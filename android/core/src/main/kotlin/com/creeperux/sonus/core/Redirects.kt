package com.creeperux.sonus.core

import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Interceptor
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
 * server's from then on ([movedBase]), and sends a POST on, as a POST, to where a redirect leads ([post]).
 *
 * Only where [mayFollow] allows: the same host, and the same scheme or from http:// up to https://. Every request
 * carries the sign-in (the token or the API key in its query, a key in a POST's body), so a redirect to another host,
 * or from https:// down to http://, is neither followed ([guard], on the app's shared client) nor taken as the
 * server's address.
 */
object Redirects {
    /** The server's address a request for [apiPath] ended at ("https://h/music" for https://h/music/rest/ping.view),
     *  when a redirect [mayFollow] allows took it to another one than it was sent to (http:// up to https://, another
     *  port or base path); null when it was not redirected, was redirected where it may not go, or ended somewhere that
     *  is not that API path (a sign-in page: not the server's API). */
    fun movedBase(sent: HttpUrl, ended: HttpUrl, apiPath: String): String? {
        if (!mayFollow(sent, ended)) return null
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

    /** A request may go on to where a redirect leads: the same host, and the same scheme or from http:// up to https://
     *  (never back down, and never to another host, which would be handed the request's credentials). */
    fun mayFollow(from: HttpUrl, to: HttpUrl): Boolean =
        from.host.equals(to.host, ignoreCase = true) && (from.scheme == to.scheme || (from.scheme == "http" && to.scheme == "https"))

    /** Where a redirect answer leads, or null when it is not one (or names no place). */
    fun target(response: Response): HttpUrl? =
        if (response.isRedirect) response.header("Location")?.let { response.request.url.resolve(it) } else null

    /** Refuses a redirect [mayFollow] does not allow, before OkHttp follows it (a network interceptor: it sees each
     *  hop). OkHttp would otherwise follow one to another host, or (followSslRedirects) from https:// down to http://. */
    fun check(response: Response): Response {
        val to = target(response) ?: return response
        val from = response.request.url
        if (mayFollow(from, to)) return response
        response.close()
        throw RedirectRefusedException(from, to)
    }

    /** The interceptor that does [check] on every hop: on the app's shared client (SubsonicClient.Shared), so the API,
     *  the streams and the covers alike. */
    val guard: Interceptor = Interceptor { chain -> check(chain.proceed(chain.request())) }

    /**
     * POSTs [body] to [url] so that a redirect never turns it into a GET: redirects are not left to OkHttp but followed
     * here, as the same POST (as a 307 or 308 would have it), where [mayFollow] allows; otherwise
     * [RedirectRefusedException]. The answer's `request.url` is the address that answered.
     */
    suspend fun post(http: OkHttpClient, url: String, body: RequestBody): Response {
        val client = http.newBuilder().followRedirects(false).followSslRedirects(false).build()
        var target = url.toHttpUrl()
        repeat(6) {
            val res = client.newCall(Request.Builder().url(target).post(body).build()).await()
            if (!res.isRedirect) return res
            val to = target(res)
            res.close()
            if (to == null) throw IOException("a redirect from $target that names no place")
            if (!mayFollow(target, to)) throw RedirectRefusedException(target, to)
            target = to
        }
        throw IOException("too many redirects from $url")
    }
}

/** A redirect the app does not follow: to another host, or from https:// down to http://. */
class RedirectRefusedException(val from: HttpUrl, val to: HttpUrl) :
    IOException("服务器把请求从 ${from.scheme}://${from.host} 转到了 ${to.scheme}://${to.host}，Sonus 没有跟过去。请直接填写服务器实际的地址（通常是 https:// 开头的那个）。")
