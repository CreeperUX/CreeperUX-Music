// The demo server: a small Subsonic / OpenSubsonic server (the API Navidrome speaks) over a fictitious catalogue with
// generated music, so CreeperUX Music can be tried, and tested, without a real server. It also serves the web client
// (web/) at /, as Navidrome serves its own web page.
//
// What it answers (from subsonic.org/pages/api.jsp and opensubsonic.netlify.app): token authentication, ping,
// getOpenSubsonicExtensions, getScanStatus, search3 (an empty query lists every song), getAlbumList2, getAlbum,
// getSong, getPlaylists / getPlaylist / createPlaylist (new, or overwrite with playlistId) / updatePlaylist /
// deletePlaylist, star / unstar, getStarred2, scrobble, getNowPlaying, savePlayQueue / getPlayQueue,
// getSimilarSongs2, getTopSongs, getArtistInfo2, getCoverArt, stream (WAV, with byte ranges), getLyricsBySongId and
// getLyrics; and CreeperUX Connect (rest/connect, a WebSocket: connect.mjs), as the CreeperUX/navidrome fork serves it.
// GET query parameters and POSTed forms are both read; every /rest answer carries
// Access-Control-Allow-Origin: * as Navidrome's do. It is not Navidrome: passing against it shows the client follows the
// API, not that a real server behaves the same.
//
// Accounts: demo / demo (yours), friend / friend (owns one public playlist).
// Test hooks (not part of the API): GET /__test/log → the stream, scrobble and cover requests seen, and how many streams
// are open;
// GET /__test/offline?on=1|0 drops every /rest connection (Connect's WebSockets too) while on;
// GET /__test/devices?u=demo → the user's connected devices and what they play.
// Usage: node server/demo-server.mjs [port]   (default 4533, Navidrome's)
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLibrary, rng, hash, LYRIC } from './catalogue.mjs';
import { wav } from './synth.mjs';
import { attachConnect, EXTENSION as CONNECT } from './connect.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv.slice(2).find(a => /^\d+$/.test(a)) || 4533);
const ACCOUNTS = { demo: 'demo', friend: 'friend' };
const md5 = s => createHash('md5').update(s).digest('hex');
const iso = ms => new Date(ms).toISOString();

// ---------------------------------------------------------------- the catalogue as a server's
const lib = buildLibrary();
// --scale=N: N copies of the catalogue under other names (a library the size of a real one, for performance runs)
const scale = Number(process.argv.find(a => a.startsWith('--scale='))?.slice(8) || 1);
// --page-cap=N: at most N songs or albums per page, whatever is asked (some servers cap it; the client must page on)
const pageCap = Number(process.argv.find(a => a.startsWith('--page-cap='))?.slice(11) || 500);
{
  const [tracks, albums, artists] = [[...lib.tracks], [...lib.albums], [...lib.artists]];
  for (let k = 1; k < scale; k++) {
    const sfx = `x${k}`, n = k + 1;
    for (const a of artists) lib.artists.push({ ...a, id: a.id + sfx, name: `${a.name} ${n}`, albumIds: a.albumIds.map(id => id + sfx) });
    for (const a of albums) lib.albums.push({ ...a, id: a.id + sfx, title: `${a.title} · ${n}`, artist: `${a.artist} ${n}`, artistId: a.artistId + sfx, trackIds: a.trackIds.map(id => id + sfx) });
    for (const t of tracks) lib.tracks.push({ ...t, id: t.id + sfx, artist: `${t.artist} ${n}`, artistId: t.artistId + sfx, album: `${t.album} · ${n}`, albumId: t.albumId + sfx, unavailable: false });
  }
}
const SUFFIX = { FLAC: 'flac', ALAC: 'm4a', MP3: 'mp3', AAC: 'm4a', DSD64: 'dsf', Opus: 'opus' };
const TYPE = { flac: 'audio/flac', m4a: 'audio/mp4', mp3: 'audio/mpeg', dsf: 'audio/x-dsf', opus: 'audio/ogg' };
const albums = new Map(lib.albums.map(a => [a.id, a]));
const artists = new Map(lib.artists.map(a => [a.id, a]));
const songs = new Map(lib.tracks.map(t => [t.id, { ...t, starred: t.liked ? Date.UTC(2026, 8, 1) + Number(t.id.slice(1)) * 60000 : null }]));
const missing = new Set(lib.tracks.filter(t => t.unavailable).map(t => t.id)); // the file is gone: stream fails
function lyricsOf(t) {
  if (t.instrumental) return [];
  const r = rng(hash(t.id)), pool = LYRIC[t.lang] || LYRIC.en, lines = [];
  for (let time = 8; time < t.duration - 6 && lines.length < 60; time += 4 + Math.floor(r() * 4)) lines.push({ start: time * 1000, value: lines.length % 9 === 8 ? '' : pool[Math.floor(r() * pool.length)] });
  return lines;
}
function song(t) {
  const al = albums.get(t.albumId), suffix = SUFFIX[t.codec] ?? 'flac';
  return {
    id: t.id, parent: t.albumId, isDir: false, title: t.title, album: t.album, artist: t.artist, track: t.number, discNumber: t.disc, year: t.year, genre: t.genre,
    coverArt: al?._art ? t.albumId : undefined, size: t.size, contentType: TYPE[suffix], suffix, duration: t.duration, bitRate: t.bitrate,
    path: `${t.artist}/${t.year} - ${t.album}/${String(t.number).padStart(2, '0')}. ${t.title}.${suffix}`, playCount: t.playCount, played: t.lastPlayed ? iso(t.lastPlayed) : undefined,
    created: iso(t.added), albumId: t.albumId, artistId: t.artistId, type: 'music', starred: t.starred ? iso(t.starred) : undefined,
    bitDepth: t.bitDepth || undefined, samplingRate: t.sampleRate, channelCount: t.channels, replayGain: { trackGain: t.replayGain.track ?? undefined, albumGain: t.replayGain.album ?? undefined },
    albumArtists: [{ id: al?.artistId, name: al?.artist }], displayAlbumArtist: al?.artist,
  };
}
const albumSongs = id => [...songs.values()].filter(t => t.albumId === id).sort((a, b) => a.disc - b.disc || a.number - b.number);
function album(a) {
  const list = albumSongs(a.id);
  return { id: a.id, name: a.title, artist: a.artist, artistId: a.artistId, coverArt: a._art ? a.id : undefined, songCount: list.length, duration: list.reduce((s, t) => s + t.duration, 0),
    created: iso(Math.min(...list.map(t => t.added))), year: a.year, genre: a.genre, playCount: list.reduce((s, t) => s + t.playCount, 0), releaseTypes: [a.type], recordLabels: a.label ? [{ name: a.label }] : [], isCompilation: false };
}
const shuffle = (list, seed) => { const r = rng(seed), out = [...list]; for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; } return out; };
const NEAR = { 'Post-Rock': ['Ambient', 'Shoegaze'], Ambient: ['Post-Rock', 'Classical'], 'City Pop': ['J-Pop', 'Dream Pop'], 'J-Pop': ['City Pop', 'Indie'], Folk: ['Indie', 'Jazz'], Indie: ['Folk', 'Dream Pop', 'Shoegaze'],
  Electronic: ['Lo-fi', 'Ambient'], Rock: ['Indie', 'Shoegaze'], 'Dream Pop': ['Shoegaze', 'City Pop'], Shoegaze: ['Dream Pop', 'Post-Rock'], Soundtrack: ['Classical', 'Ambient'], Jazz: ['Lo-fi', 'Folk'], Classical: ['Soundtrack'], 'Lo-fi': ['Jazz', 'Electronic'] };
const BIO_LINES = {
  'Post-Rock': '用漫长的渐强和层层叠起的吉他墙讲故事，现场常常一首歌就是十分钟。', 'City Pop': '把八十年代的合成器和夜晚的城市灯光写进歌里，适合开车和晚归。', Folk: '一把木吉他、一支口琴，写小城、旧信和慢下来的生活。',
  Electronic: '用合成器和采样搭出夜行列车般的节奏，作品多在深夜录完。', Indie: '在排练室里自己录、自己混，歌词里总有一条长街。', 'J-Pop': '旋律明亮、编曲细致，副歌一听就记得住。', Rock: '三个人、一台功放，舞台上比录音室里还要响。',
  Ambient: '以钢琴和环境声为主，作品像窗外的雨一样不打扰人。', 'Dream Pop': '混响很深、人声很轻，像隔着一层雾在唱歌。', Shoegaze: '把失真吉他调成一片噪音的海，人声藏在最里面。',
  Soundtrack: '为不存在的电影写配乐，管弦乐和合成器各占一半。', Jazz: '四重奏，深夜俱乐部里的即兴，每一场都不一样。', Classical: '虚构的室内乐团，演奏同样虚构的交响曲和夜曲。', 'Lo-fi': '卧室里录的磁带质感节拍，适合写作业和写代码。',
};

let pid = 0;
const playlists = [];
const addPlaylist = (name, owner, entries, comment = '') => { const p = { id: `pl${++pid}`, name, owner, comment, public: owner !== 'demo', entries, created: Date.UTC(2026, 9, 1), changed: Date.UTC(2026, 9, 1) + pid * 1000 }; playlists.push(p); return p; };
const pick = (genres, n, seed) => shuffle(lib.tracks.filter(t => genres.includes(t.genre) && !t.unavailable).map(t => t.id), seed).slice(0, n);
addPlaylist('深夜写代码', 'demo', pick(['Post-Rock', 'Electronic', 'Ambient', 'Lo-fi'], 30, 3), '不打扰思路的长音轨，适合 23 点以后。');
addPlaylist('通勤 · 早八', 'demo', pick(['City Pop', 'J-Pop', 'Indie', 'Dream Pop'], 24, 5), '地铁 40 分钟。');
addPlaylist('雨天', 'demo', pick(['Folk', 'Jazz', 'Ambient', 'Shoegaze'], 20, 9));
addPlaylist('周末慢跑', 'demo', pick(['Rock', 'Electronic', 'City Pop'], 18, 13));
addPlaylist('朋友的歌单', 'friend', pick(['Jazz', 'Folk'], 12, 17), '朋友分享的公开歌单。');
const nowPlaying = new Map();  // user → { id, at }
const playQueues = new Map();  // user → { entries, current, position, changed, changedBy }
const log = { streams: [], scrobbles: [], queues: [], covers: [], open: 0 }; // open: stream responses not finished yet
let offline = false;

// ---------------------------------------------------------------- the API
const OK = { status: 'ok', version: '1.16.1', type: 'navidrome', serverVersion: '0.58.0 (CreeperUX demo)', openSubsonic: true };
const ok = (extra = {}) => ({ ...OK, ...extra });
const err = (code, message) => ({ ...OK, status: 'failed', error: { code, message } });
const many = (q, k) => q.getAll(k).flatMap(v => (v === '' ? [] : [v]));
const plOut = p => ({ id: p.id, name: p.name, owner: p.owner, public: p.public, comment: p.comment, songCount: p.entries.length, duration: p.entries.reduce((s, id) => s + (songs.get(id)?.duration ?? 0), 0), created: iso(p.created), changed: iso(p.changed) });

function auth(q) {
  const u = q.get('u'), t = q.get('t'), s = q.get('s'), p = q.get('p');
  if (!u || (!t && !p)) return err(10, 'Required parameter is missing: u, t/s or p');
  const pass = ACCOUNTS[u];
  const good = pass !== undefined && (t ? s && md5(pass + s) === t : (p.startsWith('enc:') ? Buffer.from(p.slice(4), 'hex').toString() : p) === pass);
  return good ? null : err(40, 'Wrong username or password');
}

function api(method, q) {
  if (method === 'getOpenSubsonicExtensions') return ok({ openSubsonicExtensions: [{ name: 'songLyrics', versions: [1] }, { name: 'formPost', versions: [1] }, CONNECT] });
  const denied = auth(q); if (denied) return denied;
  const me = q.get('u');
  switch (method) {
    case 'ping': return ok();
    case 'getLicense': return ok({ license: { valid: true } });
    case 'getScanStatus': return ok({ scanStatus: { scanning: false, count: songs.size, folderCount: albums.size } });
    case 'search3': {
      const raw = (q.get('query') ?? '').trim(), text = raw === '""' ? '' : raw.toLowerCase();
      const has = v => String(v ?? '').toLowerCase().includes(text);
      const n = (k, d) => Math.max(0, Number(q.get(k) ?? d));
      const songList = [...songs.values()].filter(t => !text || has(t.title) || has(t.artist) || has(t.album));
      const albumList = lib.albums.filter(a => !text || has(a.title) || has(a.artist));
      const artistList = lib.artists.filter(a => !text || has(a.name));
      return ok({ searchResult3: {
        song: songList.slice(n('songOffset', 0), n('songOffset', 0) + Math.min(pageCap, n('songCount', 20))).map(song),
        album: albumList.slice(n('albumOffset', 0), n('albumOffset', 0) + n('albumCount', 20)).map(album),
        artist: artistList.slice(n('artistOffset', 0), n('artistOffset', 0) + n('artistCount', 20)).map(a => ({ id: a.id, name: a.name, albumCount: a.albumIds.length })),
      } });
    }
    case 'getAlbumList2': {
      const type = q.get('type'); if (!type) return err(10, 'Required parameter is missing: type');
      const size = Math.min(500, pageCap, Number(q.get('size') ?? 10)), offset = Number(q.get('offset') ?? 0);
      let list = [...lib.albums];
      if (type === 'alphabeticalByName') list.sort((a, b) => a.title.localeCompare(b.title));
      else if (type === 'newest') list.sort((a, b) => album(b).created.localeCompare(album(a).created));
      else if (type === 'frequent') list.sort((a, b) => album(b).playCount - album(a).playCount);
      else if (type === 'random') list = shuffle(list, Date.now());
      else if (type === 'starred') list = list.filter(a => albumSongs(a.id).some(t => t.starred));
      return ok({ albumList2: { album: list.slice(offset, offset + size).map(album) } });
    }
    case 'getAlbum': { const a = albums.get(q.get('id')); return a ? ok({ album: { ...album(a), song: albumSongs(a.id).map(song) } }) : err(70, 'Album not found'); }
    case 'getSong': { const t = songs.get(q.get('id')); return t ? ok({ song: song(t) }) : err(70, 'Song not found'); }
    case 'getPlaylists': return ok({ playlists: { playlist: playlists.filter(p => p.owner === me || p.public).map(plOut) } });
    case 'getPlaylist': { const p = playlists.find(x => x.id === q.get('id')); return p ? ok({ playlist: { ...plOut(p), entry: p.entries.map(id => song(songs.get(id))) } }) : err(70, 'Playlist not found'); }
    case 'createPlaylist': {
      const ids = many(q, 'songId').filter(id => songs.has(id)), existing = q.get('playlistId');
      if (existing) {
        const p = playlists.find(x => x.id === existing); if (!p) return err(70, 'Playlist not found');
        if (p.owner !== me) return err(50, 'Not the owner');
        p.entries = ids; p.changed = Date.now(); return ok({ playlist: { ...plOut(p), entry: p.entries.map(id => song(songs.get(id))) } });
      }
      if (!q.get('name')) return err(10, 'Required parameter is missing: name');
      const p = addPlaylist(q.get('name'), me, ids); p.changed = Date.now();
      return ok({ playlist: { ...plOut(p), entry: p.entries.map(id => song(songs.get(id))) } });
    }
    case 'updatePlaylist': {
      const p = playlists.find(x => x.id === q.get('playlistId')); if (!p) return err(70, 'Playlist not found');
      if (p.owner !== me) return err(50, 'Not the owner');
      if (q.has('name')) p.name = q.get('name');
      if (q.has('comment')) p.comment = q.get('comment');
      const drop = new Set(many(q, 'songIndexToRemove').map(Number));
      p.entries = [...p.entries.filter((_, i) => !drop.has(i)), ...many(q, 'songIdToAdd').filter(id => songs.has(id))];
      p.changed = Date.now(); return ok();
    }
    case 'deletePlaylist': {
      const i = playlists.findIndex(x => x.id === q.get('id')); if (i < 0) return err(70, 'Playlist not found');
      if (playlists[i].owner !== me) return err(50, 'Not the owner');
      playlists.splice(i, 1); return ok();
    }
    case 'star': case 'unstar': { for (const id of many(q, 'id')) { const t = songs.get(id); if (t) t.starred = method === 'star' ? Date.now() : null; } return ok(); }
    case 'getStarred2': return ok({ starred2: { song: [...songs.values()].filter(t => t.starred).map(song), album: [], artist: [] } });
    case 'scrobble': {
      const submission = q.get('submission') !== 'false';
      for (const id of many(q, 'id')) {
        const t = songs.get(id); if (!t) return err(70, 'Song not found');
        log.scrobbles.push({ id, submission, time: q.get('time') });
        if (submission) { t.playCount += 1; t.lastPlayed = Date.now(); } else nowPlaying.set(me, { id, at: Date.now() });
      }
      return ok();
    }
    case 'getNowPlaying': return ok({ nowPlaying: { entry: [...nowPlaying].map(([user, n]) => ({ ...song(songs.get(n.id)), username: user, minutesAgo: Math.floor((Date.now() - n.at) / 60000), playerId: 1 })) } });
    case 'savePlayQueue': {
      const ids = many(q, 'id').filter(id => songs.has(id));
      if (!ids.length) { playQueues.delete(me); return ok(); }
      const entry = { entries: ids, current: q.get('current') ?? ids[0], position: Number(q.get('position') ?? 0), changed: Date.now(), changedBy: q.get('c') ?? '' };
      playQueues.set(me, entry); log.queues.push({ current: entry.current, position: entry.position, changedBy: entry.changedBy });
      return ok();
    }
    case 'getPlayQueue': {
      const pq = playQueues.get(me);
      return ok({ playQueue: pq ? { entry: pq.entries.map(id => song(songs.get(id))), current: pq.current, position: pq.position, username: me, changed: iso(pq.changed), changedBy: pq.changedBy } : {} });
    }
    case 'getSimilarSongs2': case 'getSimilarSongs': {
      const t = songs.get(q.get('id')) ?? (albums.has(q.get('id')) ? albumSongs(q.get('id'))[0] : null); if (!t) return err(70, 'Not found');
      const near = new Set([t.genre, ...(NEAR[t.genre] ?? [])]), count = Math.min(200, Number(q.get('count') ?? 50));
      const list = shuffle([...songs.values()].filter(x => x.id !== t.id && near.has(x.genre) && !missing.has(x.id)), hash(t.id)).slice(0, count);
      return ok({ [method === 'getSimilarSongs2' ? 'similarSongs2' : 'similarSongs']: { song: list.map(song) } });
    }
    case 'getTopSongs': {
      const list = [...songs.values()].filter(x => x.artist === q.get('artist')).sort((a, b) => b.playCount - a.playCount).slice(0, Number(q.get('count') ?? 50));
      return ok({ topSongs: { song: list.map(song) } });
    }
    case 'getArtistInfo2': case 'getArtistInfo': {
      const a = artists.get(q.get('id')); if (!a) return err(70, 'Artist not found');
      const first = Math.min(...a.albumIds.map(id => albums.get(id).year));
      const bio = `${a.name}（演示数据，虚构的艺人）。${BIO_LINES[a.genre] ?? ''}自 ${first} 年起发行了 ${a.albumIds.length} 张作品，风格归为 ${a.genre}。 <a href="https://www.last.fm/">Read more on Last.fm</a>`;
      return ok({ [method === 'getArtistInfo2' ? 'artistInfo2' : 'artistInfo']: { biography: bio, lastFmUrl: 'https://www.last.fm/', similarArtist: lib.artists.filter(x => x.id !== a.id && NEAR[a.genre]?.includes(x.genre)).map(x => ({ id: x.id, name: x.name, albumCount: x.albumIds.length })) } });
    }
    case 'getLyricsBySongId': {
      const t = songs.get(q.get('id')); if (!t) return err(70, 'Song not found');
      const lines = lyricsOf(t);
      return ok({ lyricsList: { structuredLyrics: lines.length ? [{ lang: t.lang === 'ja' ? 'jpn' : t.lang === 'zh' ? 'zho' : 'eng', synced: true, displayArtist: t.artist, displayTitle: t.title, offset: 0, line: lines }] : [] } });
    }
    case 'getLyrics': {
      const t = [...songs.values()].find(x => x.artist === q.get('artist') && x.title === q.get('title'));
      return ok({ lyrics: t ? { artist: t.artist, title: t.title, value: lyricsOf(t).map(l => l.value).join('\n') } : {} });
    }
    default: return err(0, `Unknown method: ${method}`);
  }
}

// ---------------------------------------------------------------- binary answers: artwork and audio
// JPEG as real servers send (rendered once by tools/render-covers.mjs), or the generated SVG when there is none
async function coverArt(q, res) {
  const a = albums.get(q.get('id'));
  if (!a?._art) { res.writeHead(404, { 'Access-Control-Allow-Origin': '*' }).end(); return; }
  const headers = { 'Cache-Control': 'public, max-age=31536000', 'Access-Control-Allow-Origin': '*' };
  try { res.writeHead(200, { ...headers, 'Content-Type': 'image/jpeg' }).end(await readFile(join(root, 'server/covers', `${a.id.replace(/x\d+$/, '')}.jpg`))); } // copies share the cover
  catch { res.writeHead(200, { ...headers, 'Content-Type': 'image/svg+xml' }).end(decodeURIComponent(a._art.slice(a._art.indexOf(',') + 1))); }
}
function stream(q, req, res) {
  const id = q.get('id'), t = songs.get(id);
  log.streams.push({ id, format: q.get('format'), maxBitRate: q.get('maxBitRate'), range: req.headers.range ?? null });
  if (!t || missing.has(id)) { res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }).end(JSON.stringify({ 'subsonic-response': err(70, 'File not found') })); return; }
  const { total, read } = wav(t);
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '');
  const start = m && m[1] !== '' ? Number(m[1]) : 0, end = m && m[2] !== '' ? Math.min(Number(m[2]), total - 1) : total - 1;
  if (start >= total) { res.writeHead(416, { 'Content-Range': `bytes */${total}`, 'Access-Control-Allow-Origin': '*' }).end(); return; }
  res.writeHead(m ? 206 : 200, { 'Content-Type': 'audio/wav', 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*', ...(m ? { 'Content-Range': `bytes ${start}-${end}/${total}` } : {}) });
  if (req.method === 'HEAD') { res.end(); return; }
  // made as it is sent, 256 KB at a time, at the pace the player reads (a whole song up front would hold up every other
  // request while it is computed; a player that moves on closes the connection and the rest is never made)
  async function* chunks() { for (let at = start; at <= end; at += CHUNK) { yield read(at, Math.min(end, at + CHUNK - 1)); await new Promise(r => setImmediate(r)); } }
  pipeline(Readable.from(chunks()), res).catch(() => { /* the player closed the connection */ });
}
const CHUNK = 256 * 1024;

// ---------------------------------------------------------------- the server
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/__test/')) {
    if (url.pathname === '/__test/offline') { offline = url.searchParams.get('on') === '1'; if (offline) connect.dropAll(); }
    const body = url.pathname === '/__test/log' ? log : url.pathname === '/__test/devices' ? connect.devices(url.searchParams.get('u') ?? 'demo') : { offline };
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    return;
  }
  if (url.pathname.startsWith('/rest/')) {
    if (offline) { req.socket.destroy(); return; }
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': '*' }).end(); return; }
    const q = new URLSearchParams(url.search);
    if (req.method === 'POST' && /application\/x-www-form-urlencoded|text\/plain/.test(req.headers['content-type'] ?? '')) {
      const chunks = []; for await (const c of req) chunks.push(c);
      for (const [k, v] of new URLSearchParams(Buffer.concat(chunks).toString())) q.append(k, v);
    }
    const method = url.pathname.slice(6).replace(/\.view$/, '');
    if (method === 'getCoverArt' || method === 'stream') {
      const denied = auth(q);
      if (denied) { res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }).end(JSON.stringify({ 'subsonic-response': denied })); return; }
      if (method === 'getCoverArt') log.covers.push({ id: q.get('id'), size: q.get('size'), at: Date.now(), open: log.open });
      else { log.open++; res.on('close', () => log.open--); }
      return method === 'stream' ? stream(q, req, res) : coverArt(q, res);
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }).end(JSON.stringify({ 'subsonic-response': api(method, q) }));
    return;
  }
  try {
    // the web client (web/), and the shared icons (assets/)
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
    const base = /^assets([/\\]|$)/.test(rel) ? root : join(root, 'web');
    const file = join(base, rel);
    if (!file.startsWith(base) || rel.startsWith('.')) { res.writeHead(403).end(); return; }
    const real = (await stat(file)).isDirectory() ? join(file, 'index.html') : file;
    res.writeHead(200, { 'Content-Type': TYPES[extname(real)] || 'application/octet-stream', 'Cache-Control': 'no-store' }).end(await readFile(real));
  } catch { res.writeHead(404).end('not found'); }
});
const connect = attachConnect(server, { authenticate: q => (auth(q) ? null : q.get('u')), isOffline: () => offline });
server.listen(port, '127.0.0.1', () => console.log(`demo server: http://127.0.0.1:${port}/ (${songs.size} songs, ${albums.size} albums, ${playlists.length} playlists; sign in as demo / demo)`));
export { server };
