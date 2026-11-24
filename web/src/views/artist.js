// An artist: a banner from their artwork, Play / Shuffle, the most played tracks (play counts from the server),
// the discography with a filter, and artists of the same genre.
import { h, playButton } from '../dom.js';
import { scope, tint, tintFrom, hero, actionRow, stickyBar, trackList, mediaCard, shelf, chips } from './common.js';

export function artistView(holder, route, ctx) {
  const t = ctx.t, bag = scope(), a = ctx.lib.artists.get(route.id);
  if (!a) { holder.append(h('p', { class: 'cm-pad' }, t.noResults(route.id))); return null; }
  const albums = a.albumIds.map(id => ctx.lib.albums.get(id)).sort((x, y) => y.year - x.year);
  const ids = albums.flatMap(al => al.trackIds), plays = ids.reduce((s, id) => s + ctx.track(id).playCount, 0);
  tint(holder, albums[0]?.color); tintFrom(holder, ctx, albums[0]?.id);
  holder.classList.add('cm-tinted', 'cm-artist');
  // the banner: the newest cover, large and blurred behind the name
  const banner = h('div', { class: 'cm-banner', 'aria-hidden': 'true' });
  bag.add(ctx.P.createImage(banner, { src: ctx.art(albums[0]?.id), alt: '', ratio: '16 / 9', lazy: false }, ctx.S));
  holder.append(banner);
  const { titleEl } = hero(holder, ctx, bag, { kind: `${t.kindArtist} · ${a.genre}`, title: a.name, banner: true, meta: [t.nAlbums(albums.length), t.nSongs(ids.length), t.plays(plays)] });
  stickyBar(holder, ctx, bag, titleEl, { title: a.name, kind: 'artist', id: a.id });

  const body = h('div', { class: 'cm-body' });
  holder.append(body);
  body.append(actionRow(ctx, bag, { kind: 'artist', id: a.id, label: a.name,
    menu: () => [{ id: 'queue', label: t.addQueue, icon: 'queue' }, { id: 'next', label: t.playNext, icon: 'skip-next' }], onMenu: item => ctx.onTrackMenu(item, ids) }).root);

  // popular: five, or ten with "Show more"
  const top = [...ids].sort((x, y) => ctx.track(y).playCount - ctx.track(x).playCount);
  const popHead = h('h2', { class: 'cm-h2' }, t.popular);
  body.append(popHead);
  let more = false;
  const pop = trackList(body, ctx, bag, { kind: 'artist', id: a.id, ids: top.slice(0, 5), numbered: true, label: t.popular, columns: ['index', 'title', 'like', 'duration'], sortable: false, contextIds: () => top });
  pop.list.root.classList.add('cm-headless');
  const toggle = h('button', { type: 'button', class: 'cm-textbtn', 'aria-expanded': 'false', onClick: () => { more = !more; pop.setIds(top.slice(0, more ? 10 : 5)); toggle.textContent = more ? t.showLess : t.showMore; toggle.setAttribute('aria-expanded', String(more)); } }, t.showMore);
  if (top.length > 5) body.append(toggle);

  // discography with a filter, all releases in a wrapping grid
  body.append(h('h2', { class: 'cm-h2' }, t.discography));
  const grid = h('div', { class: 'cm-grid', role: 'list' });
  let cards = [];
  const renderGrid = filter => {
    cards.forEach(c => c.destroy()); grid.replaceChildren();
    cards = albums.filter(al => !filter || (filter === 'album' ? al.type === 'album' : al.type !== 'album')).map(al => { const cell = h('div', { role: 'listitem' }); grid.append(cell); return mediaCard(cell, ctx, { type: 'album', id: al.id }); });
  };
  const hasSingles = albums.some(al => al.type !== 'album');
  if (hasSingles) chips(body, { label: t.discography, value: null, clearLabel: t.clearFilter, options: [{ value: 'album', label: t.albumsOnly }, { value: 'single', label: t.singlesEps }], onChange: renderGrid });
  body.append(grid);
  renderGrid(null);
  bag.add(() => cards.forEach(c => c.destroy()));
  bag.add(ctx.on('player', () => { for (const c of cards) c.update({ playing: ctx.isContextPlaying('album', c.ref.id) }); }));

  // the biography from the server (Last.fm through Navidrome), when there is one
  const bioBox = h('section', { class: 'cm-bio', hidden: '' });
  body.append(bioBox);
  const ctl = new AbortController(); bag.add(() => ctl.abort());
  ctx.adapter.artistInfo?.(a.id, ctl.signal).then(info => {
    if (!info?.bio) return;
    bioBox.append(h('h2', { class: 'cm-h2' }, t.bio), h('p', { class: 'cm-bio-text' }, info.bio));
    if (info.url) bioBox.append(h('a', { class: 'cm-textbtn', href: info.url, target: '_blank', rel: 'noopener' }, t.bioMore));
    bioBox.hidden = false;
  }).catch(() => {});

  const related = ctx.lib.artistList.filter(x => x.id !== a.id && x.genre === a.genre).concat(ctx.lib.artistList.filter(x => x.id !== a.id && x.genre !== a.genre)).slice(0, 8).map(x => ({ type: 'artist', id: x.id }));
  shelf(body, ctx, bag, { title: t.related, refs: related });
  return { title: a.name, destroy: () => bag.destroy() };
}
