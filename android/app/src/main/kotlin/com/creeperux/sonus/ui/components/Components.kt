package com.creeperux.sonus.ui.components

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.animation.togetherWith
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import coil3.compose.AsyncImage
import coil3.compose.LocalPlatformContext
import coil3.memory.MemoryCache
import coil3.request.ImageRequest
import coil3.request.crossfade
import com.creeperux.sonus.ui.LocalMotion
import com.creeperux.sonus.ui.Motion
import com.creeperux.sonus.ui.pressScale
import com.creeperux.sonus.ui.rememberHaptics
import com.creeperux.sonus.ui.icons.KitIcon
import com.creeperux.sonus.ui.theme.Shapes
import com.creeperux.sonus.ui.theme.Sonus

/** On-screen pixels of a size in dp (what a cover is asked for at). */
@Composable
fun Dp.px(): Int = with(LocalDensity.current) { this@px.roundToPx() }

/**
 * A cover: the image when there is one, else the raised colour with an icon. [url] comes from
 * MusicSession.coverUrl(albumId, size.px()), so the server is asked for the size the Windows app would ask. The image
 * fades in over the raised colour (Coil's crossfade; AsyncImage, not a subcomposition per row, so long lists scroll
 * lightly). With [follows], a new image cross-fades from the one before (the player's cover when the song changes)
 * instead of from the empty colour.
 */
@Composable
fun Cover(url: String?, size: Dp, modifier: Modifier = Modifier, shape: Shape = RoundedCornerShape(Shapes.smallCover), placeholder: String = "album", follows: Boolean = false) {
    val c = Sonus.colors
    val context = LocalPlatformContext.current
    var shown by remember(url) { mutableStateOf(false) } // the image is there: the icon under it is not drawn
    val previous = remember { mutableStateOf<MemoryCache.Key?>(null) }
    Box(modifier.size(size).clip(shape).background(c.raised), contentAlignment = Alignment.Center) {
        if (url == null || !shown) KitIcon(placeholder, size = size * 0.32f, tint = c.textQuiet)
        if (url != null) {
            val request = remember(url) {
                ImageRequest.Builder(context).data(url).crossfade(if (follows) Motion.SHEET else 180)
                    .apply { if (follows) previous.value?.let { placeholderMemoryCacheKey(it) } }
                    .build()
            }
            AsyncImage(
                model = request, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize(),
                onSuccess = { shown = true; previous.value = it.result.memoryCacheKey },
            )
        }
    }
}

/** The covers of 我喜欢的音乐 (a gold gradient with a heart) and of the library (slate with the library icon). */
@Composable
fun SpecialCover(kind: String, size: Dp, modifier: Modifier = Modifier, shape: Shape = RoundedCornerShape(Shapes.smallCover)) {
    val brush = if (kind == "liked") {
        Brush.linearGradient(0f to Color(0xFF8A6200), 0.55f to Color(0xFFF8B700), 1f to Color(0xFFFFE08A))
    } else {
        Brush.linearGradient(listOf(Color(0xFF2C3A42), Color(0xFF5F7B88)))
    }
    Box(modifier.size(size).clip(shape).background(brush), contentAlignment = Alignment.Center) {
        KitIcon(if (kind == "liked") "heart-filled" else "library", size = size * 0.34f, tint = if (kind == "liked") Color(0xFF111416) else Color(0xFFF4F1EB))
    }
}

/** A tap target that gives a little when pressed and comes back (the Windows app's press and release: 60 and 120 ms). */
@Composable
fun Modifier.pressable(onClick: () -> Unit, label: String? = null, enabled: Boolean = true, onLongClick: (() -> Unit)? = null): Modifier {
    val source = remember { MutableInteractionSource() }
    val haptics = rememberHaptics()
    return this
        .pressScale(source)
        .then(if (label != null) Modifier.semantics { contentDescription = label } else Modifier)
        .combinedClickable(
            interactionSource = source, indication = null, enabled = enabled, role = Role.Button, onClick = onClick,
            onLongClick = onLongClick?.let { long -> { haptics.longPress(); long() } },
        )
}

/** Play or pause, the one turning into the other (a quick scale and fade, as the Windows bar's icon pop). */
@Composable
fun PlayPauseIcon(playing: Boolean, size: Dp, tint: Color) {
    AnimatedContent(
        playing,
        transitionSpec = {
            (scaleIn(tween(Motion.CONTROL, easing = Motion.EaseOut), initialScale = 0.6f) + fadeIn(tween(Motion.ENTER))) togetherWith
                (scaleOut(tween(Motion.EXIT), targetScale = 0.6f) + fadeOut(tween(Motion.EXIT)))
        },
        contentAlignment = Alignment.Center,
        label = "play-pause",
    ) { on -> KitIcon(if (on) "pause" else "play", size = size, tint = tint) }
}

/** The round amber play button of pages and cards. */
@Composable
fun PlayButton(playing: Boolean, size: Dp, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val c = Sonus.colors
    val haptics = rememberHaptics()
    Box(
        modifier.size(size).clip(CircleShape).background(c.accent).pressable({ haptics.tap(); onClick() }, if (playing) "暂停" else "播放"),
        contentAlignment = Alignment.Center,
    ) {
        PlayPauseIcon(playing, size * 0.36f, c.onAccent)
    }
}

/** A round icon button: on the raised colour, or bare. [on] marks a mode that is on (amber with a dot under it). */
@Composable
fun RoundButton(
    icon: String,
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    size: Dp = 44.dp,
    iconSize: Dp = 18.dp,
    raised: Boolean = false,
    on: Boolean = false,
    tint: Color? = null,
    enabled: Boolean = true,
) {
    val c = Sonus.colors
    Box(
        modifier.size(size).clip(CircleShape).then(if (raised) Modifier.background(c.raised) else Modifier).pressable(onClick, label, enabled),
        contentAlignment = Alignment.Center,
    ) {
        KitIcon(icon, size = iconSize, tint = tint ?: if (on) c.accentText else if (enabled) c.text else c.textQuiet)
        if (on) Box(Modifier.align(Alignment.BottomCenter).padding(bottom = size * 0.12f).size(4.dp).clip(CircleShape).background(c.accentText))
    }
}

/** A filter chip (歌单 / 专辑 / 艺人 …): Material 3's FilterChip in the Sonus colours (raised; ink when selected). */
@Composable
fun Chip(text: String, selected: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val c = Sonus.colors
    FilterChip(
        selected = selected,
        onClick = onClick,
        label = { Text(text, style = Sonus.type.bodySmall, maxLines = 1) },
        modifier = modifier,
        shape = RoundedCornerShape(Shapes.chip),
        colors = FilterChipDefaults.filterChipColors(
            containerColor = c.raised, labelColor = c.text,
            selectedContainerColor = c.text, selectedLabelColor = c.panel,
        ),
        border = null,
    )
}

/** A pill button with text (登录, 重试 …): Material 3's Button, amber when [primary], else raised. */
@Composable
fun PillButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, primary: Boolean = false, enabled: Boolean = true, icon: String? = null) {
    val c = Sonus.colors
    val colors = if (primary) {
        ButtonDefaults.buttonColors(containerColor = c.accent, contentColor = c.onAccent, disabledContainerColor = c.accent.copy(alpha = 0.45f), disabledContentColor = c.onAccent.copy(alpha = 0.6f))
    } else {
        ButtonDefaults.buttonColors(containerColor = c.raised, contentColor = c.text, disabledContainerColor = c.raised, disabledContentColor = c.textQuiet)
    }
    Button(onClick, modifier.height(44.dp), enabled = enabled, shape = RoundedCornerShape(22.dp), colors = colors, contentPadding = PaddingValues(horizontal = 20.dp)) {
        if (icon != null) {
            KitIcon(icon, size = 16.dp, tint = LocalContentColor.current)
            Spacer(Modifier.width(8.dp))
        }
        Text(text, style = Sonus.type.cardTitle, maxLines = 1)
    }
}

/** The three bars that move beside the playing song (KitIcon.cs: 3 px bars, 0.82 / 1.06 / 0.74 s). */
@Composable
fun LevelBars(playing: Boolean, modifier: Modifier = Modifier, color: Color = Sonus.colors.accentText, height: Dp = 14.dp) {
    val moving = playing && LocalMotion.current // with animations off, still bars
    val t = rememberInfiniteTransition(label = "bars")
    val periods = intArrayOf(820, 1060, 740)
    val levels = periods.mapIndexed { i, ms ->
        t.animateFloat(0.25f + i * 0.1f, 1f, infiniteRepeatable(tween(ms / 2, easing = FastOutSlowInEasing), RepeatMode.Reverse), label = "bar$i")
    }
    Row(modifier.height(height), horizontalArrangement = Arrangement.spacedBy(2.dp), verticalAlignment = Alignment.Bottom) {
        levels.forEachIndexed { i, l ->
            // drawn smaller, not laid out again: the bars move without recomposing the row
            Box(
                Modifier.width(3.dp).fillMaxHeight()
                    .graphicsLayer {
                        scaleY = if (moving) l.value else if (playing) 0.55f + i * 0.15f else 0.3f
                        transformOrigin = TransformOrigin(0.5f, 1f)
                    }
                    .clip(RoundedCornerShape(1.dp)).background(color),
            )
        }
    }
}

/** A section title with an optional link on the right ("显示全部"). */
@Composable
fun SectionHeader(title: String, modifier: Modifier = Modifier, action: String? = null, onAction: (() -> Unit)? = null) {
    val c = Sonus.colors
    Row(modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(title, style = Sonus.type.section, color = c.text, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
        if (action != null && onAction != null) {
            Text(action, style = Sonus.type.bodySmall, color = c.textMuted, modifier = Modifier.clip(RoundedCornerShape(6.dp)).clickable(onClick = onAction).padding(8.dp))
        }
    }
}

/** A quiet message where a list is empty, or something could not be found. */
@Composable
fun EmptyState(title: String, body: String? = null, icon: String = "music", modifier: Modifier = Modifier, action: (@Composable () -> Unit)? = null) {
    val c = Sonus.colors
    Column(modifier.fillMaxWidth().padding(PaddingValues(32.dp)), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
        KitIcon(icon, size = 32.dp, tint = c.textQuiet)
        Text(title, style = Sonus.type.panelHeading, color = c.text)
        if (body != null) Text(body, style = Sonus.type.muted, color = c.textMuted)
        action?.invoke()
    }
}
