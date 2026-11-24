//! Settings, from the environment. The container keeps Navidrome's: the gateway listens on `ND_ADDRESS`:`ND_PORT` (where
//! Navidrome used to), believes the proxies in `ND_EXTAUTH_TRUSTEDSOURCES`, and starts Navidrome with everything else
//! as it was. Its own settings start with `SONUS_`.

use std::ffi::OsString;
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;

use hyper::Uri;
use hyper::header::HeaderName;

use crate::trust::TrustList;

/// Where Navidrome listens inside the container when the gateway runs it.
pub const DEFAULT_NAVIDROME_PORT: u16 = 4534;

#[derive(Debug)]
pub struct Config {
    /// Where clients connect.
    pub listen: SocketAddr,
    /// Navidrome's address, `http://127.0.0.1:4534` when the gateway runs it.
    pub upstream: Uri,
    /// How to run Navidrome; none when `SONUS_NAVIDROME_URL` points at one that runs on its own.
    pub navidrome: Option<NavidromeProcess>,
    /// The proxies in front of the gateway whose forwarding headers are believed (see `trust`).
    pub trusted: TrustList,
    /// Navidrome's external-auth user header (`Remote-User`): passed on only from trusted proxies.
    pub user_header: HeaderName,
}

#[derive(Debug, Clone)]
pub struct NavidromeProcess {
    pub bin: PathBuf,
    pub port: u16,
    /// The container's own arguments, passed on to Navidrome.
    pub args: Vec<OsString>,
}

impl Config {
    pub fn from_env() -> Result<Config, String> {
        Self::from_lookup(|name| std::env::var(name).ok(), std::env::args_os().skip(1).collect())
    }

    /// `from_env` with the variables read through `var`, for tests.
    pub fn from_lookup(var: impl Fn(&str) -> Option<String>, args: Vec<OsString>) -> Result<Config, String> {
        let get = |name: &str| var(name).map(|v| v.trim().to_string()).filter(|v| !v.is_empty());

        if get("ND_TLSCERT").is_some() || get("ND_TLSKEY").is_some() {
            return Err("ND_TLSCERT/ND_TLSKEY are set, but the Sonus server serves plain HTTP: put TLS in a proxy in front of it, \
                        or unset them"
                .into());
        }
        let address = get("ND_ADDRESS").unwrap_or_else(|| "0.0.0.0".into());
        if address.starts_with("unix:") {
            return Err(format!("ND_ADDRESS={address}: the Sonus server listens on TCP only"));
        }
        let ip: IpAddr = address.trim_start_matches('[').trim_end_matches(']').parse().map_err(|_| format!("ND_ADDRESS={address} is not an address"))?;
        let port = parse_port(get("ND_PORT"), "ND_PORT", 4533)?;
        let listen = SocketAddr::new(ip, port);

        let trusted = TrustList::parse(&get("ND_EXTAUTH_TRUSTEDSOURCES").or_else(|| get("ND_REVERSEPROXYWHITELIST")).unwrap_or_default());
        let user_header = get("ND_EXTAUTH_USERHEADER").or_else(|| get("ND_REVERSEPROXYUSERHEADER")).unwrap_or_else(|| "Remote-User".into());
        let user_header = HeaderName::try_from(user_header.as_str()).map_err(|_| format!("{user_header} is not a header name"))?;

        let (upstream, navidrome) = match get("SONUS_NAVIDROME_URL") {
            Some(url) => {
                let uri: Uri = url.trim_end_matches('/').parse().map_err(|_| format!("SONUS_NAVIDROME_URL={url} is not a URL"))?;
                if uri.scheme_str() != Some("http") || uri.authority().is_none() {
                    return Err(format!("SONUS_NAVIDROME_URL={url}: an http:// address is needed"));
                }
                (uri, None)
            }
            None => {
                let internal = parse_port(get("SONUS_NAVIDROME_PORT"), "SONUS_NAVIDROME_PORT", DEFAULT_NAVIDROME_PORT)?;
                if internal == port {
                    return Err(format!("Navidrome's port ({internal}) is the gateway's own: set SONUS_NAVIDROME_PORT to another"));
                }
                let bin = get("SONUS_NAVIDROME_BIN").map(PathBuf::from).unwrap_or_else(default_navidrome_bin);
                let uri = format!("http://127.0.0.1:{internal}").parse().expect("a valid URI");
                (uri, Some(NavidromeProcess { bin, port: internal, args }))
            }
        };
        Ok(Config { listen, upstream, navidrome, trusted, user_header })
    }
}

fn parse_port(value: Option<String>, name: &str, default: u16) -> Result<u16, String> {
    match value {
        None => Ok(default),
        Some(v) => v.parse::<u16>().ok().filter(|p| *p != 0).ok_or_else(|| format!("{name}={v} is not a port")),
    }
}

/// `/app/navidrome` in the image; elsewhere whatever `navidrome` is on the PATH.
fn default_navidrome_bin() -> PathBuf {
    let image = PathBuf::from("/app/navidrome");
    if image.exists() { image } else { PathBuf::from("navidrome") }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn config(vars: &[(&str, &str)]) -> Result<Config, String> {
        let vars: HashMap<String, String> = vars.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        Config::from_lookup(|name| vars.get(name).cloned(), vec!["--flag".into()])
    }

    #[test]
    fn defaults_take_navidromes_place() {
        let c = config(&[]).unwrap();
        assert_eq!(c.listen, "0.0.0.0:4533".parse().unwrap());
        assert_eq!(c.upstream, "http://127.0.0.1:4534");
        let nd = c.navidrome.unwrap();
        assert_eq!(nd.port, 4534);
        assert_eq!(nd.args, vec![OsString::from("--flag")]);
        assert!(c.trusted.is_empty());
        assert_eq!(c.user_header, "remote-user");
    }

    #[test]
    fn navidromes_settings_are_read_as_navidrome_reads_them() {
        let c = config(&[("ND_ADDRESS", "127.0.0.1"), ("ND_PORT", "8080"), ("ND_REVERSEPROXYWHITELIST", "10.0.0.0/8"), ("ND_REVERSEPROXYUSERHEADER", "X-User")]).unwrap();
        assert_eq!(c.listen, "127.0.0.1:8080".parse().unwrap());
        assert!(c.trusted.contains("10.1.1.1".parse().unwrap()));
        assert_eq!(c.user_header, "x-user");
        let c = config(&[("ND_EXTAUTH_TRUSTEDSOURCES", "172.16.0.0/12"), ("ND_REVERSEPROXYWHITELIST", "10.0.0.0/8")]).unwrap();
        assert!(c.trusted.contains("172.16.0.1".parse().unwrap()), "the current name wins over the old one");
        assert!(!c.trusted.contains("10.1.1.1".parse().unwrap()));
        assert!(config(&[("ND_ADDRESS", "[::]")]).unwrap().listen.is_ipv6());
    }

    #[test]
    fn an_external_navidrome_is_only_proxied() {
        let c = config(&[("SONUS_NAVIDROME_URL", "http://127.0.0.1:4799/")]).unwrap();
        assert_eq!(c.upstream, "http://127.0.0.1:4799");
        assert!(c.navidrome.is_none());
        assert!(config(&[("SONUS_NAVIDROME_URL", "https://example.com")]).is_err());
    }

    #[test]
    fn what_the_gateway_cannot_do_stops_it() {
        assert!(config(&[("ND_TLSCERT", "/data/cert.pem")]).unwrap_err().contains("TLS"));
        assert!(config(&[("ND_ADDRESS", "unix:/tmp/nd.sock")]).is_err());
        assert!(config(&[("ND_PORT", "4534")]).unwrap_err().contains("SONUS_NAVIDROME_PORT"));
        assert!(config(&[("ND_PORT", "http")]).is_err());
    }
}
