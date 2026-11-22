// The app's own motion, on top of what the kit's components already do (menus, overlays, toasts, the side panels,
// reordering): a view rises in as it opens, with what is on screen following in a short stagger; a new track settles
// into the bar and the Now playing panel; liking a song pops the heart; play / pause buttons give a small bounce.
// It runs on the kit's motion core (transform and opacity only, on the compositor; a new target interrupts from where
// the element is) with a few extra roles. With prefers-reduced-motion every movement becomes at most a short fade.
// Lists are never animated as they update (the kit keeps them instant), and nothing runs while scrolling or dragging.
import { createMotion } from '../vendor/creeperux-gui/motion-core.js';
import { MOTION_ROLES } from '../vendor/creeperux-gui/tokens.js';

const ROLES = {
  ...MOTION_ROLES,
  'cm-view': { t: 'tween', d: 0.28, e: [0.2, 0.8, 0.2, 1] },  // the view itself
  'cm-rise': { t: 'tween', d: 0.4, e: [0.16, 1, 0.3, 1] },    // the parts of a view, staggered
  'cm-cover': { t: 'spring', r: 0.5, z: 0.86 },              // artwork settling in
  'cm-pop': { t: 'spring', r: 0.3, z: 0.5 },                  // a toggle answering a press
};
const STAGGER = 0.024, MAX_PARTS = 16;
// what rises in when a view opens, in reading order; only what is on screen moves
const PARTS = '.cm-hero-art, .cm-hero-text, .cm-greeting, .cm-actions, .cm-quick-item, .cm-shelf-head, .cm-shelf-row > [role="listitem"], .cm-grid > [role="listitem"], .cm-genres > [role="listitem"]';

export function createAppMotion(ctx, root) {
  const m = createMotion({ roles: ROLES });
  const onScreen = (el, box) => { const b = el.getBoundingClientRect(); return b.width > 0 && b.bottom > box.top && b.top < box.bottom; };

  /** A view that was just mounted (not one re-rendered in place): rise in. `quiet` (search results replacing each
   *  other while typing): only a short fade, so the page does not jump on every key. */
  function enterView(holder, { quiet = false } = {}) {
    if (quiet) { m.animate(holder, { o: 1 }, { role: 'cm-view', from: { o: 0.4 } }); return; }
    m.animate(holder, { o: 1, y: 0 }, { role: 'cm-view', from: { o: 0, y: 12 } });
    const box = ctx.ws.main.getBoundingClientRect();
    const parts = [...holder.querySelectorAll(PARTS)].filter(el => onScreen(el, box)).slice(0, MAX_PARTS);
    parts.forEach((el, i) => {
      const art = el.classList.contains('cm-hero-art');
      m.animate(el, art ? { o: 1, sx: 1, sy: 1 } : { o: 1, y: 0 }, { role: art ? 'cm-cover' : 'cm-rise', from: art ? { o: 0, sx: 0.94, sy: 0.94 } : { o: 0, y: 14 }, delay: 0.02 + i * STAGGER });
    });
  }

  /** New content in place of other (the panel's Now playing / queue, search results by kind): fade and rise a little. */
  function reveal(el, { y = 8 } = {}) { if (el && !el.hidden) m.animate(el, { o: 1, y: 0 }, { role: 'cm-rise', from: { o: 0, y } }); }

  /** A different track is loaded: its artwork and title settle into the bar and the Now playing panel. */
  function newTrack() {
    for (const el of root.querySelectorAll('.ui-pb-art, .ui-np-art')) m.animate(el, { o: 1, sx: 1, sy: 1 }, { role: 'cm-cover', from: { o: 0.2, sx: 0.9, sy: 0.9 } });
    for (const el of root.querySelectorAll('.ui-pb-text, .ui-np-text')) m.animate(el, { o: 1, x: 0 }, { role: 'cm-rise', from: { o: 0, x: -10 }, delay: 0.04 });
  }
  const offPlayer = ctx.on('player', ({ player, prev }) => { if (prev && player.trackId && player.trackId !== prev.trackId) newTrack(); });

  // presses: liking pops the heart (only when it turns on); play / pause bounce their icon
  const onClick = e => {
    const like = e.target.closest?.('.ui-pb-like, .ui-np-like, .ui-track-like');
    if (like && like.getAttribute('aria-pressed') === 'false') { m.animate(like, { sx: 1, sy: 1 }, { role: 'cm-pop', from: { sx: 1.35, sy: 1.35 } }); return; }
    // play / pause, and the bar's toggles (shuffle, repeat, lyrics, queue, mute) answer with their icon
    const play = e.target.closest?.('.ui-pb-play, .cm-play, .ui-mcard-play, .ui-pb .ui-media-toggle, .ui-volume-mute');
    const icon = play?.querySelector('svg');
    if (icon) m.animate(icon, { sx: 1, sy: 1 }, { role: 'cm-pop', from: { sx: 0.7, sy: 0.7 } });
  };
  root.addEventListener('click', onClick);

  return {
    enterView, reveal,
    destroy() { offPlayer(); root.removeEventListener('click', onClick); m.destroy?.(); },
  };
}
