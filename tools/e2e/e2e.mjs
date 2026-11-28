// Driving an isolated, silent test instance of the Windows app (the approach of Lumen's tools/e2e):
// - built into tools/e2e/.work/build/<arch>, so a copy the user has open never locks the build;
// - its own data folder (.work/data-<name>), and a Credential Manager entry of this checkout's own ("Sonus-test-<run>:server",
//   <run> made from the .work folder's path: the instances of one run share it, runs from two checkouts never meet);
// - a cloaked window (rendered, never on screen, out of the taskbar, never activated), driven over a named pipe through
//   the app's E2E channel (src/Sonus/Testing/E2EChannel.cs): controls are found by accessible name;
// - screenshots with PrintWindow of the test window only (shot.ps1), and a quiet check after every round.
// Nothing here moves the mouse, presses keys or brings a window to the front.
import { spawn, execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const work = join(root, 'tools/e2e/.work');
export const shots = join(work, 'shots');
export const sleep = ms => new Promise(r => setTimeout(r, ms));
// SONUS_E2E_BUILD: another folder under .work for the test builds (when a copy in build/ is open and locked)
const BUILD = process.env.SONUS_E2E_BUILD || 'build';
export const exeFor = (arch = 'x64') => join(work, BUILD, arch, 'Sonus.exe');

/** Builds the app for tests; returns the result line. */
export function build(arch = 'x64') {
  const out = join(work, BUILD, arch);
  const r = spawnSync('dotnet', ['build', join(root, 'src/Sonus/Sonus.csproj'), `-p:Platform=${arch}`, `-p:OutDir=${out}\\`, '-nologo', '-v:q'], { encoding: 'utf8' });
  const problems = [...new Set((r.stdout + r.stderr).split(/\r?\n/).filter(l => /\b(error|warning) [A-Z]+\d+/.test(l)).map(l => l.replace(/\s*\[[^\]]+\]\s*$/, '').trim()))];
  return { ok: r.status === 0, line: `BUILD ${arch} exit=${r.status}`, problems };
}

/** The demo server on a free port. */
export async function startDemoServer({ scale = 1 } = {}) {
  const port = 4700 + Math.floor(Math.random() * 200);
  const p = spawn(process.execPath, [join(root, 'tools/demo-server/demo-server.mjs'), String(port), `--scale=${scale}`], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((ok, fail) => { p.stdout.on('data', d => { if (String(d).includes('demo server')) ok(); }); p.on('exit', fail); });
  const url = `http://127.0.0.1:${port}`;
  return { url, process: p, log: async () => (await fetch(`${url}/__test/log`)).json(), offline: on => fetch(`${url}/__test/offline?on=${on ? 1 : 0}`), stop: () => p.kill() };
}

/** Every test instance this process started, in order: a failed check keeps their logs (acceptance.mjs). */
export const instances = [];
// the instances end with this process: node's own exit kills what is left (the app also ends itself, SONUS_E2E_PARENT)
process.on('exit', () => { for (const a of instances) if (a.proc && !a.exit) { try { a.proc.kill(); } catch { /* gone */ } } });
const hex = n => `0x${(n >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;

/** A test instance: start(), send(command), shot(name), quiet(), stop(). */
export class TestApp {
  /** @param env more environment for the instance (SONUS_GITHUB_API: a fake GitHub) */
  constructor(name, { exe = exeFor(), demo = null, fresh = true, env = {} } = {}) {
    this.name = name; this.exe = exe; this.demo = demo; this.env = env;
    this.exit = null; // { code, signal, expected, at } once the process has ended
    this.data = join(work, `data-${name}`);
    this.pipe = `sonus-e2e-${name}-${process.pid}`;
    if (fresh) rmSync(this.data, { recursive: true, force: true });
    mkdirSync(this.data, { recursive: true });
    mkdirSync(shots, { recursive: true });
  }

  async start() {
    if (!existsSync(this.exe)) throw new Error(`${this.exe} not built (node tools/e2e/acceptance.mjs builds it)`);
    this.exit = null; this.stopping = false; this.reported = false;
    // Detached: outside node's job object (libuv's). That job sets SEM_NOGPFAULTERRORBOX on its processes: a crash in one
    // ends it with the exception code and nothing else, no Windows Error Reporting, no Application Error event, no dump.
    // Outside it a crash is reported as any app's (WER's local dumps keep a .dmp, which acceptance.mjs copies). The job
    // also ended the instances with node: SONUS_E2E_PARENT does that now (the app ends itself when this process ends).
    this.proc = spawn(this.exe, [], { env: { ...process.env, SONUS_E2E: this.pipe, SONUS_E2E_PARENT: String(process.pid), SONUS_E2E_SILENT: '1', SONUS_DATA_DIR: this.data, SONUS_TEST_CREDENTIAL: TEST_RUN, ...(this.demo ? { SONUS_DEMO: this.demo } : {}), ...this.env }, stdio: 'ignore', detached: true });
    this.proc.on('exit', (code, signal) => { this.exit = { code, signal, expected: this.stopping, at: new Date() }; });
    this.proc.on('error', e => { this.exit ??= { code: null, signal: null, error: e.message, expected: false, at: new Date() }; });
    this.pid = this.proc.pid;
    this.started = new Date();
    instances.push(this);
    for (let i = 0; i < 150; i++) {
      if (this.exit) throw new Error(`测试实例 ${this.name} 启动时就退出了，${this.exitText()}`);
      try {
        if ((await this.send('ping', 1500)) === 'pong') {
          this.pid = Number(await this.send('pid')); // the process that owns the window
          // another process answering on this pipe (an instance left from before with the same data folder): its exit
          // could not be seen here
          if (this.pid !== this.proc.pid) throw new Error(`测试实例 ${this.name} 的窗口属于进程 ${this.pid}，不是刚启动的 ${this.proc.pid}`);
          return this;
        }
      } catch (e) { if (e.message.startsWith('测试实例')) throw e; /* not up yet */ }
      await sleep(200);
    }
    throw new Error(`test instance ${this.name} did not open its pipe`);
  }

  /** One command over the pipe, one line back. Between two clients the app opens a new pipe instance: a connection
   *  that comes in that moment (ENOENT / EBUSY) waits and tries again, as NamedPipeClientStream.Connect(timeout) does. */
  async send(command, timeout = 15000) {
    const t0 = Date.now();
    for (;;) {
      if (this.died) throw new Error(this.diedText());
      try { return await this.#once(command, timeout); }
      catch (e) {
        if (['ENOENT', 'EBUSY'].includes(e.code) && Date.now() - t0 <= Math.min(timeout, 5000) && !this.exit) { await sleep(30); continue; }
        // the pipe broke ("write EOF") or went away because the process ended: say that, with its exit code
        if (this.proc && !this.stopping && !['ENOENT', 'EBUSY'].includes(e.code)) { for (let i = 0; i < 20 && !this.exit; i++) await sleep(50); }
        if (this.died) throw new Error(this.diedText());
        throw e;
      }
    }
  }

  /** The process ended without being told to (stop()): a crash, or something outside the test closed it. */
  get died() { return !!this.exit && !this.exit.expected; }
  /** How the process ended: its exit code in hex (a crash's is the exception code, 0xC0000005 say), or still running. */
  exitText() {
    if (!this.exit) return '还在运行';
    const { code, signal, error } = this.exit;
    if (error) return `启动失败：${error}`;
    return code === null || code === undefined ? `被结束（${signal}）` : `退出码 ${hex(code)}${signal ? `（${signal}）` : ''}`;
  }
  diedText() { return `测试实例意外退出，${this.exitText()}（${this.name}，进程 ${this.pid}）`; }

  #once(command, timeout) {
    return new Promise((ok, fail) => {
      const sock = connect(`\\\\.\\pipe\\${this.pipe}`);
      let buf = '';
      const timer = setTimeout(() => { sock.destroy(); fail(new Error(`timeout: ${command}`)); }, timeout);
      sock.on('connect', () => sock.write(`${command}\n`));
      sock.on('data', d => { buf += d; const nl = buf.indexOf('\n'); if (nl >= 0) { clearTimeout(timer); sock.end(); ok(buf.slice(0, nl).trim()); } });
      sock.on('error', e => { clearTimeout(timer); fail(e); });
    });
  }

  async state() { return JSON.parse(await this.send('state')); }
  async names() { return (await this.send('names')).split('\u001e'); }
  async texts() { return (await this.send('texts')).split('\u001e'); }
  async invoke(name) { const r = await this.send(`invoke ${name}`); if (r.startsWith('error')) throw new Error(r); return r; }

  async until(fn, what, ms = 8000) {
    const t0 = Date.now();
    for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`); await sleep(150); }
  }

  /** The window's content into .work/shots/<file>.png (rendered by the app itself: RenderTargetBitmap, popups included). */
  async shot(file) {
    const out = join(shots, `${file}.png`);
    const r = await this.send(`shot ${out}`, 30000);
    if (!r.startsWith('saved')) throw new Error(r);
    return out;
  }

  /** PrintWindow of the whole window (frame and caption buttons too) into .work/shots/<file>.png. */
  printWindow(file) {
    const out = join(shots, `${file}.png`);
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'tools/e2e/shot.ps1'), '-ProcessId', String(this.pid), '-Out', out], { encoding: 'utf8' });
    return out;
  }

  /** "QUIET <foreground process>" when the window stayed hidden and never took the foreground. */
  quiet() {
    return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'tools/e2e/shot.ps1'), '-ProcessId', String(this.pid), '-Quiet'], { encoding: 'utf8' }).trim();
  }

  async stop() {
    this.stopping = true;
    if (this.exit) return;
    try { await this.send('close', 3000); } catch { /* gone */ }
    for (let i = 0; i < 30 && !this.exit; i++) await sleep(100);
    if (!this.exit) { this.killed = true; this.proc.kill(); for (let i = 0; i < 40 && !this.exit; i++) await sleep(50); }
  }
}

// the test instances' Credential Manager entries: the sign-in ("server"; up to 0.5.0 also "github", the token updates
// needed while the repository was private, which the app now deletes). They carry this checkout's run name (the app reads
// SONUS_TEST_CREDENTIAL): all instances of a run share the sign-in (a second device signs in with the first one's), and two
// checkouts testing at the same time never see, write or delete each other's. The user's own "Sonus:server" is never touched.
export const TEST_RUN = createHash('sha1').update(work.toLowerCase()).digest('hex').slice(0, 8);
export const testCredential = name => `Sonus-test-${TEST_RUN}:${name}`;
export const TEST_CREDENTIAL = testCredential('server');
export const credentialKept = (name = 'server') => { try { return execFileSync('cmdkey', ['/list'], { encoding: 'utf8' }).includes(`target=${testCredential(name)}`); } catch { return false; } };
export const forgetCredential = (name = 'server') => { try { execFileSync('cmdkey', [`/delete:${testCredential(name)}`], { stdio: 'ignore' }); } catch { /* none */ } };

// the same entries as CreeperUX Music (the app's name up to 0.3) named them: Sonus takes those over when it starts
export const formerCredential = name => `CreeperUXMusic-test-${TEST_RUN}:${name}`;
export const formerCredentialKept = name => { try { return execFileSync('cmdkey', ['/list'], { encoding: 'utf8' }).includes(`target=${formerCredential(name)}`); } catch { return false; } };
export const forgetFormerCredential = name => { try { execFileSync('cmdkey', [`/delete:${formerCredential(name)}`], { stdio: 'ignore' }); } catch { /* none */ } };
/** Saves a test entry as CreeperUX Music did (a generic credential, the value as UTF-16), with CredWrite as the app does. */
export const writeFormerCredential = (name, user, value) => writeEntry(formerCredential(name), user, value);
/** The same under the test instances' own name (Sonus-test-<run>:<name>), as an earlier version left it. */
export const writeCredential = (name, user, value) => writeEntry(testCredential(name), user, value);
function writeEntry(target, user, value) {
  const script = `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class FormerCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct C { public uint Flags, Type; public string TargetName, Comment; public uint WrittenLow, WrittenHigh, BlobSize; public IntPtr Blob; public uint Persist, AttributeCount; public IntPtr Attributes; public string TargetAlias, UserName; }
  [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool CredWrite(ref C c, uint flags);
}
'@
$bytes = [Text.Encoding]::Unicode.GetBytes($env:FORMER_VALUE)
$blob = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
try {
  [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $blob, $bytes.Length)
  $c = New-Object FormerCred+C
  $c.Type = 1; $c.Persist = 2; $c.TargetName = $env:FORMER_TARGET; $c.UserName = $env:FORMER_USER; $c.Comment = 'CreeperUX Music: test entry'
  $c.BlobSize = $bytes.Length; $c.Blob = $blob
  if (-not [FormerCred]::CredWrite([ref]$c, 0)) { throw "CredWrite: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
} finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($blob) }`;
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, FORMER_TARGET: target, FORMER_USER: user, FORMER_VALUE: value }, stdio: ['ignore', 'ignore', 'pipe'] });
}

/** Windows' media control sessions (read-only): "AppUserModelId|title" per line. */
export function mediaSessions() {
  const script = `[Console]::OutputEncoding = [Text.Encoding]::UTF8
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
    $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
    function Await($op, $type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }
    $m = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
    foreach ($s in $m.GetSessions()) { $p = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]); "$($s.SourceAppUserModelId)|$($p.Title)|$($s.GetPlaybackInfo().PlaybackStatus)" }`;
  return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' }).trim().split(/\r?\n/).filter(Boolean);
}
