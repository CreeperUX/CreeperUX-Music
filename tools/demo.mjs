// The demo in one command: starts the demo server (a fictitious library with generated music) and opens Sonus
// (the Windows app) signed out, with a button that signs in to the demo account. Closing the app stops the server.
//   npm run demo            the Windows app (built first when needed: needs the .NET 10 SDK)
//   npm run demo:browser    the web client in your default browser instead
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arch = process.arch === 'arm64' ? 'ARM64' : 'x64';
const exe = join(root, `src/Sonus/bin/${arch}/Release/net10.0-windows10.0.26100.0/win-${arch.toLowerCase()}/Sonus.exe`);
const browserMode = process.argv.includes('--browser');
const free = port => new Promise(ok => { const s = createServer().once('error', () => ok(false)).once('listening', () => s.close(() => ok(true))).listen(port, '127.0.0.1'); });
let port = 4533; // Navidrome's port; the next free one when it is taken (a real Navidrome may be running)
while (!(await free(port))) port++;

const server = spawn(process.execPath, [join(root, 'server/demo-server.mjs'), String(port)], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((ok, fail) => { server.stdout.on('data', d => { if (String(d).includes('demo server')) ok(); }); server.on('exit', () => fail(new Error('the demo server did not start'))); });
const site = `http://127.0.0.1:${port}`;
console.log(`演示服务器：${site}（账号 demo / demo；293 首歌、34 张专辑）`);
const stop = () => { server.kill(); process.exit(0); };
process.on('SIGINT', stop);

if (browserMode) {
  const url = `${site}/?demo=${encodeURIComponent(site)}#/`;
  spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref();
  console.log(`已在浏览器中打开 ${url}\n按 Ctrl+C 停止演示服务器。`);
} else {
  if (!existsSync(exe)) {
    console.log(`正在编译 Windows 程序（dotnet build，${arch}，第一次约需一分钟）…`);
    const b = spawnSync('dotnet', ['build', join(root, 'src/Sonus/Sonus.csproj'), `-p:Platform=${arch}`, '-c', 'Release', '-nologo', '-v:q'], { stdio: 'inherit' });
    if (b.status !== 0) { console.error('编译失败。也可以在浏览器里看演示：npm run demo:browser'); stop(); }
  }
  const app = spawn(exe, ['--demo', site], { stdio: 'ignore' });
  console.log('Sonus 已打开：点“使用本机的演示服务器”登录。关掉窗口，演示服务器也会停止。');
  app.on('exit', stop);
}
