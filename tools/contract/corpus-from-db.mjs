// Builds a request corpus for diff.mjs from a Navidrome database: the library reads the Rust server answers (phase 3 of
// docs/server-roadmap.md), made from the data itself, as every user of that database.
//
//   node tools/contract/corpus-from-db.mjs --db <navidrome.db> --out <corpus.json> [--seed <n>] [--covers]
//
// The database is never opened where it is: it is copied (with its -wal file) to a folder of its own first and read
// there. What the corpus holds:
//   getAlbumList2   every type but random, pages of 500 to past the end; byYear both ways; byGenre for a sample of genres
//   getAlbum        every album
//   getSong         a spread over the formats, and every song with odd data: missing tags, several values for a tag
//                   or a role, text that is not valid UTF-8 or holds control characters, the longest values
//   search3         the empty query paged through songs, albums and artists (pages of 500, as the clients page);
//                   words made from the data (titles, artists, albums: a sample, and every script found)
//   getStarred2, getPlaylists, getPlayQueue; getPlaylist for every playlist
//   getLyricsBySongId   every song with stored lyrics, a sample without
//   getCoverArt     with --covers: a few of each kind (the pictures need not be there: both servers must then fail alike)
// Every request is made as every user (auth: { user: 'u1' … }, users in the order they were created); the corpus's
// `users` field maps those keys to user ids. Random lists are left out: two servers cannot agree on them.
// Request names hold methods, ids and counts only, never titles or user names: the corpus itself holds words from the
// data, so write it where nothing is committed (tools/fixtures/.work/).
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const PAGE = 500;
const LIST_TYPES = ['newest', 'highest', 'frequent', 'recent', 'alphabeticalByName', 'alphabeticalByArtist', 'starred'];
const SCRIPTS = {
  han: /\p{Script=Han}/u, hiragana: /\p{Script=Hiragana}/u, katakana: /\p{Script=Katakana}/u, hangul: /\p{Script=Hangul}/u,
  cyrillic: /\p{Script=Cyrillic}/u, greek: /\p{Script=Greek}/u, arabic: /\p{Script=Arabic}/u, hebrew: /\p{Script=Hebrew}/u,
  thai: /\p{Script=Thai}/u, devanagari: /\p{Script=Devanagari}/u,
  // Latin letters with accents (a letter that decomposes into a base and a mark)
  accents: /[À-ɏḀ-ỿ]/u,
  punctuation: /[^\p{L}\p{N}\s]/u,
  digitsOnly: /^[\p{N}\s]+$/u,
};

/** A copy of the database (and its -wal) in a folder of its own, opened read-only: { db, remove }. */
export async function openCopy(file) {
  const folder = await mkdtemp(join(tmpdir(), 'sonus-corpus-'));
  await copyFile(file, join(folder, 'navidrome.db'));
  if (existsSync(`${file}-wal`)) await copyFile(`${file}-wal`, join(folder, 'navidrome.db-wal'));
  // a first read-write open folds the -wal into the copy; then read-only
  new DatabaseSync(join(folder, 'navidrome.db')).close();
  const db = new DatabaseSync(join(folder, 'navidrome.db'), { readOnly: true });
  return { db, remove: async () => { db.close(); await rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } };
}

/** A seeded pseudo-random number generator (mulberry32), so the same database and seed give the same corpus. */
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sample(list, n, rnd) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [copy[i], copy[j]] = [copy[j], copy[i]]; }
  return copy.slice(0, n);
}

const json = text => { try { return JSON.parse(text || 'null'); } catch { return null; } };
/** Whether a text read from SQLite holds what is not valid UTF-8 (read as U+FFFD) or control characters. */
const odd = s => typeof s === 'string' && /[�\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(s);

/** The corpus for a database: { generated, users, counts, volatile, unordered, requests }. */
export function buildCorpus(db, { seed = 1, covers = false } = {}) {
  const rnd = random(seed);
  const all = sql => db.prepare(sql).all();
  const users = all('select id from user order by created_at, id').map(r => r.id);
  const keys = users.map((_, i) => `u${i + 1}`);
  const songs = all(`select id, title, album, artist, album_artist, suffix, genre, lyrics, tags, participants, path, comment,
                            year, track_number, disc_number, duration, bit_rate, sample_rate, bit_depth, channels
                     from media_file where missing = 0 order by id`);
  const albums = all('select id, name, album_artist, min_year, max_year, genre, tags from album where missing = 0 order by id');
  const artists = all('select id, name from artist where missing = 0 order by id');
  const playlistRows = all("select id, coalesce(rules, '') <> '' as smart from playlist order by id");
  const playlists = playlistRows.map(r => r.id);
  const requests = [];
  const add = (name, method, params, extra = {}) => { for (const user of keys) requests.push({ name: `${name} ${user}`, method, params, auth: { user }, ...extra }); };

  // getAlbumList2: every type paged to the end (one more page, which must be empty)
  const pages = Math.ceil(albums.length / PAGE) + 1;
  for (const type of LIST_TYPES) {
    for (let p = 0; p < pages; p++) add(`getAlbumList2 ${type} offset=${p * PAGE}`, 'getAlbumList2', { type, size: String(PAGE), offset: String(p * PAGE) });
  }
  const years = albums.flatMap(a => [a.min_year, a.max_year]).filter(y => y > 0);
  const [fromYear, toYear] = years.length ? [Math.min(...years), Math.max(...years)] : [1900, 2100];
  for (const [f, t] of [[fromYear, toYear], [toYear, fromYear]]) {
    for (let p = 0; p < pages; p++) add(`getAlbumList2 byYear ${f}-${t} offset=${p * PAGE}`, 'getAlbumList2', { type: 'byYear', fromYear: String(f), toYear: String(t), size: String(PAGE), offset: String(p * PAGE) });
  }
  const genres = [...new Set(albums.flatMap(a => {
    const t = json(a.tags)?.genre;
    return Array.isArray(t) ? t.map(g => (typeof g === 'string' ? g : g?.value)).filter(Boolean) : a.genre ? [a.genre] : [];
  }))].sort();
  const someGenres = sample(genres, 25, rnd).sort();
  someGenres.forEach(g => add(`getAlbumList2 byGenre genre#${genres.indexOf(g)}`, 'getAlbumList2', { type: 'byGenre', genre: g, size: String(PAGE) }));

  // getAlbum: every album
  for (const a of albums) add(`getAlbum ${a.id}`, 'getAlbum', { id: a.id });

  // getSong: a spread over the formats, then every song with odd data
  // (the reasons are counted for every song they apply to, though each song is asked for once)
  const chosen = new Set();
  const songReasons = {};
  const choose = (s, why) => { chosen.add(s.id); songReasons[why] = (songReasons[why] ?? 0) + 1; };
  const bySuffix = Object.groupBy(songs, s => (s.suffix ?? '').toLowerCase());
  const perFormat = Math.max(20, Math.ceil(300 / Math.max(1, Object.keys(bySuffix).length)));
  for (const [suffix, list] of Object.entries(bySuffix)) for (const s of sample(list, perFormat, rnd)) choose(s, `format ${suffix || '(none)'}`);
  for (const s of songs) {
    const tags = json(s.tags) ?? {};
    const parts = json(s.participants) ?? {};
    if (!s.title || !s.artist || !s.album || !s.album_artist) choose(s, 'missing tags');
    if (!s.year || !s.track_number || !(tags.genre?.length)) choose(s, 'missing year, track or genre');
    if (Object.values(tags).some(v => Array.isArray(v) && v.length > 1)) choose(s, 'several values for a tag');
    if (Object.values(parts).some(v => Array.isArray(v) && v.length > 1)) choose(s, 'several artists in a role');
    if (Object.keys(parts).some(role => !['artist', 'albumartist'].includes(role))) choose(s, 'other roles');
    if ([s.title, s.album, s.artist, s.album_artist, s.comment, s.path, s.genre].some(odd) || odd(s.tags) || odd(s.participants)) choose(s, 'odd text');
    if (!s.duration || !s.bit_rate || !s.sample_rate) choose(s, 'missing audio properties');
  }
  for (const field of ['title', 'album', 'artist', 'album_artist', 'comment', 'path', 'tags', 'participants', 'lyrics', 'genre']) {
    for (const s of [...songs].sort((x, y) => (y[field]?.length ?? 0) - (x[field]?.length ?? 0)).slice(0, 5)) choose(s, `longest ${field}`);
  }
  for (const id of chosen) add(`getSong ${id}`, 'getSong', { id });

  // search3: the empty query through the whole library, as the clients page it; then words from the data
  const counts = { song: songs.length, album: albums.length, artist: artists.length };
  for (const kind of ['song', 'album', 'artist']) {
    for (let p = 0; p <= Math.ceil(counts[kind] / PAGE); p++) {
      const params = { query: '', songCount: '0', albumCount: '0', artistCount: '0' };
      params[`${kind}Count`] = String(PAGE); params[`${kind}Offset`] = String(p * PAGE);
      add(`search3 "" ${kind}s offset=${p * PAGE}`, 'search3', params);
    }
  }
  // the Windows client's search (SubsonicClient.SearchAsync)
  const words = new Map();
  const word = (w, why) => { const t = w?.trim(); if (t && !words.has(t)) words.set(t, why); };
  const firstWord = s => s?.split(/\s+/u).find(x => /[\p{L}\p{N}]/u.test(x));
  const values = [
    ...songs.map(s => ['title', s.title]), ...albums.map(a => ['album', a.name]), ...artists.map(a => ['artist', a.name]),
  ].filter(([, v]) => v);
  for (const [kind, v] of sample(values.filter(([k]) => k === 'title'), 40, rnd)) { word(v, kind); word(firstWord(v), `${kind} word`); }
  for (const [kind, v] of sample(values.filter(([k]) => k === 'album'), 25, rnd)) { word(v, kind); word(firstWord(v), `${kind} word`); }
  for (const [kind, v] of sample(values.filter(([k]) => k === 'artist'), 25, rnd)) { word(v, kind); word(firstWord(v), `${kind} word`); }
  const scriptCounts = {};
  for (const [name, re] of Object.entries(SCRIPTS)) {
    const found = values.filter(([, v]) => re.test(v));
    scriptCounts[name] = found.length;
    for (const [kind, v] of sample(found, 6, rnd)) {
      word(v, `${name} ${kind}`);
      // the run of that script alone, and the first word
      const run = v.match(new RegExp(`(?:${re.source.replace(/^\^|\$$/g, '')})+`, 'u'))?.[0];
      if (run && name !== 'punctuation') word(run, `${name} run`);
      word(firstWord(v), `${name} word`);
    }
  }
  // a part of a word, a word in other case, a word with accents taken off
  for (const [, v] of sample(values, 10, rnd)) {
    const w = firstWord(v);
    if (w && w.length > 3) { word(w.slice(0, 3), 'prefix'); word(w.toUpperCase(), 'upper case'); word(w.normalize('NFD').replace(/\p{M}/gu, ''), 'without accents'); }
  }
  const wordReasons = {};
  [...words].forEach(([w, why], i) => {
    add(`search3 word#${i} (${why})`, 'search3', { query: w, songCount: '200', albumCount: '60', artistCount: '30' });
    wordReasons[why.split(' ')[0]] = (wordReasons[why.split(' ')[0]] ?? 0) + 1;
  });

  // the user's own lists
  add('getStarred2', 'getStarred2', {});
  add('getPlaylists', 'getPlaylists', {});
  add('getPlayQueue', 'getPlayQueue', {});
  // a smart playlist is refreshed by each Navidrome when it is read, at its own moment: its times differ
  for (const p of playlistRows) {
    add(`getPlaylist ${p.id}`, 'getPlaylist', { id: p.id }, p.smart ? { volatile: ['subsonic-response.playlist.changed', 'subsonic-response.playlist.validUntil'] } : {});
  }

  // lyrics: every song with stored lyrics, a sample of those without
  const withLyrics = songs.filter(s => { const l = json(s.lyrics); return Array.isArray(l) ? l.length > 0 : !!(s.lyrics && s.lyrics !== '[]'); });
  const without = sample(songs.filter(s => !withLyrics.includes(s)), 30, rnd);
  for (const s of [...withLyrics, ...without]) add(`getLyricsBySongId ${s.id}`, 'getLyricsBySongId', { id: s.id });

  // covers: a few of each kind, as is and resized
  if (covers) {
    const ids = [
      ...sample(albums, 6, rnd).map(a => `al-${a.id}`), ...sample(songs, 4, rnd).map(s => `mf-${s.id}`),
      ...sample(artists, 3, rnd).map(a => `ar-${a.id}`), ...playlists.slice(0, 3).map(p => `pl-${p}`),
    ];
    for (const id of ids) {
      requests.push({ name: `getCoverArt ${id}`, method: 'getCoverArt', params: { id }, auth: { user: keys[0] } });
      requests.push({ name: `getCoverArt ${id} size=300`, method: 'getCoverArt', params: { id, size: '300' }, auth: { user: keys[0] } });
    }
  }

  return {
    generated: new Date().toISOString(),
    users: Object.fromEntries(keys.map((k, i) => [k, users[i]])),
    counts: {
      users: users.length, songs: songs.length, albums: albums.length, artists: artists.length, playlists: playlists.length,
      genres: genres.length, songsWithLyrics: withLyrics.length, getSong: songReasons, searchWords: wordReasons, scripts: scriptCounts,
      requests: requests.length, byMethod: Object.fromEntries(Object.entries(Object.groupBy(requests, r => r.method)).map(([m, l]) => [m, l.length])),
    },
    volatile: ['subsonic-response.serverVersion'],
    // Go builds these from maps, in random order: an artist's roles, and a song's contributors (role by role, in the
    // order Go walks the song's participants map; server/subsonic/helpers.go)
    unordered: ['subsonic-response.**.artist.*.roles', 'subsonic-response.**.contributors'],
    requests,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { db: { type: 'string' }, out: { type: 'string' }, seed: { type: 'string' }, covers: { type: 'boolean' } } });
  if (!values.db || !values.out) throw new Error('--db and --out are needed');
  const copy = await openCopy(resolve(values.db));
  try {
    const corpus = buildCorpus(copy.db, { seed: Number(values.seed ?? 1), covers: !!values.covers });
    await mkdir(dirname(resolve(values.out)), { recursive: true });
    await writeFile(resolve(values.out), JSON.stringify(corpus, null, 1));
    // counts only: the corpus holds words from the data
    console.log(JSON.stringify(corpus.counts, null, 1));
  } finally {
    await copy.remove();
  }
}
