//! Who is sent to the bucket (`docs/r2-mirror.md`, section 5): a client that asks for it (`sonusMirror=1`), away
//! from home unless the owner says otherwise, with a short-lived presigned link. The links are as good as the object
//! for anyone who holds them, so they go to the signed-in user who asked and nowhere else: not to a log line, not to
//! an error.

use std::net::IpAddr;

use chrono::{DateTime, Utc};
use ipnet::IpNet;

/// Where clients are sent to the bucket from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Policy {
    /// Only from outside the home networks (the owner's choice, the default).
    Away,
    /// From anywhere.
    Always,
    /// Never: the mirror only uploads.
    Never,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Redirects {
    pub policy: Policy,
    /// The home's networks: a client in one of them is at home.
    pub home: Vec<IpNet>,
    /// How long a link holds at least (seconds); it holds up to an hour more (links are signed on the hour).
    pub lifetime: u64,
}

/// The LAN's private ranges and this machine's own addresses (IPv4 and IPv6).
pub const DEFAULT_HOME_NETWORKS: &str = "10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 127.0.0.0/8, ::1/128, fc00::/7, fe80::/10";
pub const DEFAULT_LIFETIME: u64 = 3600;
/// S3's longest presigned link is 7 days; a link signed on the hour holds an hour more than asked.
const LONGEST: u64 = 6 * 24 * 3600;

impl Default for Redirects {
    fn default() -> Redirects {
        Redirects { policy: Policy::Away, home: parse_networks(DEFAULT_HOME_NETWORKS).expect("the default networks"), lifetime: DEFAULT_LIFETIME }
    }
}

impl Redirects {
    /// `SONUS_R2_REDIRECT` (away, always, never), `SONUS_R2_HOME_NETWORKS` (CIDRs, commas between),
    /// `SONUS_R2_LINK_LIFETIME` (1h, 30m, or seconds).
    pub fn from_env(get: &dyn Fn(&str) -> Option<String>) -> Result<Redirects, String> {
        let mut redirects = Redirects::default();
        if let Some(text) = get("SONUS_R2_REDIRECT") {
            redirects.policy = match text.to_ascii_lowercase().as_str() {
                "away" => Policy::Away,
                "always" => Policy::Always,
                "never" | "off" => Policy::Never,
                _ => return Err(format!("SONUS_R2_REDIRECT={text}: away (the default), always or never")),
            };
        }
        if let Some(text) = get("SONUS_R2_HOME_NETWORKS") {
            redirects.home = parse_networks(&text).map_err(|bad| format!("SONUS_R2_HOME_NETWORKS: {bad} is not a network like 192.168.1.0/24"))?;
        }
        if let Some(text) = get("SONUS_R2_LINK_LIFETIME") {
            redirects.lifetime = parse_lifetime(&text).ok_or_else(|| format!("SONUS_R2_LINK_LIFETIME={text} is not a time like 1h or 30m (1m to 6 days)"))?;
        }
        Ok(redirects)
    }

    /// Whether a client at this address may be sent to the bucket.
    pub fn applies(&self, client: IpAddr) -> bool {
        match self.policy {
            Policy::Always => true,
            Policy::Never => false,
            Policy::Away => {
                let client = client.to_canonical();
                !self.home.iter().any(|net| net.contains(&client))
            }
        }
    }

    /// When a link made now is signed, and how many seconds it holds from then: on the hour, so that one object has
    /// one link for the hour (a client's picture cache finds it again), holding at least `lifetime` from now.
    pub fn signing(&self, now: DateTime<Utc>) -> (DateTime<Utc>, u64) {
        let hour = now.timestamp() - now.timestamp().rem_euclid(3600);
        let signed = DateTime::from_timestamp(hour, 0).unwrap_or(now);
        (signed, self.lifetime + 3600)
    }
}

/// Networks with commas between; a bare address is a network of one. Err: the first that is none.
fn parse_networks(text: &str) -> Result<Vec<IpNet>, String> {
    text.split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(|entry| entry.parse::<IpNet>().or_else(|_| entry.parse::<IpAddr>().map(IpNet::from)).map_err(|_| entry.to_string()))
        .collect()
}

fn parse_lifetime(text: &str) -> Option<u64> {
    let text = text.trim().to_ascii_lowercase();
    let (digits, unit) = match text.char_indices().find(|(_, c)| !c.is_ascii_digit()) {
        Some((at, _)) => text.split_at(at),
        None => (text.as_str(), "s"),
    };
    let seconds = digits.parse::<u64>().ok()?.checked_mul(match unit.trim() {
        "s" => 1,
        "m" | "min" => 60,
        "h" => 3600,
        "d" => 24 * 3600,
        _ => return None,
    })?;
    (60..=LONGEST).contains(&seconds).then_some(seconds)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn redirects(vars: &[(&str, &str)]) -> Result<Redirects, String> {
        let map: HashMap<String, String> = vars.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        Redirects::from_env(&|name| map.get(name).cloned())
    }

    fn ip(text: &str) -> IpAddr {
        text.parse().unwrap()
    }

    #[test]
    fn away_from_home_only_by_default() {
        let r = redirects(&[]).unwrap();
        for home in ["192.168.1.20", "10.1.2.3", "172.20.0.5", "127.0.0.1", "::1", "fe80::1", "::ffff:192.168.1.20"] {
            assert!(!r.applies(ip(home)), "{home}");
        }
        for away in ["203.0.113.7", "172.32.0.1", "2001:db8::1", "::ffff:198.51.100.4"] {
            assert!(r.applies(ip(away)), "{away}");
        }
        assert_eq!(r.lifetime, 3600);
    }

    #[test]
    fn the_owner_decides() {
        let r = redirects(&[("SONUS_R2_HOME_NETWORKS", "192.168.50.0/24, 2001:db8:1::/48, 100.64.0.7")]).unwrap();
        assert!(!r.applies(ip("192.168.50.9")) && !r.applies(ip("100.64.0.7")) && !r.applies(ip("2001:db8:1::5")));
        assert!(r.applies(ip("192.168.1.20")) && r.applies(ip("127.0.0.1")), "only the networks named");
        assert!(redirects(&[("SONUS_R2_REDIRECT", "always")]).unwrap().applies(ip("192.168.1.20")));
        assert!(!redirects(&[("SONUS_R2_REDIRECT", "never")]).unwrap().applies(ip("203.0.113.7")));
        assert!(redirects(&[("SONUS_R2_REDIRECT", "sometimes")]).is_err());
        assert!(redirects(&[("SONUS_R2_HOME_NETWORKS", "my lan")]).is_err());
    }

    #[test]
    fn lifetimes() {
        assert_eq!(parse_lifetime("1h"), Some(3600));
        assert_eq!(parse_lifetime("30m"), Some(1800));
        assert_eq!(parse_lifetime("900"), Some(900));
        assert_eq!(parse_lifetime("2d"), Some(172_800));
        for bad in ["10s", "7d", "1y", "", "h"] {
            assert_eq!(parse_lifetime(bad), None, "{bad}");
        }
    }

    #[test]
    fn links_are_signed_on_the_hour_and_hold_at_least_their_lifetime() {
        let r = Redirects::default();
        let now = DateTime::parse_from_rfc3339("2026-11-26T10:59:30Z").unwrap().with_timezone(&Utc);
        let (signed, expires) = r.signing(now);
        assert_eq!(signed.to_rfc3339(), "2026-11-26T10:00:00+00:00");
        assert!(signed.timestamp() + expires as i64 - now.timestamp() >= 3600);
        assert_eq!(r.signing(now - chrono::Duration::minutes(30)).0, signed, "one link for the hour");
    }
}
