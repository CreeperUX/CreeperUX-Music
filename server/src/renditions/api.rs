//! Read-only Subsonic endpoints for the playback library (`docs/protocol/renditions.md`):
//! - `getSonusRenditions`: ready renditions and EBU R128 loudness for requested visible song IDs;
//! - `getSonusLibraryHealth`: admin-only progress counts and failed health-check issue list.

use std::collections::{HashMap, HashSet};

use rusqlite::types::Value;

use super::{Tier, is_lossless_source};
use crate::library::browse::int_or;
use crate::library::json::Json;
use crate::library::query::{self, Cond, ListOptions, QueryError, Song};
use crate::library::stream::{file_of, inside_library};
use crate::library::{Reply, Scope};
use crate::mirror::s3::Stamp;
use crate::subsonic::respond::{AUTHORIZATION_FAIL, MISSING_PARAMETER};

/// Maximum song IDs accepted in a single `getSonusRenditions` call.
const MAX_IDS: usize = 500;

/// `getSonusRenditions`: returns ready renditions and EBU R128 loudness for each requested song visible to the user.
pub fn get_renditions(scope: &Scope) -> Result<Reply, QueryError> {
    let raw_ids = scope.params.all("id");
    let mut ids: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for raw in raw_ids {
        let Ok(text) = std::str::from_utf8(raw) else { continue };
        let text = text.trim();
        if text.is_empty() {
            continue;
        }
        if seen.insert(text.to_string()) {
            ids.push(text.to_string());
            if ids.len() >= MAX_IDS {
                break;
            }
        }
    }
    if ids.is_empty() {
        return Ok(Reply::error(MISSING_PARAMETER, "missing parameter: 'id'"));
    }

    let Some(renditions) = scope.renditions else {
        let mut j = Json::new();
        j.object("sonusRenditions", |j| {
            j.boolean("enabled", false);
            j.array("songs", Vec::<&Song>::new(), |_, _| {});
        });
        return Ok(Reply::ok(j.finish()));
    };

    // Enforce Navidrome's library visibility filter via query::songs
    let filter = Cond::is_in("media_file.id", ids.iter().map(|id| Value::Text(id.clone())).collect());
    let list = ListOptions { filter: Some(filter), ..ListOptions::default() };
    let songs = query::songs(scope.conn, scope.viewer, scope.options, &list)?;
    let by_id: HashMap<&str, &Song> = songs.iter().map(|s| (s.id.as_str(), s)).collect();

    let mut j = Json::new();
    j.object("sonusRenditions", |j| {
        j.boolean("enabled", true);
        j.array("songs", ids.iter().filter_map(|id| by_id.get(id.as_str()).copied()), |j, song| {
            write_song_renditions(j, song, renditions);
        });
    });
    Ok(Reply::ok(j.finish()))
}

fn write_song_renditions(j: &mut Json, song: &Song, renditions: &super::Renditions) {
    let lossless = is_lossless_source(&song.suffix, &song.codec, song.bit_depth);
    let version = if inside_library(&song.path) { Stamp::of(&file_of(song)).ok().map(|s| s.version()) } else { None };
    let (rows, track_loudness, album_loudness) = match version.as_deref() {
        Some(ver) => renditions.song_info(&song.id, ver, &song.album_id),
        None => (Vec::new(), None, renditions.ledger.get_album_loudness(&song.album_id).ok().flatten()),
    };

    j.begin_object();
    j.string("id", &song.id);
    j.string_ne("sourceFormat", &song.suffix.to_ascii_lowercase());
    j.boolean("sourceLossless", lossless);
    j.int_ne("sourceSampleRate", song.sample_rate);
    if let Some(bd) = song.bit_depth.filter(|&b| b > 0) {
        j.int("sourceBitDepth", bd);
    }
    j.int_ne("sourceBitRate", song.bit_rate);

    let has_loudness = track_loudness.as_ref().is_some_and(|t| t.lufs.is_some()) || album_loudness.is_some();
    if has_loudness {
        j.object("loudness", |j| {
            if let Some(t) = &track_loudness {
                j.float_some("trackLufs", t.lufs);
                j.float_some("trackPeak", t.peak);
            }
            if let Some(a) = &album_loudness {
                j.float("albumLufs", a.lufs);
                j.float("albumPeak", a.peak);
            }
        });
    }

    j.array("renditions", &rows, |j, row| {
        j.begin_object();
        j.string("tier", row.tier.as_str());
        j.string("format", &row.format);
        j.int_ne("sampleRate", row.sample_rate as i64);
        if row.bit_depth > 0 {
            j.int("bitDepth", row.bit_depth as i64);
        }
        j.int_ne("channels", row.channels as i64);
        j.int_ne("totalSamples", row.total_samples as i64);
        let bit_rate = rendition_bitrate_kbps(row.tier, row.file_size, row.total_samples, row.sample_rate);
        j.int_ne("bitRate", bit_rate as i64);
        j.int("fileSize", row.file_size as i64);
        j.end_object();
    });
    j.end_object();
}

/// Bit rate reported for a rendition (nominal target kbps for Opus; average kbps for lossless FLAC).
pub fn rendition_bitrate_kbps(tier: Tier, file_size: u64, total_samples: u64, sample_rate: u32) -> u32 {
    if let Some(target) = tier.target_bitrate_kbps() {
        return target;
    }
    if sample_rate == 0 || total_samples == 0 || file_size == 0 {
        return 0;
    }
    let secs = total_samples as f64 / sample_rate as f64;
    if secs <= 0.0 { 0 } else { ((file_size as f64 * 8.0) / secs / 1000.0).round() as u32 }
}

/// `getSonusLibraryHealth`: admin-only playback library status and health-check issue list.
pub fn get_health(scope: &Scope) -> Result<Reply, QueryError> {
    if !scope.viewer.is_admin {
        return Ok(Reply::error(AUTHORIZATION_FAIL, "User is not authorized for the given operation"));
    }
    let limit = int_or(scope.params, "limit", 200).clamp(1, 1000) as usize;
    let offset = int_or(scope.params, "offset", 0).max(0) as usize;

    let Some(renditions) = scope.renditions else {
        let mut j = Json::new();
        j.object("sonusLibraryHealth", |j| {
            j.boolean("enabled", false);
            j.object("counts", |j| {
                j.int("ready", 0);
                j.int("pending", 0);
                j.int("failed", 0);
                j.int("deleting", 0);
            });
            j.int("totalIssues", 0);
            j.array("issues", Vec::<()>::new(), |_, _| {});
        });
        return Ok(Reply::ok(j.finish()));
    };

    let Ok(report) = renditions.health_report(limit, offset) else {
        return Ok(Reply::error(0, "could not read playback library health"));
    };

    // Hydrate title / artist / album from Navidrome's DB for display in Settings
    let mut song_meta: HashMap<String, (String, String, String)> = HashMap::new();
    let issue_ids: Vec<Value> = report.issues.iter().map(|i| Value::Text(i.song_id.clone())).collect();
    if !issue_ids.is_empty() {
        let list = ListOptions { filter: Some(Cond::is_in("media_file.id", issue_ids)), ..ListOptions::default() };
        if let Ok(songs) = query::songs(scope.conn, scope.viewer, scope.options, &list) {
            for s in songs {
                song_meta.insert(s.id, (s.title, s.artist, s.album));
            }
        }
    }

    let mut j = Json::new();
    j.object("sonusLibraryHealth", |j| {
        j.boolean("enabled", true);
        j.object("counts", |j| {
            j.int("ready", report.ready as i64);
            j.int("pending", report.pending as i64);
            j.int("failed", report.failed as i64);
            j.int("deleting", report.deleting as i64);
        });
        j.int("totalIssues", report.total_issues as i64);
        j.array("issues", &report.issues, |j, issue| {
            j.begin_object();
            j.string("songId", &issue.song_id);
            if let Some((title, artist, album)) = song_meta.get(&issue.song_id) {
                j.string_ne("title", title);
                j.string_ne("artist", artist);
                j.string_ne("album", album);
            }
            j.string("tier", &issue.tier);
            j.string("state", &issue.state);
            j.string("health", &issue.health);
            j.int("failures", issue.failures as i64);
            j.end_object();
        });
    });
    Ok(Reply::ok(j.finish()))
}
