// The music server client: Navidrome, or any server speaking the Subsonic API with the OpenSubsonic extensions
// (spec: subsonic.org/pages/api.jsp and opensubsonic.netlify.app), behind the interface's contract (contract.js).
//
// What the server gives and how it maps:
// - The library: every song (search3 with an empty query, paged) and every album (getAlbumList2, paged). Albums and
//   artists keep the server's ids, so they group the way Navidrome groups them (album artist, compilations).
// - Playlists, likes (star / unstar; "Liked Songs" is the starred songs), play counts (scrobble), artwork
//   (getCoverArt), lyrics (getLyricsBySongId, then getLyrics), search (search3), song radio (getSimilarSongs2),
//   artist biographies (getArtistInfo2) and the queue to continue on another device (savePlayQueue / getPlayQueue)
//   live on the server, so every device sees the same.
// - Playback happens here: two <audio> elements play stream URLs. The second one loads the next song before the first
//   ends, so the change of track has no network wait (a few milliseconds of gap remain; true gapless needs a native
//   player). The queue, playback order and "stop after current" are this client's own.
// - Formats a browser cannot decode (DSD, APE, WavPack …) are asked for transcoded (Opus); Navidrome does that with
//   ffmpeg when a transcoding for Opus is configured (it is by default).
// - A play counts once the position passes half the song or four minutes, whichever comes first.
//
// Sign-in: Subsonic token authentication, md5(password + salt). The password is not kept: the salt and token are. In
// the desktop app they go to Windows Credential Manager (through the window, see host below), in a browser to local
// storage (sonus.login). The token works like the password for this API, so it is a secret.
import { orderToBar, barToOrder } from './contract.js';
import { lower, parseLyrics } from './lyrics.js';
import { md5 } from './md5.js';

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
  if (!(login?.server && login?.user && login?.token && login?.salt)) login = null;
  return login;
}
/** The saved sign-in ({ server, user, salt, token }), or null. */
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
  login = null;
  if (host) { try { await host('deleteLogin'); } catch { /* already gone */ } } else storage.del(LOGIN_KEY);
}
/** The client name the server sees (Navidrome lists it under Players and as who saved the play queue). */
const clientName = () => {
  let id = storage.get('sonus.device');
  if (!id) { id = Math.random().toString(36).slice(2, 8); storage.set('sonus.device', id); }
  return `${APP} (${deviceName || `浏览器 ${id}`})`;
};

/** "music.example.com", "http://host:4533/", "https://host/rest" → "https://music.example.com", "http://host:4533", "https://host". */
export function normalizeServer(input) {
  let s = String(input ?? '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = `${/^(localhost|127\.|10\.|192\.168\.|\[)/.test(s) ? 'http' : 'https'}://${s}`;
  return s.replace(/\/+$/, '').replace(/\/(rest|app)(\/.*)?$/i, '');
}

const ERRORS = {
  10: '请求缺少必要的参数。', 20: '服务器的 Subsonic API 版本太旧。', 30: `${APP} 需要更新才能连接这个服务器。`,
  40: '用户名或密码不正确。', 41: '这个账号不能用 token 登录（例如 LDAP 账号）。', 50: '这个账号没有执行这个操作的权限。', 70: '服务器上找不到这项内容。',
};
function failure(err) { const e = new Error(ERRORS[err?.code] ?? err?.message ?? '服务器拒绝了请求。'); e.code = err?.code; return e; }

function authParams(login, extra = {}) {
  const p = new URLSearchParams({ u: login.user, t: login.token, s: login.salt, v: API_VERSION, c: clientName(), f: 'json' });
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
  let res;
  try { res = await fetch(`${base}/rest/ping.view?${authParams(next)}`); }
  catch { throw new Error(`连不上 ${base}。检查地址和网络；服务器在外网时需要 HTTPS。`); }
  let body = null;
  try { body = (await res.json())['subsonic-response']; } catch { /* not a Subsonic server */ }
  if (!body) throw new Error(`${base} 不像是 Navidrome（没有 Subsonic API 的回应）。`);
  if (body.status !== 'ok') throw failure(body.error);
  await keepLogin(next);
  return next;
}

// ---------------------------------------------------------------- the client
export function createSubsonicClient({ login = savedLogin(), scrobble = true } = {}) {
  if (!login) throw new Error('还没有登录音乐服务器。');
  const base = login.server, rest = `${base}/rest/`;
  const listeners = new Set();
  const emit = e => { for (const fn of listeners) { try { fn(e); } catch (err) { console.error(err); } } };
  let connection = 'connecting', server = { name: 'Navidrome', version: '' }, extensions = new Set();
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
  const snapshot = () => ({ ...player, context: player.context && { ...player.context } });
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
      player.state = 'playing'; pushPlayer(); saveQueue({ soon: true });
      if (scrobble) call('scrobble', { id: trackId, submission: false }).catch(() => {}); // "now playing"
    }).catch(err => {
      if (my !== ticket || err?.name === 'AbortError') return;
      if (err?.name === 'NotAllowedError') { player.state = 'paused'; pushPlayer(); return; } // the browser wants a click first
      fail(t, err?.message);
    });
  }
  function fail(t, detail) {
    Object.assign(player, { state: 'error', error: `无法播放“${t?.title ?? ''}”：${detail || '未知错误'}` });
    pushPlayer();
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
      if (player.stopAfterCurrent) { player.stopAfterCurrent = false; stop(); return; }
      if (player.order === 'repeat-track') { a.currentTime = 0; a.play().catch(() => {}); counted = false; return; }
      advance(1);
    });
    a.addEventListener('error', () => { if (a === el() && a.getAttribute('src')) fail(T.get(player.trackId), MEDIA_ERRORS[a.error?.code]); });
    a.addEventListener('durationchange', () => { if (a === el() && Number.isFinite(a.duration) && a.duration > 0 && !player.duration) { player.duration = a.duration; pushPlayer(); } });
    // paused or resumed from outside (the system's media controls, a headset button)
    a.addEventListener('pause', () => { if (a === el() && !a.ended && player.state === 'playing') { player.state = 'paused'; pushPlayer(); } });
    a.addEventListener('play', () => { if (a === el() && player.state === 'paused') { player.state = 'playing'; pushPlayer(); } });
  }
  setInterval(() => {
    if (player.state !== 'playing') return;
    player.position = el().currentTime;
    emit({ type: 'position', position: player.position });
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
  }
  if (navigator.mediaSession) {
    const on = (action, fn) => { try { navigator.mediaSession.setActionHandler(action, fn); } catch { /* not supported */ } };
    on('play', () => api.resume()); on('pause', () => api.pause()); on('nexttrack', () => api.next()); on('previoustrack', () => api.previous());
    on('seekto', e => api.seek(e.seekTime));
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
    clearTimeout(saveT);
    saveT = setTimeout(() => { const q = queueForServer(); if (!q) return; savedAt = Date.now(); call('savePlayQueue', q, { post: true }).catch(() => {}); }, soon ? 0 : 1500);
  }
  // closing the window: the position as it is (a beacon still goes out while the page unloads)
  addEventListener('pagehide', () => { const q = queueForServer(); if (q && player.state !== 'stopped') navigator.sendBeacon?.(`${rest}savePlayQueue.view`, authParams(login, q)); });
  async function remoteQueue() {
    const r = (await call('getPlayQueue')).playQueue;
    if (!r?.entry?.length || !r.current) return null;
    for (const s of r.entry) if (!T.has(s.id)) T.set(s.id, trackOf(s));
    return { trackIds: r.entry.map(e => e.id), current: r.current, position: (r.position ?? 0) / 1000, changed: Date.parse(r.changed) || 0, changedBy: r.changedBy || '', mine: r.changedBy === clientName() };
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
      try { for (const x of (await call('getOpenSubsonicExtensions')).openSubsonicExtensions ?? []) extensions.add(x.name); } catch { /* plain Subsonic */ }
      const name = r.type === 'navidrome' ? 'Navidrome' : r.type ? r.type[0].toUpperCase() + r.type.slice(1) : 'Subsonic';
      server = { name, version: `${name} ${r.serverVersion ?? ''}`.trim(), api: r.version };
      return { ...server };
    },
    async library() { await loadLibrary(); await loadPlaylists(); refreshedAt = Date.now(); refreshOutputs(); return libCopy(); },
    async playlists() { return appPlaylists(); },
    player: snapshot,
    queue: queueEntries,
    outputs: () => outputs.map(o => ({ ...o })),
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    about: () => ({ player: server.version || 'Navidrome', plugin: `Subsonic API ${server.api ?? API_VERSION}${extensions.size ? ' + OpenSubsonic' : ''}` }),
    account: () => ({ server: base, user: login.user, client: clientName() }),
    async signOut() { unload(audio[0]); unload(audio[1]); await signOut(); },
    loginStorage,
    refresh,
    /** The <audio> element playing now (diagnostics and acceptance checks). */
    mediaElement: () => el(),

    async play({ context, trackId, shuffle }) {
      if (shuffle && !ORDERS_SHUFFLE(player.order)) player.order = 'shuffle-tracks';
      const ids = context.trackIds.filter(id => T.has(id));
      if (!ids.length) return;
      const start = trackId ?? (ORDERS_SHUFFLE(player.order) || player.order === 'random' ? ids[Math.floor(Math.random() * ids.length)] : ids[0]);
      contextIds = ordered(ids, player.order, start); pointer = Math.max(0, contextIds.indexOf(start));
      player.context = { kind: context.kind, id: context.id, label: context.label };
      pushQueue(); load(contextIds[pointer]);
    },
    async pause() { if (player.state === 'playing' || player.state === 'loading') { el().pause(); player.state = 'paused'; player.position = el().currentTime || player.position; pushPlayer(); saveQueue({ soon: true }); } },
    async resume() {
      if (!player.trackId) return;
      if (player.state === 'error' || player.state === 'stopped' || !el().getAttribute('src')) { load(player.trackId); return; }
      player.state = 'playing'; pushPlayer();
      await el().play().catch(err => { if (err?.name !== 'AbortError') { player.state = 'paused'; pushPlayer(); throw new Error('浏览器没有允许播放：先点一下页面再试。'); } });
    },
    async next() { advance(1); },
    async previous() { if (player.position > 3) await api.seek(0); else advance(-1); },
    async seek(s) {
      const to = Math.max(0, Math.min(player.duration ?? Infinity, s));
      try { el().currentTime = to; } catch { /* not loaded yet */ }
      player.position = to; emit({ type: 'position', position: to }); saveQueue();
      if (to < (player.duration ?? 0) - 20 && preloadId) { unload(audio[1 - cur]); preloadId = null; } // seeking back: load the next one again later
    },
    async setVolume(v) { player.volume = Math.max(0, Math.min(1, v)); if (v > 0) player.muted = false; storage.set('sonus.volume', player.volume); applyVolume(); pushPlayer(); },
    async setMuted(m) { player.muted = m; applyVolume(); pushPlayer(); },
    async setOrder(order) {
      const was = player.order; player.order = order;
      if (contextIds.length && (ORDERS_SHUFFLE(order) || ORDERS_SHUFFLE(was))) {
        const source = appPlaylists().find(p => p.id === player.context?.id)?.trackIds ?? contextIds, c = player.trackId;
        contextIds = ordered(ORDERS_SHUFFLE(order) ? contextIds : source.filter(id => contextIds.includes(id)), order, c); pointer = Math.max(0, contextIds.indexOf(c));
      }
      if (preloadId) { unload(audio[1 - cur]); preloadId = null; }
      pushQueue(); pushPlayer();
    },
    async setStopAfterCurrent(on) { player.stopAfterCurrent = on; if (on && preloadId) { unload(audio[1 - cur]); preloadId = null; } pushPlayer(); },
    async setReplayGain(mode) { player.replayGain = mode; storage.set('sonus.replaygain', mode); applyVolume(); pushPlayer(); },
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
      const entries = trackIds.filter(id => T.has(id)).map(trackId => ({ id: `q${++qid}`, trackId }));
      queue = next ? [...entries, ...queue] : [...queue, ...entries];
      if (preloadId) { unload(audio[1 - cur]); preloadId = null; }
      pushQueue();
    },
    async queueMove({ order, keys, section }) {
      const entries = new Map(queueEntries().map(e => [e.id, e]));
      const placed = order.map(id => { const e = entries.get(id); return keys.includes(id) ? { ...e, section } : e; }).filter(Boolean);
      queue = placed.filter(e => e.section === 'queue').map(e => (e.id.startsWith('q') ? { id: e.id, trackId: e.trackId } : { id: `q${++qid}`, trackId: e.trackId }));
      contextIds = [...contextIds.slice(0, pointer + 1), ...placed.filter(e => e.section === 'context').map(e => e.trackId)];
      if (preloadId) { unload(audio[1 - cur]); preloadId = null; }
      pushQueue();
    },
    async queueRemove(ids) {
      const ctxIdx = new Set(ids.filter(id => id.startsWith('c')).map(id => Number(id.slice(1, id.indexOf(':')))));
      queue = queue.filter(q => !ids.includes(q.id)); contextIds = contextIds.filter((_, i) => !ctxIdx.has(i));
      if (preloadId) { unload(audio[1 - cur]); preloadId = null; }
      pushQueue();
    },
    async queueClear(section) { if (section === 'queue') queue = []; else contextIds = contextIds.slice(0, pointer + 1); if (preloadId) { unload(audio[1 - cur]); preloadId = null; } pushQueue(); },
    async playQueueEntry(entryId) {
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
    artworkNow: albumId => { const art = A.get(albumId)?.coverArt; return art ? url('getCoverArt', { id: art, size: 600 }) : null; },
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
