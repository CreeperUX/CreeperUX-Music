// The test vectors of Sonus Connect version 2 (docs/protocol/connect-vectors.json) replayed through the web client's
// session state (web/src/api/connect.js). Every device of a case is a client here: it gets the welcome, sessions, queues,
// devices and replies the vectors say the server sends, and the test checks what the client makes of them, step by step:
//   - the messages it would send are exactly the vectors' (hello, commands, reports);
//   - the entry keys it sends (jump, move, remove) are keys its own queue panel lists, unless the server answers stale;
//   - its reports are about the entry its player loaded, at the session rev it followed;
//   - it knows whether it is the active device, where the session plays, and the position moving;
//   - its player follows the session: the active device loads the current entry, seeks, plays or pauses; the device
//     playback leaves stops at once; the others stay silent;
//   - errors it shows and errors it keeps quiet (stale, notActive), and another device's volume command.
// Run: node --test web/test/connect-vectors.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createSessionState, entriesOf, follow, hello, command, report, modeOf, orderOf, QUIET_ERRORS, pickerDevices, windowOf, newDeviceId, validDeviceId } from '../src/api/connect.js';

const V = JSON.parse(readFileSync(fileURLToPath(new URL('../../docs/protocol/connect-vectors.json', import.meta.url)), 'utf8'));
const ACTIONS = new Set(['play', 'pause', 'toggle', 'seek', 'next', 'previous', 'playContext', 'jump', 'add', 'move', 'remove', 'clear', 'mode', 'stopAfterCurrent', 'transfer', 'volume']);
const EVENTS = new Set(['loaded', 'playing', 'paused', 'position', 'ended', 'failed']);
const strip = ({ ref, ...m }) => m;

test('the vectors are there and not empty', () => {
  assert.ok(V.cases.length >= 10, `${V.cases.length} cases`);
});

for (const c of V.cases) {
  test(c.name, () => {
    const clients = new Map(); // device id → { state, engine, hello, connected }
    const helloOf = new Map();
    let n = 0;
    for (const step of c.steps) {
      n++;
      const where = `step ${n}`, at = step.at, x = step.expect, s = x.session;
      const repliesTo = id => x.replies.filter(r => r.to === id && r.msg).map(r => r.msg);

      // ---- what a device sends
      if (step.send) {
        const m = step.send, from = step.from;
        const errors = repliesTo(from).filter(r => r.type === 'error' && r.ref === m.ref);
        const refusedAs = code => errors.some(e => e.code === code);
        const quietRefusal = refusedAs('stale') || refusedAs('notActive');
        if (m.type === 'hello') {
          helloOf.set(m.deviceId, m);
          // the client's hello is this message
          if (validDeviceId(m.deviceId) && m.name) assert.deepEqual(hello({ deviceId: m.deviceId, name: m.name, kind: m.kind, canPlay: m.canPlay, client: m.client, volume: m.volume, muted: m.muted, resume: m.resume }), m, `${where}: hello`);
          if (!clients.has(m.deviceId)) clients.set(m.deviceId, { state: createSessionState({ deviceId: m.deviceId }), engine: { key: null, trackId: null, state: 'none', position: 0 } });
          clients.get(m.deviceId).connected = !x.replies.some(r => r.reply);
        }
        const me = clients.get(from);
        if (m.type === 'command' && ACTIONS.has(m.action)) {
          const { type, action, ...fields } = strip(m);
          assert.deepEqual(command(action, fields), strip(m), `${where}: command ${action}`);
          if (m.action === 'mode' && !refusedAs('invalid')) assert.equal(modeOf(orderOf(m.mode)), m.mode, `${where}: mode ${m.mode} is one of the client's orders`);
          // entry keys come from this device's own queue panel (unless the queue moved on meanwhile: stale)
          const listed = new Set(me.state.entries().map(e => e.id));
          if (m.action === 'jump' && !quietRefusal) assert.ok(listed.has(m.entry), `${where}: jump ${m.entry} is listed (${[...listed]})`);
          if (m.action === 'move' && !quietRefusal) {
            assert.deepEqual(new Set(m.order), listed, `${where}: a move lists every entry the panel shows`);
            for (const k of m.keys) assert.ok(listed.has(k), `${where}: moved ${k} is listed`);
          }
          if (m.action === 'remove') {
            const stale = new Set(errors.find(e => e.code === 'stale')?.entries ?? []);
            for (const k of m.entries) if (!stale.has(k)) assert.ok(listed.has(k), `${where}: removed ${k} is listed`);
            for (const k of stale) assert.ok(!listed.has(k) || m.entries.includes(k), `${where}: ${k} answered stale`);
          }
        }
        if (m.type === 'report' && EVENTS.has(m.event)) {
          assert.deepEqual(report(m.event, m.key, m.positionMs, m.rev, { durationMs: m.durationMs, now: m.now }), strip(m), `${where}: report ${m.event}`);
          if (!quietRefusal && !refusedAs('invalid')) {
            // accepted: it is the active device, about the entry its player has, at the rev it followed
            assert.ok(me.state.isActive, `${where}: only the active device reports`);
            assert.equal(m.key, me.engine.key, `${where}: the report is about the entry the player loaded`);
            if (['playing', 'paused', 'position'].includes(m.event)) assert.equal(m.rev, me.state.session.rev, `${where}: at the rev it followed`);
            else assert.ok(m.rev <= me.state.session.rev, `${where}: rev ${m.rev}`);
          } else if (refusedAs('notActive')) assert.ok(!me.state.isActive, `${where}: refused as not active, and the client knew`);
          // the player as the report says it now is
          const e = me.engine;
          if (m.event === 'playing') Object.assign(e, { state: 'playing', position: m.positionMs });
          if (m.event === 'paused') Object.assign(e, { state: 'paused', position: m.positionMs });
          if (m.event === 'position') e.position = m.positionMs;
          if (m.event === 'ended') Object.assign(e, { state: 'ended', position: m.positionMs });
          if (m.event === 'failed') e.state = 'error';
        }
      }
      if (step.drop || step.leave) {
        const cl = clients.get(step.drop || step.leave);
        cl.connected = false; cl.state.disconnected();
      }

      // ---- what the server sends: direct replies, then the broadcasts
      for (const r of x.replies) {
        if (r.close) { const cl = clients.get(r.close); if (cl) { cl.connected = false; cl.state.disconnected(); } continue; }
        if (!r.to || !r.msg) continue;
        const cl = clients.get(r.to);
        const said = cl.state.receive({ ...r.msg }, at);
        if (r.msg.type === 'error') {
          assert.equal(said.error.code, r.msg.code, `${where}: error passed on`);
          // shown to the user unless the session simply moved on
          assert.equal(QUIET_ERRORS.has(r.msg.code), r.msg.code === 'stale' || r.msg.code === 'notActive', `${where}: ${r.msg.code} shown or not`);
          if (r.msg.code === 'unplayable') assert.ok(typeof r.msg.message === 'string' && r.msg.message.length > 0 && typeof r.msg.stopped === 'boolean', `${where}: unplayable names the song and says whether it stopped`);
        }
        if (r.msg.type === 'deviceCommand') assert.deepEqual(said.volume, { volume: r.msg.volume, muted: r.msg.muted, from: r.msg.from }, `${where}: volume asked`);
        if (r.msg.type === 'ack') assert.equal(said.ack.ref, r.msg.ref, `${where}: ack`);
      }
      const deviceList = x.devices.map(id => ({ id, name: helloOf.get(id)?.name ?? id, kind: helloOf.get(id)?.kind ?? 'other', canPlay: helloOf.get(id)?.canPlay !== false, volume: 1, muted: false }));
      for (const [id, cl] of clients) {
        if (!cl.connected) continue;
        if (step.send?.type === 'hello' && step.from === id) cl.state.receive({ type: 'welcome', version: 2, deviceId: id, serverTime: at, session: s, queue: x.queue, devices: deviceList }, at);
        else { cl.state.receive({ type: 'queue', queue: x.queue }, at); cl.state.receive({ type: 'session', serverTime: at, session: s }, at); cl.state.receive({ type: 'devices', serverTime: at, devices: deviceList }, at); }
      }

      // ---- what each connected device makes of it
      for (const [id, cl] of clients) {
        if (!cl.connected) continue;
        const st = cl.state;
        assert.deepEqual(st.session, s, `${where}: ${id} holds the session`);
        assert.ok(st.queueReady, `${where}: ${id} has the session's queue`);
        assert.equal(st.isActive, s.activeDevice === id, `${where}: ${id} knows whether it plays`);
        const panel = entriesOf(x.queue);
        assert.equal(panel.length, x.queue.manual.length + Math.max(0, x.queue.order.length - x.queue.pointer - 1), `${where}: entries`);
        assert.deepEqual(panel.filter(e => e.section === 'queue').map(e => e.id), x.queue.manual.map(m => m.key), `${where}: manual keys`);
        // the position moving, from the server's clock
        const want = s.playing ? Math.min(s.positionMs + Math.max(0, at - s.at), s.durationMs || Infinity) : s.positionMs;
        assert.equal(st.positionAt(st.serverNow(at)), want, `${where}: ${id}'s position`);
        // where it plays, as the bar says it
        const w = st.where();
        if (!s.current) assert.equal(w, null, `${where}: nothing to say`);
        else if (s.activeDevice === id) assert.equal(w, null, `${where}: plays here`);
        else if (s.activeDevice) assert.equal(w, `正在「${helloOf.get(s.activeDevice)?.name ?? '另一台设备'}」上播放`, `${where}: plays elsewhere`);
        else if (s.lastDevice) assert.equal(w, `上次在「${s.lastDevice.id === id ? '这个浏览器' : (x.devices.includes(s.lastDevice.id) ? helloOf.get(s.lastDevice.id).name : s.lastDevice.name)}」播放`, `${where}: played last`);
        const picker = pickerDevices(st);
        assert.equal(picker[0].id, id, `${where}: this device first in the picker`);
        assert.equal(picker.filter(d => d.active).length, s.activeDevice && (s.activeDevice === id || x.devices.includes(s.activeDevice)) ? 1 : 0, `${where}: the active device marked`);

        // the player follows the session
        const e = cl.engine, plan = follow(s, id, e, st.positionAt(st.serverNow(at)));
        if (s.activeDevice !== id || !s.current) {
          if (e.key || e.state !== 'none') assert.ok(plan.stop, `${where}: ${id} stops (not the active device)`);
          cl.engine = { key: null, trackId: null, state: 'none', position: 0 };
        } else if (s.current.key !== e.key) {
          assert.deepEqual(plan.load, { key: s.current.key, trackId: s.current.trackId, at: want, play: s.playing }, `${where}: ${id} loads the current entry`);
          cl.engine = { key: s.current.key, trackId: s.current.trackId, state: s.playing ? 'playing' : 'paused', position: want };
        } else if (plan.load) {
          assert.equal(e.state, 'ended', `${where}: loaded again only after an end`);
          cl.engine = { ...e, state: 'playing', position: want };
        } else if (!plan.idle) {
          if (plan.seek !== undefined) e.position = plan.seek;
          if (plan.play) { assert.ok(s.playing, `${where}: plays as the session does`); e.state = 'playing'; }
          if (plan.pause) { assert.ok(!s.playing, `${where}: pauses as the session does`); e.state = 'paused'; }
          assert.ok(!(s.playing && e.state === 'paused') && !(!s.playing && e.state === 'playing'), `${where}: ${id} plays or pauses as the session (${e.state})`);
          assert.ok(Math.abs(e.position - want) <= 1500, `${where}: ${id} at the session's position`);
          assert.equal(plan.preload, s.next && s.next !== s.current.trackId ? s.next : null, `${where}: preloads what follows`);
        }
      }
    }
  });
}

test('a session older than the one held is ignored; a welcome is taken whatever its rev', () => {
  const st = createSessionState({ deviceId: 'web-device-01' });
  st.receive({ type: 'welcome', serverTime: 100, session: { ...V.cases[0].steps.at(-1).expect.session }, queue: V.cases[0].steps.at(-1).expect.queue, devices: [] }, 100);
  const rev = st.session.rev;
  assert.deepEqual(st.receive({ type: 'session', serverTime: 120, session: { ...st.session, rev: rev - 1, playing: !st.session.playing } }, 120), {});
  assert.equal(st.session.rev, rev);
  st.disconnected();
  st.receive({ type: 'welcome', serverTime: 200, session: { ...st.session, rev: 1 }, queue: { queueRev: 0, order: [], pointer: -1, manual: [] }, devices: [] }, 200);
  assert.equal(st.session.rev, 1);
});

test('the clock offset: positions are read on the server\'s clock', () => {
  const st = createSessionState({ deviceId: 'web-device-01' });
  st.receive({ type: 'welcome', serverTime: 1_000_000, session: { ...V.cases[0].steps[0].expect.session, current: { key: 'c0:t0', trackId: 't0', manual: false }, playing: true, positionMs: 5000, at: 999_000, durationMs: 60_000 }, queue: { queueRev: 0, order: ['t0'], pointer: 0, manual: [] }, devices: [] }, 50);
  assert.equal(st.serverNow(50), 1_000_000);
  assert.equal(st.positionAt(st.serverNow(1050)), 7000);
  assert.equal(st.positionAt(st.serverNow(10_000_000)), 60_000, 'not past the song');
});

test('orders, windows and device ids', () => {
  for (const o of ['default', 'repeat-playlist', 'repeat-track', 'random', 'shuffle-tracks', 'shuffle-albums', 'shuffle-folders']) assert.equal(orderOf(modeOf(o)), o);
  const ids = Array.from({ length: 12_000 }, (_, i) => `t${i}`);
  assert.equal(windowOf(ids, 't5000').length, 10_000);
  assert.equal(windowOf(ids, 't1000')[0], 't900');
  assert.equal(windowOf(ids, 't5000')[0], 't2000', 'not past the end');
  assert.equal(windowOf(ids, null)[0], 't0');
  assert.equal(windowOf(ids, 't11999').at(-1), 't11999');
  const id = newDeviceId();
  assert.ok(validDeviceId(id) && id.length === 22, id);
  assert.ok(!validDeviceId('short') && !validDeviceId('has space here'));
});
