using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text.Json;

namespace Sonus.Core.Updates;

public sealed class UpdateException(string message, Exception? inner = null) : Exception(message, inner);

/// <param name="ApiUrl">The asset's API address (downloads as application/octet-stream).</param>
/// <param name="Sha256">Lower-case hex digest GitHub computed on upload, or null.</param>
public sealed record ReleaseAsset(string Name, long Size, string ApiUrl, string? Sha256);

/// <param name="Tag">"v0.3.0", "v0.4.0-beta.1".</param>
/// <param name="Version">The tag's numbers (0.3.0), for comparing.</param>
public sealed record AppRelease(string Tag, Version Version, bool IsPrerelease, string Title, string Notes,
    DateTime PublishedAt, IReadOnlyList<ReleaseAsset> Assets)
{
    /// <summary>"0.3.0", "0.4.0-beta.1": the tag without its "v".</summary>
    public string DisplayVersion => Tag.TrimStart('v', 'V');

    /// <summary>The installer for an architecture ("x64", "ARM64"), as tools/package.ps1 names it.</summary>
    public ReleaseAsset? SetupFor(string architecture) => Assets.FirstOrDefault(a =>
        a.Name.Equals(GitHubUpdates.SetupName(Version, architecture), StringComparison.OrdinalIgnoreCase));
}

/// <summary>
/// Sonus's releases on GitHub (CreeperUX/Sonus, a public repository: read without signing in; CreeperUX-Music until
/// 0.5, which GitHub still redirects), as Lumen reads its own. Lists them, picks the newest one this app should move to,
/// and downloads its installer, checked against the SHA-256 GitHub keeps for it. Unsigned calls get 60 an hour per
/// address, plenty for a daily check.
/// </summary>
public sealed class GitHubUpdates(HttpClient http, Uri? apiBase = null)
{
    public const string Repository = "CreeperUX/Sonus";
    public static readonly Uri DefaultApi = new("https://api.github.com/");

    /// <summary>"Sonus-0.4.0-x64-setup.exe": the installer tools/package.ps1 builds.</summary>
    public static string SetupName(Version version, string architecture) => $"Sonus-{version.ToString(3)}-{architecture}-setup.exe";

    private Uri Api => apiBase ?? DefaultApi;

    /// <summary>Published releases, newest first as GitHub lists them (drafts left out).</summary>
    public async Task<IReadOnlyList<AppRelease>> ReleasesAsync(CancellationToken ct = default)
    {
        using var request = Request(new Uri(Api, $"repos/{Repository}/releases?per_page=30"), "application/vnd.github+json");
        using var response = await SendAsync(request, HttpCompletionOption.ResponseContentRead, ct).ConfigureAwait(false);
        string json = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        try { return Parse(json); }
        catch (Exception ex) when (ex is JsonException or InvalidOperationException or KeyNotFoundException or FormatException)
        {
            throw new UpdateException("GitHub 的回复无法识别。", ex);
        }
    }

    internal static IReadOnlyList<AppRelease> Parse(string json)
    {
        using var doc = JsonDocument.Parse(json);
        var releases = new List<AppRelease>();
        foreach (var r in doc.RootElement.EnumerateArray())
        {
            if (r.TryGetProperty("draft", out var draft) && draft.GetBoolean()) continue;
            string tag = r.GetProperty("tag_name").GetString() ?? "";
            if (ParseTag(tag) is not { } version) continue;
            var assets = new List<ReleaseAsset>();
            if (r.TryGetProperty("assets", out var list))
            {
                foreach (var a in list.EnumerateArray())
                {
                    string? digest = a.TryGetProperty("digest", out var d) && d.ValueKind == JsonValueKind.String ? d.GetString() : null;
                    assets.Add(new ReleaseAsset(a.GetProperty("name").GetString() ?? "", a.GetProperty("size").GetInt64(),
                        a.GetProperty("url").GetString() ?? "",
                        digest is not null && digest.StartsWith("sha256:", StringComparison.OrdinalIgnoreCase) ? digest[7..].ToLowerInvariant() : null));
                }
            }
            releases.Add(new AppRelease(tag, version,
                r.TryGetProperty("prerelease", out var pre) && pre.GetBoolean(),
                Text(r, "name") is { Length: > 0 } name ? name : tag,
                Text(r, "body") ?? "",
                r.TryGetProperty("published_at", out var at) && at.ValueKind == JsonValueKind.String ? at.GetDateTime().ToUniversalTime() : default,
                assets));
        }
        return releases;

        static string? Text(JsonElement e, string name) => e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
    }

    /// <summary>"v0.3.0" → 0.3.0; "v0.4.0-beta.1" → 0.4.0; anything else → null.</summary>
    public static Version? ParseTag(string tag)
    {
        string text = tag.TrimStart('v', 'V');
        int cut = text.IndexOfAny(['-', '+']);
        if (cut >= 0) text = text[..cut];
        if (!Version.TryParse(text, out var v)) return null;
        return new Version(v.Major, v.Minor, Math.Max(0, v.Build));
    }

    /// <summary>
    /// The newest release above <paramref name="current"/> that has an installer for <paramref name="architecture"/>;
    /// test versions only when asked for. Null when this app is up to date.
    /// </summary>
    public static AppRelease? Newest(IEnumerable<AppRelease> releases, Version current, bool includePrerelease, string architecture)
    {
        var mine = new Version(current.Major, current.Minor, Math.Max(0, current.Build));
        return releases
            .Where(r => (includePrerelease || !r.IsPrerelease) && r.Version > mine && r.SetupFor(architecture) is not null)
            .OrderByDescending(r => r.Version)
            .ThenBy(r => r.IsPrerelease) // the same numbers released as a final version: that one
            .FirstOrDefault();
    }

    /// <summary>
    /// Downloads <paramref name="asset"/> to <paramref name="path"/> (written next to it, moved in place once checked).
    /// A digest that doesn't match deletes the file and throws.
    /// </summary>
    /// <param name="progress">0–1 as the bytes arrive.</param>
    public async Task DownloadAsync(ReleaseAsset asset, string path, IProgress<double>? progress = null, CancellationToken ct = default)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        string temp = path + ".part";
        try
        {
            // GitHub answers with a redirect to its storage (a signed address)
            using var request = Request(new Uri(asset.ApiUrl), "application/octet-stream");
            using var response = await SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct).ConfigureAwait(false);
            long total = response.Content.Headers.ContentLength ?? asset.Size;
            using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            await using (var input = await response.Content.ReadAsStreamAsync(ct).ConfigureAwait(false))
            await using (var output = File.Create(temp))
            {
                var buffer = new byte[81920];
                long done = 0;
                int read;
                while ((read = await input.ReadAsync(buffer, ct).ConfigureAwait(false)) > 0)
                {
                    await output.WriteAsync(buffer.AsMemory(0, read), ct).ConfigureAwait(false);
                    hash.AppendData(buffer, 0, read);
                    done += read;
                    if (total > 0) progress?.Report(Math.Min(1, (double)done / total));
                }
            }
            string actual = Convert.ToHexStringLower(hash.GetHashAndReset());
            if (asset.Sha256 is { } expected && !string.Equals(expected, actual, StringComparison.Ordinal))
                throw new UpdateException("下载的安装程序校验不一致，已删除，请重试。");
            File.Move(temp, path, overwrite: true);
        }
        catch (HttpRequestException ex) { throw new UpdateException($"下载中断：{ex.Message}", ex); }
        catch (IOException ex) { throw new UpdateException($"无法保存安装程序：{ex.Message}", ex); }
        finally
        {
            try { File.Delete(temp); }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
        }
    }

    private HttpRequestMessage Request(Uri uri, string accept)
    {
        var request = new HttpRequestMessage(HttpMethod.Get, uri);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue(accept));
        request.Headers.TryAddWithoutValidation("X-GitHub-Api-Version", "2022-11-28");
        if (!request.Headers.UserAgent.Any()) request.Headers.UserAgent.ParseAdd("Sonus"); // GitHub refuses requests without one
        return request;
    }

    private async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, HttpCompletionOption completion, CancellationToken ct)
    {
        HttpResponseMessage response;
        try { response = await http.SendAsync(request, completion, ct).ConfigureAwait(false); }
        catch (HttpRequestException ex) { throw new UpdateException($"无法连接到 GitHub：{ex.Message}", ex); }
        catch (TaskCanceledException ex) when (!ct.IsCancellationRequested) { throw new UpdateException("连接 GitHub 超时。", ex); }
        if (response.IsSuccessStatusCode) return response;
        using (response)
        {
            throw new UpdateException(response.StatusCode switch
            {
                HttpStatusCode.Forbidden or HttpStatusCode.TooManyRequests
                    when response.Headers.TryGetValues("X-RateLimit-Remaining", out var left) && left.FirstOrDefault() == "0"
                    => "GitHub 的请求次数暂时用完了（每个网络地址每小时 60 次），请过一会儿再试。",
                HttpStatusCode.NotFound => $"GitHub 上找不到 {Repository} 的版本列表。",
                _ => string.Format(CultureInfo.InvariantCulture, "GitHub 返回 {0}。", (int)response.StatusCode),
            });
        }
    }
}
