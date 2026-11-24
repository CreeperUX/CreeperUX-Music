package com.creeperux.sonus.playback

import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.DeviceInfo
import androidx.media3.common.ForwardingSimpleBasePlayer
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.common.SimpleBasePlayer
import androidx.media3.common.util.UnstableApi
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import kotlin.math.roundToInt

/**
 * The player as the system's media controls see it (the notification, the lock screen, headphones and car buttons):
 * ExoPlayer, except that next, previous and play go through [LocalPlayback], so they follow the queue (hand-queued
 * songs, shuffle, repeat, previous restarting a song past 3 s) exactly as the app's own buttons do. ExoPlayer itself
 * holds only the current song and the next one.
 *
 * With Sonus Connect version 2, while another device plays the user's session, it is that device's playback instead:
 * the song and the position the session says, and every button a command for the session (the user chose to have this:
 * the notification and lock screen steer the computer that plays).
 */
@OptIn(UnstableApi::class)
class QueuePlayer(player: Player, private val playback: LocalPlayback) : ForwardingSimpleBasePlayer(player) {
    /** The session changed: the media controls are told. */
    fun refresh() = invalidateState()

    private companion object {
        /** Volume steps of a remote device, as the system's volume panel shows them: Android's usual media volume steps, so one
         *  key press is one step on the device that plays (finer steps would round away there). */
        const val STEPS = 15
    }

    override fun getState(): State {
        playback.remoteSession?.let { return remoteState(it) }
        val s = super.getState()
        if (s.playlist.isEmpty()) return s
        val commands = s.availableCommands.buildUpon()
            .addAll(
                Player.COMMAND_SEEK_TO_NEXT, Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM,
                Player.COMMAND_SEEK_TO_PREVIOUS, Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM, Player.COMMAND_PLAY_PAUSE,
            )
            .build()
        return s.buildUpon().setAvailableCommands(commands).build()
    }

    /** Another device's playback of the session: its song, playing or paused, the position moving on with the server's clock. */
    private fun remoteState(session: com.creeperux.sonus.core.connect.PlaybackSession): State {
        val link = playback.link.value
        val key = session.current!!.key
        val item = MediaItem.Builder().setMediaId(session.current!!.trackId).setMediaMetadata(playback.metadataFor(session)).build()
        val data = MediaItemData.Builder(key)
            .setMediaItem(item)
            .setDurationUs(if (session.durationMs > 0) session.durationMs * 1000 else C.TIME_UNSET)
            .setIsSeekable(true)
            .build()
        // the device that plays, as a remote playback: the system's volume keys (and its volume panel) then change that
        // device's volume, as rule 8 allows any device to
        val target = link?.devices?.firstOrNull { it.id == session.activeDevice }
        return State.Builder()
            .setAvailableCommands(
                Player.Commands.Builder().addAll(
                    Player.COMMAND_PLAY_PAUSE, Player.COMMAND_SEEK_TO_NEXT, Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM,
                    Player.COMMAND_SEEK_TO_PREVIOUS, Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM, Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM,
                    Player.COMMAND_GET_CURRENT_MEDIA_ITEM, Player.COMMAND_GET_TIMELINE, Player.COMMAND_GET_METADATA,
                    Player.COMMAND_GET_DEVICE_VOLUME, Player.COMMAND_SET_DEVICE_VOLUME_WITH_FLAGS, Player.COMMAND_ADJUST_DEVICE_VOLUME_WITH_FLAGS,
                    // the older commands too: the platform's volume keys may come in through them
                    @Suppress("DEPRECATION") Player.COMMAND_SET_DEVICE_VOLUME, @Suppress("DEPRECATION") Player.COMMAND_ADJUST_DEVICE_VOLUME,
                ).build(),
            )
            .setDeviceInfo(DeviceInfo.Builder(DeviceInfo.PLAYBACK_TYPE_REMOTE).setMinVolume(0).setMaxVolume(STEPS).build())
            .setDeviceVolume(((target?.volume ?: 1.0) * STEPS).roundToInt())
            .setIsDeviceMuted(target?.muted == true)
            .setPlaylist(listOf(data))
            .setCurrentMediaItemIndex(0)
            .setPlaybackState(Player.STATE_READY)
            .setPlayWhenReady(session.playing, Player.PLAY_WHEN_READY_CHANGE_REASON_REMOTE)
            .setContentPositionMs(SimpleBasePlayer.PositionSupplier { session.positionAt(link?.serverNow ?: System.currentTimeMillis()) })
            .build()
    }

    override fun handleSeek(mediaItemIndex: Int, positionMs: Long, seekCommand: Int): ListenableFuture<*> {
        when (seekCommand) {
            Player.COMMAND_SEEK_TO_NEXT, Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM -> playback.next()
            Player.COMMAND_SEEK_TO_PREVIOUS, Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM -> playback.previous()
            else -> if (positionMs != C.TIME_UNSET) playback.seek(positionMs / 1000.0)
        }
        return Futures.immediateVoidFuture()
    }

    // the volume of the device that plays the session (remote playback only; locally ExoPlayer's own handling applies)
    override fun handleSetDeviceVolume(deviceVolume: Int, flags: Int): ListenableFuture<*> {
        remoteDevice()?.let { (link, id) -> link.setVolume(id, deviceVolume.coerceIn(0, STEPS) / STEPS.toDouble()) } ?: return super.handleSetDeviceVolume(deviceVolume, flags)
        return Futures.immediateVoidFuture()
    }

    override fun handleIncreaseDeviceVolume(flags: Int): ListenableFuture<*> = stepVolume(+1) ?: super.handleIncreaseDeviceVolume(flags)

    override fun handleDecreaseDeviceVolume(flags: Int): ListenableFuture<*> = stepVolume(-1) ?: super.handleDecreaseDeviceVolume(flags)

    override fun handleSetDeviceMuted(muted: Boolean, flags: Int): ListenableFuture<*> {
        remoteDevice()?.let { (link, id) -> link.setVolume(id, null, muted) } ?: return super.handleSetDeviceMuted(muted, flags)
        return Futures.immediateVoidFuture()
    }

    private fun remoteDevice() = playback.remoteSession?.activeDevice?.let { id -> playback.link.value?.let { it to id } }

    private fun stepVolume(dir: Int): ListenableFuture<*>? {
        val (link, id) = remoteDevice() ?: return null
        android.util.Log.i("Sonus", "volume key ${if (dir > 0) "up" else "down"} for the device that plays")
        val now = link.devices.firstOrNull { it.id == id }?.volume ?: 1.0
        link.setVolume(id, ((now * STEPS).roundToInt() + dir).coerceIn(0, STEPS) / STEPS.toDouble())
        return Futures.immediateVoidFuture()
    }

    override fun handleSetPlayWhenReady(playWhenReady: Boolean): ListenableFuture<*> {
        if (playWhenReady) playback.resume() else playback.pause()
        return Futures.immediateVoidFuture()
    }
}
