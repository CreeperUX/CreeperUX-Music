//! Background worker for the playback library (`docs/streaming-renditions.md`, sections 4 & 7):
//! - reconciles Navidrome's `media_file` rows against `sonus-renditions.db` at startup and every 15 minutes;
//! - generates missing renditions concurrently (default 8 workers, low OS priority, yielding to live on-demand
//!   transcodes, honoring `SONUS_RENDITIONS_HOURS`);
//! - injects a 1-second `SEEKTABLE` into every generated FLAC;
//! - decodes every generated rendition end-to-end and checks duration tolerance (`<= 0.1 s`);
//! - measures EBU R128 loudness & true peak per song and aggregates album loudness;
//! - deletes renditions for removed songs after a 7-day grace period, protected by the deletion brake.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::{DateTime, FixedOffset};
use tokio::io::AsyncReadExt;
use tokio::sync::Semaphore;
use tokio::task::JoinSet;
use tracing::{debug, info, warn};

use super::audio_meta::{self, FlacMeta, Loudness, OpusMeta};
use super::ledger::{Change, Ledger, LoudnessChange, Row, State, TrackLoudness};
use super::{Tier, is_dsd_source, is_lossless_source, rendition_path, tiers_for_source};
use crate::db::Db;
use crate::library::stream::inside_library;
use crate::library::transcoder::{Transcoder, ffmpeg_input};
use crate::mirror::s3::Stamp;
use crate::mirror::throttle::Hours;

pub const RECONCILE_EVERY: Duration = Duration::from_secs(15 * 60);
pub const IDLE_SLEEP: Duration = Duration::from_secs(60);
/// How long renditions for a deleted song stay on disk before removal.
pub const GRACE: i64 = 7 * 24 * 3600;
/// Consecutive attempts before marking a rendition/loudness item permanently `failed` (visible in health report).
pub const MAX_FAILURES: u32 = 3;
/// Maximum allowed duration difference between source song and generated rendition (seconds).
pub const MAX_DURATION_DIFF_SECS: f64 = 0.1;
/// Maximum size of one generated rendition file (4 GiB, matching `transcoder.rs`).
pub const MAX_OUTPUT_BYTES: u64 = 4 << 30;
/// Kill a background ffmpeg process if it makes no progress for this long.
pub const STALL_TIMEOUT: Duration = Duration::from_secs(120);
/// Ledger note recording when `sonus-server renditions-allow-deletions` released held deletions.
pub const RELEASED_NOTE: &str = "deletions_released_at";
/// Deletion brake triggers only when more than this many songs disappear at once.
pub const BRAKE_MIN_SONGS: usize = 20;

/// One song currently present in Navidrome's library.
#[derive(Clone, Debug)]
pub struct WantedSong {
    pub song_id: String,
    pub version: String,
    pub album_id: String,
    pub path: PathBuf,
    pub suffix: String,
    pub codec: String,
    pub bit_depth: Option<i64>,
    pub duration: f64,
    pub lossless: bool,
    pub dsd: bool,
    pub stamp: Stamp,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Counts {
    pub added: usize,
    pub kept: usize,
    pub gone: usize,
}

#[derive(Default)]
pub struct Said {
    braked_day: Option<String>,
}

pub struct Worker {
    pub ledger: Arc<Ledger>,
    pub db: Arc<Db>,
    pub dir: PathBuf,
    pub ffmpeg: PathBuf,
    pub concurrency: usize,
    pub hours: Option<Hours>,
    pub delete_brake: Option<f64>,
    pub live_transcodes: Arc<Transcoder>,
    pub clock: Arc<dyn Fn() -> DateTime<FixedOffset> + Send + Sync>,
    pub known: Mutex<HashMap<(String, String), WantedSong>>,
    pub said: Mutex<Said>,
}

impl Worker {
    pub async fn run(self: Arc<Self>) {
        cleanup_part_files(&self.dir);
        loop {
            let next = tokio::time::Instant::now() + RECONCILE_EVERY;
            match self.reconcile().await {
                Ok(counts) if counts != Counts::default() => {
                    info!(added = counts.added, back = counts.kept, gone = counts.gone, "playback library: reconciled with library");
                }
                Ok(_) => {}
                Err(e) => warn!("playback library: cannot reconcile: {e}"),
            }
            self.delete_due().await;
            while tokio::time::Instant::now() < next {
                let worked = self.process_round(next).await;
                if tokio::time::Instant::now() >= next {
                    break;
                }
                let wait = next.saturating_duration_since(tokio::time::Instant::now()).min(if worked { Duration::from_secs(2) } else { IDLE_SLEEP });
                tokio::time::sleep(wait).await;
            }
        }
    }

    /// Compares Navidrome's current songs with `sonus-renditions.db` and records additions, returns, and removals.
    pub async fn reconcile(&self) -> Result<Counts, String> {
        let db = self.db.clone();
        let wanted_list = tokio::task::spawn_blocking(move || scan_library(&db)).await.map_err(|_| "library scan did not finish".to_string())??;
        let now = (self.clock)().timestamp();

        let mut wanted_songs: HashMap<(String, String), WantedSong> = HashMap::with_capacity(wanted_list.len());
        let mut wanted_renditions: HashMap<(String, String, Tier), &WantedSong> = HashMap::new();
        for song in wanted_list {
            wanted_songs.insert((song.song_id.clone(), song.version.clone()), song);
        }
        for song in wanted_songs.values() {
            for &tier in tiers_for_source(song.lossless) {
                wanted_renditions.insert((song.song_id.clone(), song.version.clone(), tier), song);
            }
        }

        let existing = self.ledger.all_renditions()?;
        let existing_map: HashMap<(String, String, Tier), Row> = existing.into_iter().map(|r| ((r.song_id.clone(), r.version.clone(), r.tier), r)).collect();

        let mut changes = Vec::new();
        let mut counts = Counts::default();
        for ((song_id, version, tier), song) in &wanted_renditions {
            let file_exists = rendition_path(&self.dir, song_id, version, *tier).is_some_and(|p| p.is_file());
            match existing_map.get(&(song_id.clone(), version.clone(), *tier)) {
                None => {
                    changes.push(Change::Add { song_id: song_id.clone(), version: version.clone(), tier: *tier, album_id: song.album_id.clone() });
                    counts.added += 1;
                }
                Some(row) if row.state == State::Deleting => {
                    if file_exists && row.generated_at.is_some() {
                        changes.push(Change::KeepReady { song_id: song_id.clone(), version: version.clone(), tier: *tier });
                    } else {
                        changes.push(Change::KeepPending { song_id: song_id.clone(), version: version.clone(), tier: *tier });
                    }
                    counts.kept += 1;
                }
                Some(row) if row.state == State::Ready && !file_exists => {
                    // Self-heal if rendition folder was emptied/deleted
                    changes.push(Change::KeepPending { song_id: song_id.clone(), version: version.clone(), tier: *tier });
                    counts.added += 1;
                }
                Some(_) => {}
            }
        }
        for ((song_id, version, tier), row) in &existing_map {
            if wanted_renditions.contains_key(&(song_id.clone(), version.clone(), *tier)) {
                continue;
            }
            match row.state {
                State::Pending | State::Failed if row.generated_at.is_none() => {
                    if let Some(p) = rendition_path(&self.dir, song_id, version, *tier) {
                        let _ = std::fs::remove_file(p);
                    }
                    changes.push(Change::Forget { song_id: song_id.clone(), version: version.clone(), tier: *tier });
                }
                State::Pending | State::Ready | State::Failed => {
                    changes.push(Change::Gone { song_id: song_id.clone(), version: version.clone(), tier: *tier, since: now });
                    counts.gone += 1;
                }
                State::Deleting => {}
            }
        }
        self.ledger.apply(&changes)?;

        // Reconcile track loudness rows (one per song + version)
        let existing_loudness: HashMap<(String, String), TrackLoudness> =
            self.ledger.all_loudness()?.into_iter().map(|r| ((r.song_id.clone(), r.version.clone()), r)).collect();
        let mut l_changes = Vec::new();
        for ((song_id, version), song) in &wanted_songs {
            match existing_loudness.get(&(song_id.clone(), version.clone())) {
                None => l_changes.push(LoudnessChange::Add {
                    song_id: song_id.clone(),
                    version: version.clone(),
                    album_id: song.album_id.clone(),
                    duration: song.duration,
                }),
                Some(row) if row.state == State::Deleting => {
                    let restore = if row.lufs.is_some() { State::Ready } else { State::Pending };
                    l_changes.push(LoudnessChange::Keep { song_id: song_id.clone(), version: version.clone(), state: restore });
                }
                Some(_) => {}
            }
        }
        for ((song_id, version), row) in &existing_loudness {
            if wanted_songs.contains_key(&(song_id.clone(), version.clone())) {
                continue;
            }
            match row.state {
                State::Pending | State::Failed if row.measured_at.is_none() => {
                    l_changes.push(LoudnessChange::Forget { song_id: song_id.clone(), version: version.clone() });
                }
                State::Pending | State::Ready | State::Failed => {
                    l_changes.push(LoudnessChange::Gone { song_id: song_id.clone(), version: version.clone(), since: now });
                }
                State::Deleting => {}
            }
        }
        self.ledger.apply_loudness(&l_changes)?;

        *self.known.lock().expect("known songs lock") = wanted_songs;
        Ok(counts)
    }

    /// Checks whether too many distinct songs disappeared at once; returns the timestamp released by the owner when
    /// held, or `None` when deletions may proceed freely.
    fn brake(&self) -> Result<Option<i64>, String> {
        let Some(share) = self.delete_brake else { return Ok(None) };
        let rows = self.ledger.all_renditions()?;
        let live_songs: HashSet<&str> = rows.iter().filter(|r| r.state != State::Deleting).map(|r| r.song_id.as_str()).collect();
        let gone_songs: HashSet<&str> =
            rows.iter().filter(|r| r.state == State::Deleting && !live_songs.contains(r.song_id.as_str())).map(|r| r.song_id.as_str()).collect();
        let all = live_songs.len() + gone_songs.len();
        let gone = gone_songs.len();
        let held = gone > BRAKE_MIN_SONGS && gone as f64 > share * all as f64;
        let mut said = self.said.lock().expect("said lock");
        if !held {
            said.braked_day = None;
            return Ok(None);
        }
        let released = self.ledger.note(RELEASED_NOTE)?.and_then(|at| at.parse::<i64>().ok()).unwrap_or(i64::MIN);
        let today = (self.clock)().date_naive().to_string();
        if said.braked_day.as_deref() != Some(today.as_str()) {
            warn!(
                gone,
                of = all,
                "playback library: {gone} of {all} songs disappeared at once, above SONUS_RENDITIONS_DELETE_BRAKE: \
                 renditions are kept. Disk unmounted? Run `sonus-server renditions-allow-deletions` when intentional"
            );
            said.braked_day = Some(today);
        }
        Ok(Some(released))
    }

    /// Deletes rendition files and ledger rows past the 7-day grace window, respecting the brake and never removing
    /// an old version while a song's replacement version is still pending.
    pub async fn delete_due(&self) {
        let now = (self.clock)().timestamp();
        let released = match self.brake() {
            Ok(r) => r,
            Err(e) => {
                warn!("playback library: brake check failed: {e}");
                return;
            }
        };
        let Ok(rows) = self.ledger.all_renditions() else { return };
        let pending_songs: HashSet<&str> = rows.iter().filter(|r| r.state == State::Pending).map(|r| r.song_id.as_str()).collect();
        let live_songs: HashSet<&str> = rows.iter().filter(|r| r.state != State::Deleting).map(|r| r.song_id.as_str()).collect();

        let mut forget = Vec::new();
        for row in rows.iter().filter(|r| r.state == State::Deleting) {
            if row.gone_since.is_none_or(|since| now - since < GRACE) || pending_songs.contains(row.song_id.as_str()) {
                continue;
            }
            if let Some(released) = released {
                let replaced = live_songs.contains(row.song_id.as_str());
                if !replaced && row.gone_since.is_none_or(|since| since > released) {
                    continue;
                }
            }
            if let Some(path) = rendition_path(&self.dir, &row.song_id, &row.version, row.tier) {
                let _ = tokio::fs::remove_file(&path).await;
            }
            forget.push(Change::Forget { song_id: row.song_id.clone(), version: row.version.clone(), tier: row.tier });
        }
        if !forget.is_empty() {
            let count = forget.len();
            if let Err(e) = self.ledger.apply(&forget) {
                warn!("playback library: could not forget deleted renditions: {e}");
            } else {
                info!(deleted = count, "playback library: removed expired renditions");
            }
        }

        // Also expire old loudness rows past grace
        if let Ok(l_rows) = self.ledger.all_loudness() {
            let mut l_forget = Vec::new();
            for row in l_rows.iter().filter(|r| r.state == State::Deleting) {
                if row.gone_since.is_none_or(|since| now - since < GRACE) || pending_songs.contains(row.song_id.as_str()) {
                    continue;
                }
                if let Some(released) = released {
                    let replaced = live_songs.contains(row.song_id.as_str());
                    if !replaced && row.gone_since.is_none_or(|since| since > released) {
                        continue;
                    }
                }
                l_forget.push(LoudnessChange::Forget { song_id: row.song_id.clone(), version: row.version.clone() });
            }
            let _ = self.ledger.apply_loudness(&l_forget);
        }
    }

    /// Processes pending renditions and loudness jobs concurrently up to `self.concurrency` until `until`, the
    /// configured hours end, or the queue drains. Returns `true` if any work ran.
    pub async fn process_round(self: &Arc<Self>, until: tokio::time::Instant) -> bool {
        let now = (self.clock)();
        if self.hours.is_some_and(|h| !h.contains(now.time())) {
            return false;
        }
        if tokio::time::Instant::now() >= until {
            return false;
        }
        // Live playback / on-demand transcodes always take priority over background generation
        if self.live_transcodes.active_count() > 0 {
            tokio::time::sleep(Duration::from_millis(500)).await;
            return true;
        }

        let batch_size = (self.concurrency * 4).max(8);
        let pending_rows = self.ledger.pending_renditions(now.timestamp(), batch_size).unwrap_or_default();
        let pending_loudness = if pending_rows.len() < batch_size {
            self.ledger.pending_loudness(now.timestamp(), batch_size - pending_rows.len()).unwrap_or_default()
        } else {
            Vec::new()
        };

        if pending_rows.is_empty() && pending_loudness.is_empty() {
            return false;
        }

        let sem = Arc::new(Semaphore::new(self.concurrency.max(1)));
        let mut set = JoinSet::new();

        for row in pending_rows {
            if tokio::time::Instant::now() >= until {
                break;
            }
            if self.hours.is_some_and(|h| !h.contains((self.clock)().time())) {
                break;
            }
            // Wait if live on-demand transcodes are active before dispatching a new background ffmpeg
            while self.live_transcodes.active_count() > 0 && tokio::time::Instant::now() < until {
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
            let want = { self.known.lock().expect("known songs lock").get(&(row.song_id.clone(), row.version.clone())).cloned() };
            let Some(want) = want else { continue };
            let Ok(permit) = sem.clone().acquire_owned().await else { break };
            let worker = self.clone();
            set.spawn(async move {
                let _permit = permit;
                worker.generate_one(&row, &want).await;
            });
        }

        for item in pending_loudness {
            if tokio::time::Instant::now() >= until {
                break;
            }
            if self.hours.is_some_and(|h| !h.contains((self.clock)().time())) {
                break;
            }
            while self.live_transcodes.active_count() > 0 && tokio::time::Instant::now() < until {
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
            let want = { self.known.lock().expect("known songs lock").get(&(item.song_id.clone(), item.version.clone())).cloned() };
            let Some(want) = want else { continue };
            let Ok(permit) = sem.clone().acquire_owned().await else { break };
            let worker = self.clone();
            set.spawn(async move {
                let _permit = permit;
                worker.measure_loudness_one(&item, &want).await;
            });
        }

        while set.join_next().await.is_some() {}
        true
    }

    async fn generate_one(&self, row: &Row, want: &WantedSong) {
        let Some(final_path) = rendition_path(&self.dir, &row.song_id, &row.version, row.tier) else {
            return;
        };
        if let Some(parent) = final_path.parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                self.record_rendition_error(row, &format!("cannot create folder: {e}"));
                return;
            }
        }

        let mut rand = [0u8; 8];
        let _ = getrandom::fill(&mut rand);
        let nonce = u64::from_le_bytes(rand);
        let raw_part = final_path.with_extension(format!("{}.{nonce:016x}.raw.part", row.tier.extension()));
        let ready_part = final_path.with_extension(format!("{}.{nonce:016x}.part", row.tier.extension()));

        let result = self.build_and_verify(row.tier, want, &raw_part, &ready_part, &final_path).await;
        // Always clean up temp files on exit
        let _ = tokio::fs::remove_file(&raw_part).await;
        let _ = tokio::fs::remove_file(&ready_part).await;

        // Verify source file did not change mid-encode
        if result.is_ok() && Stamp::of(&want.path).ok().as_ref() != Some(&want.stamp) {
            let _ = tokio::fs::remove_file(&final_path).await;
            let now = (self.clock)().timestamp();
            let _ = self.ledger.mark_attempt_failed(&row.song_id, &row.version, row.tier, row.failures, now + 60, false, "source changed");
            return;
        }

        match result {
            Ok(meta) => {
                let now = (self.clock)().timestamp();
                if let Err(e) = self.ledger.mark_ready(
                    &row.song_id,
                    &row.version,
                    row.tier,
                    meta.sample_rate,
                    meta.bit_depth,
                    meta.channels,
                    meta.total_samples,
                    meta.file_size,
                    now,
                ) {
                    warn!(song_id = %row.song_id, tier = row.tier.as_str(), "playback library: {e}");
                } else {
                    debug!(song_id = %row.song_id, tier = row.tier.as_str(), bytes = meta.file_size, "playback library: generated rendition");
                }
            }
            Err(why) => {
                let _ = tokio::fs::remove_file(&final_path).await;
                self.record_rendition_error(row, &why);
            }
        }
    }

    async fn build_and_verify(&self, tier: Tier, want: &WantedSong, raw_part: &Path, ready_part: &Path, final_path: &Path) -> Result<BuiltMeta, String> {
        let (input_path, use_dsd_opus_filter) = if want.dsd && tier != Tier::Lossless {
            // Prefer encoding DSD Opus tiers from the already-filtered lossless FLAC so ultrasonic DSD noise does not
            // bloat Opus bitrates (Step 0 §12.2).
            match rendition_path(&self.dir, &want.song_id, &want.version, Tier::Lossless).filter(|p| p.is_file()) {
                Some(clean_flac) => (clean_flac, false),
                None => (want.path.clone(), true),
            }
        } else {
            (want.path.clone(), false)
        };

        let input = ffmpeg_input(&input_path).ok_or("source path cannot be passed to ffmpeg")?;
        let args = encode_args(tier, &input, want.dsd, use_dsd_opus_filter, raw_part)?;
        run_ffmpeg(&self.ffmpeg, &args, Some(raw_part)).await?;

        match tier {
            Tier::Lossless => {
                let src = raw_part.to_path_buf();
                let dst = ready_part.to_path_buf();
                let flac: FlacMeta = tokio::task::spawn_blocking(move || audio_meta::write_flac_with_seektable(&src, &dst))
                    .await
                    .map_err(|_| "SEEKTABLE task did not finish".to_string())??;
                verify_duration(flac.duration_secs(), want.duration)?;
                health_decode(&self.ffmpeg, ready_part).await?;
                tokio::fs::rename(ready_part, final_path).await.map_err(|e| format!("cannot move rendition into place: {e}"))?;
                Ok(BuiltMeta {
                    sample_rate: flac.sample_rate,
                    bit_depth: flac.bits_per_sample,
                    channels: flac.channels,
                    total_samples: flac.total_samples,
                    file_size: flac.file_size,
                })
            }
            Tier::VeryHigh | Tier::High | Tier::Normal => {
                let src = raw_part.to_path_buf();
                let opus: OpusMeta = tokio::task::spawn_blocking(move || audio_meta::inspect_ogg_opus(&src))
                    .await
                    .map_err(|_| "Opus inspect task did not finish".to_string())??;
                verify_duration(opus.duration_secs(), want.duration)?;
                health_decode(&self.ffmpeg, raw_part).await?;
                tokio::fs::rename(raw_part, final_path).await.map_err(|e| format!("cannot move rendition into place: {e}"))?;
                Ok(BuiltMeta {
                    sample_rate: opus.sample_rate,
                    bit_depth: 0,
                    channels: opus.channels,
                    total_samples: opus.total_samples,
                    file_size: opus.file_size,
                })
            }
        }
    }

    async fn measure_loudness_one(&self, item: &TrackLoudness, want: &WantedSong) {
        // Measure loudness from the clean lossless FLAC if DSD and ready, else source file
        let src_path = if want.dsd {
            rendition_path(&self.dir, &want.song_id, &want.version, Tier::Lossless).filter(|p| p.is_file()).unwrap_or_else(|| want.path.clone())
        } else {
            want.path.clone()
        };
        let Some(input) = ffmpeg_input(&src_path) else {
            self.record_loudness_error(item, "source path cannot be passed to ffmpeg");
            return;
        };
        let args = loudness_args(&input);
        match run_ffmpeg(&self.ffmpeg, &args, None).await {
            Ok(stderr) => match audio_meta::parse_ebur128(&stderr) {
                Some(Loudness { lufs, peak }) => {
                    if Stamp::of(&want.path).ok().as_ref() != Some(&want.stamp) {
                        return;
                    }
                    let now = (self.clock)().timestamp();
                    if let Err(e) = self.ledger.record_track_loudness(&item.song_id, &item.version, &want.album_id, lufs, peak, now) {
                        warn!(song_id = %item.song_id, "playback library: cannot save loudness: {e}");
                    } else {
                        debug!(song_id = %item.song_id, lufs, peak, "playback library: measured EBU R128 loudness");
                    }
                }
                None => self.record_loudness_error(item, "ebur128 produced no loudness summary"),
            },
            Err(why) => self.record_loudness_error(item, &why),
        }
    }

    fn record_rendition_error(&self, row: &Row, why: &str) {
        let failures = row.failures + 1;
        let permanent = failures >= MAX_FAILURES;
        let now = (self.clock)().timestamp();
        let wait = 60i64 << failures.min(8);
        let msg = truncate_health(why);
        let _ = self.ledger.mark_attempt_failed(&row.song_id, &row.version, row.tier, failures, now + wait, permanent, &msg);
        if permanent {
            warn!(song_id = %row.song_id, tier = row.tier.as_str(), failures, health = %msg, "playback library: rendition health check failed");
        } else {
            debug!(song_id = %row.song_id, tier = row.tier.as_str(), failures, health = %msg, "playback library: rendition attempt failed, retrying later");
        }
    }

    fn record_loudness_error(&self, item: &TrackLoudness, why: &str) {
        let failures = item.failures + 1;
        let permanent = failures >= MAX_FAILURES;
        let now = (self.clock)().timestamp();
        let wait = 60i64 << failures.min(8);
        let msg = truncate_health(why);
        let _ = self.ledger.mark_loudness_failed(&item.song_id, &item.version, failures, now + wait, permanent, &msg);
        if permanent {
            warn!(song_id = %item.song_id, failures, health = %msg, "playback library: loudness measurement failed");
        } else {
            debug!(song_id = %item.song_id, failures, health = %msg, "playback library: loudness attempt failed, retrying later");
        }
    }
}

struct BuiltMeta {
    sample_rate: u32,
    bit_depth: u8,
    channels: u8,
    total_samples: u64,
    file_size: u64,
}

fn verify_duration(actual: f64, expected: f64) -> Result<(), String> {
    if !actual.is_finite() || actual <= 0.0 {
        return Err("rendition has zero duration".into());
    }
    if expected.is_finite() && expected > 0.0 {
        let diff = (actual - expected).abs();
        if diff > MAX_DURATION_DIFF_SECS {
            return Err(format!("duration mismatch: actual={actual:.3}s expected={expected:.3}s diff={diff:.3}s"));
        }
    }
    Ok(())
}

fn truncate_health(msg: &str) -> String {
    let clean: String = msg.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    let trimmed = clean.trim();
    if trimmed.len() <= 240 { trimmed.to_string() } else { format!("{}…", trimmed.chars().take(240).collect::<String>()) }
}

/// Fixed ffmpeg arguments for encoding one rendition tier (no shell, no client input, `file:` protocol only).
pub fn encode_args(tier: Tier, input: &str, is_dsd: bool, dsd_opus_filter: bool, output: &Path) -> Result<Vec<String>, String> {
    let out = output.to_str().ok_or("rendition output path is not valid UTF-8")?.to_string();
    let mut args = vec![
        "-nostdin".into(),
        "-protocol_whitelist".into(),
        "file".into(),
        "-v".into(),
        "error".into(),
        "-i".into(),
        input.to_string(),
        "-map".into(),
        "0:a:0".into(),
        "-vn".into(),
    ];
    match tier {
        Tier::Lossless => {
            if is_dsd {
                // Step 0 §12.2 verified linear-phase FIR filter: 0.0 dB droop 0–20 kHz, -180 dB above 30 kHz.
                args.extend([
                    "-af".into(),
                    "aresample=88200:filter_size=128:cutoff=0.60".into(),
                    "-sample_fmt".into(),
                    "s32".into(),
                    "-bits_per_raw_sample".into(),
                    "24".into(),
                ]);
            }
            args.extend(["-c:a".into(), "flac".into(), "-compression_level".into(), "5".into(), "-f".into(), "flac".into(), "-y".into(), out]);
        }
        Tier::VeryHigh | Tier::High | Tier::Normal => {
            if dsd_opus_filter {
                args.extend(["-af".into(), "aresample=48000:filter_size=128:cutoff=0.85".into()]);
            }
            let kbps = tier.target_bitrate_kbps().expect("Opus tier bitrate");
            args.extend([
                "-c:a".into(),
                "libopus".into(),
                "-b:a".into(),
                format!("{kbps}k"),
                "-vbr".into(),
                "on".into(),
                "-application".into(),
                "audio".into(),
                "-f".into(),
                "ogg".into(),
                "-y".into(),
                out,
            ]);
        }
    }
    Ok(args)
}

/// Fixed ffmpeg arguments for EBU R128 loudness and true-peak measurement.
pub fn loudness_args(input: &str) -> Vec<String> {
    vec![
        "-nostdin".into(),
        "-protocol_whitelist".into(),
        "file".into(),
        "-nostats".into(),
        "-i".into(),
        input.to_string(),
        "-map".into(),
        "0:a:0".into(),
        "-vn".into(),
        "-af".into(),
        "ebur128=peak=true".into(),
        "-f".into(),
        "null".into(),
        "-".into(),
    ]
}

/// Decodes a generated rendition end-to-end (`-v error -f null -`) to verify there are no decode errors.
async fn health_decode(ffmpeg: &Path, file: &Path) -> Result<(), String> {
    let input = ffmpeg_input(file).ok_or("rendition path cannot be passed to ffmpeg")?;
    let args = vec![
        "-nostdin".into(),
        "-protocol_whitelist".into(),
        "file".into(),
        "-v".into(),
        "error".into(),
        "-i".into(),
        input,
        "-map".into(),
        "0:a:0".into(),
        "-f".into(),
        "null".into(),
        "-".into(),
    ];
    let stderr = run_ffmpeg(ffmpeg, &args, None).await.map_err(|e| format!("decode check failed: {e}"))?;
    if !stderr.trim().is_empty() {
        return Err(format!("decode check reported errors: {}", truncate_health(&stderr)));
    }
    Ok(())
}

/// Runs `ffmpeg` at low OS priority (no shell, no `unsafe`), enforcing output size <= 4 GiB and stall timeout.
/// Returns captured stderr (capped at 64 KiB, keeping the tail where `ebur128` prints `Summary:`).
async fn run_ffmpeg(ffmpeg: &Path, args: &[String], output_file: Option<&Path>) -> Result<String, String> {
    let mut command = build_low_priority_command(ffmpeg, args);
    command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped()).kill_on_drop(true);
    let mut child = command.spawn().map_err(|e| format!("ffmpeg did not start: {e}"))?;
    let mut stderr = child.stderr.take();

    // Keep the last 64 KiB of stderr so ebur128's final Summary is never truncated on long tracks
    let stderr_task = tokio::spawn(async move {
        const CAP: usize = 64 << 10;
        let mut buf_all = Vec::new();
        if let Some(ref mut err) = stderr {
            let mut chunk = [0u8; 4096];
            while let Ok(n) = err.read(&mut chunk).await {
                if n == 0 {
                    break;
                }
                buf_all.extend_from_slice(&chunk[..n]);
                if buf_all.len() > CAP * 2 {
                    let drop_n = buf_all.len() - CAP;
                    buf_all.drain(..drop_n);
                }
            }
        }
        String::from_utf8_lossy(&buf_all).into_owned()
    });

    let mut last_progress = tokio::time::Instant::now();
    let mut last_size = 0u64;
    let status = loop {
        match tokio::time::timeout(Duration::from_secs(1), child.wait()).await {
            Ok(Ok(status)) => break status,
            Ok(Err(e)) => {
                let _ = child.kill().await;
                return Err(format!("ffmpeg wait failed: {e}"));
            }
            Err(_) => {
                if let Some(path) = output_file {
                    if let Ok(meta) = std::fs::metadata(path) {
                        let size = meta.len();
                        if size > MAX_OUTPUT_BYTES {
                            let _ = child.kill().await;
                            return Err("ffmpeg output exceeded 4 GiB limit".into());
                        }
                        if size != last_size {
                            last_size = size;
                            last_progress = tokio::time::Instant::now();
                        }
                    }
                }
                if last_progress.elapsed() >= STALL_TIMEOUT {
                    let _ = child.kill().await;
                    return Err("ffmpeg stalled".into());
                }
            }
        }
    };

    let err_text = stderr_task.await.unwrap_or_default();
    if !status.success() {
        let reason = if err_text.trim().is_empty() { format!("ffmpeg exited with {status}") } else { truncate_health(&err_text) };
        return Err(reason);
    }
    if let Some(path) = output_file {
        if let Ok(meta) = std::fs::metadata(path) {
            if meta.len() > MAX_OUTPUT_BYTES {
                return Err("ffmpeg output exceeded 4 GiB limit".into());
            }
        }
    }
    Ok(err_text)
}

fn build_low_priority_command(ffmpeg: &Path, args: &[String]) -> tokio::process::Command {
    #[cfg(windows)]
    {
        let mut cmd = tokio::process::Command::new(ffmpeg);
        cmd.args(args);
        // BELOW_NORMAL_PRIORITY_CLASS | CREATE_NO_WINDOW (safe std API, no unsafe)
        cmd.creation_flags(0x0000_4000 | 0x0800_0000);
        cmd
    }
    #[cfg(unix)]
    {
        if let Some(nice) = crate::library::transcoder::find_program("nice") {
            let mut cmd = tokio::process::Command::new(nice);
            cmd.arg("-n").arg("10").arg(ffmpeg).args(args);
            cmd
        } else {
            let mut cmd = tokio::process::Command::new(ffmpeg);
            cmd.args(args);
            cmd
        }
    }
    #[cfg(not(any(windows, unix)))]
    {
        let mut cmd = tokio::process::Command::new(ffmpeg);
        cmd.args(args);
        cmd
    }
}

/// Scans Navidrome's `media_file` table for non-missing songs whose paths stay inside their library folder.
pub fn scan_library(db: &Db) -> Result<Vec<WantedSong>, String> {
    type DbRow = (String, String, String, String, Option<i64>, f64, String, String);
    let rows: Vec<DbRow> = db
        .read_blocking(|conn| {
            let mut stmt = conn.prepare(
                "SELECT m.id, m.path, coalesce(m.suffix, ''), coalesce(m.codec, ''), m.bit_depth,
                        coalesce(m.duration, 0), coalesce(m.album_id, ''), l.path
                 FROM media_file m
                 JOIN library l ON l.id = m.library_id
                 WHERE m.missing = 0",
            )?;
            let mapped = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?)))?;
            mapped.collect()
        })
        .map_err(|e| format!("cannot read Navidrome's library: {e}"))?;

    let mut out = Vec::with_capacity(rows.len());
    for (song_id, rel_path, suffix, codec, bit_depth, duration, album_id, lib_path) in rows {
        if song_id.is_empty() || !song_id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') || !inside_library(&rel_path) {
            continue;
        }
        let path = Path::new(&lib_path).join(&rel_path);
        let Ok(stamp) = Stamp::of(&path) else { continue };
        let version = stamp.version();
        let lossless = is_lossless_source(&suffix, &codec, bit_depth);
        let dsd = is_dsd_source(&suffix, &codec);
        out.push(WantedSong { song_id, version, album_id, path, suffix, codec, bit_depth, duration, lossless, dsd, stamp });
    }
    Ok(out)
}

/// Removes leftover `*.part` files from interrupted runs on startup.
fn cleanup_part_files(root: &Path) {
    let Ok(entries) = std::fs::read_dir(root) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            cleanup_part_files(&path);
        } else if path.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.ends_with(".part")) {
            let _ = std::fs::remove_file(&path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_args_are_fixed_and_safe() {
        let flac = encode_args(Tier::Lossless, "file:/music/a.flac", false, false, Path::new("/tmp/x.part")).unwrap();
        assert_eq!(&flac[..3], &["-nostdin", "-protocol_whitelist", "file"]);
        assert!(flac.contains(&"-c:a".to_string()) && flac.contains(&"flac".to_string()));
        assert!(!flac.iter().any(|a| a.contains("aresample")));

        let dsd = encode_args(Tier::Lossless, "file:/music/a.dsf", true, false, Path::new("/tmp/x.part")).unwrap();
        assert!(dsd.contains(&"aresample=88200:filter_size=128:cutoff=0.60".to_string()));
        assert!(dsd.contains(&"24".to_string()));

        let opus = encode_args(Tier::High, "file:/music/a.flac", false, false, Path::new("/tmp/x.part")).unwrap();
        assert!(opus.contains(&"libopus".to_string()));
        assert!(opus.contains(&"160k".to_string()));
        assert!(opus.contains(&"ogg".to_string()));
    }

    #[test]
    fn duration_tolerance_checks_within_tenth_of_a_second() {
        assert!(verify_duration(180.00, 180.00).is_ok());
        assert!(verify_duration(180.09, 180.00).is_ok());
        assert!(verify_duration(179.85, 180.00).is_err());
        assert!(verify_duration(0.0, 180.00).is_err());
        assert!(verify_duration(12.5, 0.0).is_ok(), "unscanned source duration=0 skips diff check");
    }
}
