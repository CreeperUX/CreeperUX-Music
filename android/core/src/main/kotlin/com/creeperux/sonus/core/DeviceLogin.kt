package com.creeperux.sonus.core

import kotlinx.coroutines.delay
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.net.URI

/** A browser sign-in begun: the code to show (and to see again in the browser), the page to open, how often to ask,
 *  and until when (epoch milliseconds). */
data class DeviceLoginStart(
    val server: String,
    val deviceCode: String,
    val userCode: String,
    val verificationUrl: String,
    val intervalMs: Long,
    val expires: Long,
)

enum class DeviceLoginState { Pending, Approved, Denied, Expired }

/**
 * Signing in through the browser (the Sonus server's sonusDeviceLogin, as OAuth's device authorization grant), as the
 * Windows app's DeviceLogin: the app asks the server for a sign-in, opens its approval page, where the user signs in
 * (with two-step verification) and allows this app, and then gets an API key of its own: OpenSubsonic
 * apiKeyAuthentication. The app never sees the account password; the key is listed among the user's app passwords,
 * where it can be revoked, and the app gives it back when it signs out.
 */
object DeviceLogin {
    const val EXTENSION = "sonusDeviceLogin"
    private val jsonType = "application/json; charset=utf-8".toMediaType()

    private suspend fun post(http: OkHttpClient, url: String, body: Map<String, String>): Pair<Int, JsonObject?> {
        val json = JsonObject(body.mapValues { JsonPrimitive(it.value) }).toString()
        http.newCall(Request.Builder().url(url).post(json.toRequestBody(jsonType)).build()).await().use { res ->
            val text = res.body.string()
            val obj = try {
                Json.parseToJsonElement(text) as? JsonObject
            } catch (_: SerializationException) {
                null
            }
            return res.code to obj
        }
    }

    /**
     * The server's address as it answers (a private host typed without a scheme over HTTP, else HTTPS, as
     * [SubsonicClient.signIn]), and whether it offers the browser sign-in. Asked without signing in:
     * getOpenSubsonicExtensions is public.
     */
    suspend fun probe(server: String, http: OkHttpClient = SubsonicClient.Shared): Pair<String, Boolean> {
        val baseUrl = Hosts.normalizeServer(server)
        require(baseUrl.isNotEmpty()) { "请填写服务器地址。" }
        val candidates = mutableListOf(baseUrl)
        if (!server.trim().startsWith("http", ignoreCase = true) && baseUrl.startsWith("http://")) candidates += "https://" + baseUrl.removePrefix("http://")
        var last: Exception? = null
        for (candidate in candidates) {
            try {
                val url = "$candidate/rest/getOpenSubsonicExtensions.view?v=${SubsonicClient.API_VERSION}&c=Sonus&f=json"
                http.newCall(Request.Builder().url(url).build()).await().use { res ->
                    if (!res.isSuccessful) {
                        last = ServerUnreachableException("$candidate 返回了 ${res.code}。")
                        return@use
                    }
                    val body = J.obj(Json.parseToJsonElement(res.body.string()), "subsonic-response")
                    if (body == null) {
                        last = ServerUnreachableException("$candidate 不像是 Navidrome。")
                        return@use
                    }
                    return candidate to J.array(body, "openSubsonicExtensions").any { J.str(it, "name") == EXTENSION }
                }
            } catch (e: IOException) {
                last = e
            } catch (e: SerializationException) {
                last = e
            }
        }
        throw ServerUnreachableException("连不上 $baseUrl。检查地址和网络。", last)
    }

    /** Asks the server for a browser sign-in for this app ([client], "Sonus") on this device ([device], its name). */
    suspend fun start(server: String, client: String, device: String, http: OkHttpClient = SubsonicClient.Shared): DeviceLoginStart {
        val (status, r) = try {
            post(http, "$server/auth/device/start", mapOf("client" to client, "device" to device))
        } catch (e: IOException) {
            throw ServerUnreachableException("连不上 $server。检查地址和网络。", e)
        }
        if (status !in 200..299 || r == null) throw SubsonicException(0, "服务器没有开始登录（$status）。", status)
        val path = J.str(r, "verificationPath") ?: "/app/#/device"
        return DeviceLoginStart(
            server = server,
            deviceCode = J.str(r, "deviceCode") ?: throw SerializationException("no deviceCode"),
            userCode = J.str(r, "userCode") ?: throw SerializationException("no userCode"),
            verificationUrl = verificationUrl(server, path),
            intervalMs = maxOf(1, J.int(r, "interval")) * 1000L,
            expires = System.currentTimeMillis() + maxOf(30, J.int(r, "expiresIn")) * 1000L,
        )
    }

    /** The approval page: the path carries the server's base path, so it replaces the one in [server]
     *  ("https://h/music" + "/music/app/#/device?code=X" → "https://h/music/app/#/device?code=X"). */
    fun verificationUrl(server: String, path: String): String {
        val u = URI(server)
        val port = if (u.port >= 0) ":${u.port}" else ""
        return if (path.startsWith("/")) "${u.scheme}://${u.rawAuthority ?: (u.host + port)}$path" else "$server/$path"
    }

    /** How the sign-in stands now; approved, it is the sign-in to keep. */
    suspend fun poll(start: DeviceLoginStart, http: OkHttpClient = SubsonicClient.Shared): Pair<DeviceLoginState, Login?> {
        val (status, r) = post(http, "${start.server}/auth/device/poll", mapOf("deviceCode" to start.deviceCode))
        if (status !in 200..299 || r == null) return DeviceLoginState.Pending to null // asked again next time
        val key = J.str(r, "apiKey")
        return when (J.str(r, "status")) {
            "approved" -> if (!key.isNullOrEmpty()) DeviceLoginState.Approved to Login.withApiKey(start.server, J.str(r, "username").orEmpty(), key) else DeviceLoginState.Pending to null
            "denied" -> DeviceLoginState.Denied to null
            "expired" -> DeviceLoginState.Expired to null
            else -> DeviceLoginState.Pending to null
        }
    }

    /** Asks until the user decided or the sign-in expired. A network hiccup is asked again, not given up on. */
    suspend fun await(start: DeviceLoginStart, http: OkHttpClient = SubsonicClient.Shared, now: () -> Long = System::currentTimeMillis): Pair<DeviceLoginState, Login?> {
        while (now() < start.expires) {
            delay(start.intervalMs)
            try {
                val result = poll(start, http)
                if (result.first != DeviceLoginState.Pending) return result
            } catch (_: IOException) {
                // unreachable for a moment: ask again
            } catch (_: SerializationException) {
            }
        }
        return DeviceLoginState.Expired to null
    }

    /** Gives the app's API key back to the server (signing out): it stops working there at once. Best effort: false when
     *  the server could not be told (the user can still revoke it from the web). */
    suspend fun revoke(login: Login, http: OkHttpClient = SubsonicClient.Shared): Boolean {
        if (!login.isApiKey) return false
        return try {
            post(http, "${login.server}/auth/device/revoke", mapOf("apiKey" to login.apiKey!!)).first in 200..299
        } catch (_: IOException) {
            false
        }
    }
}

/** The app's name, and the client name the server lists it as ("Sonus (Pixel 9)"), as the Windows app's AppName. */
object AppName {
    const val NAME = "Sonus"
    fun client(device: String) = "$NAME ($device)"
}

/** When a play counts (the Windows app's MusicService.OnTick): past half the song or four minutes, whichever is sooner. */
object Scrobbling {
    fun countsAt(durationSeconds: Double): Double = minOf(240.0, durationSeconds / 2)
    fun counts(positionSeconds: Double, durationSeconds: Double) = durationSeconds > 0 && positionSeconds >= countsAt(durationSeconds)
}
