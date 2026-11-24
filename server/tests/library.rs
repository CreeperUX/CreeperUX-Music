//! The library's reads answered by the gateway (`src/library`), on a database with Navidrome's own tables
//! (`common/library.sql`), in front of a fake Navidrome that registers players as the real one does (a cookie for a
//! `ping`) and records everything that reaches it. What reaches it is half of what is asserted: a request answered
//! here must not, and one that is Navidrome's must, signed in and whole.

mod common;

use std::io::Read;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use common::database;
use common::*;
use hyper::body::Incoming;
use hyper::header::{self, HeaderMap};
use hyper::{Request, Response, StatusCode};
use rusqlite::Connection;
use serde_json::Value;
use sonus_server::config::{LibraryOptions, TwoFactor};
use sonus_server::db::Db;
use sonus_server::library::{self, Library};
use sonus_server::secrets::Keys;
use sonus_server::subsonic::respond::Envelope;
use sonus_server::subsonic::{Setup, Subsonic};

const KEY: &str = "the test's encryption key";
const SECRET_HEADER: &str = "x-sonus-user-0123456789abcdef";
const ENVELOPE: &str = r#"{"subsonic-response":{"status":"ok","version":"1.16.1","type":"navidrome","serverVersion":"0.64.2-test","openSubsonic":true,"openSubsonicExtensions":[]}}"#;
const OK: &str = r#"{"subsonic-response":{"status":"ok","version":"1.16.1","type":"navidrome","serverVersion":"0.64.2-test","openSubsonic":true"#;
/// How every request signs in: alice, unless a test says otherwise.
const ALICE: &str = "u=alice&p=sesame&v=1.16.1&c=test&f=json";
const BOB: &str = "u=bob&p=hunter2&v=1.16.1&c=test&f=json";
const ADMIN: &str = "u=root&p=toor&v=1.16.1&c=test&f=json";

fn failed(code: i32, message: &str) -> String {
    format!(
        r#"{{"subsonic-response":{{"status":"failed","version":"1.16.1","type":"navidrome","serverVersion":"0.64.2-test","openSubsonic":true,"error":{{"code":{code},"message":"{message}"}}}}}}"#
    )
}

/// What the fake Navidrome saw of a request.
#[derive(Debug, Clone)]
struct Seen {
    target: String,
    headers: HeaderMap,
}

struct World {
    gateway: SocketAddr,
    seen: Arc<Mutex<Vec<Seen>>>,
    database: PathBuf,
    dir: PathBuf,
}

impl Drop for World {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

static WORLDS: AtomicUsize = AtomicUsize::new(0);

fn hex(text: &[u8]) -> String {
    text.iter().map(|b| format!("{b:02x}")).collect()
}

/// An album: its name is what the tests order by; `year` its only year.
fn add_album(conn: &Connection, id: &str, name: &str, artist: &str, year: i64, created_at: &str) {
    let participants = format!(r#"{{"albumartist":[{{"id":"ar-{artist}","name":"{artist}"}}]}}"#);
    conn.execute(
        "INSERT INTO album (id, name, album_artist, album_artist_id, min_year, max_year, song_count, duration, order_album_name, order_album_artist_name, \
         participants, tags, created_at, updated_at, imported_at) \
         VALUES (?1, ?2, ?3, 'ar-' || ?3, ?4, ?4, 1, 61.9, lower(?2), lower(?3), ?5, '{\"genre\":[{\"id\":\"g-rock\",\"value\":\"Rock\"}]}', ?6, '2026-01-01 13:00:00+01:00', '2026-11-24 23:42:35+01:00')",
        (id, name, artist, year, participants, created_at),
    )
    .unwrap();
    conn.execute("INSERT OR IGNORE INTO tag (id, tag_name, tag_value) VALUES ('g-rock', 'genre', 'Rock')", []).unwrap();
    conn.execute("INSERT INTO album_tags (album_id, tag_id) VALUES (?1, 'g-rock')", [id]).unwrap();
}

fn add_song(conn: &Connection, id: &str, title: &str, album_id: &str, track: i64, suffix: &str) {
    conn.execute(
        "INSERT INTO media_file (id, path, title, album, artist, artist_id, album_artist, album_artist_id, album_id, track_number, disc_number, year, size, \
         suffix, duration, bit_rate, channels, sample_rate, order_title, order_album_name, order_artist_name, participants, tags, created_at, updated_at) \
         SELECT ?1, 'a/' || ?2 || '.' || ?5, ?2, name, album_artist, album_artist_id, album_artist, album_artist_id, id, ?4, 1, max_year, 1000, ?5, 61.9, 320, 2, \
         44100, lower(?2), order_album_name, order_album_artist_name, participants, tags, '2026-11-24 23:42:33.5+01:00', '2026-01-01 13:00:00+01:00' \
         FROM album WHERE id = ?3",
        (id, title, album_id, track, suffix),
    )
    .unwrap();
}

fn annotate(conn: &Connection, user: &str, item: &str, kind: &str, play_count: i64, rating: i64, starred: bool) {
    conn.execute(
        "INSERT INTO annotation (user_id, item_id, item_type, play_count, play_date, rating, starred, starred_at) \
         VALUES (?1, ?2, ?3, ?4, CASE WHEN ?4 > 0 THEN '2026-01-04 22:15:00+01:00' END, ?5, ?6, CASE WHEN ?6 THEN '2026-11-24 23:42:33.88+01:00' END)",
        (user, item, kind, play_count, rating, starred),
    )
    .unwrap();
}

/// alice (the library granted), bob (no library), root (an admin, no library granted); four albums and their songs.
fn make_database() -> (PathBuf, PathBuf) {
    let dir = std::env::temp_dir().join(format!("sonus-library-test-{}-{}", std::process::id(), WORLDS.fetch_add(1, Ordering::Relaxed)));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("navidrome.db");
    let keys = Keys::new(KEY);
    let conn = database::create(&file);
    conn.execute_batch("DROP TABLE media_file;").unwrap();
    conn.execute_batch(include_str!("common/library.sql")).unwrap();
    let alice = database::add_user(&conn, &keys, "alice", "sesame");
    database::grant_library(&conn, &alice);
    database::add_user(&conn, &keys, "bob", "hunter2");
    let root = database::add_user(&conn, &keys, "root", "toor");
    database::make_admin(&conn, &root);
    database::set_session_secret(&conn, &keys, "the test's session secret");

    add_album(&conn, "al-10", "Album 10", "Zed", 2010, "2026-11-01 10:00:00+01:00");
    add_album(&conn, "al-2", "Album 2", "Zed", 2002, "2026-11-02 10:00:00+01:00");
    add_album(&conn, "al-b", "Blue", "Abe", 2020, "2026-11-03 10:00:00+01:00");
    add_album(&conn, "al-c", "<Cyan> & \"Co\"", "Abe", 1999, "2026-11-04 10:00:00+01:00");
    add_song(&conn, "s-1", "One", "al-b", 1, "flac");
    add_song(&conn, "s-2", "Two", "al-b", 2, "mp3");
    add_song(&conn, "s-3", "Three", "al-c", 1, "ogg");
    add_song(&conn, "s-x", "Odd", "al-10", 1, "xyz");
    conn.execute("UPDATE album SET song_count = 2 WHERE id = 'al-b'", []).unwrap();
    conn.execute("INSERT INTO item_artwork (item_kind, item_id, hash) VALUES ('al', 'al-b', '33401af5b95c979a'), ('al', 'al-c', '')", []).unwrap();
    annotate(&conn, &alice, "al-b", "album", 4, 5, true);
    annotate(&conn, &alice, "s-1", "media_file", 3, 4, true);
    annotate(&conn, &root, "al-2", "album", 1, 0, false);
    (dir, file)
}

/// The fake Navidrome: for a `ping` it finds or makes the player of the user and client, as the real one does, and
/// answers with its cookie; anything else gets "from navidrome".
fn register(database: &Path, user: &[u8], client: &str) -> String {
    let conn = Connection::open(database).unwrap();
    let user_id: String = conn.query_row("SELECT id FROM user WHERE user_name = ?1 COLLATE NOCASE", [String::from_utf8_lossy(user)], |r| r.get(0)).unwrap();
    let known: Option<String> = conn.query_row("SELECT id FROM player WHERE user_id = ?1 AND client = ?2", (&user_id, client), |r| r.get(0)).ok();
    known.unwrap_or_else(|| {
        let id = format!("player-{user_id}-{client}");
        conn.execute("INSERT INTO player (id, name, user_agent, user_id, client, ip) VALUES (?1, ?3, 'test', ?2, ?3, '127.0.0.1')", (&id, &user_id, client))
            .unwrap();
        id
    })
}

async fn world_with(options: LibraryOptions, registers: bool) -> World {
    let (dir, file) = make_database();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let (record, database) = (seen.clone(), file.clone());
    let navidrome = upstream(move |req: Request<Incoming>| {
        let (record, database) = (record.clone(), database.clone());
        async move {
            let target = req.uri().path_and_query().map(|p| p.to_string()).unwrap_or_default();
            record.lock().unwrap().push(Seen { target: target.clone(), headers: req.headers().clone() });
            if req.uri().path() == "/rest/ping" && registers {
                let user = req.headers().get(SECRET_HEADER).map(|v| v.as_bytes().to_vec()).unwrap_or_default();
                let client = target.split(['?', '&']).find_map(|pair| pair.strip_prefix("c=")).unwrap_or("").replace('+', " ");
                let player = register(&database, &user, &client);
                let cookie = format!("nd-player-{}={player}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict", hex(&user));
                return Response::builder().header(header::SET_COOKIE, cookie).body(full(format!("{OK}}}}}"))).unwrap();
            }
            Response::new(full("from navidrome"))
        }
    })
    .await;
    let db = Db::open(&file).unwrap();
    let envelope = Envelope::from_json(ENVELOPE.as_bytes()).unwrap();
    let subsonic = Subsonic::new(Setup {
        db: db.clone(),
        keys: Keys::new(KEY),
        two_factor: TwoFactor::Required,
        limit: 0,
        window: Duration::from_secs(20),
        envelope: envelope.clone(),
        frame_options: "DENY".into(),
    });
    let library = Library::new(library::Setup {
        db,
        options,
        envelope,
        frame_options: "DENY".into(),
        upstream: format!("http://{navidrome}").parse().unwrap(),
        base_path: String::new(),
        user_header: SECRET_HEADER.parse().unwrap(),
    });
    let setup = GatewaySetup {
        upstream_user_header: SECRET_HEADER,
        checks_sign_ins: true,
        subsonic: Some(subsonic),
        library: Some(library),
        ..GatewaySetup::default()
    };
    let (gateway, _) = gateway(navidrome, setup).await;
    World { gateway, seen, database: file, dir }
}

async fn world() -> World {
    world_with(LibraryOptions::default(), true).await
}

impl World {
    async fn request(&self, request: Request<TestBody>) -> (StatusCode, HeaderMap, Vec<u8>) {
        let response = send(self.gateway, request).await;
        let (status, headers) = (response.status(), response.headers().clone());
        (status, headers, body_bytes(response.into_body()).await.to_vec())
    }

    async fn get(&self, target: &str) -> (HeaderMap, String) {
        let (status, headers, body) = self.request(Request::get(target).body(empty()).unwrap()).await;
        assert_eq!(status, StatusCode::OK, "{target}");
        (headers, String::from_utf8(body).unwrap())
    }

    /// A request the library must answer: its headers and the `subsonic-response`. Navidrome saw nothing of it but,
    /// at most, the player's registration.
    async fn here(&self, target: &str) -> (HeaderMap, Value) {
        let before = self.seen.lock().unwrap().len();
        let (headers, body) = self.get(target).await;
        assert_eq!(headers.get(library::ANSWERED_HEADER).map(|v| v.as_bytes()), Some(&b"rust"[..]), "answered here: {target}: {body}");
        let seen = self.seen.lock().unwrap();
        for request in &seen[before..] {
            assert!(request.target.starts_with("/rest/ping?"), "only a registration reaches Navidrome, not {}", request.target);
        }
        let json: Value = serde_json::from_str(&body).unwrap_or_else(|e| panic!("{target}: {e}: {body}"));
        (headers, json["subsonic-response"].clone())
    }

    /// A request that is Navidrome's: it reached Navidrome, signed in and without its credentials.
    async fn navidromes(&self, target: &str) -> Seen {
        let (headers, body) = self.get(target).await;
        assert_eq!(body, "from navidrome", "{target}");
        assert!(headers.get(library::ANSWERED_HEADER).is_none());
        let seen = self.seen.lock().unwrap().last().cloned().expect("the request reached Navidrome");
        assert!(seen.headers.contains_key(SECRET_HEADER), "signed in by the gateway");
        assert!(!seen.target.contains("p=sesame"), "without its credentials: {}", seen.target);
        seen
    }

    fn reached(&self) -> Vec<String> {
        self.seen.lock().unwrap().iter().map(|seen| seen.target.clone()).collect()
    }

    fn db(&self) -> Connection {
        Connection::open(&self.database).unwrap()
    }
}

fn names(list: &Value) -> Vec<&str> {
    list.as_array().map(|items| items.iter().map(|item| item["name"].as_str().or(item["title"].as_str()).unwrap_or("?")).collect()).unwrap_or_default()
}

#[tokio::test]
async fn a_song_is_answered_here_as_navidrome_answers_it() {
    let w = world().await;
    let (headers, body) = w.get(&format!("/rest/getSong?{ALICE}&id=s-1")).await;
    // Navidrome's bytes for this row: its struct's field order, what it leaves out, its times and numbers
    let song = concat!(
        r#""song":{"id":"s-1","parent":"al-b","isDir":false,"title":"One","album":"Blue","artist":"Abe","track":1,"year":2020,"genre":"Rock","#,
        r#""coverArt":"dc-al-b:1","size":1000,"contentType":"audio/flac","suffix":"flac","starred":"2026-11-24T23:42:33.88+01:00","duration":61,"bitRate":320,"#,
        r#""path":"Abe/Blue/01-01 - One.flac","playCount":3,"discNumber":1,"created":"2026-11-24T23:42:33.5+01:00","albumId":"al-b","artistId":"ar-Abe","#,
        r#""type":"music","userRating":4,"played":"2026-01-04T22:15:00+01:00","bpm":0,"comment":"","sortName":"one","mediaType":"song","musicBrainzId":"","#,
        r#""isrc":[],"genres":[{"name":"Rock"}],"replayGain":{},"channelCount":2,"samplingRate":44100,"bitDepth":0,"moods":[],"artists":[],"#,
        r#""displayArtist":"Abe","albumArtists":[{"id":"ar-Abe","name":"Abe"}],"displayAlbumArtist":"Abe","contributors":[],"displayComposer":"","#,
        r#""explicitStatus":"","groupings":[],"works":[],"movements":[]}"#
    );
    assert_eq!(body, format!("{OK},{song}}}}}"));
    assert_eq!(headers["content-type"], "application/json");
    assert_eq!(
        headers["set-cookie"], "nd-player-616c696365=player-id-alice-test; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict",
        "the player's cookie, Navidrome's own"
    );
    assert_eq!((headers["x-content-type-options"].as_bytes(), headers["x-frame-options"].as_bytes()), (&b"nosniff"[..], &b"DENY"[..]));
    assert_eq!(headers[library::ANSWERED_HEADER], "rust");
    assert!(headers.get("content-encoding").is_none(), "not asked for");
    // Navidrome saw the registration only: a ping as this user and client
    assert_eq!(w.reached(), ["/rest/ping?v=1.16.1&c=test&f=json"]);
    let registration = w.seen.lock().unwrap()[0].clone();
    assert_eq!(registration.headers[SECRET_HEADER], "alice");
    assert_eq!(registration.headers["x-real-ip"], "127.0.0.1");
    // what Navidrome wrote for every request it answered: the user's last access
    let last_access: Option<String> = w.db().query_row("SELECT last_access_at FROM user WHERE user_name = 'alice'", [], |r| r.get(0)).unwrap();
    assert!(last_access.is_some());
}

#[tokio::test]
async fn the_player_is_registered_by_navidrome_once_a_minute_per_client() {
    let w = world().await;
    let with = |cookie: &'static str, agent: &'static str, target: String| {
        let mut request = Request::get(target).header(header::USER_AGENT, agent);
        if !cookie.is_empty() {
            request = request.header(header::COOKIE, cookie);
        }
        request.body(empty()).unwrap()
    };
    let song = format!("/rest/getSong?{ALICE}&id=s-1");
    for _ in 0..3 {
        let (_, headers, _) = w.request(with("nd-player-616c696365=player-id-alice-test; other=1", "Sonus/1.0", song.clone())).await;
        assert!(headers["set-cookie"].to_str().unwrap().starts_with("nd-player-616c696365=player-id-alice-test;"));
    }
    assert_eq!(w.reached().len(), 1, "remembered: one registration for three requests");
    let seen = w.seen.lock().unwrap()[0].clone();
    assert_eq!(seen.headers["cookie"], "nd-player-616c696365=player-id-alice-test; other=1", "the cookie Navidrome finds the player by");
    assert_eq!(seen.headers["user-agent"], "Sonus/1.0");
    // another client name, another User-Agent, another cookie, another user: each is registered
    w.here("/rest/ping?u=alice&p=sesame&v=1.16.1&c=other+app&f=json").await;
    assert_eq!(w.reached().last().unwrap(), "/rest/ping?v=1.16.1&c=other+app&f=json");
    w.request(with("", "Sonus/2.0", song.clone())).await;
    w.request(with("x=y", "Sonus/2.0", song.clone())).await;
    w.here(&format!("/rest/ping?{ADMIN}")).await;
    assert_eq!(w.reached().len(), 5);
    // the name as the client typed it is the name Navidrome's cookie is made from
    let (headers, _) = w.here("/rest/ping?u=ALICE&p=sesame&v=1.16.1&c=test&f=json").await;
    assert!(headers["set-cookie"].to_str().unwrap().starts_with("nd-player-414c494345=player-id-alice-test;"));
    // a player that is gone (an admin removed it) is registered again
    w.here(&song).await;
    let before = w.reached().len();
    w.here(&song).await;
    assert_eq!(w.reached().len(), before, "remembered");
    w.db().execute("DELETE FROM player WHERE id = 'player-id-alice-test'", []).unwrap();
    w.here(&song).await;
    assert_eq!(w.reached().len(), before + 1);
}

#[tokio::test]
async fn what_is_navidromes_goes_to_navidrome_signed_in() {
    let w = world().await;
    // XML and JSONP (decision 1: JSON only)
    for format in ["", "&f=xml", "&f=jsonp&callback=cb"] {
        let seen = w.navidromes(&format!("/rest/getSong?u=alice&p=sesame&v=1.16.1&c=test{format}&id=s-1")).await;
        assert!(seen.target.starts_with("/rest/getSong?u=alice&v=1.16.1&c=test"), "{}", seen.target);
    }
    // a parameter Sonus clients do not send
    w.navidromes(&format!("/rest/getAlbumList2?{ALICE}&type=newest&musicFolderId=1")).await;
    w.navidromes(&format!("/rest/getAlbumList2?{ALICE}&type=newest&musicFolderId=")).await;
    // an offset without a limit: Navidrome's query fails, and it says so
    w.navidromes(&format!("/rest/getAlbumList2?{ALICE}&type=newest&size=0&offset=2")).await;
    // methods not taken over
    w.navidromes(&format!("/rest/getAlbumList?{ALICE}&type=newest")).await;
    w.navidromes(&format!("/rest/getArtists?{ALICE}")).await;
    // a song whose content type Go would ask the operating system for, alone and in its album
    w.navidromes(&format!("/rest/getSong?{ALICE}&id=s-x")).await;
    w.navidromes(&format!("/rest/getAlbum?{ALICE}&id=al-10")).await;
    // parameters that are not text
    w.navidromes(&format!("/rest/getSong?{ALICE}&id=%ff")).await;
    // rows this server does not read as Go's decoders do
    w.db().execute("UPDATE media_file SET participants = '{\"singer\":[]}' WHERE id = 's-3'", []).unwrap();
    w.navidromes(&format!("/rest/getSong?{ALICE}&id=s-3")).await;
    w.db().execute("UPDATE album SET discs = '[1]' WHERE id = 'al-c'", []).unwrap();
    w.navidromes(&format!("/rest/getAlbum?{ALICE}&id=al-c")).await;
    // a player with a transcoding set (songs then carry transcodedSuffix)
    w.db().execute("UPDATE player SET transcoding_id = 'tr-1'", []).unwrap();
    w.navidromes(&format!("/rest/getSong?{ALICE}&id=s-1")).await;
    w.navidromes(&format!("/rest/getAlbumList2?{ALICE}&type=newest")).await;
}

#[tokio::test]
async fn without_a_player_from_navidrome_the_request_is_navidromes() {
    // Navidrome answers the registration without a cookie (it could not register a player)
    let w = world_with(LibraryOptions::default(), false).await;
    w.navidromes(&format!("/rest/getSong?{ALICE}&id=s-1")).await;
    assert_eq!(w.reached(), ["/rest/ping?v=1.16.1&c=test&f=json", "/rest/getSong?u=alice&v=1.16.1&c=test&f=json&id=s-1"]);
}

#[tokio::test]
async fn a_user_sees_what_navidrome_would_show_them() {
    let w = world().await;
    // bob has no library: nothing is there for him
    assert_eq!(w.get(&format!("/rest/getSong?{BOB}&id=s-1")).await.1, failed(70, "Song not found"));
    assert_eq!(w.get(&format!("/rest/getAlbum?{BOB}&id=al-b")).await.1, failed(70, "Album not found"));
    let (headers, list) = w.here(&format!("/rest/getAlbumList2?{BOB}&type=alphabeticalByName")).await;
    assert_eq!(list["albumList2"], serde_json::json!({}), "an empty list has no album member");
    assert_eq!(headers["x-total-count"], "0");
    // an admin sees every library, granted or not; and their own annotations, not alice's
    let (_, list) = w.here(&format!("/rest/getAlbumList2?{ADMIN}&type=alphabeticalByName")).await;
    assert_eq!(names(&list["albumList2"]["album"]).len(), 4);
    let (_, album) = w.here(&format!("/rest/getAlbum?{ADMIN}&id=al-b")).await;
    assert!(album["album"].get("starred").is_none() && album["album"].get("playCount").is_none(), "{album}");
    assert_eq!(album["album"]["userRating"], 0);
    assert_eq!(names(&w.here(&format!("/rest/getAlbumList2?{ADMIN}&type=frequent")).await.1["albumList2"]["album"]), ["Album 2"]);
    // alice sees hers
    let (_, album) = w.here(&format!("/rest/getAlbum?{ALICE}&id=al-b")).await;
    let album = &album["album"];
    assert_eq!(
        (album["starred"].as_str(), album["playCount"].as_i64(), album["userRating"].as_i64()),
        (Some("2026-11-24T23:42:33.88+01:00"), Some(4), Some(5))
    );
    assert_eq!(album["played"], "2026-01-04T22:15:00+01:00");
    assert_eq!(album["coverArt"], "al-al-b_33401af5b95c979a");
    assert_eq!(names(&album["song"]), ["One", "Two"]);
    assert_eq!(album["song"][1]["contentType"], "audio/mpeg");
    // an album known to have no picture: no coverArt; its song falls back to its disc
    let (_, album) = w.here(&format!("/rest/getAlbum?{ALICE}&id=al-c")).await;
    assert!(album["album"].get("coverArt").is_none());
    assert_eq!(album["album"]["name"], "<Cyan> & \"Co\"");
    assert_eq!(album["album"]["song"][0]["coverArt"], "dc-al-c:1");
    // an unknown id, no id, a song's id for an album
    for target in ["getAlbum?id=nope", "getAlbum?", "getAlbum?id=", "getAlbum?id=s-1"] {
        assert_eq!(w.get(&format!("/rest/{target}&{ALICE}")).await.1, failed(70, "Album not found"), "{target}");
    }
    assert_eq!(w.get(&format!("/rest/getSong?{ALICE}")).await.1, failed(70, "Song not found"));
}

#[tokio::test]
async fn names_are_escaped_as_go_escapes_them() {
    let w = world().await;
    let (_, body) = w.get(&format!("/rest/getAlbum?{ALICE}&id=al-c")).await;
    let u = "\\u";
    assert!(body.contains(&format!(r#""name":"{u}003cCyan{u}003e {u}0026 \"Co\"""#)), "{body}");
}

#[tokio::test]
async fn album_lists_in_every_order() {
    let w = world().await;
    let list = async |query: &str| {
        let (headers, body) = w.here(&format!("/rest/getAlbumList2?{ALICE}&{query}")).await;
        let albums = names(&body["albumList2"]["album"]).into_iter().map(str::to_string).collect::<Vec<_>>();
        (albums, headers["x-total-count"].to_str().unwrap().to_string())
    };
    let all = |names: &[&str]| (names.iter().map(|n| n.to_string()).collect::<Vec<_>>(), "4".to_string());
    assert_eq!(list("type=alphabeticalByName").await, all(&["<Cyan> & \"Co\"", "Album 10", "Album 2", "Blue"]));
    assert_eq!(list("type=alphabeticalByArtist").await, all(&["<Cyan> & \"Co\"", "Blue", "Album 10", "Album 2"]));
    assert_eq!(list("type=newest").await, all(&["<Cyan> & \"Co\"", "Blue", "Album 2", "Album 10"]));
    assert_eq!(list("type=byYear&fromYear=1990&toYear=2015").await, (vec!["<Cyan> & \"Co\"".into(), "Album 2".into(), "Album 10".into()], "3".into()));
    assert_eq!(list("type=byYear&fromYear=2015&toYear=1990").await.0, ["Album 10", "Album 2", "<Cyan> & \"Co\""]);
    assert_eq!(list("type=byGenre&genre=rock").await.1, "4");
    assert_eq!(list("type=byGenre&genre=Jazz").await, (vec![], "0".into()));
    for kind in ["starred", "frequent", "recent", "highest"] {
        assert_eq!(list(&format!("type={kind}")).await, (vec!["Blue".into()], "1".into()), "{kind}");
    }
    // paging: the count is the whole list's
    assert_eq!(list("type=alphabeticalByName&size=2&offset=1").await, (vec!["Album 10".into(), "Album 2".into()], "4".into()));
    assert_eq!(list("type=alphabeticalByName&size=2&offset=3").await.0, ["Blue"]);
    assert_eq!(list("type=alphabeticalByName&size=2&offset=4").await.0, Vec::<String>::new());
    assert_eq!(list("type=alphabeticalByName&size=0").await.0.len(), 4);
    assert_eq!(list("type=alphabeticalByName&size=1&offset=-3").await.0, ["<Cyan> & \"Co\""]);
    // errors, in Navidrome's words
    for (query, code, message) in [
        ("size=3", 10, "missing parameter: 'type'"),
        ("type=byGenre", 10, "missing parameter: 'genre'"),
        ("type=byYear&fromYear=1990", 10, "missing parameter: 'toYear'"),
        ("type=byYear&fromYear=x&toYear=1", 0, "invalid parameter 'fromYear': expected integer, got 'x'"),
        ("type=best", 0, "type 'best' not implemented"),
    ] {
        assert_eq!(w.get(&format!("/rest/getAlbumList2?{ALICE}&{query}")).await.1, failed(code, message), "{query}");
    }
    // the same as a form post, and under .view
    let form = Request::post("/rest/getAlbumList2.view")
        .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
        .body(full(format!("{ALICE}&type=alphabeticalByName&size=1&offset=3")))
        .unwrap();
    let (_, headers, body) = w.request(form).await;
    assert_eq!(headers[library::ANSWERED_HEADER], "rust");
    assert!(String::from_utf8(body).unwrap().contains(r#""albumList2":{"album":[{"id":"al-b","name":"Blue""#));
}

#[tokio::test]
async fn a_random_list_pages_over_every_album_once() {
    let w = world().await;
    let page = async |offset: usize| {
        let (_, body) = w.here(&format!("/rest/getAlbumList2?{ALICE}&type=random&size=2&offset={offset}")).await;
        names(&body["albumList2"]["album"]).into_iter().map(str::to_string).collect::<Vec<_>>()
    };
    let mut orders = std::collections::HashSet::new();
    for _ in 0..12 {
        // a pass from the start: the pages belong together, as Navidrome's do until the list starts over
        let mut seen = page(0).await;
        seen.extend(page(2).await);
        assert!(page(4).await.is_empty());
        orders.insert(seen.clone());
        seen.sort();
        assert_eq!(seen, ["<Cyan> & \"Co\"", "Album 10", "Album 2", "Blue"], "each album once");
    }
    assert!(orders.len() > 1, "another order when the list starts over");
}

#[tokio::test]
async fn navidromes_settings_change_the_lists() {
    // EnableNaturalSorting: "Album 2" before "Album 10" (Navidrome's NATSORT collation, registered here too)
    let natural = world_with(LibraryOptions { enable_natural_sorting: true, ..LibraryOptions::default() }, true).await;
    let (_, list) = natural.here(&format!("/rest/getAlbumList2?{ALICE}&type=alphabeticalByName")).await;
    assert_eq!(names(&list["albumList2"]["album"]), ["<Cyan> & \"Co\"", "Album 2", "Album 10", "Blue"]);

    // PreferSortTags: the sort tag orders the list and is the sortName
    let sort_tags = world_with(LibraryOptions { prefer_sort_tags: true, ..LibraryOptions::default() }, true).await;
    sort_tags.db().execute("UPDATE album SET sort_album_name = 'Zzz' WHERE id = 'al-c'", []).unwrap();
    let (_, list) = sort_tags.here(&format!("/rest/getAlbumList2?{ALICE}&type=alphabeticalByName")).await;
    assert_eq!(names(&list["albumList2"]["album"]), ["Album 10", "Album 2", "Blue", "<Cyan> & \"Co\""]);
    assert_eq!(list["albumList2"]["album"][3]["sortName"], "Zzz");

    // RecentlyAddedByModTime: newest by the files' change time, which is also "created"
    let by_mod_time = world_with(LibraryOptions { recently_added_by_mod_time: true, ..LibraryOptions::default() }, true).await;
    by_mod_time.db().execute("UPDATE album SET updated_at = '2026-06-01 00:00:00+01:00' WHERE id = 'al-10'", []).unwrap();
    let (_, list) = by_mod_time.here(&format!("/rest/getAlbumList2?{ALICE}&type=newest&size=1")).await;
    assert_eq!(list["albumList2"]["album"][0]["name"], "Album 10");
    assert_eq!(list["albumList2"]["album"][0]["created"], "2026-06-01T00:00:00+01:00");

    // AlbumPlayCountMode normalized: plays divided by the album's songs (4 plays of 2 songs)
    let normalized = world_with(LibraryOptions { normalized_album_play_count: true, enable_average_rating: false, ..LibraryOptions::default() }, true).await;
    normalized.db().execute("UPDATE album SET average_rating = 4.5 WHERE id = 'al-b'", []).unwrap();
    let (_, album) = normalized.here(&format!("/rest/getAlbum?{ALICE}&id=al-b")).await;
    assert_eq!(album["album"]["playCount"], 2);
    assert!(album["album"].get("averageRating").is_none(), "Subsonic.EnableAverageRating off");
    let (_, album) = world().await.here(&format!("/rest/getAlbum?{ALICE}&id=al-b")).await;
    assert_eq!(album["album"]["playCount"], 4);
}

#[tokio::test]
async fn a_players_settings_change_a_song() {
    let w = world().await;
    w.here(&format!("/rest/ping?{ALICE}")).await;
    // ReportRealPath, read from the player's row at every request
    w.db().execute("UPDATE player SET report_real_path = TRUE", []).unwrap();
    if library::entities::REAL_PATHS {
        let (_, song) = w.here(&format!("/rest/getSong?{ALICE}&id=s-1")).await;
        assert_eq!(song["song"]["path"], "/music/a/One.flac");
    } else {
        // where Go joins paths by other rules (Windows), such a player's songs are Navidrome's
        w.navidromes(&format!("/rest/getSong?{ALICE}&id=s-1")).await;
    }
    w.db().execute("UPDATE player SET report_real_path = FALSE", []).unwrap();
    let (_, song) = w.here(&format!("/rest/getSong?{ALICE}&id=s-1")).await;
    assert_eq!(song["song"]["path"], "Abe/Blue/01-01 - One.flac");
    // Subsonic.LegacyClients and MinimalClients go by the client's name
    let (_, song) = w.here("/rest/getSong?u=alice&p=sesame&v=1.16.1&c=DSub&f=json&id=s-1").await;
    assert!(song["song"].get("mediaType").is_none() && song["song"].get("albumId").is_some());
    let (_, song) = w.here("/rest/getSong?u=alice&p=sesame&v=1.16.1&c=SubMusic&f=json&id=s-1").await;
    assert_eq!(song["song"], serde_json::json!({"id": "s-1", "isDir": false, "title": "One"}));
}

#[tokio::test]
async fn answers_are_compressed_for_clients_that_take_gzip() {
    let w = world().await;
    let request = Request::get(format!("/rest/getAlbumList2?{ALICE}&type=newest")).header(header::ACCEPT_ENCODING, "gzip, deflate, br").body(empty()).unwrap();
    let (status, headers, body) = w.request(request).await;
    assert_eq!((status, headers["content-encoding"].as_bytes()), (StatusCode::OK, &b"gzip"[..]));
    assert_eq!(values(&headers, "vary"), ["Origin", "Accept-Encoding"]);
    let mut text = String::new();
    flate2::read::GzDecoder::new(&body[..]).read_to_string(&mut text).unwrap();
    assert!(text.starts_with(&format!("{OK},\"albumList2\":{{\"album\":[{{\"id\":\"al-c\"")), "{text}");
}

#[tokio::test]
async fn a_sign_in_is_checked_before_anything_is_read() {
    let w = world().await;
    assert_eq!(w.get("/rest/getSong?u=alice&p=wrong&v=1.16.1&c=test&f=json&id=s-1").await.1, failed(40, "Wrong username or password"));
    assert_eq!(w.get("/rest/getAlbumList2?u=alice&p=sesame&c=test&f=json&type=newest").await.1, failed(10, "missing parameter: 'v'"));
    assert!(w.reached().is_empty(), "nothing reached Navidrome, not even a registration");
}
