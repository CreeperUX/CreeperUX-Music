// A playlist: liked songs, the whole library, one of yours (reorder by dragging or Alt + ↑ ↓; the server confirms the
// order) or one you can only play (another user's, or a smart playlist).
import { h, ic, longDuration } from '../dom.js';
import { scope, tint, hero, actionRow, stickyBar, trackList } from './common.js';

export function playlistView(holder, route, ctx) {
  const t = ctx.t, bag = scope();
  let p = ctx.playlist(route.id);
  if (!p) { holder.append(h('p', { class: 'cm-pad' }, t.noResults(route.id))); return null; }
  tint(holder, ctx.playlistColor(p));
  holder.classList.add('cm-tinted');
  const own = p.kind === 'user';
  const kind = p.kind === 'auto' ? t.kindAuto : p.kind === 'library' ? t.kindLibrary : t.kindPlaylist;
  const total = () => p.trackIds.reduce((s, id) => s + (ctx.track(id)?.duration ?? 0), 0);
  const metaText = h('span', {}, `${t.nSongs(p.trackIds.length)}，${t.about(longDuration(total(), t))}`);
  const { titleEl } = hero(holder, ctx, bag, {
    kind, title: p.name, art: ctx.playlistArt(p), tintAlbum: ['liked', 'library'].includes(p.kind) ? null : ctx.track(p.trackIds[0])?.albumId, placeholder: p.kind === 'liked' ? 'heart-filled' : p.kind === 'library' ? 'library' : 'playlist',
    description: p.description, meta: [h('span', { class: 'cm-meta-strong' }, p.owner ?? ctx.adapter.account().user), metaText],
  });
  if (p.kind === 'auto' && p.query) titleEl.after(h('p', { class: 'cm-query' }, h('span', {}, t.autoplaylistQuery), h('code', { dir: 'ltr' }, p.query)));
  stickyBar(holder, ctx, bag, titleEl, { title: p.name, kind: 'playlist', id: p.id });

  const body = h('div', { class: 'cm-body' });
  holder.append(body);
  let filter = '', sorted = false;
  const visible = () => (filter ? p.trackIds.filter(id => { const x = ctx.track(id); return [x.title, x.artist, x.album].some(s => s.toLowerCase().includes(filter)); }) : p.trackIds);

  const menu = () => [
    { id: 'queue', label: t.addQueue, icon: 'queue' }, { id: 'next', label: t.playNext, icon: 'skip-next' },
    ...(own ? [{ separator: true }, { id: 'rename', label: t.rename, icon: 'edit' }, { id: 'delete', label: t.delete, icon: 'trash', danger: true }] : []),
  ];
  const onMenu = async item => {
    if (item.id === 'rename') {
      let field;
      const dlg = ctx.UI.createDialog({ title: t.renameTitle, size: 'sm',
        content: b => { field = ctx.UI.createTextField(b, { label: t.name, value: p.name, maxLength: 80 }, ctx.S); },
        initialFocus: () => field?.input,
        actions: [{ label: t.closePanel, value: null }, { label: t.rename, variant: 'primary', value: 'ok', onClick: () => { const v = field.value.trim(); if (!v) return false; ctx.run(ctx.adapter.playlistRename(p.id, v)); } }],
        onClose: () => setTimeout(() => dlg.destroy(), 400) }, ctx.S);
      dlg.open();
    } else if (item.id === 'delete') {
      if (await ctx.UI.confirm({ title: t.deleteConfirm(p.name), message: t.deleteMessage, confirmLabel: t.delete, danger: true }, ctx.S)) { await ctx.run(ctx.adapter.playlistDelete(p.id)); ctx.go('/'); }
    } else ctx.onTrackMenu(item, p.trackIds);
  };
  const row = actionRow(ctx, bag, { kind: 'playlist', id: p.id, label: p.name, ids: () => p.trackIds, menu, onMenu });
  // find in playlist (Spotify's search-in-playlist), at the row's end
  // Edit playlist (yours only): rows can be selected, and the row menu then acts on every selected song
  // (remove from this playlist, add to another, queue). Done clears the selection.
  if (own) {
    const editBtn = bag.add(ctx.UI.createToggleButton(row.root, { label: t.editPlaylist, icon: 'edit', variant: 'ghost', pressed: false,
      onPressedChange: e => {
        editBtn.update({ pressed: e.pressed });
        holder.toggleAttribute('data-editing', e.pressed);
        list.update(e.pressed ? { selectable: 'multiple' } : { selectable: false, selected: [] });
        list.list.table.update({ selectOnClick: e.pressed }); // the media list sets click-to-select only when it is created
      } }, ctx.S));
    editBtn.element.classList.add('cm-edit-toggle');
  }
  const tools = h('div', { class: 'cm-actions-end' });
  bag.add(ctx.UI.createSearchField(tools, { label: t.findInPlaylist, hideLabel: true, placeholder: t.findInPlaylist, onInput: e => { filter = e.value.trim().toLowerCase(); list.setIds(visible()); list.list.update({ reorderable: own && !filter && !sorted }); } }, ctx.S));
  row.root.append(tools);
  body.append(row.root);

  const list = trackList(body, ctx, bag, {
    kind: 'playlist', id: p.id, playlistId: p.id, ids: visible(), numbered: true, label: p.name, contextIds: () => visible(),
    virtual: p.trackIds.length > 600 ? { height: 'calc(100dvh - 15rem)' } : false, // a whole media library: only the rows in view
    columns: ['index', 'title', 'album', 'added', 'like', 'duration'],
    empty: { title: t.emptyPlaylist, message: t.emptyPlaylistMsg },
    onSortChange: e => { sorted = !!e; list.list.update({ reorderable: own && !filter && !sorted }); },
    onReorder: own ? e => ctx.run(ctx.adapter.playlistReorder(p.id, e.order, { keys: e.keys, before: e.before })) : undefined, // shown only once the server confirms
  });
  if (!own) list.list.update({ reorderable: false });
  bag.add(ctx.on('playlists', () => {
    const next = ctx.playlist(p.id);
    if (!next) return;
    const changed = next.trackIds.join() !== p.trackIds.join(), renamed = next.name !== p.name;
    p = next;
    if (renamed) { titleEl.textContent = p.name; }
    if (changed) { list.setIds(visible()); metaText.textContent = `${t.nSongs(p.trackIds.length)}，${t.about(longDuration(total(), t))}`; }
  }));
  return { title: p.name, revealCurrent: () => list.revealCurrent(), destroy: () => bag.destroy() };
}
