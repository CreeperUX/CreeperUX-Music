package com.creeperux.sonus.core

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import java.io.File
import java.io.IOException
import java.io.InterruptedIOException
import java.security.MessageDigest
import java.time.Instant
import java.util.concurrent.TimeUnit

class UpdateException(message: String, cause: Throwable? = null) : Exception(message, cause)

/** A file attached to a release. [apiUrl]: the asset's API address (downloads as application/octet-stream);
 *  [sha256]: the lower-case hex digest GitHub computed on upload, or null. */
data class ReleaseAsset(val name: String, val size: Long, val apiUrl: String, val sha256: String?)

/** A version's numbers, major.minor.patch, compared as numbers. */
data class AppVersion(val major: Int, val minor: Int, val patch: Int) : Comparable<AppVersion> {
    override fun compareTo(other: AppVersion): Int = compareValuesBy(this, other, { it.major }, { it.minor }, { it.patch })
    override fun toString(): String = "$major.$minor.$patch"

    companion object {
        private val numbers = Regex("""(\d+)\.(\d+)(?:\.(\d+))?""")

        /** "0.3.1", "0.3.1-test.1", "1.0" → the numbers (a suffix after - or + left out); anything else → null. */
        fun parse(text: String): AppVersion? {
            val m = numbers.matchEntire(text.trim().substringBefore('-').substringBefore('+')) ?: return null
            val (major, minor, patch) = m.destructured
            return AppVersion(major.toIntOrNull() ?: return null, minor.toIntOrNull() ?: return null, patch.toIntOrNull() ?: 0)
        }
    }
}

/**
 * Which releases an installed Sonus can move to. A test build ("Sonus 测试版", com.creeperux.sonus.debug, signed with
 * the owner's debug key) takes test releases only, a release build (com.creeperux.sonus, the release key) final ones:
 * each can only be updated by an APK of its own package signed with its own key, so the two never cross.
 */
enum class UpdateChannel { Release, Test }

/** A Sonus for Android release: tag "android-v0.4.0" (final) or "android-v0.4.0-test.1" (a test build, a prerelease). */
data class AppRelease(
    val tag: String,
    val version: AppVersion,
    val isPrerelease: Boolean,
    val title: String,
    val notes: String,
    val publishedAt: Instant?,
    val assets: List<ReleaseAsset>,
) {
    /** "0.4.0", "0.4.0-test.1": the tag without its "android-v". */
    val displayVersion: String get() = tag.removePrefix(GitHubUpdates.TAG_PREFIX)

    /** The APK to install: the release's (one) .apk. */
    val apk: ReleaseAsset? get() = assets.firstOrNull { it.name.endsWith(".apk", ignoreCase = true) }
}

/**
 * Sonus's releases on GitHub (CreeperUX/Sonus, a public repository: read without signing in), as the Windows app reads
 * them (src/Sonus.Core/Updates/GitHubUpdates.cs): lists them, picks the newest Android one this app should move to, and
 * downloads its APK, checked against the SHA-256 GitHub keeps for it. The Windows app's releases ("v0.6.2") share the
 * repository; Android's are tagged "android-v…". Unsigned calls get 60 an hour per address, plenty for a daily check.
 *
 * Its own HTTP client ([Http]), not the music server's (SubsonicClient.Shared): a download is redirected from
 * api.github.com to GitHub's storage host, which that client's Redirects.guard refuses (rightly, for the server's
 * sign-in); here nothing secret is sent, and the file is checked once it is here. Never from https:// down to http://.
 */
class GitHubUpdates(private val http: OkHttpClient = Http, apiBase: String? = null) {
    private val api: HttpUrl = (apiBase?.takeIf { it.isNotBlank() } ?: DEFAULT_API).let { if (it.endsWith("/")) it else "$it/" }.toHttpUrl()

    /** Published releases, newest first as GitHub lists them (drafts and other apps' releases left out). */
    suspend fun releases(): List<AppRelease> {
        val url = api.resolve("repos/$REPOSITORY/releases?per_page=30")!!
        val body = send(request(url, "application/vnd.github+json"), listing = true).use { r ->
            try {
                withContext(Dispatchers.IO) { r.body.string() }
            } catch (e: IOException) {
                throw UpdateException("无法连接到 GitHub：${e.message}", e)
            }
        }
        return try {
            parse(body)
        } catch (e: Exception) {
            throw UpdateException("GitHub 的回复无法识别。", e)
        }
    }

    /**
     * Downloads [asset] to [file] (written next to it, moved in place once checked); [progress] 0–1 as the bytes arrive.
     * A digest that doesn't match deletes the file and throws. A [file] already there with the right digest is kept (a
     * second try at installing needs no second download).
     */
    suspend fun download(asset: ReleaseAsset, file: File, progress: (Float) -> Unit = {}) {
        if (asset.sha256 != null && file.isFile && withContext(Dispatchers.IO) { sha256(file) } == asset.sha256) {
            progress(1f)
            return
        }
        file.parentFile?.mkdirs()
        val temp = File(file.path + ".part")
        try {
            // GitHub answers with a redirect to its storage (a signed address)
            send(request(asset.apiUrl.toHttpUrl(), "application/octet-stream"), listing = false).use { r ->
                val total = r.body.contentLength().takeIf { it > 0 } ?: asset.size
                val digest = MessageDigest.getInstance("SHA-256")
                withContext(Dispatchers.IO) {
                    r.body.byteStream().use { input ->
                        temp.outputStream().use { output ->
                            val buffer = ByteArray(64 * 1024)
                            var done = 0L
                            while (true) {
                                ensureActive() // cancelled: stop here (the stream closes with the response)
                                val read = input.read(buffer)
                                if (read < 0) break
                                output.write(buffer, 0, read)
                                digest.update(buffer, 0, read)
                                done += read
                                if (total > 0) progress((done.toFloat() / total).coerceAtMost(1f))
                            }
                        }
                    }
                }
                val actual = hex(digest.digest())
                if (asset.sha256 != null && asset.sha256 != actual) throw UpdateException("下载的安装包校验不一致，已删除，请重试。")
            }
            if (!temp.renameTo(file)) {
                file.delete()
                if (!temp.renameTo(file)) throw UpdateException("无法保存安装包。")
            }
        } catch (e: UpdateException) {
            throw e
        } catch (e: InterruptedIOException) {
            currentCoroutineContext().ensureActive()
            throw UpdateException("下载超时，请重试。", e)
        } catch (e: IOException) {
            currentCoroutineContext().ensureActive()
            throw UpdateException("下载中断：${e.message}", e)
        } finally {
            temp.delete()
        }
    }

    private fun request(url: HttpUrl, accept: String): Request = Request.Builder().url(url)
        .header("Accept", accept)
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header("User-Agent", "Sonus") // GitHub refuses requests without one
        .build()

    private suspend fun send(request: Request, listing: Boolean): Response {
        val client = if (listing) http.newBuilder().callTimeout(LIST_TIMEOUT_SECONDS, TimeUnit.SECONDS).build() else http
        val response = try {
            client.newCall(request).await()
        } catch (e: InterruptedIOException) {
            throw UpdateException("连接 GitHub 超时。", e)
        } catch (e: IOException) {
            throw UpdateException("无法连接到 GitHub：${e.message}", e)
        }
        if (response.isSuccessful) return response
        response.use { r ->
            throw UpdateException(
                when {
                    (r.code == 403 || r.code == 429) && r.header("X-RateLimit-Remaining") == "0" ->
                        "GitHub 的请求次数暂时用完了（每个网络地址每小时 60 次），请过一会儿再试。"
                    r.code == 404 && listing -> "GitHub 上找不到 $REPOSITORY 的版本列表。"
                    r.code == 404 -> "GitHub 上找不到这个安装包。"
                    r.isRedirect -> "GitHub 的下载地址无法打开（${r.code}）。" // a redirect not followed: down to http://
                    else -> "GitHub 返回 ${r.code}。"
                },
            )
        }
    }

    companion object {
        const val REPOSITORY = "CreeperUX/Sonus"
        const val DEFAULT_API = "https://api.github.com/"
        const val RELEASES_PAGE = "https://github.com/$REPOSITORY/releases"
        const val TAG_PREFIX = "android-v"
        private const val LIST_TIMEOUT_SECONDS = 20L

        /** For GitHub only (see the class): an APK takes a while on a slow line, so no time limit on the whole call
         *  (the listing has its own); redirects followed, but never from https:// down to http://. */
        val Http: OkHttpClient by lazy {
            OkHttpClient.Builder()
                .connectTimeout(15, TimeUnit.SECONDS)
                .readTimeout(30, TimeUnit.SECONDS)
                .followSslRedirects(false)
                .build()
        }

        private val json = Json { ignoreUnknownKeys = true }

        /** The releases in GitHub's list: Android's ("android-v…"), drafts left out. */
        fun parse(text: String): List<AppRelease> {
            val list = json.parseToJsonElement(text) as? JsonArray ?: throw IllegalArgumentException("not a list")
            return list.mapNotNull { r ->
                if (J.bool(r, "draft")) return@mapNotNull null
                val tag = J.str(r, "tag_name").orEmpty()
                val version = parseTag(tag) ?: return@mapNotNull null
                val assets = J.array(r, "assets").map { a ->
                    val digest = J.str(a, "digest")
                    ReleaseAsset(
                        name = J.str(a, "name").orEmpty(),
                        size = J.numOrNull(a, "size")?.toLong() ?: 0L,
                        apiUrl = J.str(a, "url").orEmpty(),
                        sha256 = digest?.takeIf { it.startsWith("sha256:", ignoreCase = true) }?.substring(7)?.lowercase(),
                    )
                }
                AppRelease(
                    tag = tag,
                    version = version,
                    isPrerelease = J.bool(r, "prerelease"),
                    title = J.str(r, "name")?.takeIf { it.isNotBlank() } ?: tag,
                    notes = J.str(r, "body").orEmpty(),
                    publishedAt = J.str(r, "published_at")?.let { runCatching { Instant.parse(it) }.getOrNull() },
                    assets = assets,
                )
            }
        }

        /** "android-v0.4.0" → 0.4.0; "android-v0.4.0-test.1" → 0.4.0; the Windows app's "v0.6.2", or anything else → null. */
        fun parseTag(tag: String): AppVersion? =
            if (tag.startsWith(TAG_PREFIX, ignoreCase = true)) AppVersion.parse(tag.substring(TAG_PREFIX.length)) else null

        /**
         * The newest release above [current] on this app's [channel] that has an APK: final releases for a release
         * build, test releases for a test build. Null when this app is up to date. A test release must carry new
         * numbers to be offered (0.4.0-test.2 after an installed 0.4.0 is not: the installed app does not know its test
         * number).
         */
        fun newest(releases: List<AppRelease>, current: AppVersion, channel: UpdateChannel): AppRelease? =
            releases.filter { it.isPrerelease == (channel == UpdateChannel.Test) && it.version > current && it.apk != null }
                .maxWithOrNull(compareBy<AppRelease> { it.version }.thenBy { it.publishedAt ?: Instant.EPOCH })

        fun sha256(file: File): String {
            val digest = MessageDigest.getInstance("SHA-256")
            file.inputStream().use { input ->
                val buffer = ByteArray(64 * 1024)
                while (true) {
                    val read = input.read(buffer)
                    if (read < 0) break
                    digest.update(buffer, 0, read)
                }
            }
            return hex(digest.digest())
        }

        private fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }
    }
}

/** When the app asks GitHub on its own (the Windows app's UpdateService.CheckOnStartup): once a day, whatever time it starts. */
object UpdateSchedule {
    const val INTERVAL_MS = 23L * 60 * 60 * 1000 // "once a day", whatever time the app starts

    /**
     * Whether to check now, as the app starts: a day after the last check (or never checked, or the clock went back), or
     * whenever the last check found a newer version, so that the app shows it again after starting anew (asked again,
     * not remembered: one installed or withdrawn in between is not offered).
     */
    fun due(now: Long, lastCheck: Long, foundLastTime: Boolean): Boolean =
        foundLastTime || lastCheck <= 0 || now < lastCheck || now - lastCheck >= INTERVAL_MS
}
