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
    /** Concise active quality label shown on the playback bar / player (e.g. "无损 · 96 kHz/24 位", "Opus 160"). */
    val qualityBadge: String? = null,
    val qualityIsLossless: Boolean = false,
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

    /** The song [next] will move to (read again when [PlayerState.queueVersion] or [PlayerState.trackId] changes), or null. */
    val nextTrackId: String?

    /** The song [previousTrack] will move to, or null at the start of a non-repeating list or in Random order. */
    val previousTrackId: String?

    /** Whether skipping forward can move to a song (true in Random order while context is non-empty). */
    val canSkipNext: Boolean

    /** Whether skipping backward can move to a song (true in Random order while context is non-empty). */
    val canSkipPrevious: Boolean

    /** Plays a context (an album, a playlist, a list of songs) from [startId], or its first song. */
    fun play(context: PlayContext, ids: List<String>, startId: String? = null, shuffle: Boolean = false)

    fun togglePlay()
    fun resume()
    fun pause()
    fun next()
    fun previous()
    /** Skips straight to the previous song without the 3-second restart rule (used by swipe gestures). */
    fun previousTrack()
    fun seek(seconds: Double)
    fun setOrder(order: PlaybackOrder)
    fun setStopAfterCurrent(on: Boolean)
    fun queueAdd(ids: List<String>, next: Boolean = false)
    fun queueRemove(entryIds: List<String>)
    fun queueClear(manual: Boolean)
    fun queueJump(entryId: String)
}
