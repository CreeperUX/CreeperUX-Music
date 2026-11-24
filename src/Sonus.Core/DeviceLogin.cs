using System.Net.Http.Json;
using System.Text.Json;

namespace Sonus.Core;

/// <summary>A browser sign-in begun: the code to show (and to see again in the browser), the page to open, how often to
/// ask, and until when.</summary>
public sealed record DeviceLoginStart(string Server, string DeviceCode, string UserCode, Uri VerificationUrl, TimeSpan Interval, DateTimeOffset Expires);

public enum DeviceLoginState { Pending, Approved, Denied, Expired }

/// <summary>
/// Signing in through the browser (the CreeperUX/navidrome fork's sonusDeviceLogin, as OAuth's device authorization
/// grant): the app asks the server for a sign-in, opens its approval page, where the user signs in (with two-step
/// verification) and allows this app, and then gets an API key of its own: OpenSubsonic apiKeyAuthentication. The app
/// never sees the account password; the key is listed among the user's app passwords, where it can be revoked, and the
/// app gives it back when it signs out.
/// </summary>
public static class DeviceLogin
{
    public const string Extension = "sonusDeviceLogin";

    private static HttpClient Http(HttpClient? http) => http ?? SubsonicClient.Shared;

    /// <summary>The server's address as it answers (a private host typed without a scheme over HTTP, else HTTPS, as
    /// <see cref="SubsonicClient.SignInAsync"/>), and whether it offers the browser sign-in. Asked without signing in:
    /// getOpenSubsonicExtensions is public.</summary>
    public static async Task<(string Server, bool Supported)> ProbeAsync(string server, HttpClient? http = null, CancellationToken cancel = default)
    {
        string baseUrl = SubsonicClient.NormalizeServer(server);
        if (baseUrl.Length == 0) throw new ArgumentException("请填写服务器地址。");
        var candidates = new List<string> { baseUrl };
        if (!server.Trim().StartsWith("http", StringComparison.OrdinalIgnoreCase) && baseUrl.StartsWith("http://", StringComparison.Ordinal))
            candidates.Add("https://" + baseUrl["http://".Length..]);
        Exception? last = null;
        foreach (string candidate in candidates)
        {
            try
            {
                using var res = await Http(http).GetAsync($"{candidate}/rest/getOpenSubsonicExtensions.view?v={SubsonicClient.ApiVersion}&c=Sonus&f=json", cancel).ConfigureAwait(false);
                if (!res.IsSuccessStatusCode) { last = new ServerUnreachableException($"{candidate} 返回了 {(int)res.StatusCode}。"); continue; }
                using var doc = JsonDocument.Parse(await res.Content.ReadAsStreamAsync(cancel).ConfigureAwait(false));
                if (!doc.RootElement.TryGetProperty("subsonic-response", out var body)) { last = new ServerUnreachableException($"{candidate} 不像是 Navidrome。"); continue; }
                bool supported = SubsonicClient.Array(body, "openSubsonicExtensions").Any(x => SubsonicClient.Str(x, "name") == Extension);
                return (candidate, supported);
            }
            catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException && !cancel.IsCancellationRequested)
            {
                last = ex;
            }
        }
        throw new ServerUnreachableException($"连不上 {baseUrl}。检查地址和网络。", last);
    }

    /// <summary>Asks the server for a browser sign-in for this app (client "Sonus") on this computer (device).</summary>
    public static async Task<DeviceLoginStart> StartAsync(string server, string client, string device, HttpClient? http = null, CancellationToken cancel = default)
    {
        using var res = await Http(http).PostAsJsonAsync($"{server}/auth/device/start", new { client, device }, cancel).ConfigureAwait(false);
        if (!res.IsSuccessStatusCode) throw new SubsonicException(0, $"服务器没有开始登录（{(int)res.StatusCode}）。") { HttpStatus = (int)res.StatusCode };
        using var doc = JsonDocument.Parse(await res.Content.ReadAsStreamAsync(cancel).ConfigureAwait(false));
        var r = doc.RootElement;
        string path = SubsonicClient.Str(r, "verificationPath") ?? "/app/#/device";
        return new DeviceLoginStart(
            server,
            SubsonicClient.Str(r, "deviceCode") ?? throw new JsonException("no deviceCode"),
            SubsonicClient.Str(r, "userCode") ?? throw new JsonException("no userCode"),
            new Uri(new Uri(server), path), // the path carries the server's base path: it replaces the one in server
            TimeSpan.FromSeconds(Math.Max(1, SubsonicClient.Int(r, "interval"))),
            DateTimeOffset.UtcNow.AddSeconds(Math.Max(30, SubsonicClient.Int(r, "expiresIn"))));
    }

    /// <summary>How the sign-in stands now; approved, it is the sign-in to keep.</summary>
    public static async Task<(DeviceLoginState State, Login? Login)> PollAsync(DeviceLoginStart start, HttpClient? http = null, CancellationToken cancel = default)
    {
        using var res = await Http(http).PostAsJsonAsync($"{start.Server}/auth/device/poll", new { deviceCode = start.DeviceCode }, cancel).ConfigureAwait(false);
        if (!res.IsSuccessStatusCode) return (DeviceLoginState.Pending, null); // asked again next time
        using var doc = JsonDocument.Parse(await res.Content.ReadAsStreamAsync(cancel).ConfigureAwait(false));
        var r = doc.RootElement;
        return SubsonicClient.Str(r, "status") switch
        {
            "approved" when SubsonicClient.Str(r, "apiKey") is { Length: > 0 } key =>
                (DeviceLoginState.Approved, Login.WithApiKey(start.Server, SubsonicClient.Str(r, "username") ?? "", key)),
            "denied" => (DeviceLoginState.Denied, null),
            "expired" => (DeviceLoginState.Expired, null),
            _ => (DeviceLoginState.Pending, null),
        };
    }

    /// <summary>Asks until the user decided or the sign-in expired. A network hiccup is asked again, not given up on.</summary>
    public static async Task<(DeviceLoginState State, Login? Login)> WaitAsync(DeviceLoginStart start, HttpClient? http = null, CancellationToken cancel = default)
    {
        while (DateTimeOffset.UtcNow < start.Expires)
        {
            await Task.Delay(start.Interval, cancel).ConfigureAwait(false);
            try
            {
                var result = await PollAsync(start, http, cancel).ConfigureAwait(false);
                if (result.State != DeviceLoginState.Pending) return result;
            }
            catch (Exception ex) when (ex is HttpRequestException or JsonException || ex is TaskCanceledException && !cancel.IsCancellationRequested)
            {
                // unreachable for a moment: ask again
            }
        }
        return (DeviceLoginState.Expired, null);
    }

    /// <summary>Gives the app's API key back to the server (signing out): it stops working there at once. Best effort:
    /// false when the server could not be told (the user can still revoke it from the web).</summary>
    public static async Task<bool> RevokeAsync(Login login, HttpClient? http = null, CancellationToken cancel = default)
    {
        if (!login.IsApiKey) return false;
        try
        {
            using var res = await Http(http).PostAsJsonAsync($"{login.Server}/auth/device/revoke", new { apiKey = login.ApiKey }, cancel).ConfigureAwait(false);
            return res.IsSuccessStatusCode;
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException) { return false; }
    }
}
