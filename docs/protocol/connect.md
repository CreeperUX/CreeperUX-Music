# Sonus Connect, version 2: one playback session per user

Status: specification, 2026-11-24. Not implemented yet. The server half goes into the Rust server (`server/`, roadmap
phase 1); the Windows client, the web client, the Android client and the demo server (`tools/demo-server/connect.mjs`,
the reference the client tests run against) implement the rest. Version 1 (`sonusConnect` v1, the Go fork's
`server/connect`) stays for clients that have not moved yet; the two do not see each other.

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
  "lastDevice": { "id": "…", "name": "书房电脑" },   // the device that played last, for "上次在「…」播放"
  "current": { "key": "c17:tr4x…", "trackId": "tr4x…", "manual": false },   // null: an empty session
  "next": "tr9y…",               // what follows when the current song ends (PlayQueue.Peek), for preloading; null if unknown (random, repeat one, stop after current, the end)
  "playing": true,
  "positionMs": 83500, "at": 1764001234567,   // position at server time `at`; while playing, now = positionMs + (serverNow - at)
  "durationMs": 241000,
  "now": { "title": "…", "artist": "…", "album": "…", "albumId": "…", "coverArt": "…" },  // so any device can show it without a lookup
  "mode": "default",             // default | repeatAll | repeatOne | shuffleTracks | shuffleAlbums | shuffleFolders | random
  "stopAfterCurrent": false,
  "context": { "kind": "album", "id": "…", "label": "…" },  // what the songs came from; null for none
  "queueRev": 57                 // the queue's own revision: fetch or wait for `queue` when it changes
}
```

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

**Entries** are what the queue panel lists, and what commands point at, by key, as in `PlayQueue.Entries`: manual
entries first (`q<n>`), then the context after the pointer (`c<index>:<trackId>`). A context key names a place and the
song expected there; a command whose key no longer matches (the queue moved on meanwhile) does nothing to that entry
and is answered with `error stale` for it. Keys of manual entries are stable until the entry plays or is removed.

### Devices

```jsonc
{ "id": "a1b2…", "name": "书房电脑", "kind": "desktop", "client": "Sonus 0.6.0 (Windows)", "canPlay": true,
  "connectedAt": 1764000000000, "volume": 0.62, "muted": false }
```

`kind`: `desktop`, `web`, `phone`, `tablet`, `speaker`, `other`. `canPlay: false` is a remote that never plays.
A device's **id is its own**: a random id the client makes once per installation (per browser profile for the web
client) and keeps, `[A-Za-z0-9_-]{8,64}`. The same id reconnecting is the same device. Ids are per user.

## Connecting

A WebSocket at `rest/connect?protocol=2` (or `rest/connect.view?protocol=2`), authenticated like a Subsonic request:
`u` with `t`/`s` (or `p`), or `apiKey`, plus `v`, `c`, in the query string. Without `protocol=2` the server speaks
version 1 (or refuses, once version 1 is gone). The server advertises the versions it speaks in the OpenSubsonic
extension `sonusConnect` (`versions: [1, 2]`); a client uses 2 only when it is listed, and plays locally on its own
otherwise, exactly as without Connect.

The first message is the client's `hello`; the server answers `welcome` with everything a device needs to show the
session at once (rule 2). The server pings every 30 s; a connection silent for 75 s is closed. A second connection
with the same device id replaces the first (close code 4000). At most 32 devices per user (the one silent longest goes).
JSON text frames, at most 1 MiB each; times are milliseconds since the Unix epoch on the server's clock (each message
that carries `serverTime` lets a client keep the offset to its own clock).

## Messages

### Client → server

Every client message may carry `ref` (a string the client picks); the server answers `ack {ref, rev}` once it is
applied, or `error {ref, code, message}`.

| type | fields | |
|---|---|---|
| `hello` | `deviceId`, `name`, `kind`, `canPlay`, `client`, `resume?` | first message. `resume: {rev, playing, positionMs}`: this device was active, lost the connection and is still playing (see Grace) |
| `command` | `action`, …, `rev?` | changes the session (below) |
| `report` | `event`, `key`, `positionMs`, `durationMs?`, `now?`, `rev` | the active device only: what really happened (below) |
| `device` | `volume`, `muted` | this device's own volume, on every change |

#### Commands (any device)

| action | fields | effect on the session |
|---|---|---|
| `play` | — | resume. With no active device, **the sender becomes the active device** (rule 6; `error cannotPlay` if it can't play) |
| `pause` | — | pause |
| `toggle` | — | play or pause |
| `seek` | `positionMs` | move within the current song |
| `next` | — | `PlayQueue.Next()` (manual songs first) |
| `previous` | — | more than 3 s into the song: back to its start; otherwise `PlayQueue.Previous()` |
| `playContext` | `context`, `ids`, `startId?`, `shuffle?`, `order?`, `positionMs?` | `PlayQueue.Start`: a new context (an album, a playlist, search results…), the manual songs kept. `order`: the context already arranged by the sender, required for `shuffleAlbums`/`shuffleFolders` (the server may not know albums and folders); otherwise the server arranges. Starts playing; with no active device the sender becomes it |
| `jump` | `entry` | play that queue entry (`PlayQueue.Jump`) |
| `add` | `ids`, `next` | queue by hand, at the end or first (`PlayQueue.Add`) |
| `move` | `order`, `keys`, `manual` | a drag in the queue panel (`PlayQueue.Move`) |
| `remove` | `entries` | `PlayQueue.Remove` |
| `clear` | `manual` | the hand-queued songs, or the rest of the context (`PlayQueue.Clear`) |
| `mode` | `mode`, `order?` | the playback order (`PlayQueue.SetOrder`); `order` as for `playContext` when shuffling by album or folder |
| `stopAfterCurrent` | `on` | |
| `transfer` | `to`, `play?` | the only way to change the active device (rule 4): `to` becomes active at the current position, playing as before or as `play` says; the device it leaves stops. `to` may be the sender ("play here") |
| `volume` | `device`, `volume?`, `muted?` | that device's volume (rule 8): the server passes it to that device as `deviceCommand` |

A command that only reads the session (all but `transfer`, `volume`, and `play`/`playContext` with no active device)
does not change which device is active (rule 3). Commands on an empty session that need a song (`play`, `next`…) answer
`error nothing`.

#### Reports (the active device)

| event | when | the server |
|---|---|---|
| `loaded` | the current song is ready (after a `session` changed it) | takes `durationMs`, `now` |
| `playing` / `paused` | audio started or stopped, by itself or as asked | `playing`, `positionMs`, `at` = now |
| `position` | a seek done, and at least every 30 s while playing | corrects `positionMs`/`at` |
| `ended` | the current song reached its end | `PlayQueue.Next(ended: true)`: the next song, or the end of the session (`playing: false`, position 0 of the last song) |
| `failed` | the song can't play here | skips it, as Spotify does: `PlayQueue.Next()` (not as at an end, so repeat one does not loop on it), and answers the active device `error unplayable` with a message naming the song, `trackId` and `stopped`. Five failures in a row (or none left) stop the session (`playing: false`); the next command gives a fresh try |

`key` is the entry the report is about; a report for a song that is no longer current is ignored. At an `ended`, the
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
| `error` | `ref?`, `code`, `message` | `stale` (an entry key or `rev` that no longer matches), `cannotPlay`, `nothing`, `notActive` (a report from a device that isn't active), `offline` (a `volume` for a device that isn't connected), `unplayable`, `invalid` |

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
still played. If it reconnects in time (`hello` with the same id), it stays active and its next reports correct the
state. Otherwise the session stops: `activeDevice: null`, `playing: false`, the position where it was when the
connection dropped (rule 7). A device that comes back later with `resume` while the session still has no active device
and the same `rev` is made active again (it never stopped playing: a short network loss); in every other case it stops
and shows the session as it now is.

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
