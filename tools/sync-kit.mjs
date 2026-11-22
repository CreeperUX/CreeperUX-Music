// Copies CreeperUX UI Kit's built `kit/` at a release tag into vendor/creeperux-gui (the Vue wrapper is left out: this
// app is plain JavaScript). The files are read from Git at the tag, not from a working tree, so the snapshot is the
// tagged release exactly, whatever state a checkout or worktree is in.
// Usage: node tools/sync-kit.mjs [--tag=v2.5.0] [--repo=<a clone of CreeperUX/CreeperUX-UI-Kit>] [--check]
// Default repo: ../CreeperUX UI Kit (any clone or worktree; a missing tag is fetched from its origin).
// --check compares vendor/creeperux-gui with the tag and changes nothing (exit 1 when they differ).
// Local patches (web/vendor/creeperux-gui/PATCHES.md, lines marked "foobar2k patch Pn") are reported, not failed, by
// --check; a sync keeps PATCHES.md and reminds you to re-apply them.
import { rm, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const KIT_TAG = 'v2.5.0'; // the pinned UI Kit release: change it here and run this script to upgrade

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = k => process.argv.find(a => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const tag = arg('tag') || KIT_TAG, repo = resolve(arg('repo') || process.env.KIT_REPO || resolve(root, '../CreeperUX UI Kit'));
const checkOnly = process.argv.includes('--check');
const dest = join(root, 'web/vendor/creeperux-gui');
const git = (args, opts = {}) => execFileSync('git', args, { cwd: repo, maxBuffer: 1 << 28, ...opts });

const resolveTag = () => { try { return git(['rev-parse', '--verify', '--quiet', `${tag}^{commit}`], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return null; } };
let sha = resolveTag();
if (!sha) {
  try { git(['fetch', '--quiet', 'origin', 'tag', tag, '--no-tags'], { stdio: 'ignore' }); } catch { /* reported below */ }
  sha = resolveTag();
}
if (!sha) { console.error(`UI Kit tag ${tag} not found in ${repo} (nor on its origin). Pass --repo=<a clone of CreeperUX/CreeperUX-UI-Kit>.`); process.exit(1); }

// kit/ at the tag, without the Vue wrapper
const files = git(['ls-tree', '-r', '--name-only', sha, 'kit']).toString().split('\n').filter(f => f && !/^kit\/vue\//.test(f));
const blob = f => git(['show', `${sha}:${f}`]);
const version = blob('kit/VERSION').toString().trim();
if (`v${version}` !== tag) console.warn(`note: ${tag} says kit/VERSION ${version}`);
const source = `${tag} ${sha.slice(0, 7)}\nCreeperUX/CreeperUX-UI-Kit kit/ at tag ${tag} (${version}), without kit/vue; synced by tools/sync-kit.mjs\n`;

if (checkOnly) {
  const listed = async dir => (await readdir(dir, { recursive: true, withFileTypes: true })).filter(e => e.isFile()).map(e => relative(dest, join(e.parentPath ?? e.path, e.name)).replace(/\\/g, '/'));
  const have = new Set((await listed(dest).catch(() => [])).filter(f => f !== 'SOURCE' && f !== 'PATCHES.md'));
  const want = new Map(files.map(f => [f.slice('kit/'.length), f]));
  const missing = [...want.keys()].filter(f => !have.has(f)), extra = [...have].filter(f => !want.has(f));
  const changed = [];
  for (const [f, g] of want) if (have.has(f) && !(await readFile(join(dest, f))).equals(blob(g))) changed.push(f);
  // files that differ only because of a documented local patch
  const patched = [];
  for (const f of [...changed]) if ((await readFile(join(dest, f), 'utf8')).includes('foobar2k patch P')) { patched.push(f); changed.splice(changed.indexOf(f), 1); }
  const bad = missing.length + extra.length + changed.length;
  for (const [what, list] of [['missing', missing], ['not in the tag', extra], ['different', changed], ['local patch (PATCHES.md)', patched]]) if (list.length) console.log(`${what}: ${list.join(', ')}`);
  console.log(bad ? `vendor/creeperux-gui differs from UI Kit ${tag} (${sha.slice(0, 7)}): run npm run sync-kit` : `vendor/creeperux-gui matches UI Kit ${tag} (${sha.slice(0, 7)}), ${want.size} files`);
  process.exit(bad ? 1 : 0);
}

const patches = await readFile(join(dest, 'PATCHES.md')).catch(() => null);
await rm(dest, { recursive: true, force: true });
for (const f of files) {
  const to = join(dest, f.slice('kit/'.length));
  await mkdir(dirname(to), { recursive: true });
  await writeFile(to, blob(f));
}
await writeFile(join(dest, 'SOURCE'), source);
console.log(`vendor/creeperux-gui ← UI Kit ${tag} (${version}, ${sha.slice(0, 7)}), ${files.length} files`);
if (patches) { await writeFile(join(dest, 'PATCHES.md'), patches); console.log('note: web/vendor/creeperux-gui/PATCHES.md lists local patches; re-apply those the new kit does not carry yet'); }
