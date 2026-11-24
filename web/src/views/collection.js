// "Show all" for a home shelf, and a genre page: a virtual grid of cards that scrolls with the main region.
import { h } from '../dom.js';
import { scope, tint, tintFrom, mediaCard, trackList, actionRow } from './common.js';
import { homeCollections } from './home.js';

function grid(body, ctx, bag, refs, label) {
  const g = bag.add(ctx.P.createVirtualGrid(body, { items: refs, itemKey: r => `${r.type}:${r.id}`, label, minItemWidth: 168, gap: 20, estimate: 250, height: null, scroller: ctx.ws.main,
    render: ref => mediaCard(document.createElement('div'), ctx, ref) }, ctx.S));
  return g;
}

export function shelfView(holder, route, ctx) {
  const t = ctx.t, bag = scope();
  const col = homeCollections(ctx);
  const titles = { recent: t.recent, playlists: t.yourPlaylists, artists: t.topArtists, hires: t.hires, added: t.recentlyAdded, forgotten: t.rediscover };
  const refs = col[route.id] || [];
  tint(holder, ctx.lib.albums.get(refs.find(r => r.type === 'album')?.id)?.color); tintFrom(holder, ctx, refs.find(r => r.type === 'album')?.id);
  holder.classList.add('cm-tinted');
  const body = h('div', { class: 'cm-pad' }, h('h1', { class: 'cm-greeting' }, titles[route.id] || t.home));
  holder.append(body);
  grid(body, ctx, bag, refs, titles[route.id]);
  return { title: titles[route.id], destroy: () => bag.destroy() };
}

export function genreView(holder, route, ctx) {
  const t = ctx.t, bag = scope(), g = route.id;
  const albums = ctx.lib.albumList.filter(a => a.genre === g);
  const ids = ctx.lib.trackList.filter(x => x.genre === g).sort((a, b) => b.playCount - a.playCount).map(x => x.id);
  tint(holder, albums[0]?.color); tintFrom(holder, ctx, albums[0]?.id);
  holder.classList.add('cm-tinted');
  const body = h('div', { class: 'cm-pad' }, h('span', { class: 'cm-hero-kind' }, t.kindGenre), h('h1', { class: 'cm-greeting cm-genre-title' }, g));
  holder.append(body);
  body.append(actionRow(ctx, bag, { kind: 'genre', id: g, label: g, ids: () => ids }).root);
  body.append(h('h2', { class: 'cm-h2' }, t.popular));
  trackList(body, ctx, bag, { kind: 'genre', id: g, ids: ids.slice(0, 8), numbered: true, label: t.popular, columns: ['index', 'title', 'album', 'like', 'duration'], sortable: false, contextIds: () => ids });
  body.append(h('h2', { class: 'cm-h2' }, t.albums));
  grid(body, ctx, bag, albums.map(a => ({ type: 'album', id: a.id })), t.albums);
  return { title: g, destroy: () => bag.destroy() };
}
