// What the Rust server decides about sign-ins that the suite's shared server cannot show: the failed-attempt limit
// (off in the golden settings), that Navidrome never sees a request the Rust server refused nor the credentials of one
// it let through, and that a request signed in by the gateway's header is to Navidrome what one signed in by
// credentials was (the player cookie, the last access, no user made up).
//
// Each test starts its own servers on fresh copies of the golden database (tools/fixtures/build.mjs first):
//   node --test tools/contract/gateway.test.mjs
// Navidrome alone ("Go") and the Rust server running its own Navidrome ("Rust") get the same requests; where both
// answer, the answers must be the same.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { Subsonic, apiSecret } from './lib/subsonic.mjs';
import { serveGolden } from '../fixtures/serve.mjs';
import { ANSWERED_BY_RUST, ANSWERED_HEADER, startGatewayOnGolden } from './diff.mjs';
import { device } from './lib/connect.mjs';

const CLIENT = 'sonus-gateway-test';
const sleep = ms => new Promise(done => setTimeout(done, ms));

/** The Subsonic error code of a ping with these parameters, 0 when it is answered ok. */
async function ping(base, params, method = 'ping') {
  const { body } = await new Subsonic(base, {}, { client: CLIENT }).call(method, params);
  return body.status === 'ok' ? 0 : body.error.code;
}

/** Both servers with the same settings over the golden ones; stopped when the test ends. */
async function both(t, env) {
  const [go, rust] = await Promise.all([serveGolden({ env }), startGatewayOnGolden({ env })]);
  t.after(async () => { await go.stop(); await rust.stop(); });
  return { go, rust, users: go.manifest.users };
}

test('failed sign-ins are limited the same way by Navidrome and by the Rust server', { timeout: 600_000 }, async t => {
  const WINDOW = 5000;
  const { go, rust, users } = await both(t, { ND_AUTHREQUESTLIMIT: '3', ND_AUTHWINDOWLENGTH: `${WINDOW}ms` });
  const { listener, secure } = users;
  const right = { u: listener.username, p: apiSecret(listener) };
  const key = { apiKey: secure.apiKey };

  async function scenario(base) {
    const log = [];
    const step = async (what, params) => log.push(`${what}: ${await ping(base, params)}`);
    await step('the right password', right);
    // three failures, each by another door: a GET, a form post, a HEAD (which has no body to read a code from)
    await step('wrong password 1', { u: listener.username, p: 'wrong-1' });
    const posted = await new Subsonic(base, {}, { client: CLIENT }).call('ping', { u: listener.username, p: 'wrong-2' }, { post: true });
    log.push(`wrong password 2: ${posted.body.error?.code ?? 0}`);
    const head = await fetch(new Subsonic(base, {}, { client: CLIENT }).url('ping', { u: listener.username, p: 'wrong-3' }), { method: 'HEAD' });
    log.push(`wrong password 3: HTTP ${head.status}`);
    await step('the right password, limited', right);
    await step('the name in capitals, limited', { u: listener.username.toUpperCase(), p: apiSecret(listener) });
    await step('another user is not limited', { u: secure.username, p: secure.appPassword });
    await step('an API key is not limited', key);
    for (let i = 1; i <= 3; i++) await step(`unknown key ${i}`, { apiKey: `no-such-key-${i}` });
    await step('the right key, limited', key);
    await step('mixed credentials do not count and are not limited', { ...key, u: 'x' });
    await step('a password user is not limited by keys', { u: secure.username, p: secure.appPassword });
    await sleep(WINDOW + 500);
    await step('the right password, a window later', right);
    await step('the right key, a window later', key);
    return log;
  }

  // one after the other: each server has its own window
  const fromGo = await scenario(go.url);
  const fromRust = await scenario(rust.url);
  assert.deepEqual(fromRust, fromGo, 'the Rust server limits as Navidrome does');
  assert.deepEqual(fromRust, [
    'the right password: 0',
    'wrong password 1: 40', 'wrong password 2: 40', 'wrong password 3: HTTP 200',
    'the right password, limited: 40',
    'the name in capitals, limited: 40',
    'another user is not limited: 0',
    'an API key is not limited: 0',
    'unknown key 1: 44', 'unknown key 2: 44', 'unknown key 3: 44',
    'the right key, limited: 44',
    'mixed credentials do not count and are not limited: 43',
    'a password user is not limited by keys: 0',
    'the right password, a window later: 0',
    'the right key, a window later: 0',
  ]);
});

test('Navidrome never sees what the Rust server refused, nor the credentials of what it let through', { timeout: 600_000 }, async t => {
  // at debug level Navidrome logs every request it gets, with its whole query
  const { go, rust, users } = await both(t, { ND_LOGLEVEL: 'debug' });
  const { listener, secure } = users;
  const refused = [
    { u: listener.username, p: 'wrong-password', mark: 'refused-wrong-password' },
    { u: 'nobody-by-this-name', p: 'x', mark: 'refused-unknown-user' },
    { u: secure.username, p: secure.password, mark: 'refused-two-step-account-password' },
    { apiKey: 'no-such-key', mark: 'refused-unknown-key' },
    { apiKey: secure.apiKey, u: secure.username, mark: 'refused-mixed' },
    { p: apiSecret(listener), mark: 'refused-no-user' },
  ];
  const accepted = [
    { u: listener.username, p: apiSecret(listener), mark: 'accepted-password' },
    { u: secure.username, p: secure.appPassword, mark: 'accepted-app-password' },
    { apiKey: secure.apiKey, mark: 'accepted-key' },
  ];
  for (const server of [go, rust]) {
    for (const params of refused) assert.notEqual(await ping(server.url, params), 0, params.mark);
    // (a method Navidrome still answers: the Rust server answers a signed-in ping itself)
    for (const params of accepted) assert.equal(await ping(server.url, params, 'getLicense'), 0, params.mark);
    // as a form post too
    const posted = await new Subsonic(server.url, {}, { client: CLIENT }).call('getLicense', { u: listener.username, p: apiSecret(listener), mark: 'accepted-form' }, { post: true });
    assert.equal(posted.body.status, 'ok');
  }
  await sleep(300);
  const secrets = [apiSecret(listener), secure.password, secure.appPassword, secure.apiKey];
  const count = (log, text) => log.split(text).length - 1;

  // The control: Navidrome alone saw them all, and decided itself.
  const goLog = go.log();
  for (const params of [...refused, ...accepted]) assert.ok(goLog.includes(params.mark), `Navidrome alone logs ${params.mark}`);
  assert.ok(count(goLog, 'API: Invalid login') >= 3, 'Navidrome alone refuses the sign-ins itself');
  // (Navidrome's log redacts the values, but shows the parameters it was sent)
  assert.ok(/[?&]p=/.test(goLog) && /[?&]apiKey=/.test(goLog), 'and its debug log shows it was sent the credentials');

  // Behind the Rust server: the refused requests never reached it, and the others came without their credentials.
  const rustLog = rust.log();
  for (const params of refused) assert.ok(!rustLog.includes(params.mark), `Navidrome never saw ${params.mark}`);
  for (const params of accepted) assert.ok(rustLog.includes(params.mark), `Navidrome answered ${params.mark}`);
  // (but for the one the Rust server tries itself when it starts, as nobody, to have Navidrome open its user store)
  const refusedByNavidrome = rustLog.split(String.fromCharCode(10)).filter(line => line.includes('API: Invalid login') && !line.includes('sonus-server-start-probe'));
  assert.equal(refusedByNavidrome.length, 0, 'Navidrome refused no sign-in: none reached it');
  assert.equal(count(rustLog, 'Invalid API key'.concat('"')), 0);
  for (const s of secrets) {
    assert.ok(!rustLog.includes(s) && !rustLog.includes(encodeURIComponent(s)), 'no credential is in Navidrome’s log, nor in the gateway’s');
  }
  const fromClients = rustLog.split(String.fromCharCode(10)).filter(line => !line.includes('sonus-server-start-probe')).join(' ');
  assert.ok(!/[?&](p|t|s|apiKey)=/.test(fromClients), 'no credential parameter reached Navidrome');
  assert.ok(count(rustLog, 'Subsonic: invalid sign-in') >= 3, 'the Rust server refused them, and says so');
});

test('signed in by the gateway, a request is to Navidrome what it was with credentials', { timeout: 600_000 }, async t => {
  const { go, rust, users } = await both(t, {});
  const { listener } = users;
  const cookie = async (base, u) => {
    const res = await new Subsonic(base, { u, password: apiSecret(listener), as: 'password' }, { client: CLIENT }).fetch('ping');
    await res.arrayBuffer();
    // nd-player-<hex of the name as typed>=<player id>; Max-Age=…; HttpOnly; SameSite=Strict; Path=/
    const [pair, ...attributes] = (res.headers.get('set-cookie') ?? '').split('; ');
    return { name: pair.split('=')[0], attributes: attributes.sort().join('; ') };
  };
  for (const u of [listener.username, listener.username.toUpperCase()]) {
    const [fromGo, fromRust] = [await cookie(go.url, u), await cookie(rust.url, u)];
    assert.match(fromGo.name, /^nd-player-[0-9a-f]+$/);
    assert.deepEqual(fromRust, fromGo, `the player cookie for ${u}`);
  }

  // the player is registered under the client's name, and now playing lists it
  for (const server of [go, rust]) {
    const api = new Subsonic(server.url, { u: listener.username, password: apiSecret(listener) }, { client: 'sonus-player-test' });
    const song = (await api.ok('search3', { query: '', songCount: 1, albumCount: 0, artistCount: 0 })).searchResult3.song[0];
    await api.ok('scrobble', { id: song.id, submission: false });
    const playing = (await api.ok('getNowPlaying')).nowPlaying.entry ?? [];
    assert.equal(playing[0]?.username, listener.username);
    assert.match(playing[0]?.playerName ?? '', /sonus-player-test/);
  }

  // the user's last access is written, and nobody is made up: three users before, three after
  const refusedGhost = await ping(rust.url, { u: 'ghost-of-nobody', p: 'x' });
  assert.equal(refusedGhost, 40);
  await sleep(300);
  for (const server of [go, rust]) {
    const db = new DatabaseSync(join(server.data, 'navidrome.db'), { readOnly: true });
    try {
      const golden = new DatabaseSync(join(server.data, '..', '..', 'golden', 'navidrome.db'), { readOnly: true });
      const before = golden.prepare('SELECT last_access_at AS at FROM user WHERE user_name = ?').get(listener.username).at;
      golden.close();
      const after = db.prepare('SELECT last_access_at AS at FROM user WHERE user_name = ?').get(listener.username).at;
      assert.notEqual(after, before, 'last_access_at moved');
      assert.equal(db.prepare('SELECT count(*) AS n FROM user').get().n, Object.keys(users).length, 'no user was created');
    } finally { db.close(); }
  }
});

test('the library’s reads are answered by the Rust server: Navidrome sees nothing of them, not even a registration', { timeout: 600_000 }, async t => {
  // at debug level Navidrome logs every request it gets, with its whole query
  const { go, rust, users } = await both(t, { ND_LOGLEVEL: 'debug' });
  const { listener } = users;
  const ids = go.manifest.ids;
  const client = 'sonus-library-test';
  // each request carries a mark, to find it in Navidrome's log
  const taken = [
    ['ping', {}],
    ['getSong', { id: ids['track.flac'] }],
    ['getSong', { id: 'no-such-song' }],
    ['getAlbum', { id: ids['album.twoDiscs'] }],
    ['getAlbumList2', { type: 'alphabeticalByName', size: 500 }],
    ['getAlbumList2', { type: 'starred' }],
    ['getAlbumList2', { type: 'random', size: 3 }],
    ['getAlbumList2', {}],
    ['search3', { query: '', songCount: 500, albumCount: 0, artistCount: 0 }],
    ['search3', { query: 'kenji', songCount: 200, albumCount: 60, artistCount: 30 }],
    ['search3', { query: '夜行' }],
    ['getStarred2', {}],
    ['getPlaylists', {}],
    ['getPlaylist', { id: ids['playlist.own'] }],
    ['getPlaylist', { id: 'no-such-playlist' }],
    ['getPlayQueue', {}],
    ['getLyricsBySongId', { id: ids['track.syncedLyrics'] }],
    ['getCoverArt', { id: `al-${ids['album.folderCover']}` }],
    ['getCoverArt', { id: `al-${ids['album.compilation']}` }],
    ['getCoverArt', { id: `dc-${ids['album.twoDiscs']}:1` }],
  ].map(([method, params], i) => [method, { ...params, mark: `taken-${i}-${method}${params.type === 'random' ? '-random' : ''}` }]);
  const left = [
    ['getSong', { id: ids['track.flac'], f: 'xml', mark: 'left-xml' }],
    ['getAlbumList2', { type: 'newest', musicFolderId: 1, mark: 'left-music-folder' }],
    ['getMusicFolders', { mark: 'left-other-method' }],
    ['getPlaylist', { id: ids['playlist.otherUser'], f: 'xml', mark: 'left-playlist-xml' }],
    ['search3', { query: 'kenji', musicFolderId: 1, mark: 'left-search-music-folder' }],
    ['getLyricsBySongId', { id: ids['track.lrcSidecar'], mark: 'left-lyrics-file' }],
    ['getCoverArt', { id: `dc-${ids['album.twoDiscs']}`, mark: 'left-disc-cover-without-a-number' }],
    ['getScanStatus', { mark: 'left-scan-status' }],
  ];
  for (const [method] of taken) assert.ok(ANSWERED_BY_RUST.includes(method), method);
  const answers = {};
  for (const server of [go, rust]) {
    const api = new Subsonic(server.url, { u: listener.username, password: apiSecret(listener) }, { client });
    const got = [];
    for (const [method, params] of [...taken, ...left]) {
      const res = await api.fetch(method, params);
      const text = await res.text();
      got.push({ mark: params.mark, by: res.headers.get(ANSWERED_HEADER), cookie: (res.headers.get('set-cookie') ?? '').split('=')[0], text });
    }
    answers[server === go ? 'go' : 'rust'] = got;
  }
  await sleep(300);
  // who answered, by the Rust server's own mark on its answers (debug builds), and the same answers
  for (const [i, fromRust] of answers.rust.entries()) {
    const fromGo = answers.go[i];
    const mine = fromRust.mark.startsWith('taken-');
    assert.equal(fromRust.by, mine ? 'rust' : null, `${fromRust.mark}: ${mine ? 'answered by the Rust server' : 'left to Navidrome'}`);
    assert.equal(fromGo.by, null);
    assert.equal(fromRust.cookie, fromGo.cookie, `${fromRust.mark}: the player cookie's name`);
    // (Navidrome registers no player for a cover, so there is no cookie on either)
    if (!fromRust.mark.includes('getCoverArt') && !fromRust.mark.includes('cover')) assert.match(fromGo.cookie, /^nd-player-[0-9a-f]+$/);
    if (fromRust.mark.includes('random')) continue; // another order every time, on both
    if (fromGo.text.includes('"roles":[')) continue; // an artist's roles: Go lists them in another order every time (the diff corpus compares them sorted)
    const strip = text => text.replace(/"serverVersion":"[^"]*"/, '');
    assert.equal(strip(fromRust.text), strip(fromGo.text), `${fromRust.mark}: the same bytes`);
  }

  // The control: Navidrome alone saw every request.
  const goLog = go.log();
  for (const [, params] of [...taken, ...left]) assert.ok(goLog.includes(params.mark), `Navidrome alone logs ${params.mark}`);

  // Behind the Rust server: none of the requests it answered reached Navidrome, the others did.
  const rustLog = rust.log();
  for (const [, params] of taken) assert.ok(!rustLog.includes(params.mark), `Navidrome never saw ${params.mark}`);
  for (const [, params] of left) assert.ok(rustLog.includes(params.mark), `Navidrome answered ${params.mark}`);
  const lines = rustLog.split(String.fromCharCode(10));
  const requestsFor = method => lines.filter(line => line.includes(`/rest/${method}`) && line.includes(`c=${client}`) && !line.includes('mark=left-'));
  for (const method of ANSWERED_BY_RUST.filter(m => m !== 'ping')) assert.equal(requestsFor(method).length, 0, `no ${method} of the Rust server's reached Navidrome`);
  // not even the player's registration: the Rust server registers players itself now (phase 5), no ping is sent
  const registrations = lines.filter(line => line.includes('HTTP: GET') && line.includes('/rest/ping?') && line.includes(`c=${client}`));
  assert.equal(registrations.length, 0, 'no registration reaches Navidrome');

  // The player is Navidrome's own row, made by its rules, on both servers; and the user's last access is written.
  const playerOf = server => {
    const db = new DatabaseSync(join(server.data, 'navidrome.db'), { readOnly: true });
    try {
      const players = db.prepare('SELECT name, user_agent, client, ip, max_bit_rate, transcoding_id, report_real_path, scrobble_enabled, last_seen FROM player WHERE client = ?').all(client);
      const access = db.prepare('SELECT last_access_at AS at FROM user WHERE user_name = ?').get(listener.username).at;
      return { players, access };
    } finally { db.close(); }
  };
  const [goState, rustState] = [playerOf(go), playerOf(rust)];
  assert.equal(goState.players.length, 1);
  assert.equal(rustState.players.length, 1, 'one player for the client, as with Navidrome alone');
  const { last_seen: seenByGo, ...goPlayer } = goState.players[0];
  const { last_seen: seenByRust, ...rustPlayer } = rustState.players[0];
  assert.deepEqual(rustPlayer, goPlayer, 'the same player row');
  assert.ok(seenByGo && seenByRust);
  assert.ok(rustState.access > '2026-11-25', 'the last access is written for requests the Rust server answered');
});

test('a player’s settings count for the answers the Rust server gives', { timeout: 600_000 }, async t => {
  const { go, rust, users } = await both(t, {});
  const { listener } = users;
  const id = go.manifest.ids['track.flac'];
  const client = 'sonus-real-path-test';
  const song = async server => {
    const api = new Subsonic(server.url, { u: listener.username, password: apiSecret(listener) }, { client });
    const res = await api.call('getSong', { id });
    return { path: res.body.song.path, by: res.headers.get(ANSWERED_HEADER) };
  };
  const set = (server, sql) => {
    const db = new DatabaseSync(join(server.data, 'navidrome.db'));
    try { db.prepare(sql).run(client); } finally { db.close(); }
  };
  // a new player: a path made up from the tags, answered by the Rust server
  const [madeUpByGo, madeUpByRust] = [await song(go), await song(rust)];
  assert.equal(madeUpByRust.path, madeUpByGo.path);
  assert.equal(madeUpByRust.by, 'rust');
  assert.match(madeUpByGo.path, /^Aurora Lane\/Northern Lights\//);
  // ReportRealPath turned on for the player (as an admin does in Navidrome's UI): the next answer has the file's path.
  // The Rust server reads the player's row at every request; where Go builds paths by its Windows rules, it leaves
  // such a player's songs to Navidrome.
  for (const server of [go, rust]) set(server, 'UPDATE player SET report_real_path = 1 WHERE client = ?');
  const [realByGo, realByRust] = [await song(go), await song(rust)];
  assert.notEqual(realByGo.path, madeUpByGo.path);
  assert.equal(realByRust.path.replace(rust.data, ''), realByGo.path.replace(go.data, ''), 'the same real path');
  assert.equal(realByRust.by, process.platform === 'win32' ? null : 'rust');
  // and off again
  for (const server of [go, rust]) set(server, 'UPDATE player SET report_real_path = 0 WHERE client = ?');
  assert.deepEqual(await song(rust), madeUpByRust);
});

test('a client cannot name itself a user', { timeout: 600_000 }, async t => {
  const rust = await startGatewayOnGolden();
  t.after(() => rust.stop());
  const { admin, listener } = rust.manifest.users;
  const claim = async (params, headers) => {
    const { body } = await new Subsonic(rust.url, {}, { client: CLIENT }).call('getUser', { username: admin.username, ...params }, { headers });
    return body.status === 'ok' ? 0 : body.error.code;
  };
  // Navidrome's default external-auth header, and guesses at the gateway's own
  for (const header of ['Remote-User', 'X-Sonus-User', 'X-Sonus-User-00000000000000000000000000000000']) {
    assert.equal(await claim({}, { [header]: admin.username }), 10, `${header} with no credentials`);
    assert.equal(await claim({ u: admin.username, p: 'wrong' }, { [header]: admin.username }), 40, `${header} with a wrong password`);
    // signed in as the listener, a claim to be the admin does not make one: getUser of someone else is refused (50)
    assert.equal(await claim({ u: listener.username, p: apiSecret(listener) }, { [header]: admin.username }), 50, `${header} beside the listener's own sign-in`);
  }
  // the web UI is not signed in by a header either: its page carries no session
  const page = await fetch(`${rust.url}/app/`, { headers: { 'Remote-User': admin.username } });
  const html = await page.text();
  assert.ok(!/"auth":\s*\{/.test(html) && !html.includes('"token"'), 'the page signs nobody in');
});

test('Sonus Connect version 2: the session is kept across a restart, in tables of the Rust server’s own that Navidrome runs beside', { timeout: 600_000 }, async t => {
  const go = await serveGolden();
  let rust = await startGatewayOnGolden();
  t.after(async () => { await go.stop(); await rust.stop(); });
  const { listener, secure } = go.manifest.users;
  const signed = u => new Subsonic(rust.url, { u: u.username, password: u.appPassword ?? u.password }, { client: CLIENT });
  const tables = () => {
    const db = new DatabaseSync(join(rust.data, 'navidrome.db'), { readOnly: true });
    try { return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'sonus_%' ORDER BY name").all().map(r => r.name); } finally { db.close(); }
  };
  const row = username => {
    const db = new DatabaseSync(join(rust.data, 'navidrome.db'), { readOnly: true });
    try {
      const r = db.prepare('SELECT s.session, s.lists FROM sonus_connect_session s JOIN user u ON u.id = s.user_id WHERE u.user_name = ?').get(username);
      return r ? { session: JSON.parse(r.session), lists: JSON.parse(r.lists) } : null;
    } finally { db.close(); }
  };

  // the list of extensions: Navidrome's own, in each format, with version 2 beside sonusConnect's version 1
  for (const [format, version1, both] of [
    ['f=json', '{"name":"sonusConnect","versions":[1]}', '{"name":"sonusConnect","versions":[1,2]}'],
    ['f=jsonp&callback=cb', '{"name":"sonusConnect","versions":[1]}', '{"name":"sonusConnect","versions":[1,2]}'],
    ['f=xml', '<openSubsonicExtensions name="sonusConnect"><versions>1</versions></openSubsonicExtensions>', '<openSubsonicExtensions name="sonusConnect"><versions>1</versions><versions>2</versions></openSubsonicExtensions>'],
  ]) {
    const [fromGo, fromRust] = await Promise.all([go, rust].map(s => fetch(`${s.url}/rest/getOpenSubsonicExtensions.view?${format}`, { headers: { 'Accept-Encoding': 'identity' } })));
    const [textGo, textRust] = [await fromGo.text(), await fromRust.text()];
    assert.ok(textGo.includes(version1), `${format}: Navidrome alone lists version 1`);
    assert.equal(textRust, textGo.replace(version1, both), `${format}: the same answer, but for the version`);
    assert.equal(fromRust.headers.get('content-type'), fromGo.headers.get('content-type'));
    assert.equal(fromRust.headers.get('content-length'), String(Buffer.byteLength(textRust)));
  }

  assert.deepEqual(tables(), ['sonus_app_password', 'sonus_connect_session', 'sonus_enrolment_code', 'sonus_recovery_code', 'sonus_server_schema', 'sonus_two_factor'],
    'three tables of the Rust server’s own (Connect’s session, the enrolment codes, their versions) beside the fork’s three');
  const songs = (await signed(listener).allSongs()).slice(0, 5);
  const pc = await device(rust.url, signed(listener).query().toString(), 'restart-pc-0001', '书房电脑');
  const played = await pc.command('playContext', { context: { kind: 'album', id: 'x', label: 'X' }, ids: songs.map(s => s.id), startId: songs[1].id });
  await pc.command('add', { ids: [songs[4].id] });
  const where = Math.floor(played.durationMs / 2); // within the song: the fixture library's are a few seconds long
  await pc.command('seek', { positionMs: where });
  const paused = await pc.command('pause');
  // another user's session, to see that each comes back as its own
  const other = await device(rust.url, signed(secure).query().toString(), 'restart-pc-0002', 'Secure');
  const theirs = await other.command('playContext', { ids: [songs[3].id] });

  // written within a second of the change: the server is killed, not stopped (so nothing is written at its end)
  await sleep(1500);
  assert.equal(row(listener.username).session.rev, paused.rev);
  assert.deepEqual(row(listener.username).lists.context, songs.map(s => s.id));
  await rust.stop({ keep: true });
  assert.ok([1005, 1006].includes(await pc.closed), 'the connection went with the server');

  // the same data folder again: Navidrome starts on a database with the Rust server's tables in it, and runs
  rust = await startGatewayOnGolden({ copy: rust.copy });
  const log = rust.log();
  assert.ok(!/level=(error|fatal)/i.test(log), `Navidrome and the Rust server start without errors:\n${log.slice(-2000)}`);
  assert.equal((await signed(listener).ok('ping')).status, 'ok');
  assert.equal((await signed(listener).allSongs()).length, (await new Subsonic(go.url, { u: listener.username, password: apiSecret(listener) }, { client: CLIENT }).allSongs()).length);
  assert.deepEqual(tables().length, 6);

  const laptop = await device(rust.url, signed(listener).query().toString(), 'restart-laptop-1', '笔记本');
  const back = laptop.welcome.session;
  assert.equal(back.activeDevice, null, 'no active device after a restart');
  assert.equal(back.playing, false);
  assert.equal(back.positionMs, paused.positionMs, 'paused at its position');
  assert.ok(paused.positionMs >= where && paused.positionMs < where + 500, 'which is where it was sought to, and the moment it played on');
  assert.equal(back.rev, paused.rev);
  assert.deepEqual(back.current, paused.current);
  assert.deepEqual(back.now, paused.now);
  assert.deepEqual(back.lastDevice, { id: 'restart-pc-0001', name: '书房电脑' });
  assert.deepEqual(laptop.welcome.queue.order, songs.map(s => s.id));
  assert.deepEqual(laptop.welcome.queue.manual.map(m => m.trackId), [songs[4].id]);
  assert.deepEqual(laptop.welcome.devices.map(d => d.id), ['restart-laptop-1']);
  // whichever device presses play continues it, and becomes the active device
  const playing = await laptop.command('play');
  assert.equal(playing.activeDevice, 'restart-laptop-1');
  assert.equal(playing.positionMs, paused.positionMs);
  // the other user's came back as theirs, stopped where it played (it was playing when the server was killed)
  const again = await device(rust.url, signed(secure).query().toString(), 'restart-pc-0002', 'Secure');
  assert.equal(again.welcome.session.current.trackId, songs[3].id);
  assert.equal(again.welcome.session.activeDevice, null);
  assert.equal(again.welcome.session.playing, false);
  assert.ok(again.welcome.session.rev >= theirs.rev);

  // stopped properly this time: the last change is written when the server stops (where it can be told to: a
  // killed process writes nothing, so this part is for systems with signals)
  const last = await laptop.command('seek', { positionMs: where + 100 });
  if (process.platform !== 'win32') {
    await rust.stop({ keep: true });
    assert.equal(row(listener.username).session.rev, last.rev, 'written at shutdown');
    rust = await startGatewayOnGolden({ copy: rust.copy });
  }
  await Promise.all([laptop.close(), again.close(), other.close()]);
});
