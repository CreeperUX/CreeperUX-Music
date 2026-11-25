//! Ported from Navidrome (GPL-3.0), © the Navidrome authors.
//!
//! The public link to an artist's picture that Navidrome puts in `artistImageUrl` (`core/publicurl`,
//! `core/auth.CreatePublicToken`): `<address>/share/img/<token>?size=600`, the token a JWT signed with Navidrome's
//! public secret (`JWTPublicSecret`, a secret of its own beside the session secret) naming the artwork id. The
//! address is Navidrome's: `ShareURL`, else `BaseURL`'s host, else the address the request came to
//! (`X-Forwarded-Host` / `Host`, `X-Forwarded-Proto` / `X-Forwarded-Scheme`, as the gateway passes them on). An
//! address this server cannot write as Go's `url.URL` writes it leaves the answer to Navidrome.

use hyper::header::HeaderMap;

use crate::jwt::{self, Claims, Signer};

/// Navidrome's `consts.URLPathPublicImages`.
const PUBLIC_IMAGES: &str = "/share/img";

/// The settings that decide the address.
#[derive(Debug, Clone, Default)]
pub struct Settings {
    /// `ShareURL`.
    pub share_url: String,
    /// `BaseURL`, from which Navidrome takes `BaseScheme`, `BaseHost` and `BasePath`.
    pub base_url: String,
}

/// What the links of one request are made with.
pub struct ImageLinks {
    signer: Signer,
    /// `<scheme>://<host><base path>/share/img/`.
    prefix: String,
}

impl ImageLinks {
    /// `publicurl.ImageURL(ctx, artist.CoverArtID(), 600)`.
    pub fn artist(&self, id: &str, hash: &str) -> String {
        let art_id = if hash.is_empty() { format!("ar-{id}") } else { format!("ar-{id}_{hash}") };
        let token = self.signer.sign(&Claims { issuer: jwt::ISSUER.into(), id: art_id, ..Claims::default() });
        format!("{}{token}?size=600", self.prefix)
    }
}

/// A URL's scheme, host and path, as Go's `url.Parse` splits an absolute one (no user info, query or fragment
/// expected). None: not absolute.
fn split_url(url: &str) -> Option<(String, &str, &str)> {
    let (scheme, rest) = url.split_once("://")?;
    if scheme.is_empty() || !scheme.starts_with(|c: char| c.is_ascii_alphabetic()) || !scheme.chars().all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c)) {
        return None;
    }
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (host, tail) = rest.split_at(end);
    let path = tail.split(['?', '#']).next().unwrap_or("");
    Some((scheme.to_lowercase(), host, path))
}

/// A host Go writes as it is (no escaping): letters, digits, `.-_:` and an IPv6 literal's brackets.
fn plain_host(host: &str) -> bool {
    !host.is_empty() && host.chars().all(|c| c.is_ascii_alphanumeric() || ".-_:[]".contains(c))
}

/// A path Go writes as it is.
fn plain_path(path: &str) -> bool {
    path.chars().all(|c| c.is_ascii_alphanumeric() || "/-._~".contains(c))
}

/// Go's `path.Join` of a base path and an absolute path.
fn join(base: &str, path: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for part in base.split('/').chain(path.split('/')) {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    format!("/{}", parts.join("/"))
}

/// The prefix of a request's links (`publicurl.PublicURL`), or None when Go would write the address otherwise.
pub fn prefix(settings: &Settings, request: &HeaderMap) -> Option<String> {
    let (scheme, host, base) = if !settings.share_url.is_empty() {
        // ShareURL: its scheme and host, its path (without a trailing slash) before the link's
        let (scheme, host, path) = split_url(&settings.share_url)?;
        (scheme, host.to_string(), path.trim_end_matches('/').to_string())
    } else {
        let base_path;
        let mut base_host = "";
        let mut base_scheme = String::new();
        match split_url(&settings.base_url) {
            Some((scheme, host, path)) => {
                base_scheme = scheme;
                base_host = host;
                base_path = path.to_string();
            }
            None => base_path = settings.base_url.split(['?', '#']).next().unwrap_or("").to_string(),
        }
        if !base_host.is_empty() {
            (if base_scheme.is_empty() { "http".to_string() } else { base_scheme }, base_host.to_string(), base_path)
        } else {
            // ServerAddress: the first X-Forwarded-Host, else Host; X-Forwarded-Proto, else X-Forwarded-Scheme,
            // else plain HTTP (the gateway talks to Navidrome without TLS)
            let header = |name: &str| request.get(name).and_then(|v| v.to_str().ok()).unwrap_or("");
            let forwarded = header("x-forwarded-host");
            let forwarded = forwarded.split(',').next().unwrap_or("");
            let host = if forwarded.is_empty() { header("host") } else { forwarded };
            let scheme = [header("x-forwarded-proto"), header("x-forwarded-scheme")].into_iter().find(|s| !s.is_empty()).unwrap_or("http");
            if scheme != "http" && scheme != "https" {
                return None;
            }
            (scheme.to_string(), host.to_string(), base_path)
        }
    };
    if !plain_host(&host) || !plain_path(&base) {
        return None;
    }
    let path = join(&base, &format!("{PUBLIC_IMAGES}/"));
    Some(format!("{scheme}://{host}{path}/"))
}

/// The links of a request, when Navidrome's public secret is known.
pub fn for_request(signer: Option<&Signer>, settings: &Settings, request: &HeaderMap) -> Option<ImageLinks> {
    Some(ImageLinks { signer: signer?.clone(), prefix: prefix(settings, request)? })
}

#[cfg(test)]
mod tests {
    use super::*;
    use hyper::header::HeaderValue;

    fn headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (name, value) in pairs {
            h.append(*name, HeaderValue::from_str(value).unwrap());
        }
        h
    }

    #[test]
    fn the_address_is_navidromes() {
        let none = Settings::default();
        assert_eq!(prefix(&none, &headers(&[("host", "127.0.0.1:4533")])).as_deref(), Some("http://127.0.0.1:4533/share/img/"));
        // a proxy in front: its forwarded host and scheme, the first host of a list
        let proxied = headers(&[("host", "127.0.0.1:4533"), ("x-forwarded-host", "music.example.com, other"), ("x-forwarded-proto", "https")]);
        assert_eq!(prefix(&none, &proxied).as_deref(), Some("https://music.example.com/share/img/"));
        assert_eq!(prefix(&none, &headers(&[("host", "h"), ("x-forwarded-scheme", "https")])).as_deref(), Some("https://h/share/img/"));
        // BaseURL: its host and path win over the request's; a path alone keeps the request's host
        let base = Settings { base_url: "https://music.example.com/sonus/".into(), ..Settings::default() };
        assert_eq!(prefix(&base, &proxied).as_deref(), Some("https://music.example.com/sonus/share/img/"));
        let path_only = Settings { base_url: "/sonus".into(), ..Settings::default() };
        assert_eq!(prefix(&path_only, &headers(&[("host", "h:1")])).as_deref(), Some("http://h:1/sonus/share/img/"));
        // ShareURL over everything
        let share = Settings { share_url: "https://share.example.com/s/".into(), base_url: "https://music.example.com".into() };
        assert_eq!(prefix(&share, &proxied).as_deref(), Some("https://share.example.com/s/share/img/"));
        // what Go would write some other way: Navidrome's
        assert_eq!(prefix(&none, &headers(&[])), None, "no address at all");
        assert_eq!(prefix(&none, &headers(&[("host", "a b")])), None);
        assert_eq!(prefix(&none, &headers(&[("host", "h"), ("x-forwarded-proto", "javascript")])), None);
        assert_eq!(prefix(&Settings { share_url: "share.example.com".into(), ..Settings::default() }, &proxied), None);
    }

    #[test]
    fn a_link_is_a_token_naming_the_artwork() {
        let signer = Signer::new(b"the public secret");
        let links = ImageLinks { signer: signer.clone(), prefix: "http://h/share/img/".into() };
        let link = links.artist("ar1", "9046b47ac73f2574");
        let token = link.strip_prefix("http://h/share/img/").unwrap().strip_suffix("?size=600").unwrap();
        let claims = signer.verify(token, 0).unwrap();
        assert_eq!((claims.issuer.as_str(), claims.id.as_str()), ("ND", "ar-ar1_9046b47ac73f2574"));
        let payload = token.split('.').nth(1).unwrap();
        use base64::Engine;
        let json = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload).unwrap();
        assert_eq!(json, br#"{"id":"ar-ar1_9046b47ac73f2574","iss":"ND"}"#, "jwx's claims, in key order");
        assert!(links.artist("ar1", "").contains('.'), "an artist whose picture is not settled: no hash");
    }
}
