// The CreeperUX icons for the Windows app: reads the kit's icon sets as foobar2k carries them (vendor/creeperux-gui/icons.js,
// media/icons.js and foobar2k's own src/icons.js: a 24 px grid, 1.6 px round strokes, the transport glyphs filled), and
// has tools/kit-outline (Direct2D) turn each into one filled outline: src/CreeperUX.Music/Controls/KitIcons.g.cs, which
// Controls/KitIcon draws with XAML's PathIcon. Needs the .NET SDK.
// Usage: node tools/kit-icons.mjs [path to the fb2k checkout, default ../fb2k]
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fb2k = resolve(process.argv[2] ?? join(root, '../fb2k'));
const F = 'fill="currentColor"';

/** The object literal after `start` in a file, evaluated (these are the user's own icon files: plain data). */
async function objectAfter(file, start) {
  const text = await readFile(join(fb2k, file), 'utf8');
  const at = text.indexOf(start);
  if (at < 0) throw new Error(`${file}: ${start} not found`);
  let i = text.indexOf('{', at), depth = 0, end = i;
  for (; end < text.length; end++) { if (text[end] === '{') depth++; else if (text[end] === '}' && --depth === 0) break; }
  return new Function('F', `return (${text.slice(i, end + 1)});`)(F);
}

/** SVG path data → XAML's path syntax: every command and number separated (SVG allows "2.7-.7", ".9.9", arc flags "011"). */
function normalize(d) {
  const out = [];
  let i = 0, cmd = '', arg = 0;
  const counts = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };
  const number = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/y;
  while (i < d.length) {
    const c = d[i];
    if (/[\s,]/.test(c)) { i++; continue; }
    if (/[a-zA-Z]/.test(c)) { cmd = c; arg = 0; out.push(c); i++; continue; }
    const n = counts[cmd.toUpperCase()];
    if ((cmd === 'A' || cmd === 'a') && (arg % 7 === 3 || arg % 7 === 4)) { out.push(d[i]); i++; arg++; continue; } // a flag: one digit
    number.lastIndex = i;
    const m = number.exec(d);
    if (!m) throw new Error(`bad path data at ${i}: ${d}`);
    out.push(String(+m[0]));
    i = number.lastIndex; arg++;
    if (n && arg % n === 0 && /^[Mm]$/.test(cmd)) cmd = cmd === 'M' ? 'L' : 'l'; // after a move, more pairs are lines
  }
  return out.join(' ');
}

const attrs = s => Object.fromEntries([...s.matchAll(/([\w-]+)="([^"]*)"/g)].map(m => [m[1], m[2]]));
function shapes(svg) {
  return [...svg.matchAll(/<(path|rect|circle)\b([^>]*?)\/?>/g)].map(([, tag, rest]) => {
    const a = attrs(rest), fill = a.fill === 'currentColor';
    if (tag === 'path') return { kind: 'p', data: normalize(a.d), fill };
    if (tag === 'rect') return { kind: 'r', data: [a.x ?? 0, a.y ?? 0, a.width, a.height, a.rx ?? 0].map(Number).join(' '), fill };
    return { kind: 'c', data: [a.cx, a.cy, a.r].map(Number).join(' '), fill };
  });
}

const sets = [
  await objectAfter('vendor/creeperux-gui/icons.js', 'const PATHS'),
  await objectAfter('vendor/creeperux-gui/media/icons.js', 'export const MEDIA_ICONS'),
  await objectAfter('src/icons.js', 'registerIcons('),
];
const icons = Object.assign({}, ...sets);
// the shapes, for tools/kit-outline to outline and write as C#
const input = join(await mkdtemp(join(tmpdir(), 'kit-icons-')), 'icons.json');
await writeFile(input, JSON.stringify(Object.fromEntries(Object.entries(icons).map(([name, svg]) => [name, shapes(svg)]))));
const output = join(root, 'src/CreeperUX.Music/Controls/KitIcons.g.cs');
const r = spawnSync('dotnet', ['run', '--project', join(root, 'tools/kit-outline'), '-c', 'Release', '--', input, output], { stdio: 'inherit' });
if (r.status !== 0) process.exit(r.status ?? 1);
console.log(`${Object.keys(icons).length} icons → src/CreeperUX.Music/Controls/KitIcons.g.cs`);
