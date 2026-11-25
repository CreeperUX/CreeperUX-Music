// Where the music plays. On a server with Sonus Connect version 2 (the user's one session, docs/protocol/connect.md):
// the device picker lists this browser and the user's other devices; picking one moves playback there (a transfer, the
// only way it moves: rule 4), and each row says what that device is doing and its volume. Without it the picker lists
// this browser's audio outputs, as before. Used by the playback bar and the Now playing page (a phone has no bar).
// `whereText` is the "正在「手机」上播放" line the bar, the mini player and Now playing show.
import { h, ic } from '../dom.js';

const ICON = { desktop: 'computer', web: 'computer', speaker: 'speaker', phone: 'speaker', tablet: 'speaker', other: 'speaker' };

/** "正在「手机」上播放" while another device plays the session, "上次在「书房电脑」播放" when none does; '' otherwise. */
export function whereText(ctx) {
  const w = ctx.player.where;
  return !w ? '' : w.playing ? ctx.t.playingOn(w.name) : ctx.t.playedOn(w.name);
}

/** A line saying where the session plays, kept up to date; hidden when there is nothing to say. */
export function whereLine(ctx, cls = '') {
  const text = h('span', {});
  const el = h('p', { class: `cm-where ${cls}`.trim(), hidden: '' }, ic('speaker'), text);
  const render = () => { const s = whereText(ctx); text.textContent = s; el.hidden = !s; el.dataset.playing = String(!!ctx.player.where?.playing); };
  render();
  return { el, off: ctx.on('player', render) };
}

export function mountDevicePicker(slot, ctx, { placement = 'top-end' } = {}) {
  const { M, t, adapter } = ctx;
  const connect = () => !!adapter.connected?.();
  let moving = null; // the device playback is being moved to, until the session says it plays there
  const percent = d => (d.muted ? t.dev.muted : t.dev.volume(Math.round((d.volume ?? 1) * 100)));
  const sessionRows = () => ctx.devices.map(d => ({
    id: d.id, name: d.self ? t.dev.here : d.name, kind: ICON[d.kind] ?? 'speaker',
    state: !d.connected ? (d.self ? 'connecting' : 'unavailable') : moving === d.id && !d.active ? 'connecting' : !d.canPlay ? 'unavailable' : d.active ? 'connected' : 'available',
    detail: [d.status, d.canPlay ? percent(d) : ''].filter(Boolean).join(' · '),
  }));
  const current = () => (connect() ? ctx.devices.find(d => d.active)?.id ?? null : ctx.player.output);
  const rows = () => (connect() ? sessionRows() : ctx.outputs.map(o => ({ ...o })));
  const label = () => {
    if (!connect()) return t.output;
    const w = ctx.player.where;
    return w?.playing ? t.dev.elsewhere(w.name) : t.dev.label;
  };
  const picker = M.createDevicePicker(slot, { devices: rows(), current: current(), label: label(), placement,
    onSelect: e => {
      if (!connect()) { ctx.run(adapter.setOutput(e.id)); return; }
      moving = e.id; picker.update({ devices: rows() });
      ctx.run(adapter.transfer(e.id)).finally(() => { moving = null; picker.update({ devices: rows(), current: current() }); });
    } }, ctx.S);
  // in the accent colour while another device plays (as the Windows app's devices button)
  const mark = () => { slot.toggleAttribute('data-elsewhere', !!ctx.player.where?.playing); picker.button.title = label(); };
  const sync = () => { picker.update({ devices: rows(), current: current(), label: label() }); mark(); };
  mark();
  const offs = [ctx.on('devices', sync), ctx.on('outputs', () => { if (!connect()) sync(); }), ctx.on('player', ({ player, prev }) => { if (!prev || player.where?.name !== prev.where?.name || player.where?.playing !== prev.where?.playing || player.output !== prev.output || player.state !== prev.state) sync(); })];
  return { picker, destroy: () => { for (const off of offs) off?.(); picker.destroy(); } };
}
