import { setup, fill, createVirtualizer, reconcileChildren } from '../ui/index.js';
import { plusStrings } from './strings.js';

/**
 * createLog(container, { lines: [{ id, time, level: 'debug'|'info'|'warn'|'error', source, message }], label,
 *   height = '18rem', follow = true, maxLines = 10000, timeFormat: Intl.DateTimeFormatOptions | (Date) => string }, services)
 * → { root, append(lines), clear(), pause(), resume(), update, destroy }
 * A virtualized stream. While the reader is at the end it follows new lines; after scrolling up it stays put and a
 * "n new lines" button jumps back. Pause holds new lines until resumed. role=log with aria-live off: a busy stream is
 * not read out line by line; levels are written as words, not colour alone.
 */
export function createLog(container, props = {}, services) {
  const c = setup(container, services, 'log'); plusStrings(c.s);
  let p = { lines: [], height: '18rem', follow: true, maxLines: 10000, ...props };
  let lines = p.lines.slice(-p.maxLines), held = [], paused = false, atEnd = true, unseen = 0, virt = null;
  const top = c.h('div', { class: 'ui-log-spacer', 'aria-hidden': 'true' }), bottom = c.h('div', { class: 'ui-log-spacer', 'aria-hidden': 'true' });
  const list = c.h('div', { class: 'ui-log-lines' });
  const scroller = c.h('div', { class: 'ui-log-scroll', role: 'log', 'aria-live': 'off', tabindex: '0' }, list);
  const jump = c.h('button', { type: 'button', class: 'ui-button ui-log-jump', hidden: true }, c.icon('arrow-down'), c.h('span'));
  const pauseBtn = c.h('button', { type: 'button', class: 'ui-button', 'data-variant': 'ghost', 'aria-pressed': 'false' });
  const status = c.h('span', { class: 'ui-log-status', role: 'status' });
  const el = c.own(c.h('div', { class: 'ui-log' }, c.h('div', { class: 'ui-log-bar' }, status, pauseBtn), scroller, jump));
  const time = t => (t == null ? '' : typeof t === 'string' ? t : typeof p.timeFormat === 'function' ? p.timeFormat(new Date(t)) : c.s.format.time(new Date(t), p.timeFormat || { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
  const sep = () => c.h('span', { class: 'ui-visually-hidden' }, ', ');
  const lineEl = ln => c.h('div', { class: 'ui-log-line', 'data-level': ln.level || 'info' },
    // hidden separators keep the parts apart for screen readers (whitespace inside a grid is dropped from the a11y tree)
    c.h('span', { class: 'ui-log-time' }, time(ln.time)), sep(), c.h('span', { class: 'ui-log-level' }, c.s.t(`log.${ln.level || 'info'}`)), sep(),
    ln.source ? c.h('span', { class: 'ui-log-source' }, ln.source) : null, ln.source ? sep() : null, c.h('span', { class: 'ui-log-msg' }, ln.message), c.h('span', { class: 'ui-visually-hidden' }, '; '));
  const cache = new WeakMap();
  const elFor = ln => { let e = cache.get(ln); if (!e) { e = lineEl(ln); cache.set(ln, e); } return e; };
  function paint({ start, end, top: t, bottom: b }) {
    const out = [top];
    for (let i = start; i < end; i++) out.push(elFor(lines[i]));
    out.push(bottom);
    top.style.height = `${t}px`; bottom.style.height = `${b}px`;
    const focused = c.doc.activeElement; // keep the scroll position: never remove the focused node (see table.js)
    if (focused && list.contains(focused) && !out.some(x => x.contains(focused))) scroller.focus({ preventScroll: true });
    reconcileChildren(list, out);
    let changed = false;
    for (let i = start; i < end; i++) changed = virt.measure(i, elFor(lines[i]).offsetHeight) || changed;
    if (changed) { top.style.height = `${virt.offsetOf(start)}px`; bottom.style.height = `${virt.total() - virt.offsetOf(end)}px`; }
  }
  function renderChrome() {
    scroller.setAttribute('aria-label', p.label || '');
    scroller.style.height = p.height;
    pauseBtn.textContent = c.s.t(paused ? 'log.resume' : 'log.pause'); pauseBtn.setAttribute('aria-pressed', String(paused));
    status.textContent = paused ? `${c.s.t('log.paused')}${held.length ? ` · ${c.s.t('log.newLines', { count: c.s.format.number(held.length) })}` : ''}` : lines.length ? '' : c.s.t('log.empty');
    jump.hidden = !unseen; jump.lastChild.textContent = c.s.t('log.newLines', { count: c.s.format.number(unseen) });
  }
  const toEnd = () => { virt.scrollToIndex(lines.length - 1, 'end'); scroller.scrollTop = scroller.scrollHeight; };
  c.on(scroller, 'scroll', () => { atEnd = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4; if (atEnd && unseen) { unseen = 0; renderChrome(); } });
  c.on(jump, 'click', () => { unseen = 0; toEnd(); renderChrome(); scroller.focus(); });
  c.on(pauseBtn, 'click', () => (paused ? api.resume() : api.pause()));
  virt = createVirtualizer({ scroller, list, count: lines.length, estimate: 20, overscan: 12, onRange: paint });
  c.cleanup(() => virt.destroy());
  container.append(el);
  renderChrome(); virt.update();
  if (p.follow) c.win.requestAnimationFrame(toEnd);
  const api = {
    root: el,
    append(more) {
      if (paused) { held.push(...more); renderChrome(); return; }
      const follow = p.follow && atEnd;
      lines = lines.concat(more);
      if (lines.length > p.maxLines) lines = lines.slice(-p.maxLines);
      virt.setCount(lines.length);
      if (follow) toEnd(); else { unseen += more.length; }
      renderChrome();
    },
    clear() { lines = []; held = []; unseen = 0; virt.setCount(0); renderChrome(); },
    pause() { paused = true; renderChrome(); },
    resume() { paused = false; const h = held; held = []; renderChrome(); if (h.length) api.append(h); },
    get lines() { return lines.slice(); }, get paused() { return paused; },
    update(n) { p = { ...p, ...n }; if ('lines' in n) { lines = n.lines.slice(-p.maxLines); virt.setCount(lines.length); } renderChrome(); },
    destroy: () => c.destroy(),
  };
  return api;
}

/**
 * createVirtualList(container, { items: [{ id, title, description, meta }], label, height = '24rem', render(item) → Node,
 *   onSelect({ id, item }), value, groupBy(item) → key, groupLabel(key, items) }, services) — a long list that renders
 * only the rows in view (P1 virtualization). Rows may differ in height: each is measured once rendered.
 * Rows are options of a listbox when onSelect is given (arrow keys move, Enter selects), otherwise a plain list.
 * Since 2.5.0: `groupBy` starts a header wherever the key changes; the current group's header stays at the top while
 * its rows scroll (G64), and each row's description names its group. An update keeps the active row (by id), the
 * selection and the first visible row in place (G62).
 */
export function createVirtualList(container, props = {}, services) {
  const c = setup(container, services, 'virtual-list'); plusStrings(c.s);
  let p = { items: [], height: '24rem', ...props };
  let active = 0, virt = null;
  const top = c.h('div', { 'aria-hidden': 'true' }), bottom = c.h('div', { 'aria-hidden': 'true' });
  const list = c.h('div', { class: 'ui-vlist-items' });
  const names = c.h('div', { class: 'ui-visually-hidden', 'aria-hidden': 'true' }); // group names that rows point at (always in the DOM)
  const el = c.own(c.h('div', { class: 'ui-vlist', tabindex: '0' }, list, names));
  const cache = new WeakMap(), heads = new Map();
  const select = !!p.onSelect;
  // entries: rows and group headers in display order; rowAt[i]: the entry index of item i; headOf[e]: an entry's header
  let entries = [], rowAt = [], headOf = [];
  const GROUP = Symbol('group'), isGroup = x => !!x?.[GROUP];
  function plan() {
    entries = []; rowAt = []; headOf = [];
    if (!p.groupBy) { entries = p.items; rowAt = p.items.map((_, i) => i); headOf = []; return; }
    let last = {}, h = null;
    const live = new Set();
    p.items.forEach(it => {
      const k = p.groupBy(it);
      if (k !== last) { last = k; live.add(k); h = { [GROUP]: true, key: k, items: [] }; headOf.push(entries.length); entries.push(h); }
      h.items.push(it); rowAt.push(entries.length); headOf.push(headOf[headOf.length - 1]); entries.push(it);
    });
    for (const k of [...heads.keys()]) if (!live.has(k)) { heads.get(k).name.remove(); heads.delete(k); }
    for (const e of entries) if (isGroup(e)) {
      let g = heads.get(e.key);
      if (!g) { g = { el: c.h('div', { class: 'ui-vlist-group', 'aria-hidden': 'true' }), name: c.h('span', { id: `${c.name}-g${Math.random().toString(36).slice(2, 9)}` }) }; heads.set(e.key, g); names.append(g.name); }
      const label = p.groupLabel ? p.groupLabel(e.key, e.items) : e.key;
      g.el.textContent = g.name.textContent = label == null ? '' : String(label);
      e.el = g.el; e.nameId = g.name.id;
    }
  }
  function rowEl(it, i, nameId) {
    let r = cache.get(it);
    if (!r) {
      r = c.h('div', { class: 'ui-vlist-row', role: select ? 'option' : 'listitem', id: `${c.name}-${Math.random().toString(36).slice(2, 9)}` },
        p.render ? p.render(it) : [c.h('div', { class: 'ui-vlist-text' }, c.h('div', {}, it.title), it.description ? c.h('small', {}, it.description) : null), it.meta != null ? c.h('span', { class: 'ui-vlist-meta' }, it.meta) : null]);
      r._item = it; cache.set(it, r);
    }
    r._i = i;
    r.setAttribute('aria-posinset', String(i + 1)); r.setAttribute('aria-setsize', String(p.items.length));
    if (nameId) r.setAttribute('aria-describedby', nameId); else r.removeAttribute('aria-describedby');
    r.toggleAttribute('data-active', select && i === active);
    if (select) r.setAttribute('aria-selected', String(it.id === p.value));
    return r;
  }
  const itemIndex = new Map();
  function paint({ start, end, top: t, bottom: b }) {
    const out = [top];
    // the current group's header is carried at the top while its rows scroll (it takes no space: see the margin below)
    const carried = p.groupBy && entries[start] && !isGroup(entries[start]) && headOf[start] < start ? entries[headOf[start]].el : null;
    if (carried) { carried.dataset.carried = ''; out.push(carried); }
    for (let e = start; e < end; e++) {
      const x = entries[e];
      if (isGroup(x)) { if (x.el !== carried) { delete x.el.dataset.carried; x.el.style.marginBlockEnd = ''; out.push(x.el); } continue; }
      out.push(rowEl(x, itemIndex.get(x), p.groupBy ? entries[headOf[e]].nameId : null));
    }
    out.push(bottom);
    top.style.height = `${t}px`; bottom.style.height = `${b}px`;
    reconcileChildren(list, out);
    let changed = false;
    for (let e = start; e < end; e++) { const x = entries[e]; changed = virt.measure(e, (isGroup(x) ? x.el : cache.get(x)).offsetHeight) || changed; }
    if (carried) carried.style.marginBlockEnd = `${-carried.offsetHeight}px`;
    if (changed) { top.style.height = `${virt.offsetOf(start)}px`; bottom.style.height = `${virt.total() - virt.offsetOf(end)}px`; }
    const act = select && p.items[active] && cache.get(p.items[active]);
    if (act?.isConnected) el.setAttribute('aria-activedescendant', act.id); else el.removeAttribute('aria-activedescendant');
  }
  function index() { itemIndex.clear(); p.items.forEach((it, i) => itemIndex.set(it, i)); plan(); }
  function chrome() {
    el.style.height = p.height;
    el.setAttribute('role', select ? 'listbox' : 'list');
    if (p.label) el.setAttribute('aria-label', p.label);
  }
  function move(i) { active = Math.max(0, Math.min(p.items.length - 1, i)); virt.scrollToIndex(rowAt[active] ?? active); virt.update(); }
  c.on(el, 'keydown', e => {
    if (!select) return;
    const step = { ArrowDown: 1, ArrowUp: -1, PageDown: 10, PageUp: -10 }[e.key];
    if (step) { e.preventDefault(); move(active + step); }
    else if (e.key === 'Home') { e.preventDefault(); move(0); }
    else if (e.key === 'End') { e.preventDefault(); move(p.items.length - 1); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(p.items[active]); }
  });
  c.on(list, 'click', e => { const r = e.target.closest('.ui-vlist-row'); if (r && select) { active = r._i; choose(r._item); } });
  function choose(it) { if (!it) return; p.value = it.id; virt.update(); c.emit(el, 'select', { id: it.id, item: it }, p.onSelect); }
  chrome(); index();
  container.append(el);
  // a carried group header covers the top row: rows scrolled to stay clear of it
  virt = createVirtualizer({ scroller: el, list, count: entries.length, estimate: 44, overscan: 8, onRange: paint, inset: () => (p.groupBy ? heads.values().next().value?.el.offsetHeight || 0 : 0) });
  c.cleanup(() => virt.destroy());
  virt.update();
  return {
    root: el, scrollToIndex: i => virt.scrollToIndex(rowAt[i] ?? i, 'center'),
    update(n) {
      // keep the first visible row where it is, and the active row by id
      const sr = el.getBoundingClientRect(), first = [...list.children].find(r => r._item && r.getBoundingClientRect().bottom > sr.top);
      const anchor = first ? { id: first._item.id, dy: first.getBoundingClientRect().top - sr.top } : null, activeId = p.items[active]?.id;
      p = { ...p, ...n }; chrome();
      if ('items' in n || 'groupBy' in n || 'groupLabel' in n) {
        index();
        const ai = p.items.findIndex(it => it.id === activeId); active = ai >= 0 ? ai : Math.min(active, Math.max(0, p.items.length - 1));
      }
      virt.setCount(entries.length);
      const i = anchor ? p.items.findIndex(it => it.id === anchor.id) : -1;
      if (i >= 0 && 'items' in n) {
        const listTop = list.getBoundingClientRect().top - sr.top + el.scrollTop;
        el.scrollTop = Math.max(0, listTop + virt.offsetOf(rowAt[i]) - anchor.dy); virt.update();
        const r = cache.get(p.items[i]), d = r?.isConnected ? r.getBoundingClientRect().top - el.getBoundingClientRect().top - anchor.dy : 0;
        if (Math.abs(d) >= 1) { el.scrollTop += d; virt.update(); }
      }
    },
    focus: () => el.focus(), destroy: () => c.destroy(),
  };
}
