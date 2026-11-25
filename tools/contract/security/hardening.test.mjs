// What was decided after the security review (docs/security-review-2026-11-24.md, "Weaknesses by design"), one test
// for each decision, against the Rust server running the real Navidrome:
//
//   D1. With two-step verification required, the password alone does not enrol an authenticator: a first set-up takes
//       a one-time enrolment code an admin made.
//   D2. A session alone does not allow an app's browser sign-in: an account with two-step verification sends a code,
//       and the approval page is told the address that asked.
//   D3. A session alone makes no app password and resets nobody's two-step verification, and the account's limit on
//       wrong codes counts across everything that takes one.
//
//   node tools/fixtures/build.mjs
//   node --test tools/contract/security/hardening.test.mjs
//
// Each test runs a server of its own on a fresh copy of the golden database (or on none: a new server). Every
// 127.0.0.x source address is another client to the server. Credentials come from the fixtures' manifest and are
// never printed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startGatewayOnGolden } from '../diff.mjs';
import { withCode } from '../lib/web.mjs';
import { send, postJson, totp } from './lib.mjs';

const bearer = token => ({ 'X-ND-Authorization': `Bearer ${token}` });
const refusedFor = (response, step) => [response.status, response.json?.twoFactor].join(' ') === `401 ${step}`;

async function withServer(t, options = {}) {
  const gateway = await startGatewayOnGolden(options);
  t.after(() => gateway.stop());
  return gateway;
}

/** A web session for a manifest user who has two-step verification: its header. */
async function signedIn(url, user) {
  const r = await withCode(user, otp => postJson(`${url}/auth/login`, { username: user.username, password: user.password, otp }));
  assert.equal(r.status, 200, `signing ${user.username} in: HTTP ${r.status}`);
  return bearer(r.json.token);
}

/** What only the password gets: the setup token of an account without two-step verification. */
async function setupToken(url, user) {
  const r = await postJson(`${url}/auth/login`, { username: user.username, password: user.password });
  assert.deepEqual([r.status, r.json.twoFactor, r.json.enrolmentCodeRequired], [401, 'setup', true]);
  assert.ok(!r.json.token, 'no session');
  return r.json.setupToken;
}

test('D1. the password alone does not set two-step verification up: it takes the enrolment code an admin made', { timeout: 300_000 }, async t => {
  const { url, manifest: { users } } = await withServer(t);
  const admin = await signedIn(url, users.admin);
  // a user made as admins make them today: through Navidrome's own API, which knows nothing of enrolment codes
  const victim = { username: 'newcomer', password: 'handed-over-with-the-code' };
  const made = await postJson(`${url}/api/user`, { userName: victim.username, name: 'New', password: victim.password, isAdmin: false }, { headers: admin });
  assert.equal(made.status, 200);

  // someone who has the password (and nothing else) gets the setup token, and with it nothing
  const token = await setupToken(url, victim);
  const setUp = (body, path = 'setup') => postJson(`${url}/auth/2fa/${path}`, { token, ...body });
  assert.ok(refusedFor(await setUp({}), 'enrolment'), 'a set-up was started with the password alone');
  assert.ok(refusedFor(await setUp({ enrolmentCode: 'abcd-efgh-jkmn' }), 'enrolment'));
  assert.ok(refusedFor(await setUp({ code: totp('JBSWY3DPEHPK3PXP') }, 'confirm'), 'enrolment'));
  assert.equal((await postJson(`${url}/auth/2fa/users/${made.json.id}/enrolment-code`, {}, { headers: bearer(token) })).status, 401, 'the setup token made itself a code');
  assert.equal((await send(`${url}/auth/2fa/users/${made.json.id}`, { headers: admin })).json.enabled, false);

  // the admin makes the code (with a verification code of their own) and hands it over with the password
  assert.ok(refusedFor(await postJson(`${url}/auth/2fa/users/${made.json.id}/enrolment-code`, {}, { headers: admin }), 'code'), 'an admin session alone made one');
  const issued = await withCode(users.admin, code => postJson(`${url}/auth/2fa/users/${made.json.id}/enrolment-code`, { code }, { headers: admin }));
  assert.equal(issued.status, 200);
  const enrolmentCode = issued.json.enrolmentCode;
  const begun = await setUp({ enrolmentCode });
  assert.equal(begun.status, 200);
  assert.ok(refusedFor(await setUp({ code: totp(begun.json.secret) }, 'confirm'), 'enrolment'), 'confirmed without the code');
  const done = await setUp({ code: totp(begun.json.secret), enrolmentCode }, 'confirm');
  assert.equal(done.status, 200);
  assert.equal(done.json.recoveryCodes.length, 10);

  // the code worked once: after a reset, it enrols nobody again
  const reset = await withCode(users.admin, code => postJson(`${url}/auth/2fa/users/${made.json.id}/reset`, { code }, { headers: admin }));
  assert.equal(reset.status, 200);
  const again = await setupToken(url, victim);
  assert.ok(refusedFor(await postJson(`${url}/auth/2fa/setup`, { token: again, enrolmentCode }), 'enrolment'), 'a used enrolment code worked again');
  assert.equal((await postJson(`${url}/auth/2fa/setup`, { token: again, enrolmentCode: reset.json.enrolmentCode })).status, 200, 'the reset’s own code');

  // a user who was there before enrolment codes, and never set two-step verification up, needs one too; and it
  // cannot be guessed: ten wrong ones, from anywhere, and none is looked at for the rest of the hour
  const old = await setupToken(url, users.listener);
  const listener = (await send(`${url}/api/user`, { headers: admin })).json.find(u => u.userName === users.listener.username);
  const right = (await withCode(users.admin, code => postJson(`${url}/auth/2fa/users/${listener.id}/enrolment-code`, { code }, { headers: admin }))).json.enrolmentCode;
  for (let n = 0; n < 10; n++) {
    const guess = await postJson(`${url}/auth/2fa/setup`, { token: old, enrolmentCode: `aaaa-bbbb-cc${String(n).padStart(2, '2')}` }, { localAddress: `127.0.0.${100 + n}` });
    assert.ok(refusedFor(guess, 'enrolment'), `guess ${n}: HTTP ${guess.status}`);
  }
  assert.equal((await postJson(`${url}/auth/2fa/setup`, { token: old, enrolmentCode: right }, { localAddress: '127.0.0.200' })).status, 429, 'guessing went on after ten wrong codes');
});

test('D1. the first admin sets up with the token of the account’s making; later, with a code from the server’s command line', { timeout: 300_000 }, async t => {
  const gateway = await withServer(t, { empty: true });
  const { url } = gateway;
  const owner = { username: 'owner', password: 'the-first-password' };
  const made = await postJson(`${url}/auth/createAdmin`, owner);
  assert.deepEqual([made.status, made.json.twoFactor, made.json.enrolmentCodeRequired], [401, 'setup', false]);
  // … but suppose the page was closed: from then on the password gets a token that needs a code, and no admin can
  // make one (there is none who can sign in)
  const token = await setupToken(url, owner);
  assert.ok(refusedFor(await postJson(`${url}/auth/2fa/setup`, { token }), 'enrolment'));

  // whoever runs the server makes one: `sonus-server enrolment-code <user>`, with the server's own settings
  const said = await new Promise((resolve, reject) => {
    const manifest = fileURLToPath(new URL('../../../server/Cargo.toml', import.meta.url));
    const env = { ...process.env, ...gateway.copy.env };
    execFile('cargo', ['run', '--quiet', '--manifest-path', manifest, '--', 'enrolment-code', owner.username], { cwd: gateway.data, env, windowsHide: true },
      (error, stdout, stderr) => (error ? reject(new Error(`enrolment-code: ${stderr}`)) : resolve(stdout)));
  });
  const enrolmentCode = /^Enrolment code for owner: (\S+)$/m.exec(said)?.[1];
  assert.ok(enrolmentCode, 'the command printed a code');
  const begun = await postJson(`${url}/auth/2fa/setup`, { token, enrolmentCode });
  assert.equal(begun.status, 200);
  const done = await postJson(`${url}/auth/2fa/confirm`, { token, code: totp(begun.json.secret), enrolmentCode });
  assert.deepEqual([done.status, done.json.isAdmin], [200, true]);
});

test('D2. a session alone does not allow an app: it takes a verification code, and the page shows who asks', { timeout: 300_000 }, async t => {
  const { url, manifest: { users } } = await withServer(t);
  const session = await signedIn(url, users.secure);
  const started = await postJson(`${url}/auth/device/start`, { client: 'Sonus', device: 'not yours' }, { localAddress: '127.0.0.77' });
  const { userCode, deviceCode } = started.json;
  const keys = async () => (await send(`${url}/auth/app-passwords`, { headers: session })).json.length;
  const before = await keys();
  const info = await send(`${url}/auth/device/${userCode}`, { headers: session });
  assert.deepEqual([info.json.client, info.json.device, info.json.address, info.json.codeRequired], ['Sonus', 'not yours', '127.0.0.77', true]);

  // the click an attacker's link asks for
  for (const body of [undefined, {}, { code: '' }, { code: '000000' }]) {
    const r = await send(`${url}/auth/device/${userCode}/approve`, { method: 'POST', headers: { ...session, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
    assert.ok(refusedFor(r, 'code'), `allowed with ${JSON.stringify(body)}: HTTP ${r.status}`);
  }
  assert.equal((await postJson(`${url}/auth/device/poll`, { deviceCode })).json.status, 'pending', 'the app got something');
  assert.equal(await keys(), before, 'a key was made');

  const allowed = await withCode(users.secure, code => postJson(`${url}/auth/device/${userCode}/approve`, { code }, { headers: session }));
  assert.equal(allowed.status, 204);
  const handed = (await postJson(`${url}/auth/device/poll`, { deviceCode })).json;
  assert.deepEqual([handed.status, handed.username], ['approved', users.secure.username]);
  assert.equal(await keys(), before + 1);
});

test('D3. a session alone makes no app password and resets nobody; ten wrong codes and no code is looked at anywhere', { timeout: 300_000 }, async t => {
  const { url, manifest: { users } } = await withServer(t);
  const admin = await signedIn(url, users.admin);
  const secure = (await send(`${url}/api/user`, { headers: admin })).json.find(u => u.userName === users.secure.username);
  const waiting = (await postJson(`${url}/auth/device/start`, { client: 'x', device: 'y' })).json.userCode;
  const keys = async () => (await send(`${url}/auth/app-passwords`, { headers: admin })).json.length;
  const before = await keys();
  const routes = [
    ['/auth/app-passwords', { name: 'kept' }],
    [`/auth/2fa/users/${secure.id}/reset`, {}],
    [`/auth/2fa/users/${secure.id}/enrolment-code`, {}],
    [`/auth/device/${waiting}/approve`, {}],
  ];
  for (const [path, body] of routes) assert.ok(refusedFor(await postJson(`${url}${path}`, body, { headers: admin }), 'code'), `${path} went through with a session alone`);
  // wrong codes, from ten addresses, across the four routes
  for (let n = 0; n < 10; n++) {
    const [path, body] = routes[n % routes.length];
    const r = await postJson(`${url}${path}`, { ...body, code: '000000' }, { headers: admin, localAddress: `127.0.0.${100 + n}` });
    assert.ok(refusedFor(r, 'code'), `${path} with a wrong code: HTTP ${r.status}`);
  }
  // … and now the right one is refused too, on each of them and at the sign-in
  for (const [path, body] of routes) {
    const r = await postJson(`${url}${path}`, { ...body, code: totp(users.admin.totpSecret) }, { headers: admin, localAddress: '127.0.0.200' });
    assert.equal(r.status, 429, `${path}: the account's wrong-code limit does not hold here`);
  }
  const { username, password } = users.admin;
  assert.equal((await postJson(`${url}/auth/login`, { username, password, otp: totp(users.admin.totpSecret, 1) }, { localAddress: '127.0.0.201' })).status, 429);
  // nothing happened
  assert.equal(await keys(), before, 'an app password was made');
  const seen = (await send(`${url}/auth/2fa/users/${secure.id}`, { headers: admin })).json;
  assert.deepEqual([seen.enabled, 'enrolmentCodeExpiresAt' in seen], [true, false]);
});
