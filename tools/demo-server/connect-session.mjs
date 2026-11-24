// Sonus Connect version 2, the server's half, as a pure module (docs/protocol/connect.md): one playback session per user,
// its queue and the user's devices. No sockets, timers or clock of its own: the caller hands in each message with the
// time (`now`) and a source of random numbers (`random`), and gets back what to send to which device. The same steps
// therefore always give the same result, which is what the test vectors (docs/protocol/connect-vectors.json) pin down
// for every server that implements the protocol (this demo server, the Rust server).
//
// The queue is the Windows app's src/Sonus.Core/PlayQueue.cs, line by line, plus the key of the song that plays.

export const MODES = ['default', 'repeatAll', 'repeatOne', 'random', 'shuffleTracks', 'shuffleAlbums', 'shuffleFolders'];
export const KINDS = ['desktop', 'web', 'phone', 'tablet', 'speaker', 'other'];
export const LIMITS = { order: 10_000, manual: 1_000, devices: 32, graceMs: 10_000, name: 80, client: 120 };
const DEVICE_ID = /^[A-Za-z0-9_-]{8,64}$/;
const shuffled = m => m === 'shuffleTracks' || m === 'shuffleAlbums' || m === 'shuffleFolders';

/** A random source from Math.random: n → an integer in [0, n). */
export const mathRandom = n => Math.floor(Math.random() * n);

/** A random source that hands out the given numbers in turn (each modulo n), then 0s: what the test vectors use. */
export function sequenceRandom(values) {
  let i = 0;
  const source = n => (i < values.length ? ((values[i++] % n) + n) % n : 0);
  source.used = () => i;
  return source;
}

// ---------------------------------------------------------------- the queue (PlayQueue.cs)
/**
 * What plays and what comes next: the context in playback order with a pointer, and the songs queued by hand, which
 * play first. `has(id)`: the song is in the library (unknown ids are left out, as PlayQueue's lookup does).
 */
export class PlayQueue {
  constructor({ has = () => true, random = mathRandom } = {}) {
    this.has = has; this.random = random;
    this.context = [];   // the context in playback order
    this.source = [];    // the context in its own order, to come back to from shuffling
    this.pointer = -1;
    this.manual = [];    // [{ key: 'q<n>', trackId }]
    this.nextId = 0;
    this.current = null;
    this.currentKey = null; // the entry the current song was when it became current (kept while the queue is rearranged)
    this.order = 'default';
    this.stopAfterCurrent = false;
  }

  /** Hand-queued songs first, then the rest of the context: [{ key, trackId, manual }]. */
  get entries() {
    return [
      ...this.manual.map(m => ({ key: m.key, trackId: m.trackId, manual: true })),
      ...this.context.slice(this.pointer + 1).map((t, i) => ({ key: `c${this.pointer + 1 + i}:${t}`, trackId: t, manual: false })),
    ];
  }

  #at(pointer) { this.pointer = pointer; this.current = this.context[pointer]; this.currentKey = `c${pointer}:${this.current}`; return this.current; }

  /** Plays from a context: from startId, or its first song (a random one when shuffling). `arranged`: the context in the
   *  order the sender arranged it (shuffling by album or folder, which needs what only the sender knows). Null: no song. */
  start(ids, startId, shuffle = false, arranged = null) {
    if (shuffle && !shuffled(this.order)) this.order = 'shuffleTracks';
    const known = ids.filter(id => this.has(id));
    if (known.length === 0) return null;
    // (an arranged context starts with its first song: the sender put the one to start with there)
    const start = startId != null && known.includes(startId) ? startId
      : arranged?.find(id => known.includes(id)) ?? (shuffled(this.order) || this.order === 'random' ? known[this.random(known.length)] : known[0]);
    this.source = known;
    this.context = this.#arrange(known, this.order, start, arranged);
    return this.#at(Math.max(0, this.context.indexOf(start)));
  }

  /** The song that follows when the current one ends (what next(true) returns), without moving; null when that is not a
   *  different song known now (stop after current, repeat one, random). */
  peek() {
    if (this.stopAfterCurrent || this.order === 'repeatOne') return null;
    if (this.manual.length > 0) return this.manual[0].trackId;
    if (this.order === 'random') return null;
    if (this.pointer + 1 < this.context.length) return this.context[this.pointer + 1];
    return (this.order === 'repeatAll' || shuffled(this.order)) && this.context.length > 0 ? this.context[0] : null;
  }

  /** Moves to the next song (hand-queued first). Null: the end. */
  next(ended = false) {
    if (ended && this.stopAfterCurrent) { this.stopAfterCurrent = false; return null; }
    if (ended && this.order === 'repeatOne') return this.current;
    if (this.manual.length > 0) {
      const m = this.manual.shift();
      this.current = m.trackId; this.currentKey = m.key;
      return this.current;
    }
    return this.#step(1);
  }

  /** The previous song in the context; while a hand-queued song plays, the context song that played before it. */
  previous() {
    if (this.current != null && this.pointer >= 0 && this.pointer < this.context.length && this.context[this.pointer] !== this.current)
      return this.#at(this.pointer);
    return this.#step(-1);
  }

  #step(dir) {
    if (this.context.length === 0) return null;
    let at = this.pointer + dir;
    if (this.order === 'random') at = this.random(this.context.length);
    if (at >= this.context.length || at < 0) {
      if (this.order === 'repeatAll' || shuffled(this.order)) at = dir > 0 ? 0 : this.context.length - 1;
      else return null;
    }
    return this.#at(at);
  }

  setOrder(order, arranged = null) {
    const was = this.order;
    this.order = order;
    if (this.context.length > 0 && (shuffled(order) || shuffled(was))) {
      // back from shuffling: the context's own order, without the songs removed from the queue meanwhile
      const basis = shuffled(order) ? this.context : [...new Set(this.source.filter(id => this.context.includes(id)))];
      this.context = this.#arrange(basis, order, this.current, arranged);
      this.pointer = Math.max(0, this.current == null ? 0 : this.context.indexOf(this.current));
    }
  }

  add(trackIds, next = false, room = Infinity) {
    const added = trackIds.filter(id => this.has(id)).slice(0, Math.max(0, room)).map(id => ({ key: `q${++this.nextId}`, trackId: id }));
    this.manual = next ? [...added, ...this.manual] : [...this.manual, ...added];
    return added.length;
  }

  /** A drag in the queue panel: order is every entry key in the new order, keys the moved ones, now in manual's section. */
  move(order, keys, manual) {
    const entries = new Map(this.entries.map(e => [e.key, e]));
    const placed = order.filter(k => entries.has(k)).map(k => (keys.includes(k) ? { ...entries.get(k), manual } : entries.get(k)));
    this.manual = placed.filter(e => e.manual).map(e => (e.key.startsWith('q') ? { key: e.key, trackId: e.trackId } : { key: `q${++this.nextId}`, trackId: e.trackId }));
    this.context = [...this.context.slice(0, this.pointer + 1), ...placed.filter(e => !e.manual).map(e => e.trackId)];
  }

  remove(entryKeys) {
    const keys = new Set(entryKeys);
    // a context entry is "c<index>:<song>": only removed while that index still holds that song and is still to come
    const indexes = new Set([...keys].filter(k => k.startsWith('c')).map(k => this.#contextIndex(k)).filter(i => i >= 0));
    this.manual = this.manual.filter(m => !keys.has(m.key));
    this.context = this.context.filter((_, i) => !indexes.has(i));
  }

  clear(manual) {
    if (manual) this.manual = []; else this.context = this.context.slice(0, this.pointer + 1);
  }

  #contextIndex(key) {
    const m = /^c(\d+):/.exec(key);
    if (!m) return -1;
    const i = Number(m[1]);
    return i > this.pointer && i < this.context.length && this.context[i] === key.slice(m[0].length) ? i : -1;
  }

  /** Jumps to a queue entry; returns its song, or null when there is no such entry (any more). */
  jump(key) {
    const e = this.entries.find(x => x.key === key);
    if (!e) return null;
    if (e.manual) this.manual = this.manual.filter(m => m.key !== key);
    else this.pointer = Number(key.slice(1, key.indexOf(':')));
    this.current = e.trackId; this.currentKey = key;
    return this.current;
  }

  #arrange(ids, order, start, arranged) {
    if (order === 'shuffleTracks') {
      const rest = this.#shuffle(ids.filter(id => id !== start));
      return start != null && ids.includes(start) ? [start, ...rest] : rest;
    }
    if (order === 'shuffleAlbums' || order === 'shuffleFolders') {
      // albums and folders are what the sender knows: it sends the arranged context (checked by the caller)
      return (arranged ?? ids).filter(id => this.has(id));
    }
    return [...ids];
  }

  #shuffle(items) {
    const list = [...items];
    for (let i = list.length - 1; i > 0; i--) { const j = this.random(i + 1); [list[i], list[j]] = [list[j], list[i]]; }
    return list;
  }

  toJSON() {
    const { context, source, pointer, manual, nextId, current, currentKey, order, stopAfterCurrent } = this;
    return { context, source, pointer, manual, nextId, current, currentKey, order, stopAfterCurrent };
  }

  restore(saved) {
    for (const k of ['context', 'source', 'pointer', 'manual', 'nextId', 'current', 'currentKey', 'order', 'stopAfterCurrent']) if (saved?.[k] !== undefined) this[k] = saved[k];
    return this;
  }
}

/**
 * At most `limit` songs of a context: a window of them in their own order that holds the start song (from 100 before
 * it), or the first ones. Sending clients do the same, so a library-sized context stays within the protocol's limits.
 */
export function window(ids, startId, limit = LIMITS.order) {
  if (ids.length <= limit) return ids;
  const at = startId != null ? ids.indexOf(startId) : -1;
  const from = at < 0 ? 0 : Math.max(0, Math.min(at - 100, ids.length - limit));
  return ids.slice(from, from + limit);
}

// ---------------------------------------------------------------- the session
class Fail extends Error { constructor(code, message, extra = {}) { super(message); this.code = code; this.extra = extra; } }
const fail = (code, message, extra) => { throw new Fail(code, message, extra); };
const MESSAGES = {
  nothing: '没有可以播放的歌曲。', cannotPlay: '这台设备不能播放。', offline: '这台设备不在线。', notActive: '这台设备不是正在播放的设备。',
  stale: '队列已经变了，这个操作没有执行。', invalid: '无效的请求。', unplayable: '这首歌无法播放，已跳到下一首。',
};
const isStr = v => typeof v === 'string';
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const strings = v => Array.isArray(v) && v.every(isStr);

/**
 * One user's session and devices. Options: now() → ms (the server's clock), random(n), has(id) (the library has the
 * song), lookup(id) → { title, artist, album, albumId, coverArt, durationMs } or null (what a device shows before the
 * active device reports `loaded`), graceMs, maxDevices.
 *
 * Calls return what to send: [{ to: deviceId, msg }] and [{ close: deviceId, code, reason }].
 */
export class ConnectSession {
  constructor({ now = Date.now, random = mathRandom, has = () => true, lookup = () => null, graceMs = LIMITS.graceMs, maxDevices = LIMITS.devices, saved = null } = {}) {
    this.clock = now; this.has = has; this.lookup = lookup; this.graceMs = graceMs; this.maxDevices = maxDevices;
    this.queue = new PlayQueue({ has, random });
    this.devices = new Map(); // id → { id, name, kind, client, canPlay, connectedAt, volume, muted, online, lastSeen }
    this.rev = 0; this.queueRev = 0;
    this.activeDevice = null; this.lastDevice = null;
    this.playing = false; this.positionMs = 0; this.at = 0; this.durationMs = 0; this.now = null;
    this.context = null;
    this.cmdRev = 0;      // the rev after the last change a command made: older playing/paused/position reports are ignored
    this.grace = null;    // { device, until, droppedAt }: the active device's connection dropped
    this.graceStop = null; // { device, revBefore, revAfter }: the grace ran out and stopped the session
    this.failures = 0;    // songs in a row that failed
    if (saved) this.#restore(saved);
  }

  // ---------------------------------------------------------------- what devices see
  get current() { return this.queue.current == null ? null : { key: this.queue.currentKey, trackId: this.queue.current, manual: this.queue.currentKey?.startsWith('q') ?? false }; }

  /** The position at the server's time t (it moves on while playing). */
  positionAt(t = this.clock()) {
    const p = this.playing ? this.positionMs + Math.max(0, t - this.at) : this.positionMs;
    return this.durationMs > 0 ? Math.min(p, this.durationMs) : p;
  }

  session() {
    return {
      rev: this.rev, activeDevice: this.activeDevice, lastDevice: this.lastDevice, current: this.current, next: this.queue.peek(),
      playing: this.playing, positionMs: this.positionMs, at: this.at, durationMs: this.durationMs, now: this.now,
      mode: this.queue.order, stopAfterCurrent: this.queue.stopAfterCurrent, context: this.context, queueRev: this.queueRev,
    };
  }

  queueView() {
    return { queueRev: this.queueRev, order: [...this.queue.context], pointer: this.queue.pointer, manual: this.queue.manual.map(m => ({ key: m.key, trackId: m.trackId })) };
  }

  /** The devices as the others list them: the connected ones, and the active one through its grace period. */
  deviceList() {
    return [...this.devices.values()].filter(d => d.online || d.id === this.activeDevice).sort((a, b) => a.connectedAt - b.connectedAt || (a.id < b.id ? -1 : 1))
      .map(({ id, name, kind, client, canPlay, connectedAt, volume, muted }) => ({ id, name, kind, client, canPlay, connectedAt, volume, muted }));
  }

  online() { return [...this.devices.values()].filter(d => d.online).map(d => d.id); }

  /** When tick() has something to do (the grace period's end), or null. */
  nextTimer() { return this.grace?.until ?? null; }

  // ---------------------------------------------------------------- connections
  /** A connection's first message. Returns { id, out } (id null: refused; out then holds the error to send before closing). */
  hello(msg) {
    const t = this.clock();
    if (msg?.type !== 'hello' || !isStr(msg.deviceId) || !DEVICE_ID.test(msg.deviceId))
      return { id: null, out: [{ reply: { type: 'error', ...(isStr(msg?.ref) ? { ref: msg.ref } : {}), code: 'invalid', message: '第一条消息必须是 hello，带上设备 id（8–64 个字母、数字、_ 或 -）。' } }] };
    const id = msg.deviceId;
    return this.#change(id, msg, () => {
      const out = [];
      const old = this.devices.get(id);
      // a full list: the device silent longest goes (not one connecting now)
      const online = this.online().filter(x => x !== id);
      if (!old?.online && online.length >= this.maxDevices) {
        const victim = online.map(x => this.devices.get(x)).sort((a, b) => a.lastSeen - b.lastSeen)[0];
        out.push({ close: victim.id, code: 4001, reason: 'too many devices' }, ...this.#dropNow(victim.id, t));
      }
      const d = {
        id, name: isStr(msg.name) && msg.name.trim() ? msg.name.trim().slice(0, LIMITS.name) : old?.name ?? id,
        kind: KINDS.includes(msg.kind) ? msg.kind : 'other', client: isStr(msg.client) ? msg.client.slice(0, LIMITS.client) : old?.client ?? '',
        canPlay: typeof msg.canPlay === 'boolean' ? msg.canPlay : true,
        connectedAt: old?.online ? old.connectedAt : t, volume: old?.volume ?? 1, muted: old?.muted ?? false, online: true, lastSeen: t,
      };
      this.devices.set(id, d);
      if (this.lastDevice?.id === id) this.lastDevice = { id, name: d.name };
      if (this.grace?.device === id) this.grace = null; // back in time: still the active device
      else if (msg.resume && typeof msg.resume === 'object' && this.activeDevice === null && d.canPlay && this.graceStop?.device === id
        && this.rev === this.graceStop.revAfter && msg.resume.rev === this.graceStop.revBefore && this.current) {
        // it kept playing through a short network loss, and nothing changed since: it is the active device again
        this.#activate(id);
        this.playing = Boolean(msg.resume.playing);
        this.positionMs = this.#clampPosition(isNum(msg.resume.positionMs) ? msg.resume.positionMs : this.positionMs); this.at = t;
        this.graceStop = null;
        return { out, welcome: true, command: true };
      }
      return { out, welcome: true };
    });
  }

  /** The connection of that device went away. */
  drop(id) {
    const out = this.#dropNow(id, this.clock());
    return out;
  }

  #dropNow(id, t) {
    const d = this.devices.get(id);
    if (!d?.online) return [];
    d.online = false;
    if (this.activeDevice === id) { this.grace = { device: id, until: t + this.graceMs, droppedAt: t }; return []; } // listed until the grace ends
    this.devices.delete(id);
    return this.#broadcastDevices();
  }

  /** Time passed: the grace period may have run out. */
  tick() {
    const t = this.clock();
    if (!this.grace || t < this.grace.until) return [];
    const { device, droppedAt } = this.grace;
    this.grace = null;
    if (this.activeDevice !== device) return [];
    const revBefore = this.rev;
    const out = this.#change(null, {}, () => {
      // stopped where it was when the connection dropped (or where a command put it since)
      const at = Math.max(this.at, droppedAt);
      this.positionMs = this.#clampPosition(this.playing ? this.positionMs + Math.max(0, at - this.at) : this.positionMs);
      this.playing = false; this.at = t; this.activeDevice = null;
      if (!this.devices.get(device)?.online) this.devices.delete(device);
      return { devices: true };
    }).out;
    this.graceStop = { device, revBefore, revAfter: this.rev };
    return out;
  }

  // ---------------------------------------------------------------- messages
  /** A message from a connected device (after its hello). */
  message(id, msg) {
    const d = this.devices.get(id);
    if (!d?.online) return [];
    d.lastSeen = this.clock();
    if (!msg || typeof msg !== 'object') return [];
    switch (msg.type) {
      case 'command': return this.#change(id, msg, () => this.#command(id, msg)).out;
      case 'report': return this.#change(id, msg, () => this.#report(id, msg)).out;
      case 'device': return this.#change(id, msg, () => {
        if (isNum(msg.volume)) d.volume = Math.min(1, Math.max(0, msg.volume));
        if (typeof msg.muted === 'boolean') d.muted = msg.muted;
        return { devices: true };
      }).out;
      case 'hello': return this.#reply(id, msg, 'invalid', '已经连接了。');
      default: return this.#reply(id, msg, 'invalid', `未知的消息类型：${msg.type}`);
    }
  }

  #reply(id, msg, code, message, extra = {}) {
    return [{ to: id, msg: { type: 'error', ...(isStr(msg.ref) ? { ref: msg.ref } : {}), code, message: message ?? MESSAGES[code], ...extra } }];
  }

  /**
   * Runs a change and works out what to send: the session to every device when it changed (rev + 1), the queue first when
   * it changed (queueRev + 1), the device list when asked, and an ack or error to the sender.
   */
  #change(id, msg, apply) {
    const queueBefore = JSON.stringify(this.queueView());
    const sessionBefore = JSON.stringify(this.session());
    const before = this.#state();
    let result, error = null;
    try { result = apply() ?? {}; } catch (e) { if (!(e instanceof Fail)) throw e; error = e; result = {}; this.#reset(before); } // refused: nothing changes
    const out = [...(result.out ?? [])];
    const queueChanged = JSON.stringify(this.queueView()) !== queueBefore;
    if (queueChanged) this.queueRev++;
    const changed = queueChanged || JSON.stringify(this.session()) !== sessionBefore;
    if (changed) {
      this.rev++;
      if (result.command) this.cmdRev = this.rev;
    }
    const t = this.clock();
    const others = this.online().filter(x => !(result.welcome && x === id));
    if (result.welcome) out.push({ to: id, msg: { type: 'welcome', version: 2, deviceId: id, serverTime: t, session: this.session(), queue: this.queueView(), devices: this.deviceList() } });
    if (queueChanged) for (const to of others) out.push({ to, msg: { type: 'queue', queue: this.queueView() } });
    if (changed) for (const to of others) out.push({ to, msg: { type: 'session', serverTime: t, session: this.session() } });
    if (result.welcome || result.devices) out.push(...this.#broadcastDevices(result.welcome ? id : null));
    if (error) out.push(...this.#reply(id, msg, error.code, error.message, error.extra));
    else if (id && isStr(msg.ref) && !result.welcome && !result.noAck) out.push({ to: id, msg: { type: 'ack', ref: msg.ref, rev: this.rev } });
    return { id, out };
  }

  #broadcastDevices(except = null) {
    const devices = this.deviceList(), t = this.clock();
    return this.online().filter(x => x !== except).map(to => ({ to, msg: { type: 'devices', serverTime: t, devices } }));
  }

  // ---------------------------------------------------------------- commands (any device)
  #command(id, c) {
    if (isNum(c.rev) && c.rev !== this.rev) fail('stale', MESSAGES.stale);
    const t = this.clock();
    const sender = this.devices.get(id);
    const keyBefore = this.queue.currentKey;
    const need = () => { if (!this.current) fail('nothing', MESSAGES.nothing); };
    const claim = () => { // with no active device, the sender plays (rule 6)
      if (this.activeDevice !== null) return;
      if (!sender.canPlay) fail('cannotPlay', MESSAGES.cannotPlay);
      this.#activate(id);
    };
    const setPlaying = on => { this.positionMs = this.positionAt(t); this.at = t; this.playing = on && this.activeDevice !== null; };
    const moved = song => { // the queue moved to another song (or the same one again): from its start
      if (song == null) { this.positionMs = 0; this.at = t; this.playing = false; return; }
      if (this.queue.currentKey !== keyBefore) this.#loaded();
      this.positionMs = 0; this.at = t; this.playing = this.activeDevice !== null;
    };
    switch (c.action) {
      case 'play':
        if (!this.current) { if (this.queue.manual.length === 0) need(); claim(); moved(this.queue.next()); break; }
        claim(); setPlaying(true); break;
      case 'pause': need(); setPlaying(false); break;
      case 'toggle': need(); if (this.playing) setPlaying(false); else { claim(); setPlaying(true); } break;
      case 'seek':
        need(); if (!isNum(c.positionMs)) fail('invalid', 'seek 需要 positionMs。');
        this.positionMs = this.#clampPosition(c.positionMs); this.at = t; break;
      case 'next': {
        if (!this.current && this.queue.manual.length === 0) need();
        const song = this.queue.next();
        if (song != null) moved(song); else { this.positionMs = 0; this.at = t; this.playing = false; }
        break;
      }
      case 'previous': {
        need();
        if (this.positionAt(t) > 3000) { this.positionMs = 0; this.at = t; break; }
        const song = this.queue.previous();
        if (song != null) moved(song); else { this.positionMs = 0; this.at = t; }
        break;
      }
      case 'playContext': {
        if (!strings(c.ids) || c.ids.length === 0) fail('invalid', 'playContext 需要 ids。');
        if (c.startId != null && !isStr(c.startId)) fail('invalid', 'startId 必须是字符串。');
        if (c.order != null && !strings(c.order)) fail('invalid', 'order 必须是歌曲 id 的列表。');
        const mode = c.shuffle === true && !shuffled(this.queue.order) ? 'shuffleTracks' : this.queue.order;
        if ((mode === 'shuffleAlbums' || mode === 'shuffleFolders') && !c.order) fail('invalid', '按专辑或文件夹随机时，发送方要给出排好的 order。');
        claim();
        const ids = window(c.ids, c.startId);
        const arranged = mode === 'shuffleAlbums' || mode === 'shuffleFolders' ? window(c.order, c.startId) : null;
        const song = this.queue.start(ids, c.startId ?? null, c.shuffle === true, arranged);
        if (song == null) fail('invalid', '这些歌曲都不在媒体库里。');
        const ctx = c.context && typeof c.context === 'object' ? c.context : {};
        this.context = { kind: isStr(ctx.kind) ? ctx.kind : null, id: isStr(ctx.id) ? ctx.id : null, label: isStr(ctx.label) ? ctx.label : null };
        moved(song);
        if (isNum(c.positionMs) && c.positionMs > 0) this.positionMs = this.#clampPosition(c.positionMs);
        break;
      }
      case 'jump': {
        if (!isStr(c.entry)) fail('invalid', 'jump 需要 entry。');
        const song = this.queue.jump(c.entry);
        if (song == null) fail('stale', MESSAGES.stale, { entries: [c.entry] });
        moved(song);
        break;
      }
      case 'add':
        if (!strings(c.ids)) fail('invalid', 'add 需要 ids。');
        this.queue.add(c.ids, c.next === true, LIMITS.manual - this.queue.manual.length);
        break;
      case 'move': {
        if (!strings(c.order) || !strings(c.keys) || typeof c.manual !== 'boolean') fail('invalid', 'move 需要 order、keys 和 manual。');
        const keys = new Set(this.queue.entries.map(e => e.key));
        const listed = new Set(c.order);
        // the whole queue as the sender saw it, or nothing: a move made on an older queue would drop what came since
        if (listed.size !== c.order.length || listed.size !== keys.size || [...listed].some(k => !keys.has(k)) || c.keys.some(k => !keys.has(k)))
          fail('stale', MESSAGES.stale, { entries: [...c.keys.filter(k => !keys.has(k)), ...[...listed].filter(k => !keys.has(k))] });
        this.queue.move(c.order, c.keys, c.manual);
        break;
      }
      case 'remove': {
        if (!strings(c.entries)) fail('invalid', 'remove 需要 entries。');
        const keys = new Set(this.queue.entries.map(e => e.key));
        const stale = c.entries.filter(k => !keys.has(k));
        this.queue.remove(c.entries);
        if (stale.length) return { command: true, out: this.#reply(id, c, 'stale', MESSAGES.stale, { entries: stale }), noAck: true };
        break;
      }
      case 'clear':
        if (typeof c.manual !== 'boolean') fail('invalid', 'clear 需要 manual。');
        this.queue.clear(c.manual);
        break;
      case 'mode': {
        if (!MODES.includes(c.mode)) fail('invalid', `未知的播放顺序：${c.mode}`);
        if ((c.mode === 'shuffleAlbums' || c.mode === 'shuffleFolders') && this.queue.context.length > 0 && !strings(c.order))
          fail('invalid', '按专辑或文件夹随机时，发送方要给出排好的 order。');
        this.queue.setOrder(c.mode, strings(c.order) ? c.order : null);
        break;
      }
      case 'stopAfterCurrent':
        if (typeof c.on !== 'boolean') fail('invalid', 'stopAfterCurrent 需要 on。');
        this.queue.stopAfterCurrent = c.on;
        break;
      case 'transfer': {
        const to = isStr(c.to) ? this.devices.get(c.to) : null;
        if (!to?.online) fail('offline', MESSAGES.offline);
        if (!to.canPlay) fail('cannotPlay', MESSAGES.cannotPlay);
        need();
        const play = typeof c.play === 'boolean' ? c.play : this.playing;
        this.positionMs = this.positionAt(t); this.at = t;
        this.#activate(to.id);
        this.playing = play;
        break;
      }
      case 'volume': {
        const target = isStr(c.device) ? this.devices.get(c.device) : null;
        if (!target?.online) fail('offline', MESSAGES.offline);
        if (!isNum(c.volume) && typeof c.muted !== 'boolean') fail('invalid', 'volume 需要 volume 或 muted。');
        const msg = { type: 'deviceCommand', action: 'volume', ...(isNum(c.volume) ? { volume: Math.min(1, Math.max(0, c.volume)) } : {}), ...(typeof c.muted === 'boolean' ? { muted: c.muted } : {}), from: id };
        return { out: [{ to: target.id, msg }] };
      }
      default: fail('invalid', `未知的命令：${c.action}`);
    }
    return { command: true };
  }

  // ---------------------------------------------------------------- reports (the active device)
  #report(id, r) {
    if (this.activeDevice !== id) fail('notActive', MESSAGES.notActive);
    if (!this.current || r.key !== this.current.key) fail('stale', '这首歌已经不是当前的歌曲了。'); // about a song no longer current: ignored
    const t = this.clock();
    const keyBefore = this.queue.currentKey;
    const position = () => (isNum(r.positionMs) ? this.#clampPosition(r.positionMs) : this.positionAt(t));
    // what the device did before it followed the last command (a seek, a pause from another device) is out of date
    const late = () => isNum(r.rev) && r.rev < this.cmdRev;
    switch (r.event) {
      case 'loaded':
        if (isNum(r.durationMs) && r.durationMs >= 0) this.durationMs = Math.round(r.durationMs);
        if (r.now && typeof r.now === 'object') this.now = pickNow(r.now);
        break;
      case 'playing': case 'paused':
        if (late()) fail('stale', MESSAGES.stale);
        this.positionMs = position(); this.at = t; this.playing = r.event === 'playing';
        if (r.event === 'playing') this.failures = 0;
        break;
      case 'position':
        if (late()) fail('stale', MESSAGES.stale);
        this.positionMs = position(); this.at = t;
        break;
      case 'ended': {
        const song = this.queue.next(true);
        this.positionMs = 0; this.at = t;
        if (song == null) this.playing = false; else { if (this.queue.currentKey !== keyBefore) this.#loaded(); this.playing = true; }
        break;
      }
      case 'failed': {
        // skipped, as when the song had ended (five in a row: stopped, rather than going round a list that can't play)
        this.failures++;
        const song = this.queue.next();
        this.positionMs = 0; this.at = t;
        if (song == null || this.failures >= 5) this.playing = false;
        if (song != null && this.queue.currentKey !== keyBefore) this.#loaded();
        return { out: this.#reply(id, r, 'unplayable', MESSAGES.unplayable), noAck: true };
      }
      default: fail('invalid', `未知的报告：${r.event}`);
    }
    return {};
  }

  // ---------------------------------------------------------------- helpers
  #state() {
    const { activeDevice, lastDevice, playing, positionMs, at, durationMs, now, context, grace, failures } = this;
    return { queue: JSON.stringify(this.queue.toJSON()), activeDevice, lastDevice, playing, positionMs, at, durationMs, now, context, grace, failures };
  }

  #reset({ queue, ...rest }) { this.queue.restore(JSON.parse(queue)); Object.assign(this, rest); }

  #activate(id) {
    this.activeDevice = id;
    const d = this.devices.get(id);
    this.lastDevice = { id, name: d?.name ?? id };
    this.grace = null;
  }

  /** A new current song: what the server knows of it, until the active device reports `loaded`. */
  #loaded() {
    const meta = this.queue.current == null ? null : this.lookup(this.queue.current);
    this.durationMs = isNum(meta?.durationMs) ? Math.round(meta.durationMs) : 0;
    this.now = meta ? pickNow(meta) : null;
  }

  #clampPosition(ms) { const p = Math.max(0, Math.round(ms)); return this.durationMs > 0 ? Math.min(p, this.durationMs) : p; }

  // ---------------------------------------------------------------- kept across restarts
  /** What the server stores (rule 6): restored with no active device, paused where it was. */
  save() {
    return {
      version: 2, rev: this.rev, queueRev: this.queueRev, lastDevice: this.lastDevice, positionMs: this.positionAt(), durationMs: this.durationMs,
      now: this.now, context: this.context, queue: this.queue.toJSON(),
    };
  }

  #restore(s) {
    this.rev = s.rev ?? 0; this.queueRev = s.queueRev ?? 0; this.lastDevice = s.lastDevice ?? null;
    this.positionMs = s.positionMs ?? 0; this.at = this.clock(); this.durationMs = s.durationMs ?? 0; this.now = s.now ?? null; this.context = s.context ?? null;
    this.queue.restore(s.queue);
  }
}

function pickNow(n) {
  const s = v => (isStr(v) ? v : null);
  return { title: s(n.title), artist: s(n.artist), album: s(n.album), albumId: s(n.albumId), coverArt: s(n.coverArt) };
}
