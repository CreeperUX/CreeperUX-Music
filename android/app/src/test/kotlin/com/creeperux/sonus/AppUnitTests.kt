package com.creeperux.sonus

import android.content.Context
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeDown
import androidx.compose.ui.test.swipeLeft
import androidx.compose.ui.test.swipeRight
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.creeperux.sonus.core.Login
import com.creeperux.sonus.core.SubsonicClient
import com.creeperux.sonus.data.LoginStore
import com.creeperux.sonus.data.SecretBox
import com.creeperux.sonus.session.MusicSession
import com.creeperux.sonus.ui.Haptics
import com.creeperux.sonus.ui.HorizontalDragHandler
import com.creeperux.sonus.ui.Navigator
import com.creeperux.sonus.ui.Route
import com.creeperux.sonus.ui.SonusRootTransition
import com.creeperux.sonus.ui.Tab
import com.creeperux.sonus.ui.TrackSwipeController
import com.creeperux.sonus.ui.VerticalDragHandler
import com.creeperux.sonus.ui.directionalDrag
import com.creeperux.sonus.ui.screens.SignInScreen
import com.creeperux.sonus.ui.theme.SonusTheme
import com.google.common.truth.Truth.assertThat
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.spec.GCMParameterSpec

/** AES-GCM with a key in memory: the Keystore's stand-in on the JVM (Robolectric has no Android Keystore). */
private class MemoryBox : SecretBox {
    private val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
    override fun seal(plain: ByteArray): ByteArray {
        val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key) }
        return c.iv + c.doFinal(plain)
    }
    override fun open(sealed: ByteArray): ByteArray =
        Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, sealed, 0, 12)) }.doFinal(sealed, 12, sealed.size - 12)
}

@RunWith(AndroidJUnit4::class)
class LoginStoreTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()

    @Test
    fun keepsTheSignInSealedAndNeverInPlainText() {
        val prefs = context.getSharedPreferences("test-sign-in", Context.MODE_PRIVATE)
        val store = LoginStore(prefs, MemoryBox())
        val login = Login("http://nas:4533", "alice", "a1b2c3", "0123456789abcdef0123456789abcdef")
        store.save(login)
        assertThat(store.load()).isEqualTo(login)
        val raw = prefs.all.values.joinToString()
        assertThat(raw).doesNotContain(login.token)
        assertThat(raw).doesNotContain("alice")
        store.clear()
        assertThat(store.load()).isNull()
    }

    @Test
    fun anApiKeyIsKeptTheSameWay() {
        val prefs = context.getSharedPreferences("test-sign-in-2", Context.MODE_PRIVATE)
        val store = LoginStore(prefs, MemoryBox())
        val login = Login.withApiKey("https://music.example.com", "alice", "the-api-key")
        store.save(login)
        assertThat(store.load()).isEqualTo(login)
        assertThat(prefs.all.values.joinToString()).doesNotContain("the-api-key")
    }

    @Test
    fun aSignInSealedWithAnotherKeyIsForgottenNotACrash() {
        val prefs = context.getSharedPreferences("test-sign-in-3", Context.MODE_PRIVATE)
        LoginStore(prefs, MemoryBox()).save(Login("http://h", "u", "s", "t"))
        assertThat(LoginStore(prefs, MemoryBox()).load()).isNull() // the Keystore key was reset, or a backup restored elsewhere
    }
}

class NavigatorTest {
    @Test
    fun backPopsThePageThenGoesHomeThenLeaves() {
        val nav = Navigator()
        nav.go(Route.Album("a1"))
        nav.go(Route.Artist("ar1"))
        assertThat(nav.current).isEqualTo(Route.Artist("ar1"))
        assertThat(nav.back()).isTrue()
        assertThat(nav.current).isEqualTo(Route.Album("a1"))
        nav.go(Route.Search)
        assertThat(nav.tab.value).isEqualTo(Tab.Search)
        assertThat(nav.back()).isTrue() // the search tab's first page: back to home
        assertThat(nav.tab.value).isEqualTo(Tab.Home)
        assertThat(nav.current).isEqualTo(Route.Album("a1")) // each tab keeps its pages
        assertThat(nav.back()).isTrue()
        assertThat(nav.back()).isFalse() // the system leaves the app
    }

    @Test
    fun theFullPlayerClosesFirstAndItsViewsBeforeIt() {
        val nav = Navigator()
        nav.playerOpen.value = true
        nav.playerView.value = com.creeperux.sonus.ui.PlayerView.Lyrics
        assertThat(nav.back()).isTrue()
        assertThat(nav.playerOpen.value).isTrue()
        assertThat(nav.back()).isTrue()
        assertThat(nav.playerOpen.value).isFalse()
    }

    @Test
    fun tappingTheTabAgainGoesBackToItsFirstPage() {
        val nav = Navigator()
        nav.go(Route.Album("a1"))
        nav.go(Route.Album("a2"))
        nav.selectTab(Tab.Home)
        assertThat(nav.stack).containsExactly(Route.Home)
    }
}

class CoverSizeTest {
    @Test
    fun coversAreAskedForAtTheWindowsAppsSizes() {
        // on-screen pixels rounded up to 64, 128, 256, 512 or 1024 (Covers.cs)
        assertThat(MusicSession.coverSize(40)).isEqualTo(64)
        assertThat(MusicSession.coverSize(105)).isEqualTo(128)
        assertThat(MusicSession.coverSize(147)).isEqualTo(256)
        assertThat(MusicSession.coverSize(578)).isEqualTo(1024)
        assertThat(MusicSession.coverSize(4000)).isEqualTo(1024)
    }
}

@RunWith(AndroidJUnit4::class)
class SignInScreenTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun warnsBeforePlainHttpToTheInternetOnly() {
        val graph = AppGraph(ApplicationProvider.getApplicationContext())
        compose.setContent { SonusTheme { SignInScreen(graph, null) } }
        compose.onNodeWithText("连接你的音乐服务器").assertIsDisplayed()
        compose.onNodeWithTag("server").performTextReplacement("http://music.example.com")
        compose.onNodeWithText("这是互联网上的 HTTP 地址", substring = true).assertIsDisplayed()
        compose.onNodeWithTag("server").performTextReplacement("192.168.1.10:4533")
        compose.onNodeWithText("这是互联网上的 HTTP 地址", substring = true).assertDoesNotExist()
    }

    @Test
    fun showsWhyTheKeptSignInWasDropped() {
        val graph = AppGraph(ApplicationProvider.getApplicationContext())
        compose.setContent { SonusTheme { SignInScreen(graph, "这次登录已被撤销，请重新登录。") } }
        compose.onNodeWithTag("signin-error").assertExists() // below the fold on Robolectric's small default screen
        compose.onNodeWithText("这次登录已被撤销，请重新登录。").assertExists()
    }
}

@RunWith(AndroidJUnit4::class)
class TrackSwipeUiTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun directionalDragLocksAxisAndPreservesTap() {
        var taps = 0
        var hEnds = 0
        var vEnds = 0
        val h = object : HorizontalDragHandler {
            override fun onStart() {}
            override fun onDrag(deltaXFromStart: Float) {}
            override fun onEnd(velocityX: Float) { hEnds++ }
            override fun onCancel() {}
        }
        val v = object : VerticalDragHandler {
            override fun onStart(screenY: Float) {}
            override fun onDrag(screenY: Float) {}
            override fun onEnd(velocityY: Float) { vEnds++ }
            override fun onCancel() {}
        }
        compose.setContent {
            Box(Modifier.size(200.dp).directionalDrag(vertical = v, horizontal = h).clickable { taps++ }.testTag("pad"))
        }
        compose.onNodeWithTag("pad").performClick()
        assertThat(taps).isEqualTo(1)
        assertThat(hEnds).isEqualTo(0)
        assertThat(vEnds).isEqualTo(0)

        compose.onNodeWithTag("pad").performTouchInput { swipeLeft(startX = 180f, endX = 20f) }
        assertThat(hEnds).isEqualTo(1)
        assertThat(vEnds).isEqualTo(0)
        assertThat(taps).isEqualTo(1)

        compose.onNodeWithTag("pad").performTouchInput { swipeDown(startY = 20f, endY = 180f) }
        assertThat(vEnds).isEqualTo(1)
        assertThat(hEnds).isEqualTo(1)
        assertThat(taps).isEqualTo(1)
    }

    @Test
    fun systemCancelAfterHorizontalLockIsACancelNotARelease() {
        val calls = mutableListOf<String>()
        val h = object : HorizontalDragHandler {
            override fun onStart() { calls += "start" }
            override fun onDrag(deltaXFromStart: Float) {}
            override fun onEnd(velocityX: Float) { calls += "end(${velocityX.toInt()})" }
            override fun onCancel() { calls += "cancel" }
        }
        compose.setContent { Box(Modifier.size(300.dp).directionalDrag(horizontal = h).testTag("pad")) }
        // a quick flick from the left edge that the system then claims (pilferPointers -> ACTION_CANCEL)
        compose.onNodeWithTag("pad").performTouchInput {
            down(Offset(2f, 150f))
            moveBy(Offset(40f, 0f), delayMillis = 16)
            moveBy(Offset(40f, 0f), delayMillis = 16)
            cancel(delayMillis = 16)
        }
        compose.waitForIdle()
        assertThat(calls).containsExactly("start", "cancel").inOrder()
    }

    @Test
    fun systemCancelAfterVerticalLockIsACancelNotARelease() {
        val calls = mutableListOf<String>()
        val v = object : VerticalDragHandler {
            override fun onStart(screenY: Float) { calls += "start" }
            override fun onDrag(screenY: Float) {}
            override fun onEnd(velocityY: Float) { calls += "end(${velocityY.toInt()})" }
            override fun onCancel() { calls += "cancel" }
        }
        compose.setContent { Box(Modifier.size(300.dp).directionalDrag(vertical = v).testTag("pad")) }
        compose.onNodeWithTag("pad").performTouchInput {
            down(Offset(150f, 20f))
            moveBy(Offset(0f, 40f), delayMillis = 16)
            moveBy(Offset(0f, 40f), delayMillis = 16)
            cancel(delayMillis = 16)
        }
        compose.waitForIdle()
        assertThat(calls).containsExactly("start", "cancel").inOrder()
    }

    @Test
    fun trackSwipeSkipsRespectsBoundariesAndHandlesReducedMotion() {
        var nexts = 0
        var prevs = 0
        var track = "t1"
        var canNext = true
        var canPrev = false
        var motion = true
        lateinit var controller: TrackSwipeController
        compose.setContent {
            val scope = rememberCoroutineScope()
            controller = TrackSwipeController(
                scope = scope,
                flickPxPerSec = 700f,
                haptics = Haptics {},
                motionEnabled = { motion },
                canSkipNext = { canNext },
                canSkipPrevious = { canPrev },
                currentTrackId = { track },
                onSkipNext = { nexts++; track = "t2"; canPrev = true },
                onSkipPrevious = { prevs++; track = "t1"; canPrev = false },
            ).apply { stridePx = 200f }
            Box(Modifier.size(200.dp).directionalDrag(horizontal = controller).testTag("swipe"))
        }
        // at the first track (canPrev = false): swiping right rubber-bands and does not skip
        compose.onNodeWithTag("swipe").performTouchInput { swipeRight(startX = 20f, endX = 180f) }
        compose.waitForIdle()
        assertThat(prevs).isEqualTo(0)
        assertThat(controller.offset.value).isWithin(0.5f).of(0f)

        // swiping left advances to next track
        compose.onNodeWithTag("swipe").performTouchInput { swipeLeft(startX = 180f, endX = 20f) }
        compose.waitForIdle()
        assertThat(nexts).isEqualTo(1)
        assertThat(track).isEqualTo("t2")

        // with animations disabled (Remove animations), swiping right still skips straight back immediately
        motion = false
        compose.onNodeWithTag("swipe").performTouchInput { swipeRight(startX = 20f, endX = 180f) }
        compose.waitForIdle()
        assertThat(prevs).isEqualTo(1)
        assertThat(track).isEqualTo("t1")
        assertThat(controller.offset.value).isWithin(0.5f).of(0f)
    }

    @Test
    fun rubberBandIsBoundedAndMonotonic() {
        val small = TrackSwipeController.rubberBand(20f, 50f)
        val large = TrackSwipeController.rubberBand(500f, 50f)
        assertThat(small).isGreaterThan(0f)
        assertThat(small).isLessThan(large)
        assertThat(large).isLessThan(50f)
        assertThat(TrackSwipeController.rubberBand(-500f, 50f)).isEqualTo(-large)
    }

    @Test
    fun drawPhaseReadsAvoidRecompositionDuringDragAndSnapOffsetSynchronouslyOnHandoff() {
        var recompositions = 0
        var remoteTrack = "t1"
        lateinit var controller: TrackSwipeController
        compose.mainClock.autoAdvance = false
        compose.setContent {
            val scope = rememberCoroutineScope()
            controller = androidx.compose.runtime.remember {
                TrackSwipeController(
                    scope = scope,
                    flickPxPerSec = 700f,
                    haptics = Haptics {},
                    motionEnabled = { true },
                    canSkipNext = { true },
                    canSkipPrevious = { false },
                    currentTrackId = { remoteTrack },
                    // simulate Connect v2: onSkipNext does not mutate trackId synchronously
                    onSkipNext = {},
                    onSkipPrevious = {},
                ).apply { stridePx = 200f }
            }
            recompositions++
            Box(
                Modifier
                    .size(200.dp)
                    .directionalDrag(horizontal = controller)
                    .graphicsLayer { translationX = controller.visualOffset(remoteTrack) }
                    .testTag("drag-box"),
            )
        }
        compose.mainClock.advanceTimeByFrame()
        val initial = recompositions
        // dragging and settling must not recompose when offset/dragging are read in graphicsLayer
        compose.onNodeWithTag("drag-box").performTouchInput {
            down(Offset(180f, 100f))
            moveBy(Offset(-30f, 0f), delayMillis = 16)
            moveBy(Offset(-30f, 0f), delayMillis = 16)
            moveBy(Offset(-30f, 0f), delayMillis = 16)
            advanceEventTime(16)
            up()
        }
        // advance past the ~200 ms settle animation, before the 1500 ms offline fallback
        compose.mainClock.advanceTimeBy(400)
        assertThat(recompositions).isEqualTo(initial)
        // offset is held at -stride while waiting for Connect v2 server reply; the instant trackId flips to "t2",
        // visualOffset("t2") and isSwipedInto("t2") must already be 0f / true BEFORE onTrackChanged runs
        assertThat(controller.visualOffset("t1")).isWithin(1f).of(-200f)
        assertThat(controller.visualOffset("t2")).isWithin(0.1f).of(0f)
        assertThat(controller.isSwipedInto("t2")).isTrue()
    }

    @Test
    fun sonusRootTransitionRendersEachSlotFromItsOwnTargetState() {
        val login = Login("http://127.0.0.1:4633", "demo", "s", "t")
        val session = MusicSession(SubsonicClient(login, "Sonus (Test)"))
        var state by mutableStateOf<AppState>(AppState.Connecting(login))
        var activeMainCount = 0
        var maxConcurrentMain = 0
        var activeWaitingCount = 0
        compose.mainClock.autoAdvance = false
        compose.setContent {
            SonusRootTransition(state) { s ->
                when (s) {
                    is AppState.Ready -> {
                        DisposableEffect(s.session) {
                            activeMainCount++
                            if (activeMainCount > maxConcurrentMain) maxConcurrentMain = activeMainCount
                            onDispose { activeMainCount-- }
                        }
                        Box(Modifier.size(10.dp).testTag("main"))
                    }
                    else -> {
                        DisposableEffect(Unit) {
                            activeWaitingCount++
                            onDispose { activeWaitingCount-- }
                        }
                        Box(Modifier.size(10.dp).testTag("waiting"))
                    }
                }
            }
        }
        compose.mainClock.advanceTimeByFrame()
        assertThat(activeWaitingCount).isEqualTo(1)
        assertThat(activeMainCount).isEqualTo(0)

        compose.runOnUiThread {
            state = AppState.Ready(session)
            Snapshot.sendApplyNotifications()
        }
        // mid-transition while both slots are composed: exiting slot stays Waiting and only entering slot is Main
        compose.mainClock.advanceTimeBy(60)
        assertThat(activeWaitingCount).isEqualTo(1)
        assertThat(activeMainCount).isEqualTo(1)
        assertThat(maxConcurrentMain).isEqualTo(1)

        // after fade completes: only Main remains and never more than one Main existed concurrently
        compose.mainClock.advanceTimeBy(300)
        assertThat(activeWaitingCount).isEqualTo(0)
        assertThat(activeMainCount).isEqualTo(1)
        assertThat(maxConcurrentMain).isEqualTo(1)
    }
}
