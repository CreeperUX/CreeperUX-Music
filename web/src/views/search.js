// Search. Empty: "Browse all", one coloured tile per genre tag in the library. With a query: the top result, the
// best songs, then artists, albums and playlists; chips narrow the results to one kind.
import { h, ic, playButton, shade } from '../dom.js';
import { scope, tint, trackList, shelf, chips, mediaCard } from './common.js';

export function searchView(holder, route, ctx) {
  const t = ctx.t, bag = scope(), q = route.id.trim();
  holder.classList.add('cm-search');
  tint(holder, '#2b3439');
  const body = h('div', { class: 'cm-pad' });
  holder.append(body);
  if (!q) { browse(body, ctx, bag); return { title: t.search, destroy: () => bag.destroy() }; }

  const status = h('p', { class: 'ui-visually-hidden', role: 'status' });
  const results = h('div', { class: 'cm-results' });
  body.append(status, results);
  let alive = true;
  bag.add(() => { alive = false; });
  ctx.adapter.search(q).then(r => {
    if (!alive) return;
    const total = r.tracks.length + r.albums.length + r.artists.length + r.playlists.length;
    status.textContent = `${total}`;
    if (!total) { ctx.UI.createEmptyState(results, { icon: 'search', title: t.noResults(q), message: t.noResultsMsg }, ctx.S); return; }
    let rbag = scope();
    bag.add(() => rbag.destroy());
    const render = kind => {
      rbag.destroy(); rbag = scope(); results.replaceChildren();
      if (!kind) {
        const two = h('div', { class: 'cm-search-top' });
        results.append(two);
        const best = r.artists[0] ? { type: 'artist', id: r.artists[0] } : r.albums[0] ? { type: 'album', id: r.albums[0] } : r.playlists[0] ? { type: 'playlist', id: r.playlists[0] } : null;
        if (best) topResult(two, ctx, rbag, best);
        if (r.tracks.length) {
          const col = h('section', { class: 'cm-search-songs', 'aria-label': t.songs }, h('h2', { class: 'cm-h2' }, t.songs));
          two.append(col);
          trackList(col, ctx, rbag, { kind: 'search', id: q, ids: r.tracks.slice(0, 4), label: t.songs, columns: ['title', 'like', 'duration'], sortable: false, contextIds: () => r.tracks }).list.root.classList.add('cm-headless');
        }
        shelf(results, ctx, rbag, { title: t.artists, refs: r.artists.map(id => ({ type: 'artist', id })) });
        shelf(results, ctx, rbag, { title: t.albums, refs: r.albums.map(id => ({ type: 'album', id })) });
        shelf(results, ctx, rbag, { title: t.playlists, refs: r.playlists.map(id => ({ type: 'playlist', id })) });
      } else if (kind === 'track') {
        trackList(results, ctx, rbag, { kind: 'search', id: q, ids: r.tracks, label: t.songs, columns: ['index', 'title', 'album', 'like', 'duration'], numbered: true });
      } else {
        const grid = h('div', { class: 'cm-grid', role: 'list' }); results.append(grid);
        const cards = r[`${kind}s`].map(id => { const cell = h('div', { role: 'listitem' }); grid.append(cell); return mediaCard(cell, ctx, { type: kind, id }); }).filter(Boolean);
        rbag.add(() => cards.forEach(c => c.destroy()));
      }
    };
    const opts = [['track', t.songs, r.tracks], ['artist', t.artists, r.artists], ['album', t.albums, r.albums], ['playlist', t.playlists, r.playlists]].filter(o => o[2].length).map(([value, label]) => ({ value, label }));
    const bar = h('div', { class: 'cm-search-chips' }); results.before(bar);
    chips(bar, { label: t.search, value: null, clearLabel: t.clearFilter, options: opts, onChange: kind => { render(kind); ctx.motion?.reveal(results); } });
    render(null);
  }, err => { if (alive) ctx.UI.createEmptyState(results, { title: t.offline, message: err.message, action: { label: t.retry, onClick: () => ctx.refreshView() } }, ctx.S); });
  return { title: `${t.search}: ${q}`, destroy: () => bag.destroy() };
}

function topResult(container, ctx, bag, ref) {
  const t = ctx.t, isArtist = ref.type === 'artist';
  const item = isArtist ? ctx.lib.artists.get(ref.id) : ref.type === 'album' ? ctx.lib.albums.get(ref.id) : ctx.playlist(ref.id);
  const name = item.name ?? item.title;
  const art = h('span', { class: 'cm-best-art' });
  bag.add(ctx.P.createImage(art, { src: isArtist ? ctx.art(item.albumIds[0]) : ref.type === 'album' ? ctx.art(item.id) : ctx.playlistArt(item), alt: '', shape: isArtist ? 'circle' : 'rounded', placeholder: isArtist ? 'artist' : 'album' }, ctx.S));
  const playing = () => ctx.isContextPlaying(ref.type, ref.id);
  const btn = playButton({ label: t.playX(name), playing: playing(), onClick: () => ctx.togglePlayContext(ref.type, ref.id) });
  const sub = isArtist ? t.kindArtist : ref.type === 'album' ? `${t.kindAlbum} · ${item.artist}` : t.kindPlaylist;
  const el = h('section', { class: 'cm-best', 'aria-label': t.topResult },
    h('h2', { class: 'cm-h2' }, t.topResult),
    h('div', { class: 'cm-best-card' }, art, h('a', { class: 'cm-best-name', href: `#/${ref.type}/${ref.id}` }, name), h('span', { class: 'cm-best-sub' }, sub), btn));
  container.append(el);
  bag.add(ctx.on('player', () => btn.set({ playing: playing(), label: playing() ? t.pauseX(name) : t.playX(name) })));
}

/** One tile per genre: its colour from the genre's first album, a cover tilted in the corner. */
function browse(body, ctx, bag) {
  const t = ctx.t;
  body.append(h('h1', { class: 'cm-greeting' }, t.browse), h('p', { class: 'cm-hint' }, ic('info'), t.searchHint));
  const genres = new Map();
  for (const al of ctx.lib.albumList) if (!genres.has(al.genre)) genres.set(al.genre, al);
  const grid = h('div', { class: 'cm-genres', role: 'list' });
  for (const [g, al] of genres) {
    const art = h('span', { class: 'cm-genre-art', 'aria-hidden': 'true' });
    bag.add(ctx.P.createImage(art, { src: ctx.art(al.id), alt: '' }, ctx.S));
    const tile = h('a', { class: 'cm-genre', href: `#/genre/${encodeURIComponent(g)}`, style: { background: shade(al.color, -0.35) } }, h('span', {}, g), art);
    if (!al.color) ctx.albumColor(al.id).then(c => { if (c) tile.style.background = shade(c, -0.35); });
    grid.append(h('div', { role: 'listitem' }, tile));
  }
  body.append(grid);
}
