// The bottom of a phone-width window: a mini player (cover, song, like, play / pause, a line of progress; tapping it
// opens Now playing, #/now) above three tabs (Home, Search, Library). It sits in the workspace's bottom region next to
// the playback bar; the stylesheet shows one or the other by width (--cm-phone, styles.css), so nothing here measures
// the window, and both follow the same player.
import { h, ic } from '../dom.js';

export function mountPhone(slot, ctx) {
  const { t, P, S } = ctx;
  const root = h('div', { class: 'cm-phone' });
  slot.append(root);

  // ------------------------------------------------ the mini player
  const artBox = h('span', { class: 'cm-mini-art' });
  const art = P.createImage(artBox, { alt: '', lazy: false, placeholder: 'music', shape: 'rounded' }, S);
  const title = h('span', { class: 'cm-mini-title' }), artist = h('span', { class: 'cm-mini-artist' });
  const open = h('a', { class: 'cm-mini-open', href: '#/now', title: t.openNow }, artBox, h('span', { class: 'cm-mini-text' }, title, artist));
  const like = h('button', { type: 'button', class: 'cm-mini-btn', onClick: () => { const c = ctx.currentTrack(); if (c) ctx.setLiked(c.id, !c.liked); } });
  const play = h('button', { type: 'button', class: 'cm-mini-btn cm-mini-play', onClick: () => ctx.togglePlay() });
  const line = h('span', { class: 'cm-mini-line', 'aria-hidden': 'true' }, h('i'));
  const mini = h('div', { class: 'cm-mini', role: 'group', 'aria-label': t.player }, open, like, play, line);
  root.append(mini);

  let shown;
  function render() {
    const c = ctx.currentTrack(), playing = ctx.isActive();
    mini.hidden = !c;
    if (!c) { shown = null; return; }
    if (shown !== c.id) { shown = c.id; art.update({ src: ctx.art(c.albumId) }); title.textContent = c.title; artist.textContent = c.artist; }
    like.replaceChildren(ic(c.liked ? 'heart-filled' : 'heart')); like.setAttribute('aria-label', c.liked ? t.unlike : t.like); like.setAttribute('aria-pressed', String(!!c.liked));
    play.replaceChildren(ic(playing ? 'pause' : 'play')); play.setAttribute('aria-label', playing ? t.pause : t.play);
    mini.dataset.state = ctx.player.state;
    progress(ctx.player.position);
  }
  const progress = pos => { const d = ctx.player.duration; line.firstChild.style.width = d > 0 ? `${Math.min(100, Math.max(0, pos / d * 100))}%` : '0'; };
  render();
  ctx.on('player', render);
  ctx.on('track', tr => { if (tr.id === ctx.player.trackId) render(); });
  ctx.on('position', progress);

  // ------------------------------------------------ the tabs
  const tab = (href, icon, label, on) => { const a = h('a', { class: 'cm-tab', href }, ic(icon), h('span', {}, label)); a.on = on; return a; };
  const tabs = [
    tab('#/', 'home', t.home, r => r.name === 'home' || r.name === 'shelf'),
    tab('#/search/', 'search', t.search, r => r.name === 'search' || r.name === 'genre'),
    tab('#/library', 'library', t.library, r => ['library', 'album', 'artist', 'playlist'].includes(r.name)),
  ];
  root.append(h('nav', { class: 'cm-tabs', 'aria-label': t.nav }, tabs));
  const mark = route => { for (const a of tabs) { if (a.on(route)) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); } };
  mark(ctx.route);
  ctx.on('route', ({ route }) => mark(route));
}
