//! Ported from Navidrome (GPL-3.0), © the Navidrome authors.
//!
//! More methods (see `browse.rs`): `search3` (`server/subsonic/searching.go`), `getStarred2` (`album_lists.go`),
//! `getPlaylists` and `getPlaylist` (`playlists.go`), `getPlayQueue` (`bookmarks.go`).

use rusqlite::types::Value;

use crate::subsonic::respond::MISSING_PARAMETER;

use super::browse::{int_or, string};
use super::catalog::{self, Page, Rules};
use super::json::Json;
use super::query::{self, Cond, ListOptions, QueryError, Table};
use super::{NOT_FOUND, Reply, Scope, entities, search};

const SIGNED_LINK: &str = "an artist with a picture, whose link Navidrome signs";
const SYSTEM_TYPE: &str = "a song whose content type Go takes from the system";

/// `search3`: nothing typed pages the whole library in the tables' own order (how Sonus clients read it); words go
/// through FTS5, or LIKE for Chinese, Japanese and Korean text; a MusicBrainz id is looked up as one.
pub fn search3(scope: &Scope) -> Result<Reply, QueryError> {
    let params = scope.params;
    if params.names("musicFolderId") {
        return Ok(Reply::Navidrome("musicFolderId, which Sonus clients do not send"));
    }
    if scope.options.legacy_search || scope.options.search_full_string {
        return Ok(Reply::Navidrome("Search.Backend is legacy or Search.FullString is on: Navidrome's older search"));
    }
    // getSearchParams: no query is the query "" (two quotes), which lists everything
    let query = match string(params, "query") {
        Ok(query) => query.unwrap_or("\"\""),
        Err(reply) => return Ok(reply),
    };
    let plan = search::plan(&search::normalize(query));
    let page = |count: &str, offset: &str| Page { max: int_or(params, count, 20), offset: int_or(params, offset, 0) };
    let (artists, albums, songs) = (page("artistCount", "artistOffset"), page("albumCount", "albumOffset"), page("songCount", "songOffset"));
    // a count of 0 asks for none of that kind (callSearch)
    let artists = if artists.max == 0 { Vec::new() } else { catalog::search_artists(scope.conn, scope.viewer, scope.options, &plan, artists)? };
    let albums = if albums.max == 0 { Vec::new() } else { catalog::search_albums(scope.conn, scope.viewer, scope.options, &plan, albums)? };
    let songs = if songs.max == 0 { Vec::new() } else { catalog::search_songs(scope.conn, scope.viewer, scope.options, &plan, songs)? };
    if !artists.iter().all(entities::artist_is_answerable) {
        return Ok(Reply::Navidrome(SIGNED_LINK));
    }
    if !entities::songs_are_answerable(&songs) {
        return Ok(Reply::Navidrome(SYSTEM_TYPE));
    }
    let mut j = Json::new();
    j.key("searchResult3");
    j.begin_object();
    j.array_ne("artist", &artists, |j, artist| entities::artist(j, artist, &scope.context));
    j.array_ne("album", &albums, |j, album| entities::album(j, album, &scope.context));
    j.array_ne("song", &songs, |j, song| entities::song(j, song, &scope.context));
    j.end_object();
    Ok(Reply::ok(j.finish()))
}

/// `getStarred2`: what the user starred, the latest first.
pub fn get_starred2(scope: &Scope) -> Result<Reply, QueryError> {
    if scope.params.names("musicFolderId") {
        return Ok(Reply::Navidrome("musicFolderId, which Sonus clients do not send"));
    }
    let starred = || Cond::eq("starred", Value::Integer(1));
    let libraries = scope.viewer.music_folders();
    // filter.ArtistsByStarred with ApplyArtistLibraryFilter
    let of_artists = match &libraries {
        Some(libraries) => Cond::and(vec![starred(), Cond::new(format!("library_artist.{}", libraries.sql), libraries.args.clone())]),
        None => starred(),
    };
    let order = |table| query::build_sort_order(table, "starred_at", "desc", scope.options);
    let artists = catalog::artists(scope.conn, scope.viewer, scope.options, Some(&of_artists), &order(Table::Artist))?;
    // filter.ByStarred with ApplyLibraryFilter, for albums and for songs
    let of_items = match &libraries {
        Some(libraries) => Cond::and(vec![starred().not_missing(), libraries.clone()]),
        None => starred().not_missing(),
    };
    let albums = query::albums(
        scope.conn,
        scope.viewer,
        scope.options,
        &ListOptions { filter: Some(of_items.clone()), order_by: Some(order(Table::Album)), max: 0, offset: 0 },
    )?;
    let songs = query::songs(
        scope.conn,
        scope.viewer,
        scope.options,
        &ListOptions { filter: Some(of_items), order_by: Some(order(Table::MediaFile)), max: 0, offset: 0 },
    )?;
    if !artists.iter().all(entities::artist_is_answerable) {
        return Ok(Reply::Navidrome(SIGNED_LINK));
    }
    if !entities::songs_are_answerable(&songs) {
        return Ok(Reply::Navidrome(SYSTEM_TYPE));
    }
    let mut j = Json::new();
    j.key("starred2");
    j.begin_object();
    j.array_ne("artist", &artists, |j, artist| entities::artist(j, artist, &scope.context));
    j.array_ne("album", &albums, |j, album| entities::album(j, album, &scope.context));
    j.array_ne("song", &songs, |j, song| entities::song(j, song, &scope.context));
    j.end_object();
    Ok(Reply::ok(j.finish()))
}

/// `getPlaylists`: the user's playlists and everyone's public ones (an admin: all), by name. Smart playlists are
/// listed as they were last filled: Navidrome fills them when they are read one by one, not here.
pub fn get_playlists(scope: &Scope) -> Result<Reply, QueryError> {
    let order = query::build_sort_order(Table::Playlist, "name", "", scope.options);
    let playlists = catalog::playlists(scope.conn, scope.viewer, scope.options, None, Some(&order))?;
    if playlists.iter().any(|playlist| playlist.rules() == Rules::Navidromes) {
        return Ok(Reply::Navidrome("a smart playlist with rules this server does not read as Navidrome does"));
    }
    let mut j = Json::new();
    j.key("playlists");
    j.begin_object();
    j.array_ne("playlist", &playlists, |j, playlist| {
        j.begin_object();
        entities::playlist_members(j, playlist, playlist.song_count, playlist.duration, &scope.viewer.id, &scope.context);
        j.end_object();
    });
    j.end_object();
    Ok(Reply::ok(j.finish()))
}

/// `getPlaylist`: a playlist with its songs. A smart playlist is Navidrome's: reading it may fill it anew, which
/// writes its songs.
pub fn get_playlist(scope: &Scope) -> Result<Reply, QueryError> {
    let id = match string(scope.params, "id") {
        Ok(Some(id)) => id,
        Ok(None) => return Ok(Reply::error(MISSING_PARAMETER, "missing parameter: 'id'")),
        Err(reply) => return Ok(reply),
    };
    let found = catalog::playlists(scope.conn, scope.viewer, scope.options, Some(id), None)?;
    let Some(playlist) = found.first() else { return Ok(Reply::error(NOT_FOUND, "playlist not found")) };
    if playlist.rules() != Rules::Plain {
        return Ok(Reply::Navidrome("a smart playlist: Navidrome refreshes it when it is read"));
    }
    let songs = catalog::playlist_songs(scope.conn, scope.viewer, scope.options, id)?;
    if !entities::songs_are_answerable(&songs) {
        return Ok(Reply::Navidrome(SYSTEM_TYPE));
    }
    let mut j = Json::new();
    j.key("playlist");
    j.begin_object();
    // GetWithTracks counts what it found: the songs that are there, and their length
    entities::playlist_members(&mut j, playlist, songs.len() as i64, entities::songs_duration(&songs), &scope.viewer.id, &scope.context);
    j.array_ne("entry", &songs, |j, song| entities::song(j, song, &scope.context));
    j.end_object();
    Ok(Reply::ok(j.finish()))
}

/// `getPlayQueue`: the queue the user saved, with the song that was playing and where in it.
pub fn get_play_queue(scope: &Scope) -> Result<Reply, QueryError> {
    let queue = catalog::play_queue(scope.conn, scope.viewer, scope.options)?.unwrap_or_default();
    if !entities::songs_are_answerable(&queue.songs) {
        return Ok(Reply::Navidrome(SYSTEM_TYPE));
    }
    let mut j = Json::new();
    j.key("playQueue");
    j.begin_object();
    if queue.songs.is_empty() {
        // none saved, or none of its songs left: the user's name and no time
        j.string("username", &scope.viewer.name);
        j.time("changed", None);
        j.string("changedBy", "");
    } else {
        j.array_ne("entry", &queue.songs, |j, song| entities::song(j, song, &scope.context));
        let current = usize::try_from(queue.current).ok().and_then(|index| queue.songs.get(index));
        j.string_ne("current", current.map(|song| song.id.as_str()).unwrap_or(""));
        j.int_ne("position", queue.position);
        j.string("username", &scope.viewer.name);
        j.time("changed", queue.updated_at.as_deref());
        j.string("changedBy", &queue.changed_by);
    }
    j.end_object();
    Ok(Reply::ok(j.finish()))
}
