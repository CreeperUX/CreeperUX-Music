package com.creeperux.sonus.update

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.content.pm.Signature
import android.provider.Settings as SystemSettings
import android.util.Log
import androidx.core.net.toUri
import com.creeperux.sonus.core.AppRelease
import com.creeperux.sonus.core.AppVersion
import com.creeperux.sonus.core.GitHubUpdates
import com.creeperux.sonus.core.UpdateChannel
import com.creeperux.sonus.core.UpdateException
import com.creeperux.sonus.core.UpdateSchedule
import com.creeperux.sonus.data.Settings
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

/** Where installing an update stands, for the update sheet. */
sealed interface UpdateStep {
    data object Idle : UpdateStep
    data class Downloading(val fraction: Float) : UpdateStep

    /** Downloaded and checked; the system lets Sonus install apps only once its owner allows it (once). */
    data class NeedsPermission(val file: File) : UpdateStep

    /** Handed to the system's installer: its confirmation, then the new version replaces this one (which closes). */
    data object Installing : UpdateStep

    /** Something went wrong, or the installation was cancelled: [message] says which; trying again starts over (a
     *  downloaded file that checks out is not downloaded again). */
    data class Failed(val message: String) : UpdateStep
}

/**
 * A newer Sonus on GitHub, found and installed as the Windows app does (src/Sonus/Updates/UpdateService.cs): checked once
 * a day after starting (and from 设置 › 更新), installed by downloading the release's APK, checking it against GitHub's
 * SHA-256 and that it is this app (its package, a newer version, the same signing key), then handing it to the system's
 * installer, which asks its owner to confirm. CreeperUX/Sonus is public: nothing to sign in with.
 *
 * A test build ("Sonus 测试版") takes test releases, a release build final ones ([UpdateChannel]). A debuggable build (the
 * one the device tests run) checks only when asked, so no test reaches the real GitHub and no update shows up in the
 * middle of one. The state is read on the main thread.
 */
class Updater(private val app: Context, private val settings: Settings, private val scope: CoroutineScope) {
    val channel: UpdateChannel = if (app.packageName.endsWith(".debug")) UpdateChannel.Test else UpdateChannel.Release
    private val installed = app.packageManager.getPackageInfo(app.packageName, 0)

    /** "0.4.0", as installed. */
    val currentText: String = installed.versionName.orEmpty()
    val current: AppVersion = AppVersion.parse(currentText) ?: AppVersion(0, 0, 0)
    private val versionCode: Long = installed.longVersionCode
    private val debuggable = (app.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0

    private val availableFlow = MutableStateFlow<AppRelease?>(null)

    /** The newer version the last check found; null when up to date or not checked yet. */
    val available: StateFlow<AppRelease?> = availableFlow.asStateFlow()

    private val stepFlow = MutableStateFlow<UpdateStep>(UpdateStep.Idle)
    val step: StateFlow<UpdateStep> = stepFlow.asStateFlow()

    private val announceFlow = MutableStateFlow<AppRelease?>(null)

    /** A newer version the daily check found and the app has not said yet (once per version): the shell says it. */
    val announce: StateFlow<AppRelease?> = announceFlow.asStateFlow()

    private var installing: Job? = null

    /** Asks GitHub for the newest release this app should move to (null: up to date). */
    suspend fun check(): AppRelease? {
        val releases = withContext(Dispatchers.IO) { client() }.releases()
        val newest = GitHubUpdates.newest(releases, current, channel)
        log("${releases.size} Android release(s) on GitHub; this is $currentText (${channel.name.lowercase()}): ${newest?.let { "${it.tag} available" } ?: "up to date"}")
        settings.lastUpdateCheck = System.currentTimeMillis()
        settings.knownUpdate = newest?.tag.orEmpty()
        availableFlow.value = newest
        return newest
    }

    /**
     * As the app starts: the update left over from the last version goes, and, when 启动时自动检查 is on, a check once a
     * day (sooner while an update waits, see [UpdateSchedule]), a few seconds in, once the library has settled. Quiet
     * when it can't check.
     */
    fun start() {
        scope.launch(Dispatchers.IO) {
            if (settings.lastVersionCode != versionCode) {
                File(app.cacheDir, FOLDER).deleteRecursively() // an update that has been installed, or an older one
                settings.lastVersionCode = versionCode
            }
        }
        if (!settings.autoCheckUpdates || debuggable) return
        if (!UpdateSchedule.due(System.currentTimeMillis(), settings.lastUpdateCheck, settings.knownUpdate.isNotEmpty())) return
        scope.launch {
            delay(STARTUP_DELAY_MS)
            try {
                val newest = check() ?: return@launch
                if (newest.tag != settings.announcedUpdate) announceFlow.value = newest
            } catch (e: UpdateException) {
                log("automatic check: ${e.message}")
            }
        }
    }

    /** The shell has said [release] is there: not again for this version. */
    fun announced(release: AppRelease) {
        log("said that ${release.tag} is there")
        settings.announcedUpdate = release.tag
        announceFlow.value = null
    }

    /** Downloads [release]'s APK, checks it, and hands it to the system's installer (or asks for the permission first). */
    fun install(release: AppRelease) {
        if (installing?.isActive == true) return
        val asset = release.apk ?: run {
            stepFlow.value = UpdateStep.Failed("这个版本没有安卓安装包。")
            return
        }
        installing = scope.launch {
            stepFlow.value = UpdateStep.Downloading(0f)
            val file = File(File(app.cacheDir, FOLDER), asset.name.replace(Regex("[^A-Za-z0-9._-]"), "_"))
            try {
                withContext(Dispatchers.IO) { client() }.download(asset, file) { f -> stepFlow.value = UpdateStep.Downloading(f) }
                withContext(Dispatchers.IO) { verify(file) }
                log("${asset.name} ready (${file.length()} bytes, sha256 ${if (asset.sha256 == null) "not given by GitHub" else "checked"}, this app's, newer, same key)")
            } catch (e: UpdateException) {
                log("download: ${e.message}")
                stepFlow.value = UpdateStep.Failed(e.message.orEmpty())
                return@launch
            } catch (e: CancellationException) {
                stepFlow.value = UpdateStep.Idle
                throw e
            }
            proceed(file)
        }
    }

    /** Stops a download. */
    fun cancel() {
        installing?.cancel()
        installing = null
        stepFlow.value = UpdateStep.Idle
    }

    /** The system's page where Sonus may be allowed to install apps (安装未知应用). */
    fun permissionIntent(): Intent = Intent(SystemSettings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, "package:${app.packageName}".toUri())

    /** Back in the app (from the system's settings, say): installing goes on once the permission is there. */
    fun resume() {
        val s = stepFlow.value
        if (s is UpdateStep.NeedsPermission && app.packageManager.canRequestPackageInstalls()) proceed(s.file)
    }

    private fun proceed(file: File) {
        if (!app.packageManager.canRequestPackageInstalls()) {
            stepFlow.value = UpdateStep.NeedsPermission(file)
            return
        }
        stepFlow.value = UpdateStep.Installing
        installing = scope.launch {
            try {
                withContext(Dispatchers.IO) { commit(file) }
                log("handed ${file.name} to the system's installer")
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                log("install: $e")
                stepFlow.value = UpdateStep.Failed("无法开始安装：${e.message}")
            }
        }
    }

    /** What the system's installer says ([InstallReceiver]): done (rarely heard: this app closes first), cancelled, or failed. */
    fun onInstallStatus(status: Int, message: String?) {
        log("installer: status $status${message?.let { " ($it)" }.orEmpty()}")
        stepFlow.value = when (status) {
            PackageInstaller.STATUS_SUCCESS -> UpdateStep.Idle
            PackageInstaller.STATUS_FAILURE_ABORTED -> UpdateStep.Failed("已取消安装。")
            PackageInstaller.STATUS_FAILURE_STORAGE -> UpdateStep.Failed("手机存储空间不足，无法安装。")
            PackageInstaller.STATUS_FAILURE_CONFLICT, PackageInstaller.STATUS_FAILURE_INCOMPATIBLE ->
                UpdateStep.Failed("系统拒绝了这个安装包：${message ?: "与已安装的版本冲突"}")
            else -> UpdateStep.Failed("安装没有完成：${message ?: "系统没有说明原因"}")
        }
    }

    /**
     * The APK is this app (the package name), newer (the version code) and signed with the installed app's key: the
     * system would refuse it otherwise, with a less clear message, after asking its owner to confirm.
     */
    private fun verify(file: File) {
        val pm = app.packageManager
        val flags = PackageManager.PackageInfoFlags.of(PackageManager.GET_SIGNING_CERTIFICATES.toLong())
        val apk = pm.getPackageArchiveInfo(file.path, flags) ?: fail(file, "下载的文件不是有效的安装包。")
        if (apk.packageName != app.packageName) fail(file, "这个安装包是另一个应用的（${apk.packageName}），不能用来更新。")
        if (apk.longVersionCode <= versionCode) fail(file, "这个安装包不比已安装的版本新。")
        val theirs = apk.signingInfo?.let { signers(it) }
        val mine = pm.getPackageInfo(app.packageName, flags).signingInfo?.let { signers(it) }
        if (theirs != null && mine != null && theirs.intersect(mine).isEmpty()) fail(file, "这个安装包的签名和已安装的不同，不能用来更新。")
    }

    private fun signers(info: android.content.pm.SigningInfo): Set<Signature> =
        buildSet {
            info.apkContentsSigners?.let { addAll(it) }
            info.signingCertificateHistory?.let { addAll(it) }
        }

    private fun fail(file: File, message: String): Nothing {
        file.delete()
        throw UpdateException(message)
    }

    private fun commit(file: File) {
        val installer = app.packageManager.packageInstaller
        installer.mySessions.forEach { runCatching { installer.abandonSession(it.sessionId) } } // an earlier try's
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(app.packageName)
            setSize(file.length())
            setInstallReason(PackageManager.INSTALL_REASON_USER)
        }
        val id = installer.createSession(params)
        try {
            installer.openSession(id).use { session ->
                session.openWrite("base.apk", 0, file.length()).use { out ->
                    file.inputStream().use { it.copyTo(out) }
                    session.fsync(out)
                }
                // the installer fills in the status: mutable, and explicit (InstallReceiver, not exported)
                val status = Intent(app, InstallReceiver::class.java).setPackage(app.packageName)
                val pending = PendingIntent.getBroadcast(app, id, status, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE)
                session.commit(pending.intentSender)
            }
        } catch (e: Exception) {
            runCatching { installer.abandonSession(id) }
            throw e
        }
    }

    /**
     * GitHub, or (a test build only) the fake one a test names in github-api.txt in the app's external files folder
     * (Android/data/com.creeperux.sonus.debug/files, which adb can write and other apps cannot), as the Windows app's
     * SONUS_GITHUB_API. Whatever it points at, the APK still has to be this app, signed with its key.
     */
    private fun client(): GitHubUpdates {
        val fake = if (channel != UpdateChannel.Test) {
            null
        } else {
            runCatching { app.getExternalFilesDir(null)?.resolve("github-api.txt")?.takeIf { it.isFile }?.readText()?.trim() }.getOrNull()
                ?.takeIf { it.startsWith("http://") || it.startsWith("https://") }
        }
        if (fake != null) log("using the GitHub at $fake")
        return GitHubUpdates(apiBase = fake)
    }

    private fun log(text: String) {
        Log.i("Sonus", "[update] $text")
    }

    companion object {
        private const val FOLDER = "updates" // in the cache folder
        private const val STARTUP_DELAY_MS = 8_000L
    }
}
