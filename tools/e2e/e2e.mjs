// Driving an isolated, silent test instance of the Windows app (the approach of Lumen's tools/e2e):
// - built into tools/e2e/.work/build/<arch>, so a copy the user has open never locks the build;
// - its own data folder (.work/data-<name>) and Credential Manager entry ("CreeperUXMusic-test:server");
// - a cloaked window (rendered, never on screen, out of the taskbar, never activated), driven over a named pipe through
//   the app's E2E channel (src/CreeperUX.Music/Testing/E2EChannel.cs): controls are found by accessible name;
// - screenshots with PrintWindow of the test window only (shot.ps1), and a quiet check after every round.
// Nothing here moves the mouse, presses keys or brings a window to the front.
import { spawn, execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const work = join(root, 'tools/e2e/.work');
export const shots = join(work, 'shots');
export const sleep = ms => new Promise(r => setTimeout(r, ms));
// CXMUSIC_E2E_BUILD: another folder under .work for the test builds (when a copy in build/ is open and locked)
const BUILD = process.env.CXMUSIC_E2E_BUILD || 'build';
export const exeFor = (arch = 'x64') => join(work, BUILD, arch, 'CreeperUX Music.exe');

/** Builds the app for tests; returns the result line. */
export function build(arch = 'x64') {
  const out = join(work, BUILD, arch);
  const r = spawnSync('dotnet', ['build', join(root, 'src/CreeperUX.Music/CreeperUX.Music.csproj'), `-p:Platform=${arch}`, `-p:OutDir=${out}\\`, '-nologo', '-v:q'], { encoding: 'utf8' });
  const problems = [...new Set((r.stdout + r.stderr).split(/\r?\n/).filter(l => /\b(error|warning) [A-Z]+\d+/.test(l)).map(l => l.replace(/\s*\[[^\]]+\]\s*$/, '').trim()))];
  return { ok: r.status === 0, line: `BUILD ${arch} exit=${r.status}`, problems };
}

/** The demo server on a free port. */
export async function startDemoServer({ scale = 1 } = {}) {
  const port = 4700 + Math.floor(Math.random() * 200);
  const p = spawn(process.execPath, [join(root, 'server/demo-server.mjs'), String(port), `--scale=${scale}`], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((ok, fail) => { p.stdout.on('data', d => { if (String(d).includes('demo server')) ok(); }); p.on('exit', fail); });
  const url = `http://127.0.0.1:${port}`;
  return { url, process: p, log: async () => (await fetch(`${url}/__test/log`)).json(), offline: on => fetch(`${url}/__test/offline?on=${on ? 1 : 0}`), stop: () => p.kill() };
}

/** A test instance: start(), send(command), shot(name), quiet(), stop(). */
export class TestApp {
  /** @param env more environment for the instance (CXMUSIC_GITHUB_API: a fake GitHub) */
  constructor(name, { exe = exeFor(), demo = null, fresh = true, env = {} } = {}) {
    this.name = name; this.exe = exe; this.demo = demo; this.env = env;
    this.data = join(work, `data-${name}`);
    this.pipe = `cxmusic-e2e-${name}-${process.pid}`;
    if (fresh) rmSync(this.data, { recursive: true, force: true });
    mkdirSync(this.data, { recursive: true });
    mkdirSync(shots, { recursive: true });
  }

  async start() {
    if (!existsSync(this.exe)) throw new Error(`${this.exe} not built (node tools/e2e/acceptance.mjs builds it)`);
    this.proc = spawn(this.exe, [], { env: { ...process.env, CXMUSIC_E2E: this.pipe, CXMUSIC_DATA_DIR: this.data, ...(this.demo ? { CXMUSIC_DEMO: this.demo } : {}), ...this.env }, stdio: 'ignore' });
    this.pid = this.proc.pid;
    for (let i = 0; i < 150; i++) {
      try {
        if ((await this.send('ping', 1500)) === 'pong') { this.pid = Number(await this.send('pid')); return this; } // the process that owns the window
      } catch { /* not up yet */ }
      await sleep(200);
    }
    throw new Error(`test instance ${this.name} did not open its pipe`);
  }

  /** One command over the pipe, one line back. Between two clients the app opens a new pipe instance: a connection
   *  that comes in that moment (ENOENT / EBUSY) waits and tries again, as NamedPipeClientStream.Connect(timeout) does. */
  async send(command, timeout = 15000) {
    const t0 = Date.now();
    for (;;) {
      try { return await this.#once(command, timeout); }
      catch (e) {
        if (!['ENOENT', 'EBUSY'].includes(e.code) || Date.now() - t0 > Math.min(timeout, 5000)) throw e;
        await sleep(30);
      }
    }
  }

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
    try { await this.send('close', 3000); } catch { /* gone */ }
    for (let i = 0; i < 30 && this.proc.exitCode === null; i++) await sleep(100);
    if (this.proc.exitCode === null) this.proc.kill();
  }
}

// the test instances' Credential Manager entries: the sign-in ("server") and the GitHub token for updates ("github")
export const TEST_CREDENTIAL = 'CreeperUXMusic-test:server';
const testCredential = name => `CreeperUXMusic-test:${name}`;
export const credentialKept = (name = 'server') => { try { return execFileSync('cmdkey', ['/list'], { encoding: 'utf8' }).includes(`target=${testCredential(name)}`); } catch { return false; } };
export const forgetCredential = (name = 'server') => { try { execFileSync('cmdkey', [`/delete:${testCredential(name)}`], { stdio: 'ignore' }); } catch { /* none */ } };

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
