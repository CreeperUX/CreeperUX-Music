# Sonus Playback Library (Renditions) Protocol

Status: specification, 2026-11-28 (`sonusRenditions` version 1). Design background: `docs/streaming-renditions.md`.

The server pre-generates clean, seekable playback renditions of the library into its own folder and SQLite ledger (`sonus-renditions.db`), leaving the original files and Navidrome's database untouched. Requests without `sonusQuality` are completely unchanged byte for byte.

## 1. Capability Discovery

When the playback library is enabled (`SONUS_RENDITIONS_ENABLED=true`), `getOpenSubsonicExtensions` includes:

```json
{ "name": "sonusRenditions", "versions": [1] }
```

When the playback library is disabled (default), `sonusRenditions` is not advertised and `getOpenSubsonicExtensions` is unchanged.

## 2. Streaming by Quality Tier (`stream` / `stream.view`)

### Query Parameter

| Parameter | Values | Meaning |
|---|---|---|
| `sonusQuality` | `lossless` | Lossless FLAC rendition (preserving source sample rate and 16/24-bit depth; DSD converted to 88.2 kHz / 24-bit PCM FLAC) with a 1-second `SEEKTABLE`. For lossy originals (e.g. MP3), serves the original file without re-encoding. |
| | `veryHigh` | Opus 256 kbps (Ogg container) for lossless originals; original file for lossy originals. |
| | `high` | Opus 160 kbps (Ogg container) for both lossless and lossy originals. |
| | `normal` | Opus 96 kbps (Ogg container) for both lossless and lossy originals. |
| | `original` | Always serves the original source file as-is, ignoring rendition tiers and player transcoding overrides. |

- When `sonusQuality` is omitted, the request executes the existing Subsonic `stream` behavior unchanged.
- When `sonusQuality` names an invalid value, the server responds with Subsonic error `0` (`invalid parameter 'sonusQuality'`).
- When the requested rendition is not ready yet (still generating, failed health check, or feature disabled), the server transparently falls back to the existing raw/on-demand transcoding path.
- All served renditions support HTTP `Range`, `HEAD`, and `If-*` conditional headers (`Accept-Ranges: bytes`).
- Opus renditions are always served with `Content-Type: audio/ogg` (not `audio/opus`) so browsers (`HTMLAudioElement`), ExoPlayer, and native clients all accept them uniformly.

### Response Headers

When `sonusQuality` is present on a `stream` response served by this server, the following response headers describe what was actually sent (and are exposed via `Access-Control-Expose-Headers`):

| Header | Example values | Description |
|---|---|---|
| `X-Sonus-Quality` | `lossless`, `veryHigh`, `high`, `normal`, `original`, `transcode` | Actual tier delivered (`original` when a lossy source is served directly for `lossless`/`veryHigh`, or when `sonusQuality=original`, or on raw fallback). |
| `X-Sonus-Format` | `flac`, `opus`, `mp3`, `wav`, … | Actual audio format/codec delivered. |
| `X-Sonus-Sample-Rate` | `96000`, `48000`, `44100` | Sample rate in Hz (omitted if unknown). |
| `X-Sonus-Bit-Depth` | `24`, `16` | Bits per sample for lossless PCM/FLAC streams (omitted for lossy formats or if unknown). |
| `X-Sonus-Bit-Rate` | `256`, `160`, `96`, `320`, `2840` | Bit rate in kbps (nominal tier bit rate for Opus renditions; average bit rate for FLAC/original; omitted if unknown). |

## 3. Read-Only Query Endpoints

Both endpoints are Subsonic protected methods (`/rest/<name>` and `/rest/<name>.view`), authenticated through the standard Subsonic sign-in check, and respond in standard Subsonic JSON envelope format.

### `getSonusRenditions`

Returns available ready renditions and EBU R128 loudness measurements for one or more songs visible to the signed-in user.

**Parameters**
- `id` (required, repeatable; up to 500 IDs per request): song ID(s). Songs that do not exist or belong to a library not granted to the signed-in user are silently omitted.

**Response**
```json
{
  "subsonic-response": {
    "status": "ok",
    "version": "1.16.1",
    "type": "navidrome",
    "serverVersion": "...",
    "openSubsonic": true,
    "sonusRenditions": {
      "enabled": true,
      "songs": [
        {
          "id": "song-1",
          "sourceFormat": "flac",
          "sourceLossless": true,
          "sourceSampleRate": 96000,
          "sourceBitDepth": 24,
          "sourceBitRate": 2910,
          "loudness": {
            "trackLufs": -10.6,
            "trackPeak": 0.912,
            "albumLufs": -11.2,
            "albumPeak": 0.985
          },
          "renditions": [
            {
              "tier": "lossless",
              "format": "flac",
              "sampleRate": 96000,
              "bitDepth": 24,
              "channels": 2,
              "totalSamples": 17280000,
              "bitRate": 3666,
              "fileSize": 82500000
            },
            {
              "tier": "veryHigh",
              "format": "opus",
              "sampleRate": 48000,
              "channels": 2,
              "totalSamples": 8640000,
              "bitRate": 256,
              "fileSize": 6100000
            }
          ]
        }
      ]
    }
  }
}
```

- `loudness` is omitted when neither track nor album EBU R128 loudness has been measured yet. `trackPeak` and `albumPeak` are linear true-peak amplitudes (`1.0` = `0 dBFS`).
- `renditions` lists only `ready` renditions for the source file's current on-disk version.
- When the playback library is disabled, returns `"enabled": false` and `"songs": []`.

### `getSonusLibraryHealth`

Admin-only endpoint returning playback library progress counts and the health-check issue list (songs whose source failed decoding or whose rendition duration differed from the source by more than 0.1 s).

**Authorization**
- Requires an admin user. Non-admin users receive Subsonic error `50` (`User is not authorized for the given operation`).

**Parameters**
- `limit` (optional, integer, default `200`, max `1000`): maximum number of issues returned.
- `offset` (optional, integer, default `0`): pagination offset.

**Response**
```json
{
  "subsonic-response": {
    "status": "ok",
    "version": "1.16.1",
    "type": "navidrome",
    "serverVersion": "...",
    "openSubsonic": true,
    "sonusLibraryHealth": {
      "enabled": true,
      "counts": {
        "ready": 4800,
        "pending": 12,
        "failed": 2,
        "deleting": 0
      },
      "totalIssues": 2,
      "issues": [
        {
          "songId": "song-bad",
          "title": "Broken Track",
          "artist": "Artist",
          "album": "Album",
          "tier": "lossless",
          "state": "failed",
          "health": "decode check failed: ...",
          "failures": 3
        }
      ]
    }
  }
}
```
