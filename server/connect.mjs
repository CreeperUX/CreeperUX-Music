// Sonus Connect for the demo server: the protocol of the Navidrome fork (CreeperUX/navidrome, server/connect/README.md),
// so the app's devices can be tested without it. A user's players see each other (devices), report what they play
// (state), and send each other commands and transfers. Over a small WebSocket written here (RFC 6455: the handshake,
// text frames, ping / pong, close), as Node has no WebSocket server of its own.
import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'; // RFC 6455 §1.3
export const EXTENSION = { name: 'sonusConnect', versions: [1] };

/** Serves rest/connect on the HTTP server. authenticate(query) → the user name, or null. */
export function attachConnect(server, { authenticate, isOffline = () => false }) {
  const rooms = new Map(); // user → Map(deviceId → device)
  const all = new Set();   // every socket, for going offline

  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url, 'http://x');
    if (!/^\/rest\/connect(\.view)?$/.test(url.pathname) || isOffline()) { socket.destroy(); return; }
    const user = authenticate(url.searchParams);
    const client = url.searchParams.get('c') ?? '';
    if (!user || !client) { socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return; }
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${createHash('sha1').update(key + GUID).digest('base64')}\r\n\r\n`);
    // the player, as Navidrome registers one: per user and client name
    const id = createHash('md5').update(`${user}\0${client}`).digest('hex').slice(0, 16);
    join(user, id, client, new Socket(socket, all));
  });

  function join(user, id, client, ws) {
    const room = rooms.get(user) ?? new Map();
    rooms.set(user, room);
    const old = room.get(id);
    const d = { id, name: old?.name ?? client, kind: old?.kind ?? 'other', client, canPlay: old?.canPlay ?? true, connectedAt: Date.now(), state: old?.state ?? null, queue: old?.queue ?? null, ws };
    room.set(id, d);
    old?.ws.close(4000, 'replaced by a newer connection');
    ws.send({ type: 'welcome', version: 1, deviceId: id, serverTime: Date.now() });
    broadcast(user);
    ws.onMessage = msg => handle(user, id, msg);
    ws.onClose = () => { if (room.get(id)?.ws === ws) { room.delete(id); if (!room.size) rooms.delete(user); broadcast(user); } };
  }

  function handle(user, id, msg) {
    const room = rooms.get(user), d = room?.get(id);
    if (!d) return;
    const reply = (code, message) => d.ws.send({ type: 'error', code, message });
    switch (msg.type) {
      case 'hello':
        if (msg.name) d.name = String(msg.name).slice(0, 80);
        if (msg.kind) d.kind = ['desktop', 'web', 'phone', 'speaker'].includes(msg.kind) ? msg.kind : 'other';
        if (typeof msg.canPlay === 'boolean') d.canPlay = msg.canPlay;
        broadcast(user); break;
      case 'state':
        if (!msg.state) return;
        d.state = { ...msg.state, at: Date.now() };
        if (msg.queue) d.queue = msg.queue;
        broadcast(user); break;
      case 'command': {
        const target = room.get(msg.target);
        if (!msg.command) return;
        if (!target) reply('offline', '该设备已离线。');
        else target.ws.send({ type: 'command', from: id, command: msg.command });
        break;
      }
      case 'transfer': {
        const from = room.get(msg.from || id), to = room.get(msg.to);
        if (!msg.to || msg.to === (msg.from || id)) return;
        if (!to) { reply('offline', '目标设备已离线。'); return; }
        if (!from?.state || !from.queue?.ids?.length) { reply('nothing', '这台设备没有可以转移的播放内容。'); return; }
        const position = from.state.positionMs + (from.state.playing ? Date.now() - from.state.at : 0);
        const play = typeof msg.play === 'boolean' ? msg.play : from.state.playing;
        to.ws.send({ type: 'command', from: id, command: { action: 'load', queue: from.queue, positionMs: position, play, context: from.state.context, source: from.id } });
        from.ws.send({ type: 'command', from: id, command: { action: 'stop' } });
        break;
      }
    }
  }

  function broadcast(user) {
    const room = rooms.get(user);
    if (!room) return;
    const devices = [...room.values()].sort((a, b) => a.connectedAt - b.connectedAt)
      .map(({ id, name, kind, client, canPlay, connectedAt, state }) => ({ id, name, kind, client, canPlay, connectedAt, ...(state ? { state } : {}) }));
    for (const d of room.values()) d.ws.send({ type: 'devices', serverTime: Date.now(), devices });
  }

  return {
    /** Drops every connection (the server going offline). */
    dropAll: () => { for (const s of all) s.destroy(); },
    devices: user => [...(rooms.get(user)?.values() ?? [])].map(d => ({ id: d.id, name: d.name, kind: d.kind, state: d.state })),
  };
}

/** One WebSocket connection, server side. */
class Socket {
  constructor(socket, all) {
    this.socket = socket; this.all = all; this.buffer = Buffer.alloc(0); this.parts = []; this.closed = false;
    this.onMessage = () => {}; this.onClose = () => {};
    all.add(this);
    socket.setNoDelay(true);
    socket.on('data', d => { this.buffer = Buffer.concat([this.buffer, d]); this.#read(); });
    socket.on('close', () => this.#gone());
    socket.on('error', () => this.#gone());
    this.ping = setInterval(() => this.#frame(0x9, Buffer.alloc(0)), 30_000);
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
      if (len > 4 << 20) { this.close(1009, 'too big'); return; }
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
        try { this.onMessage(JSON.parse(text)); } catch { /* not a message */ }
      }
    }
  }
}
