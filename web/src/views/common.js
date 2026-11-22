// Parts the views share: the coloured header, the action row, the sticky title bar, track lists, shelves of cards,
// filter chips, file information and the Properties dialog.
import { h, ic, playButton, audioSummary, isHiRes, isLossless, fitCount, shade, sampleColor } from '../dom.js';
import { orderToBar } from '../api/contract.js';

/** Collects what a view must undo: kit handles, listeners, observers. */
export function scope() {
  const items = [];
  return {
    add(x) { if (x) items.push(x); return x; },
    destroy() { for (const x of items.splice(0).reverse()) { try { typeof x === 'function' ? x() : x.destroy?.(); } catch (e) { console.error(e); } } },
  };
}

/** A 2 × 2 cover of four albums for a playlist, drawn once and cached. Falls back to the first cover. */
const mosaics = new Map();
export function mosaic(sources, key) {
  if (mosaics.has(key)) return mosaics.get(key);
  const resolver = async signal => {
    const urls = (await Promise.all(sources.map(s => (typeof s === 'function' ? s(signal) : s)))).filter(Boolean);
    if (urls.length < 4) return urls[0] ?? null; // an album without artwork: no mosaic
    try {
      const imgs = await Promise.all(urls.map(u => new Promise((res, rej) => { const im = new Image(); im.crossOrigin = 'anonymous'; im.onload = () => res(im); im.onerror = rej; im.src = u; })));
      const c = document.createElement('canvas'); c.width = c.height = 300;
      const g = c.getContext('2d');
      imgs.forEach((im, i) => g.drawImage(im, (i % 2) * 150, Math.floor(i / 2) * 150, 150, 150));
      const url = c.toDataURL('image/png');
      mosaics.set(key, url);
      return url;
    } catch { return urls[0] ?? null; } // a cover from another origin taints the canvas: show the first one
  };
  mosaics.set(key, resolver);
  return resolver;
}

export function tint(holder, color) { holder.style.setProperty('--cm-tint', color || '#3a4148'); holder.style.setProperty('--cm-tint-deep', shade(color || '#3a4148', -0.55)); }

// ---------------------------------------------------------------- header
export function hero(holder, ctx, bag, { kind, title, art, meta = [], description, placeholder, round = false, banner = false, onColor }) {
  const artBox = h('div', { class: 'cm-hero-art' });
  const titleEl = h('h1', { class: 'cm-hero-title', 'data-len': title.length > 26 ? 'long' : title.length > 14 ? 'mid' : 'short' }, title);
  const el = h('header', { class: 'cm-hero', 'data-round': round || null, 'data-banner': banner || null },
    banner ? null : artBox,
    h('div', { class: 'cm-hero-text' },
      kind ? h('span', { class: 'cm-hero-kind' }, kind) : null,
      titleEl,
      description ? h('p', { class: 'cm-hero-desc' }, description) : null,
      meta.filter(Boolean).length ? h('p', { class: 'cm-hero-meta' }, meta.filter(Boolean).map((m, i) => [i ? h('span', { class: 'cm-dot', 'aria-hidden': 'true' }, '•') : null, m])) : null));
  if (!banner) {
    // onColor: the artwork's colour once it has loaded, for a header whose colour was not known (real covers)
    const im = bag.add(ctx.P.createImage(artBox, { src: art ?? null, alt: '', lazy: false, placeholder: placeholder || 'album', shape: round ? 'circle' : 'rounded',
      onLoad: onColor ? () => { const c = sampleColor(artBox.querySelector('img')); if (c) { tint(holder, c); onColor(c); } } : undefined }, ctx.S));
    if (placeholder && !art) im.root.dataset.special = placeholder;
  }
  holder.append(el);
  return { root: el, titleEl };
}

// ---------------------------------------------------------------- the action row: Play, Shuffle, extras, More
export function actionRow(ctx, bag, { kind, id, label, ids, shuffle = true, extra = [], menu, onMenu }) {
  const t = ctx.t;
  const playing = () => ctx.isContextPlaying(kind, id);
  const play = playButton({ label: t.playX(label), playing: playing(), onClick: () => ctx.togglePlayContext(kind, id, { ids: ids?.() }) });
  const row = h('div', { class: 'cm-actions' }, play);
  let shuf = null;
  if (shuffle) {
    shuf = bag.add(ctx.UI.createToggleButton(row, { label: t.shuffleX(label), icon: 'shuffle', iconOnly: true, variant: 'ghost', pressed: orderToBar(ctx.player.order).shuffle,
      onPressedChange: e => ctx.run(ctx.adapter.setOrder(e.pressed ? 'shuffle-tracks' : 'default')) }, ctx.S));
    shuf.element.classList.add('cm-action-icon');
  }
  for (const x of extra) row.append(x);
  if (menu) {
    const mb = bag.add(ctx.UI.createMenuButton(row, { label: t.moreX(label), icon: 'more', iconOnly: true, variant: 'ghost', items: menu, onSelect: e => onMenu?.(e.item) }, ctx.S));
    mb.element.classList.add('cm-action-icon');
  }
  const sync = () => { play.set({ playing: playing(), label: playing() ? t.pauseX(label) : t.playX(label) }); shuf?.update({ pressed: orderToBar(ctx.player.order).shuffle }); };
  bag.add(ctx.on('player', sync));
  return { root: row, play, sync };
}

/** The bar that slides in at the top of the main region once the header's title has scrolled away. */
export function stickyBar(holder, ctx, bag, titleEl, { title, kind, id, ids }) {
  const t = ctx.t;
  const play = playButton({ label: t.playX(title), size: 'sm', playing: ctx.isContextPlaying(kind, id), onClick: () => ctx.togglePlayContext(kind, id, { ids: ids?.() }) });
  const bar = h('div', { class: 'cm-sticky', 'aria-hidden': 'true', inert: '' }, play, h('span', { class: 'cm-sticky-title' }, title));
  holder.prepend(bar);
  const io = new IntersectionObserver(([e]) => {
    const shown = !e.isIntersecting && e.boundingClientRect.top < (e.rootBounds?.top ?? 0) + 80;
    bar.toggleAttribute('data-shown', shown);
    // hidden: out of the tab order and the accessibility tree; shown: a real control
    if (shown) { bar.removeAttribute('aria-hidden'); bar.inert = false; } else { bar.setAttribute('aria-hidden', 'true'); bar.inert = true; }
  }, { root: ctx.ws.main, rootMargin: '-64px 0px 0px 0px' });
  io.observe(titleEl);
  bag.add(() => io.disconnect());
  bag.add(ctx.on('player', () => play.set({ playing: ctx.isContextPlaying(kind, id), label: ctx.isContextPlaying(kind, id) ? t.pauseX(title) : t.playX(title) })));
  return bar;
}

// ---------------------------------------------------------------- track lists
/**
 * A kit track list bound to the app: plays within the given context, marks the loaded track wherever it appears,
 * follows likes, and opens the shared track menu (for every selected row when the menu's row is selected).
 */
export function trackList(container, ctx, bag, o) {
  let ids = o.ids;
  const tracks = () => ids.map(id => ctx.kitTrack(ctx.track(id), { numbered: !!o.numbered })).filter(Boolean);
  const targets = id => { const sel = list.selected; return sel.length > 1 && sel.includes(id) ? sel : [id]; };
  const list = bag.add(ctx.M.createTrackList(container, {
    tracks: tracks(), label: o.label, columns: o.columns || ['index', 'title', 'album', 'like', 'duration'], virtual: o.virtual ?? false, height: o.height,
    selectable: o.selectable ?? false, // rows are selected only while a playlist is being edited (playlist.js)
    current: ctx.player.trackId, playing: ctx.isActive(), groupBy: o.groupBy, groupLabel: o.groupLabel, reorderable: !!o.onReorder, sortable: o.sortable ?? true,
    onPlay: e => ctx.playContext(o.kind, o.id, { trackId: e.id, ids: o.contextIds ? o.contextIds() : ids }),
    onPause: () => ctx.run(ctx.adapter.pause()),
    onLike: e => ctx.setLiked(e.id, e.liked),
    menu: t => ctx.trackMenu(targets(t.id), { playlistId: o.playlistId }),
    onMenu: e => ctx.onTrackMenu(e.item, targets(e.track.id), { playlistId: o.playlistId }),
    onReorder: o.onReorder, onSortChange: o.onSortChange, empty: o.empty, stacked: 'auto', animateRows: !!o.onReorder,
  }, ctx.S));
  // The kit table re-renders all its rows on every update; with a row focused (after a double-click) Chromium then
  // resets the main area's scroll position to the top. Keep it where it was (restored before the next paint).
  const update = n => { const main = ctx.ws.main, top = main.scrollTop; list.update(n); if (Math.abs(main.scrollTop - top) > 1) main.scrollTop = top; };
  bag.add(ctx.on('player', ({ player, prev }) => { if (player.trackId !== prev?.trackId || player.state !== prev?.state) update({ current: player.trackId, playing: ctx.isActive() }); }));
  bag.add(ctx.on('track', tr => { if (ids.includes(tr.id)) update({ tracks: tracks() }); }));
  // Opening a list that holds the song that is playing: bring its row to the middle of the main area. Rows of a long
  // list are laid out with estimated heights until they come near the screen, so it is corrected over two more frames.
  function revealCurrent() {
    const id = ctx.player.trackId;
    if (!id || !ids.includes(id)) return false;
    const main = ctx.ws.main;
    const centre = () => {
      const row = list.root.querySelector('.ui-tr[aria-current]');
      if (!row) return false;
      const m = main.getBoundingClientRect(), r = row.getBoundingClientRect();
      main.scrollTop += r.top + r.height / 2 - (m.top + m.height / 2);
      return true;
    };
    if (!centre()) return false;
    requestAnimationFrame(() => { centre(); requestAnimationFrame(centre); });
    return true;
  }
  return { list, revealCurrent, update, setIds(next) { ids = next; update({ tracks: tracks() }); }, get ids() { return ids; } };
}

// ---------------------------------------------------------------- cards and shelves
export function cardProps(ctx, ref, layout = 'tile') {
  const t = ctx.t;
  if (ref.type === 'album') {
    const a = ctx.lib.albums.get(ref.id); if (!a) return null;
    const kind = { album: t.kindAlbum, ep: t.kindEp, single: t.kindSingle, compilation: t.kindCompilation }[a.type];
    return { title: a.title, subtitle: layout === 'row' ? `${kind} · ${a.artist}` : (a.year ? `${a.year} · ${a.artist}` : a.artist), artwork: { src: ctx.art(a.id), alt: '' }, playing: ctx.isContextPlaying('album', a.id),
      onOpen: () => ctx.go(`/album/${a.id}`), onPlay: () => ctx.togglePlayContext('album', a.id), playLabel: t.playX(a.title),
      menu: () => [{ id: 'queue', label: t.addQueue, icon: 'queue' }, { id: 'next', label: t.playNext, icon: 'skip-next' }, { separator: true }, { id: 'artist', label: t.goArtist, icon: 'artist' }],
      onMenu: e => (e.item.id === 'artist' ? ctx.go(`/artist/${a.artistId}`) : ctx.onTrackMenu(e.item, a.trackIds)) };
  }
  if (ref.type === 'artist') {
    const a = ctx.lib.artists.get(ref.id); if (!a) return null;
    const cover = ctx.lib.albums.get(a.albumIds[0]);
    return { title: a.name, subtitle: t.kindArtist, artwork: { src: ctx.art(cover?.id), shape: 'circle', alt: '', placeholder: 'artist' }, playing: ctx.isContextPlaying('artist', a.id),
      onOpen: () => ctx.go(`/artist/${a.id}`), onPlay: () => ctx.togglePlayContext('artist', a.id), playLabel: t.playX(a.name) };
  }
  if (ref.type === 'playlist') {
    const p = ctx.playlist(ref.id); if (!p) return null;
    const kind = p.kind === 'auto' ? t.kindAuto : p.kind === 'library' ? t.kindLibrary : t.kindPlaylist;
    return { title: p.name, subtitle: `${kind} · ${t.nSongs(p.trackIds.length)}`, artwork: { src: ctx.playlistArt(p), alt: '', placeholder: p.kind === 'liked' ? 'heart-filled' : p.kind === 'library' ? 'library' : 'playlist' },
      playing: ctx.isContextPlaying('playlist', p.id), onOpen: () => ctx.go(`/playlist/${p.id}`), onPlay: () => ctx.togglePlayContext('playlist', p.id), playLabel: t.playX(p.name),
      menu: () => [{ id: 'queue', label: t.addQueue, icon: 'queue' }, { id: 'next', label: t.playNext, icon: 'skip-next' }], onMenu: e => ctx.onTrackMenu(e.item, p.trackIds), _special: p.kind };
  }
  return null;
}
export function mediaCard(container, ctx, ref, layout = 'tile') {
  const props = cardProps(ctx, ref, layout); if (!props) return null;
  const { _special, ...rest } = props;
  const card = ctx.P.createMediaCard(container, { ...rest, layout }, ctx.S);
  if (_special === 'liked' || _special === 'library') card.root.dataset.special = _special;
  card.ref = ref;
  return card;
}

/** One row of cards, as many as fit; "Show all" opens the whole collection. */
export function shelf(container, ctx, bag, { title, refs, more, min = 168 }) {
  if (!refs.length) return null;
  const row = h('div', { class: 'cm-shelf-row', role: 'list' });
  const headId = `shelf-${Math.random().toString(36).slice(2, 8)}`;
  const el = h('section', { class: 'cm-shelf', 'aria-labelledby': headId },
    h('div', { class: 'cm-shelf-head' }, h('h2', { id: headId }, more ? h('a', { href: `#${more}` }, title) : title), more ? h('a', { class: 'cm-showall', href: `#${more}` }, ctx.t.showAll) : null), row);
  container.append(el);
  let cards = [];
  const render = n => {
    for (const c of cards) c.destroy();
    row.style.setProperty('--cm-cols', n); row.replaceChildren();
    cards = refs.slice(0, n).map(ref => { const cell = h('div', { role: 'listitem' }); row.append(cell); return mediaCard(cell, ctx, ref); }).filter(Boolean);
  };
  bag.add(fitCount(row, min, 20, render));
  bag.add(() => cards.forEach(c => c.destroy()));
  bag.add(ctx.on('player', () => { for (const c of cards) c.update({ playing: ctx.isContextPlaying(c.ref.type, c.ref.id) }); }));
  return el;
}

// ---------------------------------------------------------------- filter chips
export function chips(container, { label, options, value, onChange, clearLabel }) {
  const el = h('div', { class: 'cm-chips', role: 'group', 'aria-label': label });
  // the buttons stay in place (focus stays on the pressed chip); Clear appears in front while a chip is on
  const clear = clearLabel ? h('button', { type: 'button', class: 'cm-chip', 'data-clear': '', 'aria-label': clearLabel, title: clearLabel, onClick: () => { value = null; render(); buttons[0]?.focus(); onChange(null); } }, ic('close')) : null;
  const buttons = options.map(o => h('button', { type: 'button', class: 'cm-chip', onClick: () => { value = value === o.value && clearLabel ? null : o.value; render(); onChange(value); } }, o.label));
  el.append(...[clear, ...buttons].filter(Boolean));
  const render = () => {
    if (clear) clear.hidden = !value;
    options.forEach((o, i) => buttons[i].setAttribute('aria-pressed', String(value === o.value)));
  };
  render(); container.append(el);
  return { root: el, set(v) { value = v; render(); } };
}

// ---------------------------------------------------------------- file information (Properties)
export function fileFacts(ctx, tr) {
  const t = ctx.t, f = ctx.S.format;
  const rate = tr.sampleRate > 1e6 ? `${(tr.sampleRate / 1e6).toFixed(4)} MHz` : `${+(tr.sampleRate / 1000).toFixed(1)} kHz`;
  const rg = v => (v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)} dB`);
  return [
    [t.codec, `${tr.codec}${isLossless(tr) ? ` · ${t.lossless}` : ` · ${t.lossy}`}`], [t.bitrate, `${f.number(tr.bitrate)} kbps`], [t.sampleRate, rate],
    [t.bitDepth, tr.bitDepth ? `${tr.bitDepth} bit` : '—'], [t.channels, tr.channels === 2 ? `2 · ${t.stereo}` : String(tr.channels)], [t.fileSize, f.bytes(tr.size)],
    [t.replayGain, `${t.rgTrack} ${rg(tr.replayGain?.track)} · ${t.rgAlbum} ${rg(tr.replayGain?.album)}`],
    [t.playCount, f.number(tr.playCount)], [t.lastPlayed, tr.lastPlayed ? f.relative(tr.lastPlayed) : t.never],
  ];
}
export function badges(ctx, tr) {
  return h('div', { class: 'cm-badges' },
    h('span', { class: 'cm-badge', 'data-strong': isHiRes(tr) || null }, audioSummary(tr)),
    isHiRes(tr) ? h('span', { class: 'cm-badge', 'data-accent': '' }, ctx.t.hiRes) : isLossless(tr) ? h('span', { class: 'cm-badge' }, ctx.t.lossless) : null);
}
export function factsList(ctx, tr, { path = true } = {}) {
  return h('dl', { class: 'cm-facts' },
    fileFacts(ctx, tr).map(([k, v]) => h('div', {}, h('dt', {}, k), h('dd', {}, v))),
    path ? h('div', { 'data-wide': '' }, h('dt', {}, ctx.t.path), h('dd', { class: 'cm-path', dir: 'ltr' }, tr.path)) : null);
}
export function showProperties(ctx, trackId) {
  const tr = ctx.track(trackId); if (!tr) return;
  const t = ctx.t;
  const tags = [[t.title, tr.title], [t.artist, tr.artist], [t.album, tr.album], ['#', `${tr.disc > 1 ? `${tr.disc}.` : ''}${tr.number}`], ['genre', tr.genre], ['date', String(tr.year)], [t.duration, ctx.S.format.duration(tr.duration)]];
  const dlg = ctx.UI.createDialog({
    title: t.properties, size: 'md',
    content: body => body.append(
      h('div', { class: 'cm-props-head' }, h('strong', {}, tr.title), h('span', {}, `${tr.artist} — ${tr.album}`), badges(ctx, tr)),
      h('dl', { class: 'cm-facts' }, tags.map(([k, v]) => h('div', {}, h('dt', {}, k), h('dd', {}, v)))),
      factsList(ctx, tr)),
    actions: [{ label: t.closePanel, variant: 'primary', value: 'close' }],
    onClose: () => setTimeout(() => dlg.destroy(), 400),
  }, ctx.S);
  dlg.open();
}
