// The differential runner: replays a request corpus against two servers (A and B) on copies of the same database,
// normalizes the answers and reports every difference.
//
//   node tools/contract/diff.mjs --a <url> --b <url> --manifest <file> [--corpus <file>]
//   node tools/contract/diff.mjs --go-vs-gateway [--corpus <file>]
//       A: the frozen Navidrome on a fresh copy of the golden database;
//       B: the Rust server (`cargo run` in server/) running its own Navidrome on another copy, as its image does:
//          sign-ins are checked by the Rust server.
//   node tools/contract/diff.mjs --go-vs-go [--corpus <file>]
//       two Navidromes on two copies: shows what differs between two runs of the same server (should be nothing).
//   node tools/contract/diff.mjs --db <navidrome.db> --corpus <file> [--env ND_X=y …] [--json <file>]
//       the same as --go-vs-gateway on two copies of any Navidrome database (startPairOnDatabase): every user gets a
//       throwaway password on the copies; the corpus comes from corpus-from-db.mjs. Prints request names and the paths
//       that differ, never values; then who answered (counted, with the Rust server's reasons for leaving requests to
//       Navidrome) and the times per method, the servers asked one at a time. The original is never opened.
//       --release: the Rust server's release build (for the times; a release build does not mark its answers).
//   Options: --json <file> writes the full report (with the answers that differ: keep it where nothing is committed);
//   --only <text> runs the requests whose name contains it.
//
// The corpus (corpus/*.json): { volatile: [paths], requests: [request] }. A request:
//   { name, method: 'getAlbum', params: { id: '{{album.compilation}}' } }          a Subsonic call (GET)
//   { …, post: true }                                                             the same as a form post
//   { …, auth: 'listener' | 'none' | { user, as: 'token'|'password'|'enc'|'appPassword'|'apiKey' } }   default: the
//       manifest's primary user, by token (with a fixed salt, so both servers get the very same request)
//   { …, headers: { Range: 'bytes=0-99' } }
//   { name, path: '/auth/device/poll', httpMethod: 'POST', json: { … } }           any other route
//   { name, path: '/rest/ping', httpMethod: 'PUT', form: 'u=x&p=y' }               the same, with a form as its body
//   { …, for: ['track.flac', 'track.mp3'] }                                        one request per key: {{$}} is the key
//   { …, volatile: [paths], unordered: [paths] }                                   the same, for this request only
//   { …, navidrome: 'why' }                                                       a request to a method the Rust server
//       answers itself (ANSWERED_BY_RUST) that it must leave to Navidrome all the same, and why
//   { …, save: 'mine' }                                                          keep the playlist id each side's
//       answer made (createPlaylist) for later requests as {{saved.mine}}; answers show it as that placeholder
//   { …, waitMs: 500 }                                                            wait before sending it (for what a
//       server finishes in the background after its answer: a resized cover written to its cache)
// The corpus's volatile paths are left out of every comparison (serverVersion, times of the request); its unordered
// paths are arrays whose order means nothing (Go builds them from maps, in random order): compared sorted.
// Who answered: a debug build of the Rust server marks the answers it made itself (`x-sonus-answered: rust`).
// --go-vs-gateway checks the mark on every request: the methods the Rust server has taken over must carry it, unless
// the request says why not (`navidrome`); everything else must not.
// What the Rust server is meant to answer differently is not hidden as volatile: it is written down (EXPECTED, below)
// and applied to Navidrome's answer before the comparison, so the two must then be the same, field for field.
// Placeholders: {{key}} is the manifest's id for key, {{user.<name>}} a user's username, {{$}} the key of a `for`.
// Paths: dot-separated keys, * for any one key or array index, ** for any number (subsonic-response.**.roles).
// Answers: JSON is compared field by field, whatever the key order; anything else by status, a few headers, length and
// a hash of the bytes.
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { apiSecret, appendParams, authParams, API_VERSION } from './lib/subsonic.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const SALT = 'd1ff5a17';
const CLIENT = 'sonus-diff';
const COMPARED_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified', 'cache-control'];
// compared for JSON answers too, when either side sends them
const COMPARED_JSON_HEADERS = ['x-total-count'];
/** The header a debug build of the Rust server marks its own answers with (server/src/library/mod.rs). */
export const ANSWERED_HEADER = 'x-sonus-answered';
/** The Subsonic methods the Rust server answers itself from the database, in JSON, once the request is signed in. */
export const ANSWERED_BY_RUST = [
  'ping', 'getSong', 'getAlbum', 'getAlbumList2', 'search3', 'getStarred2', 'getPlaylists', 'getPlaylist', 'getPlayQueue', 'getLyricsBySongId', 'getCoverArt',
  // phase 4: writes
  'star', 'unstar', 'setRating', 'savePlayQueue', 'createPlaylist', 'updatePlaylist', 'deletePlaylist',
];

// ---------------------------------------------------------------- the corpus

export function expand(corpus) {
  const out = [];
  for (const r of corpus.requests) {
    if (!r.for) { out.push(r); continue; }
    for (const key of r.for) {
      const { for: _, ...rest } = r;
      // the key goes into JSON text: escaped as JSON escapes it (a key may hold quotes or a backslash)
      out.push(JSON.parse(JSON.stringify({ ...rest, name: `${r.name} ${key}` }).replaceAll('{{$}}', JSON.stringify(key).slice(1, -1))));
    }
  }
  return out;
}

function fill(value, manifest, saved = {}) {
  return JSON.parse(JSON.stringify(value).replace(/\{\{([^}]+)\}\}/g, (_, k) => {
    if (k.startsWith('user.')) return manifest.users[k.slice(5)]?.username ?? `(no user ${k.slice(5)})`;
    // an id this side's server made earlier in the corpus (a request's `save`)
    if (k.startsWith('saved.')) return saved[k.slice(6)] ?? `(nothing saved as ${k.slice(6)})`;
    const v = manifest.ids?.[k];
    if (v === undefined) throw new Error(`the manifest has no id for ${k}`);
    return v;
  }));
}

function signIn(auth, manifest) {
  if (auth === 'none') return {};
  const spec = typeof auth === 'string' ? { user: auth } : (auth ?? { user: manifest.primaryUser });
  const u = manifest.users[spec.user ?? manifest.primaryUser];
  if (!u) throw new Error(`the manifest has no user ${spec.user}`);
  switch (spec.as ?? 'token') {
    case 'apiKey': return { apiKey: u.apiKey };
    case 'appPassword': return authParams({ u: u.username, password: u.appPassword, as: 'token', salt: SALT });
    default: return authParams({ u: u.username, password: apiSecret(u), as: spec.as ?? 'token', salt: SALT });
  }
}

/** The fetch() arguments for a request against a base URL. */
function toFetch(base, r, manifest, saved) {
  const req = fill(r, manifest, saved);
  if (req.path) {
    const init = { method: req.httpMethod ?? 'GET', headers: { ...(req.headers ?? {}) } };
    if (req.json !== undefined) { init.body = JSON.stringify(req.json); init.headers['Content-Type'] = 'application/json'; }
    if (req.form !== undefined) { init.body = req.form; init.headers['Content-Type'] ??= 'application/x-www-form-urlencoded'; }
    return [`${base}${req.path}`, init];
  }
  const q = appendParams(new URLSearchParams(), { ...signIn(req.auth, manifest), v: API_VERSION, c: CLIENT, f: 'json', ...(req.params ?? {}) });
  if (req.post) {
    return [`${base}/rest/${req.method}`, { method: 'POST', body: q.toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(req.headers ?? {}) } }];
  }
  return [`${base}/rest/${req.method}?${q}`, { headers: { ...(req.headers ?? {}) } }];
}

// ---------------------------------------------------------------- answers, normalized

async function answer(base, r, manifest, saved) {
  const [url, init] = toFetch(base, r, manifest, saved);
  let res;
  const started = performance.now();
  try { res = await fetch(url, init); } catch (e) { return { error: `no answer: ${e.cause?.code ?? e.message}` }; }
  const buf = Buffer.from(await res.arrayBuffer());
  const ms = performance.now() - started;
  const type = res.headers.get('content-type') ?? '';
  const out = { status: res.status };
  Object.defineProperty(out, 'ms', { value: ms, enumerable: false });
  // who answered is not part of the comparison (Navidrome never says): kept beside the answer
  Object.defineProperty(out, 'answeredBy', { value: res.headers.get(ANSWERED_HEADER) ?? null, enumerable: false });
  if (/json/.test(type)) {
    out.contentType = type;
    const headers = Object.fromEntries(COMPARED_JSON_HEADERS.map(h => [h, res.headers.get(h)]).filter(([, v]) => v !== null));
    if (Object.keys(headers).length) out.headers = headers;
    try { out.json = buf.length ? JSON.parse(buf.toString('utf8')) : null; } catch { out.text = buf.toString('utf8').slice(0, 500); }
  } else {
    out.headers = Object.fromEntries(COMPARED_HEADERS.map(h => [h, res.headers.get(h)]).filter(([, v]) => v !== null));
    out.length = buf.length;
    out.sha256 = createHash('sha256').update(buf).digest('hex');
    if (/^text\//.test(type)) out.text = buf.toString('utf8').slice(0, 500);
  }
  return out;
}

/** Whether a path (an array of keys) matches a pattern: '*' is any one key, '**' any number of them. */
export function matches(path, pattern) {
  const p = typeof pattern === 'string' ? pattern.split('.') : pattern;
  if (!p.length) return !path.length;
  if (p[0] === '**') return matches(path, p.slice(1)) || (path.length > 0 && matches(path.slice(1), p));
  return path.length > 0 && (p[0] === '*' || p[0] === String(path[0])) && matches(path.slice(1), p.slice(1));
}

/** Every difference between a and b, as { path, a, b }: volatile paths are left out, unordered arrays compared sorted. */
export function compare(a, b, volatile, path = [], out = [], unordered = []) {
  if (volatile.some(v => matches(path, v))) return out;
  const kind = x => (x === null ? 'null' : Array.isArray(x) ? 'array' : typeof x);
  if (kind(a) !== kind(b)) { out.push({ path: path.join('.'), a, b }); return out; }
  if (kind(a) === 'array' && unordered.some(u => matches(path, u))) {
    const sorted = x => [...x].sort((p, q) => (JSON.stringify(p) < JSON.stringify(q) ? -1 : 1));
    [a, b] = [sorted(a), sorted(b)];
  }
  if (kind(a) === 'array') {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (i >= a.length || i >= b.length) { out.push({ path: [...path, i].join('.'), a: a[i], b: b[i] }); continue; }
      compare(a[i], b[i], volatile, [...path, i], out, unordered);
    }
  } else if (kind(a) === 'object') {
    for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      if (!(k in a) || !(k in b)) {
        if (!volatile.some(v => matches([...path, k], v))) out.push({ path: [...path, k].join('.'), a: a[k], b: b[k] });
        continue;
      }
      compare(a[k], b[k], volatile, [...path, k], out, unordered);
    }
  } else if (a !== b) out.push({ path: path.join('.'), a, b });
  return out;
}

const show = v => (v === undefined ? '(missing)' : JSON.stringify(v)?.slice(0, 160));

/**
 * Where the Rust server (B) is meant to answer differently from Navidrome alone (A), each as a change made to A's
 * answer before the comparison: the answers must then be the same, so anything else that differs still shows.
 */
export const EXPECTED = {
  /** The Rust server speaks Sonus Connect version 2 itself and adds it to Navidrome's list of extensions (version 1). */
  connectVersion2: {
    what: 'getOpenSubsonicExtensions: sonusConnect is [1, 2] from the Rust server ([1] from Navidrome alone)',
    apply(answerOfA) {
      const list = answerOfA.json?.['subsonic-response']?.openSubsonicExtensions;
      const connect = Array.isArray(list) && list.find(e => e.name === 'sonusConnect');
      if (connect && Array.isArray(connect.versions) && !connect.versions.includes(2)) connect.versions = [...connect.versions, 2].sort((x, y) => x - y);
    },
  },
};

/**
 * Whether the Rust server's own code must have answered a request: a method it has taken over, asked for in JSON,
 * that got past the sign-in (Navidrome's answer says so), unless the request says why it is Navidrome's.
 */
export function mustBeAnsweredByRust(r, answerOfNavidrome) {
  const method = (r.method ?? '').replace(/\.view$/, '');
  if (!ANSWERED_BY_RUST.includes(method) || r.navidrome) return false;
  // (a cover is a picture whatever format the request names)
  if (method !== 'getCoverArt' && (r.params && 'f' in r.params && r.params.f !== 'json')) return false;
  const error = answerOfNavidrome.json?.['subsonic-response']?.error;
  // refused at the sign-in: the method was never reached
  if (error && ([40, 43, 44].includes(error.code) || /^missing parameter: '[uvc]'$/.test(error.message ?? ''))) return false;
  return true;
}

export async function runDiff({ a, b, manifest, corpus, only, expected = [], whoAnswered = false, quiet = false, sequential = false, log = console.log }) {
  const requests = expand(corpus).filter(r => !only || r.name.includes(only));
  const results = [];
  const savedA = {}, savedB = {};
  let byRust = 0;
  for (const e of expected) log(`  expected to differ, and compared with that applied to A: ${e.what}`);
  for (const r of requests) {
    if (r.waitMs) await new Promise(done => setTimeout(done, r.waitMs));
    // sequential: one server at a time, so that neither one's time includes the other's work
    const [ra, rb] = sequential
      ? [await answer(a, r, manifest, savedA), await answer(b, r, manifest, savedB)]
      : await Promise.all([answer(a, r, manifest, savedA), answer(b, r, manifest, savedB)]);
    // save: the id each side's server made (`subsonic-response.playlist.id`), for later requests as {{saved.NAME}};
    // each side's ids are then written as that placeholder in its answers, so the two compare
    if (r.save) {
      savedA[r.save] = ra.json?.['subsonic-response']?.playlist?.id;
      savedB[r.save] = rb.json?.['subsonic-response']?.playlist?.id;
    }
    for (const [answerOf, saved] of [[ra, savedA], [rb, savedB]]) {
      if (answerOf.json && Object.keys(saved).length) answerOf.json = placeholders(answerOf.json, saved);
    }
    for (const e of expected) e.apply(ra);
    const inJson = v => (v.startsWith('json.') ? v : `json.${v}`);
    const volatile = [...(corpus.volatile ?? []), ...(r.volatile ?? [])].map(inJson);
    const unordered = [...(corpus.unordered ?? []), ...(r.unordered ?? [])].map(inJson);
    const diffs = compare(ra, rb, volatile, [], [], unordered);
    if (whoAnswered === 'count') {
      // only counted: on a database of unknown content, which requests the Rust server leaves to Navidrome is a finding
      if (rb.answeredBy === 'rust') byRust++;
    } else if (whoAnswered) {
      const must = mustBeAnsweredByRust(r, ra), did = rb.answeredBy === 'rust';
      if (must && !did) diffs.push({ path: '(who answered)', a: 'the Rust server is to answer this itself', b: 'left to Navidrome' });
      if (!must && did) diffs.push({ path: '(who answered)', a: r.navidrome ? `Navidrome is to answer this: ${r.navidrome}` : 'not a request the Rust server answers itself', b: 'answered by the Rust server' });
      if (did) byRust++;
    }
    results.push({
      name: r.name, method: r.method, same: diffs.length === 0, diffs, a: diffs.length ? ra : undefined, b: diffs.length ? rb : undefined,
      ms: { a: ra.ms, b: rb.ms }, answeredBy: rb.answeredBy,
    });
    if (!diffs.length) { if (!quiet) log(`  ✓ ${r.name}`); continue; }
    log(`  ✗ ${r.name}`);
    // quiet: where they differ, not what they say (the data may be private)
    if (quiet) { log(`      ${[...new Set(diffs.map(d => d.path || '(the answer)'))].slice(0, 12).join(', ')}`); continue; }
    for (const d of diffs.slice(0, 12)) log(`      ${d.path || '(the answer)'}:\n        A ${show(d.a)}\n        B ${show(d.b)}`);
    if (diffs.length > 12) log(`      … and ${diffs.length - 12} more`);
  }
  const different = results.filter(x => !x.same).length;
  log(`\n${results.length} requests: ${results.length - different} the same, ${different} different`);
  if (whoAnswered) log(`${byRust} answered by the Rust server itself (${ANSWERED_BY_RUST.join(', ')}), ${results.length - byRust} by Navidrome behind it or by the sign-in check`);
  return { requests: results.length, different, byRust, results, timings: timings(results) };
}

/** A JSON value with every string equal to a saved id written as its placeholder ({{saved.NAME}}). */
function placeholders(value, saved) {
  const names = new Map(Object.entries(saved).filter(([, id]) => id).map(([name, id]) => [id, `{{saved.${name}}}`]));
  const walk = v => (typeof v === 'string' ? (names.get(v) ?? v) : Array.isArray(v) ? v.map(walk) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : v);
  return walk(value);
}

/** Median and worst time per method, A and B: { method: { n, a: { median, worst }, b: { … } } } (ms, rounded). */
export function timings(results) {
  const out = {};
  const stat = list => {
    const s = list.filter(x => typeof x === 'number').sort((x, y) => x - y);
    return s.length ? { median: Math.round(s[Math.floor((s.length - 1) / 2)] * 10) / 10, worst: Math.round(s[s.length - 1] * 10) / 10 } : null;
  };
  for (const [method, list] of Object.entries(Object.groupBy(results, r => r.method ?? '(route)'))) {
    out[method] = { n: list.length, a: stat(list.map(r => r.ms?.a)), b: stat(list.map(r => r.ms?.b)) };
  }
  return out;
}

/**
 * Two copies of any Navidrome database, served as --go-vs-gateway serves the golden one: A, the frozen Navidrome alone;
 * B, the Rust server running its own Navidrome. Every user gets the same throwaway password on both copies, set with
 * Navidrome's own command line; the copies are removed by stop(). `env`: settings for both sides (over safe defaults:
 * no scans, no external services, no sign-in limits). Returns { a, b, manifest, stop, gatewayLog }: the manifest is
 * made here and held in memory only (users u1…un in the order they were created, as corpus-from-db.mjs names them).
 */
export async function startPairOnDatabase(file, { env = {}, navidrome, release = false } = {}) {
  const { databaseCopy } = await import('../fixtures/serve.mjs');
  const { freePort, navidromeExe, setPasswordWithCli, startNavidrome } = await import('../fixtures/lib/navidrome.mjs');
  const { DatabaseSync } = await import('node:sqlite');
  const { randomBytes } = await import('node:crypto');
  // the Navidrome the golden database was made with, when there is one (as --go-vs-gateway runs)
  const { readManifest } = await import('../fixtures/serve.mjs');
  const golden = await readManifest().catch(() => null);
  const exe = navidromeExe({ exe: navidrome ?? golden?.server?.navidrome });
  const settings = {
    ND_ADDRESS: '127.0.0.1', ND_LOGLEVEL: 'warn', ND_SONUS_TWOFACTOR: 'off', ND_ENABLEEXTERNALSERVICES: 'false',
    ND_ENABLEINSIGHTSCOLLECTOR: 'false', ND_AUTHREQUESTLIMIT: '0', ND_SCANNER_SCHEDULE: '0', ND_SCANNER_WATCHERWAIT: '0',
    ND_ENABLEARTWORKPRECACHE: 'false', ...env,
  };
  const copies = [await databaseCopy(file, { env: settings }), await databaseCopy(file, { env: settings })];
  const stops = [];
  const stop = async () => { for (const s of stops.reverse()) await s(); for (const c of copies) await c.remove(); };
  try {
    const db = new DatabaseSync(copies[0].db);
    const users = db.prepare('select id, user_name from user order by created_at, id').all();
    db.close();
    const manifest = { primaryUser: 'u1', users: {}, ids: {}, server: { navidrome: exe } };
    users.forEach((u, i) => { manifest.users[`u${i + 1}`] = { id: u.id, username: u.user_name, password: randomBytes(12).toString('hex') }; });
    for (const c of copies) for (const u of Object.values(manifest.users)) setPasswordWithCli(exe, c.env, u.id, u.password);
    const go = await startNavidrome(exe, { ...copies[0].env, ND_PORT: String(await freePort()) });
    stops.push(go.stop);
    const gw = await startGatewayOnGolden({ copy: { ...copies[1], manifest }, navidrome: exe, env: { SONUS_LOG: 'debug' }, release });
    stops.push(() => gw.stop({ keep: true }));
    // what each copy holds: the music is not there, so a scan would mark every song missing; this shows none ran
    const holds = () => copies.map(c => {
      const d = new DatabaseSync(c.db, { readOnly: true });
      try { return d.prepare('select count(*) as songs, coalesce(sum(missing), 0) as missing from media_file').get(); } finally { d.close(); }
    });
    return { a: go.url, b: gw.url, manifest, stop, holds, files: copies.map(c => c.db), gatewayLog: gw.log, navidromeLog: go.log };
  } catch (e) { await stop(); throw e; }
}

/**
 * The two sides' databases after a corpus, table by table (db-state.mjs): prints the counts and every row one side has
 * and the other has not (quiet: the tables and how many rows, not the rows), and returns those rows.
 */
export async function stateReport(files, { since, before, quiet = false, log = console.log }) {
  const { dumpState, compareState, counts, settle } = await import('./db-state.mjs');
  const left = await settle(files);
  if (left.some(n => n)) log(`  (playlists still in Navidrome's artwork queues after 30 s: ${left.join(' / ')})`);
  const [sa, sb] = files.map(f => dumpState(f, { since, before }));
  const diffs = compareState(sa, sb);
  log(`
The databases after the corpus (rows per table, A / B):`);
  const ca = counts(sa), cb = counts(sb);
  for (const t of Object.keys(ca)) log(`  ${t.padEnd(18)} ${String(ca[t]).padStart(6)} / ${cb[t]}`);
  if (!diffs.length) log('  the same, row for row (times written during the run and new ids normalized)');
  else if (quiet) for (const [t, list] of Object.entries(Object.groupBy(diffs, d => d.table))) log(`  ✗ ${t}: ${list.length} rows differ`);
  else for (const d of diffs) log(`  ✗ ${d.table}  ${d.a ? `A only: ${d.a}` : `B only: ${d.b}`}`);
  return diffs;
}

/** The requests the Rust server left to Navidrome, counted by method and reason, from its debug log. */
export function passThroughReasons(log) {
  const out = {};
  // tracing writes the message, then the fields (a text field in quotes): … Navidrome method="getAlbum" why="…"
  for (const m of log.matchAll(/leaves a request to Navidrome method="?([^"\s]+)"? why="((?:[^"\\]|\\.)*)"/g)) {
    const key = `${m[1]}: ${m[2]}`;
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

// ---------------------------------------------------------------- servers for the comparisons

// `cargo run` in server/ with these settings, from `cwd`, until `ready(url)` holds: { url, stop, log }.
async function runGateway({ env, cwd, port, ready, release = false }) {
  // the caller's own ND_ and SONUS_ variables stay out, as for the Navidrome the tests run
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ND_|SONUS_)/i.test(k)));
  const all = { ...clean, SONUS_LOG: process.env.SONUS_LOG ?? 'warn', ...env, ND_ADDRESS: '127.0.0.1', ND_PORT: String(port) };
  const proc = spawn('cargo', ['run', '--quiet', ...(release ? ['--release'] : []), '--manifest-path', join(root, 'server', 'Cargo.toml')], { cwd, env: all, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let log = '';
  proc.stdout.on('data', d => { log += d; }); proc.stderr.on('data', d => { log += d; });
  const exited = new Promise(done => proc.once('exit', done));
  const url = `http://127.0.0.1:${port}`;
  const stop = async () => {
    if (proc.exitCode !== null) return;
    if (process.platform === 'win32') {
      const { execFileSync } = await import('node:child_process');
      try { execFileSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
    } else proc.kill('SIGTERM');
    await exited;
  };
  for (let i = 0; ; i++) {
    if (proc.exitCode !== null) throw new Error(`the gateway stopped:\n${log.slice(-3000)}`);
    try { if (await ready(url)) break; } catch { /* building or starting */ }
    if (i > 1200) { await stop(); throw new Error(`the gateway did not answer in 10 minutes:\n${log.slice(-3000)}`); }
    await new Promise(done => setTimeout(done, 500));
  }
  return { url, stop, log: () => log };
}

/**
 * The Rust gateway (`cargo run` in server/) in front of a server that runs on its own: { url, stop, log }. Everything
 * passes through; sign-ins are that server's to check.
 */
export async function startGateway(upstream) {
  const { freePort } = await import('../fixtures/lib/navidrome.mjs');
  return runGateway({ env: { SONUS_NAVIDROME_URL: upstream }, cwd: join(root, 'server'), port: await freePort(), ready: async url => (await fetch(`${url}/ping`)).status > 0 });
}

/**
 * The Rust server as its image runs it: `cargo run` in server/, which starts the frozen Navidrome itself on a fresh
 * copy of the golden database, tells it to believe the gateway alone, and checks sign-ins itself:
 * { url, stop, log, data, manifest }. `env`: settings over the golden ones (both servers read them); `empty`: a new
 * server without users instead of the golden database; `navidrome`: another build of the fork than the fixtures'. The
 * log is the gateway's and Navidrome's together.
 */
export async function startGatewayOnGolden({ env = {}, empty = false, copy: started = null, navidrome = null, release = false } = {}) {
  const { freePort } = await import('../fixtures/lib/navidrome.mjs');
  const { goldenCopy } = await import('../fixtures/serve.mjs');
  // `copy`: the `copy` of a server stopped with stop({ keep: true }): the same data folder again (a restart)
  const copy = started ?? await goldenCopy({ empty });
  const settings = { ...copy.env, ...env, SONUS_NAVIDROME_BIN: navidrome ?? copy.manifest.server.navidrome, SONUS_NAVIDROME_PORT: String(await freePort()) };
  // up when Navidrome answers behind it and the gateway has checked the database (503 until then)
  const ready = async url => (await fetch(`${url}/rest/ping?f=json`)).status === 200;
  let gw;
  try { gw = await runGateway({ env: settings, cwd: copy.folder, port: await freePort(), ready, release }); } catch (e) { await copy.remove(); throw e; }
  // navidrome: the Navidrome it runs, for a test that asks it directly (its own web UI, a write made by Go)
  return { ...gw, data: copy.folder, manifest: copy.manifest, copy, navidrome: `http://127.0.0.1:${settings.SONUS_NAVIDROME_PORT}`, stop: async ({ keep = false } = {}) => { await gw.stop(); if (!keep) await copy.remove(); } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: {
    a: { type: 'string' }, b: { type: 'string' }, manifest: { type: 'string' }, corpus: { type: 'string' },
    'go-vs-gateway': { type: 'boolean' }, 'go-vs-go': { type: 'boolean' }, json: { type: 'string' }, only: { type: 'string' },
    state: { type: 'boolean' },
    db: { type: 'string' }, env: { type: 'string', multiple: true }, release: { type: 'boolean' },
  } });
  if (values.db) {
    if (!values.corpus) throw new Error('--db needs --corpus (node tools/contract/corpus-from-db.mjs makes one)');
    const corpus = JSON.parse(await readFile(resolve(values.corpus), 'utf8'));
    const env = Object.fromEntries((values.env ?? []).map(kv => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]));
    console.log('Copying the database twice and setting throwaway passwords; starting Navidrome (A) and the Rust server (B)…');
    const pair = await startPairOnDatabase(resolve(values.db), { env, release: !!values.release });
    // a release build does not mark its own answers: who answered is then known from its log only
    if (values.release) console.log('A release build of the Rust server: for the times; it does not mark the answers it made itself');
    try {
      const show = h => h.map((x, i) => `${'AB'[i]}: ${x.songs} songs, ${x.missing} missing`).join('; ');
      console.log(`Before: ${show(pair.holds())}`);
      // quiet: request names and paths only (the database may be private); one server at a time, for the timings
      const before = values.state ? (await import('./db-state.mjs')).knownIds(pair.files[0]) : null, since = Date.now();
      const report = await runDiff({ a: pair.a, b: pair.b, manifest: pair.manifest, corpus, only: values.only, whoAnswered: values.release ? false : 'count', quiet: true, sequential: true });
      if (values.state) report.state = await stateReport(pair.files, { since, before, quiet: true });
      report.passedToNavidrome = passThroughReasons(pair.gatewayLog());
      if (values.release) {
        const left = Object.values(report.passedToNavidrome).reduce((x, y) => x + y, 0);
        console.log(`${left} left to Navidrome by the Rust server's log; the rest answered by the Rust server or refused at the sign-in`);
      }
      console.log('\nLeft to Navidrome, by method and reason:');
      for (const [why, n] of Object.entries(report.passedToNavidrome).sort((x, y) => y[1] - x[1])) console.log(`  ${String(n).padStart(6)}  ${why}`);
      console.log('\nTimes (ms), median / worst, A: Navidrome alone, B: the Rust server:');
      for (const [method, t] of Object.entries(report.timings)) console.log(`  ${method.padEnd(18)} ${String(t.n).padStart(5)}   A ${t.a?.median} / ${t.a?.worst}   B ${t.b?.median} / ${t.b?.worst}`);
      // the gateway's own warnings (Navidrome's log lines, mixed in, say level=…)
      const warnings = pair.gatewayLog().split(/\r?\n/).filter(l => /\b(WARN|ERROR)\b/.test(l)).length;
      console.log(`\nThe Rust server's log: ${warnings} warning or error lines`);
      console.log(`After: ${show(pair.holds())}`);
      if (values.json) await writeFile(resolve(values.json), JSON.stringify(report, null, 2));
      process.exitCode = report.different ? 1 : 0;
    } finally {
      await pair.stop();
    }
    process.exit();
  }
  const corpus = JSON.parse(await readFile(values.corpus ? resolve(values.corpus) : join(here, 'corpus', 'read-only.json'), 'utf8'));
  const stops = [], files = [];
  let a = values.a, b = values.b, manifest, expected = [], whoAnswered = false;
  try {
    if (values['go-vs-gateway'] || values['go-vs-go']) {
      const { serveGolden } = await import('../fixtures/serve.mjs');
      const goA = await serveGolden(); stops.push(goA.stop);
      files.push(join(goA.data, 'navidrome.db'));
      manifest = goA.manifest;
      a = goA.url;
      if (values['go-vs-gateway']) {
        console.log('Starting the Rust server (cargo run in server/; the first build takes a while)…');
        const gw = await startGatewayOnGolden(); stops.push(gw.stop);
        files.push(join(gw.data, 'navidrome.db'));
        b = gw.url;
        expected = [EXPECTED.connectVersion2];
        whoAnswered = true;
        console.log(`A: Navidrome ${manifest.server.serverVersion} at ${a}\nB: the Rust server at ${b}, running its own Navidrome on another copy of the golden database\n`);
      } else {
        const goB = await serveGolden(); stops.push(goB.stop);
        files.push(join(goB.data, 'navidrome.db'));
        b = goB.url;
        console.log(`A: Navidrome at ${a}\nB: Navidrome at ${b} (another copy of the golden database)\n`);
      }
    } else {
      if (!a || !b || !values.manifest) throw new Error('--a, --b and --manifest are needed (or --go-vs-gateway, --go-vs-go)');
      manifest = JSON.parse(await readFile(resolve(values.manifest), 'utf8'));
      console.log(`A: ${a}\nB: ${b}\n`);
    }
    const before = values.state && files.length === 2 ? (await import('./db-state.mjs')).knownIds(files[0]) : null, since = Date.now();
    const report = await runDiff({ a, b, manifest, corpus, only: values.only, expected, whoAnswered });
    if (values.state) {
      if (files.length !== 2) throw new Error('--state needs --go-vs-gateway, --go-vs-go or --db: the databases of both sides');
      report.state = await stateReport(files, { since, before });
      if (report.state.length) process.exitCode = 1;
    }
    if (values.json) await writeFile(resolve(values.json), JSON.stringify(report, null, 2));
    process.exitCode = report.different ? 1 : 0;
  } finally {
    for (const stop of stops.reverse()) await stop();
  }
}
