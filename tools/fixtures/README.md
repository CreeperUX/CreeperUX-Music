# Test fixtures: a music library and a golden database

What the server tests run on (`docs/server-roadmap.md`, phase 0): a small music library made on the spot, and the
database the frozen Navidrome (the CreeperUX fork, 0.64.2) makes from it, with test users and their state. The contract
suite and the differential runner (`tools/contract/`) run against copies of it.

## One command

```sh
node tools/fixtures/build.mjs
```

From nothing, in about 15 seconds (plus a Navidrome build the first time):

1. writes the library (`generate.mjs`) into `tools/fixtures/.work/music/`;
2. finds Navidrome, or builds it from the fork;
3. runs it on a new data folder, lets it scan, makes the users and their state through its own routes, waits for its
   background artwork work to finish;
4. writes `tools/fixtures/.work/golden/navidrome.db` and `manifest.json`, and keeps Navidrome's image store beside
   them (`golden/artwork/`: the pictures it took out of audio files and made for playlists, by their hash), which
   the database's artwork state points at. Every copy of the database gets a copy of it.

Everything goes into `tools/fixtures/.work/` (gitignored). Only the generator and this description are committed.

Navidrome: `--navidrome <exe>`, else `NAVIDROME_EXE`, else the one built before (`.work/bin/`), else a build of the fork
(`NAVIDROME_SRC`; by default the `navidrome` checkout beside this repository's), as its image builds it: tags
`netgo,sqlite_fts5`, version `0.64.2-sonus.<commits since 0.64.2>`. Go and, on Windows on ARM, llvm-mingw are found on
`PATH` or under `~/sdk/`; there it builds for x64 (`NAVIDROME_GOARCH`, `NAVIDROME_CC` override). `--rebuild-navidrome`
builds again.

`node tools/fixtures/serve.mjs [--port <n>]` runs Navidrome on a fresh copy of the golden database (with the settings it
was made with) until Ctrl+C. Tests use the same thing from code: `serveGolden()`, with `env` for settings over the
golden ones (a sign-in limit, a log level). `goldenCopy()` only makes the copy and gives the settings, for a server
that runs Navidrome itself (the Rust server: `tools/contract/diff.mjs`, `startGatewayOnGolden`).

## The settings

Made and served with (`lib/navidrome.mjs`, `navidromeEnv`): two-step verification **required** (the fork's default);
**no network** (`EnableExternalServices=false`: no Last.fm, Deezer, ListenBrainz; no usage statistics); **sign-in rate
limits off** (`AuthRequestLimit=0`, so tests can run back to back); scans only when asked (`ScanOnStartup` while the
database is made, then off; no schedule, no folder watcher); no artwork pre-cache. ffmpeg is not needed: transcoding is
not part of the tests.

## The manifest

`golden/manifest.json`. **It holds the test users' passwords, TOTP secrets, app passwords and API key**: made at random
for each build, valid only on this machine's localhost copies; never printed, never committed.

| Field | |
|---|---|
| `server` | Navidrome's version, extensions, the settings to serve it with (`env`), how a browser sign-in is approved |
| `users.admin` | the first admin, made by `/auth/createAdmin`; two-step verification (required) set up; an app password |
| `users.listener` | a plain user (`/api/user`), never signed in on the web, so no two-step verification yet: the password opens the API. **The primary user** the tests sign in as |
| `users.secure` | two-step verification set up (`totpSecret`, `recoveryCodes`), an app password, and an API key from the browser sign-in (`/auth/device/start`, approved on the web, `/poll`) |
| `ids` | entity ids by stable key (below) |
| `expect` | what each key's tags say (title, artists, genres, ReplayGain, …) |
| `covers` | sha256 of the folder cover and the embedded cover |
| `counts` | songs, albums, artists, playlists the listener sees |
| `state.listener` | the listener's stars, ratings, play counts and play queue |

The listener's state: stars on `track.flac`, `album.compilation`, `artist.kenji`; ratings 4 on `track.mp3` and 5 on
`album.twoDiscs`; plays of `track.ogg` (2) and `track.flac` (1) at fixed dates; a play queue of three songs.
Playlists: `playlist.own` (the listener's, private, three songs), `playlist.otherUser` (the admin's, public),
`playlist.smart` (the admin's, public, rules: every FLAC file by title).

## The library

27 tracks, 29 files, 3.3 MB (`library.mjs`; `lib/formats.mjs` writes them byte by byte, so no encoder is needed and the
same input gives the same bytes). FLAC and WAV carry a short tone; MP3, Ogg Vorbis, Opus and M4A carry silence: frames
that decode to nothing, which every decoder plays and whose length TagLib reads as from an encoder. All 27 decode in
Chromium (`decodeAudioData`). File times are fixed (2026-01-01). Artists and titles are made up.

| Case | Files | Keys |
|---|---|---|
| A plain album: FLAC, `cover.jpg` in the folder, one track with its own embedded cover, ReplayGain, MusicBrainz ids, an original date (2015-03-01) older than the date (2019-06-14), two genres, sort names | `Aurora Lane/Northern Lights/` | `album.normal`, `album.folderCover`, `track.flac`, `track.replayGain`, `track.musicBrainz`, `track.originalDate`, `track.embeddedCoverOverFolder` |
| Lyrics: an `.lrc` beside the file (`[offset:-250]`), embedded synced LRC (`[offset:+500]`), embedded unsynced | Northern Lights, Summer Hits | `track.lrcSidecar`, `track.syncedLyrics`, `track.unsyncedLyrics` |
| A compilation: `COMPILATION=1`, no album artist (Navidrome names it Various Artists), MP3, embedded covers only | `Various Artists/Summer Hits/` | `album.compilation`, `track.mp3`, `track.embeddedCover` |
| Several artists: `A / B`, `A feat. B`, an `ARTISTS` multi-value tag (`Lumi`, `Dax` with `ARTIST=Lumi & Dax`); two genres in one ID3 frame | Summer Hits | `track.slashArtists`, `track.feat`, `track.artistsTag`, `track.twoGenres`, `artist.lumi`, `artist.dax` |
| Two discs in `CD1`/`CD2` folders, disc subtitles: M4A (AAC) | `Kenji Mori/Twin Discs/` | `album.twoDiscs`, `track.m4a`, `track.disc1`, `track.disc2`, `track.m4aCover` |
| The same album name by two artists: Ogg Vorbis and Opus, embedded covers (`METADATA_BLOCK_PICTURE`) | `*/Greatest Hits/` | `album.sameName.aurora`, `album.sameName.kenji`, `track.ogg`, `track.opus` |
| CJK: Chinese, Japanese, Korean titles; a Chinese artist with a Latin sort name | `林夕雨/城市的灯火/` | `album.cjk`, `artist.cjk`, `track.cjk`, `track.japanese`, `track.korean` |
| Accents: `Été`, `Über`, `Ñandú` | `Zoë Ångström/Café Mélodie/` | `album.accented`, `artist.accented`, `track.accented`, `track.umlaut`, `track.tilde` |
| The Turkish I: `İ`, `ı`, `I` (Go lowercases `İ` to `i`, Rust to `i̇`): WAV with an ID3v2 chunk | `İlkay Işık/İstanbul Işıkları/` | `album.turkish`, `artist.turkish`, `track.turkish`, `track.dotlessI`, `track.upperI`, `track.wav` |
| Missing tags: no album; no artist; no tags at all (the title is the file name) | `Unsorted/` | `track.noAlbum`, `track.noArtist`, `track.noTags` |

Artists by name: `artist.aurora`, `artist.kenji`, `artist.lumi`, `artist.dax`, `artist.cjk`, `artist.accented`,
`artist.turkish`.

Tags are written as each format names them, after MusicBrainz Picard's map, which Navidrome's `mappings.yaml` follows:
Vorbis comments (FLAC, Ogg, Opus), ID3v2.4 (MP3, WAV; several values separated by a null; MusicBrainz recording id in
`UFID`), iTunes atoms (M4A; freeform `----:com.apple.iTunes:` for the rest). Covers: two of the demo server's
(`tools/demo-server/covers/al0.jpg` in folders, `al12.jpg` embedded).

## Adding a case

1. Add the track(s) to `TRACKS` in `library.mjs` with new keys (`keys` for the track, `albumKeys` for its album; an
   artist by name goes in `ARTISTS`). A tag the writers do not know yet goes in `lib/tags.mjs`, for all three families.
2. Describe it in the table above.
3. `node tools/fixtures/build.mjs`, then test it: `tools/contract/test/fixtures.test.mjs` (what the server must
   answer) and `tools/contract/corpus/read-only.json` (so the diff compares it).

Titles must stay unique: the manifest finds each track by its title.
