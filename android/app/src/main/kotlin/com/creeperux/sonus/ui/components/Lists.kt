package com.creeperux.sonus.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.creeperux.sonus.core.Formats
import com.creeperux.sonus.core.PlaylistKind
import com.creeperux.sonus.core.Track
import com.creeperux.sonus.playback.PlayerStatus
import com.creeperux.sonus.session.Toast
import com.creeperux.sonus.ui.Layout
import com.creeperux.sonus.ui.LocalLayout
import com.creeperux.sonus.ui.LocalNav
import com.creeperux.sonus.ui.LocalPlayer
import com.creeperux.sonus.ui.LocalSession
import com.creeperux.sonus.ui.Route
import com.creeperux.sonus.ui.icons.KitIcon
import com.creeperux.sonus.ui.rememberHaptics
import com.creeperux.sonus.ui.theme.Shapes
import com.creeperux.sonus.ui.theme.Sonus
import kotlinx.coroutines.launch

/**
 * A song in a list (TrackList.cs): its number (level bars when it plays) or cover, title over artist, on wider screens
 * the album and the duration, a heart and the "…" menu. A tap plays the list from this song.
 */
@Composable
fun TrackRow(
    t: Track,
    number: Int,
    showCover: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    playlistId: String? = null,
    showAlbum: Boolean = LocalLayout.current != Layout.Phone,
) {
    val c = Sonus.colors
    val session = LocalSession.current
    val player = LocalPlayer.current
    val state by player.state.collectAsState()
    session.revisionState.collectAsState().value // likes change in place
    val isCurrent = state.trackId == t.id
    val wide = LocalLayout.current != Layout.Phone
    var menu by remember { mutableStateOf(false) }
    val haptics = rememberHaptics()
    Row(
        modifier
            .fillMaxWidth()
            .heightIn(min = 56.dp)
            .clip(RoundedCornerShape(Shapes.row))
            .combinedClickable(onClick = onClick, onLongClick = { haptics.longPress(); menu = true }, onLongClickLabel = "更多")
            .padding(horizontal = 8.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (showCover) {
            Box(contentAlignment = Alignment.Center) {
                Cover(session.trackCoverUrl(t, 44.dp.px()), 44.dp)
                if (isCurrent) Box(Modifier.size(44.dp).clip(RoundedCornerShape(Shapes.smallCover)).background(c.window.copy(alpha = 0.55f)), contentAlignment = Alignment.Center) {
                    LevelBars(state.status == PlayerStatus.Playing)
                }
            }
        } else {
            Box(Modifier.width(32.dp), contentAlignment = Alignment.Center) {
                if (isCurrent) LevelBars(state.status == PlayerStatus.Playing)
                else Text("$number", style = Sonus.type.numbers, color = c.textMuted)
            }
        }
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(3f)) {
            Text(t.title, style = Sonus.type.body, color = if (isCurrent) c.accentText else c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (t.liked && !wide) {
                    KitIcon("heart-filled", size = 10.dp, tint = c.accentText)
                    Spacer(Modifier.width(4.dp))
                }
                Text(t.artist, style = Sonus.type.caption, color = c.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        if (wide && showAlbum) {
            Spacer(Modifier.width(12.dp))
            Text(t.album, style = Sonus.type.bodySmall, color = c.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(2f))
        }
        if (wide) {
            val scope = rememberCoroutineScope()
            RoundButton(
                if (t.liked) "heart-filled" else "heart", if (t.liked) "取消喜欢" else "喜欢",
                { scope.launch { session.setLiked(t.id, !t.liked) } }, size = 36.dp, iconSize = 15.dp,
                tint = if (t.liked) c.accentText else c.textMuted,
            )
            Text(Formats.duration(t.duration), style = Sonus.type.numbers, color = c.textMuted, modifier = Modifier.width(48.dp).padding(start = 8.dp))
        }
        Box {
            RoundButton("more-vertical", "更多", { menu = true }, size = 36.dp, iconSize = 16.dp, tint = c.textMuted)
            TrackMenu(t, menu, { menu = false }, playlistId)
        }
    }
}

/** The song menu (TrackList.cs:283-319). */
@Composable
fun TrackMenu(t: Track, expanded: Boolean, onDismiss: () -> Unit, playlistId: String? = null) {
    val session = LocalSession.current
    val player = LocalPlayer.current
    val nav = LocalNav.current
    val scope = rememberCoroutineScope()
    var addTo by remember { mutableStateOf(false) }
    var info by remember { mutableStateOf(false) }
    val c = Sonus.colors
    DropdownMenu(expanded, onDismiss, containerColor = c.raised) {
        @Composable
        fun item(text: String, icon: String, action: () -> Unit) = DropdownMenuItem(
            text = { Text(text, style = Sonus.type.body, color = c.text) },
            leadingIcon = { KitIcon(icon, size = 15.dp, tint = c.textMuted) },
            onClick = {
                onDismiss()
                action()
            },
        )
        item("下一首播放", "skip-next") {
            player.queueAdd(listOf(t.id), next = true)
            session.say(Toast("将在下一首播放"))
        }
        item("加入播放队列", "queue") {
            player.queueAdd(listOf(t.id))
            session.say(Toast("已加入播放队列"))
        }
        item("加入歌单", "playlist") { addTo = true }
        if (playlistId != null && (playlistId == "liked" || session.playlist(playlistId)?.isEditable == true)) {
            item("从歌单中移除", "minus") {
                scope.launch {
                    runCatching { session.removeFromPlaylist(playlistId, listOf(t.id)) }.onFailure { session.say(Toast(it.message.orEmpty(), isError = true)) }
                }
            }
        }
        item("开始电台", "waveform") {
            scope.launch {
                val radio = session.radioFor(t.id)
                if (radio == null) session.say(Toast("没有找到相似的歌曲。")) else player.play(radio.first, radio.second, t.id)
            }
        }
        item(if (t.liked) "取消喜欢" else "喜欢", if (t.liked) "heart-filled" else "heart") { scope.launch { session.setLiked(t.id, !t.liked) } }
        HorizontalDivider(color = c.divider)
        item("查看艺人", "artist") { nav.go(Route.Artist(t.artistId)) }
        item("查看专辑", "album") { nav.go(Route.Album(t.albumId)) }
        item("属性", "info") { info = true }
    }
    if (addTo) AddToPlaylistDialog(listOf(t.id)) { addTo = false }
    if (info) TrackInfoDialog(t) { info = false }
}

/** Picks one of the user's playlists (or a new one) for [ids]. */
@Composable
fun AddToPlaylistDialog(ids: List<String>, onDismiss: () -> Unit) {
    val session = LocalSession.current
    val scope = rememberCoroutineScope()
    val playlists by session.playlistsState.collectAsState()
    val c = Sonus.colors
    var naming by remember { mutableStateOf(false) }
    var name by remember { mutableStateOf("") }
    fun done(text: String) {
        session.say(Toast(text))
        onDismiss()
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = c.raised,
        title = { Text(if (naming) "新建歌单" else "加入歌单", style = Sonus.type.panelHeading, color = c.text) },
        text = {
            if (naming) {
                OutlinedTextField(
                    name, { name = it }, singleLine = true, label = { Text("歌单名称") },
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                    keyboardActions = KeyboardActions(onDone = {}),
                )
            } else {
                LazyColumn(Modifier.heightIn(max = 360.dp)) {
                    item {
                        PlaylistPick("新建歌单", "plus") {
                            naming = true
                            name = "我的歌单 #${playlists.count { it.kind == PlaylistKind.User } + 1}"
                        }
                    }
                    items(playlists.filter { it.kind == PlaylistKind.User || it.kind == PlaylistKind.Liked }, key = { it.id }) { p ->
                        PlaylistPick(p.name, if (p.kind == PlaylistKind.Liked) "heart" else "playlist") {
                            scope.launch {
                                runCatching { session.addToPlaylist(p.id, ids) }
                                    .onSuccess { done("已将 ${ids.size} 首加入“${p.name}”") }
                                    .onFailure { session.say(Toast(it.message.orEmpty(), isError = true)); onDismiss() }
                            }
                        }
                    }
                }
            }
        },
        confirmButton = {
            if (naming) {
                TextButton({
                    scope.launch {
                        runCatching { session.createPlaylist(name.trim().ifEmpty { "新歌单" }, ids) }
                            .onSuccess { done("已创建“${it.name}”") }
                            .onFailure { session.say(Toast(it.message.orEmpty(), isError = true)); onDismiss() }
                    }
                }) { Text("创建", color = c.accentText) }
            }
        },
        dismissButton = { TextButton(onDismiss) { Text("取消", color = c.textMuted) } },
    )
}

@Composable
private fun PlaylistPick(name: String, icon: String, onClick: () -> Unit) {
    val c = Sonus.colors
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(Shapes.row)).clickable(onClick = onClick).padding(vertical = 12.dp, horizontal = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        KitIcon(icon, size = 16.dp, tint = c.textMuted)
        Spacer(Modifier.width(12.dp))
        Text(name, style = Sonus.type.body, color = c.text)
    }
}

/** 属性: the song's audio details (NowPlayingPane.cs's 音频信息). */
@Composable
fun TrackInfoDialog(t: Track, onDismiss: () -> Unit) {
    val c = Sonus.colors
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = c.raised,
        title = { Text(t.title, style = Sonus.type.panelHeading, color = c.text) },
        text = { AudioFacts(t) },
        confirmButton = { TextButton(onDismiss) { Text("关闭", color = c.accentText) } },
    )
}

/** 编码, 采样率, 位深, 比特率, 回放增益, 文件大小, 播放次数, 位置. */
@Composable
fun AudioFacts(t: Track, modifier: Modifier = Modifier) {
    val c = Sonus.colors
    val rows = listOf(
        "编码" to t.codec,
        "采样率" to if (t.sampleRate > 0) "${Formats.khz(t.sampleRate)} kHz" else "—",
        "位深" to when {
            t.bitDepth == 1 -> "1 bit (DSD)"
            t.bitDepth > 1 -> "${t.bitDepth} bit"
            else -> "—"
        },
        "比特率" to if (t.bitrate > 0) "${t.bitrate} kbps" else "—",
        "回放增益" to (t.albumGain ?: t.trackGain)?.let { "%+.1f dB".format(it) }.orEmpty().ifEmpty { "—" },
        "文件大小" to if (t.size > 0) Formats.size(t.size) else "—",
        "播放次数" to "${t.playCount}",
        "位置" to t.path.ifEmpty { "—" },
    )
    Column(modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        rows.forEach { (k, v) ->
            Row {
                Text(k, style = Sonus.type.bodySmall, color = c.textMuted, modifier = Modifier.width(72.dp))
                Text(v, style = Sonus.type.bodySmall, color = c.text, maxLines = 3, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

/**
 * A card on a shelf or in a grid (ViewParts.cs:133-169): the cover (round for an artist), the title, a muted line. Its
 * amber button shows while its songs play.
 */
@Composable
fun MediaCard(
    title: String,
    subtitle: String,
    width: Dp,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    playing: Boolean? = null,
    onPlay: (() -> Unit)? = null,
    cover: @Composable (Dp, Shape) -> Unit,
) {
    val c = Sonus.colors
    val round = RoundedCornerShape(Shapes.panel)
    Column(modifier.width(width).clip(RoundedCornerShape(Shapes.panel)).pressable(onClick).padding(bottom = 4.dp)) {
        Box {
            cover(width, round)
            if (playing != null && onPlay != null) {
                PlayButton(playing, 40.dp, onPlay, Modifier.align(Alignment.BottomEnd).padding(8.dp))
            }
        }
        Spacer(Modifier.size(8.dp))
        Text(title, style = Sonus.type.cardTitle, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(subtitle, style = Sonus.type.caption, color = c.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** A card for an album, artist or playlist by its kind and id ("album", "artist", "playlist"). */
@Composable
fun CardFor(type: String, id: String, width: Dp, modifier: Modifier = Modifier) {
    val session = LocalSession.current
    val player = LocalPlayer.current
    val nav = LocalNav.current
    val lib = session.lib
    val state by player.state.collectAsState()
    val playingHere = state.context?.let { it.kind == type && it.id == id } == true
    val play = {
        if (playingHere) player.togglePlay() else session.contextOf(type, id).let { (ctx, ids) -> player.play(ctx, ids) }
    }
    when (type) {
        "album" -> {
            val a = lib.album(id) ?: return
            MediaCard(a.title, listOf(a.year.takeIf { it > 0 }?.toString(), a.artist).filterNotNull().joinToString(" · "), width, { nav.go(Route.Album(id)) }, modifier,
                playing = if (playingHere) state.isActive else null, onPlay = play) { w, s -> Cover(session.coverUrl(id, w.px()), w, shape = s) }
        }
        "artist" -> {
            val a = lib.artist(id) ?: return
            MediaCard(a.name, "艺人", width, { nav.go(Route.Artist(id)) }, modifier, playing = if (playingHere) state.isActive else null, onPlay = play) { w, _ ->
                Cover(session.coverUrl(a.albumIds.firstOrNull(), w.px()), w, shape = CircleShape, placeholder = "artist")
            }
        }
        "playlist" -> {
            val p = session.playlist(id) ?: return
            MediaCard(p.name, if (p.kind == PlaylistKind.Liked) "歌单 · ${p.entries.size} 首歌曲" else "歌单 · ${p.owner}", width, { nav.go(Route.Playlist(id)) }, modifier,
                playing = if (playingHere) state.isActive else null, onPlay = play) { w, s -> PlaylistCover(id, w, s) }
        }
    }
}

/** A playlist's cover: the special covers, else the cover of its first song's album. */
@Composable
fun PlaylistCover(id: String, size: Dp, shape: Shape = RoundedCornerShape(Shapes.smallCover)) {
    val session = LocalSession.current
    val p = session.playlist(id)
    when {
        p == null -> Cover(null, size, shape = shape, placeholder = "playlist")
        p.kind == PlaylistKind.Liked -> SpecialCover("liked", size, shape = shape)
        p.kind == PlaylistKind.Library -> SpecialCover("library", size, shape = shape)
        else -> Cover(session.coverUrl(p.trackIds.firstNotNullOfOrNull { session.lib.track(it)?.albumId }, size.px()), size, shape = shape, placeholder = "playlist")
    }
}
