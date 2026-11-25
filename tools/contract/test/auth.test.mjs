// Signing in: token (t, s), password (p and p=enc:), OpenSubsonic API keys (errors 43, 44; tokenInfo), app passwords
// for a user with two-step verification, and the errors for a wrong password (40) and a missing parameter (10), mixed
// credentials included.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { as, api, me, secret, manifest, needsUser, BASE, CLIENT } from '../lib/context.mjs';
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

test('required two-step verification, not set up yet: the account password signs the API on the fork only', { skip: me.appPassword && manifest.server?.twoFactor === 'required' ? false : 'no user without two-step verification on a server that requires it' }, async () => {
  // The Rust server takes no account password on the API where two-step verification is required, set up or not
  // (the user signs in on the web, sets it up, and uses app passwords); the frozen Navidrome took it until the
  // set-up. Which server this is, the web sign-in says: only the Rust server asks for enrolment codes.
  const web = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: me.username, password: me.password }) });
  const answer = await web.json();
  assert.deepEqual([web.status, answer.twoFactor], [401, 'setup'], 'the web sign-in still leads to the set-up');
  const forms = [{ p: me.password }, { p: `enc:${Buffer.from(me.password).toString('hex')}` }, token(me.password)];
  for (const form of forms) {
    const r = await plain({ u: me.username, ...form });
    if (answer.enrolmentCodeRequired === true) {
      assert.equal(r.body.error?.code, 40, Object.keys(form).join());
      assert.deepEqual(r.body.error, (await plain({ u: me.username, p: 'not the password' })).body.error, 'answered as a wrong password is');
    } else assert.equal(r.body.status, 'ok', Object.keys(form).join());
  }
});

test('a wrong password is error 40, as a token and as p', async () => {
  await failsWith(plain({ u: me.username, ...token('not the password') }), 40);
  await failsWith(plain({ u: me.username, p: 'not the password' }), 40);
});

test('an unknown user is error 40', async () => {
  await failsWith(plain({ u: 'nobody-by-this-name', p: 'x' }), 40);
});

test('no user at all is error 10 (a required parameter is missing)', async () => {
  await failsWith(plain({ p: secret }), 10);
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

test('the user name signs in in any case', async () => {
  const shout = new Subsonic(BASE, { u: me.username.toUpperCase(), password: secret, as: 'password' }, { client: CLIENT });
  assert.equal((await shout.call('ping')).body.status, 'ok');
});

test('p=enc: that is not hex is a wrong password (40)', async () => {
  await failsWith(plain({ u: me.username, p: 'enc:zz' }), 40);
});

test('with p and t both sent, p is the one checked', async () => {
  const r = await plain({ u: me.username, p: secret, ...token('not the password') });
  assert.equal(r.body.status, 'ok', JSON.stringify(r.body.error));
  await failsWith(plain({ u: me.username, p: 'not the password', ...token(secret) }), 40);
});

test('without v or c the answer is error 10, whatever the password', async () => {
  const bare = (params) => fetch(`${BASE}/rest/ping?${new URLSearchParams({ f: 'json', ...params })}`).then(r => r.json()).then(j => j['subsonic-response']);
  for (const [params, missing] of [
    [{ u: me.username, p: secret, c: CLIENT }, 'v'],
    [{ u: me.username, p: secret, v: '1.16.1' }, 'c'],
    [{ u: me.username, p: 'not the password', c: CLIENT }, 'v'],
  ]) {
    const body = await bare(params);
    assert.equal(body.error?.code, 10, `${missing}: ${JSON.stringify(body.error)}`);
    assert.match(body.error.message, new RegExp(`'${missing}'`), 'the message names the parameter');
  }
});

test('a refused sign-in can be read by a page on another origin (CORS)', async () => {
  const res = await fetch(`${BASE}/rest/ping?${new URLSearchParams({ u: me.username, p: 'not the password', v: '1.16.1', c: CLIENT, f: 'json' })}`, { headers: { Origin: 'https://sonus.example' } });
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.equal((await res.json())['subsonic-response'].error?.code, 40);
});

test('tokenInfo answers a password sign-in too, with the user’s name', async () => {
  assert.equal((await api.ok('tokenInfo')).tokenInfo.username, me.username);
});

test('tokenInfo with an unknown API key is error 44', async () => {
  await failsWith(new Subsonic(BASE, { apiKey: 'no-such-key-0000000000000000' }, { client: CLIENT }).call('tokenInfo'), 44);
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

test('mixed credentials are error 43 before any of them is checked', { skip: needsUser('secure') }, async () => {
  // a key nobody has, beside a right password: still 43, not 44 and not a sign-in
  await failsWith(plain({ apiKey: 'no-such-key-0000000000000000', u: me.username, p: secret }), 43);
  await failsWith(plain({ apiKey: secure.apiKey, u: secure.username, p: secure.appPassword }), 43);
  await failsWith(plain({ apiKey: secure.apiKey, s: 'c0ffee42' }), 43);
});

test('an app password is an API key too', { skip: needsUser('secure') }, async () => {
  const key = new Subsonic(BASE, { apiKey: secure.appPassword }, { client: CLIENT });
  assert.equal((await key.ok('tokenInfo')).tokenInfo.username, secure.username);
  const undashed = new Subsonic(BASE, { apiKey: secure.appPassword.replaceAll('-', '').toUpperCase() }, { client: CLIENT });
  assert.equal((await undashed.call('ping')).body.status, 'ok', 'without dashes, in capitals');
});

test('the account password is not an API key (44)', { skip: needsUser('secure') }, async () => {
  await failsWith(plain({ apiKey: secure.password }), 44);
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
