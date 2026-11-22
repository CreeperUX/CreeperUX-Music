import { setup, createTable, createButton, createEmptyState, PRESS_SCALE } from '../ui/index.js';
import { createMediaCard } from '../plus/index.js';
import { mediaStrings } from './strings.js';
import { registerMediaIcons } from './icons.js';
import { pop } from './playback.js';

/** Artwork for a row: a plain lazy image over the placeholder, cheap enough for thousands of rows. */
function thumb(c, src) {
  const s = c.h('span', { class: 'ui-track-art', 'aria-hidden': 'true' }, c.icon('music'));
  const put = url => { if (!url) { s.dataset.state = 'empty'; return; } const im = c.h('img', { alt: '', loading: 'lazy', decoding: 'async', draggable: 'false' }); im.onerror = () => { im.remove(); s.dataset.state = 'error'; }; im.src = url; s.append(im); };
  if (typeof src === 'function') Promise.resolve().then(() => src()).then(put, () => { s.dataset.state = 'error'; }); else put(src);
  return s;
}
const COLUMNS = ['index', 'title', 'album', 'like', 'duration'];

/**
 * createTrackList(container, { tracks: Track[], label, columns = ['index', 'title', 'album', 'like', 'duration'] (also
 *   'artist', 'added'), current, playing, selectable = 'multiple', selected, onSelectionChange({ selected }), sort,
 *   sortMode = 'client', onSortChange, sortable = true, virtual: 'auto' | false | { height }, height = '32rem',
 *   groupBy, groupLabel, reorderable, onReorder, menu(track) → MenuItem[], onMenu({ item, track }), onPlay({ track, id, via }),
 *   onPause({ track, id }), onLike({ track, id, liked }), loading, error, onRetry, empty }, services)
 * Track: { id, title, artist, album, duration (s), number, artwork (URL or resolver), added (Date | ms), liked,
 *   explicit, unavailable, reason, disabled }
 * → { root, table, get selected, focusTrack(id), scrollToTrack(id), update, destroy }
 * A list of tracks (2.5.0, G68) on the data table, so it has the table's row keyboard model, selection and states
 * (G58). Double-click or Enter plays a track (onPlay, `via` 'double-click' | 'keyboard'); the play button that replaces
 * the number on hover, and on the focused row, plays it too ('button'), or pauses the current track. A click selects
 * (Ctrl / ⌘ toggles, Shift selects a range); controls in a row (play, like, the menu) never count as the row.
 * `current` is the track that is loaded: it is marked with an equaliser in place of its number (moving while
 * `playing`, still when paused, still with reduced motion), aria-current and "Playing" or "Paused" in its name.
 * Unavailable tracks stay listed and selectable and say why instead of playing. Over 150 tracks the list renders only
 * the rows in view (`virtual: 'auto'`); give it a `height` (or '100%' of a container with a height).
 * The host owns the tracks: changing `current`, `playing` or `liked` re-marks rows without rebuilding the list, and new
 * track arrays keep focus, selection and the first visible row.
 */
export function createTrackList(container, props = {}, services) {
  const c = setup(container, services, 'track-list'); mediaStrings(c.s); registerMediaIcons();
  let p = { tracks: [], columns: COLUMNS, selectable: 'multiple', sortable: true, virtual: 'auto', height: '32rem', ...props };
  const el = c.own(c.h('div', { class: 'ui-tracklist' }));
  const clock = v => c.s.format.duration(v);
  const positions = () => new Map(p.tracks.map((t, i) => [t.id, i]));
  let pos = positions();
  const likedShown = new Map(); // id → the liked state its heart last showed: a change pops (D81), a row scrolled back into view does not
  function indexCell(t) {
    const play = c.h('button', { type: 'button', class: 'ui-track-play', tabindex: '-1', 'aria-label': c.s.t('tracks.play', { title: t.title ?? '' }) }, c.icon('play'), c.icon('pause'));
    play._track = t;
    return c.h('span', { class: 'ui-track-index' }, c.h('span', { class: 'ui-track-num' }, c.s.format.number(t.number ?? (pos.get(t.id) ?? 0) + 1)), c.h('span', { class: 'ui-track-eq', 'aria-hidden': 'true' }, c.h('i'), c.h('i'), c.h('i')), c.h('span', { class: 'ui-track-off', 'aria-hidden': 'true' }, c.icon('block')), play);
  }
  function titleCell(t) {
    const second = !p.columns.includes('artist') && t.artist;
    return c.h('span', { class: 'ui-track-title' }, thumb(c, t.artwork),
      c.h('span', { class: 'ui-track-text' }, c.h('span', { class: 'ui-track-name' }, t.title ?? ''),
        second || t.explicit ? c.h('span', { class: 'ui-track-sub' }, c.h('span', { class: 'ui-visually-hidden' }, ', '), t.explicit ? c.h('span', { class: 'ui-track-explicit', title: c.s.t('tracks.explicit') }, c.h('span', { 'aria-hidden': 'true' }, 'E'), c.h('span', { class: 'ui-visually-hidden' }, c.s.t('tracks.explicit'), ' ')) : null, second ? t.artist : null) : null));
  }
  function likeCell(t) {
    const b = c.h('button', { type: 'button', class: 'ui-button ui-media-button ui-media-toggle ui-track-like', 'data-variant': 'ghost', 'data-icon-only': '', 'aria-pressed': String(!!t.liked), 'aria-label': c.s.t('tracks.like', { title: t.title ?? '' }) }, c.icon(t.liked ? 'heart-filled' : 'heart'));
    b._track = t;
    const was = likedShown.get(t.id); likedShown.set(t.id, !!t.liked);
    if (was !== undefined && was !== !!t.liked) c.win.requestAnimationFrame(() => { if (b.isConnected) pop(c, b); });
    return b;
  }
  function columns() {
    const s = !!p.sortable, all = {
      index: { id: 'index', label: c.s.t('tracks.number'), width: '3.25rem', align: 'end', cell: indexCell, text: () => '' },
      title: { id: 'title', label: c.s.t('tracks.title'), role: 'primary', sortable: s, cell: titleCell, text: t => t.title ?? '', sortValue: t => t.title },
      artist: { id: 'artist', label: c.s.t('tracks.artist'), sortable: s, priority: 'low' },
      album: { id: 'album', label: c.s.t('tracks.album'), sortable: s, priority: 'low' },
      added: { id: 'added', label: c.s.t('tracks.added'), sortable: s, priority: 'low', cell: t => (t.added == null ? '' : c.s.format.date(t.added)), sortValue: t => (t.added == null ? null : +new Date(t.added)) },
      like: { id: 'like', label: c.s.t('player.like'), hideLabel: true, width: '3rem', cell: t => (t.liked == null ? '' : likeCell(t)), text: () => '' },
      duration: { id: 'duration', label: c.s.t('tracks.duration'), align: 'end', width: '5rem', sortable: s, cell: t => (t.duration == null ? '' : clock(t.duration)), sortValue: t => t.duration },
    };
    return p.columns.map(k => all[k]).filter(Boolean);
  }
  const rowState = () => { const cur = p.current, label = c.s.t(p.playing ? 'tracks.playing' : 'tracks.paused'), why = c.s.t('tracks.unavailable'); return t => ({ current: t.id === cur, currentLabel: label, unavailable: !!t.unavailable, reason: t.reason || why, disabled: !!t.disabled }); };
  const virtual = () => (p.virtual === false ? undefined : typeof p.virtual === 'object' ? p.virtual : p.tracks.length > 150 ? { height: p.height } : undefined);
  const tableProps = () => ({
    label: p.label || c.s.t('tracks.label'), columns: columns(), rows: p.tracks, rowKey: 'id', rowLabel: t => [t.title, t.artist].filter(Boolean).join(', '),
    selectable: p.selectable, selectOnClick: !!p.selectable, selected: p.selected, activation: 'double-click', rowState: rowState(),
    sort: p.sort, sortMode: p.sortMode || 'client', virtual: virtual(), groupBy: p.groupBy, groupLabel: p.groupLabel, reorderable: p.reorderable,
    rowMenu: p.menu, loading: p.loading, error: p.error, onRetry: p.onRetry, empty: p.empty || { title: c.s.t('tracks.empty') }, status: p.status, stacked: p.stacked ?? 'auto', animateRows: !!p.animateRows,
  });
  const table = createTable(el, {
    ...tableProps(),
    onSelectionChange: e => { p.selected = e.selected; c.emit(el, 'selection-change', e, p.onSelectionChange); },
    onSortChange: e => { p.sort = e; c.emit(el, 'sort-change', e, p.onSortChange); },
    onRowAction: e => c.emit(el, 'play', { track: e.row, id: e.key, via: e.via }, p.onPlay),
    onRowMenu: e => c.emit(el, 'menu', { item: e.item, track: e.row }, p.onMenu),
    onReorder: e => c.emit(el, 'reorder', { ...e, tracks: e.rows }, p.onReorder),
  }, c.s);
  c.on(table.table, 'click', e => {
    const play = e.target.closest('.ui-track-play'), like = e.target.closest('.ui-track-like');
    if (play) {
      const t = play._track;
      if (t.unavailable || t.disabled) { c.s.announce(t.reason || c.s.t('tracks.unavailable')); return; } // as the row's own action does
      if (t.id === p.current && p.playing) c.emit(el, 'pause', { track: t, id: t.id }, p.onPause); else c.emit(el, 'play', { track: t, id: t.id, via: 'button' }, p.onPlay);
    }
    else if (like) { const t = like._track; c.emit(el, 'like', { track: t, id: t.id, liked: !t.liked }, p.onLike); }
  });
  // press feedback for the row buttons, delegated as the rows come and go (D81)
  let held = null;
  const release = () => { if (held) c.s.motion.animate(held, { sx: 1, sy: 1 }, { role: 'release' }); held = null; };
  c.on(table.table, 'pointerdown', e => {
    const b = e.button ? null : e.target.closest?.('.ui-track-play, .ui-track-like');
    if (!b || b.disabled) return;
    release(); held = b; c.s.motion.animate(b, { sx: PRESS_SCALE, sy: PRESS_SCALE }, { role: 'press' });
  });
  c.on(table.table, 'pointerup', release); c.on(table.table, 'pointercancel', release);
  c.on(table.table, 'pointerout', e => { if (held && !held.contains(e.relatedTarget)) release(); });
  // the current row's play button says what it will do (rows are not rebuilt when playback changes)
  function syncCurrent() {
    el.toggleAttribute('data-playing', !!p.playing);
    el.toggleAttribute('data-fill', p.height === '100%'); // fills a container that has a height: the rows scroll inside it
    for (const b of table.table.querySelectorAll('.ui-track-play')) {
      const t = b._track, now = t.id === p.current && p.playing, label = now ? c.s.t('player.pause') : c.s.t('tracks.play', { title: t.title ?? '' });
      if (b.getAttribute('aria-label') !== label) b.setAttribute('aria-label', label);
    }
  }
  const mo = new c.win.MutationObserver(syncCurrent); mo.observe(table.table, { childList: true, subtree: true });
  c.cleanup(() => { mo.disconnect(); table.destroy(); });
  container.append(el);
  syncCurrent();
  return {
    root: el, table,
    get selected() { return table.selected; },
    focusTrack: id => table.focusRow(id),
    scrollToTrack: id => table.scrollToRow(id),
    update(n) {
      p = { ...p, ...n };
      const t = {};
      if ('tracks' in n) { pos = positions(); for (const id of likedShown.keys()) if (!pos.has(id)) likedShown.delete(id); t.rows = p.tracks; if (p.virtual === 'auto') t.virtual = virtual(); }
      if ('current' in n || 'playing' in n || 'tracks' in n) t.rowState = rowState();
      if ('columns' in n || 'sortable' in n) t.columns = columns();
      for (const k of ['selectable', 'selected', 'sort', 'sortMode', 'groupBy', 'groupLabel', 'reorderable', 'loading', 'error', 'onRetry', 'empty', 'label', 'status', 'animateRows']) if (k in n) t[k] = tableProps()[k];
      if ('menu' in n) t.rowMenu = p.menu;
      if ('virtual' in n || 'height' in n) t.virtual = virtual();
      if (Object.keys(t).length) table.update(t);
      syncCurrent();
    },
    focus: () => table.focus(),
    destroy: () => c.destroy(),
  };
}

/**
 * createQueueList(container, { current: Track | null, tracks: (Track & { section })[], sections: { [id]: label }, playing,
 *   label, onPlay({ track, id }), onReorder({ keys, before, index, order, section }), onRemove({ ids }),
 *   onClear({ section }), clearable = ['queue'], menu(track) → MenuItem[], onMenu({ item, track }), loading, error, onRetry }, services)
 * → { root, list, update, destroy }
 * The play queue (G68): what is playing now, then the upcoming tracks under their section headers ("Next in queue",
 * "Next from: Blue Hour"). Upcoming tracks reorder by their handle (pointer, or Space and the arrow keys; Alt + ↑ ↓
 * on a row), several at once when selected; the list proposes the order (onReorder, with the section the tracks land
 * in) and shows it only when the host passes the new tracks, so a move the player refuses simply does not happen.
 * Remove a track with its menu or Delete (onRemove); Clear queue empties a section
 * (onClear). When the focused track is removed, focus moves to the one in its place.
 */
export function createQueueList(container, props = {}, services) {
  const c = setup(container, services, 'queue'); mediaStrings(c.s); registerMediaIcons();
  let p = { tracks: [], sections: {}, clearable: ['queue'], ...props };
  const nowHead = c.h('h2', { class: 'ui-queue-heading' });
  const nowSlot = c.h('div', { class: 'ui-queue-now' });
  const nextHead = c.h('div', { class: 'ui-queue-bar' });
  const listSlot = c.h('div', { class: 'ui-queue-list' });
  const el = c.own(c.h('section', { class: 'ui-queue' }, nowHead, nowSlot, nextHead, listSlot));
  const sectionOf = t => t?.section ?? 'queue';
  const label = s => p.sections[s] ?? (s === 'queue' ? c.s.t('queue.next') : String(s));
  let card = null, clearBtns = [];
  const list = createTrackList(listSlot, {
    // a queue is a plain list: no checkboxes, no stacked layout in a narrow panel (selection would only add clutter there)
    tracks: p.tracks, columns: ['title', 'duration'], label: p.label || c.s.t('queue.label'), sortable: false, reorderable: true, current: null, virtual: false, selectable: false, stacked: false, animateRows: true, // tracks glide when moved, removed or added (D81)
    groupBy: sectionOf, groupLabel: label, empty: { title: c.s.t('queue.empty'), message: c.s.t('queue.emptyMessage') },
    menu: t => [{ id: '@remove', label: c.s.t('queue.remove'), icon: 'trash' }, ...(p.menu?.(t) || [])],
    onMenu: e => (e.item.id === '@remove' ? remove([e.track.id]) : c.emit(el, 'menu', e, p.onMenu)),
    onPlay: e => c.emit(el, 'play', { track: e.track, id: e.id }, p.onPlay),
    onReorder: e => { const at = p.tracks.find(t => t.id === e.before) || p.tracks.filter(t => !e.keys.includes(t.id)).at(-1); c.emit(el, 'reorder', { keys: e.keys, before: e.before, index: e.index, order: e.order, section: sectionOf(at) }, p.onReorder); },
  }, c.s);
  function remove(ids) { if (ids.length) c.emit(el, 'remove', { ids }, p.onRemove); }
  c.on(listSlot, 'keydown', e => {
    if (e.key !== 'Delete' || e.defaultPrevented) return;
    const tr = e.target.closest?.('.ui-tr'); if (!tr || e.target !== tr) return;
    e.preventDefault();
    const sel = list.selected;
    remove(sel.length && sel.includes(tr._key) ? sel : [tr._key]);
  });
  function render() {
    nowHead.textContent = c.s.t('queue.now');
    const t = p.current;
    nowSlot.hidden = !t; nowHead.hidden = !t;
    if (t) {
      const props2 = { title: t.title, subtitle: t.artist, artwork: t.artwork ? { src: t.artwork, alt: '' } : null, layout: 'row', current: true, playing: !!p.playing, level: 3 };
      if (card) card.update(props2); else card = createMediaCard(nowSlot, props2, c.s);
    } else { card?.destroy(); card = null; }
    for (const b of clearBtns) b.destroy();
    const present = [...new Set(p.tracks.map(sectionOf))].filter(s => p.clearable.includes(s));
    nextHead.hidden = !present.length;
    clearBtns = present.map(s => createButton(nextHead, { label: present.length > 1 ? `${c.s.t('queue.clear')} · ${label(s)}` : c.s.t('queue.clear'), variant: 'ghost', icon: 'close', onClick: () => c.emit(el, 'clear', { section: s }, p.onClear) }, c.s));
    el.setAttribute('aria-label', p.label || c.s.t('queue.label'));
    el.toggleAttribute('data-empty', !t && !p.tracks.length);
    el.toggleAttribute('data-no-upcoming', !p.tracks.length); // the empty state alone, without column headers
  }
  c.cleanup(() => { card?.destroy(); for (const b of clearBtns) b.destroy(); list.destroy(); });
  render(); container.append(el);
  return {
    root: el, list,
    update(n) {
      p = { ...p, ...n };
      const t = {};
      if ('tracks' in n) t.tracks = p.tracks;
      if ('playing' in n) t.playing = p.playing;
      if ('loading' in n) t.loading = p.loading;
      if ('error' in n) t.error = p.error;
      if ('onRetry' in n) t.onRetry = p.onRetry;
      if ('sections' in n) t.groupLabel = s => label(s);
      if (Object.keys(t).length) list.update(t);
      render();
    },
    focus: () => list.focus(),
    destroy: () => c.destroy(),
  };
}
