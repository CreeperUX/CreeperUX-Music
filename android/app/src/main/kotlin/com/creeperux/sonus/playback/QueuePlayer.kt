package com.creeperux.sonus.playback

import androidx.annotation.OptIn
import androidx.media3.common.ForwardingSimpleBasePlayer
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture

/**
 * The player as the system's media controls see it (the notification, the lock screen, headphones and car buttons):
 * ExoPlayer, except that next, previous and play go through [LocalPlayback], so they follow the queue (hand-queued
 * songs, shuffle, repeat, previous restarting a song past 3 s) exactly as the app's own buttons do. ExoPlayer itself
 * holds only the current song and the next one.
 */
@OptIn(UnstableApi::class)
class QueuePlayer(player: Player, private val playback: LocalPlayback) : ForwardingSimpleBasePlayer(player) {
    override fun getState(): State {
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

    override fun handleSeek(mediaItemIndex: Int, positionMs: Long, seekCommand: Int): ListenableFuture<*> {
        when (seekCommand) {
            Player.COMMAND_SEEK_TO_NEXT, Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM -> playback.next()
            Player.COMMAND_SEEK_TO_PREVIOUS, Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM -> playback.previous()
            else -> {
                if (positionMs != androidx.media3.common.C.TIME_UNSET) playback.seek(positionMs / 1000.0)
                return Futures.immediateVoidFuture()
            }
        }
        return Futures.immediateVoidFuture()
    }

    override fun handleSetPlayWhenReady(playWhenReady: Boolean): ListenableFuture<*> {
        if (playWhenReady) playback.resume() else playback.pause()
        return Futures.immediateVoidFuture()
    }
}
