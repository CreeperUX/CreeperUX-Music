package com.creeperux.sonus.playback

import android.app.PendingIntent
import android.content.Intent
import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.DefaultMediaNotificationProvider
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import com.creeperux.sonus.MainActivity
import com.creeperux.sonus.R
import com.creeperux.sonus.SonusApp

/**
 * Keeps the music playing with the app in the background, and gives the system its media controls: Media3 shows the
 * notification (with the cover, play/pause, previous and next), the lock screen controls, and takes headphone, Bluetooth
 * and car buttons, all through [QueuePlayer]. The player itself belongs to the app ([LocalPlayback]), so the session
 * can come and go without stopping what plays.
 */
@OptIn(UnstableApi::class)
class PlaybackService : MediaSessionService() {
    private var session: MediaSession? = null

    override fun onCreate() {
        super.onCreate()
        val playback = (application as SonusApp).graph.playback
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        setMediaNotificationProvider(DefaultMediaNotificationProvider.Builder(this).build().apply { setSmallIcon(R.drawable.ic_notification) })
        session = MediaSession.Builder(this, playback.sessionPlayer).setSessionActivity(open).build()
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = session

    override fun onTaskRemoved(rootIntent: Intent?) {
        // swiped away while nothing plays: go; while playing, the music goes on (the notification stops it)
        val player = session?.player
        if (player == null || !player.playWhenReady || player.mediaItemCount == 0) stopSelf()
    }

    override fun onDestroy() {
        session?.release() // the player is the app's: it is not released here
        session = null
        super.onDestroy()
    }
}
