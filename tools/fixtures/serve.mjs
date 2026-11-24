// Runs the frozen Navidrome on a fresh copy of the golden database (build.mjs), with the settings it was made with, so
// every run starts from the same state and nothing a test changes reaches the golden copy.
// Usage: node tools/fixtures/serve.mjs [--port <n>] [--data <folder>]   (until Ctrl+C; prints the URL)
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises';
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
/** Starts Navidrome on a copy of the golden database: { url, stop, data, manifest }. */
export async function serveGolden({ port, data, navidrome } = {}) {
  const manifest = await readManifest();
  const folder = data ?? join(WORK, 'runs', `${process.pid}-${Date.now()}-${runs++}`);
  await rm(folder, { recursive: true, force: true });
  await mkdir(folder, { recursive: true });
  await copyFile(join(GOLDEN, 'navidrome.db'), join(folder, 'navidrome.db'));
  const p = port ?? await freePort();
  const nd = await startNavidrome(navidrome ?? manifest.server.navidrome, {
    ...manifest.server.env, ND_DATAFOLDER: folder, ND_CACHEFOLDER: join(folder, 'cache'), ND_PORT: String(p), ND_SCANNER_SCANONSTARTUP: 'false',
  });
  return {
    url: nd.url, data: folder, manifest, log: nd.log,
    stop: async ({ keep = !!data } = {}) => { await nd.stop(); if (!keep) await rm(folder, { recursive: true, force: true }); },
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
