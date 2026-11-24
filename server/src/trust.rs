//! Which forwarding headers to believe, and so who the client is. The trusted list is read as Navidrome reads it
//! (its `realIPMiddleware`, chi's `ClientIPFromXFFTrustedProxies`, and `UsernameFromExtAuthHeader`); the gateway
//! decides with it, then hands Navidrome one clean `X-Real-IP` and trusts nothing else.
//!
//! Stricter than Navidrome in one thing: from a trusted proxy only `X-Forwarded-For` is believed. Navidrome takes
//! `True-Client-IP` and `X-Real-IP` first, and a proxy set up the usual way (it appends to `X-Forwarded-For`) passes
//! those two on from the client, who would then choose its own address and with it step around every limit kept by
//! address (docs/security-review-2026-11-24.md, F2).

use std::net::{IpAddr, Ipv6Addr};

use hyper::HeaderMap;
use ipnet::IpNet;

/// The proxies whose forwarding headers (and external-auth user header) are believed: Navidrome's
/// `ExtAuth.TrustedSources` (`ReverseProxyWhitelist` before), comma-separated. As in Navidrome, only CIDR entries count
/// (`192.168.1.10/32`, not `192.168.1.10`); `@`, its unix-socket marker, and anything else are skipped.
///
/// Navidrome reads the list twice, differently: whether the peer is a trusted proxy is checked against the entries as
/// written (`validateIPAgainstList`: " 10.0.0.0/8", with its space, matches nothing), while the `X-Forwarded-For` hops
/// are checked against the trimmed entries (`trustedProxyPrefixes`). Both are kept, so the gateway believes exactly
/// whom Navidrome believed.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct TrustList {
    peers: Vec<IpNet>,
    hops: Vec<IpNet>,
}

impl TrustList {
    pub fn parse(list: &str) -> Self {
        if list.is_empty() {
            return TrustList::default();
        }
        TrustList {
            peers: list.split(',').filter_map(|entry| entry.parse::<IpNet>().ok()).collect(),
            hops: list.split(',').filter_map(|entry| entry.trim().parse::<IpNet>().ok()).collect(),
        }
    }

    /// No peer is trusted.
    pub fn is_empty(&self) -> bool {
        self.peers.is_empty()
    }

    /// Whether `peer` (the address the connection came from) is a trusted proxy.
    pub fn contains(&self, peer: IpAddr) -> bool {
        let ip = peer.to_canonical();
        self.peers.iter().any(|net| net.contains(&ip))
    }

    fn contains_hop(&self, hop: IpAddr) -> bool {
        self.hops.iter().any(|net| net.contains(&hop))
    }
}

/// The client's address. From a trusted peer: the rightmost `X-Forwarded-For` hop that isn't itself trusted, else
/// the peer. From anyone else, the peer, whatever the headers claim.
pub fn client_ip(peer: IpAddr, headers: &HeaderMap, trusted: &TrustList) -> IpAddr {
    let peer = peer.to_canonical();
    if !trusted.contains(peer) {
        return peer;
    }
    forwarded_for(headers, trusted).unwrap_or(peer)
}

/// Walks `X-Forwarded-For` from the right (the hops nearest this server first): trusted hops are skipped, the first
/// untrusted one is the client. An entry that isn't an address stops the walk with nothing found (fail closed).
fn forwarded_for(headers: &HeaderMap, trusted: &TrustList) -> Option<IpAddr> {
    let mut hops = Vec::new();
    for value in headers.get_all("x-forwarded-for") {
        let Ok(value) = value.to_str() else { return None };
        hops.extend(value.split(',').map(str::trim).filter(|hop| !hop.is_empty()));
    }
    for hop in hops.iter().rev() {
        let ip = parse_ip(hop)?;
        if !trusted.contains_hop(ip) {
            return Some(ip);
        }
    }
    None
}

/// An address as Go's `netip.ParseAddr` takes it, then as chi stores it: `203.0.113.7`, `2001:db8::1`, or with an IPv6
/// zone (`fe80::1%eth0`, dropped); an IPv4-mapped IPv6 address becomes IPv4. No port, no brackets, no spaces.
fn parse_ip(value: &str) -> Option<IpAddr> {
    if let Some((address, zone)) = value.split_once('%') {
        if zone.is_empty() {
            return None;
        }
        return address.parse::<Ipv6Addr>().ok().map(|ip| IpAddr::V6(ip).to_canonical());
    }
    value.parse::<IpAddr>().ok().map(|ip| ip.to_canonical())
}

#[cfg(test)]
mod tests {
    use super::*;
    use hyper::header::HeaderValue;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    fn headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.append(*name, HeaderValue::from_str(value).unwrap());
        }
        map
    }

    #[test]
    fn only_cidr_entries_count_as_navidrome_reads_them() {
        let list = TrustList::parse("10.0.0.0/8,192.168.1.10,@,172.17.0.1/32,fd00::/8, 172.18.0.0/16,");
        assert!(list.contains(ip("10.1.2.3")));
        assert!(list.contains(ip("172.17.0.1")));
        assert!(list.contains(ip("fd00::1")));
        assert!(!list.contains(ip("192.168.1.10")), "a bare address is not a CIDR: Navidrome ignores it too");
        assert!(!list.contains(ip("172.18.0.1")), "\" 172.18.0.0/16\" is not a CIDR to Navidrome's peer check");
        assert!(list.contains_hop(ip("172.18.0.1")), "but X-Forwarded-For hops are checked against trimmed entries");
        assert!(TrustList::parse("").is_empty());
        assert!(TrustList::parse("@").is_empty());
        assert!(TrustList::parse(" 10.0.0.0/8").is_empty());
    }

    #[test]
    fn an_ipv4_peer_seen_through_ipv6_is_still_ipv4() {
        let list = TrustList::parse("127.0.0.0/8");
        assert!(list.contains(ip("::ffff:127.0.0.1")));
        assert_eq!(client_ip(ip("::ffff:198.51.100.4"), &HeaderMap::new(), &list), ip("198.51.100.4"));
    }

    #[test]
    fn an_untrusted_peer_is_the_client_whatever_it_claims() {
        let claims = headers(&[("x-forwarded-for", "1.2.3.4"), ("x-real-ip", "1.2.3.4"), ("true-client-ip", "1.2.3.4")]);
        assert_eq!(client_ip(ip("198.51.100.4"), &claims, &TrustList::default()), ip("198.51.100.4"));
        let list = TrustList::parse("10.0.0.0/8");
        assert_eq!(client_ip(ip("198.51.100.4"), &claims, &list), ip("198.51.100.4"));
    }

    #[test]
    fn from_a_trusted_peer_only_forwarded_for_is_believed() {
        let list = TrustList::parse("10.0.0.0/8");
        let peer = ip("10.0.0.2");
        // what the client sent and the proxy passed on, beside what the proxy appended
        let all = headers(&[("x-forwarded-for", "203.0.113.1"), ("x-real-ip", "203.0.113.2"), ("true-client-ip", "203.0.113.3")]);
        assert_eq!(client_ip(peer, &all, &list), ip("203.0.113.1"));
        let chosen = headers(&[("x-real-ip", "203.0.113.2"), ("true-client-ip", "203.0.113.3")]);
        assert_eq!(client_ip(peer, &chosen, &list), peer, "no X-Forwarded-For: the proxy itself, never a header the client may have sent");
        assert_eq!(client_ip(peer, &HeaderMap::new(), &list), peer);
    }

    #[test]
    fn addresses_are_read_as_chi_reads_them() {
        let list = TrustList::parse("10.0.0.0/8");
        let peer = ip("10.0.0.2");
        let zoned = headers(&[("x-forwarded-for", "fe80::1%eth0")]);
        assert_eq!(client_ip(peer, &zoned, &list), ip("fe80::1"));
        let mapped = headers(&[("x-forwarded-for", "::ffff:203.0.113.9")]);
        assert_eq!(client_ip(peer, &mapped, &list), ip("203.0.113.9"));
        assert_eq!(parse_ip("fe80::1%"), None);
        assert_eq!(parse_ip("10.0.0.1%eth0"), None);
        assert_eq!(parse_ip(" 10.0.0.1"), None);
    }

    #[test]
    fn forwarded_for_skips_trusted_hops_from_the_right() {
        let list = TrustList::parse("10.0.0.0/8");
        let peer = ip("10.0.0.2");
        let chain = headers(&[("x-forwarded-for", "198.51.100.9, 203.0.113.7, 10.0.0.5"), ("x-forwarded-for", "10.0.0.6")]);
        assert_eq!(client_ip(peer, &chain, &list), ip("203.0.113.7"), "the first untrusted hop from the right");
        let all_trusted = headers(&[("x-forwarded-for", "10.0.0.7, 10.0.0.5")]);
        assert_eq!(client_ip(peer, &all_trusted, &list), peer);
        let garbage = headers(&[("x-forwarded-for", "203.0.113.7, not-an-ip")]);
        assert_eq!(client_ip(peer, &garbage, &list), peer, "fail closed");
        let bracketed = headers(&[("x-forwarded-for", "[2001:db8::1]:443")]);
        assert_eq!(client_ip(peer, &bracketed, &list), peer, "not an address to chi: fail closed");
    }
}
