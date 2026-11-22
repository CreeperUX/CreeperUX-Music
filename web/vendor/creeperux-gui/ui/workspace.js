import { setup, uid } from './base.js';
import { hasFocusableIn } from '../overlay.js'; // foobar2k patch P1 (PATCHES.md)

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const SIDES = ['start', 'end'];
const DEFAULTS = { start: { width: 280, min: 200, max: 480, open: true }, end: { width: 320, min: 240, max: 480, open: true } };

/**
 * createWorkspace(container, { top = true, bottom = true, start: SideProps | false, end: SideProps | false, mainLabel,
 *   bottomLabel, mainMin = 360, narrowBelow = 760, onLayoutChange({ start, end, mode, region, reason }) }, services)
 * SideProps: { label, width, min, max, open, resizable = true }
 * → { root, top, start, main, end, bottom, get layout, open(region, { focus }), close(region), toggle(region),
 *   setWidth(region, px), focusMain(), update, destroy }
 *
 * A desktop application layout (2.5.0, G56): a top bar, a sidebar at each inline edge, the main region and a
 * persistent bottom bar (a player, a status bar). The host fills the regions and gives the container a height (e.g.
 * 100dvh). Each region scrolls on its own, and the bottom bar has its own row, so it never covers content; it also
 * keeps toasts, menus, popovers, sheets and dialogs clear of itself (--ui-reserve-bottom on the portal, G63).
 * Sidebars:
 * - resize by their separator: drag, ← → (16 px, Shift 64 px; mirrored in RTL), Home / End for min / max, Enter
 *   collapses and restores, double-click restores the initial width; Escape during a drag puts the width back;
 * - widths are preferences: when the window is too narrow for both sidebars and `mainMin`, the sidebars give way down
 *   to their `min`, then the end sidebar floats over the main region; below `narrowBelow` both float (`mode`: 'wide',
 *   'medium', 'narrow'). Widening the window brings the preferred widths back. A floating sidebar opens over a scrim,
 *   takes focus, and closes on Escape, a click outside or focus leaving it; focus returns to where it was.
 *   A sidebar holding focus when the window narrows stays open, floating, so focus is never lost;
 * - the host owns persistence: onLayoutChange reports every change (reason 'resize', 'toggle', 'mode', 'escape',
 *   'outside', 'blur'); pass the widths back as `width` next time.
 * F6 and Shift+F6 move focus between the regions. A region that scrolls but holds nothing focusable is a tab stop, so the
 * keyboard can scroll it.
 */
export function createWorkspace(container, props = {}, services) {
  const c = setup(container, services, 'workspace');
  let p = { top: true, bottom: true, mainMin: 360, narrowBelow: 760, ...props };
  const side = k => (p[k] === false ? null : { ...DEFAULTS[k], resizable: true, ...p[k] });
  // pref: the docked state the host and the person chose; float: open as an overlay (medium / narrow)
  const pref = {}, init = {}, floatOpen = { start: false, end: false };
  for (const k of SIDES) { const sd = side(k); pref[k] = { open: !!sd?.open, width: sd?.width ?? DEFAULTS[k].width }; init[k] = pref[k].width; }
  const top = c.h('header', { class: 'ui-ws-top' });
  const main = c.h('main', { class: 'ui-ws-main', tabindex: '-1', id: uid('wsm') });
  const regions = {}, seps = {};
  for (const k of SIDES) {
    regions[k] = c.h('aside', { class: `ui-ws-side ui-ws-${k}`, id: uid(`ws${k[0]}`), tabindex: '-1', 'data-side': k });
    seps[k] = c.h('div', { class: 'ui-ws-sep', role: 'separator', tabindex: '0', 'aria-orientation': 'vertical', 'aria-controls': regions[k].id, 'data-side': k });
  }
  const scrim = c.h('div', { class: 'ui-ws-scrim', hidden: true, 'aria-hidden': 'true' });
  const mid = c.h('div', { class: 'ui-ws-mid' }, regions.start, seps.start, main, seps.end, regions.end, scrim);
  const bottom = c.h('div', { class: 'ui-ws-bottom' });
  const el = c.own(c.h('div', { class: 'ui-ws' }, top, mid, bottom));
  let mode = 'wide', eff = { start: 0, end: 0 }, floating = { start: false, end: false }, opener = { start: null, end: null }, drag = null;
  const leaving = { start: false, end: false }; // a closed floating sidebar still sliding out: shown, inert (D81)
  const rtl = () => c.win.getComputedStyle(el).direction === 'rtl';
  const layout = () => ({ mode, start: { open: isOpen('start'), width: pref.start.width }, end: { open: isOpen('end'), width: pref.end.width } });
  const isOpen = k => !!side(k) && (floating[k] ? floatOpen[k] : pref[k].open);
  const report = (region, reason) => c.emit(el, 'layout-change', { ...layout(), region, reason }, p.onLayoutChange);

  // ---------------------------------------------------------------- layout
  function compute() {
    const W = mid.clientWidth || el.clientWidth;
    if (!W) return;
    const sd = { start: side('start'), end: side('end') };
    const docked = k => sd[k] && !floating[k] && pref[k].open;
    const prev = mode;
    mode = W < p.narrowBelow ? 'narrow' : 'wide';
    const want = k => clamp(pref[k].width, sd[k].min, sd[k].max);
    let fl = { start: mode === 'narrow', end: mode === 'narrow' };
    if (mode === 'wide' && sd.start && sd.end && pref.start.open && pref.end.open) {
      // too narrow for both: give way to the minimums (the end first), then float the end sidebar
      const room = W - p.mainMin, a = want('start'), b = want('end');
      if (a + b > room) {
        const bb = Math.max(sd.end.min, room - a), aa = Math.max(sd.start.min, room - bb);
        if (aa + bb > room) { mode = 'medium'; fl.end = true; }
      }
    }
    // a sidebar that holds focus keeps it: it floats open instead of closing
    for (const k of SIDES) {
      if (!sd[k] || fl[k] === floating[k]) continue;
      const focused = regions[k].contains(c.doc.activeElement);
      if (leaving[k]) { leaving[k] = false; c.s.motion.reset(regions[k]); }
      floating[k] = fl[k];
      floatOpen[k] = fl[k] && focused && pref[k].open;
    }
    let used = 0;
    for (const k of SIDES) if (docked(k)) used += want(k);
    const over = Math.max(0, used - (W - p.mainMin));
    eff.end = docked('end') ? Math.max(sd.end.min, want('end') - over) : 0;
    eff.start = docked('start') ? Math.max(sd.start.min, want('start') - Math.max(0, over - (want('end') - eff.end))) : 0;
    paint();
    if (prev !== mode) report(null, 'mode');
  }
  function paint() {
    el.dataset.mode = mode;
    let anyFloat = false, anyOpen = false;
    for (const k of SIDES) {
      const sd = side(k), r = regions[k], s = seps[k], open = isOpen(k);
      r.hidden = !sd || (!open && !leaving[k]);
      r.inert = !!leaving[k];
      r.toggleAttribute('data-floating', floating[k]);
      if (sd) {
        r.setAttribute('aria-label', sd.label || c.s.t(`workspace.${k}`));
        const w = floating[k] ? clamp(pref[k].width, sd.min, sd.max) : eff[k];
        el.style.setProperty(`--ui-ws-${k}`, `${Math.round(w)}px`);
        s.setAttribute('aria-label', c.s.t('workspace.resize', { label: sd.label || c.s.t(`workspace.${k}`) }));
        s.setAttribute('aria-valuemin', String(sd.min)); s.setAttribute('aria-valuemax', String(sd.max)); s.setAttribute('aria-valuenow', String(Math.round(w)));
      }
      s.hidden = !sd || !open || floating[k] || sd.resizable === false;
      if (floating[k] && (open || leaving[k])) anyFloat = true;
      if (floating[k] && open) anyOpen = true;
    }
    scrim.hidden = !anyFloat;
    scrim.toggleAttribute('data-leaving', anyFloat && !anyOpen); // fading out: clicks go through
    top.hidden = !p.top; bottom.hidden = !p.bottom;
    if (p.mainLabel) main.setAttribute('aria-label', p.mainLabel); else main.removeAttribute('aria-label');
    if (p.bottomLabel) { bottom.setAttribute('role', 'region'); bottom.setAttribute('aria-label', p.bottomLabel); } else { bottom.removeAttribute('role'); bottom.removeAttribute('aria-label'); }
  }
  // the persistent bottom bar: overlays keep clear of it (G63)
  const portal = c.s.overlays.portal;
  function reserve() { portal.style.setProperty('--ui-reserve-bottom', `${p.bottom && bottom.childNodes.length ? bottom.offsetHeight : 0}px`); }

  // ---------------------------------------------------------------- open, close
  function setOpen(k, open, { focus, reason = 'toggle' } = {}) {
    if (!side(k) || isOpen(k) === open) return;
    const r = regions[k], had = c.doc.activeElement;
    if (floating[k]) {
      floatOpen[k] = open;
      const d = (k === 'start') === !rtl() ? -1 : 1, low = c.s.motion.isReduced, m = c.s.motion;
      if (open) {
        opener[k] = had && !r.contains(had) ? had : null;
        const back = leaving[k], scrimFrom = scrim.hidden ? { o: 0 } : scrim.hasAttribute('data-leaving') ? {} : null;
        leaving[k] = false;
        paint();
        // reopened while sliding out: it turns around from where it is
        m.animate(r, low ? { o: 1 } : { x: 0 }, { role: 'push', from: back ? {} : low ? { o: 0 } : { x: d * r.offsetWidth } }).then(ok => { if (ok) m.reset(r); });
        if (scrimFrom) m.animate(scrim, { o: 1 }, { role: 'enter', from: scrimFrom }).then(ok => { if (ok) m.reset(scrim); });
        if (focus !== false) (r.querySelector('[autofocus]') || r).focus({ preventScroll: true });
      } else {
        const inside = r.contains(had);
        if (inside || reason === 'escape') (opener[k]?.isConnected ? opener[k] : main).focus({ preventScroll: true });
        opener[k] = null;
        // it slides back out to its edge (fades under reduced motion), inert, then hides; the scrim fades with it (D81)
        leaving[k] = true;
        paint();
        if (scrim.hasAttribute('data-leaving')) m.animate(scrim, { o: 0 }, { role: 'exit' });
        m.animate(r, low ? { o: 0 } : { x: d * r.offsetWidth }, { role: low ? 'exit' : 'push' }).then(ok => {
          if (!leaving[k]) return; // reopened, or the layout changed under it
          leaving[k] = false; m.reset(r);
          paint();
          if (scrim.hidden) m.reset(scrim);
        });
      }
    } else {
      pref[k].open = open;
      const inside = !open && r.contains(had);
      compute();
      if (inside) (opener[k]?.isConnected ? opener[k] : main).focus({ preventScroll: true });
      if (open) { opener[k] = had && !r.contains(had) ? had : null; if (focus) r.focus({ preventScroll: true }); }
    }
    report(k, reason);
  }
  c.on(scrim, 'pointerdown', e => { e.preventDefault(); for (const k of SIDES) if (floating[k] && floatOpen[k]) setOpen(k, false, { reason: 'outside' }); });
  for (const k of SIDES) {
    c.on(regions[k], 'keydown', e => { if (e.key === 'Escape' && floating[k] && floatOpen[k] && !e.defaultPrevented) { e.preventDefault(); setOpen(k, false, { reason: 'escape' }); } });
    // a floating sidebar is not modal: when focus leaves it (Tab, a click elsewhere) it closes; menus it opened are in the portal
    c.on(regions[k], 'focusout', e => {
      const to = e.relatedTarget;
      if (!floating[k] || !floatOpen[k] || !to || regions[k].contains(to) || portal.contains(to)) return;
      floatOpen[k] = false; opener[k] = null; c.s.motion.reset(regions[k]); paint(); report(k, 'blur');
    });
  }

  // ---------------------------------------------------------------- separators
  const sign = k => ((k === 'start') === !rtl() ? 1 : -1); // + when the pointer moves toward the main region
  function setWidth(k, w, reason = 'resize', emit = true) {
    const sd = side(k); if (!sd) return;
    const before = pref[k].width;
    pref[k].width = Math.round(clamp(w, sd.min, sd.max));
    compute();
    if (emit && pref[k].width !== before) report(k, reason);
  }
  for (const k of SIDES) {
    const s = seps[k];
    c.on(s, 'keydown', e => {
      const sd = side(k); if (!sd) return;
      const step = e.shiftKey ? 64 : 16, dir = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
      if (dir) setWidth(k, eff[k] + dir * step * sign(k)); // the separator moves the way the arrow points
      else if (e.key === 'Home') setWidth(k, sd.min);
      else if (e.key === 'End') setWidth(k, sd.max);
      else if (e.key === 'Enter') { setOpen(k, false); }
      else return;
      e.preventDefault(); e.stopPropagation();
    });
    c.on(s, 'dblclick', () => setWidth(k, init[k]));
    c.on(s, 'pointerdown', e => {
      if (e.button) return;
      e.preventDefault(); s.focus({ preventScroll: true });
      drag = { k, id: e.pointerId, x0: e.clientX, w0: eff[k], before: pref[k].width, last: e.clientX, frame: 0 };
      try { s.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
      s.dataset.active = ''; el.dataset.resizing = '';
    });
    c.on(s, 'pointermove', e => {
      if (!drag || drag.id !== e.pointerId) return;
      drag.last = e.clientX;
      if (!drag.frame) drag.frame = c.win.requestAnimationFrame(() => { if (!drag) return; drag.frame = 0; setWidth(k, drag.w0 + (drag.last - drag.x0) * sign(k), 'resize', false); });
    });
    const end = (e, cancel) => {
      if (!drag || (e.pointerId != null && drag.id !== e.pointerId)) return;
      const d = drag; drag = null; c.win.cancelAnimationFrame(d.frame); delete s.dataset.active; delete el.dataset.resizing;
      if (cancel) setWidth(k, d.before, 'resize', false);
      else { setWidth(k, d.w0 + (e.clientX - d.x0) * sign(k), 'resize', false); if (pref[k].width !== d.before) report(k, 'resize'); }
    };
    c.on(s, 'pointerup', e => end(e, false)); c.on(s, 'pointercancel', e => end(e, true));
    c.on(s, 'keydown', e => { if (e.key === 'Escape' && drag) { e.preventDefault(); e.stopPropagation(); end({ pointerId: drag.id }, true); } }, { capture: true });
  }

  // ---------------------------------------------------------------- F6 between regions
  c.on(el, 'keydown', e => {
    if (e.key !== 'F6' || e.defaultPrevented) return;
    const list = [top, regions.start, main, regions.end, bottom].filter(r => !r.hidden && !r.inert && (r !== top || r.childNodes.length) && (r !== bottom || r.childNodes.length));
    const at = list.findIndex(r => r.contains(c.doc.activeElement));
    const next = list[(at + (e.shiftKey ? -1 : 1) + list.length) % list.length];
    if (!next) return;
    e.preventDefault();
    const target = next === top || next === bottom ? next.querySelector('button:not([disabled]), a[href], input:not([disabled]), [tabindex="0"]') || next : next;
    if (target === next && !next.hasAttribute('tabindex')) next.tabIndex = -1;
    target.focus({ preventScroll: true });
  });

  // A region that scrolls but holds nothing focusable (a timeline, text) becomes a tab stop, so the keyboard can scroll
  // it (WCAG 2.1.1); otherwise it stays focusable by script only (focusMain, F6).
  let scrollFrame = 0;
  function scrollStops() {
    scrollFrame = 0;
    for (const r of [main, regions.start, regions.end]) {
      const stop = !r.hidden && r.scrollHeight > r.clientHeight + 1 && !hasFocusableIn(r); // foobar2k patch P1 (PATCHES.md)
      if (r.tabIndex !== (stop ? 0 : -1)) r.tabIndex = stop ? 0 : -1;
    }
  }
  const queueStops = () => { if (!scrollFrame) scrollFrame = c.win.requestAnimationFrame(scrollStops); };
  let frame = 0;
  const ro = new c.win.ResizeObserver(() => { c.win.cancelAnimationFrame(frame); frame = c.win.requestAnimationFrame(() => { compute(); reserve(); scrollStops(); }); });
  ro.observe(el); ro.observe(bottom);
  const mo = new c.win.MutationObserver(reserve); mo.observe(bottom, { childList: true });
  const content = new c.win.MutationObserver(queueStops);
  for (const r of [main, regions.start, regions.end]) content.observe(r, { childList: true, subtree: true });
  c.cleanup(() => { ro.disconnect(); mo.disconnect(); content.disconnect(); c.win.cancelAnimationFrame(frame); c.win.cancelAnimationFrame(scrollFrame); if (drag) c.win.cancelAnimationFrame(drag.frame); portal.style.removeProperty('--ui-reserve-bottom'); });
  container.append(el);
  paint(); compute(); reserve();
  return {
    root: el, top, main, bottom, start: regions.start, end: regions.end,
    get layout() { return layout(); },
    get mode() { return mode; },
    open: (k, o) => setOpen(k, true, o), close: (k, o) => setOpen(k, false, o), toggle: (k, o) => setOpen(k, !isOpen(k), o),
    setWidth: (k, w) => setWidth(k, w),
    focusMain: () => main.focus({ preventScroll: true }),
    update(n) {
      p = { ...p, ...n };
      for (const k of SIDES) if (k in n && n[k]) { if ('open' in n[k]) pref[k].open = !!n[k].open; if ('width' in n[k]) pref[k].width = n[k].width; }
      compute(); paint(); reserve();
    },
    destroy: () => c.destroy(),
  };
}
