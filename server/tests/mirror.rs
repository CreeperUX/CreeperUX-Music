//! The R2 mirror (part R2-a) against a fake S3 on 127.0.0.1 (`common/fake_s3.rs`), which checks every request's
//! signature as S3 does: uploads (one request and multipart), keeping in step with the library (new, changed, lost
//! and returned files; the grace time), the brakes (hours, the day's cap), the health check, failures, and the
//! daily check of the bucket. No real R2, no real keys: the fake's keys are made up for the test.

mod common;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use chrono::{DateTime, FixedOffset, TimeZone};
use common::database;
use common::fake_s3::{self, FakeS3, Fault};
use rusqlite::Connection;
use sonus_server::db::Db;
use sonus_server::mirror::ledger::{Kind, Ledger, State};
use sonus_server::mirror::s3::{Endpoint, S3, Stamp};
use sonus_server::mirror::sigv4::Signer;
use sonus_server::mirror::sync::{self, Counts, Round, Worker};
use sonus_server::mirror::throttle::{Hours, Rate};
use sonus_server::mirror::{Health, ledger};

static WORLDS: AtomicUsize = AtomicUsize::new(0);
const COVER: &str = "abcdef0123456789abcdef0123456789";
const DAY: i64 = 24 * 3600;

struct World {
    dir: PathBuf,
    music: PathBuf,
    conn: Connection,
    fake: FakeS3,
    worker: Arc<Worker>,
    clock: Arc<Mutex<DateTime<FixedOffset>>>,
    ledger: Arc<Ledger>,
}

impl Drop for World {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

impl World {
    async fn new(hours: Option<Hours>, daily: u64) -> World {
        Self::with_secret(hours, daily, fake_s3::SECRET).await
    }

    async fn with_secret(hours: Option<Hours>, daily: u64, secret: &str) -> World {
        let dir = std::env::temp_dir().join(format!("sonus-mirror-test-{}-{}", std::process::id(), WORLDS.fetch_add(1, Ordering::Relaxed)));
        let _ = std::fs::remove_dir_all(&dir);
        let (music, data) = (dir.join("music"), dir.join("data"));
        std::fs::create_dir_all(&music).unwrap();
        std::fs::create_dir_all(&data).unwrap();
        let file = data.join("navidrome.db");
        let conn = database::create(&file);
        conn.execute_batch("DROP TABLE media_file;").unwrap();
        conn.execute_batch(include_str!("common/library.sql")).unwrap();
        conn.execute("UPDATE library SET path = ?1 WHERE id = 1", [music.to_str().unwrap()]).unwrap();
        let db = Db::open(&file).unwrap();

        let fake = FakeS3::start().await;
        let endpoint = Endpoint { https: false, authority: fake.addr.to_string() };
        // small parts, so that a file of a few kB goes up in several
        let s3 = Arc::new(S3::new(endpoint, fake_s3::BUCKET, Signer::new(fake_s3::KEY_ID, secret, "auto")).with_parts(2048, 1024));
        let ledger = Arc::new(Ledger::open(&data).unwrap());
        let clock = Arc::new(Mutex::new(FixedOffset::east_opt(3600).unwrap().with_ymd_and_hms(2026, 11, 26, 1, 0, 0).unwrap()));
        let read = clock.clone();
        let worker = Arc::new(Worker {
            s3,
            ledger: ledger.clone(),
            db,
            data_folder: data,
            rate: Arc::new(Rate::new(0)),
            hours,
            daily_upload: daily,
            health: Arc::new(Health::default()),
            clock: Arc::new(move || *read.lock().unwrap()),
            known: Default::default(),
            said: Default::default(),
        });
        World { dir, music, conn, fake, worker, clock, ledger }
    }

    fn song(&self, id: &str, name: &str, body: &[u8], mtime: u64) {
        write(&self.music.join(name), body, mtime);
        self.conn
            .execute(
                "INSERT INTO media_file (id, path, title, album_id, suffix, size) VALUES (?1, ?2, ?1, 'al', ?3, ?4)",
                (id, name, Path::new(name).extension().unwrap().to_str().unwrap(), body.len() as i64),
            )
            .unwrap();
    }

    fn cover(&self, body: &[u8]) {
        let file = self.worker.data_folder.join("artwork/hashed/ab/cd").join(format!("{COVER}.jpg"));
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        write(&file, body, 1_700_000_000);
        self.conn.execute("INSERT INTO artwork (hash, mime) VALUES (?1, 'image/jpeg')", [COVER]).unwrap();
        self.conn.execute("INSERT INTO item_artwork (item_kind, item_id, hash) VALUES ('album', 'al', ?1)", [COVER]).unwrap();
    }

    fn key(&self, id: &str, name: &str) -> String {
        format!("m/{id}/{}", Stamp::of(&self.music.join(name)).unwrap().version())
    }

    fn later(&self, seconds: i64) {
        let mut clock = self.clock.lock().unwrap();
        *clock += chrono::Duration::seconds(seconds);
    }

    fn at(&self, hour: u32) {
        let mut clock = self.clock.lock().unwrap();
        *clock = clock.date_naive().and_hms_opt(hour, 0, 0).unwrap().and_local_timezone(*clock.offset()).unwrap();
    }

    async fn upload(&self) -> Round {
        self.worker.upload(tokio::time::Instant::now() + Duration::from_secs(60)).await
    }

    fn puts(&self) -> usize {
        self.fake.state.lock().unwrap().requests.iter().filter(|r| r.starts_with("PUT ")).count()
    }

    fn state(&self, key: &str) -> Option<State> {
        self.ledger.get(key).unwrap().map(|row| row.state)
    }
}

fn write(path: &Path, body: &[u8], mtime: u64) {
    std::fs::write(path, body).unwrap();
    let file = std::fs::File::options().write(true).open(path).unwrap();
    file.set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(mtime)).unwrap();
}

fn night() -> Option<Hours> {
    Hours::parse("00:00-07:00").unwrap()
}

#[tokio::test]
async fn the_library_goes_up_and_stays_in_step() {
    let w = World::new(night(), 0).await;
    let big: Vec<u8> = (0..5000u32).map(|i| (i % 251) as u8).collect();
    w.song("s1", "one.mp3", b"one's bytes", 1_700_000_000);
    w.song("s2", "two.flac", &big, 1_700_000_000);
    w.cover(b"a jpeg");

    sync::check_health(&w.worker.s3, &w.worker.health).await;
    assert!(w.worker.health.ok());
    assert!(w.fake.object("health").is_some(), "the health object is written once");
    assert_eq!(w.worker.reconcile().await.unwrap(), Counts { added: 3, kept: 0, gone: 0 });
    assert_eq!(w.upload().await, Round::Done);

    let (k1, k2) = (w.key("s1", "one.mp3"), w.key("s2", "two.flac"));
    let one = w.fake.object(&k1).unwrap();
    assert_eq!((&one.body[..], one.content_type.as_str()), (&b"one's bytes"[..], "audio/mpeg"));
    assert_eq!(one.cache_control, "private, max-age=31536000, immutable");
    assert_eq!(w.fake.object(&k2).unwrap().body, big, "in parts, put together whole");
    assert_eq!(w.fake.state.lock().unwrap().completed_multipart, 1);
    assert_eq!(w.fake.object(&format!("a/{COVER}")).unwrap().content_type, "image/jpeg");
    for key in [&k1, &k2, &format!("a/{COVER}")] {
        assert_eq!(w.state(key), Some(State::Uploaded), "{key}");
    }
    assert_eq!(w.ledger.day_bytes("2026-11-26").unwrap(), 11 + 5000 + 6);
    assert_eq!(w.fake.state.lock().unwrap().bad_signatures, 0);

    // nothing changed: nothing goes up again, even when Navidrome rewrites its rows
    let puts = w.puts();
    w.conn.execute("UPDATE media_file SET updated_at = '2026-11-27 00:00:00'", []).unwrap();
    assert_eq!(w.worker.reconcile().await.unwrap(), Counts::default());
    assert_eq!(w.upload().await, Round::Done);
    assert_eq!(w.puts(), puts);

    // a file rewritten: its new version goes up; the old one is deleted after the grace time
    write(&w.music.join("one.mp3"), b"one's new bytes", 1_700_000_500);
    let k1_new = w.key("s1", "one.mp3");
    assert_ne!(k1, k1_new);
    assert_eq!(w.worker.reconcile().await.unwrap(), Counts { added: 1, kept: 0, gone: 1 });
    assert_eq!(w.state(&k1), Some(State::Deleting));
    assert_eq!(w.upload().await, Round::Done);
    assert_eq!(&w.fake.object(&k1_new).unwrap().body[..], b"one's new bytes");
    w.worker.delete_due().await;
    assert!(w.fake.object(&k1).is_some(), "within the grace time");
    w.later(7 * DAY + 1);
    w.worker.delete_due().await;
    assert!(w.fake.object(&k1).is_none());
    assert_eq!(w.state(&k1), None);

    // a song lost for a day and back: kept; one lost for good: deleted after the grace time
    w.conn.execute("UPDATE media_file SET missing = 1", []).unwrap();
    assert_eq!(w.worker.reconcile().await.unwrap(), Counts { added: 0, kept: 0, gone: 2 });
    w.later(DAY);
    w.conn.execute("UPDATE media_file SET missing = 0 WHERE id = 's2'", []).unwrap();
    assert_eq!(w.worker.reconcile().await.unwrap(), Counts { added: 0, kept: 1, gone: 0 });
    assert_eq!(w.state(&k2), Some(State::Uploaded));
    w.later(7 * DAY);
    w.worker.delete_due().await;
    assert!(w.fake.object(&k2).is_some());
    assert!(w.fake.object(&k1_new).is_none());
    assert!(w.fake.object(&format!("a/{COVER}")).is_some(), "the cover is still the album's");
}

#[tokio::test]
async fn uploads_keep_to_the_hours_and_the_days_cap() {
    let w = World::new(night(), 15).await;
    w.song("s1", "one.mp3", b"0123456789", 1_700_000_000);
    w.song("s2", "two.mp3", b"abcdefghij", 1_700_000_000);
    sync::check_health(&w.worker.s3, &w.worker.health).await;
    w.worker.reconcile().await.unwrap();

    w.at(12);
    assert_eq!(w.upload().await, Round::Hours);
    assert_eq!(w.puts(), 1, "the health object only");

    w.at(6);
    assert_eq!(w.upload().await, Round::Capped, "10 of 15 bytes used: the next 10 wait");
    assert_eq!(w.fake.keys().iter().filter(|k| k.starts_with("m/")).count(), 1);
    w.later(DAY);
    assert_eq!(w.upload().await, Round::Done, "a new day");
    assert_eq!(w.fake.keys().iter().filter(|k| k.starts_with("m/")).count(), 2);
}

#[tokio::test]
async fn a_file_larger_than_the_cap_still_goes_on_a_day_of_its_own() {
    let w = World::new(None, 5).await;
    w.song("s1", "one.mp3", b"0123456789", 1_700_000_000);
    sync::check_health(&w.worker.s3, &w.worker.health).await;
    w.worker.reconcile().await.unwrap();
    assert_eq!(w.upload().await, Round::Done);
    assert!(w.fake.object(&w.key("s1", "one.mp3")).is_some());
}

#[tokio::test]
async fn wrong_keys_and_a_refusing_bucket_stop_the_uploads() {
    let wrong = World::with_secret(None, 0, "not-the-secret").await;
    wrong.song("s1", "one.mp3", b"bytes", 1_700_000_000);
    sync::check_health(&wrong.worker.s3, &wrong.worker.health).await;
    assert!(!wrong.worker.health.ok());
    assert!(wrong.fake.state.lock().unwrap().bad_signatures > 0, "the fake checks the signature");
    wrong.worker.reconcile().await.unwrap();
    assert_eq!(wrong.upload().await, Round::Unhealthy);

    let w = World::new(None, 0).await;
    w.song("s1", "one.mp3", b"bytes", 1_700_000_000);
    sync::check_health(&w.worker.s3, &w.worker.health).await;
    w.worker.reconcile().await.unwrap();
    w.fake.set_fault(Fault::Refuse);
    assert_eq!(w.upload().await, Round::Unhealthy, "403 on the upload itself");
    assert!(!w.worker.health.ok());
    assert_eq!(w.state(&w.key("s1", "one.mp3")), Some(State::Pending));

    w.fake.set_fault(Fault::Down);
    sync::check_health(&w.worker.s3, &w.worker.health).await;
    assert!(!w.worker.health.ok());
    w.fake.set_fault(Fault::None);
    sync::check_health(&w.worker.s3, &w.worker.health).await;
    assert!(w.worker.health.ok(), "back when the bucket answers");
    assert_eq!(w.upload().await, Round::Done);
    assert_eq!(w.state(&w.key("s1", "one.mp3")), Some(State::Uploaded));
}

#[tokio::test]
async fn failing_uploads_back_off_then_wait_for_the_daily_check() {
    let w = World::new(None, 0).await;
    w.song("s1", "one.mp3", b"bytes", 1_700_000_000);
    let key = w.key("s1", "one.mp3");
    sync::check_health(&w.worker.s3, &w.worker.health).await;
    w.worker.reconcile().await.unwrap();
    w.fake.set_fault(Fault::FailPuts);
    for tries in 1..=sync::MAX_FAILURES {
        assert_eq!(w.upload().await, Round::Done);
        let row = w.ledger.get(&key).unwrap().unwrap();
        assert_eq!(row.failures, tries);
        let puts = w.puts();
        assert_eq!(w.upload().await, Round::Done);
        assert_eq!(w.puts(), puts, "not again before its time");
        w.later(DAY);
    }
    let puts = w.puts();
    assert_eq!(w.upload().await, Round::Done);
    assert_eq!(w.puts(), puts, "five failures: left alone");

    w.fake.set_fault(Fault::None);
    w.worker.check_bucket().await.unwrap();
    assert_eq!(w.upload().await, Round::Done);
    assert_eq!(w.state(&key), Some(State::Uploaded));
}

#[tokio::test]
async fn the_daily_check_puts_back_what_the_bucket_lost_and_clears_what_it_should_not_have() {
    let w = World::new(None, 0).await;
    w.song("s1", "one.mp3", b"one", 1_700_000_000);
    w.song("s2", "two.mp3", b"two", 1_700_000_000);
    w.song("s3", "three.mp3", b"three", 1_700_000_000);
    sync::check_health(&w.worker.s3, &w.worker.health).await;
    w.worker.reconcile().await.unwrap();
    assert_eq!(w.upload().await, Round::Done);

    let lost = w.key("s2", "two.mp3");
    w.fake.remove(&lost);
    w.fake.put("m/stray/0123456789abcdef", b"left by someone");
    w.fake.put("manifest/2026-11-25.json.gz", b"a later part's");
    // five objects and the health object, two to a page: the listing is read to its end
    w.worker.check_bucket().await.unwrap();
    assert_eq!(w.state(&lost), Some(State::Pending));
    assert_eq!(w.state("m/stray/0123456789abcdef"), Some(State::Deleting));
    assert_eq!(w.upload().await, Round::Done);
    assert_eq!(&w.fake.object(&lost).unwrap().body[..], b"two");

    w.later(7 * DAY + 1);
    w.worker.delete_due().await;
    assert!(w.fake.object("m/stray/0123456789abcdef").is_none());
    assert!(w.fake.object("manifest/2026-11-25.json.gz").is_some(), "not the mirror's songs or covers: left alone");
    assert!(w.fake.object("health").is_some());
    assert_eq!(w.ledger.rows(Kind::Song).unwrap().len(), 3);
}

#[tokio::test]
async fn a_ledger_lost_costs_an_upload_and_nothing_more() {
    let w = World::new(None, 0).await;
    w.song("s1", "one.mp3", b"one", 1_700_000_000);
    sync::check_health(&w.worker.s3, &w.worker.health).await;
    w.worker.reconcile().await.unwrap();
    assert_eq!(w.upload().await, Round::Done);
    let key = w.key("s1", "one.mp3");
    w.ledger.apply(&[ledger::Change::Forget { key: key.clone() }]).unwrap();

    w.worker.reconcile().await.unwrap();
    assert_eq!(w.upload().await, Round::Done);
    assert_eq!(w.state(&key), Some(State::Uploaded));
    assert_eq!(&w.fake.object(&key).unwrap().body[..], b"one");
}

#[test]
fn the_ledger_is_its_own_file() {
    let dir = std::env::temp_dir().join(format!("sonus-mirror-ledger-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    drop(Ledger::open(&dir).unwrap());
    assert!(dir.join(ledger::FILE_NAME).is_file());
    let _ = std::fs::remove_dir_all(&dir);
}
