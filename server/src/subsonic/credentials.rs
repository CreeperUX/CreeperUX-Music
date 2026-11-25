//! Whether a Subsonic request's credentials are a user's: Navidrome's `validateCredentials` and the fork's
//! `checkCredentials` and `authenticateAPIKey` (`server/subsonic/middlewares.go`, `sonus_auth.go`), with the fork's
//! two-step verification store (`core/twofactor/store.go`) read straight from the database.
//!
//! The rule: a user signs with the account password (`p`, plain or `enc:` + hex, or the token `t` = md5(password ‖
//! `s`)) only where the password alone is meant to be enough: the policy is `off`, or it is `optional` and the user
//! has not set two-step verification up. Otherwise only an app password signs, in the same three forms. Everyone may
//! use an app password, as shown or without its dashes. An API key is an app password sent alone as `apiKey`, found
//! by its hash.
//!
//! With the policy `required` this is stricter than the fork on purpose: there, the account password of a user who
//! had not set two-step verification up yet still signed the API. Here it signs nothing, whether or not the user has
//! set it up, and is answered as a wrong password is.
//!
//! Where Navidrome compares secrets with `==`, this compares in constant time.
//!
//! Ported from Navidrome (GPL-3.0), © the Navidrome authors.

use chrono::Utc;
use rusqlite::{Connection, OptionalExtension};
use subtle::ConstantTimeEq;

use crate::config::TwoFactor;
use crate::db::{Db, DbError};
use crate::gotime;
use crate::secrets::{self, Keys};

/// What a user's stored secrets say about the credentials sent.
#[derive(Debug, PartialEq)]
pub enum Verdict {
    /// The account password signed (the policy lets it: see `password_alone`).
    Account,
    /// The app password at this index signed.
    AppPassword(usize),
    Invalid,
}

/// A user's secrets, opened.
pub struct Account<'a> {
    /// The account password; None when it cannot be read (it then matches nothing).
    pub password: Option<&'a [u8]>,
    /// The account password signs nothing: only app passwords do (see `password_alone`).
    pub two_factor: bool,
    pub app_passwords: &'a [Vec<u8>],
}

/// Whether the account password alone signs the Subsonic API for a user: always with the policy `off`; with
/// `optional`, until the user sets two-step verification up; with `required`, never (the web sign-in gives such a
/// user a set-up token and nothing else, and the API gives the password no more than that).
pub fn password_alone(policy: TwoFactor, confirmed: bool) -> bool {
    match policy {
        TwoFactor::Off => true,
        TwoFactor::Optional => !confirmed,
        TwoFactor::Required => false,
    }
}

/// `p` as sent: `enc:` + hex is decoded when it is hex, and taken as it is when not (as Navidrome does).
fn decode_password(pass: &[u8]) -> Vec<u8> {
    pass.strip_prefix(b"enc:").and_then(secrets::unhex).unwrap_or_else(|| pass.to_vec())
}

fn same(a: &[u8], b: &[u8]) -> bool {
    a.ct_eq(b).into()
}

/// Navidrome's `validateCredentials` without the `jwt` case: `p` when sent, else `t` with `s`.
fn matches_account(password: &[u8], pass: &[u8], token: &[u8], salt: &[u8]) -> bool {
    if !pass.is_empty() {
        same(&decode_password(pass), password)
    } else if !token.is_empty() {
        same(secrets::subsonic_token(password, salt).as_bytes(), token)
    } else {
        false
    }
}

/// The fork's `checkCredentials`, for `p`, `t` and `s` as the request has them (empty when not sent).
pub fn check(account: &Account, pass: &[u8], token: &[u8], salt: &[u8]) -> Verdict {
    if !account.two_factor && account.password.is_some_and(|password| matches_account(password, pass, token, salt)) {
        return Verdict::Account;
    }
    let pass = decode_password(pass);
    if pass.is_empty() && token.is_empty() {
        return Verdict::Invalid;
    }
    let matches = |password: &[u8]| {
        if !pass.is_empty() { same(&pass, password) } else { same(secrets::subsonic_token(password, salt).as_bytes(), token) }
    };
    for (index, password) in account.app_passwords.iter().enumerate() {
        let undashed: Vec<u8> = password.iter().copied().filter(|b| *b != b'-').collect();
        if matches(password) || matches(&undashed) {
            return Verdict::AppPassword(index);
        }
    }
    Verdict::Invalid
}

/// Who signed a request.
#[derive(Debug, PartialEq)]
pub struct SignedIn {
    pub user_id: String,
    /// The user's name as the database has it.
    pub user_name: String,
}

struct StoredAppPassword {
    id: String,
    sealed: String,
    last_used_at: Option<String>,
    last_used_by: Vec<u8>,
}

/// What a request sent to sign itself with a user name: `p`, `t`, `s` (empty when not sent), and `c`, the client's
/// name, noted with an app password's use.
pub struct Sent {
    pub pass: Vec<u8>,
    pub token: Vec<u8>,
    pub salt: Vec<u8>,
    pub client: Vec<u8>,
}

/// The user `username` names with these credentials, None when there is no such user or they are not theirs.
/// Blocking. An app password's use is noted as Navidrome notes it.
pub fn user_with_password(db: &Db, keys: &Keys, policy: TwoFactor, username: &str, sent: &Sent) -> Result<Option<SignedIn>, DbError> {
    let Sent { pass, token, salt, client } = sent;
    let found = db.read_blocking(|conn| {
        // Navidrome's FindByUsername: the name in any (ASCII) case
        let user: Option<(String, String, String)> = conn
            .query_row("SELECT id, user_name, password FROM user WHERE user_name = ?1 COLLATE NOCASE ORDER BY id LIMIT 1", [username], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })
            .optional()?;
        let Some((id, user_name, sealed_password)) = user else { return Ok(None) };
        let two_factor = !password_alone(policy, two_factor_confirmed(conn, &id)?);
        let app_passwords = app_passwords_of(conn, &id)?;
        Ok(Some((id, user_name, sealed_password, two_factor, app_passwords)))
    })?;
    let Some((user_id, user_name, sealed_password, two_factor, stored)) = found else { return Ok(None) };

    // Navidrome leaves a password it cannot decrypt as its ciphertext and compares that; here it matches nothing
    let password = keys.open(&sealed_password).ok();
    // an app password that cannot be read cannot match (Navidrome skips it too): kept in place so indexes line up
    let opened: Vec<Option<Vec<u8>>> = stored.iter().map(|ap| keys.open(&ap.sealed).ok()).collect();
    let readable: Vec<Vec<u8>> = opened.iter().flatten().cloned().collect();
    let account = Account { password: password.as_deref(), two_factor, app_passwords: &readable };
    match check(&account, pass, token, salt) {
        Verdict::Invalid => Ok(None),
        Verdict::Account => Ok(Some(SignedIn { user_id, user_name })),
        Verdict::AppPassword(index) => {
            let used = stored.iter().zip(&opened).filter(|(_, plain)| plain.is_some()).nth(index).map(|(ap, _)| ap);
            if let Some(used) = used {
                note_use(db, used, client);
            }
            Ok(Some(SignedIn { user_id, user_name }))
        }
    }
}

/// The user an API key belongs to, None when it is no one's. Blocking; the use is noted.
pub fn user_with_api_key(db: &Db, key: &[u8], client: &[u8]) -> Result<Option<SignedIn>, DbError> {
    let hash = secrets::api_key_hash(key);
    let found = db.read_blocking(|conn| {
        conn.query_row(
            "SELECT ap.id, ap.last_used_at, ap.last_used_by, u.id, u.user_name FROM sonus_app_password ap JOIN user u ON u.id = ap.user_id \
             WHERE ap.secret_hash = ?1 LIMIT 1",
            [&hash],
            |r| {
                let stored = StoredAppPassword { id: r.get(0)?, sealed: String::new(), last_used_at: r.get(1)?, last_used_by: text_bytes(r, 2)? };
                Ok((stored, SignedIn { user_id: r.get(3)?, user_name: r.get(4)? }))
            },
        )
        .optional()
    })?;
    Ok(found.map(|(stored, user)| {
        note_use(db, &stored, client);
        user
    }))
}

fn two_factor_confirmed(conn: &Connection, user_id: &str) -> rusqlite::Result<bool> {
    let n: i64 = conn.query_row("SELECT count(*) FROM sonus_two_factor WHERE user_id = ?1 AND confirmed_at IS NOT NULL", [user_id], |r| r.get(0))?;
    Ok(n > 0)
}

fn app_passwords_of(conn: &Connection, user_id: &str) -> rusqlite::Result<Vec<StoredAppPassword>> {
    let mut statement = conn.prepare_cached("SELECT id, secret, last_used_at, last_used_by FROM sonus_app_password WHERE user_id = ?1")?;
    let rows = statement
        .query_map([user_id], |r| Ok(StoredAppPassword { id: r.get(0)?, sealed: r.get(1)?, last_used_at: r.get(2)?, last_used_by: text_bytes(r, 3)? }))?;
    rows.collect()
}

/// A text column's bytes: Navidrome stores what clients send (`c`) as it came, valid UTF-8 or not.
fn text_bytes(row: &rusqlite::Row, index: usize) -> rusqlite::Result<Vec<u8>> {
    Ok(match row.get_ref(index)? {
        rusqlite::types::ValueRef::Text(bytes) | rusqlite::types::ValueRef::Blob(bytes) => bytes.to_vec(),
        _ => Vec::new(),
    })
}

/// Navidrome's `noteUse`: who used an app password and when, written at most every five minutes per client name
/// (clients sign every request). A failure to note it fails nothing, as there.
fn note_use(db: &Db, used: &StoredAppPassword, client: &[u8]) {
    let now = Utc::now();
    let recent = used.last_used_at.as_deref().and_then(gotime::parse).is_some_and(|at| now.signed_duration_since(at) <= chrono::Duration::minutes(5));
    if recent && used.last_used_by == client {
        return;
    }
    let (at, by, id) = (gotime::format(&now), String::from_utf8_lossy(client).into_owned(), used.id.clone());
    let noted = db.write_blocking(move |tx| tx.execute("UPDATE sonus_app_password SET last_used_at = ?1, last_used_by = ?2 WHERE id = ?3", (&at, &by, &id)));
    if let Err(e) = noted {
        tracing::debug!(error = %e, "could not note an app password's use");
    }
}

/// Gives app passwords made before API keys their hash, so they work as API keys too (the fork's `fillHashes`, which
/// its store runs when first used; with sign-ins checked here, that may be never). Blocking; returns how many.
pub fn fill_key_hashes(db: &Db, keys: &Keys) -> Result<usize, DbError> {
    let todo: Vec<(String, String)> = db.read_blocking(|conn| {
        conn.prepare("SELECT id, secret FROM sonus_app_password WHERE secret_hash = ''")?.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect()
    })?;
    let hashed: Vec<(String, String)> =
        todo.into_iter().filter_map(|(id, sealed)| keys.open(&sealed).ok().map(|password| (id, secrets::api_key_hash(&password)))).collect();
    if hashed.is_empty() {
        return Ok(0);
    }
    db.write_blocking(move |tx| {
        let mut done = 0;
        for (id, hash) in &hashed {
            done += tx.execute("UPDATE sonus_app_password SET secret_hash = ?1 WHERE id = ?2 AND secret_hash = ''", (hash, id))?;
        }
        Ok(done)
    })
}

/// Navidrome's `UpdateLastAccessAt` (`time.Now()`, in the server's local time). Blocking.
pub fn touch_last_access(db: &Db, user_id: &str) -> Result<(), DbError> {
    let (now, id) = (gotime::now_local(), user_id.to_string());
    db.write_blocking(move |tx| tx.execute("UPDATE user SET last_access_at = ?1 WHERE id = ?2", (&now, &id)).map(|_| ()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const APP: &[u8] = b"abcd-efgh-jkmn-pqrs";

    fn token(password: &[u8], salt: &[u8]) -> Vec<u8> {
        secrets::subsonic_token(password, salt).into_bytes()
    }

    fn enc(password: &[u8]) -> Vec<u8> {
        format!("enc:{}", secrets::hex(password)).into_bytes()
    }

    fn account<'a>(two_factor: bool, app_passwords: &'a [Vec<u8>]) -> Account<'a> {
        Account { password: Some(b"sesame"), two_factor, app_passwords }
    }

    #[test]
    fn the_account_password_signs_in_three_forms() {
        let a = account(false, &[]);
        assert_eq!(check(&a, b"sesame", b"", b""), Verdict::Account);
        assert_eq!(check(&a, &enc(b"sesame"), b"", b""), Verdict::Account);
        assert_eq!(check(&a, b"", &token(b"sesame", b"c19b2d"), b"c19b2d"), Verdict::Account);
        assert_eq!(check(&a, b"", b"26719a1196d2a940705a59634eb18eab", b"c19b2d"), Verdict::Account, "the Subsonic API's own example");
    }

    #[test]
    fn wrong_credentials_sign_nothing() {
        let a = account(false, &[]);
        assert_eq!(check(&a, b"Sesame", b"", b""), Verdict::Invalid);
        assert_eq!(check(&a, b"", &token(b"sesame", b"salt"), b"other"), Verdict::Invalid);
        assert_eq!(check(&a, b"", b"26719A1196D2A940705A59634EB18EAB", b"c19b2d"), Verdict::Invalid, "tokens are lowercase hex, as Navidrome compares them");
        assert_eq!(check(&a, b"", b"", b""), Verdict::Invalid, "u alone");
        assert_eq!(check(&a, b"", b"", b"salt"), Verdict::Invalid);
        assert_eq!(check(&a, b"enc:736573616d", b"", b""), Verdict::Invalid, "bad hex is taken as it is");
        let unreadable = Account { password: None, two_factor: false, app_passwords: &[] };
        assert_eq!(check(&unreadable, b"sesame", b"", b""), Verdict::Invalid);
        assert_eq!(check(&unreadable, b"", &token(b"", b"s"), b"s"), Verdict::Invalid);
    }

    #[test]
    fn p_wins_over_t_as_in_navidrome() {
        let a = account(false, &[]);
        assert_eq!(check(&a, b"wrong", &token(b"sesame", b"s"), b"s"), Verdict::Invalid, "with p sent, the token is not looked at");
        assert_eq!(check(&a, b"sesame", b"not-a-token", b"s"), Verdict::Account);
    }

    #[test]
    fn with_two_step_verification_the_account_password_opens_nothing() {
        let apps = [APP.to_vec()];
        let a = account(true, &apps);
        assert_eq!(check(&a, b"sesame", b"", b""), Verdict::Invalid);
        assert_eq!(check(&a, &enc(b"sesame"), b"", b""), Verdict::Invalid);
        assert_eq!(check(&a, b"", &token(b"sesame", b"s"), b"s"), Verdict::Invalid);
        assert_eq!(check(&account(true, &[]), b"sesame", b"", b""), Verdict::Invalid, "nor without any app password");
    }

    #[test]
    fn the_password_alone_signs_only_where_the_policy_means_it_to() {
        assert!(password_alone(TwoFactor::Off, false) && password_alone(TwoFactor::Off, true));
        assert!(password_alone(TwoFactor::Optional, false) && !password_alone(TwoFactor::Optional, true));
        assert!(!password_alone(TwoFactor::Required, true));
        assert!(!password_alone(TwoFactor::Required, false), "required: not before the user has set it up either");
    }

    #[test]
    fn an_app_password_signs_in_three_forms_with_or_without_dashes() {
        let apps = [b"zzzz-zzzz-zzzz-zzzz".to_vec(), APP.to_vec()];
        for two_factor in [true, false] {
            let a = account(two_factor, &apps);
            assert_eq!(check(&a, APP, b"", b""), Verdict::AppPassword(1));
            assert_eq!(check(&a, b"abcdefghjkmnpqrs", b"", b""), Verdict::AppPassword(1));
            assert_eq!(check(&a, &enc(APP), b"", b""), Verdict::AppPassword(1));
            assert_eq!(check(&a, &enc(b"abcdefghjkmnpqrs"), b"", b""), Verdict::AppPassword(1));
            assert_eq!(check(&a, b"", &token(APP, b"s"), b"s"), Verdict::AppPassword(1));
            assert_eq!(check(&a, b"", &token(b"abcdefghjkmnpqrs", b"s"), b"s"), Verdict::AppPassword(1));
            assert_eq!(check(&a, b"abcd-efgh-jkmn-pqrx", b"", b""), Verdict::Invalid);
            assert_eq!(check(&a, b"ABCD-EFGH-JKMN-PQRS", b"", b""), Verdict::Invalid, "as a password it is case-sensitive");
            assert_eq!(check(&a, b"abcdefgh-jkmnpqrs", b"", b""), Verdict::Invalid, "all its dashes or none");
        }
    }

    #[test]
    fn an_empty_account_password_is_navidromes_edge_case() {
        // Navidrome: with p= (empty) nothing is compared; a token of the empty password is valid; enc: of nothing too
        let a = Account { password: Some(b""), two_factor: false, app_passwords: &[] };
        assert_eq!(check(&a, b"", b"", b""), Verdict::Invalid);
        assert_eq!(check(&a, b"", &token(b"", b"s"), b"s"), Verdict::Account);
        assert_eq!(check(&a, b"enc:", b"", b""), Verdict::Account);
    }
}
