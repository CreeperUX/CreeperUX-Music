//! Which forwarding headers to believe, and so who the client is. This reproduces Navidrome's own rules (its
//! `realIPMiddleware`, chi's `ClientIPFrom*` middlewares, and `UsernameFromExtAuthHeader`), so putting the gateway in
//! front changes nothing: the gateway decides with the trusted list the container already has, then hands Navidrome
//! one clean `X-Real-IP` and trusts nothing else.

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

/// The client's address. From a trusted peer, as Navidrome reads it: `True-Client-IP`, else `X-Real-IP` (the last of
/// each, when sent more than once), else the rightmost `X-Forwarded-For` hop that isn't itself trusted, else the peer.
/// A header whose value is not an address is skipped. From anyone else, the peer, whatever the headers claim.
pub fn client_ip(peer: IpAddr, headers: &HeaderMap, trusted: &TrustList) -> IpAddr {
    let peer = peer.to_canonical();
    if !trusted.contains(peer) {
        return peer;
    }
    header_ip(headers, "true-client-ip").or_else(|| header_ip(headers, "x-real-ip")).or_else(|| forwarded_for(headers, trusted)).unwrap_or(peer)
}

fn header_ip(headers: &HeaderMap, name: &str) -> Option<IpAddr> {
    let value = headers.get_all(name).iter().next_back()?.to_str().ok()?;
    // Go's header parsing trims the value before chi reads it
    parse_ip(value.trim_matches([' ', '\t']))
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
    fn a_trusted_peer_is_believed_in_navidromes_order() {
        let list = TrustList::parse("10.0.0.0/8");
        let peer = ip("10.0.0.2");
        let all = headers(&[("x-forwarded-for", "203.0.113.1"), ("x-real-ip", "203.0.113.2"), ("true-client-ip", "203.0.113.3")]);
        assert_eq!(client_ip(peer, &all, &list), ip("203.0.113.3"));
        let two = headers(&[("x-forwarded-for", "203.0.113.1"), ("x-real-ip", "203.0.113.2")]);
        assert_eq!(client_ip(peer, &two, &list), ip("203.0.113.2"));
        let xff = headers(&[("x-forwarded-for", "203.0.113.1")]);
        assert_eq!(client_ip(peer, &xff, &list), ip("203.0.113.1"));
        assert_eq!(client_ip(peer, &HeaderMap::new(), &list), peer);
    }

    #[test]
    fn a_header_sent_twice_counts_by_its_last_value() {
        // a proxy that adds its own X-Real-IP after the client's: the client's is not the one believed
        let list = TrustList::parse("10.0.0.0/8");
        let added = headers(&[("x-real-ip", "6.6.6.6"), ("x-real-ip", "203.0.113.2")]);
        assert_eq!(client_ip(ip("10.0.0.2"), &added, &list), ip("203.0.113.2"));
    }

    #[test]
    fn what_is_not_an_address_is_skipped() {
        let list = TrustList::parse("10.0.0.0/8");
        let peer = ip("10.0.0.2");
        let bad = headers(&[("true-client-ip", "203.0.113.3:443"), ("x-real-ip", "[2001:db8::1]"), ("x-forwarded-for", "203.0.113.1")]);
        assert_eq!(client_ip(peer, &bad, &list), ip("203.0.113.1"), "with a port or brackets, Navidrome does not take it either");
        let zoned = headers(&[("x-real-ip", "fe80::1%eth0")]);
        assert_eq!(client_ip(peer, &zoned, &list), ip("fe80::1"));
        let mapped = headers(&[("x-real-ip", "::ffff:203.0.113.9")]);
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
