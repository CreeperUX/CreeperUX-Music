//! The `/auth` routes answered by the gateway, against a database made as the frozen Navidrome makes it and a fake
//! Navidrome that must never be asked: the cases of Navidrome's `server/auth_test.go` and the fork's
//! `sonus_twofactor_test.go` and `core/twofactor/twofactor_test.go`, and what is this server's own (everything under
//! `/auth` answered here, the rate limit, the body limit).

mod common;

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use common::database;
use common::*;
use hyper::body::Incoming;
use hyper::header::{self, HeaderMap};
use hyper::{Method, Request, Response, StatusCode};
use rusqlite::Connection;
use serde_json::{Value, json};
use sonus_server::auth::{Auth, Setup, totp};
use sonus_server::config::TwoFactor;
use sonus_server::db::Db;
use sonus_server::jwt::{Claims, Signer};
use sonus_server::secrets::Keys;

const KEY: &str = "the test's encryption key";
const SECRET: &str = "the test's session secret";

struct Options {
    policy: TwoFactor,
    limit: i64,
    window: Duration,
    trusted: &'static str,
    base_path: &'static str,
    auto_login: &'static str,
    /// No users at all: a new server.
    empty: bool,
}

impl Default for Options {
    fn default() -> Self {
        Options { policy: TwoFactor::Required, limit: 0, window: Duration::from_secs(20), trusted: "", base_path: "", auto_login: "", empty: false }
    }
}

struct World {
    gateway: SocketAddr,
    /// How many requests reached the fake Navidrome.
    reached: Arc<AtomicUsize>,
    database: PathBuf,
    dir: PathBuf,
    base: &'static str,
}

impl Drop for World {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

static WORLDS: AtomicUsize = AtomicUsize::new(0);

/// The users: alice (a plain user), root (an admin).
async fn world(options: Options) -> World {
    let dir = std::env::temp_dir().join(format!("sonus-auth-test-{}-{}", std::process::id(), WORLDS.fetch_add(1, Ordering::Relaxed)));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("navidrome.db");
    let keys = Keys::new(KEY);
    let conn = database::create(&file);
    database::set_session_secret(&conn, &keys, SECRET);
    if !options.empty {
        database::add_user(&conn, &keys, "alice", "sesame");
        let root = database::add_user(&conn, &keys, "root", "toor");
        conn.execute("UPDATE user SET is_admin = 1 WHERE id = ?1", [&root]).unwrap();
    }
    drop(conn);

    let reached = Arc::new(AtomicUsize::new(0));
    let counter = reached.clone();
    let navidrome = upstream(move |_req: Request<Incoming>| {
        counter.fetch_add(1, Ordering::SeqCst);
        async { Response::new(full("from navidrome")) }
    })
    .await;
    let auth = Auth::new(Setup {
        db: Db::open(&file).unwrap(),
        keys,
        two_factor: options.policy,
        signer: Signer::new(SECRET.as_bytes()),
        session_timeout: Duration::from_secs(3600),
        limit: options.limit,
        window: options.window,
        base_path: options.base_path.into(),
        frame_options: "DENY".into(),
        enable_gravatar: false,
        auto_login: options.auto_login.into(),
    });
    let setup = GatewaySetup { trusted: options.trusted, base_path: options.base_path, checks_sign_ins: true, auth: Some(auth), ..GatewaySetup::default() };
    let (gateway, _) = gateway(navidrome, setup).await;
    World { gateway, reached, database: file, dir, base: options.base_path }
}

fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() as i64
}

type Answer = (StatusCode, HeaderMap, Value);

impl World {
    async fn send(&self, request: Request<TestBody>) -> Answer {
        let response = send(self.gateway, request).await;
        let (status, headers) = (response.status(), response.headers().clone());
        let bytes = body_bytes(response.into_body()).await;
        let body = serde_json::from_slice(&bytes).unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into_owned()));
        (status, headers, body)
    }

    /// A JSON request under `/auth`, signed with a session token when one is given.
    async fn call(&self, method: Method, path: &str, body: Option<Value>, token: &str) -> Answer {
        let mut request = Request::builder().method(method).uri(format!("{}/auth{path}", self.base));
        if !token.is_empty() {
            request = request.header("X-ND-Authorization", format!("Bearer {token}"));
        }
        let body = match body {
            Some(body) => full(body.to_string()),
            None => empty(),
        };
        self.send(request.body(body).unwrap()).await
    }

    async fn post(&self, path: &str, body: Value, token: &str) -> Answer {
        self.call(Method::POST, path, Some(body), token).await
    }

    async fn get(&self, path: &str, token: &str) -> Answer {
        self.call(Method::GET, path, None, token).await
    }

    async fn sign_in(&self, user: &str, password: &str, otp: &str) -> Answer {
        self.post("/login", json!({ "username": user, "password": password, "otp": otp }), "").await
    }

    /// Goes through alice's first sign-in: the setup token, the secret, the confirmed code. The secret, the session
    /// and the recovery codes.
    async fn set_up(&self, user: &str, password: &str) -> (String, String, Vec<String>) {
        let (status, _, body) = self.sign_in(user, password, "").await;
        assert_eq!((status, &body["twoFactor"]), (StatusCode::UNAUTHORIZED, &json!("setup")), "{body}");
        let token = body["setupToken"].as_str().unwrap().to_string();
        let (status, _, body) = self.post("/2fa/setup", json!({ "token": token }), "").await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let secret = body["secret"].as_str().unwrap().to_string();
        assert!(body["qr"].as_str().unwrap().starts_with("data:image/png;base64,"));
        assert_eq!(body["issuer"], "Sonus");
        assert_eq!(body["account"], user);
        assert!(body["uri"].as_str().unwrap().starts_with("otpauth://totp/Sonus:") && body["uri"].as_str().unwrap().contains(&secret));
        let (status, _, body) = self.post("/2fa/confirm", json!({ "token": token, "code": totp::code(&secret, now()).unwrap() }), "").await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert!(body.get("subsonicToken").is_none() && body.get("subsonicSalt").is_none(), "no password-derived token with two-step verification");
        let codes = body["recoveryCodes"].as_array().unwrap().iter().map(|c| c.as_str().unwrap().to_string()).collect();
        (secret, body["token"].as_str().unwrap().to_string(), codes)
    }

    fn db(&self) -> Connection {
        Connection::open(&self.database).unwrap()
    }
}

/// A code not used yet: the following step's (accepted, as clocks drift).
fn next_code(secret: &str) -> String {
    totp::code(secret, now() + 30).unwrap()
}

fn error(body: &Value) -> &str {
    body["error"].as_str().unwrap_or("")
}

fn token_for(claims: Claims) -> String {
    Signer::new(SECRET.as_bytes()).sign(&claims)
}

fn session_claims(user: &str, epoch: i64) -> Claims {
    Claims {
        issuer: "ND".into(),
        subject: user.into(),
        issued_at: now() - 5,
        expires_at: now() + 600,
        user_id: format!("id-{}", user.to_lowercase()),
        epoch,
        ..Claims::default()
    }
}

// ---------------------------------------------------------------- the sign-in (server/auth_test.go)

#[tokio::test]
async fn login_fails_for_an_unknown_user_a_wrong_password_and_a_bad_body() {
    let w = world(Options { policy: TwoFactor::Optional, ..Options::default() }).await;
    let (status, headers, body) = w.sign_in("janedoe", "abc123", "").await;
    assert_eq!((status, error(&body)), (StatusCode::UNAUTHORIZED, "Invalid username or password"));
    assert_eq!(headers["content-type"], "application/json");
    assert!(body.get("twoFactor").is_none());
    let (status, _, body) = w.sign_in("alice", "nope", "").await;
    assert_eq!((status, error(&body)), (StatusCode::UNAUTHORIZED, "Invalid username or password"));

    for bad in ["", "{", "[]", "\"alice\"", r#"{"username":"alice","password":123}"#] {
        let (status, _, body) = w.send(Request::post("/auth/login").body(full(bad)).unwrap()).await;
        assert_eq!((status, error(&body)), (StatusCode::UNPROCESSABLE_ENTITY, "invalid request payload"), "{bad}");
    }
    // a body larger than the limit (8 KB) is not read whole: the same refusal
    let padded = json!({ "username": "alice", "password": "sesame", "padding": "x".repeat(8 << 10) });
    let (status, _, _) = w.post("/login", padded, "").await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(w.reached.load(Ordering::SeqCst), 0, "Navidrome is never asked");
}

#[tokio::test]
async fn login_signs_a_user_in_with_what_the_web_ui_needs() {
    let w = world(Options { policy: TwoFactor::Optional, ..Options::default() }).await;
    let (status, _, body) = w.sign_in("ALICE", "sesame", "").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!((&body["id"], &body["username"], &body["name"], &body["isAdmin"]), (&json!("id-alice"), &json!("alice"), &json!("alice"), &json!(false)));
    // the Subsonic token the web UI signs its calls with: md5(password + salt)
    let salt = body["subsonicSalt"].as_str().unwrap();
    assert_eq!(salt.len(), 6);
    assert_eq!(body["subsonicToken"], sonus_server::secrets::subsonic_token(b"sesame", salt.as_bytes()));
    assert!(body.get("avatar").is_none());
    // a session token as Navidrome makes them
    let claims = Signer::new(SECRET.as_bytes()).verify(body["token"].as_str().unwrap(), now()).unwrap();
    assert_eq!(
        (claims.issuer.as_str(), claims.subject.as_str(), claims.user_id.as_str(), claims.is_admin, claims.epoch),
        ("ND", "alice", "id-alice", false, 0)
    );
    assert!(claims.audience.is_empty());
    assert!((3590..=3600).contains(&(claims.expires_at - now())), "SessionTimeout from now");
    // the sign-in is noted
    let last: Option<String> = w.db().query_row("SELECT last_login_at FROM user WHERE user_name = 'alice'", [], |r| r.get(0)).unwrap();
    assert!(last.is_some_and(|at| sonus_server::gotime::parse(&at).is_some()));
    let (_, _, body) = w.sign_in("root", "toor", "").await;
    let claims = Signer::new(SECRET.as_bytes()).verify(body["token"].as_str().unwrap(), now()).unwrap();
    assert!(body["isAdmin"] == true && claims.is_admin);
}

#[tokio::test]
async fn create_admin_makes_the_first_user_only() {
    let w = world(Options { policy: TwoFactor::Off, empty: true, ..Options::default() }).await;
    let (status, _, body) = w.post("/createAdmin", json!({ "username": "johndoe", "password": "secret" }), "").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!((&body["isAdmin"], &body["username"], &body["name"]), (&json!(true), &json!("johndoe"), &json!("Johndoe")));
    assert_eq!(body["id"].as_str().unwrap().len(), 22);
    assert!(!body["token"].as_str().unwrap().is_empty());

    let (is_admin, sealed, last_login, created): (bool, String, Option<String>, String) = w
        .db()
        .query_row("SELECT is_admin, password, last_login_at, created_at FROM user WHERE user_name = 'johndoe'", [], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })
        .unwrap();
    assert!(is_admin && last_login.is_some());
    assert_eq!(Keys::new(KEY).open(&sealed).unwrap(), b"secret", "sealed as Navidrome seals passwords");
    assert!(sonus_server::gotime::parse(&created).is_some());
    let libraries: i64 =
        w.db().query_row("SELECT count(*) FROM user_library ul JOIN user u ON u.id = ul.user_id WHERE u.user_name = 'johndoe'", [], |r| r.get(0)).unwrap();
    assert_eq!(libraries, 1, "an admin has every library");
    // the password signs in
    assert_eq!(w.sign_in("johndoe", "secret", "").await.0, StatusCode::OK);

    // there is a user now: no second first admin
    let (status, _, body) = w.post("/createAdmin", json!({ "username": "mallory", "password": "x" }), "").await;
    assert_eq!((status, error(&body)), (StatusCode::FORBIDDEN, "Cannot create another first admin"));
    let users: i64 = w.db().query_row("SELECT count(*) FROM user", [], |r| r.get(0)).unwrap();
    assert_eq!(users, 1);
    let (status, _, _) = w.send(Request::post("/auth/createAdmin").body(full("nonsense")).unwrap()).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
}

#[tokio::test]
async fn two_first_admins_at_once_make_one() {
    let w = Arc::new(world(Options { policy: TwoFactor::Off, empty: true, ..Options::default() }).await);
    let attempts: Vec<_> = (0..8)
        .map(|i| {
            let w = w.clone();
            tokio::spawn(async move { w.post("/createAdmin", json!({ "username": format!("admin{i}"), "password": "secret" }), "").await.0 })
        })
        .collect();
    let mut made = 0;
    for attempt in attempts {
        match attempt.await.unwrap() {
            StatusCode::OK => made += 1,
            status => assert_eq!(status, StatusCode::FORBIDDEN),
        }
    }
    assert_eq!(made, 1);
    assert_eq!(w.db().query_row("SELECT count(*) FROM user", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
}

// ---------------------------------------------------------------- two-step verification (sonus_twofactor_test.go)

#[tokio::test]
async fn the_user_sets_it_up_at_the_first_sign_in_then_is_signed_in_with_recovery_codes_to_keep() {
    let w = world(Options::default()).await;
    let (secret, session, recovery) = w.set_up("alice", "sesame").await;
    assert_eq!(recovery.len(), 10);
    assert!(recovery.iter().all(|c| c.len() == 11 && c.as_bytes()[5] == b'-'));
    let (status, _, body) = w.get("/2fa", &session).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!((&body["mode"], &body["enabled"], &body["recoveryCodesLeft"]), (&json!("required"), &json!(true), &json!(10)));
    assert!(body["enabledAt"].as_str().unwrap().ends_with('Z'));
    // the secret is sealed in the database
    let sealed: String = w.db().query_row("SELECT secret FROM sonus_two_factor WHERE user_id = 'id-alice'", [], |r| r.get(0)).unwrap();
    assert!(!sealed.contains(&secret));
    assert_eq!(Keys::new(KEY).open(&sealed).unwrap(), secret.as_bytes());
}

#[tokio::test]
async fn the_setup_token_opens_nothing_else_and_gives_no_session_before_the_code() {
    let w = world(Options::default()).await;
    let (_, _, body) = w.sign_in("alice", "sesame", "").await;
    assert!(body.get("token").is_none());
    let setup_token = body["setupToken"].as_str().unwrap().to_string();
    let claims = Signer::new(SECRET.as_bytes()).verify(&setup_token, now()).unwrap();
    assert_eq!(claims.audience, ["sonus-2fa-setup"]);
    assert!((890..=900).contains(&(claims.expires_at - now())), "fifteen minutes");
    // nothing is being set up yet
    let (status, _, body) = w.post("/2fa/confirm", json!({ "token": setup_token, "code": "123456" }), "").await;
    assert_eq!((status, error(&body)), (StatusCode::CONFLICT, "No two-step verification being set up"));
    // no signed-in route takes it
    for path in ["/2fa", "/app-passwords", "/device/BCDF-GHJK"] {
        assert_eq!(w.get(path, &setup_token).await.0, StatusCode::UNAUTHORIZED, "{path}");
    }
    assert_eq!(w.post("/app-passwords", json!({ "name": "x" }), &setup_token).await.0, StatusCode::UNAUTHORIZED);
    // the setup routes want a token
    for body in [json!({}), json!({ "token": "" }), json!({ "token": "not.a.token" })] {
        let (status, _, answer) = w.post("/2fa/setup", body, "").await;
        assert_eq!((status, error(&answer)), (StatusCode::UNAUTHORIZED, "Not authenticated"));
    }
    // a wrong code while setting up
    assert_eq!(w.post("/2fa/setup", json!({ "token": setup_token }), "").await.0, StatusCode::OK);
    let (status, _, body) = w.post("/2fa/confirm", json!({ "token": setup_token, "code": "000000" }), "").await;
    assert_eq!((status, &body["twoFactor"], error(&body)), (StatusCode::UNAUTHORIZED, &json!("setup"), "Invalid verification code"));
    let enabled: i64 = w.db().query_row("SELECT count(*) FROM sonus_two_factor WHERE confirmed_at IS NOT NULL", [], |r| r.get(0)).unwrap();
    assert_eq!(enabled, 0, "off until a code from the new secret is confirmed");
}

#[tokio::test]
async fn then_a_code_at_every_sign_in_each_code_once_or_a_recovery_code() {
    let w = world(Options::default()).await;
    let (secret, _, recovery) = w.set_up("alice", "sesame").await;
    let (status, _, body) = w.sign_in("alice", "sesame", "").await;
    assert_eq!((status, &body["twoFactor"], error(&body)), (StatusCode::UNAUTHORIZED, &json!("code"), "Verification code required"));
    let (status, _, body) = w.sign_in("alice", "sesame", "000000").await;
    assert_eq!((status, &body["twoFactor"], error(&body)), (StatusCode::UNAUTHORIZED, &json!("code"), "Invalid verification code"));

    let next = next_code(&secret);
    let (status, _, body) = w.sign_in("alice", "sesame", &format!("{} {}", &next[..3], &next[3..])).await;
    assert_eq!(status, StatusCode::OK, "as people type it: {body}");
    assert!(!body["token"].as_str().unwrap().is_empty() && body.get("subsonicToken").is_none());
    assert_eq!(w.sign_in("alice", "sesame", &next).await.0, StatusCode::UNAUTHORIZED, "each code once");
    // the code confirmed at the setup was used by it
    assert_eq!(w.sign_in("alice", "sesame", &totp::code(&secret, now()).unwrap()).await.0, StatusCode::UNAUTHORIZED);

    assert_eq!(w.sign_in("alice", "sesame", &recovery[0].to_uppercase()).await.0, StatusCode::OK, "a recovery code, in capitals");
    assert_eq!(w.sign_in("alice", "sesame", &recovery[0]).await.0, StatusCode::UNAUTHORIZED, "once");
    assert_eq!(w.sign_in("root", "toor", &recovery[1]).await.2["twoFactor"], "setup", "someone else's code is nobody's");
    let (_, _, body) = w.sign_in("alice", "sesame", &recovery[1]).await;
    let session = body["token"].as_str().unwrap();
    assert_eq!(w.get("/2fa", session).await.2["recoveryCodesLeft"], 8);

    // the wrong password is refused before anything else
    let (status, _, body) = w.sign_in("alice", "nope", &recovery[2]).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert!(body.get("twoFactor").is_none());
    assert_eq!(w.get("/2fa", session).await.2["recoveryCodesLeft"], 8, "and uses no recovery code up");
}

#[tokio::test]
async fn off_or_optional_and_not_set_up_signs_in_as_navidrome_does() {
    let optional = world(Options { policy: TwoFactor::Optional, ..Options::default() }).await;
    let (status, _, body) = optional.sign_in("alice", "sesame", "").await;
    assert_eq!(status, StatusCode::OK);
    assert!(body["subsonicToken"].is_string());
    let session = body["token"].as_str().unwrap().to_string();
    assert_eq!(optional.get("/2fa", &session).await.2, json!({ "mode": "optional", "enabled": false, "recoveryCodesLeft": 0 }));

    // optional: each user turns it on (with their session as the setup token) and off again
    let (status, _, body) = optional.post("/2fa/setup", json!({}), &session).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let secret = body["secret"].as_str().unwrap().to_string();
    let (status, _, body) = optional.post("/2fa/confirm", json!({ "code": totp::code(&secret, now()).unwrap() }), &session).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let recovery = body["recoveryCodes"][0].as_str().unwrap().to_string();
    assert_eq!(optional.sign_in("alice", "sesame", "").await.2["twoFactor"], "code");
    // the sessions from before it was on have ended (one may be someone else's, opened with the password alone);
    // the one that turned it on goes on with the token it was answered
    assert_eq!(optional.get("/2fa", &session).await.0, StatusCode::UNAUTHORIZED);
    let session = body["token"].as_str().unwrap().to_string();
    assert_eq!(optional.get("/2fa", &session).await.2["enabled"], true);
    // replacing the authenticator takes a code from the one in use
    let (status, _, body) = optional.post("/2fa/setup", json!({ "code": "000000" }), &session).await;
    assert_eq!((status, &body["twoFactor"]), (StatusCode::UNAUTHORIZED, &json!("code")));
    assert_eq!(optional.post("/2fa/setup", json!({ "code": next_code(&secret) }), &session).await.0, StatusCode::OK);
    // turning it off takes a code too
    assert_eq!(optional.post("/2fa/disable", json!({ "code": "000000" }), &session).await.0, StatusCode::UNAUTHORIZED);
    assert_eq!(optional.post("/2fa/disable", json!({ "code": recovery }), &session).await.0, StatusCode::NO_CONTENT);
    assert_eq!(optional.sign_in("alice", "sesame", "").await.0, StatusCode::OK);
    assert_eq!(optional.get("/2fa", &session).await.2, json!({ "mode": "optional", "enabled": false, "recoveryCodesLeft": 0 }));

    // off: neither asked nor checked, and nothing to set up
    let off = world(Options { policy: TwoFactor::Off, ..Options::default() }).await;
    database::add_two_factor(&off.db(), "id-alice", true);
    let (status, _, body) = off.sign_in("alice", "sesame", "").await;
    assert_eq!(status, StatusCode::OK);
    assert!(body["subsonicToken"].is_string(), "off: as before two-step verification");
    let session = body["token"].as_str().unwrap().to_string();
    let (status, _, body) = off.post("/2fa/setup", json!({}), &session).await;
    assert_eq!((status, error(&body)), (StatusCode::FORBIDDEN, "Two-step verification is turned off on this server"));
    assert_eq!(off.get("/2fa", &session).await.2["mode"], "off");
}

#[tokio::test]
async fn a_signed_in_user_manages_app_passwords_and_recovery_codes() {
    let w = world(Options::default()).await;
    let (_, session, recovery) = w.set_up("alice", "sesame").await;

    let (status, _, body) = w.post("/app-passwords", json!({ "name": " 书房电脑 " }), &session).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let password = body["password"].as_str().unwrap().to_string();
    assert_eq!(password.len(), 19);
    assert!(password.split('-').all(|g| g.len() == 4 && g.bytes().all(|b| b"abcdefghjkmnpqrstuvwxyz23456789".contains(&b))), "{password}");
    let made = &body["appPassword"];
    assert_eq!(made["name"], "书房电脑");
    assert!(made.get("lastUsedAt").is_none() && made.get("lastUsedBy").is_none());
    let id = made["id"].as_str().unwrap().to_string();
    // sealed and hashed as the fork's store does: it is an API key too
    let (sealed, hash): (String, String) =
        w.db().query_row("SELECT secret, secret_hash FROM sonus_app_password WHERE id = ?1", [&id], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
    assert_eq!(Keys::new(KEY).open(&sealed).unwrap(), password.as_bytes());
    assert_eq!(hash, sonus_server::secrets::api_key_hash(password.replace('-', "").to_uppercase().as_bytes()));

    assert_eq!(w.post("/app-passwords", json!({ "name": "" }), &session).await.2["appPassword"]["name"], "App", "no name");
    let long = w.post("/app-passwords", json!({ "name": "长".repeat(100) }), &session).await.2;
    assert_eq!(long["appPassword"]["name"].as_str().unwrap().chars().count(), 64);
    let (status, _, list) = w.get("/app-passwords", &session).await;
    assert_eq!(status, StatusCode::OK);
    let list = list.as_array().unwrap();
    assert_eq!(list.len(), 3);
    assert!(list.iter().any(|ap| ap["id"] == id.as_str() && ap["name"] == "书房电脑" && ap["createdAt"].as_str().unwrap().ends_with('Z')));
    assert!(list.iter().all(|ap| ap.get("password").is_none() && ap.get("secret").is_none()), "the password is shown once, when made");

    // new recovery codes take a code
    let (status, _, body) = w.post("/2fa/recovery-codes", json!({ "code": "000000" }), &session).await;
    assert_eq!((status, &body["twoFactor"]), (StatusCode::UNAUTHORIZED, &json!("code")));
    let (status, _, body) = w.post("/2fa/recovery-codes", json!({ "code": recovery[0] }), &session).await;
    assert_eq!(status, StatusCode::OK);
    let fresh: Vec<&str> = body["recoveryCodes"].as_array().unwrap().iter().map(|c| c.as_str().unwrap()).collect();
    assert_eq!(fresh.len(), 10);
    assert_eq!(w.sign_in("alice", "sesame", &recovery[1]).await.0, StatusCode::UNAUTHORIZED, "the old ones stop working");
    assert_eq!(w.sign_in("alice", "sesame", fresh[0]).await.0, StatusCode::OK);

    // required here: it cannot be turned off
    let (status, _, body) = w.post("/2fa/disable", json!({ "code": fresh[1] }), &session).await;
    assert_eq!((status, error(&body)), (StatusCode::FORBIDDEN, "Two-step verification is required on this server"));
    // revoking: once, and only one's own
    assert_eq!(w.call(Method::DELETE, &format!("/app-passwords/{id}"), None, &session).await.0, StatusCode::NO_CONTENT);
    let (status, _, body) = w.call(Method::DELETE, &format!("/app-passwords/{id}"), None, &session).await;
    assert_eq!((status, error(&body)), (StatusCode::NOT_FOUND, "No such app password"));
    // not an admin
    let (status, _, body) = w.post("/2fa/users/id-alice/reset", json!(null), &session).await;
    assert_eq!((status, error(&body)), (StatusCode::FORBIDDEN, "Only admins can do this"));
    assert_eq!(w.get("/2fa/users/id-root", &session).await.0, StatusCode::FORBIDDEN);
    assert_eq!(w.reached.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn an_admin_resets_someones_two_step_verification_and_their_app_passwords_stay() {
    let w = world(Options::default()).await;
    let (_, alice, _) = w.set_up("alice", "sesame").await;
    let (_, root, _) = w.set_up("root", "toor").await;
    w.post("/app-passwords", json!({ "name": "phone" }), &alice).await;
    let other = w.post("/app-passwords", json!({ "name": "root's" }), &root).await.2["appPassword"]["id"].as_str().unwrap().to_string();
    assert_eq!(w.call(Method::DELETE, &format!("/app-passwords/{other}"), None, &alice).await.0, StatusCode::NOT_FOUND, "only its user revokes it");

    let (status, _, body) = w.get("/2fa/users/id-alice", &root).await;
    assert_eq!((status, &body["enabled"], &body["recoveryCodesLeft"]), (StatusCode::OK, &json!(true), &json!(10)));
    assert_eq!(w.post("/2fa/users/id-alice/reset", json!(null), &root).await.0, StatusCode::NO_CONTENT);
    assert_eq!(w.get("/2fa/users/id-alice", &root).await.2, json!({ "mode": "required", "enabled": false, "recoveryCodesLeft": 0 }));
    // they set it up again at their next sign-in; their app passwords are still there
    assert_eq!(w.sign_in("alice", "sesame", "").await.2["twoFactor"], "setup");
    assert_eq!(w.get("/app-passwords", &alice).await.2.as_array().unwrap().len(), 1);
    // and setting it up again ends the sessions from before
    let (_, again, _) = w.set_up("alice", "sesame").await;
    assert_eq!(w.get("/app-passwords", &alice).await.0, StatusCode::UNAUTHORIZED);
    assert_eq!(w.get("/app-passwords", &again).await.2.as_array().unwrap().len(), 1);
}

// ---------------------------------------------------------------- the browser sign-in for apps

#[tokio::test]
async fn an_app_gets_an_api_key_once_its_user_allows_it_only_once() {
    let w = world(Options { policy: TwoFactor::Off, ..Options::default() }).await;
    let (status, _, start) = w.post("/device/start", json!({ "client": "Sonus", "device": "书房电脑" }), "").await;
    assert_eq!(status, StatusCode::OK, "{start}");
    let (device, code) = (start["deviceCode"].as_str().unwrap().to_string(), start["userCode"].as_str().unwrap().to_string());
    assert_eq!(start["verificationPath"], format!("/app/#/device?code={code}"));
    assert_eq!((&start["expiresIn"], &start["interval"]), (&json!(600), &json!(2)));
    let poll = || w.post("/device/poll", json!({ "deviceCode": device }), "");
    assert_eq!(poll().await.2, json!({ "status": "pending", "interval": 2 }));

    // the approval page needs a signed-in user
    assert_eq!(w.get(&format!("/device/{code}"), "").await.0, StatusCode::UNAUTHORIZED);
    assert_eq!(w.post(&format!("/device/{code}/approve"), json!(null), "").await.0, StatusCode::UNAUTHORIZED);
    let session = w.sign_in("alice", "sesame", "").await.2["token"].as_str().unwrap().to_string();
    let (status, _, info) = w.get(&format!("/device/{}", code.to_lowercase()), &session).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!((&info["userCode"], &info["client"], &info["device"]), (&json!(code), &json!("Sonus"), &json!("书房电脑")));
    assert!(info["expiresIn"].as_u64().is_some_and(|s| (590..=600).contains(&s)));
    assert_eq!(w.call(Method::POST, &format!("/device/{code}/approve"), None, &session).await.0, StatusCode::NO_CONTENT);

    let got = poll().await.2;
    assert_eq!((&got["status"], &got["username"]), (&json!("approved"), &json!("alice")));
    let key = got["apiKey"].as_str().unwrap().to_string();
    assert_eq!(key.replace('-', "").len(), 32, "a key nobody types is longer");
    assert_eq!(poll().await.2, json!({ "status": "expired" }), "handed over once");
    let list = w.get("/app-passwords", &session).await.2;
    assert_eq!(list[0]["name"], "Sonus · 书房电脑");
    let owner: String = w
        .db()
        .query_row("SELECT user_id FROM sonus_app_password WHERE secret_hash = ?1", [sonus_server::secrets::api_key_hash(key.as_bytes())], |r| r.get(0))
        .unwrap();
    assert_eq!(owner, "id-alice");

    // the app gives it back when it signs out
    assert_eq!(w.post("/device/revoke", json!({ "apiKey": key }), "").await.0, StatusCode::NO_CONTENT);
    let (status, _, body) = w.post("/device/revoke", json!({ "apiKey": key }), "").await;
    assert_eq!((status, error(&body)), (StatusCode::NOT_FOUND, "No such API key"));
    for bad in [json!({}), json!({ "apiKey": "" }), json!([])] {
        assert_eq!(w.post("/device/revoke", bad, "").await.0, StatusCode::UNPROCESSABLE_ENTITY);
    }
    assert_eq!(w.get("/app-passwords", &session).await.2, json!([]));
}

#[tokio::test]
async fn a_refusal_reaches_the_app_and_unknown_codes_are_404() {
    let w = world(Options { policy: TwoFactor::Off, base_path: "/music", ..Options::default() }).await;
    let start = w.post("/device/start", json!({}), "").await.2;
    assert!(start["verificationPath"].as_str().unwrap().starts_with("/music/app/#/device?code="), "under the base path");
    let (device, code) = (start["deviceCode"].as_str().unwrap().to_string(), start["userCode"].as_str().unwrap().to_string());
    let session = w.sign_in("alice", "sesame", "").await.2["token"].as_str().unwrap().to_string();
    assert_eq!(w.get(&format!("/device/{code}"), &session).await.2["client"], "App", "an app that does not name itself");
    assert_eq!(w.call(Method::POST, &format!("/device/{code}/deny"), None, &session).await.0, StatusCode::NO_CONTENT);
    assert_eq!(w.post("/device/poll", json!({ "deviceCode": device }), "").await.2, json!({ "status": "denied" }));
    let (status, _, body) = w.call(Method::POST, &format!("/device/{code}/approve"), None, &session).await;
    assert_eq!((status, error(&body)), (StatusCode::NOT_FOUND, "No sign-in waiting for this code: it may have expired"));
    assert_eq!(w.get("/device/ZZZZ-ZZZZ", &session).await.0, StatusCode::NOT_FOUND);
    assert_eq!(w.post("/device/poll", json!({ "deviceCode": "no-such-code" }), "").await.2, json!({ "status": "expired" }));
    assert_eq!(w.send(Request::post("/music/auth/device/poll").body(full("{")).unwrap()).await.0, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(w.get("/app-passwords", &session).await.2, json!([]), "a refusal makes no key");
}

// ---------------------------------------------------------------- who is signed in (Navidrome's Authenticator)

#[tokio::test]
async fn a_session_is_good_while_its_token_is_for_this_user_this_api_and_this_password() {
    let w = world(Options { policy: TwoFactor::Off, ..Options::default() }).await;
    let w = &w;
    let ok = |token: String| async move { w.get("/2fa", &token).await.0 };
    assert_eq!(ok(token_for(session_claims("alice", 0))).await, StatusCode::OK, "a current session token");
    assert_eq!(ok(token_for(session_claims("ALICE", 0))).await, StatusCode::OK, "the name in any case");
    assert_eq!(ok(token_for(Claims { audience: vec!["native".into()], ..session_claims("alice", 0) })).await, StatusCode::OK);
    assert_eq!(
        ok(token_for(Claims { audience: vec!["jellyfin".into()], ..session_claims("alice", 0) })).await,
        StatusCode::UNAUTHORIZED,
        "made for another API"
    );
    assert_eq!(ok(token_for(Claims { audience: vec!["sonus-2fa-setup".into()], ..session_claims("alice", 0) })).await, StatusCode::UNAUTHORIZED);
    assert_eq!(ok(token_for(session_claims("alice", 1))).await, StatusCode::UNAUTHORIZED, "an epoch the user never had");
    assert_eq!(
        ok(token_for(Claims { user_id: "someone-else".into(), ..session_claims("alice", 0) })).await,
        StatusCode::UNAUTHORIZED,
        "the name was another user's"
    );
    assert_eq!(ok(token_for(session_claims("nobody", 0))).await, StatusCode::UNAUTHORIZED);
    assert_eq!(ok(token_for(Claims { expires_at: now() - 1, ..session_claims("alice", 0) })).await, StatusCode::UNAUTHORIZED, "expired");
    assert_eq!(ok(Signer::new(b"another secret").sign(&session_claims("alice", 0))).await, StatusCode::UNAUTHORIZED, "signed by someone else");
    assert_eq!(ok(String::new()).await, StatusCode::UNAUTHORIZED);
    assert_eq!(ok("not.a.token".into()).await, StatusCode::UNAUTHORIZED);

    // a password change bumps the user's epoch: every token before it is revoked
    let session = token_for(session_claims("alice", 0));
    w.db().execute("UPDATE user SET token_epoch = 3 WHERE user_name = 'alice'", []).unwrap();
    let (status, _, body) = w.get("/2fa", &session).await;
    assert_eq!((status, error(&body)), (StatusCode::UNAUTHORIZED, "Not authenticated"));
    assert_eq!(ok(token_for(session_claims("ALICE", 0))).await, StatusCode::UNAUTHORIZED, "whatever the case of the name in it");
    assert_eq!(ok(token_for(session_claims("alice", 3))).await, StatusCode::OK);
}

#[tokio::test]
async fn the_token_is_found_in_the_header_the_cookie_or_the_query_in_that_order() {
    let w = world(Options { policy: TwoFactor::Off, ..Options::default() }).await;
    let good = token_for(session_claims("alice", 0));
    let get = |request: hyper::http::request::Builder| async { w.send(request.body(empty()).unwrap()).await.0 };
    assert_eq!(get(Request::get("/auth/2fa").header(header::COOKIE, format!("theme=dark; jwt={good}"))).await, StatusCode::OK);
    assert_eq!(get(Request::get(format!("/auth/2fa?jwt={good}"))).await, StatusCode::OK);
    assert_eq!(get(Request::get("/auth/2fa").header("X-ND-Authorization", format!("bearer {good}"))).await, StatusCode::OK);
    // the first one found is the one checked: a bad header is not rescued by a good cookie
    let both = Request::get("/auth/2fa").header("X-ND-Authorization", "Bearer bad.bad.bad").header(header::COOKIE, format!("jwt={good}"));
    assert_eq!(get(both).await, StatusCode::UNAUTHORIZED);
    assert_eq!(get(Request::get("/auth/2fa").header("Authorization", format!("Bearer {good}"))).await, StatusCode::UNAUTHORIZED, "not the standard header");
}

#[tokio::test]
async fn a_trusted_proxys_user_is_signed_in_and_nobody_elses_header_is() {
    // requests come from 127.0.0.1: a trusted proxy here
    let trusted = world(Options { policy: TwoFactor::Off, trusted: "127.0.0.0/8", ..Options::default() }).await;
    let as_user = |w: &World, name: &str| {
        let request = Request::get("/auth/app-passwords").header("Remote-User", name).body(empty()).unwrap();
        let (gateway, name) = (w.gateway, name.to_string());
        async move {
            let response = send(gateway, request).await;
            (response.status(), name)
        }
    };
    assert_eq!(as_user(&trusted, "alice").await.0, StatusCode::OK);
    assert_eq!(as_user(&trusted, "nobody").await.0, StatusCode::UNAUTHORIZED, "no user is made up");
    assert_eq!(trusted.db().query_row("SELECT count(*) FROM user", [], |r| r.get::<_, i64>(0)).unwrap(), 2);
    // a valid token for the same user must still be good for them: a revoked one is refused, header or not
    let stale = token_for(session_claims("alice", 9));
    let request = Request::get("/auth/app-passwords").header("Remote-User", "alice").header("X-ND-Authorization", format!("Bearer {stale}"));
    assert_eq!(trusted.send(request.body(empty()).unwrap()).await.0, StatusCode::UNAUTHORIZED);

    let untrusted = world(Options { policy: TwoFactor::Off, ..Options::default() }).await;
    assert_eq!(as_user(&untrusted, "alice").await.0, StatusCode::UNAUTHORIZED);
    let request = Request::get("/auth/app-passwords").header("x-sonus-user-0123456789abcdef", "alice").body(empty()).unwrap();
    assert_eq!(untrusted.send(request).await.0, StatusCode::UNAUTHORIZED, "the gateway's own header, sent by a client");
}

#[tokio::test]
async fn the_development_auto_login_signs_everyone_in_as_its_user() {
    let w = world(Options { policy: TwoFactor::Off, auto_login: "alice", ..Options::default() }).await;
    assert_eq!(w.get("/2fa", "").await.0, StatusCode::OK);
    // a stray token for someone else is ignored
    assert_eq!(w.get("/2fa", &token_for(session_claims("someone-else", 0))).await.0, StatusCode::OK);
    // but a token naming the user must be good for them
    assert_eq!(w.get("/2fa", &token_for(session_claims("ALICE", 7))).await.0, StatusCode::UNAUTHORIZED);
}

// ---------------------------------------------------------------- this server's own

#[tokio::test]
async fn everything_under_auth_is_answered_here_none_of_it_reaches_navidrome() {
    let w = world(Options::default()).await;
    for (method, path, status) in [
        (Method::GET, "/auth", StatusCode::NOT_FOUND),
        (Method::GET, "/auth/", StatusCode::NOT_FOUND),
        (Method::GET, "/auth/nothing", StatusCode::NOT_FOUND),
        (Method::POST, "/auth/login/", StatusCode::NOT_FOUND),
        (Method::POST, "/auth/Login", StatusCode::NOT_FOUND),
        (Method::GET, "/auth/login", StatusCode::METHOD_NOT_ALLOWED),
        (Method::PUT, "/auth/createAdmin", StatusCode::METHOD_NOT_ALLOWED),
        (Method::HEAD, "/auth/2fa", StatusCode::METHOD_NOT_ALLOWED),
        (Method::OPTIONS, "/auth/login", StatusCode::METHOD_NOT_ALLOWED),
        (Method::POST, "/auth/device/BCDF-GHJK", StatusCode::METHOD_NOT_ALLOWED),
    ] {
        let (answered, headers, body) = w.send(Request::builder().method(method.clone()).uri(path).body(empty()).unwrap()).await;
        assert_eq!(answered, status, "{method} {path}");
        if status == StatusCode::NOT_FOUND && method != Method::HEAD {
            assert_eq!(body, "404 page not found\n");
        }
        if status == StatusCode::METHOD_NOT_ALLOWED {
            assert!(headers.contains_key("allow"), "{method} {path}");
        }
        assert_eq!(headers["x-content-type-options"], "nosniff");
    }
    assert_eq!(w.reached.load(Ordering::SeqCst), 0);
    // a CORS preflight is Navidrome's CORS middleware's to answer
    let preflight = Request::builder()
        .method(Method::OPTIONS)
        .uri("/auth/device/start")
        .header("Origin", "https://app.example")
        .header("Access-Control-Request-Method", "POST");
    assert_eq!(w.send(preflight.body(empty()).unwrap()).await.2, "from navidrome");
    assert_eq!(w.reached.load(Ordering::SeqCst), 1);
    // answers carry Navidrome's headers, CORS for a page on another origin among them
    let (_, headers, _) = w.send(Request::post("/auth/device/start").header("Origin", "https://app.example").body(full("{}")).unwrap()).await;
    assert_eq!(headers["access-control-allow-origin"], "*");
    assert_eq!(headers["content-type"], "application/json");
    assert_eq!(headers["x-frame-options"], "DENY");
}

#[tokio::test]
async fn sign_in_routes_are_rate_limited_per_address_as_navidromes() {
    let w = world(Options { policy: TwoFactor::Optional, limit: 3, window: Duration::from_secs(60), ..Options::default() }).await;
    // every request counts, right or wrong, across the limited routes
    let (status, headers, _) = w.sign_in("alice", "sesame", "").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!((headers["x-ratelimit-limit"].to_str().unwrap(), headers["x-ratelimit-remaining"].to_str().unwrap()), ("3", "2"));
    let session = w.sign_in("alice", "sesame", "").await.2["token"].as_str().unwrap().to_string();
    assert_eq!(w.post("/device/start", json!({}), "").await.1["x-ratelimit-remaining"], "0");

    let (status, headers, body) = w.sign_in("alice", "sesame", "").await;
    assert_eq!((status, body), (StatusCode::TOO_MANY_REQUESTS, json!("Too Many Requests\n")));
    assert_eq!((headers["retry-after"].to_str().unwrap(), headers["x-ratelimit-remaining"].to_str().unwrap()), ("60", "0"));
    assert_eq!(headers["content-type"], "text/plain; charset=utf-8");
    for path in ["/2fa/setup", "/2fa/confirm", "/device/start", "/device/revoke"] {
        assert_eq!(w.post(path, json!({}), "").await.0, StatusCode::TOO_MANY_REQUESTS, "{path}");
    }
    // signed-in routes are checked for the session first, then limited; the others are not limited at all
    assert_eq!(w.post("/2fa/recovery-codes", json!({ "code": "000000" }), "").await.0, StatusCode::UNAUTHORIZED);
    assert_eq!(w.post("/2fa/recovery-codes", json!({ "code": "000000" }), &session).await.0, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(w.post("/2fa/disable", json!({ "code": "000000" }), &session).await.0, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(w.get("/2fa", &session).await.0, StatusCode::OK);
    assert_eq!(w.get("/app-passwords", &session).await.0, StatusCode::OK);
    assert_eq!(w.post("/device/poll", json!({ "deviceCode": "x" }), "").await.0, StatusCode::OK);
    assert_eq!(w.post("/createAdmin", json!({ "username": "x", "password": "y" }), "").await.0, StatusCode::FORBIDDEN);
    assert!(w.get("/2fa", &session).await.1.get("x-ratelimit-limit").is_none());
}

#[tokio::test]
async fn sessions_made_here_are_not_made_of_anything_guessable() {
    let w = world(Options { policy: TwoFactor::Off, ..Options::default() }).await;
    let a = w.sign_in("alice", "sesame", "").await.2;
    let b = w.sign_in("alice", "sesame", "").await.2;
    assert_ne!(a["subsonicSalt"], b["subsonicSalt"], "a new salt each time");
    let starts: Vec<Value> = futures(&w, 3).await;
    let codes: std::collections::HashSet<String> = starts.iter().map(|s| s["deviceCode"].as_str().unwrap().to_string()).collect();
    assert_eq!(codes.len(), 3);
    assert!(codes.iter().all(|c| c.len() == 64 && c.bytes().all(|b| b.is_ascii_hexdigit())), "256 random bits");
}

async fn futures(w: &World, n: usize) -> Vec<Value> {
    let mut out = Vec::new();
    for _ in 0..n {
        out.push(w.post("/device/start", json!({ "client": "Sonus" }), "").await.2);
    }
    out
}
