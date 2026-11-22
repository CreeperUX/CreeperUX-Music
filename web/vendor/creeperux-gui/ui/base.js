import { getServices } from '../services.js';
import { installTips } from './tips.js';
import { icon } from '../icons.js';

// Shared conventions for every stage 2 component (D31):
//   const c = createX(container, props, services?)  →  { root, update(partialProps), destroy(), focus(), …getters }
// - The host owns values: callbacks (onChange …) propose; components also dispatch bubbling `cx:<event>` events.
// - All user-facing built-in text comes from services.t(); all motion goes through services.motion (quiet roles).
// - destroy() removes only nodes the component created, aborts its listeners and stops its motion. Idempotent.

let seq = 0;
export const uid = (p = 'ui') => `${p}-${(++seq).toString(36)}`;

// Links built from props never run script: javascript:, vbscript: and data: URLs are dropped (the item renders as a
// button or as text instead). URL parsing ignores tabs, newlines and other control characters inside a scheme, so the
// check ignores them too. Relative, fragment, http(s), mailto:, tel: and other schemes pass.
const UNSAFE_URL = /^(?:javascript|vbscript|data):/i;
export function safeHref(href) {
  if (href == null || href === '') return null;
  const s = String(href);
  return UNSAFE_URL.test(s.replace(/[\u0000-\u0020\u007f]+/g, '')) ? null : s;
}

export function h(doc, tag, attrs = {}, ...kids) {
  const el = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'href' && safeHref(v) == null) continue; // backstop for any link built from props
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c.nodeType ? c : doc.createTextNode(String(c)));
  return el;
}

/** replaceChildren() that skips null / false (native replaceChildren would render them as the text "null"). */
export function fill(el, ...kids) { el.replaceChildren(...kids.flat(Infinity).filter(k => k != null && k !== false)); return el; }

/** Component scaffold: services, document, listener lifecycle, event emission, owned nodes. */
export function setup(container, services, name) {
  const s = services || getServices(container);
  installTips(s); // tooltips from labels, once per document (G22)
  const doc = container.ownerDocument, win = doc.defaultView, abort = new AbortController();
  const owned = new Set(), cleanups = new Set();
  let dead = false;
  return {
    s, doc, win, name,
    h: (tag, attrs, ...kids) => h(doc, tag, attrs, ...kids),
    icon: (n, o) => icon(n, { doc, ...o }),
    on(target, type, fn, opts = {}) { target.addEventListener(type, fn, { ...opts, signal: abort.signal }); },
    own(node) { owned.add(node); return node; },
    cleanup(fn) { cleanups.add(fn); return fn; },
    emit(host, type, detail, cb) { if (dead) return; cb?.(detail); host.dispatchEvent(new win.CustomEvent(`cx:${type}`, { detail, bubbles: true, composed: true })); },
    get dead() { return dead; },
    destroy() {
      if (dead) return false;
      dead = true;
      abort.abort();
      for (const fn of cleanups) { try { fn(); } catch { /* keep tearing down */ } }
      for (const n of owned) { s.motion.reset(n); n.remove(); }
      return true;
    },
  };
}

/**
 * Field wrapper: label, required / optional marker, description, error (expands with motion), counter.
 * `box` is the visual control placed in the field; `input` (defaults to box) receives the id and ARIA wiring
 * (aria-describedby / aria-invalid / aria-required). Returns { el, setError, setDescription, setCounter, setLabel, ids }.
 */
const dist = (el, x) => { const r = el.getBoundingClientRect(); return x < r.left ? r.left - x : x > r.right ? x - r.right : 0; };
export function field(ctx, box, { input = box, label, description, error, required, optional, hideLabel, labelFor = true } = {}) {
  const { h, s } = ctx;
  const control = input;
  const id = control.id || (control.id = uid('ctl'));
  const ids = { label: uid('lbl'), desc: uid('dsc'), err: uid('err'), count: uid('cnt') };
  const labelEl = h(labelFor ? 'label' : 'span', { class: 'ui-field-label', id: ids.label, for: labelFor ? id : null });
  const descEl = h('div', { class: 'ui-field-desc', id: ids.desc, hidden: true });
  const errText = h('span');
  const errEl = h('div', { class: 'ui-field-error', id: ids.err, hidden: true }, ctx.icon('alert'), errText);
  const countEl = h('div', { class: 'ui-field-count', id: ids.count, hidden: true, 'aria-live': 'off' });
  const el = h('div', { class: 'ui-field' }, labelEl, box);
  // Taps on the box padding or its hit expansion (::before) focus the nearest input instead of doing nothing.
  if (box !== control) ctx.on(box, 'pointerdown', e => {
    if (e.target !== box || e.button) return;
    const inputs = [...box.querySelectorAll('input:not([type="hidden"]):not([aria-hidden="true"]), textarea, select')].filter(i => !i.disabled);
    const near = inputs.sort((a, b) => dist(a, e.clientX) - dist(b, e.clientX))[0];
    if (near) { e.preventDefault(); near.focus(); }
  });
  let state = { label, description, error: null, required, optional };
  function setLabel(l) {
    state.label = l;
    fill(labelEl, l ?? '', state.required ? h('span', { class: 'ui-req', 'aria-hidden': 'true' }, '*') : null, state.optional ? h('span', { class: 'ui-opt' }, s.t('optional')) : null);
    labelEl.classList.toggle('ui-visually-hidden', !!hideLabel);
  }
  function describedBy() {
    const parts = [];
    if (!descEl.hidden) parts.push(ids.desc);
    if (state.error) parts.push(ids.err);
    if (!countEl.hidden) parts.push(ids.count);
    for (const target of describedTargets) { if (parts.length) target.setAttribute('aria-describedby', parts.join(' ')); else target.removeAttribute('aria-describedby'); }
  }
  const describedTargets = new Set([control]);
  function setDescription(d) { state.description = d; descEl.textContent = d ?? ''; descEl.hidden = !d; describedBy(); }
  let errTicket = 0;
  function setError(msg) {
    const had = !!state.error;
    state.error = msg || null;
    for (const t of describedTargets) { if (msg) t.setAttribute('aria-invalid', 'true'); else t.removeAttribute('aria-invalid'); }
    el.classList.toggle('ui-invalid', !!msg);
    const my = ++errTicket;
    if (msg) {
      errText.textContent = msg; errEl.hidden = false;
      if (!had) s.motion.animate(errEl, { h: errEl.scrollHeight, o: 1 }, { role: 'expand', from: { h: 0, o: 0 }, autoHeight: true });
    } else if (had) {
      s.motion.animate(errEl, { h: 0, o: 0 }, { role: 'exit', from: { h: errEl.offsetHeight } }).then(ok => { if (ok && my === errTicket) { errEl.hidden = true; errText.textContent = ''; s.motion.reset(errEl); errEl.style.height = ''; } });
    }
    describedBy();
  }
  function setCounter(text) { countEl.textContent = text ?? ''; countEl.hidden = text == null; describedBy(); }
  function setRequired(r, o) { state.required = !!r; state.optional = !!o; for (const t of describedTargets) { if (r) t.setAttribute('aria-required', 'true'); else t.removeAttribute('aria-required'); } setLabel(state.label); }
  el.append(descEl, errEl, countEl);
  setRequired(required, optional);
  setDescription(description);
  if (error) setError(error);
  return {
    el, ids, labelEl, setLabel, setDescription, setError, setCounter, setRequired,
    describe(target) { describedTargets.add(target); describedBy(); if (state.error) target.setAttribute('aria-invalid', 'true'); },
    get error() { return state.error; },
  };
}

/** Standard validation from constraint props; returns a message or null. `pattern` (a string, matched whole like the
 * HTML attribute, or a RegExp) and `minLength` are since 2.2.0 (G20). */
export function validateValue(ctx, value, { required, min, max, step, minLength, maxLength, pattern, patternMessage, validate } = {}) {
  const { s } = ctx;
  const empty = value == null || value === '' || (Array.isArray(value) && !value.length);
  if (required && empty) return s.t('field.required');
  if (empty) return null;
  if (typeof value === 'number') {
    if (min != null && value < min) return s.t('field.min', { min: s.format.number(min) });
    if (max != null && value > max) return s.t('field.max', { max: s.format.number(max) });
    if (step && step !== 'any') { const base = min ?? 0, q = (value - base) / step; if (Math.abs(q - Math.round(q)) > 1e-9) return s.t('field.step', { step: s.format.number(step) }); }
  }
  if (typeof value === 'string') {
    const n = [...value].length;
    if (minLength != null && n < minLength) return s.t('field.tooShort', { min: minLength });
    if (maxLength != null && n > maxLength) return s.t('field.tooLong', { max: maxLength });
    if (pattern != null) {
      const re = pattern instanceof RegExp ? pattern : new RegExp(`^(?:${pattern})$`, 'u');
      re.lastIndex = 0; // a global or sticky RegExp keeps its position between calls
      if (!re.test(value)) return patternMessage ?? s.t('field.invalid');
    }
  }
  return validate ? (validate(value) || null) : null;
}
