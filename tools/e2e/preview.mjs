// Visible test preview for hands-on visual & motion review on the user's desktop:
// - builds into tools/e2e/.work/build-observe/<arch> so it never locks or touches the installed Sonus;
// - uses its own data folder (.work/data-observe) and its own Credential Manager entry (Sonus-test-observe:server),
//   separate from both the user's Sonus:server and acceptance.mjs's Sonus-test-<hash>:server;
// - marks the window clearly as a test build (a badge by the name, "[测试版]" in the title);
// - stops the local demo server and deletes Sonus-test-observe:server as soon as the window closes.
//
// Usage: node tools/e2e/preview.mjs [--arch=ARM64|x64] [--no-build] [--auto]
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { root, work } from './e2e.mjs';

const args = process.argv.slice(2);
const arch = args.find(a => a.startsWith('--arch='))?.slice(7) ?? (process.arch === 'arm64' ? 'ARM64' : 'x64');
const noBuild = args.includes('--no-build');
const autoLogin = args.includes('--auto');

const CRED_RUN = 'observe';
const CRED_TARGET = `Sonus-test-${CRED_RUN}:server`;
const outDir = join(work, 'build-observe', arch);
const exe = join(outDir, 'Sonus.exe');
const dataDir = join(work, 'data-observe');

function deleteObserveCred() {
  for (const name of ['server', 'github']) {
    try { execFileSync('cmdkey', [`/delete:Sonus-test-${CRED_RUN}:${name}`], { stdio: 'ignore' }); } catch { /* absent */ }
  }
}

function writeObserveCred(serverUrl) {
  const salt = 'obs070';
  const token = createHash('md5').update('demo' + salt).digest('hex');
  const value = JSON.stringify({ server: serverUrl, user: 'demo', salt, token });
  const script = `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class ObserveCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct C { public uint Flags, Type; public string TargetName, Comment; public uint WrittenLow, WrittenHigh, BlobSize; public IntPtr Blob; public uint Persist, AttributeCount; public IntPtr Attributes; public string TargetAlias, UserName; }
  [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool CredWrite(ref C c, uint flags);
}
'@
$bytes = [Text.Encoding]::Unicode.GetBytes($env:OBS_VALUE)
$blob = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
try {
  [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $blob, $bytes.Length)
  $c = New-Object ObserveCred+C
  $c.Type = 1; $c.Persist = 2; $c.TargetName = $env:OBS_TARGET; $c.UserName = 'demo'; $c.Comment = 'Sonus: visible preview test entry'
  $c.BlobSize = $bytes.Length; $c.Blob = $blob
  if (-not [ObserveCred]::CredWrite([ref]$c, 0)) { throw "CredWrite: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
} finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($blob) }`;
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, OBS_TARGET: CRED_TARGET, OBS_VALUE: value },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
}

if (!noBuild || !existsSync(exe)) {
  console.log(`正在编译可见测试版（${arch}）…`);
  const b = spawnSync('dotnet', ['build', join(root, 'src/Sonus/Sonus.csproj'), `-p:Platform=${arch}`, `-p:OutDir=${outDir}\\`, '-nologo', '-v:q'], { stdio: 'inherit' });
  if (b.status !== 0) process.exit(b.status ?? 1);
}

const isFree = port => new Promise(ok => {
  const s = createServer().once('error', () => ok(false)).once('listening', () => s.close(() => ok(true))).listen(port, '127.0.0.1');
});
let port = 4633;
while (!(await isFree(port))) port++;

deleteObserveCred();
rmSync(dataDir, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });

const server = spawn(process.execPath, [join(root, 'tools/demo-server/demo-server.mjs'), String(port)], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((ok, fail) => {
  server.stdout.on('data', d => { if (String(d).includes('demo server')) ok(); });
  server.on('exit', () => fail(new Error('演示服务器未能启动')));
});
const site = `http://127.0.0.1:${port}`;
if (autoLogin) writeObserveCred(site);

let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  try { server.kill(); } catch { /* gone */ }
  deleteObserveCred();
  console.log(`\n已停止演示服务器并清理测试凭据（${CRED_TARGET}）。`);
}
process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });
process.on('exit', cleanup);

console.log(`演示服务器：${site}（账号 demo / demo）`);
console.log(`数据目录：${dataDir}`);
console.log(`测试凭据：${CRED_TARGET}`);
console.log(autoLogin
  ? '已自动登录演示服务器。关掉窗口自动清理。'
  : '已打开可见测试版：点「使用本机的演示服务器」登录（或加 --auto 跳过登录页）。关掉窗口自动清理。');

const app = spawn(exe, ['--demo', site], {
  env: {
    ...process.env,
    SONUS_OBSERVE: '1',
    SONUS_DATA_DIR: dataDir,
    SONUS_TEST_CREDENTIAL: CRED_RUN,
  },
  stdio: 'ignore',
});
app.on('exit', () => { cleanup(); process.exit(0); });
