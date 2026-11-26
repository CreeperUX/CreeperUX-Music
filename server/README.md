# Sonus server

The Sonus music server, in Rust (AGPL-3.0, `LICENSE`). A gateway: it listens where Navidrome used to, runs the
CreeperUX fork of Navidrome (frozen at 0.64.2) behind it on a local port, and passes requests through, streamed both
ways, WebSockets included. Parts of the server move here one by one behind the same APIs; the route, with the
decisions behind it, is `docs/server-roadmap.md`.

Status: phase 0's gateway, phase 2: **Subsonic sign-ins are checked here** ([below](#sign-ins)) and **the `/auth`
routes are answered here** ([below](#the-auth-routes): the web sign-in with two-step verification, app passwords, the
browser sign-in for apps), on Navidrome's own database, which the server opens beside Navidrome; and phase 1:
**Sonus Connect version 2 is answered here** ([below](#sonus-connect-version-2): one playback session per user, kept
in the database); and phase 3: **the library's reads `ping`, `getSong`, `getAlbum`, `getAlbumList2`, `search3`,
`getStarred2`, `getPlaylists`, `getPlaylist`, `getPlayQueue`, `getLyricsBySongId` and `getCoverArt` are answered
here** from Navidrome's database and what it has stored on disk ([below](#the-librarys-reads)). Everything else is still Navidrome's. It reads
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
  old name `SearchFullString`), `SmartPlaylistRefreshDelay`, `LyricsPriority`, `CoverArtQuality` (and its old name
  `CoverJpegQuality`), `EnableWebPEncoding`, `ImageCacheSize`, `CacheFolder`.

| Setting | Default | |
|---|---|---|
| `Address`, `Port` (`ND_ADDRESS`, `ND_PORT`) | `0.0.0.0`, `4533` | where clients connect: the gateway takes Navidrome's place |
| `ExtAuth.TrustedSources` (`ND_EXTAUTH_TRUSTEDSOURCES`) | none | the proxies in front whose `X-Forwarded-For` is believed (CIDR entries only, `src/trust.rs`). Set it behind a reverse proxy, or every client has the proxy's address and shares its sign-in limits. `True-Client-IP` and `X-Real-IP` are not believed (Navidrome believes them first): the proxy must send `X-Forwarded-For` |
| `ExtAuth.UserHeader` (`ND_EXTAUTH_USERHEADER`) | none (Navidrome: `Remote-User`) | a header in which those proxies name the signed-in user, who then needs no password. Only for a proxy that authenticates users itself and overwrites this header on every request; unset, empty or `none`: no header signs anyone in |
| `DataFolder`, `DbPath` (`ND_DATAFOLDER`, `ND_DBPATH`) | `.`, `navidrome.db` in the data folder | Navidrome's database, which the server opens too (`DbPath`: a path, optionally after `file:` and before `?options`) |
| `PasswordEncryptionKey` (`ND_PASSWORDENCRYPTIONKEY`) | Navidrome's built-in key | what stored passwords and app passwords are encrypted with; never logged |
| `AuthRequestLimit`, `AuthWindowLength` | `5`, `20s` | failed Subsonic sign-ins allowed per address and user in a window, and requests to the sign-in routes under `/auth` per address; `0` turns both limits off |
| `SessionTimeout` (`ND_SESSIONTIMEOUT`) | `48h` | how long a web session's token is good; Navidrome renews it at every use of its API |
| `Sonus.TwoFactor` (`ND_SONUS_TWOFACTOR`) | `required` | which account passwords sign the Subsonic API: `required`, none (app passwords and API keys only); `optional`, those of users who have not set two-step verification up; `off`, all |
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
| `u` with the account password, where `Sonus.TwoFactor` is `required` (any user, two-step verification set up or not), or `optional` for a user who has set it up | error 40, as a wrong password: only an app password or an API key signs |
| `apiKey` with `u`, `p`, `t`, `s` or `jwt` | error 43, answered here |
| an `apiKey` that is no one's | error 44, answered here |
| too many failures from this address (`AuthRequestLimit` in `AuthWindowLength`) | error 40 (or 44 for keys), right credentials included |
| right credentials: the account password where it signs (`off`; `optional` for a user without two-step verification) as `p`, `p=enc:<hex>` or `t`+`s`; an app password the same three ways, with or without its dashes; an API key | goes on to Navidrome **without** `p`, `t`, `s`, `apiKey`, with the user named in the header only the gateway sets ([What Navidrome is told](#what-navidrome-is-told)); `tokenInfo` is answered here |
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

- **Where two-step verification is required, no account password signs the API**, whether or not its user has set
  two-step verification up (`credentials::password_alone`). The fork took the account password of a user who had not
  set it up yet, so that clients kept working until then; here such a user's password gets what the web sign-in
  gives it, a set-up token, and nothing on the API, Sonus Connect included (it opens with the same check). The
  answer is error 40 with the wrong-password text, and counts against the limiter as one, so from outside a user
  who has set it up, one who has not, and a wrong password look alike. What such a user does: sign in on the web,
  set two-step verification up with the enrolment code, and give each player an app password (the web client and
  the apps' browser sign-in do this by themselves). An app password or API key the account already has keeps
  working. `optional` and `off` are as they were.
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
`sonus_twofactor.go` and `sonus_device.go` answer it: the same JSON, status codes and messages, except where this
server asks for more on purpose ("Codes a session alone does not replace", below).

| Route | |
|---|---|
| `POST /auth/login` | the password, then per `Sonus.TwoFactor`: a code (`otp`: from the authenticator, each once, or a recovery code), or for a user who has not set it up while it is required, a setup token instead of a session (`"twoFactor": "setup"`, with `enrolmentCodeRequired`). With `appPassword` (a name), a sign-in that succeeds also makes an app password and answers it as `newAppPassword` |
| `POST /auth/createAdmin` | the first user, an admin, only while there is none (the count and the insert are one transaction) |
| `POST /auth/2fa/setup`, `/2fa/confirm` | a new authenticator secret with its `otpauth://` link and QR code (a PNG), then a code from it: recovery codes, and a session. A first set-up while two-step verification is required takes `enrolmentCode` in both |
| `GET /auth/2fa`, `POST /2fa/recovery-codes`, `/2fa/disable` | the user's own: status, new recovery codes (takes a code), turning it off (takes a code; refused while required) |
| `GET`, `POST /auth/app-passwords`, `DELETE /app-passwords/{id}` | app passwords: listed, made (shown once; takes `code`), revoked |
| `GET /auth/2fa/users/{id}`, `POST /2fa/users/{id}/reset`, `/enrolment-code` | admins: someone's status (and when an enrolment code that waits for them runs out), a reset for a lost phone, a new enrolment code (both take the admin's `code` and answer `{enrolmentCode, expiresAt}`) |
| `POST /auth/device/start`, `/device/poll`, `/device/revoke` | the browser sign-in, the app's side: ask, poll (the API key is handed over once), give the key back |
| `GET /auth/device/{code}`, `POST /device/{code}/approve`, `/deny` | the approval page's side, signed in: what asks (`client`, `device`, the `address` it came from, `codeRequired`), then allow (takes `code`) or refuse |
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
- **Sign-ins waiting for approval** live in this process's memory (ten minutes each; five per address and 2000 in
  all, the oldest unapproved giving way): a restart drops them and the app asks again.
- **What is written**: a user's `last_login_at`; the first admin (as Navidrome's user repository writes a new user,
  with every library); the two-step verification rows and app passwords, in the fork's tables and formats; and
  enrolment codes, in a table of this server's own (`sonus_enrolment_code`, versioned in `sonus_server_schema` as
  Sonus Connect's: Navidrome's tables are not altered).

### Codes a session alone does not replace

Decided after the security review of 2026-11-24 (`docs/security-review-2026-11-24.md`, "Weaknesses by design").
These are this server's own rules: the frozen Navidrome has none of them, and its routes read past the extra fields.

**An enrolment code for a first set-up.** With `Sonus.TwoFactor=required`, the password of an account that has no
two-step verification yet gets a setup token, as before, but the token sets nothing up by itself: `POST
/auth/2fa/setup` and `/2fa/confirm` also take the account's `enrolmentCode` (401 with `"twoFactor": "enrolment"`
without it). So whoever learns a new user's password first cannot enrol their own authenticator and lock the owner out.

- An admin makes the code and hands it over with the password: `POST /auth/2fa/users/{id}/enrolment-code`, or the
  answer of a reset. Both answer `{"enrolmentCode": "abcd-efgh-jkmn", "expiresAt": …}` once; the server keeps only
  a hash. In the old web UI it is on the user's page ("Make an enrolment code").
- It works **once, for seven days**: long enough to reach a family member by hand. A new code for the same user
  replaces the earlier one; the confirmation of the set-up uses it up (in the same transaction as the set-up, so one
  code enrols one authenticator).
- **Ten wrong enrolment codes for an account in an hour**, from anywhere, and none is looked at for the rest of the
  hour (429), the right one neither: the code has 12 characters of 31 (about 59 bits) and cannot be guessed at that
  rate. As with verification codes, someone who has the password can keep the owner's set-up refused this way.
- **Users made through Navidrome's own API** (`/api/user`, the old web UI's "new user") get none automatically:
  Navidrome knows nothing of these codes. The admin makes one on the user's page afterwards.
- **Users who were there before** and never set two-step verification up need one too: their password gets them the
  setup token and no further until an admin makes them a code. Users who are set up notice nothing.
- **The first admin** has nobody to get a code from. The setup token that `createAdmin` answers (15 minutes, for
  the account just made, `enrolmentCodeRequired: false`) sets up without one. After those minutes, or signing in
  again with the password, a code is needed like for anyone else: see the command line, next.
- **When no admin can make one** (the first admin missed those minutes; the only admin lost the authenticator and
  the recovery codes): whoever runs the server makes it on its command line, with the server's own settings (the
  same environment, config file and flags), beside the running server:

  ```sh
  sonus-server enrolment-code <user name>            # prints a code for a user without two-step verification
  sonus-server enrolment-code <user name> --reset    # removes the user's two-step verification first
  docker exec <container> /app/sonus-server enrolment-code <user name>     # in the image
  ```

  It asks for no credentials: whoever can run it can read and write the database file anyway.
- **`optional` and `off`**: no enrolment codes. With `optional`, whoever is signed in turns two-step verification
  on for themselves, as before; the admin routes answer 409 and a reset answers 204 as it did.

**A verification code for what outlives the session.** For an account that has two-step verification, a session is
not enough for these three; each takes `code` (from the authenticator, or a recovery code) and answers 401 with
`"twoFactor": "code"` without a right one:

- `POST /auth/device/{code}/approve`: allowing an app hands it a permanent key. `GET /auth/device/{code}` tells
  the page `codeRequired`, and the `address` the request came from, to show beside the app's and device's names
  (which are whatever the asker sent). Refusing takes no code.
- `POST /auth/app-passwords`: an app password is a permanent key that skips two-step verification.
- `POST /auth/2fa/users/{id}/reset` and `/enrolment-code`: the admin's own code, so that an admin's session is not
  worth every account's second step.

Wrong codes on these routes count against the account with the sign-in's (ten in an hour, then 429 for all of
them). An account without two-step verification (`off`, or `optional` and not set up) does all three as before.

A client that signs in with the password and a code and then keeps an app password of its own (the web client)
would need two codes thirty seconds apart: so a sign-in can ask for the app password in the same request
(`"appPassword": "<name>"` on `POST /auth/login` and `/2fa/confirm`; answered as `newAppPassword`, in the shape `POST
/auth/app-passwords` answers). Password and code were both checked by that very request.

**For the owner at every new device**: allowing the app in the browser now also asks for the six digits from the
authenticator. **Deployment order**: the old web UI learns to ask in `ghcr.io/creeperux/navidrome` 0.64.2-sonus.11;
an older UI behind this server cannot allow apps for accounts with two-step verification (it sends no code).

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
between requests:

| Method | |
|---|---|
| `ping` | the envelope alone, once the player is registered (below) |
| `getSong` | a song with the signed-in user's star, rating, play count and bookmark; 70 `Song not found` (also without an id) |
| `getAlbum` | an album and its songs in disc and track order; 70 `Album not found` |
| `getAlbumList2` | every `type`: `alphabeticalByName`, `alphabeticalByArtist`, `newest`, `recent`, `frequent`, `starred`, `highest`, `byYear` (`fromYear` > `toYear`: newest first), `byGenre`, `random`; `size` (10; at most 500; 0 or less: everything), `offset`; `X-Total-Count`; 10 for a missing `type`, `genre`, `fromYear` or `toYear`, 0 for a year that is not a number or an unknown type, in Navidrome's words |
| `search3` | nothing typed (`query=` empty, missing, `""` or `*`) lists everything in the tables' own order, paged by `songCount`/`songOffset` and the like: how Sonus clients read the whole library; words go through FTS5 with Navidrome's query building and BM25 ranking; Chinese, Japanese and Korean text, and text FTS5 would lose (`1+`, `!!!`), through LIKE; a MusicBrainz id is looked up as one; one character finds nothing; a count of 0 asks for none of that kind |
| `getStarred2` | the artists, albums and songs the user starred, the latest first |
| `getPlaylists` | the user's playlists and everyone's public ones (an admin: all), by name; smart playlists as they were last filled, with `validUntil` |
| `getPlaylist` | a plain playlist with its songs in order (the ones that are still there, counted and timed anew); 10 without an id, 70 `playlist not found` (someone else's private one too) |
| `getPlayQueue` | the saved queue with its songs, the current one and the position; the user's name and a zero time when none is saved |
| `getLyricsBySongId` | the lyrics Navidrome read from the song's tags when it scanned (the song's row), with their line times, language and offset; an empty list for a song without any; 10 without an id, 70 `data not found` |
| `getCoverArt` | a picture Navidrome has settled (below): as it is, or resized once Navidrome has resized it; `ETag`, `Last-Modified`, `Cache-Control` (kept for good when asked for by its hash), 304 for what the client has |
| `getScanStatus` | **not answered here**: whether a scan runs, and how far it is, are in Navidrome's memory, not in the database. It goes to Navidrome until the scanner moves (phase 7) |

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
| `getPlaylist` of a smart playlist | Navidrome fills a smart playlist anew when it is read (after its refresh delay, for its owner): a write, with the rules' translation into SQL, which stays Navidrome's |
| `getPlaylists` when a smart playlist has a refresh delay of its own, or rules Navidrome's decoder would refuse | its `validUntil`, or Navidrome's error, is Navidrome's to make |
| `search3` or `getStarred2` that would show an artist with a picture, or one whose picture is not resolved yet | such an artist carries `artistImageUrl`, a public link signed with a secret this server does not read. No Sonus client reads that field, so it is not made here (decided 2026-11-25): these searches stay Navidrome's, and the field goes when Navidrome is retired. A search that asks for no artists (`artistCount=0`, as the clients' library sync does) is not touched by this |
| `getLyricsBySongId` of a song with a lyrics file beside it (`.lrc`, `.ttml`, … in `LyricsPriority`, before `embedded`), with a plugin as a source, or with `enhanced=true` | Navidrome reads and parses such a file at every request; enhanced lyrics (other kinds, word timings) are not something Sonus clients ask for |
| `getCoverArt` of a disc (`dc-…`), of a song or album without artwork state yet, of an item known to have no picture, of an id without its kind | a disc's cover is found by a walk through the album's folders at every request; a picture without state is looked for (and noted: a write); no picture is Navidrome's placeholder |
| `getCoverArt` resized, the first time for that picture and size | resizing and its cache are Navidrome's (phase 5); from the second time on the cached picture is served here |
| `getCoverArt` when the picture's file changed since Navidrome hashed it, or is not where the state says | Navidrome looks again, and corrects its state |
| `search3` with `Search.Backend = legacy` or `Search.FullString` on | Navidrome's older search over another column |
| comes from a player with a transcoding set | songs then carry `transcodedSuffix` and a content type from Go's tables |
| comes from a player with `ReportRealPath`, on Windows | Go builds the path by Windows' rules there; on Linux (the image) it is answered here |
| would show a song whose suffix is not in Navidrome's own list of types (`resources/mime_types.yaml`) | Go asks the operating system for its content type |
| names a parameter that is not UTF-8 text, or a row holds JSON this server does not read as Go's decoders do (a participant's role Navidrome does not know, …) | Navidrome's answer, error or not, is its own |
| could not be read from the database, or Navidrome registered no player for it, or its user is gone | Navidrome answers, or fails, as it would |

**Covers.** A cover is served here when Navidrome's artwork state names its picture (`item_artwork`, with the
picture's row in `artwork`), the item is there for this user, and the bytes are where that state says
(`media.rs`): the picture's own file (a cover in a folder, an uploaded one), read only while its change time is the
one Navidrome noted when it hashed it; or Navidrome's image store (`<DataFolder>/artwork/hashed/`, for pictures taken
out of audio files or made by Navidrome); or, for a resized cover, Navidrome's cache of resized pictures
(`<CacheFolder>/images/`), under the key Navidrome caches it by (the hash, the size, square or not, and
`CoverArtQuality` / `EnableWebPEncoding`), and only an entry Navidrome has marked complete. The answer is Navidrome's:
the content type named from the bytes as Go names it, no length (Navidrome streams: the body is chunked), the
picture's hash as `ETag` (a resized one has a validator of its own), the state's time as `Last-Modified`,
`Cache-Control: public, max-age=31536000, immutable` when the id asked for carries the picture's current hash and
`public, no-cache` otherwise, and 304 for a matching `If-None-Match`. No player is registered for a cover, as in
Navidrome. A read from Navidrome's cache does not tell Navidrome the entry was used: when the cache is full, Navidrome
may drop an entry sooner than it would have, and make it again when asked.

**The player.** Navidrome registers a player for every Subsonic request: it finds it by the `nd-player-…` cookie (when
that player is this user's and this client's), else by user, client name (`c`) and the browser it reads from
`User-Agent` (the useragent library's name and OS: `useragent.rs`), else makes one; it writes the player's name,
browser, address and last-seen time at most once a minute, and answers with the cookie. A player's settings change a
song and a stream (`ReportRealPath`, a forced transcoding, `MaxBitRate`). Since phase 5, part 4 the same registration
is made here (`player.rs`) for the requests answered here, by Navidrome's rules, every column as Navidrome's `Put`
writes it, the cookie named after the user name as the request carries it; Navidrome sees nothing of those requests,
not even a `ping`. The player's row is read again at every request. Requests left to Navidrome are registered by
Navidrome, as always: the two write the same rows by the same rules.

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
| `Subsonic.ArtistParticipations` | off | an artist's `albumCount`: the albums they are album artist of, or also those they only appear on |
| `SmartPlaylistRefreshDelay` | `5s` | a smart playlist's `validUntil` |
| `LyricsPriority` | `.ttml,.yaml,.yml,.elrc,.lrc,.srt,.txt,embedded` | which lyrics files beside a song come before the lyrics in its tags (a song with one is Navidrome's) |
| `CoverArtQuality`, `EnableWebPEncoding`, `ImageCacheSize`, `CacheFolder` | `75`, off, `100MB`, `cache` in the data folder | where a resized cover is in Navidrome's cache, and whether there is one (`0`: none) |
| `Search.Backend`, `Search.FullString` | `fts`, off | `legacy` or on: `search3` goes to Navidrome |
| `Subsonic.DefaultReportRealPath` | off | nothing here: Navidrome gives it to a new player, and the player's own setting is what is read |

(`IgnoredArticles` is read and changes nothing yet: Navidrome applies it when it scans, and in `getArtists`, which is
not answered here.)

**Headers.** Navidrome's own ([Sign-ins](#sign-ins)), the player's `Set-Cookie`, `X-Total-Count` on album lists, and
gzip when the client's `Accept-Encoding` names it, as Navidrome compresses every JSON answer. Debug builds add
`X-Sonus-Answered: rust`, which the tests read to know who answered; a release build (the image) does not send it.

Where it knowingly differs from Navidrome:

- **The random list** (`type=random`) is ordered by this server's own seed, kept per user in memory as Navidrome
  keeps its own: a new order whenever the list is asked for from its start, and the pages of one pass fit together.
  The order itself is another than Navidrome's would have been (both are random).
- **`contributors`** (a song's composers, performers, …) and an artist's **`roles`** come sorted by role; Go lists the
  roles from a map, in another order every time.
- **A cover is read into memory** before it is sent (at most 64 MiB; a larger one is Navidrome's to stream), and a
  resized cover read from Navidrome's cache does not count as a use in Navidrome's own bookkeeping of that cache.
- **A search whose query fails in SQLite** (none was found: Navidrome's query building is what guards FTS5's syntax,
  and it is ported with its tests) would go to Navidrome, which logs the error and answers with empty lists.
- **Compression**: gzip at Navidrome's level, but another encoder's bytes (the same content); a client that takes
  `deflate` only gets the answer as it is.
- **Text that is not UTF-8** in the database is written with U+FFFD as the character itself; Go writes the escape
  `\ufffd`. The same JSON string.
- **Navidrome's paging shortcut** for offsets above 50,000 (`DevOffsetOptimize`: a `rowid NOT IN` subquery) is not
  taken: the plain OFFSET gives the same rows.
- **An error reading the database** hands the request to Navidrome instead of answering "Internal Server Error".

## The library's writes

`src/library/writes.rs` and `src/library/playing.rs` (roadmap, phase 4; part 1: stars, ratings and the play queue; part 2:
playlists; part 3: plays and what is playing now). Answered here, in JSON, as a
GET or a form post, also as `.view`, and written to Navidrome's tables as Navidrome writes them, so that either server
reads them back the same:

| Method | |
|---|---|
| `star`, `unstar` | every `id`, `albumId` and `artistId`, taken together; each looked up as Navidrome's `GetEntityByID` does it (artist, album, playlist, song, radio station, as the user sees them: a radio station's star is kept as a song's, as in Navidrome), one nobody sees skipped; the user's `annotation` row updated, else inserted, with `starred` and `starred_at` (also set when unstarring); 10 `Required id parameter is missing` |
| `setRating` | the user's `rating` and `rated_at`, then the item's `average_rating` over every user's rating above 0, rounded to two places; any integer kept as given, as Navidrome keeps it; 10 without `id` or `rating`, 0 for a rating that is not a number, 70 `data not found` for an item the user does not see |
| `savePlayQueue` | the user's queue replaced: `items` the ids as given, joined by commas (not checked, as in Navidrome), `current` the index of the first `current` among them (else 0), `position` (0 when it is not a number), `changed_by` the client's name; a queue saved again keeps its id, and its `created_at` becomes Go's zero time, as Navidrome writes it then; no ids: no queue |
| `createPlaylist` | a new playlist named `name` (new id, owner the user, created now) with the `songId`s, or with `playlistId` that playlist's songs replaced (no songs given: its songs stay, as in Navidrome; a `name` is then not used); a song id the user cannot read is left out (one who sees every library: kept as given, unchecked, as Navidrome keeps it); tracks numbered 1, 2, …; the counters (`song_count`, `duration`, `size`: what is there, through float32s as Navidrome reads them) and `updated_at` written anew; the cover queued for Navidrome's artwork worker; answered with the playlist as `getPlaylist` answers; 0 `Internal Server Error: required parameter name is missing`, 70 for one the user does not see, 50 for someone else's (an admin may change anyone's) or one kept in sync with a file |
| `updatePlaylist` | `songIndexToRemove` (0-based; out of range or not a number: nothing) removed and the rest numbered 1, 2, … again, then `songIdToAdd` appended after the last, then `name` (empty: unchanged), `comment` (given empty: emptied) and `public` (`true`, `on`, `1`, in any case) written back with every other column, as Navidrome's `Put` does; the cover queued when the songs changed; 10 without `playlistId`, 70, 50 as above |
| `deletePlaylist` | the playlist and, through the database's own cascade, its tracks; 10 without `id`, 70, 50 as above |
| `scrobble` | with `submission` (the default; `true`, `on`, `1`), a play of each `id` the user sees, at its `time` (ms, local time; now, with the clock's full precision, without one or for one that is not a number): one more play of the song, its album and every artist of its `artist` role, the last play the later one (compared as text, as Navidrome's SQL does), and with `EnableScrobbleHistory` (on by default) a `scrobbles` row in whole seconds; a song nobody sees is skipped; without `submission`, the first `id` playing now at `position` (s); 10 without an id, 0 `Wrong number of timestamps: …` |
| `reportPlayback` | Navidrome's playback states: `starting` (a late one does not undo `playing`), `playing` and `paused` (the session goes on for the same song; it ends a song's length later at its rate, plus 5 s, or 30 minutes after a pause), `stopped` (a play when the position is past half the song, at most 4 minutes, the player sends plays on, `ignoreScrobble` is not set; a late stop for an earlier song ends nothing); sessions kept per player, or per web UI tab (`X-ND-Client-Unique-Id`); Navidrome's errors for every parameter |
| `getNowPlaying` | the sessions in the libraries the user sees, the latest started first, `minutesAgo` from the start, the position of what plays estimated from its last report and rate (at most the song's length), `playerId` the entry's place, `playerName` the client |

- **One transaction per request** (`BEGIN IMMEDIATE`), as Navidrome's `star` is; its `setRating` and `savePlayQueue`
  are two or three statements of their own there, with the same end state. A write waits for Navidrome's write lock
  (a scan) up to the 15 s busy timeout Navidrome's connections have; an error, or a request this server leaves to
  Navidrome after all, is rolled back and Navidrome then makes the whole write.
- **Times** are written as Navidrome's driver writes a Go `time.Time`, in the server's local time zone (`gotime.rs`).
- **Navidrome caches none of these tables** (its persistence layer caches only library paths), so a write made by
  either server is read by the other at once: `tools/contract/writes.test.mjs` checks it both ways, through
  Navidrome's web UI API too.
- **Navidrome's web UI is not told.** Navidrome sends its web UI a `refreshResource` event on a star or a rating; a
  write made here sends none, so an open old web UI shows it once it reloads the item (decision 2 of the roadmap).
- **A player's settings do not matter to a write** (its answer has no song in it): a player with a transcoding set,
  which keeps the reads with Navidrome, does not keep the writes there.
- **A playlist's cover** is made by Navidrome's artwork worker, which polls its queue every 5 s: a change to a
  playlist's songs queues it there, as Navidrome's own change does, and the new cover (and its id in answers) shows a
  few seconds later. Navidrome picks the grid's albums at random, so two servers (or two runs) make different covers.
- **Smart playlists stay Navidrome's** (any write to one: Navidrome writes its rules back as it marshals them, and
  leaves its counters to the next evaluation), and so does deleting a playlist with an uploaded cover (Navidrome
  removes the file).
- **What is playing now is kept here** (`playing.rs`), in memory, as Navidrome kept it in its own: `scrobble`
  without `submission`, `reportPlayback` and `getNowPlaying` moved together (roadmap principle 2). `reportPlayback` is
  taken although no Sonus client sends it: Navidrome's own web UI reports its playback with it, and left with
  Navidrome its sessions would have been missing from `getNowPlaying`, which its "now playing" panel reads. A
  restart of the server forgets what was playing, as a restart of Navidrome did.
- **Plays are no longer sent on** (decision 3): Navidrome never sees a play or a "now playing" any more, so nothing
  reaches Last.fm, ListenBrainz or its plugins; their port, and the buffer for them, are not made.
  `writes.test.mjs` checks Navidrome's debug log and its buffer table. Plays still buffered in Navidrome from before
  are its own to send or drop.
- **Navidrome's web UI**: its now-playing count comes over its event stream, from Navidrome, which now has no
  sessions, so the badge no longer updates by itself; opening the panel reads `getNowPlaying` (answered here) and
  shows the right list and count (decision 2).
- **Player registration** moved here with the streams (phase 5, part 4: under the reads, "The player").
- **Not the same as Navidrome**: an answer to a request carrying `X-ND-Client-Unique-Id` does not set that header's
  cookie (Navidrome's middleware does, for its web UI's later requests without the header; every request of its web
  UI carries the header); `getNowPlaying` from a player with a transcoding set goes to Navidrome, which has no
  sessions (no Sonus client asks for it).
- **Still Navidrome's:** `savePlayQueueByIndex`, `getPlayQueueByIndex` and bookmarks (no Sonus client sends them).

## Media

The roadmap's phase 5: the songs' files, transcoding, covers, players, and the R2 mirror, in parts.

**Part 1: songs' files as they are** (`src/library/stream.rs`). `stream` sends a song's file as Navidrome sends a
"raw" stream (`server/subsonic/stream.go`, `core/stream`): Go's `http.ServeContent`, ported, with the song's
`updated_at` as the file's time.

| | As Navidrome |
|---|---|
| Which song | the id looked up as `getSong` does, as the signed-in user: unknown or in a library they are not granted, 70 `data not found`; no id, 10 |
| Raw or not | `format=raw` is raw for any player; otherwise as Navidrome's decision (part 2, below) |
| Answer | 200 with `Content-Type` (by the suffix, Navidrome's table), `Content-Length`, `Accept-Ranges: bytes`, `Last-Modified` (the song's `updated_at`, none for Go's zero time or the epoch), `X-Content-Duration` (the duration as Go writes a `float32`), Navidrome's usual headers and the player's cookie; never compressed |
| `Range` | one range: 206 with `Content-Range`; past the end: 416 `invalid range: failed to overlap` with `Content-Range: bytes */size`; malformed: 416 `invalid range`; ranges adding up to more than the file: the whole file |
| Conditions | `If-Match`, `If-Unmodified-Since` (412), `If-None-Match`, `If-Modified-Since` (304), `If-Range` (a range only for the same time to the second; an entity tag never matches, as Navidrome sends none); the three date layouts of Go's `http.ParseTime` |
| `HEAD` | the headers with the length, no body; other methods (a form post) the body, and 412 instead of 304 |
| `timeOffset` | ignored for a raw stream, as by Navidrome |
| Formats | the same file whatever `f` names; an error asked for in another format than JSON is Navidrome's |

**Part 2: transcoding** (`src/library/transcode.rs`, `src/library/transcoder.rs`). The decision is Navidrome's legacy
path, ported with its tests (`legacy_client.go`, `decider.go`): a `format` (an unknown one falls back to
`DefaultDownsamplingFormat`, then to the file as it is), a `maxBitRate` below the song's, the player's `MaxBitRate`, or
the player's forced transcoding; the source as stored probe data has it, else as the scanner read it; lossless to lossy
at the client's (else the format's default) bit rate, lossy keeping its own, never lossy to lossless; opus at 48 kHz,
mp3 at most 48 kHz and two channels, aac at most 96 kHz, DSD at an eighth of its rate and 24-bit. ffmpeg gets
Navidrome's own arguments (`buildDynamicArgs`: `-map 0:a:0`, both `-map_metadata`, the codec, `-b:a`, `-ar`, `-ac`,
`-sample_fmt` for flac, `-v 0`, the container), so the same ffmpeg writes the same bytes; a FLAC output gets the total
sample count ffmpeg leaves out on a pipe, as Navidrome writes it in.

| | As Navidrome |
|---|---|
| Not cached yet | 200, `Accept-Ranges: none`, the format's `Content-Type`, `X-Content-Duration`, no length (`estimateContentLength=true`: Navidrome's estimate), the bytes as ffmpeg writes them; `HEAD`: the headers, and the transcode goes on into the cache |
| Cached | the finished entry served like the song's own file: length, ranges, conditions, `Last-Modified` the song's |
| Caps | Navidrome's `Transcoding.MaxConcurrent`/`MaxConcurrentPerUser`: 429, `Retry-After: 5`, error 0 `too many concurrent transcodes, please retry shortly`; this server's own: at most 16 ffmpeg processes |
| ffmpeg fails before its first byte | Navidrome's to answer (its error names the path) |
| ffmpeg fails later | the answer ends short, as Navidrome's |

The transcoding cache is this server's own (the roadmap: "转码缓存用自己的文件夹"): `<CacheFolder>/sonus-transcoding`,
`TranscodingCacheSize` (default `100MB`, `0`: none), the least recently used entries dropped first. Navidrome's own
cache (`<CacheFolder>/transcoding`) is no longer filled by Sonus clients and ages out as before. Bounds and the
protection of the command line: `SECURITY.md`, "Media: transcoding".

**Part 3a: covers resized here, and placeholders** (`src/library/resize.rs`, `src/library/media.rs`). Until now a size
Navidrome had not resized yet was Navidrome's; now it is resized here as Navidrome resizes (`core/artwork/resize.go`):
fitted into the size asked for (never enlarged; above the picture's size, the original under the resized validator),
or centered on a transparent square canvas; Catmull-Rom; PNG for a PNG source or a square, else JPEG at
`CoverArtQuality`. The validator, `Last-Modified`, `Cache-Control` and 304s are Navidrome's (they name the
representation, not the encoder's bytes). Navidrome's cache of resized covers is still read first; what is resized
here is kept in `<CacheFolder>/sonus-images` (`ImageCacheSize`). Limits: `MaxImageSize` (default 20 MB), 64 Mi pixels,
two resizes at once (`SECURITY.md`).

| | As Navidrome |
|---|---|
| Placeholders | no id, an item settled without a picture, an item the user does not see or that is gone: Navidrome's own album or artist placeholder, `Cache-Control: no-store`, no validators |
| A short answer | a picture within Go's 2048-byte buffer goes out with its `Content-Length`, a longer one chunked, as Go's server sends it |
| Not the same | the bytes of a resize (another encoder, other pixels at the edges of the scaling): the same format, width and height; a square over 8192 × 8192 (a picture of extreme shape): the original here, where Navidrome allocates the canvas (`SECURITY.md`) |

**Part 3b: disc covers, and a song's falling back** (`src/library/disc.rs`). A disc's cover (`dc-<album>:<disc>`) is
looked for at every request, as Navidrome does (`core/artwork/disc.go`): the album's folders' image files (with its
root folder's when the album lives in disc folders and that folder holds no other album's audio), in Navidrome's
order (name in natural order, then shallower, then path), walked by `DiscArtPriority` (default
`disc*.*, cd*.*, cover.*, folder.*, front.*, discsubtitle, embedded`): a file numbered for this disc first, else the
first match (in a multi-folder album, in the disc's own folders); a file named as the disc's subtitle; the picture
embedded in the disc's first song (lofty; TagLib's choice: a front cover, else a cover, else the first). Nothing
found: the album's cover. Validated by the newest of the album's times and its folders' image times
(`<id>|<nanoseconds>|<priority>`, the representation tag around it), resized and cached as any cover. A song's cover
when the song has none of its own (settled absent, or no state and no picture in the file, or
`EnableMediaFileCoverArt` off): its disc's, or its album's without a disc number. A disc or song the user does not
see: error 70 `Artwork not found`, as Navidrome answers.

**Part 3c: artist image links** (`src/library/links.rs`). An artist with a picture (or whose picture is not resolved
yet) carries `artistImageUrl` in `search3` and `getStarred2`; such answers were Navidrome's, because the link is signed.
Now they are made here: `<address>/share/img/<token>?size=600`, the token signed with Navidrome's public secret
(`JWTPublicSecret`, read at start), byte for byte Navidrome's token; the address `ShareURL`, else `BaseURL`'s, else the
request's (`X-Forwarded-Host`, `X-Forwarded-Proto`/`-Scheme`, `Host`). The link itself is still served by Navidrome
(its `/share/img` route). This reverses phase 3's "艺人图片链接不做": the brief for phase 5 asks for these searches to
come over. Without the secret, or for an address Go would write otherwise, the answer stays Navidrome's.

**Navidrome's still (covers):** a picture with no artwork state yet (albums, artists, playlists, and a song with a
picture of its own: Navidrome resolves it and queues the result, a write), an embedded picture in a format lofty does
not read as TagLib (or a file it cannot read), a listed image file that cannot be opened, a disc id without a number,
an animated GIF resized, `EnableWebPEncoding`, a size that scales the picture to nothing, a picture whose bytes are not
where its state says (Navidrome looks again, a write).

**Navidrome's still:** a transcoding with a command of its own (the owner's template), several ranges in one request
(its multipart answer has a random boundary), a song whose file cannot be opened or is not a regular file (Navidrome's error names the path), a
stored path that would leave its library's folder (`SECURITY.md`), a suffix Go finds no content type for in Navidrome's
table, a date in a condition with a zone Go would look up locally, and **`download`**: no Sonus client downloads (the
roadmap's decision 1), and its file name (`Content-Disposition`) is Navidrome's own ASCII folding and escaping, to be
ported only if a client needs it.

**Part 5: the R2 mirror** (designed in `docs/r2-mirror.md`, decided 2026-11-26; code in steps, off until the owner
configures it). Every music file and the cover originals are mirrored to a private Cloudflare R2 bucket; clients
outside the home network that opt in are redirected to short-lived signed links for files played as they are; a
daily manifest maps the opaque object names to library paths, and a restore command fetches the music back.

> **The mirror is no full backup.** R2 keeps no history of an object: a file deleted at home is deleted on R2 after
> 7 days, and a file damaged at home (by a failing disk or ransomware) changes, is uploaded as a new version, and
> replaces the good copy. Navidrome's database (users, stars, playlists, plays) is not mirrored. Keep a real backup
> as well; the mirror is one more way back after a disk fails.

**R2-a: uploads only** (`src/mirror/`). Nobody is sent to the bucket yet (that is R2-b); the server keeps the bucket
in step with the library.

| Setting | |
|---|---|
| `SONUS_R2_ACCOUNT_ID` | The Cloudflare account: the bucket is reached at `https://<id>.r2.cloudflarestorage.com` |
| `SONUS_R2_ENDPOINT` | Instead of the account: another S3-compatible store, `https://…`, or `http://` on this machine only (a local test server) |
| `SONUS_R2_BUCKET` | The private bucket |
| `SONUS_R2_ACCESS_KEY_ID`, `SONUS_R2_SECRET_ACCESS_KEY` | A token for this bucket alone, with object read and write. The secret may come from a file instead, `SONUS_R2_SECRET_ACCESS_KEY_FILE` (for example `/data/r2-secret`, mode 600) |
| `SONUS_R2_UPLOAD_RATE` | Default `2MB` (a second); `0`: no cap |
| `SONUS_R2_UPLOAD_HOURS` | Default `00:00-07:00`, the server's time zone; `all`: any time. An upload under way at the end is finished |
| `SONUS_R2_DAILY_UPLOAD` | Default `20GB`; `0`: no cap. A file larger than the cap still goes, alone, on a day of its own |
| `SONUS_R2_REGION` | Default `auto` (R2's) |

- **Off by default.** With none of the bucket's four settings, nothing of the mirror runs, and the server does what it
  did before. With some but not all of them, the server stops at start and names the missing ones. Its errors never
  show a key.
- **The ledger** is the server's own database file, `sonus-mirror.db` in Navidrome's data folder (never Navidrome's
  database). One row for each object: pending, uploaded, or deleting. If the file is lost, the bucket is listed and
  what is there already is adopted (R2-b, below); nothing else is lost.
- **Object names say nothing about the music.**
  - A song is `m/<song id>/<version>`. The version is the first 16 hex digits of `sha256("<size>|<mtime in ns>")` of
    the file itself, so a rescan that rewrites Navidrome's rows uploads nothing.
  - A cover original is `a/<its hash>`.
- **Reconciliation** runs at start and every 15 minutes.
  - New files and covers are added.
  - When a file changes, its new version goes up. The old version is deleted after the grace time, and never before
    the new one is up.
  - Files the library loses (missing, deleted, or unreadable, as when the music folder is not mounted) are deleted
    from the bucket after **7 days**. If one returns within that time, it is kept. When much goes at once, the brake
    holds the deletions (R2-b, below).
- **Uploads** go one at a time: covers first, then songs.
  - Each upload is paced by the rate, starts only within the hours, and stops at the day's cap.
  - S3 checks each upload against its SHA-256. Files over 100 MB go up in 16 MB parts; an abandoned upload is
    aborted, and the bucket's lifecycle rule clears what is left.
  - Each file is checked unchanged before and after its upload. Its size in the bucket is checked afterwards.
  - Failures wait longer each time. After 5 a file is left for the daily check, which tries it again.
- **The health check** reads one small object (`health`) every minute, and writes it once if it is not there. While
  the bucket does not answer, or refuses the keys, nothing is uploaded or deleted. Each change is logged once.
- **The daily check** lists the whole bucket against the ledger.
  - Uploaded objects the bucket lacks, or holds at another size, are uploaded again.
  - Songs and covers the ledger does not know are deleted after the grace time.
  - Other names (`health`, `manifest/`) are left alone.
- **HTTPS** is rustls with ring and Mozilla's roots compiled in: the `tls` feature, on by default.
  - ring needs clang to build on Windows on ARM. There, build and test with `--no-default-features`: the mirror then
    reaches `http://` on this machine only, which is all its tests need.
  - The image and CI build with TLS.
- **Signing** is SigV4, written here (`mirror/sigv4.rs`). It is tested against AWS's published S3 examples (GET with
  a range, PUT, `?lifecycle`, a listing, a presigned GET), not against itself. Requests are signed in the
  `Authorization` header, and nothing logs headers, signatures or keys.
- **Tested** against a fake S3 on 127.0.0.1 (`tests/common/fake_s3.rs`). Like S3, it checks:
  - each signature with the test's own made-up keys;
  - the time (within 15 minutes);
  - each body against its signed hash.

  Its listing pages are two objects long, and it can fail on demand (403, 503, failing PUTs). `tests/mirror.rs`
  covers:
  - uploads, single and in parts;
  - a rescan that uploads nothing;
  - changed, lost, returned and stray files, and the grace time;
  - the hours and the cap;
  - wrong keys, a refusing or absent bucket, and recovery;
  - backing off and the daily retry;
  - a lost ledger.

  `tests/mirror_s3.rs` runs the client against a real S3-compatible server when one is given (`SONUS_MIRROR_S3_*`;
  skipped otherwise, and in CI). On 2026-11-26 it passed against Versity's S3 gateway (versitygw 1.11.0, Windows on
  ARM, on 127.0.0.1 with throwaway keys), which took every request:
  - single and multipart uploads, the listing, HEAD and DELETE;
  - a presigned GET, served whole, while the same link tampered with, or expired, was refused;
  - wrong keys, refused with 403.

  MinIO no longer publishes Windows builds. Not yet tried against real R2 (`docs/r2-mirror.md`, section 10).

**R2-b: clients are sent to the bucket; the manifest and the restore** (`src/mirror/links.rs`, `manifest.rs`,
`cli.rs`; `library/stream.rs`, `library/media.rs`). Still off until the bucket's settings are given.

| Setting | |
|---|---|
| `SONUS_R2_REDIRECT` | `away` (default): only clients outside the home networks; `always`; `never` (the mirror only uploads) |
| `SONUS_R2_HOME_NETWORKS` | Default the LAN's private ranges and this machine: `10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 127.0.0.0/8, ::1/128, fc00::/7, fe80::/10`. The client's address is the one the gateway decides (`trust.rs`): behind a trusted proxy, its `X-Forwarded-For` |
| `SONUS_R2_LINK_LIFETIME` | Default `1h`; `30m`, `2h`, or seconds (1 minute to 6 days) |
| `SONUS_R2_DELETE_BRAKE` | Default `10%`; `off`. More of the songs and covers than this gone at once (and more than 20): nothing is deleted until the owner says so |

- **Redirects.** `stream` and `getCoverArt` answer `302 Found` to a presigned link (SigV4 query signing, `GET` or
  `HEAD` as asked) when all of these hold; otherwise they answer as before:
  - the client asks for it: `sonusMirror=1` (only new Sonus clients send it; anything else is untouched, and a
    client that fails to follow falls back with `sonusMirror=0`);
  - the policy allows it from the client's address (away from home by default);
  - the bucket answered the last health check;
  - for a song: the file as it is (no transcode; DSF and APE, which are always transcoded, never go), and the ledger
    has its current version (the file's size and time now) uploaded;
  - for a cover: a settled picture (not a disc's, looked for at the time), as it is (`a/<hash>`) or at the size asked
    (`r/<sha256 of its representation tag>`), uploaded; a client whose `If-None-Match` matches still gets the 304
    from here.

  The answer carries the player's cookie as a stream does, `Cache-Control: no-store` and `Referrer-Policy:
  no-referrer`. Links are signed on the hour, so one object has one link for the hour (picture caches hit), and hold
  at least their lifetime (at most an hour more). Sign-in and the user's right to the song or picture are checked
  first, as for any request: a user who may not see it learns nothing of the mirror.
- **Resized covers** go up when a client first gets that size (made here, or found in a cache): offered to a queue of
  64, uploaded one at a time within the upload hours (one offered outside them is offered again when asked for again),
  and recorded in the ledger as `resized`. They go with their original: when the picture is no longer the library's,
  they are deleted after the grace time. The daily check forgets one the bucket lost (it is uploaded again when asked
  for).
- **A lost ledger costs nothing but a listing.** On a new ledger the first round checks the bucket before it uploads:
  an object already there under the key the ledger waits for, at its size, is adopted as uploaded. The key names the
  file's size and time, so the same key and size are the same file. An upload whose end was not noted is adopted the
  same way.
- **The deletion brake.** The mirror is the owner's backup too: when more than `SONUS_R2_DELETE_BRAKE` of the songs and
  covers (and more than 20) are gone at once (a disk not mounted, a folder renamed), nothing is deleted from the bucket,
  however long it lasts, and a warning says so once. Files that come back are kept, and nothing is uploaded again. When
  they are gone for good, `sonus-server r2-allow-deletions` lets go of what is gone by then: deleted after its grace
  time. What goes later is held again while the brake holds. The warning is repeated once a day while it holds, with
  the count and the command. Only what is really gone counts and is held: a replaced version (a song retagged, copied
  or rewritten, still in the library) goes after its grace time once its new version is up, as before, however many
  there are. Resized covers are not held either (they are made again).
- **Behind a reverse proxy**, the proxy must be in `ExtAuth.TrustedSources` (Navidrome's setting, which the gateway
  reads): otherwise every client has the proxy's private address, counts as at home, and nobody is ever sent to the
  mirror. That is safe, but the redirects then silently do nothing. Tailscale and other CGNAT addresses
  (`100.64.0.0/10`) are not home by default: add them to `SONUS_R2_HOME_NETWORKS` if those clients should be served
  from home.
- **The daily manifest** `manifest/<day>.json.gz` (after the daily check): each song and cover file the bucket has,
  with its library and its path inside the library's folder (`/` between folders) and its size. Covers are listed
  where they are files in the album folders (`cover.jpg`); a picture Navidrome took out of a song is not (the song
  brings it back). The last 14 are kept. It names artists and titles, so it is in the private bucket only, never in a
  log.
- **Restore**: `sonus-server r2-restore --to <folder> [--manifest <YYYY-MM-DD>] [--library <id>]`, with the server's
  own settings (environment, config file, flags), beside it or on another machine.
  - It takes the latest manifest (or the day's), and downloads each file to its path inside `<folder>`. With several
    libraries in the manifest, `--library` names one.
  - A file there already at its size is skipped, so a restore cut short goes on where it stopped. A download goes to
    `<name>.sonus-restore` first, its size is checked, then it is renamed into place.
  - Each path is checked: plain names only (no `..`, no root, no drive, and no folder that leads out of `<folder>`
    through a link).
  - It prints counts, and the keys of the files it could not restore (it exits 1 then: run it again to retry them).
  - Afterwards, let Navidrome rescan. Users, stars, playlists and plays are in Navidrome's database, which is not in
    the bucket.
- **Tested** against the fake S3, which now also serves objects, and presigned links as S3 checks them (the query as
  signed, the method, the expiry; ranges):
  - `tests/library.rs`: the redirects through the gateway (each condition, and each case that stays home: not asked,
    `sonusMirror=0`, a transcode, a user without the right, the bucket down, a file changed since its upload, a client
    at home); the link followed, whole and by range; a HEAD link refused for a GET; covers as they are and resized,
    the 304 kept, resized covers offered once.
  - `tests/mirror.rs`: adoption after a lost ledger (and not at another size), the brake (a few files deleted as
    before; a whole disk held past the grace time, kept when it is back, let go by the owner, a later loss held; the
    warning once a day; a whole library retagged, its old versions deleted after the grace time, unbraked), the
    manifest (what is up, where it belongs, 14 kept) and a restore from it (whole, then going on after a file cut
    short, a missing object and a path that would leave the folder refused, nothing left half-written), resized covers
    up and gone with their original.
  - Every log line of those runs, at every level, is searched for the keys, the signatures and the links: none is
    there (`tests/common/logs.rs`).
  - `tests/mirror_s3.rs` against versitygw again on 2026-11-26: links on the hour, a range, a HEAD link (refused for a
    GET), object downloads whole, a download of the wrong size refused and removed. Not yet tried against real R2.

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
  everything else under `/auth`, the rate limit, eight first admins at once making one; and this server's own rules:
  the password alone setting nothing up (no code, a wrong one, another user's, an expired, a used one), ten wrong
  enrolment codes, the first admin's token, an admin making codes, a session alone not allowing an app, making an
  app password or resetting a user, the wrong-code limit across all of them, an app password made with a sign-in,
  and the command line;
- unit tests of what they stand on: session tokens against ones Navidrome's own JWT stack signed (`tests/golden/`),
  authenticator codes against RFC 6238's vectors, the QR code, ids, the rate limiter's window arithmetic, JSON bodies
  decoded as Go decodes them;
- `tests/gateway.rs` also: the 4 MiB limit on bodies to `/api` and `/jellyfin`;
- `tests/library.rs`: the library's reads through the gateway, on a database with Navidrome's own tables
  (`tests/common/library.sql`: the statements of a database the fork made) and a fake Navidrome: a song in Navidrome's bytes;
  that Navidrome sees nothing of the requests answered here, and the player registered here as Navidrome registers it
  (the cookie's player, the user's for this client and browser, a new one; written once a minute); everything that stays Navidrome's reaching it signed in and whole (XML,
  JSONP, `musicFolderId`, a transcoding player, an unknown content type, rows Go would read otherwise, no player);
  what a user sees (no library: nothing; an admin: everything; each their own stars and counts); every list type's
  order, paging, `X-Total-Count` and errors; the random list's pages; `EnableNaturalSorting`, `PreferSortTags`,
  `RecentlyAddedByModTime`, `AlbumPlayCountMode`, `Subsonic.EnableAverageRating`, the legacy and minimal clients, a
  player's `ReportRealPath`; gzip; the sign-in checked before anything is read; `search3` for nothing (pages in the
  tables' order, counts of 0 and -1, past the end), for words (FTS5 on the real FTS tables and triggers, phrases,
  operators as words, an artist in Navidrome's bytes), for CJK text and punctuation (LIKE), for a MusicBrainz id, and
  what stays Navidrome's (an artist with a picture, the older search); `getStarred2` (the latest first, nothing
  starred); `getPlaylists` in Navidrome's bytes (who sees what, `readonly`, `validUntil` and
  `SmartPlaylistRefreshDelay`, the minimal and legacy clients); `getPlaylist` (the order, songs that are gone,
  someone else's private one, a synced one, smart ones going to Navidrome); `getPlayQueue` (the current song among
  what is left, none saved, all gone); `getLyricsBySongId` in Navidrome's bytes, with real lyrics files on disk going
  to Navidrome, `LyricsPriority`, `enhanced`; `getCoverArt` with real files: a folder's cover and one from the image
  store as they are, the headers, 304, the resize cache (an entry without its marker is not served, each size and
  shape and encoding setting its own entry, `ImageCacheSize` 0), and everything that stays Navidrome's (discs, no
  state, no picture, a changed file, a missing one, an item that is gone or not the user's, bytes that are no
  picture); `getScanStatus` going to Navidrome;
- unit tests of the library's pure parts: Go's JSON (floats, strings, omitted fields), songs and albums against
  answers of the real Navidrome, cover art ids, made-up and real paths, `appendSuffix`, content types, the sort orders
  with every setting (the ORDER BY clauses Navidrome logs), squirrel's conditions, Go's `toSnakeCase`, the list
  filters and their errors, the natural collation (the cases of Navidrome's own test), the stored tags and
  participants, the player cookie; the search syntax against every case of Navidrome's
  `persistence/sql_search_fts_test.go` (`buildFTS5Query`, the degraded flag, `containsCJK`) and the search
  statements against the ones Navidrome logs; Go's lowercasing (`İ`, `ı`) and its list of accents; smart playlist
  rules and artist statistics as stored; stored lyrics as Go's decoder reads them, the order of lyrics sources,
  cover ids, the paths of Navidrome's image store and cache, content types from bytes, `If-None-Match`;
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

### Players registered here (phase 5, part 4), 2026-11-26

Windows on ARM, Navidrome 0.64.2-sonus.10, `cargo run` (a debug build) in front of it, ffmpeg 7.1.5 on the `PATH`:

- `db-state.mjs` now compares the `player` table too (a new player's random id named by whose, which client and which
  browser it is; `last_seen` as a time of the run). `diff.mjs --go-vs-gateway --state`: reads 547 of 547 and writes
  187 of 187, the databases the same, players included.
- **On two copies of the production database**, `--covers --streams --state --env ND_BASEURL=…`: 9847 of 9847, the
  databases the same (28 player rows on each side). The original's hash unchanged; copies and corpus deleted.
- `gateway.test.mjs`: Navidrome's debug log shows none of the requests answered here, not even a `ping`, and the
  player row is the one Navidrome alone makes for the same client (name, browser, address, settings).
- `cargo test`: the useragent library's own 102 cases (name and OS); the player from its cookie (this user's and
  client's only), from user, client and browser, made anew; written once a minute, its settings kept; the cookie named
  after the user name as carried; a player whose transcoding is gone left to Navidrome. Also: the two-step
  verification test that confirmed with the previous 30-second step's code now waits away from a step's end (it
  failed when the step changed between computing the code and the server checking it).

### Media (phase 5, part 3c: artist image links), 2026-11-25

- **On two copies of the production database** (594 artists, 340 with pictures), `--covers --streams --env
  ND_BASEURL=https://music.example.com`: 9841 of 9841 the same; the 102 `search3` requests with artists that have
  pictures, Navidrome's until now, are answered here with the very same signed links. Without `BaseURL`, two new
  requests per user take the address from a proxy's `X-Forwarded-Host` (a list: its first) with `X-Forwarded-Proto`
  or `X-Forwarded-Scheme`: 6 of 6. The original's hash unchanged; copies and corpora deleted.
- `cargo test`: the address from each setting and header, what is left to Navidrome, the token's claims and their
  bytes.

### Media (phase 5, part 3b: disc covers), 2026-11-25

Windows on ARM, Navidrome 0.64.2-sonus.10, `cargo run` (a debug build) in front of it, ffmpeg 7.1.5 on the `PATH`:

- `diff.mjs --go-vs-gateway` (reads): 547 of 547, 453 answered here. 54 cover requests, 11 new: discs 1 and 2 of a
  two-disc album, a disc asked for by a hash, the disc of an album without a picture (its placeholder), a disc that
  is not there (the album's cover), an unknown album (70), a disc id without a number (Navidrome's), a disc resized
  and again from each side's cache, songs without a picture of their own (their disc's).
- The writes corpus with `--state`: 187 of 187, databases the same. `run.mjs --through-gateway`: 132 of 132; node
  tests 39 of 39 (`gateway.test.mjs` now counts a disc cover among the answers given here).
- Corpora made from the golden database and **two copies of the production database** with `--covers --streams`
  (now four disc covers per run) and `--env ND_BASEURL=https://music.example.com`: 841 of 841 and 9841 of 9841; the
  original's hash unchanged, copies and corpora deleted.
- `cargo test`: disc ids, Go's glob, Navidrome's image file order, TagLib's choice of picture; integration: a disc's
  numbered file, the first match further down, the validator and its time, a song's disc, 70 for another user, a
  disc without a picture showing its album's (immutable for the album's hash).
- Also in this PR: a square canvas over 64 Mi pixels is never made (the original instead; `SECURITY.md`), the
  placeholders' notice rewritten, and `auth-routes.test.mjs` sends a refused 4 MiB body again when the connection was
  reset under it (a timing race of the test, not of the servers).

### Media (phase 5, part 3a: covers resized here, placeholders), 2026-11-25

Windows on ARM, Navidrome 0.64.2-sonus.10, `cargo run` (a debug build) in front of it, ffmpeg 7.1.5 on the `PATH`:

- `node tools/contract/diff.mjs --go-vs-gateway --corpus tools/contract/corpus/read-only.json`: 536 of 536 the same,
  441 answered here. The runner now reads a picture's format, width and height from its header (`pictureSize`), and
  a resize made by each side's own encoder is compared by status, headers (type, `ETag`, `Last-Modified`,
  `Cache-Control`), format and dimensions, its bytes and length left out. The 43 cover requests: sizes 600, 300, 64,
  16, square 600 and 32, a size above the picture's (the original, byte for byte), each again from each side's cache,
  by its hash and by another, 304s; the album, playlist and artist placeholders and the one without an id byte for
  byte; a square without a size, discs, bare ids, unknown items and songs without state: Navidrome's.
- The writes corpus with `--state`: 187 of 187, databases the same. `run.mjs --through-gateway`: 132 of 132; node
  tests 39 of 39 (one new: `pictureSize`).
- A corpus made from the golden database with `--covers --streams` and `--env ND_BASEURL=https://music.example.com`:
  833 of 833. **On two copies of the production database** (the same flags; no pictures or music on this computer):
  9833 of 9833; the original's hash unchanged, copies and corpus deleted.
- `cargo test`: 3 new unit tests (fitting, squares, never enlarged, JPEG/PNG/GIF, unreadable and over-the-cap
  pictures, animations), 3 new or rewritten integration tests (a real 800 × 600 JPEG resized here, served from this
  server's cache once its source is gone, Navidrome's cache first; the placeholders).

### Media (phase 5, part 2: transcoding), 2026-11-25

Windows on ARM, Navidrome 0.64.2-sonus.10, `cargo run` (a debug build) in front of it. Both servers ran the same
ffmpeg: `ffmpeg-n7.1.5-1-g7d0e842004-winarm64-gpl-7.1.zip` from BtbN/FFmpeg-Builds (release
`autobuild-2026-06-30-13-34`), SHA-256 `2e61ed624facb68d8d9288f59cd8627807590dbd62882edc3a1004d46a3af87c`, unpacked under
`tools/fixtures/.work/ffmpeg/` (never committed) and put first on the `PATH`. **Production runs the image's own Linux
ffmpeg, another build: the same bytes here show the arguments and the plumbing are Navidrome's, not the bytes
production will make.**

- `node tools/contract/diff.mjs --go-vs-gateway --corpus tools/contract/corpus/read-only.json`: 532 of 532 the same,
  430 answered here. 35 transcode requests: every format of the generated library to mp3 at 320, flac and mp3 to aac,
  wav and flac to flac, mp3 and flac to opus, lossy to flac (falls back to opus), an unknown format (falls back), a
  `maxBitRate` below the song's (opus), the song's own format at its bit rate (the file), `timeOffset`,
  `estimateContentLength` (the answer then ends short of the announced length, on both sides), `HEAD`; then each
  again from the cache (with a length, `Accept-Ranges: bytes`), with ranges, a condition, `HEAD`, and one cached by an
  earlier `HEAD`. mp3, aac and flac are the same byte for byte; opus is the same but for its Ogg serial number, which
  ffmpeg picks at random (two Navidromes differ the same way: `@sha256` volatile, the length compared). A mono song
  asked for as opus at 320 kbit/s: libopus refuses more than 256 for one channel, ffmpeg fails before its first byte,
  and both sides answer with Navidrome's error (a finding for the web client, which asks for opus at 320).
- Before that, `--go-vs-go` on the transcode requests: 34 of 34 (the outputs are deterministic but for opus).
- Found on the way: Go's server sends a `Content-Length` instead of chunks when a whole answer fits its 2048-byte
  buffer (`bufferBeforeChunkingSize`); a short transcode is answered the same way here now.
- The writes corpus with `--state`, ffmpeg present: 187 of 187, databases the same, twice; `--go-vs-go --state`: the
  same. With ffmpeg present Navidrome's cover worker meets a playlist deleted during the run at another moment on each
  side (before the deletion: a cover row; after: a queue row it retries, "data not found"); `db-state.mjs` now compares
  such leftovers as "a deleted playlist left cover state", not row by row.
- A corpus made from the golden database with `--streams`: 789 of 789. **On two copies of the production database**
  (no music files on this computer; its four transcodings are Navidrome's built-in commands, no player has a
  transcoding or a bit rate): 195 stream requests, 195 the same; the original's hash unchanged, copies and corpus
  deleted.
- `cargo test`: 297 (7 unit tests of the decision with Navidrome's own `legacy_client_test.go` cases and more, 3 of the
  runner and cache, 2 integration tests with a stand-in ffmpeg: arguments, cache, ranges from the cache, a failure
  before the first byte, Navidrome's 429). `run.mjs --through-gateway`: 132 of 132; node tests: 35 of 35.
- **Correction to part 1**: its two transcode requests (`format=mp3`, a lower `maxBitRate`) were the same only because
  neither Navidrome had an ffmpeg; they are now compared for real.

### Media (phase 5, part 1: songs' files), 2026-11-25

Windows on ARM, Navidrome 0.64.2-sonus.10, `cargo run` (a debug build) in front of it:

- `node tools/contract/diff.mjs --go-vs-gateway --corpus tools/contract/corpus/read-only.json`: 499 of 499 the same,
  396 answered here. The runner now compares, for every answer that is not JSON, the status, the bytes (length and
  SHA-256) and the headers `Content-Type`, `Content-Length`, `Content-Range`, `Accept-Ranges`, `Last-Modified`,
  `X-Content-Duration`, `X-Content-Type-Options`, `Vary`, `Content-Encoding`, `Transfer-Encoding`, `ETag`,
  `Cache-Control`, `Content-Disposition`; and can send `HEAD`. 56 stream requests were added: every format of the
  generated library, titles in other scripts, songs without tags, artist or album, a form post, `.view`, `HEAD` with
  and without a range, ranges `0-0`, `0-`, `-0`, `-1`, `5-4`, past the end, ` 10 - 20`, `+3-9`, `abc`, `10`,
  `items=`, an empty part, two parts (Navidrome's), two adding up to more than the file, one past the end beside one
  that fits; `If-Modified-Since` ahead, long ago, in the ANSI C and RFC 850 layouts, nonsense; `If-Unmodified-Since`
  both ways; `If-Match` `*`, a tag, a list with `*`, a list broken before it; `If-None-Match` `*`, a tag, a weak tag,
  as a form post (412); `If-Range` with a tag and with an old date; `maxBitRate` 0, at or above the song's, not a
  number; below the song's and `format=mp3` (Navidrome's, transcoded; the same bytes from both); `timeOffset`; no
  id; another user; `f=xml` (the file) and an XML error (Navidrome's); a request from a page (CORS).
- A reads corpus made from the golden database with `--streams` (`corpus-from-db.mjs`): 789 of 789. **On two copies
  of the production database** (no music files on this computer: what is compared is the lookup, the access rules
  and the errors): 195 stream requests, 195 the same; the error text of a file that is not there names each copy's
  own folder and is left out of the comparison (its code is compared). The original's hash unchanged; the corpus
  made from it deleted.
- `cargo test`: 285 (2 new integration tests over a real file: every header, a part, `HEAD`, 416, 304, 412,
  `If-Range`, `raw` with a transcoding player, XML, the errors; and what stays Navidrome's: a format, a lower bit
  rate from the request or the player, a transcoding player, several ranges, a song without its file, an unknown
  suffix, a stored path with `..`, an XML error). `run.mjs --through-gateway`: 132 of 132. `writes.test.mjs`,
  `gateway.test.mjs`, `auth-routes.test.mjs`, `diff.test.mjs` and the `security/` tests: 38 of 38.

### The library's writes (phase 4, part 3: plays and now playing), 2026-11-25

Windows on ARM, Navidrome 0.64.2-sonus.10, `cargo run` (a debug build) in front of it:

- `node tools/contract/diff.mjs --go-vs-gateway --state --corpus tools/contract/corpus/writes.json`: 187 of 187 the
  same, 185 answered here; the databases the same, row for row, `scrobbles` included. 55 requests were added: plays
  at times with and without milliseconds, without a time, with a time that is not a number, several in one call, an
  earlier one, songs with two artists, an unknown id, another user's; every error; now playing for an unknown id,
  `submission` as `yes`, `false`, `0`, two ids, three users, the same song again; `getNowPlaying` before, during (the
  latest first), once the songs have played to their end (positions capped) and once their time is up (gone);
  `reportPlayback` with every parameter error, an unknown id, starting and paused on two web UI tabs, playing at
  double speed, a late `starting` ignored, a late `stopped` for another song ignored, stopped early (no play), past
  half (a play), with `ignoreScrobble`, as another user.
- A writes corpus made from the golden database, now with plays and playback reports: 255 of 255, the databases the
  same.
- **On two copies of the production database** (writes on the copies only; the original's hash unchanged): 250
  requests made from its data: 250 the same, 244 answered here (6 `getStarred2` with artists with pictures went to
  Navidrome, as decided); the databases the same, row for row (854 annotation rows, 2,332 plays in `scrobbles`).
- `node --test tools/contract/writes.test.mjs`: 5 of 5, the new one: a play counted here is seen at once by
  Navidrome's web UI API, `getNowPlaying` shows the session, and Navidrome's debug log has no trace of either (no
  `/rest/scrobble`, no "Scrobbled", no "Now Playing", nothing buffered for Last.fm or ListenBrainz; the control, a play
  Navidrome gets itself, is logged).
- The writes corpus with `--state` once more, and two Navidromes against each other (`--go-vs-go --state`): 187 of
  187 and the databases the same each time. `diff.mjs --go-vs-gateway` (reads): 443 of 443, 331 answered here.
  `run.mjs --through-gateway`: 132 of 132. `writes.test.mjs`, `gateway.test.mjs`, `auth-routes.test.mjs`,
  `diff.test.mjs` and the three `security/` tests: 38 of 38. `cargo test`: 277.
- **The Windows client against this server, end of phase 4**: `node tools/e2e/acceptance.mjs --arch=ARM64`, all 14
  rounds, `SONUS_TEST_SERVER` at a debug build of this server in front of the frozen Navidrome, on a fresh library of
  53 generated songs, throwaway users: **92 of 92, four skipped** (the same four as at the end of phase 3: no DSD song;
  every large cover already fetched; two Connect checks for version 1 or the demo server's hook). This server
  answered 348 of the library's requests itself: 176 covers, 32 `search3`, 25 `getPlaylist`, 22 `scrobble`, 21
  `getPlaylists`, 19 `getAlbumList2`, 15 `getLyricsBySongId`, 14 `ping`, 4 `getStarred2`, 4 `createPlaylist`, 4
  `deletePlaylist`, 3 `updatePlaylist`, 3 `getSong`, 3 `getAlbum`, a `star`, an `unstar` and a `getNowPlaying`; and
  left 29 to Navidrome, for the reasons written down (23 covers not resized yet, 4 disc covers, 2 songs with a lyrics
  file). The play it counted is in `scrobbles`; Navidrome's buffer for Last.fm and ListenBrainz stayed empty. Its log
  had two warnings, both the run's own (the first admin made; a wrong password the client's tests type on purpose).
  The client saved no play queue during the run (`savePlayQueue` is covered by the corpora and tests above).

### The library's writes (phase 4, part 2: playlists), 2026-11-25

Windows on ARM, Navidrome 0.64.2-sonus.10, `cargo run` (a debug build) in front of it:

- `node tools/contract/diff.mjs --go-vs-gateway --state --corpus tools/contract/corpus/writes.json`: 132 of 132 the
  same, 127 answered here; the two databases the same, row for row, Navidrome's artwork queue and the playlists'
  artwork state included. 48 requests were added: new playlists with songs, empty, with duplicates and an unknown id,
  by another user; replacing songs (own, without songs, with a name, someone else's, a public one, an unknown id, a
  smart one, as the admin); removing out of range, negative, not-a-number and repeated indexes, every song, removing
  and adding at once, adding an empty id, an empty name, an empty comment, `public` as `on` and `yes`; every error;
  deleting twice, someone else's, as the admin.
- A writes corpus made from the golden database, now with playlists: 210 of 210, the databases the same.
- **On two copies of the production database** (writes on the copies only; the original's hash unchanged): 205
  requests made from its data, its users' own playlists changed and replaced among them: 205 the same, 200 answered
  here (5 `getStarred2` with artists with pictures went to Navidrome, as decided); the databases the same, row for row
  (20 playlists, 1,382 tracks).
- `node --test tools/contract/writes.test.mjs`: 4 of 4, the new one: playlists made and changed by either server are
  seen by the other at once (`/api/playlist/:id/tracks` too); 60 appends to one playlist at once, with another user
  filling their own, are all kept, numbered 1 to 62 without a gap.
- The writes corpus with `--state` twice more, and two Navidromes against each other (`--go-vs-go --state`): 132 of
  132 and the databases the same each time. `diff.mjs --go-vs-gateway` (reads): 443 of 443, 330 answered here.
  `run.mjs --through-gateway`: 132 of 132. `writes.test.mjs`, `gateway.test.mjs`, `auth-routes.test.mjs`: 17 of 17.
  `cargo test`: 274.

### The library's writes (phase 4, part 1), 2026-11-25

Windows on ARM, Navidrome 0.64.2-sonus.10 (the frozen fork), `cargo run` (a debug build) in front of it:

- `node tools/contract/diff.mjs --go-vs-gateway --state --corpus tools/contract/corpus/writes.json`: 84 of 84 the
  same, 76 answered here; then the two databases table by table (`annotation`, `playqueue`, `playlist`,
  `playlist_tracks`, `scrobbles`, the averages, the playlists' artwork state): the same, row for row, times written
  during the run and new ids normalized (`db-state.mjs`). 50 requests were added: every parameter form the clients
  send, ids nobody sees, an empty id, starring twice, someone else's private playlist, two users and the admin rating
  the same song, ratings out of range, errors, queues with duplicates, unknown ids, no current, emptied and made anew.
- A writes corpus made from the golden database (`corpus-from-db.mjs --writes`, `diff.mjs --db … --state`): 174 of
  174, the databases the same.
- **On two copies of the production database** (writes on the copies only; the original's hash unchanged): a writes
  corpus made from its data, as its three users, 173 requests: 173 the same, 167 answered here (6 `getStarred2` with
  an artist with a picture went to Navidrome, as decided); the databases the same, row for row (750 annotation rows).
- `node --test tools/contract/writes.test.mjs`: 3 of 3: a star, unstar, rating and queue written here are seen at
  once by Navidrome's web UI API (`/api/song`, `/api/queue`) and its Subsonic API, and Navidrome's by this server;
  two users starring, rating and saving queues at once (128 requests, then 26 unstars) lose nothing and every average is right; a write
  waits out another writer holding the lock for 4 s, and 120 writes during a full scan all succeed.
- `node tools/contract/diff.mjs --go-vs-gateway`: 443 of 443, 330 answered here. `run.mjs --through-gateway`: 132 of
  132. `gateway.test.mjs` and `auth-routes.test.mjs`: 13 of 13. `cargo test`: 272.
- **A difference seen and accepted**: `getStarred2` right after items were starred in one call. Go on Windows reads a
  coarse wall clock, so items starred in one call often get the very same `starred_at` there and the list's order is
  then SQLite's; here each gets its own time. On Linux, where the server runs, Go's clock has nanoseconds too. The
  generated writes corpora compare those lists as sets.

### The library's reads (phase 3, part 3), 2026-11-25

Same machine and Navidrome. The golden database now comes with Navidrome's image store (`tools/fixtures`), so a copy
has the pictures its artwork state points at:

- `node tools/contract/diff.mjs --go-vs-gateway`: 443 of 443 the same as Navidrome alone, 329 answered by this
  server itself; four runs in a row. 42 requests were added: lyrics from the row (synced, unsynced, none, CJK),
  without an id, with the wrong kind of id, a lyrics file beside the song and `enhanced` going to Navidrome; covers
  as they are from a folder and from the image store, by their hash (kept for good), by another hash, by an old id's
  time stamp, with `If-None-Match` (the picture's validator, a weak one, `*`, another), sizes below 0 and not a
  number, in XML, as three users, a playlist's cover and another user's private one; resized covers the first time
  (Navidrome's) and again 1.5 s later (served here from Navidrome's cache: the same bytes, `ETag`, `Last-Modified`
  and `Cache-Control`), square, by hash, 304; and what stays Navidrome's (discs, a song's own cover without state,
  no picture, unknown ids, no id). `ETag`, `Last-Modified` and `Cache-Control` are compared for every answer that is
  not JSON. With `corpus/writes.json`: 34 of 34. Two Navidromes: 443 of 443.
- `node tools/contract/run.mjs --through-gateway`: 131 of 131; Navidrome alone: 123 pass, 8 skipped (Connect v2).
- `node --test tools/contract/gateway.test.mjs`: 7 of 7; the test of who answers sends nineteen requests to the
  eleven methods and eight left to Navidrome (a lyrics file, a disc's cover, the scan's status among them).
- `node --test tools/contract/auth-routes.test.mjs`: 6 of 6, as before.
- `cargo test`: 267 tests (160 unit, 24 in `tests/library.rs`, 83 in the other integration tests).
- **A difference that came and went is explained and gone.** Part 2 saw, once, a smart playlist's `coverArt` differ
  between the two servers. The cause was in the golden database, not in either server: the smart playlist had no
  artwork state (Navidrome makes a playlist's cover when the playlist is changed through the Subsonic API, and that
  one was not), so each Navidrome made the cover a few seconds after it started, and the two servers of a comparison
  do not start at the same moment. The build of the fixtures now has Navidrome settle every playlist's cover.

- **The Windows client against this server**: `node tools/e2e/acceptance.mjs --arch=ARM64`, all 14 rounds, with
  `SONUS_TEST_SERVER` pointing at this server (a debug build) in front of the frozen Navidrome, on a library of 53
  generated songs (five albums of the demo catalogue as tagged WAV with covers and synced `.lrc` files, and the
  fork's own test files), throwaway users, through the tests' recording proxy: **92 of 92, four skipped** (no DSD
  song in that library; every large cover already fetched in earlier rounds; two Connect checks that only apply to
  version 1 or need the demo server's hook). During the run this server answered 317 Subsonic requests itself: 169
  covers, 32 `search3`, 26 `getPlaylist`, 21 `getPlaylists`, 19 `getAlbumList2`, 15 `getLyricsBySongId`, 14 `ping`,
  5 `getStarred2`, 4 `getSong`, 3 `getAlbum`, and the Connect WebSockets; and left 29 of the library's reads to
  Navidrome: 23 covers not resized yet, 4 disc covers, 2 songs with a lyrics file. Nothing failed over to Navidrome
  for a reason other than those, and the server logged no warning.

Not checked: a library of production's size; covers and lyrics on Linux against the real Navidrome (the paths in
Navidrome's state are the operating system's own: the same code, and `tests/library.rs` runs on CI's Linux with real
files); a cover whose cache entry Navidrome evicts or rewrites while it is read here; a song's own cover with
artwork state (the fixture library's songs have none: checked in `tests/library.rs`); `CoverArtQuality`,
`EnableWebPEncoding`, `ImageCacheSize` and `LyricsPriority` other than the defaults against the real Navidrome.

### The library's reads (phase 3, part 2), 2026-11-25

Same machine and Navidrome as part 1, on `main` with the security review's fixes:

- `node tools/contract/diff.mjs --go-vs-gateway`: 401 of 401 the same as Navidrome alone, 293 of them answered by
  this server itself. 152 requests were added: the empty query's paging (the last page, past the end, counts of 0,
  -1 and not a number, an offset without a count, albums and artists paged, no `query` at all, `""`, `*`, spaces),
  as three users; 65 word searches (case, prefixes, phrases, accents, the Turkish I both ways, sort names, FTS5's
  operators and syntax characters typed as words, punctuated names, LIKE's wildcards, quotes alone) and 12 in Chinese,
  Japanese and Korean, paged; MusicBrainz ids of a recording, a release track, an album and an artist, in capitals,
  without dashes, in braces, unknown, almost one; the legacy and minimal clients; `getStarred2`, `getPlaylists`,
  `getPlaylist` and `getPlayQueue` as the three users (nothing starred, no queue saved, someone else's private
  playlist), without an id, with the wrong kind of id; and what stays Navidrome's (`musicFolderId`, XML, the smart
  playlist). With `corpus/writes.json`: 34 of 34. Two Navidromes (`--go-vs-go`): 401 of 401.
- `node tools/contract/run.mjs --through-gateway`: 131 of 131.
- `node --test tools/contract/gateway.test.mjs`: 7 of 7; the test of who answers now sends sixteen requests to the
  nine methods and three kinds of request left to Navidrome.
- `cargo test`: 249 tests (155 unit, 19 in `tests/library.rs`, 75 in the other integration tests).

Not checked: an artist with a picture against the real Navidrome (the fixture library's artists have none: that
such a search goes to Navidrome is checked in `tests/library.rs`); `Subsonic.ArtistParticipations`,
`SmartPlaylistRefreshDelay` and the older search against the real Navidrome (`tests/library.rs` and unit tests
only); a smart playlist with a refresh delay of its own; FTS5 ranking on a library of production's size (the same
SQL and the same SQLite functions, but another build of SQLite than Navidrome's: equal scores are ordered by the
title or name, as in Navidrome).

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
  methods of part 1, `lists.rs` those of part 2, `media.rs` lyrics and covers; `query.rs`, `catalog.rs`: Navidrome's
  queries; `search.rs`: its
  search syntax; `entities.rs`: albums, songs, artists and playlists as its JSON; `json.rs`: Go's JSON;
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

The search syntax uses `regex` (the Rust project's own regular expressions) for what Go's `regexp` does in
Navidrome: Unicode letter and number classes, the CJK scripts, ASCII word boundaries.

Compression of the library's answers is `flate2` with its default pure-Rust backend (`miniz_oxide`): the gzip
library of the Rust ecosystem, maintained by the Rust project's own contributors; no C is added to the build.

`rustfmt.toml` keeps the width the code is written to (160).
