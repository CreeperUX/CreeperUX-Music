// getLyricsBySongId (OpenSubsonic songLyrics: synced lines, the offset), getSimilarSongs2 and getArtistInfo2.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, getLibrary, id, needs } from '../lib/context.mjs';

const lyrics = async key => (await api.ok('getLyricsBySongId', { id: id(key) })).lyricsList.structuredLyrics;

test('getLyricsBySongId answers a list for every song, empty or not', async () => {
  for (const s of (await getLibrary()).songs.slice(0, 8)) {
    const list = (await api.ok('getLyricsBySongId', { id: s.id })).lyricsList.structuredLyrics ?? [];
    for (const l of list) {
      assert.equal(typeof l.synced, 'boolean');
      assert.equal(typeof l.lang, 'string');
      for (const line of l.line) {
        assert.equal(typeof line.value, 'string');
        if (l.synced) assert.ok(Number.isInteger(line.start));
      }
    }
  }
});

test('embedded synced lyrics: lines with start times and the LRC offset', { skip: needs('track.syncedLyrics') }, async () => {
  const [l] = await lyrics('track.syncedLyrics');
  assert.equal(l.synced, true);
  assert.equal(l.offset, 500);
  assert.deepEqual(l.line.map(x => [x.start, x.value]), [[500, 'Field lines bend'], [1500, 'Toward the pole'], [2500, 'And hold']]);
  assert.equal(l.displayTitle, 'Magnetic Field');
  assert.equal(l.displayArtist, 'Aurora Lane');
});

test('an .lrc beside the file: its lines and a negative offset', { skip: needs('track.lrcSidecar') }, async () => {
  const [l] = await lyrics('track.lrcSidecar');
  assert.equal(l.synced, true);
  assert.equal(l.offset, -250);
  assert.deepEqual(l.line.map(x => [x.start, x.value]), [[200, 'Morning comes slow'], [1200, 'Over the snow'], [2200, 'First light']]);
});

test('embedded unsynced lyrics: lines without times, the tag’s language', { skip: needs('track.unsyncedLyrics') }, async () => {
  const [l] = await lyrics('track.unsyncedLyrics');
  assert.equal(l.synced, false);
  assert.equal(l.lang, 'eng');
  assert.deepEqual(l.line.map(x => x.value), ['Hello summer', 'Hello sun', 'Unsynced words']);
  assert.ok(l.line.every(x => x.start === undefined));
});

test('a song without lyrics has none', { skip: needs('track.m4a') }, async () => {
  assert.deepEqual(await lyrics('track.m4a') ?? [], []);
});

test('getLyrics (by artist and title, the clients’ fallback) answers the text, embedded or beside the file', { skip: needs('track.syncedLyrics') }, async () => {
  const r = (await api.ok('getLyrics', { artist: 'Aurora Lane', title: 'Magnetic Field' })).lyrics;
  assert.equal(r.artist, 'Aurora Lane');
  assert.equal(r.title, 'Magnetic Field');
  assert.equal(r.value, 'Field lines bend\nToward the pole\nAnd hold\n', 'the lines without their times');
  assert.equal((await api.ok('getLyrics', { artist: 'Aurora Lane', title: 'First Light' })).lyrics.value, 'Morning comes slow\nOver the snow\nFirst light\n');
});

test('getLyrics of a song nobody has answers an empty text', async () => {
  const r = (await api.ok('getLyrics', { artist: 'Nobody by this name', title: 'Nothing by this title' })).lyrics;
  assert.equal(r?.value ?? '', '');
});

test('getLyricsBySongId of an unknown id is error 70', async () => {
  assert.equal((await api.call('getLyricsBySongId', { id: 'no-such-song' })).body.error?.code, 70);
});

test('getSimilarSongs2 of a song (as Sonus asks) answers a list of songs, empty when nothing is known', async () => {
  const s = (await getLibrary()).songs[0];
  const r = await api.ok('getSimilarSongs2', { id: s.id, count: 10 });
  assert.ok(r.similarSongs2 && typeof r.similarSongs2 === 'object');
  for (const x of r.similarSongs2.song ?? []) assert.equal(typeof x.id, 'string');
});

test('getSimilarSongs2 of an artist (as the API defines it) answers a list too', async () => {
  const s = (await getLibrary()).songs[0];
  assert.ok((await api.ok('getSimilarSongs2', { id: s.artistId, count: 10 })).similarSongs2);
});

test('getArtistInfo2 answers an object (biography and links when known)', async () => {
  const s = (await getLibrary()).songs[0];
  const r = await api.ok('getArtistInfo2', { id: s.artistId });
  assert.ok(r.artistInfo2 && typeof r.artistInfo2 === 'object');
  for (const k of ['biography', 'lastFmUrl', 'musicBrainzId']) if (r.artistInfo2[k] !== undefined) assert.equal(typeof r.artistInfo2[k], 'string');
});

test('getArtistInfo2 of an unknown id is error 70', async () => {
  assert.equal((await api.call('getArtistInfo2', { id: 'no-such-artist' })).body.error?.code, 70);
});
