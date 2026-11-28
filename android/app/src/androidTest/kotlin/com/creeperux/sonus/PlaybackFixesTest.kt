package com.creeperux.sonus

import android.content.Context
import android.graphics.Bitmap
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextReplacement
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.creeperux.sonus.core.Album
import com.creeperux.sonus.core.SubsonicClient
import com.creeperux.sonus.core.connect.PlaybackSession
import com.creeperux.sonus.core.connect.SessionClient
import com.creeperux.sonus.playback.PlayerStatus
import com.google.common.collect.Range
import com.google.common.truth.Truth.assertThat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.Collections
import java.util.concurrent.TimeUnit
import kotlin.math.abs

/**
 * What Sonus for Android 0.2.0 fixes, on a device, with a second device of the same account (a SessionClient in this
 * test, standing for a computer) watching the session or playing it:
 * - a song that ends by itself into a longer one keeps its own length (on the bar, in `loaded`, in the session), and both
 *   devices run past the length of the song before (the library's length stands; reported positions are not held);
 * - the remote follows the device that plays: a natural change into a longer song, a seek on either side, pause, play;
 * - a transfer late in a song plays on from there (the start position applied once);
 * - the song after the playing one failing (its file is gone) does not fail the one that plays: that one plays to its
 *   end, and the failed one is skipped with a toast naming it;
 * - the page of what plays opens at the playing song.
 * Against the demo server or a Sonus server (TestServer). The tests with a second device are skipped where the server
 * does not speak Connect v2; the other two then test this device's own playing (the queue here, no session).
 */
@RunWith(AndroidJUnit4::class)
class PlaybackFixesTest {
    @get:Rule
    val compose = createAndroidComposeRule<MainActivity>()

    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context: Context get() = instrumentation.targetContext
    private val graph: AppGraph get() = (context.applicationContext as SonusApp).graph
    private val http = OkHttpClient.Builder().readTimeout(10, TimeUnit.SECONDS).build()
    private val user: String get() = TestServer.user(context)
    private val password: String get() = TestServer.password(context)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var desk: SessionClient? = null

    @Before
    fun signedIn() {
        instrumentation.runOnMainSync { graph.signOut() }
        compose.waitUntil(20_000) { exists("signin") }
        compose.onNodeWithTag("server").performTextReplacement(TestServer.url)
        compose.onNodeWithTag("user").performTextReplacement(user)
        compose.onNodeWithTag("password").performTextReplacement(password)
        compose.onNodeWithTag("signin").performClick()
        compose.waitUntil(30_000) { exists("home") }
        if (graph.link != null) waitFor(what = "the app connected to the session") { graph.link?.isConnected == true }
    }

    private fun needsConnect() = assumeTrue("the server speaks Sonus Connect v2", graph.link != null)

    @After
    fun done() {
        scope.cancel()
        desk?.let { runBlocking { it.close() } }
        instrumentation.runOnMainSync { graph.playback.pause() }
    }

    // ---------------------------------------------------------------- helpers

    private fun exists(tag: String) = try {
        compose.onAllNodesWithTag(tag, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
    } catch (_: IllegalStateException) {
        false
    }

    private fun shows(text: String) = try {
        compose.onAllNodesWithText(text, substring = true, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
    } catch (_: IllegalStateException) {
        false
    }

    /** Runs [block] on the main thread, where the player lives. */
    private fun <T> main(block: () -> T): T {
        var result: Result<T>? = null
        instrumentation.runOnMainSync { result = runCatching(block) }
        return result!!.getOrThrow()
    }

    private fun waitFor(timeoutMs: Long = 15_000, what: String, condition: () -> Boolean) {
        val until = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < until) {
            if (main(condition)) return
            Thread.sleep(200)
        }
        throw AssertionError("timed out waiting for $what")
    }

    /** Waits (here, off the main thread) for the session as the computer has it. */
    private fun SessionClient.until(what: String, timeoutMs: Long = 10_000, test: (PlaybackSession) -> Boolean): PlaybackSession {
        val until = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < until) {
            val s = session.value
            if (test(s)) return s
            Thread.sleep(150)
        }
        throw AssertionError("timed out waiting for the session: $what (it is ${session.value})")
    }

    private fun shot(name: String) {
        val dir = InstrumentationRegistry.getArguments().getString("additionalTestOutputDir")?.let(::File) ?: context.getExternalFilesDir("screenshots")!!
        dir.mkdirs()
        val bitmap = instrumentation.uiAutomation.takeScreenshot() ?: return
        val kind = if (context.resources.configuration.smallestScreenWidthDp >= 600) "tablet" else "phone"
        File(dir, "$kind-$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private val session get() = (graph.state.value as AppState.Ready).session
    private val state get() = graph.playback.state.value
    private val position get() = graph.playback.position.value

    /** The computer: a second device of this account, connected to the session. */
    private fun computer(): SessionClient {
        needsConnect()
        val login = runBlocking { SubsonicClient.signIn(TestServer.url, user, password, "Sonus (Test)", http) }
        val client = SubsonicClient(login, "Sonus (Test)", http)
        runBlocking { client.connect() }
        val other = SessionClient(client, "test-desk-0002", "测试电脑", "desktop", clientLabel = "Sonus test", http = http).also { desk = it }
        other.start()
        runBlocking { withTimeout(10_000) { other.connected.first { it } } }
        return other
    }

    /** The computer plays [album] from its song [index] (rule 6: with no device playing, the sender becomes the one). */
    private fun SessionClient.plays(album: Album, index: Int): PlaybackSession {
        val reply = runBlocking {
            command(
                "playContext",
                buildJsonObject {
                    putJsonObject("context") { put("kind", "album"); put("id", album.id); put("label", album.title) }
                    putJsonArray("ids") { album.trackIds.forEach { add(JsonPrimitive(it)) } }
                    put("startId", album.trackIds[index])
                },
            )
        }
        assertThat(reply.ok).isTrue()
        return until("the computer plays") { it.activeDevice == deviceId && it.current?.trackId == album.trackIds[index] }
    }

    private fun SessionClient.says(event: String, positionSeconds: Double, durationSeconds: Double? = null) {
        val s = session.value
        val reply = runBlocking { report(event, s.current!!.key, (positionSeconds * 1000).toLong(), s.rev, durationSeconds?.let { (it * 1000).toLong() }) }
        assertThat(reply.ok).isTrue()
    }

    /** This device plays [album] from its song [index]. */
    private fun playHere(album: Album, index: Int) {
        main { session.contextOf("album", album.id).let { (ctx, ids) -> graph.playback.play(ctx, ids, album.trackIds[index]) } }
        waitFor(20_000, "playing here") { !graph.playback.elsewhere && graph.playback.exo.isPlaying && state.trackId == album.trackIds[index] }
    }

    // ---------------------------------------------------------------- the tests

    @Test
    fun aSongThatEndsIntoALongerOneKeepsItsOwnLength() {
        val other = computer()
        val (album, i) = TestServer.endsIntoLonger(session.lib)
        val x = session.lib.track(album.trackIds[i])!!
        val y = session.lib.track(album.trackIds[i + 1])!!
        playHere(album, i)
        main { graph.playback.seek(x.duration - 6) }
        waitFor(25_000, "the next song, by itself") { state.trackId == y.id && graph.playback.exo.isPlaying }
        // its own length: on this device's bar, and in the session
        assertThat(main { state.duration }).isWithin(0.5).of(y.duration)
        val s = other.until("the session on the longer song") { it.current?.trackId == y.id }
        assertThat(s.durationMs / 1000.0).isWithin(1.0).of(y.duration)
        // past the length of the song before, on both devices
        main { graph.playback.seek(x.duration - 3) }
        other.until("the computer told of the seek") { abs(it.positionMs / 1000.0 - (x.duration - 3)) < 1.5 }
        Thread.sleep(5_000)
        assertThat(main { position }).isGreaterThan(x.duration + 1)
        other.until("the computer's position past the song before's length") { it.current?.trackId == y.id && it.positionAt(other.serverNow) > (x.duration + 1) * 1000 }
        shot("fix-01-longer-song")
    }

    @Test
    fun theRemoteFollowsTheDeviceThatPlays() {
        val other = computer()
        val (album, i) = TestServer.endsIntoLonger(session.lib)
        val x = session.lib.track(album.trackIds[i])!!
        val y = session.lib.track(album.trackIds[i + 1])!!
        // the computer plays the shorter song, near its end
        other.plays(album, i)
        other.says("loaded", 0.0, x.duration)
        other.says("playing", x.duration - 4)
        waitFor(what = "the app shows the computer's song near its end") { graph.playback.elsewhere && state.trackId == x.id && position > x.duration - 6 }

        // it ends there by itself, into the longer one; the computer's engine still has the length of the song before
        other.says("ended", x.duration)
        other.until("the session on the longer song") { it.current?.trackId == y.id }
        other.says("loaded", 0.0, x.duration)
        other.says("playing", 0.0)
        other.says("position", x.duration + 5) // past the length of the song before
        waitFor(what = "the app on the longer song, past the length of the one before") {
            state.trackId == y.id && abs(state.duration - y.duration) < 1 && position > x.duration + 5.5
        }
        compose.waitUntil(5_000) { exists("elsewhere") }
        shot("fix-02-remote-longer-song")

        // a seek on the computer
        other.says("position", 30.0)
        waitFor(what = "the app at the computer's seek") { position in 29.0..35.0 }
        // a seek here: the computer is told, and the app stays there (not back where it was)
        val target = y.duration - 60
        main { graph.playback.seek(target) }
        other.until("the computer told of the seek") { abs(it.positionMs / 1000.0 - target) < 1.5 }
        Thread.sleep(1_500)
        assertThat(main { position }).isIn(Range.closed(target, target + 5))

        // pause and play from here
        main { graph.playback.pause() }
        other.until("paused") { !it.playing }
        waitFor(what = "paused in the app") { state.status == PlayerStatus.Paused }
        val stopped = main { position }
        Thread.sleep(1_500)
        assertThat(main { position }).isWithin(0.3).of(stopped)
        main { graph.playback.resume() }
        other.until("playing") { it.playing }
        waitFor(what = "moving on in the app") { position > stopped + 1 }
    }

    @Test
    fun aTransferLateInASongPlaysOnFromThere() {
        val other = computer()
        val (album, i) = TestServer.longSong(session.lib)
        val song = session.lib.track(album.trackIds[i])!!
        other.plays(album, i)
        other.says("loaded", 0.0, song.duration)
        other.says("playing", 150.0) // 2½ minutes in
        waitFor(what = "the app shows the computer's song") { graph.playback.elsewhere && state.trackId == song.id && position > 149 }

        // the strip opens the devices; this device takes it over
        compose.waitUntil(10_000) { exists("elsewhere") }
        compose.onNodeWithTag("elsewhere").performClick()
        compose.waitUntil(5_000) { exists("devices-sheet") }
        Thread.sleep(700) // the sheet slides up
        shot("fix-03-devices")
        compose.onNodeWithTag("device-${graph.link!!.id}").performClick()
        waitFor(25_000, "playing here") { !graph.playback.elsewhere && graph.playback.exo.isPlaying && state.trackId == song.id }
        // from where it was, once (a start position applied twice would be 300 s in, or the next song)
        val at = main { graph.playback.exo.currentPosition / 1000.0 }
        assertThat(at).isIn(Range.closed(149.0, 175.0))
        Thread.sleep(3_000)
        assertThat(main { state.trackId }).isEqualTo(song.id)
        assertThat(main { graph.playback.exo.currentPosition / 1000.0 }).isGreaterThan(at + 1)
        other.until("this device plays the session") { it.activeDevice == graph.link!!.id && it.playing }
        compose.waitUntil(5_000) { !exists("elsewhere") }
        shot("fix-04-transferred")
    }

    @Test
    fun aConnectionLostWhilePlayingHereComesBack() {
        needsConnect()
        val album = TestServer.playableAlbum(session.lib)
        playHere(album, 0)
        val link = graph.link!!
        waitFor(what = "this device plays the session") { link.isActiveHere && link.session.playing }
        // the connection breaks without a goodbye, as when the screen is off and the network sleeps: the app reconnects
        // by itself, its hello saying it still plays (until 0.5.1 that hello read the player off the main thread, Media3
        // threw, and the connection failed before it, and every reconnect after it: the phone played on, alone)
        link.client.simulateNetworkLoss()
        waitFor(5_000, "the loss noticed") { !link.isConnected }
        waitFor(15_000, "connected again") { link.isConnected }
        waitFor(10_000, "still this device, still playing") { link.isActiveHere && link.session.playing }
        assertThat(main { graph.playback.exo.isPlaying }).isTrue()
        assertThat(main { state.trackId }).isEqualTo(album.trackIds[0])
    }

    @Test
    fun aFailedNextSongDoesNotFailTheOneThatPlays() {
        val (album, i) = TestServer.beforeMissing(session.lib) ?: run { assumeTrue("a song whose file is gone", false); return }
        val p = session.lib.track(album.trackIds[i])!!
        val missing = session.lib.track(album.trackIds[i + 1])!!
        val after = session.lib.track(album.trackIds[i + 2])!!
        // what the app says (with Connect v2 the server answers the device that plays `unplayable`, naming the song, and
        // the app shows it; without, the app skips it itself and says the same)
        val toasts = Collections.synchronizedList(mutableListOf<String>())
        scope.launch { session.toast.collect { toasts += it.text } }
        playHere(album, i)
        main { graph.playback.seek(p.duration - 8) }
        // the playing song plays on to its end and is never failed, while the next one's early load fails
        val until = System.currentTimeMillis() + 5_500
        while (System.currentTimeMillis() < until) {
            val s = main { state }
            assertThat(s.trackId).isEqualTo(p.id)
            assertThat(s.status).isNotEqualTo(PlayerStatus.Error)
            Thread.sleep(250)
        }
        // then the failed one is skipped, named in a toast, and the one after it plays
        waitFor(25_000, "the song after the failed one") { state.trackId == after.id && graph.playback.exo.isPlaying }
        val said = toasts.joinToString(" | ")
        assertThat(said).contains("无法播放“${missing.title}”")
        assertThat(said).doesNotContain("“${p.title}”")
        // on screen (toasts take turns: without Connect v2, 接着上次听 from signing in, ten seconds long, can come first)
        compose.waitUntil(20_000) { shows("无法播放“${missing.title}”") }
        shot("fix-05-skipped")
    }

    @Test
    fun thePageOfWhatPlaysOpensAtThePlayingSong() {
        val lib = session.lib
        val album = lib.albums.sortedBy { it.title }.first { a -> a.trackIds.size >= 8 && a.trackIds.all { lib.track(it) != null && it != TestServer.missingFile } }
        val last = lib.track(album.trackIds.last())!!
        playHere(album, album.trackIds.lastIndex)
        // the album's page, from the player: the full player's menu on a phone, the bar's title on a tablet
        if (exists("mini-player")) {
            compose.onNodeWithTag("mini-player").performClick()
            compose.waitUntil(5_000) { exists("full-player") }
            compose.onAllNodes(hasContentDescription("更多") and hasAnyAncestor(hasTestTag("full-player")))[0].performClick()
            compose.waitUntil(5_000) { shows("查看专辑") }
            compose.onNodeWithText("查看专辑").performClick()
        } else {
            compose.onAllNodes(hasText(last.title) and hasAnyAncestor(hasTestTag("playback-bar")), useUnmergedTree = true)[0].performClick()
        }
        compose.waitUntil(10_000) { exists("album-page") }
        // its row is in view: without the jump the page opens at its top, the album's picture and its first songs
        compose.waitUntil(5_000) {
            compose.onAllNodes(hasText(last.title) and hasAnyAncestor(hasTestTag("album-page")), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
        }
        Thread.sleep(500)
        compose.onAllNodes(hasText(last.title) and hasAnyAncestor(hasTestTag("album-page")), useUnmergedTree = true)[0].assertIsDisplayed()
        shot("fix-06-album-at-playing")
    }
}
