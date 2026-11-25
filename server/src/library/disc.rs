//! Ported from Navidrome (GPL-3.0), © the Navidrome authors.
//!
//! A disc's cover (`dc-<album>:<disc>`), which Navidrome keeps no state for and finds at every request
//! (`core/artwork/disc.go`, `folders_album.go`, `sources.go`): the album's folder images (and its root folder's, when
//! the album lives in disc folders), walked in `DiscArtPriority` order, a numbered file for this very disc first; the
//! disc's subtitle as a file name; the picture embedded in the disc's first song. Nothing found: the album's cover.
//!
//! Every file is under the album's library folder, named by the scanner's rows (folders and their image files),
//! never by the client.

use std::cmp::Ordering;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use rusqlite::{Connection, OptionalExtension};

use super::natural;
use super::query::{QueryError, Viewer};
use super::stream::inside_library;
use crate::gotime;

/// `DiscArtworkID`.
pub fn disc_id(album_id: &str, disc: i64) -> String {
    format!("{album_id}:{disc}")
}

/// `ParseDiscArtworkID`: the album's id and the disc's number.
pub fn parse_disc_id(id: &str) -> Option<(&str, i64)> {
    let (album, number) = id.split_once(':')?;
    if number.is_empty() {
        return None;
    }
    // strconv.Atoi: an optional sign, then digits
    let digits = number.strip_prefix(['+', '-']).unwrap_or(number);
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some((album, number.parse().ok()?))
}

/// What a disc's cover is read from (`discArtworkReader`).
#[derive(Debug)]
pub struct DiscReader {
    pub album_id: String,
    pub disc: i64,
    /// Library-relative image files of the album's folders, in Navidrome's order.
    img_files: Vec<String>,
    disc_folders: HashSet<String>,
    multi_folder: bool,
    first_track: String,
    subtitle: String,
    root: PathBuf,
    /// `cacheTime`: the newest of the album's times and its folders' image times.
    pub cache_time: DateTime<Utc>,
}

/// What the walk found.
#[derive(Debug, PartialEq)]
pub enum Selected {
    Picture(Vec<u8>),
    /// Nothing: the album's cover is served instead.
    Exhausted,
    Navidromes(&'static str),
}

fn json_strings(text: &str) -> Option<Vec<String>> {
    serde_json::from_str(if text.is_empty() { "[]" } else { text }).ok()
}

struct Folder {
    parent_id: String,
    path: String,
    name: String,
    num_audio_files: i64,
    image_files: Vec<String>,
    images_updated_at: Option<DateTime<Utc>>,
    library_id: i64,
}

impl Folder {
    /// The folder's library-relative path (`path.Join(f.Path, f.Name)` without a leading slash).
    fn rel(&self) -> String {
        join_rel(&self.path, &self.name)
    }
}

/// Go's `path.Join` of two parts, cleaned, without a leading slash.
fn join_rel(a: &str, b: &str) -> String {
    let joined = format!("{a}/{b}");
    let mut parts: Vec<&str> = Vec::new();
    for part in joined.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    parts.join("/")
}

const FOLDER_COLUMNS: &str = "id, parent_id, path, name, num_audio_files, image_files, images_updated_at, library_id";

fn folder_from(r: &rusqlite::Row) -> rusqlite::Result<Option<Folder>> {
    let images: String = r.get(5)?;
    let updated: Option<String> = r.get(6)?;
    let Some(image_files) = json_strings(&images) else { return Ok(None) };
    let images_updated_at = match updated.as_deref() {
        None => None,
        Some(text) => match gotime::parse(text) {
            Some(time) => Some(time),
            None => return Ok(None),
        },
    };
    Ok(Some(Folder {
        parent_id: r.get(1)?,
        path: r.get(2)?,
        name: r.get(3)?,
        num_audio_files: r.get(4)?,
        image_files,
        images_updated_at,
        library_id: r.get(7)?,
    }))
}

/// Folders by id; Err(()) for a row this server does not read as Go does.
fn folders(conn: &Connection, ids: &[String], missing_too: bool) -> Result<Result<Vec<Folder>, ()>, QueryError> {
    if ids.is_empty() {
        return Ok(Ok(Vec::new()));
    }
    let marks = vec!["?"; ids.len()].join(",");
    let missing = if missing_too { "" } else { " AND missing = 0" };
    let sql = format!("SELECT {FOLDER_COLUMNS} FROM folder WHERE id IN ({marks}){missing}");
    let mut statement = conn.prepare(&sql)?;
    let rows: Vec<Option<Folder>> = statement.query_map(rusqlite::params_from_iter(ids), folder_from)?.collect::<rusqlite::Result<_>>()?;
    Ok(rows.into_iter().collect::<Option<Vec<_>>>().ok_or(()))
}

/// `compareImageFiles`: by name without extension (natural order), then shallower first, then the whole path.
fn compare_image_files(a: &str, b: &str) -> Ordering {
    let (a, b) = (a.to_lowercase(), b.to_lowercase());
    let stem = |p: &str| {
        let base = p.rsplit('/').next().unwrap_or(p);
        base.rfind('.').map(|at| base[..at].to_string()).unwrap_or_else(|| base.to_string())
    };
    natural::compare_fold(&stem(&a), &stem(&b)).then_with(|| a.matches('/').count().cmp(&b.matches('/').count())).then_with(|| natural::compare_fold(&a, &b))
}

/// `newDiscArtworkReader`. None: the album is not there for this user (Navidrome's 70). Err: Navidrome's to answer.
pub fn load(conn: &Connection, viewer: &Viewer, album_id: &str, disc: i64) -> Result<Result<Option<DiscReader>, &'static str>, QueryError> {
    // the album as the user may read it
    let mut sql = "SELECT album.folder_ids, album.discs, album.updated_at, album.imported_at, album.library_id, library.path FROM album \
                   LEFT JOIN library ON library.id = album.library_id WHERE album.id = ?"
        .to_string();
    let mut args = vec![rusqlite::types::Value::Text(album_id.to_string())];
    if let Some(filter) = viewer.library_filter("album") {
        sql.push_str(" AND ");
        sql.push_str(&filter.sql);
        args.extend(filter.args);
    }
    type AlbumRow = (String, String, Option<String>, Option<String>, i64, Option<String>);
    let row: Option<AlbumRow> = conn
        .prepare(&sql)?
        .query_row(rusqlite::params_from_iter(args), |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)))
        .optional()?;
    let Some((folder_ids, discs, updated_at, imported_at, _library_id, root)) = row else { return Ok(Ok(None)) };
    let Some(folder_ids) = json_strings(&folder_ids) else { return Ok(Err("an album's folders this server does not read as Go does")) };
    let discs: serde_json::Value = serde_json::from_str(if discs.is_empty() { "{}" } else { &discs }).unwrap_or(serde_json::Value::Null);
    let subtitle = discs.get(disc.to_string()).and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let time = |text: &Option<String>| match text {
        None => Ok(None),
        Some(text) => gotime::parse(text).map(Some).ok_or(()),
    };
    let (Ok(updated_at), Ok(imported_at)) = (time(&updated_at), time(&imported_at)) else {
        return Ok(Err("an album's times this server does not read as Go does"));
    };
    let Some(root) = root else { return Ok(Err("an album without its library")) };

    // loadAlbumFoldersPaths: the album's folders (not missing), and their common parent when it is the album's root
    let Ok(mut album_folders) = folders(conn, &folder_ids, false)? else { return Ok(Err("a folder row this server does not read as Go does")) };
    let ids: HashSet<&str> = folder_ids.iter().map(String::as_str).collect();
    let parent_id = match album_folders.first() {
        Some(first)
            if !first.parent_id.is_empty() && !ids.contains(first.parent_id.as_str()) && album_folders.iter().all(|f| f.parent_id == first.parent_id) =>
        {
            Some(first.parent_id.clone())
        }
        _ => None,
    };
    let any_images = album_folders.iter().any(|f| !f.image_files.is_empty());
    if let Some(parent_id) = parent_id.filter(|_| !(album_folders.len() < 2 && any_images)) {
        let Ok(found) = folders(conn, &[parent_id], true)? else { return Ok(Err("a folder row this server does not read as Go does")) };
        if let Some(parent) = found.into_iter().next().filter(|parent| !parent.parent_id.is_empty()) {
            // HasAudioOutsideFolders: the parent holds no other album's audio
            let other_audio = parent.num_audio_files > 0 || {
                let rel = parent.rel();
                let escaped = rel.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
                let marks = vec!["?"; folder_ids.len()].join(",");
                let sql = format!(
                    "SELECT EXISTS (SELECT 1 FROM folder WHERE library_id = ? AND missing = 0 AND num_audio_files > 0 AND id NOT IN ({marks}) \
                     AND (path = ? OR path LIKE ? ESCAPE '\\'))"
                );
                let mut args: Vec<rusqlite::types::Value> = vec![parent.library_id.into()];
                args.extend(folder_ids.iter().map(|id| rusqlite::types::Value::Text(id.clone())));
                args.push(rel.clone().into());
                args.push(format!("{escaped}/%").into());
                conn.prepare(&sql)?.query_row(rusqlite::params_from_iter(args), |r| r.get::<_, bool>(0))?
            };
            if !other_audio {
                album_folders.push(parent);
            }
        }
    }
    let mut img_files: Vec<String> = Vec::new();
    let mut images_at: Option<DateTime<Utc>> = None;
    for folder in &album_folders {
        images_at = images_at.max(folder.images_updated_at);
        let rel = folder.rel();
        for image in &folder.image_files {
            img_files.push(join_rel(&rel, image));
        }
    }
    img_files.sort_by(|a, b| compare_image_files(a, b));

    // the disc's songs: its folders and its first song
    let mut sql = "SELECT media_file.path, media_file.folder_id FROM media_file WHERE album_id = ? AND disc_number = ?".to_string();
    let mut args: Vec<rusqlite::types::Value> = vec![album_id.to_string().into(), disc.into()];
    if let Some(filter) = viewer.library_filter("media_file") {
        sql.push_str(" AND ");
        sql.push_str(&filter.sql);
        args.extend(filter.args);
    }
    sql.push_str(" ORDER BY track_number ASC, media_file.rowid");
    let songs: Vec<(String, String)> =
        conn.prepare(&sql)?.query_map(rusqlite::params_from_iter(args), |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<rusqlite::Result<_>>()?;
    let first_track = songs.iter().map(|(path, _)| path.replace('\\', "/")).find(|path| !path.is_empty()).unwrap_or_default();
    let mut song_folders: Vec<String> = Vec::new();
    for (_, folder) in &songs {
        if !song_folders.contains(folder) {
            song_folders.push(folder.clone());
        }
    }
    let Ok(disc_folder_rows) = folders(conn, &song_folders, true)? else { return Ok(Err("a folder row this server does not read as Go does")) };
    let mut disc_folders = HashSet::new();
    for folder in &disc_folder_rows {
        disc_folders.insert(folder.rel());
        images_at = images_at.max(folder.images_updated_at);
    }
    let Some(cache_time) = [updated_at, imported_at, images_at].into_iter().flatten().max() else {
        return Ok(Err("a disc with no time at all: Navidrome's zero time"));
    };
    Ok(Ok(Some(DiscReader {
        album_id: album_id.to_string(),
        disc,
        img_files,
        disc_folders,
        multi_folder: folder_ids.len() > 1,
        first_track,
        subtitle,
        root: PathBuf::from(root),
        cache_time,
    })))
}

/// Go's `filepath.Match` for a file name (no separators in it): `*`, `?`, `[…]` with ranges and `^`. None: a
/// malformed pattern.
pub fn glob(pattern: &str, name: &str) -> Option<bool> {
    fn class(pattern: &[char], c: char) -> Result<(bool, usize), ()> {
        // pattern starts after '['; returns (matched, length consumed including ']')
        let mut i = 0;
        let negated = pattern.first() == Some(&'^');
        if negated {
            i += 1;
        }
        let mut matched = false;
        let mut first = true;
        loop {
            let Some(&lo) = pattern.get(i) else { return Err(()) };
            if lo == ']' && !first {
                return Ok((matched != negated, i + 1));
            }
            first = false;
            if lo == '\\' {
                return Err(());
            }
            i += 1;
            let mut hi = lo;
            if pattern.get(i) == Some(&'-') && pattern.get(i + 1).is_some_and(|&c| c != ']') {
                hi = pattern[i + 1];
                if hi == '\\' {
                    return Err(());
                }
                i += 2;
            }
            if lo <= c && c <= hi {
                matched = true;
            }
        }
    }
    fn go(p: &[char], n: &[char]) -> Result<bool, ()> {
        match p.first() {
            None => Ok(n.is_empty()),
            Some('*') => {
                let rest = &p[1..];
                for skip in 0..=n.len() {
                    if go(rest, &n[skip..])? {
                        return Ok(true);
                    }
                }
                Ok(false)
            }
            Some('?') => Ok(!n.is_empty() && go(&p[1..], &n[1..])?),
            Some('[') => {
                let Some(&c) = n.first() else {
                    class(&p[1..], ' ')?;
                    return Ok(false);
                };
                let (matched, used) = class(&p[1..], c)?;
                Ok(matched && go(&p[1 + used..], &n[1..])?)
            }
            Some('\\') => Err(()),
            Some(&c) => Ok(n.first() == Some(&c) && go(&p[1..], &n[1..])?),
        }
    }
    let (p, n): (Vec<char>, Vec<char>) = (pattern.chars().collect(), name.chars().collect());
    go(&p, &n).ok()
}

/// `extractDiscNumber`: the number right after the pattern's literal start.
fn disc_number_in(pattern: &str, name: &str) -> Option<i64> {
    let meta = pattern.find(['*', '?', '['])?;
    let rest = name.strip_prefix(&pattern[..meta])?;
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() {
        return None;
    }
    digits.parse().ok()
}

/// TagLib's name for a picture's type, as `findBestImageIndex` matches it.
fn taglib_type(picture: &lofty::picture::Picture, mp4: bool) -> &'static str {
    use lofty::picture::PictureType as T;
    if mp4 {
        // TagLib names every MP4 cover a front cover
        return "Front Cover";
    }
    match picture.pic_type() {
        T::CoverFront => "Front Cover",
        T::CoverBack => "Back Cover",
        T::Icon => "File Icon",
        T::OtherIcon => "Other File Icon",
        T::Leaflet => "Leaflet Page",
        T::Media => "Media",
        T::LeadArtist => "Lead Artist",
        T::Artist => "Artist",
        T::Conductor => "Conductor",
        T::Band => "Band",
        T::Composer => "Composer",
        T::Lyricist => "Lyricist",
        T::RecordingLocation => "Recording Location",
        T::DuringRecording => "During Recording",
        T::DuringPerformance => "During Performance",
        T::ScreenCapture => "Movie Screen Capture",
        T::BrightFish => "Coloured Fish",
        T::Illustration => "Illustration",
        T::BandLogo => "Band Logo",
        T::PublisherLogo => "Publisher Logo",
        _ => "Other",
    }
}

/// `findBestImageIndex`: a front cover, else anything named front, else anything named cover, else the first.
fn best_picture(types: &[&str]) -> usize {
    let lower: Vec<String> = types.iter().map(|t| t.to_lowercase()).collect();
    let front_cover = |t: &str| t.find("cover").is_some_and(|c| t[c..].contains("front")) || t.find("front").is_some_and(|f| t[f..].contains("cover"));
    let rules: [&dyn Fn(&str) -> bool; 3] = [&front_cover, &|t| t.contains("front"), &|t| t.contains("cover")];
    rules.iter().find_map(|rule| lower.iter().position(|t| rule(t))).unwrap_or(0)
}

/// The formats whose pictures lofty reads as TagLib does; for others (and unreadable files) Navidrome also asks
/// ffmpeg, which is its to do.
const EMBEDDED_FORMATS: [&str; 6] = ["mp3", "flac", "m4a", "ogg", "opus", "oga"];

/// `fromTag`: the picture embedded in a song, at most `limit` bytes. Ok(None): the file has none.
///
/// Navidrome bounds nothing here (TagLib reads the picture whole): a full-size answer serves it as it is, and a resize
/// over `MaxImageSize` fails, so the disc shows its album's cover. Here a picture over the limit is not taken (that
/// answer is Navidrome's), and lofty itself refuses any single allocation over 16 MiB while it reads a tag (its
/// `allocation_limit`), so a picture frame cannot make it allocate more.
pub fn embedded_picture(path: &Path, limit: u64) -> Result<Option<Vec<u8>>, &'static str> {
    use lofty::file::TaggedFileExt;
    let suffix = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    if !EMBEDDED_FORMATS.contains(&suffix.as_str()) {
        return Err("a format whose pictures Navidrome reads with TagLib or ffmpeg");
    }
    let file = lofty::read_from_path(path).map_err(|_| "a song file lofty cannot read: Navidrome asks TagLib and ffmpeg")?;
    let mp4 = suffix == "m4a";
    let pictures: Vec<&lofty::picture::Picture> = file.tags().iter().flat_map(|tag| tag.pictures()).collect();
    if pictures.is_empty() {
        return Ok(None);
    }
    let types: Vec<&str> = pictures.iter().map(|p| taglib_type(p, mp4)).collect();
    let picture = pictures[best_picture(&types)];
    if picture.data().len() as u64 > limit {
        return Err("an embedded picture over the size this server reads: Navidrome's");
    }
    Ok((!picture.data().is_empty()).then(|| picture.data().to_vec()))
}

/// The most a picture read here may be.
const MAX_PICTURE_BYTES: u64 = 64 << 20;

impl DiscReader {
    fn open(&self, rel: &str) -> Result<Vec<u8>, &'static str> {
        if !inside_library(rel) {
            return Err("an image path that leaves the library's folder");
        }
        let path = self.root.join(rel);
        match std::fs::metadata(&path) {
            Ok(meta) if meta.is_file() && meta.len() <= MAX_PICTURE_BYTES => std::fs::read(&path).map_err(|_| "a disc image that cannot be read"),
            _ => Err("a disc image that cannot be opened: Navidrome goes on with the next candidate"),
        }
    }

    /// `selectImage`: the first candidate of `priority` with a picture.
    pub fn select(&self, priority: &str) -> Selected {
        for pattern in priority.to_lowercase().split(',') {
            let pattern = pattern.trim();
            if pattern.is_empty() || pattern == "external" {
                continue;
            }
            let found = match pattern {
                "embedded" => {
                    if self.first_track.is_empty() {
                        continue;
                    }
                    if !inside_library(&self.first_track) {
                        return Selected::Navidromes("a song path that leaves the library's folder");
                    }
                    match embedded_picture(&self.root.join(&self.first_track), MAX_PICTURE_BYTES) {
                        Ok(Some(bytes)) => Some(Ok(bytes)),
                        Ok(None) => None,
                        Err(why) => return Selected::Navidromes(why),
                    }
                }
                "discsubtitle" => {
                    if self.subtitle.is_empty() {
                        continue;
                    }
                    self.img_files.iter().find(|file| stem(file).eq_ignore_ascii_case(&self.subtitle)).map(|file| self.open(file))
                }
                _ if self.img_files.is_empty() => continue,
                _ => self.matching(pattern),
            };
            match found {
                Some(Ok(bytes)) => return Selected::Picture(bytes),
                Some(Err(why)) => return Selected::Navidromes(why),
                None => {}
            }
        }
        Selected::Exhausted
    }

    /// `fromExternalFile`: a file numbered for this disc first, else the first that matches (in a multi-folder album,
    /// only in this disc's folders).
    fn matching(&self, pattern: &str) -> Option<Result<Vec<u8>, &'static str>> {
        let literal = !pattern.contains(['*', '?', '[']);
        let mut fallbacks = Vec::new();
        for file in &self.img_files {
            let name = file.rsplit('/').next().unwrap_or(file).to_lowercase();
            if glob(pattern, &name) != Some(true) {
                continue;
            }
            if !literal {
                if let Some(number) = disc_number_in(pattern, &name) {
                    if number != self.disc {
                        continue;
                    }
                    return Some(self.open(file));
                }
            }
            let dir = file.rfind('/').map(|at| &file[..at]).unwrap_or(".");
            if self.multi_folder && !self.disc_folders.contains(dir) {
                continue;
            }
            fallbacks.push(file);
        }
        fallbacks.first().map(|file| self.open(file))
    }
}

/// `utils.BaseName`: the file name without its extension.
fn stem(file: &str) -> &str {
    let base = file.rsplit('/').next().unwrap_or(file);
    base.rfind('.').map(|at| &base[..at]).unwrap_or(base)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disc_ids_are_read_as_navidrome_reads_them() {
        assert_eq!(parse_disc_id("5MBp09M784e3YBEhG2QWzJ:1"), Some(("5MBp09M784e3YBEhG2QWzJ", 1)));
        assert_eq!(parse_disc_id("a:+2"), Some(("a", 2)));
        assert_eq!(parse_disc_id("a:b:1"), None, "SplitN: the disc part is 'b:1'");
        for bad in ["a", "a:", "a:x", "a:1.5", ":"] {
            assert_eq!(parse_disc_id(bad), None, "{bad}");
        }
        assert_eq!(parse_disc_id(":1"), Some(("", 1)));
    }

    #[test]
    fn globs_match_as_go_matches_them() {
        assert_eq!(glob("disc*.*", "disc1.jpg"), Some(true));
        assert_eq!(glob("disc*.*", "disc.jpg"), Some(true));
        assert_eq!(glob("disc*.*", "cover.jpg"), Some(false));
        assert_eq!(glob("cd?.png", "cd2.png"), Some(true));
        assert_eq!(glob("cd?.png", "cd12.png"), Some(false));
        assert_eq!(glob("[ab]*.jpg", "back.jpg"), Some(true));
        assert_eq!(glob("[^ab]*.jpg", "back.jpg"), Some(false));
        assert_eq!(glob("[a-c]x", "bx"), Some(true));
        assert_eq!(glob("cover.jpg", "cover.jpg"), Some(true));
        assert_eq!(glob("[a", "a"), None);
        assert_eq!(disc_number_in("disc*.*", "disc2.jpg"), Some(2));
        assert_eq!(disc_number_in("disc*.*", "disc.jpg"), None);
        assert_eq!(disc_number_in("cover.*", "cover.jpg"), None);
    }

    #[test]
    fn image_files_in_navidromes_order() {
        let mut files = vec!["a/cover.2.jpg", "a/b/cover.jpg", "a/Cover.jpg", "a/cover.10.jpg", "a/back.jpg"];
        files.sort_by(|a, b| compare_image_files(a, b));
        assert_eq!(files, ["a/back.jpg", "a/Cover.jpg", "a/b/cover.jpg", "a/cover.2.jpg", "a/cover.10.jpg"]);
        assert_eq!(join_rel("Artist", "Album"), "Artist/Album");
        assert_eq!(join_rel("", "Album"), "Album");
        assert_eq!(join_rel("/a/", "b/"), "a/b");
    }

    /// A FLAC file with no audio: STREAMINFO, then one PICTURE block (a front cover of picture bytes).
    fn flac_with_picture(picture: &[u8]) -> Vec<u8> {
        let mut out = b"fLaC".to_vec();
        // STREAMINFO (not last), 34 bytes: block sizes 4096, no frame sizes, 44100 Hz, 2 channels, 16 bits, no samples
        out.extend_from_slice(&[0x00, 0, 0, 34, 0x10, 0x00, 0x10, 0x00, 0, 0, 0, 0, 0, 0]);
        out.extend_from_slice(&[0x0A, 0xC4, 0x42, 0xF0, 0, 0, 0, 0]);
        out.extend_from_slice(&[0; 16]);
        // PICTURE (last): type 3 (front cover), "image/jpeg", no description, 1 × 1, 24 bits, no palette
        let mut block = Vec::new();
        block.extend_from_slice(&3u32.to_be_bytes());
        block.extend_from_slice(&10u32.to_be_bytes());
        block.extend_from_slice(b"image/jpeg");
        block.extend_from_slice(&0u32.to_be_bytes());
        for value in [1u32, 1, 24, 0] {
            block.extend_from_slice(&value.to_be_bytes());
        }
        block.extend_from_slice(&(picture.len() as u32).to_be_bytes());
        block.extend_from_slice(picture);
        let length = block.len() as u32;
        out.push(0x80 | 6);
        out.extend_from_slice(&length.to_be_bytes()[1..]);
        out.extend_from_slice(&block);
        out
    }

    #[test]
    fn an_embedded_picture_is_bounded() {
        let dir = std::env::temp_dir().join(format!("sonus-embedded-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let picture: Vec<u8> = [&[0xFF, 0xD8, 0xFF, 0xE0][..], &[7u8; 996][..]].concat();
        let song = dir.join("one.flac");
        std::fs::write(&song, flac_with_picture(&picture)).unwrap();
        assert_eq!(embedded_picture(&song, 2000), Ok(Some(picture.clone())), "within the limit: the picture's bytes");
        assert!(embedded_picture(&song, 999).is_err(), "over it: Navidrome's");
        let bare = dir.join("bare.flac");
        let mut no_picture = flac_with_picture(&[]);
        no_picture.truncate(42);
        no_picture[4] |= 0x80; // STREAMINFO is the last block
        std::fs::write(&bare, no_picture).unwrap();
        assert_eq!(embedded_picture(&bare, 2000), Ok(None), "no picture");
        assert!(embedded_picture(&dir.join("a.wav"), 2000).is_err(), "a format lofty is not trusted with here");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_best_embedded_picture() {
        assert_eq!(best_picture(&["Other", "Front Cover"]), 1);
        assert_eq!(best_picture(&["Back Cover", "Media"]), 0);
        assert_eq!(best_picture(&["Media", "Back Cover"]), 1, "a cover of any side over something else");
        assert_eq!(best_picture(&["Artist", "Band"]), 0, "no cover: the first");
        assert_eq!(best_picture(&["cover (front)", "Front Cover"]), 0);
    }
}
