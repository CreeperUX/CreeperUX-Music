// The CreeperUX Music icon (in use: "ring", the same as foobar2k's): candidate designs (a detailed master for 48 px and up, a version drawn on the pixel grid for
// 16–32 px), the preview sheet, and the build. Same family as foobar2k's icon (fb2k's tools/icons.mjs): an ink or amber
// tile with one amber (or ink) mark, the brand amber #f8b700.
// node tools/icon.mjs preview           → tools/e2e/.work/icon-candidates.png (every design, every size, dark and light
//                                         taskbars, foobar2k's icon for comparison)
// node tools/icon.mjs build <design>    → assets/icon.svg, assets/icon-<n>.png, assets/app.ico and the Windows app's
//                                         Assets (AppIcon.ico, Logo.png, Logo-64.png)
// Needs playwright (npm install) and Python with Pillow (for the .ico).
import { mkdir, writeFile, readFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const load = name => { for (const dir of [root, process.env.KIT_DIR, resolve(root, '../CreeperUX UI Kit'), resolve(root, '../fb2k')].filter(Boolean)) { try { return createRequire(join(dir, 'package.json')).resolve(name); } catch { /* next */ } } throw new Error(`${name} not found: run npm install`); };
const pw = await import(pathToFileURL(load('playwright')).href);
const { chromium } = pw.chromium ? pw : pw.default;

const AMBER = '#f8b700', AMBER_HI = '#ffcf3d', AMBER_LO = '#e59a00', INK = '#111416';
const svg = (size, body, defs = '') => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><defs>${defs}</defs>${body}</svg>`;
// amber running top to bottom across the whole mark (user space), so separate parts share one gradient
const amberGrad = (id, y1 = 40, y2 = 216) => `<linearGradient id="${id}" x1="0" y1="${y1}" x2="0" y2="${y2}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${AMBER_HI}"/><stop offset="1" stop-color="${AMBER_LO}"/></linearGradient>`;
const inkGrad = id => `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2a3237"/><stop offset="1" stop-color="${INK}"/></linearGradient>`;
const inkTile = `<rect x="8" y="8" width="240" height="240" rx="56" fill="url(#k)"/>
  <rect x="8.75" y="8.75" width="238.5" height="238.5" rx="55.25" fill="none" stroke="#fff" stroke-opacity=".08" stroke-width="1.5"/>`;
const amberTile = `<rect x="8" y="8" width="240" height="240" rx="56" fill="url(#t)"/>
  <rect x="8.75" y="8.75" width="238.5" height="238.5" rx="55.25" fill="none" stroke="#000" stroke-opacity=".12" stroke-width="1.5"/>`;
const tileDefs = amberGrad('t', 8, 248) + inkGrad('k');
const smallTile = (n, fill) => `<rect width="${n}" height="${n}" rx="${(3.5 * n) / 16}" fill="${fill}"/>`;
const f = v => +v.toFixed(2);

/** An arc of a circle (degrees, clockwise from 3 o'clock), as a path. */
const arc = (cx, cy, r, from, to) => {
  const p = a => [f(cx + r * Math.cos((a * Math.PI) / 180)), f(cy + r * Math.sin((a * Math.PI) / 180))];
  const [x1, y1] = p(from), [x2, y2] = p(to);
  return `M${x1} ${y1} A${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${x2} ${y2}`;
};

// The eighth notes, shared by the ink and the amber tile versions
const notes = fill => `
  <ellipse cx="96" cy="178" rx="31" ry="23" transform="rotate(-22 96 178)" fill="${fill}"/>
  <ellipse cx="182" cy="158" rx="31" ry="23" transform="rotate(-22 182 158)" fill="${fill}"/>
  <rect x="110" y="78" width="18" height="102" fill="${fill}"/>
  <rect x="196" y="58" width="18" height="102" fill="${fill}"/>
  <path d="M110 78 L214 56 L214 88 L110 110 Z" fill="${fill}"/>`;
const smallNote = (k, fill) => `
  <ellipse cx="${6.4 * k}" cy="${11.2 * k}" rx="${2.7 * k}" ry="${2.1 * k}" transform="rotate(-20 ${6.4 * k} ${11.2 * k})" fill="${fill}"/>
  <rect x="${7.6 * k}" y="${2.5 * k}" width="${1.6 * k}" height="${8.8 * k}" fill="${fill}"/>
  <path d="M${9.2 * k} ${2.5 * k} C${10 * k} ${4.6 * k} ${12.6 * k} ${4.8 * k} ${12.2 * k} ${8.2 * k} C${11.6 * k} ${6.6 * k} ${10.6 * k} ${6.1 * k} ${9.2 * k} ${6 * k} Z" fill="${fill}"/>`;

export const DESIGNS = {
  // The icon in use (chosen 2026-11-22): foobar2k's, an amber ring with a play mark on ink, so the two apps read as one family
  ring: {
    name: '环 · 播放（深色底，与 foobar2k 相同）',
    master: s => svg(s, `${inkTile}
      <circle cx="128" cy="128" r="76" fill="none" stroke="url(#g)" stroke-width="22"/>
      <path d="M114 100 L158 128 L114 156 Z" fill="${AMBER}" stroke="${AMBER}" stroke-width="10" stroke-linejoin="round"/>`, tileDefs + amberGrad('g', 52, 204)),
    small: n => {
      const k = n / 16;
      return svg(n, `${smallTile(n, INK)}
        <circle cx="${8 * k}" cy="${8 * k}" r="${5 * k}" fill="none" stroke="${AMBER}" stroke-width="${1.6 * k}"/>
        <path d="M${6.75 * k} ${5.75 * k} L${10.25 * k} ${8 * k} L${6.75 * k} ${10.25 * k} Z" fill="${AMBER}"/>`);
    },
  },
  // the icon before: three ink level bars on the amber tile
  bars: {
    name: '旧图标 · 三柱（琥珀底）',
    master: s => svg(s, `${amberTile}
      <rect x="58" y="100" width="36" height="96" rx="18" fill="${INK}"/>
      <rect x="110" y="56" width="36" height="140" rx="18" fill="${INK}"/>
      <rect x="162" y="124" width="36" height="72" rx="18" fill="${INK}"/>`, tileDefs),
    small: n => {
      const u = n / 16, r = Math.round, bar = Math.max(2, r(2.2 * u)), gap = Math.max(2, r(1.4 * u)), base = r(12.5 * u);
      const x0 = r((n - (3 * bar + 2 * gap)) / 2);
      const col = (i, top) => `<rect x="${x0 + i * (bar + gap)}" y="${r(top * u)}" width="${bar}" height="${base - r(top * u)}" rx="${bar / 2}" fill="${INK}"/>`;
      return svg(n, `${smallTile(n, AMBER)}${col(0, 6.25)}${col(1, 3.25)}${col(2, 8)}`);
    },
  },
  // B — a sound wave: five amber bars, tallest in the middle, on ink
  wave: {
    name: '声波（深色底）',
    master: s => {
      const hs = [56, 112, 164, 112, 56];
      return svg(s, `${inkTile}${hs.map((h, i) => `<rect x="${40 + i * 38}" y="${128 - h / 2}" width="24" height="${h}" rx="12" fill="url(#g)"/>`).join('')}`, tileDefs + amberGrad('g'));
    },
    small: n => {
      const k = n / 16, hs = [4, 8, 12, 8, 4];
      return svg(n, `${smallTile(n, INK)}${hs.map((h, i) => `<rect x="${(1 + i * 3) * k}" y="${(8 - h / 2) * k}" width="${2 * k}" height="${h * k}" fill="${AMBER}"/>`).join('')}`);
    },
  },
  // C — beamed eighth notes in amber on ink
  note: {
    name: '音符（深色底）',
    master: s => svg(s, `${inkTile}${notes('url(#g)')}`, tileDefs + amberGrad('g', 56, 202)),
    small: n => svg(n, `${smallTile(n, INK)}${smallNote(n / 16, AMBER)}`),
  },
  // D — the same notes in ink on the amber tile
  noteAmber: {
    name: '音符（琥珀底）',
    master: s => svg(s, `${amberTile}${notes(INK)}`, tileDefs),
    small: n => svg(n, `${smallTile(n, AMBER)}${smallNote(n / 16, INK)}`),
  },
  // E — play, streaming out: a play mark and two arcs (your music, played from your own server)
  stream: {
    name: '串流 · 播放（深色底）',
    master: s => svg(s, `${inkTile}
      <path d="M70 92 L130 128 L70 164 Z" fill="url(#g)" stroke="url(#g)" stroke-width="14" stroke-linejoin="round"/>
      <path d="${arc(96, 128, 66, -46, 46)}" fill="none" stroke="url(#g)" stroke-width="20" stroke-linecap="round"/>
      <path d="${arc(96, 128, 102, -44, 44)}" fill="none" stroke="url(#g)" stroke-width="20" stroke-linecap="round"/>`, tileDefs + amberGrad('g')),
    small: n => {
      const k = n / 16;
      return svg(n, `${smallTile(n, INK)}
        <path d="M${3 * k} ${5 * k} L${7 * k} ${8 * k} L${3 * k} ${11 * k} Z" fill="${AMBER}"/>
        <path d="${arc(4.6 * k, 8 * k, 5.2 * k, -45, 45)}" fill="none" stroke="${AMBER}" stroke-width="${1.6 * k}" stroke-linecap="round"/>
        <path d="${arc(4.6 * k, 8 * k, 8.6 * k, -40, 40)}" fill="none" stroke="${AMBER}" stroke-width="${1.6 * k}" stroke-linecap="round"/>`);
    },
  },
  // F — a C (CreeperUX) drawn as a record's edge, open to the right, with a level meter inside
  cring: {
    name: 'C 环 · 电平（深色底）',
    master: s => svg(s, `${inkTile}
      <path d="${arc(128, 128, 80, 42, 318)}" fill="none" stroke="url(#g)" stroke-width="24" stroke-linecap="round"/>
      <rect x="94" y="114" width="16" height="44" rx="8" fill="url(#g)"/>
      <rect x="120" y="86" width="16" height="72" rx="8" fill="url(#g)"/>
      <rect x="146" y="124" width="16" height="34" rx="8" fill="url(#g)"/>`, tileDefs + amberGrad('g')),
    small: n => {
      const k = n / 16;
      return svg(n, `${smallTile(n, INK)}
        <path d="${arc(8 * k, 8 * k, 5.2 * k, 45, 315)}" fill="none" stroke="${AMBER}" stroke-width="${1.7 * k}" stroke-linecap="round"/>
        <rect x="${7 * k}" y="${5.5 * k}" width="${2 * k}" height="${5 * k}" fill="${AMBER}"/>`);
    },
  },
};
const SIZES = [16, 20, 24, 32, 48, 64, 128, 256];
const svgFor = (d, n) => (n <= 32 ? d.small(n) : d.master(256).replace('width="256" height="256"', `width="${n}" height="${n}"`));

async function render(page, markup, n) {
  await page.setViewportSize({ width: n, height: n });
  await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">${markup}</body></html>`);
  return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: n, height: n } });
}

const [mode, which] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
try {
  if (mode === 'build') {
    const d = DESIGNS[which];
    if (!d) throw new Error(`design: ${Object.keys(DESIGNS).join(' | ')}`);
    const out = join(root, 'assets');
    await mkdir(out, { recursive: true });
    const files = [];
    for (const n of SIZES) { const file = join(out, `icon-${n}.png`); await writeFile(file, await render(page, svgFor(d, n), n)); files.push(file); }
    await writeFile(join(out, 'icon.svg'), `${d.master(256)}\n`);
    execFileSync('python', [join(root, 'tools/pack-ico.py'), join(out, 'app.ico'), ...files], { stdio: 'inherit' });
    const app = join(root, 'src/CreeperUX.Music/Assets');
    await copyFile(join(out, 'app.ico'), join(app, 'AppIcon.ico'));
    await copyFile(join(out, 'icon-256.png'), join(app, 'Logo.png'));
    await copyFile(join(out, 'icon-64.png'), join(app, 'Logo-64.png'));
    console.log(`${which}: assets/icon.svg, ${SIZES.length} PNGs, assets/app.ico; src/CreeperUX.Music/Assets updated`);
  } else {
    // preview: each design at 256 and at the taskbar sizes on a dark and a light taskbar; foobar2k's icon last, for comparison
    const rows = [];
    const sizes = [256, 64, 48, 32, 24, 20, 16];
    for (const [id, d] of Object.entries(DESIGNS)) {
      const imgs = [];
      for (const n of sizes) imgs.push({ n, src: `data:image/png;base64,${(await render(page, svgFor(d, n), n)).toString('base64')}` });
      rows.push({ id, name: d.name, imgs });
    }
    const fb2k = resolve(root, '../fb2k/assets');
    if (existsSync(join(fb2k, 'icon.svg')) && existsSync(join(fb2k, 'icon-small.svg'))) {
      const big = await readFile(join(fb2k, 'icon.svg'), 'utf8'), small16 = await readFile(join(fb2k, 'icon-small.svg'), 'utf8');
      const imgs = [];
      for (const n of sizes) {
        const markup = n <= 32 ? small16.replace('width="16" height="16"', `width="${n}" height="${n}"`) : big.replace('width="256" height="256"', `width="${n}" height="${n}"`);
        imgs.push({ n, src: `data:image/png;base64,${(await render(page, markup, n)).toString('base64')}` });
      }
      rows.push({ id: 'fb2k', name: 'foobar2k 现在的图标（参考）', imgs });
    }
    const letters = 'ABCDEFGHIJ';
    const sheet = `<!doctype html><html><body style="margin:0;font:14px 'Microsoft YaHei UI',sans-serif;background:#f3f3f3;color:#111">
    ${rows.map((c, i) => `<div style="display:flex;gap:28px;align-items:center;padding:18px 28px;border-bottom:1px solid #ddd${c.id === 'fb2k' ? ';background:#e9e9e9' : ''}">
      <div style="width:170px"><b style="font-size:18px">${c.id === 'fb2k' ? '参考' : letters[i]}</b> <code style="color:#666">${c.id === 'fb2k' ? '' : c.id}</code><br>${c.name}</div>
      <img src="${c.imgs[0].src}" width="128" height="128">
      ${['#1f1f1f', '#eeeeee'].map(bg => `<div style="background:${bg};padding:14px 18px;border-radius:8px;display:flex;gap:18px;align-items:center">
        ${c.imgs.slice(1).map(im => `<img src="${im.src}" width="${im.n}" height="${im.n}" style="image-rendering:pixelated">`).join('')}</div>`).join('')}
    </div>`).join('')}</body></html>`;
    await page.setViewportSize({ width: 1220, height: 180 * rows.length });
    await page.setContent(sheet);
    const out = join(root, 'tools/e2e/.work');
    await mkdir(out, { recursive: true });
    await page.screenshot({ path: join(out, 'icon-candidates.png'), fullPage: true });
    console.log('tools/e2e/.work/icon-candidates.png');
  }
} finally { await browser.close(); }
