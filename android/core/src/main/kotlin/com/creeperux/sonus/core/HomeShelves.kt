package com.creeperux.sonus.core

/** A card on a shelf: an album, a playlist or an artist. */
data class CardRef(val type: String, val id: String)

/** The home page's shelves, from the play counts and dates the server keeps (the Windows app's HomeShelves). */
class HomeShelves(
    val recent: List<CardRef>,
    val playlists: List<CardRef>,
    val topArtists: List<CardRef>,
    val hiRes: List<CardRef>,
    val added: List<CardRef>,
    val forgotten: List<CardRef>,
) {
    companion object {
        fun from(lib: LibrarySnapshot, playlists: List<Playlist>): HomeShelves {
            val last = HashMap<String, Long>()
            val plays = HashMap<String, Int>()
            val added = HashMap<String, Long>()
            for (t in lib.tracks) {
                t.lastPlayed?.let { lp -> if ((last[t.albumId] ?: Long.MIN_VALUE) < lp) last[t.albumId] = lp }
                plays[t.artistId] = (plays[t.artistId] ?: 0) + t.playCount
                t.added?.let { ad -> if ((added[t.albumId] ?: Long.MIN_VALUE) < ad) added[t.albumId] = ad }
            }
            fun lastOf(a: Album) = last[a.id] ?: Long.MIN_VALUE
            val albums = lib.albums
            return HomeShelves(
                recent = albums.filter { it.id in last }.sortedByDescending(::lastOf).map { CardRef("album", it.id) },
                playlists = playlists.filter { it.kind != PlaylistKind.Library }.map { CardRef("playlist", it.id) },
                topArtists = lib.artists.filter { it.albumIds.isNotEmpty() }.sortedByDescending { plays[it.id] ?: 0 }.map { CardRef("artist", it.id) },
                hiRes = albums.filter { lib.track(it.trackIds.firstOrNull())?.isHiRes == true }.map { CardRef("album", it.id) },
                added = albums.sortedByDescending { added[it.id] ?: Long.MIN_VALUE }.map { CardRef("album", it.id) },
                forgotten = albums.filter { it.id in last }.sortedBy(::lastOf).map { CardRef("album", it.id) },
            )
        }
    }
}
