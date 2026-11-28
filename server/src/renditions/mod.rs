//! The playback library (`docs/streaming-renditions.md`): pre-generated, seekable playback renditions (lossless FLAC
//! with 1-second `SEEKTABLE`, plus Opus 256 / 160 / 96 kbps in Ogg containers) and EBU R128 loudness measurements.
//!
//! Off by default (`SONUS_RENDITIONS_ENABLED`): when off, nothing here runs and existing clients see zero changes.
//! Original music files and Navidrome's database are never modified; the ledger (`sonus-renditions.db`) and rendition
//! files live in their own folder and can be deleted and regenerated at any time.

pub mod api;
pub mod audio_meta;
pub mod ledger;
pub mod worker;

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tracing::info;

use crate::config::{Config, RealFiles, Sources};
use crate::db::Db;
use crate::library::transcoder::Transcoder;
use crate::mirror::throttle::Hours;
use ledger::{AlbumLoudness, HealthReport, Ledger, Row, State, TrackLoudness};

pub const DEFAULT_CONCURRENCY: usize = 8;
pub const MAX_CONCURRENCY: usize = 32;
pub const DEFAULT_DELETE_BRAKE: f64 = 0.10;
pub const DEFAULT_DIR_NAME: &str = "sonus-renditions";
pub const ALLOW_DELETIONS_CMD: &str = "renditions-allow-deletions";

/// One generated playback tier stored in the playback library.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Tier {
    Lossless,
    VeryHigh,
    High,
    Normal,
}

impl Tier {
    pub const ALL: [Tier; 4] = [Tier::Lossless, Tier::VeryHigh, Tier::High, Tier::Normal];
    pub const LOSSY_SOURCE: [Tier; 2] = [Tier::High, Tier::Normal];

    pub fn as_str(self) -> &'static str {
        match self {
            Tier::Lossless => "lossless",
            Tier::VeryHigh => "veryHigh",
            Tier::High => "high",
            Tier::Normal => "normal",
        }
    }

    pub fn parse(text: &str) -> Option<Tier> {
        match text {
            "lossless" => Some(Tier::Lossless),
            "veryHigh" => Some(Tier::VeryHigh),
            "high" => Some(Tier::High),
            "normal" => Some(Tier::Normal),
            _ => None,
        }
    }

    pub fn format(self) -> &'static str {
        match self {
            Tier::Lossless => "flac",
            Tier::VeryHigh | Tier::High | Tier::Normal => "opus",
        }
    }

    /// HTTP `Content-Type` served for this tier (`audio/ogg` for Opus so browsers and ExoPlayer accept it).
    pub fn content_type(self) -> &'static str {
        match self {
            Tier::Lossless => "audio/flac",
            Tier::VeryHigh | Tier::High | Tier::Normal => "audio/ogg",
        }
    }

    pub fn extension(self) -> &'static str {
        match self {
            Tier::Lossless => "flac",
            Tier::VeryHigh | Tier::High | Tier::Normal => "ogg",
        }
    }

    /// Nominal target bit rate in kbps for Opus tiers (`None` for lossless FLAC).
    pub fn target_bitrate_kbps(self) -> Option<u32> {
        match self {
            Tier::Lossless => None,
            Tier::VeryHigh => Some(256),
            Tier::High => Some(160),
            Tier::Normal => Some(96),
        }
    }
}

/// What a client may ask for via `stream?sonusQuality=...`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Quality {
    Tier(Tier),
    Original,
}

impl Quality {
    pub fn parse(text: &str) -> Option<Quality> {
        if text == "original" {
            return Some(Quality::Original);
        }
        Tier::parse(text).map(Quality::Tier)
    }
}

/// Whether a source song is lossless (FLAC, WAV, AIFF, APE, WavPack, TTA, TAK, Shorten, ALAC, DSD).
pub fn is_lossless_source(suffix: &str, codec: &str, bit_depth: Option<i64>) -> bool {
    let c = codec.trim().to_ascii_lowercase();
    if matches!(c.as_str(), "flac" | "pcm" | "alac" | "ape" | "wv" | "wavpack" | "tta" | "tak" | "shn" | "dsd")
        || c.starts_with("pcm_")
        || c.starts_with("dsd_")
    {
        return true;
    }
    match suffix.trim().to_ascii_lowercase().as_str() {
        "flac" | "wav" | "aif" | "aiff" | "aifc" | "ape" | "wv" | "wvp" | "tta" | "tak" | "shn" | "dsf" | "dff" => true,
        "m4a" => bit_depth.unwrap_or(0) > 0,
        _ => false,
    }
}

/// Whether a source song is DSD (DSF / DFF), which requires 88.2 kHz / 24-bit FIR filtering before FLAC encoding.
pub fn is_dsd_source(suffix: &str, codec: &str) -> bool {
    let c = codec.trim().to_ascii_lowercase();
    c == "dsd" || c.starts_with("dsd_") || matches!(suffix.trim().to_ascii_lowercase().as_str(), "dsf" | "dff")
}

/// Which tiers the server generates for a song (`docs/streaming-renditions.md`, section 4).
pub fn tiers_for_source(lossless: bool) -> &'static [Tier] {
    if lossless { &Tier::ALL } else { &Tier::LOSSY_SOURCE }
}

/// Safe rendition path under `root`: `<root>/<first 2 chars of song_id>/<song_id>_<version>_<tier>.<ext>`.
/// Contains no song title or original library path; rejects unexpected characters in `song_id` or `version`.
pub fn rendition_path(root: &Path, song_id: &str, version: &str, tier: Tier) -> Option<PathBuf> {
    if song_id.is_empty()
        || !song_id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        || version.is_empty()
        || !version.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return None;
    }
    let shard: String = song_id.chars().take(2).collect();
    let file = format!("{song_id}_{version}_{}.{}", tier.as_str(), tier.extension());
    Some(root.join(shard).join(file))
}

/// Settings read from `SONUS_RENDITIONS_*` environment variables.
#[derive(Clone, Debug, PartialEq)]
pub struct Settings {
    /// Where rendition files live (`SONUS_RENDITIONS_DIR`); none: `<DataFolder>/sonus-renditions`.
    pub dir: Option<PathBuf>,
    /// Maximum concurrent background ffmpeg jobs (`SONUS_RENDITIONS_CONCURRENCY`, default 8, 1..=32).
    pub concurrency: usize,
    /// Optional time window in server local time (`SONUS_RENDITIONS_HOURS`, default `all`).
    pub hours: Option<Hours>,
    /// Share of library songs gone at once that holds deletions (`SONUS_RENDITIONS_DELETE_BRAKE`, default `10%`).
    pub delete_brake: Option<f64>,
}

impl Settings {
    /// Reads `SONUS_RENDITIONS_*`. Returns `Ok(None)` when disabled (the default).
    pub fn from_env(var: &dyn Fn(&str) -> Option<String>) -> Result<Option<Settings>, String> {
        let get = |name: &str| var(name).map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
        let enabled = match get("SONUS_RENDITIONS_ENABLED") {
            None => false,
            Some(text) => parse_bool(&text).ok_or_else(|| format!("SONUS_RENDITIONS_ENABLED={text} is not true or false"))?,
        };
        if !enabled {
            return Ok(None);
        }
        let dir = get("SONUS_RENDITIONS_DIR").map(PathBuf::from);
        let concurrency = match get("SONUS_RENDITIONS_CONCURRENCY") {
            Some(text) => {
                let n: usize = text
                    .parse()
                    .ok()
                    .filter(|&n| (1..=MAX_CONCURRENCY).contains(&n))
                    .ok_or_else(|| format!("SONUS_RENDITIONS_CONCURRENCY={text} must be an integer between 1 and {MAX_CONCURRENCY}"))?;
                n
            }
            None => DEFAULT_CONCURRENCY,
        };
        let hours = match get("SONUS_RENDITIONS_HOURS") {
            Some(text) => Hours::parse(&text).map_err(|e| format!("SONUS_RENDITIONS_HOURS: {e}"))?,
            None => None,
        };
        let delete_brake = match get("SONUS_RENDITIONS_DELETE_BRAKE") {
            Some(text) => parse_share(&text).ok_or_else(|| format!("SONUS_RENDITIONS_DELETE_BRAKE={text} is not a share like 10%, or off"))?,
            None => Some(DEFAULT_DELETE_BRAKE),
        };
        Ok(Some(Settings { dir, concurrency, hours, delete_brake }))
    }
}

fn parse_bool(text: &str) -> Option<bool> {
    match text.to_ascii_lowercase().as_str() {
        "1" | "t" | "true" | "yes" | "on" => Some(true),
        "0" | "f" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

fn parse_share(text: &str) -> Option<Option<f64>> {
    let text = text.trim();
    if text.eq_ignore_ascii_case("off") {
        return Some(None);
    }
    let share = match text.strip_suffix('%') {
        Some(percent) => percent.trim().parse::<f64>().ok()? / 100.0,
        None => text.parse::<f64>().ok()?,
    };
    if !(0.0..=1.0).contains(&share) || share.is_nan() {
        return None;
    }
    Some((share > 0.0).then_some(share))
}

/// Live handle held by `Library` when the playback library is enabled.
pub struct Renditions {
    pub ledger: Arc<Ledger>,
    pub dir: PathBuf,
}

impl Renditions {
    pub fn new(ledger: Arc<Ledger>, dir: PathBuf) -> Renditions {
        Renditions { ledger, dir }
    }

    /// Looks up a ready rendition for `(song_id, version, tier)` and verifies the file exists on disk.
    pub fn ready_file(&self, song_id: &str, version: &str, tier: Tier) -> Option<(Row, PathBuf)> {
        let row = self.ledger.get(song_id, version, tier).ok()??;
        if row.state != State::Ready {
            return None;
        }
        let path = rendition_path(&self.dir, song_id, version, tier)?;
        if !path.is_file() {
            return None;
        }
        Some((row, path))
    }

    /// Ready renditions and EBU R128 track/album loudness for one song at its current on-disk `version`.
    pub fn song_info(&self, song_id: &str, version: &str, album_id: &str) -> (Vec<Row>, Option<TrackLoudness>, Option<AlbumLoudness>) {
        let mut rows = self.ledger.ready_for_song(song_id, version).unwrap_or_default();
        rows.retain(|r| rendition_path(&self.dir, &r.song_id, &r.version, r.tier).is_some_and(|p| p.is_file()));
        rows.sort_by_key(|r| match r.tier {
            Tier::Lossless => 0,
            Tier::VeryHigh => 1,
            Tier::High => 2,
            Tier::Normal => 3,
        });
        let track = self.ledger.get_track_loudness(song_id, version).ok().flatten();
        let album = self.ledger.get_album_loudness(album_id).ok().flatten();
        (rows, track, album)
    }

    pub fn health_report(&self, limit: usize, offset: usize) -> Result<HealthReport, String> {
        self.ledger.health_report(limit, offset)
    }
}

/// Starts the playback library's background worker on Navidrome's database.
pub fn start(settings: Settings, db: Arc<Db>, data_folder: PathBuf, transcoder: Arc<Transcoder>) -> Result<Arc<Renditions>, String> {
    let dir = settings.dir.unwrap_or_else(|| data_folder.join(DEFAULT_DIR_NAME));
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create renditions folder {}: {e}", dir.display()))?;
    let ledger = Arc::new(Ledger::open(&data_folder)?);
    let Some(ffmpeg) = transcoder.ffmpeg_path() else {
        return Err("no ffmpeg found: playback library requires ffmpeg".into());
    };
    let clock: Arc<dyn Fn() -> chrono::DateTime<chrono::FixedOffset> + Send + Sync> = Arc::new(|| chrono::Local::now().fixed_offset());
    let worker = Arc::new(worker::Worker {
        ledger: ledger.clone(),
        db,
        dir: dir.clone(),
        ffmpeg,
        concurrency: settings.concurrency,
        hours: settings.hours,
        delete_brake: settings.delete_brake,
        live_transcodes: transcoder,
        clock,
        known: Default::default(),
        said: Default::default(),
    });
    info!(
        dir = %dir.display(),
        concurrency = settings.concurrency,
        hours = %settings.hours.map(|h| format!("{}-{}", h.start.format("%H:%M"), h.end.format("%H:%M"))).unwrap_or_else(|| "all".into()),
        delete_brake = %settings.delete_brake.map(|s| format!("{}%", s * 100.0)).unwrap_or_else(|| "off".into()),
        "playback library on: background generation and sonusQuality streaming active"
    );
    tokio::spawn(worker.run());
    Ok(Arc::new(Renditions::new(ledger, dir)))
}

/// CLI command `sonus-server renditions-allow-deletions`: releases deletions held by `SONUS_RENDITIONS_DELETE_BRAKE`.
pub fn is_cli_command(first: &OsString) -> bool {
    first == ALLOW_DELETIONS_CMD
}

pub fn run_cli(args: Vec<OsString>, var: &dyn Fn(&str) -> Option<String>) -> Result<String, String> {
    const USAGE: &str = "usage: sonus-server renditions-allow-deletions\n\
        \x20 The playback library holds deletions when much of the library disappears at once (SONUS_RENDITIONS_DELETE_BRAKE).\n\
        \x20 When the songs are gone for good, this lets their renditions be deleted after their 7-day grace time.";
    if args.iter().any(|a| a == "--help" || a == "-h") {
        return Ok(USAGE.into());
    }
    let config = Config::load(Sources { var, args, files: &RealFiles })?;
    let folder = PathBuf::from(&config.shared.data_folder);
    if !folder.join(ledger::FILE_NAME).is_file() {
        return Err(format!("no renditions ledger in {}: the playback library has not run here", folder.display()));
    }
    let ledger = Ledger::open(&folder)?;
    let now = chrono::Utc::now().timestamp();
    ledger.set_note(worker::RELEASED_NOTE, &now.to_string())?;
    let gone = ledger.all_renditions()?.into_iter().filter(|r| r.state == State::Deleting).count();
    Ok(format!(
        "{gone} renditions for songs gone from the library may now be deleted, each {} days after the song went. \
         Songs that return before then are kept.",
        worker::GRACE / 86400
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn load(vars: &[(&str, &str)]) -> Result<Option<Settings>, String> {
        let map: HashMap<String, String> = vars.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        Settings::from_env(&|name| map.get(name).cloned())
    }

    #[test]
    fn settings_are_off_by_default_and_validate_bounds() {
        assert_eq!(load(&[]).unwrap(), None);
        assert_eq!(load(&[("SONUS_RENDITIONS_ENABLED", "false")]).unwrap(), None);
        let on = load(&[("SONUS_RENDITIONS_ENABLED", "true")]).unwrap().unwrap();
        assert_eq!((on.concurrency, on.hours, on.delete_brake), (8, None, Some(0.10)));
        let custom = load(&[
            ("SONUS_RENDITIONS_ENABLED", "1"),
            ("SONUS_RENDITIONS_DIR", "/data/lib"),
            ("SONUS_RENDITIONS_CONCURRENCY", "4"),
            ("SONUS_RENDITIONS_HOURS", "01:00-06:00"),
            ("SONUS_RENDITIONS_DELETE_BRAKE", "off"),
        ])
        .unwrap()
        .unwrap();
        assert_eq!(custom.dir, Some(PathBuf::from("/data/lib")));
        assert_eq!(custom.concurrency, 4);
        assert!(custom.hours.is_some());
        assert_eq!(custom.delete_brake, None);
        assert!(load(&[("SONUS_RENDITIONS_ENABLED", "1"), ("SONUS_RENDITIONS_CONCURRENCY", "0")]).is_err());
        assert!(load(&[("SONUS_RENDITIONS_ENABLED", "1"), ("SONUS_RENDITIONS_CONCURRENCY", "99")]).is_err());
        assert!(load(&[("SONUS_RENDITIONS_ENABLED", "1"), ("SONUS_RENDITIONS_HOURS", "night")]).is_err());
    }

    #[test]
    fn source_classification_and_tier_selection() {
        assert!(is_lossless_source("flac", "flac", Some(24)));
        assert!(is_lossless_source("wav", "pcm_s24le", Some(24)));
        assert!(is_lossless_source("ape", "", None));
        assert!(is_lossless_source("dsf", "dsd_lsbf_planar", None));
        assert!(is_lossless_source("m4a", "alac", Some(16)));
        assert!(!is_lossless_source("mp3", "mp3", None));
        assert!(!is_lossless_source("m4a", "aac", None));
        assert!(is_dsd_source("dsf", ""));
        assert!(is_dsd_source("dff", ""));
        assert!(is_dsd_source("", "dsd_msbf"));
        assert!(!is_dsd_source("flac", "flac"));
        assert_eq!(tiers_for_source(true), &Tier::ALL);
        assert_eq!(tiers_for_source(false), &Tier::LOSSY_SOURCE);
    }

    #[test]
    fn rendition_paths_contain_no_titles_and_reject_traversal() {
        let root = Path::new("/renditions");
        let p = rendition_path(root, "abc123", "0123456789abcdef", Tier::Lossless).unwrap();
        assert_eq!(p, root.join("ab").join("abc123_0123456789abcdef_lossless.flac"));
        let opus = rendition_path(root, "abc123", "0123456789abcdef", Tier::High).unwrap();
        assert_eq!(opus, root.join("ab").join("abc123_0123456789abcdef_high.ogg"));
        assert_eq!(Tier::High.content_type(), "audio/ogg");
        assert_eq!(Tier::Lossless.content_type(), "audio/flac");
        for bad_id in ["", "../etc", "a/b", "a\\b", "song name"] {
            assert!(rendition_path(root, bad_id, "0123456789abcdef", Tier::High).is_none(), "{bad_id}");
        }
        for bad_ver in ["", "not-hex!", "../abc"] {
            assert!(rendition_path(root, "abc123", bad_ver, Tier::High).is_none(), "{bad_ver}");
        }
    }
}
