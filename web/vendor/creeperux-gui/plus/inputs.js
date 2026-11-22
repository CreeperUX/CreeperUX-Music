import { setup, fill, uid, field, tag, createFileDrop, createPopover, dirOf, pendingValue, createButton, createNumberField, createSheet, autoPosition } from '../ui/index.js';
import { plusStrings } from './strings.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const rtlOf = el => el.ownerDocument.defaultView.getComputedStyle(el).direction === 'rtl';

// ---------------------------------------------------------------- slider / range slider
/**
 * createSlider(container, { label, value: number | [low, high] | null, min = 0, max = 100, step = 1, largeStep, marks: [{ value, label }],
 *   orientation = 'horizontal' | 'vertical', format(v), description, hideLabel, disabled, readOnly, onInput({ value }),
 *   onChange({ value }), onCancel({ value }) }, services)
 * APG slider (a range has two thumbs that cannot cross). Arrows ±step (mirrored in RTL when horizontal), PageUp / PageDown
 * ±largeStep, Home / End. Dragging follows the pointer directly; keyboard changes are instant (D13). Thumbs have 44 px hit
 * areas. Since 2.2.0 (G24): Escape or a cancelled pointer (the page scrolled instead) puts back the value from before the
 * drag and calls onCancel; `value: null` is unknown ("Not set"), not the minimum; values snap to min + k·step, so the
 * highest is the last step that fits (0–100 in steps of 60 ends at 60); a horizontal slider leaves vertical page
 * scrolling to the page, and a vertical one horizontal scrolling.
 * Since 2.5.0, for values the host keeps changing, such as a playback position or a volume another device sets (G59):
 * - a pointer drag runs drag start (`onDragStart`), preview (`onInput`, every move), then commit (`onChange`, once, on
 *   release) or cancel (`onCancel`: Escape, or the pointer taken away); `dragging` says whether one is under way;
 * - `update({ value })` during a drag is held, not shown: the thumb stays under the pointer. A commit wins over held
 *   values (the host confirms it with its next update); a cancel shows the latest held value, or the value from before;
 * - `keyStep`: what an arrow key adds (default `step`), for values that snap finely but move in larger steps (5 s of
 *   a track that snaps to seconds);
 * - `valueText(v)` is what assistive technology reads (`format(v)` stays the visible text), and `valueTextInterval` (ms)
 *   limits how often host updates change that reading while the slider has focus, so a playing track does not talk over
 *   the user; changes the user makes are read at once.
 */
export function createSlider(container, props = {}, services) {
  const c = setup(container, services, 'slider'); plusStrings(c.s);
  let p = { min: 0, max: 100, step: 1, ...props };
  let held, heldSet = false, spokeAt = 0, spokeT = 0; // a value from the host during a drag (G59); last reading change
  const range = () => Array.isArray(p.value);
  const track = c.h('div', { class: 'ui-slider-track' }), fillEl = c.h('div', { class: 'ui-slider-fill' });
  const thumbs = [c.h('div', { class: 'ui-slider-thumb', role: 'slider', tabindex: '0' }), c.h('div', { class: 'ui-slider-thumb', role: 'slider', tabindex: '0' })];
  const marksEl = c.h('div', { class: 'ui-slider-marks', 'aria-hidden': 'true' });
  const out = c.h('output', { class: 'ui-slider-value', 'aria-hidden': 'true' });
  const box = c.h('div', { class: 'ui-slider' }, track, fillEl, thumbs[0], thumbs[1], marksEl);
  const f = field(c, box, { input: thumbs[0], label: p.label, description: p.description, hideLabel: p.hideLabel, labelFor: false });
  f.labelEl.append(out);
  const el = c.own(f.el);
  el.classList.add('ui-slider-field');
  const fmt = v => (p.format ? p.format(v) : c.s.format.number(v));
  const said = v => (p.valueText ? p.valueText(v) : fmt(v));
  // With an action a committed value shows at once and the field says how saving went (G16).
  const pend = pendingValue(c, { place: x => el.append(x), busy: box, apply: v => { p.value = v; read(); render(); committed = JSON.stringify(v); }, current: () => p.value });
  let committed = JSON.stringify(p.value);
  const stepOf = () => (p.step === 'any' ? 0 : p.step);
  const top = () => { const s = stepOf(); return s ? +(p.min + Math.floor((p.max - p.min) / s + 1e-9) * s).toFixed(10) : p.max; }; // the last legal value
  const snap = v => { const s = stepOf(); const x = s ? Math.round((v - p.min) / s) * s + p.min : v; return clamp(+x.toFixed(10), p.min, top()); };
  const pct = v => ((v - p.min) / (p.max - p.min || 1)) * 100;
  const vertical = () => p.orientation === 'vertical';
  const unknown = () => !range() && (p.value === null || Number.isNaN(p.value)); // shown as unknown, never as the minimum
  let vals = [], dragging = -1, before = null;
  function read() { vals = range() ? [...p.value] : [unknown() ? p.min : p.value ?? p.min]; vals = vals.map(snap); if (vals.length === 2 && vals[0] > vals[1]) vals.reverse(); }
  // host: the change came from update(), not from the user; a focused slider then changes its reading at most every
  // valueTextInterval ms (the visible position always follows)
  function render(host = false) {
    const gone = unknown();
    box.toggleAttribute('data-range', range());
    box.dataset.orientation = vertical() ? 'vertical' : 'horizontal';
    box.toggleAttribute('data-unknown', gone); box.toggleAttribute('data-readonly', !!p.readOnly);
    thumbs[1].hidden = !range();
    const now = c.win.performance.now(), wait = host && p.valueTextInterval && thumbs.includes(c.doc.activeElement) ? p.valueTextInterval - (now - spokeAt) : 0;
    c.win.clearTimeout(spokeT);
    if (wait > 0) spokeT = c.win.setTimeout(() => render(), wait); else spokeAt = now;
    vals.forEach((v, i) => {
      const t = thumbs[i];
      t.style.setProperty('--ui-pos', `${pct(v)}%`);
      t.setAttribute('aria-valuemin', String(range() && i === 1 ? vals[0] : p.min));
      t.setAttribute('aria-valuemax', String(range() && i === 0 ? vals[1] : top()));
      if (wait > 0) { /* the reading changes when the interval is up */ }
      else if (gone) { t.removeAttribute('aria-valuenow'); t.setAttribute('aria-valuetext', c.s.t('slider.unknown')); }
      else { t.setAttribute('aria-valuenow', String(v)); t.setAttribute('aria-valuetext', said(v)); }
      if (vertical()) t.setAttribute('aria-orientation', 'vertical'); else t.removeAttribute('aria-orientation');
      if (p.readOnly) t.setAttribute('aria-readonly', 'true'); else t.removeAttribute('aria-readonly');
      t.setAttribute('aria-labelledby', f.labelEl.id || (f.labelEl.id = uid('sl')));
      if (range()) { t.removeAttribute('aria-labelledby'); t.setAttribute('aria-label', `${p.label ?? ''} ${c.s.t(i ? 'slider.max' : 'slider.min')}`.trim()); }
      if (p.disabled) t.setAttribute('aria-disabled', 'true'); else t.removeAttribute('aria-disabled');
      t.tabIndex = p.disabled ? -1 : 0;
    });
    const a = range() ? pct(vals[0]) : 0, b = gone ? 0 : pct(vals[range() ? 1 : 0]);
    for (const k of ['insetInlineStart', 'inlineSize', 'bottom', 'height']) fillEl.style[k] = '';
    if (vertical()) { fillEl.style.bottom = `${a}%`; fillEl.style.height = `${b - a}%`; } else { fillEl.style.insetInlineStart = `${a}%`; fillEl.style.inlineSize = `${b - a}%`; }
    out.textContent = gone ? c.s.t('slider.unknown') : range() ? `${fmt(vals[0])} – ${fmt(vals[1])}` : fmt(vals[0]);
    fill(marksEl, (p.marks || []).map(m => c.h('span', { style: `--ui-pos:${pct(m.value)}%`, 'data-edge': pct(m.value) <= 0 ? 'start' : pct(m.value) >= 100 ? 'end' : null, 'data-on': (range() ? m.value >= vals[0] && m.value <= vals[1] : m.value <= vals[0]) ? '' : null }, m.label ?? '')));
    box.toggleAttribute('data-disabled', !!p.disabled);
  }
  function set(i, v, commit) {
    v = snap(v);
    if (range()) v = i === 0 ? Math.min(v, vals[1]) : Math.max(v, vals[0]);
    if (v === vals[i] && !commit && !unknown()) return;
    vals[i] = v;
    const value = range() ? [...vals] : vals[0];
    p.value = value; render(); // the value first: a slider leaving "unknown" draws as known
    c.emit(el, commit ? 'change' : 'input', { value }, commit ? p.onChange : p.onInput);
    if (!commit || JSON.stringify(value) === committed) return;
    committed = JSON.stringify(value);
    if (p.action) pend.get().run(value, p.action); else pend.sync(value);
  }
  const valueAt = e => {
    const r = track.getBoundingClientRect();
    let frac = vertical() ? (r.bottom - e.clientY) / (r.height || 1) : (e.clientX - r.left) / (r.width || 1);
    if (!vertical() && rtlOf(box)) frac = 1 - frac;
    return p.min + clamp(frac, 0, 1) * (p.max - p.min);
  };
  // A cancelled drag (Escape, or the pointer taken by page scrolling) puts back the values from before it (G24), or the
  // latest value the host sent while it ran (G59).
  function cancel() {
    if (dragging < 0) return;
    dragging = -1; delete box.dataset.dragging;
    const back = heldSet ? held : before.value; heldSet = false; held = undefined;
    if (JSON.stringify(p.value) !== JSON.stringify(back)) { p.value = back; read(); render(); c.emit(el, 'input', { value: p.value }, p.onInput); }
    committed = JSON.stringify(p.value); pend.sync(p.value);
    c.emit(el, 'cancel', { value: p.value }, p.onCancel);
  }
  c.on(box, 'pointerdown', e => {
    if (p.disabled || p.readOnly || e.button) return;
    before = { vals: [...vals], value: p.value };
    const v = valueAt(e);
    dragging = range() ? (Math.abs(v - vals[0]) <= Math.abs(v - vals[1]) ? (v > vals[1] ? 1 : 0) : 1) : 0;
    if (range() && vals[0] === vals[1]) dragging = v > vals[0] ? 1 : 0;
    try { box.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    thumbs[dragging].focus({ preventScroll: true });
    box.dataset.dragging = '';
    c.emit(el, 'drag-start', { value: p.value }, p.onDragStart);
    set(dragging, v, false);
    e.preventDefault();
  });
  c.on(box, 'pointermove', e => { if (dragging >= 0) set(dragging, valueAt(e), false); });
  const end = () => { if (dragging < 0) return; const i = dragging; dragging = -1; heldSet = false; held = undefined; delete box.dataset.dragging; set(i, vals[i], true); };
  c.on(box, 'pointerup', end); c.on(box, 'pointercancel', cancel); c.on(box, 'lostpointercapture', cancel);
  thumbs.forEach((t, i) => c.on(t, 'keydown', e => {
    if (e.key === 'Escape' && dragging >= 0) { e.preventDefault(); e.stopPropagation(); cancel(); return; }
    if (p.disabled || p.readOnly) return;
    const s = p.keyStep ?? (p.step === 'any' ? (p.max - p.min) / 100 : p.step), big = p.largeStep ?? Math.max(s, (p.max - p.min) / 10), rtl = !vertical() && rtlOf(box);
    const d = { ArrowRight: rtl ? -s : s, ArrowLeft: rtl ? s : -s, ArrowUp: s, ArrowDown: -s, PageUp: big, PageDown: -big }[e.key];
    if (d != null) { e.preventDefault(); set(i, unknown() ? (d > 0 ? p.min : top()) : vals[i] + d, true); } // from unknown, the first key picks an end
    else if (e.key === 'Home') { e.preventDefault(); set(i, range() && i === 1 ? vals[0] : p.min, true); }
    else if (e.key === 'End') { e.preventDefault(); set(i, range() && i === 0 ? vals[1] : top(), true); }
  }));
  read(); render();
  c.cleanup(() => c.win.clearTimeout(spokeT));
  container.append(el);
  return {
    root: el, get value() { return p.value; }, get state() { return pend.state; }, get dragging() { return dragging >= 0; }, observe: pend.observe,
    update(n) {
      if ('value' in n && dragging >= 0) { ({ value: held, ...n } = n); heldSet = true; } // held until the drag ends (G59)
      p = { ...p, ...n };
      if ('value' in n) { pend.sync(p.value); committed = JSON.stringify(p.value); }
      if ('value' in n || 'min' in n || 'max' in n || 'step' in n) read();
      f.setLabel(p.label); f.labelEl.append(out); render('value' in n && Object.keys(n).length === 1); // only a bare value is a host update to pace
    },
    focus: () => thumbs[0].focus(), destroy: () => c.destroy(),
  };
}

// ---------------------------------------------------------------- segmented time input
/**
 * createTimeInput(container, { label, value: 'HH:MM' | 'HH:MM:SS' | null, seconds, hour12 (default from locale), step (minutes, for the
 *   picker), picker = true, required, readOnly, disabled, description, hideLabel, onChange({ value }) }, services)
 * Segments are spinbuttons (hours, minutes, optional seconds and AM/PM in the locale's order). Type digits (auto-advance),
 * ↑ ↓ change with wrap, Backspace clears. The clock button opens a list of times at `step` minutes. Value is 24-hour text.
 */
export function createTimeInput(container, props = {}, services) {
  const c = setup(container, services, 'time-input'); plusStrings(c.s);
  let p = { step: 30, picker: true, ...props };
  const loc = () => c.s.i18n.locale;
  const h12 = () => p.hour12 ?? new Intl.DateTimeFormat(loc(), { hour: 'numeric' }).resolvedOptions().hourCycle?.startsWith('h1');
  const dayPeriods = () => { const f = new Intl.DateTimeFormat(loc(), { hour: 'numeric', hour12: true }); const g = d => f.formatToParts(new Date(2026, 0, 1, d)).find(x => x.type === 'dayPeriod')?.value || (d < 12 ? 'AM' : 'PM'); return [g(9), g(15)]; };
  const periodFirst = () => { const parts = new Intl.DateTimeFormat(loc(), { hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(new Date(2026, 0, 1, 9, 30)).map(x => x.type); return parts.indexOf('dayPeriod') < parts.indexOf('hour'); };
  const segs = { h: c.h('span', { class: 'ui-time-seg', role: 'spinbutton', tabindex: '0', inputmode: 'numeric' }), m: c.h('span', { class: 'ui-time-seg', role: 'spinbutton', tabindex: '0', inputmode: 'numeric' }), s: c.h('span', { class: 'ui-time-seg', role: 'spinbutton', tabindex: '0', inputmode: 'numeric' }), a: c.h('span', { class: 'ui-time-seg', role: 'spinbutton', tabindex: '0' }) };
  const fieldsBox = c.h('span', { class: 'ui-time-segs', role: 'group', dir: 'ltr' });
  const pickBtn = c.h('button', { type: 'button', class: 'ui-inline-button' }, c.icon('clock'));
  const box = c.h('div', { class: 'ui-input ui-time-input' }, fieldsBox, pickBtn);
  const f = field(c, box, { input: fieldsBox, label: p.label, description: p.description, required: p.required, hideLabel: p.hideLabel, labelFor: false });
  fieldsBox.setAttribute('aria-labelledby', f.labelEl.id || (f.labelEl.id = uid('ti')));
  fieldsBox.removeAttribute('aria-required'); // not allowed on role=group; set on each spinbutton in render()
  const el = c.own(f.el);
  let v = { h: null, m: null, s: null }, buffer = '', pop = null, builtOrder = '';
  const parse = t => { const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(t || ''); return m ? { h: +m[1], m: +m[2], s: m[3] != null ? +m[3] : 0 } : { h: null, m: null, s: null }; };
  const pad = n => String(n).padStart(2, '0');
  const value = () => (v.h == null || v.m == null || (p.seconds && v.s == null) ? null : `${pad(v.h)}:${pad(v.m)}${p.seconds ? `:${pad(v.s ?? 0)}` : ''}`);
  function render() {
    const twelve = h12(), [am, pm] = dayPeriods();
    const order = [...(twelve && periodFirst() ? ['a'] : []), 'h', 'm', ...(p.seconds ? ['s'] : []), ...(twelve && !periodFirst() ? ['a'] : [])];
    // Rebuild the row only when the segment order changes: moving a focused segment would blur it mid-typing.
    if (order.join() !== builtOrder) {
      builtOrder = order.join();
      const sep = () => c.h('span', { class: 'ui-time-sep', 'aria-hidden': 'true' }, ':');
      const kids = [];
      order.forEach((k, i) => { if (i && k !== 'a' && order[i - 1] !== 'a') kids.push(sep()); else if (i) kids.push(c.h('span', { class: 'ui-time-gap' })); segs[k].dataset.k = k; kids.push(segs[k]); });
      fill(fieldsBox, kids);
      fieldsBox.toggleAttribute('data-period-start', twelve && !periodFirst() && dirOf(loc()) === 'rtl');
    }
    const hv = v.h == null ? null : twelve ? ((v.h + 11) % 12) + 1 : v.h;
    const set = (el2, label, now, min, max, text) => { el2.setAttribute('aria-label', label); el2.setAttribute('aria-valuemin', String(min)); el2.setAttribute('aria-valuemax', String(max)); if (now == null) { el2.removeAttribute('aria-valuenow'); el2.setAttribute('aria-valuetext', '—'); } else { el2.setAttribute('aria-valuenow', String(now)); el2.setAttribute('aria-valuetext', text); } el2.textContent = now == null ? '––' : text; };
    set(segs.h, c.s.t('time.hours'), hv, twelve ? 1 : 0, twelve ? 12 : 23, hv == null ? '' : twelve ? String(hv) : pad(hv));
    set(segs.m, c.s.t('time.minutes'), v.m, 0, 59, v.m == null ? '' : pad(v.m));
    set(segs.s, c.s.t('time.seconds'), v.s, 0, 59, v.s == null ? '' : pad(v.s));
    const per = v.h == null ? null : v.h >= 12 ? 1 : 0;
    set(segs.a, c.s.t('time.period'), per, 0, 1, per == null ? '' : per ? pm : am);
    for (const k of ['h', 'm', 's', 'a']) {
      if (p.required) segs[k].setAttribute('aria-required', 'true'); else segs[k].removeAttribute('aria-required');
      // read-only segments stay focusable and readable; disabled ones leave the Tab order (G21)
      if (p.readOnly) segs[k].setAttribute('aria-readonly', 'true'); else segs[k].removeAttribute('aria-readonly');
      if (p.disabled) segs[k].setAttribute('aria-disabled', 'true'); else segs[k].removeAttribute('aria-disabled');
      segs[k].tabIndex = p.disabled ? -1 : 0;
    }
    pickBtn.disabled = !!(p.disabled || p.readOnly);
    box.toggleAttribute('data-disabled', !!p.disabled); box.toggleAttribute('data-readonly', !!p.readOnly);
    if (per == null) segs.a.textContent = `${am}`;
    segs.a.toggleAttribute('data-placeholder', per == null);
    pickBtn.hidden = !p.picker; pickBtn.setAttribute('aria-label', `${p.label ?? ''} ${c.s.t('time.hours')}`.trim());
  }
  function commit() { render(); c.emit(el, 'change', { value: value() }, p.onChange); }
  const keyOf = seg => Object.keys(segs).find(k => segs[k] === seg);
  function step(k, d) {
    if (k === 'a') { v.h = v.h == null ? (d > 0 ? 12 : 0) : (v.h + 12) % 24; }
    else { const max = k === 'h' ? 24 : 60; v[k] = v[k] == null ? (d > 0 ? 0 : max - 1) : (v[k] + d + max) % max; if (k !== 'h' && v.h == null) v.h = 0; if (k === 'h' && v.m == null) v.m = 0; }
    commit();
  }
  function next(seg) { const list = [...fieldsBox.querySelectorAll('.ui-time-seg')]; list[list.indexOf(seg) + 1]?.focus(); }
  c.on(fieldsBox, 'keydown', e => {
    const seg = e.target.closest('.ui-time-seg'); if (!seg) return;
    const k = keyOf(seg);
    if ((p.readOnly || p.disabled) && e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return; // moving between segments still works
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); buffer = ''; step(k, e.key === 'ArrowUp' ? 1 : -1); }
    else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); const list = [...fieldsBox.querySelectorAll('.ui-time-seg')].sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left); list[list.indexOf(seg) + (e.key === 'ArrowRight' ? 1 : -1)]?.focus(); } // by position on screen
    else if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); buffer = ''; if (k === 'a') return; v[k] = null; commit(); }
    else if (k === 'a' && /^[a-z]$/i.test(e.key)) { e.preventDefault(); const [am, pm] = dayPeriods(); const want = pm.toLowerCase().startsWith(e.key.toLowerCase()) && !am.toLowerCase().startsWith(e.key.toLowerCase()) ? 1 : am.toLowerCase().startsWith(e.key.toLowerCase()) ? 0 : null; if (want != null) { if (v.h == null) v.h = want ? 12 : 0; else if ((v.h >= 12) !== !!want) v.h = (v.h + 12) % 24; commit(); } }
    else if (/^\d$/.test(e.key) && k !== 'a') {
      e.preventDefault();
      buffer += e.key;
      const twelve = h12(), max = k === 'h' ? (twelve ? 12 : 23) : 59, n = +buffer;
      let val = n;
      if (k === 'h' && twelve) { const pm = v.h != null && v.h >= 12; val = (n % 12) + (pm ? 12 : 0); if (n === 0) { buffer = '0'; return; } }
      if (k === 'h' && !twelve) val = n;
      if (n > max) { buffer = e.key; val = +e.key; }
      v[k] = clamp(val, 0, k === 'h' ? 23 : 59);
      if (k === 'h' && v.m == null) v.m = 0;
      commit();
      if (buffer.length >= 2 || n * 10 > max) { buffer = ''; next(seg); }
    }
  });
  c.on(fieldsBox, 'focusout', () => { buffer = ''; });
  // picker: a list of times at `step` minutes in a popover
  if (p.picker) {
    pop = createPopover(pickBtn, { label: p.label, placement: 'bottom-end', content: body => {
      const list = c.h('div', { class: 'ui-time-list', role: 'listbox', 'aria-label': p.label || '' });
      const fmtT = (hh, mm) => c.s.format.time(new Date(2026, 0, 1, hh, mm), { hour: 'numeric', minute: '2-digit', hour12: h12() });
      for (let t = 0; t < 24 * 60; t += p.step) { const hh = Math.floor(t / 60), mm = t % 60; const o = c.h('button', { type: 'button', class: 'ui-time-option', role: 'option', 'data-t': `${hh}:${mm}` }, fmtT(hh, mm)); list.append(o); }
      list.addEventListener('click', e => { const o = e.target.closest('.ui-time-option'); if (!o) return; const [hh, mm] = o.dataset.t.split(':').map(Number); v = { h: hh, m: mm, s: 0 }; commit(); pop.close(); });
      body.append(list);
    }, initialFocus: () => { const cur = value() && fieldsBox.ownerDocument.querySelector(`.ui-time-option[data-t="${v.h}:${Math.round(v.m / p.step) * p.step % 60}"]`); return cur || null; }, onOpenChange: e => { if (e.open) for (const o of c.doc.querySelectorAll('.ui-time-option')) o.setAttribute('aria-selected', String(o.dataset.t === `${v.h}:${v.m}`)); } }, c.s);
    c.cleanup(() => pop.destroy());
  }
  v = parse(p.value);
  render();
  container.append(el);
  return { root: el, get value() { return value(); }, update(n) { p = { ...p, ...n }; if ('value' in n) v = parse(n.value); if ('error' in n) f.setError(n.error); render(); }, validate() { const m = p.required && !value() ? c.s.t('field.required') : null; f.setError(m); return !m; }, focus: () => fieldsBox.querySelector('.ui-time-seg')?.focus(), destroy: () => c.destroy() };
}

// ---------------------------------------------------------------- colour picker
// #RGB or #RRGGBB (the # optional); null for anything else (G25: #RGB entry)
const hexToRgb = hx => { const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hx ?? '').trim()); if (!m) return null; const h6 = m[1].length === 3 ? [...m[1]].map(x => x + x).join('') : m[1]; const n = parseInt(h6, 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const rgbToHex = (r, g, b) => `#${[r, g, b].map(x => Math.round(x).toString(16).padStart(2, '0')).join('')}`;
function rgbToHsv(r, g, b) { r /= 255; g /= 255; b /= 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn; let h = 0; if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; return [(h * 60 + 360) % 360, mx ? d / mx : 0, mx]; }
function hsvToRgb(h, s, v) { const f = n => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); }; return [f(5) * 255, f(3) * 255, f(1) * 255]; }
/**
 * createColorPicker(container, { label, value: '#rrggbb', swatches: ['#…'], description, hideLabel, onChange({ value }) }, services)
 * Saturation / brightness area (2-D slider: ←→ saturation, ↑↓ brightness), hue slider, hex field and swatches. Inline.
 */
export function createColorPicker(container, props = {}, services) {
  const c = setup(container, services, 'color-picker'); plusStrings(c.s);
  let p = { value: '#f8b700', swatches: [], ...props };
  let [hh, ss, vv] = rgbToHsv(...(hexToRgb(p.value) || [0, 0, 0]));
  const knob = c.h('span', { class: 'ui-color-knob', 'aria-hidden': 'true' });
  const area = c.h('div', { class: 'ui-color-area', role: 'slider', tabindex: '0' }, knob);
  const hue = c.h('div', { class: 'ui-color-hue', role: 'slider', tabindex: '0', 'aria-valuemin': '0', 'aria-valuemax': '360' }, c.h('span', { class: 'ui-color-knob', 'aria-hidden': 'true' }));
  const hex = c.h('input', { type: 'text', class: 'ui-color-hex', spellcheck: 'false', autocomplete: 'off', maxlength: '7' });
  const preview = c.h('span', { class: 'ui-color-preview', 'aria-hidden': 'true' });
  const swatchBox = c.h('div', { class: 'ui-color-swatches', role: 'group' });
  const hexId = uid('hex');
  hex.id = hexId;
  const box = c.h('div', { class: 'ui-color' }, area, hue, c.h('div', { class: 'ui-color-row' }, preview, c.h('label', { for: hexId, class: 'ui-visually-hidden' }), c.h('span', { class: 'ui-input' }, hex)), swatchBox);
  const f = field(c, box, { input: area, label: p.label, description: p.description, hideLabel: p.hideLabel, labelFor: false });
  const el = c.own(f.el);
  const current = () => rgbToHex(...hsvToRgb(hh, ss, vv));
  function render(syncHex = true) {
    const col = current();
    box.style.setProperty('--ui-hue', `hsl(${hh} 100% 50%)`); box.style.setProperty('--ui-color', col);
    knob.style.left = `${ss * 100}%`; knob.style.top = `${(1 - vv) * 100}%`;
    hue.firstChild.style.left = `${(hh / 360) * 100}%`;
    const lid = f.labelEl.id || (f.labelEl.id = uid('cp'));
    area.setAttribute('aria-labelledby', lid); area.setAttribute('aria-roledescription', c.s.t('color.saturation'));
    area.setAttribute('aria-valuetext', `${col}, ${c.s.format.percent(ss, 0)}, ${c.s.format.percent(vv, 0)}`);
    hue.setAttribute('aria-label', `${p.label ?? ''} ${c.s.t('color.hue')}`.trim()); hue.setAttribute('aria-valuenow', String(Math.round(hh))); hue.setAttribute('aria-valuetext', `${Math.round(hh)}°`);
    box.querySelector(`label[for="${hexId}"]`).textContent = `${p.label ?? ''} ${c.s.t('color.hex')}`.trim();
    if (syncHex) hex.value = col;
    swatchBox.setAttribute('aria-label', c.s.t('color.swatches'));
    fill(swatchBox, p.swatches.map(sw => c.h('button', { type: 'button', class: 'ui-color-swatch', style: `--ui-sw:${sw}`, 'aria-label': sw, 'aria-pressed': String(sw.toLowerCase() === col) })));
  }
  function emit() { p.value = current(); c.emit(el, 'change', { value: p.value }, p.onChange); }
  const drag = (target, onXY) => {
    let id = null;
    const at = e => { const r = target.getBoundingClientRect(); onXY(clamp((e.clientX - r.left) / (r.width || 1), 0, 1), clamp((e.clientY - r.top) / (r.height || 1), 0, 1)); render(); };
    c.on(target, 'pointerdown', e => { if (e.button) return; id = e.pointerId; try { target.setPointerCapture(id); } catch { /* synthetic */ } target.focus({ preventScroll: true }); at(e); e.preventDefault(); });
    c.on(target, 'pointermove', e => { if (id === e.pointerId) at(e); });
    for (const t of ['pointerup', 'pointercancel']) c.on(target, t, e => { if (id === e.pointerId) { id = null; emit(); } });
  };
  drag(area, (x, y) => { ss = x; vv = 1 - y; });
  drag(hue, x => { hh = x * 360; });
  c.on(area, 'keydown', e => {
    const d = e.shiftKey ? 0.1 : 0.01, map = { ArrowRight: [d, 0], ArrowLeft: [-d, 0], ArrowUp: [0, d], ArrowDown: [0, -d] }[e.key];
    if (!map) return; e.preventDefault();
    ss = clamp(ss + map[0], 0, 1); vv = clamp(vv + map[1], 0, 1); render(); emit();
  });
  c.on(hue, 'keydown', e => {
    const d = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1, PageUp: 15, PageDown: -15 }[e.key] ?? (e.key === 'Home' ? -hh : e.key === 'End' ? 359 - hh : null);
    if (d == null) return; e.preventDefault(); hh = clamp(hh + d * (e.shiftKey ? 10 : 1), 0, 359); render(); emit();
  });
  c.on(hex, 'input', () => { const rgb = hexToRgb(hex.value.startsWith('#') ? hex.value : `#${hex.value}`); f.setError(null); if (rgb) { [hh, ss, vv] = rgbToHsv(...rgb); render(false); emit(); } });
  c.on(hex, 'blur', () => { if (!hexToRgb(hex.value.startsWith('#') ? hex.value : `#${hex.value}`)) f.setError(c.s.t('field.invalid')); else render(); });
  c.on(swatchBox, 'click', e => { const b = e.target.closest('.ui-color-swatch'); if (!b) return; [hh, ss, vv] = rgbToHsv(...hexToRgb(b.getAttribute('aria-label'))); render(); emit(); });
  render();
  container.append(el);
  return { root: el, get value() { return current(); }, update(n) { p = { ...p, ...n }; if ('value' in n && hexToRgb(n.value)) [hh, ss, vv] = rgbToHsv(...hexToRgb(n.value)); render(); }, focus: () => area.focus(), destroy: () => c.destroy() };
}

// ---------------------------------------------------------------- colour field
/**
 * createColorField(container, { label, value: '#rrggbb' | null, swatches, presentation = 'auto' | 'popover' | 'sheet',
 *   required, disabled, readOnly, description, hideLabel, onChange({ value, previous }) }, services)
 * A field that shows its colour and opens a picker (G25, parity with 1.0): saturation and brightness, hue, hex (#RGB or
 * #RRGGBB, kept as #rrggbb), R / G / B from 0 to 255 and swatches, beside the old colour. Apply commits; Cancel, Escape
 * or a click outside leave the value as it was. 'auto' uses a bottom sheet on narrow touch screens. No value shows as
 * "Not set", never as white. Read-only shows the colour without opening.
 */
export function createColorField(container, props = {}, services) {
  const c = setup(container, services, 'color-field'); plusStrings(c.s);
  let p = { value: null, swatches: [], presentation: 'auto', ...props };
  const norm = v => { const rgb = hexToRgb(v); return rgb ? rgbToHex(...rgb) : null; };
  const chip = c.h('span', { class: 'ui-color-chip', 'aria-hidden': 'true' });
  const text = c.h('span', { class: 'ui-color-text', id: uid('cft') });
  const trigger = c.h('button', { type: 'button', class: 'ui-color-trigger', 'aria-haspopup': 'dialog', 'aria-expanded': 'false' }, chip, text, c.icon('chevron-down'));
  const box = c.h('div', { class: 'ui-input ui-color-field' }, trigger);
  const f = field(c, box, { input: trigger, label: p.label, description: p.description, required: p.required, optional: p.optional, hideLabel: p.hideLabel });
  const el = c.own(f.el);
  // the panel: built once, shown in a popover or a sheet
  let draft = null, open = false, surface = null, handle = null, pos = null, sheet = null;
  const panel = c.h('div', { class: 'ui-color-panel' });
  const picker = createColorPicker(panel, { label: p.label, hideLabel: true, value: '#808080', swatches: p.swatches, onChange: e => { draft = e.value; sync('picker'); } }, c.s);
  const rgbRow = c.h('div', { class: 'ui-color-rgb' });
  const rgb = ['red', 'green', 'blue'].map((k, i) => createNumberField(rgbRow, { label: c.s.t(`color.${k}`), min: 0, max: 255, step: 1, value: 0, onChange: e => { if (e.value == null) return; const v = hexToRgb(draft); v[i] = e.value; draft = rgbToHex(...v); sync('rgb'); } }, c.s));
  const was = c.h('span', { class: 'ui-color-was' }), now = c.h('span', { class: 'ui-color-now' });
  const compare = c.h('div', { class: 'ui-color-compare', 'aria-hidden': 'true' }, was, now);
  const acts = c.h('div', { class: 'ui-color-actions' });
  const cancelBtn = createButton(acts, { label: c.s.t('cancel'), variant: 'ghost', onClick: () => close() }, c.s);
  const applyBtn = createButton(acts, { label: c.s.t('apply'), variant: 'primary', onClick: () => apply() }, c.s);
  panel.append(rgbRow, compare, acts);
  function sync(from) {
    if (from !== 'picker') picker.update({ value: draft });
    if (from !== 'rgb') hexToRgb(draft).forEach((v, i) => rgb[i].update({ value: v }));
    now.style.setProperty('--ui-sw', draft);
  }
  function render() {
    const v = norm(p.value);
    chip.style.setProperty('--ui-sw', v || 'transparent'); chip.toggleAttribute('data-none', !v);
    text.textContent = v || c.s.t('color.none');
    trigger.disabled = !!p.disabled;
    if (p.readOnly) trigger.setAttribute('aria-readonly', 'true'); else trigger.removeAttribute('aria-readonly');
    trigger.setAttribute('aria-labelledby', `${f.labelEl.id || (f.labelEl.id = uid('cfl'))} ${text.id}`);
    box.toggleAttribute('data-disabled', !!p.disabled); box.toggleAttribute('data-readonly', !!p.readOnly);
    f.setLabel(p.label); f.setDescription(p.description); f.setRequired(p.required, p.optional);
    if (p.error !== undefined) f.setError(p.error || null);
  }
  const rem = () => parseFloat(c.win.getComputedStyle(c.doc.documentElement).fontSize) || 16;
  const asSheet = () => p.presentation === 'sheet' || (p.presentation === 'auto' && !!c.win.matchMedia?.('(pointer: coarse)').matches && c.win.innerWidth < 40 * rem());
  function openPanel() {
    if (open || p.disabled || p.readOnly) return;
    open = true;
    draft = norm(p.value) || norm(p.swatches[0]) || '#808080'; // a starting point only; nothing is set until Apply
    was.style.setProperty('--ui-sw', norm(p.value) || 'transparent'); was.toggleAttribute('data-none', !norm(p.value));
    sync();
    trigger.setAttribute('aria-expanded', 'true');
    if (asSheet()) {
      acts.hidden = true;
      sheet ??= createSheet({ title: p.label ?? '', content: panel, actions: [{ label: c.s.t('cancel'), value: false }, { label: c.s.t('apply'), variant: 'primary', value: true }], onClose: e => { if (e.value === true) commit(); finish(); } }, c.s);
      surface = 'sheet'; sheet.open();
    } else {
      acts.hidden = false;
      const pop = c.h('div', { class: 'ui-popover ui-popup ui-color-pop', role: 'dialog', 'aria-label': p.label ?? '' }, panel);
      c.s.overlays.portal.append(pop);
      surface = pop;
      handle = c.s.overlays.open(pop, { kind: 'menu', trigger, trap: true, dismissOnOutside: true, initialFocus: () => panel.querySelector('.ui-color-area'), onDismiss: () => close() });
      pos = autoPosition(box, pop, { placement: 'bottom-start', offset: 4, limitHeight: false });
      c.s.motion.animate(pop, { o: 1, y: 0 }, { role: 'enter', from: { o: 0, y: -2 } });
    }
  }
  function commit() {
    const prev = norm(p.value);
    if (draft === prev) return;
    p.value = draft; render();
    f.setError(p.error || null);
    c.emit(el, 'change', { value: draft, previous: prev }, p.onChange);
  }
  function apply() { commit(); close(); }
  function finish() { open = false; surface = null; trigger.setAttribute('aria-expanded', 'false'); }
  function close() {
    if (!open) return;
    if (surface === 'sheet') { sheet.close(false); return; } // onClose finishes
    const pop = surface; // each opening has its own popover element; this one goes after its exit
    pos?.cleanup(); pos = null; handle?.close(); handle = null; finish();
    c.s.motion.animate(pop, { o: 0 }, { role: 'exit' }).then(() => { c.s.motion.reset(pop); pop.remove(); });
  }
  c.on(trigger, 'click', () => (open ? close() : openPanel()));
  c.on(trigger, 'keydown', e => { if (e.key === 'ArrowDown' && e.altKey) { e.preventDefault(); openPanel(); } });
  // Enter in the hex or R / G / B fields applies, as in a form
  c.on(panel, 'keydown', e => { if (e.key === 'Enter' && e.target.matches('input') && surface !== 'sheet') { e.preventDefault(); e.target.dispatchEvent(new c.win.Event('blur')); apply(); } });
  c.cleanup(() => { close(); picker.destroy(); rgb.forEach(x => x.destroy()); cancelBtn.destroy(); applyBtn.destroy(); sheet?.destroy(); });
  render(); container.append(el);
  return {
    root: el, get value() { return norm(p.value); }, get isOpen() { return open; },
    open: openPanel, close,
    update(n) { p = { ...p, ...n }; if ('swatches' in n) picker.update({ swatches: p.swatches }); render(); },
    validate() { const m = p.required && !norm(p.value) ? c.s.t('field.required') : null; f.setError(p.error || m); return !m; },
    focus: () => trigger.focus(), destroy: () => c.destroy(),
  };
}

// ---------------------------------------------------------------- tag input
/**
 * createTagInput(container, { label, value: string[], placeholder, validate(tag) → message, maxTags, separators = [',', ';'],
 *   description, required, readOnly, disabled, hideLabel, onChange({ value }) }, services)
 * Free-text chips: Enter or a separator adds, Backspace in an empty input removes the last chip, paste splits on
 * separators and new lines. Invalid entries stay in the input with the field error; duplicates are ignored.
 */
export function createTagInput(container, props = {}, services) {
  const c = setup(container, services, 'tag-input'); plusStrings(c.s);
  let p = { value: [], separators: [',', ';'], ...props };
  const input = c.h('input', { type: 'text', class: 'ui-tags-input', autocomplete: 'off', spellcheck: 'false' });
  const chips = c.h('span', { class: 'ui-tags-chips', role: 'list' });
  const box = c.h('div', { class: 'ui-input ui-tags' }, chips, input);
  const f = field(c, box, { input, label: p.label, description: p.description, required: p.required, hideLabel: p.hideLabel });
  if (p.error) f.setError(p.error);
  const el = c.own(f.el);
  function render() {
    const locked = !!(p.readOnly || p.disabled); // tags stay readable; nothing can be added or removed (G21)
    input.placeholder = p.value.length || locked ? '' : p.placeholder || '';
    input.readOnly = !!p.readOnly; input.disabled = !!p.disabled;
    box.toggleAttribute('data-readonly', !!p.readOnly); box.toggleAttribute('data-disabled', !!p.disabled);
    fill(chips, p.value.map(v => { const t = tag(v, { doc: c.doc, onRemove: locked ? null : () => remove(v, true), removeLabel: c.s.t('tags.remove', { label: v }) }); t.setAttribute('role', 'listitem'); t.querySelector('button')?.setAttribute('tabindex', '-1'); return t; }));
  }
  function emit() { c.emit(el, 'change', { value: [...p.value] }, p.onChange); }
  function add(raw) {
    if (p.readOnly || p.disabled) return;
    const parts = raw.split(new RegExp(`[${p.separators.map(s => s.replace(/[-\\]^]/g, '\\$&')).join('')}\\n]`)).map(s => s.trim()).filter(Boolean);
    const bad = [];
    for (const t of parts) {
      if (p.value.includes(t)) continue;
      if (p.maxTags && p.value.length >= p.maxTags) { bad.push(t); f.setError(c.s.t('file.tooMany', { max: p.maxTags })); continue; }
      const msg = p.validate?.(t);
      if (msg) { bad.push(t); f.setError(msg); continue; }
      p.value = [...p.value, t];
    }
    if (!bad.length) f.setError(null);
    input.value = bad.join(', ');
    render(); emit();
  }
  function remove(v, refocus) {
    p.value = p.value.filter(x => x !== v); render(); emit();
    c.s.announce(c.s.t('tags.remove', { label: v }));
    if (refocus) input.focus();
  }
  c.on(input, 'keydown', e => {
    if ((e.key === 'Enter' || p.separators.includes(e.key)) && input.value.trim()) { e.preventDefault(); add(input.value); }
    else if (e.key === 'Backspace' && !input.value && p.value.length && !p.readOnly) { e.preventDefault(); remove(p.value[p.value.length - 1]); }
  });
  c.on(input, 'paste', e => { const t = e.clipboardData?.getData('text'); if (t && /[\n,;]/.test(t)) { e.preventDefault(); add(input.value + t); } });
  c.on(input, 'blur', () => { if (input.value.trim()) add(input.value); });
  render();
  container.append(el);
  return { root: el, input, get value() { return [...p.value]; }, update(n) { p = { ...p, ...n }; if ('error' in n) f.setError(n.error); render(); }, validate() { const t = input.value.trim(), m = (t && p.validate?.(t)) || (p.required && !p.value.length ? c.s.t('field.required') : null); f.setError(m || null); return !m; }, focus: () => input.focus(), destroy: () => c.destroy() }; // text still in the input counts
}

// ---------------------------------------------------------------- listbox
/**
 * createListbox(container, { label, options: [{ value, label, description, disabled, group }], value, values, multiple, height,
 *   onChange({ value | values }) }, services)
 * A standalone APG listbox (single or multiple). Focus stays on the list; the active option is aria-activedescendant.
 * ↑ ↓ Home End, typeahead; single: moving selects; multiple: Space toggles, Ctrl/⌘+A selects all.
 */
export function createListbox(container, props = {}, services) {
  const c = setup(container, services, 'listbox'); plusStrings(c.s);
  let p = { options: [], ...props };
  const el = c.h('div', { class: 'ui-listbox-standalone', role: 'listbox', tabindex: '0' });
  // A field like the others: visible label (or hideLabel), description; the list is labelled by it.
  const f = field(c, el, { input: el, label: p.label, description: p.description, hideLabel: p.hideLabel, labelFor: false });
  el.setAttribute('aria-labelledby', f.labelEl.id || (f.labelEl.id = uid('lbl')));
  const root = c.own(f.el);
  const base = uid('lb');
  let active = 0, buffer = '', bufT = 0;
  const enabled = () => p.options.map((o, i) => (o.disabled ? -1 : i)).filter(i => i >= 0);
  const isSel = o => (p.multiple ? (p.values || []).includes(o.value) : Object.is(p.value, o.value));
  function render() {
    f.setLabel(p.label);
    el.setAttribute('aria-multiselectable', String(!!p.multiple));
    if (p.height) el.style.maxHeight = p.height;
    let group;
    fill(el, p.options.flatMap((o, i) => {
      const out = [];
      if (o.group && o.group !== group) { group = o.group; out.push(c.h('div', { class: 'ui-option-group', role: 'presentation' }, o.group)); }
      out.push(c.h('div', { class: 'ui-option', role: 'option', id: `${base}-${i}`, 'aria-selected': String(isSel(o)), 'aria-disabled': o.disabled ? 'true' : null, 'data-active': i === active ? '' : null, 'data-i': i },
        c.h('span', { class: 'ui-option-check', 'aria-hidden': 'true' }), c.h('span', {}, o.label, o.description ? c.h('small', {}, o.description) : null)));
      return out;
    }));
    el.setAttribute('aria-activedescendant', `${base}-${active}`);
  }
  function move(i) { active = i; for (const x of el.querySelectorAll('[data-active]')) x.removeAttribute('data-active'); const o = el.querySelector(`#${base}-${i}`); o?.setAttribute('data-active', ''); o?.scrollIntoView({ block: 'nearest' }); el.setAttribute('aria-activedescendant', `${base}-${i}`); if (!p.multiple) choose(i); }
  function choose(i) {
    const o = p.options[i]; if (!o || o.disabled) return;
    if (p.multiple) { const set = new Set(p.values || []); set.has(o.value) ? set.delete(o.value) : set.add(o.value); p.values = p.options.map(x => x.value).filter(v => set.has(v)); render(); c.emit(el, 'change', { values: [...p.values] }, p.onChange); }
    else if (!Object.is(p.value, o.value)) { p.value = o.value; render(); c.emit(el, 'change', { value: o.value }, p.onChange); }
  }
  c.on(el, 'keydown', e => {
    const list = enabled(), at = list.indexOf(active);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); move(list[clamp(at + (e.key === 'ArrowDown' ? 1 : -1), 0, list.length - 1)]); }
    else if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); move(e.key === 'Home' ? list[0] : list[list.length - 1]); }
    else if (e.key === ' ' && p.multiple) { e.preventDefault(); choose(active); }
    else if ((e.key === 'a' || e.key === 'A') && (e.ctrlKey || e.metaKey) && p.multiple) { e.preventDefault(); p.values = p.options.filter(o => !o.disabled).map(o => o.value); render(); c.emit(el, 'change', { values: [...p.values] }, p.onChange); }
    else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      buffer += e.key.toLowerCase(); c.win.clearTimeout(bufT); bufT = c.win.setTimeout(() => { buffer = ''; }, 500);
      const order = [...list.slice(at + 1), ...list.slice(0, at + 1)], hit = order.find(i => String(p.options[i].label).toLowerCase().startsWith(buffer));
      if (hit != null) move(hit);
    }
  });
  c.on(el, 'click', e => { const o = e.target.closest('.ui-option'); if (!o) return; const i = Number(o.dataset.i); active = i; if (p.multiple) choose(i); else move(i); el.focus({ preventScroll: true }); });
  c.cleanup(() => c.win.clearTimeout(bufT));
  const sel = p.options.findIndex(isSel); active = sel >= 0 ? sel : enabled()[0] ?? 0;
  render();
  container.append(root);
  return { root, listbox: el, get value() { return p.multiple ? [...(p.values || [])] : p.value; }, update(n) { p = { ...p, ...n }; render(); }, focus: () => el.focus(), destroy: () => c.destroy() };
}

// ---------------------------------------------------------------- upload manager
/**
 * createUploadManager(container, { label, upload(file, { signal, onProgress(fraction) }) → Promise, concurrency = 2, accept, acceptLabel,
 *   maxSize, maxFiles, description, onChange({ items }) }, services)
 * File drop plus a queue: each file shows waiting / progress / uploaded / failed with Cancel, Retry and Remove. The
 * host supplies the transfer; at most `concurrency` run at once. A polite summary announces progress milestones.
 */
export function createUploadManager(container, props = {}, services) {
  const c = setup(container, services, 'upload'); plusStrings(c.s);
  let p = { concurrency: 2, ...props };
  const el = c.own(c.h('div', { class: 'ui-upload' }));
  const dropHost = c.h('div'), listEl = c.h('ul', { class: 'ui-upload-list' }), summary = c.h('p', { class: 'ui-upload-summary', role: 'status' });
  el.append(dropHost, summary, listEl);
  let items = [], seq = 0;
  const drop = createFileDrop(dropHost, { label: p.label, description: p.description, accept: p.accept, acceptLabel: p.acceptLabel, maxSize: p.maxSize, maxFiles: p.maxFiles, multiple: true, onFiles: e => { for (const file of e.accepted) items.push({ id: `u${++seq}`, file, name: file.name, size: file.size, status: 'queued', progress: 0 }); pump(); render(); } }, c.s);
  function pump() {
    const running = items.filter(i => i.status === 'uploading').length;
    for (const it of items.filter(i => i.status === 'queued').slice(0, Math.max(0, p.concurrency - running))) start(it);
  }
  function start(it) {
    it.status = 'uploading'; it.progress = 0; it.error = null; it.ctrl = new AbortController();
    const my = it.ctrl;
    Promise.resolve().then(() => p.upload(it.file, { signal: my.signal, onProgress: f => { if (it.ctrl !== my) return; it.progress = clamp(f, 0, 1); renderItem(it); } }))
      .then(() => { if (it.ctrl !== my) return; it.status = 'done'; it.progress = 1; })
      .catch(err => { if (it.ctrl !== my) return; it.status = my.signal.aborted ? 'cancelled' : 'failed'; it.error = err?.message; })
      .finally(() => { if (it.ctrl === my) it.ctrl = null; if (!c.dead) { pump(); render(); } });
    render();
  }
  function renderItem(it) {
    const li = listEl.querySelector(`[data-id="${it.id}"]`); if (!li) return;
    const bar = li.querySelector('.ui-progress');
    if (bar) { bar.setAttribute('aria-valuenow', String(Math.round(it.progress * 100))); bar.firstChild.style.transform = `scaleX(${it.progress})`; }
    const st = li.querySelector('.ui-upload-status'); if (st && it.status === 'uploading') st.textContent = c.s.format.percent(it.progress, 0);
  }
  function render() {
    const done = items.filter(i => i.status === 'done').length;
    summary.textContent = items.length ? c.s.t('upload.summary', { done: c.s.format.number(done), total: c.s.format.number(items.filter(i => i.status !== 'cancelled').length) }) : '';
    summary.hidden = !items.length;
    fill(listEl, items.map(it => {
      const statusText = it.status === 'done' ? c.s.t('upload.done') : it.status === 'failed' ? `${c.s.t('upload.failed')}${it.error ? ` · ${it.error}` : ''}` : it.status === 'queued' ? c.s.t('upload.queued') : it.status === 'cancelled' ? c.s.t('cancel') : c.s.format.percent(it.progress, 0);
      const act = (icon, label, fn) => { const b = c.h('button', { type: 'button', class: 'ui-button', 'data-variant': 'ghost', 'data-icon-only': '', 'aria-label': label }, c.icon(icon)); b.addEventListener('click', fn); return b; };
      return c.h('li', { class: 'ui-upload-item', 'data-id': it.id, 'data-status': it.status },
        c.icon(it.status === 'done' ? 'check-circle' : it.status === 'failed' ? 'error' : 'file'),
        c.h('div', { class: 'ui-upload-main' },
          c.h('div', { class: 'ui-upload-name' }, it.name),
          c.h('div', { class: 'ui-upload-meta' }, c.s.format.bytes(it.size), ' · ', c.h('span', { class: 'ui-upload-status' }, statusText)),
          it.status === 'uploading' ? c.h('div', { class: 'ui-progress', role: 'progressbar', 'aria-label': it.name, 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(it.progress * 100)) }, c.h('i', { style: `transform:scaleX(${it.progress})` })) : null),
        it.status === 'uploading' ? act('close', c.s.t('upload.cancel', { name: it.name }), () => { it.ctrl?.abort(); it.status = 'cancelled'; it.ctrl = null; pump(); render(); })
          : it.status === 'failed' ? act('refresh', c.s.t('upload.retry', { name: it.name }), () => { it.status = 'queued'; pump(); render(); }) : null,
        it.status !== 'uploading' ? act('trash', c.s.t('upload.remove', { name: it.name }), () => { items = items.filter(x => x !== it); render(); }) : null);
    }));
    c.emit(el, 'change', { items: items.map(({ ctrl, ...x }) => x) }, p.onChange);
  }
  c.cleanup(() => { for (const it of items) it.ctrl?.abort(); drop.destroy(); });
  container.append(el);
  render();
  return { root: el, get items() { return items.map(({ ctrl, ...x }) => x); }, addFiles: files => drop.addFiles(files), update(n) { p = { ...p, ...n }; drop.update({ label: p.label, description: p.description }); render(); }, focus: () => drop.focus(), destroy: () => c.destroy() };
}
