using System.Text.Json;
using CreeperUX.Music.Core;

namespace CreeperUX.Music;

/// <summary>Where the app keeps its things: %LOCALAPPDATA%\CreeperUX Music, or CXMUSIC_DATA_DIR (test instances).</summary>
public static class AppPaths
{
    public static string DataDirectory { get; } = Environment.GetEnvironmentVariable("CXMUSIC_DATA_DIR") is { Length: > 0 } custom
        ? Path.GetFullPath(custom)
        : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "CreeperUX Music");

    /// <summary>A test instance (tools/e2e): its own data folder and credentials, never the user's.</summary>
    public static bool IsTestInstance => Testing.E2EChannel.Enabled;
}

/// <summary>The app's preferences (settings.json in the data folder). The sign-in is not here: it is in Credential Manager.</summary>
public sealed class AppSettings
{
    public double Volume { get; set; } = 0.8;
    public bool Muted { get; set; }
    public ReplayGainMode ReplayGain { get; set; } = ReplayGainMode.Album;
    public PlaybackOrder Order { get; set; } = PlaybackOrder.Default;
    public string? OutputDeviceId { get; set; }
    public bool LibraryOpen { get; set; } = true;
    public bool PanelOpen { get; set; } = true;
    public string LibraryFilter { get; set; } = "";
    public string LibrarySort { get; set; } = "recent";
    public string LastServer { get; set; } = "";
    /// <summary>The interface zoom, as a browser's (0.8 … 1.25).</summary>
    public double Zoom { get; set; } = 1;
    /// <summary>Check GitHub for a newer version once a day after starting (设置 › 更新).</summary>
    public bool AutoCheckUpdates { get; set; } = true;
    /// <summary>Offer test versions (GitHub pre-releases) too.</summary>
    public bool UpdatePrerelease { get; set; }
    public DateTime? LastUpdateCheck { get; set; }

    private static string FilePath => Path.Combine(AppPaths.DataDirectory, "settings.json");
    private static readonly JsonSerializerOptions Options = new() { WriteIndented = true };

    public static AppSettings Load()
    {
        try { return JsonSerializer.Deserialize<AppSettings>(File.ReadAllText(FilePath)) ?? new(); }
        catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException) { return new(); }
    }

    public void Save()
    {
        try
        {
            Directory.CreateDirectory(AppPaths.DataDirectory);
            File.WriteAllText(FilePath, JsonSerializer.Serialize(this, Options));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { Log.Write($"settings not saved: {ex.Message}"); }
    }
}
