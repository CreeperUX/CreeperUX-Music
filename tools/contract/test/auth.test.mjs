// Signing in: token (t, s), password (p and p=enc:), OpenSubsonic API keys (errors 43, 44; tokenInfo), app passwords
// for a user with two-step verification, and the errors for a wrong password (40) and a missing parameter (10).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { as, api, me, manifest, needsUser, BASE, CLIENT } from '../lib/context.mjs';
import { Subsonic } from '../lib/subsonic.mjs';

const plain = (params, opts) => new Subsonic(BASE, {}, { client: CLIENT }).call('ping', params, opts);
const failsWith = async (promise, code) => {
  const { http, body } = await promise;
  assert.equal(http, 200, 'Subsonic errors come with HTTP 200');
  assert.equal(body.status, 'failed');
  assert.equal(body.error?.code, code, `error ${JSON.stringify(body.error)}`);
  assert.equal(typeof body.error.message, 'string');
};
const token = (password, salt = 'c0ffee42') => ({ t: createHash('md5').update(password + salt).digest('hex'), s: salt });

test('a token (t, s) signs in', async () => {
  assert.equal((await api.call('ping')).body.status, 'ok');
});

test('the password (p) signs in', async () => {
  assert.equal((await as(manifest.primaryUser, { as: 'password' }).call('ping')).body.status, 'ok');
});

test('the password hex-encoded (p=enc:) signs in', async () => {
  assert.equal((await as(manifest.primaryUser, { as: 'enc' }).call('ping')).body.status, 'ok');
});

test('a wrong password is error 40, as a token and as p', async () => {
  await failsWith(plain({ u: me.username, ...token('not the password') }), 40);
  await failsWith(plain({ u: me.username, p: 'not the password' }), 40);
});

test('an unknown user is error 40', async () => {
  await failsWith(plain({ u: 'nobody-by-this-name', p: 'x' }), 40);
});

test('no user at all is error 10 (a required parameter is missing)', async () => {
  await failsWith(plain({ p: me.password }), 10);
});

test('a user without a password or token is error 40 (Navidrome checks it as a wrong password)', async () => {
  await failsWith(plain({ u: me.username }), 40);
});

test('a missing parameter of a method is error 10', async () => {
  for (const method of ['getPlaylist', 'deletePlaylist', 'updatePlaylist', 'star', 'unstar', 'scrobble', 'getLyricsBySongId', 'getSimilarSongs2', 'getArtistInfo2']) {
    await failsWith(api.call(method, {}), 10);
  }
  const res = await api.fetch('stream', {});
  assert.equal(JSON.parse(await res.text())['subsonic-response'].error?.code, 10, 'stream');
});

test('getAlbum and getSong without an id answer 70 (not found), not 10', async () => {
  await failsWith(api.call('getAlbum', {}), 70);
  await failsWith(api.call('getSong', {}), 70);
});

test('an API key nobody has is error 44', async () => {
  await failsWith(plain({ apiKey: 'no-such-key-0000000000000000' }), 44);
});

// ---------------------------------------------------------------- the user with two-step verification

const secure = manifest.users?.secure;

test('an API key signs in, and tokenInfo says whose it is', { skip: needsUser('secure') }, async () => {
  const key = new Subsonic(BASE, { apiKey: secure.apiKey }, { client: CLIENT });
  assert.equal((await key.call('ping')).body.status, 'ok');
  assert.equal((await key.ok('tokenInfo')).tokenInfo.username, secure.username);
});

test('an API key with u (or a password, a token) is error 43', { skip: needsUser('secure') }, async () => {
  await failsWith(plain({ apiKey: secure.apiKey, u: secure.username }), 43);
  await failsWith(plain({ apiKey: secure.apiKey, p: 'x' }), 43);
  await failsWith(plain({ apiKey: secure.apiKey, ...token('x') }), 43);
});

test('with two-step verification the account password opens nothing (40)', { skip: needsUser('secure') }, async () => {
  await failsWith(plain({ u: secure.username, p: secure.password }), 40);
  await failsWith(plain({ u: secure.username, ...token(secure.password) }), 40);
  await failsWith(plain({ u: secure.username, p: `enc:${Buffer.from(secure.password).toString('hex')}` }), 40);
});

test('with two-step verification an app password signs in as p, enc: and a token', { skip: needsUser('secure') }, async () => {
  for (const how of ['password', 'enc', 'token']) {
    const r = await as('secure', { as: how, password: secure.appPassword }).call('ping');
    assert.equal(r.body.status, 'ok', `${how}: ${JSON.stringify(r.body.error)}`);
  }
});

test('an app password works with or without its dashes', { skip: needsUser('secure') }, async t => {
  if (!secure.appPassword.includes('-')) return t.skip('this app password has no dashes');
  const r = await as('secure', { as: 'password', password: secure.appPassword.replaceAll('-', '') }).call('ping');
  assert.equal(r.body.status, 'ok');
});

test('a wrong app password is error 40', { skip: needsUser('secure') }, async () => {
  await failsWith(plain({ u: secure.username, p: `${secure.appPassword}x` }), 40);
});
