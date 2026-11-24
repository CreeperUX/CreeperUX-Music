package com.creeperux.sonus.ui

import androidx.compose.runtime.Stable
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.staticCompositionLocalOf
import com.creeperux.sonus.AppGraph
import com.creeperux.sonus.playback.LocalPlayback
import com.creeperux.sonus.session.MusicSession

/** The pages, as the Windows app's routes (home, album:id, playlist:id, artist:id, search:q, genre:g, shelf:x …). */
sealed interface Route {
    data object Home : Route
    data object Search : Route
    data object Library : Route
    data object Settings : Route
    data object Lyrics : Route
    data class Album(val id: String) : Route
    data class Artist(val id: String) : Route
    data class Playlist(val id: String) : Route
    data class Genre(val name: String) : Route
    data class Shelf(val key: String) : Route
}

enum class Tab(val label: String, val icon: String, val root: Route) {
    Home("首页", "home", Route.Home),
    Search("搜索", "search", Route.Search),
    Library("音乐库", "library", Route.Library),
}

/**
 * Where the user is: one stack of pages per tab (the phone's bottom bar), or one stack (the tablet, which has the
 * library beside the page). Back pops the stack; tapping the tab again goes back to its first page.
 */
@Stable
class Navigator {
    val tab = mutableStateOf(Tab.Home)
    private val stacks = Tab.entries.associateWith { mutableStateListOf(it.root) }

    /** The full-screen player (phone), and what it shows below the controls. */
    val playerOpen = mutableStateOf(false)
    val playerView = mutableStateOf(PlayerView.Cover)

    /** The tablet's right panel: what plays, or the queue; closed below 1100 dp. */
    val panel = mutableStateOf(PanelView.NowPlaying)
    val panelOpen = mutableStateOf(true)

    /** What is typed in the search field. */
    val query = mutableStateOf("")

    val stack: List<Route> get() = stacks.getValue(tab.value)
    val current: Route get() = stack.last()

    fun go(route: Route) {
        playerOpen.value = false
        val s = stacks.getValue(tab.value)
        if (route == Route.Search || route == Route.Library || route == Route.Home) {
            selectTab(Tab.entries.first { it.root == route })
            return
        }
        if (s.last() != route) s.add(route)
    }

    fun selectTab(t: Tab) {
        if (tab.value == t) {
            val s = stacks.getValue(t)
            while (s.size > 1) s.removeAt(s.lastIndex)
        }
        tab.value = t
    }

    /** False when there is nowhere to go back to (the system then leaves the app). */
    fun back(): Boolean {
        if (playerOpen.value) {
            if (playerView.value != PlayerView.Cover) playerView.value = PlayerView.Cover else playerOpen.value = false
            return true
        }
        val s = stacks.getValue(tab.value)
        if (s.size > 1) {
            s.removeAt(s.lastIndex)
            return true
        }
        if (tab.value != Tab.Home) {
            tab.value = Tab.Home
            return true
        }
        return false
    }

    val canGoBack: Boolean get() = playerOpen.value || stack.size > 1 || tab.value != Tab.Home
}

enum class PlayerView { Cover, Lyrics, Queue }

enum class PanelView { NowPlaying, Queue }

val LocalGraph = staticCompositionLocalOf<AppGraph> { error("no graph") }
val LocalSession = staticCompositionLocalOf<MusicSession> { error("no session") }
val LocalPlayer = staticCompositionLocalOf<LocalPlayback> { error("no player") }
val LocalNav = staticCompositionLocalOf<Navigator> { error("no navigator") }

/** The window's width class, as the Windows app's breakpoints: phone below 600 dp; a library rail below 860; the right
 *  panel from 1100. */
enum class Layout { Phone, TabletNarrow, Tablet, TabletWide }

val LocalLayout = staticCompositionLocalOf { Layout.Phone }
