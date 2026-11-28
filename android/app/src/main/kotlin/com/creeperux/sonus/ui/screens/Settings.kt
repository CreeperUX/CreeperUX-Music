package com.creeperux.sonus.ui.screens

import android.content.Intent
import android.provider.Settings as SystemSettings
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.creeperux.sonus.BuildConfigInfo
import com.creeperux.sonus.core.AudioQuality
import com.creeperux.sonus.core.Formats
import com.creeperux.sonus.core.LoudnessLevel
import com.creeperux.sonus.core.LoudnessMode
import com.creeperux.sonus.core.PlaybackOrder
import com.creeperux.sonus.data.ThemeMode
import com.creeperux.sonus.ui.LocalGraph
import com.creeperux.sonus.ui.LocalPlayer
import com.creeperux.sonus.ui.LocalSession
import com.creeperux.sonus.ui.components.Chip
import com.creeperux.sonus.ui.components.LocalOnRaised
import com.creeperux.sonus.ui.components.PillButton
import com.creeperux.sonus.ui.pageTop
import com.creeperux.sonus.ui.theme.Shapes
import com.creeperux.sonus.ui.theme.Sonus

/** Settings (OtherPages.cs:268-437), as far as they apply on Android: playback, display, account, about. */
@Composable
fun SettingsScreen() {
    val c = Sonus.colors
    val graph = LocalGraph.current
    val session = LocalSession.current
    val player = LocalPlayer.current
    val state by player.state.collectAsState()
    val server by session.serverInfo.collectAsState()
    val theme by graph.themeMode.collectAsState()
    var wifiQuality by remember { mutableStateOf(player.wifiQuality) }
    var cellularQuality by remember { mutableStateOf(player.cellularQuality) }
    var loudnessLevel by remember { mutableStateOf(player.loudnessLevel) }
    var loudnessMode by remember { mutableStateOf(player.loudnessMode) }
    var alwaysOriginal by remember { mutableStateOf(player.alwaysOriginal) }
    val context = LocalContext.current
    Column(Modifier.fillMaxSize().pageTop().verticalScroll(rememberScrollState()).padding(16.dp).testTag("settings"), verticalArrangement = Arrangement.spacedBy(20.dp)) {
        BackRow()
        Text("设置", style = Sonus.type.pageTitle, color = c.text)

        Group("播放") {
            Label("播放顺序")
            Wrap {
                PlaybackOrder.entries.forEach { o -> Chip(Formats.order(o), state.order == o, { player.setOrder(o) }) }
            }
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text("播完当前歌曲后停止", style = Sonus.type.body, color = c.text, modifier = Modifier.weight(1f))
                Switch(state.stopAfterCurrent, { player.setStopAfterCurrent(it) }, colors = SwitchDefaults.colors(checkedTrackColor = c.accent, checkedThumbColor = c.onAccent))
            }
        }

        Group("音质与音量") {
            val tiers = listOf(
                AudioQuality.Auto to "自动",
                AudioQuality.Normal to "普通",
                AudioQuality.High to "高",
                AudioQuality.VeryHigh to "极高",
                AudioQuality.Lossless to "无损",
            )
            Label("Wi-Fi 下的音质")
            Wrap {
                tiers.forEach { (q, label) ->
                    Chip(label, wifiQuality == q, { wifiQuality = q; player.wifiQuality = q }, Modifier.testTag("wifi-quality-${q.name}"))
                }
            }
            Label("移动网络下的音质")
            Wrap {
                tiers.forEach { (q, label) ->
                    Chip(label, cellularQuality == q, { cellularQuality = q; player.cellularQuality = q }, Modifier.testTag("cell-quality-${q.name}"))
                }
            }
            Text(
                "自动：Wi-Fi 下默认无损，移动网络下默认高（Opus 160）；两项均选“无损”即为强制无损。仅在“自动”且缓冲较慢时临时降一档，切网络后下一首生效。",
                style = Sonus.type.bodySmall,
                color = c.textMuted,
            )
            Label("音量均衡")
            Wrap {
                listOf(
                    LoudnessLevel.Off to "关",
                    LoudnessLevel.Quiet to "安静",
                    LoudnessLevel.Normal to "正常",
                    LoudnessLevel.Loud to "大声",
                ).forEach { (lvl, label) ->
                    Chip(label, loudnessLevel == lvl, { loudnessLevel = lvl; player.loudnessLevel = lvl }, Modifier.testTag("loudness-${lvl.name}"))
                }
            }
            if (loudnessLevel != LoudnessLevel.Off) {
                Label("均衡方式")
                Wrap {
                    listOf(LoudnessMode.Album to "按专辑", LoudnessMode.Track to "按歌曲").forEach { (m, label) ->
                        Chip(label, loudnessMode == m, { loudnessMode = m; player.loudnessMode = m }, Modifier.testTag("loudness-mode-${m.name}"))
                    }
                }
            }
            Text(
                "按曲库响度统一不同专辑的音量（安静 −18 / 正常 −14 / 大声 −11 LUFS），带防削波峰值保护；无响度数据时回退到回放增益标签。",
                style = Sonus.type.bodySmall,
                color = c.textMuted,
            )
        }

        Group("显示") {
            Label("外观")
            Wrap {
                listOf(ThemeMode.System to "跟随系统", ThemeMode.Dark to "深色", ThemeMode.Light to "浅色").forEach { (m, label) ->
                    Chip(label, theme == m, { graph.setTheme(m) })
                }
            }
        }

        Group("输出设备") {
            Text("Sonus 用系统的媒体输出：手机扬声器、耳机、蓝牙或投放设备。", style = Sonus.type.bodySmall, color = c.textMuted)
            PillButton("打开系统的媒体输出", {
                runCatching { context.startActivity(Intent("android.settings.MEDIA_OUTPUT").putExtra("com.android.settings.panel.extra.PACKAGE_NAME", context.packageName).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
                    .onFailure { context.startActivity(Intent(SystemSettings.ACTION_SOUND_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
            }, icon = "speaker")
        }

        Group("账号") {
            val login = session.client.login
            Fact("服务器", login.server)
            Fact("用户", login.user.ifEmpty { "—" })
            Fact("登录方式", if (login.isApiKey) "在浏览器中登录（本设备专用的密钥）" else "用户名和密码（只保存登录凭证）")
            Fact("服务器版本", server.version)
            Fact("这台设备", graph.clientName)
            val link = rememberLink()
            Fact("多设备同步", if (link == null) "服务器不支持（Sonus Connect v2）" else if (link.isConnected) "已开启：所有设备共享一个播放会话" else "已开启，正在连接…")
            PillButton("退出登录", graph::signOut, Modifier.testTag("sign-out"), icon = "user")
        }

        Group("更新") { UpdatesSection() }

        Group("高级") {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("始终用原文件", style = Sonus.type.body, color = c.text)
                    Text("开启后始终请求服务器原始文件，音质设置不生效（用于排查问题或对比音质）。", style = Sonus.type.bodySmall, color = c.textMuted)
                }
                Spacer(Modifier.width(12.dp))
                Switch(
                    alwaysOriginal,
                    { alwaysOriginal = it; player.alwaysOriginal = it },
                    modifier = Modifier.testTag("always-original"),
                    colors = SwitchDefaults.colors(checkedTrackColor = c.accent, checkedThumbColor = c.onAccent),
                )
            }
        }

        Group("关于") {
            Fact("版本", BuildConfigInfo.versionName(context))
            Text("Sonus 是 CreeperUX 的音乐播放器，播放你自己服务器上的音乐。标题字体 Chakra Petch 依 SIL Open Font License 1.1 授权。", style = Sonus.type.bodySmall, color = c.textMuted)
        }
        Spacer(Modifier.height(24.dp))
    }
}

@Composable
private fun Group(title: String, content: @Composable () -> Unit) {
    val c = Sonus.colors
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(Shapes.panel)).background(c.raised).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(title, style = Sonus.type.section, color = c.text)
        CompositionLocalProvider(LocalOnRaised provides true) { content() }
    }
}

@Composable
private fun Label(text: String) = Text(text, style = Sonus.type.bodySmall, color = Sonus.colors.textMuted)

@Composable
private fun Fact(k: String, v: String) {
    val c = Sonus.colors
    Row {
        Text(k, style = Sonus.type.bodySmall, color = c.textMuted, modifier = Modifier.width(96.dp))
        Text(v, style = Sonus.type.bodySmall, color = c.text)
    }
}

/** Chips that wrap onto more lines. */
@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
private fun Wrap(content: @Composable () -> Unit) {
    androidx.compose.foundation.layout.FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) { content() }
}
