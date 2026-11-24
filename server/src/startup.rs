//! What must hold before the gateway answers anything itself: Navidrome is up (so its migrations are done), its
//! database is the schema this server knows, and Navidrome has said how it signs its Subsonic answers.

use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use http_body_util::{BodyExt, Empty, Limited};
use hyper::{Request, Uri};
use hyper_util::client::legacy::Client;
use hyper_util::rt::TokioExecutor;
use tracing::info;

use crate::config::Shared;
use crate::db::{self, Db};
use crate::secrets::Keys;
use crate::subsonic::credentials;
use crate::subsonic::respond::Envelope;
use crate::subsonic::{Setup, Subsonic};

/// Opens Navidrome's database and checks it; call when Navidrome answers (it migrates before it listens). The error
/// says why the server cannot run.
pub async fn subsonic(shared: &Shared, upstream: &Uri, base_path: &str) -> Result<Subsonic, String> {
    let path = db::locate(&shared.data_folder, &shared.db_path)?;
    let keys = Keys::new(&shared.password_encryption_key);
    let opened = {
        let keys = keys.clone();
        tokio::task::spawn_blocking(move || -> Result<Arc<Db>, String> {
            let db = Db::open(&path)?;
            db.read_blocking(|conn| Ok(db::check_sqlite(conn).and_then(|()| db::check_schema(conn)))).map_err(|e| e.to_string())??;
            let hashed = credentials::fill_key_hashes(&db, &keys).map_err(|e| format!("cannot prepare app passwords as API keys: {e}"))?;
            if hashed > 0 {
                info!(hashed, "app passwords made before API keys now work as API keys");
            }
            Ok(db)
        })
        .await
        .map_err(|_| "the database check did not finish".to_string())??
    };
    info!(database = %opened.path().display(), schema = db::SCHEMA_VERSION, "Navidrome's database is the schema this server knows");
    let envelope = envelope(upstream, base_path).await?;
    Ok(Subsonic::new(Setup {
        db: opened,
        keys,
        two_factor: shared.two_factor,
        limit: shared.auth_request_limit,
        window: shared.auth_window,
        envelope,
        frame_options: shared.frame_options.clone(),
    }))
}

/// How Navidrome starts its Subsonic answers (version, type, its own version): asked of the one method that needs no
/// sign-in, so the answers given here carry the very same.
async fn envelope(upstream: &Uri, base_path: &str) -> Result<Envelope, String> {
    let authority = upstream.authority().ok_or("no upstream address")?;
    let target = format!("http://{authority}{}/rest/getOpenSubsonicExtensions?f=json", base_path.trim_end_matches('/'));
    let client: Client<_, Empty<Bytes>> = Client::builder(TokioExecutor::new()).build_http();
    let mut last = String::new();
    for _ in 0..20 {
        let request = Request::get(&target).body(Empty::new()).map_err(|e| e.to_string())?;
        match tokio::time::timeout(Duration::from_secs(10), client.request(request)).await {
            Ok(Ok(response)) => {
                let status = response.status();
                match Limited::new(response.into_body(), 1 << 20).collect().await {
                    Ok(body) => match Envelope::from_json(&body.to_bytes()) {
                        Some(envelope) => return Ok(envelope),
                        None => last = format!("HTTP {status}, not a Subsonic answer"),
                    },
                    Err(e) => last = e.to_string(),
                }
            }
            Ok(Err(e)) => last = e.to_string(),
            Err(_) => last = "no answer in 10 s".into(),
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    Err(format!("Navidrome did not answer getOpenSubsonicExtensions ({target}): {last}"))
}
