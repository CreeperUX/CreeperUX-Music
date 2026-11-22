import { setup, fill, h as hDoc, uid, safeHref } from './base.js';
import { createButton } from './controls.js';
import { icon as iconOf } from '../icons.js';
import { getServices } from '../services.js';
import { watchCut } from './tips.js';

// M4 data display: small node factories for table cells and lists (no lifecycle), and handles for the larger pieces.
// Values are formatted by the host or through services.format; nothing here assumes a domain (D22, D30).

const docOf = o => o?.doc || globalThis.document;
const TONES = new Set(['neutral', 'info', 'good', 'warn', 'bad', 'accent']);
const tone = t => (TONES.has(t) ? t : 'neutral');

// ---------------------------------------------------------------- node factories
/** badge(value, { tone, label, doc }) — a count or short code. Numbers should be formatted by the caller. */
export function badge(value, o = {}) {
  return hDoc(docOf(o), 'span', { class: 'ui-badge', 'data-tone': tone(o.tone), 'aria-label': o.label || null }, value);
}
/** statusLabel(label, tone, { doc }) — a coloured dot plus text; the text carries the meaning (never colour alone). */
export function statusLabel(label, t, o = {}) {
  const d = docOf(o);
  return hDoc(d, 'span', { class: 'ui-status', 'data-tone': tone(t) }, hDoc(d, 'span', { class: 'ui-status-dot', 'aria-hidden': 'true' }), hDoc(d, 'span', {}, label));
}
/** tag(label, { tone, onRemove, removeLabel, doc }) — a chip; with onRemove it has a remove button. */
export function tag(label, o = {}) {
  const d = docOf(o);
  const el = hDoc(d, 'span', { class: 'ui-tag', 'data-tone': tone(o.tone) }, hDoc(d, 'span', { class: 'ui-tag-label' }, label));
  if (o.onRemove) {
    const b = hDoc(d, 'button', { type: 'button', class: 'ui-tag-remove', 'aria-label': o.removeLabel || (o.services || getServices(d)).t('tag.remove', { label }) }, iconOf('close', { doc: d }));
    b.addEventListener('click', e => o.onRemove(e));
    el.append(b);
  }
  return el;
}
/**
 * truncate(text, { lines = 1, doc }) — clips with an ellipsis; the full text stays in the accessibility tree. Cut-off text
 * shows in full in a tooltip on hover, keyboard focus and tap, and becomes a Tab stop while it is cut off (G22); the
 * `title` stays as the fallback where the kit's tooltip is off.
 */
export function truncate(text, o = {}) {
  return watchCut(hDoc(docOf(o), 'span', { class: 'ui-truncate', title: text, style: o.lines > 1 ? `-webkit-line-clamp:${o.lines}` : null, 'data-lines': o.lines > 1 ? '' : null }, text));
}
/** twoLine(primary, secondary, { doc }) — a primary value with a quieter second line (e.g. name and email in a cell). */
export function twoLine(primary, secondary, o = {}) {
  const d = docOf(o);
  return hDoc(d, 'span', { class: 'ui-two-line' }, primary, secondary != null ? hDoc(d, 'small', {}, secondary) : null);
}
/** sparkline(values, { label, doc }) — a small trend line. Decorative unless a label (text summary) is given. */
export function sparkline(values, o = {}) {
  const d = docOf(o), ns = 'http://www.w3.org/2000/svg';
  const s = d.createElementNS(ns, 'svg');
  s.setAttribute('class', 'ui-sparkline'); s.setAttribute('viewBox', '0 0 100 24'); s.setAttribute('preserveAspectRatio', 'none');
  if (o.label) { s.setAttribute('role', 'img'); s.setAttribute('aria-label', o.label); } else s.setAttribute('aria-hidden', 'true');
  const v = (values || []).filter(Number.isFinite);
  if (v.length > 1) {
    const lo = Math.min(...v), hi = Math.max(...v), sp = hi - lo || 1;
    const pts = v.map((x, i) => `${((i / (v.length - 1)) * 100).toFixed(2)},${(22 - ((x - lo) / sp) * 20).toFixed(2)}`).join(' ');
    const area = d.createElementNS(ns, 'polygon'); area.setAttribute('points', `0,24 ${pts} 100,24`); area.setAttribute('class', 'ui-sparkline-area');
    const line = d.createElementNS(ns, 'polyline'); line.setAttribute('points', pts); line.setAttribute('vector-effect', 'non-scaling-stroke');
    s.append(area, line);
  }
  return s;
}

// ---------------------------------------------------------------- shared relative-time ticker (one timer per services)
const tickers = new WeakMap();
function tick(s, fn) {
  let t = tickers.get(s);
  if (!t) {
    const win = s.overlays.portal.ownerDocument.defaultView;
    t = { fns: new Set(), id: 0 };
    t.start = () => { if (!t.id) t.id = win.setInterval(() => { for (const f of t.fns) f(); }, 30000); };
    t.stop = () => { if (t.id && !t.fns.size) { win.clearInterval(t.id); t.id = 0; } };
    tickers.set(s, t);
  }
  t.fns.add(fn); t.start();
  return () => { t.fns.delete(fn); t.stop(); };
}
const toDate = v => (v instanceof Date ? v : new Date(v));

/** createRelativeTime(container, { value, now }, services) — <time> with "3 minutes ago", the absolute date as title; updates every 30 s. */
export function createRelativeTime(container, props = {}, services) {
  const c = setup(container, services, 'relative-time');
  let p = { ...props };
  const el = c.own(c.h('time', { class: 'ui-time' }));
  const render = () => {
    if (p.value == null) { el.textContent = '—'; el.removeAttribute('datetime'); return; }
    const d = toDate(p.value);
    el.dateTime = d.toISOString(); el.title = c.s.format.dateTime(d);
    el.textContent = c.s.format.relative(d, p.now ?? Date.now());
  };
  c.cleanup(tick(c.s, render));
  render();
  container.append(el);
  return { root: el, update(n) { p = { ...p, ...n }; render(); }, destroy: () => c.destroy() };
}

// ---------------------------------------------------------------- page header, panel, disclosure, accordion
/** createPageHeader(container, { title, description, eyebrow, lead, actions: Node[] | (slot) => void, level = 1 }) */
export function createPageHeader(container, props = {}, services) {
  const c = setup(container, services, 'page-header');
  let p = { level: 1, ...props };
  const title = c.h(`h${p.level}`, { class: 'ui-page-title', tabindex: '-1' });
  const desc = c.h('p', { class: 'ui-page-desc' }), eyebrow = c.h('div', { class: 'ui-eyebrow' });
  const lead = c.h('div', { class: 'ui-page-lead' }), actions = c.h('div', { class: 'ui-page-actions' });
  const el = c.own(c.h('header', { class: 'ui-page-header' }, lead, c.h('div', { class: 'ui-page-heading' }, eyebrow, title, desc), actions));
  let built = false;
  function render() {
    title.textContent = p.title || '';
    fill(desc, p.description); desc.hidden = !p.description;
    eyebrow.textContent = p.eyebrow || ''; eyebrow.hidden = !p.eyebrow;
    fill(lead, p.lead); lead.hidden = !p.lead;
    if (!built || Array.isArray(p.actions) || p.actions?.nodeType) { if (typeof p.actions === 'function') p.actions(actions); else fill(actions, p.actions); built = true; }
    actions.hidden = !actions.childNodes.length;
  }
  render();
  container.append(el);
  return { root: el, actions, heading: title, update(n) { p = { ...p, ...n }; render(); }, focus: () => title.focus({ preventScroll: true }), destroy: () => c.destroy() };
}

/**
 * createCard(container, { title, description, meta, media: { src, alt } | Node, href | onClick, selectable, selected,
 *   onSelectChange({ selected }), actions: [{ id, label, icon, variant, onClick }], level = 3, disabled }, services)
 * A card (G35). With `href` or `onClick` the whole card acts: its title is the one link or button, and that control's
 * click area covers the card (the block-link pattern), so the accessible name stays the title and nothing interactive
 * is nested. The selection checkbox and the actions sit above that area and keep their own clicks. Lay cards out in a
 * container with the class `ui-card-grid`.
 */
export function createCard(container, props = {}, services) {
  const c = setup(container, services, 'card');
  let p = { level: 3, ...props };
  const media = c.h('div', { class: 'ui-card-media' });
  const heading = c.h(`h${p.level}`, { class: 'ui-card-title', id: uid('crd') });
  const meta = c.h('p', { class: 'ui-card-meta' }), desc = c.h('p', { class: 'ui-card-desc' });
  const check = c.h('input', { type: 'checkbox', class: 'ui-card-check' });
  const checkBox = c.h('label', { class: 'ui-check ui-check-bare ui-card-select' }, check);
  const acts = c.h('div', { class: 'ui-card-actions' });
  const el = c.own(c.h('article', { class: 'ui-card' }, media, c.h('div', { class: 'ui-card-body' }, heading, meta, desc), acts, checkBox));
  let buttons = [];
  function render() {
    const off = !!p.disabled;
    el.setAttribute('aria-labelledby', heading.id);
    el.toggleAttribute('data-disabled', off);
    const href = off ? null : safeHref(p.href);
    // the one control of a card that acts; its ::after covers the card (ui.css)
    const main = href ? c.h('a', { class: 'ui-card-link', href }, p.title ?? '')
      : p.onClick ? c.h('button', { type: 'button', class: 'ui-card-link', disabled: off || null }, p.title ?? '')
      : c.h('span', {}, p.title ?? '');
    fill(heading, main);
    el.toggleAttribute('data-action', !!(href || (p.onClick && !off)));
    if (p.media?.nodeType) fill(media, p.media); else if (p.media?.src) fill(media, c.h('img', { src: p.media.src, alt: p.media.alt ?? '', loading: 'lazy' })); else fill(media);
    media.hidden = !media.childNodes.length;
    meta.textContent = p.meta ?? ''; meta.hidden = !p.meta;
    desc.textContent = p.description ?? ''; desc.hidden = !p.description;
    checkBox.hidden = !p.selectable;
    check.checked = !!p.selected; check.disabled = off;
    check.setAttribute('aria-label', c.s.t('card.select', { title: p.title ?? '' }));
    el.toggleAttribute('data-selected', !!(p.selectable && p.selected));
    for (const b of buttons) b.destroy();
    buttons = (p.actions || []).map(a => createButton(acts, { label: a.label, icon: a.icon, iconOnly: a.iconOnly, variant: a.variant || 'ghost', disabled: off || a.disabled, onClick: () => { a.onClick?.(); c.emit(el, 'action', { id: a.id }, p.onAction); } }, c.s));
    acts.hidden = !buttons.length;
  }
  c.on(heading, 'click', e => { if (e.target.closest('button.ui-card-link') && !p.disabled) c.emit(el, 'activate', { event: e }, p.onClick); });
  c.on(check, 'change', () => { p.selected = check.checked; el.toggleAttribute('data-selected', p.selected); c.emit(el, 'select-change', { selected: p.selected }, p.onSelectChange); });
  c.cleanup(() => { for (const b of buttons) b.destroy(); });
  render(); container.append(el);
  return { root: el, get selected() { return !!p.selected; }, update(n) { p = { ...p, ...n }; render(); }, focus: () => (heading.querySelector('a, button') || check).focus(), destroy: () => c.destroy() };
}

/**
 * createPanel(container, { title, description, actions: (slot) => void, columns: 1|2, footer, padded = true, level = 2 })
 * A titled region (section with an accessible name). columns: 2 lays fields out in two columns that stack when narrow.
 */
export function createPanel(container, props = {}, services) {
  const c = setup(container, services, 'panel');
  let p = { padded: true, level: 2, ...props };
  const id = uid('pnl');
  const title = c.h(`h${p.level}`, { class: 'ui-panel-title', id });
  const desc = c.h('p', { class: 'ui-panel-desc' });
  const actions = c.h('div', { class: 'ui-panel-actions' });
  const head = c.h('header', { class: 'ui-panel-head' }, c.h('div', { class: 'ui-panel-heading' }, title, desc), actions);
  const body = c.h('div', { class: 'ui-panel-body' });
  const foot = c.h('footer', { class: 'ui-panel-foot' });
  const el = c.own(c.h('section', { class: 'ui-panel' }, head, body, foot));
  let built = false;
  function render() {
    title.textContent = p.title || ''; head.hidden = !p.title && !p.actions;
    if (p.title) el.setAttribute('aria-labelledby', id); else el.removeAttribute('aria-labelledby');
    desc.textContent = p.description || ''; desc.hidden = !p.description;
    if (!built && typeof p.actions === 'function') p.actions(actions); else if (Array.isArray(p.actions)) fill(actions, p.actions);
    built = true; actions.hidden = !actions.childNodes.length;
    body.dataset.columns = String(p.columns || 1);
    el.toggleAttribute('data-flush', !p.padded);
    fill(foot, p.footer); foot.hidden = !p.footer;
  }
  render();
  container.append(el);
  return { root: el, body, actions, update(n) { p = { ...p, ...n }; render(); }, destroy: () => c.destroy() };
}

/** createDisclosure(container, { title, open, content: Node | (body) => void, headingLevel, onToggle }) — APG disclosure with the expand role. */
export function createDisclosure(container, props = {}, services) {
  const c = setup(container, services, 'disclosure');
  let p = { open: false, ...props };
  const bodyId = uid('dsc');
  const btn = c.h('button', { type: 'button', class: 'ui-disclosure-trigger', 'aria-controls': bodyId }, c.icon('chevron-right'), c.h('span'));
  const inner = c.h('div', { class: 'ui-disclosure-inner' }); // flow-root: child margins stay inside the measured box
  const body = c.h('div', { class: 'ui-disclosure-body', id: bodyId }, inner);
  const el = c.own(c.h('div', { class: 'ui-disclosure' }, p.headingLevel ? c.h(`h${p.headingLevel}`, { class: 'ui-disclosure-heading' }, btn) : btn, body));
  if (typeof p.content === 'function') p.content(inner); else fill(inner, p.content);
  let ticket = 0;
  function sync(animate) {
    btn.setAttribute('aria-expanded', String(!!p.open)); el.toggleAttribute('data-open', !!p.open);
    btn.lastChild.textContent = p.title || '';
    const my = ++ticket;
    if (p.open) {
      body.hidden = false;
      if (animate) c.s.motion.animate(body, { h: inner.offsetHeight, o: 1 }, { role: 'expand', from: { h: 0, o: 0 }, autoHeight: true });
    } else if (animate) {
      c.s.motion.animate(body, { h: 0, o: 0 }, { role: 'expand', from: { h: body.offsetHeight } }).then(ok => { if (ok && my === ticket) { body.hidden = true; c.s.motion.reset(body); body.style.height = ''; } });
    } else body.hidden = true;
  }
  function set(open) { if (!!open === !!p.open) return; p.open = !!open; sync(true); c.emit(el, 'toggle', { open: p.open }, p.onToggle); }
  c.on(btn, 'click', () => set(!p.open));
  sync(false);
  container.append(el);
  return { root: el, body: inner, trigger: btn, get isOpen() { return !!p.open; }, open: () => set(true), close: () => set(false), toggle: () => set(!p.open), update(n) { const was = p.open; p = { ...p, ...n }; sync(was !== p.open); }, focus: () => btn.focus(), destroy: () => c.destroy() };
}

/** createAccordion(container, { items: [{ id, title, content }], value: id | id[], multiple, onChange }) — disclosures with heading triggers. */
export function createAccordion(container, props = {}, services) {
  const c = setup(container, services, 'accordion');
  let p = { items: [], multiple: false, ...props };
  const el = c.own(c.h('div', { class: 'ui-accordion' }));
  let parts = [];
  const isOpen = id => (Array.isArray(p.value) ? p.value.includes(id) : p.value === id);
  function render() {
    for (const x of parts) x.d.destroy();
    fill(el);
    parts = p.items.map(it => ({ it, d: createDisclosure(el, { title: it.title, content: it.content, headingLevel: p.level || 3, open: isOpen(it.id), onToggle: e => toggle(it.id, e.open) }, c.s) }));
  }
  function toggle(id, open) {
    if (p.multiple) { const set = new Set(Array.isArray(p.value) ? p.value : p.value != null ? [p.value] : []); open ? set.add(id) : set.delete(id); p.value = [...set]; }
    else if (open) { p.value = id; for (const x of parts) if (x.it.id !== id && x.d.isOpen) x.d.close(); }
    else if (p.value === id) p.value = null;
    else return; // another section closing because this one opened
    c.emit(el, 'change', { value: p.value }, p.onChange);
  }
  c.cleanup(() => { for (const x of parts) x.d.destroy(); });
  render();
  container.append(el);
  return { root: el, get value() { return p.value; }, update(n) { p = { ...p, ...n }; render(); }, destroy: () => c.destroy() };
}

// ---------------------------------------------------------------- key-value list
/** createKeyValue(container, { items: [{ label, value, mono, copy }] | [[label, value, { mono, copy }]], columns = 1, label }) */
export function createKeyValue(container, props = {}, services) {
  const c = setup(container, services, 'key-value');
  let p = { items: [], columns: 1, ...props };
  const el = c.own(c.h('dl', { class: 'ui-kv' }));
  function render() {
    el.style.setProperty('--ui-kv-cols', String(p.columns));
    if (p.label) el.setAttribute('aria-label', p.label);
    fill(el, p.items.map(raw => {
      const it = Array.isArray(raw) ? { label: raw[0], value: raw[1], ...(raw[2] || {}) } : raw;
      const val = c.h('dd', { class: it.mono ? 'ui-num' : null }, it.value ?? '—');
      if (it.copy) {
        const b = c.h('button', { type: 'button', class: 'ui-kv-copy', 'aria-label': `${c.s.t('copy')}: ${it.label}` }, c.icon('copy'));
        b.addEventListener('click', async () => { try { await c.win.navigator.clipboard.writeText(typeof it.copy === 'string' ? it.copy : val.firstChild.textContent); c.s.announce(c.s.t('copied')); } catch { /* clipboard refused: the value stays selectable */ } });
        val.append(b);
      }
      return c.h('div', { class: 'ui-kv-item' }, c.h('dt', {}, it.label), val);
    }));
  }
  render();
  container.append(el);
  return { root: el, update(n) { p = { ...p, ...n }; render(); }, destroy: () => c.destroy() };
}

// ---------------------------------------------------------------- metric
/**
 * createMetric(container, { label, value, unit, delta: { value, direction: 'up'|'down'|'flat', good: 'up'|'down'|null, label },
 *   sparkline: number[], sparklineLabel, footnote, updatedAt, staleAfter (ms), loading }, services)
 * The value is shown as given (format it with services.format). Freshness and stale state are opt-in (D30).
 */
export function createMetric(container, props = {}, services) {
  const c = setup(container, services, 'metric');
  let p = { ...props };
  const id = uid('met');
  const label = c.h('div', { class: 'ui-metric-label', id });
  const value = c.h('div', { class: 'ui-metric-value' });
  const foot = c.h('div', { class: 'ui-metric-foot' });
  const el = c.own(c.h('div', { class: 'ui-metric', role: 'group', 'aria-labelledby': id }, label, value, foot));
  function render() {
    label.textContent = p.label || '';
    if (p.loading) el.setAttribute('aria-busy', 'true'); else el.removeAttribute('aria-busy');
    if (p.loading) { fill(value, c.h('span', { class: 'ui-skeleton-line', style: 'width:5rem;height:1.4em' })); fill(foot); return; }
    fill(value, c.h('span', {}, p.value ?? '—'), p.unit ? c.h('small', {}, p.unit) : null);
    const d = p.delta;
    let delta = null;
    if (d && d.value != null) {
      const dir = d.direction || 'flat';
      const judged = dir === 'flat' || !d.good ? 'neutral' : dir === d.good ? 'good' : 'bad';
      delta = c.h('span', { class: 'ui-delta', 'data-tone': judged, 'data-dir': dir }, dir === 'flat' ? null : c.icon(dir === 'up' ? 'arrow-up' : 'arrow-down'),
        c.h('span', { class: 'ui-visually-hidden' }, c.s.t(`metric.${dir}`)), c.h('span', {}, d.value), d.label ? c.h('span', { class: 'ui-delta-label' }, d.label) : null);
    }
    let fresh = null;
    if (p.updatedAt != null) {
      const age = Date.now() - toDate(p.updatedAt).getTime(), stale = p.staleAfter != null && age > p.staleAfter;
      el.toggleAttribute('data-stale', stale);
      fresh = c.h('span', { class: 'ui-metric-fresh' }, stale ? c.icon('alert') : null, c.s.t(stale ? 'metric.stale' : 'metric.updated', { time: c.s.format.relative(toDate(p.updatedAt)) }));
    }
    fill(foot, delta, p.footnote ? c.h('span', { class: 'ui-metric-note' }, p.footnote) : null, fresh, p.sparkline ? sparkline(p.sparkline, { doc: c.doc, label: p.sparklineLabel }) : null);
  }
  c.cleanup(tick(c.s, () => { if (p.updatedAt != null) render(); }));
  render();
  container.append(el);
  return { root: el, update(n) { p = { ...p, ...n }; render(); }, destroy: () => c.destroy() };
}

// ---------------------------------------------------------------- timeline
/**
 * createTimeline(container, { items: [{ id, title, description, time, status: 'done'|'current'|'failed'|'pending', actor }], label }, services)
 * An ordered list; each entry's status is stated in text for screen readers, not by the marker alone.
 */
export function createTimeline(container, props = {}, services) {
  const c = setup(container, services, 'timeline');
  let p = { items: [], ...props };
  const el = c.own(c.h('ol', { class: 'ui-timeline' }));
  function render() {
    if (p.label) el.setAttribute('aria-label', p.label);
    fill(el, p.items.map(it => {
      const st = it.status || 'done';
      const time = it.time != null ? c.h('time', { datetime: toDate(it.time).toISOString(), title: c.s.format.dateTime(toDate(it.time)) }, typeof it.timeText === 'string' ? it.timeText : c.s.format.relative(toDate(it.time))) : null;
      return c.h('li', { class: 'ui-timeline-item', 'data-status': st, 'aria-current': st === 'current' ? 'step' : null },
        c.h('span', { class: 'ui-timeline-marker', 'aria-hidden': 'true' }, st === 'failed' ? c.icon('close') : st === 'done' ? c.icon('check') : null),
        c.h('div', { class: 'ui-timeline-body' },
          c.h('div', { class: 'ui-timeline-title' }, it.title, c.h('span', { class: 'ui-visually-hidden' }, ` (${c.s.t(`timeline.${st}`)})`)),
          it.description ? c.h('div', { class: 'ui-timeline-desc' }, it.description) : null,
          time || it.actor ? c.h('div', { class: 'ui-timeline-meta' }, it.actor || null, it.actor && time ? ' · ' : null, time) : null));
    }));
  }
  render();
  container.append(el);
  return { root: el, update(n) { p = { ...p, ...n }; render(); }, destroy: () => c.destroy() };
}

// ---------------------------------------------------------------- list
/**
 * createList(container, { items: [{ id, title, description, meta, leading: iconName | Node, trailing: Node | string, href,
 *   selected, disabled, group }], label, onSelect({ id, item, event }) }, services)
 * Rows are links (href) or buttons (onSelect) whose hit area covers the row; interactive trailing content stays usable.
 * Items with `group` start a new labelled group (e.g. transactions by day).
 */
export function createList(container, props = {}, services) {
  const c = setup(container, services, 'list');
  let p = { items: [], ...props };
  const el = c.own(c.h('div', { class: 'ui-list' }));
  function row(it) {
    const href = safeHref(it.href), interactive = href || p.onSelect;
    const titleEl = interactive
      ? c.h(href ? 'a' : 'button', { class: 'ui-list-action', href, type: href ? null : 'button', disabled: it.disabled || null, 'aria-current': it.selected ? 'true' : null }, it.title)
      : c.h('span', {}, it.title);
    if (interactive) titleEl._item = it;
    const lead = it.leading == null ? null : c.h('span', { class: 'ui-list-lead' }, typeof it.leading === 'string' ? c.icon(it.leading) : it.leading);
    return c.h('li', { class: 'ui-list-item', 'data-interactive': interactive ? '' : null, 'data-selected': it.selected ? '' : null },
      lead,
      c.h('div', { class: 'ui-list-text' }, c.h('div', { class: 'ui-list-title' }, titleEl), it.description ? c.h('div', { class: 'ui-list-desc' }, it.description) : null),
      it.meta != null ? c.h('div', { class: 'ui-list-meta' }, it.meta) : null,
      it.trailing != null ? c.h('div', { class: 'ui-list-trail' }, it.trailing) : null);
  }
  function render() {
    const groups = [];
    let cur = null;
    for (const it of p.items) {
      if (!cur || (it.group && it.group !== cur.name)) { cur = { name: it.group, items: [] }; groups.push(cur); }
      cur.items.push(it);
    }
    // Rows are rebuilt; keep keyboard focus on the same item (by id) when it is still listed.
    const had = el.contains(c.doc.activeElement) ? c.doc.activeElement.closest('.ui-list-action')?._item : null;
    fill(el, groups.map(g => {
      const hid = g.name ? uid('lg') : null;
      return [g.name ? c.h('div', { class: 'ui-list-group', id: hid }, g.name) : null, c.h('ul', { 'aria-labelledby': hid, 'aria-label': !hid && p.label ? p.label : null }, g.items.map(row))];
    }));
    if (had) [...el.querySelectorAll('.ui-list-action')].find(x => x._item.id === had.id)?.focus({ preventScroll: true });
  }
  c.on(el, 'click', e => { const a = e.target.closest('.ui-list-action'); if (a && !a.disabled) c.emit(el, 'select', { id: a._item.id, item: a._item, event: e }, p.onSelect); });
  render();
  container.append(el);
  return { root: el, update(n) { p = { ...p, ...n }; render(); }, focus: () => (el.querySelector('.ui-list-action[aria-current]') || el.querySelector('.ui-list-action'))?.focus(), destroy: () => c.destroy() };
}

// ---------------------------------------------------------------- empty state
// Default copy, icon and action per kind (D30, G18). act: [the prop that enables it, its label, its icon].
const RETRY = ['onRetry', 'retry', 'refresh'];
const STATES = {
  empty: { icon: 'file', title: 'empty.title' },
  filtered: { icon: 'filter', title: 'empty.filtered', act: ['onClearFilters', 'empty.clearFilters'] },
  error: { icon: 'alert', title: 'error.load', message: 'error.network', act: RETRY },
  unavailable: { icon: 'block', title: 'empty.unavailable', message: 'empty.unavailableMessage', act: RETRY },
  permission: { icon: 'lock', title: 'empty.noAccess', message: 'empty.noAccessMessage' },
  offline: { icon: 'offline', title: 'empty.offline', message: 'empty.offlineMessage', act: RETRY },
  unconfigured: { icon: 'settings', title: 'empty.unconfigured', act: ['onSetup', 'empty.setup'] },
  stale: { icon: 'clock', title: 'empty.stale', message: 'empty.staleMessage', act: RETRY, notice: true },
  partial: { icon: 'alert', title: 'empty.partial', act: RETRY, notice: true },
};
const REASONS = ['permission', 'offline'];
const stateOf = p => STATES[p.kind === 'unavailable' && REASONS.includes(p.reason) ? p.reason : p.kind] || STATES.empty;
/**
 * createEmptyState(container, { kind, reason, title, message, icon, action: { label, onClick, variant, icon }, busy,
 *   updatedAt, onRetry, onClearFilters, onSetup }, services)
 * A data state with neutral default copy (D30, G18). In place of the content: 'empty' nothing yet · 'filtered' no results
 * for these filters (Clear filters) · 'error' couldn't load (Retry) · 'unavailable', with reason 'permission' (no access)
 * or 'offline' (Retry) · 'unconfigured' not set up yet (Set up). Beside content that stays on screen, as a compact
 * notice that is announced once: 'stale' not up to date ("Showing data from …" with `updatedAt`; Retry) · 'partial'
 * some items couldn't load (Retry). `busy` shows the action working, a retry in flight for example; the action keeps
 * focus across updates.
 */
export function createEmptyState(container, props = {}, services) {
  const c = setup(container, services, 'empty');
  let p = { kind: 'empty', ...props }, act = null, btn = null, was = null, untick = null;
  const iconBox = c.h('span', { class: 'ui-empty-icon', 'aria-hidden': 'true' }), title = c.h('strong'), msg = c.h('p');
  const el = c.own(c.h('div', { class: 'ui-empty', tabindex: '-1' }, iconBox, c.h('div', { class: 'ui-empty-text' }, title, msg)));
  const since = () => (p.kind === 'stale' && p.updatedAt != null && p.message == null ? c.s.t('empty.staleSince', { time: c.s.format.relative(toDate(p.updatedAt)) }) : null);
  function render() {
    const s = stateOf(p), k = p.kind;
    el.dataset.kind = k; el.toggleAttribute('data-notice', !!s.notice);
    if (k === 'error') el.setAttribute('role', 'alert'); else el.removeAttribute('role');
    fill(iconBox, c.icon(p.icon || s.icon));
    title.textContent = p.title ?? c.s.t(s.title);
    const m = p.message ?? since() ?? (s.message ? c.s.t(s.message) : null);
    msg.textContent = m ?? ''; msg.hidden = !m;
    act = p.action || (s.act && p[s.act[0]] ? { label: c.s.t(s.act[1]), icon: s.act[2], onClick: p[s.act[0]] } : null);
    if (act && !btn) btn = createButton(el, { onClick: () => act?.onClick?.() }, c.s);
    else if (!act && btn) { const had = btn.element === c.doc.activeElement; btn.destroy(); btn = null; if (had) el.focus({ preventScroll: true }); }
    btn?.update({ label: act.label, icon: act.icon, variant: act.variant || 'secondary', busy: !!p.busy });
    if (s.notice && was !== k) c.s.announce(`${title.textContent}. ${m ?? ''}`.trim());
    was = k;
    const ticking = since() != null; // "Showing data from 5 minutes ago" stays true as time passes
    if (ticking && !untick) untick = tick(c.s, () => { msg.textContent = since() ?? msg.textContent; });
    else if (!ticking && untick) { untick(); untick = null; }
  }
  c.cleanup(() => { btn?.destroy(); untick?.(); });
  render();
  container.append(el);
  return { root: el, update(n) { p = { ...p, ...n }; render(); }, focus: () => (btn?.element || el).focus(), destroy: () => c.destroy() };
}

