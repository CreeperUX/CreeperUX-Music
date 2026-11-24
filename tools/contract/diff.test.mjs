// The diff runner's own tests (no server): placeholders and `for`, paths, and that it reports what differs and only
// that. Usage: node --test tools/contract/diff.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compare, expand, matches, mustBeAnsweredByRust, EXPECTED } from './diff.mjs';

test('paths: * is one key or index, ** any number', () => {
  assert.ok(matches(['a', 'b', 0, 'c'], 'a.b.*.c'));
  assert.ok(!matches(['a', 'b', 0, 'd'], 'a.b.*.c'));
  assert.ok(matches(['json', 'x', 'artist', 3, 'roles'], 'json.**.artist.*.roles'));
  assert.ok(matches(['json', 'artist', 3, 'roles'], 'json.**.artist.*.roles'));
  assert.ok(!matches(['json', 'artist', 'roles'], 'json.**.artist.*.roles'));
});

test('key order does not matter; values, missing keys and array lengths do', () => {
  assert.deepEqual(compare({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 }, []), []);
  assert.deepEqual(compare({ a: 1 }, { a: 2 }, []), [{ path: 'a', a: 1, b: 2 }]);
  assert.deepEqual(compare({ a: 1 }, {}, []), [{ path: 'a', a: 1, b: undefined }]);
  assert.deepEqual(compare({ l: [1, 2] }, { l: [1] }, []), [{ path: 'l.1', a: 2, b: undefined }]);
  assert.deepEqual(compare({ n: 1 }, { n: '1' }, []), [{ path: 'n', a: 1, b: '1' }]);
  assert.deepEqual(compare({ n: null }, { n: {} }, []), [{ path: 'n', a: null, b: {} }]);
});

test('volatile paths are left out, present or missing', () => {
  const v = ['r.serverVersion', 'r.list.*.changed'];
  assert.deepEqual(compare({ r: { serverVersion: '1', list: [{ changed: 'x', id: 1 }] } }, { r: { serverVersion: '2', list: [{ id: 1 }] } }, v), []);
  assert.equal(compare({ r: { list: [{ changed: 'x', id: 1 }] } }, { r: { list: [{ changed: 'x', id: 2 }] } }, v).length, 1);
});

test('unordered arrays are compared sorted, other arrays in order', () => {
  const u = ['**.roles'];
  assert.deepEqual(compare({ x: { roles: ['a', 'b'] } }, { x: { roles: ['b', 'a'] } }, [], [], [], u), []);
  assert.equal(compare({ x: { other: ['a', 'b'] } }, { x: { other: ['b', 'a'] } }, [], [], [], u).length, 2);
});

test('for: one request per key, {{$}} replaced, {{{{$}}}} becoming a placeholder', () => {
  const r = expand({ requests: [{ name: 'getSong', method: 'getSong', params: { id: '{{{{$}}}}' }, for: ['track.a', 'track.b'] }, { name: 'ping', method: 'ping' }] });
  assert.deepEqual(r.map(x => x.name), ['getSong track.a', 'getSong track.b', 'ping']);
  assert.equal(r[1].params.id, '{{track.b}}');
  assert.equal(r[0].for, undefined);
});

test('an expected difference is applied to A, and everything else still has to be the same', () => {
  const answer = versions => ({ status: 200, json: { 'subsonic-response': { status: 'ok', openSubsonicExtensions: [{ name: 'formPost', versions: [1] }, { name: 'sonusConnect', versions }] } } });
  const go = answer([1]), rust = answer([1, 2]);
  assert.equal(compare(go, rust, []).length, 1, 'without it, the lists differ');
  EXPECTED.connectVersion2.apply(go);
  assert.deepEqual(compare(go, rust, []), []);
  // only that: another extension's versions, or a version 3, still show
  const other = answer([1, 2]);
  other.json['subsonic-response'].openSubsonicExtensions[0].versions = [1, 2];
  assert.equal(compare(go, other, []).length, 1);
  assert.equal(compare(go, answer([1, 2, 3]), []).length, 1);
  // answers without the list are left as they are
  const error = { status: 200, json: { 'subsonic-response': { status: 'failed', error: { code: 40 } } } };
  EXPECTED.connectVersion2.apply(error);
  assert.deepEqual(error.json['subsonic-response'], { status: 'failed', error: { code: 40 } });
  EXPECTED.connectVersion2.apply({ status: 200, sha256: 'x' });
});

test('who must answer: the Rust server for the methods it has taken over, in JSON, past the sign-in', () => {
  const ok = { json: { 'subsonic-response': { status: 'ok' } } };
  const failed = (code, message) => ({ json: { 'subsonic-response': { status: 'failed', error: { code, message } } } });
  assert.ok(mustBeAnsweredByRust({ method: 'getSong', params: { id: 'x' } }, ok));
  assert.ok(mustBeAnsweredByRust({ method: 'getSong.view' }, failed(70, 'Song not found')));
  assert.ok(mustBeAnsweredByRust({ method: 'getAlbumList2' }, failed(10, "missing parameter: 'type'")), 'the method’s own error');
  assert.ok(mustBeAnsweredByRust({ method: 'ping', params: { f: 'json' } }, ok));
  // not taken over, not JSON, refused at the sign-in, or marked as Navidrome's
  assert.ok(!mustBeAnsweredByRust({ method: 'getArtists' }, ok));
  assert.ok(!mustBeAnsweredByRust({ method: 'ping', params: { f: null } }, { status: 200, sha256: 'x' }));
  assert.ok(!mustBeAnsweredByRust({ method: 'ping', params: { f: 'jsonp', callback: 'cb' } }, { status: 200, sha256: 'x' }));
  assert.ok(!mustBeAnsweredByRust({ method: 'ping' }, failed(40, 'Wrong username or password')));
  assert.ok(!mustBeAnsweredByRust({ method: 'ping' }, failed(10, "missing parameter: 'v'")));
  assert.ok(!mustBeAnsweredByRust({ method: 'ping' }, failed(44, 'Invalid API key')));
  assert.ok(!mustBeAnsweredByRust({ method: 'getAlbumList2', navidrome: 'musicFolderId' }, ok));
  assert.ok(!mustBeAnsweredByRust({ path: '/auth/login' }, { status: 401 }));
});
