//! Ported from Navidrome (GPL-3.0), © the Navidrome authors.
//!
//! What is read beside the tables: a song's lyrics (`getLyricsBySongId`: `server/subsonic/lyrics.go`,
//! `core/lyrics`) and a cover's bytes (`getCoverArt`: `server/subsonic/media_retrieval.go`, `core/artwork`,
//! `server/imghttp`). Both answer from what Navidrome has stored and nothing else:
//!
//! - **Lyrics** come from the song's row (the lyrics Navidrome read from the file's tags when it scanned). Navidrome
//!   looks for lyrics files beside the song first (`LyricsPriority`), and parses them when asked: a song with such a
//!   file is Navidrome's to answer.
//! - **A cover** is served when Navidrome's artwork state names its picture (`item_artwork`, `artwork`) and the
//!   bytes are where that state says: the picture's file, Navidrome's image store, or, resized, Navidrome's cache of
//!   resized pictures. A picture that must be looked for, taken out of an audio file or resized is Navidrome's work.

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use hyper::header::{self, HeaderName, HeaderValue};
use rusqlite::OptionalExtension;
use rusqlite::types::Value;
use sha1::{Digest, Sha1};

use crate::config::LibraryOptions;
use crate::gotime;
use crate::subsonic::respond::MISSING_PARAMETER;

use super::browse::{int_or, string};
use super::json::Json;
use super::query::{self, Cond, ListOptions, QueryError, Song, Viewer};
use super::{NOT_FOUND, Reply, Scope, entities};

// ---------------------------------------------------------------- lyrics

/// One set of lyrics as Navidrome stores it in a song's row (`model.Lyrics`), as far as the plain answer shows it.
#[derive(Debug, Clone, PartialEq)]
struct Lyrics {
    display_artist: String,
    display_title: String,
    kind: String,
    lang: String,
    lines: Vec<(Option<i64>, String)>,
    offset: Option<i64>,
    synced: bool,
}

/// `MediaFile.StructuredLyrics`: the stored JSON, read as Go's decoder reads it. None: not what Navidrome wrote
/// (its decoder would fail, and Navidrome would look on).
fn parse_lyrics(stored: &str) -> Option<Vec<Lyrics>> {
    let json: serde_json::Value = serde_json::from_str(stored).ok()?;
    let list = match json {
        serde_json::Value::Null => return Some(Vec::new()),
        serde_json::Value::Array(list) => list,
        _ => return None,
    };
    let text = |object: &serde_json::Value, key: &str| match object.get(key) {
        None | Some(serde_json::Value::Null) => Some(String::new()),
        Some(serde_json::Value::String(value)) => Some(value.clone()),
        _ => None,
    };
    let number = |object: &serde_json::Value, key: &str| match object.get(key) {
        None | Some(serde_json::Value::Null) => Some(None),
        Some(value) => value.as_i64().filter(|_| !value.is_f64()).map(Some),
    };
    let mut all = Vec::with_capacity(list.len());
    for item in &list {
        if !item.is_object() {
            return None;
        }
        let lines = match item.get("line") {
            None | Some(serde_json::Value::Null) => Vec::new(),
            Some(serde_json::Value::Array(lines)) => lines
                .iter()
                .map(|line| if line.is_object() { Some((number(line, "start")?, text(line, "value")?)) } else { None })
                .collect::<Option<Vec<_>>>()?,
            _ => return None,
        };
        let synced = match item.get("synced") {
            None | Some(serde_json::Value::Null) => false,
            Some(serde_json::Value::Bool(synced)) => *synced,
            _ => return None,
        };
        all.push(Lyrics {
            display_artist: text(item, "displayArtist")?,
            display_title: text(item, "displayTitle")?,
            kind: text(item, "kind")?,
            lang: text(item, "lang")?,
            lines,
            offset: number(item, "offset")?,
            synced,
        });
    }
    Some(all)
}

/// Where a song's lyrics come from, following `LyricsPriority` as `getLyricsForCandidates` does.
#[derive(Debug, PartialEq)]
enum LyricsSource {
    /// The song's row.
    Stored(Vec<Lyrics>),
    /// No source has any.
    None,
    /// A lyrics file beside the song, a plugin, or a row this server does not read as Navidrome does.
    Navidromes(&'static str),
}

/// Go's `path.Ext`: from the last dot of the last element on.
fn extension(path: &str) -> &str {
    let name = path.rsplit('/').next().unwrap_or(path);
    name.rfind('.').map(|at| &name[at..]).unwrap_or("")
}

fn lyrics_source(song: &Song, priority: &str, exists: &dyn Fn(&Path) -> Option<bool>) -> LyricsSource {
    for pattern in priority.split(',') {
        let pattern = pattern.trim();
        if pattern.is_empty() {
            continue;
        }
        if pattern.eq_ignore_ascii_case("embedded") {
            if song.lyrics.is_empty() {
                continue;
            }
            match parse_lyrics(&song.lyrics) {
                Some(list) if !list.is_empty() => return LyricsSource::Stored(list),
                Some(_) => continue,
                None => return LyricsSource::Navidromes("stored lyrics this server does not read as Navidrome does"),
            }
        }
        if pattern.starts_with('.') {
            // fromExternalFile: the song's path with this suffix for its extension, in the library's folder
            let stem = &song.path[..song.path.len() - extension(&song.path).len()];
            let beside = Path::new(&song.library_path).join(format!("{stem}{pattern}"));
            match exists(&beside) {
                Some(false) => continue,
                // there, or not to be known: Navidrome reads and parses it, or says why it cannot
                _ => return LyricsSource::Navidromes("a lyrics file beside the song, which Navidrome parses"),
            }
        }
        return LyricsSource::Navidromes("a lyrics source that is a plugin");
    }
    LyricsSource::None
}

/// Whether a file is there: None when that cannot be told (no permission, a path the system refuses).
fn file_exists(path: &Path) -> Option<bool> {
    match std::fs::metadata(path) {
        Ok(_) => Some(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Some(false),
        Err(_) => None,
    }
}

/// `getLyricsBySongId`: the song's lyrics with their line times, as OpenSubsonic's `songLyrics` has them.
pub fn get_lyrics_by_song_id(scope: &Scope) -> Result<Reply, QueryError> {
    let params = scope.params;
    let id = match string(params, "id") {
        Ok(Some(id)) => id,
        Ok(None) => return Ok(Reply::error(MISSING_PARAMETER, "missing parameter: 'id'")),
        Err(reply) => return Ok(reply),
    };
    // `enhanced` adds the other kinds of lyrics, word timings and who sings: not something Sonus clients ask for
    let enhanced = std::str::from_utf8(params.get("enhanced")).map(|v| ["true", "on", "1"].contains(&v.to_lowercase().as_str())).unwrap_or(true);
    if enhanced {
        return Ok(Reply::Navidrome("enhanced lyrics, which Sonus clients do not ask for"));
    }
    let list = ListOptions { filter: Some(Cond::eq("media_file.id", Value::Text(id.to_string()))), ..ListOptions::default() };
    let songs = query::songs(scope.conn, scope.viewer, scope.options, &list)?;
    // Navidrome's own words for a song that is not there, here: the repository's error as the handler passes it on
    let Some(song) = songs.first() else { return Ok(Reply::error(NOT_FOUND, "data not found")) };
    let lyrics = match lyrics_source(song, &scope.options.lyrics_priority, &file_exists) {
        LyricsSource::Stored(lyrics) => lyrics,
        LyricsSource::None => Vec::new(),
        LyricsSource::Navidromes(why) => return Ok(Reply::Navidrome(why)),
    };
    let mut j = Json::new();
    j.key("lyricsList");
    j.begin_object();
    // buildLyricsList without `enhanced`: the main lyrics only (a kind left blank is the main one)
    let main: Vec<&Lyrics> = lyrics.iter().filter(|l| l.kind.trim().is_empty() || l.kind == "main").collect();
    j.array_ne("structuredLyrics", &main, |j, lyrics| {
        j.begin_object();
        j.string_ne("displayArtist", if lyrics.display_artist.is_empty() { &song.artist } else { &lyrics.display_artist });
        j.string_ne("displayTitle", if lyrics.display_title.is_empty() { &song.title } else { &lyrics.display_title });
        j.string("lang", &lyrics.lang);
        j.array("line", &lyrics.lines, |j, (start, value)| {
            j.begin_object();
            if let Some(start) = start {
                j.int("start", *start);
            }
            j.string("value", value);
            j.end_object();
        });
        if let Some(offset) = lyrics.offset {
            j.int("offset", offset);
        }
        j.boolean("synced", lyrics.synced);
        j.end_object();
    });
    j.end_object();
    Ok(Reply::ok(j.finish()))
}

// ---------------------------------------------------------------- covers

/// A cover art id as Navidrome's `model.ParseArtworkID` reads it, for the kinds whose picture has a state row.
#[derive(Debug, PartialEq)]
struct CoverId<'a> {
    kind: &'a str,
    id: &'a str,
    /// The picture's hash the client asks for (`al-<id>_<hash>`), empty when the id has none.
    hash: &'a str,
}

/// `isImageHash`: 16 lowercase hexadecimal digits.
fn is_image_hash(text: &str) -> bool {
    text.len() == 16 && text.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn parse_cover_id(text: &str) -> Option<CoverId<'_>> {
    let (kind, rest) = text.split_once('-')?;
    // albums, songs, playlists, artists, discs (found by a walk through the album's folders: disc.rs); a radio's,
    // and an id that names an item without its kind, are Navidrome's
    if !["al", "mf", "pl", "ar", "dc"].contains(&kind) {
        return None;
    }
    let (id, suffix) = rest.split_once('_').unwrap_or((rest, ""));
    if id.is_empty() {
        return None;
    }
    Some(CoverId { kind, id, hash: if is_image_hash(suffix) { suffix } else { "" } })
}

/// A picture's state as Navidrome keeps it (`item_artwork` with the picture's row in `artwork`).
#[derive(Debug, Clone, Default, PartialEq)]
struct State {
    hash: String,
    source: String,
    source_path: String,
    ref_mtime: i64,
    updated_at: String,
    mime: String,
    /// Settled absent (Navidrome's empty hash): a placeholder; a hash Navidrome does not know is not this.
    absent: bool,
}

/// `formatQualityTag`.
fn quality_tag(options: &LibraryOptions) -> String {
    if options.enable_webp_encoding { format!("webp{}", options.cover_art_quality) } else { format!("q{}", options.cover_art_quality) }
}

/// `representationTag`: what versions a resized picture, and the key it is cached under.
fn representation_tag(hash: &str, size: i64, square: bool, options: &LibraryOptions) -> String {
    format!("{hash}.{size}.{square}.{}", quality_tag(options))
}

/// Where Navidrome's cache of resized pictures keeps an entry (`spreadFS.KeyMapper`): by the SHA-1 of its key.
fn cache_path(options: &LibraryOptions, key: &str) -> PathBuf {
    let digest: String = Sha1::digest(key.as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
    cache_root(options).join(&digest[0..2]).join(&digest[2..4]).join(digest)
}

fn cache_root(options: &LibraryOptions) -> PathBuf {
    let folder = if options.cache_folder.is_empty() { Path::new(&options.data_folder).join("cache") } else { PathBuf::from(&options.cache_folder) };
    folder.join("images")
}

/// Whether Navidrome keeps a cache of resized pictures at all (`ImageCacheSize`; `0` turns it off).
fn cache_enabled(options: &LibraryOptions) -> bool {
    let digits: String = options.image_cache_size.trim().chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
    digits.parse::<f64>().map(|size| size > 0.0).unwrap_or(true)
}

/// Where Navidrome's image store keeps a picture (`ImageStore.path`, `extForMime`).
fn store_path(options: &LibraryOptions, hash: &str, mime: &str) -> PathBuf {
    let extension = match mime {
        "image/jpeg" => ".jpg",
        "image/png" => ".png",
        "image/gif" => ".gif",
        "image/webp" => ".webp",
        _ => ".img",
    };
    Path::new(&options.data_folder).join("artwork").join("hashed").join(&hash[0..2]).join(&hash[2..4]).join(format!("{hash}{extension}"))
}

/// A file's change time in nanoseconds since 1970, as Go's `ModTime().UnixNano()`.
fn mtime_nanos(path: &Path) -> Option<i64> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    i64::try_from(modified.duration_since(UNIX_EPOCH).ok()?.as_nanos()).ok()
}

/// The most a picture read into memory may be.
const MAX_PICTURE_BYTES: u64 = 64 << 20;

fn read_picture(path: &Path) -> Option<Vec<u8>> {
    let size = std::fs::metadata(path).ok()?.len();
    if size == 0 || size > MAX_PICTURE_BYTES {
        return None;
    }
    std::fs::read(path).ok()
}

/// `openOriginal`: the picture's bytes, only while the file they came from is as it was when Navidrome hashed it.
fn original(options: &LibraryOptions, state: &State) -> Option<Vec<u8>> {
    let source = Path::new(&state.source_path);
    if state.source == "folder" || state.source == "upload" {
        // the picture is a file of its own
        if state.ref_mtime != 0 && mtime_nanos(source)? != state.ref_mtime {
            return None;
        }
        return read_picture(source);
    }
    // the picture is in Navidrome's store; the file it was taken from still dates it
    if !state.source_path.is_empty() && state.ref_mtime != 0 && mtime_nanos(source)? != state.ref_mtime {
        return None;
    }
    read_picture(&store_path(options, &state.hash, &state.mime))
}

/// A resized picture from Navidrome's cache: only an entry Navidrome finished writing (it marks those).
fn resized(options: &LibraryOptions, key: &str) -> Option<Vec<u8>> {
    if !cache_enabled(options) {
        return None;
    }
    let path = cache_path(options, &format!("h-{key}"));
    let mut marker = path.clone().into_os_string();
    marker.push(".complete");
    if !Path::new(&marker).is_file() {
        return None;
    }
    read_picture(&path)
}

/// The content type Go's `http.DetectContentType` gives a picture's first bytes, for the kinds of picture
/// Navidrome stores. None: something else, which Navidrome's answer is to name.
fn sniff(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("image/jpeg");
    }
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some("image/png");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if bytes.len() >= 14 && bytes.starts_with(b"RIFF") && &bytes[8..14] == b"WEBPVP" {
        return Some("image/webp");
    }
    None
}

/// `ifNoneMatch` (`server/imghttp`): RFC 9110's weak comparison.
fn if_none_match(header: &str, etag: &str) -> bool {
    let header = header.trim();
    if header.is_empty() {
        return false;
    }
    header == "*" || header.split(',').any(|tag| tag.trim().trim_start_matches("W/").trim_matches('"') == etag)
}

/// `Exists` of the item's repository: the item is there, for this user.
fn item_exists(scope: &Scope, id: &CoverId) -> Result<bool, QueryError> {
    let viewer: &Viewer = scope.viewer;
    let user = Value::Text(viewer.id.clone());
    let key = Value::Text(id.id.to_string());
    let (sql, args): (String, Vec<Value>) = match id.kind {
        "al" | "mf" => {
            let table = if id.kind == "al" { "album" } else { "media_file" };
            let mut sql = format!("SELECT count(distinct {table}.id) as count FROM {table} WHERE {table}.id = ?");
            let mut args = vec![key];
            if let Some(restricted) = viewer.library_filter(table) {
                sql.push_str(" AND ");
                sql.push_str(&restricted.sql);
                args.extend(restricted.args);
            }
            (sql, args)
        }
        "pl" if viewer.is_admin => ("SELECT count(*) as exist FROM playlist WHERE id = ?".into(), vec![key]),
        "pl" => ("SELECT count(*) as exist FROM playlist WHERE (id = ? AND (public = ? OR owner_id = ?))".into(), vec![key, Value::Integer(1), user]),
        _ if viewer.is_admin => (
            "SELECT count(distinct artist.id) as exist FROM artist JOIN library_artist on library_artist.artist_id = artist.id WHERE artist.id = ?".into(),
            vec![key],
        ),
        _ => (
            "SELECT count(distinct artist.id) as exist FROM artist JOIN library_artist on library_artist.artist_id = artist.id JOIN user_library on \
             user_library.library_id = library_artist.library_id AND user_library.user_id = ? WHERE artist.id = ?"
                .into(),
            vec![user, key],
        ),
    };
    let count: i64 = scope.conn.prepare_cached(&sql)?.query_row(rusqlite::params_from_iter(args), |r| r.get(0))?;
    Ok(count > 0)
}

/// The picture's state: `artworkRepository.GetItemArtwork`, then `GetImage`.
fn state_of(scope: &Scope, id: &CoverId) -> Result<Option<State>, QueryError> {
    let row = scope
        .conn
        .prepare_cached("SELECT hash, source, source_path, ref_mtime, updated_at FROM item_artwork WHERE image_type = ? AND item_id = ? AND item_kind = ?")?
        .query_row(("primary", id.id, id.kind), |r| {
            Ok(State {
                hash: r.get::<_, Option<String>>(0)?.unwrap_or_default(),
                source: r.get::<_, Option<String>>(1)?.unwrap_or_default(),
                source_path: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                ref_mtime: r.get::<_, Option<i64>>(3)?.unwrap_or(0),
                updated_at: r.get::<_, Option<String>>(4)?.unwrap_or_default(),
                mime: String::new(),
                absent: false,
            })
        })
        .optional()?;
    let Some(mut state) = row else { return Ok(None) };
    if !is_image_hash(&state.hash) {
        // no picture (an empty hash), or not a hash Navidrome makes
        state.absent = state.hash.is_empty();
        state.hash.clear();
        return Ok(Some(state));
    }
    let mime: Option<String> = scope.conn.prepare_cached("SELECT mime FROM artwork WHERE hash = ?")?.query_row([&state.hash], |r| r.get(0)).optional()?;
    match mime {
        Some(mime) => state.mime = mime,
        None => state.hash.clear(),
    }
    Ok(Some(state))
}

/// Navidrome's placeholder covers (`resources/`), served as they are.
const ALBUM_PLACEHOLDER: &[u8] = include_bytes!("../assets/album-placeholder.webp");
const ARTIST_PLACEHOLDER: &[u8] = include_bytes!("../assets/artist-placeholder.webp");

/// `placeholderImage`: never cached, no validators (`imghttp.WriteImageHeaders`).
fn placeholder(kind: &str) -> Reply {
    let body = if kind == "ar" { ARTIST_PLACEHOLDER } else { ALBUM_PLACEHOLDER };
    Reply::Bytes { content_type: "image/webp", body: body.to_vec(), headers: vec![(header::CACHE_CONTROL, HeaderValue::from_static("no-store"))] }
}

/// A cover to resize once the database is let go (mod.rs): the original's bytes and what the answer carries.
pub struct PendingResize {
    pub original: Vec<u8>,
    pub size: u32,
    pub square: bool,
    pub quality: u8,
    /// The cache key (`h-` and the representation tag).
    pub key: String,
    pub headers: Vec<(HeaderName, HeaderValue)>,
}

/// `getCoverArt`: a picture Navidrome has settled, as it is or resized; a placeholder where Navidrome gives one.
pub fn get_cover_art(scope: &Scope) -> Result<Reply, QueryError> {
    let params = scope.params;
    let text = match string(params, "id") {
        Ok(Some(text)) => text,
        // no id: the album placeholder (an empty id resolves to nothing to serve)
        Ok(None) => return Ok(placeholder("al")),
        Err(_) => return Ok(Reply::Navidrome("an id that is not text")),
    };
    let Some(id) = parse_cover_id(text) else {
        return Ok(Reply::Navidrome("a radio's cover, or an id without its kind: Navidrome finds those"));
    };
    let size = int_or(params, "size", 0).max(0);
    let square = std::str::from_utf8(params.get("square")).map(|v| ["true", "on", "1"].contains(&v.to_lowercase().as_str())).unwrap_or(false);
    // the hash the client asked for decides the caching of whatever picture answers, as in imghttp
    serve(scope, id.kind, id.id, size, square, id.hash)
}

/// `Artwork.Get` for one id: a settled picture, a disc's (looked for now), a song's falling back to its disc's or
/// album's, or a placeholder.
fn serve(scope: &Scope, kind: &str, item: &str, size: i64, square: bool, requested: &str) -> Result<Reply, QueryError> {
    let options = scope.options;
    if kind == "dc" {
        return serve_disc(scope, item, size, square, requested);
    }
    if kind == "mf" && !options.enable_media_file_cover_art {
        // a song's own picture is not shown: its disc's or album's
        return serve_song_fallback(scope, item, size, square, requested);
    }
    let id = CoverId { kind, id: item, hash: requested };
    let Some(state) = state_of(scope, &id)? else {
        if kind == "mf" {
            // no row: a song that has a picture of its own is looked for (Navidrome's provisional read, which writes
            // to the queue); one that has none shows its disc's or album's
            return match song(scope, item)? {
                None => Ok(Reply::error(NOT_FOUND, "Artwork not found")),
                Some(s) if s.has_cover_art => Ok(Reply::Navidrome("a song's own picture with no state yet: Navidrome takes it out of the file")),
                Some(s) => serve(scope, cover_kind(&s), &cover_item(&s), size, square, requested),
            };
        }
        return Ok(Reply::Navidrome("no artwork state yet: Navidrome looks for the picture and notes what it finds"));
    };
    if state.absent {
        // settled absent: the kind's placeholder; a song's falls back to its disc's and album's cover
        return if kind == "mf" { serve_song_fallback(scope, item, size, square, requested) } else { Ok(placeholder(kind)) };
    }
    if state.hash.is_empty() {
        return Ok(Reply::Navidrome("a picture Navidrome cannot find: it looks again (a write)"));
    }
    if !item_exists(scope, &id)? {
        // serveHash: the picture of an item this user does not see is never served
        return Ok(placeholder(kind));
    }
    let file_backed = state.source == "folder" || state.source == "upload";
    let is_image_file =
        entities::content_type(extension(&state.source_path.replace('\\', "/")).trim_start_matches('.')).is_some_and(|kind| kind.starts_with("image/"));
    if file_backed && !is_image_file {
        return Ok(Reply::Navidrome("a stored source that is not a picture: Navidrome looks again"));
    }
    let Some(updated) = gotime::parse(&state.updated_at) else {
        return Ok(Reply::Navidrome("artwork state without its time: Navidrome's error"));
    };
    let etag = if size == 0 && !square { state.hash.clone() } else { representation_tag(&state.hash, size, square, options) };
    let Some(headers) = image_headers(&etag, Some(updated), requested, &state.hash) else { return Ok(Reply::Navidrome("a validator no header carries")) };
    let original = || original(options, &state);
    let missing = "the picture's bytes are not where Navidrome's state says: Navidrome looks again";
    match source(scope, &etag, size, square, headers, &original) {
        Served::Reply(reply) => Ok(reply),
        Served::Missing | Served::TooBig => Ok(Reply::Navidrome(missing)),
    }
}

/// What `serveSource` made of a picture.
enum Served {
    Reply(Reply),
    /// No bytes to open.
    Missing,
    /// Over `MaxImageSize` for a resize.
    TooBig,
}

/// `serveSource`: the picture as it is, or resized under its own validator (cached by Navidrome or here, else made).
fn source(scope: &Scope, etag: &str, size: i64, square: bool, headers: Vec<(HeaderName, HeaderValue)>, open: &dyn Fn() -> Option<Vec<u8>>) -> Served {
    let options = scope.options;
    let not_modified = || scope.if_none_match.is_some_and(|sent| if_none_match(sent, etag));
    let bytes = if size == 0 && !square {
        match open() {
            Some(bytes) => bytes,
            None => return Served::Missing,
        }
    } else {
        let key = format!("h-{etag}");
        // made before, by Navidrome or here
        match resized(options, etag).or_else(|| scope.images.and_then(|cache| cache.get(&key)).and_then(|path| read_picture(&path))) {
            Some(bytes) => bytes,
            None => {
                if options.enable_webp_encoding {
                    return Served::Reply(Reply::Navidrome("WebP encoding is on: Navidrome's encoder"));
                }
                let Some(original) = open() else { return Served::Missing };
                if original.len() as u64 > max_image_bytes(options) {
                    return Served::TooBig;
                }
                if not_modified() {
                    return Served::Reply(Reply::NotModified { headers });
                }
                let quality = u8::try_from(options.cover_art_quality.clamp(1, 100)).unwrap_or(75);
                let size = u32::try_from(size).unwrap_or(u32::MAX);
                return Served::Reply(Reply::Resize(Box::new(PendingResize { original, size, square, quality, key, headers })));
            }
        }
    };
    let Some(content_type) = sniff(&bytes) else { return Served::Reply(Reply::Navidrome("a picture of a kind Go would name")) };
    if not_modified() {
        return Served::Reply(Reply::NotModified { headers });
    }
    Served::Reply(Reply::Bytes { content_type, body: bytes, headers })
}

/// `imghttp.WriteImageHeaders` for a picture that is no placeholder: the validator, its time, and immutable only for
/// the client that asked for this very picture's hash.
fn image_headers(etag: &str, updated: Option<chrono::DateTime<chrono::Utc>>, requested: &str, hash: &str) -> Option<Vec<(HeaderName, HeaderValue)>> {
    let mut headers = vec![(header::ETAG, HeaderValue::from_str(&format!("\"{etag}\"")).ok()?)];
    if let Some(updated) = updated {
        headers.push((header::LAST_MODIFIED, HeaderValue::from_str(&updated.format("%a, %d %b %Y %H:%M:%S GMT").to_string()).ok()?));
    }
    let caching = if !requested.is_empty() && requested == hash { "public, max-age=31536000, immutable" } else { "public, no-cache" };
    headers.push((header::CACHE_CONTROL, HeaderValue::from_static(caching)));
    Some(headers)
}

/// A song as the user may read it: whether it has a picture of its own, its disc and its album.
fn song(scope: &Scope, id: &str) -> Result<Option<Song>, QueryError> {
    let list = ListOptions { filter: Some(Cond::eq("media_file.id", Value::Text(id.to_string()))), ..ListOptions::default() };
    Ok(query::songs(scope.conn, scope.viewer, scope.options, &list)?.into_iter().next())
}

/// `MediaFile.DiscCoverArtID`: the disc's cover when the song has a disc number, else the album's.
fn cover_kind(song: &Song) -> &'static str {
    if song.disc_number > 0 { "dc" } else { "al" }
}

fn cover_item(song: &Song) -> String {
    if song.disc_number > 0 { super::disc::disc_id(&song.album_id, song.disc_number) } else { song.album_id.clone() }
}

/// A song without a picture of its own shown: its disc's or album's (`serveMediaFile`).
fn serve_song_fallback(scope: &Scope, item: &str, size: i64, square: bool, requested: &str) -> Result<Reply, QueryError> {
    match song(scope, item)? {
        None => Ok(Reply::error(NOT_FOUND, "Artwork not found")),
        Some(s) => serve(scope, cover_kind(&s), &cover_item(&s), size, square, requested),
    }
}

/// `serveDisc`: the disc's own picture, looked for now and validated by the album's and its folders' times; none:
/// the album's cover.
fn serve_disc(scope: &Scope, item: &str, size: i64, square: bool, requested: &str) -> Result<Reply, QueryError> {
    let options = scope.options;
    let Some((album_id, number)) = super::disc::parse_disc_id(item) else {
        return Ok(Reply::Navidrome("a disc id Navidrome cannot read: its error"));
    };
    let reader = match super::disc::load(scope.conn, scope.viewer, album_id, number)? {
        Ok(Some(reader)) => reader,
        Ok(None) => return Ok(Reply::error(NOT_FOUND, "Artwork not found")),
        Err(why) => return Ok(Reply::Navidrome(why)),
    };
    let Some(nanos) = reader.cache_time.timestamp_nanos_opt() else { return Ok(Reply::Navidrome("a disc's time out of Go's range")) };
    // the cache key: the id, the newest time of the album and its images, and the priority
    let key = format!("{item}|{nanos}|{}", options.disc_art_priority);
    let etag = representation_tag(&key, size, square, options);
    let Some(headers) = image_headers(&etag, Some(reader.cache_time), requested, "") else { return Ok(Reply::Navidrome("a validator no header carries")) };
    let selected = std::cell::RefCell::new(None);
    let open = || {
        let picked = reader.select(&options.disc_art_priority);
        let bytes = match &picked {
            super::disc::Selected::Picture(bytes) => Some(bytes.clone()),
            _ => None,
        };
        *selected.borrow_mut() = Some(picked);
        bytes
    };
    match source(scope, &etag, size, square, headers, &open) {
        Served::Reply(reply) => Ok(reply),
        // nothing for the disc (or too big to resize): the album's cover
        Served::Missing | Served::TooBig => match selected.into_inner() {
            Some(super::disc::Selected::Navidromes(why)) => Ok(Reply::Navidrome(why)),
            _ => serve(scope, "al", album_id, size, square, requested),
        },
    }
}

/// `maxImageBytes`: `MaxImageSize` (default 20 MB; unreadable: the default).
fn max_image_bytes(options: &LibraryOptions) -> u64 {
    super::transcoder::parse_bytes(&options.max_image_size).filter(|size| *size > 0).unwrap_or(20_000_000)
}

/// The content type Go's server sniffs for a picture's first bytes (pub for the resized answers).
pub fn sniff_picture(bytes: &[u8]) -> Option<&'static str> {
    sniff(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn song(path: &str, lyrics: &str) -> Song {
        Song { library_path: "/music".into(), path: path.into(), lyrics: lyrics.into(), ..Song::default() }
    }

    const PRIORITY: &str = ".ttml,.yaml,.yml,.elrc,.lrc,.srt,.txt,embedded";
    const STORED: &str = r#"[{"lang":"eng","line":[{"start":500,"value":"One"},{"value":"Two"}],"offset":-250,"synced":true}]"#;

    #[test]
    fn stored_lyrics_are_read_as_navidrome_reads_them() {
        let lyrics = parse_lyrics(STORED).unwrap();
        assert_eq!(lyrics.len(), 1);
        assert_eq!((lyrics[0].lang.as_str(), lyrics[0].offset, lyrics[0].synced), ("eng", Some(-250), true));
        assert_eq!(lyrics[0].lines, [(Some(500), "One".to_string()), (None, "Two".to_string())]);
        assert_eq!(parse_lyrics("[]").unwrap(), []);
        assert_eq!(parse_lyrics("null").unwrap(), []);
        // what Go's decoder refuses
        assert!(parse_lyrics("").is_none());
        assert!(parse_lyrics("{}").is_none());
        assert!(parse_lyrics(r#"[{"line":[{"start":1.5,"value":"x"}]}]"#).is_none(), "a time that is not a whole number");
        assert!(parse_lyrics(r#"[{"line":[{"start":"1","value":"x"}]}]"#).is_none());
        assert!(parse_lyrics(r#"[{"lang":5}]"#).is_none());
        assert!(parse_lyrics(r#"[{"synced":"yes"}]"#).is_none());
    }

    #[test]
    fn lyrics_come_from_the_row_unless_a_file_beside_the_song_comes_first() {
        let nothing_there = |_: &Path| Some(false);
        let s = song("Artist/Album/01 - Song.flac", STORED);
        assert!(matches!(lyrics_source(&s, PRIORITY, &nothing_there), LyricsSource::Stored(list) if list.len() == 1));
        // a file with one of the suffixes before "embedded": Navidrome's, which parses it
        let asked = std::cell::RefCell::new(Vec::new());
        let lrc = |path: &Path| {
            asked.borrow_mut().push(path.to_string_lossy().replace('\\', "/"));
            Some(path.extension().is_some_and(|e| e == "lrc"))
        };
        assert!(matches!(lyrics_source(&s, PRIORITY, &lrc), LyricsSource::Navidromes(_)));
        assert_eq!(asked.borrow()[0], "/music/Artist/Album/01 - Song.ttml", "the song's path with the suffix for its extension");
        assert_eq!(asked.borrow().last().unwrap(), "/music/Artist/Album/01 - Song.lrc", "in the order of LyricsPriority, no further than the first found");
        // whether it is there cannot be told: Navidrome's
        assert!(matches!(lyrics_source(&s, PRIORITY, &|_| None), LyricsSource::Navidromes(_)));
        // embedded first: the row wins, files are not looked for
        assert!(matches!(lyrics_source(&s, "embedded,.lrc", &|_| panic!("not looked for")), LyricsSource::Stored(_)));
        // no lyrics in the row: the files after it still count
        let bare = song("a/b.mp3", "[]");
        assert_eq!(lyrics_source(&bare, PRIORITY, &nothing_there), LyricsSource::None);
        assert!(matches!(lyrics_source(&bare, "Embedded , .txt", &|_| Some(true)), LyricsSource::Navidromes(_)));
        assert_eq!(lyrics_source(&bare, "", &nothing_there), LyricsSource::None);
        // a plugin's name, and a row Go would not read
        assert!(matches!(lyrics_source(&bare, "lrclib,embedded", &nothing_there), LyricsSource::Navidromes(_)));
        assert!(matches!(lyrics_source(&song("a/b.mp3", "{"), "embedded", &nothing_there), LyricsSource::Navidromes(_)));
        assert_eq!(extension("a.b/c"), "");
        assert_eq!(extension("a/b.tar.gz"), ".gz");
    }

    #[test]
    fn cover_ids_are_read_as_navidrome_reads_them() {
        assert_eq!(
            parse_cover_id("al-7sUNA4P7FqEWNSryFglgb4_9046b47ac73f2574"),
            Some(CoverId { kind: "al", id: "7sUNA4P7FqEWNSryFglgb4", hash: "9046b47ac73f2574" })
        );
        assert_eq!(parse_cover_id("mf-abc"), Some(CoverId { kind: "mf", id: "abc", hash: "" }));
        assert_eq!(parse_cover_id("pl-abc_0"), Some(CoverId { kind: "pl", id: "abc", hash: "" }), "an old id's time stamp is no hash");
        assert_eq!(parse_cover_id("al-abc_9046B47AC73F2574").unwrap().hash, "", "a hash is lowercase");
        assert_eq!(parse_cover_id("ar-a-b_c_d"), Some(CoverId { kind: "ar", id: "a-b", hash: "" }));
        assert_eq!(parse_cover_id("dc-abc:1"), Some(CoverId { kind: "dc", id: "abc:1", hash: "" }), "a disc: looked for here (disc.rs)");
        for navidromes in ["ra-abc", "abc", "", "al-", "xx-abc", "al"] {
            assert_eq!(parse_cover_id(navidromes), None, "{navidromes}");
        }
    }

    #[test]
    fn pictures_are_where_navidrome_keeps_them() {
        let options = LibraryOptions { data_folder: "/data".into(), ..LibraryOptions::default() };
        let slashes = |path: PathBuf| path.to_string_lossy().replace('\\', "/");
        assert_eq!(slashes(store_path(&options, "33401af5b95c979a", "image/jpeg")), "/data/artwork/hashed/33/40/33401af5b95c979a.jpg");
        assert_eq!(slashes(store_path(&options, "560ad02e92edcc95", "image/png")), "/data/artwork/hashed/56/0a/560ad02e92edcc95.png");
        assert_eq!(slashes(store_path(&options, "560ad02e92edcc95", "image/avif")), "/data/artwork/hashed/56/0a/560ad02e92edcc95.img");
        // the validator Navidrome 0.64.2 answers a 600-pixel cover with, and where its cache keeps that entry
        assert_eq!(representation_tag("9046b47ac73f2574", 600, false, &options), "9046b47ac73f2574.600.false.q75");
        let webp = LibraryOptions { enable_webp_encoding: true, cover_art_quality: 80, ..options.clone() };
        assert_eq!(representation_tag("9046b47ac73f2574", 64, true, &webp), "9046b47ac73f2574.64.true.webp80");
        let entry = slashes(cache_path(&options, "h-9046b47ac73f2574.600.false.q75"));
        assert!(entry.starts_with("/data/cache/images/") && entry.len() == "/data/cache/images/aa/bb/".len() + 40, "{entry}");
        let elsewhere = LibraryOptions { cache_folder: "/var/cache/nd".into(), ..options.clone() };
        assert!(slashes(cache_path(&elsewhere, "h-x")).starts_with("/var/cache/nd/images/"));
        // SHA-1 of the key, spread over two levels
        assert_eq!(slashes(cache_path(&options, "abc")), "/data/cache/images/a9/99/a9993e364706816aba3e25717850c26c9cd0d89d");
        assert!(cache_enabled(&options));
        for off in ["0", "0MB", " 0 ", "0.0GB"] {
            assert!(!cache_enabled(&LibraryOptions { image_cache_size: off.into(), ..options.clone() }), "{off}");
        }
    }

    #[test]
    fn content_types_and_validators() {
        assert_eq!(sniff(&[0xFF, 0xD8, 0xFF, 0xE0, 0, 0]), Some("image/jpeg"));
        assert_eq!(sniff(b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR"), Some("image/png"));
        assert_eq!(sniff(b"GIF89a\x01\0"), Some("image/gif"));
        assert_eq!(sniff(b"RIFF\x10\0\0\0WEBPVP8 "), Some("image/webp"));
        assert_eq!(sniff(b"<svg xmlns"), None);
        assert_eq!(sniff(b""), None);
        assert!(if_none_match("\"abc\"", "abc"));
        assert!(if_none_match(" W/\"abc\" ", "abc"));
        assert!(if_none_match("\"x\", \"abc\"", "abc"));
        assert!(if_none_match("*", "abc"));
        assert!(!if_none_match("\"abcd\"", "abc"));
        assert!(!if_none_match("", "abc"));
    }
}
