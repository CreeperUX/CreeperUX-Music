namespace Sonus.Core.Audio;

/// <summary>Streaming quality preference for Wi-Fi or cellular/metered networks.</summary>
public enum AudioQuality
{
    /// <summary>Automatic: lossless on Wi-Fi, high (Opus 160) on cellular/metered; may temporarily step down on slow buffering.</summary>
    Auto,
    /// <summary>Opus 96 kbps.</summary>
    Normal,
    /// <summary>Opus 160 kbps.</summary>
    High,
    /// <summary>Opus 256 kbps.</summary>
    VeryHigh,
    /// <summary>Lossless FLAC at original sample rate and bit depth.</summary>
    Lossless,
}

/// <summary>EBU R128 loudness normalization target level.</summary>
public enum LoudnessLevel
{
    /// <summary>Disabled (default): play at unmodified level.</summary>
    Off,
    /// <summary>-18 LUFS target.</summary>
    Quiet,
    /// <summary>-14 LUFS target (default when enabled).</summary>
    Normal,
    /// <summary>-11 LUFS target.</summary>
    Loud,
}

/// <summary>Whether loudness normalization preserves relative track dynamics across an album or levels each track independently.</summary>
public enum LoudnessMode
{
    /// <summary>Normalize by album loudness so quiet interludes stay quiet relative to loud tracks (default).</summary>
    Album,
    /// <summary>Normalize each track individually to the target LUFS.</summary>
    Track,
}

/// <summary>Server-measured EBU R128 integrated loudness (LUFS) and true peak (linear, 1.0 = 0 dBFS).</summary>
public sealed record LoudnessInfo(double? TrackLufs, double? TrackPeak, double? AlbumLufs, double? AlbumPeak);

/// <summary>One pre-generated playback rendition available on the server.</summary>
public sealed record RenditionInfo(
    string Tier,
    string Format,
    int SampleRate,
    int BitDepth,
    int Channels,
    long TotalSamples,
    int BitRate,
    long FileSize);

/// <summary>Rendition catalog and EBU R128 loudness metadata returned by <c>getSonusRenditions</c>.</summary>
public sealed record SongRenditions(
    string Id,
    string SourceFormat,
    bool SourceLossless,
    int SourceSampleRate,
    int SourceBitDepth,
    int SourceBitRate,
    LoudnessInfo? Loudness,
    IReadOnlyList<RenditionInfo> Renditions);

/// <summary>Display info for the playback-bar quality badge.</summary>
public sealed record QualityBadgeInfo(string Text, bool IsLossless, bool IsHiRes)
{
    public static readonly QualityBadgeInfo Empty = new("", false, false);
}

/// <summary>
/// Pure streaming-quality, auto-downgrade, EBU R128 loudness-gain, and playback-bar badge policy shared across
/// Sonus.Core tests and the Windows client (matching the Android and Web implementations).
/// </summary>
public static class QualityPolicy
{
    private static readonly string[] TierLadder = ["lossless", "veryHigh", "high", "normal"];

    /// <summary>Target integrated loudness in LUFS, or null when loudness normalization is off.</summary>
    public static double? TargetLufs(LoudnessLevel level) => level switch
    {
        LoudnessLevel.Quiet => -18.0,
        LoudnessLevel.Normal => -14.0,
        LoudnessLevel.Loud => -11.0,
        _ => null,
    };

    /// <summary>
    /// Resolves the <c>sonusQuality</c> query parameter to send on <c>stream</c>, or <c>null</c> when the server
    /// does not advertise <c>sonusRenditions</c> (preserving full compatibility with plain Navidrome / Subsonic).
    /// Auto-downgrade only applies when the active network's preference is <see cref="AudioQuality.Auto"/>.
    /// </summary>
    public static string? ResolveTier(
        AudioQuality setting,
        bool metered,
        bool alwaysOriginal,
        int autoDowngradeSteps,
        bool serverHasRenditions)
    {
        if (!serverHasRenditions) return null;
        if (alwaysOriginal) return "original";
        return setting switch
        {
            AudioQuality.Lossless => "lossless",
            AudioQuality.VeryHigh => "veryHigh",
            AudioQuality.High => "high",
            AudioQuality.Normal => "normal",
            _ => TierLadder[Math.Clamp((metered ? 2 : 0) + Math.Max(0, autoDowngradeSteps), 0, TierLadder.Length - 1)],
        };
    }

    /// <summary>
    /// Computes the linear amplitude multiplier for loudness normalization.
    /// Uses server-measured EBU R128 loudness when available (with true-peak protection so positive boost cannot clip),
    /// falling back to ReplayGain tags (referenced to -18 LUFS) when EBU R128 metadata is unavailable.
    /// </summary>
    public static double ComputeLoudnessGain(
        LoudnessLevel level,
        LoudnessMode mode,
        LoudnessInfo? loudness,
        double? rgAlbum,
        double? rgTrack,
        bool allowBoost = true)
    {
        if (TargetLufs(level) is not { } target) return 1.0;

        if (loudness is not null)
        {
            double? measured = mode == LoudnessMode.Album
                ? loudness.AlbumLufs ?? loudness.TrackLufs
                : loudness.TrackLufs ?? loudness.AlbumLufs;
            double? peak = mode == LoudnessMode.Album
                ? loudness.AlbumPeak ?? loudness.TrackPeak
                : loudness.TrackPeak ?? loudness.AlbumPeak;

            if (measured is { } m && double.IsFinite(m))
            {
                double linear = Math.Pow(10.0, (target - m) / 20.0);
                // True-peak ceiling keeps positive loudness boost from clipping digital full scale
                if (peak is { } p && double.IsFinite(p) && p > 0.0001 && linear * p > 1.0)
                    linear = 1.0 / p;
                return Math.Clamp(linear, 0.05, allowBoost ? 4.0 : 1.0);
            }
        }

        double? rg = mode == LoudnessMode.Album ? rgAlbum ?? rgTrack : rgTrack ?? rgAlbum;
        if (rg is { } g && double.IsFinite(g))
        {
            // ReplayGain tags target -18 LUFS; shift relative to the selected target level
            double db = g + (target - (-18.0));
            double linear = Math.Pow(10.0, db / 20.0);
            return Math.Clamp(linear, 0.05, allowBoost ? 4.0 : 1.0);
        }

        return 1.0;
    }

    /// <summary>Formats sample rate in kHz with minimal decimals (e.g. 44100 -> "44.1 kHz", 96000 -> "96 kHz").</summary>
    public static string FormatSampleRate(int hz)
    {
        if (hz <= 0) return "";
        return hz % 1000 == 0
            ? $"{hz / 1000} kHz"
            : string.Create(System.Globalization.CultureInfo.InvariantCulture, $"{hz / 1000.0:0.#} kHz");
    }

    /// <summary>Builds the concise playback-bar quality badge (e.g. "无损 · 96 kHz/24 位", "Opus 160", "MP3 320").</summary>
    public static QualityBadgeInfo FormatBadge(
        StreamMetadata? stream,
        SongRenditions? renditions,
        Track? track,
        string? requestedTier)
    {
        // 1. Live X-Sonus-* HTTP headers from the stream response are the ground truth of what is playing
        if (stream is not null && (!string.IsNullOrEmpty(stream.Quality) || !string.IsNullOrEmpty(stream.Format)))
        {
            string fmt = (stream.Format ?? "").Trim().ToLowerInvariant();
            string q = (stream.Quality ?? "").Trim();
            int sr = stream.SampleRate ?? 0;
            int bd = stream.BitDepth ?? 0;
            int br = stream.BitRate ?? 0;
            // Enrich missing rate/depth from track metadata when serving original lossless files
            if (q == "original" && track is not null)
            {
                if (sr <= 0) sr = track.SampleRate;
                if (bd <= 0) bd = track.BitDepth;
                if (br <= 0) br = track.Bitrate;
            }
            return BuildBadge(fmt, q, sr, bd, br);
        }

        // 2. Rendition catalog for the requested tier (used on legacy backend or before headers arrive)
        if (!string.IsNullOrEmpty(requestedTier) && requestedTier != "original" && renditions is not null)
        {
            var r = renditions.Renditions.FirstOrDefault(x => string.Equals(x.Tier, requestedTier, StringComparison.OrdinalIgnoreCase));
            if (r is not null)
                return BuildBadge(r.Format.ToLowerInvariant(), r.Tier, r.SampleRate, r.BitDepth, r.BitRate);
            // Lossy source (e.g. MP3) served as original when lossless/veryHigh requested
            if (!renditions.SourceLossless && !string.IsNullOrEmpty(renditions.SourceFormat))
                return BuildBadge(renditions.SourceFormat.ToLowerInvariant(), "original", renditions.SourceSampleRate, renditions.SourceBitDepth, renditions.SourceBitRate);
        }

        // 3. Fallback to track metadata (plain Navidrome / demo server / alwaysOriginal)
        if (track is null) return QualityBadgeInfo.Empty;
        if (requestedTier is null && track.Suffix is "dsf" or "dff" or "ape" or "wv" or "tta" or "tak" or "mpc" or "wma")
            return new QualityBadgeInfo("MP3 320", false, false);

        string fallbackFmt = !string.IsNullOrEmpty(track.Suffix) ? track.Suffix.ToLowerInvariant() : track.Codec.ToLowerInvariant();
        return BuildBadge(fallbackFmt, track.IsLossless ? "lossless" : "original", track.SampleRate, track.BitDepth, track.Bitrate, track.Codec);
    }

    private static QualityBadgeInfo BuildBadge(string fmt, string quality, int sampleRate, int bitDepth, int bitRate, string? codecHint = null)
    {
        bool lossless = quality == "lossless"
            || bitDepth > 0
            || fmt is "flac" or "wav" or "alac" or "aiff" or "ape" or "wv" or "dsf" or "dff";

        if (lossless)
        {
            bool hiRes = bitDepth > 16 || sampleRate > 48000;
            string rate = FormatSampleRate(sampleRate);
            string detail = (rate.Length > 0, bitDepth > 0) switch
            {
                (true, true) => $"{rate}/{bitDepth} 位",
                (true, false) => rate,
                (false, true) => $"{bitDepth} 位",
                _ => "",
            };
            return new QualityBadgeInfo(detail.Length > 0 ? $"无损 · {detail}" : "无损", true, hiRes);
        }

        if (fmt == "opus")
        {
            int kbps = bitRate > 0 ? bitRate : quality switch
            {
                "veryHigh" => 256,
                "high" => 160,
                "normal" => 96,
                _ => 0,
            };
            return new QualityBadgeInfo(kbps > 0 ? $"Opus {kbps}" : "Opus", false, false);
        }

        string codec = fmt switch
        {
            "mp3" => "MP3",
            "aac" or "m4a" => "AAC",
            "ogg" or "oga" or "vorbis" => "Vorbis",
            _ when !string.IsNullOrWhiteSpace(codecHint) && codecHint != "?" => codecHint,
            _ when fmt.Length > 0 => fmt.ToUpperInvariant(),
            _ => "",
        };
        if (codec.Length == 0) return QualityBadgeInfo.Empty;
        return new QualityBadgeInfo(bitRate > 0 ? $"{codec} {bitRate}" : codec, false, false);
    }
}
