//! Sonus Connect version 2 (`docs/protocol/connect.md`): one playback session per user, answered here at
//! `rest/connect?protocol=2`. Version 1 (without `protocol=2`) stays Navidrome's until the clients have moved.
//!
//! - `session`, `queue`: the protocol's logic, pure (a port of the reference, pinned by the shared test vectors).
//! - this file: what is around it. A **room** per user holds the session and the user's connections; every message
//!   is applied under the room's lock, on a blocking thread (the session asks the database what a song is), and what
//!   the session says to send goes into each connection's outbox.
//! - `socket`: one WebSocket connection: the hello, the pings, the limits, the close codes.
//! - `store`: the session kept in the database (written within a second of a change, and when the server stops), and
//!   the library as the session's user sees it.
//! - `extensions`: `sonusConnect` version 2 added to Navidrome's `getOpenSubsonicExtensions`.
//!
//! A connection belongs to the user whose credentials opened it (`subsonic::Subsonic::sign_in`), and only ever
//! reaches that user's room: nothing a device sends names a user. See `server/SECURITY.md`.

pub mod extensions;
pub mod queue;
pub mod session;
mod socket;
pub mod store;

use std::collections::{HashMap, HashSet, VecDeque};
use std::convert::Infallible;
use std::net::IpAddr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::header::{self, HeaderMap, HeaderValue};
use hyper::upgrade::OnUpgrade;
use hyper::{Method, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde_json::Value;
use sha1::{Digest, Sha1};
use tokio::sync::{Notify, mpsc};
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Utf8Bytes;
use tokio_tungstenite::tungstenite::protocol::{Role, WebSocketConfig};
use tracing::{debug, warn};

use crate::db::Db;
use crate::gateway::Body;
use crate::subsonic::{SignIn, SignedIn, Subsonic};
use queue::{Id, Manual};
use session::{ConnectSession, Env, GRACE_MS, MAX_DEVICES, Out};
use store::UserLibrary;

/// A message (a JSON text frame) is at most this long.
pub const MAX_MESSAGE_BYTES: usize = 1 << 20;
/// Messages waiting to be written to one device. One that does not read them is dropped, as on a network loss.
const OUTBOX: usize = 256;
/// Connections of one user that have not said hello yet.
const MAX_WAITING: usize = 8;

/// RFC 6455, 1.3.
const WEBSOCKET_GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/// Close codes (connect.md, Connecting; the others are RFC 6455's).
pub mod close {
    /// A newer connection of the same device took this one's place.
    pub const REPLACED: u16 = 4000;
    /// The user's 33rd device connected, and this one was silent longest.
    pub const TOO_MANY_DEVICES: u16 = 4001;
    pub const GOING_AWAY: u16 = 1001;
    pub const POLICY: u16 = 1008;
    pub const TOO_BIG: u16 = 1009;
    pub const INTERNAL: u16 = 1011;
    pub const TRY_AGAIN_LATER: u16 = 1013;
}

pub struct Setup {
    pub db: Arc<Db>,
    /// How long the active device stays active after its connection dropped (10 s).
    pub grace: Duration,
    /// The server pings every this often (30 s)…
    pub ping_every: Duration,
    /// …and closes a connection it has heard nothing from for this long (75 s).
    pub silence: Duration,
    /// A connection's first message, `hello`, must come within this.
    pub hello_within: Duration,
    /// A changed session is written this long after the change (so several changes are one write).
    pub save_after: Duration,
    /// How often a connection's user is checked to still exist.
    pub user_check_every: Duration,
    pub max_devices: usize,
}

impl Setup {
    /// The protocol's values.
    pub fn new(db: Arc<Db>) -> Setup {
        Setup {
            db,
            grace: Duration::from_millis(GRACE_MS as u64),
            ping_every: Duration::from_secs(30),
            silence: Duration::from_secs(75),
            hello_within: Duration::from_secs(10),
            save_after: Duration::from_millis(700),
            user_check_every: Duration::from_secs(60),
            max_devices: MAX_DEVICES,
        }
    }
}

/// Cheap to clone.
#[derive(Clone)]
pub struct Connect {
    inner: Arc<Inner>,
}

struct Inner {
    setup: Setup,
    /// By user id. A room is here while it has connections, a grace period running or changes not written yet;
    /// otherwise the session is in the database only.
    rooms: Mutex<HashMap<String, Arc<Room>>>,
    /// Users whose room has something to write, or may be let go.
    dirty: Mutex<HashSet<String>>,
    save_soon: Arc<Notify>,
    next_connection: AtomicU64,
    stopping: AtomicBool,
    runtime: tokio::runtime::Handle,
}

struct Room {
    user_id: String,
    state: Mutex<State>,
}

struct State {
    session: ConnectSession,
    /// The connection of each connected device.
    links: HashMap<String, Link>,
    /// Connections that hold this room (to keep it in memory), and those of them that have not said hello.
    attached: usize,
    waiting: usize,
    /// The session's rev when it was last written (or read).
    saved_rev: u64,
    /// The lists as they are in the database; None: the user has no row yet.
    saved_lists: Option<Lists>,
    /// When the timer set for the grace period's end fires.
    timer_at: Option<i64>,
}

type Lists = (Vec<Id>, Vec<Id>, Vec<Manual>);

/// What goes into a connection's outbox.
pub(crate) enum Frame {
    Text(Utf8Bytes),
    /// Closes the connection, with a code and a reason.
    Close(u16, &'static str),
    /// Writes out what the WebSocket library queued itself (a pong).
    Flush,
}

/// A connection, as the room holds it.
#[derive(Clone)]
pub(crate) struct Link {
    connection: u64,
    tx: mpsc::Sender<Frame>,
    /// Ends the connection's task without a close frame (it does not read what it is sent).
    kill: Arc<Notify>,
}

impl Link {
    fn close(&self, code: u16, reason: &'static str) {
        if self.tx.try_send(Frame::Close(code, reason)).is_err() {
            self.kill.notify_one();
        }
    }
}

/// Why a connection gets no room.
pub(crate) enum Refused {
    Stopping,
    TooMany,
    Database,
}

/// The upgrade request, as the gateway has it.
pub struct Request<'a> {
    pub method: &'a Method,
    pub query: Option<&'a str>,
    pub headers: &'a HeaderMap,
    /// The address the gateway decided the request came from (trust.rs).
    pub client: IpAddr,
    /// The protocol the request asks to switch to (`websocket`), when it asks.
    pub upgrade: Option<&'a HeaderValue>,
    pub on_upgrade: Option<OnUpgrade>,
}

/// The request asks for version 2: `protocol=2` in its query (the first `protocol`, as the reference reads it).
pub fn asks_for_v2(query: Option<&str>) -> bool {
    crate::subsonic::params::Params::parse(query.unwrap_or("").as_bytes(), None).is_some_and(|params| params.get("protocol") == b"2")
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// Random numbers for one message (shuffling a context draws thousands): splitmix64, seeded from the system.
struct Rng(Option<u64>);

impl Rng {
    fn below(&mut self, n: usize) -> usize {
        let state = self.0.get_or_insert_with(|| {
            let mut seed = [0u8; 8];
            // without the system's randomness the order is only as random as the clock
            if getrandom::fill(&mut seed).is_err() {
                seed = (now_ms() as u64).to_le_bytes();
            }
            u64::from_le_bytes(seed)
        });
        *state = state.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = *state;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^= z >> 31;
        if n == 0 { 0 } else { (z % n as u64) as usize }
    }
}

fn text(status: StatusCode, message: &'static str) -> Response<Body> {
    let mut r = Response::new(Full::new(Bytes::from_static(message.as_bytes())).map_err(|never: Infallible| match never {}).boxed());
    *r.status_mut() = status;
    r.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("text/plain; charset=utf-8"));
    r
}

impl Connect {
    /// Makes Connect's tables when the database has none (`store::prepare`). Blocking. Must be called within the
    /// runtime: the task that writes changed sessions starts here.
    pub fn new(setup: Setup) -> Result<Connect, String> {
        store::prepare(&setup.db)?;
        let save_soon = Arc::new(Notify::new());
        let runtime = tokio::runtime::Handle::current();
        let inner = Arc::new(Inner {
            setup,
            rooms: Mutex::new(HashMap::new()),
            dirty: Mutex::new(HashSet::new()),
            save_soon: save_soon.clone(),
            next_connection: AtomicU64::new(1),
            stopping: AtomicBool::new(false),
            runtime: runtime.clone(),
        });
        // ends with the last `Connect`
        let weak = Arc::downgrade(&inner);
        runtime.spawn(async move {
            loop {
                save_soon.notified().await;
                let Some(inner) = weak.upgrade() else { return };
                tokio::time::sleep(inner.setup.save_after).await;
                // stop() wrote every session last: what the closing connections change after it is not written,
                // so a stopped server never writes over the next one's rows
                if inner.stopping.load(Ordering::Relaxed) {
                    return;
                }
                let _ = tokio::task::spawn_blocking(move || inner.flush()).await;
            }
        });
        Ok(Connect { inner })
    }

    /// Answers a request to `rest/connect?protocol=2`: checks the sign-in, and switches to the WebSocket.
    pub async fn handle(&self, subsonic: &Subsonic, request: Request<'_>) -> Response<Body> {
        let user = match subsonic.sign_in(request.query, request.headers, request.client).await {
            SignIn::User(user) => user,
            SignIn::Refused(response) => return response,
            // a web session's token, a query Go would refuse: version 2 takes Subsonic credentials only
            SignIn::NotChecked => return text(StatusCode::UNAUTHORIZED, "Sonus Connect needs Subsonic credentials: u with t and s (or p), or apiKey"),
        };
        let is_websocket = request.method == Method::GET && request.upgrade.is_some_and(|protocol| protocol.as_bytes().eq_ignore_ascii_case(b"websocket"));
        let version = request.headers.get(header::SEC_WEBSOCKET_VERSION).map(HeaderValue::as_bytes);
        let key = request.headers.get(header::SEC_WEBSOCKET_KEY).map(HeaderValue::as_bytes).filter(|key| !key.is_empty() && key.len() <= 64);
        let (Some(key), Some(on_upgrade), true, Some(b"13")) = (key, request.on_upgrade, is_websocket, version) else {
            let mut r = text(StatusCode::UPGRADE_REQUIRED, "Sonus Connect is a WebSocket (version 13)");
            r.headers_mut().insert(header::SEC_WEBSOCKET_VERSION, HeaderValue::from_static("13"));
            return r;
        };
        if self.inner.stopping.load(Ordering::Relaxed) {
            return text(StatusCode::SERVICE_UNAVAILABLE, "The music server is stopping");
        }
        let mut hash = Sha1::new();
        hash.update(key);
        hash.update(WEBSOCKET_GUID.as_bytes());
        let accept = base64::engine::general_purpose::STANDARD.encode(hash.finalize());

        let inner = self.inner.clone();
        tokio::spawn(async move {
            let upgraded = match on_upgrade.await {
                Ok(upgraded) => upgraded,
                Err(e) => {
                    debug!(error = %e, "Connect: the upgrade failed");
                    return;
                }
            };
            let config = WebSocketConfig::default().max_message_size(Some(MAX_MESSAGE_BYTES)).max_frame_size(Some(MAX_MESSAGE_BYTES));
            let ws = WebSocketStream::from_raw_socket(TokioIo::new(upgraded), Role::Server, Some(config)).await;
            socket::run(inner, user, ws).await;
        });

        let mut response = Response::new(Full::new(Bytes::new()).map_err(|never: Infallible| match never {}).boxed());
        *response.status_mut() = StatusCode::SWITCHING_PROTOCOLS;
        let headers = response.headers_mut();
        headers.insert(header::CONNECTION, HeaderValue::from_static("upgrade"));
        headers.insert(header::UPGRADE, HeaderValue::from_static("websocket"));
        headers.insert(header::SEC_WEBSOCKET_ACCEPT, HeaderValue::from_str(&accept).expect("base64 is a header value"));
        response
    }

    /// The server stops: every connection is closed (1001), and every changed session written.
    pub async fn stop(&self) {
        let inner = self.inner.clone();
        let _ = tokio::task::spawn_blocking(move || {
            inner.stopping.store(true, Ordering::Relaxed);
            let rooms: Vec<Arc<Room>> = inner.rooms.lock().expect("the rooms' lock").values().cloned().collect();
            for room in rooms {
                let state = room.lock();
                for link in state.links.values() {
                    link.close(close::GOING_AWAY, "the server is stopping");
                }
                inner.dirty.lock().expect("the dirty lock").insert(room.user_id.clone());
            }
            inner.flush();
        })
        .await;
    }

    /// A user's session, queue and devices as they are now (None: no connection, nothing unwritten). For tests.
    pub fn peek(&self, user_id: &str) -> Option<Value> {
        let room = self.inner.rooms.lock().expect("the rooms' lock").get(user_id).cloned()?;
        let state = room.lock();
        Some(serde_json::json!({ "session": state.session.session(), "queue": state.session.queue_view(), "devices": state.session.device_list() }))
    }

    /// How many users' sessions are in memory. For tests.
    pub fn rooms(&self) -> usize {
        self.inner.rooms.lock().expect("the rooms' lock").len()
    }
}

impl Room {
    fn lock(&self) -> MutexGuard<'_, State> {
        // a panic while a message was applied leaves the session as far as it got: still the user's own
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

// Everything below blocks (the room's lock, the database): called on blocking threads.
impl Inner {
    /// The user's room, loading the session when it is not in memory; the caller's connection now holds it.
    fn attach(&self, user: &SignedIn) -> Result<Arc<Room>, Refused> {
        if self.stopping.load(Ordering::Relaxed) {
            return Err(Refused::Stopping);
        }
        let mut rooms = self.rooms.lock().expect("the rooms' lock");
        let room = match rooms.get(&user.user_id) {
            Some(room) => room.clone(),
            None => {
                let saved = store::load(&self.setup.db, &user.user_id).map_err(|e| {
                    warn!(error = %e, "Connect: could not read a saved session");
                    Refused::Database
                })?;
                let (grace_ms, max_devices) = (self.setup.grace.as_millis() as i64, self.setup.max_devices);
                let restored = saved.as_ref().and_then(|saved| ConnectSession::restore(saved, now_ms(), grace_ms, max_devices));
                if saved.is_some() && restored.is_none() {
                    warn!(user = %user.user_name, "Connect: the saved session is not one this server wrote; starting an empty one");
                }
                // no row, or one that could not be used: the first write is the whole session
                let saved_lists = restored.as_ref().map(ConnectSession::lists);
                let session = restored.unwrap_or_else(|| ConnectSession::new(grace_ms, max_devices));
                let state = State { saved_rev: session.rev(), saved_lists, session, links: HashMap::new(), attached: 0, waiting: 0, timer_at: None };
                let room = Arc::new(Room { user_id: user.user_id.clone(), state: Mutex::new(state) });
                rooms.insert(user.user_id.clone(), room.clone());
                room
            }
        };
        let mut state = room.lock();
        if state.waiting >= MAX_WAITING {
            return Err(Refused::TooMany);
        }
        state.attached += 1;
        state.waiting += 1;
        drop(state);
        Ok(room)
    }

    /// A connection ended: it no longer holds the room.
    fn detach(&self, room: &Room, said_hello: bool) {
        let mut state = room.lock();
        state.attached = state.attached.saturating_sub(1);
        if !said_hello {
            state.waiting = state.waiting.saturating_sub(1);
        }
        drop(state);
        // the room may be let go now
        self.dirty.lock().expect("the dirty lock").insert(room.user_id.clone());
        self.save_soon.notify_one();
    }

    fn apply<T>(&self, room: &Room, state: &mut State, f: impl FnOnce(&mut ConnectSession, &mut Env) -> T) -> T {
        let library = UserLibrary { db: &self.setup.db, user_id: &room.user_id };
        let mut rng = Rng(None);
        let mut random = |n: usize| rng.below(n);
        let mut env = Env { now: now_ms(), random: &mut random, library: &library };
        f(&mut state.session, &mut env)
    }

    /// A connection's first message. The device's id, or None when it is refused (the error went to `link`).
    fn hello(self: &Arc<Self>, room: &Arc<Room>, link: &Link, msg: &Value) -> Option<String> {
        let mut state = room.lock();
        let (id, out) = self.apply(room, &mut state, |session, env| session.hello(env, msg));
        if let Some(id) = &id {
            if let Some(old) = state.links.insert(id.clone(), link.clone()) {
                old.close(close::REPLACED, "replaced by a newer connection");
            }
            state.waiting = state.waiting.saturating_sub(1);
        }
        self.deliver(room, &mut state, out, Some(link));
        id
    }

    /// A message from a device. False: `connection` is not that device's connection any more.
    fn message(self: &Arc<Self>, room: &Arc<Room>, id: &str, connection: u64, msg: &Value) -> bool {
        let mut state = room.lock();
        if state.links.get(id).map(|link| link.connection) != Some(connection) {
            return false;
        }
        let out = self.apply(room, &mut state, |session, env| session.message(env, id, msg));
        self.deliver(room, &mut state, out, None);
        true
    }

    /// A device's connection ended: with a goodbye (it left), or without (a network loss: the grace period).
    fn gone(self: &Arc<Self>, room: &Arc<Room>, id: &str, connection: u64, goodbye: bool) {
        let mut state = room.lock();
        if state.links.get(id).map(|link| link.connection) != Some(connection) {
            return; // replaced, or closed by the server: the session knows already
        }
        state.links.remove(id);
        let out = self.apply(room, &mut state, |session, env| if goodbye { session.leave(env, id) } else { session.drop_device(env, id) });
        self.deliver(room, &mut state, out, None);
    }

    /// Time passed: the grace period may have run out.
    fn tick(self: &Arc<Self>, room: &Arc<Room>) {
        let mut state = room.lock();
        state.timer_at = None;
        let out = self.apply(room, &mut state, |session, env| session.tick(env));
        self.deliver(room, &mut state, out, None);
    }

    /// Sends what the session said, sets the grace period's timer, and notes the session for writing.
    fn deliver(self: &Arc<Self>, room: &Arc<Room>, state: &mut State, out: Vec<Out>, reply: Option<&Link>) {
        let mut out = VecDeque::from(out);
        // a broadcast is one value for all: written as text once
        let mut last: Option<(Arc<Value>, Utf8Bytes)> = None;
        while let Some(o) = out.pop_front() {
            match o {
                Out::Reply(value) => {
                    if let Some(link) = reply {
                        let _ = link.tx.try_send(Frame::Text(value.to_string().into()));
                    }
                }
                Out::Close { id, code, reason } => {
                    if let Some(link) = state.links.remove(&id) {
                        link.close(code, reason);
                    }
                }
                Out::To { to, msg } => {
                    let Some(link) = state.links.get(&to) else { continue };
                    let text = match &last {
                        Some((value, text)) if Arc::ptr_eq(value, &msg) => text.clone(),
                        _ => {
                            let text = Utf8Bytes::from(msg.to_string());
                            last = Some((msg.clone(), text.clone()));
                            text
                        }
                    };
                    if link.tx.try_send(Frame::Text(text)).is_err() {
                        // it does not read what it is sent (or is gone): as a network loss
                        if let Some(link) = state.links.remove(&to) {
                            link.kill.notify_one();
                        }
                        debug!(device = %to, "Connect: a device does not read its messages: dropped");
                        out.extend(self.apply(room, state, |session, env| session.drop_device(env, &to)));
                    }
                }
            }
        }
        match state.session.next_timer() {
            Some(at) if state.timer_at != Some(at) => {
                state.timer_at = Some(at);
                let (inner, room) = (self.clone(), room.clone());
                self.runtime.spawn(async move {
                    tokio::time::sleep(Duration::from_millis((at - now_ms()).max(0) as u64 + 5)).await;
                    let _ = tokio::task::spawn_blocking(move || inner.tick(&room)).await;
                });
            }
            Some(_) => {}
            None => state.timer_at = None,
        }
        if state.saved_rev != state.session.rev() {
            self.dirty.lock().expect("the dirty lock").insert(room.user_id.clone());
            self.save_soon.notify_one();
        }
    }

    /// Writes every changed session, and lets go of the rooms nobody needs in memory.
    fn flush(&self) {
        let users: Vec<String> = self.dirty.lock().expect("the dirty lock").drain().collect();
        if users.is_empty() {
            return;
        }
        let rooms: Vec<Arc<Room>> = {
            let all = self.rooms.lock().expect("the rooms' lock");
            users.iter().filter_map(|user| all.get(user).cloned()).collect()
        };
        let now = now_ms();
        let mut saves = Vec::new();
        let mut marks = Vec::new();
        for room in &rooms {
            let state = room.lock();
            if state.saved_rev == state.session.rev() {
                continue;
            }
            let lists = state.session.lists();
            let whole = state.saved_lists.as_ref() != Some(&lists);
            let (session, stored_lists) = store::split(state.session.save(now));
            saves.push(store::Save { user_id: room.user_id.clone(), session: session.to_string(), lists: whole.then(|| stored_lists.to_string()) });
            marks.push((room.clone(), state.session.rev(), lists, whole));
        }
        if !saves.is_empty() {
            match store::save(&self.setup.db, &saves, now) {
                Ok(written) => {
                    for ((room, rev, lists, whole), written) in marks.into_iter().zip(written) {
                        let mut state = room.lock();
                        if written {
                            state.saved_rev = rev;
                            state.saved_lists = Some(lists);
                        } else if whole {
                            // the user is gone from the database: nothing to keep
                            state.saved_rev = rev;
                        } else {
                            // the row is gone: written whole the next time
                            state.saved_lists = None;
                        }
                        if state.saved_rev != state.session.rev() {
                            self.dirty.lock().expect("the dirty lock").insert(room.user_id.clone());
                            self.save_soon.notify_one();
                        }
                    }
                }
                Err(e) => {
                    warn!(error = %e, sessions = saves.len(), "Connect: could not write sessions; trying again");
                    self.dirty.lock().expect("the dirty lock").extend(users.iter().cloned());
                    self.save_soon.notify_one();
                    return;
                }
            }
        }
        // a room without connections, without a grace period running and with nothing to write is only its row
        let mut all = self.rooms.lock().expect("the rooms' lock");
        for room in rooms {
            let state = room.lock();
            if state.attached == 0 && state.links.is_empty() && state.session.next_timer().is_none() && state.saved_rev == state.session.rev() {
                all.remove(&room.user_id);
            }
        }
    }

    fn connection_id(&self) -> u64 {
        self.next_connection.fetch_add(1, Ordering::Relaxed)
    }
}
