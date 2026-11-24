package com.creeperux.sonus.playback

import com.creeperux.sonus.core.PlayContext
import com.creeperux.sonus.core.PlaybackOrder
import com.creeperux.sonus.core.QueueEntry
import kotlinx.coroutines.flow.StateFlow

enum class PlayerStatus { Stopped, Loading, Playing, Paused, Error }

/** What the player shows: the song, how it plays, the order, where the songs come from. [queueVersion] goes up when the
 *  queue's entries change. */
data class PlayerState(
    val trackId: String? = null,
    val status: PlayerStatus = PlayerStatus.Stopped,
    val error: String? = null,
    val order: PlaybackOrder = PlaybackOrder.Default,
    val stopAfterCurrent: Boolean = false,
    val context: PlayContext? = null,
    val queueVersion: Int = 0,
    /** Seconds; 0 while unknown. */
    val duration: Double = 0.0,
) {
    val isActive: Boolean get() = status == PlayerStatus.Playing || status == PlayerStatus.Loading
}

/**
 * What the interface plays through. Today it is [LocalPlayback], this device's own player. Sonus Connect v2
 * (docs/protocol/connect.md, a later change) adds a second implementation: a remote that shows the user's one session,
 * whichever device plays it, and sends every command to the server; this device then plays only while it is the
 * session's active device, with [LocalPlayback] doing the playing as the server's session tells it. Both keep
 * PlayQueue's behaviour, so the screens do not care which one they talk to.
 */
interface Playback {
    val state: StateFlow<PlayerState>

    /** Seconds into the song, updated four times a second while it plays. */
    val position: StateFlow<Double>

    /** Hand-queued songs first, then the rest of the context (read again when [PlayerState.queueVersion] changes). */
    val queueEntries: List<QueueEntry>

    /** Plays a context (an album, a playlist, a list of songs) from [startId], or its first song. */
    fun play(context: PlayContext, ids: List<String>, startId: String? = null, shuffle: Boolean = false)

    fun togglePlay()
    fun resume()
    fun pause()
    fun next()
    fun previous()
    fun seek(seconds: Double)
    fun setOrder(order: PlaybackOrder)
    fun setStopAfterCurrent(on: Boolean)
    fun queueAdd(ids: List<String>, next: Boolean = false)
    fun queueRemove(entryIds: List<String>)
    fun queueClear(manual: Boolean)
    fun queueJump(entryId: String)
}
