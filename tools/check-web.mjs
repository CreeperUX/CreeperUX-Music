// Acceptance run for Sonus. It starts the demo server (tools/demo-server/demo-server.mjs), signs in through the sign-in
// page, then: the interface acts and the server's own state is read back through the Subsonic API; playback is checked on
// the page's real <audio> element; the library pages, the phone layout (tabs, mini player, Now playing), the keyboard and
// the system's media controls; covers from another origin; the browser sign-in against the demo server, and two-step
// verification, the account pages and the approval page against a stand-in for the Sonus server's /auth routes; every
// view is opened in seven layouts (themes, densities, widths from a phone up, 200 % zoom) and checked for console
// errors, page overflow and axe WCAG 2.1 A/AA; and 50 route changes must not grow the page.
// Usage: node tools/check-web.mjs [--only=chromium|webkit|edge] [--shots] [--grep=words] [--server=https://music.example.com]
// --grep (while working on one thing): after the sign-in, only the checks whose name matches the pattern, and no layouts.
// Any test server: SONUS_TEST_SERVER, SONUS_TEST_CREDENTIALS and SONUS_TEST_MANIFEST (tools/e2e/target.mjs, README.md):
// every check runs, through the recording proxy, with that server's library; one its library cannot give is skipped.
// --server runs READ-ONLY against a real server: MUSIC_USER and MUSIC_PASSWORD from the environment (use a separate
// test user); it reads the library, artwork, lyrics, search and artist info and runs axe, and plays nothing.
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { startDemoServer } from './e2e/e2e.mjs';
import { startTarget } from './e2e/target.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function load(name) {
  for (const dir of [root, process.env.KIT_DIR, resolve(root, '../CreeperUX UI Kit')].filter(Boolean)) { try { return createRequire(join(dir, 'package.json')).resolve(name); } catch { /* next */ } }
  throw new Error(`${name} not found: run npm install`);
}
const pw = await import(pathToFileURL(load('playwright')).href);
const { chromium, webkit } = pw.chromium ? pw : pw.default;
const AXE = load('axe-core/axe.min.js');
const only = process.argv.find(a => a.startsWith('--only='))?.slice(7), shots = process.argv.includes('--shots');
const grep = (g => (g ? new RegExp(g, 'i') : null))(process.argv.find(a => a.startsWith('--grep='))?.slice(7));
const real = process.argv.find(a => a.startsWith('--server='))?.slice(9)?.replace(/\/$/, '');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const md5 = s => createHash('md5').update(s).digest('hex');
if (real && (!process.env.MUSIC_USER || !process.env.MUSIC_PASSWORD)) { console.error('Set MUSIC_USER and MUSIC_PASSWORD (a test user) to check a real server.'); process.exit(2); }
// the server: read-only (--server), or the target of the tests (the demo server, or SONUS_TEST_SERVER behind the
// recording proxy, tools/e2e/target.mjs) with what the checks take from its library
const target = real ? null : await startTarget();
const cat = target ? await target.catalogue() : null;
const demo = target?.demo ?? false;
const account = real ? { user: process.env.MUSIC_USER, password: process.env.MUSIC_PASSWORD } : { user: target.user.username, password: target.user.password };
// the page is served by a demo server in every case; against another server only its static files are used
const pages = demo ? null : await startDemoServer();
const site = demo ? target.url : pages.url, server = real ?? target.url;
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
const testLog = () => target.log();      // the demo server's hook, or the recording proxy's
const setOffline = on => target.offline(on);

const LAYOUTS = [
  { id: 'wide-dark-zh', w: 1440, h: 900, q: 'theme=dark&locale=zh-CN' },
  { id: 'wide-light-en', w: 1440, h: 900, q: 'theme=light&locale=en' },
  { id: 'laptop-touch', w: 1180, h: 760, q: 'theme=dark&density=touch&panel=queue' },
  { id: 'narrow', w: 700, h: 820, q: 'theme=dark&panel=closed' },
  { id: 'zoom-200', w: 720, h: 450, q: 'theme=light' },
  { id: 'phone-dark', w: 390, h: 844, q: 'theme=dark' },
  { id: 'phone-light', w: 390, h: 844, q: 'theme=light' },
];
const e = encodeURIComponent;
// the library as pages, Now playing as a page, and the account pages (closed: they show their password form)
const PAGES = ['#/library/playlists', '#/library/albums', '#/library/artists', '#/library/songs', '#/now', '#/account', '#/device'];
// the demo's al0, pl1, ar5, 夜 and Jazz; another server's own
const ROUTES = cat ? ['#/', `#/album/${cat.browse.id}`, `#/playlist/${cat.ownPlaylist.id}`, '#/playlist/liked', '#/playlist/library', `#/artist/${cat.artist.id}`, '#/search/', `#/search/${e(cat.search.term)}`, ...(cat.genre ? [`#/genre/${e(cat.genre)}`] : []), '#/shelf/recent', '#/lyrics', '#/settings', ...PAGES]
  : ['#/', '#/album/al0', '#/playlist/pl1', '#/playlist/liked', '#/playlist/library', '#/artist/ar5', '#/search/', '#/search/%E5%A4%9C', '#/genre/Jazz', '#/shelf/recent', '#/lyrics', '#/settings', ...PAGES];
const engines = [['chromium', () => chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] })], ['webkit', () => webkit.launch()], ['edge', () => chromium.launch({ channel: 'msedge', args: ['--autoplay-policy=no-user-gesture-required'] })]]
  .filter(([n]) => (only ? n === only : n !== 'edge'));
const settle = page => page.waitForFunction(() => document.getAnimations().every(a => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity), null, { timeout: 4000 }).catch(() => {});
let failed = 0, skipped = 0;

for (const [engine, launch] of engines) {
  const browser = await launch();
  console.log(`\n${engine}${real ? ` (real server at ${real}, read-only)` : demo ? ' (demo server)' : ` (${target.origin}, through the recording proxy)`}`);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  const watch = p => {
    p.on('pageerror', e => errors.push(e.message));
    p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|status of 404/.test(m.text())) errors.push(m.text()); });
  };
  watch(page);
  const check = async (name, fn) => { if (grep && !/sign-in page shows|wrong password is refused/.test(name) && !grep.test(name)) return; const t0 = Date.now(); try { await fn(); console.log(`  ✓ ${name} (${Date.now() - t0} ms)`); } catch (e) { failed++; console.log(`  ✗ ${name}: ${e.message.split('\n')[0]}`); } };
  /** A check this server's library cannot give the data for (never against the demo server). */
  const skip = (name, reason) => { skipped++; console.log(`  – ${name}: skipped (${reason})`); };
  const assert = (ok, msg) => { if (!ok) throw new Error(msg); };
  const app = (fn, arg, p = page) => p.evaluate(fn, arg);
  const until = async (fn, what, ms = 6000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`); await sleep(100); } };
  const axe = async (p = page) => {
    if (!(await p.evaluate(() => !!window.axe))) await p.addScriptTag({ path: AXE });
    return p.evaluate(async () => (await axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] })).violations.map(x => `${x.id} (${x.nodes.length}): ${x.nodes[0].target}`));
  };
  /** With --shots: a picture of a state the layouts below do not reach (a step of the sign-in, an open account page). */
  const snap = async (p, name) => { if (shots) { await settle(p); await p.screenshot({ path: join(out, `${engine}-state-${name}.png`) }); } };
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
    if (cat) assert(s.tracks === cat.counts.songs && s.albums === cat.counts.albums && s.pl.length === cat.counts.playlists + 2, JSON.stringify({ ...s, server: cat.counts })); // the demo's: 293, 34, 5
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
    if (!demo) {
      // the song the server has synced lyrics for: its first line, when the server says
      if (!cat.lyrics) { console.log('    no song with synced lyrics on this server (manifest key track.syncedLyrics)'); return; }
      const lines = await app(id => __app.adapter.lyrics(id), cat.lyrics.id);
      assert(lines?.length >= 3 && Math.abs(lines[0].time - cat.lyrics.firstTime) < 0.01, JSON.stringify(lines?.slice(0, 2)));
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
    if (!demo) {
      // shown when the server has one (the text without its HTML), not shown when it has none
      const bio = String((await api('getArtistInfo2', { id }).catch(() => null))?.artistInfo2?.biography ?? '').replace(/<[^>]+>/g, '').trim();
      if (bio) await until(() => page.locator('.cm-bio:not([hidden]) .cm-bio-text').count(), 'biography shown');
      else { await sleep(1500); assert(!(await page.locator('.cm-bio:not([hidden]) .cm-bio-text').count()), 'a biography the server does not have'); }
      console.log(`    ${bio ? 'the server has a biography: shown' : 'the server has no biography: none shown'}`);
      return;
    }
    await until(() => page.locator('.cm-bio:not([hidden]) .cm-bio-text').count(), 'biography shown');
    assert(/演示数据/.test(await page.locator('.cm-bio-text').textContent()), 'text');
  });

  if (!real) {
    // ---------------------------------------------------------------- playback, against the demo server or a test server
    // an album of four songs or more that stream (the demo's first such FLAC album; another server's album.playable)
    const album = demo ? await app(() => __app.lib.albumList.find(a => a.trackIds.length >= 4 && __app.lib.tracks.get(a.trackIds[0]).codec === 'FLAC' && a.trackIds.every(id => !__app.track(id).unavailable)))
      : { id: cat.playable.id };

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
      const before = (await api('getSong', { id })).song.playCount ?? 0, d = await app(() => __app.player.duration); // left out when 0 (Navidrome)
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
    // Sonus Connect version 2 (docs/protocol/connect.md): on a server that offers it the queue and what plays are the
    // user's one session, shown by every browser and played by one; without it, the queue is saved for another device
    const v2 = await app(() => __app.adapter.connected?.() === true);
    console.log(`    Sonus Connect version 2: ${v2 ? 'offered, the session is on the server' : 'not offered, the queue is this browser\'s own'}`);
    if (!v2) {
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
    } else {
      // two browsers signed in as the same user are two devices (each its own id in its own storage)
      let ctx2 = null, p2 = null;
      const silent = async (p = page) => { const a = await audio(p); return a.paused || !a.src; };
      const playable = () => app(([demo, missing]) => __app.lib.trackList.find(t => (demo ? t.codec === 'FLAC' : !/^DSD/.test(t.codec ?? '') && t.id !== missing) && !t.unavailable && t.id !== __app.player.trackId).id, [demo, cat?.missing ?? '']);
      await check('Sonus Connect: another browser shows what plays here, where, and the position moving; it stays silent', async () => {
        ctx2 = await browser.newContext({ viewport: { width: 1280, height: 800 } }); p2 = await ctx2.newPage();
        watch(p2);
        if (!(await app(() => __app.player.trackId))) await app(id => __app.playContext('album', id), album.id); // run alone (--grep)
        else if ((await audio()).paused) await app(() => __app.adapter.resume());
        await until(async () => !(await audio()).paused, 'playing here', 8000);
        const id = await app(() => __app.player.trackId);
        await p2.goto(`${site}/?theme=dark#/`);
        await p2.locator('.cm-login').waitFor();
        await signIn(p2);
        await p2.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
        await until(() => app(id => __app.player.trackId === id && __app.player.state === 'playing' && __app.player.where?.playing === true, id, p2), 'the other browser shows the song, playing elsewhere');
        const a = await app(() => __app.player.position, undefined, p2); await sleep(1500);
        const [b, here] = [await app(() => __app.player.position, undefined, p2), await app(() => __app.player.position)];
        assert(b - a > 0.8, `the position moves there: ${a.toFixed(1)} → ${b.toFixed(1)} s`);
        assert(Math.abs(b - here) < 2, `the same position: ${b.toFixed(1)} s there, ${here.toFixed(1)} s here`);
        assert(await silent(p2), 'the other browser plays audio too');
        await until(async () => /正在「.+」上播放/.test(await p2.locator('.cm-bar-where').textContent()) && p2.locator('.cm-bar-where').isVisible(), 'its strip says where it plays');
        assert(await page.locator('.cm-bar-where').isHidden(), 'the playing browser shows a strip about itself');
        await snap(p2, 'connect-elsewhere');
        // at phone width: the mini player's third line, and Now playing with the device picker
        await p2.setViewportSize({ width: 390, height: 844 });
        await until(async () => /正在「.+」上播放/.test(await p2.locator('.cm-mini-where').textContent()) && p2.locator('.cm-mini-where').isVisible(), 'the mini player says where it plays');
        await snap(p2, 'connect-phone-mini');
        await app(() => { location.hash = '#/now'; }, undefined, p2);
        await until(() => p2.locator('.cm-now .cm-now-devices .ui-device-button').isVisible(), 'Now playing has the device picker');
        await until(() => p2.locator('.cm-now-where').isVisible(), 'and says where it plays');
        await snap(p2, 'connect-phone-now');
        await app(() => { location.hash = '#/'; }, undefined, p2);
        await p2.setViewportSize({ width: 1280, height: 800 });
      });
      await check('Sonus Connect: the other browser\'s controls steer this one: next, pause, one queue, play', async () => {
        const before = await app(() => __app.player.trackId);
        await app(() => __app.adapter.next(), undefined, p2);
        await until(async () => { const id = await app(() => __app.player.trackId), a = await audio(); return id !== before && !a.paused && a.src.includes(`id=${id}`); }, 'this browser plays the next song');
        const now = await app(() => __app.player.trackId);
        await until(() => app(id => __app.player.trackId === id, now, p2), 'the other shows it');
        assert(await silent(p2), 'the other browser plays audio');
        await app(() => __app.adapter.pause(), undefined, p2);
        await until(async () => (await audio()).paused && (await app(() => __app.player.state)) === 'paused', 'paused here');
        await until(() => app(() => __app.player.state === 'paused', undefined, p2), 'paused there');
        const q = await playable();
        await app(id => __app.adapter.queueAdd([id], { next: true }), q, p2);
        await until(() => app(id => __app.queue[0]?.trackId === id && __app.queue[0].section === 'queue', q), 'queued there, listed here');
        await app(() => __app.adapter.resume(), undefined, p2);
        await until(async () => !(await audio()).paused, 'plays here again');
        assert(await silent(p2), 'the other browser plays audio');
        await app(() => __app.adapter.queueClear('queue'), undefined, p2); // songs queued by hand outlive a new context
        await until(() => app(() => !__app.queue.some(e => e.section === 'queue')), 'cleared there, gone here');
      });
      await check('Sonus Connect: the device picker moves playback; the browser it leaves stops and shows where it plays', async () => {
        const pos = await app(() => __app.player.position);
        await p2.locator('.cm-bar .cm-output .ui-device-button').click();
        await snap(p2, 'connect-picker');
        await p2.getByRole('radio', { name: /这个浏览器/ }).click();
        await until(async () => { const a = await audio(p2); return !a.paused && a.time > 0; }, 'plays in the other browser', 8000);
        await until(() => silent(page), 'this browser stops');
        const t2 = (await audio(p2)).time;
        assert(Math.abs(t2 - pos) < 4, `from where it was: ${pos.toFixed(1)} s → ${t2.toFixed(1)} s`);
        await until(() => app(() => __app.player.where?.playing === true && __app.player.state === 'playing'), 'this browser shows it playing there');
        await p2.keyboard.press('Escape');
      });
      await check('Sonus Connect: each device has its own volume; the bar sets the playing device\'s', async () => {
        const mine = await app(() => __app.adapter.devices().find(d => d.self).volume);
        await app(() => __app.adapter.setVolume(0.3)); // the other browser plays: this sets its volume
        await until(() => app(() => Math.abs(__app.player.volume - 0.3) < 0.01, undefined, p2), 'the playing browser at 30 %');
        await until(() => app(() => Math.abs(__app.player.volume - 0.3) < 0.01), 'this bar shows the playing browser\'s volume');
        assert(Math.abs((await app(() => __app.adapter.devices().find(d => d.self).volume)) - mine) < 0.01, 'this browser\'s own volume changed');
        await app(() => __app.adapter.setVolume(1), undefined, p2);
      });
      await check('Sonus Connect: the playing browser goes away; the session stops where it was, and play here continues it', async () => {
        const id = await app(() => __app.player.trackId, undefined, p2);
        await p2.goto('about:blank'); // the page says goodbye (WebSocket close 1000): no grace period
        await ctx2.close(); p2 = null;
        await until(() => app(() => __app.player.state === 'paused' && __app.player.where?.playing === false), 'stopped, saying where it played last');
        await until(async () => /上次在「.+」播放/.test(await page.locator('.cm-bar-where').textContent()), 'the strip');
        const pos = await app(() => __app.player.position);
        await page.locator('.cm-bar .ui-pb-play').click();
        await until(async () => { const a = await audio(); return !a.paused && a.src.includes(`id=${id}`) && Math.abs(a.time - pos) < 4; }, 'plays here, from where it stopped', 8000);
      });
    }
    await check('start radio from a song: the song, then similar ones from getSimilarSongs2', async () => {
      const seed = demo ? await app(() => __app.lib.trackList.find(t => t.genre === 'City Pop' && !t.unavailable)) : await app(id => __app.track(id), cat.radio.id);
      await app(id => __app.onTrackMenu({ id: 'radio' }, [id]), seed.id);
      await until(() => app(id => __app.player.context?.kind === 'radio' && __app.player.trackId === id, seed.id), 'radio playing the seed');
      const ctxLabel = await app(() => __app.player.context.label), genres = await app(() => [...new Set(__app.queue.slice(0, 10).map(q => __app.track(q.trackId).genre))]);
      assert(ctxLabel.includes(seed.title) && ctxLabel.includes('电台'), ctxLabel);
      if (demo) assert(genres.every(g => ['City Pop', 'J-Pop', 'Dream Pop'].includes(g)), genres.join());
      else {
        // after the seed: the songs the server answered, in its order (what the recording proxy saw: a server may pick
        // them at random each time); with none, songs of the same artist or genre from the library
        const answer = (await testLog()).similar.filter(x => x.id === seed.id).at(-1)?.songs?.filter(id => id !== seed.id);
        const queue = await app(() => __app.queue.filter(q => q.section === 'context').map(q => q.trackId)); // after the seed
        assert(answer, 'no getSimilarSongs2 answer seen');
        assert(queue.length >= 1 && !queue.includes(seed.id) && new Set(queue).size === queue.length, JSON.stringify(queue.slice(0, 5)));
        if (answer.length) assert(JSON.stringify(queue) === JSON.stringify(answer), `the radio is not the server's answer: ${JSON.stringify(queue.slice(0, 3))} vs ${JSON.stringify(answer.slice(0, 3))}`);
        console.log(`    the server gave ${answer.length} similar songs${answer.length ? '' : ' (the radio takes the same artist or genre)'}; the radio has ${queue.length + 1}`);
      }
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
      // a song the browser plays as it is: on the demo server a FLAC one; elsewhere any but DSD and the missing one
      const id = await app(([demo, missing]) => __app.lib.trackList.find(t => (demo ? t.codec === 'FLAC' : !/^DSD/.test(t.codec ?? '') && t.id !== missing) && !t.unavailable && t.id !== __app.player.trackId).id, [demo, cat.missing ?? '']);
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
    const dsdId = await app(() => __app.lib.trackList.find(t => t.codec?.startsWith('DSD'))?.id ?? null);
    if (!dsdId && !demo) skip('a DSD song is asked for as Opus (the browser cannot decode DSD)', 'no DSD song on this server');
    else await check('a DSD song is asked for as Opus (the browser cannot decode DSD)', async () => {
      const id = await app(() => __app.lib.trackList.find(t => t.codec.startsWith('DSD')).id);
      await app(id => __app.playContext('library', 'all', { trackId: id }), id);
      await until(async () => (await testLog()).streams.some(s => s.id === id && s.format === 'opus'), 'format=opus');
    });
    if (!demo && !cat.missing) skip('a song the server cannot stream shows an error, not silence', 'no song whose file is gone (manifest key track.missingFile)');
    else if (v2) await check('a song that cannot play is skipped: the session moves on, and a toast names it', async () => {
      const id = demo ? await app(() => __app.lib.trackList[57].id) : cat.missing;
      await app(id => __app.playContext('library', 'all', { trackId: id }), id);
      await until(() => page.locator('.ui-toast').filter({ hasText: '无法播放' }).count(), 'the toast');
      await until(() => app(id => !!__app.player.trackId && __app.player.trackId !== id, id), 'on to the next song');
    });
    else await check('a song the server cannot stream shows an error, not silence', async () => {
      const id = demo ? await app(() => __app.lib.trackList[57].id) : cat.missing;
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
      const ids = await app(() => __app.lib.trackList.slice(__app.lib.trackList.length >= 13 ? 10 : 0).slice(0, 3).map(t => t.id)), [a, b, c] = ids;
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
    if (!cat.othersPlaylist) skip('another user\'s playlist plays but cannot be changed', 'no other user\'s public playlist on this server, and no second test user (users.other)');
    else await check('another user\'s playlist plays but cannot be changed', async () => {
      const p = await app(id => __app.playlists.find(x => x.id === id), cat.othersPlaylist.id); // the demo's 朋友的歌单, friend's
      assert(p.name === cat.othersPlaylist.name && p.kind === 'auto' && p.owner === cat.othersPlaylist.owner, `${p.name} ${p.kind} ${p.owner}`);
      const msg = await app(id => __app.adapter.playlistAdd(id, [__app.lib.trackList[0].id]).then(() => '', e => e.message), p.id);
      assert(msg.includes('只能播放'), msg);
    });
    await check('a playlist made on another device appears after a refresh', async () => {
      const made = (await api('createPlaylist', { name: `other device ${engine}`, songId: cat.songIds.slice(0, 2) })).playlist;
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
      const last = await app(async missing => { const ids = __app.lib.trackList.filter(t => !t.unavailable && t.id !== missing).map(t => t.id), from = Math.max(0, Math.min(100, ids.length - 8)); for (let i = 0; i < 8; i++) { __app.playContext('library', 'all', { trackId: ids[from + i] }); await new Promise(r => setTimeout(r, 70)); } return ids[from + 7]; }, demo ? null : cat.missing);
      await until(async () => (await app(() => __app.player.trackId)) === last && (await barTitle()) === (await app(id => __app.track(id).title, last)), 'ended on the last', 6000);
      await until(async () => (await audio()).src.includes(`id=${last}`), 'audio on the last');
      await app(() => __app.adapter.pause());
    });

    // ---------------------------------------------------------------- the library pages, the keyboard, the system's media controls
    await check('the library pages list playlists, albums, artists and songs; a song there plays within the library', async () => {
      for (const [kind, name, n] of [['playlists', '歌单', await app(() => __app.playlists.length)], ['albums', '专辑', await app(() => __app.lib.albumList.length)], ['artists', '艺人', await app(() => __app.lib.artistList.length)]]) {
        await app(k => { location.hash = `#/library/${k}`; }, kind);
        await until(async () => (await page.locator('.cm-libpage .ui-mcard').count()) > 0 && (await page.locator('.cm-libpage .cm-chip[aria-pressed="true"]').allTextContents()).join() === name, `${kind} listed`); // the page of this kind, not the one before it
        assert((await page.locator('.cm-libpage .ui-mcard').count()) <= n, `${kind}: more cards than the library has`);
      }
      await app(() => { location.hash = '#/library/songs'; });
      // the first song of the library the server can stream
      const at = await app(missing => __app.playlist('library').trackIds.findIndex(id => !__app.track(id).unavailable && id !== missing), cat.missing ?? '');
      await page.locator('.cm-libpage .ui-tracklist .ui-tr:not(.ui-tr-head)').nth(at).dblclick();
      await until(() => app(i => __app.player.context?.kind === 'playlist' && __app.player.context?.id === 'library' && __app.player.trackId === __app.playlist('library').trackIds[i], at), 'plays that song, in the library');
      await until(async () => !(await audio()).paused, 'audio playing');
    });
    await check('the system media controls show the song and its state; Space pauses and resumes', async () => {
      const ms = () => app(() => ({ title: navigator.mediaSession?.metadata?.title, state: navigator.mediaSession?.playbackState, want: __app.currentTrack().title, has: 'mediaSession' in navigator }));
      const m = await ms();
      if (!m.has) { console.log('    this engine has no Media Session API'); return; }
      await until(async () => { const x = await ms(); return x.title === x.want && x.state === 'playing'; }, 'media session shows the playing song');
      await app(() => document.activeElement?.blur?.());
      await page.keyboard.press('Space');
      await until(async () => (await audio()).paused && (await ms()).state === 'paused', 'Space pauses');
      await page.keyboard.press('Space');
      await until(async () => !(await audio()).paused, 'Space resumes');
      await app(() => __app.adapter.pause());
    });

    // ---------------------------------------------------------------- a phone: tabs and a mini player in place of the bar
    await check('at phone width tabs and a mini player replace the bar; the mini player opens Now playing, which controls playback', async () => {
      const pp = await context.newPage();
      watch(pp);
      await pp.setViewportSize({ width: 390, height: 844 });
      await pp.goto(`${site}/?theme=dark#/`);
      await pp.waitForFunction(() => window.__ready === true, null, { timeout: 30000 });
      assert(await pp.locator('.cm-tabs').isVisible() && !(await pp.locator('.cm-bar').isVisible()), 'the tabs show and the playback bar does not');
      await app(al => __app.playContext('album', al), album.id, pp);
      await until(async () => !(await audio(pp)).paused, 'playing', 8000);
      const first = await app(() => __app.player.trackId, undefined, pp);
      assert((await pp.locator('.cm-mini-title').textContent()) === (await app(() => __app.currentTrack().title, undefined, pp)), 'the mini player names the song');
      await pp.locator('.cm-mini-play').click();
      await until(async () => (await audio(pp)).paused, 'paused from the mini player');
      await pp.locator('.cm-mini-open').click();
      await pp.locator('.cm-now-stage').waitFor();
      assert(!(await pp.locator('.cm-mini').isVisible()), 'no mini player under Now playing');
      assert((await pp.locator('.cm-now-title').textContent()) === (await app(() => __app.currentTrack().title, undefined, pp)), 'Now playing names the song');
      await pp.locator('.cm-now-play').click();
      await until(async () => !(await audio(pp)).paused, 'playing from Now playing');
      await pp.getByRole('button', { name: '下一首', exact: true }).click();
      await until(() => app(id => __app.player.trackId !== id, first, pp), 'next song');
      await pp.locator('.cm-now-toggle').first().click();
      await until(() => app(() => __app.player.order === 'shuffle-tracks', undefined, pp), 'shuffle from Now playing');
      await app(() => __app.adapter.setOrder('default'), undefined, pp);
      await pp.locator('.cm-now-like').click();
      await until(() => app(() => __app.currentTrack().liked === true, undefined, pp), 'liked from Now playing');
      await pp.locator('.cm-now-like').click();
      await until(() => app(() => __app.currentTrack().liked === false, undefined, pp), 'unliked');
      await snap(pp, 'phone-now-playing');
      await pp.getByRole('button', { name: '播放队列' }).click();
      await until(() => pp.locator('.cm-panel-queue .ui-tr').count(), 'the queue opens');
      await snap(pp, 'phone-queue');
      await pp.keyboard.press('Escape');
      await pp.locator('.cm-tabs').getByRole('link', { name: '音乐库' }).click();
      await until(async () => (await pp.evaluate(() => location.hash)).startsWith('#/library') && (await pp.locator('.cm-tab[aria-current]').textContent()) === '音乐库', 'the Library tab');
      await pp.locator('.cm-tabs').getByRole('link', { name: '搜索' }).click();
      await until(async () => (await pp.evaluate(() => location.hash)) === '#/search/', 'the Search tab');
      await app(() => __app.adapter.pause(), undefined, pp);
      await pp.close();
    });

    // ---------------------------------------------------------------- covers from another origin
    await check('the page and the server on different origins: headers take the cover\'s colour, and nothing is logged', async () => {
      const other = demo ? await startDemoServer() : null; // a second demo server gives only the page; the first one stays the music server
      const cx = await browser.newContext({ viewport: { width: 1280, height: 800 } }), p = await cx.newPage();
      watch(p);
      try {
        await p.goto(`${other?.url ?? site}/?theme=dark#/`);
        await p.locator('.cm-login').waitFor();
        await signIn(p);
        await p.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
        await app(id => { location.hash = `#/album/${id}`; }, album.id, p);
        await until(() => p.evaluate(() => { const v = document.querySelector('.cm-view')?.style.getPropertyValue('--cm-tint'); return !!v && v !== '#3a4148'; }), 'the album page is tinted from its cover');
        await sleep(500);
      } finally { await cx.close(); other?.stop(); }
    });

    // ---------------------------------------------------------------- a deployment that fixes the server (web/config.js)
    if (site !== server) skip('config.js with server "same-origin": the sign-in page does not ask for the address', 'the page is not served by the music server in this run');
    else await check('config.js with server "same-origin": the sign-in page does not ask for the address, and signs in to the server that serves it', async () => {
      const cx = await browser.newContext({ viewport: { width: 1280, height: 800 } }), p = await cx.newPage();
      watch(p);
      await p.route(u => u.pathname === '/config.js', route => route.fulfill({ contentType: 'text/javascript', body: 'window.SONUS_CONFIG = { server: "same-origin", base: "" };' }));
      await p.goto(`${site}/?theme=dark#/`);
      await p.locator('.cm-login').waitFor();
      assert(!(await p.getByLabel('服务器地址').count()), 'the address is asked for');
      const v = await axe(p); assert(!v.length, v.join(' | '));
      await p.getByLabel('用户名').fill(account.user);
      await p.getByLabel('密码', { exact: true }).fill(account.password);
      await p.getByRole('button', { name: '登录', exact: true }).click();
      await p.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
      assert((await app(() => __app.adapter.account().server, undefined, p)) === server, 'signed in to another server');
      await cx.close();
    });

    // ---------------------------------------------------------------- signing in through the browser, two-step verification, the account pages
    if (!demo) skip('the browser sign-in, two-step verification and the account pages', 'they need the demo server\'s sign-in hook and a stand-in for /auth');
    else {
      const hook = async (q = '') => (await fetch(`${server}/__test/device${q}`)).json();
      const fresh = async (init) => { const cx = await browser.newContext({ viewport: { width: 1280, height: 800 } }); if (init) await cx.addInitScript(init, server); const p = await cx.newPage(); watch(p); return { cx, p }; };
      const startBrowserSignIn = async p => {
        await p.goto(`${site}/?theme=dark#/`);
        await p.locator('.cm-login').waitFor();
        await p.getByLabel('服务器地址').fill(server);
        await p.getByRole('button', { name: '在浏览器中登录' }).click();
        await p.locator('.cm-code').waitFor();
        return (await p.locator('.cm-code').textContent()).trim();
      };
      await check('sign in through the browser: the page shows a code; allowed, it gets a key of its own and no password; signing out gives the key back', async () => {
        const { cx, p } = await fresh();
        const code = await startBrowserSignIn(p);
        assert(/^[A-Z]{4}-[A-Z]{4}$/.test(code), code);
        assert((await p.locator('a.cm-linkbtn').getAttribute('href')) === `${server}/app/#/device?code=${code}`, 'the link to the approval page');
        const v = await axe(p); assert(!v.length, v.join(' | '));
        await snap(p, 'sign-in-browser');
        await hook(`?code=${code}&decide=allow&u=${account.user}`);
        await p.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
        const login = await app(() => JSON.parse(localStorage.getItem('sonus.login')), undefined, p);
        assert(login.apiKey && !login.token && !login.salt && login.user === account.user, JSON.stringify(Object.keys(login)));
        const art = await app(() => __app.lib.albumList.map(a => __app.adapter.artworkNow(a.id)).find(Boolean), undefined, p);
        assert(art.includes('apiKey=') && !/[?&](u|t|s|p)=/.test(art), 'requests carry the key, and no user name or token');
        const named = k => k.name.startsWith('Sonus · 浏览器');
        assert((await hook()).keys.filter(named).length === 1, 'the server made one key for this browser');
        await app(() => { location.hash = '#/settings'; }, undefined, p); await sleep(600);
        await p.getByRole('button', { name: '退出登录' }).click();
        await p.locator('.cm-login').waitFor({ timeout: 10000 });
        await until(async () => (await hook()).keys.filter(named).length === 0, 'the key is given back');
        await cx.close();
      });
      await check('a browser sign-in that is refused says so, and the sign-in page is back', async () => {
        const { cx, p } = await fresh();
        const code = await startBrowserSignIn(p);
        await hook(`?code=${code}&decide=deny`);
        await until(async () => (await p.locator('.cm-login-error').count()) && (await p.locator('.cm-login-error').textContent()).includes('被拒绝'), 'refused shown', 8000);
        assert(await p.getByLabel('用户名').isVisible(), 'the password form is back');
        await cx.close();
      });

      // A stand-in for the Sonus server's /auth routes, written from the Rust server's handlers (server/src/auth, which
      // ask for more than the fork's did: an enrolment code at a first set-up, a verification code to make an app
      // password or allow an app, an app password made with the sign-in that asks for one): the demo server has only
      // the app's half of the browser sign-in. The account
      // has two-step verification; its account password opens the web session only, and the app password the stand-in
      // hands out is the demo account's own password, so the Subsonic sign-in that follows is the demo server's real one.
      const ACCOUNT_PW = 'account-password-2fa', CODE = '246810', JWT = 'stand-in.jwt', SETUP = 'stand-in.setup', ENROL = 'abcd-efgh-jkmn';
      const codes = n => Array.from({ length: 10 }, (_, i) => `rc${n}-${String(i).padStart(4, '0')}`);
      const standIn = async (p, st) => {
        Object.assign(st, { enabled: true, mode: 'optional', recovery: codes(0), apps: [], n: 0, made: 0, ...st });
        await p.route(u => u.href.startsWith(`${server}/auth/`), async route => {
          const req = route.request(), path = new URL(req.url()).pathname.slice('/auth'.length), m = req.method();
          if (/^\/device\/(start|poll|revoke)$/.test(path)) return route.fallback(); // the demo server's own
          const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' };
          const json = (status, data) => route.fulfill({ status, headers: cors, contentType: 'application/json', body: data === undefined ? '' : JSON.stringify(data) });
          if (m === 'OPTIONS') return json(204);
          let body = {}; try { body = req.postDataJSON() ?? {}; } catch { /* none */ }
          const session = req.headers()['x-nd-authorization'] === `Bearer ${JWT}`, payload = { id: 'u1', name: account.user, username: account.user, isAdmin: false, token: JWT };
          const codeOk = c => c === CODE || (st.recovery.includes(c) && st.recovery.splice(st.recovery.indexOf(c), 1));
          // what a session alone does not do, for an account with two-step verification: null when the code is good
          const ownCode = () => (!st.enabled || codeOk(body.code) ? null : json(401, { error: body.code ? 'Invalid verification code' : 'Verification code required', twoFactor: 'code' }));
          const makeApp = name => { const ap = { id: `ap${++st.made}`, name: name || 'App', createdAt: new Date().toISOString() }; st.apps.push(ap); return { appPassword: ap, password: account.password }; };
          const withApp = answer => (typeof body.appPassword === 'string' ? { ...answer, newAppPassword: makeApp(body.appPassword) } : answer);
          // a first set-up where two-step verification is required: the enrolment code, null when it is good
          const enrolment = () => (st.enabled || st.mode !== 'required' || body.enrolmentCode === ENROL ? null
            : json(401, { error: body.enrolmentCode ? 'Invalid enrolment code' : 'Enrolment code required', twoFactor: 'enrolment' }));
          if (path === '/login' && m === 'POST') {
            if (body.username !== account.user || body.password !== ACCOUNT_PW) return json(401, { error: 'Invalid username or password' });
            if (st.enabled && !body.otp) return json(401, { error: 'Verification code required', twoFactor: 'code' });
            if (st.enabled && !codeOk(body.otp)) return json(401, { error: 'Invalid verification code', twoFactor: 'code' });
            if (!st.enabled && st.mode === 'required') return json(401, { error: 'Two-step verification must be set up', twoFactor: 'setup', setupToken: SETUP, enrolmentCodeRequired: true });
            return json(200, withApp(payload));
          }
          if (path === '/2fa/setup' && m === 'POST') return body.token !== SETUP && !session ? json(401, { error: 'Not authenticated' }) : enrolment() ?? json(200, { secret: 'JBSWY3DPEHPK3PXP', uri: 'otpauth://totp/Sonus:demo?secret=JBSWY3DPEHPK3PXP', qr: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', issuer: 'Sonus', account: account.user });
          if (path === '/2fa/confirm' && m === 'POST') {
            if (body.token !== SETUP && !session) return json(401, { error: 'Not authenticated' });
            const refused = enrolment(); if (refused) return refused;
            if (body.code !== CODE) return json(401, { error: 'Invalid verification code', twoFactor: 'setup' });
            st.enabled = true; st.recovery = codes(++st.n);
            return json(200, { ...withApp(payload), recoveryCodes: st.recovery });
          }
          if (!session) return json(401, { error: 'Not authenticated' });
          if (path === '/2fa' && m === 'GET') return json(200, { mode: st.mode, enabled: st.enabled, ...(st.enabled ? { enabledAt: new Date(Date.now() - 3 * 86400e3).toISOString() } : {}), recoveryCodesLeft: st.enabled ? st.recovery.length : 0 });
          if (path === '/2fa/recovery-codes' && m === 'POST') { if (!codeOk(body.code)) return json(401, { error: 'Invalid verification code', twoFactor: 'code' }); st.recovery = codes(++st.n); return json(200, { recoveryCodes: st.recovery }); }
          if (path === '/2fa/disable' && m === 'POST') { if (st.mode === 'required') return json(403, { error: 'Two-step verification is required on this server' }); if (!codeOk(body.code)) return json(401, { error: 'Invalid verification code', twoFactor: 'code' }); st.enabled = false; return json(204); }
          if (path === '/app-passwords' && m === 'GET') return json(200, st.apps);
          if (path === '/app-passwords' && m === 'POST') return ownCode() ?? json(200, makeApp(body.name));
          if (path.startsWith('/app-passwords/') && m === 'DELETE') { const i = st.apps.findIndex(a => a.id === decodeURIComponent(path.slice(15))); if (i < 0) return json(404, { error: 'No such app password' }); st.apps.splice(i, 1); return json(204); }
          const dev = /^\/device\/([^/]+)(\/approve|\/deny)?$/.exec(path);
          if (dev) {
            const code = decodeURIComponent(dev[1]), waiting = (await hook()).pending.find(x => x.userCode === code && x.status === 'pending');
            if (!waiting) return json(404, { error: 'No sign-in waiting for this code: it may have expired' });
            if (!dev[2]) return json(200, { userCode: waiting.userCode, client: waiting.client, device: waiting.device, address: '203.0.113.7', expiresIn: 540, codeRequired: st.enabled });
            if (dev[2] === '/approve') { const refused = ownCode(); if (refused) return refused; }
            await hook(`?code=${code}&decide=${dev[2] === '/approve' ? 'allow' : 'deny'}&u=${account.user}`);
            return json(204);
          }
          return json(404, { error: 'not found' });
        });
      };

      const st = {};
      const { cx: cx2, p: p2 } = await fresh();
      await standIn(p2, st);
      await check('two-step verification: the password alone is refused for the API; password and one code make this browser an app password, kept as a token', async () => {
        await p2.goto(`${site}/?theme=dark#/`);
        await p2.locator('.cm-login').waitFor();
        await signIn(p2, ACCOUNT_PW);
        await p2.getByRole('heading', { name: '两步验证' }).waitFor({ timeout: 10000 });
        const v = await axe(p2); assert(!v.length, v.join(' | '));
        await snap(p2, 'sign-in-code');
        await p2.getByLabel('验证码').fill('000000');
        await p2.getByRole('button', { name: '验证', exact: true }).click();
        await until(async () => (await p2.locator('.cm-login-error:not([hidden])').count()) && (await p2.locator('.cm-login-error:not([hidden])').textContent()).includes('验证码不正确'), 'a wrong code says so');
        await p2.getByLabel('验证码').fill(CODE);
        await p2.getByRole('button', { name: '验证', exact: true }).click();
        await p2.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
        const kept = await app(() => ({ ...localStorage }), undefined, p2), login = JSON.parse(kept['sonus.login']);
        assert(Object.keys(login).sort().join() === 'salt,server,token,user' && login.token.length === 32, JSON.stringify(Object.keys(login)));
        assert(!JSON.stringify(kept).includes(ACCOUNT_PW) && !JSON.stringify(kept).includes(CODE) && !JSON.stringify(kept).includes(JWT), 'the account password, the code or the session is kept');
        assert(st.apps.length === 1 && /^Sonus \(浏览器 /.test(st.apps[0].name), `app passwords: ${JSON.stringify(st.apps.map(a => a.name))}`);
      });
      await check('account and security: the password and a code open it; app passwords are made, shown once and revoked; recovery codes are replaced', async () => {
        await app(() => { location.hash = '#/settings'; }, undefined, p2);
        await p2.getByRole('link', { name: '账号与安全' }).click();
        await p2.getByRole('heading', { name: '确认是你' }).waitFor();
        await p2.getByLabel('密码', { exact: true }).fill(ACCOUNT_PW);
        await p2.getByRole('button', { name: '继续', exact: true }).click();
        await p2.getByLabel('验证码').fill(CODE);
        await p2.getByRole('button', { name: '继续', exact: true }).click();
        await p2.getByRole('heading', { name: '应用专用密码' }).waitFor();
        await until(async () => (await p2.locator('.cm-state[data-on]').count()) === 1, 'two-step verification shown as on');
        assert((await p2.locator('.cm-app-row').count()) === 1, 'this browser\'s app password is listed');
        const v = await axe(p2); assert(!v.length, v.join(' | '));
        await p2.getByLabel('名称').fill('客厅的播放器');
        await p2.getByRole('button', { name: '创建', exact: true }).click();
        // the session alone makes none: the page asks for a code, a wrong one is refused
        await p2.locator('.cm-app-form').getByLabel('验证码').waitFor();
        assert(st.apps.length === 1, 'an app password was made without a code');
        const withField = await axe(p2); assert(!withField.length, withField.join(' | '));
        await p2.locator('.cm-app-form').getByLabel('验证码').fill('000000');
        await p2.getByRole('button', { name: '创建', exact: true }).click();
        await until(async () => (await p2.locator('.cm-made .cm-login-error').count()) && (await p2.locator('.cm-made .cm-login-error').textContent()).includes('验证码不正确'), 'a wrong code says so');
        assert(st.apps.length === 1, 'an app password was made with a wrong code');
        await p2.locator('.cm-app-form').getByLabel('验证码').fill(CODE);
        await p2.getByRole('button', { name: '创建', exact: true }).click();
        await until(async () => (await p2.locator('.cm-made .cm-secret').count()) && (await p2.locator('.cm-app-row').count()) === 2, 'the new password is shown, and listed');
        assert(!(await p2.locator('.cm-app-form').getByLabel('验证码').count()), 'the code field goes once it was used');
        assert(st.apps[1]?.name === '客厅的播放器', JSON.stringify(st.apps));
        await snap(p2, 'account');
        await p2.getByRole('button', { name: '撤销 客厅的播放器' }).click();
        await p2.getByRole('alertdialog').getByRole('button', { name: '撤销', exact: true }).click();
        await until(async () => st.apps.length === 1 && (await p2.locator('.cm-app-row').count()) === 1, 'revoked');
        const before = [...st.recovery];
        await p2.getByRole('button', { name: '重新生成恢复代码' }).click();
        await p2.getByLabel('验证码').fill(before[0]); // a recovery code works in place of a code, once
        await p2.getByRole('button', { name: '确认', exact: true }).click();
        await until(async () => (await p2.locator('.cm-codes li').count()) === 10, 'ten new recovery codes');
        assert((await p2.locator('.cm-codes li').first().textContent()) === st.recovery[0] && st.recovery[0] !== before[0], 'the codes shown are the new ones');
        await snap(p2, 'account-recovery-codes');
        await p2.getByRole('button', { name: '我已保存' }).click();
        await until(async () => (await p2.locator('.cm-state[data-on]').count()) === 1, 'back to the state');
      });
      await check('the approval page: another browser\'s sign-in is shown with its code and allowed; that browser is signed in', async () => {
        const { cx, p } = await fresh();
        const code = await startBrowserSignIn(p);
        await app(c => { location.hash = `#/device?code=${c}`; }, code, p2); // the session of the account page is still open
        await until(async () => (await p2.locator('.cm-device .cm-code').count()) && (await p2.locator('.cm-device .cm-code').textContent()) === code, 'the approval page shows the same code');
        const facts = await p2.locator('.cm-device .cm-facts').textContent();
        assert(facts.includes('Sonus') && facts.includes('203.0.113.7'), `it names the app and the address that asked: ${facts}`);
        const v = await axe(p2); assert(!v.length, v.join(' | '));
        await snap(p2, 'approval');
        // one click allows nothing: it takes a code, and a wrong one is refused
        await p2.getByRole('button', { name: '允许', exact: true }).click();
        await sleep(300);
        assert(!(await p2.locator('.cm-device-done').count()) && (await hook()).pending.some(x => x.userCode === code && x.status === 'pending'), 'allowed without a code');
        await p2.locator('.cm-device').getByLabel('验证码').fill('000000');
        await p2.getByRole('button', { name: '允许', exact: true }).click();
        await until(async () => (await p2.locator('.cm-device .cm-login-error:not([hidden])').count()) === 1, 'a wrong code says so');
        await p2.locator('.cm-device').getByLabel('验证码').fill(CODE);
        await p2.getByRole('button', { name: '允许', exact: true }).click();
        await until(async () => (await p2.locator('.cm-device-done').count()) === 1, 'allowed');
        await p.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
        assert((await app(() => JSON.parse(localStorage.getItem('sonus.login')).apiKey, undefined, p))?.length > 10, 'the other browser got its key');
        await app(() => __app.adapter.signOut(), undefined, p);
        await cx.close();
      });
      await check('the approval page works without a sign-in kept in this browser: it asks for the password and a code, then refuses when told to', async () => {
        const { cx, p } = await fresh();
        const code = await startBrowserSignIn(p);
        const { cx: cx3, p: p3 } = await fresh(s => { try { localStorage.setItem('sonus.server', JSON.stringify(s)); } catch { /* about:blank */ } });
        const st3 = {};
        await standIn(p3, st3);
        await p3.goto(`${site}/?theme=dark#/device?code=${code}`);
        await p3.locator('.cm-device-card').waitFor();
        await p3.getByLabel('用户名').fill(account.user);
        await p3.getByLabel('密码', { exact: true }).fill(ACCOUNT_PW);
        await p3.getByRole('button', { name: '继续', exact: true }).click();
        await p3.getByLabel('验证码').fill(CODE);
        await p3.getByRole('button', { name: '继续', exact: true }).click();
        await until(async () => (await p3.locator('.cm-device .cm-code').count()) === 1, 'the request is shown');
        const v = await axe(p3); assert(!v.length, v.join(' | '));
        await snap(p3, 'approval-alone');
        await p3.getByRole('button', { name: '拒绝', exact: true }).click();
        await until(async () => (await p.locator('.cm-login-error').count()) && (await p.locator('.cm-login-error').textContent()).includes('被拒绝'), 'the other browser is told', 8000);
        assert(!(await app(() => localStorage.getItem('sonus.login'), undefined, p3)), 'approving kept a sign-in in this browser');
        await cx3.close(); await cx.close();
      });
      await check('a server that requires two-step verification: it is set up from the account page (the enrolment code, QR code, a code to confirm, recovery codes)', async () => {
        Object.assign(st, { enabled: false, mode: 'required' });
        await app(() => { location.hash = '#/'; }, undefined, p2);
        await p2.reload();
        await p2.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
        await app(() => { location.hash = '#/account'; }, undefined, p2);
        await p2.getByRole('heading', { name: '确认是你' }).waitFor();
        await p2.getByLabel('密码', { exact: true }).fill(ACCOUNT_PW);
        await p2.getByRole('button', { name: '继续', exact: true }).click();
        // the password alone sets nothing up: the enrolment code an admin handed over comes first
        await p2.getByLabel('绑定码').waitFor();
        assert(!(await p2.locator('.cm-qr').count()), 'a key to scan was shown before the enrolment code');
        const asked = await axe(p2); assert(!asked.length, asked.join(' | '));
        await snap(p2, 'two-step-enrolment');
        await p2.getByLabel('绑定码').fill('aaaa-bbbb-cccc');
        await p2.locator('.cm-setup').getByRole('button', { name: '继续', exact: true }).click();
        await until(async () => (await p2.locator('.cm-setup .cm-login-error:not([hidden])').count()) && (await p2.locator('.cm-setup .cm-login-error:not([hidden])').textContent()).includes('绑定码不正确'), 'a wrong enrolment code says so');
        await p2.getByLabel('绑定码').fill(ENROL);
        await p2.locator('.cm-setup').getByRole('button', { name: '继续', exact: true }).click();
        await p2.locator('.cm-qr').waitFor();
        assert((await p2.locator('.cm-secret').textContent()) === 'JBSWY3DPEHPK3PXP', 'the key to type by hand');
        const v = await axe(p2); assert(!v.length, v.join(' | '));
        await snap(p2, 'two-step-setup');
        await p2.getByLabel('验证码').fill(CODE);
        await p2.getByRole('button', { name: '确认', exact: true }).click();
        await until(async () => (await p2.locator('.cm-codes li').count()) === 10, 'recovery codes shown');
        await p2.getByRole('button', { name: '我已保存' }).click();
        await until(async () => (await p2.locator('.cm-state[data-on]').count()) === 1, 'two-step verification is on');
        assert(!(await p2.getByRole('button', { name: '关闭两步验证' }).count()), 'a required two-step verification cannot be turned off');
      });
      await cx2.close();
    }
  }

  // ---------------------------------------------------------------- every view in seven layouts
  const lp = await context.newPage();
  watch(lp);
  for (const L of grep ? [] : LAYOUTS) {
    let bad = 0;
    await lp.setViewportSize({ width: L.w, height: L.h });
    await lp.goto(`${site}/?${L.q}#/`);
    await lp.waitForFunction(() => window.__ready === true, null, { timeout: 30000 });
    await sleep(400);
    if (!real) { await app(al => __app.playContext('album', al, { trackId: __app.lib.albums.get(al).trackIds[2] }), cat.playable.id, lp); await sleep(500); await app(() => __app.adapter.pause(), undefined, lp); }
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
  if (!grep) { await tour(2); } const a = await count(); if (!grep) await tour(3); const b = await count();
  if (grep) { /* not run */ } else if (b.nodes > a.nodes * 1.05 || b.layers > a.layers) { failed++; console.log(`  ✗ teardown: nodes ${a.nodes} → ${b.nodes}, layers ${a.layers} → ${b.layers}`); }
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
await target?.stop();
pages?.stop();
console.log(`${failed ? `\n${failed} failures` : '\nall passed'}${skipped ? ` (${skipped} skipped: this server's library has nothing for them)` : ''}`);
process.exit(failed ? 1 : 0);
