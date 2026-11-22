// Windowing for long collections (P1 virtualization, shared by the table, list and log). Items may have different
// heights: unknown items use the estimate and are measured once rendered. Only the items in view plus an overscan
// are in the DOM; spacers keep the scroll height and the scrollbar honest.

/**
 * createVirtualizer({ scroller, list, count, estimate = 36, overscan = 6, inset() → px, onRange({ start, end, top, bottom }) })
 * scroller: the element that scrolls; list: the element holding the items (its offset inside the scroller is measured).
 * inset (2.5.0): the height at the top of the scroller covered by sticky content (column and group headers);
 * scrollToIndex keeps an item clear of it.
 * → { setCount(n), measure(index, height), scrollToIndex(index, align = 'auto'|'start'|'end'|'center'), update(), range, destroy() }
 */
export function createVirtualizer({ scroller, list = scroller, count = 0, estimate = 36, overscan = 6, inset, onRange } = {}) {
  const win = scroller.ownerDocument.defaultView;
  let n = count, sizes = new Float64Array(n).fill(estimate), offsets = new Float64Array(n + 1), dirty = true;
  let range = { start: 0, end: 0 }, frame = 0, destroyed = false;
  function layout() {
    if (!dirty) return;
    offsets[0] = 0;
    for (let i = 0; i < n; i++) offsets[i + 1] = offsets[i] + sizes[i];
    dirty = false;
  }
  const total = () => { layout(); return offsets[n]; };
  const offsetOf = i => { layout(); return offsets[Math.max(0, Math.min(n, i))]; };
  function indexAt(y) { // first item whose bottom edge is below y
    layout();
    let lo = 0, hi = n;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (offsets[mid + 1] <= y) lo = mid + 1; else hi = mid; }
    return Math.min(lo, Math.max(0, n - 1));
  }
  function listTop() { // the list's top edge measured in the scroller's content coordinates
    if (list === scroller) return 0;
    return list.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
  }
  function compute(force = false) {
    frame = 0;
    if (destroyed) return;
    const top = scroller.scrollTop - listTop(), h = scroller.clientHeight || win.innerHeight;
    const start = n ? Math.max(0, indexAt(Math.max(0, top)) - overscan) : 0;
    const end = n ? Math.min(n, indexAt(top + h) + 1 + overscan) : 0;
    if (!force && start === range.start && end === range.end) return;
    range = { start, end };
    onRange?.({ start, end, top: offsetOf(start), bottom: total() - offsetOf(end) });
  }
  const schedule = () => { if (!frame) frame = win.requestAnimationFrame(() => compute()); };
  scroller.addEventListener('scroll', schedule, { passive: true });
  const ro = new win.ResizeObserver(schedule);
  ro.observe(scroller);
  return {
    get range() { return range; }, get count() { return n; }, total, offsetOf,
    setCount(next) {
      const old = sizes; n = next; sizes = new Float64Array(n).fill(estimate); sizes.set(old.subarray(0, Math.min(old.length, n)));
      offsets = new Float64Array(n + 1); dirty = true; compute(true);
    },
    /** Reports a rendered item's height; returns true if it changed (the caller may want to re-render spacers). */
    measure(i, height) { if (i < 0 || i >= n || !height || Math.abs(sizes[i] - height) < 0.5) return false; sizes[i] = height; dirty = true; return true; },
    scrollToIndex(i, align = 'auto') {
      const top = listTop() + offsetOf(i), bottom = top + sizes[Math.min(i, n - 1)], h = scroller.clientHeight, pad = inset?.() || 0;
      let y = scroller.scrollTop;
      if (align === 'start' || (align === 'auto' && top < y + pad)) y = top - pad;
      else if (align === 'end' || (align === 'auto' && bottom > y + h)) y = bottom - h;
      else if (align === 'center') y = top - pad - (h - pad - (bottom - top)) / 2;
      scroller.scrollTop = Math.max(0, y);
      compute(true);
    },
    update: () => compute(true),
    destroy() { destroyed = true; win.cancelAnimationFrame(frame); scroller.removeEventListener('scroll', schedule); ro.disconnect(); },
  };
}

/**
 * reconcileChildren(parent, nodes) — makes parent's children exactly `nodes` (in order) without moving nodes that are
 * already in place. Unlike replaceChildren, a focused row that stays in view keeps focus (moving a node blurs it).
 */
export function reconcileChildren(parent, nodes) {
  const keep = new Set(nodes);
  for (const ch of [...parent.children]) if (!keep.has(ch)) ch.remove();
  let ref = parent.firstElementChild;
  for (const n of nodes) {
    if (n === ref) { ref = ref.nextElementSibling; continue; }
    parent.insertBefore(n, ref);
  }
}
