package com.creeperux.sonus.ui.screens

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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.creeperux.sonus.core.AlbumType
import com.creeperux.sonus.core.ArtistInfo
import com.creeperux.sonus.core.Formats
import com.creeperux.sonus.core.PlaylistKind
import com.creeperux.sonus.core.Track
import com.creeperux.sonus.session.Toast
import com.creeperux.sonus.ui.Layout
import com.creeperux.sonus.ui.LocalLayout
import com.creeperux.sonus.ui.LocalNav
import com.creeperux.sonus.ui.LocalPlayer
import com.creeperux.sonus.ui.LocalSession
import com.creeperux.sonus.ui.Route
import com.creeperux.sonus.ui.components.AddToPlaylistDialog
import com.creeperux.sonus.ui.components.CardFor
import com.creeperux.sonus.ui.components.Chip
import com.creeperux.sonus.ui.components.Cover
import com.creeperux.sonus.ui.components.EmptyState
import com.creeperux.sonus.ui.components.PlayButton
import com.creeperux.sonus.ui.components.PlaylistCover
import com.creeperux.sonus.ui.components.RoundButton
import com.creeperux.sonus.ui.components.SectionHeader
import com.creeperux.sonus.ui.components.TrackRow
import com.creeperux.sonus.ui.components.pageTint
import com.creeperux.sonus.ui.components.px
import com.creeperux.sonus.ui.components.rememberCoverColor
import com.creeperux.sonus.ui.pageTop
import com.creeperux.sonus.ui.theme.Shapes
import com.creeperux.sonus.ui.theme.Sonus
import com.creeperux.sonus.ui.theme.Tints
import kotlinx.coroutines.launch

/**
 * A page's header (ViewParts.cs:207-260): the art with a shadow, what it is, the title, a line of facts, then play,
 * shuffle and more. On the phone the art is centred above the text; on the tablet it sits beside it, as on Windows.
 */
@Composable
fun Hero(
    kind: String,
    title: String,
    facts: String,
    contextKind: String,
    contextId: String,
    tint: Color?,
    art: @Composable (Dp, Shape) -> Unit,
    artShape: Shape = RoundedCornerShape(Shapes.panel),
    extra: String? = null,
    ids: List<String>? = null,
    more: (@Composable (dismiss: () -> Unit) -> Unit)? = null,
) {
    val c = Sonus.colors
    val session = LocalSession.current
    val player = LocalPlayer.current
    val state by player.state.collectAsState()
    val phone = LocalLayout.current == Layout.Phone
    val here = state.context?.let { it.kind == contextKind && it.id == contextId } == true
    var menu by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().pageTint(tint).pageTop().padding(horizontal = 16.dp).padding(top = 8.dp, bottom = 8.dp)) {
        BackRow()
        if (phone) {
            Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                Box(Modifier.shadow(24.dp, artShape)) { art(220.dp, artShape) }
            }
            Spacer(Modifier.height(20.dp))
            Text(kind, style = Sonus.type.caption.copy(fontWeight = androidx.compose.ui.text.font.FontWeight.Bold), color = c.text)
            Text(title, style = Sonus.type.pageTitle, color = c.text, maxLines = 3, overflow = TextOverflow.Ellipsis, modifier = Modifier.testTag("page-title"))
        } else {
            Row(verticalAlignment = Alignment.Bottom) {
                Box(Modifier.shadow(24.dp, artShape)) { art(200.dp, artShape) }
                Spacer(Modifier.width(24.dp))
                Column(Modifier.weight(1f)) {
                    Text(kind, style = Sonus.type.bodySmall.copy(fontWeight = androidx.compose.ui.text.font.FontWeight.Bold), color = c.text)
                    Text(title, style = Sonus.type.hero, color = c.text, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.testTag("page-title"))
                }
            }
        }
        Spacer(Modifier.height(8.dp))
        Text(facts, style = Sonus.type.bodySmall, color = c.text, maxLines = 2, overflow = TextOverflow.Ellipsis)
        if (extra != null) Text(extra, style = Sonus.type.caption, color = c.textMuted)
        Spacer(Modifier.height(16.dp))
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            PlayButton(here && state.isActive, 56.dp, {
                if (here) player.togglePlay() else session.contextOf(contextKind, contextId, ids).let { (ctx, list) -> player.play(ctx, list) }
            }, Modifier.testTag("play-page"))
            RoundButton("shuffle", "随机播放", { session.contextOf(contextKind, contextId, ids).let { (ctx, list) -> player.play(ctx, list, shuffle = true) } }, raised = true, size = 48.dp)
            if (more != null) {
                Box {
                    RoundButton("more", "更多", { menu = true }, raised = true, size = 48.dp)
                    DropdownMenu(menu, { menu = false }, containerColor = c.raised) { more { menu = false } }
                }
            }
        }
    }
}

/** The songs of a page, numbered (an album) or with covers (a playlist, a search). */
fun LazyListScope.trackItems(tracks: List<Track>, contextKind: String, contextId: String, covers: Boolean, ids: List<String>? = null, playlistId: String? = null) {
    itemsIndexed(tracks, key = { i, t -> "$i:${t.id}" }) { i, t ->
        val session = LocalSession.current
        val player = LocalPlayer.current
        TrackRow(
            t, if (covers || contextKind != "album" || t.number <= 0) i + 1 else t.number, covers,
            onClick = { session.contextOf(contextKind, contextId, ids ?: tracks.map { it.id }).let { (ctx, list) -> player.play(ctx, list, t.id) } },
            modifier = Modifier.padding(horizontal = 8.dp).testTag("track-row"),
            playlistId = playlistId,
            showAlbum = contextKind != "album",
        )
    }
}

/** An album (LibraryPages.cs:108-136). */
@Composable
fun AlbumPage(id: String) {
    val c = Sonus.colors
    val session = LocalSession.current
    val nav = LocalNav.current
    val player = LocalPlayer.current
    val lib by session.libraryState.collectAsState()
    val a = lib.album(id)
    if (a == null) {
        EmptyState("找不到这张专辑。", icon = "album", modifier = Modifier.pageTop())
        return
    }
    val tracks = a.trackIds.mapNotNull(lib::track)
    val tint = rememberCoverColor(session.coverUrl(id, 64))
    val first = tracks.firstOrNull()
    var addTo by remember { mutableStateOf(false) }
    LazyColumn(Modifier.fillMaxSize().testTag("album-page"), contentPadding = PaddingValues(bottom = 32.dp)) {
        item {
            Hero(
                Formats.albumType(a.type), a.title,
                listOf(a.artist, a.year.takeIf { it > 0 }?.toString(), "${Formats.songs(tracks.size)}，${Formats.longDuration(tracks.sumOf { it.duration })}").filterNotNull().joinToString(" · "),
                "album", id, tint,
                art = { s, shape -> Cover(session.coverUrl(id, s.px()), s, shape = shape) },
                extra = first?.let { Formats.quality(it) },
                more = { dismiss ->
                    DropdownMenuItem({ Text("加入播放队列") }, { player.queueAdd(a.trackIds); session.say(Toast("已加入播放队列")); dismiss() })
                    DropdownMenuItem({ Text("下一首播放") }, { player.queueAdd(a.trackIds, next = true); session.say(Toast("将在下一首播放")); dismiss() })
                    DropdownMenuItem({ Text("加入歌单") }, { addTo = true; dismiss() })
                    DropdownMenuItem({ Text("查看艺人") }, { nav.go(Route.Artist(a.artistId)); dismiss() })
                },
            )
        }
        val discs = tracks.map { it.disc }.distinct()
        if (discs.size > 1) {
            for (d in discs) {
                item("disc$d") { Text("碟片 $d", style = Sonus.type.panelHeading, color = c.textMuted, modifier = Modifier.padding(start = 24.dp, top = 16.dp, bottom = 4.dp)) }
                trackItems(tracks.filter { it.disc == d }, "album", id, covers = false, ids = a.trackIds)
            }
        } else {
            trackItems(tracks, "album", id, covers = false)
        }
        item {
            Text(
                listOfNotNull(a.year.takeIf { it > 0 }?.let { "发行于 $it 年" }, a.label.takeIf { it.isNotEmpty() }?.let { "© $it" }).joinToString(" "),
                style = Sonus.type.caption, color = c.textMuted, modifier = Modifier.padding(24.dp),
            )
        }
    }
    if (addTo) AddToPlaylistDialog(a.trackIds) { addTo = false }
}

/** An artist (LibraryPages.cs:199-268): popular songs, the records, the biography, artists of the same genre. */
@Composable
fun ArtistPage(id: String) {
    val c = Sonus.colors
    val session = LocalSession.current
    val lib by session.libraryState.collectAsState()
    val ar = lib.artist(id)
    if (ar == null) {
        EmptyState("找不到这位艺人。", icon = "artist", modifier = Modifier.pageTop())
        return
    }
    val albums = ar.albumIds.mapNotNull(lib::album).sortedByDescending { it.year }
    val songs = lib.artistTracks(id).mapNotNull(lib::track)
    val popular = songs.sortedByDescending { it.playCount }
    var showMore by remember { mutableStateOf(false) }
    var records by remember { mutableStateOf("album") }
    val tint = rememberCoverColor(session.coverUrl(albums.firstOrNull()?.id, 64))
    val info by produceState<ArtistInfo?>(null, id) { value = runCatching { session.artistInfo(id) }.getOrNull() }
    val uri = LocalUriHandler.current
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 32.dp)) {
        item {
            Hero(
                "艺人" + if (ar.genre != "—") " · ${ar.genre}" else "", ar.name,
                "${albums.size} 张专辑 · ${Formats.songs(songs.size)}", "artist", id, tint,
                art = { s, _ -> Cover(session.coverUrl(albums.firstOrNull()?.id, s.px()), s, shape = CircleShape, placeholder = "artist") },
                artShape = CircleShape,
            )
        }
        item { SectionHeader("热门", Modifier.padding(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 4.dp)) }
        trackItems(popular.take(if (showMore) 10 else 5), "artist", id, covers = true, ids = popular.map { it.id })
        if (popular.size > 5) {
            item {
                Text(if (showMore) "收起" else "显示更多", style = Sonus.type.bodySmall, color = c.textMuted, modifier = Modifier.padding(horizontal = 24.dp, vertical = 8.dp).then(Modifier.testTag("more-popular")).clickableText { showMore = !showMore })
            }
        }
        item {
            Column(Modifier.padding(top = 20.dp)) {
                SectionHeader("唱片", Modifier.padding(horizontal = 16.dp))
                Row(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Chip("专辑", records == "album", { records = "album" })
                    Chip("单曲和 EP", records == "single", { records = "single" })
                }
                val shown = albums.filter { (it.type == AlbumType.Single || it.type == AlbumType.Ep) == (records == "single") }
                LazyRow(contentPadding = PaddingValues(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    items(shown, key = { it.id }) { CardFor("album", it.id, cardWidth()) }
                }
                if (shown.isEmpty()) Text("没有${if (records == "album") "专辑" else "单曲和 EP"}。", style = Sonus.type.muted, color = c.textMuted, modifier = Modifier.padding(horizontal = 16.dp))
            }
        }
        info?.takeIf { it.biography.isNotEmpty() || it.url != null }?.let { bio ->
            item {
                Column(Modifier.padding(16.dp).padding(top = 12.dp)) {
                    SectionHeader("简介")
                    Spacer(Modifier.height(8.dp))
                    if (bio.biography.isNotEmpty()) Text(bio.biography, style = Sonus.type.body, color = c.textMuted, maxLines = 6, overflow = TextOverflow.Ellipsis)
                    bio.url?.let { link -> Text("在 Last.fm 上阅读全文", style = Sonus.type.bodySmall, color = c.accentText, modifier = Modifier.padding(top = 8.dp).clickableText { uri.openUri(link) }) }
                }
            }
        }
        val similar = lib.artists.filter { it.id != id && it.genre == ar.genre && ar.genre != "—" && it.albumIds.isNotEmpty() }.take(12)
        if (similar.isNotEmpty()) {
            item {
                Column(Modifier.padding(top = 12.dp)) {
                    SectionHeader("同流派艺人", Modifier.padding(horizontal = 16.dp))
                    Spacer(Modifier.height(8.dp))
                    LazyRow(contentPadding = PaddingValues(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        items(similar, key = { it.id }) { CardFor("artist", it.id, cardWidth()) }
                    }
                }
            }
        }
    }
}

/** A playlist (LibraryPages.cs:140-195): 我喜欢的音乐, the whole library, or one of the server's playlists. */
@Composable
fun PlaylistPage(id: String) {
    val c = Sonus.colors
    val session = LocalSession.current
    val nav = LocalNav.current
    val player = LocalPlayer.current
    val scope = rememberCoroutineScope()
    val playlists by session.playlistsState.collectAsState()
    val lib by session.libraryState.collectAsState()
    session.revisionState.collectAsState().value
    val p = playlists.firstOrNull { it.id == id }
    if (p == null) {
        EmptyState("找不到这个歌单。", icon = "playlist", modifier = Modifier.pageTop())
        return
    }
    val tracks = p.trackIds.mapNotNull(lib::track)
    val firstAlbum = tracks.firstOrNull()?.albumId
    val coverColor = rememberCoverColor(if (p.kind == PlaylistKind.User || p.kind == PlaylistKind.ReadOnly) session.coverUrl(firstAlbum, 64) else null)
    val tint = when (p.kind) {
        PlaylistKind.Liked -> Tints.Liked
        PlaylistKind.Library -> Tints.Library
        else -> coverColor ?: Tints.Neutral
    }
    var renaming by remember { mutableStateOf(false) }
    var deleting by remember { mutableStateOf(false) }
    val kind = when (p.kind) {
        PlaylistKind.Library -> "媒体库"
        PlaylistKind.ReadOnly -> "歌单（只读）"
        else -> "歌单"
    }
    LazyColumn(Modifier.fillMaxSize().testTag("playlist-page"), contentPadding = PaddingValues(bottom = 32.dp)) {
        item {
            Hero(
                kind, p.name,
                listOfNotNull(p.owner.takeIf { it.isNotEmpty() }, "${Formats.songs(tracks.size)}，${Formats.longDuration(tracks.sumOf { it.duration })}").joinToString(" · "),
                "playlist", id, tint,
                art = { s, shape -> PlaylistCover(id, s, shape) },
                extra = p.comment,
                more = { dismiss ->
                    DropdownMenuItem({ Text("加入播放队列") }, { player.queueAdd(p.trackIds); session.say(Toast("已加入播放队列")); dismiss() })
                    if (p.isEditable) {
                        DropdownMenuItem({ Text("重命名") }, { renaming = true; dismiss() })
                        DropdownMenuItem({ Text("删除歌单", color = c.bad) }, { deleting = true; dismiss() })
                    }
                },
            )
        }
        if (tracks.isEmpty()) {
            item { EmptyState("这个歌单还是空的", "在歌曲的菜单里选择“加入歌单”，把歌加进来。", icon = "playlist") }
        }
        trackItems(tracks, "playlist", id, covers = true, playlistId = id)
    }
    if (renaming) {
        var name by remember { mutableStateOf(p.name) }
        AlertDialog(
            onDismissRequest = { renaming = false }, containerColor = c.raised,
            title = { Text("重命名歌单", color = c.text) },
            text = { OutlinedTextField(name, { name = it }, singleLine = true) },
            confirmButton = {
                TextButton({
                    renaming = false
                    scope.launch { runCatching { session.renamePlaylist(id, name.trim()) }.onFailure { session.say(Toast(it.message.orEmpty(), isError = true)) } }
                }) { Text("保存", color = c.accentText) }
            },
            dismissButton = { TextButton({ renaming = false }) { Text("取消", color = c.textMuted) } },
        )
    }
    if (deleting) {
        AlertDialog(
            onDismissRequest = { deleting = false }, containerColor = c.raised,
            title = { Text("删除“${p.name}”？", color = c.text) },
            text = { Text("歌单会从服务器上删除，媒体库里的歌曲不受影响。", color = c.textMuted) },
            confirmButton = {
                TextButton({
                    deleting = false
                    scope.launch {
                        runCatching { session.deletePlaylist(id) }
                            .onSuccess { session.say(Toast("已删除“${p.name}”")); nav.back() }
                            .onFailure { session.say(Toast(it.message.orEmpty(), isError = true)) }
                    }
                }) { Text("删除", color = c.bad) }
            },
            dismissButton = { TextButton({ deleting = false }) { Text("取消", color = c.textMuted) } },
        )
    }
}

/** A genre (OtherPages.cs:159-171): its albums, and its songs by plays. */
@Composable
fun GenrePage(name: String) {
    val session = LocalSession.current
    val lib by session.libraryState.collectAsState()
    val songs = lib.tracks.filter { it.genre == name }.sortedByDescending { it.playCount }
    val albums = songs.map { it.albumId }.distinct()
    val tint = rememberCoverColor(session.coverUrl(albums.firstOrNull(), 64))
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 32.dp)) {
        item {
            Hero("流派", name, "${albums.size} 张专辑 · ${Formats.songs(songs.size)}", "genre", name, tint,
                art = { s, shape -> Cover(session.coverUrl(albums.firstOrNull(), s.px()), s, shape = shape) }, ids = songs.map { it.id })
        }
        item {
            Column(Modifier.padding(top = 12.dp)) {
                SectionHeader("专辑", Modifier.padding(horizontal = 16.dp))
                Spacer(Modifier.height(8.dp))
                LazyRow(contentPadding = PaddingValues(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    items(albums, key = { it }) { CardFor("album", it, cardWidth()) }
                }
            }
        }
        item { SectionHeader("歌曲", Modifier.padding(start = 16.dp, end = 16.dp, top = 20.dp, bottom = 4.dp)) }
        trackItems(songs, "genre", name, covers = true, ids = songs.map { it.id })
    }
}

/** Text that acts as a link. */
fun Modifier.clickableText(onClick: () -> Unit): Modifier = this.clickable(onClick = onClick)
