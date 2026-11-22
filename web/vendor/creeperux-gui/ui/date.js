import { setup, fill, field, uid } from './base.js';
import { autoPosition } from '../position.js';

// ---------------------------------------------------------------- calendar math on ISO dates (no time zones)
const DAY = 86400000;
export function parseISO(s) { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? '')); if (!m) return null; const y = +m[1], mo = +m[2], d = +m[3]; if (mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return null; return { y, m: mo, d }; }
export const toISO = ({ y, m, d }) => `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const utc = iso => { const p = parseISO(iso); return Date.UTC(p.y, p.m - 1, p.d); };
const fromUTC = ms => { const d = new Date(ms); return toISO({ y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() }); };
export const addDays = (iso, n) => fromUTC(utc(iso) + n * DAY);
export function addMonths(iso, n) { const p = parseISO(iso); const t = p.m - 1 + n, y = p.y + Math.floor(t / 12), m = ((t % 12) + 12) % 12 + 1; return toISO({ y, m, d: Math.min(p.d, daysIn(y, m)) }); }
const dow = iso => new Date(utc(iso)).getUTCDay();
export const todayISO = (now = new Date()) => toISO({ y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() });
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0); // ISO strings compare lexically

/** Locale numeric date pattern, e.g. de → 01.10.2026, en-US → 10/01/2026, ja → 2026/10/01. */
const patterns = new Map();
function datePattern(locale) {
  if (patterns.has(locale)) return patterns.get(locale);
  const parts = new Intl.DateTimeFormat(locale, { year: 'numeric', month: '2-digit', day: '2-digit', numberingSystem: 'latn' }).formatToParts(new Date(Date.UTC(2026, 9, 1, 12)));
  const pattern = { order: parts.filter(x => ['year', 'month', 'day'].includes(x.type)).map(x => x.type), parts };
  patterns.set(locale, pattern);
  return pattern;
}
export function formatTyped(iso, locale) {
  const p = parseISO(iso); if (!p) return '';
  const { parts } = datePattern(locale);
  return parts.map(x => x.type === 'year' ? String(p.y) : x.type === 'month' ? String(p.m).padStart(2, '0') : x.type === 'day' ? String(p.d).padStart(2, '0') : x.value).join('').replace(/[‎‏]/g, '');
}
/** Parses a typed date in ISO or in the locale's numeric order (native digits allowed). Returns ISO or null. */
export function parseTyped(text, locale) {
  let s = String(text).trim().replace(/[٠-٩]/g, d => d.charCodeAt(0) - 0x660).replace(/[۰-۹]/g, d => d.charCodeAt(0) - 0x6f0).replace(/[０-９]/g, d => d.charCodeAt(0) - 0xff10);
  if (!s) return null;
  if (parseISO(s)) return s;
  const nums = s.match(/\d+/g); if (!nums || nums.length !== 3) return null;
  const { order } = datePattern(locale); const v = {};
  order.forEach((k, i) => { v[k] = +nums[i]; });
  if (nums[order.indexOf('year')].length <= 2) v.year += 2000;
  const iso = toISO({ y: v.year, m: v.month, d: v.day });
  return parseISO(iso) ? iso : null;
}

// ---------------------------------------------------------------- calendar view (shared)
// Intl.DateTimeFormat construction costs ~0.2 ms each at 4× CPU; a month grid needs ~45, so formatters are shared per locale.
const DTF = { month: { month: 'long', year: 'numeric' }, long: { dateStyle: 'full' }, wd: { weekday: 'narrow' }, wdLong: { weekday: 'long' } };
const dtfCache = new Map();
function dtf(locale, kind) {
  const key = `${locale}|${kind}`;
  let f = dtfCache.get(key);
  if (!f) dtfCache.set(key, f = new Intl.DateTimeFormat(locale, { ...DTF[kind], timeZone: 'UTC' }));
  return f;
}
// A day's states (G54): selected, range edge, in range. The selected state is in its name as well, because NVDA reads
// a focused grid cell's name but not its selected state (it only says "selected" when the selection changes).
function markDay(s, b, st) {
  b.toggleAttribute('data-in-range', !!st.inRange); b.toggleAttribute('data-range-edge', !!st.edge);
  if (st.selected) b.setAttribute('aria-selected', 'true'); else b.removeAttribute('aria-selected');
  const date = dtf(s.i18n.locale, 'long').format(new Date(utc(b.dataset.iso)));
  const name = st.selected ? s.t('date.selectedDay', { date }) : date;
  if (b.getAttribute('aria-label') !== name) b.setAttribute('aria-label', name);
}
function calendarView(c, opts) {
  const { s } = c;
  const loc = () => s.i18n.locale;
  const el = c.h('div', { class: 'ui-calendar' });
  const months = c.h('div', { class: 'ui-calendar-months' });
  el.append(months);
  let first = opts.month, focusIso = opts.focus;
  const weekStart = () => opts.weekStart ?? s.format.weekStart();
  const disabled = iso => (opts.min && cmp(iso, opts.min) < 0) || (opts.max && cmp(iso, opts.max) > 0) || !!opts.isDisabled?.(iso);
  const monthFmt = () => dtf(loc(), 'month');
  const wdFmt = () => dtf(loc(), 'wd'), wdLong = () => dtf(loc(), 'wdLong');
  const dayNum = n => s.format.number(n, { useGrouping: false });
  function monthGrid(monthIso, idx, count) {
    const p = parseISO(monthIso), start = toISO({ y: p.y, m: p.m, d: 1 }), n = daysIn(p.y, p.m);
    const lead = (dow(start) - weekStart() + 7) % 7;
    const title = c.h('h2', { id: uid('cal') }, monthFmt().format(new Date(utc(start))));
    const prev = idx === 0 ? c.h('button', { type: 'button', class: 'ui-calendar-nav', 'aria-label': s.t('date.previousMonth'), dataset: { nav: '-1' } }, c.icon('chevron-left')) : c.h('span', { style: 'width:var(--cx-ctl)' });
    const next = idx === count - 1 ? c.h('button', { type: 'button', class: 'ui-calendar-nav', 'aria-label': s.t('date.nextMonth'), dataset: { nav: '1' } }, c.icon('chevron-right')) : c.h('span', { style: 'width:var(--cx-ctl)' });
    const head = c.h('tr', {}, Array.from({ length: 7 }, (_, i) => { const d = new Date(Date.UTC(2026, 2, 1 + ((weekStart() + i) % 7))); return c.h('th', { scope: 'col', abbr: wdLong().format(d) }, wdFmt().format(d)); }));
    const rows = [];
    let day = 1 - lead;
    for (let r = 0; r < 6 && day <= n; r++) {
      const tr = c.h('tr');
      for (let k = 0; k < 7; k++, day++) {
        if (day < 1 || day > n) { tr.append(c.h('td')); continue; }
        const iso = toISO({ y: p.y, m: p.m, d: day });
        // The day is the grid's cell itself (APG date picker), so selected, disabled and today sit on what has focus (G54).
        const b = c.h('td', { class: 'ui-day', tabindex: '-1', dataset: { iso } }, dayNum(day));
        if (disabled(iso)) b.setAttribute('aria-disabled', 'true');
        if (iso === todayISO()) { b.dataset.today = ''; b.setAttribute('aria-current', 'date'); }
        markDay(s, b, opts.dayState?.(iso) || {});
        tr.append(b);
      }
      rows.push(tr);
    }
    return c.h('div', { class: 'ui-calendar-month' }, c.h('div', { class: 'ui-calendar-head' }, prev, title, next),
      c.h('table', { class: 'ui-calendar-grid', role: 'grid', 'aria-labelledby': title.id }, c.h('thead', {}, head), c.h('tbody', {}, rows)));
  }
  function render(fade = false) {
    const count = opts.months || 1;
    fill(months, ...Array.from({ length: count }, (_, i) => monthGrid(addMonths(first, i), i, count)));
    const target = months.querySelector(`[data-iso="${focusIso}"]`) || months.querySelector('.ui-day:not([aria-disabled])');
    if (target) target.tabIndex = 0;
    if (fade) s.motion.animate(months, { o: 1 }, { role: 'view', from: { o: 0.35 } });
  }
  const inView = iso => { const last = addMonths(first, (opts.months || 1) - 1), p = parseISO(last); return cmp(iso, first) >= 0 && cmp(iso, toISO({ y: p.y, m: p.m, d: daysIn(p.y, p.m) })) <= 0; };
  function focusDay(iso, { fade = true } = {}) {
    if (opts.min && cmp(iso, opts.min) < 0) iso = opts.min;
    if (opts.max && cmp(iso, opts.max) > 0) iso = opts.max;
    focusIso = iso;
    if (!inView(iso)) { const p = parseISO(iso); first = cmp(iso, first) < 0 ? toISO({ y: p.y, m: p.m, d: 1 }) : addMonths(toISO({ y: p.y, m: p.m, d: 1 }), -((opts.months || 1) - 1)); render(fade); }
    for (const b of months.querySelectorAll('.ui-day')) b.tabIndex = b.dataset.iso === iso ? 0 : -1;
    months.querySelector(`[data-iso="${iso}"]`)?.focus();
    opts.onFocus?.(iso);
  }
  c.on(el, 'click', e => {
    const nav = e.target.closest('[data-nav]');
    if (nav) { first = addMonths(first, +nav.dataset.nav); focusIso = addMonths(focusIso, +nav.dataset.nav); render(true); return; }
    const b = e.target.closest('.ui-day'); if (!b || b.getAttribute('aria-disabled') === 'true') return;
    focusIso = b.dataset.iso; opts.onPick(b.dataset.iso);
  });
  c.on(el, 'pointerover', e => { const b = e.target.closest('.ui-day'); if (b) opts.onHover?.(b.dataset.iso); });
  c.on(el, 'keydown', e => {
    if (!e.target.closest('.ui-day')) return;
    const rtl = c.win.getComputedStyle(el).direction === 'rtl';
    const iso = e.target.dataset.iso;
    const moves = { ArrowLeft: rtl ? 1 : -1, ArrowRight: rtl ? -1 : 1, ArrowUp: -7, ArrowDown: 7 };
    let next = null;
    if (e.key in moves) next = addDays(iso, moves[e.key]);
    else if (e.key === 'Home') next = addDays(iso, -((dow(iso) - weekStart() + 7) % 7));
    else if (e.key === 'End') next = addDays(iso, 6 - ((dow(iso) - weekStart() + 7) % 7));
    else if (e.key === 'PageUp') next = addMonths(iso, e.shiftKey ? -12 : -1);
    else if (e.key === 'PageDown') next = addMonths(iso, e.shiftKey ? 12 : 1);
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (e.target.getAttribute('aria-disabled') !== 'true') opts.onPick(iso); return; }
    if (next) { e.preventDefault(); focusDay(next); opts.onHover?.(next); }
  });
  render();
  return { el, render, focusDay, get focus() { return focusIso; }, setMonth(iso) { const p = parseISO(iso); first = toISO({ y: p.y, m: p.m, d: 1 }); render(); } };
}

// ---------------------------------------------------------------- inline calendar
/**
 * createCalendar(container, { label, value, range, min, max, isDateDisabled(iso), weekStart, months = 1, readOnly, disabled,
 *   onChange({ value, previous }) }, services)
 * The date picker's grid on the page (G27). Single: value 'YYYY-MM-DD' | null. Range (`range: true`): value
 * { start, end } | null; the first pick sets the start, the second the end, with a preview while moving. Arrow keys move
 * by day and week, Home / End within the week, PageUp / PageDown by month (Shift: year); Enter, Space or a click picks.
 * A pick keeps focus on its day; a host value in another month brings that month into view.
 */
export function createCalendar(container, props = {}, services) {
  const c = setup(container, services, 'calendar');
  let p = { value: null, months: 1, ...props }, anchor = null, hover = null;
  const el = c.own(c.h('div', { class: 'ui-calendar-inline', role: 'group' }));
  const startOf = v => (p.range ? v?.start : v) || null;
  const state = iso => {
    if (!p.range) return { selected: iso === p.value };
    const v = p.value || {}, a = anchor, s = a ? (hover && cmp(hover, a) < 0 ? hover : a) : v.start, e = a ? (hover && cmp(hover, a) > 0 ? hover : a) : v.end;
    if (!s) return {};
    return { selected: iso === s || iso === e, edge: iso === s || iso === e, inRange: e && cmp(iso, s) > 0 && cmp(iso, e) < 0 };
  };
  // Day states change in place, so the focused day keeps focus after a pick.
  const refreshDays = () => { for (const b of el.querySelectorAll('.ui-day')) markDay(c.s, b, state(b.dataset.iso)); };
  function emit(v) { const prev = p.value; p.value = v; refreshDays(); c.emit(el, 'change', { value: v, previous: prev }, p.onChange); }
  const start = startOf(p.value) || todayISO();
  const cal = calendarView(c, {
    month: start, focus: start, dayState: state,
    get months() { return p.months || 1; }, get min() { return p.min; }, get max() { return p.max; }, get isDisabled() { return p.isDateDisabled; }, get weekStart() { return p.weekStart; },
    onHover: iso => { if (anchor) { hover = iso; refreshDays(); } },
    onPick: iso => {
      if (p.readOnly || p.disabled) return;
      if (!p.range) { if (iso !== p.value) emit(iso); return; }
      if (!anchor) { anchor = iso; hover = iso; refreshDays(); c.s.announce(`${c.s.t('date.start')}: ${c.s.format.date(utc(iso), { dateStyle: 'long', timeZone: 'UTC' })}`); return; }
      const [a, b] = cmp(iso, anchor) < 0 ? [iso, anchor] : [anchor, iso];
      anchor = null; hover = null; emit({ start: a, end: b });
      c.s.announce(c.s.format.dateRange(utc(a), utc(b), { dateStyle: 'long', timeZone: 'UTC' }));
    },
  });
  el.append(cal.el);
  function render() {
    if (p.label) el.setAttribute('aria-label', p.label); else el.removeAttribute('aria-label');
    el.inert = !!p.disabled; el.toggleAttribute('data-disabled', !!p.disabled);
    for (const g of el.querySelectorAll('[role="grid"]')) { if (p.readOnly) g.setAttribute('aria-readonly', 'true'); else g.removeAttribute('aria-readonly'); }
  }
  render(); container.append(el);
  return {
    root: el, get value() { return p.value; },
    update(n) {
      const before = JSON.stringify(p.value); p = { ...p, ...n };
      if ('value' in n && JSON.stringify(p.value) !== before) { anchor = null; const s = startOf(p.value); if (s) cal.setMonth(s); }
      if (['min', 'max', 'isDateDisabled', 'weekStart', 'months'].some(k => k in n)) cal.render();
      refreshDays(); render();
    },
    focus: () => (el.querySelector('.ui-day[tabindex="0"]') || el.querySelector('.ui-day:not([aria-disabled])'))?.focus(),
    destroy: () => c.destroy(),
  };
}

// ---------------------------------------------------------------- popup helper
function popupController(c, anchor, trigger, label, build) {
  let open = false, handle = null, pos = null, popup = null, closing = null;
  function show(initialFocus) {
    if (open) return; open = true;
    // A popup still fading out from the previous close goes now (reopening within the exit duration).
    if (closing) { c.s.motion.reset(closing); closing.remove(); closing = null; }
    popup = build();
    popup.classList.add('ui-popup');
    popup.setAttribute('role', 'dialog'); popup.setAttribute('aria-label', label());
    handle = c.s.overlays.open(popup, { kind: 'menu', trigger, trap: true, dismissOnOutside: true, initialFocus: initialFocus || false, onDismiss: () => hide() });
    pos = autoPosition(anchor, popup, { placement: 'bottom-start', offset: 4, limitHeight: false });
    trigger.setAttribute('aria-expanded', 'true');
    c.s.motion.animate(popup, { o: 1, y: 0 }, { role: 'enter', from: { o: 0, y: -2 } });
  }
  function hide({ restoreFocus = true } = {}) {
    if (!open) return; open = false; const el = popup;
    pos?.cleanup(); handle?.close({ restoreFocus }); trigger.setAttribute('aria-expanded', 'false');
    closing = el;
    c.s.motion.animate(el, { o: 0 }, { role: 'exit' }).then(() => { if (closing === el) { c.s.motion.reset(el); el.remove(); closing = null; } });
  }
  c.cleanup(() => { pos?.cleanup(); handle?.close({ restoreFocus: false }); popup?.remove(); closing?.remove(); });
  return { show, hide, get open() { return open; }, get popup() { return popup; } };
}

// ---------------------------------------------------------------- date picker
/**
 * createDatePicker(container, { label, value: 'YYYY-MM-DD'|null, min, max, isDateDisabled(iso), weekStart,
 *   required, optional, description, disabled, readOnly, onChange({ value, previous }) })
 */
export function createDatePicker(container, props = {}, services) {
  const c = setup(container, services, 'date');
  let p = { value: null, ...props };
  const input = c.h('input', { type: 'text', autocomplete: 'off', inputmode: 'numeric' });
  const btn = c.h('button', { type: 'button', class: 'ui-inline-button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false' }, c.icon('calendar'));
  const box = c.h('div', { class: 'ui-input' }, input, btn);
  const f = field(c, box, { input, label: p.label, description: p.description, required: p.required, optional: p.optional, hideLabel: p.hideLabel });
  c.own(f.el);
  const example = () => formatTyped(p.value || todayISO(), c.s.i18n.locale);
  const range = iso => (p.min && cmp(iso, p.min) < 0 ? c.s.t('field.min', { min: c.s.format.date(utc(p.min), { dateStyle: 'medium', timeZone: 'UTC' }) }) : p.max && cmp(iso, p.max) > 0 ? c.s.t('field.max', { max: c.s.format.date(utc(p.max), { dateStyle: 'medium', timeZone: 'UTC' }) }) : p.isDateDisabled?.(iso) ? c.s.t('field.invalid') : null);
  let cal = null;
  const pop = popupController(c, box, btn, () => c.s.t('date.choose'), () => {
    const start = p.value || todayISO();
    cal = calendarView(c, { month: start, focus: start, min: p.min, max: p.max, isDisabled: p.isDateDisabled, weekStart: p.weekStart, dayState: iso => ({ selected: iso === p.value }), onPick: iso => { commit(iso, true); pop.hide(); } });
    const today = c.h('button', { type: 'button', class: 'ui-button', 'data-variant': 'ghost' }, c.s.t('date.today'));
    today.addEventListener('click', () => cal.focusDay(todayISO()));
    cal.el.append(c.h('div', { class: 'ui-calendar-foot' }, today));
    return cal.el;
  });
  function commit(iso, announce) {
    const prev = p.value; p.value = iso;
    input.value = iso ? formatTyped(iso, c.s.i18n.locale) : '';
    f.setError(p.error || (iso ? range(iso) : p.required ? c.s.t('field.required') : null));
    if (prev !== iso) { c.emit(f.el, 'change', { value: iso, previous: prev }, p.onChange); if (announce && iso) c.s.announce(c.s.format.date(utc(iso), { dateStyle: 'full', timeZone: 'UTC' })); }
  }
  function render() {
    if (c.doc.activeElement !== input) input.value = p.value ? formatTyped(p.value, c.s.i18n.locale) : '';
    input.placeholder = example(); input.disabled = !!p.disabled; input.readOnly = !!p.readOnly;
    btn.disabled = !!(p.disabled || p.readOnly); btn.setAttribute('aria-label', c.s.t('date.choose'));
    box.toggleAttribute('data-disabled', !!p.disabled); box.toggleAttribute('data-readonly', !!p.readOnly);
    f.setLabel(p.label); f.setDescription(p.description); f.setRequired(p.required, p.optional);
    if (p.error !== undefined) f.setError(p.error || null);
  }
  const typed = () => { const raw = input.value.trim(); if (!raw) { commit(null); return; } const iso = parseTyped(raw, c.s.i18n.locale); if (!iso) { f.setError(c.s.t('date.invalid', { example: example() })); return; } commit(iso); };
  c.on(input, 'blur', () => { if (!pop.open) typed(); });
  c.on(input, 'keydown', e => { if (e.key === 'Enter') typed(); if (e.key === 'ArrowDown' && e.altKey) { e.preventDefault(); openCal(); } });
  const openCal = () => { if (pop.open) { pop.hide(); return; } pop.show(() => cal.el.querySelector('.ui-day[tabindex="0"]')); };
  c.on(btn, 'click', openCal);
  render(); container.append(f.el);
  return { root: f.el, input, get value() { return p.value; }, get isOpen() { return pop.open; }, open: openCal, close: () => pop.hide(), update(n) { p = { ...p, ...n }; render(); }, validate() { const m = p.required && !p.value ? c.s.t('field.required') : p.value ? range(p.value) : null; f.setError(m); return !m; }, focus: () => input.focus(), destroy: () => c.destroy() };
}

// ---------------------------------------------------------------- date range picker
/**
 * createDateRangePicker(container, { label, value: { start, end } | null, min, max, isDateDisabled, weekStart,
 *   presets: [{ label, start, end }], months (default 2 on wide screens, 1 on narrow), required, …, onChange({ value }) })
 */
export function createDateRangePicker(container, props = {}, services) {
  const c = setup(container, services, 'daterange');
  let p = { value: null, presets: [], ...props };
  const startIn = c.h('input', { type: 'text', autocomplete: 'off', inputmode: 'numeric' }), endIn = c.h('input', { type: 'text', autocomplete: 'off', inputmode: 'numeric' });
  const btn = c.h('button', { type: 'button', class: 'ui-inline-button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false' }, c.icon('calendar'));
  const box = c.h('div', { class: 'ui-input ui-daterange', role: 'group' }, startIn, c.h('span', { class: 'ui-affix', 'aria-hidden': 'true' }, '–'), endIn, btn);
  const f = field(c, box, { input: box, label: p.label, description: p.description, required: p.required, optional: p.optional, hideLabel: p.hideLabel, labelFor: false });
  box.setAttribute('aria-labelledby', f.ids.label);
  f.describe(startIn); f.describe(endIn);
  c.own(f.el);
  let anchor = null, hover = null, cal = null;
  const sel = () => p.value || {};
  const state = iso => {
    const v = sel(), a = anchor, s = a ? (hover && cmp(hover, a) < 0 ? hover : a) : v.start, e = a ? (hover && cmp(hover, a) > 0 ? hover : a) : v.end;
    if (!s) return {};
    return { selected: iso === s || iso === e, edge: iso === s || iso === e, inRange: e && cmp(iso, s) > 0 && cmp(iso, e) < 0 };
  };
  const refreshDays = () => { for (const b of cal?.el.querySelectorAll('.ui-day') || []) markDay(c.s, b, state(b.dataset.iso)); };
  const pop = popupController(c, box, btn, () => c.s.t('date.chooseRange'), () => {
    anchor = null; hover = null;
    const start = sel().start || todayISO();
    const months = p.months || (c.win.innerWidth < 640 ? 1 : 2);
    cal = calendarView(c, { months, month: start, focus: start, min: p.min, max: p.max, isDisabled: p.isDateDisabled, weekStart: p.weekStart, dayState: state,
      onHover: iso => { if (anchor) { hover = iso; refreshDays(); } },
      onPick: iso => {
        if (!anchor) { anchor = iso; hover = iso; refreshDays(); c.s.announce(`${c.s.t('date.start')}: ${c.s.format.date(utc(iso), { dateStyle: 'long', timeZone: 'UTC' })}`); return; }
        const [a, b] = cmp(iso, anchor) < 0 ? [iso, anchor] : [anchor, iso];
        anchor = null; commit({ start: a, end: b }, true); pop.hide();
      } });
    if (p.presets.length) {
      const presets = c.h('div', { class: 'ui-calendar-presets' }, p.presets.map(pr => { const b = c.h('button', { type: 'button', class: 'ui-button', 'data-variant': 'ghost' }, pr.label); b.addEventListener('click', () => { commit({ start: pr.start, end: pr.end }, true); pop.hide(); }); return b; }));
      cal.el.append(c.h('div', { class: 'ui-calendar-foot' }, presets));
    }
    return cal.el;
  });
  function commit(v, announce) {
    const prev = p.value; p.value = v && v.start && v.end ? v : null;
    startIn.value = p.value ? formatTyped(p.value.start, c.s.i18n.locale) : ''; endIn.value = p.value ? formatTyped(p.value.end, c.s.i18n.locale) : '';
    f.setError(p.error || (!p.value && p.required ? c.s.t('field.required') : null));
    if (JSON.stringify(prev) !== JSON.stringify(p.value)) { c.emit(f.el, 'change', { value: p.value, previous: prev }, p.onChange); if (announce && p.value) c.s.announce(c.s.format.dateRange(utc(p.value.start), utc(p.value.end), { dateStyle: 'long', timeZone: 'UTC' })); }
  }
  function render() {
    for (const [inp, k, lab] of [[startIn, 'start', 'date.start'], [endIn, 'end', 'date.end']]) { if (c.doc.activeElement !== inp) inp.value = p.value ? formatTyped(p.value[k], c.s.i18n.locale) : ''; inp.placeholder = formatTyped(todayISO(), c.s.i18n.locale); inp.setAttribute('aria-label', c.s.t(lab)); inp.disabled = !!p.disabled; inp.readOnly = !!p.readOnly; }
    btn.disabled = !!(p.disabled || p.readOnly); btn.setAttribute('aria-label', c.s.t('date.chooseRange'));
    f.setLabel(p.label); f.setDescription(p.description); f.setRequired(p.required, p.optional);
    if (p.error !== undefined) f.setError(p.error || null);
  }
  const typed = () => {
    const a = startIn.value.trim(), b = endIn.value.trim();
    if (!a && !b) { commit(null); return; }
    const s = parseTyped(a, c.s.i18n.locale), e = parseTyped(b, c.s.i18n.locale);
    if (!s || !e) { f.setError(c.s.t('date.invalid', { example: formatTyped(todayISO(), c.s.i18n.locale) })); return; }
    commit(cmp(s, e) <= 0 ? { start: s, end: e } : { start: e, end: s });
  };
  for (const inp of [startIn, endIn]) { c.on(inp, 'blur', e => { if (!pop.open && !box.contains(e.relatedTarget)) typed(); }); c.on(inp, 'keydown', e => { if (e.key === 'Enter') typed(); if (e.key === 'ArrowDown' && e.altKey) { e.preventDefault(); openCal(); } }); }
  const openCal = () => { if (pop.open) { pop.hide(); return; } pop.show(() => cal.el.querySelector('.ui-day[tabindex="0"]')); };
  c.on(btn, 'click', openCal);
  render(); container.append(f.el);
  return { root: f.el, get value() { return p.value; }, get isOpen() { return pop.open; }, open: openCal, close: () => pop.hide(), update(n) { p = { ...p, ...n }; render(); }, validate() { const m = p.required && !p.value ? c.s.t('field.required') : null; f.setError(m); return !m; }, focus: () => startIn.focus(), destroy: () => c.destroy() };
}
