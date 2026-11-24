package com.creeperux.sonus.core

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import okhttp3.Call
import okhttp3.Callback
import okhttp3.FormBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import java.io.IOException
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * A client for Navidrome or any server speaking the Subsonic API with the OpenSubsonic extensions
 * (subsonic.org/pages/api.jsp, opensubsonic.netlify.app), as the Windows app's SubsonicClient: token or API key
 * authentication; JSON answers; writes are POSTed as forms when the server reads them. Answers are parsed off the main
 * thread (OkHttp's threads); every function is safe to call from any coroutine.
 */
class SubsonicClient(val login: Login, val clientName: String, private val http: OkHttpClient = Shared) {

    @Volatile
    var extensions: Set<String> = emptySet()
        private set

    private val online = MutableStateFlow(true)

    /** Reachable / not reachable, as the last request found it. */
    val isOnline: StateFlow<Boolean> = online.asStateFlow()

    // ---------------------------------------------------------------- requests

    private fun params(extra: List<Pair<String, Any?>>): List<Pair<String, String>> {
        // an API key signs alone (apiKeyAuthentication: u= alongside it is an error)
        val p = if (login.isApiKey) {
            mutableListOf("apiKey" to login.apiKey!!, "v" to API_VERSION, "c" to clientName, "f" to "json")
        } else {
            mutableListOf("u" to login.user, "t" to login.token, "s" to login.salt, "v" to API_VERSION, "c" to clientName, "f" to "json")
        }
        for ((k, v) in extra) {
            when (v) {
                null -> Unit
                is String -> p += k to v
                is Boolean -> p += k to if (v) "true" else "false"
                is Iterable<*> -> v.filterNotNull().forEach { p += k to it.toString() }
                else -> p += k to v.toString()
            }
        }
        return p
    }

    /** A URL with the sign-in in it (stream, cover art): the same every time for the same arguments. */
    fun url(method: String, vararg extra: Pair<String, Any?>): String = "${login.server}/rest/$method.view?${query(params(extra.toList()))}"

    internal suspend fun call(method: String, extra: List<Pair<String, Any?>> = emptyList(), post: Boolean = false): JsonObject {
        val started = System.nanoTime()
        try {
            return callOnce(method, extra, post)
        } finally {
            val ms = (System.nanoTime() - started) / 1_000_000
            if (ms >= 500) slow?.invoke("$method $ms ms")
        }
    }

    // off the caller's thread: a page of 500 songs is parsed on a pool thread, never on the main thread
    private suspend fun callOnce(method: String, extra: List<Pair<String, Any?>>, postWanted: Boolean): JsonObject = withContext(Dispatchers.IO) {
        val parameters = params(extra)
        val post = postWanted && "formPost" in extensions // a server that does not say it reads POSTed forms gets GET
        val url = "${login.server}/rest/$method.view"
        val request = if (post) {
            Request.Builder().url(url).post(FormBody.Builder().apply { parameters.forEach { (k, v) -> add(k, v) } }.build()).build()
        } else {
            Request.Builder().url("$url?${query(parameters)}").build()
        }
        val body: String
        try {
            http.newCall(request).await().use { res ->
                if (!res.isSuccessful) throw SubsonicException(0, "服务器返回了 ${res.code} ${res.message}。".replace("  ", " "), res.code)
                body = res.body.string()
            }
        } catch (e: IOException) {
            online.value = false
            throw ServerUnreachableException("无法连接到音乐服务器。检查网络，然后重新连接。", e)
        }
        val root = try {
            Json.parseToJsonElement(body) as? JsonObject
        } catch (e: SerializationException) {
            throw NotSubsonicException(e)
        }
        val r = J.obj(root, "subsonic-response") ?: throw NotSubsonicException(null)
        online.value = true
        if (J.str(r, "status") != "ok") {
            val e = J.obj(r, "error")
            val code = J.int(e, "code")
            throw SubsonicException(code, ERRORS[code] ?: J.str(e, "message") ?: "服务器拒绝了请求。")
        }
        r
    }

    // ---------------------------------------------------------------- the server and the library

    suspend fun connect(): ServerInfo {
        val r = call("ping")
        try {
            val ext = call("getOpenSubsonicExtensions")
            extensions = J.array(ext, "openSubsonicExtensions").mapNotNull { J.str(it, "name") }.toSet()
        } catch (_: SubsonicException) {
            // plain Subsonic
        }
        val type = J.str(r, "type").orEmpty()
        val name = if (type == "navidrome") "Navidrome" else if (type.isNotEmpty()) type.replaceFirstChar { it.uppercase() } else "Subsonic"
        return ServerInfo(name, "$name ${J.str(r, "serverVersion").orEmpty()}".trim(), J.str(r, "version") ?: API_VERSION, J.bool(r, "openSubsonic"))
    }

    /**
     * Every page of a list, in order. 500 are asked for per page; a server that gives fewer (some cap it) has its own page
     * size, learnt from the first two answers. Then three pages are asked for at a time (a remote server's round trips
     * add up: a library of 2,400 songs is five pages); it ends at the first page that is not full.
     */
    private suspend fun paged(method: String, key: String, sub: String, extra: (Int) -> List<Pair<String, Any?>>): List<JsonElement> = coroutineScope {
        suspend fun at(offset: Int) = J.array(J.obj(call(method, extra(offset)), key), sub)
        val all = at(0).toMutableList()
        val size = all.size
        var offset = size
        if (size == 0) return@coroutineScope all
        if (size < PAGE) {
            // the whole list, or a server's own page size: the next page tells
            val next = at(offset)
            all += next
            if (next.size < size) return@coroutineScope all
            offset += next.size
        }
        val together = 3
        while (true) {
            val from = offset
            val pages = (0 until together).map { i -> async { at(from + i * size) } }.awaitAll()
            for (page in pages) {
                all += page
                if (page.size < size) return@coroutineScope all
            }
            offset += size * together
        }
        @Suppress("UNREACHABLE_CODE")
        all
    }

    /** Every album and song. Songs come from search3 with an empty query (paged); a server that needs words there is read
     *  album by album instead. */
    suspend fun loadLibrary(): LibrarySnapshot = coroutineScope {
        val albumPages = async { paged("getAlbumList2", "albumList2", "album") { o -> listOf("type" to "alphabeticalByName", "size" to PAGE, "offset" to o) } }
        val songPages = async {
            paged("search3", "searchResult3", "song") { o -> listOf("query" to "", "songCount" to PAGE, "songOffset" to o, "albumCount" to 0, "artistCount" to 0) }
        }
        val albums = albumPages.await()
        val songs = songPages.await().toMutableList()
        if (songs.isEmpty() && albums.isNotEmpty()) {
            for (a in albums) songs += J.array(J.obj(call("getAlbum", listOf("id" to J.str(a, "id"))), "album"), "song")
        }
        withContext(Dispatchers.Default) { LibraryBuilder.build(albums, songs) }
    }

    /** The number of songs the server has (to notice a rescan), or null when it does not say. */
    suspend fun songCount(): Int? = try {
        val s = J.obj(call("getScanStatus"), "scanStatus")
        if (s != null && s.containsKey("count")) J.int(s, "count") else null
    } catch (_: SubsonicException) {
        null
    }

    // ---------------------------------------------------------------- playlists

    /** The playlists with their songs; [remember] is told every song (the app adds those its library lacks). */
    suspend fun getPlaylists(remember: (JsonElement) -> String): List<Playlist> = coroutineScope {
        val list = J.array(J.obj(call("getPlaylists"), "playlists"), "playlist")
        val gate = Semaphore(4)
        list.map { p ->
            async {
                gate.withPermit {
                    val d = J.obj(call("getPlaylist", listOf("id" to J.str(p, "id"))), "playlist")
                    val owner = J.str(p, "owner") ?: login.user
                    Playlist(
                        id = J.str(p, "id")!!, name = J.str(p, "name").orEmpty(), owner = owner, comment = J.str(p, "comment"),
                        kind = if (J.bool(p, "readonly") || !owner.equals(login.user, ignoreCase = true)) PlaylistKind.ReadOnly else PlaylistKind.User,
                        changed = J.date(p, "changed") ?: System.currentTimeMillis(),
                        entries = J.array(d, "entry").map(remember),
                    )
                }
            }
        }.awaitAll()
    }

    /** A new playlist; its id (an older server answers without the playlist: null). */
    suspend fun createPlaylist(name: String, songIds: List<String>): String? =
        J.str(J.obj(call("createPlaylist", listOf("name" to name, "songId" to songIds), post = true), "playlist"), "id")

    /** Replaces a playlist's songs (the only way the API has to reorder one). */
    suspend fun overwritePlaylist(id: String, songIds: List<String>) {
        call("createPlaylist", listOf("playlistId" to id, "songId" to songIds), post = true)
    }

    suspend fun updatePlaylist(id: String, name: String? = null, add: List<String>? = null, removeIndexes: List<Int>? = null) {
        call("updatePlaylist", listOf("playlistId" to id, "name" to name, "songIdToAdd" to add, "songIndexToRemove" to removeIndexes), post = true)
    }

    suspend fun deletePlaylist(id: String) {
        call("deletePlaylist", listOf("id" to id), post = true)
    }

    // ---------------------------------------------------------------- likes, plays, search

    suspend fun setStarred(songId: String, starred: Boolean) {
        call(if (starred) "star" else "unstar", listOf("id" to songId), post = true)
    }

    /** "Now playing" (submission false), or one counted play (true) started at [startedAt] (epoch milliseconds). */
    suspend fun scrobble(songId: String, submission: Boolean, startedAt: Long? = null) {
        call("scrobble", listOf("id" to songId, "submission" to submission, "time" to startedAt), post = true)
    }

    suspend fun search(query: String): SearchResult {
        val r = J.obj(call("search3", listOf("query" to query, "songCount" to 200, "albumCount" to 60, "artistCount" to 30)), "searchResult3")
        fun ids(k: String) = J.array(r, k).mapNotNull { J.str(it, "id") }
        return SearchResult(ids("song"), ids("album"), ids("artist"))
    }

    // ---------------------------------------------------------------- lyrics, radio, artist information

    /** The song's lyrics: OpenSubsonic structured lyrics (synced first), else getLyrics; null when there are none. */
    suspend fun lyrics(t: Track): List<LyricLine>? {
        if ("songLyrics" in extensions) {
            try {
                val list = J.array(J.obj(call("getLyricsBySongId", listOf("id" to t.id)), "lyricsList"), "structuredLyrics")
                val pick = list.firstOrNull { J.bool(it, "synced") && J.array(it, "line").isNotEmpty() }
                    ?: list.firstOrNull { J.array(it, "line").isNotEmpty() }
                if (pick != null) return LyricsParser.fromStructured(pick)
            } catch (_: SubsonicException) {
                // fall back to getLyrics
            }
        }
        return try {
            val r = J.obj(call("getLyrics", listOf("artist" to t.artist, "title" to t.title)), "lyrics")
            LyricsParser.parse(J.str(r, "value"))
        } catch (_: SubsonicException) {
            null
        }
    }

    /** Songs similar to one (getSimilarSongs2: needs Last.fm on the server); unknown songs are remembered. */
    suspend fun similarSongs(songId: String, remember: (JsonElement) -> String): List<String> = try {
        J.array(J.obj(call("getSimilarSongs2", listOf("id" to songId, "count" to 50)), "similarSongs2"), "song").map(remember)
    } catch (_: SubsonicException) {
        emptyList()
    }

    suspend fun artistInfo(artistId: String): ArtistInfo? = try {
        val r = J.obj(call("getArtistInfo2", listOf("id" to artistId)), "artistInfo2")
        var bio = Regex("<a\\b[^>]*>[\\s\\S]*?</a>\\.?", RegexOption.IGNORE_CASE).replace(J.str(r, "biography").orEmpty(), "")
        bio = Html.decode(Regex("<[^>]+>").replace(bio, "")).trim()
        val link = J.str(r, "lastFmUrl")
        if (bio.isNotEmpty() || link != null) ArtistInfo(bio, link) else null
    } catch (_: SubsonicException) {
        null
    }

    // ---------------------------------------------------------------- the play queue on the server (continue on another device)

    suspend fun savePlayQueue(ids: List<String>, current: String, positionSeconds: Double) {
        call("savePlayQueue", listOf("id" to ids, "current" to current, "position" to (positionSeconds * 1000).toLong()), post = true)
    }

    suspend fun getPlayQueue(remember: (JsonElement) -> String): RemoteQueue? {
        val q = J.obj(call("getPlayQueue"), "playQueue")
        val entries = J.array(q, "entry").map(remember)
        val current = J.str(q, "current")
        if (entries.isEmpty() || current == null) return null
        return RemoteQueue(entries, current, J.num(q, "position") / 1000, J.date(q, "changed") ?: 0L, J.str(q, "changedBy").orEmpty())
    }

    // ---------------------------------------------------------------- media

    /** The cover at a size: the URL is the same every time (a fixed salt), so caches keep it. */
    fun coverUrl(coverArt: String, size: Int = 600): String = url("getCoverArt", "id" to coverArt, "size" to size)

    /** The song's audio; [transcodeTo] asks the server to convert it (e.g. "mp3"). */
    fun streamUrl(songId: String, transcodeTo: String? = null): String =
        if (transcodeTo == null) url("stream", "id" to songId) else url("stream", "id" to songId, "format" to transcodeTo, "maxBitRate" to 320)

    /** The server answered something that is not a Subsonic answer (a web page, a proxy's error). */
    class NotSubsonicException(cause: Throwable?) : Exception("not a Subsonic answer", cause)

    companion object {
        const val API_VERSION = "1.16.1"
        const val PAGE = 500

        /** One connection pool for the API, the streams (Media3) and the covers (Coil). */
        val Shared: OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .build()

        /** Told about every request that took 500 ms or more ("getPlaylist 812 ms"), for the app's log. */
        @Volatile
        var slow: ((String) -> Unit)? = null

        private val ERRORS = mapOf(
            10 to "请求缺少必要的参数。", 20 to "服务器的 Subsonic API 版本太旧。", 30 to "Sonus 需要更新才能连接这个服务器。",
            40 to "用户名或密码不正确。", 41 to "这个账号不能用 token 登录（例如 LDAP 账号）。", 44 to "这次登录已被撤销，请重新登录。",
            50 to "这个账号没有执行这个操作的权限。", 70 to "服务器上找不到这项内容。",
        )

        private val random = SecureRandom()

        fun md5Hex(text: String): String =
            MessageDigest.getInstance("MD5").digest(text.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }

        /** As .NET's Uri.EscapeDataString: everything but A–Z a–z 0–9 - . _ ~ percent-encoded (UTF-8). */
        fun escape(s: String): String {
            val sb = StringBuilder()
            for (b in s.toByteArray(Charsets.UTF_8)) {
                val c = b.toInt() and 0xff
                if (c in 'A'.code..'Z'.code || c in 'a'.code..'z'.code || c in '0'.code..'9'.code || c == '-'.code || c == '.'.code || c == '_'.code || c == '~'.code) {
                    sb.append(c.toChar())
                } else {
                    sb.append('%').append("0123456789ABCDEF"[c shr 4]).append("0123456789ABCDEF"[c and 15])
                }
            }
            return sb.toString()
        }

        internal fun query(p: List<Pair<String, String>>) = p.joinToString("&") { (k, v) -> "${escape(k)}=${escape(v)}" }

        /**
         * Checks the server and the account; returns the sign-in to keep (not the password). A private host typed without
         * a scheme is tried over HTTP, then over HTTPS if nothing Subsonic answers there (a NAS or a tailnet name may serve
         * either).
         */
        suspend fun signIn(server: String, user: String, password: String, clientName: String, http: OkHttpClient = Shared): Login {
            val baseUrl = Hosts.normalizeServer(server)
            require(baseUrl.isNotEmpty()) { "请填写服务器地址。" }
            require(user.isNotBlank()) { "请填写用户名。" }
            val secure = if (!Hosts.hasScheme(server.trim()) && baseUrl.startsWith("http://")) "https://" + baseUrl.removePrefix("http://") else null
            try {
                return trySignIn(baseUrl, user, password, clientName, http)
            } catch (first: Exception) {
                if (secure == null || !(first is ServerUnreachableException || (first is SubsonicException && first.httpStatus > 0))) throw first
                try {
                    return trySignIn(secure, user, password, clientName, http)
                } catch (second: Exception) {
                    if (second is ServerUnreachableException || (second is SubsonicException && second.httpStatus > 0)) {
                        throw ServerUnreachableException("连不上 $baseUrl，也连不上 $secure。检查地址和网络。", second)
                    }
                    throw second
                }
            }
        }

        private suspend fun trySignIn(baseUrl: String, user: String, password: String, clientName: String, http: OkHttpClient): Login {
            val salt = ByteArray(8).also(random::nextBytes).joinToString("") { "%02x".format(it) }
            val login = Login(baseUrl, user.trim(), salt, md5Hex(password + salt))
            val client = SubsonicClient(login, clientName, http)
            try {
                client.call("ping")
            } catch (e: ServerUnreachableException) {
                throw ServerUnreachableException("连不上 $baseUrl。检查地址和网络；服务器在外网时需要 HTTPS。", e.cause ?: e)
            } catch (_: NotSubsonicException) {
                throw ServerUnreachableException("$baseUrl 不像是 Navidrome（没有 Subsonic API 的回应）。")
            }
            return login
        }
    }
}

/** OkHttp's call as a suspending function: cancelling the coroutine cancels the request. */
internal suspend fun Call.await(): Response = suspendCancellableCoroutine { cont ->
    cont.invokeOnCancellation { cancel() }
    enqueue(object : Callback {
        override fun onFailure(call: Call, e: IOException) {
            if (!cont.isCancelled) cont.resumeWithException(e)
        }

        override fun onResponse(call: Call, response: Response) {
            cont.resume(response) { _, r, _ -> r.close() }
        }
    })
}

/** The few HTML entities a biography carries. */
internal object Html {
    private val entity = Regex("&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos|nbsp);")
    fun decode(s: String): String = entity.replace(s) { m ->
        when (val e = m.groupValues[1]) {
            "amp" -> "&"
            "lt" -> "<"
            "gt" -> ">"
            "quot" -> "\""
            "apos" -> "'"
            "nbsp" -> " "
            else -> {
                val code = if (e.startsWith("#x") || e.startsWith("#X")) e.drop(2).toIntOrNull(16) else e.drop(1).toIntOrNull()
                code?.let { String(Character.toChars(it)) } ?: m.value
            }
        }
    }
}

/** Rethrows cancellation; for catch-alls around background requests. */
internal fun Throwable.rethrowIfCancelled() {
    if (this is CancellationException) throw this
}
