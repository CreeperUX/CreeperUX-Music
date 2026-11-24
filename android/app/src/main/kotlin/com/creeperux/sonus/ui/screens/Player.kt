package com.creeperux.sonus.ui.screens

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.setProgress
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.creeperux.sonus.core.Formats
import com.creeperux.sonus.core.LyricLine
import com.creeperux.sonus.core.LyricsParser
import com.creeperux.sonus.core.PlaybackOrder
import com.creeperux.sonus.core.PlayQueue
import com.creeperux.sonus.core.Track
import com.creeperux.sonus.playback.PlayerStatus
import com.creeperux.sonus.ui.LocalNav
import com.creeperux.sonus.ui.LocalPlayer
import com.creeperux.sonus.ui.LocalSession
import com.creeperux.sonus.ui.OnlineDot
import com.creeperux.sonus.ui.PanelView
import com.creeperux.sonus.ui.PlayerView
import com.creeperux.sonus.ui.Route
import com.creeperux.sonus.ui.components.AudioFacts
import com.creeperux.sonus.ui.components.Cover
import com.creeperux.sonus.ui.components.EmptyState
import com.creeperux.sonus.ui.components.RoundButton
import com.creeperux.sonus.ui.components.TrackMenu
import com.creeperux.sonus.ui.components.pressable
import com.creeperux.sonus.ui.components.px
import com.creeperux.sonus.ui.components.rememberCoverColor
import com.creeperux.sonus.ui.components.shade
import com.creeperux.sonus.ui.icons.KitIcon
import com.creeperux.sonus.ui.theme.Display
import com.creeperux.sonus.ui.theme.Shapes
import com.creeperux.sonus.ui.theme.Sonus
import kotlinx.coroutines.launch

// ---------------------------------------------------------------- shared parts

@Composable
private fun currentTrack(): Track? {
    val session = LocalSession.current
    val player = LocalPlayer.current
    val state by player.state.collectAsState()
    session.revisionState.collectAsState().value
    return session.lib.track(state.trackId)
}

/** The position bar with the times under it; tapping or dragging shows where it will go and seeks on release. */
@Composable
fun SeekBar(modifier: Modifier = Modifier, light: Boolean = false) {
    val c = Sonus.colors
    val player = LocalPlayer.current
    val state by player.state.collectAsState()
    val position by player.position.collectAsState()
    var dragging by remember { mutableStateOf(false) }
    var drag by remember { mutableFloatStateOf(0f) }
    val duration = state.duration.coerceAtLeast(0.0)
    val shown = if (dragging) drag.toDouble() else position.coerceIn(0.0, if (duration > 0) duration else 0.0)
    val text = if (light) Color.White else c.text
    Column(modifier) {
        BoxWithConstraints(
            Modifier
                .fillMaxWidth()
                .height(24.dp)
                .semantics {
                    progressBarRangeInfo = ProgressBarRangeInfo(shown.toFloat(), 0f..(if (duration > 0) duration.toFloat() else 1f))
                    setProgress { v -> player.seek(v.toDouble()); true }
                }
                .pointerInput(duration) {
                    if (duration <= 0) return@pointerInput
                    detectTapGestures { o -> player.seek((o.x / size.width).coerceIn(0f, 1f) * duration) }
                }
                .pointerInput(duration) {
                    if (duration <= 0) return@pointerInput
                    fun at(x: Float) = ((x / size.width).coerceIn(0f, 1f) * duration).toFloat()
                    detectHorizontalDragGestures(
                        onDragStart = { o -> dragging = true; drag = at(o.x) },
                        onDragEnd = { player.seek(drag.toDouble()); dragging = false },
                        onDragCancel = { dragging = false },
                    ) { change, _ -> drag = at(change.position.x) }
                }
                .testTag("seek"),
            contentAlignment = Alignment.CenterStart,
        ) {
            val f = if (duration > 0) (shown / duration).toFloat().coerceIn(0f, 1f) else 0f
            Box(Modifier.fillMaxWidth().height(4.dp).clip(RoundedCornerShape(2.dp)).background(text.copy(alpha = 0.22f)))
            Box(Modifier.fillMaxWidth(f).height(4.dp).clip(RoundedCornerShape(2.dp)).background(if (dragging) c.accent else text))
            Box(Modifier.offset(x = maxWidth * f - 6.dp).size(12.dp).clip(CircleShape).background(text))
        }
        Row {
            Text(Formats.duration(shown), style = Sonus.type.numbers, color = text.copy(alpha = 0.7f), modifier = Modifier.testTag("position"))
            Spacer(Modifier.weight(1f))
            Text(Formats.duration(duration), style = Sonus.type.numbers, color = text.copy(alpha = 0.7f))
        }
    }
}

/** Shuffle, previous, play (a white circle, as the Windows bar), next, repeat. */
@Composable
fun Controls(big: Boolean, modifier: Modifier = Modifier, light: Boolean = false) {
    val c = Sonus.colors
    val player = LocalPlayer.current
    val state by player.state.collectAsState()
    val shuffled = PlayQueue.shuffled(state.order)
    val repeat = state.order == PlaybackOrder.RepeatPlaylist || state.order == PlaybackOrder.RepeatTrack
    val fg = if (light) Color.White else c.text
    val playSize = if (big) 68.dp else 40.dp
    Row(modifier, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = if (big) Arrangement.SpaceBetween else Arrangement.spacedBy(12.dp)) {
        RoundButton("shuffle", "随机播放", { player.setOrder(if (shuffled) PlaybackOrder.Default else PlaybackOrder.ShuffleTracks) }, on = shuffled, tint = if (shuffled) c.accent else fg, size = if (big) 48.dp else 36.dp)
        RoundButton("skip-previous", "上一首", player::previous, tint = fg, size = if (big) 56.dp else 36.dp, iconSize = if (big) 26.dp else 18.dp)
        Box(
            Modifier.size(playSize).clip(CircleShape).background(if (light) Color.White else c.playButton).pressable(player::togglePlay, if (state.isActive) "暂停" else "播放").testTag("play-pause"),
            contentAlignment = Alignment.Center,
        ) {
            KitIcon(if (state.isActive) "pause" else "play", size = playSize * 0.38f, tint = if (light) Color(0xFF111416) else c.onPlayButton)
        }
        RoundButton("skip-next", "下一首", player::next, tint = fg, size = if (big) 56.dp else 36.dp, iconSize = if (big) 26.dp else 18.dp)
        RoundButton(
            if (state.order == PlaybackOrder.RepeatTrack) "repeat-one" else "repeat",
            when (state.order) { PlaybackOrder.RepeatPlaylist -> "列表循环"; PlaybackOrder.RepeatTrack -> "单曲循环"; else -> "循环播放" },
            {
                player.setOrder(
                    when (state.order) {
                        PlaybackOrder.RepeatPlaylist -> PlaybackOrder.RepeatTrack
                        PlaybackOrder.RepeatTrack -> PlaybackOrder.Default
                        else -> PlaybackOrder.RepeatPlaylist
                    },
                )
            },
            on = repeat, tint = if (repeat) c.accent else fg, size = if (big) 48.dp else 36.dp,
        )
    }
}

@Composable
private fun Heart(t: Track, light: Boolean = false, size: Dp = 40.dp) {
    val c = Sonus.colors
    val session = LocalSession.current
    val scope = rememberCoroutineScope()
    var pop by remember { mutableStateOf(false) }
    val scale by animateFloatAsState(if (pop) 1.28f else 1f, tween(140), finishedListener = { pop = false }, label = "like")
    RoundButton(
        if (t.liked) "heart-filled" else "heart", if (t.liked) "取消喜欢" else "喜欢",
        {
            pop = !t.liked
            scope.launch { session.setLiked(t.id, !t.liked) }
        },
        Modifier.scale(scale).testTag("like"), size = size,
        tint = if (t.liked) c.accent else if (light) Color.White.copy(alpha = 0.8f) else c.textMuted,
    )
}

// ---------------------------------------------------------------- the phone

/** The bar above the phone's tabs: the song, play/pause, and a thin line of progress. Tapping it opens the player. */
@Composable
fun MiniPlayer(open: () -> Unit) {
    val c = Sonus.colors
    val session = LocalSession.current
    val player = LocalPlayer.current
    val state by player.state.collectAsState()
    val position by player.position.collectAsState()
    val t = currentTrack() ?: return
    val tint = rememberCoverColor(session.trackCoverUrl(t, 64))
    val back by animateColorAsState(tint?.let { if (c.isDark) lerp(c.raised, it.shade(0.35f), 0.7f) else lerp(c.raised, it, 0.18f) } ?: c.raised, tween(400), label = "mini")
    Box(Modifier.fillMaxWidth().background(c.panel).padding(horizontal = 8.dp, vertical = 6.dp)) {
        Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(Shapes.panel)).background(back).clickable(onClick = open).testTag("mini-player")) {
            Row(Modifier.fillMaxWidth().padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Cover(session.trackCoverUrl(t, 44.dp.px()), 44.dp)
                Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f)) {
                    Text(t.title, style = Sonus.type.cardTitle, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(
                        if (state.status == PlayerStatus.Error) state.error.orEmpty() else t.artist,
                        style = Sonus.type.caption, color = if (state.status == PlayerStatus.Error) c.bad else c.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    )
                }
                Heart(t, size = 40.dp)
                RoundButton(if (state.isActive) "pause" else "play", if (state.isActive) "暂停" else "播放", player::togglePlay, Modifier.testTag("mini-play"), size = 44.dp, iconSize = 20.dp)
            }
            val d = state.duration
            val f = if (d > 0) (position / d).toFloat().coerceIn(0f, 1f) else 0f
            Box(Modifier.fillMaxWidth().padding(horizontal = 8.dp).height(2.dp).clip(RoundedCornerShape(1.dp)).background(c.text.copy(alpha = 0.15f))) {
                Box(Modifier.fillMaxWidth(f).fillMaxHeight().background(c.text))
            }
        }
    }
}

/**
 * The phone's player, full screen over the app: the cover large (or the lyrics, or the queue), the song, the position
 * and the controls, on the cover's colour.
 */
@Composable
fun FullPlayer() {
    val c = Sonus.colors
    val session = LocalSession.current
    val nav = LocalNav.current
    val player = LocalPlayer.current
    val state by player.state.collectAsState()
    val t = currentTrack()
    val tint = rememberCoverColor(t?.let { session.trackCoverUrl(it, 64) })
    val top by animateColorAsState(tint?.let { lerp(Color(0xFF151B1F), it, 0.85f) } ?: Color(0xFF20272C), tween(500), label = "top")
    val view = nav.playerView.value
    var menu by remember { mutableStateOf(false) }
    Column(
        Modifier
            .fillMaxSize()
            .background(Brush.verticalGradient(0f to top, 0.6f to top.shade(0.55f), 1f to Color(0xFF040607)))
            .clickable(enabled = false) {}
            .statusBarsPadding()
            .navigationBarsPadding()
            .padding(horizontal = 24.dp)
            .testTag("full-player"),
    ) {
        Row(Modifier.fillMaxWidth().padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            RoundButton("chevron-down", "收起", { nav.playerOpen.value = false }, tint = Color.White)
            Column(Modifier.weight(1f), horizontalAlignment = Alignment.CenterHorizontally) {
                Text("正在播放", style = Sonus.type.caption, color = Color.White.copy(alpha = 0.7f))
                Text(state.context?.label.orEmpty(), style = Sonus.type.cardTitle, color = Color.White, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Box {
                RoundButton("more-vertical", "更多", { menu = true }, tint = Color.White)
                if (t != null) TrackMenu(t, menu, { menu = false })
            }
        }
        Box(Modifier.weight(1f).fillMaxWidth().padding(vertical = 16.dp), contentAlignment = Alignment.Center) {
            when (view) {
                PlayerView.Cover -> BoxWithConstraints(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    val side = minOf(maxWidth, maxHeight)
                    Box(Modifier.size(side).shadow(28.dp, RoundedCornerShape(Shapes.panel))) {
                        Cover(t?.let { session.trackCoverUrl(it, side.px()) }, side, shape = RoundedCornerShape(Shapes.panel))
                    }
                }
                PlayerView.Lyrics -> if (t != null) LyricsView(t, LyricsStyle.Full, light = true)
                PlayerView.Queue -> QueueView(light = true)
            }
        }
        if (t != null) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(t.title, style = Sonus.type.nowPlaying, color = Color.White, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.clickable { nav.go(Route.Album(t.albumId)) }.testTag("now-title"))
                    Text(t.artist, style = Sonus.type.body, color = Color.White.copy(alpha = 0.7f), maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.clickable { nav.go(Route.Artist(t.artistId)) })
                }
                Heart(t, light = true)
            }
            if (state.status == PlayerStatus.Error) Text(state.error.orEmpty(), style = Sonus.type.caption, color = c.bad)
        }
        Spacer(Modifier.height(12.dp))
        SeekBar(light = true)
        Spacer(Modifier.height(8.dp))
        Controls(big = true, Modifier.fillMaxWidth(), light = true)
        Row(Modifier.fillMaxWidth().padding(vertical = 12.dp), horizontalArrangement = Arrangement.SpaceBetween) {
            RoundButton("lyrics", "歌词", { nav.playerView.value = if (view == PlayerView.Lyrics) PlayerView.Cover else PlayerView.Lyrics }, Modifier.testTag("show-lyrics"), on = view == PlayerView.Lyrics, tint = if (view == PlayerView.Lyrics) c.accent else Color.White)
            RoundButton("queue", "播放队列", { nav.playerView.value = if (view == PlayerView.Queue) PlayerView.Cover else PlayerView.Queue }, Modifier.testTag("show-queue"), on = view == PlayerView.Queue, tint = if (view == PlayerView.Queue) c.accent else Color.White)
        }
    }
}

// ---------------------------------------------------------------- lyrics

enum class LyricsStyle { Card, Full }

/**
 * Lyrics that follow the song (LyricsParser): the line playing is bright and kept in view, sung lines dimmer, lines to
 * come dimmer still; tapping a synced line plays from there. A positive offset in the server's lyrics shows them sooner
 * (SubsonicClient.lyrics). Lyrics without times are shown as text.
 */
@Composable
fun LyricsView(t: Track, style: LyricsStyle, modifier: Modifier = Modifier, light: Boolean = false) {
    val c = Sonus.colors
    val session = LocalSession.current
    val player = LocalPlayer.current
    val position by player.position.collectAsState()
    val lines by produceState<List<LyricLine>?>(null, t.id) { value = runCatching { session.lyrics(t) }.getOrNull() ?: emptyList() }
    val list = lines
    val fg = if (light) Color.White else c.text
    if (list == null) {
        Box(modifier.fillMaxSize())
        return
    }
    if (list.isEmpty()) {
        Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text("这首歌没有歌词", style = Sonus.type.body, color = fg.copy(alpha = 0.6f), modifier = Modifier.testTag("no-lyrics"))
        }
        return
    }
    val now = LyricsParser.currentLine(list, position)
    val listState = rememberLazyListState()
    BoxWithConstraints(modifier.fillMaxSize()) {
        val lead = if (style == LyricsStyle.Full) maxHeight / 3 else 24.dp
        LaunchedEffect(now) {
            if (now >= 0) listState.animateScrollToItem(now)
        }
        val textStyle = if (style == LyricsStyle.Full) Sonus.type.lyric else TextStyle(fontWeight = FontWeight.Bold, fontSize = 16.sp, lineHeight = 22.sp)
        LazyColumn(Modifier.fillMaxSize().testTag("lyrics"), state = listState, contentPadding = PaddingValues(top = lead, bottom = maxHeight)) {
            itemsIndexed(list) { i, line ->
                val alpha = when {
                    now < 0 && line.time == null -> 0.9f
                    i == now -> 1f
                    style == LyricsStyle.Card -> 0.45f
                    i < now -> 0.6f
                    else -> 0.38f
                }
                val a by animateFloatAsState(alpha, tween(250), label = "line")
                val s by animateFloatAsState(if (i == now || style == LyricsStyle.Card) 1f else 0.94f, tween(250), label = "scale")
                Text(
                    line.text.ifEmpty { "♪" },
                    style = textStyle,
                    color = fg.copy(alpha = a),
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = if (style == LyricsStyle.Full) 8.dp else 4.dp)
                        .graphicsLayer { scaleX = s; scaleY = s; transformOrigin = TransformOrigin(0f, 0.5f) }
                        .then(if (line.time != null) Modifier.clickable { player.seek(line.time!!) } else Modifier)
                        .then(if (i == now) Modifier.testTag("lyric-now") else Modifier),
                )
            }
        }
    }
}

/** The tablet's lyrics page: full height, on the cover's colour (OtherPages.cs:189-266). */
@Composable
fun LyricsPage() {
    val session = LocalSession.current
    val t = currentTrack()
    val tint = rememberCoverColor(t?.let { session.trackCoverUrl(it, 64) })
    val c = Sonus.colors
    val back = tint?.let { lerp(c.panel, it, 0.7f) } ?: c.raised
    Box(Modifier.fillMaxSize().background(Brush.verticalGradient(listOf(back, back.shade(0.4f)))).padding(horizontal = 48.dp)) {
        if (t == null) EmptyState("还没有播放任何歌曲", "点任意歌曲开始播放。")
        else LyricsView(t, LyricsStyle.Full, light = true)
    }
}

// ---------------------------------------------------------------- the queue

/**
 * The queue (NowPlayingPane.cs:192-260): 正在播放, then the songs queued by hand (接下来播放) and what follows in the
 * context (接下来：…, at most 100), each section with 清除; a row's ✕ removes it, a tap plays it.
 */
@Composable
fun QueueView(modifier: Modifier = Modifier, light: Boolean = false) {
    val c = Sonus.colors
    val session = LocalSession.current
    val player = LocalPlayer.current
    val state by player.state.collectAsState()
    val fg = if (light) Color.White else c.text
    val muted = fg.copy(alpha = 0.65f)
    val entries = remember(state.queueVersion, state.trackId) { player.queueEntries }
    val manual = entries.filter { it.manual }
    val context = entries.filter { !it.manual }.take(100)
    val current = session.lib.track(state.trackId)
    LazyColumn(modifier.fillMaxSize().testTag("queue")) {
        item { Heading("正在播放", fg) }
        if (current == null) {
            item { Text("队列里没有歌曲", style = Sonus.type.body, color = muted, modifier = Modifier.padding(vertical = 8.dp)) }
        } else {
            item { QueueRow(current, true, null, fg, muted, {}) }
        }
        if (manual.isNotEmpty()) {
            item { Heading("接下来播放", fg, "清除") { player.queueClear(manual = true) } }
            items(manual, key = { it.id }) { e ->
                session.lib.track(e.trackId)?.let { QueueRow(it, false, { player.queueRemove(listOf(e.id)) }, fg, muted) { player.queueJump(e.id) } }
            }
        }
        if (context.isNotEmpty()) {
            item { Heading("接下来：${state.context?.label.orEmpty()}", fg, "清除") { player.queueClear(manual = false) } }
            items(context, key = { it.id }) { e ->
                session.lib.track(e.trackId)?.let { QueueRow(it, false, { player.queueRemove(listOf(e.id)) }, fg, muted) { player.queueJump(e.id) } }
            }
        }
    }
}

@Composable
private fun Heading(text: String, fg: Color, action: String? = null, onAction: (() -> Unit)? = null) {
    Row(Modifier.fillMaxWidth().padding(top = 16.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(text, style = Sonus.type.panelHeading, color = fg, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
        if (action != null && onAction != null) Text(action, style = Sonus.type.bodySmall, color = fg.copy(alpha = 0.65f), modifier = Modifier.clip(RoundedCornerShape(6.dp)).clickable(onClick = onAction).padding(6.dp))
    }
}

@Composable
private fun QueueRow(t: Track, playing: Boolean, remove: (() -> Unit)?, fg: Color, muted: Color, onClick: () -> Unit) {
    val c = Sonus.colors
    val session = LocalSession.current
    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(Shapes.row)).clickable(onClick = onClick).padding(vertical = 6.dp).testTag("queue-row"), verticalAlignment = Alignment.CenterVertically) {
        Cover(session.trackCoverUrl(t, 40.dp.px()), 40.dp)
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text(t.title, style = Sonus.type.body, color = if (playing) c.accent else fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(t.artist, style = Sonus.type.caption, color = muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (remove != null) RoundButton("close", "从队列中移除", remove, size = 36.dp, iconSize = 13.dp, tint = muted)
    }
}

// ---------------------------------------------------------------- the tablet

/** The tablet's top bar (MainWindow.xaml:8-57): the app, home and search in the middle, the server, settings, the panel. */
@Composable
fun TabletTopBar() {
    val c = Sonus.colors
    val session = LocalSession.current
    val nav = LocalNav.current
    val scope = rememberCoroutineScope()
    val online by session.online.collectAsState()
    val server by session.serverInfo.collectAsState()
    Row(Modifier.fillMaxWidth().height(64.dp).padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
        Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically) {
            KitIcon("waveform", size = 18.dp, tint = c.accent)
            Spacer(Modifier.width(8.dp))
            Text("Sonus", style = TextStyle(fontFamily = Display, fontWeight = FontWeight.Bold, fontSize = 18.sp), color = c.text)
        }
        RoundButton("home", "首页", { nav.go(Route.Home) }, raised = true, size = 48.dp)
        Spacer(Modifier.width(8.dp))
        SearchField(Modifier.widthIn(max = 480.dp).weight(2f))
        Row(Modifier.weight(1f), horizontalArrangement = Arrangement.End, verticalAlignment = Alignment.CenterVertically) {
            Row(
                Modifier.clip(RoundedCornerShape(16.dp)).background(c.raised).pressable({ if (!online) scope.launch { session.goOnline() } }).padding(horizontal = 12.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                OnlineDot(online)
                Spacer(Modifier.width(8.dp))
                Text(if (online) server.name else "未连接到服务器", style = Sonus.type.caption, color = c.text)
            }
            Spacer(Modifier.width(4.dp))
            RoundButton("settings", "设置", { nav.go(Route.Settings) })
            RoundButton("panel-right", "右侧面板", { nav.panelOpen.value = !nav.panelOpen.value }, on = nav.panelOpen.value)
        }
    }
}

/** The tablet's playback bar (PlaybackBar.cs): the song on the left, the controls and position in the middle, the
 *  lyrics and queue toggles on the right. */
@Composable
fun PlaybackBar() {
    val c = Sonus.colors
    val session = LocalSession.current
    val nav = LocalNav.current
    val t = currentTrack()
    Row(Modifier.fillMaxWidth().height(88.dp).padding(horizontal = 16.dp).testTag("playback-bar"), verticalAlignment = Alignment.CenterVertically) {
        Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically) {
            if (t != null) {
                Cover(session.trackCoverUrl(t, 56.dp.px()), 56.dp)
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f, fill = false)) {
                    Text(t.title, style = Sonus.type.cardTitle, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.clickable { nav.go(Route.Album(t.albumId)) })
                    Text(t.artist, style = Sonus.type.caption, color = c.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.clickable { nav.go(Route.Artist(t.artistId)) })
                }
                Heart(t)
            }
        }
        Column(Modifier.weight(2f).widthIn(max = 720.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Controls(big = false)
            SeekBar(Modifier.fillMaxWidth().widthIn(max = 720.dp))
        }
        Row(Modifier.weight(1f), horizontalArrangement = Arrangement.End, verticalAlignment = Alignment.CenterVertically) {
            val lyricsOn = nav.current == Route.Lyrics
            RoundButton("lyrics", "歌词", { if (lyricsOn) nav.back() else nav.go(Route.Lyrics) }, on = lyricsOn)
            val queueOn = nav.panelOpen.value && nav.panel.value == PanelView.Queue
            RoundButton("queue", "播放队列", {
                if (queueOn) nav.panel.value = PanelView.NowPlaying
                else {
                    nav.panelOpen.value = true
                    nav.panel.value = PanelView.Queue
                }
            }, on = queueOn)
        }
    }
}

/** The tablet's right panel: what plays (with lyrics, the audio, the artist, what comes next), or the queue. */
@Composable
fun RightPanel() {
    val nav = LocalNav.current
    if (nav.panel.value == PanelView.Queue) {
        Column(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
            Row(Modifier.fillMaxWidth().padding(top = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("播放队列", style = Sonus.type.panelHeading, color = Sonus.colors.text, modifier = Modifier.weight(1f))
                RoundButton("close", "关闭", { nav.panel.value = PanelView.NowPlaying }, size = 36.dp, iconSize = 14.dp)
            }
            QueueView()
        }
    } else {
        NowPlayingPanel()
    }
}

@Composable
private fun NowPlayingPanel() {
    val c = Sonus.colors
    val session = LocalSession.current
    val nav = LocalNav.current
    val player = LocalPlayer.current
    val state by player.state.collectAsState()
    val t = currentTrack()
    if (t == null) {
        EmptyState("还没有播放任何歌曲", "点任意歌曲开始播放。")
        return
    }
    val nextId = remember(state.queueVersion, state.trackId) { player.queueEntries.firstOrNull()?.trackId }
    val next = session.lib.track(nextId)
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(state.context?.label?.ifEmpty { null } ?: "正在播放", style = Sonus.type.panelHeading, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
        BoxWithConstraints(Modifier.fillMaxWidth()) {
            Cover(session.trackCoverUrl(t, maxWidth.px()), maxWidth, Modifier.aspectRatio(1f), shape = RoundedCornerShape(Shapes.panel))
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(t.title, style = Sonus.type.nowPlaying, color = c.text, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.clickable { nav.go(Route.Album(t.albumId)) })
                Text(t.artist, style = Sonus.type.body, color = c.textMuted, maxLines = 1, modifier = Modifier.clickable { nav.go(Route.Artist(t.artistId)) })
            }
            Heart(t)
        }
        PanelCard("歌词", action = "全屏查看歌词", onAction = { nav.go(Route.Lyrics) }) {
            Box(Modifier.fillMaxWidth().height(170.dp)) { LyricsView(t, LyricsStyle.Card) }
        }
        PanelCard("音频信息") { AudioFacts(t) }
        session.lib.artist(t.artistId)?.let { ar ->
            PanelCard("关于艺人") {
                Row(Modifier.clickable { nav.go(Route.Artist(ar.id)) }, verticalAlignment = Alignment.CenterVertically) {
                    Cover(session.coverUrl(ar.albumIds.firstOrNull(), 56.dp.px()), 56.dp, shape = CircleShape, placeholder = "artist")
                    Spacer(Modifier.width(12.dp))
                    Column {
                        Text(ar.name, style = Sonus.type.cardTitle, color = c.text)
                        Text("${ar.albumIds.size} 张专辑", style = Sonus.type.caption, color = c.textMuted)
                    }
                }
            }
        }
        if (next != null) {
            PanelCard("接下来播放", action = "打开播放队列", onAction = { nav.panel.value = PanelView.Queue }) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Cover(session.trackCoverUrl(next, 44.dp.px()), 44.dp)
                    Spacer(Modifier.width(12.dp))
                    Column {
                        Text(next.title, style = Sonus.type.cardTitle, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(next.artist, style = Sonus.type.caption, color = c.textMuted, maxLines = 1)
                    }
                }
            }
        }
    }
}

@Composable
private fun PanelCard(title: String, action: String? = null, onAction: (() -> Unit)? = null, content: @Composable () -> Unit) {
    val c = Sonus.colors
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(Shapes.panel)).background(c.raised).padding(16.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(title, style = Sonus.type.panelHeading, color = c.text, modifier = Modifier.weight(1f))
            if (action != null && onAction != null) Text(action, style = Sonus.type.caption, color = c.textMuted, modifier = Modifier.clickable(onClick = onAction))
        }
        Spacer(Modifier.height(10.dp))
        content()
    }
}
