package com.creeperux.sonus.core.connect

import com.creeperux.sonus.core.J
import com.creeperux.sonus.core.SubsonicClient
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.security.SecureRandom
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

/**
 * Sonus Connect version 2, the client side (docs/protocol/connect.md), as the Windows app's SessionClient: a WebSocket on
 * rest/connect?protocol=2 that shows this device the user's one playback session, its queue and devices, and carries
 * this device's commands and, while it is the active device, its reports. Once [start]ed it keeps itself connected
 * (backoff 1 s doubling to 30 s) until [stop], and says [resume]'s answer in each hello. Its state can be read from any
 * thread; it changes on OkHttp's thread, in the order the server sent it.
 *
 * @param deviceId this installation's own id ([newDeviceId], kept): a reconnect, or the next start, is the same device.
 * @param name how the other devices list this one ("小明的手机").
 * @param kind desktop, web, phone, tablet, speaker or other.
 * @param canPlay false: a remote that never plays.
 * @param clientLabel the app and its version ("Sonus 0.1.0 (Android)").
 */
class SessionClient(
    private val client: SubsonicClient,
    val deviceId: String,
    private val name: String,
    private val kind: String = "phone",
    private val canPlay: Boolean = true,
    private val clientLabel: String = client.clientName,
    http: OkHttpClient = SubsonicClient.Shared,
) {
    init {
        require(isValidId(deviceId)) { "A device id is 8–64 letters, digits, _ or -." }
    }

    // the server pings every 30 s; OkHttp pings too, so a dead connection is noticed from this side as well
    private val http = http.newBuilder().pingInterval(25, TimeUnit.SECONDS).readTimeout(0, TimeUnit.MILLISECONDS).build()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val sessionFlow = MutableStateFlow(PlaybackSession())
    private val queueFlow = MutableStateFlow(SessionQueue.Empty)
    private val devicesFlow = MutableStateFlow<List<SessionDevice>>(emptyList())
    private val connectedFlow = MutableStateFlow(false)
    private val errorFlow = MutableSharedFlow<Pair<String, String>>(extraBufferCapacity = 16)
    private val volumeFlow = MutableSharedFlow<VolumeAsk>(extraBufferCapacity = 8)
    private val waiting = ConcurrentHashMap<String, CompletableDeferred<SessionReply>>()
    private val refs = AtomicInteger()
    private val offset = AtomicLong() // the server's clock − ours, ms
    private var loop: Job? = null

    @Volatile
    private var socket: WebSocket? = null

    @Volatile
    private var wake = CompletableDeferred<Unit>()

    /** The session as last heard (kept while reconnecting). */
    val session: StateFlow<PlaybackSession> = sessionFlow.asStateFlow()
    val queue: StateFlow<SessionQueue> = queueFlow.asStateFlow()
    val devices: StateFlow<List<SessionDevice>> = devicesFlow.asStateFlow()

    /** Connected and welcomed. */
    val connected: StateFlow<Boolean> = connectedFlow.asStateFlow()

    /** Errors from the server (code, message), also those answering a message that is waited for. */
    val errors: SharedFlow<Pair<String, String>> = errorFlow.asSharedFlow()

    /** Another device changed this one's volume. */
    val volumeAsked: SharedFlow<VolumeAsk> = volumeFlow.asSharedFlow()

    /** Asked on every (re)connect: what to say as `resume` (null: nothing). Called on a background thread. */
    @Volatile
    var resume: (() -> SessionResume?)? = null

    /** This device is the session's active device (as last heard). */
    val isActive: Boolean get() = session.value.activeDevice == deviceId

    /** The server's clock now (ms since the Unix epoch), for [PlaybackSession.positionAt]. */
    val serverNow: Long get() = System.currentTimeMillis() + offset.get()

    fun start() {
        if (loop == null) loop = scope.launch { run() }
    }

    /** Tries again now rather than after the backoff (the server answers again, or the user wants something). */
    fun reconnectNow() {
        wake.complete(Unit)
    }

    /** A command (any device): its action and fields, as in connect.md. Answers when the server applied or refused it
     *  (code "offline" without a connection, "timeout" without an answer). */
    suspend fun command(action: String, fields: JsonObject = JsonObject(emptyMap())): SessionReply =
        request("command", JsonObject(fields + ("action" to JsonPrimitive(action))))

    /** A report (the active device only): what really happened to the entry [key]. */
    suspend fun report(event: String, key: String, positionMs: Long, rev: Long, durationMs: Long? = null, now: SessionNow? = null): SessionReply =
        request(
            "report",
            buildJsonObject {
                put("event", event)
                put("key", key)
                put("positionMs", positionMs)
                put("rev", rev)
                if (durationMs != null) put("durationMs", durationMs)
                if (now != null) {
                    put(
                        "now",
                        buildJsonObject {
                            now.title?.let { put("title", it) }
                            now.artist?.let { put("artist", it) }
                            now.album?.let { put("album", it) }
                            now.albumId?.let { put("albumId", it) }
                            now.coverArt?.let { put("coverArt", it) }
                        },
                    )
                }
            },
        )

    /** This device's own volume (0–1), on every change. */
    suspend fun device(volume: Double, muted: Boolean): SessionReply =
        request("device", buildJsonObject { put("volume", volume); put("muted", muted) })

    private suspend fun request(type: String, fields: JsonObject): SessionReply {
        val ws = socket
        if (ws == null || !connected.value) return SessionReply(false, session.value.rev, "offline", "未连接到服务器。")
        val ref = refs.incrementAndGet().toString()
        val reply = CompletableDeferred<SessionReply>()
        waiting[ref] = reply
        try {
            val message = JsonObject(fields + mapOf("type" to JsonPrimitive(type), "ref" to JsonPrimitive(ref)))
            if (!ws.send(message.toString())) return SessionReply(false, session.value.rev, "offline", "未连接到服务器。")
            return withTimeoutOrNull(10_000) { reply.await() } ?: SessionReply(false, session.value.rev, "timeout", "服务器没有回应。")
        } finally {
            waiting.remove(ref)
        }
    }

    private fun address(): String {
        val url = client.url("connect") + "&protocol=2"
        return if (url.startsWith("https:", ignoreCase = true)) "wss:" + url.substring(6) else "ws:" + url.substring(5)
    }

    private suspend fun run() {
        var wait = 1_000L
        while (scope.isActive) {
            val closed = CompletableDeferred<Unit>()
            val listener = object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    val hello = buildJsonObject {
                        put("type", "hello")
                        put("deviceId", deviceId)
                        put("name", name)
                        put("kind", kind)
                        put("canPlay", canPlay)
                        put("client", clientLabel)
                        resume?.invoke()?.let { r ->
                            put("resume", buildJsonObject { put("rev", r.rev); put("playing", r.playing); put("positionMs", r.positionMs) })
                        }
                    }
                    webSocket.send(hello.toString())
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    if (handle(text)) wait = 1_000L
                }

                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    webSocket.close(1000, null)
                    closed.complete(Unit)
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    closed.complete(Unit)
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    closed.complete(Unit)
                }
            }
            val ws = http.newWebSocket(Request.Builder().url(address()).build(), listener)
            socket = ws
            try {
                closed.await()
            } finally {
                socket = null
                ws.cancel()
                for (w in waiting.values) w.complete(SessionReply(false, session.value.rev, "offline", "连接断开了。"))
                connectedFlow.value = false
            }
            // the wait before the next attempt, cut short by reconnectNow()
            val woken = wake
            val early = withTimeoutOrNull(wait) { woken.await(); true } ?: false
            if (early) {
                wake = CompletableDeferred()
                wait = 1_000L
            } else {
                wait = minOf(30_000L, wait * 2)
            }
        }
    }

    /** One message from the server; true for the welcome. */
    internal fun handle(text: String): Boolean {
        val root = try {
            Json.parseToJsonElement(text) as? JsonObject
        } catch (_: SerializationException) {
            null
        } ?: return false
        J.numOrNull(root, "serverTime")?.let { offset.set(it.toLong() - System.currentTimeMillis()) }
        when (J.str(root, "type")) {
            "welcome" -> {
                queueFlow.value = SessionQueue.parse(root["queue"]) ?: SessionQueue.Empty
                sessionFlow.value = PlaybackSession.parse(root["session"]) ?: PlaybackSession()
                devicesFlow.value = J.array(root, "devices").mapNotNull(SessionDevice::parse)
                connectedFlow.value = true
                return true
            }
            "session" -> PlaybackSession.parse(root["session"])?.let { s -> if (s.rev >= sessionFlow.value.rev) sessionFlow.value = s }
            "queue" -> SessionQueue.parse(root["queue"])?.let { q -> if (q.queueRev >= queueFlow.value.queueRev) queueFlow.value = q }
            "devices" -> devicesFlow.value = J.array(root, "devices").mapNotNull(SessionDevice::parse)
            "deviceCommand" -> if (J.str(root, "action") == "volume") {
                val muted = (root["muted"] as? JsonPrimitive)?.takeIf { it !is JsonNull && !it.isString }?.content?.toBooleanStrictOrNull()
                volumeFlow.tryEmit(VolumeAsk(J.numOrNull(root, "volume"), muted, J.str(root, "from").orEmpty()))
            }
            "ack" -> J.str(root, "ref")?.let { waiting[it]?.complete(SessionReply(true, J.numOrNull(root, "rev")?.toLong() ?: session.value.rev)) }
            "error" -> {
                val code = J.str(root, "code").orEmpty()
                val message = J.str(root, "message").orEmpty()
                J.str(root, "ref")?.let { waiting[it]?.complete(SessionReply(false, session.value.rev, code, message)) }
                errorFlow.tryEmit(code to message)
            }
        }
        return false
    }

    /** A goodbye (the server then knows this device left on purpose: no grace period), then the loop stops. */
    suspend fun stop() {
        socket?.close(1000, "bye")
        delay(100)
        loop?.cancelAndJoin()
        loop = null
        scope.coroutineContext[Job]?.cancel()
    }

    companion object {
        const val VERSION = 2
        private val idPattern = Regex("^[A-Za-z0-9_-]{8,64}$")

        fun isValidId(id: String?) = id != null && idPattern.matches(id)

        /** A new random device id (22 characters). */
        fun newDeviceId(): String = Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(16).also(SecureRandom()::nextBytes))

        /** The server offers version 2 (getOpenSubsonicExtensions, read when connecting). */
        fun supported(client: SubsonicClient) = client.extensionVersions[EXTENSION]?.contains(VERSION) == true

        const val EXTENSION = "sonusConnect"
    }
}
