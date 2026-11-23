using CreeperUX.Music.Core;
using CreeperUX.Music.Core.Connect;
using Microsoft.UI.Dispatching;

namespace CreeperUX.Music.Services;

/// <summary>
/// CreeperUX Connect in the app: this player among the user's others (on a server that offers it: the CreeperUX/navidrome
/// fork, the demo server). It tells the others what plays here (on every change, not every tick), carries out what they
/// ask, and lets the bar play here or control another device: picking a device moves the playback there (a transfer)
/// and the bar then shows and controls it. UI thread only; the client's events are brought here.
/// </summary>
public sealed class ConnectService : IDisposable
{
    private readonly MusicService _music;
    private readonly DispatcherQueue _ui;
    private readonly ConnectClient? _client;
    private readonly DispatcherQueueTimer _push;
    private long _pushedAt;
    private double _pushedPosition;
    private bool _pushedPlaying, _disposed;

    public ConnectService(MusicService music, DispatcherQueue ui, string name)
    {
        _music = music; _ui = ui;
        _push = ui.CreateTimer();
        _push.Interval = TimeSpan.FromMilliseconds(150); // a burst of changes (a new song: queue, state, position) is said once
        _push.IsRepeating = false;
        _push.Tick += (_, _) => Push();
        if (!ConnectClient.Supported(music.Client)) return;

        _client = new ConnectClient(music.Client, name);
        _client.DevicesChanged += () => _ui.TryEnqueue(OnDevices);
        _client.ConnectionChanged += _ => _ui.TryEnqueue(() => { Changed?.Invoke(); if (IsConnected) Schedule(); });
        _client.CommandReceived += (from, command) => _ui.TryEnqueue(() => Carry(from, command));
        _client.Failed += (_, message) => _ui.TryEnqueue(() => _music.RaiseToast(new(message, true)));
        music.PlayerChanged += Schedule;
        music.QueueChanged += Schedule;
        music.PositionChanged += OnPosition;
        _client.Start();
    }

    /// <summary>The server offers it (the devices button shows only then).</summary>
    public bool IsAvailable => _client is not null;
    public bool IsConnected => _client?.IsConnected == true;
    public string? ThisId => _client?.DeviceId;
    public long ServerNow => _client?.ServerNow ?? DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    /// <summary>The user's other connected devices.</summary>
    public IReadOnlyList<ConnectDevice> Others => _client is null ? [] : [.. _client.Devices.Where(d => d.Id != _client.DeviceId)];

    /// <summary>The device the bar controls; null: this one.</summary>
    public ConnectDevice? Target { get; private set; }

    /// <summary>Another device plays (for the devices button's dot).</summary>
    public bool OtherPlaying => Others.Any(d => d.State?.Playing == true);

    /// <summary>Devices came or went, one's state changed, or the target changed.</summary>
    public event Action? Changed;

    private void OnDevices()
    {
        if (Target is { } t)
        {
            var now = Others.FirstOrDefault(d => d.Id == t.Id);
            if (now is null) { Target = null; _music.RaiseToast(new($"「{t.Name}」已断开，回到这台电脑播放。")); }
            else Target = now;
        }
        Changed?.Invoke();
    }

    // ---------------------------------------------------------------- what plays here, for the others
    private void Schedule() { if (!_disposed) { _push.Stop(); _push.Start(); } }

    // a seek (a jump of the position), not the position moving on: positions are worked out from the state's time
    private void OnPosition(double at)
    {
        if (_client is null) return;
        double expected = _pushedPosition + (_pushedPlaying ? (Environment.TickCount64 - _pushedAt) / 1000.0 : 0);
        if (Math.Abs(at - expected) > 1.5) Schedule();
    }

    private void Push()
    {
        if (_client is null || _disposed) return;
        var m = _music;
        var t = m.Current;
        var (ids, index) = m.Queue.Snapshot();
        var context = m.Queue.Context is { } c ? new ConnectContext(c.Kind, c.Id, c.Label) : null;
        string? cover = t is null ? null : m.Library.Album(t.AlbumId)?.CoverArt ?? t.CoverArt;
        bool playing = m.State is PlayerState.Playing or PlayerState.Loading;
        var state = new ConnectState
        {
            TrackId = t?.Id, Title = t?.Title, Artist = t?.Artist, Album = t?.Album, CoverArt = cover,
            DurationMs = (long)(m.Duration * 1000), PositionMs = (long)(m.Position * 1000), Playing = playing,
            Volume = m.Muted ? 0 : m.Volume, Index = Math.Max(0, index), Count = ids.Count, Context = context,
        };
        _pushedAt = Environment.TickCount64; _pushedPosition = m.Position; _pushedPlaying = playing;
        _ = _client.SendStateAsync(state, ids.Count > 0 ? new ConnectQueue(ids, index) : null);
    }

    // ---------------------------------------------------------------- what the others ask of this one
    private void Carry(string from, ConnectCommand command)
    {
        var m = _music;
        switch (command.Action)
        {
            case ConnectCommand.Play: if (!m.IsActive) m.TogglePlay(); break;
            case ConnectCommand.Pause: case ConnectCommand.Stop: if (m.IsActive) m.Pause(); break;
            case ConnectCommand.Toggle: m.TogglePlay(); break;
            case ConnectCommand.Next: m.Next(); break;
            case ConnectCommand.Previous: m.Previous(); break;
            case ConnectCommand.Seek when command.PositionMs is { } ms: m.Seek(ms / 1000.0); break;
            case ConnectCommand.Volume when command.Level is { } v: m.SetVolume(v); break;
            case ConnectCommand.Load when command.Queue is { } q:
                var context = command.Context is { } c ? new PlayContext(c.Kind ?? "queue", c.Id ?? "connect", c.Label ?? "") : new PlayContext("queue", "connect", "");
                // where it came from (a transfer names it; whoever asked, this device or another)
                string? source = Others.FirstOrDefault(d => d.Id == (command.Source ?? from))?.Name;
                if (m.TakeOver(context, q.Ids, q.Index, (command.PositionMs ?? 0) / 1000.0, command.Start ?? true))
                {
                    Target = null; // this device plays now
                    if (source is not null) m.RaiseToast(new($"已从「{source}」转到这台电脑播放"));
                    Changed?.Invoke();
                }
                else m.RaiseToast(new("无法接过播放：这首歌不在这台电脑的媒体库里。", true));
                break;
        }
        Log.Write($"[connect] {command.Action} from {from}");
    }

    // ---------------------------------------------------------------- picking a device, and the bar's controls
    /// <summary>
    /// The bar plays on that device from now on (null: this one). What the bar had moves there (a transfer) when it was
    /// playing, or when it was paused and that device has nothing of its own; otherwise the bar simply controls that
    /// device, so what it plays is not interrupted.
    /// </summary>
    public async Task SelectAsync(ConnectDevice? device)
    {
        if (_client is null || ThisId is not { } me) return;
        string from = Target?.Id ?? me, to = device?.Id ?? me;
        if (from == to) return;
        bool fromPlaying = from == me ? _music.IsActive : Target?.State?.Playing == true;
        bool fromHas = from == me ? _music.Current is not null : Target?.State?.TrackId is not null;
        bool toHas = to == me ? _music.Current is not null : device?.State?.TrackId is not null;
        if (fromPlaying || (fromHas && !toHas)) await _client.TransferAsync(from, to);
        Target = device;
        Changed?.Invoke();
    }

    /// <summary>A command for the device the bar controls (Target).</summary>
    public Task SendAsync(ConnectCommand command) =>
        _client is not null && Target is { } t ? _client.SendCommandAsync(t.Id, command) : Task.CompletedTask;

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _push.Stop();
        _music.PlayerChanged -= Schedule;
        _music.QueueChanged -= Schedule;
        _music.PositionChanged -= OnPosition;
        if (_client is not null) _ = _client.DisposeAsync().AsTask();
    }
}
