// The body of a drawn listbox, shared by the drawn select and the combobox (D55, GAPS G10). Options come in runs:
// consecutive options of one group render inside role="group" named by the group, whose visible heading is decoration
// (in a long list the heading can be out of view while its options are not). Every option carries aria-posinset /
// aria-setsize within its run. Lists longer than `threshold` render only the rows in view (opening ~420 time zones
// with every row rendered took about 100 ms p95 at 4× CPU, twice the D20 input budget). Heights measured on earlier
// paints place rows before they render; they are fractional, because rounded heights drift over hundreds of rows.
import { createVirtualizer, reconcileChildren } from './virtual.js';

export const WINDOW_AT = 100;

/**
 * runsOf(entries, groupOf) → { items, runs }: adds `pos` and `run` to each entry and inserts a heading item
 * ({ head: true, run }) before each run that has a group. runs: [{ group, size }].
 */
export function runsOf(entries, groupOf) {
  const items = [], runs = [];
  let run = null;
  for (const e of entries) {
    const g = groupOf(e) ?? null;
    if (!run || run.group !== g) { run = { group: g, size: 0 }; runs.push(run); if (g != null) items.push({ head: true, run: runs.length - 1 }); }
    e.pos = ++run.size; e.run = runs.length - 1;
    items.push(e);
  }
  return { items, runs };
}

/**
 * createOptionList(c, { list, scroller, row(item, run) → element, kind(item) → string, isOpen(), onPaint(), threshold })
 * row() returns the option element for an item and brings its state up to date; kind() names a row's shape for the
 * height cache (headings, plain options, options with a description). onPaint() runs after every paint (e.g. to point
 * aria-activedescendant at the active row while it is rendered).
 * → { set(items, runs, { defer }), scrollTo(index, align), paint(), reset(), painted, destroy() }
 */
export function createOptionList(c, { list, scroller, row, kind = it => (it.head ? 'head' : 'option'), isOpen = () => true, onPaint = () => {}, threshold = WINDOW_AT }) {
  const topGap = c.h('div', { 'aria-hidden': 'true' }), bottomGap = c.h('div', { 'aria-hidden': 'true' });
  let items = [], runs = [], windowed = false, painted = null, remeasured = false, hold = false;
  const known = {}; // rendered height by kind of row
  const virt = createVirtualizer({ scroller, list, estimate: 32, overscan: 8, onRange: paint });
  function head(run) {
    run.el ??= c.h('div', { role: 'group', 'aria-label': run.group });
    run.head ??= c.h('div', { class: 'ui-option-group', 'aria-hidden': 'true' }, run.group);
    return run.head;
  }
  function paint({ start, end }) {
    remeasured = false;
    if (!isOpen() || hold) return;
    if (!windowed) { start = 0; end = items.length; }
    if (painted && painted.items === items && painted.start === start && painted.end === end) return;
    const els = [], out = [topGap];
    let cur = null, kids = [];
    const flush = () => { if (cur) reconcileChildren(cur.el, kids); };
    for (let k = start; k < end; k++) {
      const it = items[k], run = runs[it.run], el = it.head ? head(run) : row(it, run);
      els.push(el);
      if (run.group == null) { flush(); cur = null; out.push(el); continue; }
      if (cur !== run) { flush(); cur = run; kids = []; head(run); out.push(run.el); }
      kids.push(el);
    }
    flush(); out.push(bottomGap);
    reconcileChildren(list, out);
    let seen = true; // rows measured while the surface is still hidden are measured again once it shows
    els.forEach((el, n) => {
      const px = el.getBoundingClientRect().height;
      if (px) { remeasured = virt.measure(start + n, px) || remeasured; known[kind(items[start + n])] = px; } else seen = false;
    });
    painted = seen ? { items, start, end } : null;
    topGap.style.height = `${windowed ? virt.offsetOf(start) : 0}px`;
    bottomGap.style.height = `${windowed ? virt.total() - virt.offsetOf(end) : 0}px`;
    onPaint();
  }
  return {
    /** Replaces the items. defer: compute only, the caller paints (opening paints once, around the active option). */
    set(nextItems, nextRuns, { defer = false } = {}) {
      items = nextItems; runs = nextRuns;
      windowed = items.reduce((n, it) => n + (it.head ? 0 : 1), 0) > threshold;
      hold = true; virt.setCount(items.length); hold = false;
      items.forEach((it, k) => { const px = known[kind(it)]; if (px) virt.measure(k, px); });
      if (!defer) virt.update();
    },
    /** Renders the rows around item k and scrolls it into view; again if measuring them moved it. A run's first option brings its heading into view. */
    scrollTo(k, align = 'auto') {
      virt.scrollToIndex(k, align);
      if (remeasured) virt.scrollToIndex(k, align);
      if (k > 0 && items[k - 1]?.head) virt.scrollToIndex(k - 1, 'auto');
    },
    paint: () => virt.update(),
    reset() { painted = null; list.replaceChildren(); },
    get painted() { return painted?.items === items; },
    get windowed() { return windowed; },
    destroy: () => virt.destroy(),
  };
}
