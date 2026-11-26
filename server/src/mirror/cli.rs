//! The mirror's command line, beside the running server (with its settings: the same environment, config file and
//! flags):
//!
//! - `sonus-server r2-restore --to <folder> [--manifest <day>] [--library <id>]`: downloads the music (and the
//!   covers that are files in the album folders) back to where the day's manifest says they belong, inside the
//!   folder given. A file there already at its size is skipped, so a restore cut short goes on where it stopped.
//! - `sonus-server r2-allow-deletions`: lets the deletions the brake holds go (`sync.rs`): what is gone from the
//!   library by now is deleted from the bucket after its grace time.
//!
//! Neither prints a key, a signature or a link.

use std::ffi::OsString;
use std::path::{Component, Path, PathBuf};

use super::ledger::{Kind, Ledger, State};
use super::manifest::{self, File};
use super::s3::{self, S3};
use super::sigv4::Signer;
use super::sync::{GRACE, RELEASED_NOTE};
use crate::config::{Config, RealFiles, Sources};

pub const RESTORE: &str = "r2-restore";
pub const ALLOW_DELETIONS: &str = "r2-allow-deletions";

const RESTORE_USAGE: &str = "usage: sonus-server r2-restore --to <folder> [--manifest <YYYY-MM-DD>] [--library <id>]\n\
    \x20 Downloads the music from the R2 mirror back into <folder>, where the day's manifest (the latest by default)\n\
    \x20 says each file belongs. Files there already at their size are skipped: run it again to go on.\n\
    \x20 --library  which library, when the manifest has several";
const ALLOW_USAGE: &str = "usage: sonus-server r2-allow-deletions\n\
    \x20 The R2 mirror holds its deletions when much of the library is gone at once (SONUS_R2_DELETE_BRAKE). When the\n\
    \x20 files are gone for good, this lets them go: deleted from the bucket after their grace time.";

/// How many times a file's download is tried before it is counted as failed.
const TRIES: u32 = 3;
/// The most a manifest's download may be.
const MANIFEST_LIMIT: usize = 64 << 20;
/// What a file is downloaded under before it is whole.
const PART_SUFFIX: &str = ".sonus-restore";

/// Whether the first argument is one of these commands.
pub fn is_command(first: &OsString) -> bool {
    first == RESTORE || first == ALLOW_DELETIONS
}

/// Runs `command` with the arguments after it. Ok: what to print. Err: why it failed.
pub async fn run(command: &OsString, args: Vec<OsString>, var: &dyn Fn(&str) -> Option<String>) -> Result<String, String> {
    if command == ALLOW_DELETIONS {
        return allow_deletions(args, var);
    }
    restore(args, var).await
}

fn allow_deletions(args: Vec<OsString>, var: &dyn Fn(&str) -> Option<String>) -> Result<String, String> {
    if args.iter().any(|a| a == "--help" || a == "-h") {
        return Ok(ALLOW_USAGE.into());
    }
    let config = Config::load(Sources { var, args, files: &RealFiles })?;
    let folder = PathBuf::from(&config.shared.data_folder);
    if !folder.join(super::ledger::FILE_NAME).is_file() {
        return Err(format!("no mirror ledger in {}: the mirror has not run here", folder.display()));
    }
    let ledger = Ledger::open(&folder)?;
    let now = chrono::Utc::now().timestamp();
    ledger.set_note(RELEASED_NOTE, &now.to_string())?;
    let gone: usize = [Kind::Song, Kind::Cover]
        .iter()
        .map(|kind| ledger.rows(*kind).map(|rows| rows.iter().filter(|r| r.state == State::Deleting).count()))
        .sum::<Result<usize, String>>()?;
    Ok(format!(
        "{gone} songs and covers gone from the library may now be deleted from the bucket, each {} days after it went. \
         Files that come back before then are kept.",
        GRACE / 86400
    ))
}

struct RestoreArgs {
    to: PathBuf,
    day: Option<chrono::NaiveDate>,
    library: Option<i64>,
    rest: Vec<OsString>,
}

fn restore_args(args: Vec<OsString>) -> Result<RestoreArgs, String> {
    let mut parsed = RestoreArgs { to: PathBuf::new(), day: None, library: None, rest: Vec::new() };
    let mut to = None;
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        match arg.to_str() {
            Some("--help" | "-h") => return Err(RESTORE_USAGE.into()),
            Some("--to") => to = Some(PathBuf::from(args.next().ok_or(RESTORE_USAGE)?)),
            Some("--manifest") => {
                let text = args.next().and_then(|a| a.into_string().ok()).ok_or(RESTORE_USAGE)?;
                let day = chrono::NaiveDate::parse_from_str(&text, "%Y-%m-%d").map_err(|_| format!("--manifest {text}: a day like 2026-11-26"))?;
                parsed.day = Some(day);
            }
            Some("--library") => {
                let text = args.next().and_then(|a| a.into_string().ok()).ok_or(RESTORE_USAGE)?;
                parsed.library = Some(text.parse().map_err(|_| format!("--library {text}: a library's id (a number)"))?);
            }
            _ => parsed.rest.push(arg),
        }
    }
    parsed.to = to.ok_or(RESTORE_USAGE)?;
    Ok(parsed)
}

/// What a restore did.
#[derive(Debug, Default, PartialEq)]
pub struct Restored {
    pub written: usize,
    pub bytes: u64,
    pub skipped: usize,
    /// The objects that could not be restored, and why.
    pub failed: Vec<(String, String)>,
}

async fn restore(args: Vec<OsString>, var: &dyn Fn(&str) -> Option<String>) -> Result<String, String> {
    let args = match restore_args(args) {
        Ok(args) => args,
        Err(usage) if usage == RESTORE_USAGE => return Ok(usage),
        Err(why) => return Err(why),
    };
    let config = Config::load(Sources { var, args: args.rest.clone(), files: &RealFiles })?;
    let settings = config.mirror.ok_or("the R2 mirror is not set up here (SONUS_R2_*): there is nothing to restore from")?;
    let s3 = S3::new(settings.endpoint.clone(), &settings.bucket, Signer::new(&settings.access_key_id, &settings.secret_access_key, &settings.region));
    let (manifest, day) = fetch_manifest(&s3, args.day).await?;
    eprintln!("The manifest of {day} (made {}): {} files.", manifest.made, manifest.files.len());
    let library = match (args.library, manifest.libraries.as_slice()) {
        (Some(id), libraries) if libraries.iter().any(|(l, _)| *l == id) => id,
        (Some(id), _) => return Err(format!("the manifest has no library {id}")),
        (None, [(id, _)]) => *id,
        (None, []) => return Err("the manifest names no library".into()),
        (None, libraries) => {
            let list: Vec<String> =
                libraries.iter().map(|(id, path)| format!("{id} ({path}, {} files)", manifest.files.iter().filter(|f| f.library == *id).count())).collect();
            return Err(format!("the manifest has several libraries: name one with --library: {}", list.join(", ")));
        }
    };
    let files: Vec<File> = manifest.files.into_iter().filter(|f| f.library == library).collect();
    let done = restore_files(&s3, &files, &args.to).await?;
    let mut said =
        format!("Restored {} files ({:.1} GB) into {}; {} were there already.", done.written, done.bytes as f64 / 1e9, args.to.display(), done.skipped);
    if !done.failed.is_empty() {
        said.push_str(&format!("\n{} could not be restored (run the command again to retry them):", done.failed.len()));
        for (key, why) in &done.failed {
            said.push_str(&format!("\n  {key}: {why}"));
        }
        return Err(said);
    }
    Ok(said)
}

/// The day's manifest, or the latest.
pub async fn fetch_manifest(s3: &S3, day: Option<chrono::NaiveDate>) -> Result<(manifest::Manifest, chrono::NaiveDate), String> {
    let mut days: Vec<chrono::NaiveDate> =
        s3.list_all(manifest::PREFIX).await.map_err(|e| format!("cannot list the manifests: {e}"))?.iter().filter_map(|o| manifest::day_of(&o.key)).collect();
    days.sort();
    let day = match day {
        Some(day) if days.contains(&day) => day,
        Some(day) => {
            return Err(format!("no manifest of {day} in the bucket; there are: {}", days.iter().map(|d| d.to_string()).collect::<Vec<_>>().join(", ")));
        }
        None => *days.last().ok_or("no manifest in the bucket yet (the mirror puts one up each day once it has run)")?,
    };
    let packed =
        s3.get_bytes(&manifest::key(day), MANIFEST_LIMIT).await.map_err(|e| format!("cannot read the manifest: {e}"))?.ok_or("the manifest is gone")?;
    Ok((manifest::read(&packed)?, day))
}

/// Downloads each file into `to`, where its path says, unless it is there at its size.
pub async fn restore_files(s3: &S3, files: &[File], to: &Path) -> Result<Restored, String> {
    std::fs::create_dir_all(to).map_err(|e| format!("cannot make {}: {e}", to.display()))?;
    let root = to.canonicalize().map_err(|e| format!("cannot open {}: {e}", to.display()))?;
    let mut done = Restored::default();
    for (n, file) in files.iter().enumerate() {
        if n > 0 && n % 100 == 0 {
            eprintln!("{n} of {} files looked at…", files.len());
        }
        let Some(target) = place(&root, &file.path) else {
            done.failed.push((file.key.clone(), "a path that would leave the folder".into()));
            continue;
        };
        if std::fs::metadata(&target).is_ok_and(|meta| meta.is_file() && meta.len() == file.size) {
            done.skipped += 1;
            continue;
        }
        match restore_one(s3, file, &root, &target).await {
            Ok(()) => {
                done.written += 1;
                done.bytes += file.size;
            }
            Err(why) => done.failed.push((file.key.clone(), why)),
        }
    }
    Ok(done)
}

/// Where a manifest path goes inside `root`: none when any part of it is not a plain name.
pub fn place(root: &Path, path: &str) -> Option<PathBuf> {
    let mut target = root.to_path_buf();
    for part in path.split('/') {
        let mut components = Path::new(part).components();
        let plain = matches!((components.next(), components.next()), (Some(Component::Normal(name)), None) if name == part);
        // (on Windows a backslash parts folders too; elsewhere it is a character of a name)
        if part.is_empty() || !plain || (cfg!(windows) && part.contains('\\')) {
            return None;
        }
        target.push(part);
    }
    (target != root).then_some(target)
}

async fn restore_one(s3: &S3, file: &File, root: &Path, target: &Path) -> Result<(), String> {
    let folder = target.parent().ok_or("no folder")?;
    std::fs::create_dir_all(folder).map_err(|e| format!("cannot make its folder: {e}"))?;
    // a link in the folders must not lead out of the folder given
    if !folder.canonicalize().map_err(|e| e.to_string())?.starts_with(root) {
        return Err("its folder leads out of the folder given".into());
    }
    let mut part = target.as_os_str().to_owned();
    part.push(PART_SUFFIX);
    let part = PathBuf::from(part);
    let mut last = String::new();
    for _ in 0..TRIES {
        let _ = std::fs::remove_file(&part);
        match s3.get_to_file(&file.key, &part, file.size).await {
            Ok(()) => return std::fs::rename(&part, target).map_err(|e| format!("cannot put it in place: {e}")),
            Err(e @ s3::Error::Status(404, _)) => return Err(format!("not in the bucket ({e})")),
            Err(e) if e.is_refusal() => return Err(format!("the bucket refuses the keys ({e})")),
            Err(e) => last = e.to_string(),
        }
    }
    Err(last)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_paths_stay_in_the_folder() {
        let root = Path::new("/restore");
        assert_eq!(place(root, "Artist/Album/01 Song.flac"), Some(root.join("Artist").join("Album").join("01 Song.flac")));
        for bad in ["../etc/passwd", "a/../../b", "/etc/passwd", "a//b", "", ".", "a/./b", ".."] {
            assert_eq!(place(root, bad), None, "{bad}");
        }
        if cfg!(windows) {
            for bad in ["C:/x", "a\\..\\b", "C:", "\\\\server\\share"] {
                assert_eq!(place(root, bad), None, "{bad}");
            }
        } else {
            assert_eq!(place(root, "Title: Part\\One.flac"), Some(root.join("Title: Part\\One.flac")), "a name, whatever its characters");
        }
    }

    #[test]
    fn arguments() {
        let args = |list: &[&str]| restore_args(list.iter().map(OsString::from).collect());
        let parsed = args(&["--to", "/r", "--manifest", "2026-11-26", "--library", "2", "--datafolder", "/data"]).unwrap();
        assert_eq!((parsed.to, parsed.library, parsed.rest.len()), (PathBuf::from("/r"), Some(2), 2), "the rest is the server's settings");
        assert_eq!(parsed.day.unwrap().to_string(), "2026-11-26");
        assert!(args(&[]).is_err());
        assert!(args(&["--to", "/r", "--manifest", "yesterday"]).is_err());
    }
}
