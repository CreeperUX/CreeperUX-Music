import { setup, fill, uid, h, getServices, createButton, createMenuButton, createDialog, openMenu, autoPosition } from '../ui/index.js';
import { plusStrings } from './strings.js';

const rtlOf = el => el.ownerDocument.defaultView.getComputedStyle(el).direction === 'rtl';
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ---------------------------------------------------------------- split button, overflow menu
/** createSplitButton(container, { label, icon, variant, disabled, onClick, items, menuLabel, onSelect }) — main action plus a menu of related ones. */
export function createSplitButton(container, props = {}, services) {
  const c = setup(container, services, 'split-button'); plusStrings(c.s);
  let p = { variant: 'secondary', ...props };
  const el = c.own(c.h('div', { class: 'ui-split-button', role: 'group' }));
  const main = createButton(el, { label: p.label, icon: p.icon, variant: p.variant, disabled: p.disabled, onClick: e => c.emit(el, 'click', e, p.onClick) }, c.s);
  const more = createMenuButton(el, { label: p.menuLabel || c.s.t('split.more'), icon: 'chevron-down', iconOnly: true, variant: p.variant, disabled: p.disabled, placement: 'bottom-end', items: () => p.items, onSelect: e => c.emit(el, 'select', e, p.onSelect) }, c.s);
  el.setAttribute('aria-label', p.label);
  c.cleanup(() => { main.destroy(); more.destroy(); });
  container.append(el);
  return { root: el, update(n) { p = { ...p, ...n }; main.update({ label: p.label, icon: p.icon, variant: p.variant, disabled: p.disabled }); more.update({ variant: p.variant, disabled: p.disabled }); el.setAttribute('aria-label', p.label); }, focus: () => main.focus(), destroy: () => c.destroy() };
}
/** createOverflowMenu(container, { label = 'More', items, placement, onSelect }) — the "…" menu button for secondary actions. */
export function createOverflowMenu(container, props = {}, services) {
  const s = plusStrings(services || getServices(container));
  return createMenuButton(container, { label: props.label || s.t('more'), icon: 'more', iconOnly: true, variant: 'ghost', placement: 'bottom-end', ...props }, s);
}

// ---------------------------------------------------------------- menubar
/**
 * createMenubar(container, { label, menus: [{ id, label, items }], onSelect({ menu, item }) }, services)
 * APG menubar: ← → move between menus (and switch the open menu), ↓ Enter Space open, Escape closes back to the bar.
 */
export function createMenubar(container, props = {}, services) {
  const c = setup(container, services, 'menubar'); plusStrings(c.s);
  let p = { menus: [], ...props };
  const el = c.own(c.h('div', { class: 'ui-menubar', role: 'menubar' }));
  let open = null, current = 0;
  const btns = () => [...el.querySelectorAll('.ui-menubar-item')];
  function render() {
    if (p.label) el.setAttribute('aria-label', p.label);
    // a disabled menu stays in the roving order, readable, but does not open (G34)
    fill(el, p.menus.map((m, i) => c.h('button', { type: 'button', class: 'ui-menubar-item', role: 'menuitem', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-disabled': m.disabled ? 'true' : null, tabindex: i === current ? '0' : '-1', 'data-i': i }, m.label)));
  }
  function focusAt(i) { current = (i + p.menus.length) % p.menus.length; btns().forEach((b, k) => { b.tabIndex = k === current ? 0 : -1; }); btns()[current].focus(); }
  function openAt(i, focus = 'first') {
    open?.close('switch', { restoreFocus: false });
    focusAt(i);
    const b = btns()[current], m = p.menus[current];
    if (m.disabled) return;
    b.setAttribute('aria-expanded', 'true');
    const items = typeof m.items === 'function' ? m.items() : m.items;
    const handle = openMenu(c.s, { items, trigger: b, anchor: b, label: m.label, focus, onSelect: (item, e, x) => c.emit(el, 'select', { menu: m.id, item, path: x?.path ?? [item.id], group: x?.group ?? null, event: e }, p.onSelect), onClose: () => { b.setAttribute('aria-expanded', 'false'); if (open === handle) open = null; } });
    open = handle;
    // ← → inside an open top-level menu switch to the neighbouring menu (unless the item opens a submenu)
    handle.element.addEventListener('keydown', e => {
      const rtl = rtlOf(el), into = rtl ? 'ArrowLeft' : 'ArrowRight', out = rtl ? 'ArrowRight' : 'ArrowLeft';
      const item = e.target.closest?.('.ui-menu-item');
      if (e.key === into && !item?.hasAttribute('aria-haspopup')) { e.preventDefault(); e.stopPropagation(); openAt(current + 1); }
      else if (e.key === out) { e.preventDefault(); e.stopPropagation(); openAt(current - 1); }
    }, true);
  }
  c.on(el, 'click', e => { const b = e.target.closest('.ui-menubar-item'); if (!b) return; const i = Number(b.dataset.i); if (open && current === i) open.close('toggle'); else openAt(i); });
  c.on(el, 'pointerover', e => { const b = e.target.closest('.ui-menubar-item'); if (b && open && Number(b.dataset.i) !== current) openAt(Number(b.dataset.i)); });
  c.on(el, 'keydown', e => {
    const b = e.target.closest('.ui-menubar-item'); if (!b) return;
    const rtl = rtlOf(el), i = Number(b.dataset.i);
    const d = { ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1 }[e.key];
    if (d) { e.preventDefault(); focusAt(i + d); }
    else if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); focusAt(e.key === 'Home' ? 0 : p.menus.length - 1); }
    else if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openAt(i, 'first'); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); openAt(i, 'last'); }
  });
  c.cleanup(() => open?.close('destroy', { restoreFocus: false }));
  render();
  container.append(el);
  return { root: el, update(n) { p = { ...p, ...n }; render(); }, focus: () => focusAt(current), destroy: () => c.destroy() };
}

// ---------------------------------------------------------------- keyboard shortcuts
const isMac = () => /Mac|iPhone|iPad/.test(globalThis.navigator?.platform || globalThis.navigator?.userAgent || '');
function parseKeys(spec) {
  const parts = spec.toLowerCase().split('+').map(x => x.trim());
  const key = parts.pop();
  const mods = new Set(parts.map(m => (m === 'mod' ? (isMac() ? 'meta' : 'ctrl') : m === 'cmd' ? 'meta' : m === 'option' ? 'alt' : m)));
  return { key: key === 'space' ? ' ' : key === 'esc' ? 'escape' : key, mods };
}
const formatStep = spec => {
  const { key, mods } = parseKeys(spec);
  const k = key === ' ' ? 'Space' : key.length === 1 ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1);
  if (isMac()) return `${mods.has('ctrl') ? '⌃' : ''}${mods.has('alt') ? '⌥' : ''}${mods.has('shift') ? '⇧' : ''}${mods.has('meta') ? '⌘' : ''}${k}`;
  return [...(mods.has('ctrl') ? ['Ctrl'] : []), ...(mods.has('alt') ? ['Alt'] : []), ...(mods.has('shift') ? ['Shift'] : []), ...(mods.has('meta') ? ['Win'] : []), k].join('+');
};
/** formatKeys('mod+shift+k') → '⌘⇧K' on Apple platforms, 'Ctrl+Shift+K' elsewhere; a sequence 'g i' → 'G I'. */
export function formatKeys(spec) { return String(spec).trim().split(/\s+/).map(formatStep).join(' '); }
// a step as one canonical string: 'ctrl+shift+k'
const canon = spec => { const { key, mods } = parseKeys(spec); return [...['ctrl', 'alt', 'shift', 'meta'].filter(m => mods.has(m)), key].join('+'); };
const stepsOf = spec => String(spec).trim().split(/\s+/);
const matches = (e, { key, mods }) => e.key.toLowerCase() === key && ['ctrl', 'meta', 'alt', 'shift'].every(m => mods.has(m) === e[`${m}Key`] || (m === 'shift' && key.length === 1 && !/[a-z0-9]/.test(key)));
// One registry per services (G45): every createShortcuts on the same services shares the keys, the conflicts and the help.
const registries = new WeakMap();
function registryOf(s, target) {
  let r = registries.get(s);
  if (r) return r;
  const doc = s.overlays.portal.ownerDocument;
  r = { entries: [], help: null, users: 0, pending: null, timer: 0, target: target || doc };
  const typing = el => el && (el.isContentEditable || /^(input|textarea|select)$/i.test(el.tagName)) && !/^(checkbox|radio|button|submit|range)$/i.test(el.type || '');
  const ready = (sc, e) => !sc.conflict && (sc.allowInInputs || !typing(e.target)) && (sc.global || !s.overlays.stack.some(l => l.modal));
  r.reset = () => { r.pending = null; clearTimeout(r.timer); };
  r.onKey = e => {
    if (e.defaultPrevented || e.isComposing || ['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
    // a key that does not continue the sequence in progress starts again from the first step
    let step = r.pending ? r.pending.step : 0, cands = r.pending ? r.pending.cands : null;
    const at = (list, k) => list.filter(c => c.seq.length > k && matches(e, c.seq[k]) && ready(c.sc, e));
    let hits = cands ? at(cands, step) : [];
    if (!hits.length) { step = 0; hits = at(r.entries.flatMap(sc => sc.alts.map(seq => ({ sc, seq }))), 0); }
    r.reset();
    if (!hits.length) return;
    e.preventDefault();
    const done = hits.find(c => c.seq.length === step + 1);
    if (done) { done.sc.handler(e); return; }
    r.pending = { cands: hits, step: step + 1 };
    r.timer = setTimeout(r.reset, 1000);
  };
  r.target.addEventListener('keydown', r.onKey);
  // the first registration of a key, a sequence or a prefix of a sequence wins; a later one waits until it is removed
  r.recheck = () => {
    const seen = [];
    for (const sc of r.entries) {
      const mine = sc.alts.map(seq => seq.map(x => x.c).join(' '));
      const clash = seen.find(o => o.keys.some(a => mine.some(b => a === b || a.startsWith(`${b} `) || b.startsWith(`${a} `))));
      sc.conflict = clash ? clash.sc.id : null;
      if (!clash) seen.push({ sc, keys: mine });
    }
  };
  registries.set(s, r);
  return r;
}
/**
 * createShortcuts(services, { target = document, onConflict({ id, keys, with }) }) → { register({ id, keys, label, group,
 *   handler, allowInInputs, global }), unregister(id), list, conflicts, hint(id), openHelp(), destroy }
 * Shortcuts do not fire while typing in a field (unless allowInInputs) or behind a modal layer the shortcut did not open.
 * Since 2.4.0 (G45): every registry made on the same services is one registry, with one help view listing them all.
 * `keys` may be a sequence ('g i': G, then I within a second) and an array of alternatives. A key, a sequence or a
 * prefix of a sequence that is already registered is a conflict: the later shortcut waits (it does not fire) until the
 * earlier one is removed, and onConflict, or a console warning, reports it. hint(id) gives a shortcut's keys for a menu
 * item's `shortcut`; the command palette shows the keys of the shortcut registered with a command's id.
 */
export function createShortcuts(services, opts = {}) {
  const s = plusStrings(services || getServices());
  const doc = s.overlays.portal.ownerDocument, r = registryOf(s, opts.target);
  r.users++;
  const mine = new Set(); let seq = 0, alive = true;
  const conflicts = () => r.entries.filter(sc => sc.conflict).map(sc => ({ id: sc.id, keys: sc.keys, with: sc.conflict }));
  const api = {
    register(def) {
      const id = def.id || `sc${++seq}${Math.random().toString(36).slice(2, 6)}`;
      api.unregister(id);
      const sc = { ...def, id, alts: [].concat(def.keys).map(k => stepsOf(k).map(x => ({ ...parseKeys(x), c: canon(x) }))) };
      r.entries.push(sc); mine.add(id); r.recheck();
      if (sc.conflict) { const e = { id, keys: def.keys, with: sc.conflict }; if (opts.onConflict) opts.onConflict(e); else globalThis.console?.warn?.(`createShortcuts: ${[].concat(def.keys).join(', ')} is already taken by "${sc.conflict}"`); }
      return id;
    },
    unregister(id) { const i = r.entries.findIndex(sc => sc.id === id); if (i >= 0) { r.entries.splice(i, 1); mine.delete(id); r.recheck(); } },
    get list() { return r.entries.filter(sc => mine.has(sc.id)).map(({ alts, ...d }) => d); },
    /** Shortcuts registered on these services that wait behind an earlier one with the same keys. */
    get conflicts() { return conflicts(); },
    /** The keys of a registered shortcut (its first alternative), for a menu item's `shortcut`; undefined if none. */
    hint(id) { const sc = r.entries.find(x => x.id === id); return sc ? formatKeys([].concat(sc.keys)[0]) : undefined; },
    openHelp() {
      r.help?.destroy();
      const body = h(doc, 'div', { class: 'ui-shortcuts' });
      const groups = new Map();
      for (const sc of r.entries) { if (!sc.label || sc.conflict) continue; const g = sc.group || ''; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(sc); }
      for (const [g, list] of groups) {
        if (g) body.append(h(doc, 'h3', { class: 'ui-shortcuts-group' }, g));
        body.append(h(doc, 'dl', {}, list.flatMap(sc => [h(doc, 'dt', {}, sc.label), h(doc, 'dd', {}, [].concat(sc.keys).map(k => kbd(k, { doc, then: s.t('shortcuts.then') })))])));
      }
      const help = r.help = createDialog({ title: s.t('shortcuts.title'), content: body, size: 'md' }, s);
      help.open().then(() => { help.destroy(); if (r.help === help) r.help = null; });
    },
    destroy() {
      if (!alive) return; alive = false;
      for (const id of [...mine]) api.unregister(id);
      if (--r.users <= 0) { r.target.removeEventListener('keydown', r.onKey); r.reset(); r.help?.destroy(); registries.delete(s); }
    },
  };
  return api;
}
/** The keys registered for an id on these services (the command palette's hints, G45). */
export const shortcutHint = (s, id) => { const sc = registries.get(s)?.entries.find(x => x.id === id && !x.conflict); return sc ? [].concat(sc.keys)[0] : undefined; };

// ---------------------------------------------------------------- command palette
/**
 * createCommandPalette({ commands: [{ id, label, group, keywords, shortcut, icon, disabled, run }], placeholder, label, limit = 50 }, services)
 * → { open(), close(), get isOpen, update, destroy }
 * A modal search over commands (combobox + listbox): words match in any order, then subsequences; ↑ ↓ Enter, Escape.
 * Register its opener with createShortcuts, e.g. { keys: 'mod+k', handler: () => palette.open(), global: true }.
 */
export function createCommandPalette(props = {}, services) {
  const s = plusStrings(services || getServices());
  const c = setup(s.overlays.portal, s, 'palette');
  let p = { commands: [], limit: 50, ...props };
  const listId = uid('pal');
  const input = c.h('input', { type: 'text', class: 'ui-palette-input', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': listId, 'aria-autocomplete': 'list', autocomplete: 'off', spellcheck: 'false' });
  const list = c.h('div', { class: 'ui-palette-list', role: 'listbox', id: listId });
  const empty = c.h('p', { class: 'ui-palette-empty', hidden: true });
  const panel = c.h('div', { class: 'ui-palette', role: 'dialog', 'aria-modal': 'true' }, c.h('div', { class: 'ui-palette-search' }, c.icon('search'), input), list, empty);
  const layer = c.h('div', { class: 'ui-palette-layer', hidden: true }, panel);
  s.overlays.portal.append(layer);
  let handle = null, shown = [], active = 0;
  const norm = t => String(t ?? '').toLowerCase();
  function score(cmd, q) {
    if (!q) return 1;
    const hay = norm(`${cmd.label} ${cmd.group || ''} ${(cmd.keywords || []).join(' ')}`), words = q.split(/\s+/).filter(Boolean);
    if (words.every(w => hay.includes(w))) return 3 - (norm(cmd.label).startsWith(words[0]) ? 0 : 1);
    let i = 0; for (const ch of q.replace(/\s+/g, '')) { i = hay.indexOf(ch, i); if (i < 0) return 0; i++; }
    return 0.5;
  }
  let engaged = false; // set once the user types or moves in the list
  function filter() {
    const q = norm(input.value).trim();
    shown = p.commands.map((cmd, i) => ({ cmd, s: score(cmd, q), i })).filter(x => x.s > 0).sort((a, b) => b.s - a.s || a.i - b.i).slice(0, p.limit).map(x => x.cmd);
    active = Math.max(0, shown.findIndex(cmd => !cmd.disabled)); render();
  }
  function render() {
    const q = input.value.trim();
    let group;
    fill(list, shown.flatMap((cmd, i) => {
      const out = [];
      if (!q && cmd.group && cmd.group !== group) { group = cmd.group; out.push(c.h('div', { class: 'ui-option-group', role: 'presentation' }, cmd.group)); }
      out.push(c.h('div', { class: 'ui-option ui-palette-item', role: 'option', id: `${listId}-${i}`, 'aria-selected': String(i === active), 'aria-disabled': cmd.disabled ? 'true' : null, 'data-active': i === active ? '' : null, 'data-i': i },
        cmd.icon ? c.icon(cmd.icon) : c.h('span', { class: 'ui-menu-lead', 'aria-hidden': 'true' }), c.h('span', { class: 'ui-menu-label' }, cmd.label), (cmd.shortcut || shortcutHint(c.s, cmd.id)) ? kbd(cmd.shortcut || shortcutHint(c.s, cmd.id), { doc: c.doc, then: c.s.t('shortcuts.then') }) : null));
      return out;
    }));
    empty.hidden = !!shown.length; empty.textContent = c.s.t('palette.empty');
    // No active option until the user types or moves: on open a screen reader announces the edit field, not an option.
    if (shown.length && engaged) input.setAttribute('aria-activedescendant', `${listId}-${active}`); else input.removeAttribute('aria-activedescendant');
    list.querySelector('[data-active]')?.scrollIntoView({ block: 'nearest' });
  }
  // a disabled command is listed and found, but skipped by the arrows and never run (G34)
  const step = d => { for (let k = 1; k <= shown.length; k++) { const n = (active + d * k + shown.length * k) % shown.length; if (!shown[n].disabled) return n; } return active; };
  function run(i) { const cmd = shown[i]; if (!cmd || cmd.disabled) return; api.close(); c.emit(panel, 'run', { id: cmd.id, command: cmd }, p.onRun); cmd.run?.(cmd); }
  c.on(input, 'input', () => { engaged = true; filter(); });
  c.on(input, 'keydown', e => {
    list.setAttribute('data-keys', ''); // keys drive the list: the active command shows a focus ring (plus.css)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (!shown.length) return; if (engaged) active = step(e.key === 'ArrowDown' ? 1 : -1); engaged = true; render(); }
    else if (e.key === 'Enter') { e.preventDefault(); run(active); }
  });
  c.on(list, 'click', e => { const o = e.target.closest('.ui-palette-item'); if (o) run(Number(o.dataset.i)); });
  c.on(list, 'pointermove', e => { list.removeAttribute('data-keys'); const o = e.target.closest('.ui-palette-item'); if (o && Number(o.dataset.i) !== active && !shown[Number(o.dataset.i)]?.disabled) { active = Number(o.dataset.i); for (const x of list.querySelectorAll('.ui-palette-item')) { const on = Number(x.dataset.i) === active; x.toggleAttribute('data-active', on); x.setAttribute('aria-selected', String(on)); } input.setAttribute('aria-activedescendant', `${listId}-${active}`); } });
  c.on(layer, 'pointerdown', e => { if (e.target === layer) api.close(); });
  const api = {
    get isOpen() { return !!handle; },
    open() {
      if (handle) return;
      panel.setAttribute('aria-label', p.label || c.s.t('palette.label'));
      input.setAttribute('aria-label', p.label || c.s.t('palette.label'));
      input.placeholder = p.placeholder || c.s.t('palette.placeholder');
      input.value = ''; engaged = false; filter();
      handle = s.overlays.open(layer, { kind: 'palette', modal: true, initialFocus: input, onDismiss: () => api.close() });
      s.motion.animate(panel, { o: 1, y: 0 }, { role: 'enter', from: { o: 0, y: -4 } });
    },
    close() { if (!handle) return; const h2 = handle; handle = null; h2.close(); layer.hidden = true; s.motion.reset(panel); },
    update(n) { p = { ...p, ...n }; if (handle) filter(); },
    destroy() { api.close(); layer.remove(); c.destroy(); },
  };
  return api;
}

// ---------------------------------------------------------------- toggletip
/**
 * createToggletip(container, { content, label = 'More information', placement = 'top' }, services)
 * An info button that shows a small bubble on click (not hover). The text is written into a polite live region when it
 * opens, so screen readers read it; Escape and an outside click close it; focus stays on the button.
 */
export function createToggletip(container, props = {}, services) {
  const c = setup(container, services, 'toggletip'); plusStrings(c.s);
  let p = { placement: 'top', ...props };
  const btn = c.h('button', { type: 'button', class: 'ui-toggletip-btn', 'aria-expanded': 'false' }, c.icon('info'));
  const live = c.h('span', { class: 'ui-visually-hidden', role: 'status' });
  const bubble = c.h('div', { class: 'ui-toggletip', hidden: true });
  const el = c.own(c.h('span', { class: 'ui-toggletip-wrap' }, btn, live));
  let handle = null, pos = null;
  function close() { if (!handle) return; pos.cleanup(); handle.close({ restoreFocus: false }); handle = null; bubble.hidden = true; live.textContent = ''; btn.setAttribute('aria-expanded', 'false'); }
  function open() {
    fill(bubble, p.content); bubble.hidden = false;
    handle = c.s.overlays.open(bubble, { kind: 'tooltip', trigger: btn, initialFocus: false, restoreFocus: false, dismissOnOutside: true, onDismiss: close });
    pos = autoPosition(btn, bubble, { placement: p.placement, offset: 6, limitHeight: false });
    btn.setAttribute('aria-expanded', 'true');
    live.textContent = ''; c.win.setTimeout(() => { if (handle) live.textContent = typeof p.content === 'string' ? p.content : bubble.textContent; }, 50);
  }
  c.on(btn, 'click', () => (handle ? close() : open()));
  c.on(btn, 'keydown', e => { if (e.key === 'Escape' && handle) { e.preventDefault(); e.stopPropagation(); close(); } });
  c.cleanup(() => { close(); bubble.remove(); });
  btn.setAttribute('aria-label', p.label || c.s.t('toggletip.label'));
  container.append(el);
  return { root: el, get isOpen() { return !!handle; }, open, close, update(n) { p = { ...p, ...n }; btn.setAttribute('aria-label', p.label || c.s.t('toggletip.label')); if (handle) fill(bubble, p.content); }, focus: () => btn.focus(), destroy: () => c.destroy() };
}

// ---------------------------------------------------------------- loading overlay
/**
 * createLoadingOverlay(target, { label = 'Loading…', active, delay = 250 }, services) → { show(), hide(), update, destroy }
 * Covers a region while it reloads: aria-busy on the region, its content inert, a spinner with a status label. Shows
 * after `delay` ms so quick loads do not flash.
 */
export function createLoadingOverlay(target, props = {}, services) {
  const c = setup(target, services, 'loading-overlay'); plusStrings(c.s);
  let p = { delay: 250, ...props };
  const label = c.h('span', {});
  const el = c.h('div', { class: 'ui-loading-overlay', hidden: true }, c.h('span', { class: 'ui-spinner-wrap', role: 'status', 'data-size': 'lg' }, c.h('span', { class: 'ui-spinner', 'aria-hidden': 'true' }), label));
  let timer = 0, shown = false, inerted = [];
  if (c.win.getComputedStyle(target).position === 'static') { target.style.position = 'relative'; c.cleanup(() => { target.style.position = ''; }); }
  function show() {
    if (shown) return; shown = true;
    target.setAttribute('aria-busy', 'true');
    inerted = [...target.children].filter(x => x !== el && !x.inert); for (const x of inerted) x.inert = true;
    label.textContent = p.label || c.s.t('loading');
    c.win.clearTimeout(timer);
    timer = c.win.setTimeout(() => { if (!shown) return; target.append(el); el.hidden = false; c.s.announce(label.textContent); c.s.motion.animate(el, { o: 1 }, { role: 'enter', from: { o: 0 } }); }, p.delay);
  }
  function hide() {
    if (!shown) return; shown = false; c.win.clearTimeout(timer);
    target.removeAttribute('aria-busy'); for (const x of inerted) x.inert = false; inerted = [];
    el.hidden = true; el.remove();
  }
  c.cleanup(() => { hide(); });
  if (p.active) show();
  return { root: el, show, hide, get active() { return shown; }, update(n) { p = { ...p, ...n }; if ('active' in n) (n.active ? show : hide)(); label.textContent = p.label || c.s.t('loading'); }, destroy: () => c.destroy() };
}

// ---------------------------------------------------------------- result page
// Default icon, title and message of the data states a result page can show; the strings are createEmptyState's (G18).
const KNOWN = { unavailable: ['block', 'empty.unavailable', 'empty.unavailableMessage'], permission: ['lock', 'empty.noAccess', 'empty.noAccessMessage'], offline: ['offline', 'empty.offline', 'empty.offlineMessage'], unconfigured: ['settings', 'empty.unconfigured'] };
/**
 * createResult(container, { kind: 'success'|'error'|'warning'|'info'|'notFound'|'unavailable'|'unconfigured', reason, title,
 *   message, actions: [{ label, variant, href, onClick }], details: Node, level = 1, focus }, services) — the outcome of a
 * flow or an error page; focus moves to the heading when asked. 'unavailable' (reason 'permission' or 'offline') and
 * 'unconfigured' have default copy, shared with createEmptyState (G18).
 */
export function createResult(container, props = {}, services) {
  const c = setup(container, services, 'result'); plusStrings(c.s);
  let p = { kind: 'info', level: 1, ...props };
  const el = c.own(c.h('section', { class: 'ui-result' }));
  let buttons = [];
  function render() {
    for (const b of buttons) b.destroy(); buttons = [];
    el.dataset.kind = p.kind;
    const known = p.kind === 'unavailable' ? KNOWN[p.reason === 'permission' || p.reason === 'offline' ? p.reason : 'unavailable'] : p.kind === 'unconfigured' ? KNOWN.unconfigured : null; // default copy (G18)
    const heading = c.h(`h${p.level}`, { class: 'ui-result-title', tabindex: '-1' }, p.title || (known ? c.s.t(known[1]) : ''));
    const message = p.message ?? (known?.[2] ? c.s.t(known[2]) : null);
    const acts = c.h('div', { class: 'ui-result-actions' });
    for (const a of p.actions || []) {
      const link = a.href ? c.h('a', { class: 'ui-button', href: a.href, 'data-variant': a.variant || 'secondary' }, a.label) : null;
      if (link?.hasAttribute('href')) acts.append(link); // an unsafe href is dropped by h(): the action becomes a button
      else buttons.push(createButton(acts, { label: a.label, variant: a.variant || 'secondary', icon: a.icon, onClick: () => a.onClick?.() }, c.s));
    }
    const icon = known?.[0] || { success: 'check-circle', error: 'error', warning: 'alert', info: 'info', notFound: 'search' }[p.kind] || 'info';
    fill(el, c.h('span', { class: 'ui-result-icon', 'aria-hidden': 'true' }, c.icon(icon)), heading, message ? c.h('p', { class: 'ui-result-message' }, message) : null, p.details || null, acts.childNodes.length ? acts : null);
    if (p.focus) c.win.requestAnimationFrame(() => heading.focus({ preventScroll: true }));
  }
  c.cleanup(() => { for (const b of buttons) b.destroy(); });
  render();
  container.append(el);
  return { root: el, update(n) { p = { ...p, ...n }; render(); }, focus: () => el.querySelector('.ui-result-title')?.focus(), destroy: () => c.destroy() };
}

// ---------------------------------------------------------------- split pane
/**
 * createSplitPane(container, { orientation: 'horizontal'|'vertical', size = 40 (% of the first pane), min = 15, max = 85, label,
 *   stackBelow = 40 (rem; side by side only above this width), onResize({ size }) }, services) → { root, start, end, setSize }
 * A resizable separator (role=separator with a value): drag, or ← → / ↑ ↓ in 2 % steps, Home / End, Enter restores the
 * initial size. Below `stackBelow` the panes stack and the separator hides.
 */
export function createSplitPane(container, props = {}, services) {
  const c = setup(container, services, 'split-pane'); plusStrings(c.s);
  let p = { orientation: 'horizontal', size: 40, min: 15, max: 85, stackBelow: 40, ...props };
  const initial = p.size;
  const start = c.h('div', { class: 'ui-pane' }), end = c.h('div', { class: 'ui-pane' });
  const sep = c.h('div', { class: 'ui-pane-sep', role: 'separator', tabindex: '0', 'aria-valuemin': String(p.min), 'aria-valuemax': String(p.max) });
  const el = c.own(c.h('div', { class: 'ui-split-pane' }, start, sep, end));
  let dragging = null;
  function render() {
    el.dataset.orientation = p.orientation;
    el.style.setProperty('--ui-split', `${p.size}%`);
    sep.setAttribute('aria-orientation', p.orientation === 'horizontal' ? 'vertical' : 'horizontal');
    sep.setAttribute('aria-valuenow', String(Math.round(p.size)));
    sep.setAttribute('aria-label', p.label || c.s.t('pane.resize'));
  }
  function setSize(v, emit = true) { p.size = clamp(v, p.min, p.max); render(); if (emit) c.emit(el, 'resize', { size: p.size }, p.onResize); }
  c.on(sep, 'keydown', e => {
    const horiz = p.orientation === 'horizontal', rtl = rtlOf(el);
    const d = horiz ? { ArrowRight: rtl ? -2 : 2, ArrowLeft: rtl ? 2 : -2 }[e.key] : { ArrowDown: 2, ArrowUp: -2 }[e.key];
    if (d) { e.preventDefault(); setSize(p.size + d); }
    else if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); setSize(e.key === 'Home' ? p.min : p.max); }
    else if (e.key === 'Enter') { e.preventDefault(); setSize(initial); }
  });
  c.on(sep, 'pointerdown', e => { if (e.button) return; dragging = e.pointerId; try { sep.setPointerCapture(e.pointerId); } catch { /* synthetic */ } e.preventDefault(); });
  c.on(sep, 'pointermove', e => {
    if (dragging !== e.pointerId) return;
    const r = el.getBoundingClientRect(), horiz = p.orientation === 'horizontal';
    let frac = horiz ? (e.clientX - r.left) / r.width : (e.clientY - r.top) / r.height;
    if (horiz && rtlOf(el)) frac = 1 - frac;
    setSize(frac * 100);
  });
  for (const t of ['pointerup', 'pointercancel']) c.on(sep, t, () => { dragging = null; });
  const ro = new c.win.ResizeObserver(() => { const rem = parseFloat(c.win.getComputedStyle(c.doc.documentElement).fontSize) || 16; el.toggleAttribute('data-stacked', el.clientWidth < p.stackBelow * rem); });
  ro.observe(el); c.cleanup(() => ro.disconnect());
  render();
  container.append(el);
  return { root: el, start, end, get size() { return p.size; }, setSize, update(n) { p = { ...p, ...n }; render(); }, focus: () => sep.focus(), destroy: () => c.destroy() };
}

// ---------------------------------------------------------------- code, kbd, highlight
/** kbd('mod+k', { doc, then }) — key caps for a shortcut, in the platform's names; a sequence 'g i' reads "G then I". */
export function kbd(spec, o = {}) {
  const d = o.doc || globalThis.document;
  const step = x => { const text = formatStep(x), parts = isMac() ? [text] : text.split('+'); return parts.map((k, i) => [i ? h(d, 'span', { class: 'ui-kbd-plus', 'aria-hidden': 'true' }, '+') : null, h(d, 'kbd', { class: 'ui-kbd' }, k)]); };
  return h(d, 'span', { class: 'ui-kbd-group' }, stepsOf(spec).map((x, i) => [i ? h(d, 'span', { class: 'ui-kbd-then' }, ` ${o.then || 'then'} `) : null, step(x)]));
}
/** highlight(text, query, { doc }) — the text with case-insensitive matches of each query word wrapped in <mark>. */
export function highlight(text, query, o = {}) {
  const d = o.doc || globalThis.document, el = h(d, 'span', { class: 'ui-highlight' });
  const words = String(query || '').trim().split(/\s+/).filter(Boolean).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!words.length) { el.textContent = text; return el; }
  const split = new RegExp(`(${words.join('|')})`, 'gi'), whole = new RegExp(`^(?:${words.join('|')})$`, 'i');
  for (const part of String(text).split(split)) if (part) el.append(whole.test(part) ? h(d, 'mark', {}, part) : d.createTextNode(part));
  return el;
}
/** createCodeBlock(container, { code, label, language, copy = true, wrap }, services) — preformatted code with a copy button. */
export function createCodeBlock(container, props = {}, services) {
  const c = setup(container, services, 'code'); plusStrings(c.s);
  let p = { copy: true, ...props };
  const pre = c.h('pre', { class: 'ui-code', tabindex: '0' });
  const btn = c.h('button', { type: 'button', class: 'ui-button ui-code-copy', 'data-variant': 'ghost', 'data-icon-only': '' }, c.icon('copy'));
  const el = c.own(c.h('figure', { class: 'ui-code-block' }, pre, btn));
  function render() { fill(pre, c.h('code', { 'data-language': p.language || null }, p.code ?? '')); pre.setAttribute('aria-label', p.label || p.language || c.s.t('code.label')); pre.toggleAttribute('data-wrap', !!p.wrap); btn.hidden = !p.copy; btn.setAttribute('aria-label', c.s.t('copy')); }
  c.on(btn, 'click', async () => { try { await c.win.navigator.clipboard.writeText(p.code ?? ''); c.s.announce(c.s.t('copied')); btn.dataset.done = ''; c.win.setTimeout(() => delete btn.dataset.done, 1500); } catch { const r = c.doc.createRange(); r.selectNodeContents(pre); const sel = c.win.getSelection(); sel.removeAllRanges(); sel.addRange(r); } });
  render();
  container.append(el);
  return { root: el, update(n) { p = { ...p, ...n }; render(); }, destroy: () => c.destroy() };
}

// ---------------------------------------------------------------- media viewer
/**
 * createMediaViewer({ items: [{ src, alt, caption, type: 'image'|'video', poster }], label }, services) → { open(index), close(), get index, destroy }
 * A modal viewer: ← → (mirrored in RTL) and swipe move, Escape closes, focus returns to what opened it. Neighbours are
 * preloaded. Videos get native controls; images need alt text from the host.
 */
export function createMediaViewer(props = {}, services) {
  const s = plusStrings(services || getServices());
  const c = setup(s.overlays.portal, s, 'media');
  let p = { items: [], ...props }, index = 0, handle = null, swipe = null;
  const stage = c.h('div', { class: 'ui-media-stage' });
  const caption = c.h('p', { class: 'ui-media-caption' }), counter = c.h('span', { class: 'ui-media-counter', 'aria-live': 'polite' });
  const prev = c.h('button', { type: 'button', class: 'ui-button ui-media-nav', 'data-variant': 'ghost', 'data-icon-only': '' }, c.icon('chevron-left'));
  const next = c.h('button', { type: 'button', class: 'ui-button ui-media-nav', 'data-variant': 'ghost', 'data-icon-only': '' }, c.icon('chevron-right'));
  const close = c.h('button', { type: 'button', class: 'ui-button ui-media-close', 'data-variant': 'ghost', 'data-icon-only': '' }, c.icon('close'));
  const panel = c.h('div', { class: 'ui-media', role: 'dialog', 'aria-modal': 'true' }, c.h('div', { class: 'ui-media-bar' }, counter, close), c.h('div', { class: 'ui-media-main' }, prev, stage, next), caption);
  const layer = c.h('div', { class: 'ui-media-layer', hidden: true }, panel);
  s.overlays.portal.append(layer);
  const node = it => (it.type === 'video' ? c.h('video', { src: it.src, poster: it.poster || null, controls: true, preload: 'metadata' }) : c.h('img', { src: it.src, alt: it.alt ?? '', decoding: 'async' }));
  function render() {
    const n = p.items.length, it = p.items[index];
    if (!it) return;
    fill(stage, node(it));
    caption.textContent = it.caption || ''; caption.hidden = !it.caption;
    counter.textContent = c.s.t('media.counter', { n: c.s.format.number(index + 1), count: c.s.format.number(n) });
    panel.setAttribute('aria-label', p.label || it.caption || it.alt || '');
    prev.setAttribute('aria-label', c.s.t('media.previous')); next.setAttribute('aria-label', c.s.t('media.next')); close.setAttribute('aria-label', c.s.t('close'));
    prev.disabled = index === 0; next.disabled = index === n - 1; prev.hidden = next.hidden = n < 2;
    for (const k of [index - 1, index + 1]) { const nb = p.items[k]; if (nb && nb.type !== 'video') { const im = new c.win.Image(); im.src = nb.src; } }
  }
  function go(d) { const i = clamp(index + d, 0, p.items.length - 1); if (i === index) return; index = i; render(); s.motion.animate(stage, { o: 1 }, { role: 'view', from: { o: 0 } }); }
  c.on(prev, 'click', () => go(-1)); c.on(next, 'click', () => go(1)); c.on(close, 'click', () => api.close());
  c.on(panel, 'keydown', e => { const rtl = rtlOf(panel), d = { ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1 }[e.key]; if (d && !(e.target instanceof c.win.HTMLVideoElement)) { e.preventDefault(); go(d); } });
  c.on(stage, 'pointerdown', e => { swipe = { x: e.clientX, id: e.pointerId }; });
  c.on(stage, 'pointerup', e => { if (!swipe || swipe.id !== e.pointerId) return; const dx = e.clientX - swipe.x; swipe = null; if (Math.abs(dx) > 50) go((dx < 0 ? 1 : -1) * (rtlOf(panel) ? -1 : 1)); });
  c.on(layer, 'click', e => { if (e.target === layer) api.close(); });
  const api = {
    get index() { return index; }, get isOpen() { return !!handle; },
    open(i = 0) { index = clamp(i, 0, p.items.length - 1); render(); handle = s.overlays.open(layer, { kind: 'dialog', modal: true, initialFocus: close, onDismiss: () => api.close() }); s.motion.animate(layer, { o: 1 }, { role: 'enter', from: { o: 0 } }); },
    close() { if (!handle) return; const h2 = handle; handle = null; h2.close(); layer.hidden = true; fill(stage); },
    update(n) { p = { ...p, ...n }; if (handle) render(); },
    destroy() { api.close(); layer.remove(); c.destroy(); },
  };
  return api;
}

// ---------------------------------------------------------------- editable cell
/**
 * editableCell({ value, label, type: 'text'|'number'|'select', options, format(v), validate(v) → message, onCommit(v) → Promise | void, services, doc })
 * Content for a table cell (column.cell): shows the value with an edit affordance; Enter / click edits; Enter saves,
 * Escape cancels, focus returns to the cell. While saving the editor is busy; a rejection keeps the editor open with
 * the message. Built from public pieces only, so it works in any cell.
 */
export function editableCell(o) {
  const s = plusStrings(o.services || getServices());
  const d = o.doc || s.overlays.portal.ownerDocument;
  let value = o.value;
  const fmt = v => (o.format ? o.format(v) : v == null || v === '' ? '—' : String(v));
  const view = h(d, 'button', { type: 'button', class: 'ui-cell-edit' }, h(d, 'span', {}, fmt(value)), h(d, 'span', { class: 'ui-cell-edit-icon', 'aria-hidden': 'true' }, '✎'));
  const wrap = h(d, 'span', { class: 'ui-cell-editable' }, view);
  const sync = () => { view.firstChild.textContent = fmt(value); view.setAttribute('aria-label', `${s.t('cell.edit', { column: o.label || '' })}: ${fmt(value)}`); };
  sync();
  view.addEventListener('click', () => {
    const input = o.type === 'select' ? h(d, 'select', {}, (o.options || []).map(op => h(d, 'option', { value: String(op.value), selected: String(op.value) === String(value) || null }, op.label))) : h(d, 'input', { type: o.type === 'number' ? 'number' : 'text', value: value ?? '' });
    input.setAttribute('aria-label', o.label || '');
    const err = h(d, 'span', { class: 'ui-cell-error', role: 'alert' });
    const box = h(d, 'span', { class: 'ui-cell-editor ui-input' }, input);
    wrap.replaceChildren(box, err);
    input.focus(); input.select?.();
    let busy = false;
    const finish = () => { wrap.replaceChildren(view); sync(); view.focus(); };
    const commit = async () => {
      if (busy) return;
      const raw = o.type === 'number' ? (input.value === '' ? null : Number(input.value)) : input.value;
      const msg = o.validate?.(raw);
      if (msg) { err.textContent = msg; input.setAttribute('aria-invalid', 'true'); return; }
      if (raw === value) return finish();
      busy = true; input.disabled = true; box.setAttribute('aria-busy', 'true'); box.append(h(d, 'span', { class: 'ui-spinner', 'aria-hidden': 'true' }));
      try { await o.onCommit?.(raw); value = raw; finish(); }
      catch (e) { busy = false; input.disabled = false; box.removeAttribute('aria-busy'); box.querySelector('.ui-spinner')?.remove(); err.textContent = e?.message || s.t('action.failed'); input.setAttribute('aria-invalid', 'true'); input.focus(); }
    };
    input.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); commit(); } else if (e.key === 'Escape') { e.preventDefault(); if (!busy) finish(); } });
    input.addEventListener('blur', () => { if (!busy && wrap.contains(input)) commit(); });
  });
  return wrap;
}

