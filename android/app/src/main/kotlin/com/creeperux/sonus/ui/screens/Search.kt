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
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.creeperux.sonus.core.SearchResult
import com.creeperux.sonus.ui.Layout
import com.creeperux.sonus.ui.LocalLayout
import com.creeperux.sonus.ui.LocalNav
import com.creeperux.sonus.ui.LocalPlayer
import com.creeperux.sonus.ui.LocalSession
import com.creeperux.sonus.ui.Route
import com.creeperux.sonus.ui.components.CardFor
import com.creeperux.sonus.ui.components.Chip
import com.creeperux.sonus.ui.components.Cover
import com.creeperux.sonus.ui.components.EmptyState
import com.creeperux.sonus.ui.components.PlayButton
import com.creeperux.sonus.ui.components.SectionHeader
import com.creeperux.sonus.ui.components.TrackRow
import com.creeperux.sonus.ui.components.pageTint
import com.creeperux.sonus.ui.components.pressable
import com.creeperux.sonus.ui.components.px
import com.creeperux.sonus.ui.components.rememberCoverColor
import com.creeperux.sonus.ui.components.shade
import com.creeperux.sonus.ui.StatusBarScrim
import com.creeperux.sonus.ui.icons.KitIcon
import com.creeperux.sonus.ui.pageTop
import com.creeperux.sonus.ui.theme.Shapes
import com.creeperux.sonus.ui.theme.Sonus
import com.creeperux.sonus.ui.theme.Tints
import kotlinx.coroutines.delay

/** The search field: the phone's search page carries it; the tablet's top bar does. */
@Composable
fun SearchField(modifier: Modifier = Modifier, autoFocus: Boolean = false) {
    val c = Sonus.colors
    val nav = LocalNav.current
    val focus = remember { FocusRequester() }
    val manager = LocalFocusManager.current
    Row(
        modifier.height(48.dp).clip(RoundedCornerShape(24.dp)).background(c.raised).padding(horizontal = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        KitIcon("search", size = 16.dp, tint = c.textMuted)
        Spacer(Modifier.width(10.dp))
        Box(Modifier.weight(1f)) {
            if (nav.query.value.isEmpty()) Text("想听什么？", style = Sonus.type.body, color = c.textQuiet)
            BasicTextField(
                nav.query.value, { nav.query.value = it; if (nav.current != Route.Search) nav.go(Route.Search) },
                singleLine = true, textStyle = Sonus.type.body.copy(color = c.text), cursorBrush = SolidColor(c.accent),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search), keyboardActions = KeyboardActions(onSearch = { manager.clearFocus() }),
                modifier = Modifier.fillMaxWidth().focusRequester(focus).testTag("search-field"),
            )
        }
        if (nav.query.value.isNotEmpty()) {
            KitIcon("close", size = 14.dp, tint = c.textMuted, modifier = Modifier.pressable({ nav.query.value = "" }, "清除"))
        }
    }
    if (autoFocus) LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
}

/**
 * Search (OtherPages.cs:13-149): with nothing typed, the genres to browse; else the best result, songs, artists, albums
 * and playlists, asked of the server 250 ms after the last key.
 */
@Composable
fun SearchScreen() {
    val c = Sonus.colors
    val session = LocalSession.current
    val nav = LocalNav.current
    val phone = LocalLayout.current == Layout.Phone
    val query = nav.query.value.trim()
    var result by remember { mutableStateOf<SearchResult?>(null) }
    var searching by remember { mutableStateOf(false) }
    var chip by remember { mutableStateOf("") }
    LaunchedEffect(query) {
        result = null
        if (query.isEmpty()) return@LaunchedEffect
        searching = true
        delay(250)
        result = runCatching { session.search(query) }.getOrElse { SearchResult.None }
        searching = false
    }
    val lib = session.lib
    val list = rememberLazyListState()
    Box(Modifier.fillMaxSize()) {
        LazyColumn(Modifier.fillMaxSize().testTag("search"), state = list, contentPadding = PaddingValues(bottom = 32.dp)) {
            item {
                Column(Modifier.fillMaxWidth().pageTint(Tints.Search, 240.dp).pageTop().padding(16.dp)) {
                    if (phone) {
                        Text("搜索", style = Sonus.type.pageTitle, color = c.text)
                        Spacer(Modifier.height(12.dp))
                        SearchField(Modifier.fillMaxWidth())
                        Spacer(Modifier.height(12.dp))
                    }
                    if (query.isNotEmpty()) {
                        val r = result
                        Text(
                            if (r == null) "正在搜索…" else "找到 ${r.count + session.searchPlaylists(query).size} 项",
                            style = Sonus.type.muted, color = c.textMuted,
                        )
                        Spacer(Modifier.height(8.dp))
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            listOf("" to "全部", "song" to "歌曲", "artist" to "艺人", "album" to "专辑", "playlist" to "歌单").forEach { (k, label) ->
                                Chip(label, chip == k, { chip = k })
                            }
                        }
                    }
                }
            }
            if (query.isEmpty()) {
                item { Browse() }
                return@LazyColumn
            }
            val r = result ?: return@LazyColumn
            val playlists = session.searchPlaylists(query)
            if (r.count == 0 && playlists.isEmpty()) {
                item { EmptyState("没有找到“$query”", "换个关键词，或检查拼写。", icon = "search") }
                return@LazyColumn
            }
            val songs = r.tracks.mapNotNull(lib::track)
            if (chip == "" || chip == "song") {
                if (chip == "") {
                    item { BestResult(r) }
                    item { SectionHeader("歌曲", Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) }
                }
                val shown = if (chip == "") songs.take(4) else songs
                items(shown.size, key = { "s${shown[it].id}" }) { i ->
                    val player = LocalPlayer.current
                    TrackRow(shown[i], i + 1, true, { session.contextOf("search", query, r.tracks).let { (ctx, ids) -> player.play(ctx, ids, shown[i].id) } }, Modifier.padding(horizontal = 8.dp))
                }
            }
            fun shelf(key: String, title: String, ids: List<String>, type: String) {
                if (ids.isEmpty() || (chip != "" && chip != key)) return
                item(key) {
                    Column(Modifier.padding(top = 16.dp)) {
                        SectionHeader(title, Modifier.padding(horizontal = 16.dp))
                        Spacer(Modifier.height(8.dp))
                        LazyRow(contentPadding = PaddingValues(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            items(ids, key = { it }) { CardFor(type, it, cardWidth()) }
                        }
                    }
                }
            }
            shelf("artist", "艺人", r.artists, "artist")
            shelf("album", "专辑", r.albums, "album")
            shelf("playlist", "歌单", playlists.map { it.id }, "playlist")
        }
        StatusBarScrim(list)
    }
}

/** 最佳结果: the first artist, album or song found, large. */
@Composable
private fun BestResult(r: SearchResult) {
    val c = Sonus.colors
    val session = LocalSession.current
    val nav = LocalNav.current
    val player = LocalPlayer.current
    val lib = session.lib
    val artist = r.artists.firstOrNull()?.let(lib::artist)
    val album = r.albums.firstOrNull()?.let(lib::album)
    val track = r.tracks.firstOrNull()?.let(lib::track)
    val (title, sub, cover, round, open, play) = when {
        artist != null -> Best(artist.name, "艺人", session.coverUrl(artist.albumIds.firstOrNull(), 96.dp.px()), true, { nav.go(Route.Artist(artist.id)) }) {
            session.contextOf("artist", artist.id).let { (ctx, ids) -> player.play(ctx, ids) }
        }
        album != null -> Best(album.title, "专辑 · ${album.artist}", session.coverUrl(album.id, 96.dp.px()), false, { nav.go(Route.Album(album.id)) }) {
            session.contextOf("album", album.id).let { (ctx, ids) -> player.play(ctx, ids) }
        }
        track != null -> Best(track.title, "歌曲 · ${track.artist}", session.trackCoverUrl(track, 96.dp.px()), false, { nav.go(Route.Album(track.albumId)) }) {
            session.contextOf("search", nav.query.value.trim(), r.tracks).let { (ctx, ids) -> player.play(ctx, ids, track.id) }
        }
        else -> return
    }
    Column(Modifier.padding(horizontal = 16.dp)) {
        SectionHeader("最佳结果")
        Spacer(Modifier.height(8.dp))
        Row(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(Shapes.panel)).background(c.raised).pressable(open).padding(16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Cover(cover, 96.dp, shape = if (round) CircleShape else RoundedCornerShape(Shapes.smallCover), placeholder = if (round) "artist" else "album")
            Spacer(Modifier.width(16.dp))
            Column(Modifier.weight(1f)) {
                Text(title, style = Sonus.type.pageTitle, color = c.text, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Text(sub, style = Sonus.type.bodySmall, color = c.textMuted, maxLines = 1)
            }
            PlayButton(false, 48.dp, play)
        }
    }
}

private data class Best(val title: String, val sub: String, val cover: String?, val round: Boolean, val open: () -> Unit, val play: () -> Unit)

/** 浏览全部: the genres as tiles coloured from a cover, with that cover turned in the corner. */
@Composable
private fun Browse() {
    val c = Sonus.colors
    val session = LocalSession.current
    val nav = LocalNav.current
    val lib by session.libraryState.collectAsState()
    val genres = remember(lib) {
        lib.tracks.filter { it.genre != "—" }.groupBy { it.genre }.entries.sortedByDescending { e -> e.value.size }.map { e -> e.key to e.value.first().albumId }
    }
    Column(Modifier.padding(horizontal = 16.dp)) {
        SectionHeader("浏览全部")
        Spacer(Modifier.height(12.dp))
        BoxWithConstraints {
            val columns = maxOf(2, (maxWidth / 188.dp).toInt())
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                genres.chunked(columns).forEach { row ->
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        row.forEach { (genre, albumId) ->
                            val color = rememberCoverColor(session.coverUrl(albumId, 64)) ?: Tints.Neutral
                            Box(
                                Modifier.weight(1f).height(100.dp).clip(RoundedCornerShape(Shapes.panel)).background(color.shade(0.15f)).pressable({ nav.go(Route.Genre(genre)) }),
                            ) {
                                Text(genre, style = Sonus.type.panelHeading, color = androidx.compose.ui.graphics.Color.White, modifier = Modifier.padding(12.dp))
                                Box(Modifier.align(Alignment.BottomEnd).offset(18.dp, 14.dp).rotate(25f)) {
                                    Cover(session.coverUrl(albumId, 64.dp.px()), 64.dp)
                                }
                            }
                        }
                        repeat(columns - row.size) { Spacer(Modifier.weight(1f)) }
                    }
                }
            }
        }
        if (genres.isEmpty()) Text("媒体库里还没有流派信息。", style = Sonus.type.muted, color = c.textMuted)
    }
}
