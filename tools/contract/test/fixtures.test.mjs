// The fixture library's hard cases (tools/fixtures/README.md), as the frozen Navidrome reads them: several artists,
// compilations, two discs, one album name by two artists, CJK, accents and the Turkish I, missing tags, ReplayGain,
// MusicBrainz ids, original dates, several genres. Skipped against a server without the fixture library.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, expected, id, needs } from '../lib/context.mjs';

const song = async key => (await api.ok('getSong', { id: id(key) })).song;
const album = async key => (await api.ok('getAlbum', { id: id(key) })).album;
const names = list => (list ?? []).map(a => a.name);

test('titles, albums and artists come back exactly as tagged, in every format', { skip: needs('track.flac') }, async () => {
  for (const key of ['track.flac', 'track.mp3', 'track.m4a', 'track.ogg', 'track.opus', 'track.wav', 'track.cjk', 'track.japanese',
    'track.korean', 'track.accented', 'track.umlaut', 'track.tilde', 'track.turkish', 'track.dotlessI', 'track.upperI']) {
    const s = await song(key), e = expected(key);
    assert.equal(s.title, e.title, `${key}: title`);
    assert.equal(s.album, e.album, `${key}: album`);
    assert.equal(s.artist, e.artist, `${key}: artist`);
    assert.equal(s.suffix, e.suffix, `${key}: suffix`);
  }
});

test('"A / B" and "A feat. B" are split into two artists; the tag is kept for display', { skip: needs('track.slashArtists', 'track.feat') }, async () => {
  const slash = await song('track.slashArtists');
  assert.deepEqual(names(slash.artists), ['Aurora Lane', 'Kenji Mori']);
  assert.equal(slash.displayArtist, 'Aurora Lane / Kenji Mori');
  const feat = await song('track.feat');
  assert.deepEqual(names(feat.artists), ['Kenji Mori', 'Lumi']);
  assert.equal(feat.artist, 'Kenji Mori feat. Lumi');
});

test('an ARTISTS tag wins over the ARTIST text', { skip: needs('track.artistsTag', 'artist.lumi', 'artist.dax') }, async () => {
  const s = await song('track.artistsTag');
  assert.deepEqual(names(s.artists), ['Lumi', 'Dax']);
  assert.deepEqual(s.artists.map(a => a.id), [id('artist.lumi'), id('artist.dax')]);
  assert.equal(s.artist, 'Lumi & Dax');
});

test('a compilation without an album artist is by Various Artists', { skip: needs('album.compilation') }, async () => {
  const a = await album('album.compilation');
  assert.equal(a.name, 'Summer Hits');
  assert.equal(a.artist, 'Various Artists');
  assert.equal(a.isCompilation, true);
  assert.equal(a.songCount, 4);
  assert.equal(new Set(a.song.map(s => s.artist)).size, 4, 'each song keeps its own artist');
  for (const s of a.song) assert.deepEqual(names(s.albumArtists), ['Various Artists']);
});

test('two discs make one album, in disc order, with the disc subtitles', { skip: needs('album.twoDiscs') }, async () => {
  const a = await album('album.twoDiscs');
  assert.equal(a.songCount, 4);
  assert.deepEqual(a.song.map(s => [s.discNumber, s.track]), [[1, 1], [1, 2], [2, 1], [2, 2]]);
  const albumId = id('album.twoDiscs');
  assert.deepEqual(a.discTitles, [{ disc: 1, title: 'Day', coverArt: `dc-${albumId}:1` }, { disc: 2, title: 'Night', coverArt: `dc-${albumId}:2` }]);
  assert.equal((await song('track.disc2')).albumId, id('album.twoDiscs'));
});

test('the same album name by two artists is two albums', { skip: needs('album.sameName.aurora', 'album.sameName.kenji') }, async () => {
  assert.notEqual(id('album.sameName.aurora'), id('album.sameName.kenji'));
  const [a, k] = [await album('album.sameName.aurora'), await album('album.sameName.kenji')];
  assert.equal(a.name, 'Greatest Hits'); assert.equal(k.name, 'Greatest Hits');
  assert.equal(a.artist, 'Aurora Lane'); assert.equal(k.artist, 'Kenji Mori');
  assert.equal(a.songCount, 2); assert.equal(k.songCount, 2);
  const found = (await api.ok('search3', { query: 'Greatest Hits', songCount: 0, albumCount: 10, artistCount: 0 })).searchResult3.album ?? [];
  assert.deepEqual(found.map(x => x.id).sort(), [id('album.sameName.aurora'), id('album.sameName.kenji')].sort());
});

test('CJK names: exact, searchable, with the Latin sort name', { skip: needs('track.cjk', 'album.cjk', 'artist.cjk') }, async () => {
  const a = await album('album.cjk');
  assert.equal(a.name, '城市的灯火');
  assert.equal(a.artist, '林夕雨');
  assert.deepEqual(a.song.map(s => s.title), ['夜行列车', '雨の日の手紙', '별빛 아래서']);
  for (const q of ['夜行', '雨の日', '별빛']) {
    const found = (await api.ok('search3', { query: q, songCount: 10, albumCount: 0, artistCount: 0 })).searchResult3.song ?? [];
    assert.equal(found.length, 1, `"${q}"`);
  }
});

test('accents: exact titles, found without the accents', { skip: needs('track.accented') }, async () => {
  for (const [q, key] of [['ete', 'track.accented'], ['uber', 'track.umlaut'], ['nandu', 'track.tilde']]) {
    const found = (await api.ok('search3', { query: q, songCount: 10, albumCount: 0, artistCount: 0 })).searchResult3.song ?? [];
    assert.deepEqual(found.map(s => s.id), [id(key)], `"${q}"`);
  }
});

test('the Turkish I: İ, ı and I lowercase as Go does (sortName), and search finds them', { skip: needs('track.turkish', 'track.dotlessI', 'track.upperI') }, async () => {
  // Go's strings.ToLower maps İ (U+0130) to a plain "i"; Rust's to_lowercase gives "i̇" (i + U+0307). Neither is
  // Turkish-aware: I lowercases to "i", not "ı".
  assert.equal((await song('track.turkish')).sortName, 'ince yol');
  assert.equal((await song('track.dotlessI')).sortName, 'isık');
  assert.equal((await song('track.upperI')).sortName, 'irmak');
  const found = (await api.ok('search3', { query: 'ince', songCount: 10, albumCount: 0, artistCount: 0 })).searchResult3.song ?? [];
  assert.deepEqual(found.map(s => s.id), [id('track.turkish')]);
});

test('missing tags: an unknown album, an unknown artist, the file name as title', { skip: needs('track.noAlbum', 'track.noArtist', 'track.noTags') }, async () => {
  const noAlbum = await song('track.noAlbum');
  assert.equal(noAlbum.album, '[Unknown Album]');
  assert.equal(noAlbum.artist, 'Aurora Lane');
  const noArtist = await song('track.noArtist');
  assert.equal(noArtist.artist, '[Unknown Artist]');
  assert.equal(noArtist.album, 'Orphans');
  const none = await song('track.noTags');
  assert.equal(none.title, 'untagged');
  assert.equal(none.album, '[Unknown Album]');
  assert.equal(none.artist, '[Unknown Artist]');
  assert.notEqual(none.albumId, noAlbum.albumId, 'unknown albums of different artists stay apart');
});

test('ReplayGain, as numbers', { skip: needs('track.replayGain') }, async () => {
  assert.deepEqual((await song('track.replayGain')).replayGain, expected('track.replayGain').replayGain);
});

test('MusicBrainz ids: the recording’s on the song, the release’s on the album', { skip: needs('track.musicBrainz', 'album.normal') }, async () => {
  assert.equal((await song('track.musicBrainz')).musicBrainzId, expected('track.musicBrainz').musicBrainzId);
  assert.equal((await album('album.normal')).musicBrainzId, '0f3d6a8e-5c1b-4d2a-9e7f-1a2b3c4d5e02');
});

test('an original date older than the release date: the year is the original’s', { skip: needs('track.originalDate', 'album.normal') }, async () => {
  const a = await album('album.normal');
  assert.deepEqual(a.originalReleaseDate, { year: 2015, month: 3, day: 1 });
  assert.equal(a.year, 2015);
  assert.equal((await song('track.originalDate')).year, 2015);
});

test('several genres: all listed, the first as genre', { skip: needs('track.flac', 'track.twoGenres') }, async () => {
  for (const key of ['track.flac', 'track.twoGenres']) {
    const s = await song(key);
    assert.deepEqual(names(s.genres), expected(key).genres, key);
    assert.equal(s.genre, expected(key).genres[0], key);
  }
});

test('audio properties as TagLib reads the fixture files', { skip: needs('track.flac', 'track.mp3', 'track.opus') }, async () => {
  const flac = await song('track.flac');
  assert.equal(flac.samplingRate, 44100); assert.equal(flac.bitDepth, 16); assert.equal(flac.channelCount, 1); assert.equal(flac.duration, 3);
  const mp3 = await song('track.mp3');
  assert.equal(mp3.bitRate, 128); assert.equal(mp3.samplingRate, 48000); assert.equal(mp3.duration, 3);
  const opus = await song('track.opus');
  assert.equal(opus.samplingRate, 48000); assert.equal(opus.duration, 3);
});
