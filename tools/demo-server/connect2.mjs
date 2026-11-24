// Sonus Connect version 2 for the demo server (docs/protocol/connect.md): a WebSocket at rest/connect?protocol=2 with
// one playback session per user. The session logic is connect-session.mjs (the reference of the protocol's server half);
// this file is the transport around it: the handshake, one socket per device, the grace period's timer, and keeping
// the sessions (in memory, and with SONUS_DEMO_CONNECT_STORE=<file> in that JSON file across restarts).
// Version 1 (connect.mjs) stays at rest/connect without protocol=2; the two do not see each other.
//
// Settings (environment): SONUS_DEMO_CONNECT=1 advertises version 1 only (the app then uses version 1, as with the
// production server today); SONUS_DEMO_CONNECT_GRACE=<ms> shortens the grace period for tests.
// Test hooks (routed from demo-server.mjs): GET /__test/connect2?u=demo → the user's session, queue and devices;
// GET /__test/connect2/drop?u=demo&device=<id>[&hold=<ms>] → cuts that device's connection without a goodbye (a network
// loss), and refuses its reconnecting for hold ms.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { ConnectSession } from './connect-session.mjs';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'; // RFC 6455 §1.3
const STORE = process.env.SONUS_DEMO_CONNECT_STORE || null;
const GRACE = Number(process.env.SONUS_DEMO_CONNECT_GRACE) || 10_000;
export const EXTENSION = { name: 'sonusConnect', versions: process.env.SONUS_DEMO_CONNECT === '1' ? [1] : [1, 2] };

/** The upgrade asks for version 2. */
export const isV2 = req => new URL(req.url, 'http://x').searchParams.get('protocol') === '2';

/**
 * Version 2's sessions. authenticate(query) → the user name or null; has(id): the library has that song;
 * lookup(id) → what a device shows of it. Returns { upgrade(req, socket), dropAll(), test(url) }.
 */
export function attachConnect2({ authenticate, isOffline = () => false, has = () => true, lookup = () => null }) {
  const users = new Map(); // user → { session, sockets: Map(deviceId → Socket), timer, held: Map(deviceId → until) }
  const all = new Set();
  let saving = null;

  const saved = (() => { try { return STORE ? JSON.parse(readFileSync(STORE, 'utf8')) : {}; } catch { return {}; } })();
  function room(user) {
    let r = users.get(user);
    if (!r) {
      r = { session: new ConnectSession({ has, lookup, graceMs: GRACE, saved: saved[user] ?? null }), sockets: new Map(), timer: null, held: new Map() };
      users.set(user, r);
    }
    return r;
  }

  function save() {
    if (!STORE || saving) return;
    saving = setTimeout(() => { // within a second of a change
      saving = null;
      const all = Object.fromEntries([...users].map(([user, r]) => [user, r.session.save()]));
      try { writeFileSync(`${STORE}.tmp`, JSON.stringify(all)); renameSync(`${STORE}.tmp`, STORE); } catch (e) { console.error(`connect store: ${e.message}`); }
    }, 1000);
  }

  /** Sends what the session said, and sets the grace period's timer. */
  function deliver(r, out, ws = null) {
    for (const o of out) {
      if (o.reply) ws?.send(o.reply);
      else if (o.close) { const s = r.sockets.get(o.close); if (s) { r.sockets.delete(o.close); s.dropped = true; s.close(o.code, o.reason); } }
      else r.sockets.get(o.to)?.send(o.msg);
    }
    clearTimeout(r.timer);
    const at = r.session.nextTimer();
    if (at != null) r.timer = setTimeout(() => deliver(r, r.session.tick()), Math.max(0, at - Date.now()) + 5);
    save();
  }

  function upgrade(req, socket) {
    if (isOffline()) { socket.destroy(); return; }
    const url = new URL(req.url, 'http://x');
    const user = authenticate(url.searchParams);
    if (!user || !url.searchParams.get('c')) { socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return; }
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${createHash('sha1').update(key + GUID).digest('base64')}\r\n\r\n`);
    const ws = new Socket(socket, all);
    const r = room(user);
    let id = null;
    ws.onMessage = msg => {
      if (id === null) { // the first message: hello
        if (msg?.type === 'hello' && (r.held.get(msg.deviceId) ?? 0) > Date.now()) { ws.destroy(); return; } // a test's network loss
        const { id: got, out } = r.session.hello(msg);
        if (!got) { deliver(r, out, ws); ws.close(1008, 'hello expected'); return; }
        id = got;
        const old = r.sockets.get(id);
        if (old) { old.dropped = true; old.close(4000, 'replaced by a newer connection'); }
        r.sockets.set(id, ws);
        deliver(r, out, ws);
        return;
      }
      deliver(r, r.session.message(id, msg), ws);
    };
    ws.onClose = () => {
      if (id === null || ws.dropped || r.sockets.get(id) !== ws) return;
      r.sockets.delete(id);
      deliver(r, r.session.drop(id));
    };
  }

  function test(url) {
    const r = room(url.searchParams.get('u') ?? 'demo');
    if (url.pathname === '/__test/connect2/drop') {
      const device = url.searchParams.get('device') ?? '';
      const hold = Number(url.searchParams.get('hold') ?? 0);
      if (hold > 0) r.held.set(device, Date.now() + hold);
      const s = r.sockets.get(device);
      s?.destroy();
      return { dropped: Boolean(s) };
    }
    return { session: r.session.session(), queue: r.session.queueView(), devices: r.session.deviceList(), serverTime: Date.now() };
  }

  return { upgrade, test, dropAll: () => { for (const s of all) s.destroy(); } };
}

/** One WebSocket connection, server side (RFC 6455: text frames, ping / pong, close with a code). */
class Socket {
  constructor(socket, all) {
    this.socket = socket; this.all = all; this.buffer = Buffer.alloc(0); this.parts = []; this.closed = false; this.heard = Date.now();
    this.onMessage = () => {}; this.onClose = () => {};
    all.add(this);
    socket.setNoDelay(true);
    socket.on('data', d => { this.heard = Date.now(); this.buffer = Buffer.concat([this.buffer, d]); this.#read(); });
    socket.on('close', () => this.#gone());
    socket.on('end', () => this.destroy()); // the other end went without a close frame (an upgraded socket stays half open)
    socket.on('error', () => this.#gone());
    // a ping every 30 s; a connection silent for 75 s is gone
    this.ping = setInterval(() => { if (Date.now() - this.heard > 75_000) this.destroy(); else this.#frame(0x9, Buffer.alloc(0)); }, 30_000);
  }

  send(obj) { if (!this.closed) this.#frame(0x1, Buffer.from(JSON.stringify(obj))); }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    const body = Buffer.alloc(2 + Buffer.byteLength(reason)); body.writeUInt16BE(code); body.write(reason, 2);
    this.#frame(0x8, body);
    this.socket.end();
    this.#gone();
  }

  destroy() { this.socket.destroy(); this.#gone(); }

  #gone() {
    if (this.closed) return;
    this.closed = true; clearInterval(this.ping); this.all.delete(this);
    this.onClose();
  }

  #frame(opcode, payload) {
    if (this.socket.destroyed) return;
    const n = payload.length;
    const head = n < 126 ? Buffer.from([0x80 | opcode, n]) : n < 65536 ? Buffer.from([0x80 | opcode, 126, n >> 8, n & 255]) : (() => { const h = Buffer.alloc(10); h[0] = 0x80 | opcode; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); return h; })();
    this.socket.write(Buffer.concat([head, payload]));
  }

  #read() {
    for (;;) {
      const b = this.buffer;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0, opcode = b[0] & 0x0f, masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f, at = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); at = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); at = 10; }
      if (len > 1 << 20 || this.parts.reduce((s, p) => s + p.length, 0) + len > 1 << 20) { this.close(1009, 'a message is at most 1 MiB'); return; }
      const need = at + (masked ? 4 : 0) + len;
      if (b.length < need) return;
      let payload = b.subarray(at + (masked ? 4 : 0), need);
      if (masked) { const mask = b.subarray(at, at + 4); payload = Buffer.from(payload.map((x, i) => x ^ mask[i & 3])); }
      this.buffer = b.subarray(need);
      if (opcode === 0x8) { this.close(); return; }
      if (opcode === 0x9) { this.#frame(0xA, payload); continue; }
      if (opcode === 0xA) continue;
      if (opcode === 0x1 || opcode === 0x0) {
        this.parts.push(payload);
        if (!fin) continue;
        const text = Buffer.concat(this.parts).toString(); this.parts = [];
        let msg;
        try { msg = JSON.parse(text); } catch { continue; } // not a message
        this.onMessage(msg);
      }
    }
  }
}
