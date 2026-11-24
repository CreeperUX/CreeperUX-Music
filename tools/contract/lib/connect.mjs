// Sonus Connect version 2 from a test's side (docs/protocol/connect.md): a device on a WebSocket, with an inbox to
// wait on. Used by the contract suite (test/connect2.test.mjs) and by the tests that start servers of their own.

/** The WebSocket address of rest/connect on a server, with a query that signs in (Subsonic#query()). */
export const connectUrl = (base, query, { protocol = '2', path = 'rest/connect' } = {}) =>
  `${base.replace(/^http/, 'ws')}/${path}?${protocol ? `protocol=${protocol}&` : ''}${query}`;

/**
 * A connection with an inbox: next(match) takes the first message (seen or to come) that matches. `closed` resolves
 * with the close code when the connection ends (1006: without a close frame).
 */
export function socket(url, label = 'device') {
  const ws = new WebSocket(url);
  const inbox = [], waiting = [];
  ws.addEventListener('message', e => {
    inbox.push(JSON.parse(e.data));
    for (const w of [...waiting]) w.check();
  });
  const opened = new Promise((done, fail) => {
    ws.addEventListener('open', () => done(), { once: true });
    ws.addEventListener('error', () => fail(new Error(`${label}: the WebSocket did not open`)), { once: true });
  });
  opened.catch(() => {}); // a test that expects a refusal awaits it itself
  const closed = new Promise(done => ws.addEventListener('close', e => done(e.code), { once: true }));
  const next = (match, what = 'a message', ms = 5000) => new Promise((done, fail) => {
    const w = {
      check() {
        const i = inbox.findIndex(match);
        if (i < 0) return;
        const [m] = inbox.splice(i, 1);
        waiting.splice(waiting.indexOf(w), 1);
        clearTimeout(w.timer);
        done(m);
      },
    };
    w.timer = setTimeout(() => {
      waiting.splice(waiting.indexOf(w), 1);
      fail(new Error(`${label}: no ${what} in ${ms} ms; got ${JSON.stringify(inbox.map(m => m.type === 'session' ? `session ${m.session.rev}` : m.type))}`));
    }, ms);
    waiting.push(w);
    w.check();
  });
  const send = m => ws.send(JSON.stringify(m));
  /** Closes the connection: with 1000 (a goodbye) by default; a code from 3000 on is to the server a network loss. */
  const close = (code = 1000) => new Promise(done => {
    if (ws.readyState === WebSocket.CLOSED) return done();
    ws.addEventListener('close', () => done(), { once: true });
    if (ws.readyState !== WebSocket.CLOSING) ws.close(code);
  });
  return { ws, opened, closed, next, send, close, inbox, label };
}

/**
 * A version 2 device that said hello: the socket's functions, plus `welcome` (the answer), command(action, fields) →
 * the session the command gave (its ack's rev), refused(action, fields) → the error, and session(match) → the next
 * session that matches.
 */
export async function device(base, query, deviceId, name, hello = {}) {
  const s = socket(connectUrl(base, query), deviceId);
  await s.opened;
  s.send({ type: 'hello', deviceId, name, kind: 'desktop', canPlay: true, client: 'sonus-contract', ...hello });
  const welcome = await s.next(m => m.type === 'welcome', 'welcome');
  let refs = 0;
  const answer = async (type, action, fields) => {
    const ref = `${deviceId}-${++refs}`;
    s.send({ type, ref, ...(type === 'command' ? { action } : { event: action }), ...fields });
    return s.next(m => m.ref === ref && (m.type === 'ack' || m.type === 'error'), `answer to ${action}`);
  };
  const session = (match, what = 'the session', ms) => s.next(m => m.type === 'session' && match(m.session), what, ms).then(m => m.session);
  const applied = async (type, action, fields) => {
    const a = await answer(type, action, fields);
    if (a.type !== 'ack') throw new Error(`${deviceId}: ${action} was refused: ${JSON.stringify(a)}`);
    return session(x => x.rev === a.rev, `the session after ${action}`);
  };
  const refused = async (type, action, fields) => {
    const a = await answer(type, action, fields);
    if (a.type !== 'error') throw new Error(`${deviceId}: ${action} was not refused: ${JSON.stringify(a)}`);
    return a;
  };
  return {
    ...s, id: deviceId, welcome, session,
    command: (action, fields = {}) => applied('command', action, fields),
    refused: (action, fields = {}) => refused('command', action, fields),
    /** A report about the session's current song, as the active device sends it. */
    report: (event, about, fields = {}) => answer('report', event, { key: about.current?.key ?? null, positionMs: 0, rev: about.rev, ...fields }),
  };
}
