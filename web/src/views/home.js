// Home: a greeting, eight quick tiles for what was playing lately, then shelves built from the library's statistics
// (counted by the server): recently played, your playlists, top artists, the Hi-Res collection, recently added, forgotten.
import { h, ic, playButton, greeting, isHiRes } from '../dom.js';
import { scope, tint, shelf, chips } from './common.js';

export function homeCollections(ctx) {
  const lib = ctx.lib, last = new Map(), plays = new Map(), added = new Map();
  for (const tr of lib.trackList) {
    last.set(tr.albumId, Math.max(last.get(tr.albumId) ?? 0, tr.lastPlayed ?? 0));
    plays.set(tr.artistId, (plays.get(tr.artistId) ?? 0) + tr.playCount);
    added.set(tr.albumId, Math.max(added.get(tr.albumId) ?? 0, tr.added));
  }
  const albums = lib.albumList, ref = type => x => ({ type, id: x.id });
  return {
    recent: [...albums].sort((a, b) => last.get(b.id) - last.get(a.id)).map(ref('album')),
    playlists: ctx.playlists.filter(p => p.kind !== 'library').map(ref('playlist')),
    artists: [...lib.artistList].sort((a, b) => plays.get(b.id) - plays.get(a.id)).map(ref('artist')),
    hires: albums.filter(a => isHiRes(ctx.track(a.trackIds[0]))).map(ref('album')),
    added: [...albums].sort((a, b) => added.get(b.id) - added.get(a.id)).map(ref('album')),
    forgotten: [...albums].sort((a, b) => last.get(a.id) - last.get(b.id)).map(ref('album')),
  };
}

export function homeView(holder, route, ctx) {
  const t = ctx.t, bag = scope();
  const col = homeCollections(ctx);
  const first = ctx.lib.albums.get(col.recent[0]?.id);
  tint(holder, first?.color);
  holder.classList.add('cm-tinted');

  const top = h('div', { class: 'cm-home-top' });
  holder.append(top);
  let filter = null;
  chips(top, { label: t.view, value: null, clearLabel: t.clearFilter, options: [{ value: 'album', label: t.albums }, { value: 'playlist', label: t.playlists }, { value: 'artist', label: t.artists }], onChange: v => { filter = v; renderShelves(); } });

  const body = h('div', { class: 'cm-pad' });
  holder.append(body);
  body.append(h('h1', { class: 'cm-greeting' }, greeting(t)));

  // quick tiles: liked songs first, then the latest contexts; hovering one tints the page with its colour
  const quick = h('div', { class: 'cm-quick', role: 'list' });
  body.append(quick);
  const qrefs = [{ type: 'playlist', id: 'liked' }, ...col.recent.slice(0, 3), ...col.playlists.filter(r => r.id !== 'liked').slice(0, 2), ...col.recent.slice(3, 5)];
  const tiles = [];
  for (const ref of qrefs) {
    const isAlbum = ref.type === 'album', a = isAlbum ? ctx.lib.albums.get(ref.id) : null, p = isAlbum ? null : ctx.playlist(ref.id);
    const name = a?.title ?? p?.name ?? '', color = a?.color ?? ctx.playlistColor(p);
    const artBox = h('span', { class: 'cm-quick-art' });
    const img = bag.add(ctx.P.createImage(artBox, { src: isAlbum ? ctx.art(a.id) : ctx.playlistArt(p), alt: '', placeholder: p?.kind === 'liked' ? 'heart-filled' : p?.kind === 'library' ? 'library' : 'playlist', shape: 'square' }, ctx.S));
    if (p?.kind === 'liked') img.root.dataset.special = 'heart-filled';
    const playing = () => ctx.isContextPlaying(ref.type, ref.id);
    const btn = playButton({ label: playing() ? t.pauseX(name) : t.playX(name), size: 'md', playing: playing(), onClick: () => ctx.togglePlayContext(ref.type, ref.id) });
    const item = h('div', { class: 'cm-quick-item', role: 'listitem', 'data-current': ctx.isContext(ref.type, ref.id) || null, onMouseenter: () => tint(holder, color), onMouseleave: () => tint(holder, first?.color) },
      h('a', { class: 'cm-quick-link', href: `#/${ref.type}/${ref.id}` }, artBox, h('span', { class: 'cm-quick-title' }, name), ctx.isContext(ref.type, ref.id) ? h('span', { class: 'cm-eq', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')) : null), btn);
    tiles.push({ item, btn, ref, name, playing });
    quick.append(item);
  }
  bag.add(ctx.on('player', () => { for (const x of tiles) { x.btn.set({ playing: x.playing(), label: x.playing() ? t.pauseX(x.name) : t.playX(x.name) }); x.item.toggleAttribute('data-current', ctx.isContext(x.ref.type, x.ref.id)); x.item.toggleAttribute('data-playing', x.playing()); } }));

  const shelves = h('div', { class: 'cm-shelves' });
  body.append(shelves);
  let shelfBag = scope();
  function renderShelves() {
    shelfBag.destroy(); shelfBag = scope(); shelves.replaceChildren();
    const want = type => !filter || filter === type;
    if (want('album')) shelf(shelves, ctx, shelfBag, { title: t.recent, refs: col.recent.slice(0, 12), more: '/shelf/recent' });
    if (want('playlist')) shelf(shelves, ctx, shelfBag, { title: t.yourPlaylists, refs: col.playlists, more: '/shelf/playlists' });
    if (want('artist')) shelf(shelves, ctx, shelfBag, { title: t.topArtists, refs: col.artists.slice(0, 12), more: '/shelf/artists' });
    if (want('album')) shelf(shelves, ctx, shelfBag, { title: t.hires, refs: col.hires, more: '/shelf/hires' });
    if (want('album')) shelf(shelves, ctx, shelfBag, { title: t.recentlyAdded, refs: col.added.slice(0, 12), more: '/shelf/added' });
    if (want('album')) shelf(shelves, ctx, shelfBag, { title: t.rediscover, refs: col.forgotten.slice(0, 12), more: '/shelf/forgotten' });
  }
  renderShelves();
  bag.add(() => shelfBag.destroy());
  return { title: t.home, destroy: () => bag.destroy() };
}
