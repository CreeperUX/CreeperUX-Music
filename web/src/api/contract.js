// The client contract: everything the interface needs from the music server and the player, and nothing else.
//
// The interface never talks to the server directly. It talks to a client (api/subsonic.js) that owns playback, the
// library, playlists, the playback queue, artwork and lyrics; the interface shows what the client reports and asks it
// for changes. Nothing changes on screen until the client confirms it (a refused playlist move simply does not happen).
//
// Ids are strings and stable for the session. Times are seconds, volume is 0–1, dates are milliseconds since 1970.

/**
 * @typedef {Object} Track
 * @property {string} id
 * @property {string} title
 * @property {string} artist
 * @property {string} artistId
 * @property {string} album
 * @property {string} albumId
 * @property {number} number          Track number on its disc.
 * @property {number} disc
 * @property {number} duration        Seconds.
 * @property {string} genre
 * @property {number} year
 * @property {string} codec           The codec: 'FLAC', "Monkey's Audio", 'DSD64', 'MP3', 'AAC', 'Opus' …
 * @property {number} bitrate         kbps.
 * @property {number} sampleRate      Hz.
 * @property {number} bitDepth        Bits per sample (1 for DSD, 0 for lossy).
 * @property {number} channels
 * @property {string} path            The file's path on the server, as the server reports it.
 * @property {number} size            Bytes.
 * @property {number} added           When it entered the media library.
 * @property {number} playCount       Plays counted by the server (scrobble).
 * @property {number | null} lastPlayed
 * @property {boolean} liked          Loved / rated 5: however the adapter maps it.
 * @property {{ track: number | null, album: number | null }} replayGain   dB.
 * @property {boolean} [unavailable]  The file is missing or cannot be decoded.
 * @property {string} [reason]
 */

/**
 * @typedef {Object} Album
 * @property {string} id
 * @property {string} title
 * @property {string} artist
 * @property {string} artistId
 * @property {number} year
 * @property {string} genre
 * @property {'album' | 'ep' | 'single' | 'compilation'} type
 * @property {string[]} trackIds      In disc and track order.
 * @property {string} [label]
 * @property {string} [color]         A colour taken from the artwork (#rrggbb); the interface samples one if absent.
 */

/**
 * @typedef {Object} Artist
 * @property {string} id
 * @property {string} name
 * @property {string[]} albumIds
 * @property {string} [genre]
 * @property {string} [color]
 */

/**
 * @typedef {Object} Playlist
 * @property {string} id
 * @property {string} name
 * @property {'liked' | 'user' | 'auto' | 'library'} kind   'auto': one you can only play (another user's, or a smart playlist).
 * @property {string[]} trackIds
 * @property {string} [description]
 * @property {string} [query]         A smart playlist's rules, when the server says them.
 * @property {boolean} [pinned]
 * @property {number} updated
 */

/**
 * @typedef {'default' | 'repeat-playlist' | 'repeat-track' | 'random' | 'shuffle-tracks' | 'shuffle-albums' | 'shuffle-folders'} PlaybackOrder
 * Playback orders. They exclude each other: shuffle and repeat are not independent switches.
 */

/**
 * @typedef {Object} PlayContext   What a play request plays from.
 * @property {'album' | 'playlist' | 'artist' | 'library' | 'search' | 'genre' | 'queue' | 'radio'} kind
 * @property {string} id
 * @property {string} label
 * @property {string[]} trackIds
 */

/**
 * @typedef {Object} PlayerState
 * @property {string | null} trackId
 * @property {'playing' | 'paused' | 'stopped' | 'loading' | 'error'} state
 * @property {string | null} error
 * @property {number} position
 * @property {number | null} duration
 * @property {number} volume
 * @property {boolean} muted
 * @property {PlaybackOrder} order
 * @property {boolean} stopAfterCurrent
 * @property {'track' | 'album' | 'off'} replayGain
 * @property {{ kind: string, id: string, label: string } | null} context
 * @property {string} output          The output device id.
 */

/**
 * @typedef {Object} QueueEntry
 * @property {string} id              Entry id (the same track may be queued twice).
 * @property {string} trackId
 * @property {'queue' | 'context'} section   'queue': songs queued by hand; 'context': what follows in the playing playlist.
 */

/**
 * @typedef {Object} Output
 * @property {string} id
 * @property {string} name
 * @property {'computer' | 'speaker' | 'headphones'} kind
 * @property {'connected' | 'available' | 'connecting' | 'unavailable' | 'error'} state
 * @property {string} [detail]        e.g. 'WASAPI (exclusive)'.
 */

/**
 * @typedef {{ type: 'player', player: PlayerState }
 *   | { type: 'position', position: number }
 *   | { type: 'queue', queue: QueueEntry[] }
 *   | { type: 'playlists', playlists: Playlist[] }
 *   | { type: 'track', track: Track }
 *   | { type: 'outputs', outputs: Output[] }
 *   | { type: 'connection', status: 'online' | 'offline' | 'connecting' }
 *   | { type: 'library', library: { tracks: Track[], albums: Album[], artists: Artist[] }, changed: boolean }
 *   | { type: 'error', message: string, retry?: () => void }} AdapterEvent
 * 'position' arrives about four times a second while playing and changes nothing else. 'library' replaces the whole
 * library (a real one changes while the app runs); `changed` says the set of tracks changed, not only their details.
 */

/**
 * @typedef {Object} MusicClient
 * @property {() => Promise<{ name: string, version: string }>} connect
 * @property {() => Promise<{ tracks: Track[], albums: Album[], artists: Artist[] }>} library
 * @property {() => Promise<Playlist[]>} playlists
 * @property {() => PlayerState} player
 * @property {() => QueueEntry[]} queue
 * @property {() => Output[]} outputs
 * @property {(listener: (event: AdapterEvent) => void) => () => void} subscribe
 *
 * @property {(o: { context: PlayContext, trackId?: string, shuffle?: boolean }) => Promise<void>} play
 * @property {() => Promise<void>} pause
 * @property {() => Promise<void>} resume
 * @property {() => Promise<void>} next
 * @property {() => Promise<void>} previous
 * @property {(seconds: number) => Promise<void>} seek
 * @property {(volume: number) => Promise<void>} setVolume
 * @property {(muted: boolean) => Promise<void>} setMuted
 * @property {(order: PlaybackOrder) => Promise<void>} setOrder
 * @property {(on: boolean) => Promise<void>} setStopAfterCurrent
 * @property {(mode: 'track' | 'album' | 'off') => Promise<void>} setReplayGain
 * @property {(id: string) => Promise<void>} setOutput
 *
 * @property {(trackIds: string[], o?: { next?: boolean }) => Promise<void>} queueAdd
 * @property {(o: { order: string[], keys: string[], section: 'queue' | 'context' }) => Promise<void>} queueMove   order: every entry id in the new order; keys: the moved entries; section: where they landed.
 * @property {(entryIds: string[]) => Promise<void>} queueRemove
 * @property {(section: 'queue' | 'context') => Promise<void>} queueClear
 *
 * @property {(trackId: string, liked: boolean) => Promise<void>} setLiked
 * @property {(name: string, trackIds?: string[]) => Promise<Playlist>} playlistCreate
 * @property {(id: string, name: string) => Promise<void>} playlistRename
 * @property {(id: string) => Promise<void>} playlistDelete
 * @property {(id: string, trackIds: string[]) => Promise<void>} playlistAdd
 * @property {(id: string, trackIds: string[], move?: { keys: string[], before: string | null }) => Promise<void>} playlistReorder   The full new order, and the move that made it (keys now sit before `before`; null: at the end). Without `move`, an adapter restores what it can (Undo).
 * @property {(id: string, trackIds: string[]) => Promise<void>} playlistRemove
 *
 * @property {(albumId: string, signal?: AbortSignal) => Promise<string | null>} artwork   A URL, or null for none.
 * @property {(trackId: string, signal?: AbortSignal) => Promise<Array<{ time?: number, text: string }> | null>} lyrics
 * @property {(query: string) => Promise<{ tracks: string[], albums: string[], artists: string[], playlists: string[] }>} search   Ids.
 * @property {(entryId: string) => Promise<void>} [playQueueEntry]   Plays a queue entry at once (otherwise the app moves it to the front and skips).
 * @property {() => void} [goOnline]   Tries to reconnect after a lost connection.
 * @property {{ replayGain?: boolean }} [capabilities]   false hides a control the player cannot change.
 */

const REQUIRED = ['connect', 'library', 'playlists', 'player', 'queue', 'outputs', 'subscribe', 'play', 'pause', 'resume', 'next', 'previous', 'seek', 'setVolume', 'setMuted', 'setOrder',
  'setStopAfterCurrent', 'setReplayGain', 'setOutput', 'queueAdd', 'queueMove', 'queueRemove', 'queueClear', 'setLiked', 'playlistCreate', 'playlistRename', 'playlistDelete', 'playlistAdd',
  'playlistReorder', 'playlistRemove', 'artwork', 'lyrics', 'search'];

/** Throws when an adapter lacks part of the contract, naming what is missing. */
export function assertAdapter(adapter) {
  const missing = REQUIRED.filter(k => typeof adapter?.[k] !== 'function');
  if (missing.length) throw new TypeError(`the client is missing: ${missing.join(', ')}`);
  return adapter;
}

/** Playback orders ↔ the playback bar's shuffle and repeat controls. */
export const orderToBar = order => ({
  shuffle: order === 'random' || order.startsWith('shuffle'),
  repeat: order === 'repeat-playlist' ? 'all' : order === 'repeat-track' ? 'one' : 'off',
});
export const barToOrder = ({ shuffle, repeat }) => (shuffle ? 'shuffle-tracks' : repeat === 'all' ? 'repeat-playlist' : repeat === 'one' ? 'repeat-track' : 'default');
