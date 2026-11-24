//! Which forwarding headers to believe, and so who the client is. This reproduces Navidrome's own rules (its
//! `realIPMiddleware` and `UsernameFromExtAuthHeader`), so putting the gateway in front changes nothing: the gateway
//! decides with the trusted list the container already has, then hands Navidrome one clean `X-Real-IP` and trusts
//! nothing else.

use std::net::IpAddr;

use hyper::HeaderMap;
use ipnet::IpNet;

/// The proxies whose forwarding headers (and external-auth user header) are believed: Navidrome's
/// `ExtAuth.TrustedSources` (`ReverseProxyWhitelist` before), comma-separated. As in Navidrome, only CIDR entries count
/// (`192.168.1.10/32`, not `192.168.1.10`); `@`, its unix-socket marker, and anything else are skipped.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct TrustList(Vec<IpNet>);

impl TrustList {
    pub fn parse(list: &str) -> Self {
        TrustList(list.split(',').filter_map(|entry| entry.trim().parse::<IpNet>().ok()).collect())
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn contains(&self, ip: IpAddr) -> bool {
        let ip = ip.to_canonical();
        self.0.iter().any(|net| net.contains(&ip))
    }
}

/// The client's address. From a trusted peer, as Navidrome reads it: `True-Client-IP`, else `X-Real-IP`, else the
/// rightmost `X-Forwarded-For` hop that isn't itself trusted, else the peer. From anyone else, the peer, whatever the
/// headers claim.
pub fn client_ip(peer: IpAddr, headers: &HeaderMap, trusted: &TrustList) -> IpAddr {
    let peer = peer.to_canonical();
    if !trusted.contains(peer) {
        return peer;
    }
    header_ip(headers, "true-client-ip")
        .or_else(|| header_ip(headers, "x-real-ip"))
        .or_else(|| forwarded_for(headers, trusted))
        .unwrap_or(peer)
}

fn header_ip(headers: &HeaderMap, name: &str) -> Option<IpAddr> {
    let value = headers.get(name)?.to_str().ok()?;
    parse_ip(value)
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
        if !trusted.contains(ip) {
            return Some(ip);
        }
    }
    None
}

/// An address as forwarding headers carry it: `203.0.113.7`, `2001:db8::1`, `[2001:db8::1]` or with a port.
fn parse_ip(value: &str) -> Option<IpAddr> {
    let value = value.trim();
    if let Ok(ip) = value.parse::<IpAddr>() {
        return Some(ip.to_canonical());
    }
    if let Ok(addr) = value.parse::<std::net::SocketAddr>() {
        return Some(addr.ip().to_canonical());
    }
    value.strip_prefix('[')?.strip_suffix(']')?.parse::<IpAddr>().ok().map(|ip| ip.to_canonical())
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
        let list = TrustList::parse(" 10.0.0.0/8, 192.168.1.10, @, 172.17.0.1/32 ,fd00::/8,");
        assert!(list.contains(ip("10.1.2.3")));
        assert!(list.contains(ip("172.17.0.1")));
        assert!(list.contains(ip("fd00::1")));
        assert!(!list.contains(ip("192.168.1.10")), "a bare address is not a CIDR: Navidrome ignores it too");
        assert!(TrustList::parse("").is_empty());
        assert!(TrustList::parse("@").is_empty());
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
        assert_eq!(client_ip(peer, &bracketed, &list), ip("2001:db8::1"));
    }
}
