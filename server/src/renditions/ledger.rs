//! The playback library's own SQLite ledger (`sonus-renditions.db` in Navidrome's data folder). Never touches
//! Navidrome's database (`db.rs`). Deleting this database and the renditions folder simply triggers regeneration while
//! the server continues streaming originals in the meantime (`docs/streaming-renditions.md`, section 4).

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{Connection, OptionalExtension, params};

use super::Tier;

pub const FILE_NAME: &str = "sonus-renditions.db";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State {
    Pending,
    Ready,
    Failed,
    Deleting,
}

impl State {
    pub fn as_str(self) -> &'static str {
        match self {
            State::Pending => "pending",
            State::Ready => "ready",
            State::Failed => "failed",
            State::Deleting => "deleting",
        }
    }

    pub fn parse(text: &str) -> Option<State> {
        match text {
            "pending" => Some(State::Pending),
            "ready" => Some(State::Ready),
            "failed" => Some(State::Failed),
            "deleting" => Some(State::Deleting),
            _ => None,
        }
    }
}

/// One row of `sonus_rendition`: a song at a source version and quality tier.
#[derive(Clone, Debug, PartialEq)]
pub struct Row {
    pub song_id: String,
    pub version: String,
    pub tier: Tier,
    pub album_id: String,
    pub format: String,
    pub sample_rate: u32,
    pub bit_depth: u8,
    pub channels: u8,
    pub total_samples: u64,
    pub file_size: u64,
    pub lufs: Option<f64>,
    pub peak: Option<f64>,
    pub state: State,
    pub health: String,
    pub generated_at: Option<i64>,
    pub gone_since: Option<i64>,
    pub failures: u32,
    pub next_try: i64,
}

/// Per-track EBU R128 loudness row (`sonus_track_loudness`).
#[derive(Clone, Debug, PartialEq)]
pub struct TrackLoudness {
    pub song_id: String,
    pub version: String,
    pub album_id: String,
    pub duration: f64,
    pub lufs: Option<f64>,
    pub peak: Option<f64>,
    pub state: State,
    pub health: String,
    pub measured_at: Option<i64>,
    pub gone_since: Option<i64>,
    pub failures: u32,
    pub next_try: i64,
}

/// Aggregated EBU R128 loudness for an album (`sonus_album_loudness`).
#[derive(Clone, Debug, PartialEq)]
pub struct AlbumLoudness {
    pub album_id: String,
    pub lufs: f64,
    pub peak: f64,
    pub track_count: u32,
    pub updated_at: i64,
}

/// Reconciliation change for `sonus_rendition`.
#[derive(Clone, Debug)]
pub enum Change {
    Add { song_id: String, version: String, tier: Tier, album_id: String },
    KeepReady { song_id: String, version: String, tier: Tier },
    KeepPending { song_id: String, version: String, tier: Tier },
    Gone { song_id: String, version: String, tier: Tier, since: i64 },
    Forget { song_id: String, version: String, tier: Tier },
}

/// Reconciliation change for `sonus_track_loudness`.
#[derive(Clone, Debug)]
pub enum LoudnessChange {
    Add { song_id: String, version: String, album_id: String, duration: f64 },
    Keep { song_id: String, version: String, state: State },
    Gone { song_id: String, version: String, since: i64 },
    Forget { song_id: String, version: String },
}

/// Summary counts and failed entries for `getSonusLibraryHealth`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct HealthReport {
    pub ready: u64,
    pub pending: u64,
    pub failed: u64,
    pub deleting: u64,
    pub total_issues: u64,
    pub issues: Vec<HealthIssue>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct HealthIssue {
    pub song_id: String,
    pub tier: String,
    pub state: String,
    pub health: String,
    pub failures: u32,
}

pub struct Ledger {
    conn: Mutex<Connection>,
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS sonus_rendition (
    song_id TEXT NOT NULL,
    version TEXT NOT NULL,
    tier TEXT NOT NULL,
    album_id TEXT NOT NULL DEFAULT '',
    format TEXT NOT NULL,
    sample_rate INTEGER NOT NULL DEFAULT 0,
    bit_depth INTEGER NOT NULL DEFAULT 0,
    channels INTEGER NOT NULL DEFAULT 0,
    total_samples INTEGER NOT NULL DEFAULT 0,
    file_size INTEGER NOT NULL DEFAULT 0,
    lufs REAL,
    peak REAL,
    state TEXT NOT NULL,
    health TEXT NOT NULL DEFAULT '',
    generated_at INTEGER,
    gone_since INTEGER,
    failures INTEGER NOT NULL DEFAULT 0,
    next_try INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (song_id, version, tier)
);
CREATE INDEX IF NOT EXISTS sonus_rendition_state ON sonus_rendition(state, next_try);
CREATE INDEX IF NOT EXISTS sonus_rendition_song ON sonus_rendition(song_id);

CREATE TABLE IF NOT EXISTS sonus_track_loudness (
    song_id TEXT NOT NULL,
    version TEXT NOT NULL,
    album_id TEXT NOT NULL DEFAULT '',
    duration REAL NOT NULL DEFAULT 0,
    lufs REAL,
    peak REAL,
    state TEXT NOT NULL,
    health TEXT NOT NULL DEFAULT '',
    measured_at INTEGER,
    gone_since INTEGER,
    failures INTEGER NOT NULL DEFAULT 0,
    next_try INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (song_id, version)
);
CREATE INDEX IF NOT EXISTS sonus_track_loudness_album ON sonus_track_loudness(album_id);

CREATE TABLE IF NOT EXISTS sonus_album_loudness (
    album_id TEXT PRIMARY KEY,
    lufs REAL NOT NULL,
    peak REAL NOT NULL,
    track_count INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sonus_rendition_note (
    name TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
";

impl Ledger {
    pub fn open(folder: &Path) -> Result<Ledger, String> {
        let path = folder.join(FILE_NAME);
        let conn = Connection::open(&path).map_err(|e| format!("cannot open the renditions ledger {}: {e}", path.display()))?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;").map_err(|e| e.to_string())?;
        conn.busy_timeout(std::time::Duration::from_secs(15)).map_err(|e| e.to_string())?;
        conn.execute_batch(SCHEMA).map_err(|e| format!("cannot set up the renditions ledger: {e}"))?;
        Ok(Ledger { conn: Mutex::new(conn) })
    }

    pub fn in_memory() -> Ledger {
        let conn = Connection::open_in_memory().expect("an in-memory database");
        conn.execute_batch(SCHEMA).expect("the renditions ledger schema");
        Ledger { conn: Mutex::new(conn) }
    }

    fn with<T>(&self, f: impl FnOnce(&mut Connection) -> rusqlite::Result<T>) -> Result<T, String> {
        let mut conn = self.conn.lock().map_err(|_| "the renditions ledger lock is poisoned".to_string())?;
        f(&mut conn).map_err(|e| format!("the renditions ledger: {e}"))
    }

    pub fn all_renditions(&self) -> Result<Vec<Row>, String> {
        self.with(|conn| {
            let mut stmt = conn.prepare(
                "SELECT song_id, version, tier, album_id, format, sample_rate, bit_depth, channels, total_samples,
                        file_size, lufs, peak, state, health, generated_at, gone_since, failures, next_try
                 FROM sonus_rendition",
            )?;
            let rows = stmt.query_map([], read_row)?.collect::<rusqlite::Result<Vec<Option<Row>>>>()?;
            Ok(rows.into_iter().flatten().collect())
        })
    }

    pub fn get(&self, song_id: &str, version: &str, tier: Tier) -> Result<Option<Row>, String> {
        self.with(|conn| {
            conn.query_row(
                "SELECT song_id, version, tier, album_id, format, sample_rate, bit_depth, channels, total_samples,
                        file_size, lufs, peak, state, health, generated_at, gone_since, failures, next_try
                 FROM sonus_rendition WHERE song_id = ?1 AND version = ?2 AND tier = ?3",
                params![song_id, version, tier.as_str()],
                read_row,
            )
            .optional()
            .map(Option::flatten)
        })
    }

    pub fn ready_for_song(&self, song_id: &str, version: &str) -> Result<Vec<Row>, String> {
        self.with(|conn| {
            let mut stmt = conn.prepare(
                "SELECT song_id, version, tier, album_id, format, sample_rate, bit_depth, channels, total_samples,
                        file_size, lufs, peak, state, health, generated_at, gone_since, failures, next_try
                 FROM sonus_rendition WHERE song_id = ?1 AND version = ?2 AND state = 'ready'",
            )?;
            let rows = stmt.query_map(params![song_id, version], read_row)?.collect::<rusqlite::Result<Vec<Option<Row>>>>()?;
            Ok(rows.into_iter().flatten().collect())
        })
    }

    pub fn pending_renditions(&self, now: i64, limit: usize) -> Result<Vec<Row>, String> {
        self.with(|conn| {
            // Lossless first (so DSD Opus tiers can read from the cleaned lossless FLAC), then by song_id
            let mut stmt = conn.prepare(
                "SELECT song_id, version, tier, album_id, format, sample_rate, bit_depth, channels, total_samples,
                        file_size, lufs, peak, state, health, generated_at, gone_since, failures, next_try
                 FROM sonus_rendition
                 WHERE state = 'pending' AND next_try <= ?1
                 ORDER BY CASE tier WHEN 'lossless' THEN 0 WHEN 'veryHigh' THEN 1 WHEN 'high' THEN 2 ELSE 3 END, song_id
                 LIMIT ?2",
            )?;
            let rows = stmt.query_map(params![now, limit as i64], read_row)?.collect::<rusqlite::Result<Vec<Option<Row>>>>()?;
            Ok(rows.into_iter().flatten().collect())
        })
    }

    pub fn apply(&self, changes: &[Change]) -> Result<(), String> {
        if changes.is_empty() {
            return Ok(());
        }
        self.with(|conn| {
            let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            for change in changes {
                match change {
                    Change::Add { song_id, version, tier, album_id } => {
                        tx.execute(
                            "INSERT INTO sonus_rendition (song_id, version, tier, album_id, format, state)
                             VALUES (?1, ?2, ?3, ?4, ?5, 'pending')
                             ON CONFLICT(song_id, version, tier) DO UPDATE
                               SET album_id = excluded.album_id, state = 'pending', gone_since = NULL, failures = 0, next_try = 0",
                            params![song_id, version, tier.as_str(), album_id, tier.format()],
                        )?;
                    }
                    Change::KeepReady { song_id, version, tier } => {
                        tx.execute(
                            "UPDATE sonus_rendition SET state = 'ready', gone_since = NULL
                             WHERE song_id = ?1 AND version = ?2 AND tier = ?3",
                            params![song_id, version, tier.as_str()],
                        )?;
                    }
                    Change::KeepPending { song_id, version, tier } => {
                        tx.execute(
                            "UPDATE sonus_rendition SET state = 'pending', gone_since = NULL, failures = 0, next_try = 0
                             WHERE song_id = ?1 AND version = ?2 AND tier = ?3",
                            params![song_id, version, tier.as_str()],
                        )?;
                    }
                    Change::Gone { song_id, version, tier, since } => {
                        tx.execute(
                            "UPDATE sonus_rendition SET state = 'deleting', gone_since = coalesce(gone_since, ?4)
                             WHERE song_id = ?1 AND version = ?2 AND tier = ?3",
                            params![song_id, version, tier.as_str(), since],
                        )?;
                    }
                    Change::Forget { song_id, version, tier } => {
                        tx.execute("DELETE FROM sonus_rendition WHERE song_id = ?1 AND version = ?2 AND tier = ?3", params![song_id, version, tier.as_str()])?;
                    }
                }
            }
            tx.commit()
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn mark_ready(
        &self,
        song_id: &str,
        version: &str,
        tier: Tier,
        sample_rate: u32,
        bit_depth: u8,
        channels: u8,
        total_samples: u64,
        file_size: u64,
        now: i64,
    ) -> Result<(), String> {
        self.with(|conn| {
            // Pull track loudness if already measured for this (song_id, version)
            let loudness: Option<(Option<f64>, Option<f64>)> = conn
                .query_row(
                    "SELECT lufs, peak FROM sonus_track_loudness WHERE song_id = ?1 AND version = ?2 AND state = 'ready'",
                    params![song_id, version],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            let (lufs, peak) = loudness.unwrap_or((None, None));
            conn.execute(
                "UPDATE sonus_rendition
                 SET sample_rate = ?4, bit_depth = ?5, channels = ?6, total_samples = ?7, file_size = ?8,
                     lufs = coalesce(?9, lufs), peak = coalesce(?10, peak),
                     state = 'ready', health = 'ok', generated_at = ?11, gone_since = NULL, failures = 0, next_try = 0
                 WHERE song_id = ?1 AND version = ?2 AND tier = ?3 AND state != 'deleting'",
                params![
                    song_id,
                    version,
                    tier.as_str(),
                    sample_rate as i64,
                    bit_depth as i64,
                    channels as i64,
                    total_samples as i64,
                    file_size as i64,
                    lufs,
                    peak,
                    now,
                ],
            )?;
            Ok(())
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn mark_attempt_failed(
        &self,
        song_id: &str,
        version: &str,
        tier: Tier,
        failures: u32,
        next_try: i64,
        permanent: bool,
        health: &str,
    ) -> Result<(), String> {
        let state = if permanent { "failed" } else { "pending" };
        self.with(|conn| {
            conn.execute(
                "UPDATE sonus_rendition
                 SET state = ?4, health = ?5, failures = ?6, next_try = ?7
                 WHERE song_id = ?1 AND version = ?2 AND tier = ?3 AND state != 'deleting'",
                params![song_id, version, tier.as_str(), state, health, failures as i64, next_try],
            )?;
            Ok(())
        })
    }

    // ---------------------------------------------------------------- track & album loudness

    pub fn all_loudness(&self) -> Result<Vec<TrackLoudness>, String> {
        self.with(|conn| {
            let mut stmt = conn.prepare(
                "SELECT song_id, version, album_id, duration, lufs, peak, state, health, measured_at, gone_since, failures, next_try
                 FROM sonus_track_loudness",
            )?;
            let rows = stmt.query_map([], read_loudness)?.collect::<rusqlite::Result<Vec<Option<TrackLoudness>>>>()?;
            Ok(rows.into_iter().flatten().collect())
        })
    }

    pub fn pending_loudness(&self, now: i64, limit: usize) -> Result<Vec<TrackLoudness>, String> {
        self.with(|conn| {
            let mut stmt = conn.prepare(
                "SELECT song_id, version, album_id, duration, lufs, peak, state, health, measured_at, gone_since, failures, next_try
                 FROM sonus_track_loudness
                 WHERE state = 'pending' AND next_try <= ?1
                 ORDER BY song_id
                 LIMIT ?2",
            )?;
            let rows = stmt.query_map(params![now, limit as i64], read_loudness)?.collect::<rusqlite::Result<Vec<Option<TrackLoudness>>>>()?;
            Ok(rows.into_iter().flatten().collect())
        })
    }

    pub fn apply_loudness(&self, changes: &[LoudnessChange]) -> Result<(), String> {
        if changes.is_empty() {
            return Ok(());
        }
        self.with(|conn| {
            let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            for change in changes {
                match change {
                    LoudnessChange::Add { song_id, version, album_id, duration } => {
                        tx.execute(
                            "INSERT INTO sonus_track_loudness (song_id, version, album_id, duration, state)
                             VALUES (?1, ?2, ?3, ?4, 'pending')
                             ON CONFLICT(song_id, version) DO UPDATE
                               SET album_id = excluded.album_id, duration = excluded.duration, state = 'pending', gone_since = NULL, failures = 0, next_try = 0",
                            params![song_id, version, album_id, duration],
                        )?;
                    }
                    LoudnessChange::Keep { song_id, version, state } => {
                        tx.execute(
                            "UPDATE sonus_track_loudness SET state = ?3, gone_since = NULL
                             WHERE song_id = ?1 AND version = ?2",
                            params![song_id, version, state.as_str()],
                        )?;
                    }
                    LoudnessChange::Gone { song_id, version, since } => {
                        tx.execute(
                            "UPDATE sonus_track_loudness SET state = 'deleting', gone_since = coalesce(gone_since, ?3)
                             WHERE song_id = ?1 AND version = ?2",
                            params![song_id, version, since],
                        )?;
                    }
                    LoudnessChange::Forget { song_id, version } => {
                        tx.execute(
                            "DELETE FROM sonus_track_loudness WHERE song_id = ?1 AND version = ?2",
                            params![song_id, version],
                        )?;
                    }
                }
            }
            tx.commit()
        })
    }

    /// Saves a track's EBU R128 loudness, mirrors it onto its rendition rows, and recomputes its album's loudness.
    pub fn record_track_loudness(&self, song_id: &str, version: &str, album_id: &str, lufs: f64, peak: f64, now: i64) -> Result<(), String> {
        self.with(|conn| {
            let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            tx.execute(
                "UPDATE sonus_track_loudness
                 SET lufs = ?3, peak = ?4, state = 'ready', health = 'ok', measured_at = ?5, gone_since = NULL, failures = 0, next_try = 0
                 WHERE song_id = ?1 AND version = ?2 AND state != 'deleting'",
                params![song_id, version, lufs, peak, now],
            )?;
            tx.execute("UPDATE sonus_rendition SET lufs = ?3, peak = ?4 WHERE song_id = ?1 AND version = ?2", params![song_id, version, lufs, peak])?;
            if !album_id.is_empty() {
                recompute_album_loudness(&tx, album_id, now)?;
            }
            tx.commit()
        })
    }

    pub fn mark_loudness_failed(&self, song_id: &str, version: &str, failures: u32, next_try: i64, permanent: bool, health: &str) -> Result<(), String> {
        let state = if permanent { "failed" } else { "pending" };
        self.with(|conn| {
            conn.execute(
                "UPDATE sonus_track_loudness SET state = ?3, health = ?4, failures = ?5, next_try = ?6
                 WHERE song_id = ?1 AND version = ?2 AND state != 'deleting'",
                params![song_id, version, state, health, failures as i64, next_try],
            )?;
            Ok(())
        })
    }

    pub fn get_track_loudness(&self, song_id: &str, version: &str) -> Result<Option<TrackLoudness>, String> {
        self.with(|conn| {
            conn.query_row(
                "SELECT song_id, version, album_id, duration, lufs, peak, state, health, measured_at, gone_since, failures, next_try
                 FROM sonus_track_loudness WHERE song_id = ?1 AND version = ?2 AND state = 'ready'",
                params![song_id, version],
                read_loudness,
            )
            .optional()
            .map(Option::flatten)
        })
    }

    pub fn get_album_loudness(&self, album_id: &str) -> Result<Option<AlbumLoudness>, String> {
        if album_id.is_empty() {
            return Ok(None);
        }
        self.with(|conn| {
            conn.query_row("SELECT album_id, lufs, peak, track_count, updated_at FROM sonus_album_loudness WHERE album_id = ?1", [album_id], |r| {
                Ok(AlbumLoudness {
                    album_id: r.get(0)?,
                    lufs: r.get(1)?,
                    peak: r.get(2)?,
                    track_count: r.get::<_, i64>(3)?.max(0) as u32,
                    updated_at: r.get(4)?,
                })
            })
            .optional()
        })
    }

    /// Summary counts and paginated failed health-check entries across renditions and loudness probes.
    pub fn health_report(&self, limit: usize, offset: usize) -> Result<HealthReport, String> {
        self.with(|conn| {
            let mut report = HealthReport::default();
            let mut counts = conn.prepare("SELECT state, count(*) FROM sonus_rendition GROUP BY state")?;
            let rows = counts.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
            for pair in rows {
                let (state, count) = pair?;
                match State::parse(&state) {
                    Some(State::Ready) => report.ready = count as u64,
                    Some(State::Pending) => report.pending = count as u64,
                    Some(State::Failed) => report.failed = count as u64,
                    Some(State::Deleting) => report.deleting = count as u64,
                    None => {}
                }
            }
            report.total_issues = conn.query_row(
                "SELECT (SELECT count(*) FROM sonus_rendition WHERE state = 'failed')
                      + (SELECT count(*) FROM sonus_track_loudness WHERE state = 'failed')",
                [],
                |r| r.get::<_, i64>(0),
            )? as u64;

            let mut stmt = conn.prepare(
                "SELECT song_id, tier, state, health, failures FROM (
                     SELECT song_id, tier, state, health, failures FROM sonus_rendition WHERE state = 'failed'
                     UNION ALL
                     SELECT song_id, 'loudness' AS tier, state, health, failures FROM sonus_track_loudness WHERE state = 'failed'
                 )
                 ORDER BY song_id, tier
                 LIMIT ?1 OFFSET ?2",
            )?;
            let issues = stmt
                .query_map(params![limit as i64, offset as i64], |r| {
                    Ok(HealthIssue { song_id: r.get(0)?, tier: r.get(1)?, state: r.get(2)?, health: r.get(3)?, failures: r.get::<_, i64>(4)?.max(0) as u32 })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            report.issues = issues;
            Ok(report)
        })
    }

    // ---------------------------------------------------------------- notes

    pub fn note(&self, name: &str) -> Result<Option<String>, String> {
        self.with(|conn| conn.query_row("SELECT value FROM sonus_rendition_note WHERE name = ?1", [name], |r| r.get(0)).optional())
    }

    pub fn set_note(&self, name: &str, value: &str) -> Result<(), String> {
        self.with(|conn| {
            conn.execute(
                "INSERT INTO sonus_rendition_note (name, value) VALUES (?1, ?2) ON CONFLICT(name) DO UPDATE SET value = excluded.value",
                params![name, value],
            )?;
            Ok(())
        })
    }
}

/// Duration-weighted mean loudness energy across all ready tracks in `album_id`, plus maximum linear peak.
fn recompute_album_loudness(tx: &rusqlite::Transaction<'_>, album_id: &str, now: i64) -> rusqlite::Result<()> {
    let mut stmt = tx.prepare(
        "SELECT duration, lufs, peak FROM sonus_track_loudness
         WHERE album_id = ?1 AND state = 'ready' AND lufs IS NOT NULL AND peak IS NOT NULL",
    )?;
    let tracks: Vec<(f64, f64, f64)> =
        stmt.query_map([album_id], |r| Ok((r.get::<_, f64>(0)?, r.get::<_, f64>(1)?, r.get::<_, f64>(2)?)))?.collect::<rusqlite::Result<_>>()?;
    drop(stmt);
    if tracks.is_empty() {
        tx.execute("DELETE FROM sonus_album_loudness WHERE album_id = ?1", [album_id])?;
        return Ok(());
    }
    let mut energy_sum = 0.0f64;
    let mut weight_sum = 0.0f64;
    let mut max_peak = 0.0f64;
    for &(duration, lufs, peak) in &tracks {
        let weight = if duration.is_finite() && duration > 0.0 { duration } else { 1.0 };
        energy_sum += 10f64.powf(lufs / 10.0) * weight;
        weight_sum += weight;
        if peak.is_finite() && peak > max_peak {
            max_peak = peak;
        }
    }
    let album_lufs = if tracks.len() == 1 {
        tracks[0].1
    } else if energy_sum > 0.0 && weight_sum > 0.0 {
        10.0 * (energy_sum / weight_sum).log10()
    } else {
        -70.0
    };
    tx.execute(
        "INSERT INTO sonus_album_loudness (album_id, lufs, peak, track_count, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(album_id) DO UPDATE
           SET lufs = excluded.lufs, peak = excluded.peak, track_count = excluded.track_count, updated_at = excluded.updated_at",
        params![album_id, album_lufs, max_peak, tracks.len() as i64, now],
    )?;
    Ok(())
}

fn read_row(r: &rusqlite::Row) -> rusqlite::Result<Option<Row>> {
    let tier_str: String = r.get(2)?;
    let state_str: String = r.get(12)?;
    let (Some(tier), Some(state)) = (Tier::parse(&tier_str), State::parse(&state_str)) else {
        return Ok(None);
    };
    Ok(Some(Row {
        song_id: r.get(0)?,
        version: r.get(1)?,
        tier,
        album_id: r.get(3)?,
        format: r.get(4)?,
        sample_rate: r.get::<_, i64>(5)?.max(0) as u32,
        bit_depth: r.get::<_, i64>(6)?.clamp(0, 255) as u8,
        channels: r.get::<_, i64>(7)?.clamp(0, 255) as u8,
        total_samples: r.get::<_, i64>(8)?.max(0) as u64,
        file_size: r.get::<_, i64>(9)?.max(0) as u64,
        lufs: r.get(10)?,
        peak: r.get(11)?,
        state,
        health: r.get(13)?,
        generated_at: r.get(14)?,
        gone_since: r.get(15)?,
        failures: r.get::<_, i64>(16)?.max(0) as u32,
        next_try: r.get(17)?,
    }))
}

fn read_loudness(r: &rusqlite::Row) -> rusqlite::Result<Option<TrackLoudness>> {
    let state_str: String = r.get(6)?;
    let Some(state) = State::parse(&state_str) else { return Ok(None) };
    Ok(Some(TrackLoudness {
        song_id: r.get(0)?,
        version: r.get(1)?,
        album_id: r.get(2)?,
        duration: r.get(3)?,
        lufs: r.get(4)?,
        peak: r.get(5)?,
        state,
        health: r.get(7)?,
        measured_at: r.get(8)?,
        gone_since: r.get(9)?,
        failures: r.get::<_, i64>(10)?.max(0) as u32,
        next_try: r.get(11)?,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn album_loudness_combines_track_energy_weighted_by_duration() {
        let ledger = Ledger::in_memory();
        ledger
            .apply_loudness(&[
                LoudnessChange::Add { song_id: "s1".into(), version: "v1".into(), album_id: "al1".into(), duration: 100.0 },
                LoudnessChange::Add { song_id: "s2".into(), version: "v1".into(), album_id: "al1".into(), duration: 300.0 },
            ])
            .unwrap();
        ledger.record_track_loudness("s1", "v1", "al1", -10.0, 0.95, 1000).unwrap();
        ledger.record_track_loudness("s2", "v1", "al1", -16.0, 0.80, 1001).unwrap();
        let album = ledger.get_album_loudness("al1").unwrap().unwrap();
        // (100 * 10^-1 + 300 * 10^-1.6) / 400
        let expected_e = (100.0 * 10f64.powf(-1.0) + 300.0 * 10f64.powf(-1.6)) / 400.0;
        let expected_lufs = 10.0 * expected_e.log10();
        assert!((album.lufs - expected_lufs).abs() < 1e-6);
        assert!((album.peak - 0.95).abs() < 1e-6);
        assert_eq!(album.track_count, 2);
    }

    #[test]
    fn health_report_counts_states_and_paginates_failures() {
        let ledger = Ledger::in_memory();
        ledger
            .apply(&[
                Change::Add { song_id: "a".into(), version: "v1".into(), tier: Tier::Lossless, album_id: "al".into() },
                Change::Add { song_id: "b".into(), version: "v1".into(), tier: Tier::High, album_id: "al".into() },
                Change::Add { song_id: "c".into(), version: "v1".into(), tier: Tier::Normal, album_id: "al".into() },
            ])
            .unwrap();
        ledger.mark_ready("a", "v1", Tier::Lossless, 44100, 16, 2, 441000, 1000, 100).unwrap();
        ledger.mark_attempt_failed("b", "v1", Tier::High, 3, 0, true, "decode error").unwrap();

        let report = ledger.health_report(10, 0).unwrap();
        assert_eq!((report.ready, report.pending, report.failed, report.deleting), (1, 1, 1, 0));
        assert_eq!(report.total_issues, 1);
        assert_eq!(report.issues[0].song_id, "b");
        assert_eq!(report.issues[0].health, "decode error");
    }
}
