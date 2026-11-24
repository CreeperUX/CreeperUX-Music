// The end side: Now playing (artwork, title, like; then lyrics, the file's audio details, the artist and what plays
// next, as cards) or the Queue (songs queued by hand, then the rest of what is playing).
import { h, ic } from '../dom.js';
import { badges, factsList } from '../views/common.js';

export function mountPanel(slot, ctx) {
  const { UI, M, t } = ctx;
  const el = h('div', { class: 'cm-panel' });
  slot.append(el);
  const head = h('div', { class: 'cm-panel-head' });
  const heading = h('h2', { class: 'cm-panel-title' });
  head.append(heading);
  el.append(head);
  const orderMenu = UI.createMenuButton(head, { label: t.playbackOrder, icon: 'more', iconOnly: true, variant: 'ghost', placement: 'bottom-end',
    items: () => [
      { heading: t.playbackOrder }, ...Object.entries(t.orders).map(([id, label]) => ({ id: `order:${id}`, label, type: 'radio', group: 'order', checked: ctx.player.order === id })),
      { separator: true }, { id: 'stop', label: t.stopAfterCurrent, checked: ctx.player.stopAfterCurrent },
      ...(ctx.adapter.capabilities?.replayGain === false ? [] : [{ heading: t.replayGainMode }, ...Object.entries(t.rgModes).map(([id, label]) => ({ id: `rg:${id}`, label, type: 'radio', group: 'rg', checked: ctx.player.replayGain === id }))]),
    ],
    onSelect: e => {
      const [k, v] = e.item.id.split(':');
      if (k === 'order') ctx.run(ctx.adapter.setOrder(v));
      else if (k === 'rg') ctx.run(ctx.adapter.setReplayGain(v));
      else if (k === 'stop') ctx.run(ctx.adapter.setStopAfterCurrent(!ctx.player.stopAfterCurrent));
    } }, ctx.S);
  orderMenu.element.classList.add('cm-round');
  const close = UI.createIconButton(head, { label: t.closePanel, icon: 'close', variant: 'ghost', onClick: () => ctx.ws.close('end') }, ctx.S);
  close.element.classList.add('cm-round');

  const nowBox = h('div', { class: 'cm-panel-now' }), queueBox = h('div', { class: 'cm-panel-queue' });
  el.append(nowBox, queueBox);

  // ------------------------------------------------ now playing
  const np = M.createNowPlaying(nowBox, { level: 3, onLike: e => { const c = ctx.currentTrack(); if (c) ctx.setLiked(c.id, e.liked); },
    onOpen: e => { const c = ctx.currentTrack(); if (!c) return; ctx.go(e.part === 'artist' ? `/artist/${c.artistId}` : `/album/${c.albumId}`); } }, ctx.S);
  const card = (cls, title, ...kids) => h('section', { class: `cm-card ${cls}` }, h('h3', { class: 'cm-card-title' }, ...[title].flat()), ...kids);
  // lyrics card
  const lyricsBox = h('div', { class: 'cm-card-lyrics' });
  const lyricsCard = card('cm-card-tinted', [t.lyrics, h('a', { class: 'cm-card-link', href: '#/lyrics', 'aria-label': t.lyricsFull }, ic('expand'))], lyricsBox);
  const lyrics = M.createLyricsView(lyricsBox, { label: t.lyrics, height: '15rem', resumeAfter: 5000, state: 'empty', onSeek: e => ctx.run(ctx.adapter.seek(e.time)) }, ctx.S);
  // audio card
  const audioBody = h('div', {});
  const audioCard = card('', t.fileInfo, audioBody);
  // artist card
  const artistArt = h('div', { class: 'cm-card-banner' });
  const artistImg = ctx.P.createImage(artistArt, { alt: '', ratio: '16 / 10', placeholder: 'artist' }, ctx.S);
  const artistName = h('a', { class: 'cm-card-name' }), artistMeta = h('p', { class: 'cm-card-meta' });
  const artistCard = card('cm-card-artist', t.aboutArtist, artistArt, artistName, artistMeta);
  // next card
  const nextBody = h('div', { class: 'cm-card-next' });
  const openQueue = h('button', { type: 'button', class: 'cm-card-link', onClick: () => show('queue') }, t.openQueue);
  const nextCard = card('', [t.nextUp, openQueue], nextBody);
  np.body.append(lyricsCard, audioCard, artistCard, nextCard);
  let nextCardHandle = null;

  let shownTrack = null, lyricsCtl = null;
  function renderNow() {
    const c = ctx.currentTrack();
    np.update({ track: c ? { title: c.title, artist: c.artist, album: c.album, artwork: ctx.art(c.albumId) } : null, liked: c ? !!c.liked : null, playing: ctx.isActive() });
    np.body.hidden = !c;
    if (!c) return;
    const al = ctx.lib.albums.get(c.albumId), ar = ctx.lib.artists.get(c.artistId);
    el.style.setProperty('--cm-tint', al?.color ?? '#3a4148');
    if (al && !al.color) ctx.albumColor(al.id).then(col => { if (col && ctx.player.trackId === c.id) el.style.setProperty('--cm-tint', col); });
    audioBody.replaceChildren(badges(ctx, c), factsList(ctx, c));
    if (shownTrack !== c.id) {
      shownTrack = c.id;
      artistImg.update({ src: ctx.art(ar?.albumIds.at(-1)) });
      artistName.textContent = ar?.name ?? c.artist; artistName.href = `#/artist/${c.artistId}`;
      const n = ar?.albumIds.length ?? 0, songs = ar?.albumIds.reduce((s, id) => s + (ctx.lib.albums.get(id)?.trackIds.length ?? 0), 0) ?? 0;
      artistMeta.textContent = `${ar?.genre ?? ''} · ${t.nAlbums(n)} · ${t.nSongs(songs)}`;
      lyricsCtl?.abort(); lyricsCtl = new AbortController();
      const my = lyricsCtl;
      lyrics.update({ lines: null, state: 'loading' });
      ctx.adapter.lyrics(c.id, my.signal).then(lines => {
        if (my.signal.aborted) return;
        lyrics.update(lines?.length ? { lines, synced: true, state: 'ready', position: ctx.player.position } : { lines: [{ text: c.instrumental ? t.instrumental : t.noLyrics }], synced: false, state: 'ready' });
      }, () => { if (!my.signal.aborted) lyrics.update({ state: 'error' }); });
    }
  }
  function renderNext() {
    const n = ctx.queue[0], tr = n && ctx.track(n.trackId);
    nextCardHandle?.destroy(); nextCardHandle = null; nextBody.replaceChildren();
    if (!tr) { nextBody.append(h('p', { class: 'cm-card-meta' }, t.nothingNext)); return; }
    nextCardHandle = ctx.P.createMediaCard(nextBody, { title: tr.title, subtitle: tr.artist, layout: 'row', artwork: { src: ctx.art(tr.albumId), alt: '' }, level: 4,
      onOpen: () => ctx.go(`/album/${tr.albumId}`), onPlay: () => playEntry(n), playLabel: t.playX(tr.title) }, ctx.S);
  }

  // ------------------------------------------------ queue
  const toKit = e => ({ ...ctx.kitTrack(ctx.track(e.trackId)), id: e.id, section: e.section, _trackId: e.trackId });
  const ql = M.createQueueList(queueBox, { tracks: [], label: t.queue, sections: {},
    onPlay: e => playEntry(ctx.queue.find(q => q.id === e.id)),
    onReorder: e => ctx.run(ctx.adapter.queueMove({ order: e.order, keys: e.keys, section: e.section })), // shown once the client confirms
    onRemove: e => ctx.run(ctx.adapter.queueRemove(e.ids)),
    onClear: e => ctx.run(ctx.adapter.queueClear(e.section)),
    menu: tr => ctx.trackMenu([tr._trackId]).filter(i => i.id !== 'queue'),
    onMenu: e => ctx.onTrackMenu(e.item, [e.track._trackId]) }, ctx.S);
  function renderQueue() {
    const c = ctx.currentTrack();
    ql.update({ tracks: ctx.queue.map(toKit), current: c ? { ...ctx.kitTrack(c), id: `now:${c.id}` } : null, playing: ctx.isActive(),
      sections: { queue: t.nextUp, context: t.nextFrom(ctx.player.context?.label ?? t.library) } });
  }
  async function playEntry(entry) {
    if (!entry) return;
    if (ctx.adapter.playQueueEntry) { await ctx.run(ctx.adapter.playQueueEntry(entry.id)); return; }
    await ctx.run(ctx.adapter.queueRemove([entry.id]));
    await ctx.run(ctx.adapter.queueAdd([entry.trackId], { next: true }));
    await ctx.run(ctx.adapter.next());
  }

  // ------------------------------------------------ modes
  let mode = ctx.prefs.panel === 'queue' ? 'queue' : 'now';
  function sync() {
    nowBox.hidden = mode !== 'now'; queueBox.hidden = mode !== 'queue';
    const c = ctx.currentTrack();
    heading.textContent = mode === 'queue' ? t.queue : (ctx.player.context?.label || c?.album || t.nowPlaying);
    el.dataset.mode = mode;
    ctx.emit('panel', mode);
  }
  function show(m) {
    const changed = m !== mode;
    mode = m; ctx.prefs.panel = m; ctx.savePrefs(); sync();
    if (!ctx.ws.layout.end.open) ctx.ws.open('end');
    else if (changed) ctx.motion?.reveal(m === 'queue' ? queueBox : nowBox); // Now playing ↔ queue
  }
  ctx.panel = {
    get mode() { return mode; },
    show,
    toggle(m) { if (ctx.ws.layout.end.open && mode === m) ctx.ws.close('end'); else show(m); },
  };

  renderNow(); renderNext(); renderQueue(); sync();
  ctx.on('player', ({ player, prev }) => {
    if (player.trackId !== prev?.trackId || player.state !== prev?.state || player.context?.label !== prev?.context?.label) { renderNow(); renderQueue(); sync(); }
  });
  ctx.on('track', tr => { if (tr.id === ctx.player.trackId) renderNow(); });
  ctx.on('position', pos => lyrics.update({ position: pos }));
  ctx.on('queue', () => { renderQueue(); renderNext(); });
}
