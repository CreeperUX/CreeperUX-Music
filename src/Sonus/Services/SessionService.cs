using Sonus.Core;
using Sonus.Core.Connect;
using Microsoft.UI.Dispatching;

namespace Sonus.Services;

/// <summary>
/// Sonus Connect version 2 in the app (docs/protocol/connect.md), on a server that offers it: the user has one playback
/// session, kept on the server. Every device shows it; what the user does here (play something, queue, skip, seek, change
/// the order) is sent as a command, and the session's active device plays it. This device's engine plays only while it is
/// the active device (MusicService follows the session then, and reports what really happens); the device picker moves
/// playback (a transfer). UI thread only; the client's events are brought here.
/// </summary>
public sealed class SessionService : IDisposable
{
    private readonly MusicService _music;
    private readonly DispatcherQueue _ui;
    private readonly SessionClient _client;
    // reports made while the connection was down (the active device plays on): said when it is back, if still active
    private readonly List<(string Event, string Key, long PositionMs, long? DurationMs, SessionNow? Now)> _pending = [];
    private long _appliedRev = -1, _appliedQueueRev = -1;
    private double _sentVolume = -1;
    private bool _sentMuted, _disposed;

    public SessionService(MusicService music, DispatcherQueue ui, AppSettings settings, string name)
    {
        _music = music; _ui = ui;
        // this device's own id, made once and kept: a reconnect, or the next start, is the same device
        if (!SessionClient.IsValidId(settings.ConnectDeviceId)) { settings.ConnectDeviceId = SessionClient.NewDeviceId(); settings.Save(); }
        _client = new SessionClient(music.Client, settings.ConnectDeviceId!, name, "desktop", canPlay: true, $"Sonus {Updates.UpdateService.Current.ToString(3)} (Windows)")
        {
            Resume = ResumeState,
        };
        _client.ConnectionChanged += on => _ui.TryEnqueue(() => OnConnection(on));
        _client.SessionChanged += () => _ui.TryEnqueue(Apply);
        _client.QueueChanged += () => _ui.TryEnqueue(Apply);
        _client.DevicesChanged += () => _ui.TryEnqueue(() => { if (!_disposed) Changed?.Invoke(); });
        _client.VolumeAsked += (volume, muted, _) => _ui.TryEnqueue(() =>
        {
            if (_disposed) return;
            if (muted is { } m) _music.SetMuted(m);
            if (volume is { } v) _music.SetVolume(v);
        });
        _client.Failed += (code, message) => _ui.TryEnqueue(() => OnError(code, message));
        music.AttachSession(this);
        music.PlayerChanged += SayVolume;
        music.ConnectionChanged += OnServerReachable;
        _client.Start();
    }

    public string Id => _client.DeviceId;
    public bool IsConnected => _client.IsConnected;
    public PlaybackSession Session => _client.Session;
    public IReadOnlyList<SessionDevice> Devices => _client.Devices;
    public long ServerNow => _client.ServerNow;

    /// <summary>This device plays the session.</summary>
    public bool IsActiveHere => _client.IsActive;

    /// <summary>Another device plays the session (not this one, not none).</summary>
    public SessionDevice? ActiveElsewhere => Session.ActiveDevice is { } a && a != Id ? Devices.FirstOrDefault(d => d.Id == a) ?? new SessionDevice(a, NameOf(a), "other", "", true, 0, 1, false) : null;

    public string NameOf(string id) => id == Id ? "这台电脑" : Devices.FirstOrDefault(d => d.Id == id)?.Name ?? (Session.LastDevice?.Id == id ? Session.LastDevice.Name : "另一台设备");

    /// <summary>Where the session plays, as the bar says it: "正在「手机」上播放" while another device plays it, "上次在「书房电脑」
    /// 播放" when none does; null while this device plays it, or when there is nothing to play.</summary>
    public string? Where =>
        Session.Current is null ? null
        : Session.ActiveDevice is { } a ? a == Id ? null : $"正在「{NameOf(a)}」上播放"
        : Session.LastDevice is { } last ? $"上次在「{NameOf(last.Id)}」播放" : null;

    /// <summary>The session, its queue or the devices changed (or the connection came or went).</summary>
    public event Action? Changed;

    // ---------------------------------------------------------------- the session, shown and followed
    private void Apply()
    {
        if (_disposed) return;
        var s = Session;
        var q = _client.Queue;
        // the queue message comes first: wait for it when the session names a newer one
        if (q.QueueRev < s.QueueRev) return;
        if (s.Rev == _appliedRev && q.QueueRev == _appliedQueueRev) return;
        _appliedRev = s.Rev; _appliedQueueRev = q.QueueRev;
        _music.ApplySession(s, q, IsActiveHere);
        Changed?.Invoke();
    }

    private void OnConnection(bool on)
    {
        if (_disposed) return;
        if (on)
        {
            _appliedRev = -1; // the welcome's session is applied whatever its rev
            Apply();
            // what happened while the connection was down, in order (the server ignores what no longer applies)
            if (IsActiveHere) foreach (var r in _pending) _ = _client.ReportAsync(r.Event, r.Key, r.PositionMs, Session.Rev, r.DurationMs, r.Now);
            _pending.Clear();
            _sentVolume = -1; SayVolume();
        }
        Log.Write($"[session] {(on ? "connected" : "connection lost")} as {Id}");
        Changed?.Invoke();
    }

    /// <summary>On reconnecting: this device was the active one and still plays (a short network loss).</summary>
    private SessionResume? ResumeState()
    {
        if (!_client.IsActive) return null;
        var e = _music.Engine;
        if (e.CurrentId is null) return null;
        return new SessionResume(_client.Session.Rev, e.State is Playback.EngineState.Playing or Playback.EngineState.Loading, (long)(e.Position * 1000));
    }

    private void OnError(string code, string message)
    {
        if (_disposed) return;
        Log.Write($"[session] error {code}: {message}");
        // stale and notActive: the session moved on meanwhile, and what it is now is on its way
        if (code is "stale" or "notActive" or "timeout") return;
        _music.RaiseToast(new(message, code != "unplayable"));
    }

    // ---------------------------------------------------------------- what this device does: commands
    /// <summary>A command for the session; a refusal comes back as a toast. While the connection is down it is tried again
    /// at once and the command waits a few seconds for it.</summary>
    public async void Send(string action, object? fields = null)
    {
        if (_disposed) return;
        if (!IsConnected)
        {
            _client.ReconnectNow();
            for (int i = 0; i < 60 && !IsConnected && !_disposed; i++) await Task.Delay(50);
            if (_disposed) return;
            if (!IsConnected) { SayOffline(); return; }
        }
        _ = _client.CommandAsync(action, fields);
    }

    /// <summary>The server answers again (MusicService's requests): the session's connection is tried at once too.</summary>
    private void OnServerReachable() { if (!_disposed && _music.IsOnline && !IsConnected) _client.ReconnectNow(); }

    public void SayOffline() => _music.RaiseToast(new("正在重新连接服务器，稍后再试。", true));

    /// <summary>Plays a context (rule 3): the server arranges it, unless shuffling by album or folder, which this device
    /// does (the server may not know albums and folders).</summary>
    public void PlayContext(PlayContext context, IReadOnlyList<string> ids, string? startId, bool shuffle)
    {
        var known = SessionModes.Window(ids.Where(id => _music.Library.Track(id) is not null).ToList(), startId);
        if (known.Count == 0) return;
        var order = _music.Queue.Order;
        IReadOnlyList<string>? arranged = null;
        if (order is PlaybackOrder.ShuffleAlbums or PlaybackOrder.ShuffleFolders)
        {
            var q = new PlayQueue(id => _music.Library.Track(id)) { Order = order };
            startId = q.Start(context, known, startId, shuffle) ?? startId;
            arranged = q.ContextIds;
        }
        Send("playContext", new { context = new { kind = context.Kind, id = context.Id, label = context.Label }, ids = known, startId, shuffle = shuffle ? true : (bool?)null, order = arranged });
    }

    public void SetMode(PlaybackOrder order)
    {
        IReadOnlyList<string>? arranged = null;
        if (order is PlaybackOrder.ShuffleAlbums or PlaybackOrder.ShuffleFolders && _client.Queue.Order.Count > 0)
        {
            var q = new PlayQueue(id => _music.Library.Track(id));
            var cq = _client.Queue;
            q.Mirror(null, cq.Order, cq.Pointer, cq.Manual.Select(m => (m.Key, m.TrackId)).ToList(), Session.Current?.TrackId, SessionModes.Parse(Session.Mode), Session.StopAfterCurrent);
            q.SetOrder(order);
            arranged = q.ContextIds;
        }
        Send("mode", new { mode = SessionModes.Of(order), order = arranged });
    }

    /// <summary>Moves playback to that device (rule 4); the one it leaves stops. Playing as before unless said.</summary>
    public void Transfer(string deviceId, bool? play = null) => Send("transfer", new { to = deviceId, play });

    /// <summary>Any device's volume (rule 8): this one's here, another's through the server.</summary>
    public void SetVolume(string deviceId, double? volume, bool? muted = null)
    {
        if (deviceId == Id)
        {
            if (muted is { } m) _music.SetMuted(m);
            if (volume is { } v) _music.SetVolume(v);
            return;
        }
        Send("volume", new { device = deviceId, volume, muted });
    }

    // ---------------------------------------------------------------- what this device's engine does: reports
    /// <summary>A report about the entry <paramref name="key"/> (the active device only); kept for later while offline.</summary>
    public void Report(string evt, string key, double position, double? duration = null, SessionNow? now = null)
    {
        if (_disposed || !IsActiveHere) return;
        long ms = (long)Math.Max(0, position * 1000);
        long? durationMs = duration is { } d && d > 0 ? (long)(d * 1000) : null;
        if (!IsConnected)
        {
            // the last of playing / paused / position is enough; endings are all kept
            if (evt is "playing" or "paused" or "position") _pending.RemoveAll(p => p.Event is "playing" or "paused" or "position");
            if (_pending.Count < 50) _pending.Add((evt, key, ms, durationMs, now));
            return;
        }
        _ = _client.ReportAsync(evt, key, ms, Session.Rev, durationMs, now);
    }

    /// <summary>This device's volume, for the others' pickers (on every change).</summary>
    private void SayVolume()
    {
        if (_disposed || !IsConnected) return;
        double v = Math.Round(_music.Volume, 3);
        bool m = _music.Muted;
        if (v == _sentVolume && m == _sentMuted) return;
        _sentVolume = v; _sentMuted = m;
        _ = _client.DeviceAsync(v, m);
    }

    /// <summary>The app is closing or signing out: what plays here is paused first, so the other devices see it stop where
    /// it is at once (a connection that just drops stops it after the grace period, rule 7).</summary>
    public async Task LeaveAsync()
    {
        if (_disposed || !IsConnected || !IsActiveHere || !Session.Playing) return;
        try { await _client.CommandAsync("pause").WaitAsync(TimeSpan.FromSeconds(1)); }
        catch (TimeoutException) { Log.Write("[session] pause on leaving: no answer"); }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _music.PlayerChanged -= SayVolume;
        _music.ConnectionChanged -= OnServerReachable;
        _ = _client.DisposeAsync().AsTask();
    }
}
