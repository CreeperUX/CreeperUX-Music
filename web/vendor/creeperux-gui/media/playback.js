import { setup, fill, openMenu, PRESS_SCALE } from '../ui/index.js';
import { createSlider, createImage } from '../plus/index.js';
import { mediaStrings } from './strings.js';
import { registerMediaIcons } from './icons.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const rtlOf = el => el.ownerDocument.defaultView.getComputedStyle(el).direction === 'rtl';
/** Press feedback as the kit's buttons have it: the press and release roles through services.motion (D81). */
export function press(c, el) {
  c.on(el, 'pointerdown', e => { if (e.button || el.disabled || el.getAttribute('aria-disabled') === 'true') return; c.s.motion.animate(el, { sx: PRESS_SCALE, sy: PRESS_SCALE }, { role: 'press' }); });
  const up = () => c.s.motion.animate(el, { sx: 1, sy: 1 }, { role: 'release' });
  c.on(el, 'pointerup', up); c.on(el, 'pointerleave', up); c.on(el, 'pointercancel', up);
  return el;
}
/** An icon-only button in the kit's style; its label is its accessible name and its tooltip (G22). */
export function iconButton(c, icon, cls, variant = 'ghost') {
  const b = c.h('button', { type: 'button', class: `ui-button ui-media-button ${cls || ''}`.trim(), 'data-variant': variant, 'data-icon-only': '' }, c.icon(icon));
  b._icon = icon;
  return press(c, b);
}
/** A small pop for an indicator that changed (a heart filling): the control role (D81). */
export function pop(c, el) { const svg = el.querySelector('svg'); if (svg) c.s.motion.animate(svg, { sx: 1, sy: 1 }, { role: 'control', from: { sx: 0.7, sy: 0.7 } }).then(ok => { if (ok) c.s.motion.reset(svg); }); }
export function setIcon(c, b, icon) { if (b._icon !== icon) { b._icon = icon; fill(b, c.icon(icon)); } }
function setLabel(b, text) { if (b.getAttribute('aria-label') !== text) b.setAttribute('aria-label', text); }

// ---------------------------------------------------------------- seek bar
/**
 * createSeekBar(container, { position, duration, buffered, seekable = true, live, label, disabled, valueTextInterval = 15000,
 *   onSeekStart({ position }), onSeekPreview({ position }), onSeek({ position }), onSeekCancel({ position }) }, services)
 * → { root, slider, get dragging, update, destroy }
 * A track's position (2.5.0, G68), built on the slider's continuous-value contract (G59). The host sends `position`
 * (seconds) as playback runs; a drag shows the time under the pointer in a bubble and in the elapsed time without
 * waiting for the host, and ends in one onSeek (or onSeekCancel on Escape: the thumb returns to where playback is now).
 * Hovering shows the time at the pointer. ← → move 5 s, PageUp / PageDown 30 s, Home / End the start and the end; each
 * key is one onSeek. `seekable: false` (a stream that cannot seek) and an unknown `duration` keep the bar readable but
 * fixed; `live` shows "Live" for the length. Screen readers hear "1 minute 5 seconds of 3 minutes 20 seconds", changed
 * by playback at most every `valueTextInterval` ms while the bar has focus.
 */
export function createSeekBar(container, props = {}, services) {
  const c = setup(container, services, 'seek-bar'); mediaStrings(c.s);
  let p = { position: 0, duration: null, buffered: null, seekable: true, valueTextInterval: 15000, ...props };
  const elapsed = c.h('span', { class: 'ui-seek-time', 'aria-hidden': 'true' }), total = c.h('span', { class: 'ui-seek-time', 'aria-hidden': 'true' });
  const track = c.h('div', { class: 'ui-seek-track' });
  const el = c.own(c.h('div', { class: 'ui-seek' }, elapsed, track, total));
  const known = () => Number.isFinite(p.duration) && p.duration > 0 && !p.live;
  const clock = v => c.s.format.duration(v, { hours: known() && p.duration >= 3600 });
  const long = v => c.s.format.duration(v, { style: 'long' });
  let preview = null, hover = null;
  const sliderProps = () => ({
    label: p.label || c.s.t('player.position'), hideLabel: true, min: 0, max: known() ? p.duration : 1, step: 1, keyStep: 5, largeStep: 30,
    value: known() ? clamp(p.position || 0, 0, p.duration) : null, readOnly: !p.seekable || !known(), disabled: !!p.disabled,
    valueTextInterval: p.valueTextInterval,
  });
  const slider = createSlider(track, {
    ...sliderProps(), format: clock, valueText: v => c.s.t('player.positionText', { elapsed: long(v), total: long(p.duration) }),
    onDragStart: e => { preview = e.value; c.emit(el, 'seek-start', { position: e.value }, p.onSeekStart); },
    onInput: e => { if (!slider.dragging) return; preview = e.value; showTip(e.value); times(); c.emit(el, 'seek-preview', { position: e.value }, p.onSeekPreview); },
    onChange: e => { preview = null; hideTip(); times(); c.emit(el, 'seek', { position: e.value }, p.onSeek); },
    onCancel: e => { preview = null; hideTip(); times(); c.emit(el, 'seek-cancel', { position: e.value }, p.onSeekCancel); },
  }, c.s);
  const box = slider.root.querySelector('.ui-slider');
  const buffer = c.h('span', { class: 'ui-seek-buffer', 'aria-hidden': 'true' }), tip = c.h('span', { class: 'ui-seek-tip', 'aria-hidden': 'true', hidden: true });
  box.querySelector('.ui-slider-track').after(buffer); box.append(tip);
  function showTip(v) { if (!known()) return; tip.hidden = false; tip.textContent = clock(v); tip.style.setProperty('--ui-pos', `${(v / p.duration) * 100}%`); }
  function hideTip() { if (!slider.dragging && hover == null) tip.hidden = true; }
  function times() {
    elapsed.textContent = known() || p.live ? clock(preview ?? p.position ?? 0) : c.s.t('player.unknownTime');
    total.textContent = p.live ? c.s.t('player.live') : known() ? clock(p.duration) : c.s.t('player.unknownTime');
    el.toggleAttribute('data-previewing', preview != null);
    buffer.style.inlineSize = known() && Number.isFinite(p.buffered) ? `${clamp(p.buffered / p.duration, 0, 1) * 100}%` : '0';
  }
  // hovering shows the time at the pointer (not while dragging: the drag shows its own)
  c.on(box, 'pointermove', e => {
    if (slider.dragging || e.pointerType === 'touch' || !known() || !p.seekable || p.disabled) return;
    const r = box.getBoundingClientRect();
    let f = clamp((e.clientX - r.left) / (r.width || 1), 0, 1);
    if (rtlOf(box)) f = 1 - f;
    hover = f * p.duration; showTip(hover);
  });
  c.on(box, 'pointerleave', () => { hover = null; hideTip(); });
  el.toggleAttribute('data-live', !!p.live);
  times();
  c.cleanup(() => slider.destroy());
  container.append(el);
  return {
    root: el, slider, get dragging() { return slider.dragging; },
    update(n) {
      p = { ...p, ...n };
      el.toggleAttribute('data-live', !!p.live);
      // a position on its own is the frequent case: only the value moves
      if (Object.keys(n).every(k => k === 'position' || k === 'buffered')) { if ('position' in n && known()) slider.update({ value: clamp(p.position || 0, 0, p.duration) }); }
      else slider.update(sliderProps());
      times();
    },
    focus: () => slider.focus(),
    destroy: () => c.destroy(),
  };
}

// ---------------------------------------------------------------- volume
/**
 * createVolumeControl(container, { volume = 1 (0–1), muted, label, disabled, onVolume({ volume, final }), onMuteChange({ muted }) }, services)
 * → { root, slider, update, destroy }
 * A mute toggle and a volume slider (G68). The mute button keeps its name ("Mute") and says its state with
 * aria-pressed; its icon follows the level. The slider moves in 1 % steps, 5 % per arrow key; dragging reports
 * onVolume with `final: false`, the release with `final: true`. A muted control keeps its level (shown dimmed), so
 * unmuting returns to it. Volume changes from elsewhere (a hardware key) arrive through update and never move a thumb
 * that is being dragged.
 */
export function createVolumeControl(container, props = {}, services) {
  const c = setup(container, services, 'volume'); mediaStrings(c.s); registerMediaIcons();
  let p = { volume: 1, muted: false, ...props };
  const mute = iconButton(c, 'volume', 'ui-media-toggle ui-volume-mute');
  const slot = c.h('div', { class: 'ui-volume-slider' });
  const el = c.own(c.h('div', { class: 'ui-volume' }, mute, slot));
  const pct = v => c.s.format.percent(v / 100, 0);
  const slider = createSlider(slot, {
    label: p.label || c.s.t('player.volume'), hideLabel: true, min: 0, max: 100, step: 1, keyStep: 5, largeStep: 20, value: Math.round((p.volume ?? 1) * 100),
    format: pct, valueText: v => (p.muted ? c.s.t('player.mutedText', { volume: pct(v) }) : pct(v)),
    onInput: e => { if (slider.dragging) c.emit(el, 'volume', { volume: e.value / 100, final: false }, p.onVolume); },
    onChange: e => c.emit(el, 'volume', { volume: e.value / 100, final: true }, p.onVolume),
  }, c.s);
  function render() {
    const v = p.volume ?? 1;
    setIcon(c, mute, p.muted || v === 0 ? 'volume-mute' : v < 0.5 ? 'volume-low' : 'volume');
    setLabel(mute, c.s.t('player.mute'));
    mute.setAttribute('aria-pressed', String(!!p.muted));
    mute.disabled = !!p.disabled;
    el.toggleAttribute('data-muted', !!p.muted);
  }
  c.on(mute, 'click', () => c.emit(el, 'mute-change', { muted: !p.muted }, p.onMuteChange));
  c.cleanup(() => slider.destroy());
  render(); container.append(el);
  return {
    root: el, slider,
    update(n) { p = { ...p, ...n }; render(); slider.update({ ...('volume' in n ? { value: Math.round((p.volume ?? 1) * 100) } : {}), disabled: !!p.disabled, ...('label' in n ? { label: p.label || c.s.t('player.volume') } : {}) }); },
    destroy: () => c.destroy(),
  };
}

// ---------------------------------------------------------------- playback bar
const NEXT_REPEAT = { off: 'all', all: 'one', one: 'off' };
/**
 * createPlaybackBar(container, { track: { id, title, artist, album, artwork } | null, state: 'playing' | 'paused' |
 *   'stopped' | 'loading' | 'error', error, position, duration, buffered, seekable = true, live, canPrevious = true,
 *   canNext = true, shuffle: boolean | null, repeat: 'off' | 'all' | 'one' | null, liked: boolean | null, volume (0–1) | null,
 *   muted, actions: [{ id, icon, label, pressed, disabled }], onCommand({ command, value, id, event }) }, services)
 * → { root, seekBar, volume, update, destroy }
 * The persistent player bar (G68): the track (artwork, title, artist, like), the transport (shuffle, previous,
 * play / pause, next, repeat) over the seek bar, and the secondary actions (queue, lyrics, devices: `actions`) with the
 * volume. It shows what the host says and reports what the person asks for: every control emits a command
 * ('play', 'pause', 'retry', 'previous', 'next', 'shuffle' (value: the new state), 'repeat' (the next mode),
 * 'like', 'seek-start', 'seek-preview', 'seek', 'seek-cancel' (value: seconds), 'volume' (value: { volume, final }),
 * 'mute', 'open' (value: 'track'; the title and artist are one control), 'action' (id, value: the new pressed state)); nothing changes until the
 * host updates it. A position on its own updates only the seek bar, so the host can send it several times a second.
 * Toggles say their state with aria-pressed and a mark under the icon, not by colour alone; repeat names its mode.
 * 'loading' keeps the play button usable (busy); 'error' shows the message and turns Play into Try again.
 * Narrower than 48 rem the bar drops shuffle, repeat, like, the actions and the volume into a More menu; narrower than
 * 30 rem the seek bar takes its own row above the controls, and previous / next give way to play / pause.
 * Keyboard shortcuts (Space, media keys) belong to the app: register them with createShortcuts.
 */
export function createPlaybackBar(container, props = {}, services) {
  const c = setup(container, services, 'playback-bar'); mediaStrings(c.s); registerMediaIcons();
  let p = { state: 'stopped', position: 0, duration: null, seekable: true, canPrevious: true, canNext: true, shuffle: false, repeat: 'off', liked: null, volume: 1, muted: false, actions: [], ...props };
  const cmd = (command, value, extra = {}) => c.emit(el, 'command', { command, value, ...extra }, p.onCommand);
  // track
  const art = c.h('div', { class: 'ui-pb-art' });
  const image = createImage(art, { ratio: 1, placeholder: 'music', alt: '', lazy: false }, c.s);
  // title and artist are one control that opens the track: one 44 px target on touch screens (D12)
  const title = c.h('span', { class: 'ui-pb-title' }), artist = c.h('span', { class: 'ui-pb-artist' });
  const trackBtn = c.h('button', { type: 'button', class: 'ui-pb-track' }, title, c.h('span', { class: 'ui-visually-hidden' }, ', '), artist);
  const status = c.h('p', { class: 'ui-pb-status', role: 'status' });
  const like = iconButton(c, 'heart', 'ui-media-toggle ui-pb-like');
  const textBox = c.h('div', { class: 'ui-pb-text' }, trackBtn, status);
  const info = c.h('div', { class: 'ui-pb-info' }, art, textBox, like);
  let shown = { id: undefined, liked: undefined }; // what render last showed: a change gets its motion (D81)
  // transport
  const shuffle = iconButton(c, 'shuffle', 'ui-media-toggle'), prev = iconButton(c, 'skip-previous', 'ui-pb-prev'), play = iconButton(c, 'play', 'ui-pb-play', 'primary');
  const next = iconButton(c, 'skip-next', 'ui-pb-next'), repeat = iconButton(c, 'repeat', 'ui-media-toggle');
  const transport = c.h('div', { class: 'ui-pb-transport', role: 'group' }, shuffle, prev, play, next, repeat);
  const seekSlot = c.h('div', { class: 'ui-pb-seek' });
  const seekBar = createSeekBar(seekSlot, {
    position: p.position, duration: p.duration, buffered: p.buffered, seekable: p.seekable, live: p.live,
    onSeekStart: e => cmd('seek-start', e.position), onSeekPreview: e => cmd('seek-preview', e.position), onSeek: e => cmd('seek', e.position), onSeekCancel: e => cmd('seek-cancel', e.position),
  }, c.s);
  const center = c.h('div', { class: 'ui-pb-center' }, transport, seekSlot);
  // secondary actions and volume
  const actsEl = c.h('div', { class: 'ui-pb-actions' });
  const volSlot = c.h('div', { class: 'ui-pb-volume' });
  const volume = createVolumeControl(volSlot, { volume: p.volume ?? 1, muted: p.muted, onVolume: e => cmd('volume', e), onMuteChange: e => cmd('mute', e.muted) }, c.s);
  const more = iconButton(c, 'more', 'ui-pb-more');
  more.setAttribute('aria-haspopup', 'menu'); more.setAttribute('aria-expanded', 'false');
  const extras = c.h('div', { class: 'ui-pb-extras' }, actsEl, volSlot, more);
  const el = c.own(c.h('div', { class: 'ui-pb' }, info, center, extras));
  let actionEls = new Map(), menu = null;
  const said = new Set(); // modes the person asked to change; each is read out once the host settles it
  function renderActions() {
    const ids = (p.actions || []).map(a => a.id).join('\u0000');
    if (ids !== [...actionEls.keys()].join('\u0000')) {
      actionEls = new Map((p.actions || []).map(a => { const b = iconButton(c, a.icon, typeof a.pressed === 'boolean' ? 'ui-media-toggle' : ''); b._id = a.id; return [a.id, b]; }));
      fill(actsEl, [...actionEls.values()]);
    }
    for (const a of p.actions || []) {
      const b = actionEls.get(a.id);
      setIcon(c, b, a.icon); setLabel(b, a.label);
      if (typeof a.pressed === 'boolean') b.setAttribute('aria-pressed', String(a.pressed)); else b.removeAttribute('aria-pressed');
      b.disabled = !!a.disabled;
    }
  }
  function render() {
    const t = p.track, playing = p.state === 'playing', err = p.state === 'error';
    // a new track: its title and artist fade in (a content swap, D27); the artwork fades in by itself (G61)
    if (shown.id !== undefined && (t?.id ?? null) !== shown.id) c.s.motion.animate(textBox, { o: 1 }, { role: 'view', from: { o: 0 } }).then(ok => { if (ok) c.s.motion.reset(textBox); });
    const likedNow = !!p.liked, likeChanged = shown.liked !== undefined && likedNow !== shown.liked && (t?.id ?? null) === shown.id;
    shown = { id: t?.id ?? null, liked: likedNow };
    el.dataset.state = p.state;
    el.toggleAttribute('data-empty', !t);
    image.update({ src: t?.artwork ?? null });
    title.textContent = t?.title ?? c.s.t('player.nothing'); trackBtn.disabled = !t || !p.onCommand;
    artist.textContent = t?.artist ?? ''; artist.hidden = !t?.artist; artist.previousSibling.hidden = !t?.artist;
    status.textContent = err ? (p.error || c.s.t('player.error')) : ''; status.hidden = !err; status.title = status.textContent;
    like.hidden = p.liked == null || !t;
    setIcon(c, like, p.liked ? 'heart-filled' : 'heart'); setLabel(like, c.s.t('player.like')); like.setAttribute('aria-pressed', String(!!p.liked));
    if (likeChanged) pop(c, like);
    transport.setAttribute('aria-label', c.s.t('player.controls'));
    setIcon(c, play, err ? 'refresh' : playing ? 'pause' : 'play');
    setLabel(play, err ? c.s.t('player.retry') : c.s.t(playing ? 'player.pause' : 'player.play'));
    if (p.state === 'loading') play.setAttribute('aria-busy', 'true'); else play.removeAttribute('aria-busy');
    play.disabled = !t;
    setLabel(prev, c.s.t('player.previous')); prev.disabled = !t || !p.canPrevious;
    setLabel(next, c.s.t('player.next')); next.disabled = !t || !p.canNext;
    shuffle.hidden = p.shuffle == null; setLabel(shuffle, c.s.t('player.shuffle')); shuffle.setAttribute('aria-pressed', String(!!p.shuffle));
    repeat.hidden = p.repeat == null;
    setIcon(c, repeat, p.repeat === 'one' ? 'repeat-one' : 'repeat'); setLabel(repeat, c.s.t(`player.repeat.${p.repeat || 'off'}`)); repeat.setAttribute('aria-pressed', String(!!p.repeat && p.repeat !== 'off'));
    setLabel(more, c.s.t('player.more'));
    volSlot.hidden = p.volume == null;
    renderActions();
  }
  // the person asked for a mode: say the mode the host settles on (a toggle's new name is not always read out)
  function confirmSaid(n) {
    if (said.has('shuffle') && 'shuffle' in n) { said.delete('shuffle'); c.s.announce(c.s.t(p.shuffle ? 'player.shuffleOn' : 'player.shuffleOff')); }
    if (said.has('repeat') && 'repeat' in n) { said.delete('repeat'); c.s.announce(c.s.t(`player.repeat.${p.repeat || 'off'}`)); }
    if (said.has('like') && 'liked' in n) { said.delete('like'); c.s.announce(c.s.t(p.liked ? 'player.liked' : 'player.unliked')); }
  }
  c.on(play, 'click', e => { if (!p.track) return; cmd(p.state === 'error' ? 'retry' : p.state === 'playing' ? 'pause' : 'play', undefined, { event: e }); });
  c.on(prev, 'click', e => cmd('previous', undefined, { event: e }));
  c.on(next, 'click', e => cmd('next', undefined, { event: e }));
  c.on(shuffle, 'click', e => { said.add('shuffle'); cmd('shuffle', !p.shuffle, { event: e }); });
  c.on(repeat, 'click', e => { said.add('repeat'); cmd('repeat', NEXT_REPEAT[p.repeat || 'off'], { event: e }); });
  c.on(like, 'click', e => { said.add('like'); cmd('like', !p.liked, { event: e }); });
  c.on(trackBtn, 'click', e => cmd('open', 'track', { event: e }));
  c.on(actsEl, 'click', e => { const b = e.target.closest('.ui-media-button'); if (!b) return; const a = p.actions.find(x => x.id === b._id); cmd('action', typeof a?.pressed === 'boolean' ? !a.pressed : undefined, { id: b._id, event: e }); });
  // the narrow layout keeps the rest in a menu
  c.on(more, 'click', () => {
    const items = [
      ...(p.shuffle == null ? [] : [{ id: '@shuffle', label: c.s.t('player.shuffle'), checked: !!p.shuffle }]),
      ...(p.repeat == null ? [] : [{ id: '@repeat', label: c.s.t(`player.repeat.${NEXT_REPEAT[p.repeat || 'off']}`), icon: NEXT_REPEAT[p.repeat || 'off'] === 'one' ? 'repeat-one' : 'repeat' }]),
      ...(p.actions || []).map(a => ({ id: a.id, label: a.label, icon: a.icon, disabled: a.disabled, ...(typeof a.pressed === 'boolean' ? { checked: a.pressed } : {}) })),
      ...(p.volume == null ? [] : [{ id: '@mute', label: c.s.t('player.mute'), checked: !!p.muted }]),
      ...(p.liked == null || !p.track ? [] : [{ id: '@like', label: c.s.t('player.like'), checked: !!p.liked }]), // hidden from the bar at this width
    ];
    menu?.close('switch', { restoreFocus: false });
    more.setAttribute('aria-expanded', 'true');
    menu = openMenu(c.s, { items, trigger: more, anchor: more, placement: 'top-end', label: c.s.t('player.more'), onClose: () => { more.setAttribute('aria-expanded', 'false'); menu = null; },
      onSelect: item => {
        if (item.id === '@shuffle') { said.add('shuffle'); cmd('shuffle', !p.shuffle); }
        else if (item.id === '@repeat') { said.add('repeat'); cmd('repeat', NEXT_REPEAT[p.repeat || 'off']); }
        else if (item.id === '@mute') cmd('mute', !p.muted);
        else if (item.id === '@like') { said.add('like'); cmd('like', !p.liked); }
        else { const a = p.actions.find(x => x.id === item.id); cmd('action', typeof a?.pressed === 'boolean' ? !a.pressed : undefined, { id: item.id }); }
      } });
  });
  const ro = new c.win.ResizeObserver(() => { const rem = parseFloat(c.win.getComputedStyle(c.doc.documentElement).fontSize) || 16, w = el.clientWidth; el.dataset.size = w < 30 * rem ? 'mini' : w < 48 * rem ? 'compact' : 'full'; });
  ro.observe(el);
  c.cleanup(() => { ro.disconnect(); menu?.close('destroy', { restoreFocus: false }); seekBar.destroy(); volume.destroy(); image.destroy(); });
  render(); container.append(el);
  return {
    root: el, seekBar, volume,
    update(n) {
      p = { ...p, ...n };
      const keys = Object.keys(n);
      if (keys.some(k => ['position', 'duration', 'buffered', 'seekable', 'live', 'track'].includes(k))) seekBar.update({ position: p.position, ...(keys.some(k => k !== 'position' && k !== 'buffered') ? { duration: p.duration, seekable: p.seekable, live: p.live, disabled: !p.track } : {}), ...('buffered' in n ? { buffered: p.buffered } : {}) });
      if (keys.every(k => k === 'position' || k === 'buffered')) return; // the frequent case: nothing else changes
      if ('volume' in n || 'muted' in n) volume.update({ volume: p.volume ?? 1, muted: !!p.muted });
      render(); confirmSaid(n);
    },
    destroy: () => c.destroy(),
  };
}
