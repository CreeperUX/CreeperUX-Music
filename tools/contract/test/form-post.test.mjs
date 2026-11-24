// OpenSubsonic formPost: the same calls with the parameters in an application/x-www-form-urlencoded body (the web
// client posts savePlayQueue so long queues fit), sign-in included.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, as, getLibrary, manifest, needsUser, BASE, CLIENT } from '../lib/context.mjs';
import { Subsonic } from '../lib/subsonic.mjs';

const post = { post: true };

test('ping, getAlbum, search3 and getSong as form posts', async () => {
  assert.equal((await api.call('ping', {}, post)).body.status, 'ok');
  const { albums, songs } = await getLibrary();
  assert.equal((await api.ok('getAlbum', { id: albums[0].id }, post)).album.id, albums[0].id);
  assert.equal((await api.ok('getSong', { id: songs[0].id }, post)).song.id, songs[0].id);
  const r = await api.ok('search3', { query: '', songCount: 500, albumCount: 0, artistCount: 0 }, post);
  assert.equal(r.searchResult3.song.length, songs.length);
});

test('sign-in errors in a form post: wrong password 40, missing user 10', async () => {
  const anon = new Subsonic(BASE, {}, { client: CLIENT });
  assert.equal((await anon.call('ping', { u: manifest.users[manifest.primaryUser].username, p: 'wrong' }, post)).body.error?.code, 40);
  assert.equal((await anon.call('ping', { p: 'x' }, post)).body.error?.code, 10);
});

test('an API key in a form post', { skip: needsUser('secure') }, async () => {
  const key = new Subsonic(BASE, { apiKey: manifest.users.secure.apiKey }, { client: CLIENT });
  assert.equal((await key.ok('tokenInfo', {}, post)).tokenInfo.username, manifest.users.secure.username);
});

test('an app password in a form post', { skip: needsUser('secure') }, async () => {
  const c = as('secure', { as: 'password', password: manifest.users.secure.appPassword });
  assert.equal((await c.call('ping', {}, post)).body.status, 'ok');
});

test('savePlayQueue as a form post with a long queue', async () => {
  const original = (await api.ok('getPlayQueue')).playQueue;
  const songs = (await getLibrary()).songs.map(s => s.id);
  const ids = Array.from({ length: 300 }, (_, i) => songs[i % songs.length]);
  try {
    await api.ok('savePlayQueue', { id: ids, current: ids[5], position: 777 }, post);
    const q = (await api.ok('getPlayQueue')).playQueue;
    assert.deepEqual(q.entry.map(s => s.id), ids);
    assert.equal(q.position, 777);
  } finally {
    if (original?.entry?.length) await api.ok('savePlayQueue', { id: original.entry.map(s => s.id), current: original.current, position: original.position ?? 0 }, post);
  }
});

test('createPlaylist, updatePlaylist, deletePlaylist, star and unstar as form posts', async () => {
  const [a, b] = (await getLibrary()).songs.filter(s => !s.starred).map(s => s.id);
  const p = (await api.ok('createPlaylist', { name: 'Contract: posted', songId: [a, b] }, post)).playlist;
  try {
    await api.ok('updatePlaylist', { playlistId: p.id, name: 'Contract: posted, renamed', songIndexToRemove: 1 }, post);
    const got = (await api.ok('getPlaylist', { id: p.id })).playlist;
    assert.equal(got.name, 'Contract: posted, renamed');
    assert.deepEqual(got.entry.map(s => s.id), [a]);
  } finally {
    await api.ok('deletePlaylist', { id: p.id }, post);
  }
  await api.ok('star', { id: a }, post);
  assert.ok((await api.ok('getSong', { id: a })).song.starred);
  await api.ok('unstar', { id: a }, post);
  assert.equal((await api.ok('getSong', { id: a })).song.starred, undefined);
});
