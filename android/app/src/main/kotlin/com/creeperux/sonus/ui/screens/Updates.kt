package com.creeperux.sonus.ui.screens

import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.unit.dp
import androidx.core.net.toUri
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import com.creeperux.sonus.core.AppRelease
import com.creeperux.sonus.core.GitHubUpdates
import com.creeperux.sonus.core.UpdateChannel
import com.creeperux.sonus.core.UpdateException
import com.creeperux.sonus.ui.LocalGraph
import com.creeperux.sonus.ui.components.PillButton
import com.creeperux.sonus.ui.icons.KitIcon
import com.creeperux.sonus.ui.theme.Sonus
import com.creeperux.sonus.update.UpdateStep
import com.creeperux.sonus.update.Updater
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Date
import java.util.Locale

/**
 * 设置 › 更新, as the Windows app's (OtherPages.cs AddUpdates): where things stand, 检查更新 / 安装更新, the daily check,
 * and where updates come from (the public repository's releases, nothing to sign in with).
 */
@Composable
fun UpdatesSection() {
    val c = Sonus.colors
    val updater = LocalGraph.current.updater
    val settings = LocalGraph.current.settings
    val available by updater.available.collectAsState()
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var checking by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }
    var auto by remember { mutableStateOf(settings.autoCheckUpdates) }
    var sheet by remember { mutableStateOf(false) }
    val current = updater.currentText + if (updater.channel == UpdateChannel.Test) "（测试版）" else ""

    val status = message ?: available?.let { "当前版本 $current，发现新版本 ${versionLabel(it)}。" }
        ?: ("当前版本 $current。" + settings.lastUpdateCheck.takeIf { it > 0 }?.let { "上次检查：${SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.CHINA).format(Date(it))}。" }.orEmpty())
    Text(status, style = Sonus.type.body, color = c.text, modifier = Modifier.testTag("update-status").semantics { liveRegion = LiveRegionMode.Polite })
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
        PillButton("检查更新", {
            checking = true
            message = null
            scope.launch {
                message = try {
                    if (updater.check() == null) "当前版本 $current，已是最新版本。" else null
                } catch (e: UpdateException) {
                    e.message
                } finally {
                    checking = false
                }
            }
        }, Modifier.testTag("check-update"), enabled = !checking, icon = "refresh")
        if (available != null) PillButton("安装更新", { sheet = true }, Modifier.testTag("install-update"), primary = true, icon = "download")
        if (checking) CircularProgressIndicator(color = c.accent, strokeWidth = 2.dp, modifier = Modifier.size(18.dp))
    }
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text("启动时自动检查（每天一次）", style = Sonus.type.body, color = c.text, modifier = Modifier.weight(1f))
        Switch(auto, { auto = it; settings.autoCheckUpdates = it }, colors = SwitchDefaults.colors(checkedTrackColor = c.accent, checkedThumbColor = c.onAccent))
    }
    Row {
        KitIcon("info", size = 14.dp, tint = c.textMuted, modifier = Modifier.padding(top = 2.dp))
        Spacer(Modifier.width(8.dp))
        Text(
            "更新来自 GitHub 上 Sonus 的公开仓库（${GitHubUpdates.REPOSITORY}）的发布版，不用登录。下载后按 GitHub 记录的 SHA-256 校验，再交给系统安装；登录和设置保留。" +
                if (updater.channel == UpdateChannel.Test) "测试版只接收测试版的更新。" else "",
            style = Sonus.type.bodySmall, color = c.textMuted,
        )
    }
    Text(
        "在 GitHub 上查看所有版本",
        style = Sonus.type.bodySmall, color = c.accentText,
        modifier = Modifier.clip(RoundedCornerShape(6.dp))
            .clickable { CustomTabsIntent.Builder().setShowTitle(true).build().launchUrl(context, GitHubUpdates.RELEASES_PAGE.toUri()) }
            .padding(vertical = 4.dp),
    )
    val release = available
    if (sheet && release != null) UpdateSheet(updater, release) { sheet = false }
}

/** "0.4.1（测试版）", "1.0.0". */
private fun versionLabel(r: AppRelease) = r.displayVersion.substringBefore("-") + if (r.isPrerelease) "（测试版）" else ""

/**
 * Installing [release] (the Windows app's UpdateDialog): what is new, then 下载并安装 — the download and its check, the
 * permission to install apps when Sonus does not have it yet, then the system's own confirmation. Closing the sheet
 * does not stop a download: it goes on, and the sheet shows where it is when opened again.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun UpdateSheet(updater: Updater, release: AppRelease, onDismiss: () -> Unit) {
    val c = Sonus.colors
    val context = LocalContext.current
    val step by updater.step.collectAsState()
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { updater.resume() } // back from the system's settings
    ModalBottomSheet(onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = c.panel) {
        // the sheet is a window of its own: its test tags are resource ids there too (UiAutomator, adb)
        Column(
            Modifier.fillMaxWidth().semantics { testTagsAsResourceId = true }.padding(horizontal = 20.dp).padding(bottom = 24.dp).navigationBarsPadding().testTag("update-sheet"),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text("更新 Sonus", style = Sonus.type.section, color = c.text)
            val facts = listOfNotNull(
                "新版本 ${versionLabel(release)}",
                release.apk?.size?.takeIf { it > 0 }?.let { "%.1f MB".format(it / 1_048_576.0) },
                release.publishedAt?.let { DateTimeFormatter.ofPattern("yyyy-MM-dd").withZone(ZoneId.systemDefault()).format(it) },
            )
            Text(facts.joinToString(" · "), style = Sonus.type.bodySmall, color = c.textMuted)
            val notes = plainNotes(release.notes)
            if (notes.isNotBlank()) {
                Text(
                    notes, style = Sonus.type.bodySmall, color = c.text,
                    modifier = Modifier.fillMaxWidth().heightIn(max = 260.dp).verticalScroll(rememberScrollState()),
                )
            }
            when (val s = step) {
                is UpdateStep.Downloading -> {
                    LinearProgressIndicator(progress = { s.fraction }, color = c.accent, trackColor = c.raised, modifier = Modifier.fillMaxWidth())
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("正在下载… ${(s.fraction * 100).toInt()}%", style = Sonus.type.body, color = c.text, modifier = Modifier.weight(1f).testTag("update-progress"))
                        PillButton("取消", updater::cancel)
                    }
                }
                is UpdateStep.NeedsPermission -> {
                    Text("安装包已下载并校验。要安装它，需要允许 Sonus 安装应用（系统设置里的“安装未知应用”），只需一次。", style = Sonus.type.body, color = c.text)
                    PillButton("去允许", { context.startActivity(updater.permissionIntent()) }, Modifier.testTag("allow-install"), primary = true, icon = "lock")
                }
                UpdateStep.Installing -> {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        CircularProgressIndicator(color = c.accent, strokeWidth = 2.dp, modifier = Modifier.size(18.dp))
                        Spacer(Modifier.width(10.dp))
                        Text("已交给系统安装。确认后 Sonus 会关闭并更新；没有自动重新打开的话，从桌面打开它。", style = Sonus.type.body, color = c.text, modifier = Modifier.testTag("update-installing"))
                    }
                }
                UpdateStep.Idle, is UpdateStep.Failed -> {
                    if (s is UpdateStep.Failed) Text(s.message, style = Sonus.type.body, color = c.bad, modifier = Modifier.testTag("update-error"))
                    PillButton(if (s is UpdateStep.Failed) "重试" else "下载并安装", { updater.install(release) }, Modifier.testTag("download-update"), primary = true, icon = "download")
                }
            }
            Text("安装时音乐会停止，Sonus 会关闭；登录和设置保留。", style = Sonus.type.caption, color = c.textMuted)
            Spacer(Modifier.height(4.dp))
        }
    }
}

/** A release's notes (GitHub Markdown) as plain text: headings, bold and list markers dropped, links as their text. */
internal fun plainNotes(markdown: String): String = markdown.lines().joinToString("\n") { line ->
    line.replace(Regex("""^\s{0,3}#{1,6}\s+"""), "")
        .replace(Regex("""^(\s*)[-*]\s+"""), "$1• ")
        .replace(Regex("""\*\*(.+?)\*\*"""), "$1")
        .replace(Regex("""\[([^\]]+)]\([^)]*\)"""), "$1")
        .replace("`", "")
}.replace(Regex("""\n{3,}"""), "\n\n").trim()
