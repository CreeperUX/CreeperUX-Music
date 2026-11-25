//! Ported from Navidrome (GPL-3.0), © the Navidrome authors.
//!
//! The player a request comes from, registered as Navidrome registers it on every Subsonic request (`getPlayer` in
//! `server/subsonic/middlewares.go`, `core/players.go`, `persistence/player_repository.go`): the player named by the
//! `nd-player-<hex of the user name>` cookie, when it is this user's and this client's; else the user's player for
//! this client and browser (the `User-Agent` as Navidrome names it: useragent.rs); else a new one. Its name, user
//! agent, address and last-seen time are written at most once a minute per player (Navidrome's
//! `UpdatePlayerFrequency`), every column as Navidrome's `Put` writes it, and the answer carries the cookie.
//!
//! A player's settings change what a song looks like and how it streams: `ReportRealPath`, a forced transcoding,
//! `MaxBitRate`. They are read from the row at every request.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use hyper::header::{self, HeaderMap, HeaderValue};
use rusqlite::{Connection, OptionalExtension};
use tracing::{debug, warn};

use crate::db::Db;
use crate::{gotime, id};

use super::useragent;

/// Navidrome's `consts.UpdatePlayerFrequency`: how often it writes a player it sees.
const REGISTER_EVERY: Duration = Duration::from_secs(60);

/// How many players' last writes are remembered at most.
const REMEMBERED: usize = 4096;

/// Navidrome's `consts.CookieExpiry`: a year.
const COOKIE_MAX_AGE: u64 = 365 * 24 * 3600;

/// A registered player, as far as the answers given here need it.
#[derive(Debug, Clone, PartialEq)]
pub struct Player {
    pub id: String,
    /// `ReportRealPath`.
    pub report_real_path: bool,
    /// The player has a transcoding set (`transcoding_id`): songs then carry `transcodedSuffix`.
    pub transcodes: bool,
    /// The transcoding it is set to (`transcoding_id`; empty: none).
    pub transcoding_id: String,
    /// `MaxBitRate` (0: none): a stream above it is transcoded.
    pub max_bit_rate: i64,
    /// The `Set-Cookie` the answer carries.
    pub cookie: HeaderValue,
}

pub struct Players {
    db: Arc<Db>,
    /// `BaseURL`'s path: the cookie's path.
    cookie_path: String,
    /// `Subsonic.DefaultReportRealPath`: a new player's setting.
    default_report_real_path: bool,
    /// When each player was last written here (`utils.Limiter`).
    written: Mutex<HashMap<String, Instant>>,
}

/// One request's side of a registration.
pub struct Registration<'a> {
    pub user_id: &'a str,
    /// The user's name as the request carries it (as the client typed it, or the account's for an API key: what the
    /// gateway names to Navidrome), which Navidrome names the cookie after (`request.UsernameFrom`).
    pub user_name: &'a [u8],
    /// The `c` parameter.
    pub client: &'a [u8],
    /// The request's headers as they would go to Navidrome (the client's address decided in `X-Real-IP`).
    pub headers: &'a HeaderMap,
}

/// A player's row (`model.Player`).
#[derive(Debug, Clone, PartialEq)]
struct Row {
    id: String,
    name: String,
    user_agent: String,
    user_id: String,
    client: String,
    ip: String,
    last_seen: Option<String>,
    max_bit_rate: i64,
    transcoding_id: Option<String>,
    report_real_path: bool,
    scrobble_enabled: bool,
}

const COLUMNS: &str = "player.id, player.name, coalesce(player.user_agent, ''), player.user_id, player.client, coalesce(player.ip, ''), \
                       player.last_seen, coalesce(player.max_bit_rate, 0), player.transcoding_id, player.report_real_path, \
                       coalesce(player.scrobble_enabled, 1)";

fn row(r: &rusqlite::Row) -> rusqlite::Result<Row> {
    Ok(Row {
        id: r.get(0)?,
        name: r.get(1)?,
        user_agent: r.get(2)?,
        user_id: r.get(3)?,
        client: r.get(4)?,
        ip: r.get(5)?,
        last_seen: r.get(6)?,
        max_bit_rate: r.get(7)?,
        transcoding_id: r.get(8)?,
        report_real_path: r.get(9)?,
        scrobble_enabled: r.get(10)?,
    })
}

/// A request cookie's value, as Go's `r.Cookie(name)` reads it (the first one of that name, quotes taken off).
fn cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    headers.get_all(header::COOKIE).iter().filter_map(|value| value.to_str().ok()).flat_map(|value| value.split(';')).find_map(|pair| {
        let (key, value) = pair.trim().split_once('=')?;
        (key.trim() == name).then(|| value.trim().trim_matches('"').to_string())
    })
}

/// `playerIDCookieName`: `nd-player-` and the user name in hexadecimal.
fn cookie_name(user_name: &[u8]) -> String {
    let hex: String = user_name.iter().map(|b| format!("{b:02x}")).collect();
    format!("nd-player-{hex}")
}

impl Players {
    pub fn new(db: Arc<Db>, base_path: &str, default_report_real_path: bool) -> Players {
        let cookie_path = if base_path.is_empty() { "/".to_string() } else { base_path.to_string() };
        Players { db, cookie_path, default_report_real_path, written: Mutex::new(HashMap::new()) }
    }

    /// Whether this player is due to be written (`limiter.Do`): at most once a minute, the first time at once.
    fn due(&self, player_id: &str) -> bool {
        let mut written = self.written.lock().expect("the players' lock");
        if written.get(player_id).is_some_and(|at| at.elapsed() < REGISTER_EVERY) {
            return false;
        }
        if written.len() >= REMEMBERED {
            written.retain(|_, at| at.elapsed() < REGISTER_EVERY);
        }
        written.insert(player_id.to_string(), Instant::now());
        true
    }

    /// `players.Register`: the request's player, written when due. None: Navidrome would register none (a client or
    /// user agent that is not text, a transcoding that is not there, or the database failed); the request is then
    /// Navidrome's to answer.
    pub async fn register(&self, registration: Registration<'_>) -> Option<Player> {
        let client = std::str::from_utf8(registration.client).ok()?.to_string();
        let user_agent = match registration.headers.get(header::USER_AGENT) {
            None => String::new(),
            Some(value) => useragent::canonical(value.to_str().ok()?),
        };
        // the client's address, as the gateway passes it to Navidrome (its realip middleware reads the same)
        let ip = registration.headers.get("x-real-ip").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
        let name = cookie_name(registration.user_name);
        let from_cookie = cookie(registration.headers, &name).filter(|id| !id.is_empty());
        let user_id = registration.user_id.to_string();
        let found = {
            let (client, user_agent, user_id) = (client.clone(), user_agent.clone(), user_id.clone());
            self.db.read(move |conn| find(conn, from_cookie.as_deref(), &user_id, &client, &user_agent)).await
        };
        let found = match found {
            Ok(found) => found,
            Err(e) => {
                warn!(error = %e, "a player could not be read: Navidrome registers it");
                return None;
            }
        };
        let mut player = match found {
            Some(player) => player,
            None => Row {
                id: id::new_random().ok()?,
                name: String::new(),
                user_agent: String::new(),
                user_id: user_id.clone(),
                client: client.clone(),
                ip: String::new(),
                last_seen: None,
                max_bit_rate: 0,
                transcoding_id: None,
                report_real_path: self.default_report_real_path,
                scrobble_enabled: true,
            },
        };
        player.name = format!("{client} [{user_agent}]");
        player.user_agent = user_agent;
        player.ip = ip;
        player.last_seen = Some(gotime::now_local());
        if self.due(&player.id) {
            let row = player.clone();
            if let Err(e) = self.db.write(move |tx| put(tx, &row)).await {
                // Navidrome logs and goes on: the player is the request's all the same
                warn!(error = %e, "a player could not be written");
            }
        }
        // a transcoding set must be there, or Navidrome registers no player at all
        let transcoding = player.transcoding_id.clone().unwrap_or_default();
        if !transcoding.is_empty() {
            let id = transcoding.clone();
            let there = self.db.read(move |conn| conn.query_row("SELECT 1 FROM transcoding WHERE id = ?1", [&id], |_| Ok(())).optional()).await;
            if !matches!(there, Ok(Some(()))) {
                debug!("a player's transcoding is not there: Navidrome's");
                return None;
            }
        }
        let cookie = format!("{name}={}; Path={}; Max-Age={COOKIE_MAX_AGE}; HttpOnly; SameSite=Strict", player.id, self.cookie_path);
        Some(Player {
            id: player.id,
            report_real_path: player.report_real_path,
            transcodes: !transcoding.is_empty(),
            transcoding_id: transcoding,
            max_bit_rate: player.max_bit_rate,
            cookie: HeaderValue::from_str(&cookie).ok()?,
        })
    }
}

/// The player named by the cookie when it is this user's and client's (`Get`), else the user's player for this
/// client and user agent (`FindMatch`).
fn find(conn: &Connection, from_cookie: Option<&str>, user_id: &str, client: &str, user_agent: &str) -> rusqlite::Result<Option<Row>> {
    let select = format!("SELECT {COLUMNS} FROM player JOIN user ON player.user_id = user.id");
    if let Some(id) = from_cookie {
        let named = conn.prepare_cached(&format!("{select} WHERE player.id = ?1"))?.query_row([id], row).optional()?;
        if let Some(player) = named.filter(|p| p.client == client && p.user_id == user_id) {
            return Ok(Some(player));
        }
    }
    conn.prepare_cached(&format!("{select} WHERE (client = ?1 AND user_agent = ?2 AND user_id = ?3)"))?.query_row((client, user_agent, user_id), row).optional()
}

/// `playerRepository.Put`: every column, the row updated or else inserted.
fn put(tx: &Connection, p: &Row) -> rusqlite::Result<()> {
    let args = rusqlite::params![
        p.id,
        p.name,
        p.user_agent,
        p.user_id,
        p.client,
        p.ip,
        p.last_seen,
        p.max_bit_rate,
        p.transcoding_id.clone().unwrap_or_default(),
        p.report_real_path,
        p.scrobble_enabled
    ];
    let updated = tx.execute(
        "UPDATE player SET name = ?2, user_agent = ?3, user_id = ?4, client = ?5, ip = ?6, last_seen = ?7, max_bit_rate = ?8, transcoding_id = ?9, \
         report_real_path = ?10, scrobble_enabled = ?11 WHERE id = ?1",
        args,
    )?;
    if updated == 0 {
        tx.execute(
            "INSERT INTO player (id, name, user_agent, user_id, client, ip, last_seen, max_bit_rate, transcoding_id, report_real_path, scrobble_enabled) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            args,
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_cookie_is_named_after_the_user() {
        assert_eq!(cookie_name(b"listener"), "nd-player-6c697374656e6572");
        assert_eq!(cookie_name("林".as_bytes()), "nd-player-e69e97");
        let mut headers = HeaderMap::new();
        headers.insert(header::COOKIE, HeaderValue::from_static("a=1; nd-player-6c697374656e6572=\"abc\"; nd-player-6c697374656e6572=second"));
        assert_eq!(cookie(&headers, "nd-player-6c697374656e6572").as_deref(), Some("abc"), "the first, unquoted");
        assert_eq!(cookie(&headers, "nd-player-00"), None);
    }
}
