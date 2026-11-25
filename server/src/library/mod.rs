//! The library's reads, answered here from Navidrome's database (`docs/server-roadmap.md`, phase 3): the Subsonic
//! methods Sonus clients read the library with, in JSON, as Navidrome answers them byte for byte. Navidrome still
//! owns the database and writes it (its scanner too), so everything is read at the time of the request.
//!
//! A request gets here signed in (subsonic/mod.rs). It is answered here only when the answer is known to be
//! Navidrome's own; anything else goes on to Navidrome, already signed in, as before:
//!
//! - a format other than JSON (`f=json`): XML and JSONP are Navidrome's (the roadmap's decision 1);
//! - a parameter Sonus clients do not send and that changes the answer (`musicFolderId`);
//! - a player with a forced transcoding, or with `ReportRealPath` where Go builds paths by other rules (Windows);
//! - a song whose content type Go would take from the operating system's tables;
//! - rows this server does not read as Go's decoders do, or any error reading the database.
//!
//! `browse.rs` has the methods; `query.rs` the queries; `entities.rs` the albums and songs as JSON; `json.rs` Go's
//! JSON; `player.rs` the player a request comes from.

pub mod browse;
pub mod catalog;
pub mod entities;
pub mod json;
pub mod lists;
pub mod media;
pub mod natural;
pub mod player;
pub mod query;
pub mod search;

use std::collections::HashMap;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::io::Write;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::header::{self, HeaderMap, HeaderName, HeaderValue};
use hyper::{Response, StatusCode, Uri};
use tracing::{debug, warn};

use crate::config::LibraryOptions;
use crate::db::Db;
use crate::gateway::Body;
use crate::subsonic::SignedIn;
use crate::subsonic::params::Params;
use crate::subsonic::respond::{self, Envelope, Format, Payload};
use player::{Player, Players, Registration};
use query::{QueryError, Viewer};

/// The methods answered here (each also as `<name>.view`). Everything else is Navidrome's.
pub const METHODS: &[&str] = &[
    "ping",
    "getSong",
    "getAlbum",
    "getAlbumList2",
    "search3",
    "getStarred2",
    "getPlaylists",
    "getPlaylist",
    "getPlayQueue",
    "getLyricsBySongId",
    "getCoverArt",
];

/// Whether a method is one of the library's.
pub fn answers(method: &str) -> bool {
    METHODS.contains(&method)
}

/// A response header that says this server answered, in debug builds only (the tests read it): a release build's
/// answers carry Navidrome's headers and nothing else.
pub const ANSWERED_HEADER: &str = "x-sonus-answered";

pub struct Setup {
    pub db: Arc<Db>,
    pub options: LibraryOptions,
    /// How Navidrome starts its Subsonic answers.
    pub envelope: Envelope,
    /// `HTTPHeaders.FrameOptions`.
    pub frame_options: String,
    /// Navidrome's address, `BaseURL`'s path, and the header it takes the user from.
    pub upstream: Uri,
    pub base_path: String,
    pub user_header: HeaderName,
}

pub struct Library {
    db: Arc<Db>,
    options: Arc<LibraryOptions>,
    envelope: Envelope,
    frame_options: HeaderValue,
    players: Players,
    /// The seeds of the random lists, per table and user: Navidrome keeps the same in its memory (`utils/hasher`), so
    /// that a random list's pages belong together until its first page is asked for again.
    seeds: Arc<Mutex<HashMap<String, u64>>>,
    /// How many requests were answered here, and how many went on to Navidrome.
    answered: AtomicU64,
    passed: AtomicU64,
}

/// A signed-in request to one of the library's methods.
pub struct Request<'a> {
    pub method: &'static str,
    /// The query's parameters, and the form's.
    pub params: &'a Params,
    pub user: &'a SignedIn,
    /// The user as the gateway names them to Navidrome.
    pub user_header: &'a HeaderValue,
    /// The request's headers as they would go on to Navidrome.
    pub headers: &'a HeaderMap,
}

pub enum Answer {
    Here(Response<Body>),
    /// Navidrome's to answer, and why.
    Navidrome(&'static str),
}

/// What a method's handler found (browse.rs).
pub enum Reply {
    /// The answer's members after the envelope's own (`"song":{…}`), and headers beside Navidrome's usual ones.
    Ok {
        members: String,
        headers: Vec<(HeaderName, HeaderValue)>,
    },
    /// A Subsonic error, in Navidrome's words.
    Error {
        code: i32,
        message: String,
    },
    /// Something that is not JSON (a picture), with its content type and the headers Navidrome gives it.
    Bytes {
        content_type: &'static str,
        body: Vec<u8>,
        headers: Vec<(HeaderName, HeaderValue)>,
    },
    /// The client has it already (`If-None-Match`): 304, with the headers that say what it has.
    NotModified {
        headers: Vec<(HeaderName, HeaderValue)>,
    },
    Navidrome(&'static str),
}

impl Reply {
    pub fn ok(members: String) -> Reply {
        Reply::Ok { members, headers: Vec::new() }
    }

    pub fn error(code: i32, message: impl Into<String>) -> Reply {
        Reply::Error { code, message: message.into() }
    }
}

// Subsonic's error codes used here (the others are in subsonic/respond.rs)
pub const NOT_FOUND: i32 = 70;

/// What a handler works with: the connection, who asks, and how answers look for them.
pub struct Scope<'a> {
    pub conn: &'a rusqlite::Connection,
    pub viewer: &'a Viewer,
    pub options: &'a LibraryOptions,
    pub params: &'a Params,
    pub context: entities::Context<'a>,
    pub seeds: &'a Mutex<HashMap<String, u64>>,
    /// The request's `If-None-Match`, for what is answered with a validator.
    pub if_none_match: Option<&'a str>,
}

impl Scope<'_> {
    /// The seed of a table's random order for this user: a new one when the list starts over (`resetSeededRandom`).
    pub fn random_seed(&self, table: &str, start_over: bool) -> u64 {
        let key = format!("{table}|{}", self.viewer.id);
        let mut seeds = self.seeds.lock().expect("the seeds' lock");
        if start_over || !seeds.contains_key(&key) {
            let mut bytes = [0u8; 8];
            // without the system's random numbers the clock still gives another order every time
            if getrandom::fill(&mut bytes).is_err() {
                bytes = (std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(0)).to_le_bytes();
            }
            seeds.insert(key.clone(), u64::from_le_bytes(bytes));
        }
        seeds[&key]
    }
}

/// Navidrome's `SEEDEDRAND`: a number per id that changes with the seed, to order by.
pub fn seeded_order(seed: u64, id: &str) -> u64 {
    let mut hasher = DefaultHasher::new();
    seed.hash(&mut hasher);
    id.hash(&mut hasher);
    hasher.finish()
}

impl Library {
    pub fn new(setup: Setup) -> Library {
        Library {
            players: Players::new(setup.db.clone(), setup.upstream, &setup.base_path, setup.user_header),
            db: setup.db,
            options: Arc::new(setup.options),
            envelope: setup.envelope,
            frame_options: HeaderValue::from_str(&setup.frame_options).unwrap_or(HeaderValue::from_static("DENY")),
            seeds: Arc::new(Mutex::new(HashMap::new())),
            answered: AtomicU64::new(0),
            passed: AtomicU64::new(0),
        }
    }

    /// How many requests were answered here, and how many of the library's methods went on to Navidrome.
    pub fn counts(&self) -> (u64, u64) {
        (self.answered.load(Ordering::Relaxed), self.passed.load(Ordering::Relaxed))
    }

    /// Answers a signed-in request to one of `METHODS`, or says why it is Navidrome's.
    pub async fn handle(&self, request: Request<'_>) -> Answer {
        let method = request.method;
        match self.answer(&request).await {
            Ok(response) => {
                self.answered.fetch_add(1, Ordering::Relaxed);
                Answer::Here(response)
            }
            Err(why) => {
                self.passed.fetch_add(1, Ordering::Relaxed);
                debug!(method, why, "the library leaves a request to Navidrome");
                Answer::Navidrome(why)
            }
        }
    }

    async fn answer(&self, request: &Request<'_>) -> Result<Response<Body>, &'static str> {
        let Request { method, params, user, user_header, headers } = *request;
        if !answers(method) {
            return Err("not a method answered here");
        }
        // a cover is a picture whatever format the request names, and Navidrome registers no player for it
        let cover = method == "getCoverArt";
        if !cover && Format::of(params.get("f"), params.get("callback")) != Format::Json {
            return Err("not JSON");
        }
        let Ok(client) = std::str::from_utf8(params.get("c")) else { return Err("a client name that is not text") };
        let player = if cover {
            None
        } else {
            // Navidrome registers the player before the method runs (getPlayer), and answers with its cookie
            let registration = Registration { user_id: &user.user_id, user: user_header, client: params.get("c"), version: params.get("v"), headers };
            let Some(player) = self.players.register(registration).await else { return Err("Navidrome registered no player") };
            if player.transcodes {
                return Err("the player has a transcoding set");
            }
            if player.report_real_path && !entities::REAL_PATHS {
                return Err("the player reports real paths, which Go builds by this system's rules");
            }
            Some(player)
        };
        let report_real_path = player.as_ref().is_some_and(|player| player.report_real_path);
        let if_none_match = headers.get(header::IF_NONE_MATCH).and_then(|value| value.to_str().ok()).map(str::to_string);

        let (db, options, seeds) = (self.db.clone(), self.options.clone(), self.seeds.clone());
        let (user_id, client, params) = (user.user_id.clone(), client.to_string(), params.clone());
        let reply = tokio::task::spawn_blocking(move || {
            db.read_blocking(|conn| {
                let Some(viewer) = Viewer::load(conn, &user_id)? else { return Ok(Ok(Reply::Navidrome("the user is gone"))) };
                let scope = Scope {
                    conn,
                    viewer: &viewer,
                    options: &options,
                    params: &params,
                    context: entities::Context { options: &options, client: &client, report_real_path },
                    seeds: &seeds,
                    if_none_match: if_none_match.as_deref(),
                };
                Ok(browse::answer(method, &scope))
            })
        })
        .await;
        let reply = match reply {
            Ok(Ok(Ok(reply))) => reply,
            Ok(Ok(Err(QueryError::Unreadable(what)))) => {
                warn!(method, what, "the library cannot read a row as Navidrome does: Navidrome answers");
                return Err("a row this server does not read as Navidrome does");
            }
            Ok(Ok(Err(QueryError::Sqlite(e)))) => {
                warn!(method, error = %e, "the library could not read the database: Navidrome answers");
                return Err("the database could not be read");
            }
            Ok(Err(e)) => {
                warn!(method, error = %e, "the library could not read the database: Navidrome answers");
                return Err("the database could not be read");
            }
            Err(_) => return Err("the database task did not finish"),
        };
        match reply {
            Reply::Navidrome(why) => Err(why),
            Reply::Error { code, message } => {
                let (content_type, body) = respond::render(&self.envelope, &Format::Json, &Payload::Error { code, message: &message });
                Ok(self.response(content_type, body, headers, player.as_ref(), Vec::new()))
            }
            Reply::Ok { members, headers: extra } => Ok(self.response("application/json", self.envelop(&members), headers, player.as_ref(), extra)),
            Reply::Bytes { content_type, body, headers: extra } => Ok(self.picture(StatusCode::OK, Some(content_type), body, headers, extra)),
            Reply::NotModified { headers: extra } => Ok(self.picture(StatusCode::NOT_MODIFIED, None, Vec::new(), headers, extra)),
        }
    }

    /// A successful answer: Navidrome's envelope around the method's members.
    fn envelop(&self, members: &str) -> Vec<u8> {
        let e = &self.envelope;
        let mut out = String::with_capacity(members.len() + 160);
        out.push_str("{\"subsonic-response\":{\"status\":\"ok\",\"version\":");
        json::string(&mut out, &e.version);
        out.push_str(",\"type\":");
        json::string(&mut out, &e.kind);
        out.push_str(",\"serverVersion\":");
        json::string(&mut out, &e.server_version);
        if e.open_subsonic {
            out.push_str(",\"openSubsonic\":true");
        }
        if !members.is_empty() {
            out.push(',');
            out.push_str(members);
        }
        out.push_str("}}");
        out.into_bytes()
    }

    /// The answer as Navidrome sends it: its usual headers, the player's cookie, and compressed when the client
    /// takes gzip (Navidrome compresses every JSON answer).
    fn response(
        &self,
        content_type: &'static str,
        body: Vec<u8>,
        request: &HeaderMap,
        player: Option<&Player>,
        extra: Vec<(HeaderName, HeaderValue)>,
    ) -> Response<Body> {
        let gzip = accepts_gzip(request);
        let body = if gzip { compress(&body).unwrap_or(body) } else { body };
        let mut response = Response::new(Full::new(Bytes::from(body)).map_err(|never| match never {}).boxed());
        let h = response.headers_mut();
        h.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
        respond::navidrome_headers(h, request, &self.frame_options);
        if gzip {
            h.insert(header::CONTENT_ENCODING, HeaderValue::from_static("gzip"));
            h.append(header::VARY, HeaderValue::from_static("Accept-Encoding"));
        }
        if let Some(player) = player {
            h.insert(header::SET_COOKIE, player.cookie.clone());
        }
        for (name, value) in extra {
            h.insert(name, value);
        }
        if cfg!(debug_assertions) {
            h.insert(ANSWERED_HEADER, HeaderValue::from_static("rust"));
        }
        response
    }
}

impl Library {
    /// A picture as Navidrome sends it: never compressed, and without a length (Navidrome streams it: the body
    /// is chunked), with Navidrome's usual headers and the picture's own.
    fn picture(
        &self,
        status: StatusCode,
        content_type: Option<&'static str>,
        body: Vec<u8>,
        request: &HeaderMap,
        extra: Vec<(HeaderName, HeaderValue)>,
    ) -> Response<Body> {
        let body: Body = if status == StatusCode::NOT_MODIFIED {
            Full::new(Bytes::new()).map_err(|never| match never {}).boxed()
        } else {
            // a stream of one piece has no length to declare
            let piece = futures_util::stream::once(async move { Ok::<_, crate::gateway::BoxError>(hyper::body::Frame::data(Bytes::from(body))) });
            http_body_util::StreamBody::new(piece).boxed()
        };
        let mut response = Response::new(body);
        *response.status_mut() = status;
        let h = response.headers_mut();
        if let Some(content_type) = content_type {
            h.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
        }
        respond::navidrome_headers(h, request, &self.frame_options);
        for (name, value) in extra {
            h.insert(name, value);
        }
        if cfg!(debug_assertions) {
            h.insert(ANSWERED_HEADER, HeaderValue::from_static("rust"));
        }
        response
    }
}

/// Whether the client takes gzip, as Navidrome's compression middleware (chi's) reads `Accept-Encoding`: any entry
/// naming gzip, whatever its weight.
fn accepts_gzip(request: &HeaderMap) -> bool {
    request.get_all(header::ACCEPT_ENCODING).iter().filter_map(|v| v.to_str().ok()).flat_map(|v| v.split(',')).any(|entry| entry.contains("gzip"))
}

/// gzip at level 5, Navidrome's.
fn compress(body: &[u8]) -> Option<Vec<u8>> {
    let mut encoder = flate2::write::GzEncoder::new(Vec::with_capacity(body.len() / 4 + 64), flate2::Compression::new(5));
    encoder.write_all(body).ok()?;
    encoder.finish().ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn gzip_is_used_when_the_client_takes_it() {
        let mut headers = HeaderMap::new();
        assert!(!accepts_gzip(&headers));
        headers.insert(header::ACCEPT_ENCODING, HeaderValue::from_static("identity"));
        assert!(!accepts_gzip(&headers));
        headers.insert(header::ACCEPT_ENCODING, HeaderValue::from_static("br, gzip;q=0.5, deflate"));
        assert!(accepts_gzip(&headers));
        let body = br#"{"subsonic-response":{"status":"ok"}}"#.repeat(40);
        let packed = compress(&body).unwrap();
        assert!(packed.len() < body.len() / 4);
        let mut unpacked = Vec::new();
        flate2::read::GzDecoder::new(&packed[..]).read_to_end(&mut unpacked).unwrap();
        assert_eq!(unpacked, body);
    }

    #[test]
    fn a_seeded_order_changes_with_the_seed_only() {
        assert_eq!(seeded_order(1, "a"), seeded_order(1, "a"));
        assert_ne!(seeded_order(1, "a"), seeded_order(2, "a"));
        assert_ne!(seeded_order(1, "a"), seeded_order(1, "b"));
    }

    #[test]
    fn only_the_listed_methods_are_answered_here() {
        assert!(answers("ping"));
        assert!(answers("getAlbumList2"));
        assert!(!answers("getAlbumList"));
        assert!(!answers("stream"));
        for method in METHODS {
            assert!(crate::subsonic::protected_method(method).is_some(), "{method} is one of Navidrome's protected methods");
        }
    }
}
