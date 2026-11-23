using System.Globalization;
using System.Text.RegularExpressions;

namespace Sonus.Core;

/// <summary>Lyrics text: "[01:02.50]line" (any number of stamps per line, LRC) becomes timed lines, plain text untimed lines.</summary>
public static partial class LyricsParser
{
    [GeneratedRegex(@"\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]")]
    private static partial Regex Stamp();

    [GeneratedRegex(@"^\[[a-z]+:.*\]$", RegexOptions.IgnoreCase)]
    private static partial Regex Header();

    public static IReadOnlyList<LyricLine>? Parse(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;
        var timed = new List<LyricLine>();
        var plain = new List<LyricLine>();
        foreach (string raw in text.Replace("\r", "").Split('\n'))
        {
            var stamps = Stamp().Matches(raw);
            string line = Header().Replace(Stamp().Replace(raw, "").Trim(), "").Trim(); // drops [ar:…] [ti:…] headers
            if (stamps.Count > 0)
            {
                foreach (Match m in stamps)
                {
                    double time = int.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture) * 60 + int.Parse(m.Groups[2].Value, CultureInfo.InvariantCulture)
                        + (m.Groups[3].Success ? double.Parse("0." + m.Groups[3].Value, CultureInfo.InvariantCulture) : 0);
                    timed.Add(new LyricLine(time, line));
                }
            }
            else if (line.Length > 0 || plain.Count > 0) plain.Add(new LyricLine(null, line));
        }
        if (timed.Count > 0) return timed.OrderBy(l => l.Time).ToList();
        while (plain.Count > 0 && plain[^1].Text.Length == 0) plain.RemoveAt(plain.Count - 1);
        return plain.Count > 0 ? plain : null;
    }

    /// <summary>The line playing at a position: the last one that has started (−1 before the first, or for untimed lyrics).</summary>
    public static int CurrentLine(IReadOnlyList<LyricLine> lines, double position)
    {
        int at = -1;
        for (int i = 0; i < lines.Count; i++)
        {
            if (lines[i].Time is not { } t) return -1;
            if (t <= position + 0.05) at = i; else break;
        }
        return at;
    }
}
