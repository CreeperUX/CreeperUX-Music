// The app icon: three level bars on an amber tile (a music app, legible at 16 px). Renders assets/icon.svg,
// assets/icon-<n>.png and assets/app.ico (used by the desktop app's window and taskbar button).
// Usage: node tools/icon.mjs   (needs playwright, and Python with Pillow for the .ico)
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const load = name => { for (const dir of [root, process.env.KIT_DIR, resolve(root, '../CreeperUX UI Kit'), resolve(root, '../fb2k')].filter(Boolean)) { try { return createRequire(join(dir, 'package.json')).resolve(name); } catch { /* next */ } } throw new Error(`${name} not found: run npm install`); };
const pw = await import(pathToFileURL(load('playwright')).href);
const { chromium } = pw.chromium ? pw : pw.default;

const INK = '#111416';
// the master, drawn on a 256 grid
const master = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffcf3d"/><stop offset="1" stop-color="#e59a00"/></linearGradient></defs>
  <rect x="8" y="8" width="240" height="240" rx="58" fill="url(#g)"/>
  <rect x="8.75" y="8.75" width="238.5" height="238.5" rx="57.25" fill="none" stroke="#000" stroke-opacity=".12" stroke-width="1.5"/>
  <rect x="58" y="100" width="36" height="96" rx="18" fill="${INK}"/>
  <rect x="110" y="56" width="36" height="140" rx="18" fill="${INK}"/>
  <rect x="162" y="124" width="36" height="72" rx="18" fill="${INK}"/>
</svg>`;
// small sizes: the same bars snapped to whole pixels
const small = n => {
  const u = n / 16, r = Math.round, bar = Math.max(2, r(2.2 * u)), gap = Math.max(2, r(1.4 * u)), base = r(12.5 * u);
  const x0 = r((n - (3 * bar + 2 * gap)) / 2);
  const col = (i, top) => `<rect x="${x0 + i * (bar + gap)}" y="${r(top * u)}" width="${bar}" height="${base - r(top * u)}" rx="${bar / 2}" fill="${INK}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${n}" height="${n}" viewBox="0 0 ${n} ${n}"><rect x="0.5" y="0.5" width="${n - 1}" height="${n - 1}" rx="${r(3.6 * u)}" fill="#f6b51c"/>${col(0, 6.25)}${col(1, 3.25)}${col(2, 8)}</svg>`;
};

const out = join(root, 'assets');
await mkdir(out, { recursive: true });
await writeFile(join(out, 'icon.svg'), `${master}\n`);
const browser = await chromium.launch(), page = await browser.newPage({ deviceScaleFactor: 1 });
const SIZES = [16, 20, 24, 32, 48, 64, 128, 256];
const files = [];
for (const n of SIZES) {
  const svg = n <= 32 ? small(n) : master.replace('<svg ', `<svg width="${n}" height="${n}" `);
  await page.setViewportSize({ width: n, height: n });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`);
  const file = join(out, `icon-${n}.png`);
  await page.locator('svg').screenshot({ path: file, omitBackground: true });
  files.push(file);
}
await browser.close();
execFileSync('python', [join(root, 'tools/pack-ico.py'), join(out, 'app.ico'), ...files], { stdio: 'inherit' });
console.log(`assets/icon.svg, ${SIZES.length} PNGs, assets/app.ico`);
