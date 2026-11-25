//! Ported from Navidrome (GPL-3.0), © the Navidrome authors.
//!
//! The methods: Navidrome's handlers (`server/subsonic/browsing.go`, `album_lists.go`) with its list filters
//! (`server/filter/filters.go`) and its way of reading parameters (`utils/req`): the same lists, the same errors in
//! the same words.

use hyper::header::{HeaderName, HeaderValue};
use rusqlite::types::Value;

use crate::subsonic::params::Params;
use crate::subsonic::respond::{GENERIC, MISSING_PARAMETER};

use super::json::Json;
use super::query::{self, Cond, ListOptions, QueryError, Table, not_missing};
use super::{NOT_FOUND, Reply, Scope, entities, lists, media, seeded_order, writes};

/// The answer of one of `super::METHODS`.
pub fn answer(method: &str, scope: &Scope) -> Result<Reply, QueryError> {
    match method {
        "ping" => Ok(Reply::ok(String::new())),
        "getSong" => get_song(scope),
        "getAlbum" => get_album(scope),
        "getAlbumList2" => get_album_list2(scope),
        "search3" => lists::search3(scope),
        "getStarred2" => lists::get_starred2(scope),
        "getPlaylists" => lists::get_playlists(scope),
        "getPlaylist" => lists::get_playlist(scope),
        "getPlayQueue" => lists::get_play_queue(scope),
        "getLyricsBySongId" => media::get_lyrics_by_song_id(scope),
        "getCoverArt" => media::get_cover_art(scope),
        "star" => writes::star(scope, true),
        "unstar" => writes::star(scope, false),
        "setRating" => writes::set_rating(scope),
        "savePlayQueue" => writes::save_play_queue(scope),
        _ => Ok(Reply::Navidrome("not a method answered here")),
    }
}

/// A parameter Navidrome reads as a string (`req.Params.String`): its first value, None when empty or missing.
/// Err: bytes that are not text, which Go passes on as they are; such a request is Navidrome's.
pub(super) fn string<'a>(params: &'a Params, name: &str) -> Result<Option<&'a str>, Reply> {
    let value = params.get(name);
    if value.is_empty() {
        return Ok(None);
    }
    std::str::from_utf8(value).map(Some).map_err(|_| Reply::Navidrome("a parameter that is not text"))
}

/// `req.Params.String` where the parameter is needed: error 10 in Navidrome's words without it.
pub(super) fn required<'a>(params: &'a Params, name: &str) -> Result<&'a str, Reply> {
    string(params, name)?.ok_or_else(|| Reply::error(MISSING_PARAMETER, format!("missing parameter: '{name}'")))
}

/// Go's `strconv.ParseInt(text, 10, 64)`: an optional sign, then digits.
fn parse_int(text: &str) -> Option<i64> {
    let digits = text.strip_prefix(['+', '-']).unwrap_or(text);
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    text.parse().ok()
}

/// `req.Params.Int`: error 10 when missing, error 0 when it is not a number.
pub(super) fn required_int(params: &Params, name: &str) -> Result<i64, Reply> {
    let text = required(params, name)?;
    parse_int(text).ok_or_else(|| Reply::error(GENERIC, format!("invalid parameter '{name}': expected integer, got '{text}'")))
}

/// `req.Params.IntOr`: the default when missing or not a number.
pub(super) fn int_or(params: &Params, name: &str, default: i64) -> i64 {
    std::str::from_utf8(params.get(name)).ok().and_then(parse_int).unwrap_or(default)
}

/// `getSong`.
fn get_song(scope: &Scope) -> Result<Reply, QueryError> {
    // without an id Navidrome looks for the song with the empty id: not found
    let id = match string(scope.params, "id") {
        Ok(id) => id.unwrap_or(""),
        Err(reply) => return Ok(reply),
    };
    let list = ListOptions { filter: Some(Cond::eq("media_file.id", Value::Text(id.to_string()))), ..ListOptions::default() };
    let songs = query::songs(scope.conn, scope.viewer, scope.options, &list)?;
    let Some(song) = songs.first() else { return Ok(Reply::error(NOT_FOUND, "Song not found")) };
    if !entities::songs_are_answerable(&songs[..1]) {
        return Ok(Reply::Navidrome("a song whose content type Go takes from the system"));
    }
    let mut j = Json::new();
    j.key("song");
    entities::song(&mut j, song, &scope.context);
    Ok(Reply::ok(j.finish()))
}

/// `filter.SongsByAlbum`: an album's songs in album order.
fn songs_by_album(scope: &Scope, album_id: &str) -> Result<Vec<query::Song>, QueryError> {
    let list = ListOptions {
        filter: Some(Cond::eq("album_id", Value::Text(album_id.to_string())).not_missing()),
        order_by: Some(query::build_sort_order(Table::MediaFile, "album", "", scope.options)),
        ..ListOptions::default()
    };
    query::songs(scope.conn, scope.viewer, scope.options, &list)
}

/// `getAlbum`.
fn get_album(scope: &Scope) -> Result<Reply, QueryError> {
    let id = match string(scope.params, "id") {
        Ok(id) => id.unwrap_or(""),
        Err(reply) => return Ok(reply),
    };
    let list = ListOptions { filter: Some(Cond::eq("album.id", Value::Text(id.to_string()))), ..ListOptions::default() };
    let albums = query::albums(scope.conn, scope.viewer, scope.options, &list)?;
    let Some(album) = albums.first() else { return Ok(Reply::error(NOT_FOUND, "Album not found")) };
    let songs = songs_by_album(scope, id)?;
    if !entities::songs_are_answerable(&songs) {
        return Ok(Reply::Navidrome("a song whose content type Go takes from the system"));
    }
    let mut j = Json::new();
    j.key("album");
    j.begin_object();
    entities::album_members(&mut j, album, &scope.context);
    j.array_ne("song", &songs, |j, song| entities::song(j, song, &scope.context));
    j.end_object();
    Ok(Reply::ok(j.finish()))
}

/// A list of albums: its filter (before the user's libraries are added), whether that names the user's
/// annotations, and its order.
struct AlbumList {
    filter: Cond,
    annotated: bool,
    /// The sort key and direction for `build_sort_order`; None: the random order, made here.
    sort: Option<(&'static str, &'static str)>,
}

/// `getAlbumList`'s choice of list by `type` (`server/filter/filters.go`).
fn album_list(params: &Params) -> Result<AlbumList, Reply> {
    let plain = |sort, order| AlbumList { filter: not_missing(), annotated: false, sort: Some((sort, order)) };
    let annotated = |filter: Cond, sort, order| AlbumList { filter: filter.not_missing(), annotated: true, sort: Some((sort, order)) };
    Ok(match required(params, "type")? {
        // filter.AlbumsByNewest adds the default filter twice, and so it is twice in the query
        "newest" => AlbumList { filter: not_missing().not_missing(), annotated: false, sort: Some(("recently_added", "desc")) },
        // Go binds the zero time as go-sqlite3 writes it; play dates are compared as text
        "recent" => annotated(Cond::compare("play_date", ">", Value::Text("0001-01-01 00:00:00+00:00".into())), "playDate", "desc"),
        "random" => AlbumList { filter: not_missing(), annotated: false, sort: None },
        "alphabeticalByName" => plain("name", ""),
        "alphabeticalByArtist" => plain("artist", ""),
        "frequent" => annotated(Cond::compare("play_count", ">", Value::Integer(0)), "playCount", "desc"),
        "starred" => annotated(Cond::eq("starred", Value::Integer(1)), "starred_at", "desc"),
        "highest" => annotated(Cond::compare("rating", ">", Value::Integer(0)), "rating", "desc"),
        "byGenre" => {
            let genre = required(params, "genre")?;
            // persistence.AlbumGenres.ByName: by the genre's name, with LIKE (so without regard to ASCII case)
            let by_genre = Cond::new(
                "album.id IN (SELECT jt.album_id FROM album_tags jt JOIN tag on tag.id = jt.tag_id WHERE (tag.tag_name = ? AND tag.tag_value LIKE ?))",
                vec![Value::Text("genre".into()), Value::Text(genre.to_string())],
            );
            AlbumList { filter: by_genre.not_missing(), annotated: false, sort: Some(("name", "")) }
        }
        "byYear" => {
            let (mut from, mut to) = (required_int(params, "fromYear")?, required_int(params, "toYear")?);
            let mut order = "";
            if from > to {
                (from, to) = (to, from);
                order = "desc";
            }
            let within = |column: &str| Cond::and(vec![Cond::compare(column, ">=", Value::Integer(from)), Cond::compare(column, "<=", Value::Integer(to))]);
            AlbumList { filter: Cond::or(vec![within("min_year"), within("max_year")]).not_missing(), annotated: false, sort: Some(("max_year", order)) }
        }
        other => return Err(Reply::error(GENERIC, format!("type '{other}' not implemented"))),
    })
}

/// `getAlbumList2`.
fn get_album_list2(scope: &Scope) -> Result<Reply, QueryError> {
    let params = scope.params;
    let list = match album_list(params) {
        Ok(list) => list,
        Err(reply) => return Ok(reply),
    };
    if params.names("musicFolderId") {
        return Ok(Reply::Navidrome("musicFolderId, which Sonus clients do not send"));
    }
    // filter.ApplyLibraryFilter with the user's libraries
    let filter = match scope.viewer.music_folders() {
        Some(libraries) => Cond::and(vec![list.filter, libraries]),
        None => list.filter,
    };
    let offset = int_or(params, "offset", 0);
    let max = int_or(params, "size", 10).min(500);
    if offset > 0 && max <= 0 {
        return Ok(Reply::Navidrome("an offset without a size, which Navidrome's query cannot have"));
    }
    let albums = match list.sort {
        Some((sort, order)) => {
            let order_by = Some(query::build_sort_order(Table::Album, sort, order, scope.options));
            query::albums(scope.conn, scope.viewer, scope.options, &ListOptions { filter: Some(filter.clone()), order_by, max, offset })?
        }
        None => random_albums(scope, &filter, max, offset)?,
    };
    let count = query::count_albums(scope.conn, scope.viewer, Some(&filter), list.annotated)?;
    let mut j = Json::new();
    j.key("albumList2");
    j.begin_object();
    j.array_ne("album", &albums, |j, album| entities::album(j, album, &scope.context));
    j.end_object();
    let total = (HeaderName::from_static("x-total-count"), HeaderValue::from(count));
    Ok(Reply::Ok { members: j.finish(), headers: vec![total] })
}

/// The random list (`filter.AlbumsByRandom`): Navidrome orders by a number made from a seed and the album's id,
/// and makes a new seed whenever the list is asked for from its start, so the pages of one pass fit together. The
/// same here, with this server's own seed.
fn random_albums(scope: &Scope, filter: &Cond, max: i64, offset: i64) -> Result<Vec<query::Album>, QueryError> {
    let seed = scope.random_seed("album", offset <= 0);
    let mut ids = query::album_ids(scope.conn, scope.viewer, Some(filter))?;
    ids.sort_by_cached_key(|id| (seeded_order(seed, id), id.clone()));
    let from = (offset.max(0) as usize).min(ids.len());
    let to = if max > 0 { (from + max as usize).min(ids.len()) } else { ids.len() };
    let page = &ids[from..to];
    let mut albums = Vec::with_capacity(page.len());
    // in batches, under SQLite's limit on arguments
    for chunk in page.chunks(500) {
        let these = Cond::is_in("album.id", chunk.iter().map(|id| Value::Text(id.clone())).collect());
        let list = ListOptions { filter: Some(Cond::and(vec![filter.clone(), these])), ..ListOptions::default() };
        albums.extend(query::albums(scope.conn, scope.viewer, scope.options, &list)?);
    }
    albums.sort_by_cached_key(|album| page.iter().position(|id| *id == album.id).unwrap_or(usize::MAX));
    Ok(albums)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params(query: &str) -> Params {
        Params::parse(query.as_bytes(), None).unwrap()
    }

    fn error(reply: Result<AlbumList, Reply>) -> (i32, String) {
        match reply {
            Err(Reply::Error { code, message }) => (code, message),
            _ => panic!("not an error"),
        }
    }

    #[test]
    fn parameters_are_read_as_navidrome_reads_them() {
        let p = params("size=20&offset=x&id=&n=%2B7&m=-3&big=99999999999999999999&u=%ff");
        assert_eq!(int_or(&p, "size", 10), 20);
        assert_eq!(int_or(&p, "offset", 0), 0, "not a number: the default");
        assert_eq!(int_or(&p, "missing", 10), 10);
        assert_eq!(int_or(&p, "n", 0), 7);
        assert_eq!(int_or(&p, "m", 0), -3);
        assert_eq!(int_or(&p, "big", 5), 5, "out of range: the default");
        assert_eq!(string(&p, "id").ok().unwrap(), None, "an empty value counts as missing");
        assert!(matches!(string(&p, "u"), Err(Reply::Navidrome(_))));
        assert_eq!(parse_int("12"), Some(12));
        assert_eq!(parse_int(" 12"), None);
        assert_eq!(parse_int("1_000"), None);
        assert_eq!(parse_int("+"), None);
        assert_eq!(parse_int("0x10"), None);
    }

    #[test]
    fn album_lists_fail_in_navidromes_words() {
        assert_eq!(error(album_list(&params("size=5"))), (10, "missing parameter: 'type'".into()));
        assert_eq!(error(album_list(&params("type=byGenre"))), (10, "missing parameter: 'genre'".into()));
        assert_eq!(error(album_list(&params("type=byYear&toYear=2000"))), (10, "missing parameter: 'fromYear'".into()));
        assert_eq!(error(album_list(&params("type=byYear&fromYear=2000"))), (10, "missing parameter: 'toYear'".into()));
        assert_eq!(error(album_list(&params("type=byYear&fromYear=old&toYear=2000"))), (0, "invalid parameter 'fromYear': expected integer, got 'old'".into()));
        assert_eq!(error(album_list(&params("type=best"))), (0, "type 'best' not implemented".into()));
        assert_eq!(error(album_list(&params("type=Newest"))), (0, "type 'Newest' not implemented".into()));
    }

    #[test]
    fn album_lists_are_filtered_as_navidrome_filters_them() {
        let list = |query: &str| album_list(&params(query)).ok().unwrap();
        assert_eq!(list("type=alphabeticalByName").filter.sql, "missing = ?");
        assert_eq!(list("type=newest").filter.sql, "(missing = ? AND missing = ?)");
        assert_eq!(list("type=recent").filter.sql, "(missing = ? AND play_date > ?)");
        assert_eq!(list("type=frequent").filter.sql, "(missing = ? AND play_count > ?)");
        assert_eq!(list("type=starred").filter.sql, "(missing = ? AND starred = ?)");
        assert_eq!(list("type=highest").filter.sql, "(missing = ? AND rating > ?)");
        assert!(list("type=starred").annotated && list("type=recent").annotated && !list("type=newest").annotated);
        let by_year = list("type=byYear&fromYear=2020&toYear=2015");
        assert_eq!(by_year.filter.sql, "(missing = ? AND ((min_year >= ? AND min_year <= ?) OR (max_year >= ? AND max_year <= ?)))");
        assert_eq!(by_year.filter.args[1..], [Value::Integer(2015), Value::Integer(2020), Value::Integer(2015), Value::Integer(2020)], "turned around");
        assert_eq!(by_year.sort, Some(("max_year", "desc")));
        assert_eq!(list("type=byYear&fromYear=2015&toYear=2020").sort, Some(("max_year", "")));
        assert_eq!(
            list("type=byGenre&genre=Pop").filter.sql,
            "(missing = ? AND album.id IN (SELECT jt.album_id FROM album_tags jt JOIN tag on tag.id = jt.tag_id WHERE (tag.tag_name = ? AND tag.tag_value LIKE ?)))"
        );
        assert!(list("type=random").sort.is_none());
    }
}
