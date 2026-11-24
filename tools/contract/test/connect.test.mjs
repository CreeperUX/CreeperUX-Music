// Sonus Connect v1 (the fork's server/connect/README.md): a WebSocket at rest/connect signed in as a Subsonic request;
// welcome, the device list, hello, state, a command from one connection to another, the offline error, a transfer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, getLibrary, hasExtension, BASE } from '../lib/context.mjs';

const skip = async () => ((await hasExtension('sonusConnect')) ? false : 'the server does not advertise sonusConnect');

/** A Connect connection with an inbox: next(predicate) takes the first message (seen or to come) that matches. */
function connect(client, query = api.with(api.auth, { client }).query()) {
  const url = `${BASE.replace(/^http/, 'ws')}/rest/connect?${query}`;
  const ws = new WebSocket(url);
  const inbox = [], waiting = [];
  ws.addEventListener('message', e => {
    inbox.push(JSON.parse(e.data));
    for (const w of [...waiting]) w.check();
  });
  const opened = new Promise((done, fail) => {
    ws.addEventListener('open', () => done(), { once: true });
    ws.addEventListener('error', () => fail(new Error(`${client}: the WebSocket did not open`)), { once: true });
  });
  const next = (match, what = 'a message', ms = 5000) => new Promise((done, fail) => {
    const w = {
      check() {
        const i = inbox.findIndex(match);
        if (i < 0) return;
        const [m] = inbox.splice(i, 1);
        waiting.splice(waiting.indexOf(w), 1);
        clearTimeout(w.timer);
        done(m);
      },
    };
    w.timer = setTimeout(() => { waiting.splice(waiting.indexOf(w), 1); fail(new Error(`${client}: no ${what} in ${ms} ms; got ${JSON.stringify(inbox.map(m => m.type))}`)); }, ms);
    waiting.push(w);
    w.check();
  });
  const send = m => ws.send(JSON.stringify(m));
  const close = () => new Promise(done => { if (ws.readyState === WebSocket.CLOSED) return done(); ws.addEventListener('close', () => done(), { once: true }); ws.close(); });
  return { ws, opened, next, send, close, inbox };
}

test('Connect: welcome, then the device list', { skip: await skip() }, async () => {
  const a = connect('contract-connect-a');
  try {
    await a.opened;
    const welcome = await a.next(m => m.type === 'welcome', 'welcome');
    assert.equal(welcome.version, 1);
    assert.equal(typeof welcome.deviceId, 'string');
    assert.ok(Math.abs(welcome.serverTime - Date.now()) < 60_000, 'serverTime is now, in ms');
    const devices = await a.next(m => m.type === 'devices', 'devices');
    const me = devices.devices.find(d => d.id === welcome.deviceId);
    assert.ok(me, 'this connection is in the list');
    assert.equal(typeof me.name, 'string');
    assert.equal(typeof me.kind, 'string');
    assert.equal(typeof me.canPlay, 'boolean');
    assert.ok(Number.isInteger(me.connectedAt));
  } finally { await a.close(); }
});

test('Connect: hello names the device; state reaches the others; a command goes from one connection to another', { skip: await skip() }, async () => {
  const a = connect('contract-connect-a'), b = connect('contract-connect-b');
  try {
    await Promise.all([a.opened, b.opened]);
    const [wa, wb] = await Promise.all([a.next(m => m.type === 'welcome'), b.next(m => m.type === 'welcome')]);
    assert.notEqual(wa.deviceId, wb.deviceId, 'two clients are two devices');

    a.send({ type: 'hello', name: 'Contract A', kind: 'desktop', canPlay: true });
    const named = await b.next(m => m.type === 'devices' && m.devices.some(d => d.id === wa.deviceId && d.name === 'Contract A'), 'A’s hello');
    assert.equal(named.devices.find(d => d.id === wa.deviceId).kind, 'desktop');

    const songId = (await getLibrary()).songs[0].id;
    b.send({ type: 'state', state: { trackId: songId, title: 'T', artist: 'A', album: 'L', durationMs: 3000, positionMs: 1200, playing: true, volume: 0.5, index: 0, count: 1 }, queue: { ids: [songId], index: 0 } });
    const withState = await a.next(m => m.type === 'devices' && m.devices.some(d => d.id === wb.deviceId && d.state), 'B’s state');
    const st = withState.devices.find(d => d.id === wb.deviceId).state;
    assert.equal(st.trackId, songId);
    assert.equal(st.positionMs, 1200);
    assert.equal(st.playing, true);
    assert.ok(Number.isInteger(st.at), 'the server stamps when it got the state');

    a.send({ type: 'command', target: wb.deviceId, command: { action: 'seek', positionMs: 2000 } });
    const cmd = await b.next(m => m.type === 'command', 'the command');
    assert.equal(cmd.from, wa.deviceId);
    assert.deepEqual(cmd.command, { action: 'seek', positionMs: 2000 });

    a.send({ type: 'command', target: 'no-such-device', command: { action: 'pause' } });
    const err = await a.next(m => m.type === 'error', 'the offline error');
    assert.equal(err.code, 'offline');
    assert.equal(typeof err.message, 'string');

    a.send({ type: 'transfer', from: wb.deviceId, to: wa.deviceId });
    const load = await a.next(m => m.type === 'command' && m.command.action === 'load', 'the load');
    assert.deepEqual(load.command.queue, { ids: [songId], index: 0 });
    assert.equal(load.command.play, true);
    assert.equal(load.command.source, wb.deviceId);
    assert.ok(load.command.positionMs >= 1200);
    assert.equal((await b.next(m => m.type === 'command' && m.command.action === 'stop', 'the stop')).from, wa.deviceId);
  } finally { await Promise.all([a.close(), b.close()]); }
});

test('Connect: a device that leaves is gone from the others’ list', { skip: await skip() }, async () => {
  const a = connect('contract-connect-a'), b = connect('contract-connect-b');
  try {
    await Promise.all([a.opened, b.opened]);
    const wb = await b.next(m => m.type === 'welcome');
    await a.next(m => m.type === 'devices' && m.devices.some(d => d.id === wb.deviceId), 'B in the list');
    await b.close();
    await a.next(m => m.type === 'devices' && !m.devices.some(d => d.id === wb.deviceId), 'B gone');
  } finally { await Promise.all([a.close(), b.close()]); }
});

test('Connect: a wrong password gets no connection', { skip: await skip() }, async () => {
  const bad = connect('contract-connect-bad', api.with({ u: api.auth.u, password: 'wrong' }, { client: 'contract-connect-bad' }).query());
  await assert.rejects(bad.opened);
  await bad.close();
});
