//! The Subsonic answers the gateway gives itself (sign-in errors, `tokenInfo`), written as Navidrome writes them: the
//! same envelope (taken from Navidrome itself at start, so `serverVersion` is its own), in the format the request
//! asks for (`f=json`, `f=jsonp` with `callback`, else XML), byte for byte as Go's encoders make them, with HTTP 200
//! and the headers Navidrome's middlewares add to every answer.

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::header::{self, HeaderMap, HeaderValue};
use hyper::{Response, StatusCode};

use crate::gateway::Body;

/// What every Subsonic answer starts with: Navidrome's, read from its `getOpenSubsonicExtensions`.
#[derive(Debug, Clone, PartialEq)]
pub struct Envelope {
    pub version: String,
    pub kind: String,
    pub server_version: String,
    pub open_subsonic: bool,
}

impl Envelope {
    /// From a JSON Subsonic answer of Navidrome's.
    pub fn from_json(body: &[u8]) -> Option<Envelope> {
        let json: serde_json::Value = serde_json::from_slice(body).ok()?;
        let r = json.get("subsonic-response")?;
        Some(Envelope {
            version: r.get("version")?.as_str()?.to_string(),
            kind: r.get("type")?.as_str()?.to_string(),
            server_version: r.get("serverVersion")?.as_str()?.to_string(),
            open_subsonic: r.get("openSubsonic").and_then(|v| v.as_bool()).unwrap_or(false),
        })
    }
}

/// The format a request asks for (`f`), as Navidrome's `sendResponse` decides it.
#[derive(Debug, Clone, PartialEq)]
pub enum Format {
    Json,
    /// With the `callback` parameter.
    Jsonp(Vec<u8>),
    Xml,
}

impl Format {
    pub fn of(f: &[u8], callback: &[u8]) -> Format {
        match f {
            b"json" => Format::Json,
            b"jsonp" => Format::Jsonp(callback.to_vec()),
            _ => Format::Xml,
        }
    }
}

pub enum Payload<'a> {
    Error { code: i32, message: &'a str },
    TokenInfo { username: &'a str },
}

// Subsonic's error codes, and OpenSubsonic's two for API keys
pub const GENERIC: i32 = 0;
pub const MISSING_PARAMETER: i32 = 10;
pub const WRONG_CREDENTIALS: i32 = 40;
pub const CONFLICTING_AUTH: i32 = 43;
pub const INVALID_API_KEY: i32 = 44;
pub const AUTHORIZATION_FAIL: i32 = 50;

/// Navidrome's text for error 40.
pub const WRONG_CREDENTIALS_MESSAGE: &str = "Wrong username or password";

/// The answer's content type and body.
pub fn render(envelope: &Envelope, format: &Format, payload: &Payload) -> (&'static str, Vec<u8>) {
    match format {
        Format::Json => ("application/json", json(envelope, payload).into_bytes()),
        Format::Jsonp(callback) => {
            if !valid_js_identifier(callback) {
                let error = Payload::Error { code: GENERIC, message: "invalid callback parameter" };
                return ("application/json", json(envelope, &error).into_bytes());
            }
            let mut out = callback.clone();
            out.push(b'(');
            out.extend_from_slice(json(envelope, payload).as_bytes());
            out.push(b')');
            ("application/javascript", out)
        }
        Format::Xml => ("application/xml", xml(envelope, payload).into_bytes()),
    }
}

/// Navidrome's `validJSIdentifier`: `^[a-zA-Z_$][a-zA-Z0-9_$.]*$`.
fn valid_js_identifier(name: &[u8]) -> bool {
    let first = |b: u8| b.is_ascii_alphabetic() || b == b'_' || b == b'$';
    match name.split_first() {
        Some((head, rest)) => first(*head) && rest.iter().all(|b| first(*b) || b.is_ascii_digit() || *b == b'.'),
        None => false,
    }
}

fn json(e: &Envelope, payload: &Payload) -> String {
    let status = if matches!(payload, Payload::Error { .. }) { "failed" } else { "ok" };
    let mut out = String::with_capacity(256);
    out.push_str("{\"subsonic-response\":{\"status\":\"");
    out.push_str(status);
    out.push_str("\",\"version\":");
    json_string(&mut out, &e.version);
    out.push_str(",\"type\":");
    json_string(&mut out, &e.kind);
    out.push_str(",\"serverVersion\":");
    json_string(&mut out, &e.server_version);
    if e.open_subsonic {
        out.push_str(",\"openSubsonic\":true");
    }
    match payload {
        Payload::Error { code, message } => {
            out.push_str(&format!(",\"error\":{{\"code\":{code},\"message\":"));
            json_string(&mut out, message);
        }
        Payload::TokenInfo { username } => {
            out.push_str(",\"tokenInfo\":{\"username\":");
            json_string(&mut out, username);
        }
    }
    out.push_str("}}}");
    out
}

/// A string as Go's `encoding/json` writes it (with its HTML escaping, on by default).
fn json_string(out: &mut String, text: &str) {
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '<' | '>' | '&' | '\u{2028}' | '\u{2029}' => out.push_str(&format!("\\u{:04x}", c as u32)),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

fn xml(e: &Envelope, payload: &Payload) -> String {
    let status = if matches!(payload, Payload::Error { .. }) { "failed" } else { "ok" };
    let mut out = String::with_capacity(256);
    out.push_str("<subsonic-response xmlns=\"http://subsonic.org/restapi\" status=\"");
    out.push_str(status);
    out.push_str("\" version=\"");
    xml_text(&mut out, &e.version);
    out.push_str("\" type=\"");
    xml_text(&mut out, &e.kind);
    out.push_str("\" serverVersion=\"");
    xml_text(&mut out, &e.server_version);
    out.push('"');
    if e.open_subsonic {
        out.push_str(" openSubsonic=\"true\"");
    }
    out.push('>');
    match payload {
        Payload::Error { code, message } => {
            out.push_str(&format!("<error code=\"{code}\" message=\""));
            xml_text(&mut out, message);
            out.push_str("\"></error>");
        }
        Payload::TokenInfo { username } => {
            out.push_str("<tokenInfo username=\"");
            xml_text(&mut out, username);
            out.push_str("\"></tokenInfo>");
        }
    }
    out.push_str("</subsonic-response>");
    out
}

/// An attribute value as Go's `encoding/xml` writes it (`xml.EscapeText`).
fn xml_text(out: &mut String, text: &str) {
    for c in text.chars() {
        match c {
            '"' => out.push_str("&#34;"),
            '\'' => out.push_str("&#39;"),
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '\t' => out.push_str("&#x9;"),
            '\n' => out.push_str("&#xA;"),
            '\r' => out.push_str("&#xD;"),
            // not a character XML allows
            c if (c as u32) < 0x20 || c == '\u{fffe}' || c == '\u{ffff}' => out.push('\u{fffd}'),
            c => out.push(c),
        }
    }
}

/// An answer with the headers Navidrome's middlewares give every answer (`server/middlewares.go`: its security
/// headers and CORS, open to every origin), so a browser client on another origin can read the gateway's errors as it
/// reads Navidrome's. Navidrome also compresses answers when asked to; these are sent as they are.
pub fn response(content_type: &'static str, body: Vec<u8>, request: &HeaderMap, frame_options: &HeaderValue) -> Response<Body> {
    let mut r = Response::new(Full::new(Bytes::from(body)).map_err(|never| match never {}).boxed());
    *r.status_mut() = StatusCode::OK;
    r.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    navidrome_headers(r.headers_mut(), request, frame_options);
    r
}

/// The headers Navidrome's middlewares add to every answer, for the answers given here: its security headers, and
/// CORS open to every origin, without credentials, when the request comes from a page (`Origin`).
pub fn navidrome_headers(h: &mut HeaderMap, request: &HeaderMap, frame_options: &HeaderValue) {
    h.insert(header::VARY, HeaderValue::from_static("Origin"));
    if request.get(header::ORIGIN).is_some_and(|origin| !origin.is_empty()) {
        h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
        h.insert(header::ACCESS_CONTROL_EXPOSE_HEADERS, HeaderValue::from_static("X-Content-Duration, X-Total-Count, X-Nd-Authorization"));
    }
    h.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    h.insert(header::X_FRAME_OPTIONS, frame_options.clone());
    h.insert(header::REFERRER_POLICY, HeaderValue::from_static("same-origin"));
    h.insert("permissions-policy", HeaderValue::from_static("autoplay=(), camera=(), microphone=(), usb=()"));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn envelope() -> Envelope {
        Envelope { version: "1.16.1".into(), kind: "navidrome".into(), server_version: "0.64.2-sonus.10 (fb95b5ce)".into(), open_subsonic: true }
    }

    fn text(format: &Format, payload: &Payload) -> (&'static str, String) {
        let (kind, body) = render(&envelope(), format, payload);
        (kind, String::from_utf8(body).unwrap())
    }

    // The expected bytes are Navidrome's own answers (0.64.2-sonus.10), captured from the fork.

    #[test]
    fn json_errors_are_navidromes_bytes() {
        let wrong = Payload::Error { code: WRONG_CREDENTIALS, message: WRONG_CREDENTIALS_MESSAGE };
        assert_eq!(
            text(&Format::Json, &wrong),
            (
                "application/json",
                r#"{"subsonic-response":{"status":"failed","version":"1.16.1","type":"navidrome","serverVersion":"0.64.2-sonus.10 (fb95b5ce)","openSubsonic":true,"error":{"code":40,"message":"Wrong username or password"}}}"#.to_string()
            )
        );
        let missing = Payload::Error { code: MISSING_PARAMETER, message: "missing parameter: 'v'" };
        assert!(text(&Format::Json, &missing).1.ends_with(r#""error":{"code":10,"message":"missing parameter: 'v'"}}}"#));
    }

    #[test]
    fn xml_errors_are_navidromes_bytes() {
        let missing = Payload::Error { code: MISSING_PARAMETER, message: "missing parameter: 'u'" };
        assert_eq!(
            text(&Format::Xml, &missing),
            (
                "application/xml",
                r#"<subsonic-response xmlns="http://subsonic.org/restapi" status="failed" version="1.16.1" type="navidrome" serverVersion="0.64.2-sonus.10 (fb95b5ce)" openSubsonic="true"><error code="10" message="missing parameter: &#39;u&#39;"></error></subsonic-response>"#.to_string()
            )
        );
    }

    #[test]
    fn jsonp_wraps_the_json_in_the_callback() {
        let wrong = Payload::Error { code: WRONG_CREDENTIALS, message: WRONG_CREDENTIALS_MESSAGE };
        let (kind, body) = text(&Format::Jsonp(b"cb".to_vec()), &wrong);
        assert_eq!(kind, "application/javascript");
        assert_eq!(body, format!("cb({})", text(&Format::Json, &wrong).1));
        let (kind, body) = text(&Format::Jsonp(b"a(b".to_vec()), &wrong);
        assert_eq!(kind, "application/json");
        assert!(body.ends_with(r#""error":{"code":0,"message":"invalid callback parameter"}}}"#), "{body}");
        assert_eq!(text(&Format::Jsonp(Vec::new()), &wrong).0, "application/json", "no callback");
        assert!(valid_js_identifier(b"$jQuery_1.cb2"));
        assert!(!valid_js_identifier(b"1cb"));
        assert!(!valid_js_identifier(b"cb;alert"));
    }

    #[test]
    fn the_format_is_decided_as_navidrome_decides_it() {
        assert_eq!(Format::of(b"json", b""), Format::Json);
        assert_eq!(Format::of(b"jsonp", b"cb"), Format::Jsonp(b"cb".to_vec()));
        assert_eq!(Format::of(b"", b""), Format::Xml);
        assert_eq!(Format::of(b"xml", b""), Format::Xml);
        assert_eq!(Format::of(b"JSON", b""), Format::Xml, "f is case-sensitive");
    }

    #[test]
    fn token_info_in_both_formats() {
        let who = Payload::TokenInfo { username: "listener" };
        assert!(text(&Format::Json, &who).1.ends_with(r#""openSubsonic":true,"tokenInfo":{"username":"listener"}}}"#));
        assert!(text(&Format::Json, &who).1.starts_with(r#"{"subsonic-response":{"status":"ok","#));
        assert!(text(&Format::Xml, &who).1.ends_with(r#"openSubsonic="true"><tokenInfo username="listener"></tokenInfo></subsonic-response>"#));
    }

    #[test]
    fn names_are_escaped_as_go_escapes_them() {
        let who = Payload::TokenInfo { username: "a<b>&\"c'\\\n\t\u{1}林\u{2028}" };
        // Go escapes <, >, & and the line separators as \uXXXX, and control characters too
        let u = ['\\', 'u'].iter().collect::<String>();
        let expected = format!(r#"{{"username":"a{u}003cb{u}003e{u}0026\"c'\\\n\t{u}0001林{u}2028"}}"#);
        assert!(text(&Format::Json, &who).1.contains(&expected), "{}", text(&Format::Json, &who).1);
        assert!(text(&Format::Xml, &who).1.contains("username=\"a&lt;b&gt;&amp;&#34;c&#39;\\&#xA;&#x9;\u{fffd}林\u{2028}\""), "{}", text(&Format::Xml, &who).1);
    }

    #[test]
    fn the_envelope_is_navidromes_own() {
        let body = br#"{"subsonic-response":{"status":"ok","version":"1.16.1","type":"navidrome","serverVersion":"0.64.2-sonus.10 (fb95b5ce)","openSubsonic":true,"openSubsonicExtensions":[]}}"#;
        assert_eq!(Envelope::from_json(body), Some(envelope()));
        assert_eq!(Envelope::from_json(b"<html>"), None);
        assert_eq!(Envelope::from_json(br#"{"subsonic-response":{"status":"ok"}}"#), None);
    }

    #[test]
    fn answers_carry_navidromes_headers() {
        let deny = HeaderValue::from_static("DENY");
        let r = response("application/json", b"{}".to_vec(), &HeaderMap::new(), &deny);
        assert_eq!(r.status(), 200);
        assert_eq!(r.headers()["content-type"], "application/json");
        assert_eq!(r.headers()["vary"], "Origin");
        assert_eq!(r.headers()["x-content-type-options"], "nosniff");
        assert_eq!(r.headers()["x-frame-options"], "DENY");
        assert_eq!(r.headers()["referrer-policy"], "same-origin");
        assert_eq!(r.headers()["permissions-policy"], "autoplay=(), camera=(), microphone=(), usb=()");
        assert!(r.headers().get("access-control-allow-origin").is_none(), "no Origin, no CORS headers");
        let mut from_a_page = HeaderMap::new();
        from_a_page.insert("origin", HeaderValue::from_static("https://app.example"));
        let r = response("application/json", b"{}".to_vec(), &from_a_page, &deny);
        assert_eq!(r.headers()["access-control-allow-origin"], "*");
        assert_eq!(r.headers()["access-control-expose-headers"], "X-Content-Duration, X-Total-Count, X-Nd-Authorization");
    }
}
