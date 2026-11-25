//! A cache of files of this server's own (the transcoding cache, resized covers): one file per entry, named by the
//! SHA-256 of its key, written to a part file and renamed when complete, the least recently used dropped first when
//! the total is over the size. Nothing from a client names a file here.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;
use tracing::warn;

pub struct Cache {
    folder: PathBuf,
    size: u64,
    index: Mutex<Option<Index>>,
}

#[derive(Default)]
pub(super) struct Index {
    /// name → (bytes, last use)
    entries: HashMap<String, (u64, u64)>,
    total: u64,
    clock: u64,
    /// Names being written.
    writing: HashSet<String>,
}

/// A cache entry being written: a file of its own, renamed when complete.
pub struct Entry {
    cache: Arc<Cache>,
    name: String,
    part: PathBuf,
    file: tokio::fs::File,
    size: u64,
}

fn name_of(key: &str) -> String {
    Sha256::digest(key.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

impl Cache {
    pub fn new(folder: PathBuf, size: u64) -> Cache {
        Cache { folder, size, index: Mutex::new(None) }
    }

    /// The index, read from the folder at first use: what is there and finished; anything half written is removed.
    fn with_index<T>(&self, f: impl FnOnce(&mut Index) -> T) -> T {
        let mut guard = self.index.lock().expect("the cache's lock");
        let index = guard.get_or_insert_with(|| {
            let mut index = Index::default();
            let _ = std::fs::create_dir_all(&self.folder);
            if let Ok(dir) = std::fs::read_dir(&self.folder) {
                for item in dir.flatten() {
                    let name = item.file_name().to_string_lossy().into_owned();
                    let Ok(meta) = item.metadata() else { continue };
                    if name.len() == 64 && name.bytes().all(|b| b.is_ascii_hexdigit()) && meta.is_file() {
                        index.total += meta.len();
                        index.entries.insert(name, (meta.len(), 0));
                    } else if name.ends_with(".part") {
                        let _ = std::fs::remove_file(item.path());
                    }
                }
            }
            index
        });
        f(index)
    }

    fn path(&self, name: &str) -> PathBuf {
        self.folder.join(name)
    }

    pub fn get(&self, key: &str) -> Option<PathBuf> {
        let name = name_of(key);
        let found = self.with_index(|index| {
            index.clock += 1;
            let clock = index.clock;
            index.entries.get_mut(&name).map(|entry| entry.1 = clock).is_some()
        });
        if !found {
            return None;
        }
        let path = self.path(&name);
        if path.is_file() {
            return Some(path);
        }
        // the entry outlived its file
        self.with_index(|index| {
            if let Some((size, _)) = index.entries.remove(&name) {
                index.total -= size;
            }
        });
        None
    }

    /// A new entry for a key, unless one is being written already (that request then runs on its own, uncached).
    pub fn begin(self: Arc<Self>, key: &str) -> Option<Entry> {
        let name = name_of(key);
        if !self.with_index(|index| index.writing.insert(name.clone())) {
            return None;
        }
        let mut random = [0u8; 8];
        let _ = getrandom::fill(&mut random);
        let part = self.path(&format!("{name}.{}.part", u64::from_le_bytes(random)));
        let file = match std::fs::create_dir_all(&self.folder).and_then(|_| std::fs::File::create(&part)) {
            Ok(file) => tokio::fs::File::from_std(file),
            Err(e) => {
                warn!(error = %e, "the transcoding cache cannot be written");
                self.with_index(|index| index.writing.remove(&name));
                return None;
            }
        };
        Some(Entry { cache: self, name, part, file, size: 0 })
    }
}

impl Entry {
    /// Writes a chunk; false when the entry is given up (too big for the cache, or the disk refuses).
    pub async fn write(&mut self, bytes: &[u8]) -> bool {
        self.size += bytes.len() as u64;
        self.size <= self.cache.size && self.file.write_all(bytes).await.is_ok()
    }

    /// The entry is complete: in place, and the least used ones dropped until the cache fits its size.
    pub async fn finish(mut self) {
        if self.file.flush().await.is_err() || self.file.sync_all().await.is_err() {
            return;
        }
        let final_path = self.cache.path(&self.name);
        if tokio::fs::rename(&self.part, &final_path).await.is_err() {
            return;
        }
        let (cache, name, size) = (self.cache.clone(), self.name.clone(), self.size);
        let dropped = cache.with_index(|index| {
            index.clock += 1;
            let clock = index.clock;
            if let Some((old, _)) = index.entries.insert(name.clone(), (size, clock)) {
                index.total -= old;
            }
            index.total += size;
            let mut dropped = Vec::new();
            while index.total > cache.size {
                let Some(oldest) = index.entries.iter().filter(|(n, _)| **n != name).min_by_key(|(_, (_, used))| *used).map(|(n, _)| n.clone()) else {
                    break;
                };
                let (bytes, _) = index.entries.remove(&oldest).expect("listed");
                index.total -= bytes;
                dropped.push(oldest);
            }
            dropped
        });
        for name in dropped {
            let _ = tokio::fs::remove_file(cache.path(&name)).await;
        }
    }
}

impl Drop for Entry {
    fn drop(&mut self) {
        // finished entries were renamed: removing the part then fails, harmlessly
        let _ = std::fs::remove_file(&self.part);
        self.cache.with_index(|index| index.writing.remove(&self.name));
    }
}
