import { setup, fill, uid } from './base.js';
import { createButton, createSearchField } from './controls.js';
import { openMenu } from './overlays.js';
import { createPagination } from './navigation.js';
import { createEmptyState } from './display.js';
import { createVirtualizer, reconcileChildren } from './virtual.js';
import { createReorder } from '../reorder.js';

/**
 * createTable(container, props, services) — data table (M4).
 *
 * props: { label, columns, rows, rowKey = 'id', rowLabel(row),
 *   selectable: false|'multiple'|'single', selected: key[], onSelectionChange({ selected }),
 *   sort: { id, direction: 'asc'|'desc' }, sortMode: 'client'|'host', onSortChange({ id, direction }),
 *   filter: string | (row) => boolean, onClearFilters, pageSize, page, onPageChange({ page }),
 *   rowMenu: (row) => MenuItem[], onRowMenu({ item, row, key }), onRowAction({ row, key, event }),
 *   bulkActions: [{ id, label, icon, variant }], onBulkAction({ id, keys, rows }),
 *   expandable: (row) => Node | null, totals: { [columnId]: Node | string }, totalsLabel,
 *   loading, error, onRetry, empty: { title, message, action }, hidden: columnId[], columnMenu, onColumnsChange({ hidden }),
 *   stacked: 'auto'|true|false, virtual: { height } (P1: renders only the rows in view inside a scrolling region),
 *   resizable, widths: { [columnId]: px }, onColumnResize({ id, width, widths }),
 *   search: true | { label, placeholder }, query, searchMode: 'client'|'host', onQueryChange({ query }),
 *   status: true (a count and selection line), total (for host data), stale: true | { updatedAt }, disabled }
 * column: { id, label, role: 'primary'|'meta', align: 'start'|'end', priority: 'low', width (CSS track), sortable,
 *   sortValue(row), text(row), cell(row) → Node | string | number, stackLabel, pin: 'start'|'end', minWidth (px), resizable }
 *
 * Pinned columns stay in view while the table scrolls sideways (selection and expand columns join the start side,
 * the action column the end side); not in the stacked layout. Resizable columns get a separator in the header:
 * drag, ← → (16 px, Shift 64 px; mirrored in RTL), Home / End for min / max, Enter or double-click resets.
 *
 * Rows are fixed-track CSS grids with ARIA table roles: no table layout pass, and long tables use content-visibility.
 * Keyboard (row model): one tab stop on the rows; ↑ ↓ Home End PageUp PageDown move; Space selects; Enter runs the row
 * action; Shift+F10 / ContextMenu opens the row menu; Ctrl/⌘+A selects all rows in view. Below 40 rem the table stacks:
 * line 1 holds selection, primary cell and row menu; the other columns wrap below; low-priority columns hide.
 * Since 2.3.0 (G32): `search` adds a search field that filters the rows on the client (or only reports the query with
 * searchMode 'host'); `status` adds a line with the row count and the selection; `stale` shows the compact "not up to
 * date" notice with Retry (onRetry); `disabled` turns every control off while the rows stay readable and navigable.
 * Since 2.5.0 (G58, G57, G64):
 * - `activation`: 'primary' (default: Enter, or a click on the primary cell, runs onRowAction; a primary cell holding a
 *   Node now works too) or 'double-click' (Enter or a double-click anywhere on the row). onRowAction's `via` says which:
 *   'keyboard' | 'click' | 'double-click'. `onRowClick` and `onRowDoubleClick` report plain clicks on the row; clicks on
 *   buttons, links, fields and menus inside a cell never count as the row's. `selectOnClick` (with `selectable`): a click
 *   selects the row, Ctrl / ⌘ + click toggles it, Shift + click and Shift + ↑ ↓ select a range.
 * - `rowState(row) → { current, currentLabel, disabled, unavailable, reason }`: current is marked (aria-current, a bar
 *   at the start edge); disabled rows cannot be selected or acted on; unavailable rows can be selected and use their
 *   menu, but their action announces the reason instead of running. Pass a new function to re-evaluate.
 * - Controls inside cells are reached with Tab from their row (one row's controls at a time).
 * - `groupBy(row) → key`, `groupLabel(key, rows)`: a header row wherever the key changes in the current order; in a
 *   virtual table the current group's header stays at the top while its rows scroll.
 * - `reorderable` + `onReorder({ keys, before, index, order, rows })`: a drag handle per row (pointer, or Space / arrows /
 *   Space on the handle, or Alt + ↑ ↓ on a row); the selected rows move together. The table proposes; the host passes
 *   the new rows. Off while the rows are sorted, filtered, searched, paginated or disabled.
 * - A rows update keeps the focused row focused and, in a virtual table, the first visible row in place.
 * - Motion (D81): when new rows confirm a reorder (within a few seconds of the proposal) the moved rows settle into
 *   place (the drag-release spring) and the rows they passed glide (layout); nimateRows does the same for every rows
 *   update, with new rows fading in, for lists people edit directly (a play queue). Sorting and filtering never move rows.
 */
export function createTable(container, props = {}, services) {
  const c = setup(container, services, 'table');
  let p = { columns: [], rows: [], rowKey: 'id', selectable: false, sortMode: 'client', stacked: 'auto', ...props };
  const tid = uid('tbl');
  const keyOf = typeof p.rowKey === 'function' ? p.rowKey : r => r[p.rowKey];
  const collator = () => new Intl.Collator(c.s.i18n.locale, { numeric: true, sensitivity: 'base' });
  let selected = new Set(p.selected || []), expanded = new Set(), hidden = new Set(p.hidden || []);
  let rowEls = new Map(), textCache = new WeakMap(), view = [], focusKey = null, stacked = false, pager = null, emptyH = null, bulkButtons = [], menu = null, roFrame = 0, virt = null;
  // items: what the body shows in order, rows and group headers (G64); itemOf[i]: the item index of view[i]
  let items = [], itemOf = [], headOf = [], groupEls = new Map(), anchorKey = null, reorder = null;
  let proposed = null; // { keys, until }: a reorder the host may confirm with its next rows (D81)
  const GROUP = Symbol('group'), isGroup = it => !!it?.[GROUP];
  const activation = () => p.activation || 'primary';
  const stateOf = row => p.rowState?.(row) || {};
  const INTERACTIVE = 'a[href], button, input, select, textarea, label, summary, [role="button"], [role="link"], [role="menuitem"], [role="switch"], [role="checkbox"], [contenteditable="true"], [tabindex]';
  const onControl = (e, tr) => { const hit = e.target.closest?.(INTERACTIVE); return !!hit && hit !== tr && tr.contains(hit); };
  // The controls in a cell's content, found by walking its few elements: a selector query per cell cost the 1,000-row
  // mount budget several milliseconds (2.5.0). Same set as INTERACTIVE.
  const CONTROL_TAGS = new Set(['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'LABEL', 'SUMMARY']), CONTROL_ROLES = new Set(['button', 'link', 'menuitem', 'switch', 'checkbox']);
  const isControl = el => CONTROL_TAGS.has(el.tagName) || (el.tagName === 'A' && el.hasAttribute('href')) || el.hasAttribute('tabindex') || CONTROL_ROLES.has(el.getAttribute('role')) || el.getAttribute('contenteditable') === 'true';
  function controlsIn(node) {
    if (!node.getElementsByTagName) return [];
    const out = isControl(node) ? [node] : [];
    for (const el of node.getElementsByTagName('*')) if (isControl(el)) out.push(el);
    return out;
  }
  const reorderOn = () => !!p.reorderable && !p.disabled && !p.loading && !p.error && !p.pageSize && !(p.sort && p.sortMode === 'client') && !p.query && !p.filter;
  const rowOfKey = k => p.rows.find(r => keyOf(r) === k);
  const spacerTop = c.h('div', { class: 'ui-table-spacer', 'aria-hidden': 'true' }), spacerBottom = c.h('div', { class: 'ui-table-spacer', 'aria-hidden': 'true' });

  const head = c.h('div', { role: 'rowgroup', class: 'ui-thead' });
  const body = c.h('div', { role: 'rowgroup', class: 'ui-tbody' });
  const foot = c.h('div', { role: 'rowgroup', class: 'ui-tfoot', hidden: true });
  const table = c.h('div', { class: 'ui-table', role: 'table', id: tid }, head, body, foot);
  const bulkText = c.h('span', { class: 'ui-table-bulk-count' });
  const bulkActs = c.h('div', { class: 'ui-table-bulk-actions' });
  const bulk = c.h('div', { class: 'ui-table-bulk', hidden: true }, bulkText, bulkActs);
  const scroller = c.h('div', { class: 'ui-table-scroll' }, table);
  const footer = c.h('div', { class: 'ui-table-footer', hidden: true });
  // search, count and stale notice above the rows (G32)
  const statusEl = c.h('span', { class: 'ui-table-status' });
  const top = c.h('div', { class: 'ui-table-top', hidden: true }, statusEl);
  const staleBox = c.h('div', { class: 'ui-table-stale', hidden: true });
  let searchH = null, staleH = null, countT = 0, shownCount = 0; // shownCount: rows after filter and search, from the last render
  const el = c.own(c.h('div', { class: 'ui-table-wrap' }, top, staleBox, bulk, scroller, footer));

  const cols = () => p.columns.filter(col => !hidden.has(col.id));
  const primaryOf = () => p.columns.find(col => col.role === 'primary') || p.columns[0];
  const roleOf = col => col.role || (col === primaryOf() ? 'primary' : 'meta');
  const labelOf = row => (p.rowLabel ? p.rowLabel(row) : textOf(row, primaryOf()));
  // ---------------------------------------------------------------- pinning, widths
  let widths = new Map(Object.entries(p.widths || {})), plan = new Map(), order = [];
  const ordered = () => [...p.columns.filter(x => x.pin === 'start'), ...p.columns.filter(x => x.pin !== 'start' && x.pin !== 'end'), ...p.columns.filter(x => x.pin === 'end')];
  function planPins() { // slot key → [side, index, edge]; '@' keys are the selection, expand and action columns
    plan = new Map(); order = ordered();
    if (!p.columns.some(x => x.pin)) return;
    const keys = [...(p.reorderable ? ['@reorder'] : []), ...(p.selectable ? ['@select'] : []), ...(p.expandable ? ['@expand'] : []), ...ordered().map(x => x.id), ...(p.rowMenu || p.columnMenu ? ['@action'] : [])];
    const start = p.columns.some(x => x.pin === 'start'), side = k => (k === '@action' ? 'end' : k[0] === '@' ? (start ? 'start' : null) : p.columns.find(x => x.id === k).pin);
    const put = (list, sd) => { const ks = list.filter(k => side(k) === sd); ks.forEach((k, i) => plan.set(k, [sd, i, i === ks.length - 1])); };
    put(keys, 'start'); put(keys.reverse(), 'end');
  }
  const pin = k => { const x = plan.get(k); return x ? { 'data-pin': x[0], 'data-pin-edge': x[2] || null, style: `inset-inline-${x[0]}: var(--ui-p${x[0][0]}${x[1]}, 0px)` } : {}; };
  function measurePins() {
    if (!plan.size || stacked) return;
    const w = {}, off = { start: 0, end: 0 };
    for (const th of head.firstElementChild?.children || []) w[th._pk] = th.getBoundingClientRect().width;
    for (const [k, [sd, i]] of plan) { table.style.setProperty(`--ui-p${sd[0]}${i}`, `${off[sd]}px`); off[sd] += w[k] || 0; }
    syncPinScroll();
  }
  function syncPinScroll() {
    if (!plan.size) return;
    const x = Math.abs(scroller.scrollLeft), max = scroller.scrollWidth - scroller.clientWidth;
    table.toggleAttribute('data-scroll-start', x > 1); table.toggleAttribute('data-scroll-end', x < max - 1);
  }
  c.on(scroller, 'scroll', syncPinScroll, { passive: true });
  function textOf(row, col) {
    if (!col) return '';
    if (col.text) return String(col.text(row) ?? '');
    const v = row[col.id];
    return v == null ? '' : typeof v === 'object' ? '' : String(v);
  }
  function rowText(row) {
    let t = textCache.get(row);
    if (t == null) { t = p.columns.map(col => textOf(row, col)).join('\u0000').toLowerCase(); textCache.set(row, t); }
    return t;
  }
  const trackOf = col => (widths.has(col.id) ? `${widths.get(col.id)}px` : col.width) || (roleOf(col) === 'primary' ? 'minmax(10rem, 2fr)' : col.align === 'end' ? 'minmax(5.5rem, 1fr)' : 'minmax(6rem, 1fr)');
  function tracks() {
    planPins();
    const t = [];
    if (p.reorderable) t.push('max(2.25rem, var(--cx-hit))');
    if (p.selectable) t.push('max(2.5rem, var(--cx-hit))'); // ≥ 44 px wide at touch density
    if (p.expandable) t.push('2.25rem');
    for (const col of ordered()) if (!hidden.has(col.id)) t.push(trackOf(col));
    if (p.rowMenu || p.columnMenu) t.push('2.75rem');
    table.style.setProperty('--ui-cols', t.join(' '));
  }

  // ---------------------------------------------------------------- header
  let selectAll = null;
  function renderHead() {
    planPins();
    const cells = [];
    if (p.reorderable) cells.push(c.h('div', { role: 'columnheader', class: 'ui-th ui-td-reorder', ...pin('@reorder') }, c.h('span', { class: 'ui-visually-hidden' }, c.s.t('reorder.column'))));
    if (p.selectable) {
      selectAll = p.selectable === 'multiple' ? c.h('input', { type: 'checkbox', class: 'ui-table-check-all', disabled: p.disabled || null }) : null;
      cells.push(c.h('div', { role: 'columnheader', class: 'ui-th ui-td-select', ...pin('@select') }, selectAll ? c.h('label', { class: 'ui-check ui-check-bare' }, selectAll, c.h('span', { class: 'ui-visually-hidden' }, c.s.t('table.selectAll'))) : c.h('span', { class: 'ui-visually-hidden' }, c.s.t('table.select'))));
    }
    if (p.expandable) cells.push(c.h('div', { role: 'columnheader', class: 'ui-th ui-td-expand', ...pin('@expand') }, c.h('span', { class: 'ui-visually-hidden' }, c.s.t('table.details'))));
    for (const col of ordered()) {
      if (hidden.has(col.id)) continue;
      const sorted = p.sort?.id === col.id ? p.sort.direction : null;
      const th = c.h('div', { role: 'columnheader', class: 'ui-th', 'data-col': col.id, 'data-align': col.align || null, 'data-role': roleOf(col), 'data-priority': col.priority || null, 'aria-sort': sorted ? (sorted === 'asc' ? 'ascending' : 'descending') : null, ...pin(col.id) });
      th._pk = col.id;
      if (col.sortable) {
        const b = c.h('button', { type: 'button', class: 'ui-th-sort', disabled: p.disabled || null }, c.h('span', {}, col.label ?? ''), c.icon(sorted === 'desc' ? 'arrow-down' : 'arrow-up'));
        b._col = col; th.append(b);
      } else th.append(c.h('span', { class: col.hideLabel ? 'ui-visually-hidden' : 'ui-th-label' }, col.label ?? ''));
      if (p.resizable && col.resizable !== false) { const r = c.h('div', { class: 'ui-col-resize', role: 'separator', tabindex: '0', 'aria-orientation': 'vertical', 'aria-label': c.s.t('table.resize', { column: col.label ?? col.id }), 'aria-valuemin': minOf(col), 'aria-valuemax': MAXW, 'aria-valuenow': widths.get(col.id) ?? minOf(col) }); r._col = col; th.append(r); }
      cells.push(th);
    }
    if (p.rowMenu || p.columnMenu) {
      const th = c.h('div', { role: 'columnheader', class: 'ui-th ui-td-action', ...pin('@action') });
      if (p.columnMenu) th.append(c.h('button', { type: 'button', disabled: p.disabled || null, class: 'ui-button ui-table-columns', 'data-variant': 'ghost', 'data-icon-only': '', 'aria-label': c.s.t('table.columns'), 'aria-haspopup': 'menu' }, c.icon('settings')));
      else th.append(c.h('span', { class: 'ui-visually-hidden' }, c.s.t('table.actions')));
      cells.push(th);
    }
    const sys = p.reorderable ? 1 : 0;
    if (p.reorderable) cells[0]._pk = '@reorder';
    if (p.selectable) cells[sys]._pk = '@select';
    if (p.expandable) cells[sys + (p.selectable ? 1 : 0)]._pk = '@expand';
    if (p.rowMenu || p.columnMenu) cells[cells.length - 1]._pk = '@action';
    fill(head, c.h('div', { role: 'row', class: 'ui-tr ui-tr-head' }, cells));
    table.toggleAttribute('data-resizable', !!p.resizable);
    if (stacked) syncHeadFocus();
  }

  // ---------------------------------------------------------------- rows
  function cellContent(col, row) {
    const v = col.cell ? col.cell(row) : row[col.id];
    if (v == null || v === '') return null;
    if (roleOf(col) === 'primary' && p.onRowAction && activation() === 'primary' && (typeof v === 'string' || typeof v === 'number')) return c.h('button', { type: 'button', class: 'ui-table-primary', tabindex: '-1', disabled: p.disabled || null }, String(v)); // reached by Enter on the row (one tab stop)
    return typeof v === 'object' ? v : String(v);
  }
  // Rows are cloned from a per-table template and then filled: much cheaper than building each element (1,000-row budget).
  let tpl = null, says = null;
  function template() {
    const tr = c.h('div', { role: 'row', class: 'ui-tr', tabindex: '-1' });
    if (p.reorderable) tr.append(c.h('div', { role: 'cell', class: 'ui-td ui-td-reorder', ...pin('@reorder') }, c.h('button', { type: 'button', class: 'ui-reorder-handle', tabindex: '-1', 'data-row-control': '', 'aria-describedby': hintId, disabled: p.disabled || null }, c.icon('grip'))));
    if (p.selectable) tr.append(c.h('label', { role: 'cell', class: 'ui-td ui-td-select ui-check ui-check-bare', ...pin('@select') }, c.h('input', { disabled: p.disabled || null, type: p.selectable === 'multiple' ? 'checkbox' : 'radio', name: p.selectable === 'single' ? tid : null, class: 'ui-table-check', tabindex: '-1' })));
    if (p.expandable) tr.append(c.h('div', { role: 'cell', class: 'ui-td ui-td-expand', ...pin('@expand') }));
    for (const col of ordered()) {
      const role = roleOf(col);
      tr.append(c.h('div', { role: role === 'primary' ? 'rowheader' : 'cell', class: 'ui-td', 'data-col': col.id, 'data-align': col.align || null, 'data-role': role, 'data-priority': col.priority || null, 'data-label': col.stackLabel ? col.label : null, hidden: hidden.has(col.id) || null, ...pin(col.id) }));
    }
    if (p.rowMenu || p.columnMenu) tr.append(c.h('div', { role: 'cell', class: 'ui-td ui-td-action', ...pin('@action') }, p.rowMenu ? c.h('button', { type: 'button', disabled: p.disabled || null, class: 'ui-button ui-table-menu', 'data-variant': 'ghost', 'data-icon-only': '', tabindex: '-1', 'aria-haspopup': 'menu' }) : null));
    // Localised names with a placeholder, filled per row by string replacement.
    says = { select: c.s.t('table.selectRow', { name: '\u0001' }), menu: c.s.t('table.rowActions', { name: '\u0001' }), expand: c.s.t('table.expand', { name: '\u0001' }), reorder: c.s.t('reorder.handle', { name: '\u0001' }) };
    return tr;
  }
  function buildRow(row) {
    if (!tpl) tpl = template();
    const key = keyOf(row), name = labelOf(row), say = k => says[k].replace('\u0001', name);
    const tr = tpl.cloneNode(true), cells = tr.children;
    tr._row = row; tr._key = key;
    const actCol = p.onRowAction && activation() === 'primary' ? primaryOf() : null;
    let i = 0;
    if (p.reorderable) cells[i++].firstChild.setAttribute('aria-label', say('reorder'));
    if (p.selectable) {
      const box = cells[i++].firstChild;
      box.setAttribute('aria-label', say('select'));
      if (selected.has(key)) { box.checked = true; tr.dataset.selected = ''; }
    }
    if (p.expandable) {
      const cell = cells[i++];
      if (p.expandable(row) != null) cell.append(c.h('button', { type: 'button', class: 'ui-table-expander', tabindex: '-1', disabled: p.disabled || null, 'aria-expanded': String(expanded.has(key)), 'aria-label': say('expand') }, c.icon('chevron-right')));
    }
    for (const col of order) {
      const td = cells[i++], v = cellContent(col, row);
      if (v == null) continue;
      if (typeof v === 'string') td.textContent = v;
      else if (v.classList?.contains('ui-table-primary')) td.append(v);
      else {
        td.append(v);
        for (const x of controlsIn(v)) { x.tabIndex = -1; x.dataset.rowControl = ''; } // app controls: reached with Tab from their row
        if (col === actCol) td.dataset.act = ''; // a click on this cell runs the row action
      }
    }
    if (p.rowMenu) cells[i].firstChild.setAttribute('aria-label', say('menu'));
    if (p.rowState) applyState(tr); else tr._st = NO_STATE; // the default state needs no writes (1,000-row mount budget)
    return tr;
  }
  // Row states (G58): current, disabled, unavailable. Re-applied to every built row when rowState changes.
  const NO_STATE = {};
  const sameState = (a, b) => !!a && !!b && !!a.current === !!b.current && !!a.disabled === !!b.disabled && !!a.unavailable === !!b.unavailable && a.currentLabel === b.currentLabel && a.reason === b.reason;
  function applyState(tr) {
    const st = stateOf(tr._row);
    if (sameState(st, tr._st) && tr._stDisabled === !!p.disabled) return; // a new rowState function re-checks every row; only changes are written
    tr._st = st; tr._stDisabled = !!p.disabled;
    tr.toggleAttribute('data-current', !!st.current);
    if (st.current) tr.setAttribute('aria-current', 'true'); else tr.removeAttribute('aria-current');
    tr.toggleAttribute('data-unavailable', !!st.unavailable);
    if (st.disabled) tr.setAttribute('aria-disabled', 'true'); else tr.removeAttribute('aria-disabled');
    if (!p.disabled) for (const b of tr.querySelectorAll('.ui-table-check, .ui-table-primary, .ui-reorder-handle, .ui-table-expander, .ui-table-menu')) b.disabled = !!st.disabled;
    if (st.unavailable && !tr._mark) { tr._mark = c.icon('block'); tr._mark.classList.add('ui-tr-mark'); tr.querySelector('.ui-td[data-role="primary"]')?.prepend(tr._mark); }
    else if (!st.unavailable && tr._mark) { tr._mark.remove(); tr._mark = null; }
    if (tr.hasAttribute('aria-label')) nameRow(tr);
  }
  function groupEl(key, rows) {
    let g = groupEls.get(key);
    if (!g) { g = c.h('div', { role: 'row', class: 'ui-tr ui-tr-group' }, c.h('div', { role: 'cell', class: 'ui-td' })); groupEls.set(key, g); }
    const label = p.groupLabel ? p.groupLabel(key, rows) : key;
    fill(g.firstChild, label == null ? '' : typeof label === 'object' ? label : String(label));
    return g;
  }
  function rowEl(row) {
    const key = keyOf(row);
    let tr = rowEls.get(key);
    if (!tr || tr._row !== row) { tr = buildRow(row); rowEls.set(key, tr); }
    return tr;
  }
  function expansionEl(tr) {
    if (!tr._exp) {
      const content = p.expandable(tr._row);
      tr._exp = c.h('div', { role: 'row', class: 'ui-tr ui-tr-expansion', id: uid('exp') }, c.h('div', { role: 'cell', class: 'ui-td' }, content));
      tr.querySelector('.ui-table-expander')?.setAttribute('aria-controls', tr._exp.id);
    }
    return tr._exp;
  }

  // ---------------------------------------------------------------- view: filter → sort → page
  function computeView() {
    let rows = p.rows;
    if (typeof p.filter === 'function') rows = rows.filter(p.filter);
    else if (p.filter) { const q = String(p.filter).toLowerCase().trim(); if (q) rows = rows.filter(r => rowText(r).includes(q)); }
    if (p.query && p.searchMode !== 'host') { const q = String(p.query).toLowerCase().trim(); if (q) rows = rows.filter(r => rowText(r).includes(q)); }
    if (p.sort && p.sortMode === 'client') {
      const col = p.columns.find(x => x.id === p.sort.id);
      if (col) {
        const val = col.sortValue || (r => r[col.id]), coll = collator(), dir = p.sort.direction === 'desc' ? -1 : 1;
        const keyed = rows.map((r, i) => ({ r, v: val(r), i }));
        keyed.sort((a, b) => {
          if (a.v == null || a.v === '') return b.v == null || b.v === '' ? a.i - b.i : 1; // empty values last either way
          if (b.v == null || b.v === '') return -1;
          const d = typeof a.v === 'number' && typeof b.v === 'number' ? a.v - b.v : a.v instanceof Date ? a.v - b.v : coll.compare(String(a.v), String(b.v));
          return d * dir || a.i - b.i;
        });
        rows = keyed.map(k => k.r);
      }
    }
    return rows;
  }
  function render() {
    tracks();
    if (p.loading) table.setAttribute('aria-busy', 'true'); else table.removeAttribute('aria-busy');
    if (p.label) table.setAttribute('aria-label', p.label);
    emptyH?.destroy(); emptyH = null;
    const all = p.loading || p.error ? [] : computeView();
    const pageCount = p.pageSize ? Math.max(1, Math.ceil(all.length / p.pageSize)) : 1;
    const page = Math.min(Math.max(1, p.page || 1), pageCount);
    view = p.pageSize ? all.slice((page - 1) * p.pageSize, page * p.pageSize) : all;
    // group headers wherever the group key changes (G64)
    items = []; itemOf = []; headOf = [];
    if (p.groupBy && !p.loading && !p.error) {
      let last = {}, members = null;
      const live = new Set();
      view.forEach(row => {
        const k = p.groupBy(row);
        if (k !== last) { last = k; members = []; live.add(k); headOf.push(items.length); items.push({ [GROUP]: true, group: k, rows: members }); }
        members.push(row); itemOf.push(items.length); headOf.push(headOf[headOf.length - 1]); items.push(row);
      });
      for (const it of items) if (isGroup(it)) it.el = groupEl(it.group, it.rows);
      for (const k of groupEls.keys()) if (!live.has(k)) groupEls.delete(k);
    } else { items = view; itemOf = view.map((_, i) => i); }
    table.setAttribute('aria-rowcount', String(all.length + (items.length - view.length) + 1 + (p.totals ? 1 : 0)));
    let out = [];
    if (p.loading) out = Array.from({ length: 5 }, () => c.h('div', { role: 'row', class: 'ui-tr ui-tr-skeleton', 'aria-hidden': 'true' }, cols().map(() => c.h('div', { class: 'ui-td' }, c.h('span', { class: 'ui-skeleton-line' })))));
    else if (p.error || !view.length) {
      const cell = c.h('div', { role: 'cell', class: 'ui-td' });
      out = [c.h('div', { role: 'row', class: 'ui-tr ui-tr-empty' }, cell)];
      const filtered = !p.error && p.rows.length > 0;
      emptyH = createEmptyState(cell, { kind: p.error ? 'error' : filtered ? 'filtered' : 'empty', ...(p.error ? { message: typeof p.error === 'string' ? p.error : undefined } : filtered ? {} : p.empty), onRetry: p.onRetry, onClearFilters: p.onClearFilters }, c.s);
    } else {
      if (!p.virtual) items.forEach((row, i) => {
        if (isGroup(row)) { row.el.setAttribute('aria-rowindex', String((page - 1) * (p.pageSize || 0) + i + 2)); out.push(row.el); return; }
        const tr = rowEl(row);
        tr.setAttribute('aria-rowindex', String((page - 1) * (p.pageSize || 0) + i + 2));
        out.push(tr);
        if (expanded.has(tr._key)) out.push(expansionEl(tr));
      });
    }
    // Long unpaginated tables skip layout and paint for off-screen rows; virtual tables render only the rows in view.
    const virtual = !!p.virtual && !p.pageSize && view.length > 0 && !p.loading && !p.error;
    table.toggleAttribute('data-long', !virtual && view.length > 60);
    scroller.toggleAttribute('data-virtual', !!p.virtual);
    scroller.style.height = p.virtual ? (p.virtual.height || '32rem') : '';
    if (virtual) {
      // the sticky column headers (and a carried group header) cover the top of the scroller: rows scrolled to stay clear
      if (!virt) virt = createVirtualizer({ scroller, list: body, count: items.length, estimate: rowEls.values().next().value?.offsetHeight || 40, overscan: 8, onRange: paintRange, inset: () => head.offsetHeight + (p.groupBy ? groupEls.values().next().value?.offsetHeight || 0 : 0) });
      else virt.setCount(items.length);
      virt.update();
    } else { virt?.destroy(); virt = null; body.replaceChildren(...out); }
    // forget rows that no longer exist
    if (rowEls.size > p.rows.length * 1.5 + 50) { const live = new Set(p.rows.map(keyOf)); for (const k of rowEls.keys()) if (!live.has(k)) rowEls.delete(k); }
    shownCount = all.length;
    table.toggleAttribute('data-reorder-off', !!p.reorderable && !reorderOn());
    table.toggleAttribute('data-reorderable', !!p.reorderable);
    table.dataset.activation = activation();
    renderFoot(); syncSelectAll(); syncBulk(); syncRoving(); measurePins(); renderTop();
    reorder?.refresh();
    // pagination
    footer.hidden = !p.pageSize || p.loading || !!p.error || all.length <= p.pageSize;
    if (!footer.hidden) {
      const props = { page, pageCount, total: all.length, pageSize: p.pageSize, disabled: !!p.disabled, onChange: e => { p.page = e.page; render(); c.emit(el, 'page-change', { page: e.page }, p.onPageChange); } };
      if (pager) pager.update(props); else pager = createPagination(footer, props, c.s);
    }
  }
  function paintRange({ start, end, top, bottom }) {
    const out = [spacerTop];
    // the current group's header stays at the top while its rows scroll (it takes no space there: see .ui-tr-group)
    let carried = null;
    if (p.groupBy) table.style.setProperty('--ui-head-h', `${head.offsetHeight}px`); // group headers stick under the column headers
    if (p.groupBy && items[start] && !isGroup(items[start]) && headOf[start] < start) carried = items[headOf[start]].el;
    if (carried) { carried.dataset.carried = ''; out.push(carried); }
    for (let i = start; i < end; i++) {
      const it = items[i];
      if (isGroup(it)) { if (it.el !== carried) { delete it.el.dataset.carried; it.el.style.marginBlockEnd = ''; it.el.setAttribute('aria-rowindex', String(i + 2)); out.push(it.el); } continue; }
      const tr = rowEl(it);
      tr.setAttribute('aria-rowindex', String(i + 2));
      out.push(tr);
      if (expanded.has(tr._key)) out.push(expansionEl(tr));
    }
    out.push(spacerBottom);
    spacerTop.style.height = `${top}px`; spacerBottom.style.height = `${bottom}px`;
    // Removing the focused row makes browsers reset the scroll position: park focus on the scroll region first.
    const focused = c.doc.activeElement;
    if (focused && body.contains(focused) && !out.some(x => x.contains(focused))) { scroller.tabIndex = -1; scroller.focus({ preventScroll: true }); }
    reconcileChildren(body, out);
    let changed = false;
    for (let i = start; i < end; i++) { const it = items[i], tr = isGroup(it) ? it.el : rowEls.get(keyOf(it)); changed = virt.measure(i, tr.offsetHeight + (expanded.has(tr._key) ? tr._exp?.offsetHeight || 0 : 0)) || changed; }
    if (carried) carried.style.marginBlockEnd = `${-carried.offsetHeight}px`;
    if (changed) { spacerTop.style.height = `${virt.offsetOf(start)}px`; spacerBottom.style.height = `${virt.total() - virt.offsetOf(end)}px`; }
    syncRoving();
  }
  function countText(shown) {
    const total = p.total ?? (p.searchMode === 'host' ? shown : p.rows.length);
    return shown === total ? c.s.t('table.count', { count: total }) : c.s.t('table.countOf', { shown: c.s.format.number(shown), total: c.s.format.number(total) });
  }
  const renderStatus = () => { statusEl.hidden = !p.status; if (p.status) statusEl.textContent = [countText(shownCount), selected.size ? c.s.t('selected', { count: selected.size }) : null].filter(Boolean).join(' · '); };
  function renderTop() {
    const s = p.search === true ? {} : p.search;
    if (s && !searchH) {
      searchH = createSearchField(top, { label: s.label ?? c.s.t('search'), hideLabel: true, placeholder: s.placeholder ?? c.s.t('search'), value: p.query ?? '',
        onInput: e => {
          p.query = e.value;
          c.emit(el, 'query-change', { query: e.value }, p.onQueryChange);
          if (p.searchMode === 'host') return;
          p.page = 1; render();
          // the new count once typing pauses, not on every key
          c.win.clearTimeout(countT); countT = c.win.setTimeout(() => c.s.announce(countText(shownCount)), 600);
        } }, c.s);
      top.prepend(searchH.root);
    } else if (!s && searchH) { searchH.destroy(); searchH = null; }
    searchH?.update({ disabled: !!p.disabled, ...(searchH.input.value !== (p.query ?? '') && c.doc.activeElement !== searchH.input ? { value: p.query ?? '' } : {}) });
    renderStatus();
    top.hidden = !s && !p.status;
    if (p.stale) {
      const o = { kind: 'stale', updatedAt: p.stale === true ? undefined : p.stale.updatedAt, onRetry: p.onRetry, busy: !!p.loading };
      if (staleH) staleH.update(o); else staleH = createEmptyState(staleBox, o, c.s);
    } else if (staleH) { staleH.destroy(); staleH = null; }
    staleBox.hidden = !p.stale;
  }
  function renderFoot() {
    foot.hidden = !p.totals;
    if (!p.totals) return;
    const cells = [];
    if (p.reorderable) cells.push(c.h('div', { role: 'cell', class: 'ui-td ui-td-reorder', ...pin('@reorder') }));
    if (p.selectable) cells.push(c.h('div', { role: 'cell', class: 'ui-td ui-td-select', ...pin('@select') }));
    if (p.expandable) cells.push(c.h('div', { role: 'cell', class: 'ui-td ui-td-expand', ...pin('@expand') }));
    for (const col of ordered()) {
      if (hidden.has(col.id)) continue;
      const v = p.totals[col.id] ?? (roleOf(col) === 'primary' ? (p.totalsLabel ?? c.s.t('table.total')) : '');
      cells.push(c.h('div', { role: roleOf(col) === 'primary' ? 'rowheader' : 'cell', class: 'ui-td', 'data-col': col.id, 'data-align': col.align || null, 'data-role': roleOf(col), 'data-priority': col.priority || null, 'data-label': (col.stackLabel || roleOf(col) !== 'primary') && v !== '' ? col.label : null, ...pin(col.id) }, v));
    }
    if (p.rowMenu || p.columnMenu) cells.push(c.h('div', { role: 'cell', class: 'ui-td ui-td-action', ...pin('@action') }));
    fill(foot, c.h('div', { role: 'row', class: 'ui-tr ui-tr-total' }, cells));
  }

  // ---------------------------------------------------------------- selection
  function syncSelectAll() {
    if (!selectAll) return;
    const keys = view.map(keyOf), n = keys.filter(k => selected.has(k)).length;
    selectAll.checked = n > 0 && n === keys.length; selectAll.indeterminate = n > 0 && n < keys.length; selectAll.disabled = !keys.length || !!p.disabled;
  }
  let announceT = 0;
  function syncBulk() {
    const show = !!p.bulkActions?.length && selected.size > 0;
    bulk.hidden = !show;
    if (!show) return;
    bulkText.textContent = c.s.t('selected', { count: selected.size });
    for (const b of bulkButtons) b.update({ disabled: !!p.disabled });
    if (!bulkButtons.length) {
      bulkButtons = p.bulkActions.map(a => createButton(bulkActs, { label: a.label, icon: a.icon, variant: a.variant || 'secondary', onClick: () => { const keys = [...selected]; c.emit(el, 'bulk-action', { id: a.id, keys, rows: p.rows.filter(r => selected.has(keyOf(r))) }, p.onBulkAction); } }, c.s));
      bulkButtons.push(createButton(bulkActs, { label: c.s.t('table.clearSelection'), variant: 'ghost', onClick: () => setSelected([]) }, c.s));
    }
  }
  function setSelected(keys, announce = true) {
    selected = new Set(keys);
    for (const tr of rowEls.values()) {
      const on = selected.has(tr._key), box = tr.querySelector('.ui-table-check');
      if (box && box.checked !== on) box.checked = on;
      tr.toggleAttribute('data-selected', on);
    }
    syncSelectAll(); syncBulk(); renderStatus();
    if (announce) { c.win.clearTimeout(announceT); announceT = c.win.setTimeout(() => c.s.announce(c.s.t('selected', { count: selected.size })), 300); }
    c.emit(el, 'selection-change', { selected: [...selected] }, p.onSelectionChange);
  }
  function toggleRow(tr) {
    if (!p.selectable || p.disabled || tr._st?.disabled) return;
    const k = tr._key;
    anchorKey = k;
    if (p.selectable === 'single') setSelected(selected.has(k) ? [] : [k]);
    else { const next = new Set(selected); next.has(k) ? next.delete(k) : next.add(k); setSelected([...next]); }
  }

  // ---------------------------------------------------------------- keyboard rows (one tab stop)
  const rowsInView = () => [...body.children].filter(x => x._key !== undefined);
  let curRow = null;
  function syncRoving() {
    const list = rowsInView();
    if (!list.length) return;
    const cur = list.find(x => x._key === focusKey) || list[0];
    for (const tr of list) if (tr.tabIndex !== (tr === cur ? 0 : -1)) tr.tabIndex = tr === cur ? 0 : -1;
    // the current row's own controls are in the tab order after it; every other row's are not
    if (cur !== curRow) { for (const x of curRow?.querySelectorAll('[data-row-control]') || []) x.tabIndex = -1; for (const x of cur.querySelectorAll('[data-row-control]')) x.tabIndex = 0; curRow = cur; }
    focusKey = cur._key;
  }
  function focusRow(tr) { if (!tr) return; focusKey = tr._key; syncRoving(); tr.focus({ preventScroll: !!virt }); }
  function focusIndex(i) { if (!virt || !view[i]) return; virt.scrollToIndex(itemOf[i]); focusRow(rowEls.get(keyOf(view[i]))); }
  const selectableKeys = rows => rows.filter(r => !stateOf(r).disabled).map(keyOf);
  // Selection by pointer and Shift (selectOnClick, G58): a range runs from the last row clicked or toggled.
  function selectRange(k, add) {
    const keys = view.map(keyOf), a = keys.indexOf(anchorKey), b = keys.indexOf(k);
    if (a < 0 || b < 0) { anchorKey = k; setSelected(selectableKeys(view.filter(r => keyOf(r) === k))); return; }
    const range = selectableKeys(view.slice(Math.min(a, b), Math.max(a, b) + 1));
    setSelected(add ? [...new Set([...selected, ...range])] : range);
  }
  function clickSelect(tr, e) {
    const multi = p.selectable === 'multiple';
    if (multi && e.shiftKey && anchorKey != null) selectRange(tr._key, e.ctrlKey || e.metaKey);
    else if (multi && (e.ctrlKey || e.metaKey)) toggleRow(tr);
    else { anchorKey = tr._key; setSelected([tr._key]); }
  }
  function act(tr, e, via) {
    if (p.disabled || tr._st?.disabled || !p.onRowAction) return;
    if (tr._st?.unavailable) { c.s.announce(tr._st.reason || c.s.t('table.unavailable')); return; }
    c.emit(el, 'row-action', { row: tr._row, key: tr._key, event: e, via }, p.onRowAction);
  }
  c.on(body, 'keydown', e => {
    const tr = e.target.closest?.('.ui-tr'); if (!tr || tr._key === undefined) return;
    // keys typed into a control inside a cell (select, text, spinbutton…) belong to that control
    if (e.target !== tr && e.target.closest('select, textarea, input:not([type="checkbox"]):not([type="radio"]), [contenteditable="true"], [role="combobox"], [role="spinbutton"], [role="slider"]')) return;
    const onRow = e.target === tr, list = rowsInView(), i = list.indexOf(tr);
    const move = { ArrowDown: 1, ArrowUp: -1, PageDown: 10, PageUp: -10 }[e.key];
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && reorderOn()) { e.preventDefault(); reorder.moveBy(tr._key, e.key === 'ArrowUp' ? -1 : 1); return; }
    const extend = e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && p.selectOnClick && p.selectable === 'multiple' && !p.disabled;
    if (extend && anchorKey == null) anchorKey = tr._key;
    if (virt && (move || (onRow && (e.key === 'Home' || e.key === 'End')))) { // by index: the target may not be rendered yet
      e.preventDefault();
      const at = view.findIndex(r => keyOf(r) === tr._key), n = view.length;
      focusIndex(e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : Math.max(0, Math.min(n - 1, at + move)));
      if (extend) selectRange(focusKey, false);
    }
    else if (move) { e.preventDefault(); focusRow(list[Math.max(0, Math.min(list.length - 1, i + move))]); if (extend) selectRange(focusKey, false); }
    else if (e.key === 'Home' && onRow) { e.preventDefault(); focusRow(list[0]); }
    else if (e.key === 'End' && onRow) { e.preventDefault(); focusRow(list[list.length - 1]); }
    else if (e.key === ' ' && onRow && p.selectable) { e.preventDefault(); toggleRow(tr); }
    else if (p.disabled && (e.key === 'Enter' || e.key === 'F10' || e.key === 'ContextMenu' || ((e.key === 'a' || e.key === 'A') && (e.ctrlKey || e.metaKey)) || e.key === 'ArrowRight' || e.key === 'ArrowLeft')) { if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') e.preventDefault(); } // reading only
    else if (e.key === 'Enter' && onRow) { e.preventDefault(); if (p.onRowAction) act(tr, e, 'keyboard'); else if (p.expandable) toggleExpand(tr); }
    else if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') { const b = tr.querySelector('.ui-table-menu'); if (b) { e.preventDefault(); openRowMenu(tr, b); } }
    else if ((e.key === 'a' || e.key === 'A') && (e.ctrlKey || e.metaKey) && onRow && p.selectable === 'multiple') { e.preventDefault(); setSelected([...new Set([...selected, ...selectableKeys(view)])]); }
    else if (e.key === 'ArrowRight' && onRow && p.expandable && !expanded.has(tr._key)) { e.preventDefault(); toggleExpand(tr); }
    else if (e.key === 'ArrowLeft' && onRow && expanded.has(tr._key)) { e.preventDefault(); toggleExpand(tr); }
  });
  // A focused row is announced by its name: the text of its visible cells (set when it gets focus, so mounting costs nothing).
  function nameRow(tr) {
    const st = tr._st || {};
    // decoration marked aria-hidden (an equaliser, a badge's letter) stays out of the name
    const text = td => { if (!td.querySelector('[aria-hidden="true"]')) return td.textContent; const x = td.cloneNode(true); for (const h of x.querySelectorAll('[aria-hidden="true"]')) h.remove(); return x.textContent; };
    const parts = [...tr.children].filter(td => !td.hidden && !td.matches('.ui-td-select, .ui-td-expand, .ui-td-action, .ui-td-reorder') && td.getClientRects().length).map(td => text(td).trim()).filter(Boolean);
    if (st.current) parts.push(st.currentLabel || c.s.t('table.current'));
    if (st.unavailable) parts.push(st.reason || c.s.t('table.unavailable'));
    tr.setAttribute('aria-label', parts.join(', '));
  }
  c.on(body, 'focusin', e => { const tr = e.target.closest?.('.ui-tr'); if (tr && tr._key !== undefined) { if (e.target === tr) nameRow(tr); if (tr._key !== focusKey) { focusKey = tr._key; syncRoving(); } } });
  function toggleExpand(tr) {
    const k = tr._key, open = !expanded.has(k);
    if (open) expanded.add(k); else expanded.delete(k);
    tr.querySelector('.ui-table-expander')?.setAttribute('aria-expanded', String(open));
    tr.toggleAttribute('data-expanded', open);
    if (open) { const x = expansionEl(tr); tr.after(x); c.s.motion.animate(x, { o: 1 }, { role: 'enter', from: { o: 0 } }); }
    else tr._exp?.remove();
  }
  function openRowMenu(tr, anchor) {
    const items = p.rowMenu(tr._row);
    if (!items?.length) return;
    anchor.setAttribute('aria-expanded', 'true');
    menu?.close('switch', { restoreFocus: false });
    menu = openMenu(c.s, { items, trigger: anchor, anchor, placement: 'bottom-end', label: c.s.t('table.rowActions', { name: labelOf(tr._row) }), onSelect: (item, ev) => c.emit(el, 'row-menu', { item, row: tr._row, key: tr._key, event: ev }, p.onRowMenu), onClose: () => { anchor.setAttribute('aria-expanded', 'false'); menu = null; } });
  }

  // ---------------------------------------------------------------- pointer
  c.on(body, 'change', e => { const box = e.target.closest('.ui-table-check'); if (box) { const tr = box.closest('.ui-tr'); focusKey = tr._key; toggleRow(tr); } });
  c.on(head, 'change', e => { if (e.target === selectAll) { const keys = selectableKeys(view); setSelected(selectAll.checked ? [...new Set([...selected, ...keys])] : [...selected].filter(k => !keys.includes(k))); } });
  c.on(body, 'click', e => {
    const tr = e.target.closest('.ui-tr'); if (!tr || tr._key === undefined) return;
    if (p.disabled) return;
    const menu = e.target.closest('.ui-table-menu'), exp = e.target.closest('.ui-table-expander'), prim = e.target.closest('.ui-table-primary');
    if (focusKey !== tr._key) { focusKey = tr._key; syncRoving(); }
    if (menu) openRowMenu(tr, menu);
    else if (exp) toggleExpand(tr);
    else if (prim) act(tr, e, 'click');
    else if (!onControl(e, tr)) {
      if (p.selectOnClick && p.selectable && !tr._st?.disabled) clickSelect(tr, e);
      c.emit(el, 'row-click', { row: tr._row, key: tr._key, event: e }, p.onRowClick);
      // a primary cell holding a Node has no button of its own: a click on the cell is the row action (G58)
      if (activation() === 'primary' && e.target.closest('.ui-td[data-role="primary"]') && !tr.querySelector('.ui-table-primary')) act(tr, e, 'click');
    }
  });
  c.on(body, 'dblclick', e => {
    const tr = e.target.closest('.ui-tr'); if (!tr || tr._key === undefined || p.disabled || onControl(e, tr)) return;
    c.emit(el, 'row-double-click', { row: tr._row, key: tr._key, event: e }, p.onRowDoubleClick);
    if (activation() === 'double-click') act(tr, e, 'double-click');
  });
  // a double-click activates; it should not also select the word under the pointer
  c.on(body, 'mousedown', e => { const tr = e.target.closest('.ui-tr'); if (e.detail > 1 && tr && activation() === 'double-click' && !onControl(e, tr)) e.preventDefault(); });
  c.on(head, 'click', e => {
    const sortBtn = e.target.closest('.ui-th-sort');
    if (sortBtn) {
      const col = sortBtn._col, dir = p.sort?.id === col.id && p.sort.direction === 'asc' ? 'desc' : 'asc';
      p.sort = { id: col.id, direction: dir };
      c.emit(el, 'sort-change', { ...p.sort }, p.onSortChange);
      renderHead(); render();
      head.querySelector(`[data-col="${col.id}"] .ui-th-sort`)?.focus();
      return;
    }
    const colBtn = e.target.closest('.ui-table-columns');
    if (colBtn) {
      menu?.close('switch', { restoreFocus: false });
      menu = openMenu(c.s, { onClose: () => { menu = null; }, items: p.columns.filter(col => roleOf(col) !== 'primary').map(col => ({ id: col.id, label: col.label, checked: !hidden.has(col.id) })), trigger: colBtn, anchor: colBtn, placement: 'bottom-end', label: c.s.t('table.columns'),
        onSelect: item => { hidden.has(item.id) ? hidden.delete(item.id) : hidden.add(item.id); applyHidden(); c.emit(el, 'columns-change', { hidden: [...hidden] }, p.onColumnsChange); } });
    }
  });
  function applyHidden() {
    tpl = null;
    for (const tr of rowEls.values()) for (const td of tr.querySelectorAll('.ui-td[data-col]')) td.hidden = hidden.has(td.dataset.col);
    renderHead(); tracks(); renderFoot(); syncSelectAll();
  }

  // ---------------------------------------------------------------- column resizing
  const MAXW = 960, minOf = col => col.minWidth ?? (roleOf(col) === 'primary' ? 96 : 56);
  const widthOf = r => Math.round(r.parentElement.getBoundingClientRect().width);
  function setWidth(r, w, done) {
    const col = r._col;
    if (w == null) widths.delete(col.id); else widths.set(col.id, Math.round(Math.min(MAXW, Math.max(minOf(col), w))));
    tracks(); measurePins(); r.setAttribute('aria-valuenow', widthOf(r));
    if (done) c.emit(el, 'column-resize', { id: col.id, width: widths.get(col.id) ?? null, widths: Object.fromEntries(widths) }, p.onColumnResize);
  }
  const rtl = () => c.win.getComputedStyle(el).direction === 'rtl';
  c.on(head, 'focusin', e => { if (e.target.classList?.contains('ui-col-resize')) e.target.setAttribute('aria-valuenow', widthOf(e.target)); });
  c.on(head, 'keydown', e => {
    const r = e.target.closest?.('.ui-col-resize'); if (!r) return;
    const step = e.shiftKey ? 64 : 16, dir = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (dir) setWidth(r, widthOf(r) + dir * step * (rtl() ? -1 : 1), true);
    else if (e.key === 'Home') setWidth(r, 0, true);
    else if (e.key === 'End') setWidth(r, MAXW, true);
    else if (e.key === 'Enter') setWidth(r, null, true);
    else return;
    e.preventDefault(); e.stopPropagation();
  });
  c.on(head, 'dblclick', e => { const r = e.target.closest?.('.ui-col-resize'); if (r) setWidth(r, null, true); });
  c.on(head, 'pointerdown', e => {
    const r = e.target.closest?.('.ui-col-resize'); if (!r || e.button !== 0) return;
    e.preventDefault(); r.focus({ preventScroll: true });
    const x0 = e.clientX, w0 = widthOf(r), sign = rtl() ? -1 : 1, before = widths.get(r._col.id);
    let frame = 0, last = x0;
    try { r.setPointerCapture(e.pointerId); } catch { /* synthetic or ended pointer */ }
    r.dataset.active = '';
    const move = ev => { last = ev.clientX; if (!frame) frame = c.win.requestAnimationFrame(() => { frame = 0; setWidth(r, w0 + (last - x0) * sign); }); };
    const end = ev => {
      c.win.cancelAnimationFrame(frame); frame = 0; delete r.dataset.active;
      r.removeEventListener('pointermove', move); r.removeEventListener('pointerup', end); r.removeEventListener('pointercancel', end); r.removeEventListener('keydown', esc);
      if (ev.type === 'pointerup') setWidth(r, w0 + (ev.clientX - x0) * sign, true); else setWidth(r, before ?? null);
    };
    const esc = ev => { if (ev.key === 'Escape') { ev.stopPropagation(); end(ev); } };
    r.addEventListener('pointermove', move); r.addEventListener('pointerup', end); r.addEventListener('pointercancel', end); r.addEventListener('keydown', esc);
  });

  // ---------------------------------------------------------------- row motion (D81)
  // Rows rendered before and after an update move from where they were; moved rows (a confirmed reorder) settle with the
  // drag-release spring, the others glide; new rows fade in when animateRows is on. Reduced motion: no travel.
  function glide(before, moved) {
    const m = c.s.motion;
    for (const tr of rowsInView()) {
      const top = before.get(tr._key), now = tr.getBoundingClientRect().top;
      if (top == null) { if (p.animateRows && before.size) m.animate(tr, { o: 1 }, { role: 'enter', from: { o: 0 } }).then(ok => { if (ok) m.reset(tr); }); continue; }
      const dy = top - now;
      if (Math.abs(dy) < 0.5) continue;
      m.animate(tr, { y: 0 }, { role: moved?.has(tr._key) ? 'drag' : 'layout', from: { y: dy } }).then(ok => { if (ok) m.reset(tr); });
    }
  }

  // ---------------------------------------------------------------- stacked mode
  // Applied in the next frame: switching layout resizes the observed element (avoids a ResizeObserver loop).
  const ro = new c.win.ResizeObserver(() => { c.win.cancelAnimationFrame(roFrame); roFrame = c.win.requestAnimationFrame(applyStacked); });
  function applyStacked() {
    const rem = parseFloat(c.win.getComputedStyle(c.doc.documentElement).fontSize) || 16;
    const next = p.stacked === true || (p.stacked === 'auto' && el.clientWidth > 0 && el.clientWidth < 40 * rem);
    if (next !== stacked) { stacked = next; table.toggleAttribute('data-stacked', stacked); syncHeadFocus(); }
    measurePins();
    if (p.resizable && !stacked) for (const r of head.querySelectorAll('.ui-col-resize')) r.setAttribute('aria-valuenow', widthOf(r));
  }
  // Stacked: header cells other than the primary are visually hidden; their sort buttons leave the tab order.
  function syncHeadFocus() { for (const r of head.querySelectorAll('.ui-col-resize')) r.tabIndex = stacked ? -1 : 0; for (const b of head.querySelectorAll('.ui-th-sort')) { if (stacked && b.closest('.ui-th').dataset.role !== 'primary') b.tabIndex = -1; else b.removeAttribute('tabindex'); } }
  ro.observe(el);
  // Reordering (G57): a handle per row; the table proposes the new order and the host confirms it with new rows.
  const hintId = uid('rh');
  el.append(c.h('span', { id: hintId, class: 'ui-visually-hidden' }, c.s.t('reorder.hint')));
  reorder = createReorder({
    s: c.s, container: body, handleSelector: '.ui-reorder-handle',
    rowOf: x => { const tr = x.closest?.('.ui-tr'); return tr && tr._key !== undefined ? { key: tr._key } : null; },
    rendered: rowsInView, keys: () => p.rows.map(keyOf), selected: () => [...selected], labelOf: k => labelOf(rowOfKey(k)), enabled: reorderOn,
    reveal: k => { const i = view.findIndex(r => keyOf(r) === k); if (i < 0) return null; if (virt) virt.scrollToIndex(itemOf[i]); else rowEls.get(k)?.scrollIntoView({ block: 'nearest' }); const tr = rowEls.get(k); return tr?.isConnected ? tr : null; },
    onMove: d => { proposed = { keys: new Set(d.keys), until: Date.now() + 4000 }; c.emit(el, 'reorder', { ...d, rows: d.keys.map(rowOfKey) }, p.onReorder); },
    afterMove: (k, viaHandle) => { if (!viaHandle) c.win.requestAnimationFrame(() => api.focusRow(k)); },
  });
  c.cleanup(() => { reorder.destroy(); virt?.destroy(); ro.disconnect(); c.win.cancelAnimationFrame(roFrame); menu?.close('destroy', { restoreFocus: false }); c.win.clearTimeout(announceT); c.win.clearTimeout(countT); searchH?.destroy(); staleH?.destroy(); pager?.destroy(); emptyH?.destroy(); for (const b of bulkButtons) b.destroy(); });

  renderHead(); render();
  container.append(el);
  const api = {
    root: el, table,
    get selected() { return [...selected]; }, get rows() { return view.slice(); }, get stacked() { return stacked; }, get widths() { return Object.fromEntries(widths); },
    setSelected: keys => setSelected(keys, false),
    focusRow: key => (virt ? focusIndex(view.findIndex(r => keyOf(r) === key)) : focusRow(rowsInView().find(x => x._key === key))),
    scrollToRow: key => { const i = view.findIndex(r => keyOf(r) === key); if (virt) virt.scrollToIndex(itemOf[i], 'center'); else rowEls.get(key)?.scrollIntoView({ block: 'nearest' }); },
    update(n) {
      const structural = ['columns', 'selectable', 'expandable', 'rowMenu', 'columnMenu', 'rowKey', 'disabled', 'reorderable', 'activation'].some(k => k in n && n[k] !== p[k]); // disabled rebuilds the row template
      // keep the focused row focused, and the first visible row of a virtual table where it was (G62)
      const a = c.doc.activeElement, ftr = a && body.contains(a) ? a.closest('.ui-tr') : null, fkey = ftr?._key;
      const fidx = fkey !== undefined ? view.findIndex(r => keyOf(r) === fkey) : -1;
      // a confirmed reorder or an edited list: remember where the rendered rows were (D81)
      const confirm = 'rows' in n && proposed && Date.now() < proposed.until ? proposed : null, animate = 'rows' in n && (confirm || p.animateRows || n.animateRows) && !p.sort;
      const before = animate ? new Map(rowsInView().map(tr => [tr._key, tr.getBoundingClientRect().top])) : null;
      if (confirm) proposed = null;
      let anchor = null;
      if (virt && 'rows' in n) {
        const sr = scroller.getBoundingClientRect(), headH = head.offsetHeight;
        const first = rowsInView().find(tr => tr.getBoundingClientRect().bottom > sr.top + headH);
        if (first) anchor = { key: first._key, dy: first.getBoundingClientRect().top - sr.top };
      }
      p = { ...p, ...n };
      if ('selected' in n) selected = new Set(n.selected || []);
      if ('hidden' in n) hidden = new Set(n.hidden || []);
      if ('widths' in n) widths = new Map(Object.entries(n.widths || {}));
      if ('rows' in n) textCache = new WeakMap();
      if (structural) { rowEls = new Map(); expanded = new Set(); tpl = null; }
      if (('rows' in n || 'selected' in n) && !structural) for (const tr of rowEls.values()) { const box = tr.querySelector('.ui-table-check'); if (box) box.checked = selected.has(tr._key); tr.toggleAttribute('data-selected', selected.has(tr._key)); }
      if ('bulkActions' in n) { for (const b of bulkButtons) b.destroy(); bulkButtons = []; }
      if ('search' in n && !n.search) { searchH?.destroy(); searchH = null; }
      if ('stacked' in n) ro.observe(el);
      if ('rowState' in n && !structural) for (const tr of rowEls.values()) applyState(tr);
      // foobar2k patch P2 (PATCHES.md): only the rows' state changed (the playing track): applyState above has marked
      // them; rebuilding every row (and the layout of a long list) is not needed
      if (Object.keys(n).every(k => k === 'rowState')) return;
      renderHead(); render();
      if (anchor && virt) {
        const i = view.findIndex(r => keyOf(r) === anchor.key);
        if (i >= 0) {
          const bodyTop = body.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
          scroller.scrollTop = Math.max(0, bodyTop + virt.offsetOf(itemOf[i]) - anchor.dy); virt.update();
          // rows painted for the first time are measured then and may differ from the estimate: correct once by the real position
          const tr = rowEls.get(anchor.key), d = tr?.isConnected ? tr.getBoundingClientRect().top - scroller.getBoundingClientRect().top - anchor.dy : 0;
          if (Math.abs(d) >= 1) { scroller.scrollTop += d; virt.update(); }
        }
      }
      if (fkey !== undefined && !body.contains(c.doc.activeElement)) {
        const tr = rowEls.get(fkey);
        if (tr?.isConnected && view.some(r => keyOf(r) === fkey)) { focusKey = fkey; syncRoving(); tr.focus({ preventScroll: true }); }
        else if (fidx >= 0 && view.length) api.focusRow(keyOf(view[Math.min(fidx, view.length - 1)])); // the focused row was removed: the one now in its place
      }
      if (before) glide(before, confirm?.keys);
    },
    focus: () => (rowsInView().find(x => x.tabIndex === 0) || rowsInView()[0])?.focus(),
    destroy: () => c.destroy(),
  };
  return api;
}
