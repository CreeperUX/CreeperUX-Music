package com.creeperux.sonus.playback

import android.content.Context
import android.media.audiofx.LoudnessEnhancer
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.annotation.OptIn
import androidx.core.net.toUri
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.Timeline
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.HttpDataSource
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlaybackException
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.exoplayer.source.UnrecognizedInputFormatException
import com.creeperux.sonus.core.AudioQuality
import com.creeperux.sonus.core.LoudnessLevel
import com.creeperux.sonus.core.LoudnessMode
import com.creeperux.sonus.core.PlayContext
import com.creeperux.sonus.core.PlayQueue
import com.creeperux.sonus.core.PlaybackOrder
import com.creeperux.sonus.core.QualityBadgeInfo
import com.creeperux.sonus.core.QualityPolicy
import com.creeperux.sonus.core.QueueEntry
import com.creeperux.sonus.core.RemoteQueue
import com.creeperux.sonus.core.ReplayGainMode
import com.creeperux.sonus.core.Scrobbling
import com.creeperux.sonus.core.ServerUnreachableException
import com.creeperux.sonus.core.SongRenditions
import com.creeperux.sonus.core.StreamHeaderInfo
import com.creeperux.sonus.core.SubsonicException
import com.creeperux.sonus.core.Track
import com.creeperux.sonus.core.connect.PlaybackSession
import com.creeperux.sonus.core.connect.SessionModes
import com.creeperux.sonus.core.connect.SessionNow
import com.creeperux.sonus.core.connect.SessionQueue
import com.creeperux.sonus.core.connect.SessionResume
import com.creeperux.sonus.data.Settings
import com.creeperux.sonus.session.MusicSession
import com.creeperux.sonus.session.SessionLink
import com.creeperux.sonus.session.Toast
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.abs
import kotlin.math.log10
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.roundToInt

/**
 * This device's own player (the playing half of the Windows app's MusicService): the queue ([PlayQueue]) decides what
 * plays; Media3's ExoPlayer holds just the current song and the one after it, loaded early so one runs into the next
 * without a gap. When ExoPlayer moves on by itself, the queue moves with it. Scrobbles as the Windows app does: "now
 * playing" once a song really starts, the counted play past half the song or four minutes. Saves the queue on the
 * server (savePlayQueue) so another device, or this one next time, can continue. Lives on the main thread.
 *
 * With Sonus Connect version 2 ([link], on a server that offers it) the queue and what plays are the user's session on
 * the server: the actions below become its commands, the queue shows the session's, and the player plays only while
 * this device is the session's active device, following the session and reporting what really happens (the Windows
 * app's MusicService does the same). While another device plays, this one shows that device's song and position, and
 * the system's media controls (QueuePlayer) steer it.
 */
@OptIn(UnstableApi::class)
class LocalPlayback(
    private val context: Context,
    private val settings: Settings,
    private val http: OkHttpClient,
    private val scope: CoroutineScope,
) : Playback {
    private var session: MusicSession? = null
    private var queue = newQueue()
    private val stateFlow = MutableStateFlow(PlayerState(order = settings.order))
    private val positionFlow = MutableStateFlow(0.0)
    private val linkFlow = MutableStateFlow<SessionLink?>(null)
    private var counted = false
    private var nowPlayingSent = false
    private var startedAt = 0L
    private var savedAt = 0L
    private var ticker: Job? = null
    private var saveJob: Job? = null
    private var failures = 0 // songs in a row that could not play (without a session: skipped, up to five)
    private val noPreload = mutableSetOf<String>() // songs whose early load failed: loaded only when they come up
    private var positionHeldUntil = 0L // a seek sent for another device: the session's position is not shown until it says so
    private val mainHandler = Handler(Looper.getMainLooper())
    private val renditionsCache = ConcurrentHashMap<String, SongRenditions>()
    private val renditionsLoading = mutableSetOf<String>()
    private val streamHeaders = ConcurrentHashMap<String, StreamHeaderInfo>()
    private val requestedTiers = ConcurrentHashMap<String, String>()
    @Volatile private var meteredNetwork = false
    private var autoDowngradeSteps = 0
    private var smoothTracksSinceDowngrade = 0
    private var bufferingSinceMs = 0L
    private var downgradedThisStall = false
    private var loudnessEnhancer: LoudnessEnhancer? = null
    private var enhancerSessionId: Int = C.AUDIO_SESSION_ID_UNSET
    private var networkCallbackRegistered = false

    // Sonus Connect version 2: the session as last applied, and what the player has of it
    private var remote: PlaybackSession? = null
    private var engineKey: String? = null // the session entry the player has loaded
    private var advancedTo: String? = null // the song the player went on to by itself (gapless), until the session follows
    private var loadedSaid = false // `loaded` was reported for engineKey
    private var saidAt = 0L
    private var sayPositionAt = 0L

    override val state: StateFlow<PlayerState> = stateFlow.asStateFlow()
    override val position: StateFlow<Double> = positionFlow.asStateFlow()
    override val queueEntries: List<QueueEntry> get() = queue.entries
    override val nextTrackId: String? get() = queue.peekNext() ?: if (linkFlow.value != null) remote?.next else null
    override val previousTrackId: String? get() = queue.peekPrevious()
    override val canSkipNext: Boolean get() = queue.hasNext() || (linkFlow.value != null && remote?.next != null)
    override val canSkipPrevious: Boolean get() = queue.hasPrevious()

    /** Sonus Connect version 2, when the server offers it. */
    val link: StateFlow<SessionLink?> = linkFlow.asStateFlow()

    var replayGain: ReplayGainMode = settings.replayGain
        set(v) {
            field = v
            settings.replayGain = v
            applyVolume(current)
        }

    var wifiQuality: AudioQuality = settings.wifiQuality
        set(v) {
            if (field == v) return
            field = v
            settings.wifiQuality = v
            autoDowngradeSteps = 0
            smoothTracksSinceDowngrade = 0
            refreshPreload()
        }

    var cellularQuality: AudioQuality = settings.cellularQuality
        set(v) {
            if (field == v) return
            field = v
            settings.cellularQuality = v
            autoDowngradeSteps = 0
            smoothTracksSinceDowngrade = 0
            refreshPreload()
        }

    var loudnessLevel: LoudnessLevel = settings.loudnessLevel
        set(v) {
            if (field == v) return
            field = v
            settings.loudnessLevel = v
            if (v != LoudnessLevel.Off && replayGain != ReplayGainMode.Off) {
                replayGain = ReplayGainMode.Off
            }
            applyVolume(current)
        }

    var loudnessMode: LoudnessMode = settings.loudnessMode
        set(v) {
            if (field == v) return
            field = v
            settings.loudnessMode = v
            applyVolume(current)
        }

    var alwaysOriginal: Boolean = settings.alwaysOriginal
        set(v) {
            if (field == v) return
            field = v
            settings.alwaysOriginal = v
            autoDowngradeSteps = 0
            smoothTracksSinceDowngrade = 0
            refreshPreload()
        }

    private val activeNetworkQuality: AudioQuality get() = if (meteredNetwork) cellularQuality else wifiQuality

    /** OkHttp derivative for ExoPlayer that captures X-Sonus-* rendition headers from stream responses. */
    private val streamHttp: OkHttpClient by lazy {
        http.newBuilder()
            .addNetworkInterceptor { chain ->
                val res = chain.proceed(chain.request())
                val url = res.request.url
                if (url.encodedPath.endsWith("/stream.view")) {
                    val songId = url.queryParameter("id")
                    val q = res.header("X-Sonus-Quality")
                    val fmt = res.header("X-Sonus-Format")
                    if (!songId.isNullOrEmpty() && (!q.isNullOrEmpty() || !fmt.isNullOrEmpty())) {
                        streamHeaders[songId] = StreamHeaderInfo(
                            quality = q,
                            format = fmt,
                            sampleRate = res.header("X-Sonus-Sample-Rate")?.toIntOrNull(),
                            bitDepth = res.header("X-Sonus-Bit-Depth")?.toIntOrNull(),
                            bitRate = res.header("X-Sonus-Bit-Rate")?.toIntOrNull(),
                        )
                        mainHandler.post { if (current?.id == songId) updateBadge(current) }
                    }
                }
                res
            }
            .build()
    }

    val current: Track? get() = session?.lib?.track(queue.current)

    /** With a session, another device plays it (or none does): this one shows it and its player is silent. */
    val elsewhere: Boolean get() = linkFlow.value?.isActiveHere == false

    /** The session as another device plays it (for the system's media controls), or null. */
    val remoteSession: PlaybackSession? get() = remote?.takeIf { elsewhere && it.current != null && it.activeDevice != null }

    private fun newQueue() = PlayQueue({ session?.lib?.track(it) }).also { q ->
        q.order = settings.order
        q.onChanged = {
            stateFlow.update { it.copy(queueVersion = it.queueVersion + 1, order = q.order, context = q.playContext, stopAfterCurrent = q.stopAfterCurrent) }
            refreshPreload()
            scheduleSave()
        }
    }

    /** The player: made on first use, on the main thread, and kept for the life of the app. */
    val exo: ExoPlayer by lazy {
        ensureNetworkObserver()
        ExoPlayer.Builder(context)
            .setMediaSourceFactory(DefaultMediaSourceFactory(OkHttpDataSource.Factory(streamHttp)))
            .setAudioAttributes(AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(), true)
            .setHandleAudioBecomingNoisy(true)
            .setWakeMode(C.WAKE_MODE_NETWORK)
            .build()
            .also { it.addListener(listener) }
    }

    private fun ensureNetworkObserver() {
        if (networkCallbackRegistered) return
        networkCallbackRegistered = true
        meteredNetwork = detectMeteredNetwork()
        runCatching {
            val cm = context.getSystemService(ConnectivityManager::class.java) ?: return
            cm.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
                override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
                    val metered = caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) ||
                        !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
                    if (metered != meteredNetwork) {
                        meteredNetwork = metered
                        mainHandler.post {
                            autoDowngradeSteps = 0
                            smoothTracksSinceDowngrade = 0
                            Log.i(TAG, "network changed -> ${if (metered) "metered/cellular" else "wifi/unmetered"} (next track)")
                            refreshPreload()
                        }
                    }
                }
            })
        }
    }

    private fun detectMeteredNetwork(): Boolean = runCatching {
        val cm = context.getSystemService(ConnectivityManager::class.java) ?: return false
        val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return false
        caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) || !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
    }.getOrDefault(false)

    /** What the system's media controls (notification, lock screen, headphones, car) talk to: the player, with next and
     *  previous going through the queue, or another device's playback while that one plays the session. */
    val sessionPlayer: QueuePlayer by lazy { QueuePlayer(exo, this) }

    /** Signed in (a session) or out (null): what plays stops. */
    fun attach(s: MusicSession?) {
        if (session === s) return
        if (session != null) {
            saveNow()
            stop()
            exo.clearMediaItems()
        }
        session = s
        linkFlow.value = null
        remote = null
        engineKey = null
        advancedTo = null
        renditionsCache.clear()
        renditionsLoading.clear()
        streamHeaders.clear()
        requestedTiers.clear()
        autoDowngradeSteps = 0
        smoothTracksSinceDowngrade = 0
        queue = newQueue()
        stateFlow.value = PlayerState(order = queue.order)
        sessionPlayer.refresh()
    }

    /** Sonus Connect version 2 for this sign-in (null: none). */
    fun attachLink(l: SessionLink?) {
        linkFlow.value = l
        stateFlow.update { it.copy(queueVersion = it.queueVersion + 1) }
    }

    /** A command for the session (true: done that way). Without a connection the active device does what its player can
     *  do by itself ([playerOffline]: pause, play, seek; the reports tell the server later); anything else waits a moment
     *  for the connection. */
    private fun command(action: String, fields: JsonObject = JsonObject(emptyMap()), playerOffline: Boolean = false): Boolean {
        val l = linkFlow.value ?: return false
        if (!l.isConnected && playerOffline && l.isActiveHere) return false
        l.send(action, fields)
        return true
    }

    // ---------------------------------------------------------------- playing

    override fun play(context: PlayContext, ids: List<String>, startId: String?, shuffle: Boolean) {
        linkFlow.value?.let { l ->
            l.playContext(context, ids, startId, shuffle, if (shuffle && !PlayQueue.shuffled(queue.order)) PlaybackOrder.ShuffleTracks else queue.order)
            return
        }
        val start = queue.start(context, ids, startId, shuffle) ?: return
        settings.order = queue.order
        failures = 0
        load(start, autoplay = true)
    }

    override fun togglePlay() {
        val s = session ?: return
        if (current == null) {
            val (ctx, ids) = s.contextOf("playlist", if ((s.playlist("liked")?.entries?.size ?: 0) > 0) "liked" else "library")
            play(ctx, ids)
            return
        }
        if (state.value.isActive) pause() else resume()
    }

    override fun resume() {
        val l = linkFlow.value
        if (l != null) {
            // a song that failed here is tried again here
            if (l.isActiveHere && state.value.status == PlayerStatus.Error && queue.current != null) {
                load(queue.current!!, autoplay = true, at = position.value)
                return
            }
            if (command("play", playerOffline = true)) return
        }
        val id = queue.current ?: return
        val status = state.value.status
        if (status == PlayerStatus.Error || status == PlayerStatus.Stopped || currentPlayerId() != id) {
            load(id, autoplay = true, at = if (status == PlayerStatus.Stopped) 0.0 else position.value)
            return
        }
        // loading first: play() may report playing at once (from its own call), which must not be overwritten
        setStatus(PlayerStatus.Loading)
        if (exo.playbackState == Player.STATE_IDLE) exo.prepare()
        exo.play()
    }

    override fun pause() {
        if (command("pause", playerOffline = true)) return
        exo.pause()
        if (queue.current != null) setStatus(PlayerStatus.Paused)
        scheduleSave(soon = true)
    }

    override fun next() {
        if (command("next")) return
        failures = 0
        val id = queue.next()
        if (id != null) load(id, autoplay = true) else stop()
    }

    override fun previous() {
        if (command("previous")) return // the server goes back to the start more than 3 s in, as below
        if (position.value > 3) {
            seek(0.0)
            return
        }
        failures = 0
        val id = queue.previous()
        if (id != null) load(id, autoplay = true) else seek(0.0)
    }

    override fun previousTrack() {
        if (command("previous", buildJsonObject { put("force", true) })) return
        failures = 0
        val id = queue.previous()
        if (id != null) load(id, autoplay = true) else seek(0.0)
    }

    fun stop() {
        exo.stop()
        positionFlow.value = 0.0
        stateFlow.update { it.copy(status = PlayerStatus.Stopped, error = null, qualityBadge = null, qualityIsLossless = false) }
        ticker?.cancel()
    }

    override fun seek(seconds: Double) {
        val d = state.value.duration
        val at = seconds.coerceIn(0.0, if (d > 0) d else seconds.coerceAtLeast(0.0))
        if (command("seek", buildJsonObject { put("positionMs", (at * 1000).toLong()) }, playerOffline = true)) {
            positionFlow.value = at
            if (elsewhere) {
                positionHeldUntil = System.currentTimeMillis() + 2_000 // until the session says where it is now
            } else if (currentPlayerId() == queue.current) {
                // the active device seeks at once: the session's answer then matches, and is not applied again
                exo.seekTo((at * 1000).toLong())
            }
            return
        }
        positionFlow.value = at
        if (currentPlayerId() == queue.current) exo.seekTo((at * 1000).toLong())
        scheduleSave()
    }

    override fun setOrder(order: PlaybackOrder) {
        settings.order = order // this device's own setting stays
        linkFlow.value?.let {
            it.setMode(order)
            return
        }
        queue.changeOrder(order) // the queue keeps the context's own order (search results, a radio) to come back to
    }

    override fun setStopAfterCurrent(on: Boolean) {
        if (command("stopAfterCurrent", buildJsonObject { put("on", on) })) return
        queue.stopAfterCurrent = on
        stateFlow.update { it.copy(stopAfterCurrent = on) }
        refreshPreload()
    }

    override fun queueAdd(ids: List<String>, next: Boolean) {
        if (!command("add", buildJsonObject { put("ids", JsonArray(ids.map(::JsonPrimitive))); put("next", next) })) queue.add(ids, next)
    }

    override fun queueRemove(entryIds: List<String>) {
        if (!command("remove", buildJsonObject { put("entries", JsonArray(entryIds.map(::JsonPrimitive))) })) queue.remove(entryIds)
    }

    override fun queueClear(manual: Boolean) {
        if (!command("clear", buildJsonObject { put("manual", manual) })) queue.clear(manual)
    }

    override fun queueJump(entryId: String) {
        if (command("jump", buildJsonObject { put("entry", entryId) })) return
        failures = 0
        queue.jump(entryId)?.let { load(it, autoplay = true) }
    }

    /** Takes over a saved queue: its song at its position, paused. (Without Sonus Connect v2: with it, the session is
     *  kept on the server and continues where it stopped, rule 6.) */
    fun continueQueue(q: RemoteQueue, label: String) {
        if (linkFlow.value != null) return
        queue.adopt(PlayContext("queue", "continue", label), q.trackIds, q.current)?.let { load(it, autoplay = false, at = q.position) }
    }

    // ---------------------------------------------------------------- Sonus Connect version 2: the session

    /** The session changed: its queue is shown; this device's player follows it while this is the active device, and is
     *  stopped at once otherwise (rule 4). */
    fun applySession(s: PlaybackSession, q: SessionQueue, here: Boolean) {
        remote = s
        positionHeldUntil = 0
        val ctx = s.context?.let { PlayContext(it.kind, it.id, it.label) }
        queue.mirror(ctx, q.order, q.pointer, q.manual.map { it.key to it.trackId }, s.current?.trackId, SessionModes.parse(s.mode), s.stopAfterCurrent)
        if (here) followHere(s) else showElsewhere(s)
        stateFlow.update { it.copy(queueVersion = it.queueVersion + 1) }
        sessionPlayer.refresh()
    }

    private fun showElsewhere(s: PlaybackSession) {
        if (engineKey != null || exo.mediaItemCount > 0) {
            exo.stop() // the device playback left stops at once
            exo.clearMediaItems()
        }
        engineKey = null
        advancedTo = null
        val t = session?.lib?.track(s.current?.trackId)
        stateFlow.update {
            it.copy(
                trackId = s.current?.trackId, error = null,
                status = if (s.current == null) PlayerStatus.Stopped else if (s.playing) PlayerStatus.Playing else PlayerStatus.Paused,
                duration = if (s.durationMs > 0) s.durationMs / 1000.0 else t?.duration ?: 0.0,
                qualityBadge = null, qualityIsLossless = false,
            )
        }
        positionFlow.value = s.positionAt(linkFlow.value?.serverNow ?: System.currentTimeMillis()) / 1000.0
        if (s.playing) startTicker()
    }

    /** The active device's player made to match the session: the current entry loaded, the position (when more than 1.5 s
     *  off), playing or paused, the next song preloaded. */
    private fun followHere(s: PlaybackSession) {
        val cur = s.current
        if (cur == null) {
            if (engineKey != null) exo.stop()
            engineKey = null
            advancedTo = null
            positionFlow.value = 0.0
            stateFlow.update { it.copy(trackId = null, status = PlayerStatus.Stopped, error = null) }
            return
        }
        val want = s.positionAt(linkFlow.value?.serverNow ?: System.currentTimeMillis()) / 1000.0
        if (cur.key != engineKey) {
            if (advancedTo != null && advancedTo == cur.trackId && currentPlayerId() == cur.trackId) {
                // the player is there already (it went on by itself): only the entry is new
                engineKey = cur.key
                advancedTo = null
                loadedSaid = false
                if (state.value.status == PlayerStatus.Error) {
                    sayHere("failed") // it failed on arriving there: now the session can be told, for this entry
                    return
                }
                if (exo.isPlaying) sayHere("playing")
            } else {
                engineKey = cur.key
                advancedTo = null
                loadedSaid = false
                load(cur.trackId, autoplay = s.playing, at = want)
                if (state.value.status == PlayerStatus.Error) sayHere("failed") // not in this library
                return
            }
        } else if (advancedTo != null) {
            return // the session has not yet followed the player to the next song
        }
        if (state.value.status == PlayerStatus.Error) return // reported: the session moves on
        if (exo.playbackState == Player.STATE_ENDED || exo.playbackState == Player.STATE_IDLE) {
            // the song ended here: played again from the session's position when the session plays on (repeat one, play
            // after the end); near its end the session has not yet heard of it
            val d = state.value.duration
            if (s.playing && (d <= 0 || want < d - 2)) {
                load(cur.trackId, autoplay = true, at = want)
                return
            }
            if (!s.playing) {
                positionFlow.value = want
                setStatus(PlayerStatus.Paused)
            }
            return
        }
        if (exo.playbackState == Player.STATE_READY && abs(exo.currentPosition / 1000.0 - want) > 1.5) {
            exo.seekTo((want * 1000).toLong())
            positionFlow.value = want
            sayPositionAt = System.currentTimeMillis() + 500
        }
        if (s.playing && !exo.playWhenReady) {
            setStatus(PlayerStatus.Loading)
            exo.play()
            startTicker()
        } else if (!s.playing && exo.playWhenReady) {
            exo.pause()
            setStatus(PlayerStatus.Paused)
        }
        refreshPreload()
    }

    /** What the player really did, for the session (the active device only): `loaded` first for a new entry. */
    private fun sayHere(event: String) {
        val l = linkFlow.value ?: return
        val key = engineKey ?: return
        if (!l.isActiveHere) return
        val p = exo.currentPosition / 1000.0
        if (!loadedSaid && event != "failed") {
            loadedSaid = true
            val t = session?.lib?.track(currentPlayerId() ?: queue.current)
            // the library's length first, as the server takes it (the player's only when the library has none: right
            // after a gapless change the player can still have the song before's, and a transcoded stream's is a guess)
            val d = t?.duration?.takeIf { it > 0 } ?: exo.duration.takeIf { it != C.TIME_UNSET && it > 0 }?.let { it / 1000.0 }
            l.report(
                "loaded", key, p, d,
                t?.let { SessionNow(it.title, it.artist, it.album, it.albumId, session?.lib?.album(it.albumId)?.coverArt ?: it.coverArt) },
            )
        }
        l.report(event, key, p)
        saidAt = System.currentTimeMillis()
    }

    /**
     * On reconnecting while active: still playing (a short network loss) or not. Asked on the connection's thread, but
     * the player may only be read on the main thread (Media3 throws otherwise, and the hello never went out: a phone that
     * lost its connection while playing, as when its screen is off, never got back): read there, waited for a moment.
     * Null when the main thread does not answer in time; the hello then says nothing of it.
     */
    fun resumeState(rev: Long): SessionResume? {
        if (Looper.myLooper() == Looper.getMainLooper()) return resumeHere(rev)
        val answer = AtomicReference<SessionResume?>()
        val read = CountDownLatch(1)
        val posted = Handler(Looper.getMainLooper()).post {
            try {
                answer.set(runCatching { resumeHere(rev) }.getOrNull())
            } finally {
                read.countDown()
            }
        }
        return if (posted && read.await(RESUME_WAIT_MS, TimeUnit.MILLISECONDS)) answer.get() else null
    }

    /** [resumeState], on the main thread. */
    private fun resumeHere(rev: Long): SessionResume? {
        if (currentPlayerId() == null) return null
        return SessionResume(rev, exo.playWhenReady, exo.currentPosition)
    }

    // ---------------------------------------------------------------- the player

    private fun currentPlayerId(): String? = if (exo.mediaItemCount > 0) exo.currentMediaItem?.mediaId else null

    private fun itemFor(t: Track): MediaItem {
        val s = session!!
        meteredNetwork = detectMeteredNetwork()
        val tier = QualityPolicy.resolveTier(
            setting = activeNetworkQuality,
            metered = meteredNetwork,
            alwaysOriginal = alwaysOriginal,
            autoDowngradeSteps = autoDowngradeSteps,
            serverHasRenditions = s.client.supportsRenditions,
        )
        if (tier != null) requestedTiers[t.id] = tier else requestedTiers.remove(t.id)
        val streamUrl = if (tier != null) {
            s.client.streamUrl(t.id, sonusQuality = tier)
        } else {
            // ExoPlayer plays FLAC, ALAC, AAC, MP3, WAV, Opus and Vorbis; the rest is asked for as MP3, which every server
            // can transcode to (the same list as the Windows app)
            val transcode = if (t.suffix in TRANSCODED) "mp3" else null
            s.client.streamUrl(t.id, transcode)
        }
        return MediaItem.Builder()
            .setMediaId(t.id)
            .setUri(streamUrl)
            .setMediaMetadata(metadataFor(t))
            .build()
    }

    private fun ensureRenditions(vararg ids: String?) {
        val s = session ?: return
        if (!s.client.supportsRenditions) return
        val need = ids.filterNotNull().filter { it.isNotEmpty() && !renditionsCache.containsKey(it) && renditionsLoading.add(it) }.distinct()
        if (need.isEmpty()) return
        scope.launch {
            try {
                val found = s.client.getSonusRenditions(need)
                mainHandler.post {
                    need.forEach { renditionsLoading.remove(it) }
                    if (found.isNotEmpty()) {
                        renditionsCache.putAll(found)
                        current?.let { cur ->
                            if (cur.id in found) {
                                applyVolume(cur)
                                updateBadge(cur)
                            }
                        }
                    }
                }
            } catch (e: Exception) {
                mainHandler.post { need.forEach { renditionsLoading.remove(it) } }
                Log.i(TAG, "getSonusRenditions: ${e.message}")
            }
        }
    }

    private fun badgeFor(t: Track?): QualityBadgeInfo = if (t == null || elsewhere) {
        QualityBadgeInfo.Empty
    } else {
        QualityPolicy.formatBadge(
            stream = streamHeaders[t.id],
            renditions = renditionsCache[t.id],
            track = t,
            requestedTier = requestedTiers[t.id],
        )
    }

    private fun updateBadge(t: Track?) {
        val b = badgeFor(t)
        stateFlow.update { it.copy(qualityBadge = b.text.ifEmpty { null }, qualityIsLossless = b.isLossless) }
    }

    /** What the system's media controls show of a song. */
    fun metadataFor(t: Track): MediaMetadata = MediaMetadata.Builder()
        .setTitle(t.title).setArtist(t.artist).setAlbumTitle(t.album).setAlbumArtist(t.albumArtist)
        .setArtworkUri(session?.trackCoverUrl(t, 512)?.toUri()).setDurationMs((t.duration * 1000).toLong())
        .setIsPlayable(true).setIsBrowsable(false).setMediaType(MediaMetadata.MEDIA_TYPE_MUSIC)
        .build()

    /** What the system's media controls show of the session's song when another device plays it (it may not be in this
     *  library: the session says what it is). */
    fun metadataFor(s: PlaybackSession): MediaMetadata {
        session?.lib?.track(s.current?.trackId)?.let { return metadataFor(it) }
        val now = s.now
        return MediaMetadata.Builder()
            .setTitle(now?.title).setArtist(now?.artist).setAlbumTitle(now?.album)
            .setArtworkUri(now?.coverArt?.let { session?.client?.coverUrl(it, 512)?.toUri() })
            .setIsPlayable(true).setIsBrowsable(false).setMediaType(MediaMetadata.MEDIA_TYPE_MUSIC)
            .build()
    }

    /** What to load after [currentId]: what the queue (or the session) says follows. */
    private fun nextItem(currentId: String?): MediaItem? {
        val next = if (linkFlow.value != null) remote?.next else queue.peek()
        return next?.takeIf { it != currentId && it !in noPreload }?.let { session?.lib?.track(it) }?.let(::itemFor)
    }

    private fun load(trackId: String, autoplay: Boolean, at: Double = 0.0) {
        val t = session?.lib?.track(trackId)
        if (t == null) {
            setStatus(PlayerStatus.Error, "这首歌已不在媒体库中。")
            return
        }
        counted = false
        nowPlayingSent = false
        bufferingSinceMs = 0L
        downgradedThisStall = false
        startedAt = System.currentTimeMillis()
        positionFlow.value = at
        noPreload -= trackId // tried again now that it comes up
        streamHeaders.remove(trackId)
        // the start position is given here only, once (the session's position is not applied again unless the player
        // is more than 1.5 s off it: see followHere)
        val next = nextItem(trackId)
        val items = listOfNotNull(itemFor(t), next)
        ensureRenditions(trackId, next?.mediaId)
        applyVolume(t)
        val badge = badgeFor(t)
        // the state first: the player reports what it does (playing …) from within the calls below
        stateFlow.update {
            it.copy(
                trackId = trackId, duration = t.duration, error = null,
                status = if (autoplay) PlayerStatus.Loading else PlayerStatus.Paused,
                qualityBadge = badge.text.ifEmpty { null }, qualityIsLossless = badge.isLossless,
            )
        }
        exo.setMediaItems(items, 0, (at * 1000).toLong())
        exo.prepare()
        exo.playWhenReady = autoplay
        if (autoplay) startTicker()
    }

    /** The song after the current one changed (queued by hand, the order …): load that one early instead. */
    private fun refreshPreload() {
        if (exo.mediaItemCount == 0) return
        val i = exo.currentMediaItemIndex
        if (exo.getMediaItemAt(i).mediaId != queue.current) return
        val wanted = nextItem(queue.current)
        val have = if (i + 1 < exo.mediaItemCount) exo.getMediaItemAt(i + 1) else null
        if (have?.mediaId == wanted?.mediaId && have?.localConfiguration?.uri == wanted?.localConfiguration?.uri) return
        if (i + 1 < exo.mediaItemCount) exo.removeMediaItems(i + 1, exo.mediaItemCount)
        wanted?.let {
            ensureRenditions(it.mediaId)
            exo.addMediaItem(it)
        }
    }

    private val listener = object : Player.Listener {
        override fun onMediaItemTransition(item: MediaItem?, reason: Int) {
            if (item == null || reason != Player.MEDIA_ITEM_TRANSITION_REASON_AUTO) return
            val id = item.mediaId
            val l = linkFlow.value
            if (l != null) {
                // the player went on by itself to the preloaded song (gapless): the session moves there on the report
                if (!l.isActiveHere) return
                engineKey?.let { l.report("ended", it, state.value.duration) }
                advancedTo = id
                if (!l.isConnected && queue.peek() == id) queue.next(ended = true) // shown at once while the server can't be told
            } else if (queue.peek() == id) {
                // the player moved on by itself: move the queue there too, then load what comes after
                queue.next(ended = true)
            } else if (queue.current != id) {
                load(queue.next(ended = true) ?: id, autoplay = true)
                return
            }
            val i = exo.currentMediaItemIndex
            if (i > 0) exo.removeMediaItems(0, i)
            refreshPreload()
            counted = false
            nowPlayingSent = false
            if (autoDowngradeSteps > 0 && !downgradedThisStall && ++smoothTracksSinceDowngrade >= 2) {
                autoDowngradeSteps--
                smoothTracksSinceDowngrade = 0
                Log.i(TAG, "recovered one quality step -> downgrade=$autoDowngradeSteps")
            }
            bufferingSinceMs = 0L
            downgradedThisStall = false
            startedAt = System.currentTimeMillis()
            val t = session?.lib?.track(id)
            ensureRenditions(id, nextTrackId)
            applyVolume(t)
            val badge = badgeFor(t)
            stateFlow.update {
                it.copy(
                    trackId = id, duration = t?.duration ?: 0.0, error = null,
                    qualityBadge = badge.text.ifEmpty { null }, qualityIsLossless = badge.isLossless,
                )
            }
            positionFlow.value = 0.0
            if (exo.isPlaying) nowPlaying()
        }

        override fun onAudioSessionIdChanged(audioSessionId: Int) {
            applyVolume(current)
        }

        override fun onIsPlayingChanged(isPlaying: Boolean) {
            if (elsewhere) return
            if (isPlaying) {
                failures = 0
                setStatus(PlayerStatus.Playing)
                if (!nowPlayingSent) nowPlaying()
                startTicker()
                sayHere("playing")
            } else {
                positionFlow.value = exo.currentPosition / 1000.0
                if (exo.playbackState == Player.STATE_BUFFERING && exo.playWhenReady) {
                    setStatus(PlayerStatus.Loading)
                } else if (!exo.playWhenReady && queue.current != null && state.value.status != PlayerStatus.Stopped && state.value.status != PlayerStatus.Error) {
                    setStatus(PlayerStatus.Paused) // paused here, by a headset, a call or another app taking the sound
                    scheduleSave(soon = true)
                    sayHere("paused")
                }
            }
        }

        override fun onPlaybackStateChanged(playbackState: Int) {
            when (playbackState) {
                Player.STATE_ENDED -> {
                    val l = linkFlow.value
                    if (l != null) {
                        // the session says what follows
                        if (l.isActiveHere) engineKey?.let { l.report("ended", it, state.value.duration) }
                        return
                    }
                    // the last loaded song ended: what follows was not known in advance (repeat one, random, the end)
                    val id = queue.next(ended = true)
                    if (id != null) load(id, autoplay = true) else stop()
                }
                Player.STATE_READY -> {
                    // the library's length stands (the bar, `loaded`); the player's only when the library has none
                    val d = exo.duration
                    val known = session?.lib?.track(currentPlayerId())?.duration ?: 0.0
                    if (known <= 0 && d != C.TIME_UNSET && d > 0) stateFlow.update { it.copy(duration = d / 1000.0) }
                }
                else -> Unit
            }
        }

        override fun onPlayerError(error: PlaybackException) {
            val failed = failedSong(error)
            val playing = currentPlayerId()
            if (failed != null && playing != null && failed != playing) {
                // the song loaded early to follow the current one failed (ExoPlayer opens it near the current one's end,
                // and stops on it): not the current song's failure. That one plays on; the other is tried again, not
                // early, when it comes up, and fails there as itself.
                Log.w(TAG, "the preloaded $failed failed (${error.errorCodeName}); $playing plays on", error)
                noPreload += failed
                for (i in exo.mediaItemCount - 1 downTo 0) {
                    if (i != exo.currentMediaItemIndex && exo.getMediaItemAt(i).mediaId == failed) exo.removeMediaItem(i)
                }
                exo.prepare() // from where it stopped, playing as it was
                return
            }
            val t = session?.lib?.track(failed) ?: current
            val name = t?.let { "“${it.title}”" } ?: "这首歌"
            val reason = when (error.errorCode) {
                PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED, PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT -> "连不上服务器"
                PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS, PlaybackException.ERROR_CODE_IO_FILE_NOT_FOUND -> "服务器上找不到这个文件"
                PlaybackException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED, PlaybackException.ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED -> "这台设备不支持这个格式"
                else -> error.errorCodeName
            }
            val message = "无法播放$name：$reason"
            Log.w(TAG, "$failed failed: $message", error)
            setStatus(PlayerStatus.Error, message)
            if (linkFlow.value != null) {
                // the session skips it and says so to every device (error `unplayable`, naming it). A song the player went
                // on to by itself is reported once the session is there too (followHere): before, the entry would be the
                // song before's, and the server would drop the report as stale.
                if (advancedTo == null) sayHere("failed")
                return
            }
            // a song that cannot be played here is skipped with a toast naming it, as the Windows app does; after five
            // in a row, or at the end, it stops on the error. A lost connection is not skipped (every song would fail).
            val network = error.errorCode == PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED ||
                error.errorCode == PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT
            if (!network) {
                if (++failures >= 5) {
                    session?.say(Toast("无法播放$name；连续 $failures 首都无法播放，已停止播放。", isError = true))
                    return
                }
                val next = queue.next()
                if (next != null) {
                    session?.say(Toast("无法播放$name，已跳到下一首。"))
                    load(next, autoplay = true)
                    return
                }
            }
            session?.say(Toast(message, isError = true))
        }
    }

    /** Which song a failure is from: the one whose stream (its address) could not be opened or read, or the one being
     *  decoded; the current one when the failure does not say. ExoPlayer itself names the current song for any stream's
     *  failure, also the early-loaded next one's. */
    private fun failedSong(error: PlaybackException): String? {
        var cause: Throwable? = error.cause
        var uri: android.net.Uri? = null
        while (cause != null && uri == null) {
            uri = when (cause) {
                is HttpDataSource.HttpDataSourceException -> cause.dataSpec.uri
                is UnrecognizedInputFormatException -> cause.uri
                else -> null
            }
            cause = cause.cause
        }
        if (uri != null) {
            for (i in 0 until exo.mediaItemCount) {
                val item = exo.getMediaItemAt(i)
                if (item.localConfiguration?.uri == uri) return item.mediaId
            }
            uri.getQueryParameter("id")?.let { return it }
        }
        // a song that could not be decoded: the one the renderers were reading (the next song's start can be, already)
        val period = (error as? ExoPlaybackException)?.takeIf { it.type == ExoPlaybackException.TYPE_RENDERER }?.mediaPeriodId
        if (period != null) {
            val timeline = exo.currentTimeline
            val index = timeline.getIndexOfPeriod(period.periodUid)
            if (index != C.INDEX_UNSET) {
                val window = timeline.getPeriod(index, Timeline.Period()).windowIndex
                if (window < exo.mediaItemCount) return exo.getMediaItemAt(window).mediaId
            }
        }
        return currentPlayerId()
    }

    private fun setStatus(s: PlayerStatus, error: String? = null) {
        stateFlow.update { it.copy(status = s, error = if (s == PlayerStatus.Error) error else null) }
    }

    /** Four times a second while playing: the position, the counted play, the queue saved (or the session told) every
     *  30 s; while another device plays, the session's position moving on. */
    private fun startTicker() {
        if (ticker?.isActive == true) return
        ticker = scope.launch {
            while (isActive) {
                delay(250)
                val l = linkFlow.value
                if (l != null && !l.isActiveHere) {
                    val s = remote ?: break
                    if (!s.playing) break
                    if (System.currentTimeMillis() >= positionHeldUntil) positionFlow.value = s.positionAt(l.serverNow) / 1000.0
                    continue
                }
                if (l != null && sayPositionAt > 0 && System.currentTimeMillis() >= sayPositionAt) {
                    sayPositionAt = 0
                    sayHere("position") // a seek done
                }
                if (!exo.isPlaying) {
                    if (exo.playbackState == Player.STATE_BUFFERING && exo.playWhenReady) {
                        val now = System.currentTimeMillis()
                        if (bufferingSinceMs == 0L) bufferingSinceMs = now
                        else if (!downgradedThisStall && now - bufferingSinceMs >= 4_500 &&
                            session?.client?.supportsRenditions == true && !alwaysOriginal &&
                            activeNetworkQuality == AudioQuality.Auto && autoDowngradeSteps < 3
                        ) {
                            downgradedThisStall = true
                            autoDowngradeSteps++
                            smoothTracksSinceDowngrade = 0
                            Log.i(TAG, "slow buffering (>4.5s), auto-downgrade step -> $autoDowngradeSteps (next track)")
                            refreshPreload()
                        }
                    } else {
                        bufferingSinceMs = 0L
                        downgradedThisStall = false
                    }
                    if (state.value.status != PlayerStatus.Loading) break
                    continue
                }
                bufferingSinceMs = 0L
                downgradedThisStall = false
                val p = exo.currentPosition / 1000.0
                positionFlow.value = p
                val t = session?.lib?.track(currentPlayerId())
                if (!counted && t != null && Scrobbling.counts(p, state.value.duration)) {
                    counted = true // a play counts past half the song or four minutes
                    countPlay(t, startedAt)
                }
                if (l != null) {
                    if (System.currentTimeMillis() - saidAt > 30_000) sayHere("position") // at least every 30 s
                } else if (System.currentTimeMillis() - savedAt > 30_000) {
                    scheduleSave(soon = true) // the position, for another device
                }
            }
        }
    }

    private fun nowPlaying() {
        nowPlayingSent = true
        val t = session?.lib?.track(currentPlayerId()) ?: current ?: return
        quietly { session?.client?.scrobble(t.id, submission = false) }
        scheduleSave(soon = true)
    }

    private fun countPlay(t: Track, started: Long) {
        val s = session ?: return
        quietly {
            s.client.scrobble(t.id, submission = true, startedAt = started)
            t.playCount++
            t.lastPlayed = System.currentTimeMillis()
            s.bump()
        }
    }

    /** Applies EBU R128 loudness normalization (using exo.volume for attenuation and LoudnessEnhancer for peak-safe
     *  boost) or legacy ReplayGain when loudness normalization is off. */
    private fun applyVolume(t: Track?) {
        if (loudnessLevel != LoudnessLevel.Off) {
            val loudness = t?.let { renditionsCache[it.id]?.loudness }
            val linear = QualityPolicy.computeLoudnessGain(
                level = loudnessLevel,
                mode = loudnessMode,
                loudness = loudness,
                rgAlbum = t?.albumGain,
                rgTrack = t?.trackGain,
                allowBoost = true,
            )
            if (linear <= 1.0) {
                exo.volume = linear.toFloat().coerceIn(0f, 1f)
                setEnhancerBoostMb(0)
            } else {
                exo.volume = 1.0f
                val boostMb = (20.0 * log10(linear) * 100.0).roundToInt().coerceIn(0, 1200)
                setEnhancerBoostMb(boostMb)
            }
            return
        }
        setEnhancerBoostMb(0)
        val gain = if (t == null || replayGain == ReplayGainMode.Off) null
        else if (replayGain == ReplayGainMode.Album) t.albumGain ?: t.trackGain else t.trackGain ?: t.albumGain
        exo.volume = (gain?.let { min(1.0, 10.0.pow(it / 20)) } ?: 1.0).toFloat()
    }

    private fun setEnhancerBoostMb(gainMb: Int) {
        if (gainMb <= 0) {
            runCatching { loudnessEnhancer?.enabled = false }
            return
        }
        val sid = exo.audioSessionId
        if (sid == C.AUDIO_SESSION_ID_UNSET || sid <= 0) return
        runCatching {
            if (loudnessEnhancer == null || enhancerSessionId != sid) {
                runCatching { loudnessEnhancer?.release() }
                loudnessEnhancer = LoudnessEnhancer(sid)
                enhancerSessionId = sid
            }
            loudnessEnhancer?.setTargetGain(gainMb)
            loudnessEnhancer?.enabled = true
        }.onFailure { Log.i(TAG, "LoudnessEnhancer unavailable: ${it.message}") }
    }

    // ---------------------------------------------------------------- continue on another device (without Connect v2)

    private fun scheduleSave(soon: Boolean = false) {
        // with a session the server keeps it (rule 6)
        if (queue.current == null || session == null || linkFlow.value != null) return
        saveJob?.cancel()
        saveJob = scope.launch {
            delay(if (soon) 1 else 1500)
            saveNow()
        }
    }

    private fun saveNow() {
        if (linkFlow.value != null) return
        val s = session ?: return
        val c = queue.current ?: return
        savedAt = System.currentTimeMillis()
        val ids = queue.forServer()
        val at = if (currentPlayerId() == c) exo.currentPosition / 1000.0 else position.value
        quietly { s.client.savePlayQueue(ids, c, at) }
    }

    /** Runs a request whose failure only needs logging (now playing, saving the queue). */
    private fun quietly(request: suspend () -> Unit) {
        scope.launch {
            try {
                request()
            } catch (e: ServerUnreachableException) {
                Log.i(TAG, "background request: ${e.message}")
            } catch (e: SubsonicException) {
                Log.i(TAG, "background request: ${e.message}")
            } catch (e: SerializationException) {
                Log.i(TAG, "background request: ${e.message}")
            }
        }
    }

    private companion object {
        const val TAG = "Sonus"
        const val RESUME_WAIT_MS = 1_000L // how long a reconnect's hello waits for the main thread to read the player
        val TRANSCODED = setOf("dsf", "dff", "ape", "wv", "tta", "tak", "mpc", "wma")
    }
}
