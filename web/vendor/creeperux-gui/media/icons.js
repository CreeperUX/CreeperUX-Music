import { registerIcons } from '../ui/index.js';

// Media icon pack (2.5.0, G60): the kit's grid and stroke (24 px, 1.6 px stroke, round caps and joins). Transport
// glyphs are filled so they read at small sizes; everything else is drawn in strokes like the core icons.
// RTL: playback controls, volume, shuffle and repeat are never mirrored (playback runs the way a tape runs, not the way
// text reads); icons made of text lines (queue, playlist, lyrics) are mirrored like other text-direction icons.
// States never rely on colour alone: favourite is an outline or a filled heart, repeat-one has its own glyph, and the
// media layer marks a pressed toggle with a dot under its icon (media.css).
const F = 'fill="currentColor"';
export const MEDIA_ICONS = {
  play: `<path d="M8 5.6v12.8l10.2-6.4z" ${F}/>`,
  pause: `<rect x="6.8" y="5.5" width="3.4" height="13" rx="1" ${F}/><rect x="13.8" y="5.5" width="3.4" height="13" rx="1" ${F}/>`,
  stop: `<rect x="6.5" y="6.5" width="11" height="11" rx="1.5" ${F}/>`,
  'skip-previous': `<path d="M6.5 6v12"/><path d="M17.5 6.6v10.8L9.5 12z" ${F}/>`,
  'skip-next': `<path d="M17.5 6v12"/><path d="M6.5 6.6v10.8l8-5.4z" ${F}/>`,
  'fast-forward': `<path d="M3.8 7.2v9.6l7-4.8zM12.6 7.2v9.6l7-4.8z" ${F}/>`,
  rewind: `<path d="M20.2 7.2v9.6l-7-4.8zM11.4 7.2v9.6l-7-4.8z" ${F}/>`,
  shuffle: '<path d="M3.5 17h2.6c1.7 0 2.7-.7 3.7-2.1l3.9-5.8c1-1.4 2-2.1 3.7-2.1h3"/><path d="M3.5 7h2.6c1.4 0 2.3.5 3.1 1.4M14.1 15.6c.9.9 1.8 1.4 3.2 1.4h3"/><path d="M18 4.5L20.5 7 18 9.5M18 14.5l2.5 2.5-2.5 2.5"/>',
  repeat: '<path d="M17 3.5L19.5 6 17 8.5"/><path d="M4.5 11.5V10a4 4 0 0 1 4-4h11"/><path d="M7 20.5L4.5 18 7 15.5"/><path d="M19.5 12.5V14a4 4 0 0 1-4 4h-11"/>',
  'repeat-one': '<path d="M17 3.5L19.5 6 17 8.5"/><path d="M4.5 11.5V10a4 4 0 0 1 4-4h11"/><path d="M7 20.5L4.5 18 7 15.5"/><path d="M19.5 12.5V14a4 4 0 0 1-4 4h-11"/><path d="M11 10.6l1.6-1.1v5"/>',
  queue: `<rect x="4" y="4.5" width="5" height="5" rx="1" ${F}/><path d="M12.5 7h7.5M4 13h16M4 18h16"/>`,
  playlist: '<path d="M4 6h11M4 11h11M4 16h6.5"/><path d="M18 17.5V8.6l3-.9"/><circle cx="16.3" cy="17.5" r="1.7"/>',
  lyrics: '<path d="M5 4.5h14a1 1 0 0 1 1 1v9.5a1 1 0 0 1-1 1h-7.5L7 19.5V16H5a1 1 0 0 1-1-1V5.5a1 1 0 0 1 1-1z"/><path d="M8 8.5h8M8 12h5"/>',
  heart: '<path d="M12 19.6s-7.6-4.5-7.6-10.2A4.3 4.3 0 0 1 12 6.8a4.3 4.3 0 0 1 7.6 2.6c0 5.7-7.6 10.2-7.6 10.2z"/>',
  'heart-filled': `<path d="M12 19.6s-7.6-4.5-7.6-10.2A4.3 4.3 0 0 1 12 6.8a4.3 4.3 0 0 1 7.6 2.6c0 5.7-7.6 10.2-7.6 10.2z" ${F}/>`,
  volume: '<path d="M4 9.5h3.4L12 5.6v12.8l-4.6-3.9H4z"/><path d="M15.4 9a4.2 4.2 0 0 1 0 6M17.9 6.4a7.8 7.8 0 0 1 0 11.2"/>',
  'volume-low': '<path d="M4 9.5h3.4L12 5.6v12.8l-4.6-3.9H4z"/><path d="M15.4 9a4.2 4.2 0 0 1 0 6"/>',
  'volume-mute': '<path d="M4 9.5h3.4L12 5.6v12.8l-4.6-3.9H4z"/><path d="M15.5 9.5l5 5M20.5 9.5l-5 5"/>',
  speaker: '<rect x="6" y="3.5" width="12" height="17" rx="2"/><circle cx="12" cy="14" r="3.2"/><path d="M12 7.4v.01"/>',
  headphones: '<path d="M4.5 16.5V13a7.5 7.5 0 0 1 15 0v3.5"/><rect x="4" y="14" width="4" height="6.5" rx="1.5"/><rect x="16" y="14" width="4" height="6.5" rx="1.5"/>',
  computer: '<rect x="3.5" y="5" width="17" height="11" rx="1.5"/><path d="M8.5 20h7M12 16v4"/>',
  album: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="2.4"/>',
  artist: '<rect x="9" y="3.5" width="6" height="10" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5v3M8.5 20.5h7"/>',
  library: '<path d="M5 4v16M9.5 4v16M13.8 5.2l4.6 14.6"/>',
  music: '<path d="M9 17.5V6.3l10-2.2v11.2"/><circle cx="6.6" cy="17.5" r="2.4"/><circle cx="16.6" cy="15.3" r="2.4"/>',
};
export const MEDIA_MIRRORED = ['queue', 'playlist', 'lyrics'];
let done = false;
/** registerMediaIcons() — adds the media icon pack to the shared icon registry (done when the media layer loads; repeat calls do nothing). */
export function registerMediaIcons() {
  if (done) return;
  done = true;
  registerIcons(MEDIA_ICONS, { mirror: MEDIA_MIRRORED });
}
