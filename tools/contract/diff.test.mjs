// The diff runner's own tests (no server): placeholders and `for`, paths, and that it reports what differs and only
// that. Usage: node --test tools/contract/diff.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compare, expand, matches } from './diff.mjs';

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
