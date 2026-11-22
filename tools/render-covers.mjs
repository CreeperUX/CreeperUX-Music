// Renders the demo catalogue's covers (generated SVG, server/catalogue.mjs) to JPEG in server/covers/, so the demo server
// serves what real servers serve: the Windows app's images, its page tints and the system media controls need raster
// images. Run again after changing the catalogue's cover generator.
// Usage: node tools/render-covers.mjs
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { buildLibrary } from '../server/catalogue.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'server/covers');
await mkdir(out, { recursive: true });
const browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 600, height: 600 } });
let n = 0;
for (const a of buildLibrary().albums) {
  if (!a._art) continue;
  await page.setContent(`<html><body style="margin:0"><img src="${a._art}" width="600" height="600" style="display:block"></body></html>`);
  await writeFile(join(out, `${a.id}.jpg`), await page.locator('img').screenshot({ type: 'jpeg', quality: 85 }));
  n++;
}
await browser.close();
console.log(`${n} covers in server/covers`);
