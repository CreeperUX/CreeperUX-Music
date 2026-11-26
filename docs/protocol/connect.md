# Sonus Connect, version 2: one playback session per user

Status: specification, 2026-11-24. The server half has a reference implementation, `tools/demo-server/connect-session.mjs`
(served by the demo server at `rest/connect?protocol=2`, `connect2.mjs`), and test vectors made from it,
`docs/protocol/connect-vectors.json`: sequences of messages with the session, queue, devices and replies expected after
each step. A server implementing this protocol (the Rust server, `server/`, roadmap phase 1) must give exactly those.
The Rust server is the one deployed; the vectors cover the session, not the connection around it, and where the demo
server does less than this document says (it does not bound `mode`'s `order`, has no `hello` deadline and does not
count connections waiting for one), the Rust server is the one that does it.
The Windows and Android clients implement the client half; the web client follows. Version 1 (`sonusConnect` v1, the Go
fork's `server/connect`, the demo's `connect.mjs`) stays for clients that have not moved yet; the two do not see each
other.

## The rules (agreed with the user)

1. 一个账号同时只有一台设备出声。One device of a user plays audio at a time: the **active device**.
2. 每台设备一打开就显示正在哪台放什么，进度实时走。Every device shows the session as soon as it connects: what plays, where, and
   the position moving.
3. 在任何一台点歌、加队列、切歌、拖进度、随机/循环，都作用于正在出声的那台。Whatever any device does (play something, queue, skip,
   seek, change the order) changes the one session, and the active device follows.
4. 只在设备列表里切换出声设备；原来的停下，变成遥控器。Only the device picker moves playback (a transfer); the device it leaves stops
   and is a remote like the others.
5. 队列只有一份。There is one queue, the session's.
6. 都关掉后会话留在服务器上；哪台按播放，就从原处接着放。The session is kept on the server (across restarts) when no device plays;
   whichever device presses play continues it where it stopped, and becomes the active device. This replaces the "接着上次听"
   (continue where you left off) prompt and the clients' use of `savePlayQueue`/`getPlayQueue`.
7. 出声设备掉线，会话就停在原位。When the active device goes away, the session stops where it was (after a short grace period).
8. 音量属于每台设备自己。Volume belongs to each device, and any device can change any device's volume.

## Model

The server holds, per user, one **session** and the user's connected **devices**. The server is the only source of
truth for the session; devices show it and send commands. The active device plays the session's current song and
reports what really happens (it started, paused, reached the end, failed). The queue logic is the Windows app's
`src/Sonus.Core/PlayQueue.cs`, moved to the server unchanged in behaviour, so all clients get the same queue for free.

### Session

```jsonc
{
  "rev": 412,                    // +1 on every change of the session or its queue
  "activeDevice": "a1b2…" ,      // null: nothing plays (rule 6/7)
  "lastDevice": { "id": "…", "name": "书房电脑" },   // the device that played last, for "上次在「…」播放"; while a device plays: that device
  "current": { "key": "c17:tr4x…", "trackId": "tr4x…", "manual": false },   // null: an empty session; key: see Entries
  "next": "tr9y…",               // what follows when the current song ends (PlayQueue.Peek), for preloading; null if unknown (random, repeat one, stop after current, the end)
  "playing": true,
  "positionMs": 83500, "at": 1764001234567,   // position at server time `at`; while playing, now = positionMs + (serverNow - at)
  "durationMs": 241000,           // 0: not known
  "now": { "title": "…", "artist": "…", "album": "…", "albumId": "…", "coverArt": "…" },  // so any device can show it without a lookup; coverArt: see below
  "mode": "default",             // default | repeatAll | repeatOne | shuffleTracks | shuffleAlbums | shuffleFolders | random
  "stopAfterCurrent": false,
  "context": { "kind": "album", "id": "…", "label": "…" },  // what the songs came from; null for none
  "queueRev": 57                 // the queue's own revision: fetch or wait for `queue` when it changes
}
```

Whenever the current song changes, the server fills `now` and `durationMs` from its library (so every device can show
the new song even when no device plays, after a remote's `next`); the active device's `loaded` report replaces `now`.
The library's `durationMs` stands: a device's figure can be out of date (an engine that has not yet read the new song's
length after a gapless change reports the previous song's), so the server takes `loaded.durationMs` only when its
library has none for the song (0).

**Positions and the end of the song.** A position a command asks for (`seek`, `playContext`'s `positionMs`) is kept
within the song as the library has it (0 to `durationMs`). A position the active device reports (`playing`, `paused`,
`position`, `resume`) is taken as it is (at least 0): the device plays the real file, which can be a second or two
longer than the library says (a VBR MP3). Holding it to the library's duration would set the device back each time it
reported near the end, so the song would never finish. While playing, the position moves on with the clock and stops
at the song's end: `durationMs`, or the position the device last reported if that is further.
Without an active device the session is never playing: `activeDevice: null` means `playing: false`.

`now.coverArt` is an id to pass to `getCoverArt` as it is, and nothing more: clients do not parse it or compare it with
ids from other answers. Filled in by the server it is the song's own picture (`mf-<songId>`), else its disc's
(`dc-<albumId>:<disc>`), else its album's (`al-<albumId>`), without the `_<hash>` suffix the same ids carry in
`getSong` and other Subsonic answers (`getCoverArt` takes them either way); after a `loaded` it is whatever id the
active device sent.

### Queue

As `PlayQueue`: the **context** in playback order with a **pointer** to the current context song, and the songs queued
by hand (**manual**), which play before the context continues.

```jsonc
{
  "queueRev": 57,
  "order": ["tr1…", "tr2…", …],        // the context in playback order (shuffled or not); at most 10 000
  "pointer": 16,                        // order[pointer] is the context's current song (also while a manual song plays)
  "manual": [ { "key": "q41", "trackId": "…" } ],   // at most 1 000
}
```

The server also keeps the context in its own order (to come back from shuffling); devices never need it.

**The 10 000.** `playContext` takes a window of the `ids` it is sent, and of `order` when it is used: all of them up
to 10 000; of a longer list, 10 000 in their own order that hold `startId`, from 100 before it (or the first 10 000
without `startId`). Senders window the same way, so the song they start with is in it. Of the window, the songs the
library does not have (or the user may not see) are left out. `mode` with an arranged `order` takes the first 10 000
songs of `order` that the library has (no window: there is no start song), and they become the context as sent.

**Entries** are what the queue panel lists, and what commands point at, by key, as in `PlayQueue.Entries`: manual
entries first (`q<n>`), then the context after the pointer (`c<index>:<trackId>`). A context key names a place and the
song expected there; a command whose key no longer matches (the queue moved on meanwhile) does nothing to that entry
and is answered with `error stale` for it. Keys of manual entries are stable until the entry plays or is removed.
Keys are opaque to clients: they send them back exactly as the server wrote them, never one they made or rewrote. A
key written differently is not that entry's key (`c05:x` is not `c5:x`) and gets `error stale`; what else such a
key does is not specified (today `remove` of `c05:x` also removes the entry `c5:x`, as the reference does).

`current.key` is the entry key the song had when it became current (`c<index>:<trackId>` for a context song, its `q<n>`
for a song queued by hand), and it does not change while the song plays: a new order moves the pointer, not the key. So
shuffling on or off never makes the active device load the song again, and its reports about it still apply. Two plays
of the same entry one after the other (repeat one, `previous` more than 3 s in) keep the key; the position going back
to 0 says that it starts again.

### Devices

```jsonc
{ "id": "a1b2…", "name": "书房电脑", "kind": "desktop", "client": "Sonus 0.6.0 (Windows)", "canPlay": true,
  "connectedAt": 1764000000000, "volume": 0.62, "muted": false }
```

`kind`: `desktop`, `web`, `phone`, `tablet`, `speaker`, `other` (anything else is `other`). `canPlay: false` is a remote
that never plays. `name` is trimmed and kept to its first 80 UTF-16 code units, `client` to 120, never cutting a
character in two (a name of only spaces keeps the device's earlier name, or its id).
`volume` (0–1) and `muted` are what the device said in its `hello` or its last `device` message; until it says, 1 and
not muted. The active device stays listed through its grace period (below), even while its connection is down.
A device's **id is its own**: a random id the client makes once per installation (per browser profile for the web
client) and keeps, `[A-Za-z0-9_-]{8,64}`. The same id reconnecting is the same device. Ids are per user.

## Connecting

A WebSocket at `rest/connect?protocol=2` (or `rest/connect.view?protocol=2`), signed in with Subsonic credentials in
the query string: `u` with `t`/`s` (or `p`, `enc:` included), or `apiKey` alone, plus `v`, `c`. They are checked as
any Subsonic request's are (the same rules, and failed attempts counted with the others); refused, the request gets
the Subsonic error a Subsonic request would (code 40 for a wrong password, …) and no WebSocket. Only these sign in to
version 2: a web session's token (`jwt`) is answered HTTP 401, and a reverse proxy's user header (`Remote-User`)
signs no one in here. Credentials are checked when the connection opens, not again while it stays open (a deleted
user's connections are closed within a minute). Without `protocol=2` the server speaks version 1 (or refuses, once
version 1 is gone). The server advertises the versions it speaks in the OpenSubsonic
extension `sonusConnect` (`versions: [1, 2]`); a client uses 2 only when it is listed, and plays locally on its own
otherwise, exactly as without Connect.

The first message is the client's `hello`, within 10 s of the connection opening; the server answers `welcome` with
everything a device needs to show the session at once (rule 2). Any other first message, or a `hello` the server
refuses (a device id that is not one), is answered `error invalid` and the connection closed (1008); a connection
with no `hello` after 10 s is closed too (1008). At most 8 connections of a user may be waiting for their `hello` at once: one
more is closed at once (1013). The server pings every 30 s; a connection silent for 75 s is closed. A second
connection with the same device id replaces the first (close code 4000). At most 32 devices per user: a 33rd closes
the connection of the one silent longest (close code 4001). JSON text frames, at most 1 MiB each (a longer message
closes the connection, 1009); times are milliseconds since the Unix epoch on the server's clock (each message that
carries `serverTime` lets a client keep the offset to its own clock).

**Goodbye.** A client that closes its connection on purpose (the app closes, the user signs out) says goodbye with
close code 1000 or 1001; see Grace for what that changes. Anything else is a network loss: a connection that breaks,
times out, or is closed with another code or **with no code at all**. A browser's `ws.close()` without arguments sends
no code (1005, a network loss), so the web client says goodbye with `ws.close(1000)`.

The server's close codes: 1001 the server is stopping, 1008 no (valid) `hello` or the user no longer exists, 1009 a
message over 1 MiB, 1011 the server failed, 1013 too many connections waiting for `hello`, 4000 replaced by a newer
connection of the same device, 4001 the 33rd device took its place.

## Messages

### Client → server

Every client message may carry `ref` (a string the client picks); the server answers `ack {ref, rev}` once it is
applied, or `error {ref, code, message}`. A refused message changes nothing at all (not even which device is active);
the one exception is `remove`, below.

| type | fields | |
|---|---|---|
| `hello` | `deviceId`, `name`, `kind`, `canPlay`, `client`, `volume?`, `muted?`, `resume?` | first message. `volume`/`muted`: this device's volume, as in `device`. `resume: {rev, playing, positionMs}`: this device was active, lost the connection and is still playing (see Grace) |
| `command` | `action`, …, `rev?` | changes the session (below) |
| `report` | `event`, `key`, `positionMs`, `durationMs?`, `now?`, `rev` | the active device only: what really happened (below) |
| `device` | `volume`, `muted` | this device's own volume, on every change |

#### Commands (any device)

| action | fields | effect on the session |
|---|---|---|
| `play` | — | resume. With no active device, **the sender becomes the active device** (rule 6; `error cannotPlay` if it can't play). With nothing current but songs queued by hand: the first of them plays (as `next`) |
| `pause` | — | pause |
| `toggle` | — | play or pause |
| `seek` | `positionMs` | move within the current song |
| `next` | — | `PlayQueue.Next()` (manual songs first) |
| `previous` | — | more than 3 s into the song: back to its start; otherwise `PlayQueue.Previous()` |
| `playContext` | `context`, `ids`, `startId?`, `shuffle?`, `order?`, `positionMs?` | `PlayQueue.Start`: a new context (an album, a playlist, search results…), the manual songs kept. `order`: the context already arranged by the sender, required for `shuffleAlbums`/`shuffleFolders` (the server may not know albums and folders); otherwise the server arranges. With an arranged `order` and no `startId` the first song of `order` plays (the sender puts the one to start with there). Starts playing; with no active device the sender becomes it (`error cannotPlay` if it can't play, and nothing changes) |
| `jump` | `entry` | play that queue entry (`PlayQueue.Jump`) |
| `add` | `ids`, `next` | queue by hand, at the end or first (`PlayQueue.Add`) |
| `move` | `order`, `keys`, `manual` | a drag in the queue panel (`PlayQueue.Move`). All or nothing: `order` must list exactly the current entries and `keys` must be among them, else `error stale` (`PlayQueue.Move` drops entries missing from `order`, so a move made on an older queue would delete what was queued since) |
| `remove` | `entries` | `PlayQueue.Remove`. Keys that no longer match are answered `error stale` with `entries` (those keys); the others are removed all the same. Keys are compared as text, so a client sends them exactly as it got them (see Entries) |
| `clear` | `manual` | the hand-queued songs, or the rest of the context (`PlayQueue.Clear`) |
| `mode` | `mode`, `order?` | the playback order (`PlayQueue.SetOrder`); `order` as for `playContext` when shuffling by album or folder (required then, unless the context is empty), bounded as in The 10 000 |
| `stopAfterCurrent` | `on` | |
| `transfer` | `to`, `play?` | the only way to change the active device (rule 4): `to` becomes active at the current position, playing as before or as `play` says; the device it leaves stops. `to` may be the sender ("play here") |
| `volume` | `device`, `volume?`, `muted?` | that device's volume (rule 8): the server passes it to that device as `deviceCommand` |

A command that only reads the session (all but `transfer`, `volume`, and `play`/`toggle`/`playContext` with no active
device) does not change which device is active (rule 3). With no active device nothing plays: a remote's `next`,
`previous` or `jump` moves the session and leaves it paused. Commands that need a song (`play`, `next`, `seek`…) on a
session with nothing current and nothing queued answer `error nothing`. A command with `rev` that is not the session's
rev is answered `error stale` and does nothing.

#### Reports (the active device)

| event | when | the server |
|---|---|---|
| `loaded` | the current song is ready (after a `session` changed it) | takes `now`; takes `durationMs` only when the library has none for the song (a device's can be out of date: see Session) |
| `playing` / `paused` | audio started or stopped, by itself or as asked | `playing`, `positionMs`, `at` = now |
| `position` | a seek done, and at least every 30 s while playing | corrects `positionMs`/`at` |
| `ended` | the current song reached its end | `PlayQueue.Next(ended: true)`: the next song, or the end of the session (`playing: false`, position 0 of the last song) |
| `failed` | the song can't play here | skips it, as Spotify does: `PlayQueue.Next()` (not as at an end, so repeat one does not loop on it), and answers the active device `error unplayable` with a message naming the song, `trackId` and `stopped`. Five failures in a row (or none left) stop the session (`playing: false`); the next command gives a fresh try |

`key` is the entry the report is about; a report for a song that is no longer current is ignored (`error stale`). `rev`
is the session rev the device last followed: a `playing`, `paused` or `position` report whose `rev` is older than the
last change a command made is ignored too (`error stale`), since the device had not yet followed it (a seek from a
remote, say) and its position is out of date; it follows the `session` and reports again. `loaded`, `ended` and `failed`
are guarded by `key` only. At an `ended`, the
active device may start `next` at once (it preloaded it) without waiting for the server: the server moves to the same
song unless the queue changed meanwhile, in which case the device follows the `session` it gets.

### Server → client

| type | fields | when |
|---|---|---|
| `welcome` | `version: 2`, `deviceId`, `serverTime`, `session`, `queue`, `devices` | answer to `hello` |
| `session` | `serverTime`, `session` | after every change (to every device of the user, the sender too) |
| `queue` | `queue` | after every change of the queue (`queueRev`) |
| `devices` | `serverTime`, `devices` | a device joined, left, or changed its volume |
| `deviceCommand` | `action: "volume"`, `volume?`, `muted?`, `from` | another device changed this one's volume |
| `ack` | `ref`, `rev` | a message with `ref` was applied |
| `error` | `ref?`, `code`, `message`, … | `stale` (an entry key or `rev` that no longer matches; `entries?`: the keys), `cannotPlay`, `nothing`, `notActive` (a report from a device that isn't active), `offline` (a transfer to or `volume` for a device that isn't connected), `unplayable` (`trackId`, `stopped`: the failed song, and whether the session stopped), `invalid` |

`message` is for people (Chinese for now) and its wording may change: clients act on `code` and the other fields,
never on `message`. Clients show errors to the user, except `stale` and `notActive`: the session moved on meanwhile,
and what it is now is on its way.

### What each device does with a `session`

- **Every device** shows it: the song, the position moving (from `positionMs`, `at` and the clock offset), playing or
  paused, the mode, and where it plays: "正在「{active device's name}」上播放" when it is another device, the last
  device's name when none plays.
- **The active device** makes its audio match: load `current` if it is a different entry, seek when the position is
  more than 1.5 s from where it is, play or pause as `playing` says, preload `next`; then report.
- **A device that stops being active** (a transfer to another, or the session moved on without it) stops its audio at
  once and releases it.

## Lifetime

**Kept on the server.** The session and its queue are stored per user (a table of the Rust server's own,
`sonus_connect_session`), written within a second of a change and when the server stops. After a restart the session
is back with no active device, paused at its position (rules 6, 7).

**Grace.** When the active device's connection drops, the server keeps it active for 10 s, the position moving as if it
still played; it stays in `devices` meanwhile. If it reconnects in time (`hello` with the same id), it stays active and
its next reports correct the state. Otherwise the session stops: `activeDevice: null`, `playing: false`, the position
where it was when the connection dropped, or where a command put it since (rule 7). That stop is itself a change (rev
+ 1), so a `resume` is taken when the session has not changed since the stop and `resume.rev` is the rev from before
it: the device is made active again, `playing` and `positionMs` as it says (it never stopped playing: a short network
loss). In every other case it stops and shows the session as it now is.

**A goodbye is not a network loss.** A device that closes its connection with close code 1000 or 1001 left on purpose:
there is no grace period. (A close with no code is a network loss: see Goodbye, under Connecting.) If it was the active device the session stops at once where it is (`activeDevice: null`,
`playing: false`), so another device can play it straight away instead of sending it to a device that is gone.

**Devices keep playing through a network loss.** The active device does not stop its audio because its connection
dropped; it reconnects with backoff (1 s doubling to 30 s) and `resume`s.

## Unchanged

- Scrobbling: the active device calls `scrobble` (now playing, then the counted play) as today.
- Song metadata, covers and streams come from the Subsonic API as today; the session carries ids, plus `now` for
  display.
- Clients without a server that offers version 2 play locally, as now.

## Examples

**Opening the app while the phone plays.** PC → `hello`; ← `welcome` with `session.activeDevice` = the phone,
`playing: true`. The bar shows the phone's song with "正在「手机」上播放" and its position moving. Clicking an album on
the PC → `command playContext` → the session changes → the phone plays the album; the PC stays silent.

**Moving playback to the PC.** PC → `command transfer {to: PC}` → `session.activeDevice` = PC → the phone stops; the
PC loads `current`, seeks to the position, plays, and reports `loaded`, `playing`.

**Everything off, the next day.** Laptop → `hello`; ← `welcome`, `activeDevice: null`, `lastDevice: 书房电脑`, the song
paused at 1:23. The bar shows it ("上次在「书房电脑」播放"). Play → `command play` → the laptop becomes active and
continues at 1:23.
