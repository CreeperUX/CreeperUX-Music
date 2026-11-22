// Tooltips from labels (GAPS G22). One delegated tooltip per document: an icon-only button shows its accessible name,
// and text cut off by truncate() shows in full. It appears on hover (mouse, pen) after a short delay, on keyboard focus,
// and for cut-off text on tap. Nothing is bound per element, so a table of icon buttons costs nothing extra. A target
// with its own createTooltip is skipped (data-tip="own"); createServices({ tips: false }) turns this off.
// It is decoration, not a layer: it never joins the overlay stack, and it goes as soon as the person does anything
// else (a key, a press, focus elsewhere) or its target leaves the page. WCAG 1.4.13: it can be hovered, and Escape hides
// it without closing the layer below while it belongs to the focused or hovered element.
import { autoPosition } from '../position.js';
import { LAYERS } from '../tokens.js';

const SEL = '.ui-button[data-icon-only][aria-label], .ui-inline-button[aria-label], .ui-truncate';
const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock']);
const cut = t => t.scrollWidth > t.clientWidth + 1 || t.scrollHeight > t.clientHeight + 1;
const docs = new WeakMap();
let lastHide = -Infinity;

/** Installs the shared tooltip for the document of `s` (once; again when the services that installed it are gone). */
export function installTips(s) {
  const doc = s.overlays.portal.ownerDocument, had = docs.get(doc);
  if (s.tips === false || (had && !had.s.destroyed)) return;
  had?.off();
  const win = doc.defaultView, offs = [];
  const el = doc.createElement('div'); el.className = 'ui-tooltip'; el.setAttribute('role', 'tooltip'); el.hidden = true;
  el.style.zIndex = String(LAYERS.tooltip * 10 + 9); // above every layer, without joining the stack
  let target = null, want = null, via = null, pos = null, showT = 0, hideT = 0, watch = 0, ticket = 0;
  const find = node => {
    const t = node?.closest?.(SEL);
    if (!t || t.dataset.tip === 'own') return null;
    if (!t.classList.contains('ui-truncate')) return t;
    if (!cut(t)) return null;
    if (t.title) { t.dataset.full = t.title; t.removeAttribute('title'); } // this tooltip replaces the native one
    return t;
  };
  function show(t, how) {
    win.clearTimeout(showT); win.clearTimeout(hideT); want = null;
    if (s.destroyed) { off(); return; }
    if (t === target) { via = how; return; }
    if (target) hide(true);
    const text = t.classList.contains('ui-truncate') ? t.dataset.full || t.textContent : t.getAttribute('aria-label');
    if (!text || !t.isConnected) return;
    target = t; via = how; ticket++;
    el.textContent = text; el.hidden = false; s.overlays.portal.append(el);
    pos = autoPosition(t, el, { placement: 'top', offset: 6, limitHeight: false });
    s.motion.animate(el, { o: 1 }, { role: 'enter', from: { o: 0 } });
    watch = win.setInterval(() => { if (!target?.isConnected || target.closest('[hidden], [inert]')) hide(true); }, 250);
  }
  function hide(now) {
    win.clearTimeout(showT); win.clearTimeout(hideT); want = null;
    if (!target) return;
    lastHide = win.performance.now();
    win.clearInterval(watch); pos?.cleanup(); pos = null; target = null; via = null;
    const my = ++ticket;
    if (now === true) { el.hidden = true; s.motion.reset(el); el.remove(); return; }
    s.motion.animate(el, { o: 0 }, { role: 'exit' }).then(() => { if (my === ticket && !target) { el.hidden = true; s.motion.reset(el); el.remove(); } });
  }
  const on = (node, type, fn, o) => { node.addEventListener(type, fn, o); offs.push(() => node.removeEventListener(type, fn, o)); };
  const inside = n => n && (el.contains(n) || target?.contains(n) || want?.contains(n));
  on(doc, 'pointerover', e => {
    if (e.pointerType === 'touch') return;
    if (inside(e.target)) { win.clearTimeout(hideT); return; }
    const t = find(e.target);
    if (!t) return;
    win.clearTimeout(showT); want = t;
    const warm = target || win.performance.now() - lastHide < 400; // moving along a row of icon buttons: no second delay
    showT = win.setTimeout(() => show(t, 'hover'), warm ? 0 : 500);
  });
  on(doc, 'pointerout', e => {
    if (e.pointerType === 'touch' || inside(e.relatedTarget)) return;
    win.clearTimeout(showT); want = null;
    if (target && via === 'hover') { win.clearTimeout(hideT); hideT = win.setTimeout(hide, 120); }
  });
  on(doc, 'focusin', e => {
    const t = find(e.target);
    if (!t || t !== e.target) { if (target && !inside(e.target)) hide(); return; } // focus went elsewhere
    let kb; try { kb = t.matches(':focus-visible'); } catch { kb = s.modality?.modality === 'keyboard'; }
    if (kb) show(t, 'focus'); else if (target && target !== t) hide();
  });
  on(doc, 'focusout', e => { if (e.target === target && !el.contains(e.relatedTarget)) hide(); });
  on(doc, 'pointerdown', e => { if (!el.contains(e.target)) hide(true); });
  // A tap on cut-off text shows it in full; the next tap anywhere hides it.
  on(doc, 'pointerup', e => { if (e.pointerType !== 'touch') return; const t = find(e.target); if (t?.classList.contains('ui-truncate')) show(t, 'tap'); });
  // Any key means the person moved on. Escape is kept only while the tooltip belongs to what is focused or hovered.
  on(win, 'keydown', e => {
    if (!target || MODIFIERS.has(e.key)) return;
    if (e.key === 'Escape' && (target.contains(doc.activeElement) || via === 'hover')) { e.preventDefault(); e.stopPropagation(); }
    hide(e.key === 'Escape' ? undefined : true);
  }, { capture: true });
  function off() { hide(true); for (const f of offs) f(); offs.length = 0; el.remove(); if (docs.get(doc)?.s === s) docs.delete(doc); }
  docs.set(doc, { s, off });
}

// Cut-off text is focusable, so keyboard users can reach its tooltip; text that fits is not a Tab stop. One
// ResizeObserver per window; a removed element reports a zero size and is let go.
const observers = new WeakMap();
export function watchCut(span) {
  const win = span.ownerDocument?.defaultView;
  if (!win?.ResizeObserver) return span;
  let ro = observers.get(win);
  if (!ro) {
    ro = new win.ResizeObserver(entries => {
      const seen = entries.map(e => [e.target, e.target.isConnected && cut(e.target)]); // read every size, then write
      for (const [t, on] of seen) { if (!t.isConnected) ro.unobserve(t); if (on) t.tabIndex = 0; else t.removeAttribute('tabindex'); }
    });
    observers.set(win, ro);
  }
  ro.observe(span);
  return span;
}
