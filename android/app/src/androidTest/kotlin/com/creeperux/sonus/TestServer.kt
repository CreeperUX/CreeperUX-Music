package com.creeperux.sonus

import android.content.Context
import androidx.test.platform.app.InstrumentationRegistry
import com.creeperux.sonus.core.Album
import com.creeperux.sonus.core.LibrarySnapshot
import com.creeperux.sonus.core.Track
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import okhttp3.FormBody
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.security.MessageDigest
import java.util.concurrent.TimeUnit
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import kotlin.random.Random

/**
 * The server the device tests talk to, as tools/test-device.ps1 hands it over in instrumentation arguments: the demo
 * server (tools/demo-server: accounts demo and friend, the password their name, and its test hooks) by default; or
 * another server, a Sonus server in front of Navidrome (tools/server-library.mjs), with throwaway users: sonusUser and
 * sonusPassword for a phone, sonusUser2 and sonusPassword2 for a tablet (one account is one playback session, and the
 * tests run on every connected device at once), sonusTwoStepUser, sonusTwoStepPassword and sonusTwoStepSecret for a user
 * with two-step verification, sonusMissing for a song the library lists whose file is gone. What the tests need from
 * the library they find by what it is (an album of long songs, a song that ends into a longer one …), on either server.
 */
object TestServer {
    private val args get() = InstrumentationRegistry.getArguments()
    private val http = OkHttpClient.Builder().readTimeout(15, TimeUnit.SECONDS).build()

    val url: String get() = args.getString("sonusServer") ?: "http://127.0.0.1:4633"

    /** The demo server, with its test hooks (/__test/…); otherwise a real server, reached through its own API only. */
    val isDemo: Boolean get() = args.getString("sonusUser").isNullOrEmpty()

    private fun tablet(context: Context) = context.resources.configuration.smallestScreenWidthDp >= 600

    /** This device's account: the phone's or the tablet's (both have the same library). */
    fun user(context: Context): String =
        if (isDemo) (if (tablet(context)) "friend" else "demo") else args.getString(if (tablet(context)) "sonusUser2" else "sonusUser")!!

    fun password(context: Context): String =
        if (isDemo) user(context) else args.getString(if (tablet(context)) "sonusPassword2" else "sonusPassword")!!

    /** A user with two-step verification (user, password, the authenticator's secret), on a real server. */
    val twoStep: Triple<String, String, String>?
        get() {
            val u = args.getString("sonusTwoStepUser") ?: return null
            return Triple(u, args.getString("sonusTwoStepPassword")!!, args.getString("sonusTwoStepSecret")!!)
        }

    /** A song the library lists whose file is gone (it cannot be played). */
    val missingFile: String? get() = if (isDemo) "t57" else args.getString("sonusMissing")

    // ---------------------------------------------------------------- what the tests take from the library

    private fun playable(t: Track) = t.id != missingFile && t.suffix !in setOf("dsf", "dff")

    /** An album of four or more songs of a minute or more that all play, on one disc. */
    fun playableAlbum(lib: LibrarySnapshot): Album =
        if (isDemo) lib.albums.first { it.title == "夜行列车" }
        else lib.albums.sortedBy { it.title }.first { a ->
            val songs = a.trackIds.mapNotNull(lib::track)
            songs.size >= 4 && songs.all { playable(it) && it.duration >= 60 && it.disc <= 1 }
        }

    /** A song that ends into a longer one of the same album (by half a minute or more), both playable: the album, the
     *  index of the first. */
    fun endsIntoLonger(lib: LibrarySnapshot): Pair<Album, Int> {
        for (a in lib.albums.sortedBy { it.title }) {
            val songs = a.trackIds.map { lib.track(it) }
            for (i in 0 until songs.size - 1) {
                val x = songs[i] ?: continue
                val y = songs[i + 1] ?: continue
                if (playable(x) && playable(y) && x.duration in 60.0..240.0 && y.duration >= x.duration + 30) return a to i
            }
        }
        throw AssertionError("the library has no song that ends into a longer one")
    }

    /** A playable song of 280 s or more (to take over more than 2 minutes in): the album, its index. */
    fun longSong(lib: LibrarySnapshot): Pair<Album, Int> {
        for (a in lib.albums.sortedBy { it.title }) {
            val i = a.trackIds.indexOfFirst { id -> lib.track(id)?.let { playable(it) && it.duration >= 280 } == true }
            if (i >= 0) return a to i
        }
        throw AssertionError("the library has no song of 280 s or more")
    }

    /** The album with the song whose file is gone, and the index of the playable song before it (null: none such). */
    fun beforeMissing(lib: LibrarySnapshot): Pair<Album, Int>? {
        val gone = missingFile ?: return null
        val a = lib.albums.firstOrNull { gone in it.trackIds } ?: return null
        val i = a.trackIds.indexOf(gone) - 1
        if (i < 0 || i + 2 >= a.trackIds.size) return null
        return a to i
    }

    // ---------------------------------------------------------------- a real server's own API

    private fun md5(s: String) = MessageDigest.getInstance("MD5").digest(s.toByteArray()).joinToString("") { "%02x".format(it) }

    /** A Subsonic request as [user] (token sign-in), its subsonic-response. */
    fun api(user: String, password: String, method: String, vararg params: Pair<String, String>): JsonObject {
        val salt = Random.nextInt(0x10000000, Int.MAX_VALUE).toString(16)
        val query = (listOf("u" to user, "t" to md5(password + salt), "s" to salt, "v" to "1.16.1", "c" to "sonus-test", "f" to "json") + params)
            .joinToString("&") { (k, v) -> "$k=${java.net.URLEncoder.encode(v, "UTF-8")}" }
        val body = http.newCall(Request.Builder().url("$url/rest/$method?$query").build()).execute().use { it.body.string() }
        return Json.parseToJsonElement(body).jsonObject["subsonic-response"]!!.jsonObject
    }

    /** The approval page's decision on a browser sign-in, as the page makes it: the user signs in on the server's page
     *  and allows the code shown in the app. With two-step verification on, both ask for an authenticator code, and a
     *  code is taken once: the second is the next 30 seconds' (up to half a minute's wait). */
    fun approve(code: String, user: String, password: String, secret: String? = null): Boolean {
        val login = buildString {
            append("""{"username":${Json.encodeToString(String.serializer(), user)},"password":${Json.encodeToString(String.serializer(), password)}""")
            if (secret != null) append(""","otp":"${totp(secret)}"""")
            append("}")
        }
        val json = "application/json".toMediaType()
        val token = http.newCall(Request.Builder().url("$url/auth/login").post(login.toRequestBody(json)).build()).execute().use { r ->
            Json.parseToJsonElement(r.body.string()).jsonObject["token"]?.toString()?.trim('"')
        } ?: return false
        val body = if (secret == null) {
            FormBody.Builder().build()
        } else {
            Thread.sleep(30_000 - System.currentTimeMillis() % 30_000 + 1_000) // the next code
            """{"code":"${totp(secret)}"}""".toRequestBody(json)
        }
        val approved = http.newCall(
            Request.Builder().url("$url/auth/device/${java.net.URLEncoder.encode(code, "UTF-8")}/approve").header("X-ND-Authorization", "Bearer $token")
                .post(body).build(),
        ).execute().use { it.code }
        return approved == 204
    }

    /** RFC 6238, as an authenticator app makes the code: HMAC-SHA1 over 30-second steps, 6 digits. */
    fun totp(secret: String, unixSeconds: Long = System.currentTimeMillis() / 1000): String {
        val alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
        var bits = 0
        var value = 0
        val key = java.io.ByteArrayOutputStream()
        for (ch in secret.trimEnd('=').uppercase()) {
            value = (value shl 5) or alphabet.indexOf(ch)
            bits += 5
            if (bits >= 8) {
                bits -= 8
                key.write((value shr bits) and 255)
            }
        }
        val counter = java.nio.ByteBuffer.allocate(8).putLong(unixSeconds / 30).array()
        val mac = Mac.getInstance("HmacSHA1").apply { init(SecretKeySpec(key.toByteArray(), "HmacSHA1")) }
        val h = mac.doFinal(counter)
        val o = h.last().toInt() and 15
        val n = ((h[o].toInt() and 0x7f) shl 24) or ((h[o + 1].toInt() and 255) shl 16) or ((h[o + 2].toInt() and 255) shl 8) or (h[o + 3].toInt() and 255)
        return (n % 1_000_000).toString().padStart(6, '0')
    }
}

/** This device's account (see [TestServer]). */
fun account(context: Context): String = TestServer.user(context)
