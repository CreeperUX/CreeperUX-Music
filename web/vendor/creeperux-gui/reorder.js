// Reordering for lists and tables (2.5.0, G57): a drag handle per row, by pointer or by keyboard. The list never changes
// its own order: it proposes one (stable keys and the full new order) and the host confirms by passing new rows.
// Works with virtualized lists: positions are indices into the data, and only rendered rows are measured.

/**
 * createReorder({ s, container, handleSelector, rowOf(el) → { key } | null, rendered() → row elements in order,
 *   keys() → every key in data order, selected() → keys, labelOf(key), reveal(key) → element | null, enabled() → bool,
 *   onMove({ keys, before, index, order }), afterMove(key) })
 * → { moveBy(key, delta), refresh(), cancel(), get active, destroy() }
 * Pointer: drag a handle; the line shows where the rows go; near the scroller's edges the list scrolls; Escape cancels.
 * Keyboard (on a handle): Space or Enter picks up, ↑ ↓ PageUp PageDown Home End move, Space or Enter drops, Escape or Tab
 * cancels. The selected rows move together when the handle's row is one of them.
 */
export function createReorder(o) {
  const { s } = o, doc = o.container.ownerDocument, win = doc.defaultView, abort = new AbortController(), on = { signal: abort.signal };
  let drag = null, pending = null, frame = 0;
  const say = (k, p) => s.announce(s.t(k, p), { dedupeMs: 0 });
  const nameOf = keys => (keys.length > 1 ? s.t('reorder.items', { count: keys.length }) : o.labelOf(keys[0]));
  const line = doc.createElement('div'); line.className = 'ui-reorder-line'; line.setAttribute('aria-hidden', 'true');
  const ghost = doc.createElement('div'); ghost.className = 'ui-reorder-ghost'; ghost.setAttribute('aria-hidden', 'true');
  function scrollParent() {
    for (let e = o.container; e && e !== doc.body; e = e.parentElement) {
      const y = win.getComputedStyle(e).overflowY;
      if ((y === 'auto' || y === 'scroll') && e.scrollHeight > e.clientHeight + 1) return e;
    }
    return doc.scrollingElement;
  }
  function begin(key, mode, handle, quiet) {
    if (drag || !o.enabled()) return false;
    const all = o.keys(), sel = new Set(o.selected?.() || []);
    const moving = sel.has(key) && sel.size > 1 ? all.filter(k => sel.has(k)) : [key], set = new Set(moving);
    const rest = all.filter(k => !set.has(k)), target = all.slice(0, all.indexOf(moving[0])).filter(k => !set.has(k)).length;
    drag = { key, moving, set, rest, target, origin: target, mode, handle, total: all.length, y: 0, scroller: scrollParent() };
    for (const el of o.rendered()) if (set.has(o.rowOf(el)?.key)) el.dataset.moving = '';
    o.container.dataset.reordering = mode;
    s.overlays.portal.append(line);
    if (mode === 'pointer') { ghost.textContent = nameOf(moving); s.overlays.portal.append(ghost); }
    if (!quiet) say('reorder.grabbed', { name: nameOf(moving), pos: target + 1, count: drag.total });
    if (mode === 'keyboard') doc.addEventListener('keydown', keys, { capture: true, signal: abort.signal });
    doc.addEventListener('scroll', onScroll, { capture: true, passive: true, signal: abort.signal }); // the line is fixed: it follows any scroll
    return true;
  }
  let scrollFrame = 0;
  function onScroll() { if (drag && !scrollFrame) scrollFrame = win.requestAnimationFrame(() => { scrollFrame = 0; if (drag?.mode === 'pointer') drag.target = targetAt(drag.y); place(); }); }
  function finish() {
    const d = drag; drag = null; win.cancelAnimationFrame(frame); frame = 0;
    for (const el of o.container.querySelectorAll('[data-moving]')) delete el.dataset.moving;
    delete o.container.dataset.reordering;
    line.remove(); ghost.remove();
    doc.removeEventListener('keydown', keys, { capture: true });
    doc.removeEventListener('scroll', onScroll, { capture: true }); win.cancelAnimationFrame(scrollFrame); scrollFrame = 0;
    return d;
  }
  function cancel(quiet) {
    if (!drag) return;
    const d = finish();
    if (!quiet) say('reorder.cancelled');
    if (d.handle && d.mode === 'keyboard') focusHandle(d.key);
  }
  function focusHandle(key) { win.requestAnimationFrame(() => o.reveal(key)?.querySelector(o.handleSelector)?.focus({ preventScroll: true })); }
  function drop() {
    if (!drag) return;
    const d = finish();
    if (d.target === d.origin) { say('reorder.cancelled'); if (d.handle && d.mode === 'keyboard') focusHandle(d.key); return; }
    const order = [...d.rest.slice(0, d.target), ...d.moving, ...d.rest.slice(d.target)];
    o.onMove({ keys: d.moving, before: d.rest[d.target] ?? null, index: d.target, order });
    say('reorder.dropped', { name: nameOf(d.moving), pos: d.target + 1, count: d.total });
    if (d.mode === 'keyboard') { if (d.handle) focusHandle(d.key); o.afterMove?.(d.key, !!d.handle); }
  }
  // The line sits on the edge between rendered rows: above the row the items go before, or below the last one.
  function place() {
    if (!drag) return;
    const before = drag.rest[drag.target], after = drag.rest[drag.target - 1];
    const rows = o.rendered().filter(el => !drag.set.has(o.rowOf(el)?.key));
    const row = rows.find(el => o.rowOf(el)?.key === before) || rows.find(el => o.rowOf(el)?.key === after);
    const box = o.container.getBoundingClientRect();
    if (!row) { line.hidden = true; return; }
    const r = row.getBoundingClientRect(), y = o.rowOf(row).key === before ? r.top : r.bottom;
    line.hidden = false;
    Object.assign(line.style, { left: `${box.left}px`, width: `${box.width}px`, top: `${Math.round(y) - 1}px` });
  }
  function targetAt(y) {
    const rows = o.rendered().filter(el => !drag.set.has(o.rowOf(el)?.key));
    if (!rows.length) return drag.target;
    for (const el of rows) { const r = el.getBoundingClientRect(); if (y < r.top + r.height / 2) return drag.rest.indexOf(o.rowOf(el).key); }
    return drag.rest.indexOf(o.rowOf(rows[rows.length - 1]).key) + 1;
  }
  function tick() {
    frame = 0;
    if (!drag || drag.mode !== 'pointer') return;
    const sc = drag.scroller, r = sc === doc.scrollingElement ? { top: 0, bottom: win.innerHeight } : sc.getBoundingClientRect(), edge = 48;
    const speed = drag.y < r.top + edge ? -(1 - Math.max(0, drag.y - r.top) / edge) : drag.y > r.bottom - edge ? 1 - Math.max(0, r.bottom - drag.y) / edge : 0;
    if (speed) { sc.scrollTop += Math.round(speed * 18); frame = win.requestAnimationFrame(tick); } // keeps scrolling while the pointer rests at an edge
    // the rows painted for the new scroll position come in the next frame: measure after it
    win.requestAnimationFrame(() => { if (drag) { drag.target = targetAt(drag.y); place(); } });
  }
  o.container.addEventListener('pointerdown', e => {
    const handle = e.target.closest?.(o.handleSelector);
    if (!handle || e.button || drag || !o.enabled()) return;
    const key = o.rowOf(handle)?.key;
    if (key === undefined) return;
    pending = { key, x: e.clientX, y: e.clientY, id: e.pointerId, handle };
    e.preventDefault(); handle.focus({ preventScroll: true });
  }, on);
  doc.addEventListener('pointermove', e => {
    if (pending && e.pointerId === pending.id && Math.hypot(e.clientX - pending.x, e.clientY - pending.y) > 4) { const p = pending; pending = null; begin(p.key, 'pointer', p.handle); }
    if (!drag || drag.mode !== 'pointer') return;
    drag.y = e.clientY;
    Object.assign(ghost.style, { left: `${e.clientX + 12}px`, top: `${e.clientY + 12}px` });
    drag.target = targetAt(e.clientY); place();
    if (!frame) frame = win.requestAnimationFrame(tick);
  }, on);
  doc.addEventListener('pointerup', e => { if (pending?.id === e.pointerId) pending = null; if (drag?.mode === 'pointer') drop(); }, on);
  doc.addEventListener('pointercancel', () => { pending = null; if (drag?.mode === 'pointer') cancel(); }, on);
  doc.addEventListener('keydown', e => { if (drag?.mode === 'pointer' && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); } }, { capture: true, signal: abort.signal });
  o.container.addEventListener('keydown', e => {
    const handle = e.target.closest?.(o.handleSelector);
    if (!handle || drag || (e.key !== ' ' && e.key !== 'Enter')) return;
    const key = o.rowOf(handle)?.key;
    if (key === undefined) return;
    e.preventDefault(); e.stopPropagation();
    if (begin(key, 'keyboard', handle)) place();
  }, on);
  // While picked up by keyboard the keys belong to the move, wherever focus is (a virtualized row may leave the DOM).
  function keys(e) {
    if (!drag) return;
    if (e.key === 'Tab') { cancel(); return; }
    const n = drag.rest.length, step = { ArrowDown: 1, ArrowUp: -1, PageDown: 10, PageUp: -10 }[e.key];
    let t = null;
    if (step) t = drag.target + step; else if (e.key === 'Home') t = 0; else if (e.key === 'End') t = n;
    else if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); drop(); return; }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); return; }
    else return;
    e.preventDefault(); e.stopPropagation();
    t = Math.max(0, Math.min(n, t));
    if (t === drag.target) return;
    drag.target = t;
    o.reveal(drag.rest[t] ?? drag.rest[t - 1]);
    win.requestAnimationFrame(place);
    say('reorder.position', { pos: t + 1, count: drag.total });
  }
  return {
    get active() { return !!drag; },
    /** Moves a row (or the selection it belongs to) by `delta` places at once, as Alt+↑ / Alt+↓ do. */
    moveBy(key, delta) {
      if (drag || !begin(key, 'keyboard', null, true)) return;
      drag.target = Math.max(0, Math.min(drag.rest.length, drag.target + delta));
      drop();
    },
    /** The data changed: a picked-up row that is gone cancels the move; otherwise the line keeps its neighbour. */
    refresh() {
      if (!drag) return;
      const all = o.keys(), live = new Set(all);
      if (drag.moving.some(k => !live.has(k))) { cancel(); return; }
      const before = drag.rest[drag.target];
      drag.rest = all.filter(k => !drag.set.has(k)); drag.total = all.length;
      drag.target = before == null || !live.has(before) ? drag.rest.length : drag.rest.indexOf(before);
      for (const el of o.rendered()) el.toggleAttribute('data-moving', drag.set.has(o.rowOf(el)?.key));
      win.requestAnimationFrame(place);
    },
    cancel: () => cancel(true),
    destroy() { cancel(true); abort.abort(); },
  };
}
