package com.creeperux.sonus.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Snackbar
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import com.creeperux.sonus.AppGraph
import com.creeperux.sonus.AppState
import com.creeperux.sonus.session.MusicSession
import com.creeperux.sonus.session.Toast
import com.creeperux.sonus.ui.components.PillButton
import com.creeperux.sonus.ui.icons.KitIcon
import com.creeperux.sonus.ui.screens.AlbumPage
import com.creeperux.sonus.ui.screens.ArtistPage
import com.creeperux.sonus.ui.screens.GenrePage
import com.creeperux.sonus.ui.screens.HomeScreen
import com.creeperux.sonus.ui.screens.LibraryList
import com.creeperux.sonus.ui.screens.LibraryRail
import com.creeperux.sonus.ui.screens.LibraryScreen
import com.creeperux.sonus.ui.screens.LyricsPage
import com.creeperux.sonus.ui.screens.PlaybackBar
import com.creeperux.sonus.ui.screens.PlaylistPage
import com.creeperux.sonus.ui.screens.RightPanel
import com.creeperux.sonus.ui.screens.SearchScreen
import com.creeperux.sonus.ui.screens.SettingsScreen
import com.creeperux.sonus.ui.screens.ShelfPage
import com.creeperux.sonus.ui.screens.SignInScreen
import com.creeperux.sonus.ui.screens.TabletTopBar
import com.creeperux.sonus.ui.theme.Shapes
import com.creeperux.sonus.ui.theme.Sonus
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.launch

/** The app: signing in, connecting, or the music. */
@Composable
fun SonusRoot(graph: AppGraph) {
    val state by graph.state.collectAsState()
    val c = Sonus.colors
    // test tags double as resource ids, so UiAutomator (instrumented tests, adb) finds the same elements
    Box(Modifier.fillMaxSize().background(c.window).semantics { testTagsAsResourceId = true }) {
        AnimatedContent(state::class, transitionSpec = { fadeIn(tween(180)) togetherWith fadeOut(tween(120)) }, label = "app") { _ ->
            when (val s = graph.state.collectAsState().value) {
                AppState.Starting -> Box(Modifier.fillMaxSize())
                is AppState.SignedOut -> SignInScreen(graph, s.message)
                is AppState.Connecting -> Waiting("正在载入媒体库…")
                is AppState.Failed -> Failed(s.message, { graph.connect(s.login) }, graph::signOut)
                is AppState.Ready -> Main(graph, s.session)
            }
        }
    }
}

@Composable
private fun Waiting(text: String) {
    val c = Sonus.colors
    Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        CircularProgressIndicator(color = c.accent, strokeWidth = 3.dp, modifier = Modifier.size(36.dp))
        Spacer(Modifier.height(16.dp))
        Text(text, style = Sonus.type.body, color = c.textMuted, modifier = Modifier.testTag("waiting"))
    }
}

@Composable
private fun Failed(message: String, retry: () -> Unit, signOut: () -> Unit) {
    val c = Sonus.colors
    Column(
        Modifier.fillMaxSize().systemBarsPadding().padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center,
    ) {
        KitIcon("offline", size = 36.dp, tint = c.textQuiet)
        Spacer(Modifier.height(16.dp))
        Text("无法连接到音乐服务器", style = Sonus.type.section, color = c.text)
        Spacer(Modifier.height(8.dp))
        Text(message, style = Sonus.type.body, color = c.textMuted, textAlign = TextAlign.Center)
        Spacer(Modifier.height(24.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            PillButton("重试", retry, primary = true, icon = "refresh")
            PillButton("退出登录", signOut)
        }
    }
}

/** Signed in: the phone's tabs, or the tablet's panels, as wide as the window allows. */
@Composable
private fun Main(graph: AppGraph, session: MusicSession) {
    val nav = remember(session) { Navigator() }
    val snackbar = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    LaunchedEffect(session) {
        session.toast.collect { t -> scope.launch { show(snackbar, t) } }
    }
    // the daily check found a newer version: said once (the dot on 设置 stays while it waits), by this shell itself and
    // taken as said once it has been on screen: a shell that goes away while saying it (the one fading out as the app
    // connects, as both are composed for a moment) leaves it to the one that stays
    LaunchedEffect(session) {
        graph.updater.announce.filterNotNull().collect { r ->
            val result = snackbar.showSnackbar("Sonus ${r.displayVersion.substringBefore('-')} 可以更新了", "查看", duration = SnackbarDuration.Long)
            graph.updater.announced(r)
            if (result == SnackbarResult.ActionPerformed) nav.go(Route.Settings)
        }
    }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { scope.launch { session.onActivated() } }
    CompositionLocalProvider(LocalGraph provides graph, LocalSession provides session, LocalPlayer provides graph.playback, LocalNav provides nav, LocalMotion provides rememberMotionEnabled()) {
        BackHandler(nav.canGoBack) { nav.back() }
        BoxWithConstraints(Modifier.fillMaxSize()) {
            val layout = when {
                maxWidth < 600.dp -> Layout.Phone
                maxWidth < 860.dp -> Layout.TabletNarrow
                maxWidth < 1100.dp -> Layout.Tablet
                else -> Layout.TabletWide
            }
            CompositionLocalProvider(LocalLayout provides layout) {
                if (layout == Layout.Phone) PhoneShell(nav) else TabletShell(nav, layout)
                // above the mini player and the tabs; over the cover while the phone's full player is open, so a message
                // never covers the player's song, position or buttons
                val overPlayer = layout == Layout.Phone && nav.playerOpen.value
                SnackbarHost(
                    snackbar,
                    if (overPlayer) {
                        Modifier.align(Alignment.TopCenter).statusBarsPadding().padding(top = 72.dp).widthIn(max = 420.dp)
                    } else {
                        Modifier.align(if (layout == Layout.Phone) Alignment.BottomCenter else Alignment.BottomEnd)
                            .navigationBarsPadding()
                            .padding(bottom = if (layout == Layout.Phone) 140.dp else 104.dp, end = if (layout == Layout.Phone) 0.dp else 16.dp)
                            .widthIn(max = 420.dp)
                    },
                ) { data ->
                    val c = Sonus.colors
                    Snackbar(data, shape = RoundedCornerShape(7.dp), containerColor = c.toast, contentColor = Sonus.colors.text.takeIf { c.isDark } ?: androidx.compose.ui.graphics.Color(0xFFF4F1EB), actionColor = c.accent)
                }
            }
        }
    }
}

private suspend fun show(host: SnackbarHostState, t: Toast) {
    val result = host.showSnackbar(t.text, t.actionLabel, withDismissAction = false, duration = if (t.actionLabel != null) SnackbarDuration.Long else SnackbarDuration.Short)
    if (result == SnackbarResult.ActionPerformed) t.action?.invoke()
}

/** A page by its route. */
@Composable
fun Page(route: Route) {
    when (route) {
        Route.Home -> HomeScreen()
        Route.Search -> SearchScreen()
        Route.Library -> LibraryScreen()
        Route.Settings -> SettingsScreen()
        Route.Lyrics -> LyricsPage()
        is Route.Album -> AlbumPage(route.id)
        is Route.Artist -> ArtistPage(route.id)
        is Route.Playlist -> PlaylistPage(route.id)
        is Route.Genre -> GenrePage(route.name)
        is Route.Shelf -> ShelfPage(route.key)
    }
}

/** The phone's tabs: Material 3's NavigationBar, in the Sonus colours (the selected tab on the raised colour). */
@Composable
internal fun PhoneTabs(nav: Navigator) {
    val c = Sonus.colors
    NavigationBar(containerColor = c.window, tonalElevation = 0.dp, modifier = Modifier.height(80.dp + WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding())) {
        Tab.entries.forEach { t ->
            NavigationBarItem(
                selected = nav.tab.value == t,
                onClick = { nav.selectTab(t) },
                icon = { KitIcon(t.icon, size = 20.dp, tint = LocalContentColor.current) },
                label = { Text(t.label, style = Sonus.type.caption) },
                modifier = Modifier.testTag("tab-${t.name}"),
                colors = NavigationBarItemDefaults.colors(
                    selectedIconColor = c.text, selectedTextColor = c.text, indicatorColor = c.raised,
                    unselectedIconColor = c.textQuiet, unselectedTextColor = c.textQuiet,
                ),
            )
        }
    }
}

/**
 * The tablet, as the Windows window (MainWindow.xaml): a top bar; the library, the page and the right panel side by
 * side, 8 dp apart on the window colour; the playback bar along the bottom. Below 860 dp the library is a rail of
 * covers, below 1100 dp the right panel closes.
 */
@Composable
private fun TabletShell(nav: Navigator, layout: Layout) {
    val c = Sonus.colors
    Column(Modifier.fillMaxSize().background(c.window).systemBarsPadding()) {
        TabletTopBar()
        Row(Modifier.weight(1f).fillMaxWidth().padding(horizontal = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            val panelShape = RoundedCornerShape(Shapes.panel)
            Box(Modifier.width(if (layout == Layout.TabletNarrow) 80.dp else 300.dp).fillMaxHeight().clip(panelShape).background(c.panel)) {
                if (layout == Layout.TabletNarrow) LibraryRail() else LibraryList(pane = true)
            }
            Box(Modifier.weight(1f).fillMaxHeight().clip(panelShape).background(c.panel)) {
                PageHost(nav, Modifier.fillMaxSize())
            }
            if (layout == Layout.TabletWide && nav.panelOpen.value) {
                Box(Modifier.width(340.dp).fillMaxHeight().clip(panelShape).background(c.panel)) { RightPanel() }
            }
        }
        PlaybackBar()
    }
}

/** A small round dot: green while the server answers, red when it does not. */
@Composable
fun OnlineDot(online: Boolean) {
    val c = Sonus.colors
    Box(Modifier.size(8.dp).clip(CircleShape).background(if (online) c.good else c.bad))
}

/** Pages put this at their top on the phone (the status bar), nothing on the tablet. */
@Composable
fun Modifier.pageTop(): Modifier = if (LocalLayout.current == Layout.Phone) this.statusBarsPadding() else this
