package com.creeperux.sonus.core

import com.google.common.truth.Truth.assertThat
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import okhttp3.OkHttpClient
import okhttp3.Request
import org.junit.AfterClass
import org.junit.Assume.assumeTrue
import org.junit.BeforeClass
import org.junit.Test
import java.io.File
import java.net.ServerSocket
import java.util.concurrent.TimeUnit

/**
 * The client against the repository's demo server (tools/demo-server, account demo/demo), started here with node on a
 * free port: the same server the Windows and web clients' tests use. Skipped when node is not on the PATH.
 */
class DemoServerTest {
    companion object {
        private var process: Process? = null
        private var base = ""
        private val http = OkHttpClient.Builder().readTimeout(20, TimeUnit.SECONDS).build()

        @JvmStatic
        @BeforeClass
        fun startServer() {
            val repo = File(System.getProperty("sonus.repo") ?: "..")
            val script = File(repo, "tools/demo-server/demo-server.mjs")
            assumeTrue("the demo server is in the repository", script.isFile)
            val port = ServerSocket(0).use { it.localPort }
            val p = try {
                ProcessBuilder("node", script.absolutePath, port.toString()).redirectErrorStream(true).start()
            } catch (_: Exception) {
                null
            }
            assumeTrue("node is on the PATH", p != null)
            process = p
            val ready = p!!.inputStream.bufferedReader().readLine().orEmpty()
            assertThat(ready).contains("demo server")
            base = "http://127.0.0.1:$port"
        }

        @JvmStatic
        @AfterClass
        fun stopServer() {
            process?.destroy()
        }
    }

    private fun get(path: String): String = http.newCall(Request.Builder().url("$base$path").build()).execute().use { it.body.string() }

    private fun client() = runBlocking { SubsonicClient(SubsonicClient.signIn(base, "demo", "demo", "Sonus (Test)", http), "Sonus (Test)", http) }

    @Test
    fun signsInLoadsTheLibraryAndPlaylists() = runBlocking {
        val c = client()
        val info = c.connect()
        assertThat(info.name).isEqualTo("Navidrome")
        assertThat(c.extensions).containsAtLeast("songLyrics", "formPost", DeviceLogin.EXTENSION)
        val lib = c.loadLibrary()
        assertThat(lib.tracks.size).isAtLeast(100)
        assertThat(lib.albums.size).isAtLeast(10)
        assertThat(lib.albums.all { it.trackIds.isNotEmpty() }).isTrue()
        assertThat(c.songCount()).isEqualTo(lib.tracks.size)
        val playlists = c.getPlaylists { J.str(it, "id")!! }
        assertThat(playlists.map { it.name }).contains("深夜写代码")
        assertThat(playlists.first { it.name == "朋友的歌单" }.kind).isEqualTo(PlaylistKind.ReadOnly)
        assertThat(playlists.first { it.name == "深夜写代码" }.entries).isNotEmpty()
    }

    @Test
    fun wrongPasswordIsRefused() {
        val e = runCatching { runBlocking { SubsonicClient.signIn(base, "demo", "nope", "Sonus (Test)", http) } }.exceptionOrNull()
        assertThat((e as SubsonicException).isAuthentication).isTrue()
    }

    @Test
    fun syncedLyricsCoversAndStreams() = runBlocking {
        val c = client()
        c.connect()
        val lib = c.loadLibrary()
        val withLyrics = lib.tracks.firstNotNullOf { t -> c.lyrics(t)?.takeIf { l -> l.size > 2 && l.all { it.time != null } }?.let { t to it } }
        assertThat(withLyrics.second.zipWithNext().all { (a, b) -> a.time!! <= b.time!! }).isTrue()
        val album = lib.albums.first()
        http.newCall(Request.Builder().url(c.coverUrl(album.coverArt!!, 96)).build()).execute().use {
            assertThat(it.code).isEqualTo(200)
            assertThat(it.header("Content-Type")).startsWith("image/")
        }
        http.newCall(Request.Builder().url(c.streamUrl(album.trackIds.first())).header("Range", "bytes=0-15").build()).execute().use {
            assertThat(it.code).isEqualTo(206)
            assertThat(it.header("Content-Type")).isEqualTo("audio/wav")
        }
    }

    @Test
    fun scrobblesNowPlayingThenAPlay() = runBlocking {
        val c = client()
        c.connect()
        val t = c.loadLibrary().tracks.first()
        c.scrobble(t.id, submission = false)
        c.scrobble(t.id, submission = true, startedAt = System.currentTimeMillis() - 120_000)
        val log = Json.parseToJsonElement(get("/__test/log")) as JsonObject
        val mine = J.array(log, "scrobbles").filter { J.str(it, "id") == t.id }
        assertThat(mine.size).isAtLeast(2)
    }

    @Test
    fun savesAndReadsThePlayQueue() = runBlocking {
        val c = client()
        c.connect()
        val ids = c.loadLibrary().tracks.take(5).map { it.id }
        c.savePlayQueue(ids, ids[2], 42.5)
        val q = c.getPlayQueue { J.str(it, "id")!! }!!
        assertThat(q.trackIds).isEqualTo(ids)
        assertThat(q.current).isEqualTo(ids[2])
        assertThat(q.position).isWithin(0.01).of(42.5)
    }

    @Test
    fun browserSignInGetsAKeyThatWorksAndIsRevoked() = runBlocking {
        val (server, supported) = DeviceLogin.probe(base, http)
        assertThat(supported).isTrue()
        val start = DeviceLogin.start(server, "Sonus", "测试手机", http)
        assertThat(start.verificationUrl).startsWith("$base/app/#/device")
        val waiting = async { DeviceLogin.await(start, http) }
        delay(300)
        assertThat(get("/__test/device?code=${start.userCode}&decide=allow")).contains("\"decided\":true")
        val (state, login) = waiting.await()
        assertThat(state).isEqualTo(DeviceLoginState.Approved)
        val c = SubsonicClient(login!!, "Sonus (Test)", http)
        assertThat(c.connect().name).isEqualTo("Navidrome")
        assertThat(c.coverUrl("x")).contains("apiKey=")
        assertThat(DeviceLogin.revoke(login, http)).isTrue()
        val e = runCatching { c.connect() }.exceptionOrNull()
        assertThat((e as SubsonicException).isAuthentication).isTrue()
    }

    @Test
    fun aDeniedBrowserSignInSaysSo() = runBlocking {
        val start = DeviceLogin.start(base, "Sonus", "测试手机", http)
        val waiting = async { DeviceLogin.await(start, http) }
        delay(300)
        get("/__test/device?code=${start.userCode}&decide=deny")
        assertThat(waiting.await().first).isEqualTo(DeviceLoginState.Denied)
    }
}
