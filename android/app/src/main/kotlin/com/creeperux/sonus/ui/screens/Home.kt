package com.creeperux.sonus.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.creeperux.sonus.core.CardRef
import com.creeperux.sonus.core.Formats
import com.creeperux.sonus.core.HomeShelves
import com.creeperux.sonus.ui.Layout
import com.creeperux.sonus.ui.LocalGraph
import com.creeperux.sonus.ui.LocalLayout
import com.creeperux.sonus.ui.LocalNav
import com.creeperux.sonus.ui.LocalPlayer
import com.creeperux.sonus.ui.LocalSession
import com.creeperux.sonus.ui.OnlineDot
import com.creeperux.sonus.ui.Route
import com.creeperux.sonus.ui.components.CardFor
import com.creeperux.sonus.ui.components.Chip
import com.creeperux.sonus.ui.components.Cover
import com.creeperux.sonus.ui.components.LevelBars
import com.creeperux.sonus.ui.components.PlaylistCover
import com.creeperux.sonus.ui.components.RoundButton
import com.creeperux.sonus.ui.components.SectionHeader
import com.creeperux.sonus.ui.components.pageTint
import com.creeperux.sonus.ui.components.pressable
import com.creeperux.sonus.ui.components.px
import com.creeperux.sonus.ui.entrance
import com.creeperux.sonus.ui.pageTop
import com.creeperux.sonus.ui.theme.Shapes
import com.creeperux.sonus.ui.theme.Sonus
import com.creeperux.sonus.ui.theme.Tints
import kotlinx.coroutines.launch
import java.time.LocalTime

/** The shelves of the home page (HomeShelves.cs) and where "显示全部" leads (shelf:x). */
val ShelfTitles = linkedMapOf(
    "recent" to "最近播放", "playlists" to "你的歌单", "artists" to "你常听的艺人",
    "hires" to "高解析度收藏", "added" to "最近添加到媒体库", "forgotten" to "很久没听了",
)

fun HomeShelves.byKey(key: String): List<CardRef> = when (key) {
    "recent" -> recent
    "playlists" -> playlists
    "artists" -> topArtists
    "hires" -> hiRes
    "added" -> added
    else -> forgotten
}

/** The card width of shelves and grids: 168 dp as the Windows app on a tablet, smaller on a phone. */
@Composable
fun cardWidth(): Dp = if (LocalLayout.current == Layout.Phone) 140.dp else 168.dp

/**
 * Home (LibraryPages.cs:12-105): the greeting, the chips that filter the shelves, up to eight quick tiles (liked songs,
 * recent albums, playlists), then the shelves.
 */
@Composable
fun HomeScreen() {
    val c = Sonus.colors
    val session = LocalSession.current
    val nav = LocalNav.current
    val lib by session.libraryState.collectAsState()
    val playlists by session.playlistsState.collectAsState()
    val online by session.online.collectAsState()
    val scope = rememberCoroutineScope()
    session.revisionState.collectAsState().value
    var filter by rememberSaveable { mutableStateOf("") }
    val shelves = remember(lib, playlists, session.revisionState.value) { HomeShelves.from(lib, playlists) }
    val phone = LocalLayout.current == Layout.Phone

    val tiles = remember(shelves) {
        buildList {
            add(CardRef("playlist", "liked"))
            addAll(shelves.recent.take(3))
            addAll(shelves.playlists.filter { it.id != "liked" }.take(2))
            addAll(shelves.recent.drop(3))
            addAll(shelves.added)
        }.distinct().take(8)
    }
    val wanted = when (filter) {
        "album" -> listOf("recent", "hires", "added", "forgotten")
        "playlist" -> listOf("playlists")
        "artist" -> listOf("artists")
        else -> ShelfTitles.keys.toList()
    }

    LazyColumn(Modifier.fillMaxSize().testTag("home"), contentPadding = PaddingValues(bottom = 24.dp)) {
        item {
            Column(Modifier.fillMaxWidth().pageTint(Tints.Neutral, 360.dp).pageTop().padding(horizontal = 16.dp).padding(top = 16.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(Formats.greeting(LocalTime.now().hour), style = Sonus.type.pageTitle, color = c.text, modifier = Modifier.weight(1f))
                    if (phone) {
                        if (!online) {
                            Row(Modifier.clip(RoundedCornerShape(16.dp)).background(c.raised).pressable({ scope.launch { session.goOnline() } }).padding(horizontal = 10.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                                OnlineDot(false)
                                Spacer(Modifier.width(6.dp))
                                Text("未连接到服务器", style = Sonus.type.caption, color = c.text)
                            }
                        }
                        val update by LocalGraph.current.updater.available.collectAsState()
                        RoundButton("settings", if (update != null) "设置（有新版本）" else "设置", { nav.go(Route.Settings) }, Modifier.testTag("open-settings"), badge = update != null)
                    }
                }
                Spacer(Modifier.height(12.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    listOf("album" to "专辑", "playlist" to "歌单", "artist" to "艺人").forEach { (k, label) ->
                        Chip(label, filter == k, { filter = if (filter == k) "" else k })
                    }
                }
                Spacer(Modifier.height(16.dp))
                if (filter.isEmpty()) QuickTiles(tiles)
            }
        }
        for ((shelf, key) in wanted.withIndex()) {
            val cards = shelves.byKey(key)
            if (cards.isEmpty()) continue
            item(key) {
                Column(Modifier.entrance(6 + shelf).padding(top = 24.dp)) {
                    SectionHeader(ShelfTitles.getValue(key), Modifier.padding(horizontal = 16.dp), "显示全部") { nav.go(Route.Shelf(key)) }
                    Spacer(Modifier.height(8.dp))
                    LazyRow(contentPadding = PaddingValues(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        items(cards.take(12), key = { "${it.type}:${it.id}" }) { CardFor(it.type, it.id, cardWidth()) }
                    }
                }
            }
        }
    }
}

/** The quick tiles: cover and title in a tinted box, two or four to a row. */
@Composable
private fun QuickTiles(tiles: List<CardRef>) {
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val columns = if (maxWidth >= 900.dp) 4 else 2
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            tiles.chunked(columns).forEachIndexed { r, row ->
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    row.forEachIndexed { i, tile -> QuickTile(tile, Modifier.weight(1f).entrance(r * columns + i)) }
                    repeat(columns - row.size) { Spacer(Modifier.weight(1f)) }
                }
            }
        }
    }
}

@Composable
private fun QuickTile(ref: CardRef, modifier: Modifier) {
    val c = Sonus.colors
    val session = LocalSession.current
    val nav = LocalNav.current
    val player = LocalPlayer.current
    val state by player.state.collectAsState()
    val title = when (ref.type) {
        "album" -> session.lib.album(ref.id)?.title
        "playlist" -> session.playlist(ref.id)?.name
        else -> session.lib.artist(ref.id)?.name
    } ?: return
    val playing = state.context?.let { it.kind == ref.type && it.id == ref.id } == true
    Row(
        modifier.height(56.dp).clip(RoundedCornerShape(Shapes.row)).background(c.tile).pressable({
            nav.go(if (ref.type == "album") Route.Album(ref.id) else if (ref.type == "playlist") Route.Playlist(ref.id) else Route.Artist(ref.id))
        }),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (ref.type == "playlist") PlaylistCover(ref.id, 56.dp, RoundedCornerShape(topStart = Shapes.row, bottomStart = Shapes.row))
        else Cover(session.coverUrl(ref.id, 56.dp.px()), 56.dp, shape = RoundedCornerShape(topStart = Shapes.row, bottomStart = Shapes.row))
        Spacer(Modifier.width(10.dp))
        Text(title, style = Sonus.type.cardTitle, color = if (playing) c.accentText else c.text, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        if (playing) Box(Modifier.padding(end = 10.dp)) { LevelBars(state.isActive) }
    }
}

/** 显示全部: a shelf as a grid of cards (OtherPages.cs:173-186). */
@Composable
fun ShelfPage(key: String) {
    val session = LocalSession.current
    val lib by session.libraryState.collectAsState()
    val playlists by session.playlistsState.collectAsState()
    val cards = remember(lib, playlists) { HomeShelves.from(lib, playlists).byKey(key) }
    CardGrid(ShelfTitles[key].orEmpty(), cards)
}

/** A page of cards in a grid, under a title. */
@Composable
fun CardGrid(title: String, cards: List<CardRef>) {
    val c = Sonus.colors
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val w = cardWidth()
        val columns = maxOf(2, ((maxWidth - 32.dp + 12.dp) / (w + 12.dp)).toInt())
        val cell = (maxWidth - 32.dp - 12.dp * (columns - 1)) / columns
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
            item {
                Column(Modifier.pageTop().padding(16.dp)) {
                    BackRow()
                    Text(title, style = Sonus.type.pageTitle, color = c.text)
                }
            }
            items(cards.chunked(columns)) { row ->
                Row(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    row.forEach { CardFor(it.type, it.id, cell) }
                }
            }
        }
    }
}

/** The back arrow at the top of a page (phone; the tablet uses the system back gesture and its top bar). */
@Composable
fun BackRow() {
    val nav = LocalNav.current
    if (nav.stack.size > 1) {
        RoundButton("arrow-left", "返回", { nav.back() }, Modifier.padding(bottom = 4.dp).testTag("back"), size = 40.dp)
    }
}
