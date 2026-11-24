package com.creeperux.sonus.session

import android.util.Log
import com.creeperux.sonus.core.Album
import com.creeperux.sonus.core.ArtistInfo
import com.creeperux.sonus.core.LibraryBuilder
import com.creeperux.sonus.core.LibrarySnapshot
import com.creeperux.sonus.core.LyricLine
import com.creeperux.sonus.core.PlayContext
import com.creeperux.sonus.core.Playlist
import com.creeperux.sonus.core.PlaylistKind
import com.creeperux.sonus.core.RemoteQueue
import com.creeperux.sonus.core.SearchResult
import com.creeperux.sonus.core.ServerInfo
import com.creeperux.sonus.core.ServerUnreachableException
import com.creeperux.sonus.core.SubsonicClient
import com.creeperux.sonus.core.SubsonicException
import com.creeperux.sonus.core.Track
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.net.URI

/** A message for the bottom of the screen, with an optional action. */
data class Toast(val text: String, val isError: Boolean = false, val actionLabel: String? = null, val action: (() -> Unit)? = null)

/**
 * Everything the app shows and does with the music on one server, for one sign-in (the library half of the Windows
 * app's MusicService): the server, the library and playlists, likes, search. Its state is read on the main thread; its
 * functions are called from the main thread's coroutines. What it shows is what the server reports, except a like:
 * that shows at once and goes back if the server refuses it.
 */
class MusicSession(val client: SubsonicClient) {
    private val server = MutableStateFlow(ServerInfo("Navidrome", "Navidrome", SubsonicClient.API_VERSION, false))
    private val library = MutableStateFlow(LibrarySnapshot.Empty)
    private val playlists = MutableStateFlow<List<Playlist>>(emptyList())
    private val revision = MutableStateFlow(0)
    private val toasts = MutableSharedFlow<Toast>(extraBufferCapacity = 8)
    private var refreshedAt = 0L

    val serverInfo: StateFlow<ServerInfo> = server.asStateFlow()
    val libraryState: StateFlow<LibrarySnapshot> = library.asStateFlow()
    val playlistsState: StateFlow<List<Playlist>> = playlists.asStateFlow()

    /** Goes up when a song's like, play count or last played changed (the tracks are changed in place). */
    val revisionState: StateFlow<Int> = revision.asStateFlow()
    val toast: SharedFlow<Toast> = toasts.asSharedFlow()
    val online: StateFlow<Boolean> get() = client.isOnline

    val lib: LibrarySnapshot get() = library.value

    fun say(t: Toast) {
        toasts.tryEmit(t)
    }

    fun bump() {
        revision.value++
    }

    // ---------------------------------------------------------------- start and stay in step

    suspend fun start() {
        val started = System.currentTimeMillis()
        server.value = client.connect()
        // the library first, then the playlists (their songs are matched against the library)
        library.value = client.loadLibrary()
        val loaded = System.currentTimeMillis()
        val fromServer = client.getPlaylists(::remember)
        mergeUnknown()
        playlists.value = listOf(likedPlaylist(), libraryPlaylist()) + fromServer
        refreshedAt = System.currentTimeMillis()
        Log.i(TAG, "library ${lib.tracks.size} songs in ${loaded - started} ms, playlists done at ${refreshedAt - started} ms")
    }

    private val unknown = mutableListOf<JsonElement>()

    /** A song from a playlist, the play queue or a radio. Songs the library does not have are kept aside and added by
     *  [mergeUnknown], all at once. */
    fun remember(song: JsonElement): String {
        val id = ((song as JsonObject)["id"] as JsonPrimitive).content
        if (id !in library.value.trackById) synchronized(unknown) { unknown += song }
        return id
    }

    private fun mergeUnknown() {
        val songs = synchronized(unknown) { unknown.toList().also { unknown.clear() } }
            .filter { ((it as JsonObject)["id"] as JsonPrimitive).content !in lib.trackById }
        if (songs.isEmpty()) return
        val albums = lib.albumById.toMutableMap()
        val added = songs.map { LibraryBuilder.trackOf(it, albums) }.distinctBy { it.id }
        if (added.isEmpty()) return
        library.value = LibraryBuilder.group(lib.tracks + added, LinkedHashMap<String, Album>(albums))
        Log.i(TAG, "${added.size} songs from playlists or the queue were not in the library: added")
    }

    private fun likedPlaylist() = Playlist(
        id = "liked", name = "我喜欢的音乐", kind = PlaylistKind.Liked, owner = client.login.user,
        entries = lib.tracks.filter { it.liked }.sortedByDescending { it.starredAt ?: Long.MIN_VALUE }.map { it.id },
    )

    private fun libraryPlaylist() = Playlist(
        id = "library", name = "媒体库 · 全部歌曲", kind = PlaylistKind.Library, owner = server.value.name,
        comment = "${server.value.name} 媒体库（${URI(client.login.server).authority}）", entries = lib.tracks.map { it.id },
    )

    private fun rebuildSpecialPlaylists() {
        playlists.value = listOf(likedPlaylist(), libraryPlaylist()) + playlists.value.filter { it.kind == PlaylistKind.User || it.kind == PlaylistKind.ReadOnly }
    }

    fun playlist(id: String): Playlist? = playlists.value.firstOrNull { it.id == id }

    /** Reads the playlists again, and the library when the server's song count changed (another device, a rescan). */
    suspend fun refresh() {
        refreshedAt = System.currentTimeMillis()
        try {
            val n = client.songCount()
            if (n != null && n != lib.tracks.size) library.value = client.loadLibrary()
            val fromServer = client.getPlaylists(::remember)
            mergeUnknown()
            playlists.value = listOf(likedPlaylist(), libraryPlaylist()) + fromServer
        } catch (e: ServerUnreachableException) {
            Log.i(TAG, "refresh: ${e.message}")
        } catch (e: SubsonicException) {
            Log.i(TAG, "refresh: ${e.message}")
        }
    }

    /** The app came to the front: refresh at most once a minute. */
    suspend fun onActivated() {
        if (System.currentTimeMillis() - refreshedAt > 60_000) refresh()
    }

    suspend fun goOnline() {
        try {
            client.connect()
            say(Toast("已重新连接服务器"))
            refresh()
        } catch (e: Exception) {
            if (e is ServerUnreachableException || e is SubsonicException) say(Toast(e.message.orEmpty(), isError = true)) else throw e
        }
    }

    // ---------------------------------------------------------------- what plays

    /** The songs of a context: an album, a playlist, an artist, a genre, search results, the library. */
    fun contextOf(kind: String, id: String, ids: List<String>? = null): Pair<PlayContext, List<String>> = when (kind) {
        "album" -> lib.album(id).let { PlayContext(kind, id, it?.title.orEmpty()) to (ids ?: it?.trackIds ?: emptyList()) }
        "playlist" -> playlist(id).let { PlayContext(kind, id, it?.name.orEmpty()) to (ids ?: it?.trackIds ?: emptyList()) }
        "artist" -> PlayContext(kind, id, lib.artist(id)?.name.orEmpty()) to (ids ?: lib.artistTracks(id))
        "genre" -> PlayContext(kind, id, id) to (ids ?: lib.tracks.filter { it.genre == id }.map { it.id })
        "search" -> PlayContext(kind, id, "搜索“$id”") to (ids ?: emptyList())
        else -> PlayContext("library", "all", "媒体库") to (ids ?: lib.tracks.map { it.id })
    }

    /** A radio from a song: the song, then similar ones from the server (without Last.fm there: songs of the same artist
     *  or genre from the library). */
    suspend fun radioFor(trackId: String): Pair<PlayContext, List<String>>? {
        val seed = lib.track(trackId) ?: return null
        var ids = client.similarSongs(trackId, ::remember).filter { it != trackId }
        mergeUnknown()
        if (ids.isEmpty()) ids = lib.tracks.filter { it.id != trackId && (it.artistId == seed.artistId || it.genre == seed.genre) }.shuffled().take(50).map { it.id }
        if (ids.isEmpty()) return null
        return PlayContext("radio", trackId, "${seed.title} 电台") to (listOf(trackId) + ids)
    }

    suspend fun remoteQueue(): RemoteQueue? {
        val q = client.getPlayQueue(::remember)
        mergeUnknown()
        return q
    }

    // ---------------------------------------------------------------- likes and playlists

    private val likeWanted = HashMap<String, Boolean>()
    private val likeSending = HashSet<String>()

    /**
     * Likes or unlikes a song. The heart changes at once and the server is told after. One request per song is on its
     * way at a time and the last wish is sent last; if the server refuses or cannot be reached, the heart shows what the
     * server has.
     */
    suspend fun setLiked(trackId: String, liked: Boolean) {
        val t = lib.track(trackId) ?: return
        if (t.liked == liked) return
        val before = t.starredAt
        fun show(on: Boolean, at: Long?) {
            t.liked = on
            t.starredAt = at
            bump()
            rebuildSpecialPlaylists()
        }
        show(liked, if (liked) System.currentTimeMillis() else null)
        likeWanted[trackId] = liked
        if (!likeSending.add(trackId)) return // the request on its way sends this wish after it
        var server = !liked // what the server has
        try {
            while (true) {
                val want = likeWanted[trackId] ?: break
                if (want == server) break
                client.setStarred(trackId, want)
                server = want
            }
        } catch (e: Exception) {
            if (t.liked != server) show(server, if (server) before ?: System.currentTimeMillis() else null)
            if (e is ServerUnreachableException || e is SubsonicException) say(Toast(e.message.orEmpty(), isError = true)) else throw e
        } finally {
            likeSending.remove(trackId)
            likeWanted.remove(trackId)
        }
    }

    private fun own(id: String): Playlist {
        val p = playlist(id) ?: throw IllegalStateException("找不到这个歌单。")
        if (!p.isEditable) throw IllegalStateException("这是别人的歌单，只能播放，不能修改。")
        return p
    }

    private fun changedPlaylists() {
        playlists.value = playlists.value.toList()
    }

    suspend fun createPlaylist(name: String, trackIds: List<String>): Playlist {
        val id = client.createPlaylist(name, trackIds)
        val fromServer = client.getPlaylists(::remember)
        mergeUnknown()
        playlists.value = listOf(likedPlaylist(), libraryPlaylist()) + fromServer
        return (if (id != null) playlist(id) else fromServer.filter { it.name == name }.maxByOrNull { it.changed })
            ?: throw IllegalStateException("歌单已创建，但没能读回来。")
    }

    suspend fun renamePlaylist(id: String, name: String) {
        val p = own(id)
        client.updatePlaylist(id, name = name)
        p.name = name
        p.changed = System.currentTimeMillis()
        changedPlaylists()
    }

    suspend fun deletePlaylist(id: String) {
        own(id)
        client.deletePlaylist(id)
        playlists.value = playlists.value.filter { it.id != id }
    }

    suspend fun addToPlaylist(id: String, trackIds: List<String>) {
        if (id == "liked") {
            trackIds.forEach { setLiked(it, true) }
            return
        }
        val p = own(id)
        client.updatePlaylist(id, add = trackIds)
        p.entries = p.entries + trackIds
        p.changed = System.currentTimeMillis()
        changedPlaylists()
    }

    suspend fun removeFromPlaylist(id: String, trackIds: List<String>) {
        if (id == "liked") {
            trackIds.forEach { setLiked(it, false) }
            return
        }
        val p = own(id)
        val drop = trackIds.toSet()
        val indexes = p.entries.withIndex().filter { it.value in drop }.map { it.index }
        if (indexes.isEmpty()) return
        client.updatePlaylist(id, removeIndexes = indexes)
        p.entries = p.entries.filter { it !in drop }
        p.changed = System.currentTimeMillis()
        changedPlaylists()
    }

    // ---------------------------------------------------------------- searching and reading

    suspend fun search(query: String): SearchResult {
        val r = client.search(query)
        return SearchResult(
            r.tracks.filter { lib.track(it) != null },
            r.albums.filter { (lib.album(it)?.trackIds?.size ?: 0) > 0 },
            r.artists.filter { lib.artist(it) != null },
        )
    }

    fun searchPlaylists(query: String) = playlists.value.filter { it.name.contains(query, ignoreCase = true) }

    suspend fun lyrics(t: Track): List<LyricLine>? = client.lyrics(t)

    suspend fun artistInfo(artistId: String): ArtistInfo? = client.artistInfo(artistId)

    /** An album's cover at [px] on-screen pixels, asked for at the size the Windows app asks (the pixels rounded up to
     *  64, 128, 256, 512 or 1024): the same few URLs, so caches keep them. */
    fun coverUrl(albumId: String?, px: Int): String? = lib.album(albumId)?.coverArt?.let { client.coverUrl(it, coverSize(px)) }

    fun trackCoverUrl(t: Track?, px: Int): String? = t?.let { (lib.album(it.albumId)?.coverArt ?: it.coverArt)?.let { art -> client.coverUrl(art, coverSize(px)) } }

    companion object {
        private const val TAG = "Sonus"

        fun coverSize(px: Int): Int = intArrayOf(64, 128, 256, 512, 1024).firstOrNull { it >= px } ?: 1024
    }
}
