// The frozen Navidrome (the CreeperUX fork) for tests: found or built, and run on a data folder with the settings the
// golden database is made and served with.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const WORK = resolve(here, '..', '.work');
const EXE = process.platform === 'win32' ? 'navidrome.exe' : 'navidrome';
export const BIN = join(WORK, 'bin', EXE);
const FROZEN_TAG = 'v0.64.2'; // the Navidrome release the fork is frozen at (its creeperux-image.yml)

/** The fork's checkout: NAVIDROME_SRC, else a `navidrome` folder beside this repository's main checkout. */
export function forkSource() {
  if (process.env.NAVIDROME_SRC) return resolve(process.env.NAVIDROME_SRC);
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: here }).toString().trim();
  return resolve(common, '..', '..', 'navidrome');
}

/** The Navidrome to run: the one given, NAVIDROME_EXE, the one built before (.work/bin), or a new build of the fork. */
export function navidromeExe({ exe, rebuild = false } = {}) {
  if (exe) return resolve(exe);
  if (process.env.NAVIDROME_EXE) return resolve(process.env.NAVIDROME_EXE);
  if (existsSync(BIN) && !rebuild) return BIN;
  buildNavidrome(forkSource(), BIN);
  return BIN;
}

// A tool from PATH, else the newest one under ~/sdk/<prefix>*/bin.
function findTool(name, sdkPrefix) {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  for (const dir of (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')) if (dir && existsSync(join(dir, exe))) return dir;
  const sdk = join(homedir(), 'sdk');
  if (!existsSync(sdk)) return null;
  const dirs = readdirSync(sdk).filter(d => d.startsWith(sdkPrefix)).sort().reverse();
  for (const d of dirs) if (existsSync(join(sdk, d, 'bin', exe))) return join(sdk, d, 'bin');
  return null;
}

/**
 * Builds the fork as its image does (tags netgo,sqlite_fts5; version 0.64.2-sonus.<commits since 0.64.2>). On Windows
 * on ARM it builds for x64 with llvm-mingw's clang, as the fork is run there; NAVIDROME_GOARCH and NAVIDROME_CC
 * override the target and the C compiler.
 */
export function buildNavidrome(src, out) {
  if (!existsSync(join(src, 'go.mod'))) throw new Error(`no Navidrome checkout at ${src} (set NAVIDROME_SRC or NAVIDROME_EXE)`);
  const goDir = findTool('go', 'go');
  if (!goDir) throw new Error('Go not found (PATH or ~/sdk/go*/bin): set NAVIDROME_EXE to a built Navidrome instead');
  const env = { ...process.env, CGO_ENABLED: '1' };
  const path = [goDir];
  const winArm = process.platform === 'win32' && process.arch === 'arm64';
  const goarch = process.env.NAVIDROME_GOARCH ?? (winArm ? 'amd64' : undefined);
  const cc = process.env.NAVIDROME_CC ?? (winArm ? 'x86_64-w64-mingw32-clang' : undefined);
  if (goarch) env.GOARCH = goarch;
  if (cc) {
    env.CC = cc;
    env.CXX = cc.replace(/clang$/, 'clang++');
    const ccDir = findTool(cc, 'llvm-mingw');
    if (ccDir) path.push(ccDir);
  }
  env.PATH = [...path, env.PATH].join(process.platform === 'win32' ? ';' : ':');
  const git = (...args) => execFileSync('git', ['-C', src, ...args]).toString().trim();
  const n = git('rev-list', '--count', `${FROZEN_TAG}..HEAD`), sha = git('rev-parse', '--short', 'HEAD');
  const dirty = git('status', '--porcelain', '--untracked-files=no') ? '-dirty' : '';
  const ldflags = `-X github.com/navidrome/navidrome/consts.gitSha=${sha}${dirty} -X github.com/navidrome/navidrome/consts.gitTag=${FROZEN_TAG}-sonus.${n}`;
  mkdirSync(dirname(out), { recursive: true });
  console.log(`Building Navidrome ${FROZEN_TAG.slice(1)}-sonus.${n} (${sha}${dirty}) from ${src}${goarch ? ` for ${goarch}` : ''}…`);
  execFileSync(join(goDir, process.platform === 'win32' ? 'go.exe' : 'go'), ['build', '-tags', 'netgo,sqlite_fts5', '-ldflags', ldflags, '-o', out, '.'],
    { cwd: src, env, stdio: 'inherit' });
}

/** A free TCP port on 127.0.0.1. */
export function freePort() {
  return new Promise((done, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => done(port)); });
  });
}

/**
 * The settings the golden database is made and served with. Nothing reaches the network (no Last.fm, Deezer or
 * ListenBrainz, no usage statistics); sign-in rate limits are off so tests can run back to back; scans run only when
 * asked (and on start-up while the database is made); two-step verification is required, as the fork's default.
 */
export function navidromeEnv({ data, music, port, encryptionKey, scanOnStartup = false }) {
  return {
    ND_DATAFOLDER: data,
    ND_MUSICFOLDER: music,
    ND_CACHEFOLDER: join(data, 'cache'),
    ND_ADDRESS: '127.0.0.1',
    ND_PORT: String(port),
    ND_LOGLEVEL: 'warn',
    ND_PASSWORDENCRYPTIONKEY: encryptionKey,
    ND_SONUS_TWOFACTOR: 'required',
    ND_ENABLEEXTERNALSERVICES: 'false',
    ND_ENABLEINSIGHTSCOLLECTOR: 'false',
    ND_AUTHREQUESTLIMIT: '0',
    ND_SCANNER_SCANONSTARTUP: String(scanOnStartup),
    ND_SCANNER_SCHEDULE: '0',
    ND_SCANNER_WATCHERWAIT: '0',
    ND_ENABLEARTWORKPRECACHE: 'false',
  };
}

/** Runs Navidrome with these ND_ settings (the caller's own ND_ variables are dropped) until stop(). */
export async function startNavidrome(exe, ndEnv, { timeoutMs = 60_000 } = {}) {
  mkdirSync(ndEnv.ND_DATAFOLDER, { recursive: true });
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.toUpperCase().startsWith('ND_')));
  const proc = spawn(exe, [], { cwd: ndEnv.ND_DATAFOLDER, env: { ...env, ...ndEnv }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let log = '';
  const keep = d => { log = (log + d).slice(-200_000); };
  proc.stdout.on('data', keep); proc.stderr.on('data', keep);
  const exited = new Promise(done => proc.once('exit', code => done(code)));
  const url = `http://127.0.0.1:${ndEnv.ND_PORT}`;
  const stop = async () => {
    if (proc.exitCode !== null) return;
    if (process.platform === 'win32') {
      try { execFileSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone already */ }
    } else proc.kill('SIGTERM');
    await exited;
  };
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`Navidrome stopped (code ${proc.exitCode}):\n${log.slice(-4000)}`);
    try { if ((await fetch(`${url}/ping`)).ok) break; } catch { /* starting */ }
    if (Date.now() > deadline) { await stop(); throw new Error(`Navidrome did not answer in ${timeoutMs / 1000} s:\n${log.slice(-4000)}`); }
    await new Promise(done => setTimeout(done, 250));
  }
  return { url, proc, stop, log: () => log };
}

/**
 * Gives a user a new password with Navidrome's own command line (`navidrome user edit -u <user> --set-password`), on
 * the database `ndEnv` names, as Navidrome stores it. That command reads the password from a console only (it fails on
 * a pipe), so it runs in a pseudo console: lib/console-input.ps1 (ConPTY) on Windows, `script` elsewhere. The password
 * is handed over in the environment, never on a command line, and never printed.
 */
export function setPasswordWithCli(exe, ndEnv, user, password) {
  // (`user`: a user's id or name; ids need no quoting)
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.toUpperCase().startsWith('ND_'))), ...ndEnv };
  let out;
  if (process.platform === 'win32') {
    const script = resolve(here, '..', '..', 'contract', 'lib', 'console-input.ps1');
    out = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Exe', exe, '-ArgsLine', `user edit -u ${user} --set-password`, '-Cwd', ndEnv.ND_DATAFOLDER],
      { env: { ...env, CONSOLE_INPUT: [password, password].join('\n') }, cwd: ndEnv.ND_DATAFOLDER, windowsHide: true }).toString();
  } else {
    // util-linux script: the command runs on a new terminal, its input is this process's
    out = execFileSync('script', ['-qec', `"${exe}" user edit -u "${user}" --set-password`, '/dev/null'],
      { env, cwd: ndEnv.ND_DATAFOLDER, input: [password, password, ''].join('\n') }).toString();
  }
  const failed = out.split(/\r?\n/).filter(l => /level=(fatal|error)/.test(l));
  if (failed.length) throw new Error(`navidrome user edit failed: ${failed.join(' ')}`);
}

/**
 * Waits until Navidrome's background artwork work is done (artwork_queue empty). Until then the ids it gives cover art
 * change as the work goes on (al-<id> becomes al-<id>_<hash>), so a database copied earlier answers differently from
 * one copied later. Returns the rows left after the timeout.
 */
export async function waitForArtworkQueue(dbFile, { timeoutMs = 120_000 } = {}) {
  const { DatabaseSync } = await import('node:sqlite');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const db = new DatabaseSync(dbFile, { readOnly: true });
    let left;
    try { left = db.prepare('SELECT item_kind, item_id, attempts FROM artwork_queue').all(); } finally { db.close(); }
    if (!left.length || Date.now() > deadline) return left;
    await new Promise(done => setTimeout(done, 500));
  }
}

/** Moves what the WAL holds into the database file, so navidrome.db alone is the whole database. */
export async function checkpoint(dbFile) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbFile);
  try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } finally { db.close(); }
}
