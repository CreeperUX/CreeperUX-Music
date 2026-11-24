// Bytes: getCoverArt (as is and resized, as clients ask for 512 and 600) and stream (the whole file, byte ranges for
// seeking).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { api, expected, getLibrary, id, manifest, needs } from '../lib/context.mjs';

const bytes = async res => Buffer.from(await res.arrayBuffer());
const sha = buf => createHash('sha256').update(buf).digest('hex');
const isImage = buf => (buf[0] === 0xff && buf[1] === 0xd8) || buf.subarray(0, 4).toString('latin1') === '\x89PNG' || buf.subarray(8, 12).toString('latin1') === 'WEBP';

test('getCoverArt of an album answers an image, resized when asked', async () => {
  const { albums } = await getLibrary();
  const album = albums.find(a => a.coverArt);
  const full = await api.fetch('getCoverArt', { id: album.coverArt });
  assert.equal(full.status, 200);
  assert.match(full.headers.get('content-type'), /^image\//);
  const big = await bytes(full);
  assert.ok(isImage(big), 'image bytes');
  for (const size of [600, 64]) {
    const res = await api.fetch('getCoverArt', { id: album.coverArt, size });
    assert.equal(res.status, 200, `size ${size}`);
    assert.match(res.headers.get('content-type'), /^image\//);
    assert.ok(isImage(await bytes(res)), `size ${size}: image bytes`);
  }
});

test('getCoverArt of a song answers an image', async () => {
  const { songs } = await getLibrary();
  const s = songs.find(x => x.coverArt);
  const res = await api.fetch('getCoverArt', { id: s.coverArt, size: 512 });
  assert.equal(res.status, 200);
  assert.ok(isImage(await bytes(res)));
});

test('the folder cover is the album’s, a song’s own embedded cover is the song’s',
  { skip: needs('album.folderCover', 'track.embeddedCoverOverFolder', 'track.embeddedCover') || (manifest.covers ? false : 'no cover hashes') }, async () => {
    const album = (await api.ok('getAlbum', { id: id('album.folderCover') })).album;
    assert.equal(sha(await bytes(await api.fetch('getCoverArt', { id: album.coverArt }))), manifest.covers.folder, 'album: cover.jpg');
    for (const key of ['track.embeddedCoverOverFolder', 'track.embeddedCover']) {
      const s = (await api.ok('getSong', { id: id(key) })).song;
      assert.equal(expected(key).cover, 'embedded');
      assert.equal(sha(await bytes(await api.fetch('getCoverArt', { id: s.coverArt }))), manifest.covers.embedded, `${key}: the embedded picture`);
    }
  });

test('stream answers the whole file, as long as the song’s size, with byte ranges allowed', async () => {
  const s = (await api.ok('getSong', { id: id('track.mp3') ?? (await getLibrary()).songs[0].id })).song;
  const res = await api.fetch('stream', { id: s.id });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^audio\//);
  assert.equal(res.headers.get('accept-ranges'), 'bytes');
  const body = await bytes(res);
  assert.equal(body.length, s.size, 'the file’s size');
  assert.equal(Number(res.headers.get('content-length')), s.size);
});

test('stream with Range answers 206 with the bytes asked for', async () => {
  const s = (await api.ok('getSong', { id: id('track.flac') ?? (await getLibrary()).songs[0].id })).song;
  const whole = await bytes(await api.fetch('stream', { id: s.id }));
  const cases = [['bytes=0-99', 0, 99], ['bytes=100-', 100, whole.length - 1], [`bytes=${whole.length - 10}-${whole.length + 1000}`, whole.length - 10, whole.length - 1]];
  await assertRanges(s.id, whole, cases);
});

test('stream with a suffix Range (bytes=-N) answers the last N bytes', async () => {
  const s = (await api.ok('getSong', { id: id('track.flac') ?? (await getLibrary()).songs[0].id })).song;
  const whole = await bytes(await api.fetch('stream', { id: s.id }));
  await assertRanges(s.id, whole, [['bytes=-50', whole.length - 50, whole.length - 1]]);
});

async function assertRanges(songId, whole, cases) {
  for (const [range, from, to] of cases) {
    const res = await api.fetch('stream', { id: songId }, { headers: { Range: range } });
    assert.equal(res.status, 206, range);
    assert.equal(res.headers.get('content-range'), `bytes ${from}-${to}/${whole.length}`, range);
    const part = await bytes(res);
    assert.equal(part.length, to - from + 1, range);
    assert.ok(part.equals(whole.subarray(from, to + 1)), `${range}: the same bytes as the whole file`);
  }
}

test('stream with a Range past the end answers 416', async () => {
  const s = (await getLibrary()).songs[0];
  const res = await api.fetch('stream', { id: s.id }, { headers: { Range: `bytes=${s.size + 10}-` } });
  assert.equal(res.status, 416);
  await res.arrayBuffer();
});

test('stream with format=raw answers the file as it is', async () => {
  const s = (await getLibrary()).songs[0];
  const raw = await bytes(await api.fetch('stream', { id: s.id, format: 'raw' }));
  const plain = await bytes(await api.fetch('stream', { id: s.id }));
  assert.ok(raw.equals(plain));
});

test('stream of an unknown id is error 70', async () => {
  const res = await api.fetch('stream', { id: 'no-such-song' });
  const body = JSON.parse(await res.text())['subsonic-response'];
  assert.equal(body.error?.code, 70);
});
