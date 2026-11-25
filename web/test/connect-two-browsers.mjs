// Sonus Connect version 2 with two browsers against a real server: two Chromium profiles sign in to the web client as
// the same user (two devices), and the eight rules are checked as the user would see them. Made for the Rust server in
// front of the frozen Navidrome on the generated library (tools/fixtures, tools/contract/README.md), whose songs are a
// few seconds long: the round plays in "repeat one", so a song stays current while it is checked.
//
//   SONUS_TEST_SERVER=http://127.0.0.1:<port> SONUS_TEST_CREDENTIALS=<file> node web/test/connect-two-browsers.mjs
//
// The credentials file is tools/e2e/target.mjs's ({ "users": { "main": { "username", "password" } } }), a throwaway
// user whose password signs Subsonic calls. The page is served by a demo server started here (its static files only).
// Screenshots: qa/connect-two-*.png.
import { readFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { startDemoServer } from '../../tools/e2e/e2e.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const server = (process.env.SONUS_TEST_SERVER || '').replace(/\/$/, '');
if (!server || !process.env.SONUS_TEST_CREDENTIALS) { console.error('Set SONUS_TEST_SERVER and SONUS_TEST_CREDENTIALS.'); process.exit(2); }
const user = JSON.parse(readFileSync(process.env.SONUS_TEST_CREDENTIALS, 'utf8')).users.main;
function playwright() {
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root }).toString().trim();
  for (const dir of [root, resolve(common, '..')]) { try { return createRequire(join(dir, 'package.json')).resolve('playwright'); } catch { /* next */ } }
  throw new Error('Playwright not found: npm install');
}
const pw = await import(pathToFileURL(playwright()).href);
const { chromium } = pw.chromium ? pw : pw.default;
const out = join(root, 'qa'); mkdirSync(out, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pages = await startDemoServer();
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
let failed = 0;
const errors = [];
const check = async (name, fn) => { const t0 = Date.now(); try { await fn(); console.log(`  ✓ ${name} (${Date.now() - t0} ms)`); } catch (e) { failed++; console.log(`  ✗ ${name}: ${e.message.split('\n')[0]}`); } };
const assert = (ok, msg) => { if (!ok) throw new Error(msg); };
const until = async (fn, what, ms = 8000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`); await sleep(100); } };
const app = (p, fn, arg) => p.evaluate(fn, arg);
const audio = p => app(p, () => { const a = __app.adapter.mediaElement(); return { paused: a.paused, src: a.src, time: a.currentTime }; });
const silent = async p => { const a = await audio(p); return a.paused || !a.src; };

async function open(name) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } }), p = await ctx.newPage();
  p.on('pageerror', e => errors.push(`${name}: ${e.message}`));
  p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`${name}: ${m.text()}`); });
  await p.goto(`${pages.url}/?theme=dark#/`);
  await p.getByLabel('服务器地址').fill(server);
  await p.getByLabel('用户名').fill(user.username);
  await p.getByLabel('密码', { exact: true }).fill(user.password);
  await p.getByRole('button', { name: '登录', exact: true }).click();
  await p.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
  return { ctx, p };
}

console.log(`Sonus Connect, two browsers, against ${server}`);
const A = await open('A');
const a = A.p;
let B = null, b = null, album = null;
await check('the server offers version 2 and the client uses it', async () => {
  assert(await app(a, () => __app.adapter.connected?.() === true), 'the client does not speak Connect 2 here');
  await until(() => app(a, () => __app.adapter.devices().some(d => d.self && d.connected)), 'connected to the session');
});
await check('A plays an album (repeat one); B signs in and shows it playing on A, silent', async () => {
  album = await app(a, () => __app.lib.albumList.find(x => x.trackIds.length >= 3 && x.trackIds.every(id => ['mp3', 'flac', 'ogg', 'opus', 'm4a'].includes(__app.track(id).suffix))));
  assert(album, 'no album of three songs this browser plays');
  await app(a, () => __app.adapter.setOrder('repeat-track'));
  await app(a, id => __app.playContext('album', id), album.id);
  await until(async () => { const x = await audio(a); return !x.paused && x.time > 0; }, 'A plays');
  B = await open('B'); b = B.p;
  const id = await app(a, () => __app.player.trackId);
  await until(() => app(b, id => __app.player.trackId === id && __app.player.state === 'playing' && __app.player.where?.playing === true, id), 'B shows the song, playing elsewhere');
  assert(await silent(b), 'B plays audio');
  await until(async () => /正在「.+」上播放/.test(await b.locator('.cm-bar-where').textContent()), 'B\'s strip');
  assert(await app(b, () => __app.player.order === 'repeat-track'), 'B shows the order');
  await b.screenshot({ path: join(out, 'connect-two-b-elsewhere.png') });
});
await check('B steers A: next, pause, play; one queue', async () => {
  const before = await app(a, () => __app.player.trackId);
  await app(b, () => __app.adapter.next());
  await until(async () => { const id = await app(a, () => __app.player.trackId), x = await audio(a); return id !== before && !x.paused && x.src.includes(`id=${id}`); }, 'A plays the next song');
  await until(async () => (await app(b, () => __app.player.trackId)) === (await app(a, () => __app.player.trackId)), 'B shows it');
  await app(b, () => __app.adapter.pause());
  await until(async () => (await audio(a)).paused, 'A paused');
  await until(() => app(b, () => __app.player.state === 'paused'), 'B shows paused');
  const q = album.trackIds[0];
  await app(b, id => __app.adapter.queueAdd([id], { next: true }), q);
  await until(() => app(a, id => __app.queue[0]?.trackId === id && __app.queue[0].section === 'queue', q), 'queued on B, listed on A');
  await app(b, () => __app.adapter.queueClear('queue'));
  await until(() => app(a, () => !__app.queue.some(e => e.section === 'queue')), 'cleared on B, gone on A');
  await app(b, () => __app.adapter.resume());
  await until(async () => !(await audio(a)).paused, 'A plays again');
  assert(await silent(b), 'B plays audio');
});
await check('B\'s device picker moves playback to B; A stops and shows where it plays', async () => {
  const id = await app(a, () => __app.player.trackId);
  await b.locator('.cm-bar .cm-output .ui-device-button').click();
  await b.screenshot({ path: join(out, 'connect-two-b-picker.png') });
  await b.getByRole('radio', { name: /这个浏览器/ }).click();
  await until(async () => { const x = await audio(b); return !x.paused && x.src.includes(`id=${id}`); }, 'B plays the song');
  await until(() => silent(a), 'A stops');
  await until(() => app(a, () => __app.player.where?.playing === true && __app.player.state === 'playing'), 'A shows it playing on B');
  await b.keyboard.press('Escape');
  await a.screenshot({ path: join(out, 'connect-two-a-elsewhere.png') });
});
await check('volume is per device: A\'s bar sets B\'s volume, not its own', async () => {
  const mine = await app(a, () => __app.adapter.devices().find(d => d.self).volume);
  await app(a, () => __app.adapter.setVolume(0.3));
  await until(() => app(b, () => Math.abs(__app.player.volume - 0.3) < 0.01), 'B at 30 %');
  await until(() => app(a, () => Math.abs(__app.adapter.devices().find(d => !d.self && d.active)?.volume - 0.3) < 0.01), 'A lists B at 30 %');
  assert(Math.abs((await app(a, () => __app.adapter.devices().find(d => d.self).volume)) - mine) < 0.01, 'A\'s own volume changed');
  await app(b, () => __app.adapter.setVolume(1));
});
await check('B goes away (a goodbye): the session stops at once where it was; play on A continues it on A', async () => {
  const id = await app(b, () => __app.player.trackId);
  await b.goto('about:blank');
  await B.ctx.close(); B = null;
  await until(() => app(a, () => __app.player.state === 'paused' && __app.player.where?.playing === false), 'A shows it stopped, played last on B', 4000);
  await until(async () => /上次在「.+」播放/.test(await a.locator('.cm-bar-where').textContent()), 'A\'s strip');
  await a.locator('.cm-bar .ui-pb-play').click();
  await until(async () => { const x = await audio(a); return !x.paused && x.src.includes(`id=${id}`); }, 'A plays it');
  await app(a, () => __app.adapter.pause());
  await app(a, () => __app.adapter.setOrder('default'));
});
await check('no errors in either page\'s console', async () => { assert(!errors.length, errors.slice(0, 3).join(' | ')); });

await browser.close();
await pages.stop?.();
console.log(failed ? `\n${failed} failures` : '\nall passed');
process.exit(failed ? 1 : 0);
