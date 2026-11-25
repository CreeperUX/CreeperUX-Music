//! Keeping the bucket in step with the library (`docs/r2-mirror.md`, section 4): a reconciliation at start and every
//! 15 minutes, uploads one at a time within the hours and the day's cap, deletions after a grace time, and once a
//! day a check of the whole bucket against the ledger.
//!
//! Each step takes the time from the worker's clock, so the tests can move it.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::{DateTime, FixedOffset};
use tracing::{debug, info, warn};

use super::Health;
use super::ledger::{Change, Kind, Ledger, Row, State};
use super::s3::{self, S3, Stamp};
use super::throttle::{Hours, Rate};
use crate::db::Db;
use crate::library::media::artwork_file;
use crate::library::stream::inside_library;

pub const RECONCILE_EVERY: Duration = Duration::from_secs(15 * 60);
pub const HEALTH_EVERY: Duration = Duration::from_secs(60);
/// How long an object the library lost stays in the bucket: a library folder not mounted for a while must not
/// empty the bucket.
pub const GRACE: i64 = 7 * 24 * 3600;
/// Failures in a row after which a file waits for the daily check.
pub const MAX_FAILURES: u32 = 5;
/// The object the health check reads (and writes once when it is not there).
pub const HEALTH_KEY: &str = "health";
const HEALTH_BODY: &[u8] = b"Sonus mirror health check\n";
/// What the objects say about being kept: forever under their name (a new version is a new name), never shared.
const CACHE_CONTROL: &str = "private, max-age=31536000, immutable";
/// The ledger's note of the day the whole bucket was last checked.
const CHECKED_NOTE: &str = "full_check_day";

/// An object the library has now: where its file is, and what it is.
#[derive(Clone, Debug)]
pub struct Wanted {
    pub kind: Kind,
    pub item: String,
    pub stamp: Stamp,
    pub version: String,
    pub path: PathBuf,
    pub content_type: String,
}

/// What has been logged already, to say a lasting condition once.
#[derive(Default)]
pub struct Said {
    capped_day: Option<String>,
}

pub struct Worker {
    pub s3: Arc<S3>,
    pub ledger: Arc<Ledger>,
    pub db: Arc<Db>,
    pub data_folder: PathBuf,
    pub rate: Arc<Rate>,
    pub hours: Option<Hours>,
    pub daily_upload: u64,
    pub health: Arc<Health>,
    /// The time, in the server's time zone.
    pub clock: Arc<dyn Fn() -> DateTime<FixedOffset> + Send + Sync>,
    /// The library's objects at the last reconciliation, by key.
    pub known: Mutex<HashMap<String, Wanted>>,
    pub said: Mutex<Said>,
}

/// What a reconciliation found, for the log.
#[derive(Debug, Default, PartialEq)]
pub struct Counts {
    pub added: usize,
    pub kept: usize,
    pub gone: usize,
}

/// Why an upload round ended.
#[derive(Debug, PartialEq)]
pub enum Round {
    /// Nothing (more) to upload now.
    Done,
    /// The bucket does not answer, or refuses.
    Unhealthy,
    /// Outside the upload hours.
    Hours,
    /// The day's bytes are used up.
    Capped,
    /// The time given to it ran out.
    Time,
}

impl Worker {
    pub async fn run(self: Arc<Self>) {
        // the first health check decides whether the first round uploads
        check_health(&self.s3, &self.health).await;
        loop {
            let next = tokio::time::Instant::now() + RECONCILE_EVERY;
            match self.reconcile().await {
                Ok(counts) if counts != Counts::default() => {
                    info!(added = counts.added, back = counts.kept, gone = counts.gone, "R2 mirror: the library changed")
                }
                Ok(_) => {}
                Err(e) => warn!("R2 mirror: cannot reconcile: {e}"),
            }
            if self.health.ok() {
                let today = (self.clock)().date_naive().to_string();
                if self.ledger.note(CHECKED_NOTE).ok().flatten().as_deref() != Some(today.as_str()) {
                    match self.check_bucket().await {
                        Ok(()) => {
                            let _ = self.ledger.set_note(CHECKED_NOTE, &today);
                        }
                        Err(e) => warn!("R2 mirror: cannot check the bucket: {e}"),
                    }
                }
                self.delete_due().await;
            }
            while tokio::time::Instant::now() < next {
                let round = self.upload(next).await;
                if round == Round::Time {
                    break;
                }
                let wait = next.saturating_duration_since(tokio::time::Instant::now()).min(HEALTH_EVERY);
                tokio::time::sleep(wait).await;
            }
        }
    }

    /// Compares the library with the ledger and records what changed.
    pub async fn reconcile(&self) -> Result<Counts, String> {
        let (db, folder) = (self.db.clone(), self.data_folder.clone());
        let wanted = tokio::task::spawn_blocking(move || wanted(&db, &folder)).await.map_err(|_| "the library's read did not finish".to_string())??;
        let now = (self.clock)().timestamp();
        let mut changes = Vec::new();
        let mut counts = Counts::default();
        for kind in [Kind::Song, Kind::Cover] {
            let rows: HashMap<String, Row> = self.ledger.rows(kind)?.into_iter().map(|row| (row.key.clone(), row)).collect();
            for (key, want) in wanted.iter().filter(|(_, w)| w.kind == kind) {
                match rows.get(key) {
                    None => {
                        changes.push(Change::Add { key: key.clone(), kind, item: want.item.clone(), version: want.version.clone(), size: want.stamp.size });
                        counts.added += 1;
                    }
                    Some(row) if row.state == State::Deleting => {
                        changes.push(Change::Keep { key: key.clone() });
                        counts.kept += 1;
                    }
                    Some(_) => {}
                }
            }
            for (key, row) in &rows {
                if wanted.contains_key(key) {
                    continue;
                }
                match row.state {
                    // nothing in the bucket: a part upload left over is the lifecycle rule's to clear
                    State::Pending if row.uploaded_at.is_none() => changes.push(Change::Forget { key: key.clone() }),
                    State::Pending | State::Uploaded => {
                        changes.push(Change::Gone { key: key.clone(), since: now });
                        counts.gone += 1;
                    }
                    State::Deleting => {}
                }
            }
        }
        self.ledger.apply(&changes)?;
        *self.known.lock().expect("the known objects' lock") = wanted;
        Ok(counts)
    }

    /// Deletes from the bucket what the library has not had for the grace time. An old version waits while its
    /// song's new one is not up yet.
    pub async fn delete_due(&self) {
        let now = (self.clock)().timestamp();
        for kind in [Kind::Song, Kind::Cover] {
            let Ok(rows) = self.ledger.rows(kind) else { return };
            let waiting: std::collections::HashSet<&str> = rows.iter().filter(|r| r.state == State::Pending).map(|r| r.item.as_str()).collect();
            for row in rows.iter().filter(|r| r.state == State::Deleting) {
                if row.gone_since.is_none_or(|since| now - since < GRACE) || waiting.contains(row.item.as_str()) {
                    continue;
                }
                match self.s3.delete(&row.key).await {
                    Ok(()) => {
                        if let Err(e) = self.ledger.apply(&[Change::Forget { key: row.key.clone() }]) {
                            warn!("R2 mirror: {e}");
                        }
                    }
                    Err(e) if e.is_refusal() => {
                        self.health.down(&e);
                        return;
                    }
                    Err(e) => {
                        debug!("R2 mirror: a deletion failed, tried again later: {e}");
                        return;
                    }
                }
            }
        }
    }

    /// Uploads what is pending, one file at a time, until `until`, the hours' end, the day's cap, or a failure of
    /// the bucket.
    pub async fn upload(&self, until: tokio::time::Instant) -> Round {
        loop {
            if !self.health.ok() {
                return Round::Unhealthy;
            }
            let now = (self.clock)();
            if self.hours.is_some_and(|hours| !hours.contains(now.time())) {
                return Round::Hours;
            }
            if tokio::time::Instant::now() >= until {
                return Round::Time;
            }
            let Some((row, want)) = self.next_pending(now.timestamp()) else { return Round::Done };
            let day = now.date_naive().to_string();
            let used = self.ledger.day_bytes(&day).unwrap_or(0);
            // a file larger than the whole cap still goes, alone, on a day of its own
            if self.daily_upload > 0 && used > 0 && used + want.stamp.size > self.daily_upload {
                let mut said = self.said.lock().expect("the said lock");
                if said.capped_day.as_deref() != Some(day.as_str()) {
                    warn!(used, cap = self.daily_upload, "R2 mirror: the day's upload cap is reached: uploads wait for tomorrow");
                    said.capped_day = Some(day);
                }
                return Round::Capped;
            }
            let headers = [("content-type".to_string(), want.content_type.clone()), ("cache-control".to_string(), CACHE_CONTROL.to_string())];
            let result = self.s3.put_file(&row.key, &want.path, want.stamp, &headers, &self.rate).await;
            let after = (self.clock)().timestamp();
            match result {
                Ok(()) => {
                    if let Err(e) = self.ledger.mark_uploaded(&row.key, after).and_then(|()| self.ledger.add_day_bytes(&day, want.stamp.size)) {
                        warn!("R2 mirror: {e}");
                        return Round::Done;
                    }
                }
                Err(e) if e.is_refusal() => {
                    self.health.down(&e);
                    return Round::Unhealthy;
                }
                Err(s3::Error::Changed) => {
                    // the next reconciliation finds its new version
                    let _ = self.ledger.mark_failed(&row.key, row.failures, after + RECONCILE_EVERY.as_secs() as i64);
                }
                Err(e) => {
                    let failures = row.failures + 1;
                    let wait = 60i64 << failures.min(8);
                    let _ = self.ledger.mark_failed(&row.key, failures, after + wait);
                    if failures >= MAX_FAILURES {
                        warn!(key = %row.key, "R2 mirror: an upload failed {failures} times ({e}): left for the daily check");
                    } else {
                        debug!(key = %row.key, "R2 mirror: an upload failed ({e}): tried again in {wait} s");
                    }
                    if matches!(e, s3::Error::Transport(_)) {
                        // likely the connection, not the file: let the health check say
                        return Round::Done;
                    }
                }
            }
        }
    }

    /// The next object to upload: covers first (small, and seen while browsing), then songs, by key.
    fn next_pending(&self, now: i64) -> Option<(Row, Wanted)> {
        let known = self.known.lock().expect("the known objects' lock");
        for kind in [Kind::Cover, Kind::Song] {
            let mut rows = self.ledger.rows(kind).ok()?;
            rows.retain(|r| r.state == State::Pending && r.failures < MAX_FAILURES && r.next_try <= now);
            rows.sort_by(|a, b| a.key.cmp(&b.key));
            for row in rows {
                if let Some(want) = known.get(&row.key) {
                    return Some((row, want.clone()));
                }
            }
        }
        None
    }

    /// The whole bucket against the ledger: what it lacks is uploaded again, what it has that the ledger does not
    /// know is deleted after the grace time, and files that failed too often are tried again.
    pub async fn check_bucket(&self) -> Result<(), String> {
        let now = (self.clock)().timestamp();
        let listed: HashMap<String, u64> = self.s3.list_all("").await.map_err(|e| e.to_string())?.into_iter().map(|o| (o.key, o.size)).collect();
        let mut changes = Vec::new();
        let mut known_keys = std::collections::HashSet::new();
        for kind in [Kind::Song, Kind::Cover] {
            for row in self.ledger.rows(kind)? {
                known_keys.insert(row.key.clone());
                match row.state {
                    State::Uploaded if listed.get(&row.key) != Some(&row.size) => changes.push(Change::Missing { key: row.key }),
                    State::Pending if row.failures > 0 => changes.push(Change::Missing { key: row.key }),
                    _ => {}
                }
            }
        }
        let mut strays = 0;
        for (key, size) in &listed {
            let kind = if key.starts_with("m/") {
                Kind::Song
            } else if key.starts_with("a/") {
                Kind::Cover
            } else {
                // the health object, and what later parts keep (manifests, resized covers)
                continue;
            };
            if !known_keys.contains(key) {
                changes.push(Change::Stray { key: key.clone(), kind, size: *size, since: now });
                strays += 1;
            }
        }
        let missing = changes.iter().filter(|c| matches!(c, Change::Missing { .. })).count();
        self.ledger.apply(&changes)?;
        info!(objects = listed.len(), missing, unknown = strays, "R2 mirror: the bucket checked against the ledger");
        Ok(())
    }
}

/// The health check, once a minute.
pub async fn health_loop(s3: Arc<S3>, health: Arc<Health>) {
    loop {
        tokio::time::sleep(HEALTH_EVERY).await;
        check_health(&s3, &health).await;
    }
}

/// Reads the health object (one class B request), writing it when it is not there.
pub async fn check_health(s3: &S3, health: &Health) {
    match s3.head(HEALTH_KEY).await {
        Ok(Some(_)) => health.up(),
        Ok(None) => match s3.put_bytes(HEALTH_KEY, HEALTH_BODY.into(), "text/plain").await {
            Ok(()) => health.up(),
            Err(e) => health.down(&e),
        },
        Err(e) => health.down(&e),
    }
}

/// The library's files and covers, as they are on disk now. Blocking.
pub fn wanted(db: &Db, data_folder: &Path) -> Result<HashMap<String, Wanted>, String> {
    let songs: Vec<(String, String, String, String)> = db
        .read_blocking(|conn| {
            let mut statement =
                conn.prepare("SELECT m.id, m.path, m.suffix, l.path FROM media_file m JOIN library l ON l.id = m.library_id WHERE m.missing = 0")?;
            let rows = statement.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?;
            rows.collect()
        })
        .map_err(|e| format!("cannot read the library: {e}"))?;
    let covers: Vec<(String, String)> = db
        .read_blocking(|conn| {
            let mut statement = conn.prepare("SELECT a.hash, a.mime FROM artwork a WHERE EXISTS (SELECT 1 FROM item_artwork i WHERE i.hash = a.hash)")?;
            let rows = statement.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
            rows.collect()
        })
        .map_err(|e| format!("cannot read the covers: {e}"))?;
    let mut wanted = HashMap::new();
    for (id, path, suffix, library) in songs {
        // ids name objects: Navidrome's are letters and digits; anything else stays home
        if id.is_empty() || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') || !inside_library(&path) {
            continue;
        }
        let file = Path::new(&library).join(&path);
        let Ok(stamp) = Stamp::of(&file) else { continue };
        let version = stamp.version();
        let content_type = crate::library::entities::content_type(&suffix.to_ascii_lowercase()).unwrap_or("application/octet-stream").to_string();
        wanted.insert(format!("m/{id}/{version}"), Wanted { kind: Kind::Song, item: id, stamp, version, path: file, content_type });
    }
    for (hash, mime) in covers {
        if hash.len() < 4 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
            continue;
        }
        let file = artwork_file(data_folder, &hash, &mime);
        let Ok(stamp) = Stamp::of(&file) else { continue };
        let content_type = if mime.starts_with("image/") && mime.bytes().all(|b| b.is_ascii_graphic()) { mime } else { "application/octet-stream".into() };
        // the hash names the picture's content: its version
        wanted.insert(format!("a/{hash}"), Wanted { kind: Kind::Cover, item: hash.clone(), stamp, version: hash, path: file, content_type });
    }
    Ok(wanted)
}
