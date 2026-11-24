//! Navidrome's database, shared with Navidrome while it still runs. Until Navidrome is retired the schema is its
//! own (`docs/server-roadmap.md`, principle 3): frozen at goose version 20260922230428 plus the fork's `sonus_*`
//! tables. This server checks that at start and refuses to run on anything else; it never creates, alters or drops
//! Navidrome's tables, and never runs VACUUM.
//!
//! Every connection is set up as Navidrome's are (WAL, a 15 s busy timeout, foreign keys on, synchronous NORMAL).
//! Reads run in autocommit; every write is one short `BEGIN IMMEDIATE` transaction, so it waits for the write lock
//! at its start instead of failing halfway. SQLite calls block, so they run on tokio's blocking threads.
//!
//! Navidrome's connections register a collation, `NATSORT`, which its sort orders name when `EnableNaturalSorting`
//! is on: registered here too (library/natural.rs). Its `SEEDEDRAND` function is not: the random lists are ordered
//! by this server itself (library/browse.rs).

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rusqlite::{Connection, OpenFlags, OptionalExtension, Transaction, TransactionBehavior};

/// The last of Navidrome 0.64.2's migrations: the schema this server knows.
pub const SCHEMA_VERSION: i64 = 20260922230428;

/// The fork's own tables (`db/sonus.go`), made after its migrations.
const SONUS_TABLES: [&str; 3] = ["sonus_two_factor", "sonus_recovery_code", "sonus_app_password"];

const BUSY_TIMEOUT: Duration = Duration::from_secs(15);
const IDLE_CONNECTIONS: usize = 4;

pub struct Db {
    path: PathBuf,
    idle: Mutex<Vec<Connection>>,
}

#[derive(Debug)]
pub enum DbError {
    Sqlite(rusqlite::Error),
    /// The blocking task was cancelled or panicked.
    Task,
}

impl std::fmt::Display for DbError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DbError::Sqlite(e) => write!(f, "{e}"),
            DbError::Task => f.write_str("the database task did not finish"),
        }
    }
}

impl From<rusqlite::Error> for DbError {
    fn from(e: rusqlite::Error) -> Self {
        DbError::Sqlite(e)
    }
}

impl Db {
    /// Opens the database file, which must exist (Navidrome makes it). Blocking.
    pub fn open(path: &Path) -> Result<Arc<Db>, String> {
        let db = Db { path: path.to_owned(), idle: Mutex::new(Vec::new()) };
        let conn = db.connect().map_err(|e| format!("cannot open Navidrome's database {}: {e}", path.display()))?;
        db.put_back(conn);
        Ok(Arc::new(db))
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn connect(&self) -> rusqlite::Result<Connection> {
        // no CREATE: a missing file is an error, not a new empty database
        let flags = OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX;
        let conn = Connection::open_with_flags(&self.path, flags)?;
        conn.busy_timeout(BUSY_TIMEOUT)?;
        // journal_mode answers with a row; the database is in WAL mode already (Navidrome's connections ask for it)
        conn.query_row("PRAGMA journal_mode=WAL", [], |_| Ok(()))?;
        conn.execute_batch("PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL;")?;
        conn.create_collation("NATSORT", crate::library::natural::compare_fold)?;
        Ok(conn)
    }

    fn take(&self) -> rusqlite::Result<Connection> {
        match self.idle.lock().expect("the connection pool's lock").pop() {
            Some(conn) => Ok(conn),
            None => self.connect(),
        }
    }

    fn put_back(&self, conn: Connection) {
        let mut idle = self.idle.lock().expect("the connection pool's lock");
        if idle.len() < IDLE_CONNECTIONS {
            idle.push(conn);
        }
    }

    /// Runs reads on a connection in autocommit. Blocking: see `read`.
    pub fn read_blocking<T>(&self, f: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> Result<T, DbError> {
        let conn = self.take()?;
        let result = f(&conn);
        self.put_back(conn);
        Ok(result?)
    }

    /// Runs writes in one `BEGIN IMMEDIATE` transaction, committed when `f` succeeds and rolled back when it fails.
    /// Blocking: see `write`. Keep it short: Navidrome waits for the same lock.
    pub fn write_blocking<T>(&self, f: impl FnOnce(&Transaction) -> rusqlite::Result<T>) -> Result<T, DbError> {
        let mut conn = self.take()?;
        let result = (|| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let value = f(&tx)?;
            tx.commit()?;
            Ok(value)
        })();
        self.put_back(conn);
        result.map_err(DbError::Sqlite)
    }

    pub async fn read<T: Send + 'static>(self: &Arc<Self>, f: impl FnOnce(&Connection) -> rusqlite::Result<T> + Send + 'static) -> Result<T, DbError> {
        let db = self.clone();
        tokio::task::spawn_blocking(move || db.read_blocking(f)).await.map_err(|_| DbError::Task)?
    }

    pub async fn write<T: Send + 'static>(self: &Arc<Self>, f: impl FnOnce(&Transaction) -> rusqlite::Result<T> + Send + 'static) -> Result<T, DbError> {
        let db = self.clone();
        tokio::task::spawn_blocking(move || db.write_blocking(f)).await.map_err(|_| DbError::Task)?
    }
}

/// Where Navidrome keeps its database: `DbPath` when set (a go-sqlite3 data source name: a path, optionally after
/// `file:` and before `?options`), else `navidrome.db` in `DataFolder`. Relative paths are relative to the working
/// directory, which the gateway shares with the Navidrome it runs.
pub fn locate(data_folder: &str, db_path: &str) -> Result<PathBuf, String> {
    if db_path.is_empty() {
        return Ok(Path::new(data_folder).join("navidrome.db"));
    }
    let name = db_path.split('?').next().unwrap_or("");
    let name = name.strip_prefix("file:").unwrap_or(name);
    if name.is_empty() || name.starts_with(":memory:") {
        return Err(format!("DbPath={db_path}: the Sonus server shares Navidrome's database, so it must be a file"));
    }
    Ok(PathBuf::from(name))
}

/// What the bundled SQLite must have for Navidrome's schema: FTS5 (its triggers keep the search index up to date on
/// every write to songs, albums and artists) and the JSON functions (its queries use them).
pub fn check_sqlite(conn: &Connection) -> Result<(), String> {
    let fts5: bool = conn.query_row("SELECT sqlite_compileoption_used('ENABLE_FTS5')", [], |r| r.get(0)).map_err(|e| e.to_string())?;
    if !fts5 {
        return Err("this build's SQLite has no FTS5, which Navidrome's database needs".into());
    }
    conn.query_row("SELECT json_extract('{\"a\":1}', '$.a')", [], |r| r.get::<_, i64>(0))
        .map_err(|_| "this build's SQLite has no JSON functions, which Navidrome's database needs".to_string())?;
    Ok(())
}

/// The goose version the database is at, None before Navidrome's first migration.
pub fn schema_version(conn: &Connection) -> rusqlite::Result<Option<i64>> {
    let has_table: Option<String> =
        conn.query_row("SELECT name FROM sqlite_master WHERE type='table' AND name='goose_db_version'", [], |r| r.get(0)).optional()?;
    if has_table.is_none() {
        return Ok(None);
    }
    // goose: the newest row decides, and only when it was applied (not rolled back)
    conn.query_row("SELECT version_id FROM goose_db_version WHERE is_applied ORDER BY id DESC LIMIT 1", [], |r| r.get(0)).optional()
}

/// Whether this is the schema the server knows: Navidrome 0.64.2's, with the fork's tables, and one library
/// (`docs/server-roadmap.md`, decision 4). The message says what to do.
pub fn check_schema(conn: &Connection) -> Result<(), String> {
    let sql = |e: rusqlite::Error| format!("cannot read Navidrome's database: {e}");
    match schema_version(conn).map_err(sql)? {
        Some(SCHEMA_VERSION) => {}
        Some(other) => {
            return Err(format!(
                "Navidrome's database is at schema version {other}, but this Sonus server knows {SCHEMA_VERSION} (Navidrome 0.64.2, the \
                 CreeperUX fork): run it with the Navidrome it was built for"
            ));
        }
        None => return Err("Navidrome's database has no schema yet (no goose_db_version): Navidrome has not finished starting".into()),
    }
    for table in SONUS_TABLES {
        let found: Option<String> =
            conn.query_row("SELECT name FROM sqlite_master WHERE type='table' AND name=?1", [table], |r| r.get(0)).optional().map_err(sql)?;
        if found.is_none() {
            return Err(format!("Navidrome's database has no {table} table: it was not made by the CreeperUX fork of Navidrome (0.64.2-sonus)"));
        }
    }
    let hashed: i64 = conn.query_row("SELECT count(*) FROM pragma_table_info('sonus_app_password') WHERE name='secret_hash'", [], |r| r.get(0)).map_err(sql)?;
    if hashed == 0 {
        return Err("sonus_app_password has no secret_hash column: the database was made by an older build of the fork; start that fork's current \
                    Navidrome on it once"
            .into());
    }
    let libraries: i64 = conn.query_row("SELECT count(*) FROM library", [], |r| r.get(0)).map_err(sql)?;
    if libraries != 1 {
        return Err(format!("Navidrome's database has {libraries} libraries: the Sonus server supports exactly one"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_bundled_sqlite_has_fts5_and_json() {
        let conn = Connection::open_in_memory().unwrap();
        check_sqlite(&conn).unwrap();
        // not only compiled in: usable, as Navidrome's triggers use it
        conn.execute_batch(
            "CREATE VIRTUAL TABLE song_fts USING fts5(title, tokenize='unicode61 remove_diacritics 2');
             INSERT INTO song_fts(title) VALUES ('Été à la plage');",
        )
        .unwrap();
        let hits: i64 = conn.query_row("SELECT count(*) FROM song_fts WHERE song_fts MATCH 'ete'", [], |r| r.get(0)).unwrap();
        assert_eq!(hits, 1);
        let name: String =
            conn.query_row("SELECT json_group_array(json_object('id', 1)) ->> '$[0].id'", [], |r| r.get::<_, i64>(0)).map(|v| v.to_string()).unwrap();
        assert_eq!(name, "1");
    }

    #[test]
    fn the_database_is_where_navidrome_keeps_it() {
        assert_eq!(locate("/data", "").unwrap(), Path::new("/data").join("navidrome.db"));
        assert_eq!(locate(".", "").unwrap(), Path::new(".").join("navidrome.db"));
        assert_eq!(locate("/data", "/db/nd.db?cache=shared&_busy_timeout=15000").unwrap(), PathBuf::from("/db/nd.db"));
        assert_eq!(locate("/data", "file:/db/nd.db?mode=rwc").unwrap(), PathBuf::from("/db/nd.db"));
        assert_eq!(locate("/data", "nd.db").unwrap(), PathBuf::from("nd.db"), "a DbPath of its own is not under DataFolder");
        assert!(locate("/data", ":memory:").is_err());
        assert!(locate("/data", "file::memory:?cache=shared").is_err());
    }

    fn schema(version: i64, applied: bool, libraries: usize, sonus: bool) -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE goose_db_version (id INTEGER PRIMARY KEY AUTOINCREMENT, version_id INTEGER NOT NULL, is_applied INTEGER NOT NULL, tstamp TIMESTAMP DEFAULT (datetime('now')));
             INSERT INTO goose_db_version (version_id, is_applied) VALUES (0, 1), (20260901225726, 1);
             CREATE TABLE library (id INTEGER PRIMARY KEY, name TEXT);",
        )
        .unwrap();
        conn.execute("INSERT INTO goose_db_version (version_id, is_applied) VALUES (?1, ?2)", (version, applied)).unwrap();
        for i in 0..libraries {
            conn.execute("INSERT INTO library (name) VALUES (?1)", [format!("Library {i}")]).unwrap();
        }
        if sonus {
            conn.execute_batch(
                "CREATE TABLE sonus_two_factor (user_id TEXT PRIMARY KEY);
                 CREATE TABLE sonus_recovery_code (user_id TEXT);
                 CREATE TABLE sonus_app_password (id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL DEFAULT '');",
            )
            .unwrap();
        }
        conn
    }

    #[test]
    fn only_the_known_schema_passes() {
        check_schema(&schema(SCHEMA_VERSION, true, 1, true)).unwrap();
        assert!(check_schema(&schema(20270101000000, true, 1, true)).unwrap_err().contains("20270101000000"), "a newer Navidrome's");
        assert!(check_schema(&schema(SCHEMA_VERSION, false, 1, true)).unwrap_err().contains("20260901225726"), "the last migration rolled back");
        assert!(check_schema(&schema(SCHEMA_VERSION, true, 1, false)).unwrap_err().contains("sonus_two_factor"), "upstream Navidrome's");
        assert!(check_schema(&schema(SCHEMA_VERSION, true, 2, true)).unwrap_err().contains("2 libraries"));
        assert!(check_schema(&schema(SCHEMA_VERSION, true, 0, true)).unwrap_err().contains("0 libraries"));
        assert!(check_schema(&Connection::open_in_memory().unwrap()).unwrap_err().contains("no schema yet"));

        let old = schema(SCHEMA_VERSION, true, 1, false);
        old.execute_batch("CREATE TABLE sonus_two_factor (a); CREATE TABLE sonus_recovery_code (a); CREATE TABLE sonus_app_password (id TEXT);").unwrap();
        assert!(check_schema(&old).unwrap_err().contains("secret_hash"));
    }

    #[test]
    fn connections_are_set_up_as_navidromes_and_writes_are_immediate() {
        let dir = std::env::temp_dir().join(format!("sonus-db-test-{}-{:?}", std::process::id(), std::thread::current().id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("navidrome.db");
        assert!(Db::open(&file).is_err(), "a missing database is not created");
        Connection::open(&file).unwrap().execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE t (v INTEGER);").unwrap();

        let db = Db::open(&file).unwrap();
        let (journal, foreign_keys, synchronous, busy): (String, i64, i64, i64) = db
            .read_blocking(|c| {
                Ok((
                    c.query_row("PRAGMA journal_mode", [], |r| r.get(0))?,
                    c.query_row("PRAGMA foreign_keys", [], |r| r.get(0))?,
                    c.query_row("PRAGMA synchronous", [], |r| r.get(0))?,
                    c.query_row("PRAGMA busy_timeout", [], |r| r.get(0))?,
                ))
            })
            .unwrap();
        assert_eq!((journal.as_str(), foreign_keys, synchronous, busy), ("wal", 1, 1, 15_000));

        db.write_blocking(|tx| tx.execute("INSERT INTO t VALUES (1)", []).map(|_| ())).unwrap();
        let failed = db.write_blocking(|tx| {
            tx.execute("INSERT INTO t VALUES (2)", [])?;
            tx.execute("INSERT INTO nowhere VALUES (3)", [])
        });
        assert!(failed.is_err());
        let rows: Vec<i64> = db.read_blocking(|c| c.prepare("SELECT v FROM t")?.query_map([], |r| r.get(0))?.collect()).unwrap();
        assert_eq!(rows, vec![1], "a failed write leaves nothing behind");

        // a write transaction holds the write lock from its first statement: another writer waits (here: gives up at once)
        let other = Connection::open(&file).unwrap();
        other.busy_timeout(Duration::ZERO).unwrap();
        db.write_blocking(|tx| {
            let busy = other.execute("INSERT INTO t VALUES (9)", []);
            assert!(matches!(busy, Err(rusqlite::Error::SqliteFailure(e, _)) if e.code == rusqlite::ErrorCode::DatabaseBusy), "{busy:?}");
            tx.execute("INSERT INTO t VALUES (4)", []).map(|_| ())
        })
        .unwrap();
        drop(other);
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
