package com.creeperux.sonus.core

import kotlinx.serialization.json.JsonElement
import kotlin.math.roundToInt

/**
 * Server JSON → tracks, albums and artists (the Windows app's LibraryBuilder). Albums and artists keep the server's ids,
 * so they group the way the server groups them (album artist, compilations).
 */
object LibraryBuilder {
    private val lossy = setOf("mp3", "aac", "m4a", "ogg", "oga", "opus", "mpc", "wma", "mp2")
    private val codecs = mapOf(
        "flac" to "FLAC", "mp3" to "MP3", "aac" to "AAC", "ogg" to "Vorbis", "oga" to "Vorbis", "opus" to "Opus", "ape" to "Monkey's Audio",
        "wv" to "WavPack", "wav" to "PCM", "aif" to "PCM", "aiff" to "PCM", "wma" to "WMA", "mpc" to "Musepack", "tta" to "TTA", "tak" to "TAK", "mp2" to "MP2",
    )

    fun codecOf(suffix: String, sampleRate: Int, bitDepth: Int, contentType: String): String {
        val x = suffix.lowercase()
        if (x == "dsf" || x == "dff") return "DSD${max(1, ((if (sampleRate > 0) sampleRate else 2822400) / 2822400.0).roundToInt()) * 64}"
        if (x == "m4a" || x == "mp4" || x == "alac") return if (bitDepth > 0 || contentType.contains("alac", ignoreCase = true)) "ALAC" else "AAC"
        return codecs[x] ?: if (x.isNotEmpty()) x.uppercase() else "?"
    }

    private fun max(a: Int, b: Int) = if (a > b) a else b

    private fun firstName(e: JsonElement?, key: String) = J.array(e, key).firstNotNullOfOrNull { J.str(it, "name") }

    fun albumOf(a: JsonElement): Album {
        val types = J.array(a, "releaseTypes").mapNotNull { (it as? kotlinx.serialization.json.JsonPrimitive)?.content?.lowercase() }
        val type = when {
            "compilation" in types || J.bool(a, "isCompilation") -> AlbumType.Compilation
            "ep" in types -> AlbumType.Ep
            "single" in types -> AlbumType.Single
            "album" in types -> AlbumType.Album
            else -> null
        }
        val artist = J.str(a, "artist") ?: J.str(a, "displayArtist") ?: "未知艺人"
        return Album(
            id = J.str(a, "id")!!, title = J.str(a, "name") ?: J.str(a, "album") ?: "未知专辑", artist = artist,
            artistId = J.str(a, "artistId") ?: ("ar-" + artist.lowercase()), year = J.int(a, "year"),
            genre = J.str(a, "genre") ?: firstName(a, "genres") ?: "—", label = firstName(a, "recordLabels").orEmpty(), type = type,
            coverArt = J.str(a, "coverArt"),
        )
    }

    fun trackOf(s: JsonElement, albums: Map<String, Album>): Track {
        val al = albums[J.str(s, "albumId").orEmpty()]
        val suffix = J.str(s, "suffix").orEmpty().lowercase()
        val contentType = J.str(s, "contentType").orEmpty()
        val sampleRate = J.int(s, "samplingRate")
        val bitDepth = J.int(s, "bitDepth")
        val codec = codecOf(suffix, sampleRate, bitDepth, contentType)
        val dsd = codec.startsWith("DSD")
        val isLossy = suffix in lossy && codec != "ALAC"
        val albumArtist = al?.artist ?: J.str(s, "displayAlbumArtist") ?: firstName(s, "albumArtists") ?: J.str(s, "artist") ?: "未知艺人"
        val albumTitle = J.str(s, "album") ?: al?.title ?: "未知专辑"
        val rg = J.obj(s, "replayGain")
        val path = J.str(s, "path").orEmpty()
        val id = J.str(s, "id")!!
        val title = J.str(s, "title")?.takeIf { it.isNotEmpty() } ?: path.split('/', '\\').last().takeIf { it.isNotEmpty() } ?: id
        val channels = J.int(s, "channelCount")
        return Track(
            id = id, title = title, artist = J.str(s, "artist") ?: albumArtist,
            artistId = al?.artistId ?: J.array(s, "albumArtists").firstNotNullOfOrNull { J.str(it, "id") } ?: J.str(s, "artistId") ?: ("ar-" + albumArtist.lowercase()),
            album = albumTitle, albumId = J.str(s, "albumId") ?: ("al-" + albumTitle.lowercase()), albumArtist = albumArtist,
            number = J.int(s, "track"), disc = max(1, J.int(s, "discNumber")), duration = J.num(s, "duration"),
            genre = J.str(s, "genre") ?: firstName(s, "genres") ?: "—", year = J.int(s, "year"),
            codec = codec, bitrate = J.int(s, "bitRate"), sampleRate = sampleRate, bitDepth = if (dsd) 1 else if (isLossy) 0 else bitDepth,
            channels = if (channels > 0) channels else 2,
            path = path, size = J.num(s, "size").toLong(), added = J.date(s, "created"), playCount = J.int(s, "playCount"), lastPlayed = J.date(s, "played"),
            liked = J.str(s, "starred") != null, starredAt = J.date(s, "starred"), trackGain = J.numOrNull(rg, "trackGain"), albumGain = J.numOrNull(rg, "albumGain"),
            suffix = suffix, contentType = contentType, coverArt = J.str(s, "coverArt") ?: al?.coverArt, label = al?.label.orEmpty(),
        )
    }

    fun build(albumJson: List<JsonElement>, songJson: List<JsonElement>): LibrarySnapshot {
        val albums = LinkedHashMap<String, Album>()
        for (a in albumJson) albumOf(a).let { albums[it.id] = it }
        val tracks = ArrayList<Track>(songJson.size)
        val seen = HashSet<String>()
        for (s in songJson) {
            val t = trackOf(s, albums)
            if (seen.add(t.id)) tracks += t
        }
        return group(tracks, albums)
    }

    /** Tracks into albums (disc and track order) and artists; albums without songs are left out. */
    fun group(tracks: List<Track>, albums: MutableMap<String, Album>): LibrarySnapshot {
        val byId = tracks.associateBy { it.id }
        for (al in albums.values) al.trackIds.clear() // grouping again (a song added later) starts from scratch
        for (t in tracks) {
            val al = albums.getOrPut(t.albumId) {
                Album(id = t.albumId, title = t.album, artist = t.albumArtist, artistId = t.artistId, year = t.year, genre = t.genre, coverArt = t.coverArt)
            }
            al.trackIds += t.id
        }
        val artists = LinkedHashMap<String, Artist>()
        val kept = ArrayList<Album>()
        for (al in albums.values) {
            if (al.trackIds.isEmpty()) continue
            val ordered = al.trackIds.map { byId.getValue(it) }
                .sortedWith(compareBy<Track>({ it.disc }, { it.number }).thenBy { it.path })
                .map { it.id }
            al.trackIds.clear()
            al.trackIds += ordered
            if (al.year == 0) al.year = ordered.maxOf { byId.getValue(it).year }
            if (al.type == null) al.type = if (ordered.size <= 3) AlbumType.Single else if (ordered.size <= 6) AlbumType.Ep else AlbumType.Album
            val ar = artists.getOrPut(al.artistId) { Artist(al.artistId, al.artist, al.genre) }
            ar.albumIds += al.id
            kept += al
        }
        for (t in tracks) if (t.artistId !in artists) artists[t.artistId] = Artist(t.artistId, t.albumArtist, t.genre)
        return LibrarySnapshot(tracks, kept, artists.values.toList())
    }
}
