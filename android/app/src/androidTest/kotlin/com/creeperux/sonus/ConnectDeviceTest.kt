package com.creeperux.sonus

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.media.AudioManager
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextReplacement
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import com.creeperux.sonus.core.SubsonicClient
import com.creeperux.sonus.core.connect.SessionClient
import com.creeperux.sonus.playback.PlaybackService
import com.creeperux.sonus.playback.PlayerStatus
import com.google.common.truth.Truth.assertThat
import kotlinx.coroutines.flow.first
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
import java.util.concurrent.TimeUnit

/**
 * Sonus Connect version 2 on a device: the app and a second device of the same account (a SessionClient in this test,
 * standing for a computer) share one playback session. The other device plays; the app shows it ("正在「测试电脑」上播放"),
 * stays silent, and steers it from its buttons and from the system's media controls; the other device sets the app's
 * volume; the device list moves playback to the app. Skipped when the demo server does not speak version 2.
 */
@RunWith(AndroidJUnit4::class)
class ConnectDeviceTest {
    @get:Rule
    val compose = createAndroidComposeRule<MainActivity>()

    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context: Context get() = instrumentation.targetContext
    private val graph: AppGraph get() = (context.applicationContext as SonusApp).graph
    private val device: UiDevice = UiDevice.getInstance(instrumentation)
    private val server = InstrumentationRegistry.getArguments().getString("sonusServer") ?: "http://127.0.0.1:4633"
    private val http = OkHttpClient.Builder().readTimeout(10, TimeUnit.SECONDS).build()
    private val user: String get() = account(context)
    private var desk: SessionClient? = null

    @Before
    fun signedIn() {
        instrumentation.runOnMainSync { graph.signOut() }
        compose.waitUntil(20_000) { exists("signin") }
        compose.onNodeWithTag("server").performTextReplacement(server)
        compose.onNodeWithTag("user").performTextReplacement(user)
        compose.onNodeWithTag("password").performTextReplacement(user)
        compose.onNodeWithTag("signin").performClick()
        compose.waitUntil(30_000) { exists("home") }
        assumeTrue("the server speaks Sonus Connect v2", graph.link != null)
        waitFor(what = "the app connected to the session") { graph.link?.isConnected == true }
    }

    @After
    fun done() {
        desk?.let { runBlocking { it.close() } }
        instrumentation.runOnMainSync { graph.playback.pause() }
    }

    private fun exists(tag: String) = try {
        compose.onAllNodesWithTag(tag, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
    } catch (_: IllegalStateException) {
        false
    }

    /** Some text on screen says [text] (also while the app is not in front: false). */
    private fun shows(text: String) = try {
        compose.onAllNodesWithText(text, substring = true, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
    } catch (_: IllegalStateException) {
        false
    }

    private fun waitFor(timeoutMs: Long = 15_000, what: String, condition: () -> Boolean) {
        val until = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < until) {
            var ok = false
            instrumentation.runOnMainSync { ok = condition() }
            if (ok) return
            Thread.sleep(200)
        }
        throw AssertionError("timed out waiting for $what")
    }

    private fun shot(name: String) {
        val dir = InstrumentationRegistry.getArguments().getString("additionalTestOutputDir")?.let(::File) ?: context.getExternalFilesDir("screenshots")!!
        dir.mkdirs()
        val bitmap = instrumentation.uiAutomation.takeScreenshot() ?: return
        val kind = if (context.resources.configuration.smallestScreenWidthDp >= 600) "tablet" else "phone"
        File(dir, "$kind-$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private fun bringToFront() {
        context.startActivity(Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT))
        device.wait(Until.hasObject(By.pkg(context.packageName).depth(0)), 5_000)
        compose.waitForIdle()
    }

    @Test
    fun anotherDevicePlaysTheAppShowsAndSteersItThenTakesItOver() {
        // a computer of the same account joins and plays an album (rule 6: with no active device, the sender becomes it)
        val login = runBlocking { SubsonicClient.signIn(server, user, user, "Sonus (Test)", http) }
        val client = SubsonicClient(login, "Sonus (Test)", http)
        runBlocking { client.connect() }
        val other = SessionClient(client, "test-desk-0001", "测试电脑", "desktop", clientLabel = "Sonus test", http = http).also { desk = it }
        other.start()
        runBlocking { withTimeout(10_000) { other.connected.first { it } } }
        val session = (graph.state.value as AppState.Ready).session
        val album = session.lib.albums.first { it.title == "夜行列车" }
        val reply = runBlocking {
            other.command(
                "playContext",
                buildJsonObject {
                    putJsonObject("context") { put("kind", "album"); put("id", album.id); put("label", album.title) }
                    putJsonArray("ids") { album.trackIds.forEach { add(JsonPrimitive(it)) } }
                },
            )
        }
        assertThat(reply.ok).isTrue()
        val key = runBlocking { withTimeout(10_000) { other.session.first { it.activeDevice == "test-desk-0001" && it.current != null } } }.current!!.key
        runBlocking {
            other.report("loaded", key, 0, other.session.value.rev, durationMs = 180_000)
            other.report("playing", key, 0, other.session.value.rev)
        }

        // the app shows it, silent: the song, where it plays, the position moving
        waitFor(what = "the app shows the other device's playback") {
            graph.playback.elsewhere && graph.playback.state.value.trackId == album.trackIds[0] && graph.playback.state.value.status == PlayerStatus.Playing
        }
        var silent = false
        instrumentation.runOnMainSync { silent = !graph.playback.exo.isPlaying } // the player lives on the main thread
        assertThat(silent).isTrue()
        compose.waitUntil(10_000) { shows("正在「测试电脑」上播放") }
        shot("connect-01-elsewhere")

        // the system's media controls steer the computer (the user asked for these)
        val controller = MediaController.Builder(context, SessionToken(context, ComponentName(context, PlaybackService::class.java))).buildAsync().get(10, TimeUnit.SECONDS)
        var title: CharSequence? = null
        var playing = false
        instrumentation.runOnMainSync {
            title = controller.mediaMetadata.title
            playing = controller.isPlaying
        }
        assertThat(playing).isTrue()
        assertThat(title.toString()).isEqualTo(session.lib.track(album.trackIds[0])!!.title)
        device.pressHome()
        device.openNotification()
        assertThat(device.wait(Until.hasObject(By.text(title.toString())), 8_000)).isTrue()
        shot("connect-02-remote-notification")
        device.pressBack()
        instrumentation.runOnMainSync { controller.pause() }
        runBlocking { withTimeout(10_000) { other.session.first { !it.playing } } }
        instrumentation.runOnMainSync { controller.play() }
        runBlocking { withTimeout(10_000) { other.session.first { it.playing } } }
        instrumentation.runOnMainSync { controller.release() }

        // rule 8: the computer sets this device's volume, which is its media volume
        val audio = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        val max = audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
        val want = if (audio.getStreamVolume(AudioManager.STREAM_MUSIC) == max / 3) max * 2 / 3 else max / 3
        val volume = runBlocking { other.command("volume", buildJsonObject { put("device", graph.link!!.id); put("volume", want.toDouble() / max) }) }
        assertThat(volume.ok).isTrue()
        waitFor(what = "the media volume set from the other device") { audio.getStreamVolume(AudioManager.STREAM_MUSIC) == want }

        // back in the app: its own pause button pauses the computer
        bringToFront()
        compose.onNodeWithTag(if (exists("mini-play")) "mini-play" else "play-pause").performClick()
        runBlocking { withTimeout(10_000) { other.session.first { !it.playing } } }

        // the device list moves playback here (rule 4): this device plays, the computer is left (on the phone the list is
        // in the full player; on the tablet in the playback bar)
        if (exists("mini-player")) {
            compose.onNodeWithTag("mini-player").performClick()
            compose.waitUntil(5_000) { exists("full-player") }
        }
        compose.onNodeWithTag("devices").performClick()
        compose.waitUntil(5_000) { exists("devices-sheet") }
        Thread.sleep(600) // the sheet slides up
        shot("connect-03-devices")
        compose.onNodeWithTag("device-${graph.link!!.id}").performClick()
        runBlocking { withTimeout(10_000) { other.session.first { it.activeDevice == graph.link!!.id } } }
        waitFor(what = "this device active") { !graph.playback.elsewhere }
        instrumentation.runOnMainSync { graph.playback.resume() }
        waitFor(what = "playing here") { graph.playback.state.value.status == PlayerStatus.Playing && graph.playback.exo.isPlaying }
        runBlocking { withTimeout(10_000) { other.session.first { it.playing && it.activeDevice == graph.link!!.id } } }
        compose.waitUntil(5_000) { !exists("where") }
        shot("connect-04-here")
    }
}
