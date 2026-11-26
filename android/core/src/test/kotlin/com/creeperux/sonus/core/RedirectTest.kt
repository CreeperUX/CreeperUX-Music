package com.creeperux.sonus.core

import com.google.common.truth.Truth.assertThat
import com.sun.net.httpserver.HttpServer
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import org.junit.AfterClass
import org.junit.Assume.assumeTrue
import org.junit.BeforeClass
import org.junit.Test
import java.io.File
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.util.concurrent.TimeUnit

/** Where the redirects lead, unit by unit. */
class RedirectsTest {
    private fun moved(sent: String, ended: String, path: String) = Redirects.movedBase(sent.toHttpUrl(), ended.toHttpUrl(), path)

    @Test
    fun theAddressARedirectLedTo() {
        assertThat(moved("http://music.example.com/rest/ping.view?u=a", "https://music.example.com/rest/ping.view?u=a", "/rest/ping.view")).isEqualTo("https://music.example.com")
        assertThat(moved("http://h/rest/ping.view", "https://h/music/rest/ping.view", "/rest/ping.view")).isEqualTo("https://h/music")
        assertThat(moved("http://h/rest/ping.view", "https://h:8443/rest/ping.view", "/rest/ping.view")).isEqualTo("https://h:8443")
        assertThat(moved("http://[fd00::1]:4533/auth/device/start", "https://[fd00::1]/auth/device/start", "/auth/device/start")).isEqualTo("https://[fd00::1]")
        // not redirected, or redirected to something that is not the API (a sign-in page)
        assertThat(moved("https://h/rest/ping.view", "https://h/rest/ping.view", "/rest/ping.view")).isNull()
        assertThat(moved("http://h/rest/ping.view", "https://h/login", "/rest/ping.view")).isNull()
    }

    @Test
    fun aPostFollowsOnlyToTheSameHostAndNeverDownToHttp() {
        assertThat(Redirects.mayFollow("http://h/a".toHttpUrl(), "https://h/a".toHttpUrl())).isTrue()
        assertThat(Redirects.mayFollow("http://h/a".toHttpUrl(), "http://h:8080/a".toHttpUrl())).isTrue()
        assertThat(Redirects.mayFollow("https://h/a".toHttpUrl(), "http://h/a".toHttpUrl())).isFalse()
        assertThat(Redirects.mayFollow("https://h/a".toHttpUrl(), "https://other/a".toHttpUrl())).isFalse()
    }
}

/**
 * A server behind an address that redirects, as the owner's reverse proxy answers every http:// request with 301 to
 * https://: here a small front on its own port answers everything with 301 to the demo server (another port, so another
 * server address, as http:// → https:// is). The probe, the browser sign-in (its POSTs), the password sign-in and the
 * API's POSTs must all work through it, and the app must keep the address the redirect led to. Skipped without node.
 */
class RedirectTest {
    companion object {
        private var process: Process? = null
        private var base = ""
        private val fronts = mutableListOf<HttpServer>()
        private val http = OkHttpClient.Builder().readTimeout(20, TimeUnit.SECONDS).build()

        @JvmStatic
        @BeforeClass
        fun startServer() {
            val script = File(demoRepo(), "tools/demo-server/demo-server.mjs")
            assumeTrue("the demo server is in the repository", script.isFile)
            val port = ServerSocket(0).use { it.localPort }
            val p = runCatching { ProcessBuilder("node", script.absolutePath, port.toString()).redirectErrorStream(true).start() }.getOrNull()
            assumeTrue("node is on the PATH", p != null)
            process = p
            assertThat(p!!.inputStream.bufferedReader().readLine().orEmpty()).contains("demo server")
            base = "http://127.0.0.1:$port"
        }

        @JvmStatic
        @AfterClass
        fun stopServer() {
            fronts.forEach { it.stop(0) }
            process?.destroy()
        }

        /** A front that answers every request (any method) with [status] and the same path and query at [target]. */
        private fun front(target: String, status: Int = 301): String {
            val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
            server.createContext("/") { ex ->
                ex.requestBody.readAllBytes()
                val uri = ex.requestURI
                ex.responseHeaders.add("Location", target + uri.rawPath + (uri.rawQuery?.let { "?$it" } ?: ""))
                ex.sendResponseHeaders(status, -1)
                ex.close()
            }
            server.start()
            fronts += server
            return "http://127.0.0.1:${server.address.port}"
        }
    }

    private fun get(path: String): String = http.newCall(Request.Builder().url("$base$path").build()).execute().use { it.body.string() }

    @Test
    fun theProbeGivesTheAddressTheRedirectLedTo() = runBlocking {
        val (server, supported) = DeviceLogin.probe(front(base), http)
        assertThat(server).isEqualTo(base)
        assertThat(supported).isTrue()
    }

    @Test
    fun browserSignInWorksThroughARedirectingAddress() = runBlocking {
        val redirecting = front(base)
        // started at the redirecting address itself (the POST is sent on as a POST, not turned into a GET: no 401)
        val start = DeviceLogin.start(redirecting, "Sonus", "测试手机", http)
        assertThat(start.server).isEqualTo(base)
        assertThat(start.verificationUrl).startsWith("$base/app/#/device")
        val waiting = async { DeviceLogin.await(start, http) }
        delay(300)
        assertThat(get("/__test/device?code=${start.userCode}&decide=allow")).contains("\"decided\":true")
        val (state, login) = waiting.await()
        assertThat(state).isEqualTo(DeviceLoginState.Approved)
        assertThat(login!!.server).isEqualTo(base)
        val c = SubsonicClient(login, "Sonus (Test)", http)
        assertThat(c.connect().name).isEqualTo("Navidrome")
        // given back through the redirecting address too (a POST): the key stops working
        assertThat(DeviceLogin.revoke(login.copy(server = redirecting), http)).isTrue()
        val e = runCatching { c.connect() }.exceptionOrNull()
        assertThat((e as SubsonicException).isAuthentication).isTrue()
    }

    @Test
    fun aTemporaryRedirectWorksToo() = runBlocking {
        val start = DeviceLogin.start(front(base, status = 302), "Sonus", "测试手机", http)
        assertThat(start.server).isEqualTo(base)
        val start2 = DeviceLogin.start(front(base, status = 307), "Sonus", "测试手机", http) // a POST by itself
        assertThat(start2.server).isEqualTo(base)
    }

    @Test
    fun passwordSignInKeepsTheAddressTheRedirectLedTo() = runBlocking {
        val login = SubsonicClient.signIn(front(base), "demo", "demo", "Sonus (Test)", http)
        assertThat(login.server).isEqualTo(base)
    }

    @Test
    fun aKeptSignInAtARedirectingAddressMovesAndItsPostsStayPosts() = runBlocking {
        // a sign-in kept from before (0.2.0 kept the address typed): the first request moves it
        val kept = SubsonicClient.signIn(base, "demo", "demo", "Sonus (Test)", http).copy(server = front(base))
        val c = SubsonicClient(kept, "Sonus (Test)", http)
        c.connect()
        assertThat(c.login.server).isEqualTo(base)
        assertThat(c.extensions).contains("formPost")
        // a POSTed form through a redirecting address: sent on as a POST with its form, not as a GET without it
        val other = SubsonicClient(kept.copy(server = front(base)), "Sonus (Test)", http)
        other.extensions = c.extensions // as connect() finds them, without a request that would move the address first
        val id = other.createPlaylist("经过重定向", listOf("t1", "t2"))
        assertThat(id).isNotEmpty()
        assertThat(other.login.server).isEqualTo(base)
        other.deletePlaylist(id!!)
    }

    @Test
    fun aPostIsNotSentOnToAnotherHost() = runBlocking {
        // the same demo server, by another host name: a POST (with what it carries) is not handed to another host
        val elsewhere = front(base.replace("127.0.0.1", "localhost"))
        val e = runCatching { DeviceLogin.start(elsewhere, "Sonus", "测试手机", http) }.exceptionOrNull()
        assertThat(e).isInstanceOf(SubsonicException::class.java)
        assertThat(e!!.message).contains("没有跟过去")
        assertThat(e.message).doesNotContain("401")
    }
}
