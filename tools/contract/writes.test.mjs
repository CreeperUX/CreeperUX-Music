// The writes the Rust server answers (phase 4), beyond what the writes corpus compares: that Navidrome sees them at
// once (its own web UI's /api and its Subsonic API) and the Rust server sees Navidrome's at once, that two users
// writing at the same time lose nothing, and that a write waits out a long write lock (a scan, a backup) instead of
// failing.
//
// Each test starts the Rust server on a fresh copy of the golden database (tools/fixtures/build.mjs first):
//   node --test tools/contract/writes.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { Subsonic } from './lib/subsonic.mjs';
import { ANSWERED_HEADER, startGatewayOnGolden } from './diff.mjs';

const CLIENT = 'sonus-writes-test';
const sleep = ms => new Promise(done => setTimeout(done, ms));

/** The Rust server on a fresh golden copy, two-step verification off (so Navidrome's own sign-in takes passwords). */
async function server(t, env = {}) {
  const rust = await startGatewayOnGolden({ env: { ND_SONUS_TWOFACTOR: 'off', ...env } });
  t.after(() => rust.stop());
  const { users, ids } = rust.manifest;
  // (with two-step verification off, the account password signs in to the Subsonic API)
  const as = name => new Subsonic(rust.url, { u: users[name].username, password: users[name].password, as: 'token' }, { client: CLIENT });
  return { rust, users, ids, as, db: join(rust.data, 'navidrome.db') };
}

/** A call through the Rust server that it must have answered itself, and successfully. */
async function rustOk(client, method, params, opts) {
  const { body, headers } = await client.call(method, params, opts);
  assert.equal(body.status, 'ok', `${method}: ${JSON.stringify(body.error)}`);
  assert.equal(headers.get(ANSWERED_HEADER), 'rust', `${method} was answered by the Rust server`);
  return body;
}

/** Signs in to the Navidrome behind the Rust server as its web UI does: { api(path), subsonic }. */
async function navidromeUi(base, user) {
  const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: user.username, password: user.password }) });
  assert.equal(res.status, 200, `Navidrome's sign-in: HTTP ${res.status} ${await res.clone().text()}`);
  const login = await res.json();
  const api = async path => {
    const r = await fetch(`${base}/api${path}`, { headers: { 'x-nd-authorization': `Bearer ${login.token}` } });
    assert.equal(r.status, 200, `GET /api${path}: HTTP ${r.status}`);
    return r.json();
  };
  // the web UI's own Subsonic calls: the salt and token its sign-in answered
  const raw = new Subsonic(base, {}, { client: 'NavidromeUI' });
  const subsonic = { ok: (method, params = {}) => raw.ok(method, { u: user.username, t: login.subsonicToken, s: login.subsonicSalt, ...params }) };
  return { api, subsonic };
}

test('a write made by the Rust server is seen at once by Navidrome, and one made by Navidrome by the Rust server', { timeout: 600_000 }, async t => {
  const { rust, users, ids, as } = await server(t);
  const me = as('listener');
  const go = await navidromeUi(rust.navidrome, users.listener);

  // Rust writes, Navidrome's web UI reads (/api) at once
  await rustOk(me, 'star', { id: ids['track.korean'] });
  await rustOk(me, 'setRating', { id: ids['track.korean'], rating: 4 });
  let song = await go.api(`/song/${ids['track.korean']}`);
  assert.equal(song.starred, true, 'the star, in /api');
  assert.equal(song.rating, 4, 'the rating, in /api');
  await rustOk(me, 'unstar', { id: ids['track.korean'] });
  song = await go.api(`/song/${ids['track.korean']}`);
  assert.ok(!song.starred, 'the unstar, in /api (Navidrome leaves out a false starred)');
  await rustOk(me, 'savePlayQueue', { id: [ids['track.mp3'], ids['track.ogg']], current: ids['track.ogg'], position: 4321 }, { post: true });
  const queue = await go.api('/queue');
  assert.deepEqual([queue.items.map(i => i.id), queue.current, queue.position], [[ids['track.mp3'], ids['track.ogg']], 1, 4321], 'the queue, in /api');

  // ... and Navidrome's Subsonic API reads the same at once
  const starredByGo = await go.subsonic.ok('getStarred2');
  assert.ok(!(starredByGo.starred2.song ?? []).some(s => s.id === ids['track.korean']), 'Navidrome sees the unstar');
  assert.equal((await go.subsonic.ok('getSong', { id: ids['track.korean'] })).song.userRating, 4, 'Navidrome sees the rating');

  // Navidrome writes (as its web UI does), the Rust server reads at once
  await go.subsonic.ok('star', { id: ids['track.wav'] });
  await go.subsonic.ok('setRating', { id: ids['album.cjk'], rating: 5 });
  await go.subsonic.ok('savePlayQueue', { id: [ids['track.flac']], current: ids['track.flac'], position: 10 });
  const starred = await rustOk(me, 'getStarred2', {});
  assert.ok(starred.starred2.song.some(s => s.id === ids['track.wav']), 'the Rust server sees Navidrome\'s star');
  assert.equal((await rustOk(me, 'getAlbum', { id: ids['album.cjk'] })).album.userRating, 5, 'the Rust server sees Navidrome\'s rating');
  const q = await rustOk(me, 'getPlayQueue', {});
  assert.deepEqual([q.playQueue.entry.map(e => e.id), q.playQueue.position, q.playQueue.changedBy], [[ids['track.flac']], 10, 'NavidromeUI']);
});

test('two users writing at the same time lose nothing', { timeout: 600_000 }, async t => {
  const { rust, users, as, db } = await server(t);
  const songs = (() => { const d = new DatabaseSync(db, { readOnly: true }); try { return d.prepare('SELECT id FROM media_file ORDER BY id').all().map(r => r.id); } finally { d.close(); } })();
  const people = [['listener', as('listener')], ['secure', as('secure')]];
  const rating = (who, i) => (who === 'listener' ? 1 + (i % 5) : 5 - (i % 5));
  const calls = [];
  for (const [who, client] of people) {
    songs.forEach((id, i) => {
      calls.push(() => rustOk(client, 'star', { id }, { post: i % 2 === 0 }));
      calls.push(() => rustOk(client, 'setRating', { id, rating: rating(who, i) }));
    });
    for (let n = 0; n < 10; n++) calls.push(() => rustOk(client, 'savePlayQueue', { id: songs.slice(n, n + 5), current: songs[n + 1], position: n }, { post: true }));
  }
  // every call at once, the two users' mixed (a fixed shuffle)
  const order = calls.map((call, i) => [(i * 7919) % calls.length, call]).sort((x, y) => x[0] - y[0]).map(([, call]) => call);
  await Promise.all(order.map(call => call()));
  // then each unstars every other song, again both at once
  await Promise.all(people.flatMap(([, client]) => songs.filter((_, i) => i % 2).map(id => rustOk(client, 'unstar', { id }))));

  const d = new DatabaseSync(db, { readOnly: true });
  try {
    for (const [who] of people) {
      const id = users[who].id;
      const rows = d.prepare("SELECT item_id, starred, rating FROM annotation WHERE user_id = ? AND item_type = 'media_file' ORDER BY item_id").all(id);
      const expected = songs.map((song, i) => ({ item_id: song, starred: i % 2 ? 0 : 1, rating: rating(who, i) }));
      assert.deepEqual(rows.map(r => ({ ...r })), expected, `${who}: every star, unstar and rating is there`);
      const queue = d.prepare('SELECT count(*) AS n FROM playqueue WHERE user_id = ?').get(id).n;
      assert.equal(queue, 1, `${who}: one queue`);
    }
    // each song's average is that of the two ratings
    for (const [i, song] of songs.entries()) {
      const avg = d.prepare('SELECT average_rating FROM media_file WHERE id = ?').get(song).average_rating;
      assert.equal(avg, Math.round(((rating('listener', i) + rating('secure', i)) / 2) * 100) / 100, `the average of song ${i}`);
    }
  } finally { d.close(); }
});

test('a write waits out a long write lock and a scan, and fails nothing', { timeout: 600_000 }, async t => {
  const { ids, as, db } = await server(t);
  const me = as('listener');

  // another writer holds the lock for 4 s (a backup, a long scan transaction)
  const holder = new DatabaseSync(db);
  holder.exec('PRAGMA busy_timeout = 5000');
  holder.exec('BEGIN IMMEDIATE');
  const started = Date.now();
  const released = sleep(4000).then(() => { holder.exec('COMMIT'); holder.close(); return Date.now(); });
  const answer = rustOk(me, 'star', { id: ids['track.turkish'] }).then(() => Date.now());
  const [releasedAt, answeredAt] = await Promise.all([released, answer]);
  assert.ok(answeredAt >= releasedAt, `the star was answered after the lock was let go (${answeredAt - started} ms, released at ${releasedAt - started} ms)`);

  // a full scan by Navidrome, with writes all through it
  // (a scan is an admin's to start)
  const scan = await as('admin').ok('startScan', { fullScan: true });
  assert.equal(scan.scanStatus.scanning, true);
  // (one round at a time, so that the last of each is known)
  for (let i = 0; i < 40; i++) {
    await Promise.all([
      rustOk(me, i % 2 ? 'star' : 'unstar', { id: ids['track.umlaut'] }),
      rustOk(me, 'setRating', { id: ids['track.tilde'], rating: 1 + (i % 5) }),
      rustOk(me, 'savePlayQueue', { id: [ids['track.cjk'], ids['track.wav']], current: ids['track.wav'], position: i }, { post: true }),
    ]);
  }
  for (let i = 0; i < 120; i++) {
    const { scanStatus } = await me.ok('getScanStatus');
    if (!scanStatus.scanning) break;
    await sleep(500);
  }
  const d = new DatabaseSync(db, { readOnly: true });
  try {
    const user = d.prepare('SELECT id FROM user WHERE user_name = ?').get(me.auth.u).id;
    const get = item => d.prepare("SELECT starred, rating FROM annotation WHERE user_id = ? AND item_id = ? AND item_type = 'media_file'").get(user, item);
    assert.equal(get(ids['track.turkish']).starred, 1, 'the star made under the lock');
    assert.equal(get(ids['track.umlaut']).starred, 1, 'the last of the stars made during the scan');
    assert.equal(get(ids['track.tilde']).rating, 5, 'the last rating made during the scan');
    assert.equal(d.prepare('SELECT position FROM playqueue WHERE user_id = ?').get(user).position, 39, 'the last queue saved during the scan');
  } finally { d.close(); }
});

test('playlists: made by either server and seen by the other at once; appends at the same time all kept, in order', { timeout: 600_000 }, async t => {
  const { rust, users, ids, as, db } = await server(t);
  const me = as('listener');
  const go = await navidromeUi(rust.navidrome, users.listener);

  // the Rust server makes and changes a playlist: Navidrome's web UI API and Subsonic API see it at once
  const made = await rustOk(me, 'createPlaylist', { name: 'Made by Rust', songId: [ids['track.flac'], ids['track.mp3']] }, { post: true });
  const id = made.playlist.id;
  await rustOk(me, 'updatePlaylist', { playlistId: id, songIdToAdd: ids['track.ogg'], songIndexToRemove: '0', comment: 'changed' }, { post: true });
  const viaApi = await go.api(`/playlist/${id}/tracks`);
  assert.deepEqual(viaApi.map(t => t.mediaFileId), [ids['track.mp3'], ids['track.ogg']], 'the tracks, in /api');
  const viaGo = await go.subsonic.ok('getPlaylist', { id });
  assert.deepEqual([viaGo.playlist.comment, viaGo.playlist.songCount, viaGo.playlist.entry.map(e => e.id)], ['changed', 2, [ids['track.mp3'], ids['track.ogg']]]);

  // Navidrome makes and changes one: the Rust server sees it at once
  const byGo = await go.subsonic.ok('createPlaylist', { name: 'Made by Go', songId: [ids['track.wav']] });
  await go.subsonic.ok('updatePlaylist', { playlistId: byGo.playlist.id, songIdToAdd: ids['track.cjk'], name: 'Made by Go (2)' });
  const seen = await rustOk(me, 'getPlaylist', { id: byGo.playlist.id });
  assert.deepEqual([seen.playlist.name, seen.playlist.entry.map(e => e.id)], ['Made by Go (2)', [ids['track.wav'], ids['track.cjk']]]);
  await go.subsonic.ok('deletePlaylist', { id: byGo.playlist.id });
  const { body } = await me.call('getPlaylist', { id: byGo.playlist.id });
  assert.equal(body.error?.code, 70, 'the Rust server sees the delete');

  // 60 appends to one playlist at once, and the two users each filling their own at the same time
  const songs = (() => { const d = new DatabaseSync(db, { readOnly: true }); try { return d.prepare('SELECT id FROM media_file ORDER BY id').all().map(r => r.id); } finally { d.close(); } })();
  const other = await rustOk(as('secure'), 'createPlaylist', { name: 'Secure fills this' });
  await Promise.all([
    ...Array.from({ length: 60 }, (_, i) => rustOk(me, 'updatePlaylist', { playlistId: id, songIdToAdd: songs[i % songs.length] }, { post: i % 2 === 0 })),
    ...songs.map(song => rustOk(as('secure'), 'updatePlaylist', { playlistId: other.playlist.id, songIdToAdd: song })),
  ]);
  const d = new DatabaseSync(db, { readOnly: true });
  try {
    const positions = list => d.prepare('SELECT id FROM playlist_tracks WHERE playlist_id = ? ORDER BY id').all(list).map(r => r.id);
    assert.deepEqual(positions(id), Array.from({ length: 62 }, (_, i) => i + 1), 'every append kept, numbered 1 to 62 without a gap or a repeat');
    assert.deepEqual(positions(other.playlist.id), songs.map((_, i) => i + 1), 'the other user\'s, all of them');
    assert.equal(d.prepare('SELECT song_count FROM playlist WHERE id = ?').get(id).song_count, 62, 'the count');
  } finally { d.close(); }
});

test('plays: counted by the Rust server, seen by Navidrome at once, never shown to Navidrome (so never sent on)', { timeout: 600_000 }, async t => {
  // Navidrome logs at debug level: every request it gets and every play it counts or hears of shows in its log
  const { rust, users, ids, as, db } = await server(t, { ND_LOGLEVEL: 'debug' });
  const me = as('listener');
  const go = await navidromeUi(rust.navidrome, users.listener);
  const before = (await go.api(`/song/${ids['track.feat']}`)).playCount ?? 0;
  await rustOk(me, 'scrobble', { id: ids['track.feat'], time: 1767484800000 }, { post: true });
  await rustOk(me, 'scrobble', { id: ids['track.korean'], submission: false });
  const song = await go.api(`/song/${ids['track.feat']}`);
  assert.equal(song.playCount, before + 1, 'the play, in /api');
  assert.ok(song.playDate?.startsWith('2026-01-04'), `its time, in /api: ${song.playDate}`);
  const playing = await rustOk(me, 'getNowPlaying', {});
  assert.deepEqual(playing.nowPlaying.entry.map(e => [e.id, e.username, e.playerName, e.state]), [[ids['track.korean'], users.listener.username, CLIENT, 'playing']]);
  // what Navidrome saw of it: nothing (a Sonus client's plays and "now playing" no longer reach its scrobblers)
  const log = rust.log();
  // (its settings, printed at start, mention EnableNowPlaying: not looked for)
  for (const sign of ['/rest/scrobble', 'msg=Scrobbled', 'msg="Now Playing"', 'Buffering Scrobble', 'PlaybackSession']) {
    assert.ok(!log.includes(sign), `Navidrome's log has no "${sign}"`);
  }
  const d = new DatabaseSync(db, { readOnly: true });
  try {
    assert.equal(d.prepare('SELECT count(*) AS n FROM scrobble_buffer').get().n, 0, 'nothing buffered for Last.fm or ListenBrainz');
    assert.equal(d.prepare('SELECT count(*) AS n FROM scrobbles WHERE media_file_id = ? AND submission_time = 1767484800').get(ids['track.feat']).n, 1, 'the play\'s history row');
  } finally { d.close(); }
  // the control: a play Navidrome does get (its web UI's own call) shows in that log
  await go.subsonic.ok('scrobble', { id: ids['track.feat'], time: 1767484900000 });
  await sleep(500);
  assert.ok(rust.log().includes('msg=Scrobbled'), 'a play Navidrome counts itself is logged as such');
});
