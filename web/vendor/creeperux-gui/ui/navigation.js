import { setup, fill, uid, safeHref } from './base.js';
import { createButton, createSearchField } from './controls.js';
import { createSelect } from './select.js';
import { createDatePicker } from './date.js';
import { createMenuButton } from './overlays.js';
import { createRovingFocus } from '../interaction.js';

// M3 navigation. Selection indicators glide with the control spring; everything else changes in place (D27).

const fmtCount = (c, n) => (typeof n === 'number' ? (n > 99 ? `${c.s.format.number(99)}+` : c.s.format.number(n)) : n);

// ---------------------------------------------------------------- nav list
/**
 * createNavList(container, { items: [{ id, label, short, icon, href, badge, attention, section, children }], value, label,
 *   layout: 'list'|'rail'|'bar', maxItems, expanded: [id], onNavigate({ id, item, event }) }, services)
 * Links when items have href (the host may preventDefault in onNavigate for client routing), buttons otherwise.
 * With maxItems, the remaining items move under a "More" menu; More shows as current when the page is inside it.
 * Since 2.3.0 (G31) an item with `children` is a group: in the list layout a disclosure button opens its nested
 * items (it opens by itself when the current page moves inside, and shows as current while collapsed); in the rail and
 * bar layouts it opens them as a menu, like More. A group's own href is not used.
 */
export function createNavList(container, props = {}, services) {
  const c = setup(container, services, 'nav-list');
  let p = { items: [], layout: 'list', ...props };
  const ind = c.h('span', { class: 'ui-nav-ind', 'aria-hidden': 'true' });
  const el = c.own(c.h('nav', { class: 'ui-nav' }));
  let more = null, placed = false, frame = 0, groupMenus = [];
  const open = new Set(props.expanded || []);
  let revealed; // the value the groups were last opened around; a group the user closed stays closed until it changes
  const inside = (it, id) => !!it?.children?.some(ch => ch.id === id || inside(ch, id));
  function itemEl(it) {
    const current = it.id === p.value;
    const badge = it.badge != null && it.badge !== 0 ? c.h('span', { class: 'ui-nav-badge' }, c.h('span', { 'aria-hidden': 'true' }, fmtCount(c, it.badge)), c.h('span', { class: 'ui-visually-hidden' }, typeof it.badge === 'number' ? `, ${c.s.t('nav.badge', { count: it.badge })}` : `, ${it.badge}`))
      : it.attention ? c.h('span', { class: 'ui-nav-badge', 'data-dot': '' }, c.h('span', { class: 'ui-visually-hidden' }, `, ${c.s.t('nav.attention')}`)) : null;
    const href = safeHref(it.href);
    const a = c.h(href ? 'a' : 'button', { class: 'ui-nav-item', href, type: href ? null : 'button', 'aria-current': current ? 'page' : null, dataset: { id: it.id } },
      it.icon ? c.icon(it.icon) : null,
      // A short label for the icon strip and bottom bar; the full label stays the accessible name.
      c.h('span', { class: 'ui-nav-label' }, it.short && p.layout !== 'list' ? [c.h('span', { 'aria-hidden': 'true' }, it.short), c.h('span', { class: 'ui-visually-hidden' }, it.label)] : it.label), badge);
    a._item = it;
    return c.h('li', {}, a);
  }
  // a nav tab that opens its items as a menu: More, and a group in the rail and bar layouts
  function menuTab(li, label, icon, placement, list) {
    const m = createMenuButton(li, { label, icon, variant: 'ghost', placement, onSelect: e => go(e.item._nav, e.event),
      items: () => list.map(it => ({ id: it.id, label: it.label, icon: it.icon, href: it.href, description: it.badge != null && it.badge !== 0 ? String(fmtCount(c, it.badge)) : undefined, _nav: it })) }, c.s);
    m.element.classList.add('ui-nav-item'); m.element.classList.remove('ui-button');
    return m;
  }
  function groupEl(it, depth) {
    const current = inside(it, p.value);
    if (p.layout !== 'list') { // rail and bar: the group's items in a menu
      const li = c.h('li'), m = menuTab(li, it.label, it.icon, p.layout === 'bar' ? 'top-start' : 'end-start', it.children);
      m.element.toggleAttribute('data-current', current);
      m.item = it; groupMenus.push(m);
      return li;
    }
    if (current && revealed !== p.value) open.add(it.id);
    const sub = c.h('ul', { class: 'ui-nav-sub', id: uid('nav') });
    const shown = open.has(it.id);
    const btn = c.h('button', { type: 'button', class: 'ui-nav-item ui-nav-group', 'aria-expanded': String(shown), 'aria-controls': sub.id, dataset: { group: it.id } },
      it.icon ? c.icon(it.icon) : null, c.h('span', { class: 'ui-nav-label' }, it.label), c.icon('chevron-down'));
    if (current && !shown) btn.dataset.current = '';
    sub.hidden = !shown;
    for (const ch of it.children) sub.append(ch.children?.length ? groupEl(ch, depth + 1) : itemEl(ch));
    return c.h('li', { class: 'ui-nav-groupitem', 'data-depth': depth }, btn, sub);
  }
  // a closed group shows as current while the current page is inside it
  const markGroup = btn => btn.toggleAttribute('data-current', btn.getAttribute('aria-expanded') !== 'true' && inside(findItem(p.items, btn.dataset.group), p.value));
  function toggleGroup(btn) {
    const id = btn.dataset.group, show = btn.getAttribute('aria-expanded') !== 'true';
    if (show) open.add(id); else open.delete(id);
    btn.setAttribute('aria-expanded', String(show));
    const sub = el.querySelector(`[id="${btn.getAttribute('aria-controls')}"]`);
    if (sub) sub.hidden = !show;
    markGroup(btn);
    schedule();
  }
  const findItem = (list, id) => { for (const it of list) { if (it.id === id) return it; const f = it.children && findItem(it.children, id); if (f) return f; } return null; };
  function render() {
    el.dataset.layout = p.layout;
    el.setAttribute('aria-label', p.label || c.s.t('nav.main'));
    more?.destroy(); more = null;
    for (const m of groupMenus) m.destroy(); groupMenus = [];
    const items = p.items;
    const cap = p.maxItems && items.length > p.maxItems ? p.maxItems - 1 : items.length;
    const shown = items.slice(0, cap), rest = items.slice(cap);
    const lists = [];
    let ul = null, section;
    for (const it of shown) {
      if (!ul || (p.layout === 'list' && it.section !== section)) {
        section = it.section;
        if (p.layout === 'list' && it.section) lists.push(c.h('div', { class: 'ui-nav-section', 'aria-hidden': 'true' }, it.section));
        ul = c.h('ul', { 'aria-label': p.layout === 'list' && it.section ? it.section : null }); lists.push(ul);
      }
      ul.append(it.children?.length ? groupEl(it, 0) : itemEl(it));
    }
    fill(el, ind, lists);
    if (rest.length) {
      const li = c.h('li');
      (ul || el).append(li);
      more = menuTab(li, c.s.t('nav.more'), 'more', p.layout === 'bar' ? 'top-end' : 'end-start', rest);
      more.element.querySelector('.ui-icon:last-child:not(:first-child)')?.remove(); // no chevron on the More tab
      more.element.toggleAttribute('data-current', rest.some(it => it.id === p.value));
    }
    revealed = p.value;
    placed = false; schedule();
  }
  function go(it, event) {
    c.emit(el, 'navigate', { id: it.id, item: it, event }, p.onNavigate);
    if (event?.defaultPrevented || !safeHref(it.href)) setValue(it.id);
  }
  function setValue(id) {
    if (p.value === id) return;
    p.value = revealed = id;
    for (const a of el.querySelectorAll('.ui-nav-item[data-id]')) { if (a.dataset.id === id) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); }
    // a new current page inside a closed group opens it (outer groups first, in document order)
    for (const g of el.querySelectorAll('.ui-nav-group')) { if (g.getAttribute('aria-expanded') === 'false' && inside(findItem(p.items, g.dataset.group), id)) toggleGroup(g); else markGroup(g); }
    for (const m of groupMenus) m.element.toggleAttribute('data-current', inside(m.item, id));
    more?.element.toggleAttribute('data-current', p.items.slice(p.maxItems - 1).some(it => it.id === id));
    schedule();
  }
  function place() {
    frame = 0;
    const cur = el.querySelector('.ui-nav-item[aria-current="page"]') || el.querySelector('.ui-nav-item[data-current]');
    ind.hidden = !cur;
    if (!cur || !el.offsetWidth) return;
    const r = cur.getBoundingClientRect(), n = el.getBoundingClientRect();
    const box = { x: r.left - n.left + el.scrollLeft, y: r.top - n.top + el.scrollTop, w: r.width, h: r.height };
    c.s.motion.animate(ind, box, { role: placed ? 'control' : 'instant' });
    placed = true;
  }
  const schedule = () => { if (!frame) frame = c.win.requestAnimationFrame(place); };
  c.on(el, 'click', e => {
    const g = e.target.closest('.ui-nav-group');
    if (g && el.contains(g)) { toggleGroup(g); return; }
    const a = e.target.closest('.ui-nav-item[data-id]');
    if (a && el.contains(a)) go(a._item, e);
  });
  const ro = new c.win.ResizeObserver(() => schedule());
  ro.observe(el);
  c.cleanup(() => { ro.disconnect(); c.win.cancelAnimationFrame(frame); more?.destroy(); for (const m of groupMenus) m.destroy(); });
  render();
  container.append(el);
  return { root: el, get value() { return p.value; }, setValue, update(n) { p = { ...p, ...n }; render(); }, focus: () => (el.querySelector('[aria-current="page"]') || el.querySelector('.ui-nav-item'))?.focus(), destroy: () => c.destroy() };
}

// ---------------------------------------------------------------- tabs
/**
 * createTabs(container, { tabs: [{ id, label, icon, badge, disabled }], value, label, activation: 'auto'|'manual',
 *   overflow: 'scroll'|'menu', onChange }, services)
 * → { root, panel(id), value, update, focus, destroy }. Each tab has a panel (role=tabpanel) that the host fills;
 * only the selected one is shown and it fades in with the view role. Arrow keys move (and select when automatic).
 * overflow 'menu' (since 2.3.0, G31): tabs that do not fit move into a "More tabs" menu button after the tab list; the
 * selected tab always stays in the row. The default, 'scroll', scrolls the row.
 */
export function createTabs(container, props = {}, services) {
  const c = setup(container, services, 'tabs');
  let p = { tabs: [], activation: 'auto', ...props };
  const ind = c.h('span', { class: 'ui-tab-ind', 'aria-hidden': 'true' });
  const list = c.h('div', { class: 'ui-tablist', role: 'tablist' });
  const moreSlot = c.h('div', { class: 'ui-tabs-more', hidden: true });
  const el = c.own(c.h('div', { class: 'ui-tabs' }, c.h('div', { class: 'ui-tabs-row' }, list, moreSlot)));
  let moreBtn = null, fitting = false;
  const panels = new Map(), base = uid('tabs');
  let roving = null, placed = false, frame = 0;
  const panelOf = id => {
    let pn = panels.get(id);
    if (!pn) { pn = c.h('div', { class: 'ui-tabpanel', role: 'tabpanel', id: `${base}-p-${id}`, 'aria-labelledby': `${base}-t-${id}`, tabindex: '0', hidden: true }); panels.set(id, pn); el.append(pn); }
    return pn;
  };
  function render() {
    if (p.label) list.setAttribute('aria-label', p.label);
    if (p.value == null || !p.tabs.some(t => t.id === p.value && !t.disabled)) p.value = p.tabs.find(t => !t.disabled)?.id;
    fill(list, ind, p.tabs.map(t => {
      const b = c.h('button', { type: 'button', class: 'ui-tab', role: 'tab', id: `${base}-t-${t.id}`, 'aria-controls': `${base}-p-${t.id}`, 'aria-selected': String(t.id === p.value), disabled: t.disabled || null },
        t.icon ? c.icon(t.icon) : null, c.h('span', {}, t.label), t.badge != null ? c.h('span', { class: 'ui-count' }, fmtCount(c, t.badge)) : null);
      b._id = t.id;
      return b;
    }));
    for (const t of p.tabs) panelOf(t.id).hidden = t.id !== p.value;
    for (const [id, pn] of panels) if (!p.tabs.some(t => t.id === id)) { pn.remove(); panels.delete(id); }
    roving?.destroy();
    roving = createRovingFocus(list, { items: () => [...list.querySelectorAll('.ui-tab')], orientation: 'horizontal', onMove: b => { if (p.activation === 'auto') select(b._id); } });
    if (p.overflow === 'menu' && !moreBtn) moreBtn = createMenuButton(moreSlot, { label: c.s.t('tabs.more'), icon: 'more', iconOnly: true, variant: 'ghost', placement: 'bottom-end', items: () => p.tabs.filter(t => list.querySelector(`[id="${base}-t-${t.id}"]`)?.hidden).map(t => ({ id: t.id, label: t.label, disabled: t.disabled, checked: undefined })), onSelect: e => { select(e.item.id); list.querySelector('[aria-selected="true"]')?.focus(); } }, c.s);
    else if (p.overflow !== 'menu' && moreBtn) { moreBtn.destroy(); moreBtn = null; }
    el.toggleAttribute('data-overflow-menu', p.overflow === 'menu');
    fit();
    placed = false; schedule();
  }
  // overflow 'menu': hide tabs from the end until the row fits beside the More button; the selected tab stays (G31)
  function fit() {
    if (p.overflow !== 'menu' || fitting) return;
    fitting = true;
    const tabs = [...list.querySelectorAll('.ui-tab')];
    for (const b of tabs) b.hidden = false;
    moreSlot.hidden = true;
    const width = () => tabs.filter(b => !b.hidden).reduce((w, b) => w + b.offsetWidth, 0);
    const room = () => el.firstChild.clientWidth - (moreSlot.hidden ? 0 : moreSlot.offsetWidth + 4);
    if (width() > room() + 1) {
      moreSlot.hidden = false;
      for (let i = tabs.length - 1; i >= 0 && width() > room() + 1; i--) if (tabs[i].getAttribute('aria-selected') !== 'true') tabs[i].hidden = true;
    }
    roving?.sync();
    fitting = false;
  }
  function select(id) {
    if (id === p.value || p.tabs.find(t => t.id === id)?.disabled) return;
    const prev = p.value;
    p.value = id;
    for (const b of list.querySelectorAll('.ui-tab')) b.setAttribute('aria-selected', String(b._id === id));
    for (const [pid, pn] of panels) pn.hidden = pid !== id;
    const pn = panels.get(id);
    if (pn) c.s.motion.animate(pn, { o: 1 }, { role: 'view', from: { o: 0 } });
    list.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    fit(); schedule();
    c.emit(el, 'change', { value: id, previous: prev }, p.onChange);
  }
  function place() {
    frame = 0;
    const b = list.querySelector('[aria-selected="true"]');
    ind.hidden = !b || b.hidden;
    if (!b || b.hidden || !list.offsetWidth) return;
    c.s.motion.animate(ind, { x: b.offsetLeft, w: b.offsetWidth }, { role: placed ? 'control' : 'instant' });
    placed = true;
  }
  const schedule = () => { if (!frame) frame = c.win.requestAnimationFrame(place); };
  c.on(list, 'click', e => { const b = e.target.closest('.ui-tab'); if (b) select(b._id); });
  const ro = new c.win.ResizeObserver(() => { fit(); schedule(); });
  ro.observe(el);
  c.cleanup(() => { ro.disconnect(); roving?.destroy(); moreBtn?.destroy(); c.win.cancelAnimationFrame(frame); });
  render();
  container.append(el);
  return { root: el, panel: panelOf, get value() { return p.value; }, select, update(n) { p = { ...p, ...n }; render(); }, focus: () => list.querySelector('[aria-selected="true"]')?.focus(), destroy: () => c.destroy() };
}

// ---------------------------------------------------------------- breadcrumbs
/**
 * createBreadcrumbs(container, { items: [{ id, label, href }], label, maxItems = 5, onNavigate }, services)
 * The last item is the current page. Middle levels collapse into a "…" menu when there are more than maxItems or the
 * trail does not fit its container.
 */
export function createBreadcrumbs(container, props = {}, services) {
  const c = setup(container, services, 'breadcrumbs');
  let p = { items: [], maxItems: 5, ...props };
  const ol = c.h('ol');
  const el = c.own(c.h('nav', { class: 'ui-breadcrumbs' }, ol));
  let menu = null, hidden = 0, fitting = false;
  const sep = () => c.h('span', { class: 'ui-crumb-sep', 'aria-hidden': 'true' }, c.icon('chevron-right'));
  function crumb(it, last) {
    const node = last ? c.h('span', { class: 'ui-crumb', 'aria-current': 'page', title: it.label }, it.label)
      : c.h(safeHref(it.href) ? 'a' : 'button', { class: 'ui-crumb', href: safeHref(it.href), type: safeHref(it.href) ? null : 'button', title: it.label }, it.label);
    node._item = it;
    return c.h('li', {}, node, last ? null : sep());
  }
  function render() {
    el.setAttribute('aria-label', p.label || c.s.t('breadcrumb'));
    menu?.destroy(); menu = null;
    const n = p.items.length;
    const maxHidden = Math.max(0, n - 2);
    const h = Math.min(maxHidden, Math.max(hidden, n > p.maxItems ? n - p.maxItems + 1 : 0));
    const lis = [];
    p.items.forEach((it, i) => {
      if (h && i === 1) {
        const li = c.h('li', { class: 'ui-crumb-more' });
        menu = createMenuButton(li, { label: c.s.t('breadcrumb.more'), icon: 'more', iconOnly: true, variant: 'ghost', items: p.items.slice(1, 1 + h).map(x => ({ id: x.id, label: x.label, href: x.href, _crumb: x })), onSelect: e => go(e.item._crumb, e.event) }, c.s);
        li.append(sep());
        lis.push(li);
      }
      if (h && i >= 1 && i < 1 + h) return;
      lis.push(crumb(it, i === n - 1));
    });
    fill(ol, lis);
  }
  function go(it, event) { c.emit(el, 'navigate', { id: it.id, item: it, event }, p.onNavigate); }
  c.on(ol, 'click', e => { const a = e.target.closest('a.ui-crumb, button.ui-crumb'); if (a) go(a._item, e); });
  // Collapse levels until the trail fits (re-evaluated when the container resizes).
  function fit() {
    if (fitting) return; fitting = true;
    hidden = 0; render();
    while (el.scrollWidth > el.clientWidth + 1 && hidden < p.items.length - 2) { hidden++; render(); }
    fitting = false;
  }
  const ro = new c.win.ResizeObserver(() => fit());
  ro.observe(el);
  c.cleanup(() => { ro.disconnect(); menu?.destroy(); });
  render();
  container.append(el);
  return { root: el, update(n) { p = { ...p, ...n }; fit(); }, destroy: () => c.destroy() };
}

// ---------------------------------------------------------------- pagination
/**
 * createPagination(container, { page, pageCount, total, pageSize, pageSizes, siblings = 1, label, onChange({ page }),
 *   onPageSizeChange({ pageSize }) }, services)
 * Wide: previous, numbered pages with gaps, next, range text and rows-per-page. Narrow (< 30rem): previous, "Page n of m", next.
 */
export function createPagination(container, props = {}, services) {
  const c = setup(container, services, 'pagination');
  let p = { page: 1, pageCount: 1, siblings: 1, ...props };
  const el = c.own(c.h('nav', { class: 'ui-pagination' }));
  let compact = false;
  const num = n => c.s.format.number(n, { useGrouping: false });
  function pages() {
    const { page, pageCount: n, siblings: s } = p, out = [];
    const lo = Math.max(2, page - s), hi = Math.min(n - 1, page + s);
    out.push(1);
    if (lo > 2) out.push(lo === 3 ? 2 : 'gap');
    for (let i = lo; i <= hi; i++) out.push(i);
    if (hi < n - 1) out.push(hi === n - 2 ? n - 1 : 'gap');
    if (n > 1) out.push(n);
    return out;
  }
  function render() {
    el.setAttribute('aria-label', p.label || c.s.t('pagination.label'));
    el.toggleAttribute('data-compact', compact);
    const n = Math.max(1, p.pageCount), page = Math.min(Math.max(1, p.page), n);
    p.page = page;
    const off = !!p.disabled; // G33: every control of the pagination off while the host loads a page, say
    el.toggleAttribute('data-disabled', off);
    const nav = (dir) => { const b = c.h('button', { type: 'button', class: 'ui-button ui-page-step', 'data-variant': 'ghost', 'data-icon-only': '', 'aria-label': c.s.t(dir < 0 ? 'pagination.previous' : 'pagination.next'), disabled: off || (dir < 0 ? page <= 1 : page >= n) || null }, c.icon(dir < 0 ? 'chevron-left' : 'chevron-right')); b._page = page + dir; return b; };
    const list = compact
      ? [c.h('span', { class: 'ui-page-status', 'aria-live': 'polite' }, c.s.t('pagination.pageOf', { page: num(page), count: num(n) }))]
      : pages().map(x => (x === 'gap' ? c.h('span', { class: 'ui-page-gap', 'aria-hidden': 'true' }, '…')
        : Object.assign(c.h('button', { type: 'button', class: 'ui-page', 'aria-label': c.s.t('pagination.page', { page: num(x) }), 'aria-current': x === page ? 'page' : null, disabled: off || null }, num(x)), { _page: x })));
    const range = p.total != null && p.pageSize ? c.h('span', { class: 'ui-page-range' }, c.s.t('pagination.range', { from: c.s.format.number(Math.min(p.total, (page - 1) * p.pageSize + 1)), to: c.s.format.number(Math.min(p.total, page * p.pageSize)), total: c.s.format.number(p.total) })) : null;
    let size = null;
    if (p.pageSizes?.length && !compact) {
      const id = uid('pgs');
      const sel = c.h('select', { id, disabled: off || null }, p.pageSizes.map(v => c.h('option', { value: String(v), selected: v === p.pageSize || null }, c.s.format.number(v))));
      sel.addEventListener('change', () => { p.pageSize = Number(sel.value); c.emit(el, 'page-size-change', { pageSize: p.pageSize }, p.onPageSizeChange); });
      size = c.h('label', { class: 'ui-page-size', for: id }, c.h('span', {}, c.s.t('pagination.perPage')), c.h('span', { class: 'ui-input' }, sel));
    }
    fill(el, range, c.h('div', { class: 'ui-page-list' }, nav(-1), list, nav(1)), size);
  }
  c.on(el, 'click', e => {
    const b = e.target.closest('button'); if (!b || b._page == null || b.disabled) return;
    const next = Math.min(Math.max(1, b._page), p.pageCount);
    if (next === p.page) return;
    const prev = p.page; p.page = next; render();
    // Keep keyboard focus on the equivalent control after re-rendering.
    (b.classList.contains('ui-page-step') ? el.querySelectorAll('.ui-page-step')[b._page < prev ? 0 : 1] : el.querySelector('.ui-page[aria-current="page"]'))?.focus();
    c.emit(el, 'change', { page: next, previous: prev }, p.onChange);
  });
  const ro = new c.win.ResizeObserver(() => { const rem = parseFloat(c.win.getComputedStyle(c.doc.documentElement).fontSize) || 16; const next = el.parentElement ? el.parentElement.clientWidth < 30 * rem : false; if (next !== compact) { compact = next; render(); } });
  c.cleanup(() => ro.disconnect());
  render();
  container.append(el);
  ro.observe(container);
  return { root: el, get page() { return p.page; }, update(n) { p = { ...p, ...n }; render(); }, destroy: () => c.destroy() };
}

// ---------------------------------------------------------------- toolbar
/**
 * createToolbar(container, { label, items: [{ id, label, icon, iconOnly, type: 'button'|'toggle'|'menu'|'separator'
 *   |'search'|'select'|'date', pressed, disabled, variant, items, value, options, placeholder }], overflow = true,
 *   onAction({ id, item, pressed, value }) }, services)
 * One tab stop with arrow-key movement (APG toolbar). Items that do not fit move into a "More actions" menu; filters
 * shrink first and never move, and wrap onto more rows when they alone do not fit (a phone-width filter bar). Since 2.3.0
 * (G31) a toolbar also holds filters: a search field, a choice (select) and a date, labelled by `label`. They join the
 * arrow-key order; inside a field the arrows edit the text and leave it from its first or last character; filters
 * never move into the menu. Their changes arrive as onAction({ id, value }).
 */
export function createToolbar(container, props = {}, services) {
  const c = setup(container, services, 'toolbar');
  let p = { items: [], overflow: true, ...props };
  const el = c.own(c.h('div', { class: 'ui-toolbar', role: 'toolbar' }));
  let parts = [], more = null, roving = null, measuring = false;
  function act(it, extra = {}) { c.emit(el, 'action', { id: it.id, item: it, ...extra }, p.onAction); }
  function render() {
    if (p.label) el.setAttribute('aria-label', p.label);
    for (const x of parts) x.handle?.destroy();
    more?.destroy(); more = null;
    fill(el);
    parts = p.items.map(it => {
      const slot = c.h('span', { class: 'ui-toolbar-slot', 'data-filter': ['search', 'select', 'date'].includes(it.type) ? '' : null });
      el.append(slot);
      if (it.type === 'separator') { slot.append(c.h('span', { class: 'ui-toolbar-sep', role: 'separator', 'aria-orientation': 'vertical' })); return { it, slot }; }
      if (it.type === 'search') return { it, slot, control: true, handle: createSearchField(slot, { label: it.label, hideLabel: true, placeholder: it.placeholder ?? it.label, value: it.value ?? '', disabled: it.disabled, onInput: e => { it.value = e.value; act(it, { value: e.value }); } }, c.s) };
      if (it.type === 'select') return { it, slot, control: true, handle: createSelect(slot, { label: it.label, hideLabel: true, options: it.options || [], value: it.value ?? null, disabled: it.disabled, onChange: e => { it.value = e.value; act(it, { value: e.value }); } }, c.s) };
      if (it.type === 'date') {
        const h = createDatePicker(slot, { label: it.label, hideLabel: true, value: it.value ?? null, disabled: it.disabled, onChange: e => { it.value = e.value; act(it, { value: e.value }); } }, c.s);
        h.root.querySelector('.ui-inline-button').tabIndex = -1; // Alt+↓ in the field opens the calendar; one stop per filter
        return { it, slot, control: true, handle: h };
      }
      if (it.type === 'menu') return { it, slot, handle: createMenuButton(slot, { label: it.label, icon: it.icon, iconOnly: it.iconOnly, variant: it.variant || 'ghost', disabled: it.disabled, items: it.items, onSelect: e => act(it, { selected: e.item }) }, c.s) };
      const h = createButton(slot, { label: it.label, icon: it.icon, iconOnly: it.iconOnly, variant: it.variant || 'ghost', disabled: it.disabled, pressed: it.type === 'toggle' ? !!it.pressed : undefined, onClick: () => { if (it.type === 'toggle') { it.pressed = !it.pressed; h.update({ pressed: it.pressed }); act(it, { pressed: it.pressed }); } else act(it); } }, c.s);
      return { it, slot, handle: h };
    });
    const moreSlot = c.h('span', { class: 'ui-toolbar-slot ui-toolbar-more', hidden: true });
    el.append(moreSlot);
    more = createMenuButton(moreSlot, { label: c.s.t('toolbar.more'), icon: 'more', iconOnly: true, variant: 'ghost', placement: 'bottom-end', items: () => overflowItems() }, c.s);
    roving?.destroy();
    // buttons are the slots' own children; a filter contributes its field (not the field's inner buttons)
    roving = createRovingFocus(el, { items: () => [...el.querySelectorAll('.ui-toolbar-slot:not([hidden]) > button, .ui-toolbar-slot:not([hidden]) .ui-field :is(input:not([type="hidden"]), select)')], orientation: 'horizontal' });
    fit();
  }
  function overflowItems() {
    return parts.filter(x => x.slot.hidden && x.it.type !== 'separator').map(({ it }) => ({
      id: it.id, label: it.label, icon: it.icon, disabled: it.disabled, items: it.type === 'menu' ? it.items : undefined,
      checked: it.type === 'toggle' ? !!it.pressed : undefined,
      onSelect: sel => { if (it.type === 'toggle') { it.pressed = !it.pressed; parts.find(x => x.it === it).handle.update({ pressed: it.pressed }); act(it, { pressed: it.pressed }); } else if (it.type === 'menu') act(it, { selected: sel }); else act(it); },
    }));
  }
  function fit() {
    if (measuring || !p.overflow) return;
    measuring = true;
    el.removeAttribute('data-wrap');
    // Measured from the items themselves: with end alignment, overflow on the start side is not in scrollWidth.
    const gap = parseFloat(c.win.getComputedStyle(el).columnGap) || 0;
    const need = () => { const vis = [...el.children].filter(x => !x.hidden); return vis.reduce((w, x) => w + x.offsetWidth, 0) + gap * Math.max(0, vis.length - 1); };
    for (const x of parts) x.slot.hidden = false;
    more.element.parentElement.hidden = true;
    if (need() > el.clientWidth + 1) {
      more.element.parentElement.hidden = false;
      for (let i = parts.length - 1; i >= 0 && need() > el.clientWidth + 1; i--) if (!parts[i].control) parts[i].slot.hidden = true; // filters stay
      // A separator never ends the visible row.
      for (let i = parts.length - 1; i >= 0; i--) { if (parts[i].slot.hidden) continue; if (parts[i].it.type === 'separator') parts[i].slot.hidden = true; else break; }
      // Filters shrink first and never move into More; when they alone are wider than the row, they wrap (G31).
      el.toggleAttribute('data-wrap', need() > el.clientWidth + 1);
    }
    roving?.sync();
    measuring = false;
  }
  let width = -1; // fit again when the width changes; wrapping changes only the height
  const ro = new c.win.ResizeObserver(() => { if (el.clientWidth !== width) { width = el.clientWidth; fit(); } });
  ro.observe(el);
  c.cleanup(() => { ro.disconnect(); roving?.destroy(); for (const x of parts) x.handle?.destroy(); more?.destroy(); });
  container.append(el);
  render();
  return { root: el, update(n) { p = { ...p, ...n }; render(); }, focus: () => roving?.focus(), destroy: () => c.destroy() };
}

// ---------------------------------------------------------------- link
/** createLink(container, { label, href, external, standalone, onClick }) — external links open a new tab and say so. */
export function createLink(container, props = {}, services) {
  const c = setup(container, services, 'link');
  let p = { ...props };
  const el = c.own(c.h('a', { class: 'ui-link' }));
  function render() {
    const href = safeHref(p.href);
    if (href) el.setAttribute('href', href); else el.removeAttribute('href');
    el.toggleAttribute('data-standalone', !!p.standalone);
    if (p.external) { el.target = '_blank'; el.rel = 'noopener noreferrer'; } else { el.removeAttribute('target'); el.removeAttribute('rel'); }
    fill(el, p.label, p.external ? [c.icon('external'), c.h('span', { class: 'ui-visually-hidden' }, ` ${c.s.t('link.external')}`)] : null);
  }
  c.on(el, 'click', e => c.emit(el, 'click', { event: e }, p.onClick));
  render();
  container.append(el);
  return { root: el, update(n) { p = { ...p, ...n }; render(); }, focus: () => el.focus(), destroy: () => c.destroy() };
}
