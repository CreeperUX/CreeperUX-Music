// Playlists: listing (one's own, other users' public ones, smart playlists), reading, and the changes Sonus makes:
// createPlaylist (new, or overwrite with playlistId), updatePlaylist, deletePlaylist. What a test makes it removes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, expected, getLibrary, id, me, needs, ISO_DATE } from '../lib/context.mjs';

const assertPlaylist = (p, where) => {
  for (const k of ['id', 'name', 'owner']) assert.equal(typeof p[k], 'string', `${where}: ${k}`);
  for (const k of ['songCount', 'duration']) assert.ok(Number.isInteger(p[k]), `${where}: ${k}`);
  if (p.public !== undefined) assert.equal(typeof p.public, 'boolean', `${where}: public (Navidrome leaves it out when false)`);
  assert.match(p.changed, ISO_DATE, `${where}: changed`);
  assert.match(p.created, ISO_DATE, `${where}: created`);
};
const someSongs = async n => (await getLibrary()).songs.slice(0, n).map(s => s.id);

test('getPlaylists lists one’s own playlists and other users’ public ones', async () => {
  const list = (await api.ok('getPlaylists')).playlists.playlist ?? [];
  for (const p of list) assertPlaylist(p, `getPlaylists ${p.name}`);
  assert.ok(list.some(p => p.owner !== me.username && p.public), 'a public playlist of another user');
  for (const key of ['playlist.own', 'playlist.otherUser', 'playlist.smart']) {
    if (!id(key)) continue;
    const p = list.find(x => x.id === id(key));
    assert.ok(p, `${key} is listed`);
    const e = expected(key);
    assert.equal(p.name, e.name); assert.equal(p.owner, e.owner); assert.equal(p.public ?? false, e.public);
  }
});

test('getPlaylist of one’s own lists its songs', { skip: needs('playlist.own') }, async () => {
  const p = (await api.ok('getPlaylist', { id: id('playlist.own') })).playlist;
  assertPlaylist(p, 'own');
  assert.equal(p.entry.length, expected('playlist.own').songCount);
  assert.equal(p.songCount, p.entry.length);
  assert.ok(!p.readonly, 'one’s own playlist is not read-only');
  for (const s of p.entry) assert.equal(typeof s.id, 'string');
});

test('getPlaylist of another user’s public playlist is read-only to us', async () => {
  const list = (await api.ok('getPlaylists')).playlists.playlist ?? [];
  const other = list.find(p => p.id === id('playlist.otherUser')) ?? list.find(p => p.owner !== me.username);
  const p = (await api.ok('getPlaylist', { id: other.id })).playlist;
  assert.notEqual(p.owner, me.username);
  if (p.readonly !== undefined) assert.equal(p.readonly, true);
  assert.equal(p.entry.length, p.songCount);
});

test('another user’s playlist cannot be changed or deleted (50)', async () => {
  const list = (await api.ok('getPlaylists')).playlists.playlist ?? [];
  const other = list.find(p => p.id === id('playlist.otherUser')) ?? list.find(p => p.owner !== me.username);
  assert.equal((await api.call('updatePlaylist', { playlistId: other.id, name: 'Not yours' })).body.error?.code, 50);
  assert.equal((await api.call('deletePlaylist', { id: other.id })).body.error?.code, 50);
  assert.equal((await api.ok('getPlaylist', { id: other.id })).playlist.name, other.name);
});

test('a smart playlist lists the songs its rules pick', { skip: needs('playlist.smart') }, async () => {
  const p = (await api.ok('getPlaylist', { id: id('playlist.smart') })).playlist;
  assert.equal(p.entry.length, expected('playlist.smart').songCount);
  assert.ok(p.entry.every(s => s.suffix === 'flac'), 'only FLAC (the rule)');
  const titles = p.entry.map(s => s.title);
  assert.deepEqual(titles, [...titles].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1)), 'sorted by title');
  if (p.readonly !== undefined) assert.equal(p.readonly, true);
});

test('createPlaylist makes one; updatePlaylist renames, adds, removes; deletePlaylist removes it', async () => {
  const [a, b, c] = await someSongs(3);
  const created = (await api.ok('createPlaylist', { name: 'Contract: new', songId: [a, b] })).playlist;
  try {
    assertPlaylist(created, 'createPlaylist');
    assert.equal(created.owner, me.username);
    assert.deepEqual(created.entry.map(s => s.id), [a, b]);
    await api.ok('updatePlaylist', { playlistId: created.id, name: 'Contract: renamed', comment: 'A comment', songIdToAdd: c, songIndexToRemove: 0 });
    const p = (await api.ok('getPlaylist', { id: created.id })).playlist;
    assert.equal(p.name, 'Contract: renamed');
    assert.equal(p.comment, 'A comment');
    assert.deepEqual(p.entry.map(s => s.id), [b, c]);
    const listed = ((await api.ok('getPlaylists')).playlists.playlist ?? []).find(x => x.id === created.id);
    assert.equal(listed.songCount, 2);
  } finally {
    await api.ok('deletePlaylist', { id: created.id });
  }
  assert.equal((await api.call('getPlaylist', { id: created.id })).body.error?.code, 70);
});

test('createPlaylist with playlistId replaces the songs of an existing one', async () => {
  const [a, b, c] = await someSongs(3);
  const created = (await api.ok('createPlaylist', { name: 'Contract: overwrite', songId: [a, b] })).playlist;
  try {
    const r = (await api.ok('createPlaylist', { playlistId: created.id, songId: [c, a] })).playlist;
    assert.equal(r.id, created.id);
    const p = (await api.ok('getPlaylist', { id: created.id })).playlist;
    assert.deepEqual(p.entry.map(s => s.id), [c, a]);
    assert.equal(p.name, 'Contract: overwrite');
  } finally {
    await api.ok('deletePlaylist', { id: created.id });
  }
});

test('updatePlaylist removes several songs at once', async () => {
  const [a, b, c] = await someSongs(3);
  const created = (await api.ok('createPlaylist', { name: 'Contract: removals', songId: [a, b, c] })).playlist;
  try {
    await api.ok('updatePlaylist', { playlistId: created.id, songIndexToRemove: [0, 2] });
    assert.deepEqual((await api.ok('getPlaylist', { id: created.id })).playlist.entry.map(s => s.id), [b]);
  } finally {
    await api.ok('deletePlaylist', { id: created.id });
  }
});

test('updatePlaylist makes a playlist public and private again', async () => {
  const [a] = await someSongs(1);
  const created = (await api.ok('createPlaylist', { name: 'Contract: public', songId: [a] })).playlist;
  try {
    assert.equal(created.public ?? false, false, 'a new playlist is private');
    await api.ok('updatePlaylist', { playlistId: created.id, public: true });
    assert.equal((await api.ok('getPlaylist', { id: created.id })).playlist.public, true);
    await api.ok('updatePlaylist', { playlistId: created.id, public: false });
    assert.equal((await api.ok('getPlaylist', { id: created.id })).playlist.public ?? false, false);
  } finally {
    await api.ok('deletePlaylist', { id: created.id });
  }
});

test('getPlaylist of an unknown id is error 70', async () => {
  assert.equal((await api.call('getPlaylist', { id: 'no-such-playlist' })).body.error?.code, 70);
});
