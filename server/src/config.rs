//! Settings. The container keeps Navidrome's, and the gateway reads them as Navidrome does: its config file
//! (`ND_CONFIGFILE`, `navidrome.toml`), its `ND_*` environment variables and its command line, with the same names and
//! precedence (the environment over the file over the defaults). The gateway listens where Navidrome used to, believes
//! the proxies Navidrome believed, and starts Navidrome with its own decisions as environment variables, which win
//! over Navidrome's file. The gateway's own settings start with `SONUS_` and come from the environment only.

mod file;
mod flags;

use std::ffi::OsString;
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::time::Duration;

use hyper::Uri;
use hyper::header::HeaderName;

pub use file::{ConfigFile, Files, Kind, RealFiles, Value};

use crate::trust::TrustList;

/// Where Navidrome listens inside the container when the gateway runs it.
pub const DEFAULT_NAVIDROME_PORT: u16 = 4534;

#[derive(Debug)]
pub struct Config {
    /// Where clients connect.
    pub listen: SocketAddr,
    /// Navidrome's address, `http://127.0.0.1:4534` when the gateway runs it.
    pub upstream: Uri,
    /// How to run Navidrome; none when `SONUS_NAVIDROME_URL` points at one that runs on its own.
    pub navidrome: Option<NavidromeProcess>,
    /// The proxies in front of the gateway whose forwarding headers are believed (see `trust`).
    pub trusted: TrustList,
    /// Navidrome's external-auth user header, believed from trusted proxies only. None unless the setting names one:
    /// no user header is believed.
    pub user_header: Option<HeaderName>,
    /// The header Navidrome takes the signed-in user from. The gateway alone sets it, from `user_header` of a trusted
    /// proxy, and removes it from every other request. When no proxy is trusted it is a random name, so nothing that
    /// reaches Navidrome without the gateway (on 127.0.0.1) can sign in with a header either.
    pub upstream_user_header: HeaderName,
    /// `BaseURL`'s path (`/music`), empty when none. Requests pass through as they came (Navidrome serves under it);
    /// kept for the routes the gateway will answer itself.
    pub base_path: String,
    /// The config file read, if any.
    pub config_file: Option<PathBuf>,
    /// Navidrome's settings the server shares with it, for the parts it answers itself.
    pub shared: Shared,
}

/// Navidrome's settings that the parts of the server answered here need too, read as Navidrome reads them.
#[derive(Clone, PartialEq)]
pub struct Shared {
    /// `DataFolder` (default: the working directory).
    pub data_folder: String,
    /// `DbPath`, empty when unset: `navidrome.db` in the data folder (see `db::locate`).
    pub db_path: String,
    /// `PasswordEncryptionKey`, empty when unset (see `secrets`). Never logged.
    pub password_encryption_key: String,
    /// `AuthRequestLimit` (default 5): failed sign-ins allowed per window; 0 or less turns the limit off.
    pub auth_request_limit: i64,
    /// `AuthWindowLength` (default 20 s).
    pub auth_window: Duration,
    /// `Sonus.TwoFactor` (default required).
    pub two_factor: TwoFactor,
    /// `HTTPHeaders.FrameOptions` (default DENY): the `X-Frame-Options` Navidrome answers with.
    pub frame_options: String,
    /// `SessionTimeout` (default 48 h): how long a web session's token is valid; Navidrome renews it at every use.
    pub session_timeout: Duration,
    /// `EnableGravatar` (default off): a sign-in's answer carries the user's Gravatar address.
    pub enable_gravatar: bool,
    /// `DevAutoLoginUsername`, empty when unset: Navidrome's development setting that signs everyone in as this user.
    pub dev_auto_login_username: String,
    /// The settings that change what the library's answers look like (`library`).
    pub library: LibraryOptions,
}

/// Navidrome's settings that change the answers of the library methods answered here (`library`), with Navidrome's
/// defaults (`conf/configuration.go`).
#[derive(Clone, Debug, PartialEq)]
pub struct LibraryOptions {
    /// `Subsonic.AppendSubtitle` (default on): a song's title is followed by its subtitle tag.
    pub append_subtitle: bool,
    /// `Subsonic.AppendAlbumVersion` (default on): an album's name is followed by its version tag.
    pub append_album_version: bool,
    /// `Subsonic.EnableAverageRating` (default on): `averageRating` is part of the answers.
    pub enable_average_rating: bool,
    /// `Subsonic.ArtistParticipations` (default off): an artist's albums include those they only appear on.
    pub artist_participations: bool,
    /// `Subsonic.LegacyClients` (default `DSub`): clients that get no OpenSubsonic fields.
    pub legacy_clients: String,
    /// `Subsonic.MinimalClients` (default `SubMusic`): clients that get a song's id and title only.
    pub minimal_clients: String,
    /// `PreferSortTags` (default off): sort tags come before the names made for ordering, in `sortName` and in lists.
    pub prefer_sort_tags: bool,
    /// `EnableNaturalSorting` (default off): numbers inside names sort by their value.
    pub enable_natural_sorting: bool,
    /// `RecentlyAddedByModTime` (default off): "created" and the newest list go by a file's change time.
    pub recently_added_by_mod_time: bool,
    /// `AlbumPlayCountMode` is `normalized` (default `absolute`): an album's play count is divided by its songs.
    pub normalized_album_play_count: bool,
    /// `EnableMediaFileCoverArt` (default on): a song with a picture of its own shows it.
    pub enable_media_file_cover_art: bool,
    /// `IgnoredArticles` (default `The El La Los Las Le Les Os As O A`).
    pub ignored_articles: String,
    /// `Search.Backend` is `legacy` (default `fts`), and `Search.FullString` (default off).
    pub legacy_search: bool,
    pub search_full_string: bool,
    /// `SmartPlaylistRefreshDelay` (default 5 s): how long a smart playlist's songs are good (`validUntil`).
    pub smart_playlist_refresh_delay: Duration,
    /// `LyricsPriority` (default `.ttml,.yaml,.yml,.elrc,.lrc,.srt,.txt,embedded`): where lyrics are looked for, in order.
    pub lyrics_priority: String,
    /// `CoverArtQuality` (default 75) and `EnableWebPEncoding` (default off): how resized covers are encoded, which
    /// is part of what Navidrome caches them under.
    pub cover_art_quality: i64,
    pub enable_webp_encoding: bool,
    /// `ImageCacheSize` (default `100MB`; `0`: no cache of resized covers).
    pub image_cache_size: String,
    /// `DataFolder`, and `CacheFolder` (empty: `cache` in the data folder): where Navidrome keeps its image store and
    /// its cache of resized covers.
    pub data_folder: String,
    pub cache_folder: String,
}

impl Default for LibraryOptions {
    fn default() -> Self {
        LibraryOptions {
            append_subtitle: true,
            append_album_version: true,
            enable_average_rating: true,
            artist_participations: false,
            legacy_clients: "DSub".into(),
            minimal_clients: "SubMusic".into(),
            prefer_sort_tags: false,
            enable_natural_sorting: false,
            recently_added_by_mod_time: false,
            normalized_album_play_count: false,
            enable_media_file_cover_art: true,
            ignored_articles: "The El La Los Las Le Les Os As O A".into(),
            legacy_search: false,
            search_full_string: false,
            smart_playlist_refresh_delay: Duration::from_secs(5),
            lyrics_priority: ".ttml,.yaml,.yml,.elrc,.lrc,.srt,.txt,embedded".into(),
            cover_art_quality: 75,
            enable_webp_encoding: false,
            image_cache_size: "100MB".into(),
            data_folder: ".".into(),
            cache_folder: String::new(),
        }
    }
}

impl std::fmt::Debug for Shared {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // the key stays out of logs and test output
        f.debug_struct("Shared")
            .field("data_folder", &self.data_folder)
            .field("db_path", &self.db_path)
            .field("password_encryption_key", &if self.password_encryption_key.is_empty() { "(unset)" } else { "(set)" })
            .field("auth_request_limit", &self.auth_request_limit)
            .field("auth_window", &self.auth_window)
            .field("two_factor", &self.two_factor)
            .field("frame_options", &self.frame_options)
            .field("session_timeout", &self.session_timeout)
            .field("enable_gravatar", &self.enable_gravatar)
            .field("dev_auto_login_username", &self.dev_auto_login_username)
            .field("library", &self.library)
            .finish()
    }
}

impl Default for Shared {
    fn default() -> Self {
        Shared {
            data_folder: ".".into(),
            db_path: String::new(),
            password_encryption_key: String::new(),
            auth_request_limit: 5,
            auth_window: DEFAULT_AUTH_WINDOW,
            two_factor: TwoFactor::Required,
            frame_options: "DENY".into(),
            session_timeout: DEFAULT_SESSION_TIMEOUT,
            enable_gravatar: false,
            dev_auto_login_username: String::new(),
            library: LibraryOptions::default(),
        }
    }
}

/// Navidrome's `consts.DefaultSessionTimeout`.
pub const DEFAULT_SESSION_TIMEOUT: Duration = Duration::from_secs(48 * 3600);

/// Navidrome's `consts.DefaultAuthWindowLength`.
pub const DEFAULT_AUTH_WINDOW: Duration = Duration::from_secs(20);

/// The fork's two-step verification policy (`Sonus.TwoFactor`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum TwoFactor {
    /// Everyone: a user without it sets it up at the next web sign-in.
    Required,
    /// Each user decides.
    Optional,
    /// Neither asked nor checked.
    Off,
}

impl TwoFactor {
    /// As the fork's `twofactor.CurrentMode`: anything unknown is Required.
    pub fn parse(value: &str) -> TwoFactor {
        match value.trim().to_lowercase().as_str() {
            "optional" => TwoFactor::Optional,
            "off" => TwoFactor::Off,
            _ => TwoFactor::Required,
        }
    }
}

#[derive(Debug, Clone)]
pub struct NavidromeProcess {
    pub bin: PathBuf,
    pub port: u16,
    /// The container's own arguments, passed on to Navidrome.
    pub args: Vec<OsString>,
    /// Set in Navidrome's environment over the container's: the gateway's decisions, which outrank its config file.
    pub env: Vec<(String, String)>,
    /// Removed from Navidrome's environment.
    pub env_remove: Vec<String>,
}

/// Where the settings come from: the environment (or a stand-in, in tests), the arguments, the filesystem.
pub struct Sources<'a> {
    pub var: &'a dyn Fn(&str) -> Option<String>,
    pub args: Vec<OsString>,
    pub files: &'a dyn Files,
}

impl Config {
    pub fn from_env() -> Result<Config, String> {
        Self::load(Sources { var: &|name| std::env::var(name).ok(), args: std::env::args_os().skip(1).collect(), files: &RealFiles })
    }

    pub fn load(sources: Sources) -> Result<Config, String> {
        let var = sources.var;
        let flags = flags::scan(&sources.args)?;
        let file = match file::locate(flags.config_file.as_deref(), var("ND_CONFIGFILE"), sources.files) {
            Some(path) => Some(ConfigFile::read(&path, sources.files)?),
            None => None,
        };
        let nd = Navidrome {
            var,
            base_url_flag: flags.base_url,
            data_folder_flag: flags.data_folder,
            session_timeout_flag: flags.session_timeout,
            file: file.as_ref(),
        };
        if let Some(file) = &file {
            // these would outrank the environment the gateway gives Navidrome (see Navidrome::get)
            for name in ["address", "port", "extauth.trustedsources", "extauth.userheader"] {
                if file.get_env_named(name).is_some() {
                    let env = env_name(name);
                    return Err(format!(
                        "{}: {env} is set in the file, where Navidrome takes it over its environment; the Sonus server sets \
                         it for Navidrome, so write it as {name} instead",
                        file.path.display()
                    ));
                }
            }
        }

        let tls = [nd.get("tlscert")?, nd.get("tlskey")?];
        if tls.iter().flatten().any(|v| !v.trim().is_empty()) {
            return Err("TLSCert/TLSKey are set, but the Sonus server serves plain HTTP: put TLS in a proxy in front of it, \
                        or unset them"
                .into());
        }
        let address = nd.get("address")?.map(|a| a.trim().to_string()).filter(|a| !a.is_empty()).unwrap_or_else(|| "0.0.0.0".into());
        if address.starts_with("unix:") {
            return Err(format!("Address={address}: the Sonus server listens on TCP only"));
        }
        let ip: IpAddr = address.trim_start_matches('[').trim_end_matches(']').parse().map_err(|_| format!("Address={address} is not an IP address"))?;
        let port = parse_port(nd.get("port")?, "Port", 4533)?;
        let listen = SocketAddr::new(ip, port);

        // not trimmed: Navidrome checks the peer against the entries as they are written (trust.rs)
        let trusted = TrustList::parse(&nd.get_renamed("extauth.trustedsources", "reverseproxywhitelist")?.unwrap_or_default());
        // Unlike Navidrome, no default: naming the proxy (so that clients have their own addresses) must not also
        // let a header sign users in, which a proxy passes on from the client unless it was told not to. An empty
        // environment value reads as not set, so "none" says it there.
        let user_header = nd.get_renamed("extauth.userheader", "reverseproxyuserheader")?.unwrap_or_default();
        let user_header = match user_header.trim() {
            "" => None,
            none if none.eq_ignore_ascii_case("none") => None,
            name => Some(HeaderName::try_from(name).map_err(|_| format!("ExtAuth.UserHeader={name} is not a header name"))?),
        };
        if let Some(name) = &user_header {
            if crate::gateway::is_managed_header(name) {
                return Err(format!("ExtAuth.UserHeader={name}: a header the gateway sets or removes itself, so it cannot carry the user"));
            }
        }
        let base_path = nd.get("baseurl")?.map(|url| base_path(&url)).unwrap_or_default();
        let defaults = Shared::default();
        let shared = Shared {
            data_folder: nd.get("datafolder")?.unwrap_or(defaults.data_folder),
            db_path: nd.get("dbpath")?.unwrap_or_default(),
            password_encryption_key: nd.get("passwordencryptionkey")?.unwrap_or_default(),
            auth_request_limit: match nd.get("authrequestlimit")? {
                Some(v) => v.trim().parse().map_err(|_| format!("AuthRequestLimit={v} is not a number"))?,
                None => defaults.auth_request_limit,
            },
            auth_window: match nd.get("authwindowlength")? {
                // Navidrome: a negative length falls back to the default, and so does none at all
                Some(v) => match parse_go_duration(&v).ok_or_else(|| format!("AuthWindowLength={v} is not a duration (20s, 1m30s)"))? {
                    Some(window) if !window.is_zero() => window,
                    _ => DEFAULT_AUTH_WINDOW,
                },
                None => defaults.auth_window,
            },
            two_factor: nd.get("sonus.twofactor")?.map(|v| TwoFactor::parse(&v)).unwrap_or(defaults.two_factor),
            frame_options: nd.get("httpheaders.frameoptions")?.filter(|v| !v.is_empty()).unwrap_or(defaults.frame_options),
            session_timeout: match nd.get("sessiontimeout")? {
                // Navidrome: a negative timeout falls back to the default
                Some(v) => parse_go_duration(&v).ok_or_else(|| format!("SessionTimeout={v} is not a duration (48h, 30m)"))?.unwrap_or(DEFAULT_SESSION_TIMEOUT),
                None => defaults.session_timeout,
            },
            enable_gravatar: match nd.get_bool("enablegravatar")? {
                Some(v) => v,
                None => defaults.enable_gravatar,
            },
            dev_auto_login_username: nd.get("devautologinusername")?.unwrap_or_default(),
            library: {
                let d = defaults.library;
                LibraryOptions {
                    append_subtitle: nd.get_bool("subsonic.appendsubtitle")?.unwrap_or(d.append_subtitle),
                    append_album_version: nd.get_bool("subsonic.appendalbumversion")?.unwrap_or(d.append_album_version),
                    enable_average_rating: nd.get_bool("subsonic.enableaveragerating")?.unwrap_or(d.enable_average_rating),
                    artist_participations: nd.get_bool("subsonic.artistparticipations")?.unwrap_or(d.artist_participations),
                    legacy_clients: nd.get("subsonic.legacyclients")?.unwrap_or(d.legacy_clients),
                    minimal_clients: nd.get("subsonic.minimalclients")?.unwrap_or(d.minimal_clients),
                    prefer_sort_tags: nd.get_bool("prefersorttags")?.unwrap_or(d.prefer_sort_tags),
                    enable_natural_sorting: nd.get_bool("enablenaturalsorting")?.unwrap_or(d.enable_natural_sorting),
                    recently_added_by_mod_time: nd.get_bool("recentlyaddedbymodtime")?.unwrap_or(d.recently_added_by_mod_time),
                    // Navidrome compares the value as written: anything but "normalized" counts plays as they are
                    normalized_album_play_count: nd.get("albumplaycountmode")?.is_some_and(|mode| mode == "normalized"),
                    enable_media_file_cover_art: nd.get_bool("enablemediafilecoverart")?.unwrap_or(d.enable_media_file_cover_art),
                    ignored_articles: nd.get("ignoredarticles")?.unwrap_or(d.ignored_articles),
                    // Navidrome: trimmed and lowercased; anything but "legacy" is the FTS5 search
                    legacy_search: nd.get("search.backend")?.is_some_and(|backend| backend.trim().eq_ignore_ascii_case("legacy")),
                    search_full_string: match nd.get_bool("search.fullstring")? {
                        Some(v) => v,
                        // the option's old name, which Navidrome still reads when the new one is set nowhere
                        None => nd.get_bool("searchfullstring")?.unwrap_or(d.search_full_string),
                    },
                    smart_playlist_refresh_delay: match nd.get("smartplaylistrefreshdelay")? {
                        // Navidrome: a negative delay falls back to the default
                        Some(v) => parse_go_duration(&v)
                            .ok_or_else(|| format!("SmartPlaylistRefreshDelay={v} is not a duration (5s, 1m)"))?
                            .unwrap_or(d.smart_playlist_refresh_delay),
                        None => d.smart_playlist_refresh_delay,
                    },
                    lyrics_priority: nd.get("lyricspriority")?.unwrap_or(d.lyrics_priority),
                    cover_art_quality: match nd.get_renamed("coverartquality", "coverjpegquality")? {
                        Some(v) => v.trim().parse().map_err(|_| format!("CoverArtQuality={v} is not a number"))?,
                        None => d.cover_art_quality,
                    },
                    enable_webp_encoding: nd.get_bool("enablewebpencoding")?.unwrap_or(d.enable_webp_encoding),
                    image_cache_size: nd.get("imagecachesize")?.unwrap_or(d.image_cache_size),
                    data_folder: nd.get("datafolder")?.unwrap_or(d.data_folder),
                    cache_folder: nd.get("cachefolder")?.unwrap_or_default(),
                }
            },
        };

        let (upstream, navidrome, upstream_user_header) = match get(var, "SONUS_NAVIDROME_URL") {
            Some(url) => {
                let uri: Uri = url.trim_end_matches('/').parse().map_err(|_| format!("SONUS_NAVIDROME_URL={url} is not a URL"))?;
                if uri.scheme_str() != Some("http") || uri.authority().is_none() {
                    return Err(format!("SONUS_NAVIDROME_URL={url}: an http:// address is needed"));
                }
                // a Navidrome with its own settings: it believes the header it was told to
                let upstream_user_header = user_header.clone().unwrap_or(HeaderName::from_static("remote-user"));
                (uri, None, upstream_user_header)
            }
            None => {
                let internal = parse_port(get(var, "SONUS_NAVIDROME_PORT"), "SONUS_NAVIDROME_PORT", DEFAULT_NAVIDROME_PORT)?;
                if internal == port {
                    return Err(format!("Navidrome's port ({internal}) is the gateway's own: set SONUS_NAVIDROME_PORT to another"));
                }
                let bin = get(var, "SONUS_NAVIDROME_BIN").map(PathBuf::from).unwrap_or_else(default_navidrome_bin);
                let uri = format!("http://127.0.0.1:{internal}").parse().expect("a valid URI");
                let upstream_user_header = match &user_header {
                    Some(name) if !trusted.is_empty() => name.clone(),
                    _ => unguessable_header(),
                };
                let env = vec![
                    ("ND_ADDRESS".into(), "127.0.0.1".into()),
                    ("ND_PORT".into(), internal.to_string()),
                    // Only the gateway reaches it, and the gateway has already decided who the client is (trust.rs): its
                    // X-Real-IP is the client's address, and the user header it sets came from a trusted proxy.
                    ("ND_EXTAUTH_TRUSTEDSOURCES".into(), "127.0.0.1/32".into()),
                    ("ND_EXTAUTH_USERHEADER".into(), upstream_user_header.as_str().into()),
                ];
                let env_remove = vec!["ND_REVERSEPROXYWHITELIST".into(), "ND_REVERSEPROXYUSERHEADER".into()];
                (uri, Some(NavidromeProcess { bin, port: internal, args: sources.args, env, env_remove }), upstream_user_header)
            }
        };
        Ok(Config { listen, upstream, navidrome, trusted, user_header, upstream_user_header, base_path, config_file: file.map(|f| f.path), shared })
    }
}

/// Navidrome's settings, looked up as Navidrome (viper) looks them up.
struct Navidrome<'a> {
    var: &'a dyn Fn(&str) -> Option<String>,
    base_url_flag: Option<String>,
    data_folder_flag: Option<String>,
    session_timeout_flag: Option<String>,
    file: Option<&'a ConfigFile>,
}

impl Navidrome<'_> {
    /// A setting by its lowercase dotted name: from the file's `ND_`-named key, else the command line, else the `ND_`
    /// variable (an empty one counts as unset), else (the port only) `PORT`, else the file. None: the default.
    fn get(&self, name: &str) -> Result<Option<String>, String> {
        if let Some(value) = self.file.and_then(|f| f.get_env_named(name)) {
            return self.text(name, value).map(Some);
        }
        let flag = match name {
            "baseurl" => &self.base_url_flag,
            "datafolder" => &self.data_folder_flag,
            "sessiontimeout" => &self.session_timeout_flag,
            _ => &None,
        };
        if let Some(flag) = flag {
            return Ok(Some(flag.clone()));
        }
        if let Some(value) = (self.var)(&env_name(name)).filter(|v| !v.is_empty()) {
            return Ok(Some(value));
        }
        if name == "port" {
            // Navidrome binds "port" to PORT as well (viper.BindEnv before its ND_ prefix is set)
            if let Some(value) = (self.var)("PORT").filter(|v| !v.is_empty()) {
                return Ok(Some(value));
            }
        }
        match self.file.and_then(|f| f.get(name)) {
            Some(value) => self.text(name, value).map(Some),
            None => Ok(None),
        }
    }

    /// A yes-or-no setting, as Go's `strconv.ParseBool` reads the environment's text; in the file, a TOML boolean.
    fn get_bool(&self, name: &str) -> Result<Option<bool>, String> {
        let from_file = |value: &Value| match value {
            Value::Bool(b) => Ok(*b),
            Value::Text(text) => parse_bool(text).ok_or_else(|| format!("{name}={text} is not true or false")),
            Value::Other(kind) => Err(format!("{name} in the config file is a TOML {kind}: Navidrome needs true or false here")),
        };
        if let Some(value) = self.file.and_then(|f| f.get_env_named(name)) {
            return from_file(value).map(Some);
        }
        if let Some(text) = (self.var)(&env_name(name)).filter(|v| !v.is_empty()) {
            return parse_bool(&text).map(Some).ok_or_else(|| format!("{}={text} is not true or false", env_name(name)));
        }
        self.file.and_then(|f| f.get(name)).map(from_file).transpose()
    }

    /// A renamed setting: the current name when it is set anywhere, else the old one, else the current name's default.
    fn get_renamed(&self, name: &str, old: &str) -> Result<Option<String>, String> {
        let explicit =
            self.file.is_some_and(|f| f.get(name).is_some() || f.get_env_named(name).is_some()) || (self.var)(&env_name(name)).is_some_and(|v| !v.is_empty());
        if !explicit {
            if let Some(value) = self.get(old)? {
                return Ok(Some(value));
            }
        }
        self.get(name)
    }

    fn text(&self, name: &str, value: &Value) -> Result<String, String> {
        match value {
            Value::Text(text) => Ok(text.clone()),
            Value::Bool(_) => Err(format!("{name} in the config file is a TOML boolean: Navidrome needs a string here")),
            Value::Other(kind) => Err(format!("{name} in the config file is a TOML {kind}: Navidrome needs a string here")),
        }
    }
}

/// `ExtAuth.TrustedSources` → `ND_EXTAUTH_TRUSTEDSOURCES`.
fn env_name(name: &str) -> String {
    format!("ND_{}", name.replace('.', "_").to_uppercase())
}

fn get(var: &dyn Fn(&str) -> Option<String>, name: &str) -> Option<String> {
    var(name).map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

fn parse_port(value: Option<String>, name: &str, default: u16) -> Result<u16, String> {
    match value {
        None => Ok(default),
        Some(v) => v.trim().parse::<u16>().ok().filter(|p| *p != 0).ok_or_else(|| format!("{name}={v} is not a port")),
    }
}

/// Go's `strconv.ParseBool`.
fn parse_bool(text: &str) -> Option<bool> {
    match text {
        "1" | "t" | "T" | "TRUE" | "true" | "True" => Some(true),
        "0" | "f" | "F" | "FALSE" | "false" | "False" => Some(false),
        _ => None,
    }
}

/// A duration as Navidrome (viper) reads one: Go's `time.ParseDuration` (`20s`, `1m30s`, `1.5h`, `300ms`), or a bare
/// number, which is nanoseconds. Some(None): a negative one. None: not a duration.
fn parse_go_duration(text: &str) -> Option<Option<Duration>> {
    let text = text.trim();
    let (negative, rest) = match text.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, text.strip_prefix('+').unwrap_or(text)),
    };
    if rest.is_empty() {
        return None;
    }
    let mut nanos = 0f64;
    if !rest.contains(['n', 's', 'u', 'µ', 'm', 'h']) {
        nanos = rest.parse::<u64>().ok()? as f64;
    } else {
        let mut rest = rest;
        while !rest.is_empty() {
            let digits = rest.find(|c: char| !c.is_ascii_digit() && c != '.').unwrap_or(rest.len());
            let number: f64 = rest[..digits].parse().ok()?;
            rest = &rest[digits..];
            let (unit, scale) = [("ns", 1e0), ("us", 1e3), ("µs", 1e3), ("μs", 1e3), ("ms", 1e6), ("s", 1e9), ("m", 6e10), ("h", 3.6e12)]
                .into_iter()
                .find(|(unit, _)| rest.starts_with(unit))?;
            rest = &rest[unit.len()..];
            nanos += number * scale;
        }
    }
    if negative && nanos > 0.0 {
        return Some(None);
    }
    Some(Some(Duration::from_nanos(nanos as u64)))
}

/// `BaseURL`'s path, as Navidrome takes it: `/music` from `/music` or from `https://example.com/music?x`.
fn base_path(url: &str) -> String {
    let url = url.trim();
    let rest = match url.split_once("://") {
        Some((_, rest)) => rest.find('/').map(|at| &rest[at..]).unwrap_or(""),
        None => url,
    };
    rest.split(['?', '#']).next().unwrap_or("").to_string()
}

/// `/app/navidrome` in the image; elsewhere whatever `navidrome` is on the PATH.
fn default_navidrome_bin() -> PathBuf {
    let image = PathBuf::from("/app/navidrome");
    if image.exists() { image } else { PathBuf::from("navidrome") }
}

/// `x-sonus-user-<32 hex digits>`, new at every start.
fn unguessable_header() -> HeaderName {
    let mut bytes = [0u8; 16];
    random_bytes(&mut bytes);
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    HeaderName::try_from(format!("x-sonus-user-{hex}")).expect("a valid header name")
}

/// From the kernel where there is one to ask (the image); elsewhere from the keys std draws from the OS for hashing.
fn random_bytes(out: &mut [u8; 16]) {
    #[cfg(unix)]
    {
        use std::io::Read;
        if std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(out)).is_ok() {
            return;
        }
    }
    use std::hash::{BuildHasher, Hasher};
    let keys = std::collections::hash_map::RandomState::new();
    for (i, chunk) in out.chunks_mut(8).enumerate() {
        let mut hasher = keys.build_hasher();
        hasher.write_usize(i);
        chunk.copy_from_slice(&hasher.finish().to_le_bytes());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::io;
    use std::path::Path;

    struct OneFile(Option<(&'static str, &'static str)>);

    impl Files for OneFile {
        fn kind(&self, path: &Path) -> Option<Kind> {
            self.0.filter(|(p, _)| Path::new(p) == path).map(|_| Kind::File)
        }
        fn read(&self, path: &Path) -> io::Result<String> {
            self.0.filter(|(p, _)| Path::new(p) == path).map(|(_, text)| text.to_string()).ok_or(io::ErrorKind::NotFound.into())
        }
    }

    fn load(vars: &[(&str, &str)], args: &[&str], file: Option<&'static str>) -> Result<Config, String> {
        let vars: HashMap<String, String> = vars.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        let files = OneFile(file.map(|text| ("/data/navidrome.toml", text)));
        let var = |name: &str| vars.get(name).cloned().or_else(|| (name == "ND_CONFIGFILE").then(|| "/data/navidrome.toml".into()));
        Config::load(Sources { var: &var, args: args.iter().map(OsString::from).collect(), files: &files })
    }

    fn env(c: &Config) -> HashMap<String, String> {
        c.navidrome.as_ref().unwrap().env.iter().cloned().collect()
    }

    #[test]
    fn the_librarys_settings_are_navidromes() {
        let defaults = load(&[], &[], None).unwrap().shared.library;
        assert_eq!(defaults, LibraryOptions::default());
        assert!(defaults.append_subtitle && defaults.append_album_version && defaults.enable_average_rating && defaults.enable_media_file_cover_art);
        assert!(
            !defaults.prefer_sort_tags && !defaults.enable_natural_sorting && !defaults.recently_added_by_mod_time && !defaults.normalized_album_play_count
        );
        assert_eq!((defaults.legacy_clients.as_str(), defaults.minimal_clients.as_str()), ("DSub", "SubMusic"));
        // from the file (a table, or dotted), and the environment over it
        let file = "PreferSortTags = true\nAlbumPlayCountMode = 'normalized'\nSearchFullString = true\n[Subsonic]\nAppendSubtitle = false\n\
                    LegacyClients = 'A,B'\n[Search]\nBackend = ' Legacy '";
        let env = [
            ("ND_SUBSONIC_APPENDALBUMVERSION", "false"),
            ("ND_ENABLENATURALSORTING", "1"),
            ("ND_RECENTLYADDEDBYMODTIME", "true"),
            ("ND_SUBSONIC_LEGACYCLIENTS", "C"),
        ];
        let set = load(&env, &[], Some(file)).unwrap().shared.library;
        assert!(set.prefer_sort_tags && set.normalized_album_play_count && set.enable_natural_sorting && set.recently_added_by_mod_time);
        assert!(!set.append_subtitle && !set.append_album_version);
        assert_eq!(set.legacy_clients, "C", "the environment outranks the file");
        assert!(set.legacy_search, "trimmed and in any case, as Navidrome reads it");
        assert!(set.search_full_string, "the option's old name still counts");
        // anything but "normalized" counts plays as they are; a yes-or-no setting must be one
        assert!(!load(&[("ND_ALBUMPLAYCOUNTMODE", "Normalized")], &[], None).unwrap().shared.library.normalized_album_play_count);
        assert!(load(&[("ND_PREFERSORTTAGS", "maybe")], &[], None).is_err());
        assert!(!load(&[("ND_SEARCH_FULLSTRING", "false")], &[], Some("SearchFullString = true")).unwrap().shared.library.search_full_string);
    }

    #[test]
    fn defaults_take_navidromes_place() {
        let c = load(&[], &["--nobanner"], None).unwrap();
        assert_eq!(c.listen, "0.0.0.0:4533".parse().unwrap());
        assert_eq!(c.upstream, "http://127.0.0.1:4534");
        assert!(c.trusted.is_empty());
        assert_eq!(c.user_header, None, "no header signs anyone in unless one is named");
        assert_eq!(c.base_path, "");
        assert_eq!(c.config_file, None);
        let nd = c.navidrome.as_ref().unwrap();
        assert_eq!(nd.port, 4534);
        assert_eq!(nd.args, vec![OsString::from("--nobanner")]);
        let env = env(&c);
        assert_eq!(env["ND_ADDRESS"], "127.0.0.1");
        assert_eq!(env["ND_PORT"], "4534");
        assert_eq!(env["ND_EXTAUTH_TRUSTEDSOURCES"], "127.0.0.1/32");
        assert!(nd.env_remove.contains(&"ND_REVERSEPROXYWHITELIST".to_string()));
    }

    #[test]
    fn without_trusted_proxies_navidromes_user_header_is_unguessable() {
        let a = load(&[], &[], None).unwrap();
        let b = load(&[], &[], None).unwrap();
        assert!(a.upstream_user_header.as_str().starts_with("x-sonus-user-"));
        assert_eq!(a.upstream_user_header.as_str().len(), "x-sonus-user-".len() + 32);
        assert_ne!(a.upstream_user_header, b.upstream_user_header);
        assert_eq!(env(&a)["ND_EXTAUTH_USERHEADER"], a.upstream_user_header.as_str());
        let trusted = load(&[("ND_EXTAUTH_TRUSTEDSOURCES", "10.0.0.0/8"), ("ND_EXTAUTH_USERHEADER", "Remote-User")], &[], None).unwrap();
        assert_eq!(trusted.upstream_user_header, "remote-user");
        assert_eq!(env(&trusted)["ND_EXTAUTH_USERHEADER"], "remote-user");
        // naming the proxy alone signs nobody in by a header: Navidrome is told a name nobody can guess
        for (variables, file) in [
            (vec![], None),
            (vec![("ND_EXTAUTH_USERHEADER", "")], None),
            (vec![("ND_EXTAUTH_USERHEADER", "None")], None),
            (vec![], Some("[ExtAuth]\nUserHeader = ''")),
        ] {
            let mut all = vec![("ND_EXTAUTH_TRUSTEDSOURCES", "10.0.0.0/8")];
            all.extend(variables);
            let off = load(&all, &[], file).unwrap();
            assert_eq!(off.user_header, None, "{all:?} {file:?}");
            assert!(off.upstream_user_header.as_str().starts_with("x-sonus-user-"), "{all:?} {file:?}");
        }
    }

    #[test]
    fn navidromes_settings_are_read_as_navidrome_reads_them() {
        let c = load(
            &[("ND_ADDRESS", "127.0.0.1"), ("ND_PORT", "8080"), ("ND_REVERSEPROXYWHITELIST", "10.0.0.0/8"), ("ND_REVERSEPROXYUSERHEADER", "X-User")],
            &[],
            None,
        )
        .unwrap();
        assert_eq!(c.listen, "127.0.0.1:8080".parse().unwrap());
        assert!(c.trusted.contains("10.1.1.1".parse().unwrap()));
        assert_eq!(c.user_header, Some(HeaderName::from_static("x-user")));
        let c = load(&[("ND_EXTAUTH_TRUSTEDSOURCES", "172.16.0.0/12"), ("ND_REVERSEPROXYWHITELIST", "10.0.0.0/8")], &[], None).unwrap();
        assert!(c.trusted.contains("172.16.0.1".parse().unwrap()), "the current name wins over the old one");
        assert!(!c.trusted.contains("10.1.1.1".parse().unwrap()));
        assert!(load(&[("ND_ADDRESS", "[::]")], &[], None).unwrap().listen.is_ipv6());
        assert_eq!(load(&[("PORT", "4600")], &[], None).unwrap().listen.port(), 4600, "Navidrome reads PORT too");
        assert_eq!(load(&[("PORT", "4600"), ("ND_PORT", "4700")], &[], None).unwrap().listen.port(), 4700);
        assert_eq!(load(&[("ND_PORT", "")], &[], Some("Port = 4600")).unwrap().listen.port(), 4600, "an empty variable is unset");
    }

    #[test]
    fn the_file_counts_under_the_environment() {
        let toml =
            "Address = '127.0.0.1'\nPort = 4600\nBaseURL = 'https://example.com/music'\n[ExtAuth]\nTrustedSources = '10.0.0.0/8'\nUserHeader = 'X-Auth-User'";
        let c = load(&[], &[], Some(toml)).unwrap();
        assert_eq!(c.listen, "127.0.0.1:4600".parse().unwrap());
        assert!(c.trusted.contains("10.2.3.4".parse().unwrap()));
        assert_eq!(c.user_header, Some(HeaderName::from_static("x-auth-user")));
        assert_eq!(c.base_path, "/music");
        assert_eq!(c.config_file, Some(PathBuf::from("/data/navidrome.toml")));
        assert_eq!(env(&c)["ND_EXTAUTH_USERHEADER"], "x-auth-user", "Navidrome is told the header the gateway decided on");
        assert_eq!(env(&c)["ND_PORT"], "4534");

        let c = load(&[("ND_PORT", "4700"), ("ND_EXTAUTH_TRUSTEDSOURCES", "172.16.0.0/12")], &[], Some(toml)).unwrap();
        assert_eq!(c.listen.port(), 4700);
        assert!(!c.trusted.contains("10.2.3.4".parse().unwrap()));
        assert_eq!(load(&[], &["--baseurl", "/flag"], Some(toml)).unwrap().base_path, "/flag", "a flag over the file");
    }

    #[test]
    fn old_names_count_only_when_the_new_one_is_set_nowhere() {
        let c = load(&[("ND_REVERSEPROXYWHITELIST", "10.0.0.0/8")], &[], Some("[ExtAuth]\nTrustedSources = '172.16.0.0/12'")).unwrap();
        assert!(c.trusted.contains("172.16.0.1".parse().unwrap()), "the new name in the file wins over the old one in the environment");
        assert!(!c.trusted.contains("10.0.0.1".parse().unwrap()));
        let c = load(&[("ND_REVERSEPROXYWHITELIST", "10.0.0.0/8")], &[], Some("ReverseProxyWhitelist = '172.16.0.0/12'")).unwrap();
        assert!(c.trusted.contains("10.0.0.1".parse().unwrap()), "the environment over the file, for the old name too");
        let c = load(&[], &[], Some("ReverseProxyWhitelist = '172.16.0.0/12'\nReverseProxyUserHeader = 'X-Old'")).unwrap();
        assert!(c.trusted.contains("172.16.0.1".parse().unwrap()));
        assert_eq!(c.user_header, Some(HeaderName::from_static("x-old")));
        let c = load(&[("ND_REVERSEPROXYWHITELIST", "10.0.0.0/8")], &[], Some("[ExtAuth]\nTrustedSources = ''")).unwrap();
        assert!(c.trusted.is_empty(), "set to nothing is still set");
    }

    #[test]
    fn trusted_sources_are_not_trimmed() {
        let c = load(&[("ND_EXTAUTH_TRUSTEDSOURCES", "10.0.0.0/8, 172.16.0.0/12")], &[], None).unwrap();
        assert!(c.trusted.contains("10.0.0.1".parse().unwrap()));
        assert!(!c.trusted.contains("172.16.0.1".parse().unwrap()), "Navidrome does not believe \" 172.16.0.0/12\" either");
    }

    #[test]
    fn shared_settings_are_read_as_navidrome_reads_them() {
        let c = load(&[], &[], None).unwrap();
        assert_eq!(c.shared, Shared::default());
        assert_eq!((c.shared.auth_request_limit, c.shared.auth_window, c.shared.two_factor), (5, Duration::from_secs(20), TwoFactor::Required));

        let toml = "DataFolder = '/data'\nPasswordEncryptionKey = 'from the file'\nAuthRequestLimit = 9\nAuthWindowLength = '1m30s'\n\
                    [Sonus]\nTwoFactor = 'Optional'\n[HTTPHeaders]\nFrameOptions = 'SAMEORIGIN'";
        let c = load(&[], &[], Some(toml)).unwrap();
        assert_eq!(c.shared.data_folder, "/data");
        assert_eq!(c.shared.db_path, "");
        assert_eq!(c.shared.password_encryption_key, "from the file");
        assert_eq!(c.shared.auth_request_limit, 9);
        assert_eq!(c.shared.auth_window, Duration::from_secs(90));
        assert_eq!(c.shared.two_factor, TwoFactor::Optional);
        assert_eq!(c.shared.frame_options, "SAMEORIGIN");
        assert!(!format!("{c:?}").contains("from the file"), "the key is not in debug output");

        let env = [
            ("ND_DATAFOLDER", "/env"),
            ("ND_DBPATH", "/db/nd.db?_busy_timeout=1"),
            ("ND_PASSWORDENCRYPTIONKEY", "from the environment"),
            ("ND_AUTHREQUESTLIMIT", "0"),
            ("ND_AUTHWINDOWLENGTH", "5s"),
            ("ND_SONUS_TWOFACTOR", "off"),
        ];
        let c = load(&env, &[], Some(toml)).unwrap();
        assert_eq!(c.shared.data_folder, "/env", "the environment over the file");
        assert_eq!(c.shared.db_path, "/db/nd.db?_busy_timeout=1");
        assert_eq!(c.shared.password_encryption_key, "from the environment");
        assert_eq!((c.shared.auth_request_limit, c.shared.auth_window, c.shared.two_factor), (0, Duration::from_secs(5), TwoFactor::Off));
        assert_eq!(load(&env, &["--datafolder", "/flag"], Some(toml)).unwrap().shared.data_folder, "/flag", "a flag over both");

        assert_eq!(load(&[("ND_SONUS_TWOFACTOR", "sometimes")], &[], None).unwrap().shared.two_factor, TwoFactor::Required, "unknown is required");
        assert_eq!(load(&[("ND_AUTHWINDOWLENGTH", "-5s")], &[], None).unwrap().shared.auth_window, Duration::from_secs(20), "negative: the default");
        assert_eq!(load(&[("ND_AUTHWINDOWLENGTH", "0")], &[], None).unwrap().shared.auth_window, Duration::from_secs(20));
        assert!(load(&[("ND_AUTHREQUESTLIMIT", "many")], &[], None).is_err());

        // what the /auth routes need
        let c = load(&[], &[], None).unwrap();
        assert_eq!(
            (c.shared.session_timeout, c.shared.enable_gravatar, c.shared.dev_auto_login_username.as_str()),
            (Duration::from_secs(48 * 3600), false, "")
        );
        let c = load(&[("ND_SESSIONTIMEOUT", "30m"), ("ND_ENABLEGRAVATAR", "true"), ("ND_DEVAUTOLOGINUSERNAME", "dev")], &[], None).unwrap();
        assert_eq!((c.shared.session_timeout, c.shared.enable_gravatar, c.shared.dev_auto_login_username.as_str()), (Duration::from_secs(1800), true, "dev"));
        let c = load(&[("ND_SESSIONTIMEOUT", "30m")], &["--sessiontimeout", "2h"], Some("EnableGravatar = true\nSessionTimeout = '1h'")).unwrap();
        assert_eq!((c.shared.session_timeout, c.shared.enable_gravatar), (Duration::from_secs(7200), true), "a flag over the environment over the file");
        assert_eq!(load(&[("ND_SESSIONTIMEOUT", "-1h")], &[], None).unwrap().shared.session_timeout, Duration::from_secs(48 * 3600));
        assert!(load(&[("ND_ENABLEGRAVATAR", "maybe")], &[], None).is_err());
        assert!(load(&[], &[], Some("EnableGravatar = 'yes'")).is_err());
        assert!(load(&[("ND_AUTHWINDOWLENGTH", "soon")], &[], None).is_err());
    }

    #[test]
    fn durations_as_go_parses_them() {
        let d = |text| parse_go_duration(text);
        assert_eq!(d("20s"), Some(Some(Duration::from_secs(20))));
        assert_eq!(d("1m30s"), Some(Some(Duration::from_secs(90))));
        assert_eq!(d("1.5h"), Some(Some(Duration::from_secs(5400))));
        assert_eq!(d("300ms"), Some(Some(Duration::from_millis(300))));
        assert_eq!(d("2000000000"), Some(Some(Duration::from_secs(2))), "a bare number is nanoseconds");
        assert_eq!(d("0"), Some(Some(Duration::ZERO)));
        assert_eq!(d("-1s"), Some(None));
        assert_eq!(d(""), None);
        assert_eq!(d("5 s"), None);
        assert_eq!(d("5x"), None);
        assert_eq!(d("s"), None);
    }

    #[test]
    fn base_paths() {
        assert_eq!(base_path("/music"), "/music");
        assert_eq!(base_path("/music/"), "/music/");
        assert_eq!(base_path("https://example.com/music?x=1"), "/music");
        assert_eq!(base_path("http://example.com"), "");
        assert_eq!(base_path(""), "");
    }

    #[test]
    fn an_external_navidrome_is_only_proxied() {
        let c = load(&[("SONUS_NAVIDROME_URL", "http://127.0.0.1:4799/")], &[], None).unwrap();
        assert_eq!(c.upstream, "http://127.0.0.1:4799");
        assert!(c.navidrome.is_none());
        assert_eq!(c.upstream_user_header, "remote-user");
        assert!(load(&[("SONUS_NAVIDROME_URL", "https://example.com")], &[], None).is_err());
    }

    #[test]
    fn what_the_gateway_cannot_do_stops_it() {
        assert!(load(&[("ND_TLSCERT", "/data/cert.pem")], &[], None).unwrap_err().contains("TLS"));
        assert!(load(&[], &[], Some("TLSKey = '/data/key.pem'")).unwrap_err().contains("TLS"));
        assert!(load(&[], &[], Some("ND_TLSCERT = '/data/cert.pem'")).unwrap_err().contains("TLS"));
        assert!(load(&[("ND_ADDRESS", "unix:/tmp/nd.sock")], &[], None).is_err());
        assert!(load(&[("ND_PORT", "4534")], &[], None).unwrap_err().contains("SONUS_NAVIDROME_PORT"));
        assert!(load(&[("ND_PORT", "http")], &[], None).is_err());
        assert!(load(&[], &[], Some("Port = 4534.5")).is_err());
        assert!(load(&[], &["--port", "4600"], None).is_err());
        assert!(load(&[], &["scan"], None).is_err());
        assert!(load(&[("ND_EXTAUTH_USERHEADER", "X-Real-IP")], &[], None).is_err());
        assert!(load(&[("ND_EXTAUTH_USERHEADER", "Bad Header")], &[], None).is_err());
        for key in ["ND_ADDRESS = '0.0.0.0'", "ND_PORT = 4533", "ND_EXTAUTH_TRUSTEDSOURCES = '0.0.0.0/0'", "ND_EXTAUTH_USERHEADER = 'X-User'"] {
            assert!(load(&[], &[], Some(key)).unwrap_err().contains("ND_"), "{key}: it would outrank what the gateway tells Navidrome");
        }
        assert!(load(&[], &[], Some("Port = ")).is_err(), "a file Navidrome cannot read");
    }
}
