import { setup, fill, field, validateValue, uid } from './base.js';
import { autoPosition } from '../position.js';
import { createOptionList, runsOf } from './optionlist.js';

const norm = s => String(s ?? '').normalize('NFKC').toLowerCase();

/**
 * createCombobox(container, {
 *   label, placeholder, description, required, optional, disabled, readOnly,
 *   options?: [{ value, label, description, disabled, group }],   // static options, filtered on the label
 *   load?: async (query, signal) => options,                        // async options; latest query wins
 *   multiple, value (single) | values (multiple), creatable, minQuery = 0, maxResults,
 *   loading, loadError, onRetry,                                     // host-loaded options (G23)
 *   onChange({ value } | { values }), onQuery({ query }), onCreate({ query })
 * })
 * APG combobox: the input keeps focus; ↑/↓ move the active option (aria-activedescendant), Enter selects,
 * Escape closes then clears, Backspace on an empty input removes the last chip (multiple). Every match is listed
 * (since 2.1.0; `maxResults` caps on request): lists over 100 options render only the rows in view, and options of
 * one group form a named role="group". A host that loads the options itself sets `loading`, and `loadError` (a message,
 * or true for "Couldn't load") with `onRetry` for a Retry button. With static options, a selected value that is not one
 * of them is shown and flagged like the select's (not while loading, nor when the field creates values).
 */
export function createCombobox(container, props = {}, services) {
  const c = setup(container, services, 'combobox');
  let p = { options: [], value: null, values: [], minQuery: 0, ...props };
  const listId = uid('lst');
  const input = c.h('input', { type: 'text', role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': 'false', 'aria-controls': listId, autocomplete: 'off', spellcheck: 'false' });
  const chips = c.h('span', { style: 'display:contents' });
  const picked = c.h('span', { class: 'ui-visually-hidden', id: uid('sel') }); // "Design, Sales selected": read with the name
  const toggleBtn = c.h('button', { type: 'button', class: 'ui-inline-button', tabindex: '-1', 'aria-hidden': 'true' }, c.icon('chevron-down'));
  const box = c.h('div', { class: 'ui-input ui-combobox' }, chips, picked, input, toggleBtn);
  const f = field(c, box, { input, label: p.label, description: p.description, required: p.required, optional: p.optional, hideLabel: p.hideLabel });
  c.own(f.el);
  const list = c.h('div', { class: 'ui-listbox', role: 'listbox', id: listId });
  const stateRow = c.h('div', { class: 'ui-popup-state', role: 'status' });
  const popup = c.h('div', { class: 'ui-popup', hidden: true }, list, stateRow);
  let total = 0, open = false, handle = null, pos = null, active = -1, shown = [], loadSeq = 0, loadCtrl = null, loadState = 'idle', closeTicket = 0, announceT = 0;
  // cache of labels for selected values that are not in the current option list (async)
  const known = new Map();
  const labelOf = v => known.get(v) ?? p.options.find(o => Object.is(o.value, v))?.label ?? String(v);
  const isSel = v => (p.multiple ? p.values.some(x => Object.is(x, v)) : Object.is(p.value, v));
  let missingShown = false;
  const missing = () => {
    if (p.load || p.creatable || p.loading) return null;
    const vals = p.multiple ? p.values : p.value == null ? [] : [p.value];
    return vals.some(v => !known.has(v) && !p.options.some(o => Object.is(o.value, v))) ? c.s.t('select.missing') : null;
  };

  function renderChips() {
    fill(chips, ...(p.multiple ? p.values.map(v => {
      const rm = c.h('button', { type: 'button', 'aria-label': c.s.t('combobox.remove', { label: labelOf(v) }), tabindex: '-1' }, c.icon('close'));
      rm._value = v;
      return c.h('span', { class: 'ui-chip' }, c.h('span', {}, labelOf(v)), rm);
    }) : []));
    if (!p.multiple && c.doc.activeElement !== input) input.value = p.value == null ? '' : labelOf(p.value);
    if (p.multiple) {
      picked.textContent = p.values.length ? c.s.t('combobox.selected', { list: p.values.map(labelOf).join(', ') }) : '';
      input.setAttribute('aria-labelledby', `${f.labelEl.id || (f.labelEl.id = uid('lbl'))} ${picked.id}`);
    }
  }
  function highlight(text, q) {
    const i = q ? norm(text).indexOf(norm(q)) : -1;
    if (i < 0 || !q) return [text];
    return [text.slice(0, i), c.h('mark', {}, text.slice(i, i + q.length)), text.slice(i + q.length)];
  }
  // Option rows are reused between keystrokes (keyed by option); only text, index and state change. Perf: D20.
  // Weakly keyed, so rows for discarded async results are collected.
  const rowCache = new WeakMap(); let createRow;
  const newRow = () => c.h('div', { class: 'ui-option', role: 'option' }, c.h('span', { class: 'ui-option-check', 'aria-hidden': 'true' }), c.h('span'));
  function row(o) {
    if (o.create) return (createRow ??= newRow());
    let li = rowCache.get(o);
    if (!li) rowCache.set(o, li = newRow());
    return li;
  }
  // The rendered list (optionlist.js, shared with the drawn select): group headings and options in runs; only the rows
  // in view when the list is long. itemOf maps an index in `shown` to its item.
  let items = [], itemOf = new Map(), lastQuery = '';
  const lb = createOptionList(c, { list, scroller: popup, row: optionRow, kind: it => (it.head ? 'head' : shown[it.i].description ? 'described' : 'option'), isOpen: () => open, onPaint: markActive });
  function optionRow({ i, pos }, run) {
    const o = shown[i], li = row(o), query = lastQuery;
    li.id = `${listId}-${i}`; li._i = i;
    li.setAttribute('aria-selected', o.create ? 'false' : String(isSel(o.value)));
    if (o.disabled) li.setAttribute('aria-disabled', 'true'); else li.removeAttribute('aria-disabled');
    li.setAttribute('aria-posinset', String(pos)); li.setAttribute('aria-setsize', String(run.size));
    li.toggleAttribute('data-active', i === active);
    const text = o.create ? `${c.s.i18n.locale}\u0000${query}` : query;
    if (li._q !== text) { li._q = text; fill(li.lastChild, o.create ? c.s.t('combobox.create', { query }) : highlight(o.label, query), o.description ? c.h('small', {}, o.description) : null); }
    return li;
  }
  const activeRow = () => (active >= 0 && itemOf.has(active) ? row(shown[active]) : null);
  function markActive() { const cur = activeRow(); if (cur?.isConnected && open) input.setAttribute('aria-activedescendant', cur.id); else input.removeAttribute('aria-activedescendant'); }
  function renderList(query) {
    lastQuery = query;
    const built = runsOf(shown.map((o, i) => ({ i })), e => (shown[e.i].create ? null : shown[e.i].group));
    items = built.items; itemOf = new Map();
    items.forEach((it, k) => { if (!it.head) itemOf.set(it.i, k); });
    lb.set(items, built.runs);
    const st = p.loadError ? 'error' : p.loading ? 'loading' : loadState; // the host's state, then the load()'s
    stateRow.dataset.kind = st === 'error' ? 'error' : '';
    if (st === 'loading') list.setAttribute('aria-busy', 'true'); else list.removeAttribute('aria-busy');
    fill(stateRow);
    if (st === 'loading') stateRow.append(c.h('span', { class: 'ui-spinner', 'aria-hidden': 'true' }), c.s.t('loading'));
    else if (st === 'error') {
      stateRow.append(typeof p.loadError === 'string' ? p.loadError : c.s.t('error.load'));
      if (!p.loadError || p.onRetry) { const retry = c.h('button', { type: 'button', class: 'ui-button', 'data-variant': 'ghost' }, c.s.t('retry')); retry.addEventListener('click', () => (p.loadError ? p.onRetry() : refresh(input.value))); stateRow.append(retry); }
    }
    else if (!shown.length) stateRow.append(query ? c.s.t('noResults') : c.s.t('noOptions'));
    else if (total > shown.filter(o => !o.create).length) stateRow.append(c.s.t('combobox.more', { shown: c.s.format.number(shown.filter(o => !o.create).length), total: c.s.format.number(total) }));
    stateRow.hidden = !stateRow.childNodes.length;
    setActive(Math.min(active, shown.length - 1), false);
  }
  function setActive(i, scroll = true) {
    active = i;
    list.querySelector('.ui-option[data-active]')?.removeAttribute('data-active');
    if (scroll && open && itemOf.has(i)) lb.scrollTo(itemOf.get(i), 'auto'); // renders the rows around it
    const cur = activeRow();
    if (cur?.isConnected) cur.setAttribute('data-active', '');
    markActive();
  }
  // Normalized search text is computed once per option (NFKC + lower case), not on every keystroke.
  const searchText = new WeakMap();
  const textOf = o => { let t = searchText.get(o); if (t == null) { t = `${norm(o.label)}\u0000${norm(o.description)}`; searchText.set(o, t); } return t; };
  function filterStatic(q) {
    const n = norm(q);
    return n ? p.options.filter(o => textOf(o).includes(n)) : p.options;
  }
  async function refresh(query) {
    const q = query ?? '';
    c.emit(f.el, 'query', { query: q }, p.onQuery);
    let opts;
    if (p.load) {
      if (q.length < p.minQuery) { shown = []; loadState = 'idle'; renderList(q); return; }
      const my = ++loadSeq; loadCtrl?.abort(); loadCtrl = new AbortController();
      loadState = 'loading'; renderList(q);
      try { opts = await p.load(q, loadCtrl.signal); } catch (e) { if (my !== loadSeq || e?.name === 'AbortError') return; loadState = 'error'; shown = []; renderList(q); return; }
      if (my !== loadSeq || c.dead) return; // a newer query is in flight: ignore this late result
      loadState = 'idle';
      for (const o of opts) known.set(o.value, o.label);
    } else opts = filterStatic(q);
    total = opts.length;
    shown = opts.slice(0, p.maxResults ?? Infinity); // every match (D33, G10): long lists render only the rows in view; maxResults caps on request and the status row says so
    if (p.creatable && q.trim() && !shown.some(o => norm(o.label) === norm(q.trim()))) shown.push({ create: true, value: q.trim(), label: q.trim() });
    if (active >= shown.length) active = shown.length ? 0 : -1;
    renderList(q);
    // Result count for screen readers, debounced so fast typing is not read out on every keystroke.
    c.win.clearTimeout(announceT); announceT = c.win.setTimeout(() => { if (open) c.s.announce(c.s.t('combobox.results', { count: total })); }, 600);
  }
  function openPopup() {
    if (open || p.disabled || p.readOnly) return;
    open = true; closeTicket++;
    popup.hidden = false;
    popup.style.minWidth = `${box.offsetWidth}px`;
    handle = c.s.overlays.open(popup, { kind: 'menu', trigger: input, initialFocus: false, restoreFocus: false, onDismiss: reason => close(reason !== 'escape') });
    pos = autoPosition(box, popup, { placement: 'bottom-start', offset: 4 });
    input.setAttribute('aria-expanded', 'true');
    c.s.motion.animate(popup, { o: 1, y: 0 }, { role: 'enter', from: { o: 0, y: -2 } });
    refresh(p.multiple || input.value !== labelOf(p.value) ? input.value : '');
  }
  function close(keepText = true) {
    if (!open) return;
    open = false; const my = ++closeTicket;
    input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant');
    loadCtrl?.abort(); loadSeq++;
    pos?.cleanup(); pos = null;
    handle?.close({ restoreFocus: false }); handle = null;
    c.s.motion.animate(popup, { o: 0 }, { role: 'exit' }).then(() => { if (my === closeTicket && !open) { popup.hidden = true; c.s.motion.reset(popup); } });
    if (!keepText || !p.multiple) renderChips();
  }
  function select(o) {
    if (!o || o.disabled) return;
    if (o.create) { known.set(o.value, o.label); c.emit(f.el, 'create', { query: o.value }, p.onCreate); }
    if (p.multiple) {
      const prev = p.values;
      const values = isSel(o.value) ? prev.filter(v => !Object.is(v, o.value)) : [...prev, o.value];
      p.values = values; input.value = '';
      renderChips(); refresh('');
      f.setError(p.error || validateValue(c, p.values, p));
      c.emit(f.el, 'change', { values, previous: prev }, p.onChange);
    } else {
      const prev = p.value; p.value = o.value; known.set(o.value, o.label);
      close(); input.value = o.label;
      f.setError(p.error || validateValue(c, p.value, p)); missingShown = false;
      if (!Object.is(prev, o.value)) c.emit(f.el, 'change', { value: o.value, previous: prev }, p.onChange);
    }
  }
  c.on(input, 'input', () => { if (!open) openPopup(); else refresh(input.value); active = 0; });
  c.on(input, 'focus', () => { if (p.openOnFocus) openPopup(); });
  c.on(input, 'blur', () => { if (!p.multiple && !open) renderChips(); });
  c.on(input, 'keydown', e => {
    if (e.isComposing) return;
    list.setAttribute('data-keys', ''); // keys drive the list: the active option shows a focus ring (ui.css)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) { openPopup(); setActive(e.key === 'ArrowDown' ? 0 : shown.length - 1); return; } // ↑ opens on the last option, scrolled into view
      if (!shown.length) return;
      let n = active; const dir = e.key === 'ArrowDown' ? 1 : -1;
      for (let k = 0; k < shown.length; k++) { n = (n + dir + shown.length) % shown.length; if (!shown[n].disabled) break; }
      setActive(n);
    } else if (e.key === 'Enter') { if (open && active >= 0) { e.preventDefault(); select(shown[active]); } }
    else if (e.key === 'Escape') { if (open) { e.preventDefault(); e.stopPropagation(); close(); } else if (input.value) { e.preventDefault(); e.stopPropagation(); input.value = ''; if (!p.multiple && p.value != null && !p.required) { const prev = p.value; p.value = null; c.emit(f.el, 'change', { value: null, previous: prev }, p.onChange); } } }
    else if (e.key === 'Backspace' && p.multiple && !input.value && p.values.length) { const prev = p.values; p.values = prev.slice(0, -1); renderChips(); c.emit(f.el, 'change', { values: p.values, previous: prev }, p.onChange); }
    else if (e.key === 'Tab') close();
  });
  c.on(list, 'pointerdown', e => e.preventDefault()); // keep focus in the input
  c.on(list, 'click', e => { const li = e.target.closest('.ui-option'); if (li) select(shown[li._i]); });
  c.on(list, 'pointermove', e => { list.removeAttribute('data-keys'); const li = e.target.closest('.ui-option'); if (li && li._i !== active) setActive(li._i, false); });
  c.on(input, 'pointerdown', () => list.removeAttribute('data-keys'));
  c.on(toggleBtn, 'pointerdown', e => e.preventDefault());
  c.on(toggleBtn, 'click', () => { list.removeAttribute('data-keys'); if (open) close(); else { input.focus(); openPopup(); } });
  c.on(box, 'pointerdown', e => { if (e.target === box) { e.preventDefault(); input.focus(); } });
  c.on(chips, 'click', e => { const b = e.target.closest('button'); if (!b) return; const prev = p.values; p.values = prev.filter(v => !Object.is(v, b._value)); renderChips(); input.focus(); c.emit(f.el, 'change', { values: p.values, previous: prev }, p.onChange); });
  c.cleanup(() => { c.win.clearTimeout(announceT); loadCtrl?.abort(); lb.destroy(); pos?.cleanup(); handle?.close({ restoreFocus: false }); popup.remove(); });
  function render() {
    input.placeholder = p.placeholder ?? ''; input.disabled = !!p.disabled; input.readOnly = !!p.readOnly;
    box.toggleAttribute('data-disabled', !!p.disabled); box.toggleAttribute('data-readonly', !!p.readOnly);
    toggleBtn.hidden = !!(p.readOnly || p.disabled);
    f.setLabel(p.label); f.setDescription(p.description); f.setRequired(p.required, p.optional);
    const miss = missing();
    if (p.error !== undefined || miss || missingShown) { f.setError(p.error || miss || null); missingShown = !!miss; }
    renderChips();
    if (open) refresh(input.value);
  }
  render(); container.append(f.el);
  return {
    root: f.el, input,
    get value() { return p.multiple ? p.values : p.value; },
    get isOpen() { return open; },
    open: () => { input.focus(); openPopup(); }, close: () => close(),
    update(n) { p = { ...p, ...n }; render(); },
    validate() { const m = validateValue(c, p.multiple ? p.values : p.value, p) || missing(); f.setError(p.error || m); return !m; },
    focus: () => input.focus(),
    destroy: () => c.destroy(),
  };
}
