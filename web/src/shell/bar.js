// The playback bar along the bottom: the kit's PlaybackBar, with the playback order behind its shuffle and
// repeat controls, the output device picker, and the Now playing / Lyrics / Queue actions.
import { h } from '../dom.js';
import { orderToBar, barToOrder } from '../api/contract.js';
import { mountDevicePicker, whereLine } from './devices.js';

export function mountBar(slot, ctx) {
  const { M, t, adapter } = ctx;
  const actions = () => {
    const open = ctx.ws.layout.end.open, mode = ctx.panel?.mode;
    return [
      { id: 'now', icon: 'panel-right', label: t.nowPlayingView, pressed: open && mode === 'now' },
      { id: 'lyrics', icon: 'lyrics', label: t.lyrics, pressed: ctx.route.name === 'lyrics' },
      { id: 'queue', icon: 'queue', label: t.queue, pressed: open && mode === 'queue' },
    ];
  };
  const state = () => {
    const p = ctx.player, c = ctx.currentTrack(), o = orderToBar(p.order);
    return {
      track: c ? { id: c.id, title: c.title, artist: c.artist, album: c.album, artwork: ctx.art(c.albumId) } : null,
      state: p.state === 'stopped' && c ? 'paused' : p.state, error: p.error ?? undefined, position: p.position, duration: c ? p.duration : null,
      liked: c ? !!c.liked : null, shuffle: o.shuffle, repeat: o.repeat, volume: p.volume, muted: p.muted, canPrevious: !!c, canNext: !!c,
    };
  };
  const bar = M.createPlaybackBar(slot, { ...state(), actions: actions(), onCommand: e => {
    const c = ctx.currentTrack();
    switch (e.command) {
      case 'play': ctx.togglePlay(); break;
      case 'pause': ctx.run(adapter.pause()); break;
      case 'retry': ctx.run(adapter.resume()); break;
      case 'next': ctx.run(adapter.next()); break;
      case 'previous': ctx.run(adapter.previous()); break;
      case 'shuffle': ctx.run(adapter.setOrder(barToOrder({ shuffle: e.value, repeat: 'off' }))); break; // the orders exclude each other
      case 'repeat': ctx.run(adapter.setOrder(barToOrder({ shuffle: false, repeat: e.value }))); break;
      case 'like': if (c) ctx.setLiked(c.id, e.value); break;
      case 'seek': ctx.run(adapter.seek(e.value)); break;
      case 'volume': ctx.run(adapter.setVolume(e.value.volume)); break;
      case 'mute': ctx.run(adapter.setMuted(e.value)); break;
      case 'open': if (c) ctx.go(`/album/${c.albumId}`); break;
      case 'action':
        if (e.id === 'lyrics') { if (ctx.route.name === 'lyrics') ctx.back(); else ctx.go('/lyrics'); }
        else ctx.panel.toggle(e.id);
        break;
      default: break;
    }
  } }, ctx.S);
  bar.root.classList.add('cm-bar');

  // the device picker sits with the actions, before the volume (Spotify's "Connect to a device"): the user's devices
  // with Sonus Connect, this browser's audio outputs without it (shell/devices.js)
  const extras = bar.root.querySelector('.ui-pb-extras'), volume = bar.root.querySelector('.ui-pb-volume');
  const pickSlot = h('span', { class: 'cm-output' });
  if (extras && volume && ctx.adapter.capabilities?.outputs !== false) extras.insertBefore(pickSlot, volume);
  mountDevicePicker(pickSlot, ctx);
  // "正在「手机」上播放": a strip under the bar while another device plays (or played last)
  bar.root.after(whereLine(ctx, 'cm-bar-where').el);
  // the volume is the playing device's while another one plays (rule 8)
  const volumeLabel = () => { const r = ctx.player.remote; if (volume) { volume.title = r ? t.dev.volumeOf(r.name) : ''; volume.toggleAttribute('data-remote', !!r); } };

  ctx.on('player', () => { bar.update(state()); volumeLabel(); });
  ctx.on('position', pos => bar.update({ position: pos }));
  ctx.on('track', tr => { if (tr.id === ctx.player.trackId) bar.update({ liked: !!tr.liked }); });
  const syncActions = () => bar.update({ actions: actions() });
  ctx.on('route', syncActions); ctx.on('layout', syncActions); ctx.on('panel', syncActions);
}
