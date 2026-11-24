// Runs the contract suite (test/*.test.mjs, node:test) against a server.
//
//   node tools/contract/run.mjs                              the frozen Navidrome on a fresh copy of the golden database
//                                                            (tools/fixtures/build.mjs makes it; stopped afterwards)
//   node tools/contract/run.mjs --base <url> --manifest <file>   a server that runs already
//   node tools/contract/run.mjs --demo                       the demo server (tools/demo-server), started for the run
//   node tools/contract/run.mjs --through-gateway            the Rust server (cargo run in server/) running the golden
//                                                            Navidrome behind it, as its image does: it checks sign-ins
//   … [--only <name pattern>] [test file names…]
//
// The tests run one file at a time: some change the user's state (stars, the play queue) and put it back.
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');

async function startDemo() {
  const { freePort } = await import('../fixtures/lib/navidrome.mjs');
  const port = await freePort();
  const proc = spawn(process.execPath, [join(root, 'tools/demo-server/demo-server.mjs'), String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${url}/rest/ping?f=json`)).status) break; } catch { /* starting */ }
    await new Promise(done => setTimeout(done, 100));
  }
  return { url, stop: async () => { proc.kill(); } };
}

const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export async function runSuite({ base, manifest, only, files = [] }) {
  const all = readdirSync(join(here, 'test')).filter(f => f.endsWith('.test.mjs')).sort();
  const chosen = files.length ? all.filter(f => files.some(x => f.includes(x))) : all;
  // A server's known differences (its manifest's knownDifferences: tests it is not expected to pass, and why).
  const known = JSON.parse(readFileSync(manifest, 'utf8')).knownDifferences ?? [];
  for (const k of known) console.log(`  skipped, a known difference: “${k.test}”: ${k.why}`);
  const args = ['--test', '--test-concurrency=1', ...(only ? ['--test-name-pattern', only] : []),
    ...known.flatMap(k => ['--test-skip-pattern', escape(k.test)]), ...chosen.map(f => join(here, 'test', f))];
  const child = spawn(process.execPath, args, { stdio: 'inherit', env: { ...process.env, CONTRACT_BASE_URL: base, CONTRACT_MANIFEST: manifest } });
  return new Promise(done => child.once('exit', code => done(code ?? 1)));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    base: { type: 'string' }, manifest: { type: 'string' }, demo: { type: 'boolean' }, only: { type: 'string' },
    'through-gateway': { type: 'boolean' },
  } });
  const stops = [];
  let manifest = values.manifest && resolve(values.manifest), base = values.base, what = '';
  if (values.demo) {
    const demo = await startDemo(); stops.push(demo.stop);
    base = demo.url;
    manifest ??= join(here, 'manifests', 'demo.json');
    what = ' (the demo server)';
  } else if (!base && values['through-gateway']) {
    const { MANIFEST } = await import('../fixtures/serve.mjs');
    const { startGatewayOnGolden } = await import('./diff.mjs');
    console.log('Starting the Rust server (cargo run in server/)…');
    const gw = await startGatewayOnGolden(); stops.push(gw.stop);
    base = gw.url;
    manifest ??= MANIFEST;
    what = ` (the Rust server, running Navidrome ${gw.manifest.server.serverVersion} behind it, golden database)`;
  } else if (!base) {
    const { serveGolden, MANIFEST } = await import('../fixtures/serve.mjs');
    const go = await serveGolden(); stops.push(go.stop);
    base = go.url;
    manifest ??= MANIFEST;
    what = ` (Navidrome ${go.manifest.server.serverVersion}, golden database)`;
  }
  if (!manifest) throw new Error('--manifest is needed with --base');
  console.log(`Contract suite against ${base}${what}`);
  let code = 1;
  try { code = await runSuite({ base, manifest, only: values.only, files: positionals }); } finally { for (const stop of stops.reverse()) await stop(); }
  process.exit(code);
}
