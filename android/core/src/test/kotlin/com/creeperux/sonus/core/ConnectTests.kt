package com.creeperux.sonus.core

import com.creeperux.sonus.core.connect.PlaybackSession
import com.creeperux.sonus.core.connect.SessionClient
import com.creeperux.sonus.core.connect.SessionModes
import com.google.common.truth.Truth.assertThat
import com.google.common.truth.Truth.assertWithMessage
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import okhttp3.OkHttpClient
import org.junit.AfterClass
import org.junit.Assume.assumeTrue
import org.junit.BeforeClass
import org.junit.Test
import java.io.File
import java.net.ServerSocket
import java.util.concurrent.TimeUnit
import kotlin.random.Random

/** Where the demo server and the protocol's files are: SONUS_DEMO_REPO (another checkout, e.g. one with a newer demo
 *  server), else this repository. */
internal fun demoRepo(): File = File(System.getProperty("sonus.demoRepo")?.takeIf { it.isNotBlank() } ?: System.getProperty("sonus.repo") ?: "..")

/**
 * The test vectors of Sonus Connect version 2 (docs/protocol/connect-vectors.json, made by the reference session logic,
 * tools/demo-server/connect-session.mjs) replayed on this app's own PlayQueue, as the Windows app's ConnectVectorsTests:
 * every step that moves the queue is done here too, with the same random numbers, and the queue must then be what the
 * vector says. So the server's queue is PlayQueue's, as the protocol promises. Skipped where the file is not (yet) in
 * the repository.
 */
class ConnectVectorsTest {
    /** Random numbers as the vectors hand them out: the case's list in turn, each modulo n, then 0s. */
    private class SequenceRandom(private val values: IntArray) : Random() {
        private var at = 0
        override fun nextBits(bitCount: Int): Int = 0
        override fun nextInt(until: Int): Int = if (at < values.size) ((values[at++] % until) + until) % until else 0
    }

    private fun s(e: JsonElement?, name: String) = J.str(e, name)
    private fun ids(e: JsonElement?, name: String) = J.array(e, name).map { it.jsonPrimitive.content }
    private fun b(e: JsonElement?, name: String) = J.bool(e, name)

    @Test
    fun theVectorsQueueIsWhatPlayQueueDoes() {
        val file = File(demoRepo(), "docs/protocol/connect-vectors.json")
        assumeTrue("docs/protocol/connect-vectors.json is in the repository", file.isFile)
        val root = Json.parseToJsonElement(file.readText()).jsonObject
        val library = root["library"]!!.jsonObject.mapValues { (id, v) ->
            Track(id = id, title = s(v, "title")!!, artist = s(v, "artist")!!, artistId = "ar", album = s(v, "album")!!, albumId = s(v, "albumId")!!, albumArtist = "A", duration = J.num(v, "durationMs") / 1000)
        }
        var cases = 0
        var checked = 0
        for (c in root["cases"]!!.jsonArray) {
            val name = s(c, "name")!!
            if (c.toString().contains("shuffleAlbums") || c.toString().contains("shuffleFolders")) continue // the sender arranges those
            cases++
            val q = PlayQueue({ library[it] }, SequenceRandom(c.jsonObject["random"]!!.jsonArray.map { it.jsonPrimitive.int }.toIntArray()))
            var before: JsonObject? = null
            for ((n, step) in c.jsonObject["steps"]!!.jsonArray.withIndex()) {
                val expect = step.jsonObject["expect"]!!.jsonObject
                step.jsonObject["send"]?.let { apply(q, it.jsonObject, step.jsonObject["at"]!!.jsonPrimitive.long, before, expect) }
                val where = "$name, step ${n + 1}"
                val queue = expect["queue"]!!.jsonObject
                val session = expect["session"]!!.jsonObject
                assertWithMessage("$where: order").that(q.contextIds).isEqualTo(ids(queue, "order"))
                assertWithMessage("$where: pointer").that(q.pointer).isEqualTo(queue["pointer"]!!.jsonPrimitive.int)
                assertWithMessage("$where: manual").that(q.entries.filter { it.manual }.map { "${it.id}:${it.trackId}" })
                    .isEqualTo(J.array(queue, "manual").map { "${s(it, "key")}:${s(it, "trackId")}" })
                assertWithMessage("$where: current").that(q.current).isEqualTo((session["current"] as? JsonObject)?.let { s(it, "trackId") })
                assertWithMessage("$where: mode").that(SessionModes.of(q.order)).isEqualTo(s(session, "mode"))
                assertWithMessage("$where: stop after current").that(q.stopAfterCurrent).isEqualTo(b(session, "stopAfterCurrent"))
                assertWithMessage("$where: next").that(q.peek()).isEqualTo(s(session, "next"))
                before = session
                checked++
            }
        }
        assertWithMessage("$cases cases, $checked steps").that(cases >= 10 && checked >= 100).isTrue()
    }

    /** What a step does to the queue, as the session logic decides it. */
    private fun apply(q: PlayQueue, msg: JsonObject, at: Long, before: JsonObject?, expect: JsonObject) {
        val errors = J.array(expect, "replies").mapNotNull { r -> (r as? JsonObject)?.get("msg")?.takeIf { s(it, "type") == "error" }?.let { s(it, "code") } }
        val type = s(msg, "type").orEmpty()
        val action = s(msg, if (type == "report") "event" else "action").orEmpty()
        // refused: nothing changed (a remove with stale keys still removes the rest)
        if (errors.any { it in setOf("nothing", "invalid", "cannotPlay", "notActive", "offline") } || ("stale" in errors && action != "remove")) return
        if (type == "report") {
            if (action == "ended") q.next(ended = true) else if (action == "failed") q.next()
            return
        }
        if (type != "command") return
        when (action) {
            "playContext" -> {
                val ctx = msg["context"] as? JsonObject
                q.start(PlayContext(s(ctx, "kind").orEmpty(), s(ctx, "id").orEmpty(), s(ctx, "label").orEmpty()), ids(msg, "ids"), s(msg, "startId"), b(msg, "shuffle"))
            }
            "next" -> q.next()
            "play" -> if (before?.get("current") !is JsonObject) q.next() // songs queued by hand, nothing current yet
            "previous" -> {
                val bf = before!!
                var position = J.num(bf, "positionMs").toLong() + if (b(bf, "playing")) maxOf(0, at - J.num(bf, "at").toLong()) else 0
                val duration = J.num(bf, "durationMs").toLong()
                if (duration > 0) position = minOf(position, duration)
                if (position <= 3000) q.previous() // more than 3 s in: back to the start of the same song
            }
            "jump" -> q.jump(s(msg, "entry")!!)
            "add" -> q.add(ids(msg, "ids"), b(msg, "next"))
            "move" -> q.move(ids(msg, "order"), ids(msg, "keys"), b(msg, "manual"))
            "remove" -> q.remove(ids(msg, "entries"))
            "clear" -> q.clear(b(msg, "manual"))
            "mode" -> q.changeOrder(SessionModes.parse(s(msg, "mode")))
            "stopAfterCurrent" -> q.stopAfterCurrent = b(msg, "on")
        }
    }
}

/**
 * Sonus Connect version 2 against the demo server: two devices of one user, as the protocol's examples have them. Skipped
 * when the demo server does not speak version 2 (set SONUS_DEMO_REPO to a checkout whose demo server does).
 */
class ConnectDemoTest {
    companion object {
        private var process: Process? = null
        private var base = ""
        private val http = OkHttpClient.Builder().readTimeout(20, TimeUnit.SECONDS).build()

        @JvmStatic
        @BeforeClass
        fun startServer() {
            val script = File(demoRepo(), "tools/demo-server/demo-server.mjs")
            assumeTrue("the demo server is there", script.isFile)
            assumeTrue("it speaks Connect v2", File(demoRepo(), "tools/demo-server/connect2.mjs").isFile)
            val port = ServerSocket(0).use { it.localPort }
            val p = runCatching { ProcessBuilder("node", script.absolutePath, port.toString()).redirectErrorStream(true).also { it.environment()["SONUS_DEMO_CONNECT_GRACE"] = "1500" }.start() }.getOrNull()
            assumeTrue("node is on the PATH", p != null)
            process = p
            assertThat(p!!.inputStream.bufferedReader().readLine().orEmpty()).contains("demo server")
            base = "http://127.0.0.1:$port"
        }

        @JvmStatic
        @AfterClass
        fun stopServer() {
            process?.destroy()
        }
    }

    private suspend fun device(id: String, name: String, kind: String = "desktop"): Pair<SubsonicClient, SessionClient> {
        val login = SubsonicClient.signIn(base, "demo", "demo", "Sonus (Test)", http)
        val c = SubsonicClient(login, "Sonus (Test)", http)
        c.connect()
        assertThat(SessionClient.supported(c)).isTrue()
        val s = SessionClient(c, id, name, kind, clientLabel = "Sonus test", http = http)
        s.start()
        withTimeout(10_000) { s.connected.first { it } }
        return c to s
    }

    private suspend fun SessionClient.until(what: String, test: (PlaybackSession) -> Boolean): PlaybackSession =
        withTimeout(10_000) { session.first(test) }.also { assertWithMessage(what).that(test(it)).isTrue() }

    @Test
    fun oneSessionTwoDevicesTransferAndVolume(): Unit = runBlocking {
        val (client, pc) = device("test-pc-0001", "书房电脑")
        val (_, phone) = device("test-phone-01", "手机", "phone")
        try {
            // both see each other
            withTimeout(5_000) { phone.devices.first { d -> d.any { it.id == "test-pc-0001" } && d.any { it.id == "test-phone-01" } } }

            // the PC plays an album: with no active device, the sender becomes it (rule 6)
            val album = client.loadLibrary().albums.first { it.trackIds.size >= 3 }
            val reply = pc.command(
                "playContext",
                buildJsonObject {
                    putJsonObject("context") { put("kind", "album"); put("id", album.id); put("label", album.title) }
                    putJsonArray("ids") { album.trackIds.forEach { add(JsonPrimitive(it)) } }
                },
            )
            assertWithMessage("playContext: ${reply.code} ${reply.message}").that(reply.ok).isTrue()
            val s1 = phone.until("the phone sees the PC play") { it.activeDevice == "test-pc-0001" && it.current?.trackId == album.trackIds[0] }
            assertThat(pc.isActive).isTrue()
            assertThat(phone.isActive).isFalse()
            assertThat(s1.next).isEqualTo(album.trackIds[1])
            assertThat(phone.queue.value.order).containsAtLeastElementsIn(album.trackIds)

            // the active device reports what happens; a remote's command changes the one session
            pc.report("loaded", s1.current!!.key, 0, s1.rev, durationMs = 180_000)
            pc.report("playing", s1.current!!.key, 0, pc.session.value.rev)
            phone.until("playing") { it.playing }
            assertThat(phone.command("next").ok).isTrue()
            pc.until("the PC follows next") { it.current?.trackId == album.trackIds[1] }
            assertThat(phone.command("pause").ok).isTrue()
            pc.until("paused") { !it.playing }

            // rule 8: the phone changes the PC's volume
            val asked = async { withTimeout(5_000) { pc.volumeAsked.first() } }
            delay(100)
            assertThat(phone.command("volume", buildJsonObject { put("device", "test-pc-0001"); put("volume", 0.4) }).ok).isTrue()
            assertThat(asked.await().volume).isWithin(0.001).of(0.4)

            // rule 4: only a transfer moves playback; the device it leaves stops
            assertThat(phone.command("transfer", buildJsonObject { put("to", "test-phone-01"); put("play", true) }).ok).isTrue()
            pc.until("the PC is no longer active") { it.activeDevice == "test-phone-01" && it.playing }
            assertThat(phone.isActive).isTrue()
            assertThat(pc.isActive).isFalse()

            // a goodbye: the PC leaves the list at once
            pc.stop()
            withTimeout(5_000) { phone.devices.first { d -> d.none { it.id == "test-pc-0001" } } }
        } finally {
            phone.stop()
            runCatching { pc.stop() }
        }
    }

    @Test
    fun commandsWithoutAConnectionSayOffline(): Unit = runBlocking {
        val login = SubsonicClient.signIn(base, "demo", "demo", "Sonus (Test)", http)
        val s = SessionClient(SubsonicClient(login, "Sonus (Test)", http), "never-connected-1", "x")
        assertThat(s.command("next").code).isEqualTo("offline")
    }
}

/** The session as the protocol writes it, without a server. */
class ConnectSessionTest {
    @Test
    fun sessionMessagesAreReadAsTheSpecShowsThem() {
        val s = PlaybackSession.parse(
            Json.parseToJsonElement(
                """{"rev":412,"activeDevice":"a1b2c3d4","lastDevice":{"id":"a1b2c3d4","name":"书房电脑"},"current":{"key":"c17:tr4","trackId":"tr4","manual":false},
                "next":"tr9","playing":true,"positionMs":83500,"at":1764001234567,"durationMs":241000,"now":{"title":"T","artist":"A","album":"B","albumId":"al1","coverArt":"al1"},
                "mode":"shuffleTracks","stopAfterCurrent":false,"context":{"kind":"album","id":"al1","label":"B"},"queueRev":57}""",
            ),
        )!!
        assertThat(s.rev).isEqualTo(412)
        assertThat(s.current!!.key).isEqualTo("c17:tr4")
        assertThat(s.positionAt(1764001234567 + 2_000)).isEqualTo(85_500)
        assertThat(s.copy(playing = false).positionAt(1764001234567 + 2_000)).isEqualTo(83_500)
        assertThat(s.copy(positionMs = 240_000).positionAt(1764001234567 + 5_000)).isEqualTo(241_000) // not past the end
        assertThat(SessionModes.parse(s.mode)).isEqualTo(PlaybackOrder.ShuffleTracks)
        assertThat(SessionModes.window((1..20_000).map { "t$it" }, "t15000")).hasSize(10_000)
        assertThat(SessionModes.window((1..20_000).map { "t$it" }, "t15000").first()).isEqualTo("t10001")
        assertThat(SessionClient.isValidId(SessionClient.newDeviceId())).isTrue()
        assertThat(SessionClient.isValidId("short")).isFalse()
    }
}
