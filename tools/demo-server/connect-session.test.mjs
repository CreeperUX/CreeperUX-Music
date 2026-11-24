// Tests of Sonus Connect version 2's session logic (connect-session.mjs) and of the test vectors it gave
// (docs/protocol/connect-vectors.json, made by connect-vectors.mjs).
// Usage: node --test tools/demo-server/connect-session.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ConnectSession, PlayQueue, sequenceRandom, window } from './connect-session.mjs';
import { replay, VECTORS } from './connect-vectors.mjs';

// ---------------------------------------------------------------- the queue: PlayQueueTests (tests/Sonus.Core.Tests/UnitTests.cs)
const all = Array.from({ length: 10 }, (_, i) => `t${i}`);
const queue = (values = []) => new PlayQueue({ has: id => all.includes(id), random: sequenceRandom(values) });

test('queue: plays in order and stops at the end', () => {
  const q = queue();
  assert.equal(q.start(all, 't8'), 't8');
  assert.equal(q.peek(), 't9');
  assert.equal(q.next(), 't9');
  assert.equal(q.peek(), null);
  assert.equal(q.next(), null);
});

test('queue: repeat all wraps, repeat one replays, the next button still moves on', () => {
  const q = queue();
  q.start(all, 't9');
  q.setOrder('repeatAll');
  assert.equal(q.peek(), 't0');
  assert.equal(q.next(), 't0');
  q.setOrder('repeatOne');
  assert.equal(q.peek(), null);
  assert.equal(q.next(true), 't0');
  assert.equal(q.next(), 't1');
});

test('queue: hand-queued songs play first; "play next" goes in front', () => {
  const q = queue();
  q.start(all, 't0');
  q.add(['t5', 't6']);
  q.add(['t9'], true);
  assert.deepEqual(q.entries.slice(0, 4).map(e => e.trackId), ['t9', 't5', 't6', 't1']);
  assert.deepEqual(['t9', 't5', 't6', 't1'].map(() => q.next()), ['t9', 't5', 't6', 't1']);
});

test('queue: stop after current stops once at the end of the song', () => {
  const q = queue();
  q.start(all, 't0');
  q.stopAfterCurrent = true;
  assert.equal(q.peek(), null);
  assert.equal(q.next(true), null);
  assert.equal(q.stopAfterCurrent, false);
});

test('queue: shuffle keeps the chosen song first and every song once; off restores the order', () => {
  const q = queue([5, 1, 7, 2, 0, 3, 1, 4, 2]);
  q.setOrder('shuffleTracks');
  q.start(all, 't3');
  assert.equal(q.context[0], 't3');
  assert.deepEqual([...q.context].sort(), [...all].sort());
  assert.notDeepEqual(q.context, all);
  q.setOrder('default');
  assert.deepEqual(q.context, all);
  assert.equal(q.current, 't3');
  assert.equal(q.pointer, 3);
});

test('queue: move, remove, clear and jump', () => {
  const q = queue();
  q.start(all, 't0');
  q.add(['t7']);
  const keys = q.entries.map(e => e.key); // q1, c1:t1, c2:t2 …
  q.move([keys[1], keys[0], ...keys.slice(2)], [keys[1]], true); // t1 dragged above t7, into the hand-queued part
  assert.deepEqual(q.entries.slice(0, 3).map(e => e.trackId), ['t1', 't7', 't2']);
  assert.equal(q.entries[0].manual, true);
  q.remove([q.entries[2].key]);
  assert.ok(!q.entries.some(e => e.trackId === 't2'));
  assert.equal(q.jump(q.entries.find(e => e.trackId === 't4').key), 't4');
  q.clear(false);
  assert.ok(q.entries.every(e => e.manual));
  q.clear(true);
  assert.deepEqual(q.entries, []);
});

test('queue: peek agrees with the end of the song when songs are queued by hand', () => {
  for (const [order, stopAfter] of [['repeatOne', false], ['default', true]]) {
    const q = queue();
    q.start(all, 't0'); q.setOrder(order); q.stopAfterCurrent = stopAfter;
    q.add(['t7']);
    assert.equal(q.peek(), null);
    assert.equal(q.next(true), order === 'repeatOne' ? 't0' : null);
    assert.equal(q.entries.filter(e => e.manual).length, 1);
  }
  const q = queue();
  q.start(all, 't0'); q.add(['t7']);
  assert.equal(q.peek(), q.next(true));
});

test('queue: shuffle off goes back to the context\'s own order (a search)', () => {
  const q = queue([3, 0, 2, 1]);
  const results = ['t9', 't2', 't5', 't1'];
  q.start(results, 't9');
  q.setOrder('shuffleTracks');
  q.setOrder('default');
  assert.deepEqual(q.context, results);
  assert.equal(q.peek(), 't2');
});

test('queue: a stale entry key removes nothing; previous after a hand-queued song; unknown songs left out', () => {
  const q = queue();
  q.start(all, 't0');
  const stale = q.entries[0].key; // c1:t1
  q.next(); q.next();
  q.remove([stale]);
  assert.deepEqual(q.entries.slice(0, 2).map(e => e.trackId), ['t3', 't4']);
  q.remove(['c5:t9']);
  assert.ok(q.entries.some(e => e.trackId === 't5'));

  const p = queue();
  p.start(all, 't3'); p.add(['t8'], true);
  assert.equal(p.next(), 't8');
  assert.equal(p.currentKey, 'q1');
  assert.equal(p.previous(), 't3');
  assert.equal(p.previous(), 't2');

  const u = queue();
  assert.equal(u.start(['nope'], null), null);
  assert.equal(u.start(['nope', 't1'], null), 't1');
});

test('window: a context of more than 10 000 songs keeps the start song', () => {
  const ids = Array.from({ length: 25_000 }, (_, i) => `s${i}`);
  assert.equal(window(ids, 's20000').length, 10_000);
  assert.ok(window(ids, 's20000').includes('s20000'));
  assert.equal(window(ids, 's20000')[0], 's15000'); // the last 10 000
  assert.equal(window(ids, 's500')[0], 's400');     // from 100 before it
  assert.equal(window(ids, null)[0], 's0');
});

// ---------------------------------------------------------------- the session
function world({ grace = 10_000, maxDevices = 32 } = {}) {
  let t = 1_000;
  const s = new ConnectSession({ now: () => t, random: sequenceRandom([]), has: id => all.includes(id), graceMs: grace, maxDevices,
    lookup: id => ({ title: `Song ${id}`, artist: 'A', album: 'X', albumId: 'al', coverArt: 'al', durationMs: 200_000 }) });
  const sent = [];
  const hello = (deviceId, extra = {}) => { const r = s.hello({ type: 'hello', deviceId, name: deviceId, kind: 'desktop', canPlay: true, client: 'test', ...extra }); sent.push(...r.out); return r; };
  const send = (id, msg) => { const out = s.message(id, msg); sent.push(...out); return out; };
  const cmd = (id, action, fields = {}) => send(id, { type: 'command', ref: 'r', action, ...fields });
  const report = (id, event, fields = {}) => send(id, { type: 'report', event, key: s.current?.key, rev: s.rev, ...fields });
  const replies = (out, type) => out.filter(o => o.msg?.type === type).map(o => o.msg);
  return { s, hello, send, cmd, report, replies, sent, at: ms => { t = ms; }, later: ms => { t += ms; }, get t() { return t; } };
}
const A = 'device-A1', B = 'device-B2', C = 'device-C3';

test('session: a device is welcomed with the session; a bad hello is refused', () => {
  const w = world();
  const r = w.hello(A);
  assert.equal(r.id, A);
  const welcome = r.out.find(o => o.msg?.type === 'welcome').msg;
  assert.equal(welcome.version, 2);
  assert.equal(welcome.session.current, null);
  assert.deepEqual(welcome.devices.map(d => d.id), [A]);
  assert.equal(w.s.hello({ type: 'hello', deviceId: 'short' }).id, null);
});

test('session: playing a context makes the sender active; a remote\'s command changes the session, not the active device', () => {
  const w = world();
  w.hello(A); w.hello(B);
  w.cmd(A, 'playContext', { context: { kind: 'album', id: 'al', label: 'X' }, ids: all, startId: 't2' });
  assert.equal(w.s.activeDevice, A);
  assert.deepEqual(w.s.current, { key: 'c2:t2', trackId: 't2', manual: false });
  assert.equal(w.s.playing, true);
  assert.deepEqual(w.s.lastDevice, { id: A, name: A });
  assert.equal(w.s.session().now.title, 'Song t2');
  const out = w.cmd(B, 'next');
  assert.deepEqual(w.replies(out, 'ack'), [{ type: 'ack', ref: 'r', rev: w.s.rev }]);
  assert.equal(w.s.activeDevice, A);
  assert.equal(w.s.current.trackId, 't3');
  // every device gets the queue, then the session
  const types = out.filter(o => o.to === A).map(o => o.msg.type);
  assert.deepEqual(types, ['queue', 'session']);
});

test('session: with no active device, a remote\'s next moves the session paused; one that cannot play cannot start it', () => {
  const w = world();
  w.hello(A); w.hello(C, { canPlay: false });
  w.cmd(A, 'playContext', { ids: all, startId: 't0' });
  w.cmd(A, 'pause');
  w.s.drop(A); w.later(11_000); w.s.tick();
  assert.equal(w.s.activeDevice, null);
  w.cmd(C, 'next');
  assert.equal(w.s.current.trackId, 't1');
  assert.equal(w.s.playing, false);
  const out = w.cmd(C, 'play');
  assert.equal(w.replies(out, 'error')[0].code, 'cannotPlay');
  assert.equal(w.s.activeDevice, null);
});

test('session: an empty session answers nothing; a refused command changes nothing', () => {
  const w = world();
  w.hello(A);
  for (const action of ['play', 'pause', 'next', 'previous', 'seek']) assert.equal(w.replies(w.cmd(A, action, { positionMs: 1 }), 'error')[0].code, 'nothing');
  const rev = w.s.rev;
  assert.equal(w.replies(w.cmd(A, 'playContext', { ids: ['nope'] }), 'error')[0].code, 'invalid');
  assert.equal(w.s.activeDevice, null); // the sender was not made active for nothing
  assert.equal(w.s.rev, rev);
});

test('session: a transfer moves the active device at the current position; play here', () => {
  const w = world();
  w.hello(A); w.hello(B);
  w.cmd(A, 'playContext', { ids: all, startId: 't0' });
  w.later(5_000);
  w.cmd(B, 'transfer', { to: B });
  assert.equal(w.s.activeDevice, B);
  assert.equal(w.s.positionMs, 5_000);
  assert.equal(w.s.playing, true);
  w.cmd(A, 'transfer', { to: A, play: false });
  assert.equal(w.s.activeDevice, A);
  assert.equal(w.s.playing, false);
  assert.equal(w.replies(w.cmd(A, 'transfer', { to: 'device-gone' }), 'error')[0].code, 'offline');
});

test('session: reports come from the active device, about the current song, and not from before a command', () => {
  const w = world();
  w.hello(A); w.hello(B);
  w.cmd(A, 'playContext', { ids: all, startId: 't0' });
  assert.equal(w.replies(w.report(B, 'position', { positionMs: 1 }), 'error')[0].code, 'notActive');
  assert.equal(w.replies(w.send(A, { type: 'report', event: 'ended', key: 'c9:t9', positionMs: 0, rev: w.s.rev }), 'error')[0].code, 'stale');
  w.report(A, 'loaded', { durationMs: 123_000, now: { title: 'Real title' } });
  assert.equal(w.s.durationMs, 123_000);
  assert.equal(w.s.now.title, 'Real title');
  const before = w.s.rev;
  w.cmd(B, 'seek', { positionMs: 60_000 });
  // the device's position from before it followed the seek: out of date
  assert.equal(w.replies(w.send(A, { type: 'report', event: 'position', key: w.s.current.key, positionMs: 2_000, rev: before }), 'error')[0].code, 'stale');
  assert.equal(w.s.positionMs, 60_000);
  w.report(A, 'position', { positionMs: 60_100 });
  assert.equal(w.s.positionMs, 60_100);
  w.report(A, 'ended');
  assert.equal(w.s.current.trackId, 't1');
  assert.equal(w.s.positionMs, 0);
  const failed = w.replies(w.report(A, 'failed'), 'error')[0];
  assert.deepEqual([failed.code, failed.message, failed.trackId, failed.stopped], ['unplayable', '无法播放“Song t1”，已跳到下一首。', 't1', false]);
  assert.equal(w.s.current.trackId, 't2'); // skipped, as Spotify does
  assert.equal(w.s.playing, true);
});

test('session: repeat one keeps the entry at the end of the song; stop after current stops at its start', () => {
  const w = world();
  w.hello(A);
  w.cmd(A, 'playContext', { ids: all, startId: 't4' });
  w.cmd(A, 'mode', { mode: 'repeatOne' });
  w.later(200_000);
  w.report(A, 'ended');
  assert.deepEqual([w.s.current.key, w.s.positionMs, w.s.playing], ['c4:t4', 0, true]);
  w.cmd(A, 'mode', { mode: 'default' });
  w.cmd(A, 'stopAfterCurrent', { on: true });
  w.report(A, 'ended');
  assert.deepEqual([w.s.current.key, w.s.positionMs, w.s.playing, w.s.queue.stopAfterCurrent], ['c4:t4', 0, false, false]);
});

test('session: the grace period, and resume', () => {
  const w = world();
  w.hello(A); w.hello(B);
  w.cmd(A, 'playContext', { ids: all, startId: 't0' });
  w.later(3_000);
  w.s.drop(A);
  assert.deepEqual(w.s.deviceList().map(d => d.id), [A, B]); // still listed, still active
  w.later(5_000); w.s.tick();
  assert.equal(w.s.activeDevice, A);
  w.hello(A); // back in time
  assert.equal(w.s.activeDevice, A);
  w.s.drop(A);
  w.later(10_000); w.s.tick();
  assert.equal(w.s.activeDevice, null);
  assert.equal(w.s.playing, false);
  assert.equal(w.s.positionMs, 8_000); // where it was when the connection dropped
  assert.deepEqual(w.s.deviceList().map(d => d.id), [B]);
  // it never stopped playing: a resume with the rev it last saw makes it active again
  const seen = w.s.graceStop.revBefore;
  w.later(1_000);
  w.hello(A, { resume: { rev: seen, playing: true, positionMs: 19_000 } });
  assert.equal(w.s.activeDevice, A);
  assert.equal(w.s.positionMs, 19_000);
  // after a change made meanwhile, the resume is refused
  w.s.drop(A); w.later(10_000); w.s.tick();
  const seen2 = w.s.graceStop.revBefore;
  w.cmd(B, 'next');
  w.hello(A, { resume: { rev: seen2, playing: true, positionMs: 1 } });
  assert.equal(w.s.activeDevice, null);
});

test('session: a device that leaves with a goodbye has no grace period', () => {
  const w = world();
  w.hello(A); w.hello(B);
  w.cmd(A, 'playContext', { ids: all, startId: 't0' });
  w.later(4_000);
  w.s.leave(A);
  assert.equal(w.s.activeDevice, null);
  assert.equal(w.s.playing, false);
  assert.equal(w.s.positionMs, 4_000);
  assert.deepEqual(w.s.deviceList().map(d => d.id), [B]);
  w.cmd(B, 'playContext', { ids: all, startId: 't3' }); // plays on B, not on a device that left
  assert.equal(w.s.activeDevice, B);
});

test('session: volume goes to the device it names, as a deviceCommand', () => {
  const w = world();
  w.hello(A); w.hello(B);
  const out = w.cmd(B, 'volume', { device: A, volume: 0.25 });
  assert.deepEqual(out.find(o => o.to === A).msg, { type: 'deviceCommand', action: 'volume', volume: 0.25, from: B });
  assert.equal(w.replies(w.cmd(B, 'volume', { device: 'device-gone', volume: 1 }), 'error')[0].code, 'offline');
  w.send(A, { type: 'device', volume: 0.25, muted: false });
  assert.equal(w.s.deviceList().find(d => d.id === A).volume, 0.25);
  w.hello(C, { volume: 0.4, muted: true }); // said in the hello: listed so from the start
  assert.deepEqual([w.s.deviceList().find(d => d.id === C).volume, w.s.deviceList().find(d => d.id === C).muted], [0.4, true]);
});

test('session: a stale remove still removes the rest; a stale move moves nothing; a stale rev', () => {
  const w = world();
  w.hello(A);
  w.cmd(A, 'playContext', { ids: all, startId: 't0' });
  const keys = w.s.queue.entries.map(e => e.key);
  const out = w.cmd(A, 'remove', { entries: ['c1:t1', 'c9:t2'] });
  assert.deepEqual(w.replies(out, 'error')[0].entries, ['c9:t2']);
  assert.ok(!w.s.queue.entries.some(e => e.trackId === 't1'));
  const before = JSON.stringify(w.s.queueView());
  assert.equal(w.replies(w.cmd(A, 'move', { order: keys, keys: [keys[2]], manual: true }), 'error')[0].code, 'stale');
  assert.equal(JSON.stringify(w.s.queueView()), before);
  assert.equal(w.replies(w.cmd(A, 'pause', { rev: w.s.rev - 1 }), 'error')[0].code, 'stale');
});

test('session: previous more than 3 s into a song goes back to its start', () => {
  const w = world();
  w.hello(A);
  w.cmd(A, 'playContext', { ids: all, startId: 't5' });
  w.later(4_000);
  w.cmd(A, 'previous');
  assert.deepEqual([w.s.current.trackId, w.s.positionMs], ['t5', 0]);
  w.cmd(A, 'previous');
  assert.equal(w.s.current.trackId, 't4');
});

test('session: kept across a restart with no active device, paused where it was', () => {
  const w = world();
  w.hello(A);
  w.cmd(A, 'playContext', { context: { kind: 'album', id: 'al', label: 'X' }, ids: all, startId: 't1' });
  w.cmd(A, 'add', { ids: ['t9'] });
  w.later(7_000);
  const saved = JSON.parse(JSON.stringify(w.s.save()));
  const s = new ConnectSession({ now: () => 99_000, saved });
  assert.equal(s.activeDevice, null);
  assert.equal(s.playing, false);
  assert.equal(s.positionMs, 7_000);
  assert.deepEqual(s.lastDevice, { id: A, name: A });
  assert.deepEqual(s.queueView(), w.s.queueView());
  assert.equal(s.session().context.label, 'X');
});

test('session: at most 32 devices, the one silent longest goes', () => {
  const w = world({ maxDevices: 3 });
  w.hello('device-1x'); w.later(1); w.hello('device-2x'); w.later(1); w.hello('device-3x');
  w.later(1); w.send('device-1x', { type: 'device', volume: 0.5 });
  const r = w.hello('device-4x');
  assert.deepEqual(r.out.filter(o => o.close).map(o => o.close), ['device-2x']);
  assert.deepEqual(w.s.online().sort(), ['device-1x', 'device-3x', 'device-4x']);
});

// ---------------------------------------------------------------- the vectors
test('vectors: the session module gives what docs/protocol/connect-vectors.json says, step by step', () => {
  const file = JSON.parse(readFileSync(VECTORS, 'utf8'));
  assert.ok(file.cases.length >= 10);
  for (const c of file.cases) {
    const got = replay(c, file.library);
    got.forEach((step, i) => assert.deepEqual(step, c.steps[i].expect, `${c.name}, step ${i + 1}`));
  }
});
