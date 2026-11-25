//! Plays and what is playing now (phase 4, part 3 of docs/server-roadmap.md): `scrobble` and `getNowPlaying`, the
//! first of Navidrome's in-memory states to move here. Navidrome keeps "now playing" in its process (its play
//! tracker's cache); from now on it is kept here, and Navidrome no longer sees a Sonus client's plays.
//!
//! Ported from Navidrome (GPL-3.0), © the Navidrome authors: `server/subsonic/media_annotation.go` (`Scrobble`,
//! `scrobblerSubmit`, `scrobblerNowPlaying`), `server/subsonic/album_lists.go` (`GetNowPlaying`),
//! `core/scrobbler/play_tracker.go` (`ReportPlayback`, `GetNowPlaying`, `Submit`, `incPlay`,
//! `remainingTTL`), `server/subsonic/media_annotation.go` (`ReportPlayback`), `persistence/sql_annotations.go` (`IncPlayCount`), `persistence/scrobble_repository.go`
//! (`RecordScrobble`), `utils/req/req.go` (`Times`, `BoolOr`).
//!
//! What is not ported, by decision: sending plays and "now playing" to Last.fm, ListenBrainz or plugins, and the
//! buffer for them (decision 3 of the roadmap); the events Navidrome's web UI gets (`refreshResource` after a play,
//! the now-playing count; decision 2).

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};

use chrono::{DateTime, Local, TimeZone};
use rusqlite::types::Value;
use rusqlite::{Connection, params};

use super::browse::{int_or, string};
use super::json::Json;
use super::query::{self, Cond, ListOptions, QueryResult, Song};
use super::{Reply, Scope, entities};
use crate::gotime;
use crate::subsonic::respond::{GENERIC, MISSING_PARAMETER};

/// Navidrome's `PlaybackSession`, for the one state a Subsonic `scrobble` makes ("playing").
#[derive(Debug, Clone)]
pub struct Session {
    /// The song as it was loaded for the user when the session began (Navidrome keeps that `MediaFile`).
    pub song: Song,
    pub library_id: i64,
    pub username: String,
    /// The client's name (`c`).
    pub player_name: String,
    pub state: &'static str,
    pub position_ms: i64,
    pub playback_rate: f64,
    pub start: SystemTime,
    pub last_report: Instant,
    pub expires: Instant,
}

/// What is playing, by client: the player's id, or the web UI's unique client id (`X-ND-Client-Unique-Id`).
#[derive(Default)]
pub struct NowPlaying {
    sessions: Mutex<HashMap<String, Session>>,
}

impl NowPlaying {
    /// The sessions that have not expired (Navidrome's cache forgets an entry at its time to live).
    fn live(&self) -> Vec<Session> {
        let mut sessions = self.sessions.lock().expect("the now-playing lock");
        let now = Instant::now();
        sessions.retain(|_, session| session.expires > now);
        sessions.values().cloned().collect()
    }

    fn get(&self, client: &str) -> Option<Session> {
        let sessions = self.sessions.lock().expect("the now-playing lock");
        sessions.get(client).filter(|session| session.expires > Instant::now()).cloned()
    }

    fn put(&self, client: &str, session: Session) {
        let mut sessions = self.sessions.lock().expect("the now-playing lock");
        // (at most one entry per player or web UI tab; expired ones are dropped as they are found)
        let now = Instant::now();
        sessions.retain(|_, session| session.expires > now);
        sessions.insert(client.to_string(), session);
    }

    fn remove(&self, client: &str) {
        self.sessions.lock().expect("the now-playing lock").remove(client);
    }

    pub fn len(&self) -> usize {
        self.live().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// `remainingTTL`: what is left of the song at the rate it plays, plus 5 s.
fn remaining(duration_seconds: f64, position_ms: i64, rate: f64) -> Duration {
    let rate = if rate <= 0.0 { 1.0 } else { rate };
    let remaining_ms = ((duration_seconds as f32 * 1000.0) as i64 - position_ms) as f64 / rate;
    let remaining_s = ((remaining_ms / 1000.0) as i64).max(0);
    Duration::from_secs(remaining_s as u64 + 5)
}

/// `MediaFile.Get` for the user (with the library filter, missing songs too): the song and its library.
fn song(conn: &Connection, scope: &Scope, id: &str) -> QueryResult<Option<(Song, i64)>> {
    let list = ListOptions { filter: Some(Cond::eq("media_file.id", Value::Text(id.to_string()))), ..ListOptions::default() };
    let Some(found) = query::songs(conn, scope.viewer, scope.options, &list)?.into_iter().next() else { return Ok(None) };
    let library: i64 = conn.query_row("SELECT library_id FROM media_file WHERE id = ?1", [id], |row| row.get(0))?;
    Ok(Some((found, library)))
}

/// `IncPlayCount`: one more play of the item for the user, its last play the later of the two (compared as text,
/// as Navidrome's SQL compares them), inserted when the user had no row for it.
fn inc_play_count(conn: &Connection, user: &str, kind: &str, id: &str, at: &str) -> QueryResult<()> {
    let updated = conn
        .prepare_cached(
            "UPDATE annotation SET play_count = play_count+1, play_date = max(ifnull(play_date,''),?1) \
             WHERE annotation.user_id = ?2 AND annotation.item_type = ?3 AND annotation.item_id = ?4",
        )?
        .execute(params![at, user, kind, id])?;
    if updated == 0 {
        conn.prepare_cached("INSERT INTO annotation (user_id, item_type, item_id, play_count, play_date) VALUES (?1, ?2, ?3, 1, ?4)")?
            .execute(params![user, kind, id, at])?;
    }
    Ok(())
}

/// `incPlay`: the song, its album and every artist of the song (its `artist` role, in order, as many times as
/// listed) played once more; with `EnableScrobbleHistory`, a row in `scrobbles` (the time in seconds).
fn inc_play(scope: &Scope, song: &Song, time: &DateTime<Local>) -> QueryResult<()> {
    let conn = scope.conn;
    let at = gotime::format(time);
    let user = &scope.viewer.id;
    inc_play_count(conn, user, "media_file", &song.id, &at)?;
    inc_play_count(conn, user, "album", &song.album_id, &at)?;
    for artist in song.participants.role("artist") {
        inc_play_count(conn, user, "artist", &artist.id, &at)?;
    }
    if scope.options.enable_scrobble_history {
        // time.Time.Unix: whole seconds, rounded down
        conn.prepare_cached("INSERT INTO scrobbles (media_file_id, user_id, submission_time) VALUES (?1, ?2, ?3)")?.execute(params![
            song.id,
            user,
            time.timestamp()
        ])?;
    }
    Ok(())
}

/// `scrobble`: with `submission` (the default) a play of each `id`, at its `time` (ms; now when not given or not a
/// number); without, the first `id` playing now, at `position` (seconds). Answered ok whatever happened to each song,
/// as Navidrome answers (a song the user does not see is skipped).
pub fn scrobble(scope: &Scope, now_playing: &NowPlaying, client_id: &str) -> QueryResult<Reply> {
    let mut ids = Vec::new();
    for value in scope.params.all("id") {
        let Ok(text) = std::str::from_utf8(value) else { return Ok(Reply::Navidrome("a parameter that is not text")) };
        ids.push(text.to_string());
    }
    if ids.is_empty() {
        return Ok(Reply::error(MISSING_PARAMETER, "missing parameter: 'id'"));
    }
    // req.Params.Times: each value a number of milliseconds (time.UnixMilli, local time), or now (time.Now, with all
    // the precision the clock has)
    let times: Vec<DateTime<Local>> = scope
        .params
        .all("time")
        .iter()
        .map(|v| {
            std::str::from_utf8(v).ok().and_then(super::browse::parse_int).and_then(|ms| Local.timestamp_millis_opt(ms).single()).unwrap_or_else(Local::now)
        })
        .collect();
    if !times.is_empty() && times.len() != ids.len() {
        return Ok(Reply::error(GENERIC, format!("Wrong number of timestamps: {}, should be {}", times.len(), ids.len())));
    }
    // BoolOr("submission", true)
    let submission = match string(scope.params, "submission") {
        Ok(None) => true,
        Ok(Some(value)) => "/true/on/1/".contains(&format!("/{}/", value.to_lowercase())),
        Err(reply) => return Ok(reply),
    };
    let position = int_or(scope.params, "position", 0);
    if submission {
        for (i, id) in ids.iter().enumerate() {
            let Some((found, _)) = song(scope.conn, scope, id)? else { continue };
            inc_play(scope, &found, &times.get(i).copied().unwrap_or_else(Local::now))?;
        }
    } else {
        // scrobblerNowPlaying (MediaFile.Get, then ReportPlayback with "playing"); what fails is only logged there
        let report = Report { media_id: &ids[0], position_ms: position.saturating_mul(1000), state: "playing", rate: 1.0, ignore_scrobble: false };
        let _ = playback(scope, now_playing, client_id, &report)?;
    }
    Ok(Reply::ok(String::new()))
}

/// A playback report: `reportPlayback`'s parameters, or what a `scrobble` without `submission` amounts to.
pub struct Report<'a> {
    pub media_id: &'a str,
    pub position_ms: i64,
    pub state: &'static str,
    pub rate: f64,
    pub ignore_scrobble: bool,
}

/// Whether the request's player sends plays on (`player.ScrobbleEnabled`; Go's zero value, false, without a row).
fn scrobble_enabled(scope: &Scope) -> QueryResult<bool> {
    let enabled = scope
        .conn
        .query_row("SELECT scrobble_enabled FROM player WHERE id = ?1", [scope.player_id], |row| Ok(query::truthy(row.get_ref(0)?)))
        .or_else(|e| if e == rusqlite::Error::QueryReturnedNoRows { Ok(false) } else { Err(e) })?;
    Ok(enabled)
}

/// `playTracker.ReportPlayback`: the client's session started, playing, paused or stopped; a stop far enough into the
/// song (half of it, at most 4 minutes) counts a play, when the player sends plays on and the report does not say to
/// ignore it. Err: Navidrome's answer for a song the user does not see (70).
pub fn playback(scope: &Scope, now_playing: &NowPlaying, client_id: &str, report: &Report) -> QueryResult<Result<(), Reply>> {
    let not_found = || Reply::error(super::NOT_FOUND, "data not found");
    let now = Instant::now();
    let current = now_playing.get(client_id);
    let playing_this = current.as_ref().is_some_and(|session| session.song.id == report.media_id && session.state == "playing");
    let new_session = |found: Song, library_id: i64, start: SystemTime| Session {
        start,
        username: scope.viewer.name.clone(),
        player_name: scope.context.client.to_string(),
        state: report.state,
        position_ms: report.position_ms,
        playback_rate: report.rate,
        last_report: now,
        expires: now,
        library_id,
        song: found,
    };
    match report.state {
        "starting" => {
            // a late "starting" must not turn a playing session back
            if playing_this {
                return Ok(Ok(()));
            }
            let Some((found, library_id)) = song(scope.conn, scope, report.media_id)? else { return Ok(Err(not_found())) };
            let session = new_session(found, library_id, SystemTime::now());
            let expires = now + remaining(session.song.duration, report.position_ms, report.rate);
            now_playing.put(client_id, Session { expires, ..session });
        }
        "playing" | "paused" => {
            let mut session = match current.filter(|session| session.song.id == report.media_id) {
                Some(session) => session,
                None => {
                    let Some((found, library_id)) = song(scope.conn, scope, report.media_id)? else { return Ok(Err(not_found())) };
                    let start = SystemTime::now().checked_sub(Duration::from_millis(report.position_ms.max(0) as u64)).unwrap_or(SystemTime::UNIX_EPOCH);
                    new_session(found, library_id, start)
                }
            };
            session.state = report.state;
            session.position_ms = report.position_ms;
            session.playback_rate = report.rate;
            session.last_report = now;
            let ttl = if report.state == "playing" { remaining(session.song.duration, report.position_ms, report.rate) } else { Duration::from_secs(30 * 60) };
            now_playing.put(client_id, Session { expires: now + ttl, ..session });
        }
        _ => {
            // stopped
            let mut loaded = None;
            if !report.ignore_scrobble && scrobble_enabled(scope)? {
                let Some((found, library_id)) = song(scope.conn, scope, report.media_id)? else { return Ok(Err(not_found())) };
                let duration_ms = (found.duration as f32 * 1000.0) as i64;
                let threshold = (duration_ms * 50 / 100).min(240_000);
                if report.position_ms >= threshold {
                    inc_play(scope, &found, &Local::now())?;
                }
                loaded = Some((found, library_id));
            }
            match current {
                // a late stop for a song before the current one ends nothing
                Some(session) if session.song.id != report.media_id => return Ok(Ok(())),
                Some(_) => now_playing.remove(client_id),
                None => {
                    // Navidrome loads the song for its playback reporters, and answers 70 when it cannot
                    if loaded.is_none() && song(scope.conn, scope, report.media_id)?.is_none() {
                        return Ok(Err(not_found()));
                    }
                }
            }
        }
    }
    Ok(Ok(()))
}

/// Go's `strconv.ParseFloat(text, 64)` for what Sonus and Navidrome's web UI send; None for what is not a number
/// (and for Go's hexadecimal and underscored forms, which Navidrome would read: such a request is Navidrome's).
fn parse_float(text: &str) -> Result<Option<f64>, ()> {
    if text.contains(['x', 'X', '_', 'p', 'P']) {
        return Err(());
    }
    Ok(text.parse::<f64>().ok())
}

/// `reportPlayback`.
pub fn report_playback(scope: &Scope, now_playing: &NowPlaying, client_id: &str) -> QueryResult<Reply> {
    use super::browse::required;
    let media_id = match required(scope.params, "mediaId") {
        Ok(id) => id,
        Err(reply) => return Ok(reply),
    };
    // (any media type is taken as a song; Navidrome logs the others)
    if let Err(reply) = required(scope.params, "mediaType") {
        return Ok(reply);
    }
    let position_ms = match super::browse::required_int(scope.params, "positionMs") {
        Ok(position) => position,
        Err(reply) => return Ok(reply),
    };
    if position_ms < 0 {
        return Ok(Reply::error(GENERIC, "positionMs must be non-negative"));
    }
    let state = match required(scope.params, "state") {
        Ok(state) => state,
        Err(reply) => return Ok(reply),
    };
    let state: &'static str = match state {
        "starting" => "starting",
        "playing" => "playing",
        "paused" => "paused",
        "stopped" => "stopped",
        other => return Ok(Reply::error(GENERIC, format!("Invalid state: {other}"))),
    };
    // Float64Or("playbackRate", 1.0)
    let rate = match string(scope.params, "playbackRate") {
        Ok(None) => 1.0,
        Ok(Some(text)) => match parse_float(text) {
            Ok(value) => value.unwrap_or(1.0),
            Err(()) => return Ok(Reply::Navidrome("a playback rate written as Go alone reads it")),
        },
        Err(reply) => return Ok(reply),
    };
    if !rate.is_finite() || rate <= 0.0 {
        return Ok(Reply::error(GENERIC, "playbackRate must be a finite positive number"));
    }
    let ignore_scrobble = match string(scope.params, "ignoreScrobble") {
        Ok(None) => false,
        Ok(Some(value)) => "/true/on/1/".contains(&format!("/{}/", value.to_lowercase())),
        Err(reply) => return Ok(reply),
    };
    let report = Report { media_id, position_ms, state, rate, ignore_scrobble };
    Ok(match playback(scope, now_playing, client_id, &report)? {
        Ok(()) => Reply::ok(String::new()),
        Err(reply) => reply,
    })
}

/// `getNowPlaying`: what is playing in the libraries the user sees, the latest started first, the position of what
/// plays estimated from its last report.
pub fn get_now_playing(scope: &Scope, now_playing: &NowPlaying) -> QueryResult<Reply> {
    let mut sessions: Vec<Session> =
        now_playing.live().into_iter().filter(|session| scope.viewer.is_admin || scope.viewer.libraries.contains(&session.library_id)).collect();
    sessions.sort_by_key(|session| std::cmp::Reverse(session.start));
    let mut j = Json::new();
    j.key("nowPlaying");
    j.begin_object();
    // playerId: the entry's place in the list, from 1
    let place = std::cell::Cell::new(0);
    j.array_ne("entry", &sessions, |j, session| {
        place.set(place.get() + 1);
        let mut position = session.position_ms;
        if session.state == "playing" {
            let elapsed = session.last_report.elapsed().as_millis() as i64;
            let estimated = position + (elapsed as f64 * session.playback_rate) as i64;
            position = estimated.min((session.song.duration as f32 * 1000.0) as i64);
        }
        j.begin_object();
        entities::song_members(j, &session.song, &scope.context);
        j.string("username", &session.username);
        // int32(time.Since(start).Minutes()): whole minutes
        let minutes = SystemTime::now().duration_since(session.start).map(|d| d.as_secs() / 60).unwrap_or(0);
        j.int("minutesAgo", minutes as i64);
        j.int("playerId", place.get());
        j.string_ne("playerName", &session.player_name);
        j.string("state", session.state);
        j.int("positionMs", position);
        j.float("playbackRate", session.playback_rate);
        j.end_object();
    });
    j.end_object();
    let out = j.finish();
    Ok(Reply::ok(out))
}
