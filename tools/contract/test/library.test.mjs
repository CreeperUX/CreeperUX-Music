// Reading the library as Sonus clients do: getAlbumList2 and search3 with the empty query, paged, then getAlbum,
// getSong and search3 with words; the fields the clients map into tracks and albums (web/src/api/subsonic.js trackOf
// and albumOf, src/Sonus.Core/SubsonicClient.cs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, getLibrary, manifest, ISO_DATE } from '../lib/context.mjs';

function assertSong(s, where) {
  const at = `${where}: song ${s.id}`;
  for (const k of ['id', 'title', 'album', 'albumId', 'artist', 'artistId', 'suffix', 'contentType', 'path', 'created']) {
    assert.equal(typeof s[k], 'string', `${at}: ${k}`);
  }
  for (const k of ['duration', 'size', 'bitRate']) assert.ok(Number.isFinite(s[k]) && s[k] >= 0, `${at}: ${k} = ${s[k]}`);
  assert.match(s.created, ISO_DATE, `${at}: created`);
  assert.equal(s.isDir, false, `${at}: isDir`);
  for (const k of ['track', 'discNumber', 'year', 'playCount', 'samplingRate', 'channelCount', 'bitDepth', 'userRating']) {
    if (s[k] !== undefined) assert.ok(Number.isInteger(s[k]), `${at}: ${k} = ${s[k]}`);
  }
  if (s.starred !== undefined) assert.match(s.starred, ISO_DATE, `${at}: starred`);
  if (s.played !== undefined) assert.match(s.played, ISO_DATE, `${at}: played`);
  if (s.coverArt !== undefined) assert.equal(typeof s.coverArt, 'string');
  if (s.genres !== undefined) assert.ok(s.genres.every(g => typeof g.name === 'string'), `${at}: genres`);
  if (s.artists !== undefined) assert.ok(s.artists.every(a => typeof a.id === 'string' && typeof a.name === 'string'), `${at}: artists`);
  if (s.albumArtists !== undefined) assert.ok(s.albumArtists.every(a => typeof a.id === 'string' && typeof a.name === 'string'), `${at}: albumArtists`);
  if (s.replayGain !== undefined) for (const v of Object.values(s.replayGain)) assert.equal(typeof v, 'number', `${at}: replayGain`);
}

function assertAlbum(a, where) {
  const at = `${where}: album ${a.id}`;
  for (const k of ['id', 'name', 'artist', 'artistId']) assert.equal(typeof a[k], 'string', `${at}: ${k}`);
  for (const k of ['songCount', 'duration']) assert.ok(Number.isInteger(a[k]), `${at}: ${k}`);
  assert.match(a.created, ISO_DATE, `${at}: created`);
  if (a.year !== undefined) assert.ok(Number.isInteger(a.year), `${at}: year`);
  if (a.coverArt !== undefined) assert.equal(typeof a.coverArt, 'string');
  if (a.isCompilation !== undefined) assert.equal(typeof a.isCompilation, 'boolean');
  if (a.genres !== undefined) assert.ok(a.genres.every(g => typeof g.name === 'string'));
  if (a.releaseTypes !== undefined) assert.ok(a.releaseTypes.every(t => typeof t === 'string'));
  if (a.recordLabels !== undefined) assert.ok(a.recordLabels.every(l => typeof l.name === 'string'));
}

test('getAlbumList2 alphabeticalByName pages through every album, each once', async () => {
  const { albums } = await getLibrary();
  assert.ok(albums.length > 0);
  if (manifest.counts?.albums !== undefined) assert.equal(albums.length, manifest.counts.albums);
  const pages = [];
  for (let offset = 0; ; offset += 3) {
    const page = (await api.ok('getAlbumList2', { type: 'alphabeticalByName', size: 3, offset })).albumList2.album ?? [];
    pages.push(...page);
    if (page.length < 3) break;
  }
  assert.deepEqual(pages.map(a => a.id), albums.map(a => a.id), 'small pages give the same albums in the same order');
  assert.equal(new Set(albums.map(a => a.id)).size, albums.length, 'no album twice');
  for (const a of albums) assertAlbum(a, 'getAlbumList2');
});

test('getAlbumList2 newest and random answer albums too', async () => {
  for (const type of ['newest', 'random', 'frequent', 'recent', 'starred', 'alphabeticalByArtist']) {
    const r = await api.ok('getAlbumList2', { type, size: 5 });
    assert.ok(Array.isArray(r.albumList2.album ?? []), type);
  }
});

test('getAlbumList2 random: a pass over its pages gives every album once, and another pass another order', async () => {
  const { albums } = await getLibrary();
  if (albums.length < 6) return; // too few albums to tell one order from another
  const pass = async () => {
    const ids = [];
    for (let offset = 0; ; offset += 4) {
      const page = (await api.ok('getAlbumList2', { type: 'random', size: 4, offset })).albumList2.album ?? [];
      ids.push(...page.map(a => a.id));
      if (page.length < 4) return ids;
    }
  };
  const orders = new Set();
  for (let i = 0; i < 6; i++) {
    const ids = await pass();
    assert.deepEqual([...ids].sort(), albums.map(a => a.id).sort(), 'every album, each once: the pages of one pass belong together');
    orders.add(ids.join(' '));
  }
  assert.ok(orders.size > 1, 'six passes are not all in the same order');
  const one = (await api.ok('getAlbumList2', { type: 'random', size: 1 })).albumList2.album;
  assertAlbum(one[0], 'getAlbumList2 random');
});

test('getAlbumList2 says how many albums the whole list has (X-Total-Count)', async () => {
  const { albums } = await getLibrary();
  const res = await api.call('getAlbumList2', { type: 'alphabeticalByName', size: 2, offset: 1 });
  assert.equal(res.headers.get('x-total-count'), String(albums.length));
});

test('search3 with the empty query pages the whole library, each song once', async () => {
  const { songs } = await getLibrary();
  assert.ok(songs.length > 0);
  if (manifest.counts?.songs !== undefined) assert.equal(songs.length, manifest.counts.songs);
  const pages = [];
  for (let offset = 0; ; offset += 4) {
    const page = (await api.ok('search3', { query: '', songCount: 4, songOffset: offset, albumCount: 0, artistCount: 0 })).searchResult3.song ?? [];
    pages.push(...page);
    if (page.length < 4) break;
  }
  assert.deepEqual(pages.map(s => s.id), songs.map(s => s.id), 'small pages give the same songs in the same order');
  assert.equal(new Set(songs.map(s => s.id)).size, songs.length, 'no song twice');
  for (const s of songs) assertSong(s, 'search3');
});

test('search3 with words finds songs, albums and artists', async () => {
  const { songs } = await getLibrary();
  const target = songs.find(s => /^[A-Za-z]{4,}/.test(s.title)) ?? songs[0];
  const word = target.title.split(/\s+/)[0];
  const r = (await api.ok('search3', { query: word, songCount: 50, albumCount: 20, artistCount: 20 })).searchResult3;
  assert.ok((r.song ?? []).some(s => s.id === target.id), `"${word}" finds ${target.title}`);
  for (const s of r.song ?? []) assertSong(s, `search3 "${word}"`);
  for (const a of r.album ?? []) assertAlbum(a, `search3 "${word}"`);
  for (const a of r.artist ?? []) assert.equal(typeof a.name, 'string');
});

test('getAlbum lists its songs in disc and track order', async () => {
  const { albums } = await getLibrary();
  for (const a of albums.slice(0, 20)) {
    const album = (await api.ok('getAlbum', { id: a.id })).album;
    assertAlbum(album, 'getAlbum');
    assert.equal(album.id, a.id);
    assert.equal(album.song.length, album.songCount, `${a.name} (${a.artist}): songs listed`);
    for (const s of album.song) { assertSong(s, `getAlbum ${a.name}`); assert.equal(s.albumId, a.id); }
    const order = album.song.map(s => [s.discNumber ?? 1, s.track ?? 0]);
    const sorted = [...order].sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    assert.deepEqual(order, sorted, `${a.name}: songs in disc and track order`);
  }
});

test('getAlbum of an unknown id is error 70', async () => {
  const { body } = await api.call('getAlbum', { id: 'no-such-album' });
  assert.equal(body.error?.code, 70);
});

test('getSong answers the song as the lists do', async () => {
  const { songs } = await getLibrary();
  for (const s of songs.slice(0, 10)) {
    const song = (await api.ok('getSong', { id: s.id })).song;
    assertSong(song, 'getSong');
    for (const k of ['id', 'title', 'album', 'albumId', 'artist', 'suffix', 'size', 'duration', 'path']) assert.deepEqual(song[k], s[k], k);
  }
});

test('getSong of an unknown id is error 70', async () => {
  const { body } = await api.call('getSong', { id: 'no-such-song' });
  assert.equal(body.error?.code, 70);
});
