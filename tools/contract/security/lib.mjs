// Helpers for the adversarial checks (docs/security-review-brief.md): raw requests an HTTP library would refuse to
// send, requests from other loopback addresses (each 127.0.0.x is another client to the server), and authenticator
// codes. Credentials come from the fixtures' manifest and are never printed.
import net from 'node:net';
import http from 'node:http';
import { createHmac, createHash } from 'node:crypto';

/** Sends bytes as they are and resolves with everything the server sent back until it closed or went quiet. */
export function raw(url, bytes, { localAddress, quietMs = 1500 } = {}) {
  const { hostname, port } = new URL(url);
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: hostname, port: Number(port), localAddress });
    let data = Buffer.alloc(0), timer;
    const done = () => { clearTimeout(timer); socket.destroy(); resolve(data.toString('latin1')); };
    const arm = () => { clearTimeout(timer); timer = setTimeout(done, quietMs); };
    socket.on('connect', () => { socket.write(bytes); arm(); });
    socket.on('data', d => { data = Buffer.concat([data, d]); arm(); });
    socket.on('end', done);
    socket.on('error', e => (data.length ? done() : reject(e)));
  });
}

/** The status lines in what `raw` returned (one per response on the connection). */
export const statuses = text => [...text.matchAll(/^HTTP\/1\.[01] (\d{3})/gm)].map(m => Number(m[1]));

/** A request with node's http (any method, headers, body, source address): { status, headers, text, json }. */
export function send(url, { method = 'GET', headers = {}, body, localAddress } = {}) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers, localAddress, agent: false }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

export const postJson = (url, value, options = {}) =>
  send(url, { method: 'POST', ...options, headers: { 'Content-Type': 'application/json', ...options.headers }, body: JSON.stringify(value) });

/** The Subsonic answer inside a response (`subsonic-response`), or null. */
export const subsonic = response => response.json?.['subsonic-response'] ?? null;

/** RFC 6238 (SHA-1, 30 s, 6 digits) from a base32 secret, `steps` steps from now. */
export function totp(secret, steps = 0) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secret.replace(/[\s=]/g, '').toUpperCase()) bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map(b => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + steps));
  const h = createHmac('sha1', key).update(counter).digest(), o = h[19] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}

export const md5 = text => createHash('md5').update(text).digest('hex');
export const sleep = ms => new Promise(done => setTimeout(done, ms));
/** Query parameters every Subsonic request carries. */
export const COMMON = 'v=1.16.1&c=security-review&f=json';
