//! The gateway against a fake Navidrome: what passes through, what is streamed, what is changed on the way.

mod common;

use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use common::*;
use http_body_util::BodyExt;
use hyper::body::Incoming;
use hyper::header::{self, HeaderValue};
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot};

/// What the fake Navidrome saw of a request.
#[derive(Debug)]
struct Seen {
    method: Method,
    target: String,
    headers: hyper::HeaderMap,
    body: Bytes,
}

/// A fake Navidrome that reports each request on the channel and answers 200 "ok".
async fn recording_upstream() -> (std::net::SocketAddr, mpsc::UnboundedReceiver<Seen>) {
    let (tx, rx) = mpsc::unbounded_channel();
    let addr = upstream(move |req: Request<Incoming>| {
        let tx = tx.clone();
        async move {
            let (parts, body) = req.into_parts();
            let body = body.collect().await.unwrap().to_bytes();
            let target = parts.uri.path_and_query().map(|p| p.to_string()).unwrap_or_default();
            tx.send(Seen { method: parts.method, target, headers: parts.headers, body }).unwrap();
            Response::new(full("ok"))
        }
    })
    .await;
    (addr, rx)
}

#[tokio::test]
async fn requests_pass_through_as_they_came() {
    let (tx, mut requests) = mpsc::unbounded_channel();
    let nd = upstream(move |req: Request<Incoming>| {
        let tx = tx.clone();
        async move {
            let (parts, body) = req.into_parts();
            let body = body.collect().await.unwrap().to_bytes();
            let target = parts.uri.path_and_query().unwrap().to_string();
            tx.send(Seen { method: parts.method, target, headers: parts.headers, body }).unwrap();
            Response::builder().status(StatusCode::CREATED).header("x-from-navidrome", "yes").body(full("made")).unwrap()
        }
    })
    .await;
    let (gw, _) = gateway(nd, GatewaySetup::default()).await;

    let req = Request::post("/rest/savePlayQueue.view?u=demo&f=json&id=1&id=2&q=a%2Fb+c%20d")
        .header(header::HOST, "music.example:4533")
        .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
        .header("x-custom", "kept")
        .body(full("current=1&position=2000"))
        .unwrap();
    let response = send(gw, req).await;
    assert_eq!(response.status(), StatusCode::CREATED);
    assert_eq!(response.headers()["x-from-navidrome"], "yes");
    assert_eq!(body_bytes(response.into_body()).await, "made");

    let seen = within("the request upstream", requests.recv()).await.unwrap();
    assert_eq!(seen.method, Method::POST);
    assert_eq!(seen.target, "/rest/savePlayQueue.view?u=demo&f=json&id=1&id=2&q=a%2Fb+c%20d", "the target, byte for byte");
    assert_eq!(values(&seen.headers, "host"), ["music.example:4533"], "the client's Host, not Navidrome's address");
    assert_eq!(seen.headers["content-type"], "application/x-www-form-urlencoded");
    assert_eq!(seen.headers["x-custom"], "kept");
    assert_eq!(seen.body, "current=1&position=2000");

    for method in [Method::GET, Method::HEAD, Method::PUT, Method::DELETE, Method::OPTIONS, Method::PATCH] {
        let response = send(gw, Request::builder().method(method.clone()).uri("/api/song/1").header(header::HOST, "h").body(empty()).unwrap()).await;
        assert_eq!(response.status(), StatusCode::CREATED);
        assert_eq!(within("the request upstream", requests.recv()).await.unwrap().method, method);
    }
}

#[tokio::test]
async fn a_large_upload_streams_through() {
    const CHUNK: usize = 64 * 1024;
    const CHUNKS: usize = 256; // 16 MiB
    let (first_tx, mut first_rx) = mpsc::channel::<()>(1);
    let nd = upstream(move |req: Request<Incoming>| {
        let first_tx = first_tx.clone();
        async move {
            let mut body = req.into_body();
            let mut total = 0usize;
            while let Some(frame) = body.frame().await {
                if let Ok(data) = frame.unwrap().into_data() {
                    if total == 0 && !data.is_empty() {
                        let _ = first_tx.send(()).await;
                    }
                    total += data.len();
                }
            }
            Response::new(full(total.to_string()))
        }
    })
    .await;
    let (gw, _) = gateway(nd, GatewaySetup::default()).await;

    let (chunks, body) = channel_body();
    let response = tokio::spawn(send(gw, Request::post("/api/upload").header(header::HOST, "h").body(body).unwrap()));
    chunks.send(Bytes::from(vec![7u8; CHUNK])).await.unwrap();
    // Navidrome has the first piece while the rest is still on the client: nothing waits for the whole body
    within("the first piece upstream, before the rest is sent", first_rx.recv()).await.unwrap();
    for _ in 1..CHUNKS {
        within("sending a piece", chunks.send(Bytes::from(vec![7u8; CHUNK]))).await.unwrap();
    }
    drop(chunks);
    let response = within("the response", response).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(body_bytes(response.into_body()).await, (CHUNK * CHUNKS).to_string());
}

#[tokio::test]
async fn a_streamed_response_arrives_as_it_is_made() {
    let (go_tx, go_rx) = oneshot::channel::<()>();
    let go_rx = Arc::new(Mutex::new(Some(go_rx)));
    let nd = upstream(move |_req: Request<Incoming>| {
        let go_rx = go_rx.lock().unwrap().take();
        async move {
            let (chunks, body) = channel_body();
            tokio::spawn(async move {
                chunks.send(Bytes::from_static(b"event: first\n\n")).await.unwrap();
                // the rest waits for the client to have the first part
                if let Some(go) = go_rx {
                    let _ = go.await;
                }
                chunks.send(Bytes::from_static(b"event: second\n\n")).await.unwrap();
            });
            Response::builder().header(header::CONTENT_TYPE, "text/event-stream").body(body.boxed()).unwrap()
        }
    })
    .await;
    let (gw, _) = gateway(nd, GatewaySetup::default()).await;

    let response = send(gw, Request::get("/api/events").header(header::HOST, "h").body(empty()).unwrap()).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["content-type"], "text/event-stream");
    let mut body = response.into_body();
    let first = within("the first event, while the response is still open", body.frame()).await.unwrap().unwrap();
    assert_eq!(first.into_data().unwrap(), "event: first\n\n");
    go_tx.send(()).unwrap();
    assert_eq!(body_bytes(body).await, "event: second\n\n");
}

#[tokio::test]
async fn ranges_get_partial_content() {
    let song: Vec<u8> = (0..100u8).collect();
    let nd = upstream(move |req: Request<Incoming>| {
        let song = song.clone();
        async move {
            match req.headers().get(header::RANGE).map(|r| r.to_str().unwrap().to_string()) {
                Some(range) => {
                    assert_eq!(range, "bytes=10-19");
                    assert_eq!(req.headers()["if-range"], "\"v1\"");
                    Response::builder()
                        .status(StatusCode::PARTIAL_CONTENT)
                        .header(header::ACCEPT_RANGES, "bytes")
                        .header(header::CONTENT_RANGE, "bytes 10-19/100")
                        .header(header::CONTENT_LENGTH, "10")
                        .header(header::ETAG, "\"v1\"")
                        .body(full(song[10..20].to_vec()))
                        .unwrap()
                }
                None => Response::builder().header(header::ACCEPT_RANGES, "bytes").header(header::CONTENT_LENGTH, "100").body(full(song)).unwrap(),
            }
        }
    })
    .await;
    let (gw, _) = gateway(nd, GatewaySetup::default()).await;

    let req = Request::get("/rest/stream.view?id=1").header(header::HOST, "h").header(header::RANGE, "bytes=10-19").header("if-range", "\"v1\"").body(empty()).unwrap();
    let response = send(gw, req).await;
    assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(response.headers()["content-range"], "bytes 10-19/100");
    assert_eq!(response.headers()["content-length"], "10");
    assert_eq!(response.headers()["accept-ranges"], "bytes");
    assert_eq!(response.headers()["etag"], "\"v1\"");
    assert_eq!(body_bytes(response.into_body()).await.to_vec(), (10..20u8).collect::<Vec<_>>());

    let whole = send(gw, Request::get("/rest/stream.view?id=1").header(header::HOST, "h").body(empty()).unwrap()).await;
    assert_eq!(whole.status(), StatusCode::OK);
    assert_eq!(whole.headers()["content-length"], "100");
    assert_eq!(body_bytes(whole.into_body()).await.len(), 100);
}

#[tokio::test]
async fn a_websocket_carries_bytes_both_ways() {
    let nd = upstream(|mut req: Request<Incoming>| async move {
        let headers = req.headers().clone();
        assert!(values(&headers, "connection").iter().any(|v| v.eq_ignore_ascii_case("upgrade")), "{headers:?}");
        assert_eq!(headers["upgrade"], "websocket");
        assert_eq!(headers["sec-websocket-key"], "dGhlIHNhbXBsZSBub25jZQ==");
        assert_eq!(headers["sec-websocket-version"], "13");
        let upgrade = hyper::upgrade::on(&mut req);
        tokio::spawn(async move {
            let mut io = TokioIo::new(upgrade.await.unwrap());
            io.write_all(b"welcome").await.unwrap();
            let mut ping = [0u8; 4];
            io.read_exact(&mut ping).await.unwrap();
            assert_eq!(&ping, b"ping");
            io.write_all(b"pong").await.unwrap();
            // the client closes; the upstream end sees it
            let mut rest = Vec::new();
            io.read_to_end(&mut rest).await.unwrap();
            assert!(rest.is_empty());
        });
        Response::builder()
            .status(StatusCode::SWITCHING_PROTOCOLS)
            .header(header::CONNECTION, "Upgrade")
            .header(header::UPGRADE, "websocket")
            .header("sec-websocket-accept", "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=")
            .body(empty())
            .unwrap()
    })
    .await;
    let (gw, _) = gateway(nd, GatewaySetup::default()).await;

    let req = Request::get("/connect/ws")
        .header(header::HOST, "h")
        .header(header::CONNECTION, "keep-alive, Upgrade")
        .header(header::UPGRADE, "websocket")
        .header("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ==")
        .header("sec-websocket-version", "13")
        .body(empty())
        .unwrap();
    let mut response = send(gw, req).await;
    assert_eq!(response.status(), StatusCode::SWITCHING_PROTOCOLS);
    assert_eq!(response.headers()["upgrade"], "websocket");
    assert!(response.headers()["connection"].to_str().unwrap().eq_ignore_ascii_case("upgrade"));
    assert_eq!(response.headers()["sec-websocket-accept"], "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
    let mut io = TokioIo::new(within("the upgrade", hyper::upgrade::on(&mut response)).await.unwrap());
    let mut welcome = [0u8; 7];
    within("the first bytes from upstream", io.read_exact(&mut welcome)).await.unwrap();
    assert_eq!(&welcome, b"welcome");
    io.write_all(b"ping").await.unwrap();
    let mut pong = [0u8; 4];
    within("the answer from upstream", io.read_exact(&mut pong)).await.unwrap();
    assert_eq!(&pong, b"pong");
    io.shutdown().await.unwrap();
}

#[tokio::test]
async fn hop_by_hop_headers_stay_on_their_hop() {
    let nd = upstream(|req: Request<Incoming>| async move {
        let h = req.headers();
        for name in ["x-hop", "keep-alive", "proxy-connection", "proxy-authorization", "upgrade", "te", "trailer"] {
            assert!(!h.contains_key(name), "{name} reached Navidrome: {h:?}");
        }
        assert!(values(h, "connection").iter().all(|v| !v.to_ascii_lowercase().contains("x-hop")), "{h:?}");
        assert_eq!(h["x-end-to-end"], "kept");
        Response::builder()
            .header(header::CONNECTION, "X-Upstream-Hop")
            .header("x-upstream-hop", "1")
            .header("keep-alive", "timeout=5")
            .header(header::PROXY_AUTHENTICATE, "Basic")
            .header("x-end-to-end", "kept")
            .body(full("ok"))
            .unwrap()
    })
    .await;
    let (gw, _) = gateway(nd, GatewaySetup::default()).await;

    let req = Request::get("/rest/ping.view")
        .header(header::HOST, "h")
        .header(header::CONNECTION, "keep-alive, X-Hop")
        .header("x-hop", "1")
        .header("keep-alive", "timeout=5")
        .header("proxy-connection", "keep-alive")
        .header(header::PROXY_AUTHORIZATION, "Basic Zm9vOmJhcg==")
        .header(header::UPGRADE, "h2c")
        .header(header::TE, "trailers")
        .header(header::TRAILER, "x-checksum")
        .header("x-end-to-end", "kept")
        .body(empty())
        .unwrap();
    let response = send(gw, req).await;
    assert_eq!(response.status(), StatusCode::OK, "Navidrome's assertions failed");
    let h = response.headers();
    for name in ["x-upstream-hop", "keep-alive", "proxy-authenticate"] {
        assert!(!h.contains_key(name), "{name} reached the client: {h:?}");
    }
    assert_eq!(h["x-end-to-end"], "kept");
}

#[tokio::test]
async fn an_untrusted_peer_cannot_choose_its_address_or_its_user() {
    // 127.0.0.1 (the test) is not in the list
    let (nd, mut requests) = recording_upstream().await;
    let (gw, _) = gateway(nd, GatewaySetup { trusted: "10.0.0.0/8", user_header: Some("Remote-User"), upstream_user_header: "remote-user", ready: true }).await;
    let spoofed = |req: hyper::http::request::Builder| {
        req.header(header::HOST, "h")
            .header("x-forwarded-for", "203.0.113.1")
            .header("x-forwarded-for", "203.0.113.2")
            .header("x-real-ip", "203.0.113.3")
            .header("true-client-ip", "203.0.113.4")
            .header("remote-user", "admin")
            .body(empty())
            .unwrap()
    };
    let response = send(gw, spoofed(Request::get("/rest/ping.view"))).await;
    assert_eq!(response.status(), StatusCode::OK);
    let seen = within("the request upstream", requests.recv()).await.unwrap();
    assert_eq!(values(&seen.headers, "x-real-ip"), ["127.0.0.1"]);
    assert_eq!(values(&seen.headers, "x-forwarded-for"), ["127.0.0.1"]);
    assert!(!seen.headers.contains_key("true-client-ip"));
    assert!(!seen.headers.contains_key("remote-user"), "{:?}", seen.headers);

    // no proxy trusted: Navidrome's own header name (random, see config.rs) cannot be sent either
    let (nd, mut requests) = recording_upstream().await;
    let (gw, _) = gateway(nd, GatewaySetup { trusted: "", upstream_user_header: "x-sonus-user-0123456789abcdef", ..GatewaySetup::default() }).await;
    let req = spoofed(Request::get("/rest/ping.view").header("x-sonus-user-0123456789abcdef", "admin"));
    assert_eq!(send(gw, req).await.status(), StatusCode::OK);
    let seen = within("the request upstream", requests.recv()).await.unwrap();
    assert_eq!(values(&seen.headers, "x-real-ip"), ["127.0.0.1"]);
    assert!(!seen.headers.contains_key("remote-user"));
    assert!(!seen.headers.contains_key("x-sonus-user-0123456789abcdef"), "{:?}", seen.headers);

    // a peer that names the gateway's own headers in Connection does not get them removed
    let (nd, mut requests) = recording_upstream().await;
    let (gw, _) = gateway(nd, GatewaySetup::default()).await;
    let req = Request::get("/").header(header::HOST, "h").header(header::CONNECTION, "x-real-ip, host").body(empty()).unwrap();
    assert_eq!(send(gw, req).await.status(), StatusCode::OK);
    let seen = within("the request upstream", requests.recv()).await.unwrap();
    assert_eq!(values(&seen.headers, "x-real-ip"), ["127.0.0.1"]);
    assert_eq!(values(&seen.headers, "host"), ["h"]);
}

#[tokio::test]
async fn a_trusted_proxy_is_believed() {
    let (nd, mut requests) = recording_upstream().await;
    let setup = GatewaySetup { trusted: "127.0.0.0/8", user_header: Some("X-Proxy-User"), upstream_user_header: "x-navidrome-user", ready: true };
    let (gw, _) = gateway(nd, setup).await;
    let req = Request::get("/app/")
        .header(header::HOST, "h")
        .header("x-forwarded-for", "198.51.100.7, 127.0.0.2")
        .header("x-proxy-user", "alice")
        .header("x-navidrome-user", "mallory")
        .body(empty())
        .unwrap();
    assert_eq!(send(gw, req).await.status(), StatusCode::OK);
    let seen = within("the request upstream", requests.recv()).await.unwrap();
    assert_eq!(values(&seen.headers, "x-real-ip"), ["198.51.100.7"], "the first hop from the right that isn't trusted");
    assert_eq!(values(&seen.headers, "x-forwarded-for"), ["198.51.100.7"]);
    assert_eq!(values(&seen.headers, "x-navidrome-user"), ["alice"], "the proxy's user, under Navidrome's name, and only it");
    assert!(!seen.headers.contains_key("x-proxy-user"));

    let req = Request::get("/app/").header(header::HOST, "h").header("x-real-ip", "203.0.113.5").header("true-client-ip", "203.0.113.6").body(empty()).unwrap();
    assert_eq!(send(gw, req).await.status(), StatusCode::OK);
    let seen = within("the request upstream", requests.recv()).await.unwrap();
    assert_eq!(values(&seen.headers, "x-real-ip"), ["203.0.113.6"], "True-Client-IP first, as Navidrome");
    assert!(!seen.headers.contains_key("true-client-ip"));
    assert!(!seen.headers.contains_key("x-navidrome-user"), "no user from the proxy: none at all");
}

#[tokio::test]
async fn while_navidrome_starts_503_then_502() {
    // a port nothing listens on
    let closed = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap().local_addr().unwrap();
    let (gw, ready) = gateway(closed, GatewaySetup { ready: false, ..GatewaySetup::default() }).await;

    let starting = send(gw, Request::get("/rest/ping.view").header(header::HOST, "h").body(empty()).unwrap()).await;
    assert_eq!(starting.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(starting.headers()[header::RETRY_AFTER], HeaderValue::from_static("5"));

    ready.store(true, Ordering::Relaxed);
    let down = send(gw, Request::get("/rest/ping.view").header(header::HOST, "h").body(empty()).unwrap()).await;
    assert_eq!(down.status(), StatusCode::BAD_GATEWAY);
}

#[tokio::test]
async fn connect_is_not_a_tunnel() {
    let (nd, mut requests) = recording_upstream().await;
    let (gw, _) = gateway(nd, GatewaySetup::default()).await;
    let req = Request::connect("example.com:443").header(header::HOST, "example.com:443").body(empty()).unwrap();
    assert_eq!(send(gw, req).await.status(), StatusCode::METHOD_NOT_ALLOWED);
    assert!(requests.try_recv().is_err(), "nothing reached Navidrome");
}
