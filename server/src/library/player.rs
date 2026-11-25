//! The player a request comes from. Navidrome registers one on every Subsonic request (`getPlayer` in
//! `server/subsonic/middlewares.go`, `core/players.go`): it finds the player by the `nd-player-…` cookie, else by
//! user, client name and the browser family it reads from `User-Agent`, else makes a new one; it writes the player's
//! address and last-seen time at most once a minute, and answers with the cookie. A player's settings change what a
//! song looks like: `ReportRealPath` (the `path`), a forced transcoding (`transcodedSuffix`).
//!
//! Until the methods that write a player's state move here too (the roadmap's phase 4), registering stays
//! Navidrome's: for a request answered here, the server sends Navidrome one `ping` as the signed-in user, with the
//! request's own client name, cookie, `User-Agent` and client address, and takes the cookie Navidrome answers with.
//! So the player is the one Navidrome would have found, made by Navidrome's own rules, and its row is written as
//! Navidrome writes it. The answer is remembered for a minute per client (the time Navidrome itself lets pass between
//! two writes of a player), and the player's row is read again for every request: its settings are never cached.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use bytes::Bytes;
use http_body_util::{BodyExt, Empty, Limited};
use hyper::header::{self, HeaderMap, HeaderName, HeaderValue};
use hyper::{Request, Uri};
use hyper_util::client::legacy::Client;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::rt::TokioExecutor;
use rusqlite::OptionalExtension;
use tracing::debug;

use crate::db::Db;

/// Navidrome's `consts.UpdatePlayerFrequency`: how often it writes a player it sees.
const REGISTER_EVERY: Duration = Duration::from_secs(60);

/// How many clients' players are remembered at most.
const REMEMBERED: usize = 4096;

/// A registered player, as far as the answers given here need it.
#[derive(Debug, Clone, PartialEq)]
pub struct Player {
    pub id: String,
    /// `ReportRealPath`.
    pub report_real_path: bool,
    /// The player has a transcoding set (`transcoding_id`): songs then carry `transcodedSuffix`.
    pub transcodes: bool,
    /// `MaxBitRate` (0: none): a stream above it is transcoded.
    pub max_bit_rate: i64,
    /// The `Set-Cookie` Navidrome answers this player's requests with.
    pub cookie: HeaderValue,
}

/// What a client is known by between two registrations.
#[derive(Hash, PartialEq, Eq, Clone)]
struct Key {
    user: Vec<u8>,
    client: Vec<u8>,
    user_agent: Vec<u8>,
    cookies: Vec<u8>,
}

struct Known {
    player_id: String,
    cookie: HeaderValue,
    at: Instant,
}

pub struct Players {
    db: Arc<Db>,
    client: Client<HttpConnector, Empty<Bytes>>,
    /// Navidrome's address and `BaseURL` path.
    upstream: Uri,
    base_path: String,
    /// The header Navidrome takes the user from, which only this server sets.
    user_header: HeaderName,
    known: Mutex<HashMap<Key, Known>>,
}

/// One request's side of a registration.
pub struct Registration<'a> {
    pub user_id: &'a str,
    /// The user's name as the gateway passes it to Navidrome (as the client typed it, or the account's for a key).
    pub user: &'a HeaderValue,
    /// The `c` and `v` parameters.
    pub client: &'a [u8],
    pub version: &'a [u8],
    /// The request's headers as they would go to Navidrome (the client's address decided, hop-by-hop ones gone).
    pub headers: &'a HeaderMap,
}

impl Players {
    pub fn new(db: Arc<Db>, upstream: Uri, base_path: &str, user_header: HeaderName) -> Players {
        let mut connector = HttpConnector::new();
        connector.set_nodelay(true);
        connector.set_connect_timeout(Some(Duration::from_secs(5)));
        let client = Client::builder(TokioExecutor::new()).pool_idle_timeout(Duration::from_secs(30)).build(connector);
        Players { db, client, upstream, base_path: base_path.trim_end_matches('/').to_string(), user_header, known: Mutex::new(HashMap::new()) }
    }

    /// The player of a request, registered by Navidrome. None: Navidrome did not answer with a player (it could not
    /// register one, or the user is gone); the request is then Navidrome's to answer.
    pub async fn register(&self, registration: Registration<'_>) -> Option<Player> {
        let key = Key {
            user: registration.user.as_bytes().to_vec(),
            client: registration.client.to_vec(),
            user_agent: joined(registration.headers, &header::USER_AGENT),
            cookies: joined(registration.headers, &header::COOKIE),
        };
        let remembered = {
            let known = self.known.lock().expect("the players' lock");
            known.get(&key).filter(|k| k.at.elapsed() < REGISTER_EVERY).map(|k| (k.player_id.clone(), k.cookie.clone()))
        };
        if let Some((player_id, cookie)) = remembered {
            // still the player Navidrome would find: its row is there, for this user and client
            if let Some(player) = self.read(&player_id, &registration, cookie).await {
                return Some(player);
            }
        }
        let cookie = self.ask_navidrome(&registration).await?;
        let player_id = player_id_of(&cookie)?;
        let player = self.read(&player_id, &registration, cookie.clone()).await?;
        let mut known = self.known.lock().expect("the players' lock");
        if known.len() >= REMEMBERED {
            known.retain(|_, k| k.at.elapsed() < REGISTER_EVERY);
            if known.len() >= REMEMBERED {
                known.clear();
            }
        }
        known.insert(key, Known { player_id, cookie, at: Instant::now() });
        Some(player)
    }

    /// The player's row, when it is this user's and this client's.
    async fn read(&self, player_id: &str, registration: &Registration<'_>, cookie: HeaderValue) -> Option<Player> {
        let (id, user_id, client) = (player_id.to_string(), registration.user_id.to_string(), registration.client.to_vec());
        let row = self
            .db
            .read(move |conn| {
                conn.query_row(
                    "SELECT client, user_id, report_real_path, coalesce(transcoding_id, ''), coalesce(max_bit_rate, 0) FROM player WHERE id = ?1",
                    [&id],
                    |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, bool>(2)?, r.get::<_, String>(3)?, r.get::<_, i64>(4)?)),
                )
                .optional()
            })
            .await
            .ok()??;
        let (row_client, row_user, report_real_path, transcoding, max_bit_rate) = row;
        if row_client.as_bytes() != client || row_user != user_id {
            return None;
        }
        Some(Player { id: player_id.to_string(), report_real_path, transcodes: !transcoding.is_empty(), max_bit_rate, cookie })
    }

    /// One `ping` to Navidrome as this request's user and client: the `Set-Cookie` of the player it registered.
    async fn ask_navidrome(&self, registration: &Registration<'_>) -> Option<HeaderValue> {
        let authority = self.upstream.authority()?;
        let target =
            format!("http://{authority}{}/rest/ping?v={}&c={}&f=json", self.base_path, query_escape(registration.version), query_escape(registration.client));
        let mut request = Request::get(&target).body(Empty::new()).ok()?;
        let headers = request.headers_mut();
        // what Navidrome reads to find the player: the cookie, the User-Agent, the client's address
        for name in [header::COOKIE, header::USER_AGENT, header::HOST, HeaderName::from_static("x-real-ip"), HeaderName::from_static("x-forwarded-for")] {
            for value in registration.headers.get_all(&name) {
                headers.append(name.clone(), value.clone());
            }
        }
        headers.insert(self.user_header.clone(), registration.user.clone());
        let response = match tokio::time::timeout(Duration::from_secs(10), self.client.request(request)).await {
            Ok(Ok(response)) => response,
            Ok(Err(e)) => {
                debug!(error = %e, "Navidrome did not register a player");
                return None;
            }
            Err(_) => return None,
        };
        let cookie = response.headers().get_all(header::SET_COOKIE).iter().find(|value| value.as_bytes().starts_with(b"nd-player-")).cloned();
        // the answer itself is not needed; reading it lets the connection be used again
        let _ = Limited::new(response.into_body(), 1 << 16).collect().await;
        cookie
    }
}

/// A header's values, joined: part of what a client is remembered by.
fn joined(headers: &HeaderMap, name: &HeaderName) -> Vec<u8> {
    let mut out = Vec::new();
    for value in headers.get_all(name) {
        out.extend_from_slice(value.as_bytes());
        out.push(0);
    }
    out
}

/// The player's id in Navidrome's cookie: `nd-player-<hex of the user name>=<id>; Path=/; …`.
fn player_id_of(cookie: &HeaderValue) -> Option<String> {
    let text = cookie.to_str().ok()?;
    let pair = text.split(';').next()?;
    let (_, id) = pair.split_once('=')?;
    let id = id.trim().trim_matches('"');
    (!id.is_empty()).then(|| id.to_string())
}

/// Go's `url.QueryEscape`.
fn query_escape(text: &[u8]) -> String {
    let mut out = String::with_capacity(text.len());
    for &byte in text {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(byte as char),
            b' ' => out.push('+'),
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_player_is_read_from_navidromes_cookie() {
        let cookie = HeaderValue::from_static("nd-player-6c697374656e6572=2JhoQ7ATSKRNJipggJXN7i; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict");
        assert_eq!(player_id_of(&cookie).as_deref(), Some("2JhoQ7ATSKRNJipggJXN7i"));
        assert_eq!(player_id_of(&HeaderValue::from_static("nd-player-00=; Path=/")), None);
        assert_eq!(player_id_of(&HeaderValue::from_static("nonsense")), None);
    }

    #[test]
    fn parameters_are_escaped_as_go_escapes_them() {
        assert_eq!(query_escape(b"Sonus Windows/0.2.0"), "Sonus+Windows%2F0.2.0");
        assert_eq!(query_escape("林".as_bytes()), "%E6%9E%97");
        assert_eq!(query_escape(b"a&c=b#~_-."), "a%26c%3Db%23~_-.");
    }
}
