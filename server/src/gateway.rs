//! The gateway: every request goes to Navidrome as it came, streamed both ways (songs, uploads, server-sent events),
//! WebSockets included (Sonus Connect, the Jellyfin API). Only what a proxy must change changes: hop-by-hop headers,
//! and who the client is (trust.rs). Parts of the API move out of Navidrome by being answered or checked here instead:
//! `routes.rs` lists them. So far: Subsonic sign-ins (`subsonic`), the `/auth` routes (`auth`) and Sonus Connect
//! version 2 (`connect`). Request bodies to Navidrome's own API are bounded here as Navidrome bounds them.

use std::convert::Infallible;
use std::future::Future;
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use bytes::Bytes;
use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::Incoming;
use hyper::header::{self, HeaderMap, HeaderName, HeaderValue};
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode, Uri, Version};
use hyper_util::client::legacy::Client;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::rt::{TokioExecutor, TokioIo, TokioTimer};
use hyper_util::server::conn::auto;
use hyper_util::server::graceful::GracefulShutdown;
use tokio::net::TcpListener;
use tracing::{debug, warn};

use crate::auth::{self, Auth};
use crate::connect::{self, Connect};
use crate::routes::{self, Local};
use crate::subsonic::{self, Subsonic};
use crate::trust::{TrustList, client_ip};

pub type BoxError = Box<dyn std::error::Error + Send + Sync>;
pub type Body = BoxBody<Bytes, BoxError>;

/// Navidrome's `MaxAPIBodySize`: what a request to its own API or the Jellyfin API may send (uploads apart). Its
/// handlers decode JSON bodies without a limit of their own; 4 MiB is about 150,000 song ids.
pub const MAX_API_BODY_BYTES: u64 = 4 << 20;

pub struct Settings {
    /// Navidrome's address: `http://127.0.0.1:4534`.
    pub upstream: Uri,
    pub trusted: TrustList,
    /// The header trusted proxies name the signed-in user with (`Remote-User`); None: no user header is believed.
    pub user_header: Option<HeaderName>,
    /// The header Navidrome takes the user from (see `Config::upstream_user_header`): set by the gateway alone.
    pub upstream_user_header: HeaderName,
    /// `BaseURL`'s path (`/music`), empty when none: the routes answered here are under it, as Navidrome's are.
    pub base_path: String,
    /// The gateway checks Subsonic sign-ins itself (`subsonic`), once `Gateway::set_subsonic` has given it the means;
    /// until then those requests wait (503). False: they are Navidrome's, as everything else.
    pub checks_sign_ins: bool,
}

/// Headers the gateway sets or removes itself, whatever the client sent: none of them can be the user header.
pub fn is_managed_header(name: &HeaderName) -> bool {
    let name = name.as_str();
    FORWARDING.contains(&name) || HOP_BY_HOP.contains(&name) || name == "host" || name == "expect"
}

/// Who the client is: decided here (trust.rs), so a client's own claims never reach Navidrome.
const FORWARDING: [&str; 3] = ["true-client-ip", "x-real-ip", "x-forwarded-for"];

/// The headers that belong to one connection, not to the request (RFC 9110 7.6.1), with the two older ones.
const HOP_BY_HOP: [&str; 9] =
    ["connection", "te", "trailer", "transfer-encoding", "upgrade", "proxy-authorization", "proxy-authenticate", "keep-alive", "proxy-connection"];

/// Cheap to clone: one per connection.
#[derive(Clone)]
pub struct Gateway {
    inner: Arc<Inner>,
}

struct Inner {
    settings: Settings,
    client: Client<HttpConnector, Body>,
    /// Whether Navidrome has answered yet: until then a refused connection is "starting" (503), afterwards "down" (502).
    ready: Arc<AtomicBool>,
    subsonic: OnceLock<Arc<Subsonic>>,
    auth: OnceLock<Arc<Auth>>,
    connect: OnceLock<Connect>,
}

impl Gateway {
    pub fn new(settings: Settings, ready: Arc<AtomicBool>) -> Gateway {
        let mut connector = HttpConnector::new();
        connector.set_nodelay(true);
        connector.set_connect_timeout(Some(Duration::from_secs(5)));
        let client = Client::builder(TokioExecutor::new()).pool_idle_timeout(Duration::from_secs(30)).pool_timer(TokioTimer::new()).build(connector);
        Gateway { inner: Arc::new(Inner { settings, client, ready, subsonic: OnceLock::new(), auth: OnceLock::new(), connect: OnceLock::new() }) }
    }

    /// Gives the gateway what it checks Subsonic sign-ins with (the database is open and is the schema it knows).
    /// Once: a second call changes nothing.
    pub fn set_subsonic(&self, subsonic: Subsonic) {
        let _ = self.inner.subsonic.set(Arc::new(subsonic));
    }

    /// Gives the gateway what it answers the `/auth` routes with. Once: a second call changes nothing.
    pub fn set_auth(&self, auth: Auth) {
        let _ = self.inner.auth.set(Arc::new(auth));
    }

    /// Gives the gateway Sonus Connect version 2: from then on it answers `rest/connect?protocol=2` itself and says so
    /// in `getOpenSubsonicExtensions`. Once: a second call changes nothing.
    pub fn set_connect(&self, connect: Connect) {
        let _ = self.inner.connect.set(connect);
    }

    /// Sonus Connect, when the gateway answers it.
    pub fn connect(&self) -> Option<&Connect> {
        self.inner.connect.get()
    }

    pub async fn handle(&self, mut req: Request<Incoming>, peer: IpAddr) -> Response<Body> {
        let started = Instant::now();
        let settings = &self.inner.settings;
        let method = req.method().clone();
        // the path only: queries carry Subsonic credentials (p, t, s, apiKey)
        let path = req.uri().path().to_string();
        if method == Method::CONNECT {
            // not a proxy for anywhere else
            return text(StatusCode::METHOD_NOT_ALLOWED, "Method not allowed");
        }

        let upgrade = upgrade_protocol(req.headers());
        let mut client_upgrade = upgrade.as_ref().map(|_| hyper::upgrade::on(&mut req));

        let (parts, body) = req.into_parts();
        // Navidrome's address and the request's own path, as it came (a BaseURL path included)
        let mut path_and_query = parts.uri.path_and_query().map(|p| p.as_str()).unwrap_or("/").to_string();

        let mut headers = parts.headers;
        if !headers.contains_key(header::HOST) {
            // HTTP/2 carries the host in the request target; Navidrome (HTTP/1.1) wants the header
            if let Some(authority) = parts.uri.authority().and_then(|a| HeaderValue::from_str(a.as_str()).ok()) {
                headers.insert(header::HOST, authority);
            }
        }
        strip_hop_by_hop(&mut headers);
        headers.remove(header::EXPECT); // answered here already
        let client = client_ip(peer, &headers, &settings.trusted);
        for name in FORWARDING {
            headers.remove(name);
        }
        let client_value = HeaderValue::from_str(&client.to_string()).expect("an address is a header value");
        headers.insert("x-real-ip", client_value.clone());
        headers.insert("x-forwarded-for", client_value);
        // Anyone could claim to be signed in by a proxy: only a trusted proxy's claim reaches Navidrome, under the
        // name Navidrome reads, which nobody else can set. Navidrome reads the first value, as here.
        let mut user = match &settings.user_header {
            Some(name) if settings.trusted.contains(peer) => headers.get(name).cloned(),
            _ => None,
        };
        if let Some(name) = &settings.user_header {
            headers.remove(name);
        }
        headers.remove(&settings.upstream_user_header);

        // What is answered or checked here instead of by Navidrome (routes.rs). A user a trusted proxy names is
        // Navidrome's to look up, as before.
        let local = if settings.checks_sign_ins { routes::find(&parts.method, parts.uri.path(), &headers, &settings.base_path) } else { None };
        // Navidrome's list of extensions gets this server's own added (below), so it must come as it is written
        let merge_extensions = local == Some(Local::Extensions) && self.inner.connect.get().is_some() && parts.method != Method::HEAD;
        if merge_extensions {
            headers.remove(header::ACCEPT_ENCODING);
        }
        let body: Body = match local {
            // Sonus Connect version 2: its WebSocket is answered here, for the user the query's credentials sign in
            // (a trusted proxy's user header does not open it)
            Some(ref connect_v2) if self.inner.connect.get().is_some() && routes::is_connect_v2(connect_v2, parts.uri.query()) => {
                let (Some(connect), Some(subsonic)) = (self.inner.connect.get(), self.inner.subsonic.get()) else { return starting() };
                let request = connect::Request {
                    method: &parts.method,
                    query: parts.uri.query(),
                    headers: &headers,
                    client,
                    upgrade: upgrade.as_ref(),
                    on_upgrade: client_upgrade.take(),
                };
                let response = connect.handle(subsonic, request).await;
                debug!(%method, path, status = response.status().as_u16(), ms = started.elapsed().as_millis() as u64, %client, "answered here");
                return response;
            }
            Some(Local::Auth(rest)) => {
                let Some(auth) = self.inner.auth.get() else { return starting() };
                let request = auth::Request {
                    method: &parts.method,
                    path: &rest,
                    query: parts.uri.query(),
                    headers: &headers,
                    client,
                    proxy_user: user.as_ref().map(|name| name.as_bytes()),
                };
                let response = auth.handle(request, body).await;
                debug!(%method, path, status = response.status().as_u16(), ms = started.elapsed().as_millis() as u64, %client, "answered here");
                return response;
            }
            // a user a trusted proxy names is Navidrome's to look up, whatever credentials come along
            Some(Local::Subsonic(subsonic_method)) if user.is_none() => {
                let Some(subsonic) = self.inner.subsonic.get() else {
                    // not before the database is known to be the one this server understands
                    return starting();
                };
                let request = subsonic::Request {
                    method: subsonic_method,
                    http_method: &parts.method,
                    path: parts.uri.path(),
                    query: parts.uri.query(),
                    headers: &headers,
                    client,
                };
                match subsonic.check(request, body).await {
                    subsonic::Outcome::Respond(response) => {
                        debug!(%method, path, status = response.status().as_u16(), ms = started.elapsed().as_millis() as u64, %client, "answered here");
                        return response;
                    }
                    subsonic::Outcome::Untouched(body) => body,
                    subsonic::Outcome::SignedIn { path_and_query: stripped, body, content_length, user: signed_in } => {
                        path_and_query = stripped;
                        if let Some(length) = content_length {
                            headers.insert(header::CONTENT_LENGTH, HeaderValue::from(length));
                        }
                        user = Some(signed_in);
                        body
                    }
                }
            }
            _ if limits_body(&parts.method, parts.uri.path(), &headers, &settings.base_path) => {
                let declared = headers.get(header::CONTENT_LENGTH).and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<u64>().ok());
                if declared.is_some_and(|length| length > MAX_API_BODY_BYTES) {
                    // read what the client is sending, within reason, so it gets the answer and not a closed connection
                    let _ = tokio::time::timeout(Duration::from_secs(10), discard(body, 8 * MAX_API_BODY_BYTES)).await;
                    return too_large();
                }
                // a body that says no length is cut off at the limit: the request then fails (413, below)
                Limited::new(body, MAX_API_BODY_BYTES as usize).boxed()
            }
            _ => body.map_err(Into::into).boxed(),
        };
        let uri = match settings.upstream.authority() {
            Some(authority) => Uri::builder().scheme("http").authority(authority.clone()).path_and_query(path_and_query.as_str()).build(),
            None => return text(StatusCode::INTERNAL_SERVER_ERROR, "No upstream address"),
        };
        let uri: Uri = match uri {
            Ok(uri) => uri,
            Err(_) => return text(StatusCode::BAD_REQUEST, "Bad request target"),
        };
        if let Some(user) = user {
            headers.insert(settings.upstream_user_header.clone(), user);
        }
        if let Some(protocol) = &upgrade {
            headers.insert(header::CONNECTION, HeaderValue::from_static("upgrade"));
            headers.insert(header::UPGRADE, protocol.clone());
        }

        let mut upstream_req = Request::new(body);
        *upstream_req.method_mut() = parts.method;
        *upstream_req.uri_mut() = uri;
        *upstream_req.version_mut() = Version::HTTP_11;
        *upstream_req.headers_mut() = headers;

        let mut response = match self.inner.client.request(upstream_req).await {
            Ok(response) => response,
            Err(e) if is_length_limit(&e) => return too_large(),
            Err(e) => {
                let ready = self.inner.ready.load(Ordering::Relaxed);
                warn!(%method, path, error = %e, "Navidrome did not answer");
                return if ready { text(StatusCode::BAD_GATEWAY, "The music server (Navidrome) did not answer") } else { starting() };
            }
        };
        let status = response.status();
        debug!(%method, path, status = status.as_u16(), ms = started.elapsed().as_millis() as u64, %client);

        if status == StatusCode::SWITCHING_PROTOCOLS {
            if let Some(client_upgrade) = client_upgrade {
                let upstream_upgrade = hyper::upgrade::on(&mut response);
                tokio::spawn(async move {
                    match tokio::try_join!(client_upgrade, upstream_upgrade) {
                        Ok((from_client, to_upstream)) => {
                            let (mut a, mut b) = (TokioIo::new(from_client), TokioIo::new(to_upstream));
                            if let Err(e) = tokio::io::copy_bidirectional(&mut a, &mut b).await {
                                debug!(error = %e, "upgraded connection ended");
                            }
                        }
                        Err(e) => warn!(error = %e, "upgrade failed"),
                    }
                });
                let (mut parts, _) = response.into_parts();
                let keep = (parts.headers.get(header::CONNECTION).cloned(), parts.headers.get(header::UPGRADE).cloned());
                strip_hop_by_hop(&mut parts.headers);
                if let (Some(connection), Some(upgrade)) = keep {
                    parts.headers.insert(header::CONNECTION, connection);
                    parts.headers.insert(header::UPGRADE, upgrade);
                }
                return Response::from_parts(parts, empty());
            }
        }

        let (mut parts, body) = response.into_parts();
        strip_hop_by_hop(&mut parts.headers);
        if merge_extensions && status == StatusCode::OK && !parts.headers.contains_key(header::CONTENT_ENCODING) {
            // the list is a few hundred bytes; an answer that is not one goes out as it came
            let Ok(read) = Limited::new(body, 1 << 20).collect().await else {
                return text(StatusCode::BAD_GATEWAY, "The music server (Navidrome) did not answer");
            };
            let bytes = read.to_bytes();
            let merged = connect::extensions::merge(&bytes, connect::extensions::OURS).map(Bytes::from).unwrap_or(bytes);
            parts.headers.insert(header::CONTENT_LENGTH, HeaderValue::from(merged.len()));
            return Response::from_parts(parts, Full::new(merged).map_err(|never: Infallible| match never {}).boxed());
        }
        Response::from_parts(parts, body.map_err(Into::into).boxed())
    }
}

/// Whether the request's body is bounded here as Navidrome's `LimitRequestBody` bounds it: requests to its own API
/// (`/api`) and the Jellyfin API (`/jellyfin`), except uploads (`multipart/form-data`, `image/*`), which have limits
/// of their own in Navidrome.
fn limits_body(method: &Method, path: &str, headers: &HeaderMap, base_path: &str) -> bool {
    let Some(path) = path.strip_prefix(base_path.trim_end_matches('/')) else { return false };
    let under = |prefix: &str| path.strip_prefix(prefix).is_some_and(|rest| rest.is_empty() || rest.starts_with('/'));
    if !(under("/api") || under("/jellyfin")) || matches!(*method, Method::GET | Method::HEAD | Method::OPTIONS) {
        return false;
    }
    let media = headers.get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).and_then(|v| v.split(';').next()).unwrap_or("").trim().to_ascii_lowercase();
    !(media == "multipart/form-data" || media.starts_with("image/"))
}

/// Reads a body and throws it away, up to `most` bytes.
async fn discard(mut body: Incoming, most: u64) {
    let mut seen = 0u64;
    while let Some(Ok(frame)) = body.frame().await {
        seen += frame.data_ref().map(|data| data.len() as u64).unwrap_or(0);
        if seen > most {
            break;
        }
    }
}

/// Whether a failed request to Navidrome failed because its body was cut off at the limit.
fn is_length_limit(error: &(dyn std::error::Error + 'static)) -> bool {
    let mut source = Some(error);
    while let Some(e) = source {
        if e.is::<http_body_util::LengthLimitError>() {
            return true;
        }
        source = e.source();
    }
    false
}

/// Navidrome's answer to a body declared too long.
fn too_large() -> Response<Body> {
    let mut r = text(StatusCode::PAYLOAD_TOO_LARGE, "Request body must not be larger than 4194304 bytes\n");
    r.headers_mut().insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    r
}

/// Accepts connections until `shutdown` resolves, then lets the open ones finish for a few seconds.
pub async fn serve(listener: TcpListener, gateway: Gateway, shutdown: impl Future<Output = ()>) -> std::io::Result<()> {
    let mut builder = auto::Builder::new(TokioExecutor::new());
    builder.http1().timer(TokioTimer::new()).header_read_timeout(Duration::from_secs(30));
    let graceful = GracefulShutdown::new();
    tokio::pin!(shutdown);
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let (stream, peer): (_, SocketAddr) = match accepted {
                    Ok(accepted) => accepted,
                    Err(e) => { warn!(error = %e, "accept failed"); tokio::time::sleep(Duration::from_millis(100)).await; continue; }
                };
                let _ = stream.set_nodelay(true);
                let gateway = gateway.clone();
                let service = service_fn(move |req| {
                    let gateway = gateway.clone();
                    async move { Ok::<_, Infallible>(gateway.handle(req, peer.ip()).await) }
                });
                let connection = builder.serve_connection_with_upgrades(TokioIo::new(stream), service).into_owned();
                let connection = graceful.watch(connection);
                tokio::spawn(async move {
                    if let Err(e) = connection.await {
                        debug!(error = %e, "connection ended");
                    }
                });
            }
            () = &mut shutdown => break,
        }
    }
    drop(listener);
    if tokio::time::timeout(Duration::from_secs(10), graceful.shutdown()).await.is_err() {
        debug!("connections still open after 10s: closing them");
    }
    Ok(())
}

/// The protocol asked for (`websocket`), when the request asks to switch to one.
fn upgrade_protocol(headers: &HeaderMap) -> Option<HeaderValue> {
    let asks = headers
        .get_all(header::CONNECTION)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .any(|token| token.trim().eq_ignore_ascii_case("upgrade"));
    if asks { headers.get(header::UPGRADE).cloned() } else { None }
}

/// The headers that belong to one connection, not to the request (RFC 9110 7.6.1), and the ones Connection names.
fn strip_hop_by_hop(headers: &mut HeaderMap) {
    let named: Vec<HeaderName> = headers
        .get_all(header::CONNECTION)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .filter_map(|token| HeaderName::try_from(token.trim()).ok())
        .filter(|name| name != header::HOST)
        .collect();
    for name in named {
        headers.remove(name);
    }
    for name in HOP_BY_HOP {
        headers.remove(name);
    }
}

fn starting() -> Response<Body> {
    let mut r = text(StatusCode::SERVICE_UNAVAILABLE, "The music server is starting");
    r.headers_mut().insert(header::RETRY_AFTER, HeaderValue::from_static("5"));
    r
}

fn text(status: StatusCode, message: &'static str) -> Response<Body> {
    let mut r = Response::new(Full::new(Bytes::from_static(message.as_bytes())).map_err(|never: Infallible| match never {}).boxed());
    *r.status_mut() = status;
    r.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("text/plain; charset=utf-8"));
    r
}

fn empty() -> Body {
    Full::new(Bytes::new()).map_err(|never: Infallible| match never {}).boxed()
}
