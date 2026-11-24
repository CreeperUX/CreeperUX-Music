// Sound and pictures for the fixture files: a short tone (for the lossless formats, which carry samples as they are)
// and what the tag writers need to know about a JPEG.

/** Mono 16-bit samples: a soft sine with a fade in and out, deterministic. */
export function tone(seconds, rate, freq) {
  const n = Math.round(seconds * rate), out = new Int16Array(n), fade = Math.min(n / 4, rate * 0.05);
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / fade, (n - 1 - i) / fade);
    out[i] = Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 0.2 * 32767 * env);
  }
  return out;
}

/** Little-endian bytes of 16-bit samples (WAV's data, and what FLAC's MD5 is taken over). */
export function pcmBytes(samples) {
  const b = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) b.writeInt16LE(samples[i], i * 2);
  return b;
}

/** Width and height of a baseline or progressive JPEG, from its SOF marker. */
export function jpegSize(buf) {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error('not a JPEG');
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1], len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  throw new Error('no SOF marker in the JPEG');
}

/** FLAC's PICTURE block body (also base64-encoded into Ogg's METADATA_BLOCK_PICTURE): a front cover. */
export function flacPicture(jpeg, description = '') {
  const { width, height } = jpegSize(jpeg), mime = Buffer.from('image/jpeg'), desc = Buffer.from(description, 'utf8');
  const head = Buffer.alloc(4 + 4 + mime.length + 4 + desc.length + 16 + 4);
  let o = 0;
  head.writeUInt32BE(3, o); o += 4; // front cover
  head.writeUInt32BE(mime.length, o); o += 4; mime.copy(head, o); o += mime.length;
  head.writeUInt32BE(desc.length, o); o += 4; desc.copy(head, o); o += desc.length;
  head.writeUInt32BE(width, o); o += 4; head.writeUInt32BE(height, o); o += 4;
  head.writeUInt32BE(24, o); o += 4; head.writeUInt32BE(0, o); o += 4;
  head.writeUInt32BE(jpeg.length, o);
  return Buffer.concat([head, jpeg]);
}
