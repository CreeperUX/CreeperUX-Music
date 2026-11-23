using System.Globalization;

namespace Sonus.Core;

/// <summary>Numbers as the interface shows them (Chinese).</summary>
public static class Formats
{
    /// <summary>3:05, 1:02:03.</summary>
    public static string Duration(double seconds)
    {
        if (!double.IsFinite(seconds) || seconds < 0) seconds = 0;
        var t = TimeSpan.FromSeconds(Math.Floor(seconds));
        return t.TotalHours >= 1 ? $"{(int)t.TotalHours}:{t.Minutes:00}:{t.Seconds:00}" : $"{t.Minutes}:{t.Seconds:00}";
    }

    /// <summary>"约 1 小时 20 分钟", "约 35 分钟".</summary>
    public static string LongDuration(double seconds)
    {
        int minutes = (int)Math.Round(seconds / 60);
        return minutes >= 60 ? $"约 {minutes / 60} 小时 {minutes % 60} 分钟" : $"约 {Math.Max(1, minutes)} 分钟";
    }

    public static string Songs(int n) => $"{n} 首歌曲";

    public static string Plays(int n) => $"播放 {n.ToString("N0", CultureInfo.InvariantCulture)} 次";

    /// <summary>"刚刚", "5 分钟前", "3 天前", "2025年3月1日".</summary>
    public static string Relative(DateTimeOffset? when, DateTimeOffset? now = null)
    {
        if (when is not { } w) return "从未";
        var span = (now ?? DateTimeOffset.Now) - w;
        if (span.TotalMinutes < 1) return "刚刚";
        if (span.TotalHours < 1) return $"{(int)span.TotalMinutes} 分钟前";
        if (span.TotalDays < 1) return $"{(int)span.TotalHours} 小时前";
        if (span.TotalDays < 30) return $"{(int)span.TotalDays} 天前";
        return w.ToLocalTime().ToString("yyyy年M月d日", CultureInfo.InvariantCulture);
    }

    public static string Size(long bytes) => bytes >= 1 << 30 ? $"{bytes / (double)(1 << 30):0.0} GB" : $"{bytes / (double)(1 << 20):0.0} MB";

    /// <summary>"FLAC · 24 bit / 96 kHz", "MP3 · 320 kbps", "DSD64".</summary>
    public static string Quality(Track t)
    {
        if (t.Codec.StartsWith("DSD", StringComparison.Ordinal)) return t.Codec;
        if (t.BitDepth > 1) return $"{t.Codec} · {t.BitDepth} bit / {t.SampleRate / 1000.0:0.#} kHz";
        return t.Bitrate > 0 ? $"{t.Codec} · {t.Bitrate} kbps" : t.Codec;
    }

    public static string Greeting(DateTime now) => now.Hour switch { < 5 => "夜深了", < 12 => "早上好", < 18 => "下午好", _ => "晚上好" };

    public static string AlbumType(AlbumType? type) => type switch { Core.AlbumType.Ep => "EP", Core.AlbumType.Single => "单曲", Core.AlbumType.Compilation => "合辑", _ => "专辑" };

    public static string Order(PlaybackOrder o) => o switch
    {
        PlaybackOrder.RepeatPlaylist => "列表循环", PlaybackOrder.RepeatTrack => "单曲循环", PlaybackOrder.Random => "随机",
        PlaybackOrder.ShuffleTracks => "乱序（曲目）", PlaybackOrder.ShuffleAlbums => "乱序（专辑）", PlaybackOrder.ShuffleFolders => "乱序（文件夹）", _ => "默认",
    };
}
