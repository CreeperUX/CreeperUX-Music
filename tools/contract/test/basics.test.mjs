// ping, getOpenSubsonicExtensions, getScanStatus: what a client checks when it connects.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, anon, manifest, BASE, ISO_DATE } from '../lib/context.mjs';

test('ping answers ok with the server identification clients show', async () => {
  const { http, headers, body } = await api.call('ping');
  assert.equal(http, 200);
  assert.match(headers.get('content-type'), /^application\/json/);
  assert.equal(body.status, 'ok');
  assert.match(body.version, /^\d+\.\d+\.\d+$/);
  assert.equal(typeof body.type, 'string');
  assert.equal(typeof body.serverVersion, 'string');
  assert.equal(body.openSubsonic, true);
  if (manifest.server?.serverVersion) assert.equal(body.serverVersion, manifest.server.serverVersion);
});

test('ping.view (the suffix older clients add) answers the same', async () => {
  const res = await fetch(`${BASE}/rest/ping.view?${api.query()}`);
  assert.equal((await res.json())['subsonic-response'].status, 'ok');
});

test('getOpenSubsonicExtensions needs no sign-in and lists what Sonus looks for', async () => {
  const body = await anon.ok('getOpenSubsonicExtensions');
  const list = body.openSubsonicExtensions;
  assert.ok(Array.isArray(list));
  for (const e of list) {
    assert.equal(typeof e.name, 'string');
    assert.ok(Array.isArray(e.versions) && e.versions.every(Number.isInteger), `${e.name}: versions`);
  }
  const names = new Set(list.map(e => e.name));
  for (const n of ['formPost', 'songLyrics', 'apiKeyAuthentication', 'sonusDeviceLogin', 'sonusConnect']) assert.ok(names.has(n), `missing ${n}`);
  if (manifest.server?.openSubsonicExtensions) assert.deepEqual([...names].sort(), manifest.server.openSubsonicExtensions);
});

const origin = 'https://sonus.example';

test('CORS: /rest answers pages from other origins (the web client)', async () => {
  const get = await fetch(api.url('ping'), { headers: { Origin: origin } });
  assert.equal(get.headers.get('access-control-allow-origin'), '*');
  await get.arrayBuffer();
});

test('CORS preflight: /rest and the browser sign-in allow a POST from other origins', async () => {
  for (const path of ['/rest/ping', '/auth/device/start']) {
    const pre = await fetch(`${BASE}${path}`, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
    assert.ok(pre.status === 200 || pre.status === 204, `${path}: preflight ${pre.status}`);
    assert.equal(pre.headers.get('access-control-allow-origin'), '*', path);
    await pre.arrayBuffer();
  }
});

test('getScanStatus reports the library size and whether a scan runs', async () => {
  const s = (await api.ok('getScanStatus')).scanStatus;
  assert.equal(typeof s.scanning, 'boolean');
  assert.ok(Number.isInteger(s.count));
  if (manifest.counts?.songs !== undefined) assert.equal(s.count, manifest.counts.songs);
  if (s.lastScan !== undefined) assert.match(s.lastScan, ISO_DATE);
});
