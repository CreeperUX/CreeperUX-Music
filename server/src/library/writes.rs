//! The writes Sonus clients make that are answered here (phase 4 of docs/server-roadmap.md), written to Navidrome's
//! tables exactly as Navidrome writes them, so that either server reads them back the same.
//!
//! Ported from Navidrome (GPL-3.0), © the Navidrome authors: `server/subsonic/media_annotation.go` (`star`,
//! `unstar`, `setRating`), `server/subsonic/bookmarks.go` (`savePlayQueue`), `persistence/sql_annotations.go`
//! (`annUpsert`, `SetStar`, `SetRating`, `updateAvgRating`), `persistence/playqueue_repository.go` (`Store`),
//! `model/get_entity.go` (`GetEntityByID`); for playlists, see below.
//!
//! Every method runs in one `BEGIN IMMEDIATE` transaction (Navidrome runs `star` and `unstar` in one; `setRating` and
//! `savePlayQueue` are two or three statements there, each its own: the end state is the same). Navidrome's web UI
//! hears of a star or a rating through its event broker (`refreshResource`); writes made here send nothing there
//! (decision 2 of the roadmap: the old web UI does not refresh by itself).

use rusqlite::{Connection, OptionalExtension, params};

use super::browse::{int_or, parse_int, required, required_int, string};
use super::catalog::playlist_filter;
use super::query::{QueryResult, Viewer, text, truthy};
use super::{NOT_FOUND, Reply, Scope};
use crate::gotime;
use crate::subsonic::respond::{AUTHORIZATION_FAIL, GENERIC, MISSING_PARAMETER};

/// The methods answered here that write.
pub const METHODS: [&str; 9] =
    ["star", "unstar", "setRating", "savePlayQueue", "createPlaylist", "updatePlaylist", "deletePlaylist", "scrobble", "reportPlayback"];

/// What an id names, as `GetEntityByID` finds it: the table its annotations are kept for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Item {
    Artist,
    Album,
    Playlist,
    /// A song, and also a radio station: Navidrome's switch sends whatever is not an artist, album or playlist to
    /// the media file repository, so a radio's star is kept as a `media_file` annotation.
    Song,
}

impl Item {
    /// The table and `annotation.item_type`.
    pub fn table(self) -> &'static str {
        match self {
            Item::Artist => "artist",
            Item::Album => "album",
            Item::Playlist => "playlist",
            Item::Song => "media_file",
        }
    }
}

/// `model.GetEntityByID`: the first of artist, album, playlist, song, radio that has the id and that the user sees
/// (each repository's `Get`, with its library filter; a playlist the user's own or public, every one for an admin).
pub fn find(conn: &Connection, viewer: &Viewer, id: &str) -> QueryResult<Option<Item>> {
    // artist: selectArtist joins library_artist (and user_library for a user who is not an admin)
    let artist = if viewer.is_admin {
        "SELECT 1 FROM artist JOIN library_artist ON library_artist.artist_id = artist.id WHERE artist.id = ?1 LIMIT 1".to_string()
    } else {
        "SELECT 1 FROM artist JOIN library_artist ON library_artist.artist_id = artist.id \
         JOIN user_library ON user_library.library_id = library_artist.library_id AND user_library.user_id = ?2 \
         WHERE artist.id = ?1 LIMIT 1"
            .to_string()
    };
    if exists(conn, &artist, id, viewer)? {
        return Ok(Some(Item::Artist));
    }
    if exists(conn, &with_library("album", viewer), id, viewer)? {
        return Ok(Some(Item::Album));
    }
    let visible = playlist_filter(viewer);
    let mut args: Vec<rusqlite::types::Value> = vec![rusqlite::types::Value::Text(id.to_string())];
    args.extend(visible.args);
    let playlist = format!("SELECT 1 FROM playlist WHERE playlist.id = ? AND {} LIMIT 1", visible.sql);
    if conn.prepare_cached(&playlist)?.query(rusqlite::params_from_iter(args))?.next()?.is_some() {
        return Ok(Some(Item::Playlist));
    }
    if exists(conn, &with_library("media_file", viewer), id, viewer)? {
        return Ok(Some(Item::Song));
    }
    if conn.prepare_cached("SELECT 1 FROM radio WHERE id = ?1")?.query([id])?.next()?.is_some() {
        return Ok(Some(Item::Song));
    }
    Ok(None)
}

/// `SELECT 1 FROM <table> WHERE id = ?1`, with Navidrome's library filter for a user who does not see every library.
fn with_library(table: &str, viewer: &Viewer) -> String {
    match viewer.library_filter(table) {
        None => format!("SELECT 1 FROM {table} WHERE {table}.id = ?1 LIMIT 1"),
        // (the filter's one argument is the user's id: ?2 here)
        Some(_) => format!(
            "SELECT 1 FROM {table} WHERE {table}.id = ?1 AND {table}.library_id IN (SELECT ul.library_id FROM user_library ul WHERE ul.user_id = ?2) LIMIT 1"
        ),
    }
}

fn exists(conn: &Connection, sql: &str, id: &str, viewer: &Viewer) -> QueryResult<bool> {
    let mut statement = conn.prepare_cached(sql)?;
    let found =
        if statement.parameter_count() == 2 { statement.query(params![id, viewer.id])?.next()?.is_some() } else { statement.query([id])?.next()?.is_some() };
    Ok(found)
}

/// `annUpsert`: update the user's annotation of the item, and insert one when there was none. `set` is the columns
/// and their values, in Navidrome's terms (`starred`/`starred_at`, `rating`/`rated_at`).
fn upsert(conn: &Connection, user: &str, item: Item, id: &str, set: &[(&str, rusqlite::types::Value)]) -> QueryResult<()> {
    let assignments = set.iter().enumerate().map(|(i, (column, _))| format!("{column} = ?{}", i + 4)).collect::<Vec<_>>().join(", ");
    let mut args: Vec<rusqlite::types::Value> = vec![user.to_string().into(), item.table().to_string().into(), id.to_string().into()];
    args.extend(set.iter().map(|(_, value)| value.clone()));
    let update = format!("UPDATE annotation SET {assignments} WHERE annotation.user_id = ?1 AND annotation.item_type = ?2 AND annotation.item_id = ?3");
    if conn.prepare_cached(&update)?.execute(rusqlite::params_from_iter(args.iter()))? > 0 {
        return Ok(());
    }
    let columns = set.iter().map(|(column, _)| *column).collect::<Vec<_>>().join(", ");
    let marks = (4..4 + set.len()).map(|i| format!("?{i}")).collect::<Vec<_>>().join(", ");
    let insert = format!("INSERT INTO annotation (user_id, item_type, item_id, {columns}) VALUES (?1, ?2, ?3, {marks})");
    conn.prepare_cached(&insert)?.execute(rusqlite::params_from_iter(args.iter()))?;
    Ok(())
}

/// `star` and `unstar`: every `id`, `albumId` and `artistId`, in that order; ids nobody sees are skipped.
pub fn star(scope: &Scope, starred: bool) -> QueryResult<Reply> {
    let mut ids = Vec::new();
    for name in ["id", "albumId", "artistId"] {
        for value in scope.params.all(name) {
            let Ok(text) = std::str::from_utf8(value) else { return Ok(Reply::Navidrome("a parameter that is not text")) };
            ids.push(text.to_string());
        }
    }
    if ids.is_empty() {
        return Ok(Reply::error(MISSING_PARAMETER, "Required id parameter is missing"));
    }
    for id in &ids {
        // (Navidrome skips an unknown id with a warning in its log)
        let Some(item) = find(scope.conn, scope.viewer, id)? else { continue };
        // SetStar: time.Now() for each item, as Navidrome takes it
        upsert(scope.conn, &scope.viewer.id, item, id, &[("starred", starred.into()), ("starred_at", gotime::now_local().into())])?;
    }
    Ok(Reply::ok(String::new()))
}

/// `setRating`: the user's rating of the item, and its average over every user's rating.
pub fn set_rating(scope: &Scope) -> QueryResult<Reply> {
    let id = match required(scope.params, "id") {
        Ok(id) => id,
        Err(reply) => return Ok(reply),
    };
    let rating = match required_int(scope.params, "rating") {
        Ok(rating) => rating,
        Err(reply) => return Ok(reply),
    };
    // Navidrome's int is 64 bits; the column holds what it is given
    let Some(item) = find(scope.conn, scope.viewer, id)? else {
        return Ok(Reply::error(NOT_FOUND, "data not found"));
    };
    upsert(scope.conn, &scope.viewer.id, item, id, &[("rating", rating.into()), ("rated_at", gotime::now_local().into())])?;
    // updateAvgRating, on the item's own table (a radio's: media_file, where no row has its id)
    let table = item.table();
    scope.conn.execute(
        &format!(
            "UPDATE {table} SET average_rating = coalesce((select round(avg(rating), 2) from annotation where item_id = ?1 and item_type = ?2 and rating > 0), 0) WHERE id = ?3"
        ),
        params![id, table, id],
    )?;
    Ok(Reply::ok(String::new()))
}

/// `savePlayQueue`: the user's queue replaced by the songs given (none: no queue), the current one the first
/// `current` in it (else the first), the position as given (0 when it is not a number), `changed_by` the client.
pub fn save_play_queue(scope: &Scope) -> QueryResult<Reply> {
    let mut ids = Vec::new();
    for value in scope.params.all("id") {
        let Ok(text) = std::str::from_utf8(value) else { return Ok(Reply::Navidrome("a parameter that is not text")) };
        ids.push(text);
    }
    let current = match string(scope.params, "current") {
        Ok(current) => current.unwrap_or(""),
        Err(reply) => return Ok(reply),
    };
    let position = int_or(scope.params, "position", 0);
    let index = ids.iter().position(|id| *id == current).unwrap_or(0) as i64;
    let user = &scope.viewer.id;
    // Store: the queue's id is kept from the one there was; the row is deleted and written again
    let existing: Option<String> =
        scope.conn.query_row("SELECT id FROM playqueue WHERE user_id = ?1 LIMIT 1", [user], |row| row.get::<_, Option<String>>(0)).optional()?.flatten();
    scope.conn.execute("DELETE FROM playqueue WHERE user_id = ?1", [user])?;
    if ids.is_empty() {
        return Ok(Reply::ok(String::new()));
    }
    let now = gotime::now_local();
    let (id, created_at) = match existing.filter(|id| !id.is_empty()) {
        // a queue saved again: Navidrome's model has no creation time then (the zero time.Time), and writes it
        Some(id) => (id, gotime::ZERO.to_string()),
        None => match crate::id::new_random() {
            Ok(id) => (id, now.clone()),
            Err(_) => return Ok(Reply::Navidrome("no random id could be made")),
        },
    };
    // `items`: the ids joined by commas, as given (Navidrome does not check them)
    scope.conn.execute(
        "INSERT INTO playqueue (id, user_id, current, position, changed_by, items, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![id, user, index, position, scope.context.client, ids.join(","), created_at, now],
    )?;
    Ok(Reply::ok(String::new()))
}

// ---------------------------------------------------------------- playlists
//
// Ported from Navidrome (GPL-3.0), © the Navidrome authors: `server/subsonic/playlists.go` (`createPlaylist`,
// `updatePlaylist`, `deletePlaylist`), `core/playlists/playlists.go` (`Create`, `Update`, `Delete`, `checkWritable`,
// `checkTracksEditable`), `persistence/playlist_repository.go` (`Put`, `addTracks`, `keepAccessible`,
// `refreshCounters`, `renumber`, `enqueueCoverRebuild`), `persistence/playlist_track_repository.go` (`Add`, `Delete`),
// `persistence/artwork_queue_repository.go` (`Enqueue`).

/// Error 50 in Navidrome's words: someone else's playlist, or one whose songs are not the user's to change.
fn not_authorized() -> Reply {
    Reply::error(AUTHORIZATION_FAIL, "User is not authorized for the given operation")
}

/// A playlist as Navidrome's `Get` loads it, with what `Put` writes back.
struct PlaylistRow {
    id: String,
    name: String,
    comment: String,
    owner_id: String,
    public: bool,
    path: String,
    sync: bool,
    uploaded_image: String,
    external_image_url: String,
    imported_hash: String,
    evaluated_at: Option<String>,
    rules: String,
}

/// `playlistRepository.Get`: a playlist the user sees (their own or a public one; every one for an admin).
fn visible_playlist(conn: &Connection, viewer: &Viewer, id: &str) -> QueryResult<Option<PlaylistRow>> {
    let visible = playlist_filter(viewer);
    let mut args: Vec<rusqlite::types::Value> = vec![id.to_string().into()];
    args.extend(visible.args);
    let sql = format!(
        "SELECT id, name, comment, owner_id, public, path, sync, coalesce(uploaded_image, ''), coalesce(external_image_url, ''), \
         imported_hash, evaluated_at, coalesce(rules, '') FROM playlist WHERE playlist.id = ? AND {}",
        visible.sql
    );
    let mut statement = conn.prepare_cached(&sql)?;
    let mut rows = statement.query(rusqlite::params_from_iter(args))?;
    let Some(row) = rows.next()? else { return Ok(None) };
    Ok(Some(PlaylistRow {
        id: text(row, 0),
        name: text(row, 1),
        comment: text(row, 2),
        owner_id: text(row, 3),
        public: truthy(row.get_ref(4)?),
        path: text(row, 5),
        sync: truthy(row.get_ref(6)?),
        uploaded_image: text(row, 7),
        external_image_url: text(row, 8),
        imported_hash: text(row, 9),
        evaluated_at: row.get::<_, Option<String>>(10).ok().flatten(),
        rules: text(row, 11),
    }))
}

/// `checkWritable`: Err is the answer (70 not found, 50 not the user's), or a request that is Navidrome's.
fn writable(scope: &Scope, id: &str) -> QueryResult<Result<PlaylistRow, Reply>> {
    let Some(playlist) = visible_playlist(scope.conn, scope.viewer, id)? else {
        return Ok(Err(Reply::error(NOT_FOUND, "data not found")));
    };
    if !scope.viewer.is_admin && playlist.owner_id != scope.viewer.id {
        return Ok(Err(not_authorized()));
    }
    // A smart playlist is Navidrome's: its Put writes the rules back as it marshals them and leaves its counters to
    // the next evaluation; it is not something Sonus clients change.
    if !playlist.rules.is_empty() {
        return Ok(Err(Reply::Navidrome("a smart playlist: Navidrome writes its rules")));
    }
    Ok(Ok(playlist))
}

/// `enqueueCoverRebuild`: Navidrome's artwork worker (it polls its queue every 5 s) makes the playlist's cover anew.
fn enqueue_cover(conn: &Connection, id: &str) -> QueryResult<()> {
    let now = gotime::now_local();
    conn.prepare_cached(
        "INSERT INTO artwork_queue (item_kind, item_id, image_type, priority, attempts, retry_at, enqueued_at) VALUES ('pl', ?1, 'primary', 50, 0, ?2, ?2) \
         ON CONFLICT (item_kind, item_id, image_type) DO UPDATE SET priority = MAX(priority, excluded.priority), retry_at = excluded.retry_at, \
         attempts = 0, enqueued_at = excluded.enqueued_at, trace = '[]'",
    )?
    .execute(params![id, now])?;
    Ok(())
}

/// `refreshCounters`: the playlist's length, size and number of songs from its tracks that are there (Navidrome reads
/// the sums into float32s, and writes those).
fn refresh_counters(conn: &Connection, id: &str) -> QueryResult<()> {
    let (duration, size, count): (f64, f64, f64) = conn.query_row(
        "SELECT coalesce(sum(duration), 0), coalesce(sum(size), 0), count(*) FROM media_file JOIN playlist_tracks f ON f.media_file_id = media_file.id WHERE playlist_id = ?1",
        [id],
        |row| Ok((float_of(row.get_ref(0)?), float_of(row.get_ref(1)?), float_of(row.get_ref(2)?))),
    )?;
    let f32_ = |x: f64| f64::from(x as f32);
    conn.prepare_cached("UPDATE playlist SET duration = ?1, size = ?2, song_count = ?3, updated_at = ?4 WHERE id = ?5")?.execute(params![
        f32_(duration),
        f32_(size),
        f32_(count),
        gotime::now_local(),
        id
    ])?;
    Ok(())
}

fn float_of(value: rusqlite::types::ValueRef) -> f64 {
    match value {
        rusqlite::types::ValueRef::Integer(i) => i as f64,
        rusqlite::types::ValueRef::Real(f) => f,
        _ => 0.0,
    }
}

/// `keepAccessible`: the ids the user can read, in order, duplicates kept (all of them, unchecked, for a user who sees
/// every library, as Navidrome keeps them).
fn keep_accessible(conn: &Connection, viewer: &Viewer, ids: &[String]) -> QueryResult<Vec<String>> {
    if viewer.library_filter("media_file").is_none() {
        return Ok(ids.to_vec());
    }
    let mut accessible = std::collections::HashSet::new();
    let mut found = conn.prepare_cached(
        "SELECT id FROM media_file WHERE id = ?1 AND media_file.library_id IN (SELECT ul.library_id FROM user_library ul WHERE ul.user_id = ?2)",
    )?;
    for id in ids {
        if !accessible.contains(id) && found.exists(params![id, viewer.id])? {
            accessible.insert(id.clone());
        }
    }
    Ok(ids.iter().filter(|id| accessible.contains(*id)).cloned().collect())
}

/// `addTracks`: the songs the user can read appended from position `start` (1-based, the track's `id`), then the
/// cover queued and the counters refreshed.
fn add_tracks(conn: &Connection, viewer: &Viewer, id: &str, start: i64, ids: &[String]) -> QueryResult<()> {
    let ids = keep_accessible(conn, viewer, ids)?;
    let mut insert = conn.prepare_cached("INSERT INTO playlist_tracks (playlist_id, media_file_id, id) VALUES (?1, ?2, ?3)")?;
    for (i, song) in ids.iter().enumerate() {
        insert.execute(params![id, song, start + i as i64])?;
    }
    enqueue_cover(conn, id)?;
    refresh_counters(conn, id)
}

/// `playlistTrackRepository.Add`: appended after the highest position.
fn append_tracks(conn: &Connection, viewer: &Viewer, id: &str, ids: &[String]) -> QueryResult<()> {
    if ids.is_empty() {
        return Ok(());
    }
    let max: Option<i64> = conn.query_row("SELECT max(id) FROM playlist_tracks WHERE playlist_id = ?1", [id], |row| row.get(0))?;
    add_tracks(conn, viewer, id, max.unwrap_or(0) + 1, ids)
}

/// `playlistTrackRepository.Delete` and `renumber`: the tracks at these positions removed, the rest numbered 1, 2, …
/// in their order (through negative numbers, as Navidrome does, so no two rows share a number on the way).
fn remove_tracks(conn: &Connection, id: &str, positions: &[i64]) -> QueryResult<()> {
    let mut delete = conn.prepare_cached("DELETE FROM playlist_tracks WHERE playlist_id = ?1 AND id = ?2")?;
    for position in positions {
        delete.execute(params![id, position])?;
    }
    conn.execute("UPDATE playlist_tracks SET id = -id WHERE playlist_id = ?1 AND id > 0", [id])?;
    conn.execute(
        "WITH new_ids AS (SELECT rowid as rid, ROW_NUMBER() OVER (ORDER BY id DESC) as new_id FROM playlist_tracks WHERE playlist_id = ?1) \
         UPDATE playlist_tracks SET id = new_ids.new_id FROM new_ids WHERE playlist_tracks.rowid = new_ids.rid AND playlist_tracks.playlist_id = ?1",
        [id],
    )?;
    enqueue_cover(conn, id)?;
    refresh_counters(conn, id)
}

/// `Put` of a playlist that is there, without tracks: every column written back from the model (its counters as
/// they were loaded, `refreshCounters` writes them anew right after), `updated_at` now; `created_at` is never written
/// on an update.
fn put_playlist(conn: &Connection, p: &PlaylistRow) -> QueryResult<()> {
    // the loaded counters, as the model holds them (float32 for the duration and the size)
    let (duration, size, count): (f64, i64, i64) = conn
        .query_row("SELECT duration, size, song_count FROM playlist WHERE id = ?1", [&p.id], |row| Ok((float_of(row.get_ref(0)?), row.get(1)?, row.get(2)?)))?;
    let duration = f64::from(duration as f32);
    conn.prepare_cached(
        "UPDATE playlist SET id = ?1, name = ?2, comment = ?3, duration = ?4, size = ?5, song_count = ?6, owner_id = ?7, public = ?8, path = ?9, \
         sync = ?10, uploaded_image = ?11, external_image_url = ?12, updated_at = ?13, imported_hash = ?14, evaluated_at = ?15 WHERE id = ?1",
    )?
    .execute(params![
        p.id,
        p.name,
        p.comment,
        duration,
        size,
        count,
        p.owner_id,
        p.public,
        p.path,
        p.sync,
        p.uploaded_image,
        p.external_image_url,
        gotime::now_local(),
        p.imported_hash,
        p.evaluated_at
    ])?;
    refresh_counters(conn, &p.id)
}

/// `createPlaylist`: a new playlist named `name` with the songs given, or, with `playlistId`, that playlist's songs
/// replaced by them; answered with the playlist, as `getPlaylist` answers.
pub fn create_playlist(scope: &Scope) -> QueryResult<Reply> {
    let mut songs = Vec::new();
    for value in scope.params.all("songId") {
        let Ok(text) = std::str::from_utf8(value) else { return Ok(Reply::Navidrome("a parameter that is not text")) };
        songs.push(text.to_string());
    }
    let (playlist_id, name) = match (string(scope.params, "playlistId"), string(scope.params, "name")) {
        (Ok(id), Ok(name)) => (id, name),
        (Err(reply), _) | (_, Err(reply)) => return Ok(reply),
    };
    let id = match (playlist_id, name) {
        (None, None) => return Ok(Reply::error(GENERIC, "Internal Server Error: required parameter name is missing")),
        (Some(id), _) => {
            let playlist = match writable(scope, id)? {
                Ok(playlist) => playlist,
                Err(reply) => return Ok(reply),
            };
            // a playlist kept in sync with a file: its songs are not the user's to change
            if playlist.sync {
                return Ok(not_authorized());
            }
            // Put with the new tracks: the row written back (refreshStats: no length or size yet, the songs' number)
            put_playlist_with_tracks(scope, &playlist, &songs)?;
            playlist.id
        }
        (None, Some(name)) => {
            let Ok(id) = crate::id::new_random() else { return Ok(Reply::Navidrome("no random id could be made")) };
            let now = gotime::now_local();
            scope.conn.execute(
                "INSERT INTO playlist (id, name, comment, duration, size, song_count, owner_id, public, path, sync, uploaded_image, external_image_url, \
                 created_at, updated_at, imported_hash, evaluated_at) VALUES (?1, ?2, '', 0, 0, ?3, ?4, 0, '', 0, '', '', ?5, ?5, '', NULL)",
                params![id, name, songs.len() as i64, scope.viewer.id, now],
            )?;
            if songs.is_empty() {
                // a new playlist without songs: its cover is looked for all the same
                enqueue_cover(scope.conn, &id)?;
                refresh_counters(scope.conn, &id)?;
            } else {
                scope.conn.execute("DELETE FROM playlist_tracks WHERE playlist_id = ?1", [&id])?;
                add_tracks(scope.conn, scope.viewer, &id, 1, &songs)?;
            }
            id
        }
    };
    super::lists::playlist_answer(scope, &id)
}

/// `Put` of a playlist whose tracks were replaced (`createPlaylist` with `playlistId`).
fn put_playlist_with_tracks(scope: &Scope, playlist: &PlaylistRow, songs: &[String]) -> QueryResult<()> {
    let conn = scope.conn;
    conn.prepare_cached(
        "UPDATE playlist SET id = ?1, name = ?2, comment = ?3, duration = 0, size = 0, song_count = ?4, owner_id = ?5, public = ?6, path = ?7, \
         sync = ?8, uploaded_image = ?9, external_image_url = ?10, updated_at = ?11, imported_hash = ?12, evaluated_at = ?13 WHERE id = ?1",
    )?
    .execute(params![
        playlist.id,
        playlist.name,
        playlist.comment,
        songs.len() as i64,
        playlist.owner_id,
        playlist.public,
        playlist.path,
        playlist.sync,
        playlist.uploaded_image,
        playlist.external_image_url,
        gotime::now_local(),
        playlist.imported_hash,
        playlist.evaluated_at
    ])?;
    if songs.is_empty() {
        // no songs given: Navidrome's Put updates no tracks (the old ones stay), and counts them again
        return refresh_counters(conn, &playlist.id);
    }
    conn.execute("DELETE FROM playlist_tracks WHERE playlist_id = ?1", [&playlist.id])?;
    add_tracks(conn, scope.viewer, &playlist.id, 1, songs)
}

/// `updatePlaylist`: the tracks at `songIndexToRemove` (0-based) removed, `songIdToAdd` appended, then `name`,
/// `comment` and `public` when given.
pub fn update_playlist(scope: &Scope) -> QueryResult<Reply> {
    let id = match required(scope.params, "playlistId") {
        Ok(id) => id,
        Err(reply) => return Ok(reply),
    };
    let mut add = Vec::new();
    for value in scope.params.all("songIdToAdd") {
        let Ok(text) = std::str::from_utf8(value) else { return Ok(Reply::Navidrome("a parameter that is not text")) };
        add.push(text.to_string());
    }
    // req.Params.Ints: what is not a number is left out
    let remove: Vec<i64> = scope.params.all("songIndexToRemove").iter().filter_map(|v| std::str::from_utf8(v).ok().and_then(parse_int)).collect();
    let name = match string(scope.params, "name") {
        Ok(name) => name.map(str::to_string),
        Err(reply) => return Ok(reply),
    };
    // StringPtr and BoolPtr: given (even empty) or not
    let comment = if scope.params.names("comment") {
        match std::str::from_utf8(scope.params.get("comment")) {
            Ok(comment) => Some(comment.to_string()),
            Err(_) => return Ok(Reply::Navidrome("a parameter that is not text")),
        }
    } else {
        None
    };
    let public = scope.params.names("public").then(|| {
        let value = String::from_utf8_lossy(scope.params.get("public")).to_lowercase();
        "/true/on/1/".contains(&format!("/{value}/"))
    });
    let mut playlist = match writable(scope, id)? {
        Ok(playlist) => playlist,
        Err(reply) => return Ok(reply),
    };
    let track_changes = !add.is_empty() || !remove.is_empty();
    if track_changes && playlist.sync {
        return Ok(not_authorized());
    }
    let metadata = name.is_some() || comment.is_some() || public.is_some();
    if let Some(name) = name {
        playlist.name = name;
    }
    if let Some(comment) = comment {
        playlist.comment = comment;
    }
    if let Some(public) = public {
        playlist.public = public;
    }
    if !remove.is_empty() {
        let positions: Vec<i64> = remove.iter().map(|index| index + 1).collect();
        remove_tracks(scope.conn, id, &positions)?;
        append_tracks(scope.conn, scope.viewer, id, &add)?;
        // updateMetadata, whatever was given
        put_playlist(scope.conn, &playlist)?;
        return Ok(Reply::ok(String::new()));
    }
    append_tracks(scope.conn, scope.viewer, id, &add)?;
    if metadata {
        put_playlist(scope.conn, &playlist)?;
    }
    Ok(Reply::ok(String::new()))
}

/// `deletePlaylist`.
pub fn delete_playlist(scope: &Scope) -> QueryResult<Reply> {
    let id = match required(scope.params, "id") {
        Ok(id) => id,
        Err(reply) => return Ok(reply),
    };
    let playlist = match writable(scope, id)? {
        Ok(playlist) => playlist,
        Err(reply) => return Ok(reply),
    };
    // Navidrome removes an uploaded cover's file too: a file this server does not touch
    if !playlist.uploaded_image.is_empty() {
        return Ok(Reply::Navidrome("a playlist with an uploaded cover: Navidrome removes its file"));
    }
    // (its tracks go with it: ON DELETE CASCADE)
    let visible = playlist_filter(scope.viewer);
    let mut args: Vec<rusqlite::types::Value> = vec![id.to_string().into()];
    args.extend(visible.args);
    scope.conn.execute(&format!("DELETE FROM playlist WHERE id = ? AND {}", visible.sql), rusqlite::params_from_iter(args))?;
    Ok(Reply::ok(String::new()))
}
