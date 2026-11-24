# Sonus server: security decisions and trust boundaries

For whoever reviews this server's security: what it decides, what Navidrome still decides, whom each believes, and
what could go wrong. It describes the code as it is after phase 2's first half (`docs/server-roadmap.md`): the gateway
(phase 0) and Subsonic sign-ins checked here. The `/auth` routes (web sign-in, two-step verification, the browser
sign-in for apps) are still Navidrome's; they move here next, and this file grows with them.

Code: `src/gateway.rs`, `src/trust.rs`, `src/routes.rs`, `src/subsonic/`, `src/secrets.rs`, `src/db.rs`,
`src/startup.rs`, `src/config.rs`. What the behaviour is checked with: `README.md`, "Tests" and "Checked against the
real Navidrome".

## The pieces

```
client ──► [ trusted proxy ] ──► Sonus server (gateway) ──► Navidrome (the CreeperUX fork, 0.64.2)
                                   0.0.0.0:4533              127.0.0.1:4534, started by the gateway
                                        │                         │
                                        └──── navidrome.db ───────┘   (one SQLite file, opened by both)
```

- One container. The gateway is its entrypoint and the only thing that listens on the published port.
- Navidrome is a child process on 127.0.0.1, told by the gateway (through its environment, which outranks its config
  file) to listen there, to believe forwarding and user headers from 127.0.0.1 only, and under which name to read the
  user header.
- Both open the same database file. The gateway reads users, their encrypted passwords, the two-step verification
  state and app passwords from it, and writes three things (below).

## What the gateway decides

1. **Who the client is** (`trust.rs`, phase 0). The peer address, unless the peer is in `ExtAuth.TrustedSources`;
   then `True-Client-IP`, `X-Real-IP`, the rightmost untrusted `X-Forwarded-For` hop, as Navidrome reads them. Clients'
   own forwarding headers never reach Navidrome; it gets one `X-Real-IP` from the gateway.
2. **Whether a Subsonic request is signed in** (`subsonic/`). For every method behind Navidrome's sign-in, by any
   HTTP method: the parameters' presence (error 10), the credentials (40, 43, 44), the failed-attempt limit.
   `README.md`, "Sign-ins", has the table.
3. **Which user Navidrome is told**. A signed-in request goes on with the user's name in one header, and without `p`,
   `t`, `s`, `apiKey`. Navidrome looks that name up and treats the request as that user's.
4. **`tokenInfo`**: answered here.
5. **Whether to run at all**: only on the database schema it knows (goose version 20260922230428, the fork's
   `sonus_*` tables, one library). Otherwise it stops, and stops Navidrome.

## What Navidrome still decides

- Everything under `/auth` (web sign-in with two-step verification, app passwords, the browser sign-in for apps), with
  its own rate limit; the web UI's sessions (JWTs): issuing, verifying, refreshing; `/api`; the Jellyfin API; shares.
- A Subsonic request signed with `jwt=` (the web UI's own calls): the gateway passes it on untouched and Navidrome
  verifies the token.
- A user named by a trusted proxy (`ExtAuth`): the gateway passes the proxy's header on, and Navidrome looks the user
  up. On the web UI's page Navidrome creates a user a trusted proxy names when there is none (its
  `handleLoginFromHeaders`); the gateway never sends its header there.
- What a signed-in user may do (admin-only methods, playlist ownership, …): every authorization check.
- For Subsonic requests the gateway does not check: a CORS preflight, `getOpenSubsonicExtensions`, a path that is no
  method (404), a query or form Go's parser refuses (error 0). Navidrome compares no credential for any of these.

## The one new power: the user header

Before phase 2 the gateway only relayed a trusted proxy's user header. Now it also writes that header itself, after
checking credentials. Navidrome believes it without any further check, so everything rests on these:

- **Only the gateway can set it.** Navidrome listens on 127.0.0.1 and believes the header from 127.0.0.1/32 only
  (`ND_EXTAUTH_TRUSTEDSOURCES`, set by the gateway, outranking the config file; a config file that would outrank it
  back stops the gateway). The gateway removes the header (and the configured `ExtAuth.UserHeader`) from every
  incoming request before anything else, and adds it only (a) from a trusted proxy's `ExtAuth.UserHeader`, or (b) for
  a Subsonic request whose credentials it has checked. With no trusted proxy the header's name is 128 random bits,
  new at every start.
- **Only for a user in the database, whose credentials were checked.** The name sent on is the one the request
  signed in with: `u` as the client typed it for a password (Navidrome names the player cookie after it, and finds
  the user case-insensitively as the gateway did), the database's `user_name` for an API key. There is no code path
  that names a user without a successful check, and none that takes the name from anything but the request's own
  checked `u` or the matched row. On `/rest`, Navidrome answers 40 for a header naming nobody and creates no user.
- **Only on `/rest/<protected method>`.** On every other path the header is stripped and never added (unless a
  trusted proxy sent it), so it cannot reach Navidrome's web sign-in, where a header creates users.
- **A name the header cannot carry is not sent.** Control characters would be refused by the HTTP library; a name
  with spaces at its ends would be trimmed by Navidrome into another name. For such a user (only if the database has
  one) the request goes to Navidrome untouched, credentials included, and Navidrome checks them itself.

What could go wrong here:

- **Another process on 127.0.0.1** (in the container, or on the host with host networking) can reach Navidrome's
  port without the gateway. With no trusted proxy it would need the random header name, which is in Navidrome's
  environment (`/proc/<pid>/environ`, readable by the same user and root) and in Navidrome's own start-up log if it
  dumps its configuration at debug level. With a trusted proxy configured the name is the configured one, known. Not
  new in phase 2 (phase 0 documented it; a unix socket between the two is the noted follow-up), but the header now
  matters for every Subsonic request.
- **The gateway and Navidrome disagreeing about a request.** If the gateway checked one thing and Navidrome acted on
  another, a request could be signed in as the wrong user. After a check Navidrome takes the user from the header
  alone and ignores `u`; the path the gateway matched is forwarded byte for byte; the query and form are forwarded
  byte for byte minus whole credential pairs. The parameters are read as Go reads them (`subsonic/params.rs`: first
  value, the form before the query, `+` and `%XX`), and where Go's parser would refuse the query or the form the
  gateway does not interpret it at all.
- **A path Navidrome's router matches and `routes.rs` does not.** Such a request would reach Navidrome with its
  credentials and be checked there: no bypass, but a second limiter (below). The gateway matches the literal path as
  chi does (`/rest/ping`, `/rest/ping.view`; no decoding, no trailing slash, no case folding), under `BaseURL`'s path.

## One place decides every credential check

Navidrome's limiter and the gateway's are separate, so each request path on which Navidrome itself would still
compare a password, token or key is a second door with its own budget of guesses. The gateway therefore checks every
HTTP method (Navidrome's router answers them all), forms in POST, PUT and PATCH, and all three answer formats. What
still reaches Navidrome with credentials in it:

- requests Navidrome answers without comparing anything (listed above);
- `jwt=`: a signature, not a guessable secret; Navidrome's limiter still applies to it;
- a correct sign-in for a user whose name no header can carry: only after the gateway's own check succeeded;
- a trusted proxy's requests: Navidrome ignores their credentials.

The other doors are Navidrome's own and unchanged: `/auth/login` and the browser sign-in (per-address rate limit), the
Jellyfin API.

## The limiter

Navidrome's `authLimiter`, ported with its counting (`subsonic/limiter.rs`; `tools/contract/gateway.test.mjs` compares
the two step by step):

- keyed by the client address the gateway decided (an IPv6 address by its /64) and the lowercased user name, or by the
  address alone for API keys; a failure for one key does not limit another;
- `AuthRequestLimit` failures in `AuthWindowLength` (5 in 20 s by default) refuse the key until the window is over,
  right credentials included, with the answer of a wrong password (40, or 44 for keys);
- at most `limit` checks per key run at once and failures are recorded when a check ends, so a window admits at most
  2 × limit − 1 guesses;
- only wrong credentials count: missing parameters, mixed credentials (43) and database errors do not;
- keys are stored as 64-bit hashes seeded per process, and idle keys are dropped once per window: memory is bounded by
  the attempts of the last window, not by the length of names.

Known limits, as in Navidrome: an attacker with many addresses is limited per address only; a user's name is not
locked out, so guesses against one user from many addresses are not limited; `AuthRequestLimit=0` turns it off (the
test settings do). Behind a proxy that is not in `ExtAuth.TrustedSources`, every client shares the proxy's address and
so one budget per user name.

## Secrets

- **Passwords are stored reversibly**, by Navidrome's design: Subsonic's token sign-in (`t` = md5(password ‖ salt))
  needs the password itself. AES-256-GCM with the key sha256(`PasswordEncryptionKey`); without that setting the key
  is Navidrome's public default, and the encryption only obscures. Anyone who reads the database file and the
  setting reads every password. This server changes none of that; it reads the same file with the same key.
- md5 and unsalted sha256 appear because the protocols define them (Subsonic tokens, the fork's API-key lookup hash
  of a 160-bit random key), not as password hashing.
- Comparisons of secrets are constant-time (`subtle`). Which user exists is still observable by timing (an unknown
  user answers before any decryption), as in Navidrome.
- The key, passwords, tokens and API keys are never logged: the request log has the path only; refusals log the user
  name and client address; `Shared`'s debug output masks the key. Credentials are removed before a request goes to
  Navidrome, so they are not in Navidrome's log either (checked: `gateway.test.mjs`).
- Credentials still travel in query strings from client to gateway (the Subsonic protocol); TLS is the proxy's job in
  front (the gateway refuses to start with Navidrome's TLS settings rather than serve plain HTTP unnoticed).

## The database

- Opened read-write, because three things are written: an app password's `last_used_at`/`last_used_by` (as Navidrome
  notes it), a user's `last_access_at` for `tokenInfo`, and at start the key hash of app passwords made before API
  keys existed. Each is one short `BEGIN IMMEDIATE` transaction; every statement is parameterized.
- No schema change, ever, and no VACUUM; the schema is checked at start and the server refuses any other.
- Until that check has passed, sign-in requests are answered 503: they are neither checked against an unknown schema
  nor handed to Navidrome with their credentials.
- SQLite is the bundled copy (rusqlite), not the image's: its version is this crate's `Cargo.lock`.

## The answers given here

- Errors and `tokenInfo` only, in Navidrome's bytes. Reflected input: the `callback` of a JSONP answer, accepted only
  when it matches Navidrome's own pattern (`^[a-zA-Z_$][a-zA-Z0-9_$.]*$`), else a JSON error; the missing parameter's
  name, which is one of three constants; the user name in `tokenInfo`, from the database, escaped as Go's JSON and XML
  encoders escape it.
- The headers Navidrome's middlewares add: `X-Content-Type-Options: nosniff`, `X-Frame-Options`, `Referrer-Policy`,
  `Permissions-Policy`, and CORS open to every origin without credentials (`Access-Control-Allow-Origin: *`), as
  Navidrome has it for the whole server.

## Denial of service

- A form is read into memory before it is checked, up to 10 MiB (Navidrome's own limit), by anyone, signed in or not.
  Many at once cost memory: as in Navidrome, and bounded per request.
- Each sign-in check is a blocking database task (a few indexed reads, AES-GCM over a few short strings). A flood of
  requests queues on tokio's blocking pool; nothing here caps the total, as nothing does in Navidrome.
- A slow client is cut after 30 s without complete headers (phase 0). Request bodies and responses stream.

## Where the gateway knowingly differs from Navidrome

`README.md`, "Sign-ins", lists them: constant-time comparison; an undecryptable password matches nothing; both keys
tried for passwords; a user name that is not UTF-8 refused here; a malformed `Content-Type` answered after the sign-in
check instead of before; the gateway's own answers uncompressed; key hashes filled at start. None widens what signs
in: each either refuses more or changes nothing about who is accepted, except the second key, which only opens what
was sealed with the public default key.

## Running in front of a Navidrome it did not start

With `SONUS_NAVIDROME_URL` the gateway checks nothing and writes no user header of its own: that Navidrome has its own
settings, and the gateway cannot know it believes the header from the gateway alone. Everything passes through, as in
phase 0.

## Not covered by tests

- The image and Linux builds are built by CI, not run by these tests; the checks ran on Windows.
- `BaseURL` with a path in front of the real Navidrome (tested with the fake one).
- Concurrency under load: the limiter's and the database's behaviour with hundreds of simultaneous sign-ins.
- A database written by Navidrome while the gateway writes (both use WAL and a 15 s busy timeout; not stress-tested).
