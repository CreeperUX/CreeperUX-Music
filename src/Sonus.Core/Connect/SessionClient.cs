using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace Sonus.Core.Connect;

/// <summary>The song a session plays: the queue entry it was when it became current (its key, kept while it plays), the
/// song, and whether it was queued by hand.</summary>
public sealed record SessionCurrent(string Key, string TrackId, bool Manual);

/// <summary>What any device shows of the current song without looking it up.</summary>
public sealed record SessionNow(string? Title, string? Artist, string? Album, string? AlbumId, string? CoverArt);

public sealed record SessionDeviceRef(string Id, string Name);

/// <summary>
/// The user's one playback session (docs/protocol/connect.md, Session), as the server holds it: what plays, where, the
/// position at the server's time <see cref="At"/>, the order. The server is its only source of truth.
/// </summary>
public sealed record PlaybackSession
{
    public long Rev { get; init; }
    /// <summary>The device that plays; null: nothing plays (rules 6, 7).</summary>
    public string? ActiveDevice { get; init; }
    /// <summary>The device that played last (while one plays: that one).</summary>
    public SessionDeviceRef? LastDevice { get; init; }
    public SessionCurrent? Current { get; init; }
    /// <summary>What follows when the current song ends, to preload; null when that is not known.</summary>
    public string? Next { get; init; }
    public bool Playing { get; init; }
    public long PositionMs { get; init; }
    public long At { get; init; }
    public long DurationMs { get; init; }
    public SessionNow? Now { get; init; }
    public string Mode { get; init; } = "default";
    public bool StopAfterCurrent { get; init; }
    public ConnectContext? Context { get; init; }
    public long QueueRev { get; init; }

    /// <summary>The position at the server's time <paramref name="serverNow"/> (it moves on while playing).</summary>
    public long PositionAt(long serverNow)
    {
        long p = Playing ? PositionMs + Math.Max(0, serverNow - At) : PositionMs;
        return DurationMs > 0 ? Math.Min(p, DurationMs) : p;
    }
}

public sealed record SessionManual(string Key, string TrackId);

/// <summary>The session's queue: the context in playback order, the pointer to its current song, the songs queued by hand.</summary>
public sealed record SessionQueue(long QueueRev, IReadOnlyList<string> Order, int Pointer, IReadOnlyList<SessionManual> Manual)
{
    public static readonly SessionQueue Empty = new(0, [], -1, []);
}

/// <summary>One of the user's connected devices (this one included).</summary>
public sealed record SessionDevice(string Id, string Name, string Kind, string Client, bool CanPlay, long ConnectedAt, double Volume, bool Muted);

/// <summary>What a device that was active and kept playing through a network loss says when it reconnects.</summary>
public sealed record SessionResume(long Rev, bool Playing, long PositionMs);

/// <summary>The server's answer to a message: applied (the session's rev then), or an error code and message.</summary>
public sealed record SessionReply(bool Ok, long Rev, string? Code = null, string? Message = null);

/// <summary>The protocol's names of the playback orders.</summary>
public static class SessionModes
{
    public static string Of(PlaybackOrder order) => order switch
    {
        PlaybackOrder.RepeatPlaylist => "repeatAll", PlaybackOrder.RepeatTrack => "repeatOne", PlaybackOrder.Random => "random",
        PlaybackOrder.ShuffleTracks => "shuffleTracks", PlaybackOrder.ShuffleAlbums => "shuffleAlbums", PlaybackOrder.ShuffleFolders => "shuffleFolders",
        _ => "default",
    };

    public static PlaybackOrder Parse(string? mode) => mode switch
    {
        "repeatAll" => PlaybackOrder.RepeatPlaylist, "repeatOne" => PlaybackOrder.RepeatTrack, "random" => PlaybackOrder.Random,
        "shuffleTracks" => PlaybackOrder.ShuffleTracks, "shuffleAlbums" => PlaybackOrder.ShuffleAlbums, "shuffleFolders" => PlaybackOrder.ShuffleFolders,
        _ => PlaybackOrder.Default,
    };

    /// <summary>At most <paramref name="limit"/> songs of a context (the protocol's limit): a window of them in their own
    /// order that holds the start song (from 100 before it), or the first ones. The server does the same.</summary>
    public static IReadOnlyList<string> Window(IReadOnlyList<string> ids, string? startId, int limit = 10_000)
    {
        if (ids.Count <= limit) return ids;
        int at = startId is null ? -1 : ids.ToList().IndexOf(startId);
        int from = at < 0 ? 0 : Math.Max(0, Math.Min(at - 100, ids.Count - limit));
        return ids.Skip(from).Take(limit).ToList();
    }
}

/// <summary>
/// Sonus Connect version 2, the client side (docs/protocol/connect.md): a WebSocket on rest/connect?protocol=2 that shows
/// this device the user's one playback session, its queue and devices, and carries this device's commands and, while it
/// is the active device, its reports. It keeps itself connected (backoff 1 s doubling to 30 s) until disposed, and says
/// <see cref="Resume"/>'s answer in each hello. Events come on a background thread, in the order the server sent them.
/// </summary>
public sealed partial class SessionClient : IAsyncDisposable
{
    public const int Version = 2;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull };
    private static readonly TimeSpan ReplyTimeout = TimeSpan.FromSeconds(10);

    private readonly SubsonicClient _client;
    private readonly string _name, _kind, _clientName;
    private readonly bool _canPlay;
    private readonly CancellationTokenSource _stop = new();
    private readonly SemaphoreSlim _sending = new(1, 1);
    private readonly ConcurrentDictionary<string, TaskCompletionSource<SessionReply>> _waiting = new();
    private ClientWebSocket? _ws;
    private Task? _loop;
    private long _offset; // server clock − ours, ms
    private int _refs;
    private CancellationTokenSource _wake = new(); // cuts the wait between two attempts short

    /// <param name="deviceId">This device's own id, made once per installation and kept (<see cref="NewDeviceId"/>).</param>
    /// <param name="name">How the other devices list this one ("书房电脑").</param>
    /// <param name="kind">desktop, web, phone, tablet, speaker or other.</param>
    /// <param name="canPlay">False: a remote that never plays.</param>
    /// <param name="clientName">The app and its version ("Sonus 0.6.0 (Windows)").</param>
    public SessionClient(SubsonicClient client, string deviceId, string name, string kind = "desktop", bool canPlay = true, string? clientName = null)
    {
        if (!IsValidId(deviceId)) throw new ArgumentException("A device id is 8–64 letters, digits, _ or -.", nameof(deviceId));
        _client = client; DeviceId = deviceId; _name = name; _kind = kind; _canPlay = canPlay; _clientName = clientName ?? client.ClientName;
    }

    /// <summary>The server offers version 2 (getOpenSubsonicExtensions, read when connecting).</summary>
    public static bool Supported(SubsonicClient client) => client.ExtensionVersions.TryGetValue(ConnectClient.Extension, out var v) && v.Contains(Version);

    [GeneratedRegex("^[A-Za-z0-9_-]{8,64}$")] private static partial Regex IdPattern();
    public static bool IsValidId(string? id) => id is not null && IdPattern().IsMatch(id);

    /// <summary>A new random device id (22 characters).</summary>
    public static string NewDeviceId() => Convert.ToBase64String(RandomNumberGenerator.GetBytes(16)).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    public string DeviceId { get; }
    public bool IsConnected { get; private set; }
    /// <summary>The session as last heard (kept while reconnecting).</summary>
    public PlaybackSession Session { get; private set; } = new();
    public SessionQueue Queue { get; private set; } = SessionQueue.Empty;
    public IReadOnlyList<SessionDevice> Devices { get; private set; } = [];
    /// <summary>This device is the session's active device (as last heard).</summary>
    public bool IsActive => Session.ActiveDevice == DeviceId;

    /// <summary>The server's clock now (ms since the Unix epoch), for <see cref="PlaybackSession.PositionAt"/>.</summary>
    public long ServerNow => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + Interlocked.Read(ref _offset);

    /// <summary>Asked on every (re)connect: what to say as <c>resume</c> (null: nothing). Called on a background thread.</summary>
    public Func<SessionResume?>? Resume { get; set; }

    /// <summary>Asked on every (re)connect: this device's volume, said in the hello. Called on a background thread.</summary>
    public Func<(double Volume, bool Muted)>? VolumeNow { get; set; }

    public event Action<bool>? ConnectionChanged;
    /// <summary>The session changed (or arrived with a welcome).</summary>
    public event Action? SessionChanged;
    public event Action? QueueChanged;
    public event Action? DevicesChanged;
    /// <summary>Another device changed this one's volume (volume, muted, from whom).</summary>
    public event Action<double?, bool?, string>? VolumeAsked;
    /// <summary>An error from the server (code, message), also those answering a message that is waited for.</summary>
    public event Action<string, string>? Failed;

    public void Start() => _loop ??= Task.Run(() => RunAsync(_stop.Token));

    /// <summary>Tries again now rather than after the backoff (the server is reachable again, or the user wants something).</summary>
    public void ReconnectNow() { try { _wake.Cancel(); } catch (ObjectDisposedException) { } }

    /// <summary>A command (any device): its action and fields, as in connect.md. Answers when the server applied or
    /// refused it (code "offline" without a connection, "timeout" without an answer).</summary>
    public Task<SessionReply> CommandAsync(string action, object? fields = null) => RequestAsync("command", fields, ("action", action));

    /// <summary>A report (the active device only): what really happened to the entry <paramref name="key"/>.</summary>
    public Task<SessionReply> ReportAsync(string evt, string key, long positionMs, long rev, long? durationMs = null, SessionNow? now = null) =>
        RequestAsync("report", new { key, positionMs, rev, durationMs, now }, ("event", evt));

    /// <summary>This device's own volume, on every change.</summary>
    public Task<SessionReply> DeviceAsync(double volume, bool muted) => RequestAsync("device", new { volume, muted });

    private async Task<SessionReply> RequestAsync(string type, object? fields, params (string Key, string Value)[] head)
    {
        var ws = _ws;
        if (ws is null || ws.State != WebSocketState.Open || !IsConnected) return new SessionReply(false, Session.Rev, "offline", "未连接到服务器。");
        string reference = Interlocked.Increment(ref _refs).ToString(System.Globalization.CultureInfo.InvariantCulture);
        var message = new JsonObject { ["type"] = type, ["ref"] = reference };
        foreach (var (k, v) in head) message[k] = v;
        if (fields is not null && JsonSerializer.SerializeToNode(fields, Json) is JsonObject extra)
            foreach (var (k, v) in extra) message[k] = v?.DeepClone();
        var waiter = new TaskCompletionSource<SessionReply>(TaskCreationOptions.RunContinuationsAsynchronously);
        _waiting[reference] = waiter;
        try
        {
            if (!await SendAsync(ws, message).ConfigureAwait(false)) return new SessionReply(false, Session.Rev, "offline", "未连接到服务器。");
            var done = await Task.WhenAny(waiter.Task, Task.Delay(ReplyTimeout, _stop.Token)).ConfigureAwait(false);
            return done == waiter.Task ? waiter.Task.Result : new SessionReply(false, Session.Rev, "timeout", "服务器没有回应。");
        }
        catch (OperationCanceledException) { return new SessionReply(false, Session.Rev, "offline", "未连接到服务器。"); }
        finally { _waiting.TryRemove(reference, out _); }
    }

    private async Task<bool> SendAsync(ClientWebSocket ws, JsonNode message)
    {
        byte[] data = JsonSerializer.SerializeToUtf8Bytes(message, Json);
        try { await _sending.WaitAsync(_stop.Token).ConfigureAwait(false); }
        catch (OperationCanceledException) { return false; }
        try { await ws.SendAsync(data, WebSocketMessageType.Text, true, _stop.Token).ConfigureAwait(false); return true; }
        catch (Exception ex) when (ex is WebSocketException or OperationCanceledException or ObjectDisposedException or InvalidOperationException) { return false; } // the loop sees it and reconnects
        finally { _sending.Release(); }
    }

    private Uri Address()
    {
        string url = _client.Url("connect") + "&protocol=2";
        return new Uri(url.StartsWith("https:", StringComparison.OrdinalIgnoreCase) ? "wss:" + url[6..] : "ws:" + url[5..]);
    }

    private async Task RunAsync(CancellationToken stop)
    {
        var wait = TimeSpan.FromSeconds(1);
        while (!stop.IsCancellationRequested)
        {
            using var ws = new ClientWebSocket();
            ws.Options.KeepAliveInterval = TimeSpan.FromSeconds(25);
            try
            {
                await ws.ConnectAsync(Address(), stop).ConfigureAwait(false);
                _ws = ws;
                var hello = new JsonObject { ["type"] = "hello", ["deviceId"] = DeviceId, ["name"] = _name, ["kind"] = _kind, ["canPlay"] = _canPlay, ["client"] = _clientName };
                if (VolumeNow is { } said) { var (volume, muted) = said(); hello["volume"] = Math.Round(volume, 3); hello["muted"] = muted; }
                if (Resume?.Invoke() is { } resume) hello["resume"] = JsonSerializer.SerializeToNode(resume, Json);
                if (await SendAsync(ws, hello).ConfigureAwait(false)) await ReceiveAsync(ws, stop, () => wait = TimeSpan.FromSeconds(1)).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (stop.IsCancellationRequested) { break; }
            catch (Exception ex) when (ex is WebSocketException or HttpRequestException or IOException or JsonException or InvalidOperationException or KeyNotFoundException) { }
            finally
            {
                _ws = null;
                foreach (var w in _waiting.Values) w.TrySetResult(new SessionReply(false, Session.Rev, "offline", "连接断开了。"));
                if (IsConnected) { IsConnected = false; ConnectionChanged?.Invoke(false); }
            }
            var wake = _wake;
            using var waiting = CancellationTokenSource.CreateLinkedTokenSource(stop, wake.Token);
            try { await Task.Delay(wait, waiting.Token).ConfigureAwait(false); wait = TimeSpan.FromSeconds(Math.Min(30, wait.TotalSeconds * 2)); }
            catch (OperationCanceledException) when (!stop.IsCancellationRequested) { _wake = new(); wake.Dispose(); wait = TimeSpan.FromSeconds(1); } // woken
            catch (OperationCanceledException) { break; }
        }
    }

    private async Task ReceiveAsync(ClientWebSocket ws, CancellationToken stop, Action welcomed)
    {
        var buffer = new byte[64 * 1024];
        using var message = new MemoryStream();
        while (ws.State == WebSocketState.Open)
        {
            var r = await ws.ReceiveAsync(buffer, stop).ConfigureAwait(false);
            if (r.MessageType == WebSocketMessageType.Close) return;
            message.Write(buffer, 0, r.Count);
            if (!r.EndOfMessage) continue;
            if (r.MessageType == WebSocketMessageType.Text && Handle(message.ToArray())) welcomed();
            message.SetLength(0);
        }
    }

    /// <summary>One message from the server; true for the welcome.</summary>
    private bool Handle(byte[] data)
    {
        using var doc = JsonDocument.Parse(data);
        var root = doc.RootElement;
        string? type = root.TryGetProperty("type", out var t) ? t.GetString() : null;
        SetClock(root);
        switch (type)
        {
            case "welcome":
                Queue = Read<SessionQueue>(root, "queue") ?? SessionQueue.Empty;
                Session = Read<PlaybackSession>(root, "session") ?? new();
                Devices = Read<List<SessionDevice>>(root, "devices") ?? [];
                IsConnected = true;
                ConnectionChanged?.Invoke(true);
                QueueChanged?.Invoke(); SessionChanged?.Invoke(); DevicesChanged?.Invoke();
                return true;
            case "session":
                if (Read<PlaybackSession>(root, "session") is { } s && s.Rev >= Session.Rev) { Session = s; SessionChanged?.Invoke(); }
                break;
            case "queue":
                if (Read<SessionQueue>(root, "queue") is { } q && q.QueueRev >= Queue.QueueRev) { Queue = q; QueueChanged?.Invoke(); }
                break;
            case "devices":
                Devices = Read<List<SessionDevice>>(root, "devices") ?? [];
                DevicesChanged?.Invoke();
                break;
            case "deviceCommand":
                if (root.TryGetProperty("action", out var a) && a.GetString() == "volume")
                    VolumeAsked?.Invoke(root.TryGetProperty("volume", out var v) && v.TryGetDouble(out double vol) ? vol : null,
                        root.TryGetProperty("muted", out var m) && m.ValueKind is JsonValueKind.True or JsonValueKind.False ? m.GetBoolean() : null,
                        root.TryGetProperty("from", out var f) ? f.GetString() ?? "" : "");
                break;
            case "ack":
                if (Ref(root) is { } ack && _waiting.TryGetValue(ack, out var done)) done.TrySetResult(new SessionReply(true, root.TryGetProperty("rev", out var rev) ? rev.GetInt64() : Session.Rev));
                break;
            case "error":
                string code = root.TryGetProperty("code", out var c) ? c.GetString() ?? "" : "", text = root.TryGetProperty("message", out var mm) ? mm.GetString() ?? "" : "";
                if (Ref(root) is { } failed && _waiting.TryGetValue(failed, out var w)) w.TrySetResult(new SessionReply(false, Session.Rev, code, text));
                Failed?.Invoke(code, text);
                break;
        }
        return false;
    }

    private static T? Read<T>(JsonElement root, string name) where T : class =>
        root.TryGetProperty(name, out var e) && e.ValueKind != JsonValueKind.Null ? e.Deserialize<T>(Json) : null;

    private static string? Ref(JsonElement root) => root.TryGetProperty("ref", out var r) && r.ValueKind == JsonValueKind.String ? r.GetString() : null;

    private void SetClock(JsonElement root)
    {
        if (root.TryGetProperty("serverTime", out var s) && s.TryGetInt64(out long server))
            Interlocked.Exchange(ref _offset, server - DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
    }

    public async ValueTask DisposeAsync()
    {
        // a goodbye first: the server then knows this device left on purpose (no grace period), then the loop stops
        if (_ws is { State: WebSocketState.Open } ws)
        {
            using var wait = new CancellationTokenSource(TimeSpan.FromSeconds(2));
            try { await ws.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "bye", wait.Token).ConfigureAwait(false); }
            catch (Exception ex) when (ex is WebSocketException or ObjectDisposedException or OperationCanceledException or InvalidOperationException) { }
        }
        _stop.Cancel();
        if (_loop is not null) { try { await _loop.ConfigureAwait(false); } catch (OperationCanceledException) { } }
    }
}
