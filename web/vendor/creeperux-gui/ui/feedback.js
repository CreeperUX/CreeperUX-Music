import { setup, fill } from './base.js';
import { createButton } from './controls.js';
import { getServices } from '../services.js';

// M3 feedback (D17): feedback appears first where the action happened; a toast appears only when that place is
// off-screen or gone, or the action can be undone. Success toasts dismiss themselves; failures persist and offer
// Retry; a toast with an action stays until it is handled (G19). No notification centre or history in this stage.

const KIND_ICON = { info: 'info', ok: 'check-circle', warn: 'alert', fail: 'error', bad: 'error', good: 'check-circle' };

// ---------------------------------------------------------------- toaster (one per services)
const toasters = new WeakMap();
/** getToaster(services) → { show(options) → { dismiss(), update(options) }, dismissAll(), get count } */
export function getToaster(services) {
  const s = services || getServices();
  let t = toasters.get(s);
  if (!t || t.dead) { t = createToaster(s); toasters.set(s, t); }
  return t;
}
function createToaster(s) {
  const c = setup(s.overlays.portal, s, 'toaster');
  const region = c.h('section', { class: 'ui-toasts', 'aria-label': s.t('toast.region') });
  const live = new Set();
  let handle = null, paused = false, returnTo = null;
  const now = () => c.win.performance.now();
  function pauseAll(on) { paused = on; for (const t of live) on ? t.pause() : t.resume(); }
  c.on(region, 'pointerenter', () => pauseAll(true));
  c.on(region, 'pointerleave', () => { if (!region.contains(c.doc.activeElement)) pauseAll(false); });
  c.on(region, 'focusin', e => { if (!region.contains(e.relatedTarget)) returnTo = e.relatedTarget; pauseAll(true); });
  c.on(region, 'focusout', e => { if (!region.contains(e.relatedTarget)) pauseAll(false); });
  c.on(c.doc, 'visibilitychange', () => pauseAll(c.doc.hidden));
  function ensureOpen() {
    if (handle) return;
    c.s.overlays.portal.append(region);
    handle = c.s.overlays.open(region, { kind: 'toast', passive: true, initialFocus: false, restoreFocus: false, dismissOnOutside: false, dismissOnEscape: false });
  }
  function maybeClose() { if (!live.size && handle) { handle.close({ restoreFocus: false }); handle = null; region.remove(); } }

  /**
   * show({ kind: 'info'|'ok'|'warn'|'fail', message, detail, undo(), retry(), action: { label, onClick }, duration })
   * Info and ok toasts dismiss themselves after 5 s. Warn and fail toasts, and any toast with an action (undo, retry,
   * action), stay until handled (G19, WCAG 2.2.1: a keyboard or screen-reader user may need longer to reach the
   * action). `duration` overrides both, for an undo window the server enforces for example.
   */
  function show(o = {}) {
    ensureOpen();
    let opts = { kind: 'info', ...o };
    const el = c.h('div', { class: 'ui-toast' });
    const text = c.h('div', { class: 'ui-toast-text' });
    const acts = c.h('div', { class: 'ui-toast-actions' });
    const close = c.h('button', { type: 'button', class: 'ui-button', 'data-variant': 'ghost', 'data-icon-only': '', 'aria-label': s.t('dismiss') }, c.icon('close'));
    el.append(c.h('span', { class: 'ui-toast-icon' }), text, acts, close);
    region.append(el);
    let timer = 0, remaining = 0, started = 0, gone = false, buttons = [];
    const t = {
      pause() { if (!timer) return; c.win.clearTimeout(timer); timer = 0; remaining -= now() - started; },
      resume() { if (timer || gone || !Number.isFinite(remaining)) return; started = now(); timer = c.win.setTimeout(() => t.dismiss('timeout'), Math.max(1200, remaining)); },
      dismiss(reason = 'dismiss') {
        if (gone) return; gone = true;
        c.win.clearTimeout(timer); live.delete(t);
        if (el.contains(c.doc.activeElement)) { const next = [...live].at(-1)?.el.querySelector('button'); (next || (returnTo?.isConnected ? returnTo : null))?.focus({ preventScroll: true }); }
        for (const b of buttons) b.destroy();
        s.motion.animate(el, { o: 0 }, { role: 'exit' })
          .then(() => s.motion.animate(el, { h: 0 }, { role: 'layout', from: { h: el.offsetHeight } }))
          .then(() => { s.motion.reset(el); el.remove(); maybeClose(); });
        opts.onDismiss?.(reason);
      },
      update(n) { opts = { ...opts, ...n }; render(); },
      get el() { return el; },
    };
    function render() {
      el.dataset.kind = opts.kind;
      fill(el.firstChild, c.icon(KIND_ICON[opts.kind] || 'info'));
      fill(text, c.h('span', {}, opts.message ?? ''), opts.detail ? c.h('small', {}, opts.detail) : null);
      for (const b of buttons) b.destroy();
      fill(acts);
      buttons = [];
      const add = (label, fn) => { const b = createButton(acts, { label, variant: 'ghost' }, s); b.element.addEventListener('click', fn); buttons.push(b); };
      if (opts.undo) add(s.t('undo'), () => { t.dismiss('undo'); opts.undo(); });
      if (opts.retry) add(s.t('retry'), () => { t.dismiss('retry'); opts.retry(); });
      if (opts.action) add(opts.action.label, () => { t.dismiss('action'); opts.action.onClick?.(); });
      acts.hidden = !buttons.length;
      const persistent = opts.kind === 'fail' || opts.kind === 'warn' || buttons.length > 0;
      remaining = opts.duration ?? (persistent ? Infinity : 5000);
      c.win.clearTimeout(timer); timer = 0;
      if (!paused) t.resume();
    }
    close.addEventListener('click', () => t.dismiss('close'));
    render();
    live.add(t);
    // Keep at most four; the oldest non-failure goes first.
    if (live.size > 4) ([...live].find(x => x.el.dataset.kind !== 'fail') || [...live][0]).dismiss('overflow');
    s.motion.animate(el, { o: 1, y: 0 }, { role: 'enter', from: { o: 0, y: 4 } });
    s.announce([opts.message, opts.detail].filter(Boolean).join('. '), { politeness: opts.kind === 'fail' ? 'assertive' : 'polite' });
    return t;
  }
  const api = {
    show, get count() { return live.size; }, get region() { return region; }, dead: false,
    dismissAll() { for (const t of [...live]) t.dismiss('api'); },
    destroy() { api.dead = true; for (const t of [...live]) { c.win.clearTimeout(0); live.delete(t); } handle?.close({ restoreFocus: false }); handle = null; region.remove(); c.destroy(); },
  };
  return api;
}
/** toast(options, services) — shorthand for getToaster(services).show(options). */
/** toast({ kind, message, detail, undo, retry, action, duration }, services) — shorthand for getToaster(services).show(); prefer reportFeedback, which announces in place when the source is visible (D17). */
export const toast = (options, services) => getToaster(services).show(options);

const onScreen = el => {
  if (!el?.isConnected || el.closest('[hidden],[inert]')) return false;
  const r = el.getBoundingClientRect(), win = el.ownerDocument.defaultView;
  if (!r.width && !r.height) return false;
  const vis = Math.min(r.bottom, win.innerHeight) - Math.max(r.top, 0);
  return vis >= Math.min(r.height, 24) * 0.5 && r.right > 0 && r.left < win.innerWidth;
};
/**
 * reportFeedback({ source, kind: 'ok'|'fail'|'info'|'warn', message, detail, retry, undo, duration }, services)
 * D17 placement rule. When `source` (the button, field or status line that already shows the result) is on screen and
 * nothing can be undone, the message is only announced and { placement: 'source' } is returned; otherwise a toast is
 * shown and { placement: 'toast', toast } is returned.
 */
export function reportFeedback(o = {}, services) {
  const s = services || getServices(o.source || globalThis.document);
  if (!o.undo && onScreen(o.source)) {
    s.announce([o.message, o.detail].filter(Boolean).join('. '), { politeness: o.kind === 'fail' ? 'assertive' : 'polite' });
    return { placement: 'source' };
  }
  return { placement: 'toast', toast: getToaster(s).show(o) };
}

// ---------------------------------------------------------------- inline alert / banner
/**
 * createInlineAlert(container, { kind: 'info'|'ok'|'warn'|'bad', title, message, actions: [{ label, variant, onClick }],
 *   dismissible, onDismiss, live: false|'polite'|'assertive' }, services)
 * Actions sit at the end on wide containers and wrap below the text on narrow ones.
 */
export function createInlineAlert(container, props = {}, services) {
  const c = setup(container, services, 'inline-alert');
  let p = { kind: 'info', ...props };
  const el = c.own(c.h('div', { class: 'ui-alert' }));
  let buttons = [];
  function render() {
    el.dataset.kind = p.kind;
    if (p.live === 'assertive') el.setAttribute('role', 'alert'); else if (p.live) el.setAttribute('role', 'status'); else el.removeAttribute('role');
    for (const b of buttons) b.destroy();
    buttons = [];
    const acts = c.h('div', { class: 'ui-alert-actions' });
    for (const a of p.actions || []) { const b = createButton(acts, { label: a.label, variant: a.variant || 'secondary' }, c.s); b.element.addEventListener('click', () => a.onClick?.()); buttons.push(b); }
    const dismiss = p.dismissible ? c.h('button', { type: 'button', class: 'ui-button ui-alert-dismiss', 'data-variant': 'ghost', 'data-icon-only': '', 'aria-label': c.s.t('dismiss') }, c.icon('close')) : null;
    dismiss?.addEventListener('click', () => { c.emit(el, 'dismiss', {}, p.onDismiss); });
    fill(el, c.h('span', { class: 'ui-alert-icon' }, c.icon(KIND_ICON[p.kind] || 'info')),
      c.h('div', { class: 'ui-alert-text' }, p.title ? c.h('strong', {}, p.title) : null, p.message ? c.h('span', {}, p.message) : null),
      buttons.length ? acts : null, dismiss);
  }
  render();
  container.append(el);
  c.cleanup(() => { for (const b of buttons) b.destroy(); });
  return { root: el, update(n) { p = { ...p, ...n }; render(); }, destroy: () => c.destroy() };
}

// ---------------------------------------------------------------- progress, spinner, skeleton
/**
 * createProgress(container, { label, value: 0..1 | null (indeterminate), showValue = true, valueText, hideLabel }, services)
 */
export function createProgress(container, props = {}, services) {
  const c = setup(container, services, 'progress');
  let p = { showValue: true, ...props };
  const labelId = `${c.name}-${Math.random().toString(36).slice(2, 8)}`;
  const label = c.h('span', { class: 'ui-progress-label', id: labelId });
  const value = c.h('span', { class: 'ui-progress-value' });
  const bar = c.h('i');
  const track = c.h('div', { class: 'ui-progress', role: 'progressbar', 'aria-labelledby': labelId, 'aria-valuemin': '0', 'aria-valuemax': '100' }, bar);
  const el = c.own(c.h('div', { class: 'ui-progress-field' }, c.h('div', { class: 'ui-progress-head' }, label, value), track));
  function render() {
    label.textContent = p.label ?? c.s.t('loading');
    label.classList.toggle('ui-visually-hidden', !!p.hideLabel);
    const det = typeof p.value === 'number' && Number.isFinite(p.value);
    track.toggleAttribute('data-indeterminate', !det);
    if (det) {
      const v = Math.min(1, Math.max(0, p.value)), text = p.valueText ?? c.s.format.percent(v, 0);
      track.setAttribute('aria-valuenow', String(Math.round(v * 100))); track.setAttribute('aria-valuetext', text);
      bar.style.transform = `scaleX(${v})`; value.textContent = p.showValue ? text : '';
    } else { track.removeAttribute('aria-valuenow'); track.removeAttribute('aria-valuetext'); bar.style.transform = ''; value.textContent = ''; }
  }
  render();
  container.append(el);
  return { root: el, update(n) { p = { ...p, ...n }; render(); }, destroy: () => c.destroy() };
}

/** createSpinner(container, { label, size: 'sm'|'md'|'lg' }) — role=status with a visually hidden label (default "Loading…"). */
export function createSpinner(container, props = {}, services) {
  const c = setup(container, services, 'spinner');
  let p = { size: 'md', ...props };
  const text = c.h('span', { class: 'ui-visually-hidden' });
  const el = c.own(c.h('span', { class: 'ui-spinner-wrap', role: 'status' }, c.h('span', { class: 'ui-spinner', 'aria-hidden': 'true' }), text));
  const render = () => { el.dataset.size = p.size; text.textContent = p.label ?? c.s.t('loading'); };
  render();
  container.append(el);
  return { root: el, update(n) { p = { ...p, ...n }; render(); }, destroy: () => c.destroy() };
}

/**
 * createSkeleton(container, { lines = 3, avatar = false, block: height }) — decorative placeholder (aria-hidden). The host
 * marks the loading region with aria-busy and announces completion; the pulse stops under reduced motion.
 */
export function createSkeleton(container, props = {}, services) {
  const c = setup(container, services, 'skeleton');
  let p = { lines: 3, ...props };
  const el = c.own(c.h('div', { class: 'ui-skeleton', 'aria-hidden': 'true' }));
  function render() {
    fill(el,
      p.avatar ? c.h('span', { class: 'ui-skeleton-avatar' }) : null,
      p.block ? c.h('span', { class: 'ui-skeleton-block', style: `height:${typeof p.block === 'number' ? `${p.block}px` : p.block}` }) : null,
      c.h('span', { class: 'ui-skeleton-lines' }, Array.from({ length: p.lines }, (_, i) => c.h('span', { class: 'ui-skeleton-line', style: i === p.lines - 1 && p.lines > 1 ? 'width:62%' : null }))));
  }
  render();
  container.append(el);
  return { root: el, update(n) { p = { ...p, ...n }; render(); }, destroy: () => c.destroy() };
}
