package com.creeperux.sonus.session

import android.content.Context
import android.database.ContentObserver
import android.media.AudioManager
import android.os.Handler
import android.os.Looper
import android.provider.Settings as SystemSettings
import android.util.Log
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import com.creeperux.sonus.core.PlayContext
import com.creeperux.sonus.core.PlayQueue
import com.creeperux.sonus.core.PlaybackOrder
import com.creeperux.sonus.core.connect.PlaybackSession
import com.creeperux.sonus.core.connect.SessionClient
import com.creeperux.sonus.core.connect.SessionDevice
import com.creeperux.sonus.core.connect.SessionModes
import com.creeperux.sonus.core.connect.SessionNow
import com.creeperux.sonus.core.connect.SessionQueue
import com.creeperux.sonus.core.connect.SessionResume
import com.creeperux.sonus.playback.LocalPlayback
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import kotlin.math.roundToInt

/**
 * Sonus Connect version 2 in the app (docs/protocol/connect.md), on a server that offers it, as the Windows app's
 * SessionService: the user has one playback session, kept on the server. Every device shows it; what the user does here
 * (play something, queue, skip, seek, change the order) is sent as a command, and the session's active device plays it.
 * This device's player plays only while it is the active device ([LocalPlayback] follows the session then, and reports
 * what really happens); the device list moves playback (a transfer).
 *
 * On Android (the user's choices): this device's volume is the system's media volume; in the background the connection
 * is kept while the session plays somewhere (this device plays it, or the notification and lock screen control another
 * device that does), and closed a minute after the session stops playing. Main thread only.
 */
class SessionLink(
    private val context: Context,
    private val music: MusicSession,
    private val playback: LocalPlayback,
    deviceId: String,
    name: String,
    kind: String,
    clientLabel: String,
    private val scope: CoroutineScope,
) {
    val client = SessionClient(music.client, deviceId, name, kind, canPlay = true, clientLabel = clientLabel)
    private val audio = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private val changed = MutableStateFlow(0)
    private val pending = mutableListOf<Pending>()
    private var appliedRev = -1L
    private var appliedQueueRev = -1L
    private var sentVolume = -1.0
    private var sentMuted = false
    private var foreground = true
    private var sleeping: Job? = null
    private val jobs = mutableListOf<Job>()
    private var closed = false

    private data class Pending(val event: String, val key: String, val positionMs: Long, val durationMs: Long?, val now: SessionNow?)

    /** Goes up when the session, its queue, the devices or the connection changed. */
    val revision: StateFlow<Int> = changed.asStateFlow()

    val id: String get() = client.deviceId
    val isConnected: Boolean get() = client.connected.value
    val session: PlaybackSession get() = client.session.value
    val queue: SessionQueue get() = client.queue.value
    val devices: List<SessionDevice> get() = client.devices.value
    val serverNow: Long get() = client.serverNow

    /** This device plays the session. */
    val isActiveHere: Boolean get() = client.isActive

    /** How this device calls itself in the device list. */
    val hereName: String = if (kind == "tablet") "这台平板" else "这台手机"

    fun nameOf(id: String): String =
        if (id == this.id) hereName else devices.firstOrNull { it.id == id }?.name ?: session.lastDevice?.takeIf { it.id == id }?.name ?: "另一台设备"

    /** Where the session plays, as the player says it: "正在「书房电脑」上播放" while another device plays it, "上次在「书房电脑」播放"
     *  when none does; null while this device plays it, or when there is nothing to play. */
    val where: String?
        get() {
            val s = session
            if (s.current == null) return null
            val active = s.activeDevice
            if (active != null) return if (active == id) null else "正在「${nameOf(active)}」上播放"
            return s.lastDevice?.let { "上次在「${nameOf(it.id)}」播放" }
        }

    private val volumeObserver = object : ContentObserver(Handler(Looper.getMainLooper())) {
        override fun onChange(selfChange: Boolean) = sayVolume()
    }

    private val lifecycle = object : DefaultLifecycleObserver {
        override fun onStart(owner: LifecycleOwner) {
            foreground = true
            keepOrSleep()
        }

        override fun onStop(owner: LifecycleOwner) {
            foreground = false
            keepOrSleep()
        }
    }

    fun start() {
        client.resume = ::resumeState
        jobs += scope.launch { client.connected.collect { onConnection(it) } }
        jobs += scope.launch { client.session.collect { apply(); keepOrSleep() } }
        jobs += scope.launch { client.queue.collect { apply() } }
        jobs += scope.launch {
            client.devices.collect {
                changed.value++
                playback.sessionPlayer.refresh() // the playing device's volume, for the system's volume panel
            }
        }
        jobs += scope.launch { client.errors.collect { (code, message) -> onError(code, message) } }
        jobs += scope.launch {
            client.volumeAsked.collect { a ->
                a.muted?.let { setMutedHere(it) }
                a.volume?.let { setVolumeHere(it) }
            }
        }
        jobs += scope.launch { music.online.collect { if (it && !isConnected && client.isStarted) client.reconnectNow() } }
        context.contentResolver.registerContentObserver(SystemSettings.System.CONTENT_URI, true, volumeObserver)
        ProcessLifecycleOwner.get().lifecycle.addObserver(lifecycle)
        client.start()
    }

    suspend fun close() {
        if (closed) return
        closed = true
        ProcessLifecycleOwner.get().lifecycle.removeObserver(lifecycle)
        context.contentResolver.unregisterContentObserver(volumeObserver)
        jobs.forEach { it.cancel() }
        sleeping?.cancel()
        client.close()
    }

    // ---------------------------------------------------------------- staying connected in the background

    /** Connected in the foreground; in the background while the session plays somewhere, else for a minute more. */
    private fun keepOrSleep() {
        if (closed) return
        val s = session
        val needed = foreground || (s.playing && s.activeDevice != null)
        if (needed) {
            sleeping?.cancel()
            sleeping = null
            if (!client.isStarted) {
                Log.i(TAG, "connect again")
                client.start()
            }
        } else if (sleeping == null && client.isStarted) {
            sleeping = scope.launch {
                delay(60_000)
                Log.i(TAG, "in the background with nothing playing: disconnect")
                client.stop()
                sleeping = null
                changed.value++
            }
        }
    }

    // ---------------------------------------------------------------- the session, shown and followed

    private fun apply() {
        if (closed) return
        val s = session
        val q = queue
        if (q.queueRev < s.queueRev) return // the queue message comes first: wait for it when the session names a newer one
        if (s.rev == appliedRev && q.queueRev == appliedQueueRev) return
        appliedRev = s.rev
        appliedQueueRev = q.queueRev
        playback.applySession(s, q, isActiveHere)
        changed.value++
    }

    private fun onConnection(on: Boolean) {
        if (closed) return
        if (on) {
            appliedRev = -1 // the welcome's session is applied whatever its rev
            apply()
            // what happened while the connection was down, in order (the server ignores what no longer applies)
            if (isActiveHere) for (r in pending) scope.launch { client.report(r.event, r.key, r.positionMs, session.rev, r.durationMs, r.now) }
            pending.clear()
            sentVolume = -1.0
            sayVolume()
        }
        Log.i(TAG, if (on) "connected as $id" else "connection lost")
        changed.value++
    }

    /** On reconnecting: this device was the active one and still plays (a short network loss). */
    private fun resumeState(): SessionResume? = if (client.isActive) playback.resumeState(session.rev) else null

    private fun onError(code: String, message: String) {
        Log.i(TAG, "error $code: $message")
        // stale and notActive: the session moved on meanwhile, and what it is now is on its way
        if (code == "stale" || code == "notActive" || code == "timeout") return
        music.say(Toast(message, isError = code != "unplayable"))
    }

    // ---------------------------------------------------------------- what this device does: commands

    /** A command for the session; a refusal comes back as a toast. While the connection is down it is tried again at once
     *  and the command waits a few seconds for it. */
    fun send(action: String, fields: JsonObject = JsonObject(emptyMap())) {
        scope.launch {
            if (!isConnected) {
                if (!client.isStarted) client.start()
                client.reconnectNow()
                for (i in 0 until 60) {
                    if (isConnected || closed) break
                    delay(50)
                }
                if (!isConnected) {
                    music.say(Toast("正在重新连接服务器，稍后再试。", isError = true))
                    return@launch
                }
            }
            client.command(action, fields)
        }
    }

    /** Plays a context (rule 3): the server arranges it, unless shuffling by album or folder, which this device does (the
     *  server may not know albums and folders). */
    fun playContext(context: PlayContext, ids: List<String>, startId: String?, shuffle: Boolean, order: PlaybackOrder) {
        val known = SessionModes.window(ids.filter { music.lib.track(it) != null }, startId)
        if (known.isEmpty()) return
        var start = startId
        var arranged: List<String>? = null
        if (order == PlaybackOrder.ShuffleAlbums || order == PlaybackOrder.ShuffleFolders) {
            val q = PlayQueue({ music.lib.track(it) }).also { it.order = order }
            start = q.start(context, known, startId, shuffle) ?: startId
            arranged = q.contextIds
        }
        send(
            "playContext",
            buildJsonObject {
                putJsonObject("context") { put("kind", context.kind); put("id", context.id); put("label", context.label) }
                put("ids", JsonArray(known.map(::JsonPrimitive)))
                start?.let { put("startId", it) }
                if (shuffle) put("shuffle", true)
                arranged?.let { put("order", JsonArray(it.map(::JsonPrimitive))) }
            },
        )
    }

    fun setMode(order: PlaybackOrder) {
        var arranged: List<String>? = null
        if ((order == PlaybackOrder.ShuffleAlbums || order == PlaybackOrder.ShuffleFolders) && queue.order.isNotEmpty()) {
            val q = PlayQueue({ music.lib.track(it) })
            val s = session
            q.mirror(null, queue.order, queue.pointer, queue.manual.map { it.key to it.trackId }, s.current?.trackId, SessionModes.parse(s.mode), s.stopAfterCurrent)
            q.changeOrder(order)
            arranged = q.contextIds
        }
        send("mode", buildJsonObject { put("mode", SessionModes.of(order)); arranged?.let { put("order", JsonArray(it.map(::JsonPrimitive))) } })
    }

    /** Moves playback to that device (rule 4); the one it leaves stops. Playing as before unless said. */
    fun transfer(deviceId: String, play: Boolean? = null) =
        send("transfer", buildJsonObject { put("to", deviceId); play?.let { put("play", it) } })

    /** Any device's volume (rule 8): this one's here (the system's media volume), another's through the server. */
    fun setVolume(deviceId: String, volume: Double?, muted: Boolean? = null) {
        if (deviceId == id) {
            muted?.let(::setMutedHere)
            volume?.let(::setVolumeHere)
            return
        }
        send("volume", buildJsonObject { put("device", deviceId); volume?.let { put("volume", it) }; muted?.let { put("muted", it) } })
    }

    // ---------------------------------------------------------------- what this device's player does: reports

    /** A report about the entry [key] (the active device only); kept for later while offline. */
    fun report(event: String, key: String, positionSeconds: Double, durationSeconds: Double? = null, now: SessionNow? = null) {
        if (closed || !isActiveHere) return
        val ms = (maxOf(0.0, positionSeconds) * 1000).toLong()
        val durationMs = durationSeconds?.takeIf { it > 0 }?.let { (it * 1000).toLong() }
        if (!isConnected) {
            // the last of playing / paused / position is enough; endings are all kept
            if (event == "playing" || event == "paused" || event == "position") pending.removeAll { it.event == "playing" || it.event == "paused" || it.event == "position" }
            if (pending.size < 50) pending += Pending(event, key, ms, durationMs, now)
            return
        }
        scope.launch { client.report(event, key, ms, session.rev, durationMs, now) }
    }

    // ---------------------------------------------------------------- this device's volume: the system's media volume

    val volumeHere: Double
        get() = audio.getStreamVolume(AudioManager.STREAM_MUSIC).toDouble() / maxOf(1, audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC))

    val mutedHere: Boolean get() = audio.isStreamMute(AudioManager.STREAM_MUSIC)

    private fun setVolumeHere(v: Double) {
        val max = audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
        audio.setStreamVolume(AudioManager.STREAM_MUSIC, (v.coerceIn(0.0, 1.0) * max).roundToInt(), 0)
        if (v > 0 && mutedHere) setMutedHere(false)
        sayVolume()
    }

    private fun setMutedHere(m: Boolean) {
        audio.adjustStreamVolume(AudioManager.STREAM_MUSIC, if (m) AudioManager.ADJUST_MUTE else AudioManager.ADJUST_UNMUTE, 0)
        sayVolume()
    }

    /** This device's volume, for the others' lists (on every change). */
    private fun sayVolume() {
        if (closed || !isConnected) return
        val v = Math.round(volumeHere * 1000) / 1000.0
        val m = mutedHere
        if (v == sentVolume && m == sentMuted) return
        sentVolume = v
        sentMuted = m
        scope.launch { client.device(v, m) }
        changed.value++
    }

    private companion object {
        const val TAG = "Sonus"
    }
}
