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
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.creeperux.sonus.session.SessionLink
import com.creeperux.sonus.ui.LocalPlayer
import com.creeperux.sonus.ui.LocalSession
import com.creeperux.sonus.ui.components.LevelBars
import com.creeperux.sonus.ui.components.RoundButton
import com.creeperux.sonus.ui.icons.KitIcon
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

/** Where the session plays when not here: "正在「书房电脑」上播放", or "上次在「书房电脑」播放" when nothing plays. */
@Composable
fun WhereLine(modifier: Modifier = Modifier, light: Boolean = false) {
    val where = rememberLink()?.where ?: return
    val color = if (light) Sonus.colors.accent else Sonus.colors.accentText
    Row(modifier.testTag("where"), verticalAlignment = Alignment.CenterVertically) {
        KitIcon("computer", size = 11.dp, tint = color)
        Spacer(Modifier.width(5.dp))
        Text(where, style = Sonus.type.caption, color = color, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
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
 * 在哪台设备上播放 (the Windows bar's device list): this device and the user's others, what each one does, a tap moves
 * playback there (a transfer, rule 4), and each one's volume (rule 8: this phone's is its media volume).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DevicesSheet(link: SessionLink, onDismiss: () -> Unit) {
    val c = Sonus.colors
    val session = LocalSession.current
    link.revision.collectAsState().value
    val s = link.session
    val title = session.lib.track(s.current?.trackId)?.title ?: s.now?.title
    ModalBottomSheet(onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = c.panel) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp).padding(bottom = 24.dp).navigationBarsPadding().testTag("devices-sheet")) {
            Text("在哪台设备上播放", style = Sonus.type.section, color = c.text)
            Spacer(Modifier.height(4.dp))
            if (!link.isConnected) Text("正在连接服务器…", style = Sonus.type.muted, color = c.textMuted)
            Spacer(Modifier.height(12.dp))
            fun status(id: String, canPlay: Boolean) = when {
                s.activeDevice == id -> (if (s.playing) "正在播放" else "已暂停") + (title?.let { " · $it" } ?: "")
                canPlay -> "空闲"
                else -> "只能遥控"
            }
            Device(link, link.id, link.hereName, if (link.hereName == "这台平板") "tablet" else "phone", true, link.volumeHere, link.mutedHere, status(link.id, true), s, onDismiss)
            val others = link.devices.filter { it.id != link.id }
            for (d in others) Device(link, d.id, d.name, d.kind, d.canPlay, d.volume, d.muted, status(d.id, d.canPlay), s, onDismiss)
            if (others.isEmpty()) {
                Spacer(Modifier.height(12.dp))
                Row(Modifier.clip(RoundedCornerShape(Shapes.panel)).background(c.raised).padding(14.dp), verticalAlignment = Alignment.Top) {
                    KitIcon("info", size = 14.dp, tint = c.textMuted)
                    Spacer(Modifier.width(10.dp))
                    Text("没有其他设备在线。在另一台电脑或手机上打开 Sonus，登录同一个账号，就会出现在这里。", style = Sonus.type.bodySmall, color = c.textMuted)
                }
            }
        }
    }
}

@Composable
private fun Device(
    link: SessionLink,
    id: String,
    name: String,
    kind: String,
    canPlay: Boolean,
    volume: Double,
    muted: Boolean,
    status: String,
    s: com.creeperux.sonus.core.connect.PlaybackSession,
    done: () -> Unit,
) {
    val c = Sonus.colors
    val active = s.activeDevice == id
    var level by remember(id, volume, muted) { mutableFloatStateOf(if (muted) 0f else volume.toFloat()) }
    Column(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
        Row(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(Shapes.row))
                .clickable(enabled = !active && canPlay) {
                    link.transfer(id)
                    done()
                }
                .padding(vertical = 8.dp)
                .semantics { contentDescription = "在「$name」上播放" }
                .testTag("device-$id"),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(Modifier.size(40.dp).clip(CircleShape).background(if (active) c.accent.copy(alpha = 0.18f) else c.raised), contentAlignment = Alignment.Center) {
                KitIcon(iconOf(kind), size = 16.dp, tint = if (active) c.accentText else c.text)
            }
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(name, style = Sonus.type.body, color = if (active) c.accentText else c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(status, style = Sonus.type.caption, color = c.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            if (active) LevelBars(s.playing)
        }
        // rule 8: any device's volume, from here
        Row(Modifier.padding(start = 52.dp), verticalAlignment = Alignment.CenterVertically) {
            KitIcon(if (level <= 0f) "volume-mute" else "volume-low", size = 12.dp, tint = c.textMuted)
            Slider(
                value = level,
                onValueChange = { level = it },
                onValueChangeFinished = { link.setVolume(id, level.toDouble(), if (level > 0 && muted) false else null) },
                modifier = Modifier.weight(1f).height(32.dp).semantics { contentDescription = "「$name」的音量" },
                colors = SliderDefaults.colors(thumbColor = c.text, activeTrackColor = c.text, inactiveTrackColor = c.text.copy(alpha = 0.2f)),
            )
        }
    }
}

private fun iconOf(kind: String) = when (kind) {
    "phone", "tablet" -> "headphones"
    "speaker" -> "speaker"
    else -> "computer"
}
