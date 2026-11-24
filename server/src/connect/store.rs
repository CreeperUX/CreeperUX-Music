//! What Sonus Connect keeps in the database, and what it reads there.
//!
//! **Its own tables**, in Navidrome's database file (`docs/server-roadmap.md`, principle 3: additive only, in the
//! server's own namespace, with its own version table; Navidrome's tables are never altered):
//!
//! - `sonus_server_schema (part, version)`: which version of each part of the Rust server's own schema the file
//!   holds. Navidrome's migrations (goose) do not know it and do not touch it.
//! - `sonus_connect_session (user_id, session, lists, updated_at)`: one row per user, the session as
//!   `ConnectSession::save` gives it, in two parts: `session` (small: the position, the song, the order) and `lists`
//!   (the context, its own order, the hand-queued songs: up to 21,000 ids), so a position report rewrites a few
//!   hundred bytes and not the whole queue. A user's row goes with the user (`ON DELETE CASCADE`).
//!
//! **Navidrome's tables**, read only: `media_file` for what a song is, with `user` and `user_library` for whether
//! the session's user may see it, as Navidrome's `applyLibraryFilter` decides it (an admin sees every library, anyone
//! else the ones granted in `user_library`).

use rusqlite::{Connection, OptionalExtension, Transaction};
use serde_json::{Value, json};
use tracing::warn;

use super::queue::{Library, Song};
use crate::db::{Db, DbError};

/// The version of Connect's part of the schema this server writes.
pub const SCHEMA_VERSION: i64 = 1;
const PART: &str = "connect";

/// Makes Connect's tables when the database has none yet. Err: the tables are from a newer server (or cannot be
/// made); the server then does not run on this database.
pub fn prepare(db: &Db) -> Result<(), String> {
    let found = db
        .write_blocking(|tx| {
            tx.execute_batch("CREATE TABLE IF NOT EXISTS sonus_server_schema (part TEXT PRIMARY KEY, version INTEGER NOT NULL);")?;
            let version: Option<i64> = tx.query_row("SELECT version FROM sonus_server_schema WHERE part = ?1", [PART], |r| r.get(0)).optional()?;
            if version.is_none() {
                create(tx)?;
            }
            Ok(version.unwrap_or(SCHEMA_VERSION))
        })
        .map_err(|e| format!("cannot prepare the Sonus Connect tables: {e}"))?;
    if found != SCHEMA_VERSION {
        return Err(format!(
            "the database's Sonus Connect tables are at version {found}, but this Sonus server knows {SCHEMA_VERSION}: it was used by a newer server"
        ));
    }
    Ok(())
}

fn create(tx: &Transaction) -> rusqlite::Result<()> {
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS sonus_connect_session (
             user_id TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
             session TEXT NOT NULL,
             lists TEXT NOT NULL,
             updated_at INTEGER NOT NULL
         );",
    )?;
    tx.execute("INSERT INTO sonus_server_schema (part, version) VALUES (?1, ?2)", (PART, SCHEMA_VERSION))?;
    Ok(())
}

/// The lists of a saved session (`ConnectSession::save`), apart from the rest.
const LISTS: [&str; 3] = ["context", "source", "manual"];

/// A saved session in its two parts: (`session`, `lists`).
pub fn split(mut saved: Value) -> (Value, Value) {
    let mut lists = serde_json::Map::new();
    if let Some(queue) = saved.get_mut("queue").and_then(Value::as_object_mut) {
        for name in LISTS {
            if let Some(list) = queue.remove(name) {
                lists.insert(name.into(), list);
            }
        }
    }
    (saved, Value::Object(lists))
}

/// The two parts as one again.
fn join(mut session: Value, lists: Value) -> Option<Value> {
    let queue = session.get_mut("queue")?.as_object_mut()?;
    let mut lists = match lists {
        Value::Object(lists) => lists,
        _ => return None,
    };
    for name in LISTS {
        queue.insert(name.into(), lists.remove(name)?);
    }
    Some(session)
}

/// What to write for a user: the small part always, the lists when they changed since the last write.
pub struct Save {
    pub user_id: String,
    pub session: String,
    pub lists: Option<String>,
}

/// Writes them in one short transaction. A row whose lists are not given must exist already: when it does not (the
/// user was deleted meanwhile, or the row was), nothing is written for it. Returns the users written.
pub fn save(db: &Db, saves: &[Save], now: i64) -> Result<Vec<bool>, DbError> {
    db.write_blocking(|tx| {
        let mut written = Vec::with_capacity(saves.len());
        for save in saves {
            let rows = match &save.lists {
                Some(lists) => {
                    // a user who is gone has no session to keep (the insert would break the reference to `user`)
                    tx.prepare_cached(
                        "INSERT INTO sonus_connect_session (user_id, session, lists, updated_at)
                         SELECT ?1, ?2, ?3, ?4 WHERE EXISTS (SELECT 1 FROM user WHERE id = ?1)
                         ON CONFLICT (user_id) DO UPDATE SET session = excluded.session, lists = excluded.lists, updated_at = excluded.updated_at",
                    )?
                    .execute((&save.user_id, &save.session, lists, now))?
                }
                None => tx.prepare_cached("UPDATE sonus_connect_session SET session = ?2, updated_at = ?3 WHERE user_id = ?1")?.execute((
                    &save.user_id,
                    &save.session,
                    now,
                ))?,
            };
            written.push(rows > 0);
        }
        Ok(written)
    })
}

/// A user's saved session. `Ok(None)`: none, or one that cannot be read as JSON (said in the log; the session then
/// starts empty).
pub fn load(db: &Db, user_id: &str) -> Result<Option<Value>, DbError> {
    let row: Option<(String, String)> = db.read_blocking(|conn| {
        conn.query_row("SELECT session, lists FROM sonus_connect_session WHERE user_id = ?1", [user_id], |r| Ok((r.get(0)?, r.get(1)?))).optional()
    })?;
    let Some((session, lists)) = row else { return Ok(None) };
    let joined = match (serde_json::from_str(&session), serde_json::from_str(&lists)) {
        (Ok(session), Ok(lists)) => join(session, lists),
        _ => None,
    };
    if joined.is_none() {
        warn!(user = user_id, "Connect: the saved session cannot be read; starting an empty one");
    }
    Ok(joined)
}

/// Whether the user still exists.
pub fn user_exists(db: &Db, user_id: &str) -> Result<bool, DbError> {
    db.read_blocking(|conn| conn.prepare_cached("SELECT 1 FROM user WHERE id = ?1")?.exists([user_id]))
}

/// A song the user may see: in a library granted to them, or any when they are an admin.
const VISIBLE: &str = "(EXISTS (SELECT 1 FROM user u WHERE u.id = ?2 AND u.is_admin) \
                       OR mf.library_id IN (SELECT ul.library_id FROM user_library ul WHERE ul.user_id = ?2))";

/// Navidrome's library as one user sees it. Blocking: used on a blocking thread.
pub struct UserLibrary<'a> {
    pub db: &'a Db,
    pub user_id: &'a str,
}

impl UserLibrary<'_> {
    fn query<T>(&self, what: &str, f: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> Option<T> {
        match self.db.read_blocking(f) {
            Ok(value) => Some(value),
            Err(e) => {
                warn!(error = %e, "Connect: could not read {what}");
                None
            }
        }
    }
}

impl Library for UserLibrary<'_> {
    fn has(&self, id: &str) -> bool {
        let sql = format!("SELECT 1 FROM media_file mf WHERE mf.id = ?1 AND {VISIBLE}");
        self.query("whether a song exists", |conn| conn.prepare_cached(&sql)?.exists((id, self.user_id))).unwrap_or(false)
    }

    fn lookup(&self, id: &str) -> Option<Song> {
        let sql = format!(
            "SELECT mf.title, mf.artist, mf.album, mf.album_id, mf.duration, mf.has_cover_art, mf.disc_number FROM media_file mf WHERE mf.id = ?1 AND {VISIBLE}"
        );
        self.query("a song", |conn| {
            conn.prepare_cached(&sql)?
                .query_row((id, self.user_id), |r| {
                    let (album_id, seconds, has_cover_art, disc): (String, f64, bool, i64) = (r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?);
                    Ok(Song {
                        title: Some(r.get(0)?),
                        artist: Some(r.get(1)?),
                        album: Some(r.get(2)?),
                        cover_art: Some(cover_art(id, &album_id, has_cover_art, disc)),
                        album_id: Some(album_id),
                        duration_ms: Some((seconds * 1000.0).round().max(0.0) as i64),
                    })
                })
                .optional()
        })
        .flatten()
    }
}

/// The id `getCoverArt` shows the song's picture for, as Navidrome's `MediaFile.CoverArtID` picks it: the file's own
/// picture, else its disc's, else its album's. Navidrome's answers add `_<hash>` to these ids (for caches); it reads
/// them without, and the active device's `loaded` report replaces this one with the id its own lookup gave.
fn cover_art(id: &str, album_id: &str, has_cover_art: bool, disc: i64) -> String {
    if has_cover_art {
        format!("mf-{id}")
    } else if disc > 0 {
        format!("dc-{album_id}:{disc}")
    } else {
        format!("al-{album_id}")
    }
}

/// Connect's row count and schema version, for tests and the start-up log.
pub fn describe(db: &Db) -> Result<Value, DbError> {
    db.read_blocking(|conn| {
        let version: Option<i64> = conn.query_row("SELECT version FROM sonus_server_schema WHERE part = ?1", [PART], |r| r.get(0)).optional()?;
        let sessions: i64 = conn.query_row("SELECT count(*) FROM sonus_connect_session", [], |r| r.get(0))?;
        Ok(json!({ "version": version, "sessions": sessions }))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_saved_session_splits_into_its_two_parts_and_back() {
        let saved = json!({
            "version": 2, "rev": 7, "positionMs": 1200,
            "queue": { "context": ["a", "b"], "source": ["b", "a"], "pointer": 1, "manual": [{ "key": "q1", "trackId": "c" }], "order": "default" },
        });
        let (session, lists) = split(saved.clone());
        assert_eq!(session, json!({ "version": 2, "rev": 7, "positionMs": 1200, "queue": { "pointer": 1, "order": "default" } }));
        assert_eq!(lists, json!({ "context": ["a", "b"], "source": ["b", "a"], "manual": [{ "key": "q1", "trackId": "c" }] }));
        assert_eq!(join(session.clone(), lists), Some(saved));
        assert_eq!(join(session, json!({ "context": [] })), None, "lists that are not whole");
    }

    #[test]
    fn the_cover_is_the_files_then_the_discs_then_the_albums() {
        assert_eq!(cover_art("s1", "a1", true, 2), "mf-s1");
        assert_eq!(cover_art("s1", "a1", false, 2), "dc-a1:2");
        assert_eq!(cover_art("s1", "a1", false, 0), "al-a1");
    }
}
