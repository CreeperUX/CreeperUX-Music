package com.creeperux.sonus.core

import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.Response
import java.io.IOException

/**
 * A server whose address redirects (a reverse proxy answering every http:// request with 301 → https://, a moved host).
 * OkHttp follows redirects: a GET then simply answers from the new address, but the address the app keeps stays the old
 * one, and a POST becomes a GET without its body (OkHttp does what browsers do on a 301, 302 or 303), which the server
 * answers with an error (the browser sign-in's start: 401). So the app takes the address a request ended at as the
 * server's from then on ([movedBase]), and sends a POST again, as a POST, to where a redirect led ([post]).
 */
object Redirects {
    /** The server's address a request for [apiPath] ended at ("https://h/music" for https://h/music/rest/ping.view),
     *  when a redirect took it to another one than it was sent to (another scheme, host, port or base path); null when
     *  it was not redirected, or ended somewhere that is not that API path (a sign-in page: not the server's API). */
    fun movedBase(sent: HttpUrl, ended: HttpUrl, apiPath: String): String? {
        val from = baseOf(sent, apiPath) ?: return null
        val to = baseOf(ended, apiPath) ?: return null
        return to.takeIf { it != from }
    }

    private fun baseOf(url: HttpUrl, apiPath: String): String? {
        val path = url.encodedPath
        if (!path.endsWith(apiPath)) return null
        val origin = url.newBuilder().encodedPath("/").query(null).fragment(null).build().toString().removeSuffix("/")
        return origin + path.removeSuffix(apiPath)
    }

    /** A POST may be sent again to where a redirect led: the same host, and the same scheme or from http:// up to
     *  https:// (never back down, and never to another host, which would be handed the request's credentials). */
    fun mayFollow(from: HttpUrl, to: HttpUrl): Boolean =
        from.host.equals(to.host, ignoreCase = true) && (from.scheme == to.scheme || (from.scheme == "http" && to.scheme == "https"))

    /**
     * POSTs [body] to [url] so that a redirect never turns it into a GET: when the answer came from a GET (OkHttp
     * followed a 301, 302 or 303), the POST is sent again, as a POST, to where the redirect led, as a 307 or 308 would
     * have it, as long as [mayFollow] allows; otherwise [RedirectRefusedException]. The answer's `request.url` is the
     * address that answered.
     */
    suspend fun post(http: OkHttpClient, url: String, body: RequestBody): Response {
        var target = url.toHttpUrl()
        repeat(5) {
            val res = http.newCall(Request.Builder().url(target).post(body).build()).await()
            if (res.request.method == "POST") return res
            val ended = res.request.url
            res.close()
            if (!mayFollow(target, ended)) throw RedirectRefusedException(target, ended)
            target = ended
        }
        throw IOException("too many redirects from $url")
    }
}

/** A redirect the app does not follow with a POST: to another host, or from https:// down to http://. */
class RedirectRefusedException(val from: HttpUrl, val to: HttpUrl) :
    IOException("服务器把请求从 ${from.scheme}://${from.host} 转到了 ${to.scheme}://${to.host}，Sonus 没有跟过去。请直接填写服务器实际的地址（通常是 https:// 开头的那个）。")
