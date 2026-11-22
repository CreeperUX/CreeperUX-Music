// Lyrics in the main view, large, on the playing album's colour; the kit's lyrics view follows the song, stops
// following when the person scrolls, and seeks when a line is chosen.
import { h } from '../dom.js';
import { scope, tint } from './common.js';

export function lyricsView(holder, route, ctx) {
  const t = ctx.t, bag = scope();
  holder.classList.add('cm-lyrics-page');
  const head = h('div', { class: 'cm-lyrics-head' });
  const box = h('div', { class: 'cm-lyrics-box' });
  holder.append(head, box);
  const view = bag.add(ctx.M.createLyricsView(box, { label: t.lyrics, height: '100%', resumeAfter: 6000, state: 'loading', onSeek: e => ctx.run(ctx.adapter.seek(e.time)) }, ctx.S));
  let shownId = null, ctl = null;
  const load = () => {
    const tr = ctx.currentTrack();
    if (tr?.id === shownId) return;
    shownId = tr?.id ?? null;
    const al = tr && ctx.lib.albums.get(tr.albumId);
    tint(holder, al?.color);
    head.replaceChildren(...(tr ? [h('span', { class: 'cm-hero-kind' }, t.lyrics), h('h1', {}, tr.title), h('p', {}, tr.artist)] : [h('h1', {}, t.lyrics)]));
    if (!tr) { view.update({ lines: null, state: 'empty' }); return; }
    ctl?.abort(); ctl = new AbortController();
    const my = ctl;
    view.update({ lines: null, state: 'loading' });
    ctx.adapter.lyrics(tr.id, my.signal).then(lines => {
      if (my.signal.aborted) return;
      view.update(lines?.length ? { lines, state: 'ready', position: ctx.player.position } : { lines: [{ text: tr.instrumental ? t.instrumental : t.noLyrics }], synced: false, state: 'ready' });
    }, () => { if (!my.signal.aborted) view.update({ state: 'error' }); });
  };
  load();
  bag.add(ctx.on('player', load));
  bag.add(ctx.on('position', pos => view.update({ position: pos })));
  bag.add(() => ctl?.abort());
  return { title: t.lyrics, destroy: () => bag.destroy() };
}
