//! Navidrome's config file (`navidrome.toml`), found and read as Navidrome finds and reads it (viper): keys are
//! case-insensitive, `[ExtAuth] TrustedSources`, `ExtAuth.TrustedSources` and `"ExtAuth.TrustedSources"` are the same
//! setting, and a key written as its environment variable (`ND_PORT = 4533`) counts over the environment.

use std::collections::HashMap;
use std::ffi::OsStr;
use std::io;
use std::path::{Path, PathBuf};

/// What the gateway needs from the filesystem, so tests can do without one.
pub trait Files {
    /// Whether something is at `path`, and whether it is a file (not a directory).
    fn kind(&self, path: &Path) -> Option<Kind>;
    fn read(&self, path: &Path) -> io::Result<String>;
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Kind {
    File,
    Other,
}

pub struct RealFiles;

impl Files for RealFiles {
    fn kind(&self, path: &Path) -> Option<Kind> {
        let meta = std::fs::metadata(path).ok()?;
        Some(if meta.is_dir() { Kind::Other } else { Kind::File })
    }

    fn read(&self, path: &Path) -> io::Result<String> {
        std::fs::read_to_string(path)
    }
}

/// The formats Navidrome's config file can have, in the order it looks for `navidrome.<ext>` (viper's SupportedExts).
const NAVIDROME_FORMATS: &[&str] = &["json", "toml", "yaml", "yml", "properties", "props", "prop", "hcl", "tfvars", "dotenv", "env", "ini"];

/// Where Navidrome finds its config file: `--configfile`, else `ND_CONFIGFILE` when something is there, else the first
/// `navidrome.<ext>` file in the working directory. None: no file, the environment and defaults only.
pub fn locate(flag: Option<&OsStr>, env: Option<String>, files: &dyn Files) -> Option<PathBuf> {
    if let Some(flag) = flag.filter(|f| !f.is_empty()) {
        return Some(PathBuf::from(flag));
    }
    if let Some(env) = env.filter(|e| !e.is_empty()) {
        let path = PathBuf::from(env);
        if files.kind(&path).is_some() {
            return Some(path);
        }
    }
    NAVIDROME_FORMATS.iter().map(|ext| PathBuf::from(format!("navidrome.{ext}"))).find(|path| files.kind(path) == Some(Kind::File))
}

#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Text(String),
    /// Not a string or a number: a TOML type name.
    Other(&'static str),
}

#[derive(Debug, Default)]
pub struct ConfigFile {
    pub path: PathBuf,
    /// Settings by lowercase dotted name (`extauth.trustedsources`).
    values: HashMap<String, Value>,
    /// Settings written as environment variables (`ND_EXTAUTH_TRUSTEDSOURCES = …`), by the name they stand for:
    /// Navidrome takes these over the environment, the command line and the rest of the file.
    env_named: HashMap<String, Value>,
}

impl ConfigFile {
    pub fn read(path: &Path, files: &dyn Files) -> Result<ConfigFile, String> {
        // as Navidrome: the extension decides the format, and it is case-sensitive
        let ext = path.extension().and_then(OsStr::to_str).unwrap_or("");
        if ext != "toml" {
            return Err(if NAVIDROME_FORMATS.contains(&ext) {
                format!("{}: the Sonus server reads TOML config files only (navidrome.toml): convert it, or use ND_* environment variables", path.display())
            } else {
                format!("{}: not a config file Navidrome reads (it needs a .toml extension)", path.display())
            });
        }
        let text = files.read(path).map_err(|e| format!("cannot read the config file {}: {e}", path.display()))?;
        Self::parse(path, &text)
    }

    pub fn parse(path: &Path, text: &str) -> Result<ConfigFile, String> {
        let text = text.strip_prefix('\u{feff}').unwrap_or(text);
        let table: toml::Table = text.parse().map_err(|e| format!("{}: {e}", path.display()))?;
        let mut flat = HashMap::new();
        flatten(&table, "", 0, &mut flat).map_err(|e| format!("{}: {e}", path.display()))?;

        let mut file = ConfigFile { path: path.to_owned(), ..ConfigFile::default() };
        for (key, (_, value)) in flat {
            match key.strip_prefix("nd_") {
                Some(name) => {
                    file.env_named.insert(name.replace('_', "."), value);
                }
                None => {
                    file.values.insert(key, value);
                }
            }
        }
        if let Some(name) = file.env_named.keys().find(|name| file.values.contains_key(*name)) {
            // Navidrome stops on this too
            return Err(format!("{}: {name} is set twice, once as ND_{}: remove the ND_ one", path.display(), name.replace('.', "_").to_uppercase()));
        }
        Ok(file)
    }

    pub fn get(&self, name: &str) -> Option<&Value> {
        self.values.get(name)
    }

    pub fn get_env_named(&self, name: &str) -> Option<&Value> {
        self.env_named.get(name)
    }
}

/// Lowercase dotted names. A key written with its dots (`"ExtAuth.TrustedSources" = …`) wins over the same setting
/// nested in tables, as in viper; the same key twice at the same depth (`Port` and `port`) is refused.
fn flatten(table: &toml::Table, prefix: &str, depth: usize, out: &mut HashMap<String, (usize, Value)>) -> Result<(), String> {
    for (key, value) in table {
        let name = format!("{prefix}{}", key.to_lowercase());
        let value = match value {
            toml::Value::Table(inner) => {
                flatten(inner, &format!("{name}."), depth + 1, out)?;
                continue;
            }
            toml::Value::String(s) => Value::Text(s.clone()),
            toml::Value::Integer(i) => Value::Text(i.to_string()),
            other => Value::Other(other.type_str()),
        };
        match out.get(&name) {
            Some((existing, _)) if *existing < depth => {}
            Some((existing, _)) if *existing == depth => return Err(format!("{name} is set twice")),
            _ => {
                out.insert(name, (depth, value));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FakeFiles(Vec<(&'static str, Kind)>);

    impl Files for FakeFiles {
        fn kind(&self, path: &Path) -> Option<Kind> {
            self.0.iter().find(|(p, _)| Path::new(p) == path).map(|(_, k)| *k)
        }
        fn read(&self, _: &Path) -> io::Result<String> {
            Err(io::ErrorKind::NotFound.into())
        }
    }

    fn parse(text: &str) -> Result<ConfigFile, String> {
        ConfigFile::parse(Path::new("navidrome.toml"), text)
    }

    #[test]
    fn found_where_navidrome_finds_it() {
        let none = FakeFiles(vec![]);
        assert_eq!(locate(Some(OsStr::new("/x.toml")), Some("/data/navidrome.toml".into()), &none), Some("/x.toml".into()), "the flag first, found or not");
        let data = FakeFiles(vec![("/data/navidrome.toml", Kind::File), ("navidrome.toml", Kind::File)]);
        assert_eq!(locate(None, Some("/data/navidrome.toml".into()), &data), Some("/data/navidrome.toml".into()));
        assert_eq!(locate(None, Some("/missing.toml".into()), &data), Some("navidrome.toml".into()), "a missing ND_CONFIGFILE is skipped");
        assert_eq!(locate(None, None, &none), None);
        let both = FakeFiles(vec![("navidrome.toml", Kind::File), ("navidrome.json", Kind::File), ("navidrome.ini", Kind::Other)]);
        assert_eq!(locate(None, None, &both), Some("navidrome.json".into()), "in viper's order: then refused, as JSON");
        let dir = FakeFiles(vec![("navidrome.json", Kind::Other)]);
        assert_eq!(locate(None, None, &dir), None, "a directory is not a config file");
        assert!(ConfigFile::read(Path::new("navidrome.json"), &none).unwrap_err().contains("TOML"));
        assert!(ConfigFile::read(Path::new("navidrome.TOML"), &none).is_err(), "Navidrome's extension check is case-sensitive");
    }

    #[test]
    fn keys_are_read_as_viper_reads_them() {
        let f = parse("PORT = 4600\naddress = \"127.0.0.1\"\n[extauth]\ntrustedSources = \"10.0.0.0/8\"\nUserHeader = 'X-User'\n").unwrap();
        assert_eq!(f.get("port"), Some(&Value::Text("4600".into())));
        assert_eq!(f.get("address"), Some(&Value::Text("127.0.0.1".into())));
        assert_eq!(f.get("extauth.trustedsources"), Some(&Value::Text("10.0.0.0/8".into())));
        assert_eq!(f.get("extauth.userheader"), Some(&Value::Text("X-User".into())));

        let dotted = parse("ExtAuth.TrustedSources = \"10.0.0.0/8\"").unwrap();
        assert_eq!(dotted.get("extauth.trustedsources"), Some(&Value::Text("10.0.0.0/8".into())));
        let quoted = parse("\"ExtAuth.TrustedSources\" = \"172.16.0.0/12\"\n[ExtAuth]\nTrustedSources = \"10.0.0.0/8\"").unwrap();
        assert_eq!(quoted.get("extauth.trustedsources"), Some(&Value::Text("172.16.0.0/12".into())), "the key written with its dots wins");

        let other = parse("TrustedSources = [\"10.0.0.0/8\"]\nScanSchedule = 1.5").unwrap();
        assert_eq!(other.get("trustedsources"), Some(&Value::Other("array")));
        assert_eq!(parse("\u{feff}Port = 1").unwrap().get("port"), Some(&Value::Text("1".into())));
    }

    #[test]
    fn environment_names_in_the_file_are_kept_apart() {
        let f = parse("ND_PORT = 4600\nND_EXTAUTH_TRUSTEDSOURCES = \"10.0.0.0/8\"\nBaseURL = \"/music\"").unwrap();
        assert_eq!(f.get_env_named("port"), Some(&Value::Text("4600".into())));
        assert_eq!(f.get_env_named("extauth.trustedsources"), Some(&Value::Text("10.0.0.0/8".into())));
        assert_eq!(f.get("port"), None);
        assert!(parse("ND_PORT = 1\nPort = 2").unwrap_err().contains("ND_PORT"), "Navidrome refuses both");
    }

    #[test]
    fn what_navidrome_cannot_read_stops_the_gateway() {
        assert!(parse("Port = 1\nport = 2").unwrap_err().contains("twice"));
        assert!(parse("Port = ").is_err());
        assert!(parse("[ExtAuth]\nTrustedSources = \"a\"\n[ExtAuth]\nUserHeader = \"b\"").is_err());
    }
}
