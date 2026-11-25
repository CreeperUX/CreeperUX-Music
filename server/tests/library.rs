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

/// More of the library for the lists: the two artists (known to have no picture), a starred artist, three playlists
/// (alice's own, root's public one, root's smart one) and one of root's that is private, and alice's play queue.
fn add_lists(conn: &Connection) {
    for (artist, albums) in [("Abe", 2), ("Zed", 2)] {
        conn.execute("INSERT INTO artist (id, name, order_artist_name) VALUES ('ar-' || ?1, ?1, lower(?1))", [artist]).unwrap();
        let stats = format!(
            r#"{{"albumartist":{{"a":{albums},"m":3,"s":10}},"maincredit":{{"a":{},"m":3,"s":10}},"total":{{"a":{albums},"m":3,"s":10}}}}"#,
            albums + 1
        );
        conn.execute("INSERT INTO library_artist (library_id, artist_id, stats) VALUES (1, 'ar-' || ?1, ?2)", (artist, stats)).unwrap();
        conn.execute("INSERT INTO item_artwork (item_kind, item_id, hash) VALUES ('ar', 'ar-' || ?1, '')", [artist]).unwrap();
    }
    annotate(conn, "id-alice", "ar-Abe", "artist", 0, 0, true);
    let playlist = |id: &str, name: &str, owner: &str, public: bool, rules: Option<&str>| {
        conn.execute(
            "INSERT INTO playlist (id, name, comment, duration, song_count, public, created_at, updated_at, owner_id, rules, evaluated_at) \
             VALUES (?1, ?2, 'a comment', 123.9, 2, ?3, '2026-11-24 23:42:33.9+01:00', '2026-11-24 23:42:34+01:00', ?4, ?5, \
             CASE WHEN ?5 IS NOT NULL THEN '2026-11-24 23:42:33.5+01:00' END)",
            (id, name, public, owner, rules),
        )
        .unwrap();
    };
    playlist("pl-own", "Road Trip", "id-alice", false, None);
    playlist("pl-shared", "Shared Picks", "id-root", true, None);
    playlist("pl-smart", "All FLAC", "id-root", true, Some(r#"{"all":[{"is":{"suffix":"flac"}}],"sort":"title"}"#));
    playlist("pl-secret", "Secret", "id-root", false, None);
    for (playlist, position, song) in [("pl-own", 1, "s-2"), ("pl-own", 2, "s-gone"), ("pl-own", 3, "s-1"), ("pl-shared", 1, "s-3"), ("pl-smart", 1, "s-1")] {
        conn.execute("INSERT INTO playlist_tracks (id, playlist_id, media_file_id) VALUES (?1, ?2, ?3)", (position, playlist, song)).unwrap();
    }
    conn.execute("INSERT INTO item_artwork (item_kind, item_id, hash) VALUES ('pl', 'pl-own', '560ad02e92edcc95')", []).unwrap();
    conn.execute(
        "INSERT INTO playqueue (id, user_id, current, changed_by, items, created_at, updated_at, position) \
         VALUES ('pq-1', 'id-alice', 1, 'Sonus', 's-2,s-gone,s-1', '2026-11-24 23:00:00+01:00', '2026-11-24 23:42:33.9263+01:00', 5000)",
        [],
    )
    .unwrap();
}

async fn world_with_lists() -> World {
    let w = world().await;
    add_lists(&w.db());
    w
}

fn ids(list: &Value) -> Vec<&str> {
    list.as_array().map(|items| items.iter().map(|item| item["id"].as_str().unwrap_or("?")).collect()).unwrap_or_default()
}

fn nothing() -> Value {
    serde_json::json!({})
}

#[tokio::test]
async fn a_search_for_nothing_pages_the_library_in_the_tables_order() {
    let w = world_with_lists().await;
    let sync = |count: i64, offset: i64| format!("/rest/search3?{ALICE}&query=&songCount={count}&songOffset={offset}&albumCount=0&artistCount=0");
    let (_, page) = w.here(&sync(2, 0)).await;
    assert_eq!(ids(&page["searchResult3"]["song"]), ["s-1", "s-2"]);
    assert!(page["searchResult3"].get("album").is_none() && page["searchResult3"].get("artist").is_none(), "a count of 0 asks for none");
    assert_eq!(page["searchResult3"]["song"][0]["starred"], "2026-11-24T23:42:33.88+01:00", "with the user's own annotations");
    assert_eq!(ids(&w.here(&sync(1, 2)).await.1["searchResult3"]["song"]), ["s-3"]);
    assert_eq!(w.here(&sync(2, 4)).await.1["searchResult3"], nothing(), "past the end: nothing, and no error");
    // no query at all, two quotes, a star: everything, 20 of each kind
    for query in ["", "&query=%22%22", "&query=*"] {
        let (_, all) = w.here(&format!("/rest/search3?{ALICE}{query}&songCount=3")).await;
        assert_eq!(ids(&all["searchResult3"]["song"]), ["s-1", "s-2", "s-3"], "{query}");
        assert_eq!(ids(&all["searchResult3"]["album"]), ["al-10", "al-2", "al-b", "al-c"]);
        assert_eq!(ids(&all["searchResult3"]["artist"]), ["ar-Abe", "ar-Zed"]);
    }
    // an offset without a count is not SQL for Navidrome either: no rows
    assert_eq!(w.here(&sync(-1, 1)).await.1["searchResult3"], nothing());
    // the page that would show the song with a content type of the system's: Navidrome's
    w.navidromes(&sync(500, 0)).await;
    // what a user may see: bob has no library, an admin every one
    assert_eq!(w.here(&format!("/rest/search3?{BOB}&query=")).await.1["searchResult3"], nothing());
    let (_, admin) = w.here(&format!("/rest/search3?{ADMIN}&query=&songCount=3")).await;
    assert_eq!(ids(&admin["searchResult3"]["artist"]), ["ar-Abe", "ar-Zed"]);
    assert!(admin["searchResult3"]["song"][0].get("starred").is_none(), "the admin's own annotations, not alice's");
}

#[tokio::test]
async fn a_search_for_words_goes_through_fts5_like_or_musicbrainz_ids() {
    let w = world_with_lists().await;
    let search =
        async |query: &str| w.here(&format!("/rest/search3?{ALICE}&query={query}&songCount=20&albumCount=20&artistCount=20")).await.1["searchResult3"].clone();
    // words: FTS5, any case, prefixes
    let blue = search("BLU").await;
    assert_eq!(ids(&blue["album"]), ["al-b"]);
    assert_eq!(ids(&blue["song"]), ["s-1", "s-2"], "songs of the album, by title");
    assert!(blue.get("artist").is_none());
    assert_eq!(ids(&search("album+2").await["album"]), ["al-2"]);
    let (_, phrase) = w.here(&format!("/rest/search3?{ALICE}&query=%22album+10%22&songCount=0")).await;
    assert_eq!(ids(&phrase["searchResult3"]["album"]), ["al-10"], "a phrase");
    assert_eq!(search("o").await, nothing(), "one character is too broad");
    assert_eq!(search("nothing+like+it").await, nothing());
    assert_eq!(ids(&search("co+cyan").await["album"]), ["al-c"], "every word, in any order");
    assert_eq!(search("cyan+AND+co").await, nothing(), "FTS5's operators are words like any other: nothing here has an 'and'");
    // an artist: Navidrome's ArtistID3
    let abe = search("abe").await;
    assert_eq!(
        abe["artist"],
        serde_json::json!([{"id": "ar-Abe", "name": "Abe", "albumCount": 2, "starred": "2026-11-24T23:42:33.88+01:00", "musicBrainzId": "", "sortName": "abe",
            "roles": ["albumartist", "maincredit"]}])
    );
    assert_eq!(ids(&abe["album"]).len(), 2, "the albums of this album artist");
    // Chinese, Japanese, Korean: LIKE, a single character too
    w.db().execute("UPDATE media_file SET title = '夜の歌' WHERE id = 's-3'", []).unwrap();
    assert_eq!(ids(&search("%E5%A4%9C").await["song"]), ["s-3"]);
    assert_eq!(ids(&search("%E5%A4%9C+%E6%AD%8C").await["song"]), ["s-3"], "every word, anywhere");
    assert_eq!(search("%E5%A4%9C+%E6%9C%9D").await, nothing());
    // punctuation: the word through FTS5; what FTS5 would lose, with LIKE
    assert_eq!(ids(&search("%3CCyan%3E").await["album"]), ["al-c"]);
    assert_eq!(ids(&search("%26+%22").await["album"]), ["al-c"]);
    // a MusicBrainz id, in any case
    w.db().execute("UPDATE media_file SET mbz_recording_id = '0f3d6a8e-5c1b-4d2a-9e7f-1a2b3c4d5f01' WHERE id = 's-2'", []).unwrap();
    let by_id = search("0F3D6A8E-5C1B-4D2A-9E7F-1A2B3C4D5F01").await;
    assert_eq!((ids(&by_id["song"]), by_id.get("album").is_none()), (vec!["s-2"], true));
    // paging
    let page = w.here(&format!("/rest/search3?{ALICE}&query=album&albumCount=1&albumOffset=1&songCount=0&artistCount=0")).await.1;
    assert_eq!(ids(&page["searchResult3"]["album"]).len(), 1);
    // legacy clients get no OpenSubsonic fields; Subsonic.ArtistParticipations counts the albums an artist is only on
    let (_, legacy) = w.here("/rest/search3?u=alice&p=sesame&v=1.16.1&c=DSub&f=json&query=abe").await;
    assert!(legacy["searchResult3"]["artist"][0].get("roles").is_none() && legacy["searchResult3"]["album"][0].get("userRating").is_none());
    let participations = world_with(LibraryOptions { artist_participations: true, ..LibraryOptions::default() }, true).await;
    add_lists(&participations.db());
    assert_eq!(participations.here(&format!("/rest/search3?{ALICE}&query=zed&songCount=0")).await.1["searchResult3"]["artist"][0]["albumCount"], 3);
}

#[tokio::test]
async fn searches_that_stay_navidromes() {
    let w = world_with_lists().await;
    w.navidromes(&format!("/rest/search3?{ALICE}&query=blue&musicFolderId=1")).await;
    w.navidromes(&format!("/rest/search3?{ALICE}&query=%ff")).await;
    w.navidromes(&format!("/rest/search2?{ALICE}&query=blue")).await;
    // an artist with a picture (or one not looked for yet) carries a link Navidrome signs
    w.db().execute("UPDATE item_artwork SET hash = '00ff00ff00ff00ff' WHERE item_kind = 'ar' AND item_id = 'ar-Zed'", []).unwrap();
    w.navidromes(&format!("/rest/search3?{ALICE}&query=zed")).await;
    w.navidromes(&format!("/rest/search3?{ALICE}&query=&songCount=1")).await;
    w.here(&format!("/rest/search3?{ALICE}&query=zed&artistCount=0&songCount=0")).await;
    w.here(&format!("/rest/search3?{ALICE}&query=abe")).await;
    w.db().execute("DELETE FROM item_artwork WHERE item_kind = 'ar'", []).unwrap();
    w.navidromes(&format!("/rest/search3?{ALICE}&query=abe")).await;
    w.navidromes(&format!("/rest/getStarred2?{ALICE}")).await;
    // Navidrome's older search (Search.Backend = legacy, Search.FullString)
    for options in
        [LibraryOptions { legacy_search: true, ..LibraryOptions::default() }, LibraryOptions { search_full_string: true, ..LibraryOptions::default() }]
    {
        let legacy = world_with(options, true).await;
        legacy.navidromes(&format!("/rest/search3?{ALICE}&query=blue")).await;
    }
}

#[tokio::test]
async fn what_a_user_starred() {
    let w = world_with_lists().await;
    let (_, starred) = w.here(&format!("/rest/getStarred2?{ALICE}")).await;
    let starred = &starred["starred2"];
    assert_eq!((ids(&starred["artist"]), ids(&starred["album"]), ids(&starred["song"])), (vec!["ar-Abe"], vec!["al-b"], vec!["s-1"]));
    assert_eq!(starred["artist"][0]["albumCount"], 2);
    assert_eq!(starred["album"][0]["starred"], "2026-11-24T23:42:33.88+01:00");
    // nothing starred: an empty object, as Navidrome writes it
    assert_eq!(w.get(&format!("/rest/getStarred2?{ADMIN}")).await.1, format!("{OK},\"starred2\":{{}}}}}}"));
    assert_eq!(w.here(&format!("/rest/getStarred2?{BOB}")).await.1["starred2"], nothing());
    // the latest first
    annotate(&w.db(), "id-alice", "s-2", "media_file", 0, 0, true);
    w.db().execute("UPDATE annotation SET starred_at = '2026-11-25 08:00:00+01:00' WHERE item_id = 's-2'", []).unwrap();
    assert_eq!(ids(&w.here(&format!("/rest/getStarred2.view?{ALICE}")).await.1["starred2"]["song"]), ["s-2", "s-1"]);
    w.navidromes(&format!("/rest/getStarred2?{ALICE}&musicFolderId=1")).await;
    w.navidromes(&format!("/rest/getStarred?{ALICE}")).await;
}

#[tokio::test]
async fn playlists_a_user_may_see() {
    let w = world_with_lists().await;
    let (_, body) = w.get(&format!("/rest/getPlaylists?{ALICE}")).await;
    // Navidrome's bytes: by name; `public` left out when false; someone else's and a smart one read-only; a smart
    // one good until Navidrome's refresh delay after it was filled
    let expected = concat!(
        r#""playlists":{"playlist":[{"id":"pl-smart","name":"All FLAC","comment":"a comment","songCount":2,"duration":123,"public":true,"owner":"root","#,
        r#""created":"2026-11-24T23:42:33.9+01:00","changed":"2026-11-24T23:42:34+01:00","coverArt":"pl-pl-smart","readonly":true,"#,
        r#""validUntil":"2026-11-24T23:42:38.5+01:00"},"#,
        r#"{"id":"pl-own","name":"Road Trip","comment":"a comment","songCount":2,"duration":123,"owner":"alice","created":"2026-11-24T23:42:33.9+01:00","#,
        r#""changed":"2026-11-24T23:42:34+01:00","coverArt":"pl-pl-own_560ad02e92edcc95","readonly":false},"#,
        r#"{"id":"pl-shared","name":"Shared Picks","comment":"a comment","songCount":2,"duration":123,"public":true,"owner":"root","#,
        r#""created":"2026-11-24T23:42:33.9+01:00","changed":"2026-11-24T23:42:34+01:00","coverArt":"pl-pl-shared","readonly":true}]}"#
    );
    assert_eq!(body, format!("{OK},{expected}}}}}"));
    // an admin sees every playlist; someone with none of their own the public ones
    assert_eq!(ids(&w.here(&format!("/rest/getPlaylists?{ADMIN}")).await.1["playlists"]["playlist"]), ["pl-smart", "pl-own", "pl-secret", "pl-shared"]);
    assert_eq!(ids(&w.here(&format!("/rest/getPlaylists?{BOB}")).await.1["playlists"]["playlist"]), ["pl-smart", "pl-shared"]);
    // minimal and legacy clients
    let (_, minimal) = w.here("/rest/getPlaylists?u=alice&p=sesame&v=1.16.1&c=SubMusic&f=json").await;
    assert_eq!(
        minimal["playlists"]["playlist"][1],
        serde_json::json!({"id": "pl-own", "name": "Road Trip", "songCount": 2, "duration": 123, "created": "2026-11-24T23:42:33.9+01:00",
            "changed": "2026-11-24T23:42:34+01:00"})
    );
    let (_, legacy) = w.here("/rest/getPlaylists?u=alice&p=sesame&v=1.16.1&c=DSub&f=json").await;
    assert!(legacy["playlists"]["playlist"][0].get("readonly").is_none() && legacy["playlists"]["playlist"][0].get("coverArt").is_some());
    // SmartPlaylistRefreshDelay
    let slow = world_with(LibraryOptions { smart_playlist_refresh_delay: Duration::from_secs(3600), ..LibraryOptions::default() }, true).await;
    add_lists(&slow.db());
    assert_eq!(slow.here(&format!("/rest/getPlaylists?{ALICE}")).await.1["playlists"]["playlist"][0]["validUntil"], "2026-11-25T00:42:33.5+01:00");
    // a smart playlist with a delay of its own, or rules Navidrome's decoder refuses: Navidrome's list
    w.db().execute(r#"UPDATE playlist SET rules = '{"all":[{"is":{"suffix":"flac"}}],"refreshDelay":"1h"}' WHERE id = 'pl-smart'"#, []).unwrap();
    w.navidromes(&format!("/rest/getPlaylists?{ALICE}")).await;
}

#[tokio::test]
async fn a_playlist_with_its_songs() {
    let w = world_with_lists().await;
    let (_, own) = w.here(&format!("/rest/getPlaylist?{ALICE}&id=pl-own")).await;
    let own = &own["playlist"];
    // in the playlist's order, without the song that is gone; counted and timed from the songs that are there
    assert_eq!(ids(&own["entry"]), ["s-2", "s-1"]);
    assert_eq!((own["songCount"].as_i64(), own["duration"].as_i64(), own["readonly"].as_bool()), (Some(2), Some(123), Some(false)));
    assert_eq!(own["entry"][1]["starred"], "2026-11-24T23:42:33.88+01:00");
    assert_eq!(own["entry"][1]["userRating"], 4);
    assert!(own.get("public").is_none());
    // someone else's public playlist: read-only; a private one is not there for them; an admin reads any
    let (_, shared) = w.here(&format!("/rest/getPlaylist?{ALICE}&id=pl-shared")).await;
    let shared = &shared["playlist"];
    assert_eq!((ids(&shared["entry"]), shared["readonly"].as_bool(), shared["songCount"].as_i64()), (vec!["s-3"], Some(true), Some(1)));
    assert_eq!(w.get(&format!("/rest/getPlaylist?{ALICE}&id=pl-secret")).await.1, failed(70, "playlist not found"));
    assert_eq!(w.get(&format!("/rest/getPlaylist?{BOB}&id=pl-own")).await.1, failed(70, "playlist not found"));
    assert_eq!(w.here(&format!("/rest/getPlaylist?{ADMIN}&id=pl-own")).await.1["playlist"]["readonly"], true, "not the owner");
    assert_eq!(w.get(&format!("/rest/getPlaylist?{ALICE}&id=nope")).await.1, failed(70, "playlist not found"));
    assert_eq!(w.get(&format!("/rest/getPlaylist?{ALICE}")).await.1, failed(10, "missing parameter: 'id'"));
    // a user without the library sees a public playlist without its songs
    let (_, empty) = w.here(&format!("/rest/getPlaylist?{BOB}&id=pl-shared")).await;
    assert!(empty["playlist"].get("entry").is_none());
    assert_eq!(empty["playlist"]["songCount"], 0);
    // a playlist Navidrome keeps in step with a file is read-only for its owner too
    w.db().execute("UPDATE playlist SET sync = TRUE WHERE id = 'pl-own'", []).unwrap();
    assert_eq!(w.here(&format!("/rest/getPlaylist?{ALICE}&id=pl-own")).await.1["playlist"]["readonly"], true);
    // a smart playlist: Navidrome fills it when it is read, which writes its songs
    w.navidromes(&format!("/rest/getPlaylist?{ALICE}&id=pl-smart")).await;
    w.navidromes(&format!("/rest/getPlaylist?{ADMIN}&id=pl-smart")).await;
}

#[tokio::test]
async fn the_saved_play_queue() {
    let w = world_with_lists().await;
    let (_, queue) = w.here(&format!("/rest/getPlayQueue?{ALICE}")).await;
    let queue = &queue["playQueue"];
    // the queue's order, without the song that is gone; `current` is the song at the saved index of what is left
    assert_eq!(ids(&queue["entry"]), ["s-2", "s-1"]);
    assert_eq!(
        (queue["current"].as_str(), queue["position"].as_i64(), queue["username"].as_str(), queue["changedBy"].as_str(), queue["changed"].as_str()),
        (Some("s-1"), Some(5000), Some("alice"), Some("Sonus"), Some("2026-11-24T23:42:33.9263+01:00"))
    );
    // none saved: the user's name and Go's zero time
    let none = format!("{OK},\"playQueue\":{{\"username\":\"bob\",\"changed\":\"0001-01-01T00:00:00Z\",\"changedBy\":\"\"}}}}}}");
    assert_eq!(w.get(&format!("/rest/getPlayQueue?{BOB}")).await.1, none);
    // an index past the end: no current song; position 0 is left out
    w.db().execute("UPDATE playqueue SET current = 2, position = 0", []).unwrap();
    let (_, queue) = w.here(&format!("/rest/getPlayQueue?{ALICE}")).await;
    assert!(queue["playQueue"].get("current").is_none() && queue["playQueue"].get("position").is_none());
    // a queue of songs that are all gone answers as none saved
    w.db().execute("UPDATE playqueue SET items = 's-gone,s-gone2'", []).unwrap();
    let (_, queue) = w.here(&format!("/rest/getPlayQueue?{ALICE}")).await;
    assert_eq!(queue["playQueue"], serde_json::json!({"username": "alice", "changed": "0001-01-01T00:00:00Z", "changedBy": ""}));
    w.navidromes(&format!("/rest/getPlayQueueByIndex?{ALICE}")).await;
}

const JPEG: &[u8] = &[0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, b'J', b'F', b'I', b'F', 0x00, 0x01, 0x02, 0x03, 0x04, 0x05];
const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR resized";
const FOLDER_HASH: &str = "9046b47ac73f2574";
const STORE_HASH: &str = "33401af5b95c979a";

fn mtime_nanos(path: &Path) -> i64 {
    std::fs::metadata(path).unwrap().modified().unwrap().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos() as i64
}

/// The world with pictures: album Blue's cover is a file in its folder, album 2's is in Navidrome's image store
/// (taken out of a song's file), album Cyan has none, album 10 has no state yet.
async fn world_with_pictures() -> (World, PathBuf, PathBuf) {
    let (music, data) = {
        let base = std::env::temp_dir().join(format!("sonus-library-disk-{}-{}", std::process::id(), WORLDS.fetch_add(1, Ordering::Relaxed)));
        let _ = std::fs::remove_dir_all(&base);
        (base.join("music"), base.join("data"))
    };
    std::fs::create_dir_all(music.join("a")).unwrap();
    std::fs::create_dir_all(&data).unwrap();
    let options = LibraryOptions { data_folder: data.to_string_lossy().into_owned(), ..LibraryOptions::default() };
    let w = world_with(options, true).await;
    let db = w.db();
    db.execute("UPDATE library SET path = ?1", [music.to_string_lossy()]).unwrap();
    // a cover in the album's folder
    let cover = music.join("a").join("cover.jpg");
    std::fs::write(&cover, JPEG).unwrap();
    db.execute("DELETE FROM item_artwork", []).unwrap();
    let state = "INSERT INTO item_artwork (item_kind, item_id, hash, source, source_path, ref_mtime, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, '2026-11-24 23:42:38.07+01:00')";
    db.execute(state, ("al", "al-b", FOLDER_HASH, "folder", cover.to_string_lossy(), mtime_nanos(&cover))).unwrap();
    // a cover taken out of a song's file, kept in Navidrome's image store
    let song = music.join("a").join("One.flac");
    std::fs::write(&song, b"not really audio").unwrap();
    let stored = data.join("artwork").join("hashed").join("33").join("40");
    std::fs::create_dir_all(&stored).unwrap();
    std::fs::write(stored.join(format!("{STORE_HASH}.jpg")), [JPEG, b" from the store"].concat()).unwrap();
    db.execute(state, ("al", "al-2", STORE_HASH, "embedded", song.to_string_lossy(), mtime_nanos(&song))).unwrap();
    db.execute(state, ("al", "al-c", "", "", "", 0)).unwrap();
    for (hash, mime) in [(FOLDER_HASH, "image/jpeg"), (STORE_HASH, "image/jpeg")] {
        db.execute("INSERT INTO artwork (hash, mime, width, height, size_bytes) VALUES (?1, ?2, 600, 600, 16)", (hash, mime)).unwrap();
    }
    (w, music, data)
}

/// Puts an entry into Navidrome's cache of resized pictures, as Navidrome writes it: the bytes under the SHA-1 of
/// the key, and a marker beside them once they are whole.
fn cache_resized(data: &Path, key: &str, bytes: &[u8], complete: bool) {
    use sha1::{Digest, Sha1};
    let digest: String = Sha1::digest(key.as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
    let folder = data.join("cache").join("images").join(&digest[0..2]).join(&digest[2..4]);
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::write(folder.join(&digest), bytes).unwrap();
    if complete {
        std::fs::write(folder.join(format!("{digest}.complete")), b"").unwrap();
    }
}

impl World {
    async fn cover(&self, query: &str, if_none_match: Option<&str>) -> (StatusCode, HeaderMap, Vec<u8>) {
        let mut request = Request::get(format!("/rest/getCoverArt?{ALICE}&{query}"));
        if let Some(validator) = if_none_match {
            request = request.header(header::IF_NONE_MATCH, validator);
        }
        self.request(request.body(empty()).unwrap()).await
    }
}

#[tokio::test]
async fn a_cover_navidrome_has_settled_is_served_from_where_it_is() {
    let (w, _music, _data) = world_with_pictures().await;
    // the picture's own file, as it is: Navidrome's headers, no length (it streams), no cookie (no player here)
    let (status, headers, body) = w.cover("id=al-al-b", None).await;
    assert_eq!((status, body.as_slice()), (StatusCode::OK, JPEG));
    assert_eq!(headers["content-type"], "image/jpeg");
    assert_eq!(headers["etag"], format!("\"{FOLDER_HASH}\""));
    assert_eq!(headers["last-modified"], "Tue, 24 Nov 2026 22:42:38 GMT");
    assert_eq!(headers["cache-control"], "public, no-cache");
    assert_eq!(headers[library::ANSWERED_HEADER], "rust");
    assert!(headers.get("content-length").is_none() && headers.get("set-cookie").is_none() && headers.get("content-encoding").is_none());
    assert_eq!(headers["x-content-type-options"], "nosniff");
    assert!(w.reached().is_empty(), "Navidrome saw nothing, not even a registration");
    // asked for by its hash: the client may keep it for good; by another hash, or an old id's time stamp: it revalidates
    assert_eq!(w.cover(&format!("id=al-al-b_{FOLDER_HASH}"), None).await.1["cache-control"], "public, max-age=31536000, immutable");
    assert_eq!(w.cover(&format!("id=al-al-b_{STORE_HASH}"), None).await.1["cache-control"], "public, no-cache");
    assert_eq!(w.cover("id=al-al-b_66f1a2b3&size=-1", None).await.0, StatusCode::OK);
    // what the client has already: 304, with the validator and no body
    for validator in [format!("\"{FOLDER_HASH}\""), format!("W/\"{FOLDER_HASH}\""), "*".to_string(), format!("\"x\", \"{FOLDER_HASH}\"")] {
        let (status, headers, body) = w.cover("id=al-al-b", Some(&validator)).await;
        assert_eq!((status, body.len()), (StatusCode::NOT_MODIFIED, 0), "{validator}");
        assert_eq!(headers["etag"], format!("\"{FOLDER_HASH}\""));
        assert!(headers.get("content-type").is_none());
    }
    assert_eq!(w.cover("id=al-al-b", Some("\"something else\"")).await.0, StatusCode::OK);
    // a picture from Navidrome's image store
    let (status, headers, body) = w.cover("id=al-al-2&f=xml", None).await;
    assert_eq!((status, body), (StatusCode::OK, [JPEG, b" from the store"].concat()), "a picture whatever format is named");
    assert_eq!(headers["etag"], format!("\"{STORE_HASH}\""));
    assert!(w.reached().is_empty());
    // an admin, who sees every library
    let admin = Request::get(format!("/rest/getCoverArt.view?{ADMIN}&id=al-al-b")).body(empty()).unwrap();
    assert_eq!(w.request(admin).await.0, StatusCode::OK);
    // the user's last access is written, as Navidrome writes it for every request
    let last_access: Option<String> = w.db().query_row("SELECT last_access_at FROM user WHERE user_name = 'alice'", [], |r| r.get(0)).unwrap();
    assert!(last_access.is_some());
}

#[tokio::test]
async fn a_resized_cover_is_served_once_navidrome_has_made_it() {
    let (w, _music, data) = world_with_pictures().await;
    // not resized yet: Navidrome's to make (and to cache)
    w.navidromes(&format!("/rest/getCoverArt?{ALICE}&id=al-al-b&size=300")).await;
    // an entry Navidrome is still writing (no marker yet) is not served
    cache_resized(&data, &format!("h-{FOLDER_HASH}.300.false.q75"), PNG, false);
    w.navidromes(&format!("/rest/getCoverArt?{ALICE}&id=al-al-b&size=300")).await;
    cache_resized(&data, &format!("h-{FOLDER_HASH}.300.false.q75"), PNG, true);
    let (status, headers, body) = w.cover("id=al-al-b&size=300", None).await;
    assert_eq!((status, body.as_slice()), (StatusCode::OK, PNG));
    assert_eq!(headers["content-type"], "image/png", "named by its bytes, as Go names it");
    assert_eq!(headers["etag"], format!("\"{FOLDER_HASH}.300.false.q75\""), "a resized picture has a validator of its own");
    assert_eq!(headers["cache-control"], "public, no-cache");
    assert_eq!(w.cover(&format!("id=al-al-b_{FOLDER_HASH}&size=300"), None).await.1["cache-control"], "public, max-age=31536000, immutable");
    assert_eq!(w.cover("id=al-al-b&size=300", Some(&format!("\"{FOLDER_HASH}.300.false.q75\""))).await.0, StatusCode::NOT_MODIFIED);
    assert_eq!(w.cover("id=al-al-b&size=300", Some(&format!("\"{FOLDER_HASH}\""))).await.0, StatusCode::OK, "the full picture's validator is another");
    // every size and shape is an entry of its own
    w.navidromes(&format!("/rest/getCoverArt?{ALICE}&id=al-al-b&size=301")).await;
    w.navidromes(&format!("/rest/getCoverArt?{ALICE}&id=al-al-b&size=300&square=true")).await;
    cache_resized(&data, &format!("h-{FOLDER_HASH}.300.true.q75"), JPEG, true);
    assert_eq!(w.cover("id=al-al-b&size=300&square=1", None).await.2, JPEG);
    // a resized picture is served whatever became of its source since: Navidrome does not look either
    std::fs::remove_file(_music.join("a").join("cover.jpg")).unwrap();
    assert_eq!(w.cover("id=al-al-b&size=300", None).await.0, StatusCode::OK);
    w.navidromes(&format!("/rest/getCoverArt?{ALICE}&id=al-al-b")).await;
}

#[tokio::test]
async fn other_settings_other_cache_entries() {
    // CoverArtQuality and EnableWebPEncoding are part of what a resized picture is cached under; ImageCacheSize 0
    // means Navidrome keeps no cache, so nothing is read from one
    for (options, key, served) in [
        (LibraryOptions { cover_art_quality: 90, ..LibraryOptions::default() }, "q90", true),
        (LibraryOptions { enable_webp_encoding: true, ..LibraryOptions::default() }, "webp75", true),
        (LibraryOptions { image_cache_size: "0".into(), ..LibraryOptions::default() }, "q75", false),
    ] {
        let dir = std::env::temp_dir().join(format!("sonus-library-cache-{}-{}", std::process::id(), WORLDS.fetch_add(1, Ordering::Relaxed)));
        let data = dir.join("data");
        std::fs::create_dir_all(&data).unwrap();
        let w = world_with(LibraryOptions { data_folder: data.to_string_lossy().into_owned(), ..options }, true).await;
        w.db().execute("INSERT INTO artwork (hash, mime) VALUES (?1, 'image/jpeg')", [FOLDER_HASH]).unwrap();
        w.db()
            .execute("UPDATE item_artwork SET hash = ?1, source = 'embedded', updated_at = '2026-11-24 23:42:38+01:00' WHERE item_id = 'al-b'", [FOLDER_HASH])
            .unwrap();
        cache_resized(&data, &format!("h-{FOLDER_HASH}.64.false.q75"), JPEG, true);
        cache_resized(&data, &format!("h-{FOLDER_HASH}.64.false.{key}"), PNG, true);
        let (_, headers, body) = w.cover("id=al-al-b&size=64", None).await;
        match served {
            true => assert_eq!((body.as_slice(), headers["etag"].to_str().unwrap()), (PNG, format!("\"{FOLDER_HASH}.64.false.{key}\"").as_str())),
            false => assert_eq!(body, b"from navidrome"),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[tokio::test]
async fn covers_that_stay_navidromes() {
    let (w, music, data) = world_with_pictures().await;
    let navidromes = async |query: &str| {
        w.navidromes(&format!("/rest/getCoverArt?{ALICE}&{query}")).await;
    };
    // a disc's cover (no state: a walk through the album's folders), a song's without state, an id without its kind
    navidromes("id=dc-al-b:1").await;
    navidromes("id=mf-s-1").await;
    navidromes("id=al-b").await;
    navidromes("id=s-1").await;
    navidromes("id=ra-1").await;
    navidromes("").await;
    navidromes("id=").await;
    // no state yet (Navidrome looks, and notes what it finds), no picture (its placeholder), an unknown item
    navidromes("id=al-al-10").await;
    navidromes("id=al-al-c").await;
    navidromes("id=al-nope").await;
    // state for an item that is gone, or that is not this user's to see
    w.db()
        .execute(
            "INSERT INTO item_artwork (item_kind, item_id, hash, source, updated_at) VALUES ('al', 'al-gone', ?1, 'embedded', '2026-11-24 23:42:38+01:00')",
            [STORE_HASH],
        )
        .unwrap();
    navidromes("id=al-al-gone").await;
    w.navidromes(&format!("/rest/getCoverArt?{BOB}&id=al-al-b")).await;
    // a picture Navidrome has no row for, state without its time, a hash that is none
    w.db().execute("UPDATE item_artwork SET hash = 'ffffffffffffffff' WHERE item_id = 'al-gone'", []).unwrap();
    navidromes("id=al-al-gone").await;
    // the picture's file changed since Navidrome hashed it: Navidrome looks again
    let cover = music.join("a").join("cover.jpg");
    w.db().execute("UPDATE item_artwork SET ref_mtime = ref_mtime + 1 WHERE item_id = 'al-b'", []).unwrap();
    navidromes("id=al-al-b").await;
    w.db().execute("UPDATE item_artwork SET ref_mtime = ?1 WHERE item_id = 'al-b'", [mtime_nanos(&cover)]).unwrap();
    assert_eq!(w.cover("id=al-al-b", None).await.0, StatusCode::OK);
    // a source that is not a picture's file; bytes that are no picture Navidrome stores
    w.db().execute("UPDATE item_artwork SET source_path = ?1 WHERE item_id = 'al-b'", [music.join("a").join("One.flac").to_string_lossy()]).unwrap();
    navidromes("id=al-al-b").await;
    std::fs::write(data.join("artwork").join("hashed").join("33").join("40").join(format!("{STORE_HASH}.jpg")), b"<svg/>").unwrap();
    navidromes("id=al-al-2").await;
    // the store's file is gone, or the song it came from changed
    std::fs::remove_file(data.join("artwork").join("hashed").join("33").join("40").join(format!("{STORE_HASH}.jpg"))).unwrap();
    navidromes("id=al-al-2").await;
    // EnableMediaFileCoverArt off: a song's own cover is not served as such
    w.db()
        .execute(
            "INSERT INTO item_artwork (item_kind, item_id, hash, source, updated_at) VALUES ('mf', 's-1', ?1, 'embedded', '2026-11-24 23:42:38+01:00')",
            [FOLDER_HASH],
        )
        .unwrap();
    let off = world_with(LibraryOptions { enable_media_file_cover_art: false, ..LibraryOptions::default() }, true).await;
    off.navidromes(&format!("/rest/getCoverArt?{ALICE}&id=mf-s-1")).await;
}

#[tokio::test]
async fn lyrics_from_the_songs_row() {
    let (w, music, _data) = world_with_pictures().await;
    let stored = r#"[{"lang":"eng","line":[{"start":500,"value":"One <one>"},{"start":1500,"value":"Two"}],"offset":-250,"synced":true},{"kind":"translation","lang":"deu","line":[{"value":"Eins"}],"synced":false}]"#;
    w.db().execute("UPDATE media_file SET lyrics = ?1 WHERE id = 's-1'", [stored]).unwrap();
    let (headers, body) = w.get(&format!("/rest/getLyricsBySongId?{ALICE}&id=s-1")).await;
    // Navidrome's bytes: the main lyrics only, the song's artist and title where the lyrics name none
    let u = "\\u";
    let expected = format!(
        r#""lyricsList":{{"structuredLyrics":[{{"displayArtist":"Abe","displayTitle":"One","lang":"eng","line":[{{"start":500,"value":"One {u}003cone{u}003e"}},{{"start":1500,"value":"Two"}}],"offset":-250,"synced":true}}]}}"#
    );
    assert_eq!(body, format!("{OK},{expected}}}}}"));
    assert_eq!(headers[library::ANSWERED_HEADER], "rust");
    assert!(headers["set-cookie"].to_str().unwrap().starts_with("nd-player-"), "a player is registered, as for any method but covers");
    // unsynced lines have no time; a song without lyrics has an empty list
    w.db().execute(r#"UPDATE media_file SET lyrics = '[{"displayArtist":"X","displayTitle":"Y","lang":"xxx","line":[{"value":"la"}],"synced":false}]' WHERE id = 's-2'"#, []).unwrap();
    assert_eq!(
        w.here(&format!("/rest/getLyricsBySongId.view?{ALICE}&id=s-2")).await.1["lyricsList"]["structuredLyrics"],
        serde_json::json!([{"displayArtist": "X", "displayTitle": "Y", "lang": "xxx", "line": [{"value": "la"}], "synced": false}])
    );
    assert_eq!(w.get(&format!("/rest/getLyricsBySongId?{ALICE}&id=s-3")).await.1, format!("{OK},\"lyricsList\":{{}}}}}}"));
    // errors, in Navidrome's words
    assert_eq!(w.get(&format!("/rest/getLyricsBySongId?{ALICE}")).await.1, failed(10, "missing parameter: 'id'"));
    assert_eq!(w.get(&format!("/rest/getLyricsBySongId?{ALICE}&id=nope")).await.1, failed(70, "data not found"));
    assert_eq!(w.get(&format!("/rest/getLyricsBySongId?{BOB}&id=s-1")).await.1, failed(70, "data not found"), "not a song bob may see");
    // a lyrics file beside the song comes first in LyricsPriority, and Navidrome parses it
    std::fs::write(music.join("a").join("One.lrc"), "[00:01.00]From the file").unwrap();
    w.navidromes(&format!("/rest/getLyricsBySongId?{ALICE}&id=s-1")).await;
    w.here(&format!("/rest/getLyricsBySongId?{ALICE}&id=s-2")).await;
    std::fs::write(music.join("a").join("Three.txt"), "words").unwrap();
    w.navidromes(&format!("/rest/getLyricsBySongId?{ALICE}&id=s-3")).await;
    // enhanced lyrics (other kinds, word timings), and rows Go's decoder refuses
    w.navidromes(&format!("/rest/getLyricsBySongId?{ALICE}&id=s-2&enhanced=true")).await;
    w.here(&format!("/rest/getLyricsBySongId?{ALICE}&id=s-2&enhanced=false")).await;
    w.db().execute("UPDATE media_file SET lyrics = '{' WHERE id = 's-2'", []).unwrap();
    w.navidromes(&format!("/rest/getLyricsBySongId?{ALICE}&id=s-2")).await;
    // with "embedded" first, the row wins over the file
    let embedded_first = world_with(LibraryOptions { lyrics_priority: "embedded,.lrc".into(), ..LibraryOptions::default() }, true).await;
    embedded_first.db().execute("UPDATE library SET path = ?1", [music.to_string_lossy()]).unwrap();
    embedded_first.db().execute("UPDATE media_file SET lyrics = ?1 WHERE id = 's-1'", [stored]).unwrap();
    assert_eq!(embedded_first.here(&format!("/rest/getLyricsBySongId?{ALICE}&id=s-1")).await.1["lyricsList"]["structuredLyrics"][0]["lang"], "eng");
    // the scan's status is Navidrome's: its state is in Navidrome's memory
    w.navidromes(&format!("/rest/getScanStatus?{ALICE}")).await;
}
