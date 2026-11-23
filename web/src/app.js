// Sonus: a Spotify-style player for your own music server (Navidrome, or any Subsonic-compatible server),
// built on CreeperUX UI Kit 2.5.0. The app holds no playback state of its own: it shows what the client (api/subsonic.js,
// behind the contract in api/contract.js) reports and sends it what the person asks for. The shell is the kit's workspace: library on the start side, the view in the middle,
// Now playing / Queue on the end side and the playback bar along the bottom. Views are plain modules mounted per
// route (#/album/al3, #/playlist/liked, #/search/雨 …).
import * as UI from '../vendor/creeperux-gui/ui/index.js';
import * as P from '../vendor/creeperux-gui/plus/index.js';
import * as M from '../vendor/creeperux-gui/media/index.js';
import { STRINGS } from './strings.js';
import { createSubsonicClient, loadLogin, savedLogin, signOut } from './api/subsonic.js';
import { mountLogin } from './views/login.js';
import { assertAdapter } from './api/contract.js';
import { h } from './dom.js';
import { registerAppIcons } from './icons.js';
import { mountTopbar } from './shell/topbar.js';
import { mountLibrary } from './shell/library.js';
import { mountPanel } from './shell/panel.js';
import { mountBar } from './shell/bar.js';
import { VIEWS, parseRoute } from './views/index.js';
import { showProperties, mosaic } from './views/common.js';
import { createAppMotion } from './motion.js';

// ---------------------------------------------------------------- preferences (layout widths are the person's, D78)
const PREFS_KEY = 'sonus.prefs';
const DEFAULTS = { theme: 'dark', density: '', locale: 'zh-CN', startWidth: 300, startOpen: true, endWidth: 340, endOpen: true, panel: 'now', libFilter: null, libSort: 'recent' };
const prefs = (() => { try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }; } catch { return { ...DEFAULTS }; } })();
const query = new URLSearchParams(location.search);
for (const k of ['theme', 'density', 'locale']) if (query.has(k)) prefs[k] = query.get(k);
if (query.has('panel')) { prefs.panel = query.get('panel') === 'closed' ? prefs.panel : query.get('panel'); prefs.endOpen = query.get('panel') !== 'closed'; }
const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* private mode: keep them for this session */ } };

const root = document.getElementById('app');

// ---------------------------------------------------------------- the server: a saved sign-in, or the sign-in page
// In the desktop app the sign-in is kept in Windows Credential Manager (read through the app's host object), in a
// browser in local storage. ?server=… pre-fills the sign-in page; ?demo=1 offers the local demo server's account.
const T = STRINGS[prefs.locale] || STRINGS['zh-CN'];
await loadLogin();
if (!savedLogin()) await showLogin(); // never resolves: signing in reloads the page
function showLogin(error = '') {
  applyLook();
  mountLogin(root, { UI, S: UI.createServices({ root, locale: prefs.locale }), t: T, server: query.get('server') || '', demo: query.get('demo'), error });
  return new Promise(() => {});
}
function applyLook() {
  if (prefs.theme === 'system') delete root.dataset.theme; else root.dataset.theme = prefs.theme;
  if (prefs.density) root.dataset.density = prefs.density;
  root.lang = prefs.locale; document.documentElement.lang = prefs.locale;
}
const adapter = assertAdapter(createSubsonicClient());

// ---------------------------------------------------------------- the app context handed to every part
const listeners = new Map();
const ctx = {
  UI, P, M, adapter, prefs, savePrefs, root,
  t: T,
  lib: { tracks: new Map(), albums: new Map(), artists: new Map(), trackList: [], albumList: [], artistList: [] },
  playlists: [], player: adapter.player(), queue: [], outputs: [], connection: 'connecting', server: null, source: 'subsonic',
  on(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); return () => listeners.get(type)?.delete(fn); },
  emit(type, payload) { for (const fn of [...(listeners.get(type) || [])]) { try { fn(payload); } catch (e) { console.error(e); } } },
  go(path, { replace = false } = {}) { const hash = `#${path.startsWith('/') ? path : `/${path}`}`; if (location.hash === hash) return; if (replace) location.replace(hash); else location.hash = hash; },
  route: parseRoute(location.hash),
};

// artwork: one resolver per album, so every image of it shares the adapter's cache (the newest request wins, G61)
const artCache = new Map();
ctx.art = albumId => {
  if (!albumId) return null;
  if (adapter.artworkNow) return adapter.artworkNow(albumId);
  if (!artCache.has(albumId)) artCache.set(albumId, signal => adapter.artwork(albumId, signal));
  return artCache.get(albumId);
};
ctx.kitTrack = (t, { numbered = false } = {}) => t && ({
  id: t.id, title: t.title, artist: t.artist, album: t.album, duration: t.duration, number: numbered ? undefined : t.number, artwork: ctx.art(t.albumId),
  added: t.added, liked: !!t.liked, unavailable: !!t.unavailable, reason: t.reason,
});
ctx.track = id => ctx.lib.tracks.get(id);
ctx.currentTrack = () => ctx.track(ctx.player.trackId);
ctx.playlist = id => ctx.playlists.find(p => p.id === id);
ctx.isActive = () => ['playing', 'loading'].includes(ctx.player.state);
ctx.playlistArt = p => {
  if (!p) return null;
  if (p.kind === 'liked' || p.kind === 'library') return null; // drawn by CSS (a gradient and an icon)
  const albums = [...new Set(p.trackIds.map(id => ctx.track(id)?.albumId).filter(Boolean))];
  if (albums.length < 4) return ctx.art(albums[0]);
  return mosaic(albums.slice(0, 4).map(ctx.art), `${p.id}:${albums.slice(0, 4).join()}`);
};
ctx.playlistColor = p => (p?.kind === 'liked' ? '#6b4e0a' : p?.kind === 'library' ? '#34424b' : ctx.lib.albums.get(ctx.track(p?.trackIds[0])?.albumId)?.color || '#3a4148');
ctx.artistTracks = id => ctx.lib.artists.get(id)?.albumIds.map(a => ctx.lib.albums.get(a)).sort((a, b) => b.year - a.year).flatMap(a => a.trackIds) ?? [];

// ---------------------------------------------------------------- playing things
function contextOf(kind, id, ids) {
  const t = ctx.t;
  if (kind === 'album') { const a = ctx.lib.albums.get(id); return { kind, id, label: a?.title ?? '', trackIds: a?.trackIds ?? [] }; }
  if (kind === 'playlist') { const p = ctx.playlist(id); return { kind, id, label: p?.name ?? '', trackIds: ids ?? p?.trackIds ?? [] }; }
  if (kind === 'artist') { const a = ctx.lib.artists.get(id); return { kind, id, label: a?.name ?? '', trackIds: ids ?? ctx.artistTracks(id) }; }
  if (kind === 'genre') return { kind, id, label: id, trackIds: ids ?? ctx.lib.trackList.filter(x => x.genre === id).map(x => x.id) };
  return { kind, id, label: kind === 'search' ? `${t.search} “${id}”` : t.library, trackIds: ids ?? ctx.lib.trackList.map(x => x.id) };
}
ctx.isContext = (kind, id) => ctx.player.context?.kind === kind && ctx.player.context?.id === id;
ctx.isContextPlaying = (kind, id) => ctx.isContext(kind, id) && ctx.isActive();
ctx.playContext = (kind, id, { trackId, shuffle, ids } = {}) => ctx.run(adapter.play({ context: contextOf(kind, id, ids), trackId, shuffle }));
ctx.togglePlayContext = (kind, id, o = {}) => {
  if (ctx.isContext(kind, id) && !o.trackId) return ctx.run(ctx.isActive() ? adapter.pause() : adapter.resume());
  return ctx.playContext(kind, id, o);
};
ctx.togglePlay = () => {
  if (!ctx.player.trackId) { const liked = ctx.playlist('liked'); return ctx.playContext('playlist', liked?.trackIds.length ? 'liked' : 'library'); }
  return ctx.run(ctx.isActive() ? adapter.pause() : adapter.resume());
};
ctx.setLiked = (id, liked) => ctx.run(adapter.setLiked(id, liked));
/** A radio from a song: the song, then similar ones from the server. */
ctx.startRadio = trackId => ctx.run(adapter.similar(trackId).then(ids => {
  if (ids.length < 2) { UI.toast({ message: ctx.t.radioEmpty }, ctx.S); return; }
  return adapter.play({ context: { kind: 'radio', id: trackId, label: ctx.t.radioOf(ctx.track(trackId)?.title ?? ''), trackIds: ids }, trackId });
}));
/** Runs an adapter request; a failure becomes a toast (with Retry when it is worth trying again). */
ctx.run = (promise, { retry } = {}) => Promise.resolve(promise).catch(err => {
  if (err?.name === 'AbortError') return;
  UI.toast({ kind: 'fail', message: err?.message || String(err), retry }, ctx.S);
});

// ---------------------------------------------------------------- the track menu (rows, the bar, Now playing)
ctx.trackMenu = (ids, { playlistId } = {}) => {
  const t = ctx.t, one = ids.length === 1 ? ctx.track(ids[0]) : null;
  const own = ctx.playlists.filter(p => p.kind === 'user');
  const items = [
    { id: 'queue', label: t.addQueue, icon: 'queue' }, { id: 'next', label: t.playNext, icon: 'skip-next' },
    { id: 'pl', label: t.addToPlaylist, icon: 'plus', items: [{ id: 'pl:@new', label: t.newPlaylist, icon: 'plus' }, ...(own.length ? [{ separator: true }] : []), ...own.map(p => ({ id: `pl:${p.id}`, label: p.name }))] },
  ];
  if (playlistId && ctx.playlist(playlistId)?.kind === 'user') items.push({ id: 'remove', label: t.remove, icon: 'trash' });
  if (one) {
    items.push({ id: 'radio', label: t.startRadio, icon: 'sparkle' },
      { id: 'like', label: one.liked ? t.unlike : t.like, icon: one.liked ? 'heart-filled' : 'heart' }, { separator: true },
      { id: 'artist', label: t.goArtist, icon: 'artist' }, { id: 'album', label: t.goAlbum, icon: 'album' }, { separator: true },
      { id: 'props', label: t.properties, icon: 'info' });
  }
  return items;
};
ctx.onTrackMenu = async (item, ids, { playlistId } = {}) => {
  const t = ctx.t, id = item.id, one = ctx.track(ids[0]);
  if (id === 'remove') { // Undo puts the order from before the removal back
    const before = [...(ctx.playlist(playlistId)?.trackIds || [])];
    await ctx.run(adapter.playlistRemove(playlistId, ids));
    UI.toast({ message: t.removed(ids.length), undo: () => ctx.run(adapter.playlistReorder(playlistId, before)) }, ctx.S);
    return;
  }
  if (id === 'queue' || id === 'next') { await ctx.run(adapter.queueAdd(ids, { next: id === 'next' })); UI.toast({ kind: 'ok', message: t.addedQueue(ids.length) }, ctx.S); }
  else if (id === 'pl:@new') { const p = await adapter.playlistCreate(t.newPlaylistName(ctx.playlists.filter(x => x.kind === 'user').length + 1), ids).catch(e => ctx.run(Promise.reject(e))); if (p) { UI.toast({ kind: 'ok', message: t.created(p.name), action: { label: t.playlists, onClick: () => ctx.go(`/playlist/${p.id}`) } }, ctx.S); } }
  else if (id.startsWith('pl:')) { const p = ctx.playlist(id.slice(3)); await ctx.run(adapter.playlistAdd(p.id, ids)); UI.toast({ kind: 'ok', message: t.addedPlaylist(ids.length, p.name) }, ctx.S); }
  else if (id === 'like') ctx.setLiked(one.id, !one.liked);
  else if (id === 'artist') ctx.go(`/artist/${one.artistId}`);
  else if (id === 'album') ctx.go(`/album/${one.albumId}`);
  else if (id === 'props') showProperties(ctx, one.id);
  else if (id === 'radio') ctx.startRadio(one.id);
};

// ---------------------------------------------------------------- adapter events → the context → the parts
adapter.subscribe(e => {
  if (e.type === 'player') { const prev = ctx.player; ctx.player = e.player; ctx.emit('player', { player: e.player, prev }); }
  else if (e.type === 'position') { ctx.player = { ...ctx.player, position: e.position }; ctx.emit('position', e.position); }
  else if (e.type === 'queue') { ctx.queue = e.queue; ctx.emit('queue', e.queue); }
  else if (e.type === 'playlists') { ctx.playlists = e.playlists; ctx.emit('playlists', e.playlists); }
  else if (e.type === 'track') { ctx.lib.tracks.set(e.track.id, e.track); ctx.lib.trackList = ctx.lib.trackList.map(t => (t.id === e.track.id ? e.track : t)); ctx.emit('track', e.track); }
  else if (e.type === 'outputs') { ctx.outputs = e.outputs; ctx.emit('outputs', e.outputs); }
  else if (e.type === 'library') { loadLibrary(e.library); ctx.emit('library', e.library); if (e.changed && ctx.ready) ctx.refreshView(); } // a real library changes under us
  else if (e.type === 'connection') {
    ctx.connection = e.status; ctx.emit('connection', e.status);
    if (!ctx.S || !ctx.ready) return; // still starting: the start screen reports it
    if (e.status === 'offline' && !ctx.lost) { ctx.lost = true; UI.toast({ kind: 'warn', message: ctx.t.offlineMsg, action: { label: ctx.t.reconnect, onClick: () => adapter.goOnline?.() } }, ctx.S); }
    if (e.status === 'online' && ctx.lost) { ctx.lost = false; UI.toast({ kind: 'ok', message: ctx.t.backOnline }, ctx.S); }
  }
});

function loadLibrary(lib) {
  ctx.lib.trackList = lib.tracks; ctx.lib.albumList = lib.albums; ctx.lib.artistList = lib.artists;
  ctx.lib.tracks = new Map(lib.tracks.map(x => [x.id, x])); ctx.lib.albums = new Map(lib.albums.map(x => [x.id, x])); ctx.lib.artists = new Map(lib.artists.map(x => [x.id, x]));
}

// ---------------------------------------------------------------- routing (hash routes; the browser keeps the history)
let histIdx = 0, histMax = 0, view = null;
const scrolls = new Map();
function onRoute() {
  const r = parseRoute(location.hash), was = ctx.route?.name;
  scrolls.set(histIdx, ctx.ws.main.scrollTop);
  const st = history.state;
  if (st?.cm == null) { histIdx = histMax = histIdx + 1; history.replaceState({ cm: histIdx }, ''); } else histIdx = st.cm;
  ctx.route = r;
  // floating sidebars (narrow windows) step aside once something is opened from them
  if (ctx.ws.mode === 'narrow') { if (ctx.ws.layout.start.open) ctx.ws.close('start'); if (ctx.ws.layout.end.open) ctx.ws.close('end'); }
  mountView(r, scrolls.get(histIdx) ?? 0, { enter: true, quiet: was === 'search' && r.name === 'search' }); // typing a search: a quiet fade
  ctx.emit('route', { route: r, canBack: histIdx > 1, canForward: histIdx < histMax });
}
function mountView(r, scrollTop = 0, { enter = false, quiet = false } = {}) {
  try { view?.destroy?.(); } catch (e) { console.error(e); }
  const holder = h('div', { class: 'cm-view', 'data-view': r.name });
  ctx.ws.main.replaceChildren(holder);
  view = (VIEWS[r.name] || VIEWS.home)(holder, r, ctx) || null;
  restoreScroll(scrollTop);
  // opened afresh (not back / forward to a kept position): an album or playlist with the playing song shows that song
  if (enter && !scrollTop) view?.revealCurrent?.();
  if (enter) ctx.motion?.enterView(holder, { quiet }); // opened, not re-rendered in place
  document.title = `${view?.title ? `${view.title} · ` : ''}${ctx.t.app}`;
}
// A new view may still be laying out (lists measuring rows, artwork arriving): a scroll position set at once can be
// clamped to the top, so it is set again over the next frames until it holds or the user scrolls.
let scrollWanted = null;
function restoreScroll(top) {
  const main = ctx.ws.main, want = scrollWanted = { top };
  main.scrollTop = top;
  if (!top) return;
  let frames = 0;
  const again = () => {
    if (scrollWanted !== want || ++frames > 30) return;
    if (Math.abs(main.scrollTop - top) > 1) main.scrollTop = top;
    if (Math.abs(main.scrollTop - top) > 1) requestAnimationFrame(again);
  };
  requestAnimationFrame(again);
}
ctx.back = () => history.back();
ctx.forward = () => history.forward();
ctx.refreshView = () => mountView(ctx.route, ctx.ws.main.scrollTop);

// If the page reloads (the desktop app can), come back to the same place: the route is in the URL already,
// the scroll position is kept per tab. Reloads are counted for the settings page (a diagnostic without DevTools).
const SCROLL_KEY = 'sonus.scroll', RELOADS_KEY = 'sonus.reloads';
const store = { get(k) { try { return JSON.parse(sessionStorage.getItem(k)); } catch { return null; } }, set(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } } };
const reloaded = performance.getEntriesByType?.('navigation')?.[0]?.type === 'reload';
if (reloaded) { const n = store.get(RELOADS_KEY) || []; n.push(Date.now()); store.set(RELOADS_KEY, n.slice(-20)); }
ctx.reloads = () => store.get(RELOADS_KEY) || [];
function trackScroll() {
  let pending = 0;
  // the user takes over: stop restoring (scroll events alone can't tell, restoring itself fires them)
  for (const type of ['wheel', 'pointerdown', 'touchstart', 'keydown']) ctx.ws.main.addEventListener(type, () => { scrollWanted = null; }, { passive: true });
  ctx.ws.main.addEventListener('scroll', () => {
    if (pending) return;
    pending = setTimeout(() => { pending = 0; store.set(SCROLL_KEY, { hash: location.hash, top: ctx.ws.main.scrollTop }); }, 150);
  }, { passive: true });
}

// ---------------------------------------------------------------- continue where another device (or the last session) stopped
// At start: the saved queue is taken over paused, at its position, and a toast offers to play. Later (the window comes
// back to the front, nothing playing): a queue saved since by another device is offered.
let offeredAt = 0;
async function offerContinue({ atStart = false } = {}) {
  if (!adapter.remoteQueue || (!atStart && (ctx.isActive() || Date.now() - offeredAt < 15000))) return;
  offeredAt = Date.now();
  const q = await adapter.remoteQueue().catch(() => null);
  if (!q || (!atStart && (q.mine || q.changed <= adapter.queueSavedAt() || ctx.isActive()))) return;
  if (atStart && ctx.player.trackId) return;
  const title = ctx.track(q.current)?.title; if (!title) return;
  const from = q.mine ? '' : q.changedBy.replace(/^(?:Sonus|CreeperUX Music) \((.*)\)$/, '$1'); // CreeperUX Music: the name before 0.4
  adapter.continueQueue(q, ctx.t.resumeFrom(title, from));
  UI.toast({ message: ctx.t.resumeFrom(title, from), duration: 12000, action: { label: ctx.t.resume, onClick: () => ctx.run(adapter.resume()) } }, ctx.S);
}

// ---------------------------------------------------------------- start
async function start() {
  applyLook();
  registerAppIcons();
  ctx.S = UI.createServices({ root, locale: prefs.locale });
  const t = ctx.t;

  const ws = ctx.ws = UI.createWorkspace(root, {
    start: { label: t.library, width: prefs.startWidth, min: 72, max: 480, open: prefs.startOpen },
    end: { label: t.nowPlaying, width: prefs.endWidth, min: 280, max: 480, open: prefs.endOpen },
    mainLabel: t.mainLabel, bottomLabel: t.player, mainMin: 420,
    onLayoutChange: e => {
      prefs.startWidth = e.start.width; prefs.endWidth = e.end.width;
      if (e.reason === 'toggle' || e.reason === 'escape' || e.reason === 'outside') { if (e.region === 'start') prefs.startOpen = e.start.open; if (e.region === 'end') prefs.endOpen = e.end.open; }
      savePrefs(); ctx.emit('layout', e);
    },
  }, ctx.S);
  root.classList.add('cm');

  // a loading state while the server answers
  ws.main.append(h('div', { class: 'cm-loading', role: 'status' }, h('span', { class: 'cm-spinner', 'aria-hidden': 'true' }), t.loading));
  try {
    ctx.server = await adapter.connect();
    const lib = await adapter.library();
    loadLibrary(lib);
    ctx.playlists = await adapter.playlists(); ctx.player = adapter.player(); ctx.queue = adapter.queue(); ctx.outputs = adapter.outputs(); ctx.connection = 'online';
  } catch (err) {
    ws.main.replaceChildren();
    // the server refused the saved sign-in (the password changed): sign in again
    if (err?.code === 40 || err?.code === 41) { signOut(); root.replaceChildren(); root.classList.remove('cm'); showLogin(err.message); return; }
    UI.createEmptyState(ws.main, { title: t.offline, message: err?.message || t.offlineMsg, action: { label: t.retry, onClick: () => location.reload() } }, ctx.S);
    return;
  }

  mountTopbar(ws.top, ctx);
  mountLibrary(ws.start, ctx);
  mountPanel(ws.end, ctx);
  mountBar(ws.bottom, ctx);
  ctx.motion = createAppMotion(ctx, root);

  // keys: Space plays or pauses, Ctrl + ← → change track, Ctrl + ↑ ↓ the volume, Ctrl + K searches, Alt + ← → navigate
  const keys = ctx.keys = P.createShortcuts(ctx.S);
  const g = t.player;
  keys.register({ id: 'play', keys: 'space', label: `${t.play} / ${t.pause}`, group: g, handler: e => { e.preventDefault(); ctx.togglePlay(); } });
  keys.register({ id: 'next', keys: 'mod+arrowright', label: '→', group: g, handler: () => ctx.run(adapter.next()) });
  keys.register({ id: 'prev', keys: 'mod+arrowleft', label: '←', group: g, handler: () => ctx.run(adapter.previous()) });
  keys.register({ id: 'vol+', keys: 'mod+arrowup', label: '+', group: g, handler: () => ctx.run(adapter.setVolume(Math.min(1, ctx.player.volume + 0.05))) });
  keys.register({ id: 'vol-', keys: 'mod+arrowdown', label: '−', group: g, handler: () => ctx.run(adapter.setVolume(Math.max(0, ctx.player.volume - 0.05))) });
  keys.register({ id: 'search', keys: ['mod+k', '/'], label: t.search, group: t.app, handler: e => { e.preventDefault(); ctx.emit('focus-search'); } });
  keys.register({ id: 'back', keys: 'alt+arrowleft', label: t.back, group: t.app, handler: () => ctx.back() });
  keys.register({ id: 'fwd', keys: 'alt+arrowright', label: t.forward, group: t.app, handler: () => ctx.forward() });
  keys.register({ id: 'like', keys: 'alt+shift+b', label: t.like, group: g, handler: () => { const c = ctx.currentTrack(); if (c) ctx.setLiked(c.id, !c.liked); } });

  history.replaceState({ cm: 1 }, ''); histIdx = histMax = 1;
  window.addEventListener('hashchange', onRoute);
  ctx.route = parseRoute(location.hash);
  const kept = store.get(SCROLL_KEY);
  mountView(ctx.route, reloaded && kept?.hash === location.hash ? kept.top : 0, { enter: true });
  trackScroll();
  ctx.emit('route', { route: ctx.route, canBack: false, canForward: false });
  ctx.ready = true;
  offerContinue({ atStart: true });
  window.addEventListener('focus', () => offerContinue());
  window.__app = ctx; window.__ready = true;
}
start();
