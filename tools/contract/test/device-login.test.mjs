// Signing in through the browser (sonusDeviceLogin v1, the fork's SONUS.md): start, poll, the user's decision, the
// key handed over once, tokenInfo with it, revoke.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approver, decideDeviceLogin, hasExtension, manifest, BASE, CLIENT } from '../lib/context.mjs';
import { webJson } from '../lib/web.mjs';
import { Subsonic } from '../lib/subsonic.mjs';

const skip = async () => ((await hasExtension('sonusDeviceLogin')) ? false : 'the server does not advertise sonusDeviceLogin');
const start = body => webJson(BASE, '/auth/device/start', { method: 'POST', body });
const poll = deviceCode => webJson(BASE, '/auth/device/poll', { method: 'POST', body: { deviceCode } });
const revoke = apiKey => webJson(BASE, '/auth/device/revoke', { method: 'POST', body: { apiKey } });

test('start answers the codes, where to approve and how often to poll', { skip: await skip() }, async () => {
  const r = await start({ client: 'Sonus', device: 'Contract 书房' });
  assert.equal(r.status, 200);
  assert.equal(typeof r.json.deviceCode, 'string');
  assert.match(r.json.userCode, /^[A-Z]{4}-[A-Z]{4}$/);
  assert.ok(r.json.verificationPath.endsWith(`/#/device?code=${r.json.userCode}`), r.json.verificationPath);
  assert.ok(Number.isInteger(r.json.expiresIn) && r.json.expiresIn > 0);
  assert.ok(Number.isInteger(r.json.interval) && r.json.interval > 0);
  const p = await poll(r.json.deviceCode);
  assert.equal(p.status, 200);
  assert.equal(p.json.status, 'pending');
});

test('approved: the key comes once, signs in, tokenInfo names the user, revoke ends it', { skip: await skip() }, async () => {
  const s = (await start({ client: 'Sonus', device: 'Contract' })).json;
  await decideDeviceLogin(s.userCode, true);
  const p = await poll(s.deviceCode);
  assert.equal(p.json.status, 'approved');
  assert.equal(p.json.username, manifest.users[approver].username);
  assert.equal(typeof p.json.apiKey, 'string');
  assert.equal((await poll(s.deviceCode)).json.status, 'expired', 'the key is handed over once');

  const key = new Subsonic(BASE, { apiKey: p.json.apiKey }, { client: CLIENT });
  assert.equal((await key.ok('tokenInfo')).tokenInfo.username, p.json.username);
  assert.equal((await key.call('ping')).body.status, 'ok');

  const r = await revoke(p.json.apiKey);
  assert.equal(r.status, 204);
  assert.equal((await key.call('ping')).body.error?.code, 44, 'a revoked key is error 44');
  assert.equal((await revoke(p.json.apiKey)).status, 404, 'revoking it again: 404');
});

test('denied: the poll says so, once', { skip: await skip() }, async () => {
  const s = (await start({ client: 'Sonus', device: 'Contract (denied)' })).json;
  await decideDeviceLogin(s.userCode, false);
  assert.equal((await poll(s.deviceCode)).json.status, 'denied');
  assert.equal((await poll(s.deviceCode)).json.status, 'expired');
});

test('an unknown device code polls as expired', { skip: await skip() }, async () => {
  assert.equal((await poll('no-such-device-code')).json.status, 'expired');
});

test('device sign-in: a body that is not JSON, or a revoke without a key, is 422', { skip: await skip() }, async () => {
  const bad = await fetch(`${BASE}/auth/device/poll`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'not json' });
  assert.equal(bad.status, 422);
  await bad.arrayBuffer();
  assert.equal((await webJson(BASE, '/auth/device/revoke', { method: 'POST', body: {} })).status, 422);
});
