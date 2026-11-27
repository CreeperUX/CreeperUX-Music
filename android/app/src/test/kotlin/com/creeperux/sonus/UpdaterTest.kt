package com.creeperux.sonus

import android.content.Context
import android.content.pm.PackageInstaller
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.creeperux.sonus.core.UpdateChannel
import com.creeperux.sonus.data.Settings
import com.creeperux.sonus.ui.screens.plainNotes
import com.creeperux.sonus.update.UpdateStep
import com.creeperux.sonus.update.Updater
import com.google.common.truth.Truth.assertThat
import com.sun.net.httpserver.HttpServer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.net.InetSocketAddress
import java.security.MessageDigest

/**
 * The app's side of updating, against a fake GitHub on this computer that the test build is pointed at the way a device
 * test points it (github-api.txt in the app's external files folder).
 */
@RunWith(AndroidJUnit4::class)
class UpdaterTest {
    private val context: Context = ApplicationProvider.getApplicationContext()
    private val settings = Settings(context.getSharedPreferences("update-test", Context.MODE_PRIVATE).also { it.edit().clear().commit() })
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private lateinit var github: HttpServer
    private val notAnApk = "not an APK".toByteArray()
    private val override get() = File(context.getExternalFilesDir(null), "github-api.txt")

    @Before
    fun start() {
        github = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0).apply {
            val base = "http://127.0.0.1:${address.port}"
            val sha = MessageDigest.getInstance("SHA-256").digest(notAnApk).joinToString("") { "%02x".format(it) }
            val list = """
                [{"tag_name": "android-v99.0.0-test.1", "name": "Sonus Android 99.0.0 测试版", "prerelease": true, "body": "## 新\n- **自动更新**",
                  "assets": [{"name": "Sonus-Android-99.0.0-test.apk", "size": ${notAnApk.size}, "url": "$base/asset", "digest": "sha256:$sha"}]},
                 {"tag_name": "android-v100.0.0", "prerelease": false, "body": "",
                  "assets": [{"name": "Sonus-Android-100.0.0.apk", "size": 1, "url": "$base/asset"}]}]
            """.trimIndent().toByteArray()
            createContext("/repos/CreeperUX/Sonus/releases") { ex ->
                ex.sendResponseHeaders(200, list.size.toLong())
                ex.responseBody.use { it.write(list) }
            }
            createContext("/asset") { ex ->
                ex.sendResponseHeaders(200, notAnApk.size.toLong())
                ex.responseBody.use { it.write(notAnApk) }
            }
            start()
        }
        override.parentFile?.mkdirs()
        override.writeText("http://127.0.0.1:${github.address.port}/\n")
    }

    @After
    fun stop() {
        override.delete()
        github.stop(0)
        scope.cancel()
    }

    @Test
    fun aTestBuildFindsTheTestReleaseAndRemembersIt() = runBlocking {
        val updater = Updater(context, settings, scope)
        assertThat(updater.channel).isEqualTo(UpdateChannel.Test) // com.creeperux.sonus.debug
        assertThat(updater.currentText).isEqualTo(BuildConfigInfo.versionName(context))
        val found = updater.check()
        // the final 100.0.0 is the release build's, not this one's
        assertThat(found?.tag).isEqualTo("android-v99.0.0-test.1")
        assertThat(updater.available.value).isEqualTo(found)
        assertThat(settings.knownUpdate).isEqualTo("android-v99.0.0-test.1")
        assertThat(settings.lastUpdateCheck).isGreaterThan(0L)
    }

    @Test
    fun aDownloadThatIsNotThisAppIsRefusedAndDeleted() = runBlocking {
        val updater = Updater(context, settings, scope)
        val release = updater.check()!!
        updater.install(release)
        val step = withTimeout(10_000) { updater.step.first { it is UpdateStep.Failed } } as UpdateStep.Failed
        assertThat(step.message).isEqualTo("下载的文件不是有效的安装包。")
        assertThat(File(context.cacheDir, "updates").listFiles().orEmpty().toList()).isEmpty()
    }

    @Test
    fun whatTheInstallerSaysIsShownPlainly() {
        val updater = Updater(context, settings, scope)
        updater.onInstallStatus(PackageInstaller.STATUS_FAILURE_ABORTED, null)
        assertThat(updater.step.value).isEqualTo(UpdateStep.Failed("已取消安装。"))
        updater.onInstallStatus(PackageInstaller.STATUS_FAILURE_CONFLICT, "INSTALL_FAILED_UPDATE_INCOMPATIBLE")
        assertThat((updater.step.value as UpdateStep.Failed).message).isEqualTo("系统拒绝了这个安装包：INSTALL_FAILED_UPDATE_INCOMPATIBLE")
        updater.onInstallStatus(PackageInstaller.STATUS_SUCCESS, null)
        assertThat(updater.step.value).isEqualTo(UpdateStep.Idle)
    }

    @Test
    fun aReleasesNotesReadAsPlainText() {
        assertThat(plainNotes("## 新功能\n\n\n- **自动更新**：见 [说明](https://x/y)\n* `代码`")).isEqualTo("新功能\n\n• 自动更新：见 说明\n• 代码")
    }
}
