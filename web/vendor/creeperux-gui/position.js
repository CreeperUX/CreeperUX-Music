// Anchored positioning: place a floating element next to an anchor (or a point), flip to the other side when it
// does not fit, then shift along the edge to stay inside the viewport. Logical placements follow the direction
// (start / end mirror in RTL). Pure geometry in computePosition(); autoPosition() keeps it updated and cleans up.

/**
 * computePosition({ anchor: DOMRect | {x,y}, floating: {width,height}, viewport: {width,height},
 *   placement: 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end' | 'end-start' | 'start-start' | …,
 *   offset = 4, padding = 8 | { top, right, bottom, left }, dir = 'ltr', flip = true }) → { x, y, placement, maxHeight }
 */
export function computePosition({ anchor, floating, viewport, placement = 'bottom-start', offset = 4, padding = 8, dir = 'ltr', flip = true }) {
  // padding per side: a number, or the sides of a notch or home indicator (safe areas, G36)
  const pad = {}; for (const k of ['top', 'right', 'bottom', 'left']) pad[k] = typeof padding === 'number' ? padding : padding[k] ?? 8;
  const a = 'width' in anchor ? anchor : { left: anchor.x, top: anchor.y, right: anchor.x, bottom: anchor.y, width: 0, height: 0 };
  const rect = { left: a.left, top: a.top, right: a.right ?? a.left + a.width, bottom: a.bottom ?? a.top + a.height };
  let [side, align = 'start'] = placement.split('-');
  const physical = s => (s === 'start' ? (dir === 'rtl' ? 'right' : 'left') : s === 'end' ? (dir === 'rtl' ? 'left' : 'right') : s);
  side = physical(side);
  const vertical = side === 'top' || side === 'bottom';
  const space = { top: rect.top - pad.top, bottom: viewport.height - rect.bottom - pad.bottom, left: rect.left - pad.left, right: viewport.width - rect.right - pad.right };
  const need = (vertical ? floating.height : floating.width) + offset;
  const opposite = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' }[side];
  if (flip && space[side] < need && space[opposite] > space[side]) side = opposite;
  let x, y;
  if (vertical) {
    y = side === 'bottom' ? rect.bottom + offset : rect.top - offset - floating.height;
    const startEdge = dir === 'rtl' ? rect.right - floating.width : rect.left, endEdge = dir === 'rtl' ? rect.left : rect.right - floating.width;
    x = align === 'center' ? (rect.left + rect.right - floating.width) / 2 : align === 'end' ? endEdge : startEdge;
  } else {
    x = side === 'right' ? rect.right + offset : rect.left - offset - floating.width;
    y = align === 'center' ? (rect.top + rect.bottom - floating.height) / 2 : align === 'end' ? rect.bottom - floating.height : rect.top;
  }
  // shift into the viewport
  x = Math.min(Math.max(pad.left, x), Math.max(pad.left, viewport.width - floating.width - pad.right));
  y = Math.min(Math.max(pad.top, y), Math.max(pad.top, viewport.height - floating.height - pad.bottom));
  const maxHeight = vertical ? Math.max(120, (side === 'bottom' ? viewport.height - rect.bottom - offset - pad.bottom : rect.top - offset - pad.top)) : viewport.height - pad.top - pad.bottom;
  const logicalSide = side === 'left' ? (dir === 'rtl' ? 'end' : 'start') : side === 'right' ? (dir === 'rtl' ? 'start' : 'end') : side;
  return { x: Math.round(x), y: Math.round(y), placement: `${logicalSide}-${align}`, maxHeight: Math.round(maxHeight) };
}

// The safe-area insets (notch, home indicator) in px, read from a probe that uses env(); 0 where there are none.
const probes = new WeakMap();
function safeInsets(doc) {
  let el = probes.get(doc);
  if (!el?.isConnected) {
    el = doc.createElement('div'); el.setAttribute('aria-hidden', 'true'); el.dataset.cxAnnouncer = 'probe'; // left alone by the inert logic
    el.style.cssText = 'position:fixed;inset:0;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)';
    doc.body.append(el); probes.set(doc, el);
  }
  const cs = doc.defaultView.getComputedStyle(el);
  return { top: parseFloat(cs.paddingTop) || 0, right: parseFloat(cs.paddingRight) || 0, bottom: parseFloat(cs.paddingBottom) || 0, left: parseFloat(cs.paddingLeft) || 0 };
}

/** Positions `floating` (position: fixed) against `anchor` and keeps it placed on scroll / resize until cleanup(). */
export function autoPosition(anchor, floating, options = {}) {
  const doc = floating.ownerDocument, win = doc.defaultView;
  let frame = 0, stopped = false, scrolled = 0; // scrolled: the floating element's own scroll position, from its scroll events
  const update = () => {
    frame = 0;
    if (stopped || (!options.point && !anchor.isConnected)) return;
    const vv = win.visualViewport;
    const viewport = { width: vv?.width ?? win.innerWidth, height: vv?.height ?? win.innerHeight };
    // Measuring the natural height clears max-height, which snaps a scrolled floating element to its top: its place is put
    // back afterwards (tracked from scroll events: reading scrollTop here would force an extra layout on every open).
    floating.style.maxHeight = '';
    const base = options.padding ?? 8, safe = safeInsets(doc), at = side => Math.max(typeof base === 'number' ? base : base[side] ?? 8, safe[side]);
    // a persistent bottom bar (--ui-reserve-bottom on the portal, G63): popovers and menus open above it, not over it
    const reserve = parseFloat(win.getComputedStyle(floating).getPropertyValue('--ui-reserve-bottom')) || 0;
    const r = computePosition({ ...options, padding: { top: at('top'), right: at('right'), bottom: Math.max(at('bottom'), reserve ? reserve + 8 : 0), left: at('left') }, anchor: options.point || anchor.getBoundingClientRect(), floating: { width: floating.offsetWidth, height: floating.offsetHeight }, viewport, dir: options.dir || win.getComputedStyle(options.point ? doc.documentElement : anchor).direction });
    floating.style.position = 'fixed';
    floating.style.left = `${r.x}px`; floating.style.top = `${r.y}px`;
    if (options.limitHeight !== false) floating.style.maxHeight = `${r.maxHeight}px`;
    if (scrolled) floating.scrollTop = scrolled;
    floating.dataset.placement = r.placement;
    options.onPlace?.(r);
  };
  const schedule = () => { if (!frame) frame = win.requestAnimationFrame(update); };
  // Scrolling inside the floating element (a long list) does not move its anchor: only outer scrolling repositions.
  const onScroll = e => { if (e.target === floating) scrolled = floating.scrollTop; else if (!floating.contains(e.target)) schedule(); };
  const ro = new win.ResizeObserver(schedule);
  ro.observe(floating); if (!options.point) ro.observe(anchor);
  win.addEventListener('scroll', onScroll, { capture: true, passive: true });
  win.addEventListener('resize', schedule);
  win.visualViewport?.addEventListener('resize', schedule);
  update();
  return {
    update,
    cleanup() { stopped = true; win.cancelAnimationFrame(frame); ro.disconnect(); win.removeEventListener('scroll', onScroll, { capture: true }); win.removeEventListener('resize', schedule); win.visualViewport?.removeEventListener('resize', schedule); },
  };
}
