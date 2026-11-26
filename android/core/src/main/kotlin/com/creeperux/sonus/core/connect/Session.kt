package com.creeperux.sonus.core.connect

import com.creeperux.sonus.core.J
import com.creeperux.sonus.core.PlaybackOrder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.longOrNull

// Sonus Connect version 2 (docs/protocol/connect.md): the user's one playback session, as the server holds it. The
// shapes follow the Windows app's Sonus.Core/Connect/SessionClient.cs.

/** The song a session plays: the queue entry it was when it became current (its key), the song, queued by hand or not. */
data class SessionCurrent(val key: String, val trackId: String, val manual: Boolean)

/** What any device shows of the current song without looking it up. */
data class SessionNow(val title: String?, val artist: String?, val album: String?, val albumId: String?, val coverArt: String?)

data class SessionDeviceRef(val id: String, val name: String)

data class SessionContext(val kind: String, val id: String, val label: String)

/** The session: what plays, where, the position at the server's time [at], the order. The server is its only truth. */
data class PlaybackSession(
    val rev: Long = 0,
    /** The device that plays; null: nothing plays (rules 6, 7). */
    val activeDevice: String? = null,
    /** The device that played last (while one plays: that one). */
    val lastDevice: SessionDeviceRef? = null,
    val current: SessionCurrent? = null,
    /** What follows when the current song ends, to preload; null when that is not known. */
    val next: String? = null,
    val playing: Boolean = false,
    val positionMs: Long = 0,
    val at: Long = 0,
    val durationMs: Long = 0,
    val now: SessionNow? = null,
    val mode: String = "default",
    val stopAfterCurrent: Boolean = false,
    val context: SessionContext? = null,
    val queueRev: Long = 0,
) {
    /** The position at the server's time [serverNow]: while playing it moves on with the clock and stops at the song's
     *  end, the library's [durationMs] or the position last reported if that is further (the real file can be a second
     *  or two longer than the library says). A reported position is never held to the duration. */
    fun positionAt(serverNow: Long): Long {
        if (!playing) return positionMs
        val p = positionMs + maxOf(0, serverNow - at)
        return if (durationMs > 0) minOf(p, maxOf(durationMs, positionMs)) else p
    }

    companion object {
        fun parse(e: JsonElement?): PlaybackSession? {
            val o = e as? JsonObject ?: return null
            val last = J.obj(o, "lastDevice")
            val cur = J.obj(o, "current")
            val now = J.obj(o, "now")
            val ctx = J.obj(o, "context")
            return PlaybackSession(
                rev = long(o, "rev"),
                activeDevice = J.str(o, "activeDevice"),
                lastDevice = last?.let { l -> J.str(l, "id")?.let { SessionDeviceRef(it, J.str(l, "name").orEmpty()) } },
                current = cur?.let { c -> J.str(c, "key")?.let { k -> J.str(c, "trackId")?.let { SessionCurrent(k, it, J.bool(c, "manual")) } } },
                next = J.str(o, "next"),
                playing = J.bool(o, "playing"),
                positionMs = long(o, "positionMs"),
                at = long(o, "at"),
                durationMs = long(o, "durationMs"),
                now = now?.let { SessionNow(J.str(it, "title"), J.str(it, "artist"), J.str(it, "album"), J.str(it, "albumId"), J.str(it, "coverArt")) },
                mode = J.str(o, "mode") ?: "default",
                stopAfterCurrent = J.bool(o, "stopAfterCurrent"),
                context = ctx?.let { SessionContext(J.str(it, "kind") ?: "queue", J.str(it, "id").orEmpty(), J.str(it, "label").orEmpty()) },
                queueRev = long(o, "queueRev"),
            )
        }
    }
}

/** A song queued by hand, with the server's key ("q41"). */
data class SessionManual(val key: String, val trackId: String)

/** The session's queue: the context in playback order, the pointer to its current song, the songs queued by hand. */
data class SessionQueue(val queueRev: Long, val order: List<String>, val pointer: Int, val manual: List<SessionManual>) {
    companion object {
        val Empty = SessionQueue(0, emptyList(), -1, emptyList())

        fun parse(e: JsonElement?): SessionQueue? {
            val o = e as? JsonObject ?: return null
            return SessionQueue(
                queueRev = long(o, "queueRev"),
                order = J.array(o, "order").mapNotNull { (it as? JsonPrimitive)?.content },
                pointer = J.numOrNull(o, "pointer")?.toInt() ?: -1,
                manual = J.array(o, "manual").mapNotNull { m -> J.str(m, "key")?.let { k -> J.str(m, "trackId")?.let { SessionManual(k, it) } } },
            )
        }
    }
}

/** One of the user's connected devices (this one included). */
data class SessionDevice(
    val id: String,
    val name: String,
    val kind: String,
    val client: String,
    val canPlay: Boolean,
    val connectedAt: Long,
    val volume: Double,
    val muted: Boolean,
) {
    companion object {
        fun parse(e: JsonElement): SessionDevice? {
            val id = J.str(e, "id") ?: return null
            return SessionDevice(
                id, J.str(e, "name").orEmpty(), J.str(e, "kind") ?: "other", J.str(e, "client").orEmpty(),
                (e as? JsonObject)?.get("canPlay")?.let { (it as? JsonPrimitive)?.content != "false" } ?: true,
                long(e, "connectedAt"), J.numOrNull(e, "volume") ?: 1.0, J.bool(e, "muted"),
            )
        }
    }
}

/** What a device that was active and kept playing through a network loss says when it reconnects. */
data class SessionResume(val rev: Long, val playing: Boolean, val positionMs: Long)

/** The server's answer to a message: applied (the session's rev then), or an error code and message. */
data class SessionReply(val ok: Boolean, val rev: Long, val code: String? = null, val message: String? = null)

/** Another device changed this one's volume (volume, muted, from whom). */
data class VolumeAsk(val volume: Double?, val muted: Boolean?, val from: String)

/** The protocol's names of the playback orders, and the context window it allows. */
object SessionModes {
    fun of(order: PlaybackOrder) = when (order) {
        PlaybackOrder.RepeatPlaylist -> "repeatAll"
        PlaybackOrder.RepeatTrack -> "repeatOne"
        PlaybackOrder.Random -> "random"
        PlaybackOrder.ShuffleTracks -> "shuffleTracks"
        PlaybackOrder.ShuffleAlbums -> "shuffleAlbums"
        PlaybackOrder.ShuffleFolders -> "shuffleFolders"
        PlaybackOrder.Default -> "default"
    }

    fun parse(mode: String?) = when (mode) {
        "repeatAll" -> PlaybackOrder.RepeatPlaylist
        "repeatOne" -> PlaybackOrder.RepeatTrack
        "random" -> PlaybackOrder.Random
        "shuffleTracks" -> PlaybackOrder.ShuffleTracks
        "shuffleAlbums" -> PlaybackOrder.ShuffleAlbums
        "shuffleFolders" -> PlaybackOrder.ShuffleFolders
        else -> PlaybackOrder.Default
    }

    /** At most [limit] songs of a context (the protocol's limit): a window of them in their own order that holds the
     *  start song (from 100 before it), or the first ones. The server does the same. */
    fun window(ids: List<String>, startId: String?, limit: Int = 10_000): List<String> {
        if (ids.size <= limit) return ids
        val at = if (startId == null) -1 else ids.indexOf(startId)
        val from = if (at < 0) 0 else maxOf(0, minOf(at - 100, ids.size - limit))
        return ids.drop(from).take(limit)
    }
}

private fun long(e: JsonElement?, name: String): Long = ((e as? JsonObject)?.get(name) as? JsonPrimitive)?.longOrNull ?: J.num(e, name).toLong()
