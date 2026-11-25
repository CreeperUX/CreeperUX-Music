// The /auth routes where the suite's shared server cannot show them: on a new server without users (the first admin),
// with two-step verification optional or off, with the sign-in rate limit on, and the body limits. Each test starts
// Navidrome alone ("Go") and the Rust server running its own Navidrome ("Rust") with the same settings, sends both the
// same requests, and compares what comes back step by step.
//
//   node --test tools/contract/auth-routes.test.mjs      (tools/fixtures/build.mjs first)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webJson } from './lib/web.mjs';
import { totp } from './lib/totp.mjs';
import { Subsonic } from './lib/subsonic.mjs';
import { serveGolden } from '../fixtures/serve.mjs';
import { startGatewayOnGolden } from './diff.mjs';

const sleep = ms => new Promise(done => setTimeout(done, ms));

/** Both servers with the same settings over the golden ones; stopped when the test ends. */
async function both(t, env, { empty = false } = {}) {
  const [go, rust] = await Promise.all([serveGolden({ env, empty }), startGatewayOnGolden({ env, empty })]);
  t.after(async () => { await go.stop(); await rust.stop(); });
  return { go, rust, users: go.manifest.users };
}

/** Runs a scenario against each server in turn: it returns the list of what it saw, which must be the same. */
async function same(servers, scenario) {
  const fromGo = await scenario(servers.go.url, 'Go');
  const fromRust = await scenario(servers.rust.url, 'Rust');
  assert.deepEqual(fromRust, fromGo, 'the Rust server answers as Navidrome does');
  return fromRust;
}

/** What a sign-in sends for a manifest user. */
const creds = u => ({ username: u.username, password: u.password });
const post = (base, path, body, token) => webJson(base, `/auth${path}`, { method: 'POST', body, token });
const get = (base, path, token) => webJson(base, `/auth${path}`, { token });
/** The keys of an answer, and the values that are the same on every server. */
const shape = r => [r.status, Object.keys(r.json ?? {}).sort().join(',')];

test('a new server: the first admin is made once, and both servers read what the other wrote', { timeout: 600_000 }, async t => {
  const servers = await both(t, { ND_SONUS_TWOFACTOR: 'off' }, { empty: true });
  const admin = { username: 'first admin', password: 'correct horse battery staple 电池' };
  const seen = await same(servers, async base => {
    const log = [];
    log.push(['createAdmin with a body that is not JSON', (await fetch(`${base}/auth/createAdmin`, { method: 'POST', body: 'x' })).status]);
    const made = await post(base, '/createAdmin', admin);
    log.push(['createAdmin', ...shape(made), made.json.username, made.json.name, made.json.isAdmin]);
    const session = made.json.token;
    assert.ok(session, JSON.stringify(made.json));
    log.push(['a second first admin', (await post(base, '/createAdmin', { username: 'mallory', password: 'x' })).status]);
    const again = await post(base, '/login', admin);
    log.push(['the password signs in', ...shape(again)]);
    log.push(['in any case of the name', (await post(base, '/login', { ...admin, username: admin.username.toUpperCase() })).status]);

    // Navidrome's own API takes the session, and lists the one user with every library
    const me = await webJson(base, `/api/user/${made.json.id}`, { token: session });
    log.push(['the native API with the session', me.status, me.json.userName, me.json.isAdmin, me.json.libraries?.length]);
    const sub = new Subsonic(base, { u: admin.username, password: admin.password }, { client: 'sonus-auth-test' });
    log.push(['the Subsonic API with the password', (await sub.call('ping')).body.status]);

    // A password change through Navidrome's own API: Navidrome checks the current password (so it opened what was
    // sealed at createAdmin), seals the new one, and revokes the sessions made before.
    const changed = await webJson(base, `/api/user/${made.json.id}`, {
      method: 'PUT', token: session,
      body: { ...me.json, currentPassword: admin.password, password: 'a new password', changePassword: true },
    });
    log.push(['changing the password through the native API', changed.status]);
    log.push(['the session from before', (await get(base, '/2fa', session)).status]);
    log.push(['the old password', (await post(base, '/login', admin)).status]);
    const fresh = await post(base, '/login', { username: admin.username, password: 'a new password' });
    log.push(['the new password', fresh.status]);
    log.push(['the new session', (await get(base, '/2fa', fresh.json.token)).status]);
    return log;
  });
  assert.deepEqual(seen, [
    ['createAdmin with a body that is not JSON', 422],
    ['createAdmin', 200, 'id,isAdmin,name,subsonicSalt,subsonicToken,token,username', 'first admin', 'First Admin', true],
    ['a second first admin', 403],
    ['the password signs in', 200, 'id,isAdmin,name,subsonicSalt,subsonicToken,token,username'],
    ['in any case of the name', 200],
    ['the native API with the session', 200, 'first admin', true, 1],
    ['the Subsonic API with the password', 'ok'],
    ['changing the password through the native API', 200],
    ['the session from before', 401],
    ['the old password', 401],
    ['the new password', 200],
    ['the new session', 200],
  ]);
});

test('a new server with two-step verification required: the first admin sets it up before any session', { timeout: 600_000 }, async t => {
  const servers = await both(t, {}, { empty: true });
  await same(servers, async (base, who) => {
    const made = await post(base, '/createAdmin', { username: 'admin', password: 'pw' });
    assert.deepEqual([made.status, made.json.twoFactor], [401, 'setup']);
    // The Rust server asks for an enrolment code at a first set-up, where the frozen Navidrome asks for none (the
    // security review of 2026-11-24); the first admin has nobody to get one from, and its answer says none is needed
    // (enrolmentCodeRequired: false), which is the one key Navidrome's answer does not have. Signing in again with
    // the password gives a token that does need one: only the token of the account's making sets up without.
    if (who === 'Rust') {
      assert.equal(made.json.enrolmentCodeRequired, false);
      const later = await post(base, '/login', { username: 'admin', password: 'pw' });
      assert.deepEqual([later.status, later.json.twoFactor, later.json.enrolmentCodeRequired], [401, 'setup', true]);
      const refused = await post(base, '/2fa/setup', { token: later.json.setupToken });
      assert.deepEqual([refused.status, refused.json.twoFactor], [401, 'enrolment']);
      delete made.json.enrolmentCodeRequired;
    }
    const begin = await post(base, '/2fa/setup', { token: made.json.setupToken });
    const done = await post(base, '/2fa/confirm', { token: made.json.setupToken, code: totp(begin.json.secret) });
    return [shape(made), shape(begin), shape(done), (await get(base, '/2fa', done.json.token)).json.enabled];
  });
});

test('optional: each user turns two-step verification on and off; off: neither asked nor set up', { timeout: 600_000 }, async t => {
  const optional = await both(t, { ND_SONUS_TWOFACTOR: 'optional' });
  const { listener, secure } = optional.users;
  const seen = await same(optional, async base => {
    const log = [];
    const first = await post(base, '/login', creds(listener));
    log.push(['a user without it signs in with the password', ...shape(first)]);
    const session = first.json.token;
    log.push(['status', (await get(base, '/2fa', session)).json]);
    const begin = await post(base, '/2fa/setup', {}, session);
    log.push(['setting it up with the session', ...shape(begin)]);
    const done = await post(base, '/2fa/confirm', { code: totp(begin.json.secret) }, session);
    log.push(['confirmed', ...shape(done)]);
    log.push(['now a code is asked for', (await post(base, '/login', creds(listener))).json]);
    const sub = params => new Subsonic(base, {}, { client: 'sonus-auth-test' }).call('ping', params).then(r => r.body.error?.code ?? 0);
    log.push(['and the account password no longer signs the Subsonic API', await sub({ u: listener.username, p: listener.password })]);
    // the session to go on with is the one the confirmation answered: the Rust server ends those from before
    // (docs/security-review-2026-11-24.md, F6), where Navidrome let them go on
    const after = done.json.token;
    log.push(['replacing the authenticator takes a code', (await post(base, '/2fa/setup', { code: '000000' }, after)).json]);
    log.push(['turning it off takes a code', (await post(base, '/2fa/disable', { code: '000000' }, after)).status]);
    log.push(['with a recovery code', (await post(base, '/2fa/disable', { code: done.json.recoveryCodes[0] }, after)).status]);
    log.push(['off again', (await get(base, '/2fa', after)).json, await sub({ u: listener.username, p: listener.password })]);
    // a user who has it set up is asked for a code, as when it is required
    log.push(['the two-step user', (await post(base, '/login', creds(secure))).json]);
    return log;
  });
  assert.deepEqual(seen[0], ['a user without it signs in with the password', 200, 'id,isAdmin,name,subsonicSalt,subsonicToken,token,username']);
  assert.deepEqual(seen[1], ['status', { mode: 'optional', enabled: false, recoveryCodesLeft: 0 }]);
  assert.deepEqual(seen.slice(4), [
    ['now a code is asked for', { error: 'Verification code required', twoFactor: 'code' }],
    ['and the account password no longer signs the Subsonic API', 40],
    ['replacing the authenticator takes a code', { error: 'Invalid verification code', twoFactor: 'code' }],
    ['turning it off takes a code', 401],
    ['with a recovery code', 204],
    ['off again', { mode: 'optional', enabled: false, recoveryCodesLeft: 0 }, 0],
    ['the two-step user', { error: 'Verification code required', twoFactor: 'code' }],
  ]);

  const off = await both(t, { ND_SONUS_TWOFACTOR: 'off' });
  const seenOff = await same(off, async base => {
    const signed = await post(base, '/login', creds(secure));
    return [
      ['the two-step user signs in with the password alone', ...shape(signed)],
      ['nothing to set up', (await post(base, '/2fa/setup', {}, signed.json.token)).json],
      ['status', (await get(base, '/2fa', signed.json.token)).json.mode],
    ];
  });
  assert.deepEqual(seenOff, [
    ['the two-step user signs in with the password alone', 200, 'id,isAdmin,name,subsonicSalt,subsonicToken,token,username'],
    ['nothing to set up', { error: 'Two-step verification is turned off on this server' }],
    ['status', 'off'],
  ]);
});

test('the sign-in routes are rate-limited per address the same way', { timeout: 600_000 }, async t => {
  const WINDOW = 6;
  const servers = await both(t, { ND_AUTHREQUESTLIMIT: '3', ND_AUTHWINDOWLENGTH: `${WINDOW}s`, ND_SONUS_TWOFACTOR: 'off' });
  const { listener } = servers.users;
  const seen = await same(servers, async base => {
    // start at the beginning of one of the limiter's windows, so both runs count the same way
    const probe = await fetch(`${base}/auth/device/start`, { method: 'POST', body: '{}' });
    await probe.arrayBuffer();
    const reset = Number(probe.headers.get('x-ratelimit-reset'));
    assert.ok(reset > 0, 'answers say when the window ends');
    await sleep(Math.max(0, reset * 1000 - Date.now()) + WINDOW * 1000 + 300); // a whole window later: the probe is forgotten
    const log = [];
    const call = async (what, path, body, token) => {
      const res = await fetch(`${base}/auth${path}`, {
        method: 'POST', body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json', ...(token ? { 'X-ND-Authorization': `Bearer ${token}` } : {}) },
      });
      const text = await res.text();
      log.push([what, res.status, res.headers.get('x-ratelimit-limit'), res.headers.get('x-ratelimit-remaining'), res.headers.get('retry-after'), res.status === 429 ? text : '']);
      try { return JSON.parse(text); } catch { return {}; }
    };
    const signed = await call('a sign-in', '/login', creds(listener));
    await call('a wrong password', '/login', { ...creds(listener), password: 'wrong' });
    await call('an app asking to sign in', '/device/start', {});
    await call('one too many', '/login', creds(listener));
    await call('the setup routes are in the same count', '/2fa/setup', {});
    await call('and giving a key back', '/device/revoke', { apiKey: 'x' });
    await call('signed-in routes with a limit: without a session, 401 first', '/2fa/recovery-codes', { code: '000000' });
    await call('with one, limited', '/2fa/recovery-codes', { code: '000000' }, signed.token);
    await call('polling is not limited', '/device/poll', { deviceCode: 'x' });
    log.push(['nor is the status', (await get(base, '/2fa', signed.token)).status]);
    return log;
  });
  assert.deepEqual(seen.map(([what, status, limit, remaining, retry]) => [what, status, limit, remaining, retry]), [
    ['a sign-in', 200, '3', '2', null],
    ['a wrong password', 401, '3', '1', null],
    ['an app asking to sign in', 200, '3', '0', null],
    ['one too many', 429, '3', '0', String(WINDOW)],
    ['the setup routes are in the same count', 429, '3', '0', String(WINDOW)],
    ['and giving a key back', 429, '3', '0', String(WINDOW)],
    ['signed-in routes with a limit: without a session, 401 first', 401, null, null, null],
    ['with one, limited', 429, '3', '0', String(WINDOW)],
    ['polling is not limited', 200, null, null, null],
    ['nor is the status', 200, undefined, undefined, undefined],
  ]);
  assert.equal(seen[3][5], 'Too Many Requests\n');
});

test('request bodies are bounded the same way: 8 KB under /auth, 4 MiB to the native API', { timeout: 600_000 }, async t => {
  const servers = await both(t, { ND_SONUS_TWOFACTOR: 'off' });
  const { listener } = servers.users;
  const seen = await same(servers, async base => {
    const session = (await post(base, '/login', creds(listener))).json.token;
    // A server that refuses a body answers before it has read it, and may close the connection while the client is
    // still sending its megabytes: the client then sees a reset instead of the answer, depending on timing alone (the
    // gateway reads and discards up to 32 MiB to avoid it, Navidrome does not). What is tested is the answer, so a
    // request that fails on the network, and only that, is sent again (at most three times).
    const send = async (path, bytes, type = 'application/json') => {
      for (let attempt = 1; ; attempt++) {
        try {
          const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': type, 'X-ND-Authorization': `Bearer ${session}` }, body: Buffer.alloc(bytes, 0x20) });
          const text = await res.text();
          return [res.status, res.status === 413 ? text : ''];
        } catch (e) {
          if (attempt >= 3) throw e;
        }
      }
    };
    return [
      ['/auth: a sign-in within 8 KB', (await post(base, '/login', { ...creds(listener), padding: 'x'.repeat(7000) })).status],
      ['/auth: a sign-in over 8 KB', (await post(base, '/login', { ...creds(listener), padding: 'x'.repeat(8200) })).status],
      ['/api: a body over 4 MiB', await send('/api/playlist', (4 << 20) + 1)],
      ['/api: a body of 4 MiB is read (and is no playlist)', (await send('/api/playlist', 4 << 20))[0] !== 413],
      ['/api: an upload is not bounded here', (await send('/api/playlist/none/image', (4 << 20) + 1, 'multipart/form-data; boundary=x'))[0] !== 413],
    ];
  });
  assert.deepEqual(seen, [
    ['/auth: a sign-in within 8 KB', 200],
    ['/auth: a sign-in over 8 KB', 422],
    ['/api: a body over 4 MiB', [413, 'Request body must not be larger than 4194304 bytes\n']],
    ['/api: a body of 4 MiB is read (and is no playlist)', true],
    ['/api: an upload is not bounded here', true],
  ]);
});

test('sign-ins that wait for approval are the Rust server’s own: Navidrome never hears of them', { timeout: 600_000 }, async t => {
  // at debug level Navidrome logs every request it gets
  const rust = await startGatewayOnGolden({ env: { ND_LOGLEVEL: 'debug', ND_SONUS_TWOFACTOR: 'off' } });
  t.after(() => rust.stop());
  const { listener } = rust.manifest.users;
  const session = (await post(rust.url, '/login', creds(listener))).json.token;
  const s = (await post(rust.url, '/device/start', { client: 'Sonus', device: 'marker-device' })).json;
  assert.equal((await post(rust.url, `/device/${s.userCode}/approve`, undefined, session)).status, 204);
  assert.equal((await post(rust.url, '/device/poll', { deviceCode: s.deviceCode })).json.status, 'approved');
  assert.equal((await get(rust.url, '/2fa', session)).status, 200);
  // and one request that is Navidrome's, to know its log is being read
  assert.equal((await webJson(rust.url, '/api/song?_start=0&_end=1', { token: session })).status, 200);
  await sleep(300);
  const log = rust.log();
  assert.ok(log.includes('/api/song'), 'Navidrome logs what reaches it');
  assert.ok(!/HTTP: \w+ \S*\/auth\//.test(log), 'no request under /auth reached Navidrome');
  assert.ok(!log.includes(listener.password), 'nor the password');
});
