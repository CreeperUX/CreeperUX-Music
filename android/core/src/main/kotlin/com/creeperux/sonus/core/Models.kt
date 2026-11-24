package com.creeperux.sonus.core

/**
 * A song as the server reports it (the Windows app's Track). Liked, play count and last played change while the app
 * runs; whoever changes them tells the library's watchers (MusicSession bumps its revision).
 */
class Track(
    val id: String,
    val title: String,
    val artist: String,
    /** The album artist's id: what "go to artist" opens and what groups the library. */
    val artistId: String,
    val album: String,
    val albumId: String,
    val albumArtist: String,
    val number: Int = 0,
    val disc: Int = 1,
    /** Seconds. */
    val duration: Double = 0.0,
    val genre: String = "—",
    val year: Int = 0,
    /** "FLAC", "MP3", "AAC", "ALAC", "Opus", "DSD64", "Monkey's Audio" … */
    val codec: String = "?",
    /** kbps. */
    val bitrate: Int = 0,
    val sampleRate: Int = 0,
    /** Bits per sample: 0 for lossy formats, 1 for DSD. */
    val bitDepth: Int = 0,
    val channels: Int = 2,
    val path: String = "",
    val size: Long = 0,
    /** Epoch milliseconds. */
    val added: Long? = null,
    val trackGain: Double? = null,
    val albumGain: Double? = null,
    /** The file's extension, lower case ("flac", "dsf" …). */
    val suffix: String = "",
    val contentType: String = "",
    val coverArt: String? = null,
    val label: String = "",
    var playCount: Int = 0,
    /** Epoch milliseconds. */
    var lastPlayed: Long? = null,
    var liked: Boolean = false,
    /** Epoch milliseconds. */
    var starredAt: Long? = null,
) {
    val isLossless: Boolean get() = bitDepth > 0
    val isHiRes: Boolean get() = bitDepth > 16 || sampleRate > 48000

    override fun toString() = "Track($id, $title)"
}

enum class AlbumType { Album, Ep, Single, Compilation }

class Album(
    val id: String,
    val title: String,
    val artist: String,
    val artistId: String,
    var year: Int = 0,
    val genre: String = "—",
    val label: String = "",
    var type: AlbumType? = null,
    val coverArt: String? = null,
) {
    /** In disc and track order. */
    val trackIds: MutableList<String> = mutableListOf()
}

class Artist(val id: String, val name: String, val genre: String = "—") {
    val albumIds: MutableList<String> = mutableListOf()
}

enum class PlaylistKind { Liked, Library, User, ReadOnly }

class Playlist(
    val id: String,
    var name: String,
    val kind: PlaylistKind,
    val owner: String = "",
    val comment: String? = null,
    var changed: Long = System.currentTimeMillis(),
    /** The playlist as stored: a song may appear more than once. */
    var entries: List<String> = emptyList(),
) {
    /** Each song once, in order (what lists show). */
    val trackIds: List<String> get() = entries.distinct()
    val isEditable: Boolean get() = kind == PlaylistKind.User
}

/** The whole library: songs, albums and artists, with lookups. */
class LibrarySnapshot(val tracks: List<Track>, val albums: List<Album>, val artists: List<Artist>) {
    val trackById: Map<String, Track> = tracks.associateBy { it.id }
    val albumById: Map<String, Album> = albums.associateBy { it.id }
    val artistById: Map<String, Artist> = artists.associateBy { it.id }

    fun track(id: String?): Track? = id?.let(trackById::get)
    fun album(id: String?): Album? = id?.let(albumById::get)
    fun artist(id: String?): Artist? = id?.let(artistById::get)

    /** An artist's songs, newest album first. */
    fun artistTracks(artistId: String): List<String> =
        artist(artistId)?.albumIds?.mapNotNull(::album)?.sortedByDescending { it.year }?.flatMap { it.trackIds } ?: emptyList()

    companion object {
        val Empty = LibrarySnapshot(emptyList(), emptyList(), emptyList())
    }
}

enum class PlaybackOrder { Default, RepeatPlaylist, RepeatTrack, Random, ShuffleTracks, ShuffleAlbums, ShuffleFolders }

enum class ReplayGainMode { Album, Track, Off }

/** Where the playing songs come from: an album, a playlist, an artist, search results, a radio … */
data class PlayContext(val kind: String, val id: String, val label: String)

/** A line of lyrics; [time] in seconds, null for unsynced lyrics. */
data class LyricLine(val time: Double?, val text: String)

/** The queue another device (or this one, last time) saved on the server. */
data class RemoteQueue(val trackIds: List<String>, val current: String, val position: Double, val changed: Long, val changedBy: String)

data class ServerInfo(val name: String, val version: String, val apiVersion: String, val openSubsonic: Boolean)

data class ArtistInfo(val biography: String, val url: String?)

data class SearchResult(val tracks: List<String>, val albums: List<String>, val artists: List<String>) {
    val count: Int get() = tracks.size + albums.size + artists.size

    companion object {
        val None = SearchResult(emptyList(), emptyList(), emptyList())
    }
}
