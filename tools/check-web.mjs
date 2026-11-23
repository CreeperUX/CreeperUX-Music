// Acceptance run for Sonus. It starts the demo server (server/demo-server.mjs), signs in through the sign-in
// page, then: the interface acts and the server's own state is read back through the Subsonic API; playback is checked on
// the page's real <audio> element; every view is opened in five layouts (themes, densities, widths, 200 % zoom) and
// checked for console errors, page overflow and axe WCAG 2.1 A/AA; and 50 route changes must not grow the page.
// Usage: node tools/check.mjs [--only=chromium|webkit|edge] [--shots] [--server=https://music.example.com]
// --server runs READ-ONLY against a real server: MUSIC_USER and MUSIC_PASSWORD from the environment (use a separate
// test user); it reads the library, artwork, lyrics, search and artist info and runs axe, and plays nothing.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function load(name) {
  for (const dir of [root, process.env.KIT_DIR, resolve(root, '../CreeperUX UI Kit')].filter(Boolean)) { try { return createRequire(join(dir, 'package.json')).resolve(name); } catch { /* next */ } }
  throw new Error(`${name} not found: run npm install`);
}
const pw = await import(pathToFileURL(load('playwright')).href);
const { chromium, webkit } = pw.chromium ? pw : pw.default;
const AXE = load('axe-core/axe.min.js');
const only = process.argv.find(a => a.startsWith('--only='))?.slice(7), shots = process.argv.includes('--shots');
const real = process.argv.find(a => a.startsWith('--server='))?.slice(9)?.replace(/\/$/, '');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const md5 = s => createHash('md5').update(s).digest('hex');
const account = real ? { user: process.env.MUSIC_USER, password: process.env.MUSIC_PASSWORD } : { user: 'demo', password: 'demo' };
if (real && (!account.user || !account.password)) { console.error('Set MUSIC_USER and MUSIC_PASSWORD (a test user) to check a real server.'); process.exit(2); }

// the page is served by the demo server in both cases; against a real server only its static files are used
const port = 4600 + Math.floor(Math.random() * 300);
const demo = spawn(process.execPath, [join(root, 'server/demo-server.mjs'), String(port)], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((ok, fail) => { demo.stdout.on('data', d => { if (String(d).includes('demo server')) ok(); }); demo.on('exit', fail); });
const site = `http://127.0.0.1:${port}`, server = real ?? site;
const out = join(root, 'qa');
await mkdir(out, { recursive: true });

/** The Subsonic API, as another client would call it (to read back what the interface did). */
async function api(method, params = {}) {
  const salt = Math.random().toString(16).slice(2, 10);
  const q = new URLSearchParams({ u: account.user, t: md5(account.password + salt), s: salt, v: '1.16.1', c: 'check', f: 'json' });
  for (const [k, v] of Object.entries(params)) for (const x of [].concat(v)) q.append(k, String(x));
  const r = (await (await fetch(`${server}/rest/${method}.view?${q}`)).json())['subsonic-response'];
  if (r.status !== 'ok') throw new Error(`${method}: ${r.error?.message}`);
  return r;
}
const testLog = async () => (await fetch(`${site}/__test/log`)).json();
const setOffline = on => fetch(`${site}/__test/offline?on=${on ? 1 : 0}`);

const LAYOUTS = [
  { id: 'wide-dark-zh', w: 1440, h: 900, q: 'theme=dark&locale=zh-CN' },
  { id: 'wide-light-en', w: 1440, h: 900, q: 'theme=light&locale=en' },
  { id: 'laptop-touch', w: 1180, h: 760, q: 'theme=dark&density=touch&panel=queue' },
  { id: 'narrow', w: 700, h: 820, q: 'theme=dark&panel=closed' },
  { id: 'zoom-200', w: 720, h: 450, q: 'theme=light' },
];
const ROUTES = ['#/', '#/album/al0', '#/playlist/pl1', '#/playlist/liked', '#/playlist/library', '#/artist/ar5', '#/search/', '#/search/%E5%A4%9C', '#/genre/Jazz', '#/shelf/recent', '#/lyrics', '#/settings'];
const engines = [['chromium', () => chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] })], ['webkit', () => webkit.launch()], ['edge', () => chromium.launch({ channel: 'msedge', args: ['--autoplay-policy=no-user-gesture-required'] })]]
  .filter(([n]) => (only ? n === only : n !== 'edge'));
const settle = page => page.waitForFunction(() => document.getAnimations().every(a => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity), null, { timeout: 4000 }).catch(() => {});
let failed = 0;

for (const [engine, launch] of engines) {
  const browser = await launch();
  console.log(`\n${engine}${real ? ` (real server at ${real}, read-only)` : ' (demo server)'}`);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  const watch = p => {
    p.on('pageerror', e => errors.push(e.message));
    p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|status of 404/.test(m.text())) errors.push(m.text()); });
  };
  watch(page);
  const check = async (name, fn) => { const t0 = Date.now(); try { await fn(); console.log(`  ✓ ${name} (${Date.now() - t0} ms)`); } catch (e) { failed++; console.log(`  ✗ ${name}: ${e.message.split('\n')[0]}`); } };
  const assert = (ok, msg) => { if (!ok) throw new Error(msg); };
  const app = (fn, arg, p = page) => p.evaluate(fn, arg);
  const until = async (fn, what, ms = 6000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`); await sleep(100); } };
  const axe = async (p = page) => {
    if (!(await p.evaluate(() => !!window.axe))) await p.addScriptTag({ path: AXE });
    return p.evaluate(async () => (await axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] })).violations.map(x => `${x.id} (${x.nodes.length}): ${x.nodes[0].target}`));
  };
  const audio = (p = page) => app(() => { const a = __app.adapter.mediaElement(); return { paused: a.paused, time: a.currentTime, src: a.src, volume: a.volume }; }, undefined, p);
  const barTitle = (p = page) => p.locator('.ui-pb-title').textContent();
  async function signIn(p, password = account.password) {
    await p.getByLabel('服务器地址').fill(server);
    await p.getByLabel('用户名').fill(account.user);
    await p.getByLabel('密码', { exact: true }).fill(password);
    await p.getByRole('button', { name: '登录', exact: true }).click();
  }

  // ---------------------------------------------------------------- sign-in
  await page.goto(`${site}/?theme=dark#/`);
  await check('without a saved sign-in the sign-in page shows (0 axe violations)', async () => {
    await page.locator('.cm-login').waitFor({ timeout: 15000 });
    const v = await axe(); assert(!v.length, v.join(' | '));
    assert((await page.title()) === 'Sonus', await page.title());
  });
  await check('a wrong password is refused and says so; the right one signs in and loads the library', async () => {
    await signIn(page, `${account.password}-wrong`);
    await until(async () => (await page.locator('.cm-login-error').textContent()).includes('用户名或密码不正确'), 'error shown');
    await page.getByLabel('密码', { exact: true }).fill(account.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
    const s = await app(() => ({ tracks: __app.lib.trackList.length, albums: __app.lib.albumList.length, artists: __app.lib.artistList.length, pl: __app.playlists.map(p => p.kind), server: __app.server?.version }));
    assert(s.tracks > 0 && s.albums > 0 && s.pl[0] === 'liked' && s.pl[1] === 'library', JSON.stringify(s));
    if (!real) assert(s.tracks === 293 && s.albums === 34 && s.pl.length === 7, JSON.stringify(s));
    console.log(`    ${s.server}: ${s.tracks} songs, ${s.albums} albums, ${s.artists} artists, ${s.pl.length - 2} playlists`);
  });
  await check('the password is not kept (only the salt and token), and nothing says foobar2000', async () => {
    const login = await app(() => JSON.parse(localStorage.getItem('sonus.login') || 'null'));
    assert(login?.token?.length === 32 && login.salt && Object.keys(login).sort().join() === 'salt,server,token,user', JSON.stringify(Object.keys(login ?? {})));
    assert(!JSON.stringify({ ...await app(() => ({ ...localStorage })) }).includes(account.password === 'demo' ? '"demo"}' : account.password), 'password kept');
    for (const hash of ['#/', '#/settings']) { await app(h => { location.hash = h; }, hash); await sleep(600); assert(!/foobar|beefweb/i.test(await page.locator('body').innerText()), `${hash} mentions foobar2000`); }
  });
  await check('artwork comes from getCoverArt and loads', async () => {
    const u = await app(() => __app.lib.albumList.map(a => __app.adapter.artworkNow(a.id)).find(Boolean));
    assert(u?.includes('/rest/getCoverArt.view?'), u);
    assert(await app(async u => { const img = new Image(); img.src = u; await img.decode(); return img.naturalWidth; }, u) > 0, 'image did not decode');
  });
  await check('search goes to the server (search3)', async () => {
    const al = await app(() => __app.lib.albumList.find(a => a.title.length >= 2));
    const r = await app(q => __app.adapter.search(q), al.title);
    assert(r.albums.includes(al.id), `"${al.title}" not found`);
  });
  await check('lyrics: synced lines from getLyricsBySongId', async () => {
    if (real) {
      let found = null;
      for (const id of await app(() => __app.lib.trackList.slice(0, 30).map(t => t.id))) { const l = await app(id => __app.adapter.lyrics(id), id); if (l?.length) { found = l; break; } }
      console.log(`    ${found ? `${found.length} lines (${found[0].time != null ? 'synced' : 'plain'})` : 'none of the first 30 songs has lyrics'}`);
      return;
    }
    const id = await app(() => __app.lib.trackList.find(t => t.genre === 'City Pop').id);
    const lines = await app(id => __app.adapter.lyrics(id), id);
    assert(lines?.length > 5 && lines[0].time === 8 && lines[0].text, JSON.stringify(lines?.slice(0, 2)));
  });
  await check('an artist page shows the biography from getArtistInfo2', async () => {
    const id = await app(() => __app.lib.artistList[0].id);
    await app(id => { location.hash = `#/artist/${id}`; }, id);
    if (real) { await sleep(1500); console.log(`    ${(await page.locator('.cm-bio:not([hidden])').count()) ? 'has a biography' : 'no biography (Last.fm not set up?)'}`); return; }
    await until(() => page.locator('.cm-bio:not([hidden]) .cm-bio-text').count(), 'biography shown');
    assert(/演示数据/.test(await page.locator('.cm-bio-text').textContent()), 'text');
  });

  if (!real) {
    // ---------------------------------------------------------------- playback, against the demo server
    const album = await app(() => __app.lib.albumList.find(a => a.trackIds.length >= 4 && __app.lib.tracks.get(a.trackIds[0]).codec === 'FLAC' && a.trackIds.every(id => !__app.track(id).unavailable)));
    await check('double-click a track: the <audio> element plays its stream and the server shows it as now playing', async () => {
      await app(id => { location.hash = `#/album/${id}`; }, album.id); await sleep(800);
      await page.locator('.cm-view .ui-tracklist .ui-tr:not(.ui-tr-head)').nth(1).dblclick();
      const id = await app(a => __app.lib.albums.get(a).trackIds[1], album.id), want = await app(id => __app.track(id).title, id);
      await until(async () => { const a = await audio(); return !a.paused && a.time > 0.3 && a.src.includes(`id=${id}`); }, 'audio playing', 8000);
      await until(async () => (await barTitle()) === want, 'bar title');
      await until(async () => (await api('getNowPlaying')).nowPlaying.entry?.some(e => e.id === id), 'server now playing');
    });
    await check('the big Play button pauses the audio, and resumes it', async () => {
      await page.locator('.cm-actions .cm-play').click();
      await until(async () => (await audio()).paused && (await app(() => __app.player.state)) === 'paused', 'paused');
      await page.locator('.cm-actions .cm-play').click();
      await until(async () => !(await audio()).paused, 'playing again');
    });
    await check('seeking moves the audio, and the position follows', async () => {
      await app(() => __app.adapter.seek(30));
      await until(async () => Math.abs((await audio()).time - 30) < 1.5, 'audio at 30 s');
      await sleep(800);
      const [ui, el] = [await app(() => __app.player.position), (await audio()).time];
      assert(Math.abs(ui - el) < 0.6, `interface ${ui.toFixed(1)} s, audio ${el.toFixed(1)} s`);
    });
    await check('past half the song the play is counted once on the server, and in the interface', async () => {
      const id = await app(() => __app.player.trackId);
      const before = (await api('getSong', { id })).song.playCount, d = await app(() => __app.player.duration);
      const counted = async () => (await testLog()).scrobbles.filter(x => x.id === id && x.submission).length, already = await counted();
      await app(s => __app.adapter.seek(s), Math.min(d / 2 + 2, 245));
      await until(async () => (await api('getSong', { id })).song.playCount === before + 1, 'server count +1');
      await until(() => app(([id, n]) => __app.track(id).playCount === n, [id, before + 1]), 'interface count +1');
      await sleep(1000);
      assert((await counted()) === already + 1, 'counted more than once');
    });
    await check('the next song is loaded before this one ends, and plays when it does', async () => {
      const next = await app(a => { const ids = __app.lib.albums.get(a).trackIds; return ids[ids.indexOf(__app.player.trackId) + 1]; }, album.id);
      await app(s => __app.adapter.seek(s), (await app(() => __app.player.duration)) - 12);
      await until(async () => (await testLog()).streams.some(s => s.id === next), 'next stream requested early', 8000);
      await until(() => app(n => __app.player.trackId === n && __app.player.state === 'playing', next), 'next playing', 20000);
      assert(!(await audio()).paused, 'audio paused');
      await until(async () => (await barTitle()) === (await app(n => __app.track(n).title, next)), 'bar title');
    });
    await check('the queue is saved on the server for another device (savePlayQueue)', async () => {
      const id = await app(() => __app.player.trackId);
      await app(() => __app.adapter.pause());
      await until(async () => { const q = (await api('getPlayQueue')).playQueue; return q.current === id && /Sonus/.test(q.changedBy); }, 'server queue current');
    });
    await check('another device signs in and is offered to continue where this one stopped', async () => {
      const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 800 } }), p2 = await ctx2.newPage();
      watch(p2);
      const [id, pos] = await app(() => [__app.player.trackId, __app.player.position]);
      await p2.goto(`${site}/?theme=dark#/`);
      await p2.locator('.cm-login').waitFor();
      await signIn(p2);
      await p2.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
      await until(() => app(id => __app.player.trackId === id && __app.player.state === 'paused', id, p2), 'the other device shows the song, paused');
      assert(Math.abs((await app(() => __app.player.position, undefined, p2)) - pos) < 2, 'position');
      const toast = p2.locator('.ui-toast').filter({ hasText: '接着听' });
      await until(() => toast.count(), 'continue toast');
      await toast.getByRole('button', { name: '接着播放' }).click();
      await until(async () => { const a = await audio(p2); return !a.paused && Math.abs(a.time - pos) < 4; }, 'plays from the saved position', 8000);
      await app(() => __app.adapter.pause(), undefined, p2);
      await ctx2.close();
    });
    await check('start radio from a song: the song, then similar ones from getSimilarSongs2', async () => {
      const seed = await app(() => __app.lib.trackList.find(t => t.genre === 'City Pop' && !t.unavailable));
      await app(id => __app.onTrackMenu({ id: 'radio' }, [id]), seed.id);
      await until(() => app(id => __app.player.context?.kind === 'radio' && __app.player.trackId === id, seed.id), 'radio playing the seed');
      const ctxLabel = await app(() => __app.player.context.label), genres = await app(() => [...new Set(__app.queue.slice(0, 10).map(q => __app.track(q.trackId).genre))]);
      assert(ctxLabel.includes(seed.title) && ctxLabel.includes('电台'), ctxLabel);
      assert(genres.every(g => ['City Pop', 'J-Pop', 'Dream Pop'].includes(g)), genres.join());
      await app(() => __app.adapter.pause());
    });
    await check('shuffle and repeat in the bar set the playback order', async () => {
      await page.locator('.ui-pb-transport > .ui-media-toggle').first().click();
      await until(() => app(() => __app.player.order === 'shuffle-tracks'), 'shuffle');
      await page.locator('.ui-pb-transport > .ui-media-toggle').last().click();
      await until(() => app(() => __app.player.order === 'repeat-playlist'), 'repeat');
      await app(() => __app.adapter.setOrder('default'));
    });
    await check('a queued song plays next', async () => {
      const id = await app(() => __app.lib.trackList.find(t => t.codec === 'FLAC' && !t.unavailable && t.id !== __app.player.trackId).id);
      await app(id => __app.onTrackMenu({ id: 'next' }, [id]), id);
      await app(() => __app.panel.show('queue'));
      const title = await app(id => __app.track(id).title, id);
      await until(async () => (await page.locator('.cm-panel-queue .ui-tr:not(.ui-tr-head, .ui-tr-group) .ui-track-name').allTextContents()).includes(title), 'queue panel');
      await app(() => __app.adapter.next());
      await until(async () => { const a = await audio(); return !a.paused && a.src.includes(`id=${id}`); }, 'audio on it');
    });
    await check('replay gain lowers the volume by the song\'s gain', async () => {
      await app(() => __app.adapter.setVolume(1));
      await app(() => __app.adapter.setReplayGain('track'));
      const [g, v] = [await app(() => __app.currentTrack().replayGain.track), (await audio()).volume];
      assert(g != null && Math.abs(v - 10 ** (g / 20)) < 0.01, `gain ${g} dB, volume ${v}`);
      await app(() => __app.adapter.setReplayGain('album'));
    });
    await check('a DSD song is asked for as Opus (the browser cannot decode DSD)', async () => {
      const id = await app(() => __app.lib.trackList.find(t => t.codec.startsWith('DSD')).id);
      await app(id => __app.playContext('library', 'all', { trackId: id }), id);
      await until(async () => (await testLog()).streams.some(s => s.id === id && s.format === 'opus'), 'format=opus');
    });
    await check('a song the server cannot stream shows an error, not silence', async () => {
      const id = await app(() => __app.lib.trackList[57].id);
      await app(id => __app.playContext('library', 'all', { trackId: id }), id);
      await until(() => app(() => __app.player.state === 'error' && !!__app.player.error), 'error state');
      await until(() => page.locator('.ui-pb[data-state="error"]').count(), 'bar shows it');
    });
    await check('liking stars the song on the server; unliking unstars it', async () => {
      const id = await app(() => __app.lib.trackList.find(t => !t.liked).id);
      const starred = async () => ((await api('getStarred2')).starred2.song ?? []).some(s => s.id === id);
      await app(id => __app.setLiked(id, true), id);
      await until(starred, 'server starred');
      await until(() => app(id => __app.playlist('liked').trackIds[0] === id, id), 'first in Liked Songs');
      await app(id => __app.setLiked(id, false), id);
      await until(async () => !(await starred()), 'server unstarred');
    });
    await check('playlists: create, reorder, remove, rename and delete reach the server', async () => {
      const ids = await app(() => __app.lib.trackList.slice(10, 13).map(t => t.id)), [a, b, c] = ids;
      const p = await app(ids => __app.adapter.playlistCreate(`check ${Date.now()}`, ids), ids);
      const entries = async () => ((await api('getPlaylist', { id: p.id })).playlist.entry ?? []).map(e => e.id).join();
      assert(await entries() === ids.join(), 'created');
      await until(() => page.locator('.cm-lib .ui-mcard-title', { hasText: p.name }).count(), 'sidebar shows it');
      await app(([id, a, c]) => __app.adapter.playlistReorder(id, [], { keys: [a], before: c }), [p.id, a, c]);
      assert(await entries() === [b, a, c].join(), `reordered: ${await entries()}`);
      await app(([id, b]) => __app.adapter.playlistRemove(id, [b]), [p.id, b]);
      assert(await entries() === [a, c].join(), `removed: ${await entries()}`);
      await app(id => __app.adapter.playlistRename(id, 'check renamed'), p.id);
      assert((await api('getPlaylists')).playlists.playlist.some(x => x.id === p.id && x.name === 'check renamed'), 'renamed');
      await app(id => __app.adapter.playlistDelete(id), p.id);
      assert(!(await api('getPlaylists')).playlists.playlist.some(x => x.id === p.id), 'deleted');
      await until(async () => (await page.locator('.cm-lib .ui-mcard-title', { hasText: 'check renamed' }).count()) === 0, 'sidebar drops it');
    });
    await check('another user\'s playlist plays but cannot be changed', async () => {
      const p = await app(() => __app.playlists.find(x => x.name === '朋友的歌单'));
      assert(p.kind === 'auto' && p.owner === 'friend', `${p.kind} ${p.owner}`);
      const msg = await app(id => __app.adapter.playlistAdd(id, [__app.lib.trackList[0].id]).then(() => '', e => e.message), p.id);
      assert(msg.includes('只能播放'), msg);
    });
    await check('a playlist made on another device appears after a refresh', async () => {
      const made = (await api('createPlaylist', { name: `other device ${engine}`, songId: ['t1', 't2'] })).playlist;
      await app(() => __app.adapter.refresh());
      await until(() => page.locator('.cm-lib .ui-mcard-title', { hasText: `other device ${engine}` }).count(), 'sidebar shows it');
      await api('deletePlaylist', { id: made.id });
    });
    await check('losing the server shows offline; reconnecting brings it back', async () => {
      await setOffline(true);
      await app(() => __app.adapter.refresh());
      await until(async () => (await page.locator('.cm-conn').getAttribute('data-state')) === 'offline', 'badge offline');
      await setOffline(false);
      await page.locator('.cm-conn').click();
      await until(async () => (await page.locator('.cm-conn').getAttribute('data-state')) === 'online', 'badge online');
    });
    await check('eight rapid song changes end on the last one everywhere', async () => {
      const last = await app(async () => { const ids = __app.lib.trackList.filter(t => !t.unavailable).map(t => t.id); for (let i = 0; i < 8; i++) { __app.playContext('library', 'all', { trackId: ids[100 + i] }); await new Promise(r => setTimeout(r, 70)); } return ids[107]; });
      await until(async () => (await app(() => __app.player.trackId)) === last && (await barTitle()) === (await app(id => __app.track(id).title, last)), 'ended on the last', 6000);
      await until(async () => (await audio()).src.includes(`id=${last}`), 'audio on the last');
      await app(() => __app.adapter.pause());
    });
  }

  // ---------------------------------------------------------------- every view in five layouts
  const lp = await context.newPage();
  watch(lp);
  for (const L of LAYOUTS) {
    let bad = 0;
    await lp.setViewportSize({ width: L.w, height: L.h });
    await lp.goto(`${site}/?${L.q}#/`);
    await lp.waitForFunction(() => window.__ready === true, null, { timeout: 30000 });
    await sleep(400);
    if (!real) { await app(() => __app.playContext('album', 'al3', { trackId: __app.lib.albums.get('al3').trackIds[2] }), undefined, lp); await sleep(500); await app(() => __app.adapter.pause(), undefined, lp); }
    for (const hash of ROUTES.filter(h => !real || !/al0|pl1|ar5|Jazz/.test(h))) {
      await lp.evaluate(h => { location.hash = h; }, hash);
      await sleep(450); await settle(lp);
      const overflow = await lp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (overflow > 0) { bad++; failed++; console.log(`  ✗ ${L.id} ${hash}: page overflows by ${overflow}px`); }
      for (const v of await axe(lp)) { bad++; failed++; console.log(`  ✗ ${L.id} ${hash}: axe ${v}`); }
      if (shots) await lp.screenshot({ path: join(out, `${engine}-${L.id}-${hash.replace(/[#/%]+/g, '_') || 'home'}.png`) });
    }
    console.log(`  ${bad ? '✗' : '✓'} ${L.id}: ${ROUTES.length} views${bad ? `, ${bad} failures` : ''}`);
  }
  // 50 route changes leave no growing nodes or layers
  const count = () => lp.evaluate(() => ({ nodes: document.getElementsByTagName('*').length, layers: document.querySelectorAll('.ui-portal > *, [data-layer]').length }));
  const tour = async n => { for (let i = 0; i < n; i++) for (const h of ROUTES) { await lp.evaluate(x => { location.hash = x; }, h); await sleep(110); } await lp.evaluate(() => { location.hash = '#/'; }); await sleep(500); };
  await lp.setViewportSize({ width: 1280, height: 800 });
  await tour(2); const a = await count(); await tour(3); const b = await count();
  if (b.nodes > a.nodes * 1.05 || b.layers > a.layers) { failed++; console.log(`  ✗ teardown: nodes ${a.nodes} → ${b.nodes}, layers ${a.layers} → ${b.layers}`); }
  else console.log(`  ✓ teardown: nodes ${a.nodes} → ${b.nodes}, layers ${a.layers} → ${b.layers}`);
  await lp.close();

  await check('signing out forgets the sign-in and shows the sign-in page', async () => {
    await page.bringToFront();
    await app(() => { location.hash = '#/settings'; }); await sleep(700);
    await page.getByRole('button', { name: '退出登录' }).click();
    await page.locator('.cm-login').waitFor({ timeout: 10000 });
    assert(!(await app(() => localStorage.getItem('sonus.login'))), 'sign-in still kept');
  });
  for (const e of errors) { failed++; console.log(`  ✗ console: ${e}`); }
  await browser.close();
}
demo.kill();
console.log(failed ? `\n${failed} failures` : '\nall passed');
process.exit(failed ? 1 : 0);
