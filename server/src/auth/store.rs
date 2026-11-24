//! What the `/auth` routes keep in Navidrome's database: users (read, and the first admin made), and the fork's
//! two-step verification store (`core/twofactor/store.go`): the authenticator secret, recovery codes, app passwords.
//! The same tables, the same statements and the same sealed formats as the fork's, so either server reads what the
//! other wrote. Every function blocks (see `Db`); each write is one `BEGIN IMMEDIATE` transaction.
//!
//! Ported from Navidrome and its CreeperUX fork (GPL-3.0), © the Navidrome authors.

use chrono::{DateTime, Local, Utc};
use rusqlite::{Connection, OptionalExtension};

use super::totp;
use crate::config::TwoFactor;
use crate::db::{Db, DbError};
use crate::secrets::{self, Keys};
use crate::{gotime, id};

#[derive(Debug)]
pub enum StoreError {
    Db(DbError),
    /// A stored secret cannot be opened: was `PasswordEncryptionKey` changed?
    Unreadable,
    /// The system gave no random bytes.
    Random,
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StoreError::Db(e) => write!(f, "{e}"),
            StoreError::Unreadable => f.write_str("two-step verification data cannot be read: was PasswordEncryptionKey changed?"),
            StoreError::Random => f.write_str("the system gave no random bytes"),
        }
    }
}

impl From<DbError> for StoreError {
    fn from(e: DbError) -> Self {
        StoreError::Db(e)
    }
}

impl From<rusqlite::Error> for StoreError {
    fn from(e: rusqlite::Error) -> Self {
        StoreError::Db(DbError::Sqlite(e))
    }
}

impl From<getrandom::Error> for StoreError {
    fn from(_: getrandom::Error) -> Self {
        StoreError::Random
    }
}

impl From<secrets::SecretError> for StoreError {
    fn from(e: secrets::SecretError) -> Self {
        match e {
            secrets::SecretError::Unreadable => StoreError::Unreadable,
            secrets::SecretError::Random => StoreError::Random,
        }
    }
}

// ---------------------------------------------------------------- users

#[derive(Debug, Clone, PartialEq)]
pub struct User {
    pub id: String,
    pub user_name: String,
    pub name: String,
    pub email: String,
    pub is_admin: bool,
    /// Bumped when the password changes: tokens made before are revoked.
    pub token_epoch: i64,
    /// The account password, None when it cannot be opened (it then matches nothing).
    pub password: Option<Vec<u8>>,
}

/// Navidrome's `FindByUsernameWithPassword`: the user by name, in any (ASCII) case.
pub fn find_user(db: &Db, keys: &Keys, username: &str) -> Result<Option<User>, DbError> {
    let row = db.read_blocking(|conn| {
        conn.query_row(
            "SELECT id, user_name, name, email, is_admin, token_epoch, password FROM user WHERE user_name = ?1 COLLATE NOCASE ORDER BY id LIMIT 1",
            [username],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get::<_, bool>(4)?, r.get(5)?, r.get::<_, String>(6)?)),
        )
        .optional()
    })?;
    Ok(row.map(|(id, user_name, name, email, is_admin, token_epoch, sealed)| User {
        id,
        user_name,
        name,
        email,
        is_admin,
        token_epoch,
        password: keys.open(&sealed).ok(),
    }))
}

/// Navidrome's `UpdateLastLoginAt` (`time.Now()`, the server's local time).
pub fn touch_last_login(db: &Db, user_id: &str) -> Result<(), DbError> {
    let (now, id) = (gotime::now_local(), user_id.to_string());
    db.write_blocking(move |tx| tx.execute("UPDATE user SET last_login_at = ?1 WHERE id = ?2", (&now, &id)).map(|_| ()))
}

/// Go's `cases.Title(language.Und)` for a user name: each word's first letter in capitals, the rest small.
fn title_case(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut start = true;
    for c in text.chars() {
        if c.is_alphanumeric() {
            if start {
                out.extend(c.to_uppercase());
            } else {
                out.extend(c.to_lowercase());
            }
            start = false;
        } else {
            out.push(c);
            // an apostrophe is inside a word ("o'neil" is "O'neil" to Go too)
            start = c != '\'' && c != '’';
        }
    }
    out
}

/// Navidrome's `createAdmin`: the first user, an admin, made only while there is none. False: there is a user
/// already. The count and the insert are one transaction, so two requests at once make one admin, not two.
pub fn create_first_admin(db: &Db, keys: &Keys, username: &str, password: &str) -> Result<bool, StoreError> {
    let (id, sealed) = (id::new_random()?, keys.seal(password.as_bytes())?);
    let (username, name, now) = (username.to_string(), title_case(username), gotime::now_local());
    Ok(db.write_blocking(move |tx| {
        let users: i64 = tx.query_row("SELECT count(*) FROM user", [], |r| r.get(0))?;
        if users > 0 {
            return Ok(false);
        }
        // the columns Navidrome's user repository writes for a new user (persistence/user_repository.go, Put)
        tx.execute(
            "INSERT INTO user (id, user_name, name, email, password, is_admin, last_login_at, last_access_at, created_at, updated_at, scrobble_filter) \
             VALUES (?1, ?2, ?3, '', ?4, 1, ?5, NULL, ?5, ?5, '')",
            (&id, &username, &name, &sealed, &now),
        )?;
        // an admin has every library
        tx.execute("INSERT OR IGNORE INTO user_library (user_id, library_id) SELECT ?1, id FROM library", [&id])?;
        Ok(true)
    })?)
}

// ---------------------------------------------------------------- two-step verification

/// Set up and confirmed, and the policy is not `off`: the account password alone opens nothing.
pub fn enabled(db: &Db, policy: TwoFactor, user_id: &str) -> Result<bool, DbError> {
    if policy == TwoFactor::Off {
        return Ok(false);
    }
    db.read_blocking(|conn| confirmed(conn, user_id))
}

fn confirmed(conn: &Connection, user_id: &str) -> rusqlite::Result<bool> {
    let n: i64 = conn.query_row("SELECT count(*) FROM sonus_two_factor WHERE user_id = ?1 AND confirmed_at IS NOT NULL", [user_id], |r| r.get(0))?;
    Ok(n > 0)
}

/// What a user (or an admin) sees of their two-step verification.
#[derive(Debug, PartialEq)]
pub struct Status {
    /// Set up and confirmed, whatever the policy.
    pub enabled: bool,
    /// When, as stored.
    pub enabled_at: Option<String>,
    pub recovery_codes_left: i64,
}

pub fn status(db: &Db, user_id: &str) -> Result<Status, DbError> {
    db.read_blocking(|conn| {
        let confirmed_at: Option<Option<String>> =
            conn.query_row("SELECT confirmed_at FROM sonus_two_factor WHERE user_id = ?1", [user_id], |r| r.get(0)).optional()?;
        let enabled_at = confirmed_at.flatten();
        let recovery_codes_left = conn.query_row("SELECT count(*) FROM sonus_recovery_code WHERE user_id = ?1 AND used_at IS NULL", [user_id], |r| r.get(0))?;
        Ok(Status { enabled: enabled_at.is_some(), enabled_at, recovery_codes_left })
    })
}

/// A new authenticator secret for the user, kept aside until a code from it is confirmed (one already set up keeps
/// working until then). The secret and its `otpauth://` link.
pub fn begin_setup(db: &Db, keys: &Keys, user_id: &str, account: &str) -> Result<(String, String), StoreError> {
    let secret = totp::new_secret()?;
    let (sealed, id) = (keys.seal(secret.as_bytes())?, user_id.to_string());
    db.write_blocking(move |tx| {
        tx.execute(
            "INSERT INTO sonus_two_factor (user_id, pending_secret) VALUES (?1, ?2) ON CONFLICT(user_id) DO UPDATE SET pending_secret = excluded.pending_secret",
            (&id, &sealed),
        )
    })?;
    let uri = totp::uri(totp::ISSUER, account, &secret);
    Ok((secret, uri))
}

#[derive(Debug)]
pub enum ConfirmError {
    /// Nothing is being set up.
    NoSetup,
    InvalidCode,
    Store(StoreError),
}

impl<E: Into<StoreError>> From<E> for ConfirmError {
    fn from(e: E) -> Self {
        ConfirmError::Store(e.into())
    }
}

/// Checks a code from the secret being set up; when it matches, that secret becomes the one in use and the user gets
/// new recovery codes (the old ones stop working).
pub fn confirm_setup(db: &Db, keys: &Keys, user_id: &str, code: &str, now: DateTime<Utc>) -> Result<Vec<String>, ConfirmError> {
    let pending: Option<String> =
        db.read_blocking(|conn| conn.query_row("SELECT pending_secret FROM sonus_two_factor WHERE user_id = ?1", [user_id], |r| r.get(0)).optional())?;
    let Some(pending) = pending.filter(|p| !p.is_empty()) else { return Err(ConfirmError::NoSetup) };
    let secret = String::from_utf8(keys.open(&pending)?).map_err(|_| StoreError::Unreadable)?;
    let Some(step) = totp::match_step(&secret, code, now.timestamp()) else { return Err(ConfirmError::InvalidCode) };
    let codes = new_codes()?;
    let (id, at, hashes) = (user_id.to_string(), gotime::format(&now), codes.iter().map(|c| recovery_hash(c)).collect::<Vec<_>>());
    db.write_blocking(move |tx| {
        tx.execute(
            "UPDATE sonus_two_factor SET secret = pending_secret, pending_secret = '', confirmed_at = ?1, last_step = ?2 WHERE user_id = ?3",
            (&at, step, &id),
        )?;
        end_sessions(tx, &id)?;
        replace_recovery_codes(tx, &id, &hashes)
    })?;
    Ok(codes)
}

/// Checks a code at sign-in: from the authenticator (each one once: a code seen before is refused), or one of the
/// recovery codes (used up by it). False for a wrong code, and for one that cannot be checked.
pub fn verify(db: &Db, keys: &Keys, user_id: &str, code: &str, now: DateTime<Utc>) -> Result<bool, StoreError> {
    if is_recovery_code(code) {
        let (at, id, hash) = (gotime::format(&now), user_id.to_string(), recovery_hash(code));
        let used = db.write_blocking(move |tx| {
            tx.execute("UPDATE sonus_recovery_code SET used_at = ?1 WHERE user_id = ?2 AND code_hash = ?3 AND used_at IS NULL", (&at, &id, &hash))
        })?;
        return Ok(used == 1);
    }
    let sealed: Option<String> = db.read_blocking(|conn| {
        conn.query_row("SELECT secret FROM sonus_two_factor WHERE user_id = ?1 AND confirmed_at IS NOT NULL", [user_id], |r| r.get(0)).optional()
    })?;
    let Some(sealed) = sealed else { return Ok(false) };
    let secret = String::from_utf8(keys.open(&sealed)?).map_err(|_| StoreError::Unreadable)?;
    let Some(step) = totp::match_step(&secret, code, now.timestamp()) else { return Ok(false) };
    // one use per code: someone who saw it go by cannot sign in with it too
    let id = user_id.to_string();
    let taken = db.write_blocking(move |tx| tx.execute("UPDATE sonus_two_factor SET last_step = ?1 WHERE user_id = ?2 AND last_step < ?1", (step, &id)))?;
    Ok(taken == 1)
}

/// Replaces the user's recovery codes (after the caller checked a code).
pub fn new_recovery_codes(db: &Db, user_id: &str) -> Result<Vec<String>, StoreError> {
    let codes = new_codes()?;
    let (id, hashes) = (user_id.to_string(), codes.iter().map(|c| recovery_hash(c)).collect::<Vec<_>>());
    db.write_blocking(move |tx| replace_recovery_codes(tx, &id, &hashes))?;
    Ok(codes)
}

/// Ends the user's sessions, as a new password does (Navidrome and this server refuse a token from an earlier
/// epoch). When two-step verification is turned on: a session opened before, with the password alone, would
/// otherwise go on, and be renewed for as long as it is used. (Turning it off, or an admin's reset, ends none: those
/// sessions were opened with a code, and after a reset the next set-up ends them.)
fn end_sessions(tx: &rusqlite::Transaction<'_>, user_id: &str) -> rusqlite::Result<()> {
    tx.execute("UPDATE user SET token_epoch = token_epoch + 1 WHERE id = ?1", [user_id]).map(|_| ())
}

/// Removes the user's two-step verification and recovery codes (their app passwords stay). With the policy
/// `required` they are asked to set it up again at the next sign-in: an admin's reset for a lost phone.
pub fn disable(db: &Db, user_id: &str) -> Result<(), DbError> {
    let id = user_id.to_string();
    db.write_blocking(move |tx| {
        tx.execute("DELETE FROM sonus_two_factor WHERE user_id = ?1", [&id])?;
        tx.execute("DELETE FROM sonus_recovery_code WHERE user_id = ?1", [&id]).map(|_| ())
    })
}

const RECOVERY_CODES: usize = 10;

fn new_codes() -> Result<Vec<String>, getrandom::Error> {
    (0..RECOVERY_CODES).map(|_| id::readable(10, 5)).collect()
}

fn replace_recovery_codes(tx: &rusqlite::Transaction, user_id: &str, hashes: &[String]) -> rusqlite::Result<()> {
    tx.execute("DELETE FROM sonus_recovery_code WHERE user_id = ?1", [user_id])?;
    for hash in hashes {
        tx.execute("INSERT OR IGNORE INTO sonus_recovery_code (user_id, code_hash) VALUES (?1, ?2)", (user_id, hash))?;
    }
    Ok(())
}

/// Recovery codes have letters, authenticator codes only digits.
fn is_recovery_code(code: &str) -> bool {
    totp::normalize(code).chars().any(|c| !c.is_ascii_digit())
}

/// Recovery codes are kept only as hashes: sha256 of the code without its dash, in small letters.
fn recovery_hash(code: &str) -> String {
    secrets::hex(&secrets::sha256(totp::normalize(code).to_lowercase().as_bytes()))
}

// ---------------------------------------------------------------- app passwords

/// One of a user's app passwords, without the password itself (shown once, when it is made).
#[derive(Debug, Clone, PartialEq)]
pub struct AppPassword {
    pub id: String,
    pub name: String,
    /// Times as they go into a JSON answer.
    pub created_at: String,
    pub last_used_at: Option<String>,
    pub last_used_by: String,
}

/// A user's app passwords, newest first.
pub fn app_passwords(db: &Db, user_id: &str) -> Result<Vec<AppPassword>, DbError> {
    db.read_blocking(|conn| {
        let mut statement =
            conn.prepare_cached("SELECT id, name, created_at, last_used_at, last_used_by FROM sonus_app_password WHERE user_id = ?1 ORDER BY created_at DESC")?;
        let rows = statement.query_map([user_id], |r| {
            let (created, used): (String, Option<String>) = (r.get(2)?, r.get(3)?);
            Ok(AppPassword {
                id: r.get(0)?,
                name: r.get(1)?,
                created_at: gotime::stored_to_json(&created).unwrap_or(created),
                last_used_at: used.and_then(|u| gotime::stored_to_json(&u)),
                last_used_by: String::from_utf8_lossy(r.get_ref(4)?.as_bytes().unwrap_or_default()).into_owned(),
            })
        })?;
        rows.collect()
    })
}

/// How long the password is: one a person types in (`abcd-efgh-jkmn-pqrs`), or a key an app was handed by the
/// browser sign-in, never typed, so longer.
#[derive(Clone, Copy)]
pub enum Kind {
    Typed,
    Handed,
}

/// Makes an app password for one client or device; the password itself is returned this once. It is an API key too.
pub fn create_app_password(db: &Db, keys: &Keys, user_id: &str, name: &str, kind: Kind) -> Result<(AppPassword, String), StoreError> {
    let password = id::readable(
        match kind {
            Kind::Typed => 16,
            Kind::Handed => 32,
        },
        4,
    )?;
    let now = Utc::now();
    let name = match name.trim() {
        "" => "App".to_string(),
        name => name.to_string(),
    };
    let made = AppPassword { id: id::new_random()?, name, created_at: gotime::to_json(&now), last_used_at: None, last_used_by: String::new() };
    let row = (
        made.id.clone(),
        user_id.to_string(),
        made.name.clone(),
        keys.seal(password.as_bytes())?,
        secrets::api_key_hash(password.as_bytes()),
        gotime::format(&now),
    );
    db.write_blocking(move |tx| {
        tx.execute("INSERT INTO sonus_app_password (id, user_id, name, secret, secret_hash, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)", row)
    })?;
    Ok((made, password))
}

/// Revokes one of the user's app passwords: false when it was not theirs or not there.
pub fn delete_app_password(db: &Db, user_id: &str, app_password_id: &str) -> Result<bool, DbError> {
    let (user, id) = (user_id.to_string(), app_password_id.to_string());
    Ok(db.write_blocking(move |tx| tx.execute("DELETE FROM sonus_app_password WHERE id = ?1 AND user_id = ?2", (&id, &user)))? == 1)
}

/// Deletes the app password that is this key: an app signing out gives its own key back. False: no such key.
pub fn revoke_api_key(db: &Db, key: &str) -> Result<bool, DbError> {
    let hash = secrets::api_key_hash(key.as_bytes());
    Ok(db.write_blocking(move |tx| tx.execute("DELETE FROM sonus_app_password WHERE secret_hash = ?1", [&hash]))? > 0)
}

/// Now, in the server's local time, for a caller that needs one clock for a whole request.
pub fn now() -> DateTime<Utc> {
    Local::now().with_timezone(&Utc)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_titled_as_go_titles_them() {
        assert_eq!(title_case("admin"), "Admin");
        assert_eq!(title_case("ADMIN"), "Admin");
        assert_eq!(title_case("mary ann-smith"), "Mary Ann-Smith");
        assert_eq!(title_case("o'neil"), "O'neil");
        assert_eq!(title_case("élodie"), "Élodie");
        assert_eq!(title_case("林夕雨"), "林夕雨");
        assert_eq!(title_case(""), "");
    }

    #[test]
    fn recovery_codes_are_told_from_authenticator_codes_and_hashed_as_typed() {
        assert!(is_recovery_code("abcde-fghjk"));
        assert!(is_recovery_code("ABCDE FGHJK"));
        assert!(!is_recovery_code("123456"));
        assert!(!is_recovery_code("123 456"));
        assert!(!is_recovery_code(""));
        assert_eq!(recovery_hash("abcde-fghjk"), recovery_hash(" ABCDE FGHJK "));
        assert_eq!(recovery_hash("abcde-fghjk"), secrets::hex(&secrets::sha256(b"abcdefghjk")));
        let codes = new_codes().unwrap();
        assert_eq!(codes.len(), 10);
        assert!(codes.iter().all(|c| c.len() == 11 && c.as_bytes()[5] == b'-'));
    }
}
