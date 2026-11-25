//! Ported from Navidrome (GPL-3.0), © the Navidrome authors.
//!
//! Running a transcode (`core/stream/media_streamer.go`, `core/ffmpeg`, `core/stream/limiter.go`,
//! `utils/cache/file_caches.go`): one ffmpeg process per stream, its output sent as it comes and, when the transcoding
//! cache is on (`TranscodingCacheSize`, default 100 MB), kept in a folder of this server's own so that the next request
//! for the same stream is a file, with ranges, as Navidrome's cache makes it.
//!
//! Bounds (`SECURITY.md`): no shell, no path from the client, a fixed argument list; at most `MAX_PROCESSES` ffmpeg
//! processes at once (and Navidrome's `Transcoding.MaxConcurrent`/`MaxConcurrentPerUser` when set: a 429 as Navidrome
//! answers); a process that writes nothing for `STALL` is ended; an output past `MAX_OUTPUT` is cut; the cache never
//! holds more than its size.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::Bytes;
use tokio::io::AsyncReadExt;
use tokio::sync::mpsc;
use tracing::{debug, warn};

use super::filecache::{Cache, Entry};
use super::transcode;

/// The most ffmpeg processes this server runs at once, whatever Navidrome's settings say.
pub const MAX_PROCESSES: usize = 16;
/// A process that writes nothing for this long is ended.
const STALL: Duration = Duration::from_secs(60);
/// The most one transcode may write.
const MAX_OUTPUT: u64 = 4 << 30;
/// How much is read from ffmpeg at a time.
const CHUNK: usize = 64 << 10;
/// Navidrome's `consts.DefaultCacheSize`: the cache size when the setting cannot be read.
const DEFAULT_CACHE_SIZE: u64 = 100_000_000;

/// The settings a transcode runs by.
#[derive(Debug, Clone, Default)]
pub struct Settings {
    /// The ffmpeg program found (`FFmpegPath`, else `ffmpeg` on the `PATH`); none: transcoding is Navidrome's.
    pub ffmpeg: Option<PathBuf>,
    /// The cache's folder and size in bytes; none: no cache.
    pub cache: Option<(PathBuf, u64)>,
    /// `Transcoding.MaxConcurrent`, `MaxConcurrentPerUser` (0: no cap), `EnableCancellation`.
    pub max_concurrent: usize,
    pub max_per_user: usize,
    pub enable_cancellation: bool,
}

/// One transcode to run.
#[derive(Debug, Clone)]
pub struct Job {
    /// `streamJob.Key()`: what the cache knows it by.
    pub key: String,
    /// ffmpeg's arguments after the program.
    pub args: Vec<String>,
    /// The duration to write into a FLAC header (`Duration - Offset`).
    pub flac_duration: f32,
    /// Who asks (the per-user cap).
    pub user: String,
}

/// Why a transcode is not running.
#[derive(Debug, PartialEq)]
pub enum Refused {
    /// Over a cap: Navidrome's 429.
    Busy,
    /// ffmpeg did not start, or failed before its first byte: Navidrome's to answer (and word).
    Failed,
}

pub struct Transcoder {
    settings: Settings,
    running: Mutex<Running>,
    cache: Option<Arc<Cache>>,
}

#[derive(Default)]
struct Running {
    total: usize,
    per_user: HashMap<String, usize>,
}

/// A slot of the caps, given back when dropped.
struct Slot {
    transcoder: Arc<Transcoder>,
    user: String,
}

impl Drop for Slot {
    fn drop(&mut self) {
        let mut running = self.transcoder.running.lock().expect("the transcodes' lock");
        running.total = running.total.saturating_sub(1);
        if let Some(n) = running.per_user.get_mut(&self.user) {
            *n -= 1;
            if *n == 0 {
                running.per_user.remove(&self.user);
            }
        }
    }
}

/// What a running transcode sends.
pub type Chunk = Result<Bytes, std::io::Error>;

impl Transcoder {
    pub fn new(settings: Settings) -> Transcoder {
        let cache = settings.cache.clone().map(|(folder, size)| Arc::new(Cache::new(folder, size)));
        Transcoder { settings, running: Mutex::new(Running::default()), cache }
    }

    pub fn available(&self) -> bool {
        self.settings.ffmpeg.is_some()
    }

    /// The finished cache entry for a key, if there is one.
    pub fn cached(&self, key: &str) -> Option<PathBuf> {
        self.cache.as_ref()?.get(key)
    }

    /// `limiter.Acquire`: Navidrome's caps when set, and this server's own.
    fn acquire(self: &Arc<Self>, user: &str) -> Option<Slot> {
        let mut running = self.running.lock().expect("the transcodes' lock");
        let mine = running.per_user.get(user).copied().unwrap_or(0);
        let cap = if self.settings.max_concurrent > 0 { self.settings.max_concurrent.min(MAX_PROCESSES) } else { MAX_PROCESSES };
        if running.total >= cap || (self.settings.max_per_user > 0 && mine >= self.settings.max_per_user) {
            return None;
        }
        running.total += 1;
        *running.per_user.entry(user.to_string()).or_default() += 1;
        Some(Slot { transcoder: self.clone(), user: user.to_string() })
    }

    /// Starts a transcode; its output comes on the receiver. Ok once ffmpeg has written its first bytes (or ended
    /// cleanly without any), so that a failure to start is still Navidrome's to answer.
    pub async fn start(self: &Arc<Self>, job: Job) -> Result<mpsc::Receiver<Chunk>, Refused> {
        let Some(program) = self.settings.ffmpeg.clone() else { return Err(Refused::Failed) };
        let slot = self.acquire(&job.user).ok_or(Refused::Busy)?;
        let mut command = tokio::process::Command::new(&program);
        command.args(&job.args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        let mut child = command.spawn().map_err(|e| {
            warn!(error = %e, "ffmpeg did not start");
            Refused::Failed
        })?;
        let mut stdout = child.stdout.take().ok_or(Refused::Failed)?;
        // ffmpeg's last words, kept short, for the log
        let stderr = child.stderr.take();
        let errors = tokio::spawn(async move {
            let mut text = Vec::new();
            if let Some(mut stderr) = stderr {
                let mut buf = [0u8; 4096];
                while let Ok(n) = stderr.read(&mut buf).await {
                    if n == 0 {
                        break;
                    }
                    if text.len() < 4096 {
                        text.extend_from_slice(&buf[..n.min(4096 - text.len())]);
                    }
                }
            }
            String::from_utf8_lossy(&text).trim().to_string()
        });

        // the first bytes: a FLAC header's prefix whole, to put the length in
        let mut first = vec![0u8; transcode::FLAC_PREFIX];
        let mut have = 0;
        while have < first.len() {
            match tokio::time::timeout(STALL, stdout.read(&mut first[have..])).await {
                Ok(Ok(0)) => break,
                Ok(Ok(n)) => have += n,
                _ => {
                    let _ = child.kill().await;
                    return Err(Refused::Failed);
                }
            }
        }
        first.truncate(have);
        if have == 0 {
            // nothing at all: a clean end is an empty answer (Navidrome sends one), a failure is Navidrome's
            let status = child.wait().await.map_err(|_| Refused::Failed)?;
            if !status.success() {
                let stderr = errors.await.unwrap_or_default();
                debug!(%stderr, "ffmpeg wrote nothing");
                return Err(Refused::Failed);
            }
        }
        transcode::patch_flac_total_samples(&mut first, job.flac_duration);

        let (tx, rx) = mpsc::channel(8);
        let cache = self.cache.clone().and_then(|cache| cache.begin(&job.key));
        let keep_going = cache.is_some() && !(self.settings.enable_cancellation || self.settings.max_concurrent > 0 || self.settings.max_per_user > 0);
        tokio::spawn(pump(child, stdout, first, tx, cache, keep_going, errors, slot));
        Ok(rx)
    }
}

/// Sends ffmpeg's output on, writes it to the cache, and ends the process when it stalls, writes too much, or (unless
/// it is filling the cache, as Navidrome lets it) when nobody reads any more.
#[allow(clippy::too_many_arguments)]
async fn pump(
    mut child: tokio::process::Child,
    mut stdout: tokio::process::ChildStdout,
    first: Vec<u8>,
    tx: mpsc::Sender<Chunk>,
    mut cache: Option<Entry>,
    keep_going: bool,
    errors: tokio::task::JoinHandle<String>,
    _slot: Slot,
) {
    let mut tx = Some(tx);
    let mut written = first.len() as u64;
    let mut chunk = first;
    loop {
        if !chunk.is_empty() {
            let bytes = Bytes::from(std::mem::take(&mut chunk));
            if let Some(entry) = cache.as_mut() {
                if !entry.write(&bytes).await {
                    cache = None;
                }
            }
            if let Some(sender) = &tx {
                if sender.send(Ok(bytes)).await.is_err() {
                    tx = None;
                }
            }
            if tx.is_none() && !(keep_going && cache.is_some()) {
                // nobody reads, and nothing is kept: ffmpeg is ended (kill_on_drop), as a closed pipe ends it
                debug!("a transcode's client went away");
                return;
            }
        }
        let mut buf = vec![0u8; CHUNK];
        match tokio::time::timeout(STALL, stdout.read(&mut buf)).await {
            Ok(Ok(0)) => break,
            Ok(Ok(n)) => {
                written += n as u64;
                if written > MAX_OUTPUT {
                    warn!("a transcode wrote more than its limit: ended");
                    fail(tx, &mut child, "a transcode wrote more than its limit").await;
                    return;
                }
                buf.truncate(n);
                chunk = buf;
            }
            Ok(Err(e)) => {
                fail(tx, &mut child, &e.to_string()).await;
                return;
            }
            Err(_) => {
                warn!("a transcode wrote nothing for a minute: ended");
                fail(tx, &mut child, "ffmpeg stalled").await;
                return;
            }
        }
    }
    match child.wait().await {
        Ok(status) if status.success() => {
            if let Some(entry) = cache {
                entry.finish().await;
            }
        }
        _ => {
            let stderr = errors.await.unwrap_or_default();
            debug!(%stderr, "ffmpeg failed while transcoding");
            // the answer has begun: ending it short is the only way left to say so, as Navidrome does
            if let Some(sender) = tx {
                let _ = sender.send(Err(std::io::Error::other("ffmpeg failed"))).await;
            }
        }
    }
}

async fn fail(tx: Option<mpsc::Sender<Chunk>>, child: &mut tokio::process::Child, why: &str) {
    let _ = child.kill().await;
    if let Some(sender) = tx {
        let _ = sender.send(Err(std::io::Error::other(why.to_string()))).await;
    }
}

// ---------------------------------------------------------------- settings

/// `humanize.ParseBytes`: a number and an optional unit (`100MB`, `1.5 GiB`, `512k`). None: not a size.
pub fn parse_bytes(text: &str) -> Option<u64> {
    let text = text.trim();
    let split = text.find(|c: char| !(c.is_ascii_digit() || c == '.' || c == ',')).unwrap_or(text.len());
    let (number, unit) = text.split_at(split);
    let number: f64 = number.replace(',', "").parse().ok()?;
    let multiplier: f64 = match unit.trim().to_lowercase().as_str() {
        "" | "b" => 1.0,
        "k" | "kb" => 1e3,
        "ki" | "kib" => 1024.0,
        "m" | "mb" => 1e6,
        "mi" | "mib" => 1024.0 * 1024.0,
        "g" | "gb" => 1e9,
        "gi" | "gib" => 1024.0 * 1024.0 * 1024.0,
        "t" | "tb" => 1e12,
        "ti" | "tib" => 1024f64.powi(4),
        _ => return None,
    };
    Some((number * multiplier) as u64)
}

/// The cache's size as Navidrome reads `TranscodingCacheSize`: an unreadable size is the default, 0 turns it off.
pub fn cache_size(setting: &str) -> Option<u64> {
    let size = parse_bytes(setting).unwrap_or(DEFAULT_CACHE_SIZE);
    (size > 0).then_some(size)
}

/// Go's `exec.LookPath`: a name with a separator as it is, else the first match on the `PATH`.
pub fn find_program(name: &str) -> Option<PathBuf> {
    let candidates: Vec<String> =
        if cfg!(windows) && !name.to_lowercase().ends_with(".exe") { vec![format!("{name}.exe"), name.to_string()] } else { vec![name.to_string()] };
    if name.contains('/') || name.contains('\\') {
        return candidates.iter().map(PathBuf::from).find(|path| path.is_file());
    }
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        for candidate in &candidates {
            let full = dir.join(candidate);
            if full.is_file() {
                return Some(full);
            }
        }
    }
    None
}

/// The file as ffmpeg is told to open it: absolute, through its `file` protocol only, so that nothing in a stored path
/// can name another protocol.
pub fn ffmpeg_input(path: &Path) -> Option<String> {
    let absolute = std::path::absolute(path).ok()?;
    Some(format!("file:{}", absolute.to_str()?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_sizes_are_read_as_navidrome_reads_them() {
        assert_eq!(parse_bytes("100MB"), Some(100_000_000));
        assert_eq!(parse_bytes("100 MiB"), Some(104_857_600));
        assert_eq!(parse_bytes("1.5gb"), Some(1_500_000_000));
        assert_eq!(parse_bytes("512"), Some(512));
        assert_eq!(parse_bytes("512k"), Some(512_000));
        assert_eq!(parse_bytes("lots"), None);
        assert_eq!(cache_size("0"), None);
        assert_eq!(cache_size("0 MB"), None);
        assert_eq!(cache_size("nonsense"), Some(100_000_000), "an unreadable size is the default");
        assert_eq!(cache_size("1GB"), Some(1_000_000_000));
    }

    #[test]
    fn ffmpeg_opens_files_only() {
        let input = ffmpeg_input(Path::new("music/a.flac")).unwrap();
        assert!(input.starts_with("file:"));
        assert!(Path::new(&input[5..]).is_absolute());
    }

    #[tokio::test]
    async fn the_cache_keeps_finished_entries_within_its_size() {
        let folder = std::env::temp_dir().join(format!("sonus-transcode-cache-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&folder);
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("leftover.1.part"), b"x").unwrap();
        let cache = Arc::new(Cache::new(folder.clone(), 10));
        assert!(cache.get("a").is_none());
        assert!(!folder.join("leftover.1.part").exists(), "half-written entries go");
        let mut a = cache.clone().begin("a").unwrap();
        assert!(cache.clone().begin("a").is_none(), "one writer per key");
        assert!(a.write(b"12345").await);
        a.finish().await;
        assert_eq!(std::fs::read(cache.get("a").unwrap()).unwrap(), b"12345");
        let mut b = cache.clone().begin("b").unwrap();
        assert!(b.write(b"123456").await);
        b.finish().await;
        assert!(cache.get("a").is_none(), "the least recently used goes when the cache is over its size");
        assert!(cache.get("b").is_some());
        let mut big = cache.clone().begin("c").unwrap();
        assert!(!big.write(b"12345678901").await, "an entry bigger than the cache is given up");
        drop(big);
        assert!(cache.get("c").is_none());
        let names: Vec<_> = std::fs::read_dir(&folder).unwrap().flatten().map(|e| e.file_name()).collect();
        assert_eq!(names.len(), 1, "no part files left: {names:?}");
        let _ = std::fs::remove_dir_all(&folder);
    }
}
