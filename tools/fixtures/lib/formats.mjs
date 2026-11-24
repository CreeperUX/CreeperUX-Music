// The six audio formats, written byte by byte so the fixtures need no encoder and come out the same every time.
//
// - FLAC and WAV carry a short tone (verbatim FLAC subframes, plain PCM).
// - MP3, Ogg Vorbis, Opus and M4A (AAC-LC) carry silence: frames whose decoded output is all zero, which any decoder
//   plays, and whose length and audio properties TagLib reads as it would from an encoder's output.
//
// Each writer takes { tags, cover, seconds, freq } (tags: lib/tags.mjs; cover: JPEG bytes or null) and returns the
// file's bytes.
import { createHash } from 'node:crypto';
import { BitWriter, BitWriterLSB, crc8, crc16, crc32ogg, u8, u16be, u32be, u16le, u32le } from './bits.mjs';
import { tone, pcmBytes, flacPicture } from './pcm.mjs';
import { vorbisComments, id3v2, mp4Items } from './tags.mjs';

const VENDOR = 'Sonus fixtures';

// ---------------------------------------------------------------- Vorbis comments (FLAC, Ogg)

function commentBody(tags, extra = []) {
  const pairs = [...vorbisComments(tags), ...extra].map(([k, v]) => Buffer.from(`${k}=${v}`, 'utf8'));
  const vendor = Buffer.from(VENDOR);
  return Buffer.concat([u32le(vendor.length), vendor, u32le(pairs.length), ...pairs.flatMap(p => [u32le(p.length), p])]);
}

// ---------------------------------------------------------------- FLAC

function utf8Number(n) { // FLAC's frame number coding
  if (n < 0x80) return Buffer.from([n]);
  if (n < 0x800) return Buffer.from([0xc0 | (n >> 6), 0x80 | (n & 0x3f)]);
  return Buffer.from([0xe0 | (n >> 12), 0x80 | ((n >> 6) & 0x3f), 0x80 | (n & 0x3f)]);
}

export function flac({ tags, cover, seconds, freq = 440 }) {
  const rate = 44100, block = 4096, samples = tone(seconds, rate, freq);
  const blocks = [];
  for (let i = 0, n = 0; i < samples.length; i += block, n++) {
    const s = samples.subarray(i, Math.min(i + block, samples.length));
    const head = new BitWriter()
      .write(0b11111111111110, 14).write(0, 1).write(0, 1)             // sync, reserved, fixed block size
      .write(s.length === block ? 0b1100 : 0b0111, 4).write(0b1001, 4) // block size (4096, or 16 bits at the end), 44.1 kHz
      .write(0, 4).write(0b100, 3).write(0, 1)                          // mono, 16 bits, reserved
      .buffer();
    const parts = [head, utf8Number(n)];
    if (s.length !== block) parts.push(u16be(s.length - 1));
    let h = Buffer.concat(parts);
    h = Buffer.concat([h, u8(crc8(h))]);
    const sub = Buffer.alloc(1 + s.length * 2);
    sub[0] = 0b00000010; // verbatim subframe, no wasted bits
    for (let k = 0; k < s.length; k++) sub.writeInt16BE(s[k], 1 + k * 2);
    const frame = Buffer.concat([h, sub]);
    blocks.push(frame, u16be(crc16(frame)));
  }
  const md5 = createHash('md5').update(pcmBytes(samples)).digest();
  const info = new BitWriter()
    .write(block, 16).write(block, 16).write(0, 24).write(0, 24)
    .write(rate, 20).write(0, 3).write(15, 5).write(samples.length, 36)
    .buffer();
  const meta = [[0, Buffer.concat([info, md5])], [4, commentBody(tags)]];
  if (cover) meta.push([6, flacPicture(cover)]);
  const out = [Buffer.from('fLaC')];
  meta.forEach(([type, body], i) => {
    const last = i === meta.length - 1 ? 0x80 : 0;
    out.push(u8(last | type), Buffer.from([(body.length >> 16) & 0xff, (body.length >> 8) & 0xff, body.length & 0xff]), body);
  });
  return Buffer.concat([...out, ...blocks]);
}

// ---------------------------------------------------------------- WAV (with an ID3v2 chunk)

export function wav({ tags, cover, seconds, freq = 440 }) {
  const rate = 44100, data = pcmBytes(tone(seconds, rate, freq));
  const chunk = (id, body) => Buffer.concat([Buffer.from(id, 'latin1'), u32le(body.length), body, body.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
  const fmt = Buffer.concat([u16le(1), u16le(1), u32le(rate), u32le(rate * 2), u16le(2), u16le(16)]);
  const body = Buffer.concat([Buffer.from('WAVE'), chunk('fmt ', fmt), chunk('data', data), chunk('id3 ', id3v2(tags, cover))]);
  return Buffer.concat([Buffer.from('RIFF'), u32le(body.length), body]);
}

// ---------------------------------------------------------------- MP3 (MPEG-1 Layer III, 128 kb/s, 48 kHz, mono)

export function mp3({ tags, cover, seconds }) {
  // 1152 samples a frame, 384 bytes exactly at 128 kb/s and 48 kHz (no padding). Side info and main data all zero:
  // no granule carries any bits, so every frame decodes to silence. No Xing header: CBR, TagLib takes the length from
  // the stream's size and bitrate.
  const frames = Math.round((seconds * 48000) / 1152), frame = Buffer.alloc(384);
  frame.set([0xff, 0xfb, 0x94, 0xc0]); // sync, MPEG-1, Layer III, no CRC; 128 kb/s, 48 kHz; mono
  return Buffer.concat([id3v2(tags, cover), ...Array(frames).fill(frame)]);
}

// ---------------------------------------------------------------- Ogg

/** An Ogg stream from packets: { data, granule, flush } (flush: the packet ends its page). */
function oggStream(serial, packets) {
  const pages = [];
  let seq = 0, segs = [], body = [], granule = -1, continued = false, first = true;
  const emit = (last = false) => {
    const header = Buffer.alloc(27 + segs.length);
    header.write('OggS', 0, 'latin1');
    header[4] = 0;
    header[5] = (continued ? 1 : 0) | (first ? 2 : 0) | (last ? 4 : 0);
    header.writeBigInt64LE(BigInt(granule), 6);
    header.writeUInt32LE(serial, 14);
    header.writeUInt32LE(seq++, 18);
    header[26] = segs.length;
    Buffer.from(segs).copy(header, 27);
    const page = Buffer.concat([header, ...body]);
    page.writeUInt32LE(crc32ogg(page), 22);
    pages.push(page);
    segs = []; body = []; granule = -1; first = false;
  };
  packets.forEach((p, i) => {
    const last = i === packets.length - 1;
    let off = 0;
    for (;;) {
      const take = Math.min(255, p.data.length - off);
      segs.push(take);
      body.push(p.data.subarray(off, off + take));
      off += take;
      if (take < 255) break; // the packet ends here (a 255 is followed by another segment, a 0 if need be)
      if (segs.length === 255) { emit(); continued = true; }
    }
    continued = false;
    granule = p.granule ?? 0;
    if (p.flush || last || segs.length > 240) emit(last);
  });
  return Buffer.concat(pages);
}

const pictureComment = cover => (cover ? [['METADATA_BLOCK_PICTURE', flacPicture(cover).toString('base64')]] : []);

// ---------------------------------------------------------------- Ogg Vorbis (44.1 kHz, mono)

function vorbisSetup() {
  // The smallest setup a decoder accepts: one 2-entry codebook, one floor 1 with no partitions, one residue with one
  // classification and no books, one mapping, one mode (long blocks). Audio packets then mark the channel's floor
  // unused, which decodes to silence.
  const w = new BitWriterLSB();
  w.write(0, 8);                                                      // codebooks: 1
  w.write(0x564342, 24).write(1, 16).write(2, 24).write(0, 1).write(0, 1).write(0, 5).write(0, 5).write(0, 4);
  w.write(0, 6).write(0, 16);                                         // time domain transforms: 1, placeholder
  w.write(0, 6).write(1, 16);                                         // floors: 1, type 1
  w.write(0, 5).write(1, 2).write(7, 4);                              // no partitions, multiplier 2, range bits 7
  w.write(0, 6).write(0, 16);                                         // residues: 1, type 0
  w.write(0, 24).write(128, 24).write(31, 24).write(0, 6).write(0, 8); // 0..128 by 32, 1 classification, classbook 0
  w.write(0, 3).write(0, 1);                                          // cascade: none
  w.write(0, 6).write(0, 16).write(0, 1).write(0, 1).write(0, 2);     // mappings: 1, type 0, 1 submap, no coupling
  w.write(0, 8).write(0, 8).write(0, 8);                              // submap: time, floor 0, residue 0
  w.write(0, 6).write(1, 1).write(0, 16).write(0, 16).write(0, 8);    // modes: 1, long block, mapping 0
  w.write(1, 1);                                                      // framing
  return Buffer.concat([Buffer.from([5]), Buffer.from('vorbis'), w.buffer()]);
}

export function oggVorbis({ tags, cover, seconds }) {
  const rate = 44100, total = Math.round(seconds * rate);
  const ident = Buffer.concat([Buffer.from([1]), Buffer.from('vorbis'), u32le(0), u8(1), u32le(rate),
    u32le(0), u32le(0), u32le(0), u8((11 << 4) | 8), u8(1)]); // bitrates unset; blocks 256 and 2048
  const comment = Buffer.concat([Buffer.from([3]), Buffer.from('vorbis'), commentBody(tags, pictureComment(cover)), u8(1)]);
  const packets = [{ data: ident, granule: 0, flush: true }, { data: comment, granule: 0 }, { data: vorbisSetup(), granule: 0, flush: true }];
  // Long blocks only: the first packet gives no samples, each next one 1024. The last page's granule trims the end.
  const audio = Math.ceil(total / 1024) + 1, silent = Buffer.from([0]); // packet type 0, (no mode bits), windows, floor unused
  for (let i = 0; i < audio; i++) packets.push({ data: silent, granule: Math.min(i * 1024, total) });
  return oggStream(0x50e05001, packets);
}

// ---------------------------------------------------------------- Opus (48 kHz, mono)

export function opus({ tags, cover, seconds }) {
  const preSkip = 312, frames = Math.round((seconds * 48000) / 960);
  const head = Buffer.concat([Buffer.from('OpusHead'), u8(1), u8(1), u16le(preSkip), u32le(48000), u16le(0), u8(0)]);
  const opusTags = Buffer.concat([Buffer.from('OpusTags'), commentBody(tags, pictureComment(cover))]);
  const packets = [{ data: head, granule: 0, flush: true }, { data: opusTags, granule: 0, flush: true }];
  const silent = Buffer.from([0xf8, 0xff, 0xfe]); // CELT-only, fullband, 20 ms, mono: a frame that decodes to silence
  for (let i = 1; i <= frames; i++) packets.push({ data: silent, granule: preSkip + i * 960 });
  return oggStream(0x50e05002, packets);
}

// ---------------------------------------------------------------- M4A (AAC-LC, 44.1 kHz, mono)

const box = (type, ...children) => { const body = Buffer.concat(children); return Buffer.concat([u32be(8 + body.length), Buffer.from(type, 'latin1'), body]); };
const fullBox = (type, version, flags, ...children) => box(type, u8(version), Buffer.from([(flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff]), ...children);
const MATRIX = Buffer.concat([0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000].map(u32be));

function descriptor(tag, body) { // MPEG-4 descriptor with a one-byte length
  return Buffer.concat([u8(tag), u8(body.length), body]);
}

function ilst(items) {
  const data = (type, value) => box('data', u32be(type), u32be(0), value);
  return box('ilst', ...items.map(([atom, values, kind]) => {
    if (atom.startsWith('----:')) {
      const [, mean, name] = atom.split(':');
      return box('----', fullBox('mean', 0, 0, Buffer.from(mean)), fullBox('name', 0, 0, Buffer.from(name)), ...values.map(v => data(1, Buffer.from(String(v), 'utf8'))));
    }
    const name = Buffer.from(atom, 'latin1');
    const body = values.map(v => {
      switch (kind) {
        case 'trkn': return data(0, Buffer.concat([u16be(0), u16be(v[0] ?? 0), u16be(v[1] ?? 0), u16be(0)]));
        case 'disk': return data(0, Buffer.concat([u16be(0), u16be(v[0] ?? 0), u16be(v[1] ?? 0)]));
        case 'bool': return data(21, u8(v ? 1 : 0));
        case 'int16': return data(21, u16be(v));
        case 'jpeg': return data(13, v);
        default: return data(1, Buffer.from(String(v), 'utf8'));
      }
    });
    return Buffer.concat([u32be(8 + Buffer.concat(body).length), name, ...body]);
  }));
}

export function m4a({ tags, cover, seconds }) {
  const rate = 44100, frames = Math.ceil((seconds * rate) / 1024), duration = frames * 1024;
  const silent = Buffer.from([0x01, 0x40, 0x20, 0x07]); // SCE, max_sfb 0 (no spectral data), END: silence
  const mdatBody = Buffer.concat(Array(frames).fill(silent));
  const bitrate = Math.round((mdatBody.length * 8) / (duration / rate));
  const esds = fullBox('esds', 0, 0, descriptor(0x03, Buffer.concat([
    u16be(1), u8(0),
    descriptor(0x04, Buffer.concat([u8(0x40), u8(0x15), Buffer.from([0, 0x01, 0x00]), u32be(bitrate), u32be(bitrate),
      descriptor(0x05, Buffer.from([0x12, 0x08]))])), // AAC-LC, 44.1 kHz, mono
    descriptor(0x06, Buffer.from([0x02])),
  ])));
  const mp4a = box('mp4a', Buffer.alloc(6), u16be(1), Buffer.alloc(8), u16be(1), u16be(16), u16be(0), u16be(0), u32be(rate * 65536), esds);
  const moov = chunkOffset => box('moov',
    fullBox('mvhd', 0, 0, u32be(0), u32be(0), u32be(rate), u32be(duration), u32be(0x10000), u16be(0x100), Buffer.alloc(10), MATRIX, Buffer.alloc(24), u32be(2)),
    box('trak',
      fullBox('tkhd', 0, 7, u32be(0), u32be(0), u32be(1), u32be(0), u32be(duration), Buffer.alloc(8), u16be(0), u16be(0), u16be(0x100), u16be(0), MATRIX, u32be(0), u32be(0)),
      box('mdia',
        fullBox('mdhd', 0, 0, u32be(0), u32be(0), u32be(rate), u32be(duration), u16be(0x55c4), u16be(0)),
        fullBox('hdlr', 0, 0, u32be(0), Buffer.from('soun'), Buffer.alloc(12), Buffer.from('SoundHandler\0')),
        box('minf',
          fullBox('smhd', 0, 0, u16be(0), u16be(0)),
          box('dinf', fullBox('dref', 0, 0, u32be(1), fullBox('url ', 0, 1))),
          box('stbl',
            fullBox('stsd', 0, 0, u32be(1), mp4a),
            fullBox('stts', 0, 0, u32be(1), u32be(frames), u32be(1024)),
            fullBox('stsc', 0, 0, u32be(1), u32be(1), u32be(frames), u32be(1)),
            fullBox('stsz', 0, 0, u32be(silent.length), u32be(frames)),
            fullBox('stco', 0, 0, u32be(1), u32be(chunkOffset)))))),
    box('udta', fullBox('meta', 0, 0,
      fullBox('hdlr', 0, 0, u32be(0), Buffer.from('mdir'), Buffer.from('appl'), Buffer.alloc(9)),
      ilst(mp4Items(tags, cover)))));
  const ftyp = box('ftyp', Buffer.from('M4A '), u32be(0), Buffer.from('M4A mp42isom'));
  const size = moov(0).length;
  return Buffer.concat([ftyp, moov(ftyp.length + size + 8), box('mdat', mdatBody)]);
}

export const WRITERS = { flac, wav, mp3, ogg: oggVorbis, opus, m4a };
