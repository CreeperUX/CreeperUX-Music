import { setup, fill, field, validateValue, uid } from './base.js';
import { autoPosition } from '../position.js';
import { createSheet } from './overlays.js';
import { createNativeSelect } from './controls.js';
import { createOptionList, runsOf } from './optionlist.js';
import { pendingValue } from './pending.js';

const norm = s => String(s ?? '').normalize('NFKC').toLocaleLowerCase();
const same = (a, b) => Object.is(a, b) || (a != null && b != null && String(a) === String(b));
const PAGE = 10;

/**
 * createSelect(container, { label, options: [{ value, label, description, disabled, group }], value, placeholder,
 *   presentation = 'native' | 'popup' | 'sheet' | 'auto', searchable, loading, required, optional, disabled, readOnly,
 *   description, error, hideLabel, onChange({ value, previous, option }), onOpen(), onClose() }, services)
 *
 * presentation 'native' (the default) is a styled native <select>: the closed field follows the kit, but the open list
 * is drawn by the browser and the operating system and cannot be themed (colours, highlight, corners, width, position).
 * 'popup' draws the list with the kit, anchored to the field; 'sheet' shows it in a sheet (a bottom sheet on narrow
 * screens); 'auto' uses the sheet on narrow touch screens and the popup elsewhere.
 *
 * Drawn presentations follow the WAI-ARIA select-only combobox: focus stays on the field (the active option is its
 * aria-activedescendant); ↓ ↑ Enter Space or typing opens the list; ↑ ↓ Home End PageUp PageDown move; typing jumps to the
 * next matching label (a space typed within the label continues it); moving never commits a value — Enter, Space, Tab,
 * Alt+↑ or a click do; Escape closes without a change. Lists over 100 options render only the rows in view.
 * `searchable` adds a filter field to the list (focus moves into it; Escape or Tab returns to the field). A value that is
 * not one of the options is shown and flagged (aria-invalid and a message; not while `loading`). `readOnly` lets the
 * list open for reading; nothing can be chosen.
 */
export function createSelect(container, props = {}, services) {
  const isNative = q => (q.presentation ?? 'native') === 'native';
  const build = q => (isNative(q) ? createNativeSelect : drawnSelect)(container, q, services);
  let p = { ...props }, inner = build(p);
  return {
    get root() { return inner.root; },
    get select() { return inner.select; },
    get trigger() { return inner.trigger ?? null; },
    get value() { return inner.value; },
    get isOpen() { return !!inner.isOpen; },
    get state() { return inner.state; },
    observe: v => inner.observe(v),
    open: () => inner.open?.(),
    close: () => inner.close?.(),
    update(n) {
      const wasNative = isNative(p);
      p = { ...p, ...n, value: 'value' in n ? n.value : inner.value };
      if (wasNative === isNative(p)) { inner.update(n); return; }
      // Switching between the native and a drawn presentation rebuilds the control in place.
      const old = inner, at = old.root;
      inner = build(p);
      if (at.isConnected) at.replaceWith(inner.root);
      old.destroy();
    },
    validate: () => inner.validate(),
    focus: () => inner.focus(),
    destroy: () => inner.destroy(),
  };
}

function drawnSelect(container, props, services) {
  const c = setup(container, services, 'select');
  let p = { value: null, options: [], presentation: 'popup', ...props };
  const listId = uid('sel');
  const valueEl = c.h('span', { class: 'ui-select-value' });
  const trigger = c.h('button', { type: 'button', class: 'ui-select-trigger', role: 'combobox', 'aria-haspopup': 'listbox', 'aria-expanded': 'false', 'aria-controls': listId }, valueEl, c.icon('chevron-down'));
  // A real <select> mirrors the value, so handle.select keeps its 2.0 type and code that reads it still works. Never shown.
  const hidden = c.h('select', { hidden: true, disabled: true, 'aria-hidden': 'true', tabindex: '-1' });
  const box = c.h('div', { class: 'ui-input ui-select' }, trigger, hidden);
  const f = field(c, box, { input: trigger, label: p.label, description: p.description, required: p.required, optional: p.optional, hideLabel: p.hideLabel, labelFor: false });
  trigger.setAttribute('aria-labelledby', f.ids.label);
  c.own(f.el);
  c.on(f.labelEl, 'click', () => trigger.focus()); // a plain label: clicking it focuses the field; it does not open the list

  const list = c.h('div', { class: 'ui-listbox', role: 'listbox', id: listId, 'aria-labelledby': f.ids.label });
  const scroller = c.h('div', { class: 'ui-select-scroll' }, list);
  const stateRow = c.h('div', { class: 'ui-popup-state', role: 'status', hidden: true });
  const searchInput = c.h('input', { type: 'search', class: 'ui-select-search-input', autocomplete: 'off', spellcheck: 'false', 'aria-controls': listId, 'aria-autocomplete': 'list' });
  const searchBox = c.h('div', { class: 'ui-input ui-select-search' }, c.icon('search'), searchInput);
  const body = c.h('div', { class: 'ui-select-body' }, searchBox, scroller, stateRow);
  const popup = c.h('div', { class: 'ui-popup ui-select-popup', hidden: true });
  let open = false, surface = null, handle = null, pos = null, sheet = null, closeTicket = 0;
  let shown = [], active = -1, query = '', buffer = '', bufferAt = 0, rowsFor = null, hiddenFor = null;
  const rows = new Map(); // option index → row; rebuilt when the options array changes
  // The rendered list (optionlist.js): group headings and options in runs; itemOf maps an option index to its item.
  let items = [], itemOf = new Map();
  const kind = it => (it.head ? 'head' : p.options[it.i].description ? 'described' : 'option');
  const lb = createOptionList(c, { list, scroller, row, kind, isOpen: () => open, onPaint: markActive });

  const indexOfValue = v => (v == null ? -1 : p.options.findIndex(o => same(o.value, v)));
  const enabled = i => i >= 0 && i < p.options.length && !p.options[i].disabled;
  // The element that owns aria-activedescendant: the filter field, the sheet's list, or the field itself.
  const owner = () => (p.searchable ? searchInput : surface === 'sheet' ? list : trigger);

  // A host value that is not one of the options is an invalid state, not an empty one (1.0 flagged it the same way).
  let missingShown = false;
  // With a filter field, the active option becomes its aria-activedescendant only once the user types or moves: on
  // open a screen reader announces the field ("Filter options, edit"), not an option (NVDA pass, 2.1.0; as the palette).
  let engaged = true;
  const missing = () => (p.value != null && !p.loading && indexOfValue(p.value) < 0 ? c.s.t('select.missing') : null);
  const keys = on => list.toggleAttribute('data-keys', on); // keys drive the list: the active option rings (ui.css)
  const pend = pendingValue(c, { place: x => f.el.append(x), busy: trigger, apply: v => { p.value = v; renderValue(); }, current: () => p.value });
  function renderValue() {
    const i = indexOfValue(p.value), o = i >= 0 ? p.options[i] : null, empty = p.value == null;
    valueEl.textContent = o ? o.label : empty ? (p.placeholder ?? c.s.t('select.placeholder')) : String(p.value);
    valueEl.toggleAttribute('data-placeholder', empty);
    valueEl.toggleAttribute('data-missing', !empty && !o); // a value that is not one of the options is shown, not hidden
    if (hiddenFor !== p.options) { hiddenFor = p.options; fill(hidden, c.h('option', { value: '' }), p.options.map(x => c.h('option', { value: String(x.value) }, x.label))); }
    hidden.value = o ? String(o.value) : '';
  }
  function row({ i, pos }, run) {
    let el = rows.get(i);
    if (!el) {
      const o = p.options[i];
      el = c.h('div', { class: 'ui-option', role: 'option', id: `${listId}-${i}` }, c.h('span', { class: 'ui-option-check', 'aria-hidden': 'true' }), c.h('span', { class: 'ui-option-label' }, o.label, o.description ? c.h('small', {}, o.description) : null));
      el._i = i; rows.set(i, el);
    }
    el.setAttribute('aria-selected', String(same(p.options[i].value, p.value)));
    if (p.options[i].disabled) el.setAttribute('aria-disabled', 'true'); else el.removeAttribute('aria-disabled');
    // explicit positions, so "12 of 40" stays right when a long list renders only the rows in view
    el.setAttribute('aria-posinset', String(pos)); el.setAttribute('aria-setsize', String(run.size));
    el.toggleAttribute('data-active', i === active);
    return el;
  }
  // After every paint: the active option is the owner's aria-activedescendant only while it is rendered.
  function markActive() {
    const el = active >= 0 ? rows.get(active) : null;
    if (el?.isConnected && engaged) owner().setAttribute('aria-activedescendant', el.id); else owner().removeAttribute('aria-activedescendant');
  }
  // defer: compute the list but leave painting to the caller (opening paints once, around the active option).
  function renderList({ defer = false } = {}) {
    if (rowsFor !== p.options) { rows.clear(); rowsFor = p.options; }
    const n = norm(query);
    shown = p.loading ? [] : p.options.map((o, i) => i).filter(i => !n || norm(`${p.options[i].label} ${p.options[i].description ?? ''}`).includes(n));
    const built = runsOf(shown.map(i => ({ i })), e => p.options[e.i].group);
    items = built.items; itemOf = new Map();
    items.forEach((it, k) => { if (!it.head) itemOf.set(it.i, k); });
    if (!shown.includes(active)) active = -1;
    lb.set(items, built.runs, { defer });
    fill(stateRow);
    if (p.loading) stateRow.append(c.h('span', { class: 'ui-spinner', 'aria-hidden': 'true' }), c.s.t('loading'));
    else if (!shown.length) stateRow.append(query ? c.s.t('noResults') : c.s.t('noOptions'));
    else if (p.readOnly) stateRow.append(c.s.t('select.readOnly'));
    stateRow.hidden = !stateRow.childNodes.length;
  }
  // align: 'auto' scrolls only as far as needed, 'center' centres the option, false leaves the scroll position alone.
  function setActive(i, align = 'auto') {
    active = i;
    list.querySelector('.ui-option[data-active]')?.removeAttribute('data-active');
    for (const el of [trigger, searchInput, list]) el.removeAttribute('aria-activedescendant');
    if (!open || i < 0) return;
    if (align && itemOf.has(i)) lb.scrollTo(itemOf.get(i), align); // renders the rows around it
    const el = rows.get(i);
    if (!el?.isConnected) return;
    el.setAttribute('data-active', '');
    if (engaged) owner().setAttribute('aria-activedescendant', el.id);
  }
  // `steps` enabled options forward (+) or back (−) in list order, stopping at the ends (no wrap, as the APG select).
  function move(steps) {
    let k = shown.indexOf(active), last = k;
    if (k < 0) k = steps > 0 ? -1 : shown.length;
    for (let left = Math.abs(steps), dir = Math.sign(steps); left > 0;) {
      k += dir;
      if (k < 0 || k >= shown.length) break;
      if (enabled(shown[k])) { last = k; left--; }
    }
    if (last >= 0 && last < shown.length && enabled(shown[last])) setActive(shown[last]);
  }
  const first = () => { const i = shown.find(enabled); if (i != null) setActive(i); };
  const last = () => { const i = [...shown].reverse().find(enabled); if (i != null) setActive(i); };
  // Typeahead: characters typed within 500 ms form a prefix; repeating one character cycles through its matches.
  const typing = () => buffer !== '' && c.win.performance.now() - bufferAt <= 500;
  function typeahead(ch) {
    const now = c.win.performance.now();
    buffer = now - bufferAt > 500 ? ch : buffer + ch; bufferAt = now;
    const repeat = [...buffer].every(x => x === buffer[0]), needle = norm(repeat ? buffer[0] : buffer);
    const at = shown.indexOf(active) + (repeat ? 1 : 0); // a growing prefix may stay on the current option
    const hit = [...shown.slice(at), ...shown.slice(0, at)].find(i => enabled(i) && norm(p.options[i].label).startsWith(needle));
    if (hit != null) setActive(hit);
  }

  function useSheet() {
    if (p.presentation === 'sheet') return true;
    if (p.presentation !== 'auto') return false;
    const rem = parseFloat(c.win.getComputedStyle(c.doc.documentElement).fontSize) || 16;
    return !!c.win.matchMedia?.('(pointer: coarse)').matches && c.win.innerWidth < 40 * rem;
  }
  function openList(where = 'selected') {
    if (open || p.disabled) return; // read-only opens for reading
    open = true; closeTicket++; query = ''; searchInput.value = ''; active = -1; engaged = !p.searchable;
    surface = useSheet() ? 'sheet' : 'popup';
    searchBox.hidden = !p.searchable;
    const filterName = c.s.t('select.search');
    if (searchInput.placeholder !== filterName) { searchInput.placeholder = filterName; searchInput.setAttribute('aria-label', filterName); }
    list.tabIndex = surface === 'sheet' && !p.searchable ? 0 : -1;
    lb.reset(); // only the rows around the new active option render
    const sel = indexOfValue(p.value);
    const activate = () => { if (where === 'first') first(); else if (where === 'last') last(); else if (enabled(sel) && shown.includes(sel)) setActive(sel, 'center'); else first(); };
    if (surface === 'popup') {
      const width = box.offsetWidth; // read while layout is still clean
      renderList({ defer: true });
      popup.replaceChildren(body); popup.style.minWidth = `${width}px`; popup.style.maxHeight = ''; popup.hidden = false;
      if (popup.parentNode !== c.s.overlays.portal) c.s.overlays.portal.append(popup); // measured before the layer opens
      activate();
      if (!lb.painted) lb.paint(); // nothing to activate: paint from the top
      const natural = popup.offsetHeight;
      pos = autoPosition(box, popup, { placement: 'bottom-start', offset: 4 });
      if (parseFloat(popup.style.maxHeight) < natural && active >= 0) setActive(active, 'center'); // little room: keep it in view
      handle = c.s.overlays.open(popup, { kind: 'menu', trigger, initialFocus: false, restoreFocus: false, onDismiss: reason => close({ focus: reason === 'escape' }) });
      // The filter field takes focus one frame later: the list paints first, and keys pressed meanwhile reach it anyway.
      if (p.searchable) c.win.requestAnimationFrame(() => { if (open && surface === 'popup' && c.doc.activeElement !== searchInput) searchInput.focus({ preventScroll: true }); });
      c.s.motion.animate(popup, { o: 1, y: 0 }, { role: 'enter', from: { o: 0, y: -2 } });
    } else {
      sheet ??= createSheet({ title: p.label ?? '', side: 'auto', initialFocus: () => (p.searchable ? searchInput : list), onClose: () => close({ fromSheet: true }) }, c.s);
      sheet.element.classList.add('ui-select-sheet');
      sheet.update({ title: p.label ?? '' });
      sheet.body.replaceChildren(body);
      renderList(); // before the sheet takes focus, so its list is never focused empty
      sheet.open();
      activate();
    }
    trigger.setAttribute('aria-expanded', 'true');
    c.emit(f.el, 'open', {}, p.onOpen);
  }
  function close({ focus = false, fromSheet = false } = {}) {
    if (!open) return;
    open = false; const my = ++closeTicket, was = surface;
    trigger.setAttribute('aria-expanded', 'false');
    setActive(-1, false);
    surface = null;
    if (was === 'popup') {
      pos?.cleanup(); pos = null;
      const hadFocus = popup.contains(c.doc.activeElement);
      handle?.close({ restoreFocus: false }); handle = null;
      c.s.motion.animate(popup, { o: 0 }, { role: 'exit' }).then(() => { if (my === closeTicket && !open) { popup.hidden = true; c.s.motion.reset(popup); } });
      if (focus || hadFocus) trigger.focus({ preventScroll: true });
    } else {
      if (!fromSheet) sheet?.close();
      if (focus) trigger.focus({ preventScroll: true }); // Safari does not focus clicked buttons, so the sheet may have no opener to restore
    }
    c.emit(f.el, 'close', {}, p.onClose);
  }
  function commit(i) {
    if (!enabled(i)) return;
    if (p.readOnly) { close({ focus: true }); return; }
    const o = p.options[i], prev = p.value, changed = !same(prev, o.value);
    p.value = o.value;
    renderValue();
    f.setError(p.error || validateValue(c, p.value, p)); missingShown = false;
    close({ focus: true });
    if (!changed) return;
    c.emit(f.el, 'change', { value: o.value, previous: prev, option: o }, p.onChange);
    if (p.action) pend.get().run(o.value, p.action); else pend.sync(o.value);
  }

  // Keys while the list is open, from the field (popup), the filter field, or the sheet's list.
  function openKeys(e) {
    const k = e.key, inSearch = e.target === searchInput;
    if (!engaged && /^(Arrow|Page|Home$|End$)/.test(k)) engaged = true; // moving: the active option is announced from now on
    if (k === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (k === 'ArrowUp' && e.altKey) { e.preventDefault(); if (active >= 0) commit(active); else close({ focus: true }); }
    else if (k === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (k === 'PageDown') { e.preventDefault(); move(PAGE); }
    else if (k === 'PageUp') { e.preventDefault(); move(-PAGE); }
    else if ((k === 'Home' || k === 'End') && !inSearch) { e.preventDefault(); if (k === 'Home') first(); else last(); }
    else if (k === ' ' && !inSearch && typing()) { e.preventDefault(); typeahead(k); } // "New York": the space is part of the label
    else if (k === 'Enter' || (k === ' ' && !inSearch)) { e.preventDefault(); if (active >= 0) commit(active); }
    else if (k === 'Escape') { e.preventDefault(); e.stopPropagation(); close({ focus: true }); }
    else if (k === 'Tab' && inSearch && surface === 'popup') { e.preventDefault(); close({ focus: true }); } // back to the field
    else if (k === 'Tab' && surface === 'popup') { if (active >= 0) commit(active); else close(); } // focus then moves on
    else if (k.length === 1 && !inSearch && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); typeahead(k); }
  }
  c.on(trigger, 'keydown', e => {
    if (e.isComposing || p.disabled) return;
    keys(true);
    if (open && surface === 'popup') { // a searchable popup gets here only in the frame before its filter field has focus
      if (p.searchable && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); searchInput.focus({ preventScroll: true }); searchInput.value += e.key; filterNow(); }
      else openKeys(e);
      return;
    }
    const k = e.key;
    if (k === 'ArrowDown' || k === 'ArrowUp' || k === 'Enter' || k === ' ') { e.preventDefault(); openList(k === 'ArrowUp' && !e.altKey && indexOfValue(p.value) < 0 ? 'last' : 'selected'); }
    else if (k === 'Home' || k === 'End') { e.preventDefault(); openList(k === 'Home' ? 'first' : 'last'); }
    else if (k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault(); openList();
      if (!open) return;
      if (p.searchable) { searchInput.value = k; filterNow(); } else typeahead(k);
    }
  });
  c.on(trigger, 'click', e => { if (e.detail === 0) return; keys(false); if (open) close({ focus: true }); else openList(); }); // pointer only; keys are above
  c.on(trigger, 'blur', e => { if (open && surface === 'popup' && !p.searchable && !popup.contains(e.relatedTarget)) close(); });
  c.on(searchInput, 'keydown', e => { if (!e.isComposing) { keys(true); openKeys(e); } });
  function filterNow() { engaged = true; query = searchInput.value; renderList(); first(); }
  c.on(searchInput, 'input', filterNow);
  c.on(list, 'keydown', e => { if (surface === 'sheet' && e.target === list) { keys(true); openKeys(e); } });
  // Pointer presses inside the popup (options, padding, scrollbar) keep focus where it is, so the field never blurs.
  c.on(popup, 'pointerdown', e => { if (e.target !== searchInput) e.preventDefault(); });
  c.on(list, 'click', e => { const el = e.target.closest('.ui-option'); if (el && list.contains(el)) commit(el._i); });
  c.on(list, 'pointermove', e => { keys(false); const el = e.target.closest('.ui-option'); if (el && el._i !== active && enabled(el._i)) setActive(el._i, false); });
  c.cleanup(() => { if (open) close(); lb.destroy(); pos?.cleanup(); handle?.close({ restoreFocus: false }); sheet?.destroy(); popup.remove(); });

  function render() {
    trigger.disabled = !!p.disabled;
    if (p.readOnly) trigger.setAttribute('aria-readonly', 'true'); else trigger.removeAttribute('aria-readonly');
    if (p.loading) trigger.setAttribute('aria-busy', 'true'); else trigger.removeAttribute('aria-busy');
    box.toggleAttribute('data-disabled', !!p.disabled); box.toggleAttribute('data-readonly', !!p.readOnly);
    f.setLabel(p.label); f.setDescription(p.description); f.setRequired(p.required, p.optional);
    const miss = missing();
    if (miss || missingShown) { f.setError(p.error || miss || null); missingShown = !!miss; }
    else if (p.error !== undefined) f.setError(p.error || null);
    renderValue();
    if (open) {
      if (p.disabled) close();
      else { const keep = active; renderList(); if (shown.includes(keep)) setActive(keep, false); else first(); }
    }
  }
  render();
  container.append(f.el);
  return {
    root: f.el, select: hidden, trigger,
    get value() { return p.value; },
    get isOpen() { return open; },
    get state() { return pend.state; }, observe: pend.observe,
    open: () => { trigger.focus(); openList(); },
    close: () => close({ focus: true }),
    update(n) { p = { ...p, ...n }; if ('value' in n) pend.sync(p.value); render(); },
    validate() { const m = validateValue(c, p.value, p) || missing(); f.setError(p.error || m); return !m; },
    focus: () => trigger.focus(),
    destroy: () => c.destroy(),
  };
}
