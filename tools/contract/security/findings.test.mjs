// The security review's proven findings (docs/security-review-2026-11-24.md), one test each, written as the
// behaviour the server should have. All six failed on the code under review (6094387) and pass since the fixes
// that came with the report: they stay as regression tests.
//
//   node tools/fixtures/build.mjs
//   node --test tools/contract/security/findings.test.mjs
//
// Each test runs a server of its own on a fresh copy of the golden database. Every 127.0.0.x source address is
// another client to the server. Credentials come from the fixtures' manifest and are never printed.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { startGatewayOnGolden } from '../diff.mjs';
import { send, postJson, subsonic, totp, sleep, COMMON } from './lib.mjs';

const LIMITS = { ND_AUTHREQUESTLIMIT: '5', ND_AUTHWINDOWLENGTH: '20s' };
const PROXY = { ND_EXTAUTH_TRUSTEDSOURCES: '127.0.0.1/32' };
const ok = response => subsonic(response)?.status === 'ok';

async function withServer(t, env) {
  const gateway = await startGatewayOnGolden({ env });
  t.after(() => gateway.stop());
  return { url: gateway.url, users: gateway.manifest.users };
}

test('F1. behind a trusted proxy, ND_EXTAUTH_USERHEADER="" turns sign-in by header off', { timeout: 300_000 }, async t => {
  // An empty environment value reads as "not set", so the default (Remote-User) stays on: a deployment configured by
  // environment alone (a container template) cannot have the proxy's addresses believed without also believing a
  // Remote-User header, which a proxy passes on from the client unless it was told to remove it.
  const { url, users } = await withServer(t, { ...PROXY, ND_EXTAUTH_USERHEADER: '' });
  const headers = { 'Remote-User': users.admin.username };
  assert.ok(!ok(await send(`${url}/rest/getUsers?${COMMON}`, { headers })), 'no password, and the admin-only call answered');
  assert.notEqual((await postJson(`${url}/auth/app-passwords`, { name: 'x' }, { headers })).status, 200, 'a permanent key was made for the admin');
});

test('F2. behind a trusted proxy, a True-Client-IP the client chose does not reset the sign-in limit', { timeout: 300_000 }, async t => {
  // True-Client-IP and X-Real-IP are believed before X-Forwarded-For. A proxy that only appends to X-Forwarded-For
  // (nginx's proxy_add_x_forwarded_for, and nothing else set) passes the client's True-Client-IP through.
  const { url, users } = await withServer(t, { ...PROXY, ...LIMITS });
  const { username, password } = users.secure;
  const statuses = [];
  for (let i = 0; i < 12; i++) {
    const headers = { 'True-Client-IP': `203.0.113.${i}`, 'X-Forwarded-For': '198.51.100.7' };
    statuses.push((await postJson(`${url}/auth/login`, { username, password, otp: '000000' }, { headers })).status);
  }
  assert.ok(statuses.includes(429), `12 wrong codes from one client were all tried: ${statuses.join(' ')}`);
});

test('F3. wrong authenticator codes for one account are limited however many addresses they come from', { timeout: 300_000 }, async t => {
  // Limits are per address (web sign-in) or per address and user name (Subsonic); nothing counts per account. With the
  // password known, the second step is 1 000 000 codes of which 3 are right at any time.
  const { url, users } = await withServer(t, LIMITS);
  const { username, password } = users.secure;
  const statuses = [];
  for (let address = 2; address <= 21; address++) {
    const tries = [0, 1, 2, 3, 4].map(() => postJson(`${url}/auth/login`, { username, password, otp: '000000' }, { localAddress: `127.0.0.${address}` }));
    statuses.push(...(await Promise.all(tries)).map(r => r.status));
  }
  assert.ok(statuses.includes(429), `${statuses.filter(s => s === 401).length} wrong codes in one window were all tried`);
});

test('F4. anonymous clients cannot take every place in the browser sign-in waiting list', { timeout: 300_000 }, async t => {
  // 200 places for the whole server, 10 minutes each, 5 starts per address per 20 s: 40 addresses fill it at once and
  // one address keeps it full (15 starts a minute against 20 expiring).
  const { url } = await withServer(t, LIMITS);
  for (let address = 100; address < 140; address++) {
    await Promise.all([0, 1, 2, 3, 4].map(() => postJson(`${url}/auth/device/start`, { client: 'x', device: 'y' }, { localAddress: `127.0.0.${address}` })));
  }
  const app = await postJson(`${url}/auth/device/start`, { client: 'Sonus', device: 'my PC' }, { localAddress: '127.0.0.200' });
  assert.equal(app.status, 200, `a real app could not start signing in: ${app.text}`);
});

test('F5. a request whose body never arrives is given up on', { timeout: 300_000 }, async t => {
  // Form posts to /rest are read whole (up to 10 MiB) before the credentials are looked at, with no time limit:
  // 30 unfinished ones held 300 MiB for as long as the connections stayed open.
  const { url } = await withServer(t);
  const socket = net.connect({ host: '127.0.0.1', port: Number(new URL(url).port) });
  t.after(() => socket.destroy());
  let closed = false;
  socket.on('close', () => { closed = true; }).on('error', () => {});
  socket.resume(); // the answer is read (and dropped), or the end of the connection is never seen
  socket.write(`POST /rest/ping?${COMMON} HTTP/1.1\r\nHost: x\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: 10485760\r\n\r\nx=`);
  socket.write(Buffer.alloc(1 << 20, 0x61));
  await sleep(45_000);
  assert.ok(closed, 'after 45 s the server still held the megabyte it was sent and waited for the rest');
});

test('F6. turning two-step verification on ends the sessions made before it', { timeout: 300_000 }, async t => {
  // Sessions end only when the password changes. One opened with the password alone (stolen, or the thief's own) goes
  // on working after the owner turns two-step verification on, and can make itself an app password without a code.
  const { url, users } = await withServer(t, { ND_SONUS_TWOFACTOR: 'optional' });
  const { username, password } = users.listener;
  const thief = { 'X-ND-Authorization': `Bearer ${(await postJson(`${url}/auth/login`, { username, password })).json.token}` };
  const owner = { 'X-ND-Authorization': `Bearer ${(await postJson(`${url}/auth/login`, { username, password })).json.token}` };
  const setup = await postJson(`${url}/auth/2fa/setup`, {}, { headers: owner });
  assert.equal((await postJson(`${url}/auth/2fa/confirm`, { code: totp(setup.json.secret) }, { headers: owner })).status, 200);
  assert.equal((await send(`${url}/api/song?_end=1`, { headers: thief })).status, 401, 'the other session still reads the library');
  assert.notEqual((await postJson(`${url}/auth/app-passwords`, { name: 'kept' }, { headers: thief })).status, 200, 'and made an app password');
});
