// The server the client tests run against (tools/e2e/acceptance.mjs, tools/check-web.mjs; the unit tests in
// tests/Sonus.Core.Tests read the same variables): the demo server by default, or any server.
//
//   SONUS_TEST_SERVER       the server's base URL. Unset: a demo server is started (tools/demo-server), as always.
//   SONUS_TEST_CREDENTIALS  a JSON file with the test users (keep it out of the repository: tools/e2e/.work/ is ignored).
//   SONUS_TEST_MANIFEST     optional: a JSON file naming entities the tests want (a song with synced lyrics, …).
//
// Against another server the tests talk to a recording proxy (proxy.mjs) in front of it, which gives what the demo
// server's /__test/log and /__test/offline give; the browser sign-in is allowed through the server's own routes; what
// the tests need from the library comes from the manifest, or is found through the API. See README.md for the keys.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { startDemoServer } from './e2e.mjs';
import { startProxy } from './proxy.mjs';

export const SERVER = (process.env.SONUS_TEST_SERVER || '').trim().replace(/\/$/, '') || null;
const md5 = s => createHash('md5').update(s).digest('hex');

// ---------------------------------------------------------------- credentials and the manifest
/** { "a": { "b": 1 } } → { "a.b": 1 }; an "ids" or "entities" wrapper is looked through. */
export function flatten(value, prefix = '', out = {}) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else if (prefix) {
    out[prefix] = value;
    const bare = prefix.replace(/^(ids|entities)\./, '');
    if (bare !== prefix && !(bare in out)) out[bare] = value;
  }
  return out;
}
const readJson = (path, what) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch (e) { throw new Error(`${what}: ${path}: ${e.message}`); } };
/** A user under `key` (users.main, main, or the file's top level when key is ''): { username, password } or null. */
function userAt(flat, key) {
  const k = s => (key ? `${key}.${s}` : s);
  const username = flat[k('username')] ?? flat[k('user')] ?? flat[k('name')], password = flat[k('password')] ?? flat[k('pass')];
  return username && password ? { username: String(username), password: String(password) } : null;
}

/** The demo server's accounts and what the tests take from its catalogue (tools/demo-server/catalogue.mjs). */
export const DEMO_USERS = { main: { username: 'demo', password: 'demo' }, other: { username: 'friend', password: 'friend' } };
export const DEMO_CATALOGUE = {
  counts: { songs: 293, albums: 34, artists: 17, playlists: 5 },
  browse: { id: 'al0', title: '雾中山脉', artist: '林间信号' },          // an album page
  second: { album: 'al1', artist: 'ar1' },                               // another album and artist
  artist: { id: 'ar5', name: '月影ノート' },
  genre: 'Jazz',
  ownPlaylist: { id: 'pl1', name: '深夜写代码' },
  othersPlaylist: { id: 'pl5', name: '朋友的歌单', owner: 'friend' },    // another user's, public: read-only here
  playable: { id: 'al3', title: '霓虹航线' },                            // ≥ 4 long songs that stream
  radio: { id: 't21', title: '星期天的雨', genres: ['City Pop', 'J-Pop', 'Dream Pop'] }, // first song of `playable`
  lyrics: { id: 't21', albumId: 'al5', index: 2, firstTime: 8 },          // synced lyrics; the album to continue on
  search: { term: '夜', best: '夏夜电台' },
  missing: 't57',                                                         // listed, but its file is gone
  songIds: ['t1', 't2', 't3', 't9'],
  bio: '演示数据',
};

// ---------------------------------------------------------------- the target
/** Starts what the tests talk to: the demo server, or the recording proxy in front of SONUS_TEST_SERVER. */
export async function startTarget({ scale = 1 } = {}) {
  if (!SERVER) {
    const demo = await startDemoServer({ scale });
    return makeTarget({ url: demo.url, demo: true, users: DEMO_USERS, manifest: {}, stop: async () => demo.stop() });
  }
  const credentialsFile = process.env.SONUS_TEST_CREDENTIALS, manifestFile = process.env.SONUS_TEST_MANIFEST;
  const manifest = manifestFile ? flatten(readJson(manifestFile, 'SONUS_TEST_MANIFEST')) : {};
  const creds = credentialsFile ? flatten(readJson(credentialsFile, 'SONUS_TEST_CREDENTIALS')) : {};
  const main = userAt(creds, 'users.main') ?? userAt(creds, 'main') ?? userAt(creds, '') ?? userAt(manifest, 'users.main');
  const other = userAt(creds, 'users.other') ?? userAt(creds, 'other') ?? userAt(manifest, 'users.other');
  if (!main) throw new Error('SONUS_TEST_SERVER needs a test user: SONUS_TEST_CREDENTIALS (a JSON file, see tools/e2e/README.md)');
  const proxy = await startProxy(SERVER);
  return makeTarget({ url: proxy.url, origin: SERVER, demo: false, users: { main, other }, manifest, stop: () => proxy.stop() });
}

function makeTarget({ url, origin = url, demo, users, manifest, stop }) {
  const cleanup = [];
  let catalogue = null;
  /** The Subsonic API as another client would call it (token authentication), as `as` (the main user by default). */
  async function api(method, params = {}, as = users.main) {
    const salt = Math.random().toString(16).slice(2, 10);
    const q = new URLSearchParams({ u: as.username, t: md5(as.password + salt), s: salt, v: '1.16.1', c: 'tests', f: 'json' });
    for (const [k, v] of Object.entries(params)) for (const x of [].concat(v)) q.append(k, String(x));
    const r = (await (await fetch(`${url}/rest/${method}.view?${q}`)).json())['subsonic-response'];
    if (r.status !== 'ok') throw Object.assign(new Error(`${method}: ${r.error?.message}`), { code: r.error?.code });
    return r;
  }
  const t = {
    url, origin, demo, user: users.main, other: users.other ?? null, manifest,
    describe: demo ? `演示服务器 ${url}` : `${origin}（经记录代理 ${url}）`,
    api,
    /** The requests seen: { streams, scrobbles, queues, covers, open } (the demo server's hook, or the proxy's). */
    log: async () => (await fetch(`${url}/__test/log`)).json(),
    /** Drops every connection while on (the demo server's hook, or the proxy's). */
    offline: on => fetch(`${url}/__test/offline?on=${on ? 1 : 0}`),
    id: key => manifest[key] ?? null,
    /** What the tests take from the library (DEMO_CATALOGUE, or found on the server): see README.md. */
    catalogue: async () => (catalogue ??= demo ? structuredClone(DEMO_CATALOGUE) : await discover(t, cleanup)),
    signIns: demo ? demoSignIns(url) : serverSignIns(url, users.main),
    /** Sonus Connect devices of the main user that the server accepted: the demo server's list, or the sockets the
     *  proxy passed on (signed in with an API key, accepted, still open). */
    connectDevices: async () => demo
      ? (await fetch(`${url}/__test/devices?u=${encodeURIComponent(users.main.username)}`)).json()
      : (await t.log()).sockets.filter(s => s.open && s.status === 101),
    /** Runs `fn` when the target stops (things the tests made on the server). */
    onStop: fn => cleanup.push(fn),
    stop: async () => { for (const fn of cleanup.reverse()) await fn().catch(() => {}); await stop(); },
  };
  return t;
}

// ---------------------------------------------------------------- signing in through the browser (an API key)
// The approval page's decision: the demo server's test hook, or the server's own routes as the approval page calls
// them (the CreeperUX/navidrome fork's SONUS.md: /auth/login, then /auth/device/{code} and its approve / deny), with
// the test user's web sign-in (two-step verification off for it, or not set up).
function demoSignIns(url) {
  const hook = async (query = '') => (await fetch(`${url}/__test/device${query}`)).json();
  return {
    waiting: async code => (await hook()).pending.find(p => p.userCode === code) ?? null,
    decide: async (code, allow) => (await hook(`?code=${code}&decide=${allow ? 'allow' : 'deny'}`)).decided,
    keys: async () => (await hook()).keys,
  };
}
function serverSignIns(url, user) {
  let jwt = null;
  async function call(path, init = {}) {
    for (let attempt = 0; ; attempt++) {
      if (!jwt) {
        const r = await fetch(`${url}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: user.username, password: user.password }) });
        const body = await r.json().catch(() => ({}));
        if (!r.ok || !body.token) throw new Error(`web sign-in as the test user: ${r.status}${body.twoFactor ? ` (two-step verification: ${body.twoFactor})` : ''}`);
        jwt = body.token;
      }
      const r = await fetch(`${url}${path}`, { ...init, headers: { ...init.headers, 'X-ND-Authorization': `Bearer ${jwt}` } });
      if (r.status === 401 && attempt === 0) { jwt = null; continue; }
      return r;
    }
  }
  return {
    waiting: async code => { const r = await call(`/auth/device/${encodeURIComponent(code)}`); return r.ok ? r.json() : null; },
    decide: async (code, allow) => (await call(`/auth/device/${encodeURIComponent(code)}/${allow ? 'approve' : 'deny'}`, { method: 'POST' })).status === 204,
    // the user's app passwords: an API key is one of them, named "client · device"
    keys: async () => { const r = await call('/auth/app-passwords'); if (!r.ok) throw new Error(`/auth/app-passwords: ${r.status}`); return (await r.json()).map(k => ({ id: k.id, user: user.username, name: k.name })); },
  };
}

// ---------------------------------------------------------------- the library of another server
async function paged(get) {
  const all = [];
  for (let offset = 0; ;) { const page = (await get(offset)) ?? []; if (!page.length) return all; all.push(...page); offset += page.length; }
}

/** What DEMO_CATALOGUE says, for another server: the manifest's ids where it has them, otherwise found through the API.
 *  Playlists the tests need and the server does not have are made (and deleted when the target stops). */
async function discover(t, cleanup) {
  const { api, user, other } = t;
  const songs = await paged(o => api('search3', { query: '', songCount: 500, songOffset: o, albumCount: 0, artistCount: 0 }).then(r => r.searchResult3.song));
  const albums = await paged(o => api('getAlbumList2', { type: 'alphabeticalByName', size: 500, offset: o }).then(r => r.albumList2.album));
  const missing = t.id('track.missingFile');
  const dsd = t.id('track.dsd') ?? songs.find(s => /^(dsf|dff)$/i.test(s.suffix ?? ''))?.id ?? null;
  const usable = s => s.id !== missing && !/^(dsf|dff)$/i.test(s.suffix ?? '');
  const byAlbum = new Map();
  for (const s of songs) { if (!byAlbum.has(s.albumId)) byAlbum.set(s.albumId, []); byAlbum.get(s.albumId).push(s); }
  for (const list of byAlbum.values()) list.sort((a, b) => (a.discNumber ?? 1) - (b.discNumber ?? 1) || (a.track ?? 0) - (b.track ?? 0));
  const songsOf = id => byAlbum.get(id) ?? [];
  const albumById = new Map(albums.map(a => [a.id, a]));

  // the playback rounds: ≥ 4 songs of a minute or more, all streamable; one disc (the web check counts rows)
  const long = albums.filter(a => songsOf(a.id).length >= 4 && songsOf(a.id).every(s => usable(s) && s.duration >= 60));
  const oneDisc = a => new Set(songsOf(a.id).map(s => s.discNumber ?? 1)).size === 1;
  const playableId = t.id('album.playable') ?? (long.find(oneDisc) ?? long[0])?.id;
  if (!playableId) throw new Error('the server has no album of 4 or more songs of a minute or more (manifest key album.playable)');
  const playable = albumById.get(playableId) ?? (await api('getAlbum', { id: playableId })).album;
  const first = songsOf(playableId)[0] ?? (await api('getAlbum', { id: playableId })).album.song[0];

  // synced lyrics: the manifest's, or the first of the songs (long enough to continue at 41 s) that has some
  let lyricsId = t.id('track.syncedLyrics'), firstTime = null;
  const lyricsOf = async id => { try { return (await api('getLyricsBySongId', { id })).lyricsList?.structuredLyrics?.find(l => l.synced && l.line?.length >= 3) ?? null; } catch { return null; } };
  // the first line's time as the clients show it: OpenSubsonic's offset (ms) brings the lines sooner
  const shown = l => (l ? Math.max(0, l.line[0].start - (l.offset ?? 0)) : null);
  if (lyricsId) firstTime = shown(await lyricsOf(lyricsId));
  else for (const s of songs.filter(s => usable(s) && s.duration >= 45).slice(0, 120)) { const l = await lyricsOf(s.id); if (l) { lyricsId = s.id; firstTime = shown(l); break; } }
  const lyricsSong = lyricsId ? songs.find(s => s.id === lyricsId) : null;

  // an album page (five songs or more, of half a minute or more: "play next" plays the fifth, as on the demo's al0),
  // another album, and the artist with the most songs (of an album: the app's artist pages are album artists)
  const whole = a => songsOf(a.id).every(usable);
  const browse = albums.find(a => a.id !== playableId && whole(a) && songsOf(a.id).length >= 5 && songsOf(a.id).every(s => s.duration >= 30)) ??
    albums.find(a => a.id !== playableId && whole(a) && songsOf(a.id).length >= 5) ?? albums.find(a => a.id !== playableId && songsOf(a.id).length >= 2) ?? albums[0];
  const secondAlbum = albums.find(a => a.id !== browse.id && a.id !== playableId && whole(a) && songsOf(a.id).length) ?? albums.find(a => a.id !== browse.id) ?? browse;
  const songCount = new Map();
  for (const a of albums) if (a.artistId) songCount.set(a.artistId, (songCount.get(a.artistId) ?? 0) + songsOf(a.id).length);
  const artists = [...new Map(albums.filter(a => a.artistId).map(a => [a.artistId, a.artist])).entries()].sort((x, y) => songCount.get(y[0]) - songCount.get(x[0]));
  const artist = artists[0];
  const secondArtist = artists.find(([id]) => id !== artist[0]) ?? artist;
  const genres = new Map(); for (const s of songs) if (s.genre) genres.set(s.genre, (genres.get(s.genre) ?? 0) + 1);
  const genre = [...genres].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const songIds = songs.filter(usable).slice(0, 4).map(s => s.id);

  // playlists: the user's own, and another user's public one (read-only for this user)
  let playlists = (await api('getPlaylists')).playlists.playlist ?? [];
  const pick = id => playlists.find(p => p.id === id);
  let own = pick(t.id('playlist.own')) ?? playlists.find(p => p.owner === user.username);
  if (!own) {
    own = (await api('createPlaylist', { name: 'Sonus 测试歌单', songId: songIds.slice(0, 3) })).playlist;
    cleanup.push(() => api('deletePlaylist', { id: own.id }));
  }
  let others = pick(t.id('playlist.otherPublic')) ?? playlists.find(p => p.owner !== user.username);
  if (!others && other) {
    const made = (await api('createPlaylist', { name: '朋友的测试歌单', songId: songIds.slice(0, 2) }, other)).playlist;
    cleanup.push(() => api('deletePlaylist', { id: made.id }, other));
    await api('updatePlaylist', { playlistId: made.id, public: true }, other);
    others = made;
  }
  playlists = (await api('getPlaylists')).playlists.playlist ?? [];

  const term = artist?.[1] ?? browse.name;
  const found = (await api('search3', { query: term, songCount: 0, albumCount: 20, artistCount: 20 })).searchResult3;
  return {
    counts: { songs: songs.length, albums: albums.length, artists: null, playlists: playlists.length },
    browse: { id: browse.id, title: browse.name, artist: browse.artist },
    second: { album: secondAlbum.id, artist: secondArtist?.[0] ?? artist[0] },
    artist: { id: artist[0], name: artist[1] },
    genre,
    ownPlaylist: { id: own.id, name: playlists.find(p => p.id === own.id)?.name ?? own.name },
    othersPlaylist: others ? { id: others.id, name: others.name, owner: others.owner } : null,
    playable: { id: playable.id, title: playable.name },
    radio: { id: first.id, title: first.title, genres: null },
    lyrics: lyricsSong ? { id: lyricsSong.id, albumId: lyricsSong.albumId, index: songsOf(lyricsSong.albumId).findIndex(s => s.id === lyricsSong.id), firstTime: firstTime == null ? null : firstTime / 1000 } : null,
    search: { term, best: found.artist?.[0]?.name ?? found.album?.[0]?.name ?? null },
    missing,
    dsd,
    songIds,
    bio: null,
  };
}
