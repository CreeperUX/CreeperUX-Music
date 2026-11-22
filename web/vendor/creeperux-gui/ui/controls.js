import { setup, fill, field, validateValue, uid } from './base.js';
import { createAsyncAction } from '../async-action.js';
import { pendingValue } from './pending.js';
import { createRovingFocus } from '../interaction.js';
import { PRESS_SCALE } from '../tokens.js';

// ---------------------------------------------------------------- press feedback (press / release roles)
function pressFeedback(c, el) {
  c.on(el, 'pointerdown', e => { if (e.button || el.disabled || el.getAttribute('aria-disabled') === 'true') return; c.s.motion.animate(el, { sx: PRESS_SCALE, sy: PRESS_SCALE }, { role: 'press' }); });
  const up = () => c.s.motion.animate(el, { sx: 1, sy: 1 }, { role: 'release' });
  c.on(el, 'pointerup', up); c.on(el, 'pointerleave', up); c.on(el, 'pointercancel', up);
}

// ---------------------------------------------------------------- button
/**
 * createButton(container, { label, icon, iconEnd, variant: 'secondary'|'primary'|'ghost'|'danger', iconOnly, disabled,
 *   busy, pressed (toggle when boolean), type, describedBy, onClick, onPressedChange })
 */
export function createButton(container, props = {}, services) {
  const c = setup(container, services, 'button');
  let p = { variant: 'secondary', type: 'button', ...props };
  const el = c.own(c.h('button', { class: 'ui-button', type: p.type }));
  pressFeedback(c, el);
  function render() {
    el.dataset.variant = p.variant;
    el.toggleAttribute('data-icon-only', !!p.iconOnly);
    if (p.iconOnly && p.label) el.setAttribute('aria-label', p.label); else el.removeAttribute('aria-label');
    el.disabled = !!p.disabled;
    if (p.busy) { el.setAttribute('aria-busy', 'true'); el.setAttribute('aria-disabled', 'true'); } else { el.removeAttribute('aria-busy'); if (!p.disabled) el.removeAttribute('aria-disabled'); }
    if (typeof p.pressed === 'boolean') el.setAttribute('aria-pressed', String(p.pressed)); else el.removeAttribute('aria-pressed');
    if (p.describedBy) el.setAttribute('aria-describedby', p.describedBy);
    if (p.haspopup) el.setAttribute('aria-haspopup', p.haspopup);
    fill(el,
      p.busy ? c.h('span', { class: 'ui-spinner', 'aria-hidden': 'true' }) : p.icon ? c.icon(p.icon) : null,
      p.iconOnly ? null : c.h('span', { class: 'ui-button-label' }, p.label ?? ''),
      p.iconEnd && !p.iconOnly ? c.icon(p.iconEnd) : null);
  }
  c.on(el, 'click', e => {
    if (p.busy || el.getAttribute('aria-disabled') === 'true') { e.preventDefault(); return; }
    if (typeof p.pressed === 'boolean') c.emit(el, 'pressed-change', { pressed: !p.pressed, previous: p.pressed }, p.onPressedChange);
    c.emit(el, 'click', { event: e }, p.onClick);
  });
  render();
  container.append(el);
  return { root: el, element: el, update(n) { p = { ...p, ...n }; render(); }, focus: () => el.focus(), destroy: () => c.destroy() };
}
/** createIconButton(container, { label, icon, … }, services) — a ghost button that shows only its icon; `label` stays its accessible name and tooltip text. */
export const createIconButton = (container, props, services) => createButton(container, { variant: 'ghost', ...props, iconOnly: true }, services);
/** createToggleButton(container, { label, pressed, onPressedChange({ pressed, previous }) }, services) — a button with aria-pressed; the host owns `pressed`. */
export const createToggleButton = (container, props, services) => createButton(container, { pressed: false, ...props }, services);

/**
 * createButtonGroup(container, { label, buttons: [{ id, …button props }], disabled, onClick({ id, event }) }, services)
 * Related actions attached side by side (G37): a named role="group" of ordinary buttons, each its own Tab stop, with
 * shared edges. Use the segmented control for one choice among options, and a toolbar for many tools.
 */
export function createButtonGroup(container, props = {}, services) {
  const c = setup(container, services, 'button-group');
  let p = { buttons: [], ...props };
  const el = c.own(c.h('div', { class: 'ui-button-group', role: 'group' }));
  let handles = [];
  function render() {
    if (p.label) el.setAttribute('aria-label', p.label); else el.removeAttribute('aria-label');
    for (const b of handles) b.destroy();
    handles = p.buttons.map(b => createButton(el, { ...b, disabled: p.disabled || b.disabled, onClick: e => { b.onClick?.(e); c.emit(el, 'click', { id: b.id, event: e.event }, p.onClick); } }, c.s));
  }
  c.cleanup(() => { for (const b of handles) b.destroy(); });
  render(); container.append(el);
  return { root: el, get buttons() { return handles.slice(); }, update(n) { p = { ...p, ...n }; render(); }, focus: () => handles.find(b => !b.element.disabled)?.focus(), destroy: () => c.destroy() };
}

// ---------------------------------------------------------------- text-like fields
function textLike(kind) {
  return function create(container, props = {}, services) {
    const c = setup(container, services, kind);
    let p = { value: '', validateOn: 'blur', ...props };
    const isArea = kind === 'textarea';
    const input = c.h(isArea ? 'textarea' : 'input', { class: null });
    if (!isArea) input.type = p.type || (kind === 'search' ? 'search' : 'text');
    if (['tel', 'email', 'url'].includes(input.type)) input.dir = 'ltr'; // phone numbers and addresses read left to right in every language
    const box = c.h('div', { class: 'ui-input' });
    const prefix = c.h('span', { class: 'ui-affix', hidden: true }), suffix = c.h('span', { class: 'ui-affix', hidden: true });
    const clearBtn = c.h('button', { type: 'button', class: 'ui-inline-button', hidden: true, tabindex: '-1' }, c.icon('close'));
    // A toggle button keeps one name ("Show password"); aria-pressed says whether the password is shown.
    const reveal = kind === 'text' && p.type === 'password' && p.reveal !== false ? c.h('button', { type: 'button', class: 'ui-inline-button', 'aria-pressed': 'false' }, c.icon('eye')) : null;
    const spin = c.h('span', { class: 'ui-spinner', 'aria-hidden': 'true', hidden: true }); // a host check is running (G17)
    box.append(...[kind === 'search' ? c.icon('search') : null, prefix, input, suffix, spin, clearBtn, reveal].filter(Boolean));
    const f = field(c, box, { input, label: p.label, description: p.description, required: p.required, optional: p.optional, hideLabel: p.hideLabel });
    c.own(f.el);
    // unshowable: the host's value is not what the input shows, e.g. line breaks in a one-line field (G20)
    let touched = false, composing = false, committed = p.value, unshowable = false;
    const value = () => input.value;
    // A host check, validate(value, signal), may answer with a promise (G17). Built-in rules run first. While the check
    // runs a spinner sits in the field and the input is aria-busy; a newer value aborts the older check and its late
    // answer is ignored (latest wins). Once a check has answered late, typing waits validateDelay ms before checking
    // again; blur, validate() and validateAsync() check at once. The last answer is kept for its value, so a submit
    // right after blur does not ask twice. A check that throws or rejects counts as passed: the server has the final say.
    let run = null, wait = 0, known = null, slow = false;
    function busy(on) { spin.hidden = !on; if (on) input.setAttribute('aria-busy', 'true'); else input.removeAttribute('aria-busy'); }
    function stop() { c.win.clearTimeout(wait); wait = 0; if (run) { const r = run; run = null; r.ctl.abort(); busy(false); r.end(); } } // waiters move on even if the host ignores the abort
    function ask(v) {
      if (known && known.value === v) { stop(); f.setError(known.msg); return !known.msg; } // an older check for another value is dropped
      if (run && run.value === v) return false; // this value is being checked already
      stop();
      const ctl = new AbortController();
      let answer; try { answer = p.validate(v, ctl.signal); } catch { answer = null; }
      if (typeof answer?.then !== 'function') { f.setError(answer || null); return !answer; }
      slow = true;
      const me = run = { value: v, ctl };
      me.done = new Promise(res => { me.end = res; });
      Promise.resolve(answer).then(m => m || null, () => null).then(msg => {
        if (run !== me) return; // superseded or stopped
        run = null; busy(false); known = { value: v, msg };
        if (value() === v) f.setError(p.error || msg);
        me.end();
      });
      busy(true);
      return false;
    }
    function check(force, typing) {
      if (!force && !touched && !p.error && !unshowable) return;
      if (p.error) { stop(); f.setError(p.error); return false; }
      const v = value(), msg = validateValue(c, v, { ...p, validate: null }) || (unshowable ? c.s.t('field.unshowable') : null);
      if (msg || !p.validate) { stop(); f.setError(msg); return !msg; }
      if (typing && slow && !(known && known.value === v)) { stop(); wait = c.win.setTimeout(() => { wait = 0; ask(value()); }, p.validateDelay ?? 400); return false; }
      return ask(v);
    }
    c.cleanup(stop);
    function autosize() { if (isArea && p.autosize !== false) { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight + 2, p.maxHeight || 400)}px`; } }
    function render() {
      const flagged = unshowable;
      if (input.value !== String(p.value ?? '') && c.doc.activeElement !== input) { input.value = p.value ?? ''; unshowable = typeof p.value === 'string' && input.value !== p.value; }
      input.placeholder = p.placeholder ?? '';
      input.readOnly = !!p.readOnly; input.disabled = !!p.disabled;
      box.toggleAttribute('data-readonly', !!p.readOnly); box.toggleAttribute('data-disabled', !!p.disabled);
      for (const [k, a] of [['autocomplete', 'autocomplete'], ['inputMode', 'inputmode'], ['name', 'name'], ['maxLength', 'maxlength'], ['spellcheck', 'spellcheck'], ['rows', 'rows']]) { if (p[k] != null) input.setAttribute(a, String(p[k])); else input.removeAttribute(a); }
      if (p.ariaLabel) input.setAttribute('aria-label', p.ariaLabel);
      prefix.textContent = p.prefix ?? ''; prefix.hidden = !p.prefix;
      suffix.textContent = p.suffix ?? ''; suffix.hidden = !p.suffix;
      clearBtn.setAttribute('aria-label', c.s.t('clear'));
      reveal?.setAttribute('aria-label', c.s.t('password.show'));
      clearBtn.hidden = !((p.clearable || kind === 'search') && input.value && !p.readOnly && !p.disabled);
      f.setLabel(p.label); f.setDescription(p.description); f.setRequired(p.required, p.optional);
      if (p.counter && p.maxLength) f.setCounter(`${[...input.value].length} / ${p.maxLength}`); else f.setCounter(null);
      if (p.error !== undefined || unshowable) check(true); else if (flagged) { if (touched) check(true); else f.setError(null); }
      autosize();
    }
    c.on(input, 'compositionstart', () => { composing = true; });
    c.on(input, 'compositionend', () => { composing = false; c.emit(f.el, 'input', { value: value() }, p.onInput); });
    c.on(input, 'input', () => {
      unshowable = false; // what the person typed is what the field holds
      clearBtn.hidden = !((p.clearable || kind === 'search') && input.value);
      if (p.counter && p.maxLength) f.setCounter(`${[...input.value].length} / ${p.maxLength}`);
      autosize();
      if (f.error || p.validateOn === 'input') check(true, true);
      if (!composing) c.emit(f.el, 'input', { value: value() }, p.onInput);
    });
    const commit = () => { if (value() !== committed) { committed = value(); c.emit(f.el, 'change', { value: committed }, p.onChange); } };
    c.on(input, 'blur', () => { touched = true; if (p.validateOn !== 'submit') check(true); commit(); });
    c.on(input, 'keydown', e => {
      if (e.key === 'Enter' && !isArea && !composing) { commit(); if (kind === 'search') c.emit(f.el, 'search', { value: value() }, p.onSearch); }
      if (e.key === 'Escape' && kind === 'search' && input.value) { e.preventDefault(); e.stopPropagation(); input.value = ''; input.dispatchEvent(new c.win.Event('input', { bubbles: true })); commit(); }
      // Escape restores the last committed value; only an unchanged field lets Escape through, to close a dialog say (G20)
      else if (e.key === 'Escape' && kind !== 'search' && !composing && !e.isComposing && !p.readOnly && input.value !== String(committed ?? '')) {
        e.preventDefault(); e.stopPropagation();
        const typed = input.value; input.value = committed ?? '';
        input.dispatchEvent(new c.win.Event('input', { bubbles: true }));
        c.emit(f.el, 'cancel', { value: input.value, previous: typed }, p.onCancel);
      }
    });
    c.on(clearBtn, 'click', () => { input.value = ''; input.dispatchEvent(new c.win.Event('input', { bubbles: true })); commit(); input.focus(); });
    if (reveal) c.on(reveal, 'click', () => { const show = input.type === 'password'; input.type = show ? 'text' : 'password'; reveal.setAttribute('aria-pressed', String(show)); fill(reveal, c.icon(show ? 'eye-off' : 'eye')); });
    render();
    container.append(f.el);
    return {
      root: f.el, input,
      get value() { return value(); },
      update(n) { p = { ...p, ...n }; if ('value' in n) committed = n.value ?? ''; if ('validate' in n) { stop(); known = null; slow = false; } render(); },
      /** Checks now. With a host check still running it returns false: await validateAsync() for the answer. */
      validate() { touched = true; return check(true); },
      /** Checks now and resolves once every check has answered, for the value the field holds by then. */
      async validateAsync() { touched = true; let ok = check(true); while (run) { await run.done; ok = check(true); } return ok; },
      get checking() { return !!run || !!wait; },
      focus: () => input.focus(),
      destroy: () => c.destroy(),
    };
  };
}
/**
 * createTextField(container, { label, value, type, placeholder, description, error, required, optional, readOnly, disabled,
 *   prefix, suffix, clearable, minLength, maxLength, pattern, patternMessage, counter, reveal (password), validate(v, signal),
 *   validateOn = 'blur', validateDelay = 400, onInput, onChange, onCancel }, services)
 * A labelled single-line field. Errors are linked with aria-describedby and aria-invalid; phone, email and URL fields
 * read left to right in right-to-left forms. validate may return a promise (an availability check): see validateAsync().
 * Escape restores the last committed value (onCancel); a host value the input cannot show as given, line breaks in a
 * one-line field for example, is flagged until the person edits it.
 */
export const createTextField = textLike('text');
/** createTextArea(container, { …text field props, rows, autosize = true, maxHeight }, services) — multi-line text; grows with its content up to maxHeight. */
export const createTextArea = textLike('textarea');
/** createSearchField(container, { …text field props }, services) — a search input with a magnifier and its own clear button (Escape clears). */
export const createSearchField = textLike('search');

// ---------------------------------------------------------------- number field
/**
 * createNumberField(container, { label, value: number|null, min, max, step = 1, largeStep = 10 * step,
 *   format: Intl.NumberFormat options, prefix, suffix (unit), required, …, onChange(value), onInput(value) })
 * Typing accepts the locale's grouping / decimal marks and native digits; commits on blur / Enter.
 * Arrow Up/Down ±step, Page Up/Down ±largeStep, Home/End min/max. Touch density shows −/+ buttons (hold to repeat).
 */
export function createNumberField(container, props = {}, services) {
  const c = setup(container, services, 'number');
  let p = { value: null, step: 1, ...props };
  const input = c.h('input', { type: 'text', inputmode: 'decimal', autocomplete: 'off', role: 'spinbutton' });
  const dec = c.h('button', { type: 'button', class: 'ui-step', tabindex: '-1' }, c.icon('minus'));
  const inc = c.h('button', { type: 'button', class: 'ui-step', tabindex: '-1' }, c.icon('plus'));
  const spinUp = c.h('button', { type: 'button', tabindex: '-1' }, c.icon('chevron-up')), spinDown = c.h('button', { type: 'button', tabindex: '-1' }, c.icon('chevron-down'));
  const prefix = c.h('span', { class: 'ui-affix', hidden: true }), suffix = c.h('span', { class: 'ui-affix', hidden: true });
  const box = c.h('div', { class: 'ui-input ui-number' }, dec, prefix, input, suffix, c.h('span', { class: 'ui-spin', 'aria-hidden': 'true' }, spinUp, spinDown), inc);
  const f = field(c, box, { input, label: p.label, description: p.description, required: p.required, optional: p.optional, hideLabel: p.hideLabel });
  c.own(f.el);
  let current = p.value, typing = false;
  const fmt = v => (v == null ? '' : c.s.format.number(v, { maximumFractionDigits: 20, useGrouping: false, ...(p.format || {}) }));
  const clamp = v => Math.min(p.max ?? Infinity, Math.max(p.min ?? -Infinity, v));
  const round = v => { const st = p.step && p.step !== 'any' ? p.step : 0; if (!st) return v; const base = p.min ?? 0; const d = (String(st).split('.')[1] || '').length; return Number((Math.round((v - base) / st) * st + base).toFixed(d)); };
  function show() { if (!typing) input.value = fmt(current); input.setAttribute('aria-valuenow', current == null ? '' : String(current)); input.setAttribute('aria-valuetext', current == null ? '' : `${fmt(current)}${p.suffix ? ` ${p.suffix}` : ''}`); dec.disabled = p.disabled || p.readOnly || (current != null && p.min != null && current <= p.min); inc.disabled = p.disabled || p.readOnly || (current != null && p.max != null && current >= p.max); }
  function set(v, { commit = true, announce = false } = {}) {
    const prev = current; current = v; show();
    if (commit && prev !== v) { const msg = validateValue(c, v, p); f.setError(p.error || msg); c.emit(f.el, 'change', { value: v, previous: prev }, p.onChange); if (announce) c.s.announce(input.getAttribute('aria-valuetext')); }
  }
  function stepBy(n) { if (p.readOnly || p.disabled) return; const base = current ?? (p.min != null && p.min > 0 ? p.min : 0); set(clamp(round(base + n)), { announce: false }); }
  function render() {
    current = p.value;
    for (const [k, a] of [['min', 'aria-valuemin'], ['max', 'aria-valuemax']]) { if (p[k] != null) input.setAttribute(a, String(p[k])); else input.removeAttribute(a); }
    input.readOnly = !!p.readOnly; input.disabled = !!p.disabled; box.toggleAttribute('data-readonly', !!p.readOnly); box.toggleAttribute('data-disabled', !!p.disabled);
    input.placeholder = p.placeholder ?? '';
    prefix.textContent = p.prefix ?? ''; prefix.hidden = !p.prefix; suffix.textContent = p.suffix ?? ''; suffix.hidden = !p.suffix;
    dec.setAttribute('aria-label', c.s.t('number.decrement')); inc.setAttribute('aria-label', c.s.t('number.increment'));
    f.setLabel(p.label); f.setDescription(p.description); f.setRequired(p.required, p.optional);
    if (p.error !== undefined) f.setError(p.error || null);
    show();
  }
  c.on(input, 'focus', () => { typing = true; });
  c.on(input, 'input', () => { const v = input.value.trim() === '' ? null : c.s.format.parseNumber(input.value); f.setError(Number.isNaN(v) ? c.s.t('field.invalid') : null); if (!Number.isNaN(v)) c.emit(f.el, 'input', { value: v }, p.onInput); });
  const commitTyped = () => { typing = false; const raw = input.value.trim(); if (raw === '') { set(null); return; } const v = c.s.format.parseNumber(raw); if (Number.isNaN(v)) { f.setError(c.s.t('field.invalid')); return; } set(v); input.value = fmt(current); };
  c.on(input, 'blur', commitTyped);
  c.on(input, 'keydown', e => {
    const st = p.step === 'any' ? 1 : p.step, big = p.largeStep ?? st * 10;
    const d = { ArrowUp: st, ArrowDown: -st, PageUp: big, PageDown: -big }[e.key];
    if (d != null) { e.preventDefault(); typing = false; stepBy(d); typing = true; input.value = fmt(current); return; }
    if (e.key === 'Home' && p.min != null) { e.preventDefault(); set(p.min); }
    if (e.key === 'End' && p.max != null) { e.preventDefault(); set(p.max); }
    if (e.key === 'Enter') commitTyped();
  });
  // −/+ buttons: hold to repeat (400 ms delay, then every 80 ms); repeat timers are cleaned on destroy
  let holdT = 0, repeatT = 0;
  const stopHold = () => { c.win.clearTimeout(holdT); c.win.clearInterval(repeatT); holdT = repeatT = 0; };
  c.cleanup(stopHold);
  for (const [btn, sign] of [[dec, -1], [inc, 1], [spinDown, -1], [spinUp, 1]]) {
    c.on(btn, 'pointerdown', e => { if (e.button || btn.disabled) return; e.preventDefault(); const st = p.step === 'any' ? 1 : p.step; stepBy(sign * st); holdT = c.win.setTimeout(() => { repeatT = c.win.setInterval(() => stepBy(sign * st), 80); }, 400); });
    c.on(btn, 'pointerup', stopHold); c.on(btn, 'pointerleave', stopHold); c.on(btn, 'pointercancel', stopHold);
    c.on(btn, 'click', e => { if (e.detail === 0) stepBy(sign * (p.step === 'any' ? 1 : p.step)); }); // keyboard activation
  }
  render();
  container.append(f.el);
  return { root: f.el, input, get value() { return current; }, update(n) { p = { ...p, ...n }; render(); }, focus: () => input.focus(), destroy: () => c.destroy() };
}

// ---------------------------------------------------------------- select (native, styled)
// The 'native' presentation of createSelect (kit/ui/select.js): a styled native <select>. The closed field follows the
// kit's tokens and densities; the open list is drawn by the browser and the operating system, so its colours, highlight,
// corners, fonts, width, position and scrolling are the platform's and cannot be themed (the kit colours the option rows
// where the browser allows it). Not exported from the package root; createSelect chooses it.
export function createNativeSelect(container, props = {}, services) {
  const c = setup(container, services, 'select');
  let p = { value: null, options: [], ...props };
  const select = c.h('select');
  const box = c.h('div', { class: 'ui-input' }, select, c.icon('chevron-down'));
  const f = field(c, box, { input: select, label: p.label, description: p.description, required: p.required, optional: p.optional, hideLabel: p.hideLabel });
  c.own(f.el);
  const pend = pendingValue(c, { place: x => f.el.append(x), busy: select, apply: v => { p.value = v; select.value = v == null ? '' : String(v); }, current: () => p.value });
  function render() {
    const frag = c.doc.createDocumentFragment();
    if (p.placeholder != null || p.value == null) frag.append(c.h('option', { value: '', disabled: p.required ? true : null }, p.placeholder ?? c.s.t('select.placeholder')));
    const groups = new Map();
    for (const o of p.options) {
      const opt = c.h('option', { value: String(o.value), disabled: o.disabled || (p.readOnly && !Object.is(o.value, p.value)) || null }, o.label);
      if (o.group) { let g = groups.get(o.group); if (!g) { g = c.h('optgroup', { label: o.group }); groups.set(o.group, g); frag.append(g); } g.append(opt); } else frag.append(opt);
    }
    fill(select, frag);
    select.value = p.value == null ? '' : String(p.value);
    select.disabled = !!p.disabled;
    if (p.readOnly) select.setAttribute('aria-readonly', 'true'); else select.removeAttribute('aria-readonly');
    box.toggleAttribute('data-disabled', !!p.disabled); box.toggleAttribute('data-readonly', !!p.readOnly);
    f.setLabel(p.label); f.setDescription(p.description); f.setRequired(p.required, p.optional);
    if (p.error !== undefined) f.setError(p.error || null);
  }
  c.on(select, 'change', () => {
    if (p.readOnly) { select.value = p.value == null ? '' : String(p.value); return; } // a stray change (autofill) is put back
    const opt = p.options.find(o => String(o.value) === select.value) || null;
    const prev = p.value; p.value = opt ? opt.value : null;
    f.setError(p.error || validateValue(c, p.value, p));
    c.emit(f.el, 'change', { value: p.value, previous: prev, option: opt }, p.onChange);
    if (p.action) pend.get().run(p.value, p.action); else pend.sync(p.value);
  });
  render();
  container.append(f.el);
  return { root: f.el, select, get value() { return p.value; }, get state() { return pend.state; }, observe: pend.observe, update(n) { p = { ...p, ...n }; if ('value' in n) pend.sync(p.value); render(); }, validate() { const m = validateValue(c, p.value, p); f.setError(m); return !m; }, focus: () => select.focus(), destroy: () => c.destroy() };
}

// ---------------------------------------------------------------- native time / datetime field (P0 styled native; segmented field is P1)
/** createTimeField(container, { label, type: 'time'|'datetime-local'|'month'|'week', value, min, max, step, onChange }, services) — the browser's native picker, styled; see P.createTimeInput for the segmented field. */
export function createTimeField(container, props = {}, services) {
  const c = setup(container, services, 'time');
  let p = { type: 'time', value: '', ...props };
  const input = c.h('input', { type: p.type });
  const pick = c.h('button', { type: 'button', class: 'ui-inline-button', tabindex: '-1', 'aria-hidden': 'true' }, c.icon(p.type === 'time' ? 'clock' : 'calendar'));
  const box = c.h('div', { class: 'ui-input' }, input, pick);
  c.on(pick, 'click', () => { if (input.disabled || input.readOnly) return; input.focus(); try { input.showPicker?.(); } catch { /* not allowed or unsupported: typing still works */ } });
  const f = field(c, box, { input, label: p.label, description: p.description, required: p.required, optional: p.optional, hideLabel: p.hideLabel });
  c.own(f.el);
  function render() { input.value = p.value ?? ''; for (const k of ['min', 'max', 'step']) { if (p[k] != null) input.setAttribute(k, String(p[k])); else input.removeAttribute(k); } input.disabled = !!p.disabled; input.readOnly = !!p.readOnly; box.toggleAttribute('data-disabled', !!p.disabled); box.toggleAttribute('data-readonly', !!p.readOnly); pick.hidden = !!p.readOnly; f.setLabel(p.label); f.setDescription(p.description); f.setRequired(p.required, p.optional); if (p.error !== undefined) f.setError(p.error || null); }
  c.on(input, 'change', () => { const prev = p.value; p.value = input.value; f.setError(p.error || validateValue(c, p.value, p)); c.emit(f.el, 'change', { value: p.value, previous: prev }, p.onChange); });
  render(); container.append(f.el);
  return { root: f.el, input, get value() { return input.value; }, update(n) { p = { ...p, ...n }; render(); }, focus: () => input.focus(), destroy: () => c.destroy() };
}

// ---------------------------------------------------------------- checkbox, checkbox group, radio group
/** createCheckbox(container, { label, description, checked, indeterminate, required, disabled, onChange({ checked }) }, services) — a native checkbox with a 44 px target at touch density. */
export function createCheckbox(container, props = {}, services) {
  const c = setup(container, services, 'checkbox');
  let p = { checked: false, ...props };
  const input = c.h('input', { type: 'checkbox', id: uid('chk') });
  const text = c.h('span');
  const el = c.own(c.h('label', { class: 'ui-check' }, input, text));
  // With an action the change shows at once and the status line under the box says how saving went (G16).
  const pend = pendingValue(c, { place: x => { el.after(x); c.own(x); }, busy: input, apply: v => { p.checked = !!v; input.checked = !!v; }, current: () => !!p.checked });
  function render() { input.checked = !!p.checked; input.indeterminate = !!p.indeterminate; input.disabled = !!p.disabled; if (p.name) input.name = p.name; fill(text, p.label ?? '', p.description ? c.h('small', {}, p.description) : null); if (p.ariaLabel) input.setAttribute('aria-label', p.ariaLabel); }
  c.on(input, 'change', () => {
    const prev = p.checked; p.checked = input.checked; p.indeterminate = false;
    c.emit(el, 'change', { checked: p.checked, previous: prev }, p.onChange);
    if (p.action) pend.get().run(p.checked, p.action); else pend.sync(p.checked);
  });
  render(); container.append(el);
  return { root: el, input, get checked() { return input.checked; }, get state() { return pend.state; }, observe: pend.observe, update(n) { p = { ...p, ...n }; if ('checked' in n) pend.sync(!!p.checked); render(); }, focus: () => input.focus(), destroy: () => c.destroy() };
}
function choiceGroup(type) {
  return function create(container, props = {}, services) {
    const c = setup(container, services, type);
    let p = { options: [], value: type === 'radio' ? null : [], orientation: 'vertical', ...props };
    const name = uid(type);
    const legend = c.h('legend');
    const descId = uid('dsc'), desc = c.h('div', { class: 'ui-field-desc', id: descId, hidden: true });
    const items = c.h('div', { class: 'ui-group-items' });
    const errId = uid('err'), err = c.h('div', { class: 'ui-field-error', id: errId, hidden: true }, c.icon('alert'), c.h('span'));
    const el = c.own(c.h('fieldset', { class: 'ui-group', role: type === 'radio' ? 'radiogroup' : 'group' }, legend, desc, items, err));
    const showValue = v => { for (const i of items.querySelectorAll('input')) i.checked = type === 'radio' ? Object.is(i._value, v) : (v || []).includes(i._value); };
    const pend = pendingValue(c, { place: x => items.after(x), busy: el, apply: v => { p.value = v; showValue(v); }, current: () => p.value });
    function render() {
      el.dataset.orientation = p.orientation;
      fill(legend, p.label ?? '', p.required ? c.h('span', { class: 'ui-req', 'aria-hidden': 'true' }, ' *') : null, p.optional && !p.required ? c.h('span', { class: 'ui-opt' }, c.s.t('optional')) : null);
      legend.classList.toggle('ui-visually-hidden', !!p.hideLabel);
      desc.textContent = p.description ?? ''; desc.hidden = !p.description;
      if (p.required && type === 'radio') el.setAttribute('aria-required', 'true'); else el.removeAttribute('aria-required');
      // read-only: options stay focusable and readable but cannot change (radiogroup and checkbox take aria-readonly)
      if (p.readOnly && type === 'radio') el.setAttribute('aria-readonly', 'true'); else el.removeAttribute('aria-readonly');
      el.toggleAttribute('data-readonly', !!p.readOnly);
      fill(items, ...p.options.map(o => {
        const checked = type === 'radio' ? Object.is(o.value, p.value) : p.value.includes(o.value);
        const input = c.h('input', { type, name, value: String(o.value), checked: checked || null, disabled: p.disabled || o.disabled || null, 'aria-readonly': p.readOnly && type === 'checkbox' ? 'true' : null });
        input._value = o.value;
        return c.h('label', { class: 'ui-check' }, input, c.h('span', {}, o.label, o.description ? c.h('small', {}, o.description) : null));
      }));
      setError(p.error);
    }
    function setError(msg) {
      err.hidden = !msg; err.lastChild.textContent = msg || '';
      const by = [p.description ? descId : null, msg ? errId : null].filter(Boolean).join(' ');
      if (by) el.setAttribute('aria-describedby', by); else el.removeAttribute('aria-describedby');
      if (msg) el.setAttribute('aria-invalid', 'true'); else el.removeAttribute('aria-invalid');
    }
    // Cancelling the click undoes the check for pointer, Space and arrow-key selection alike.
    c.on(items, 'click', e => { if (p.readOnly && e.target.closest('input')) e.preventDefault(); });
    c.on(items, 'change', e => {
      const input = e.target.closest('input'); if (!input) return;
      const prev = p.value;
      p.value = type === 'radio' ? input._value : [...items.querySelectorAll('input:checked')].map(i => i._value);
      setError(p.error || validateValue(c, p.value, p));
      c.emit(el, 'change', { value: p.value, previous: prev }, p.onChange);
      if (p.action) pend.get().run(p.value, p.action); else pend.sync(p.value);
    });
    render(); container.append(el);
    return { root: el, get value() { return p.value; }, get state() { return pend.state; }, observe: pend.observe, update(n) { p = { ...p, ...n }; if ('value' in n) pend.sync(p.value); render(); }, validate() { const m = validateValue(c, p.value, p); setError(m); return !m; }, focus: () => (items.querySelector('input:checked') || items.querySelector('input:not(:disabled)'))?.focus(), destroy: () => c.destroy() };
  };
}
/** createCheckboxGroup(container, { label, options: [{ value, label, description, disabled }], value: [], orientation, description, required, optional, readOnly, hideLabel, onChange({ value }) }, services) — a fieldset of checkboxes; the legend is the group name. readOnly keeps the boxes focusable but unchangeable. */
export const createCheckboxGroup = choiceGroup('checkbox');
/** createRadioGroup(container, { label, options, value, orientation, description, required, optional, readOnly, hideLabel, onChange({ value }) }, services) — native radios in a fieldset: arrow keys move and select, one Tab stop; readOnly lets arrows move focus without changing the value. */
export const createRadioGroup = choiceGroup('radio');

// ---------------------------------------------------------------- switch (with optional async action, D17 / D30)
/**
 * createSwitch(container, { label, hideLabel (still the accessible name, e.g. in a table column), description, checked, disabled, readOnly, action?: async (next, signal) => any,
 *   onChange({ checked }) })
 * Without `action` it is a controlled switch (host updates `checked`). With `action` it updates optimistically,
 * shows pending (aria-busy) and the status line at the source, reverts on failure with a retry, and latest intent wins.
 */
export function createSwitch(container, props = {}, services) {
  const c = setup(container, services, 'switch');
  let p = { checked: false, ...props };
  const btn = c.h('button', { type: 'button', class: 'ui-switch', role: 'switch' }, c.h('i'));
  const labelEl = c.h('span', { id: uid('lbl') }), desc = c.h('small', { id: uid('dsc') }), status = c.h('small', { class: 'ui-switch-status', 'aria-live': 'polite' });
  const retry = c.h('button', { type: 'button', class: 'ui-button', 'data-variant': 'ghost', hidden: true, style: 'height:auto;padding:0 4px;font-size:inherit' });
  const el = c.own(c.h('div', { class: 'ui-switch-row' }, c.h('div', { class: 'ui-switch-text' }, labelEl, desc, c.h('span', {}, status, retry)), btn));
  btn.setAttribute('aria-labelledby', labelEl.id);
  let shown = !!p.checked, confirmed = !!p.checked, syncChecked = true;
  const action = createAsyncAction({ onChange: s => renderStatus(s), clearConfirmedAfter: 1600 });
  c.cleanup(() => action.destroy());
  const knobX = () => (shown ? btn.clientWidth - btn.firstChild.offsetWidth - 4 : 0) * (c.win.getComputedStyle(btn).direction === 'rtl' ? -1 : 1);
  let placed = false;
  function placeKnob() { if (!btn.isConnected || !btn.clientWidth) return; c.s.motion.animate(btn.firstChild, { x: knobX(), sx: 1 }, { role: placed ? 'detent' : 'instant' }); placed = true; }
  function renderStatus(s) {
    btn.setAttribute('aria-busy', String(s.phase === 'pending'));
    if (s.phase !== 'pending') btn.removeAttribute('aria-busy');
    status.dataset.phase = s.phase;
    status.textContent = s.phase === 'pending' ? c.s.t('action.pending') : s.phase === 'failed' ? c.s.t('action.failed') : s.phase === 'confirmed' ? c.s.t('action.confirmed') : '';
    retry.hidden = s.phase !== 'failed'; retry.textContent = c.s.t('retry');
    if (s.phase === 'failed') { shown = confirmed; btn.setAttribute('aria-checked', String(shown)); placeKnob(); }
  }
  function render() {
    labelEl.textContent = p.label ?? ''; labelEl.className = p.hideLabel ? 'ui-visually-hidden' : ''; desc.textContent = p.description ?? ''; desc.hidden = !p.description;
    if (p.description) btn.setAttribute('aria-describedby', desc.id); else btn.removeAttribute('aria-describedby');
    if (syncChecked && !action.pending) { shown = !!p.checked; confirmed = shown; }
    syncChecked = false;
    btn.setAttribute('aria-checked', String(shown));
    btn.disabled = !!p.disabled; if (p.readOnly) btn.setAttribute('aria-readonly', 'true'); else btn.removeAttribute('aria-readonly');
    placeKnob();
  }
  async function toggle() {
    if (p.disabled || p.readOnly) return;
    const next = !shown;
    shown = next; btn.setAttribute('aria-checked', String(next)); placeKnob();
    c.emit(el, 'change', { checked: next }, p.onChange);
    if (p.action) {
      const r = await action.run(signal => p.action(next, signal), { value: next });
      if (r.status === 'confirmed') confirmed = next;
    }
  }
  c.on(btn, 'click', toggle);
  c.on(retry, 'click', () => { shown = !confirmed; btn.setAttribute('aria-checked', String(shown)); placeKnob(); action.retry().then(r => { if (r.status === 'confirmed') confirmed = shown; }); });
  c.on(btn, 'pointerdown', e => { if (!e.button && !btn.disabled) c.s.motion.animate(btn.firstChild, { sx: 1.1 }, { role: 'press' }); });
  const ro = new c.win.ResizeObserver(() => { placed = false; placeKnob(); });
  ro.observe(btn); c.cleanup(() => ro.disconnect());
  render(); container.append(el); requestAnimationFrame(placeKnob);
  return { root: el, button: btn, get checked() { return shown; }, get state() { return action.state; }, update(n) { p = { ...p, ...n }; syncChecked = 'checked' in n; render(); }, focus: () => btn.focus(), destroy: () => c.destroy() };
}

// ---------------------------------------------------------------- segmented control / toggle group
/**
 * createSegmented(container, { label, options: [{ value, label, icon, count, disabled }], value, multiple, onChange })
 * Single: role=radiogroup with roving focus and a gliding indicator (control role). Multiple: toggle buttons (aria-pressed).
 */
export function createSegmented(container, props = {}, services) {
  const c = setup(container, services, 'segmented');
  let p = { options: [], value: null, ...props };
  const ind = c.h('span', { class: 'ui-seg-ind', 'aria-hidden': 'true' });
  const el = c.own(c.h('div', { class: 'ui-segmented' }));
  let roving = null, placed = false;
  const selected = o => (p.multiple ? (p.value || []).includes(o.value) : Object.is(o.value, p.value));
  const showValue = () => { for (const x of el.querySelectorAll('button')) { const on = selected({ value: x._value }); if (p.multiple) x.setAttribute('aria-pressed', String(on)); else x.setAttribute('aria-checked', String(on)); } placeIndicator(); };
  const pend = pendingValue(c, { place: x => { el.after(x); c.own(x); }, busy: el, apply: v => { p.value = v; showValue(); }, current: () => p.value });
  function placeIndicator() {
    if (p.multiple) { ind.hidden = true; return; }
    const b = [...el.querySelectorAll('button')].find(x => x.getAttribute('aria-checked') === 'true');
    ind.hidden = !b; if (!b || !el.clientWidth) return;
    c.s.motion.animate(ind, { x: b.offsetLeft, w: b.offsetWidth }, { role: placed ? 'control' : 'instant' }); placed = true;
  }
  function render() {
    el.setAttribute('role', p.multiple ? 'group' : 'radiogroup');
    if (p.label) el.setAttribute('aria-label', p.label);
    fill(el, ind, ...p.options.map(o => {
      const b = c.h('button', { type: 'button', disabled: o.disabled || p.disabled || null, dataset: { value: String(o.value) } }, o.icon ? c.icon(o.icon) : null, o.label, o.count != null ? c.h('span', { class: 'ui-count' }, typeof o.count === 'number' ? c.s.format.number(o.count) : o.count) : null);
      b._value = o.value;
      if (p.multiple) b.setAttribute('aria-pressed', String(selected(o))); else { b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(selected(o))); }
      return b;
    }));
    roving?.destroy();
    roving = p.multiple ? null : createRovingFocus(el, { items: () => [...el.querySelectorAll('button')], orientation: 'horizontal', onMove: b => choose(b) });
    requestAnimationFrame(placeIndicator);
  }
  function choose(b) {
    if (b.disabled) return;
    const prev = p.value;
    if (p.multiple) { const set = new Set(p.value || []); set.has(b._value) ? set.delete(b._value) : set.add(b._value); p.value = p.options.map(o => o.value).filter(v => set.has(v)); for (const x of el.querySelectorAll('button')) x.setAttribute('aria-pressed', String(p.value.includes(x._value))); }
    else { if (Object.is(prev, b._value)) return; p.value = b._value; for (const x of el.querySelectorAll('button')) x.setAttribute('aria-checked', String(x === b)); placeIndicator(); }
    c.emit(el, 'change', { value: p.value, previous: prev }, p.onChange);
    if (p.action) pend.get().run(p.value, p.action); else pend.sync(p.value);
  }
  // A tap on the track's padding or border picks the option under it, so the whole track is the hit area.
  const nearest = x => [...el.querySelectorAll('button:not(:disabled)')].find(b => { const r = b.getBoundingClientRect(); return x >= r.left && x <= r.right; });
  c.on(el, 'click', e => { const b = e.target.closest('button') || (e.target === el && nearest(e.clientX)); if (b) choose(b); });
  pressFeedbackGroup(c, el);
  const ro = new c.win.ResizeObserver(() => { placed = false; placeIndicator(); });
  ro.observe(el); c.cleanup(() => { ro.disconnect(); roving?.destroy(); });
  render(); container.append(el);
  return { root: el, get value() { return p.value; }, get state() { return pend.state; }, observe: pend.observe, update(n) { p = { ...p, ...n }; if ('value' in n) pend.sync(p.value); render(); }, focus: () => (el.querySelector('[tabindex="0"]') || el.querySelector('button'))?.focus(), destroy: () => c.destroy() };
}
function pressFeedbackGroup(c, el) {
  c.on(el, 'pointerdown', e => { const b = e.target.closest('button'); if (b && !e.button && !b.disabled) { c.s.motion.animate(b, { sx: PRESS_SCALE, sy: PRESS_SCALE }, { role: 'press' }); const up = () => c.s.motion.animate(b, { sx: 1, sy: 1 }, { role: 'release' }); b.addEventListener('pointerup', up, { once: true }); b.addEventListener('pointerleave', up, { once: true }); } });
}
