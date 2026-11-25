// The web sign-in and what hangs on it (/auth): the password, two-step verification from its setup at the first sign-in
// to recovery codes and an admin's reset, app passwords, session tokens, and the routes' own errors. The cases of
// Navidrome's server/auth_test.go and the fork's sonus_twofactor_test.go and core/twofactor/twofactor_test.go, as a
// client sees them. Needs a Navidrome-kind server (the web UI's routes) with two-step verification required, as the
// golden database is served.
//
// The Rust server is stricter than the frozen Navidrome on purpose (the security review of 2026-11-24): a first set-up
// takes an enrolment code an admin made, and making an app password, allowing an app and an admin's reset each take a
// verification code. The first sign-in's answer says which server this is (`enrolmentCodeRequired`), and the tests
// then expect that; against Navidrome alone they expect what the fork does.
//
// The tests make a user of their own (through the native API, as the admin) and remove it at the end, so the manifest's
// users stay as the other files expect them. They run in order: each builds on the one before.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { manifest, session, BASE, CLIENT } from '../lib/context.mjs';
import { webJson, withCode } from '../lib/web.mjs';
import { step, totp } from '../lib/totp.mjs';
import { Subsonic } from '../lib/subsonic.mjs';

const web = manifest.server?.kind === 'navidrome' && manifest.server?.twoFactor === 'required';
const skip = web ? false : 'the server has no web sign-in with two-step verification required';

const temp = { username: `contract-${randomBytes(4).toString('hex')}`, password: `pw-${randomBytes(9).toString('hex')}` };
let admin;        // the admin's session
const post = (path, body, token) => webJson(BASE, `/auth${path}`, { method: 'POST', body, token });
const get = (path, token) => webJson(BASE, `/auth${path}`, { token });
const signIn = (otp, user = temp) => post('/login', { username: user.username, password: user.password, ...(otp === undefined ? {} : { otp }) });
const subsonic = params => new Subsonic(BASE, {}, { client: CLIENT }).call('ping', params);
// a code not used yet: the following step's (accepted, as clocks drift)
const nextCode = () => totp(temp.secret, step() + 1);

before(async () => {
  if (skip) return;
  admin = await session('admin');
  const made = await webJson(BASE, '/api/user', { method: 'POST', token: admin, body: { userName: temp.username, name: 'Contract Test', password: temp.password, isAdmin: false } });
  assert.equal(made.status, 200, `making the test user: ${JSON.stringify(made.json)}`);
  temp.id = made.json.id;
});

after(async () => {
  if (skip || !temp.id) return;
  const gone = await webJson(BASE, `/api/user/${temp.id}`, { method: 'DELETE', token: admin });
  assert.equal(gone.status, 200, 'removing the test user');
});

test('a session from /auth/login opens the native API, and the token the API hands back opens /auth', { skip }, async () => {
  // the admin's session came from /auth/login (with a code); the native API is Navidrome's
  const res = await fetch(`${BASE}/api/user?_start=0&_end=5`, { headers: { 'X-ND-Authorization': `Bearer ${admin}` } });
  assert.equal(res.status, 200);
  assert.ok((await res.json()).some(u => u.userName === temp.username));
  // Navidrome renews the token at every use
  const renewed = res.headers.get('x-nd-authorization');
  assert.ok(renewed, 'a renewed token comes back (the same one when it is renewed within the second it was made)');
  assert.equal((await get('/2fa', renewed)).status, 200, 'the renewed token is a session on /auth too');
  // a token that was changed is nobody's
  const [h, p, s] = admin.split('.');
  const forged = [h, Buffer.from(Buffer.from(p, 'base64url').toString().replace('"adm":true', '"adm":false')).toString('base64url'), s].join('.');
  assert.equal((await get('/2fa', forged)).status, 401);
  assert.equal((await get('/2fa', `${admin}x`)).status, 401);
  assert.equal((await get('/2fa')).status, 401);
  assert.deepEqual((await get('/2fa')).json, { error: 'Not authenticated' });
});

test('login refuses an unknown user, a wrong password and a body it cannot read', { skip }, async () => {
  const unknown = await post('/login', { username: 'nobody-by-this-name', password: 'x' });
  assert.equal(unknown.status, 401);
  assert.deepEqual(unknown.json, { error: 'Invalid username or password' });
  const wrong = await post('/login', { username: temp.username, password: 'not the password' });
  assert.equal(wrong.status, 401);
  assert.ok(!('twoFactor' in wrong.json), 'the wrong password is refused before anything else');
  for (const body of ['', '{', '[]', '"text"', '{"username":"a","password":1}']) {
    const res = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    assert.equal(res.status, 422, JSON.stringify(body));
    assert.deepEqual(await res.json(), { error: 'invalid request payload' });
  }
  // more than the routes read (8 KB)
  const padded = await post('/login', { username: temp.username, password: temp.password, padding: 'x'.repeat(8 << 10) });
  assert.equal(padded.status, 422);
});

test('the first sign-in gives a setup token that opens nothing else', { skip }, async () => {
  const first = await signIn();
  assert.equal(first.status, 401);
  assert.equal(first.json.twoFactor, 'setup');
  assert.equal(first.json.error, 'Two-step verification must be set up');
  assert.ok(!('token' in first.json), 'no session before the code');
  temp.setupToken = first.json.setupToken;
  const claims = JSON.parse(Buffer.from(temp.setupToken.split('.')[1], 'base64url'));
  assert.deepEqual(claims.aud, ['sonus-2fa-setup']);
  assert.equal(claims.sub, temp.username);
  assert.equal(claims.uid, temp.id);
  assert.ok(Math.abs(claims.exp - claims.iat - 900) <= 2, 'good for fifteen minutes');

  assert.equal((await get('/2fa', temp.setupToken)).status, 401, '/auth');
  assert.equal((await webJson(BASE, '/api/user', { token: temp.setupToken })).status, 401, 'the native API');
  assert.equal((await subsonic({ u: temp.username, jwt: temp.setupToken })).body.error?.code, 40, 'the Subsonic API');
  // until it is set up, the account password still signs the Subsonic API on the fork; the Rust server takes no
  // account password there where two-step verification is required, set up or not
  const byPassword = (await subsonic({ u: temp.username, p: temp.password })).body;
  if (first.json.enrolmentCodeRequired === true) assert.equal(byPassword.error?.code, 40);
  else assert.equal(byPassword.status, 'ok');

  temp.hardened = first.json.enrolmentCodeRequired === true;
  if (temp.hardened) {
    // the password got the token; it does not set anything up without the account's enrolment code
    for (const [path, body] of [['/2fa/setup', {}], ['/2fa/confirm', { code: '123456' }], ['/2fa/setup', { enrolmentCode: 'abcd-efgh-jkmn' }]]) {
      const refused = await post(path, { token: temp.setupToken, ...body });
      assert.deepEqual([refused.status, refused.json.twoFactor], [401, 'enrolment'], `${path} ${JSON.stringify(body)}`);
    }
    // an admin makes one (with a code of their own), for the user they made through the native API
    const noCode = await post(`/2fa/users/${temp.id}/enrolment-code`, {}, admin);
    assert.deepEqual([noCode.status, noCode.json.twoFactor], [401, 'code']);
    assert.equal((await post(`/2fa/users/${temp.id}/enrolment-code`, { code: '000000' }, temp.setupToken)).status, 401, 'not with a setup token');
    const made = await withCode(manifest.users.admin, code => post(`/2fa/users/${temp.id}/enrolment-code`, { code }, admin));
    assert.equal(made.status, 200, JSON.stringify(made.json));
    assert.match(made.json.enrolmentCode, /^[a-z2-9]{4}(-[a-z2-9]{4}){2}$/);
    assert.match(made.json.expiresAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    temp.enrolment = made.json.enrolmentCode;
    assert.equal((await get(`/2fa/users/${temp.id}`, admin)).json.enrolmentCodeExpiresAt, made.json.expiresAt, 'the admin sees that one waits');
  }
  const early = await post('/2fa/confirm', { token: temp.setupToken, code: '123456', enrolmentCode: temp.enrolment });
  assert.equal(early.status, 409, 'nothing is being set up yet');
  for (const body of [{}, { token: 'not.a.token' }]) assert.equal((await post('/2fa/setup', body)).status, 401);
});

test('setting it up: the secret and its QR code, a code from it, then recovery codes and a session', { skip }, async () => {
  const begin = await post('/2fa/setup', { token: temp.setupToken, enrolmentCode: temp.enrolment });
  assert.equal(begin.status, 200);
  assert.match(begin.json.secret, /^[A-Z2-7]{32}$/);
  assert.ok(begin.json.uri.startsWith(`otpauth://totp/Sonus:${temp.username}?`) && begin.json.uri.includes(`secret=${begin.json.secret}`));
  assert.ok(begin.json.qr.startsWith('data:image/png;base64,'));
  assert.equal(begin.json.issuer, 'Sonus');
  assert.equal(begin.json.account, temp.username);
  temp.secret = begin.json.secret;

  const wrong = await post('/2fa/confirm', { token: temp.setupToken, code: '000000', enrolmentCode: temp.enrolment });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.json.twoFactor, 'setup');
  assert.equal((await get(`/2fa/users/${temp.id}`, admin)).json.enabled, false, 'off until a code is confirmed');

  const done = await post('/2fa/confirm', { token: temp.setupToken, code: totp(temp.secret), enrolmentCode: temp.enrolment });
  assert.equal(done.status, 200, JSON.stringify(done.json));
  if (temp.hardened) assert.ok(!('enrolmentCodeExpiresAt' in (await get(`/2fa/users/${temp.id}`, admin)).json), 'the enrolment code is used up');
  assert.equal(done.json.username, temp.username);
  assert.equal(done.json.id, temp.id);
  assert.equal(done.json.isAdmin, false);
  assert.ok(!('subsonicToken' in done.json) && !('subsonicSalt' in done.json), 'no password-derived token with two-step verification');
  assert.equal(done.json.recoveryCodes.length, 10);
  for (const c of done.json.recoveryCodes) assert.match(c, /^[a-z2-9]{5}-[a-z2-9]{5}$/);
  temp.recovery = done.json.recoveryCodes;
  temp.session = done.json.token;

  const status = await get('/2fa', temp.session);
  assert.equal(status.status, 200);
  assert.equal(status.json.mode, 'required');
  assert.equal(status.json.enabled, true);
  assert.equal(status.json.recoveryCodesLeft, 10);
  assert.match(status.json.enabledAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/);
  // now the account password alone opens nothing
  assert.equal((await subsonic({ u: temp.username, p: temp.password })).body.error?.code, 40);
  // the web UI signs its Subsonic calls with its session instead
  assert.equal((await subsonic({ u: temp.username, jwt: temp.session })).body.status, 'ok');
});

test('then every sign-in takes a code, each code once, or a recovery code', { skip }, async () => {
  const none = await signIn();
  assert.equal(none.status, 401);
  assert.deepEqual(none.json, { error: 'Verification code required', twoFactor: 'code' });
  const wrong = await signIn('000000');
  assert.deepEqual([wrong.status, wrong.json], [401, { error: 'Invalid verification code', twoFactor: 'code' }]);
  assert.equal((await signIn(totp(temp.secret, step() - 3))).status, 401, 'a code from a minute and a half ago');

  const next = nextCode();
  const ok = await signIn(`${next.slice(0, 3)} ${next.slice(3)}`);
  assert.equal(ok.status, 200, 'as people type it');
  assert.ok(ok.json.token && !('subsonicToken' in ok.json));
  assert.equal((await signIn(next)).status, 401, 'each code once');

  assert.equal((await signIn(temp.recovery[0].toUpperCase())).status, 200, 'a recovery code, in capitals');
  assert.equal((await signIn(temp.recovery[0])).status, 401, 'once');
  assert.equal((await get('/2fa', temp.session)).json.recoveryCodesLeft, 9);
  // someone else's recovery code is nobody's
  const other = await post('/login', { username: manifest.users.secure.username, password: manifest.users.secure.password, otp: temp.recovery[1] });
  assert.equal(other.status, 401);
  assert.equal((await get('/2fa', temp.session)).json.recoveryCodesLeft, 9);
});

test('app passwords: made, listed, used on the Subsonic API, revoked', { skip }, async () => {
  if (temp.hardened) {
    // a session alone makes none: it takes a code (a recovery code here; the frozen Navidrome reads none)
    const none = await post('/app-passwords', { name: 'x' }, temp.session);
    assert.deepEqual([none.status, none.json], [401, { error: 'Verification code required', twoFactor: 'code' }]);
    assert.equal((await post('/app-passwords', { name: 'x', code: '000000' }, temp.session)).status, 401);
    assert.equal((await get('/app-passwords', temp.session)).json.length, 0);
  }
  const made = await post('/app-passwords', { name: ' 书房电脑 ', code: temp.recovery[3] }, temp.session);
  assert.equal(made.status, 200);
  assert.match(made.json.password, /^[a-z2-9]{4}(-[a-z2-9]{4}){3}$/);
  assert.equal(made.json.appPassword.name, '书房电脑');
  assert.ok(!('lastUsedAt' in made.json.appPassword));
  const { id } = made.json.appPassword;
  const unnamed = await post('/app-passwords', { code: temp.recovery[4] }, temp.session);
  assert.equal(unnamed.json.appPassword.name, 'App');
  assert.equal((await post('/app-passwords', { name: 'x' })).status, 401, 'signed in only');

  // it signs the Subsonic API where the account password no longer does, and is an API key too
  assert.equal((await subsonic({ u: temp.username, p: made.json.password })).body.status, 'ok');
  assert.equal((await new Subsonic(BASE, { apiKey: made.json.password }, { client: CLIENT }).ok('tokenInfo')).tokenInfo.username, temp.username);

  const list = await get('/app-passwords', temp.session);
  assert.equal(list.status, 200);
  assert.equal(list.json.length, 2);
  const listed = list.json.find(ap => ap.id === id);
  assert.equal(listed.name, '书房电脑');
  assert.equal(listed.lastUsedBy, CLIENT, 'who used it last');
  assert.match(listed.lastUsedAt, /^\d{4}-\d\d-\d\dT/);
  assert.match(listed.createdAt, /^\d{4}-\d\d-\d\dT/);
  assert.ok(list.json.every(ap => !('password' in ap) && !('secret' in ap)), 'the password is shown once, when made');
  assert.ok(list.json[0].createdAt >= list.json[1].createdAt, 'newest first');

  // only its user revokes it
  const others = await webJson(BASE, `/auth/app-passwords/${id}`, { method: 'DELETE', token: admin });
  assert.equal(others.status, 404);
  assert.equal((await webJson(BASE, `/auth/app-passwords/${id}`, { method: 'DELETE', token: temp.session })).status, 204);
  const again = await webJson(BASE, `/auth/app-passwords/${id}`, { method: 'DELETE', token: temp.session });
  assert.deepEqual([again.status, again.json], [404, { error: 'No such app password' }]);
  assert.equal((await subsonic({ u: temp.username, p: made.json.password })).body.error?.code, 40, 'revoked: it stops working at once');
  assert.equal((await subsonic({ apiKey: made.json.password })).body.error?.code, 44);
  assert.equal((await webJson(BASE, `/auth/app-passwords/${unnamed.json.appPassword.id}`, { method: 'DELETE', token: temp.session })).status, 204);

  if (temp.hardened) {
    // nor does a session alone hand an app a key
    const s = (await post('/device/start', { client: 'Sonus', device: 'Contract' })).json;
    const info = await get(`/device/${s.userCode}`, temp.session);
    assert.equal(info.json.codeRequired, true);
    assert.match(info.json.address, /^(127\.0\.0\.1|::1)$/, 'the page shows the address that asked');
    for (const body of [undefined, {}, { code: '000000' }]) {
      const refused = await post(`/device/${s.userCode}/approve`, body, temp.session);
      assert.deepEqual([refused.status, refused.json.twoFactor], [401, 'code'], JSON.stringify(body));
    }
    assert.equal((await post('/device/poll', { deviceCode: s.deviceCode })).json.status, 'pending');
    assert.equal((await post(`/device/${s.userCode}/approve`, { code: temp.recovery[5] }, temp.session)).status, 204);
    const handed = (await post('/device/poll', { deviceCode: s.deviceCode })).json;
    assert.equal(handed.status, 'approved');
    assert.equal((await post('/device/revoke', { apiKey: handed.apiKey })).status, 204);
    // a sign-in with the password and a code can ask for an app password with it: one code for both
    const both = await post('/login', { username: temp.username, password: temp.password, otp: temp.recovery[6], appPassword: 'Contract (one code)' });
    assert.equal(both.status, 200, JSON.stringify(both.json));
    assert.equal(both.json.newAppPassword.appPassword.name, 'Contract (one code)');
    assert.equal((await subsonic({ u: temp.username, p: both.json.newAppPassword.password })).body.status, 'ok');
    assert.equal((await webJson(BASE, `/auth/app-passwords/${both.json.newAppPassword.appPassword.id}`, { method: 'DELETE', token: temp.session })).status, 204);
  }
});

test('new recovery codes take a code and replace the old ones; required, it cannot be turned off', { skip }, async () => {
  const wrong = await post('/2fa/recovery-codes', { code: '000000' }, temp.session);
  assert.deepEqual([wrong.status, wrong.json.twoFactor], [401, 'code']);
  const fresh = await post('/2fa/recovery-codes', { code: temp.recovery[1] }, temp.session);
  assert.equal(fresh.status, 200);
  assert.equal(fresh.json.recoveryCodes.length, 10);
  assert.equal((await signIn(temp.recovery[2])).status, 401, 'the old ones stop working');
  temp.recovery = fresh.json.recoveryCodes;
  assert.equal((await get('/2fa', temp.session)).json.recoveryCodesLeft, 10);

  const off = await post('/2fa/disable', { code: temp.recovery[0] }, temp.session);
  assert.deepEqual([off.status, off.json], [403, { error: 'Two-step verification is required on this server' }]);
  assert.equal((await get('/2fa', temp.session)).json.recoveryCodesLeft, 10, 'and the code was not used up');
  assert.equal((await post('/2fa/recovery-codes', { code: temp.recovery[0] })).status, 401, 'signed in only');
});

test('an admin sees and resets someone’s two-step verification; others cannot', { skip }, async () => {
  const mine = await post(`/2fa/users/${temp.id}/reset`, undefined, temp.session);
  assert.deepEqual([mine.status, mine.json], [403, { error: 'Only admins can do this' }]);
  assert.equal((await get(`/2fa/users/${temp.id}`, temp.session)).status, 403);
  assert.equal((await get(`/2fa/users/${temp.id}`)).status, 401);

  const kept = await post('/app-passwords', { name: 'kept', code: temp.recovery[9] }, temp.session);
  const seen = await get(`/2fa/users/${temp.id}`, admin);
  assert.deepEqual([seen.status, seen.json.enabled, seen.json.recoveryCodesLeft], [200, true, temp.hardened ? 9 : 10]);
  if (temp.hardened) {
    // an admin's session alone resets nobody; with the admin's code, the answer carries the user's new enrolment code
    for (const body of [undefined, { code: '000000' }]) {
      const refused = await post(`/2fa/users/${temp.id}/reset`, body, admin);
      assert.deepEqual([refused.status, refused.json.twoFactor], [401, 'code'], JSON.stringify(body));
    }
    assert.equal((await get(`/2fa/users/${temp.id}`, admin)).json.enabled, true);
    const reset = await withCode(manifest.users.admin, code => post(`/2fa/users/${temp.id}/reset`, { code }, admin));
    assert.equal(reset.status, 200, JSON.stringify(reset.json));
    assert.match(reset.json.enrolmentCode, /^[a-z2-9]{4}(-[a-z2-9]{4}){2}$/);
    assert.notEqual(reset.json.enrolmentCode, temp.enrolment);
  } else {
    assert.equal((await post(`/2fa/users/${temp.id}/reset`, undefined, admin)).status, 204);
  }
  const after = await get(`/2fa/users/${temp.id}`, admin);
  assert.deepEqual([after.json.mode, after.json.enabled, after.json.recoveryCodesLeft], ['required', false, 0]);
  // they set it up again at their next sign-in; their app passwords keep working
  assert.equal((await signIn()).json.twoFactor, 'setup');
  assert.equal((await subsonic({ u: temp.username, p: kept.json.password })).body.status, 'ok');
  assert.equal((await get('/app-passwords', temp.session)).json.length, 1);
});

test('the browser sign-in’s approval page: signed in only, the code as typed, a key named after the app', { skip }, async () => {
  const s = (await post('/device/start', { client: ' Sonus ', device: '书房电脑' })).json;
  assert.equal((await get(`/device/${s.userCode}`)).status, 401);
  assert.equal((await post(`/device/${s.userCode}/approve`)).status, 401);
  const info = await get(`/device/${s.userCode.toLowerCase().replace('-', '')}`, temp.session);
  assert.equal(info.status, 200);
  assert.deepEqual([info.json.userCode, info.json.client, info.json.device], [s.userCode, 'Sonus', '书房电脑']);
  assert.ok(info.json.expiresIn > 590 && info.json.expiresIn <= 600);
  assert.equal((await post(`/device/${s.userCode}/approve`, undefined, temp.session)).status, 204);
  const gone = await get(`/device/${s.userCode}`, temp.session);
  assert.deepEqual([gone.status, gone.json], [404, { error: 'No sign-in waiting for this code: it may have expired' }]);
  const handed = (await post('/device/poll', { deviceCode: s.deviceCode })).json;
  assert.deepEqual([handed.status, handed.username], ['approved', temp.username]);
  assert.equal(handed.apiKey.replaceAll('-', '').length, 32, 'a key nobody types is longer');
  const list = (await get('/app-passwords', temp.session)).json;
  assert.ok(list.some(ap => ap.name === 'Sonus · 书房电脑'), JSON.stringify(list.map(ap => ap.name)));

  // refused, it cannot be allowed after all
  const r = (await post('/device/start', {})).json;
  assert.equal((await get(`/device/${r.userCode}`, temp.session)).json.client, 'App', 'an app that does not name itself');
  assert.equal((await post(`/device/${r.userCode}/deny`, undefined, temp.session)).status, 204);
  assert.equal((await post(`/device/${r.userCode}/approve`, undefined, temp.session)).status, 404);
  assert.equal((await post('/device/poll', { deviceCode: r.deviceCode })).json.status, 'denied');
});

test('paths that are no route are 404 and other methods 405, signed in or not', { skip }, async () => {
  const status = async (method, path) => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'X-ND-Authorization': `Bearer ${temp.session}` } });
    await res.arrayBuffer();
    return res.status;
  };
  for (const path of ['/auth', '/auth/', '/auth/nothing', '/auth/login/', '/auth/2fa/users', '/auth/device']) assert.equal(await status('GET', path), 404, path);
  for (const [method, path] of [['GET', '/auth/login'], ['PUT', '/auth/createAdmin'], ['POST', '/auth/2fa'], ['GET', '/auth/app-passwords/x'], ['DELETE', '/auth/device/start']]) {
    assert.equal(await status(method, path), 405, `${method} ${path}`);
  }
});

test('there is one first admin: createAdmin is refused once there is a user', { skip }, async () => {
  const r = await post('/createAdmin', { username: 'another-admin', password: 'x' });
  assert.deepEqual([r.status, r.json], [403, { error: 'Cannot create another first admin' }]);
});
