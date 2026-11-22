import { setup, fill, uid } from './base.js';
import { createRovingFocus } from '../interaction.js';

/**
 * createTree(container, { items: [{ id, label, description, icon, badge, disabled, children, hasChildren, loading,
 *   loadError }], expanded: id[], value, label, selection: 'single'|'multiple'|'checkbox', disabled, readOnly,
 *   onSelect({ id, item }), onChange({ value, id, item }), onToggle({ id, open, item }), onRetry({ id, item }) }, services)
 * → { root, value, expanded, expand(id, open), focus(id), update, destroy }
 * APG tree view: one tab stop; ↑ ↓ move through visible items; → opens an item or moves to its first child; ← closes
 * it or moves to the parent (both mirrored in RTL); Home / End; typeahead; * opens all siblings. Groups open and
 * close with the expand role.
 * Since 2.3.0 (G30):
 * - selection 'single' (the default): Enter, Space or a click selects one item (onSelect). 'multiple'
 *   (aria-multiselectable): Enter, Space or a click toggles an item, Shift+↑ / ↓ moves and toggles, Shift+Space adds
 *   the items from the last one toggled, Ctrl+A selects every item; onChange reports the ids. 'checkbox': a check per
 *   item; checking a parent checks every enabled item below it, a parent shows mixed while only some are checked, and
 *   `value` lists every fully checked item, parents included (a parent in `value` checks everything below it).
 * - lazy children: an item with `hasChildren` and no `children` array shows "Loading…" when opened (onToggle tells
 *   the host to load); `loading` shows it again while reloading; `loadError` (a message, or true) shows it with Retry
 *   (onRetry); an empty `children` array shows "No items". The host passes the children with update({ items }); open
 *   items, checks and focus survive the update, and focus on "Loading…" moves to the first child.
 * - `description` adds a second line, read as the item's description; `disabled` turns selection and checks off and
 *   `readOnly` keeps them as they are, while items still open, close and take focus; focus(id) opens the items above
 *   `id` and moves focus to it.
 */
export function createTree(container, props = {}, services) {
  const c = setup(container, services, 'tree');
  let p = { items: [], selection: 'single', ...props };
  let open = new Set(p.expanded || []);
  const el = c.own(c.h('ul', { class: 'ui-tree', role: 'tree' }));
  const byId = new Map();
  let roving = null, anchor = null;
  // 'multiple': the selected ids. 'checkbox': the checked items that have no children loaded (a parent's state follows).
  let picked = new Set();
  const mode = () => (p.selection === 'multiple' || p.selection === 'checkbox' ? p.selection : 'single');
  const kidsOf = it => (Array.isArray(it.children) && it.children.length ? it.children : null);
  const opens = it => !!(kidsOf(it) || it.hasChildren);
  const statusOf = it => (it.loadError ? 'error' : it.loading || (it.hasChildren && !Array.isArray(it.children)) ? 'loading' : it.hasChildren && !kidsOf(it) ? 'empty' : null);
  const locked = () => !!(p.disabled || p.readOnly);
  const leaves = it => (kidsOf(it) ? it.children.flatMap(leaves) : [it]);
  function checkState(it) {
    if (!kidsOf(it)) return picked.has(it.id) ? 'true' : 'false';
    const s = new Set(it.children.map(checkState));
    return s.size === 1 ? [...s][0] : 'mixed';
  }
  function walk(list, fn) { for (const it of list) { fn(it); if (kidsOf(it)) walk(it.children, fn); } }
  function index() { byId.clear(); const at = (list, parent) => { for (const it of list) { byId.set(it.id, { it, parent }); if (kidsOf(it)) at(it.children, it.id); } }; at(p.items, null); }
  // Takes the host's `value` into `picked`; render() expands a checked parent into the items below it.
  const adopt = value => { picked = new Set(mode() === 'single' ? [] : Array.isArray(value) ? value : value != null ? [value] : []); };
  function currentValue() {
    if (mode() === 'single') return p.value;
    const out = [], seen = new Set();
    walk(p.items, it => { seen.add(it.id); if (mode() === 'checkbox' ? checkState(it) === 'true' : picked.has(it.id)) out.push(it.id); });
    for (const id of picked) if (!seen.has(id)) out.push(id); // ids the host passed for items not loaded yet
    return out;
  }
  function node(it, level, pos, size, parent) {
    const kids = kidsOf(it), st = opens(it) ? statusOf(it) : null, m = mode();
    // read once, as the description: kept out of the item's name, which is computed from its text
    const desc = it.description ? c.h('span', { class: 'ui-tree-desc', id: uid('trd'), 'aria-hidden': 'true' }, it.description) : null;
    const li = c.h('li', {
      role: 'treeitem', class: 'ui-tree-item', 'aria-level': String(level), 'aria-setsize': String(size), 'aria-posinset': String(pos),
      'aria-selected': m === 'checkbox' ? null : String(m === 'single' ? it.id === p.value : picked.has(it.id)),
      'aria-checked': m === 'checkbox' ? checkState(it) : null,
      'aria-expanded': opens(it) ? String(open.has(it.id)) : null, 'aria-disabled': it.disabled ? 'true' : null,
      'aria-describedby': desc?.id ?? null, 'aria-busy': st === 'loading' && open.has(it.id) ? 'true' : null, tabindex: '-1',
    },
      c.h('div', { class: 'ui-tree-row', style: `--ui-depth:${level - 1}` },
        c.h('span', { class: 'ui-tree-toggle', 'aria-hidden': 'true' }, opens(it) ? c.icon('chevron-right') : null),
        m === 'checkbox' ? c.h('span', { class: 'ui-tree-check', 'aria-hidden': 'true' }) : null, // drawn like the kit's checkbox
        it.icon ? c.icon(it.icon) : null,
        c.h('span', { class: 'ui-tree-text' }, c.h('span', { class: 'ui-tree-label' }, it.label), desc),
        it.badge != null ? c.h('span', { class: 'ui-badge', 'data-tone': 'neutral' }, typeof it.badge === 'number' ? c.s.format.number(it.badge) : it.badge) : null));
    li._id = it.id;
    if (opens(it)) {
      const group = c.h('ul', { role: 'group', hidden: !open.has(it.id) });
      if (st) group.append(statusRow(it, st, level + 1));
      else kids.forEach((k, i) => group.append(node(k, level + 1, i + 1, kids.length, it.id)));
      li.append(group);
    }
    return li;
  }
  // Loading, empty and error rows are items of their own, so the arrows reach them and screen readers say them.
  function statusRow(it, st, level) {
    const text = st === 'loading' ? c.s.t('loading') : st === 'empty' ? c.s.t('tree.empty') : typeof it.loadError === 'string' ? it.loadError : c.s.t('error.load');
    const li = c.h('li', { role: 'treeitem', class: 'ui-tree-item ui-tree-status', 'data-status': st, 'aria-level': String(level), 'aria-setsize': '1', 'aria-posinset': '1', tabindex: '-1' },
      c.h('div', { class: 'ui-tree-row', style: `--ui-depth:${level - 1}` },
        c.h('span', { class: 'ui-tree-toggle', 'aria-hidden': 'true' }, st === 'loading' ? c.h('span', { class: 'ui-spinner' }) : null),
        c.h('span', { class: 'ui-tree-label' }, text),
        st === 'error' ? c.h('span', { class: 'ui-tree-retry' }, c.s.t('retry')) : null));
    li._status = st; li._parent = it.id;
    return li;
  }
  const items = () => [...el.querySelectorAll('[role="treeitem"]')];
  const visible = () => items().filter(li => !li.parentElement.closest('[role="group"][hidden]'));
  const liOf = id => items().find(li => li._id === id);
  function render() {
    const had = el.contains(c.doc.activeElement) ? c.doc.activeElement.closest('[role="treeitem"]') : null;
    const ups = []; // the focused item's ancestors, nearest first, from the items before this render
    if (had) for (let n = had._status ? had._parent : byId.get(had._id)?.parent; n != null; n = byId.get(n)?.parent) ups.push(n);
    index();
    // A checked parent stands for every item below it: from the host's value, or when its children arrive.
    if (mode() === 'checkbox') { const keep = picked; picked = new Set(); for (const id of keep) { const n = byId.get(id); if (n) for (const l of leaves(n.it)) picked.add(l.id); else picked.add(id); } }
    if (p.label) el.setAttribute('aria-label', p.label); else el.removeAttribute('aria-label');
    if (mode() === 'multiple') el.setAttribute('aria-multiselectable', 'true'); else el.removeAttribute('aria-multiselectable');
    if (p.disabled) el.setAttribute('aria-disabled', 'true'); else el.removeAttribute('aria-disabled');
    el.toggleAttribute('data-readonly', !!p.readOnly && !p.disabled);
    fill(el, p.items.map((it, i) => node(it, 1, i + 1, p.items.length, null)));
    roving?.destroy();
    roving = createRovingFocus(el, { items: visible, orientation: 'vertical', loop: false, typeahead: true, getLabel: li => (li._id != null ? byId.get(li._id).it.label : li.textContent), onMove: (li, i, e) => { if (mode() === 'multiple' && e?.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) toggle(li); } });
    if (had) {
      // Focus stays on the same item, or its nearest shown ancestor when it went away or closed; on "Loading…" it
      // moves to the first child once the children arrive.
      const shown = li => !!li && !li.parentElement.closest('[role="group"][hidden]');
      let to = had._status ? liOf(had._parent)?.querySelector(':scope > [role="group"] > [role="treeitem"]') : liOf(had._id);
      for (const id of ups) { if (shown(to)) break; to = liOf(id); }
      roving.focus(shown(to) ? to : visible()[0]);
    }
  }
  function setOpen(li, want) {
    const g = li.querySelector(':scope > [role="group"]');
    if (!g || (li.getAttribute('aria-expanded') === 'true') === want) return;
    li.setAttribute('aria-expanded', String(want));
    const it = byId.get(li._id).it;
    if (want) {
      open.add(li._id); g.hidden = false; c.s.motion.animate(g, { h: g.scrollHeight, o: 1 }, { role: 'expand', from: { h: 0, o: 0 }, autoHeight: true });
      if (statusOf(it) === 'loading') li.setAttribute('aria-busy', 'true');
    } else {
      open.delete(li._id); li.removeAttribute('aria-busy');
      c.s.motion.animate(g, { h: 0, o: 0 }, { role: 'expand', from: { h: g.offsetHeight } }).then(ok => { if (ok && !open.has(li._id)) { g.hidden = true; c.s.motion.reset(g); g.style.height = ''; } });
    }
    c.emit(el, 'toggle', { id: li._id, open: want, item: it }, p.onToggle);
  }
  const usable = li => li && li._id != null && li.getAttribute('aria-disabled') !== 'true' && !locked();
  function changed(li) { c.emit(el, 'change', { value: currentValue(), id: li?._id ?? null, item: li ? byId.get(li._id).it : null }, p.onChange); }
  function paint() {
    for (const li of items()) {
      if (li._id == null) continue;
      if (mode() === 'checkbox') li.setAttribute('aria-checked', checkState(byId.get(li._id).it));
      else li.setAttribute('aria-selected', String(mode() === 'single' ? li._id === p.value : picked.has(li._id)));
    }
  }
  function select(li) {
    if (!usable(li)) return;
    if (p.value !== li._id) { p.value = li._id; paint(); }
    c.emit(el, 'select', { id: li._id, item: byId.get(li._id).it }, p.onSelect);
  }
  function toggle(li) {
    if (!usable(li)) return;
    const it = byId.get(li._id).it;
    if (mode() === 'checkbox') {
      // a parent toggles its enabled items: all on unless all are on already
      const mine = leaves(it).filter(l => !l.disabled), on = !mine.every(l => picked.has(l.id));
      for (const l of mine) { if (on) picked.add(l.id); else picked.delete(l.id); }
    } else if (picked.has(li._id)) picked.delete(li._id); else picked.add(li._id);
    anchor = li._id;
    paint(); changed(li);
  }
  function activate(li) {
    if (li?._status === 'error') { const it = byId.get(li._parent)?.it; if (it) c.emit(el, 'retry', { id: li._parent, item: it }, p.onRetry); return; }
    if (mode() === 'single') select(li); else toggle(li);
  }
  function selectRange(li) {
    if (!usable(li)) return;
    const vis = visible().filter(x => x._id != null), a = vis.findIndex(x => x._id === anchor), b = vis.indexOf(li);
    if (a < 0) { toggle(li); return; }
    for (const x of vis.slice(Math.min(a, b), Math.max(a, b) + 1)) if (usable(x)) picked.add(x._id);
    paint(); changed(li);
  }
  c.on(el, 'keydown', e => {
    const li = e.target.closest?.('[role="treeitem"]'); if (!li || e.target !== li) return;
    const rtl = c.win.getComputedStyle(el).direction === 'rtl';
    const into = rtl ? 'ArrowLeft' : 'ArrowRight', out = rtl ? 'ArrowRight' : 'ArrowLeft';
    const isOpen = li.getAttribute('aria-expanded') === 'true', hasKids = li.hasAttribute('aria-expanded');
    if (e.key === into) { e.preventDefault(); if (hasKids && !isOpen) setOpen(li, true); else if (isOpen) roving.focus(li.querySelector('[role="group"] > [role="treeitem"]')); }
    else if (e.key === out) { e.preventDefault(); if (isOpen) setOpen(li, false); else { const parent = li.parentElement.closest('[role="treeitem"]'); if (parent) roving.focus(parent); } }
    else if (e.key === ' ' && e.shiftKey && mode() === 'multiple') { e.preventDefault(); selectRange(li); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(li); }
    else if (e.key === '*') { e.preventDefault(); for (const sib of li.parentElement.children) setOpen(sib, true); }
    else if (mode() === 'multiple' && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      if (locked()) return;
      walk(p.items, it => { if (!it.disabled) picked.add(it.id); });
      paint(); changed(null);
    }
  });
  c.on(el, 'click', e => {
    const li = e.target.closest('[role="treeitem"]'); if (!li) return;
    e.stopPropagation(); // nested items: handle the innermost only
    if (li._status) activate(li);
    else if (e.target.closest('.ui-tree-toggle')) setOpen(li, li.getAttribute('aria-expanded') !== 'true');
    else if (mode() === 'single') { select(li); if (li.hasAttribute('aria-expanded') && li.getAttribute('aria-expanded') !== 'true') setOpen(li, true); }
    else activate(li);
    if (li.getAttribute('aria-disabled') !== 'true') roving.focus(li);
  });
  c.cleanup(() => roving?.destroy());
  adopt(p.value);
  render();
  container.append(el);
  return {
    root: el, get value() { return currentValue(); }, get expanded() { return [...open]; },
    expand: (id, want = true) => { const li = liOf(id); if (li) setOpen(li, want); },
    /** Moves focus to an item, opening the items above it; with no id, to the tree's tab stop. */
    focus(id) {
      if (id == null) { roving?.focus(); return; }
      const chain = []; for (let n = byId.get(id)?.parent; n != null; n = byId.get(n)?.parent) chain.unshift(n);
      for (const a of chain) { const li = liOf(a); if (li) setOpen(li, true); }
      const li = liOf(id); if (li) roving.focus(li);
    },
    update(n) {
      p = { ...p, ...n };
      if ('expanded' in n) open = new Set(n.expanded || []);
      if ('value' in n || 'selection' in n) adopt(p.value);
      render();
    },
    destroy: () => c.destroy(),
  };
}
