# Server contract tests and the differential runner

How the Rust server is proven to answer as the frozen Navidrome does (`docs/server-roadmap.md`, principle 4):

- **The contract suite** (`test/`, `node:test`): black-box checks of what Sonus clients rely on, given a base URL and a
  manifest. It passes against the frozen Navidrome on the golden database, and through the Rust gateway.
- **The differential runner** (`diff.mjs`): the same requests against two servers on copies of the same database, the
  answers normalized and compared field by field.

Both run on `tools/fixtures/` (the fixture library and the golden database). Node 24, no dependencies.

## Quick start

```sh
node tools/fixtures/build.mjs                 # once: the library, the golden database, its manifest
node tools/contract/run.mjs                   # the suite against Navidrome on a fresh copy of it
node tools/contract/diff.mjs --go-vs-gateway  # Navidrome vs the Rust server running another Navidrome
node --test tools/contract/gateway.test.mjs   # what only the Rust server decides: the sign-in limit, what Navidrome never sees, who answers the library's reads, Connect 2 across a restart
node --test tools/contract/auth-routes.test.mjs   # /auth on servers of their own: a new server, optional/off, limits
node tools/contract/web-ui.check.mjs          # the old web UI, headless, through the Rust server (--go: Navidrome alone)
node --test tools/contract/security/findings.test.mjs tools/contract/security/hardening.test.mjs   # the security review's findings and decisions
```

## Running the suite

| Command | Against |
|---|---|
| `node tools/contract/run.mjs` | the frozen Navidrome on a fresh copy of the golden database (started, then stopped and removed) |
| `node tools/contract/run.mjs --through-gateway` | the Rust server (`cargo run` in `server/`) running the frozen Navidrome on a fresh copy of the golden database, as its image does: it checks the sign-ins |
| `node tools/contract/run.mjs --base <url> --manifest <file>` | a server that runs already (the Rust server, later) |
| `node tools/contract/run.mjs --demo` | the demo server (`tools/demo-server`), with `manifests/demo.json` |

Add `--only <name pattern>` or test file names (`run.mjs auth connect`) to run part of it. The files run one at a time:
some tests change the user's state and put it back (stars, the play queue, playlists they make); plays they scrobble
stay. Run against a long-lived server, the starting-state tests (`manifest.state`) hold only until something else
changes that state.

A **manifest** tells the suite who signs in and what to look for: `users` (`primaryUser` signs in with a token), and,
for the golden database, `ids` by key, `expect`, `counts`, `state`, `covers` (`tools/fixtures/README.md`). Tests that
need a key or a user the manifest lacks are skipped, so the suite runs against another catalogue (the demo server's)
and looks its entities up through the API; ids are never written into the tests. A manifest's `knownDifferences` lists
tests that server is not expected to pass, and why (`manifests/demo.json`: ten things the demo server does not do as
Navidrome does); `run.mjs` prints them and skips them.

| File | Covers |
|---|---|
| `basics` | `ping` (and `ping.view`), `getOpenSubsonicExtensions` without signing in, `getScanStatus`, CORS on `/rest` and the browser sign-in |
| `auth` | `t`/`s`, `p`, `p=enc:`, the name in any case; wrong password 40, unknown user 40, `enc:` that is not hex 40, no `u` 10, `u` alone 40, no `v` or `c` 10 whatever the password, `p` checked when `p` and `t` both come, missing parameters 10 (and 70 for `getAlbum`/`getSong` without an id); `apiKey` with `tokenInfo`, 43 with `u`/`p`/`t` and for mixed credentials before any is checked, 44 unknown; an app password as an API key; `tokenInfo` after a password sign-in; CORS on a refusal; the two-step user: account password 40 (all three ways, and as an API key 44), app password as `p`, `enc:` and token, with or without dashes |
| `library` | `getAlbumList2` paged (alphabeticalByName, the same in pages of 3) and its other types, the random list (every album once over the pages of one pass, another order on another pass), `X-Total-Count`; `search3` with the empty query paging the whole library (each song once, the same in pages of 4) and with words; `getAlbum` (disc and track order), `getSong`; the fields the clients map (`web/src/api/subsonic.js`, `src/Sonus.Core`) |
| `fixtures` | the library's hard cases (`tools/fixtures/README.md`): exact text in every format, several artists, compilations, two discs, one album name by two artists, CJK and accents in search, the Turkish I in `sortName`, missing tags, ReplayGain, MusicBrainz ids, the original date, several genres, audio properties |
| `playlists` | `getPlaylists` (own, another user's public one, a smart playlist), `getPlaylist`, `createPlaylist` (new, and overwrite with `playlistId`), `updatePlaylist` (rename, comment, add, remove several, public), `deletePlaylist`; another user's playlist: read-only, 50 on change |
| `user-state` | the starting stars, ratings, play counts and queue; `star`/`unstar` (songs, album, artist), `getStarred2`; `scrobble` (a play, its time, now playing); `savePlayQueue`/`getPlayQueue` (songs, current, position, `changedBy`) |
| `lyrics-and-discovery` | `getLyricsBySongId` (embedded synced with `[offset:+500]`, an `.lrc` with `[offset:-250]`, unsynced with its language, none), `getLyrics`, `getSimilarSongs2`, `getArtistInfo2` |
| `media` | `getCoverArt` (as is: the folder's and the embedded picture byte for byte; resized), `stream` (whole, `Range` from, to, open-ended, suffix, past the end 416, `format=raw`, unknown id) |
| `form-post` | the same calls as `application/x-www-form-urlencoded` posts: reads, sign-in errors, API key, app password, a 300-song `savePlayQueue`, playlist changes, stars |
| `connect` | Connect v1: `welcome`, `devices`, `hello`, `state` (stamped `at`), a command from one connection to another, the `offline` error, a `transfer` (`load` and `stop`), leaving, a wrong password |
| `connect2` | Connect v2 (`docs/protocol/connect.md`), for servers that list `sonusConnect` version 2 (skipped otherwise): the versions; `hello` and `welcome`; `playContext` with the song filled in from the library (`now`, `durationMs`, a `coverArt` `getCoverArt` shows), the queue, `loaded`; a remote's `seek`, `next`, `add`, `pause`; reports (`notActive`, `stale`); `transfer`; `volume` and `device`; refusals; hello first (1008); a wrong password; a second connection of the same device (4000); version 1 beside it; a lost connection (a close that is not 1000 or 1001) back within the grace period, the stop after its 10 s, `resume`, a goodbye; another user's own session. `lib/connect.mjs` is the device the tests use |
| `device-login` | `/auth/device/start`, `poll` (pending, approved once then expired, denied), approval on the web as the two-step user, `tokenInfo` with the key, `revoke` (204, then 44, then 404), 422 |
| `web-auth` | the web sign-in (`/auth`), with a user the file makes through the native API and removes: `login` (unknown user, wrong password, unreadable and oversized bodies); the first sign-in's setup token and what refuses it (`/auth`, `/api`, `/rest`); the setup (secret, link, QR code, a wrong code, the confirmed one) with recovery codes and a session; a code at every sign-in, each once, recovery codes once and in capitals; app passwords (made, listed with their last use, used as `p` and as an API key, revoked, only by their user); new recovery codes; `disable` refused while required; an admin's status and reset; the approval page's routes; 404 and 405; `createAdmin` refused; session tokens both ways (a session from `/auth/login` opens `/api`, the token `/api` hands back opens `/auth`), a forged one refused. Skipped for servers without a web sign-in (the demo server) |

### Not covered

- Transcoding (`stream` with `format`/`maxBitRate`): the test machine has no ffmpeg, and its output would differ between
  ffmpeg versions anyway.
- What Sonus does not use (roadmap, decision 1): XML, JSONP, `getArtists`/`getIndexes`, sharing, radio, bookmarks,
  downloads; the native `/api` (only used to build the database).
- Limits and timers: Connect's 30 s ping and 75 s timeout and its 32-device cap (the Rust server's own tests check
  them, `server/tests/connect.rs`), version 1's close code 4000, a device sign-in's 10-minute expiry and
  200-at-a-time cap. The sign-in rate limit is off in the suite's settings; `gateway.test.mjs`
  (below) checks it with servers of its own.
- `getNowPlaying`, `reportPlayback`, `startScan`, `setRating` (the database build uses it; the writes corpus compares it).

## What only the Rust server decides: `gateway.test.mjs`

```sh
node --test tools/contract/gateway.test.mjs
```

Seven tests that need servers of their own, each started on a fresh copy of the golden database: Navidrome alone, and
the Rust server running its own Navidrome, with the same settings.

| Test | Shows |
|---|---|
| failed sign-ins are limited the same way | with `AuthRequestLimit=3` and a 5 s window: three failures (by GET, by form post, by HEAD), then the right password refused (40), the name in capitals too, another user and an API key not; three unknown keys, then the right key refused (44), mixed credentials still 43, a password user not limited by keys; a window later both sign in again. The sixteen answers are the same from both servers |
| Navidrome never sees what the Rust server refused | with Navidrome's log at debug level (it logs every request with its query): six refused requests are not in the log of the Navidrome behind the Rust server, three accepted ones are (to `getLicense`, which Navidrome still answers), without any `p`, `t`, `s` or `apiKey` parameter, and it logged no "Invalid login"; Navidrome alone logs all nine and refuses the six itself |
| the library's reads are answered by the Rust server | with Navidrome's log at debug level: nineteen requests to the eleven methods the Rust server has taken over (`ANSWERED_BY_RUST` in `diff.mjs`; errors and a random list among them) carry its mark (`X-Sonus-Answered: rust`, debug builds), Navidrome's bytes and the same player cookie name, and are not in the log of the Navidrome behind it, which shows one `ping` for the client (the player's registration) and the eight requests left to it (XML, `musicFolderId`, another method, a lyrics file beside the song, a disc's cover, the scan's status); the player's row is the same as the one Navidrome alone makes; the last access is written |
| a player's settings count for the answers the Rust server gives | `ReportRealPath` turned on in the database while the servers run: the next `getSong` has the file's path on both, and the made-up path again when it is off (on Windows the Rust server leaves such a player's songs to Navidrome: checked that it does) |
| signed in by the gateway, a request is to Navidrome what it was with credentials | the player cookie's name (after the user name as typed) and attributes, the player in `getNowPlaying`, the user's last access written, no user created by an unknown name |
| Sonus Connect version 2: the session is kept across a restart | the extensions answer in JSON, JSONP and XML is Navidrome's but for `sonusConnect`'s version 2; two users' sessions are in the Rust server's own table 1.5 s after their last change (the server is then killed, so nothing is written at its end); the Rust server and Navidrome start again on the same data folder, tables included, without errors; both sessions are back with no active device, paused at their position, and play on from there |
| a client cannot name itself a user | `Remote-User`, `X-Sonus-User`, `X-Sonus-User-000…` sent by a client: 10 without credentials, 40 with a wrong password, and beside the listener's own sign-in the request is still the listener's; the web UI's page signs nobody in |

## `/auth` on servers of their own: `auth-routes.test.mjs`

```sh
node --test tools/contract/auth-routes.test.mjs
```

What needs other settings than the golden ones, or no users at all. Each test starts Navidrome alone and the Rust
server with the same settings, sends both the same requests, and compares the two lists of answers step by step.

| Test | Shows |
|---|---|
| a new server: the first admin | `createAdmin` (422 for a bad body, the admin and its session, 403 for a second one), the name in any case, the native API with that session and the admin's one library, the Subsonic API with the password; then a password change through the native API: Navidrome checks the current password (so each server reads what the other sealed), the session from before is refused (the epoch), the old password too, the new one signs in |
| a new server with two-step verification required | `createAdmin` answers the setup step; setup and confirm give the session. The Rust server's answer has one key more (`enrolmentCodeRequired: false`: the first admin needs no enrolment code), and a later sign-in with the password gets a token that does need one: asserted for the Rust server, left out of the comparison |
| optional, and off | optional: a user turns it on with their session, is then asked for a code (and their account password stops signing the Subsonic API), replaces and turns it off with a code; off: the two-step user signs in with the password alone, and setup is refused |
| the sign-in routes are rate-limited the same way | 3 requests in 6 s per address across `login`, `device/start`, the setup routes and `device/revoke`: the fourth is 429 with `Retry-After`, the `X-RateLimit-*` headers count down the same; signed-in limited routes answer 401 before they count; `poll` and the status are not limited |
| request bodies are bounded the same way | 8 KB under `/auth` (422), 4 MiB to `/api` (413 with Navidrome's text), uploads apart |
| sign-ins that wait for approval are the Rust server's own | with Navidrome's log at debug level, a whole browser sign-in through the Rust server leaves no `/auth` request in Navidrome's log |

`serveGolden({ empty: true })` and `startGatewayOnGolden({ empty: true })` start a server on no database at all
(Navidrome makes a new one), with the golden settings.

## The old web UI: `web-ui.check.mjs`

```sh
node tools/contract/web-ui.check.mjs        # through the Rust server
node tools/contract/web-ui.check.mjs --go   # Navidrome alone: the control
```

Navidrome's React UI in headless Chromium (Playwright, from the repository's `node_modules`), on a new server with
two-step verification required: the first admin made on the sign-up page, setting two-step verification up without an
enrolment code (the secret read from the page, the QR code a square picture, the recovery codes kept for the run);
the browser sign-in's approval page (the app, the device and the address that asked; no allowing without a
verification code, a wrong one refused, a right one handing the key over; refuse; a typed code; a code nobody waits
for); the app's key working and listed in Personal settings; an app password made only with a code; every call the UI
makes to Navidrome's `/api` answered; a second user made through Navidrome's API, the admin making their enrolment
code on the user's page, and that user's first sign-in (the enrolment code asked for before any QR code, a wrong one
refused); the admin's reset with a code, its new enrolment code, and the used one refused; signing in again with a
code. Screenshots go to `tools/fixtures/.work/web-ui/`. It is a script, not part of the suite: it needs a browser.

It needs a fork build whose UI knows the codes (0.64.2-sonus.11 or later): `--navidrome <exe>` runs another build
than the fixtures'. With `--go` the same UI runs against Navidrome alone, which asks for none of the codes: the
control that the UI still works there.

## The security review's findings and decisions: `security/`

```sh
node --test tools/contract/security/findings.test.mjs     # F1 to F6: what the review proved, fixed since
node --test tools/contract/security/hardening.test.mjs    # D1 to D3: what was decided after it
node --test tools/contract/security/required.test.mjs     # required: no account password on the API
```

`required.test.mjs`: with two-step verification required, the password of a user without two-step verification
signs no API call (three forms, GET and form post, a media route, Sonus Connect), answered as a wrong password; it
still gets the set-up token, and with an enrolment code the set-up and an app password that signs; an app password
from before keeps working; `optional` and `off` are as they were.

**Who the suites sign in as.** The fixtures' listener has no two-step verification, and the tests sign its API
calls with its app password (`apiSecret` in `lib/subsonic.mjs`: the suite's `api`, `as()`, the differential
corpora's `listener` entries, `gateway.test.mjs`): the frozen Navidrome would take its account password, the Rust
server does not, and an app password is what Sonus clients hold anyway. The account password on the API is still
checked where it is meant to sign: the suite's `auth` file (required: refused by the Rust server, taken by the
fork), `auth-routes.test.mjs` and `required.test.mjs` (`optional`, `off`), and the server's own tests.

Each test runs the Rust server with the real Navidrome on a fresh copy of the golden database (or on none).
`hardening.test.mjs`:

| Test | Shows |
|---|---|
| D1. the password alone does not set two-step verification up | a user made through Navidrome's API: the setup token starts and confirms nothing without the enrolment code, and makes itself none; an admin's session alone makes none either; with the admin's code it is made, works, and after a reset does not work again (the reset's own does); a user from before needs one too; ten wrong ones from ten addresses, then the right one is 429 |
| D1. the first admin | sets up with the token of the account's making; after that the password's token needs a code, which `sonus-server enrolment-code` prints (run with the server's settings beside the running server) |
| D2. a session alone does not allow an app | the approval page is told the address that asked (another loopback address) and that a code is needed; no body, no code, a wrong code: 401, the app still waits, no key made; with a code: approved |
| D3. a session alone makes no app password and resets nobody | each of the four routes that take a code refuses a session alone; ten wrong codes across them from ten addresses, then the right code is 429 on each and at the sign-in; nothing was made or reset |

The suite's own `web-auth` file runs the same flows on the shared server, and expects the stricter answers when the
first sign-in's answer says the server asks for enrolment codes (the Rust server), the fork's otherwise.

## The differential runner

```sh
node tools/contract/diff.mjs --go-vs-gateway [--corpus <file>]   # A: Navidrome; B: the Rust server running another Navidrome
node tools/contract/diff.mjs --go-vs-go [--corpus <file>]        # two Navidromes: what differs between two runs (should be nothing)
node tools/contract/diff.mjs --a <url> --b <url> --manifest <file> [--corpus <file>]
```

Each side gets its own copy of the golden database. Options: `--only <text>` (requests whose name contains it),
`--json <file>` (the whole report). It exits with 1 when anything differs. `node --test tools/contract/diff.test.mjs`
tests the runner itself.

Results so far (Navidrome 0.64.2-sonus.10): `corpus/read-only.json`, 443 requests, and `corpus/writes.json`, 34, come
out identical between Navidrome and the Rust server in front of its own Navidrome (329 of the 443 answered by the
Rust server itself), and between two Navidromes.

**Who answered.** A debug build of the Rust server marks the answers it made itself from the database
(`X-Sonus-Answered: rust`; `cargo run` is a debug build, the image is not). `--go-vs-gateway` checks the mark on every
request: a request to a method the Rust server has taken over (`ANSWERED_BY_RUST` in `diff.mjs`), in JSON and past the
sign-in, must carry it, unless the corpus says why it is Navidrome's all the same (`"navidrome": "why"`); every other
request must not. A wrong answerer is reported as a difference, so "identical" also means "answered by the one that
should". The summary says how many each answered. `X-Total-Count` is compared on JSON answers; `ETag`,
`Last-Modified` and `Cache-Control` on the others (pictures, streams).

A request with `"waitMs": 1500` is sent after that pause: for what a server finishes in the background after its
answer. A cover resized for the first time is written to Navidrome's cache a moment after it was sent; the same
request again, later, is the one the Rust server answers from that cache.

**Expected differences.** Where the Rust server is meant to answer differently from Navidrome alone, the difference
is written down in `diff.mjs` (`EXPECTED`) and applied to Navidrome's answer before the comparison, so the two must
then be the same and nothing else about that answer is hidden. `--go-vs-gateway` applies them and says so at the
top of its output; `--go-vs-go` and `--a/--b` apply none. So far one: `getOpenSubsonicExtensions` lists
`sonusConnect` as `[1, 2]` from the Rust server (it speaks version 2 itself), `[1]` from Navidrome alone.

`--go-vs-gateway` and `--through-gateway` run the Rust server as its image runs it (`startGatewayOnGolden` in
`diff.mjs`): `cargo run`, which starts Navidrome itself (`SONUS_NAVIDROME_BIN`) with the golden settings, so Navidrome
believes the gateway's user header and nobody else's. A server stopped with `stop({ keep: true })` leaves its data
folder; `startGatewayOnGolden({ copy: server.copy })` starts one on it again (a restart). `startGateway(url)` is the other way, the gateway in front of a
server that runs on its own: then it only passes requests through.

### The corpora

| File | |
|---|---|
| `corpus/read-only.json` | every sign-in and every way it fails: in JSON, XML and JSONP (compared byte for byte, with `Accept-Encoding: identity`), in the query and as a form, by every HTTP method, mixed credentials, missing `v`/`c`, `tokenInfo`, a CORS preflight, queries Go refuses; extensions, scan status; album lists (every type but random: whole and paged, as three users, the paging boundaries, `byYear` both ways round, `byGenre` in another case and with wildcards, every error), `search3` (the empty query whole and paged to its boundaries, for songs, albums and artists; words in every script, in any case, as prefixes and phrases, with accents, the Turkish I, sort names, punctuated names, FTS5's own syntax typed as words, LIKE's wildcards; Chinese, Japanese and Korean; MusicBrainz ids); `getAlbum`, `getSong` for every fixture case (and without an id, with the wrong kind of id, as the admin, as a user with no state, for the legacy and minimal client names, as `.view` and as form posts); playlists, the play queue and stars as three users (nothing starred, no queue saved, someone else's private playlist); what stays Navidrome's (XML, JSONP, `musicFolderId`, a smart playlist); playlists, the play queue, stars; lyrics (from the tags, from a file beside the song, none; `enhanced`), similar songs, artist info; cover art (as is from a folder and from Navidrome's image store, by hash, with `If-None-Match`, resized the first time and again from the cache, square, a playlist's, a disc's, without a picture, unknown), `stream` (every format, ranges, errors); two device sign-in calls |
| `corpus/writes.json` | stars, ratings, plays, the play queue, changing and deleting a playlist; each followed by the reads that show it |

### Normalizing

- **Key order** never matters: JSON is compared field by field. Other answers are compared by status, `Content-Type`,
  `Content-Length`, `Content-Range`, `Accept-Ranges`, length and a hash of the bytes.
- **Volatile** fields are listed in the corpus (`volatile`) and left out: `serverVersion`; in the writes corpus, the
  times the server takes from its clock (`starred`, a queue's or playlist's `changed`). Plays carry their own `time`.
- **Unordered** arrays (`unordered`) are compared sorted: an artist's `roles`, which Go lists from a map in random
  order, and `getSimilarSongs2`'s songs, which Navidrome shuffles (without Last.fm it picks from the artist's own).
- Requests are the same bytes on both sides: tokens use a fixed salt.

### Adding a case

To the suite: a `test(...)` in the file it belongs to. Look entities up with `id('key')` (skip with `needs('key')`
when the manifest may not have it) or through the API (`getLibrary()`); put back what the test changes. Check what
the clients read, as Navidrome answers it; when the demo server cannot do it, add it to `manifests/demo.json`'s
`knownDifferences` with the reason.

To a corpus: a request (`diff.mjs`'s header has the format):

```json
{ "name": "getAlbum", "method": "getAlbum", "params": { "id": "{{{{$}}}}" }, "for": ["album.normal", "album.cjk"] }
{ "name": "stream Range", "method": "stream", "params": { "id": "{{track.flac}}" }, "headers": { "Range": "bytes=0-99" } }
{ "name": "an app password", "method": "ping", "auth": { "user": "secure", "as": "appPassword" } }
{ "name": "device poll", "path": "/auth/device/poll", "httpMethod": "POST", "json": { "deviceCode": "x" } }
{ "name": "a form by PUT", "path": "/rest/ping", "httpMethod": "PUT", "form": "u=x&p=y&f=json" }
{ "name": "XML", "method": "ping", "params": { "f": null }, "headers": { "Accept-Encoding": "identity" } }
{ "name": "a music folder", "method": "getAlbumList2", "params": { "type": "newest", "musicFolderId": 1 }, "navidrome": "not something Sonus clients send" }
```

A parameter set to `null` is left out (`"v": null`: no `v`). Answers that are not JSON are compared by their bytes and
`Content-Length`: ask for them uncompressed (`Accept-Encoding: identity`), since Navidrome compresses and the Rust
server's own answers are not compressed.

Run `--go-vs-go` first: a field that differs between two Navidromes is volatile (list it, say why) or the golden
database is not settled yet (fix the build). Requests that make something with a random id (`createPlaylist`) do not
fit a corpus yet: each side would get another id.

## What Navidrome does that a rewrite must match

Found while writing these, all checked by the suite or the corpora:

- `public` is left out of playlists when false; another user's playlist is `readonly: true`.
- `getAlbum` and `getSong` without an id answer 70, not 10; `createPlaylist` without a name answers code 0; `u` without
  a password or token is 40.
- A smart playlist is filled when its owner reads it; until then others see it empty (the build has the admin read
  it once). Read by its owner it changes `changed` and carries `validUntil`.
- After start-up Navidrome works through `artwork_queue` in the background, and cover art ids change as it goes
  (`al-<id>` becomes `al-<id>_<hash>`). The build waits for the queue to empty, so every copy answers the same.
- A few seconds after every start Navidrome also looks for items without artwork state and makes their covers. A
  playlist gets its cover when it is changed through the Subsonic API; a smart playlist made through the native API
  has none until then (or until its cover is asked for). The build asks for every playlist's cover and waits for the
  state, or two servers started a moment apart would answer different ids for a while.
- Artist `roles` come in random order (a Go map); so do `getSimilarSongs2`'s songs.
- `sortName` lowercases as Go does: `İnce Yol` → `ince yol`, `Işık` → `isık` (Rust's `to_lowercase` gives `i̇nce yol`).
- A song's and an album's `year` is the original date's when there is one (2015, not 2019).
- `discTitles` entries carry a cover art id, `dc-<albumId>:<disc>`.
- `path` is made up from the tags (`Aurora Lane/Northern Lights/01-01 - First Light.flac`,
  `[Unknown Artist]/[Unknown Album]/untagged.ogg`), not the file's.
- Lyrics: an embedded Vorbis `LYRICS` tag has language `xxx`, an ID3 `USLT` its own (`eng`); `offset` is reported as
  written, the line times are not shifted by it. `getLyrics` answers the lines without times.
- An album list's `size` of 0 or less means everything; with an `offset` too, Navidrome's query fails (an OFFSET
  without a LIMIT) and it answers error 0. A random list (`type=random`) keeps its order until it is asked for from
  its start again (`offset` 0), so the pages of one pass fit together.
- `search3`: a count of 0 asks for none of that kind, a count below 0 for everything; a count below 0 with an offset
  fails inside Navidrome (an OFFSET without a LIMIT), which then answers with no rows of that kind and no error; one
  character finds nothing; `""` and `*` are the empty query; a key of a `for` may hold quotes (the runner escapes it).
- An artist's `albumCount` is the albums they are album artist of. An artist with a picture also carries
  `artistImageUrl` (the fixture library's artists have none).
- A playlist read with its songs is counted and timed from the songs that are still there; `getPlaylists` shows the
  stored numbers. The play queue's `current` is the song at the saved index among the songs that are still there.
- `getCoverArt` names the picture's type from its bytes, sends no length (chunked), and no player cookie. The `ETag`
  is the picture's hash, or `<hash>.<size>.<square>.q<quality>` for a resized one; `Cache-Control` is
  `immutable` only when the id asked for ends in the picture's current hash. An item known to have no picture
  answers 200 with a placeholder and `no-store`.
- `getLyricsBySongId` for a song that is not there answers 70 `data not found` (not `Song not found`).
- `byGenre` matches the genre's name with LIKE: any ASCII case, and `%` and `_` are wildcards.
- Album entries of a client whose name is a substring of `Subsonic.LegacyClients` (`DSub`: so `Sub`, `D`, …) carry no
  OpenSubsonic fields; songs only for the listed names themselves.
- Timestamps carry the server's local offset (`2026-11-24T19:50:32.1743303+01:00`), with as many fractional digits
  as the clock gives (7 on Windows) and trailing zeros dropped.
