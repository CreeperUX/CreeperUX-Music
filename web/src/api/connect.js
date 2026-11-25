// Sonus Connect version 2, the client's state (docs/protocol/connect.md): the user's one playback session as the server
// sends it, its queue and devices, and what this device does about it. No browser APIs here (no WebSocket, no <audio>),
// so it runs in node too: web/test/connect-vectors.test.mjs replays docs/protocol/connect-vectors.json through it.
// The transport is api/session.js; api/subsonic.js plays and reports.

/** The protocol's playback modes ↔ this client's orders (contract.js, PlaybackOrder). */
const MODES = { default: 'default', 'repeat-playlist': 'repeatAll', 'repeat-track': 'repeatOne', random: 'random', 'shuffle-tracks': 'shuffleTracks', 'shuffle-albums': 'shuffleAlbums', 'shuffle-folders': 'shuffleFolders' };
const ORDERS = Object.fromEntries(Object.entries(MODES).map(([k, v]) => [v, k]));
export const modeOf = order => MODES[order] ?? 'default';
export const orderOf = mode => ORDERS[mode] ?? 'default';

/** The context limit (connect.md, Queue): a window of at most `limit` songs holding the start song (from 100 before it), as the server keeps. */
export function windowOf(ids, startId, limit = 10_000) {
  if (ids.length <= limit) return ids;
  const at = startId == null ? -1 : ids.indexOf(startId);
  const from = at < 0 ? 0 : Math.max(0, Math.min(at - 100, ids.length - limit));
  return ids.slice(from, from + limit);
}

/** The queue panel's entries (connect.md, Entries): manual entries first (`q<n>`), then the context after the pointer (`c<index>:<trackId>`). */
export function entriesOf(queue) {
  if (!queue) return [];
  const manual = queue.manual.map(m => ({ id: m.key, trackId: m.trackId, section: 'queue' }));
  const rest = queue.order.slice(queue.pointer + 1).map((trackId, i) => ({ id: `c${queue.pointer + 1 + i}:${trackId}`, trackId, section: 'context' }));
  return [...manual, ...rest];
}

export const EMPTY_SESSION = Object.freeze({ rev: 0, activeDevice: null, lastDevice: null, current: null, next: null, playing: false, positionMs: 0, at: 0, durationMs: 0, now: null, mode: 'default', stopAfterCurrent: false, context: null, queueRev: 0 });
export const EMPTY_QUEUE = Object.freeze({ queueRev: 0, order: [], pointer: -1, manual: [] });

/** A new device id: 22 characters of [A-Za-z0-9_-], made once per browser profile and kept (connect.md, Devices). */
export function newDeviceId(random = n => globalThis.crypto.getRandomValues(new Uint8Array(n))) {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  return Array.from(random(22), b => abc[b & 63]).join('');
}
export const validDeviceId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(id);

/** Errors the user is not told about: the session moved on meanwhile, and what it is now is on its way (connect.md). */
export const QUIET_ERRORS = new Set(['stale', 'notActive', 'timeout']);

/**
 * The session as this device knows it. `receive(message, localNow)` takes a server message and says what changed:
 * { session, queue, devices, welcome, volume: { volume?, muted?, from }, error: { code, message, ref, … }, ack: { ref, rev } }.
 */
export function createSessionState({ deviceId, hereName = '这个浏览器' }) {
  let session = EMPTY_SESSION, queue = EMPTY_QUEUE, devices = [], offset = 0, welcomed = false;
  const state = {
    deviceId,
    get session() { return session; },
    get queue() { return queue; },
    get devices() { return devices; },
    get welcomed() { return welcomed; },
    /** The session's queue arrived for the rev the session names (a `session` can come before its `queue`). */
    get queueReady() { return queue.queueRev >= session.queueRev; },
    /** This device plays the session. */
    get isActive() { return session.activeDevice === deviceId; },
    /** Another device plays it: that device (as listed, or as much as the session says of it); null when this one or none does. */
    get activeElsewhere() {
      const a = session.activeDevice;
      if (!a || a === deviceId) return null;
      return devices.find(d => d.id === a) ?? { id: a, name: state.nameOf(a), kind: 'other', canPlay: true, volume: 1, muted: false };
    },
    /** The server's clock (ms) at the local time `localNow`. */
    serverNow: (localNow = Date.now()) => localNow + offset,
    /** The session's position (ms) at server time `serverNow`: it moves on while playing, up to the song's length. */
    positionAt(serverNow) {
      const p = session.playing ? session.positionMs + Math.max(0, serverNow - session.at) : session.positionMs;
      return session.durationMs > 0 ? Math.min(p, session.durationMs) : p;
    },
    nameOf(id) {
      if (id === deviceId) return hereName;
      return devices.find(d => d.id === id)?.name ?? (session.lastDevice?.id === id ? session.lastDevice.name : '另一台设备');
    },
    /** Where the session plays, as the bar says it: "正在「手机」上播放" while another device plays it, "上次在「书房电脑」播放"
     *  when none does; null while this device plays it, or when there is nothing to play. */
    where() {
      const p = state.place();
      return !p ? null : p.playing ? `正在「${p.name}」上播放` : `上次在「${p.name}」播放`;
    },
    /** The same, as data for the interface's own words: { playing: true, id, name } (another device plays it now) or
     *  { playing: false, id, name } (none does; it played last); null as above. */
    place() {
      if (!session.current) return null;
      const a = session.activeDevice;
      if (a) return a === deviceId ? null : { playing: true, id: a, name: state.nameOf(a) };
      return session.lastDevice ? { playing: false, id: session.lastDevice.id, name: state.nameOf(session.lastDevice.id) } : null;
    },
    entries: () => entriesOf(queue),

    receive(msg, localNow = Date.now()) {
      if (typeof msg?.serverTime === 'number') offset = msg.serverTime - localNow;
      switch (msg?.type) {
        case 'welcome':
          welcomed = true;
          session = msg.session ?? EMPTY_SESSION; queue = msg.queue ?? EMPTY_QUEUE; devices = msg.devices ?? [];
          return { welcome: true, session: true, queue: true, devices: true };
        case 'session':
          // the welcome's session is taken whatever its rev; after it, never an older one
          if (msg.session && msg.session.rev >= session.rev) { session = msg.session; return { session: true }; }
          return {};
        case 'queue':
          if (msg.queue && msg.queue.queueRev >= queue.queueRev) { queue = msg.queue; return { queue: true }; }
          return {};
        case 'devices': devices = msg.devices ?? []; return { devices: true };
        case 'deviceCommand':
          return msg.action === 'volume' ? { volume: { volume: typeof msg.volume === 'number' ? msg.volume : undefined, muted: typeof msg.muted === 'boolean' ? msg.muted : undefined, from: msg.from ?? '' } } : {};
        case 'ack': return { ack: { ref: msg.ref, rev: msg.rev } };
        case 'error': return { error: { ...msg } };
        default: return {};
      }
    },
    /** The connection dropped: the session stays shown meanwhile; the next welcome replaces it whatever its rev. */
    disconnected() { welcomed = false; },
  };
  return state;
}

// ---------------------------------------------------------------- messages
export const hello = ({ deviceId, name, kind = 'web', canPlay = true, client, volume, muted, resume }) => {
  const m = { type: 'hello', deviceId, name, kind, canPlay, client };
  if (typeof volume === 'number') { m.volume = Math.round(volume * 1000) / 1000; m.muted = !!muted; }
  if (resume) m.resume = resume;
  return m;
};
/** A command (any device): connect.md, Commands. Fields left undefined are not sent. */
export const command = (action, fields = {}) => {
  const m = { type: 'command', action };
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) m[k] = v;
  return m;
};
/** A report (the active device): connect.md, Reports. */
export const report = (event, key, positionMs, rev, { durationMs, now } = {}) => {
  const m = { type: 'report', event, key, positionMs: Math.max(0, Math.round(positionMs)), rev };
  if (durationMs > 0) m.durationMs = Math.round(durationMs);
  if (now) m.now = now;
  return m;
};

// ---------------------------------------------------------------- what the active device does
/**
 * What this device's player does to match the session (connect.md, "What each device does with a session").
 * `engine` is the player as it is: { key (the session entry it has loaded, or null), trackId, state: 'none' | 'loading'
 * | 'playing' | 'paused' | 'ended' | 'error', position (ms) }. `want` is the session's position now (ms).
 * Answers one of:
 *   { stop: true }                         not the active device (or nothing current): silence, release the audio
 *   { load: { key, trackId, at, play } }   a different entry: load it there, playing or not
 *   { seek: at?, play?: bool, pause?: bool, preload: trackId | null }   the same entry: correct it
 *   { idle: true }                         the same entry, and nothing to do (it failed, or it ended and the session has not moved yet)
 */
export function follow(session, deviceId, engine, want) {
  const cur = session.current;
  if (session.activeDevice !== deviceId || !cur) return engine.key || engine.state !== 'none' ? { stop: true } : { idle: true };
  if (cur.key !== engine.key) return { load: { key: cur.key, trackId: cur.trackId, at: want, play: session.playing } };
  if (engine.state === 'error') return { idle: true }; // reported: the session moves on
  if (engine.state === 'ended') {
    // played again from the session's position when the session plays on (repeat one, play after the end); near its
    // end the session has not yet heard of it
    if (session.playing && (session.durationMs <= 0 || want < session.durationMs - 2000)) return { load: { key: cur.key, trackId: cur.trackId, at: want, play: true } };
    return { idle: true };
  }
  const out = { preload: session.next && session.next !== cur.trackId ? session.next : null };
  if (engine.state !== 'loading' && Math.abs(engine.position - want) > 1500) out.seek = want;
  if (session.playing && engine.state === 'paused') out.play = true;
  else if (!session.playing && (engine.state === 'playing' || engine.state === 'loading')) out.pause = true;
  return out;
}

/** The device list as the device picker shows it: this device first, then the others in the server's order. */
export function pickerDevices(state, { hereKind = 'web', volumeHere = 1, mutedHere = false, title = null } = {}) {
  const s = state.session;
  const status = (id, canPlay) => (s.activeDevice === id ? `${s.playing ? '正在播放' : '已暂停'}${title ? ` · ${title}` : ''}` : canPlay ? '空闲' : '只能遥控');
  const row = (id, name, kind, canPlay, volume, muted) => ({ id, name, kind, canPlay, volume, muted, active: s.activeDevice === id, self: id === state.deviceId, status: status(id, canPlay) });
  return [row(state.deviceId, state.nameOf(state.deviceId), hereKind, true, volumeHere, mutedHere),
    ...state.devices.filter(d => d.id !== state.deviceId).map(d => row(d.id, d.name, d.kind, d.canPlay !== false, d.volume ?? 1, !!d.muted))];
}
