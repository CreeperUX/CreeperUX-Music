//! Subsonic sign-ins checked by the gateway, against a fake Navidrome that records what reaches it and a database made
//! as the frozen Navidrome makes it (`common::database`). What is asserted of the fake Navidrome is the point: a
//! refused request never reaches it, a signed-in one reaches it without its credentials and with the user named in the
//! gateway's own header.

mod common;

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use bytes::Bytes;
use common::database;
use common::*;
use http_body_util::BodyExt;
use hyper::body::Incoming;
use hyper::header::{self, HeaderMap};
use hyper::{Method, Request, Response, StatusCode, Uri};
use rusqlite::Connection;
use sonus_server::config::{Shared, TwoFactor};
use sonus_server::db::Db;
use sonus_server::secrets::{Keys, subsonic_token};
use sonus_server::subsonic::respond::Envelope;
use sonus_server::subsonic::{Setup, Subsonic};
use tokio::sync::mpsc;

const KEY: &str = "the test's encryption key";
const SECRET_HEADER: &str = "x-sonus-user-0123456789abcdef";
const ALICE_APP: &str = "abcd-efgh-jkmn-pqrs";
const BOB_APP: &str = "wxyz-2345-6789-abcd";
const BOB_KEY: &str = "nmkj-hgfe-dcba-9876-5432-zyxw-vuts-rqpn";
const ENVELOPE: &str = r#"{"subsonic-response":{"status":"ok","version":"1.16.1","type":"navidrome","serverVersion":"0.64.2-test","openSubsonic":true,"openSubsonicExtensions":[]}}"#;
const COMMON: &str = "v=1.16.1&c=test&f=json";

fn error_json(code: i32, message: &str) -> String {
    format!(
        r#"{{"subsonic-response":{{"status":"failed","version":"1.16.1","type":"navidrome","serverVersion":"0.64.2-test","openSubsonic":true,"error":{{"code":{code},"message":"{message}"}}}}}}"#
    )
}

const WRONG: &str = "Wrong username or password";

/// What the fake Navidrome saw of a request.
#[derive(Debug)]
struct Seen {
    method: Method,
    target: String,
    headers: HeaderMap,
    body: Bytes,
}

struct Options {
    limit: i64,
    window: Duration,
    two_factor: TwoFactor,
    trusted: &'static str,
    base_path: &'static str,
    /// The gateway has its sign-in check (false: still starting).
    started: bool,
}

impl Default for Options {
    fn default() -> Self {
        Options { limit: 0, window: Duration::from_secs(20), two_factor: TwoFactor::Optional, trusted: "", base_path: "", started: true }
    }
}

struct World {
    gateway: SocketAddr,
    seen: mpsc::UnboundedReceiver<Seen>,
    /// How many requests reached the fake Navidrome.
    reached: Arc<AtomicUsize>,
    database: PathBuf,
    dir: PathBuf,
}

impl Drop for World {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

static WORLDS: AtomicUsize = AtomicUsize::new(0);

/// The users: alice (a password, and an app password), bob (two-step verification set up, an app password and an API
/// key), carol (two-step verification begun, never confirmed), and 林夕雨.
fn make_database() -> (PathBuf, PathBuf) {
    let dir = std::env::temp_dir().join(format!("sonus-subsonic-test-{}-{}", std::process::id(), WORLDS.fetch_add(1, Ordering::Relaxed)));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("navidrome.db");
    let keys = Keys::new(KEY);
    let conn = database::create(&file);
    let alice = database::add_user(&conn, &keys, "alice", "sesame");
    database::add_app_password(&conn, &keys, &alice, "ap-alice", ALICE_APP);
    let bob = database::add_user(&conn, &keys, "bob", "hunter2");
    database::add_two_factor(&conn, &bob, true);
    database::add_app_password(&conn, &keys, &bob, "ap-bob", BOB_APP);
    database::add_app_password(&conn, &keys, &bob, "key-bob", BOB_KEY);
    let carol = database::add_user(&conn, &keys, "carol", "not-yet");
    database::add_two_factor(&conn, &carol, false);
    database::add_user(&conn, &keys, "林夕雨", "密码");
    database::set_session_secret(&conn, &keys, "the test's session secret");
    (dir, file)
}

async fn world(options: Options) -> World {
    let (dir, file) = make_database();
    let (tx, seen) = mpsc::unbounded_channel();
    let reached = Arc::new(AtomicUsize::new(0));
    let counter = reached.clone();
    let navidrome = upstream(move |req: Request<Incoming>| {
        let (tx, counter) = (tx.clone(), counter.clone());
        async move {
            counter.fetch_add(1, Ordering::SeqCst);
            let (parts, body) = req.into_parts();
            let body = body.collect().await.unwrap().to_bytes();
            let target = parts.uri.path_and_query().map(|p| p.to_string()).unwrap_or_default();
            let _ = tx.send(Seen { method: parts.method, target, headers: parts.headers, body });
            Response::new(full("from navidrome"))
        }
    })
    .await;
    let subsonic = options.started.then(|| {
        Subsonic::new(Setup {
            db: Db::open(&file).unwrap(),
            keys: Keys::new(KEY),
            two_factor: options.two_factor,
            limit: options.limit,
            window: options.window,
            envelope: Envelope::from_json(ENVELOPE.as_bytes()).unwrap(),
            frame_options: "DENY".into(),
        })
    });
    let setup = GatewaySetup {
        trusted: options.trusted,
        upstream_user_header: SECRET_HEADER,
        base_path: options.base_path,
        checks_sign_ins: true,
        subsonic,
        ..GatewaySetup::default()
    };
    let (gateway, _) = gateway(navidrome, setup).await;
    World { gateway, seen, reached, database: file, dir }
}

impl World {
    async fn get(&self, target: &str) -> (StatusCode, HeaderMap, String) {
        self.request(Request::get(target).body(empty()).unwrap()).await
    }

    async fn post(&self, target: &str, form: &str) -> (StatusCode, HeaderMap, String) {
        let request = Request::post(target).header(header::CONTENT_TYPE, "application/x-www-form-urlencoded").body(full(form.to_string())).unwrap();
        self.request(request).await
    }

    async fn request(&self, request: Request<TestBody>) -> (StatusCode, HeaderMap, String) {
        let response = send(self.gateway, request).await;
        let (status, headers) = (response.status(), response.headers().clone());
        (status, headers, String::from_utf8(body_bytes(response.into_body()).await.to_vec()).unwrap())
    }

    /// The one request that reached Navidrome.
    fn reached(&mut self) -> Seen {
        let seen = self.seen.try_recv().expect("the request reached Navidrome");
        assert!(self.seen.try_recv().is_err(), "one request only");
        seen
    }

    /// A request the gateway must answer itself: the answer's body. Nothing reached Navidrome.
    async fn refused(&mut self, target: &str) -> String {
        let before = self.reached.load(Ordering::SeqCst);
        let (status, _, body) = self.get(target).await;
        assert_eq!(status, StatusCode::OK, "Subsonic errors come with HTTP 200");
        assert_eq!(self.reached.load(Ordering::SeqCst), before, "Navidrome never saw {target}");
        assert!(self.seen.try_recv().is_err());
        body
    }

    /// A request that must go on to Navidrome signed in: what Navidrome saw.
    async fn signed_in(&mut self, target: &str) -> Seen {
        let (status, _, body) = self.get(target).await;
        assert_eq!((status, body.as_str()), (StatusCode::OK, "from navidrome"), "{target}");
        self.reached()
    }

    fn db(&self) -> Connection {
        Connection::open(&self.database).unwrap()
    }
}

fn user_of(seen: &Seen) -> Option<&[u8]> {
    seen.headers.get(SECRET_HEADER).map(|v| v.as_bytes())
}

fn token(password: &str, salt: &str) -> String {
    subsonic_token(password.as_bytes(), salt.as_bytes())
}

fn hex(text: &str) -> String {
    sonus_server::secrets::hex(text.as_bytes())
}

// ---------------------------------------------------------------- signing in

#[tokio::test]
async fn a_password_signs_in_three_ways_and_navidrome_gets_the_user_not_the_credentials() {
    let mut w = world(Options::default()).await;
    for credentials in ["p=sesame".to_string(), format!("p=enc:{}", hex("sesame")), format!("t={}&s=c0ffee", token("sesame", "c0ffee"))] {
        let seen = w.signed_in(&format!("/rest/ping?u=alice&{credentials}&{COMMON}&id=1&id=2")).await;
        assert_eq!(seen.target, format!("/rest/ping?u=alice&{COMMON}&id=1&id=2"), "everything but the credentials, as it came");
        assert_eq!(user_of(&seen), Some(&b"alice"[..]));
        assert!(!seen.target.contains("sesame") && !seen.target.contains("c0ffee"));
    }
    // the .view spelling, the name in another case (Navidrome finds it either way and keeps it as typed)
    let seen = w.signed_in(&format!("/rest/getAlbum.view?id=al-1&u=ALICE&p=sesame&{COMMON}")).await;
    assert_eq!(seen.target, format!("/rest/getAlbum.view?id=al-1&u=ALICE&{COMMON}"));
    assert_eq!(user_of(&seen), Some(&b"ALICE"[..]));
    // a name that is not ASCII travels in the header as its bytes
    let seen = w.signed_in(&format!("/rest/ping?u=%E6%9E%97%E5%A4%95%E9%9B%A8&p=%E5%AF%86%E7%A0%81&{COMMON}")).await;
    assert_eq!(user_of(&seen), Some("林夕雨".as_bytes()));
    assert_eq!(seen.target, format!("/rest/ping?u=%E6%9E%97%E5%A4%95%E9%9B%A8&{COMMON}"));
}

#[tokio::test]
async fn wrong_credentials_are_refused_here_with_navidromes_answer() {
    let mut w = world(Options::default()).await;
    let wrong = error_json(40, WRONG);
    for target in [
        format!("/rest/ping?u=alice&p=wrong&{COMMON}"),
        format!("/rest/ping?u=alice&t={}&s=c0ffee&{COMMON}", token("wrong", "c0ffee")),
        format!("/rest/ping?u=alice&t={}&s=other&{COMMON}", token("sesame", "c0ffee")),
        format!("/rest/ping?u=alice&p=enc:{}&{COMMON}", hex("wrong")),
        format!("/rest/ping?u=nobody&p=sesame&{COMMON}"),
        format!("/rest/ping?u=alice&{COMMON}"),
        format!("/rest/ping?u=alice&s=c0ffee&{COMMON}"),
        format!("/rest/stream?id=1&u=alice&p=wrong&{COMMON}"),
        format!("/rest/getCoverArt.view?id=1&u=alice&p=wrong&{COMMON}"),
    ] {
        assert_eq!(w.refused(&target).await, wrong, "{target}");
    }
    assert_eq!(w.reached.load(Ordering::SeqCst), 0, "Navidrome saw none of them");
}

#[tokio::test]
async fn a_missing_parameter_is_error_10_in_navidromes_order() {
    let mut w = world(Options::default()).await;
    assert_eq!(w.refused("/rest/ping?p=sesame&v=1.16.1&c=test&f=json").await, error_json(10, "missing parameter: 'u'"));
    assert_eq!(w.refused("/rest/ping?f=json").await, error_json(10, "missing parameter: 'u'"));
    assert_eq!(w.refused("/rest/ping?u=&p=sesame&v=1.16.1&c=test&f=json").await, error_json(10, "missing parameter: 'u'"), "empty is missing");
    assert_eq!(w.refused("/rest/ping?u=alice&p=sesame&c=test&f=json").await, error_json(10, "missing parameter: 'v'"));
    assert_eq!(w.refused("/rest/ping?u=alice&p=sesame&v=1.16.1&f=json").await, error_json(10, "missing parameter: 'c'"));
    assert_eq!(w.refused("/rest/ping?u=alice&p=wrong&f=json").await, error_json(10, "missing parameter: 'v'"), "before the password is looked at");
    assert_eq!(w.refused(&format!("/rest/ping?apiKey={BOB_KEY}&c=test&f=json")).await, error_json(10, "missing parameter: 'v'"), "an API key needs no u");
    assert_eq!(w.refused(&format!("/rest/ping?apiKey={BOB_KEY}&v=1.16.1&f=json")).await, error_json(10, "missing parameter: 'c'"));
}

#[tokio::test]
async fn an_api_key_signs_in_alone() {
    let mut w = world(Options::default()).await;
    for key in [BOB_KEY.to_string(), BOB_KEY.replace('-', ""), BOB_KEY.to_uppercase(), format!("%20{BOB_KEY}%20")] {
        let seen = w.signed_in(&format!("/rest/ping?apiKey={key}&{COMMON}")).await;
        assert_eq!(seen.target, format!("/rest/ping?{COMMON}"), "the key does not go on");
        assert_eq!(user_of(&seen), Some(&b"bob"[..]), "the name the database has");
    }
    // an app password is a key too
    let seen = w.signed_in(&format!("/rest/ping?apiKey={ALICE_APP}&{COMMON}")).await;
    assert_eq!(user_of(&seen), Some(&b"alice"[..]));

    let conflicting = error_json(43, "Multiple conflicting authentication mechanisms provided");
    for other in ["u=bob", "p=x", "t=x", "s=x", "jwt=x", "u=bob&p=hunter2"] {
        assert_eq!(w.refused(&format!("/rest/ping?apiKey={BOB_KEY}&{other}&{COMMON}")).await, conflicting, "{other}");
    }
    // a wrong key with other credentials is 43 as well: which credentials to believe comes first
    assert_eq!(w.refused(&format!("/rest/ping?apiKey=nope&u=alice&p=sesame&{COMMON}")).await, conflicting);

    let invalid = error_json(44, "Invalid API key");
    assert_eq!(w.refused(&format!("/rest/ping?apiKey=no-such-key&{COMMON}")).await, invalid);
    assert_eq!(w.refused(&format!("/rest/ping?apiKey={BOB_KEY}x&{COMMON}")).await, invalid);
    assert_eq!(w.refused(&format!("/rest/ping?apiKey=hunter2&{COMMON}")).await, invalid, "the account password is not a key");
}

#[tokio::test]
async fn with_two_step_verification_only_an_app_password_signs() {
    let mut w = world(Options::default()).await;
    let wrong = error_json(40, WRONG);
    for credentials in ["p=hunter2".to_string(), format!("p=enc:{}", hex("hunter2")), format!("t={}&s=abc", token("hunter2", "abc"))] {
        assert_eq!(w.refused(&format!("/rest/ping?u=bob&{credentials}&{COMMON}")).await, wrong, "{credentials}");
    }
    let undashed = BOB_APP.replace('-', "");
    for credentials in [
        format!("p={BOB_APP}"),
        format!("p={undashed}"),
        format!("p=enc:{}", hex(BOB_APP)),
        format!("t={}&s=abc", token(BOB_APP, "abc")),
        format!("t={}&s=abc", token(&undashed, "abc")),
    ] {
        let seen = w.signed_in(&format!("/rest/ping?u=bob&{credentials}&{COMMON}")).await;
        assert_eq!(user_of(&seen), Some(&b"bob"[..]), "{credentials}");
        assert_eq!(seen.target, format!("/rest/ping?u=bob&{COMMON}"));
    }
    assert_eq!(w.refused(&format!("/rest/ping?u=bob&p={BOB_APP}x&{COMMON}")).await, wrong);
    assert_eq!(w.refused(&format!("/rest/ping?u=bob&p={ALICE_APP}&{COMMON}")).await, wrong, "someone else's app password");

    // without it, the password signs and so does an app password
    w.signed_in(&format!("/rest/ping?u=alice&p={ALICE_APP}&{COMMON}")).await;
    // begun but never confirmed is not set up: the password still signs
    let seen = w.signed_in(&format!("/rest/ping?u=carol&p=not-yet&{COMMON}")).await;
    assert_eq!(user_of(&seen), Some(&b"carol"[..]));
}

#[tokio::test]
async fn with_the_policy_off_the_account_password_signs_again() {
    let mut w = world(Options { two_factor: TwoFactor::Off, ..Options::default() }).await;
    let seen = w.signed_in(&format!("/rest/ping?u=bob&p=hunter2&{COMMON}")).await;
    assert_eq!(user_of(&seen), Some(&b"bob"[..]));
    w.signed_in(&format!("/rest/ping?u=bob&p={BOB_APP}&{COMMON}")).await;
    let optional = world(Options { two_factor: TwoFactor::Optional, ..Options::default() }).await;
    let (_, _, body) = optional.get(&format!("/rest/ping?u=bob&p=hunter2&{COMMON}")).await;
    assert_eq!(body, error_json(40, WRONG), "optional: set up is set up");
}

#[tokio::test]
async fn where_two_step_verification_is_required_no_account_password_signs_set_up_or_not() {
    let mut w = world(Options { two_factor: TwoFactor::Required, ..Options::default() }).await;
    let wrong = error_json(40, WRONG);
    // alice never set it up, carol began and never confirmed, bob has it: the password of none of them signs, in any
    // of its forms, and each is answered as a wrong password is
    for (user, password) in [("alice", "sesame"), ("carol", "not-yet"), ("bob", "hunter2")] {
        for credentials in [format!("p={password}"), format!("p=enc:{}", hex(password)), format!("t={}&s=abc", token(password, "abc"))] {
            assert_eq!(w.refused(&format!("/rest/ping?u={user}&{credentials}&{COMMON}")).await, wrong, "{user} {credentials}");
        }
        assert_eq!(w.refused(&format!("/rest/ping?u={user}&p=not-the-password&{COMMON}")).await, wrong, "the same answer as for a wrong one");
    }
    let (status, _, body) = w.post("/rest/ping.view", &format!("u=alice&p=sesame&{COMMON}")).await;
    assert_eq!((status, body), (StatusCode::OK, wrong.clone()), "a form post neither");
    // an app password still signs, for a user who has not set it up too (one made before the server required it),
    // and so does an API key
    let seen = w.signed_in(&format!("/rest/ping?u=alice&p={ALICE_APP}&{COMMON}")).await;
    assert_eq!(user_of(&seen), Some(&b"alice"[..]));
    let seen = w.signed_in(&format!("/rest/ping?u=alice&t={}&s=abc&{COMMON}", token(ALICE_APP, "abc"))).await;
    assert_eq!(user_of(&seen), Some(&b"alice"[..]));
    let seen = w.signed_in(&format!("/rest/ping?u=bob&p={BOB_APP}&{COMMON}")).await;
    assert_eq!(user_of(&seen), Some(&b"bob"[..]));
    let seen = w.signed_in(&format!("/rest/ping?apiKey={BOB_KEY}&{COMMON}")).await;
    assert_eq!(user_of(&seen), Some(&b"bob"[..]));
}

// ---------------------------------------------------------------- form posts

#[tokio::test]
async fn a_form_posts_credentials_are_read_and_removed_from_the_body() {
    let mut w = world(Options::default()).await;
    let form = format!("u=alice&p=sesame&{COMMON}&id=s1&id=s2&current=s1&q=a%2Fb+c");
    let (status, _, body) = w.post("/rest/savePlayQueue.view", &form).await;
    assert_eq!((status, body.as_str()), (StatusCode::OK, "from navidrome"));
    let seen = w.reached();
    assert_eq!(seen.method, Method::POST);
    assert_eq!(seen.target, "/rest/savePlayQueue.view");
    assert_eq!(seen.body, format!("u=alice&{COMMON}&id=s1&id=s2&current=s1&q=a%2Fb+c"), "the rest of the form, byte for byte");
    assert_eq!(seen.headers["content-length"], seen.body.len().to_string().as_str());
    assert_eq!(seen.headers["content-type"], "application/x-www-form-urlencoded");
    assert_eq!(user_of(&seen), Some(&b"alice"[..]));

    // credentials split between the query and the form; an API key in a form
    let (_, _, body) = w.post(&format!("/rest/ping?u=alice&s=abc&{COMMON}"), &format!("t={}", token("sesame", "abc"))).await;
    assert_eq!(body, "from navidrome");
    let seen = w.reached();
    assert_eq!((seen.target.as_str(), &seen.body[..]), (format!("/rest/ping?u=alice&{COMMON}").as_str(), &b""[..]));
    let (_, _, body) = w.post("/rest/ping", &format!("apiKey={BOB_KEY}&{COMMON}")).await;
    assert_eq!(body, "from navidrome");
    let seen = w.reached();
    assert_eq!(seen.body, COMMON);
    assert_eq!(user_of(&seen), Some(&b"bob"[..]));

    // the form's values come first, as in Navidrome: its wrong password is the one checked
    let (_, _, body) = w.post(&format!("/rest/ping?u=alice&p=sesame&{COMMON}"), "p=wrong").await;
    assert_eq!(body, error_json(40, WRONG));
    let (_, _, body) = w.post(&format!("/rest/ping?p=wrong&{COMMON}"), "u=alice&p=sesame").await;
    assert_eq!(body, "from navidrome");
    assert_eq!(w.reached().target, format!("/rest/ping?{COMMON}"));
    // a wrong password in a form is refused here, in the format the form asks for
    let (_, headers, body) = w.post("/rest/ping", "u=alice&p=wrong&v=1.16.1&c=test&f=json").await;
    assert_eq!(body, error_json(40, WRONG));
    assert_eq!(headers["content-type"], "application/json");
    assert!(w.seen.try_recv().is_err());
}

#[tokio::test]
async fn a_post_that_is_not_a_form_is_read_from_its_query_and_its_body_streams_on() {
    let mut w = world(Options::default()).await;
    let request = Request::post(format!("/rest/getTranscodeDecision?u=alice&p=sesame&{COMMON}"))
        .header(header::CONTENT_TYPE, "application/json")
        .body(full(r#"{"p":"not a parameter"}"#))
        .unwrap();
    let (_, _, body) = w.request(request).await;
    assert_eq!(body, "from navidrome");
    let seen = w.reached();
    assert_eq!(seen.target, format!("/rest/getTranscodeDecision?u=alice&{COMMON}"));
    assert_eq!(seen.body, r#"{"p":"not a parameter"}"#);
    assert_eq!(user_of(&seen), Some(&b"alice"[..]));
}

// ---------------------------------------------------------------- what stays Navidrome's

#[tokio::test]
async fn what_is_not_the_gateways_to_check_reaches_navidrome_as_it_came() {
    let mut w = world(Options::default()).await;
    for target in [
        // a web session's token: Navidrome checks it
        format!("/rest/ping?u=alice&jwt=abc.def.ghi&{COMMON}"),
        format!("/rest/ping?u=alice&p=wrong&jwt=abc.def.ghi&{COMMON}"),
        // what Go's parser refuses: Navidrome answers with its own error
        format!("/rest/ping?u=alice&p=%zz&{COMMON}"),
        format!("/rest/ping?u=alice;p=sesame&{COMMON}"),
        // not behind the sign-in, or not a method at all (Navidrome's 404)
        "/rest/getOpenSubsonicExtensions?f=json".to_string(),
        format!("/rest/nothing?u=alice&p=wrong&{COMMON}"),
        format!("/rest/ping/?u=alice&p=wrong&{COMMON}"),
        format!("/REST/ping?u=alice&p=wrong&{COMMON}"),
        // other parts of the server
        "/api/song?p=x".to_string(),
    ] {
        let (_, _, body) = w.get(&target).await;
        assert_eq!(body, "from navidrome", "{target}");
        let seen = w.reached();
        assert_eq!(seen.target, target, "untouched");
        assert_eq!(user_of(&seen), None, "and nobody is named: {target}");
    }
    // a CORS preflight: Navidrome answers it before any sign-in
    let target = format!("/rest/ping?u=alice&p=wrong&{COMMON}");
    let preflight =
        Request::builder().method(Method::OPTIONS).uri(&target).header("Origin", "https://app.example").header("Access-Control-Request-Method", "POST");
    w.request(preflight.body(empty()).unwrap()).await;
    let seen = w.reached();
    assert_eq!((&seen.method, &seen.target, user_of(&seen)), (&Method::OPTIONS, &target, None));
    // a form Go's parser refuses: sent on as it was read
    let (_, _, body) = w.post("/rest/ping", "u=alice&p=%zz").await;
    assert_eq!(body, "from navidrome");
    let seen = w.reached();
    assert_eq!((&seen.body[..], user_of(&seen)), (&b"u=alice&p=%zz"[..], None));
}

#[tokio::test]
async fn every_http_method_is_checked_here_none_is_a_second_door() {
    let mut w = world(Options { limit: 2, window: Duration::from_secs(60), ..Options::default() }).await;
    // Navidrome's router answers any method on a Subsonic path and checks its sign-in: so does the gateway
    for method in [Method::HEAD, Method::PUT, Method::PATCH, Method::DELETE, Method::OPTIONS] {
        let right = format!("/rest/ping?u=carol&p=not-yet&{COMMON}");
        w.request(Request::builder().method(method.clone()).uri(&right).body(empty()).unwrap()).await;
        let seen = w.reached();
        assert_eq!(
            (&seen.method, seen.target.as_str(), user_of(&seen)),
            (&method, format!("/rest/ping?u=carol&{COMMON}").as_str(), Some(&b"carol"[..])),
            "{method}"
        );
    }
    // wrong passwords by any method are refused here and count against the one limit
    let wrong = format!("/rest/ping?u=alice&p=wrong&{COMMON}");
    let (_, headers, body) = w.request(Request::builder().method(Method::HEAD).uri(&wrong).body(empty()).unwrap()).await;
    assert_eq!((headers["content-type"].to_str().unwrap(), body.as_str()), ("application/json", ""), "a HEAD's answer has no body");
    let (_, _, body) = w.request(Request::builder().method(Method::DELETE).uri(&wrong).body(empty()).unwrap()).await;
    assert_eq!(body, error_json(40, WRONG));
    assert_eq!(w.refused(&format!("/rest/ping?u=alice&p=sesame&{COMMON}")).await, error_json(40, WRONG), "two failures, by HEAD and DELETE: limited");
    // a form in a PUT is a form, as Go reads it
    let put =
        Request::put("/rest/ping").header(header::CONTENT_TYPE, "application/x-www-form-urlencoded").body(full(format!("u=carol&p=not-yet&{COMMON}"))).unwrap();
    w.request(put).await;
    let seen = w.reached();
    assert_eq!((&seen.body[..], user_of(&seen)), (format!("u=carol&{COMMON}").as_bytes(), Some(&b"carol"[..])));
    // and so is one whose Content-Type has a parameter Go refuses: no way around the check
    let odd = Request::post("/rest/ping")
        .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded; charset")
        .body(full(format!("u=bob&p=hunter2&{COMMON}")))
        .unwrap();
    let (_, _, body) = w.request(odd).await;
    assert_eq!(body, error_json(40, WRONG));
    assert!(w.seen.try_recv().is_err());
}

#[tokio::test]
async fn a_user_name_that_is_not_text_is_nobodys() {
    let mut w = world(Options { limit: 2, window: Duration::from_secs(60), ..Options::default() }).await;
    let target = format!("/rest/ping?u=%ff%fe&p=x&{COMMON}");
    assert_eq!(w.refused(&target).await, error_json(40, WRONG));
    assert_eq!(w.refused(&target).await, error_json(40, WRONG));
    assert_eq!(w.refused(&target).await, error_json(40, WRONG), "limited like any name");
    w.signed_in(&format!("/rest/ping?u=alice&p=sesame&{COMMON}")).await;
}

#[tokio::test]
async fn nobody_outside_names_a_user() {
    let mut w = world(Options::default()).await;
    // the header Navidrome believes, sent by a client: removed, and the wrong password still refused here
    let wrong = format!("/rest/ping?u=alice&p=wrong&{COMMON}");
    let (_, _, body) = w.request(Request::get(&wrong).header(SECRET_HEADER, "alice").header("Remote-User", "alice").body(empty()).unwrap()).await;
    assert_eq!(body, error_json(40, WRONG));
    assert!(w.seen.try_recv().is_err());
    // with the right password for alice, a claim to be bob changes nothing
    let right = format!("/rest/ping?u=alice&p=sesame&{COMMON}");
    w.request(Request::get(&right).header(SECRET_HEADER, "bob").header("Remote-User", "bob").body(empty()).unwrap()).await;
    let seen = w.reached();
    assert_eq!(seen.headers.get_all(SECRET_HEADER).iter().map(|v| v.as_bytes()).collect::<Vec<_>>(), [&b"alice"[..]]);
    assert!(seen.headers.get("remote-user").is_none());
    // on paths the gateway does not check, the header never arrives either
    w.request(Request::get("/api/song").header(SECRET_HEADER, "alice").body(empty()).unwrap()).await;
    assert_eq!(user_of(&w.reached()), None);
    // no credentials at all name nobody
    let (_, _, body) = w.request(Request::get("/rest/ping?v=1.16.1&c=test&f=json").header(SECRET_HEADER, "alice").body(empty()).unwrap()).await;
    assert_eq!(body, error_json(10, "missing parameter: 'u'"));
}

#[tokio::test]
async fn a_trusted_proxys_user_is_navidromes_to_look_up() {
    // the test's requests come from 127.0.0.1, here a trusted proxy that signs users in itself
    let mut w = world(Options { trusted: "127.0.0.0/8", ..Options::default() }).await;
    let target = format!("/rest/ping?u=alice&p=wrong&{COMMON}");
    let (_, _, body) = w.request(Request::get(&target).header("Remote-User", "someone").body(empty()).unwrap()).await;
    assert_eq!(body, "from navidrome");
    let seen = w.reached();
    assert_eq!(seen.target, target, "untouched: Navidrome ignores credentials beside a proxy's user");
    assert_eq!(user_of(&seen), Some(&b"someone"[..]));
    // without the proxy's header the same peer's requests are checked here
    assert_eq!(w.refused(&target).await, error_json(40, WRONG));
}

// ---------------------------------------------------------------- answers given here

#[tokio::test]
async fn token_info_is_answered_here() {
    let mut w = world(Options::default()).await;
    let before = w.reached.load(Ordering::SeqCst);
    let (status, headers, body) = w.get(&format!("/rest/tokenInfo?apiKey={BOB_KEY}&{COMMON}")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers["content-type"], "application/json");
    assert_eq!(
        body,
        r#"{"subsonic-response":{"status":"ok","version":"1.16.1","type":"navidrome","serverVersion":"0.64.2-test","openSubsonic":true,"tokenInfo":{"username":"bob"}}}"#
    );
    // with a password too, the name as the database has it; .view; XML
    let (_, _, body) = w.get(&format!("/rest/tokenInfo.view?u=ALICE&p=sesame&{COMMON}")).await;
    assert!(body.contains(r#""tokenInfo":{"username":"alice"}"#), "{body}");
    let (_, headers, body) = w.get(&format!("/rest/tokenInfo?apiKey={BOB_KEY}&v=1.16.1&c=test")).await;
    assert_eq!(headers["content-type"], "application/xml");
    assert!(body.ends_with(r#"<tokenInfo username="bob"></tokenInfo></subsonic-response>"#), "{body}");
    assert_eq!(w.refused(&format!("/rest/tokenInfo?apiKey=nope&{COMMON}")).await, error_json(44, "Invalid API key"));
    assert_eq!(w.reached.load(Ordering::SeqCst), before, "Navidrome is not asked");

    // the user's last access is written, as Navidrome writes it for every signed-in request
    let last: Option<String> = w.db().query_row("SELECT last_access_at FROM user WHERE user_name = 'bob'", [], |r| r.get(0)).unwrap();
    let last = last.expect("written");
    assert!(sonus_server::gotime::parse(&last).is_some(), "{last}");
    let carol: Option<String> = w.db().query_row("SELECT last_access_at FROM user WHERE user_name = 'carol'", [], |r| r.get(0)).unwrap();
    assert_eq!(carol, None);
}

#[tokio::test]
async fn errors_come_in_the_format_asked_for_with_navidromes_headers() {
    let mut w = world(Options::default()).await;
    let (_, headers, body) = w.get("/rest/ping?u=alice&p=wrong&v=1.16.1&c=test").await;
    assert_eq!(headers["content-type"], "application/xml");
    assert_eq!(
        body,
        r#"<subsonic-response xmlns="http://subsonic.org/restapi" status="failed" version="1.16.1" type="navidrome" serverVersion="0.64.2-test" openSubsonic="true"><error code="40" message="Wrong username or password"></error></subsonic-response>"#
    );
    let (_, _, body) = w.get("/rest/ping?p=x&v=1.16.1&c=test&f=xml").await;
    assert!(body.contains(r#"<error code="10" message="missing parameter: &#39;u&#39;"></error>"#), "{body}");
    let (_, headers, body) = w.get("/rest/ping?u=alice&p=wrong&v=1.16.1&c=test&f=jsonp&callback=cb").await;
    assert_eq!(headers["content-type"], "application/javascript");
    assert_eq!(body, format!("cb({})", error_json(40, WRONG)));
    let (_, headers, body) = w.get("/rest/ping?u=alice&p=wrong&v=1.16.1&c=test&f=jsonp&callback=alert(1)").await;
    assert_eq!(headers["content-type"], "application/json");
    assert_eq!(body, error_json(0, "invalid callback parameter"));

    // Navidrome's security headers, and CORS for a page on another origin
    let (_, headers, _) =
        w.request(Request::get("/rest/ping?u=alice&p=wrong&v=1&c=test&f=json").header("Origin", "https://app.example").body(empty()).unwrap()).await;
    assert_eq!(headers["access-control-allow-origin"], "*");
    assert_eq!(headers["vary"], "Origin");
    assert_eq!(headers["x-content-type-options"], "nosniff");
    assert_eq!(headers["x-frame-options"], "DENY");
    assert_eq!(headers["referrer-policy"], "same-origin");
    assert!(w.seen.try_recv().is_err());
}

// ---------------------------------------------------------------- the limiter

#[tokio::test]
async fn failed_sign_ins_are_limited_per_address_and_user() {
    let mut w = world(Options { limit: 3, window: Duration::from_millis(600), ..Options::default() }).await;
    let wrong = error_json(40, WRONG);
    let right = format!("/rest/ping?u=alice&p=sesame&{COMMON}");
    w.signed_in(&right).await;
    for _ in 0..3 {
        assert_eq!(w.refused(&format!("/rest/ping?u=alice&p=wrong&{COMMON}")).await, wrong);
    }
    // the window is used up: the right password is refused too, with the very same answer
    assert_eq!(w.refused(&right).await, wrong);
    assert_eq!(w.refused(&format!("/rest/ping?u=ALICE&p=sesame&{COMMON}")).await, wrong, "the name in any case");
    assert_eq!(w.refused(&format!("/rest/ping?u=alice&p={ALICE_APP}&{COMMON}")).await, wrong);
    // another user from the same address is not limited, nor are API keys
    w.signed_in(&format!("/rest/ping?u=carol&p=not-yet&{COMMON}")).await;
    w.signed_in(&format!("/rest/ping?apiKey={BOB_KEY}&{COMMON}")).await;
    // a new window
    tokio::time::sleep(Duration::from_millis(700)).await;
    w.signed_in(&right).await;
}

#[tokio::test]
async fn failed_api_keys_are_limited_per_address() {
    let mut w = world(Options { limit: 2, window: Duration::from_millis(600), ..Options::default() }).await;
    let invalid = error_json(44, "Invalid API key");
    let right = format!("/rest/ping?apiKey={BOB_KEY}&{COMMON}");
    w.signed_in(&right).await;
    for key in ["nope-1", "nope-2"] {
        assert_eq!(w.refused(&format!("/rest/ping?apiKey={key}&{COMMON}")).await, invalid);
    }
    assert_eq!(w.refused(&right).await, invalid, "the right key is refused while the address is limited");
    assert_eq!(w.refused(&format!("/rest/tokenInfo?apiKey={BOB_KEY}&{COMMON}")).await, invalid);
    w.signed_in(&format!("/rest/ping?u=alice&p=sesame&{COMMON}")).await;
    // conflicting credentials are not a guess: they do not count
    tokio::time::sleep(Duration::from_millis(700)).await;
    for _ in 0..5 {
        w.refused(&format!("/rest/ping?apiKey=nope&u=x&{COMMON}")).await;
    }
    w.signed_in(&right).await;
}

#[tokio::test]
async fn missing_parameters_and_unknown_users_count_as_navidrome_counts_them() {
    let mut w = world(Options { limit: 2, window: Duration::from_secs(60), ..Options::default() }).await;
    // a missing parameter is refused before the limiter: no guess was made
    for _ in 0..5 {
        w.refused("/rest/ping?u=alice&p=wrong&f=json").await;
    }
    w.signed_in(&format!("/rest/ping?u=alice&p=sesame&{COMMON}")).await;
    // an unknown user's failures count for that name
    for _ in 0..2 {
        w.refused(&format!("/rest/ping?u=ghost&p=x&{COMMON}")).await;
    }
    assert_eq!(w.refused(&format!("/rest/ping?u=ghost&p=x&{COMMON}")).await, error_json(40, WRONG));
    w.signed_in(&format!("/rest/ping?u=alice&p=sesame&{COMMON}")).await;
}

// ---------------------------------------------------------------- what is written

#[tokio::test]
async fn an_app_passwords_use_is_noted_as_navidrome_notes_it() {
    let mut w = world(Options::default()).await;
    let used = |w: &World, id: &str| -> (Option<String>, String) {
        w.db().query_row("SELECT last_used_at, last_used_by FROM sonus_app_password WHERE id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?))).unwrap()
    };
    assert_eq!(used(&w, "ap-bob"), (None, String::new()));
    w.signed_in(&format!("/rest/ping?u=bob&p={BOB_APP}&v=1.16.1&c=Sonus&f=json")).await;
    let (at, by) = used(&w, "ap-bob");
    let at = at.expect("noted");
    assert!(at.ends_with("+00:00") && sonus_server::gotime::parse(&at).is_some(), "UTC, as Navidrome writes it: {at}");
    assert_eq!(by, "Sonus");
    // the same client again within five minutes: not written again
    w.signed_in(&format!("/rest/ping?u=bob&p={BOB_APP}&v=1.16.1&c=Sonus&f=json")).await;
    assert_eq!(used(&w, "ap-bob").0.as_deref(), Some(at.as_str()));
    // another client: written
    tokio::time::sleep(Duration::from_millis(5)).await;
    w.signed_in(&format!("/rest/ping?u=bob&p={BOB_APP}&v=1.16.1&c=Other&f=json")).await;
    let (later, by) = used(&w, "ap-bob");
    assert_eq!(by, "Other");
    assert_ne!(later.as_deref(), Some(at.as_str()));
    // an API key's use is noted the same way; the other app passwords are untouched
    w.signed_in(&format!("/rest/ping?apiKey={BOB_KEY}&v=1.16.1&c=Sonus&f=json")).await;
    assert_eq!(used(&w, "key-bob").1, "Sonus");
    assert_eq!(used(&w, "ap-alice"), (None, String::new()));
    // a failed sign-in notes nothing, and an account password's use is not an app password's
    w.refused(&format!("/rest/ping?u=alice&p=wrong&{COMMON}")).await;
    w.signed_in(&format!("/rest/ping?u=alice&p=sesame&{COMMON}")).await;
    assert_eq!(used(&w, "ap-alice"), (None, String::new()));
}

// ---------------------------------------------------------------- starting, and the base path

#[tokio::test]
async fn until_the_database_is_checked_sign_ins_wait() {
    let w = world(Options { started: false, ..Options::default() }).await;
    let (status, headers, _) = w.get(&format!("/rest/ping?u=alice&p=sesame&{COMMON}")).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(headers["retry-after"], "5");
    assert_eq!(w.reached.load(Ordering::SeqCst), 0, "credentials do not go to Navidrome meanwhile");
    // what is not checked here passes
    let (status, _, body) = w.get("/rest/getOpenSubsonicExtensions?f=json").await;
    assert_eq!((status, body.as_str()), (StatusCode::OK, "from navidrome"));
}

#[tokio::test]
async fn under_a_base_path_the_same_holds() {
    let mut w = world(Options { base_path: "/music", ..Options::default() }).await;
    assert_eq!(w.refused(&format!("/music/rest/ping?u=alice&p=wrong&{COMMON}")).await, error_json(40, WRONG));
    let seen = w.signed_in(&format!("/music/rest/ping?u=alice&p=sesame&{COMMON}")).await;
    assert_eq!(seen.target, format!("/music/rest/ping?u=alice&{COMMON}"));
    // outside it, the path is not Navidrome's Subsonic API: untouched
    let (_, _, body) = w.get(&format!("/rest/ping?u=alice&p=wrong&{COMMON}")).await;
    assert_eq!(body, "from navidrome");
    assert_eq!(user_of(&w.reached()), None);
}

#[tokio::test]
async fn a_connect_websocket_with_a_wrong_password_is_refused_before_it_is_one() {
    let mut w = world(Options::default()).await;
    let request = Request::get(format!("/rest/connect?u=alice&p=wrong&{COMMON}"))
        .header(header::CONNECTION, "Upgrade")
        .header(header::UPGRADE, "websocket")
        .header("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
        .header("Sec-WebSocket-Version", "13")
        .body(empty())
        .unwrap();
    let (status, _, body) = w.request(request).await;
    assert_eq!((status, body), (StatusCode::OK, error_json(40, WRONG)));
    assert!(w.seen.try_recv().is_err());
}

// ---------------------------------------------------------------- start-up

/// A fake Navidrome that answers getOpenSubsonicExtensions.
async fn answering_upstream() -> Uri {
    let addr = upstream(|_req: Request<Incoming>| async { Response::new(full(ENVELOPE)) }).await;
    format!("http://{addr}").parse().unwrap()
}

fn shared(dir: &std::path::Path) -> Shared {
    Shared { data_folder: dir.to_string_lossy().into_owned(), password_encryption_key: KEY.into(), ..Shared::default() }
}

#[tokio::test]
async fn at_start_the_database_is_checked_and_old_app_passwords_become_keys() {
    let (dir, file) = make_database();
    // an app password made before API keys: no hash yet
    let keys = Keys::new(KEY);
    let conn = Connection::open(&file).unwrap();
    conn.execute(
        "INSERT INTO sonus_app_password (id, user_id, name, secret, created_at) VALUES ('old', 'id-alice', 'Old', ?1, '2026-01-01 00:00:00+00:00')",
        [keys.seal(b"old1-old2-old3-old4").unwrap()],
    )
    .unwrap();
    drop(conn);

    let upstream = answering_upstream().await;
    sonus_server::startup::local(&shared(&dir), &upstream, "").await.expect("the known schema");
    let hash: String = Connection::open(&file).unwrap().query_row("SELECT secret_hash FROM sonus_app_password WHERE id = 'old'", [], |r| r.get(0)).unwrap();
    assert_eq!(hash, sonus_server::secrets::api_key_hash(b"old1old2old3old4"));
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn another_schema_or_no_database_stops_the_start() {
    let upstream = answering_upstream().await;
    let dir = std::env::temp_dir().join(format!("sonus-subsonic-test-{}-schema", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let Err(missing) = sonus_server::startup::local(&shared(&dir), &upstream, "").await else { panic!("no database is no start") };
    assert!(missing.contains("cannot open Navidrome's database"), "{missing}");

    drop(database::create_at_version(&dir.join("navidrome.db"), 20270101000000));
    let Err(newer) = sonus_server::startup::local(&shared(&dir), &upstream, "").await else { panic!("a newer schema is no start") };
    assert!(newer.contains("20270101000000") && newer.contains("20260922230428"), "{newer}");

    let conn = Connection::open(dir.join("navidrome.db")).unwrap();
    conn.execute_batch(
        "DELETE FROM goose_db_version; INSERT INTO goose_db_version (version_id, is_applied) VALUES (20260922230428, 1); DROP TABLE sonus_app_password;",
    )
    .unwrap();
    drop(conn);
    let Err(upstream_navidrome) = sonus_server::startup::local(&shared(&dir), &upstream, "").await else { panic!("upstream Navidrome's tables are no start") };
    assert!(upstream_navidrome.contains("sonus_app_password"), "{upstream_navidrome}");
    let _ = std::fs::remove_dir_all(&dir);
}
