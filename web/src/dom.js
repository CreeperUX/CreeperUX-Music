// Small DOM and formatting helpers shared by the shell and the views.
import { icon } from '../vendor/creeperux-gui/ui/index.js';

/** h('div', { class: 'x', onClick: fn }, ...children): attributes, `on*` listeners, and text or nodes as children. */
export function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  e.append(...kids.flat(Infinity).filter(x => x != null && x !== false));
  return e;
}
export const ic = (name, size) => icon(name, size ? { size } : undefined);

/** A round accent play button, Spotify's big green one in the kit's accent. */
export function playButton({ label, playing = false, size = 'lg', onClick }) {
  const b = h('button', { type: 'button', class: 'cm-play', 'data-size': size, 'aria-label': label, onClick }, ic(playing ? 'pause' : 'play'));
  b.set = ({ playing: on, label: l }) => { b.replaceChildren(ic(on ? 'pause' : 'play')); if (l) b.setAttribute('aria-label', l); b.toggleAttribute('data-playing', !!on); };
  b.toggleAttribute('data-playing', playing);
  return b;
}

/** Seconds → "1 小时 12 分钟" / "1 hr 12 min". */
export function longDuration(seconds, t) { const m = Math.round(seconds / 60); return t.hours(Math.floor(m / 60), m % 60); }

// codec names: "FLAC", "Monkey's Audio", "DSD64", "DST64", "PCM", "MP3", "AAC" …
const SHORT = { "Monkey's Audio": 'APE', WavPack: 'WV', 'True Audio': 'TTA' };
const isDsd = t => /^(DSD|DST)/i.test(t?.codec ?? '') || t?.bitDepth === 1;
export function audioSummary(track) {
  if (!track) return '';
  if (isDsd(track)) return /^(DSD|DST)\d+/i.test(track.codec) ? track.codec.toUpperCase() : `DSD${Math.round(track.sampleRate / 44100)}`;
  const codec = SHORT[track.codec] ?? track.codec;
  if (track.bitDepth) return `${codec} ${track.bitDepth}/${+(track.sampleRate / 1000).toFixed(1)}`;
  return track.bitrate ? `${codec} ${track.bitrate}k` : codec;
}
export const isHiRes = t => !!t && (isDsd(t) || (t.bitDepth >= 24 && t.sampleRate >= 48000) || (t.bitDepth >= 16 && t.sampleRate > 48000));
export const isLossless = t => !!t && (isDsd(t) || ['FLAC', 'ALAC', 'WavPack', 'PCM', 'APE', "Monkey's Audio", 'TAK', 'True Audio', 'TTA', 'WAV', 'AIFF', 'OptimFROG'].includes(t.codec));

/** Mixes a colour with black (amount < 0) or white (amount > 0), for gradients from an artwork colour. */
export function shade(hex, amount) {
  const n = parseInt((hex || '#404040').slice(1), 16), c = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const to = amount < 0 ? 0 : 255, a = Math.abs(amount);
  return `#${c.map(v => Math.round(v + (to - v) * a).toString(16).padStart(2, '0')).join('')}`;
}

/** Keeps `count` children of a row: as many tiles as fit one line of a shelf (re-rendered on resize). */
export function fitCount(el, min, gap, cb) {
  let last = -1, frame = 0;
  // rendering changes the row's height: do it in the next frame, never inside the observer's callback (a loop)
  const ro = new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => { const n = Math.max(1, Math.floor((el.clientWidth + gap) / (min + gap))); if (n !== last) { last = n; cb(n); } }); });
  ro.observe(el);
  return () => { cancelAnimationFrame(frame); ro.disconnect(); };
}

/** The average colour of a loaded image, for tinting a header after real artwork arrives; null if it cannot be read. */
export function sampleColor(img) {
  try {
    const c = document.createElement('canvas'); c.width = c.height = 12;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0, 12, 12);
    const d = g.getImageData(0, 0, 12, 12).data; let r = 0, gr = 0, b = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) { const w = 1 + (Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2])) / 32; r += d[i] * w; gr += d[i + 1] * w; b += d[i + 2] * w; n += w; } // saturated pixels count more
    const hex = [r, gr, b].map(v => Math.round(v / n).toString(16).padStart(2, '0')).join('');
    return shade(`#${hex}`, -0.25);
  } catch { return null; } // another origin's image taints the canvas
}

export function greeting(t, d = new Date()) { const hr = d.getHours(); return hr < 5 ? t.greetNight : hr < 12 ? t.greetMorning : hr < 18 ? t.greetAfternoon : t.greetEvening; }
