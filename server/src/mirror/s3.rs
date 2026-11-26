//! The few S3 requests the mirror makes, path-style (`/<bucket>/<key>`), signed with SigV4 in the `Authorization`
//! header: put an object (one request up to `MULTIPART_ABOVE`, a multipart upload past it), HEAD, DELETE, and list.
//! Nothing here logs a request's headers: the signature is in them.
//!
//! HTTPS comes from rustls (with ring and Mozilla's roots compiled in, so the image needs no certificate store); a
//! build without the `tls` feature speaks plain HTTP only, which the settings allow on this machine's own addresses
//! alone (a local test server).

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use chrono::Utc;
use futures_util::stream;
use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Full, Limited, StreamBody};
use hyper::body::{Frame, Incoming};
use hyper::{Request, Response, StatusCode};
use hyper_util::client::legacy::Client;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::rt::TokioExecutor;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncSeekExt};

use super::sigv4::{self, EMPTY_SHA256, Signer};
use super::throttle::Rate;
use crate::secrets::hex;

/// Files past this go up in parts (S3 takes up to 5 GB in one request, but a part lost costs less than a file).
pub const MULTIPART_ABOVE: u64 = 100 * 1024 * 1024;
/// A part's size (S3: at least 5 MiB but the last, at most 10,000 parts: 160 GiB a file).
pub const PART_SIZE: u64 = 16 * 1024 * 1024;
/// The pieces a body is sent in, each waiting for the rate.
const PIECE: usize = 64 * 1024;
/// The most of an answer's body read (S3's XML: a listing of 1000 keys is about 300 kB).
const ANSWER_LIMIT: usize = 4 * 1024 * 1024;
/// How long a request may take: this much, and a slow connection's time for its body.
const REQUEST_TIME: Duration = Duration::from_secs(60);
const SLOWEST_BYTES_PER_SECOND: u64 = 64 * 1024;

#[cfg(feature = "tls")]
type Connector = hyper_rustls::HttpsConnector<HttpConnector>;
#[cfg(not(feature = "tls"))]
type Connector = HttpConnector;

type Body = BoxBody<Bytes, std::io::Error>;

/// Where the bucket is: `https://<account>.r2.cloudflarestorage.com` for R2.
#[derive(Clone, Debug, PartialEq)]
pub struct Endpoint {
    pub https: bool,
    /// `host` or `host:port`.
    pub authority: String,
}

impl Endpoint {
    fn origin(&self) -> String {
        format!("{}://{}", if self.https { "https" } else { "http" }, self.authority)
    }
}

#[derive(Debug)]
pub enum Error {
    /// S3 answered with an error: its status and its `<Code>` (empty when it gave none, as for HEAD).
    Status(u16, String),
    /// No answer: the connection, TLS, or the time allowed.
    Transport(String),
    /// The file changed while it was read: its version is not the one uploaded.
    Changed,
    /// The file could not be read.
    File(String),
    /// An answer this client does not understand.
    Answer(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Status(status, code) if code.is_empty() => write!(f, "S3 answered {status}"),
            Error::Status(status, code) => write!(f, "S3 answered {status} ({code})"),
            Error::Transport(why) => write!(f, "no answer from S3: {why}"),
            Error::Changed => f.write_str("the file changed while it was uploaded"),
            Error::File(why) => write!(f, "the file cannot be read: {why}"),
            Error::Answer(why) => write!(f, "an answer not understood: {why}"),
        }
    }
}

impl Error {
    /// The keys are wrong, revoked or without rights, or the clock is off: nothing works until someone acts.
    pub fn is_refusal(&self) -> bool {
        matches!(self, Error::Status(401 | 403, _))
    }
}

/// A file's size and modification time (nanoseconds since 1970): what its mirrored version is made from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Stamp {
    pub size: u64,
    pub mtime_nanos: i128,
}

impl Stamp {
    pub fn of(path: &Path) -> std::io::Result<Stamp> {
        let meta = std::fs::metadata(path)?;
        if !meta.is_file() {
            return Err(std::io::Error::other("not a file"));
        }
        let mtime = meta.modified()?;
        let mtime_nanos = match mtime.duration_since(std::time::UNIX_EPOCH) {
            Ok(after) => after.as_nanos() as i128,
            Err(before) => -(before.duration().as_nanos() as i128),
        };
        Ok(Stamp { size: meta.len(), mtime_nanos })
    }

    /// The object version: the first 16 hex digits of `sha256("<size>|<mtime>")`.
    pub fn version(&self) -> String {
        sigv4::sha256_hex(format!("{}|{}", self.size, self.mtime_nanos).as_bytes())[..16].to_string()
    }
}

pub struct Object {
    pub key: String,
    pub size: u64,
}

pub struct S3 {
    endpoint: Endpoint,
    bucket: String,
    signer: Signer,
    client: Client<Connector, Body>,
    multipart_above: u64,
    part_size: u64,
}

impl S3 {
    pub fn new(endpoint: Endpoint, bucket: &str, signer: Signer) -> S3 {
        let client = Client::builder(TokioExecutor::new()).pool_idle_timeout(Duration::from_secs(30)).build(connector());
        S3 { endpoint, bucket: bucket.to_string(), signer, client, multipart_above: MULTIPART_ABOVE, part_size: PART_SIZE }
    }

    /// Other sizes for multipart uploads (the tests' small files).
    pub fn with_parts(mut self, above: u64, part_size: u64) -> S3 {
        self.multipart_above = above;
        self.part_size = part_size.max(1);
        self
    }

    /// The object's size, or none when there is no such object.
    pub async fn head(&self, key: &str) -> Result<Option<u64>, Error> {
        let answer = self.send("HEAD", Some(key), &[], &[], empty(), EMPTY_SHA256, 0).await?;
        match answer.status() {
            StatusCode::NOT_FOUND => Ok(None),
            status if status.is_success() => {
                let size = answer.headers().get(hyper::header::CONTENT_LENGTH).and_then(|v| v.to_str().ok()).and_then(|v| v.parse().ok());
                size.map(Some).ok_or_else(|| Error::Answer("a HEAD without Content-Length".into()))
            }
            status => Err(Error::Status(status.as_u16(), String::new())),
        }
    }

    /// Deletes the object; one already gone is no error.
    pub async fn delete(&self, key: &str) -> Result<(), Error> {
        let answer = self.send("DELETE", Some(key), &[], &[], empty(), EMPTY_SHA256, 0).await?;
        match answer.status() {
            status if status.is_success() || status == StatusCode::NOT_FOUND => Ok(()),
            _ => Err(failure(answer).await),
        }
    }

    /// Puts a small object from memory.
    pub async fn put_bytes(&self, key: &str, body: Bytes, content_type: &str) -> Result<(), Error> {
        let hash = sigv4::sha256_hex(&body);
        let length = body.len() as u64;
        let headers = [("content-type".to_string(), content_type.to_string())];
        let answer = self.send("PUT", Some(key), &[], &headers, Full::new(body).map_err(|never| match never {}).boxed(), &hash, length).await?;
        ok(answer).await.map(|_| ())
    }

    /// Uploads the file as it is at `stamp`, at the rate's pace, and checks it went up whole. `Error::Changed` when
    /// the file is not that version any more, before or after.
    pub async fn put_file(&self, key: &str, path: &Path, stamp: Stamp, headers: &[(String, String)], rate: &Arc<Rate>) -> Result<(), Error> {
        let file = |e: std::io::Error| Error::File(e.to_string());
        if Stamp::of(path).map_err(file)? != stamp {
            return Err(Error::Changed);
        }
        if stamp.size > self.multipart_above {
            self.put_parts(key, path, stamp, headers, rate).await?;
        } else {
            // read twice: once for the hash S3 checks the body against, once to send it
            let mut hasher = Sha256::new();
            let mut reader = tokio::fs::File::open(path).await.map_err(file)?;
            let mut buffer = vec![0; 1024 * 1024];
            loop {
                let n = reader.read(&mut buffer).await.map_err(file)?;
                if n == 0 {
                    break;
                }
                hasher.update(&buffer[..n]);
            }
            let hash = hex(&hasher.finalize());
            let reader = tokio::fs::File::open(path).await.map_err(file)?;
            let answer = self.send("PUT", Some(key), &[], headers, file_body(reader, stamp.size, rate.clone()), &hash, stamp.size).await?;
            ok(answer).await?;
        }
        if Stamp::of(path).map_err(file)? != stamp {
            return Err(Error::Changed);
        }
        match self.head(key).await? {
            Some(size) if size == stamp.size => Ok(()),
            Some(size) => Err(Error::Answer(format!("{size} bytes stored of {}", stamp.size))),
            None => Err(Error::Answer("the object is not there after its upload".into())),
        }
    }

    async fn put_parts(&self, key: &str, path: &Path, stamp: Stamp, headers: &[(String, String)], rate: &Arc<Rate>) -> Result<(), Error> {
        let answer = self.send("POST", Some(key), &[pair("uploads", "")], headers, empty(), EMPTY_SHA256, 0).await?;
        let xml = ok(answer).await?;
        let upload_id = tag(&xml, "UploadId").ok_or_else(|| Error::Answer("no UploadId".into()))?;
        let result = self.send_parts(key, path, stamp, &upload_id, rate).await;
        if result.is_err() {
            // best effort; the bucket's lifecycle rule clears what is left
            let _ = self.send("DELETE", Some(key), &[pair("uploadId", &upload_id)], &[], empty(), EMPTY_SHA256, 0).await;
        }
        result
    }

    async fn send_parts(&self, key: &str, path: &Path, stamp: Stamp, upload_id: &str, rate: &Arc<Rate>) -> Result<(), Error> {
        let file = |e: std::io::Error| Error::File(e.to_string());
        let mut reader = tokio::fs::File::open(path).await.map_err(file)?;
        let mut etags = Vec::new();
        let mut offset = 0;
        while offset < stamp.size {
            let length = self.part_size.min(stamp.size - offset);
            let mut part = vec![0; length as usize];
            reader.seek(std::io::SeekFrom::Start(offset)).await.map_err(file)?;
            reader.read_exact(&mut part).await.map_err(file)?;
            let number = (etags.len() + 1).to_string();
            let hash = sigv4::sha256_hex(&part);
            let query = [pair("partNumber", &number), pair("uploadId", upload_id)];
            let answer = self.send("PUT", Some(key), &query, &[], bytes_body(Bytes::from(part), rate.clone()), &hash, length).await?;
            let etag = answer.headers().get(hyper::header::ETAG).and_then(|v| v.to_str().ok()).map(str::to_string);
            ok(answer).await?;
            etags.push(etag.ok_or_else(|| Error::Answer("a part without an ETag".into()))?);
            offset += length;
        }
        if Stamp::of(path).map_err(file)? != stamp {
            return Err(Error::Changed);
        }
        let mut xml = String::from("<CompleteMultipartUpload>");
        for (i, etag) in etags.iter().enumerate() {
            xml.push_str(&format!("<Part><PartNumber>{}</PartNumber><ETag>{}</ETag></Part>", i + 1, escape(etag)));
        }
        xml.push_str("</CompleteMultipartUpload>");
        let body = Bytes::from(xml);
        let (hash, length) = (sigv4::sha256_hex(&body), body.len() as u64);
        let headers = [("content-type".to_string(), "application/xml".to_string())];
        let answer = self
            .send("POST", Some(key), &[pair("uploadId", upload_id)], &headers, Full::new(body).map_err(|never| match never {}).boxed(), &hash, length)
            .await?;
        let answer = ok(answer).await?;
        // S3 may answer 200 and say in the body that it failed
        if answer.contains("<Error>") {
            return Err(Error::Status(200, tag(&answer, "Code").unwrap_or_default()));
        }
        Ok(())
    }

    /// One page of the bucket's objects under `prefix` (up to 1000), and the token for the next page, if any.
    pub async fn list(&self, prefix: &str, after: Option<&str>) -> Result<(Vec<Object>, Option<String>), Error> {
        let mut query = vec![pair("list-type", "2"), pair("prefix", prefix), pair("max-keys", "1000")];
        if let Some(token) = after {
            query.push(pair("continuation-token", token));
        }
        let answer = self.send("GET", None, &query, &[], empty(), EMPTY_SHA256, 0).await?;
        let xml = ok(answer).await?;
        let mut objects = Vec::new();
        for contents in blocks(&xml, "Contents") {
            let key = tag(contents, "Key").ok_or_else(|| Error::Answer("an object without a Key".into()))?;
            let size = tag(contents, "Size").and_then(|s| s.parse().ok()).ok_or_else(|| Error::Answer("an object without a Size".into()))?;
            objects.push(Object { key, size });
        }
        let next = if tag(&xml, "IsTruncated").as_deref() == Some("true") {
            Some(tag(&xml, "NextContinuationToken").ok_or_else(|| Error::Answer("a truncated listing without a token".into()))?)
        } else {
            None
        };
        Ok((objects, next))
    }

    /// Every object under `prefix`.
    pub async fn list_all(&self, prefix: &str) -> Result<Vec<Object>, Error> {
        let mut all = Vec::new();
        let mut after = None;
        loop {
            let (objects, next) = self.list(prefix, after.as_deref()).await?;
            all.extend(objects);
            match next {
                Some(token) => after = Some(token),
                None => return Ok(all),
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn send(
        &self,
        method: &str,
        key: Option<&str>,
        query: &[(String, String)],
        extra: &[(String, String)],
        body: Body,
        payload_sha256: &str,
        length: u64,
    ) -> Result<Response<Incoming>, Error> {
        let path = match key {
            Some(key) => format!("/{}/{}", sigv4::encode_path(&self.bucket), sigv4::encode_path(key)),
            None => format!("/{}", sigv4::encode_path(&self.bucket)),
        };
        let now = Utc::now();
        let mut headers = vec![
            ("host".to_string(), self.endpoint.authority.clone()),
            ("x-amz-date".to_string(), sigv4::amz_date(now)),
            ("x-amz-content-sha256".to_string(), payload_sha256.to_string()),
        ];
        headers.extend(extra.iter().cloned());
        let request = sigv4::Request { method, path: &path, query, headers: &headers, payload_sha256 };
        let authorization = self.signer.authorization(&request, now);
        let query = sigv4::canonical_query(query);
        let uri = if query.is_empty() { format!("{}{path}", self.endpoint.origin()) } else { format!("{}{path}?{query}", self.endpoint.origin()) };
        let mut builder = Request::builder().method(method).uri(uri).header(hyper::header::AUTHORIZATION, authorization);
        for (name, value) in &headers {
            builder = builder.header(name.as_str(), value.as_str());
        }
        if method == "PUT" || method == "POST" {
            builder = builder.header(hyper::header::CONTENT_LENGTH, length);
        }
        let request = builder.body(body).map_err(|e| Error::Transport(format!("cannot make the request: {e}")))?;
        let allowed = REQUEST_TIME + Duration::from_secs(length / SLOWEST_BYTES_PER_SECOND);
        match tokio::time::timeout(allowed, self.client.request(request)).await {
            Ok(Ok(answer)) => Ok(answer),
            Ok(Err(e)) => Err(Error::Transport(transport_reason(&e))),
            Err(_) => Err(Error::Transport(format!("no answer in {} s", allowed.as_secs()))),
        }
    }
}

#[cfg(feature = "tls")]
fn connector() -> Connector {
    let mut http = HttpConnector::new();
    http.enforce_http(false);
    http.set_connect_timeout(Some(Duration::from_secs(15)));
    hyper_rustls::HttpsConnectorBuilder::new()
        .with_provider_and_webpki_roots(rustls::crypto::ring::default_provider())
        .expect("ring's provider supports rustls' default protocol versions")
        .https_or_http()
        .enable_http1()
        .wrap_connector(http)
}

#[cfg(not(feature = "tls"))]
fn connector() -> Connector {
    let mut http = HttpConnector::new();
    http.set_connect_timeout(Some(Duration::from_secs(15)));
    http
}

/// Whether this build speaks HTTPS.
pub const TLS: bool = cfg!(feature = "tls");

/// The error's chain, without the request (whose URL is harmless, but whose headers are not).
fn transport_reason(error: &hyper_util::client::legacy::Error) -> String {
    let mut reason = error.to_string();
    let mut source = std::error::Error::source(error);
    while let Some(cause) = source {
        reason.push_str(": ");
        reason.push_str(&cause.to_string());
        source = cause.source();
    }
    reason
}

fn pair(name: &str, value: &str) -> (String, String) {
    (name.to_string(), value.to_string())
}

fn empty() -> Body {
    Full::new(Bytes::new()).map_err(|never| match never {}).boxed()
}

/// The file's first `size` bytes, piece by piece at the rate's pace.
fn file_body(file: tokio::fs::File, size: u64, rate: Arc<Rate>) -> Body {
    let pieces = stream::unfold((file, size, rate), |(mut file, left, rate)| async move {
        if left == 0 {
            return None;
        }
        let mut piece = vec![0; PIECE.min(left as usize)];
        match file.read(&mut piece).await {
            Ok(0) => Some((Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "the file is shorter than it was")), (file, 0, rate))),
            Ok(n) => {
                piece.truncate(n);
                rate.take(n).await;
                Some((Ok(Frame::data(Bytes::from(piece))), (file, left - n as u64, rate)))
            }
            Err(e) => Some((Err(e), (file, 0, rate))),
        }
    });
    StreamBody::new(pieces).boxed()
}

/// The bytes, piece by piece at the rate's pace.
fn bytes_body(bytes: Bytes, rate: Arc<Rate>) -> Body {
    let pieces = stream::unfold((bytes, rate), |(mut left, rate)| async move {
        if left.is_empty() {
            return None;
        }
        let piece = left.split_to(PIECE.min(left.len()));
        rate.take(piece.len()).await;
        Some((Ok(Frame::data(piece)), (left, rate)))
    });
    StreamBody::new(pieces).boxed()
}

/// The answer's body when it succeeded, else its error.
async fn ok(answer: Response<Incoming>) -> Result<String, Error> {
    if !answer.status().is_success() {
        return Err(failure(answer).await);
    }
    read(answer).await
}

async fn failure(answer: Response<Incoming>) -> Error {
    let status = answer.status().as_u16();
    let code = read(answer).await.ok().and_then(|xml| tag(&xml, "Code")).unwrap_or_default();
    Error::Status(status, code)
}

async fn read(answer: Response<Incoming>) -> Result<String, Error> {
    let body = Limited::new(answer.into_body(), ANSWER_LIMIT).collect().await.map_err(|e| Error::Transport(format!("the answer was cut short: {e}")))?;
    String::from_utf8(body.to_bytes().to_vec()).map_err(|_| Error::Answer("an answer that is not UTF-8".into()))
}

/// The text of the first `<name>…</name>` in the XML, unescaped.
pub fn tag(xml: &str, name: &str) -> Option<String> {
    blocks(xml, name).next().map(unescape)
}

/// The insides of every `<name>…</name>` (S3's XML has no attributes on these, and no nesting of the same name).
pub fn blocks<'a>(xml: &'a str, name: &str) -> impl Iterator<Item = &'a str> {
    let (open, close) = (format!("<{name}>"), format!("</{name}>"));
    let mut rest = xml;
    std::iter::from_fn(move || {
        let start = rest.find(&open)? + open.len();
        let end = start + rest[start..].find(&close)?;
        let inside = &rest[start..end];
        rest = &rest[end + close.len()..];
        Some(inside)
    })
}

fn unescape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        let Some(end) = rest.find(';') else { break };
        let entity = &rest[1..end];
        let decoded = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            _ => entity
                .strip_prefix("#x")
                .and_then(|h| u32::from_str_radix(h, 16).ok())
                .or_else(|| entity.strip_prefix('#').and_then(|d| d.parse().ok()))
                .and_then(char::from_u32),
        };
        match decoded {
            Some(c) => {
                out.push(c);
                rest = &rest[end + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xml() {
        let listing = "<ListBucketResult><IsTruncated>true</IsTruncated><Contents><Key>m/a&amp;b</Key><Size>3</Size></Contents>\
                       <Contents><Key>a/&#x41;&#66;</Key><Size>10</Size></Contents><NextContinuationToken>t=1</NextContinuationToken></ListBucketResult>";
        let keys: Vec<String> = blocks(listing, "Contents").filter_map(|c| tag(c, "Key")).collect();
        assert_eq!(keys, ["m/a&b", "a/AB"]);
        assert_eq!(tag(listing, "NextContinuationToken").as_deref(), Some("t=1"));
        assert_eq!(tag(listing, "Missing"), None);
        assert_eq!(unescape("a &unknown; b & c"), "a &unknown; b & c");
        assert_eq!(escape("\"abc\""), "&quot;abc&quot;");
    }

    #[test]
    fn versions_follow_the_file_not_the_database() {
        let stamp = Stamp { size: 1234, mtime_nanos: 1_700_000_000_123_456_789 };
        assert_eq!(stamp.version(), sigv4::sha256_hex(b"1234|1700000000123456789")[..16]);
        assert_ne!(stamp.version(), Stamp { size: 1235, ..stamp }.version());
        assert_ne!(stamp.version(), Stamp { mtime_nanos: 1, ..stamp }.version());
    }
}
