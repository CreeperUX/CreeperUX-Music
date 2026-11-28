// Now playing as a page (#/now): the cover, the song, the seek bar, the transport and the lyrics on the album's
// colour. On a phone it is what the mini player opens (the playback bar and the side panel do not fit there); on a wide
// window it works as a large "stage" view. It holds no state: it shows the player and sends it commands, like the bar.
import { h, ic } from '../dom.js';
import { scope, tint } from './common.js';
import { orderToBar, barToOrder } from '../api/contract.js';
import { formatQualityBadge } from '../api/quality.js';
import { mountDevicePicker, whereLine } from '../shell/devices.js';

export function nowView(holder, route, ctx) {
  const { t, UI, M, P, S, adapter } = ctx, bag = scope();
  holder.classList.add('cm-now');
  const empty = h('div', { class: 'cm-now-empty' });
  const stage = h('div', { class: 'cm-now-stage' });
  holder.append(empty, stage);
  bag.add(UI.createEmptyState(empty, { title: t.nothingPlaying, message: t.nothingPlayingMsg, action: { label: t.home, onClick: () => ctx.go('/') } }, S));

  // ------------------------------------------------ the song
  const context = h('p', { class: 'cm-now-context' });
  const artBox = h('div', { class: 'cm-now-art' });
  const art = bag.add(P.createImage(artBox, { alt: '', lazy: false, placeholder: 'album', shape: 'rounded' }, S));
  const title = h('a', { class: 'cm-now-title' }), artist = h('a', { class: 'cm-now-artist' });
  const qualityBadge = h('span', { class: 'cm-quality-badge cm-now-quality', hidden: true });
  const names = h('div', { class: 'cm-now-names' }, h('h1', {}, title), artist, qualityBadge);
  const meta = h('div', { class: 'cm-now-meta' }, names);
  const like = bag.add(UI.createToggleButton(meta, { label: t.like, icon: 'heart', iconOnly: true, variant: 'ghost', pressed: false,
    onPressedChange: e => { const c = ctx.currentTrack(); if (c) ctx.setLiked(c.id, e.pressed); } }, S));
  like.element.classList.add('cm-now-like');

  // ------------------------------------------------ seek and transport
  const seekBox = h('div', { class: 'cm-now-seek' });
  const seek = bag.add(M.createSeekBar(seekBox, { position: ctx.player.position, duration: ctx.player.duration, onSeek: e => ctx.run(adapter.seek(e.position)) }, S));
  const transport = h('div', { class: 'cm-now-transport', role: 'group', 'aria-label': t.player });
  const btn = (label, icon, onClick, cls = '') => { const b = bag.add(UI.createIconButton(transport, { label, icon, onClick }, S)); if (cls) b.element.classList.add(...cls.split(' ')); return b; };
  const shuffle = btn(t.shuffle, 'shuffle', () => ctx.run(adapter.setOrder(barToOrder({ shuffle: !orderToBar(ctx.player.order).shuffle, repeat: 'off' }))), 'cm-now-toggle');
  btn(t.previous, 'skip-previous', () => ctx.run(adapter.previous()), 'cm-now-skip');
  const play = btn(t.play, 'play', () => ctx.togglePlay(), 'cm-now-play');
  btn(t.next, 'skip-next', () => ctx.run(adapter.next()), 'cm-now-skip');
  const NEXT_REPEAT = { off: 'all', all: 'one', one: 'off' };
  const repeat = btn(t.repeat, 'repeat', () => ctx.run(adapter.setOrder(barToOrder({ shuffle: false, repeat: NEXT_REPEAT[orderToBar(ctx.player.order).repeat] }))), 'cm-now-toggle');

  // ------------------------------------------------ what else: the queue, the album, the full lyrics
  const links = h('div', { class: 'cm-now-links' });
  bag.add(UI.createButton(links, { label: t.queue, icon: 'queue', variant: 'ghost', onClick: () => ctx.panel.show('queue') }, S));
  links.append(h('a', { class: 'cm-now-link', href: '#/lyrics' }, ic('lyrics'), h('span', {}, t.lyrics)));
  const albumLink = h('a', { class: 'cm-now-link' }, ic('album'), h('span', {}, t.goAlbum));
  links.append(albumLink);
  // where it plays, and the device picker (on a phone this page is the only place for it)
  const pickSlot = h('span', { class: 'cm-output cm-now-devices' });
  links.append(pickSlot);
  const devicePicker = mountDevicePicker(pickSlot, ctx, { placement: 'top' });
  bag.add(() => devicePicker.destroy());
  const where = whereLine(ctx, 'cm-now-where');
  bag.add(where.off);

  const lyricsBox = h('div', { class: 'cm-now-lyrics' });
  const lyrics = bag.add(M.createLyricsView(lyricsBox, { label: t.lyrics, height: '100%', resumeAfter: 5000, state: 'empty', onSeek: e => ctx.run(adapter.seek(e.time)) }, S));
  const main = h('div', { class: 'cm-now-main' }, context, artBox, meta, seekBox, transport, where.el, links);
  stage.append(main, lyricsBox);

  let shown = null, ctl = null;
  function render() {
    const c = ctx.currentTrack(), p = ctx.player;
    empty.hidden = !!c; stage.hidden = !c;
    if (!c) { tint(holder, null); return; }
    const o = orderToBar(p.order), playing = ctx.isActive();
    context.textContent = p.context?.label ? `${t.nowPlaying} · ${p.context.label}` : t.nowPlaying;
    like.update({ pressed: !!c.liked, icon: c.liked ? 'heart-filled' : 'heart', label: c.liked ? t.unlike : t.like });
    play.update({ icon: playing ? 'pause' : 'play', label: playing ? t.pause : t.play });
    shuffle.element.setAttribute('aria-pressed', String(o.shuffle));
    repeat.update({ icon: o.repeat === 'one' ? 'repeat-one' : 'repeat', label: o.repeat === 'one' ? t.repeatOne : o.repeat === 'all' ? t.repeatAll : t.repeat });
    repeat.element.setAttribute('aria-pressed', String(o.repeat !== 'off'));
    seek.update({ position: p.position, duration: p.duration });
    const qb = !p.remote && p.state !== 'error' && p.state !== 'stopped'
      ? formatQualityBadge({ ...(p.qualitySource ?? {}), track: c, locale: ctx.prefs.locale })
      : { text: '', isLossless: false };
    qualityBadge.hidden = !qb.text;
    qualityBadge.textContent = qb.text;
    qualityBadge.toggleAttribute('data-lossless', qb.isLossless);
    if (qb.text) qualityBadge.setAttribute('aria-label', t.currentQuality(qb.text));
    else qualityBadge.removeAttribute('aria-label');
    if (shown === c.id) return;
    shown = c.id;
    art.update({ src: ctx.art(c.albumId) });
    title.textContent = c.title; title.href = `#/album/${c.albumId}`;
    artist.textContent = c.artist; artist.href = `#/artist/${c.artistId}`;
    albumLink.href = `#/album/${c.albumId}`;
    tint(holder, ctx.lib.albums.get(c.albumId)?.color);
    ctx.albumColor(c.albumId).then(col => { if (col && shown === c.id) tint(holder, col); });
    ctl?.abort(); ctl = new AbortController();
    const my = ctl;
    lyrics.update({ lines: null, state: 'loading' });
    adapter.lyrics(c.id, my.signal).then(lines => {
      if (my.signal.aborted) return;
      lyrics.update(lines?.length ? { lines, state: 'ready', position: ctx.player.position } : { lines: [{ text: c.instrumental ? t.instrumental : t.noLyrics }], synced: false, state: 'ready' });
    }, () => { if (!my.signal.aborted) lyrics.update({ state: 'error' }); });
  }
  render();
  bag.add(ctx.on('player', render));
  bag.add(ctx.on('track', tr => { if (tr.id === ctx.player.trackId) render(); }));
  bag.add(ctx.on('position', pos => { if (!seek.dragging) seek.update({ position: pos }); lyrics.update({ position: pos }); }));
  bag.add(() => ctl?.abort());
  return { title: t.nowPlaying, destroy: () => bag.destroy() };
}
