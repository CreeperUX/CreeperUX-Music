package com.creeperux.sonus

import android.content.ComponentName
import android.graphics.Color
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.creeperux.sonus.data.ThemeMode
import com.creeperux.sonus.playback.PlaybackService
import com.creeperux.sonus.ui.SonusRoot
import com.creeperux.sonus.ui.theme.SonusTheme
import com.google.common.util.concurrent.ListenableFuture

class MainActivity : ComponentActivity() {
    private var controller: ListenableFuture<MediaController>? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        val graph = (application as SonusApp).graph
        setContent {
            val mode by graph.themeMode.collectAsState()
            val dark = when (mode) {
                ThemeMode.Dark -> true
                ThemeMode.Light -> false
                ThemeMode.System -> isSystemInDarkTheme()
            }
            // keep system bar icon contrast in sync with the in-app theme choice (e.g. Light mode on a dark system)
            DisposableEffect(dark) {
                val style = if (dark) SystemBarStyle.dark(Color.TRANSPARENT) else SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT)
                enableEdgeToEdge(statusBarStyle = style, navigationBarStyle = style)
                onDispose {}
            }
            SonusTheme(mode) { SonusRoot(graph) }
        }
    }

    override fun onStart() {
        super.onStart()
        // connecting to the session starts the playback service, which keeps the music going in the background and
        // shows the media notification while something plays
        controller = MediaController.Builder(this, SessionToken(this, ComponentName(this, PlaybackService::class.java))).buildAsync()
    }

    override fun onStop() {
        controller?.let(MediaController::releaseFuture)
        controller = null
        super.onStop()
    }
}
