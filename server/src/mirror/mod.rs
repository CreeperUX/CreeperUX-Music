//! The R2 mirror (`docs/r2-mirror.md`): a private copy of the music files and covers in a Cloudflare R2 bucket (any
//! S3-compatible store), kept in step with the library by a background task. Part R2-a: the signer, the client, the
//! ledger, the uploads and the health check. Nobody is sent to the copy yet (part R2-b).
//!
//! Off unless the owner gives the bucket and its keys (`SONUS_R2_*`): without them nothing of this runs, and the
//! server behaves as before. The keys stay in this process's memory; nothing logs them, nor a signature.

pub mod ledger;
pub mod s3;
pub mod sigv4;
pub mod sync;
pub mod throttle;

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use hyper::Uri;
use tracing::{info, warn};

use crate::db::Db;
use crate::library::transcoder::parse_bytes;
use ledger::Ledger;
use s3::{Endpoint, S3};
use sigv4::Signer;
use throttle::{Hours, Rate};

pub const DEFAULT_UPLOAD_RATE: u64 = 2_000_000;
pub const DEFAULT_UPLOAD_HOURS: &str = "00:00-07:00";
pub const DEFAULT_DAILY_UPLOAD: u64 = 20_000_000_000;

/// The settings the owner gives: all four of the bucket's, or none (the mirror is off).
pub struct Settings {
    pub endpoint: Endpoint,
    pub bucket: String,
    pub access_key_id: String,
    pub secret_access_key: String,
    /// `auto` for R2.
    pub region: String,
    /// Bytes a second; 0: no cap.
    pub upload_rate: u64,
    /// None: any time.
    pub upload_hours: Option<Hours>,
    /// Bytes a day; 0: no cap.
    pub daily_upload: u64,
}

impl std::fmt::Debug for Settings {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Settings")
            .field("endpoint", &self.endpoint)
            .field("bucket", &self.bucket)
            .field("access_key_id", &"(set)")
            .field("secret_access_key", &"(set)")
            .field("region", &self.region)
            .field("upload_rate", &self.upload_rate)
            .field("upload_hours", &self.upload_hours)
            .field("daily_upload", &self.daily_upload)
            .finish()
    }
}

/// The names that switch the mirror on; any one set asks for all.
const REQUIRED: [&str; 4] = ["SONUS_R2_ACCOUNT_ID or SONUS_R2_ENDPOINT", "SONUS_R2_BUCKET", "SONUS_R2_ACCESS_KEY_ID", "SONUS_R2_SECRET_ACCESS_KEY"];

impl Settings {
    /// The mirror's settings from the environment; none when none of the bucket's are set. An error names the
    /// setting, never a key's value.
    pub fn from_env(var: &dyn Fn(&str) -> Option<String>) -> Result<Option<Settings>, String> {
        let get = |name: &str| var(name).map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
        let account = get("SONUS_R2_ACCOUNT_ID");
        let endpoint = get("SONUS_R2_ENDPOINT");
        let bucket = get("SONUS_R2_BUCKET");
        let key_id = get("SONUS_R2_ACCESS_KEY_ID");
        let secret = match (get("SONUS_R2_SECRET_ACCESS_KEY"), get("SONUS_R2_SECRET_ACCESS_KEY_FILE")) {
            (Some(_), Some(_)) => return Err("SONUS_R2_SECRET_ACCESS_KEY and SONUS_R2_SECRET_ACCESS_KEY_FILE are both set: keep one".into()),
            (Some(secret), None) => Some(secret),
            (None, Some(file)) => Some(read_secret_file(&PathBuf::from(&file))?),
            (None, None) => None,
        };
        let given = [account.is_some() || endpoint.is_some(), bucket.is_some(), key_id.is_some(), secret.is_some()];
        if !given.iter().any(|g| *g) {
            return Ok(None);
        }
        if !given.iter().all(|g| *g) {
            let missing: Vec<&str> = REQUIRED.iter().zip(given).filter(|(_, g)| !g).map(|(name, _)| *name).collect();
            return Err(format!("the R2 mirror is half set up: {} missing (set all of them, or none to leave it off)", missing.join(", ")));
        }
        let endpoint = match (endpoint, account) {
            (Some(url), _) => parse_endpoint(&url)?,
            (None, Some(account)) => {
                if account.len() > 64 || !account.bytes().all(|b| b.is_ascii_alphanumeric()) {
                    return Err("SONUS_R2_ACCOUNT_ID is not a Cloudflare account id (letters and digits)".into());
                }
                if !s3::TLS {
                    return Err("this build of the server has no HTTPS (built without the tls feature): it cannot reach R2".into());
                }
                Endpoint { https: true, authority: format!("{}.r2.cloudflarestorage.com", account.to_ascii_lowercase()) }
            }
            (None, None) => unreachable!("checked above"),
        };
        let bucket = bucket.expect("checked above");
        if !(3..=63).contains(&bucket.len()) || !bucket.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'.') {
            return Err(format!("SONUS_R2_BUCKET={bucket} is not a bucket name (3 to 63 of a-z, 0-9, - and .)"));
        }
        let key_id = key_id.expect("checked above");
        if !key_id.bytes().all(|b| b.is_ascii_graphic()) {
            return Err("SONUS_R2_ACCESS_KEY_ID is not an access key id".into());
        }
        let upload_rate = match get("SONUS_R2_UPLOAD_RATE") {
            Some(text) => {
                parse_bytes(text.trim_end_matches("/s")).ok_or_else(|| format!("SONUS_R2_UPLOAD_RATE={text} is not a rate (2MB, 500KB; 0: no cap)"))?
            }
            None => DEFAULT_UPLOAD_RATE,
        };
        let upload_hours = match get("SONUS_R2_UPLOAD_HOURS") {
            Some(text) => Hours::parse(&text).map_err(|e| format!("SONUS_R2_UPLOAD_HOURS: {e}"))?,
            None => Hours::parse(DEFAULT_UPLOAD_HOURS).expect("the default hours"),
        };
        let daily_upload = match get("SONUS_R2_DAILY_UPLOAD") {
            Some(text) => parse_bytes(&text).ok_or_else(|| format!("SONUS_R2_DAILY_UPLOAD={text} is not a size (20GB; 0: no cap)"))?,
            None => DEFAULT_DAILY_UPLOAD,
        };
        Ok(Some(Settings {
            endpoint,
            bucket,
            access_key_id: key_id,
            secret_access_key: secret.expect("checked above"),
            region: get("SONUS_R2_REGION").unwrap_or_else(|| "auto".into()),
            upload_rate,
            upload_hours,
            daily_upload,
        }))
    }
}

/// An S3-compatible store's address: `https://…`, or `http://` on this machine's own addresses only (a local test
/// server), never with a path.
fn parse_endpoint(url: &str) -> Result<Endpoint, String> {
    // before anything echoes the address back: a key written into it is never repeated in a message
    if url.contains('@') {
        return Err("SONUS_R2_ENDPOINT carries a user name or password: the keys go in their own settings".into());
    }
    let uri: Uri = url.trim_end_matches('/').parse().map_err(|_| format!("SONUS_R2_ENDPOINT={url} is not a URL"))?;
    let authority = uri.authority().ok_or_else(|| format!("SONUS_R2_ENDPOINT={url} has no host"))?.clone();
    if !matches!(uri.path(), "" | "/") || uri.query().is_some() {
        return Err(format!("SONUS_R2_ENDPOINT={url}: only the address, without a path (the bucket is SONUS_R2_BUCKET)"));
    }
    let https = match uri.scheme_str() {
        Some("https") => true,
        Some("http") => {
            let host = authority.host().trim_start_matches('[').trim_end_matches(']');
            let local = host.eq_ignore_ascii_case("localhost") || host.parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback());
            if !local {
                return Err(format!("SONUS_R2_ENDPOINT={url}: plain http only to this machine itself (127.0.0.1); use https"));
            }
            false
        }
        _ => return Err(format!("SONUS_R2_ENDPOINT={url}: an https:// address is needed")),
    };
    if https && !s3::TLS {
        return Err("this build of the server has no HTTPS (built without the tls feature): only an http:// endpoint on this machine".into());
    }
    Ok(Endpoint { https, authority: authority.as_str().to_string() })
}

/// The secret from its own file (for example `/data/r2-secret`, readable by the server alone).
fn read_secret_file(path: &std::path::Path) -> Result<String, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("SONUS_R2_SECRET_ACCESS_KEY_FILE ({}) cannot be read: {e}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(path) {
            if meta.permissions().mode() & 0o077 != 0 {
                warn!(file = %path.display(), "the R2 secret's file can be read by others than its owner: chmod 600 it");
            }
        }
    }
    let secret = text.trim().to_string();
    if secret.is_empty() {
        return Err(format!("SONUS_R2_SECRET_ACCESS_KEY_FILE ({}) is empty", path.display()));
    }
    Ok(secret)
}

/// Whether R2 answered the last health check.
#[derive(Default)]
pub struct Health {
    ok: AtomicBool,
    /// Whether a failure was already logged (one line per change, not one a minute).
    said_down: AtomicBool,
}

impl Health {
    pub fn ok(&self) -> bool {
        self.ok.load(Ordering::Relaxed)
    }

    pub fn up(&self) {
        if !self.ok.swap(true, Ordering::Relaxed) {
            info!("R2 mirror: the bucket answers");
        }
        self.said_down.store(false, Ordering::Relaxed);
    }

    pub fn down(&self, why: &s3::Error) {
        self.ok.store(false, Ordering::Relaxed);
        if !self.said_down.swap(true, Ordering::Relaxed) {
            if why.is_refusal() {
                warn!("R2 mirror: the bucket refuses the keys ({why}): uploads stop until they are fixed (wrong, revoked, or the clock is off)");
            } else {
                warn!("R2 mirror: the bucket does not answer ({why}): uploads wait");
            }
        }
    }
}

/// The mirror while it runs.
pub struct Mirror {
    pub health: Arc<Health>,
    pub ledger: Arc<Ledger>,
    pub s3: Arc<S3>,
}

/// Starts the mirror's tasks (the health check, and the reconciliation and uploads) on Navidrome's database; the
/// ledger is made in `data_folder`.
pub fn start(settings: Settings, db: Arc<Db>, data_folder: PathBuf) -> Result<Arc<Mirror>, String> {
    let ledger = Arc::new(Ledger::open(&data_folder)?);
    let signer = Signer::new(&settings.access_key_id, &settings.secret_access_key, &settings.region);
    let s3 = Arc::new(S3::new(settings.endpoint.clone(), &settings.bucket, signer));
    let health = Arc::new(Health::default());
    let worker = Arc::new(sync::Worker {
        s3: s3.clone(),
        ledger: ledger.clone(),
        db,
        data_folder,
        rate: Arc::new(Rate::new(settings.upload_rate)),
        hours: settings.upload_hours,
        daily_upload: settings.daily_upload,
        health: health.clone(),
        clock: Arc::new(|| chrono::Local::now().fixed_offset()),
        known: Default::default(),
        said: Default::default(),
    });
    info!(
        endpoint = %settings.endpoint.authority,
        upload_rate = settings.upload_rate,
        upload_hours = %settings.upload_hours.map(|h| format!("{}-{}", h.start.format("%H:%M"), h.end.format("%H:%M"))).unwrap_or_else(|| "all".into()),
        daily_upload = settings.daily_upload,
        "R2 mirror on: uploads only (nobody is sent to it yet)"
    );
    tokio::spawn(sync::health_loop(s3.clone(), health.clone()));
    tokio::spawn(worker.run());
    Ok(Arc::new(Mirror { health, ledger, s3 }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn load(vars: &[(&str, &str)]) -> Result<Option<Settings>, String> {
        let map: HashMap<String, String> = vars.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        Settings::from_env(&|name| map.get(name).cloned())
    }

    const LOCAL: [(&str, &str); 4] = [
        ("SONUS_R2_ENDPOINT", "http://127.0.0.1:9000"),
        ("SONUS_R2_BUCKET", "music"),
        ("SONUS_R2_ACCESS_KEY_ID", "test-key"),
        ("SONUS_R2_SECRET_ACCESS_KEY", "test-secret-value"),
    ];

    #[test]
    fn off_without_settings() {
        assert!(load(&[]).unwrap().is_none());
        assert!(load(&[("SONUS_R2_UPLOAD_RATE", "1MB")]).unwrap().is_none(), "the brakes alone do not switch it on");
    }

    #[test]
    fn half_set_up_is_an_error_that_names_what_is_missing() {
        let error = load(&[("SONUS_R2_BUCKET", "music"), ("SONUS_R2_SECRET_ACCESS_KEY", "test-secret-value")]).unwrap_err();
        assert!(error.contains("SONUS_R2_ACCESS_KEY_ID") && error.contains("SONUS_R2_ACCOUNT_ID"), "{error}");
        assert!(!error.contains("test-secret-value"));
    }

    #[test]
    fn defaults() {
        let settings = load(&LOCAL).unwrap().unwrap();
        assert_eq!(settings.endpoint, Endpoint { https: false, authority: "127.0.0.1:9000".into() });
        assert_eq!((settings.upload_rate, settings.daily_upload, settings.region.as_str()), (2_000_000, 20_000_000_000, "auto"));
        assert_eq!(settings.upload_hours, Hours::parse("00:00-07:00").unwrap());
        let shown = format!("{settings:?}");
        assert!(!shown.contains("test-secret-value") && !shown.contains("test-key"), "{shown}");
    }

    #[test]
    fn brakes() {
        let mut vars = LOCAL.to_vec();
        vars.extend([("SONUS_R2_UPLOAD_RATE", "500KB/s"), ("SONUS_R2_UPLOAD_HOURS", "all"), ("SONUS_R2_DAILY_UPLOAD", "0")]);
        let settings = load(&vars).unwrap().unwrap();
        assert_eq!((settings.upload_rate, settings.upload_hours, settings.daily_upload), (500_000, None, 0));
        let mut bad = LOCAL.to_vec();
        bad.push(("SONUS_R2_UPLOAD_HOURS", "nights"));
        assert!(load(&bad).unwrap_err().contains("SONUS_R2_UPLOAD_HOURS"));
    }

    #[test]
    fn endpoints() {
        for bad in ["http://192.168.1.5:9000", "http://example.com", "ftp://127.0.0.1", "https://key:secret@example.com", "https://example.com/bucket"] {
            assert!(parse_endpoint(bad).is_err(), "{bad}");
        }
        // a key written into the address, even one that does not parse, is not repeated in the message
        for with_key in ["https://key:test-secret-value@example.com", "https://key:test-secret-value @ex ample", "test-secret-value@"] {
            let error = parse_endpoint(with_key).unwrap_err();
            assert!(!error.contains("test-secret-value"), "{error}");
        }
        assert!(parse_endpoint("http://localhost:9000").is_ok());
        assert!(parse_endpoint("http://[::1]:9000/").is_ok());
        assert_eq!(parse_endpoint("https://s3.example.com").map(|e| e.https).ok(), s3::TLS.then_some(true));
        let mut vars = LOCAL.to_vec();
        vars[0] = ("SONUS_R2_ACCOUNT_ID", "0123456789abcdef0123456789abcdef");
        match load(&vars) {
            Ok(Some(settings)) => assert_eq!(settings.endpoint.authority, "0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com"),
            Err(e) => assert!(!s3::TLS && e.contains("HTTPS"), "{e}"),
            Ok(None) => panic!("set up"),
        }
        vars[0] = ("SONUS_R2_ACCOUNT_ID", "../evil");
        assert!(load(&vars).is_err());
    }

    #[test]
    fn buckets() {
        for bad in ["ab", "Music", "my_bucket"] {
            let mut vars = LOCAL.to_vec();
            vars[1] = ("SONUS_R2_BUCKET", bad);
            assert!(load(&vars).is_err(), "{bad}");
        }
    }
}
