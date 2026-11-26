//! Sonus Connect version 2, the server's half, as pure logic (`docs/protocol/connect.md`): one user's playback
//! session, its queue and the user's devices. A port of the protocol's reference, `tools/demo-server/
//! connect-session.mjs`, statement by statement; `docs/protocol/connect-vectors.json` pins both down, and
//! `tests/connect_vectors.rs` replays it.
//!
//! No sockets, timers, clock or randomness of its own: the caller hands in each message with the time, a source of
//! random numbers and the library as the user sees it (`Env`), and gets back what to send to which device (`Out`).
//! Messages are JSON as it came (`serde_json::Value`), judged as the reference judges them, so a wrong type is
//! refused or ignored exactly as there.

use std::collections::HashSet;
use std::sync::Arc;

use serde_json::{Map, Value, json};

use super::queue::{Id, Library, MAX_MANUAL, MAX_ORDER, Mode, PlayQueue, Random, Song, window};

/// At most this many devices per user: one more closes the connection of the one silent longest (4001).
pub const MAX_DEVICES: usize = 32;
/// How long the active device stays active after its connection dropped.
pub const GRACE_MS: i64 = 10_000;
const MAX_NAME: usize = 80;
const MAX_CLIENT: usize = 120;
const KINDS: [&str; 6] = ["desktop", "web", "phone", "tablet", "speaker", "other"];

const NOTHING: &str = "没有可以播放的歌曲。";
const CANNOT_PLAY: &str = "这台设备不能播放。";
const OFFLINE: &str = "这台设备不在线。";
const NOT_ACTIVE: &str = "这台设备不是正在播放的设备。";
const STALE: &str = "队列已经变了，这个操作没有执行。";

/// What a call needs from outside: the server's time (ms since the Unix epoch), random numbers, the library.
pub struct Env<'a> {
    pub now: i64,
    pub random: Random<'a>,
    pub library: &'a dyn Library,
}

/// What to send after a call.
#[derive(Clone, Debug, PartialEq)]
pub enum Out {
    /// A message to a connected device. Broadcasts share one value.
    To { to: String, msg: Arc<Value> },
    /// The server closes that device's connection.
    Close { id: String, code: u16, reason: &'static str },
    /// The answer to a refused `hello`, to the connection that sent it (it has no device).
    Reply(Value),
}

#[derive(Clone, Debug, PartialEq)]
pub struct Device {
    pub id: String,
    pub name: String,
    pub kind: &'static str,
    pub client: String,
    pub can_play: bool,
    pub connected_at: i64,
    pub volume: f64,
    pub muted: bool,
    pub online: bool,
    pub last_seen: i64,
}

#[derive(Clone, Debug, PartialEq)]
struct Now {
    title: Option<String>,
    artist: Option<String>,
    album: Option<String>,
    album_id: Option<String>,
    cover_art: Option<String>,
}

impl Now {
    fn of(song: &Song) -> Now {
        Now {
            title: song.title.clone(),
            artist: song.artist.clone(),
            album: song.album.clone(),
            album_id: song.album_id.clone(),
            cover_art: song.cover_art.clone(),
        }
    }

    /// The reference's `pickNow`: the five fields, null for whatever is not a string.
    fn pick(value: &Value) -> Now {
        let s = |name: &str| value.get(name).and_then(Value::as_str).map(str::to_string);
        Now { title: s("title"), artist: s("artist"), album: s("album"), album_id: s("albumId"), cover_art: s("coverArt") }
    }

    fn to_json(&self) -> Value {
        json!({ "title": self.title, "artist": self.artist, "album": self.album, "albumId": self.album_id, "coverArt": self.cover_art })
    }
}

#[derive(Clone, Debug, PartialEq)]
struct Context {
    kind: Option<String>,
    id: Option<String>,
    label: Option<String>,
}

impl Context {
    fn pick(value: Option<&Value>) -> Context {
        let s = |name: &str| value.and_then(|v| v.as_object()).and_then(|o| o.get(name)).and_then(Value::as_str).map(str::to_string);
        Context { kind: s("kind"), id: s("id"), label: s("label") }
    }

    fn to_json(&self) -> Value {
        json!({ "kind": self.kind, "id": self.id, "label": self.label })
    }
}

#[derive(Clone, Debug, PartialEq)]
struct Named {
    id: String,
    name: String,
}

impl Named {
    fn to_json(&self) -> Value {
        json!({ "id": self.id, "name": self.name })
    }
}

/// The active device's connection dropped.
#[derive(Clone, Debug, PartialEq)]
struct Grace {
    device: String,
    until: i64,
    dropped_at: i64,
}

/// The grace period ran out and stopped the session.
#[derive(Clone, Debug, PartialEq)]
struct GraceStop {
    device: String,
    rev_before: u64,
    rev_after: u64,
}

/// A refused message: nothing changes, and the sender gets `error`.
struct Fail {
    code: &'static str,
    message: String,
    extra: Map<String, Value>,
}

fn fail<T>(code: &'static str, message: impl Into<String>) -> Result<T, Fail> {
    Err(Fail { code, message: message.into(), extra: Map::new() })
}

fn stale_entries<T>(entries: Vec<Value>) -> Result<T, Fail> {
    let mut extra = Map::new();
    extra.insert("entries".into(), Value::Array(entries));
    Err(Fail { code: "stale", message: STALE.into(), extra })
}

/// What a change gives besides the change.
#[derive(Default)]
struct Applied {
    out: Vec<Out>,
    /// A `hello`: the sender gets `welcome` instead of the broadcasts.
    welcome: bool,
    /// A command changed the session: reports from before it are out of date.
    command: bool,
    /// The device list goes out.
    devices: bool,
    /// The sender got its answer in `out`.
    no_ack: bool,
}

/// What a refused change is put back to (the reference's `#state`).
struct Before {
    queue: PlayQueue,
    active_device: Option<String>,
    last_device: Option<Named>,
    playing: bool,
    position_ms: i64,
    at: i64,
    duration_ms: i64,
    now: Option<Now>,
    context: Option<Context>,
    grace: Option<Grace>,
    failures: u32,
}

pub struct ConnectSession {
    queue: PlayQueue,
    /// In the order they first connected (the reference's Map): a device that reconnects keeps its place.
    devices: Vec<Device>,
    rev: u64,
    queue_rev: u64,
    active_device: Option<String>,
    last_device: Option<Named>,
    playing: bool,
    position_ms: i64,
    at: i64,
    duration_ms: i64,
    now: Option<Now>,
    context: Option<Context>,
    /// The rev after the last change a command made: older playing/paused/position reports are ignored.
    cmd_rev: u64,
    grace: Option<Grace>,
    grace_stop: Option<GraceStop>,
    /// Songs in a row that failed.
    failures: u32,
    grace_ms: i64,
    max_devices: usize,
}

// ---------------------------------------------------------------- JSON, judged as JavaScript judges it

fn num(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64).filter(|n| n.is_finite())
}

fn text(v: Option<&Value>) -> Option<&str> {
    v.and_then(Value::as_str)
}

fn boolean(v: Option<&Value>) -> Option<bool> {
    v.and_then(Value::as_bool)
}

/// An array of strings, or None.
fn strings(v: Option<&Value>) -> Option<Vec<Id>> {
    v?.as_array()?.iter().map(|x| x.as_str().map(Id::from)).collect()
}

/// `v == null` in JavaScript: missing or null.
fn nullish(v: Option<&Value>) -> bool {
    matches!(v, None | Some(Value::Null))
}

/// `Boolean(v)`.
fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// `${v}`: how a template string shows a value (in an error's message).
fn shown(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => json_number_text(n),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(items)) => items.iter().map(|x| if x.is_null() { String::new() } else { shown(Some(x)) }).collect::<Vec<_>>().join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}

fn json_number_text(n: &serde_json::Number) -> String {
    match n.as_f64() {
        Some(f) if f.fract() == 0.0 && f.abs() < 1e15 => format!("{}", f as i64),
        _ => n.to_string(),
    }
}

/// A number as JavaScript writes it in JSON: 1, not 1.0.
fn number(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 9e15 { Value::from(n as i64) } else { Value::from(n) }
}

/// `Math.round`, to milliseconds (halves go up; what no i64 holds is its nearest).
fn round(n: f64) -> i64 {
    (n + 0.5).floor() as i64
}

/// A position the active device says it is at, in the file it plays.
fn played(ms: f64) -> i64 {
    round(ms).max(0)
}

fn clamp01(n: f64) -> f64 {
    n.clamp(0.0, 1.0)
}

/// JavaScript's `String.prototype.trim`: white space and line terminators.
fn js_trim(s: &str) -> &str {
    let space = |c: char| matches!(c, '\u{9}'..='\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}');
    s.trim_matches(space)
}

/// The first `limit` UTF-16 units of a string (JavaScript's `slice(0, limit)`), never half a character.
fn js_slice(s: &str, limit: usize) -> String {
    let mut units = 0;
    s.chars()
        .take_while(|c| {
            units += c.len_utf16();
            units <= limit
        })
        .collect()
}

fn is_device_id(id: &str) -> bool {
    (8..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn ids_json(ids: &[Id]) -> Value {
    Value::Array(ids.iter().map(|id| Value::String(id.to_string())).collect())
}

impl Default for ConnectSession {
    fn default() -> Self {
        ConnectSession::new(GRACE_MS, MAX_DEVICES)
    }
}

impl ConnectSession {
    pub fn new(grace_ms: i64, max_devices: usize) -> ConnectSession {
        ConnectSession {
            queue: PlayQueue::default(),
            devices: Vec::new(),
            rev: 0,
            queue_rev: 0,
            active_device: None,
            last_device: None,
            playing: false,
            position_ms: 0,
            at: 0,
            duration_ms: 0,
            now: None,
            context: None,
            cmd_rev: 0,
            grace: None,
            grace_stop: None,
            failures: 0,
            grace_ms,
            max_devices,
        }
    }

    // ---------------------------------------------------------------- what devices see

    pub fn rev(&self) -> u64 {
        self.rev
    }

    fn has_current(&self) -> bool {
        self.queue.current.is_some()
    }

    fn current_json(&self) -> Value {
        match (&self.queue.current, &self.queue.current_key) {
            (Some(track), key) => json!({ "key": key, "trackId": &**track, "manual": key.as_deref().is_some_and(|k| k.starts_with('q')) }),
            (None, _) => Value::Null,
        }
    }

    /// The position at the server's time `t` (it moves on while playing).
    pub fn position_at(&self, t: i64) -> i64 {
        let p = if self.playing { self.position_ms.saturating_add((t - self.at).max(0)) } else { self.position_ms };
        self.held(p)
    }

    /// A position that moved on by itself, held at the song's end: the library's duration, or the position the active
    /// device last said if it is beyond that (the file is longer than the library says: a VBR MP3, say).
    fn held(&self, p: i64) -> i64 {
        if self.duration_ms > 0 { p.min(self.duration_ms.max(self.position_ms)) } else { p }
    }

    /// The session object (connect.md, Session).
    pub fn session(&self) -> Value {
        json!({
            "rev": self.rev,
            "activeDevice": self.active_device,
            "lastDevice": self.last_device.as_ref().map(Named::to_json),
            "current": self.current_json(),
            "next": self.queue.peek().as_deref(),
            "playing": self.playing,
            "positionMs": self.position_ms,
            "at": self.at,
            "durationMs": self.duration_ms,
            "now": self.now.as_ref().map(Now::to_json),
            "mode": self.queue.order.as_str(),
            "stopAfterCurrent": self.queue.stop_after_current,
            "context": self.context.as_ref().map(Context::to_json),
            "queueRev": self.queue_rev,
        })
    }

    /// The queue object (connect.md, Queue).
    pub fn queue_view(&self) -> Value {
        json!({
            "queueRev": self.queue_rev,
            "order": ids_json(&self.queue.context),
            "pointer": self.queue.pointer,
            "manual": self.queue.manual.iter().map(|m| json!({ "key": m.key, "trackId": &*m.track_id })).collect::<Vec<_>>(),
        })
    }

    /// The devices as the others list them: the connected ones, and the active one through its grace period.
    pub fn device_list(&self) -> Value {
        let mut listed: Vec<&Device> = self.devices.iter().filter(|d| d.online || self.active_device.as_deref() == Some(d.id.as_str())).collect();
        listed.sort_by(|a, b| a.connected_at.cmp(&b.connected_at).then_with(|| a.id.cmp(&b.id)));
        Value::Array(
            listed
                .into_iter()
                .map(|d| {
                    json!({
                        "id": d.id, "name": d.name, "kind": d.kind, "client": d.client, "canPlay": d.can_play,
                        "connectedAt": d.connected_at, "volume": number(d.volume), "muted": d.muted,
                    })
                })
                .collect(),
        )
    }

    /// The connected devices' ids, in the order they first connected.
    pub fn online(&self) -> Vec<String> {
        self.devices.iter().filter(|d| d.online).map(|d| d.id.clone()).collect()
    }

    pub fn is_online(&self, id: &str) -> bool {
        self.device(id).is_some_and(|d| d.online)
    }

    /// The queue's lists (the context, the context in its own order, the hand-queued songs): the large part of what
    /// is stored.
    pub fn lists(&self) -> (Vec<Id>, Vec<Id>, Vec<super::queue::Manual>) {
        (self.queue.context.clone(), self.queue.source.clone(), self.queue.manual.clone())
    }

    /// When `tick` has something to do (the grace period's end), or None.
    pub fn next_timer(&self) -> Option<i64> {
        self.grace.as_ref().map(|g| g.until)
    }

    fn device(&self, id: &str) -> Option<&Device> {
        self.devices.iter().find(|d| d.id == id)
    }

    fn forget(&mut self, id: &str) {
        self.devices.retain(|d| d.id != id);
    }

    // ---------------------------------------------------------------- connections

    /// A connection's first message. The id is None when it is refused; `out` then holds the error to send before
    /// closing.
    pub fn hello(&mut self, env: &mut Env, msg: &Value) -> (Option<String>, Vec<Out>) {
        let t = env.now;
        let id = match text(msg.get("deviceId")) {
            Some(id) if text(msg.get("type")) == Some("hello") && is_device_id(id) => id.to_string(),
            _ => {
                let mut reply = Map::new();
                reply.insert("type".into(), "error".into());
                if let Some(r) = text(msg.get("ref")) {
                    reply.insert("ref".into(), r.into());
                }
                reply.insert("code".into(), "invalid".into());
                reply.insert("message".into(), "第一条消息必须是 hello，带上设备 id（8–64 个字母、数字、_ 或 -）。".into());
                return (None, vec![Out::Reply(Value::Object(reply))]);
            }
        };
        let out = self.change(env, Some(&id), msg, |s, _| {
            let mut out = Vec::new();
            let old = s.device(&id).cloned();
            let was_online = old.as_ref().is_some_and(|d| d.online);
            // a full list: the device silent longest goes (not one connecting now)
            let online: Vec<&Device> = s.devices.iter().filter(|d| d.online && d.id != id).collect();
            if !was_online && online.len() >= s.max_devices {
                let victim = online.iter().min_by_key(|d| d.last_seen).map(|d| d.id.clone());
                if let Some(victim) = victim {
                    out.push(Out::Close { id: victim.clone(), code: 4001, reason: "too many devices" });
                    out.extend(s.drop_now(&victim, t));
                }
            }
            let name = match text(msg.get("name")).map(js_trim).filter(|n| !n.is_empty()) {
                Some(name) => js_slice(name, MAX_NAME),
                None => old.as_ref().map(|d| d.name.clone()).unwrap_or_else(|| id.clone()),
            };
            let device = Device {
                id: id.clone(),
                name,
                kind: text(msg.get("kind")).and_then(|k| KINDS.iter().copied().find(|x| *x == k)).unwrap_or("other"),
                client: match text(msg.get("client")) {
                    Some(client) => js_slice(client, MAX_CLIENT),
                    None => old.as_ref().map(|d| d.client.clone()).unwrap_or_default(),
                },
                can_play: boolean(msg.get("canPlay")).unwrap_or(true),
                connected_at: if was_online { old.as_ref().map(|d| d.connected_at).unwrap_or(t) } else { t },
                online: true,
                last_seen: t,
                volume: num(msg.get("volume")).map(clamp01).or(old.as_ref().map(|d| d.volume)).unwrap_or(1.0),
                muted: boolean(msg.get("muted")).or(old.as_ref().map(|d| d.muted)).unwrap_or(false),
            };
            let (name, can_play) = (device.name.clone(), device.can_play);
            match s.devices.iter_mut().find(|d| d.id == id) {
                Some(slot) => *slot = device,
                None => s.devices.push(device),
            }
            if s.last_device.as_ref().is_some_and(|l| l.id == id) {
                s.last_device = Some(Named { id: id.clone(), name });
            }
            if s.grace.as_ref().is_some_and(|g| g.device == id) {
                s.grace = None; // back in time: still the active device
            } else if let Some(resume) = msg.get("resume").and_then(Value::as_object) {
                let stopped = s.grace_stop.as_ref().filter(|g| g.device == id && s.rev == g.rev_after).map(|g| g.rev_before);
                let same_rev = stopped.is_some_and(|before| num(resume.get("rev")) == Some(before as f64));
                if s.active_device.is_none() && can_play && same_rev && s.has_current() {
                    // it kept playing through a short network loss, and nothing changed since: the active device again
                    s.activate(&id);
                    s.playing = truthy(resume.get("playing"));
                    if let Some(p) = num(resume.get("positionMs")) {
                        s.position_ms = played(p);
                    }
                    s.at = t;
                    s.grace_stop = None;
                    return Ok(Applied { out, welcome: true, command: true, ..Applied::default() });
                }
            }
            Ok(Applied { out, welcome: true, ..Applied::default() })
        });
        (Some(id), out)
    }

    /// That device's connection closed with a goodbye (WebSocket close code 1000 or 1001: the app closed, the user
    /// signed out). It left on purpose, so there is no grace period: if it was the active device, the session stops
    /// where it is now.
    pub fn leave(&mut self, env: &mut Env, id: &str) -> Vec<Out> {
        if !self.is_online(id) {
            return Vec::new();
        }
        if self.active_device.as_deref() != Some(id) {
            return self.drop_now(id, env.now);
        }
        self.change(env, None, &Value::Null, |s, env| {
            let t = env.now;
            s.position_ms = s.position_at(t);
            s.at = t;
            s.playing = false;
            s.active_device = None;
            s.grace = None;
            s.forget(id);
            Ok(Applied { devices: true, ..Applied::default() })
        })
    }

    /// The connection of that device went away without a goodbye (a network loss): the grace period.
    pub fn drop_device(&mut self, env: &mut Env, id: &str) -> Vec<Out> {
        self.drop_now(id, env.now)
    }

    fn drop_now(&mut self, id: &str, t: i64) -> Vec<Out> {
        let Some(device) = self.devices.iter_mut().find(|d| d.id == id && d.online) else { return Vec::new() };
        device.online = false;
        if self.active_device.as_deref() == Some(id) {
            // listed until the grace ends
            self.grace = Some(Grace { device: id.to_string(), until: t.saturating_add(self.grace_ms), dropped_at: t });
            return Vec::new();
        }
        self.forget(id);
        self.broadcast_devices(None, t)
    }

    /// Time passed: the grace period may have run out.
    pub fn tick(&mut self, env: &mut Env) -> Vec<Out> {
        let t = env.now;
        let Some(grace) = self.grace.clone().filter(|g| t >= g.until) else { return Vec::new() };
        self.grace = None;
        if self.active_device.as_deref() != Some(grace.device.as_str()) {
            return Vec::new();
        }
        let rev_before = self.rev;
        let out = self.change(env, None, &Value::Null, |s, _| {
            // stopped where it was when the connection dropped (or where a command put it since)
            let at = s.at.max(grace.dropped_at);
            let position = if s.playing { s.position_ms.saturating_add((at - s.at).max(0)) } else { s.position_ms };
            s.position_ms = s.held(position);
            s.playing = false;
            s.at = t;
            s.active_device = None;
            if !s.is_online(&grace.device) {
                s.forget(&grace.device);
            }
            Ok(Applied { devices: true, ..Applied::default() })
        });
        self.grace_stop = Some(GraceStop { device: grace.device, rev_before, rev_after: self.rev });
        out
    }

    // ---------------------------------------------------------------- messages

    /// A message from a connected device (after its hello).
    pub fn message(&mut self, env: &mut Env, id: &str, msg: &Value) -> Vec<Out> {
        let Some(device) = self.devices.iter_mut().find(|d| d.id == id && d.online) else { return Vec::new() };
        device.last_seen = env.now;
        if !(msg.is_object() || msg.is_array()) {
            return Vec::new();
        }
        match text(msg.get("type")) {
            Some("command") => self.change(env, Some(id), msg, |s, env| s.command(env, id, msg)),
            Some("report") => self.change(env, Some(id), msg, |s, env| s.report(env, id, msg)),
            Some("device") => self.change(env, Some(id), msg, |s, _| {
                if let Some(device) = s.devices.iter_mut().find(|d| d.id == id) {
                    if let Some(volume) = num(msg.get("volume")) {
                        device.volume = clamp01(volume);
                    }
                    if let Some(muted) = boolean(msg.get("muted")) {
                        device.muted = muted;
                    }
                }
                Ok(Applied { devices: true, ..Applied::default() })
            }),
            Some("hello") => vec![self.reply(id, msg, "invalid", "已经连接了。".into(), Map::new())],
            _ => vec![self.reply(id, msg, "invalid", format!("未知的消息类型：{}", shown(msg.get("type"))), Map::new())],
        }
    }

    fn reply(&self, id: &str, msg: &Value, code: &str, message: String, extra: Map<String, Value>) -> Out {
        let mut reply = Map::new();
        reply.insert("type".into(), "error".into());
        if let Some(r) = text(msg.get("ref")) {
            reply.insert("ref".into(), r.into());
        }
        reply.insert("code".into(), code.into());
        reply.insert("message".into(), message.into());
        reply.extend(extra);
        Out::To { to: id.to_string(), msg: Arc::new(Value::Object(reply)) }
    }

    /// Runs a change and works out what to send: the session to every device when it changed (rev + 1), the queue
    /// first when it changed (queueRev + 1), the device list when asked, and an ack or error to the sender.
    fn change(&mut self, env: &mut Env, id: Option<&str>, msg: &Value, apply: impl FnOnce(&mut Self, &mut Env) -> Result<Applied, Fail>) -> Vec<Out> {
        let session_before = self.session();
        let before = self.state();
        let (result, error) = match apply(self, env) {
            Ok(result) => (result, None),
            Err(e) => {
                // refused: nothing changes
                let queue_before = before.queue.clone();
                self.reset(before);
                return self.finish(env.now, id, msg, Applied::default(), Some(e), &queue_before, &session_before);
            }
        };
        self.finish(env.now, id, msg, result, error, &before.queue, &session_before)
    }

    #[allow(clippy::too_many_arguments)]
    fn finish(
        &mut self,
        t: i64,
        id: Option<&str>,
        msg: &Value,
        result: Applied,
        error: Option<Fail>,
        queue_before: &PlayQueue,
        session_before: &Value,
    ) -> Vec<Out> {
        let mut out = result.out;
        // the queue as devices see it: the context, the pointer, the hand-queued songs
        let queue_changed =
            self.queue.context != queue_before.context || self.queue.pointer != queue_before.pointer || self.queue.manual != queue_before.manual;
        if queue_changed {
            self.queue_rev += 1;
        }
        let changed = queue_changed || self.session() != *session_before;
        if changed {
            self.rev += 1;
            if result.command {
                self.cmd_rev = self.rev;
            }
        }
        let welcomed = if result.welcome { id } else { None };
        let others: Vec<String> = self.online().into_iter().filter(|x| Some(x.as_str()) != welcomed).collect();
        if let Some(id) = welcomed {
            let welcome = json!({
                "type": "welcome", "version": 2, "deviceId": id, "serverTime": t,
                "session": self.session(), "queue": self.queue_view(), "devices": self.device_list(),
            });
            out.push(Out::To { to: id.to_string(), msg: Arc::new(welcome) });
        }
        if queue_changed && !others.is_empty() {
            let queue = Arc::new(json!({ "type": "queue", "queue": self.queue_view() }));
            out.extend(others.iter().map(|to| Out::To { to: to.clone(), msg: queue.clone() }));
        }
        if changed && !others.is_empty() {
            let session = Arc::new(json!({ "type": "session", "serverTime": t, "session": self.session() }));
            out.extend(others.iter().map(|to| Out::To { to: to.clone(), msg: session.clone() }));
        }
        if result.welcome || result.devices {
            out.extend(self.broadcast_devices(welcomed, t));
        }
        match (error, id) {
            (Some(e), Some(id)) => out.push(self.reply(id, msg, e.code, e.message, e.extra)),
            (Some(_), None) => {}
            (None, Some(id)) if !result.welcome && !result.no_ack => {
                if let Some(r) = text(msg.get("ref")) {
                    out.push(Out::To { to: id.to_string(), msg: Arc::new(json!({ "type": "ack", "ref": r, "rev": self.rev })) });
                }
            }
            _ => {}
        }
        out
    }

    fn broadcast_devices(&self, except: Option<&str>, t: i64) -> Vec<Out> {
        let to: Vec<String> = self.online().into_iter().filter(|x| Some(x.as_str()) != except).collect();
        if to.is_empty() {
            return Vec::new();
        }
        let msg = Arc::new(json!({ "type": "devices", "serverTime": t, "devices": self.device_list() }));
        to.into_iter().map(|to| Out::To { to, msg: msg.clone() }).collect()
    }

    // ---------------------------------------------------------------- commands (any device)

    fn need(&self) -> Result<(), Fail> {
        if self.has_current() { Ok(()) } else { fail("nothing", NOTHING) }
    }

    /// With no active device, the sender plays (rule 6).
    fn claim(&mut self, id: &str) -> Result<(), Fail> {
        if self.active_device.is_some() {
            return Ok(());
        }
        if !self.device(id).is_some_and(|d| d.can_play) {
            return fail("cannotPlay", CANNOT_PLAY);
        }
        self.activate(id);
        Ok(())
    }

    fn set_playing(&mut self, on: bool, t: i64) {
        self.position_ms = self.position_at(t);
        self.at = t;
        self.playing = on && self.active_device.is_some();
    }

    /// The queue moved to another song (or the same one again): from its start.
    fn moved(&mut self, song: Option<Id>, key_before: &Option<String>, env: &Env) {
        self.position_ms = 0;
        self.at = env.now;
        if song.is_none() {
            self.playing = false;
            return;
        }
        if self.queue.current_key != *key_before {
            self.loaded(env.library);
        }
        self.playing = self.active_device.is_some();
    }

    fn command(&mut self, env: &mut Env, id: &str, c: &Value) -> Result<Applied, Fail> {
        if num(c.get("rev")).is_some_and(|rev| rev != self.rev as f64) {
            return fail("stale", STALE);
        }
        let action = text(c.get("action"));
        if action != Some("volume") {
            self.failures = 0; // what the user does next gets a fresh try
        }
        let t = env.now;
        let key_before = self.queue.current_key.clone();
        match action {
            Some("play") => {
                if !self.has_current() {
                    if self.queue.manual.is_empty() {
                        self.need()?;
                    }
                    self.claim(id)?;
                    let song = self.queue.next(false, env.random);
                    self.moved(song, &key_before, env);
                } else {
                    self.claim(id)?;
                    self.set_playing(true, t);
                }
            }
            Some("pause") => {
                self.need()?;
                self.set_playing(false, t);
            }
            Some("toggle") => {
                self.need()?;
                if self.playing {
                    self.set_playing(false, t);
                } else {
                    self.claim(id)?;
                    self.set_playing(true, t);
                }
            }
            Some("seek") => {
                self.need()?;
                let Some(position) = num(c.get("positionMs")) else { return fail("invalid", "seek 需要 positionMs。") };
                self.position_ms = self.clamp_position(position);
                self.at = t;
            }
            Some("next") => {
                if !self.has_current() && self.queue.manual.is_empty() {
                    self.need()?;
                }
                let song = self.queue.next(false, env.random);
                self.moved(song, &key_before, env);
            }
            Some("previous") => {
                self.need()?;
                if self.position_at(t) > 3000 {
                    self.position_ms = 0;
                    self.at = t;
                } else {
                    match self.queue.previous(env.random) {
                        Some(song) => self.moved(Some(song), &key_before, env),
                        None => {
                            self.position_ms = 0;
                            self.at = t;
                        }
                    }
                }
            }
            Some("playContext") => {
                let ids = strings(c.get("ids")).filter(|ids| !ids.is_empty());
                let Some(ids) = ids else { return fail("invalid", "playContext 需要 ids。") };
                let start_id = match c.get("startId") {
                    v if nullish(v) => None,
                    Some(Value::String(s)) => Some(s.as_str()),
                    _ => return fail("invalid", "startId 必须是字符串。"),
                };
                let order = match c.get("order") {
                    v if nullish(v) => None,
                    v => match strings(v) {
                        Some(order) => Some(order),
                        None => return fail("invalid", "order 必须是歌曲 id 的列表。"),
                    },
                };
                let shuffle = boolean(c.get("shuffle")) == Some(true);
                let mode = if shuffle && !self.queue.order.shuffled() { Mode::ShuffleTracks } else { self.queue.order };
                if mode.arranged_by_sender() && order.is_none() {
                    return fail("invalid", "按专辑或文件夹随机时，发送方要给出排好的 order。");
                }
                self.claim(id)?;
                let ids = window(&ids, start_id, MAX_ORDER);
                let arranged = if mode.arranged_by_sender() { order.as_deref().map(|o| window(o, start_id, MAX_ORDER)) } else { None };
                let song = self.queue.start(ids, start_id, shuffle, arranged, env.library, env.random);
                if song.is_none() {
                    return fail("invalid", "这些歌曲都不在媒体库里。");
                }
                self.context = Some(Context::pick(c.get("context")));
                self.moved(song, &key_before, env);
                if let Some(position) = num(c.get("positionMs")).filter(|p| *p > 0.0) {
                    self.position_ms = self.clamp_position(position);
                }
            }
            Some("jump") => {
                let Some(entry) = text(c.get("entry")) else { return fail("invalid", "jump 需要 entry。") };
                let Some(song) = self.queue.jump(entry) else { return stale_entries(vec![entry.into()]) };
                self.moved(Some(song), &key_before, env);
            }
            Some("add") => {
                let Some(ids) = strings(c.get("ids")) else { return fail("invalid", "add 需要 ids。") };
                let room = MAX_MANUAL.saturating_sub(self.queue.manual.len());
                self.queue.add(&ids, boolean(c.get("next")) == Some(true), room, env.library);
            }
            Some("move") => {
                let (Some(order), Some(keys), Some(manual)) = (strings(c.get("order")), strings(c.get("keys")), boolean(c.get("manual"))) else {
                    return fail("invalid", "move 需要 order、keys 和 manual。");
                };
                let entries = self.queue.entry_keys();
                // the keys listed, each once, in the order they first come
                let mut seen = HashSet::new();
                let listed: Vec<&Id> = order.iter().filter(|k| seen.insert(&***k)).collect();
                let unknown = |k: &&Id| !entries.contains(&***k);
                // the whole queue as the sender saw it, or nothing: a move made on an older queue would drop what came since
                if listed.len() != order.len() || listed.len() != entries.len() || listed.iter().any(unknown) || keys.iter().any(|k| !entries.contains(&**k)) {
                    let stale = keys.iter().filter(|k| !entries.contains(&***k)).chain(listed.iter().copied().filter(unknown));
                    return stale_entries(stale.map(|k| Value::String(k.to_string())).collect());
                }
                self.queue.move_entries(&order, &keys, manual);
            }
            Some("remove") => {
                let Some(remove) = strings(c.get("entries")) else { return fail("invalid", "remove 需要 entries。") };
                let entries = self.queue.entry_keys();
                let stale: Vec<Value> = remove.iter().filter(|k| !entries.contains(&***k)).map(|k| Value::String(k.to_string())).collect();
                self.queue.remove(&remove);
                if !stale.is_empty() {
                    let mut extra = Map::new();
                    extra.insert("entries".into(), Value::Array(stale));
                    let reply = self.reply(id, c, "stale", STALE.into(), extra);
                    return Ok(Applied { command: true, out: vec![reply], no_ack: true, ..Applied::default() });
                }
            }
            Some("clear") => {
                let Some(manual) = boolean(c.get("manual")) else { return fail("invalid", "clear 需要 manual。") };
                self.queue.clear(manual);
            }
            Some("mode") => {
                let Some(mode) = text(c.get("mode")).and_then(Mode::parse) else {
                    return fail("invalid", format!("未知的播放顺序：{}", shown(c.get("mode"))));
                };
                let order = strings(c.get("order"));
                if mode.arranged_by_sender() && !self.queue.context.is_empty() && order.is_none() {
                    return fail("invalid", "按专辑或文件夹随机时，发送方要给出排好的 order。");
                }
                self.queue.set_order(mode, order.as_deref(), env.library, env.random);
            }
            Some("stopAfterCurrent") => {
                let Some(on) = boolean(c.get("on")) else { return fail("invalid", "stopAfterCurrent 需要 on。") };
                self.queue.stop_after_current = on;
            }
            Some("transfer") => {
                let to = text(c.get("to")).and_then(|to| self.device(to)).filter(|d| d.online);
                let Some(to) = to else { return fail("offline", OFFLINE) };
                if !to.can_play {
                    return fail("cannotPlay", CANNOT_PLAY);
                }
                let to = to.id.clone();
                self.need()?;
                let play = boolean(c.get("play")).unwrap_or(self.playing);
                self.position_ms = self.position_at(t);
                self.at = t;
                self.activate(&to);
                self.playing = play;
            }
            Some("volume") => {
                let target = text(c.get("device")).and_then(|d| self.device(d)).filter(|d| d.online);
                let Some(target) = target else { return fail("offline", OFFLINE) };
                let (volume, muted) = (num(c.get("volume")), boolean(c.get("muted")));
                if volume.is_none() && muted.is_none() {
                    return fail("invalid", "volume 需要 volume 或 muted。");
                }
                let mut msg = Map::new();
                msg.insert("type".into(), "deviceCommand".into());
                msg.insert("action".into(), "volume".into());
                if let Some(volume) = volume {
                    msg.insert("volume".into(), number(clamp01(volume)));
                }
                if let Some(muted) = muted {
                    msg.insert("muted".into(), muted.into());
                }
                msg.insert("from".into(), id.into());
                return Ok(Applied { out: vec![Out::To { to: target.id.clone(), msg: Arc::new(Value::Object(msg)) }], ..Applied::default() });
            }
            _ => return fail("invalid", format!("未知的命令：{}", shown(c.get("action")))),
        }
        Ok(Applied { command: true, ..Applied::default() })
    }

    // ---------------------------------------------------------------- reports (the active device)

    fn report(&mut self, env: &mut Env, id: &str, r: &Value) -> Result<Applied, Fail> {
        if self.active_device.as_deref() != Some(id) {
            return fail("notActive", NOT_ACTIVE);
        }
        // about a song no longer current: ignored
        if !self.has_current() || text(r.get("key")) != self.queue.current_key.as_deref() || self.queue.current_key.is_none() {
            return fail("stale", "这首歌已经不是当前的歌曲了。");
        }
        let t = env.now;
        let key_before = self.queue.current_key.clone();
        // where the device is in the file it plays: not held to the library's duration (a file can be longer)
        let position = |s: &Self| match num(r.get("positionMs")) {
            Some(p) => played(p),
            None => s.position_at(t),
        };
        // what the device did before it followed the last command (a seek, a pause from another device) is out of date
        let late = num(r.get("rev")).is_some_and(|rev| rev < self.cmd_rev as f64);
        match text(r.get("event")) {
            Some("loaded") => {
                // the library's duration stands: a device's can be out of date (an engine that has not yet read the
                // new song's after a gapless change). Taken only when the library has none.
                if let Some(duration) = num(r.get("durationMs")).filter(|d| *d >= 0.0 && self.duration_ms == 0) {
                    self.duration_ms = round(duration);
                }
                if let Some(now) = r.get("now").filter(|n| n.is_object() || n.is_array()) {
                    self.now = Some(Now::pick(now));
                }
            }
            Some(event @ ("playing" | "paused")) => {
                if late {
                    return fail("stale", STALE);
                }
                self.position_ms = position(self);
                self.at = t;
                self.playing = event == "playing";
                if self.playing {
                    self.failures = 0;
                }
            }
            Some("position") => {
                if late {
                    return fail("stale", STALE);
                }
                self.position_ms = position(self);
                self.at = t;
            }
            Some("ended") => {
                let song = self.queue.next(true, env.random);
                self.position_ms = 0;
                self.at = t;
                if song.is_none() {
                    self.playing = false;
                } else {
                    if self.queue.current_key != key_before {
                        self.loaded(env.library);
                    }
                    self.playing = true;
                }
            }
            Some("failed") => {
                // skipped, as Spotify does: the next song (not as at an end, so repeat one does not loop on it); five
                // in a row stop the session rather than going round a list that can't play. The message names the
                // song, for any device.
                self.failures += 1;
                let failed = self.queue.current.clone();
                let title = match self.now.as_ref().and_then(|n| n.title.clone()) {
                    Some(title) => Some(title),
                    None => failed.as_ref().and_then(|f| env.library.lookup(f)).and_then(|song| song.title),
                };
                let name = match title.filter(|t| !t.is_empty()) {
                    Some(title) => format!("“{title}”"),
                    None => "这首歌".to_string(),
                };
                let song = self.queue.next(false, env.random);
                self.position_ms = 0;
                self.at = t;
                let stopped = song.is_none() || self.failures >= 5;
                if stopped {
                    self.playing = false;
                }
                if song.is_some() && self.queue.current_key != key_before {
                    self.loaded(env.library);
                }
                let message = if song.is_none() {
                    format!("无法播放{name}，后面没有歌曲了。")
                } else if self.failures >= 5 {
                    format!("无法播放{name}；连续 {} 首都无法播放，已停止播放。", self.failures)
                } else {
                    format!("无法播放{name}，已跳到下一首。")
                };
                let mut extra = Map::new();
                extra.insert("trackId".into(), failed.as_deref().map(Value::from).unwrap_or(Value::Null));
                extra.insert("stopped".into(), stopped.into());
                let reply = self.reply(id, r, "unplayable", message, extra);
                return Ok(Applied { out: vec![reply], no_ack: true, ..Applied::default() });
            }
            _ => return fail("invalid", format!("未知的报告：{}", shown(r.get("event")))),
        }
        Ok(Applied::default())
    }

    // ---------------------------------------------------------------- helpers

    fn state(&self) -> Before {
        Before {
            queue: self.queue.clone(),
            active_device: self.active_device.clone(),
            last_device: self.last_device.clone(),
            playing: self.playing,
            position_ms: self.position_ms,
            at: self.at,
            duration_ms: self.duration_ms,
            now: self.now.clone(),
            context: self.context.clone(),
            grace: self.grace.clone(),
            failures: self.failures,
        }
    }

    fn reset(&mut self, before: Before) {
        self.queue = before.queue;
        self.active_device = before.active_device;
        self.last_device = before.last_device;
        self.playing = before.playing;
        self.position_ms = before.position_ms;
        self.at = before.at;
        self.duration_ms = before.duration_ms;
        self.now = before.now;
        self.context = before.context;
        self.grace = before.grace;
        self.failures = before.failures;
    }

    fn activate(&mut self, id: &str) {
        self.active_device = Some(id.to_string());
        let name = self.device(id).map(|d| d.name.clone()).unwrap_or_else(|| id.to_string());
        self.last_device = Some(Named { id: id.to_string(), name });
        self.grace = None;
    }

    /// A new current song: what the server knows of it, until the active device reports `loaded`.
    fn loaded(&mut self, library: &dyn Library) {
        let meta = self.queue.current.as_ref().and_then(|id| library.lookup(id));
        self.duration_ms = meta.as_ref().and_then(|m| m.duration_ms).unwrap_or(0);
        self.now = meta.as_ref().map(Now::of);
    }

    /// A position a command asks for (a seek, a context started part-way): within the song as the library has it.
    fn clamp_position(&self, ms: f64) -> i64 {
        let p = round(ms).max(0);
        if self.duration_ms > 0 { p.min(self.duration_ms) } else { p }
    }

    // ---------------------------------------------------------------- kept across restarts

    /// What the server stores (rule 6): restored with no active device, paused where it was at `now`.
    pub fn save(&self, now: i64) -> Value {
        json!({
            "version": 2,
            "rev": self.rev,
            "queueRev": self.queue_rev,
            "lastDevice": self.last_device.as_ref().map(Named::to_json),
            "positionMs": self.position_at(now),
            "durationMs": self.duration_ms,
            "now": self.now.as_ref().map(Now::to_json),
            "context": self.context.as_ref().map(Context::to_json),
            "queue": self.queue.to_json(),
        })
    }

    /// A stored session, back with no active device, paused where it was. None when `saved` is not what `save`
    /// writes (the caller then starts an empty session).
    pub fn restore(saved: &Value, now: i64, grace_ms: i64, max_devices: usize) -> Option<ConnectSession> {
        let mut s = ConnectSession::new(grace_ms, max_devices);
        if saved.get("version")?.as_u64()? != 2 {
            return None;
        }
        s.rev = saved.get("rev")?.as_u64()?;
        s.queue_rev = saved.get("queueRev")?.as_u64()?;
        s.last_device = match saved.get("lastDevice")? {
            Value::Null => None,
            device => Some(Named { id: device.get("id")?.as_str()?.to_string(), name: device.get("name")?.as_str()?.to_string() }),
        };
        s.position_ms = saved.get("positionMs")?.as_i64()?.max(0);
        s.at = now;
        s.duration_ms = saved.get("durationMs")?.as_i64()?.max(0);
        s.now = match saved.get("now")? {
            Value::Null => None,
            now => Some(Now::pick(now)),
        };
        s.context = match saved.get("context")? {
            Value::Null => None,
            context => Some(Context::pick(Some(context))),
        };
        s.queue = PlayQueue::from_json(saved.get("queue")?)?;
        Some(s)
    }
}
