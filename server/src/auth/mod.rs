//! The `/auth` routes, answered here instead of by Navidrome (`docs/server-roadmap.md`, phase 2): the web sign-in
//! with two-step verification, the first admin, app passwords, and the browser sign-in for apps. They move as one
//! unit, because they share state: the sign-ins that wait for approval live in this process's memory, and one
//! per-address rate limit counts across them.
//!
//! What Navidrome's `server/auth.go` and the fork's `sonus_twofactor.go` and `sonus_device.go` answer, this answers
//! the same: the same JSON, the same status codes, the same session tokens (`jwt.rs`), so the web UI signs in here and
//! goes on to use Navidrome's `/api` with the token it got. Everything under `/auth` is answered here, unknown paths
//! too (404, 405, as Navidrome's router): nothing under it reaches Navidrome but CORS preflights, so Navidrome's own
//! sign-in is not a second door.
//!
//! Three things are stricter here than in Navidrome's fork, on purpose (the security review of 2026-11-24, "weaknesses
//! by design"): with the policy `required`, an account's first set-up takes a one-time enrolment code besides the
//! password; and allowing an app's browser sign-in, making an app password, and an admin's reset of someone's two-step
//! verification each take a verification code of the acting account, when it has two-step verification: a session
//! alone does none of them.
//!
//! Ported from Navidrome and its CreeperUX fork (GPL-3.0), © the Navidrome authors.

pub mod device;
pub mod ratelimit;
pub mod store;
pub mod totp;

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use bytes::Bytes;
use chrono::Utc;
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::Incoming;
use hyper::header::{self, HeaderMap, HeaderValue};
use hyper::{Method, Response, StatusCode};
use serde_json::{Map, Value, json};
use subtle::ConstantTimeEq;
use tracing::{error, info, warn};

use crate::config::TwoFactor;
use crate::db::Db;
use crate::gateway::Body;
use crate::jwt::{self, Claims, Signer};
use crate::secrets::{self, Keys};
use crate::subsonic::params::Params;
use crate::subsonic::respond::navidrome_headers;
use crate::{gotime, id};
use device::DeviceLogins;
use ratelimit::{RateLimiter, Verdict};
use store::User;

/// Navidrome's `MaxLoginBodySize`: what a request under `/auth` may send.
pub const MAX_BODY_BYTES: usize = 8 << 10;

/// Wrong verification codes an account may be sent in `WRONG_CODES_WINDOW`, wherever they come from: the limit by
/// address stops nobody with many addresses, and with the password known a code is one of a million. After these,
/// no code is looked at until the window ends (the right one neither, or the guessing would go on).
const MAX_WRONG_CODES: u32 = 10;
const WRONG_CODES_WINDOW: Duration = Duration::from_secs(3600);
const TOO_MANY_CODES: &str = "Too many wrong verification codes; try again later";
const TOO_MANY_ENROLMENT_CODES: &str = "Too many wrong enrolment codes; try again later";

struct WrongCodes {
    since: Instant,
    count: u32,
}

enum Code {
    Right,
    Wrong,
    /// Not looked at: too many wrong ones.
    Refused,
}

/// How long a request's body may take to arrive: it is a few hundred bytes.
const BODY_WITHIN: Duration = Duration::from_secs(10);

/// The audience of a setup token: no API takes it, only the two setup routes.
const AUDIENCE_SETUP: &str = "sonus-2fa-setup";
/// A second audience, on the setup token `createAdmin` answers with: the first admin has nobody to get an enrolment
/// code from, so this token (15 minutes, for the account just made) sets two-step verification up without one.
const AUDIENCE_FIRST_ADMIN: &str = "sonus-2fa-first-admin";
const SETUP_TOKEN_SECONDS: i64 = 15 * 60;

pub struct Auth {
    db: Arc<Db>,
    keys: Keys,
    policy: TwoFactor,
    signer: Signer,
    session_timeout: Duration,
    limiter: Option<RateLimiter>,
    devices: DeviceLogins,
    wrong_codes: Mutex<HashMap<String, WrongCodes>>,
    base_path: String,
    frame_options: HeaderValue,
    enable_gravatar: bool,
    auto_login: String,
}

pub struct Setup {
    pub db: Arc<Db>,
    pub keys: Keys,
    pub two_factor: TwoFactor,
    /// The session secret, from Navidrome's `property` table.
    pub signer: Signer,
    pub session_timeout: Duration,
    /// `AuthRequestLimit` and `AuthWindowLength`.
    pub limit: i64,
    pub window: Duration,
    /// `BaseURL`'s path, empty when none.
    pub base_path: String,
    pub frame_options: String,
    pub enable_gravatar: bool,
    /// `DevAutoLoginUsername`, empty when unset.
    pub auto_login: String,
}

/// A request under `/auth`.
pub struct Request<'a> {
    pub method: &'a Method,
    /// The path after `/auth`: empty, or starting with `/`.
    pub path: &'a str,
    pub query: Option<&'a str>,
    pub headers: &'a HeaderMap,
    /// The address the gateway decided the request came from (trust.rs).
    pub client: IpAddr,
    /// The user a trusted proxy names (`ExtAuth`), when one does.
    pub proxy_user: Option<&'a [u8]>,
}

#[derive(Debug, PartialEq)]
enum Route {
    Login,
    CreateAdmin,
    Setup,
    Confirm,
    Status,
    RecoveryCodes,
    Disable,
    AppPasswords,
    AppPasswordCreate,
    AppPasswordDelete(String),
    UserStatus(String),
    UserReset(String),
    UserEnrolmentCode(String),
    DeviceStart,
    DevicePoll,
    DeviceRevoke,
    DeviceInfo(String),
    DeviceApprove(String),
    DeviceDeny(String),
}

impl Route {
    /// The routes Navidrome rate-limits per address, as its sign-in.
    fn limited(&self) -> bool {
        matches!(self, Route::Login | Route::Setup | Route::Confirm | Route::RecoveryCodes | Route::Disable | Route::DeviceStart | Route::DeviceRevoke)
    }

    /// The routes behind Navidrome's `Authenticator`: a session, or a trusted proxy's user.
    fn signed_in(&self) -> bool {
        !matches!(self, Route::Login | Route::CreateAdmin | Route::Setup | Route::Confirm | Route::DeviceStart | Route::DevicePoll | Route::DeviceRevoke)
    }
}

#[derive(Debug, PartialEq)]
enum Miss {
    NotFound,
    /// The path is a route's, the method is not: the methods it takes.
    MethodNotAllowed(Vec<&'static str>),
}

/// The route for a method and a path (after `/auth`), as Navidrome's router (chi) finds it: literal paths first, then
/// the ones with a parameter, which is one path segment as it came.
fn route(method: &Method, path: &str) -> Result<Route, Miss> {
    type Literal = (&'static str, &'static str, fn() -> Route);
    const LITERAL: [Literal; 12] = [
        ("POST", "/login", || Route::Login),
        ("POST", "/createAdmin", || Route::CreateAdmin),
        ("POST", "/2fa/setup", || Route::Setup),
        ("POST", "/2fa/confirm", || Route::Confirm),
        ("GET", "/2fa", || Route::Status),
        ("POST", "/2fa/recovery-codes", || Route::RecoveryCodes),
        ("POST", "/2fa/disable", || Route::Disable),
        ("GET", "/app-passwords", || Route::AppPasswords),
        ("POST", "/app-passwords", || Route::AppPasswordCreate),
        ("POST", "/device/start", || Route::DeviceStart),
        ("POST", "/device/poll", || Route::DevicePoll),
        ("POST", "/device/revoke", || Route::DeviceRevoke),
    ];
    if let Some((_, _, make)) = LITERAL.iter().find(|(m, p, _)| *m == method.as_str() && *p == path) {
        return Ok(make());
    }
    let segments: Vec<&str> = path.strip_prefix('/').map(|rest| rest.split('/').collect()).unwrap_or_default();
    let parameter = |s: &str| !s.is_empty();
    let with_parameter: Vec<(&'static str, Route)> = match segments.as_slice() {
        ["app-passwords", id] if parameter(id) => vec![("DELETE", Route::AppPasswordDelete(id.to_string()))],
        ["2fa", "users", id] if parameter(id) => vec![("GET", Route::UserStatus(id.to_string()))],
        ["2fa", "users", id, "reset"] if parameter(id) => vec![("POST", Route::UserReset(id.to_string()))],
        ["2fa", "users", id, "enrolment-code"] if parameter(id) => vec![("POST", Route::UserEnrolmentCode(id.to_string()))],
        ["device", code] if parameter(code) => vec![("GET", Route::DeviceInfo(code.to_string()))],
        ["device", code, "approve"] if parameter(code) => vec![("POST", Route::DeviceApprove(code.to_string()))],
        ["device", code, "deny"] if parameter(code) => vec![("POST", Route::DeviceDeny(code.to_string()))],
        _ => Vec::new(),
    };
    let mut allowed: Vec<&'static str> = LITERAL.iter().filter(|(_, p, _)| *p == path).map(|(m, _, _)| *m).collect();
    for (m, found) in with_parameter {
        if m == method.as_str() {
            return Ok(found);
        }
        allowed.push(m);
    }
    if allowed.is_empty() { Err(Miss::NotFound) } else { Err(Miss::MethodNotAllowed(allowed)) }
}

/// A setup route's body (`Auth::setup_request`).
struct SetupRequest {
    token: String,
    code: String,
    enrolment: String,
    app_password: Option<String>,
}

/// What a handler answers, before the headers every answer gets.
struct Reply {
    status: StatusCode,
    body: Option<Value>,
}

fn ok(body: Value) -> Reply {
    Reply { status: StatusCode::OK, body: Some(body) }
}

fn no_content() -> Reply {
    Reply { status: StatusCode::NO_CONTENT, body: None }
}

/// Navidrome's `rest.RespondWithError`.
fn fail(status: StatusCode, message: &str) -> Reply {
    Reply { status, body: Some(json!({ "error": message })) }
}

/// The fork's `respondTwoFactor`: an error that tells the web UI which step comes next.
fn two_factor(step: &str, message: &str) -> Reply {
    Reply { status: StatusCode::UNAUTHORIZED, body: Some(json!({ "error": message, "twoFactor": step })) }
}

const NOT_AUTHENTICATED: &str = "Not authenticated";
const BAD_PAYLOAD: &str = "invalid request payload";
const INVALID_CODE: &str = "Invalid verification code";
const CODE_REQUIRED: &str = "Verification code required";
const UNKNOWN_ERROR: &str = "Unknown error authenticating user. Please try again";

/// The parts of a request the handlers need, owned: they run on a blocking thread.
struct Sent {
    /// `X-ND-Authorization: Bearer <token>`.
    bearer: String,
    /// The `jwt` cookie, then the `jwt` query parameter: where Navidrome's verifier looks next.
    cookie: String,
    query: String,
    proxy_user: Option<String>,
    /// The address rate limits count for.
    address: String,
    /// The address as it is shown to a person.
    client: String,
    /// The body, None when it was longer than Navidrome reads or did not arrive.
    body: Option<Bytes>,
}

impl Sent {
    /// The first JSON value of the body, as Go's `json.Decoder.Decode` reads one. None: there is none.
    fn json(&self) -> Option<Value> {
        let body = self.body.as_ref()?;
        serde_json::Deserializer::from_slice(body).into_iter::<Value>().next()?.ok()
    }

    /// The body decoded into a Go struct of strings: `fields` by their JSON names. None: Go's decoder would fail (no
    /// JSON, not an object, a field that is not a string). As Go, names match in any case, `null` is no value.
    fn fields<const N: usize>(&self, names: [&str; N]) -> Option<[String; N]> {
        let value = self.json()?;
        let object = match &value {
            Value::Null => return Some(std::array::from_fn(|_| String::new())),
            Value::Object(object) => object,
            _ => return None,
        };
        let mut out: [String; N] = std::array::from_fn(|_| String::new());
        for (key, value) in object {
            let Some(at) = names.iter().position(|name| name.eq_ignore_ascii_case(key)) else { continue };
            match value {
                Value::String(text) => out[at] = text.clone(),
                Value::Null => {}
                _ => return None,
            }
        }
        Some(out)
    }

    /// A code sent with a request that had no body before codes were asked for: no body is no code. None: a body
    /// that is not the JSON object expected.
    fn code(&self) -> Option<String> {
        match &self.body {
            Some(body) if body.iter().all(u8::is_ascii_whitespace) => Some(String::new()),
            _ => self.fields(["code"]).map(|[code]| code),
        }
    }

    /// The body decoded into Go's `map[string]string`: every value a string (or null), keys as written.
    fn string_map(&self) -> Option<Map<String, Value>> {
        match self.json()? {
            Value::Null => Some(Map::new()),
            Value::Object(object) if object.values().all(|v| v.is_string() || v.is_null()) => Some(object),
            _ => None,
        }
    }
}

fn text<'a>(map: &'a Map<String, Value>, key: &str) -> &'a str {
    map.get(key).and_then(Value::as_str).unwrap_or("")
}

/// Navidrome's `tokenFromHeader`: `Bearer <token>`, the word in any case.
fn bearer(headers: &HeaderMap) -> String {
    let value = headers.get("x-nd-authorization").map(|v| v.as_bytes()).unwrap_or_default();
    if value.len() > 7 && value[..6].eq_ignore_ascii_case(b"BEARER") { String::from_utf8_lossy(&value[7..]).into_owned() } else { String::new() }
}

/// The value of the first cookie named `name` (Go's `Request.Cookie`).
fn cookie(headers: &HeaderMap, name: &str) -> String {
    for value in headers.get_all(header::COOKIE) {
        let Ok(value) = value.to_str() else { continue };
        for pair in value.split(';') {
            if let Some((key, value)) = pair.trim().split_once('=') {
                if key == name {
                    return value.trim_matches('"').to_string();
                }
            }
        }
    }
    String::new()
}

impl Auth {
    pub fn new(setup: Setup) -> Auth {
        Auth {
            db: setup.db,
            keys: setup.keys,
            policy: setup.two_factor,
            signer: setup.signer,
            session_timeout: setup.session_timeout,
            limiter: RateLimiter::new(setup.limit, setup.window),
            devices: DeviceLogins::default(),
            wrong_codes: Mutex::default(),
            base_path: setup.base_path.trim_end_matches('/').to_string(),
            frame_options: HeaderValue::from_str(&setup.frame_options).unwrap_or(HeaderValue::from_static("DENY")),
            enable_gravatar: setup.enable_gravatar,
            auto_login: setup.auto_login,
        }
    }

    /// Answers a request under `/auth`.
    pub async fn handle(self: &Arc<Self>, request: Request<'_>, body: Incoming) -> Response<Body> {
        let found = match route(request.method, request.path) {
            Ok(found) => found,
            Err(Miss::NotFound) => return self.plain(StatusCode::NOT_FOUND, "404 page not found\n", request.headers, None),
            Err(Miss::MethodNotAllowed(allowed)) => return self.plain(StatusCode::METHOD_NOT_ALLOWED, "", request.headers, Some(&allowed)),
        };
        // Navidrome reads at most 8 KB of a request here: more, and its JSON decoding fails
        // nor does it wait for one that does not come
        let read = tokio::time::timeout(BODY_WITHIN, Limited::new(body, MAX_BODY_BYTES).collect()).await;
        let body = read.ok().and_then(|read| read.ok()).map(|read| read.to_bytes());
        let query = request.query.and_then(|q| Params::parse(q.as_bytes(), None)).map(|p| String::from_utf8_lossy(p.get("jwt")).into_owned());
        let sent = Sent {
            bearer: bearer(request.headers),
            cookie: cookie(request.headers, "jwt"),
            query: query.unwrap_or_default(),
            proxy_user: request.proxy_user.map(|name| String::from_utf8_lossy(name).into_owned()),
            address: crate::subsonic::limiter_address(request.client),
            client: request.client.to_string(),
            body,
        };
        let auth = self.clone();
        let (reply, rate) = match tokio::task::spawn_blocking(move || auth.answer(found, &sent)).await {
            Ok(answered) => answered,
            Err(_) => (fail(StatusCode::INTERNAL_SERVER_ERROR, "Internal error"), None),
        };
        self.respond(reply, rate, request.headers)
    }

    /// Navidrome's middlewares around a route, then the route. Blocking.
    fn answer(&self, found: Route, sent: &Sent) -> (Reply, Option<Verdict>) {
        // the sign-in comes before the rate limit, as Navidrome's Authenticator comes before its limiter
        let user = if found.signed_in() {
            match self.authenticate(sent) {
                Some(user) => Some(user),
                None => return (fail(StatusCode::UNAUTHORIZED, NOT_AUTHENTICATED), None),
            }
        } else {
            None
        };
        let mut rate = None;
        if let (true, Some(limiter)) = (found.limited(), &self.limiter) {
            let verdict = limiter.hit(&sent.address);
            if verdict.limited {
                return (Reply { status: StatusCode::TOO_MANY_REQUESTS, body: None }, Some(verdict));
            }
            rate = Some(verdict);
        }
        let user = user.as_ref();
        let signed_in = || user.expect("a signed-in route");
        let reply = match found {
            Route::Login => self.login(sent),
            Route::CreateAdmin => self.create_admin(sent),
            Route::Setup => self.setup_begin(sent),
            Route::Confirm => self.setup_confirm(sent),
            Route::Status => self.status(&signed_in().id, false),
            Route::RecoveryCodes => self.with_code(signed_in(), sent, |auth, user| match store::new_recovery_codes(&auth.db, &user.id) {
                Ok(codes) => ok(json!({ "recoveryCodes": codes })),
                Err(e) => fail(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
            }),
            Route::Disable => self.disable(signed_in(), sent),
            Route::AppPasswords => self.app_passwords(signed_in()),
            Route::AppPasswordCreate => self.app_password_create(signed_in(), sent),
            Route::AppPasswordDelete(id) => self.app_password_delete(signed_in(), &id),
            Route::UserStatus(id) => self.admin_only(signed_in(), || self.status(&id, true)),
            Route::UserReset(id) => self.admin_only(signed_in(), || self.user_reset(signed_in(), &id, sent)),
            Route::UserEnrolmentCode(id) => self.admin_only(signed_in(), || self.user_enrolment_code(signed_in(), &id, sent)),
            Route::DeviceStart => self.device_start(sent),
            Route::DevicePoll => self.device_poll(sent),
            Route::DeviceRevoke => self.device_revoke(sent),
            Route::DeviceInfo(code) => self.device_info(signed_in(), &code),
            Route::DeviceApprove(code) => self.device_approve(signed_in(), &code, sent),
            Route::DeviceDeny(code) => self.device_deny(signed_in(), &code),
        };
        (reply, rate)
    }

    // ------------------------------------------------------------ who is asking

    /// Navidrome's `Authenticator`: the user a request is signed in as. In its order: the development auto-login, the
    /// session token (header, cookie, query), a trusted proxy's user header. Then, when the request carries a valid
    /// token that names this user, the token must still be good for them: not revoked, and for this API.
    fn authenticate(&self, sent: &Sent) -> Option<User> {
        let token = [&sent.bearer, &sent.cookie, &sent.query].into_iter().find(|t| !t.is_empty());
        let claims = token.and_then(|token| self.signer.verify(token, Utc::now().timestamp()).ok());
        let from_token = claims.as_ref().map(|c| c.subject.as_str()).filter(|name| !name.is_empty());
        let username = if !self.auto_login.is_empty() { &self.auto_login } else { from_token.or(sent.proxy_user.as_deref().filter(|n| !n.is_empty()))? };
        let user = match store::find_user(&self.db, &self.keys, username) {
            Ok(Some(user)) => user,
            Ok(None) => return None,
            Err(e) => {
                error!(error = %e, "could not look a user up");
                return None;
            }
        };
        if let Some(claims) = &claims {
            if claims.subject.to_lowercase() == user.user_name.to_lowercase() {
                if let Err(e) = jwt::check(claims, &user.id, user.token_epoch, jwt::AUDIENCE_NATIVE) {
                    warn!(user = %claims.subject, reason = ?e, "a session token was refused");
                    return None;
                }
            }
        }
        Some(user)
    }

    /// The fork's `userForSetup`: the user a setup token (or a session token) names; and whether the token is the
    /// first admin's, from `createAdmin`.
    fn user_for_setup(&self, token: &str) -> Option<(User, bool)> {
        if token.is_empty() {
            return None;
        }
        let claims = self.signer.verify(token, Utc::now().timestamp()).ok()?;
        let user = store::find_user(&self.db, &self.keys, &claims.subject).ok()??;
        jwt::check(&claims, &user.id, user.token_epoch, AUDIENCE_SETUP).ok()?;
        let first_admin = claims.audience.iter().any(|a| a == AUDIENCE_FIRST_ADMIN);
        Some((user, first_admin))
    }

    // ------------------------------------------------------------ tokens and the sign-in's answer

    fn claims(&self, user: &User, audience: &[&str], seconds: i64) -> Claims {
        let now = Utc::now().timestamp();
        Claims {
            issuer: jwt::ISSUER.into(),
            subject: user.user_name.clone(),
            audience: audience.iter().map(|a| a.to_string()).collect(),
            issued_at: now,
            expires_at: now + seconds,
            user_id: user.id.clone(),
            is_admin: user.is_admin,
            epoch: user.token_epoch,
            id: String::new(),
        }
    }

    /// Navidrome's `CreateToken`: a session, good for `SessionTimeout` (Navidrome renews it at every use of `/api`).
    fn session_token(&self, user: &User) -> String {
        self.signer.sign(&self.claims(user, &[], self.session_timeout.as_secs() as i64))
    }

    fn two_factor_enabled(&self, user: &User) -> Result<bool, crate::db::DbError> {
        store::enabled(&self.db, self.policy, &user.id)
    }

    /// Navidrome's `buildAuthPayload` with the session token, and the fork's `withoutSubsonicToken`: a user with
    /// two-step verification gets no password-derived Subsonic token in the browser (it would open the API without a
    /// code); the web UI signs its Subsonic calls with its session instead.
    fn signed_in_payload(&self, user: &User) -> Map<String, Value> {
        let mut payload = Map::new();
        payload.insert("id".into(), json!(user.id));
        payload.insert("name".into(), json!(user.name));
        payload.insert("username".into(), json!(user.user_name));
        payload.insert("isAdmin".into(), json!(user.is_admin));
        if self.enable_gravatar && !user.email.is_empty() {
            let hash = secrets::hex(&secrets::sha256(user.email.to_lowercase().trim().as_bytes()));
            payload.insert("avatar".into(), json!(format!("https://www.gravatar.com/avatar/{hash}?s=50")));
        }
        if !matches!(self.two_factor_enabled(user), Ok(true)) {
            if let Ok(salt) = id::random_hex(3) {
                let password = user.password.as_deref().unwrap_or_default();
                payload.insert("subsonicToken".into(), json!(secrets::subsonic_token(password, salt.as_bytes())));
                payload.insert("subsonicSalt".into(), json!(salt));
            }
        }
        payload.insert("token".into(), json!(self.session_token(user)));
        payload
    }

    // ------------------------------------------------------------ the sign-in

    fn login(&self, sent: &Sent) -> Reply {
        let Some(data) = sent.string_map() else { return fail(StatusCode::UNPROCESSABLE_ENTITY, BAD_PAYLOAD) };
        // otp: the authenticator or recovery code, when two-step verification asks for one
        // appPassword: a name; an app password of that name is made with the sign-in (see `with_app_password`)
        self.sign_in(text(&data, "username"), text(&data, "password"), text(&data, "otp"), data.get("appPassword").and_then(Value::as_str), false)
    }

    /// Navidrome's `doLogin`. `app_password`: the name of an app password to make with the sign-in. `first_admin`:
    /// the account was made by this very request.
    fn sign_in(&self, username: &str, password: &str, code: &str, app_password: Option<&str>, first_admin: bool) -> Reply {
        let user = match store::find_user(&self.db, &self.keys, username) {
            Ok(user) => user,
            Err(e) => {
                error!(error = %e, "could not check a sign-in");
                return fail(StatusCode::INTERNAL_SERVER_ERROR, "Unknown error authentication user. Please try again");
            }
        };
        // a password that cannot be opened matches nothing; the comparison takes the same time whatever differs
        let user = user.filter(|u| u.password.as_deref().is_some_and(|stored| bool::from(stored.ct_eq(password.as_bytes()))));
        let Some(user) = user else {
            warn!(username, "web sign-in refused");
            return fail(StatusCode::UNAUTHORIZED, "Invalid username or password");
        };
        if let Err(e) = store::touch_last_login(&self.db, &user.id) {
            error!(error = %e, "could not note a sign-in");
        }
        if let Some(reply) = self.second_step(&user, code, first_admin) {
            return reply;
        }
        ok(Value::Object(self.with_app_password(&user, app_password, self.signed_in_payload(&user))))
    }

    /// A sign-in's answer with an app password made in the same request (`newAppPassword`, as `POST /app-passwords`
    /// answers), when the request names one. A client that signs in with the password and a code and then keeps an
    /// app password of its own (the web client) needs one code this way, not two: making an app password from a
    /// session takes a code of its own, and an authenticator's code is taken once.
    fn with_app_password(&self, user: &User, name: Option<&str>, mut payload: Map<String, Value>) -> Map<String, Value> {
        let Some(name) = name else { return payload };
        let name: String = name.chars().take(64).collect();
        match store::create_app_password(&self.db, &self.keys, &user.id, &name, store::Kind::Handed) {
            Ok((made, password)) => {
                info!(username = %user.user_name, name = %made.name, "app password created with the sign-in");
                payload.insert("newAppPassword".into(), json!({ "appPassword": app_password_json(&made), "password": password }));
            }
            // the sign-in stands; the client sees that no app password came
            Err(e) => error!(username = %user.user_name, error = %e, "could not make the app password asked for with the sign-in"),
        }
        payload
    }

    /// The fork's `twoFactorSignIn`, after a correct password: Some when the request is answered here (a code is
    /// missing or wrong, or the user must set it up first), None when the sign-in goes on.
    fn second_step(&self, user: &User, code: &str, first_admin: bool) -> Option<Reply> {
        if self.policy == TwoFactor::Off {
            return None;
        }
        let enabled = match self.two_factor_enabled(user) {
            Ok(enabled) => enabled,
            Err(e) => {
                error!(user = %user.user_name, error = %e, "two-step verification: could not read the user's setup");
                return Some(fail(StatusCode::INTERNAL_SERVER_ERROR, UNKNOWN_ERROR));
            }
        };
        if enabled {
            if code.is_empty() {
                return Some(two_factor("code", CODE_REQUIRED));
            }
            return match self.check_code(user, code) {
                Code::Right => None,
                Code::Wrong => {
                    warn!(username = %user.user_name, "web sign-in refused: wrong verification code");
                    Some(two_factor("code", INVALID_CODE))
                }
                Code::Refused => Some(fail(StatusCode::TOO_MANY_REQUESTS, TOO_MANY_CODES)),
            };
        }
        if self.policy == TwoFactor::Required {
            // not set up yet: a short-lived token that only the setup routes take, instead of a session. The password
            // was enough to get it, so it is not enough to set up with: that takes the account's enrolment code too
            let audience: &[&str] = if first_admin { &[AUDIENCE_SETUP, AUDIENCE_FIRST_ADMIN] } else { &[AUDIENCE_SETUP] };
            let token = self.signer.sign(&self.claims(user, audience, SETUP_TOKEN_SECONDS));
            let mut reply = two_factor("setup", "Two-step verification must be set up");
            if let Some(Value::Object(body)) = &mut reply.body {
                body.insert("setupToken".into(), json!(token));
                body.insert("enrolmentCodeRequired".into(), json!(!first_admin));
            }
            return Some(reply);
        }
        None
    }

    /// Checks a code for the user's two-step verification, counting the wrong ones per account.
    fn check_code(&self, user: &User, code: &str) -> Code {
        self.counted(&user.id, user, "verification", || store::verify(&self.db, &self.keys, &user.id, code, Utc::now()).map_err(|e| e.to_string()))
    }

    /// Checks an account's enrolment code (it is used up only when the set-up is confirmed), counting the wrong ones
    /// per account as verification codes are, in a count of their own.
    fn check_enrolment_code(&self, user: &User, code: &str) -> Code {
        let key = format!("enrolment:{}", user.id);
        self.counted(&key, user, "enrolment", || store::enrolment_code_matches(&self.db, &user.id, code, Utc::now()).map_err(|e| e.to_string()))
    }

    /// Runs a check of a code, unless too many wrong ones were counted under `key`; a wrong one is counted.
    fn counted(&self, key: &str, user: &User, kind: &str, check: impl FnOnce() -> Result<bool, String>) -> Code {
        let refused = |codes: &mut HashMap<String, WrongCodes>| {
            codes.retain(|_, wrong| wrong.since.elapsed() < WRONG_CODES_WINDOW);
            codes.get(key).is_some_and(|wrong| wrong.count >= MAX_WRONG_CODES)
        };
        if refused(&mut self.wrong_codes.lock().expect("the wrong codes' lock")) {
            return Code::Refused;
        }
        let right = match check() {
            Ok(right) => right,
            Err(e) => {
                error!(user = %user.user_name, error = %e, kind, "two-step verification: could not check the code");
                return Code::Wrong;
            }
        };
        let mut codes = self.wrong_codes.lock().expect("the wrong codes' lock");
        // looked at again: codes sent at once are all past the first look before any is counted
        if refused(&mut codes) {
            return Code::Refused;
        }
        if right {
            return Code::Right;
        }
        let wrong = codes.entry(key.to_string()).or_insert(WrongCodes { since: Instant::now(), count: 0 });
        wrong.count += 1;
        if wrong.count == MAX_WRONG_CODES {
            warn!(username = %user.user_name, kind, "two-step verification: too many wrong codes for this account, none is taken for an hour");
        }
        Code::Wrong
    }

    /// What a session alone must not do (hand an app a key, make an app password, reset someone's two-step
    /// verification): for an account with two-step verification, a code from its authenticator, or a recovery code.
    /// An account without it (the policy is `off`, or `optional` and not set up) goes on as it is. Err: the answer.
    fn own_code(&self, user: &User, code: &str) -> Result<(), Reply> {
        match self.two_factor_enabled(user) {
            Ok(false) => Ok(()),
            Ok(true) if code.is_empty() => Err(two_factor("code", CODE_REQUIRED)),
            Ok(true) => match self.check_code(user, code) {
                Code::Right => Ok(()),
                Code::Wrong => {
                    warn!(username = %user.user_name, "a wrong verification code was sent with a signed-in request");
                    Err(two_factor("code", INVALID_CODE))
                }
                Code::Refused => Err(fail(StatusCode::TOO_MANY_REQUESTS, TOO_MANY_CODES)),
            },
            Err(e) => {
                error!(user = %user.user_name, error = %e, "two-step verification: could not read the user's setup");
                Err(fail(StatusCode::INTERNAL_SERVER_ERROR, UNKNOWN_ERROR))
            }
        }
    }

    /// The enrolment code a first set-up must carry: Ok(None) when this set-up needs none, Ok(Some) the code that
    /// checked out, Err the answer. None is needed when the policy is not `required` (whoever is signed in turns
    /// two-step verification on for themselves), and for the first admin, by the token `createAdmin` answered.
    fn enrolment(&self, user: &User, first_admin: bool, code: String) -> Result<Option<String>, Reply> {
        if self.policy != TwoFactor::Required || first_admin {
            return Ok(None);
        }
        if code.trim().is_empty() {
            return Err(two_factor("enrolment", "Enrolment code required"));
        }
        match self.check_enrolment_code(user, &code) {
            Code::Right => Ok(Some(code)),
            Code::Wrong => {
                warn!(username = %user.user_name, "two-step verification: a set-up was refused, wrong enrolment code");
                Err(two_factor("enrolment", "Invalid enrolment code"))
            }
            Code::Refused => Err(fail(StatusCode::TOO_MANY_REQUESTS, TOO_MANY_ENROLMENT_CODES)),
        }
    }

    fn create_admin(&self, sent: &Sent) -> Reply {
        let Some(data) = sent.string_map() else { return fail(StatusCode::UNPROCESSABLE_ENTITY, BAD_PAYLOAD) };
        let (username, password) = (text(&data, "username"), text(&data, "password"));
        match store::create_first_admin(&self.db, &self.keys, username, password) {
            Ok(true) => {
                warn!(user = username, "the first user, an admin, was created");
                self.sign_in(username, password, "", None, true)
            }
            Ok(false) => fail(StatusCode::FORBIDDEN, "Cannot create another first admin"),
            Err(e) => {
                error!(error = %e, "could not create the first user");
                fail(StatusCode::INTERNAL_SERVER_ERROR, &format!("creating initial user: {e}"))
            }
        }
    }

    // ------------------------------------------------------------ setting two-step verification up

    /// A setup route's body: `token` (a setup token, a session's, or else the session header's), `code`,
    /// `enrolmentCode` (a first set-up's, when the server requires two-step verification) and `appPassword` (the name
    /// of an app password to make with the sign-in a confirmation ends in).
    fn setup_request(&self, sent: &Sent) -> Option<SetupRequest> {
        let [token, code, enrolment, app_password] = sent.fields(["token", "code", "enrolmentCode", "appPassword"])?;
        let named =
            sent.json().is_some_and(|body| body.as_object().is_some_and(|o| o.iter().any(|(k, v)| k.eq_ignore_ascii_case("appPassword") && v.is_string())));
        Some(SetupRequest { token: if token.is_empty() { sent.bearer.clone() } else { token }, code, enrolment, app_password: named.then_some(app_password) })
    }

    /// Starts setting an authenticator up: a new secret, its link and QR code. Replacing one already in use takes a
    /// code from it (or a recovery code) first.
    fn setup_begin(&self, sent: &Sent) -> Reply {
        if self.policy == TwoFactor::Off {
            return fail(StatusCode::FORBIDDEN, "Two-step verification is turned off on this server");
        }
        let Some(SetupRequest { token, code, enrolment, .. }) = self.setup_request(sent) else { return fail(StatusCode::UNPROCESSABLE_ENTITY, BAD_PAYLOAD) };
        let Some((user, first_admin)) = self.user_for_setup(&token) else { return fail(StatusCode::UNAUTHORIZED, NOT_AUTHENTICATED) };
        match self.two_factor_enabled(&user) {
            Err(e) => return fail(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
            Ok(true) => match self.check_code(&user, &code) {
                Code::Right => {}
                Code::Wrong => return two_factor("code", INVALID_CODE),
                Code::Refused => return fail(StatusCode::TOO_MANY_REQUESTS, TOO_MANY_CODES),
            },
            // a first set-up: nothing is made, no secret handed out, without the enrolment code
            Ok(false) => {
                if let Err(reply) = self.enrolment(&user, first_admin, enrolment) {
                    return reply;
                }
            }
        }
        let (secret, uri) = match store::begin_setup(&self.db, &self.keys, &user.id, &user.user_name) {
            Ok(begun) => begun,
            Err(e) => {
                error!(user = %user.user_name, error = %e, "two-step verification: could not start the setup");
                return fail(StatusCode::INTERNAL_SERVER_ERROR, "Could not start the setup");
            }
        };
        let qr = totp::qr_code(&uri).unwrap_or_else(|e| {
            error!(error = %e, "two-step verification: could not draw the QR code");
            String::new()
        });
        ok(json!({ "secret": secret, "uri": uri, "qr": qr, "issuer": totp::ISSUER, "account": user.user_name }))
    }

    /// Checks a code from the new authenticator; when it is right, that authenticator is the one in use, the user gets
    /// their recovery codes, and is signed in (as the sign-in answers).
    fn setup_confirm(&self, sent: &Sent) -> Reply {
        let Some(SetupRequest { token, code, enrolment, app_password }) = self.setup_request(sent) else {
            return fail(StatusCode::UNPROCESSABLE_ENTITY, BAD_PAYLOAD);
        };
        let Some((user, first_admin)) = self.user_for_setup(&token) else { return fail(StatusCode::UNAUTHORIZED, NOT_AUTHENTICATED) };
        // a first set-up is confirmed with the enrolment code too: knowing a secret that waits is not enough (one may
        // wait from before enrolment codes), and the code is used up with the confirmation
        let enrolment = match store::is_set_up(&self.db, &user.id) {
            Ok(true) => None,
            Ok(false) => match self.enrolment(&user, first_admin, enrolment) {
                Ok(enrolment) => enrolment,
                Err(reply) => return reply,
            },
            Err(e) => return fail(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
        };
        let codes = match store::confirm_setup(&self.db, &self.keys, &user.id, &code, enrolment.as_deref(), Utc::now()) {
            Ok(codes) => codes,
            Err(store::ConfirmError::InvalidCode) => return two_factor("setup", INVALID_CODE),
            Err(store::ConfirmError::InvalidEnrolment) => return two_factor("enrolment", "Invalid enrolment code"),
            Err(store::ConfirmError::NoSetup) => return fail(StatusCode::CONFLICT, "No two-step verification being set up"),
            Err(store::ConfirmError::Store(e)) => {
                error!(user = %user.user_name, error = %e, "two-step verification: could not confirm the setup");
                return fail(StatusCode::INTERNAL_SERVER_ERROR, "Could not confirm the setup");
            }
        };
        info!(username = %user.user_name, "two-step verification set up");
        // the account's sessions from before have ended with it (store::end_sessions): this one gets a new token
        let user = match store::find_user(&self.db, &self.keys, &user.user_name) {
            Ok(Some(found)) if found.id == user.id => found,
            _ => User { token_epoch: user.token_epoch + 1, ..user },
        };
        let mut payload = self.with_app_password(&user, app_password.as_deref(), self.signed_in_payload(&user));
        payload.insert("recoveryCodes".into(), json!(codes));
        ok(Value::Object(payload))
    }

    // ------------------------------------------------------------ signed in: the user's own

    /// `for_admin`: an admin looking at a user also sees whether an enrolment code waits for them.
    fn status(&self, user_id: &str, for_admin: bool) -> Reply {
        match store::status(&self.db, user_id) {
            Ok(status) => {
                let mut body = Map::new();
                let mode = match self.policy {
                    TwoFactor::Required => "required",
                    TwoFactor::Optional => "optional",
                    TwoFactor::Off => "off",
                };
                body.insert("mode".into(), json!(mode));
                body.insert("enabled".into(), json!(status.enabled));
                if let Some(at) = status.enabled_at.as_deref().and_then(gotime::stored_to_json) {
                    body.insert("enabledAt".into(), json!(at));
                }
                body.insert("recoveryCodesLeft".into(), json!(status.recovery_codes_left));
                if for_admin {
                    if let Ok(Some(until)) = store::enrolment_code_expiry(&self.db, user_id, Utc::now()) {
                        body.insert("enrolmentCodeExpiresAt".into(), json!(gotime::to_json(&until)));
                    }
                }
                ok(Value::Object(body))
            }
            Err(e) => fail(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
        }
    }

    /// The fork's `withCode`: runs `then` after a code from the user's authenticator (or a recovery code) checks out.
    fn with_code(&self, user: &User, sent: &Sent, then: impl FnOnce(&Auth, &User) -> Reply) -> Reply {
        let Some([_, code]) = sent.fields(["token", "code"]) else { return fail(StatusCode::UNPROCESSABLE_ENTITY, BAD_PAYLOAD) };
        match self.check_code(user, &code) {
            Code::Right => then(self, user),
            Code::Wrong => two_factor("code", INVALID_CODE),
            Code::Refused => fail(StatusCode::TOO_MANY_REQUESTS, TOO_MANY_CODES),
        }
    }

    fn disable(&self, user: &User, sent: &Sent) -> Reply {
        if self.policy == TwoFactor::Required {
            return fail(StatusCode::FORBIDDEN, "Two-step verification is required on this server");
        }
        self.with_code(user, sent, |auth, user| match store::disable(&auth.db, &user.id) {
            Ok(()) => {
                info!(username = %user.user_name, "two-step verification turned off");
                no_content()
            }
            Err(e) => fail(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
        })
    }

    fn app_passwords(&self, user: &User) -> Reply {
        match store::app_passwords(&self.db, &user.id) {
            Ok(list) => ok(Value::Array(list.iter().map(app_password_json).collect())),
            Err(e) => fail(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
        }
    }

    fn app_password_create(&self, user: &User, sent: &Sent) -> Reply {
        let Some([name, code]) = sent.fields(["name", "code"]) else { return fail(StatusCode::UNPROCESSABLE_ENTITY, BAD_PAYLOAD) };
        // an app password is a permanent key that skips two-step verification: a session alone does not make one
        if let Err(reply) = self.own_code(user, &code) {
            return reply;
        }
        let name: String = name.chars().take(64).collect();
        match store::create_app_password(&self.db, &self.keys, &user.id, &name, store::Kind::Typed) {
            Ok((made, password)) => {
                info!(username = %user.user_name, name = %made.name, "app password created");
                ok(json!({ "appPassword": app_password_json(&made), "password": password }))
            }
            Err(e) => fail(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
        }
    }

    fn app_password_delete(&self, user: &User, id: &str) -> Reply {
        match store::delete_app_password(&self.db, &user.id, id) {
            Ok(true) => {
                info!(username = %user.user_name, "app password revoked");
                no_content()
            }
            Ok(false) => fail(StatusCode::NOT_FOUND, "No such app password"),
            Err(e) => fail(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
        }
    }

    // ------------------------------------------------------------ admins: someone else's

    fn admin_only(&self, user: &User, then: impl FnOnce() -> Reply) -> Reply {
        if !user.is_admin {
            return fail(StatusCode::FORBIDDEN, "Only admins can do this");
        }
        then()
    }

    /// Removes someone's two-step verification (a lost phone and no recovery codes): they set it up again at their next
    /// sign-in. Their app passwords keep working. It takes the admin's own verification code: an admin's session is
    /// otherwise worth every account. Where two-step verification is required, the answer carries the enrolment code
    /// the user sets it up again with (`enrolmentCode`, `expiresAt`), shown this once.
    fn user_reset(&self, admin: &User, user_id: &str, sent: &Sent) -> Reply {
        let Some(code) = sent.code() else { return fail(StatusCode::UNPROCESSABLE_ENTITY, BAD_PAYLOAD) };
        if let Err(reply) = self.own_code(admin, &code) {
            return reply;
        }
        if let Err(e) = store::disable(&self.db, user_id) {
            return fail(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string());
        }
        warn!(admin = %admin.user_name, user_id, "two-step verification reset by an admin");
        if self.policy != TwoFactor::Required {
            return no_content();
        }
        match self.issue_enrolment_code(admin, user_id) {
            // as before enrolment codes: resetting someone who is not there changes nothing and says so with 204
            Err(reply) if reply.status == StatusCode::NOT_FOUND => no_content(),
            Ok(reply) | Err(reply) => reply,
        }
    }

    /// Makes an enrolment code for a user without two-step verification: one who was just made (through Navidrome's
    /// own API, which knows nothing of these codes), or who was there before the server asked for them. An earlier
    /// code of theirs stops working. It takes the admin's own verification code.
    fn user_enrolment_code(&self, admin: &User, user_id: &str, sent: &Sent) -> Reply {
        if self.policy != TwoFactor::Required {
            return fail(StatusCode::CONFLICT, "Enrolment codes are used only where two-step verification is required");
        }
        let Some(code) = sent.code() else { return fail(StatusCode::UNPROCESSABLE_ENTITY, BAD_PAYLOAD) };
        if let Err(reply) = self.own_code(admin, &code) {
            return reply;
        }
        match self.issue_enrolment_code(admin, user_id) {
            Ok(reply) | Err(reply) => reply,
        }
    }

    /// Ok: the code and when it stops working. Err: why there is none.
    fn issue_enrolment_code(&self, admin: &User, user_id: &str) -> Result<Reply, Reply> {
        match store::issue_enrolment_code(&self.db, user_id, &admin.id, Utc::now()) {
            Ok(store::Issued::Code(code, until)) => {
                info!(admin = %admin.user_name, user_id, "an enrolment code was made");
                Ok(ok(json!({ "enrolmentCode": code, "expiresAt": gotime::to_json(&until) })))
            }
            Ok(store::Issued::NoSuchUser) => Err(fail(StatusCode::NOT_FOUND, "No such user")),
            Ok(store::Issued::AlreadySetUp) => Err(fail(StatusCode::CONFLICT, "Two-step verification is set up for this user: reset it first")),
            Err(e) => {
                error!(admin = %admin.user_name, user_id, error = %e, "could not make an enrolment code");
                Err(fail(StatusCode::INTERNAL_SERVER_ERROR, "Could not make an enrolment code"))
            }
        }
    }

    // ------------------------------------------------------------ the browser sign-in for apps

    fn device_start(&self, sent: &Sent) -> Reply {
        let Some([client, device]) = sent.fields(["client", "device"]) else { return fail(StatusCode::UNPROCESSABLE_ENTITY, BAD_PAYLOAD) };
        match self.devices.start(&client, &device, &sent.address, &sent.client) {
            Ok(started) => ok(json!({
                "deviceCode": started.device_code,
                "userCode": started.user_code,
                "verificationPath": format!("{}/app/#/device?code={}", self.base_path, started.user_code),
                "expiresIn": device::LIFETIME.as_secs(),
                "interval": device::INTERVAL,
            })),
            Err(device::StartError::TooMany) => fail(StatusCode::TOO_MANY_REQUESTS, "Too many sign-ins waiting; try again in a few minutes"),
            Err(device::StartError::Random) => fail(StatusCode::INTERNAL_SERVER_ERROR, "no random bytes"),
        }
    }

    fn device_poll(&self, sent: &Sent) -> Reply {
        let Some([device_code]) = sent.fields(["deviceCode"]) else { return fail(StatusCode::UNPROCESSABLE_ENTITY, BAD_PAYLOAD) };
        ok(match self.devices.poll(&device_code) {
            device::Poll::Pending => json!({ "status": "pending", "interval": device::INTERVAL }),
            device::Poll::Approved { api_key, username } => json!({ "status": "approved", "apiKey": api_key, "username": username }),
            device::Poll::Denied => json!({ "status": "denied" }),
            device::Poll::Expired => json!({ "status": "expired" }),
        })
    }

    /// An app signing out gives its own API key back.
    fn device_revoke(&self, sent: &Sent) -> Reply {
        let Some([api_key]) = sent.fields(["apiKey"]).filter(|[key]| !key.is_empty()) else { return fail(StatusCode::UNPROCESSABLE_ENTITY, BAD_PAYLOAD) };
        match store::revoke_api_key(&self.db, &api_key) {
            Ok(true) => {
                info!("an API key was given back by its app");
                no_content()
            }
            Ok(false) => fail(StatusCode::NOT_FOUND, "No such API key"),
            Err(e) => fail(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
        }
    }

    const NO_SIGN_IN_WAITING: &'static str = "No sign-in waiting for this code: it may have expired";

    /// What asks: the app and device as they named themselves, the address the request came from, and whether
    /// allowing it takes a verification code of the user who looks.
    fn device_info(&self, user: &User, code: &str) -> Reply {
        match self.devices.info(code) {
            Some(info) => ok(json!({
                "userCode": info.user_code,
                "client": info.client,
                "device": info.device,
                "address": info.address,
                "expiresIn": info.expires_in,
                "codeRequired": !matches!(self.two_factor_enabled(user), Ok(false)),
            })),
            None => fail(StatusCode::NOT_FOUND, Self::NO_SIGN_IN_WAITING),
        }
    }

    /// The signed-in user allows the app: an API key is made for it, named after the app and the device. With
    /// two-step verification, it takes a verification code: someone signed in who is talked into opening an
    /// attacker's approval link does not hand a permanent key over with one click.
    fn device_approve(&self, user: &User, code: &str, sent: &Sent) -> Reply {
        let Some(own) = sent.code() else { return fail(StatusCode::UNPROCESSABLE_ENTITY, BAD_PAYLOAD) };
        // a code is used by being checked: not for a sign-in that is not there
        if self.devices.info(code).is_none() {
            return fail(StatusCode::NOT_FOUND, Self::NO_SIGN_IN_WAITING);
        }
        if let Err(reply) = self.own_code(user, &own) {
            return reply;
        }
        let make_key = |name: &str| store::create_app_password(&self.db, &self.keys, &user.id, name, store::Kind::Handed).map(|(_, key)| key);
        match self.devices.approve(code, &user.user_name, make_key) {
            Some(Ok(())) => {
                info!(username = %user.user_name, "browser sign-in allowed");
                no_content()
            }
            Some(Err(e)) => {
                error!(username = %user.user_name, error = %e, "browser sign-in: could not make the API key");
                fail(StatusCode::INTERNAL_SERVER_ERROR, "Could not sign the app in")
            }
            None => fail(StatusCode::NOT_FOUND, Self::NO_SIGN_IN_WAITING),
        }
    }

    fn device_deny(&self, user: &User, code: &str) -> Reply {
        if self.devices.deny(code) {
            info!(username = %user.user_name, "browser sign-in refused");
            no_content()
        } else {
            fail(StatusCode::NOT_FOUND, Self::NO_SIGN_IN_WAITING)
        }
    }

    // ------------------------------------------------------------ answers

    fn respond(&self, reply: Reply, rate: Option<Verdict>, request: &HeaderMap) -> Response<Body> {
        let mut response = if reply.status == StatusCode::TOO_MANY_REQUESTS && reply.body.is_none() {
            // httprate's refusal: Go's http.Error
            self.plain(StatusCode::TOO_MANY_REQUESTS, "Too Many Requests\n", request, None)
        } else {
            let (bytes, json) = match &reply.body {
                Some(body) => (Bytes::from(body.to_string()), true),
                None => (Bytes::new(), false),
            };
            let mut response = Response::new(full(bytes));
            *response.status_mut() = reply.status;
            if json {
                response.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
            }
            navidrome_headers(response.headers_mut(), request, &self.frame_options);
            response
        };
        if let Some(rate) = rate {
            let h = response.headers_mut();
            h.insert("x-ratelimit-limit", HeaderValue::from(rate.limit));
            h.insert("x-ratelimit-remaining", HeaderValue::from(rate.remaining));
            h.insert("x-ratelimit-reset", HeaderValue::from(rate.reset));
            if rate.limited {
                h.insert(header::RETRY_AFTER, HeaderValue::from(rate.retry_after));
            }
        }
        response
    }

    /// A text answer as Go's `http.Error` and chi's 404 and 405 write them.
    fn plain(&self, status: StatusCode, text: &'static str, request: &HeaderMap, allow: Option<&[&'static str]>) -> Response<Body> {
        let mut response = Response::new(full(Bytes::from_static(text.as_bytes())));
        *response.status_mut() = status;
        let h = response.headers_mut();
        if !text.is_empty() {
            h.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/plain; charset=utf-8"));
        }
        for method in allow.unwrap_or_default() {
            h.append(header::ALLOW, HeaderValue::from_static(method));
        }
        navidrome_headers(h, request, &self.frame_options);
        response
    }
}

fn full(bytes: Bytes) -> Body {
    Full::new(bytes).map_err(|never| match never {}).boxed()
}

fn app_password_json(ap: &store::AppPassword) -> Value {
    let mut body = Map::new();
    body.insert("id".into(), json!(ap.id));
    body.insert("name".into(), json!(ap.name));
    body.insert("createdAt".into(), json!(ap.created_at));
    if let Some(at) = &ap.last_used_at {
        body.insert("lastUsedAt".into(), json!(at));
    }
    if !ap.last_used_by.is_empty() {
        body.insert("lastUsedBy".into(), json!(ap.last_used_by));
    }
    Value::Object(body)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn found(method: &str, path: &str) -> Result<Route, Miss> {
        route(&Method::from_bytes(method.as_bytes()).unwrap(), path)
    }

    #[test]
    fn routes_are_found_as_navidromes_router_finds_them() {
        assert_eq!(found("POST", "/login"), Ok(Route::Login));
        assert_eq!(found("POST", "/createAdmin"), Ok(Route::CreateAdmin));
        assert_eq!(found("GET", "/2fa"), Ok(Route::Status));
        assert_eq!(found("POST", "/2fa/recovery-codes"), Ok(Route::RecoveryCodes));
        assert_eq!(found("GET", "/app-passwords"), Ok(Route::AppPasswords));
        assert_eq!(found("POST", "/app-passwords"), Ok(Route::AppPasswordCreate));
        assert_eq!(found("DELETE", "/app-passwords/abc"), Ok(Route::AppPasswordDelete("abc".into())));
        assert_eq!(found("GET", "/2fa/users/u1"), Ok(Route::UserStatus("u1".into())));
        assert_eq!(found("POST", "/2fa/users/u1/reset"), Ok(Route::UserReset("u1".into())));
        assert_eq!(found("POST", "/2fa/users/u1/enrolment-code"), Ok(Route::UserEnrolmentCode("u1".into())));
        assert_eq!(found("GET", "/2fa/users/u1/enrolment-code"), Err(Miss::MethodNotAllowed(vec!["POST"])));
        assert_eq!(found("POST", "/device/start"), Ok(Route::DeviceStart));
        assert_eq!(found("GET", "/device/BCDF-GHJK"), Ok(Route::DeviceInfo("BCDF-GHJK".into())));
        assert_eq!(found("POST", "/device/BCDF-GHJK/approve"), Ok(Route::DeviceApprove("BCDF-GHJK".into())));
        assert_eq!(found("POST", "/device/BCDF-GHJK/deny"), Ok(Route::DeviceDeny("BCDF-GHJK".into())));
        // a literal path of another method is a code to the route with a parameter, as in chi
        assert_eq!(found("GET", "/device/start"), Ok(Route::DeviceInfo("start".into())));
    }

    #[test]
    fn other_paths_are_404_and_other_methods_405() {
        for path in ["", "/", "/nothing", "/login/", "/Login", "/2fa/users", "/2fa/users/", "/device", "/device/", "/device/a/b/c", "/app-passwords/a/b"] {
            assert_eq!(found("GET", path), Err(Miss::NotFound), "{path}");
        }
        assert_eq!(found("GET", "/login"), Err(Miss::MethodNotAllowed(vec!["POST"])));
        assert_eq!(found("PUT", "/app-passwords"), Err(Miss::MethodNotAllowed(vec!["GET", "POST"])));
        assert_eq!(found("GET", "/app-passwords/abc"), Err(Miss::MethodNotAllowed(vec!["DELETE"])));
        assert_eq!(found("POST", "/2fa"), Err(Miss::MethodNotAllowed(vec!["GET"])));
        assert_eq!(found("POST", "/device/BCDF-GHJK"), Err(Miss::MethodNotAllowed(vec!["GET"])));
        assert_eq!(found("HEAD", "/2fa"), Err(Miss::MethodNotAllowed(vec!["GET"])));
    }

    #[test]
    fn the_limited_and_the_signed_in_routes_are_navidromes() {
        let all = [
            (Route::Login, true, false),
            (Route::CreateAdmin, false, false),
            (Route::Setup, true, false),
            (Route::Confirm, true, false),
            (Route::Status, false, true),
            (Route::RecoveryCodes, true, true),
            (Route::Disable, true, true),
            (Route::AppPasswords, false, true),
            (Route::AppPasswordCreate, false, true),
            (Route::AppPasswordDelete(String::new()), false, true),
            (Route::UserStatus(String::new()), false, true),
            (Route::UserReset(String::new()), false, true),
            (Route::UserEnrolmentCode(String::new()), false, true),
            (Route::DeviceStart, true, false),
            (Route::DevicePoll, false, false),
            (Route::DeviceRevoke, true, false),
            (Route::DeviceInfo(String::new()), false, true),
            (Route::DeviceApprove(String::new()), false, true),
            (Route::DeviceDeny(String::new()), false, true),
        ];
        for (found, limited, signed_in) in all {
            assert_eq!((found.limited(), found.signed_in()), (limited, signed_in), "{found:?}");
        }
    }

    fn sent(body: &str) -> Sent {
        Sent {
            bearer: String::new(),
            cookie: String::new(),
            query: String::new(),
            proxy_user: None,
            address: String::new(),
            client: String::new(),
            body: Some(Bytes::from(body.to_string())),
        }
    }

    #[test]
    fn bodies_are_decoded_as_gos_json_decoder_decodes_them() {
        assert_eq!(sent(r#"{"token":"t","code":"123456"}"#).fields(["token", "code"]), Some(["t".to_string(), "123456".to_string()]));
        assert_eq!(
            sent(r#"{"Token":"t","CODE":"1","more":[1]}"#).fields(["token", "code"]),
            Some(["t".to_string(), "1".to_string()]),
            "names in any case; the rest ignored"
        );
        assert_eq!(sent(r#"{"code":null}"#).fields(["token", "code"]), Some([String::new(), String::new()]));
        assert_eq!(sent("null").fields(["code"]), Some([String::new()]));
        assert_eq!(sent(r#"{"code":"1"} trailing"#).fields(["code"]), Some(["1".to_string()]), "the first value only");
        assert_eq!(sent(r#"{"code":123456}"#).fields(["code"]), None, "a number is not a string");
        assert_eq!(sent("[]").fields(["code"]), None);
        assert_eq!(sent("").fields(["code"]), None);
        assert_eq!(sent("{").fields(["code"]), None);
        assert_eq!(Sent { body: None, ..sent("") }.fields(["code"]), None, "a body longer than 8 KB");

        let map = sent(r#"{"username":"alice","password":"p","otp":null}"#).string_map().unwrap();
        assert_eq!((text(&map, "username"), text(&map, "otp"), text(&map, "missing")), ("alice", "", ""));
        assert!(sent(r#"{"username":"alice","remember":true}"#).string_map().is_none(), "every value must be a string");
        assert!(sent(r#"{"Username":"alice"}"#).string_map().is_some_and(|m| text(&m, "username").is_empty()), "a map's keys are as written");
        assert!(sent("null").string_map().is_some_and(|m| m.is_empty()));
        assert!(sent("").string_map().is_none());
    }

    #[test]
    fn tokens_are_found_where_navidrome_looks() {
        let mut headers = HeaderMap::new();
        headers.insert("x-nd-authorization", HeaderValue::from_static("Bearer abc.def"));
        assert_eq!(bearer(&headers), "abc.def");
        headers.insert("x-nd-authorization", HeaderValue::from_static("bearer abc.def"));
        assert_eq!(bearer(&headers), "abc.def");
        for not_one in ["abc.def", "Bearer", "Bearer ", "Basic abcdefgh"] {
            headers.insert("x-nd-authorization", HeaderValue::from_static(not_one));
            assert_eq!(bearer(&headers), "", "{not_one}");
        }
        assert_eq!(bearer(&HeaderMap::new()), "");

        let mut headers = HeaderMap::new();
        headers.insert(header::COOKIE, HeaderValue::from_static("theme=dark; jwt=abc.def; other=1"));
        assert_eq!(cookie(&headers, "jwt"), "abc.def");
        assert_eq!(cookie(&headers, "jw"), "");
        assert_eq!(cookie(&HeaderMap::new(), "jwt"), "");
    }
}
