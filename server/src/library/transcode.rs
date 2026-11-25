//! Ported from Navidrome (GPL-3.0), © the Navidrome authors.
//!
//! Whether a `stream` is the file as it is or transcoded, and to what (`core/stream/legacy_client.go`,
//! `core/stream/decider.go`, `core/stream/codec.go`, `core/stream/aliases.go`, `model.MediaFile.AudioCodec`), the
//! ffmpeg arguments for it (`core/ffmpeg/ffmpeg.go`, `buildDynamicArgs`) and the repair of a piped FLAC header
//! (`core/ffmpeg/flac_streaminfo.go`). Only Navidrome's four built-in transcodings are run here (the roadmap: no
//! command templates of one's own); a transcoding whose stored command is not Navidrome's default is Navidrome's.
//!
//! Sonus clients call `stream` the legacy way (`format`, `maxBitRate`), so that is the path ported: no client profiles,
//! no codec limitations, no `getTranscodeDecision`.

use super::query::Song;

/// Navidrome's built-in transcodings (`consts.DefaultTranscodings`): target format, default bit rate, command.
pub const DEFAULT_TRANSCODINGS: [(&str, i64, &str); 4] = [
    ("mp3", 192, "ffmpeg -ss %t -i %s -map 0:a:0 -map_metadata 0 -map_metadata 0:s:a:0 -b:a %bk -v 0 -f mp3 -"),
    ("opus", 128, "ffmpeg -ss %t -i %s -map 0:a:0 -map_metadata 0 -map_metadata 0:s:a:0 -b:a %bk -v 0 -c:a libopus -f opus -"),
    ("aac", 256, "ffmpeg -ss %t -i %s -map 0:a:0 -map_metadata 0 -map_metadata 0:s:a:0 -b:a %bk -v 0 -c:a aac -f adts -"),
    ("flac", 0, "ffmpeg -ss %t -i %s -map 0:a:0 -map_metadata 0 -map_metadata 0:s:a:0 -v 0 -c:a flac -f flac -"),
];

/// `fallbackBitrate`.
const FALLBACK_BITRATE: i64 = 256;

/// A row of Navidrome's `transcoding` table.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Transcoding {
    pub target_format: String,
    pub default_bit_rate: i64,
    pub command: String,
}

/// What the decision reads besides the song and the request.
pub struct Context<'a> {
    /// The player's `MaxBitRate` (0: none).
    pub player_max_bit_rate: i64,
    /// The player's transcoding (`request.TranscodingFrom`), when it has one.
    pub player_transcoding: Option<&'a Transcoding>,
    /// `DefaultDownsamplingFormat`.
    pub default_downsampling_format: &'a str,
    /// `ds.Transcoding(ctx).FindByFormat`: the stored row for a target format.
    pub find: &'a dyn Fn(&str) -> Option<Transcoding>,
}

/// A resolved stream (`stream.Request`).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Request {
    /// `raw`, or the format to transcode to.
    pub format: String,
    pub bit_rate: i64,
    pub sample_rate: i64,
    pub bit_depth: i64,
    pub channels: i64,
}

impl Request {
    fn raw() -> Request {
        Request { format: "raw".into(), ..Request::default() }
    }

    pub fn is_raw(&self) -> bool {
        self.format == "raw"
    }
}

#[derive(Debug, Clone, Default)]
struct DirectPlayProfile {
    containers: Vec<String>,
    audio_codecs: Vec<String>,
    protocols: Vec<String>,
}

#[derive(Debug, Clone, Default)]
struct Profile {
    container: String,
    audio_codec: String,
    protocol: String,
}

#[derive(Debug, Clone, Default)]
struct ClientInfo {
    max_audio_bitrate: i64,
    max_transcoding_audio_bitrate: i64,
    direct_play: Vec<DirectPlayProfile>,
    transcoding: Vec<Profile>,
}

impl ClientInfo {
    /// `CapBitrate`.
    fn cap_bitrate(&mut self, max: i64) {
        if max <= 0 {
            return;
        }
        if self.max_audio_bitrate == 0 || max < self.max_audio_bitrate {
            self.max_audio_bitrate = max;
        }
        if self.max_transcoding_audio_bitrate == 0 || max < self.max_transcoding_audio_bitrate {
            self.max_transcoding_audio_bitrate = max;
        }
    }
}

/// `MediaFile.AudioCodec`: the stored codec, else one inferred from the suffix.
pub fn audio_codec(song: &Song) -> String {
    if !song.codec.is_empty() {
        return song.codec.to_lowercase();
    }
    match song.suffix.to_lowercase().as_str() {
        "mp3" | "mpga" => "mp3",
        "mp2" => "mp2",
        "ogg" | "oga" => "vorbis",
        "opus" => "opus",
        "mpc" => "mpc",
        "wma" => "wma",
        "flac" => "flac",
        "wav" | "aif" | "aiff" | "aifc" => "pcm",
        "ape" => "ape",
        "wv" | "wvp" => "wv",
        "tta" => "tta",
        "tak" => "tak",
        "shn" => "shn",
        "dsf" | "dff" => "dsd",
        "m4a" if song.bit_depth.unwrap_or(0) > 0 => "alac",
        "m4a" | "m4b" | "m4p" | "m4r" => "aac",
        _ => "",
    }
    .to_string()
}

/// `buildLegacyClientInfo`.
fn legacy_client_info(song: &Song, format: &str, bit_rate: i64, player_max: i64, downsampling: &str) -> ClientInfo {
    let mut ci = ClientInfo::default();
    let target = if !format.is_empty() {
        format
    } else if !downsampling.is_empty() && ((bit_rate > 0 && bit_rate < song.bit_rate) || (player_max > 0 && player_max < song.bit_rate)) {
        // a bit rate below the song's, the request's or (issue #5583) the player's alone
        downsampling
    } else {
        ""
    };
    if target.is_empty() {
        ci.direct_play = vec![DirectPlayProfile { protocols: vec!["http".into()], ..DirectPlayProfile::default() }];
        return ci;
    }
    if format.is_empty() || format.eq_ignore_ascii_case(&song.suffix) {
        ci.direct_play =
            vec![DirectPlayProfile { containers: vec![song.suffix.clone()], audio_codecs: vec![audio_codec(song)], protocols: vec!["http".into()] }];
    }
    ci.transcoding = vec![Profile { container: target.into(), audio_codec: target.into(), protocol: "http".into() }];
    if bit_rate > 0 {
        ci.max_audio_bitrate = bit_rate;
        ci.max_transcoding_audio_bitrate = bit_rate;
    }
    ci
}

/// `ResolveRequest`.
pub fn resolve_request(song: &Song, format: &str, bit_rate: i64, cx: &Context) -> Request {
    if format == "raw" {
        return Request::raw();
    }
    let ci = legacy_client_info(song, format, bit_rate, cx.player_max_bit_rate, cx.default_downsampling_format);
    if let Some(request) = resolve(song, ci, cx) {
        return request;
    }
    // no profile for the format asked for: once more with the default downsampling format
    let fallback = cx.default_downsampling_format;
    if !format.is_empty() && !fallback.is_empty() && !format.eq_ignore_ascii_case(fallback) {
        return resolve_request(song, fallback, bit_rate, cx);
    }
    Request::raw()
}

/// `resolve`: the player's overrides, then the decision. None: no profile fits.
fn resolve(song: &Song, mut ci: ClientInfo, cx: &Context) -> Option<Request> {
    match cx.player_transcoding.filter(|t| !t.target_format.is_empty()) {
        Some(forced) => ci = server_override(forced, cx.player_max_bit_rate),
        None => ci.cap_bitrate(cx.player_max_bit_rate),
    }
    match make_decision(song, &ci, cx) {
        Decision::DirectPlay => Some(Request::raw()),
        Decision::Transcode(request) => Some(request),
        Decision::Neither => None,
    }
}

/// `applyServerOverride`.
fn server_override(forced: &Transcoding, player_max: i64) -> ClientInfo {
    let max = if player_max > 0 { player_max } else { forced.default_bit_rate };
    let format = forced.target_format.clone();
    ClientInfo {
        max_audio_bitrate: max,
        max_transcoding_audio_bitrate: max,
        direct_play: vec![DirectPlayProfile { containers: vec![format.clone()], audio_codecs: vec![format.clone()], protocols: vec!["http".into()] }],
        transcoding: vec![Profile { container: format.clone(), audio_codec: format, protocol: "http".into() }],
    }
}

/// `Details`: the source's or the transcoded stream's.
#[derive(Debug, Clone, Default)]
struct Details {
    container: String,
    codec: String,
    bitrate: i64,
    sample_rate: i64,
    bit_depth: i64,
    channels: i64,
    lossless: bool,
}

enum Decision {
    DirectPlay,
    Transcode(Request),
    Neither,
}

/// `AudioProbeResult` as `json.Unmarshal` reads it from `probe_data`: None when empty or not what Go would decode.
fn parse_probe(data: &str) -> Option<Details> {
    if data.is_empty() {
        return None;
    }
    let json: serde_json::Value = serde_json::from_str(data).ok()?;
    let mut details = Details::default();
    if json.is_null() {
        return Some(details);
    }
    let object = json.as_object()?;
    let string = |key: &str| match object.get(key) {
        None | Some(serde_json::Value::Null) => Some(String::new()),
        Some(serde_json::Value::String(s)) => Some(s.clone()),
        _ => None,
    };
    let int = |key: &str| match object.get(key) {
        None | Some(serde_json::Value::Null) => Some(0),
        Some(value) => value.as_i64().filter(|_| !value.is_f64()),
    };
    details.codec = string("codec")?;
    string("profile")?;
    details.bitrate = int("bitRate")?;
    details.sample_rate = int("sampleRate")?;
    details.bit_depth = int("bitDepth")?;
    details.channels = int("channels")?;
    Some(details)
}

/// `normalizeProbeCodec`.
fn normalize_probe_codec(codec: &str) -> String {
    let c = codec.to_lowercase();
    if c.starts_with("dsd") {
        "dsd".into()
    } else if c.starts_with("pcm_") {
        "pcm".into()
    } else {
        c
    }
}

/// `isLosslessFormat`.
fn is_lossless(format: &str) -> bool {
    matches!(format.to_lowercase().as_str(), "flac" | "alac" | "wav" | "aiff" | "ape" | "wv" | "wavpack" | "tta" | "tak" | "shn" | "dsd" | "pcm")
}

/// `buildSourceStream`, without probing (`SkipProbe`): stored probe data, else the scanner's values.
fn source(song: &Song) -> Details {
    let mut details = match parse_probe(&song.probe_data) {
        Some(probe) => Details { codec: normalize_probe_codec(&probe.codec), ..probe },
        None => Details {
            codec: audio_codec(song),
            bitrate: song.bit_rate,
            sample_rate: song.sample_rate,
            bit_depth: song.bit_depth.unwrap_or(0),
            channels: song.channels,
            ..Details::default()
        },
    };
    details.container = song.suffix.clone();
    details.lossless = is_lossless(&details.codec);
    details
}

const CONTAINER_ALIASES: [&[&str]; 7] = [
    &["aac", "adts", "m4a", "mp4", "m4b", "m4p"],
    &["mpeg", "mp3", "mp2"],
    &["ogg", "oga", "opus"],
    &["aif", "aiff"],
    &["asf", "wma"],
    &["mpc", "mpp"],
    &["wv"],
];
const CODEC_ALIASES: [&[&str]; 11] = [
    &["aac", "adts"],
    &["ac3", "ac-3"],
    &["eac3", "e-ac3", "e-ac-3", "eac-3"],
    &["mpc7", "musepack7"],
    &["mpc8", "musepack8"],
    &["wma1", "wmav1"],
    &["wma2", "wmav2"],
    &["wmalossless", "wma9lossless"],
    &["wmapro", "wma9pro"],
    &["shn", "shorten"],
    &["mp4als", "als"],
];

/// `matchesWithAliases`.
fn matches_with_aliases(value: &str, candidates: &[String], groups: &[&[&str]]) -> bool {
    let value = value.to_lowercase();
    let group_of = |name: &str| groups.iter().position(|group| group.contains(&name));
    let canonical = group_of(&value);
    candidates.iter().any(|candidate| {
        let candidate = candidate.to_lowercase();
        candidate == value || (canonical.is_some() && group_of(&candidate) == canonical)
    })
}

/// `checkDirectPlayProfile`: whether the source plays as it is.
fn direct_play_fits(src: &Details, profile: &DirectPlayProfile) -> bool {
    if !profile.protocols.is_empty() && !profile.protocols.iter().any(|p| p.eq_ignore_ascii_case("http")) {
        return false;
    }
    if !profile.containers.is_empty() && !matches_with_aliases(&src.container, &profile.containers, &CONTAINER_ALIASES) {
        return false;
    }
    // matchesPCMWAVBridge
    let bridge = src.codec.eq_ignore_ascii_case("pcm")
        && src.container.eq_ignore_ascii_case("wav")
        && profile.audio_codecs.iter().any(|c| c.eq_ignore_ascii_case("wav"));
    if !profile.audio_codecs.is_empty() && !matches_with_aliases(&src.codec, &profile.audio_codecs, &CODEC_ALIASES) && !bridge {
        return false;
    }
    true
}

/// `LookupTranscodeCommand`: the stored command, else the built-in one; empty for an unknown format.
pub fn command_for(format: &str, find: &dyn Fn(&str) -> Option<Transcoding>) -> String {
    if let Some(row) = find(format).filter(|row| !row.command.is_empty()) {
        return row.command;
    }
    DEFAULT_TRANSCODINGS.iter().find(|(f, _, _)| *f == format).map(|(_, _, c)| c.to_string()).unwrap_or_default()
}

/// `lookupDefaultBitrate`.
fn default_bitrate(format: &str, find: &dyn Fn(&str) -> Option<Transcoding>) -> i64 {
    if let Some(row) = find(format).filter(|row| row.default_bit_rate > 0) {
        return row.default_bit_rate;
    }
    DEFAULT_TRANSCODINGS.iter().find(|(f, rate, _)| *f == format && *rate > 0).map(|(_, rate, _)| *rate).unwrap_or(FALLBACK_BITRATE)
}

/// `MakeDecision` for the legacy client.
fn make_decision(song: &Song, ci: &ClientInfo, cx: &Context) -> Decision {
    let src = source(song);
    if !(ci.max_audio_bitrate > 0 && src.bitrate > ci.max_audio_bitrate) && ci.direct_play.iter().any(|profile| direct_play_fits(&src, profile)) {
        return Decision::DirectPlay;
    }
    for profile in &ci.transcoding {
        if let Some((target, details)) = transcoded_stream(&src, profile, ci, cx) {
            return Decision::Transcode(Request {
                format: target,
                bit_rate: details.bitrate,
                sample_rate: details.sample_rate,
                bit_depth: details.bit_depth,
                channels: details.channels,
            });
        }
    }
    Decision::Neither
}

/// `computeTranscodedStream`.
fn transcoded_stream(src: &Details, profile: &Profile, ci: &ClientInfo, cx: &Context) -> Option<(String, Details)> {
    if !profile.protocol.is_empty() && !profile.protocol.eq_ignore_ascii_case("http") {
        return None;
    }
    // resolveTargetFormat
    let container = profile.container.to_lowercase();
    let target = if profile.audio_codec.is_empty() { container.clone() } else { profile.audio_codec.to_lowercase() };
    if target.is_empty() {
        return None;
    }
    let container = if container.is_empty() { target.clone() } else { container };
    if command_for(&target, cx.find).is_empty() {
        return None;
    }
    let target_lossless = is_lossless(&target);
    if !src.lossless && target_lossless {
        return None;
    }
    let codec = if profile.audio_codec.is_empty() { target.clone() } else { profile.audio_codec.to_lowercase() };
    let mut ts = Details {
        container,
        sample_rate: if src.codec.eq_ignore_ascii_case("dsd") && src.sample_rate > 0 { src.sample_rate / 8 } else { src.sample_rate },
        channels: src.channels,
        // targetBitDepth
        bit_depth: match (target_lossless, src.codec.eq_ignore_ascii_case("dsd") && src.bit_depth == 1) {
            (false, _) => 0,
            (true, true) => 24,
            (true, false) => src.bit_depth,
        },
        lossless: target_lossless,
        codec,
        bitrate: 0,
    };
    // codecFixedOutputSampleRate, codecMaxSampleRate, codecMaxChannels
    if ts.codec == "opus" {
        ts.sample_rate = 48000;
    }
    let max_rate = match ts.codec.as_str() {
        "mp3" => 48000,
        "aac" => 96000,
        _ => 0,
    };
    if max_rate > 0 && ts.sample_rate > max_rate {
        ts.sample_rate = max_rate;
    }
    let max_channels = match ts.codec.as_str() {
        "mp3" => 2,
        "opus" => 8,
        _ => 0,
    };
    if max_channels > 0 && ts.channels > max_channels {
        ts.channels = max_channels;
    }
    // computeBitrate
    if src.lossless {
        if !target_lossless {
            ts.bitrate = if ci.max_transcoding_audio_bitrate > 0 {
                ci.max_transcoding_audio_bitrate
            } else if ci.max_audio_bitrate > 0 {
                ci.max_audio_bitrate
            } else {
                default_bitrate(&target, cx.find)
            };
        } else if ci.max_audio_bitrate > 0 && src.bitrate > ci.max_audio_bitrate {
            return None;
        }
    } else {
        ts.bitrate = src.bitrate;
    }
    if ci.max_audio_bitrate > 0 && ts.bitrate > 0 && ts.bitrate > ci.max_audio_bitrate {
        ts.bitrate = ci.max_audio_bitrate;
    }
    Some((target, ts))
}

// ---------------------------------------------------------------- running it

/// `formatCodecMap`, `formatOutputMap`.
fn codec_and_output(format: &str) -> Option<(&'static str, &'static str)> {
    Some(match format {
        "mp3" => ("libmp3lame", "mp3"),
        "opus" => ("libopus", "opus"),
        "aac" => ("aac", "adts"),
        "flac" => ("flac", "flac"),
        _ => return None,
    })
}

/// Whether a format's command is Navidrome's built-in one (`isDefaultCommand`): only those are run here.
pub fn is_default_command(format: &str, command: &str) -> bool {
    DEFAULT_TRANSCODINGS.iter().any(|(f, _, c)| *f == format && *c == command)
}

/// `buildDynamicArgs`, after the program: the arguments ffmpeg gets for a request. `input` is the file as ffmpeg is
/// to open it.
pub fn ffmpeg_args(request: &Request, input: &str, offset: i64) -> Option<Vec<String>> {
    let (codec, output) = codec_and_output(&request.format)?;
    let mut args: Vec<String> = Vec::new();
    if offset > 0 {
        args.extend(["-ss".into(), offset.to_string()]);
    }
    args.extend(["-i".into(), input.into(), "-map".into(), "0:a:0".into()]);
    args.extend(["-map_metadata", "0", "-map_metadata", "0:s:a:0", "-c:a", codec].map(String::from));
    if request.bit_rate > 0 {
        args.extend(["-b:a".into(), format!("{}k", request.bit_rate)]);
    }
    // injectDynamicAudioFlags
    if request.sample_rate > 0 {
        args.extend(["-ar".into(), request.sample_rate.to_string()]);
    }
    if request.channels > 0 {
        args.extend(["-ac".into(), request.channels.to_string()]);
    }
    if request.bit_depth >= 16 && matches!(request.format.as_str(), "flac" | "alac" | "wav" | "aiff") {
        args.extend(["-sample_fmt".into(), if request.bit_depth == 16 { "s16" } else { "s32" }.into()]);
    }
    args.extend(["-v", "0", "-f", output, "-"].map(String::from));
    Some(args)
}

/// `Stream.EstimatedContentLength`, in Go's `float32` arithmetic.
pub fn estimated_length(duration: f64, bit_rate: i64) -> i64 {
    (duration as f32 * bit_rate as f32 / 8.0 * 1024.0) as i64
}

/// Where a FLAC stream's total sample count is, and how much of it to hold back until it is fixed.
pub const FLAC_PREFIX: usize = 26;

/// `setFLACTotalSamples`: the count ffmpeg leaves at 0 when writing to a pipe, from the rate in the header.
pub fn patch_flac_total_samples(prefix: &mut [u8], duration: f32) {
    if duration <= 0.0 || prefix.len() < FLAC_PREFIX || &prefix[..4] != b"fLaC" || prefix[4] & 0x7F != 0 {
        return;
    }
    let info = u64::from_be_bytes(prefix[18..26].try_into().expect("eight bytes"));
    let rate = info >> 44;
    const MAX: u64 = (1 << 36) - 1;
    if rate == 0 || info & MAX != 0 {
        return;
    }
    let total = (f64::from(duration) * rate as f64).round();
    if total > MAX as f64 {
        return;
    }
    prefix[18..26].copy_from_slice(&(info | total as u64).to_be_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn song(suffix: &str, codec: &str, bit_rate: i64, bit_depth: Option<i64>) -> Song {
        Song { id: "1".into(), suffix: suffix.into(), codec: codec.into(), bit_rate, channels: 2, sample_rate: 44100, bit_depth, ..Song::default() }
    }

    fn flac() -> Song {
        song("flac", "FLAC", 1000, Some(16))
    }

    fn mp3(bit_rate: i64) -> Song {
        song("mp3", "MP3", bit_rate, None)
    }

    /// Navidrome's test mock of the transcoding table: mp3 at 160, the rest as built in.
    fn mock(format: &str) -> Option<Transcoding> {
        (format == "mp3").then(|| Transcoding { target_format: "mp3".into(), default_bit_rate: 160, command: DEFAULT_TRANSCODINGS[0].2.into() })
    }

    fn none(_: &str) -> Option<Transcoding> {
        None
    }

    fn resolve_with(song: &Song, format: &str, bit_rate: i64, player_max: i64, forced: Option<&Transcoding>, downsampling: &str) -> Request {
        let cx = Context { player_max_bit_rate: player_max, player_transcoding: forced, default_downsampling_format: downsampling, find: &mock };
        resolve_request(song, format, bit_rate, &cx)
    }

    fn resolve(song: &Song, format: &str, bit_rate: i64) -> Request {
        resolve_with(song, format, bit_rate, 0, None, "opus")
    }

    fn forced(format: &str, rate: i64) -> Transcoding {
        Transcoding { target_format: format.into(), default_bit_rate: rate, command: String::new() }
    }

    // legacy_client_test.go, "buildLegacyClientInfo"
    #[test]
    fn the_legacy_client_info() {
        let mf = song("flac", "", 960, None);
        let ci = legacy_client_info(&mf, "mp3", 0, 0, "opus");
        assert_eq!((ci.transcoding[0].container.as_str(), ci.transcoding[0].audio_codec.as_str(), ci.max_audio_bitrate), ("mp3", "mp3", 0));
        assert!(ci.direct_play.is_empty(), "explicit format differs from the source: no direct play");
        assert!(legacy_client_info(&mf, "opus", 0, 0, "opus").direct_play.is_empty());
        let same = legacy_client_info(&mf, "flac", 0, 0, "opus");
        assert_eq!((same.direct_play[0].containers.clone(), same.direct_play[0].audio_codecs.clone()), (vec!["flac".to_string()], vec!["flac".to_string()]));
        let capped = legacy_client_info(&mf, "mp3", 192, 0, "opus");
        assert_eq!((capped.max_audio_bitrate, capped.max_transcoding_audio_bitrate), (192, 192));
        let nothing = legacy_client_info(&mf, "", 0, 0, "opus");
        assert!(nothing.transcoding.is_empty() && nothing.direct_play[0].containers.is_empty() && nothing.direct_play[0].protocols == ["http"]);
        let downsample = legacy_client_info(&mf, "", 128, 0, "opus");
        assert_eq!((downsample.transcoding[0].container.as_str(), downsample.max_audio_bitrate), ("opus", 128));
        assert_eq!(downsample.direct_play[0].containers, ["flac"]);
        assert!(legacy_client_info(&mf, "", 960, 0, "opus").transcoding.is_empty(), "bit rate at the source's");
        assert_eq!(legacy_client_info(&mf, "", 0, 256, "opus").transcoding[0].container, "opus", "the player's cap alone");
        assert!(legacy_client_info(&mf, "", 0, 960, "opus").transcoding.is_empty());
        assert!(legacy_client_info(&mf, "", 0, 256, "").transcoding.is_empty(), "no downsampling format");
        assert_eq!(legacy_client_info(&mf, "mp3", 0, 256, "opus").transcoding[0].container, "mp3", "the request's format first");
    }

    // legacy_client_test.go, "ResolveRequest"
    #[test]
    fn resolve_request_as_navidrome() {
        assert!(resolve(&mp3(320), "raw", 0).is_raw());
        assert!(resolve(&mp3(320), "", 0).is_raw());
        assert_eq!(resolve(&flac(), "opus", 0).format, "opus");
        let r = resolve(&flac(), "mp3", 128);
        assert_eq!((r.format.as_str(), r.bit_rate), ("mp3", 128));
        assert!(resolve(&mp3(320), "mp3", 320).is_raw(), "the source's format at its bit rate");
        let r = resolve(&flac(), "", 128);
        assert_eq!((r.format.as_str(), r.bit_rate), ("opus", 128));
        // a player's forced transcoding
        let r = resolve_with(&song("flac", "FLAC", 1000, None), "", 0, 0, Some(&forced("mp3", 192)), "opus");
        assert_eq!((r.format.as_str(), r.bit_rate), ("mp3", 192));
        assert!(resolve_with(&mp3(128), "", 0, 0, Some(&forced("mp3", 256)), "opus").is_raw());
        let r = resolve_with(&mp3(320), "", 0, 0, Some(&forced("mp3", 192)), "opus");
        assert_eq!((r.format.as_str(), r.bit_rate), ("mp3", 192));
        let r = resolve_with(&song("flac", "FLAC", 1000, None), "", 0, 320, Some(&forced("mp3", 192)), "opus");
        assert_eq!(r.bit_rate, 320, "the player's MaxBitRate over the transcoding's default");
        let r = resolve_with(&song("flac", "FLAC", 1000, None), "", 0, 0, Some(&forced("mp3", 0)), "opus");
        assert_eq!((r.format.as_str(), r.bit_rate), ("mp3", 160), "no cap: the format's default bit rate (160 in the mock)");
        assert!(resolve(&song("flac", "FLAC", 1000, None), "", 0).is_raw());
        // the player's MaxBitRate
        let r = resolve_with(&flac(), "mp3", 0, 320, None, "opus");
        assert_eq!((r.format.as_str(), r.bit_rate), ("mp3", 320));
        assert_eq!(resolve_with(&flac(), "mp3", 256, 500, None, "opus").bit_rate, 256);
        assert!(resolve_with(&mp3(320), "", 0, 0, None, "opus").is_raw());
        let r = resolve_with(&flac(), "", 0, 256, None, "opus");
        assert_eq!((r.format.as_str(), r.bit_rate), ("opus", 256));
        assert!(resolve_with(&flac(), "", 0, 256, None, "").is_raw());
        // an unknown format
        assert_eq!(resolve(&mp3(320), "xyz", 0).format, "opus");
        assert!(resolve_with(&mp3(320), "xyz", 0, 0, None, "").is_raw());
        assert!(resolve_with(&mp3(320), "xyz", 0, 0, None, "xyz").is_raw());
        let r = resolve(&flac(), "xyz", 128);
        assert_eq!((r.format.as_str(), r.bit_rate), ("opus", 128));
    }

    #[test]
    fn transcoded_streams_follow_the_codecs_limits() {
        // opus resamples to 48 kHz; mp3 caps at 48 kHz and two channels; lossy to lossless is refused
        let hi = Song { sample_rate: 96000, channels: 6, ..flac() };
        let cx = Context { player_max_bit_rate: 0, player_transcoding: None, default_downsampling_format: "opus", find: &none };
        let r = resolve_request(&hi, "mp3", 0, &cx);
        assert_eq!((r.format.as_str(), r.bit_rate, r.sample_rate, r.channels, r.bit_depth), ("mp3", 192, 48000, 2, 0));
        let r = resolve_request(&hi, "opus", 0, &cx);
        assert_eq!((r.bit_rate, r.sample_rate, r.channels), (128, 48000, 6));
        let r = resolve_request(&hi, "aac", 0, &cx);
        assert_eq!((r.bit_rate, r.sample_rate), (256, 96000));
        let r = resolve_request(&song("ape", "", 900, Some(24)), "flac", 0, &cx);
        assert_eq!((r.format.as_str(), r.bit_rate, r.bit_depth), ("flac", 0, 24));
        // lossy to flac: refused, then the default downsampling format
        let r = resolve_request(&mp3(320), "flac", 0, &cx);
        assert_eq!((r.format.as_str(), r.bit_rate), ("opus", 320), "lossy keeps its bit rate");
        // DSD: an eighth of the rate, 24-bit as PCM
        let dsd = Song { sample_rate: 2_822_400, bit_depth: Some(1), ..song("dsf", "", 5645, Some(1)) };
        let r = resolve_request(&dsd, "flac", 0, &cx);
        assert_eq!((r.sample_rate, r.bit_depth), (352_800, 24));
        let r = resolve_request(&dsd, "mp3", 320, &cx);
        assert_eq!((r.format.as_str(), r.bit_rate, r.sample_rate), ("mp3", 320, 48000));
    }

    #[test]
    fn stored_probe_data_outranks_the_scanner() {
        let probed = Song {
            probe_data: r#"{"codec":"pcm_s24le","bitRate":2304,"sampleRate":48000,"bitDepth":24,"channels":2}"#.into(),
            ..song("wav", "", 1411, Some(16))
        };
        let src = source(&probed);
        assert_eq!((src.codec.as_str(), src.bitrate, src.sample_rate, src.bit_depth, src.lossless), ("pcm", 2304, 48000, 24, true));
        assert_eq!(source(&Song { probe_data: r#"{"codec":"DSD_LSBF_PLANAR"}"#.into(), ..flac() }).codec, "dsd");
        assert_eq!(source(&Song { probe_data: r#"{"bitRate":"x"}"#.into(), ..flac() }).codec, "flac", "what Go cannot decode is ignored");
        assert_eq!(source(&Song { probe_data: "null".into(), ..flac() }).codec, "", "null decodes to nothing");
    }

    #[test]
    fn codecs_and_aliases() {
        assert_eq!(audio_codec(&song("m4a", "", 0, Some(16))), "alac");
        assert_eq!(audio_codec(&song("m4a", "", 0, None)), "aac");
        assert_eq!(audio_codec(&song("OGG", "", 0, None)), "vorbis");
        assert_eq!(audio_codec(&song("xyz", "", 0, None)), "");
        assert_eq!(audio_codec(&song("mp3", "MP3", 0, None)), "mp3");
        let s = |list: &[&str]| list.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        assert!(matches_with_aliases("m4a", &s(&["mp4"]), &CONTAINER_ALIASES));
        assert!(matches_with_aliases("OGA", &s(&["opus"]), &CONTAINER_ALIASES));
        assert!(!matches_with_aliases("flac", &s(&["mp3"]), &CONTAINER_ALIASES));
        assert!(matches_with_aliases("adts", &s(&["AAC"]), &CODEC_ALIASES));
        let wav = Details { codec: "pcm".into(), container: "wav".into(), ..Details::default() };
        assert!(direct_play_fits(&wav, &DirectPlayProfile { audio_codecs: s(&["wav"]), ..DirectPlayProfile::default() }), "the PCM/WAV bridge");
    }

    #[test]
    fn ffmpeg_gets_navidromes_arguments() {
        let r = Request { format: "mp3".into(), bit_rate: 320, sample_rate: 44100, channels: 2, ..Request::default() };
        assert_eq!(
            ffmpeg_args(&r, "/music/a.flac", 0).unwrap().join(" "),
            "-i /music/a.flac -map 0:a:0 -map_metadata 0 -map_metadata 0:s:a:0 -c:a libmp3lame -b:a 320k -ar 44100 -ac 2 -v 0 -f mp3 -"
        );
        let r = Request { format: "flac".into(), sample_rate: 44100, channels: 2, bit_depth: 24, ..Request::default() };
        assert_eq!(
            ffmpeg_args(&r, "x", 30).unwrap().join(" "),
            "-ss 30 -i x -map 0:a:0 -map_metadata 0 -map_metadata 0:s:a:0 -c:a flac -ar 44100 -ac 2 -sample_fmt s32 -v 0 -f flac -"
        );
        let r = Request { format: "aac".into(), bit_rate: 256, ..Request::default() };
        assert!(ffmpeg_args(&r, "x", 0).unwrap().join(" ").ends_with("-c:a aac -b:a 256k -v 0 -f adts -"));
        assert!(ffmpeg_args(&Request { format: "wav".into(), ..Request::default() }, "x", 0).is_none());
        assert!(is_default_command("opus", DEFAULT_TRANSCODINGS[1].2));
        assert!(!is_default_command("mp3", "ffmpeg -i %s -ss %t -map 0:a:0 -b:a %bk -v 0 -f mp3 -"), "an older default is a command of its own");
        assert_eq!(command_for("mp3", &none), DEFAULT_TRANSCODINGS[0].2);
        assert_eq!(command_for("wav", &none), "");
    }

    #[test]
    fn lengths_and_flac_headers_as_go_makes_them() {
        assert_eq!(estimated_length(180.5, 320), 7_393_280);
        assert_eq!(estimated_length(212.97, 128), 3_489_300);
        // STREAMINFO: rate 44100, 2 channels, 16 bits, no total
        let mut header = vec![0u8; FLAC_PREFIX];
        header[..4].copy_from_slice(b"fLaC");
        let info: u64 = (44100 << 44) | (1 << 41) | (15 << 36);
        header[18..26].copy_from_slice(&info.to_be_bytes());
        patch_flac_total_samples(&mut header, 2.5);
        assert_eq!(u64::from_be_bytes(header[18..26].try_into().unwrap()) & ((1 << 36) - 1), 110_250);
        let before = header.clone();
        patch_flac_total_samples(&mut header, 9.0);
        assert_eq!(header, before, "a count already there stays");
        let mut other = b"ID3\x04".repeat(7)[..FLAC_PREFIX].to_vec();
        let copy = other.clone();
        patch_flac_total_samples(&mut other, 2.5);
        assert_eq!(other, copy);
    }
}
