//! The parts of the API the gateway answers or checks itself instead of passing them to Navidrome: one entry per
//! part, each in its own module. Everything else passes through (gateway.rs).
//!
//! To add a part: a variant of `Local`, its paths in `find`, and its arm where the gateway dispatches
//! (`Gateway::handle`). Paths are matched as Navidrome's router (chi) matches them: literally and case-sensitively,
//! under `BaseURL`'s path; a path spelled any other way is not ours, so Navidrome answers it as it always did.

use hyper::header::HeaderMap;
use hyper::{Method, header};

use crate::subsonic;

#[derive(Debug, PartialEq)]
pub enum Local {
    /// A Subsonic method behind the sign-in (`/rest/<method>`, `/rest/<method>.view`): the gateway checks the
    /// credentials (subsonic/mod.rs) and Navidrome answers the method, except `tokenInfo`, answered here.
    Subsonic(&'static str),
    /// Everything under `/auth` (auth/mod.rs): the web sign-in, two-step verification, app passwords, the browser
    /// sign-in for apps. Answered here whole, unknown paths included; the path after `/auth`.
    Auth(String),
}

/// What the gateway does itself with a request, None for what is Navidrome's alone. `base_path` is `BaseURL`'s path
/// (`/music`), empty when none.
pub fn find(method: &Method, path: &str, headers: &HeaderMap, base_path: &str) -> Option<Local> {
    let path = path.strip_prefix(base_path.trim_end_matches('/'))?;
    if let Some(name) = path.strip_prefix("/rest/") {
        // Navidrome's router answers every HTTP method there and checks the sign-in for each, so each is checked
        // here: none is a second door with a limiter of its own. Only a CORS preflight is answered by Navidrome before
        // any sign-in (its CORS middleware), and carries none.
        if method == Method::OPTIONS && headers.contains_key(header::ACCESS_CONTROL_REQUEST_METHOD) {
            return None;
        }
        return subsonic::protected_method(name).map(Local::Subsonic);
    }
    if let Some(rest) = path.strip_prefix("/auth") {
        // a CORS preflight is Navidrome's CORS middleware's to answer, here too
        let preflight = method == Method::OPTIONS && headers.contains_key(header::ACCESS_CONTROL_REQUEST_METHOD);
        if (rest.is_empty() || rest.starts_with('/')) && !preflight {
            return Some(Local::Auth(rest.to_string()));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn get(path: &str, base_path: &str) -> Option<Local> {
        find(&Method::GET, path, &HeaderMap::new(), base_path)
    }

    #[test]
    fn subsonic_methods_behind_the_sign_in_are_checked_here() {
        assert_eq!(get("/rest/ping", ""), Some(Local::Subsonic("ping")));
        assert_eq!(get("/rest/ping.view", ""), Some(Local::Subsonic("ping")));
        assert_eq!(get("/rest/stream", ""), Some(Local::Subsonic("stream")));
        assert_eq!(get("/rest/connect", ""), Some(Local::Subsonic("connect")));
        assert_eq!(get("/music/rest/ping", "/music"), Some(Local::Subsonic("ping")));
        assert_eq!(get("/music/rest/ping", "/music/"), Some(Local::Subsonic("ping")));
        // whatever the HTTP method: Navidrome checks the sign-in for each
        for method in [Method::POST, Method::HEAD, Method::OPTIONS, Method::PUT, Method::PATCH, Method::DELETE, Method::TRACE] {
            assert_eq!(find(&method, "/rest/ping", &HeaderMap::new(), ""), Some(Local::Subsonic("ping")), "{method}");
        }
    }

    #[test]
    fn everything_under_auth_is_answered_here() {
        assert_eq!(get("/auth/login", ""), Some(Local::Auth("/login".into())));
        assert_eq!(get("/auth", ""), Some(Local::Auth(String::new())));
        assert_eq!(get("/auth/", ""), Some(Local::Auth("/".into())));
        assert_eq!(get("/auth/no/such/route", ""), Some(Local::Auth("/no/such/route".into())), "unknown paths too: none reaches Navidrome");
        assert_eq!(get("/music/auth/device/start", "/music"), Some(Local::Auth("/device/start".into())));
        assert_eq!(find(&Method::DELETE, "/auth/app-passwords/x", &HeaderMap::new(), ""), Some(Local::Auth("/app-passwords/x".into())));
        let mut preflight = HeaderMap::new();
        preflight.insert(header::ACCESS_CONTROL_REQUEST_METHOD, "POST".parse().unwrap());
        assert_eq!(find(&Method::OPTIONS, "/auth/device/start", &preflight, ""), None, "a CORS preflight is Navidrome's");
        assert_eq!(find(&Method::OPTIONS, "/auth/device/start", &HeaderMap::new(), ""), Some(Local::Auth("/device/start".into())));
    }

    #[test]
    fn everything_else_is_navidromes() {
        assert_eq!(get("/rest/getOpenSubsonicExtensions", ""), None, "no sign-in needed");
        assert_eq!(get("/rest/nothing", ""), None);
        assert_eq!(get("/rest/ping/", ""), None);
        assert_eq!(get("/rest/Ping", ""), None);
        assert_eq!(get("/REST/ping", ""), None);
        assert_eq!(get("//rest/ping", ""), None);
        assert_eq!(get("/rest/pi%6Eg", ""), None, "not decoded: Navidrome's router does not match it either");
        assert_eq!(get("/rest", ""), None);
        assert_eq!(get("/api/song", ""), None);
        assert_eq!(get("/authentic", ""), None);
        assert_eq!(get("/rest/ping", "/music"), None, "outside the base path");
        assert_eq!(get("/music2/rest/ping", "/music"), None);
        // a CORS preflight: answered by Navidrome before any sign-in
        let mut preflight = HeaderMap::new();
        preflight.insert(header::ACCESS_CONTROL_REQUEST_METHOD, "POST".parse().unwrap());
        assert_eq!(find(&Method::OPTIONS, "/rest/ping", &preflight, ""), None);
        assert_eq!(find(&Method::GET, "/rest/ping", &preflight, ""), Some(Local::Subsonic("ping")), "only OPTIONS is a preflight");
    }
}
