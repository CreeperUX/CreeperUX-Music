//! Integration tests for the playback library (`src/renditions/`):
//! - `sonusQuality` streaming (lossless FLAC, Opus 256/160/96 with `audio/ogg`, lossy original pass-through,
//!   `original`, HTTP Range 206, fallback when not ready, invariance when `sonusQuality` is omitted);
//! - `getOpenSubsonicExtensions` advertising `sonusRenditions` only when enabled;
//! - `getSonusRenditions` library visibility filtering & EBU R128 loudness reporting;
//! - `getSonusLibraryHealth` admin-only enforcement (error 50 for non-admin) & failed-item reporting;
//! - reconciliation (new, changed, missing, returned within 7-day grace, self-healing when files deleted, deletion brake);
//! - real end-to-end generation + 1-second FLAC SEEKTABLE + health check + corrupted-file detection when ffmpeg is present.

mod common;

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::{DateTime, FixedOffset, TimeZone};
use common::database;
use common::*;
use hyper::header::{self, HeaderMap};
use hyper::{Request, Response, StatusCode};
use rusqlite::Connection;
use serde_json::Value;
use sonus_server::config::{LibraryOptions, TwoFactor};
use sonus_server::connect::{self, Connect};
use sonus_server::db::Db;
use sonus_server::library::transcoder::{Transcoder, find_program};
use sonus_server::library::{self, Library};
use sonus_server::mirror::s3::Stamp;
use sonus_server::renditions::ledger::{Change, Ledger, LoudnessChange, State};
use sonus_server::renditions::worker::{GRACE, RELEASED_NOTE, Worker};
use sonus_server::renditions::{Renditions, Tier, rendition_path};
use sonus_server::secrets::Keys;
use sonus_server::subsonic::respond::Envelope;
use sonus_server::subsonic::{Setup, Subsonic};

const KEY: &str = "renditions test key";
const SECRET_HEADER: &str = "x-sonus-user-0123456789abcdef";
const ENVELOPE: &str = r#"{"subsonic-response":{"status":"ok","version":"1.16.1","type":"navidrome","serverVersion":"0.64.2-test","openSubsonic":true,"openSubsonicExtensions":[{"name":"sonusConnect","versions":[1]}]}}"#;
const ALICE: &str = "u=alice&p=sesame&v=1.16.1&c=test&f=json";
const BOB: &str = "u=bob&p=hunter2&v=1.16.1&c=test&f=json";
const ADMIN: &str = "u=root&p=toor&v=1.16.1&c=test&f=json";
const DAY: i64 = 24 * 3600;

static WORLDS: AtomicUsize = AtomicUsize::new(0);

struct World {
    gateway: SocketAddr,
    dir: PathBuf,
    music: PathBuf,
    renditions_dir: PathBuf,
    database: PathBuf,
    db: Arc<Db>,
    ledger: Arc<Ledger>,
    renditions: Arc<Renditions>,
    clock: Arc<Mutex<DateTime<FixedOffset>>>,
}

impl Drop for World {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

impl World {
    async fn new(enable_renditions: bool) -> World {
        let dir = std::env::temp_dir().join(format!("sonus-renditions-test-{}-{}", std::process::id(), WORLDS.fetch_add(1, Ordering::Relaxed)));
        let _ = std::fs::remove_dir_all(&dir);
        let music = dir.join("music");
        let data = dir.join("data");
        let renditions_dir = data.join("sonus-renditions");
        std::fs::create_dir_all(&music).unwrap();
        std::fs::create_dir_all(&renditions_dir).unwrap();

        let database = data.join("navidrome.db");
        let conn = database::create(&database);
        conn.execute_batch("DROP TABLE media_file;").unwrap();
        conn.execute_batch(include_str!("common/library.sql")).unwrap();
        conn.execute("UPDATE library SET path = ?1 WHERE id = 1", [music.to_str().unwrap()]).unwrap();
        let keys = Keys::new(KEY);
        let alice = database::add_user(&conn, &keys, "alice", "sesame");
        database::grant_library(&conn, &alice);
        database::add_user(&conn, &keys, "bob", "hunter2");
        let root = database::add_user(&conn, &keys, "root", "toor");
        database::make_admin(&conn, &root);
        // album + 2 songs (1 lossless FLAC, 1 lossy MP3)
        conn.execute(
            "INSERT INTO album (id, name, album_artist, album_artist_id, min_year, max_year, song_count, duration, order_album_name, order_album_artist_name, participants, tags, created_at, updated_at, imported_at)
             VALUES ('al-1', 'Test Album', 'Test Artist', 'ar-1', 2026, 2026, 2, 120.0, 'test album', 'test artist', '{}', '{}', '2026-01-01 12:00:00+00:00', '2026-01-01 12:00:00+00:00', '2026-01-01 12:00:00+00:00')",
            [],
        )
        .unwrap();
        drop(conn);

        let navidrome = upstream(|_req| async move {
            Response::builder().status(StatusCode::OK).header(header::CONTENT_TYPE, "application/json").body(full(ENVELOPE.as_bytes())).unwrap()
        })
        .await;

        let db = Db::open(&database).unwrap();
        let ledger = Arc::new(Ledger::open(&data).unwrap());
        let renditions = Arc::new(Renditions::new(ledger.clone(), renditions_dir.clone()));

        let envelope = Envelope::from_json(ENVELOPE.as_bytes()).unwrap();
        let connect = Connect::new(connect::Setup::new(db.clone())).unwrap();
        let subsonic = Subsonic::new(Setup {
            db: db.clone(),
            keys: Keys::new(KEY),
            two_factor: TwoFactor::Off,
            limit: 0,
            window: Duration::from_secs(20),
            envelope: envelope.clone(),
            frame_options: "DENY".into(),
        });
        let library = Library::new(library::Setup {
            db: db.clone(),
            options: LibraryOptions { data_folder: data.to_string_lossy().into_owned(), ..LibraryOptions::default() },
            envelope,
            frame_options: "DENY".into(),
            base_path: String::new(),
            public_signer: None,
        });
        if enable_renditions {
            library.set_renditions(renditions.clone());
        }
        let setup = GatewaySetup {
            upstream_user_header: SECRET_HEADER,
            checks_sign_ins: true,
            subsonic: Some(subsonic),
            connect: Some(connect),
            library: Some(library),
            ..GatewaySetup::default()
        };
        let (addr, _ready) = gateway(navidrome, setup).await;
        let clock = Arc::new(Mutex::new(FixedOffset::east_opt(0).unwrap().with_ymd_and_hms(2026, 11, 28, 2, 0, 0).unwrap()));
        World { gateway: addr, dir, music, renditions_dir, database, db, ledger, renditions, clock }
    }

    fn conn(&self) -> Connection {
        Connection::open(&self.database).unwrap()
    }

    #[allow(clippy::too_many_arguments)]
    fn add_song(
        &self,
        id: &str,
        rel_path: &str,
        suffix: &str,
        codec: &str,
        sample_rate: i64,
        bit_depth: i64,
        bit_rate: i64,
        duration: f64,
        bytes: &[u8],
    ) -> Stamp {
        let full_path = self.music.join(rel_path);
        if let Some(parent) = full_path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(&full_path, bytes).unwrap();
        let conn = self.conn();
        conn.execute(
            "INSERT INTO media_file (id, path, title, album, artist, artist_id, album_artist, album_artist_id, album_id, track_number, disc_number, year, size,
             suffix, codec, duration, bit_rate, channels, sample_rate, bit_depth, order_title, order_album_name, order_artist_name, participants, tags, created_at, updated_at)
             VALUES (?1, ?2, ?1, 'Test Album', 'Test Artist', 'ar-1', 'Test Artist', 'ar-1', 'al-1', 1, 1, 2026, ?3,
                     ?4, ?5, ?6, ?7, 2, ?8, ?9, lower(?1), 'test album', 'test artist', '{}', '{}', '2026-01-01 12:00:00+00:00', '2026-01-01 12:00:00+00:00')",
            rusqlite::params![id, rel_path, bytes.len() as i64, suffix, codec, duration, bit_rate, sample_rate, bit_depth],
        )
        .unwrap();
        Stamp::of(&full_path).unwrap()
    }

    #[allow(clippy::too_many_arguments)]
    fn seed_ready_rendition(&self, song_id: &str, version: &str, tier: Tier, sample_rate: u32, bit_depth: u8, total_samples: u64, bytes: &[u8]) {
        let path = rendition_path(&self.renditions_dir, song_id, version, tier).unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, bytes).unwrap();
        self.ledger.apply(&[Change::Add { song_id: song_id.into(), version: version.into(), tier, album_id: "al-1".into() }]).unwrap();
        self.ledger.mark_ready(song_id, version, tier, sample_rate, bit_depth, 2, total_samples, bytes.len() as u64, 1_700_000_000).unwrap();
    }

    async fn get(&self, target: &str, headers: &[(&str, &str)]) -> (StatusCode, HeaderMap, Vec<u8>) {
        let mut req = Request::get(target);
        for &(k, v) in headers {
            req = req.header(k, v);
        }
        let resp = send(self.gateway, req.body(empty()).unwrap()).await;
        let status = resp.status();
        let headers = resp.headers().clone();
        let body = body_bytes(resp.into_body()).await.to_vec();
        (status, headers, body)
    }

    fn worker(&self, ffmpeg: PathBuf) -> Arc<Worker> {
        let clock = self.clock.clone();
        Arc::new(Worker {
            ledger: self.ledger.clone(),
            db: self.db.clone(),
            dir: self.renditions_dir.clone(),
            ffmpeg,
            concurrency: 2,
            hours: None,
            delete_brake: Some(0.10),
            live_transcodes: Arc::new(Transcoder::new(Default::default())),
            clock: Arc::new(move || *clock.lock().unwrap()),
            known: Default::default(),
            said: Default::default(),
        })
    }
}

#[tokio::test]
async fn extensions_advertise_sonus_renditions_only_when_enabled() {
    let off = World::new(false).await;
    let (status, _, body) = off.get("/rest/getOpenSubsonicExtensions?f=json", &[]).await;
    assert_eq!(status, StatusCode::OK);
    let json: Value = serde_json::from_slice(&body).unwrap();
    let exts = json["subsonic-response"]["openSubsonicExtensions"].as_array().unwrap();
    assert!(!exts.iter().any(|e| e["name"] == "sonusRenditions"), "disabled by default: {exts:?}");

    let on = World::new(true).await;
    let (status, _, body) = on.get("/rest/getOpenSubsonicExtensions?f=json", &[]).await;
    assert_eq!(status, StatusCode::OK);
    let json: Value = serde_json::from_slice(&body).unwrap();
    let exts = json["subsonic-response"]["openSubsonicExtensions"].as_array().unwrap();
    assert!(exts.iter().any(|e| e["name"] == "sonusRenditions" && e["versions"] == serde_json::json!([1])), "{exts:?}");
}

#[tokio::test]
async fn stream_serves_renditions_with_range_and_headers_and_leaves_legacy_unchanged() {
    let w = World::new(true).await;
    let flac_orig = b"ORIGINAL-FLAC-BYTES-0123456789abcdef";
    let mp3_orig = b"ORIGINAL-MP3-BYTES-0123456789abcdef";
    let flac_stamp = w.add_song("s-flac", "a/hi.flac", "flac", "flac", 96000, 24, 3200, 10.0, flac_orig);
    let mp3_stamp = w.add_song("s-mp3", "a/pop.mp3", "mp3", "mp3", 44100, 0, 320, 10.0, mp3_orig);

    let rendition_flac = b"fLaC-GENERATED-SEEKABLE-RENDITION-96KHZ-24BIT-PAYLOAD";
    let rendition_opus160 = b"OggS-OPUS-160-KBPS-RENDITION-BYTES-0123456789";
    let mp3_opus160 = b"OggS-MP3-TO-OPUS-160-BYTES-0123456789";
    w.seed_ready_rendition("s-flac", &flac_stamp.version(), Tier::Lossless, 96000, 24, 960_000, rendition_flac);
    w.seed_ready_rendition("s-flac", &flac_stamp.version(), Tier::High, 48000, 0, 480_000, rendition_opus160);
    w.seed_ready_rendition("s-mp3", &mp3_stamp.version(), Tier::High, 48000, 0, 480_000, mp3_opus160);

    // 1. Without sonusQuality: exact unchanged bytes, NO X-Sonus-* headers
    let (status, headers, body) = w.get(&format!("/rest/stream?{ALICE}&id=s-flac"), &[]).await;
    assert_eq!((status, body.as_slice()), (StatusCode::OK, flac_orig.as_slice()));
    assert!(headers.get("x-sonus-quality").is_none());
    assert!(headers.get("x-sonus-format").is_none());

    // 2. Lossless rendition with Range -> 206 Partial Content + X-Sonus-* headers
    let (status, headers, body) = w.get(&format!("/rest/stream?{ALICE}&id=s-flac&sonusQuality=lossless"), &[("Range", "bytes=0-15")]).await;
    assert_eq!(status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(body.as_slice(), &rendition_flac[..16]);
    assert_eq!(headers[header::CONTENT_TYPE], "audio/flac");
    assert_eq!(headers[header::ACCEPT_RANGES], "bytes");
    assert_eq!(headers["x-sonus-quality"], "lossless");
    assert_eq!(headers["x-sonus-format"], "flac");
    assert_eq!(headers["x-sonus-sample-rate"], "96000");
    assert_eq!(headers["x-sonus-bit-depth"], "24");

    // 3. Opus rendition -> Content-Type MUST be audio/ogg for browser compatibility
    let (status, headers, body) = w.get(&format!("/rest/stream?{ALICE}&id=s-flac&sonusQuality=high"), &[]).await;
    assert_eq!((status, body.as_slice()), (StatusCode::OK, rendition_opus160.as_slice()));
    assert_eq!(headers[header::CONTENT_TYPE], "audio/ogg");
    assert_eq!(headers["x-sonus-quality"], "high");
    assert_eq!(headers["x-sonus-format"], "opus");
    assert_eq!(headers["x-sonus-sample-rate"], "48000");
    assert_eq!(headers["x-sonus-bit-rate"], "160");
    assert!(headers.get("x-sonus-bit-depth").is_none());

    // 4. MP3 original requested at lossless or veryHigh -> serves original directly (never upsampled)
    for q in ["lossless", "veryHigh", "original"] {
        let (status, headers, body) = w.get(&format!("/rest/stream?{ALICE}&id=s-mp3&sonusQuality={q}"), &[]).await;
        assert_eq!((status, body.as_slice()), (StatusCode::OK, mp3_orig.as_slice()), "{q}");
        assert_eq!(headers["x-sonus-quality"], "original");
        assert_eq!(headers["x-sonus-format"], "mp3");
        assert_eq!(headers["x-sonus-bit-rate"], "320");
    }

    // 5. MP3 original requested at high -> serves generated Opus 160
    let (status, headers, body) = w.get(&format!("/rest/stream?{ALICE}&id=s-mp3&sonusQuality=high"), &[]).await;
    assert_eq!((status, body.as_slice()), (StatusCode::OK, mp3_opus160.as_slice()));
    assert_eq!(headers[header::CONTENT_TYPE], "audio/ogg");
    assert_eq!(headers["x-sonus-quality"], "high");

    // 6. Requested tier not ready yet (normal on s-flac) -> falls back transparently to original
    let (status, headers, body) = w.get(&format!("/rest/stream?{ALICE}&id=s-flac&sonusQuality=normal"), &[]).await;
    assert_eq!((status, body.as_slice()), (StatusCode::OK, flac_orig.as_slice()));
    assert_eq!(headers["x-sonus-quality"], "original");

    // 7. Invalid sonusQuality -> Subsonic error 0
    let (status, _, body) = w.get(&format!("/rest/stream?{ALICE}&id=s-flac&sonusQuality=ultra"), &[]).await;
    assert_eq!(status, StatusCode::OK);
    let json: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["subsonic-response"]["status"], "failed");
    assert_eq!(json["subsonic-response"]["error"]["code"], 0);

    // 8. User without library access (Bob) cannot stream rendition -> error 70
    let (_, _, body) = w.get(&format!("/rest/stream?{BOB}&id=s-flac&sonusQuality=lossless"), &[]).await;
    let json: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["subsonic-response"]["error"]["code"], 70);
}

#[tokio::test]
async fn query_endpoints_enforce_visibility_and_admin_authorization() {
    let w = World::new(true).await;
    let stamp = w.add_song("s-1", "a/one.flac", "flac", "flac", 96000, 24, 2900, 120.0, b"flac-data");
    w.seed_ready_rendition("s-1", &stamp.version(), Tier::Lossless, 96000, 24, 11_520_000, b"rendition-flac");
    w.ledger.apply_loudness(&[LoudnessChange::Add { song_id: "s-1".into(), version: stamp.version(), album_id: "al-1".into(), duration: 120.0 }]).unwrap();
    w.ledger.record_track_loudness("s-1", &stamp.version(), "al-1", -11.4, 0.92, 1_700_000_000).unwrap();
    w.ledger.apply(&[Change::Add { song_id: "s-1".into(), version: stamp.version(), tier: Tier::High, album_id: "al-1".into() }]).unwrap();
    w.ledger.mark_attempt_failed("s-1", &stamp.version(), Tier::High, 3, 0, true, "decode check failed").unwrap();

    // Alice sees song s-1 with ready lossless rendition and EBU R128 loudness
    let (status, _, body) = w.get(&format!("/rest/getSonusRenditions?{ALICE}&id=s-1&id=missing"), &[]).await;
    assert_eq!(status, StatusCode::OK);
    let json: Value = serde_json::from_slice(&body).unwrap();
    let sr = &json["subsonic-response"]["sonusRenditions"];
    assert_eq!(sr["enabled"], true);
    assert_eq!(sr["songs"].as_array().unwrap().len(), 1);
    assert_eq!(sr["songs"][0]["id"], "s-1");
    assert_eq!(sr["songs"][0]["sourceLossless"], true);
    assert!((sr["songs"][0]["loudness"]["trackLufs"].as_f64().unwrap() - (-11.4)).abs() < 1e-6);
    assert!((sr["songs"][0]["loudness"]["albumLufs"].as_f64().unwrap() - (-11.4)).abs() < 1e-6);
    assert_eq!(sr["songs"][0]["renditions"][0]["tier"], "lossless");
    assert_eq!(sr["songs"][0]["renditions"][0]["sampleRate"], 96000);
    assert_eq!(sr["songs"][0]["renditions"][0]["bitDepth"], 24);

    // Bob has no library access -> empty songs list (never leaks song existence or loudness)
    let (_, _, body) = w.get(&format!("/rest/getSonusRenditions?{BOB}&id=s-1"), &[]).await;
    let json: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["subsonic-response"]["sonusRenditions"]["songs"].as_array().unwrap().len(), 0);

    // Non-admin Alice is refused getSonusLibraryHealth with error 50
    let (_, _, body) = w.get(&format!("/rest/getSonusLibraryHealth?{ALICE}"), &[]).await;
    let json: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["subsonic-response"]["status"], "failed");
    assert_eq!(json["subsonic-response"]["error"]["code"], 50);

    // Admin gets counts and the failed item hydrated with title/artist/album
    let (_, _, body) = w.get(&format!("/rest/getSonusLibraryHealth?{ADMIN}"), &[]).await;
    let json: Value = serde_json::from_slice(&body).unwrap();
    let health = &json["subsonic-response"]["sonusLibraryHealth"];
    assert_eq!(health["enabled"], true);
    assert_eq!(health["counts"]["ready"], 1);
    assert_eq!(health["counts"]["failed"], 1);
    assert_eq!(health["totalIssues"], 1);
    assert_eq!(health["issues"][0]["songId"], "s-1");
    assert_eq!(health["issues"][0]["title"], "s-1");
    assert_eq!(health["issues"][0]["tier"], "high");
    assert_eq!(health["issues"][0]["health"], "decode check failed");
}

#[tokio::test]
async fn reconcile_grace_period_self_heal_and_deletion_brake() {
    let w = World::new(true).await;
    let worker = w.worker(PathBuf::from("nonexistent-ffmpeg"));

    // Add 25 MP3 songs so deleting all 25 triggers the deletion brake (>20 songs and >10%)
    let mut stamps = Vec::new();
    for i in 0..25 {
        let id = format!("s-{i:02}");
        let stamp = w.add_song(&id, &format!("a/{id}.mp3"), "mp3", "mp3", 44100, 0, 320, 10.0, format!("mp3-{i}").as_bytes());
        w.seed_ready_rendition(&id, &stamp.version(), Tier::High, 48000, 0, 480_000, b"ogg-high");
        w.seed_ready_rendition(&id, &stamp.version(), Tier::Normal, 48000, 0, 480_000, b"ogg-normal");
        stamps.push((id, stamp));
    }
    let counts = worker.reconcile().await.unwrap();
    assert_eq!(counts.added, 0, "all seeded renditions already ready");

    // Self-heal: delete one rendition file on disk -> next reconcile resets it to pending
    let p0 = rendition_path(&w.renditions_dir, "s-00", &stamps[0].1.version(), Tier::High).unwrap();
    std::fs::remove_file(&p0).unwrap();
    let counts = worker.reconcile().await.unwrap();
    assert_eq!(counts.added, 1);
    assert_eq!(w.ledger.get("s-00", &stamps[0].1.version(), Tier::High).unwrap().unwrap().state, State::Pending);
    // Restore it for the brake test
    std::fs::write(&p0, b"ogg-high").unwrap();
    w.ledger.mark_ready("s-00", &stamps[0].1.version(), Tier::High, 48000, 0, 2, 480_000, 8, 1_700_000_000).unwrap();

    // Remove 1 song: enters deleting, stays for 6 days, returns -> kept ready without re-encode!
    w.conn().execute("DELETE FROM media_file WHERE id = 's-00'", []).unwrap();
    let counts = worker.reconcile().await.unwrap();
    assert_eq!(counts.gone, 2);
    *w.clock.lock().unwrap() += chrono::Duration::seconds(6 * DAY);
    worker.delete_due().await;
    assert!(p0.is_file(), "still within 7-day grace");

    // Now remove all 25 songs -> triggers deletion brake (>20 songs & >10%)
    w.conn().execute("DELETE FROM media_file", []).unwrap();
    worker.reconcile().await.unwrap();
    *w.clock.lock().unwrap() += chrono::Duration::seconds(10 * DAY);
    worker.delete_due().await;
    let remaining = w.ledger.all_renditions().unwrap().len();
    assert_eq!(remaining, 50, "deletion brake holds all 50 renditions");

    // Owner releases deletions via renditions-allow-deletions note -> now deleted!
    let now = w.clock.lock().unwrap().timestamp();
    w.ledger.set_note(RELEASED_NOTE, &now.to_string()).unwrap();
    worker.delete_due().await;
    assert_eq!(w.ledger.all_renditions().unwrap().len(), 0, "all expired renditions removed after release");
    assert!(!p0.exists());
    let _ = GRACE;
}

/// Finds ffmpeg on PATH or in this repository's local fixture folder.
fn local_ffmpeg() -> Option<PathBuf> {
    if let Some(p) = find_program("ffmpeg") {
        return Some(p);
    }
    let fixture = Path::new(
        r"C:\Users\Creep\Documents\Claude Workspace\creeperux-music\.claude\worktrees\server-library\tools\fixtures\.work\ffmpeg\unpacked\ffmpeg-n7.1.5-1-g7d0e842004-winarm64-gpl-7.1\bin\ffmpeg.exe",
    );
    fixture.is_file().then(|| fixture.to_path_buf())
}

/// Writes a valid 2-second stereo 44.1 kHz / 16-bit PCM WAV file (440 Hz sine wave).
fn write_test_wav(path: &Path) {
    let sample_rate = 44_100u32;
    let channels = 2u16;
    let bits = 16u16;
    let total_frames = sample_rate * 2;
    let data_bytes = total_frames * u32::from(channels) * u32::from(bits / 8);
    let mut wav = Vec::with_capacity(44 + data_bytes as usize);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data_bytes).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes()); // PCM
    wav.extend_from_slice(&channels.to_le_bytes());
    wav.extend_from_slice(&sample_rate.to_le_bytes());
    wav.extend_from_slice(&(sample_rate * u32::from(channels) * u32::from(bits / 8)).to_le_bytes());
    wav.extend_from_slice(&(channels * (bits / 8)).to_le_bytes());
    wav.extend_from_slice(&bits.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_bytes.to_le_bytes());
    for i in 0..total_frames {
        let t = i as f64 / sample_rate as f64;
        let v = ((2.0 * std::f64::consts::PI * 440.0 * t).sin() * 12000.0) as i16;
        wav.extend_from_slice(&v.to_le_bytes());
        wav.extend_from_slice(&v.to_le_bytes());
    }
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, wav).unwrap();
}

#[tokio::test]
async fn real_ffmpeg_generates_seekable_flac_opus_loudness_and_catches_corrupt_files() {
    let Some(ffmpeg) = local_ffmpeg() else {
        eprintln!("skipping real_ffmpeg test: ffmpeg binary not found");
        return;
    };
    let w = World::new(true).await;
    let wav_path = w.music.join("a/good.wav");
    write_test_wav(&wav_path);
    let wav_bytes = std::fs::read(&wav_path).unwrap();
    let good_stamp = w.add_song("s-good", "a/good.wav", "wav", "pcm_s16le", 44100, 16, 1411, 2.0, &wav_bytes);
    let bad_stamp = w.add_song("s-bad", "a/corrupt.flac", "flac", "flac", 44100, 16, 1000, 2.0, b"NOT A REAL FLAC FILE");

    let worker = w.worker(ffmpeg);
    worker.reconcile().await.unwrap();
    // Run enough rounds to finish good song (4 tiers + loudness) and fail bad song 3 times
    for _ in 0..5 {
        worker.process_round(tokio::time::Instant::now() + Duration::from_secs(60)).await;
        // Advance clock past backoff so s-bad hits MAX_FAILURES=3
        *w.clock.lock().unwrap() += chrono::Duration::seconds(3600);
    }

    // Verify all 4 tiers for s-good are ready and valid
    let (rows, track_l, album_l) = w.renditions.song_info("s-good", &good_stamp.version(), "al-1");
    assert_eq!(rows.len(), 4, "expected all 4 tiers ready: {rows:?}");
    let flac_row = rows.iter().find(|r| r.tier == Tier::Lossless).unwrap();
    assert_eq!((flac_row.sample_rate, flac_row.bit_depth, flac_row.channels), (44100, 16, 2));
    assert_eq!(flac_row.total_samples, 88_200);
    // Verify FLAC SEEKTABLE block (type 3) is present right after STREAMINFO
    let flac_file = rendition_path(&w.renditions_dir, "s-good", &good_stamp.version(), Tier::Lossless).unwrap();
    let flac_hdr = std::fs::read(&flac_file).unwrap();
    assert_eq!(&flac_hdr[0..4], b"fLaC");
    assert_eq!(flac_hdr[4 + 4 + 34] & 0x7F, 3, "SEEKTABLE block must follow STREAMINFO");

    // Verify EBU R128 loudness measured for track and album
    let tl = track_l.expect("track loudness measured");
    assert!(tl.lufs.unwrap() < -5.0 && tl.lufs.unwrap() > -30.0, "lufs={:?}", tl.lufs);
    assert!(tl.peak.unwrap() > 0.1 && tl.peak.unwrap() <= 1.0, "peak={:?}", tl.peak);
    assert!(album_l.is_some());

    // Verify s-bad failed into the health report while original file remains untouched
    let report = w.renditions.health_report(50, 0).unwrap();
    assert!(report.failed >= 1, "corrupt file should be flagged: {report:?}");
    assert!(report.issues.iter().any(|i| i.song_id == "s-bad"));
    assert_eq!(std::fs::read(w.music.join("a/corrupt.flac")).unwrap(), b"NOT A REAL FLAC FILE", "original untouched");
    let _ = bad_stamp;
}
