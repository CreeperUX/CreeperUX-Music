# Sonus server: security decisions and trust boundaries

For whoever reviews this server's security: what it decides, what Navidrome still decides, whom each believes, and
what could go wrong. It describes the code as it is after phase 2 (`docs/server-roadmap.md`): the gateway (phase 0),
Subsonic sign-ins checked here, and the `/auth` routes answered here (web sign-in, two-step verification, app
passwords, the browser sign-in for apps), with session tokens Navidrome accepts.

Code: `src/gateway.rs`, `src/trust.rs`, `src/routes.rs`, `src/subsonic/`, `src/auth/`, `src/jwt.rs`, `src/id.rs`,
`src/secrets.rs`, `src/db.rs`, `src/startup.rs`, `src/config.rs`. What the behaviour is checked with: `README.md`, "Tests" and "Checked against the
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
  state, app passwords and the session secret from it, and writes what the sign-in routes write (below).
- Both sign and verify session tokens with the same secret. In the gateway's memory only: the sign-ins of apps
  waiting for approval, and the two limiters' counts.

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
5. **Everything under `/auth`** (`auth/`): whether a password and a second step sign a user in on the web; who the
   first admin is; a user's authenticator secret, recovery codes and app passwords; which app gets an API key through
   the browser sign-in; and for its signed-in routes, whether a session token is good.
6. **Session tokens**: it issues them (at sign-in and after the setup), with the secret Navidrome verifies them with.
7. **How much a request to Navidrome's own API may send** (4 MiB, uploads apart).
8. **Whether to run at all**: only on the database schema it knows (goose version 20260922230428, the fork's
   `sonus_*` tables, one library) and with the session secret readable. Otherwise it stops, and stops Navidrome.

## What Navidrome still decides

- `/api` (the web UI's API, user management and password changes included), the Jellyfin API (with its own sign-in
  by password, and its own tokens), shares and public links (signed with a second secret this server never reads).
- On `/api`: whether a session token is good (the same checks: signature, expiry, user, epoch, audience), and its
  renewal: every answer carries a new token good for another `SessionTimeout`. A password change there bumps the
  user's epoch, which revokes the tokens made here too (checked: `auth-routes.test.mjs`).
- The session secret itself: Navidrome makes it at its first start and would make a new one if it could not open it.
  The gateway reads it once, at start, after Navidrome is up.
- A Subsonic request signed with `jwt=` (the web UI's own calls): the gateway passes it on untouched and Navidrome
  verifies the token.
- A user named by a trusted proxy (`ExtAuth`): the gateway passes the proxy's header on, and Navidrome looks the user
  up. On the web UI's page Navidrome creates a user a trusted proxy names when there is none (its
  `handleLoginFromHeaders`); the gateway never sends its own header there. Under `/auth` the gateway itself honours a
  trusted proxy's user on the signed-in routes, as Navidrome's `Authenticator` does, and creates nobody.
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

The web sign-in is the other place that compares passwords, and it is here too: everything under `/auth` is answered
by the gateway, unknown paths and methods included (404, 405), so no spelling of a path reaches Navidrome's own
`/auth` handlers; only CORS preflights go there, which its CORS middleware answers before any route. What remains
Navidrome's own and unchanged: the Jellyfin API's sign-in by password (`/jellyfin`, when enabled), with Navidrome's
own limiter.

The two limits here are separate, as they are in Navidrome: failed Subsonic sign-ins per address and user
(`subsonic/limiter.rs`), and requests to the sign-in routes under `/auth` per address (`auth/ratelimit.rs`).

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

## The web sign-in and two-step verification

Ported from Navidrome and the fork; the design is theirs, restated here because this server now carries it out.

- **The password** is compared in constant time with the stored one, opened from the database. A wrong password and
  an unknown user get the same answer (401, `Invalid username or password`); which of the two it was is still
  observable by timing (an unknown user answers before any decryption), as in Navidrome.
- **The second step** per `Sonus.TwoFactor`: `required` (default), a user who has not set it up gets no session, only
  a setup token; `optional`, only users who set it up are asked; `off`, nobody is asked and the routes to set it up
  are refused (what was set up stays in the database).
- **The setup token** is a session-shaped JWT with `aud: sonus-2fa-setup`, good for 15 minutes. The signed-in routes
  here, Navidrome's `/api` and the Subsonic API all refuse it by its audience (checked). It lets its holder, who has
  proven the password, set an authenticator up and so get a session: that is its purpose. The setup routes also take
  a session token (a signed-in user replacing their authenticator), and then ask for a code from the one in use.
- **Authenticator codes**: RFC 6238 with SHA-1, 6 digits, 30 s, one step either side accepted. Each code signs in
  once: the step is stored, and a code for that step or an earlier one is refused (one atomic `UPDATE … WHERE
  last_step < ?`). Compared in constant time.
- **Recovery codes**: ten, 10 characters of a 31-letter alphabet each (about 49 bits), stored as unsalted sha256 (the
  fork's choice: they are random, not chosen), each used up by one atomic `UPDATE … WHERE used_at IS NULL`.
- **What limits guessing codes**: only the per-address rate limit of `/auth/login` (5 requests in 20 s by default).
  There is no per-user lockout: someone who has the password can try about 21,600 codes a day from one address
  against 3 valid ones in a million at any moment, more from more addresses. As in Navidrome and the fork; not
  changed here, and worth a decision.
- **An admin's reset** takes the admin's session and no code: it removes the user's authenticator and recovery codes,
  so with `required` the user's password alone gets a setup token again. An admin's session is thus enough to take
  over any account's second step (they can also change any password through Navidrome's `/api`).
- **App passwords** are random (16 characters of the 31-letter alphabet, about 79 bits; 32 for keys handed to apps),
  sealed like passwords so the Subsonic token sign-in can use them, shown once. They bypass the second step by
  design: that is what they are for.
- **The first admin** (`createAdmin`) can be made by anyone who reaches a server that has no user yet, with any name
  and password, empty ones included (Navidrome's behaviour, kept). Here the count and the insert are one transaction.
- **`DevAutoLoginUsername`**, Navidrome's development setting, is honoured on the signed-in routes as Navidrome
  honours it: with it set, every request is that user's.

## Session tokens

- HS256 with the secret from Navidrome's `property` table (`JWTSecret`), opened with `PasswordEncryptionKey`. The
  secret is a 22-character random id (about 128 bits). Whoever reads the database and knows the key can forge
  sessions for anyone, admins included: as before.
- Only `HS256` is accepted, whatever a token's header says (`none` and other algorithms are refused before any
  signature check); the signature is compared by the MAC in constant time; then `exp`, `iat` (not in the future) and
  `nbf`, as Navidrome's JWT library validates them.
- A token must then fit the user it names: the same user id (a deleted user's name reused by a new one does not
  inherit tokens), the user's current epoch (a password change revokes), and the audience of the API it is shown to.
- Tokens made here carry the claims Navidrome's carry and nothing more. They are not renewed here: Navidrome renews
  on `/api`. A token is good for `SessionTimeout` (48 h by default) from its last renewal, and cannot be revoked
  before that except by a password change (epoch): there is no sign-out on the server, as in Navidrome.
- The gateway reads the secret once. If Navidrome ever replaced it while running (it does so only when it cannot
  open the stored one, at its own start), the two would disagree until the next restart; they start together.
- Tokens travel in `X-ND-Authorization`, and Navidrome's verifier also takes a `jwt` cookie and `?jwt=`: so does the
  gateway on its signed-in routes, in the same order. A token in a query string can end up in logs and referrers;
  the gateway's own log has the path only.

## The browser sign-in for apps

RFC 8628's device grant, as the fork has it. An app starts a sign-in without credentials and polls with its device
code (256 random bits); a signed-in user, on the approval page, allows or refuses the sign-in that waits under the
user code the app shows (8 letters of 20, about 34 bits, valid ten minutes, read in any case and without its dash).

- The API key is made only when a signed-in user approves, belongs to that user, and is handed to the poller once.
  Two approvals at once make one key (the sign-in is held while the key is made).
- **The grant's inherent risk is here too**: someone can start a sign-in and talk a user into approving the code they
  are shown; the page shows the app's own claims (`client`, `device`), which are whatever the starter sent. The user
  code is the only tie between the app in front of the user and the request they approve.
- At most 200 sign-ins wait at a time; `start` is rate-limited per address, but several addresses can fill the 200
  and keep apps from starting a sign-in for up to ten minutes.
- `revoke` takes only the key itself: whoever has a key can delete it. That is the point (an app signing out), and
  it is rate-limited so it does not become a way to test keys quickly (the Subsonic limiter does not see it).
- Waiting sign-ins are in memory: lost at a restart, never written anywhere.

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

- Opened read-write. Written: an app password's `last_used_at`/`last_used_by` (as Navidrome notes it), a user's
  `last_access_at` for `tokenInfo` and `last_login_at` at a web sign-in, at start the key hash of app passwords made
  before API keys existed, the first admin (a `user` row and its `user_library` rows), and the fork's own tables
  (`sonus_two_factor`, `sonus_recovery_code`, `sonus_app_password`). Each write is one short `BEGIN IMMEDIATE`
  transaction; every statement is parameterized.
- No schema change, ever, and no VACUUM; the schema is checked at start and the server refuses any other.
- Until that check has passed, sign-in requests and everything under `/auth` are answered 503: they are neither
  checked against an unknown schema nor handed to Navidrome with their credentials.
- **The start-up probe.** Navidrome settles its password encryption lazily, at its first use of the user store: when
  `PasswordEncryptionKey` is set and it has not noted that key yet (a new database, or a key newly set), it
  re-encrypts every password it finds, assuming the default key, and keeps using the default key if that fails. A
  first admin written here before that moment was sealed with the configured key and became unreadable to Navidrome
  (found by `auth-routes.test.mjs`). So at start, before anything is answered here, the gateway sends Navidrome one
  Subsonic sign-in as nobody (`sonus-server-start-probe`, a random password), which makes Navidrome open its user
  store. It shows in Navidrome's log as one invalid login per start, from 127.0.0.1.
- SQLite is the bundled copy (rusqlite), not the image's: its version is this crate's `Cargo.lock`.

## The answers given here

- On `/rest`: errors and `tokenInfo` only, in Navidrome's bytes. Reflected input: the `callback` of a JSONP answer, accepted only
  when it matches Navidrome's own pattern (`^[a-zA-Z_$][a-zA-Z0-9_$.]*$`), else a JSON error; the missing parameter's
  name, which is one of three constants; the user name in `tokenInfo`, from the database, escaped as Go's JSON and XML
  encoders escape it.
- Under `/auth`: JSON built from values, never by pasting text; what comes from a request and goes back out is the
  user's own name, app password names and the app's `client`/`device` (cut to 40 and 64 characters), inside JSON
  strings. The web UI renders them as text.
- The headers Navidrome's middlewares add: `X-Content-Type-Options: nosniff`, `X-Frame-Options`, `Referrer-Policy`,
  `Permissions-Policy`, and CORS open to every origin without credentials (`Access-Control-Allow-Origin: *`), as
  Navidrome has it for the whole server.

## Denial of service

- A form is read into memory before it is checked, up to 10 MiB (Navidrome's own limit), by anyone, signed in or not.
  Many at once cost memory: as in Navidrome, and bounded per request. Under `/auth` at most 8 KB is read.
- A body to `/api` or `/jellyfin` declared over 4 MiB is refused; the gateway then reads and discards up to 32 MiB of
  it, for at most 10 s, so the client receives the 413 instead of a reset connection.
- The `/auth` rate limiter keeps one small count per address seen in the last two windows.
- Each sign-in check is a blocking database task (a few indexed reads, AES-GCM over a few short strings). A flood of
  requests queues on tokio's blocking pool; nothing here caps the total, as nothing does in Navidrome.
- A slow client is cut after 30 s without complete headers (phase 0). Request bodies and responses stream.

## Where the gateway knowingly differs from Navidrome

`README.md`, "Sign-ins" and "The `/auth` routes", list them: constant-time comparison; an undecryptable password
matches nothing; both keys tried for passwords; a user name that is not UTF-8 refused here; a malformed
`Content-Type` answered after the sign-in check instead of before; the gateway's own answers uncompressed; key hashes
filled at start; one first admin when several are asked for at once; the QR code's pixels; a simpler title-casing of
the first admin's display name; 413 for a body cut off at the limit. None widens what signs in: each either refuses
more or changes nothing about who is accepted, except the second key, which only opens what was sealed with the
public default key.

## Running in front of a Navidrome it did not start

With `SONUS_NAVIDROME_URL` the gateway checks nothing, answers nothing under `/auth` and writes no user header of its
own: that Navidrome has its own settings and database, and the gateway cannot know it believes the header from the
gateway alone. Everything passes through, as in phase 0; only the 4 MiB limit on bodies to `/api` applies.

## Not covered by tests

- The image and Linux builds are built by CI, not run by these tests; the checks ran on Windows.
- `BaseURL` with a path in front of the real Navidrome (tested with the fake one).
- Concurrency under load: the limiters' and the database's behaviour with hundreds of simultaneous sign-ins.
- `EnableGravatar` and `DevAutoLoginUsername` against the real Navidrome; the QR code read by a real authenticator
  app; session tokens across a `PasswordEncryptionKey` change.
- A database written by Navidrome while the gateway writes (both use WAL and a 15 s busy timeout; not stress-tested).
