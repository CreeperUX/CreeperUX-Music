using System.Diagnostics;
using System.Runtime.InteropServices;
using CreeperUX.Music.Core.Updates;
using CreeperUX.Music.Interop;

namespace CreeperUX.Music.Updates;

/// <summary>
/// A newer CreeperUX Music on GitHub, found as Lumen finds its own: checked once a day after starting (and from
/// 设置 › 更新), installed by downloading the installer for this architecture, checking it against GitHub's SHA-256,
/// then running it while the app closes. CreeperUX/CreeperUX-Music is private, so every call carries the user's
/// read-only token, kept in Credential Manager beside the sign-in. UI thread only.
/// </summary>
public sealed class UpdateService(AppSettings settings)
{
    private const string TokenSecret = "github";
    private static readonly TimeSpan CheckInterval = TimeSpan.FromHours(23); // "once a day", whatever time the app starts
    private static readonly TimeSpan StartupDelay = TimeSpan.FromSeconds(8);  // once the library has settled
    private static readonly TimeSpan ListTimeout = TimeSpan.FromSeconds(20);

    // CXMUSIC_GITHUB_API points a test instance at a fake GitHub (tools/e2e/fake-github.mjs)
    private static readonly Uri? Api = Environment.GetEnvironmentVariable("CXMUSIC_GITHUB_API") is { Length: > 0 } api
        ? new Uri(api.EndsWith('/') ? api : api + "/") : null;

    // Not the covers' or the server's client: an installer takes minutes on a slow line. The list has its own timeout
    // (ListTimeout); a download runs until done or cancelled.
    private static readonly HttpClient Http = new() { Timeout = Timeout.InfiniteTimeSpan };

    /// <summary>This app's version (CreeperUX.Music.csproj).</summary>
    public static Version Current { get; } = typeof(App).Assembly.GetName().Version ?? new Version(0, 0, 0);
    public static string CurrentText => Current.ToString(3);

    /// <summary>The installer this computer needs ("x64", "ARM64"), as tools/package.ps1 names them.</summary>
    public static string Architecture => RuntimeInformation.ProcessArchitecture == System.Runtime.InteropServices.Architecture.Arm64 ? "ARM64" : "x64";

    public AppSettings Settings => settings;

    public bool HasToken => !string.IsNullOrEmpty(Credentials.ReadSecret(TokenSecret));
    public void SaveToken(string token) => Credentials.WriteSecret(TokenSecret, token, "CreeperUX Music: read-only GitHub token for updates");
    public void RemoveToken() => Credentials.DeleteSecret(TokenSecret);

    /// <summary>The newer version the last check found; null when up to date or not checked yet.</summary>
    public AppRelease? Available { get; private set; }
    public event Action? AvailableChanged;

    /// <summary>Asks GitHub for the newest release this app should move to (null: up to date).</summary>
    public async Task<AppRelease?> CheckAsync()
    {
        using var timeout = new CancellationTokenSource(ListTimeout);
        IReadOnlyList<AppRelease> releases;
        try { releases = await Client().ReleasesAsync(timeout.Token); }
        catch (OperationCanceledException ex) when (timeout.IsCancellationRequested) { throw new UpdateException("连接 GitHub 超时。", ex); }
        var newest = GitHubUpdates.Newest(releases, Current, settings.UpdatePrerelease, Architecture);
        Log.Write($"[update] {releases.Count} release(s) on GitHub; this is {CurrentText} ({Architecture}): {(newest is null ? "up to date" : $"{newest.Tag} available")}");
        settings.LastUpdateCheck = DateTime.UtcNow;
        settings.Save();
        if (newest?.Tag != Available?.Tag)
        {
            Available = newest;
            AvailableChanged?.Invoke();
        }
        return newest;
    }

    /// <summary>The once-a-day check after starting (设置 › 更新 › 启动时自动检查). Quiet when it can't check.</summary>
    public async void CheckOnStartup()
    {
        if (!settings.AutoCheckUpdates || !HasToken) return;
        if (settings.LastUpdateCheck is { } last && DateTime.UtcNow - last < CheckInterval) return;
        await Task.Delay(StartupDelay);
        try { await CheckAsync(); }
        catch (UpdateException ex) { Log.Write($"[update] automatic check: {ex.Message}"); }
    }

    /// <summary>Downloads the release's installer for this computer (into %TEMP%\CreeperUX-Music-Update); its path.</summary>
    public async Task<string> DownloadAsync(AppRelease release, IProgress<double> progress, CancellationToken ct)
    {
        var asset = release.SetupFor(Architecture) ?? throw new UpdateException("这个版本没有适合这台电脑的安装程序。");
        // a test instance keeps it in its own data folder, where the test finds it
        string folder = AppPaths.IsTestInstance ? Path.Combine(AppPaths.DataDirectory, "update") : Path.Combine(Path.GetTempPath(), "CreeperUX-Music-Update");
        string path = Path.Combine(folder, asset.Name);
        await Client().DownloadAsync(asset, path, progress, ct);
        Log.Write($"[update] downloaded {asset.Name}, {new FileInfo(path).Length} bytes, sha256 {(asset.Sha256 is null ? "not given by GitHub" : "checked")}");
        return path;
    }

    /// <summary>
    /// Runs the downloaded installer and closes the app, whose files it replaces (the installer waits for that). A test
    /// instance only logs it: tests never install anything.
    /// </summary>
    public static async Task RunInstallerAsync(string path)
    {
        if (AppPaths.IsTestInstance)
        {
            Log.Write($"[update] test instance: installer not started ({Path.GetFileName(path)})");
            return;
        }
        Process.Start(new ProcessStartInfo(path) { UseShellExecute = true })?.Dispose();
        Log.Write("[update] installer started; closing");
        if (App.MainWindow is { } window) await window.CloseAppAsync();
    }

    private static GitHubUpdates Client() =>
        Credentials.ReadSecret(TokenSecret) is { Length: > 0 } token
            ? new GitHubUpdates(Http, token, Api)
            : throw new UpdateException("需要 GitHub 令牌才能检查更新（CreeperUX Music 的仓库是私有的），请在「设置 › 更新」里填写。");
}
