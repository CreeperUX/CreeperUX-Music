//! Ported from Navidrome (GPL-3.0), © the Navidrome authors.
//!
//! More of Navidrome's queries (see `query.rs`): the searches (`persistence/sql_search*.go`, the repositories'
//! `Search`), artists (`artist_repository.go`), playlists and their songs (`playlist_repository.go`), and the play
//! queue (`playqueue_repository.go`). The same SQL text, for the same rows in the same order.

use std::collections::HashMap;
use std::time::Duration;

use rusqlite::types::Value;
use rusqlite::{Connection, Row, params_from_iter};

use crate::config::LibraryOptions;

use super::query::{
    Album, Annotations, Cond, ItemImage, ListOptions, QueryError, QueryResult, Song, Viewer, album_from, annotation_columns, annotation_join, annotations,
    boolean, float, hydrate_song_artwork, int, item_images, song_from, songs, text, time,
};
use super::search::{self, Plan};

/// An artist, as Navidrome's `model.Artist` after `dbArtist.PostScan` and the artwork hydration.
#[derive(Debug, Clone, Default)]
pub struct Artist {
    pub id: String,
    pub name: String,
    pub sort_artist_name: String,
    pub order_artist_name: String,
    pub mbz_artist_id: String,
    /// Per role, the albums the artist has in it, over the libraries the user sees; the roles sorted by name (Go
    /// keeps them in a map, in no order).
    pub album_counts: Vec<(String, i64)>,
    pub annotations: Annotations,
    pub image: ItemImage,
}

impl Artist {
    pub fn album_count(&self, role: &str) -> i64 {
        self.album_counts.iter().find(|(name, _)| name == role).map(|(_, count)| *count).unwrap_or(0)
    }
}

/// `dbArtist.PostScan`: `{"1": {"albumartist": {"m": 10, "a": 5, "s": 1024}, "total": {…}}}`, summed over libraries.
fn parse_artist_stats(data: &str) -> QueryResult<Vec<(String, i64)>> {
    let unreadable = || QueryError::Unreadable("artist statistics that are not Navidrome's JSON".into());
    if data.is_empty() {
        return Ok(Vec::new());
    }
    let json: serde_json::Value = serde_json::from_str(data).map_err(|_| unreadable())?;
    let libraries = match &json {
        serde_json::Value::Object(libraries) => libraries,
        serde_json::Value::Null => return Ok(Vec::new()),
        _ => return Err(unreadable()),
    };
    let mut counts: std::collections::BTreeMap<String, i64> = std::collections::BTreeMap::new();
    for stats in libraries.values() {
        let roles = match stats {
            serde_json::Value::Object(roles) => roles,
            serde_json::Value::Null => continue,
            _ => return Err(unreadable()),
        };
        for (role, numbers) in roles {
            let albums = match numbers {
                serde_json::Value::Object(numbers) => match numbers.get("a") {
                    None | Some(serde_json::Value::Null) => 0,
                    Some(count) => count.as_i64().ok_or_else(unreadable)?,
                },
                serde_json::Value::Null => 0,
                _ => return Err(unreadable()),
            };
            // "total" and anything else that is no role is left out of the roles (model.RoleFromString)
            if super::query::is_role(role) {
                *counts.entry(role.clone()).or_default() += albums;
            }
        }
    }
    Ok(counts.into_iter().collect())
}

fn artist_from(row: &Row) -> QueryResult<Artist> {
    Ok(Artist {
        id: text(row, "id"),
        name: text(row, "name"),
        sort_artist_name: text(row, "sort_artist_name"),
        order_artist_name: text(row, "order_artist_name"),
        mbz_artist_id: text(row, "mbz_artist_id"),
        album_counts: parse_artist_stats(&text(row, "library_stats_json"))?,
        annotations: annotations(row),
        image: ItemImage::default(),
    })
}

/// A SELECT up to its joins, with the arguments those take.
struct Head {
    sql: String,
    args: Vec<Value>,
}

fn song_head(viewer: &Viewer, options: &LibraryOptions) -> Head {
    Head {
        sql: format!(
            "SELECT media_file.*, library.path as library_path, library.name as library_name, {}, coalesce(position, 0) as bookmark_position FROM media_file \
             LEFT JOIN library on media_file.library_id = library.id {} LEFT JOIN bookmark on (bookmark.item_id = media_file.id AND bookmark.user_id = ?)",
            annotation_columns("media_file", options),
            annotation_join("media_file"),
        ),
        args: vec![Value::Text("media_file".into()), Value::Text(viewer.id.clone()), Value::Text(viewer.id.clone())],
    }
}

fn album_head(viewer: &Viewer, options: &LibraryOptions) -> Head {
    Head {
        sql: format!(
            "SELECT album.*, library.path as library_path, library.name as library_name, {} FROM album LEFT JOIN library on album.library_id = library.id {}",
            annotation_columns("album", options),
            annotation_join("album"),
        ),
        args: vec![Value::Text("album".into()), Value::Text(viewer.id.clone())],
    }
}

/// `selectArtist`: the artists with content in the libraries the user sees (`applyLibraryFilterToArtistQuery`).
fn artist_head(viewer: &Viewer, options: &LibraryOptions) -> Head {
    let mut args = Vec::new();
    let mut sql = String::from("SELECT artist.*, JSON_GROUP_OBJECT(library_artist.library_id, JSONB(library_artist.stats)) as library_stats_json, ");
    sql.push_str(&annotation_columns("artist", options));
    sql.push_str(" FROM artist JOIN library_artist on library_artist.artist_id = artist.id");
    if !viewer.is_admin {
        sql.push_str(" JOIN user_library on user_library.library_id = library_artist.library_id AND user_library.user_id = ?");
        args.push(Value::Text(viewer.id.clone()));
    }
    sql.push(' ');
    sql.push_str(&annotation_join("artist"));
    args.extend([Value::Text("artist".into()), Value::Text(viewer.id.clone())]);
    Head { sql, args }
}

fn read_artists(conn: &Connection, sql: &str, args: Vec<Value>) -> QueryResult<Vec<Artist>> {
    let mut statement = conn.prepare_cached(sql)?;
    let mut rows = statement.query(params_from_iter(args))?;
    let mut artists = Vec::new();
    while let Some(row) = rows.next()? {
        artists.push(artist_from(row)?);
    }
    let images = item_images(conn, "ar", artists.iter().map(|a| a.id.as_str()))?;
    for artist in &mut artists {
        if let Some(image) = images.get(&artist.id) {
            artist.image = image.clone();
        }
    }
    Ok(artists)
}

fn read_albums(conn: &Connection, sql: &str, args: Vec<Value>) -> QueryResult<Vec<Album>> {
    let mut statement = conn.prepare_cached(sql)?;
    let mut rows = statement.query(params_from_iter(args))?;
    let mut albums = Vec::new();
    while let Some(row) = rows.next()? {
        albums.push(album_from(row)?);
    }
    let images = item_images(conn, "al", albums.iter().map(|a| a.id.as_str()))?;
    for album in &mut albums {
        if let Some(image) = images.get(&album.id) {
            album.image = image.clone();
        }
    }
    Ok(albums)
}

fn read_songs(conn: &Connection, options: &LibraryOptions, sql: &str, args: Vec<Value>) -> QueryResult<Vec<Song>> {
    let mut statement = conn.prepare_cached(sql)?;
    let mut rows = statement.query(params_from_iter(args))?;
    let mut songs = Vec::new();
    while let Some(row) = rows.next()? {
        songs.push(song_from(row)?);
    }
    hydrate_song_artwork(conn, options, &mut songs)?;
    Ok(songs)
}

/// `artistRepository.GetAll`: artists of a list (the starred ones), grouped as Navidrome groups them.
pub fn artists(conn: &Connection, viewer: &Viewer, options: &LibraryOptions, filter: Option<&Cond>, order_by: &str) -> QueryResult<Vec<Artist>> {
    let Head { mut sql, mut args } = artist_head(viewer, options);
    if let Some(filter) = filter {
        sql.push_str(" WHERE ");
        sql.push_str(&filter.sql);
        args.extend(filter.args.iter().cloned());
    }
    sql.push_str(" GROUP BY artist.id");
    if !order_by.is_empty() {
        sql.push_str(" ORDER BY ");
        sql.push_str(order_by);
    }
    read_artists(conn, &sql, args)
}

/// One page of a search's results.
#[derive(Debug, Clone, Copy)]
pub struct Page {
    pub max: i64,
    pub offset: i64,
}

/// What differs between the three searches (`searchConfig`, and how each repository selects).
struct Search<'a> {
    table: &'a str,
    head: Head,
    /// The conditions of the full SELECT before the search's own, in Navidrome's order.
    outer: Vec<Cond>,
    /// The conditions of the rowid query (phase 1) after `missing = false`.
    inner: Vec<Cond>,
    /// `NaturalOrder`: the order of a search for nothing.
    natural_order: &'a str,
    /// The first of `OrderBy` qualified for the rowid query (`qualifyOrderBy`), and the whole of it for a LIKE search.
    rank_tie: &'a str,
    like_order: &'a str,
    group_by: Option<&'a str>,
}

/// `squirrel`'s LIMIT and OFFSET, each only when positive.
fn limits(page: Page) -> String {
    let mut sql = String::new();
    if page.max > 0 {
        sql.push_str(&format!(" LIMIT {}", page.max));
    }
    if page.offset > 0 {
        sql.push_str(&format!(" OFFSET {}", page.offset));
    }
    sql
}

/// The SQL of one search (`doSearch` and the strategies' `execute`), None when it finds nothing without asking.
fn search_sql(search: Search, plan: &Plan, page: Page) -> Option<(String, Vec<Value>)> {
    let Search { table, head, outer, inner, natural_order, rank_tie, like_order, group_by } = search;
    // an OFFSET without a LIMIT is not SQL: Navidrome's query fails there, it logs that and answers with no rows
    if page.offset > 0 && page.max <= 0 {
        return None;
    }
    let Head { mut sql, mut args } = head;
    let missing = Cond::eq(&format!("{table}.missing"), Value::Integer(0));
    let mut conditions: Vec<Cond> = outer;
    conditions.push(missing.clone());
    let mut order_by = String::new();
    let mut limit = String::new();
    match plan {
        Plan::Nothing => return None,
        Plan::Everything | Plan::FullText(_) => {
            // executeTwoPhase: the page's rowids first (no joins: SQLite pages over an index), then the rows
            let mut rowids = format!("SELECT {table}.rowid FROM {table}");
            let mut rowid_args = Vec::new();
            let order = match plan {
                Plan::FullText(expression) => {
                    rowids.push_str(&format!(" JOIN {table}_fts ON {table}_fts.rowid = {table}.rowid AND {table}_fts MATCH ?"));
                    rowid_args.push(Value::Text(search::match_argument(table, expression)));
                    format!("{}, {rank_tie}", search::rank_expression(table))
                }
                _ => natural_order.to_string(),
            };
            let inner: Vec<Cond> = std::iter::once(missing).chain(inner).collect();
            rowids.push_str(" WHERE ");
            rowids.push_str(&inner.iter().map(|c| c.sql.as_str()).collect::<Vec<_>>().join(" AND "));
            rowid_args.extend(inner.into_iter().flat_map(|c| c.args));
            rowids.push_str(&format!(" ORDER BY {order}{}", limits(page)));
            sql.push_str(&format!(" JOIN (SELECT rowid as _rid, row_number() OVER () AS _rn FROM ({rowids})) AS _ranked ON {table}.rowid = _ranked._rid"));
            args.extend(rowid_args);
            order_by.push_str("_ranked._rn");
        }
        Plan::Like(words) => {
            let per_word = words
                .iter()
                .map(|word| {
                    Cond::or(
                        search::like_columns(table)
                            .iter()
                            .map(|column| Cond::compare(&format!("{table}.{column}"), "LIKE", Value::Text(format!("%{word}%"))))
                            .collect(),
                    )
                })
                .collect();
            conditions.push(Cond::and(per_word));
            order_by.push_str(like_order);
            limit = limits(page);
        }
        Plan::MusicBrainzId(id) => {
            let columns = search::mbid_columns(table);
            conditions.push(Cond::or(columns.iter().map(|column| Cond::eq(&format!("{table}.{column}"), Value::Text(id.clone()))).collect()));
            limit = limits(page);
        }
    }
    sql.push_str(" WHERE ");
    sql.push_str(&conditions.iter().map(|c| c.sql.as_str()).collect::<Vec<_>>().join(" AND "));
    args.extend(conditions.into_iter().flat_map(|c| c.args));
    if let Some(group_by) = group_by {
        sql.push_str(&format!(" GROUP BY {group_by}"));
    }
    if !order_by.is_empty() {
        sql.push_str(&format!(" ORDER BY {order_by}"));
    }
    sql.push_str(&limit);
    Some((sql, args))
}

/// The conditions a search of songs or albums carries: the handler's library filter (`library_id IN (…)`), then the
/// repository's own for a user who does not see every library.
fn library_conditions(viewer: &Viewer, table: &str) -> (Vec<Cond>, Vec<Cond>) {
    let requested = viewer.music_folders();
    let restricted = viewer.library_filter(table);
    let outer: Vec<Cond> = requested.iter().cloned().chain(restricted.iter().cloned()).collect();
    // the rowid query: the repository's filter first, then the handler's
    let inner: Vec<Cond> = restricted.into_iter().chain(requested).collect();
    (outer, inner)
}

/// `mediaFileRepository.Search`.
pub fn search_songs(conn: &Connection, viewer: &Viewer, options: &LibraryOptions, plan: &Plan, page: Page) -> QueryResult<Vec<Song>> {
    let (outer, inner) = library_conditions(viewer, "media_file");
    let search = Search {
        table: "media_file",
        head: song_head(viewer, options),
        outer,
        inner,
        natural_order: "media_file.rowid",
        rank_tie: "media_file.title",
        like_order: "title",
        group_by: None,
    };
    match search_sql(search, plan, page) {
        Some((sql, args)) => read_songs(conn, options, &sql, args),
        None => Ok(Vec::new()),
    }
}

/// `albumRepository.Search`.
pub fn search_albums(conn: &Connection, viewer: &Viewer, options: &LibraryOptions, plan: &Plan, page: Page) -> QueryResult<Vec<Album>> {
    let (outer, inner) = library_conditions(viewer, "album");
    let search = Search {
        table: "album",
        head: album_head(viewer, options),
        outer,
        inner,
        natural_order: "album.rowid",
        rank_tie: "album.name",
        like_order: "name",
        group_by: None,
    };
    match search_sql(search, plan, page) {
        Some((sql, args)) => read_albums(conn, &sql, args),
        None => Ok(Vec::new()),
    }
}

/// `artistRepository.Search`. Artists have no library of their own: the full SELECT joins the libraries the user
/// sees, and the rowid query is narrowed (`searchScope`) only when the handler's libraries are fewer than those.
pub fn search_artists(conn: &Connection, viewer: &Viewer, options: &LibraryOptions, plan: &Plan, page: Page) -> QueryResult<Vec<Artist>> {
    let search = Search {
        table: "artist",
        head: artist_head(viewer, options),
        outer: Vec::new(),
        inner: artist_scope(viewer).into_iter().collect(),
        natural_order: "artist.id",
        rank_tie: "artist.name",
        like_order: "sum(json_extract(stats, '$.total.m')) desc, name",
        group_by: Some("artist.id"),
    };
    match search_sql(search, plan, page) {
        Some((sql, args)) => read_artists(conn, &sql, args),
        None => Ok(Vec::new()),
    }
}

/// `searchScope` and `artistLibraryFilter`, for a handler that asks for the user's own libraries: no narrowing when
/// those are all the user can see (always, but for a user without any library, who sees no artist).
fn artist_scope(viewer: &Viewer) -> Option<Cond> {
    // the libraries the search is to stay in: the handler's (the user's own), else, when the user does not see all,
    // the ones they see
    let sees_all = viewer.is_admin || (viewer.all_libraries > 0 && viewer.libraries.len() as i64 == viewer.all_libraries);
    if !viewer.libraries.is_empty() || sees_all {
        // an admin granted only some libraries would be narrowed to them here; with one library that cannot be
        return None;
    }
    Some(Cond::eq("1", Value::Integer(2)))
}

/// A playlist, as Navidrome's `model.Playlist` with its owner's name and its artwork state.
#[derive(Debug, Clone, Default)]
pub struct Playlist {
    pub id: String,
    pub name: String,
    pub comment: String,
    pub duration: f64,
    pub song_count: i64,
    pub public: bool,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub sync: bool,
    pub owner_id: String,
    pub owner_name: String,
    /// The smart playlist's rules as stored, empty for a plain playlist.
    pub rules: String,
    /// When a smart playlist was last filled, as stored.
    pub evaluated_at: String,
    pub image: ItemImage,
}

/// What kind of playlist the stored rules make it (`Criteria.UnmarshalJSON`, `Playlist.IsSmartPlaylist`).
#[derive(Debug, Clone, PartialEq)]
pub enum Rules {
    /// No rules: a list of songs someone put together.
    Plain,
    /// A smart playlist that is refreshed after Navidrome's `SmartPlaylistRefreshDelay`.
    Smart,
    /// A smart playlist with a refresh delay of its own, or rules this server does not read as Navidrome does.
    Navidromes,
}

impl Playlist {
    pub fn rules(&self) -> Rules {
        if self.rules.is_empty() {
            return Rules::Plain;
        }
        let Ok(serde_json::Value::Object(rules)) = serde_json::from_str::<serde_json::Value>(&self.rules) else { return Rules::Navidromes };
        let filled = |key: &str| rules.get(key).and_then(|list| list.as_array()).is_some_and(|list| !list.is_empty());
        // both keys, or neither with rules in it: Navidrome's decoder fails, and so does its answer
        if rules.contains_key("all") && rules.contains_key("any") || !(filled("all") || filled("any")) {
            return Rules::Navidromes;
        }
        match rules.get("refreshDelay") {
            None => Rules::Smart,
            Some(serde_json::Value::String(delay)) if delay.is_empty() => Rules::Smart,
            Some(_) => Rules::Navidromes,
        }
    }

    /// `ValidUntil`: when a smart playlist's songs are due to be looked up again.
    pub fn valid_until(&self, delay: Duration) -> Option<String> {
        crate::gotime::stored_plus_to_json(&self.evaluated_at, delay).filter(|_| time_is_set(&self.evaluated_at))
    }
}

/// Whether a stored time is one Go reads as set (not NULL, not unreadable, not the zero time).
fn time_is_set(stored: &str) -> bool {
    crate::gotime::stored_to_json(stored).is_some()
}

fn playlist_from(row: &Row) -> Playlist {
    Playlist {
        id: text(row, "id"),
        name: text(row, "name"),
        comment: text(row, "comment"),
        duration: float(row, "duration"),
        song_count: int(row, "song_count"),
        public: boolean(row, "public"),
        created_at: time(row, "created_at"),
        updated_at: time(row, "updated_at"),
        sync: boolean(row, "sync"),
        owner_id: text(row, "owner_id"),
        owner_name: text(row, "owner_name"),
        rules: text(row, "rules"),
        evaluated_at: text(row, "evaluated_at"),
        image: ItemImage::default(),
    }
}

/// `playlistRepository.userFilter`: an admin sees every playlist, anyone else the public ones and their own.
pub(super) fn playlist_filter(viewer: &Viewer) -> Cond {
    if viewer.is_admin {
        return Cond::new("(1=1)", Vec::new()); // squirrel's empty And
    }
    Cond::or(vec![Cond::eq("public", Value::Integer(1)), Cond::eq("owner_id", Value::Text(viewer.id.clone()))])
}

/// `playlistRepository.GetAll` (with an ORDER BY) and `Get` (with an id): the playlists the user may see.
pub fn playlists(conn: &Connection, viewer: &Viewer, options: &LibraryOptions, id: Option<&str>, order_by: Option<&str>) -> QueryResult<Vec<Playlist>> {
    let mut args = vec![Value::Text("playlist".into()), Value::Text(viewer.id.clone())];
    let mut sql = format!(
        "SELECT playlist.*, user.user_name as owner_name, {} FROM playlist JOIN user on user.id = owner_id {}",
        annotation_columns("playlist", options),
        annotation_join("playlist")
    );
    let filter = match id {
        Some(id) => Cond::and(vec![Cond::eq("playlist.id", Value::Text(id.to_string())), playlist_filter(viewer)]),
        None => playlist_filter(viewer),
    };
    sql.push_str(" WHERE ");
    sql.push_str(&filter.sql);
    args.extend(filter.args);
    if let Some(order_by) = order_by {
        sql.push_str(" ORDER BY ");
        sql.push_str(order_by);
    }
    let mut statement = conn.prepare_cached(&sql)?;
    let mut rows = statement.query(params_from_iter(args))?;
    let mut playlists = Vec::new();
    while let Some(row) = rows.next()? {
        playlists.push(playlist_from(row));
    }
    let images = item_images(conn, "pl", playlists.iter().map(|p| p.id.as_str()))?;
    for playlist in &mut playlists {
        if let Some(image) = images.get(&playlist.id) {
            playlist.image = image.clone();
        }
    }
    Ok(playlists)
}

/// `playlistRepository.loadTracks` as `GetWithTracks` asks: a playlist's songs that are not missing, in its order,
/// with the user's annotations (no bookmarks: Navidrome's query has none here).
pub fn playlist_songs(conn: &Connection, viewer: &Viewer, options: &LibraryOptions, playlist_id: &str) -> QueryResult<Vec<Song>> {
    let mut args = vec![Value::Text(viewer.id.clone()), Value::Integer(0)];
    // Navidrome writes the user's id into the join as a literal; here it is an argument
    let mut sql = String::from(
        "SELECT coalesce(starred, 0) as starred, starred_at, coalesce(play_count, 0) as play_count, play_date, coalesce(rating, 0) as rating, rated_at, f.*, \
         playlist_tracks.*, library.path as library_path, library.name as library_name FROM playlist_tracks \
         LEFT JOIN annotation on (annotation.item_id = media_file_id AND annotation.item_type = 'media_file' AND annotation.user_id = ?) \
         JOIN media_file f on f.id = media_file_id JOIN library on f.library_id = library.id WHERE missing = ?",
    );
    if let Some(restricted) = viewer.library_filter("f") {
        sql.push_str(" AND ");
        sql.push_str(&restricted.sql);
        args.extend(restricted.args);
    }
    sql.push_str(" AND playlist_id = ? ORDER BY playlist_tracks.id");
    args.push(Value::Text(playlist_id.to_string()));
    let mut statement = conn.prepare_cached(&sql)?;
    let mut rows = statement.query(params_from_iter(args))?;
    let mut songs = Vec::new();
    while let Some(row) = rows.next()? {
        // `id` is there twice, the song's first: that is the one read here, as the entry's id is the song's
        let mut song = song_from(row)?;
        song.id = text(row, "media_file_id");
        songs.push(song);
    }
    hydrate_song_artwork(conn, options, &mut songs)?;
    Ok(songs)
}

/// A user's saved play queue (`playQueueRepository.RetrieveWithMediaFiles`).
#[derive(Debug, Clone, Default)]
pub struct PlayQueue {
    pub songs: Vec<Song>,
    /// The index of the current song among `songs`.
    pub current: i64,
    pub position: i64,
    pub changed_by: String,
    pub updated_at: Option<String>,
}

/// The play queue with its songs in the queue's order; songs that are gone (or not the user's to see) are left out.
/// None: the user saved none.
pub fn play_queue(conn: &Connection, viewer: &Viewer, options: &LibraryOptions) -> QueryResult<Option<PlayQueue>> {
    let mut statement = conn.prepare_cached("SELECT * FROM playqueue WHERE user_id = ?")?;
    let mut rows = statement.query([&viewer.id])?;
    let Some(row) = rows.next()? else { return Ok(None) };
    let items = text(row, "items");
    let mut queue = PlayQueue {
        songs: Vec::new(),
        current: int(row, "current"),
        position: int(row, "position"),
        changed_by: text(row, "changed_by"),
        updated_at: time(row, "updated_at"),
    };
    drop(rows);
    drop(statement);
    if items.trim().is_empty() {
        return Ok(Some(queue));
    }
    let ids: Vec<&str> = items.split(',').collect();
    let mut by_id: HashMap<String, Song> = HashMap::new();
    // Navidrome asks in batches of 500 too, under SQLite's limit on arguments
    for chunk in ids.chunks(500) {
        let these = Cond::is_in("media_file.id", chunk.iter().map(|id| Value::Text(id.to_string())).collect());
        let list = ListOptions { filter: Some(these), ..ListOptions::default() };
        for song in songs(conn, viewer, options, &list)? {
            by_id.insert(song.id.clone(), song);
        }
    }
    queue.songs = ids.iter().filter_map(|id| by_id.get(*id).cloned()).collect();
    Ok(Some(queue))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn viewer(is_admin: bool, libraries: Vec<i64>) -> Viewer {
        Viewer { id: "u1".into(), name: "listener".into(), is_admin, libraries, all_libraries: 1 }
    }

    fn sql_of(table: &str, v: &Viewer, plan: &Plan, page: Page) -> Option<(String, usize)> {
        let options = LibraryOptions::default();
        let (outer, inner) = library_conditions(v, table);
        let search = match table {
            "media_file" => Search {
                table,
                head: Head { sql: "SELECT <MF>".into(), args: Vec::new() },
                outer,
                inner,
                natural_order: "media_file.rowid",
                rank_tie: "media_file.title",
                like_order: "title",
                group_by: None,
            },
            "album" => Search {
                table,
                head: Head { sql: "SELECT <AL>".into(), args: Vec::new() },
                outer,
                inner,
                natural_order: "album.rowid",
                rank_tie: "album.name",
                like_order: "name",
                group_by: None,
            },
            _ => Search {
                table,
                head: artist_head(v, &options),
                outer: Vec::new(),
                inner: artist_scope(v).into_iter().collect(),
                natural_order: "artist.id",
                rank_tie: "artist.name",
                like_order: "sum(json_extract(stats, '$.total.m')) desc, name",
                group_by: Some("artist.id"),
            },
        };
        search_sql(search, plan, page).map(|(sql, args)| (sql, args.len()))
    }

    // The expected statements are the ones Navidrome 0.64.2-sonus.10 logs at trace level for the same searches
    // (its `{:pN}` placeholders written as `?`).

    #[test]
    fn a_search_for_nothing_pages_the_table_in_its_own_order() {
        let listener = viewer(false, vec![1]);
        let (sql, args) = sql_of("media_file", &listener, &Plan::Everything, Page { max: 4, offset: 8 }).unwrap();
        assert_eq!(
            sql,
            "SELECT <MF> JOIN (SELECT rowid as _rid, row_number() OVER () AS _rn FROM (SELECT media_file.rowid FROM media_file WHERE media_file.missing = ? AND \
             library_id IN (?) ORDER BY media_file.rowid LIMIT 4 OFFSET 8)) AS _ranked ON media_file.rowid = _ranked._rid WHERE library_id IN (?) AND \
             media_file.missing = ? ORDER BY _ranked._rn"
        );
        assert_eq!(args, 4);
        // an offset without a limit is not SQL: no rows, as Navidrome answers when its query fails
        assert!(sql_of("media_file", &listener, &Plan::Everything, Page { max: -1, offset: 8 }).is_none());
        assert!(sql_of("media_file", &listener, &Plan::Everything, Page { max: -1, offset: 0 }).unwrap().0.contains("ORDER BY media_file.rowid)) AS _ranked"));
    }

    #[test]
    fn a_search_for_words_is_ranked_by_fts5() {
        let listener = viewer(false, vec![1]);
        let plan = Plan::FullText("(light OR light*)".into());
        assert_eq!(
            sql_of("media_file", &listener, &plan, Page { max: 200, offset: 0 }).unwrap().0,
            "SELECT <MF> JOIN (SELECT rowid as _rid, row_number() OVER () AS _rn FROM (SELECT media_file.rowid FROM media_file JOIN media_file_fts ON \
             media_file_fts.rowid = media_file.rowid AND media_file_fts MATCH ? WHERE media_file.missing = ? AND library_id IN (?) ORDER BY \
             bm25(media_file_fts, 10.0, 5.0, 3.0, 3.0, 1.0, 1.0, 1.0, 1.0, 1.0, 2.0, 1.0), media_file.title LIMIT 200)) AS _ranked ON media_file.rowid = _ranked._rid \
             WHERE library_id IN (?) AND media_file.missing = ? ORDER BY _ranked._rn"
        );
        assert_eq!(
            sql_of("album", &listener, &plan, Page { max: 60, offset: 0 }).unwrap().0,
            "SELECT <AL> JOIN (SELECT rowid as _rid, row_number() OVER () AS _rn FROM (SELECT album.rowid FROM album JOIN album_fts ON album_fts.rowid = album.rowid AND \
             album_fts MATCH ? WHERE album.missing = ? AND library_id IN (?) ORDER BY bm25(album_fts, 10.0, 1.0, 3.0, 2.0, 1.0, 1.0, 1.0, 1.0), album.name LIMIT 60)) \
             AS _ranked ON album.rowid = _ranked._rid WHERE library_id IN (?) AND album.missing = ? ORDER BY _ranked._rn"
        );
        assert_eq!(
            sql_of("artist", &listener, &plan, Page { max: 30, offset: 0 }).unwrap().0,
            "SELECT artist.*, JSON_GROUP_OBJECT(library_artist.library_id, JSONB(library_artist.stats)) as library_stats_json, coalesce(starred, 0) as starred, \
             coalesce(rating, 0) as rating, starred_at, play_date, rated_at, coalesce(play_count, 0) as play_count, artist.average_rating FROM artist JOIN library_artist \
             on library_artist.artist_id = artist.id JOIN user_library on user_library.library_id = library_artist.library_id AND user_library.user_id = ? LEFT JOIN \
             annotation on (annotation.item_id = artist.id AND annotation.item_type = ? AND annotation.user_id = ?) JOIN (SELECT rowid as _rid, row_number() OVER () AS \
             _rn FROM (SELECT artist.rowid FROM artist JOIN artist_fts ON artist_fts.rowid = artist.rowid AND artist_fts MATCH ? WHERE artist.missing = ? ORDER BY \
             bm25(artist_fts, 10.0, 1.0, 10.0), artist.name LIMIT 30)) AS _ranked ON artist.rowid = _ranked._rid WHERE artist.missing = ? GROUP BY artist.id ORDER BY \
             _ranked._rn"
        );
    }

    #[test]
    fn chinese_japanese_and_korean_words_are_matched_with_like() {
        let listener = viewer(false, vec![1]);
        let plan = Plan::Like(vec!["夜行".into()]);
        assert_eq!(
            sql_of("media_file", &listener, &plan, Page { max: 200, offset: 0 }).unwrap().0,
            "SELECT <MF> WHERE library_id IN (?) AND media_file.missing = ? AND ((media_file.title LIKE ? OR media_file.album LIKE ? OR media_file.artist LIKE ? OR \
             media_file.album_artist LIKE ?)) ORDER BY title LIMIT 200"
        );
        assert_eq!(
            sql_of("album", &listener, &plan, Page { max: 60, offset: 5 }).unwrap().0,
            "SELECT <AL> WHERE library_id IN (?) AND album.missing = ? AND ((album.name LIKE ? OR album.album_artist LIKE ?)) ORDER BY name LIMIT 60 OFFSET 5"
        );
        let artists = sql_of("artist", &listener, &plan, Page { max: 30, offset: 0 }).unwrap().0;
        assert!(
            artists.ends_with(
                "WHERE artist.missing = ? AND ((artist.name LIKE ?)) GROUP BY artist.id ORDER BY sum(json_extract(stats, '$.total.m')) desc, name LIMIT 30"
            ),
            "{artists}"
        );
        let two = Plan::Like(vec!["雨".into(), "夜".into()]);
        assert!(
            sql_of("album", &listener, &two, Page { max: 1, offset: 0 })
                .unwrap()
                .0
                .contains("((album.name LIKE ? OR album.album_artist LIKE ?) AND (album.name LIKE ? OR album.album_artist LIKE ?))")
        );
    }

    #[test]
    fn a_musicbrainz_id_and_what_a_user_may_see() {
        let listener = viewer(false, vec![1]);
        let id = Plan::MusicBrainzId("0f3d6a8e-5c1b-4d2a-9e7f-1a2b3c4d5f01".into());
        assert_eq!(
            sql_of("media_file", &listener, &id, Page { max: 20, offset: 0 }).unwrap().0,
            "SELECT <MF> WHERE library_id IN (?) AND media_file.missing = ? AND (media_file.mbz_recording_id = ? OR media_file.mbz_release_track_id = ?) LIMIT 20"
        );
        assert!(
            sql_of("artist", &listener, &id, Page { max: 20, offset: 0 })
                .unwrap()
                .0
                .ends_with("WHERE artist.missing = ? AND (artist.mbz_artist_id = ?) GROUP BY artist.id LIMIT 20")
        );
        assert!(sql_of("album", &listener, &Plan::Nothing, Page { max: 20, offset: 0 }).is_none());
        // a user without the library: Navidrome's subquery over user_library, in both queries; and no artist
        let outsider = viewer(false, Vec::new());
        assert_eq!(
            sql_of("album", &outsider, &Plan::Everything, Page { max: 5, offset: 0 }).unwrap().0,
            "SELECT <AL> JOIN (SELECT rowid as _rid, row_number() OVER () AS _rn FROM (SELECT album.rowid FROM album WHERE album.missing = ? AND album.library_id IN \
             (SELECT ul.library_id FROM user_library ul WHERE ul.user_id = ?) ORDER BY album.rowid LIMIT 5)) AS _ranked ON album.rowid = _ranked._rid WHERE \
             album.library_id IN (SELECT ul.library_id FROM user_library ul WHERE ul.user_id = ?) AND album.missing = ? ORDER BY _ranked._rn"
        );
        assert!(
            sql_of("artist", &outsider, &Plan::Everything, Page { max: 5, offset: 0 })
                .unwrap()
                .0
                .contains("WHERE artist.missing = ? AND 1 = ? ORDER BY artist.id LIMIT 5")
        );
        // an admin: every library, without the join of the user's libraries
        let admin = viewer(true, Vec::new());
        let artists = sql_of("artist", &admin, &Plan::Everything, Page { max: 5, offset: 0 }).unwrap().0;
        assert!(!artists.contains("user_library") && artists.contains("WHERE artist.missing = ? ORDER BY artist.id LIMIT 5"), "{artists}");
    }

    #[test]
    fn stored_rules_and_statistics() {
        let with = |rules: &str| Playlist { rules: rules.into(), evaluated_at: "2026-11-24 23:42:33.9197185+01:00".into(), ..Playlist::default() };
        assert_eq!(with("").rules(), Rules::Plain);
        assert_eq!(with(r#"{"all":[{"is":{"suffix":"flac"}}],"sort":"title"}"#).rules(), Rules::Smart);
        assert_eq!(with(r#"{"any":[{"gt":{"rating":3}}]}"#).rules(), Rules::Smart);
        assert_eq!(with(r#"{"all":[{"is":{"suffix":"flac"}}],"refreshDelay":"1h"}"#).rules(), Rules::Navidromes);
        assert_eq!(with(r#"{"all":[],"sort":"title"}"#).rules(), Rules::Navidromes, "no rules: Navidrome's decoder fails");
        assert_eq!(with(r#"{"all":[{"a":1}],"any":[]}"#).rules(), Rules::Navidromes);
        assert_eq!(with("not json").rules(), Rules::Navidromes);
        let smart = with(r#"{"all":[{"is":{"suffix":"flac"}}]}"#);
        assert_eq!(smart.valid_until(Duration::from_secs(5)).as_deref(), Some("2026-11-24T23:42:38.9197185+01:00"));
        assert_eq!(Playlist::default().valid_until(Duration::from_secs(5)), None, "never filled: no validUntil");

        let stats = r#"{"1":{"albumartist":{"a":2,"m":7,"s":100},"artist":{"a":3,"m":9,"s":120},"maincredit":{"a":3,"m":9,"s":120},"total":{"a":3,"m":9,"s":120}},
                        "2":{"artist":{"a":1,"m":1,"s":1},"composer":{"m":4}}}"#;
        let counts = parse_artist_stats(stats).unwrap();
        assert_eq!(counts, [("albumartist".to_string(), 2), ("artist".to_string(), 4), ("composer".to_string(), 0), ("maincredit".to_string(), 3)]);
        assert!(parse_artist_stats("").unwrap().is_empty());
        assert!(parse_artist_stats("[]").is_err());
    }
}
