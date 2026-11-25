//! The R2 mirror against a real S3-compatible server, when one is given: skipped otherwise (and in CI). The local
//! check of `docs/r2-mirror.md` section 10, run with Versity's S3 gateway on 127.0.0.1:
//!
//! ```text
//! SONUS_MIRROR_S3_ENDPOINT=127.0.0.1:7070 SONUS_MIRROR_S3_BUCKET=music \
//! SONUS_MIRROR_S3_KEY_ID=… SONUS_MIRROR_S3_SECRET=… [SONUS_MIRROR_S3_REGION=us-east-1] \
//! cargo test --no-default-features --test mirror_s3 -- --nocapture
//! ```
//!
//! The bucket must exist and be empty. Plain http only (this machine's own server, made for the run).

use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use chrono::Utc;
use http_body_util::{BodyExt, Empty};
use hyper::Request;
use hyper_util::client::legacy::Client;
use hyper_util::rt::TokioExecutor;
use sonus_server::mirror::s3::{Endpoint, S3, Stamp};
use sonus_server::mirror::sigv4::{self, Signer};
use sonus_server::mirror::throttle::Rate;

struct Server {
    authority: String,
    bucket: String,
    key_id: String,
    secret: String,
    region: String,
}

fn server() -> Option<Server> {
    let get = |name: &str| std::env::var(name).ok().filter(|v| !v.is_empty());
    Some(Server {
        authority: get("SONUS_MIRROR_S3_ENDPOINT")?,
        bucket: get("SONUS_MIRROR_S3_BUCKET")?,
        key_id: get("SONUS_MIRROR_S3_KEY_ID")?,
        secret: get("SONUS_MIRROR_S3_SECRET")?,
        region: get("SONUS_MIRROR_S3_REGION").unwrap_or_else(|| "us-east-1".into()),
    })
}

async fn fetch(url: &str) -> (u16, Bytes) {
    let client: Client<_, Empty<Bytes>> = Client::builder(TokioExecutor::new()).build_http();
    let answer = client.request(Request::get(url).body(Empty::new()).unwrap()).await.unwrap();
    let status = answer.status().as_u16();
    (status, answer.into_body().collect().await.unwrap().to_bytes())
}

#[tokio::test]
async fn a_real_s3_server_takes_what_the_mirror_sends() {
    let Some(server) = server() else {
        eprintln!("no S3 server given (SONUS_MIRROR_S3_*): skipped");
        return;
    };
    let endpoint = Endpoint { https: false, authority: server.authority.clone() };
    // parts as small as S3 allows (5 MiB, the last smaller), so that a 12 MiB file goes up in three
    let s3 = S3::new(endpoint, &server.bucket, Signer::new(&server.key_id, &server.secret, &server.region)).with_parts(6 << 20, 5 << 20);
    let rate = Arc::new(Rate::new(0));
    let dir = std::env::temp_dir().join(format!("sonus-mirror-s3-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();

    // health: absent, written, read
    assert_eq!(s3.head("health").await.unwrap(), None);
    s3.put_bytes("health", Bytes::from_static(b"ok\n"), "text/plain").await.unwrap();
    assert_eq!(s3.head("health").await.unwrap(), Some(3));

    // one request, and in parts
    let small = dir.join("small.mp3");
    std::fs::write(&small, b"a small file's bytes").unwrap();
    let big = dir.join("big.flac");
    let big_bytes: Vec<u8> = (0..12u32 << 20).map(|i| (i.wrapping_mul(2654435761) >> 24) as u8).collect();
    std::fs::write(&big, &big_bytes).unwrap();
    let headers = [("content-type".to_string(), "audio/mpeg".to_string()), ("cache-control".to_string(), "private, max-age=31536000, immutable".to_string())];
    let small_key = format!("m/s1/{}", Stamp::of(&small).unwrap().version());
    let big_key = format!("m/s2/{}", Stamp::of(&big).unwrap().version());
    s3.put_file(&small_key, &small, Stamp::of(&small).unwrap(), &headers, &rate).await.unwrap();
    s3.put_file(&big_key, &big, Stamp::of(&big).unwrap(), &headers, &rate).await.unwrap();
    assert_eq!(s3.head(&big_key).await.unwrap(), Some(big_bytes.len() as u64));

    // a listing, read to its end
    let mut keys: Vec<String> = s3.list_all("").await.unwrap().into_iter().map(|o| o.key).collect();
    keys.sort();
    assert_eq!(keys, [String::from("health"), small_key.clone(), big_key.clone()]);
    assert_eq!(s3.list_all("m/s2/").await.unwrap().len(), 1);

    // a presigned link (R2-b's): the server gives the object, whole and by range, and refuses it tampered
    let path = format!("/{}/{}", sigv4::encode_path(&server.bucket), sigv4::encode_path(&big_key));
    let query = Signer::new(&server.key_id, &server.secret, &server.region).presign("GET", &server.authority, &path, Utc::now(), 3600);
    let url = format!("http://{}{path}?{query}", server.authority);
    let (status, body) = fetch(&url).await;
    assert_eq!(status, 200);
    assert!(body == big_bytes, "the object as uploaded");
    let (status, _) = fetch(&url.replace("X-Amz-Expires=3600", "X-Amz-Expires=7200")).await;
    assert_eq!(status, 403, "a link changed after signing");
    let old = Utc::now() - chrono::Duration::hours(2);
    let expired = Signer::new(&server.key_id, &server.secret, &server.region).presign("GET", &server.authority, &path, old, 3600);
    let (status, _) = fetch(&format!("http://{}{path}?{expired}", server.authority)).await;
    assert_eq!(status, 403, "an expired link");

    // wrong keys are refused as such
    let wrong =
        S3::new(Endpoint { https: false, authority: server.authority.clone() }, &server.bucket, Signer::new(&server.key_id, "not-the-secret", &server.region));
    assert!(wrong.head("health").await.unwrap_err().is_refusal());

    // deletions, one already gone included
    for key in [&small_key, &big_key, &small_key, &"health".to_string()] {
        s3.delete(key).await.unwrap();
    }
    assert!(s3.list_all("").await.unwrap().is_empty());
    tokio::time::sleep(Duration::from_millis(10)).await;
    let _ = std::fs::remove_dir_all(&dir);
    eprintln!("the S3 server took every request");
}
