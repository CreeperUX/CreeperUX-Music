// The top bar: brand, Home and the search field in the middle, the server connection, settings and the Now playing
// toggle at the end. No back / forward buttons; Alt+←/→ and the mouse's
// back / forward buttons still go through the history.
import { h, ic } from '../dom.js';

export function mountTopbar(slot, ctx) {
  const { UI, t } = ctx;
  const bar = h('div', { class: 'cm-top' });
  slot.append(bar);

  const start = h('div', { class: 'cm-top-start' });
  start.append(h('a', { class: 'cm-brand', href: '#/', 'aria-label': t.app }, h('img', { class: 'cm-brand-mark', src: './assets/icon.svg', alt: '', width: 26, height: 26 }), h('span', { class: 'cm-brand-name', 'aria-hidden': 'true' }, 'Sonus')));
  // Your Library, when it is closed or floats (narrow windows)
  const libBtn = UI.createIconButton(start, { label: t.toggleLibrary, icon: 'library', variant: 'ghost', onClick: () => ctx.ws.toggle('start', { focus: true }) }, ctx.S);
  libBtn.element.classList.add('cm-round', 'cm-lib-toggle');
  const syncLib = () => { libBtn.element.hidden = ctx.ws.mode === 'wide' && ctx.ws.layout.start.open; libBtn.element.setAttribute('aria-expanded', String(ctx.ws.layout.start.open)); };
  syncLib(); ctx.on('layout', syncLib);
  bar.append(start);

  // centre: Home and the search pill
  const center = h('div', { class: 'cm-top-center' });
  const home = h('a', { class: 'cm-home-btn', href: '#/', 'aria-label': t.home }, ic('home'));
  const pill = h('div', { class: 'cm-search-pill' });
  center.append(home, pill);
  bar.append(center);
  let timer = 0;
  const search = UI.createSearchField(pill, { label: t.search, hideLabel: true, placeholder: t.searchPlaceholder, value: ctx.route.name === 'search' ? ctx.route.id : '',
    onInput: e => {
      clearTimeout(timer);
      const v = e.value.trim();
      timer = setTimeout(() => ctx.go(`/search/${encodeURIComponent(v)}`, { replace: ctx.route.name === 'search' }), 220);
    } }, ctx.S);
  search.input.addEventListener('focus', () => { if (ctx.route.name !== 'search') ctx.go(`/search/${encodeURIComponent(search.value.trim())}`); });
  const browse = h('a', { class: 'cm-browse', href: '#/search/', 'aria-label': t.browse, title: t.browse }, ic('browse'));
  pill.append(h('span', { class: 'cm-pill-sep', 'aria-hidden': 'true' }), browse);
  ctx.on('focus-search', () => { search.input.focus(); search.input.select?.(); });

  // end: connection, settings, panel toggle
  const end = h('div', { class: 'cm-top-end' });
  bar.append(end);
  const conn = h('button', { type: 'button', class: 'cm-conn' });
  end.append(conn);
  const renderConn = () => {
    const s = ctx.connection;
    conn.dataset.state = s;
    const text = s === 'online' ? (ctx.server?.name ?? 'Navidrome') : s === 'connecting' ? t.connecting : t.offline;
    conn.replaceChildren(h('span', { class: 'cm-conn-dot', 'aria-hidden': 'true' }), h('span', { class: 'cm-conn-text' }, text));
    conn.title = s === 'online' ? t.connected(`${ctx.server?.version ?? ''} · ${ctx.adapter.account().server.replace(/^https?:\/\//, '')}`) : s === 'offline' ? t.offlineMsg : t.connecting;
    conn.setAttribute('aria-label', conn.title.includes(text) ? conn.title : `${text}：${conn.title}`); // the name starts with what is shown (WCAG 2.5.3)
    conn.disabled = s === 'connecting';
  };
  conn.addEventListener('click', () => { if (ctx.connection === 'offline') ctx.adapter.goOnline?.(); else UI.toast({ message: conn.title }, ctx.S); });
  renderConn(); ctx.on('connection', renderConn);

  // settings: a page of its own (#/settings), marked while it is open
  const gear = h('a', { class: 'cm-icon-link', href: '#/settings', 'aria-label': t.settings, title: t.settings }, ic('settings'));
  end.append(gear);
  const panel = UI.createIconButton(end, { label: t.togglePanel, icon: 'panel-right', variant: 'ghost', onClick: () => ctx.panel.toggle('now') }, ctx.S);
  panel.element.setAttribute('aria-pressed', String(ctx.ws.layout.end.open));
  ctx.on('layout', () => panel.element.setAttribute('aria-pressed', String(ctx.ws.layout.end.open)));

  ctx.on('route', ({ route }) => {
    home.toggleAttribute('aria-current', route.name === 'home');
    if (route.name === 'home') home.setAttribute('aria-current', 'page');
    if (route.name === 'settings') gear.setAttribute('aria-current', 'page'); else gear.removeAttribute('aria-current');
    if (route.name !== 'search' && document.activeElement !== search.input) search.update({ value: '' });
  });
}
