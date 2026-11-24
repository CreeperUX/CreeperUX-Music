# Sonus server

The Sonus music server, in Rust (AGPL-3.0, `LICENSE`). A gateway: it listens where Navidrome used to, runs the
CreeperUX fork of Navidrome (frozen at 0.64.2) behind it on a local port, and passes requests through, streamed both
ways, WebSockets included. Parts of the server move here one by one behind the same APIs; the route, with the
decisions behind it, is `docs/server-roadmap.md`.

Status: phase 0's gateway, and the first half of phase 2: **Subsonic sign-ins are checked here** ([below](#sign-ins)),
on Navidrome's own database, which the server opens beside Navidrome. Everything else is still Navidrome's. It reads
Navidrome's own settings (`navidrome.toml`, `ND_*`, the command line), has unit and integration tests, and passes the
contract suite and the differential corpora of `tools/contract` in front of the real frozen Navidrome
([below](#checked-against-the-real-navidrome)). The image `ghcr.io/creeperux/sonus-server` is built by CI
(`.github/workflows/server.yml`). What the server decides and whom it trusts is in [`SECURITY.md`](SECURITY.md).

## Running it

```sh
cargo run                                              # runs `navidrome` (PATH) on 127.0.0.1:4534, listens on :4533
SONUS_NAVIDROME_URL=http://127.0.0.1:4801 cargo run    # in front of a server that runs on its own (the demo server)
```

In the image, nothing changes for the container: same volumes, same environment, same port. Only the image name
changes, `ghcr.io/creeperux/navidrome` → `ghcr.io/creeperux/sonus-server`; going back is changing it back.

In front of a server that runs on its own (`SONUS_NAVIDROME_URL`) the gateway only passes requests through: it checks
no sign-ins and opens no database, since it neither knows that server's settings nor is believed by it.

## Settings

The gateway reads Navidrome's settings as Navidrome reads them, so a container keeps its configuration:

- **Where**: the config file named by `--configfile` / `-c`, else `ND_CONFIGFILE` when something is there (the image
  sets `/data/navidrome.toml`), else the first `navidrome.<ext>` in the working directory; the `ND_*` environment
  variables (an empty one counts as unset); `PORT` too, for the port, as Navidrome reads it; and `--baseurl`.
- **Precedence**, Navidrome's (viper's): a key written in the file as its environment variable (`ND_PORT = 4533`),
  then a command-line flag, then the environment, then the file, then the default. Keys are case-insensitive, and
  `[ExtAuth] TrustedSources`, `ExtAuth.TrustedSources` and `"ExtAuth.TrustedSources"` are the same setting.
  The old names `ReverseProxyWhitelist` / `ReverseProxyUserHeader` count only when the new ones are set nowhere.
- **Read**: `Address`, `Port`, `BaseURL` (requests pass through as they came, and Navidrome serves under its path; the
  routes answered here are under it too), `ExtAuth.TrustedSources`, `ExtAuth.UserHeader`, `TLSCert`, `TLSKey`; and for
  the sign-ins checked here: `DataFolder` (also `--datafolder`), `DbPath`, `PasswordEncryptionKey`, `AuthRequestLimit`,
  `AuthWindowLength`, `Sonus.TwoFactor`, `HTTPHeaders.FrameOptions`.

| Setting | Default | |
|---|---|---|
| `Address`, `Port` (`ND_ADDRESS`, `ND_PORT`) | `0.0.0.0`, `4533` | where clients connect: the gateway takes Navidrome's place |
| `ExtAuth.TrustedSources` (`ND_EXTAUTH_TRUSTEDSOURCES`) | none | the proxies in front whose forwarding headers are believed, as Navidrome reads them (CIDR entries only, `src/trust.rs`) |
| `ExtAuth.UserHeader` (`ND_EXTAUTH_USERHEADER`) | `Remote-User` | the signed-in user, believed from those proxies only; empty turns it off |
| `DataFolder`, `DbPath` (`ND_DATAFOLDER`, `ND_DBPATH`) | `.`, `navidrome.db` in the data folder | Navidrome's database, which the server opens too (`DbPath`: a path, optionally after `file:` and before `?options`) |
| `PasswordEncryptionKey` (`ND_PASSWORDENCRYPTIONKEY`) | Navidrome's built-in key | what stored passwords and app passwords are encrypted with; never logged |
| `AuthRequestLimit`, `AuthWindowLength` | `5`, `20s` | failed sign-ins allowed per address and user in a window; `0` turns the limit off |
| `Sonus.TwoFactor` (`ND_SONUS_TWOFACTOR`) | `required` | `off`: an account password signs the API even with two-step verification set up |
| `SONUS_NAVIDROME_BIN` | `/app/navidrome`, else `navidrome` | the Navidrome to run |
| `SONUS_NAVIDROME_PORT` | `4534` | its port, on 127.0.0.1 |
| `SONUS_NAVIDROME_URL` | none | an `http://` Navidrome (or demo server) to proxy instead of running one; nothing is checked here then |
| `SONUS_LOG` | `info` | log filter (`debug`: one line per request, the path only: queries carry credentials) |

The gateway's own settings (`SONUS_*`) come from the environment only. Only TOML config files are read (the roadmap
keeps TOML and the environment); a `navidrome.json`, `.yaml` or `.ini` stops the gateway with a message.

### What stops it

The gateway refuses to start (exit code 2, with the reason in the log) rather than let Navidrome escape it:

- TLS (`TLSCert`, `TLSKey`): put TLS in a proxy in front;
- a unix socket address (`Address = "unix:…"`);
- `--address`, `--port`, `--tlscert`, `--tlskey` on the command line, or a subcommand (`navidrome scan`): flags outrank
  the environment the gateway gives Navidrome; run Navidrome's commands with `/app/navidrome` itself (`docker exec`);
- `ND_ADDRESS`, `ND_PORT`, `ND_EXTAUTH_TRUSTEDSOURCES`, `ND_EXTAUTH_USERHEADER` written as keys in the config file:
  there Navidrome takes them over its environment; write them as `Address`, `Port`, … instead;
- a user header the gateway sets or removes itself (`X-Real-IP`, `Host`, `Connection`, …), or one that is not a header name;
- `AuthRequestLimit` that is not a number, `AuthWindowLength` that is not a duration, an in-memory `DbPath`;
- a config file Navidrome could not read either (bad TOML, the same key twice).

### What Navidrome is told

Navidrome is started with the container's environment and arguments, plus these, which outrank its config file:

| Variable | Value |
|---|---|
| `ND_ADDRESS`, `ND_PORT` | `127.0.0.1`, `SONUS_NAVIDROME_PORT` |
| `ND_EXTAUTH_TRUSTEDSOURCES` | `127.0.0.1/32`: the gateway alone |
| `ND_EXTAUTH_USERHEADER` | the user header the gateway decided on; with no trusted proxy, a random `x-sonus-user-…` name, new at every start |

The gateway decides who the client is (`src/trust.rs`, Navidrome's rules) and tells Navidrome alone, with `X-Real-IP`.
A client's own `X-Forwarded-For`, `X-Real-IP` and `True-Client-IP` never reach Navidrome. The user header is passed
on only from a trusted proxy, under the name Navidrome reads, which the gateway removes from every other request. With
no trusted proxy that name is random, so nothing that reaches 127.0.0.1:4534 without the gateway (another process in
the container, or on the host with host networking) can sign in with a header either.

When Navidrome stops, the gateway stops too, with Navidrome's exit code (128 + the signal when a signal ended it; 1 when
it exited cleanly, since the server stopping by itself is a failure), so the container restarts as it did.

### What stops it once Navidrome is up

Once Navidrome answers (it migrates its database before it listens), the server opens the database and stops (exit
code 1, Navidrome stopped first) when it is not the one it knows:

- the schema is not goose version `20260922230428` (Navidrome 0.64.2's last migration): a newer or older Navidrome;
- the fork's tables are missing (`sonus_two_factor`, `sonus_recovery_code`, `sonus_app_password` with `secret_hash`):
  upstream Navidrome's database, or an old build of the fork's;
- there is not exactly one library (roadmap, decision 4);
- the file cannot be opened, or this build's SQLite lacks FTS5 or the JSON functions (it has both: `src/db.rs` tests it).

Until that check is done, Subsonic requests that need a sign-in are answered 503 with `Retry-After`, as while
Navidrome starts: credentials are not handed to Navidrome in the meantime.

## Sign-ins

A request to a Subsonic method behind the sign-in (`/rest/<method>`, `/rest/<method>.view`, by any HTTP method; every
method Navidrome's router protects, `src/subsonic/mod.rs` lists them) is checked by the gateway, exactly as Navidrome
checks it (`server/subsonic/middlewares.go` and the fork's `sonus_auth.go`):

| The request | What happens |
|---|---|
| lacks `u`, `v` or `c` (with `apiKey`: `v` or `c`) | error 10, `missing parameter: 'u'`, answered here |
| `u` with a wrong `p` or `t`/`s`, or an unknown `u`, or `u` alone | error 40, answered here |
| `u` with the account password, of a user with two-step verification set up (unless `Sonus.TwoFactor` is `off`) | error 40: only an app password signs for them |
| `apiKey` with `u`, `p`, `t`, `s` or `jwt` | error 43, answered here |
| an `apiKey` that is no one's | error 44, answered here |
| too many failures from this address (`AuthRequestLimit` in `AuthWindowLength`) | error 40 (or 44 for keys), right credentials included |
| right credentials: the password as `p`, `p=enc:<hex>` or `t`+`s`; an app password the same three ways, with or without its dashes; an API key | goes on to Navidrome **without** `p`, `t`, `s`, `apiKey`, with the user named in the header only the gateway sets ([What Navidrome is told](#what-navidrome-is-told)); `tokenInfo` is answered here |
| `jwt=` (the web UI's session), without `apiKey` | Navidrome's to check, as it came |
| a user header from a trusted proxy (`ExtAuth`) | Navidrome's to look up, as it came |
| a query or form Go's parser refuses (`%zz`, a `;`), a form over 10 MiB | Navidrome's to answer with its error (it checks no sign-in for these), as it came |
| a CORS preflight, `getOpenSubsonicExtensions`, a path that is no method | Navidrome's (it checks no sign-in for these either), as it came |
| right credentials for a user whose name no header can carry (control characters, spaces at its ends) | Navidrome's to check again, as it came |

A form (`application/x-www-form-urlencoded` in a POST, PUT or PATCH; OpenSubsonic `formPost`) is read as Navidrome
reads it: the body's parameters come before the query's, and the credentials are removed from both before it goes on.

So every request for which Navidrome would compare a password, a token or a key is decided here, by one limiter; what
reaches Navidrome with credentials still in it are the cases above where Navidrome compares none (it answers an error,
a preflight, a 404), and a session token, which is a signature it verifies.

Answers given here are Navidrome's byte for byte: the same envelope (the gateway asks Navidrome for it once, at start,
through `getOpenSubsonicExtensions`, so `serverVersion` is Navidrome's own), in JSON, JSONP (`callback`) or XML as `f`
asks, HTTP 200, with Navidrome's security and CORS headers. Decision 1 of the roadmap needs only JSON; XML and JSONP
are answered here too rather than left to Navidrome, so that one place decides every credential check.

Where the gateway differs from Navidrome, knowingly:

- Navidrome compresses answers when the client accepts it; the gateway's own (a few hundred bytes) are sent as they
  are.
- Secrets are compared in constant time (Navidrome compares the account password and tokens with `==`).
- A stored password that cannot be decrypted matches nothing (Navidrome goes on to compare its ciphertext), and stored
  passwords are opened with `PasswordEncryptionKey` and then Navidrome's default key, as Navidrome opens app passwords
  (it opens account passwords with the one key it settled on at start).
- A user name that is not UTF-8 text is refused here as a wrong password (Navidrome looks it up and finds nobody).
- A POST, PUT or PATCH whose `Content-Type` Go's parser refuses: Navidrome answers error 0 before looking at the
  sign-in; here the sign-in is checked first (40 when it is wrong; when it is right Navidrome answers its error 0).
- App passwords made before API keys get their key hash when the server starts (Navidrome: when its store is first
  used, which with sign-ins checked here might be never).

What Navidrome still does for a signed-in request, unchanged: it looks the user up by the header's name (never
creating one), registers the player (`c`, the `nd-player-…` cookie, named after the user name as the client typed it,
which is the name the gateway passes on), writes the user's last access, and answers the method. For `tokenInfo`,
answered here, the gateway writes the last access itself, at most once a minute per user as Navidrome does. An app
password's use (`last_used_at`, `last_used_by`) is noted here as Navidrome notes it, at most every five minutes per
client name. Nothing else is written to the database.

### The database

`src/db.rs`. The file Navidrome's settings name (`DataFolder`, `DbPath`), opened beside Navidrome:

- every connection: WAL, `busy_timeout` 15 s, `foreign_keys=ON`, `synchronous=NORMAL`, as Navidrome's;
- reads in autocommit; every write is one short `BEGIN IMMEDIATE` transaction;
- SQLite is rusqlite's bundled copy, with FTS5 and the JSON functions (Navidrome's triggers need FTS5 on writes to
  songs, albums and artists: later phases);
- calls block, so they run on tokio's blocking threads;
- the schema stays Navidrome's: checked at start (above), never created, altered or dropped here, never VACUUMed.

Timestamps are written as Navidrome's driver writes them (`src/gotime.rs`: `2006-01-02 15:04:05.999999999-07:00`).

### Secrets

`src/secrets.rs`, byte-compatible with Navidrome (`utils/encrypt.go`): account passwords and app passwords are
AES-256-GCM, key sha256(`PasswordEncryptionKey`), stored as base64(nonce ‖ ciphertext ‖ tag). An API key is found by
sha256 of the key as typed, lowercased and without dashes and spaces. The unit tests open values Navidrome's own code
sealed, and Navidrome's code opened what this server sealed (`tests/golden/README.md`).

## The image

`Dockerfile` (build context `server/`) starts from `ARG NAVIDROME_IMAGE=ghcr.io/creeperux/navidrome:latest` and adds
the gateway as `/app/sonus-server`, the entrypoint; everything else of Navidrome's image stays. The Rust stage runs on
the build machine and cross-compiles a static musl binary with `rust-lld`, without QEMU. One dependency is C: SQLite,
which clang compiles for the target against the target's musl headers (Alpine's `musl-dev` for that architecture, put
into `/sysroot` by `apk`). `SONUS_GIT_SHA` (a build argument) goes into the version the server logs.

```sh
docker build --build-arg SONUS_GIT_SHA=$(git rev-parse HEAD) -t sonus-server server
```

CI (`.github/workflows/server.yml`): `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings` and
`cargo test` on pushes to `main` and pull requests touching `server/`; on pull requests the image is also built for
both architectures and thrown away, so a broken cross build shows before merging; off pull requests it builds and
pushes linux/amd64 and linux/arm64, tagged `latest`, the Cargo version and `sha-<short>`. It also runs every Monday at
02:30 UTC, an hour after the Navidrome image's weekly rebuild, and by hand.

## Tests

`cargo test` runs:

- unit tests next to the code: settings (`src/config*.rs`), the command line, the trusted list and client address;
  secrets against values Navidrome sealed (`tests/golden/`), tokens, timestamps; the database's set-up, its schema
  check, FTS5 and JSON; the sign-in rule (passwords, tokens, `enc:`, app passwords, two-step verification); the limiter
  (its counting, 2 × limit − 1 guesses a window at most, cancelled waiters); query and form parsing as Go parses them;
  the answers' bytes in JSON, XML and JSONP;
- `tests/subsonic.rs`: the gateway with its sign-in check against a fake Navidrome that records what reaches it, and a
  database made as the frozen Navidrome makes it: every way to sign in and every refusal; that a refused request never
  reaches Navidrome and a signed-in one reaches it without credentials and with the user in the gateway's header; form
  posts; what stays Navidrome's (session tokens, a trusted proxy's user, malformed queries, other HTTP methods); a
  client's own user headers ignored; `tokenInfo`; the limiter per address and user, and per address for keys; what is
  written (an app password's use, the last access); 503 until the database is checked; a base path; the start-up
  check refusing another schema;
- `tests/gateway.rs`: the gateway against a fake Navidrome: method, target, body and `Host` passing through; a 16 MiB
  upload Navidrome starts reading before the client has sent it all; a response whose first part arrives while the
  rest is still being made; `Range` and 206; a WebSocket carrying bytes both ways; hop-by-hop headers (and those named
  in `Connection`) dropped both ways; forged forwarding and user headers from an untrusted peer; a trusted proxy's
  believed; 503 while Navidrome starts, 502 after; `CONNECT` refused;
- `tests/supervisor.rs`: the real binary running a fake Navidrome (the test binary itself, started again, which makes
  its database first): the settings it gets (from a `navidrome.toml`), the random user header, exit codes passed on, a
  refused setting stopping it, a sign-in checked and passed on under that header, a database of another schema
  stopping the server.

Against the real Navidrome (`tools/contract`, not part of `cargo test`: it needs the fork's binary):

```sh
node tools/fixtures/build.mjs                         # once: the test library and the golden database
node tools/contract/run.mjs --through-gateway         # the contract suite through this server
node tools/contract/diff.mjs --go-vs-gateway          # the same requests to Navidrome alone and to this server
node tools/contract/diff.mjs --go-vs-gateway --corpus tools/contract/corpus/writes.json
node --test tools/contract/gateway.test.mjs           # the limiter, and what Navidrome never sees
```

These start this server as its image runs it: `cargo run`, which starts Navidrome itself on a copy of the golden
database.

## Checked against the real Navidrome

### Sign-ins (phase 2), 2026-11-24

On Windows (ARM64), with the fork's Navidrome 0.64.2-sonus.10 (`fb95b5ce`, x64) started by this server on copies of
the golden database of `tools/fixtures` (three users: an admin and a user with two-step verification, app passwords
and an API key, and a plain user):

- `node tools/contract/run.mjs --through-gateway`: 110 of 110 (the suite's 100, and 10 added for sign-ins: mixed
  credentials, `p` over `t`, missing `v`/`c`, names in any case, app passwords as API keys, `tokenInfo`, CORS on a
  refusal);
- `node tools/contract/diff.mjs --go-vs-gateway`: 169 requests, all identical to Navidrome alone, 53 of them added for
  sign-ins: every refusal in JSON, XML and JSONP (compared byte for byte), in the query and as a form, by GET, POST,
  HEAD, PUT, PATCH, DELETE and OPTIONS, a CORS preflight, malformed queries;
- the same with `corpus/writes.json`: 34 of 34 identical;
- `node --test tools/contract/gateway.test.mjs`: with `AuthRequestLimit=3`, sixteen steps of failures (by GET, by
  form post, by HEAD), refusals of right credentials, other users and keys, and a new window come out the same from
  Navidrome alone and from this server; with Navidrome's log at debug level, the requests this server refused are not in it and no `p`, `t`, `s` or
  `apiKey` parameter is, while Navidrome alone logs them all and refuses them itself; the player cookie has the same
  name and attributes, now playing lists the player, the last access is written, no user is created; a client's
  `Remote-User` or `X-Sonus-User…` header signs nobody in, on `/rest` or on the web UI's page.

Not checked: the image (CI builds it; no Docker here) and Linux binaries; a database in production's size; transcoding
(no ffmpeg here); a `BaseURL` with a path in front of the real Navidrome (the fake one only).

### The gateway (phase 0), 2026-11-24

On Windows (ARM64), with an x64 build of the fork (`navidrome-freeze.exe`, built from `creeperux` with
`go build -tags netgo,sqlite_fts5`) and the release build of this gateway. A throwaway data folder, a music folder with
five files from the fork's `tests/fixtures` (`test.mp3`, `test.flac`, `test.ogg`, `test.m4a`,
`01 Invisible (RED) Edit Version.mp3`), and a throwaway admin made through the gateway, its credentials kept in a file
outside the repository and never printed. Two config files, the gateway's port coming from them:

```toml
# navidrome-a.toml: no trusted proxy
MusicFolder = '<folder>/music'
DataFolder = '<folder>/data'
Address = '127.0.0.1'
Port = 4633
LogLevel = 'debug'
EnableInsightsCollector = false
EnableExternalServices = false
# navidrome-b.toml: the same, plus the check script on 127.0.0.1 playing a trusted proxy (127.0.0.2 is anyone else)
[ExtAuth]
TrustedSources = '127.0.0.1/32'
```

```sh
ND_CONFIGFILE=<folder>/data/navidrome-a.toml ND_SONUS_TWOFACTOR=off SONUS_NAVIDROME_BIN=<path>/navidrome-freeze.exe \
  SONUS_NAVIDROME_PORT=4634 SONUS_LOG=debug target/release/sonus-server > <folder>/logs/run-a.out.log 2> <folder>/logs/run-a.err.log
node scripts/check-real-navidrome.mjs a <folder>     # then stop it, and the same with navidrome-b.toml and "b"
```

Everything held, in both runs:

- Navidrome listened on 127.0.0.1:4634 (the gateway's override) while reading the same config file, which said 4633.
- The web UI loads (`/app/`, its 2.7 MB script) and signs in: `POST /auth/login`, and in a browser through the real
  login form, after which the album list, cover art, `/api/events` and the page's Subsonic calls all answered 200.
- `/api/events` stayed open for 35 s, streaming `serverStart`, `scanStatus`, `refreshResource`, `keepAlive`.
- Subsonic `ping` (token auth), `startScan`, `getScanStatus`, `search3` (the five songs).
- `stream.view?format=raw` of the mp3 and the flac: with `Range: bytes=1000-1999`, 206, the right `Content-Range` and
  the file's own bytes; without, 200 and the whole file.
- The Connect WebSocket (`rest/connect.view`) answered `welcome` first.
- A request from 127.0.0.2 with forged `X-Forwarded-For`, `X-Real-IP`, `True-Client-IP`: Navidrome logged
  `remoteAddr=127.0.0.2`. In run B, the trusted proxy's `X-Real-IP: 203.0.113.77` was logged as `remoteAddr=203.0.113.77`.
- `Remote-User`: signs nobody in with no trusted proxy (run A), nor from 127.0.0.2 (run B); from the trusted proxy it
  signs in (run B: Navidrome's external auth through the gateway).

Also checked here: the musl binaries link (`cargo build --release --target x86_64-unknown-linux-musl` and
`aarch64-unknown-linux-musl` with `CARGO_TARGET_*_LINKER=rust-lld`: static ELF executables, the commit inside). Not
checked here: the image itself (no Docker on this machine; CI builds it first, after merging), and running the Linux
binaries (no Linux here).

## Code

- `src/config.rs`: settings, and what Navidrome is told; `src/config/file.rs`: the config file; `src/config/flags.rs`:
  the command line.
- `src/trust.rs`: who the client is (Navidrome's rules, reproduced).
- `src/gateway.rs`: the proxy, and where the parts answered here branch off.
- `src/routes.rs`: which requests the gateway answers or checks itself. A new part of the server (the `/auth` routes,
  Connect) is a variant of `Local` there, its paths in `find`, an arm in `Gateway::handle`, and a module of its own.
- `src/subsonic/`: Subsonic sign-ins. `mod.rs`: what happens to a request; `credentials.rs`: whose the credentials
  are (the rule, and the queries); `limiter.rs`: failed attempts; `params.rs`: the query and the form, as Go reads
  them; `respond.rs`: the answers, as Navidrome writes them.
- `src/db.rs`: Navidrome's database; `src/gotime.rs`: its timestamps; `src/secrets.rs`: its encryption.
- `src/startup.rs`: what must hold before anything is answered here.
- `src/supervisor.rs`: runs Navidrome.
- `src/main.rs`: puts them together; stops on SIGTERM / Ctrl+C.
- `scripts/check-real-navidrome.mjs`: the phase 0 check above.
- `examples/seal.rs`, `tests/golden/`: checking the encryption against Navidrome's own code.

Code ported from Navidrome's (the sign-in rule, the limiter, the encryption) is a derived work of Navidrome
(GPL-3.0) and says so in its header; GPL-3.0 and AGPL-3.0 combine (section 13 of both).

`rustfmt.toml` keeps the width the code is written to (160).
