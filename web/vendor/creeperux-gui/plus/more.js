import { setup, fill, uid, field, createDatePicker, createRovingFocus, autoPosition } from '../ui/index.js';
import { createTimeInput } from './inputs.js';
import { plusStrings } from './strings.js';

// Components below the standard threshold of the market audit, built for 2.4.0 (G49, D69).

// ---------------------------------------------------------------- OTP / PIN
/**
 * createOtpField(container, { label, length = 6, value, type: 'numeric'|'alphanumeric', mask, description, error,
 *   required, disabled, readOnly, hideLabel, onChange({ value, complete }), onComplete({ value }) }, services)
 * → { root, value, focus(), clear(), update, destroy }
 * A one-time code or PIN, one box per character. Typing moves to the next box, Backspace on an empty box goes back,
 * the arrows, Home and End move, and a paste or the platform's one-time-code autofill fills every box at once.
 * `mask` hides the characters (a PIN). The boxes read left to right in every direction.
 */
export function createOtpField(container, props = {}, services) {
  const c = setup(container, services, 'otp'); plusStrings(c.s);
  let p = { length: 6, value: '', type: 'numeric', ...props };
  const box = c.h('div', { class: 'ui-otp', role: 'group', dir: 'ltr' });
  let inputs = [], completed = false;
  const f = field(c, box, { input: box, label: p.label, description: p.description, error: p.error, required: p.required, hideLabel: p.hideLabel, labelFor: false });
  box.setAttribute('aria-labelledby', f.ids.label);
  const el = c.own(f.el); el.classList.add('ui-otp-field');
  const allowed = ch => (p.type === 'alphanumeric' ? /^[a-z0-9]$/i.test(ch) : /^[0-9]$/.test(ch));
  const value = () => inputs.map(i => i.value).join('');
  function build(v = p.value || '') {
    fill(box);
    inputs = Array.from({ length: p.length }, (_, i) => {
      const inp = c.h('input', { class: 'ui-otp-box', type: p.mask ? 'password' : 'text', inputmode: p.type === 'numeric' ? 'numeric' : 'text', autocomplete: i ? 'off' : 'one-time-code', spellcheck: 'false', 'aria-label': c.s.t('otp.char', { n: i + 1, count: p.length }) });
      f.describe(inp); box.append(inp);
      return inp;
    });
    set(v, false);
  }
  function set(v, emit = true) {
    const chars = [...String(v)].filter(allowed).slice(0, p.length);
    inputs.forEach((inp, i) => { inp.value = chars[i] || ''; });
    if (emit) changed();
  }
  function changed() {
    const v = value(), complete = v.length === p.length;
    c.emit(el, 'change', { value: v, complete }, p.onChange);
    if (complete && !completed) c.emit(el, 'complete', { value: v }, p.onComplete);
    completed = complete;
  }
  // typed, pasted or autofilled text fills from this box on
  function put(i, text) {
    const chars = [...text].filter(allowed);
    if (!chars.length) { inputs[i].value = ''; return; }
    for (let k = 0; k < chars.length && i + k < p.length; k++) inputs[i + k].value = chars[k];
    inputs[Math.min(p.length - 1, i + chars.length)].focus();
    changed();
  }
  const at = e => inputs.indexOf(e.target);
  c.on(box, 'input', e => { const i = at(e); if (i < 0) return; const t = e.target.value; e.target.value = ''; put(i, t); if (!t) changed(); });
  c.on(box, 'paste', e => { const i = at(e); if (i < 0) return; e.preventDefault(); if (p.readOnly) return; put(i, e.clipboardData?.getData('text') || ''); });
  c.on(box, 'keydown', e => {
    const i = at(e); if (i < 0) return;
    const go = k => { const t = inputs[Math.max(0, Math.min(p.length - 1, k))]; t.focus(); t.select?.(); };
    if (e.key === 'Backspace' && !e.target.value && i > 0 && !p.readOnly) { e.preventDefault(); inputs[i - 1].value = ''; go(i - 1); changed(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); go(i - 1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); go(i + 1); }
    else if (e.key === 'Home') { e.preventDefault(); go(0); }
    else if (e.key === 'End') { e.preventDefault(); go(p.length - 1); }
  });
  c.on(box, 'focusin', e => { if (at(e) >= 0) e.target.select?.(); });
  function render() {
    for (const inp of inputs) { inp.disabled = !!p.disabled; inp.readOnly = !!p.readOnly; }
    el.toggleAttribute('data-readonly', !!p.readOnly);
    f.setLabel(p.label); f.setDescription(p.description); f.setError(p.error); f.setRequired(p.required);
  }
  build(); render();
  container.append(el);
  return {
    root: el, get value() { return value(); },
    focus: () => (inputs.find(i => !i.value) || inputs[p.length - 1])?.focus(),
    clear() { set('', true); inputs[0]?.focus(); },
    update(n) { const rebuild = ('length' in n && n.length !== p.length) || ('mask' in n) || ('type' in n), keep = 'value' in n ? n.value || '' : value(); p = { ...p, ...n }; if (rebuild) build(keep); else if ('value' in n) set(keep, false); render(); },
    destroy: () => c.destroy(),
  };
}

// ---------------------------------------------------------------- rating
const STAR = 'M12 2.6l2.9 6 6.6.8-4.9 4.6 1.3 6.5L12 17.3l-5.9 3.2 1.3-6.5L2.5 9.4l6.6-.8z';
/**
 * createRating(container, { label, value = 0, max = 5, readOnly, disabled, allowClear = true, description, hideLabel,
 *   onChange({ value, previous }) }, services) → { root, value, update, focus, destroy }
 * Stars as a radio group: the arrows move and choose, Home and End go to one and to `max`, Delete or Backspace clears
 * (with allowClear), and a click on the chosen star clears it. Read-only shows any value, fractions included, as one
 * image named "Rated 3.5 out of 5".
 */
export function createRating(container, props = {}, services) {
  const c = setup(container, services, 'rating'); plusStrings(c.s);
  let p = { value: 0, max: 5, allowClear: true, ...props };
  const box = c.h('div', { class: 'ui-rating' });
  const f = field(c, box, { input: box, label: p.label, description: p.description, hideLabel: p.hideLabel, labelFor: false });
  const el = c.own(f.el); el.classList.add('ui-rating-field');
  let roving = null, hover = 0;
  const star = () => { const s = c.doc.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true'); s.setAttribute('class', 'ui-rating-star'); const path = c.doc.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', STAR); s.append(path); return s; };
  function render() {
    roving?.destroy(); roving = null;
    const shownValue = hover || p.value;
    box.removeAttribute('role'); box.removeAttribute('aria-label'); box.removeAttribute('aria-disabled');
    box.setAttribute('aria-labelledby', f.ids.label);
    if (p.readOnly) {
      // one image: the value as text, the stars filled to the fraction
      box.setAttribute('role', 'img'); box.removeAttribute('aria-labelledby');
      box.setAttribute('aria-label', `${p.label ? `${p.label}: ` : ''}${c.s.t('rating.rated', { value: c.s.format.number(p.value, { maximumFractionDigits: 1 }), max: p.max })}`);
      fill(box, Array.from({ length: p.max }, (_, i) => c.h('span', { class: 'ui-rating-item', style: `--ui-fill:${Math.max(0, Math.min(1, p.value - i)) * 100}%` }, star(), star())));
    } else {
      box.setAttribute('role', 'radiogroup');
      if (p.disabled) box.setAttribute('aria-disabled', 'true');
      fill(box, Array.from({ length: p.max }, (_, i) => {
        const n = i + 1;
        return c.h('span', { class: 'ui-rating-item', role: 'radio', 'aria-checked': String(p.value === n), 'aria-label': c.s.t('rating.stars', { n }), 'aria-disabled': p.disabled ? 'true' : null, 'data-n': n, style: `--ui-fill:${n <= shownValue ? 100 : 0}%` }, star(), star());
      }));
      if (!p.disabled) roving = createRovingFocus(box, { items: () => [...box.querySelectorAll('[role="radio"]')], orientation: 'both', loop: false });
      // with nothing chosen the first star is the tab stop; its name says what it chooses
    }
    el.toggleAttribute('data-readonly', !!p.readOnly);
    el.toggleAttribute('data-disabled', !!p.disabled);
    f.setLabel(p.label); f.setDescription(p.description);
  }
  function choose(n, focus = true) {
    if (p.readOnly || p.disabled) return;
    const previous = p.value;
    n = Math.max(0, Math.min(p.max, n));
    if (n === previous) return;
    p.value = n; hover = 0; render();
    if (focus) (box.querySelector(`[data-n="${n || 1}"]`))?.focus();
    c.emit(el, 'change', { value: n, previous }, p.onChange);
  }
  c.on(box, 'click', e => { const it = e.target.closest('[role="radio"]'); if (!it) return; const n = Number(it.dataset.n); choose(n === p.value && p.allowClear ? 0 : n); });
  c.on(box, 'keydown', e => {
    const it = e.target.closest?.('[role="radio"]'); if (!it || p.readOnly || p.disabled) return;
    const dir = c.win.getComputedStyle(box).direction === 'rtl' ? -1 : 1, n = Number(it.dataset.n);
    const step = { ArrowRight: dir, ArrowLeft: -dir, ArrowUp: 1, ArrowDown: -1 }[e.key];
    if (step) { e.preventDefault(); e.stopPropagation(); choose(Math.max(1, (p.value || (step > 0 ? 0 : n + 1)) + step)); }
    else if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); e.stopPropagation(); choose(e.key === 'Home' ? 1 : p.max); }
    else if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); choose(n); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && p.allowClear) { e.preventDefault(); choose(0, false); box.querySelector('[data-n="1"]')?.focus(); }
  }, { capture: true });
  // a fine pointer previews the value under it
  c.on(box, 'pointerover', e => { if (e.pointerType !== 'mouse' || p.readOnly || p.disabled) return; const it = e.target.closest('[role="radio"]'); if (it) { hover = Number(it.dataset.n); paintHover(); } });
  c.on(box, 'pointerleave', () => { if (hover) { hover = 0; paintHover(); } });
  const paintHover = () => box.querySelectorAll('[role="radio"]').forEach(it => it.style.setProperty('--ui-fill', `${Number(it.dataset.n) <= (hover || p.value) ? 100 : 0}%`));
  c.cleanup(() => roving?.destroy());
  render();
  container.append(el);
  return { root: el, get value() { return p.value; }, update(n) { p = { ...p, ...n }; render(); }, focus: () => (box.querySelector('[role="radio"][tabindex="0"]') || box.querySelector('[role="radio"]'))?.focus(), destroy: () => c.destroy() };
}

// ---------------------------------------------------------------- hover card
/**
 * createHoverCard(trigger, { content: Node | (body) => void, placement = 'bottom-start', delay = 500, closeDelay = 300,
 *   onOpenChange({ open }) }, services) → { open(), close(), isOpen, update, destroy }
 * A preview of what a link or name points to (a person, an issue), shown while the pointer rests on it or keyboard
 * focus is on it. The pointer can move into the card; Escape, leaving both, or a press elsewhere closes it. It is
 * supplementary: keep the same information reachable from the link itself (touch screens have no hover).
 */
export function createHoverCard(trigger, props = {}, services) {
  const c = setup(trigger.parentElement || trigger, services, 'hovercard'); plusStrings(c.s);
  let p = { placement: 'bottom-start', delay: 500, closeDelay: 300, ...props };
  const card = c.h('div', { class: 'ui-hovercard', id: uid('hvc'), hidden: true });
  c.s.overlays.portal.append(card);
  let handle = null, pos = null, openTimer = 0, closeTimer = 0;
  const clear = () => { clearTimeout(openTimer); clearTimeout(closeTimer); };
  function open() {
    clear();
    if (handle) return;
    fill(card); if (typeof p.content === 'function') p.content(card); else fill(card, p.content);
    handle = c.s.overlays.open(card, { kind: 'menu', trigger, initialFocus: false, restoreFocus: false, dismissOnOutside: true, onDismiss: () => close() });
    pos = autoPosition(trigger, card, { placement: p.placement, offset: 6 });
    c.s.motion.animate(card, { o: 1, y: 0 }, { role: 'enter', from: { o: 0, y: -2 } });
    c.emit(trigger, 'open-change', { open: true }, p.onOpenChange);
  }
  function close() {
    clear();
    if (!handle) return;
    const h = handle; handle = null; h.close(); pos?.cleanup(); pos = null;
    card.hidden = true; c.s.motion.reset(card);
    c.emit(trigger, 'open-change', { open: false }, p.onOpenChange);
  }
  const later = () => { clearTimeout(openTimer); clearTimeout(closeTimer); closeTimer = setTimeout(close, p.closeDelay); };
  const soon = () => { clearTimeout(closeTimer); if (!handle) { clearTimeout(openTimer); openTimer = setTimeout(open, p.delay); } };
  for (const node of [trigger, card]) {
    c.on(node, 'pointerenter', e => { if (e.pointerType !== 'touch') soon(); });
    c.on(node, 'pointerleave', e => { if (e.pointerType !== 'touch') later(); });
  }
  c.on(trigger, 'focus', () => { if (trigger.matches(':focus-visible')) open(); });
  c.on(trigger, 'blur', e => { if (!card.contains(e.relatedTarget)) later(); });
  c.on(card, 'focusout', e => { if (!card.contains(e.relatedTarget) && e.relatedTarget !== trigger) later(); });
  c.cleanup(() => { clear(); if (handle) { handle.close(); pos?.cleanup(); } card.remove(); });
  return { open, close, get isOpen() { return !!handle; }, element: card, update(n) { p = { ...p, ...n }; if (handle) { fill(card); if (typeof p.content === 'function') p.content(card); else fill(card, p.content); } }, destroy: () => c.destroy() };
}

// ---------------------------------------------------------------- filter chips
/**
 * createFilterChips(container, { label, options: [{ value, label, count, icon, disabled }], value: [], multiple = true,
 *   clearable = true, onChange({ value }) }, services) → { root, value, update, focus, destroy }
 * Quick filters as toggle buttons (aria-pressed) with a check when on and an optional count. With `multiple: false`
 * turning one on turns the others off. "Clear filters" appears while any is on.
 */
export function createFilterChips(container, props = {}, services) {
  const c = setup(container, services, 'chips'); plusStrings(c.s);
  let p = { options: [], value: [], multiple: true, clearable: true, ...props };
  const el = c.own(c.h('div', { class: 'ui-chips', role: 'group' }));
  const value = () => [].concat(p.value ?? []);
  function render() {
    if (p.label) el.setAttribute('aria-label', p.label); else el.removeAttribute('aria-label');
    const on = new Set(value());
    fill(el, p.options.map(o => c.h('button', { type: 'button', class: 'ui-chip-toggle', 'aria-pressed': String(on.has(o.value)), disabled: o.disabled || p.disabled || null, 'data-value': String(o.value) },
      c.icon(on.has(o.value) ? 'check' : o.icon || 'filter'), c.h('span', {}, o.label),
      o.count != null ? c.h('span', { class: 'ui-chip-count' }, c.h('span', { 'aria-hidden': 'true' }, c.s.format.number(o.count)), c.h('span', { class: 'ui-visually-hidden' }, `, ${c.s.t('chips.count', { count: o.count })}`)) : null)),
      p.clearable && on.size ? c.h('button', { type: 'button', class: 'ui-button ui-chips-clear', 'data-variant': 'ghost' }, c.s.t('empty.clearFilters')) : null);
  }
  c.on(el, 'click', e => {
    const b = e.target.closest('button'); if (!b || b.disabled) return;
    if (b.classList.contains('ui-chips-clear')) { p.value = []; render(); el.querySelector('.ui-chip-toggle:not([disabled])')?.focus(); c.emit(el, 'change', { value: [] }, p.onChange); return; }
    const v = p.options.find(o => String(o.value) === b.dataset.value)?.value, on = value();
    p.value = on.includes(v) ? on.filter(x => x !== v) : p.multiple ? [...on, v] : [v];
    render();
    el.querySelector(`.ui-chip-toggle[data-value="${CSS.escape(String(v))}"]`)?.focus();
    c.emit(el, 'change', { value: value() }, p.onChange);
  });
  render();
  container.append(el);
  return { root: el, get value() { return value(); }, update(n) { p = { ...p, ...n }; render(); }, focus: () => el.querySelector('button:not([disabled])')?.focus(), destroy: () => c.destroy() };
}

// ---------------------------------------------------------------- tree grid
/**
 * createTreeGrid(container, { label, columns: [{ id, label, width, align, cell(row) }], rows: [{ id, children,
 *   hasChildren, loading, loadError, …data }], expanded: [], onToggle({ id, open, row }), onRowAction({ id, row }),
 *   onRetry({ id, row }) }, services) → { root, expanded, expand(id, open), focus(id), update, destroy }
 * Rows with children in columns (APG treegrid, row focus): ↑ ↓ move, → opens a row or moves to its first child, ←
 * closes it or moves to its parent (both mirrored in RTL), Home / End, Enter runs onRowAction. Children load lazily as
 * in the tree: `hasChildren` without `children` shows "Loading…", `loadError` an error with Retry, `children: []`
 * "No items". The first column carries the indent and the open / close button.
 */
export function createTreeGrid(container, props = {}, services) {
  const c = setup(container, services, 'treegrid'); plusStrings(c.s);
  let p = { columns: [], rows: [], ...props };
  let open = new Set(p.expanded || []), focusId = null;
  const head = c.h('div', { class: 'ui-tg-row ui-tg-head', role: 'row' });
  const body = c.h('div', { class: 'ui-tg-body', role: 'rowgroup' });
  const el = c.own(c.h('div', { class: 'ui-treegrid', role: 'treegrid' }, c.h('div', { role: 'rowgroup' }, head), body));
  const kids = r => (Array.isArray(r.children) && r.children.length ? r.children : null);
  const opens = r => !!(kids(r) || r.hasChildren);
  const statusOf = r => (r.loadError ? 'error' : r.loading || (r.hasChildren && !Array.isArray(r.children)) ? 'loading' : r.hasChildren && !kids(r) ? 'empty' : null);
  const byId = new Map();
  function rowsFlat() {
    const out = [];
    const walk = (list, level, parent) => list.forEach((r, i) => {
      byId.set(r.id, { r, parent });
      out.push({ r, level, pos: i + 1, size: list.length, parent });
      if (opens(r) && open.has(r.id)) { const st = statusOf(r); if (st) out.push({ status: st, r, level: level + 1, parent: r.id }); else walk(r.children, level + 1, r.id); }
    });
    byId.clear(); walk(p.rows, 1, null);
    return out;
  }
  function render() {
    el.setAttribute('aria-label', p.label || '');
    el.style.setProperty('--ui-tg-cols', p.columns.map(col => col.width || 'minmax(0, 1fr)').join(' '));
    fill(head, p.columns.map(col => c.h('div', { class: 'ui-tg-cell', role: 'columnheader', 'data-align': col.align || null }, col.label)));
    const had = el.contains(c.doc.activeElement) ? c.doc.activeElement.closest('[role="row"]')?.dataset.key : null;
    fill(body, rowsFlat().map(x => {
      if (x.status) {
        const text = x.status === 'loading' ? c.s.t('loading') : x.status === 'empty' ? c.s.t('tree.empty') : typeof x.r.loadError === 'string' ? x.r.loadError : c.s.t('error.load');
        return c.h('div', { class: 'ui-tg-row ui-tg-status', role: 'row', 'aria-level': x.level, tabindex: '-1', 'data-key': `status:${x.parent}`, 'data-status': x.status },
          c.h('div', { class: 'ui-tg-cell', role: 'gridcell', style: `--ui-depth:${x.level - 1}`, 'aria-colspan': p.columns.length }, x.status === 'loading' ? c.h('span', { class: 'ui-spinner', 'aria-hidden': 'true' }) : null, text, x.status === 'error' ? c.h('span', { class: 'ui-tg-retry' }, c.s.t('retry')) : null));
      }
      const exp = opens(x.r) ? String(open.has(x.r.id)) : null;
      return c.h('div', { class: 'ui-tg-row', role: 'row', 'aria-level': x.level, 'aria-posinset': x.pos, 'aria-setsize': x.size, 'aria-expanded': exp, 'aria-busy': exp === 'true' && statusOf(x.r) === 'loading' ? 'true' : null, tabindex: '-1', 'data-key': `row:${x.r.id}` },
        p.columns.map((col, k) => c.h('div', { class: 'ui-tg-cell', role: 'gridcell', 'data-align': col.align || null, style: k ? null : `--ui-depth:${x.level - 1}` },
          k === 0 ? c.h('span', { class: 'ui-tg-toggle', 'aria-hidden': 'true' }, opens(x.r) ? c.icon('chevron-right') : null) : null,
          col.cell ? col.cell(x.r) : x.r[col.id] ?? '')));
    }));
    const rows = [...body.children];
    const target = rows.find(r => r.dataset.key === (had || focusId)) || rows.find(r => r.dataset.key === `row:${focusId}`) || rows[0];
    rows.forEach(r => { r.tabIndex = r === target ? 0 : -1; });
    if (had && target) target.focus({ preventScroll: true });
  }
  const rowOf = n => n?.closest?.('[role="row"]');
  const idOf = row => (row?.dataset.key?.startsWith('row:') ? row.dataset.key.slice(4) : null);
  const realId = key => { for (const id of byId.keys()) if (String(id) === key) return id; return key; };
  function focusRow(row) { if (!row) return; for (const r of body.children) r.tabIndex = r === row ? 0 : -1; row.focus(); focusId = idOf(row) ?? focusId; }
  function toggle(id, want) {
    const node = byId.get(id); if (!node || !opens(node.r)) return;
    const now = open.has(id); want = want ?? !now; if (want === now) return;
    if (want) open.add(id); else open.delete(id);
    focusId = id;
    const keep = el.contains(c.doc.activeElement);
    render();
    if (keep) focusRow([...body.children].find(r => r.dataset.key === `row:${id}`));
    c.emit(el, 'toggle', { id, open: want, row: node.r }, p.onToggle);
  }
  c.on(body, 'keydown', e => {
    const row = rowOf(e.target); if (!row || e.target !== row) return;
    const rows = [...body.children], i = rows.indexOf(row), id = idOf(row) != null ? realId(idOf(row)) : null;
    const rtl = c.win.getComputedStyle(el).direction === 'rtl', into = rtl ? 'ArrowLeft' : 'ArrowRight', out = rtl ? 'ArrowRight' : 'ArrowLeft';
    const isOpen = row.getAttribute('aria-expanded') === 'true';
    if (e.key === 'ArrowDown') { e.preventDefault(); focusRow(rows[i + 1]); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); focusRow(rows[i - 1]); }
    else if (e.key === 'Home') { e.preventDefault(); focusRow(rows[0]); }
    else if (e.key === 'End') { e.preventDefault(); focusRow(rows[rows.length - 1]); }
    else if (e.key === into && id != null) { e.preventDefault(); if (row.hasAttribute('aria-expanded') && !isOpen) toggle(id, true); else if (isOpen) focusRow(rows[i + 1]); }
    else if (e.key === out) {
      e.preventDefault();
      if (isOpen && id != null) toggle(id, false);
      else { const parent = row.dataset.key.startsWith('status:') ? row.dataset.key.slice(7) : byId.get(id)?.parent; if (parent != null) focusRow(rows.find(r => r.dataset.key === `row:${parent}`)); }
    }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (row.dataset.status === 'error') { const pid = realId(row.dataset.key.slice(7)); c.emit(el, 'retry', { id: pid, row: byId.get(pid)?.r }, p.onRetry); }
      else if (id != null) c.emit(el, 'row-action', { id, row: byId.get(id).r }, p.onRowAction);
    }
  });
  c.on(body, 'click', e => {
    const row = rowOf(e.target); if (!row) return;
    focusRow(row);
    if (row.dataset.status === 'error') { const pid = realId(row.dataset.key.slice(7)); c.emit(el, 'retry', { id: pid, row: byId.get(pid)?.r }, p.onRetry); return; }
    const id = idOf(row) != null ? realId(idOf(row)) : null; if (id == null) return;
    if (e.target.closest('.ui-tg-toggle')) toggle(id); else c.emit(el, 'row-action', { id, row: byId.get(id).r }, p.onRowAction);
  });
  render();
  container.append(el);
  return {
    root: el, get expanded() { return [...open]; },
    expand: (id, want = true) => toggle(id, want),
    focus(id) { const row = [...body.children].find(r => id == null ? r.tabIndex === 0 : r.dataset.key === `row:${id}`); focusRow(row || body.firstElementChild); },
    update(n) { p = { ...p, ...n }; if ('expanded' in n) open = new Set(n.expanded || []); render(); },
    destroy: () => c.destroy(),
  };
}

// ---------------------------------------------------------------- date and time
/**
 * createDateTimePicker(container, { label, value: 'YYYY-MM-DDTHH:MM' | null, min, max, description, error, required,
 *   disabled, readOnly, hideLabel, onChange({ value, date, time, previous }) }, services) → { root, value, update, focus, destroy }
 * A date (with its calendar) and a time (the segmented field) under one label. The value is set once both parts are,
 * as local date-time text; `min` and `max` bound the date, and a value outside them is reported as an error.
 */
export function createDateTimePicker(container, props = {}, services) {
  const c = setup(container, services, 'datetime'); plusStrings(c.s);
  let p = { value: null, ...props };
  const box = c.h('div', { class: 'ui-datetime', role: 'group' });
  const f = field(c, box, { input: box, label: p.label, description: p.description, error: p.error, required: p.required, hideLabel: p.hideLabel, labelFor: false });
  box.setAttribute('aria-labelledby', f.ids.label);
  const el = c.own(f.el); el.classList.add('ui-datetime-field');
  const split = v => (v ? [v.slice(0, 10), v.slice(11, 16) || null] : [null, null]);
  let [date, time] = split(p.value);
  const value = () => (date && time ? `${date}T${time}` : null);
  const check = v => (v && ((p.min && v < p.min) || (p.max && v > p.max)) ? c.s.t('datetime.range') : null);
  function changed() {
    const previous = p.value, v = value();
    p.value = v;
    f.setError(p.error || check(v));
    c.emit(el, 'change', { value: v, date, time, previous }, p.onChange);
  }
  const dp = createDatePicker(box, { label: c.s.t('datetime.date'), hideLabel: true, value: date, min: p.min?.slice(0, 10), max: p.max?.slice(0, 10), disabled: p.disabled, readOnly: p.readOnly, onChange: e => { date = e.value; changed(); } }, c.s);
  const tp = createTimeInput(box, { label: c.s.t('datetime.time'), hideLabel: true, value: time, disabled: p.disabled, readOnly: p.readOnly, onChange: e => { time = e.value; changed(); } }, c.s);
  c.cleanup(() => { dp.destroy(); tp.destroy(); });
  f.setError(p.error || check(value()));
  container.append(el);
  return {
    root: el, get value() { return value(); },
    update(n) {
      p = { ...p, ...n };
      if ('value' in n) { [date, time] = split(n.value); dp.update({ value: date }); tp.update({ value: time }); }
      dp.update({ disabled: p.disabled, readOnly: p.readOnly, min: p.min?.slice(0, 10), max: p.max?.slice(0, 10) }); tp.update({ disabled: p.disabled, readOnly: p.readOnly });
      f.setLabel(p.label); f.setDescription(p.description); f.setError(p.error || check(value()));
    },
    focus: () => dp.focus(), destroy: () => c.destroy(),
  };
}

// ---------------------------------------------------------------- colour swatches
const luminance = hex => { const n = parseInt(hex.slice(1), 16), ch = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * ch(n >> 16) + 0.7152 * ch((n >> 8) & 255) + 0.0722 * ch(n & 255); };
/**
 * createSwatchPicker(container, { label, value: '#rrggbb' | null, swatches: ['#hex' | { value, name }], description,
 *   hideLabel, disabled, onChange({ value, previous }) }, services) → { root, value, update, focus, destroy }
 * A choice among named colours, as a radio group: the arrows move and choose (wrapping), Home and End. Each swatch is
 * named by its name or its hex value; the chosen one carries a check drawn light or dark against its colour.
 */
export function createSwatchPicker(container, props = {}, services) {
  const c = setup(container, services, 'swatches'); plusStrings(c.s);
  let p = { swatches: [], value: null, ...props };
  const box = c.h('div', { class: 'ui-swatches', role: 'radiogroup' });
  const f = field(c, box, { input: box, label: p.label, description: p.description, hideLabel: p.hideLabel, labelFor: false });
  box.setAttribute('aria-labelledby', f.ids.label);
  const el = c.own(f.el); el.classList.add('ui-swatches-field');
  let roving = null;
  const list = () => p.swatches.map(s => (typeof s === 'string' ? { value: s.toLowerCase(), name: s.toLowerCase() } : { value: s.value.toLowerCase(), name: s.name || s.value.toLowerCase() }));
  function render() {
    roving?.destroy(); roving = null;
    const v = p.value?.toLowerCase() ?? null;
    if (p.disabled) box.setAttribute('aria-disabled', 'true'); else box.removeAttribute('aria-disabled');
    fill(box, list().map(s => c.h('span', { class: 'ui-swatch', role: 'radio', 'aria-checked': String(s.value === v), 'aria-label': s.name, 'aria-disabled': p.disabled ? 'true' : null, 'data-value': s.value, 'data-light': luminance(s.value) > 0.4 ? '' : null, style: `--ui-sw:${s.value}` }, s.value === v ? c.icon('check') : null)));
    if (!p.disabled) roving = createRovingFocus(box, { items: () => [...box.querySelectorAll('[role="radio"]')], orientation: 'both', loop: true, onMove: it => choose(it.dataset.value, false) });
    f.setLabel(p.label); f.setDescription(p.description);
  }
  function choose(value, focus = true) {
    if (p.disabled || value === p.value?.toLowerCase()) return;
    const previous = p.value ?? null;
    p.value = value; render();
    const it = box.querySelector(`[data-value="${value}"]`);
    if (focus) it?.focus(); else roving?.focus(it);
    c.emit(el, 'change', { value, previous }, p.onChange);
  }
  c.on(box, 'click', e => { const it = e.target.closest('[role="radio"]'); if (it) choose(it.dataset.value); });
  c.on(box, 'keydown', e => { const it = e.target.closest?.('[role="radio"]'); if (it && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); choose(it.dataset.value); } });
  c.cleanup(() => roving?.destroy());
  render();
  container.append(el);
  return { root: el, get value() { return p.value ?? null; }, update(n) { p = { ...p, ...n }; render(); }, focus: () => (box.querySelector('[role="radio"][tabindex="0"]') || box.querySelector('[role="radio"]'))?.focus(), destroy: () => c.destroy() };
}
