// Runs the frozen Navidrome on a fresh copy of the golden database (build.mjs), with the settings it was made with, so
// every run starts from the same state and nothing a test changes reaches the golden copy.
// Usage: node tools/fixtures/serve.mjs [--port <n>] [--data <folder>]   (until Ctrl+C; prints the URL)
import { copyFile, cp, mkdir, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { WORK, freePort, startNavidrome } from './lib/navidrome.mjs';

export const GOLDEN = join(WORK, 'golden');
export const MANIFEST = join(GOLDEN, 'manifest.json');

export async function readManifest(file = MANIFEST) {
  if (!existsSync(file)) throw new Error(`no manifest at ${file}: run node tools/fixtures/build.mjs first`);
  return JSON.parse(await readFile(file, 'utf8'));
}

let runs = 0;
/**
 * A fresh copy of the golden database in a folder of its own, and the settings Navidrome serves it with (all but its
 * port): { folder, manifest, env, remove }. `empty`: no database at all, so Navidrome starts as a new server without
 * users (with the same settings and music folder).
 */
export async function goldenCopy({ data, empty = false } = {}) {
  const manifest = await readManifest();
  const folder = data ?? join(WORK, 'runs', `${process.pid}-${Date.now()}-${runs++}`);
  await rm(folder, { recursive: true, force: true });
  await mkdir(folder, { recursive: true });
  if (!empty) {
    await copyFile(join(GOLDEN, 'navidrome.db'), join(folder, 'navidrome.db'));
    // with Navidrome's image store, which the database's artwork state points at
    if (existsSync(join(GOLDEN, 'artwork'))) await cp(join(GOLDEN, 'artwork'), join(folder, 'artwork'), { recursive: true });
  }
  const env = { ...manifest.server.env, ND_DATAFOLDER: folder, ND_CACHEFOLDER: join(folder, 'cache'), ND_SCANNER_SCANONSTARTUP: 'false' };
  // Windows lets go of a stopped server's files a moment after it is gone
  const remove = () => rm(folder, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  return { folder, manifest, env, remove };
}

/** Starts Navidrome on a copy of the golden database: { url, stop, data, manifest }. `env`: settings over the golden ones. */
export async function serveGolden({ port, data, navidrome, env = {}, empty = false } = {}) {
  const copy = await goldenCopy({ data, empty });
  const { manifest, folder } = copy;
  const p = port ?? await freePort();
  const nd = await startNavidrome(navidrome ?? manifest.server.navidrome, { ...copy.env, ...env, ND_PORT: String(p) });
  return {
    url: nd.url, data: folder, manifest, log: nd.log,
    stop: async ({ keep = !!data } = {}) => { await nd.stop(); if (!keep) await copy.remove(); },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { port: { type: 'string' }, data: { type: 'string' } } });
  const s = await serveGolden({ port: values.port ? Number(values.port) : undefined, data: values.data ? resolve(values.data) : undefined });
  console.log(`Navidrome (${s.manifest.server.serverVersion}) on the golden database: ${s.url}`);
  console.log(`  data: ${s.data}\n  manifest: ${MANIFEST}\nCtrl+C stops it.`);
  const quit = async () => { await s.stop(); process.exit(0); };
  process.on('SIGINT', quit); process.on('SIGTERM', quit);
}
