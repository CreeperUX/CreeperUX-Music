// An album: the coloured header (artwork, type, title, artist · year · songs, length, the audio format), Play,
// Shuffle and More, the tracks (by disc when there are two), the release details and more by the artist.
import { h, longDuration } from '../dom.js';
import { scope, tint, hero, actionRow, stickyBar, trackList, shelf, badges } from './common.js';

export function albumView(holder, route, ctx) {
  const t = ctx.t, bag = scope(), a = ctx.lib.albums.get(route.id);
  if (!a) { holder.append(h('p', { class: 'cm-pad' }, t.noResults(route.id))); return null; }
  const tracks = a.trackIds.map(ctx.track), first = tracks[0], artist = ctx.lib.artists.get(a.artistId);
  tint(holder, a.color);
  holder.classList.add('cm-tinted');
  const kind = { album: t.kindAlbum, ep: t.kindEp, single: t.kindSingle, compilation: t.kindCompilation }[a.type];
  const avatar = h('span', { class: 'cm-avatar' });
  bag.add(ctx.P.createImage(avatar, { src: ctx.art(artist?.albumIds[0]), alt: '', shape: 'circle', placeholder: 'artist' }, ctx.S));
  const total = tracks.reduce((s, x) => s + x.duration, 0);
  const { titleEl } = hero(holder, ctx, bag, {
    kind, title: a.title, art: ctx.art(a.id), onColor: a.color ? undefined : c => { a.color = c; },
    meta: [h('a', { class: 'cm-meta-strong', href: `#/artist/${a.artistId}` }, avatar, a.artist), a.year ? String(a.year) : null, `${t.nSongs(tracks.length)}，${longDuration(total, t)}`, badges(ctx, first)],
  });
  stickyBar(holder, ctx, bag, titleEl, { title: a.title, kind: 'album', id: a.id });

  const body = h('div', { class: 'cm-body' });
  holder.append(body);
  const queueBtn = ctx.UI.createIconButton(h('span'), { label: t.addQueue, icon: 'queue', variant: 'ghost', onClick: () => ctx.onTrackMenu({ id: 'queue' }, a.trackIds) }, ctx.S);
  queueBtn.element.classList.add('cm-action-icon'); bag.add(queueBtn);
  body.append(actionRow(ctx, bag, { kind: 'album', id: a.id, label: a.title, extra: [queueBtn.element],
    menu: () => [{ id: 'queue', label: t.addQueue, icon: 'queue' }, { id: 'next', label: t.playNext, icon: 'skip-next' }, { id: 'pl', label: t.addToPlaylist, icon: 'plus', items: ctx.trackMenu(a.trackIds)[2].items }, { separator: true }, { id: 'artist', label: t.goArtist, icon: 'artist' }],
    onMenu: item => (item.id === 'artist' ? ctx.go(`/artist/${a.artistId}`) : ctx.onTrackMenu(item, a.trackIds)) }).root);

  const discs = new Set(tracks.map(x => x.disc)).size > 1;
  const list = trackList(body, ctx, bag, { kind: 'album', id: a.id, ids: a.trackIds, label: a.title, columns: ['index', 'title', 'like', 'duration'], sortable: false,
    groupBy: discs ? tr => ctx.track(tr.id)?.disc : undefined, groupLabel: d => `CD ${d}` });

  body.append(h('div', { class: 'cm-release' }, a.year ? h('p', {}, t.released(ctx.S.format.date(Date.UTC(a.year, 0, 1), { year: 'numeric' }))) : null, (a.year || a.label) ? h('p', {}, `℗ ${[a.year || '', a.label ?? ''].join(' ').trim()}`) : null));
  const others = (artist?.albumIds || []).filter(id => id !== a.id).map(id => ({ type: 'album', id }));
  shelf(body, ctx, bag, { title: t.moreBy(a.artist), refs: others, more: others.length > 4 ? `/artist/${a.artistId}` : null });
  return { title: a.title, revealCurrent: () => list.revealCurrent(), destroy: () => bag.destroy() };
}
