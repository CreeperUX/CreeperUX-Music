// Bit writers and checksums for the audio writers. Values up to 2^53 are taken as plain numbers.

/** Writes bits most significant first (FLAC, AAC, MPEG). */
export class BitWriter {
  constructor() { this.bytes = []; this.cur = 0; this.n = 0; }
  write(value, bits) {
    for (let i = bits - 1; i >= 0; i--) this.#bit(Math.floor(value / 2 ** i) % 2);
    return this;
  }
  #bit(b) {
    this.cur = (this.cur << 1) | b;
    if (++this.n === 8) { this.bytes.push(this.cur); this.cur = 0; this.n = 0; }
  }
  /** Pads with zeros to the next byte. */
  align() { while (this.n !== 0) this.#bit(0); return this; }
  buffer() { this.align(); return Buffer.from(this.bytes); }
}

/** Writes bits least significant first (Vorbis). */
export class BitWriterLSB {
  constructor() { this.bytes = []; this.cur = 0; this.n = 0; }
  write(value, bits) {
    for (let i = 0; i < bits; i++) {
      this.cur |= (Math.floor(value / 2 ** i) % 2) << this.n;
      if (++this.n === 8) { this.bytes.push(this.cur); this.cur = 0; this.n = 0; }
    }
    return this;
  }
  buffer() { if (this.n) { this.bytes.push(this.cur); this.cur = 0; this.n = 0; } return Buffer.from(this.bytes); }
}

/** CRC-8 as FLAC frame headers use it (polynomial 0x07). */
export function crc8(buf) {
  let crc = 0;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
  }
  return crc;
}

/** CRC-16 as FLAC frames use it (polynomial 0x8005). */
export function crc16(buf) {
  let crc = 0;
  for (const byte of buf) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x8005) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

const OGG_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? ((r << 1) ^ 0x04c11db7) >>> 0 : (r << 1) >>> 0;
    t[i] = r >>> 0;
  }
  return t;
})();

/** CRC-32 as Ogg pages use it (polynomial 0x04C11DB7, not reflected, no final xor). */
export function crc32ogg(buf) {
  let crc = 0;
  for (const byte of buf) crc = ((crc << 8) ^ OGG_TABLE[((crc >>> 24) ^ byte) & 0xff]) >>> 0;
  return crc >>> 0;
}

export const u8 = n => Buffer.from([n & 0xff]);
export const u16be = n => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
export const u32be = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
export const u16le = n => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
export const u32le = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
