//! The writes Sonus clients make that are answered here (phase 4 of docs/server-roadmap.md), written to Navidrome's
//! tables exactly as Navidrome writes them, so that either server reads them back the same.
//!
//! Ported from Navidrome (GPL-3.0), © the Navidrome authors: `server/subsonic/media_annotation.go` (`star`,
//! `unstar`, `setRating`), `server/subsonic/bookmarks.go` (`savePlayQueue`), `persistence/sql_annotations.go`
//! (`annUpsert`, `SetStar`, `SetRating`, `updateAvgRating`), `persistence/playqueue_repository.go` (`Store`),
//! `model/get_entity.go` (`GetEntityByID`).
//!
//! Every method runs in one `BEGIN IMMEDIATE` transaction (Navidrome runs `star` and `unstar` in one; `setRating` and
//! `savePlayQueue` are two or three statements there, each its own: the end state is the same). Navidrome's web UI
//! hears of a star or a rating through its event broker (`refreshResource`); writes made here send nothing there
//! (decision 2 of the roadmap: the old web UI does not refresh by itself).

use rusqlite::{Connection, OptionalExtension, params};

use super::browse::{int_or, required, required_int, string};
use super::catalog::playlist_filter;
use super::query::{QueryResult, Viewer};
use super::{NOT_FOUND, Reply, Scope};
use crate::gotime;
use crate::subsonic::respond::MISSING_PARAMETER;

/// The methods answered here that write.
pub const METHODS: [&str; 4] = ["star", "unstar", "setRating", "savePlayQueue"];

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
