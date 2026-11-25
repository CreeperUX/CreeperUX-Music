// The music server client: Navidrome, or any server speaking the Subsonic API with the OpenSubsonic extensions
// (spec: subsonic.org/pages/api.jsp and opensubsonic.netlify.app), behind the interface's contract (contract.js).
//
// What the server gives and how it maps:
// - The library: every song (search3 with an empty query, paged) and every album (getAlbumList2, paged). Albums and
//   artists keep the server's ids, so they group the way Navidrome groups them (album artist, compilations).
// - Playlists, likes (star / unstar; "Liked Songs" is the starred songs), play counts (scrobble), artwork
//   (getCoverArt), lyrics (getLyricsBySongId, then getLyrics), search (search3), song radio (getSimilarSongs2),
//   artist biographies (getArtistInfo2) live on the server, so every device sees the same.
// - Playback happens here: two <audio> elements play stream URLs. The second one loads the next song before the first
//   ends, so the change of track has no network wait (a few milliseconds of gap remain; true gapless needs a native
//   player).
// - On a server that offers Sonus Connect version 2 (sonusConnect, versions [.., 2]: the Sonus server) what plays, the
//   queue, the order and "stop after current" are the user's one session on the server (api/connect.js,
//   api/session.js, docs/protocol/connect.md): every action here is a command to it, the session's active device plays
//   it, and this browser's <audio> plays only while this browser is that device (it follows the session and reports
//   what really happens). Elsewhere the queue and order are this client's own, and the queue is saved on the server
//   for another device to continue (savePlayQueue / getPlayQueue); with a session that is the session's job (rule 6).
// - Formats a browser cannot decode (DSD, APE, WavPack …) are asked for transcoded (Opus); Navidrome does that with
//   ffmpeg when a transcoding for Opus is configured (it is by default).
// - A play counts once the position passes half the song or four minutes, whichever comes first.
//
// Sign-in: Subsonic token authentication, md5(password + salt). The password is not kept: the salt and token are. In
// the desktop app they go to Windows Credential Manager (through the window, see host below), in a browser to local
// storage (sonus.login). The token works like the password for this API, so it is a secret. On a Sonus server there are
// two more ways (views/login.js): with two-step verification on, the password and a code open a web session that makes
// an app password for this browser, kept as salt and token like any password; and the browser sign-in (OpenSubsonic
// apiKeyAuthentication), kept as { server, user, apiKey } and given back to the server on signing out.
import { orderToBar, barToOrder } from './contract.js';
import { lower, parseLyrics } from './lyrics.js';
import { md5 } from './md5.js';
import { createAuthApi } from './sonus.js';
import { command, report, follow, modeOf, orderOf, windowOf, pickerDevices, newDeviceId, validDeviceId, QUIET_ERRORS } from './connect.js';
import { openSession } from './session.js';
import { VERSION } from '../version.js';

const API_VERSION = '1.16.1', APP = 'Sonus', PAGE = 500;
const LOGIN_KEY = 'sonus.login', LAST_SERVER_KEY = 'sonus.server';
const LOSSY = new Set(['mp3', 'aac', 'm4a', 'ogg', 'oga', 'opus', 'mpc', 'wma', 'mp2']);
const CODECS = { flac: 'FLAC', mp3: 'MP3', aac: 'AAC', ogg: 'Vorbis', oga: 'Vorbis', opus: 'Opus', ape: "Monkey's Audio", wv: 'WavPack', wav: 'PCM', aif: 'PCM', aiff: 'PCM', wma: 'WMA', mpc: 'Musepack', tta: 'TTA', tak: 'TAK', mp2: 'MP2' };
const ORDERS_SHUFFLE = o => o.startsWith('shuffle');
const shuffled = list => { const out = [...list]; for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; } return out; };

// ---------------------------------------------------------------- the stored sign-in
const storage = { get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode: this session only */ } }, del(k) { try { localStorage.removeItem(k); } catch { /* nothing kept */ } } };
// The desktop app (desktop/MainForm.cs) answers chrome.webview.postMessage({ id, op, arg }) with { id, result | error }:
// readLogin / writeLogin / deleteLogin (Windows Credential Manager) and deviceName. In a browser there is no host.
const host = (() => {
  const wv = globalThis.chrome?.webview;
  if (!wv || !globalThis.sonusHost) return null;
  let n = 0;
  const waiting = new Map();
  wv.addEventListener('message', e => { const m = e.data; if (m && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } });
  return (op, arg) => new Promise((resolve, reject) => {
    const id = ++n;
    waiting.set(id, m => (m.error ? reject(new Error(m.error)) : resolve(m.result)));
    wv.postMessage({ id, op, arg });
  });
})();
let login = null, deviceName = '';
/** Reads the saved sign-in (and, in the desktop app, the computer's name); call once before savedLogin(). */
export async function loadLogin() {
  if (host) {
    try { login = JSON.parse((await host('readLogin')) || 'null'); } catch { login = null; }
    try { deviceName = String(await host('deviceName')); } catch { deviceName = ''; }
  } else login = storage.get(LOGIN_KEY);
  if (!(login?.server && login?.user && ((login?.token && login?.salt) || login?.apiKey))) login = null;
  return login;
}
/** The saved sign-in ({ server, user, salt, token } or { server, user, apiKey }), or null. */
export const savedLogin = () => login;
export const lastServer = () => storage.get(LAST_SERVER_KEY) || '';
/** Where the sign-in is kept: 'credential-manager' (the desktop app) or 'browser'. */
export const loginStorage = () => (host ? 'credential-manager' : 'browser');
async function keepLogin(next) {
  login = next;
  if (host) await host('writeLogin', JSON.stringify(next)); else storage.set(LOGIN_KEY, next);
  storage.set(LAST_SERVER_KEY, next.server);
}
export async function signOut() {
  // an API key is given back: it stops working at once (without the server it stays listed under app passwords)
  if (login?.apiKey) await createAuthApi(login.server).deviceRevoke(login.apiKey).catch(() => {});
  login = null;
  if (host) { try { await host('deleteLogin'); } catch { /* already gone */ } } else storage.del(LOGIN_KEY);
}
/** The client name the server sees (Navidrome lists it under Players and as who saved the play queue). */
export const clientName = () => {
  let id = storage.get('sonus.device');
  if (!id) { id = Math.random().toString(36).slice(2, 8); storage.set('sonus.device', id); }
  return `${APP} (${deviceName || `浏览器 ${id}`})`;
};
/** This browser profile's Connect device id, made once and kept: a reload, or the next visit, is the same device. */
function connectDeviceId() {
  let id = storage.get('sonus.connect.device');
  if (!validDeviceId(id)) { id = newDeviceId(); storage.set('sonus.connect.device', id); }
  return id;
}
/** How the other devices list this browser: "Edge · Windows", "Safari · iPhone". */
export function browserName() {
  const ua = globalThis.navigator?.userAgent ?? '';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '浏览器';
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : '';
  return deviceName || (os ? `${browser} · ${os}` : browser);
}
const deviceKind = () => (/iPad|Tablet/.test(globalThis.navigator?.userAgent ?? '') ? 'tablet' : /iPhone|Android.*Mobile/.test(globalThis.navigator?.userAgent ?? '') ? 'phone' : 'web');

/** "music.example.com", "http://host:4533/", "https://host/rest" → "https://music.example.com", "http://host:4533", "https://host". */
export function normalizeServer(input) {
  let s = String(input ?? '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = `${/^(localhost|127\.|10\.|192\.168\.|\[)/.test(s) ? 'http' : 'https'}://${s}`;
  return s.replace(/\/+$/, '').replace(/\/(rest|app)(\/.*)?$/i, '');
}

const ERRORS = {
  43: '登录信息有冲突，请重新登录。', 44: '这个登录已被撤销，请重新登录。',
  10: '请求缺少必要的参数。', 20: '服务器的 Subsonic API 版本太旧。', 30: `${APP} 需要更新才能连接这个服务器。`,
  40: '用户名或密码不正确。', 41: '这个账号不能用 token 登录（例如 LDAP 账号）。', 50: '这个账号没有执行这个操作的权限。', 70: '服务器上找不到这项内容。',
};
function failure(err) { const e = new Error(ERRORS[err?.code] ?? err?.message ?? '服务器拒绝了请求。'); e.code = err?.code; return e; }

function authParams(login, extra = {}) {
  const p = new URLSearchParams(login.apiKey ? { apiKey: login.apiKey, v: API_VERSION, c: clientName(), f: 'json' } : { u: login.user, t: login.token, s: login.salt, v: API_VERSION, c: clientName(), f: 'json' });
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) for (const x of v) p.append(k, String(x)); else p.set(k, String(v));
  }
  return p;
}

/** Checks the server and the account; resolves with the sign-in to keep. The password itself is not returned. */
export async function signIn({ server, user, password }) {
  const base = normalizeServer(server);
  if (!base) throw new Error('请填写服务器地址。');
  if (!user) throw new Error('请填写用户名。');
  const salt = Array.from(crypto.getRandomValues(new Uint8Array(8)), b => b.toString(16).padStart(2, '0')).join('');
  const next = { server: base, user: String(user).trim(), salt, token: md5(`${password ?? ''}${salt}`) };
  await ping(next);
  await keepLogin(next);
  return next;
}
async function ping(next) {
  const base = next.server;
  let res;
  try { res = await fetch(`${base}/rest/ping.view?${authParams(next)}`); }
  catch { throw new Error(`连不上 ${base}。检查地址和网络；服务器在外网时需要 HTTPS。`); }
  let body = null;
  try { body = (await res.json())['subsonic-response']; } catch { /* not a Subsonic server */ }
  if (!body) throw new Error(`${base} 不像是 Navidrome（没有 Subsonic API 的回应）。`);
  if (body.status !== 'ok') throw failure(body.error);
}
/** Keeps an API key the server handed this browser (the browser sign-in), after checking it works. */
export async function signInWithKey({ server, user, apiKey }) {
  const next = { server: normalizeServer(server), user: String(user ?? '').trim(), apiKey };
  await ping(next);
  await keepLogin(next);
  return next;
}
/** What a server offers before anyone signs in: its OpenSubsonic extensions by name (an empty set for plain Subsonic, or when it cannot be reached). */
export async function serverExtensions(server) {
  try {
    const r = (await (await fetch(`${normalizeServer(server)}/rest/getOpenSubsonicExtensions.view?v=${API_VERSION}&c=${encodeURIComponent(APP)}&f=json`)).json())['subsonic-response'];
    return new Set((r?.openSubsonicExtensions ?? []).map(x => x.name));
  } catch { return new Set(); }
}

// ---------------------------------------------------------------- the client
export function createSubsonicClient({ login = savedLogin(), scrobble = true } = {}) {
  if (!login) throw new Error('还没有登录音乐服务器。');
  const base = login.server, rest = `${base}/rest/`;
  const listeners = new Set();
  const emit = e => { for (const fn of listeners) { try { fn(e); } catch (err) { console.error(err); } } };
  let connection = 'connecting', server = { name: 'Navidrome', version: '' }, extensions = new Set(), versions = new Map();
  const setConnection = s => { if (s !== connection) { connection = s; emit({ type: 'connection', status: s }); } };

  async function call(method, extra, { post = false, signal } = {}) {
    let res;
    try {
      res = post ? await fetch(`${rest}${method}.view`, { method: 'POST', body: authParams(login, extra), signal })
        : await fetch(`${rest}${method}.view?${authParams(login, extra)}`, { signal });
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      setConnection('offline');
      throw new Error('无法连接到 Navidrome。检查网络，然后重新连接。');
    }
    if (!res.ok) throw new Error(`Navidrome 返回了 ${res.status} ${res.statusText}。`);
    const body = (await res.json())['subsonic-response'];
    if (!body) throw new Error('Navidrome 的回应无法识别。');
    setConnection('online');
    if (body.status !== 'ok') throw failure(body.error);
    return body;
  }
  const url = (method, extra) => `${rest}${method}.view?${authParams(login, extra)}`;

  // ---------------------------------------------------------------- the library
  const T = new Map(), A = new Map();          // id → track, id → album
  let library = { tracks: [], albums: [], artists: [] };
  let pls = [];                                // server playlists: { id, name, owner, comment, changed, entries: [songId…], readonly }

  const codecOf = s => {
    const x = lower(s.suffix);
    if (x === 'dsf' || x === 'dff') { const n = Math.round((s.samplingRate || 2822400) / 2822400) * 64; return `DSD${n || 64}`; }
    if (x === 'm4a' || x === 'mp4' || x === 'alac') return s.bitDepth || /alac/i.test(s.contentType ?? '') ? 'ALAC' : 'AAC';
    return CODECS[x] ?? (x ? x.toUpperCase() : '?');
  };
  function trackOf(s) {
    const al = A.get(s.albumId), codec = codecOf(s), lossy = LOSSY.has(lower(s.suffix)) && codec !== 'ALAC';
    const albumArtist = al?.artist ?? s.displayAlbumArtist ?? s.albumArtists?.[0]?.name ?? s.artist ?? '未知艺人';
    return {
      id: s.id, title: s.title || s.path?.split(/[\\/]/).pop() || s.id, artist: s.artist || albumArtist, artistId: al?.artistId ?? s.albumArtists?.[0]?.id ?? s.artistId ?? `ar-${lower(albumArtist)}`,
      album: s.album || al?.title || '未知专辑', albumId: s.albumId || `al-${lower(s.album)}`, albumArtist,
      number: s.track || 0, disc: s.discNumber || 1, duration: s.duration || 0, genre: s.genre || s.genres?.[0]?.name || '—', year: s.year || 0,
      codec, bitrate: s.bitRate || 0, sampleRate: s.samplingRate || 0, bitDepth: lossy || codec.startsWith('DSD') ? (codec.startsWith('DSD') ? 1 : 0) : (s.bitDepth || 0), channels: s.channelCount || 2,
      path: s.path || '', size: s.size || 0, added: Date.parse(s.created) || 0, playCount: s.playCount || 0, lastPlayed: s.played ? Date.parse(s.played) || null : null,
      liked: !!s.starred, starredAt: s.starred ? Date.parse(s.starred) || 0 : 0,
      replayGain: { track: s.replayGain?.trackGain ?? null, album: s.replayGain?.albumGain ?? null }, label: al?.label ?? '', instrumental: false,
      suffix: lower(s.suffix), contentType: s.contentType || '', coverArt: s.coverArt || al?.coverArt || null,
    };
  }
  function albumOf(a) {
    const rt = (a.releaseTypes || []).map(lower);
    const type = rt.includes('compilation') || a.isCompilation ? 'compilation' : rt.includes('ep') ? 'ep' : rt.includes('single') ? 'single' : rt.includes('album') ? 'album' : null;
    return { id: a.id, title: a.name || a.album || '未知专辑', artist: a.artist || a.displayArtist || '未知艺人', artistId: a.artistId || `ar-${lower(a.artist)}`, year: a.year || 0, genre: a.genre || a.genres?.[0]?.name || '—',
      label: a.recordLabels?.[0]?.name ?? '', type, coverArt: a.coverArt || null, trackIds: [] };
  }
  async function paged(method, key, sub, extra) {
    const out = [];
    for (let offset = 0; ; offset += PAGE) {
      const r = await call(method, { ...extra(offset) });
      const page = r[key]?.[sub] ?? [];
      out.push(...page);
      if (page.length < PAGE) return out;
    }
  }
  async function loadLibrary() {
    const albums = await paged('getAlbumList2', 'albumList2', 'album', offset => ({ type: 'alphabeticalByName', size: PAGE, offset }));
    A.clear();
    for (const a of albums) A.set(a.id, albumOf(a));
    let songs = await paged('search3', 'searchResult3', 'song', offset => ({ query: '', songCount: PAGE, songOffset: offset, albumCount: 0, artistCount: 0 }));
    if (!songs.length && albums.length) { // a server whose search3 needs words: read album by album instead
      songs = [];
      for (const a of albums) songs.push(...((await call('getAlbum', { id: a.id })).album?.song ?? []));
    }
    T.clear();
    for (const s of songs) { const t = trackOf(s); T.set(t.id, t); }
    group();
  }
  function group() {
    for (const a of A.values()) a.trackIds = [];
    for (const t of T.values()) {
      if (!A.has(t.albumId)) A.set(t.albumId, { id: t.albumId, title: t.album, artist: t.albumArtist, artistId: t.artistId, year: t.year, genre: t.genre, label: '', type: null, coverArt: t.coverArt, trackIds: [] });
      A.get(t.albumId).trackIds.push(t.id);
    }
    const artists = new Map(), albums = [];
    for (const a of A.values()) {
      if (!a.trackIds.length) continue;
      a.trackIds.sort((x, y) => { const p = T.get(x), q = T.get(y); return p.disc - q.disc || p.number - q.number || p.path.localeCompare(q.path); });
      a.year = a.year || Math.max(0, ...a.trackIds.map(id => T.get(id).year));
      a.type = a.type ?? (a.trackIds.length <= 3 ? 'single' : a.trackIds.length <= 6 ? 'ep' : 'album');
      if (!artists.has(a.artistId)) artists.set(a.artistId, { id: a.artistId, name: a.artist, genre: a.genre, albumIds: [] });
      artists.get(a.artistId).albumIds.push(a.id);
      albums.push(a);
    }
    for (const t of T.values()) if (!artists.has(t.artistId)) artists.set(t.artistId, { id: t.artistId, name: t.albumArtist, genre: t.genre, albumIds: [] });
    library = { tracks: [...T.values()], albums, artists: [...artists.values()] };
  }
  const libCopy = () => ({ tracks: library.tracks.map(t => ({ ...t })), albums: library.albums.map(a => ({ ...a, trackIds: [...a.trackIds] })), artists: library.artists.map(a => ({ ...a, albumIds: [...a.albumIds] })) });

  // ---------------------------------------------------------------- playlists
  async function loadPlaylists() {
    const list = (await call('getPlaylists')).playlists?.playlist ?? [];
    const next = [];
    for (let i = 0; i < list.length; i += 4) { // four at a time
      next.push(...await Promise.all(list.slice(i, i + 4).map(async p => {
        const d = (await call('getPlaylist', { id: p.id })).playlist ?? {};
        const entries = (d.entry ?? []).map(s => { if (!T.has(s.id)) T.set(s.id, trackOf(s)); return s.id; });
        return { id: p.id, name: p.name, owner: p.owner, comment: p.comment, changed: Date.parse(p.changed) || Date.now(), readonly: !!p.readonly || (p.owner && p.owner !== login.user), entries };
      })));
    }
    pls = next;
  }
  const dedupe = ids => [...new Set(ids)];
  function appPlaylists() {
    const liked = library.tracks.filter(t => t.liked).sort((a, b) => b.starredAt - a.starredAt).map(t => t.id);
    return [
      { id: 'liked', name: '我喜欢的音乐', kind: 'liked', pinned: true, owner: login.user, trackIds: liked, updated: Date.now() },
      { id: 'library', name: '媒体库 · 全部歌曲', kind: 'library', pinned: true, owner: server.name, trackIds: library.tracks.map(t => t.id), updated: Date.now(), description: `Navidrome 媒体库（${base.replace(/^https?:\/\//, '')}）` },
      ...pls.map(p => ({ id: p.id, name: p.name, kind: p.readonly ? 'auto' : 'user', owner: p.owner || login.user, trackIds: dedupe(p.entries), updated: p.changed, description: p.comment || (p.readonly ? `${p.owner} 的歌单，只能播放` : undefined) })),
    ];
  }
  const emitPlaylists = () => emit({ type: 'playlists', playlists: appPlaylists() });
  const own = id => { const p = pls.find(x => x.id === id); if (!p) throw new Error('找不到这个歌单。'); if (p.readonly) throw new Error('这是别人的歌单，只能播放，不能修改。'); return p; };
  async function rewrite(p, entries) { await call('createPlaylist', { playlistId: p.id, songId: entries }, { post: true }); p.entries = entries; p.changed = Date.now(); emitPlaylists(); }

  // ---------------------------------------------------------------- playback: two <audio> elements, the second loads what comes next
  const audio = [new Audio(), new Audio()];
  let cur = 0, preloadId = null, ticket = 0, started = 0, counted = false;
  const el = () => audio[cur];
  const player = { trackId: null, state: 'stopped', error: null, position: 0, duration: null, volume: storage.get('sonus.volume') ?? 0.8, muted: false, order: 'default', stopAfterCurrent: false, replayGain: storage.get('sonus.replaygain') ?? 'album', context: null, output: 'default' };
  let contextIds = [], pointer = -1, queue = [], qid = 0;
  const snapshot = () => {
    const p = { ...player, context: player.context && { ...player.context }, where: null, remote: null };
    const away = sess?.state.activeElsewhere;
    if (sess) p.where = sess.state.place();
    // another device plays: the bar's volume is that device's (rule 8)
    if (away) Object.assign(p, { remote: { id: away.id, name: away.name, kind: away.kind }, volume: away.volume ?? 1, muted: !!away.muted });
    return p;
  };
  const pushPlayer = () => { emit({ type: 'player', player: snapshot() }); mediaSession(); };
  const queueEntries = () => [...queue.map(q => ({ ...q, section: 'queue' })), ...contextIds.slice(pointer + 1).map((trackId, i) => ({ id: `c${pointer + 1 + i}:${trackId}`, trackId, section: 'context' }))];
  const pushQueue = () => { emit({ type: 'queue', queue: queueEntries() }); if (player.trackId) saveQueue(); };

  const canPlay = t => {
    if (['dsf', 'dff', 'ape', 'wv', 'tta', 'tak', 'wma', 'mpc', 'aif', 'aiff'].includes(t.suffix)) return false;
    if (t.codec === 'ALAC') return !!el().canPlayType('audio/mp4; codecs="alac"');
    return !t.contentType || el().canPlayType(t.contentType) !== '';
  };
  const streamUrl = t => url('stream', canPlay(t) ? { id: t.id } : { id: t.id, format: 'opus', maxBitRate: 320 });
  const gain = t => {
    if (!t || player.replayGain === 'off') return 1;
    const g = player.replayGain === 'album' ? t.replayGain.album ?? t.replayGain.track : t.replayGain.track ?? t.replayGain.album;
    return g == null ? 1 : Math.min(1, 10 ** (g / 20)); // an <audio> element cannot go above full volume
  };
  const applyVolume = () => { const v = player.muted ? 0 : Math.max(0, Math.min(1, player.volume * gain(T.get(player.trackId)))); for (const a of audio) a.volume = v; };
  const unload = a => { a.pause(); a.removeAttribute('src'); a.load(); };
  const MEDIA_ERRORS = { 1: '播放被中止', 2: '网络错误', 3: '解码失败', 4: '格式不受支持或文件无法读取' };

  function load(trackId, { autoplay = true, at = 0 } = {}) {
    const my = ++ticket, t = T.get(trackId);
    Object.assign(player, { trackId, state: autoplay ? 'loading' : 'paused', error: null, position: at, duration: t?.duration || null });
    if (!t) { Object.assign(player, { state: 'error', error: '这首歌已不在媒体库中。' }); pushPlayer(); return; }
    if (preloadId === trackId) { const old = el(); cur = 1 - cur; unload(old); }
    else { unload(audio[1 - cur]); el().src = streamUrl(t); }
    preloadId = null; counted = false; started = Date.now();
    if (at > 0) { const a = el(); a.addEventListener('loadedmetadata', () => { if (a === el()) a.currentTime = at; }, { once: true }); }
    applyVolume(); pushPlayer();
    if (!autoplay) return;
    el().play().then(() => {
      if (my !== ticket) return;
      player.state = 'playing'; pushPlayer(); saveQueue({ soon: true }); say('playing');
      if (scrobble) call('scrobble', { id: trackId, submission: false }).catch(() => {}); // "now playing"
    }).catch(err => {
      if (my !== ticket || err?.name === 'AbortError') return;
      if (err?.name === 'NotAllowedError') { // the browser wants a click first
        player.state = 'paused'; pushPlayer(); say('paused');
        if (sess) emit({ type: 'notice', kind: 'warn', message: '浏览器没有允许自动播放：点一下播放键，就在这里接着放。' });
        return;
      }
      fail(t, err?.message);
    });
  }
  function fail(t, detail) {
    Object.assign(player, { state: 'error', error: `无法播放“${t?.title ?? ''}”：${detail || '未知错误'}` });
    pushPlayer();
    say('failed'); // with a session: the server skips it and says so
  }
  function stop() { el().pause(); Object.assign(player, { state: 'stopped', position: 0 }); try { el().currentTime = 0; } catch { /* nothing loaded */ } pushPlayer(); }
  /** What plays after the current song, without moving there (for loading it early). */
  function peekNext() {
    if (queue.length) return queue[0].trackId;
    if (player.order === 'repeat-track' || player.order === 'random' || player.stopAfterCurrent) return null;
    if (pointer + 1 < contextIds.length) return contextIds[pointer + 1];
    return player.order === 'repeat-playlist' || ORDERS_SHUFFLE(player.order) ? contextIds[0] ?? null : null;
  }
  function advance(dir) {
    if (dir > 0 && queue.length) { const q = queue.shift(); pushQueue(); load(q.trackId); return; }
    let at = pointer + dir;
    if (player.order === 'random' && contextIds.length) at = Math.floor(Math.random() * contextIds.length);
    if (at >= contextIds.length || at < 0) {
      if (contextIds.length && (player.order === 'repeat-playlist' || ORDERS_SHUFFLE(player.order))) at = dir > 0 ? 0 : contextIds.length - 1;
      else { if (dir > 0) stop(); return; }
    }
    pointer = at; pushQueue(); load(contextIds[pointer]);
  }
  for (const a of audio) {
    a.preload = 'auto';
    a.addEventListener('ended', () => {
      if (a !== el()) return;
      if (sess) { say('ended'); return; } // the session says what follows
      if (player.stopAfterCurrent) { player.stopAfterCurrent = false; stop(); return; }
      if (player.order === 'repeat-track') { a.currentTime = 0; a.play().catch(() => {}); counted = false; return; }
      advance(1);
    });
    a.addEventListener('error', () => { if (a === el() && a.getAttribute('src')) fail(T.get(player.trackId), MEDIA_ERRORS[a.error?.code]); });
    a.addEventListener('durationchange', () => { if (a === el() && Number.isFinite(a.duration) && a.duration > 0 && !player.duration) { player.duration = a.duration; pushPlayer(); } });
    // paused or resumed from outside (the system's media controls, a headset button)
    a.addEventListener('pause', () => { if (a === el() && !a.ended && player.state === 'playing') { player.state = 'paused'; pushPlayer(); say('paused'); } });
    a.addEventListener('play', () => { if (a === el() && player.state === 'paused') { player.state = 'playing'; pushPlayer(); say('playing'); } });
  }
  setInterval(() => {
    if (sess && !here()) {
      // another device plays the session (or none does): its position, moving on while it plays there
      if (player.state !== 'playing') return;
      player.position = sessPosition();
      emit({ type: 'position', position: player.position });
      return;
    }
    if (sess && sayPositionAt && Date.now() >= sayPositionAt) { sayPositionAt = 0; say('position'); } // a seek done
    if (player.state !== 'playing') return;
    player.position = el().currentTime;
    emit({ type: 'position', position: player.position });
    if (sess && Date.now() - saidAt > 30_000) say('position'); // at least every 30 s
    if (Date.now() - savedAt > 30_000) saveQueue({ soon: true }); // the position, for another device
    const d = player.duration || el().duration;
    if (!counted && d > 0 && player.position >= Math.min(240, d / 2)) {
      counted = true;
      const t = T.get(player.trackId);
      if (t && scrobble) call('scrobble', { id: t.id, submission: true, time: started }).then(() => { t.playCount += 1; t.lastPlayed = Date.now(); emit({ type: 'track', track: { ...t } }); }).catch(() => {});
    }
    if (d > 0 && d - player.position < 20 && !preloadId) { // load what comes next while this one plays
      const next = peekNext();
      if (next && next !== player.trackId && T.has(next)) { preloadId = next; audio[1 - cur].src = streamUrl(T.get(next)); applyVolume(); }
    }
  }, 250);

  function ordered(ids, order, start) {
    const shuffle = list => { const out = [...list]; for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; } return out; };
    if (order === 'shuffle-tracks') { const rest = shuffle(ids.filter(id => id !== start)); return start ? [start, ...rest] : rest; }
    if (order === 'shuffle-albums' || order === 'shuffle-folders') {
      const keyOf = id => (order === 'shuffle-albums' ? T.get(id)?.albumId : T.get(id)?.path.replace(/[\\/][^\\/]*$/, ''));
      const groups = shuffle([...new Set(ids.map(keyOf))]);
      const startKey = start && keyOf(start);
      if (startKey) groups.sort((a, b) => (a === startKey ? -1 : b === startKey ? 1 : 0));
      return groups.flatMap(g => ids.filter(id => keyOf(id) === g));
    }
    return ids;
  }

  // the system's media controls (Windows shows them for the browser or the shell window)
  function mediaSession() {
    const ms = navigator.mediaSession; if (!ms) return;
    const t = T.get(player.trackId);
    if (t && ms.metadata?.title !== t.title) {
      const art = A.get(t.albumId)?.coverArt ?? t.coverArt;
      try { ms.metadata = new MediaMetadata({ title: t.title, artist: t.artist, album: t.album, artwork: art ? [{ src: url('getCoverArt', { id: art, size: 512 }), sizes: '512x512' }] : [] }); } catch { /* an older engine */ }
    }
    ms.playbackState = player.state === 'playing' ? 'playing' : player.state === 'paused' ? 'paused' : 'none';
    mediaPosition();
  }
  /** The system's controls draw their own progress from this (set on every change of state, and after a seek). */
  function mediaPosition() {
    const d = player.duration;
    try { if (d > 0 && Number.isFinite(d)) navigator.mediaSession?.setPositionState?.({ duration: d, position: Math.min(d, Math.max(0, player.position || 0)), playbackRate: 1 }); } catch { /* an older engine */ }
  }
  if (navigator.mediaSession) {
    const on = (action, fn) => { try { navigator.mediaSession.setActionHandler(action, fn); } catch { /* not supported */ } };
    on('play', () => api.resume()); on('pause', () => api.pause()); on('nexttrack', () => api.next()); on('previoustrack', () => api.previous());
    on('seekto', e => api.seek(e.seekTime));
    on('seekbackward', e => api.seek(player.position - (e.seekOffset || 10))); on('seekforward', e => api.seek(player.position + (e.seekOffset || 10)));
    on('stop', () => api.pause());
  }

  // ---------------------------------------------------------------- output devices: what the browser can reach
  let outputs = [{ id: 'default', name: '系统默认设备', kind: 'computer', state: 'connected', detail: '跟随 Windows 的默认输出' }];
  async function refreshOutputs() {
    if (!navigator.mediaDevices?.enumerateDevices || !el().setSinkId) return;
    try {
      const devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audiooutput' && d.deviceId && d.deviceId !== 'default' && d.label);
      const kind = n => (/headphone|耳机|airpods|buds|bluetooth|蓝牙/i.test(n) ? 'headphones' : /usb|dac|hdmi|spdif|speaker|扬声器/i.test(n) ? 'speaker' : 'computer');
      outputs = [outputs[0], ...devices.map(d => ({ id: d.deviceId, name: d.label, kind: kind(d.label), state: 'available', detail: '浏览器音频输出' }))]
        .map(o => ({ ...o, state: o.id === player.output ? 'connected' : 'available' }));
      emit({ type: 'outputs', outputs: outputs.map(o => ({ ...o })) });
    } catch { /* keep the default */ }
  }
  navigator.mediaDevices?.addEventListener?.('devicechange', refreshOutputs);

  // ---------------------------------------------------------------- the play queue on the server: continue on another device
  let savedAt = 0, saveT = 0;
  function queueForServer() {
    if (!player.trackId) return null;
    const before = contextIds.slice(0, pointer + 1);
    if (before.at(-1) !== player.trackId) before.push(player.trackId); // playing a queued song
    const ids = [...before, ...queue.map(q => q.trackId), ...contextIds.slice(pointer + 1)], from = Math.max(0, before.length - 100);
    return { id: ids.slice(from, from + 500), current: player.trackId, position: Math.round((player.position || 0) * 1000) };
  }
  function saveQueue({ soon = false } = {}) {
    if (sess) return; // with a session the server keeps it (rule 6)
    clearTimeout(saveT);
    saveT = setTimeout(() => { const q = queueForServer(); if (!q) return; savedAt = Date.now(); call('savePlayQueue', q, { post: true }).catch(() => {}); }, soon ? 0 : 1500);
  }
  // closing the window: the position as it is (a beacon still goes out while the page unloads)
  addEventListener('pagehide', () => {
    if (sess) { sess.close(); sess = null; return; } // a goodbye: the session stops at once if it played here
    const q = queueForServer(); if (q && player.state !== 'stopped') navigator.sendBeacon?.(`${rest}savePlayQueue.view`, authParams(login, q));
  });
  // back from the browser's page cache: the connection was closed on the way out
  addEventListener('pageshow', e => { if (e.persisted && versions.get('sonusConnect')?.includes(2)) location.reload(); });
  async function remoteQueue() {
    if (sess) return null; // the session is the user's, on the server: nothing to offer
    const r = (await call('getPlayQueue')).playQueue;
    if (!r?.entry?.length || !r.current) return null;
    for (const s of r.entry) if (!T.has(s.id)) T.set(s.id, trackOf(s));
    return { trackIds: r.entry.map(e => e.id), current: r.current, position: (r.position ?? 0) / 1000, changed: Date.parse(r.changed) || 0, changedBy: r.changedBy || '', mine: r.changedBy === clientName() };
  }

  // ---------------------------------------------------------------- Sonus Connect version 2: the user's one session
  let sess = null;              // the session's connection (api/session.js), on a server that offers version 2
  let engKey = null;            // the session entry this browser's <audio> has loaded
  let loadedSaid = false, saidAt = 0, sayPositionAt = 0;
  let pending = [];             // reports made while the connection was down (this device plays on): said when it is back
  let sentVolume = null;
  const here = () => !!sess?.state.isActive && !sess.replaced; // another tab of this browser may be this device now
  const sessPosition = () => sess.state.positionAt(sess.state.serverNow()) / 1000;

  function startSession() {
    if (sess || !versions.get('sonusConnect')?.includes(2)) return;
    const wsUrl = `${rest}connect.view?${authParams(login, { protocol: 2 })}`.replace(/^http/, 'ws');
    sess = openSession({
      url: () => wsUrl, deviceId: connectDeviceId(), name: browserName(), kind: deviceKind(), client: `Sonus ${VERSION} (web)`,
      volume: () => ({ volume: player.volume, muted: player.muted }),
      // this device was the active one and still plays (a short network loss)
      resume: st => (st.isActive && engKey && player.trackId ? { rev: st.session.rev, playing: player.state === 'playing' || player.state === 'loading', positionMs: Math.round((el().currentTime || player.position || 0) * 1000) } : null),
      onConnection: status => {
        if (status === 'online') {
          applySession(true);
          if (here()) for (const r of pending) sess.send(report(r.event, r.key, r.positionMs, sess.state.session.rev, r.extra));
          pending = []; sentVolume = null; sayVolume();
        }
        if (status === 'replaced') { // another tab of this browser is this device now: this one is silent
          silence();
          Object.assign(player, { state: player.trackId ? 'paused' : 'stopped' }); pushPlayer();
          emit({ type: 'notice', kind: 'info', message: '这个浏览器的另一个标签页接管了播放。在这里按播放就回到这个标签页。' });
        }
        emit({ type: 'devices', devices: devices() });
      },
      onChange: (what, st) => {
        if (what.volume) { // another device changed this one's volume (rule 8)
          if (what.volume.muted !== undefined) setMutedHere(what.volume.muted);
          if (what.volume.volume !== undefined) setVolumeHere(what.volume.volume);
        }
        // errors that answer a command come back to the caller; the others (a song this device could not play) are said here
        if (what.error && what.error.ref == null && !QUIET_ERRORS.has(what.error.code)) emit({ type: 'notice', kind: what.error.code === 'unplayable' ? 'warn' : 'error', message: what.error.message || '服务器拒绝了这个操作。' });
        if (what.session || what.queue) applySession(what.welcome);
        if (what.devices || what.session) { emit({ type: 'devices', devices: devices() }); if (!here()) pushPlayer(); }
      },
    });
  }

  let appliedRev = -1, appliedQueueRev = -1;
  /** The session changed: its queue is shown; this browser's audio follows it while this is the active device, and is
   *  silent otherwise (the device playback leaves stops at once, rule 4). */
  function applySession(force = false) {
    const st = sess.state, s = st.session, q = st.queue;
    if (!st.queueReady) return; // the queue message comes first: wait for it when the session names a newer one
    if (!force && s.rev === appliedRev && q.queueRev === appliedQueueRev) return;
    appliedRev = s.rev; appliedQueueRev = q.queueRev;
    contextIds = q.order; pointer = q.pointer; queue = q.manual.map(m => ({ id: m.key, trackId: m.trackId }));
    Object.assign(player, { order: orderOf(s.mode), stopAfterCurrent: s.stopAfterCurrent, context: s.context ? { kind: s.context.kind, id: s.context.id, label: s.context.label } : null });
    emit({ type: 'queue', queue: queueEntries() });
    if (here()) followHere(s); else showElsewhere(s);
  }
  function silence() {
    if (engKey || el().getAttribute('src')) { ++ticket; unload(audio[0]); unload(audio[1]); }
    engKey = null; preloadId = null;
  }
  function showElsewhere(s) {
    silence();
    const t = s.current && T.get(s.current.trackId);
    Object.assign(player, {
      trackId: s.current?.trackId ?? null, state: !s.current ? 'stopped' : s.playing ? 'playing' : 'paused', error: null,
      position: sessPosition(), duration: s.durationMs > 0 ? s.durationMs / 1000 : t?.duration || null,
    });
    pushPlayer();
  }
  function engineNow() {
    const a = el();
    const state = !engKey ? 'none' : player.state === 'error' ? 'error' : a.ended ? 'ended' : player.state === 'loading' ? 'loading' : player.state === 'playing' ? 'playing' : 'paused';
    return { key: engKey, trackId: player.trackId, state, position: (a.currentTime || 0) * 1000 };
  }
  /** The active device's audio made to match the session: the current entry loaded, the position (when more than 1.5 s
   *  off), playing or paused, the next song preloaded. */
  function followHere(s) {
    const plan = follow(s, sess.state.deviceId, engineNow(), sess.state.positionAt(sess.state.serverNow()));
    if (plan.stop) { silence(); Object.assign(player, { trackId: null, state: 'stopped', position: 0, error: null }); pushPlayer(); return; }
    if (plan.load) {
      engKey = plan.load.key; loadedSaid = false;
      load(plan.load.trackId, { autoplay: plan.load.play, at: plan.load.at / 1000 });
      if (player.state === 'error') say('failed'); // not in this library
      else if (!plan.load.play) whenLoaded(() => say('paused'));
      return;
    }
    if (plan.idle) {
      // the song ended here and the session stopped there (the end of the queue, stop after current)
      if (!s.playing && el().ended) Object.assign(player, { state: 'paused', position: sessPosition() });
      pushPlayer(); return;
    }
    const a = el();
    if (plan.seek !== undefined) { try { a.currentTime = plan.seek / 1000; } catch { /* not loaded yet */ } player.position = plan.seek / 1000; emit({ type: 'position', position: player.position }); sayPositionAt = Date.now() + 500; }
    if (plan.play) { player.state = 'loading'; a.play().then(() => { if (a === el() && engKey) { player.state = 'playing'; pushPlayer(); say('playing'); } }).catch(err => { if (err?.name === 'NotAllowedError') { player.state = 'paused'; pushPlayer(); say('paused'); emit({ type: 'notice', kind: 'warn', message: '浏览器没有允许自动播放：点一下播放键，就在这里接着放。' }); } }); }
    if (plan.pause) { a.pause(); player.state = 'paused'; player.position = a.currentTime || player.position; say('paused'); }
    if (plan.preload && plan.preload !== preloadId && T.has(plan.preload)) { preloadId = plan.preload; audio[1 - cur].src = streamUrl(T.get(plan.preload)); applyVolume(); }
    else if (!plan.preload && preloadId) { unload(audio[1 - cur]); preloadId = null; }
    pushPlayer();
  }
  function whenLoaded(fn) { const a = el(), key = engKey; if (a.readyState >= 1) fn(); else a.addEventListener('loadedmetadata', () => { if (a === el() && engKey === key) fn(); }, { once: true }); }
  /** What this browser's audio really did, for the session (the active device only): `loaded` first for a new entry. */
  function say(event) {
    if (!sess || !here() || !engKey) return;
    const key = engKey, a = el(), at = (a.currentTime || 0) * 1000;
    const send = (ev, extra) => {
      if (sess.connected) sess.send(report(ev, key, at, sess.state.session.rev, extra));
      else { // kept for when the connection is back: the last of playing / paused / position is enough; endings all
        if (['playing', 'paused', 'position'].includes(ev)) pending = pending.filter(p => !['playing', 'paused', 'position'].includes(p.event));
        if (pending.length < 50) pending.push({ event: ev, key, positionMs: at, extra });
      }
    };
    if (!loadedSaid && event !== 'failed') {
      loadedSaid = true;
      const t = T.get(player.trackId), d = Number.isFinite(a.duration) && a.duration > 0 ? a.duration : t?.duration;
      send('loaded', { durationMs: d ? d * 1000 : undefined, now: t ? { title: t.title, artist: t.artist, album: t.album, albumId: t.albumId, coverArt: A.get(t.albumId)?.coverArt ?? t.coverArt } : undefined });
    }
    send(event);
    saidAt = Date.now();
  }
  /** This device's own volume, for the others' pickers (on every change). */
  function sayVolume() {
    if (!sess?.connected) return;
    const v = Math.round(player.volume * 1000) / 1000, key = `${v}|${player.muted}`;
    if (key === sentVolume) return;
    sentVolume = key; sess.send({ type: 'device', volume: v, muted: player.muted });
  }
  function setVolumeHere(v) { player.volume = Math.max(0, Math.min(1, v)); if (v > 0) player.muted = false; storage.set('sonus.volume', player.volume); applyVolume(); pushPlayer(); sayVolume(); }
  function setMutedHere(m) { player.muted = m; applyVolume(); pushPlayer(); sayVolume(); }

  // a volume slider dragged while another device plays: the latest value, at most every 100 ms
  let volumeWanted = null, volumeTimer = 0;
  function remoteVolume(device, v) {
    volumeWanted = { device: device.id, volume: Math.max(0, Math.min(1, v)), muted: v > 0 && device.muted ? false : undefined };
    if (volumeTimer) return;
    const send = () => { const w = volumeWanted; volumeWanted = null; if (!w) { volumeTimer = 0; return; } cmd('volume', w).catch(err => emit({ type: 'notice', kind: 'error', message: err.message })); volumeTimer = setTimeout(send, 100); };
    send();
  }
  /** A command for the session (connect.md, Commands); true when sent that way. A refusal is thrown (stale and
   *  notActive are not: the session moved on, and what it is now is on its way). Waits a moment for the connection. */
  async function cmd(action, fields) {
    if (!sess) return false;
    if (!sess.connected && !(await sess.ready(3000))) throw new Error('正在重新连接服务器，稍后再试。');
    const r = await sess.request(command(action, fields));
    if (!r.ok && !QUIET_ERRORS.has(r.code)) throw new Error(r.message || '服务器拒绝了这个操作。');
    return true;
  }
  /** Without the connection, the active device does what its audio can do by itself; the reports tell the server later. */
  const offlineHere = () => sess && !sess.connected && !sess.replaced && here();
  /** Shuffling by album or folder: the sender arranges the context (the server may not know albums and folders). */
  const arranged = (ids, order, start) => (order === 'shuffle-albums' || order === 'shuffle-folders' ? ordered(ids, order, start) : undefined);
  function devices() {
    if (!sess) return [];
    const t = T.get(player.trackId) ?? null;
    return pickerDevices(sess.state, { hereKind: deviceKind(), volumeHere: player.volume, mutedHere: player.muted, title: t?.title ?? sess.state.session.now?.title ?? null })
      .map(d => ({ ...d, connected: sess.connected }));
  }

  // ---------------------------------------------------------------- staying in step with other clients
  let refreshedAt = 0;
  async function refresh() {
    refreshedAt = Date.now();
    const before = library.tracks.length;
    try {
      const scan = (await call('getScanStatus').catch(() => null))?.scanStatus;
      if (scan && typeof scan.count === 'number' && scan.count !== before) { await loadLibrary(); emit({ type: 'library', library: libCopy(), changed: true }); }
      await loadPlaylists(); emitPlaylists();
    } catch (err) { console.warn('Navidrome refresh failed', err); }
  }
  window.addEventListener('focus', () => { if (Date.now() - refreshedAt > 60_000) refresh(); });
  setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 10 * 60_000);

  // ---------------------------------------------------------------- the contract
  const api = {
    capabilities: { replayGain: true },
    async connect() {
      const r = await call('ping');
      try { for (const x of (await call('getOpenSubsonicExtensions')).openSubsonicExtensions ?? []) { extensions.add(x.name); versions.set(x.name, x.versions ?? []); } } catch { /* plain Subsonic */ }
      const name = r.type === 'navidrome' ? 'Navidrome' : r.type ? r.type[0].toUpperCase() + r.type.slice(1) : 'Subsonic';
      server = { name, version: `${name} ${r.serverVersion ?? ''}`.trim(), api: r.version };
      return { ...server };
    },
    async library() { await loadLibrary(); await loadPlaylists(); refreshedAt = Date.now(); refreshOutputs(); startSession(); return libCopy(); },
    async playlists() { return appPlaylists(); },
    player: snapshot,
    queue: queueEntries,
    outputs: () => outputs.map(o => ({ ...o })),
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    about: () => ({ player: server.version || 'Navidrome', plugin: `Subsonic API ${server.api ?? API_VERSION}${extensions.size ? ' + OpenSubsonic' : ''}` }),
    account: () => ({ server: base, user: login.user, client: clientName(), kind: login.apiKey ? 'key' : 'token' }),
    /** The server's OpenSubsonic extensions by name (known after connect). */
    extensions: () => new Set(extensions),
    async signOut() { if (sess) { sess.close(); sess = null; } unload(audio[0]); unload(audio[1]); await signOut(); },
    loginStorage,
    refresh,
    /** The <audio> element playing now (diagnostics and acceptance checks). */
    mediaElement: () => el(),

    async play({ context, trackId, shuffle }) {
      if (sess) {
        const ids = windowOf(context.trackIds.filter(id => T.has(id)), trackId ?? null);
        if (!ids.length) return;
        const order = shuffle && !ORDERS_SHUFFLE(player.order) ? 'shuffle-tracks' : player.order;
        const start = trackId ?? (arranged(ids, order) ? ids[Math.floor(Math.random() * ids.length)] : undefined);
        const order2 = arranged(ids, order, start);
        await cmd('playContext', { context: { kind: context.kind, id: context.id, label: context.label }, ids, startId: start, shuffle: shuffle ? true : undefined, order: order2 });
        return;
      }
      if (shuffle && !ORDERS_SHUFFLE(player.order)) player.order = 'shuffle-tracks';
      const ids = context.trackIds.filter(id => T.has(id));
      if (!ids.length) return;
      const start = trackId ?? (ORDERS_SHUFFLE(player.order) || player.order === 'random' ? ids[Math.floor(Math.random() * ids.length)] : ids[0]);
      contextIds = ordered(ids, player.order, start); pointer = Math.max(0, contextIds.indexOf(start));
      player.context = { kind: context.kind, id: context.id, label: context.label };
      pushQueue(); load(contextIds[pointer]);
    },
    async pause() { if (sess && !offlineHere()) { await cmd('pause'); return; } if (player.state === 'playing' || player.state === 'loading') { el().pause(); player.state = 'paused'; player.position = el().currentTime || player.position; pushPlayer(); saveQueue({ soon: true }); } },
    async resume() {
      if (sess) {
        if (sess.replaced) sess.reconnect(); // this tab takes the device back
        // a song that failed here: tried again here
        if (here() && player.state === 'error' && player.trackId) { load(player.trackId, { at: player.position }); return; }
        if (!offlineHere()) { await cmd('play'); return; }
      }
      if (!player.trackId) return;
      if (player.state === 'error' || player.state === 'stopped' || !el().getAttribute('src')) { load(player.trackId); return; }
      player.state = 'playing'; pushPlayer();
      await el().play().catch(err => { if (err?.name !== 'AbortError') { player.state = 'paused'; pushPlayer(); throw new Error('浏览器没有允许播放：先点一下页面再试。'); } });
    },
    async next() { if (await cmd('next')) return; advance(1); },
    async previous() { if (await cmd('previous')) return; if (player.position > 3) await api.seek(0); else advance(-1); },
    async seek(s) {
      if (sess && !offlineHere()) { await cmd('seek', { positionMs: Math.max(0, Math.round(s * 1000)) }); return; }
      const to = Math.max(0, Math.min(player.duration ?? Infinity, s));
      try { el().currentTime = to; } catch { /* not loaded yet */ }
      player.position = to; emit({ type: 'position', position: to }); saveQueue(); mediaPosition();
      if (to < (player.duration ?? 0) - 20 && preloadId) { unload(audio[1 - cur]); preloadId = null; } // seeking back: load the next one again later
    },
    async setVolume(v) {
      const away = sess?.state.activeElsewhere;
      if (away) { remoteVolume(away, v); return; } // rule 8: the device that plays
      if (sess) { setVolumeHere(v); return; }
      player.volume = Math.max(0, Math.min(1, v)); if (v > 0) player.muted = false; storage.set('sonus.volume', player.volume); applyVolume(); pushPlayer(); },
    async setMuted(m) {
      const away = sess?.state.activeElsewhere;
      if (away) { await cmd('volume', { device: away.id, muted: m }); return; }
      if (sess) { setMutedHere(m); return; }
      player.muted = m; applyVolume(); pushPlayer(); },
    async setOrder(order) {
      if (sess) {
        const source = appPlaylists().find(p => p.id === player.context?.id)?.trackIds ?? contextIds;
        await cmd('mode', { mode: modeOf(order), order: contextIds.length ? arranged(source.filter(id => contextIds.includes(id)), order, player.trackId) : undefined });
        return;
      }
      const was = player.order; player.order = order;
      if (contextIds.length && (ORDERS_SHUFFLE(order) || ORDERS_SHUFFLE(was))) {
        const source = appPlaylists().find(p => p.id === player.context?.id)?.trackIds ?? contextIds, c = player.trackId;
        contextIds = ordered(ORDERS_SHUFFLE(order) ? contextIds : source.filter(id => contextIds.includes(id)), order, c); pointer = Math.max(0, contextIds.indexOf(c));
      }
      if (preloadId) { unload(audio[1 - cur]); preloadId = null; }
      pushQueue(); pushPlayer();
    },
    async setStopAfterCurrent(on) { if (await cmd('stopAfterCurrent', { on: !!on })) return; player.stopAfterCurrent = on; if (on && preloadId) { unload(audio[1 - cur]); preloadId = null; } pushPlayer(); },
    async setReplayGain(mode) { player.replayGain = mode; storage.set('sonus.replaygain', mode); applyVolume(); pushPlayer(); },
    // ---- Sonus Connect version 2 (contract.js, ConnectClient): the user's devices, and moving playback between them
    /** True while this client shows the user's session on the server (the server offers version 2). */
    connected: () => !!sess,
    /** The devices for the picker: this browser first ({ id, name, kind, canPlay, volume, muted, active, self, status, connected }). */
    devices,
    /** Moves playback to that device (rule 4): the one it leaves stops. This browser included ("play here"). */
    async transfer(deviceId) {
      if (deviceId === sess?.state.deviceId && sess.replaced) sess.reconnect();
      await cmd('transfer', { to: deviceId });
    },
    /** Any device's volume (rule 8): this one's here, another's through the server. */
    async setDeviceVolume(deviceId, volume, muted) {
      if (!sess || deviceId === sess.state.deviceId) { if (muted !== undefined) setMutedHere(muted); if (volume !== undefined) setVolumeHere(volume); return; }
      await cmd('volume', { device: deviceId, volume, muted });
    },

    async setOutput(id) {
      if (!el().setSinkId) throw new Error('这个浏览器不能切换输出设备。');
      const o = outputs.find(x => x.id === id); if (!o) return;
      outputs = outputs.map(x => (x.id === id ? { ...x, state: 'connecting' } : x)); emit({ type: 'outputs', outputs: outputs.map(x => ({ ...x })) });
      try { await Promise.all(audio.map(a => a.setSinkId(id === 'default' ? '' : id))); }
      catch (err) { outputs = outputs.map(x => (x.id === id ? { ...x, state: 'error', detail: err?.message || '无法使用' } : x)); emit({ type: 'outputs', outputs: outputs.map(x => ({ ...x })) }); throw new Error(`无法切换到 ${o.name}：${err?.message || '设备不可用'}`); }
      player.output = id;
      outputs = outputs.map(x => ({ ...x, state: x.id === id ? 'connected' : x.state === 'unavailable' ? x.state : 'available', detail: x.id === id ? o.detail : x.detail }));
      emit({ type: 'outputs', outputs: outputs.map(x => ({ ...x })) }); pushPlayer();
    },

    async queueAdd(trackIds, { next = false } = {}) {
      if (await cmd('add', { ids: trackIds.filter(id => T.has(id)), next: !!next })) return;
      const entries = trackIds.filter(id => T.has(id)).map(trackId => ({ id: `q${++qid}`, trackId }));
      queue = next ? [...entries, ...queue] : [...queue, ...entries];
      if (preloadId) { unload(audio[1 - cur]); preloadId = null; }
      pushQueue();
    },
    async queueMove({ order, keys, section }) {
      if (await cmd('move', { order, keys, manual: section === 'queue' })) return;
      const entries = new Map(queueEntries().map(e => [e.id, e]));
      const placed = order.map(id => { const e = entries.get(id); return keys.includes(id) ? { ...e, section } : e; }).filter(Boolean);
      queue = placed.filter(e => e.section === 'queue').map(e => (e.id.startsWith('q') ? { id: e.id, trackId: e.trackId } : { id: `q${++qid}`, trackId: e.trackId }));
      contextIds = [...contextIds.slice(0, pointer + 1), ...placed.filter(e => e.section === 'context').map(e => e.trackId)];
      if (preloadId) { unload(audio[1 - cur]); preloadId = null; }
      pushQueue();
    },
    async queueRemove(ids) {
      if (await cmd('remove', { entries: ids })) return;
      const ctxIdx = new Set(ids.filter(id => id.startsWith('c')).map(id => Number(id.slice(1, id.indexOf(':')))));
      queue = queue.filter(q => !ids.includes(q.id)); contextIds = contextIds.filter((_, i) => !ctxIdx.has(i));
      if (preloadId) { unload(audio[1 - cur]); preloadId = null; }
      pushQueue();
    },
    async queueClear(section) { if (await cmd('clear', { manual: section === 'queue' })) return; if (section === 'queue') queue = []; else contextIds = contextIds.slice(0, pointer + 1); if (preloadId) { unload(audio[1 - cur]); preloadId = null; } pushQueue(); },
    async playQueueEntry(entryId) {
      if (await cmd('jump', { entry: entryId })) return;
      const e = queueEntries().find(x => x.id === entryId); if (!e) return;
      if (e.section === 'queue') queue = queue.filter(q => q.id !== entryId);
      else pointer = Number(entryId.slice(1, entryId.indexOf(':')));
      pushQueue(); load(e.trackId);
    },

    async setLiked(trackId, liked) {
      const t = T.get(trackId); if (!t) return;
      await call(liked ? 'star' : 'unstar', { id: trackId });
      t.liked = liked; t.starredAt = liked ? Date.now() : 0;
      emit({ type: 'track', track: { ...t } }); emitPlaylists();
    },
    async playlistCreate(name, trackIds = []) {
      const r = await call('createPlaylist', { name, songId: trackIds }, { post: true });
      let id = r.playlist?.id;
      if (!id) { await loadPlaylists(); id = [...pls].filter(p => p.name === name).sort((a, b) => b.changed - a.changed)[0]?.id; } // an older server answers without the playlist
      else pls.push({ id, name, owner: login.user, comment: '', changed: Date.now(), readonly: false, entries: [...trackIds] });
      emitPlaylists();
      return appPlaylists().find(p => p.id === id) ?? { id, name, kind: 'user', trackIds: [...trackIds], updated: Date.now() };
    },
    async playlistRename(id, name) { const p = own(id); await call('updatePlaylist', { playlistId: id, name }, { post: true }); p.name = name; p.changed = Date.now(); emitPlaylists(); },
    async playlistDelete(id) { own(id); await call('deletePlaylist', { id }, { post: true }); pls = pls.filter(p => p.id !== id); emitPlaylists(); },
    async playlistAdd(id, trackIds) {
      if (id === 'liked') { for (const t of trackIds) await api.setLiked(t, true); return; }
      const p = own(id);
      await call('updatePlaylist', { playlistId: id, songIdToAdd: trackIds }, { post: true });
      p.entries = [...p.entries, ...trackIds]; p.changed = Date.now(); emitPlaylists();
    },
    async playlistRemove(id, trackIds) {
      if (id === 'liked') { for (const t of trackIds) await api.setLiked(t, false); return; }
      const p = own(id), drop = new Set(trackIds);
      const indices = p.entries.flatMap((t, i) => (drop.has(t) ? [i] : []));
      if (!indices.length) return;
      await call('updatePlaylist', { playlistId: id, songIndexToRemove: indices }, { post: true });
      p.entries = p.entries.filter(t => !drop.has(t)); p.changed = Date.now(); emitPlaylists();
    },
    async playlistReorder(id, order, { keys, before } = {}) {
      const p = own(id);
      if (!keys?.length) { await rewrite(p, [...order]); return; } // Undo: the order given is the order wanted
      const moving = new Set(keys), kept = p.entries.filter(t => !moving.has(t)), moved = p.entries.filter(t => moving.has(t));
      const at = before == null ? kept.length : Math.max(0, kept.indexOf(before));
      await rewrite(p, [...kept.slice(0, at), ...moved, ...kept.slice(at)]); // duplicates in the playlist stay
    },

    // artwork: the server scales it; the URL is the same every time (a fixed salt), so the browser's cache keeps it
    artworkNow: (albumId, size = 600) => { const art = A.get(albumId)?.coverArt; return art ? url('getCoverArt', { id: art, size }) : null; },
    artwork(albumId) { return Promise.resolve(api.artworkNow(albumId)); },
    async lyrics(trackId, signal) {
      const t = T.get(trackId); if (!t) return null;
      if (extensions.has('songLyrics')) {
        try {
          const list = (await call('getLyricsBySongId', { id: trackId }, { signal })).lyricsList?.structuredLyrics ?? [];
          const pick = list.find(l => l.synced && l.line?.length) ?? list.find(l => l.line?.length);
          // OpenSubsonic: a positive offset shows the lyrics sooner (as the Windows app reads it)
          if (pick) return pick.synced ? pick.line.map(l => ({ time: Math.max(0, (l.start ?? 0) / 1000 - (pick.offset ?? 0) / 1000), text: l.value ?? '' })) : pick.line.map(l => ({ text: l.value ?? '' }));
        } catch (err) { if (err?.name === 'AbortError') throw err; }
      }
      const r = await call('getLyrics', { artist: t.artist, title: t.title }, { signal }).catch(err => { if (err?.name === 'AbortError') throw err; return null; });
      return parseLyrics(r?.lyrics?.value ?? '');
    },
    async search(query) {
      const q = String(query ?? '').trim(); if (!q) return { tracks: [], albums: [], artists: [], playlists: [] };
      const has = s => lower(s).includes(lower(q));
      const playlists = appPlaylists().filter(p => has(p.name)).map(p => p.id);
      try {
        const r = (await call('search3', { query: q, songCount: 200, albumCount: 60, artistCount: 30 })).searchResult3 ?? {};
        const artistIds = new Set(library.artists.map(a => a.id));
        return {
          tracks: (r.song ?? []).map(s => s.id).filter(id => T.has(id)),
          albums: (r.album ?? []).map(a => a.id).filter(id => A.get(id)?.trackIds.length),
          artists: (r.artist ?? []).map(a => a.id).filter(id => artistIds.has(id)),
          playlists,
        };
      } catch (err) {
        if (connection === 'offline') throw err;
        return { // the server refused the words: search what is loaded here
          tracks: library.tracks.filter(t => has(t.title) || has(t.artist) || has(t.album)).map(t => t.id),
          albums: library.albums.filter(a => has(a.title) || has(a.artist)).map(a => a.id),
          artists: library.artists.filter(a => has(a.name)).map(a => a.id), playlists,
        };
      }
    },
    /** The queue saved on the server (by another device, or by this one last time), or null. */
    remoteQueue,
    /** When this client last saved its queue to the server (ms). */
    queueSavedAt: () => savedAt,
    /** Takes over a saved queue: its song at its position, paused unless `autoplay`. */
    continueQueue(q, label, { autoplay = false } = {}) {
      const ids = q.trackIds.filter(id => T.has(id)); if (!ids.includes(q.current)) return;
      contextIds = ids; pointer = Math.max(0, ids.indexOf(q.current)); queue = [];
      player.context = { kind: 'queue', id: 'continue', label };
      pushQueue(); load(q.current, { autoplay, at: q.position });
    },
    /** A radio from a song: the song, then up to 50 similar ones (getSimilarSongs2; without Last.fm on the server,
     *  songs of the same artist or genre from the library). */
    async similar(trackId) {
      let ids = [];
      try { ids = ((await call('getSimilarSongs2', { id: trackId, count: 50 })).similarSongs2?.song ?? []).map(s => { if (!T.has(s.id)) T.set(s.id, trackOf(s)); return s.id; }); }
      catch (err) { if (connection === 'offline') throw err; }
      if (!ids.length) { const t = T.get(trackId); ids = shuffled(library.tracks.filter(x => x.id !== trackId && (x.artistId === t?.artistId || x.genre === t?.genre))).slice(0, 50).map(x => x.id); }
      return [trackId, ...ids.filter(id => id !== trackId)];
    },
    /** The artist's biography and Last.fm page (getArtistInfo2), or null. */
    async artistInfo(artistId, signal) {
      const r = (await call('getArtistInfo2', { id: artistId }, { signal }).catch(err => { if (err?.name === 'AbortError') throw err; return null; }))?.artistInfo2;
      const bio = String(r?.biography ?? '').replace(/<a\b[^>]*>[\s\S]*?<\/a>\.?/gi, '').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').trim();
      return bio || r?.lastFmUrl ? { bio, url: r?.lastFmUrl || null } : null;
    },
    goOnline() { setConnection('connecting'); call('ping').then(() => refresh()).catch(() => setConnection('offline')); },
    orderToBar, barToOrder,
  };
  return api;
}
