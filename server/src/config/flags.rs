//! Navidrome's command line, as its root command reads it (cobra/pflag: `--name value`, `--name=value`, `-c value`,
//! `-cvalue`, `-nc value`). The container's arguments go to Navidrome unchanged; the gateway only looks for what
//! concerns it: the config file, `BaseURL` and `DataFolder`, which it reads too, and the address, port and TLS flags,
//! which would outrank the gateway's own settings for Navidrome and so stop it.

use std::ffi::{OsStr, OsString};

#[derive(Debug, Default, PartialEq)]
pub struct Flags {
    /// `--configfile` / `-c`.
    pub config_file: Option<OsString>,
    /// `--baseurl`.
    pub base_url: Option<String>,
    /// `--datafolder`.
    pub data_folder: Option<String>,
}

/// The root command's flags that take a value: long name, shorthand, and whether the gateway cannot run with it
/// (flags outrank the environment the gateway sets for Navidrome).
const VALUE_FLAGS: &[(&str, Option<char>, Refused)] = &[
    ("configfile", Some('c'), Refused::No),
    ("musicfolder", None, Refused::No),
    ("datafolder", None, Refused::No),
    ("cachefolder", None, Refused::No),
    ("loglevel", Some('l'), Refused::No),
    ("logfile", None, Refused::No),
    ("address", Some('a'), Refused::Listen),
    ("port", Some('p'), Refused::Listen),
    ("baseurl", None, Refused::No),
    ("tlscert", None, Refused::Tls),
    ("tlskey", None, Refused::Tls),
    ("unixsocketperm", None, Refused::No),
    ("sessiontimeout", None, Refused::No),
    ("scaninterval", None, Refused::No),
    ("uiloginbackgroundurl", None, Refused::No),
    ("transcodingcachesize", None, Refused::No),
    ("imagecachesize", None, Refused::No),
    ("albumplaycountmode", None, Refused::No),
    ("prometheus.metricspath", None, Refused::No),
];

/// The root command's flags that take no value (`--nobanner`, or `--nobanner=false`).
const BOOL_FLAGS: &[(&str, Option<char>)] = &[
    ("nobanner", Some('n')),
    ("enabletranscodingconfig", None),
    ("enabletranscodingcancellation", None),
    ("autoimportplaylists", None),
    ("prometheus.enabled", None),
    ("help", Some('h')),
    ("version", Some('v')),
];

#[derive(Clone, Copy, PartialEq)]
enum Refused {
    No,
    Listen,
    Tls,
}

/// Reads the flags the gateway cares about. Errors for what would make Navidrome escape the gateway: its own address,
/// port or TLS on the command line, or a subcommand (`navidrome scan`), which does not run the server at all.
pub fn scan(args: &[OsString]) -> Result<Flags, String> {
    let mut flags = Flags::default();
    let mut found = |name: &str, value: &OsStr| -> Result<(), String> {
        let refused = VALUE_FLAGS.iter().find(|f| f.0 == name).map(|f| f.2).unwrap_or(Refused::No);
        match (name, refused) {
            (_, Refused::Listen) => Err(format!(
                "--{name} is on the command line: the Sonus server listens in Navidrome's place and gives Navidrome its own \
                 address; set ND_ADDRESS / ND_PORT (or Address / Port in navidrome.toml) instead"
            )),
            (_, Refused::Tls) => Err(format!("--{name} is on the command line, but the Sonus server serves plain HTTP: put TLS in a proxy in front of it")),
            ("configfile", _) => {
                flags.config_file = Some(value.to_owned());
                Ok(())
            }
            ("baseurl", _) => {
                flags.base_url = Some(value.to_string_lossy().into_owned());
                Ok(())
            }
            ("datafolder", _) => {
                flags.data_folder = Some(value.to_string_lossy().into_owned());
                Ok(())
            }
            _ => Ok(()),
        }
    };

    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        i += 1;
        let Some(text) = arg.to_str() else {
            return Err(format!("{}: an argument Navidrome's server does not take (a command?)", arg.to_string_lossy()));
        };
        if text == "--" {
            if let Some(next) = args.get(i) {
                return Err(positional(&next.to_string_lossy()));
            }
            break;
        }
        if let Some(long) = text.strip_prefix("--") {
            let (name, inline) = match long.split_once('=') {
                Some((name, value)) => (name, Some(value)),
                None => (long, None),
            };
            if VALUE_FLAGS.iter().any(|f| f.0 == name) {
                let value = match inline {
                    Some(value) => OsString::from(value),
                    None => take_value(args, &mut i, name)?,
                };
                found(name, &value)?;
            }
            // a bool flag, or one Navidrome does not know (and refuses by itself): nothing to read
            continue;
        }
        if let Some(cluster) = text.strip_prefix('-').filter(|c| !c.is_empty()) {
            for (at, short) in cluster.char_indices() {
                if BOOL_FLAGS.iter().any(|f| f.1 == Some(short)) {
                    continue;
                }
                let Some((name, _, _)) = VALUE_FLAGS.iter().find(|f| f.1 == Some(short)) else {
                    break; // unknown: Navidrome refuses it by itself
                };
                let rest = &cluster[at + short.len_utf8()..];
                let value = match rest.strip_prefix('=').unwrap_or(rest) {
                    "" if !rest.starts_with('=') => take_value(args, &mut i, name)?,
                    value => OsString::from(value),
                };
                found(name, &value)?;
                break;
            }
            continue;
        }
        return Err(positional(text));
    }
    Ok(flags)
}

fn take_value(args: &[OsString], i: &mut usize, name: &str) -> Result<OsString, String> {
    let value = args.get(*i).cloned().ok_or_else(|| format!("--{name} needs a value"))?;
    *i += 1;
    Ok(value)
}

fn positional(arg: &str) -> String {
    format!(
        "\"{arg}\" is on the command line: the Sonus server runs Navidrome's server only; run Navidrome's commands with \
         /app/navidrome itself (docker exec)"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scan_str(args: &[&str]) -> Result<Flags, String> {
        scan(&args.iter().map(OsString::from).collect::<Vec<_>>())
    }

    #[test]
    fn the_config_file_and_base_url_are_read_in_every_spelling() {
        for args in [
            &["--configfile", "/data/a.toml"][..],
            &["--configfile=/data/a.toml"],
            &["-c", "/data/a.toml"],
            &["-c/data/a.toml"],
            &["-c=/data/a.toml"],
            &["-nc", "/data/a.toml"],
            &["--nobanner", "-c", "/x.toml", "--musicfolder", "/music", "-c", "/data/a.toml"],
        ] {
            assert_eq!(scan_str(args).unwrap().config_file, Some(OsString::from("/data/a.toml")), "{args:?}");
        }
        assert_eq!(scan_str(&["--baseurl", "/music"]).unwrap().base_url.as_deref(), Some("/music"));
        assert_eq!(scan_str(&["--datafolder=/data", "--musicfolder", "/music"]).unwrap().data_folder.as_deref(), Some("/data"));
        assert_eq!(scan_str(&["--loglevel", "--baseurl"]).unwrap(), Flags::default(), "a value that looks like a flag is a value");
        assert_eq!(scan_str(&[]).unwrap(), Flags::default());
        assert_eq!(scan_str(&["--unknown", "--enabletranscodingconfig=false", "--"]).unwrap(), Flags::default());
    }

    #[test]
    fn what_would_bypass_the_gateway_is_refused() {
        for args in [
            &["--port", "4533"][..],
            &["--port=4533"],
            &["-p", "4533"],
            &["-np4533"],
            &["--address", "0.0.0.0"],
            &["-a0.0.0.0"],
            &["--tlscert", "/c.pem"],
            &["--tlskey=/k.pem"],
            &["scan"],
            &["--musicfolder", "/music", "user", "list"],
            &["--", "scan"],
        ] {
            assert!(scan_str(args).is_err(), "{args:?}");
        }
        assert!(scan_str(&["-l", "-p"]).is_ok(), "-p is -l's value here");
        assert!(scan_str(&["--configfile"]).is_err(), "a value is missing");
    }
}
