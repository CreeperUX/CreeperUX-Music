// Sonus Connect version 2, the connection (docs/protocol/connect.md, Connecting): a WebSocket on
// rest/connect?protocol=2, signed in like a Subsonic request, that keeps itself connected (backoff 1 s doubling to
// 30 s) until closed. The state it feeds is api/connect.js; api/subsonic.js decides what this device does.
//
// Browser specifics:
// - Closing says goodbye with code 1000 (the page goes away, the user signs out): a browser's bare close() is 1005,
//   which the server takes for a network loss (a grace period with nobody there).
// - Two tabs of one browser profile are one device (one id). The newer tab's hello replaces the older one's connection
//   (close code 4000): the older tab then stays quiet and silent, and takes the device back when it is used again
//   (focus, a click on play): `reconnect()`.
import { createSessionState, hello } from './connect.js';

const REPLY_TIMEOUT = 10_000;

/**
 * @param {{ url: () => string, deviceId: string, name: string, client: string, kind?: string,
 *   volume: () => { volume: number, muted: boolean }, resume: (state) => object | null,
 *   onChange: (what: object, state) => void, onConnection: (status: 'online' | 'offline' | 'replaced') => void }} o
 */
export function openSession(o) {
  const state = createSessionState({ deviceId: o.deviceId });
  let ws = null, connected = false, closed = false, replaced = false, wait = 1000, timer = 0, refs = 0;
  const waiting = new Map(); // ref → resolve
  const settleAll = reply => { for (const done of waiting.values()) done(reply); waiting.clear(); };

  function connect() {
    clearTimeout(timer); timer = 0;
    if (closed || ws) return;
    let sock;
    try { sock = new WebSocket(o.url()); } catch { return retry(); }
    ws = sock;
    sock.onopen = () => {
      const v = o.volume();
      sock.send(JSON.stringify(hello({ deviceId: o.deviceId, name: o.name, kind: o.kind ?? 'web', canPlay: true, client: o.client, volume: v.volume, muted: v.muted, resume: o.resume(state) ?? undefined })));
    };
    sock.onmessage = e => {
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      const what = state.receive(msg);
      if (what.welcome) { connected = true; wait = 1000; o.onConnection('online'); }
      if (what.ack) waiting.get(what.ack.ref)?.({ ok: true, rev: what.ack.rev });
      if (what.error?.ref != null) waiting.get(what.error.ref)?.({ ok: false, code: what.error.code, message: what.error.message, error: what.error });
      if (what.ack) waiting.delete(what.ack.ref);
      if (what.error?.ref != null) waiting.delete(what.error.ref);
      o.onChange(what, state);
    };
    sock.onclose = e => {
      if (ws !== sock) return;
      ws = null;
      const was = connected; connected = false; state.disconnected();
      settleAll({ ok: false, code: 'offline', message: '连接断开了。' });
      if (closed) return;
      if (e.code === 4000) { replaced = true; o.onConnection('replaced'); return; } // another tab is this device now
      if (was) o.onConnection('offline');
      retry();
    };
    sock.onerror = () => { /* onclose follows */ };
  }
  function retry() {
    if (closed || replaced || timer) return;
    timer = setTimeout(() => { timer = 0; connect(); }, wait);
    wait = Math.min(30_000, wait * 2);
  }

  /** Sends a message and waits for the server's answer: { ok, rev } or { ok: false, code, message }. */
  async function request(message) {
    if (!connected || ws?.readyState !== WebSocket.OPEN) return { ok: false, code: 'offline', message: '未连接到服务器。' };
    const ref = String(++refs);
    return new Promise(resolve => {
      const t = setTimeout(() => { waiting.delete(ref); resolve({ ok: false, code: 'timeout', message: '服务器没有回应。' }); }, REPLY_TIMEOUT);
      waiting.set(ref, r => { clearTimeout(t); resolve(r); });
      try { ws.send(JSON.stringify({ ...message, ref })); } catch { waiting.delete(ref); clearTimeout(t); resolve({ ok: false, code: 'offline', message: '未连接到服务器。' }); }
    });
  }
  /** Sends without waiting (reports, the device's volume). */
  function send(message) {
    if (!connected || ws?.readyState !== WebSocket.OPEN) return false;
    try { ws.send(JSON.stringify(message)); return true; } catch { return false; }
  }

  connect();
  return {
    state,
    get connected() { return connected; },
    get replaced() { return replaced; },
    request, send,
    /** Tries now rather than after the backoff; after another tab took the device over, takes it back. */
    reconnect() { if (closed) return; replaced = false; wait = 1000; if (!ws) connect(); },
    /** Waits up to `ms` for the connection (a command pressed while it is being made). */
    async ready(ms = 3000) {
      if (connected) return true;
      this.reconnect();
      const until = Date.now() + ms;
      while (!connected && !closed && Date.now() < until) await new Promise(r => setTimeout(r, 50));
      return connected;
    },
    /** A goodbye (code 1000): no grace period on the server; this device's session stops there at once if it played. */
    close() {
      closed = true; clearTimeout(timer);
      const sock = ws; ws = null; connected = false;
      settleAll({ ok: false, code: 'offline', message: '连接已关闭。' });
      if (!sock) return;
      // still connecting: closed once open (WebKit reports a socket closed before it connected as an error)
      if (sock.readyState === WebSocket.CONNECTING) { sock.onopen = () => sock.close(1000, 'bye'); sock.onmessage = null; return; }
      try { sock.close(1000, 'bye'); } catch { /* gone */ }
    },
  };
}
