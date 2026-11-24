// A small Subsonic client for the contract suite, the golden-database builder and the diff runner: JSON only, every
// way of signing in Sonus clients use, GET or form POST.
import { createHash, randomBytes } from 'node:crypto';

export const API_VERSION = '1.16.1';

/** Query parameters for a sign-in: { u, password, as: 'token' | 'password' | 'enc' } or { apiKey } or {} (none). */
export function authParams(auth = {}) {
  if (auth.apiKey !== undefined) return { apiKey: auth.apiKey };
  if (auth.u === undefined) return {};
  const as = auth.as ?? 'token';
  if (as === 'password') return { u: auth.u, p: auth.password };
  if (as === 'enc') return { u: auth.u, p: `enc:${Buffer.from(auth.password, 'utf8').toString('hex')}` };
  const s = auth.salt ?? randomBytes(6).toString('hex');
  return { u: auth.u, t: createHash('md5').update(auth.password + s).digest('hex'), s };
}

/** Appends params to a URLSearchParams; arrays become repeated parameters, undefined is left out. */
export function appendParams(q, params) {
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    for (const x of [v].flat()) q.append(k, String(x));
  }
  return q;
}

export class Subsonic {
  /** base: the server's root URL; auth: see authParams; client: the c parameter. */
  constructor(base, auth = {}, { client = 'sonus-contract' } = {}) {
    this.base = base.replace(/\/+$/, '');
    this.auth = auth;
    this.client = client;
  }

  with(auth, opts = {}) { return new Subsonic(this.base, auth, { client: this.client, ...opts }); }

  query(params = {}) {
    return appendParams(new URLSearchParams(), { ...authParams(this.auth), v: API_VERSION, c: this.client, f: 'json', ...params });
  }

  url(method, params = {}) { return `${this.base}/rest/${method}?${this.query(params)}`; }

  /** The raw response; post: send the parameters as a form body instead of the query string. */
  async fetch(method, params = {}, { post = false, headers = {} } = {}) {
    if (!post) return fetch(this.url(method, params), { headers });
    return fetch(`${this.base}/rest/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body: this.query(params).toString(),
    });
  }

  /** { http, body } where body is the subsonic-response object. */
  async call(method, params = {}, opts = {}) {
    const res = await this.fetch(method, params, opts);
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { throw new Error(`${method}: not JSON (HTTP ${res.status}): ${text.slice(0, 200)}`); }
    const body = json['subsonic-response'];
    if (!body) throw new Error(`${method}: no subsonic-response (HTTP ${res.status})`);
    return { http: res.status, headers: res.headers, body };
  }

  /** The subsonic-response of a call that must succeed. */
  async ok(method, params = {}, opts = {}) {
    const { body } = await this.call(method, params, opts);
    if (body.status !== 'ok') throw new Error(`${method}: ${body.error?.code} ${body.error?.message}`);
    return body;
  }

  /** Every song, paging search3 with an empty query as Sonus clients sync the library. */
  async allSongs(pageSize = 500) {
    const songs = [];
    for (let offset = 0; ; offset += pageSize) {
      const r = await this.ok('search3', { query: '', songCount: pageSize, songOffset: offset, albumCount: 0, artistCount: 0 });
      const page = r.searchResult3?.song ?? [];
      songs.push(...page);
      if (page.length < pageSize) return songs;
    }
  }

  /** Every album, paging getAlbumList2 alphabetically. */
  async allAlbums(pageSize = 500) {
    const albums = [];
    for (let offset = 0; ; offset += pageSize) {
      const r = await this.ok('getAlbumList2', { type: 'alphabeticalByName', size: pageSize, offset });
      const page = r.albumList2?.album ?? [];
      albums.push(...page);
      if (page.length < pageSize) return albums;
    }
  }
}
