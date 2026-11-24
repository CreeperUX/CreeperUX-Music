// What every contract test needs: the server (CONTRACT_BASE_URL), the manifest (CONTRACT_MANIFEST: users and, for the
// golden database, the ids of the fixture entities by key), clients signed in as its users, and the library as the
// server lists it. run.mjs sets both variables.
import { readFileSync } from 'node:fs';
import { Subsonic } from './subsonic.mjs';
import { signIn, webJson } from './web.mjs';

const base = process.env.CONTRACT_BASE_URL;
const manifestFile = process.env.CONTRACT_MANIFEST;
if (!base || !manifestFile) throw new Error('CONTRACT_BASE_URL and CONTRACT_MANIFEST must be set (node tools/contract/run.mjs sets them)');

export const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
export const BASE = base.replace(/\/+$/, '');
export const CLIENT = 'sonus-contract';

const primary = manifest.users[manifest.primaryUser];
/** The primary user (signs in with a token), as Sonus clients sign in. */
export const me = primary;
export const api = new Subsonic(BASE, { u: primary.username, password: primary.password }, { client: CLIENT });
/** No sign-in at all. */
export const anon = new Subsonic(BASE, {}, { client: CLIENT });

/** A client signed in as a manifest user ('listener', 'secure', …), with a password, token or app password. */
export function as(userKey, { as: how = 'token', password, client = CLIENT } = {}) {
  const u = manifest.users[userKey];
  return new Subsonic(BASE, { u: u.username, password: password ?? u.password, as: how }, { client });
}

/** The id the manifest gives a key ('track.cjk', 'album.compilation', …), or undefined. */
export const id = key => manifest.ids?.[key];
/** What the manifest says to expect of a key's entity. */
export const expected = key => manifest.expect?.[key];
/** A node:test skip reason when the manifest lacks any of these keys (another server's catalogue), else false. */
export const needs = (...keys) => {
  const missing = keys.filter(k => !id(k));
  return missing.length ? `the manifest has no ${missing.join(', ')}` : false;
};
/** A skip reason when the manifest lacks this user. */
export const needsUser = key => (manifest.users?.[key] ? false : `the manifest has no ${key} user`);

let library;
/** The library as the primary user sees it: { songs, albums } (paged as clients page it), fetched once. */
export async function getLibrary() {
  library ??= (async () => ({ songs: await api.allSongs(), albums: await api.allAlbums() }))();
  return library;
}

/** A song id: the manifest's for this key, else the first song the server lists. */
export async function songId(key = 'track.mp3') {
  return id(key) ?? (await getLibrary()).songs[0].id;
}

/** The OpenSubsonic extensions the server advertises (no sign-in needed). */
let extensions;
const listed = () => (extensions ??= anon.ok('getOpenSubsonicExtensions').then(r => new Map((r.openSubsonicExtensions ?? []).map(e => [e.name, e.versions ?? []]))));
export async function hasExtension(name) {
  return (await listed()).has(name);
}
/** The versions of an extension the server lists ([] when it does not list it). */
export async function extensionVersions(name) {
  return (await listed()).get(name) ?? [];
}

// ---------------------------------------------------------------- the browser sign-in's approval step

const sessions = new Map();
/** A web session for a manifest user (Navidrome; two-step verification answered from the manifest's secret). */
export async function session(userKey) {
  if (!sessions.has(userKey)) sessions.set(userKey, signIn(BASE, manifest.users[userKey]));
  return sessions.get(userKey);
}

/** The manifest user who approves browser sign-ins in the tests. */
export const approver = manifest.server?.deviceApprover ?? manifest.primaryUser;

/**
 * Allows or refuses a waiting browser sign-in as the user would on the approval page. Navidrome: the approver signs in
 * on the web and posts the decision; the demo server: its test hook.
 */
export async function decideDeviceLogin(userCode, allow) {
  if (manifest.server?.deviceApproval === 'demo-hook') {
    const u = manifest.users[approver].username;
    const r = await fetch(`${BASE}/__test/device?code=${encodeURIComponent(userCode)}&decide=${allow ? 'allow' : 'deny'}&u=${encodeURIComponent(u)}`);
    const body = await r.json();
    if (!body.decided) throw new Error(`the demo server did not decide ${userCode}`);
    return;
  }
  const token = await session(approver);
  const r = await webJson(BASE, `/auth/device/${encodeURIComponent(userCode)}/${allow ? 'approve' : 'deny'}`, { method: 'POST', token });
  if (r.status !== 204) throw new Error(`approving ${userCode}: HTTP ${r.status} ${JSON.stringify(r.json)}`);
}

// ---------------------------------------------------------------- checks

export const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
