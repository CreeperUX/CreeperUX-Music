package com.creeperux.sonus.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.creeperux.sonus.core.PlaylistKind
import com.creeperux.sonus.session.Toast
import com.creeperux.sonus.ui.LocalGraph
import com.creeperux.sonus.ui.LocalNav
import com.creeperux.sonus.ui.LocalPlayer
import com.creeperux.sonus.ui.LocalSession
import com.creeperux.sonus.ui.Route
import com.creeperux.sonus.ui.components.Chip
import com.creeperux.sonus.ui.components.Cover
import com.creeperux.sonus.ui.components.LevelBars
import com.creeperux.sonus.ui.components.PlaylistCover
import com.creeperux.sonus.ui.components.RoundButton
import com.creeperux.sonus.ui.components.px
import com.creeperux.sonus.ui.entrance
import com.creeperux.sonus.ui.icons.KitIcon
import com.creeperux.sonus.ui.pageTop
import com.creeperux.sonus.ui.theme.Shapes
import com.creeperux.sonus.ui.theme.Sonus
import kotlinx.coroutines.launch

/** A row of the library: an album, an artist or a playlist, with what the sorts need. */
private data class Entry(
    val key: String,
    val type: String,
    val id: String,
    val name: String,
    val subtitle: String,
    val pinned: Boolean,
    val lastPlayed: Long,
    val added: Long,
    val creator: String,
)

private val sorts = linkedMapOf("recent" to "最近播放", "added" to "最近添加", "alpha" to "字母顺序", "creator" to "创作者")

/** The phone's 音乐库 tab. */
@Composable
fun LibraryScreen() = LibraryList(pane = false)

/**
 * The library (LibraryPane.cs): 我喜欢的音乐 and the whole library pinned on top, then the playlists, albums and artists,
 * filtered by the chips, found by name, sorted as chosen. On the tablet it stays beside the page.
 */
@Composable
fun LibraryList(pane: Boolean) {
    val c = Sonus.colors
    val session = LocalSession.current
    val graph = LocalGraph.current
    val nav = LocalNav.current
    val player = LocalPlayer.current
    val scope = rememberCoroutineScope()
    val lib by session.libraryState.collectAsState()
    val playlists by session.playlistsState.collectAsState()
    val state by player.state.collectAsState()
    var filter by remember { mutableStateOf(graph.settings.libraryFilter) }
    var sort by remember { mutableStateOf(graph.settings.librarySort) }
    var find by remember { mutableStateOf("") }
    var sortMenu by remember { mutableStateOf(false) }

    val entries = remember(lib, playlists, session.revisionState.value) {
        val lastAlbum = HashMap<String, Long>()
        val addedAlbum = HashMap<String, Long>()
        val lastArtist = HashMap<String, Long>()
        for (t in lib.tracks) {
            t.lastPlayed?.let { if ((lastAlbum[t.albumId] ?: 0) < it) lastAlbum[t.albumId] = it; if ((lastArtist[t.artistId] ?: 0) < it) lastArtist[t.artistId] = it }
            t.added?.let { if ((addedAlbum[t.albumId] ?: 0) < it) addedAlbum[t.albumId] = it }
        }
        buildList {
            for (p in playlists) {
                val pinned = p.kind == PlaylistKind.Liked || p.kind == PlaylistKind.Library
                val last = p.trackIds.maxOfOrNull { lib.track(it)?.lastPlayed ?: 0 } ?: 0
                add(Entry("playlist:${p.id}", "playlist", p.id, p.name, "歌单 · ${p.trackIds.size} 首歌曲", pinned, last, p.changed, p.owner))
            }
            for (a in lib.albums) add(Entry("album:${a.id}", "album", a.id, a.title, "专辑 · ${a.artist}", false, lastAlbum[a.id] ?: 0, addedAlbum[a.id] ?: 0, a.artist))
            for (a in lib.artists.filter { it.albumIds.isNotEmpty() }) add(Entry("artist:${a.id}", "artist", a.id, a.name, "艺人", false, lastArtist[a.id] ?: 0, 0, a.name))
        }
    }
    val shown = entries
        .filter { filter.isEmpty() || it.type == filter }
        .filter { find.isBlank() || it.name.contains(find.trim(), ignoreCase = true) }
        .sortedWith(
            compareByDescending<Entry> { it.pinned }.then(
                when (sort) {
                    "added" -> compareByDescending { it.added }
                    "alpha" -> compareBy { it.name.lowercase() }
                    "creator" -> compareBy<Entry> { it.creator.lowercase() }.thenBy { it.name.lowercase() }
                    else -> compareByDescending<Entry> { it.lastPlayed }.thenBy { it.name.lowercase() }
                },
            ),
        )

    LazyColumn(Modifier.fillMaxSize().testTag("library"), contentPadding = PaddingValues(bottom = 16.dp)) {
        item {
            Column(Modifier.then(if (pane) Modifier else Modifier.pageTop()).padding(horizontal = if (pane) 12.dp else 16.dp).padding(top = if (pane) 12.dp else 16.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    KitIcon("library", size = 18.dp, tint = c.textMuted)
                    Spacer(Modifier.width(10.dp))
                    Text("音乐库", style = if (pane) Sonus.type.panelHeading else Sonus.type.pageTitle, color = c.text, modifier = Modifier.weight(1f))
                    RoundButton("plus", "新建歌单", {
                        scope.launch {
                            val n = playlists.count { it.kind == PlaylistKind.User } + 1
                            runCatching { session.createPlaylist("我的歌单 #$n", emptyList()) }
                                .onSuccess { session.say(Toast("已创建“${it.name}”")); nav.go(Route.Playlist(it.id)) }
                                .onFailure { session.say(Toast(it.message.orEmpty(), isError = true)) }
                        }
                    }, raised = true, size = 36.dp, iconSize = 16.dp)
                }
                Spacer(Modifier.height(12.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    listOf("playlist" to "歌单", "album" to "专辑", "artist" to "艺人").forEach { (k, label) ->
                        Chip(label, filter == k, {
                            filter = if (filter == k) "" else k
                            graph.settings.libraryFilter = filter
                        })
                    }
                }
                Spacer(Modifier.height(10.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Row(
                        Modifier.weight(1f).height(36.dp).clip(RoundedCornerShape(18.dp)).background(c.raised).padding(horizontal = 12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        KitIcon("search", size = 14.dp, tint = c.textMuted)
                        Spacer(Modifier.width(8.dp))
                        Box(Modifier.weight(1f)) {
                            if (find.isEmpty()) Text("在音乐库中搜索", style = Sonus.type.bodySmall, color = c.textQuiet)
                            BasicTextField(find, { find = it }, singleLine = true, textStyle = Sonus.type.bodySmall.copy(color = c.text), cursorBrush = SolidColor(c.accent), modifier = Modifier.fillMaxWidth())
                        }
                    }
                    Spacer(Modifier.width(8.dp))
                    Box {
                        Row(Modifier.clip(RoundedCornerShape(6.dp)).clickable { sortMenu = true }.padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text(sorts.getValue(sort), style = Sonus.type.caption, color = c.textMuted)
                            Spacer(Modifier.width(4.dp))
                            KitIcon("sort", size = 13.dp, tint = c.textMuted)
                        }
                        DropdownMenu(sortMenu, { sortMenu = false }, containerColor = c.raised) {
                            sorts.forEach { (k, label) ->
                                DropdownMenuItem({ Text(label, color = if (k == sort) c.accentText else c.text) }, {
                                    sort = k
                                    graph.settings.librarySort = k
                                    sortMenu = false
                                })
                            }
                        }
                    }
                }
                Spacer(Modifier.height(6.dp))
            }
        }
        itemsIndexed(shown, key = { _, e -> e.key }) { i, e ->
            val playing = state.context?.let { it.kind == e.type && it.id == e.id } == true
            Row(
                Modifier
                    .entrance(i)
                    .fillMaxWidth()
                    .padding(horizontal = if (pane) 6.dp else 8.dp)
                    .clip(RoundedCornerShape(Shapes.row))
                    .clickable {
                        nav.go(
                            when (e.type) {
                                "album" -> Route.Album(e.id)
                                "artist" -> Route.Artist(e.id)
                                else -> Route.Playlist(e.id)
                            },
                        )
                    }
                    .padding(horizontal = 8.dp, vertical = 6.dp)
                    .testTag("library-row"),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                EntryCover(e.type, e.id, 48)
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Text(e.name, style = Sonus.type.body, color = if (playing) c.accentText else c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(e.subtitle, style = Sonus.type.caption, color = c.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                if (playing) LevelBars(state.isActive)
            }
        }
    }
}

@Composable
private fun EntryCover(type: String, id: String, size: Int) {
    val session = LocalSession.current
    val s = size.dp
    when (type) {
        "playlist" -> PlaylistCover(id, s)
        "artist" -> Cover(session.coverUrl(session.lib.artist(id)?.albumIds?.firstOrNull(), s.px()), s, shape = CircleShape, placeholder = "artist")
        else -> Cover(session.coverUrl(id, s.px()), s)
    }
}

/** The narrow tablet's library: a rail of covers (the Windows window below 860 px). */
@Composable
fun LibraryRail() {
    val session = LocalSession.current
    val nav = LocalNav.current
    val playlists by session.playlistsState.collectAsState()
    val lib by session.libraryState.collectAsState()
    val items = remember(playlists, lib) { playlists.map { "playlist" to it.id } + lib.albums.take(60).map { "album" to it.id } }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(vertical = 12.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item { RoundButton("library", "音乐库", { nav.go(Route.Library) }, raised = true, size = 48.dp) }
        items(items, key = { "${it.first}:${it.second}" }) { (type, id) ->
            Box(Modifier.size(56.dp).clip(RoundedCornerShape(Shapes.smallCover)).clickable { nav.go(if (type == "album") Route.Album(id) else Route.Playlist(id)) }, contentAlignment = Alignment.Center) {
                EntryCover(type, id, 56)
            }
        }
    }
}
