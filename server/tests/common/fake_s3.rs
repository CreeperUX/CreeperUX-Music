//! A fake S3 on 127.0.0.1 for the R2 mirror's tests: objects in memory, the requests the mirror makes (PUT, multipart
//! uploads, HEAD, DELETE, ListObjectsV2), each checked as S3 checks it (the SigV4 signature with the test's keys,
//! the time within 15 minutes, the body against its signed hash), and faults to switch on.

use std::collections::{BTreeMap, HashMap};
use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use chrono::{DateTime, NaiveDateTime, Utc};
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use sonus_server::mirror::sigv4::{self, Signer};
use tokio::net::TcpListener;

pub const KEY_ID: &str = "fake-key-id";
pub const SECRET: &str = "fake-secret-made-for-the-test";
pub const BUCKET: &str = "music";

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Fault {
    None,
    /// Every request: 403 AccessDenied (revoked keys).
    Refuse,
    /// Every request: 503 (R2 down).
    Down,
    /// PUTs of objects (not parts): 500 InternalError.
    FailPuts,
}

#[derive(Clone, Debug)]
pub struct Stored {
    pub body: Bytes,
    pub content_type: String,
    pub cache_control: String,
}

#[derive(Default)]
pub struct State {
    pub objects: BTreeMap<String, Stored>,
    /// Multipart uploads under way: id → (key, content type, parts by number).
    uploads: HashMap<String, (String, String, BTreeMap<u32, Bytes>)>,
    pub requests: Vec<String>,
    /// Requests refused for their signature.
    pub bad_signatures: usize,
    pub completed_multipart: usize,
    pub aborted_multipart: usize,
}

pub struct FakeS3 {
    pub addr: SocketAddr,
    pub state: Arc<Mutex<State>>,
    pub fault: Arc<Mutex<Fault>>,
}

impl FakeS3 {
    pub async fn start() -> FakeS3 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let state = Arc::new(Mutex::new(State::default()));
        let fault = Arc::new(Mutex::new(Fault::None));
        let (s, f) = (state.clone(), fault.clone());
        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else { return };
                let (state, fault) = (s.clone(), f.clone());
                tokio::spawn(async move {
                    let service = service_fn(move |req| {
                        let (state, fault) = (state.clone(), fault.clone());
                        async move { Ok::<_, Infallible>(handle(req, &state, &fault).await) }
                    });
                    let _ = hyper::server::conn::http1::Builder::new().serve_connection(TokioIo::new(stream), service).await;
                });
            }
        });
        FakeS3 { addr, state, fault }
    }

    pub fn set_fault(&self, fault: Fault) {
        *self.fault.lock().unwrap() = fault;
    }

    pub fn object(&self, key: &str) -> Option<Stored> {
        self.state.lock().unwrap().objects.get(key).cloned()
    }

    pub fn keys(&self) -> Vec<String> {
        self.state.lock().unwrap().objects.keys().cloned().collect()
    }

    pub fn remove(&self, key: &str) {
        self.state.lock().unwrap().objects.remove(key);
    }

    pub fn put(&self, key: &str, body: &[u8]) {
        let stored = Stored { body: Bytes::copy_from_slice(body), content_type: String::new(), cache_control: String::new() };
        self.state.lock().unwrap().objects.insert(key.to_string(), stored);
    }
}

type Answer = Response<Full<Bytes>>;

fn answer(status: StatusCode, body: impl Into<Bytes>) -> Answer {
    Response::builder().status(status).body(Full::new(body.into())).unwrap()
}

fn error(status: StatusCode, code: &str) -> Answer {
    answer(status, format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?><Error><Code>{code}</Code><Message>fake</Message></Error>"))
}

fn decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(&text[i + 1..i + 3], 16) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap()
}

async fn handle(req: Request<Incoming>, state: &Mutex<State>, fault: &Mutex<Fault>) -> Answer {
    let fault = *fault.lock().unwrap();
    let method = req.method().as_str().to_string();
    let path = req.uri().path().to_string();
    let query: Vec<(String, String)> = req
        .uri()
        .query()
        .unwrap_or("")
        .split('&')
        .filter(|p| !p.is_empty())
        .map(|p| {
            let (n, v) = p.split_once('=').unwrap_or((p, ""));
            (decode(n), decode(v))
        })
        .collect();
    let headers: Vec<(String, String)> = req.headers().iter().map(|(n, v)| (n.as_str().to_string(), v.to_str().unwrap_or("").to_string())).collect();
    let header = |name: &str| headers.iter().find(|(n, _)| n == name).map(|(_, v)| v.clone()).unwrap_or_default();
    let body = req.into_body().collect().await.map(|b| b.to_bytes()).unwrap_or_default();
    state.lock().unwrap().requests.push(format!("{method} {path}"));

    match fault {
        Fault::Refuse => return error(StatusCode::FORBIDDEN, "AccessDenied"),
        Fault::Down => return error(StatusCode::SERVICE_UNAVAILABLE, "ServiceUnavailable"),
        _ => {}
    }

    // the signature, as S3 checks it
    let authorization = header("authorization");
    let Some(rest) = authorization.strip_prefix("AWS4-HMAC-SHA256 ") else { return error(StatusCode::FORBIDDEN, "AccessDenied") };
    let fields: HashMap<&str, &str> = rest.split(',').filter_map(|f| f.trim().split_once('=')).collect();
    let (Some(credential), Some(signed), Some(_)) = (fields.get("Credential"), fields.get("SignedHeaders"), fields.get("Signature")) else {
        return error(StatusCode::FORBIDDEN, "AccessDenied");
    };
    if !credential.starts_with(&format!("{KEY_ID}/")) {
        return error(StatusCode::FORBIDDEN, "InvalidAccessKeyId");
    }
    let Ok(time) = NaiveDateTime::parse_from_str(&header("x-amz-date"), "%Y%m%dT%H%M%SZ") else { return error(StatusCode::FORBIDDEN, "AccessDenied") };
    let time: DateTime<Utc> = time.and_utc();
    if (Utc::now() - time).num_seconds().abs() > 15 * 60 {
        return error(StatusCode::FORBIDDEN, "RequestTimeTooSkewed");
    }
    let payload = header("x-amz-content-sha256");
    let signed_headers: Vec<(String, String)> = signed.split(';').map(|name| (name.to_string(), header(name))).collect();
    let expected = Signer::new(KEY_ID, SECRET, "auto")
        .authorization(&sigv4::Request { method: &method, path: &path, query: &query, headers: &signed_headers, payload_sha256: &payload }, time);
    if expected != authorization {
        state.lock().unwrap().bad_signatures += 1;
        return error(StatusCode::FORBIDDEN, "SignatureDoesNotMatch");
    }
    if payload != sigv4::UNSIGNED_PAYLOAD && payload != sigv4::sha256_hex(&body) {
        return error(StatusCode::BAD_REQUEST, "XAmzContentSHA256Mismatch");
    }

    let Some(rest) = path.strip_prefix(&format!("/{BUCKET}")) else { return error(StatusCode::NOT_FOUND, "NoSuchBucket") };
    let key = decode(rest.trim_start_matches('/'));
    let q = |name: &str| query.iter().find(|(n, _)| n == name).map(|(_, v)| v.clone());
    let mut state = state.lock().unwrap();
    match method.as_str() {
        "GET" if key.is_empty() => {
            // ListObjectsV2, two keys a page so that paging is tested
            let prefix = q("prefix").unwrap_or_default();
            let after = q("continuation-token").unwrap_or_default();
            let matching: Vec<(&String, &Stored)> = state.objects.iter().filter(|(k, _)| k.starts_with(&prefix) && k.as_str() > after.as_str()).collect();
            let page = &matching[..matching.len().min(2)];
            let mut xml = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?><ListBucketResult>");
            for (k, o) in page {
                xml.push_str(&format!("<Contents><Key>{}</Key><Size>{}</Size></Contents>", k.replace('&', "&amp;"), o.body.len()));
            }
            if matching.len() > 2 {
                xml.push_str(&format!("<IsTruncated>true</IsTruncated><NextContinuationToken>{}</NextContinuationToken>", page[1].0));
            } else {
                xml.push_str("<IsTruncated>false</IsTruncated>");
            }
            xml.push_str("</ListBucketResult>");
            answer(StatusCode::OK, xml)
        }
        "HEAD" => match state.objects.get(&key) {
            Some(o) => Response::builder().header("content-length", o.body.len()).body(Full::new(Bytes::new())).unwrap(),
            None => answer(StatusCode::NOT_FOUND, Bytes::new()),
        },
        "DELETE" => {
            if let Some(id) = q("uploadId") {
                state.uploads.remove(&id);
                state.aborted_multipart += 1;
            } else {
                state.objects.remove(&key);
            }
            answer(StatusCode::NO_CONTENT, Bytes::new())
        }
        "POST" if q("uploads").is_some() => {
            let id = format!("upload-{}", state.requests.len());
            state.uploads.insert(id.clone(), (key, header("content-type"), BTreeMap::new()));
            answer(StatusCode::OK, format!("<InitiateMultipartUploadResult><UploadId>{id}</UploadId></InitiateMultipartUploadResult>"))
        }
        "POST" => {
            let Some(id) = q("uploadId") else { return error(StatusCode::BAD_REQUEST, "InvalidRequest") };
            let Some((key, content_type, parts)) = state.uploads.remove(&id) else { return error(StatusCode::NOT_FOUND, "NoSuchUpload") };
            let listed = String::from_utf8_lossy(&body).matches("<Part>").count();
            if listed != parts.len() {
                return error(StatusCode::BAD_REQUEST, "InvalidPart");
            }
            let mut whole = Vec::new();
            for part in parts.values() {
                whole.extend_from_slice(part);
            }
            state.objects.insert(key, Stored { body: whole.into(), content_type, cache_control: String::new() });
            state.completed_multipart += 1;
            answer(StatusCode::OK, "<CompleteMultipartUploadResult><ETag>\"x\"</ETag></CompleteMultipartUploadResult>")
        }
        "PUT" => {
            if let (Some(number), Some(id)) = (q("partNumber"), q("uploadId")) {
                let Some(upload) = state.uploads.get_mut(&id) else { return error(StatusCode::NOT_FOUND, "NoSuchUpload") };
                upload.2.insert(number.parse().unwrap(), body);
                return Response::builder().header("etag", format!("\"etag-{number}\"")).body(Full::new(Bytes::new())).unwrap();
            }
            if fault == Fault::FailPuts && key != "health" {
                return error(StatusCode::INTERNAL_SERVER_ERROR, "InternalError");
            }
            state.objects.insert(key, Stored { body, content_type: header("content-type"), cache_control: header("cache-control") });
            answer(StatusCode::OK, Bytes::new())
        }
        _ => error(StatusCode::METHOD_NOT_ALLOWED, "MethodNotAllowed"),
    }
}
