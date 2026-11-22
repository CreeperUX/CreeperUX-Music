import { focusTarget } from './focus.js';
import { LAYERS } from './tokens.js';

// Overlay manager (M1 infrastructure): one per application root. Owns the portal, the stacking order (z-index from
// the layer tokens), inert backgrounds for modal layers, reference-counted scroll locking, focus trapping and
// restoration, and dismissal (Escape closes only the top layer; outside pointer-down closes dismissible layers that
// opted in). Components open overlays through it instead of positioning and stacking themselves.

const FOCUSABLE = 'a[href],area[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),iframe,[contenteditable="true"],[tabindex]:not([tabindex="-1"])';
// Focus candidates in order; functions are expanded only when every earlier candidate failed (scanning a
// popup's focusables forces layout, so it is skipped when the preferred target takes focus).
function* candidates(...items) { for (const it of items) if (typeof it === 'function') yield* it(); else if (it) yield it; }
export const focusableIn = root => [...root.querySelectorAll(FOCUSABLE)].filter(el => el.getClientRects().length && !el.closest('[inert],[hidden]'));
// foobar2k patch P1 (PATCHES.md): whether a region holds anything focusable, stopping at the first one. Measuring
// every candidate (focusableIn) forced layout of thousands of off-screen rows on each change in a long list.
export const hasFocusableIn = root => { for (const el of root.querySelectorAll(FOCUSABLE)) if (el.getClientRects().length && !el.closest('[inert],[hidden]')) return true; return false; };

export function createOverlayManager({ root = globalThis.document.body, onStackChange } = {}) {
  const doc = root.ownerDocument || root, win = doc.defaultView;
  const portal = doc.createElement('div');
  portal.className = 'cx-ui-portal';
  portal.dataset.cxPortal = '';
  // The portal inherits theme / density / direction from the app root.
  const syncAttrs = () => { for (const a of ['data-theme', 'data-density', 'dir', 'lang', 'data-motion']) { const v = root.getAttribute?.(a); if (v == null) portal.removeAttribute(a); else portal.setAttribute(a, v); } if (root.classList?.contains('cx-ui')) portal.classList.add('cx-ui'); };
  syncAttrs();
  // The portal lives at body level so overlays escape overflow / transform containers; attributes are mirrored.
  doc.body.append(portal);
  const attrObserver = new win.MutationObserver(syncAttrs);
  if (root.nodeType === 1) attrObserver.observe(root, { attributes: true, attributeFilter: ['data-theme', 'data-density', 'dir', 'lang', 'data-motion', 'class'] });
  const stack = [];
  const abort = new AbortController();
  let lock = null, destroyed = false, inertNodes = [];

  // ---- scroll lock (reference counted; scrollbar gutter compensated; restores only what it set)
  function lockScroll() {
    if (lock) { lock.count++; return; }
    const html = doc.documentElement, body = doc.body, gap = Math.max(0, win.innerWidth - html.clientWidth);
    lock = { count: 1, overflow: html.style.overflow, pad: body.style.paddingInlineEnd };
    html.style.overflow = 'hidden';
    // Padding replaces the scrollbar so content does not shift. (scrollbar-gutter: stable was tried: WebKit drops the
    // gutter under overflow: hidden and content moved by the scrollbar width.)
    if (gap) body.style.paddingInlineEnd = `calc(${win.getComputedStyle(body).paddingInlineEnd} + ${gap}px)`;
  }
  function unlockScroll() {
    if (!lock || --lock.count > 0) return;
    doc.documentElement.style.overflow = lock.overflow; doc.body.style.paddingInlineEnd = lock.pad; lock = null;
  }
  // ---- inert background below the top modal layer
  function syncInert() {
    for (const el of inertNodes) el.inert = false;
    inertNodes = [];
    const topModal = [...stack].reverse().find(l => l.modal);
    if (!topModal) return;
    const keep = new Set(stack.filter((l, i) => i >= stack.indexOf(topModal) || l.passive).map(l => l.element));
    for (const el of [...doc.body.children]) {
      if (el === portal || el.dataset.cxAnnouncer != null || el.tagName === 'SCRIPT') continue;
      if (!el.inert) { el.inert = true; inertNodes.push(el); }
    }
    for (const el of portal.children) if (!keep.has(el) && !el.inert) { el.inert = true; inertNodes.push(el); }
  }
  // A modal's background turns inert just after the layer's first paint. Focus is already inside and trapped, and the
  // layer covers the page, while the document-wide restyle that inert costs would otherwise hold back that paint
  // (dialog open latency, G55, D67). Closing updates inert at once.
  let inertFrame = 0, inertTimer = 0;
  function deferInert() {
    if (inertFrame || inertTimer) return;
    inertFrame = win.requestAnimationFrame(() => { inertFrame = 0; inertTimer = win.setTimeout(() => { inertTimer = 0; syncInert(); }, 0); });
  }
  // z-index follows stack order (a menu opened from a dialog sits above it); the layer token is a floor so that
  // toasts and tooltips stay above everything opened earlier.
  function restack(inert = true) { let z = 0; for (const l of stack) { z = Math.max(z + 1, (LAYERS[l.kind] ?? LAYERS.menu) * 10); l.element.style.zIndex = String(z); } if (inert) syncInert(); onStackChange?.(stack.map(l => ({ kind: l.kind, element: l.element }))); }


  /**
   * open(element, { kind: 'menu'|'dialog'|'drawer'|'palette'|'toast'|'tooltip'|..., modal, trigger, initialFocus,
   *   restoreFocus = true, trap = modal, dismissOnOutside = !modal, dismissOnEscape = true, onDismiss(reason), passive })
   * Passive layers (toasts, tooltips) stack above by kind but never take Escape or outside dismissal from the layer
   * below and are never made inert by a modal; they manage their own dismissal. A hidden element is shown here, so
   * open a layer hidden rather than showing it first; a modal's background turns inert after its first paint (D67).
   * Returns a handle { close({ restoreFocus }), element, get isTop }.
   */
  function open(element, opts = {}) {
    if (destroyed) throw new Error('overlay manager destroyed');
    const layer = { element, kind: opts.kind || 'menu', modal: !!opts.modal, trap: opts.trap ?? !!opts.modal, dismissOnOutside: opts.dismissOnOutside ?? !opts.modal, dismissOnEscape: opts.dismissOnEscape ?? true, onDismiss: opts.onDismiss, trigger: opts.trigger || doc.activeElement, restore: opts.restoreFocus ?? true, closed: false, passive: !!opts.passive };
    if (element.hidden) element.hidden = false;
    if (element.parentNode !== portal) portal.append(element);
    stack.push(layer);
    // Focus moves in first: the visibility check in focusTarget forces a layout, and doing it before the scroll lock
    // and the inert background keeps that layout to the new layer. The lock then measures the scrollbar while the
    // layout is still clean (dialog open latency, M6 and G55).
    restack(false);
    if (opts.initialFocus !== false) {
      const target = typeof opts.initialFocus === 'function' ? opts.initialFocus() : opts.initialFocus;
      focusTarget(candidates(target, () => focusableIn(element), element));
    }
    if (layer.modal) { lockScroll(); deferInert(); } else syncInert();
    const handle = {
      element,
      get isTop() { return topActive() === layer; },
      close({ restoreFocus = layer.restore, remove = false } = {}) {
        if (layer.closed) return;
        layer.closed = true;
        const i = stack.indexOf(layer);
        if (i >= 0) stack.splice(i, 1);
        if (layer.modal) unlockScroll();
        restack();
        if (remove) element.remove();
        if (restoreFocus) {
          const active = doc.activeElement;
          if (!active || active === doc.body || element.contains(active) || !active.isConnected) {
            const below = topActive();
            focusTarget(candidates(layer.trigger, () => (below ? focusableIn(below.element).slice(0, 1) : []), below?.element));
          }
        }
      },
    };
    layer.handle = handle;
    return handle;
  }
  const topActive = () => { for (let i = stack.length - 1; i >= 0; i--) if (!stack[i].passive) return stack[i]; return null; };
  // The on-screen keyboard (G36): its height is --cx-keyboard on the portal, so bottom sheets and dialogs sit above it,
  // and a field focused in a layer scrolls back into view when the keyboard opens.
  const vv = win.visualViewport;
  const onViewport = () => {
    const kb = Math.max(0, Math.round(win.innerHeight - vv.height - vv.offsetTop));
    portal.style.setProperty('--cx-keyboard', `${kb}px`);
    const a = doc.activeElement;
    if (kb && a && portal.contains(a) && a.matches('input, textarea, [contenteditable="true"]')) win.requestAnimationFrame(() => a.scrollIntoView?.({ block: 'nearest' }));
  };
  vv?.addEventListener('resize', onViewport, { signal: abort.signal });
  const dismiss = (layer, reason) => { if (layer.onDismiss) layer.onDismiss(reason); else layer.handle.close(); };
  doc.addEventListener('keydown', e => {
    const top = topActive();
    if (!top) return;
    if (e.key === 'Escape' && top.dismissOnEscape && !e.defaultPrevented) { e.preventDefault(); e.stopPropagation(); dismiss(top, 'escape'); return; }
    if (e.key === 'Tab' && top.trap) {
      const items = focusableIn(top.element);
      if (!items.length) { e.preventDefault(); top.element.focus?.(); return; }
      const first = items[0], last = items[items.length - 1], active = doc.activeElement;
      if (e.shiftKey && (active === first || !top.element.contains(active))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (active === last || !top.element.contains(active))) { e.preventDefault(); first.focus(); }
    }
  }, { signal: abort.signal, capture: true });
  doc.addEventListener('pointerdown', e => {
    // Close dismissible layers above the one that was hit (nested menus close back to the clicked level).
    for (let i = stack.length - 1; i >= 0; i--) {
      const l = stack[i];
      if (l.passive) continue;
      if (l.element.contains(e.target) || l.trigger?.contains?.(e.target)) break;
      if (!l.dismissOnOutside) break;
      dismiss(l, 'outside');
    }
  }, { signal: abort.signal, capture: true });

  return {
    open, portal,
    /** Back button of an embedding host (G36): the top layer is dismissed as by Escape (reason 'back'). Returns false
     * when no layer is open, so the host can navigate; true when a layer took it, also when it cannot close now. */
    handleBack() { const top = topActive(); if (!top) return false; if (top.dismissOnEscape) dismiss(top, 'back'); return true; },
    get stack() { return stack.map(l => ({ kind: l.kind, element: l.element, modal: l.modal })); },
    get top() { return topActive()?.element || null; },
    get count() { return stack.length; },
    closeAll() { for (const l of [...stack].reverse()) l.handle.close({ restoreFocus: false }); },
    destroy() {
      if (destroyed) return; destroyed = true;
      win.cancelAnimationFrame(inertFrame); win.clearTimeout(inertTimer);
      for (const l of [...stack].reverse()) l.handle.close({ restoreFocus: false });
      abort.abort(); attrObserver.disconnect();
      for (const el of inertNodes) el.inert = false; inertNodes = [];
      while (lock) unlockScroll();
      portal.remove();
    },
  };
}
