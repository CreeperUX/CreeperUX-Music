import { setup, fill, uid, safeHref } from './base.js';
import { createNavList, createBreadcrumbs } from './navigation.js';
import { createButton } from './controls.js';
import { BREAKPOINTS } from '../tokens.js';

/**
 * createAppShell(container, { brand: { label, mark, href }, nav: NavItem[], value, onNavigate, breadcrumbs: Crumb[],
 *   onBreadcrumb, topItems: Node | Node[] | (slot) => void, navLabel, maxBarItems = 5, mode: 'auto'|'side'|'rail'|'bar' }, services)
 * → { root, main, top, get mode, setValue(id), setBreadcrumbs(items), focusMain(), update, destroy }
 *
 * D18 layout by the shell's own width: ≥ 1100 px full sidebar, 760–1100 px icon strip, < 760 px bottom bar with at
 * most five destinations (four + "More"). No manual collapse or pin. Breadcrumbs show in the top bar on the two
 * desktop layouts only. The top bar has an app-supplied items slot (status, search, account) instead of a built-in
 * status bar (D29); items with a data-optional attribute are hidden on the bottom-bar layout. The host renders page
 * content into `main` and sets the container's height (e.g. 100dvh).
 */
export function createAppShell(container, props = {}, services) {
  const c = setup(container, services, 'shell');
  let p = { nav: [], maxBarItems: 5, mode: 'auto', ...props };
  const mainId = uid('main');
  const skip = c.h('a', { class: 'ui-skip-link', href: `#${mainId}` });
  const brand = c.h('div', { class: 'ui-shell-brand' });
  const crumbsSlot = c.h('div', { class: 'ui-shell-crumbs' });
  const top = c.h('div', { class: 'ui-shell-slot' });
  const header = c.h('header', { class: 'ui-shell-top' }, brand, crumbsSlot, c.h('span', { class: 'ui-shell-spacer' }), top);
  const navSlot = c.h('div', { class: 'ui-shell-nav' });
  const main = c.h('main', { class: 'ui-shell-main', id: mainId, tabindex: '-1' });
  const el = c.own(c.h('div', { class: 'ui-shell' }, skip, header, navSlot, main));
  let mode = null, nav = null, crumbs = null, topBuilt = false;
  const modeFor = w => (p.mode !== 'auto' ? p.mode : w >= BREAKPOINTS.sidebar ? 'side' : w >= BREAKPOINTS.rail ? 'rail' : 'bar');
  function renderBrand() {
    const b = p.brand || {};
    const inner = [b.mark || c.h('i', { class: 'ui-shell-mark', 'aria-hidden': 'true' }), c.h('span', { class: 'ui-shell-name' }, b.label || '')];
    fill(brand, safeHref(b.href) ? c.h('a', { href: b.href, 'aria-label': mode === 'rail' ? b.label : null }, inner) : inner);
  }
  function renderNav() {
    const layout = mode === 'side' ? 'list' : mode;
    const opts = { items: p.nav, value: p.value, label: p.navLabel, layout, maxItems: mode === 'bar' ? p.maxBarItems : undefined, onNavigate: e => { p.value = e.id; c.emit(el, 'navigate', e, p.onNavigate); } };
    if (nav) nav.update(opts); else nav = createNavList(navSlot, opts, c.s);
  }
  function renderCrumbs() {
    const show = mode !== 'bar' && p.breadcrumbs?.length;
    crumbsSlot.hidden = !show;
    if (!show) { crumbs?.destroy(); crumbs = null; return; }
    const opts = { items: p.breadcrumbs, onNavigate: e => c.emit(el, 'breadcrumb', e, p.onBreadcrumb) };
    if (crumbs) crumbs.update(opts); else crumbs = createBreadcrumbs(crumbsSlot, opts, c.s);
  }
  function renderTop() {
    if (topBuilt && !p.topItems?.nodeType && !Array.isArray(p.topItems)) return;
    if (typeof p.topItems === 'function') p.topItems(top); else fill(top, p.topItems);
    topBuilt = true;
  }
  function setMode(next) {
    if (next === mode) return;
    mode = next;
    el.dataset.nav = mode;
    renderBrand(); renderNav(); renderCrumbs();
    syncInset();
  }
  // Toasts sit above the bottom bar on phones.
  function syncInset() { c.s.overlays.portal.style.setProperty('--ui-bottom-inset', mode === 'bar' ? `${navSlot.offsetHeight}px` : '0px'); }
  c.on(skip, 'click', e => { e.preventDefault(); main.focus(); });
  const ro = new c.win.ResizeObserver(() => { setMode(modeFor(el.clientWidth)); if (mode === 'bar') syncInset(); });
  ro.observe(el); ro.observe(navSlot);
  c.cleanup(() => { ro.disconnect(); nav?.destroy(); crumbs?.destroy(); c.s.overlays.portal.style.removeProperty('--ui-bottom-inset'); });
  skip.textContent = c.s.t('nav.skip');
  container.append(el);
  renderTop();
  setMode(modeFor(el.clientWidth || container.clientWidth || c.win.innerWidth));
  return {
    root: el, main, top,
    get mode() { return mode; },
    setValue(id) { p.value = id; nav?.setValue(id); },
    setBreadcrumbs(items) { p.breadcrumbs = items; renderCrumbs(); },
    /** Moves focus to the main region (after a route change, so screen readers start at the new content). */
    focusMain() { main.focus({ preventScroll: true }); },
    update(n) { p = { ...p, ...n }; renderBrand(); renderNav(); renderCrumbs(); if ('topItems' in n) { topBuilt = false; renderTop(); } if ('mode' in n) setMode(modeFor(el.clientWidth)); },
    destroy: () => c.destroy(),
  };
}

/**
 * createMasterDetail(container, { masterLabel, detailLabel, open = false, stackBelow = 1000, masterWidth = '20rem',
 *   onOpenChange({ open, reason }) }, services)
 * → { root, master, detail, get stacked, get open, showDetail({ focus }), back(), update, destroy }
 *
 * A list and the item it opens (G38). When the component is at least `stackBelow` px wide (the SCOPE stack
 * breakpoint) both panes show side by side, the list `masterWidth` wide. Narrower, one pane shows at a time:
 * showDetail() pushes the detail in from the inline end (the push role; a fade with reduced motion) and moves focus
 * to it, and its Back button or back() slides it out and returns focus to where it was in the list. Focus moves at
 * once; input never waits for the motion, and a push reverses from where it is.
 * The host fills `master` and `detail`, decides what the detail shows and owns the route: showDetail() and back() are
 * the navigation verbs (motion, focus, onOpenChange), while update({ open }) restores a state without motion. An
 * embedding host's back button calls services.handleBack() first, then back(), which is true when it went back.
 * Wide, the detail always shows; render its empty state ("Select a message") while nothing is open. Give the container
 * a height (e.g. the shell's main area) and each pane scrolls on its own, the Back bar staying at the top.
 */
export function createMasterDetail(container, props = {}, services) {
  const c = setup(container, services, 'master-detail');
  let p = { open: false, stackBelow: BREAKPOINTS.stack, ...props };
  const master = c.h('div', { class: 'ui-md-master', tabindex: '-1' });
  const bar = c.h('div', { class: 'ui-md-bar' });
  const detail = c.h('div', { class: 'ui-md-body' });
  const pane = c.h('div', { class: 'ui-md-detail', tabindex: '-1' }, bar, detail);
  const el = c.own(c.h('div', { class: 'ui-md' }, master, pane));
  const backBtn = createButton(bar, { label: c.s.t('back'), icon: 'chevron-left', variant: 'ghost', onClick: () => go(false, 'button') }, c.s);
  let stacked = null, ticket = 0, opener = null;
  const m = c.s.motion;
  function labels() {
    for (const [node, text] of [[master, p.masterLabel], [pane, p.detailLabel]]) {
      if (text) { node.setAttribute('role', 'region'); node.setAttribute('aria-label', text); } else { node.removeAttribute('role'); node.removeAttribute('aria-label'); }
    }
    backBtn.element.setAttribute('aria-label', p.masterLabel ? c.s.t('md.backTo', { label: p.masterLabel }) : c.s.t('back'));
    if (p.masterWidth) el.style.setProperty('--ui-md-master', p.masterWidth); else el.style.removeProperty('--ui-md-master');
  }
  // the resting state for the mode, without motion; focus never stays in a pane that has just hidden
  function rest() {
    const had = c.doc.activeElement;
    ticket++;
    m.reset(pane);
    master.inert = false; pane.inert = false;
    master.hidden = stacked && !!p.open;
    pane.hidden = stacked && !p.open;
    el.toggleAttribute('data-stacked', stacked);
    el.toggleAttribute('data-open', !!p.open);
    if (master.hidden && master.contains(had)) pane.focus({ preventScroll: true });
    else if (pane.hidden && pane.contains(had)) master.focus({ preventScroll: true });
  }
  function setStacked(next) { if (next !== stacked) { stacked = next; rest(); } }
  const measure = () => el.clientWidth || container.clientWidth || c.win.innerWidth;
  function go(open, reason, focus = stacked) {
    if (!!p.open === open) { if (open && focus) pane.focus({ preventScroll: true }); return false; }
    p.open = open;
    el.toggleAttribute('data-open', open);
    if (open) opener = master.contains(c.doc.activeElement) ? c.doc.activeElement : null;
    if (!stacked) {
      if (open && focus) pane.focus({ preventScroll: true });
      if (!open && pane.contains(c.doc.activeElement)) (opener?.isConnected && master.contains(opener) ? opener : master).focus({ preventScroll: true });
    } else {
      const my = ++ticket, d = c.win.getComputedStyle(el).direction === 'rtl' ? -1 : 1, w = el.clientWidth, low = m.isReduced;
      if (open) {
        const from = pane.hidden ? (low ? { o: 0 } : { x: d * w }) : undefined; // a push already under way reverses from where it is
        pane.hidden = false; pane.inert = false; master.inert = true;
        if (focus) pane.focus({ preventScroll: true });
        m.animate(pane, low ? { o: 1 } : { x: 0 }, { role: 'push', from }).then(() => { if (my === ticket) { master.hidden = true; master.inert = false; m.reset(pane); } });
      } else {
        master.hidden = false; master.inert = false; pane.inert = true;
        (opener?.isConnected && master.contains(opener) ? opener : master).focus({ preventScroll: true });
        m.animate(pane, low ? { o: 0 } : { x: d * w }, { role: 'push' }).then(() => { if (my === ticket) { pane.hidden = true; pane.inert = false; m.reset(pane); } });
      }
    }
    c.emit(el, 'open-change', { open, reason }, p.onOpenChange);
    return true;
  }
  const ro = new c.win.ResizeObserver(() => { if (el.clientWidth) setStacked(el.clientWidth < p.stackBelow); });
  ro.observe(el);
  c.cleanup(() => { ro.disconnect(); ticket++; m.reset(pane); backBtn.destroy(); });
  labels();
  container.append(el);
  setStacked(measure() < p.stackBelow);
  return {
    root: el, master, detail,
    get stacked() { return stacked; },
    get open() { return !!p.open; },
    /** Shows the detail: pushed in and focused when stacked; side by side, focus stays unless `focus: true`. */
    showDetail({ focus } = {}) { go(true, 'api', focus ?? stacked); },
    /** Goes back to the list when stacked with the detail open; false otherwise (nothing to go back from). */
    back() { return stacked && p.open ? go(false, 'api') : false; },
    update(n) { p = { ...p, ...n }; labels(); if ('open' in n) { if (!p.open) opener = null; rest(); } if ('stackBelow' in n) setStacked(measure() < p.stackBelow); },
    focus: () => (master.hidden ? pane : master).focus({ preventScroll: true }),
    destroy: () => c.destroy(),
  };
}
