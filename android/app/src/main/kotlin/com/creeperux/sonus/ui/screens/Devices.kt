package com.creeperux.sonus.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.SliderState
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.creeperux.sonus.core.connect.SessionDevice
import com.creeperux.sonus.session.SessionLink
import com.creeperux.sonus.ui.LocalPlayer
import com.creeperux.sonus.ui.LocalSession
import com.creeperux.sonus.ui.components.LevelBars
import com.creeperux.sonus.ui.components.RoundButton
import com.creeperux.sonus.ui.icons.KitIcon
import com.creeperux.sonus.ui.rememberHaptics
import com.creeperux.sonus.ui.theme.Shapes
import com.creeperux.sonus.ui.theme.Sonus

/** Sonus Connect version 2, as last heard (recomposed when the session, its queue, the devices or the connection change). */
@Composable
fun rememberLink(): SessionLink? {
    val player = LocalPlayer.current
    val link by player.link.collectAsState()
    link?.revision?.collectAsState()?.value
    return link
}

/** The device the session plays on when it is not this one (null while this one plays, or none does). */
private fun SessionLink.playingElsewhere(): String? = session.activeDevice?.takeIf { it != id && session.current != null }

/** Where the session plays when not here: "正在「书房电脑」上播放", or "上次在「书房电脑」播放" when nothing plays. With [strip]
 *  shown beside it (the strip says where it plays now), only where it played last. */
@Composable
fun WhereLine(modifier: Modifier = Modifier, light: Boolean = false, besideStrip: Boolean = false) {
    val link = rememberLink() ?: return
    if (besideStrip && link.playingElsewhere() != null) return
    val where = link.where ?: return
    val color = if (light) Sonus.colors.accent else Sonus.colors.accentText
    Row(modifier.testTag("where"), verticalAlignment = Alignment.CenterVertically) {
        KitIcon("computer", size = 11.dp, tint = color)
        Spacer(Modifier.width(5.dp))
        Text(where, style = Sonus.type.caption, color = color, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** The line under the song in the bars says where it played last; while another device plays, the strip says so. */
@Composable
fun showsWhereLine(): Boolean = rememberLink()?.let { it.where != null && it.playingElsewhere() == null } == true

/**
 * Spotify's strip while another device plays: "正在「书房电脑」上播放" in the accent colour, under the phone's mini player and
 * the tablet's playback bar (as under the Windows bar). A tap opens the devices.
 */
@Composable
fun ElsewhereStrip(modifier: Modifier = Modifier) {
    val link = rememberLink() ?: return
    val active = link.playingElsewhere() ?: return
    val c = Sonus.colors
    var open by remember { mutableStateOf(false) }
    val name = link.nameOf(active)
    Row(
        modifier
            .fillMaxWidth()
            .background(c.accent)
            .clickable { open = true }
            .padding(horizontal = 12.dp, vertical = 5.dp)
            .semantics(mergeDescendants = true) { contentDescription = "正在「$name」上播放，选择设备" }
            .testTag("elsewhere"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        KitIcon(iconOf(link.devices.firstOrNull { it.id == active }?.kind ?: "desktop"), size = 13.dp, tint = c.onAccent)
        Spacer(Modifier.width(7.dp))
        Text("正在「$name」上播放", style = Sonus.type.caption.copy(fontWeight = FontWeight.Bold), color = c.onAccent, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
    if (open) DevicesSheet(link) { open = false }
}

/** The devices button (where to play); amber while another device plays. Absent without Sonus Connect version 2. */
@Composable
fun DevicesButton(light: Boolean = false, size: androidx.compose.ui.unit.Dp = 44.dp) {
    val link = rememberLink() ?: return
    var open by remember { mutableStateOf(false) }
    val elsewhere = link.session.activeDevice?.let { it != link.id } == true
    RoundButton(
        "computer", "选择播放设备", { open = true }, Modifier.testTag("devices"), size = size,
        on = elsewhere, tint = if (elsewhere) Sonus.colors.accent else if (light) Color.White else null,
    )
    if (open) DevicesSheet(link) { open = false }
}

/**
 * 连接到设备, as Spotify's Connect panel (and the Windows right panel's DevicesView): the device that plays in a card on top
 * with its volume (when none plays, this one: pressing play plays here, rule 6), the user's other devices under it one
 * row each (a tap moves playback there, a transfer, rule 4; the speaker at the end opens that device's volume, rule 8:
 * this phone's is its media volume), and a hint at the bottom.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DevicesSheet(link: SessionLink, onDismiss: () -> Unit) {
    val c = Sonus.colors
    val session = LocalSession.current
    link.revision.collectAsState().value
    val s = link.session
    val title = session.lib.track(s.current?.trackId)?.title ?: s.now?.title
    // this device first, then the others as they joined, and the one that plays while it is away (its grace period)
    val here = SessionDevice(link.id, link.hereName, if (link.hereName == "这台平板") "tablet" else "phone", "", true, 0, link.volumeHere, link.mutedHere)
    val devices = buildList {
        add(here)
        addAll(link.devices.filter { it.id != link.id })
        s.activeDevice?.takeIf { a -> none { it.id == a } }?.let { add(SessionDevice(it, link.nameOf(it), "desktop", "", true, 0, 1.0, false)) }
    }
    val current = devices.firstOrNull { it.id == s.activeDevice } ?: here
    val status = when {
        s.activeDevice == null -> "没有设备在播放"
        s.playing -> "正在播放" + (title?.let { " · $it" } ?: "")
        else -> "已暂停" + (title?.let { " · $it" } ?: "")
    }
    val others = devices.filter { it.id != current.id }
    ModalBottomSheet(onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = c.panel) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp).padding(bottom = 24.dp).navigationBarsPadding().testTag("devices-sheet")) {
            Text("连接到设备", style = Sonus.type.section, color = c.text)
            if (!link.isConnected) {
                Spacer(Modifier.height(4.dp))
                Text("正在连接服务器上的 Sonus Connect…", style = Sonus.type.muted, color = c.textMuted)
            }
            Spacer(Modifier.height(14.dp))
            CurrentDeviceCard(link, current, status, s.activeDevice != null && s.playing)
            if (others.isNotEmpty()) {
                Spacer(Modifier.height(18.dp))
                Text("选择其他设备", style = Sonus.type.panelHeading, color = c.text)
                Spacer(Modifier.height(4.dp))
                for (d in others) OtherDevice(link, d, onDismiss)
            }
            Spacer(Modifier.height(20.dp))
            Text("没看到你的设备？", style = Sonus.type.body.copy(fontWeight = FontWeight.Bold), color = c.text)
            Spacer(Modifier.height(2.dp))
            Text("在那台电脑或手机上打开 Sonus，登录同一个账号，它就会出现在这里。", style = Sonus.type.bodySmall, color = c.textMuted)
        }
    }
}

/** The device that plays: a raised card, its name in the accent colour, what it does, and its volume under a hairline. */
@Composable
private fun CurrentDeviceCard(link: SessionLink, d: SessionDevice, status: String, playing: Boolean) {
    val c = Sonus.colors
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(Shapes.panel))
            .background(c.raised)
            .padding(start = 16.dp, end = 16.dp, top = 14.dp, bottom = 6.dp)
            .testTag("device-card"),
    ) {
        Row(Modifier.semantics(mergeDescendants = true) { contentDescription = "当前设备：${d.name}，$status" }, verticalAlignment = Alignment.CenterVertically) {
            KitIcon(iconOf(d.kind), size = 24.dp, tint = c.accentText)
            Spacer(Modifier.width(14.dp))
            Column(Modifier.weight(1f)) {
                Text(d.name, style = Sonus.type.cardTitle, color = c.accentText, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(status, style = Sonus.type.caption, color = c.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            if (playing) LevelBars(true)
        }
        Spacer(Modifier.height(12.dp))
        Box(Modifier.fillMaxWidth().height(1.dp).background(c.divider))
        Spacer(Modifier.height(2.dp))
        VolumeSlider(link, d)
    }
}

/** Another device: a tall row that moves playback there; the speaker at its end opens its volume under it. */
@Composable
private fun OtherDevice(link: SessionLink, d: SessionDevice, done: () -> Unit) {
    val c = Sonus.colors
    var volumeOpen by remember(d.id) { mutableStateOf(false) }
    val haptics = rememberHaptics()
    Column(Modifier.fillMaxWidth()) {
        Row(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(Shapes.row))
                .clickable(enabled = d.canPlay) {
                    haptics.confirm()
                    link.transfer(d.id)
                    done()
                }
                .padding(start = 4.dp, top = 6.dp, bottom = 6.dp)
                .semantics { contentDescription = if (d.canPlay) "在「${d.name}」上播放" else "「${d.name}」只能遥控，不能播放" }
                .testTag("device-${d.id}"),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            KitIcon(iconOf(d.kind), size = 22.dp, tint = if (d.canPlay) c.textMuted else c.textMuted.copy(alpha = 0.5f))
            Spacer(Modifier.width(16.dp))
            Column(Modifier.weight(1f)) {
                Text(d.name, style = Sonus.type.body, color = if (d.canPlay) c.text else c.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (!d.canPlay) Text("只能遥控", style = Sonus.type.caption, color = c.textMuted, maxLines = 1)
            }
            RoundButton(
                if (d.muted || d.volume <= 0) "volume-mute" else "volume-low", "「${d.name}」的音量", { volumeOpen = !volumeOpen },
                Modifier.testTag("device-volume-${d.id}"), size = 40.dp, iconSize = 16.dp, on = volumeOpen,
            )
        }
        if (volumeOpen) Box(Modifier.padding(start = 42.dp)) { VolumeSlider(link, d) }
    }
}

/** A device's volume (rule 8: any device sets any device's), sent when the drag ends; a thin track, as the seek bar's. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun VolumeSlider(link: SessionLink, d: SessionDevice) {
    val c = Sonus.colors
    val slider = remember(d.id) { SliderState(0f, 0, 0f..1f) }
    SideEffect {
        if (!slider.isDragging) slider.value = if (d.muted) 0f else d.volume.toFloat().coerceIn(0f, 1f)
    }
    val colors = SliderDefaults.colors(thumbColor = c.text, activeTrackColor = if (slider.isDragging) c.accent else c.text, inactiveTrackColor = c.text.copy(alpha = 0.2f))
    Row(verticalAlignment = Alignment.CenterVertically) {
        KitIcon(if (slider.value <= 0f) "volume-mute" else "volume-low", size = 14.dp, tint = c.textMuted)
        Spacer(Modifier.width(10.dp))
        Slider(
            state = slider,
            onValueChange = { slider.value = it },
            onValueChangeFinished = { link.setVolume(d.id, slider.value.toDouble(), if (slider.value > 0 && d.muted) false else null) },
            modifier = Modifier.weight(1f).height(36.dp).semantics { contentDescription = "「${d.name}」的音量" },
            colors = colors,
            thumb = { Box(Modifier.size(14.dp).clip(CircleShape).background(c.text)) },
            track = { s: SliderState -> SliderDefaults.Track(s, Modifier.height(4.dp), colors = colors, drawStopIndicator = null, thumbTrackGapSize = 0.dp) },
        )
    }
}

private fun iconOf(kind: String) = when (kind) {
    "phone", "tablet" -> "headphones"
    "speaker" -> "speaker"
    else -> "computer"
}
