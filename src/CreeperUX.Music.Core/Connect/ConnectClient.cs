using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace CreeperUX.Music.Core.Connect;

/// <summary>Where a queue came from (an album, a playlist…), so another device can name it and play it the same way.</summary>
public sealed record ConnectContext(string? Kind, string? Id, string? Label);

/// <summary>A play queue: song ids and the playing one's index.</summary>
public sealed record ConnectQueue(IReadOnlyList<string> Ids, int Index);

/// <summary>
/// What a device plays, as it reports it. <see cref="At"/> is when the server received it (its clock, ms since the Unix
/// epoch); while <see cref="Playing"/>, the position now is <see cref="PositionAt"/>.
/// </summary>
public sealed record ConnectState
{
    public string? TrackId { get; init; }
    public string? Title { get; init; }
    public string? Artist { get; init; }
    public string? Album { get; init; }
    public string? CoverArt { get; init; }
    public long DurationMs { get; init; }
    public long PositionMs { get; init; }
    public bool Playing { get; init; }
    public double? Volume { get; init; }
    public int Index { get; init; }
    public int Count { get; init; }
    public ConnectContext? Context { get; init; }
    public long At { get; init; }

    /// <summary>The position at the server's time <paramref name="serverNow"/> (it keeps moving while playing).</summary>
    public long PositionAt(long serverNow)
    {
        long p = Playing && At > 0 ? PositionMs + Math.Max(0, serverNow - At) : PositionMs;
        return DurationMs > 0 ? Math.Min(p, DurationMs) : p;
    }
}

/// <summary>What a device is asked to do: play, pause, toggle, next, previous, stop; seek (PositionMs); volume (Volume);
/// load (Queue, PositionMs, Play, Context; Source: the device a transfer moved the playback from).</summary>
public sealed record ConnectCommand(string Action)
{
    public string? Source { get; init; }
    public const string Play = "play", Pause = "pause", Toggle = "toggle", Next = "next", Previous = "previous", Stop = "stop",
        Seek = "seek", Volume = "volume", Load = "load";
    public long? PositionMs { get; init; }
    [JsonPropertyName("volume")] public double? Level { get; init; }
    public ConnectQueue? Queue { get; init; }
    [JsonPropertyName("play")] public bool? Start { get; init; }
    public ConnectContext? Context { get; init; }
}

/// <summary>One connected player of the user, this one included.</summary>
public sealed record ConnectDevice(string Id, string Name, string Kind, string Client, bool CanPlay, long ConnectedAt, ConnectState? State);

/// <summary>
/// CreeperUX Connect, the client side (the CreeperUX/navidrome fork's server/connect, and the demo server): a WebSocket
/// on rest/connect where this player says what it plays, sees the user's other players and what they play, and sends
/// and receives commands and transfers. It keeps itself connected (reconnecting after a dropped connection) until
/// disposed; what it last said is said again on reconnecting. Events come on a background thread.
/// </summary>
public sealed class ConnectClient : IAsyncDisposable
{
    public const string Extension = "creeperuxConnect";

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull };
    private static readonly TimeSpan[] Backoff = [TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(2), TimeSpan.FromSeconds(5), TimeSpan.FromSeconds(10), TimeSpan.FromSeconds(30)];

    private readonly SubsonicClient _client;
    private readonly string _name, _kind;
    private readonly CancellationTokenSource _stop = new();
    private readonly SemaphoreSlim _sending = new(1, 1);
    private ClientWebSocket? _ws;
    private Task? _loop;
    private (ConnectState State, ConnectQueue? Queue)? _said;
    private ConnectQueue? _queueSaid;
    private long _offset; // server clock − ours, ms

    /// <param name="name">How the other devices list this one ("书房电脑").</param>
    /// <param name="kind">desktop, web, phone or speaker.</param>
    public ConnectClient(SubsonicClient client, string name, string kind = "desktop")
    {
        _client = client; _name = name; _kind = kind;
    }

    /// <summary>The server offers it (getOpenSubsonicExtensions, read when connecting).</summary>
    public static bool Supported(SubsonicClient client) => client.Extensions.Contains(Extension);

    /// <summary>This player's id, as the server knows it (null until connected).</summary>
    public string? DeviceId { get; private set; }
    public IReadOnlyList<ConnectDevice> Devices { get; private set; } = [];
    public bool IsConnected { get; private set; }

    /// <summary>The server's clock now (ms since the Unix epoch), for <see cref="ConnectState.PositionAt"/>.</summary>
    public long ServerNow => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + Interlocked.Read(ref _offset);

    public event Action? DevicesChanged;
    public event Action<bool>? ConnectionChanged;
    /// <summary>Another device (its id) asks this one to do something.</summary>
    public event Action<string, ConnectCommand>? CommandReceived;
    /// <summary>A command or transfer could not be delivered (code: offline, nothing; and a message to show).</summary>
    public event Action<string, string>? Failed;

    public void Start() => _loop ??= Task.Run(() => RunAsync(_stop.Token));

    /// <summary>What this player plays. The queue goes with it only when it changed (the server keeps it for transfers).</summary>
    public Task SendStateAsync(ConnectState state, ConnectQueue? queue)
    {
        bool queueChanged = queue is not null && !SameQueue(queue, _queueSaid);
        _said = (state, queue);
        if (queueChanged) _queueSaid = queue;
        return SendAsync(new { type = "state", state = state with { At = 0 }, queue = queueChanged ? queue : null });
    }

    public Task SendCommandAsync(string target, ConnectCommand command) => SendAsync(new { type = "command", target, command });

    /// <summary>Moves <paramref name="from"/>'s playback to <paramref name="to"/> (playing as it was, unless <paramref name="play"/> says).</summary>
    public Task TransferAsync(string from, string to, bool? play = null) => SendAsync(new { type = "transfer", from, to, play });

    private static bool SameQueue(ConnectQueue a, ConnectQueue? b) => b is not null && a.Index == b.Index && a.Ids.SequenceEqual(b.Ids);

    private async Task SendAsync(object message)
    {
        var ws = _ws;
        if (ws is null || ws.State != WebSocketState.Open) return; // said again on reconnecting (state); commands need a connection
        byte[] data = JsonSerializer.SerializeToUtf8Bytes(message, Json);
        await _sending.WaitAsync(_stop.Token).ConfigureAwait(false);
        try { await ws.SendAsync(data, WebSocketMessageType.Text, true, _stop.Token).ConfigureAwait(false); }
        catch (Exception ex) when (ex is WebSocketException or OperationCanceledException or ObjectDisposedException) { /* the loop sees it and reconnects */ }
        finally { _sending.Release(); }
    }

    private Uri Address()
    {
        string url = _client.Url("connect");
        return new Uri(url.StartsWith("https:", StringComparison.OrdinalIgnoreCase) ? "wss:" + url[6..] : "ws:" + url[5..]);
    }

    private async Task RunAsync(CancellationToken stop)
    {
        int failures = 0;
        while (!stop.IsCancellationRequested)
        {
            using var ws = new ClientWebSocket();
            ws.Options.KeepAliveInterval = TimeSpan.FromSeconds(25);
            try
            {
                await ws.ConnectAsync(Address(), stop).ConfigureAwait(false);
                _ws = ws;
                failures = 0;
                await ReceiveAsync(ws, stop).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (stop.IsCancellationRequested) { break; }
            catch (Exception ex) when (ex is WebSocketException or HttpRequestException or IOException or JsonException or InvalidOperationException) { }
            finally
            {
                _ws = null;
                if (IsConnected) { IsConnected = false; Devices = []; ConnectionChanged?.Invoke(false); DevicesChanged?.Invoke(); }
            }
            try { await Task.Delay(Backoff[Math.Min(failures++, Backoff.Length - 1)], stop).ConfigureAwait(false); }
            catch (OperationCanceledException) { break; }
        }
    }

    private async Task ReceiveAsync(ClientWebSocket ws, CancellationToken stop)
    {
        var buffer = new byte[64 * 1024];
        using var message = new MemoryStream();
        while (ws.State == WebSocketState.Open)
        {
            var r = await ws.ReceiveAsync(buffer, stop).ConfigureAwait(false);
            if (r.MessageType == WebSocketMessageType.Close) return;
            message.Write(buffer, 0, r.Count);
            if (!r.EndOfMessage) continue;
            if (r.MessageType == WebSocketMessageType.Text) await HandleAsync(message.ToArray()).ConfigureAwait(false);
            message.SetLength(0);
        }
    }

    private async Task HandleAsync(byte[] data)
    {
        using var doc = JsonDocument.Parse(data);
        var root = doc.RootElement;
        string? type = root.TryGetProperty("type", out var t) ? t.GetString() : null;
        switch (type)
        {
            case "welcome":
                DeviceId = root.GetProperty("deviceId").GetString();
                SetClock(root);
                IsConnected = true;
                ConnectionChanged?.Invoke(true);
                await SendAsync(new { type = "hello", name = _name, kind = _kind, canPlay = true }).ConfigureAwait(false);
                if (_said is { } said) // what this player plays, again (a reconnect, or the server restarted)
                {
                    _queueSaid = said.Queue;
                    await SendAsync(new { type = "state", state = said.State with { At = 0 }, queue = said.Queue }).ConfigureAwait(false);
                }
                break;
            case "devices":
                SetClock(root);
                Devices = root.GetProperty("devices").Deserialize<List<ConnectDevice>>(Json) ?? [];
                DevicesChanged?.Invoke();
                break;
            case "command":
                if (root.GetProperty("command").Deserialize<ConnectCommand>(Json) is { } command)
                    CommandReceived?.Invoke(root.TryGetProperty("from", out var f) ? f.GetString() ?? "" : "", command);
                break;
            case "error":
                Failed?.Invoke(root.GetProperty("code").GetString() ?? "", root.GetProperty("message").GetString() ?? "");
                break;
        }
    }

    private void SetClock(JsonElement root)
    {
        if (root.TryGetProperty("serverTime", out var s) && s.TryGetInt64(out long server))
            Interlocked.Exchange(ref _offset, server - DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
    }

    public async ValueTask DisposeAsync()
    {
        _stop.Cancel();
        if (_ws is { State: WebSocketState.Open } ws)
        {
            try { await ws.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "bye", CancellationToken.None).ConfigureAwait(false); }
            catch (Exception ex) when (ex is WebSocketException or ObjectDisposedException) { }
        }
        if (_loop is not null) { try { await _loop.ConfigureAwait(false); } catch (OperationCanceledException) { } }
        // _stop is not disposed: a send still in flight may look at its token (it holds no timer)
    }
}
