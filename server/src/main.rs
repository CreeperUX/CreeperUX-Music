use std::process::ExitCode;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use hyper::Uri;
use sonus_server::config::Config;
use sonus_server::gateway::{self, Gateway, Settings};
use sonus_server::supervisor::Navidrome;
use tokio::net::TcpListener;
use tokio::sync::watch;
use tracing::{error, info, warn};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> ExitCode {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_env("SONUS_LOG").unwrap_or_else(|_| EnvFilter::new("info")))
        .with_target(false)
        .init();

    let config = match Config::from_env() {
        Ok(config) => config,
        Err(e) => {
            error!("{e}");
            return ExitCode::from(2);
        }
    };
    info!(version = %sonus_server::version(), listen = %config.listen, navidrome = %config.upstream, "Sonus server starting");
    if !config.trusted.is_empty() {
        info!(user_header = %config.user_header, "forwarding headers believed from ND_EXTAUTH_TRUSTEDSOURCES");
    }

    // the port first: when it is taken, Navidrome is not started for nothing
    let listener = match TcpListener::bind(config.listen).await {
        Ok(listener) => listener,
        Err(e) => {
            error!("cannot listen on {}: {e}", config.listen);
            return ExitCode::from(1);
        }
    };

    let ready = Arc::new(AtomicBool::new(config.navidrome.is_none()));
    let mut navidrome = match &config.navidrome {
        Some(process) => match Navidrome::start(process) {
            Ok(child) => Some(child),
            Err(e) => {
                error!("{e}");
                return ExitCode::from(1);
            }
        },
        None => None,
    };
    if navidrome.is_some() {
        tokio::spawn(watch_until_ready(config.upstream.clone(), ready.clone()));
    }

    let gateway = Gateway::new(Settings { upstream: config.upstream, trusted: config.trusted, user_header: config.user_header }, ready);
    let (stop_tx, mut stop_rx) = watch::channel(false);
    let server = tokio::spawn(gateway::serve(listener, gateway, async move {
        let _ = stop_rx.wait_for(|stop| *stop).await;
    }));

    let code = tokio::select! {
        () = shutdown_signal() => {
            info!("stopping");
            if let Some(navidrome) = navidrome.as_mut() {
                navidrome.stop(Duration::from_secs(30)).await;
            }
            ExitCode::SUCCESS
        }
        status = wait(navidrome.as_mut()) => {
            match status {
                Ok(status) => {
                    error!(%status, "Navidrome stopped: stopping too");
                    ExitCode::from(status.code().and_then(|c| u8::try_from(c).ok()).filter(|c| *c != 0).unwrap_or(1))
                }
                Err(e) => {
                    error!("lost Navidrome: {e}");
                    ExitCode::from(1)
                }
            }
        }
    };
    let _ = stop_tx.send(true);
    if tokio::time::timeout(Duration::from_secs(12), server).await.is_err() {
        warn!("connections still open: leaving them");
    }
    code
}

async fn wait(navidrome: Option<&mut Navidrome>) -> std::io::Result<std::process::ExitStatus> {
    match navidrome {
        Some(navidrome) => navidrome.wait().await,
        None => std::future::pending().await,
    }
}

/// Waits for Navidrome's port to take connections (it may take minutes: migrations, the first scan's setup).
async fn watch_until_ready(upstream: Uri, ready: Arc<AtomicBool>) {
    let started = Instant::now();
    let address = upstream.authority().map(|a| a.to_string()).unwrap_or_default();
    loop {
        if tokio::net::TcpStream::connect(&address).await.is_ok() {
            ready.store(true, Ordering::Relaxed);
            info!(after_ms = started.elapsed().as_millis() as u64, "Navidrome is up");
            return;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let mut term = signal(SignalKind::terminate()).expect("SIGTERM handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = term.recv() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
