package com.creeperux.sonus.ui.components

import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
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
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import coil3.compose.SubcomposeAsyncImage
import com.creeperux.sonus.ui.icons.KitIcon
import com.creeperux.sonus.ui.theme.Shapes
import com.creeperux.sonus.ui.theme.Sonus

/** On-screen pixels of a size in dp (what a cover is asked for at). */
@Composable
fun Dp.px(): Int = with(LocalDensity.current) { this@px.roundToPx() }

/**
 * A cover: the image when there is one, else the raised colour with an icon. [url] comes from
 * MusicSession.coverUrl(albumId, size.px()), so the server is asked for the size the Windows app would ask.
 */
@Composable
fun Cover(url: String?, size: Dp, modifier: Modifier = Modifier, shape: Shape = RoundedCornerShape(Shapes.smallCover), placeholder: String = "album") {
    val c = Sonus.colors
    Box(modifier.size(size).clip(shape).background(c.raised), contentAlignment = Alignment.Center) {
        if (url == null) {
            KitIcon(placeholder, size = size * 0.32f, tint = c.textQuiet)
        } else {
            SubcomposeAsyncImage(
                model = url, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize(),
                loading = {}, error = { Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { KitIcon(placeholder, size = size * 0.32f, tint = c.textQuiet) } },
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

/** A tap target that grows a little when pressed (the Windows app's 0.97 / 1.04 button motion, pressed only). */
@Composable
fun Modifier.pressable(onClick: () -> Unit, label: String? = null, enabled: Boolean = true): Modifier {
    val source = remember { MutableInteractionSource() }
    val pressed by source.collectIsPressedAsState()
    return this
        .scale(if (pressed) 0.96f else 1f)
        .then(if (label != null) Modifier.semantics { contentDescription = label } else Modifier)
        .clickable(interactionSource = source, indication = null, enabled = enabled, role = Role.Button, onClick = onClick)
}

/** The round amber play button of pages and cards. */
@Composable
fun PlayButton(playing: Boolean, size: Dp, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val c = Sonus.colors
    Box(
        modifier.size(size).clip(CircleShape).background(c.accent).pressable(onClick, if (playing) "暂停" else "播放"),
        contentAlignment = Alignment.Center,
    ) {
        KitIcon(if (playing) "pause" else "play", size = size * 0.36f, tint = c.onAccent)
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
    val t = rememberInfiniteTransition(label = "bars")
    val periods = intArrayOf(820, 1060, 740)
    val levels = periods.mapIndexed { i, ms ->
        t.animateFloat(0.25f + i * 0.1f, 1f, infiniteRepeatable(tween(ms / 2, easing = FastOutSlowInEasing), RepeatMode.Reverse), label = "bar$i")
    }
    Row(modifier.height(height), horizontalArrangement = Arrangement.spacedBy(2.dp), verticalAlignment = Alignment.Bottom) {
        levels.forEach { l ->
            Box(Modifier.width(3.dp).fillMaxHeight(if (playing) l.value else 0.3f).clip(RoundedCornerShape(1.dp)).background(color))
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
