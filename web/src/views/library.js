// The music library as pages (#/library/playlists | albums | artists | songs): what the sidebar lists on a wide
// window, laid out for the main view. On a phone this is the "Library" tab; on a desktop it is the whole collection
// as a grid. Albums and artists are virtual grids, the songs a virtual list, so a large library costs nothing extra.
import { h } from '../dom.js';
import { scope, mediaCard, trackList, chips } from './common.js';

const KINDS = ['playlists', 'albums', 'artists', 'songs'];

export function libraryView(holder, route, ctx) {
  const t = ctx.t, bag = scope();
  const kind = KINDS.includes(route.id) ? route.id : (KINDS.includes(ctx.prefs.libPage) ? ctx.prefs.libPage : 'playlists');
  if (ctx.prefs.libPage !== kind) { ctx.prefs.libPage = kind; ctx.savePrefs(); }
  holder.classList.add('cm-libpage');
  const names = { playlists: t.playlists, albums: t.albums, artists: t.artists, songs: t.songs };
  const top = h('div', { class: 'cm-home-top' });
  holder.append(top);
  chips(top, { label: t.library, value: kind, options: KINDS.map(k => ({ value: k, label: names[k] })), onChange: v => ctx.go(`/library/${v}`, { replace: true }) });
  const body = h('div', { class: 'cm-pad' });
  holder.append(body);
  const head = h('div', { class: 'cm-libpage-head' }, h('h1', { class: 'cm-greeting' }, t.library));
  body.append(head);
  const by = (a, b) => a.localeCompare(b, ctx.prefs.locale);
  const grid = refs => bag.add(ctx.P.createVirtualGrid(body, { items: refs, itemKey: r => `${r.type}:${r.id}`, label: names[kind], minItemWidth: 150, gap: 12, estimate: 230, height: null, scroller: ctx.ws.main,
    render: ref => mediaCard(document.createElement('div'), ctx, ref) }, ctx.S));
  let list = null;

  if (kind === 'playlists') {
    const create = bag.add(ctx.UI.createButton(head, { label: t.newPlaylist, icon: 'plus', variant: 'secondary', onClick: async () => {
      const p = await ctx.adapter.playlistCreate(t.newPlaylistName(ctx.playlists.filter(x => x.kind === 'user').length + 1)).catch(err => { ctx.run(Promise.reject(err)); });
      if (p) ctx.go(`/playlist/${p.id}`);
    } }, ctx.S));
    create.element.classList.add('cm-libpage-new');
    const refs = () => ctx.playlists.map(p => ({ type: 'playlist', id: p.id }));
    const g = grid(refs());
    bag.add(ctx.on('playlists', () => g.update({ items: refs() })));
  } else if (kind === 'albums') {
    grid([...ctx.lib.albumList].sort((a, b) => by(a.title, b.title)).map(a => ({ type: 'album', id: a.id })));
  } else if (kind === 'artists') {
    grid([...ctx.lib.artistList].sort((a, b) => by(a.name, b.name)).map(a => ({ type: 'artist', id: a.id })));
  } else {
    // every song, as the "media library" playlist plays them: a tap plays from there on
    const ids = ctx.playlist('library')?.trackIds ?? ctx.lib.trackList.map(x => x.id);
    head.append(h('span', { class: 'cm-libpage-count' }, t.nSongs(ids.length)));
    list = trackList(body, ctx, bag, { kind: 'playlist', id: 'library', ids, label: t.songs, columns: ['title', 'album', 'like', 'duration'],
      virtual: ids.length > 600 ? { height: 'calc(100dvh - 15rem)' } : false, contextIds: () => ids });
  }
  return { title: `${t.library} · ${names[kind]}`, revealCurrent: () => list?.revealCurrent(), destroy: () => bag.destroy() };
}
