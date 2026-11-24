use std::io::IsTerminal;
use std::process::ExitCode;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use hyper::Uri;
use sonus_server::config::Config;
use sonus_server::gateway::{self, Gateway, Settings};
use sonus_server::startup;
use sonus_server::supervisor::Navidrome;
use tokio::net::TcpListener;
use tokio::sync::watch;
use tracing::{error, info, warn};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> ExitCode {
    // SONUS_LOG=debug: one line per request; the HTTP library's own debug lines (its connection pool) only when named
    let filter = std::env::var("SONUS_LOG").ok().filter(|f| !f.trim().is_empty()).unwrap_or_else(|| "info".into());
    let filter = if filter.contains("hyper") { filter } else { format!("{filter},hyper=info,hyper_util=info") };
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_new(&filter).unwrap_or_else(|_| EnvFilter::new("info")))
        .with_target(false)
        .with_ansi(std::io::stdout().is_terminal())
        .init();

    let config = match Config::from_env() {
        Ok(config) => config,
        Err(e) => {
            error!("{e}");
            return ExitCode::from(2);
        }
    };
    info!(version = %sonus_server::version(), listen = %config.listen, navidrome = %config.upstream, "Sonus server starting");
    if let Some(file) = &config.config_file {
        info!(file = %file.display(), "read Navidrome's config file");
    }
    if !config.trusted.is_empty() {
        let user_header = config.user_header.as_ref().map(|h| h.as_str()).unwrap_or("none");
        info!(user_header, "forwarding headers believed from ExtAuth.TrustedSources");
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
    // Sign-ins are checked here only in front of the Navidrome this server runs itself: that one is told to believe
    // the gateway's user header and nobody else's, and shares its settings and its database.
    let checks_sign_ins = navidrome.is_some();
    if !checks_sign_ins {
        info!("in front of a Navidrome that runs on its own (SONUS_NAVIDROME_URL): everything passes through, sign-ins are Navidrome's to check");
    }
    let settings = Settings {
        upstream: config.upstream.clone(),
        trusted: config.trusted,
        user_header: config.user_header,
        upstream_user_header: config.upstream_user_header,
        base_path: config.base_path.clone(),
        checks_sign_ins,
    };
    let gateway = Gateway::new(settings, ready.clone());
    let (failed_tx, mut failed_rx) = tokio::sync::mpsc::channel::<String>(1);
    if navidrome.is_some() {
        let (gateway, upstream, base_path, shared) = (gateway.clone(), config.upstream.clone(), config.base_path.clone(), config.shared.clone());
        tokio::spawn(async move {
            watch_until_ready(upstream.clone(), ready).await;
            match startup::subsonic(&shared, &upstream, &base_path).await {
                Ok(subsonic) => {
                    gateway.set_subsonic(subsonic);
                    info!("Subsonic sign-ins are checked here");
                }
                Err(e) => {
                    let _ = failed_tx.send(e).await;
                }
            }
        });
    }
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
        Some(reason) = failed_rx.recv() => {
            error!("{reason}");
            error!("cannot run on this database: stopping");
            if let Some(navidrome) = navidrome.as_mut() {
                navidrome.stop(Duration::from_secs(30)).await;
            }
            ExitCode::from(1)
        }
        status = wait(navidrome.as_mut()) => {
            match status {
                Ok(status) => {
                    error!(%status, "Navidrome stopped: stopping too");
                    ExitCode::from(sonus_server::supervisor::exit_code(status))
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
