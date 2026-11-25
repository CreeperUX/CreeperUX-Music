# Sonus server: security decisions and trust boundaries

For whoever reviews this server's security: what it decides, what Navidrome still decides, whom each believes, and
what could go wrong. It describes the code as it is after phases 1 and 2 (`docs/server-roadmap.md`): the gateway
(phase 0), Subsonic sign-ins checked here, the `/auth` routes answered here (web sign-in, two-step verification, app
passwords, the browser sign-in for apps), with session tokens Navidrome accepts, and Sonus Connect version 2 answered
here (one playback session per user, on a WebSocket).

Code: `src/gateway.rs`, `src/trust.rs`, `src/routes.rs`, `src/subsonic/`, `src/auth/`, `src/connect/`, `src/jwt.rs`, `src/id.rs`,
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
  waiting for approval, the two limiters' counts, and Sonus Connect's devices (its sessions are in the database).

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
   `sonus_*` tables, one library; its own tables at the version it writes) and with the session secret readable.
   Otherwise it stops, and stops Navidrome.
9. **Sonus Connect version 2** (`connect/`): who a WebSocket at `rest/connect?protocol=2` belongs to, each user's
   playback session and what its devices are sent, and what of it is kept in the database.
10. **What `getOpenSubsonicExtensions` lists**: Navidrome's answer, with `sonusConnect` version 2 added.

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

**What an account password is worth on the API** follows the policy, not only the account
(`subsonic/credentials.rs`, `password_alone`): with `required`, nothing, for every user; with `optional`, the API
until its user sets two-step verification up; with `off`, the API. Under `required` the fork still took the password
of a user who had not set two-step verification up, which left the enrolment code guarding only the web: the password
alone could not enrol an authenticator, yet it signed every API call. Now a password alone reaches the set-up token
and, with the enrolment code, the set-up; the refusal is the wrong-password answer and a counted failure, so it does
not tell whether the password was right or whether the user has set anything up. What still signs for a user who
has not set it up: an app password or API key the account was given earlier (by a trusted proxy's user, or while the
policy was `optional`), as for anyone. A session token from such an earlier time is Navidrome's to check (`jwt=`),
as before.

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
  here, Navidrome's `/api` and the Subsonic API all refuse it by its audience (checked). Its holder has proven the
  password and nothing else, so by itself it sets nothing up (next point). The setup routes also take a session
  token (a signed-in user replacing their authenticator), and then ask for a code from the one in use.
- **A first set-up takes an enrolment code** while two-step verification is required (README, "Codes a session alone
  does not replace"): before it, whoever first had an unenrolled account's password could enrol their own
  authenticator, keep the recovery codes, and leave the owner asked for a code only the attacker has. The code is
  random (12 characters of 31, about 59 bits), kept as an unsalted sha256 (as recovery codes: random, not chosen)
  in `sonus_enrolment_code`, good for seven days, one per user, checked in constant time at `setup` and again at
  `confirm`, where it is deleted in the transaction that turns the authenticator on (`DELETE … WHERE code_hash = ?
  AND expires_at > ?`: two confirmations at once enrol one). Ten wrong ones per account in an hour, then none is
  looked at. What it does not close: the admin's channel to the user carries the code and the password together, so
  whoever reads that message has both; an attacker with the password can spend the ten guesses every hour and keep
  the owner's set-up refused (429), as with verification codes; and under `optional` the password alone still signs
  in and can turn two-step verification on for itself, which is what `optional` means.
- **The first admin's token**: `createAdmin` answers a setup token with a second audience
  (`sonus-2fa-first-admin`) that sets up without an enrolment code, for 15 minutes, for the account that request
  made. Anyone who reaches a server with no users can make that account anyway (below). Afterwards the way in is
  the server's command line (`sonus-server enrolment-code`), which trusts whoever can run it: they can write the
  database file themselves.
- **Authenticator codes**: RFC 6238 with SHA-1, 6 digits, 30 s, one step either side accepted. Each code signs in
  once: the step is stored, and a code for that step or an earlier one is refused (one atomic `UPDATE … WHERE
  last_step < ?`). Compared in constant time.
- **Recovery codes**: ten, 10 characters of a 31-letter alphabet each (about 49 bits), stored as unsalted sha256 (the
  fork's choice: they are random, not chosen), each used up by one atomic `UPDATE … WHERE used_at IS NULL`.
- **What limits guessing codes**: the per-address rate limit of `/auth/login` (5 requests in 20 s by default), and
  per account ten wrong verification codes in an hour, from anywhere and on any route that takes one (the sign-in,
  the set-up of a replacement, recovery codes, turning it off, allowing an app, an app password, an admin's reset or
  enrolment code): then no code is looked at for the rest of the hour. Kept in memory: a restart forgets. Someone
  who has the password can keep the owner's codes refused this way; nobody is told.
- **An admin's reset** takes the admin's own verification code besides the session (when the admin has two-step
  verification): it removes the user's authenticator and recovery codes, and where two-step verification is required
  answers the enrolment code the user sets it up again with. An admin's session alone no longer takes over an
  account's second step. (An admin can still change any password through Navidrome's `/api`, which asks for no
  code: with `required` that password alone now gets a setup token and no further.)
- **App passwords** are random (16 characters of the 31-letter alphabet, about 79 bits; 32 for keys handed to apps),
  sealed like passwords so the Subsonic token sign-in can use them, shown once. They bypass the second step by
  design: that is what they are for. So making one takes a verification code from an account that has two-step
  verification: a session (stolen, left open, opened before two-step verification was on) does not mint a
  permanent key. A sign-in may ask for one in the same request (`appPassword`): password and code were checked by
  that request, so it is the same proof in one step, not a way around it.
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
- **The grant's inherent risk is here too**, with a higher bar: someone can start a sign-in and talk a user into
  approving the code they are shown. The page shows the app's own claims (`client`, `device`), which are whatever
  the starter sent, and the address the request came from, which the starter does not choose (the gateway's decided
  client address; behind a proxy the server is not told about, it is the proxy's). Allowing takes a verification
  code from an account that has two-step verification, so a click on a link is not enough; a user who is talked
  into typing a code too still hands the key over. The user code is the only tie between the app in front of the
  user and the request they approve.
- Five sign-ins wait per address and 2000 in all, the oldest unapproved giving way, so a new sign-in always gets a
  place; with several hundred addresses the list can still be turned over faster than a user approves.
- `revoke` takes only the key itself: whoever has a key can delete it. That is the point (an app signing out), and
  it is rate-limited so it does not become a way to test keys quickly (the Subsonic limiter does not see it).
- Waiting sign-ins are in memory: lost at a restart, never written anywhere.

## Sonus Connect version 2

`src/connect/`; the protocol is `docs/protocol/connect.md`. A WebSocket at `rest/connect?protocol=2`, answered here
whole: Navidrome never sees it.

**Who a connection is.** The user whose Subsonic credentials are in the upgrade request's query, checked by
`Subsonic::sign_in`: the same function, limiter and answers as for every Subsonic request ("One place decides every
credential check" holds). There is no connection without a signed-in user: a refused sign-in is answered before any
upgrade, with Navidrome's error. A session token (`jwt`) is not taken (401), and neither is a trusted proxy's user
header: version 2 asks for credentials even behind a proxy that signs users in. Credentials are in the query, so the
log lines carry the path only, as everywhere; the user's name and the device's id are logged at debug level.

**What a signed-in device can do.** Everything to its own user's session: play, queue, seek, transfer, set the
volume of any of that user's devices, close that user's other connections by connecting with their device id (4000)
or as a 33rd device (4001). That is the protocol: every device of a user steers the one session.

**What it can do to another user's session: nothing.** A connection is bound to its user's room when it is accepted
(`Inner::attach`, by the user id the sign-in gave) and never to another: no message carries a user, and device ids
are looked up in that room only, so another user's device id is "offline" (`transfer`, `volume`), even when two
users' devices have the same id. Broadcasts go to the room's own connections. Song ids a user sends are checked
against the library as that user sees it (admin: all; otherwise `user_library`), so a session never holds, and `now`
never shows, a song the user could not read through the Subsonic API; an id they cannot see is the same as one that
does not exist. The stored row is keyed by the user id.

**What comes from a device and goes back out**, to that user's devices only: the device's name (80 characters),
`client` (120), `kind` (one of six), the context's `kind`/`id`/`label` and a `loaded` report's `now` (strings, as
sent, bounded by the frame size), `ref` (echoed to its sender), and song ids the library has. All inside JSON built
from values. A user can show their own other devices any text; clients render it as text.

**Limits.**

| What | Limit |
|---|---|
| a message | 1 MiB (the frame and the whole message); more closes the connection (1009) |
| JSON nesting | 128 levels (deeper is not a message: ignored) |
| devices per user | 32 (the 33rd closes the one silent longest) |
| connections per user that have not said hello | 8 (one more is closed, 1013), each for at most 10 s |
| the context, the hand-queued songs | 10,000 and 1,000 ids |
| messages waiting to be written to one device | 256; a device that does not read is dropped (as a network loss), and a write that takes over 30 s ends the connection |
| silence | a ping every 30 s; nothing heard for 75 s cuts the connection |
| a session in memory | only while the user has a connection, a grace period running or an unwritten change |
| one row per user | the session without its lists (a few hundred bytes) and the lists (up to 21,000 ids) |

Messages of one connection are applied one at a time (the next is not read before the last is applied), and all of
one user's under that user's lock: a user's devices cannot race each other into an inconsistent session, and a flood
from one device slows that user's session, not another's. What a message can cost: a `playContext` or `mode` looks
up to 10,000 ids up in the library (one indexed read each), an `add` reads until 1,000 are found or its list ends
(a 1 MiB list of ids nobody has is about 260,000 reads: the largest thing one message can ask for); every change
sends the session, and a queue change the queue (up to 10,000 ids), to up to 32 devices. All of it is a signed-in
user spending the server's time on their own session; nothing here caps messages per second.

**The connection's life.** Credentials are checked when it opens, not again: changing a password or revoking an app
password does not close the connections it opened (as with Navidrome's version 1, and any stream already running).
Once a minute each connection's user is checked to still exist; a deleted user's connections are closed (1008), and
their row goes with them (`ON DELETE CASCADE`).

**Origins.** No `Origin` check: the WebSocket is opened with credentials in its URL, not with cookies, so a page of
another origin has nothing to ride on (the same as the Subsonic API's open CORS).

## The library's reads

`src/library/`; what is answered is in `README.md`, "The library's reads". Read-only: the only write is the user's
last access, as for `tokenInfo`.

**Who reads.** Only a request the sign-in check let through gets here (`Outcome::SignedIn`), as the user it signed in
as; a refused request is answered before anything is read (`tests/library.rs`). A session token (`jwt`) and a trusted
proxy's user are still Navidrome's, as for every Subsonic method.

**What a user can read: what Navidrome would show them, and nothing else.**

- **Libraries.** The queries carry Navidrome's own two filters (`query.rs`): the libraries granted to the user
  (`user_library`), and for anyone but an admin who is not granted every library, the subquery over `user_library`.
  With one library (decision 4) that is: an admin sees it, anyone else sees it when it is granted. A user without it
  gets 70 for a song or an album and empty lists (`tests/library.rs`).
- **Other users' state.** Stars, ratings, play counts and bookmarks are joined for the signed-in user's id only, which
  comes from the sign-in check, never from the request.
- **By id.** `getSong` and `getAlbum` answer by id whatever the item is: an item marked missing is shown, as Navidrome
  shows it (lists leave missing ones out, as Navidrome's do).
- **The user's row is read again** for every request (admin or not, the libraries): a change in Navidrome counts at
  the next request. A user deleted since the sign-in check gets Navidrome's answer.

- **Playlists.** A playlist is shown to its owner, to everyone when it is public, and to an admin: Navidrome's rule,
  in the query. Someone else's private playlist answers 70, as an id that does not exist. A playlist's songs are
  filtered by the reader's libraries like any song.
- **The play queue** is read by the signed-in user's id only: nobody reads another user's.
- **Artists** are those with content in a library the user sees (the join over `library_artist` and
  `user_library`, as Navidrome joins them).

- **Lyrics** are a song's: read only for a song the user may see.
- **Covers.** A picture is served for an item that is there for this user (the same check Navidrome makes); for
  anything else the request goes to Navidrome, which answers with its placeholder.

**Files.** Lyrics and covers are the first answers that read files. No part of a request becomes a path:

- a lyrics file is only *looked for* (does it exist?), at the song's own path from the database with one of the
  suffixes of `LyricsPriority` from the settings; it is never read here, and the answer does not say what was found
  (a song with such a file is answered by Navidrome, as before);
- a picture's file is the path Navidrome's artwork state holds (`item_artwork.source_path`, written by Navidrome's
  scanner), read only when its change time is the one Navidrome noted;
- the image store's and the cache's paths are built from the picture's hash, which is taken from the database and
  must be 16 hexadecimal digits before it is used, and from a SHA-1 of the cache key.

What is read is sent only when its first bytes are a JPEG, PNG, GIF or WebP picture, with `nosniff`. A file is read
whole into memory before it is sent, at most 64 MiB; a signed-in user can ask for many at once, as they can of
Navidrome.

**What is typed into a search.** It never becomes SQL: it is bound as an argument, either inside LIKE patterns or as
one FTS5 MATCH expression. The expression is built by a port of Navidrome's `buildFTS5Query`, which keeps only
letters, numbers, quoted phrases and a trailing `*`, and turns FTS5's operators into plain words; the port passes
every case of Navidrome's own test, and the corpus sends it FTS5 syntax (`{title}: x`, `x)`, `NOT x`, `"`, `x;drop`)
with the same answers from both servers. Were an expression refused by SQLite all the same, the request would go to
Navidrome. A search costs what it costs in Navidrome: the same statements, the same limits (none on the counts:
`songCount=-1` lists everything, as in Navidrome).

**The queries.** Their text is built from constants: the list types, the sort keys and the settings choose among
fixed fragments, and no part of a request is ever pasted into SQL. Everything a request brings is bound as an
argument: ids, years, the genre. The genre is matched with LIKE, as Navidrome matches it, so `%` and `_` in it are
wildcards: over genre names only, of albums the user may see anyway.

**The registration at Navidrome.** For a request answered here the server sends Navidrome a `ping` under the
gateway's own user header (`player.rs`): only after the sign-in check, with the name that check produced, to
`127.0.0.1` only. It forwards the client's `Cookie` and `User-Agent` (what Navidrome finds the player by) and the
client address the gateway decided; never the credentials, which are not part of it. The cookie Navidrome answers
with is handed to the client and remembered for a minute under the user's name, the client name, the `User-Agent` and
the cookies sent: a request by another user never matches that entry, and the remembered player is used only while
its row is still that user's and that client's. The cookie itself is Navidrome's (`HttpOnly`, `SameSite=Strict`): it
names a player, and signs nobody in.

**What the answers reflect.** Text from the database (tags, names) and, in errors, a parameter's value (`type 'x'
not implemented`, `expected integer, got 'x'`), always inside JSON strings written with Go's escaping (`<`, `>`, `&`
as `\u003c`…), with `Content-Type: application/json` and `nosniff`. JSONP and XML are not made here.

**Who answered** is marked on the answer (`X-Sonus-Answered: rust`) in debug builds only, for the tests. A release
build, which is what the image holds, sends Navidrome's headers and nothing more.

**Cost.** A list is at most 500 albums, or all of them for a `size` of 0 or less, as in Navidrome; the random list
reads every visible album's id first. Each request is one blocking database task, as a sign-in check is; nothing caps
their number, as nothing does in Navidrome. Answers are compressed (gzip) for clients that ask, in memory, after they
are made. Remembered players: at most 4,096 entries, each a few hundred bytes, dropped when older than a minute.
Random seeds: one number per user who asked for a random list, until the server stops. Only signed-in users reach any
of it.

**When this server is not sure**, it does not answer: the request goes to Navidrome, signed in, as before this phase
(the list is in the README). That path adds nothing: it is the path every method took until now.

## The library's writes

`src/library/writes.rs`; what is answered is in `README.md`, "The library's writes". Only a request the sign-in check
let through gets here, as the user it signed in as, the same path as the reads.

**What a signed-in user can write: their own rows, nothing else.**

- `annotation`: only rows whose `user_id` is the signed-in user's. The user is never a parameter: it is who signed in.
- The item's `average_rating` (`setRating`): the one column of a shared row written, recomputed from every user's
  ratings in the database, as Navidrome does; the user only adds or changes their own rating.
- `playqueue`: only the signed-in user's row (deleted and written again, as Navidrome does).
- `playlist` and `playlist_tracks`: a new playlist is the user's own; an existing one only when the user owns it (an
  admin: any), as Navidrome's `checkWritable`; one the user does not see is "not found", someone else's they see
  (public) is refused (50). The songs added are only those the user can read (Navidrome's `keepAccessible`), so a
  playlist cannot be used to learn of songs in a library the user is not granted. `artwork_queue`: one row per
  changed playlist, for Navidrome's artwork worker, as Navidrome writes it. Smart playlists, and a playlist with an
  uploaded cover being deleted (a file), stay Navidrome's.
- An item is looked up as the user sees it (the library filter; a playlist their own or public, all for an admin), as
  Navidrome's `GetEntityByID` does: what a user cannot see they cannot star or rate (a rating answers 70, a star skips
  it), so a write tells them nothing they could not read.
- The queue's ids are kept as given, unchecked, as Navidrome keeps them: the column is the user's own, and what reads
  it back (`getPlayQueue`) shows only songs that are there and that the user sees.

**How.** Every value is a bound parameter; the only names put into SQL text are table names from a fixed list (the
kind of item found). One `BEGIN IMMEDIATE` transaction per request, rolled back on any error. A request's ids are as
many as its query or form holds (a form is read up to 10 MiB, as Navidrome reads it); each is one indexed lookup.

**Plays and now playing.** A play is counted only for the signed-in user (their annotation rows, their `scrobbles`
rows) and only for a song they see; the time is theirs to give, as in Navidrome (a client may count a play at any
time, past or future). What is playing now is kept in memory, one session per player (or web UI tab id, a value the
client chooses, as Navidrome takes it), replaced by the next report of that client: at most one per player and tab,
each a song row and a few numbers, dropped at its time to live. `getNowPlaying` shows a user only the sessions in the
libraries they see (every one to an admin), with the name of the user who plays, as Navidrome does.

**Not sent:** the `refreshResource` events Navidrome's web UI gets on a star, a rating or a play, the now-playing
count (decision 2), and anything to Last.fm, ListenBrainz or plugins (decision 3).

## Media: songs' files

`src/library/stream.rs` (phase 5); what is answered is in `README.md`, "Media". This is the first code here that reads
files by what a client asks for, so the whole path is written down.

**No path comes from the client.** The client sends a song's id (`id`), nothing else that names a file. The id is one
bound parameter of the same query `getSong` runs, as the signed-in user: a song in a library the user is not granted
is "not found" (70), exactly as in Navidrome, before anything is opened. The file is the song row's `path` joined to
its library's `path`, both written by Navidrome's scanner. Before opening it, the stored path must be relative and
made of plain names only (no `..`, no root, no drive or UNC prefix: `inside_library`); any other row is left to
Navidrome, which serves it as before (so this adds a check and removes none). Symbolic links inside the library are
followed, as Navidrome follows them: a library is the owner's folder, and a link in it is the owner's choice.

**What is opened.** One read-only file per request, through the operating system's normal permissions of the server
process; a path that is not a regular file is left to Navidrome. Nothing is written. The file is read as it is sent,
64 KiB at a time, so a request costs one open file and one buffer, whatever the file's size; a slow client holds them
until it reads or the connection ends (as Navidrome).

**The request's headers.** `Range` and the `If-…` conditions are parsed by code ported from Go's `net/http`, checked
against Navidrome on every edge in the corpus (empty, reversed and overflowing ranges, suffixes longer than the file,
spaces, signs, past the end, several parts; the three date layouts, bad dates, entity tags). The numbers are 64-bit
and checked, so a range can never point outside the file: a start past the end is "416", an end past it is cut to the
last byte. Several ranges in one request (a multipart answer) are left to Navidrome. A date in a zone that Go would
look up in the server's own time zone is left to Navidrome rather than guessed.

**What is answered.** The file's bytes, the headers `http.ServeContent` sets, and Navidrome's usual headers
(`X-Content-Type-Options: nosniff` among them, so a browser never sniffs a file into something else); the content type
comes from Navidrome's own table by the song's suffix, never from the file's contents. Nothing from the request is
reflected except the numbers of a range.

**Left to Navidrome, as before:** downloads (`download`, not used by Sonus clients), and every error Navidrome words
with a path in it (a file that cannot be opened).

## Media: resizing covers

`src/library/resize.rs`, the resize path of `src/library/media.rs`. The picture comes only from where Navidrome's
artwork state says (its folder file, with the modification time Navidrome noted, or its image store), as for the full
size (above): no path from the client, which names an item by kind and id.

**Decompression bombs.** At most `MaxImageSize` bytes (Navidrome's setting, default 20 MB) are taken to resize; a
larger picture is Navidrome's. Before anything is decoded the picture's declared width and height are read, and a
canvas over 64 Mi pixels (Navidrome's `maxImagePixels`) is not decoded at all: the original is served as it is, as
Navidrome does. The decoder is also told the declared size as its limit and a cap on what it may allocate, so a file
whose frames claim more than its header cannot make it allocate more. Only JPEG, PNG, GIF and WebP are decoded (the
`image` crate, pure Rust); anything else is served as it is. An animated GIF (which Navidrome turns into an animated
WebP with ffmpeg) is Navidrome's; animated WebP and PNG are served as they are.

**CPU and memory.** At most two resizes at once, on blocking threads; a request waits at most 10 s for its turn
(Navidrome gives `getCoverArt` 10 s), then goes to Navidrome. The output is never larger than the size asked for nor
than the picture (never enlarged), so it is at most the original's pixel count.

**The cache.** Resized covers are kept in a folder of this server's own (`<CacheFolder>/sonus-images`), bounded by
`ImageCacheSize` (Navidrome's; `0`: none), the same file cache as the transcoding cache (named by the SHA-256 of the
representation's key, written whole then renamed, least recently used out first). Navidrome's own cache of resized
covers is still read first and never written.

**Placeholders.** Navidrome's two placeholder pictures are compiled in and served as they are, with
`Cache-Control: no-store` and no validators, exactly where Navidrome serves them: no id, an item settled without a
picture, an item the user does not see or that is gone. They say nothing about the item beyond "no picture for you",
as Navidrome's do.

## Media: transcoding

`src/library/transcode.rs` (the decision, ffmpeg's arguments), `src/library/transcoder.rs` (the processes, the caps,
the cache). The first code here that starts programs.

**What runs.** Only the program found as Navidrome finds it (`FFmpegPath`, else `ffmpeg` on the `PATH`), only for
Navidrome's four built-in transcodings (mp3, opus, aac, flac) and only while the stored command for that format is
Navidrome's built-in one: a command of the owner's own is a template with `%s`, which only Navidrome fills in (it
stays Navidrome's). The program is started directly, never through a shell, with a fixed list of arguments; what
comes from the request is numbers only (the bit rate, the offset), each parsed as an integer, and the target format,
which must be one of the four. The file is the song's (the same lookup and path check as for its own bytes) and is
given to ffmpeg as `file:<absolute path>` with `-protocol_whitelist file` and `-nostdin`: a stored path cannot be read
as an option or as another protocol, and nothing in the file (a playlist, an `ffconcat`, an HLS manifest posing as
audio) can make ffmpeg open anything but local files. Standard input is closed; standard error is kept to 4 KB, for
the log only.

**Bounds.** At most 16 ffmpeg processes at once, and Navidrome's `Transcoding.MaxConcurrent` and
`MaxConcurrentPerUser` below that when they are set (over a cap: 429 with `Retry-After: 5`, as Navidrome answers). A
process that writes nothing for 60 s is killed; one that writes more than 4 GiB is killed. A process whose client has
gone is killed at once unless its output is going into the cache (as Navidrome lets it finish then, by default); with
Navidrome's caps or `Transcoding.EnableCancellation` set it is killed in any case, as Navidrome does. Processes are
killed when their task ends for any reason (`kill_on_drop`).

**The cache.** A folder of this server's own (`<CacheFolder>/sonus-transcoding`, beside Navidrome's), bounded by
`TranscodingCacheSize` (Navidrome's setting; `0` turns it off): an entry is written to a file of its own and renamed
when ffmpeg ended well, so a half-written entry is never served (and is deleted at the next start); the least recently
used entries are deleted when the total is over the size, and an entry bigger than the whole cache is not kept. Its
name is the SHA-256 of the stream's key (the song's id and time, the bit rate, sample rate, bit depth, channels, format
and offset): nothing from the client names a file there. A cached entry is served like the song's own file (ranges,
conditions). One writer per entry; a second request while it is written runs a transcode of its own, uncached.


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
  `last_access_at` for `tokenInfo` and for the library's reads answered here, and `last_login_at` at a web sign-in, at start the key hash of app passwords made
  before API keys existed, the first admin (a `user` row and its `user_library` rows), and the fork's own tables
  (`sonus_two_factor`, `sonus_recovery_code`, `sonus_app_password`). Each write is one short `BEGIN IMMEDIATE`
  transaction; every statement is parameterized.
- Two tables of the server's own, made at the first start and written by nobody else: `sonus_server_schema` and
  `sonus_connect_session` (a user's Connect session, as JSON). Sonus Connect reads `media_file`, `user` and
  `user_library` and writes only its own table. What it stores came from the user's own devices and is read back as
  data: parsed as JSON, checked for shape and size, and a row that does not pass starts an empty session.
- The library's reads (above) read `album`, `media_file`, `artist`, `library_artist`, `annotation`, `bookmark`,
  `item_artwork`, `album_tags`, `tag`, `playlist`, `playlist_tracks`, `playqueue`, the three FTS5 tables, `library`,
  `user`, `user_library` and `player`, and write none of them. The library's writes (above) write `annotation` (the
  user's own rows), the `average_rating` of `media_file`, `album`, `artist` and `playlist`, `playqueue` (the user's
  own row), `playlist` and `playlist_tracks` (the user's own playlists, an admin's: any), `artwork_queue` (a changed
  playlist's cover) and `scrobbles` (the user's own plays), and read `radio` to find an id as Navidrome does and
  `player.scrobble_enabled` for a stopped playback. Covers read `item_artwork` and `artwork`, and files:
  the pictures Navidrome's state names, its image store and its cache of resized pictures. Streams read `media_file`
  and `library` as `getSong` does, `player.max_bit_rate` and `transcoding_id`, `transcoding` (a player's row, and a format's command and default bit
  rate), and a song's file (above). Nothing is written there either; the only files written are the transcoding
  cache's, in its own folder.
- No change to Navidrome's schema, ever, and no VACUUM; the schema is checked at start and the server refuses any
  other. The server's own tables are additive (`CREATE TABLE IF NOT EXISTS`); a `sonus_connect_session` row refers to
  its user (`ON DELETE CASCADE`), which adds one indexed lookup to Navidrome's deleting of a user and nothing else.
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

- On `/rest`: errors, `tokenInfo`, and the library's reads (their own section above), in Navidrome's bytes. Reflected input: the `callback` of a JSONP answer, accepted only
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
- Sonus Connect's limits per connection and per user are in its section above: only signed-in users reach them.
- `getOpenSubsonicExtensions` (no sign-in) is read whole from Navidrome before it is answered, up to 1 MiB (it is a
  few hundred bytes).

## Where the gateway knowingly differs from Navidrome

`README.md`, "Sign-ins" and "The `/auth` routes", list them: constant-time comparison; an undecryptable password
matches nothing; both keys tried for passwords; a user name that is not UTF-8 refused here; a malformed
`Content-Type` answered after the sign-in check instead of before; the gateway's own sign-in answers uncompressed; key hashes
filled at start; one first admin when several are asked for at once; the QR code's pixels; a simpler title-casing of
the first admin's display name; 413 for a body cut off at the limit; and, since the security review, the rules that
ask for more than Navidrome did: no header signs anyone in unless one is named, sessions end when two-step
verification is turned on, an enrolment code for a first set-up, a verification code to allow an app, make an
app password or reset a user, and no account password on the API where two-step verification is required. None widens what signs in: each either refuses more or changes nothing about who is
accepted, except the second key, which only opens what was sealed with the public default key, and the app password
a sign-in may ask for, which that sign-in's own password and code would have got in a second request.

## Running in front of a Navidrome it did not start

With `SONUS_NAVIDROME_URL` the gateway checks nothing, answers nothing under `/auth` and writes no user header of its
own: that Navidrome has its own settings and database, and the gateway cannot know it believes the header from the
gateway alone. Everything passes through, as in phase 0; only the 4 MiB limit on bodies to `/api` applies.

## Not covered by tests

- The library's reads: a cache entry Navidrome removes or rewrites while this server reads it (Navidrome marks an
  entry complete only when it is whole, and that mark is required; a removal in between fails the read, and the
  request goes to Navidrome); an artist with a picture against the real Navidrome (unit and integration tests only);
  settings other than the defaults against the real Navidrome (unit and integration tests
  only); a scan writing while lists are read; a database of production's size; `ReportRealPath` answered here against
  the real Navidrome (Linux only: the checks ran on Windows, where such requests go to Navidrome).

- The image and Linux builds are built by CI, not run by these tests; the checks ran on Windows.
- `BaseURL` with a path in front of the real Navidrome (tested with the fake one).
- Concurrency under load: the limiters' and the database's behaviour with hundreds of simultaneous sign-ins.
- `EnableGravatar` and `DevAutoLoginUsername` against the real Navidrome; the QR code read by a real authenticator
  app; session tokens across a `PasswordEncryptionKey` change.
- A database written by Navidrome while the gateway writes (both use WAL and a 15 s busy timeout; not stress-tested).
- Sonus Connect: many users or devices at once, a device that stops reading (the outbox's limit is reasoned, not
  tested), a flood of messages from one device, a proxy in front of the WebSocket, the real clients against this
  server, and the 30 s ping and 75 s timeout at their real lengths.
