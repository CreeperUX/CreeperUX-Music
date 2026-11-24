package com.creeperux.sonus

import android.content.Context
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performTextReplacement
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.creeperux.sonus.core.Login
import com.creeperux.sonus.data.LoginStore
import com.creeperux.sonus.data.SecretBox
import com.creeperux.sonus.session.MusicSession
import com.creeperux.sonus.ui.Navigator
import com.creeperux.sonus.ui.Route
import com.creeperux.sonus.ui.Tab
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
