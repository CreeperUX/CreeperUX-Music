import { setup, fill, safeHref, createVirtualizer, reconcileChildren, openMenu, PRESS_SCALE } from '../ui/index.js';
import { plusStrings } from './strings.js';

const rtlOf = el => el.ownerDocument.defaultView.getComputedStyle(el).direction === 'rtl';

// ---------------------------------------------------------------- image / artwork
/**
 * createImage(container, { src: string | (signal) => Promise<string | null>, alt = '', ratio = 1, fit = 'cover' | 'contain',
 *   shape = 'rounded' | 'square' | 'circle', size, lazy = true, placeholder = 'image', label, onLoad, onError }, services)
 * → { root, get state, update, retry(), destroy }
 * An image that keeps its box while it loads (2.5.0, G61): the box has the given aspect ratio (and `size`, a CSS width,
 * when set), so the layout never moves. While loading it shows the placeholder icon on a quiet surface; a missing
 * `src` (null or empty) shows the placeholder as the "no artwork" state; a failed load shows it with the error look
 * (`state`: 'empty' | 'loading' | 'loaded' | 'error'). The latest `src` always wins: a slower, older request never
 * replaces a newer one, so fast track changes cannot leave old artwork behind. `src` may be a function that resolves a
 * URL (an artwork cache), called with an AbortSignal that aborts when the source changes; with `lazy` it is first
 * called when the image comes near the viewport. `alt` names the image; '' marks it decorative. The name stays when
 * the image fails (the box becomes role="img"). `retry()` loads the current source again.
 */
export function createImage(container, props = {}, services) {
  const c = setup(container, services, 'image'); plusStrings(c.s);
  let p = { alt: '', ratio: 1, fit: 'cover', shape: 'rounded', lazy: true, placeholder: 'image', ...props };
  const img = c.h('img', { class: 'ui-image-img', alt: '', decoding: 'async', draggable: 'false' }); // shown by state (CSS): a lazy image that is not rendered never loads
  const ph = c.h('span', { class: 'ui-image-ph', 'aria-hidden': 'true' });
  const el = c.own(c.h('span', { class: 'ui-image' }, ph, img));
  let state = 'empty', ticket = 0, ctl = null, io = null, near = !p.lazy, srcKey;
  function chrome() {
    el.style.aspectRatio = String(p.ratio);
    el.style.width = p.size ?? '';
    el.dataset.shape = p.shape; el.dataset.fit = p.fit;
    fill(ph, typeof p.placeholder === 'string' ? c.icon(p.placeholder) : p.placeholder);
    img.alt = p.alt ?? '';
    img.loading = p.lazy ? 'lazy' : 'eager';
    const named = p.alt && state !== 'loaded';
    if (named) { el.setAttribute('role', 'img'); el.setAttribute('aria-label', p.alt); } else { el.removeAttribute('role'); el.removeAttribute('aria-label'); }
    if (p.label) el.title = p.label; else el.removeAttribute('title');
  }
  function setState(s) { state = s; el.dataset.state = s; chrome(); }
  function show(url, my) {
    if (my !== ticket) return;
    if (!url) { img.removeAttribute('src'); setState('empty'); return; }
    setState('loading');
    let settled = false;
    const done = (ok, cached) => {
      if (my !== ticket || settled) return; // a newer source has been set since, or this one already answered
      settled = true;
      if (!ok) { setState('error'); c.emit(el, 'error', { src: url }, p.onError); return; }
      setState('loaded');
      if (!cached) c.s.motion.animate(img, { o: 1 }, { role: 'enter', from: { o: 0 } }).then(() => c.s.motion.reset(img)); // a cached image shows at once
      c.emit(el, 'load', { src: url }, p.onLoad);
    };
    img.onload = () => done(true); img.onerror = () => done(false);
    img.src = url;
    if (img.complete && img.naturalWidth) done(true, true);
  }
  function load() {
    const my = ++ticket;
    ctl?.abort(); ctl = null;
    const src = p.src;
    if (typeof src !== 'function') { show(src || null, my); return; }
    if (!near) { setState('loading'); watch(); return; }
    ctl = new c.win.AbortController();
    setState('loading');
    Promise.resolve().then(() => src(ctl.signal)).then(url => show(url || null, my), () => { if (my === ticket) { setState('error'); c.emit(el, 'error', { src: null }, p.onError); } });
  }
  // a resolver runs only once the image is near the viewport (lazy)
  function watch() {
    if (io || near || !c.win.IntersectionObserver) { if (!c.win.IntersectionObserver) { near = true; load(); } return; }
    io = new c.win.IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) { near = true; io.disconnect(); io = null; load(); } }, { rootMargin: '200px' });
    io.observe(el);
  }
  c.cleanup(() => { ticket++; ctl?.abort(); io?.disconnect(); img.onload = img.onerror = null; });
  chrome(); container.append(el);
  srcKey = p.src; load();
  return {
    root: el, get state() { return state; },
    update(n) { p = { ...p, ...n }; if ('lazy' in n && !p.lazy) near = true; chrome(); if ('src' in n && n.src !== srcKey) { srcKey = n.src; load(); } },
    retry() { load(); },
    destroy: () => c.destroy(),
  };
}

// ---------------------------------------------------------------- media card and compact item
/**
 * createMediaCard(container, { title, subtitle, meta, artwork: { src, alt, shape } | string | null, layout = 'tile' | 'row',
 *   href | onOpen({ event }), onPlay({ event }), playLabel, playing, current, menu: () => MenuItem[], onMenu({ item }),
 *   menuLabel, disabled, level = 3 }, services) → { root, image, update, focus, destroy }
 * An album, artist, playlist or episode (2.5.0, G65). `tile` stacks the artwork over the text (for grids); `row` is the
 * compact list item (artwork at the start, two lines, actions at the end). Three separate actions: the title opens the
 * item (its click area covers the card, the block-link pattern), Play plays it, More opens its menu. Play and More
 * show on hover and while the card holds focus, and always on touch screens, so keyboard and touch users reach them
 * too. `current` marks the open or playing item (aria-current, a bar and an outline, not colour alone); `playing`
 * turns Play into Pause. Missing artwork shows the placeholder (createImage). Long titles wrap to two lines, then end
 * with an ellipsis and keep the full text as a tooltip.
 */
export function createMediaCard(container, props = {}, services) {
  const c = setup(container, services, 'media-card'); plusStrings(c.s);
  let p = { layout: 'tile', level: 3, ...props };
  const art = c.h('div', { class: 'ui-mcard-art' });
  const image = createImage(art, {}, c.s);
  const heading = c.h(`h${p.level}`, { class: 'ui-mcard-title' });
  const sub = c.h('p', { class: 'ui-mcard-sub' }), meta = c.h('p', { class: 'ui-mcard-meta' });
  const play = c.h('button', { type: 'button', class: 'ui-button ui-mcard-play', 'data-variant': 'primary', 'data-icon-only': '' });
  const more = c.h('button', { type: 'button', class: 'ui-button ui-mcard-more', 'data-variant': 'ghost', 'data-icon-only': '', 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, c.icon('more'));
  const acts = c.h('div', { class: 'ui-mcard-actions' }, more);
  for (const b of [play, more]) { // press feedback, as kit buttons have (D81)
    c.on(b, 'pointerdown', e => { if (!e.button && !b.disabled) c.s.motion.animate(b, { sx: PRESS_SCALE, sy: PRESS_SCALE }, { role: 'press' }); });
    const up = () => c.s.motion.animate(b, { sx: 1, sy: 1 }, { role: 'release' });
    c.on(b, 'pointerup', up); c.on(b, 'pointerleave', up); c.on(b, 'pointercancel', up);
  }
  const el = c.own(c.h('div', { class: 'ui-mcard' }, art, c.h('div', { class: 'ui-mcard-body' }, heading, sub, meta), acts));
  let menu = null;
  function render() {
    const off = !!p.disabled, href = off ? null : safeHref(p.href);
    el.dataset.layout = p.layout;
    el.toggleAttribute('data-disabled', off); el.toggleAttribute('data-current', !!p.current); el.toggleAttribute('data-playing', !!p.playing);
    const a = typeof p.artwork === 'string' ? { src: p.artwork } : p.artwork || {};
    image.update({ src: a.src ?? null, alt: a.alt ?? '', shape: a.shape || (p.layout === 'row' ? 'rounded' : 'rounded'), placeholder: a.placeholder || 'image' });
    el.dataset.shape = a.shape || 'rounded';
    const main = href ? c.h('a', { class: 'ui-mcard-link', href }) : p.onOpen ? c.h('button', { type: 'button', class: 'ui-mcard-link', disabled: off || null }) : c.h('span', { class: 'ui-mcard-link' });
    main.append(c.h('span', { class: 'ui-mcard-text' }, p.title ?? ''));
    if (p.current) main.setAttribute('aria-current', 'true');
    main.title = p.title ?? '';
    fill(heading, main);
    el.toggleAttribute('data-action', !!(href || (p.onOpen && !off)));
    sub.textContent = p.subtitle ?? ''; sub.hidden = !p.subtitle; sub.title = p.subtitle ?? '';
    meta.textContent = p.meta ?? ''; meta.hidden = !p.meta;
    play.hidden = !p.onPlay;
    fill(play, c.icon(p.playing ? 'pause' : 'play'));
    play.setAttribute('aria-label', p.playing ? c.s.t('mediaCard.pause', { title: p.title ?? '' }) : (p.playLabel || c.s.t('mediaCard.play', { title: p.title ?? '' })));
    play.disabled = off;
    if (play.parentNode !== (p.layout === 'tile' ? art : acts)) (p.layout === 'tile' ? art : acts).prepend(play);
    more.hidden = !p.menu; more.disabled = off;
    more.setAttribute('aria-label', p.menuLabel || c.s.t('mediaCard.more', { title: p.title ?? '' }));
  }
  c.on(heading, 'click', e => { if (e.target.closest('button.ui-mcard-link') && !p.disabled) c.emit(el, 'open', { event: e }, p.onOpen); });
  c.on(play, 'click', e => { if (!p.disabled) c.emit(el, 'play', { event: e }, p.onPlay); });
  c.on(more, 'click', () => {
    const items = p.menu?.(); if (!items?.length) return;
    menu?.close('switch', { restoreFocus: false });
    more.setAttribute('aria-expanded', 'true');
    menu = openMenu(c.s, { items, trigger: more, anchor: more, placement: 'bottom-end', label: more.getAttribute('aria-label'), onSelect: item => c.emit(el, 'menu', { item }, p.onMenu), onClose: () => { more.setAttribute('aria-expanded', 'false'); menu = null; } });
  });
  // a right click opens the same menu at the pointer
  c.on(el, 'contextmenu', e => {
    const items = p.menu?.(); if (!items?.length || p.disabled) return;
    e.preventDefault();
    menu?.close('switch', { restoreFocus: false });
    menu = openMenu(c.s, { items, point: { x: e.clientX, y: e.clientY }, trigger: heading.firstChild, label: more.getAttribute('aria-label'), onSelect: item => c.emit(el, 'menu', { item }, p.onMenu), onClose: () => { menu = null; } });
  });
  c.cleanup(() => { menu?.close('destroy', { restoreFocus: false }); image.destroy(); });
  render(); container.append(el);
  return { root: el, image, update(n) { p = { ...p, ...n }; render(); }, focus: () => heading.querySelector('a, button')?.focus(), destroy: () => c.destroy() };
}

// ---------------------------------------------------------------- virtual grid
/**
 * createVirtualGrid(container, { items, label, render(item, index) → Node | { root, destroy }, itemKey = 'id',
 *   minItemWidth = 160 (px), gap = 16 (px), estimate = 240 (row height, px), height = '32rem' | null, scroller }, services)
 * → { root, scrollToIndex(i), focusItem(i), update, destroy }
 * A grid of tiles that renders only the rows in view (2.5.0, G66): a thousand albums cost a few dozen tiles. Columns
 * follow the width (as many `minItemWidth` columns as fit). It scrolls on its own (`height`), or inside `scroller`, a
 * scrolling ancestor such as the workspace's main region (then pass `height: null`). A list of tiles with one tab
 * stop: ← → (mirrored in RTL) ↑ ↓ PageUp PageDown Home End (Ctrl for the first and last tile) move between tiles,
 * focusing each tile's first control (its title link); Tab then reaches that tile's other controls. Items rendered
 * once are kept per item, so their handles are destroyed when the item leaves the data or the grid is destroyed.
 * An update keeps the focused tile focused and the first visible row in place.
 */
export function createVirtualGrid(container, props = {}, services) {
  const c = setup(container, services, 'virtual-grid'); plusStrings(c.s);
  let p = { items: [], itemKey: 'id', minItemWidth: 160, gap: 16, estimate: 240, height: '32rem', ...props };
  const keyOf = it => (typeof p.itemKey === 'function' ? p.itemKey(it) : it[p.itemKey]);
  const top = c.h('div', { class: 'ui-vgrid-spacer', 'aria-hidden': 'true' }), bottom = c.h('div', { class: 'ui-vgrid-spacer', 'aria-hidden': 'true' });
  const list = c.h('div', { class: 'ui-vgrid', role: 'list' });
  const own = !p.scroller;
  const el = c.own(c.h('div', { class: 'ui-vgrid-wrap' }, list));
  const scroller = p.scroller || el;
  let cols = 1, virt = null, active = 0, cells = new Map(), rows = new Map();
  const handles = new Map(); // key → { node, handle }
  function cellFor(i) {
    const it = p.items[i], k = keyOf(it);
    let cell = cells.get(k);
    if (!cell || cell._item !== it) {
      if (cell) drop(k);
      const r = p.render ? p.render(it, i) : c.h('div', {}, String(it.title ?? k));
      const node = r?.nodeType ? r : r?.root;
      cell = c.h('div', { class: 'ui-vgrid-item', role: 'listitem' }, node);
      cell._item = it; cell._key = k;
      if (!r?.nodeType && r?.destroy) handles.set(k, r);
      cells.set(k, cell);
    }
    cell._i = i;
    cell.setAttribute('aria-posinset', String(i + 1)); cell.setAttribute('aria-setsize', String(p.items.length));
    return cell;
  }
  function drop(k) { handles.get(k)?.destroy(); handles.delete(k); cells.delete(k); }
  function rowFor(r) {
    let row = rows.get(r);
    if (!row) { row = c.h('div', { class: 'ui-vgrid-row', role: 'presentation' }); rows.set(r, row); }
    const kids = [];
    for (let i = r * cols; i < Math.min(p.items.length, (r + 1) * cols); i++) kids.push(cellFor(i));
    reconcileChildren(row, kids);
    row._r = r;
    return row;
  }
  // a tile's controls, whatever their tabindex (the inactive tiles' controls are out of the tab order)
  const CONTROLS = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not(.ui-vgrid-item)';
  const controlsOf = cell => [...cell.querySelectorAll(CONTROLS)];
  const primaryOf = cell => (cell.querySelector('.ui-mcard-link:not(span)') || controlsOf(cell)[0] || cell);
  function syncTabs() {
    for (const cell of list.querySelectorAll('.ui-vgrid-item')) {
      const on = cell._i === active, prim = primaryOf(cell);
      if (prim === cell) cell.tabIndex = on ? 0 : -1; else cell.removeAttribute('tabindex');
      for (const x of controlsOf(cell)) x.tabIndex = on ? 0 : -1;
    }
  }
  function paint({ start, end, top: t, bottom: b }) {
    const focused = c.doc.activeElement; // before rows are rebuilt: moving a tile to another row blurs it
    const out = [top];
    for (let r = start; r < end; r++) out.push(rowFor(r));
    out.push(bottom);
    top.style.height = `${t}px`; bottom.style.height = `${b}px`;
    if (focused && list.contains(focused) && !out.some(x => x.contains(focused))) { el.tabIndex = -1; el.focus({ preventScroll: true }); }
    reconcileChildren(list, out);
    // tiles move between rows when the columns change, and moving a node blurs it: focus goes back
    if (focused?.isConnected && list.contains(focused) && c.doc.activeElement !== focused) focused.focus({ preventScroll: true });
    let changed = false;
    for (let r = start; r < end; r++) changed = virt.measure(r, rows.get(r).offsetHeight + p.gap) || changed;
    if (changed) { top.style.height = `${virt.offsetOf(start)}px`; bottom.style.height = `${virt.total() - virt.offsetOf(end)}px`; }
    syncTabs();
  }
  function columns() {
    const w = list.clientWidth || el.clientWidth;
    const n = Math.max(1, Math.floor((w + p.gap) / (p.minItemWidth + p.gap)));
    if (n !== cols) { cols = n; rows = new Map(); }
    list.style.setProperty('--ui-vgrid-cols', String(cols));
    list.style.setProperty('--ui-vgrid-gap', `${p.gap}px`);
    return Math.ceil(p.items.length / cols);
  }
  function chrome() {
    if (own) { el.style.height = p.height ?? ''; el.toggleAttribute('data-scroll', p.height != null); }
    if (p.label) list.setAttribute('aria-label', p.label); else list.removeAttribute('aria-label');
  }
  function focusItem(i, scroll = true) {
    if (!p.items.length) return;
    active = Math.max(0, Math.min(p.items.length - 1, i));
    const r = Math.floor(active / cols);
    if (scroll) virt.scrollToIndex(r); else virt.update();
    syncTabs();
    const cell = cells.get(keyOf(p.items[active]));
    if (cell?.isConnected) primaryOf(cell).focus({ preventScroll: true });
  }
  c.on(list, 'keydown', e => {
    const cell = e.target.closest?.('.ui-vgrid-item'); if (!cell) return;
    if (e.target !== primaryOf(cell)) return; // keys inside a tile's other controls are theirs
    const rtl = rtlOf(list), page = Math.max(1, Math.floor(scroller.clientHeight / (virt.total() / Math.max(1, Math.ceil(p.items.length / cols)) || p.estimate))) * cols;
    const step = { ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1, ArrowDown: cols, ArrowUp: -cols, PageDown: page, PageUp: -page }[e.key];
    let to = null;
    if (step) to = cell._i + step;
    else if (e.key === 'Home') to = e.ctrlKey ? 0 : cell._i - (cell._i % cols);
    else if (e.key === 'End') to = e.ctrlKey ? p.items.length - 1 : Math.min(p.items.length - 1, cell._i - (cell._i % cols) + cols - 1);
    if (to == null) return;
    e.preventDefault();
    if (to >= 0 && to < p.items.length) focusItem(to);
    else if (e.key.startsWith('Page')) focusItem(to);
  });
  c.on(list, 'focusin', e => { const cell = e.target.closest?.('.ui-vgrid-item'); if (cell && cell._i !== active) { active = cell._i; syncTabs(); } });
  chrome();
  container.append(el);
  virt = createVirtualizer({ scroller, list, count: columns(), estimate: p.estimate + p.gap, overscan: 2, onRange: paint });
  const ro = new c.win.ResizeObserver(() => { const before = cols, n = columns(); if (cols !== before) { virt.setCount(n); syncTabs(); } else virt.update(); });
  ro.observe(list);
  c.cleanup(() => { ro.disconnect(); virt.destroy(); for (const h of handles.values()) h.destroy(); handles.clear(); });
  virt.update();
  return {
    root: el, list,
    get columns() { return cols; },
    scrollToIndex: i => virt.scrollToIndex(Math.floor(i / cols), 'center'),
    focusItem: i => focusItem(i),
    update(n) {
      // keep the focused tile and the first visible row where they were
      const a = c.doc.activeElement, focusedKey = a && list.contains(a) ? a.closest('.ui-vgrid-item')?._key : undefined;
      const sr = scroller.getBoundingClientRect(), firstRow = [...list.querySelectorAll('.ui-vgrid-row')].find(r => r.getBoundingClientRect().bottom > sr.top);
      const anchorKey = firstRow?.firstElementChild?._key, dy = firstRow ? firstRow.getBoundingClientRect().top - sr.top : 0;
      const activeKey = p.items[active] != null ? keyOf(p.items[active]) : undefined;
      p = { ...p, ...n };
      if ('items' in n) {
        const live = new Set(p.items.map(keyOf));
        for (const k of [...cells.keys()]) if (!live.has(k)) drop(k);
        rows = new Map();
        const ai = p.items.findIndex(it => keyOf(it) === activeKey); active = ai >= 0 ? ai : Math.min(active, Math.max(0, p.items.length - 1));
      }
      chrome();
      virt.setCount(columns());
      const ai = anchorKey !== undefined ? p.items.findIndex(it => keyOf(it) === anchorKey) : -1;
      if (ai >= 0) {
        const listTop = list.getBoundingClientRect().top - sr.top + scroller.scrollTop;
        scroller.scrollTop = Math.max(0, listTop + virt.offsetOf(Math.floor(ai / cols)) - dy); virt.update();
      }
      if (focusedKey !== undefined && !list.contains(c.doc.activeElement)) { const cell = cells.get(focusedKey); if (cell?.isConnected) primaryOf(cell).focus({ preventScroll: true }); }
    },
    focus: () => focusItem(active, false),
    destroy: () => c.destroy(),
  };
}
