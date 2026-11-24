// Writes the fixture music library (library.mjs) into a folder: every audio file, the folder cover and the .lrc
// sidecars. The same input gives the same bytes; every file's modification time is set to a fixed date.
// Usage: node tools/fixtures/generate.mjs [--out <folder>]   (default: tools/fixtures/.work/music)
import { mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { WRITERS } from './lib/formats.mjs';
import { COVERS, TRACKS } from './library.mjs';

const here = dirname(fileURLToPath(import.meta.url)), root = resolve(here, '../..');
export const DEFAULT_MUSIC = join(here, '.work', 'music');
const MTIME = new Date('2026-01-01T12:00:00Z');

export async function generate(out = DEFAULT_MUSIC) {
  await rm(out, { recursive: true, force: true });
  const covers = Object.fromEntries(await Promise.all(Object.entries(COVERS).map(async ([k, p]) => [k, await readFile(join(root, p))])));
  const written = [];
  const put = async (rel, bytes) => {
    const file = join(out, rel);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, bytes);
    await utimes(file, MTIME, MTIME);
    written.push(rel);
  };
  for (const t of TRACKS) {
    const write = WRITERS[t.format];
    if (!write) throw new Error(`${t.path}: no writer for ${t.format}`);
    await put(t.path, write({ tags: t.tags, cover: t.cover ? covers[t.cover] : null, seconds: t.seconds, freq: t.freq }));
    if (t.lrc) await put(t.path.replace(/\.[^.]+$/, '.lrc'), Buffer.from(t.lrc, 'utf8'));
    if (t.albumKeys?.includes('album.folderCover')) await put(join(dirname(t.path), 'cover.jpg'), covers.folder);
  }
  return { out, files: written.length, tracks: TRACKS.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { out: { type: 'string' } } });
  const r = await generate(values.out ? resolve(values.out) : undefined);
  console.log(`${r.tracks} tracks (${r.files} files) in ${r.out}`);
}
