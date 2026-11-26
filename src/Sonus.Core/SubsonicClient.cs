using System.Globalization;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Sonus.Core;

/// <summary>The sign-in kept between runs: the server, the user, and either the token (md5(password + salt)) with its
/// salt, or an API key (the browser sign-in, <see cref="DeviceLogin"/>: OpenSubsonic apiKeyAuthentication, a key of
/// this app's own that the user can revoke). The password itself is never kept. Token and key work like the password for
/// this API, so they are secrets.</summary>
public sealed record Login(string Server, string User, string Salt, string Token, string? ApiKey = null)
{
    /// <summary>Signed in through the browser: requests carry the API key alone.</summary>
    public bool IsApiKey => !string.IsNullOrEmpty(ApiKey);

    public static Login WithApiKey(string server, string user, string apiKey) => new(server, user, "", "", apiKey);

    public string ToJson() => JsonSerializer.Serialize(IsApiKey
        ? new Dictionary<string, string> { ["server"] = Server, ["user"] = User, ["apiKey"] = ApiKey! }
        : new Dictionary<string, string> { ["server"] = Server, ["user"] = User, ["salt"] = Salt, ["token"] = Token });

    public static Login? FromJson(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return null;
        try
        {
            using var doc = JsonDocument.Parse(json);
            string? Get(string k) => doc.RootElement.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
            if (Get("server") is { Length: > 0 } server && Get("apiKey") is { Length: > 0 } key) return WithApiKey(server, Get("user") ?? "", key);
            return Get("server") is { Length: > 0 } s && Get("user") is { Length: > 0 } u && Get("salt") is { Length: > 0 } salt && Get("token") is { Length: > 0 } t ? new Login(s, u, salt, t) : null;
        }
        catch (JsonException) { return null; }
    }

    // a record prints its properties: never the secrets, should one end up in a log
    public override string ToString() => $"Login {{ Server = {Server}, User = {User}{(IsApiKey ? ", by API key" : "")} }}";
}

/// <summary>The server answered with a Subsonic error (wrong password, not found, not allowed …).</summary>
public sealed class SubsonicException(int code, string message) : Exception(message)
{
    public int Code { get; } = code;
    /// <summary>The HTTP status when the request failed before any Subsonic answer (404, 502 …); 0 otherwise.</summary>
    public int HttpStatus { get; init; }
    public bool IsAuthentication => Code is 40 or 41;
}

/// <summary>The server could not be reached at all.</summary>
public sealed class ServerUnreachableException(string message, Exception? inner = null) : Exception(message, inner);

/// <summary>
/// A client for Navidrome or any server speaking the Subsonic API with the OpenSubsonic extensions
/// (subsonic.org/pages/api.jsp, opensubsonic.netlify.app). Token authentication; JSON answers; writes are POSTed as forms.
/// Every await is ConfigureAwait(false): answers (a few thousand songs) are parsed on the thread pool, never on the
/// caller's UI thread; callbacks given to it (remember) may run on any thread.
/// </summary>
public sealed class SubsonicClient
{
    public const string ApiVersion = "1.16.1";
    private const int Page = 500;
    internal static readonly HttpClient Shared = new(new SocketsHttpHandler { PooledConnectionLifetime = TimeSpan.FromMinutes(5), AutomaticDecompression = DecompressionMethods.All }) { Timeout = TimeSpan.FromSeconds(30) };

    private static readonly Dictionary<int, string> Errors = new()
    {
        [10] = "请求缺少必要的参数。", [20] = "服务器的 Subsonic API 版本太旧。", [30] = "Sonus 需要更新才能连接这个服务器。",
        [40] = "用户名或密码不正确。", [41] = "这个账号不能用 token 登录（例如 LDAP 账号）。", [50] = "这个账号没有执行这个操作的权限。", [70] = "服务器上找不到这项内容。",
    };

    private readonly HttpClient _http;
    private bool _online = true;

    public SubsonicClient(Login login, string clientName, HttpClient? http = null)
    {
        _login = login; ClientName = clientName; _http = http ?? Shared;
    }

    /// <summary>The sign-in. Its server is the address the server answers at: when a request is redirected to another
    /// (http:// to https://, a moved host), that one from then on, for every request, the streams and covers too.</summary>
    public Login Login { get => Volatile.Read(ref _login); private set => Volatile.Write(ref _login, value); }
    private Login _login;
    /// <summary>What the server lists this client as (Navidrome: Players, and who saved the play queue).</summary>
    public string ClientName { get; }
    public HashSet<string> Extensions { get; } = [];
    /// <summary>The versions of each OpenSubsonic extension the server offers (Sonus Connect: 1, 2).</summary>
    public Dictionary<string, IReadOnlyList<int>> ExtensionVersions { get; } = [];
    public bool IsOnline => _online;

    /// <summary>Reachable / not reachable, as the last request found it.</summary>
    public event EventHandler<bool>? ConnectionChanged;

    // ---------------------------------------------------------------- signing in

    /// <summary>"music.example.com", "http://host:4533/", "https://host/rest" → "https://music.example.com", "http://host:4533", "https://host".
    /// Typed without http:// or https://, a private host (<see cref="IsPrivateHost"/>), where Navidrome is usually reached
    /// directly, gets HTTP; any other gets HTTPS.</summary>
    public static string NormalizeServer(string? input)
    {
        string s = (input ?? "").Trim();
        if (s.Length == 0) return "";
        if (!HasScheme(s)) s = (IsPrivateHost(HostOf("http://" + s)) ? "http://" : "https://") + s;
        s = s.TrimEnd('/');
        return Regex.Replace(s, @"/(rest|app)(/.*)?$", "", RegexOptions.IgnoreCase);
    }

    private static bool HasScheme(string s) => Regex.IsMatch(s, "^https?://", RegexOptions.IgnoreCase);
    private static string HostOf(string url) => Uri.TryCreate(url, UriKind.Absolute, out var u) ? u.Host : "";
    private static readonly string[] PrivateSuffixes = [".localhost", ".local", ".lan", ".home.arpa", ".internal", ".ts.net"];

    /// <summary>
    /// A host whose traffic stays off the open internet: this machine; the local network (10/8, 172.16/12, 192.168/16,
    /// link-local, IPv6 unique-local, a name without a dot, .local, .lan, .home.arpa, .internal); or a Tailscale tailnet
    /// (100.64/10, its IPv6 addresses, which are unique-local, and .ts.net names), where WireGuard encrypts everything.
    /// </summary>
    public static bool IsPrivateHost(string? host)
    {
        string h = (host ?? "").Trim().TrimStart('[').TrimEnd(']').TrimEnd('.').ToLowerInvariant();
        if (h.Length == 0) return false;
        if (IPAddress.TryParse(h, out var ip))
        {
            if (ip.IsIPv4MappedToIPv6) ip = ip.MapToIPv4();
            if (IPAddress.IsLoopback(ip)) return true;
            if (ip.AddressFamily == System.Net.Sockets.AddressFamily.InterNetworkV6) return ip.IsIPv6LinkLocal || ip.IsIPv6UniqueLocal || ip.IsIPv6SiteLocal;
            byte[] b = ip.GetAddressBytes();
            return b[0] == 10 || (b[0] == 172 && b[1] is >= 16 and <= 31) || (b[0] == 192 && b[1] == 168) || (b[0] == 169 && b[1] == 254) || (b[0] == 100 && b[1] is >= 64 and <= 127);
        }
        return !h.Contains('.') || PrivateSuffixes.Any(h.EndsWith);
    }

    /// <summary>Plain HTTP to a host on the internet: the sign-in token, which works like the password, would cross the
    /// internet readable in every request.</summary>
    public static bool IsPlainOverInternet(string? server)
    {
        string s = NormalizeServer(server);
        return s.StartsWith("http://", StringComparison.OrdinalIgnoreCase) && HostOf(s) is { Length: > 0 } host && !IsPrivateHost(host);
    }

    public static string Md5Hex(string text) => Convert.ToHexStringLower(MD5.HashData(Encoding.UTF8.GetBytes(text)));

    /// <summary>Checks the server and the account; returns the sign-in to keep (not the password). A private host typed
    /// without a scheme is tried over HTTP, then over HTTPS if nothing Subsonic answers there (a NAS or a tailnet name
    /// may serve either).</summary>
    public static async Task<Login> SignInAsync(string server, string user, string password, string clientName, HttpClient? http = null, CancellationToken cancel = default)
    {
        string baseUrl = NormalizeServer(server);
        if (baseUrl.Length == 0) throw new ArgumentException("请填写服务器地址。");
        if (string.IsNullOrWhiteSpace(user)) throw new ArgumentException("请填写用户名。");
        string? secure = !HasScheme(server.Trim()) && baseUrl.StartsWith("http://", StringComparison.Ordinal) ? "https://" + baseUrl["http://".Length..] : null;
        try { return await TrySignInAsync(baseUrl, user, password, clientName, http, cancel).ConfigureAwait(false); }
        catch (Exception first) when (secure is not null && first is ServerUnreachableException or SubsonicException { HttpStatus: > 0 })
        {
            try { return await TrySignInAsync(secure, user, password, clientName, http, cancel).ConfigureAwait(false); }
            catch (Exception second) when (second is ServerUnreachableException or SubsonicException { HttpStatus: > 0 })
            {
                throw new ServerUnreachableException($"连不上 {baseUrl}，也连不上 {secure}。检查地址和网络。", second);
            }
        }
    }

    private static async Task<Login> TrySignInAsync(string baseUrl, string user, string password, string clientName, HttpClient? http, CancellationToken cancel)
    {
        string salt = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(8));
        var login = new Login(baseUrl, user.Trim(), salt, Md5Hex(password + salt));
        var client = new SubsonicClient(login, clientName, http);
        try { await client.CallAsync("ping", null, cancel: cancel).ConfigureAwait(false); }
        catch (ServerUnreachableException) { throw new ServerUnreachableException($"连不上 {baseUrl}。检查地址和网络；服务器在外网时需要 HTTPS。"); }
        catch (JsonException) { throw new ServerUnreachableException($"{baseUrl} 不像是 Navidrome（没有 Subsonic API 的回应）。"); }
        return client.Login; // at the address the server answered at, when it redirected
    }

    // ---------------------------------------------------------------- requests

    private List<KeyValuePair<string, string>> Params(IEnumerable<KeyValuePair<string, object?>>? extra)
    {
        // an API key signs alone (apiKeyAuthentication: u= alongside it is an error)
        var p = Login.IsApiKey
            ? new List<KeyValuePair<string, string>> { new("apiKey", Login.ApiKey!), new("v", ApiVersion), new("c", ClientName), new("f", "json") }
            : new List<KeyValuePair<string, string>>
            {
                new("u", Login.User), new("t", Login.Token), new("s", Login.Salt), new("v", ApiVersion), new("c", ClientName), new("f", "json"),
            };
        foreach (var (k, v) in extra ?? [])
        {
            switch (v)
            {
                case null: break;
                case string s: p.Add(new(k, s)); break;
                case IEnumerable<string> list: p.AddRange(list.Select(x => new KeyValuePair<string, string>(k, x))); break;
                case IEnumerable<int> list: p.AddRange(list.Select(x => new KeyValuePair<string, string>(k, x.ToString(CultureInfo.InvariantCulture)))); break;
                case bool b: p.Add(new(k, b ? "true" : "false")); break;
                case IFormattable f: p.Add(new(k, f.ToString(null, CultureInfo.InvariantCulture))); break;
                default: p.Add(new(k, v.ToString() ?? "")); break;
            }
        }
        return p;
    }

    private static string Query(IEnumerable<KeyValuePair<string, string>> p) =>
        string.Join("&", p.Select(x => $"{Uri.EscapeDataString(x.Key)}={Uri.EscapeDataString(x.Value)}"));

    private static IEnumerable<KeyValuePair<string, object?>> P(params (string Key, object? Value)[] items) => items.Select(x => new KeyValuePair<string, object?>(x.Key, x.Value));

    /// <summary>A URL with the sign-in in it (stream, cover art): the same every time for the same arguments.</summary>
    public string Url(string method, params (string Key, object? Value)[] extra) => $"{Login.Server}/rest/{method}.view?{Query(Params(P(extra)))}";

    private void SetOnline(bool online)
    {
        if (_online == online) return;
        _online = online;
        ConnectionChanged?.Invoke(this, online);
    }

    /// <summary>Told about every request that took 500 ms or more ("getPlaylist 812 ms"), for the app's log.</summary>
    public static Action<string>? Slow { get; set; }

    internal async Task<JsonElement> CallAsync(string method, IEnumerable<KeyValuePair<string, object?>>? extra, bool post = false, CancellationToken cancel = default)
    {
        long started = System.Diagnostics.Stopwatch.GetTimestamp();
        try { return await CallOnceAsync(method, extra, post, cancel).ConfigureAwait(false); }
        finally
        {
            var took = System.Diagnostics.Stopwatch.GetElapsedTime(started);
            if (took.TotalMilliseconds >= 500) Slow?.Invoke($"{method} {took.TotalMilliseconds:0} ms");
        }
    }

    private async Task<JsonElement> CallOnceAsync(string method, IEnumerable<KeyValuePair<string, object?>>? extra, bool post, CancellationToken cancel)
    {
        HttpResponseMessage res;
        string url;
        var parameters = Params(extra);
        post = post && Extensions.Contains("formPost"); // a server that does not say it reads POSTed forms gets GET
        try
        {
            url = $"{Login.Server}/rest/{method}.view";
            // a POST stays a POST through a redirect (HttpClient would send it on as a GET without the form)
            res = post
                ? await Redirects.PostAsync(_http, url, () => new FormUrlEncodedContent(parameters), cancel).ConfigureAwait(false)
                : await _http.GetAsync($"{url}?{Query(parameters)}", cancel).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancel.IsCancellationRequested) { throw; }
        catch (RedirectRefusedException ex) { throw new SubsonicException(0, ex.Message); }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
        {
            SetOnline(false);
            throw new ServerUnreachableException("无法连接到音乐服务器。检查网络，然后重新连接。", ex);
        }
        using (res)
        {
            if (!res.IsSuccessStatusCode) throw new SubsonicException(0, $"服务器返回了 {(int)res.StatusCode} {res.ReasonPhrase}。") { HttpStatus = (int)res.StatusCode };
            using var doc = JsonDocument.Parse(await res.Content.ReadAsStreamAsync(cancel).ConfigureAwait(false));
            if (!doc.RootElement.TryGetProperty("subsonic-response", out var body)) throw new JsonException("not a Subsonic answer");
            // redirected: the address it led to is the server's from now on
            if (Redirects.MovedBase(new Uri(url), res.RequestMessage?.RequestUri, $"/rest/{method}.view") is { } moved) Login = Login with { Server = moved };
            SetOnline(true);
            if (Str(body, "status") != "ok")
            {
                var e = body.TryGetProperty("error", out var err) ? err : default;
                int code = e.ValueKind == JsonValueKind.Object ? Int(e, "code") : 0;
                throw new SubsonicException(code, Errors.GetValueOrDefault(code) ?? Str(e, "message") ?? "服务器拒绝了请求。");
            }
            return body.Clone();
        }
    }

    // ---------------------------------------------------------------- JSON helpers
    internal static string? Str(JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) ? v.ValueKind switch { JsonValueKind.String => v.GetString(), JsonValueKind.Number => v.GetRawText(), _ => null } : null;
    internal static int Int(JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetDouble(out var d) ? (int)d : 0;
    internal static double Num(JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetDouble(out var d) ? d : 0;
    internal static double? NumOrNull(JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetDouble(out var d) ? d : null;
    internal static bool Bool(JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.True;
    internal static DateTimeOffset? Date(JsonElement e, string name) =>
        Str(e, name) is { } s && DateTimeOffset.TryParse(s, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var d) ? d : null;
    internal static IEnumerable<JsonElement> Array(JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Array ? v.EnumerateArray() : [];
    internal static JsonElement Obj(JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Object ? v : default;

    // ---------------------------------------------------------------- the server and the library

    public async Task<ServerInfo> ConnectAsync(CancellationToken cancel = default)
    {
        var r = await CallAsync("ping", null, cancel: cancel).ConfigureAwait(false);
        try
        {
            var ext = await CallAsync("getOpenSubsonicExtensions", null, cancel: cancel).ConfigureAwait(false);
            foreach (var x in Array(ext, "openSubsonicExtensions"))
            {
                if (Str(x, "name") is not { } n) continue;
                Extensions.Add(n);
                ExtensionVersions[n] = Array(x, "versions").Where(v => v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out _)).Select(v => v.GetInt32()).ToList();
            }
        }
        catch (SubsonicException) { /* plain Subsonic */ }
        string type = Str(r, "type") ?? "";
        string name = type == "navidrome" ? "Navidrome" : type.Length > 0 ? char.ToUpperInvariant(type[0]) + type[1..] : "Subsonic";
        return new ServerInfo(name, $"{name} {Str(r, "serverVersion")}".Trim(), Str(r, "version") ?? ApiVersion, Bool(r, "openSubsonic"));
    }

    /// <summary>
    /// Every page of a list, in order. 500 are asked for per page; a server that gives fewer (some cap it) has its own page
    /// size, learnt from the first two answers. Then three pages are asked for at a time (a remote server's round trips add
    /// up: a library of 2,400 songs is five pages); it ends at the first page that is not full.
    /// </summary>
    private async Task<List<JsonElement>> PagedAsync(string method, string key, string sub, Func<int, IEnumerable<KeyValuePair<string, object?>>> extra, CancellationToken cancel)
    {
        async Task<List<JsonElement>> At(int offset) => Array(Obj(await CallAsync(method, extra(offset), cancel: cancel).ConfigureAwait(false), key), sub).ToList();
        var all = await At(0).ConfigureAwait(false);
        int size = all.Count, offset = size;
        if (size == 0) return all;
        if (size < Page)
        {
            // the whole list, or a server's own page size: the next page tells
            var next = await At(offset).ConfigureAwait(false);
            all.AddRange(next);
            if (next.Count < size) return all;
            offset += next.Count;
        }
        const int together = 3;
        for (; ; offset += size * together)
        {
            int from = offset;
            var pages = await Task.WhenAll(Enumerable.Range(0, together).Select(i => At(from + i * size))).ConfigureAwait(false);
            foreach (var page in pages)
            {
                all.AddRange(page);
                if (page.Count < size) return all;
            }
        }
    }

    /// <summary>Every album and song. Songs come from search3 with an empty query (paged); a server that needs words
    /// there is read album by album instead.</summary>
    public async Task<LibrarySnapshot> LoadLibraryAsync(CancellationToken cancel = default)
    {
        // albums and songs at the same time
        var albumPages = PagedAsync("getAlbumList2", "albumList2", "album", o => P(("type", "alphabeticalByName"), ("size", Page), ("offset", o)), cancel);
        var songPages = PagedAsync("search3", "searchResult3", "song", o => P(("query", ""), ("songCount", Page), ("songOffset", o), ("albumCount", 0), ("artistCount", 0)), cancel);
        var albums = await albumPages.ConfigureAwait(false);
        var songs = await songPages.ConfigureAwait(false);
        if (songs.Count == 0 && albums.Count > 0)
            foreach (var a in albums)
                songs.AddRange(Array(Obj(await CallAsync("getAlbum", P(("id", Str(a, "id"))), cancel: cancel).ConfigureAwait(false), "album"), "song"));
        return LibraryBuilder.Build(albums, songs);
    }

    /// <summary>The number of songs the server has (to notice a rescan), or null when it does not say.</summary>
    public async Task<int?> SongCountAsync(CancellationToken cancel = default)
    {
        try { var s = Obj(await CallAsync("getScanStatus", null, cancel: cancel).ConfigureAwait(false), "scanStatus"); return s.ValueKind == JsonValueKind.Object && s.TryGetProperty("count", out _) ? Int(s, "count") : null; }
        catch (SubsonicException) { return null; }
    }

    // ---------------------------------------------------------------- playlists
    public async Task<List<Playlist>> GetPlaylistsAsync(Func<JsonElement, string> remember, CancellationToken cancel = default)
    {
        var list = Array(Obj(await CallAsync("getPlaylists", null, cancel: cancel).ConfigureAwait(false), "playlists"), "playlist").ToList();
        var result = new Playlist[list.Count];
        var gate = new SemaphoreSlim(4);
        await Task.WhenAll(list.Select(async (p, i) =>
        {
            await gate.WaitAsync(cancel).ConfigureAwait(false);
            try
            {
                var d = Obj(await CallAsync("getPlaylist", P(("id", Str(p, "id"))), cancel: cancel).ConfigureAwait(false), "playlist");
                string owner = Str(p, "owner") ?? Login.User;
                result[i] = new Playlist
                {
                    Id = Str(p, "id")!, Name = Str(p, "name") ?? "", Owner = owner, Comment = Str(p, "comment"),
                    Kind = Bool(p, "readonly") || !owner.Equals(Login.User, StringComparison.OrdinalIgnoreCase) ? PlaylistKind.ReadOnly : PlaylistKind.User,
                    Changed = Date(p, "changed") ?? DateTimeOffset.Now,
                    Entries = Array(d, "entry").Select(remember).ToList(),
                };
            }
            finally { gate.Release(); }
        })).ConfigureAwait(false);
        return result.ToList();
    }

    /// <summary>A new playlist; its id (an older server answers without the playlist: null).</summary>
    public async Task<string?> CreatePlaylistAsync(string name, IReadOnlyList<string> songIds, CancellationToken cancel = default) =>
        Str(Obj(await CallAsync("createPlaylist", P(("name", name), ("songId", songIds)), post: true, cancel: cancel).ConfigureAwait(false), "playlist"), "id");

    /// <summary>Replaces a playlist's songs (the only way the API has to reorder one).</summary>
    public Task OverwritePlaylistAsync(string id, IReadOnlyList<string> songIds, CancellationToken cancel = default) =>
        CallAsync("createPlaylist", P(("playlistId", id), ("songId", songIds)), post: true, cancel: cancel);

    public Task UpdatePlaylistAsync(string id, string? name = null, IReadOnlyList<string>? add = null, IReadOnlyList<int>? removeIndexes = null, CancellationToken cancel = default) =>
        CallAsync("updatePlaylist", P(("playlistId", id), ("name", name), ("songIdToAdd", add), ("songIndexToRemove", removeIndexes)), post: true, cancel: cancel);

    public Task DeletePlaylistAsync(string id, CancellationToken cancel = default) => CallAsync("deletePlaylist", P(("id", id)), post: true, cancel: cancel);

    // ---------------------------------------------------------------- likes, plays, search
    public Task SetStarredAsync(string songId, bool starred, CancellationToken cancel = default) =>
        CallAsync(starred ? "star" : "unstar", P(("id", songId)), post: true, cancel: cancel);

    /// <summary>"Now playing" (submission false), or one counted play (true) started at <paramref name="startedAt"/>.</summary>
    public Task ScrobbleAsync(string songId, bool submission, DateTimeOffset? startedAt = null, CancellationToken cancel = default) =>
        CallAsync("scrobble", P(("id", songId), ("submission", submission), ("time", startedAt?.ToUnixTimeMilliseconds())), post: true, cancel: cancel);

    public async Task<SearchResult> SearchAsync(string query, CancellationToken cancel = default)
    {
        var r = Obj(await CallAsync("search3", P(("query", query), ("songCount", 200), ("albumCount", 60), ("artistCount", 30)), cancel: cancel).ConfigureAwait(false), "searchResult3");
        List<string> Ids(string k) => Array(r, k).Select(x => Str(x, "id")).OfType<string>().ToList();
        return new SearchResult(Ids("song"), Ids("album"), Ids("artist"));
    }

    // ---------------------------------------------------------------- lyrics, radio, artist information
    public async Task<IReadOnlyList<LyricLine>?> LyricsAsync(Track t, CancellationToken cancel = default)
    {
        if (Extensions.Contains("songLyrics"))
        {
            try
            {
                var list = Array(Obj(await CallAsync("getLyricsBySongId", P(("id", t.Id)), cancel: cancel).ConfigureAwait(false), "lyricsList"), "structuredLyrics").ToList();
                var pick = list.FirstOrDefault(l => Bool(l, "synced") && Array(l, "line").Any());
                if (pick.ValueKind != JsonValueKind.Object) pick = list.FirstOrDefault(l => Array(l, "line").Any());
                if (pick.ValueKind == JsonValueKind.Object)
                {
                    bool synced = Bool(pick, "synced");
                    // OpenSubsonic: a positive offset shows the lyrics sooner
                    double offset = Num(pick, "offset") / 1000;
                    return Array(pick, "line").Select(l => new LyricLine(synced ? Math.Max(0, Num(l, "start") / 1000 - offset) : null, Str(l, "value") ?? "")).ToList();
                }
            }
            catch (SubsonicException) { /* fall back to getLyrics */ }
        }
        try
        {
            var r = Obj(await CallAsync("getLyrics", P(("artist", t.Artist), ("title", t.Title)), cancel: cancel).ConfigureAwait(false), "lyrics");
            return LyricsParser.Parse(Str(r, "value"));
        }
        catch (SubsonicException) { return null; }
    }

    /// <summary>Songs similar to one (getSimilarSongs2: needs Last.fm on the server); unknown songs are remembered.</summary>
    public async Task<List<string>> SimilarSongsAsync(string songId, Func<JsonElement, string> remember, CancellationToken cancel = default)
    {
        try { return Array(Obj(await CallAsync("getSimilarSongs2", P(("id", songId), ("count", 50)), cancel: cancel).ConfigureAwait(false), "similarSongs2"), "song").Select(remember).ToList(); }
        catch (SubsonicException) { return []; }
    }

    public async Task<ArtistInfo?> ArtistInfoAsync(string artistId, CancellationToken cancel = default)
    {
        try
        {
            var r = Obj(await CallAsync("getArtistInfo2", P(("id", artistId)), cancel: cancel).ConfigureAwait(false), "artistInfo2");
            string bio = Regex.Replace(Str(r, "biography") ?? "", @"<a\b[^>]*>[\s\S]*?</a>\.?", "", RegexOptions.IgnoreCase);
            bio = WebUtility.HtmlDecode(Regex.Replace(bio, "<[^>]+>", "")).Trim();
            string? url = Str(r, "lastFmUrl");
            return bio.Length > 0 || url is not null ? new ArtistInfo(bio, url) : null;
        }
        catch (SubsonicException) { return null; }
    }

    // ---------------------------------------------------------------- the play queue on the server (continue on another device)
    public Task SavePlayQueueAsync(IReadOnlyList<string> ids, string current, double positionSeconds, CancellationToken cancel = default) =>
        CallAsync("savePlayQueue", P(("id", ids), ("current", current), ("position", (long)(positionSeconds * 1000))), post: true, cancel: cancel);

    public async Task<RemoteQueue?> GetPlayQueueAsync(Func<JsonElement, string> remember, CancellationToken cancel = default)
    {
        var q = Obj(await CallAsync("getPlayQueue", null, cancel: cancel).ConfigureAwait(false), "playQueue");
        var entries = Array(q, "entry").Select(remember).ToList();
        if (entries.Count == 0 || Str(q, "current") is not { } current) return null;
        return new RemoteQueue(entries, current, Num(q, "position") / 1000, Date(q, "changed") ?? DateTimeOffset.MinValue, Str(q, "changedBy") ?? "");
    }

    // ---------------------------------------------------------------- media
    /// <summary>The cover at a size: the URL is the same every time (a fixed salt), so caches keep it.</summary>
    public string CoverUrl(string coverArt, int size = 600) => Url("getCoverArt", ("id", coverArt), ("size", size));

    /// <summary>The song's audio; <paramref name="transcodeTo"/> asks the server to convert it (e.g. "mp3").</summary>
    public string StreamUrl(string songId, string? transcodeTo = null) =>
        transcodeTo is null ? Url("stream", ("id", songId)) : Url("stream", ("id", songId), ("format", transcodeTo), ("maxBitRate", 320));
}
