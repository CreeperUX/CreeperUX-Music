// The demo server's Sonus Connect version 2 over its real WebSocket (connect2.mjs): the extension's versions, a hello and
// a command, version 1 beside it, a second connection replacing the first, and the session kept across a restart.
// Usage: node --test tools/demo-server/connect2.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

async function demo(env = {}) {
  const port = 5100 + Math.floor(Math.random() * 800);
  const p = spawn(process.execPath, [join(here, 'demo-server.mjs'), String(port)], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((ok, fail) => { p.stdout.on('data', d => { if (String(d).includes('demo server')) ok(); }); p.on('exit', fail); });
  return { url: `http://127.0.0.1:${port}`, port, stop: () => new Promise(r => { p.on('exit', r); p.kill(); }) };
}

function auth() {
  const salt = Math.random().toString(16).slice(2, 10);
  return new URLSearchParams({ u: 'demo', t: createHash('md5').update('demo' + salt).digest('hex'), s: salt, v: '1.16.1', c: 'node-test', f: 'json' });
}

/** A device: its socket, every message it got, and waiting for one. */
async function device(server, deviceId, name, protocol = '2') {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/rest/connect?${protocol ? `protocol=${protocol}&` : ''}${auth()}`);
  const got = [];
  let wake = () => {};
  ws.onmessage = e => { got.push(JSON.parse(e.data)); wake(); };
  await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });
  const d = {
    ws, got, closed: new Promise(r => { ws.onclose = e => r(e.code); }),
    send: msg => ws.send(JSON.stringify(msg)),
    async until(pred, what) {
      const t0 = Date.now();
      for (;;) {
        const m = got.find(pred);
        if (m) return m;
        if (Date.now() - t0 > 5000) throw new Error(`timed out: ${what}: ${JSON.stringify(got.slice(-3))}`);
        await new Promise(r => { wake = r; setTimeout(r, 100); });
      }
    },
  };
  if (protocol === '2') d.send({ type: 'hello', deviceId, name, kind: 'desktop', canPlay: true, client: 'node test' });
  return d;
}

test('the demo server advertises versions 1 and 2, and speaks version 2 at protocol=2 beside version 1', async () => {
  const server = await demo();
  try {
    const ext = (await (await fetch(`${server.url}/rest/getOpenSubsonicExtensions.view?${auth()}`)).json())['subsonic-response'].openSubsonicExtensions;
    assert.deepEqual(ext.find(e => e.name === 'sonusConnect').versions, [1, 2]);
    const a = await device(server, 'node-test-A', '甲');
    const welcome = await a.until(m => m.type === 'welcome', 'welcome');
    assert.equal(welcome.version, 2);
    a.send({ type: 'command', ref: '1', action: 'playContext', context: { kind: 'album', id: 'al3', label: 'x' }, ids: ['t20', 't21', 't22'], startId: 't21' });
    const ack = await a.until(m => m.type === 'ack' && m.ref === '1', 'ack');
    const s = await a.until(m => m.type === 'session' && m.session.rev === ack.rev, 'session');
    assert.equal(s.session.activeDevice, 'node-test-A');
    assert.equal(s.session.current.trackId, 't21');
    assert.ok(s.session.now.title && s.session.durationMs > 0, 'the server fills in what it knows of the song');
    // version 1 does not see version 2's devices
    const v1 = await device(server, null, null, '');
    const w1 = await v1.until(m => m.type === 'welcome', 'v1 welcome');
    assert.equal(w1.version, 1);
    const hook = await (await fetch(`${server.url}/__test/connect2?u=demo`)).json();
    assert.deepEqual(hook.devices.map(d => d.id), ['node-test-A']);
    // a second connection with the same id replaces the first (4000)
    const again = await device(server, 'node-test-A', '甲');
    assert.equal(await a.closed, 4000);
    await again.until(m => m.type === 'welcome' && m.session.activeDevice === 'node-test-A', 'still the active device');
    again.ws.close(); v1.ws.close();
  } finally { await server.stop(); }
});

test('SONUS_DEMO_CONNECT=1 advertises version 1 only', async () => {
  const server = await demo({ SONUS_DEMO_CONNECT: '1' });
  try {
    const ext = (await (await fetch(`${server.url}/rest/getOpenSubsonicExtensions.view?${auth()}`)).json())['subsonic-response'].openSubsonicExtensions;
    assert.deepEqual(ext.find(e => e.name === 'sonusConnect').versions, [1]);
  } finally { await server.stop(); }
});

test('the session is kept across a restart (SONUS_DEMO_CONNECT_STORE), with no active device, where it was', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sonus-connect-'));
  const env = { SONUS_DEMO_CONNECT_STORE: join(dir, 'sessions.json'), SONUS_DEMO_CONNECT_GRACE: '300' };
  try {
    let server = await demo(env);
    const a = await device(server, 'node-test-B', '乙');
    a.send({ type: 'command', ref: 'p', action: 'playContext', ids: ['t30', 't31'], startId: 't30' });
    await a.until(m => m.type === 'ack' && m.ref === 'p', 'played');
    a.send({ type: 'command', ref: 's', action: 'seek', positionMs: 42_000 });
    a.send({ type: 'command', ref: 'z', action: 'pause' });
    await a.until(m => m.type === 'ack' && m.ref === 'z', 'paused');
    await new Promise(r => setTimeout(r, 1300)); // written within a second
    a.ws.close();
    await server.stop();
    server = await demo(env);
    const b = await device(server, 'node-test-C', '丙');
    const w = await b.until(m => m.type === 'welcome', 'welcome');
    assert.equal(w.session.activeDevice, null);
    assert.equal(w.session.current.trackId, 't30');
    assert.equal(w.session.playing, false);
    assert.ok(Math.abs(w.session.positionMs - 42_000) < 100, String(w.session.positionMs));
    assert.deepEqual(w.session.lastDevice, { id: 'node-test-B', name: '乙' });
    b.ws.close();
    await server.stop();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
