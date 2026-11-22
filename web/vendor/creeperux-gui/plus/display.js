import { setup, fill, uid, h } from '../ui/index.js';
import { plusStrings } from './strings.js';

const docOf = o => o?.doc || globalThis.document;
const TONES = new Set(['neutral', 'info', 'good', 'warn', 'bad', 'accent']);

// ---------------------------------------------------------------- avatar
/**
 * Initials from a name: first and last word. A one-word Han or Hangul name of three or more characters gives its last
 * two (the given name: 王一凡 → 一凡, 김민준 → 민준), shorter ones stay whole; a one-word kana name gives its first two.
 */
export function initials(name = '') {
  const words = String(name).trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  const g = s => [...s];
  if (words.length === 1) {
    const w = g(words[0]);
    if (/^[㐀-鿿가-힯々]+$/.test(words[0])) return (w.length > 2 ? w.slice(-2) : w).join('');
    return (/[぀-ヿ]/.test(words[0]) ? w.slice(0, 2) : w.slice(0, 1)).join('').toUpperCase();
  }
  return (g(words[0])[0] + g(words[words.length - 1])[0]).toUpperCase();
}
/**
 * avatar(name, { src, size: 'sm'|'md'|'lg', status: tone, statusLabel, decorative, doc }) — a picture or initials.
 * Named for assistive tech (role=img) unless decorative (when the name is already written next to it).
 */
export function avatar(name, o = {}) {
  const d = docOf(o);
  const el = h(d, 'span', { class: 'ui-avatar', 'data-size': o.size || 'md', role: o.decorative ? null : 'img', 'aria-label': o.decorative ? null : name, 'aria-hidden': o.decorative ? 'true' : null },
    h(d, 'span', { class: 'ui-avatar-initials', 'aria-hidden': 'true' }, initials(name)));
  if (o.src) {
    const img = h(d, 'img', { src: o.src, alt: '', loading: 'lazy', decoding: 'async' });
    img.addEventListener('error', () => img.remove(), { once: true }); // fall back to the initials
    el.append(img);
  }
  if (o.status && TONES.has(o.status)) el.append(h(d, 'span', { class: 'ui-avatar-status', 'data-tone': o.status, 'aria-hidden': 'true' }));
  if (o.status && o.statusLabel && !o.decorative) el.setAttribute('aria-label', `${name}, ${o.statusLabel}`);
  return el;
}
/** avatarGroup(people: Array<string | { name, src }>, { max = 3, size, services, doc }) — overlapping avatars and "+N". */
export function avatarGroup(people, o = {}) {
  const d = docOf(o), max = o.max ?? 3, shown = people.slice(0, max), rest = people.length - shown.length;
  const name = p => (typeof p === 'string' ? p : p.name);
  const el = h(d, 'span', { class: 'ui-avatar-group', role: 'img', 'aria-label': people.map(name).join(', ') },
    shown.map(p => avatar(name(p), { src: p.src, size: o.size, decorative: true, doc: d })),
    rest > 0 ? h(d, 'span', { class: 'ui-avatar ui-avatar-more', 'data-size': o.size || 'md', 'aria-hidden': 'true' }, `+${rest}`) : null);
  return el;
}

// ---------------------------------------------------------------- stepper
/**
 * createStepper(container, { steps: [{ id, label, description, optional, status: 'error' }], current (index or id),
 *   orientation: 'horizontal'|'vertical', label, onSelect({ id, index }) }, services)
 * An ordered list; the current step has aria-current="step" and every step states its status in text. With onSelect,
 * completed steps are buttons (going back), later steps are not. Narrow containers show "Step n of m · label".
 */
export function createStepper(container, props = {}, services) {
  const c = setup(container, services, 'stepper'); plusStrings(c.s);
  let p = { steps: [], current: 0, orientation: 'horizontal', ...props };
  const compact = c.h('p', { class: 'ui-stepper-compact', 'aria-hidden': 'true' });
  const ol = c.h('ol');
  const el = c.own(c.h('nav', { class: 'ui-stepper' }, compact, ol));
  const indexOf = v => (typeof v === 'number' ? v : Math.max(0, p.steps.findIndex(s => s.id === v)));
  function render() {
    const cur = indexOf(p.current), n = p.steps.length;
    el.dataset.orientation = p.orientation;
    el.setAttribute('aria-label', p.label || c.s.t('stepper.step', { n: c.s.format.number(cur + 1), count: c.s.format.number(n) }));
    compact.textContent = `${c.s.t('stepper.step', { n: c.s.format.number(cur + 1), count: c.s.format.number(n) })} · ${p.steps[cur]?.label ?? ''}`;
    fill(ol, p.steps.map((st, i) => {
      const state = st.status === 'error' ? 'error' : i < cur ? 'done' : i === cur ? 'current' : 'todo';
      const marker = c.h('span', { class: 'ui-step-marker', 'aria-hidden': 'true' }, state === 'done' ? c.icon('check') : state === 'error' ? c.icon('alert') : c.s.format.number(i + 1));
      const text = c.h('span', { class: 'ui-step-text' }, c.h('span', { class: 'ui-step-label' }, st.label),
        st.description || st.optional ? c.h('small', {}, st.description || c.s.t('stepper.optional')) : null,
        state !== 'todo' ? c.h('span', { class: 'ui-visually-hidden' }, `, ${c.s.t(state === 'done' ? 'stepper.done' : state === 'error' ? 'stepper.error' : 'stepper.current')}`) : null);
      const inner = p.onSelect && state === 'done' ? c.h('button', { type: 'button', class: 'ui-step-button', 'data-index': i }, marker, text) : c.h('span', { class: 'ui-step-button' }, marker, text);
      return c.h('li', { class: 'ui-step', 'data-state': state, 'aria-current': state === 'current' ? 'step' : null }, inner);
    }));
  }
  c.on(ol, 'click', e => { const b = e.target.closest('button.ui-step-button'); if (b) { const i = Number(b.dataset.index); c.emit(el, 'select', { id: p.steps[i].id, index: i }, p.onSelect); } });
  render();
  container.append(el);
  return { root: el, update(n) { p = { ...p, ...n }; render(); }, destroy: () => c.destroy() };
}

// ---------------------------------------------------------------- meter and progress ring
const ring = (c, frac, size) => {
  const ns = 'http://www.w3.org/2000/svg', svg = c.doc.createElementNS(ns, 'svg'), r = 15.9155; // circumference 100
  svg.setAttribute('viewBox', '0 0 36 36'); svg.setAttribute('class', 'ui-ring'); svg.setAttribute('aria-hidden', 'true');
  if (size) svg.style.width = svg.style.height = typeof size === 'number' ? `${size}px` : size;
  const track = c.doc.createElementNS(ns, 'circle'), bar = c.doc.createElementNS(ns, 'circle');
  for (const x of [track, bar]) { x.setAttribute('cx', '18'); x.setAttribute('cy', '18'); x.setAttribute('r', String(r)); }
  track.setAttribute('class', 'ui-ring-track'); bar.setAttribute('class', 'ui-ring-bar');
  bar.setAttribute('stroke-dasharray', frac == null ? '25 75' : `${(Math.max(0, Math.min(1, frac)) * 100).toFixed(2)} 100`);
  svg.append(track, bar);
  return svg;
};
/**
 * createMeter(container, { label, value, min = 0, max = 1, low, high, optimum, valueText, variant: 'bar'|'ring', size, hideLabel }, services)
 * A measurement within a known range (role=meter). Tone follows the HTML meter rules: good in the optimum region,
 * warn one region away, bad two regions away.
 */
export function createMeter(container, props = {}, services) {
  const c = setup(container, services, 'meter'); plusStrings(c.s);
  let p = { min: 0, max: 1, variant: 'bar', ...props };
  const id = uid('mtr');
  const el = c.own(c.h('div', { class: 'ui-meter' }));
  function region(v) { const { low = p.min, high = p.max } = p; return v < low ? 0 : v > high ? 2 : 1; }
  function render() {
    const v = Math.min(p.max, Math.max(p.min, Number(p.value) || 0)), frac = (v - p.min) / (p.max - p.min || 1);
    const opt = p.optimum == null ? 1 : region(p.optimum), dist = p.low == null && p.high == null ? 0 : Math.abs(region(v) - opt);
    const tone = dist === 0 ? 'good' : dist === 1 ? 'warn' : 'bad';
    const text = p.valueText ?? c.s.format.percent(frac, 0);
    el.dataset.variant = p.variant; el.dataset.tone = p.low == null && p.high == null ? 'accent' : tone;
    const m = c.h('div', { class: 'ui-meter-track', role: 'meter', 'aria-labelledby': id, 'aria-valuemin': String(p.min), 'aria-valuemax': String(p.max), 'aria-valuenow': String(v), 'aria-valuetext': text },
      p.variant === 'ring' ? [ring(c, frac, p.size), c.h('span', { class: 'ui-ring-value', 'aria-hidden': 'true' }, text)] : c.h('i', { style: `transform:scaleX(${frac})` }));
    fill(el, c.h('div', { class: 'ui-meter-head' }, c.h('span', { id, class: p.hideLabel ? 'ui-visually-hidden' : null }, p.label ?? ''), p.variant === 'bar' ? c.h('span', { class: 'ui-meter-value', 'aria-hidden': 'true' }, text) : null), m);
  }
  render();
  container.append(el);
  return { root: el, update(n) { p = { ...p, ...n }; render(); }, destroy: () => c.destroy() };
}
/** createProgressRing(container, { label, value: 0..1 | null (indeterminate), size, showValue }, services) — compact progress (role=progressbar). */
export function createProgressRing(container, props = {}, services) {
  const c = setup(container, services, 'progress-ring'); plusStrings(c.s);
  let p = { showValue: true, ...props };
  const el = c.own(c.h('span', { class: 'ui-progress-ring', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' }));
  function render() {
    const det = typeof p.value === 'number' && Number.isFinite(p.value), v = det ? Math.max(0, Math.min(1, p.value)) : null;
    el.setAttribute('aria-label', p.label ?? c.s.t('loading'));
    if (det) { el.setAttribute('aria-valuenow', String(Math.round(v * 100))); el.setAttribute('aria-valuetext', c.s.format.percent(v, 0)); } else { el.removeAttribute('aria-valuenow'); el.removeAttribute('aria-valuetext'); }
    el.toggleAttribute('data-indeterminate', !det);
    fill(el, ring(c, v, p.size), det && p.showValue ? c.h('span', { class: 'ui-ring-value', 'aria-hidden': 'true' }, c.s.format.percent(v, 0)) : null);
  }
  render();
  container.append(el);
  return { root: el, update(n) { p = { ...p, ...n }; render(); }, destroy: () => c.destroy() };
}
