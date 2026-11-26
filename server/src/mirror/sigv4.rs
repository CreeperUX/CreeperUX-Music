//! AWS Signature Version 4, as S3 (and R2, which speaks S3) checks it: the `Authorization` header of the mirror's
//! own requests, and presigned query strings (the links clients are sent to, part R2-b). Written here rather than
//! taken from the AWS SDK, which would bring far more than these few hashes; checked against the examples AWS
//! publishes for S3 (the tests below), not against itself.
//!
//! The secret key never leaves this module's `Signer`: nothing prints it, and its `Debug` says only that it is set.

use chrono::{DateTime, Utc};
use hmac::{Hmac, KeyInit, Mac};
use sha2::{Digest, Sha256};

use crate::secrets::hex;

/// The payload hash of a request without a body (`sha256("")`).
pub const EMPTY_SHA256: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
/// A presigned link's payload hash: S3 does not hash what a GET carries.
pub const UNSIGNED_PAYLOAD: &str = "UNSIGNED-PAYLOAD";

/// The longest a presigned link may live (S3's own limit: 7 days).
pub const MAX_EXPIRES: u64 = 7 * 24 * 3600;

pub struct Signer {
    access_key_id: String,
    secret_access_key: String,
    region: String,
}

impl std::fmt::Debug for Signer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Signer").field("access_key_id", &"(set)").field("secret_access_key", &"(set)").field("region", &self.region).finish()
    }
}

/// A request to sign: its method, its path as sent (already encoded, see `encode_path`), its query (decoded pairs,
/// in any order) and its headers (any case; `host` among them).
pub struct Request<'a> {
    pub method: &'a str,
    pub path: &'a str,
    pub query: &'a [(String, String)],
    pub headers: &'a [(String, String)],
    pub payload_sha256: &'a str,
}

impl Signer {
    pub fn new(access_key_id: &str, secret_access_key: &str, region: &str) -> Signer {
        Signer { access_key_id: access_key_id.to_string(), secret_access_key: secret_access_key.to_string(), region: region.to_string() }
    }

    /// The `Authorization` header's value for a request sent at `time`, whose headers already carry `x-amz-date`
    /// (`amz_date(time)`) and `x-amz-content-sha256` (the payload hash).
    pub fn authorization(&self, request: &Request, time: DateTime<Utc>) -> String {
        let (signed_headers, canonical_headers) = canonical_headers(request.headers);
        let canonical = canonical_request(request, &canonical_headers, &signed_headers);
        let signature = self.signature(&canonical, time);
        format!("AWS4-HMAC-SHA256 Credential={}/{},SignedHeaders={signed_headers},Signature={signature}", self.access_key_id, self.scope(time))
    }

    /// A presigned GET or HEAD link's query string (`X-Amz-…=…&…`, encoded), for an object at `path` (encoded) on
    /// `host`, valid `expires` seconds from `time`. Only `host` is signed: whoever holds the link can fetch that one
    /// object until it expires, and nothing else.
    pub fn presign(&self, method: &str, host: &str, path: &str, time: DateTime<Utc>, expires: u64) -> String {
        let query = vec![
            ("X-Amz-Algorithm".to_string(), "AWS4-HMAC-SHA256".to_string()),
            ("X-Amz-Credential".to_string(), format!("{}/{}", self.access_key_id, self.scope(time))),
            ("X-Amz-Date".to_string(), amz_date(time)),
            ("X-Amz-Expires".to_string(), expires.min(MAX_EXPIRES).to_string()),
            ("X-Amz-SignedHeaders".to_string(), "host".to_string()),
        ];
        let headers = [("host".to_string(), host.to_string())];
        let request = Request { method, path, query: &query, headers: &headers, payload_sha256: UNSIGNED_PAYLOAD };
        let (signed_headers, canonical_headers) = canonical_headers(request.headers);
        let canonical = canonical_request(&request, &canonical_headers, &signed_headers);
        let signature = self.signature(&canonical, time);
        format!("{}&X-Amz-Signature={signature}", canonical_query(&query))
    }

    fn scope(&self, time: DateTime<Utc>) -> String {
        format!("{}/{}/s3/aws4_request", time.format("%Y%m%d"), self.region)
    }

    fn signature(&self, canonical_request: &str, time: DateTime<Utc>) -> String {
        let string_to_sign = format!("AWS4-HMAC-SHA256\n{}\n{}\n{}", amz_date(time), self.scope(time), sha256_hex(canonical_request.as_bytes()));
        let date = hmac(format!("AWS4{}", self.secret_access_key).as_bytes(), time.format("%Y%m%d").to_string().as_bytes());
        let region = hmac(&date, self.region.as_bytes());
        let service = hmac(&region, b"s3");
        let key = hmac(&service, b"aws4_request");
        hex(&hmac(&key, string_to_sign.as_bytes()))
    }
}

/// `20130524T000000Z`: the time as `x-amz-date` carries it.
pub fn amz_date(time: DateTime<Utc>) -> String {
    time.format("%Y%m%dT%H%M%SZ").to_string()
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

fn hmac(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC takes any key length");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

/// An object key as a path: every byte but the unreserved ones and `/` percent-encoded (S3 encodes the path once).
pub fn encode_path(key: &str) -> String {
    encode(key, true)
}

/// A query name or value, encoded as SigV4 wants: every byte but `A-Z a-z 0-9 - _ . ~`.
pub fn encode_component(text: &str) -> String {
    encode(text, false)
}

fn encode(text: &str, keep_slash: bool) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') || (keep_slash && byte == b'/') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// The query as SigV4 and S3 want it: each pair encoded, sorted by name then value, `name=value` joined with `&`.
pub fn canonical_query(query: &[(String, String)]) -> String {
    let mut pairs: Vec<(String, String)> = query.iter().map(|(n, v)| (encode_component(n), encode_component(v))).collect();
    pairs.sort();
    pairs.iter().map(|(n, v)| format!("{n}={v}")).collect::<Vec<_>>().join("&")
}

/// (signed header names, canonical header lines).
fn canonical_headers(headers: &[(String, String)]) -> (String, String) {
    let mut lines: Vec<(String, String)> =
        headers.iter().map(|(name, value)| (name.to_ascii_lowercase(), value.split_whitespace().collect::<Vec<_>>().join(" "))).collect();
    lines.sort();
    let signed = lines.iter().map(|(n, _)| n.as_str()).collect::<Vec<_>>().join(";");
    let canonical = lines.iter().map(|(n, v)| format!("{n}:{v}\n")).collect::<String>();
    (signed, canonical)
}

fn canonical_request(request: &Request, canonical_headers: &str, signed_headers: &str) -> String {
    format!("{}\n{}\n{}\n{canonical_headers}\n{signed_headers}\n{}", request.method, request.path, canonical_query(request.query), request.payload_sha256)
}

#[cfg(test)]
mod tests {
    //! The examples of AWS's "Authenticating Requests: Using the Authorization Header" and "Using Query Parameters"
    //! pages for S3 (Signature Version 4): their example keys, time and requests, and the signatures AWS gives.

    use super::*;
    use chrono::TimeZone;

    fn aws() -> (Signer, DateTime<Utc>) {
        (Signer::new("AKIAIOSFODNN7EXAMPLE", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "us-east-1"), Utc.with_ymd_and_hms(2013, 5, 24, 0, 0, 0).unwrap())
    }

    fn pairs(list: &[(&str, &str)]) -> Vec<(String, String)> {
        list.iter().map(|(n, v)| (n.to_string(), v.to_string())).collect()
    }

    fn signature_of(authorization: &str) -> &str {
        authorization.rsplit("Signature=").next().unwrap()
    }

    #[test]
    fn get_object() {
        let (signer, time) = aws();
        let headers = pairs(&[
            ("Host", "examplebucket.s3.amazonaws.com"),
            ("Range", "bytes=0-9"),
            ("x-amz-content-sha256", EMPTY_SHA256),
            ("x-amz-date", "20130524T000000Z"),
        ]);
        let request = Request { method: "GET", path: "/test.txt", query: &[], headers: &headers, payload_sha256: EMPTY_SHA256 };
        let authorization = signer.authorization(&request, time);
        assert_eq!(
            authorization,
            "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,\
             SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,\
             Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
        );
    }

    #[test]
    fn put_object() {
        let (signer, time) = aws();
        let body = sha256_hex(b"Welcome to Amazon S3.");
        assert_eq!(body, "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072");
        let headers = pairs(&[
            ("Date", "Fri, 24 May 2013 00:00:00 GMT"),
            ("Host", "examplebucket.s3.amazonaws.com"),
            ("x-amz-date", "20130524T000000Z"),
            ("x-amz-storage-class", "REDUCED_REDUNDANCY"),
            ("x-amz-content-sha256", &body),
        ]);
        let path = encode_path("/test$file.text");
        assert_eq!(path, "/test%24file.text");
        let request = Request { method: "PUT", path: &path, query: &[], headers: &headers, payload_sha256: &body };
        assert_eq!(signature_of(&signer.authorization(&request, time)), "98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd");
    }

    #[test]
    fn get_bucket_lifecycle() {
        let (signer, time) = aws();
        let headers = pairs(&[("Host", "examplebucket.s3.amazonaws.com"), ("x-amz-date", "20130524T000000Z"), ("x-amz-content-sha256", EMPTY_SHA256)]);
        let query = pairs(&[("lifecycle", "")]);
        let request = Request { method: "GET", path: "/", query: &query, headers: &headers, payload_sha256: EMPTY_SHA256 };
        assert_eq!(signature_of(&signer.authorization(&request, time)), "fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543");
    }

    #[test]
    fn list_objects() {
        let (signer, time) = aws();
        let headers = pairs(&[("Host", "examplebucket.s3.amazonaws.com"), ("x-amz-date", "20130524T000000Z"), ("x-amz-content-sha256", EMPTY_SHA256)]);
        // in the order AWS writes them, which is not the sorted one
        let query = pairs(&[("prefix", "J"), ("max-keys", "2")]);
        let request = Request { method: "GET", path: "/", query: &query, headers: &headers, payload_sha256: EMPTY_SHA256 };
        assert_eq!(signature_of(&signer.authorization(&request, time)), "34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7");
    }

    #[test]
    fn presigned_get() {
        let (signer, time) = aws();
        let query = signer.presign("GET", "examplebucket.s3.amazonaws.com", "/test.txt", time, 86400);
        assert_eq!(
            query,
            "X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request\
             &X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host\
             &X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404"
        );
    }

    #[test]
    fn no_secret_in_debug() {
        let (signer, _) = aws();
        let shown = format!("{signer:?}");
        assert!(!shown.contains("EXAMPLEKEY") && !shown.contains("AKIA"), "{shown}");
    }

    #[test]
    fn encoding() {
        assert_eq!(encode_component("a b+c/d~e"), "a%20b%2Bc%2Fd~e");
        assert_eq!(encode_path("m/abc/0123"), "m/abc/0123");
        assert_eq!(encode_path("x/é"), "x/%C3%A9");
    }
}
