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
//! JSON; `player.rs` the player a request comes from; `stream.rs` a song's file (phase 5).

pub mod browse;
pub mod catalog;
pub mod disc;
pub mod entities;
pub mod filecache;
pub mod json;
pub mod lists;
pub mod media;
pub mod natural;
pub mod player;
pub mod playing;
pub mod query;
pub mod resize;
pub mod search;
pub mod stream;
pub mod transcode;
pub mod transcoder;
pub mod writes;

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
    // phase 4: writes (writes.rs)
    "star",
    "unstar",
    "setRating",
    "savePlayQueue",
    "createPlaylist",
    "updatePlaylist",
    "deletePlaylist",
    // phase 4, part 3: plays and now playing (playing.rs)
    "scrobble",
    "getNowPlaying",
    "reportPlayback",
    // phase 5: media (stream.rs)
    "stream",
];

/// The methods whose answer is the media itself, whatever format the request names: an error is rendered in that
/// format, so one asked for in another than JSON is Navidrome's.
const MEDIA: &[&str] = &["getCoverArt", "stream"];

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
    /// What is playing now (`scrobble` without `submission`, `getNowPlaying`): kept here, as Navidrome kept it in
    /// its memory.
    now_playing: Arc<playing::NowPlaying>,
    transcoder: Arc<transcoder::Transcoder>,
    /// Covers resized here, and how many are resized at once.
    images: Option<Arc<filecache::Cache>>,
    resizing: Arc<tokio::sync::Semaphore>,
    /// How many requests were answered here, and how many went on to Navidrome.
    answered: AtomicU64,
    passed: AtomicU64,
}

/// A signed-in request to one of the library's methods.
pub struct Request<'a> {
    pub method: &'static str,
    /// The HTTP method (`GET`, `HEAD`, `POST`…).
    pub http_method: &'a str,
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
    /// A song's file, or part of it, with the status and headers Go's `ServeContent` gives it (stream.rs).
    Media(stream::Media),
    /// A transcode to run (stream.rs, transcoder.rs).
    Transcode(Box<stream::Pending>),
    /// A cover to resize (media.rs, resize.rs).
    Resize(Box<media::PendingResize>),
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
    /// What is playing now, and the client this request's session is kept for.
    pub now_playing: &'a playing::NowPlaying,
    pub client_id: &'a str,
    /// The player Navidrome registered for the request (empty: none).
    pub player_id: &'a str,
    pub player: Option<&'a Player>,
    /// The HTTP method, and the request's headers as they would go on to Navidrome (a stream's `Range`, `If-…`).
    pub http_method: &'a str,
    pub headers: &'a HeaderMap,
    /// ffmpeg, its caps and the transcoding cache.
    pub transcoder: &'a transcoder::Transcoder,
    /// The cache of covers resized here (none: `ImageCacheSize` is 0).
    pub images: Option<&'a filecache::Cache>,
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
        let transcoder = Arc::new(transcoder::Transcoder::new(transcoder_settings(&setup.options)));
        let images = images_cache(&setup.options);
        Library {
            players: Players::new(setup.db.clone(), setup.upstream, &setup.base_path, setup.user_header),
            db: setup.db,
            options: Arc::new(setup.options),
            envelope: setup.envelope,
            frame_options: HeaderValue::from_str(&setup.frame_options).unwrap_or(HeaderValue::from_static("DENY")),
            seeds: Arc::new(Mutex::new(HashMap::new())),
            now_playing: Arc::new(playing::NowPlaying::default()),
            transcoder,
            images,
            resizing: Arc::new(tokio::sync::Semaphore::new(RESIZES)),
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
        let Request { method, http_method, params, user, user_header, headers } = *request;
        if !answers(method) {
            return Err("not a method answered here");
        }
        // a cover is a picture whatever format the request names, and Navidrome registers no player for it
        let cover = method == "getCoverArt";
        let writing = writes::METHODS.contains(&method);
        let json = Format::of(params.get("f"), params.get("callback")) == Format::Json;
        if !MEDIA.contains(&method) && !json {
            return Err("not JSON");
        }
        let Ok(client) = std::str::from_utf8(params.get("c")) else { return Err("a client name that is not text") };
        let player = if cover {
            None
        } else {
            // Navidrome registers the player before the method runs (getPlayer), and answers with its cookie
            let registration = Registration { user_id: &user.user_id, user: user_header, client: params.get("c"), version: params.get("v"), headers };
            let Some(player) = self.players.register(registration).await else { return Err("Navidrome registered no player") };
            // (a write's answer holds no song: the player's transcoding and real paths do not matter to it; a stream
            // looks at the player's settings itself)
            let media = MEDIA.contains(&method);
            if player.transcodes && !writing && !media {
                return Err("the player has a transcoding set");
            }
            if player.report_real_path && !entities::REAL_PATHS && !writing && !media {
                return Err("the player reports real paths, which Go builds by this system's rules");
            }
            Some(player)
        };
        let report_real_path = player.as_ref().is_some_and(|player| player.report_real_path);
        let if_none_match = headers.get(header::IF_NONE_MATCH).and_then(|value| value.to_str().ok()).map(str::to_string);

        // the client a session is kept for: the web UI's unique id (header, else its cookie), else the player
        let client_id = headers
            .get("x-nd-client-unique-id")
            .and_then(|value| value.to_str().ok())
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .or_else(|| cookie(headers, "X-ND-Client-Unique-Id"))
            .or_else(|| player.as_ref().map(|player| player.id.clone()))
            .unwrap_or_default();
        let player_id = player.as_ref().map(|player| player.id.clone()).unwrap_or_default();
        let (db, options, seeds, now_playing, transcoder, images) =
            (self.db.clone(), self.options.clone(), self.seeds.clone(), self.now_playing.clone(), self.transcoder.clone(), self.images.clone());
        let (user_id, client, params) = (user.user_id.clone(), client.to_string(), params.clone());
        let (http_method_owned, request_headers, player_owned) = (http_method.to_string(), headers.clone(), player.clone());
        let reply = tokio::task::spawn_blocking(move || {
            let run = |conn: &rusqlite::Connection| {
                let Some(viewer) = Viewer::load(conn, &user_id)? else { return Ok(Ok(Reply::Navidrome("the user is gone"))) };
                let scope = Scope {
                    conn,
                    viewer: &viewer,
                    options: &options,
                    params: &params,
                    context: entities::Context { options: &options, client: &client, report_real_path },
                    seeds: &seeds,
                    if_none_match: if_none_match.as_deref(),
                    now_playing: &now_playing,
                    client_id: &client_id,
                    player_id: &player_id,
                    player: player_owned.as_ref(),
                    http_method: &http_method_owned,
                    headers: &request_headers,
                    transcoder: &transcoder,
                    images: images.as_deref(),
                };
                Ok(browse::answer(method, &scope))
            };
            // a write: one BEGIN IMMEDIATE transaction, committed when the method answers (an error answer has
            // written nothing), rolled back when it fails
            if writing {
                // kept when the method answered (an error answer has written nothing either way); a failure or a
                // request left to Navidrome is rolled back, and Navidrome then does the whole write itself
                db.write_blocking_if(|tx| run(tx), |reply| matches!(reply, Ok(r) if !matches!(r, Reply::Navidrome(_))))
            } else {
                db.read_blocking(run)
            }
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
            Reply::Error { .. } if !json => Err("an error answer in a format other than JSON"),
            Reply::Media(media) => Ok(self.media(media, headers, player.as_ref())),
            Reply::Transcode(pending) => self.transcode(*pending, headers, player.as_ref(), json).await,
            Reply::Resize(pending) => self.resize(*pending, headers).await,
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

/// Go's `bufferBeforeChunkingSize`: an answer that ends within it goes out with its length.
const GO_UNCHUNKED: usize = 2048;

/// How much of a song's file is read at a time.
const CHUNK: u64 = 64 << 10;

/// The transcoder's settings from Navidrome's: ffmpeg where Navidrome would find it, the cache in a folder of this
/// server's own beside Navidrome's caches.
fn transcoder_settings(options: &LibraryOptions) -> transcoder::Settings {
    let program = if options.ffmpeg_path.trim().is_empty() { "ffmpeg" } else { options.ffmpeg_path.trim() };
    let caches = if options.cache_folder.is_empty() { std::path::Path::new(&options.data_folder).join("cache") } else { options.cache_folder.clone().into() };
    transcoder::Settings {
        ffmpeg: transcoder::find_program(program),
        cache: transcoder::cache_size(&options.transcoding_cache_size).map(|size| (caches.join("sonus-transcoding"), size)),
        max_concurrent: options.transcode_max_concurrent.max(0) as usize,
        max_per_user: options.transcode_max_per_user.max(0) as usize,
        enable_cancellation: options.transcode_enable_cancellation,
    }
}

/// How many covers are resized at once: each decode may take up to `resize::MAX_PIXELS` × 4 bytes.
const RESIZES: usize = 2;

/// How long a resize waits for its turn (Navidrome gives `getCoverArt` 10 s) before it is left to Navidrome.
const RESIZE_WAIT: std::time::Duration = std::time::Duration::from_secs(10);

/// The cache of covers resized here: `<CacheFolder>/sonus-images`, `ImageCacheSize` (Navidrome's; `0`: none).
fn images_cache(options: &LibraryOptions) -> Option<Arc<filecache::Cache>> {
    let caches = if options.cache_folder.is_empty() { std::path::Path::new(&options.data_folder).join("cache") } else { options.cache_folder.clone().into() };
    transcoder::cache_size(&options.image_cache_size).map(|size| Arc::new(filecache::Cache::new(caches.join("sonus-images"), size)))
}

/// A running transcode's output, as it comes.
fn transcode_body(held: Vec<u8>, output: tokio::sync::mpsc::Receiver<transcoder::Chunk>) -> Body {
    use futures_util::StreamExt;
    let first = (!held.is_empty()).then(|| Ok::<_, std::io::Error>(Bytes::from(held)));
    let rest = futures_util::stream::unfold(output, |mut output| async move { Some((output.recv().await?, output)) });
    let chunks =
        StreamExt::map(futures_util::stream::iter(first).chain(rest), |chunk| chunk.map(hyper::body::Frame::data).map_err(crate::gateway::BoxError::from));
    BodyExt::boxed(http_body_util::StreamBody::new(chunks))
}

/// The bytes of an open file, `length` of them from where it stands, read as they are sent.
fn file_body(file: std::fs::File, length: u64) -> Body {
    use tokio::io::AsyncReadExt;
    let file = tokio::fs::File::from_std(file);
    let chunks = futures_util::stream::unfold((file, length), |(mut file, left)| async move {
        if left == 0 {
            return None;
        }
        let mut buf = vec![0u8; left.min(CHUNK) as usize];
        match file.read(&mut buf).await {
            Ok(0) => Some((Err(std::io::Error::from(std::io::ErrorKind::UnexpectedEof).into()), (file, 0))),
            Ok(read) => {
                buf.truncate(read);
                Some((Ok(hyper::body::Frame::data(Bytes::from(buf))), (file, left - read as u64)))
            }
            // the answer has begun: ending it short is the only way left to say so, as Go does
            Err(e) => Some((Err(crate::gateway::BoxError::from(e)), (file, 0))),
        }
    });
    http_body_util::StreamBody::new(chunks).boxed()
}

impl Library {
    /// A cover resized here (`resizedItem.Reader`): the new bytes, or the original's where Navidrome keeps it as it
    /// is, kept in the cache under the representation's key either way, sent with the picture's headers.
    async fn resize(&self, pending: media::PendingResize, request: &HeaderMap) -> Result<Response<Body>, &'static str> {
        let Ok(Ok(permit)) = tokio::time::timeout(RESIZE_WAIT, self.resizing.clone().acquire_owned()).await else {
            return Err("every resize is busy for too long: Navidrome's");
        };
        let media::PendingResize { original, size, square, quality, key, headers } = pending;
        let made = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            match resize::resize(&original, size, square, quality) {
                resize::Resized::Bytes(bytes) => Ok(bytes),
                resize::Resized::Original => Ok(original),
                resize::Resized::Navidromes(why) => Err(why),
            }
        })
        .await
        .map_err(|_| "the resize did not finish")??;
        let Some(content_type) = media::sniff_picture(&made) else { return Err("a picture of a kind Go would name") };
        if let Some(cache) = &self.images {
            if let Some(mut entry) = cache.clone().begin(&key) {
                if entry.write(&made).await {
                    entry.finish().await;
                }
            }
        }
        Ok(self.picture(StatusCode::OK, Some(content_type), made, request, headers))
    }

    /// A transcode as Navidrome sends one it has not cached (`Stream.Serve`, not seekable): as it comes, without
    /// ranges; over a cap, Navidrome's 429; ffmpeg failing before its first byte, Navidrome's to answer.
    async fn transcode(&self, pending: stream::Pending, request: &HeaderMap, player: Option<&Player>, json: bool) -> Result<Response<Body>, &'static str> {
        let output = match self.transcoder.start(pending.job).await {
            Ok(output) => output,
            Err(transcoder::Refused::Busy) if json => {
                let message = "too many concurrent transcodes, please retry shortly";
                let (content_type, body) = respond::render(&self.envelope, &Format::Json, &Payload::Error { code: 0, message });
                let retry = vec![(header::RETRY_AFTER, HeaderValue::from_static("5"))];
                let mut response = self.response(content_type, body, request, player, retry);
                *response.status_mut() = StatusCode::TOO_MANY_REQUESTS;
                return Ok(response);
            }
            Err(transcoder::Refused::Busy) => return Err("too many transcodes, answered in a format other than JSON"),
            Err(transcoder::Refused::Failed) => return Err("ffmpeg failed before its first byte: Navidrome's error"),
        };
        let mut headers = vec![
            (HeaderName::from_static("x-content-duration"), HeaderValue::from_str(&pending.duration).expect("digits")),
            (header::ACCEPT_RANGES, HeaderValue::from_static("none")),
            (header::CONTENT_TYPE, HeaderValue::from_static(pending.content_type)),
        ];
        if let Some(length) = pending.length {
            headers.push((header::CONTENT_LENGTH, HeaderValue::from(length)));
        }
        // a HEAD lets the transcode go on into the cache, as Navidrome drains it; nobody reads it here
        let body = if pending.head {
            drop(output);
            stream::MediaBody::Empty
        } else {
            // Go's server holds the first 2048 bytes of an answer (bufferBeforeChunkingSize): an output that ends
            // within them goes out with its length, a longer one in chunks
            let mut output = output;
            let mut held = Vec::new();
            let mut ended = false;
            while held.len() <= GO_UNCHUNKED {
                match output.recv().await {
                    Some(Ok(bytes)) => held.extend_from_slice(&bytes),
                    Some(Err(_)) => return Err("ffmpeg failed within the first bytes: Navidrome's error"),
                    None => {
                        ended = true;
                        break;
                    }
                }
            }
            if ended && pending.length.is_none() {
                headers.push((header::CONTENT_LENGTH, HeaderValue::from(held.len())));
                stream::MediaBody::Text(held)
            } else {
                stream::MediaBody::Held(held, output)
            }
        };
        Ok(self.media(stream::Media { status: StatusCode::OK, headers, body }, request, player))
    }

    /// A song's file as Navidrome sends it (stream.rs): its status and headers, Navidrome's usual ones, the player's
    /// cookie; never compressed.
    fn media(&self, media: stream::Media, request: &HeaderMap, player: Option<&Player>) -> Response<Body> {
        let body = match media.body {
            stream::MediaBody::Empty => Full::new(Bytes::new()).map_err(|never| match never {}).boxed(),
            stream::MediaBody::Text(text) => Full::new(Bytes::from(text)).map_err(|never| match never {}).boxed(),
            stream::MediaBody::File { file, length, .. } => file_body(file, length),
            stream::MediaBody::Transcode(output) => transcode_body(Vec::new(), output),
            stream::MediaBody::Held(held, output) => transcode_body(held, output),
        };
        let mut response = Response::new(body);
        *response.status_mut() = media.status;
        let h = response.headers_mut();
        respond::navidrome_headers(h, request, &self.frame_options);
        if let Some(player) = player {
            h.insert(header::SET_COOKIE, player.cookie.clone());
        }
        for (name, value) in media.headers {
            h.insert(name, value);
        }
        if cfg!(debug_assertions) {
            h.insert(ANSWERED_HEADER, HeaderValue::from_static("rust"));
        }
        response
    }

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
        } else if body.len() <= GO_UNCHUNKED {
            // a picture within Go's 2048-byte buffer goes out with its length, as Go's server sends it
            Full::new(Bytes::from(body)).map_err(|never| match never {}).boxed()
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

/// A request cookie's value (Go: `r.Cookie(name)`).
fn cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    headers.get_all(header::COOKIE).iter().filter_map(|value| value.to_str().ok()).flat_map(|value| value.split(';')).find_map(|pair| {
        let (key, value) = pair.trim().split_once('=')?;
        (key == name && !value.is_empty()).then(|| value.to_string())
    })
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
        assert!(answers("stream"));
        assert!(!answers("download"));
        for method in METHODS {
            assert!(crate::subsonic::protected_method(method).is_some(), "{method} is one of Navidrome's protected methods");
        }
    }
}
