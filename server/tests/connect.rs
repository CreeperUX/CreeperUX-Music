//! Sonus Connect version 2 over its real WebSocket (`docs/protocol/connect.md`), through the gateway: a database
//! made as the frozen Navidrome makes it (`common::database`), the gateway's own sign-in check, and a fake Navidrome
//! that counts what reaches it (nothing of version 2 may). The session's logic itself is `connect_vectors.rs`'s to
//! check; here: the connection, the sign-in, the limits, the grace period, a goodbye, and the session kept in the
//! database.

mod common;

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use common::database;
use common::*;
use futures_util::{SinkExt, StreamExt};
use hyper::body::Incoming;
use hyper::{Request, Response, StatusCode};
use rusqlite::Connection;
use serde_json::{Value, json};
use sonus_server::config::TwoFactor;
use sonus_server::connect::{self, Connect, close};
use sonus_server::db::{self, Db};
use sonus_server::secrets::{Keys, subsonic_token};
use sonus_server::subsonic::respond::Envelope;
use sonus_server::subsonic::{Setup, Subsonic};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::{Error, Message};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

const KEY: &str = "the test's encryption key";
const SECRET_HEADER: &str = "x-sonus-user-0123456789abcdef";
const BOB_APP: &str = "wxyz-2345-6789-abcd";
const BOB_KEY: &str = "nmkj-hgfe-dcba-9876-5432-zyxw-vuts-rqpn";
const ENVELOPE: &str = r#"{"subsonic-response":{"status":"ok","version":"1.16.1","type":"navidrome","serverVersion":"0.64.2-test","openSubsonic":true,"openSubsonicExtensions":[]}}"#;
/// Navidrome's answer to `getOpenSubsonicExtensions`, as the frozen fork gives it.
const EXTENSIONS: &str = r#"{"subsonic-response":{"status":"ok","version":"1.16.1","type":"navidrome","serverVersion":"0.64.2-test","openSubsonic":true,"openSubsonicExtensions":[{"name":"formPost","versions":[1]},{"name":"sonusConnect","versions":[1]},{"name":"sonusDeviceLogin","versions":[1]}]}}"#;

const PC: &str = "pc-study-01";
const PHONE: &str = "phone-0001";

static WORLDS: AtomicUsize = AtomicUsize::new(0);

struct World {
    gateway: SocketAddr,
    connect: Connect,
    /// How many requests reached the fake Navidrome.
    reached: Arc<AtomicUsize>,
    database: PathBuf,
    dir: PathBuf,
    /// The folder is this world's to remove.
    owns: bool,
}

impl Drop for World {
    fn drop(&mut self) {
        if self.owns {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }
}

/// The users: alice (a password; the library granted), bob (two-step verification, an app password and an API key;
/// the library granted), carol (a password, no library granted), root (an admin, no library granted). Six songs.
fn make_database() -> (PathBuf, PathBuf) {
    let dir = std::env::temp_dir().join(format!("sonus-connect-test-{}-{}", std::process::id(), WORLDS.fetch_add(1, Ordering::Relaxed)));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("navidrome.db");
    let keys = Keys::new(KEY);
    let conn = database::create(&file);
    let alice = database::add_user(&conn, &keys, "alice", "sesame");
    database::grant_library(&conn, &alice);
    let bob = database::add_user(&conn, &keys, "bob", "hunter2");
    database::add_two_factor(&conn, &bob, true);
    database::add_app_password(&conn, &keys, &bob, "ap-bob", BOB_APP);
    database::add_app_password(&conn, &keys, &bob, "key-bob", BOB_KEY);
    database::grant_library(&conn, &bob);
    database::add_user(&conn, &keys, "carol", "not-granted");
    let root = database::add_user(&conn, &keys, "root", "toor-toor");
    database::make_admin(&conn, &root);
    for i in 1..=6 {
        // s1 has a picture of its own, s2 is on a disc, the others show their album's
        database::add_song(&conn, &format!("s{i}"), &format!("Song {i}"), "al1", 180.0 + i as f64 + 0.4006, i == 1, if i == 2 { 2 } else { 0 });
    }
    database::set_session_secret(&conn, &keys, "the test's session secret");
    (dir, file)
}

struct Options {
    /// `AuthRequestLimit`: failed sign-ins per window, 0 for no limit.
    limit: i64,
    tune: fn(&mut connect::Setup),
    /// The gateway answers version 2 (false: as before this server spoke it).
    connect: bool,
}

impl Default for Options {
    fn default() -> Self {
        Options { limit: 0, tune: |_| {}, connect: true }
    }
}

async fn world(options: Options) -> World {
    let (dir, file) = make_database();
    let mut world = world_on(&dir, &file, options).await;
    world.owns = true;
    world
}

/// A gateway on a database that exists: a server started (again) on it.
async fn world_on(dir: &Path, file: &Path, options: Options) -> World {
    let reached = Arc::new(AtomicUsize::new(0));
    let counter = reached.clone();
    let navidrome = upstream(move |req: Request<Incoming>| {
        let counter = counter.clone();
        async move {
            counter.fetch_add(1, Ordering::SeqCst);
            if req.uri().path().contains("getOpenSubsonicExtensions") {
                let mut response = Response::new(full(EXTENSIONS));
                response.headers_mut().insert("content-type", "application/json".parse().unwrap());
                return response;
            }
            let user = req.headers().get(SECRET_HEADER).and_then(|v| v.to_str().ok()).unwrap_or("nobody").to_string();
            Response::new(full(format!("navidrome answered {} for {user}", req.uri().path_and_query().unwrap())))
        }
    })
    .await;
    let db = Db::open(file).unwrap();
    let subsonic = Subsonic::new(Setup {
        db: db.clone(),
        keys: Keys::new(KEY),
        two_factor: TwoFactor::Optional,
        limit: options.limit,
        window: Duration::from_secs(20),
        envelope: Envelope::from_json(ENVELOPE.as_bytes()).unwrap(),
        frame_options: "DENY".into(),
    });
    // quick, so the tests are: a grace period of 400 ms, sessions written 100 ms after a change
    let mut setup = connect::Setup { grace: Duration::from_millis(400), save_after: Duration::from_millis(100), ..connect::Setup::new(db) };
    (options.tune)(&mut setup);
    let connect = tokio::task::spawn_blocking(move || Connect::new(setup)).await.unwrap().unwrap();
    let setup = GatewaySetup {
        upstream_user_header: SECRET_HEADER,
        checks_sign_ins: true,
        subsonic: Some(subsonic),
        connect: options.connect.then(|| connect.clone()),
        ..GatewaySetup::default()
    };
    let (gateway, _) = gateway(navidrome, setup).await;
    World { gateway, connect, reached, database: file.to_path_buf(), dir: dir.to_path_buf(), owns: false }
}

/// The query that signs a user in with a token, as Sonus clients do.
fn signed(user: &str, password: &str) -> String {
    format!("u={user}&t={}&s=c0ffee&v=1.16.1&c=test&f=json", subsonic_token(password.as_bytes(), b"c0ffee"))
}

fn alice() -> String {
    signed("alice", "sesame")
}

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// A device: its connection, and what it got that nobody asked for yet.
struct Device {
    ws: Socket,
    inbox: Vec<Value>,
}

impl World {
    fn url(&self, query: &str) -> String {
        format!("ws://{}/rest/connect?protocol=2&{query}", self.gateway)
    }

    /// A connection, before any hello.
    async fn open(&self, query: &str) -> Device {
        let (ws, response) = within("the WebSocket", tokio_tungstenite::connect_async(self.url(query))).await.expect("the WebSocket opens");
        assert_eq!(response.status(), StatusCode::SWITCHING_PROTOCOLS);
        Device { ws, inbox: Vec::new() }
    }

    /// A device that said hello: itself, and the welcome it got.
    async fn device(&self, query: &str, id: &str, name: &str) -> (Device, Value) {
        self.device_with(query, json!({ "type": "hello", "deviceId": id, "name": name, "kind": "desktop", "canPlay": true, "client": "the tests" })).await
    }

    async fn device_with(&self, query: &str, hello: Value) -> (Device, Value) {
        let mut device = self.open(query).await;
        device.send(hello).await;
        let welcome = device.next("welcome").await;
        (device, welcome)
    }

    /// A request for a WebSocket that must not get one: the answer's status and body.
    async fn refused(&self, url: &str) -> (StatusCode, String) {
        match within("the answer", tokio_tungstenite::connect_async(url)).await {
            Err(Error::Http(response)) => (response.status(), String::from_utf8(response.body().clone().unwrap_or_default()).unwrap()),
            other => panic!("{url}: expected a refusal, got {:?}", other.map(|(_, response)| response.status())),
        }
    }

    async fn get(&self, target: &str) -> (StatusCode, hyper::HeaderMap, String) {
        let response = send(self.gateway, Request::get(target).body(empty()).unwrap()).await;
        let (status, headers) = (response.status(), response.headers().clone());
        (status, headers, String::from_utf8(body_bytes(response.into_body()).await.to_vec()).unwrap())
    }

    fn db(&self) -> Connection {
        Connection::open(&self.database).unwrap()
    }

    /// The user's row in Connect's table: (`session`, `lists`) as JSON (None also when they are not JSON).
    fn stored(&self, user_id: &str) -> Option<(Value, Value)> {
        self.db()
            .query_row("SELECT session, lists FROM sonus_connect_session WHERE user_id = ?1", [user_id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })
            .ok()
            .and_then(|(session, lists)| Some((serde_json::from_str(&session).ok()?, serde_json::from_str(&lists).ok()?)))
    }
}

impl Device {
    async fn send(&mut self, msg: Value) {
        self.ws.send(Message::text(msg.to_string())).await.unwrap();
    }

    /// The next message from the server, or how the connection ended.
    async fn read(&mut self) -> Result<Value, Option<u16>> {
        loop {
            match within("a message", self.ws.next()).await {
                Some(Ok(Message::Text(text))) => return Ok(serde_json::from_str(text.as_str()).unwrap()),
                Some(Ok(Message::Close(frame))) => return Err(Some(frame.map(|f| u16::from(f.code)).unwrap_or(1005))),
                Some(Ok(_)) => {}
                Some(Err(_)) | None => return Err(None),
            }
        }
    }

    /// The first message (seen or to come) that matches.
    async fn find(&mut self, what: &str, matches: impl Fn(&Value) -> bool) -> Value {
        if let Some(at) = self.inbox.iter().position(&matches) {
            return self.inbox.remove(at);
        }
        loop {
            match self.read().await {
                Ok(msg) if matches(&msg) => return msg,
                Ok(msg) => self.inbox.push(msg),
                Err(end) => panic!("the connection ended ({end:?}) before {what}; got {:?}", self.inbox),
            }
        }
    }

    /// The first message of that type.
    async fn next(&mut self, kind: &str) -> Value {
        self.find(kind, |m| m["type"] == kind).await
    }

    /// The session with that rev (what an ack names).
    async fn session(&mut self, rev: &Value) -> Value {
        self.find("the session", |m| m["type"] == "session" && m["session"]["rev"] == *rev).await["session"].take()
    }

    /// Sends a command and waits for its ack: the session it gave.
    async fn command(&mut self, action: &str, fields: Value) -> Value {
        let mut msg = json!({ "type": "command", "ref": action, "action": action });
        msg.as_object_mut().unwrap().extend(fields.as_object().cloned().unwrap_or_default());
        self.send(msg).await;
        let ack = self.find("the ack", |m| m["ref"] == action && (m["type"] == "ack" || m["type"] == "error")).await;
        assert_eq!(ack["type"], "ack", "{action}: {ack}");
        self.session(&ack["rev"]).await
    }

    /// Sends a command that must be refused: the error.
    async fn refused(&mut self, action: &str, fields: Value) -> Value {
        let mut msg = json!({ "type": "command", "ref": action, "action": action });
        msg.as_object_mut().unwrap().extend(fields.as_object().cloned().unwrap_or_default());
        self.send(msg).await;
        let answer = self.find("the answer", |m| m["ref"] == action && (m["type"] == "ack" || m["type"] == "error")).await;
        assert_eq!(answer["type"], "error", "{action}: {answer}");
        answer
    }

    /// How the server closes the connection: the close code, None when it only went away.
    async fn closed(&mut self) -> Option<u16> {
        loop {
            match self.read().await {
                Ok(_) => {}
                Err(end) => return end,
            }
        }
    }

    /// Leaves with a goodbye.
    async fn goodbye(mut self) {
        self.ws.close(Some(CloseFrame { code: 1000.into(), reason: "".into() })).await.unwrap();
        let _ = self.closed().await;
    }
}

fn play(ids: &[&str], start: &str) -> Value {
    json!({ "context": { "kind": "album", "id": "al1", "label": "The Album" }, "ids": ids, "startId": start })
}

async fn until(what: &str, check: impl Fn() -> bool) {
    for _ in 0..200 {
        if check() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("timed out: {what}");
}

// ---------------------------------------------------------------- the session over the wire

#[tokio::test]
async fn two_devices_share_one_session_a_remote_steers_it_and_a_transfer_moves_it() {
    let world = world(Options::default()).await;
    let (mut pc, welcome) = world.device(&alice(), PC, "书房电脑").await;
    assert_eq!(welcome["version"], 2);
    assert_eq!(welcome["deviceId"], PC);
    assert_eq!(welcome["session"]["current"], Value::Null, "an empty session at first");
    assert_eq!(welcome["session"]["rev"], 0);
    assert_eq!(welcome["queue"], json!({ "queueRev": 0, "order": [], "pointer": -1, "manual": [] }));
    assert_eq!(welcome["devices"][0]["id"], PC);
    assert_eq!(welcome["devices"][0]["name"], "书房电脑");
    assert_eq!(welcome["devices"][0]["volume"], 1);
    let server_time = welcome["serverTime"].as_i64().unwrap();
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
    assert!((server_time - now).abs() < 5_000, "the server's clock, in ms");

    let (mut phone, welcome) = world
        .device_with(&alice(), json!({ "type": "hello", "deviceId": PHONE, "name": "手机", "kind": "phone", "canPlay": true, "client": "t", "volume": 0.5 }))
        .await;
    assert_eq!(welcome["devices"].as_array().unwrap().iter().map(|d| d["id"].as_str().unwrap()).collect::<Vec<_>>(), [PC, PHONE]);
    assert_eq!(welcome["devices"][1]["volume"], 0.5);
    let devices = pc.find("the phone in the list", |m| m["type"] == "devices" && m["devices"].as_array().unwrap().len() == 2).await;
    assert_eq!(devices["devices"][1]["kind"], "phone");

    // the PC plays an album: it becomes the active device, and the server says what the song is
    let session = pc.command("playContext", play(&["s1", "s2", "s3", "not-a-song"], "s2")).await;
    assert_eq!(session["activeDevice"], PC);
    assert_eq!(session["lastDevice"], json!({ "id": PC, "name": "书房电脑" }));
    assert_eq!(session["current"], json!({ "key": "c1:s2", "trackId": "s2", "manual": false }));
    assert_eq!(session["next"], "s3");
    assert_eq!(session["playing"], true);
    assert_eq!(session["now"], json!({ "title": "Song 2", "artist": "The Artist", "album": "The Album", "albumId": "al1", "coverArt": "dc-al1:2" }));
    assert_eq!(session["durationMs"], 182_401, "182.4006 s, to the millisecond");
    assert_eq!(session["context"], json!({ "kind": "album", "id": "al1", "label": "The Album" }));
    // the phone hears of it: the queue first, then the session
    let queue = phone.next("queue").await;
    assert_eq!(queue["queue"], json!({ "queueRev": 1, "order": ["s1", "s2", "s3"], "pointer": 1, "manual": [] }), "without the song the library lacks");
    let seen = phone.session(&session["rev"]).await;
    assert_eq!(seen, session);

    // the active device says what really happens: `now` is taken, its duration is not (the library's stands: a device's
    // can be out of date)
    pc.send(json!({ "type": "report", "ref": "r1", "event": "loaded", "key": "c1:s2", "positionMs": 0, "durationMs": 182_000, "rev": session["rev"],
        "now": { "title": "Song 2 (from the file)", "artist": "A", "album": "L", "albumId": "al1", "coverArt": "mf-s2_abc" } }))
        .await;
    let ack = pc.find("the report's ack", |m| m["ref"] == "r1").await;
    assert_eq!(ack["type"], "ack");
    let loaded = phone.session(&ack["rev"]).await;
    assert_eq!(
        (&loaded["durationMs"], &loaded["now"]["title"], &loaded["now"]["coverArt"]),
        (&json!(182_401), &json!("Song 2 (from the file)"), &json!("mf-s2_abc"))
    );

    // a remote's commands change the one session; the active device stays the PC
    let session = phone.command("seek", json!({ "positionMs": 90_000 })).await;
    assert_eq!((&session["positionMs"], &session["activeDevice"], &session["playing"]), (&json!(90_000), &json!(PC), &json!(true)));
    assert_eq!(pc.session(&session["rev"]).await, session, "the active device follows");
    let session = phone.command("next", json!({})).await;
    assert_eq!(session["current"]["trackId"], "s3");
    assert_eq!(session["now"]["coverArt"], "al-al1", "the album's picture");
    let session = phone.command("pause", json!({})).await;
    assert_eq!((&session["playing"], &session["activeDevice"]), (&json!(false), &json!(PC)));
    // a report from a device that is not active is not taken
    phone.send(json!({ "type": "report", "ref": "r2", "event": "playing", "key": "c2:s3", "positionMs": 5, "rev": session["rev"] })).await;
    assert_eq!(phone.find("the refusal", |m| m["ref"] == "r2").await["code"], "notActive");

    // the phone takes playback over: the only way the active device changes
    let session = phone.command("transfer", json!({ "to": PHONE, "play": true })).await;
    assert_eq!((&session["activeDevice"], &session["playing"], &session["lastDevice"]["name"]), (&json!(PHONE), &json!(true), &json!("手机")));
    assert_eq!(pc.session(&session["rev"]).await["activeDevice"], PHONE, "the PC is told to stop");

    // volume belongs to each device: the phone sets the PC's, as a command to it
    phone.send(json!({ "type": "command", "ref": "v", "action": "volume", "device": PC, "volume": 0.25 })).await;
    assert_eq!(pc.next("deviceCommand").await, json!({ "type": "deviceCommand", "action": "volume", "volume": 0.25, "from": PHONE }));
    pc.send(json!({ "type": "device", "volume": 0.25, "muted": false })).await;
    let devices = phone.find("the PC's volume", |m| m["type"] == "devices" && m["devices"][0]["volume"] == 0.25).await;
    assert_eq!(devices["devices"][0]["id"], PC);

    // what cannot be done is said, and changes nothing
    assert_eq!(phone.refused("transfer", json!({ "to": "nobody-here" })).await["code"], "offline");
    assert_eq!(
        phone.refused("jump", json!({ "entry": "c9:s9" })).await,
        json!({ "type": "error", "ref": "jump", "code": "stale", "message": "队列已经变了，这个操作没有执行。", "entries": ["c9:s9"] })
    );
    assert_eq!(phone.refused("dance", json!({})).await["code"], "invalid");
    assert_eq!(world.reached.load(Ordering::SeqCst), 0, "none of it reached Navidrome");
}

#[tokio::test]
async fn a_user_plays_only_what_they_may_see_and_never_reaches_another_users_session() {
    let world = world(Options::default()).await;
    let (mut alice_pc, _) = world.device(&alice(), PC, "Alice's PC").await;
    alice_pc.command("playContext", play(&["s1", "s2"], "s1")).await;

    // bob signs in with his API key: his own session, empty, with only his device, though the device id is the same
    let (mut bob_pc, welcome) = world.device(&format!("apiKey={BOB_KEY}&v=1.16.1&c=test"), PC, "Bob's PC").await;
    assert_eq!(welcome["session"]["current"], Value::Null);
    assert_eq!(welcome["devices"].as_array().unwrap().len(), 1);
    assert_eq!(welcome["devices"][0]["name"], "Bob's PC");
    // nothing he sends names a user: alice's device is not there for him
    let (mut alice_phone, _) = world.device(&alice(), PHONE, "Alice's phone").await;
    assert_eq!(bob_pc.refused("transfer", json!({ "to": PHONE })).await["code"], "offline");
    assert_eq!(bob_pc.refused("volume", json!({ "device": PHONE, "volume": 0 })).await["code"], "offline");
    assert_eq!(bob_pc.refused("pause", json!({})).await["code"], "nothing", "his session has no song");
    let session = bob_pc.command("playContext", play(&["s4"], "s4")).await;
    assert_eq!(session["activeDevice"], PC);
    // alice's session is as she left it, and her devices heard nothing of bob's
    let hers = world.connect.peek("id-alice").unwrap();
    assert_eq!(hers["session"]["current"]["trackId"], "s1");
    assert_eq!(hers["devices"].as_array().unwrap().iter().map(|d| d["name"].as_str().unwrap()).collect::<Vec<_>>(), ["Alice's PC", "Alice's phone"]);
    alice_phone.send(json!({ "type": "command", "ref": "p", "action": "pause" })).await;
    let ack = alice_phone.find("the ack", |m| m["ref"] == "p").await;
    assert!(alice_phone.inbox.iter().chain(&alice_pc.inbox).all(|m| m.to_string().find("Bob").is_none() && m.to_string().find("s4").is_none()));
    assert_eq!(alice_pc.session(&ack["rev"]).await["playing"], false);
    assert_eq!(world.connect.peek("id-bob").unwrap()["session"]["playing"], true, "and bob's plays on");

    // carol was granted no library: to her no song exists
    let (mut carol, _) = world.device(&signed("carol", "not-granted"), PC, "Carol's PC").await;
    let refused = carol.refused("playContext", play(&["s1", "s2"], "s1")).await;
    assert_eq!((&refused["code"], &refused["message"]), (&json!("invalid"), &json!("这些歌曲都不在媒体库里。")));
    carol.send(json!({ "type": "command", "ref": "a", "action": "add", "ids": ["s1"] })).await;
    let ack = carol.find("the ack", |m| m["ref"] == "a").await;
    assert_eq!(ack["rev"], 0, "nothing was queued");
    // an admin sees every library, granted or not
    let (mut root, _) = world.device(&signed("root", "toor-toor"), PC, "Root's PC").await;
    let session = root.command("playContext", play(&["s1", "s2"], "s1")).await;
    assert_eq!(session["now"]["coverArt"], "mf-s1", "the song's own picture");
}

// ---------------------------------------------------------------- signing in

#[tokio::test]
async fn no_connection_without_a_signed_in_user() {
    let world = world(Options::default()).await;
    let error = |code: i32, message: &str| {
        format!(
            r#"{{"subsonic-response":{{"status":"failed","version":"1.16.1","type":"navidrome","serverVersion":"0.64.2-test","openSubsonic":true,"error":{{"code":{code},"message":"{message}"}}}}}}"#
        )
    };
    let wrong = error(40, "Wrong username or password");
    // refused as any Subsonic request is: Navidrome's answer, with HTTP 200, and no WebSocket
    for (query, expect) in [
        (signed("alice", "wrong"), wrong.clone()),
        (signed("nobody", "sesame"), wrong.clone()),
        ("u=alice&p=wrong&v=1.16.1&c=test&f=json".to_string(), wrong.clone()),
        ("u=alice&v=1.16.1&c=test&f=json".to_string(), wrong.clone()),
        // bob has two-step verification: his account password does not sign
        (signed("bob", "hunter2"), wrong.clone()),
        ("v=1.16.1&c=test&f=json".to_string(), error(10, "missing parameter: 'u'")),
        ("u=alice&p=sesame&v=1.16.1&f=json".to_string(), error(10, "missing parameter: 'c'")),
        ("apiKey=not-a-key&v=1.16.1&c=test&f=json".to_string(), error(44, "Invalid API key")),
        (format!("apiKey={BOB_KEY}&u=bob&v=1.16.1&c=test&f=json"), error(43, "Multiple conflicting authentication mechanisms provided")),
    ] {
        assert_eq!(world.refused(&world.url(&query)).await, (StatusCode::OK, expect), "{query}");
    }
    // a web session's token is not a Subsonic credential: version 2 does not take it
    let (status, _) = world.refused(&world.url("u=alice&jwt=abc.def.ghi&v=1.16.1&c=test")).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    // a client cannot name itself a user
    let request = Request::get("/rest/connect?protocol=2&v=1.16.1&c=test&f=json")
        .header("Remote-User", "alice")
        .header(SECRET_HEADER, "alice")
        .header("connection", "Upgrade")
        .header("upgrade", "websocket")
        .header("sec-websocket-version", "13")
        .header("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ==")
        .body(empty())
        .unwrap();
    let response = send(world.gateway, request).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(String::from_utf8(body_bytes(response.into_body()).await.to_vec()).unwrap(), error(10, "missing parameter: 'u'"));
    // signed in, but not a WebSocket request
    let (status, headers, _) = world.get(&format!("/rest/connect?protocol=2&{}", alice())).await;
    assert_eq!(status, StatusCode::UPGRADE_REQUIRED);
    assert_eq!(headers["sec-websocket-version"], "13");
    assert_eq!(world.connect.rooms(), 0, "nobody got a session");
    assert_eq!(world.reached.load(Ordering::SeqCst), 0, "and Navidrome saw none of it");

    // the ways in: a token, a password, `enc:`, an app password (with two-step verification), an API key
    for query in [
        alice(),
        "u=alice&p=sesame&v=1.16.1&c=test".to_string(),
        "u=ALICE&p=enc:736573616d65&v=1.16.1&c=test".to_string(),
        signed("bob", BOB_APP),
        format!("apiKey={BOB_KEY}&v=1.16.1&c=test"),
    ] {
        let (device, welcome) = world.device(&query, "signs-in-01", "x").await;
        assert_eq!(welcome["version"], 2, "{query}");
        device.goodbye().await;
    }
    // `rest/connect.view` is the same door
    let url = format!("ws://{}/rest/connect.view?protocol=2&{}", world.gateway, alice());
    let (mut ws, _) = tokio_tungstenite::connect_async(url).await.unwrap();
    ws.send(Message::text(json!({ "type": "hello", "deviceId": "signs-in-02" }).to_string())).await.unwrap();
    let welcome: Value = serde_json::from_str(within("welcome", ws.next()).await.unwrap().unwrap().to_text().unwrap()).unwrap();
    assert_eq!(welcome["type"], "welcome");
}

#[tokio::test]
async fn failed_sign_ins_count_against_the_same_limit_as_any_subsonic_request() {
    let world = world(Options { limit: 2, ..Options::default() }).await;
    let wrong = world.url(&signed("alice", "wrong"));
    // one failure at the WebSocket, one at a plain Subsonic request: the limit of two is reached
    assert_eq!(world.refused(&wrong).await.0, StatusCode::OK);
    let (_, _, body) = world.get(&format!("/rest/ping?{}", signed("alice", "wrong"))).await;
    assert!(body.contains(r#""code":40"#), "{body}");
    // now the right password is refused too, at both doors
    let (status, body) = world.refused(&world.url(&alice())).await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.contains(r#""code":40"#), "{body}");
    let (_, _, body) = world.get(&format!("/rest/ping?{}", alice())).await;
    assert!(body.contains(r#""code":40"#), "{body}");
    // another user is not limited by it
    let (device, _) = world.device(&signed("root", "toor-toor"), PC, "x").await;
    device.goodbye().await;
}

#[tokio::test]
async fn without_protocol_2_the_request_is_version_1s_and_navidromes() {
    let world = world(Options::default()).await;
    for query in [alice(), format!("protocol=1&{}", alice()), format!("{}&protocol=", alice())] {
        let (status, _, body) = world.get(&format!("/rest/connect?{query}")).await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.starts_with("navidrome answered /rest/connect?") && body.ends_with(" for alice"), "signed in here, answered there: {body}");
        assert!(!body.contains("t=") && !body.contains("s=c0ffee"), "without its credentials: {body}");
    }
    assert_eq!(world.reached.load(Ordering::SeqCst), 3);
    // a gateway that does not answer version 2 passes protocol=2 on as well, and Navidrome speaks version 1
    let world = self::world(Options { connect: false, ..Options::default() }).await;
    let (_, _, body) = world.get(&format!("/rest/connect?protocol=2&{}", alice())).await;
    assert!(body.starts_with("navidrome answered /rest/connect?protocol=2"), "{body}");
}

#[tokio::test]
async fn the_extensions_list_gains_version_2_only_when_the_server_speaks_it() {
    let world = world(Options::default()).await;
    let expect = EXTENSIONS.replace(r#"{"name":"sonusConnect","versions":[1]}"#, r#"{"name":"sonusConnect","versions":[1,2]}"#);
    for path in ["/rest/getOpenSubsonicExtensions", "/rest/getOpenSubsonicExtensions.view?f=json"] {
        let (status, headers, body) = world.get(path).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, expect, "Navidrome's answer, with version 2 beside version 1");
        assert_eq!(headers["content-length"], expect.len().to_string().as_str());
        assert_eq!(headers["content-type"], "application/json");
    }
    let quiet = self::world(Options { connect: false, ..Options::default() }).await;
    let (_, _, body) = quiet.get("/rest/getOpenSubsonicExtensions").await;
    assert_eq!(body, EXTENSIONS, "as Navidrome answered");
}

// ---------------------------------------------------------------- the connection's rules

#[tokio::test]
async fn hello_comes_first_and_in_time() {
    let world = world(Options { tune: |setup| setup.hello_within = Duration::from_millis(300), ..Options::default() }).await;
    // anything else first: an error, and the connection is closed
    let mut device = world.open(&alice()).await;
    device.send(json!({ "type": "command", "ref": "1", "action": "play" })).await;
    let error = device.next("error").await;
    assert_eq!((&error["code"], &error["ref"]), (&json!("invalid"), &json!("1")));
    assert_eq!(device.closed().await, Some(close::POLICY));
    // a device id that is not one
    let mut device = world.open(&alice()).await;
    device.send(json!({ "type": "hello", "deviceId": "bad id" })).await;
    assert_eq!(device.next("error").await["code"], "invalid");
    assert_eq!(device.closed().await, Some(close::POLICY));
    // what is not JSON is not a message; the hello after it is taken
    let mut device = world.open(&alice()).await;
    device.ws.send(Message::text("not json")).await.unwrap();
    device.ws.send(Message::binary(vec![1, 2, 3])).await.unwrap();
    device.send(json!({ "type": "hello", "deviceId": "after-noise-1" })).await;
    assert_eq!(device.next("welcome").await["devices"][0]["name"], "after-noise-1", "a device without a name is called by its id");
    // a second hello is refused, and the connection stays
    device.send(json!({ "type": "hello", "ref": "again", "deviceId": "after-noise-1" })).await;
    assert_eq!(device.find("the refusal", |m| m["ref"] == "again").await["code"], "invalid");
    // no hello at all
    let started = std::time::Instant::now();
    let mut silent = world.open(&alice()).await;
    assert_eq!(silent.closed().await, Some(close::POLICY));
    assert!(started.elapsed() >= Duration::from_millis(280), "after the time a hello may take");
    // the device that did say hello is still there
    device.send(json!({ "type": "device", "ref": "still", "volume": 0.5 })).await;
    assert_eq!(device.find("the ack", |m| m["ref"] == "still").await["type"], "ack");
}

#[tokio::test]
async fn a_message_is_at_most_one_mebibyte() {
    let world = world(Options::default()).await;
    let (mut pc, _) = world.device(&alice(), PC, "PC").await;
    let (mut phone, _) = world.device(&alice(), PHONE, "Phone").await;
    // just under the limit: taken (65,000 ids, of which the library has two)
    let mut ids: Vec<String> = (0..65_000).map(|i| format!("filler-{i:06}")).collect();
    ids.extend(["s1".to_string(), "s2".to_string()]);
    let big = json!({ "type": "command", "ref": "big", "action": "playContext", "ids": ids, "startId": "s1" }).to_string();
    assert!(big.len() > 900_000 && big.len() < connect::MAX_MESSAGE_BYTES);
    pc.ws.send(Message::text(big)).await.unwrap();
    let ack = pc.find("the ack", |m| m["ref"] == "big").await;
    assert_eq!(ack["type"], "ack", "{ack}");
    assert_eq!(phone.next("queue").await["queue"]["order"], json!(["s1", "s2"]));
    // over it: closed with 1009
    let too_big = json!({ "type": "command", "action": "add", "ids": [], "padding": "x".repeat(connect::MAX_MESSAGE_BYTES) }).to_string();
    let _ = pc.ws.send(Message::text(too_big)).await;
    assert_eq!(pc.closed().await, Some(close::TOO_BIG));
    // to the session that is a network loss: the PC, active, stays listed through its grace period
    let stopped = phone.find("the session stopping", |m| m["type"] == "session" && m["session"]["activeDevice"].is_null()).await;
    assert_eq!(stopped["session"]["playing"], false);
}

#[tokio::test]
async fn the_same_device_connecting_again_replaces_its_older_connection() {
    let world = world(Options::default()).await;
    let (mut first, _) = world.device(&alice(), PC, "PC").await;
    let (mut phone, _) = world.device(&alice(), PHONE, "Phone").await;
    first.command("playContext", play(&["s1", "s2"], "s1")).await;
    let (mut second, welcome) = world.device(&alice(), PC, "PC, again").await;
    assert_eq!(first.closed().await, Some(close::REPLACED));
    assert_eq!(welcome["session"]["activeDevice"], PC, "still the active device");
    assert_eq!(welcome["session"]["playing"], true);
    assert_eq!(welcome["devices"].as_array().unwrap().len(), 2, "one device, not two");
    assert_eq!(welcome["session"]["lastDevice"]["name"], "PC, again");
    // the old connection's end is not the device's: no grace period started, the session plays on
    tokio::time::sleep(Duration::from_millis(600)).await;
    let session = second.command("seek", json!({ "positionMs": 1000 })).await;
    assert_eq!((&session["activeDevice"], &session["playing"]), (&json!(PC), &json!(true)));
    assert!(phone.inbox.iter().all(|m| m["type"] != "session" || !m["session"]["activeDevice"].is_null()));
    let _ = phone.session(&session["rev"]).await;
}

#[tokio::test]
async fn the_thirty_third_device_closes_the_one_silent_longest() {
    let world = world(Options::default()).await;
    let mut devices = Vec::new();
    for i in 0..32 {
        devices.push(world.device(&alice(), &format!("device-{i:04}"), &format!("Device {i}")).await.0);
        tokio::time::sleep(Duration::from_millis(2)).await; // each a little later than the one before
    }
    // the first speaks again, so the second is the one silent longest
    devices[0].send(json!({ "type": "device", "ref": "awake", "volume": 0.9 })).await;
    devices[0].find("the ack", |m| m["ref"] == "awake").await;
    let (_, welcome) = world.device(&alice(), "device-0032", "Device 32").await;
    assert_eq!(devices[1].closed().await, Some(close::TOO_MANY_DEVICES));
    let listed: Vec<&str> = welcome["devices"].as_array().unwrap().iter().map(|d| d["id"].as_str().unwrap()).collect();
    assert_eq!(listed.len(), 32);
    assert!(listed.contains(&"device-0000") && listed.contains(&"device-0032") && !listed.contains(&"device-0001"));
    // connections that never say hello are bounded too
    let mut waiting = Vec::new();
    for _ in 0..8 {
        waiting.push(world.open(&alice()).await);
    }
    let mut ninth = world.open(&alice()).await;
    assert_eq!(ninth.closed().await, Some(close::TRY_AGAIN_LATER));
    // another user's devices are not counted with alice's
    let (_root, welcome) = world.device(&signed("root", "toor-toor"), PC, "x").await;
    assert_eq!(welcome["devices"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn the_server_pings_and_a_silent_connection_is_closed() {
    let tune = |setup: &mut connect::Setup| {
        setup.ping_every = Duration::from_millis(100);
        setup.silence = Duration::from_millis(350);
    };
    let world = world(Options { tune, ..Options::default() }).await;
    let (mut pc, _) = world.device(&alice(), PC, "PC").await;
    let (mut phone, _) = world.device(&alice(), PHONE, "Phone").await;
    pc.command("playContext", play(&["s1", "s2"], "s1")).await;
    // the phone reads, so it sees the pings and answers them (its library does): it stays connected
    let mut pings = 0;
    let started = std::time::Instant::now();
    while started.elapsed() < Duration::from_millis(900) {
        match tokio::time::timeout(Duration::from_millis(50), phone.ws.next()).await {
            Ok(Some(Ok(Message::Ping(_)))) => pings += 1,
            Ok(Some(Ok(Message::Text(text)))) => phone.inbox.push(serde_json::from_str(text.as_str()).unwrap()),
            Ok(Some(Ok(_))) | Err(_) => {}
            Ok(other) => panic!("the phone's connection ended: {other:?}"),
        }
        phone.ws.flush().await.unwrap(); // the pong
    }
    assert!((3..=10).contains(&pings), "a ping every 100 ms: {pings}");
    // the PC did not read all that time, so it answered no ping: silent for 350 ms, it is gone; after the grace
    // period the session stops
    let stopped = phone.find("the session stopping", |m| m["type"] == "session" && m["session"]["activeDevice"].is_null()).await;
    assert_eq!(stopped["session"]["playing"], false);
    assert_eq!(pc.closed().await, None, "cut without a close frame, as a connection that is gone");
    phone.send(json!({ "type": "device", "ref": "alive", "volume": 1 })).await;
    assert_eq!(phone.find("the ack", |m| m["ref"] == "alive").await["type"], "ack");
}

// ---------------------------------------------------------------- lifetime

#[tokio::test]
async fn a_lost_connection_has_a_grace_period_and_a_resume_and_a_goodbye_has_none() {
    // a grace period long enough to tell "at once" from "after it" on a slow machine
    let world = world(Options { tune: |setup| setup.grace = Duration::from_millis(1200), ..Options::default() }).await;
    let (mut pc, _) = world.device(&alice(), PC, "PC").await;
    let (mut phone, _) = world.device(&alice(), PHONE, "Phone").await;
    let session = pc.command("playContext", play(&["s1", "s2", "s3"], "s1")).await;

    // the PC's connection is lost (no goodbye), and it is back within the grace period: still the active device
    drop(pc);
    tokio::time::sleep(Duration::from_millis(150)).await;
    let listed = world.connect.peek("id-alice").unwrap();
    assert_eq!(listed["devices"].as_array().unwrap().len(), 2, "listed through its grace period");
    assert_eq!(listed["session"]["activeDevice"], PC);
    let (mut pc, welcome) = world.device(&alice(), PC, "PC").await;
    assert_eq!((&welcome["session"]["activeDevice"], &welcome["session"]["playing"], &welcome["session"]["rev"]), (&json!(PC), &json!(true), &session["rev"]));
    tokio::time::sleep(Duration::from_millis(1500)).await;
    pc.send(json!({ "type": "report", "ref": "p", "event": "position", "key": "c0:s1", "positionMs": 5_000, "rev": session["rev"] })).await;
    let ack = pc.find("the ack", |m| m["ref"] == "p").await;
    assert_eq!(ack["type"], "ack", "the grace period was over when it came back: {ack}");
    let before = phone.session(&ack["rev"]).await;
    assert_eq!(before["activeDevice"], PC);

    // lost for longer than the grace period: the session stops where it was, with no active device
    drop(pc);
    let stopped = phone.find("the session stopping", |m| m["type"] == "session" && m["session"]["activeDevice"].is_null()).await["session"].take();
    assert_eq!(stopped["playing"], false);
    assert_eq!(stopped["lastDevice"]["id"], PC);
    assert!(
        stopped["positionMs"].as_i64().unwrap() >= 5_000 && stopped["positionMs"].as_i64().unwrap() < 6_000,
        "where it was when the connection dropped: {stopped}"
    );
    assert_eq!(stopped["rev"].as_u64().unwrap(), before["rev"].as_u64().unwrap() + 1);
    let devices = phone.find("the PC gone", |m| m["type"] == "devices" && m["devices"].as_array().unwrap().len() == 1).await;
    assert_eq!(devices["devices"][0]["id"], PHONE);
    // it kept playing through the loss, and nothing changed since: its resume makes it the active device again
    let hello = json!({ "type": "hello", "deviceId": PC, "name": "PC", "kind": "desktop", "canPlay": true, "client": "t", "resume": { "rev": before["rev"], "playing": true, "positionMs": 9_000 } });
    let (pc, welcome) = world.device_with(&alice(), hello.clone()).await;
    assert_eq!(
        (&welcome["session"]["activeDevice"], &welcome["session"]["playing"], &welcome["session"]["positionMs"]),
        (&json!(PC), &json!(true), &json!(9_000))
    );
    let resumed = phone.session(&welcome["session"]["rev"]).await;
    assert_eq!((&resumed["activeDevice"], &resumed["positionMs"]), (&json!(PC), &json!(9_000)), "the others are told");

    // lost again, and something changes meanwhile: the resume is not taken
    drop(pc);
    phone.find("the session stopping", |m| m["type"] == "session" && m["session"]["activeDevice"].is_null()).await;
    let moved = phone.command("next", json!({})).await;
    assert_eq!(
        (&moved["current"]["trackId"], &moved["playing"], &moved["activeDevice"]),
        (&json!("s2"), &json!(false), &Value::Null),
        "a remote moves the session, paused"
    );
    let (pc, welcome) = world.device_with(&alice(), hello).await;
    assert_eq!(
        (&welcome["session"]["activeDevice"], &welcome["session"]["current"]["trackId"]),
        (&Value::Null, &json!("s2")),
        "it stops, and shows the session as it now is"
    );

    // a goodbye: the PC takes playback, then leaves on purpose; the session stops at once
    let mut pc = pc;
    let playing = pc.command("play", json!({})).await;
    assert_eq!(playing["activeDevice"], PC);
    phone.session(&playing["rev"]).await;
    let left = std::time::Instant::now();
    pc.goodbye().await;
    let stopped = phone.find("the session stopping", |m| m["type"] == "session" && m["session"]["activeDevice"].is_null()).await;
    assert!(left.elapsed() < Duration::from_millis(900), "no grace period");
    assert_eq!(stopped["session"]["playing"], false);
    // so another device can play it straight away
    let taken = phone.command("play", json!({})).await;
    assert_eq!((&taken["activeDevice"], &taken["playing"]), (&json!(PHONE), &json!(true)));
}

#[tokio::test]
async fn the_session_is_kept_in_the_database_and_is_back_after_a_restart() {
    let (dir, file) = make_database();
    let world = world_on(&dir, &file, Options::default()).await;
    // the server's own tables, beside Navidrome's, which still pass the start-up check
    let tables: Vec<String> = world
        .db()
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'sonus_%' ORDER BY name")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert_eq!(tables, ["sonus_app_password", "sonus_connect_session", "sonus_recovery_code", "sonus_server_schema", "sonus_two_factor"]);
    assert_eq!(world.db().query_row("SELECT version FROM sonus_server_schema WHERE part = 'connect'", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
    db::check_schema(&world.db()).unwrap();
    assert!(world.stored("id-alice").is_none(), "nothing is written for a session nobody changed");

    let (mut pc, _) = world.device(&alice(), PC, "书房电脑").await;
    pc.command("playContext", play(&["s1", "s2", "s3", "s4"], "s2")).await;
    pc.command("add", json!({ "ids": ["s6"] })).await;
    pc.command("mode", json!({ "mode": "repeatAll" })).await;
    let session = pc.command("seek", json!({ "positionMs": 42_000 })).await;
    // written within a second of the change, while the server runs
    until("the session written", || world.stored("id-alice").is_some_and(|(stored, _)| stored["rev"] == session["rev"])).await;
    let (stored, lists) = world.stored("id-alice").unwrap();
    assert_eq!(stored["queue"], json!({ "pointer": 1, "nextId": 1, "current": "s2", "currentKey": "c1:s2", "order": "repeatAll", "stopAfterCurrent": false }));
    assert_eq!(lists, json!({ "context": ["s1", "s2", "s3", "s4"], "source": ["s1", "s2", "s3", "s4"], "manual": [{ "key": "q1", "trackId": "s6" }] }));
    // a change of the position alone rewrites the small part only
    world.db().execute("UPDATE sonus_connect_session SET lists = '\"untouched\"'", []).unwrap();
    let session = pc.command("seek", json!({ "positionMs": 50_000 })).await;
    until("the session written", || world.stored("id-alice").is_some_and(|(stored, _)| stored["rev"] == session["rev"])).await;
    assert_eq!(world.stored("id-alice").unwrap().1, json!("untouched"));
    world.db().execute("UPDATE sonus_connect_session SET lists = ?1", [lists.to_string()]).unwrap();

    // the last change comes right before the server stops: written at shutdown
    let session = pc.command("pause", json!({})).await;
    let session = { pc.command("seek", json!({ "positionMs": 61_000 })).await["rev"].clone().as_u64().unwrap().max(session["rev"].as_u64().unwrap()) };
    within("the server stopping", world.connect.stop()).await;
    assert_eq!(world.stored("id-alice").unwrap().0["rev"], session);
    assert_eq!(pc.closed().await, Some(close::GOING_AWAY));
    let (status, _) = world.refused(&world.url(&alice())).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "a stopping server takes no new device");
    drop(world);

    // a new server on the same database: the session is back, with no active device, paused where it was
    let world = world_on(&dir, &file, Options::default()).await;
    let (mut laptop, welcome) = world.device(&alice(), "laptop-0001", "笔记本").await;
    let restored = &welcome["session"];
    assert_eq!(restored["activeDevice"], Value::Null);
    assert_eq!(restored["lastDevice"], json!({ "id": PC, "name": "书房电脑" }));
    assert_eq!(restored["current"], json!({ "key": "c1:s2", "trackId": "s2", "manual": false }));
    assert_eq!((&restored["playing"], &restored["positionMs"], &restored["mode"]), (&json!(false), &json!(61_000), &json!("repeatAll")));
    assert_eq!(restored["now"]["title"], "Song 2");
    assert_eq!(restored["rev"], session);
    assert_eq!(welcome["queue"]["order"], json!(["s1", "s2", "s3", "s4"]));
    assert_eq!(welcome["queue"]["manual"], json!([{ "key": "q1", "trackId": "s6" }]));
    assert_eq!(welcome["devices"].as_array().unwrap().len(), 1, "devices are not kept");
    // whichever device presses play continues it where it stopped, and becomes the active device
    let playing = laptop.command("play", json!({})).await;
    assert_eq!((&playing["activeDevice"], &playing["playing"], &playing["positionMs"]), (&json!("laptop-0001"), &json!(true), &json!(61_000)));
    // the hand-queued song's key is still its key
    let jumped = laptop.command("jump", json!({ "entry": "q1" })).await;
    assert_eq!(jumped["current"], json!({ "key": "q1", "trackId": "s6", "manual": true }));

    // with everyone gone and everything written, the session is only its row
    laptop.goodbye().await;
    until("the room let go", || world.connect.rooms() == 0).await;
    let (stored, _) = world.stored("id-alice").unwrap();
    assert_eq!(stored["queue"]["currentKey"], "q1");
    assert!(stored["positionMs"].as_i64().unwrap() < 1_000, "where the laptop left it, a moment into the song: {stored}");
    // and the row goes with the user (Navidrome deletes users; its connections have foreign keys on, as here)
    let conn = world.db();
    conn.execute_batch("PRAGMA foreign_keys=ON; DELETE FROM user WHERE id = 'id-alice';").unwrap();
    assert!(world.stored("id-alice").is_none());
    drop(world);
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_stored_session_this_server_did_not_write_starts_an_empty_one() {
    let (dir, file) = make_database();
    {
        let world = world_on(&dir, &file, Options::default()).await;
        let (mut pc, _) = world.device(&alice(), PC, "PC").await;
        pc.command("playContext", play(&["s1"], "s1")).await;
        world.connect.stop().await;
    }
    for (session, lists) in [("not json", "{}"), (r#"{"version":3}"#, "{}"), (r#"{"version":2,"rev":"7"}"#, r#"{"context":[],"source":[],"manual":[]}"#)] {
        Connection::open(&file).unwrap().execute("UPDATE sonus_connect_session SET session = ?1, lists = ?2", (session, lists)).unwrap();
        let world = world_on(&dir, &file, Options::default()).await;
        let (mut pc, welcome) = world.device(&alice(), PC, "PC").await;
        assert_eq!((&welcome["session"]["rev"], &welcome["session"]["current"]), (&json!(0), &Value::Null), "{session}");
        // and it is written whole again at its first change
        let played = pc.command("playContext", play(&["s3"], "s3")).await;
        until("the session written", || world.stored("id-alice").is_some_and(|(stored, _)| stored["rev"] == played["rev"])).await;
        assert_eq!(world.stored("id-alice").unwrap().1["context"], json!(["s3"]));
        world.connect.stop().await;
    }
    // tables from a newer server: this one does not run on them
    Connection::open(&file).unwrap().execute("UPDATE sonus_server_schema SET version = 2 WHERE part = 'connect'", []).unwrap();
    let db = Db::open(&file).unwrap();
    let refused = tokio::task::spawn_blocking(move || Connect::new(connect::Setup::new(db))).await.unwrap();
    assert!(refused.err().unwrap().contains("newer server"));
    let _ = std::fs::remove_dir_all(&dir);
}
