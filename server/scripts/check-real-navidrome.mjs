// Checks the real (frozen) Navidrome through the Sonus gateway on 127.0.0.1:4633; see "Checked against the real
// Navidrome" in server/README.md for the setup (a throwaway data folder, two config files, the gateway started with
// its output in <folder>/logs/run-<a|b>.*).
// Usage: node check-real-navidrome.mjs <a|b> <folder with admin.json, music/Fixtures/, logs/>
//   a: no trusted proxy. b: ExtAuth.TrustedSources = '127.0.0.1/32' (this script on 127.0.0.1 plays the proxy,
//   and 127.0.0.2 plays anyone else). admin.json is {"username", "password"} of a throwaway admin, made by run a.
// Never prints the credentials: only what was checked and whether it held.
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const [mode, root] = process.argv.slice(2);
const GW = { host: "127.0.0.1", port: 4633 };
const { username, password } = JSON.parse(fs.readFileSync(path.join(root, "admin.json"), "utf8"));
let failures = 0;
const check = (ok, what, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
};

function request(method, target, { headers = {}, body, localAddress } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ ...GW, method, path: target, headers, localAddress, agent: false }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}
const json = (r) => JSON.parse(r.body.toString("utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function subsonicQuery(params = {}) {
  const salt = crypto.randomBytes(8).toString("hex");
  const token = crypto.createHash("md5").update(password + salt).digest("hex");
  return new URLSearchParams({ u: username, t: token, s: salt, v: "1.16.1", c: "gateway-check", f: "json", ...params }).toString();
}
const subsonic = async (method, params, opts) => json(await request("GET", `/rest/${method}.view?${subsonicQuery(params)}`, opts))["subsonic-response"];

// 1. up: 503 while Navidrome starts, then answers
let first = null;
const startedAt = Date.now();
for (;;) {
  try {
    const r = await request("GET", "/ping");
    first ??= r.status;
    if (r.status === 200) break;
  } catch {
    // the gateway itself is not listening yet
  }
  if (Date.now() - startedAt > 60000) throw new Error("not up after 60 s");
  await sleep(100);
}
console.log(`up after ${Date.now() - startedAt} ms; the first answer was ${first}`);

// 2. the web UI and signing in
const app = await request("GET", "/app/");
const html = app.body.toString("utf8");
check(app.status === 200 && /text\/html/.test(app.headers["content-type"]) && html.includes('id="root"'), "GET /app/ serves the web UI", `${app.status}`);
const script = html.match(/src="([^"]+\.js)"/)?.[1];
if (script) {
  const js = await request("GET", script.startsWith("/") ? script : `/app/${script}`);
  check(js.status === 200 && js.body.length > 10000, "the web UI's script loads", `${script.replace(/\?.*/, "")}: ${js.status}, ${js.body.length} bytes`);
}
let login = await request("POST", "/auth/login", { headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password }) });
if (login.status === 401 && mode === "a") {
  const created = await request("POST", "/auth/createAdmin", { headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password }) });
  check(created.status === 200, "first admin created through the gateway", `${created.status}`);
  login = await request("POST", "/auth/login", { headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password }) });
}
const jwt = login.status === 200 ? json(login).token : null;
check(!!jwt, "POST /auth/login signs in", `${login.status}`);

// 3. the events stream stays open (and sends keep-alives)
await new Promise((resolve) => {
  const seconds = 35;
  const req = http.get({ ...GW, path: `/api/events?jwt=${encodeURIComponent(jwt)}`, agent: false, headers: { accept: "text/event-stream" } }, (res) => {
    let bytes = 0;
    let events = [];
    let ended = false;
    res.on("data", (c) => {
      bytes += c.length;
      events.push(...[...c.toString("utf8").matchAll(/^event: (\S+)/gm)].map((m) => m[1]));
    });
    res.on("end", () => (ended = true));
    setTimeout(() => {
      check(res.statusCode === 200 && /text\/event-stream/.test(res.headers["content-type"]) && !ended && bytes > 0,
        `GET /api/events stays open for ${seconds} s and streams`, `${res.statusCode}, ${bytes} bytes, events: ${[...new Set(events)].join(", ")}`);
      req.destroy();
      resolve();
    }, seconds * 1000);
  });
});

// 4. Subsonic: ping, a scan, the songs
const ping = await subsonic("ping");
check(ping?.status === "ok", "Subsonic ping.view (token auth)", ping?.status);
await subsonic("startScan");
let songs = [];
for (let i = 0; i < 120; i++) {
  const status = await subsonic("getScanStatus");
  if (!status.scanStatus.scanning) {
    songs = (await subsonic("search3", { query: "", songCount: "50", artistCount: "0", albumCount: "0" })).searchResult3.song ?? [];
    if (songs.length) break;
  }
  await sleep(500);
}
check(songs.length >= 4, "the fixture songs are in the library", `${songs.length} songs: ${songs.map((s) => s.suffix).join(", ")}`);

// 5. a real file streamed with Range
const files = fs.readdirSync(path.join(root, "music", "Fixtures")).map((name) => path.join(root, "music", "Fixtures", name));
for (const suffix of ["mp3", "flac"]) {
  const song = songs.find((s) => s.suffix === suffix);
  const file = song && files.find((f) => f.endsWith(`.${suffix}`) && fs.statSync(f).size === song.size);
  if (!file) {
    check(false, `a ${suffix} song to stream`);
    continue;
  }
  const bytes = fs.readFileSync(file);
  const r = await request("GET", `/rest/stream.view?${subsonicQuery({ id: song.id, format: "raw" })}`, { headers: { range: "bytes=1000-1999" } });
  check(r.status === 206 && r.headers["content-range"] === `bytes 1000-1999/${bytes.length}` && r.body.equals(bytes.subarray(1000, 2000)),
    `stream.view (${suffix}) with Range: 206 and the file's bytes`, `${r.status}, ${r.headers["content-range"]}, ${r.body.length} bytes`);
  const whole = await request("GET", `/rest/stream.view?${subsonicQuery({ id: song.id, format: "raw" })}`);
  check(whole.status === 200 && whole.body.equals(bytes), `stream.view (${suffix}) whole: 200 and the file's bytes`, `${whole.status}, ${whole.body.length} bytes`);
}

// 6. Sonus Connect: the WebSocket says welcome
const welcome = await new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:4633/rest/connect.view?${subsonicQuery()}`);
  const timer = setTimeout(() => { ws.close(); resolve(null); }, 10000);
  ws.onmessage = (event) => {
    clearTimeout(timer);
    ws.close();
    resolve(JSON.parse(event.data));
  };
  ws.onerror = () => { clearTimeout(timer); resolve(null); };
});
check(welcome?.type === "welcome", "Connect WebSocket: the first message is welcome", welcome ? `type ${welcome.type}, version ${welcome.version}` : "none");

// 7. who the client is: decided by the gateway, logged by Navidrome
const spoof = { "x-forwarded-for": "198.51.100.1", "x-real-ip": "198.51.100.2", "true-client-ip": "198.51.100.3" };
const asOther = await request("GET", `/rest/ping.view?${subsonicQuery({ c: "from-127.0.0.2" })}`, { headers: spoof, localAddress: "127.0.0.2" });
check(asOther.status === 200, "a request from 127.0.0.2 with forged forwarding headers", `${asOther.status}`);
const userFrom = async (localAddress, headers) => (await request("GET", "/api/song?_start=0&_end=1", { headers, localAddress })).status;
if (mode === "a") {
  check((await userFrom("127.0.0.1", { "remote-user": username })) === 401, "no trusted proxy: Remote-User from 127.0.0.1 signs nobody in");
} else {
  const trusted = await request("GET", `/rest/ping.view?${subsonicQuery({ c: "from-trusted-proxy" })}`, { headers: { "x-real-ip": "203.0.113.77" } });
  check(trusted.status === 200, "a request from the trusted proxy 127.0.0.1 for client 203.0.113.77", `${trusted.status}`);
  check((await userFrom("127.0.0.1", { "remote-user": username })) === 200, "the trusted proxy's Remote-User signs in (Navidrome's external auth)");
  check((await userFrom("127.0.0.2", { "remote-user": username })) === 401, "Remote-User from an untrusted peer (127.0.0.2) signs nobody in");
}
await sleep(500);
const log = fs.readdirSync(path.join(root, "logs")).filter((f) => f.startsWith(`run-${mode}`)).map((f) => fs.readFileSync(path.join(root, "logs", f), "utf8")).join("\n");
const remoteFor = (client) => log.split("\n").filter((l) => l.includes(`c=${client}`) && l.includes("HTTP: GET")).map((l) => l.match(/remoteAddr=(\S+)/)?.[1]);
check(remoteFor("from-127.0.0.2").includes("127.0.0.2"), "Navidrome logs the forger as 127.0.0.2 (its real address, not 127.0.0.1 nor the forged ones)", `remoteAddr=${remoteFor("from-127.0.0.2").join(",")}`);
if (mode === "b") {
  check(remoteFor("from-trusted-proxy").includes("203.0.113.77"), "Navidrome logs the trusted proxy's client 203.0.113.77", `remoteAddr=${remoteFor("from-trusted-proxy").join(",")}`);
}
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
