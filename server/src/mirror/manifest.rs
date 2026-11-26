//! The daily manifest (`docs/r2-mirror.md`, sections 2 and 7): which object is which file, so that the music can be
//! restored from the bucket (`cli.rs`). The object names say nothing of what they hold; the manifest does (song paths
//! name artists and titles), so it lives in the private bucket only, never in a log. `manifest/<day>.json.gz`, the
//! last `KEEP` of them kept:
//!
//! ```json
//! {"format": 1, "made": "2026-11-26T03:00:00+01:00",
//!  "libraries": [{"id": 1, "path": "/music"}],
//!  "files": [{"key": "m/<song id>/<version>", "library": 1, "path": "Artist/Album/01 Song.flac", "size": 1234}]}
//! ```
//!
//! A path is inside its library's folder, `/` between its parts; a restore checks it again before it writes.

use std::collections::HashMap;
use std::io::{Read, Write};

use chrono::NaiveDate;
use serde_json::{Value, json};

use super::ledger::{Ledger, State};
use super::sync::Wanted;
use crate::db::Db;

pub const PREFIX: &str = "manifest/";
/// How many days of manifests the bucket keeps.
pub const KEEP: usize = 14;
const FORMAT: i64 = 1;
/// The most a manifest may be unpacked to (about 200 bytes a file: a million files).
pub const MAX_UNPACKED: u64 = 256 << 20;

pub fn key(day: NaiveDate) -> String {
    format!("{PREFIX}{day}.json.gz")
}

/// The day a manifest's key names.
pub fn day_of(key: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(key.strip_prefix(PREFIX)?.strip_suffix(".json.gz")?, "%Y-%m-%d").ok()
}

/// The manifest of what the bucket has now, gzipped. Blocking.
pub fn make(db: &Db, ledger: &Ledger, known: &HashMap<String, Wanted>, made: &str) -> Result<Vec<u8>, String> {
    let libraries: Vec<(i64, String)> = db
        .read_blocking(|conn| conn.prepare("SELECT id, path FROM library ORDER BY id")?.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect())
        .map_err(|e| format!("cannot read the libraries: {e}"))?;
    let mut files = Vec::new();
    let mut keys: Vec<&String> = known.keys().collect();
    keys.sort();
    for key in keys {
        let want = &known[key];
        if want.restore.is_empty() {
            continue;
        }
        let uploaded = ledger.get(key)?.is_some_and(|row| row.state == State::Uploaded && row.size == want.stamp.size);
        if !uploaded {
            continue;
        }
        for (library, path) in &want.restore {
            files.push(json!({"key": key, "library": library, "path": path, "size": want.stamp.size}));
        }
    }
    let manifest = json!({
        "format": FORMAT,
        "made": made,
        "libraries": libraries.iter().map(|(id, path)| json!({"id": id, "path": path})).collect::<Vec<_>>(),
        "files": files,
    });
    let mut packed = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    packed.write_all(manifest.to_string().as_bytes()).map_err(|e| e.to_string())?;
    packed.finish().map_err(|e| e.to_string())
}

/// One file of a manifest.
#[derive(Clone, Debug, PartialEq)]
pub struct File {
    pub key: String,
    pub library: i64,
    pub path: String,
    pub size: u64,
}

#[derive(Debug, PartialEq)]
pub struct Manifest {
    pub made: String,
    /// The libraries' ids and folders (as they were on the server).
    pub libraries: Vec<(i64, String)>,
    pub files: Vec<File>,
}

/// Reads a gzipped manifest. Err: not one this server wrote.
pub fn read(packed: &[u8]) -> Result<Manifest, String> {
    let mut text = Vec::new();
    flate2::read::GzDecoder::new(packed).take(MAX_UNPACKED + 1).read_to_end(&mut text).map_err(|e| format!("the manifest cannot be unpacked: {e}"))?;
    if text.len() as u64 > MAX_UNPACKED {
        return Err("the manifest is larger than any this server writes".into());
    }
    let value: Value = serde_json::from_slice(&text).map_err(|e| format!("the manifest is not JSON: {e}"))?;
    if value["format"].as_i64() != Some(FORMAT) {
        return Err("a manifest of another format".into());
    }
    let bad = || "a manifest entry this server did not write".to_string();
    let libraries = value["libraries"]
        .as_array()
        .ok_or_else(bad)?
        .iter()
        .map(|l| Some((l["id"].as_i64()?, l["path"].as_str()?.to_string())))
        .collect::<Option<Vec<_>>>()
        .ok_or_else(bad)?;
    let files = value["files"]
        .as_array()
        .ok_or_else(bad)?
        .iter()
        .map(|f| {
            Some(File {
                key: f["key"].as_str()?.to_string(),
                library: f["library"].as_i64()?,
                path: f["path"].as_str()?.to_string(),
                size: f["size"].as_u64()?,
            })
        })
        .collect::<Option<Vec<_>>>()
        .ok_or_else(bad)?;
    Ok(Manifest { made: value["made"].as_str().unwrap_or_default().to_string(), libraries, files })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_name_their_day() {
        let day = NaiveDate::from_ymd_opt(2026, 11, 26).unwrap();
        assert_eq!(key(day), "manifest/2026-11-26.json.gz");
        assert_eq!(day_of(&key(day)), Some(day));
        assert_eq!(day_of("manifest/latest.json.gz"), None);
        assert_eq!(day_of("m/2026-11-26.json.gz"), None);
    }

    #[test]
    fn what_is_read_is_what_was_written() {
        let text = json!({"format": 1, "made": "x", "libraries": [{"id": 1, "path": "/music"}],
            "files": [{"key": "m/a/0123", "library": 1, "path": "A/b.flac", "size": 5}]});
        let mut packed = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        packed.write_all(text.to_string().as_bytes()).unwrap();
        let manifest = read(&packed.finish().unwrap()).unwrap();
        assert_eq!(manifest.libraries, vec![(1, "/music".to_string())]);
        assert_eq!(manifest.files, vec![File { key: "m/a/0123".into(), library: 1, path: "A/b.flac".into(), size: 5 }]);
        assert!(read(b"not gzip").is_err());
    }
}
