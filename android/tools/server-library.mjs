// A Sonus server (server/, the Rust one) in front of the frozen Navidrome, with a library of long songs and throwaway
// users, for running the app's device tests against it (tools/test-device.ps1 -Credentials). Nothing here talks to any
// server but the one on this machine.
//
//   node server-library.mjs library <dir>                       53 generated songs of 2½ to 9 minutes (tagged WAV, small:
//                                                               8 kHz mono), synced lyrics beside each, the demo covers;
//                                                               and two FLAC songs of 2½ minutes
//   node server-library.mjs start <dir> <sonus-server.exe> <navidrome.exe> [port]
//                                                               the server (and its Navidrome) in the background, on
//                                                               127.0.0.1:<port> (4650), two-step verification optional
//   node server-library.mjs users <dir> [port]                  throwaway users (passwords random, kept in
//                                                               <dir>/credentials.json only, never printed): one for a
//                                                               phone, one for a tablet, one with two-step verification;
//                                                               waits for the scan, then removes one song's file (a song
//                                                               the library lists that cannot be played)
//   node server-library.mjs stop <dir>
//
// The song whose file is removed is listed (search3, its album) only until the server starts again, which leaves it
// out: run the tests that look for it (PlaybackFixesTest) between `users` and the next `start`, or with a new <dir>.
//
// The albums are made so that the tests find what they look for: a song that ends into a longer one, songs long enough
// to take over more than 2 minutes in, and a playable song followed by the one whose file is gone.
import { spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [cmd, dir, ...rest] = process.argv.slice(2);
if (!cmd || !dir) {
  console.error('usage: node server-library.mjs library|start|users|stop <dir> ...');
  process.exit(2);
}
const music = join(dir, 'music');
const data = join(dir, 'data');
const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// artist, album, year, genre, cover (tools/demo-server/covers), the songs' lengths in seconds (null: its file is removed)
const ALBUMS = [
  ['夜航', '长夜列车', 2021, 'Electronic', 'al8', [200, 185, 330, 255, 211, 261, 189, 169, 165, 240]],
  ['海风', '南方的雨', 2019, 'Pop', 'al7', [260, 205, 172, null, 188, 208, 227, 185, 185]],
  ['远山乐团', '远山', 2018, 'Folk', 'al3', [312, 356, 298, 405, 377, 333, 289, 344]],
  ['霓虹', '城市灯火', 2022, 'City Pop', 'al5', [228, 247, 263, 219, 281, 236, 254, 245, 270]],
  ['林间', '慢慢长夜', 2020, 'Ambient', 'al2', [540, 498, 465, 512, 476, 530]],
  ['潮汐', '海岸线', 2023, 'Rock', 'al12', [301, 287, 318, 296, 342, 305, 279, 322, 290, 310, 285]],
];
const TITLES = ['起点', '夜色', '窗外', '远行', '回声', '微光', '长路', '雨后', '灯塔', '潮声', '归途', '晚风', '星图', '山谷', '雾里'];
const LINES = ['夜色慢慢落下', '车窗外的灯一盏盏后退', '我们沿着海岸一直走', '风把旧信吹到远方', '城市还没有睡', '雨停在屋檐下',
  '远处有人在唱歌', '把时间留给明天', '山那边是晨光', '心跳和鼓点一起', '听见潮水回来', '一路向北不回头'];
const MISSING_SECONDS = 243;

if (cmd === 'library') {
  rmSync(music, { recursive: true, force: true });
  const syncsafe = n => Buffer.from([(n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127]);
  const frame = (id, body) => Buffer.concat([Buffer.from(id, 'latin1'), syncsafe(body.length), Buffer.from([0, 0]), body]);
  const text = (id, s) => frame(id, Buffer.concat([Buffer.from([3]), Buffer.from(String(s), 'utf8')]));
  const id3 = frames => { const body = Buffer.concat(frames); return Buffer.concat([Buffer.from('ID3'), Buffer.from([4, 0, 0]), syncsafe(body.length), body]); };
  const stamp = s => `${String(Math.floor(s / 60)).padStart(2, '0')}:${(s % 60).toFixed(2).padStart(5, '0')}`;
  const RATE = 8000;
  const SCALE = [261.63, 293.66, 329.63, 392.0, 440.0, 523.25, 587.33, 659.25];
  let n = 0, bytes = 0, seconds = 0;
  for (const [a, [artist, album, year, genre, cover, lengths]] of ALBUMS.entries()) {
    const folder = join(music, artist, `${year} - ${album}`);
    mkdirSync(folder, { recursive: true });
    const art = join(repo, 'tools', 'demo-server', 'covers', `${cover}.jpg`);
    if (existsSync(art)) copyFileSync(art, join(folder, 'cover.jpg'));
    for (const [i, length] of lengths.entries()) {
      const duration = length ?? MISSING_SECONDS;
      const title = `${TITLES[(a * 5 + i) % TITLES.length]} ${i + 1}`;
      // 8-bit PCM: a slow melody of the scale, a note a second, softly enveloped
      const samples = duration * RATE;
      const audio = Buffer.alloc(44 + samples);
      audio.write('RIFF', 0, 'latin1'); audio.write('WAVE', 8, 'latin1'); audio.write('fmt ', 12, 'latin1');
      audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22); audio.writeUInt32LE(RATE, 24);
      audio.writeUInt32LE(RATE, 28); audio.writeUInt16LE(1, 32); audio.writeUInt16LE(8, 34);
      audio.write('data', 36, 'latin1'); audio.writeUInt32LE(samples, 40);
      let seed = a * 1000 + i * 37 + 11;
      let freq = SCALE[0];
      for (let s = 0; s < samples; s++) {
        const inNote = s % RATE;
        if (inNote === 0) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; freq = SCALE[seed % SCALE.length] / (1 + (a % 2)); }
        const envelope = Math.min(1, inNote / 400) * Math.max(0.2, 1 - inNote / RATE);
        audio[44 + s] = 128 + Math.round(42 * envelope * Math.sin((2 * Math.PI * freq * s) / RATE));
      }
      const tag = id3([text('TIT2', title), text('TPE1', artist), text('TPE2', artist), text('TALB', album), text('TCON', genre),
        text('TDRC', year), text('TRCK', `${i + 1}/${lengths.length}`), text('TPOS', '1/1')]);
      const pad = tag.length % 2 ? Buffer.from([0]) : Buffer.alloc(0);
      const chunk = Buffer.concat([Buffer.from('id3 ', 'latin1'), Buffer.alloc(4), tag, pad]);
      chunk.writeUInt32LE(tag.length, 4);
      const file = Buffer.concat([audio, chunk]);
      file.writeUInt32LE(file.length - 8, 4);
      const base = join(folder, `${String(i + 1).padStart(2, '0')} - ${title}`);
      writeFileSync(`${base}.wav`, file);
      // synced lyrics beside it: a line every 4 to 7 seconds from 8 s on
      const lines = [];
      for (let t = 8, k = 0; t < duration - 6 && lines.length < 80; t += 4 + ((a + i + k) % 4), k++) lines.push(`[${stamp(t)}]${LINES[(a * 3 + i + k) % LINES.length]}`);
      writeFileSync(`${base}.lrc`, `[ti:${title}]\n[ar:${artist}]\n[al:${album}]\n${lines.join('\n')}\n`);
      n++; bytes += file.length; seconds += duration;
    }
  }
  // two FLAC songs (44.1 kHz, flacWriter below): one taken over mid-song from another device (tools/e2e/acceptance.mjs;
  // Windows 0.7.0 skipped it: Media Foundation's FLAC decoder failed the move to its position). An album of two short
  // ones, named to sort last, so that nothing that looks for "an album of long songs" picks it.
  const flac = await flacWriter();
  const lossless = join(music, '龙吟', '2024 - 龙吟（无损）');
  mkdirSync(lossless, { recursive: true });
  const losslessArt = join(repo, 'tools', 'demo-server', 'covers', 'al2.jpg');
  if (existsSync(losslessArt)) copyFileSync(losslessArt, join(lossless, 'cover.jpg'));
  for (const [i, length] of [150, 150].entries()) {
    const title = `无损 ${i + 1}`;
    const file = flac({ tags: { title, artist: '龙吟', albumArtist: '龙吟', album: '龙吟（无损）', track: [i + 1, 2], disc: [1, 1], date: '2024', genres: ['Classical'] }, seconds: length, freq: 330 + 110 * i });
    writeFileSync(join(lossless, `${String(i + 1).padStart(2, '0')} - ${title}.flac`), file);
    n++; bytes += file.length; seconds += length;
  }
  console.log(`library: ${n} songs, ${(seconds / 3600).toFixed(1)} h, ${(bytes / 1e6).toFixed(0)} MB in ${music}`);
}

/**
 * A FLAC writer as an encoder's output looks to a player: the fixtures' verbatim frames (tools/fixtures/lib), with the
 * frame sizes in STREAMINFO and a seek point every 10 s. Without those, Windows' Media Foundation could only guess where
 * a position is, and sometimes failed the file at it: not what the owner's files, from real encoders, do.
 */
async function flacWriter() {
  const lib = name => import(pathToFileURL(join(repo, 'tools', 'fixtures', 'lib', name)).href);
  const { BitWriter, crc8, crc16, u8, u16be, u32le } = await lib('bits.mjs');
  const { tone, pcmBytes } = await lib('pcm.mjs');
  const { vorbisComments } = await lib('tags.mjs');
  const { createHash } = await import('node:crypto');
  const frameNumber = n => n < 0x80 ? Buffer.from([n]) : n < 0x800 ? Buffer.from([0xc0 | (n >> 6), 0x80 | (n & 0x3f)])
    : Buffer.from([0xe0 | (n >> 12), 0x80 | ((n >> 6) & 0x3f), 0x80 | (n & 0x3f)]);
  return ({ tags, seconds, freq }) => {
    const rate = 44100, block = 4096, samples = tone(seconds, rate, freq), out = [], frames = [];
    let offset = 0;
    for (let i = 0, n = 0; i < samples.length; i += block, n++) {
      const part = samples.subarray(i, Math.min(i + block, samples.length));
      const head = new BitWriter().write(0b11111111111110, 14).write(0, 1).write(0, 1)
        .write(part.length === block ? 0b1100 : 0b0111, 4).write(0b1001, 4).write(0, 4).write(0b100, 3).write(0, 1).buffer();
      let h = Buffer.concat([head, frameNumber(n), ...(part.length === block ? [] : [u16be(part.length - 1)])]);
      h = Buffer.concat([h, u8(crc8(h))]);
      const sub = Buffer.alloc(1 + part.length * 2);
      sub[0] = 0b00000010; // verbatim
      for (let k = 0; k < part.length; k++) sub.writeInt16BE(part[k], 1 + k * 2);
      const frame = Buffer.concat([h, sub]);
      out.push(frame, u16be(crc16(frame)));
      frames.push({ sample: i, offset, samples: part.length, size: frame.length + 2 });
      offset += frame.length + 2;
    }
    const sizes = frames.map(x => x.size);
    const info = new BitWriter().write(block, 16).write(block, 16).write(Math.min(...sizes), 24).write(Math.max(...sizes), 24)
      .write(rate, 20).write(0, 3).write(15, 5).write(samples.length, 36).buffer();
    const seek = [];
    for (let t = 0; t < seconds; t += 10) {
      const x = frames.find(y => y.sample >= t * rate) ?? frames.at(-1);
      const p = Buffer.alloc(18); p.writeBigUInt64BE(BigInt(x.sample), 0); p.writeBigUInt64BE(BigInt(x.offset), 8); p.writeUInt16BE(x.samples, 16);
      seek.push(p);
    }
    const pairs = vorbisComments(tags).map(([k, v]) => Buffer.from(`${k}=${v}`, 'utf8'));
    const vendor = Buffer.from('Sonus test library');
    const comments = Buffer.concat([u32le(vendor.length), vendor, u32le(pairs.length), ...pairs.flatMap(p => [u32le(p.length), p])]);
    const meta = [[0, Buffer.concat([info, createHash('md5').update(pcmBytes(samples)).digest()])], [3, Buffer.concat(seek)], [4, comments]];
    const head = [Buffer.from('fLaC')];
    meta.forEach(([type, body], i) => head.push(u8((i === meta.length - 1 ? 0x80 : 0) | type), Buffer.from([(body.length >> 16) & 0xff, (body.length >> 8) & 0xff, body.length & 0xff]), body));
    return Buffer.concat([...head, ...out]);
  };
}

if (cmd === 'start') {
  const [server, navidrome, port = '4650'] = rest;
  mkdirSync(data, { recursive: true });
  const env = {
    ...process.env,
    ND_DATAFOLDER: data, ND_MUSICFOLDER: music, ND_PORT: port, ND_ADDRESS: '127.0.0.1', ND_LOGLEVEL: 'warn',
    ND_SONUS_TWOFACTOR: 'optional', ND_AUTHREQUESTLIMIT: '0', ND_ENABLEINSIGHTSCOLLECTOR: 'false', ND_SCANNER_WATCHERWAIT: '0',
    // nothing leaves this machine: no Last.fm, ListenBrainz or Deezer
    ND_LASTFM_ENABLED: 'false', ND_LISTENBRAINZ_ENABLED: 'false', ND_DEEZER_ENABLED: 'false',
    SONUS_NAVIDROME_BIN: navidrome, SONUS_NAVIDROME_PORT: String(Number(port) + 1), SONUS_LOG: 'info,sonus_server::connect=debug',
  };
  const { openSync } = await import('node:fs');
  const out = openSync(join(dir, 'server.log'), 'a');
  const p = spawn(server, [], { cwd: dir, env, detached: true, stdio: ['ignore', out, out], windowsHide: true });
  p.unref();
  writeFileSync(join(dir, 'server.pid'), String(p.pid));
  for (let i = 0; ; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/ping`)).ok) break; } catch { /* starting */ }
    if (i > 120) throw new Error(`the server did not answer on ${port} (see ${join(dir, 'server.log')})`);
    await sleep(500);
  }
  console.log(`server: http://127.0.0.1:${port} (pid ${p.pid})`);
}

if (cmd === 'stop') {
  const pidFile = join(dir, 'server.pid');
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, 'utf8'));
    if (process.platform === 'win32') {
      // with the Navidrome it started (killing the server alone leaves it running)
      const { spawnSync } = await import('node:child_process');
      const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8' });
      console.log(r.status === 0 ? `stopped ${pid} and what it started` : `${pid}: ${r.stderr.trim()}`);
    } else {
      try { process.kill(-pid); } catch { try { process.kill(pid); } catch (e) { console.log(`${pid}: ${e.code}`); } }
      console.log(`stopped ${pid}`);
    }
    rmSync(pidFile, { force: true });
  }
}

/** RFC 6238: HMAC-SHA1 over 30-second steps, 6 digits (as an authenticator app makes them). */
function totp(secret, unix = Date.now() / 1000) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0;
  const key = [];
  for (const ch of secret.replace(/=+$/, '').toUpperCase()) {
    value = (value << 5) | alphabet.indexOf(ch); bits += 5;
    if (bits >= 8) { bits -= 8; key.push((value >> bits) & 255); }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(unix / 30)));
  const h = createHmac('sha1', Buffer.from(key)).update(counter).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

if (cmd === 'users') {
  const port = rest[0] ?? '4650';
  const base = `http://127.0.0.1:${port}`;
  const pass = () => randomBytes(12).toString('base64url');
  const credsFile = join(dir, 'credentials.json');
  const saved = existsSync(credsFile) ? JSON.parse(readFileSync(credsFile, 'utf8')) : {};
  const users = saved.users ?? {
    admin: { username: 'sonus-admin', password: pass() },
    main: { username: 'android-phone', password: pass() },
    other: { username: 'android-tablet', password: pass() },
    twoStep: { username: 'android-2fa', password: pass() },
  };
  const post = (path, body, token) => fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { 'X-ND-Authorization': `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  let r = await post('/auth/createAdmin', users.admin);
  if (!r.ok) r = await post('/auth/login', users.admin);
  const admin = (await r.json()).token;
  if (!admin) throw new Error(`admin sign-in: ${r.status}`);
  for (const key of ['main', 'other', 'twoStep']) {
    const u = users[key];
    const made = await post('/api/user', { userName: u.username, name: u.username, password: u.password, isAdmin: false }, admin);
    console.log(`user ${u.username}: ${made.status}`);
  }
  // two-step verification for one of them, as the owner's account may have it
  if (!users.twoStep.secret) {
    const token = (await (await post('/auth/login', users.twoStep)).json()).token;
    const setup = await (await post('/auth/2fa/setup', { token })).json();
    if (!setup.secret) throw new Error(`two-step set-up: ${JSON.stringify(Object.keys(setup))}`);
    const confirmed = await post('/auth/2fa/confirm', { token, code: totp(setup.secret) });
    if (!confirmed.ok) throw new Error(`two-step confirmation: ${confirmed.status}`);
    users.twoStep.secret = setup.secret;
    console.log(`user ${users.twoStep.username}: two-step verification on`);
  }
  writeFileSync(credsFile, JSON.stringify({ users, manifest: saved.manifest ?? {} }, null, 2));

  const { createHash } = await import('node:crypto');
  const api = async (method, params = {}, u = users.main) => {
    const salt = randomBytes(4).toString('hex');
    const q = new URLSearchParams({ u: u.username, t: createHash('md5').update(u.password + salt).digest('hex'), s: salt, v: '1.16.1', c: 'setup', f: 'json', ...params });
    return (await (await fetch(`${base}/rest/${method}?${q}`)).json())['subsonic-response'];
  };
  for (let i = 0; ; i++) {
    const s = (await api('getScanStatus')).scanStatus;
    if (!s.scanning && s.count >= 53) { console.log(`scanned: ${s.count} songs`); break; }
    if (i === 20 && !s.scanning) await api('startScan', {}, users.admin);
    if (i > 240) throw new Error('the scan did not finish');
    await sleep(500);
  }
  if (!saved.manifest?.missingFile) {
    // the song whose file goes: 南方的雨's fourth, after a playable one
    const songs = (await api('search3', { query: '', songCount: 500, albumCount: 0, artistCount: 0 })).searchResult3.song;
    const gone = songs.find(s => s.album === '南方的雨' && s.track === 4);
    if (!gone) throw new Error('no fourth song on 南方的雨');
    const folder = join(music, '海风', '2019 - 南方的雨');
    const file = readdirSync(folder).find(f => f.startsWith('04 - ') && f.endsWith('.wav'));
    rmSync(join(folder, file), { force: true });
    const manifest = { missingFile: gone.id };
    writeFileSync(credsFile, JSON.stringify({ users, manifest }, null, 2));
    console.log(`removed the file of "${gone.title}" (${gone.id})`);
  }
  console.log(`credentials: ${credsFile}`);
}
