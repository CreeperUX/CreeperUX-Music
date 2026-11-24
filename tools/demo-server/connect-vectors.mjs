// The test vectors of Sonus Connect version 2 (docs/protocol/connect-vectors.json): sequences of messages, with the
// session, the queue, the devices and the direct replies expected after each step, made by running them through the
// reference session logic (connect-session.mjs). Any server implementing the protocol (the Rust server) replays the
// same file; the Windows app's tests replay its queue steps on src/Sonus.Core/PlayQueue.cs.
// Usage: node tools/demo-server/connect-vectors.mjs           writes the file
//        node tools/demo-server/connect-vectors.mjs --check   fails when the file is not what the module gives now
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConnectSession, sequenceRandom } from './connect-session.mjs';

export const VECTORS = resolve(dirname(fileURLToPath(import.meta.url)), '../../docs/protocol/connect-vectors.json');

const ABOUT = {
  what: 'Test vectors of Sonus Connect version 2 (connect.md): each case is a sequence of steps; after each step the server\'s session, queue, device list and direct replies must be exactly `expect`.',
  steps: {
    send: '{ at, from, send }: the message `send` arrives from device `from`\'s connection at server time `at` (ms). A `hello` opens that device\'s connection.',
    drop: '{ at, drop }: that device\'s connection goes away (no goodbye).',
    tick: '{ at, tick: true }: only time passes (the grace period may run out). Servers check the grace period at least this often.',
  },
  expect: {
    session: 'the session object (connect.md, Session), exactly',
    queue: 'the queue object (connect.md, Queue), exactly',
    devices: 'the ids of the devices listed in `devices` messages, in order (the connected ones, and the active one during its grace period)',
    replies: 'every message sent that is not a broadcast of `welcome`, `session`, `queue` or `devices`, in order: { to, msg } (ack, error, deviceCommand), { close, code } (a connection closed by the server), { reply } (the answer to a refused hello)',
  },
  random: 'Where the server draws a random number (shuffling, the random order, a random first song) it takes the next number of the case\'s `random` list modulo n (0 once the list is used up). Shuffling is Fisher–Yates from the end: for i from n−1 down to 1, j = draw(i + 1), swap i and j.',
  library: 'The songs the server knows (has), with what it shows of them before the active device reports `loaded`. Ids not listed are not in the library.',
  graceMs: 10000,
};

const LIBRARY = Object.fromEntries(Array.from({ length: 10 }, (_, i) => {
  const album = i < 4 ? 0 : i < 8 ? 1 : 2;
  return [`t${i}`, { title: `Song ${i}`, artist: ['Orbit', 'Nightline', 'Cedar'][album], album: ['Orbit', 'Night Train', 'Cedar'][album], albumId: `al${album}`, coverArt: `al${album}`, durationMs: 180_000 + i * 1_000 }];
}));

const PC = 'pc-study-01', PHONE = 'phone-0001', REMOTE = 'remote-only-1';
const hello = (deviceId, name, extra = {}) => ({ type: 'hello', deviceId, name, kind: deviceId.startsWith('phone') ? 'phone' : 'desktop', canPlay: deviceId !== REMOTE, client: 'vectors', ...extra });
const cmd = (action, fields = {}, ref = action) => ({ type: 'command', ref, action, ...fields });
// a report about the current song, with the rev the device has seen (the current one)
const report = (event, fields = {}) => s => ({ type: 'report', ref: event, event, key: s.current?.key ?? null, positionMs: 0, rev: s.rev, ...fields });
const all = Object.keys(LIBRARY);
const album = { kind: 'album', id: 'al0', label: 'Orbit' };

/** The cases: steps as data, or functions of the live session (resolved when the file is made). */
const CASES = [
  { name: 'play an album on one device; a second device skips, goes back, seeks and pauses', random: [], steps: [
    [0, PC, hello(PC, '书房电脑')],
    [10, PHONE, hello(PHONE, '手机')],
    [1000, PC, cmd('playContext', { context: album, ids: all.slice(0, 8), startId: 't2' })],
    [1200, PC, report('loaded', { durationMs: 182_500, now: { title: 'Song 2 (from the file)', artist: 'Orbit', album: 'Orbit', albumId: 'al0', coverArt: 'al0' } })],
    [1250, PC, report('playing', { positionMs: 0 })],
    [31_250, PC, report('position', { positionMs: 30_010 })],
    [32_000, PHONE, cmd('next')],
    [33_000, PHONE, cmd('previous')],
    [40_000, PHONE, cmd('previous')],
    [41_000, PHONE, cmd('seek', { positionMs: 90_000 })],
    [42_000, PHONE, cmd('pause')],
    [50_000, PHONE, cmd('toggle')],
  ] },
  { name: 'songs queued by hand play first, then the context goes on where it was', random: [], steps: [
    [0, PC, hello(PC, '书房电脑')],
    [1000, PC, cmd('playContext', { context: album, ids: all, startId: 't0' })],
    [2000, PC, cmd('add', { ids: ['t5', 't6'], next: false })],
    [3000, PC, cmd('add', { ids: ['t9', 'not-in-library'], next: true })],
    [4000, PC, cmd('next')],
    [5000, PC, cmd('next')],
    [6000, PC, cmd('previous')],
    [7000, PC, cmd('next')],
    [8000, PC, cmd('next')],
  ] },
  { name: 'queue edits by entry key: move, remove (one key stale), jump, clear, and stale keys', random: [], steps: [
    [0, PC, hello(PC, '书房电脑')],
    [1000, PC, cmd('playContext', { context: album, ids: all.slice(0, 8), startId: 't0' })],
    [2000, PC, cmd('add', { ids: ['t9'] })],
    // t1 dragged above the hand-queued t9, into the hand-queued part
    [3000, PC, s => { const k = s.queue.entries.map(e => e.key); return cmd('move', { order: [k[1], k[0], ...k.slice(2)], keys: [k[1]], manual: true }); }],
    [4000, PC, s => cmd('remove', { entries: [s.queue.entries.find(e => e.trackId === 't3').key, 'c1:t1'] })],
    [5000, PC, s => cmd('jump', { entry: s.queue.entries.find(e => e.trackId === 't5').key })],
    [6000, PC, cmd('jump', { entry: 'c2:t2' })],
    [7000, PC, s => { const k = s.queue.entries.map(e => e.key); return cmd('move', { order: k.slice(1), keys: [k[1]], manual: false }); }],
    [8000, PC, s => cmd('jump', { entry: s.queue.entries.find(e => e.manual).key })],
    [9000, PC, cmd('add', { ids: ['t8', 't9'] })],
    [10_000, PC, cmd('clear', { manual: false })],
    [11_000, PC, cmd('clear', { manual: true })],
    [12_000, PC, cmd('next')],
  ] },
  { name: 'playback orders: shuffle and back, repeat all wraps, repeat one, random', random: [7, 3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5, 8, 9, 7], steps: [
    [0, PC, hello(PC, '书房电脑')],
    [1000, PC, cmd('playContext', { context: album, ids: all, startId: 't3' })],
    [2000, PC, cmd('mode', { mode: 'shuffleTracks' })],
    [3000, PC, cmd('next')],
    [4000, PC, cmd('mode', { mode: 'default' })],
    [5000, PC, cmd('mode', { mode: 'repeatAll' })],
    [6000, PC, s => (s.queue.entries.length ? cmd('jump', { entry: s.queue.entries.at(-1).key }) : cmd('seek', { positionMs: 0 }))], // to the last song
    [7000, PC, cmd('next')],
    [8000, PC, cmd('mode', { mode: 'repeatOne' })],
    [190_000, PC, report('ended')],
    [191_000, PC, cmd('next')],
    [192_000, PC, cmd('mode', { mode: 'random' })],
    [193_000, PC, cmd('next')],
    [380_000, PC, report('ended')],
    [381_000, PC, cmd('playContext', { context: { kind: 'playlist', id: 'pl1', label: 'Mix' }, ids: ['t9', 't1', 't5'], shuffle: true })],
    [382_000, PC, cmd('mode', { mode: 'sideways' })],
  ] },
  { name: 'stop after current: the song plays to its end, the session stops at its start', random: [], steps: [
    [0, PC, hello(PC, '书房电脑')],
    [1000, PC, cmd('playContext', { context: album, ids: all.slice(0, 4), startId: 't1' })],
    [2000, PC, cmd('stopAfterCurrent', { on: true })],
    [183_000, PC, report('ended')],
    [190_000, PC, cmd('play')],
    [372_000, PC, report('ended')],
    [400_000, PC, cmd('jump', { entry: 'c3:t3' })],
    [584_000, PC, report('ended')],
  ] },
  { name: 'shuffling by album or folder: the sender arranges the context', random: [], steps: [
    [0, PC, hello(PC, '书房电脑')],
    [1000, PC, cmd('mode', { mode: 'shuffleAlbums' })],
    [2000, PC, cmd('playContext', { context: album, ids: all })],
    [3000, PC, cmd('playContext', { context: album, ids: all, startId: 't5', order: ['t4', 't5', 't6', 't7', 't8', 't9', 't0', 't1', 't2', 't3'] })],
    [4000, PC, cmd('mode', { mode: 'default' })],
    [5000, PC, cmd('mode', { mode: 'shuffleFolders' })],
    [6000, PC, cmd('mode', { mode: 'shuffleFolders', order: ['t8', 't9', 't5', 't6', 't7', 't4', 't0', 't1', 't2', 't3'] })],
    [7000, PC, cmd('next')],
    [8000, PC, cmd('playContext', { context: album, ids: all, shuffle: true, order: ['t0', 't1', 't2', 't3', 't8', 't9', 't4', 't5', 't6', 't7'] })],
  ] },
  { name: 'a transfer moves playback; the device it leaves is a remote; play here', random: [], steps: [
    [0, PC, hello(PC, '书房电脑')],
    [10, PHONE, hello(PHONE, '手机')],
    [20, REMOTE, hello(REMOTE, '遥控器')],
    [1000, PC, cmd('playContext', { context: album, ids: all.slice(0, 4), startId: 't0' })],
    [5000, PHONE, cmd('transfer', { to: PHONE })],
    [5100, PC, report('paused', { positionMs: 4000 })],
    [5300, PHONE, report('loaded', { durationMs: 180_000 })],
    [5400, PHONE, report('playing', { positionMs: 4000 })],
    [6000, REMOTE, cmd('transfer', { to: REMOTE })],
    [6100, REMOTE, cmd('transfer', { to: 'nobody-here' })],
    [9000, PHONE, cmd('transfer', { to: PC, play: false })],
    [9500, REMOTE, cmd('play')],
  ] },
  { name: 'reports: only the active device, only about the current song, not from before a command; failed songs are skipped', random: [], steps: [
    [0, PC, hello(PC, '书房电脑')],
    [10, PHONE, hello(PHONE, '手机')],
    [1000, PC, cmd('playContext', { context: album, ids: all.slice(0, 8), startId: 't0' })],
    [1500, PHONE, report('position', { positionMs: 500 })],
    [2000, PC, report('playing', { positionMs: 0 })],
    [3000, PHONE, cmd('seek', { positionMs: 120_000 })],
    [3010, PC, s => ({ type: 'report', ref: 'late', event: 'position', key: s.current.key, positionMs: 2010, rev: s.rev - 1 })],
    [3300, PC, report('position', { positionMs: 120_250 })],
    [3400, PC, { type: 'report', ref: 'old-song', event: 'ended', key: 'c7:t7', positionMs: 0, rev: 0 }],
    [62_000, PC, report('ended')],
    [63_000, PC, report('failed')],
    [64_000, PC, report('failed')],
    [65_000, PC, report('failed')],
    [66_000, PC, report('failed')],
    [67_000, PC, report('playing', { positionMs: 0 })],
    [68_000, PC, report('failed')],
    [69_000, PC, report('sideways')],
  ] },
  { name: 'five failed songs in a row stop the session', random: [], steps: [
    [0, PC, hello(PC, '书房电脑')],
    [1000, PC, cmd('playContext', { context: album, ids: all, startId: 't0' })],
    [2000, PC, report('failed')],
    [3000, PC, report('failed')],
    [4000, PC, report('failed')],
    [5000, PC, report('failed')],
    [6000, PC, report('failed')],
  ] },
  { name: 'the grace period: back in time; run out; resume after a short network loss; resume refused after a change', random: [], steps: [
    [0, PC, hello(PC, '书房电脑')],
    [10, PHONE, hello(PHONE, '手机')],
    [1000, PC, cmd('playContext', { context: album, ids: all.slice(0, 8), startId: 't0' })],
    [4000, PC, { drop: PC }],
    [9000, PHONE, { tick: true }],
    [10_000, PC, hello(PC, '书房电脑')],
    [12_000, PC, report('position', { positionMs: 11_000 })],
    [20_000, PC, { drop: PC }],
    [30_000, PHONE, { tick: true }],
    // it kept playing through the network loss: the rev it last saw is the one before the grace period stopped the session
    [31_000, PC, s => hello(PC, '书房电脑', { resume: { rev: s.rev - 1, playing: true, positionMs: 30_000 } })],
    [32_000, PC, report('position', { positionMs: 31_000 })],
    [40_000, PC, { drop: PC }],
    [50_000, PHONE, { tick: true }],
    [50_500, PHONE, cmd('seek', { positionMs: 100 })],
    // the session changed meanwhile: it stops, and shows the session as it now is
    [52_000, PC, s => hello(PC, '书房电脑', { resume: { rev: s.rev - 2, playing: true, positionMs: 41_000 } })],
    [53_000, PC, report('position', { positionMs: 42_000 })],
  ] },
  { name: 'with no active device: a remote moves the session paused; one that cannot play cannot start it; the next to press play plays', random: [], steps: [
    [0, PC, hello(PC, '书房电脑')],
    [10, PHONE, hello(PHONE, '手机')],
    [20, REMOTE, hello(REMOTE, '遥控器')],
    [1000, PC, cmd('playContext', { context: album, ids: all.slice(0, 4), startId: 't0' })],
    [61_000, PC, cmd('pause')],
    [62_000, PC, { drop: PC }],
    [72_000, PHONE, { tick: true }],
    [73_000, REMOTE, cmd('next')],
    [74_000, REMOTE, cmd('play')],
    [75_000, REMOTE, cmd('playContext', { context: album, ids: ['t2'] })],
    [76_000, PHONE, cmd('previous')],
    [77_000, PHONE, cmd('play')],
  ] },
  { name: 'volume: any device sets any device\'s volume, as a deviceCommand to it', random: [], steps: [
    [0, PC, hello(PC, '书房电脑')],
    [10, PHONE, hello(PHONE, '手机')],
    [1000, PHONE, cmd('volume', { device: PC, volume: 0.3 })],
    [1100, PC, { type: 'device', ref: 'v', volume: 0.3, muted: false }],
    [2000, PC, cmd('volume', { device: PHONE, muted: true })],
    [3000, PHONE, cmd('volume', { device: 'nobody-here', volume: 1 })],
    [4000, PHONE, cmd('volume', { device: PC })],
  ] },
  { name: 'an empty session, and requests that are refused', random: [], steps: [
    [0, PC, { type: 'hello', deviceId: 'bad id' }],
    [10, PC, hello(PC, '书房电脑')],
    [1000, PC, cmd('play')],
    [1100, PC, cmd('next')],
    [1200, PC, cmd('playContext', { ids: ['not-in-library'] })],
    [1300, PC, cmd('add', { ids: ['t4', 't5'] })],
    [1400, PC, cmd('play')],
    [1500, PC, cmd('pause', { rev: 0 })],
    [1600, PC, cmd('dance')],
    [1700, PC, { type: 'shout', ref: 'x' }],
    [1800, PC, cmd('playContext', { context: album, ids: all, startId: 't6', positionMs: 30_000 })],
  ] },
];

/** Replays a case's steps (concrete ones, as in the file); returns what each step gives. */
export function replay(c, library = LIBRARY, resolveStep = null) {
  let t = 0;
  const s = new ConnectSession({ now: () => t, random: sequenceRandom(c.random ?? []), has: id => id in library, lookup: id => library[id] ?? null, graceMs: ABOUT.graceMs });
  return c.steps.map((raw, i) => {
    const step = resolveStep ? resolveStep(raw, s, i) : raw;
    t = step.at;
    let out;
    if (step.drop) out = s.drop(step.drop);
    else if (step.tick) out = s.tick();
    else if (step.send?.type === 'hello') out = s.hello(step.send).out;
    else out = s.message(step.from, step.send);
    const replies = out.filter(o => o.close || o.reply || !['welcome', 'session', 'queue', 'devices'].includes(o.msg?.type))
      .map(o => (o.close ? { close: o.close, code: o.code } : o.reply ? { reply: o.reply } : { to: o.to, msg: o.msg }));
    return { session: s.session(), queue: s.queueView(), devices: s.deviceList().map(d => d.id), replies };
  });
}

/** Makes the file's cases: each step resolved against the live session, with what it gives. */
function make() {
  return CASES.map(c => {
    const steps = [];
    const results = replay({ ...c, steps: c.steps }, LIBRARY, ([at, from, x], s) => {
      const v = typeof x === 'function' ? x(s) : x;
      const step = v.drop ? { at, drop: v.drop } : v.tick ? { at, tick: true } : { at, from, send: v };
      steps.push(step);
      return step;
    });
    return { name: c.name, random: c.random, steps: steps.map((s, i) => ({ ...s, expect: results[i] })) };
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = { about: ABOUT, library: LIBRARY, cases: make() };
  const text = JSON.stringify(file, null, 1) + '\n';
  if (process.argv.includes('--check')) {
    const now = readFileSync(VECTORS, 'utf8');
    if (now !== text) { console.error('docs/protocol/connect-vectors.json is not what connect-session.mjs gives: run node tools/demo-server/connect-vectors.mjs'); process.exit(1); }
    console.log(`connect-vectors.json: ${file.cases.length} cases, ${file.cases.reduce((n, c) => n + c.steps.length, 0)} steps, as the module gives`);
  } else {
    writeFileSync(VECTORS, text);
    console.log(`wrote ${VECTORS}: ${file.cases.length} cases, ${file.cases.reduce((n, c) => n + c.steps.length, 0)} steps`);
  }
}
