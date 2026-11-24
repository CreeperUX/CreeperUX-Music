// A recording proxy for the client tests: it sits in front of any server (Navidrome, the Sonus server, a demo server)
// and passes every request through as it is, streamed both ways, WebSockets too (Sonus Connect). On the side it gives
// the tests what the demo server's own test hooks give (tools/demo-server/demo-server.mjs), so a check written against
// those runs against any server:
//   GET /__test/log            → { streams, scrobbles, queues, covers, open, sockets, similar }: the stream, scrobble,
//                                play queue and cover requests seen, how many streams are open, Sonus Connect's sockets,
//                                and the songs each similar-songs answer gave (a server may pick them at random);
//   GET /__test/offline?on=1|0 → while on, every request is dropped (the connection closed, no answer), and the open
//                                WebSockets are dropped when it goes on, as the demo server's hook does.
// Secrets (passwords, tokens, API keys) are never recorded.
// Usage: node tools/e2e/proxy.mjs <server URL> [port]   (prints "recording proxy: http://127.0.0.1:<port> → <server>")
import { createServer, request as httpRequest, Agent as HttpAgent } from 'node:http';
import { request as httpsRequest, Agent as HttpsAgent } from 'node:https';
import { connect as netConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { gunzipSync, brotliDecompressSync, inflateSync } from 'node:zlib';

const FORM_LIMIT = 1 << 20; // a POSTed form (formPost) is read to record it, up to this; larger bodies just pass through

/** Starts the proxy in front of `target` (a base URL). Resolves to { url, log, offline(on), stop() }. */
export function startProxy(target, { port = 0 } = {}) {
  const up = new URL(target);
  const secure = up.protocol === 'https:';
  const upPort = Number(up.port) || (secure ? 443 : 80);
  const base = up.pathname.replace(/\/$/, ''); // a server under a base path (/music)
  const agent = secure ? new HttpsAgent({ keepAlive: true }) : new HttpAgent({ keepAlive: true });
  const send = secure ? httpsRequest : httpRequest;
  const log = { streams: [], scrobbles: [], queues: [], covers: [], open: 0, sockets: [], similar: [] };
  const tunnels = new Set();
  let offline = false;

  const headersFor = req => {
    const h = { ...req.headers, host: up.host };
    delete h['proxy-connection'];
    return h;
  };
  const method = path => /^\/rest\/([^/?]+?)(\.view)?$/.exec(path)?.[1] ?? null;
  const all = (q, k) => q.getAll(k).filter(v => v !== '');

  /** What a /rest call says, recorded as the demo server records it. */
  function record(name, q, req, res) {
    if (name === 'stream') {
      log.streams.push({ id: q.get('id'), format: q.get('format'), maxBitRate: q.get('maxBitRate'), range: req.headers.range ?? null });
      log.open++;
      res.on('close', () => log.open--);
    } else if (name === 'getCoverArt') log.covers.push({ id: q.get('id'), size: q.get('size'), at: Date.now(), open: log.open });
    else if (name === 'scrobble') { const submission = q.get('submission') !== 'false'; for (const id of all(q, 'id')) log.scrobbles.push({ id, submission, time: q.get('time') }); }
    else if (name === 'savePlayQueue' && all(q, 'id').length) log.queues.push({ current: q.get('current') ?? all(q, 'id')[0], position: Number(q.get('position') ?? 0), changedBy: q.get('c') ?? '' });
  }

  /** The songs a similar-songs answer gave, in its order (read from a copy of the answer as it passes). */
  function readSimilar(answer, id) {
    const chunks = [];
    answer.on('data', c => chunks.push(c));
    answer.on('end', () => {
      try {
        const raw = Buffer.concat(chunks), enc = answer.headers['content-encoding'];
        const text = (enc === 'gzip' ? gunzipSync(raw) : enc === 'br' ? brotliDecompressSync(raw) : enc === 'deflate' ? inflateSync(raw) : raw).toString();
        const r = JSON.parse(text)['subsonic-response'];
        log.similar.push({ id, songs: (r?.similarSongs2 ?? r?.similarSongs)?.song?.map(s => s.id) ?? [] });
      } catch { log.similar.push({ id, songs: null }); } // not JSON (f=xml): seen, not read
    });
  }

  function forward(req, res, body, similarOf = null) {
    const out = send({ host: up.hostname, port: upPort, method: req.method, path: base + req.url, headers: headersFor(req), agent, servername: up.hostname }, answer => {
      res.writeHead(answer.statusCode, answer.statusMessage, answer.headers);
      if (similarOf !== null) readSimilar(answer, similarOf);
      answer.pipe(res);
      res.on('close', () => answer.destroy());
    });
    out.on('error', () => { if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' }).end('the server did not answer'); else res.destroy(); });
    res.on('close', () => { if (!res.writableFinished) out.destroy(); });
    if (body) out.end(body); else req.pipe(out);
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/__test/')) {
      if (url.pathname === '/__test/offline') {
        offline = url.searchParams.get('on') === '1';
        if (offline) for (const t of tunnels) t.destroy();
      }
      const known = ['/__test/log', '/__test/offline'].includes(url.pathname);
      res.writeHead(known ? 200 : 404, { 'Content-Type': 'application/json' })
        .end(JSON.stringify(url.pathname === '/__test/log' ? log : known ? { offline } : { error: 'the recording proxy has only /__test/log and /__test/offline' }));
      return;
    }
    if (offline) { req.socket.destroy(); return; }
    const name = method(url.pathname);
    if (!name) { forward(req, res); return; }
    const q = new URLSearchParams(url.search);
    let body = null;
    if (req.method === 'POST' && /application\/x-www-form-urlencoded|text\/plain/.test(req.headers['content-type'] ?? '') && Number(req.headers['content-length'] ?? 0) <= FORM_LIMIT) {
      const chunks = []; for await (const c of req) chunks.push(c);
      body = Buffer.concat(chunks);
      for (const [k, v] of new URLSearchParams(body.toString())) q.append(k, v);
    }
    record(name, q, req, res);
    forward(req, res, body, /^getSimilarSongs2?$/.test(name) ? q.get('id') : null);
  });

  // WebSockets (Sonus Connect at /rest/connect): the handshake is passed on and the two sockets joined
  server.on('upgrade', (req, socket, head) => {
    if (offline) { socket.destroy(); return; }
    const url = new URL(req.url, 'http://x');
    const q = url.searchParams;
    const entry = /^\/rest\/connect(\.view)?$/.test(url.pathname)
      ? { path: url.pathname, client: q.get('c') ?? '', auth: q.has('apiKey') ? 'apiKey' : q.has('t') ? 'token' : q.has('p') ? 'password' : 'none', status: null, open: true, at: Date.now() }
      : null;
    if (entry) log.sockets.push(entry);
    const upstream = secure ? tlsConnect({ host: up.hostname, port: upPort, servername: up.hostname }) : netConnect(upPort, up.hostname);
    const head0 = [`${req.method} ${base}${req.url} HTTP/1.1`, ...Object.entries(headersFor(req)).flatMap(([k, v]) => [].concat(v).map(x => `${k}: ${x}`)), '', ''].join('\r\n');
    const tunnel = { destroy: () => { socket.destroy(); upstream.destroy(); } };
    tunnels.add(tunnel);
    const done = () => { tunnels.delete(tunnel); if (entry) entry.open = false; socket.destroy(); upstream.destroy(); };
    upstream.once(secure ? 'secureConnect' : 'connect', () => {
      upstream.write(head0);
      if (head?.length) upstream.write(head);
      socket.pipe(upstream);
    });
    let first = true;
    upstream.on('data', d => {
      if (first && entry) { first = false; entry.status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(d.toString('latin1', 0, 32))?.[1] ?? 0); }
      if (!socket.write(d)) { upstream.pause(); socket.once('drain', () => upstream.resume()); }
    });
    for (const s of [socket, upstream]) { s.on('close', done); s.on('error', done); }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${server.address().port}`;
      resolve({
        url, log,
        offline: on => { offline = on; if (on) for (const t of tunnels) t.destroy(); },
        stop: () => new Promise(done => { for (const t of tunnels) t.destroy(); agent.destroy(); server.closeAllConnections?.(); server.close(() => done()); }),
      });
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [target, port] = process.argv.slice(2);
  if (!target) { console.error('Usage: node tools/e2e/proxy.mjs <server URL> [port]'); process.exit(2); }
  const p = await startProxy(target.replace(/\/$/, ''), { port: Number(port ?? 0) });
  console.log(`recording proxy: ${p.url} → ${target}`);
}
