package com.creeperux.sonus

import android.app.Application
import android.content.Context
import coil3.ImageLoader
import coil3.PlatformContext
import coil3.SingletonImageLoader
import coil3.disk.DiskCache
import coil3.disk.directory
import coil3.memory.MemoryCache
import coil3.network.okhttp.OkHttpNetworkFetcherFactory
import coil3.request.crossfade
import com.creeperux.sonus.core.AppName
import com.creeperux.sonus.core.DeviceLogin
import com.creeperux.sonus.core.Login
import com.creeperux.sonus.core.ServerUnreachableException
import com.creeperux.sonus.core.SubsonicClient
import com.creeperux.sonus.core.SubsonicException
import com.creeperux.sonus.core.connect.SessionClient
import com.creeperux.sonus.data.KeystoreBox
import com.creeperux.sonus.data.LoginStore
import com.creeperux.sonus.data.Settings
import com.creeperux.sonus.data.ThemeMode
import com.creeperux.sonus.playback.LocalPlayback
import com.creeperux.sonus.session.MusicSession
import com.creeperux.sonus.session.SessionLink
import com.creeperux.sonus.session.Toast
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

class SonusApp : Application(), SingletonImageLoader.Factory {
    lateinit var graph: AppGraph
        private set

    override fun onCreate() {
        super.onCreate()
        graph = AppGraph(this)
        graph.start()
    }

    /** Covers: through the app's one OkHttp client, 64 MB in memory (the Windows app keeps 48), 256 MB on disk. */
    override fun newImageLoader(context: PlatformContext): ImageLoader = ImageLoader.Builder(context)
        .components { add(OkHttpNetworkFetcherFactory(callFactory = { SubsonicClient.Shared })) }
        .memoryCache { MemoryCache.Builder().maxSizeBytes(64L * 1024 * 1024).build() }
        .diskCache { DiskCache.Builder().directory(context.cacheDir.resolve("covers")).maxSizeBytes(256L * 1024 * 1024).build() }
        .crossfade(true)
        .build()
}

/** Where the app stands: reading the sign-in, signed out, connecting, ready, or unable to reach the server. */
sealed interface AppState {
    data object Starting : AppState
    data class SignedOut(val message: String? = null) : AppState
    data class Connecting(val login: Login) : AppState
    data class Ready(val session: MusicSession) : AppState
    data class Failed(val login: Login, val message: String) : AppState
}

/** The app's parts, made once per process: settings, the kept sign-in, the player, and the session once signed in. */
class AppGraph(private val app: Context, val scope: CoroutineScope = MainScope()) {
    val settings = Settings(app.getSharedPreferences("settings", Context.MODE_PRIVATE))
    val logins = LoginStore(app.getSharedPreferences("sign-in", Context.MODE_PRIVATE), KeystoreBox())
    val playback = LocalPlayback(app, settings, SubsonicClient.Shared, scope)
    private val stateFlow = MutableStateFlow<AppState>(AppState.Starting)
    val state: StateFlow<AppState> = stateFlow.asStateFlow()
    val themeMode = MutableStateFlow(settings.theme)

    fun setTheme(mode: ThemeMode) {
        settings.theme = mode
        themeMode.value = mode
    }
    private var connecting: Job? = null

    /** What the server lists this app as: "Sonus (小明的手机)". */
    val clientName: String get() = AppName.client(deviceName)
    val deviceName: String get() = Settings.deviceName(app)

    fun start() {
        val login = logins.load()
        if (login == null) stateFlow.value = AppState.SignedOut() else connect(login)
    }

    /** Connects with a kept sign-in: the library and playlists, then the queue saved last time, paused. */
    fun connect(login: Login) {
        connecting?.cancel()
        stateFlow.value = AppState.Connecting(login)
        connecting = scope.launch {
            val session = MusicSession(SubsonicClient(login, clientName))
            try {
                session.start()
            } catch (e: SubsonicException) {
                if (e.isAuthentication) {
                    // the password changed or the key was revoked: the kept sign-in is no good any more
                    logins.clear()
                    stateFlow.value = AppState.SignedOut(e.message)
                } else {
                    stateFlow.value = AppState.Failed(login, e.message.orEmpty())
                }
                return@launch
            } catch (e: ServerUnreachableException) {
                stateFlow.value = AppState.Failed(login, e.message.orEmpty())
                return@launch
            } catch (e: SubsonicClient.NotSubsonicException) {
                stateFlow.value = AppState.Failed(login, "服务器的回答不像 Navidrome。")
                return@launch
            }
            // the server's address redirects (http:// to https://): the sign-in keeps the one it answered at
            val moved = session.client.login
            if (moved != login) {
                logins.save(moved)
                settings.lastServer = moved.server
            }
            playback.attach(session)
            closeLink()
            if (SessionClient.supported(session.client)) {
                // Sonus Connect version 2: the user's one session, kept on the server (it replaces 接着上次听, rule 6)
                val tablet = app.resources.configuration.smallestScreenWidthDp >= 600
                link = SessionLink(
                    app, session, playback, settings.deviceId, deviceName, if (tablet) "tablet" else "phone",
                    "Sonus ${BuildConfigInfo.versionName(app)} (Android)", scope,
                ).also {
                    playback.attachLink(it)
                    it.start()
                }
                stateFlow.value = AppState.Ready(session)
            } else {
                stateFlow.value = AppState.Ready(session)
                offerSavedQueue(session)
            }
        }
    }

    /** Sonus Connect version 2 of the signed-in session, when the server offers it. */
    var link: SessionLink? = null
        private set

    private fun closeLink() {
        val l = link ?: return
        link = null
        scope.launch { l.close() }
    }

    /** The queue saved on the server last time (here or on another device), loaded paused, with an offer to go on. */
    private suspend fun offerSavedQueue(session: MusicSession) {
        val q = try {
            session.remoteQueue()
        } catch (_: Exception) {
            null
        } ?: return
        if (playback.state.value.trackId != null) return
        val t = session.lib.track(q.current) ?: return
        val device = AppName.deviceOf(q.changedBy)
        val here = q.changedBy.isEmpty() || q.changedBy == clientName
        val label = if (here) "上次播放" else "来自「$device」"
        playback.continueQueue(q, label)
        session.say(Toast(if (here) "接着上次听：${t.title}" else "从「$device」接着听：${t.title}", actionLabel = "接着播放", action = { playback.resume() }))
    }

    /** Signed in (with a password or in the browser): keeps the sign-in and connects. */
    fun signedIn(login: Login) {
        logins.save(login)
        settings.lastServer = login.server
        settings.lastUser = login.user
        connect(login)
    }

    /** Signs out: stops the music, gives a browser sign-in's key back to the server, forgets the sign-in. */
    fun signOut() {
        val s = (state.value as? AppState.Ready)?.session
        val login = s?.client?.login ?: (state.value as? AppState.Failed)?.login ?: logins.load()
        connecting?.cancel()
        closeLink()
        playback.attach(null)
        logins.clear()
        stateFlow.value = AppState.SignedOut()
        if (login != null && login.isApiKey) scope.launch { DeviceLogin.revoke(login) }
    }
}

/** The app's version, as installed. */
object BuildConfigInfo {
    fun versionName(context: Context): String = context.packageManager.getPackageInfo(context.packageName, 0).versionName.orEmpty()
}
