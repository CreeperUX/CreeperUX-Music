//! A database as the frozen Navidrome leaves it, as far as sign-ins and a song's name go: the tables are created with
//! the statements of a database the fork made (0.64.2-sonus.10, `tools/fixtures`), at its last migration, with one
//! library. `media_file` has the columns up to `bit_rate`, then `library_id` and `missing` (of its 70).

use std::path::Path;

use rusqlite::Connection;
use sonus_server::db::SCHEMA_VERSION;
use sonus_server::secrets::{Keys, api_key_hash};

const SCHEMA: &str = r#"
CREATE TABLE goose_db_version (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    version_id INTEGER NOT NULL,
    is_applied INTEGER NOT NULL,
    tstamp TIMESTAMP DEFAULT (datetime('now'))
);
CREATE TABLE library (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, path TEXT NOT NULL UNIQUE);
INSERT INTO library (name, path) VALUES ('Music Library', '/music');
CREATE TABLE property
(
	id varchar(255) not null
		primary key,
	value varchar(255) default '' not null
);
CREATE TABLE user_library (user_id VARCHAR(255) NOT NULL, library_id INTEGER NOT NULL, PRIMARY KEY (user_id, library_id));
CREATE TABLE "user"
(
    id             varchar(255)                              not null
        primary key,
    user_name      varchar(255)                default ''    not null
        unique,
    name           varchar(255) collate NOCASE default ''    not null,
    email          varchar(255)                default ''    not null,
    password       varchar(255)                default ''    not null,
    is_admin       bool                        default FALSE not null,
    last_login_at  datetime,
    last_access_at datetime,
    created_at     datetime                                  not null,
    updated_at     datetime                                  not null
, scrobble_filter varchar default '' not null, token_epoch INTEGER NOT NULL DEFAULT 0);
CREATE TABLE sonus_two_factor (
	user_id TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
	secret TEXT NOT NULL DEFAULT '',
	pending_secret TEXT NOT NULL DEFAULT '',
	confirmed_at DATETIME,
	last_step INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE sonus_recovery_code (
	user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
	code_hash TEXT NOT NULL,
	used_at DATETIME,
	PRIMARY KEY (user_id, code_hash)
);
CREATE TABLE sonus_app_password (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
	name TEXT NOT NULL,
	secret TEXT NOT NULL,
	created_at DATETIME NOT NULL,
	last_used_at DATETIME,
	last_used_by TEXT NOT NULL DEFAULT ''
, secret_hash TEXT NOT NULL DEFAULT '');
CREATE INDEX sonus_app_password_user ON sonus_app_password(user_id);
CREATE INDEX sonus_app_password_hash ON sonus_app_password(secret_hash);
CREATE TABLE "media_file"
(
    id                      varchar(255)                         not null
        primary key,
    path                    varchar(255)           default ''    not null,
    title                   varchar(255)           default ''    not null,
    album                   varchar(255)           default ''    not null,
    artist                  varchar(255)           default ''    not null,
    artist_id               varchar(255)           default ''    not null,
    album_artist            varchar(255)           default ''    not null,
    album_id                varchar(255)           default ''    not null,
    has_cover_art           bool                   default FALSE not null,
    track_number            integer                default 0     not null,
    disc_number             integer                default 0     not null,
    year                    integer                default 0     not null,
    size                    integer                default 0     not null,
    suffix                  varchar(255)           default ''    not null,
    duration                real                   default 0     not null,
    bit_rate                integer                default 0     not null,
    library_id              integer                default 1     not null
        references library
            on delete cascade
, missing boolean default false not null);
"#;

/// A new database file at `path`, at `version` (the known one: `SCHEMA_VERSION`).
pub fn create_at_version(path: &Path, version: i64) -> Connection {
    let conn = Connection::open(path).unwrap();
    conn.execute_batch("PRAGMA journal_mode=WAL;").unwrap();
    conn.execute_batch(SCHEMA).unwrap();
    conn.execute("INSERT INTO goose_db_version (version_id, is_applied) VALUES (0, 1), (?1, 1)", [version]).unwrap();
    conn
}

/// The session secret, sealed in the `property` table as Navidrome keeps it.
pub fn set_session_secret(conn: &Connection, keys: &Keys, secret: &str) {
    conn.execute("INSERT OR REPLACE INTO property (id, value) VALUES ('JWTSecret', ?1)", [keys.seal(secret.as_bytes()).unwrap()]).unwrap();
}

pub fn create(path: &Path) -> Connection {
    create_at_version(path, SCHEMA_VERSION)
}

/// A user whose id is `id-<name>`, the password sealed as Navidrome seals it.
pub fn add_user(conn: &Connection, keys: &Keys, name: &str, password: &str) -> String {
    let id = format!("id-{name}");
    conn.execute(
        "INSERT INTO user (id, user_name, name, password, created_at, updated_at) VALUES (?1, ?2, ?2, ?3, '2026-11-24 21:01:53.5980136+01:00', '2026-11-24 21:01:53.5980136+01:00')",
        (&id, name, keys.seal(password.as_bytes()).unwrap()),
    )
    .unwrap();
    id
}

/// An app password of the user's, sealed and hashed as the fork's store does.
pub fn add_app_password(conn: &Connection, keys: &Keys, user_id: &str, id: &str, password: &str) {
    conn.execute(
        "INSERT INTO sonus_app_password (id, user_id, name, secret, secret_hash, created_at) VALUES (?1, ?2, 'Test', ?3, ?4, '2026-11-24 20:01:53.6158737+00:00')",
        (id, user_id, keys.seal(password.as_bytes()).unwrap(), api_key_hash(password.as_bytes())),
    )
    .unwrap();
}

/// Two-step verification, set up and confirmed, or only begun.
pub fn add_two_factor(conn: &Connection, user_id: &str, confirmed: bool) {
    let at = confirmed.then_some("2026-11-24 20:01:53.6128455+00:00");
    conn.execute("INSERT INTO sonus_two_factor (user_id, secret, confirmed_at) VALUES (?1, 'sealed', ?2)", (user_id, at)).unwrap();
}

/// Makes the user an admin (who sees every library).
pub fn make_admin(conn: &Connection, user_id: &str) {
    conn.execute("UPDATE user SET is_admin = TRUE WHERE id = ?1", [user_id]).unwrap();
}

/// Grants the user the library, as Navidrome does for a new user.
pub fn grant_library(conn: &Connection, user_id: &str) {
    conn.execute("INSERT INTO user_library (user_id, library_id) VALUES (?1, 1)", [user_id]).unwrap();
}

/// A song in the library: `duration` in seconds; its cover is its own (`has_cover_art`), its disc's or its album's.
pub fn add_song(conn: &Connection, id: &str, title: &str, album_id: &str, duration: f64, has_cover_art: bool, disc_number: i64) {
    conn.execute(
        "INSERT INTO media_file (id, title, artist, album, album_id, duration, has_cover_art, disc_number) VALUES (?1, ?2, 'The Artist', 'The Album', ?3, ?4, ?5, ?6)",
        (id, title, album_id, duration, has_cover_art, disc_number),
    )
    .unwrap();
}
