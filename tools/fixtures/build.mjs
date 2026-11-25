// One command for the whole test environment, from nothing: the fixture music library (generate.mjs), then the golden
// database: the frozen Navidrome scans the library in a new data folder, test users are made through its own routes
// (first admin, two-step verification, app password, browser sign-in), they get some state (stars, ratings, plays,
// playlists, a play queue), and the manifest records the users and the ids tests look entities up by.
//
// Output, in tools/fixtures/.work/ (gitignored; the credentials are for this machine's localhost only, never printed):
//   music/              the library
//   golden/navidrome.db the database
//   golden/manifest.json users, credentials, ids by key, counts, the settings to serve it with (serve.mjs)
//   bin/navidrome(.exe) the fork, when this script built it
//
// Usage: node tools/fixtures/build.mjs [--navidrome <exe>] [--rebuild-navidrome] [--keep-build]
//   Navidrome: --navidrome, else NAVIDROME_EXE, else .work/bin, else built from the fork (NAVIDROME_SRC, default: a
//   `navidrome` checkout beside this repository's).
import { createHash, randomBytes } from 'node:crypto';
import { copyFile, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { generate, DEFAULT_MUSIC } from './generate.mjs';
import { ARTISTS, COVERS, TRACKS } from './library.mjs';
import { WORK, checkpoint, freePort, navidromeEnv, navidromeExe, startNavidrome, waitForArtworkQueue } from './lib/navidrome.mjs';
import { GOLDEN } from './serve.mjs';
import { Subsonic } from '../contract/lib/subsonic.mjs';
import { webJson } from '../contract/lib/web.mjs';
import { step, totp } from '../contract/lib/totp.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const secret = () => randomBytes(18).toString('base64url');
const sleep = ms => new Promise(done => setTimeout(done, ms));
const check = (ok, msg) => { if (!ok) throw new Error(msg); };

// Fixed times for the plays, so play dates do not depend on when the database was made.
const PLAYED = ['2026-01-02T10:00:00Z', '2026-01-03T11:30:00Z', '2026-01-04T21:15:00Z'].map(t => Date.parse(t));

/** What a track's tags say the server should report (the contract suite compares). */
function expectTrack(t, title) {
  const tg = t.tags, num = v => (v === undefined ? undefined : parseFloat(v));
  return {
    title, album: tg.album ?? null, artist: tg.artist ?? null, albumArtist: tg.albumArtist ?? null, suffix: t.format,
    artists: tg.artists ?? null, genres: tg.genres ?? [], track: tg.track?.[0] ?? null, disc: tg.disc?.[0] ?? null,
    discSubtitle: tg.discSubtitle ?? null, date: tg.date ?? null, originalDate: tg.originalDate ?? null,
    replayGain: tg.replayGain ? { trackGain: num(tg.replayGain.trackGain), trackPeak: num(tg.replayGain.trackPeak),
      albumGain: num(tg.replayGain.albumGain), albumPeak: num(tg.replayGain.albumPeak) } : null,
    musicBrainzId: tg.mbz?.recording ?? null, cover: t.cover ?? null, lyrics: tg.lyrics?.text ?? t.lrc ?? null,
  };
}

/** Sets up two-step verification with a setup (or session) token: { secret, session, recoveryCodes }. */
async function setUpTwoFactor(base, token) {
  const begin = await webJson(base, '/auth/2fa/setup', { method: 'POST', body: { token } });
  check(begin.status === 200 && begin.json?.secret, `2fa setup: HTTP ${begin.status}`);
  const totpSecret = begin.json.secret;
  const confirm = await webJson(base, '/auth/2fa/confirm', { method: 'POST', body: { token, code: totp(totpSecret, step()) } });
  check(confirm.status === 200 && confirm.json?.token, `2fa confirm: HTTP ${confirm.status} ${JSON.stringify(confirm.json)}`);
  return { totpSecret, session: confirm.json.token, recoveryCodes: confirm.json.recoveryCodes };
}

async function appPassword(base, session, name) {
  const r = await webJson(base, '/auth/app-passwords', { method: 'POST', body: { name }, token: session });
  check(r.status === 200 && r.json?.password, `app password: HTTP ${r.status}`);
  return r.json.password;
}

async function makeGolden({ exe, music }) {
  const build = join(WORK, 'golden-build');
  await rm(build, { recursive: true, force: true });
  const encryptionKey = randomBytes(32).toString('hex');
  const port = await freePort();
  const env = navidromeEnv({ data: build, music, port, encryptionKey, scanOnStartup: true });
  const nd = await startNavidrome(exe, env);
  const base = nd.url;
  try {
    // ---- the first admin: the sign-in asks for two-step verification to be set up first (required)
    const admin = { username: 'admin', password: secret(), isAdmin: true };
    const created = await webJson(base, '/auth/createAdmin', { method: 'POST', body: { username: admin.username, password: admin.password } });
    check(created.status === 401 && created.json?.twoFactor === 'setup', `createAdmin: HTTP ${created.status} ${JSON.stringify(created.json)}`);
    Object.assign(admin, await setUpTwoFactor(base, created.json.setupToken));
    admin.appPassword = await appPassword(base, admin.session, 'Contract tests');
    const asAdmin = new Subsonic(base, { u: admin.username, password: admin.appPassword }, { client: 'sonus-fixtures' });

    // ---- the scan (started with the server): wait until every track is in
    for (let i = 0; ; i++) {
      const s = (await asAdmin.ok('getScanStatus')).scanStatus;
      if (!s.scanning && s.count >= TRACKS.length) break;
      if (i === 0 && !s.scanning && s.count === 0) await asAdmin.ok('startScan', { fullScan: true });
      check(i < 240, `the scan did not finish: ${JSON.stringify(s)}`);
      await sleep(500);
    }

    // ---- a plain user (never signed in on the web, so no two-step verification yet: the password opens the API) and a
    // user with two-step verification, an app password and an API key from the browser sign-in
    const listener = { username: 'listener', password: secret() };
    const secure = { username: 'secure', password: secret() };
    for (const u of [listener, secure]) {
      const r = await webJson(base, '/api/user', { method: 'POST', token: admin.session,
        body: { userName: u.username, name: u.username[0].toUpperCase() + u.username.slice(1), email: '', password: u.password, isAdmin: false } });
      check(r.status === 200 && r.json?.id, `creating ${u.username}: HTTP ${r.status} ${JSON.stringify(r.json)}`);
      u.id = r.json.id;
    }
    const login = await webJson(base, '/auth/login', { method: 'POST', body: { username: secure.username, password: secure.password } });
    check(login.status === 401 && login.json?.twoFactor === 'setup', `secure's first sign-in: HTTP ${login.status}`);
    Object.assign(secure, await setUpTwoFactor(base, login.json.setupToken));
    secure.appPassword = await appPassword(base, secure.session, 'Contract tests');
    const start = await webJson(base, '/auth/device/start', { method: 'POST', body: { client: 'Sonus', device: 'Fixtures' } });
    check(start.status === 200, `device start: HTTP ${start.status}`);
    const approve = await webJson(base, `/auth/device/${start.json.userCode}/approve`, { method: 'POST', token: secure.session });
    check(approve.status === 204, `device approve: HTTP ${approve.status}`);
    const poll = await webJson(base, '/auth/device/poll', { method: 'POST', body: { deviceCode: start.json.deviceCode } });
    check(poll.json?.status === 'approved' && poll.json.apiKey, `device poll: ${JSON.stringify(poll.json?.status)}`);
    secure.apiKey = poll.json.apiKey;

    // ---- what the library looks like to the listener: ids by key
    const asListener = new Subsonic(base, { u: listener.username, password: listener.password }, { client: 'sonus-fixtures' });
    const songs = await asListener.allSongs();
    check(songs.length === TRACKS.length, `the listener sees ${songs.length} songs, not ${TRACKS.length}`);
    const ids = {}, expect = {};
    for (const t of TRACKS) {
      const title = t.tags.title ?? t.path.replace(/^.*\//, '').replace(/\.[^.]+$/, '');
      const matches = songs.filter(s => s.title === title);
      check(matches.length === 1, `${matches.length} songs titled ${title}`);
      const s = matches[0];
      for (const k of t.keys) { ids[k] = s.id; expect[k] = expectTrack(t, title); }
      for (const k of t.albumKeys ?? []) { ids[k] = s.albumId; expect[k] = { name: t.tags.album, songCount: TRACKS.filter(x => x.tags.album === t.tags.album && x.tags.albumArtist === t.tags.albumArtist).length }; }
    }
    // getArtists lists album artists; an artist who only appears on tracks is found through the songs (OpenSubsonic's
    // artists list).
    const artistIndex = (await asListener.ok('getArtists')).artists.index ?? [];
    const artists = artistIndex.flatMap(i => i.artist ?? []);
    const trackArtists = songs.flatMap(s => [...(s.artists ?? []), ...(s.albumArtists ?? [])]);
    for (const [k, name] of Object.entries(ARTISTS)) {
      const a = artists.find(x => x.name === name) ?? trackArtists.find(x => x.name === name);
      check(a, `no artist named ${name} (album artists: ${artists.map(x => x.name).join(', ')}; on tracks: ${[...new Set(trackArtists.map(x => x.name))].join(', ')})`);
      ids[k] = a.id; expect[k] = { name, albumArtist: artists.some(x => x.name === name) };
    }

    // ---- state: the listener's stars, ratings, plays and play queue
    await asListener.ok('star', { id: ids['track.flac'], albumId: ids['album.compilation'], artistId: ids['artist.kenji'] });
    await asListener.ok('setRating', { id: ids['track.mp3'], rating: 4 });
    await asListener.ok('setRating', { id: ids['album.twoDiscs'], rating: 5 });
    await asListener.ok('scrobble', { id: ids['track.ogg'], submission: true, time: PLAYED[0] });
    await asListener.ok('scrobble', { id: ids['track.ogg'], submission: true, time: PLAYED[1] });
    await asListener.ok('scrobble', { id: ids['track.flac'], submission: true, time: PLAYED[2] });
    const queue = [ids['track.flac'], ids['track.mp3'], ids['track.m4a']];
    await asListener.ok('savePlayQueue', { id: queue, current: ids['track.mp3'], position: 1500 });

    // ---- playlists: the listener's own (private), the admin's (public), and the admin's smart playlist (public)
    const own = await asListener.ok('createPlaylist', { name: 'Road Trip', songId: [ids['track.mp3'], ids['track.opus'], ids['track.cjk']] });
    ids['playlist.own'] = own.playlist.id;
    await asListener.ok('updatePlaylist', { playlistId: ids['playlist.own'], comment: 'The listener’s own' });
    const shared = await asAdmin.ok('createPlaylist', { name: 'Shared Picks', songId: [ids['track.wav'], ids['track.accented'], ids['track.disc2']] });
    ids['playlist.otherUser'] = shared.playlist.id;
    await asAdmin.ok('updatePlaylist', { playlistId: ids['playlist.otherUser'], public: true, comment: 'Owned by the admin' });
    const smart = await webJson(base, '/api/playlist', { method: 'POST', token: admin.session, body: {
      name: 'All FLAC', comment: 'A smart playlist', public: true,
      rules: { all: [{ is: { filetype: 'flac' } }], sort: 'title', order: 'asc', limit: 100 } } });
    check(smart.status === 200 && smart.json?.id, `smart playlist: HTTP ${smart.status} ${JSON.stringify(smart.json)}`);
    ids['playlist.smart'] = smart.json.id;
    // A smart playlist is filled when its owner reads it (others see what it held then): fill it once now.
    check((await asAdmin.ok('getPlaylist', { id: ids['playlist.smart'] })).playlist.songCount > 0, 'the smart playlist is empty');
    expect['playlist.own'] = { name: 'Road Trip', owner: listener.username, public: false, songCount: 3 };
    expect['playlist.otherUser'] = { name: 'Shared Picks', owner: admin.username, public: true, songCount: 3 };
    expect['playlist.smart'] = { name: 'All FLAC', owner: admin.username, public: true, songCount: TRACKS.filter(t => t.format === 'flac').length };

    // ---- every playlist's cover settled. Navidrome makes a playlist's cover when the playlist is changed through
    // the Subsonic API; the smart playlist was not, so its cover would be made a few seconds after each start of a
    // copy (Navidrome's sweep for items without artwork state), and its cover art id would change under the tests.
    // Asking for the cover makes Navidrome settle it now.
    for (const key of ['playlist.own', 'playlist.otherUser', 'playlist.smart']) {
      await (await asAdmin.fetch('getCoverArt', { id: `pl-${ids[key]}` })).arrayBuffer();
    }
    {
      const { DatabaseSync } = await import('node:sqlite');
      const settled = () => {
        const db = new DatabaseSync(join(build, 'navidrome.db'), { readOnly: true });
        try { return db.prepare("SELECT count(*) AS n FROM item_artwork WHERE item_kind = 'pl' AND hash != ''").get().n; } finally { db.close(); }
      };
      for (let i = 0; settled() < 3; i++) {
        check(i < 120, 'the covers of the playlists were not settled in a minute');
        await new Promise(done => setTimeout(done, 500));
      }
    }

    // ---- let the background artwork work finish, so every copy of the database answers the same cover art ids
    const left = await waitForArtworkQueue(join(build, 'navidrome.db'));
    check(!left.length, `artwork still queued: ${JSON.stringify(left)}`);

    // ---- what the listener should see now
    const playlists = (await asListener.ok('getPlaylists')).playlists.playlist ?? [];
    const albums = await asListener.allAlbums();
    const ping = await asListener.ok('ping');
    const ext = (await new Subsonic(base).ok('getOpenSubsonicExtensions')).openSubsonicExtensions;
    const strip = u => { const { session, ...rest } = u; return rest; };
    const manifest = {
      version: 1,
      generated: new Date().toISOString(),
      server: {
        kind: 'navidrome',
        type: ping.type,
        serverVersion: ping.serverVersion,
        openSubsonicExtensions: ext.map(e => e.name).sort(),
        twoFactor: 'required',
        musicFolder: music,
        // What serve.mjs runs Navidrome with (the data folder and port are its own).
        env: Object.fromEntries(Object.entries(env).filter(([k]) => !['ND_DATAFOLDER', 'ND_CACHEFOLDER', 'ND_PORT', 'ND_SCANNER_SCANONSTARTUP'].includes(k))),
        // How a browser sign-in is allowed: a user signs in on the web and approves the code.
        deviceApproval: 'web',
        deviceApprover: 'secure',
      },
      primaryUser: 'listener',
      users: { admin: strip(admin), listener, secure: strip(secure) },
      ids,
      expect,
      // sha256 of the cover images as written into the library (the folder's cover.jpg, the embedded one)
      covers: Object.fromEntries(await Promise.all(Object.entries(COVERS).map(async ([k, p]) =>
        [k, createHash('sha256').update(await readFile(join(ROOT, p))).digest('hex')]))),
      counts: { songs: songs.length, albums: albums.length, artists: artists.length, playlistsVisibleToListener: playlists.length },
      state: {
        listener: {
          starred: { song: [ids['track.flac']], album: [ids['album.compilation']], artist: [ids['artist.kenji']] },
          ratings: { [ids['track.mp3']]: 4, [ids['album.twoDiscs']]: 5 },
          playCounts: { [ids['track.ogg']]: 2, [ids['track.flac']]: 1 },
          playQueue: { ids: queue, current: ids['track.mp3'], position: 1500 },
        },
      },
    };
    return { manifest, build };
  } catch (e) {
    console.error(nd.log().slice(-3000));
    throw e;
  } finally {
    await nd.stop();
  }
}

export async function buildAll({ navidrome, rebuildNavidrome = false, keepBuild = false } = {}) {
  const t0 = Date.now();
  const lib = await generate(DEFAULT_MUSIC);
  console.log(`Library: ${lib.tracks} tracks (${lib.files} files) in ${lib.out}`);
  const exe = navidromeExe({ exe: navidrome, rebuild: rebuildNavidrome });
  const { manifest, build } = await makeGolden({ exe, music: lib.out });
  await checkpoint(join(build, 'navidrome.db'));
  await rm(GOLDEN, { recursive: true, force: true });
  await mkdir(GOLDEN, { recursive: true });
  await copyFile(join(build, 'navidrome.db'), join(GOLDEN, 'navidrome.db'));
  // Navidrome's image store: the pictures it took out of audio files, by their hash. The database's artwork state
  // points at them, so a copy of the database without them has covers Navidrome must work out again.
  if (existsSync(join(build, 'artwork'))) await cp(join(build, 'artwork'), join(GOLDEN, 'artwork'), { recursive: true });
  manifest.server.navidrome = exe;
  await writeFile(join(GOLDEN, 'manifest.json'), JSON.stringify(manifest, null, 2));
  if (!keepBuild) await rm(build, { recursive: true, force: true });
  const c = manifest.counts;
  console.log(`Golden database: ${manifest.server.serverVersion}; ${c.songs} songs, ${c.albums} albums, ${c.artists} artists; ` +
    `${Object.keys(manifest.ids).length} ids by key; ${Object.keys(manifest.users).length} users`);
  console.log(`  ${join(GOLDEN, 'navidrome.db')}\n  ${join(GOLDEN, 'manifest.json')} (credentials: localhost only, keep it private)`);
  console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { navidrome: { type: 'string' }, 'rebuild-navidrome': { type: 'boolean' }, 'keep-build': { type: 'boolean' } } });
  await buildAll({ navidrome: values.navidrome, rebuildNavidrome: values['rebuild-navidrome'], keepBuild: values['keep-build'] });
}
