// Authenticator codes (RFC 6238: SHA-1, 6 digits, 30 s), as the fork's two-step verification checks them.
import { createHmac } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32(secret) {
  let bits = 0, value = 0;
  const out = [];
  for (const ch of secret.toUpperCase().replace(/=+$/, '')) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) throw new Error('not a base32 secret');
    value = (value << 5) | v; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

export const step = (at = Date.now()) => Math.floor(at / 1000 / 30);

/** The code for a time step (default: now). */
export function totp(secret, s = step()) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(s));
  const sum = createHmac('sha1', base32(secret)).update(msg).digest();
  const off = sum[sum.length - 1] & 0x0f;
  return String((sum.readUInt32BE(off) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
