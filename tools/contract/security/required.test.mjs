// Decided on 2026-11-25, after the review of the enrolment codes: where two-step verification is required, an
// account password signs nothing on the Subsonic API, whether or not the account has set two-step verification up.
// What a password alone gets is the set-up token, and with the account's enrolment code, the set-up.
//
//   node tools/fixtures/build.mjs
//   node --test tools/contract/security/required.test.mjs
//
// Each test runs the Rust server with the real Navidrome on a fresh copy of the golden database. Credentials come
// from the fixtures' manifest, or are made for the run, and are never printed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { startGatewayOnGolden } from '../diff.mjs';
import { withCode } from '../lib/web.mjs';
import { send, postJson, subsonic, totp, COMMON } from './lib.mjs';

const bearer = token => ({ 'X-ND-Authorization': `Bearer ${token}` });
const query = params => new URLSearchParams(params).toString();
/** The three forms a password takes on the Subsonic API. */
const forms = password => ({
  p: { p: password },
  'p=enc:': { p: `enc:${Buffer.from(password).toString('hex')}` },
  't and s': { t: createHash('md5').update(`${password}c0ffee`).digest('hex'), s: 'c0ffee' },
});

/** Whether a WebSocket opens at this address (node's own WebSocket). */
const opens = address => new Promise(done => {
  const ws = new WebSocket(address);
  ws.addEventListener('open', () => { ws.close(); done(true); }, { once: true });
  ws.addEventListener('error', () => done(false), { once: true });
});

async function withServer(t, env = {}) {
  const gateway = await startGatewayOnGolden({ env });
  t.after(() => gateway.stop());
  return gateway;
}

/** The Subsonic answer of a method signed with these parameters. */
const rest = async (url, method, params, options) => subsonic(await send(`${url}/rest/${method}?${COMMON}&${query(params)}`, options));

/** An admin's web session (the admin has two-step verification). */
async function adminSession(url, admin) {
  const r = await withCode(admin, otp => postJson(`${url}/auth/login`, { username: admin.username, password: admin.password, otp }));
  assert.equal(r.status, 200, `signing the admin in: HTTP ${r.status}`);
  return bearer(r.json.token);
}

test('required: the account password of a user who has not set two-step verification up signs nothing on the API', { timeout: 300_000 }, async t => {
  const { url, manifest: { users } } = await withServer(t);
  const admin = await adminSession(url, users.admin);
  // a user as an admin makes one: a name and a password, no two-step verification yet
  const user = { username: 'newcomer', password: 'only-the-password' };
  const made = await postJson(`${url}/api/user`, { userName: user.username, name: 'New', password: user.password, isAdmin: false }, { headers: admin });
  assert.equal(made.status, 200);

  const wrong = await rest(url, 'ping', { u: user.username, p: 'not the password' });
  assert.equal(wrong.error?.code, 40);
  for (const [name, form] of Object.entries(forms(user.password))) {
    for (const method of ['ping', 'getAlbumList2', 'getUser']) {
      const r = await rest(url, method, { u: user.username, type: 'newest', username: user.username, ...form });
      assert.notEqual(r.status, 'ok', `${method} answered an account password (${name}) before any two-step verification`);
      assert.deepEqual(r.error, wrong.error, `${method} (${name}): answered otherwise than a wrong password`);
    }
    // a form post and the media routes are the same door
    const posted = subsonic(await send(`${url}/rest/ping.view`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `${COMMON}&${query({ u: user.username, ...form })}` }));
    assert.deepEqual(posted?.error, wrong.error, `a form post (${name})`);
    const stream = await send(`${url}/rest/stream?${COMMON}&${query({ u: user.username, id: 'x', ...form })}`);
    assert.deepEqual(subsonic(stream)?.error, wrong.error, `stream (${name})`);
  }
  // Sonus Connect opens with the same check
  for (const protocol of [1, 2]) {
    const opened = await opens(`${url.replace('http', 'ws')}/rest/connect?${COMMON}&${query({ u: user.username, p: user.password, ...(protocol === 2 ? { protocol: 2 } : {}) })}`);
    assert.equal(opened, false, `Sonus Connect version ${protocol} opened with the account password`);
  }

  // what the password still gets: the set-up token, and with the enrolment code the set-up, then app passwords
  const login = await postJson(`${url}/auth/login`, user);
  assert.deepEqual([login.status, login.json.twoFactor, login.json.enrolmentCodeRequired], [401, 'setup', true]);
  assert.equal((await send(`${url}/api/song?_end=1`, { headers: bearer(login.json.setupToken) })).status, 401, 'the set-up token opens the native API');
  assert.notEqual((await rest(url, 'ping', { u: user.username, jwt: login.json.setupToken })).status, 'ok', 'the set-up token signs the Subsonic API');
  const issued = await withCode(users.admin, code => postJson(`${url}/auth/2fa/users/${made.json.id}/enrolment-code`, { code }, { headers: admin }));
  assert.equal(issued.status, 200);
  const enrolmentCode = issued.json.enrolmentCode;
  const begun = await postJson(`${url}/auth/2fa/setup`, { token: login.json.setupToken, enrolmentCode });
  assert.equal(begun.status, 200);
  const done = await postJson(`${url}/auth/2fa/confirm`, { token: login.json.setupToken, enrolmentCode, code: totp(begun.json.secret), appPassword: 'the first player' });
  assert.equal(done.status, 200);
  const appPassword = done.json.newAppPassword.password;
  assert.equal((await rest(url, 'ping', { u: user.username, p: appPassword })).status, 'ok', 'the app password made with the set-up signs');
  assert.equal((await rest(url, 'ping', { apiKey: appPassword })).status, 'ok', 'and is an API key');
  assert.deepEqual((await rest(url, 'ping', { u: user.username, p: user.password })).error, wrong.error, 'the account password still signs nothing, and is answered the same');
});

test('required: an app password an account had before it set two-step verification up keeps working; its password does not', { timeout: 300_000 }, async t => {
  // the fixtures' listener: no two-step verification, and an app password from when the server did not require it
  const { url, manifest: { users: { listener } } } = await withServer(t);
  assert.ok(listener.appPassword, 'the fixtures give the listener an app password (node tools/fixtures/build.mjs)');
  assert.equal((await rest(url, 'ping', { u: listener.username, p: listener.appPassword })).status, 'ok');
  assert.equal((await rest(url, 'getAlbumList2', { apiKey: listener.appPassword, type: 'newest' })).status, 'ok');
  for (const [name, form] of Object.entries(forms(listener.password))) {
    assert.equal((await rest(url, 'ping', { u: listener.username, ...form })).error?.code, 40, name);
  }
});

test('optional and off are as they were: the password signs until the user sets two-step verification up (off: always)', { timeout: 300_000 }, async t => {
  for (const policy of ['optional', 'off']) {
    const { url, manifest: { users: { listener, secure } } } = await withServer(t, { ND_SONUS_TWOFACTOR: policy });
    for (const [name, form] of Object.entries(forms(listener.password))) {
      assert.equal((await rest(url, 'ping', { u: listener.username, ...form })).status, 'ok', `${policy}: ${name}`);
    }
    const withIt = await rest(url, 'ping', { u: secure.username, p: secure.password });
    assert.equal(withIt.status === 'ok', policy === 'off', `${policy}: a user who has set it up`);
  }
});
