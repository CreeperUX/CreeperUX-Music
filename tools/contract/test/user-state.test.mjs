// A user's own state: stars (star, unstar), plays (scrobble), the play queue (savePlayQueue, getPlayQueue), and what
// the golden database starts with (manifest.state). Each test puts back what it changed, except play counts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, getLibrary, id, manifest, me, CLIENT, ISO_DATE } from '../lib/context.mjs';

const song = async songId => (await api.ok('getSong', { id: songId })).song;
const state = manifest.state?.[manifest.primaryUser];

test('the starting state: stars, ratings and play counts', { skip: state ? false : 'the manifest has no state' }, async () => {
  for (const s of state.starred.song) assert.match((await song(s)).starred ?? '', ISO_DATE, `song ${s} starred`);
  for (const a of state.starred.album) assert.match((await api.ok('getAlbum', { id: a })).album.starred ?? '', ISO_DATE, `album ${a} starred`);
  for (const [s, n] of Object.entries(state.playCounts)) {
    const x = await song(s);
    assert.equal(x.playCount, n, `play count of ${s}`);
    assert.match(x.played, ISO_DATE);
  }
  for (const [itemId, rating] of Object.entries(state.ratings)) {
    const r = await api.call('getSong', { id: itemId });
    const item = r.body.status === 'ok' ? r.body.song : (await api.ok('getAlbum', { id: itemId })).album;
    assert.equal(item.userRating, rating, `rating of ${itemId}`);
  }
  const starred = (await api.ok('getStarred2')).starred2;
  assert.deepEqual((starred.song ?? []).map(s => s.id).sort(), [...state.starred.song].sort());
  assert.deepEqual((starred.album ?? []).map(a => a.id).sort(), [...state.starred.album].sort());
  assert.deepEqual((starred.artist ?? []).map(a => a.id).sort(), [...state.starred.artist].sort());
});

test('star and unstar a song', async () => {
  const { songs } = await getLibrary();
  const target = songs.find(s => !s.starred && !state?.starred.song.includes(s.id));
  try {
    await api.ok('star', { id: target.id });
    assert.match((await song(target.id)).starred ?? '', ISO_DATE);
  } finally {
    await api.ok('unstar', { id: target.id });
  }
  assert.equal((await song(target.id)).starred, undefined);
});

test('star and unstar several songs in one call', async () => {
  const free = (await getLibrary()).songs.filter(s => !s.starred).slice(0, 3).map(s => s.id);
  try {
    await api.ok('star', { id: free });
    for (const s of free) assert.ok((await song(s)).starred);
  } finally {
    await api.ok('unstar', { id: free });
  }
  for (const s of free) assert.equal((await song(s)).starred, undefined);
});

test('star and unstar an album and an artist (albumId, artistId)', async () => {
  const { songs, albums } = await getLibrary();
  const album = albums.find(a => !a.starred);
  const starredArtists = new Set(((await api.ok('getStarred2')).starred2.artist ?? []).map(a => a.id));
  const artistId = songs.map(s => s.artistId).find(a => a && !starredArtists.has(a));
  const params = { albumId: album.id, artistId };
  const artistStarred = async () => ((await api.ok('getStarred2')).starred2.artist ?? []).some(a => a.id === artistId);
  try {
    await api.ok('star', params);
    assert.ok((await api.ok('getAlbum', { id: album.id })).album.starred);
    assert.ok(await artistStarred(), 'the artist is starred');
  } finally {
    await api.ok('unstar', params);
  }
  assert.equal((await api.ok('getAlbum', { id: album.id })).album.starred, undefined);
  assert.equal(await artistStarred(), false);
});

test('scrobble with submission counts a play', async () => {
  const { songs } = await getLibrary();
  const target = id('track.opus') ?? songs[songs.length - 1].id;
  const before = (await song(target)).playCount ?? 0;
  await api.ok('scrobble', { id: target, submission: true });
  const after = await song(target);
  assert.equal(after.playCount, before + 1);
  assert.match(after.played, ISO_DATE);
});

test('scrobble’s time is when the song was played', async () => {
  const { songs } = await getLibrary();
  const target = id('track.m4a') ?? songs[songs.length - 2].id;
  const at = Date.parse('2026-02-03T04:05:06Z');
  await api.ok('scrobble', { id: target, submission: true, time: at });
  assert.equal(Date.parse((await song(target)).played), at);
});

test('scrobble without submission (now playing) counts nothing', async () => {
  const target = (await getLibrary()).songs[0].id;
  const before = (await song(target)).playCount ?? 0;
  await api.ok('scrobble', { id: target, submission: false });
  assert.equal((await song(target)).playCount ?? 0, before);
});

test('savePlayQueue then getPlayQueue: songs, current, position, who changed it', async () => {
  const original = (await api.ok('getPlayQueue')).playQueue;
  const ids = (await getLibrary()).songs.slice(0, 4).map(s => s.id);
  try {
    await api.ok('savePlayQueue', { id: ids, current: ids[2], position: 4321 });
    const q = (await api.ok('getPlayQueue')).playQueue;
    assert.deepEqual(q.entry.map(s => s.id), ids);
    assert.equal(q.current, ids[2]);
    assert.equal(q.position, 4321);
    assert.equal(q.username, me.username);
    assert.equal(q.changedBy, CLIENT);
    assert.match(q.changed, ISO_DATE);
    for (const s of q.entry) assert.equal(typeof s.title, 'string');
  } finally {
    if (original?.entry?.length) await api.ok('savePlayQueue', { id: original.entry.map(s => s.id), current: original.current, position: original.position ?? 0 });
  }
});

test('the starting play queue', { skip: state?.playQueue ? false : 'the manifest has no play queue' }, async () => {
  const q = (await api.ok('getPlayQueue')).playQueue;
  assert.deepEqual(q.entry.map(s => s.id), state.playQueue.ids);
  assert.equal(q.current, state.playQueue.current);
  assert.equal(q.position, state.playQueue.position);
});
