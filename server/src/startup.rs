//! What must hold before the gateway answers anything itself: Navidrome is up (so its migrations are done), its
//! database is the schema this server knows, Navidrome has said how it starts its Subsonic answers, and the secret
//! both servers sign sessions with is read.

use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use http_body_util::{BodyExt, Empty, Limited};
use hyper::{Request, Uri};
use hyper_util::client::legacy::Client;
use hyper_util::rt::TokioExecutor;
use rusqlite::OptionalExtension;
use tracing::info;

use crate::auth::{self, Auth};
use crate::config::Shared;
use crate::connect::{self, Connect};
use crate::db::{self, Db};
use crate::jwt::Signer;
use crate::library::{self, Library};
use crate::secrets::Keys;
use crate::subsonic::credentials;
use crate::subsonic::respond::Envelope;
use crate::subsonic::{Setup, Subsonic};

/// What the gateway answers its own routes with.
pub struct Local {
    pub subsonic: Subsonic,
    pub auth: Auth,
    pub connect: Connect,
    pub library: Library,
}

/// Navidrome's `consts.JWTSecretKey`: where the `property` table keeps the session secret, sealed.
const SESSION_SECRET: &str = "JWTSecret";

/// The secret Navidrome signs session tokens with. Navidrome makes it at its first start, before it listens.
fn session_secret(db: &Db, keys: &Keys) -> Result<Signer, String> {
    let sealed: Option<String> = db
        .read_blocking(|conn| conn.query_row("SELECT value FROM property WHERE id = ?1", [SESSION_SECRET], |r| r.get(0)).optional())
        .map_err(|e| format!("cannot read the session secret: {e}"))?;
    let sealed = sealed.filter(|s| !s.is_empty()).ok_or("Navidrome's database has no session secret (JWTSecret): Navidrome has not finished starting")?;
    let secret = keys.open(&sealed).map_err(|_| "the session secret cannot be opened: was PasswordEncryptionKey changed?".to_string())?;
    Ok(Signer::new(&secret))
}

/// Opens Navidrome's database and checks it; call when Navidrome answers (it migrates before it listens). The error
/// says why the server cannot run.
pub async fn local(shared: &Shared, upstream: &Uri, base_path: &str, user_header: &hyper::header::HeaderName) -> Result<Local, String> {
    let path = db::locate(&shared.data_folder, &shared.db_path)?;
    let keys = Keys::new(&shared.password_encryption_key);
    let opened = {
        let keys = keys.clone();
        tokio::task::spawn_blocking(move || -> Result<(Arc<Db>, Signer, Connect), String> {
            let db = Db::open(&path)?;
            db.read_blocking(|conn| Ok(db::check_sqlite(conn).and_then(|()| db::check_schema(conn)))).map_err(|e| e.to_string())??;
            let hashed = credentials::fill_key_hashes(&db, &keys).map_err(|e| format!("cannot prepare app passwords as API keys: {e}"))?;
            if hashed > 0 {
                info!(hashed, "app passwords made before API keys now work as API keys");
            }
            let signer = session_secret(&db, &keys)?;
            auth::store::prepare(&db)?;
            // the server's own tables (additive: Navidrome's are never altered), made at the first start
            let connect = Connect::new(connect::Setup::new(db.clone()))?;
            Ok((db, signer, connect))
        })
        .await
        .map_err(|_| "the database check did not finish".to_string())??
    };
    let (opened, signer, connect) = opened;
    info!(database = %opened.path().display(), schema = db::SCHEMA_VERSION, "Navidrome's database is the schema this server knows");
    let envelope = envelope(upstream, base_path).await?;
    let subsonic = Subsonic::new(Setup {
        db: opened.clone(),
        keys: keys.clone(),
        two_factor: shared.two_factor,
        limit: shared.auth_request_limit,
        window: shared.auth_window,
        envelope: envelope.clone(),
        frame_options: shared.frame_options.clone(),
    });
    let library = Library::new(library::Setup {
        db: opened.clone(),
        options: shared.library.clone(),
        envelope,
        frame_options: shared.frame_options.clone(),
        upstream: upstream.clone(),
        base_path: base_path.to_string(),
        user_header: user_header.clone(),
    });
    let auth = Auth::new(auth::Setup {
        db: opened,
        keys,
        two_factor: shared.two_factor,
        signer,
        session_timeout: shared.session_timeout,
        limit: shared.auth_request_limit,
        window: shared.auth_window,
        base_path: base_path.to_string(),
        frame_options: shared.frame_options.clone(),
        enable_gravatar: shared.enable_gravatar,
        auto_login: shared.dev_auto_login_username.clone(),
    });
    Ok(Local { subsonic, auth, connect, library })
}

/// The user name of the sign-in the server tries at Navidrome when it starts: nobody's.
pub const START_PROBE_USER: &str = "sonus-server-start-probe";

/// How Navidrome starts its Subsonic answers (version, type, its own version), so the answers given here carry the
/// very same. Asked with a sign-in that is nobody's, on purpose: checking it makes Navidrome open its user store, and
/// with that settle its password encryption (on a new database, or after `PasswordEncryptionKey` was set, it
/// re-encrypts the passwords it finds and notes the key, which it otherwise does at its first sign-in). After this
/// the server may write passwords itself (the first admin) without Navidrome mistaking them for old ones.
async fn envelope(upstream: &Uri, base_path: &str) -> Result<Envelope, String> {
    let authority = upstream.authority().ok_or("no upstream address")?;
    let nothing = crate::id::random_hex(16).map_err(|e| e.to_string())?;
    let target = format!("http://{authority}{}/rest/ping?u={START_PROBE_USER}&p={nothing}&v=1.16.1&c=sonus-server&f=json", base_path.trim_end_matches('/'));
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
    Err(format!("Navidrome did not answer a Subsonic request (http://{authority}/rest/ping): {last}"))
}
