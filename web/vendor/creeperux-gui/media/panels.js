import { setup, fill, uid, createPopover, createEmptyState, createSpinner } from '../ui/index.js';
import { createImage } from '../plus/index.js';
import { mediaStrings } from './strings.js';
import { registerMediaIcons } from './icons.js';
import { iconButton, setIcon, press, pop } from './playback.js';

// ---------------------------------------------------------------- now playing
/**
 * createNowPlaying(container, { track: { title, artist, album, artwork } | null, liked: boolean | null, playing, level = 2,
 *   label, onLike({ liked }), onOpen({ part: 'track' | 'artist' | 'album' }) }, services) → { root, body, image, update, destroy }
 * The details of the loaded track (G68): its artwork large, title, artist and album, and a like toggle. `body` is the
 * host's slot underneath (credits, lyrics, what plays next). Rapid track changes never show old artwork: the image
 * takes the newest source only (G61). With no track it says "Nothing playing".
 */
export function createNowPlaying(container, props = {}, services) {
  const c = setup(container, services, 'now-playing'); mediaStrings(c.s); registerMediaIcons();
  let p = { level: 2, liked: null, ...props };
  const art = c.h('div', { class: 'ui-np-art' });
  const image = createImage(art, { ratio: 1, placeholder: 'music', alt: '', lazy: false }, c.s);
  const title = c.h(`h${p.level}`, { class: 'ui-np-title' });
  const artist = c.h('p', { class: 'ui-np-artist' }), album = c.h('p', { class: 'ui-np-album' });
  const like = iconButton(c, 'heart', 'ui-media-toggle ui-np-like');
  const body = c.h('div', { class: 'ui-np-body' });
  const head = c.h('div', { class: 'ui-np-head' }, c.h('div', { class: 'ui-np-text' }, title, artist, album), like);
  const el = c.own(c.h('section', { class: 'ui-np' }, art, head, body));
  let shown = null; // the track and like state last shown: a change gets its motion (D81)
  const link = (text, part) => (p.onOpen && text ? Object.assign(c.h('button', { type: 'button', class: 'ui-np-link' }, text), { _part: part }) : text ?? '');
  function render() {
    const t = p.track, key = t ? `${t.title}\u0000${t.artist ?? ''}` : null;
    if (shown && shown.key !== key) c.s.motion.animate(head, { o: 1 }, { role: 'view', from: { o: 0 } }).then(ok => { if (ok) c.s.motion.reset(head); }); // a new track: a content swap
    const likeChanged = shown && shown.key === key && shown.liked !== !!p.liked;
    shown = { key, liked: !!p.liked };
    el.toggleAttribute('data-empty', !t);
    el.setAttribute('aria-label', p.label || c.s.t('queue.now'));
    image.update({ src: t?.artwork ?? null, alt: t?.album ? t.album : '' });
    fill(title, t ? link(t.title, 'track') : c.s.t('player.nothing'));
    fill(artist, link(t?.artist, 'artist')); artist.hidden = !t?.artist;
    fill(album, link(t?.album, 'album')); album.hidden = !t?.album;
    like.hidden = p.liked == null || !t;
    setIcon(c, like, p.liked ? 'heart-filled' : 'heart'); like.setAttribute('aria-label', c.s.t('player.like')); like.setAttribute('aria-pressed', String(!!p.liked));
    if (likeChanged) pop(c, like);
  }
  c.on(like, 'click', () => c.emit(el, 'like', { liked: !p.liked }, p.onLike));
  c.on(el, 'click', e => { const b = e.target.closest('.ui-np-link'); if (b) c.emit(el, 'open', { part: b._part }, p.onOpen); });
  c.cleanup(() => image.destroy());
  render(); container.append(el);
  return { root: el, body, image, update(n) { p = { ...p, ...n }; render(); }, destroy: () => c.destroy() };
}

// ---------------------------------------------------------------- lyrics
/**
 * createLyricsView(container, { lines: [{ time (s), text }] | null, synced = true, position = 0, state = 'ready' |
 *   'loading' | 'empty' | 'error', follow = true, resumeAfter (ms) | null, label, height, onSeek({ time, index }), onRetry }, services)
 * → { root, get following, get active, follow(), update, destroy }
 * Lyrics that follow the track (G68). The line being sung is marked (aria-current, and bold and full contrast rather
 * than colour alone) and kept in the middle of the view while `follow` is on. Scrolling by hand (wheel, touch, the
 * scroll bar, keys) or moving focus into the lines suspends following; "Back to the current line" resumes it (and
 * moves focus to that line), as does `resumeAfter` ms without scrolling. With `onSeek`, a line is a button that seeks
 * to its time; the lines are one tab stop, ↑ ↓ Home End move between them. Unsynced lyrics (`synced: false`, or lines
 * without times) are plain text with a note. Line changes are never announced; the view scrolls instantly with reduced
 * motion. `position` updates are cheap: only the marked line changes.
 */
export function createLyricsView(container, props = {}, services) {
  const c = setup(container, services, 'lyrics'); mediaStrings(c.s); registerMediaIcons();
  let p = { lines: null, synced: true, position: 0, state: 'ready', follow: true, resumeAfter: null, ...props };
  const list = c.h('ol', { class: 'ui-lyrics-lines' });
  const note = c.h('p', { class: 'ui-lyrics-note' });
  const stateSlot = c.h('div', { class: 'ui-lyrics-state' });
  const scroller = c.h('div', { class: 'ui-lyrics-scroll' }, note, list, stateSlot);
  const back = c.h('button', { type: 'button', class: 'ui-button ui-lyrics-follow', 'data-variant': 'secondary', hidden: true });
  const el = c.own(c.h('section', { class: 'ui-lyrics' }, scroller, back));
  press(c, back);
  let following = !!p.follow, active = -1, lineEls = [], times = [], stateH = null, resumeT = 0, programmatic = 0, focusIdx = 0;
  const synced = () => p.synced !== false && (p.lines || []).length > 0 && p.lines.every(l => Number.isFinite(l.time));
  function build() {
    const sync = synced(), seek = sync && !!p.onSeek;
    times = sync ? p.lines.map(l => l.time) : [];
    lineEls = (p.lines || []).map((l, i) => {
      const inner = seek ? c.h('button', { type: 'button', class: 'ui-lyrics-line', tabindex: '-1' }, l.text || '♪') : c.h('span', { class: 'ui-lyrics-line' }, l.text || '♪');
      inner._i = i;
      return c.h('li', { class: 'ui-lyrics-item', 'data-blank': l.text ? null : '' }, inner);
    });
    fill(list, lineEls);
    el.toggleAttribute('data-synced', sync); el.toggleAttribute('data-seek', seek);
    note.textContent = c.s.t('lyrics.unsynced'); note.hidden = sync || !(p.lines || []).length;
    active = -1; focusIdx = 0;
    roving();
    mark(true);
  }
  function renderState() {
    const st = p.state !== 'ready' ? p.state : (p.lines || []).length ? 'ready' : 'empty';
    el.dataset.state = st;
    stateH?.destroy(); stateH = null; fill(stateSlot);
    if (st === 'loading') { const s = c.h('div', { class: 'ui-lyrics-wait', role: 'status' }); stateSlot.append(s); createSpinner(s, { label: c.s.t('lyrics.loading') }, c.s); }
    else if (st === 'empty') stateH = createEmptyState(stateSlot, { title: c.s.t('lyrics.empty'), icon: 'lyrics' }, c.s);
    else if (st === 'error') stateH = createEmptyState(stateSlot, { kind: 'error', message: c.s.t('lyrics.error'), onRetry: p.onRetry }, c.s);
    stateSlot.hidden = st === 'ready';
    list.hidden = st !== 'ready';
    el.setAttribute('aria-label', p.label || c.s.t('lyrics.label'));
    if (p.height) scroller.style.height = p.height; else scroller.style.height = '';
    back.textContent = c.s.t('lyrics.follow');
  }
  // the line being sung: the last one whose time has come (binary search)
  function lineAt(t) { let lo = 0, hi = times.length - 1, r = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (times[m] <= t) { r = m; lo = m + 1; } else hi = m - 1; } return r; }
  function mark(jump = false) {
    if (!times.length) return;
    const i = lineAt(p.position ?? 0);
    if (i === active && !jump) return;
    lineEls[active]?.removeAttribute('data-active'); lineEls[active]?.firstChild.removeAttribute('aria-current');
    active = i;
    const li = lineEls[i];
    if (li) { li.setAttribute('data-active', ''); li.firstChild.setAttribute('aria-current', 'true'); }
    for (let k = 0; k < lineEls.length; k++) lineEls[k].toggleAttribute('data-past', k < i);
    if (following) center(jump);
  }
  function center(instant) {
    const li = lineEls[Math.max(0, active)]; if (!li || list.hidden) return;
    const top = li.offsetTop - scroller.clientHeight / 2 + li.offsetHeight / 2;
    programmatic++;
    scroller.scrollTo({ top: Math.max(0, top), behavior: instant || c.s.motion.isReduced ? 'auto' : 'smooth' });
    c.win.setTimeout(() => { programmatic--; }, instant || c.s.motion.isReduced ? 50 : 700);
  }
  function suspend() {
    if (!following || !p.follow) return;
    following = false; back.hidden = !times.length;
    if (!back.hidden) c.s.motion.animate(back, { o: 1 }, { role: 'enter', from: { o: 0 } }).then(ok => { if (ok) c.s.motion.reset(back); });
    c.win.clearTimeout(resumeT);
    if (p.resumeAfter) resumeT = c.win.setTimeout(() => resume(false), p.resumeAfter);
  }
  function resume(focus = true) {
    c.win.clearTimeout(resumeT);
    following = true; back.hidden = true; center(false);
    if (focus) { focusIdx = Math.max(0, active); roving(); (lineEls[focusIdx]?.firstChild.tagName === 'BUTTON' ? lineEls[focusIdx].firstChild : scroller).focus({ preventScroll: true }); }
  }
  // manual scrolling, not ours, suspends following; each new scroll restarts the resume timer
  const manual = () => { if (following) suspend(); else if (p.resumeAfter) { c.win.clearTimeout(resumeT); resumeT = c.win.setTimeout(() => resume(false), p.resumeAfter); } };
  c.on(scroller, 'wheel', manual, { passive: true });
  c.on(scroller, 'touchmove', manual, { passive: true });
  c.on(scroller, 'pointerdown', e => { if (e.target === scroller) manual(); }); // the scroll bar
  c.on(scroller, 'keydown', e => { if (['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', ' '].includes(e.key)) manual(); });
  c.on(back, 'click', () => resume(true));
  // the lines: one tab stop
  function roving() { lineEls.forEach((li, i) => { const b = li.firstChild; if (b.tagName === 'BUTTON') b.tabIndex = i === focusIdx ? 0 : -1; }); scroller.tabIndex = el.hasAttribute('data-seek') ? -1 : 0; }
  c.on(list, 'focusin', e => { const b = e.target.closest('.ui-lyrics-line'); if (b) { focusIdx = b._i; roving(); if (!programmatic) suspend(); } });
  c.on(list, 'keydown', e => {
    const b = e.target.closest('button.ui-lyrics-line'); if (!b) return;
    const to = { ArrowDown: b._i + 1, ArrowUp: b._i - 1, Home: 0, End: lineEls.length - 1 }[e.key];
    if (to == null) return;
    e.preventDefault(); e.stopPropagation();
    focusIdx = Math.max(0, Math.min(lineEls.length - 1, to)); roving();
    lineEls[focusIdx].firstChild.focus();
  });
  c.on(list, 'click', e => { const b = e.target.closest('button.ui-lyrics-line'); if (b) c.emit(el, 'seek', { time: p.lines[b._i].time, index: b._i }, p.onSeek); });
  c.cleanup(() => { c.win.clearTimeout(resumeT); stateH?.destroy(); });
  renderState(); build();
  container.append(el);
  c.win.requestAnimationFrame(() => mark(true));
  return {
    root: el, get following() { return following; }, get active() { return active; },
    follow: () => resume(false),
    update(n) {
      p = { ...p, ...n };
      if ('follow' in n) { following = !!p.follow; back.hidden = true; }
      if ('lines' in n || 'synced' in n || 'onSeek' in n) { build(); renderState(); }
      else if ('state' in n || 'label' in n || 'height' in n || 'onRetry' in n) renderState();
      if ('position' in n) mark();
    },
    destroy: () => c.destroy(),
  };
}

// ---------------------------------------------------------------- device picker
const KIND_ICON = { speaker: 'speaker', headphones: 'headphones', computer: 'computer' };
/**
 * createDevicePicker(container, { devices: [{ id, name, kind: 'computer' | 'speaker' | 'headphones' | string, state:
 *   'connected' | 'available' | 'connecting' | 'unavailable' | 'error', detail }], current, label, placement = 'top-end',
 *   onSelect({ id, device }) }, services) → { root, button, update, open(), close(), destroy }
 * Where the music plays (G68): a button showing the current output's kind opens a popover listing the outputs as a
 * radio group (↑ ↓ Home End, Space or Enter picks). Each says its state in words: "Current device" with a check,
 * "Connecting…" with a spinner, "Unavailable" (cannot be picked), "Couldn't connect" (picking it again retries).
 * Picking reports onSelect and keeps the popover open while the host connects; the host updates `current` and states.
 */
export function createDevicePicker(container, props = {}, services) {
  const c = setup(container, services, 'device-picker'); mediaStrings(c.s); registerMediaIcons();
  let p = { devices: [], placement: 'top-end', ...props };
  const button = c.h('button', { type: 'button', class: 'ui-button ui-media-button ui-device-button', 'data-variant': 'ghost', 'data-icon-only': '' }, c.icon('speaker'));
  const el = c.own(c.h('span', { class: 'ui-device-picker' }, button));
  press(c, button);
  const group = c.h('div', { class: 'ui-device-list', role: 'radiogroup' });
  const empty = c.h('p', { class: 'ui-device-empty' });
  const content = c.h('div', { class: 'ui-device-pop' }, group, empty);
  let focusId = null;
  const pop = createPopover(button, { content, placement: p.placement, initialFocus: () => group.querySelector('[tabindex="0"]') }, c.s);
  const iconOf = d => KIND_ICON[d?.kind] || 'speaker';
  function render() {
    const cur = p.devices.find(d => d.id === p.current);
    fill(button, c.icon(iconOf(cur)));
    button.setAttribute('aria-label', p.label || c.s.t('devices.label'));
    button.toggleAttribute('data-remote', !!cur && cur.kind !== 'computer');
    pop.update({ title: c.s.t('devices.title') });
    const tabTo = p.devices.find(d => d.id === focusId) ? focusId : (cur?.id ?? p.devices.find(d => d.state !== 'unavailable')?.id);
    fill(group, p.devices.map(d => {
      const on = d.id === p.current, off = d.state === 'unavailable';
      const state = on && d.state !== 'connecting' && d.state !== 'error' ? c.s.t('devices.current') : d.state === 'connecting' ? c.s.t('devices.connecting') : off ? c.s.t('devices.unavailable') : d.state === 'error' ? c.s.t('devices.error') : '';
      const sid = uid('dev');
      const b = c.h('button', { type: 'button', class: 'ui-device', role: 'radio', 'aria-checked': String(on), 'aria-disabled': off ? 'true' : null, 'aria-describedby': state || d.detail ? sid : null, 'aria-busy': d.state === 'connecting' ? 'true' : null, tabindex: d.id === tabTo ? '0' : '-1', 'data-state': d.state || 'available' },
        c.icon(iconOf(d)), c.h('span', { class: 'ui-device-text' }, c.h('span', { class: 'ui-device-name' }, d.name), c.h('span', { class: 'ui-device-state', id: sid }, [state, d.detail].filter(Boolean).join(' · '))),
        d.state === 'connecting' ? c.h('span', { class: 'ui-spinner', 'aria-hidden': 'true' }) : on ? c.icon('check') : null);
      b._id = d.id;
      return b;
    }));
    empty.textContent = c.s.t('devices.empty'); empty.hidden = p.devices.length > 1;
  }
  function pick(b) {
    const d = p.devices.find(x => x.id === b._id);
    if (!d || d.state === 'unavailable' || (d.id === p.current && d.state === 'connected')) return;
    c.emit(el, 'select', { id: d.id, device: d }, p.onSelect);
  }
  c.on(group, 'click', e => { const b = e.target.closest('.ui-device'); if (b) { focusId = b._id; pick(b); } });
  c.on(group, 'keydown', e => {
    const b = e.target.closest('.ui-device'); if (!b) return;
    const all = [...group.querySelectorAll('.ui-device')], i = all.indexOf(b);
    const to = { ArrowDown: i + 1, ArrowRight: i + 1, ArrowUp: i - 1, ArrowLeft: i - 1, Home: 0, End: all.length - 1 }[e.key];
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); pick(b); return; }
    if (to == null) return;
    e.preventDefault();
    const nb = all[(to + all.length) % all.length];
    for (const x of all) x.tabIndex = x === nb ? 0 : -1;
    focusId = nb._id; nb.focus();
  });
  c.cleanup(() => pop.destroy());
  render(); container.append(el);
  return {
    root: el, button,
    update(n) { const had = group.contains(c.doc.activeElement) ? c.doc.activeElement._id : null; p = { ...p, ...n }; render(); if (had != null) [...group.querySelectorAll('.ui-device')].find(b => b._id === had)?.focus({ preventScroll: true }); },
    open: () => pop.open(), close: () => pop.close(),
    destroy: () => c.destroy(),
  };
}
