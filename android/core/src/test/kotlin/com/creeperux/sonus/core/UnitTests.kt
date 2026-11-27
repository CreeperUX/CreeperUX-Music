package com.creeperux.sonus.core

import com.google.common.truth.Truth.assertThat
import com.google.common.truth.Truth.assertWithMessage
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Before
import org.junit.Test
import kotlin.random.Random

// Ported from the Windows app's tests (tests/Sonus.Core.Tests/UnitTests.cs): the same cases, so both clients behave alike.

class SignInTests {
    @Test
    fun normalizesServerAddresses() {
        val cases = listOf(
            "music.example.com" to "https://music.example.com",
            "http://host:4533/" to "http://host:4533",
            "https://host/rest" to "https://host",
            "https://host/app/" to "https://host",
            "192.168.1.10:4533" to "http://192.168.1.10:4533",
            "localhost:4533" to "http://localhost:4533",
            "172.20.0.5:4533" to "http://172.20.0.5:4533",
            "100.101.102.103:4533" to "http://100.101.102.103:4533",
            "[fd7a:115c:a1e0::1]:4533" to "http://[fd7a:115c:a1e0::1]:4533",
            "nas:4533" to "http://nas:4533",
            "nas.local:4533" to "http://nas.local:4533",
            "nas.tail1234.ts.net:4533" to "http://nas.tail1234.ts.net:4533",
            "10.example.com" to "https://10.example.com",
            "172.32.0.1" to "https://172.32.0.1",
            "100.128.0.1" to "https://100.128.0.1",
            "[2001:db8::1]:4533" to "https://[2001:db8::1]:4533",
            "  " to "",
        )
        for ((input, expected) in cases) assertThat(Hosts.normalizeServer(input)).isEqualTo(expected)
    }

    @Test
    fun plainHttpIsFlaggedOnlyOverTheInternet() {
        val cases = listOf(
            "http://music.example.com" to true, "http://203.0.113.5:4533" to true, "http://[2001:db8::1]:4533" to true,
            "https://music.example.com" to false, "music.example.com" to false, "http://192.168.1.10:4533" to false,
            "http://100.101.102.103:4533" to false, "http://nas.local" to false, "http://localhost:4533" to false,
            "http://[::1]:4533" to false, "" to false,
        )
        for ((server, plain) in cases) assertWithMessage(server).that(Hosts.isPlainOverInternet(server)).isEqualTo(plain)
    }

    @Test
    fun ipv6LiteralsParse() {
        assertThat(Hosts.parseIpv6("::1")!!.last()).isEqualTo(1)
        assertThat(Hosts.parseIpv6("::ffff:192.168.1.2")!!.takeLast(4)).containsExactly(192, 168, 1, 2).inOrder()
        assertThat(Hosts.parseIpv6("1:2:3")).isNull()
        assertThat(Hosts.parseIpv6("nas.local")).isNull()
        assertThat(Hosts.isPrivateHost("::ffff:10.0.0.1")).isTrue()
        assertThat(Hosts.isPrivateHost("fe80::1%wlan0")).isTrue()
    }

    @Test
    fun tokenIsMd5OfPasswordAndSalt() {
        assertThat(SubsonicClient.md5Hex("")).isEqualTo("d41d8cd98f00b204e9800998ecf8427e")
        assertThat(SubsonicClient.md5Hex("sesame2b7a8c")).isEqualTo("677360458cc1b212589d3375381847cd") // the Subsonic documentation's example
        assertThat(SubsonicClient.md5Hex("中文密码salt")).isEqualTo("fa0f54b75c93ce66abceebf516b0cd4f")
    }

    @Test
    fun loginRoundTripsAndRejectsIncompleteJson() {
        val login = Login("http://h", "u", "abcd", "0123")
        assertThat(Login.fromJson(login.toJson())).isEqualTo(login)
        assertThat(Login.fromJson("{\"server\":\"http://h\",\"user\":\"u\"}")).isNull()
        assertThat(Login.fromJson("not json")).isNull()
        assertThat(login.toJson()).doesNotContain("password")
    }

    @Test
    fun urlsCarryTheTokenAndAreStable() {
        val c = SubsonicClient(Login("http://h:4533", "demo", "s1", "t1"), "Sonus (PC)")
        assertThat(c.coverUrl("al1")).isEqualTo(c.coverUrl("al1"))
        assertThat(c.coverUrl("al1")).startsWith("http://h:4533/rest/getCoverArt.view?u=demo&t=t1&s=s1&v=1.16.1&c=Sonus%20%28PC%29&f=json&id=al1&size=600")
        assertThat(c.streamUrl("t1", "mp3")).contains("format=mp3")
        assertThat(c.streamUrl("t1")).doesNotContain("format")
    }

    @Test
    fun apiKeyLoginRoundTripsAndKeepsTheKeyOutOfLogs() {
        val login = Login.withApiKey("https://h", "u", "k3y-secret")
        assertThat(login.isApiKey).isTrue()
        assertThat(Login("http://h", "u", "abcd", "0123").isApiKey).isFalse()
        assertThat(Login.fromJson(login.toJson())).isEqualTo(login)
        assertThat(login.toJson()).contains("\"apiKey\"")
        assertThat(login.toJson()).doesNotContain("token")
        assertThat(login.toString()).doesNotContain("k3y-secret")
        assertThat(Login("http://h", "u", "abcd", "0123").toString()).doesNotContain("0123")
    }

    @Test
    fun apiKeyUrlsCarryTheKeyAndNoUser() {
        val c = SubsonicClient(Login.withApiKey("http://h:4533", "demo", "abc"), "Sonus (PC)")
        val url = c.coverUrl("al1")
        assertThat(url).startsWith("http://h:4533/rest/getCoverArt.view?apiKey=abc&v=1.16.1&c=Sonus%20%28PC%29&f=json&id=al1")
        assertThat(url).doesNotContain("u=")
    }
}

class ClientTests {
    private lateinit var server: MockWebServer
    private val http = OkHttpClient()

    @Before
    fun up() {
        server = MockWebServer()
        server.start()
    }

    @After
    fun down() = server.close()

    private fun ok(body: String) = MockResponse.Builder().code(200).addHeader("Content-Type", "application/json")
        .body("{\"subsonic-response\":{\"status\":\"ok\",\"version\":\"1.16.1\"$body}}").build()

    private fun base() = server.url("/").toString().trimEnd('/')

    @Test
    fun signInTriesTheServerAndKeepsATokenNotThePassword() = runTest {
        server.enqueue(ok(""))
        val login = SubsonicClient.signIn(base(), "demo", "secret", "Sonus (Test)", http)
        assertThat(login.token).isEqualTo(SubsonicClient.md5Hex("secret" + login.salt))
        assertThat(login.toJson()).doesNotContain("secret")
        val req = server.takeRequest()
        assertThat(req.url.queryParameter("t")).isEqualTo(login.token)
        assertThat(req.url.queryParameter("p")).isNull()
    }

    @Test
    fun aWrongPasswordSaysSoInChinese() = runTest {
        server.enqueue(MockResponse.Builder().code(200).body("{\"subsonic-response\":{\"status\":\"failed\",\"error\":{\"code\":40,\"message\":\"Wrong\"}}}").build())
        val e = runCatching { SubsonicClient.signIn(base(), "demo", "x", "Sonus", http) }.exceptionOrNull()
        assertThat(e).isInstanceOf(SubsonicException::class.java)
        assertThat((e as SubsonicException).isAuthentication).isTrue()
        assertThat(e.message).isEqualTo("用户名或密码不正确。")
    }

    @Test
    fun aWebPageIsNotASubsonicServer() = runTest {
        server.enqueue(MockResponse.Builder().code(200).body("<html>hello</html>").build())
        val e = runCatching { SubsonicClient.signIn(base(), "demo", "x", "Sonus", http) }.exceptionOrNull()
        assertThat(e).isInstanceOf(ServerUnreachableException::class.java)
        assertThat(e!!.message).contains("不像是 Navidrome")
    }

    @Test
    fun writesArePostedOnlyWhenTheServerReadsForms() = runTest {
        val c = SubsonicClient(Login(base(), "demo", "s", "t"), "Sonus", http)
        server.enqueue(ok(""))
        server.enqueue(ok(",\"openSubsonicExtensions\":[{\"name\":\"formPost\",\"versions\":[1]}]"))
        c.connect()
        server.takeRequest(); server.takeRequest()
        server.enqueue(ok(""))
        c.setStarred("t1", true)
        val r = server.takeRequest()
        assertThat(r.method).isEqualTo("POST")
        assertThat(r.body!!.utf8()).contains("id=t1")
    }

    @Test
    fun theLibraryIsPagedUntilAShortPage() = runTest {
        // a server capping pages at 2: the client learns the size and reads on
        val songs = (1..5).map { """{"id":"s$it","title":"S$it","albumId":"a1","album":"A","artist":"X","track":$it,"duration":60}""" }
        server.dispatcher = object : mockwebserver3.Dispatcher() {
            override fun dispatch(request: mockwebserver3.RecordedRequest): MockResponse {
                val u = request.url
                return when (u.encodedPath) {
                    "/rest/getAlbumList2.view" ->
                        if (u.queryParameter("offset") == "0") ok(""","albumList2":{"album":[{"id":"a1","name":"A","artist":"X","artistId":"ar1","year":2020}]}""")
                        else ok(""","albumList2":{"album":[]}""")
                    "/rest/search3.view" -> {
                        val offset = u.queryParameter("songOffset")!!.toInt()
                        ok(",\"searchResult3\":{\"song\":[${songs.drop(offset).take(2).joinToString(",")}]}")
                    }
                    else -> ok("")
                }
            }
        }
        val lib = SubsonicClient(Login(base(), "demo", "s", "t"), "Sonus", http).loadLibrary()
        assertThat(lib.tracks.map { it.id }).containsExactly("s1", "s2", "s3", "s4", "s5").inOrder()
        assertThat(lib.album("a1")!!.trackIds).hasSize(5)
        assertThat(lib.artists.single().id).isEqualTo("ar1")
    }
}

class DeviceLoginTests {
    private lateinit var server: MockWebServer
    private val http = OkHttpClient()

    @Before
    fun up() {
        server = MockWebServer()
        server.start()
    }

    @After
    fun down() = server.close()

    private fun json(body: String, code: Int = 200) = MockResponse.Builder().code(code).addHeader("Content-Type", "application/json").body(body).build()

    @Test
    fun probeSaysWhetherTheServerOffersIt() = runTest {
        server.enqueue(json("{\"subsonic-response\":{\"status\":\"ok\",\"openSubsonicExtensions\":[{\"name\":\"sonusDeviceLogin\",\"versions\":[1]}]}}"))
        val base = server.url("/").toString().trimEnd('/')
        assertThat(DeviceLogin.probe(base, http)).isEqualTo(base to true)
        server.enqueue(json("{\"subsonic-response\":{\"status\":\"ok\",\"openSubsonicExtensions\":[]}}"))
        assertThat(DeviceLogin.probe("$base/", http)).isEqualTo(base to false)
    }

    @Test
    fun startsPollsAndGetsAKey() = runTest {
        val base = server.url("/music").toString()
        server.enqueue(json("{\"deviceCode\":\"dev-1\",\"userCode\":\"BCDF-GHJK\",\"verificationPath\":\"/music/app/#/device?code=BCDF-GHJK\",\"expiresIn\":600,\"interval\":1}"))
        server.enqueue(json("{\"status\":\"pending\"}"))
        server.enqueue(json("{\"status\":\"approved\",\"apiKey\":\"the-key\",\"username\":\"alice\"}"))
        val start = DeviceLogin.start(base, "Sonus", "书房电脑", http)
        assertThat(start.userCode).isEqualTo("BCDF-GHJK")
        assertThat(start.verificationUrl).isEqualTo(base.removeSuffix("/music") + "/music/app/#/device?code=BCDF-GHJK")
        val first = server.takeRequest()
        assertThat(first.url.encodedPath).isEqualTo("/music/auth/device/start")
        assertThat(Json.parseToJsonElement(first.body!!.utf8()).jsonObject["device"].toString()).isEqualTo("\"书房电脑\"")
        val (state, login) = DeviceLogin.await(start, http)
        assertThat(state).isEqualTo(DeviceLoginState.Approved)
        assertThat(login).isEqualTo(Login.withApiKey(base, "alice", "the-key"))
        assertThat(server.takeRequest().body!!.utf8()).contains("dev-1")
    }

    @Test
    fun pollReadsTheDecision() = runTest {
        val start = DeviceLoginStart(server.url("/").toString().trimEnd('/'), "dev-1", "BCDF-GHJK", "x", 1000, System.currentTimeMillis() + 60_000)
        for ((answer, expected) in listOf(
            "{\"status\":\"denied\"}" to DeviceLoginState.Denied,
            "{\"status\":\"expired\"}" to DeviceLoginState.Expired,
            "{\"status\":\"approved\"}" to DeviceLoginState.Pending, // approved without a key: not a sign-in
        )) {
            server.enqueue(json(answer))
            assertThat(DeviceLogin.poll(start, http).first).isEqualTo(expected)
        }
    }

    @Test
    fun revokeGivesTheKeyBackAndSkipsPasswordSignIns() = runTest {
        val base = server.url("/").toString().trimEnd('/')
        server.enqueue(json("", 204))
        assertThat(DeviceLogin.revoke(Login.withApiKey(base, "alice", "the-key"), http)).isTrue()
        val r = server.takeRequest()
        assertThat(r.url.encodedPath).isEqualTo("/auth/device/revoke")
        assertThat(r.body!!.utf8()).contains("the-key")
        assertThat(DeviceLogin.revoke(Login(base, "alice", "s", "t"), http)).isFalse()
        assertThat(server.requestCount).isEqualTo(1)
    }
}

class LyricsTests {
    @Test
    fun parsesLrcWithSeveralStampsAndHeaders() {
        val lines = LyricsParser.parse("[ar:Someone]\n[00:12.50]Hello\n[00:05.00][00:20]Twice\n\n[01:02.123]End")!!
        assertThat(lines.map { it.time }).containsExactly(5.0, 12.5, 20.0, 62.123).inOrder()
        assertThat(lines.map { it.text }).containsExactly("Twice", "Hello", "Twice", "End").inOrder()
    }

    @Test
    fun plainTextIsUntimedAndTrimmed() {
        val lines = LyricsParser.parse("one\ntwo\n\n")!!
        assertThat(lines.map { it.text }).containsExactly("one", "two").inOrder()
        assertThat(lines.all { it.time == null }).isTrue()
        assertThat(LyricsParser.parse("  \n ")).isNull()
    }

    @Test
    fun findsTheCurrentLine() {
        val lines = LyricsParser.parse("[00:05]a\n[00:10]b\n[00:15]c")!!
        assertThat(LyricsParser.currentLine(lines, 2.0)).isEqualTo(-1)
        assertThat(LyricsParser.currentLine(lines, 5.0)).isEqualTo(0)
        assertThat(LyricsParser.currentLine(lines, 14.9)).isEqualTo(1)
        assertThat(LyricsParser.currentLine(lines, 99.0)).isEqualTo(2)
    }

    @Test
    fun aPositiveOffsetShowsLyricsSooner() {
        val pick = Json.parseToJsonElement("""{"synced":true,"offset":500,"line":[{"start":1000,"value":"a"},{"start":200,"value":"b"}]}""")
        val lines = LyricsParser.fromStructured(pick)
        assertThat(lines.map { it.time }).containsExactly(0.5, 0.0).inOrder() // 1.0 − 0.5, and never below zero
        val later = LyricsParser.fromStructured(Json.parseToJsonElement("""{"synced":true,"offset":-500,"line":[{"start":1000,"value":"a"}]}"""))
        assertThat(later.single().time).isEqualTo(1.5)
        val unsynced = LyricsParser.fromStructured(Json.parseToJsonElement("""{"synced":false,"line":[{"value":"x"}]}"""))
        assertThat(unsynced.single().time).isNull()
    }
}

class PlayQueueTests {
    private val tracks = (0 until 10).associate { i ->
        "t$i" to Track(id = "t$i", title = "Song $i", artist = "A", artistId = "ar", album = "Album ${i / 4}", albumId = "al${i / 4}", albumArtist = "A", path = "A/Album ${i / 4}/$i.flac")
    }
    private fun queue(seed: Int = 1) = PlayQueue({ tracks[it] }, Random(seed))
    private val ctx = PlayContext("album", "x", "X")
    private val all = tracks.keys.toList()

    @Test
    fun playsInOrderAndStopsAtTheEnd() {
        val q = queue()
        assertThat(q.start(ctx, all, "t8")).isEqualTo("t8")
        assertThat(q.peek()).isEqualTo("t9")
        assertThat(q.next()).isEqualTo("t9")
        assertThat(q.peek()).isNull()
        assertThat(q.next()).isNull()
    }

    @Test
    fun repeatPlaylistWrapsAndRepeatTrackReplays() {
        val q = queue()
        q.start(ctx, all, "t9")
        q.changeOrder(PlaybackOrder.RepeatPlaylist)
        assertThat(q.peek()).isEqualTo("t0")
        assertThat(q.next()).isEqualTo("t0")
        q.changeOrder(PlaybackOrder.RepeatTrack)
        assertThat(q.peek()).isNull()
        assertThat(q.next(ended = true)).isEqualTo("t0")
        assertThat(q.next()).isEqualTo("t1") // the Next button still moves on
    }

    @Test
    fun handQueuedSongsPlayFirstAndPlayNextGoesInFront() {
        val q = queue()
        q.start(ctx, all, "t0")
        q.add(listOf("t5", "t6"))
        q.add(listOf("t9"), next = true)
        assertThat(q.entries.take(4).map { it.trackId }).containsExactly("t9", "t5", "t6", "t1").inOrder()
        assertThat(q.next()).isEqualTo("t9")
        assertThat(q.next()).isEqualTo("t5")
        assertThat(q.next()).isEqualTo("t6")
        assertThat(q.next()).isEqualTo("t1") // back in the context where it left off
    }

    @Test
    fun stopAfterCurrentStopsOnceAtTheEndOfTheSong() {
        val q = queue()
        q.start(ctx, all, "t0")
        q.stopAfterCurrent = true
        assertThat(q.peek()).isNull()
        assertThat(q.next(ended = true)).isNull()
        assertThat(q.stopAfterCurrent).isFalse()
    }

    @Test
    fun shuffleKeepsTheChosenSongFirstAndEverySongOnce() {
        val q = queue(7)
        q.changeOrder(PlaybackOrder.ShuffleTracks)
        q.start(ctx, all, "t3")
        assertThat(q.contextIds[0]).isEqualTo("t3")
        assertThat(q.contextIds.sorted()).isEqualTo(all.sorted())
        assertThat(q.contextIds).isNotEqualTo(all)
        q.changeOrder(PlaybackOrder.Default)
        assertThat(q.contextIds).isEqualTo(all) // back to the album's order
        assertThat(q.current).isEqualTo("t3")
        assertThat(q.pointer).isEqualTo(3)
    }

    @Test
    fun shuffleAlbumsKeepsAlbumsTogether() {
        val q = queue(3)
        q.changeOrder(PlaybackOrder.ShuffleAlbums)
        q.start(ctx, all, "t5")
        val albums = q.contextIds.map { tracks.getValue(it).albumId }
        assertThat(albums[0]).isEqualTo("al1")
        assertThat(albums.indices.count { it == 0 || albums[it - 1] != albums[it] }).isEqualTo(3) // three runs, one per album
    }

    @Test
    fun shuffleFoldersKeepsFoldersTogether() {
        val q = queue(5)
        q.changeOrder(PlaybackOrder.ShuffleFolders)
        q.start(ctx, all, "t9")
        val folders = q.contextIds.map { PlayQueue.folderOf(tracks.getValue(it).path) }
        assertThat(folders[0]).isEqualTo("A/Album 2")
        assertThat(folders.indices.count { it == 0 || folders[it - 1] != folders[it] }).isEqualTo(3)
    }

    @Test
    fun moveRemoveClearAndJump() {
        val q = queue()
        q.start(ctx, all, "t0")
        q.add(listOf("t7"))
        val entries = q.entries.map { it.id } // q1, c1:t1, c2:t2 …
        val order = listOf(entries[1], entries[0]) + entries.drop(2)
        q.move(order, listOf(entries[1]), toManual = true) // t1 dragged above the queued t7, into the queue section
        assertThat(q.entries.take(3).map { it.trackId }).containsExactly("t1", "t7", "t2").inOrder()
        assertThat(q.entries[0].manual).isTrue()
        q.remove(listOf(q.entries[2].id)) // t2
        assertThat(q.entries.map { it.trackId }).doesNotContain("t2")
        assertThat(q.jump(q.entries.first { it.trackId == "t4" }.id)).isEqualTo("t4")
        q.clear(manualSection = false)
        assertThat(q.entries.all { it.manual }).isTrue()
        q.clear(manualSection = true)
        assertThat(q.entries).isEmpty()
    }

    @Test
    fun theServerCopyHasTheCurrentSongAndWhatComes() {
        val q = queue()
        q.start(ctx, all, "t2")
        q.add(listOf("t8"))
        assertThat(q.forServer()).containsExactly("t0", "t1", "t2", "t8", "t3", "t4", "t5", "t6", "t7", "t8", "t9").inOrder()
        val other = queue()
        assertThat(other.adopt(ctx, q.forServer(), "t2")).isEqualTo("t2")
        assertThat(other.peek()).isEqualTo("t8")
    }

    // found in the Windows app's code review: the preloaded next song must be the one next(ended) moves to
    @Test
    fun peekAgreesWithTheEndOfTheSongWhenSongsAreQueuedByHand() {
        for ((order, stopAfter) in listOf(PlaybackOrder.RepeatTrack to false, PlaybackOrder.Default to true)) {
            val q = queue()
            q.start(ctx, all, "t0")
            q.changeOrder(order)
            q.stopAfterCurrent = stopAfter
            q.add(listOf("t7"))
            assertThat(q.peek()).isNull() // nothing different follows by itself: nothing is preloaded
            val ended = q.next(ended = true)
            assertThat(ended).isEqualTo(if (order == PlaybackOrder.RepeatTrack) "t0" else null)
            assertThat(q.entries.count { it.manual }).isEqualTo(1) // the hand-queued song is still waiting
        }
    }

    @Test
    fun peekIsTheHandQueuedSongOtherwise() {
        val q = queue()
        q.start(ctx, all, "t0")
        q.add(listOf("t7"))
        assertThat(q.next(ended = true)).isEqualTo("t7")
    }

    @Test
    fun shuffleOffGoesBackToTheContextsOwnOrderForSearchesAndRadios() {
        val q = queue(11)
        val results = listOf("t9", "t2", "t5", "t1") // a search: an order no lookup can rebuild
        q.start(PlayContext("search", "x", "搜索"), results, "t9")
        q.changeOrder(PlaybackOrder.ShuffleTracks)
        q.changeOrder(PlaybackOrder.Default)
        assertThat(q.contextIds).isEqualTo(results)
        assertThat(q.peek()).isEqualTo("t2")
    }

    @Test
    fun aStaleQueueEntryIdRemovesNothing() {
        val q = queue()
        q.start(ctx, all, "t0")
        val stale = q.entries[0].id // c1:t1
        q.next(); q.next() // t1 and t2 played: index 1 is behind the pointer now
        q.remove(listOf(stale))
        assertThat(q.entries.take(2).map { it.trackId }).containsExactly("t3", "t4").inOrder()
        q.remove(listOf("c5:t9")) // index 5 holds t5, not t9
        assertThat(q.entries.map { it.trackId }).contains("t5")
    }

    @Test
    fun previousAfterAHandQueuedSongGoesBackToTheContextSong() {
        val q = queue()
        q.start(ctx, all, "t3")
        q.add(listOf("t8"), next = true)
        assertThat(q.next()).isEqualTo("t8")
        assertThat(q.peekPrevious()).isEqualTo("t3")
        assertThat(q.previous()).isEqualTo("t3")
        assertThat(q.peekPrevious()).isEqualTo("t2")
        assertThat(q.previous()).isEqualTo("t2")
    }

    @Test
    fun peekNextAndPreviousMatchManualSkipsAcrossOrders() {
        // empty queue
        val empty = queue()
        assertThat(empty.peekNext()).isNull()
        assertThat(empty.peekPrevious()).isNull()
        assertThat(empty.hasNext()).isFalse()
        assertThat(empty.hasPrevious()).isFalse()

        // default: boundaries stop, middle peeks both ways
        val q = queue()
        q.start(ctx, all, "t0")
        assertThat(q.peekPrevious()).isNull()
        assertThat(q.hasPrevious()).isFalse()
        assertThat(q.peekNext()).isEqualTo("t1")
        assertThat(q.hasNext()).isTrue()

        q.start(ctx, all, "t9")
        assertThat(q.peekNext()).isNull()
        assertThat(q.hasNext()).isFalse()
        assertThat(q.peekPrevious()).isEqualTo("t8")
        assertThat(q.hasPrevious()).isTrue()

        // manual queue overrides peekNext even at the end of a non-repeating list
        q.add(listOf("t2"))
        assertThat(q.peekNext()).isEqualTo("t2")
        assertThat(q.hasNext()).isTrue()
        assertThat(q.next()).isEqualTo("t2")
        assertThat(q.peekPrevious()).isEqualTo("t9")
        assertThat(q.peekNext()).isNull()

        // repeat playlist and shuffled orders wrap both ways
        for (order in listOf(PlaybackOrder.RepeatPlaylist, PlaybackOrder.ShuffleTracks)) {
            val w = queue(4)
            w.changeOrder(order)
            w.start(ctx, all, "t0")
            val first = w.contextIds.first()
            val last = w.contextIds.last()
            assertThat(w.peekPrevious()).isEqualTo(last)
            assertThat(w.previous()).isEqualTo(last)
            assertThat(w.peekNext()).isEqualTo(first)
            assertThat(w.next()).isEqualTo(first)
        }

        // repeat one and stop-after-current: auto-advance peek() is null, manual peekNext() still matches next()
        val r = queue()
        r.start(ctx, all, "t3")
        r.changeOrder(PlaybackOrder.RepeatTrack)
        assertThat(r.peek()).isNull()
        assertThat(r.peekNext()).isEqualTo("t4")
        assertThat(r.peekPrevious()).isEqualTo("t2")
        r.changeOrder(PlaybackOrder.Default)
        r.stopAfterCurrent = true
        assertThat(r.peek()).isNull()
        assertThat(r.peekNext()).isEqualTo("t4")

        // random: next/previous song is unknown ahead of time, yet skipping is still possible
        val rnd = queue(2)
        rnd.start(ctx, all, "t3")
        rnd.changeOrder(PlaybackOrder.Random)
        assertThat(rnd.peekNext()).isNull()
        assertThat(rnd.peekPrevious()).isNull()
        assertThat(rnd.hasNext()).isTrue()
        assertThat(rnd.hasPrevious()).isTrue()
        rnd.add(listOf("t7"), next = true)
        assertThat(rnd.peekNext()).isEqualTo("t7")
        assertThat(rnd.next()).isEqualTo("t7")
        assertThat(rnd.peekPrevious()).isEqualTo("t3")
    }

    @Test
    fun unknownSongsAreLeftOut() {
        val q = queue()
        assertThat(q.start(ctx, listOf("nope"), null)).isNull()
        assertThat(q.start(ctx, listOf("nope", "t1"), null)).isEqualTo("t1")
    }

    @Test
    fun everyChangeIsAnnounced() {
        val q = queue()
        var changes = 0
        q.onChanged = { changes++ }
        q.start(ctx, all, "t0"); q.add(listOf("t3")); q.next(); q.changeOrder(PlaybackOrder.RepeatPlaylist)
        assertThat(changes).isEqualTo(4)
    }
}

class LibraryTests {
    @Test
    fun groupingAgainDoesNotRepeatAlbumSongs() {
        // found in the Windows app's code review: adding a song the library did not know (from a playlist) grouped every album again
        fun t(id: String, n: Int) = Track(id = id, title = id, artist = "A", artistId = "ar", album = "X", albumId = "al", albumArtist = "A", number = n)
        val albums = mutableMapOf("al" to Album(id = "al", title = "X", artist = "A", artistId = "ar"))
        val first = LibraryBuilder.group(listOf(t("a", 1), t("b", 2)), albums)
        val second = LibraryBuilder.group(first.tracks + t("c", 3), albums)
        assertThat(second.album("al")!!.trackIds).containsExactly("a", "b", "c").inOrder()
        assertThat(second.artists).hasSize(1)
    }

    @Test
    fun songsAreReadForgivingly() {
        val albums = LibraryBuilder.build(
            listOf(Json.parseToJsonElement("""{"id":"a1","name":"A","artist":"X","artistId":"ar1","releaseTypes":["EP"]}""")),
            listOf(Json.parseToJsonElement("""{"id":"s1","albumId":"a1","path":"x/y/song.flac","suffix":"FLAC","bitDepth":24,"samplingRate":96000,"starred":"2025-03-01T10:00:00Z","replayGain":{"trackGain":-6.5}}""")),
        )
        val t = albums.track("s1")!!
        assertThat(t.title).isEqualTo("song.flac") // no title: the file name
        assertThat(t.codec).isEqualTo("FLAC")
        assertThat(t.isHiRes).isTrue()
        assertThat(t.liked).isTrue()
        assertThat(t.trackGain).isEqualTo(-6.5)
        assertThat(albums.album("a1")!!.type).isEqualTo(AlbumType.Ep)
        assertThat(Formats.quality(t)).isEqualTo("FLAC · 24 bit / 96 kHz")
    }
}

class FormatTests {
    @Test
    fun durations() {
        assertThat(Formats.duration(185.9)).isEqualTo("3:05")
        assertThat(Formats.duration(3723.0)).isEqualTo("1:02:03")
        assertThat(Formats.duration(Double.NaN)).isEqualTo("0:00")
        assertThat(Formats.longDuration(4800.0)).isEqualTo("约 1 小时 20 分钟")
        assertThat(Formats.longDuration(10.0)).isEqualTo("约 1 分钟")
    }

    @Test
    fun codecs() {
        assertThat(LibraryBuilder.codecOf("dsf", 2822400, 1, "audio/x-dsf")).isEqualTo("DSD64")
        assertThat(LibraryBuilder.codecOf("dff", 5644800, 1, "")).isEqualTo("DSD128")
        assertThat(LibraryBuilder.codecOf("m4a", 48000, 24, "audio/mp4")).isEqualTo("ALAC")
        assertThat(LibraryBuilder.codecOf("m4a", 44100, 0, "audio/mp4")).isEqualTo("AAC")
        assertThat(LibraryBuilder.codecOf("ape", 44100, 16, "")).isEqualTo("Monkey's Audio")
        assertThat(LibraryBuilder.codecOf("xyz", 0, 0, "")).isEqualTo("XYZ")
    }

    @Test
    fun relative() {
        val now = java.time.OffsetDateTime.of(2026, 11, 22, 12, 0, 0, 0, java.time.ZoneOffset.UTC).toInstant().toEpochMilli()
        assertThat(Formats.relative(null, now)).isEqualTo("从未")
        assertThat(Formats.relative(now - 5 * 60_000, now)).isEqualTo("5 分钟前")
        assertThat(Formats.relative(now - 3 * 86_400_000L, now)).isEqualTo("3 天前")
        assertThat(Formats.khz(44100)).isEqualTo("44.1")
    }

    @Test
    fun scrobblingCountsPastHalfOrFourMinutes() {
        assertThat(Scrobbling.countsAt(200.0)).isEqualTo(100.0)
        assertThat(Scrobbling.countsAt(600.0)).isEqualTo(240.0)
        assertThat(Scrobbling.counts(99.0, 200.0)).isFalse()
        assertThat(Scrobbling.counts(100.0, 200.0)).isTrue()
        assertThat(Scrobbling.counts(10.0, 0.0)).isFalse()
    }
}
