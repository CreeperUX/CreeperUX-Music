package com.creeperux.sonus.core

import java.net.URI

/**
 * Server addresses as the Windows client reads them (SubsonicClient.NormalizeServer, IsPrivateHost,
 * IsPlainOverInternet). Nothing here looks a name up: it runs while the user types.
 */
object Hosts {
    private val privateSuffixes = listOf(".localhost", ".local", ".lan", ".home.arpa", ".internal", ".ts.net")
    private val scheme = Regex("^https?://", RegexOption.IGNORE_CASE)
    private val restOrApp = Regex("/(rest|app)(/.*)?$", RegexOption.IGNORE_CASE)

    fun hasScheme(s: String): Boolean = scheme.containsMatchIn(s)

    /** The host of a URL, without brackets around an IPv6 address; "" when there is none. */
    fun hostOf(url: String): String = try {
        URI(url).host?.trim('[', ']').orEmpty()
    } catch (_: Exception) {
        ""
    }

    /**
     * "music.example.com", "http://host:4533/", "https://host/rest" → "https://music.example.com", "http://host:4533",
     * "https://host". Typed without http:// or https://, a private host ([isPrivateHost]), where Navidrome is usually
     * reached directly, gets HTTP; any other gets HTTPS.
     */
    fun normalizeServer(input: String?): String {
        var s = input.orEmpty().trim()
        if (s.isEmpty()) return ""
        if (!hasScheme(s)) s = (if (isPrivateHost(hostOf("http://$s"))) "http://" else "https://") + s
        s = s.trimEnd('/')
        return restOrApp.replace(s, "")
    }

    /**
     * A host whose traffic stays off the open internet: this machine; the local network (10/8, 172.16/12, 192.168/16,
     * link-local, IPv6 unique-local, a name without a dot, .local, .lan, .home.arpa, .internal); or a Tailscale tailnet
     * (100.64/10, its IPv6 addresses, which are unique-local, and .ts.net names), where WireGuard encrypts everything.
     */
    fun isPrivateHost(host: String?): Boolean {
        val h = host.orEmpty().trim().trimStart('[').trimEnd(']').trimEnd('.').lowercase()
        if (h.isEmpty()) return false
        parseIpv4(h)?.let { return isPrivateV4(it) }
        parseIpv6(h)?.let { b ->
            // an IPv4-mapped address (::ffff:a.b.c.d) is the IPv4 address
            if ((0 until 10).all { b[it] == 0 } && b[10] == 0xff && b[11] == 0xff) return isPrivateV4(b.copyOfRange(12, 16))
            if ((0 until 15).all { b[it] == 0 } && b[15] == 1) return true // ::1
            val linkLocal = b[0] == 0xfe && (b[1] and 0xc0) == 0x80
            val siteLocal = b[0] == 0xfe && (b[1] and 0xc0) == 0xc0
            val uniqueLocal = (b[0] and 0xfe) == 0xfc
            return linkLocal || siteLocal || uniqueLocal
        }
        if (h.contains(':')) return false // neither an address nor a name
        return !h.contains('.') || privateSuffixes.any { h.endsWith(it) }
    }

    private fun isPrivateV4(b: IntArray): Boolean =
        b[0] == 127 || b[0] == 10 || (b[0] == 172 && b[1] in 16..31) || (b[0] == 192 && b[1] == 168) ||
            (b[0] == 169 && b[1] == 254) || (b[0] == 100 && b[1] in 64..127)

    /**
     * Plain HTTP to a host on the internet: the sign-in token, which works like the password, would cross the internet
     * readable in every request.
     */
    fun isPlainOverInternet(server: String?): Boolean {
        val s = normalizeServer(server)
        if (!s.startsWith("http://", ignoreCase = true)) return false
        val host = hostOf(s)
        return host.isNotEmpty() && !isPrivateHost(host)
    }

    internal fun parseIpv4(s: String): IntArray? {
        val parts = s.split('.')
        if (parts.size != 4) return null
        val out = IntArray(4)
        for ((i, p) in parts.withIndex()) {
            if (p.isEmpty() || p.length > 3 || !p.all(Char::isDigit)) return null
            out[i] = p.toInt().takeIf { it <= 255 } ?: return null
        }
        return out
    }

    /** An IPv6 literal (with :: and a trailing dotted IPv4; a zone is ignored) as 16 bytes; null when it is not one. */
    internal fun parseIpv6(input: String): IntArray? {
        val s = input.substringBefore('%')
        if (!s.contains(':')) return null
        val halves = s.split("::")
        if (halves.size > 2) return null
        fun groups(part: String): List<Int>? {
            if (part.isEmpty()) return emptyList()
            val out = mutableListOf<Int>()
            val items = part.split(':')
            for ((i, g) in items.withIndex()) {
                if (i == items.lastIndex && g.contains('.')) {
                    val v4 = parseIpv4(g) ?: return null
                    out += (v4[0] shl 8) or v4[1]
                    out += (v4[2] shl 8) or v4[3]
                } else {
                    if (g.isEmpty() || g.length > 4) return null
                    out += g.toIntOrNull(16) ?: return null
                }
            }
            return out
        }
        val head = groups(halves[0]) ?: return null
        val tail = if (halves.size == 2) groups(halves[1]) ?: return null else emptyList()
        val all = if (halves.size == 2) {
            if (head.size + tail.size > 7) return null
            head + List(8 - head.size - tail.size) { 0 } + tail
        } else {
            head
        }
        if (all.size != 8) return null
        return IntArray(16) { i -> if (i % 2 == 0) all[i / 2] shr 8 else all[i / 2] and 0xff }
    }
}
