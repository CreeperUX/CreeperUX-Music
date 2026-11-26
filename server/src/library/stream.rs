//! Ported from Navidrome (GPL-3.0), © the Navidrome authors; the HTTP part follows Go's `net/http` (`ServeContent`,
//! BSD-3-Clause, © The Go Authors).
//!
//! `stream` of a song's file as it is (`server/subsonic/stream.go`, `core/stream/media_streamer.go`,
//! `core/stream/legacy_client.go`): what Navidrome calls a "raw" stream, served as Go's `http.ServeContent` serves a
//! file: ranges, `HEAD`, and the `If-…` conditions, with the song's `updated_at` as the file's time. A stream
//! Navidrome would transcode (a format asked for, a bit rate below the song's, a player with a transcoding or a lower
//! bit rate set) is decided as Navidrome decides it (transcode.rs) and run by ffmpeg (transcoder.rs); once in the
//! transcoding cache it is a file like the song's own.
//!
//! The file's path is never the client's: the client names a song by its id, the song's row (as the user may read it)
//! gives its path inside its library's folder, and a path that would leave that folder is not opened here.

use std::io::{Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};

use chrono::{DateTime, Datelike, NaiveDate, NaiveTime, Utc};
use hyper::StatusCode;
use hyper::header::{self, HeaderMap, HeaderName, HeaderValue};
use rusqlite::OptionalExtension;
use rusqlite::types::Value;

use crate::gotime;
use crate::subsonic::respond::MISSING_PARAMETER;

use super::browse::{int_or, string};
use super::query::{self, Cond, ListOptions, QueryError, Song};
use super::{NOT_FOUND, Reply, Scope, entities, transcode, transcoder};

/// What is sent: a status, headers beside Navidrome's usual ones, and a body.
pub struct Media {
    pub status: StatusCode,
    pub headers: Vec<(HeaderName, HeaderValue)>,
    pub body: MediaBody,
}

pub enum MediaBody {
    /// No body (a `HEAD`, 304, 412).
    Empty,
    /// A body known whole: Go's `http.Error` text, a short transcode.
    Text(Vec<u8>),
    /// `length` bytes of the open file from `start` on.
    File { file: std::fs::File, start: u64, length: u64 },
    /// A running transcode's output.
    Transcode(tokio::sync::mpsc::Receiver<transcoder::Chunk>),
    /// The first bytes of a running transcode, held, then the rest of it.
    Held(Vec<u8>, tokio::sync::mpsc::Receiver<transcoder::Chunk>),
}

/// `stream`: the song's file as it is, transcoded, or Navidrome's to answer.
pub fn stream(scope: &Scope) -> Result<Reply, QueryError> {
    let params = scope.params;
    let id = match string(params, "id") {
        Ok(Some(id)) => id,
        Ok(None) => return Ok(Reply::error(MISSING_PARAMETER, "missing parameter: 'id'")),
        Err(reply) => return Ok(reply),
    };
    let max_bit_rate = int_or(params, "maxBitRate", 0);
    let format = match string(params, "format") {
        Ok(format) => format.unwrap_or(""),
        Err(reply) => return Ok(reply),
    };
    let offset = int_or(params, "timeOffset", 0);
    let list = ListOptions { filter: Some(Cond::eq("media_file.id", Value::Text(id.to_string()))), ..ListOptions::default() };
    let songs = query::songs(scope.conn, scope.viewer, scope.options, &list)?;
    let Some(song) = songs.first() else { return Ok(Reply::error(NOT_FOUND, "data not found")) };
    let Some(player) = scope.player else { return Ok(Reply::Navidrome("no player: Navidrome's")) };
    // the player's transcoding, as Navidrome's middleware loads it
    let forced = if player.transcoding_id.is_empty() {
        None
    } else {
        match transcoding(scope.conn, "id", &player.transcoding_id)? {
            Some(row) => Some(row),
            None => return Ok(Reply::Navidrome("a player whose transcoding is not there")),
        }
    };
    let find = |format: &str| transcoding(scope.conn, "target_format", format).ok().flatten();
    let cx = transcode::Context {
        player_max_bit_rate: player.max_bit_rate,
        player_transcoding: forced.as_ref(),
        default_downsampling_format: &scope.options.default_downsampling_format,
        find: &find,
    };
    let request = transcode::resolve_request(song, format, max_bit_rate, &cx);
    if request.is_raw() {
        // the file as it is: from the R2 mirror, for a client that asked and may be sent there, when the mirror has
        // this very version of it
        if let Some(link) = scope.mirror.filter(|_| scope.redirect).and_then(|mirror| mirror_link(mirror, song, scope.http_method)) {
            return Ok(Reply::Redirect(link));
        }
        return Ok(serve_raw(song, scope.http_method, scope.headers));
    }
    Ok(transcoded(song, &request, offset, scope, &find))
}

/// `ds.Transcoding(ctx)`: a row by its id or its format.
fn transcoding(conn: &rusqlite::Connection, column: &str, value: &str) -> Result<Option<transcode::Transcoding>, QueryError> {
    let sql = format!("SELECT target_format, coalesce(default_bit_rate, 0), coalesce(command, '') FROM transcoding WHERE {column} = ? LIMIT 1");
    Ok(conn
        .prepare_cached(&sql)?
        .query_row([value], |r| Ok(transcode::Transcoding { target_format: r.get(0)?, default_bit_rate: r.get(1)?, command: r.get(2)? }))
        .optional()?)
}

/// Whether a song's stored path stays inside its library's folder: relative, without `..`.
pub fn inside_library(path: &str) -> bool {
    !path.is_empty() && Path::new(path).components().all(|part| matches!(part, Component::Normal(_) | Component::CurDir))
}

/// A presigned link to the song's file in the mirror: only when the mirror has the file's current version (its size
/// and time now) uploaded.
fn mirror_link(mirror: &crate::mirror::Mirror, song: &Song, method: &str) -> Option<String> {
    if !inside_library(&song.path) || song.id.is_empty() || !song.id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
        return None;
    }
    let stamp = crate::mirror::s3::Stamp::of(&file_of(song)).ok()?;
    mirror.link(&format!("m/{}/{}", song.id, stamp.version()), Some(stamp.size), method)
}

/// `mf.AbsolutePath()`.
pub fn file_of(song: &Song) -> PathBuf {
    Path::new(&song.library_path).join(&song.path)
}

/// The song's time as Go has it (none: Go's zero time); Err when it cannot be read as Go reads it.
fn song_time(song: &Song) -> Result<Option<DateTime<Utc>>, ()> {
    match song.updated_at.as_deref() {
        None => Ok(None),
        Some(text) => gotime::parse(text).map(|time| Some(time).filter(|time| !is_go_zero(time))).ok_or(()),
    }
}

/// The song's file as `http.ServeContent` serves it, or Navidrome's to answer.
fn serve_raw(song: &Song, method: &str, request: &HeaderMap) -> Reply {
    if !inside_library(&song.path) {
        return Reply::Navidrome("a song whose stored path leaves its library's folder");
    }
    // Stream.Name() is the title and the suffix: its type comes from the suffix
    if song.suffix.is_empty() || !song.suffix.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return Reply::Navidrome("a suffix Go would not find the content type by");
    }
    let Some(content_type) = entities::content_type(&song.suffix) else {
        return Reply::Navidrome("a song whose content type Go would take from the operating system's tables");
    };
    let Ok(stored) = song_time(song) else { return Reply::Navidrome("a song's time this server does not read as Go does") };
    let file = match std::fs::File::open(file_of(song)) {
        Ok(file) => file,
        Err(_) => return Reply::Navidrome("the song's file cannot be opened: Navidrome's error"),
    };
    serve_file(file, content_type, song.duration, stored, method, request)
}

/// A transcoded stream (`NewStream` past `ResolveRequest`): the finished cache entry as a file, or a transcode to run.
fn transcoded(song: &Song, request: &transcode::Request, offset: i64, scope: &Scope, find: &dyn Fn(&str) -> Option<transcode::Transcoding>) -> Reply {
    if !transcode::is_default_command(&request.format, &transcode::command_for(&request.format, find)) {
        return Reply::Navidrome("a transcoding with a command of its own, which only Navidrome runs");
    }
    if !scope.transcoder.available() {
        return Reply::Navidrome("no ffmpeg found: Navidrome's error");
    }
    if !inside_library(&song.path) {
        return Reply::Navidrome("a song whose stored path leaves its library's folder");
    }
    let path = file_of(song);
    if !path.is_file() {
        return Reply::Navidrome("the song's file is not there: Navidrome's error");
    }
    let Some(content_type) = entities::content_type(&request.format) else { return Reply::Navidrome("a format without a content type") };
    let Ok(stored) = song_time(song) else { return Reply::Navidrome("a song's time this server does not read as Go does") };
    // streamJob.Key(): a new entry once the song's row changes
    let key = format!(
        "{}.{}.{}.{}.{}.{}.{}.{}",
        song.id,
        song.updated_at.as_deref().unwrap_or(""),
        request.bit_rate,
        request.sample_rate,
        request.bit_depth,
        request.channels,
        request.format,
        offset
    );
    if let Some(cached) = scope.transcoder.cached(&key) {
        // a finished transcode is a file: ranges and conditions as for the song's own
        if let Ok(file) = std::fs::File::open(&cached) {
            return serve_file(file, content_type, song.duration, stored, scope.http_method, scope.headers);
        }
    }
    let Some(input) = transcoder::ffmpeg_input(&path) else { return Reply::Navidrome("a path ffmpeg cannot be given") };
    let Some(ffmpeg_args) = transcode::ffmpeg_args(request, &input, offset) else { return Reply::Navidrome("a format only Navidrome transcodes") };
    // ffmpeg reads no keyboard and opens nothing but files
    let mut args: Vec<String> = ["-nostdin", "-protocol_whitelist", "file"].map(String::from).to_vec();
    args.extend(ffmpeg_args);
    let estimate =
        std::str::from_utf8(scope.params.get("estimateContentLength")).map(|v| ["true", "on", "1"].contains(&v.to_lowercase().as_str())).unwrap_or(false);
    let job = transcoder::Job { key, args, flac_duration: song.duration as f32 - offset as f32, user: scope.viewer.id.clone() };
    Reply::Transcode(Box::new(Pending {
        job,
        content_type,
        duration: go_float32(song.duration as f32),
        length: estimate.then(|| transcode::estimated_length(song.duration, request.bit_rate)),
        head: scope.http_method == "HEAD",
    }))
}

/// A transcode to start once the database is let go (mod.rs).
pub struct Pending {
    pub job: transcoder::Job,
    pub content_type: &'static str,
    /// `X-Content-Duration`.
    pub duration: String,
    /// `estimateContentLength`: the length announced.
    pub length: Option<i64>,
    pub head: bool,
}

/// `http.ServeContent` of an open file, with the song's time and duration.
fn serve_file(mut file: std::fs::File, content_type: &'static str, duration: f64, stored: Option<DateTime<Utc>>, method: &str, request: &HeaderMap) -> Reply {
    // the conditions and Last-Modified leave out the epoch as well as Go's zero time
    let modtime = stored.filter(|time| !is_zero_time(time));
    let size = match file.metadata() {
        Ok(meta) if meta.is_file() => meta.len(),
        _ => return Reply::Navidrome("the song's path is not a file"),
    };
    let mut headers = vec![(HeaderName::from_static("x-content-duration"), HeaderValue::from_str(&go_float32(duration as f32)).expect("digits"))];
    if let Some(time) = &modtime {
        headers.push((header::LAST_MODIFIED, HeaderValue::from_str(&http_date(time)).expect("a date")));
    }
    let (status, range) = match preconditions(method, request, modtime.as_ref(), stored.as_ref()) {
        Ok(Precondition::Go(range)) => (None, range),
        Ok(Precondition::NotModified) => (Some(StatusCode::NOT_MODIFIED), String::new()),
        Ok(Precondition::Failed) => (Some(StatusCode::PRECONDITION_FAILED), String::new()),
        Err(why) => return Reply::Navidrome(why),
    };
    if let Some(status) = status {
        return Reply::Media(Media { status, headers, body: MediaBody::Empty });
    }
    headers.push((header::CONTENT_TYPE, HeaderValue::from_static(content_type)));
    let ranges = match parse_range(&range, size) {
        Ok(ranges) => ranges,
        Err(RangeError::NoOverlap) if size == 0 => Vec::new(),
        Err(error) => {
            // serveError: the headers about the content go, Go's error text comes
            headers.retain(|(name, _)| name != header::LAST_MODIFIED && name != header::CONTENT_TYPE);
            if error == RangeError::NoOverlap {
                headers.push((header::CONTENT_RANGE, HeaderValue::from_str(&format!("bytes */{size}")).expect("digits")));
            }
            headers.push((header::CONTENT_TYPE, HeaderValue::from_static("text/plain; charset=utf-8")));
            let text = if error == RangeError::NoOverlap { "invalid range: failed to overlap" } else { "invalid range" };
            return Reply::Media(Media { status: StatusCode::RANGE_NOT_SATISFIABLE, headers, body: MediaBody::Text(format!("{text}\n").into_bytes()) });
        }
    };
    // a request for more bytes than the file has is answered with the whole file
    let ranges = if ranges.iter().map(|r| r.length).sum::<u64>() > size { Vec::new() } else { ranges };
    let (status, start, length) = match ranges.as_slice() {
        [] => (StatusCode::OK, 0, size),
        [range] => {
            headers.push((
                header::CONTENT_RANGE,
                HeaderValue::from_str(&format!("bytes {}-{}/{size}", range.start, (range.start + range.length).wrapping_sub(1) as i64)).expect("digits"),
            ));
            (StatusCode::PARTIAL_CONTENT, range.start, range.length)
        }
        _ => return Reply::Navidrome("several ranges: Navidrome's multipart answer, with a boundary of its own"),
    };
    headers.push((header::ACCEPT_RANGES, HeaderValue::from_static("bytes")));
    headers.push((header::CONTENT_LENGTH, HeaderValue::from(length)));
    if method == "HEAD" {
        return Reply::Media(Media { status, headers, body: MediaBody::Empty });
    }
    if file.seek(SeekFrom::Start(start)).is_err() {
        return Reply::Navidrome("the song's file cannot be read: Navidrome's error");
    }
    // the bytes are read as they go out
    Reply::Media(Media { status, headers, body: MediaBody::File { file, start, length } })
}

// ---------------------------------------------------------------- Go's net/http, as ServeContent uses it

/// Go's `Time.IsZero`: January 1 of year 1, 00:00:00 UTC.
fn is_go_zero(time: &DateTime<Utc>) -> bool {
    time.year() == 1 && time.ordinal() == 1 && time.time() == NaiveTime::MIN
}

/// `isZeroTime`: Go's zero time, or the Unix epoch.
fn is_zero_time(time: &DateTime<Utc>) -> bool {
    is_go_zero(time) || (time.timestamp() == 0 && time.timestamp_subsec_nanos() == 0)
}

/// `http.TimeFormat`, in UTC.
pub fn http_date(time: &DateTime<Utc>) -> String {
    time.format("%a, %d %b %Y %H:%M:%S GMT").to_string()
}

/// What the conditions of a request decide (`checkPreconditions`).
#[derive(Debug, PartialEq)]
enum Precondition {
    /// Go on, with this `Range` (empty: the whole file).
    Go(String),
    NotModified,
    Failed,
}

#[derive(Debug, PartialEq, Clone, Copy)]
enum Check {
    None,
    True,
    False,
}

/// `checkPreconditions`, for an answer without an `ETag`: `modtime` is the time without Go's zero and the epoch,
/// `stored` without Go's zero only (`checkIfRange` takes the epoch). Err: a condition this server cannot read as Go
/// does.
fn preconditions(method: &str, request: &HeaderMap, modtime: Option<&DateTime<Utc>>, stored: Option<&DateTime<Utc>>) -> Result<Precondition, &'static str> {
    // the first value, as Go's Header.Get
    let text = |name: &HeaderName| request.get(name).map(|v| String::from_utf8_lossy(v.as_bytes()).into_owned()).unwrap_or_default();
    let get_or_head = method == "GET" || method == "HEAD";
    let mut cond = check_if_match(&text(&header::IF_MATCH));
    if cond == Check::None {
        cond = check_since(&text(&header::IF_UNMODIFIED_SINCE), modtime, true)?;
    }
    if cond == Check::False {
        return Ok(Precondition::Failed);
    }
    match check_if_none_match(&text(&header::IF_NONE_MATCH)) {
        Check::False if get_or_head => return Ok(Precondition::NotModified),
        Check::False => return Ok(Precondition::Failed),
        Check::None if get_or_head && check_since(&text(&header::IF_MODIFIED_SINCE), modtime, false)? == Check::False => {
            return Ok(Precondition::NotModified);
        }
        _ => {}
    }
    let range = text(&header::RANGE);
    if !range.is_empty() && get_or_head && check_if_range(&text(&header::IF_RANGE), stored)? == Check::False {
        return Ok(Precondition::Go(String::new()));
    }
    Ok(Precondition::Go(range))
}

/// `textproto.TrimString`.
fn trim(text: &str) -> &str {
    text.trim_matches([' ', '\t', '\n', '\r'])
}

/// `scanETag`: an entity tag at the start of `text`, and what follows it.
fn scan_etag(text: &str) -> Option<(&str, &str)> {
    let text = trim(text);
    let start = if text.starts_with("W/") { 2 } else { 0 };
    let bytes = text.as_bytes();
    if bytes.len() - start < 2 || bytes[start] != b'"' {
        return None;
    }
    for (i, &c) in bytes.iter().enumerate().skip(start + 1) {
        match c {
            b'"' => return Some((&text[..=i], &text[i + 1..])),
            0x21 | 0x23..=0x7E | 0x80.. => {}
            _ => return None,
        }
    }
    None
}

/// `checkIfMatch` with no `ETag` of ours: only `*` matches.
fn check_if_match(value: &str) -> Check {
    if value.is_empty() {
        return Check::None;
    }
    let mut rest = value;
    loop {
        rest = trim(rest);
        if rest.is_empty() {
            break;
        }
        if let Some(after) = rest.strip_prefix(',') {
            rest = after;
            continue;
        }
        if rest.starts_with('*') {
            return Check::True;
        }
        match scan_etag(rest) {
            Some((_, after)) => rest = after,
            None => break,
        }
    }
    Check::False
}

/// `checkIfNoneMatch` with no `ETag` of ours: only `*` matches.
fn check_if_none_match(value: &str) -> Check {
    if value.is_empty() {
        return Check::None;
    }
    let mut rest = value;
    loop {
        rest = trim(rest);
        if rest.is_empty() {
            break;
        }
        if let Some(after) = rest.strip_prefix(',') {
            rest = after;
            continue;
        }
        if rest.starts_with('*') {
            return Check::False;
        }
        match scan_etag(rest) {
            Some((_, after)) => rest = after,
            None => break,
        }
    }
    Check::True
}

/// `checkIfUnmodifiedSince` (`unmodified`) and `checkIfModifiedSince`: the file's time to the second against the
/// header's.
fn check_since(value: &str, modtime: Option<&DateTime<Utc>>, unmodified: bool) -> Result<Check, &'static str> {
    let Some(modtime) = modtime.filter(|_| !value.is_empty()) else { return Ok(Check::None) };
    let since = match parse_http_time(value) {
        HttpTime::At(time) => time,
        HttpTime::Invalid => return Ok(Check::None),
        HttpTime::Unsure => return Err("a time in a condition this server does not read as Go does"),
    };
    let not_after = modtime.timestamp() <= since;
    Ok(match (unmodified, not_after) {
        (true, true) | (false, false) => Check::True,
        _ => Check::False,
    })
}

/// `checkIfRange` with no `ETag` of ours: an entity tag never matches, a time must be the file's to the second.
fn check_if_range(value: &str, modtime: Option<&DateTime<Utc>>) -> Result<Check, &'static str> {
    if value.is_empty() {
        return Ok(Check::None);
    }
    if scan_etag(value).is_some() {
        return Ok(Check::False);
    }
    let Some(modtime) = modtime else { return Ok(Check::False) };
    Ok(match parse_http_time(value) {
        HttpTime::At(time) if time == modtime.timestamp() => Check::True,
        HttpTime::Unsure => return Err("a time in a condition this server does not read as Go does"),
        _ => Check::False,
    })
}

/// A time in a header, as Go's `http.ParseTime` reads it: seconds since 1970.
#[derive(Debug, PartialEq)]
enum HttpTime {
    At(i64),
    Invalid,
    /// A zone Go would look up in the server's own time zone.
    Unsure,
}

const SHORT_DAYS: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const LONG_DAYS: [&str; 7] = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/// Reads Go's `time.Parse` would read with the layouts of `http.ParseTime`, in order: `http.TimeFormat`
/// (`Mon, 02 Jan 2006 15:04:05 GMT`), RFC 850 (`Monday, 02-Jan-06 15:04:05 MST`), ANSI C (`Mon Jan _2 15:04:05 2006`).
fn parse_http_time(text: &str) -> HttpTime {
    let mut unsure = false;
    for layout in 0..3 {
        match parse_layout(text, layout) {
            Some(Ok(time)) => return HttpTime::At(time),
            Some(Err(())) => unsure = true,
            None => {}
        }
    }
    if unsure { HttpTime::Unsure } else { HttpTime::Invalid }
}

/// A cursor over the text as Go's parser walks it.
struct Cursor<'a>(&'a str);

impl<'a> Cursor<'a> {
    fn literal(&mut self, prefix: &str) -> Option<()> {
        self.0 = self.0.strip_prefix(prefix)?;
        Some(())
    }

    /// One of the names, compared without case (Go's `lookup`); its index.
    fn name(&mut self, names: &[&str]) -> Option<usize> {
        for (i, name) in names.iter().enumerate() {
            if self.0.len() >= name.len() && self.0.is_char_boundary(name.len()) && self.0[..name.len()].eq_ignore_ascii_case(name) {
                self.0 = &self.0[name.len()..];
                return Some(i);
            }
        }
        None
    }

    /// Go's `getnum`: two digits when `fixed`, else one or two.
    fn number(&mut self, fixed: bool) -> Option<u32> {
        let bytes = self.0.as_bytes();
        let first = *bytes.first().filter(|b| b.is_ascii_digit())?;
        match bytes.get(1).filter(|b| b.is_ascii_digit()) {
            Some(second) => {
                self.0 = &self.0[2..];
                Some(u32::from(first - b'0') * 10 + u32::from(second - b'0'))
            }
            None if fixed => None,
            None => {
                self.0 = &self.0[1..];
                Some(u32::from(first - b'0'))
            }
        }
    }

    fn digits(&mut self, count: usize) -> Option<u32> {
        let head = self.0.get(..count)?;
        if !head.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        self.0 = &self.0[count..];
        head.parse().ok()
    }
}

/// One layout: None when it does not read the text, Some(Err) when Go's answer would depend on the server's zone.
fn parse_layout(text: &str, layout: usize) -> Option<Result<i64, ()>> {
    let mut c = Cursor(text);
    let (year, month, day, hour, minute, second);
    let mut zone_known = true;
    match layout {
        0 => {
            c.name(&SHORT_DAYS)?;
            c.literal(", ")?;
            day = c.number(true)?;
            c.literal(" ")?;
            month = c.name(&MONTHS)? as u32 + 1;
            c.literal(" ")?;
            year = c.digits(4)? as i32;
            c.literal(" ")?;
            (hour, minute, second) = clock(&mut c)?;
            c.literal(" GMT")?;
        }
        1 => {
            c.name(&LONG_DAYS)?;
            c.literal(", ")?;
            day = c.number(true)?;
            c.literal("-")?;
            month = c.name(&MONTHS)? as u32 + 1;
            c.literal("-")?;
            let short = c.digits(2)? as i32;
            year = if short >= 69 { 1900 + short } else { 2000 + short };
            c.literal(" ")?;
            (hour, minute, second) = clock(&mut c)?;
            c.literal(" ")?;
            let length = zone_length(c.0)?;
            // GMT is GMT anywhere; another name is the server's zone when it is called so, else UTC
            zone_known = &c.0[..length] == "GMT";
            c.0 = &c.0[length..];
        }
        _ => {
            c.name(&SHORT_DAYS)?;
            c.literal(" ")?;
            month = c.name(&MONTHS)? as u32 + 1;
            c.literal(" ")?;
            if c.0.starts_with(' ') {
                c.0 = &c.0[1..];
            }
            day = c.number(false)?;
            c.literal(" ")?;
            (hour, minute, second) = clock(&mut c)?;
            c.literal(" ")?;
            year = c.digits(4)? as i32;
        }
    }
    if !c.0.is_empty() {
        return None;
    }
    let date = NaiveDate::from_ymd_opt(year, month, day)?;
    let time = NaiveTime::from_hms_opt(hour, minute, second)?;
    if !zone_known {
        return Some(Err(()));
    }
    Some(Ok(date.and_time(time).and_utc().timestamp()))
}

/// `15:04:05`: the hour with one or two digits, the rest with two.
fn clock(c: &mut Cursor) -> Option<(u32, u32, u32)> {
    let hour = c.number(false)?;
    c.literal(":")?;
    let minute = c.number(true)?;
    c.literal(":")?;
    let second = c.number(true)?;
    Some((hour, minute, second))
}

/// `parseTimeZone`, for the names it takes (a `GMT` with an offset is left out: no client sends one).
fn zone_length(text: &str) -> Option<usize> {
    let bytes = text.as_bytes();
    if bytes.len() < 3 {
        return None;
    }
    if bytes.starts_with(b"GMT") {
        return if bytes.len() == 3 { Some(3) } else { None };
    }
    let upper = bytes.iter().take(6).take_while(|b| b.is_ascii_uppercase()).count();
    match upper {
        3 => Some(3),
        4 if bytes[3] == b'T' || &bytes[..4] == b"WITA" => Some(4),
        5 if bytes[4] == b'T' => Some(5),
        _ => None,
    }
}

/// A byte range of the file.
#[derive(Debug, PartialEq, Clone, Copy)]
struct ByteRange {
    start: u64,
    length: u64,
}

#[derive(Debug, PartialEq, Clone, Copy)]
enum RangeError {
    Invalid,
    NoOverlap,
}

/// Go's `strconv.ParseInt(text, 10, 64)` for a range's numbers.
fn range_number(text: &str) -> Option<i64> {
    super::browse::parse_int(text)
}

/// `parseRange`.
fn parse_range(header: &str, size: u64) -> Result<Vec<ByteRange>, RangeError> {
    if header.is_empty() {
        return Ok(Vec::new());
    }
    let Some(specs) = header.strip_prefix("bytes=") else { return Err(RangeError::Invalid) };
    let size = size as i64;
    let mut ranges = Vec::new();
    let mut no_overlap = false;
    for spec in specs.split(',') {
        let spec = trim(spec);
        if spec.is_empty() {
            continue;
        }
        let Some((start, end)) = spec.split_once('-') else { return Err(RangeError::Invalid) };
        let (start, end) = (trim(start), trim(end));
        let range = if start.is_empty() {
            if end.is_empty() || end.starts_with('-') {
                return Err(RangeError::Invalid);
            }
            let suffix = range_number(end).filter(|n| *n >= 0).ok_or(RangeError::Invalid)?.min(size);
            ByteRange { start: (size - suffix) as u64, length: suffix as u64 }
        } else {
            let first = range_number(start).filter(|n| *n >= 0).ok_or(RangeError::Invalid)?;
            if first >= size {
                no_overlap = true;
                continue;
            }
            let length = if end.is_empty() {
                size - first
            } else {
                let last = range_number(end).filter(|last| first <= *last).ok_or(RangeError::Invalid)?.min(size - 1);
                last - first + 1
            };
            ByteRange { start: first as u64, length: length as u64 }
        };
        ranges.push(range);
    }
    if no_overlap && ranges.is_empty() {
        return Err(RangeError::NoOverlap);
    }
    Ok(ranges)
}

/// Go's `strconv.FormatFloat(float64(f), 'G', -1, 32)`: the shortest digits that read back as the same `float32`,
/// with an exponent below 1e-4 and from 1e6 on.
pub fn go_float32(value: f32) -> String {
    if value.is_nan() {
        return "NaN".into();
    }
    if value.is_infinite() {
        return if value > 0.0 { "+Inf".into() } else { "-Inf".into() };
    }
    if value == 0.0 {
        return if value.is_sign_negative() { "-0".into() } else { "0".into() };
    }
    // Rust's shortest digits of an f32, in scientific form: "1.234567E6"
    let scientific = format!("{value:E}");
    let (mantissa, exponent) = scientific.split_once('E').expect("an exponent");
    let exponent: i32 = exponent.parse().expect("a number");
    if !(-4..6).contains(&exponent) {
        let sign = if exponent < 0 { '-' } else { '+' };
        return format!("{mantissa}E{sign}{:02}", exponent.abs());
    }
    format!("{value}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn durations_are_written_as_go_writes_a_float32() {
        assert_eq!(go_float32(180.0), "180");
        assert_eq!(go_float32(3.0), "3");
        assert_eq!(go_float32(212.97_f64 as f32), "212.97");
        assert_eq!(go_float32(0.1), "0.1");
        assert_eq!(go_float32(0.0), "0");
        assert_eq!(go_float32(123_456.7), "123456.7");
        assert_eq!(go_float32(1_234_567.0), "1.234567E+06");
        assert_eq!(go_float32(0.000_01), "1E-05");
        assert_eq!(go_float32(0.000_1), "0.0001");
        assert_eq!(go_float32(f32::NAN), "NaN");
        assert_eq!(go_float32(f32::INFINITY), "+Inf");
    }

    #[test]
    fn ranges_are_read_as_go_reads_them() {
        let r = |start, length| ByteRange { start, length };
        assert_eq!(parse_range("", 100), Ok(vec![]));
        assert_eq!(parse_range("bytes=0-99", 1000), Ok(vec![r(0, 100)]));
        assert_eq!(parse_range("bytes=1000-", 5000), Ok(vec![r(1000, 4000)]));
        assert_eq!(parse_range("bytes=-50", 1000), Ok(vec![r(950, 50)]));
        assert_eq!(parse_range("bytes=-5000", 1000), Ok(vec![r(0, 1000)]), "a suffix longer than the file is the file");
        assert_eq!(parse_range("bytes=-0", 1000), Ok(vec![r(1000, 0)]));
        assert_eq!(parse_range("bytes=0-99999", 1000), Ok(vec![r(0, 1000)]), "an end past the file is its last byte");
        assert_eq!(parse_range("bytes= 5 - 9 ,", 1000), Ok(vec![r(5, 5)]), "spaces and empty parts are allowed");
        assert_eq!(parse_range("bytes=+5-9", 1000), Ok(vec![r(5, 5)]), "ParseInt takes a sign");
        assert_eq!(parse_range("bytes=0-1,5-6", 1000), Ok(vec![r(0, 2), r(5, 2)]));
        assert_eq!(parse_range("bytes=5000-", 1000), Err(RangeError::NoOverlap));
        assert_eq!(parse_range("bytes=5000-,0-1", 1000), Ok(vec![r(0, 2)]), "a part past the end is skipped when another fits");
        for invalid in ["bites=0-1", "bytes=1", "bytes=--5", "bytes=-", "bytes=9-5", "bytes=a-5", "bytes=-1-2", "bytes=99999999999999999999-"] {
            assert_eq!(parse_range(invalid, 1000), Err(RangeError::Invalid), "{invalid}");
        }
    }

    #[test]
    fn header_times_are_read_as_go_reads_them() {
        let at = |y, mo, d, h, mi, s| HttpTime::At(Utc.with_ymd_and_hms(y, mo, d, h, mi, s).unwrap().timestamp());
        assert_eq!(parse_http_time("Sun, 06 Nov 1994 08:49:37 GMT"), at(1994, 11, 6, 8, 49, 37));
        assert_eq!(parse_http_time("sun, 06 NOV 1994 8:49:37 GMT"), at(1994, 11, 6, 8, 49, 37), "names without case, a one-digit hour");
        assert_eq!(parse_http_time("Mon, 06 Nov 1994 08:49:37 GMT"), at(1994, 11, 6, 8, 49, 37), "Go does not check the weekday");
        assert_eq!(parse_http_time("Sunday, 06-Nov-94 08:49:37 GMT"), at(1994, 11, 6, 8, 49, 37));
        assert_eq!(parse_http_time("Sunday, 06-Nov-68 08:49:37 GMT"), at(2068, 11, 6, 8, 49, 37));
        assert_eq!(parse_http_time("Sun Nov  6 08:49:37 1994"), at(1994, 11, 6, 8, 49, 37));
        assert_eq!(parse_http_time("Sun Nov 16 08:49:37 1994"), at(1994, 11, 16, 8, 49, 37));
        assert_eq!(parse_http_time("Sunday, 06-Nov-94 08:49:37 CET"), HttpTime::Unsure, "a zone Go may look up locally");
        for invalid in [
            "",
            "Sun, 6 Nov 1994 08:49:37 GMT",
            "Sun, 31 Nov 1994 08:49:37 GMT",
            "Sun, 06 Nov 1994 24:00:00 GMT",
            "Sun, 06 Nov 1994 08:49:37 UTC",
            "Sun, 06 Nov 1994 08:49:37 GMT ",
            "yesterday",
        ] {
            assert_eq!(parse_http_time(invalid), HttpTime::Invalid, "{invalid:?}");
        }
    }

    #[test]
    fn conditions_are_checked_as_go_checks_them() {
        let modtime = Utc.with_ymd_and_hms(2026, 11, 25, 10, 0, 0).unwrap() + chrono::Duration::milliseconds(500);
        let check = |method: &str, pairs: &[(HeaderName, &str)]| {
            let mut headers = HeaderMap::new();
            for (name, value) in pairs {
                headers.insert(name.clone(), HeaderValue::from_str(value).unwrap());
            }
            preconditions(method, &headers, Some(&modtime), Some(&modtime)).unwrap()
        };
        let same = "Wed, 25 Nov 2026 10:00:00 GMT";
        let earlier = "Wed, 25 Nov 2026 09:59:59 GMT";
        assert_eq!(check("GET", &[]), Precondition::Go(String::new()));
        assert_eq!(check("GET", &[(header::RANGE, "bytes=0-1")]), Precondition::Go("bytes=0-1".into()));
        assert_eq!(check("GET", &[(header::IF_MODIFIED_SINCE, same)]), Precondition::NotModified, "to the second");
        assert_eq!(check("HEAD", &[(header::IF_MODIFIED_SINCE, same)]), Precondition::NotModified);
        assert_eq!(check("POST", &[(header::IF_MODIFIED_SINCE, same)]), Precondition::Go(String::new()), "only for GET and HEAD");
        assert_eq!(check("GET", &[(header::IF_MODIFIED_SINCE, earlier)]), Precondition::Go(String::new()));
        assert_eq!(check("GET", &[(header::IF_MODIFIED_SINCE, "nonsense")]), Precondition::Go(String::new()));
        assert_eq!(check("GET", &[(header::IF_UNMODIFIED_SINCE, earlier)]), Precondition::Failed);
        assert_eq!(check("GET", &[(header::IF_UNMODIFIED_SINCE, same)]), Precondition::Go(String::new()));
        assert_eq!(check("GET", &[(header::IF_MATCH, "\"abc\"")]), Precondition::Failed, "no entity tag of ours matches");
        assert_eq!(check("GET", &[(header::IF_MATCH, "\"abc\", *"), (header::IF_UNMODIFIED_SINCE, earlier)]), Precondition::Go(String::new()), "If-Match wins");
        assert_eq!(check("GET", &[(header::IF_MATCH, "abc, *")]), Precondition::Failed, "not an entity tag: the list ends there");
        assert_eq!(check("GET", &[(header::IF_NONE_MATCH, "*")]), Precondition::NotModified);
        assert_eq!(check("PUT", &[(header::IF_NONE_MATCH, "*")]), Precondition::Failed);
        assert_eq!(
            check("GET", &[(header::IF_NONE_MATCH, "\"abc\""), (header::IF_MODIFIED_SINCE, same)]),
            Precondition::Go(String::new()),
            "If-None-Match wins"
        );
        assert_eq!(check("GET", &[(header::RANGE, "bytes=0-1"), (header::IF_RANGE, same)]), Precondition::Go("bytes=0-1".into()));
        assert_eq!(check("GET", &[(header::RANGE, "bytes=0-1"), (header::IF_RANGE, earlier)]), Precondition::Go(String::new()));
        assert_eq!(check("GET", &[(header::RANGE, "bytes=0-1"), (header::IF_RANGE, "\"abc\"")]), Precondition::Go(String::new()));
        assert_eq!(check("POST", &[(header::RANGE, "bytes=0-1"), (header::IF_RANGE, "\"abc\"")]), Precondition::Go("bytes=0-1".into()));
    }

    #[test]
    fn a_stored_path_must_stay_in_the_library() {
        assert!(inside_library("Artist/Album/01 - Song.flac"));
        assert!(inside_library("./a.mp3"));
        assert!(!inside_library("../secret"));
        assert!(!inside_library("Artist/../../etc/passwd"));
        assert!(!inside_library("/etc/passwd"));
        assert!(!inside_library(""));
        #[cfg(windows)]
        {
            assert!(!inside_library("C:\\Windows\\win.ini"));
            assert!(!inside_library("..\\secret"));
        }
    }

    #[test]
    fn zero_times_have_no_date() {
        assert!(is_zero_time(&DateTime::<Utc>::UNIX_EPOCH));
        assert!(is_zero_time(&gotime::parse(gotime::ZERO).unwrap()));
        assert!(!is_zero_time(&Utc.with_ymd_and_hms(2026, 1, 1, 0, 0, 0).unwrap()));
        assert_eq!(http_date(&Utc.with_ymd_and_hms(2026, 11, 5, 7, 8, 9).unwrap()), "Thu, 05 Nov 2026 07:08:09 GMT");
    }
}
