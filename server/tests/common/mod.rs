//! A fake Navidrome (an HTTP server run by the test) behind a real gateway, and a client, all on 127.0.0.1.

#![allow(dead_code)]

pub mod database;

use std::convert::Infallible;
use std::future::Future;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::task::{Context, Poll};
use std::time::Duration;

use bytes::Bytes;
use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Empty, Full};
use hyper::body::{Body, Frame, Incoming};
use hyper::header::HeaderName;
use hyper::service::service_fn;
use hyper::{Request, Response, Uri};
use hyper_util::rt::TokioIo;
use sonus_server::auth::Auth;
use sonus_server::connect::Connect;
use sonus_server::gateway::{self, Gateway, Settings};
use sonus_server::library::Library;
use sonus_server::subsonic::Subsonic;
use sonus_server::trust::TrustList;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;

pub type TestBody = BoxBody<Bytes, Infallible>;

/// Long enough for a slow machine, short enough that a gateway that buffers fails instead of hanging.
pub const PATIENCE: Duration = Duration::from_secs(10);

pub async fn within<T>(what: &str, future: impl Future<Output = T>) -> T {
    tokio::time::timeout(PATIENCE, future).await.unwrap_or_else(|_| panic!("timed out: {what}"))
}

/// A fake Navidrome answering every request with `handler`, upgrades included.
pub async fn upstream<F, Fut>(handler: F) -> SocketAddr
where
    F: Fn(Request<Incoming>) -> Fut + Clone + Send + Sync + 'static,
    Fut: Future<Output = Response<TestBody>> + Send + 'static,
{
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else { return };
            let handler = handler.clone();
            tokio::spawn(async move {
                let service = service_fn(move |req| {
                    let handler = handler.clone();
                    async move { Ok::<_, Infallible>(handler(req).await) }
                });
                let _ = hyper::server::conn::http1::Builder::new().serve_connection(TokioIo::new(stream), service).with_upgrades().await;
            });
        }
    });
    addr
}

pub struct GatewaySetup<'a> {
    pub trusted: &'a str,
    pub user_header: Option<&'a str>,
    pub upstream_user_header: &'a str,
    pub ready: bool,
    pub base_path: &'a str,
    /// The gateway checks Subsonic sign-ins itself, with `subsonic` once it has it.
    pub checks_sign_ins: bool,
    pub subsonic: Option<Subsonic>,
    /// What the gateway answers `/auth` with.
    pub auth: Option<Auth>,
    /// What the gateway answers Sonus Connect version 2 with.
    pub connect: Option<Connect>,
    /// What the gateway answers the library's reads with.
    pub library: Option<Library>,
}

impl Default for GatewaySetup<'_> {
    fn default() -> Self {
        GatewaySetup {
            trusted: "",
            user_header: Some("Remote-User"),
            upstream_user_header: "x-sonus-user-0123456789abcdef",
            ready: true,
            base_path: "",
            checks_sign_ins: false,
            subsonic: None,
            auth: None,
            connect: None,
            library: None,
        }
    }
}

/// The gateway, in front of `upstream`, listening on 127.0.0.1.
pub async fn gateway(upstream: SocketAddr, setup: GatewaySetup<'_>) -> (SocketAddr, Arc<AtomicBool>) {
    let settings = Settings {
        upstream: format!("http://{upstream}").parse::<Uri>().unwrap(),
        trusted: TrustList::parse(setup.trusted),
        user_header: setup.user_header.map(|h| HeaderName::try_from(h).unwrap()),
        upstream_user_header: HeaderName::try_from(setup.upstream_user_header).unwrap(),
        base_path: setup.base_path.to_string(),
        checks_sign_ins: setup.checks_sign_ins,
    };
    let ready = Arc::new(AtomicBool::new(setup.ready));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let gateway = Gateway::new(settings, ready.clone());
    if let Some(subsonic) = setup.subsonic {
        gateway.set_subsonic(subsonic);
    }
    if let Some(auth) = setup.auth {
        gateway.set_auth(auth);
    }
    if let Some(connect) = setup.connect {
        gateway.set_connect(connect);
    }
    if let Some(library) = setup.library {
        gateway.set_library(library);
    }
    tokio::spawn(gateway::serve(listener, gateway, std::future::pending()));
    (addr, ready)
}

/// One request on a new connection; the connection supports upgrades.
pub async fn send<B>(addr: SocketAddr, req: Request<B>) -> Response<Incoming>
where
    B: Body<Data = Bytes> + Send + 'static,
    B::Error: Into<Box<dyn std::error::Error + Send + Sync>>,
{
    let stream = TcpStream::connect(addr).await.unwrap();
    let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream)).await.unwrap();
    tokio::spawn(async move {
        let _ = connection.with_upgrades().await;
    });
    within("the response", sender.send_request(req)).await.unwrap()
}

pub async fn body_bytes<B>(body: B) -> Bytes
where
    B: Body,
    B::Error: std::fmt::Debug,
{
    within("the whole body", body.collect()).await.unwrap().to_bytes()
}

pub fn full(data: impl Into<Bytes>) -> TestBody {
    Full::new(data.into()).boxed()
}

pub fn empty() -> TestBody {
    Empty::new().boxed()
}

/// A body sent piece by piece: what goes into the sender is what goes out, when it is sent.
pub struct ChannelBody(pub mpsc::Receiver<Bytes>);

impl Body for ChannelBody {
    type Data = Bytes;
    type Error = Infallible;

    fn poll_frame(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Result<Frame<Bytes>, Infallible>>> {
        self.0.poll_recv(cx).map(|chunk| chunk.map(|data| Ok(Frame::data(data))))
    }
}

pub fn channel_body() -> (mpsc::Sender<Bytes>, ChannelBody) {
    let (tx, rx) = mpsc::channel(1);
    (tx, ChannelBody(rx))
}

/// The values of one header, as text.
pub fn values(headers: &hyper::HeaderMap, name: &str) -> Vec<String> {
    headers.get_all(name).iter().map(|v| v.to_str().unwrap().to_string()).collect()
}
