package com.creeperux.sonus.core

import com.google.common.truth.Truth.assertThat
import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.net.InetSocketAddress
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicInteger

/** Reading GitHub's release list, picking the release to move to, and versions. */
class UpdateChoiceTest {
    private val list = """
        [
          {"tag_name": "android-v0.5.0-test.1", "name": "", "draft": true, "prerelease": true, "body": "", "assets": []},
          {"tag_name": "v0.6.2", "name": "Sonus 0.6.2", "draft": false, "prerelease": false, "body": "Windows",
           "assets": [{"name": "Sonus-0.6.2-ARM64-setup.exe", "size": 9, "url": "https://api.github.com/repos/CreeperUX/Sonus/releases/assets/1", "digest": "sha256:AA"}]},
          {"tag_name": "android-v0.4.0-test.1", "name": "Sonus Android 0.4.0 测试版", "draft": false, "prerelease": true,
           "body": "自动更新", "published_at": "2026-11-28T10:00:00Z",
           "assets": [{"name": "Sonus-Android-0.4.0-test.apk", "size": 5031682, "url": "https://api.github.com/repos/CreeperUX/Sonus/releases/assets/7",
                       "digest": "sha256:173FEAC40F7A156DB8DC349227D00C1524B361B586D44659EB7B6B970C679013", "content_type": "application/vnd.android.package-archive"}]},
          {"tag_name": "android-v0.3.0-test.1", "name": "Sonus Android 0.3.0 测试版", "draft": false, "prerelease": true, "body": "动效",
           "published_at": "2026-11-27T10:00:00Z",
           "assets": [{"name": "Sonus-Android-0.3.0-test.apk", "size": 5, "url": "https://api.github.com/repos/CreeperUX/Sonus/releases/assets/6", "digest": null}]},
          {"tag_name": "android-v0.2.0", "name": "Sonus Android 0.2.0", "draft": false, "prerelease": false, "body": "",
           "assets": [{"name": "Sonus-Android-0.2.0.apk", "size": 5, "url": "https://api.github.com/repos/CreeperUX/Sonus/releases/assets/5"}]},
          {"tag_name": "android-v9.0.0", "name": "", "draft": false, "prerelease": false, "body": "notes only", "assets": []}
        ]
    """.trimIndent()

    @Test
    fun androidReleasesAreReadAndTheRestLeftOut() {
        val releases = GitHubUpdates.parse(list)
        // the draft and the Windows release left out
        assertThat(releases.map { it.tag }).containsExactly("android-v0.4.0-test.1", "android-v0.3.0-test.1", "android-v0.2.0", "android-v9.0.0").inOrder()
        val r = releases[0]
        assertThat(r.version).isEqualTo(AppVersion(0, 4, 0))
        assertThat(r.isPrerelease).isTrue()
        assertThat(r.displayVersion).isEqualTo("0.4.0-test.1")
        assertThat(r.title).isEqualTo("Sonus Android 0.4.0 测试版")
        assertThat(r.notes).isEqualTo("自动更新")
        assertThat(r.publishedAt.toString()).isEqualTo("2026-11-28T10:00:00Z")
        val apk = r.apk!!
        assertThat(apk.name).isEqualTo("Sonus-Android-0.4.0-test.apk")
        assertThat(apk.size).isEqualTo(5031682)
        assertThat(apk.apiUrl).isEqualTo("https://api.github.com/repos/CreeperUX/Sonus/releases/assets/7")
        assertThat(apk.sha256).isEqualTo("173feac40f7a156db8dc349227d00c1524b361b586d44659eb7b6b970c679013")
        // no digest (null, or none at all), no title
        assertThat(releases[1].apk!!.sha256).isNull()
        assertThat(releases[2].apk!!.sha256).isNull()
        assertThat(releases[3].title).isEqualTo("android-v9.0.0")
        assertThat(releases[3].apk).isNull()
    }

    @Test
    fun aTestBuildMovesToTestReleasesOnly() {
        val releases = GitHubUpdates.parse(list)
        assertThat(GitHubUpdates.newest(releases, AppVersion(0, 3, 1), UpdateChannel.Test)?.tag).isEqualTo("android-v0.4.0-test.1")
        assertThat(GitHubUpdates.newest(releases, AppVersion(0, 2, 0), UpdateChannel.Test)?.tag).isEqualTo("android-v0.4.0-test.1")
        // up to date: the same numbers (whatever the test number) or newer
        assertThat(GitHubUpdates.newest(releases, AppVersion(0, 4, 0), UpdateChannel.Test)).isNull()
        assertThat(GitHubUpdates.newest(releases, AppVersion(0, 5, 0), UpdateChannel.Test)).isNull()
    }

    @Test
    fun aReleaseBuildMovesToFinalReleasesWithAnApkOnly() {
        val releases = GitHubUpdates.parse(list)
        // android-v9.0.0 has no APK; the test releases are another app's
        assertThat(GitHubUpdates.newest(releases, AppVersion(0, 1, 0), UpdateChannel.Release)?.tag).isEqualTo("android-v0.2.0")
        assertThat(GitHubUpdates.newest(releases, AppVersion(0, 2, 0), UpdateChannel.Release)).isNull()
    }

    @Test
    fun versions() {
        assertThat(AppVersion.parse("0.3.1")).isEqualTo(AppVersion(0, 3, 1))
        assertThat(AppVersion.parse("1.0")).isEqualTo(AppVersion(1, 0, 0))
        assertThat(AppVersion.parse("0.4.0-test.1")).isEqualTo(AppVersion(0, 4, 0))
        assertThat(AppVersion.parse("0.10.0+5")).isEqualTo(AppVersion(0, 10, 0))
        assertThat(AppVersion.parse("")).isNull()
        assertThat(AppVersion.parse("one")).isNull()
        assertThat(AppVersion(0, 10, 0)).isGreaterThan(AppVersion(0, 9, 9))
        assertThat(AppVersion(1, 0, 0)).isGreaterThan(AppVersion(0, 99, 0))
        assertThat(GitHubUpdates.parseTag("android-v0.4.0-test.1")).isEqualTo(AppVersion(0, 4, 0))
        assertThat(GitHubUpdates.parseTag("v0.6.2")).isNull()
        assertThat(GitHubUpdates.parseTag("android-vnext")).isNull()
    }
}

/**
 * Against a fake GitHub on this computer: the API on 127.0.0.1, its downloads redirected to "storage" on localhost (another
 * host, as api.github.com sends them to objects.githubusercontent.com).
 */
class UpdateDownloadTest {
    @get:Rule
    val temp = TemporaryFolder()

    private lateinit var api: HttpServer
    private lateinit var storage: HttpServer
    private val apk = ByteArray(300_000) { (it * 31 % 251).toByte() }
    private val apkSha = MessageDigest.getInstance("SHA-256").digest(apk).joinToString("") { "%02x".format(it) }
    private var listStatus = 200
    private var listHeaders = mapOf<String, String>()
    private var listBody = ""
    private var storageBytes = apk
    private val downloads = AtomicInteger()
    private val seen = mutableListOf<Map<String, String>>()

    @Before
    fun start() {
        storage = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0).apply {
            createContext("/apk") { ex ->
                downloads.incrementAndGet()
                ex.reply(200, storageBytes)
            }
            start()
        }
        api = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0).apply {
            createContext("/repos/CreeperUX/Sonus/releases") { ex ->
                synchronized(seen) { seen += ex.headers() }
                listHeaders.forEach { (k, v) -> ex.responseHeaders.add(k, v) }
                ex.reply(listStatus, listBody.toByteArray())
            }
            createContext("/repos/CreeperUX/Sonus/releases/assets/") { ex ->
                synchronized(seen) { seen += ex.headers() }
                ex.responseHeaders.add("Location", "http://localhost:${storage.address.port}/apk?sig=1")
                ex.reply(302, ByteArray(0))
            }
            start()
        }
    }

    @After
    fun stop() {
        api.stop(0)
        storage.stop(0)
    }

    private fun HttpExchange.headers(): Map<String, String> = requestHeaders.mapKeys { it.key.lowercase() }.mapValues { it.value.first() } + ("path" to requestURI.toString())

    private fun HttpExchange.reply(code: Int, body: ByteArray) {
        sendResponseHeaders(code, if (body.isEmpty()) -1 else body.size.toLong())
        if (body.isNotEmpty()) responseBody.use { it.write(body) } else close()
    }

    private val base get() = "http://127.0.0.1:${api.address.port}"
    private val updates get() = GitHubUpdates(apiBase = base)
    private fun asset(sha: String? = apkSha) = ReleaseAsset("Sonus-Android-0.4.0-test.apk", apk.size.toLong(), "$base/repos/CreeperUX/Sonus/releases/assets/7", sha)

    @Test
    fun theListIsAskedForAsGitHubWantsIt() = runBlocking {
        listBody = """[{"tag_name": "android-v0.4.0-test.1", "prerelease": true, "assets": [{"name": "a.apk", "size": 1, "url": "$base/x", "digest": "sha256:ab"}]}]"""
        val releases = updates.releases()
        assertThat(releases.single().apk!!.sha256).isEqualTo("ab")
        val h = seen.single()
        assertThat(h["path"]).isEqualTo("/repos/CreeperUX/Sonus/releases?per_page=30")
        assertThat(h["accept"]).isEqualTo("application/vnd.github+json")
        assertThat(h["x-github-api-version"]).isEqualTo("2022-11-28")
        assertThat(h["user-agent"]).isEqualTo("Sonus")
    }

    @Test
    fun whatGoesWrongIsSaidPlainly() = runBlocking {
        listStatus = 403
        listHeaders = mapOf("X-RateLimit-Remaining" to "0")
        assertThat(failure { updates.releases() }).contains("每小时 60 次")
        listStatus = 404
        listHeaders = emptyMap()
        assertThat(failure { updates.releases() }).isEqualTo("GitHub 上找不到 CreeperUX/Sonus 的版本列表。")
        listStatus = 500
        assertThat(failure { updates.releases() }).isEqualTo("GitHub 返回 500。")
        listStatus = 200
        listBody = "<html>a captive portal</html>"
        assertThat(failure { updates.releases() }).isEqualTo("GitHub 的回复无法识别。")
        api.stop(0)
        assertThat(failure { updates.releases() }).startsWith("无法连接到 GitHub")
    }

    @Test
    fun theApkComesThroughTheRedirectAndIsChecked() = runBlocking {
        val file = File(temp.root, "updates/Sonus-Android-0.4.0-test.apk")
        val progress = mutableListOf<Float>()
        updates.download(asset(), file) { progress += it }
        assertThat(file.readBytes()).isEqualTo(apk)
        assertThat(progress.last()).isEqualTo(1f)
        assertThat(progress).isInOrder()
        assertThat(File(file.path + ".part").exists()).isFalse()
        val h = seen.single { it["path"]!!.contains("/assets/") }
        assertThat(h["accept"]).isEqualTo("application/octet-stream")
        assertThat(downloads.get()).isEqualTo(1)

        // a second try at installing: the file already there, checked, not downloaded again
        updates.download(asset(), file)
        assertThat(downloads.get()).isEqualTo(1)
    }

    @Test
    fun aFileThatDoesNotMatchTheDigestIsDeleted() = runBlocking {
        val file = File(temp.root, "Sonus-Android-0.4.0-test.apk")
        storageBytes = apk.copyOf().also { it[1000] = (it[1000] + 1).toByte() } // one byte changed on the way
        assertThat(failure { updates.download(asset(), file) }).isEqualTo("下载的安装包校验不一致，已删除，请重试。")
        assertThat(file.exists()).isFalse()
        assertThat(File(file.path + ".part").exists()).isFalse()

        // a file left there that no longer matches is downloaded again
        file.writeBytes(byteArrayOf(1, 2, 3))
        storageBytes = apk
        updates.download(asset(), file)
        assertThat(file.readBytes()).isEqualTo(apk)
    }

    @Test
    fun withoutADigestTheFileIsKeptAsItCame() = runBlocking {
        // GitHub has given every asset a digest since 2025; an older one without: the Windows app takes it too, and
        // Android only installs an update signed with the installed app's own key
        val file = File(temp.root, "a.apk")
        updates.download(asset(sha = null), file)
        assertThat(file.readBytes()).isEqualTo(apk)
    }

    @Test
    fun theServersOwnClientIsNotUsed() {
        // the music server's client refuses a redirect to another host (Redirects.guard): GitHub's downloads need one
        assertThat(GitHubUpdates.Http.networkInterceptors).doesNotContain(Redirects.guard)
        assertThat(GitHubUpdates.Http.followSslRedirects).isFalse()
    }

    private suspend fun failure(block: suspend () -> Unit): String {
        try {
            block()
        } catch (e: UpdateException) {
            return e.message.orEmpty()
        }
        throw AssertionError("no UpdateException")
    }
}

/**
 * The real GitHub, once by hand: -Dsonus.realGitHub=1 (./gradlew :core:test --tests '*RealGitHub*' -Psonus.realGitHub). Off
 * otherwise: no test reaches the real GitHub on its own.
 */
class RealGitHubTest {
    @Test
    fun theRealListReads() = runBlocking {
        assumeTrue(System.getProperty("sonus.realGitHub") == "1")
        val releases = GitHubUpdates().releases()
        println(releases.joinToString("\n") { "${it.tag} pre=${it.isPrerelease} apk=${it.apk?.name} ${it.apk?.size} sha=${it.apk?.sha256}" })
        assertThat(releases).isNotEmpty()
        assertThat(releases.all { it.tag.startsWith("android-v") }).isTrue()
    }
}

class UpdateScheduleTest {
    private val hour = 60 * 60 * 1000L
    private val now = 1_800_000_000_000L

    @Test
    fun onceADayOrWhileAnUpdateWaits() {
        assertThat(UpdateSchedule.due(now, lastCheck = 0, foundLastTime = false)).isTrue() // never checked
        assertThat(UpdateSchedule.due(now, now - 2 * hour, foundLastTime = false)).isFalse()
        assertThat(UpdateSchedule.due(now, now - 23 * hour, foundLastTime = false)).isTrue()
        assertThat(UpdateSchedule.due(now, now - 2 * hour, foundLastTime = true)).isTrue() // shown again after a restart
        assertThat(UpdateSchedule.due(now, now + 5 * hour, foundLastTime = false)).isTrue() // the clock went back
    }
}
