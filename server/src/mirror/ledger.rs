//! The mirror's ledger: what is (or is to be) in the bucket. It lives in the server's own database file,
//! `sonus-mirror.db` in Navidrome's data folder, never in Navidrome's (whose schema is Navidrome's alone,
//! `db.rs`). Losing it costs an upload of everything again, nothing more: the daily check against the bucket
//! puts back what is missing.
//!
//! A row is an object: `pending` (to upload), `uploaded`, or `deleting` (gone from the library, deleted from the
//! bucket after a grace time). Only an `uploaded` row at the file's current version may send a client to R2.

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{Connection, OptionalExtension, params};

pub const FILE_NAME: &str = "sonus-mirror.db";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Song,
    Cover,
}

impl Kind {
    fn name(self) -> &'static str {
        match self {
            Kind::Song => "song",
            Kind::Cover => "cover",
        }
    }

    fn from_name(name: &str) -> Option<Kind> {
        match name {
            "song" => Some(Kind::Song),
            "cover" => Some(Kind::Cover),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State {
    Pending,
    Uploaded,
    Deleting,
}

impl State {
    fn from_name(name: &str) -> Option<State> {
        match name {
            "pending" => Some(State::Pending),
            "uploaded" => Some(State::Uploaded),
            "deleting" => Some(State::Deleting),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Row {
    pub key: String,
    pub kind: Kind,
    /// The song's id, or the picture's hash.
    pub item: String,
    pub version: String,
    pub size: u64,
    pub state: State,
    /// Seconds since 1970.
    pub uploaded_at: Option<i64>,
    /// When the library stopped having it (`deleting` only).
    pub gone_since: Option<i64>,
    pub failures: u32,
    /// Not tried again before this (seconds since 1970).
    pub next_try: i64,
}

pub struct Ledger {
    conn: Mutex<Connection>,
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS sonus_r2_object (
    key TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    item TEXT NOT NULL,
    version TEXT NOT NULL,
    size INTEGER NOT NULL,
    state TEXT NOT NULL,
    uploaded_at INTEGER,
    gone_since INTEGER,
    failures INTEGER NOT NULL DEFAULT 0,
    next_try INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS sonus_r2_object_item ON sonus_r2_object(kind, item);
CREATE TABLE IF NOT EXISTS sonus_r2_day (day TEXT PRIMARY KEY, bytes INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sonus_r2_note (name TEXT PRIMARY KEY, value TEXT NOT NULL);
";

impl Ledger {
    /// Opens (or makes) the ledger in the folder. Blocking.
    pub fn open(folder: &Path) -> Result<Ledger, String> {
        let path = folder.join(FILE_NAME);
        let conn = Connection::open(&path).map_err(|e| format!("cannot open the mirror's ledger {}: {e}", path.display()))?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;").map_err(|e| e.to_string())?;
        conn.busy_timeout(std::time::Duration::from_secs(15)).map_err(|e| e.to_string())?;
        conn.execute_batch(SCHEMA).map_err(|e| format!("cannot set up the mirror's ledger: {e}"))?;
        Ok(Ledger { conn: Mutex::new(conn) })
    }

    /// An empty ledger in memory, for tests.
    pub fn in_memory() -> Ledger {
        let conn = Connection::open_in_memory().expect("an in-memory database");
        conn.execute_batch(SCHEMA).expect("the ledger's schema");
        Ledger { conn: Mutex::new(conn) }
    }

    fn with<T>(&self, f: impl FnOnce(&mut Connection) -> rusqlite::Result<T>) -> Result<T, String> {
        let mut conn = self.conn.lock().map_err(|_| "the ledger's lock is poisoned".to_string())?;
        f(&mut conn).map_err(|e| format!("the mirror's ledger: {e}"))
    }

    pub fn rows(&self, kind: Kind) -> Result<Vec<Row>, String> {
        self.with(|conn| {
            let mut statement =
                conn.prepare("SELECT key, kind, item, version, size, state, uploaded_at, gone_since, failures, next_try FROM sonus_r2_object WHERE kind = ?1")?;
            let rows = statement.query_map([kind.name()], read_row)?.collect::<rusqlite::Result<Vec<Option<Row>>>>()?;
            Ok(rows.into_iter().flatten().collect())
        })
    }

    pub fn all_keys(&self) -> Result<Vec<(String, State)>, String> {
        self.with(|conn| {
            let mut statement = conn.prepare("SELECT key, state FROM sonus_r2_object")?;
            let rows = statement.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows.into_iter().filter_map(|(key, state)| Some((key, State::from_name(&state)?))).collect())
        })
    }

    pub fn get(&self, key: &str) -> Result<Option<Row>, String> {
        self.with(|conn| {
            conn.query_row(
                "SELECT key, kind, item, version, size, state, uploaded_at, gone_since, failures, next_try FROM sonus_r2_object WHERE key = ?1",
                [key],
                read_row,
            )
            .optional()
            .map(Option::flatten)
        })
    }

    /// Applies a reconciliation's changes in one transaction.
    pub fn apply(&self, changes: &[Change]) -> Result<(), String> {
        if changes.is_empty() {
            return Ok(());
        }
        self.with(|conn| {
            let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            for change in changes {
                match change {
                    Change::Add { key, kind, item, version, size } => {
                        tx.execute(
                            "INSERT INTO sonus_r2_object (key, kind, item, version, size, state) VALUES (?1, ?2, ?3, ?4, ?5, 'pending')
                             ON CONFLICT(key) DO UPDATE SET size = excluded.size, state = 'pending', gone_since = NULL, failures = 0, next_try = 0",
                            params![key, kind.name(), item, version, *size as i64],
                        )?;
                    }
                    Change::Keep { key } => {
                        // back in the library within the grace time: as it was before it went
                        tx.execute(
                            "UPDATE sonus_r2_object SET state = CASE WHEN uploaded_at IS NULL THEN 'pending' ELSE 'uploaded' END, gone_since = NULL
                             WHERE key = ?1",
                            [key],
                        )?;
                    }
                    Change::Gone { key, since } => {
                        tx.execute("UPDATE sonus_r2_object SET state = 'deleting', gone_since = ?2 WHERE key = ?1", params![key, since])?;
                    }
                    Change::Stray { key, kind, size, since } => {
                        tx.execute(
                            "INSERT INTO sonus_r2_object (key, kind, item, version, size, state, gone_since) VALUES (?1, ?2, '', '', ?3, 'deleting', ?4)
                             ON CONFLICT(key) DO NOTHING",
                            params![key, kind.name(), *size as i64, since],
                        )?;
                    }
                    Change::Forget { key } => {
                        tx.execute("DELETE FROM sonus_r2_object WHERE key = ?1", [key])?;
                    }
                    Change::Missing { key } => {
                        tx.execute("UPDATE sonus_r2_object SET state = 'pending', uploaded_at = NULL, failures = 0, next_try = 0 WHERE key = ?1", [key])?;
                    }
                }
            }
            tx.commit()
        })
    }

    pub fn mark_uploaded(&self, key: &str, at: i64) -> Result<(), String> {
        self.with(|conn| {
            conn.execute(
                "UPDATE sonus_r2_object SET state = 'uploaded', uploaded_at = ?2, failures = 0, next_try = 0 WHERE key = ?1 AND state = 'pending'",
                params![key, at],
            )
            .map(|_| ())
        })
    }

    pub fn mark_failed(&self, key: &str, failures: u32, next_try: i64) -> Result<(), String> {
        self.with(|conn| conn.execute("UPDATE sonus_r2_object SET failures = ?2, next_try = ?3 WHERE key = ?1", params![key, failures, next_try]).map(|_| ()))
    }

    /// Bytes uploaded on the day (`2026-11-26`, the server's time zone).
    pub fn day_bytes(&self, day: &str) -> Result<u64, String> {
        self.with(|conn| {
            conn.query_row("SELECT bytes FROM sonus_r2_day WHERE day = ?1", [day], |r| r.get::<_, i64>(0)).optional().map(|b| b.unwrap_or(0).max(0) as u64)
        })
    }

    pub fn add_day_bytes(&self, day: &str, bytes: u64) -> Result<(), String> {
        self.with(|conn| {
            conn.execute(
                "INSERT INTO sonus_r2_day (day, bytes) VALUES (?1, ?2) ON CONFLICT(day) DO UPDATE SET bytes = bytes + excluded.bytes",
                params![day, bytes as i64],
            )?;
            // a month of days is enough to read back
            conn.execute("DELETE FROM sonus_r2_day WHERE day < date(?1, '-31 days')", [day])?;
            Ok(())
        })
    }

    pub fn note(&self, name: &str) -> Result<Option<String>, String> {
        self.with(|conn| conn.query_row("SELECT value FROM sonus_r2_note WHERE name = ?1", [name], |r| r.get(0)).optional())
    }

    pub fn set_note(&self, name: &str, value: &str) -> Result<(), String> {
        self.with(|conn| {
            conn.execute("INSERT INTO sonus_r2_note (name, value) VALUES (?1, ?2) ON CONFLICT(name) DO UPDATE SET value = excluded.value", [name, value])
                .map(|_| ())
        })
    }
}

/// What a reconciliation changes in the ledger.
#[derive(Clone, Debug, PartialEq)]
pub enum Change {
    /// A new object to upload (or one to upload again).
    Add { key: String, kind: Kind, item: String, version: String, size: u64 },
    /// An object marked `deleting` that the library has again.
    Keep { key: String },
    /// An object the library no longer has: deleted from the bucket after the grace time.
    Gone { key: String, since: i64 },
    /// A row with nothing in the bucket to delete (never uploaded), or one deleted from it.
    Forget { key: String },
    /// An `uploaded` object the bucket does not have (the daily check): uploaded again. Also a `pending` one that
    /// failed too often: tried again.
    Missing { key: String },
    /// An object in the bucket the ledger does not know (the daily check): deleted after the grace time.
    Stray { key: String, kind: Kind, size: u64, since: i64 },
}

fn read_row(r: &rusqlite::Row) -> rusqlite::Result<Option<Row>> {
    let (Some(kind), Some(state)) = (Kind::from_name(&r.get::<_, String>(1)?), State::from_name(&r.get::<_, String>(5)?)) else {
        return Ok(None);
    };
    Ok(Some(Row {
        key: r.get(0)?,
        kind,
        item: r.get(2)?,
        version: r.get(3)?,
        size: r.get::<_, i64>(4)?.max(0) as u64,
        state,
        uploaded_at: r.get(6)?,
        gone_since: r.get(7)?,
        failures: r.get::<_, i64>(8)?.clamp(0, u32::MAX as i64) as u32,
        next_try: r.get(9)?,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rows_move_between_states() {
        let ledger = Ledger::in_memory();
        let add = Change::Add { key: "m/a/1".into(), kind: Kind::Song, item: "a".into(), version: "1".into(), size: 5 };
        ledger.apply(std::slice::from_ref(&add)).unwrap();
        let row = ledger.get("m/a/1").unwrap().unwrap();
        assert_eq!((row.state, row.size, row.uploaded_at), (State::Pending, 5, None));

        ledger.mark_uploaded("m/a/1", 100).unwrap();
        ledger.apply(&[Change::Gone { key: "m/a/1".into(), since: 200 }]).unwrap();
        let row = ledger.get("m/a/1").unwrap().unwrap();
        assert_eq!((row.state, row.gone_since), (State::Deleting, Some(200)));

        ledger.apply(&[Change::Keep { key: "m/a/1".into() }]).unwrap();
        let row = ledger.get("m/a/1").unwrap().unwrap();
        assert_eq!((row.state, row.gone_since, row.uploaded_at), (State::Uploaded, None, Some(100)));

        ledger.apply(&[Change::Missing { key: "m/a/1".into() }]).unwrap();
        assert_eq!(ledger.get("m/a/1").unwrap().unwrap().state, State::Pending);
        ledger.apply(&[Change::Forget { key: "m/a/1".into() }]).unwrap();
        assert_eq!(ledger.get("m/a/1").unwrap(), None);
        assert!(ledger.rows(Kind::Song).unwrap().is_empty());
    }

    #[test]
    fn days_add_up() {
        let ledger = Ledger::in_memory();
        ledger.add_day_bytes("2026-11-26", 10).unwrap();
        ledger.add_day_bytes("2026-11-26", 5).unwrap();
        assert_eq!(ledger.day_bytes("2026-11-26").unwrap(), 15);
        assert_eq!(ledger.day_bytes("2026-11-27").unwrap(), 0);
        ledger.add_day_bytes("2027-01-01", 1).unwrap();
        assert_eq!(ledger.day_bytes("2026-11-26").unwrap(), 0, "older than a month: dropped");
    }
}
