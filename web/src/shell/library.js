// "Your Library" on the start side: playlists (liked songs and the media library pinned), albums and artists, with
// filter chips, a find field and sorting. Narrowed below 140 px it becomes a rail of covers.
import { h, ic } from '../dom.js';
import { mediaCard, chips } from '../views/common.js';

const RAIL = 140;

export function mountLibrary(slot, ctx) {
  const { UI, t } = ctx;
  const nav = h('nav', { class: 'cm-lib', 'aria-label': t.library });
  slot.append(nav);

  // The title row and the chips stay at the top together, in one sticky block: two separately sticky rows (the chips at
  // a fixed offset) left a gap whenever the title row was not exactly that tall, and the list showed through it.
  const top = h('div', { class: 'cm-lib-top' });
  nav.append(top);
  const onScroll = () => top.toggleAttribute('data-scrolled', slot.scrollTop > 0); // a shadow once the list runs under it
  slot.addEventListener('scroll', onScroll, { passive: true });

  // header: the title collapses / expands the library; + creates a playlist
  const head = h('div', { class: 'cm-lib-head' });
  const title = h('button', { type: 'button', class: 'cm-lib-title', 'aria-expanded': 'true' }, ic('library'), h('span', {}, t.library));
  head.append(title);
  top.append(head);
  const create = UI.createMenuButton(head, { label: t.createPlaylist, icon: 'plus', iconOnly: true, variant: 'ghost', placement: 'bottom-end',
    items: [{ id: 'new', label: t.newPlaylist, icon: 'playlist' }, { id: 'auto', label: t.newAutoplaylist, icon: 'filter', description: t.autoNote, disabled: true }],
    onSelect: async e => {
      if (e.item.id !== 'new') return;
      const p = await ctx.adapter.playlistCreate(t.newPlaylistName(ctx.playlists.filter(x => x.kind === 'user').length + 1)).catch(err => { ctx.run(Promise.reject(err)); });
      if (p) ctx.go(`/playlist/${p.id}`);
    } }, ctx.S);
  create.element.classList.add('cm-round');
  title.addEventListener('click', () => {
    const rail = ctx.ws.layout.start.width < RAIL;
    ctx.ws.setWidth('start', rail ? (ctx.prefs.startWide || 300) : 72);
  });

  // chips, then find and sort
  const filters = h('div', { class: 'cm-lib-filters' });
  top.append(filters);
  chips(filters, { label: t.library, value: ctx.prefs.libFilter, clearLabel: t.clearFilter,
    options: [{ value: 'playlist', label: t.playlists }, { value: 'album', label: t.albums }, { value: 'artist', label: t.artists }],
    onChange: v => { ctx.prefs.libFilter = v; ctx.savePrefs(); render(); } });
  const tools = h('div', { class: 'cm-lib-tools' });
  nav.append(tools);
  let find = '';
  const findBox = h('div', { class: 'cm-lib-find' });
  tools.append(findBox);
  UI.createSearchField(findBox, { label: t.searchLibrary, hideLabel: true, placeholder: t.searchLibrary, onInput: e => { find = e.value.trim().toLowerCase(); render(); } }, ctx.S);
  const sortNames = { recent: t.sortRecent, added: t.sortAdded, alpha: t.sortAlpha, creator: t.sortCreator };
  const sort = UI.createMenuButton(tools, { label: sortNames[ctx.prefs.libSort], icon: 'sort', variant: 'ghost', placement: 'bottom-end',
    items: () => [{ heading: t.sort }, ...Object.entries(sortNames).map(([id, label]) => ({ id, label, type: 'radio', group: 'sort', checked: ctx.prefs.libSort === id }))],
    onSelect: e => { ctx.prefs.libSort = e.item.id; ctx.savePrefs(); sort.update({ label: sortNames[e.item.id] }); render(); } }, ctx.S);
  sort.element.classList.add('cm-sort');

  // the list renders only the rows in view (a virtual grid of one column scrolling with the sidebar): with hundreds
  // of albums and artists, laying out every card made resizing the sidebar drop to a few frames a second
  const list = h('div', { class: 'cm-lib-list' });
  nav.append(list);
  const keyOf = e => `${e.type}:${e.id}`;
  const cards = new Map(); // key → the card handle, for the rows rendered so far (the grid destroys them)
  const grid = ctx.P.createVirtualGrid(list, { items: [], itemKey: keyOf, label: t.library, minItemWidth: 1e6, gap: 0, estimate: 64, height: null, scroller: slot,
    render: e => {
      const card = mediaCard(document.createElement('div'), ctx, e, 'row');
      if (!card) return h('div');
      card.update({ current: isCurrent(e) });
      if (e.pinned) card.root.querySelector('.ui-mcard-sub')?.prepend(h('span', { class: 'cm-pin', title: t.pinned }, ic('pin')));
      cards.set(keyOf(e), card);
      return card;
    } }, ctx.S);
  function entries() {
    const lastAlbum = new Map(), lastArtist = new Map(), addedAlbum = new Map();
    for (const tr of ctx.lib.trackList) {
      lastAlbum.set(tr.albumId, Math.max(lastAlbum.get(tr.albumId) ?? 0, tr.lastPlayed ?? 0));
      lastArtist.set(tr.artistId, Math.max(lastArtist.get(tr.artistId) ?? 0, tr.lastPlayed ?? 0));
      addedAlbum.set(tr.albumId, Math.max(addedAlbum.get(tr.albumId) ?? 0, tr.added));
    }
    const lastOfPlaylist = p => Math.max(p.updated, ...p.trackIds.slice(0, 50).map(id => ctx.track(id)?.lastPlayed ?? 0));
    let all = [
      ...ctx.playlists.map(p => ({ type: 'playlist', id: p.id, name: p.name, creator: p.owner ?? '', pinned: !!p.pinned, recent: lastOfPlaylist(p), added: p.updated })),
      ...ctx.lib.albumList.map(a => ({ type: 'album', id: a.id, name: a.title, creator: a.artist, recent: lastAlbum.get(a.id), added: addedAlbum.get(a.id) })),
      ...ctx.lib.artistList.map(a => ({ type: 'artist', id: a.id, name: a.name, creator: a.name, recent: lastArtist.get(a.id), added: 0 })),
    ];
    if (ctx.prefs.libFilter) all = all.filter(e => e.type === ctx.prefs.libFilter);
    if (find) all = all.filter(e => e.name.toLowerCase().includes(find) || e.creator.toLowerCase().includes(find));
    const by = { recent: (a, b) => b.recent - a.recent, added: (a, b) => b.added - a.added, alpha: (a, b) => a.name.localeCompare(b.name, ctx.prefs.locale), creator: (a, b) => a.creator.localeCompare(b.creator, ctx.prefs.locale) }[ctx.prefs.libSort] || (() => 0);
    return all.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || by(a, b));
  }
  function isCurrent(ref) { return ctx.route.name === ref.type && ctx.route.id === ref.id; }
  function render() {
    const all = entries(), live = new Set(all.map(keyOf));
    for (const k of [...cards.keys()]) if (!live.has(k)) cards.delete(k);
    grid.update({ items: all });
  }
  render();
  ctx.on('route', () => { for (const c of cards.values()) c.update({ current: isCurrent(c.ref) }); });
  ctx.on('player', ({ player, prev }) => { if (player.state !== prev?.state || player.context?.id !== prev?.context?.id) for (const c of cards.values()) c.update({ playing: ctx.isContextPlaying(c.ref.type, c.ref.id) }); });
  ctx.on('playlists', render); ctx.on('library', render);

  // the rail: covers only, below 140 px (the names stay as the links' accessible names)
  const syncRail = () => {
    const rail = ctx.ws.layout.start.width < RAIL;
    nav.toggleAttribute('data-rail', rail);
    title.setAttribute('aria-expanded', String(!rail));
    title.setAttribute('aria-label', rail ? t.expandLibrary : t.collapseLibrary);
    if (!rail) ctx.prefs.startWide = ctx.ws.layout.start.width;
  };
  syncRail(); ctx.on('layout', syncRail);
}
