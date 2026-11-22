// Music for the demo server: every song gets a short piece of its own, made from its id (a key, a chord progression,
// a tempo and a voice), so playing, seeking and the change from one song to the next can be heard. Mono 16-bit WAV at
// 22.05 kHz, as long as the song. Four bars are rendered once per song and repeated; any byte range is served.

const RATE = 22050;
const rng = seed => { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; };
const hash = str => { let h = 2166136261; for (const ch of str) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
const MAJOR = [0, 2, 4, 5, 7, 9, 11], MINOR = [0, 2, 3, 5, 7, 8, 10];
const PROGRESSIONS = [[0, 4, 5, 3], [5, 3, 0, 4], [1, 4, 0, 5], [0, 5, 3, 4], [0, 3, 4, 3], [5, 4, 3, 4]];
const hz = midi => 440 * 2 ** ((midi - 69) / 12);
const SLOW = new Set(['Classical', 'Ambient', 'Post-Rock', 'Soundtrack', 'Jazz', 'Folk', 'Shoegaze']);
const FAST = new Set(['City Pop', 'J-Pop', 'Electronic', 'Rock', 'Lo-fi']);

const cache = new Map(); // id → the four rendered bars
function bars(song) {
  if (cache.has(song.id)) return cache.get(song.id);
  const r = rng(hash(`${song.id}/${song.title}`));
  const scale = r() < 0.65 ? MAJOR : MINOR, root = 48 + Math.floor(r() * 12);
  const prog = PROGRESSIONS[Math.floor(r() * PROGRESSIONS.length)];
  const barSec = SLOW.has(song.genre) ? 3.6 + r() * 1.2 : FAST.has(song.genre) ? 1.8 + r() * 0.5 : 2.4 + r() * 0.6;
  const steps = FAST.has(song.genre) ? 16 : 8, pattern = [[0, 1, 2, 1], [0, 2, 1, 2], [0, 1, 2, 3], [2, 1, 0, 1]][Math.floor(r() * 4)];
  const bright = 0.04 + r() * 0.08, len = Math.round(barSec * RATE), stepLen = len / steps;
  const note = (degree, octave = 0) => { const d = ((degree % 7) + 7) % 7; return root + scale[d] + 12 * (Math.floor(degree / 7) + octave); };
  const out = prog.map(deg => {
    const chord = [note(deg), note(deg + 2), note(deg + 4)], f = chord.map(hz), bass = hz(note(deg, -1)), buf = new Int16Array(len);
    const arp = [...pattern].map(i => (i === 3 ? hz(note(deg, 1)) : hz(chord[i] + 12)));
    for (let n = 0; n < len; n++) {
      const t = n / RATE, env = Math.min(1, t / 0.25, (len - n) / RATE / 0.2);
      let v = 0;
      for (const x of f) v += Math.sin(2 * Math.PI * x * t) * 0.06 + Math.sin(4 * Math.PI * x * t) * 0.012; // pad
      v *= env;
      v += Math.sin(2 * Math.PI * bass * t) * 0.14 * Math.exp(-t * 0.9) * Math.min(1, t / 0.01);         // bass
      const step = Math.floor(n / stepLen), ts = (n - step * stepLen) / RATE, a = arp[step % arp.length];
      const pluck = Math.exp(-ts * 7) * Math.min(1, ts / 0.004);
      v += (Math.sin(2 * Math.PI * a * ts) * 0.13 + Math.sin(4 * Math.PI * a * ts) * bright) * pluck;          // arpeggio
      buf[n] = Math.max(-32767, Math.min(32767, Math.round(v * 32767 * 1.6)));
    }
    return buf;
  });
  const entry = { bars: out, len };
  cache.set(song.id, entry);
  if (cache.size > 24) cache.delete(cache.keys().next().value);
  return entry;
}

/** The WAV's size in bytes, and the bytes [start, end] of it. */
export function wav(song) {
  const samples = Math.round(song.duration * RATE), total = 44 + samples * 2;
  function read(start, end) {
    const out = Buffer.alloc(end - start + 1);
    const header = Buffer.alloc(44);
    header.write('RIFF', 0); header.writeUInt32LE(total - 8, 4); header.write('WAVE', 8); header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
    header.writeUInt32LE(RATE, 24); header.writeUInt32LE(RATE * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(samples * 2, 40);
    if (start < 44) header.copy(out, 0, start, Math.min(44, end + 1));
    const { bars: b, len } = bars(song), fadeIn = RATE * 1.5, fadeOut = RATE * 3;
    let n = Math.max(0, Math.floor((start - 44) / 2));
    for (let pos = Math.max(44, start - ((start - 44) % 2)); pos <= end && n < samples; pos += 2, n++) {
      const bar = Math.floor(n / len) % b.length;
      let v = b[bar][n % len];
      if (n < fadeIn) v *= n / fadeIn; else if (samples - n < fadeOut) v *= (samples - n) / fadeOut;
      const s = Math.round(v), i = pos - start;
      if (i >= 0 && i < out.length) out[i] = s & 255;
      if (i + 1 >= 0 && i + 1 < out.length) out[i + 1] = (s >> 8) & 255;
    }
    return out;
  }
  return { total, read };
}
