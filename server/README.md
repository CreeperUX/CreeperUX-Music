# Sonus server

The Sonus music server, in Rust (AGPL-3.0, `LICENSE`). A gateway: it listens where Navidrome used to, runs the
CreeperUX fork of Navidrome (frozen at 0.64.2) behind it on a local port, and passes requests through, streamed both
ways, WebSockets included. Parts of the server move here one by one behind the same APIs; the route, with the
decisions behind it, is `docs/server-roadmap.md`.

Status: phase 0's gateway, phase 2: **Subsonic sign-ins are checked here** ([below](#sign-ins)) and **the `/auth`
routes are answered here** ([below](#the-auth-routes): the web sign-in with two-step verification, app passwords, the
browser sign-in for apps), on Navidrome's own database, which the server opens beside Navidrome; and phase 1:
**Sonus Connect version 2 is answered here** ([below](#sonus-connect-version-2): one playback session per user, kept
in the database); and phase 3, so far: **the library's reads `ping`, `getSong`, `getAlbum` and `getAlbumList2` are
answered here** from Navidrome's database ([below](#the-librarys-reads)). Everything else is still Navidrome's. It reads
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
  what is answered here: `DataFolder` (also `--datafolder`), `DbPath`, `PasswordEncryptionKey`, `AuthRequestLimit`,
  `AuthWindowLength`, `Sonus.TwoFactor`, `HTTPHeaders.FrameOptions`, `SessionTimeout` (also `--sessiontimeout`),
  `EnableGravatar`, `DevAutoLoginUsername`; and what changes the library's answers
  ([the table there](#the-librarys-reads)): `Subsonic.AppendSubtitle`, `Subsonic.AppendAlbumVersion`,
  `Subsonic.EnableAverageRating`, `Subsonic.ArtistParticipations`, `Subsonic.LegacyClients`,
  `Subsonic.MinimalClients`, `PreferSortTags`, `EnableNaturalSorting`, `RecentlyAddedByModTime`,
  `AlbumPlayCountMode`, `EnableMediaFileCoverArt`, `IgnoredArticles`, `Search.Backend`, `Search.FullString` (and its
  old name `SearchFullString`).

| Setting | Default | |
|---|---|---|
| `Address`, `Port` (`ND_ADDRESS`, `ND_PORT`) | `0.0.0.0`, `4533` | where clients connect: the gateway takes Navidrome's place |
| `ExtAuth.TrustedSources` (`ND_EXTAUTH_TRUSTEDSOURCES`) | none | the proxies in front whose forwarding headers are believed, as Navidrome reads them (CIDR entries only, `src/trust.rs`) |
| `ExtAuth.UserHeader` (`ND_EXTAUTH_USERHEADER`) | `Remote-User` | the signed-in user, believed from those proxies only; empty turns it off |
| `DataFolder`, `DbPath` (`ND_DATAFOLDER`, `ND_DBPATH`) | `.`, `navidrome.db` in the data folder | Navidrome's database, which the server opens too (`DbPath`: a path, optionally after `file:` and before `?options`) |
| `PasswordEncryptionKey` (`ND_PASSWORDENCRYPTIONKEY`) | Navidrome's built-in key | what stored passwords and app passwords are encrypted with; never logged |
| `AuthRequestLimit`, `AuthWindowLength` | `5`, `20s` | failed Subsonic sign-ins allowed per address and user in a window, and requests to the sign-in routes under `/auth` per address; `0` turns both limits off |
| `SessionTimeout` (`ND_SESSIONTIMEOUT`) | `48h` | how long a web session's token is good; Navidrome renews it at every use of its API |
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
- `AuthRequestLimit` that is not a number, `AuthWindowLength` or `SessionTimeout` that is not a duration,
  `EnableGravatar` or one of the library's yes-or-no settings that is not true or false, an in-memory `DbPath`;
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
- the session secret (`JWTSecret` in the `property` table, which Navidrome makes at its first start) is missing or
  cannot be opened with `PasswordEncryptionKey`;
- the file cannot be opened, or this build's SQLite lacks FTS5 or the JSON functions (it has both: `src/db.rs` tests it).

Until that check is done, Subsonic requests that need a sign-in and everything under `/auth` are answered 503 with
`Retry-After`, as while Navidrome starts: credentials are not handed to Navidrome in the meantime.

At start the server also makes one Subsonic request to Navidrome itself, a sign-in as nobody
(`sonus-server-start-probe`, refused: Navidrome logs one invalid login per start). It reads from the answer how
Navidrome starts its Subsonic answers, and it makes Navidrome open its user store, which is when Navidrome settles its
password encryption: on a new database, or after `PasswordEncryptionKey` was set, Navidrome re-encrypts the passwords
it finds, assuming the default key, at its first use of the user store. Were the first admin made here before that,
Navidrome would take that password for an old one and never read it again.

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

What Navidrome still does for a signed-in request it answers (all but [the library's reads](#the-librarys-reads)),
unchanged: it looks the user up by the header's name (never creating one), registers the player (`c`, the `nd-player-…` cookie, named after the user name as the client typed it,
which is the name the gateway passes on), writes the user's last access, and answers the method. For `tokenInfo`,
answered here, the gateway writes the last access itself, at most once a minute per user as Navidrome does. An app
password's use (`last_used_at`, `last_used_by`) is noted here as Navidrome notes it, at most every five minutes per
client name. Nothing else is written to the database.

## The `/auth` routes

Everything under `/auth` is answered here (`src/auth/`), as Navidrome's `server/auth.go` and the fork's
`sonus_twofactor.go` and `sonus_device.go` answer it: the same JSON, status codes and messages.

| Route | |
|---|---|
| `POST /auth/login` | the password, then per `Sonus.TwoFactor`: a code (`otp`: from the authenticator, each once, or a recovery code), or for a user who has not set it up while it is required, a setup token instead of a session (`"twoFactor": "setup"`) |
| `POST /auth/createAdmin` | the first user, an admin, only while there is none (the count and the insert are one transaction) |
| `POST /auth/2fa/setup`, `/2fa/confirm` | a new authenticator secret with its `otpauth://` link and QR code (a PNG), then a code from it: recovery codes, and a session |
| `GET /auth/2fa`, `POST /2fa/recovery-codes`, `/2fa/disable` | the user's own: status, new recovery codes (takes a code), turning it off (takes a code; refused while required) |
| `GET`, `POST /auth/app-passwords`, `DELETE /app-passwords/{id}` | app passwords: listed, made (shown once), revoked |
| `GET /auth/2fa/users/{id}`, `POST /2fa/users/{id}/reset` | admins: someone's status, and a reset for a lost phone |
| `POST /auth/device/start`, `/device/poll`, `/device/revoke` | the browser sign-in, the app's side: ask, poll (the API key is handed over once), give the key back |
| `GET /auth/device/{code}`, `POST /device/{code}/approve`, `/deny` | the approval page's side, signed in |
| anything else under `/auth` | 404, or 405 with `Allow`, as Navidrome's router; a CORS preflight alone goes to Navidrome (its CORS middleware answers it) |

- **Sessions** are the JWTs Navidrome makes and checks (`src/jwt.rs`): HS256 with the secret from the `property`
  table, claims `iss`, `sub`, `iat`, `exp`, `uid`, `adm`, `ep`, `aud`. A token made here opens Navidrome's `/api`
  (which then renews it), and one Navidrome made or renewed opens `/auth` here; a password change through Navidrome's
  API bumps the user's epoch and revokes the tokens made here too. A setup token (`aud: sonus-2fa-setup`, 15 minutes)
  opens only the two setup routes.
- **Who is signed in** on the signed-in routes is decided as Navidrome's `Authenticator` decides it:
  `DevAutoLoginUsername`, else the session token (`X-ND-Authorization: Bearer …`, the `jwt` cookie, `?jwt=`: the first
  one found), else a trusted proxy's user header; the user must exist, and a valid token naming them must still be
  theirs (id), current (epoch) and for this API (audience).
- **The rate limit** is Navidrome's (go-chi/httprate's sliding window, `src/auth/ratelimit.rs`): `AuthRequestLimit`
  requests per `AuthWindowLength` per client address, every request counted, one count across `login`, the two setup
  routes, `recovery-codes`, `disable`, `device/start` and `device/revoke`; 429 with `Retry-After`, and
  `X-RateLimit-*` on every answer of those routes.
- **Bodies**: at most 8 KB is read under `/auth` (more: the JSON does not decode, 422). Requests to Navidrome's own
  API (`/api`) and the Jellyfin API (`/jellyfin`) are bounded at 4 MiB here as Navidrome bounds them (413 for a longer
  declared body, read and thrown away within reason so the client gets the answer; a body without a length is cut off
  at the limit), uploads (`multipart/form-data`, `image/*`) apart.
- **Sign-ins waiting for approval** live in this process's memory (200 at most, ten minutes each): a restart drops
  them and the app asks again.
- **What is written**: a user's `last_login_at`; the first admin (as Navidrome's user repository writes a new user,
  with every library); the two-step verification rows and app passwords, in the fork's tables and formats.

Where it differs from Navidrome, knowingly: passwords are compared in constant time, and a stored password that
cannot be decrypted matches nothing; two first admins asked for at once make one (Navidrome counts, then inserts);
the QR code is the same code drawn by another library, so its PNG is not Navidrome's byte for byte; a user's display
name at `createAdmin` is titled by a simpler rule than Go's (each word's first letter); JSON answers escape `<`, `>`,
`&` as themselves where Go writes `\u003c` (the same JSON); a body cut off at 4 MiB without a declared length is
answered 413 here, where Navidrome's handler would fail on the truncated JSON.

### The database

`src/db.rs`. The file Navidrome's settings name (`DataFolder`, `DbPath`), opened beside Navidrome:

- every connection: WAL, `busy_timeout` 15 s, `foreign_keys=ON`, `synchronous=NORMAL`, as Navidrome's;
- reads in autocommit; every write is one short `BEGIN IMMEDIATE` transaction;
- SQLite is rusqlite's bundled copy, with FTS5 and the JSON functions (Navidrome's triggers need FTS5 on writes to
  songs, albums and artists: later phases), and Navidrome's `NATSORT` collation registered on every connection;
- calls block, so they run on tokio's blocking threads;
- the schema stays Navidrome's: checked at start (above), never altered or dropped here, never VACUUMed. The server's
  own tables ([Sonus Connect](#sonus-connect-version-2)) are beside it, in their own namespace with their own version
  table.

Timestamps are written as Navidrome's driver writes them (`src/gotime.rs`: `2006-01-02 15:04:05.999999999-07:00`).

### Secrets

`src/secrets.rs`, byte-compatible with Navidrome (`utils/encrypt.go`): account passwords and app passwords are
AES-256-GCM, key sha256(`PasswordEncryptionKey`), stored as base64(nonce ‖ ciphertext ‖ tag). An API key is found by
sha256 of the key as typed, lowercased and without dashes and spaces. The unit tests open values Navidrome's own code
sealed, and Navidrome's code opened what this server sealed (`tests/golden/README.md`).

## The library's reads

`src/library/` (roadmap, phase 3). The Subsonic methods Sonus clients read the library with are answered here, from
Navidrome's database, as Navidrome answers them: the same JSON, byte for byte, for the same request. Navidrome still
owns the database and writes it (its scanner too), so everything is read when the request comes and nothing is kept
between requests. So far, part 1 of 3:

| Method | |
|---|---|
| `ping` | the envelope alone, once the player is registered (below) |
| `getSong` | a song with the signed-in user's star, rating, play count and bookmark; 70 `Song not found` (also without an id) |
| `getAlbum` | an album and its songs in disc and track order; 70 `Album not found` |
| `getAlbumList2` | every `type`: `alphabeticalByName`, `alphabeticalByArtist`, `newest`, `recent`, `frequent`, `starred`, `highest`, `byYear` (`fromYear` > `toYear`: newest first), `byGenre`, `random`; `size` (10; at most 500; 0 or less: everything), `offset`; `X-Total-Count`; 10 for a missing `type`, `genre`, `fromYear` or `toYear`, 0 for a year that is not a number or an unknown type, in Navidrome's words |

Each also as `<method>.view`, by GET or as a form post, for any way of signing in the gateway checks.

**How an answer is made.** The queries are Navidrome's own SQL text (`query.rs`; taken from its trace log, statement
by statement), so SQLite answers with the same rows in the same order: the user's annotations joined in, the user's
libraries as Navidrome filters them (an admin sees every library, anyone else the ones granted in `user_library`), the
artwork state from `item_artwork` for the `coverArt` ids (`al-<id>_<hash>`, `mf-<id>`, `dc-<album>:<disc>`). The rows
become JSON as Go's `encoding/json` writes Navidrome's response structs (`entities.rs`, `json.rs`): the fields in the
struct's order, left out where `omitempty` leaves them out, times as Go marshals them with the offset they were
stored with, floats as Go formats them, `<`, `>` and `&` escaped as `\u003c`…

**What goes on to Navidrome all the same**, signed in, as before this phase (the gateway logs why at debug level):

| The request | Why |
|---|---|
| asks for XML or JSONP (`f` is not `json`) | the roadmap's decision 1: JSON only |
| carries `musicFolderId` | Sonus clients do not send it; it changes the list and has an error of its own |
| `getAlbumList2` with an `offset` and a `size` of 0 or less | Navidrome's query fails there (an OFFSET without a LIMIT), and its answer says so |
| comes from a player with a transcoding set | songs then carry `transcodedSuffix` and a content type from Go's tables |
| comes from a player with `ReportRealPath`, on Windows | Go builds the path by Windows' rules there; on Linux (the image) it is answered here |
| would show a song whose suffix is not in Navidrome's own list of types (`resources/mime_types.yaml`) | Go asks the operating system for its content type |
| names a parameter that is not UTF-8 text, or a row holds JSON this server does not read as Go's decoders do (a participant's role Navidrome does not know, …) | Navidrome's answer, error or not, is its own |
| could not be read from the database, or Navidrome registered no player for it, or its user is gone | Navidrome answers, or fails, as it would |

**The player.** Navidrome registers a player for every Subsonic request: it finds it by the `nd-player-…` cookie, else
by user, client name (`c`) and the browser family it reads from `User-Agent`, else makes one; it writes the player's
address and last-seen time at most once a minute, and answers with the cookie. A player's settings change a song
(`ReportRealPath`: the `path`; a forced transcoding). Registering stays Navidrome's until the methods that write a
player's state move here (phase 4): for a request answered here the server sends Navidrome one `ping` as the
signed-in user, with the request's client name, cookies, `User-Agent` and client address, and gives the client the
`Set-Cookie` Navidrome answers with (`player.rs`). So the player is the row Navidrome would have found or made, by
Navidrome's own rules. That answer is remembered for a minute per user, client name, `User-Agent` and cookies (the
time Navidrome lets pass between two writes of a player); the player's row is read again at every request, and a row
that is gone, or no longer this user's and client's, is registered anew. In Navidrome's log a client's reads thus show
as one `ping` a minute.

**The last access.** Navidrome notes a user's last access at every request it answers, at most once a minute; so does
the gateway for the requests it answers here (the same code as for `tokenInfo`).

**Navidrome's settings** that change these answers are read as Navidrome reads them ([Settings](#settings)):

| Setting | Default | Changes |
|---|---|---|
| `Subsonic.AppendSubtitle`, `Subsonic.AppendAlbumVersion` | on | a song's `title` and an album's `name` (and the made-up `path`) get the subtitle or version tag appended |
| `Subsonic.EnableAverageRating` | on | `averageRating` |
| `Subsonic.LegacyClients`, `Subsonic.MinimalClients` | `DSub`, `SubMusic` | which client names get no OpenSubsonic fields, or a song's id and title only |
| `PreferSortTags` | off | `sortName`, and the order of the lists by name |
| `EnableNaturalSorting` | off | numbers in names order by value: Navidrome's `NATSORT` collation, registered on this server's connections too (`natural.rs`) |
| `RecentlyAddedByModTime` | off | `created`, and the `newest` list |
| `AlbumPlayCountMode` | `absolute` | `normalized`: an album's `playCount` is divided by its songs |
| `EnableMediaFileCoverArt` | on | whether a song with a picture of its own has a `mf-` cover id |
| `Subsonic.DefaultReportRealPath` | off | nothing here: Navidrome gives it to a new player, and the player's own setting is what is read |

(`Subsonic.ArtistParticipations`, `IgnoredArticles`, `Search.Backend` and `Search.FullString` are read already, for
the methods of parts 2 and 3.)

**Headers.** Navidrome's own ([Sign-ins](#sign-ins)), the player's `Set-Cookie`, `X-Total-Count` on album lists, and
gzip when the client's `Accept-Encoding` names it, as Navidrome compresses every JSON answer. Debug builds add
`X-Sonus-Answered: rust`, which the tests read to know who answered; a release build (the image) does not send it.

Where it knowingly differs from Navidrome:

- **The random list** (`type=random`) is ordered by this server's own seed, kept per user in memory as Navidrome
  keeps its own: a new order whenever the list is asked for from its start, and the pages of one pass fit together.
  The order itself is another than Navidrome's would have been (both are random).
- **`contributors`** (a song's composers, performers, …) come sorted by role; Go lists the roles from a map, in
  another order every time.
- **Compression**: gzip at Navidrome's level, but another encoder's bytes (the same content); a client that takes
  `deflate` only gets the answer as it is.
- **Text that is not UTF-8** in the database is written with U+FFFD as the character itself; Go writes the escape
  `\ufffd`. The same JSON string.
- **Navidrome's paging shortcut** for offsets above 50,000 (`DevOffsetOptimize`: a `rowid NOT IN` subquery) is not
  taken: the plain OFFSET gives the same rows.
- **An error reading the database** hands the request to Navidrome instead of answering "Internal Server Error".

## Sonus Connect version 2

One playback session per user, as Spotify Connect has it: the protocol is `docs/protocol/connect.md`, and this server
is its first real implementation (`src/connect/`). Version 1, Navidrome's, stays beside it until every client has
moved: the two do not see each other.

| Request | |
|---|---|
| `rest/connect?protocol=2`, `rest/connect.view?protocol=2` (a WebSocket) | answered here |
| `rest/connect` without `protocol=2` | version 1: the sign-in is checked here, Navidrome answers, as any Subsonic method |
| `rest/getOpenSubsonicExtensions` | Navidrome's answer with this server's extensions merged in: `sonusConnect` is `[1, 2]`. Only that changes: the rest of the answer is Navidrome's bytes, in JSON, JSONP and XML (asked of Navidrome uncompressed, and answered uncompressed) |

- **The sign-in** is a Subsonic request's, in the query: `u` with `t`/`s` or `p`, or `apiKey`, plus `v` and `c`,
  checked by the same code as every Subsonic request (`Subsonic::sign_in`): app passwords, the two-step rule, the
  failed-attempt limiter with the same counts, and Navidrome's answers when it fails (error 10, 40, 43, 44 with HTTP
  200, and no WebSocket). A session token (`jwt`) and a trusted proxy's user header do not open it: 401, and the
  missing-parameter error. Signed in but not asking for a WebSocket: 426.
- **The session's logic** (`session.rs`, `queue.rs`) is a port of the protocol's reference,
  `tools/demo-server/connect-session.mjs`, statement by statement and pure: the clock, the random numbers and the
  library are handed in. `tests/connect_vectors.rs` replays `docs/protocol/connect-vectors.json` (14 cases, 157
  steps): the session, the queue, the devices and the direct replies after every step are exactly the file's.
- **The connection** (`socket.rs`): JSON text frames of at most 1 MiB (more: close 1009); `hello` first, within 10 s
  (else an error and close 1008); a ping every 30 s, and a connection silent for 75 s is cut; a second connection of
  the same device id replaces the first (4000); a user's 33rd device closes the one silent longest (4001); a close
  with 1000 or 1001 is a goodbye (the session stops at once if that device played), any other end a network loss
  (the 10 s grace period, and `resume`). When the server stops, connections are closed with 1001.
- **What a song is** (`now`, `durationMs`, whether an id exists) is read from Navidrome's `media_file`, read-only, as
  the session's user may see it: an admin every library, anyone else the libraries granted in `user_library`
  (Navidrome's `applyLibraryFilter`). `now.coverArt` is an id `getCoverArt` shows the song's picture for (the file's
  own, `mf-<id>`, else its disc's, `dc-<album>:<disc>`, else its album's, `al-<album>`), without the `_<hash>`
  Navidrome's own answers add for caches; the active device's `loaded` report replaces it.
- **Kept in the database** (`store.rs`), in two tables of this server's own in Navidrome's file, made at the first
  start: `sonus_server_schema (part, version)`, the version of each part of the Rust server's own schema (`connect`:
  1), and `sonus_connect_session (user_id, session, lists, updated_at)`, one row per user. A changed session is
  written within a second (700 ms after the change, several changes in one transaction) and when the server stops; a
  position report rewrites the small part (`session`), not the queue's lists. After a restart the session is back
  with no active device, paused at its position. A session nobody is connected to is only its row: it is read when
  the user's first device connects. A row this server cannot read (not what it wrote) starts an empty session;
  tables from a newer server (a higher version) stop the server at start, as a database of another schema does.
- **Navidrome beside it**: the tables are additive (`CREATE TABLE IF NOT EXISTS`, never `ALTER`), in the `sonus_`
  namespace Navidrome's migrations do not touch; the frozen Navidrome starts and runs on a database that has them
  (`tools/contract/gateway.test.mjs` restarts it on one), and this server's start-up check accepts them.

Where it knowingly differs from the reference (`connect-session.mjs`), none of it reached by the vectors:

- a `hello` must come within 10 s, and a user has at most 8 connections that have not said hello (one more is closed
  with 1013): the reference waits for a hello as long as the connection answers pings, without counting them;
- `mode` with an arranged `order` (shuffling by album or folder) keeps at most the first 10,000 songs the library
  has, the limit `connect.md` gives the context; the reference takes `order` whole there (`playContext` windows it);
- a device's name is cut to 80 UTF-16 units as in the reference, but never through the middle of a character;
- numbers shown inside an error's message (an unknown `mode` that is a number, say) are written as Rust writes them.

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
- `tests/auth.rs`: the `/auth` routes with a fake Navidrome that must never be asked: the cases of Navidrome's
  `server/auth_test.go` and the fork's `sonus_twofactor_test.go` and `core/twofactor/twofactor_test.go` (sign-in, the
  first admin, the setup at the first sign-in, a code at every sign-in and each once, recovery codes, app passwords,
  an admin's reset, optional and off, the browser sign-in from start to revoke), who is signed in (a token's user,
  epoch and audience; header, cookie, query; a trusted proxy's user; the development auto-login), 404 and 405 for
  everything else under `/auth`, the rate limit, eight first admins at once making one;
- unit tests of what they stand on: session tokens against ones Navidrome's own JWT stack signed (`tests/golden/`),
  authenticator codes against RFC 6238's vectors, the QR code, ids, the rate limiter's window arithmetic, JSON bodies
  decoded as Go decodes them;
- `tests/gateway.rs` also: the 4 MiB limit on bodies to `/api` and `/jellyfin`;
- `tests/library.rs`: the library's reads through the gateway, on a database with Navidrome's own tables
  (`tests/common/library.sql`: the statements of a database the fork made) and a fake Navidrome that registers players
  as the real one does: a song in Navidrome's bytes; that Navidrome sees a client's registration once a minute and
  nothing else of the requests answered here; everything that stays Navidrome's reaching it signed in and whole (XML,
  JSONP, `musicFolderId`, a transcoding player, an unknown content type, rows Go would read otherwise, no player);
  what a user sees (no library: nothing; an admin: everything; each their own stars and counts); every list type's
  order, paging, `X-Total-Count` and errors; the random list's pages; `EnableNaturalSorting`, `PreferSortTags`,
  `RecentlyAddedByModTime`, `AlbumPlayCountMode`, `Subsonic.EnableAverageRating`, the legacy and minimal clients, a
  player's `ReportRealPath`; gzip; the sign-in checked before anything is read;
- unit tests of the library's pure parts: Go's JSON (floats, strings, omitted fields), songs and albums against
  answers of the real Navidrome, cover art ids, made-up and real paths, `appendSuffix`, content types, the sort orders
  with every setting (the ORDER BY clauses Navidrome logs), squirrel's conditions, Go's `toSnakeCase`, the list
  filters and their errors, the natural collation (the cases of Navidrome's own test), the stored tags and
  participants, the player cookie;
- `tests/connect_vectors.rs`: the protocol's shared vectors (`docs/protocol/connect-vectors.json`) replayed on the
  session logic: 14 cases, 157 steps, each compared exactly;
- `tests/connect.rs`: Sonus Connect version 2 over its real WebSocket through the gateway, with a fake Navidrome that
  must never be asked: two devices on one session, a remote's commands, a transfer, volume; what a user may see (no
  library granted, an admin) and that nothing reaches another user's session; every way to sign in and every
  refusal, the limiter shared with plain Subsonic requests, a client's own user headers ignored; without
  `protocol=2` on to Navidrome; the extensions answer; hello first and in time; the 1 MiB limit; a second connection
  of the same device (4000); the 33rd device (4001) and the 8 waiting connections; pings and the silence timeout
  (with short times); the grace period, a resume taken and one refused, a goodbye; the session written within a
  second, the small part alone for a position, at shutdown, back after a restart, gone with its user; rows this
  server did not write; tables from a newer server;
- unit tests of the extension merge (JSON, JSONP, XML, lists it must leave alone) and of the stored session's parts;
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
node --test tools/contract/gateway.test.mjs           # the limiter, what Navidrome never sees, who answers the library, Connect across a restart
node --test tools/contract/auth-routes.test.mjs       # /auth on a new server, optional and off, rate limit, body limits
node tools/contract/web-ui.check.mjs                  # the old web UI, headless (Playwright), through this server
```

These start this server as its image runs it: `cargo run`, which starts Navidrome itself on a copy of the golden
database.

## Checked against the real Navidrome

### The library's reads (phase 3, part 1), 2026-11-25

On Windows on ARM (the fork's x64 binary, 0.64.2-sonus.10, `fb95b5ce`), this server started as its image starts it
(`cargo run`, a debug build, which marks its own answers), on copies of the golden database:

- `node tools/contract/diff.mjs --go-vs-gateway`: 249 of 249 the same as Navidrome alone, 124 of them answered by
  this server itself. The runner now checks who answered every request (`X-Sonus-Answered`): a method taken over
  must be answered here unless the corpus says why not, and nothing else may be. 80 requests were added for this
  part: every list type whole and paged, as three users (one who starred, rated and played nothing; the admin); the
  paging boundaries (the last page, the last album, past the end, sizes 0, -1, 1, 501 and not a number, offsets
  negative and not a number); `byYear` both ways round, one year, no album, every year; `byGenre` in another case,
  with LIKE's wildcards, unknown; every error; `.view` and form posts; no id, an empty id, the wrong kind of id; the
  legacy and minimal client names; XML, JSONP and `musicFolderId` staying Navidrome's. `X-Total-Count` is compared.
  With `corpus/writes.json`: 34 of 34.
- `node tools/contract/run.mjs --through-gateway`: 131 of 131 (two added: a random list's pages give every album
  once and another order on another pass; `X-Total-Count`), and 131 of 131 against Navidrome alone, 8 skipped there.
- `node --test tools/contract/gateway.test.mjs`: 7 of 7. New: with Navidrome's log at debug level, eight requests to
  the four methods (errors and a random list among them) are answered by this server with Navidrome's bytes and the
  player cookie's name, and none of them is in the log of the Navidrome behind it, which shows exactly one `ping` for
  the client (the registration) and the three requests left to it (XML, `musicFolderId`, another method); the
  player's row is the same as the one Navidrome alone makes, and the last access is written. And: a player's
  `ReportRealPath`, turned on in the database while the servers run, changes the next answer on both (on Windows this
  server leaves such a player's songs to Navidrome: checked that it does).
- `cargo test`: 231 tests (144 unit, 12 in `tests/library.rs`, 75 in the other integration tests).

Not checked: the image and Linux binaries beyond CI building them, so `ReportRealPath` answered here (Linux only) is
covered by unit tests and `tests/library.rs` on CI's Linux, not against the real Navidrome; the settings other than
the defaults against the real Navidrome (`tests/library.rs` and the unit tests check them against Navidrome's logged
SQL and its code); a library of production's size, and timings; a scan running while lists are read; the real
clients against this part (the Windows acceptance is run after part 3).

### Sonus Connect version 2 (phase 1), 2026-11-24

On Windows on ARM (the fork's x64 binary, 0.64.2-sonus.10), this server started as its image starts it:

- `node tools/contract/run.mjs --through-gateway`: 129 of 129, the 8 of `test/connect2.test.mjs` among them: the
  extension's versions; hello and welcome; a context played with ids from the library, the song filled in (`now`,
  `durationMs`, a `coverArt` that `getCoverArt` shows), the queue, a `loaded` report; a remote's seek, next, add and
  pause; reports only from the active device and only about the current song; a transfer; volume; refusals (`invalid`,
  `stale`, `offline`, `notActive`); hello first; a wrong password and no credentials; a second connection of the same
  device (4000); version 1 beside version 2, neither seeing the other's devices; a lost connection back within the
  grace period, the session stopping after the real 10 s, a resume, a goodbye stopping it at once; a second user's
  own session. The same 8 pass against the demo server, the protocol's reference (`run.mjs --demo connect2`), and
  are skipped for Navidrome alone, which lists version 1 only (`run.mjs`: 121 pass, 8 skipped).
- `node tools/contract/diff.mjs --go-vs-gateway`: 169 of 169 the same, and 34 of 34 with `corpus/writes.json`. The one
  answer that is meant to differ, `getOpenSubsonicExtensions` (`sonusConnect` `[1, 2]` here, `[1]` from Navidrome
  alone), is not hidden: the runner applies that one change to Navidrome's answer (`EXPECTED.connectVersion2` in
  `diff.mjs`) and then compares the whole list.
- `node --test tools/contract/gateway.test.mjs`: 5 of 5. The new one: the extensions answer in JSON, JSONP and XML is
  Navidrome's byte for byte but for the version; with two users' sessions changed, the server is killed 1.5 s later
  (nothing can be written at its end): the rows are there; the Rust server and Navidrome start again on that data
  folder, with the two extra tables in the database, without an error in either log, and Navidrome answers as
  before; both sessions are back as their users', with no active device, paused at their position, the queue and
  the hand-queued song as they were; the device that presses play continues it. (That a stopped server writes the
  last change is checked in `tests/connect.rs`, and in this test on systems with signals: Windows can only kill.)
- `node --test tools/contract/auth-routes.test.mjs`: 6 of 6, as before.

- **The Windows client against this server**: `node tools/e2e/acceptance.mjs --arch=ARM64 --only=signin,connect` with
  `SONUS_TEST_SERVER` pointing at this server in front of the frozen Navidrome (a library of 53 generated songs of
  one to two minutes, throwaway users, through the tests' recording proxy): 20 of 20, one skipped. The app saw
  version 2 in the extensions and used it. Two silent instances of the app on one account: both in the device list;
  the first plays and the second shows the same song, "正在「第一台」上播放" and the position moving, silent; the
  second's next, add to queue, pause and play steer the first; the device list's volume slider; "这台电脑" moves
  playback at the same song and position and stops the first; the first, now a remote, pauses and plays the second;
  the second pauses and closes: the session stays on the server ("上次在「第二台」播放"); the first presses play and
  continues it. Skipped: the network loss of over 10 s with a resume, which needs the demo server's hook that cuts
  one device's connection (that sequence is checked by `connect2.test.mjs` and `tests/connect.rs`).

Not checked here: the Android client against this server; the Windows app's other acceptance rounds against it
(they do not touch Connect); the 30 s ping and 75 s timeout at their real lengths (the tests shorten them; the grace
period's 10 s is checked at its real length); a real proxy in front of the WebSocket; many users or devices at once;
the image (CI builds it).

### The `/auth` routes (phase 2, part 2), 2026-11-24

Same machine, same Navidrome (0.64.2-sonus.10, `fb95b5ce`), started by this server on copies of the golden database
or on no database at all (a new server):

- `cargo test`: 168 tests (108 unit, 19 `/auth`, 24 Subsonic sign-in, 11 gateway, 6 with the real binary).
- `node tools/contract/run.mjs --through-gateway`: 121 of 121: the suite's 110 and 11 new ones for the web sign-in
  (`test/web-auth.test.mjs`), which also pass against Navidrome alone. Among them, tokens both ways: the session
  `/auth/login` gives here opens Navidrome's `/api`, and the token `/api` hands back opens `/auth` here.
- `node tools/contract/diff.mjs --go-vs-gateway`: 169 of 169 identical, and 34 of 34 with `corpus/writes.json`.
- `node --test tools/contract/auth-routes.test.mjs`: 6 of 6, each comparing Navidrome alone and this server step by
  step: a new server's first admin, then a password change through Navidrome's own API (Navidrome checks the current
  password, so it opened what this server sealed; it seals the new one, which this server then reads; the session
  made before is refused here: the epoch Navidrome bumped); the first admin with two-step verification required;
  optional (on and off again) and off; the per-address rate limit with its headers (3 in 6 s: the fourth is 429 on
  both, across routes); the 8 KB and 4 MiB body limits; and that with Navidrome's log at debug level no request under
  `/auth` reaches Navidrome.
- `node --test tools/contract/gateway.test.mjs`: 4 of 4, as before.
- `node tools/contract/web-ui.check.mjs`: the React UI in headless Chromium through this server, 11 of 11 (and 11 of
  11 against Navidrome alone, `--go`): the sign-in form refusing a wrong password; the first sign-in's setup (the
  secret, the QR code as a square picture, a code); the approval page after it, with the app's code and device;
  allow, and the app's key working; the key listed in Personal settings; the UI's own calls to `/api` all answered
  (none 401 or 403); refuse; a typed code; a code nobody waits for; the key given back; signing in again with a code.

Not checked: the image and Linux binaries beyond CI building them; `EnableGravatar` and `DevAutoLoginUsername` against
the real Navidrome (unit and integration tests only); a `BaseURL` with a path in front of the real Navidrome; a real
authenticator app scanning the QR code (the UI check reads the secret from the page; the code in the picture is
checked by a unit test for its size only); load.

### Sign-ins (phase 2, part 1), 2026-11-24

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
- `src/routes.rs`: which requests the gateway answers or checks itself. A new part of the server is a variant of
  `Local` there, its paths in `find`, an arm in `Gateway::handle`, and a module of its own.
- `src/subsonic/`: Subsonic sign-ins. `mod.rs`: what happens to a request; `credentials.rs`: whose the credentials
  are (the rule, and the queries); `limiter.rs`: failed attempts; `params.rs`: the query and the form, as Go reads
  them; `respond.rs`: the answers, as Navidrome writes them.
- `src/auth/`: the `/auth` routes. `mod.rs`: the routes and who is signed in; `store.rs`: users, two-step
  verification, recovery codes and app passwords in the database; `totp.rs`: authenticator codes and the QR code;
  `device.rs`: the sign-ins waiting for approval; `ratelimit.rs`: the per-address limit.
- `src/connect/`: Sonus Connect version 2. `session.rs`, `queue.rs`: the protocol's logic, pure; `mod.rs`: a room per
  user, and the upgrade; `socket.rs`: one connection; `store.rs`: the session in the database, and the library as a
  user sees it; `extensions.rs`: the merge into `getOpenSubsonicExtensions`.
- `src/library/`: the library's reads. `mod.rs`: what is answered here and what goes on to Navidrome; `browse.rs`: the
  methods; `query.rs`: Navidrome's queries; `entities.rs`: albums and songs as its JSON; `json.rs`: Go's JSON;
  `player.rs`: the player, registered by Navidrome; `natural.rs`: the `NATSORT` collation.
- `src/jwt.rs`: session tokens; `src/id.rs`: ids and the random strings people type.
- `src/db.rs`: Navidrome's database; `src/gotime.rs`: its timestamps; `src/secrets.rs`: its encryption.
- `src/startup.rs`: what must hold before anything is answered here.
- `src/supervisor.rs`: runs Navidrome.
- `src/main.rs`: puts them together; stops on SIGTERM / Ctrl+C.
- `scripts/check-real-navidrome.mjs`: the phase 0 check above.
- `examples/seal.rs`, `tests/golden/`: checking the encryption against Navidrome's own code.

Code ported from Navidrome's (the sign-in rule, the limiter, the encryption, the library's queries and answers) is a derived work of Navidrome
(GPL-3.0) and says so in its header; GPL-3.0 and AGPL-3.0 combine (section 13 of both). Sonus Connect is Sonus's own:
written from its protocol and its reference implementation in this repository.

The WebSocket's framing is `tokio-tungstenite` (tungstenite): the WebSocket library most Rust servers stand on (axum
and warp among them), maintained, and usable on the connection hyper hands over after an upgrade without a framework
around it. It is built without its handshake, client and TLS features: the gateway answers the upgrade itself (it has
SHA-1 and base64 already), so the dependency adds framing, masking, UTF-8 and size checks and nothing else.

Compression of the library's answers is `flate2` with its default pure-Rust backend (`miniz_oxide`): the gzip
library of the Rust ecosystem, maintained by the Rust project's own contributors; no C is added to the build.

`rustfmt.toml` keeps the width the code is written to (160).
