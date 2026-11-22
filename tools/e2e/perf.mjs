// How long the UI thread is blocked, on a library the size of a real one (the demo server with --scale): every command of
// the E2E channel runs on the UI thread, so a ping sent every 50 ms that takes long to come back is the window frozen
// that long. Reports the longest freeze during each action, and the working set.
// Usage: node tools/e2e/perf.mjs [--arch=x64|ARM64] [--scale=8]
import { startDemoServer, TestApp, sleep, exeFor, forgetCredential, build } from './e2e.mjs';
const arch = process.argv.find(a => a.startsWith('--arch='))?.slice(7) ?? (process.arch === 'arm64' ? 'ARM64' : 'x64');
const scale = Number(process.argv.find(a => a.startsWith('--scale='))?.slice(8) ?? 8);
if (!process.argv.includes('--no-build')) { const b = build(arch); console.log(b.line, b.problems.join(' | ')); if (!b.ok) process.exit(1); }
forgetCredential();
const server = await startDemoServer({ scale });
const app = await new TestApp('perf', { demo: server.url, exe: exeFor(arch) }).start();

/** Runs an action while pinging the UI thread; returns the longest ping and how long until the UI was idle again. */
async function measure(name, action, settle = 1500) {
  let worst = 0, running = true;
  const pinger = (async () => { while (running) { const t0 = Date.now(); await app.send('ping', 60000); worst = Math.max(worst, Date.now() - t0); await sleep(50); } })();
  const t0 = Date.now();
  await action();
  const took = Date.now() - t0;
  await sleep(settle);
  running = false; await pinger;
  const ws = Number(await app.send('ws'));
  console.log(`${name.padEnd(28)} ${String(took).padStart(6)} ms   最长卡顿 ${String(worst).padStart(5)} ms   内存 ${ws} MB`);
  return { name, took, worst, ws };
}
const results = [];
try {
  results.push(await measure('登录并载入曲库', async () => { await app.invoke('使用本机的演示服务器'); await app.until(async () => (await app.send('ready')) === 'yes', 'ready', 120000); }, 2500));
  const s = await app.state();
  console.log(`  曲库：${s.songs} 首，${s.albums} 张专辑，${s.playlists.length} 个歌单`);
  for (const route of ['playlist:library', 'home', 'album:al3', 'artist:ar5', 'playlist:liked', 'search:夜', 'shelf:recent', 'shelf:added', 'shelf:artists'])
    results.push(await measure(`打开 ${route}`, () => app.send(`nav ${route}`, 60000), 2000));
  await app.send('nav playlist:library', 60000); await sleep(1500);
  results.push(await measure('媒体库滚到底', () => app.send('scroll 100'), 2000));
  results.push(await measure('媒体库滚回中间', () => app.send('scroll 50'), 2000));
  await app.send('nav search:夜', 60000); await sleep(2500);
  results.push(await measure('搜索结果选“歌曲”', () => app.invoke('歌曲'), 2000));
  await app.send('shot tools/e2e/.work/shots/perf-search-songs.png', 30000);
  await app.send('nav playlist:library', 60000); await sleep(2000);
  await app.send('shot tools/e2e/.work/shots/perf-library.png', 30000);
  await app.send('scroll 40'); await sleep(800);
  await app.send('shot tools/e2e/.work/shots/perf-library-scrolled.png', 30000);
  await app.send('nav shelf:added', 60000); await sleep(2000);
  await app.send('shot tools/e2e/.work/shots/perf-added.png', 30000);
  await app.send('nav album:al3', 60000); await sleep(2000);
  await app.send('shot tools/e2e/.work/shots/perf-album.png', 30000);
  results.push(await measure('刷新（窗口回到前台）', () => app.send('do refresh'), 3000));
  results.push(await measure('点喜欢（重排音乐库）', () => app.send('do like t5 on'), 2000));
  results.push(await measure('播放专辑并切到下一首', async () => { await app.send('do play album al3 0'); await sleep(1500); await app.send('do next'); }, 2000));
  console.log(`\n最长卡顿：${Math.max(...results.map(r => r.worst))} ms；内存最高 ${Math.max(...results.map(r => r.ws))} MB；静默：${app.quiet()}`);
} finally { await app.stop(); server.stop(); forgetCredential(); }
