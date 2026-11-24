//! Subsonic authentication at the gateway (`docs/server-roadmap.md`, phase 2). A request to a Subsonic method that
//! needs a sign-in is checked here, exactly as Navidrome checks it (`server/subsonic/middlewares.go`, the fork's
//! `sonus_auth.go`), and then one of three things happens:
//!
//! - **Refused here**: a missing parameter (10), wrong credentials or a limited address (40), an API key with other
//!   credentials (43), an unknown API key (44). Navidrome never sees the request.
//! - **Signed in**: the request goes on to Navidrome without its credentials (`p`, `t`, `s`, `apiKey`), with the user
//!   named in the header only the gateway can set (`Config::upstream_user_header`). `tokenInfo` is answered here.
//! - **Not ours**: a request signed with a session token (`jwt=`, the web UI), or one Go's parser would refuse, goes
//!   to Navidrome as it came, and Navidrome decides as before. So does everything the caller keeps away from here:
//!   a trusted proxy's user header, CORS preflights, paths that are not Subsonic methods.
//!
//! The gateway never names a user that is not in the database, and never names one without having checked the
//! credentials sent. See `server/SECURITY.md`.

pub mod credentials;
pub mod limiter;
pub mod params;
pub mod respond;

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::Incoming;
use hyper::header::{self, HeaderMap, HeaderValue};
use hyper::{Method, Response};
use tracing::{error, warn};

use crate::config::TwoFactor;
use crate::db::Db;
use crate::gateway::Body;
use crate::secrets::Keys;
pub use credentials::SignedIn;
use limiter::Limiter;
use params::{CREDENTIALS, MAX_FORM_BYTES, Params};

/// How long a form post's body may take to arrive.
const FORM_WITHIN: std::time::Duration = std::time::Duration::from_secs(30);
use respond::{Envelope, Format, Payload};

/// The methods Navidrome's router has behind its sign-in (`server/subsonic/api.go`, the "Protected" group), each also
/// under `<name>.view`. Anything else under `/rest/` is not checked here: `getOpenSubsonicExtensions` needs no
/// sign-in, and an unknown path is Navidrome's 404, credentials or not.
const PROTECTED: &[&str] = &[
    "ping",
    "getLicense",
    "tokenInfo",
    "getMusicFolders",
    "getIndexes",
    "getArtists",
    "getGenres",
    "getMusicDirectory",
    "getArtist",
    "getAlbum",
    "getSong",
    "getAlbumInfo",
    "getAlbumInfo2",
    "getArtistInfo",
    "getArtistInfo2",
    "getTopSongs",
    "getSimilarSongs",
    "getSimilarSongs2",
    "getSonicSimilarTracks",
    "findSonicPath",
    "getAlbumList",
    "getAlbumList2",
    "getStarred",
    "getStarred2",
    "getNowPlaying",
    "getRandomSongs",
    "getSongsByGenre",
    "setRating",
    "star",
    "unstar",
    "scrobble",
    "reportPlayback",
    "getPlaylists",
    "getPlaylist",
    "createPlaylist",
    "deletePlaylist",
    "updatePlaylist",
    "getBookmarks",
    "createBookmark",
    "deleteBookmark",
    "getPlayQueue",
    "getPlayQueueByIndex",
    "savePlayQueue",
    "savePlayQueueByIndex",
    "search2",
    "search3",
    "getUser",
    "getUsers",
    "getScanStatus",
    "startScan",
    "getAvatar",
    "getLyrics",
    "getLyricsBySongId",
    "stream",
    "download",
    "getTranscodeDecision",
    "getTranscodeStream",
    "getCoverArt",
    "getInternetRadioStations",
    "createInternetRadioStation",
    "deleteInternetRadioStation",
    "updateInternetRadioStation",
    "getShares",
    "createShare",
    "updateShare",
    "deleteShare",
    "connect",
    "jukeboxControl",
    "getPodcasts",
    "getNewestPodcasts",
    "refreshPodcasts",
    "createPodcastChannel",
    "deletePodcastChannel",
    "deletePodcastEpisode",
    "downloadPodcastEpisode",
    "createUser",
    "updateUser",
    "deleteUser",
    "changePassword",
    "search",
    "getChatMessages",
    "addChatMessage",
    "getVideos",
    "getVideoInfo",
    "getCaptions",
    "hls",
];

/// The protected method a path under `/rest/` names (`ping`, `ping.view`), exactly as Navidrome's router matches it.
pub fn protected_method(name: &str) -> Option<&'static str> {
    let name = name.strip_suffix(".view").unwrap_or(name);
    PROTECTED.iter().copied().find(|method| *method == name)
}

/// Navidrome's `consts.UpdateLastAccessFrequency`: a user's last access is written at most this often.
const LAST_ACCESS_EVERY: Duration = Duration::from_secs(60);

pub struct Subsonic {
    db: Arc<Db>,
    keys: Keys,
    two_factor: TwoFactor,
    limiter: Option<Limiter>,
    envelope: Envelope,
    frame_options: HeaderValue,
    /// When each user's last access was last written by `tokenInfo` here.
    last_access: Mutex<HashMap<String, Instant>>,
}

pub struct Setup {
    pub db: Arc<Db>,
    pub keys: Keys,
    pub two_factor: TwoFactor,
    /// `AuthRequestLimit` and `AuthWindowLength`.
    pub limit: i64,
    pub window: Duration,
    pub envelope: Envelope,
    /// `HTTPHeaders.FrameOptions`.
    pub frame_options: String,
}

/// A request to a protected method.
pub struct Request<'a> {
    /// The method's name (`protected_method`).
    pub method: &'static str,
    pub http_method: &'a Method,
    /// The request target's path and query, as they came.
    pub path: &'a str,
    pub query: Option<&'a str>,
    pub headers: &'a HeaderMap,
    /// The address the gateway decided the request came from (trust.rs).
    pub client: IpAddr,
}

pub enum Outcome {
    /// Answered here.
    Respond(Response<Body>),
    /// Navidrome's to decide, as the request came.
    Untouched(Body),
    /// Signed in: on to Navidrome as `user`, with this target and body (the credentials removed).
    SignedIn { path_and_query: String, body: Body, content_length: Option<usize>, user: HeaderValue },
}

/// Why `identify` names no user.
enum Refusal {
    Respond(Box<Response<Body>>),
    /// The request carries a session token (`jwt`): Navidrome's to check.
    SessionToken,
}

/// What `Subsonic::sign_in` found.
pub enum SignIn {
    User(SignedIn),
    /// Refused, with the answer Navidrome would give (10, 40, 43, 44).
    Refused(Response<Body>),
    /// Not credentials this server checks: a session token (`jwt`), or a query Go's parser refuses.
    NotChecked,
}

impl Subsonic {
    pub fn new(setup: Setup) -> Subsonic {
        Subsonic {
            db: setup.db,
            keys: setup.keys,
            two_factor: setup.two_factor,
            limiter: Limiter::new(setup.limit, setup.window),
            envelope: setup.envelope,
            frame_options: HeaderValue::from_str(&setup.frame_options).unwrap_or(HeaderValue::from_static("DENY")),
            last_access: Mutex::new(HashMap::new()),
        }
    }

    /// Checks a request to a protected method, whatever its HTTP method.
    pub async fn check(&self, request: Request<'_>, body: Incoming) -> Outcome {
        let Request { method, http_method, path, query, headers, client } = request;
        let raw_query = query.unwrap_or("").as_bytes();
        let Some(from_query) = Params::parse(raw_query, None) else { return Outcome::Untouched(stream(body)) };

        // a form post carries parameters in its body: read it (Navidrome reads at most 10 MiB)
        // the parameters, the form's bytes when there is one, and the body to send on: the stream as it comes, or the
        // form that was read
        let (params, form, body) = match params::is_form(http_method, headers.get(header::CONTENT_TYPE).map(|v| v.as_bytes())) {
            false => (from_query, None, stream(body)),
            true => {
                let declared = headers.get(header::CONTENT_LENGTH).and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<u64>().ok());
                if declared.is_some_and(|length| length > MAX_FORM_BYTES as u64) {
                    return Outcome::Untouched(stream(body)); // Navidrome refuses it, unread
                }
                // Read before anyone is signed in, so not waited for long: a client that sends most of a form and
                // stops would hold what it sent for as long as it kept the connection.
                let Ok(read) = tokio::time::timeout(FORM_WITHIN, Limited::new(body, MAX_FORM_BYTES).collect()).await else {
                    let format = Format::of(from_query.get("f"), from_query.get("callback"));
                    return self.error(&format, headers, respond::GENERIC, "i/o timeout");
                };
                let bytes = match read {
                    Ok(read) => read.to_bytes(),
                    Err(e) => {
                        // sent without a length and too long (Navidrome's answer, in the format the query asks for),
                        // or the client went away mid-body (nobody reads the answer)
                        let message = if e.is::<http_body_util::LengthLimitError>() { "http: request body too large" } else { "unexpected EOF" };
                        let format = Format::of(from_query.get("f"), from_query.get("callback"));
                        return self.error(&format, headers, respond::GENERIC, message);
                    }
                };
                match Params::parse(raw_query, Some(&bytes)) {
                    Some(params) => (params, Some(bytes.clone()), full(bytes)),
                    None => return Outcome::Untouched(full(bytes)),
                }
            }
        };

        let format = Format::of(params.get("f"), params.get("callback"));
        let by_key = params.has("apiKey");
        let user = match self.identify(&params, headers, client, &format).await {
            Ok(user) => user,
            Err(Refusal::Respond(response)) => return Outcome::Respond(*response),
            Err(Refusal::SessionToken) => return Outcome::Untouched(body), // a web session: Navidrome checks its token
        };

        if method == "tokenInfo" {
            self.touch_last_access(&user.user_id).await;
            return self.respond(&format, headers, &Payload::TokenInfo { username: &user.user_name });
        }

        // Navidrome keeps the name as the client typed it for a password sign-in (its player cookie is named after
        // it), and as the database has it for an API key.
        let name = if by_key { user.user_name.as_bytes() } else { params.get("u") };
        let Some(user_header) = header_value(name) else {
            // a name no header can carry: Navidrome checks the credentials itself, as before
            return Outcome::Untouched(body);
        };
        let query = params::without(raw_query, &CREDENTIALS);
        let mut path_and_query = path.to_string();
        if !query.is_empty() {
            path_and_query.push('?');
            path_and_query.push_str(&String::from_utf8_lossy(&query));
        }
        match form {
            Some(form) => {
                let stripped = params::without(&form, &CREDENTIALS);
                let length = stripped.len();
                Outcome::SignedIn { path_and_query, body: full(Bytes::from(stripped)), content_length: Some(length), user: user_header }
            }
            None => Outcome::SignedIn { path_and_query, body, content_length: None, user: user_header },
        }
    }

    /// Who the parameters sign in as, exactly as `check` decides it: the required parameters first, then an API key
    /// (alone) or a user name with its password or token. Err: the answer that refuses them, or that they carry a
    /// session token (`jwt`), which is not checked here.
    async fn identify(&self, params: &Params, headers: &HeaderMap, client: IpAddr, format: &Format) -> Result<SignedIn, Refusal> {
        let refuse = |code: i32, message: &str| Err(Refusal::Respond(Box::new(self.error_response(format, headers, code, message))));
        let by_key = params.has("apiKey");
        // Navidrome's checkRequiredParameters: an API key comes without u
        let required: &[&str] = if by_key { &["v", "c"] } else { &["u", "v", "c"] };
        if let Some(missing) = required.iter().find(|name| !params.has(name)) {
            return refuse(respond::MISSING_PARAMETER, &format!("missing parameter: '{missing}'"));
        }
        if by_key {
            if ["u", "p", "t", "s", "jwt"].iter().any(|other| params.has(other)) {
                return refuse(respond::CONFLICTING_AUTH, "Multiple conflicting authentication mechanisms provided");
            }
            return match self.by_api_key(params, client).await {
                Ok(user) => Ok(user),
                Err((code, message)) => refuse(code, message),
            };
        }
        if params.has("jwt") {
            return Err(Refusal::SessionToken);
        }
        match self.by_password(params.get("u"), params, client).await {
            Ok(user) => Ok(user),
            Err(()) => refuse(respond::WRONG_CREDENTIALS, respond::WRONG_CREDENTIALS_MESSAGE),
        }
    }

    /// Who a request's query signs in as, for a route answered here whole (Sonus Connect's WebSocket): the same check
    /// as `check` makes, with the same limiter and the same answers when it fails, but nothing goes on to Navidrome.
    /// Only the query is read: such a request has no form.
    pub async fn sign_in(&self, query: Option<&str>, headers: &HeaderMap, client: IpAddr) -> SignIn {
        let Some(params) = Params::parse(query.unwrap_or("").as_bytes(), None) else { return SignIn::NotChecked };
        let format = Format::of(params.get("f"), params.get("callback"));
        match self.identify(&params, headers, client, &format).await {
            Ok(user) => SignIn::User(user),
            Err(Refusal::Respond(response)) => SignIn::Refused(*response),
            Err(Refusal::SessionToken) => SignIn::NotChecked,
        }
    }

    /// Navidrome's `authenticate`, the `u` with `p` or `t`/`s` branch. Err: answer 40.
    async fn by_password(&self, name: &[u8], params: &Params, client: IpAddr) -> Result<SignedIn, ()> {
        // a name that is not text is no user's (names are text in the database): a failed attempt like any other
        let text = std::str::from_utf8(name).ok();
        let username = text.unwrap_or("(not text)");
        // refused attempts get the answer of a wrong password, so they reveal nothing
        let mut key = limiter_address(client).into_bytes();
        key.push(0);
        match text {
            Some(text) => key.extend_from_slice(text.to_lowercase().as_bytes()),
            None => key.extend_from_slice(name),
        }
        let slot = match &self.limiter {
            Some(limiter) => match limiter.acquire(&key).await {
                Some(slot) => Some(slot),
                None => {
                    warn!(username, %client, "Subsonic: too many failed sign-ins");
                    return Err(());
                }
            },
            None => None,
        };
        let (db, keys, policy) = (self.db.clone(), self.keys.clone(), self.two_factor);
        let name = text.map(str::to_string);
        let sent = credentials::Sent {
            pass: params.get("p").to_vec(),
            token: params.get("t").to_vec(),
            salt: params.get("s").to_vec(),
            client: params.get("c").to_vec(),
        };
        let checked = tokio::task::spawn_blocking(move || match name {
            Some(name) => credentials::user_with_password(&db, &keys, policy, &name, &sent),
            None => Ok(None),
        })
        .await;
        let result = match checked {
            Ok(Ok(Some(user))) => Ok(user),
            Ok(Ok(None)) => {
                warn!(username, %client, "Subsonic: invalid sign-in");
                Err(true)
            }
            Ok(Err(e)) => {
                error!(username, %client, error = %e, "Subsonic: could not check a sign-in");
                Err(false)
            }
            Err(_) => Err(false),
        };
        if let Some(slot) = slot {
            // only wrong credentials count; a server that could not check them is not the client's failure
            slot.release(result == Err(true));
        }
        result.map_err(|_| ())
    }

    /// The fork's `authenticateAPIKey`. Err: the error to answer.
    async fn by_api_key(&self, params: &Params, client: IpAddr) -> Result<SignedIn, (i32, &'static str)> {
        const INVALID: (i32, &str) = (respond::INVALID_API_KEY, "Invalid API key");
        // failed keys count against the address, as failed passwords do
        let mut key = limiter_address(client).into_bytes();
        key.extend_from_slice(b"\0apiKey");
        let slot = match &self.limiter {
            Some(limiter) => match limiter.acquire(&key).await {
                Some(slot) => Some(slot),
                None => {
                    warn!(%client, "Subsonic: too many failed API keys");
                    return Err(INVALID);
                }
            },
            None => None,
        };
        let db = self.db.clone();
        let (api_key, app) = (params.get("apiKey").to_vec(), params.get("c").to_vec());
        let checked = tokio::task::spawn_blocking(move || credentials::user_with_api_key(&db, &api_key, &app)).await;
        let (result, failed) = match checked {
            Ok(Ok(Some(user))) => (Ok(user), false),
            Ok(Ok(None)) => {
                warn!(%client, "Subsonic: invalid API key");
                (Err(INVALID), true)
            }
            Ok(Err(e)) => {
                error!(%client, error = %e, "Subsonic: could not check an API key");
                (Err((respond::GENERIC, "Internal error")), false)
            }
            Err(_) => (Err((respond::GENERIC, "Internal error")), false),
        };
        if let Some(slot) = slot {
            slot.release(failed);
        }
        result
    }

    /// As Navidrome's `UpdateLastAccessMiddleware` does for every signed-in request it answers.
    async fn touch_last_access(&self, user_id: &str) {
        {
            let mut written = self.last_access.lock().expect("the last-access lock");
            let now = Instant::now();
            if written.get(user_id).is_some_and(|at| now.duration_since(*at) < LAST_ACCESS_EVERY) {
                return;
            }
            written.retain(|_, at| now.duration_since(*at) < LAST_ACCESS_EVERY);
            written.insert(user_id.to_string(), now);
        }
        let (db, id) = (self.db.clone(), user_id.to_string());
        match tokio::task::spawn_blocking(move || credentials::touch_last_access(&db, &id)).await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => warn!(error = %e, "could not update a user's last access"),
            Err(_) => {}
        }
    }

    fn error(&self, format: &Format, request: &HeaderMap, code: i32, message: &str) -> Outcome {
        self.respond(format, request, &Payload::Error { code, message })
    }

    fn error_response(&self, format: &Format, request: &HeaderMap, code: i32, message: &str) -> Response<Body> {
        let (content_type, body) = respond::render(&self.envelope, format, &Payload::Error { code, message });
        respond::response(content_type, body, request, &self.frame_options)
    }

    fn respond(&self, format: &Format, request: &HeaderMap, payload: &Payload) -> Outcome {
        let (content_type, body) = respond::render(&self.envelope, format, payload);
        Outcome::Respond(respond::response(content_type, body, request, &self.frame_options))
    }
}

fn stream(body: Incoming) -> Body {
    body.map_err(Into::into).boxed()
}

fn full(bytes: Bytes) -> Body {
    Full::new(bytes).map_err(|never| match never {}).boxed()
}

/// The address a limit is counted for: Navidrome's `httprate.CanonicalizeIP`, an IPv4 address itself and an IPv6
/// address's /64 (one subscriber, usually).
pub fn limiter_address(client: IpAddr) -> String {
    match client {
        IpAddr::V4(v4) => v4.to_string(),
        IpAddr::V6(v6) => {
            let mut bytes = v6.octets();
            bytes[8..].fill(0);
            std::net::Ipv6Addr::from(bytes).to_string()
        }
    }
}

/// A user name as a header value Navidrome reads back unchanged: no control characters, nothing its header parser
/// would trim. None when it cannot be one.
fn header_value(name: &[u8]) -> Option<HeaderValue> {
    let edge = |b: &u8| *b == b' ' || *b == b'\t';
    if name.is_empty() || name.first().is_some_and(edge) || name.last().is_some_and(edge) || name.contains(&b'\t') {
        return None;
    }
    HeaderValue::from_bytes(name).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protected_methods_are_matched_as_navidromes_router_matches_them() {
        assert_eq!(protected_method("ping"), Some("ping"));
        assert_eq!(protected_method("ping.view"), Some("ping"));
        assert_eq!(protected_method("tokenInfo"), Some("tokenInfo"));
        assert_eq!(protected_method("connect"), Some("connect"));
        assert_eq!(protected_method("getOpenSubsonicExtensions"), None, "public");
        assert_eq!(protected_method("Ping"), None, "case-sensitive");
        assert_eq!(protected_method("ping/"), None);
        assert_eq!(protected_method("ping.view.view"), None);
        assert_eq!(protected_method("nothing"), None);
        assert_eq!(protected_method(""), None);
        let mut names = PROTECTED.to_vec();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), PROTECTED.len(), "no method twice");
    }

    #[test]
    fn limits_are_counted_per_ipv4_address_and_per_ipv6_64() {
        assert_eq!(limiter_address("203.0.113.7".parse().unwrap()), "203.0.113.7");
        assert_eq!(limiter_address("2001:db8:1:2:3:4:5:6".parse().unwrap()), "2001:db8:1:2::");
        assert_eq!(limiter_address("2001:db8:1:2::9".parse().unwrap()), limiter_address("2001:db8:1:2:ffff::1".parse().unwrap()));
        assert_ne!(limiter_address("2001:db8:1:2::9".parse().unwrap()), limiter_address("2001:db8:1:3::9".parse().unwrap()));
    }

    #[test]
    fn only_names_a_header_carries_unchanged_are_named() {
        assert_eq!(header_value(b"alice").unwrap(), "alice");
        assert_eq!(header_value("林夕雨".as_bytes()).unwrap().as_bytes(), "林夕雨".as_bytes());
        assert_eq!(header_value(b"first last").unwrap(), "first last");
        assert!(header_value(b"").is_none());
        assert!(header_value(b" alice").is_none());
        assert!(header_value(b"alice\t").is_none());
        assert!(header_value(b"ali\tce").is_none());
        assert!(header_value(b"alice\r\nx-injected: 1").is_none());
        assert!(header_value(b"ali\0ce").is_none());
    }
}
