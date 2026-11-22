// Plays 40 songs in a row on a silent test instance and reports how long each took to start; a stall dumps the state.
// Usage: node tools/e2e/stress-load.mjs [--arch=x64|ARM64]
import { startDemoServer, TestApp, sleep, exeFor, forgetCredential } from './e2e.mjs';
const arch = process.argv.find(a => a.startsWith('--arch='))?.slice(7) ?? (process.arch === 'arm64' ? 'ARM64' : 'x64');
forgetCredential();
const server = await startDemoServer();
const app = await new TestApp('stress', { demo: server.url, exe: exeFor(arch) }).start();
let stalls = 0;
try {
  await app.invoke('使用本机的演示服务器');
  await app.until(async () => (await app.send('ready')) === 'yes', 'ready', 30000);
  await app.send('do volume 0.05');
  const times = [];
  for (let i = 0; i < 40; i++) {
    const album = `al${i % 33}`, t0 = Date.now();
    await app.send(`do play album ${album} ${i % 3}`);
    let s;
    for (;;) {
      s = await app.state();
      if (s.engine === 'Playing' && s.enginePosition > 0.05) break;
      if (Date.now() - t0 > 8000) { stalls++; console.log(`STALL #${i} ${album}:`, JSON.stringify({ state: s.state, engine: s.engine, track: s.track, engineTrack: s.engineTrack, next: s.engineNext, pos: s.enginePosition, err: s.error })); break; }
      await sleep(50);
    }
    times.push(Date.now() - t0);
    if (i % 4 === 3) { await app.send('do seek 30'); await sleep(200); }
  }
  times.sort((a, b) => a - b);
  console.log(`${arch}: 40 loads, median ${times[20]} ms, p90 ${times[36]} ms, max ${times[39]} ms, stalls ${stalls}`);
} finally { await app.stop(); server.stop(); forgetCredential(); }
