// Sonus Connect version 2 with two silent test instances of the Windows app (as acceptance.mjs round 6b does for version
// 1), against the demo server: one session on the server; the device that plays first is the active one and the other
// shows it ("正在「第一台」上播放") and controls it with commands; the device picker moves playback and sets the other's
// volume; a network loss doesn't stop the active device, which resumes; with no device left playing the session stays
// ("上次在「第二台」播放") and the next to press play continues it. No "接着上次听" toast anywhere (rule 6).
// It only uses e2e.mjs's helpers: isolated builds and data, the "Sonus-test" sign-in, hidden windows, no mouse or keys.
// Screenshots: .work/shots/c2-*.png (look at them).
// Usage: node tools/e2e/connect-v2.mjs [--arch=x64|ARM64] [--no-build]
import { build, startDemoServer, TestApp, sleep, exeFor, forgetCredential } from './e2e.mjs';

const args = process.argv.slice(2);
const arch = args.find(a => a.startsWith('--arch='))?.slice(7) ?? (process.arch === 'arm64' ? 'ARM64' : 'x64');
const exe = exeFor(arch);
const results = [];
const log = (...a) => console.log(...a);
async function check(name, fn) {
  const t0 = Date.now();
  try { await fn(); results.push({ name, ok: true }); log(`  ✓ ${name} (${Date.now() - t0} ms)`); }
  catch (e) { results.push({ name, ok: false }); log(`  ✗ ${name}: ${e.message.split('\n')[0]}`); }
}
const assert = (ok, msg) => { if (!ok) throw new Error(msg); };
function quiet(...apps) {
  for (const app of apps) {
    const q = app.quiet();
    results.push({ name: `静默 ${app.name}`, ok: q.startsWith('QUIET') });
    log(`  ${q.startsWith('QUIET') ? '✓' : '✗'} 静默检查（${app.name}）：${q}`);
  }
}

if (!args.includes('--no-build')) {
  const b = build(arch);
  log(b.line, b.problems.length ? `\n${b.problems.join('\n')}` : '');
  if (!b.ok) process.exit(1);
}
forgetCredential('server');
const server = await startDemoServer();
const hook = async (path, params = {}) => (await fetch(`${server.url}/__test/${path}?${new URLSearchParams({ u: 'demo', ...params })}`)).json();
const a = await new TestApp('connect2-a', { demo: server.url, exe, env: { SONUS_DEVICE_NAME: '第一台' } }).start();
let b = null;
const session = async app => (await app.state()).session;
const texts = async app => app.texts();
const noContinueToast = async app => { const s = await app.state(); assert(!(s.toasts ?? []).some(t => t.includes('接着')), `${app.name}: ${JSON.stringify(s.toasts)}`); };

try {
  log('\n第 1 步：两台设备登录，都用 Sonus Connect 第 2 版');
  await check('第一台登录（演示服务器），连上会话', async () => {
    await a.until(async () => (await a.names()).some(n => n.startsWith('使用本机的演示服务器 [')), 'the sign-in page', 30000);
    await a.invoke('使用本机的演示服务器');
    await a.until(async () => (await a.send('ready')) === 'yes', 'A signed in', 30000);
    await a.until(async () => (await session(a))?.connected, 'A has a session', 10000);
  });
  b = await new TestApp('connect2-b', { demo: server.url, exe, env: { SONUS_DEVICE_NAME: '第二台' } }).start();
  await check('第二台登录（同一个测试账号），两台都在设备列表里；没有“接着上次听”', async () => {
    await b.until(async () => (await b.send('ready')) === 'yes', 'B signed in', 30000);
    await b.until(async () => (await session(b))?.devices?.length === 2, 'B sees two devices', 10000);
    const s = await session(b);
    assert(s.devices.some(d => d.Name === '第一台') && s.devices.some(d => d.Name === '第二台'), JSON.stringify(s.devices));
    assert(s.id !== (await session(a)).id, '两台的设备 id 一样');
    await noContinueToast(a); await noContinueToast(b);
  });
  quiet(a, b);

  log('\n第 2 步：第一台放歌，第二台显示会话并遥控');
  let playing;
  await check('第一台放专辑：它是正在出声的设备；第二台显示同一首歌、“正在「第一台」上播放”，自己不出声', async () => {
    await a.send('do play album al3 0');
    await a.until(async () => (await a.state()).engine === 'Playing', 'A plays', 10000);
    playing = await a.state();
    assert(playing.session.here === true, JSON.stringify(playing.session));
    await b.until(async () => { const s = await b.state(); return s.track === playing.track && s.state === 'Playing'; }, 'B shows A\'s song playing', 8000);
    const s = await b.state();
    assert(s.engine === 'Stopped' && s.engineTrack === null, `第二台在出声：${s.engine} ${s.engineTrack}`);
    assert(s.session.active === '第一台', JSON.stringify(s.session));
    await b.until(async () => (await texts(b)).includes('正在「第一台」上播放'), 'the line in B\'s bar', 5000);
    assert((await texts(b)).includes(playing.trackTitle), '第二台的播放条没有那首歌');
    await b.send('nav settings'); // a page without "播放" buttons of its own
    await sleep(1500); // the position moves on
    const later = await b.state();
    assert(later.position > s.position, `第二台的进度没有走：${s.position} → ${later.position}`);
    await b.shot('c2-remote-playing');
  });
  await check('第二台按“下一首”：第一台换到下一首，第二台仍不出声', async () => {
    await b.invoke('下一首');
    await a.until(async () => { const s = await a.state(); return s.engineTrack && s.engineTrack !== playing.track && s.engine === 'Playing'; }, 'A moved on', 10000);
    const s = await a.state();
    await b.until(async () => (await b.state()).track === s.engineTrack, 'B shows it', 5000);
    assert((await b.state()).engine === 'Stopped', '第二台在出声');
    playing = s;
  });
  await check('第二台加歌到队列：第一台的队列里有它（只有一份队列）', async () => {
    await b.send('do queue t5');
    await a.until(async () => (await a.state()).manual === 1, 'A\'s queue has it', 5000);
    assert((await a.state()).queue[0] === 't5', JSON.stringify((await a.state()).queue));
    await b.until(async () => (await b.state()).manual === 1, 'B\'s too', 5000);
  });
  await check('第二台按暂停，第一台暂停；再按播放，第一台接着放', async () => {
    await b.invoke('暂停');
    await a.until(async () => (await a.state()).engine === 'Paused', 'A paused', 5000);
    await b.until(async () => (await b.names()).includes('播放 [Button]'), 'B shows it paused', 5000);
    await b.invoke('播放');
    await a.until(async () => (await a.state()).engine === 'Playing', 'A plays again', 8000);
  });
  quiet(a, b);

  log('\n第 3 步：设备列表');
  await check('第二台打开设备列表：两台设备，各有音量；调第一台的音量，第一台的音量跟着变', async () => {
    await b.invoke('正在「第一台」上播放，选择设备'); // the devices button, named for where it plays
    await b.until(async () => (await b.names()).some(n => n.startsWith('这台电脑 [')), 'the device list', 5000);
    const names = await b.names();
    assert(names.some(n => n.startsWith('第一台 [')) && names.some(n => n.startsWith('「第一台」的音量 [')) && names.some(n => n.startsWith('「这台电脑」的音量 [')), names.filter(n => n.includes('台')).join(' | '));
    await sleep(700); // the flyout fades in
    b.printWindow('c2-devices'); // a Flyout is not in the app's own (RenderTargetBitmap) shots
    const r = await b.send('set 「第一台」的音量=30');
    assert(r.startsWith('set'), r);
    await a.until(async () => Math.abs((await session(a)).devices.find(d => d.Name === '第一台')?.Volume - 0.3) < 0.011, 'A\'s volume is 0.3', 5000);
  });
  await check('选“这台电脑”：播放转到第二台，同一首、同一位置；第一台停下并显示“正在「第二台」上播放”', async () => {
    const before = await a.state();
    await b.invoke('这台电脑');
    await b.until(async () => { const s = await b.state(); return s.engine === 'Playing' && s.engineTrack === before.engineTrack; }, 'B plays A\'s song', 10000);
    await a.until(async () => (await a.state()).engine === 'Stopped', 'A stopped', 5000);
    const s = await b.state();
    assert(s.session.here === true, JSON.stringify(s.session));
    assert(Math.abs(s.enginePosition - before.enginePosition) < 5, `位置 ${s.enginePosition}，第一台是 ${before.enginePosition}`);
    await a.until(async () => (await texts(a)).includes('正在「第二台」上播放'), 'the line in A\'s bar', 5000);
    await a.shot('c2-moved');
  });
  await check('第一台（现在是遥控器）按暂停：第二台暂停；再播放', async () => {
    await a.send('nav settings');
    await a.invoke('暂停');
    await b.until(async () => (await b.state()).engine === 'Paused', 'B paused', 5000);
    await a.invoke('播放');
    await b.until(async () => (await b.state()).engine === 'Playing', 'B plays', 8000);
  });
  quiet(a, b);

  log('\n第 4 步：断网');
  await check('第二台断网超过 10 秒：一直在放；服务器上会话停在原处，回来后用 resume 接着当出声的设备', async () => {
    const id = (await session(b)).id;
    const dropped = await hook('connect2/drop', { device: id, hold: '12000' }); // refused for 12 s: past the 10 s grace period
    assert(dropped.dropped, JSON.stringify(dropped));
    await b.until(async () => (await session(b)).connected === false, 'B noticed', 5000);
    await a.until(async () => (await session(a)).active === null, 'the session stopped after the grace period', 15000);
    assert((await b.state()).engine === 'Playing', '第二台断网后停了');
    await a.until(async () => (await texts(a)).includes('上次在「第二台」播放'), 'A says where it played last', 5000);
    await b.until(async () => (await session(b)).connected === true, 'B reconnected', 30000);
    await a.until(async () => (await session(a)).active === '第二台', 'B is the active device again (resume)', 8000);
    const s = await b.state();
    assert(s.engine === 'Playing' && s.session.here, JSON.stringify({ engine: s.engine, here: s.session.here }));
    await a.until(async () => (await session(a)).playing === true, 'A shows it playing', 5000);
  });
  quiet(a, b);

  log('\n第 5 步：都不放了');
  await check('第二台暂停后关掉：会话留在服务器上，第一台显示“上次在「第二台」播放”', async () => {
    await b.invoke('暂停');
    await b.until(async () => (await b.state()).engine === 'Paused', 'B paused', 5000);
    const at = (await session(b)).position;
    await b.stop(); b = null;
    await a.until(async () => (await session(a)).active === null, 'no active device after the grace period', 15000);
    const s = await a.state();
    assert(s.session.track === playing.engineTrack || s.track, '会话没了');
    assert(Math.abs(s.session.position - at) < 2, `位置 ${s.session.position}，暂停时是 ${at}`);
    await a.until(async () => (await texts(a)).includes('上次在「第二台」播放'), 'the line', 5000);
    assert(s.engine === 'Stopped', '第一台在出声');
    await a.shot('c2-none-playing');
  });
  await check('第一台按播放：它成为出声的设备，从原处接着放', async () => {
    const at = (await session(a)).position;
    await a.invoke('播放');
    await a.until(async () => (await a.state()).engine === 'Playing', 'A plays', 10000);
    const s = await a.state();
    assert(s.session.here === true && s.session.active === '这台电脑', JSON.stringify(s.session)); // the app names itself so
    assert(Math.abs(s.enginePosition - at) < 4, `位置 ${s.enginePosition}，会话停在 ${at}`);
    await noContinueToast(a);
    await a.send('do pause');
  });
  quiet(a);
} finally {
  if (b) await b.stop();
  await a.stop();
  server.stop();
  forgetCredential('server');
}
const failed = results.filter(r => !r.ok);
log(`\n${results.length - failed.length} / ${results.length} 通过${failed.length ? `；没通过：${failed.map(r => r.name).join('；')}` : ''}`);
process.exit(failed.length ? 1 : 0);
