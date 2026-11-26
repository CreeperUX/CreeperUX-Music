package com.creeperux.sonus

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.view.KeyEvent
import androidx.compose.ui.test.SemanticsNodeInteractionCollection
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
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
import com.creeperux.sonus.core.SubsonicException
import com.creeperux.sonus.playback.PlaybackService
import com.creeperux.sonus.playback.PlayerStatus
import com.google.common.truth.Truth.assertThat
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assume.assumeTrue
import okhttp3.OkHttpClient
import okhttp3.Request
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * The app on a device against the demo server (tools/demo-server, account demo/demo) or a Sonus server (TestServer), with
 * no one at the screen: it signs in, browses, plays, keeps playing in the background, answers the notification and
 * headset keys, scrobbles, shows lyrics, and signs in through the browser (also with two-step verification on, where the
 * password alone does not sign in). The server is the PC's, at the address the instrumentation argument sonusServer
 * gives (tools/test-device.ps1 forwards it with adb reverse). Screenshots go to the additional test output, which Gradle
 * copies to app/build/outputs/connected_android_test_additional_output.
 */
@RunWith(AndroidJUnit4::class)
class DeviceTest {
    @get:Rule
    val compose = createAndroidComposeRule<MainActivity>()

    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context: Context get() = instrumentation.targetContext
    private val graph: AppGraph get() = (context.applicationContext as SonusApp).graph
    private val device: UiDevice = UiDevice.getInstance(instrumentation)
    private val server = TestServer.url
    private val http = OkHttpClient.Builder().readTimeout(10, TimeUnit.SECONDS).build()

    /** The account: the tests run on the phone and the tablet at once, and one account is one playback session (Sonus
     *  Connect v2), so the tablet uses another account. */
    private val user: String get() = TestServer.user(context)
    private val password: String get() = TestServer.password(context)

    @Before
    fun signedOut() {
        instrumentation.runOnMainSync { graph.signOut() }
        compose.waitUntil(20_000) { exists("signin") }
    }

    // ---------------------------------------------------------------- helpers

    private fun nodes(tag: String): SemanticsNodeInteractionCollection = compose.onAllNodesWithTag(tag, useUnmergedTree = true)
    /** False also while the app is not on screen (a browser over it: no Compose hierarchy to look in). */
    private fun exists(tag: String) = try {
        nodes(tag).fetchSemanticsNodes().isNotEmpty()
    } catch (_: IllegalStateException) {
        false
    }
    private fun state() = graph.playback.state.value

    private fun get(path: String): String = http.newCall(Request.Builder().url("$server$path").build()).execute().use { it.body.string() }

    /** The scrobbles the server saw: the demo server's record of them, (song id, submission) pairs; on another server
     *  "now playing" from getNowPlaying, and a counted play from the song's play count having gone up. */
    private fun scrobbles(): List<Pair<String, Boolean>> = if (TestServer.isDemo) {
        entries("scrobbles").map { it["id"]!!.jsonPrimitive.content to it["submission"]!!.jsonPrimitive.boolean }
    } else {
        val now = TestServer.api(user, password, "getNowPlaying")["nowPlaying"]?.jsonObject?.get("entry")?.jsonArray.orEmpty()
            .filter { it.jsonObject["username"]?.jsonPrimitive?.content == user }.map { it.jsonObject["id"]!!.jsonPrimitive.content to false }
        now + counted.filter { (id, before) -> playCount(id) > before }.map { (id, _) -> id to true }
    }
    private val counted = mutableMapOf<String, Int>() // song id → its play count before it played (another server)
    private fun playCount(id: String): Int = TestServer.api(user, password, "getSong", "id" to id)["song"]?.jsonObject?.get("playCount")?.jsonPrimitive?.int ?: 0
    private fun streams(): List<String> = entries("streams").map { it["id"]!!.jsonPrimitive.content }
    private fun entries(key: String) = (Json.parseToJsonElement(get("/__test/log")) as JsonObject)[key]!!.jsonArray.map { it.jsonObject }

    /** Waits (off the main thread) for something the server sees. */
    private fun eventually(timeoutMs: Long = 10_000, condition: () -> Boolean): Boolean {
        val until = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < until) {
            if (condition()) return true
            Thread.sleep(300)
        }
        return condition()
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

    private fun signIn(user: String = this.user, password: String = this.password) {
        compose.onNodeWithTag("server").performTextReplacement(server)
        compose.onNodeWithTag("user").performTextReplacement(user)
        compose.onNodeWithTag("password").performTextReplacement(password)
        compose.onNodeWithTag("signin").performClick()
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

    // ---------------------------------------------------------------- the tests

    @Test
    fun aWrongPasswordIsSaidSo() {
        signIn(password = "not-the-password")
        compose.waitUntil(15_000) { exists("signin-error") }
        compose.onNodeWithTag("signin-error").assertExists()
        assertThat(compose.onAllNodesWithText("用户名或密码不正确。", substring = true).fetchSemanticsNodes()).isNotEmpty()
        assertThat(compose.onAllNodesWithText("在浏览器中登录”", substring = true).fetchSemanticsNodes()).isNotEmpty() // the way with two-step verification
        assertThat(graph.logins.load()).isNull()
    }

    @Test
    fun signsInBrowsesAndPlaysInTheBackground() {
        signIn()
        compose.waitUntil(30_000) { exists("home") }
        assertThat(graph.logins.load()!!.token).isNotEmpty()
        shot("01-home")

        // an album, from the home page's quick tiles or shelves
        val session = (graph.state.value as AppState.Ready).session
        val album = TestServer.playableAlbum(session.lib)
        if (!TestServer.isDemo) counted[album.trackIds[0]] = playCount(album.trackIds[0])
        compose.onAllNodesWithText(album.title)[0].performClick()
        compose.waitUntil(10_000) { exists("album-page") }
        shot("02-album")

        // a tap plays the album from that song
        nodes("track-row")[0].performClick()
        val first = album.trackIds[0]
        waitFor(what = "playing") { state().status == PlayerStatus.Playing && state().trackId == first }
        // the player shows it: the phone's mini player, the tablet's playback bar
        val song = session.lib.track(first)!!.title
        val bar = if (exists("mini-player")) "mini-player" else "playback-bar"
        compose.waitUntil(10_000) {
            compose.onAllNodes(hasText(song) and hasAnyAncestor(hasTestTag(bar)), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
        }
        shot("03-playing")
        assertThat(eventually { (first to false) in scrobbles() }).isTrue() // "now playing"
        if (TestServer.isDemo) assertThat(streams()).contains(first)

        // past half the song the play counts (Scrobbling.counts), as on Windows
        instrumentation.runOnMainSync { graph.playback.seek(state().duration / 2 + 1) }
        assertThat(eventually { (first to true) in scrobbles() }).isTrue()

        // in the background the music goes on, and the system's media session says so
        device.pressHome()
        var before = 0.0
        instrumentation.runOnMainSync { before = graph.playback.position.value }
        Thread.sleep(5_000)
        waitFor(what = "still playing in the background") { state().status == PlayerStatus.Playing && graph.playback.position.value > before + 3 }
        val controller = MediaController.Builder(context, SessionToken(context, ComponentName(context, PlaybackService::class.java))).buildAsync().get(10, TimeUnit.SECONDS)
        var title: CharSequence? = null
        var playing = false
        instrumentation.runOnMainSync {
            title = controller.mediaMetadata.title
            playing = controller.isPlaying
        }
        assertThat(playing).isTrue()
        assertThat(title.toString()).isEqualTo(session.lib.track(first)!!.title)

        // the notification shows the song
        device.openNotification()
        assertThat(device.wait(Until.hasObject(By.text(title.toString())), 8_000)).isTrue()
        shot("04-notification")
        device.pressBack()

        // headset and notification keys go through the queue
        device.pressKeyCode(KeyEvent.KEYCODE_MEDIA_NEXT)
        waitFor(what = "the next song") { state().trackId == album.trackIds[1] }
        device.pressKeyCode(KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE)
        waitFor(what = "paused") { state().status == PlayerStatus.Paused }
        device.pressKeyCode(KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE)
        waitFor(what = "playing again") { state().status == PlayerStatus.Playing }
        instrumentation.runOnMainSync { controller.release() }

        // back in the app: synced lyrics follow the song
        bringToFront()
        instrumentation.runOnMainSync { graph.playback.seek(40.0) }
        if (exists("mini-player")) {
            compose.onNodeWithTag("mini-player").performClick()
            compose.waitUntil(5_000) { exists("full-player") }
            shot("05-player")
            compose.onNodeWithTag("show-lyrics").performClick()
        } else {
            compose.onNodeWithContentDescription("歌词").performClick() // the tablet's playback bar
        }
        compose.waitUntil(10_000) { exists("lyric-now") }
        shot("06-lyrics")
        instrumentation.runOnMainSync { graph.playback.pause() }
    }

    @Test
    fun browserSignInGetsAKeyOfItsOwnAndSigningOutGivesItBack() {
        compose.onNodeWithTag("server").performTextReplacement(server)
        compose.onNodeWithTag("signin-browser").performClick()
        // the approval page opens in a browser over the app; the app shows the code to compare
        Thread.sleep(3_000)
        bringToFront()
        compose.waitUntil(15_000) { exists("user-code") }
        shot("07-browser-sign-in")
        val code = compose.onAllNodes(hasTestTag("user-code"))[0].fetchSemanticsNode().config[SemanticsProperties.Text].joinToString("") { it.text }
        // the user allows the app on the server's page (the demo server's test hook stands for it; on another server the
        // page's own requests: signing in there, then allowing the code)
        if (TestServer.isDemo) assertThat(get("/__test/device?code=$code&decide=allow&u=$user")).contains("\"decided\":true")
        else assertThat(TestServer.approve(code, user, password)).isTrue()
        bringToFront()
        compose.waitUntil(30_000) { exists("home") }
        val login = graph.logins.load()!!
        assertThat(login.isApiKey).isTrue()
        val prefs = context.getSharedPreferences("sign-in", Context.MODE_PRIVATE).all.values.joinToString()
        assertThat(prefs).doesNotContain(login.apiKey!!) // sealed with the Keystore key
        val client = SubsonicClient(login, "Sonus (Test)", http)
        runBlocking { client.connect() }

        // signing out gives the key back: the server refuses it at once
        instrumentation.runOnMainSync { graph.signOut() }
        compose.waitUntil(10_000) { exists("signin") }
        val refused = eventually { runCatching { runBlocking { client.connect() } }.exceptionOrNull().let { it is SubsonicException && it.isAuthentication } }
        assertThat(refused).isTrue()
    }

    /**
     * With two-step verification on, the account password alone signs no app in (the server answers as for a wrong
     * password): the app says so and points at the browser sign-in, which works (the server's page asks for the
     * authenticator's code). A Sonus server only, and the phone only (one authenticator code is used once).
     */
    @Test
    fun withTwoStepVerificationTheBrowserSignInIsTheWay() {
        val (twoStepUser, twoStepPassword, secret) = TestServer.twoStep ?: run { assumeTrue("a server with a two-step user", false); return }
        assumeTrue("on the phone", context.resources.configuration.smallestScreenWidthDp < 600)
        signIn(twoStepUser, twoStepPassword)
        compose.waitUntil(15_000) { exists("signin-error") }
        assertThat(compose.onAllNodesWithText("二步验证", substring = true).fetchSemanticsNodes()).isNotEmpty()
        assertThat(graph.logins.load()).isNull()
        shot("08-two-step-password")

        compose.onNodeWithTag("signin-browser").performClick()
        Thread.sleep(3_000)
        bringToFront()
        compose.waitUntil(15_000) { exists("user-code") }
        val code = compose.onAllNodes(hasTestTag("user-code"))[0].fetchSemanticsNode().config[SemanticsProperties.Text].joinToString("") { it.text }
        assertThat(TestServer.approve(code, twoStepUser, twoStepPassword, secret)).isTrue()
        bringToFront()
        compose.waitUntil(30_000) { exists("home") }
        assertThat(graph.logins.load()!!.isApiKey).isTrue()
        shot("09-two-step-browser-signed-in")
        instrumentation.runOnMainSync { graph.signOut() }
        compose.waitUntil(10_000) { exists("signin") }
    }
}

