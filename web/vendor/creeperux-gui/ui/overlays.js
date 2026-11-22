import { setup, fill, uid, safeHref } from './base.js';
import { createButton, createTextField } from './controls.js';
import { createInlineAlert } from './feedback.js';
import { getServices } from '../services.js';
import { autoPosition } from '../position.js';
import { createRovingFocus } from '../interaction.js';
import { BREAKPOINTS } from '../tokens.js';

// M3 overlays. Every layer opens through services.overlays (stacking, inert background, focus trap / restore,
// Escape for the top layer only, outside dismissal) and animates with the quiet roles: enter = opacity + at most
// 4 px, exit = opacity, sheets use the sheet spring and the drag spring on release (D27).

const portalOf = s => s.overlays.portal;
// First focus target in a dialog or sheet: anything in the Tab order (a stepper button with tabindex=-1 is not).
const FIELD = ':is(input:not([type="hidden"]), select, textarea, button):not(:disabled):not([tabindex="-1"]), [contenteditable="true"]:not([tabindex="-1"]), a[href]:not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])';
const rtlOf = el => el.ownerDocument.defaultView.getComputedStyle(el).direction === 'rtl';
const fromOffset = placement => (String(placement).startsWith('top') ? { o: 0, y: 2 } : { o: 0, y: -2 });

// ---------------------------------------------------------------- menu
/**
 * openMenu(services, { items, trigger, anchor, point: {x, y}, placement = 'bottom-start', label, focus: 'first'|'last'|'none',
 *   onSelect(item, event, { path, group }), onClose(reason) }) → { element, close(reason, { restoreFocus }), focusFirst(), get isOpen }
 * Item: { id, label, icon, description, shortcut, disabled, danger, href, checked (→ menuitemcheckbox),
 *   type: 'radio' (→ menuitemradio, uses checked; `group` names its set), items (submenu), onSelect } · { separator: true } · { heading }.
 * Keyboard (APG menu): arrows, Home / End, typeahead, Enter / Space, ArrowRight / Left open and close submenus
 * (mirrored in RTL), Escape closes one level, Tab closes all and continues from the trigger. A selection reports the
 * ids from the top menu down to the item (`path`) and a radio item's `group` (G34). On narrow screens (below the rail
 * breakpoint) a submenu opens over its parent with a Back item first.
 */
export function openMenu(services, opts = {}) {
  const s = services || getServices();
  const c = setup(s.overlays.portal, s, 'menu');
  const doc = c.doc, win = c.win;
  const lead = opts.items.some(i => i.icon || typeof i.checked === 'boolean' || i.type === 'radio');
  const el = c.h('div', { class: 'ui-menu ui-popup', role: 'menu', id: uid('menu'), tabindex: '-1', 'aria-label': opts.label || null });
  if (!opts.label && opts.trigger) el.setAttribute('aria-labelledby', opts.trigger.id || (opts.trigger.id = uid('mt'))); // "Export menu"
  const entries = [];
  for (const it of opts.items) {
    if (it.separator) { el.append(c.h('div', { class: 'ui-menu-sep', role: 'separator' })); continue; }
    if (it.heading) { el.append(c.h('div', { class: 'ui-menu-heading', role: 'presentation' }, it.heading)); continue; }
    const role = it.type === 'radio' ? 'menuitemradio' : typeof it.checked === 'boolean' ? 'menuitemcheckbox' : 'menuitem';
    const href = safeHref(it.href);
    const b = c.h(href ? 'a' : 'div', {
      class: 'ui-menu-item', role, tabindex: '-1', href,
      'aria-disabled': it.disabled ? 'true' : null, 'aria-checked': role === 'menuitem' ? null : String(!!it.checked),
      'aria-haspopup': it.items ? 'menu' : null, 'aria-expanded': it.items ? 'false' : null, 'data-danger': it.danger ? '' : null,
    },
    lead ? (role === 'menuitem' ? (it.icon ? c.icon(it.icon) : c.h('span', { class: 'ui-menu-lead', 'aria-hidden': 'true' })) : c.h('span', { class: 'ui-menu-lead ui-menu-check', 'aria-hidden': 'true' })) : null,
    c.h('span', { class: 'ui-menu-label' }, it.label, it.description ? c.h('small', {}, it.description) : null),
    it.shortcut ? c.h('kbd', { class: 'ui-menu-kbd' }, it.shortcut) : null,
    it.items ? c.icon('chevron-right') : null);
    b._item = it;
    entries.push(b); el.append(b);
  }
  let open = true, sub = null, hoverT = 0;
  const roving = createRovingFocus(el, { items: () => entries, orientation: 'vertical', typeahead: true, getLabel: b => String(b._item.label) });
  const enabled = () => entries.filter(b => b.getAttribute('aria-disabled') !== 'true');
  const handle = s.overlays.open(el, { kind: 'menu', trigger: opts.trigger, initialFocus: false, dismissOnOutside: true, onDismiss: r => api.close(r) });
  const pos = autoPosition(opts.anchor || opts.trigger, el, { placement: opts.placement || 'bottom-start', offset: opts.offset ?? (opts.point ? 0 : 4), point: opts.point });
  s.motion.animate(el, { o: 1, y: 0 }, { role: 'enter', from: fromOffset(el.dataset.placement) });
  const focus = opts.focus ?? 'first';
  if (focus !== 'none') { const list = enabled(); const t = focus === 'last' ? list[list.length - 1] : list[0]; if (t) roving.focus(t); else el.focus(); }

  const root = () => { let m = api; while (m.parent) m = m.parent; return m; };
  const info = it => ({ path: [...(opts.path || []), it.id], group: it.type === 'radio' ? it.group ?? null : null });
  function activate(b, e) {
    const it = b._item;
    if (it.disabled) { e?.preventDefault(); return; }
    if (it.back) { api.close('back'); return; } // the Back item of a narrow submenu
    if (it.items) { openSub(b, true); return; }
    root().close('select');
    it.onSelect?.(it, e, info(it));
    opts.onSelect?.(it, e, info(it));
  }
  function openSub(b, focusFirst) {
    win.clearTimeout(hoverT);
    if (sub && sub.parentItem === b) { if (focusFirst) sub.focusFirst(); return; }
    sub?.close('switch', { restoreFocus: false });
    b.setAttribute('aria-expanded', 'true');
    // Narrow screens have no room beside the menu: the submenu opens over it, with Back first (G34, as in 1.0).
    const narrow = win.innerWidth < BREAKPOINTS.rail, r = narrow ? el.getBoundingClientRect() : null;
    const items = narrow ? [{ id: 'back', label: s.t('back'), icon: 'chevron-left', back: true }, { separator: true }, ...b._item.items] : b._item.items;
    const where = narrow ? { point: { x: r.left, y: r.top }, placement: 'bottom-start', offset: 0 } : { anchor: b, placement: 'end-start', offset: 2 };
    sub = openMenu(s, { items, trigger: b, ...where, label: String(b._item.label), focus: focusFirst || narrow ? 'first' : 'none', path: [...(opts.path || []), b._item.id], onSelect: opts.onSelect, onClose: () => { b.setAttribute('aria-expanded', 'false'); sub = null; } });
    sub.parent = api; sub.parentItem = b;
  }
  c.on(el, 'click', e => { const b = e.target.closest('.ui-menu-item'); if (b && el.contains(b)) activate(b, e); });
  c.on(el, 'pointermove', e => {
    if (e.pointerType === 'touch') return;
    const b = e.target.closest('.ui-menu-item');
    if (!b || doc.activeElement === b) return;
    if (b.getAttribute('aria-disabled') !== 'true') roving.focus(b); else { el.focus({ preventScroll: true }); }
    win.clearTimeout(hoverT);
    if (b._item.items) hoverT = win.setTimeout(() => open && openSub(b, false), 120);
    else if (sub) hoverT = win.setTimeout(() => sub?.close('hover', { restoreFocus: false }), 200);
  });
  c.on(el, 'keydown', e => {
    const b = e.target.closest?.('.ui-menu-item');
    const rtl = rtlOf(el), into = rtl ? 'ArrowLeft' : 'ArrowRight', back = rtl ? 'ArrowRight' : 'ArrowLeft';
    if (e.key === into && b?._item.items) { e.preventDefault(); openSub(b, true); }
    else if (e.key === back && api.parent) { e.preventDefault(); api.close('back'); }
    else if ((e.key === 'Enter' || e.key === ' ') && b) { e.preventDefault(); if (b.tagName === 'A' && e.key === 'Enter' && !b._item.disabled) { root().close('select'); opts.onSelect?.(b._item, e, info(b._item)); b.click(); } else activate(b, e); }
    else if (e.key === 'Tab') root().close('tab'); // focus returns to the root trigger, then Tab continues from there
  });
  const api = {
    element: el, parent: null, parentItem: null,
    get isOpen() { return open; },
    focusFirst() { const t = enabled()[0]; if (t) roving.focus(t); },
    close(reason = 'dismiss', { restoreFocus = true } = {}) {
      if (!open) return; open = false;
      win.clearTimeout(hoverT);
      // Close the submenu first and let it hand focus back to its item, so this menu can then restore to its trigger.
      sub?.close(reason, { restoreFocus });
      pos.cleanup(); roving.destroy();
      handle.close({ restoreFocus });
      opts.onClose?.(reason);
      // A selection in a submenu closes the whole chain from the root.
      if (reason === 'select' || reason === 'tab') api.parent?.close(reason, { restoreFocus });
      s.motion.animate(el, { o: 0 }, { role: 'exit' }).then(() => { c.destroy(); el.remove(); });
    },
  };
  return api;
}

/** createMenuButton(container, { label, icon, iconOnly, variant, items | () => items, placement, disabled, onSelect }) */
export function createMenuButton(container, props = {}, services) {
  const c = setup(container, services, 'menu-button');
  let p = { placement: 'bottom-start', variant: 'secondary', ...props };
  const btn = createButton(container, { label: p.label, icon: p.icon, iconOnly: p.iconOnly, iconEnd: p.iconOnly ? null : 'chevron-down', variant: p.variant, disabled: p.disabled, haspopup: 'menu' }, c.s);
  const el = btn.element;
  el.setAttribute('aria-expanded', 'false');
  let menu = null;
  function open(focus = 'first') {
    if (menu || p.disabled) return;
    const items = typeof p.items === 'function' ? p.items() : p.items;
    menu = openMenu(c.s, { items, trigger: el, anchor: el, placement: p.placement, label: p.label, focus, onSelect: (item, e, x) => c.emit(el, 'select', { item, id: item.id, path: x?.path ?? [item.id], group: x?.group ?? null, event: e }, p.onSelect), onClose: () => { menu = null; el.setAttribute('aria-expanded', 'false'); el.removeAttribute('aria-controls'); } });
    el.setAttribute('aria-expanded', 'true'); el.setAttribute('aria-controls', menu.element.id);
  }
  c.on(el, 'click', () => (menu ? menu.close('toggle') : open('first')));
  c.on(el, 'keydown', e => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); open(e.key === 'ArrowUp' ? 'last' : 'first'); } });
  c.cleanup(() => { menu?.close('destroy', { restoreFocus: false }); btn.destroy(); });
  return {
    root: el, element: el, open, close: () => menu?.close('api'), get isOpen() { return !!menu; },
    update(n) { p = { ...p, ...n }; btn.update({ label: p.label, icon: p.icon, iconOnly: p.iconOnly, variant: p.variant, disabled: p.disabled }); },
    focus: () => el.focus(), destroy: () => c.destroy(),
  };
}

/**
 * createContextMenu(target, { items | (event) => items, label, disabled, onSelect }) — opens at the pointer on right-click,
 * after a 500 ms touch long-press, and at the focused element with Shift+F10 or the ContextMenu key.
 */
export function createContextMenu(target, props = {}, services) {
  const c = setup(target, services, 'context-menu');
  let p = { ...props }, menu = null, press = null, ignoreNative = 0;
  function open(e, at) {
    if (p.disabled) return;
    const items = typeof p.items === 'function' ? p.items(e) : p.items;
    if (!items?.length) return;
    menu?.close('reopen', { restoreFocus: false });
    const origin = e?.target instanceof c.win.Element ? e.target : target;
    const trigger = origin.closest('a[href],button,input,select,textarea,[tabindex]') || target;
    menu = openMenu(c.s, { items, trigger, label: p.label, placement: 'bottom-start', focus: 'first', ...at, onSelect: (item, ev, x) => c.emit(target, 'select', { item, id: item.id, path: x?.path ?? [item.id], group: x?.group ?? null, origin, event: ev }, p.onSelect), onClose: () => { menu = null; } });
  }
  c.on(target, 'contextmenu', e => {
    if (p.disabled) return;
    e.preventDefault();
    if (c.win.performance.now() < ignoreNative) return;
    if (!e.clientX && !e.clientY) open(e, { anchor: e.target.closest?.('*') || target }); else open(e, { point: { x: e.clientX, y: e.clientY } });
  });
  c.on(target, 'keydown', e => {
    if (!((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu')) return;
    e.preventDefault(); ignoreNative = c.win.performance.now() + 300;
    open(e, { anchor: e.target });
  });
  // Touch long-press (iOS Safari does not fire contextmenu): 500 ms without moving more than 8 px.
  const cancelPress = () => { if (press) { c.win.clearTimeout(press.t); press = null; } };
  c.on(target, 'pointerdown', e => {
    if (e.pointerType !== 'touch' || p.disabled) return;
    cancelPress();
    press = { x: e.clientX, y: e.clientY, t: c.win.setTimeout(() => { press = null; ignoreNative = c.win.performance.now() + 800; open(e, { point: { x: e.clientX, y: e.clientY } }); }, 500) };
  });
  c.on(target, 'pointermove', e => { if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 8) cancelPress(); });
  for (const t of ['pointerup', 'pointercancel', 'scroll']) c.on(target, t, cancelPress);
  c.cleanup(() => { cancelPress(); menu?.close('destroy', { restoreFocus: false }); });
  return { root: target, get isOpen() { return !!menu; }, close: () => menu?.close('api'), update(n) { p = { ...p, ...n }; }, destroy: () => c.destroy() };
}

// ---------------------------------------------------------------- tooltip
let lastTooltipHide = -Infinity;
/**
 * createTooltip(target, { content, placement = 'top', delay = 500, describe }) — supplementary text on hover (mouse /
 * pen) and keyboard focus; never on touch. Hoverable and dismissable with Escape (WCAG 1.4.13). Describes the target
 * (aria-describedby) unless the text equals the target's accessible name (icon-only buttons).
 */
export function createTooltip(target, props = {}, services) {
  const c = setup(target, services, 'tooltip');
  let p = { placement: 'top', delay: 500, ...props };
  const el = c.h('div', { class: 'ui-tooltip', role: 'tooltip', id: uid('tip'), hidden: true });
  let shown = false, showT = 0, hideT = 0, handle = null, pos = null, ticket = 0;
  target.dataset.tip = 'own'; // the shared label tooltip (tips.js) skips this target
  const text = () => (typeof p.content === 'string' ? p.content : p.content?.textContent || '');
  function syncDescribe() {
    const ids = new Set((target.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean));
    const on = p.describe ?? text() !== target.getAttribute('aria-label');
    if (on) ids.add(el.id); else ids.delete(el.id);
    if (ids.size) target.setAttribute('aria-describedby', [...ids].join(' ')); else target.removeAttribute('aria-describedby');
    if (on && !el.isConnected) { el.hidden = true; c.s.overlays.portal.append(el); } // the description must exist in the DOM
    if (!shown) fill(el, p.content);
  }
  function show() {
    c.win.clearTimeout(showT); c.win.clearTimeout(hideT);
    if (shown || !target.isConnected) return;
    shown = true; ticket++;
    fill(el, p.content); el.hidden = false;
    handle = c.s.overlays.open(el, { kind: 'tooltip', passive: true, initialFocus: false, restoreFocus: false, dismissOnOutside: false });
    pos = autoPosition(target, el, { placement: p.placement, offset: 6, limitHeight: false });
    c.s.motion.animate(el, { o: 1 }, { role: 'enter', from: { o: 0 } });
  }
  function hide() {
    c.win.clearTimeout(showT); c.win.clearTimeout(hideT);
    if (!shown) return;
    shown = false; lastTooltipHide = c.win.performance.now();
    pos.cleanup(); handle.close({ restoreFocus: false });
    const my = ++ticket;
    c.s.motion.animate(el, { o: 0 }, { role: 'exit' }).then(() => { if (my === ticket && !shown) { el.hidden = true; c.s.motion.reset(el); } });
  }
  const later = () => { c.win.clearTimeout(hideT); hideT = c.win.setTimeout(hide, 120); };
  c.on(target, 'pointerenter', e => {
    if (e.pointerType === 'touch') return;
    c.win.clearTimeout(hideT);
    const warm = c.win.performance.now() - lastTooltipHide < 400; // moving between tooltipped controls: no second delay
    showT = c.win.setTimeout(show, warm ? 0 : p.delay);
  });
  c.on(target, 'pointerleave', later);
  c.on(el, 'pointerenter', () => c.win.clearTimeout(hideT));
  c.on(el, 'pointerleave', later);
  c.on(target, 'focusin', () => { let kb = false; try { kb = target.matches(':focus-visible') || target.querySelector(':focus-visible'); } catch { kb = c.s.modality.modality === 'keyboard'; } if (kb) show(); });
  c.on(target, 'focusout', hide);
  c.on(target, 'pointerdown', hide);
  // Escape hides only the tooltip (window capture runs before the overlay manager's document listener).
  c.on(c.win, 'keydown', e => { if (shown && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); hide(); } }, { capture: true });
  syncDescribe();
  c.cleanup(() => { hide(); el.remove(); delete target.dataset.tip; const ids = (target.getAttribute('aria-describedby') || '').split(/\s+/).filter(x => x && x !== el.id); if (ids.length) target.setAttribute('aria-describedby', ids.join(' ')); else target.removeAttribute('aria-describedby'); });
  return { root: el, show, hide, get isOpen() { return shown; }, update(n) { p = { ...p, ...n }; if (shown) { fill(el, p.content); pos.update(); } syncDescribe(); }, destroy: () => c.destroy() };
}

// ---------------------------------------------------------------- popover
/**
 * createPopover(trigger, { content: Node | (body) => void, title, label, placement = 'bottom-start', initialFocus, onOpenChange })
 * A non-modal dialog anchored to its trigger: focus moves in, Escape / outside click / focus leaving closes it.
 */
export function createPopover(trigger, props = {}, services) {
  const c = setup(trigger, services, 'popover');
  let p = { placement: 'bottom-start', ...props };
  const titleId = uid('pop-t');
  const el = c.h('div', { class: 'ui-popover ui-popup', role: 'dialog', id: uid('pop'), tabindex: '-1', hidden: true });
  const head = c.h('div', { class: 'ui-popover-title', id: titleId });
  const body = c.h('div', { class: 'ui-popover-body' });
  el.append(head, body);
  let isOpen = false, handle = null, pos = null, ticket = 0, built = false;
  function render() {
    head.hidden = !p.title; head.textContent = p.title || '';
    if (p.title) { el.setAttribute('aria-labelledby', titleId); el.removeAttribute('aria-label'); } else { el.removeAttribute('aria-labelledby'); if (p.label) el.setAttribute('aria-label', p.label); }
    if (!built || p.content?.nodeType) { if (typeof p.content === 'function') p.content(body); else fill(body, p.content); built = true; }
    trigger.setAttribute('aria-haspopup', 'dialog'); trigger.setAttribute('aria-expanded', String(isOpen)); trigger.setAttribute('aria-controls', el.id);
  }
  function open() {
    if (isOpen) return;
    isOpen = true; ticket++;
    el.hidden = false;
    handle = c.s.overlays.open(el, { kind: 'menu', trigger, initialFocus: () => p.initialFocus?.() || null, dismissOnOutside: true, onDismiss: r => close({ reason: r }) });
    pos = autoPosition(trigger, el, { placement: p.placement, offset: 6 });
    trigger.setAttribute('aria-expanded', 'true');
    c.s.motion.animate(el, { o: 1, y: 0 }, { role: 'enter', from: fromOffset(el.dataset.placement) });
    c.emit(trigger, 'open-change', { open: true }, p.onOpenChange);
  }
  function close({ restoreFocus = true, reason = 'api' } = {}) {
    if (!isOpen) return;
    isOpen = false;
    pos.cleanup(); handle.close({ restoreFocus });
    trigger.setAttribute('aria-expanded', 'false');
    const my = ++ticket;
    c.s.motion.animate(el, { o: 0 }, { role: 'exit' }).then(() => { if (my === ticket) { el.hidden = true; c.s.motion.reset(el); } });
    c.emit(trigger, 'open-change', { open: false, reason }, p.onOpenChange);
  }
  c.on(trigger, 'click', () => (isOpen ? close({ reason: 'toggle' }) : open()));
  // Focus leaving for the page (not for the trigger or a layer opened from inside) closes without stealing focus back.
  c.on(el, 'focusout', e => {
    const to = e.relatedTarget;
    if (!isOpen || !to || el.contains(to) || trigger.contains(to) || c.s.overlays.portal.contains(to)) return;
    close({ restoreFocus: false, reason: 'blur' });
  });
  render();
  c.cleanup(() => { close({ restoreFocus: false, reason: 'destroy' }); el.remove(); for (const a of ['aria-haspopup', 'aria-expanded', 'aria-controls']) trigger.removeAttribute(a); });
  return { root: el, body, open, close, toggle: () => (isOpen ? close() : open()), get isOpen() { return isOpen; }, update(n) { p = { ...p, ...n }; render(); pos?.update(); }, destroy: () => c.destroy() };
}

// ---------------------------------------------------------------- modal shell shared by dialog and sheet
function modalBase(c, p, { kind, panelClass, layerClass }) {
  const titleId = uid('dlg-t'), descId = uid('dlg-d');
  const layer = c.h('div', { class: layerClass, hidden: true });
  const panel = c.h('section', { class: panelClass, role: p.role === 'alertdialog' ? 'alertdialog' : 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1' });
  const title = c.h('h2', { class: 'ui-modal-title', id: titleId });
  const closeBtn = c.h('button', { type: 'button', class: 'ui-button ui-modal-close', 'data-variant': 'ghost', 'data-icon-only': '' }, c.icon('close'));
  const head = c.h('header', { class: 'ui-modal-head' }, title, closeBtn);
  const errorSlot = c.h('div', { class: 'ui-modal-error', hidden: true });
  const desc = c.h('p', { class: 'ui-modal-desc', id: descId });
  const body = c.h('div', { class: 'ui-modal-body' });
  const actions = c.h('footer', { class: 'ui-modal-actions' });
  panel.append(head, c.h('div', { class: 'ui-modal-scroll' }, errorSlot, desc, body), actions);
  layer.append(panel);
  let busy = false, built = false, alert = null, buttons = [];
  function render(run) {
    title.textContent = p.title || '';
    closeBtn.setAttribute('aria-label', c.s.t('close'));
    closeBtn.hidden = p.closeButton === false || p.dismissible === false;
    desc.textContent = p.description || ''; desc.hidden = !p.description;
    if (p.description) panel.setAttribute('aria-describedby', descId); else panel.removeAttribute('aria-describedby');
    panel.dataset.size = p.size || 'md';
    if (p.width) panel.style.setProperty(kind === 'dialog' ? '--ui-dialog-width' : '--ui-sheet-width', p.width); else panel.style.removeProperty(kind === 'dialog' ? '--ui-dialog-width' : '--ui-sheet-width'); // width hook (G36)
    if (!built || p.content?.nodeType) { if (typeof p.content === 'function') p.content(body); else fill(body, p.content); built = true; }
    for (const b of buttons) b.destroy();
    fill(actions);
    buttons = (p.actions || []).map(a => { const b = createButton(actions, { label: a.label, variant: a.variant || 'secondary', icon: a.icon, disabled: a.disabled }, c.s); b.element.addEventListener('click', () => run(a, b)); b._action = a; return b; });
    actions.hidden = !buttons.length;
  }
  function setBusy(on, which) {
    busy = on;
    for (const b of buttons) b.update(b === which ? { busy: on } : { disabled: on || b._action.disabled });
    closeBtn.disabled = on;
  }
  function setError(msg) {
    alert?.destroy(); alert = null;
    errorSlot.hidden = !msg;
    if (msg) alert = createInlineAlert(errorSlot, { kind: 'bad', message: msg, live: 'assertive' }, c.s);
  }
  // Initial focus: an action marked autoFocus; in an alert dialog the safe (non-primary, non-danger) action; else the
  // first field in the body; else the primary action; else the panel itself.
  function initialFocus() {
    if (p.initialFocus) return typeof p.initialFocus === 'function' ? p.initialFocus() : p.initialFocus;
    const auto = buttons.find(b => b._action.autoFocus); if (auto) return auto.element;
    if (p.role === 'alertdialog') { const safe = buttons.find(b => !['primary', 'danger'].includes(b._action.variant || 'secondary')); if (safe) return safe.element; }
    // First field by selector (no layout); the overlay manager falls back to a full scan if it cannot take focus.
    return body.querySelector(FIELD) || buttons.find(b => b._action.variant === 'primary')?.element || panel;
  }
  return { layer, panel, body, closeBtn, render, setBusy, setError, initialFocus, get busy() { return busy; }, get buttons() { return buttons; }, destroyButtons() { for (const b of buttons) b.destroy(); alert?.destroy(); } };
}
async function runAction(m, a, b, api) {
  if (m.busy || a.disabled) return;
  m.setError(null);
  let r = a.value;
  if (a.onClick) {
    let out;
    try { out = a.onClick({ dialog: api, value: a.value }); } catch (err) { m.setError(err?.message || api.t('dialog.error')); return; }
    if (out && typeof out.then === 'function') {
      m.setBusy(true, b);
      try { out = await out; } catch (err) { if (!api.isOpen) return; m.setBusy(false, b); m.setError(err?.message || api.t('dialog.error')); return; }
      if (!api.isOpen) return;
      m.setBusy(false, b);
    }
    if (out === false) return;
    if (out !== undefined) r = out;
  }
  if (a.close !== false) api.close(r);
}

// ---------------------------------------------------------------- dialog
/**
 * createDialog({ title, description, content: Node | (body) => void, actions: [{ label, variant, value, icon, autoFocus,
 *   close, onClick({ dialog, value }) → value | false | Promise }], role: 'dialog'|'alertdialog', size: 'sm'|'md'|'lg',
 *   dismissible = true, closeButton = true, initialFocus, onClose({ value, reason }) }, services)
 * → { element, body, open() → Promise<value>, close(value), setError(msg), get isOpen, update, destroy }
 * An async action shows busy on its button and blocks dismissal; a rejection shows an error in the dialog (D17).
 */
export function createDialog(props = {}, services) {
  const s = services || getServices();
  const c = setup(portalOf(s), s, 'dialog');
  let p = { role: 'dialog', size: 'md', dismissible: true, ...props };
  const m = modalBase(c, p, { kind: 'dialog', panelClass: 'ui-dialog', layerClass: 'ui-dialog-layer' });
  let isOpen = false, handle = null, resolve = null, ticket = 0, downOnLayer = false;
  const api = {
    element: m.panel, body: m.body, t: (k, o) => c.s.t(k, o),
    get isOpen() { return isOpen; },
    open() {
      if (isOpen) return new Promise(r => { const prev = resolve; resolve = v => { prev?.(v); r(v); }; });
      isOpen = true; ticket++;
      handle = c.s.overlays.open(m.layer, { kind: 'dialog', modal: true, initialFocus: m.initialFocus, dismissOnEscape: true, onDismiss: reason => { if (p.dismissible !== false && !m.busy) close(undefined, reason); } });
      c.s.motion.animate(m.layer, { o: 1 }, { role: 'enter', from: { o: 0 } });
      c.s.motion.animate(m.panel, { o: 1, y: 0 }, { role: 'enter', from: { o: 0, y: 4 } });
      return new Promise(r => { resolve = r; });
    },
    close: v => close(v, 'api'),
    setError: msg => m.setError(msg),
    update(n) { Object.assign(p, n); m.render((a, b) => runAction(m, a, b, api)); }, // modalBase holds this object
    destroy: () => c.destroy(),
  };
  function close(value, reason = 'action') {
    if (!isOpen) return;
    isOpen = false;
    handle.close();
    m.setError(null);
    const my = ++ticket;
    c.s.motion.animate(m.layer, { o: 0 }, { role: 'exit' }).then(() => { if (my === ticket) { m.layer.hidden = true; c.s.motion.reset(m.layer); c.s.motion.reset(m.panel); } });
    const r = resolve; resolve = null;
    p.onClose?.({ value, reason });
    r?.(value);
  }
  // Backdrop click (press and release both on the scrim) dismisses ordinary dialogs, never alert dialogs.
  c.on(m.layer, 'pointerdown', e => { downOnLayer = e.target === m.layer; });
  c.on(m.layer, 'click', e => { if (downOnLayer && e.target === m.layer && p.role !== 'alertdialog' && p.dismissible !== false && !m.busy) close(undefined, 'backdrop'); downOnLayer = false; });
  c.on(m.closeBtn, 'click', () => { if (!m.busy) close(undefined, 'close'); });
  m.render((a, b) => runAction(m, a, b, api));
  c.s.overlays.portal.append(m.layer);
  c.cleanup(() => { if (isOpen) { isOpen = false; handle.close({ restoreFocus: true }); resolve?.(undefined); } m.destroyButtons(); m.layer.remove(); });
  return api;
}

/**
 * confirm({ title, message, content, confirmLabel, cancelLabel, danger, typeToConfirm, onConfirm }, services) → Promise<boolean>
 * An alert dialog that focuses the safe action, ignores backdrop clicks, resolves false on Escape and true after
 * onConfirm settles (its errors stay in the dialog). With `typeToConfirm` (G26) a field asks for that exact text: it
 * takes focus, the confirm action stays disabled until the text matches, and Enter then confirms.
 */
export async function confirm(props = {}, services) {
  const s = services || getServices();
  const word = props.typeToConfirm == null ? null : String(props.typeToConfirm);
  let field = null, matched = word == null;
  const actions = () => [{ label: props.cancelLabel || s.t('cancel'), value: false }, { label: props.confirmLabel || s.t('apply'), variant: props.danger ? 'danger' : 'primary', value: true, disabled: !matched, onClick: props.onConfirm ? () => Promise.resolve(props.onConfirm()).then(() => true) : undefined }];
  const content = word == null ? props.content : body => {
    if (props.content) body.append(props.content);
    field = createTextField(body, { label: s.t('confirm.type', { text: word }), autocomplete: 'off', spellcheck: false, onInput: e => { const now = e.value.trim() === word; if (now !== matched) { matched = now; d.update({ actions: actions() }); } } }, s);
    field.input.addEventListener('keydown', e => { if (e.key === 'Enter' && matched && !e.isComposing) { e.preventDefault(); [...d.element.querySelectorAll('.ui-modal-actions .ui-button')].at(-1)?.click(); } });
  };
  const d = createDialog({ role: 'alertdialog', size: 'sm', title: props.title, description: props.message, content, actions: actions(), initialFocus: word == null ? undefined : () => field.input }, s);
  const v = await d.open();
  field?.destroy(); d.destroy();
  return v === true;
}

// ---------------------------------------------------------------- sheet / drawer
/**
 * createSheet({ title, description, content, actions, side: 'auto'|'end'|'start'|'bottom', dismissible = true, onClose }, services)
 * Modal side drawer on wide screens, bottom sheet below the rail breakpoint (side 'auto'). The bottom sheet can be
 * dragged down to close (release past 30 % of its height or faster than 800 px/s); otherwise it springs back.
 */
export function createSheet(props = {}, services) {
  const s = services || getServices();
  const c = setup(portalOf(s), s, 'sheet');
  let p = { side: 'auto', dismissible: true, ...props };
  const m = modalBase(c, p, { kind: 'drawer', panelClass: 'ui-sheet', layerClass: 'ui-sheet-layer' });
  const grip = c.h('div', { class: 'ui-sheet-grip', 'aria-hidden': 'true' });
  m.panel.prepend(grip);
  let isOpen = false, handle = null, resolve = null, ticket = 0, side = 'end', drag = null;
  const resolveSide = () => (p.side === 'auto' ? (c.win.innerWidth < BREAKPOINTS.rail ? 'bottom' : 'end') : p.side);
  const offset = () => {
    if (side === 'bottom') return { y: m.panel.offsetHeight + 16 };
    const w = m.panel.offsetWidth + 16, rtl = rtlOf(m.panel);
    return { x: (side === 'end') !== rtl ? w : -w };
  };
  const api = {
    element: m.panel, body: m.body, t: (k, o) => c.s.t(k, o),
    get isOpen() { return isOpen; }, get side() { return side; },
    open() {
      if (isOpen) return new Promise(r => { const prev = resolve; resolve = v => { prev?.(v); r(v); }; });
      isOpen = true; ticket++;
      side = resolveSide(); m.panel.dataset.side = side;
      handle = c.s.overlays.open(m.layer, { kind: 'drawer', modal: true, initialFocus: m.initialFocus, onDismiss: reason => { if (p.dismissible !== false && !m.busy) close(undefined, reason); } });
      c.s.motion.animate(m.layer, { o: 1 }, { role: 'enter', from: { o: 0 } });
      c.s.motion.animate(m.panel, { x: 0, y: 0 }, { role: 'sheet', from: offset() });
      return new Promise(r => { resolve = r; });
    },
    close: v => close(v, 'api'),
    setError: msg => m.setError(msg),
    update(n) { Object.assign(p, n); m.render((a, b) => runAction(m, a, b, api)); }, // modalBase holds this object
    destroy: () => c.destroy(),
  };
  function close(value, reason = 'action', vel) {
    if (!isOpen) return;
    isOpen = false;
    handle.close();
    m.setError(null);
    const my = ++ticket;
    c.s.motion.animate(m.panel, offset(), { role: vel ? 'drag' : 'sheet', vel });
    c.s.motion.animate(m.layer, { o: 0 }, { role: 'exit', delay: 0.06 }).then(() => { if (my === ticket) { m.layer.hidden = true; c.s.motion.reset(m.layer); c.s.motion.reset(m.panel); } });
    const r = resolve; resolve = null;
    p.onClose?.({ value, reason });
    r?.(value);
  }
  c.on(m.layer, 'click', e => { if (e.target === m.layer && p.dismissible !== false && !m.busy) close(undefined, 'backdrop'); });
  c.on(m.closeBtn, 'click', () => { if (!m.busy) close(undefined, 'close'); });
  // Drag to dismiss (bottom sheet): from the grip or the header, not from buttons.
  c.on(m.panel, 'pointerdown', e => {
    if (side !== 'bottom' || e.button || !isOpen || m.busy || p.dismissible === false) return;
    if (!e.target.closest('.ui-sheet-grip, .ui-modal-head') || e.target.closest('button')) return;
    drag = { id: e.pointerId, y0: e.clientY, dy: 0, samples: [[e.timeStamp, 0]] };
    try { m.panel.setPointerCapture(e.pointerId); } catch { /* synthetic or already released pointer */ }
  });
  c.on(m.panel, 'pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    const raw = e.clientY - drag.y0;
    drag.dy = raw < 0 ? raw * 0.2 : raw; // resist pulling up
    drag.samples.push([e.timeStamp, drag.dy]); if (drag.samples.length > 5) drag.samples.shift();
    c.s.motion.animate(m.panel, { y: drag.dy }, { role: 'list' });
  });
  const endDrag = e => {
    if (!drag || e.pointerId !== drag.id) return;
    const [[t0, y0]] = drag.samples, [t1, y1] = drag.samples[drag.samples.length - 1];
    // Release velocity over at least 32 ms: coalesced or synthetic events can be < 1 ms apart and would read as a fling.
    const v = ((y1 - y0) / Math.max(32, t1 - t0)) * 1000, dy = drag.dy;
    drag = null;
    if (dy > m.panel.offsetHeight * 0.3 || v > 800) close(undefined, 'drag', { y: v });
    else c.s.motion.animate(m.panel, { y: 0 }, { role: 'drag', vel: { y: v } });
  };
  c.on(m.panel, 'pointerup', endDrag); c.on(m.panel, 'pointercancel', endDrag);
  m.render((a, b) => runAction(m, a, b, api));
  c.s.overlays.portal.append(m.layer);
  c.cleanup(() => { if (isOpen) { isOpen = false; handle.close({ restoreFocus: true }); resolve?.(undefined); } m.destroyButtons(); m.layer.remove(); });
  return api;
}
