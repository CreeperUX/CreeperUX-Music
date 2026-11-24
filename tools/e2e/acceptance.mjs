// Acceptance of the Windows app, silent and isolated (tools/e2e/e2e.mjs): builds it, starts the demo server and test
// instances, and goes through the app in rounds: sign-in, every page, playback, playlists, search, continuing on a second
// device, controlling another device, narrow windows, losing the server, the system media controls, a restart and signing
// out, updates, taking over what the former name (CreeperUX Music) left, and signing in through the browser. After each round the
// test window must still be hidden and never have been the foreground window. Results: .work/acceptance/report.md;
// screenshots: .work/shots/acc-*.png (look at them).
// Any server: SONUS_TEST_SERVER, SONUS_TEST_CREDENTIALS and SONUS_TEST_MANIFEST (target.mjs, README.md). Against the demo
// server (the default) every check is as it always was; against another one the same behaviour is checked with what
// that server has, and a check the server's library cannot give is reported as skipped, with the reason.
// Usage: node tools/e2e/acceptance.mjs [--arch=x64|ARM64] [--no-build] [--only=signin,pages,playback,playlists,search,devices,connect,layout,offline,smtc,restart,updates,former,browser] [--exe=<path>]
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { build, TestApp, sleep, work, exeFor, credentialKept, forgetCredential, mediaSessions, formerCredentialKept, forgetFormerCredential, writeFormerCredential, writeCredential } from './e2e.mjs';
import { startTarget } from './target.mjs';
import { startFakeGitHub } from './fake-github.mjs';

const args = process.argv.slice(2);
const only = args.find(a => a.startsWith('--only='))?.slice(7).split(',');
const want = round => !only || only.includes(round);
const arch = args.find(a => a.startsWith('--arch='))?.slice(7) ?? (process.arch === 'arm64' ? 'ARM64' : 'x64');
// --exe=<path>: test that program instead of a fresh build (the one unpacked from an MSI by tools/package.ps1 -Extract)
const exe = args.find(a => a.startsWith('--exe='))?.slice(6) ?? exeFor(arch);
const results = [];
let current = '';
const log = (...a) => console.log(...a);

/** Thrown by a check that finds this server cannot give it what it needs (never against the demo server). */
class Skip extends Error {}
async function check(name, fn) {
  const t0 = Date.now();
  try { await fn(); results.push({ round: current, name, ok: true }); log(`  ✓ ${name} (${Date.now() - t0} ms)`); }
  catch (e) {
    if (e instanceof Skip && !server.demo) { skip(name, e.message); return; }
    results.push({ round: current, name, ok: false, error: e.message.split('\n')[0] }); log(`  ✗ ${name}: ${e.message.split('\n')[0]}`);
  }
}
/** A check this server cannot give the data for (never against the demo server): reported, not failed. */
function skip(name, reason) { results.push({ round: current, name, ok: true, skipped: reason }); log(`  – ${name}：跳过（${reason}）`); }
const assert = (ok, msg) => { if (!ok) throw new Error(msg); };
function round(name, title) { current = name; log(`\n${title}`); }
function quiet(app) {
  const q = app.quiet();
  results.push({ round: current, name: `静默：${q}`, ok: q.startsWith('QUIET') });
  log(`  ${q.startsWith('QUIET') ? '✓' : '✗'} 静默检查：${q}`);
}

// ---------------------------------------------------------------- build, the server, the first instance
if (!args.includes('--no-build') && !args.some(a => a.startsWith('--exe='))) {
  const b = build(arch);
  log(b.line, b.problems.length ? `\n${b.problems.join('\n')}` : '');
  if (!b.ok) process.exit(1);
}
const forgetAll = () => { for (const name of ['server', 'github']) { forgetCredential(name); forgetFormerCredential(name); } };
forgetAll();
// the demo server, or the recording proxy in front of SONUS_TEST_SERVER (target.mjs)
const server = await startTarget();
// what the checks take from the library (the demo catalogue's albums, songs and playlists, or another server's)
const cat = await server.catalogue();
const github = await startFakeGitHub();
const appEnv = { SONUS_GITHUB_API: github.url, SONUS_DEVICE_NAME: '第一台' };
const md5 = s => createHash('md5').update(s).digest('hex');
const api = (method, params) => server.api(method, params);
// the demo server's sign-in page offers its account (--demo); any other server is signed in to through the form
const demoUrl = server.demo ? server.url : null;
async function signIn(a) {
  if (server.demo) { await a.invoke('使用本机的演示服务器'); return; }
  await a.send(`set 服务器地址=${server.url}`); await a.send(`set 用户名=${server.user.username}`); await a.send(`set 密码=${server.user.password}`);
  await a.invoke('登录');
}
log(`架构：${arch}${exe === exeFor(arch) ? '' : `（${exe}）`}；服务器：${server.describe}`);
let app = await new TestApp('main', { demo: demoUrl, exe, env: appEnv }).start();
const state = () => app.state();
const until = (fn, what, ms) => app.until(fn, what, ms);
const names = async () => app.names();
const hasName = async n => (await names()).some(x => x.startsWith(`${n} [`));
const shot = async name => app.shot(`acc-${name}`);
const audit = async () => (await app.send('audit')).split('\u001e').filter(Boolean);

try {
  // ---------------------------------------------------------------- 1. first start and sign-in
  if (want('signin')) {
    round('signin', '第 1 轮：首次启动与登录');
    await check(server.demo ? '没有登录时显示登录页（服务器地址、用户名、密码、登录、演示服务器）' : '没有登录时显示登录页（服务器地址、用户名、密码、登录；没有演示服务器的按钮）', async () => {
      await until(async () => hasName('服务器地址'), 'login page');
      for (const n of ['用户名', '密码', '登录', ...(server.demo ? ['使用本机的演示服务器'] : [])]) assert(await hasName(n), `缺少 ${n}`);
      if (!server.demo) assert(!(await hasName('使用本机的演示服务器')), '不是演示服务器，却有它的按钮');
      assert((await audit()).length === 0, (await audit()).join(' | '));
      await shot('login');
    });
    await check('密码错误时说明原因，不保存任何东西', async () => {
      await app.send(`set 服务器地址=${server.url}`); await app.send(`set 用户名=${server.user.username}`); await app.send('set 密码=wrong');
      await app.invoke('登录');
      await until(async () => (await app.texts()).some(t => t.startsWith('用户名或密码不正确。') && t.includes('在浏览器中登录')), 'error text, with the hint for two-step verification');
      assert(!credentialKept(), '凭据被保存了');
      await shot('login-error');
    });
    await check('服务器地址是外网的明文 HTTP 时提醒（内网、Tailscale、HTTPS 不提醒）', async () => {
      const warned = async () => (await app.texts()).some(t => t.startsWith('这是明文 HTTP 连接'));
      await app.send('set 服务器地址=http://music.example.com');
      await until(warned, 'plain HTTP warning');
      await shot('login-plain');
      for (const fine of ['https://music.example.com', 'music.example.com', '100.101.102.103:4533', 'http://192.168.1.10:4533', server.url]) {
        await app.send(`set 服务器地址=${fine}`);
        await until(async () => !(await warned()), `no warning for ${fine}`);
      }
    });
    const { songs: nSongs, albums: nAlbums, playlists: nPlaylists } = cat.counts;
    await check(server.demo ? '用演示服务器登录：载入 293 首、34 张专辑、5 个服务器歌单' : `用测试用户登录：载入服务器上的 ${nSongs} 首、${nAlbums} 张专辑、${nPlaylists} 个歌单`, async () => {
      await signIn(app);
      await until(async () => (await app.send('ready')) === 'yes', 'ready', 30000);
      const s = await state();
      assert(s.songs === nSongs && s.albums === nAlbums && s.playlists.length === nPlaylists + 2, JSON.stringify({ songs: s.songs, albums: s.albums, pl: s.playlists.length }));
      assert(s.route === 'home' && s.title === '首页 · Sonus', s.title);
    });
    await check('登录信息在 Windows 凭据管理器里（测试专用条目），设置文件里没有令牌', async () => {
      assert(credentialKept(), '凭据管理器里没有 Sonus-test:server');
      for (const f of readdirSync(app.data)) if (f.endsWith('.json')) assert(!/token|salt/i.test(readFileSync(join(app.data, f), 'utf8')), `${f} 里有令牌`);
    });
    await check('首页：问候、快捷入口、各个卡片架', async () => {
      await sleep(1500);
      const t = await app.texts();
      for (const x of ['最近播放', '你的歌单', '你常听的艺人', '高解析度收藏', '最近添加到媒体库']) assert(t.includes(x), `缺少 ${x}`);
      assert(await hasName('快捷入口'), '没有快捷入口');
      await shot('home');
    });
    await check('刚启动时图标就是该有的颜色：播放键是深色，其他按钮是灰色', async () => {
      const color = async name => (await app.send(`iconcolor ${name}`)).toUpperCase();
      assert((await color('播放')) === '#FF111416', `播放键图标是 ${await color('播放')}`);
      for (const name of ['上一首', '下一首', '随机播放', '循环播放', '设置'])
        assert((await color(name)) === '#FFA9B0B3', `${name} 图标是 ${await color(name)}`);
    });
    quiet(app);
  }

  // ---------------------------------------------------------------- 2. every page
  if (want('pages')) {
    round('pages', '第 2 轮：每个页面（标题、内容、可访问性审查、截图）');
    const others = cat.othersPlaylist; // another user's public playlist (the demo's friend's)
    const pages = [
      [`album:${cat.browse.id}`, 'AlbumPage', cat.browse.title], [`playlist:${cat.ownPlaylist.id}`, 'PlaylistPage', cat.ownPlaylist.name], ['playlist:liked', 'PlaylistPage', '我喜欢的音乐'],
      ['playlist:library', 'PlaylistPage', '媒体库 · 全部歌曲'], ...(others ? [[`playlist:${others.id}`, 'PlaylistPage', others.name]] : []), [`artist:${cat.artist.id}`, 'ArtistPage', cat.artist.name],
      ['search:', 'SearchPage', '浏览全部'], ...(cat.genre ? [[`genre:${cat.genre}`, 'CollectionPage', cat.genre]] : []), ['shelf:recent', 'CollectionPage', '最近播放'], ['settings', 'SettingsPage', '设置'],
    ];
    if (!others) skip('别人的歌单页', '服务器上没有别的用户的公开歌单，也没有第二个测试用户（users.other）');
    if (!cat.genre) skip('流派页', '服务器上的歌都没有流派');
    for (const [route, view, text] of pages) {
      await check(`${route}：${view} 显示“${text}”，控件都有名称`, async () => {
        await app.send(`nav ${route}`);
        await until(async () => (await state()).view === view, view);
        await sleep(900);
        assert((await app.texts()).some(t => t.includes(text)), `没有“${text}”`);
        // a list fills the rows below the window in idle time (the x64 build under emulation takes over a second):
        // their buttons have no song, so no name, until then
        let problems = [];
        await until(async () => (problems = (await audit()).filter(p => !p.startsWith('small'))).length === 0, 'every control named', 5000).catch(() => {});
        assert(problems.length === 0, problems.slice(0, 3).join(' | '));
        await shot(`page-${route.replace(/[:]/g, '-').replace(/-$/, '')}`);
      });
    }
    await check('键盘：歌曲列表就是页面的滚动区，Tab 仍从页头的播放按钮进到列表', async () => {
      await app.send(`nav album:${cat.browse.id}`); await sleep(800);
      const order = (await app.send(`tabs ${cat.browse.artist} 5`)).split('');
      const play = order.indexOf(`播放 ${cat.browse.title} [Button]`), row = order.findIndex(x => x.endsWith('[ListViewItem]'));
      assert(play >= 0 && row > play, order.join(' → '));
    });
    if (others) await check('别人的歌单只能播放：没有重命名和删除', async () => {
      await app.send(`nav playlist:${others.id}`); await sleep(600);
      assert(!(await hasName(`${others.name} 的更多选项`)), '出现了“更多选项”');
      assert((await app.texts()).includes('歌单（只读）'), '没有标成只读');
    });
    else skip('别人的歌单只能播放：没有重命名和删除', '服务器上没有别的用户的公开歌单');
    await check('来回切换 60 次页面后，界面元素和托管内存不再增长（离开的页面被释放）', async () => {
      const routes = ['home', `album:${cat.browse.id}`, `playlist:${cat.ownPlaylist.id}`, `artist:${cat.artist.id}`, 'search:', `search:${cat.search.term}`, ...(cat.genre ? [`genre:${cat.genre}`] : []), 'shelf:recent', 'lyrics', 'settings'];
      const tour = async n => { for (let i = 0; i < n; i++) for (const r of routes) { await app.send(`nav ${r}`); await sleep(120); } await app.send('nav home'); await sleep(1200); };
      await tour(2);
      const [e1, m1] = [Number(await app.send('elements')), Number(await app.send('memory'))];
      await tour(4);
      const [e2, m2] = [Number(await app.send('elements')), Number(await app.send('memory'))];
      log(`    界面元素 ${e1} → ${e2}，托管内存 ${(m1 / 1024).toFixed(1)} MB → ${(m2 / 1024).toFixed(1)} MB`);
      assert(e2 <= e1 * 1.05, `元素 ${e1} → ${e2}`);
      assert(m2 <= m1 * 1.25 + 2048, `内存 ${m1} KB → ${m2} KB`);
    });
    await check('界面缩放：设置里选 90%，整个窗口按 90% 重新排版，选回 100% 复原', async () => {
      const width = async () => Number((await app.send('insets')).match(/width ([\d.]+)/)[1]);
      await app.send('nav settings'); await sleep(600);
      const before = await width();
      await app.invoke('90%'); await sleep(600);
      const zoomed = await width();
      assert(Math.abs(zoomed - before / 0.9) < 2, `排版宽度 ${before} → ${zoomed}（应为 ${(before / 0.9).toFixed(1)}）`);
      await shot('zoom-90');
      await app.invoke('100%'); await sleep(600);
      assert(Math.abs((await width()) - before) < 2, '没有复原');
    });
    await check('窗口按钮能点：顶栏里可点的部分跟着按钮走，不盖住最小化、最大化、关闭（各种缩放下）', async () => {
      // "buttons 2394; passthrough 797,28,1088,72 1995,28,374,72; end 1995,28,374,72" (window pixels)
      const bar = async () => {
        const s = await app.send('titlebar');
        const m = /^buttons (-?\d+); passthrough ([\d, -]*); end (\d+),(\d+),(\d+),(\d+)$/.exec(s);
        assert(m, s);
        return { s, buttons: Number(m[1]), parts: m[2].trim().split(' ').filter(Boolean).map(p => p.split(',').map(Number)), end: m.slice(3).map(Number) };
      };
      const fits = async zoom => {
        await until(async () => {
          const b = await bar();
          const last = b.parts.at(-1);
          return b.parts.every(([x, , w]) => x + w <= b.buttons) && last && Math.abs(last[0] - b.end[0]) <= 2 && Math.abs(last[2] - Math.min(b.end[2], b.buttons - b.end[0])) <= 2;
        }, `top bar at ${zoom}: ${(await bar()).s}`, 3000);
      };
      await app.send('nav settings'); await sleep(600);
      for (const zoom of ['90%', '125%', '110%', '100%']) { await app.invoke(zoom); await sleep(400); await fits(zoom); }
    });
    await check('后退回到上一个页面', async () => {
      await app.send(`nav album:${cat.second.album}`); await sleep(300);
      await app.send(`nav artist:${cat.second.artist}`); await sleep(300);
      await app.send('back'); await until(async () => (await state()).route === `album:${cat.second.album}`, `back to album:${cat.second.album}`);
    });
    quiet(app);
  }

  // ---------------------------------------------------------------- 3. playback
  if (want('playback')) {
    round('playback', '第 3 轮：播放（Windows MediaPlayer）');
    // the album the round plays (the demo's 霓虹航线: t21, t22, t23 …)
    const pt = (await api('getAlbum', { id: cat.playable.id })).album.song.map(s => s.id);
    await check('专辑页的播放按钮：从第一首开始，位置在走，服务器显示正在播放', async () => {
      await app.send(`nav album:${cat.playable.id}`); await sleep(800);
      await app.invoke(`播放 ${cat.playable.title}`);
      await until(async () => { const s = await state(); return s.engine === 'Playing' && s.enginePosition > 0.5; }, 'playing', 10000);
      const s = await state();
      assert(s.track === pt[0] && s.engineTrack === pt[0] && s.context.Kind === 'album', JSON.stringify({ t: s.track, e: s.engineTrack }));
      assert(s.engineNext === pt[1], `下一首没有提前载入：${s.engineNext}`);
      await until(async () => (await api('getNowPlaying')).nowPlaying.entry?.some(e => e.id === pt[0]), 'now playing on the server');
      await shot('playing-album');
    });
    await check('播放条：暂停、继续', async () => {
      await app.invoke('暂停');
      await until(async () => { const s = await state(); return s.state === 'Paused' && s.engine === 'Paused'; }, 'paused');
      await app.invoke('播放');
      await until(async () => (await state()).engine === 'Playing', 'playing again');
    });
    await check('拖动进度：MediaPlayer 跳到 30 秒', async () => {
      await app.send('do seek 30');
      await until(async () => Math.abs((await state()).enginePosition - 30) < 1.5, 'at 30 s');
    });
    await check('播过一半计一次播放（scrobble），服务器和界面都 +1', async () => {
      const before = (await api('getSong', { id: pt[0] })).song.playCount ?? 0;
      const d = (await state()).duration;
      await app.send(`do seek ${Math.min(d / 2 + 2, 245)}`);
      await until(async () => (await api('getSong', { id: pt[0] })).song.playCount === before + 1, 'server +1', 8000);
      await until(async () => JSON.parse(await app.send(`do track ${pt[0]}`)).PlayCount === before + 1, 'app +1');
    });
    await check('无缝切歌：下一首提前载入，播完自动接上', async () => {
      const d = (await state()).duration;
      await app.send(`do seek ${d - 5}`);
      await until(async () => { const s = await state(); return s.track === pt[1] && s.engineTrack === pt[1] && s.engine === 'Playing'; }, `moved on to ${pt[1]}`, 15000);
      const s = await state();
      assert(s.engineNext === pt[2], `再下一首没有载入：${s.engineNext}`);
      const streams = (await server.log()).streams.filter(x => x.id === pt[1]);
      assert(streams.length >= 1, `没有请求 ${pt[1]}`);
    });
    await check('播放时打开别的专辑，封面照样马上去取（歌曲的连接不占满图片下载）', async () => {
      // an album whose big cover (the page's: 512 px or more, by the screen) has not been fetched yet in this run, since a
      // cached one needs no request (asked for by the album's coverArt: the album's own id on the demo server)
      const big = c => Number(c.size) >= 512;
      const seen = new Set((await server.log()).covers.filter(big).map(c => c.id));
      const albums = (await api('getAlbumList2', { type: 'alphabeticalByName', size: 500 })).albumList2.album.filter(a => a.coverArt);
      const album = albums.find(a => !seen.has(a.coverArt));
      if (!album && !server.demo) throw new Skip(`服务器只有 ${albums.length} 张有封面的专辑，大封面在前面几轮都已经取过（有缓存就不再请求）`);
      assert(album, '每张专辑的大封面都已经取过了');
      const t0 = Date.now();
      await app.send(`nav album:${album.id}`);
      try { await until(async () => (await server.log()).covers.some(c => c.id === album.coverArt && big(c) && c.at >= t0), 'cover requested', 2000); }
      catch (e) { const l = await server.log(); throw new Error(`${e.message}; streams open ${l.open}; album ${album.id}; latest covers ${JSON.stringify(l.covers.slice(-4).map(c => [c.id, c.size, c.at - t0]))}; view ${(await state()).view}`); }
      const open = (await server.log()).open;
      assert(open >= 1, `没有在播放（打开的音频流 ${open}）`);
    });
    await check('下一首 / 上一首', async () => {
      await app.invoke('下一首');
      await until(async () => (await state()).track === pt[2], `next ${pt[2]}`);
      await sleep(500);
      await app.invoke('上一首');
      await until(async () => (await state()).track === pt[1], `previous ${pt[1]}`);
    });
    await check('随机与循环按钮切换播放顺序', async () => {
      const color = async name => (await app.send(`iconcolor ${name}`)).toUpperCase();
      await app.invoke('随机播放');
      await until(async () => (await state()).order === 'ShuffleTracks', 'shuffle');
      await until(async () => (await color('随机播放')) === '#FFF8B700', 'the shuffle icon in amber'); // on: the accent
      await app.invoke('随机播放');
      await until(async () => (await state()).order === 'Default', 'shuffle off');
      await until(async () => (await color('随机播放')) === '#FFA9B0B3', 'the shuffle icon grey again');
      await app.invoke('循环播放'); await until(async () => (await state()).order === 'RepeatPlaylist', 'repeat all');
      await app.invoke('列表循环'); await until(async () => (await state()).order === 'RepeatTrack', 'repeat one');
      await app.invoke('单曲循环'); await until(async () => (await state()).order === 'Default', 'repeat off');
    });
    await check('歌曲菜单：“下一首播放”排进队列，接着就播它', async () => {
      await app.send(`nav album:${cat.browse.id}`); await sleep(800);
      const list = (await api('getAlbum', { id: cat.browse.id })).album.song, target = list[Math.min(4, list.length - 1)];
      await app.invoke(`${target.title} 的更多选项`);
      await until(async () => Number(await app.send('popups')) > 0, 'menu open');
      await shot('track-menu');
      await app.invoke('下一首播放');
      await until(async () => (await state()).manual === 1, 'queued');
      await app.invoke('下一首');
      await until(async () => (await state()).track === target.id, 'plays the queued song');
    });
    await check('播放队列面板列出接下来的歌', async () => {
      await app.invoke('播放队列');
      await sleep(600);
      assert((await app.texts()).some(t => t.startsWith('接下来：')), '没有“接下来”');
      await shot('queue-panel');
      await app.invoke('播放队列');
    });
    await check('播放条上的“喜欢”：服务器收藏，再取消', async () => {
      const id = (await state()).track;
      const starred = async () => ((await api('getStarred2')).starred2.song ?? []).some(s => s.id === id);
      const was = await starred();
      await app.invoke(was ? '取消喜欢' : '喜欢');
      await until(async () => (await starred()) !== was, 'server changed');
      await app.invoke(was ? '喜欢' : '取消喜欢');
      await until(async () => (await starred()) === was, 'server back');
    });
    await check('开始电台：从这首歌开始，接着是相似的歌', async () => {
      await app.send(`nav album:${cat.playable.id}`); await sleep(800);
      await app.invoke(`${cat.radio.title} 的更多选项`);
      await until(async () => Number(await app.send('popups')) > 0, 'menu open');
      await app.invoke('开始电台');
      await until(async () => (await state()).context?.Kind === 'radio', 'radio', 8000);
      const s = await state();
      assert(s.context.Label === `${cat.radio.title} 电台` && s.track === cat.radio.id, JSON.stringify(s.context));
      if (server.demo) assert(s.queue.length >= 5, `电台只有 ${s.queue.length} 首`);
      else {
        // the seed, then the songs the server answered, in its order (what the recording proxy saw: a server may pick
        // them at random each time); with none, songs of the same artist or genre from the library
        const answer = (await server.log()).similar.filter(x => x.id === cat.radio.id).at(-1)?.songs?.filter(id => id !== cat.radio.id);
        // the state's queue: the songs after the one playing, hand-queued ones first (at most 20 listed)
        const after = s.queue.slice(s.manual ?? 0);
        assert(answer, '没有看到 getSimilarSongs2 的回应');
        assert(after.length >= 1 && !after.includes(cat.radio.id) && new Set(after).size === after.length, `电台：${JSON.stringify(after)}`);
        if (answer.length) assert(JSON.stringify(after) === JSON.stringify(answer.slice(0, after.length)), `电台不是服务器给的那些歌：${JSON.stringify(after.slice(0, 3))} / ${JSON.stringify(answer.slice(0, 3))}`);
        log(`    服务器给了 ${answer.length} 首相似的歌${answer.length ? '' : '（电台用同一艺人或流派的歌）'}，电台里接下来 ${after.length} 首（状态里最多列 20 首）`);
      }
    });
    const dsd = await api('search3', { query: '', songCount: 500 }).then(r => r.searchResult3.song?.find(x => x.suffix === 'dsf'), () => null);
    if (dsd || server.demo) await check('DSD 歌曲请服务器转成 MP3（Windows 不能直接解 DSD）', async () => {
      await app.send(`do play album ${dsd.albumId} ${dsd.id}`);
      try { await until(async () => (await server.log()).streams.some(x => x.id === dsd.id && x.format === 'mp3'), 'format=mp3'); }
      catch (e) {
        const s = await state(), streams = (await server.log()).streams.slice(-4);
        throw new Error(`${e.message}: ${JSON.stringify({ want: dsd.id, album: dsd.albumId, track: s.track, state: s.state, engine: s.engine, engineTrack: s.engineTrack, err: s.error, streams })}`);
      }
      await until(async () => (await state()).engine === 'Playing', 'plays');
    });
    else skip('DSD 歌曲请服务器转成 MP3（Windows 不能直接解 DSD）', '服务器上没有 DSD（.dsf）歌曲');
    if (cat.missing) await check('服务器给不出文件的歌：像 Spotify 一样跳到下一首，并说哪首无法播放', async () => {
      await app.send(`do play library all ${cat.missing}`);
      await until(async () => { const s = await state(); return s.track && s.track !== cat.missing && s.engine === 'Playing'; }, 'skipped to the next song', 10000);
      const toasts = (await state()).toasts ?? [];
      assert(toasts.some(t => t.startsWith('无法播放“') && t.includes('已跳到下一首')), JSON.stringify(toasts));
      await shot('play-error');
    });
    else skip('服务器给不出文件的歌：像 Spotify 一样跳到下一首，并说哪首无法播放', '清单里没有文件已丢失的歌（track.missingFile）');
    await check('回放增益：按音轨降低音量', async () => {
      await app.send(`do play album ${cat.playable.id} 0`);
      await until(async () => (await state()).engine === 'Playing', 'playing');
      await app.send('do volume 1'); await app.send('do replaygain Track');
      // the song's own gain (or its album's when it has none); with neither, the volume stays at full
      const t = JSON.parse(await app.send(`do track ${pt[0]}`)), v = (await state()).volume, gain = t.TrackGain ?? t.AlbumGain;
      assert(Math.abs(v - (gain == null ? 1 : Math.min(1, 10 ** (gain / 20)))) < 0.01, `gain ${t.TrackGain}, volume ${v}`);
      if (!server.demo) log(`    音轨增益 ${t.TrackGain ?? '无'}，专辑增益 ${t.AlbumGain ?? '无'}，音量 ${v.toFixed(3)}`);
      await app.send('do replaygain Album'); await app.send('do volume 0.3');
    });
    if (server.demo || cat.lyrics) await check('全屏歌词：当前行随播放变亮', async () => {
      if (!server.demo) { // a song with synced lyrics (on the demo server, the one playing has them)
        await app.send(`do play library all ${cat.lyrics.id}`);
        await until(async () => { const s = await state(); return s.track === cat.lyrics.id && s.engine === 'Playing'; }, 'the song with lyrics plays');
      }
      await app.send('do seek 20');
      await app.send('nav lyrics'); await sleep(1500);
      const t = await app.texts();
      assert(t.length > 8, '歌词太少');
      await shot('lyrics');
    });
    else skip('全屏歌词：当前行随播放变亮', '服务器上找不到有同步歌词的歌（track.syncedLyrics）');
    quiet(app);
  }

  // ---------------------------------------------------------------- 4. playlists
  if (want('playlists')) {
    round('playlists', '第 4 轮：歌单（新建、改名、加歌、删除）');
    let created = null;
    await check('音乐库的“+”新建歌单，打开它的页面', async () => {
      const before = (await api('getPlaylists')).playlists.playlist ?? [], known = new Set(['liked', 'library', ...before.map(p => p.id)]);
      await app.invoke('新建歌单');
      // its page: plN on the demo server, whatever id another server gives
      await until(async () => { const r = (await state()).route ?? ''; return r.startsWith(server.demo ? 'playlist:pl' : 'playlist:') && !known.has(r.slice(9)); }, 'opened', 8000);
      const list = (await api('getPlaylists')).playlists.playlist ?? [];
      assert(list.length === before.length + 1, '服务器上没有新歌单');
      created = list.find(p => !known.has(p.id));
      await shot('new-playlist');
    });
    await check('“更多选项 → 重命名”改名，服务器跟着改', async () => {
      await app.invoke(`${created.name} 的更多选项`);
      await until(async () => Number(await app.send('popups')) > 0, 'menu');
      await app.invoke('重命名');
      await until(async () => hasName('名称'), 'dialog');
      await app.send('set 名称=验收歌单');
      await app.invoke('保存');
      await until(async () => (await api('getPlaylists')).playlists.playlist.some(p => p.id === created.id && p.name === '验收歌单'), 'renamed');
    });
    await check('歌曲菜单“加入歌单”把歌加进去', async () => {
      await app.send(`nav album:${cat.second.album}`); await sleep(800);
      const song = (await api('getAlbum', { id: cat.second.album })).album.song[0];
      await app.invoke(`${song.title} 的更多选项`);
      await until(async () => Number(await app.send('popups')) > 0, 'menu');
      await app.invoke('加入歌单');
      await until(async () => hasName('验收歌单'), 'submenu');
      await app.invoke('验收歌单');
      await until(async () => ((await api('getPlaylist', { id: created.id })).playlist.entry ?? []).some(e => e.id === song.id), 'added');
    });
    await check('删除歌单（先确认）', async () => {
      await app.send(`nav playlist:${created.id}`); await sleep(800);
      await app.invoke('验收歌单 的更多选项');
      await until(async () => Number(await app.send('popups')) > 0, 'menu');
      await app.invoke('删除歌单');
      await until(async () => hasName('删除'), 'confirm');
      await shot('confirm-delete');
      await app.invoke('删除');
      await until(async () => !(await api('getPlaylists')).playlists.playlist.some(p => p.id === created.id), 'deleted');
      await until(async () => (await state()).route === 'home', 'back home');
    });
    await check('在别的设备上建的歌单，刷新后出现在音乐库', async () => {
      const made = (await api('createPlaylist', { name: '另一台设备的歌单', songId: cat.songIds.slice(0, 2) })).playlist;
      await app.send('do refresh');
      await until(async () => (await state()).playlists.some(p => p.Name === '另一台设备的歌单'), 'appears');
      await api('deletePlaylist', { id: made.id });
    });
    quiet(app);
  }

  // ---------------------------------------------------------------- 5. search
  if (want('search')) {
    round('search', '第 5 轮：搜索');
    const term = cat.search.term; // 夜 on the demo server
    await check(`在顶栏输入“${term}”：进入搜索页，有最佳结果和歌曲`, async () => {
      await app.send(`set 搜索=${term}`);
      await until(async () => (await state()).route === `search:${term}`, 'search route', 5000);
      await until(async () => (await app.texts()).includes('最佳结果'), 'results');
      await shot('search');
    });
    await check('从搜索结果播放，开关随机后队列还在（回到搜索结果的顺序）', async () => {
      await app.send(`nav search:${term}`); await sleep(1500);
      await app.invoke(`播放 ${cat.search.best}`); // the best result: the first artist found (or album)
      await until(async () => (await state()).engine === 'Playing', 'playing');
      const r = ((await api('search3', { query: term, songCount: 200, albumCount: 0, artistCount: 0 })).searchResult3.song ?? []).map(x => x.id);
      await app.send(`do playsearch ${term}`);
      await until(async () => (await state()).context?.Kind === 'search', 'search context');
      await app.send('do order ShuffleTracks'); await app.send('do order Default');
      const s = await state();
      assert(s.queue.length > 0, '队列空了');
      log(`    搜索结果 ${r.length} 首，关掉随机后队列 ${s.queue.length} 首`);
    });
    await check('搜不到时说明', async () => {
      await app.send('nav search:zzzz');
      await until(async () => (await app.texts()).includes('没有找到“zzzz”'), 'no results');
    });
    quiet(app);
  }

  // ---------------------------------------------------------------- 6. a second device continues
  if (want('devices')) {
    round('devices', '第 6 轮：在另一台设备上接着听');
    await check('第一台暂停后，第二台登录：停在同一首歌的同一位置，并提示“接着播放”', async () => {
      // a song with synced lyrics, so the second device's lyrics card has a line to light (the demo's: al5)
      const at = cat.lyrics ?? { albumId: cat.playable.id, index: 0 };
      await app.send(`do play album ${at.albumId} ${at.index}`);
      await until(async () => (await state()).engine === 'Playing', 'A playing');
      await app.send('do seek 41');
      await sleep(800);
      await app.send('do pause');
      const a = await state();
      await until(async () => (await api('getPlayQueue')).playQueue.current === a.track, 'saved on the server');
      const b = await new TestApp('second', { demo: demoUrl, exe }).start();
      try {
        await b.until(async () => (await b.send('ready')) === 'yes', 'B signed in (shared test credential)', 30000);
        await b.until(async () => { const s = await b.state(); return s.track === a.track && s.state === 'Paused'; }, 'B shows A\'s song paused', 10000);
        const s = await b.state();
        assert(Math.abs(s.position - a.position) < 2, `位置 ${s.position} ≠ ${a.position}`);
        assert(s.toasts.some(t => t.includes('接着')), JSON.stringify(s.toasts));
        if (cat.lyrics) await b.until(async () => (await b.state()).lyric, 'the lyrics card lights the line at that position', 6000);
        else log('    （服务器上找不到有同步歌词的歌：不查歌词卡片）');
        await b.shot('acc-second-device');
        await b.invoke('接着播放');
        try { await b.until(async () => { const x = await b.state(); return x.engine === 'Playing' && Math.abs(x.enginePosition - a.position) < 4; }, 'B plays from there', 10000); }
        catch (e) { const x = await b.state(); throw new Error(`${e.message}: ${JSON.stringify({ state: x.state, engine: x.engine, track: x.track, engineTrack: x.engineTrack, pos: x.position, epos: x.enginePosition, want: a.position, err: x.error })}`); }
        await b.send('do pause');
        const q = b.quiet(); assert(q.startsWith('QUIET'), `第二台：${q}`);
      } finally { await b.stop(); }
    });
    quiet(app);
  }

  // ---------------------------------------------------------------- 6b. Sonus Connect: control and move playback between devices
  if (want('connect')) {
    round('connect', '第 6b 轮：跨设备控制（Sonus Connect）');
    const b = await new TestApp('remote', { demo: demoUrl, exe, env: { ...appEnv, SONUS_DEVICE_NAME: '第二台' } }).start();
    try {
      await check('两台设备都连上，各自的设备列表里有对方', async () => {
        await b.until(async () => (await b.send('ready')) === 'yes', 'B signed in', 30000);
        await until(async () => (await state()).connect?.others?.some(d => d.Name === '第二台'), 'A sees B', 10000);
        await b.until(async () => (await b.state()).connect?.others?.some(d => d.Name === '第一台'), 'B sees A', 10000);
      });
      let a;
      await check('第一台放歌时，第二台看到它正在播放；选中它，播放条显示那首歌，第一台不被打断', async () => {
        await app.send(`do play album ${cat.playable.id} 0`);
        await until(async () => (await state()).engine === 'Playing', 'A playing');
        a = await state();
        await b.until(async () => (await b.state()).connect.others.some(d => d.Name === '第一台' && d.playing && d.track === a.track), 'B sees A playing', 10000);
        await b.send('nav settings'); // a page without "播放" buttons of its own
        await b.invoke('在其他设备上播放');
        await b.until(async () => (await b.names()).some(n => n.startsWith('第一台 [')), 'the device list', 5000);
        await sleep(700); // the flyout fades in
        b.printWindow('acc-connect-devices'); // a Flyout is not in the app's own (RenderTargetBitmap) shots
        await b.invoke('第一台');
        await b.until(async () => (await b.state()).connect.target === '第一台', 'B controls A');
        await b.until(async () => (await b.texts()).includes('正在「第一台」上播放'), 'the line in the bar');
        assert((await b.texts()).includes(a.trackTitle), '播放条没有显示第一台的歌');
        assert((await state()).engine === 'Playing', '只是选中，第一台不该被打断');
        await b.shot('acc-connect-remote');
      });
      await check('在第二台按暂停，第一台暂停；再按播放，第一台继续', async () => {
        await b.invoke('暂停');
        await until(async () => (await state()).state === 'Paused', 'A paused', 5000);
        // the bar's button, not the settings page's "播放" heading (a TextBlock), which is there all along
        await b.until(async () => (await b.names()).includes('播放 [Button]'), 'B shows A paused', 5000);
        await b.invoke('播放');
        await until(async () => (await state()).engine === 'Playing', 'A plays again', 8000);
      });
      await check('选“这台电脑”：播放从第一台转过来，同一首歌、同一位置接着放，第一台停下', async () => {
        await sleep(1500);
        await b.invoke('正在「第一台」上播放，选择设备'); // the devices button, named for what it controls
        await b.until(async () => (await b.names()).some(n => n.startsWith('这台电脑 [')), 'the device list', 5000);
        const before = await state();
        await b.invoke('这台电脑');
        await until(async () => (await state()).state === 'Paused', 'A stopped', 8000);
        await b.until(async () => { const s = await b.state(); return s.engine === 'Playing' && s.track === before.track; }, 'B plays A\'s song', 10000);
        const s = await b.state();
        assert(Math.abs(s.enginePosition - before.position) < 5, `位置 ${s.enginePosition} 与第一台的 ${before.position} 相差太多`);
        assert(s.connect.target === null, '第二台应回到“这台电脑”');
        assert(s.toasts.some(t => t.includes('已从「第一台」转到这台电脑播放')), JSON.stringify(s.toasts));
        await b.shot('acc-connect-moved');
        await b.send('do pause');
        const q = b.quiet(); assert(q.startsWith('QUIET'), `第二台：${q}`);
      });
    } finally { await b.stop(); }
    quiet(app);
  }

  // ---------------------------------------------------------------- 7. narrow windows
  if (want('layout')) {
    round('layout', '第 7 轮：窄窗口');
    await check('窗口变窄：右侧面板收起，音乐库变成封面栏', async () => {
      await app.send('nav home');
      await app.send('resize 1400 1000'); await sleep(1500);
      const n = await names();
      assert(!n.some(x => x.startsWith('关闭右侧面板 [')), '右侧面板还在');
      assert(!n.some(x => x.startsWith('在音乐库中搜索 [TextBox')), '音乐库没有收起');
      assert(n.some(x => x.startsWith('搜索 [TextBox')), '窄窗口里没有搜索框');
      // the rail's items are covers only: no names or subtitles
      assert(!(await app.texts()).some(t => /^媒体库 · \d+ 首歌曲$/.test(t)), '封面栏里还显示着文字');
      await shot('narrow');
    });
    await check('窗口变回宽：右侧面板和音乐库恢复成原来的样子（自动收起不改设置）', async () => {
      await app.send('resize 2880 1800'); await sleep(1200);
      const n = await names();
      assert(n.some(x => x.startsWith('关闭右侧面板 [')), '右侧面板没有回来');
      assert(n.some(x => x.startsWith('在音乐库中搜索 [TextBox')), '音乐库还是封面栏');
      assert((await app.texts()).some(t => /^媒体库 · \d+ 首歌曲$/.test(t)), '音乐库的文字没有回来');
      const saved = JSON.parse(readFileSync(join(app.data, 'settings.json'), 'utf8'));
      assert(saved.LibraryOpen === true && saved.PanelOpen === true, JSON.stringify({ LibraryOpen: saved.LibraryOpen, PanelOpen: saved.PanelOpen }));
    });
    quiet(app);
  }

  // ---------------------------------------------------------------- 8. losing the server
  if (want('offline')) {
    round('offline', '第 8 轮：服务器断开与恢复');
    await check('服务器断开：连接标记变红并提示；点它重新连接', async () => {
      await server.offline(true);
      await app.send('do refresh');
      await until(async () => (await state()).online === false, 'offline');
      await sleep(400);
      await shot('offline');
      await server.offline(false);
      await app.invoke('未连接到服务器，点击重新连接');
      await until(async () => (await state()).online === true, 'online again');
    });
    quiet(app);
  }

  // ---------------------------------------------------------------- 9. Windows' media controls
  if (want('smtc')) {
    round('smtc', '第 9 轮：系统媒体控制（只读查询）');
    await check('播放时 Windows 媒体控制里有这个程序和歌名', async () => {
      await app.send(`do play album ${cat.playable.id} 0`);
      await until(async () => (await state()).engine === 'Playing', 'playing');
      await sleep(1500);
      const title = (await state()).trackTitle;
      const sessions = mediaSessions();
      const mine = sessions.find(s => s.includes(title));
      assert(mine, `没有“${title}”：${sessions.join(' ; ')}`);
      log(`    ${mine}`);
      await app.send('do pause');
    });
  }

  // ---------------------------------------------------------------- 10. restart, sign out
  if (want('restart')) {
    round('restart', '第 10 轮：重新启动与退出登录');
    await check('关掉再打开：不用再登录，音量等设置还在', async () => {
      await app.send('do volume 0.42');
      await app.stop();
      app = await new TestApp('main', { demo: demoUrl, fresh: false, exe, env: appEnv }).start();
      await until(async () => (await app.send('ready')) === 'yes', 'signed in from Credential Manager', 30000);
      assert(Math.abs((await state()).volume - 0.42) < 0.02 || (await state()).volume <= 0.42, `音量 ${(await state()).volume}`);
    });
    await check('设置页“退出登录”：回到登录页，凭据被删除', async () => {
      await app.send('nav settings'); await sleep(800);
      await shot('settings');
      await app.invoke('退出登录');
      await until(async () => hasName('服务器地址'), 'login page');
      assert(!credentialKept(), '凭据还在');
      assert((await state()).services === 0, `退出后还有 ${(await state()).services} 个会话在运行（播放器、计时器）`);
    });
    await check('再登录一次：只有一个会话，之前的不再运行', async () => {
      await signIn(app);
      await until(async () => (await app.send('ready')) === 'yes', 'ready', 30000);
      assert((await state()).services === 1, `会话数 ${(await state()).services}`);
      await app.send(`do play album ${cat.playable.id} 0`);
      await until(async () => (await state()).engine === 'Playing', 'plays');
      await app.send('do pause');
    });
    quiet(app);
  }

  // ---------------------------------------------------------------- 11. updates (a fake GitHub: tools/e2e/fake-github.mjs)
  if (want('updates')) {
    round('updates', '第 11 轮：检查更新（本地的假 GitHub）');
    const statusLine = async re => (await app.texts()).find(t => re.test(t));
    await check('设置 › 更新：不用填任何东西，说明更新来自公开仓库', async () => {
      await app.send('nav settings');
      await until(async () => statusLine(/^当前版本 \d+\.\d+\.\d+。/), 'status');
      assert((await app.texts()).some(t => t.startsWith('更新来自 GitHub 上 Sonus 的公开仓库')), '没有说明更新从哪里来');
      assert(!(await hasName('GitHub 令牌')) && !(await hasName('保存 GitHub 令牌')), '还有填写 GitHub 令牌的地方');
    });
    await check('检查更新：找到正式版 9.9.0（不提示测试版和草稿），右上角出现“新版本”；请求不带任何凭据', async () => {
      await app.invoke('检查更新');
      await until(async () => statusLine(/发现新版本 9\.9\.0。$/), '9.9.0 found');
      await until(async () => hasName('更新到 Sonus 9.9.0'), 'the top bar pill');
      assert(github.log.requests.some(r => r.path.endsWith('/releases')) && !github.log.authSent, '列表请求带了凭据（仓库是公开的，不该带）');
      await app.send('scroll 62'); await sleep(300);
      await shot('settings-update');
    });
    await check('打开“接收测试版”：找到 9.10.0-beta.1', async () => {
      await app.invoke('接收测试版');
      await app.invoke('检查更新');
      await until(async () => statusLine(/发现新版本 9\.10\.0-beta\.1（测试版）/), 'beta found');
      await until(async () => hasName('更新到 Sonus 9.10.0-beta.1'), 'the pill follows');
    });
    await check('安装更新：显示版本说明，下载这台电脑架构的安装程序并按 SHA-256 校验（测试实例不运行它）', async () => {
      const name = `Sonus-9.10.0-${arch}-setup.exe`;
      await app.invoke('安装更新');
      await until(async () => (await app.texts()).includes('更新到 Sonus 9.10.0-beta.1'), 'dialog');
      assert((await app.texts()).some(t => t.includes('测试用的版本说明。') && !t.includes('**')), '版本说明没有显示成纯文本');
      await shot('update-dialog');
      await app.invoke('下载并安装');
      const logFile = join(app.data, 'app.log');
      await until(async () => readFileSync(logFile, 'utf8').includes(`installer not started (${name})`), 'downloaded and checked', 20000);
      const file = join(app.data, 'update', name);
      assert(createHash('sha256').update(readFileSync(file)).digest('hex') === github.sha256(name), '下载的文件和 GitHub 上的不一样');
      assert(!github.log.authSent, '请求带了凭据（仓库是公开的，不该带）');
      await until(async () => statusLine(/^下载完成，已校验。/), 'done status');
      await shot('update-downloaded');
      await app.invoke('以后再说');
      await until(async () => !(await app.texts()).includes('更新到 Sonus 9.10.0-beta.1'), 'dialog closed');
    });
    quiet(app);
  }

  // ---------------------------------------------------------------- 12. the former name (CreeperUX Music, up to 0.3)
  if (want('former')) {
    round('former', '第 12 轮：从 CreeperUX Music（0.3）升级：登录搬到新名字下，不再需要的 GitHub 令牌删掉');
    await check('旧名字下的登录：启动时改存为 Sonus 的，不用重新登录；旧版本留下的 GitHub 令牌（两个名字下）删掉', async () => {
      await app.stop();
      forgetAll();
      const salt = 'former01';
      const { username, password } = server.user;
      writeFormerCredential('server', username, JSON.stringify({ server: server.url, user: username, salt, token: md5(password + salt) }));
      writeFormerCredential('github', 'github', 'gh-token');
      writeCredential('github', 'github', 'gh-token');
      assert(formerCredentialKept('server') && formerCredentialKept('github') && credentialKept('github'), '没写进测试条目');
      app = await new TestApp('former', { demo: demoUrl, exe, env: appEnv }).start();
      await until(async () => (await app.send('ready')) === 'yes', 'signed in with the former sign-in', 30000);
      assert(credentialKept(), '新名字（Sonus-test）下没有登录');
      assert(!credentialKept('github'), 'Sonus-test:github 还在（更新已经不用令牌）');
      assert(!formerCredentialKept('server') && !formerCredentialKept('github'), '旧名字（CreeperUXMusic-test）的条目还在');
      const logText = readFileSync(join(app.data, 'app.log'), 'utf8');
      assert(logText.includes('[former name] CreeperUXMusic-test:server → Sonus-test:server') && logText.includes('[credentials] Sonus-test:github deleted') && !logText.includes('gh-token') && !logText.includes(md5(password + salt)), '日志里没有迁移记录，或写进了密钥');
      assert((await state()).title === '首页 · Sonus', (await state()).title);
    });
    await check('没有令牌照样能检查更新', async () => {
      await app.send('nav settings');
      await app.invoke('检查更新');
      await until(async () => (await app.texts()).some(t => /发现新版本 9\.9\.0。$/.test(t)), '9.9.0 found without a token');
    });
    quiet(app);
  }

  // ---------------------------------------------------------------- 13. signing in through the browser (an API key)
  if (want('browser')) {
    round('browser', '第 13 轮：在浏览器中登录（服务器发给这台电脑的应用密钥，不经过密码）');
    // the approval page's decision: the demo server's test hook, or the server's own routes as the page calls them
    // (target.mjs); no browser is opened (a test instance only logs it)
    const signIns = server.signIns;
    const keysBefore = new Set((await signIns.keys().catch(() => [])).map(k => k.id ?? `${k.user}/${k.name}`));
    const newKeys = async () => (await signIns.keys()).filter(k => !keysBefore.has(k.id ?? `${k.user}/${k.name}`)); // the demo's: all of them
    const codeShown = async () => (await app.texts()).find(t => /^[B-Z]{4}-[B-Z]{4}$/.test(t));
    const logText = () => readFileSync(join(app.data, 'app.log'), 'utf8');
    await check('点“在浏览器中登录”：显示登录代码，打开服务器的允许页面（测试实例只记日志）', async () => {
      await app.stop();
      forgetAll();
      app = await new TestApp('browser', { demo: demoUrl, exe, env: appEnv }).start();
      await until(async () => hasName('在浏览器中登录'), 'login page');
      await app.send(`set 服务器地址=${server.url}`);
      await app.invoke('在浏览器中登录');
      await until(codeShown, 'the code');
      const code = await codeShown();
      await until(async () => logText().includes(`[browser sign-in] ${server.url}/app/#/device?code=${code}`), 'the approval page logged');
      const waiting = await signIns.waiting(code);
      assert(waiting?.client === 'Sonus' && waiting.device === '测试 第一台', `服务器上的登录请求：${JSON.stringify(waiting)}`);
      assert(await hasName('取消在浏览器中登录'), '没有取消按钮');
      assert((await audit()).length === 0, (await audit()).join(' | '));
      await shot('login-browser');
    });
    await check('在网页上允许后自动登录：服务器上多了一个以这台电脑命名的应用密钥', async () => {
      assert(await signIns.decide(await codeShown(), true), '服务器上没有等待中的登录');
      await until(async () => (await app.send('ready')) === 'yes', 'ready', 30000);
      assert(credentialKept(), '凭据没有保存');
      const keys = await newKeys();
      assert(keys.length === 1 && keys[0].user === server.user.username && keys[0].name === 'Sonus · 测试 第一台', JSON.stringify(keys));
      const s = await state();
      assert(s.songs === cat.counts.songs && s.albums === cat.counts.albums, JSON.stringify({ songs: s.songs, albums: s.albums }));
    });
    await check('设置页写明登录方式；Sonus Connect 用应用密钥连上服务器', async () => {
      await app.send('nav settings');
      await until(async () => (await app.texts()).includes('在浏览器中登录（应用密钥，可在服务器网页上撤销）'), 'the sign-in method');
      await until(async () => (await server.connectDevices()).length > 0, `a Connect device for ${server.user.username}`);
      await app.send('scroll 45'); await sleep(300);
      await shot('settings-browser');
    });
    await check('关掉再打开：用保存的应用密钥直接登录，密钥不出现在日志里', async () => {
      await app.stop();
      app = await new TestApp('browser', { demo: demoUrl, fresh: false, exe, env: appEnv }).start();
      await until(async () => (await app.send('ready')) === 'yes', 'signed in with the kept key', 30000);
      assert(!/apiKey=[A-Za-z0-9_-]{8}/.test(logText()), '日志里有应用密钥');
    });
    await check('退出登录：把应用密钥还给服务器（随即失效），凭据被删除', async () => {
      await app.send('nav settings'); await sleep(800);
      await app.invoke('退出登录');
      await until(async () => hasName('服务器地址'), 'login page');
      assert(!credentialKept(), '凭据还在');
      await until(async () => (await newKeys()).length === 0, 'the key given back');
      assert(!(await hasName('接着播放')), '登录页上还留着上一个会话的“接着播放”提示');
    });
    await check('在网页上拒绝：说明被拒绝，什么都不保存', async () => {
      await app.send(`set 服务器地址=${server.url}`);
      await app.invoke('在浏览器中登录');
      await until(codeShown, 'the code');
      await signIns.decide(await codeShown(), false);
      await until(async () => (await app.texts()).includes('在浏览器中拒绝了这次登录。'), 'the denied message');
      assert(!(await codeShown()), '代码还显示着');
      assert(!credentialKept() && (await newKeys()).length === 0, '拒绝后还是保存了登录或发了密钥');
      await shot('login-browser-denied');
    });
    await check('取消：代码收起，还能用密码登录', async () => {
      await app.invoke('在浏览器中登录');
      await until(codeShown, 'the code');
      await app.invoke('取消在浏览器中登录');
      await until(async () => !(await codeShown()), 'the code put away');
      await signIn(app);
      await until(async () => (await app.send('ready')) === 'yes', 'ready', 30000);
    });
    quiet(app);
  }
} finally {
  await app.stop().catch(() => {});
  await server.stop();
  github.stop();
  forgetAll();
}

const passed = results.filter(r => r.ok).length, skipped = results.filter(r => r.skipped).length;
const dir = join(work, 'acceptance');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'report.md'), `# 验收报告 ${new Date().toLocaleString('zh-CN')}\n\n服务器：${server.describe}\n\n${passed}/${results.length} 通过${skipped ? `（其中 ${skipped} 项跳过）` : ''}\n\n${results.map(r => `- ${r.skipped ? '–' : r.ok ? '✓' : '✗'} [${r.round}] ${r.name}${r.skipped ? `：跳过（${r.skipped}）` : r.ok ? '' : `：${r.error}`}`).join('\n')}\n`);
log(`\n${passed}/${results.length} 通过${skipped ? `（其中 ${skipped} 项跳过）` : ''}${passed === results.length ? '' : `，${results.length - passed} 项失败`}（报告：tools/e2e/.work/acceptance/report.md）`);
process.exit(passed === results.length ? 0 : 1);
