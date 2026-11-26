// Sonus Connect version 2 (docs/protocol/connect.md) over a server's real WebSocket, rest/connect?protocol=2: one
// playback session per user. What a client sees of it: the extension's versions, hello and welcome, a session any
// device steers and only a transfer moves, the song filled in from the library, the sign-in, a second connection of
// the same device (4000), a goodbye against a network loss with its grace period and resume, and each user's own
// session. The session's logic step by step is the shared vectors' to pin down (docs/protocol/connect-vectors.json);
// the 30 s ping, the 75 s timeout and the 32-device limit are checked in the Rust server's own tests.
//
// Skipped for a server that does not list sonusConnect version 2 (the frozen Navidrome alone). The session is kept by
// the server, so every test starts its own context and leaves with a goodbye.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, as, extensionVersions, getLibrary, manifest, BASE, CLIENT } from '../lib/context.mjs';
import { connectUrl, device, socket } from '../lib/connect.mjs';

const skip = async () => ((await extensionVersions('sonusConnect')).includes(2) ? false : 'the server does not speak Sonus Connect version 2');
const query = (client = api) => client.query().toString();
let run = 0;
/** A device id of this test's own. */
const idOf = name => `contract-${process.pid}-${++run}-${name}`.slice(0, 64);
const me = (name, hello) => device(BASE, query(), idOf(name), name, hello);
const sleep = ms => new Promise(done => setTimeout(done, ms));

/** Four songs of one album, as the library lists them. */
async function album() {
  const { songs } = await getLibrary();
  const byAlbum = Map.groupBy(songs.filter(s => s.albumId), s => s.albumId);
  const picked = [...byAlbum.values()].find(list => list.length >= 4) ?? songs;
  return picked.slice(0, 4);
}
const context = songs => ({ context: { kind: 'album', id: songs[0].albumId ?? null, label: songs[0].album ?? null }, ids: songs.map(s => s.id) });

/** Another user of the manifest who can sign in to the Subsonic API (an app password where two-step verification asks for one). */
function otherUser() {
  const key = Object.keys(manifest.users).find(k => k !== manifest.primaryUser && (manifest.users[k].appPassword || manifest.users[k].password));
  if (!key) return null;
  const u = manifest.users[key];
  return as(key, { password: u.appPassword ?? u.password, client: CLIENT });
}

test('Connect 2: sonusConnect lists versions 1 and 2', { skip: await skip() }, async () => {
  assert.deepEqual(await extensionVersions('sonusConnect'), [1, 2]);
});

test('Connect 2: hello is answered with everything a device shows; playing a context fills in the song', { skip: await skip() }, async () => {
  const songs = await album();
  const a = await me('pc');
  try {
    const w = a.welcome;
    assert.equal(w.version, 2);
    assert.equal(w.deviceId, a.id);
    assert.ok(Math.abs(w.serverTime - Date.now()) < 60_000, 'serverTime is now, in ms');
    for (const k of ['rev', 'activeDevice', 'lastDevice', 'current', 'next', 'playing', 'positionMs', 'at', 'durationMs', 'now', 'mode', 'stopAfterCurrent', 'context', 'queueRev'])
      assert.ok(k in w.session, `session.${k}`);
    assert.equal(w.session.activeDevice, null, 'nobody plays: every device of the test before left');
    assert.equal(w.session.playing, false);
    assert.deepEqual(Object.keys(w.queue).sort(), ['manual', 'order', 'pointer', 'queueRev']);
    const listed = w.devices.find(d => d.id === a.id);
    assert.deepEqual({ ...listed, connectedAt: 0 }, { id: a.id, name: 'pc', kind: 'desktop', client: 'sonus-contract', canPlay: true, connectedAt: 0, volume: 1, muted: false });
    assert.ok(Math.abs(listed.connectedAt - w.serverTime) < 5000);

    const s = await a.command('playContext', { ...context(songs), ids: [...songs.map(x => x.id), 'not-in-the-library'], startId: songs[1].id });
    assert.equal(s.rev, w.session.rev + 1, 'one change, one rev');
    assert.equal(s.activeDevice, a.id, 'with no active device, the sender plays');
    assert.deepEqual(s.lastDevice, { id: a.id, name: 'pc' });
    assert.deepEqual(s.current, { key: `c1:${songs[1].id}`, trackId: songs[1].id, manual: false });
    assert.equal(s.next, songs[2].id);
    assert.equal(s.playing, true);
    assert.equal(s.positionMs, 0);
    assert.ok(Math.abs(s.at - Date.now()) < 60_000);
    assert.equal(s.mode, 'default');
    // what the server knows of the song, so any device can show it without a lookup
    assert.equal(s.now.title, songs[1].title);
    assert.equal(s.now.artist, songs[1].artist);
    assert.equal(s.now.album, songs[1].album);
    assert.equal(s.now.albumId, songs[1].albumId);
    assert.ok(Math.abs(s.durationMs / 1000 - songs[1].duration) <= 1, `durationMs ${s.durationMs} for a song of ${songs[1].duration} s`);
    if (s.now.coverArt) {
      const cover = await api.fetch('getCoverArt', { id: s.now.coverArt, size: 64 });
      assert.equal(cover.status, 200);
      assert.match(cover.headers.get('content-type') ?? '', /^image\//, `getCoverArt shows ${s.now.coverArt}`);
      await cover.arrayBuffer();
    }
    // the sender gets the queue too, before the session: without the id the library lacks
    const q = a.inbox.find(m => m.type === 'queue' && m.queue.queueRev === s.queueRev);
    assert.deepEqual(q.queue, { queueRev: s.queueRev, order: songs.map(x => x.id), pointer: 1, manual: [] });

    // the active device's report replaces what the server shows of the song, but not the library's duration (a
    // device's can be out of date: the previous song's, after a gapless change)
    const ack = await a.report('loaded', s, { durationMs: 123_456, now: { title: 'From the file', artist: 'A', album: 'B', albumId: songs[1].albumId, coverArt: 'x' } });
    assert.equal(ack.type, 'ack');
    const loaded = await a.session(x => x.rev === ack.rev);
    assert.equal(loaded.durationMs, s.durationMs, 'the library’s duration stands');
    assert.equal(loaded.now.title, 'From the file');
    // a position the device reports past the library's end is taken as it is (the file can be longer)
    const past = await a.report('position', loaded, { positionMs: s.durationMs + 1_500 });
    const reported = await a.session(x => x.rev === past.rev);
    assert.equal(reported.positionMs, s.durationMs + 1_500);

    // refused messages say why, and change nothing
    const nothing = await a.refused('playContext', { ids: ['not-in-the-library'] });
    assert.equal(nothing.code, 'invalid');
    assert.equal((await a.refused('jump', { entry: 'c99:nope' })).code, 'stale');
    assert.equal((await a.refused('seek', { positionMs: 5, rev: reported.rev - 1 })).code, 'stale', 'a command for an older rev');
    assert.equal((await a.refused('dance')).code, 'invalid');
    const still = await a.command('seek', { positionMs: 1000 });
    assert.equal(still.rev, reported.rev + 1, 'the refused ones changed nothing');
  } finally { await a.close(); }
});

test('Connect 2: any device steers the one session; only a transfer moves it; volume is each device’s own', { skip: await skip() }, async () => {
  const songs = await album();
  const pc = await me('pc'), phone = await me('phone', { kind: 'phone', volume: 0.5 });
  try {
    assert.deepEqual(phone.welcome.devices.map(d => d.id), [pc.id, phone.id]);
    assert.equal(phone.welcome.devices[1].volume, 0.5);
    await pc.next(m => m.type === 'devices' && m.devices.some(d => d.id === phone.id && d.kind === 'phone'), 'the phone in the list');

    const played = await pc.command('playContext', { ...context(songs), startId: songs[0].id });
    assert.deepEqual(await phone.session(x => x.rev === played.rev), played, 'every device gets the same session');
    await phone.next(m => m.type === 'queue' && m.queue.queueRev === played.queueRev, 'the queue');

    // the remote's commands change the session; the active device stays the PC
    // (positions within the song: the fixture library's songs are a few seconds long)
    const half = Math.floor(played.durationMs / 2);
    const sought = await phone.command('seek', { positionMs: half });
    assert.equal(sought.positionMs, half);
    assert.equal(sought.activeDevice, pc.id);
    assert.equal((await pc.session(x => x.rev === sought.rev)).positionMs, half, 'the active device follows');
    assert.equal((await phone.command('seek', { positionMs: played.durationMs + 60_000 })).positionMs, played.durationMs, 'not past the song’s end');
    const next = await phone.command('next');
    assert.equal(next.current.trackId, songs[1].id);
    assert.equal(next.now.title, songs[1].title);
    assert.equal(next.positionMs, 0);
    const added = await phone.command('add', { ids: [songs[3].id], next: false });
    assert.equal(added.next, songs[3].id, 'a song queued by hand plays before the context goes on');
    const q = await pc.next(m => m.type === 'queue' && m.queue.queueRev === added.queueRev, 'the queue with the added song');
    assert.equal(q.queue.manual.length, 1);
    assert.equal(q.queue.manual[0].trackId, songs[3].id);
    const paused = await phone.command('pause');
    assert.equal(paused.playing, false);
    assert.equal(paused.activeDevice, pc.id);

    // a report from a device that is not the active one is not taken
    assert.equal((await phone.report('playing', paused)).code, 'notActive');
    // the active device's is; one about a song that is no longer current is not
    const quarter = Math.floor(next.durationMs / 4);
    assert.equal((await pc.report('position', paused, { positionMs: quarter })).type, 'ack');
    assert.equal((await pc.report('ended', { ...paused, current: { key: 'c0:gone' } })).code, 'stale');

    // "play here": the phone becomes the active device, at the position, and the PC is told
    const moved = await phone.command('transfer', { to: phone.id, play: true });
    assert.equal(moved.activeDevice, phone.id);
    assert.equal(moved.playing, true);
    assert.equal(moved.positionMs, quarter);
    assert.deepEqual(moved.lastDevice, { id: phone.id, name: 'phone' });
    assert.equal((await pc.session(x => x.rev === moved.rev)).activeDevice, phone.id);
    assert.equal((await pc.refused('transfer', { to: 'nobody-here-0001' })).code, 'offline');

    // volume: a command to that device; its own message puts it in the list
    pc.send({ type: 'command', action: 'volume', device: phone.id, volume: 0.25, muted: true });
    assert.deepEqual(await phone.next(m => m.type === 'deviceCommand', 'the volume command'), { type: 'deviceCommand', action: 'volume', volume: 0.25, muted: true, from: pc.id });
    phone.send({ type: 'device', volume: 0.25, muted: true });
    const list = await pc.next(m => m.type === 'devices' && m.devices.some(d => d.id === phone.id && d.volume === 0.25), 'the phone’s volume');
    assert.equal(list.devices.find(d => d.id === phone.id).muted, true);
  } finally { await Promise.all([pc.close(), phone.close()]); }
});

test('Connect 2: hello comes first; a wrong password gets no connection', { skip: await skip() }, async () => {
  const early = socket(connectUrl(BASE, query()), 'no-hello');
  await early.opened;
  early.send({ type: 'command', ref: 'x', action: 'play' });
  const error = await early.next(m => m.type === 'error', 'the error');
  assert.equal(error.code, 'invalid');
  assert.equal(await early.closed, 1008);

  const badId = socket(connectUrl(BASE, query()), 'bad-id');
  await badId.opened;
  badId.send({ type: 'hello', deviceId: 'bad id', name: 'x' });
  assert.equal((await badId.next(m => m.type === 'error', 'the error')).code, 'invalid');
  assert.equal(await badId.closed, 1008);

  const wrong = socket(connectUrl(BASE, api.with({ u: api.auth.u, password: 'wrong' }).query()), 'wrong-password');
  await assert.rejects(wrong.opened);
  const nobody = socket(connectUrl(BASE, 'v=1.16.1&c=x&f=json'), 'no-credentials');
  await assert.rejects(nobody.opened);
});

test('Connect 2: a second connection of the same device replaces the first (4000)', { skip: await skip() }, async () => {
  const songs = await album();
  const id = idOf('twice');
  const first = await device(BASE, query(), id, 'first');
  let second;
  try {
    await first.command('playContext', { ...context(songs), startId: songs[0].id });
    second = await device(BASE, query(), id, 'second');
    assert.equal(await first.closed, 4000);
    assert.equal(second.welcome.session.activeDevice, id, 'the same device: still the active one');
    assert.equal(second.welcome.session.playing, true);
    assert.equal(second.welcome.devices.filter(d => d.id === id).length, 1);
    assert.equal(second.welcome.session.lastDevice.name, 'second');
  } finally { await first.close(); await second?.close(); }
});

test('Connect 2: version 1 is still spoken beside it, and the two do not see each other', { skip: await skip() }, async () => {
  const two = await me('v2');
  const one = socket(connectUrl(BASE, query(), { protocol: '' }), 'v1');
  try {
    await one.opened;
    const w = await one.next(m => m.type === 'welcome', 'version 1’s welcome');
    assert.equal(w.version, 1);
    const list = await one.next(m => m.type === 'devices', 'version 1’s devices');
    assert.ok(!list.devices.some(d => d.id === two.id), 'version 1 does not list version 2’s devices');
    await sleep(300);
    assert.ok(!two.inbox.some(m => m.type === 'devices' && m.devices.some(d => d.id === w.deviceId)), 'nor the other way round');
  } finally { await Promise.all([two.close(), one.close()]); }
});

test('Connect 2: a goodbye stops the session at once; a lost connection has a grace period, and a resume', { skip: await skip(), timeout: 60_000 }, async () => {
  const songs = await album();
  const id = idOf('pc');
  let pc = await device(BASE, query(), id, 'pc');
  const phone = await me('phone');
  try {
    const played = await pc.command('playContext', { ...context(songs), startId: songs[2].id });
    await phone.session(x => x.rev === played.rev);
    // positions within the song (the fixture library's songs are a few seconds long)
    const length = played.durationMs, early = Math.floor(length * 0.3), late = Math.floor(length * 0.6);

    // lost (to the server, any close that is not 1000 or 1001), and back in time: still the active device
    await pc.close(4999);
    await sleep(1500);
    assert.ok(!phone.inbox.some(m => m.type === 'session'), 'within the grace period nothing changes');
    pc = await device(BASE, query(), id, 'pc');
    assert.equal(pc.welcome.session.activeDevice, id);
    assert.equal(pc.welcome.session.playing, true);
    assert.equal(pc.welcome.session.rev, played.rev);
    assert.equal((await pc.report('position', played, { positionMs: early })).type, 'ack');
    const before = await phone.session(x => x.positionMs === early, 'the position report');

    // lost for longer than the grace period (10 s): the session stops where it was
    const lostAt = Date.now();
    await pc.close(4999);
    const stopped = await phone.session(x => x.activeDevice === null, 'the session stopping', 20_000);
    const waited = Date.now() - lostAt;
    assert.ok(waited > 8_000 && waited < 15_000, `after the grace period of 10 s: ${waited} ms`);
    assert.equal(stopped.playing, false);
    assert.equal(stopped.rev, before.rev + 1);
    assert.ok(stopped.positionMs >= early && stopped.positionMs <= Math.min(length, early + 3000), `where it was when the connection dropped: ${stopped.positionMs}`);
    assert.deepEqual(stopped.lastDevice, { id, name: 'pc' });
    await phone.next(m => m.type === 'devices' && !m.devices.some(d => d.id === id), 'the PC gone from the list');

    // it kept playing through the loss and nothing changed since: its resume makes it the active device again
    pc = await device(BASE, query(), id, 'pc', { resume: { rev: before.rev, playing: true, positionMs: late } });
    assert.equal(pc.welcome.session.activeDevice, id);
    assert.equal(pc.welcome.session.playing, true);
    assert.equal(pc.welcome.session.positionMs, late);
    await phone.session(x => x.activeDevice === id && x.positionMs === late, 'the resume');

    // a goodbye: no grace period, the session stops at once, and another device can play it straight away
    const leftAt = Date.now();
    await pc.close(1000);
    const left = await phone.session(x => x.activeDevice === null, 'the session stopping');
    assert.ok(Date.now() - leftAt < 3000, 'at once');
    assert.equal(left.playing, false);
    assert.equal(left.current.trackId, songs[2].id);
    const mine = await phone.command('play');
    assert.equal(mine.activeDevice, phone.id);
    assert.equal(mine.playing, true);
    assert.ok(mine.positionMs >= late, 'from where it stopped');
  } finally { await Promise.all([pc.close(), phone.close()]); }
});

test('Connect 2: each user has a session of their own', { skip: (await skip()) || (otherUser() ? false : 'the manifest has no second user') }, async () => {
  const songs = await album();
  const other = otherUser();
  const mine = await me('mine');
  const theirs = await device(BASE, query(other), idOf('theirs'), 'theirs');
  try {
    const played = await mine.command('playContext', { ...context(songs), startId: songs[0].id });
    mine.inbox.length = 0; // what its own command brought
    assert.deepEqual(theirs.welcome.devices.map(d => d.id), [theirs.id], 'only their own devices');
    assert.notEqual(theirs.welcome.session.activeDevice, mine.id);
    // nothing a device sends names a user: the other user's device is not there
    assert.equal((await theirs.refused('transfer', { to: mine.id })).code, 'offline');
    assert.equal((await theirs.refused('volume', { device: mine.id, volume: 0 })).code, 'offline');
    const paused = await theirs.command('playContext', { ...context(songs), startId: songs[3].id }).then(() => theirs.command('pause'));
    assert.equal(paused.current.trackId, songs[3].id);
    await sleep(300);
    // and mine heard nothing of it
    assert.ok(!mine.inbox.some(m => m.type === 'session' || m.type === 'queue' || m.type === 'deviceCommand' || (m.type === 'devices' && m.devices.some(d => d.id === theirs.id))));
    const still = await mine.command('seek', { positionMs: 7000 });
    assert.equal(still.rev, played.rev + 1);
    assert.equal(still.current.trackId, songs[0].id);
    assert.equal(still.playing, true);
  } finally { await Promise.all([mine.close(), theirs.close()]); }
});
