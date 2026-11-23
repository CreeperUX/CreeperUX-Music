using System.Collections.Concurrent;
using Microsoft.UI.Dispatching;
using Windows.Devices.Enumeration;
using Windows.Media;
using Windows.Media.Core;
using Windows.Media.Devices;
using Windows.Media.Playback;
using Windows.Storage.Streams;

namespace Sonus.Playback;

/// <summary>What the engine is doing.</summary>
public enum EngineState { Stopped, Loading, Playing, Paused, Error }

/// <summary>A song for the engine: its stream and what the system media controls show.</summary>
public sealed record EngineItem(string Id, string Url, string Title, string Artist, string Album, string? CoverUrl, double StartAt = 0);

/// <summary>An audio output the computer has.</summary>
public sealed record OutputDevice(string Id, string Name, bool IsDefault);

/// <summary>
/// Plays audio with Windows' own MediaPlayer. The playing song and the next one sit in a MediaPlaybackList, so Media
/// Foundation goes from one to the other without a gap and without waiting for the network. The system media controls
/// (media keys, the card in the volume flyout and on the lock screen) come with MediaPlayer; Next and Previous are handed
/// to the app (its queue decides), Play and Pause MediaPlayer does itself.
///
/// Every call into MediaPlayer runs on the engine's own thread, one after another, never on the UI thread: Media
/// Foundation and the system media controls make cross-process calls that can block, and a blocked UI thread is a frozen
/// window (Lumen moved its media controls off the UI thread for the same reason). The UI reads values the engine thread
/// keeps up to date; events arrive on the UI thread.
/// </summary>
public sealed class AudioEngine : IDisposable
{
    private readonly DispatcherQueue _ui;
    private readonly BlockingCollection<Action> _work = [];
    private readonly Thread _thread;
    private MediaPlayer _player = null!;
    private MediaPlaybackList _list = null!;
    private Timer? _poll;
    private bool _wantPlay;
    private double _pendingSeek; // where a loaded song starts, applied once Media Foundation has opened it
    private DateTime _loadingSince = DateTime.MaxValue; // a play that has not started yet (the watchdog in Poll)
    private int _nudges;

    // read by the UI thread, written by the engine thread
    private volatile EngineState _state = EngineState.Stopped;
    private volatile string? _currentId, _nextId, _error;
    private double _position, _volume = 1;
    private double? _duration;
    private volatile bool _muted;
    /// <summary>Counts loads (written on the UI thread). An event raised for an earlier load is dropped, so a late "ended" or
    /// "failed" of the previous song never acts on the one just chosen.</summary>
    private int _generation;

    public AudioEngine(DispatcherQueue ui)
    {
        _ui = ui;
        _thread = new Thread(Run) { IsBackground = true, Name = "audio engine" };
        _thread.SetApartmentState(ApartmentState.MTA);
        _thread.Start();
        Do(Create);
    }

    public EngineState State => _state;
    /// <summary>The song the engine has loaded (playing or paused), or null.</summary>
    public string? CurrentId => _currentId;
    /// <summary>The song loaded after it (it starts by itself when the current one ends), or null.</summary>
    public string? NextId => _nextId;
    public double Position => Volatile.Read(ref _position);
    public double? Duration => _duration;
    public string? Error => _error;

    public event Action? StateChanged;
    /// <summary>The next song started by itself when the previous one ended (gapless): its id.</summary>
    public event Action<string>? Advanced;
    /// <summary>The last loaded song ended and nothing followed.</summary>
    public event Action? Ended;
    public event Action? NextRequested, PreviousRequested;

    // ---------------------------------------------------------------- the engine thread
    private void Run()
    {
        foreach (var action in _work.GetConsumingEnumerable())
        {
            try { action(); }
            catch (Exception ex) { Log.Write($"[engine] {ex.GetType().Name}: {ex.Message}"); }
        }
    }

    private void Do(Action action)
    {
        try { _work.Add(action); }
        catch (InvalidOperationException) { /* disposed: nothing more to do */ }
    }

    /// <summary>Raises a UI event unless a newer load came after the media event that caused it.</summary>
    private void Post(int generation, Action action) => Post(() => { if (generation == Volatile.Read(ref _generation)) action(); });

    private void Post(Action action) => _ui.TryEnqueue(() => { try { action(); } catch (Exception ex) { Log.Write($"[engine ui] {ex}"); } });

    private void Create()
    {
        _player = new MediaPlayer { AudioCategory = MediaPlayerAudioCategory.Media, AutoPlay = false, Volume = _volume, IsMuted = _muted };
        _list = NewList();
        _player.Source = _list;
        _player.MediaOpened += (_, _) => Do(() =>
        {
            if (_loadClock is { } c && _openedAt < 0) _openedAt = c.ElapsedMilliseconds;
            ApplyPendingSeek();
        });
        _player.MediaEnded += (_, _) =>
        {
            int g = Volatile.Read(ref _generation);
            Do(() => { if (g == Volatile.Read(ref _generation) && _state != EngineState.Error) { SetState(EngineState.Stopped); Post(g, () => Ended?.Invoke()); } });
        };
        _player.MediaFailed += (_, e) =>
        {
            int g = Volatile.Read(ref _generation);
            Do(() => { if (g == Volatile.Read(ref _generation)) Fail(_currentId, e.ErrorMessage is { Length: > 0 } m ? m : e.Error.ToString()); });
        };
        _player.PlaybackSession.PlaybackStateChanged += (s, _) => { var st = s.PlaybackState; Do(() => OnSessionState(st)); };
        var commands = _player.CommandManager;
        commands.IsEnabled = true;
        commands.NextBehavior.EnablingRule = MediaCommandEnablingRule.Always;
        commands.PreviousBehavior.EnablingRule = MediaCommandEnablingRule.Always;
        commands.NextReceived += (_, e) => { e.Handled = true; Post(() => NextRequested?.Invoke()); };
        commands.PreviousReceived += (_, e) => { e.Handled = true; Post(() => PreviousRequested?.Invoke()); };
        _poll = new Timer(_ => Do(Poll), null, 200, 200);
    }

    private MediaPlaybackList NewList()
    {
        var list = new MediaPlaybackList { AutoRepeatEnabled = false, ShuffleEnabled = false };
        list.CurrentItemChanged += (_, e) => { int g = Volatile.Read(ref _generation); Do(() => OnItemChanged(e, g)); };
        list.ItemFailed += (_, e) => { int g = Volatile.Read(ref _generation); Do(() => { if (g == Volatile.Read(ref _generation)) Fail(Id(e.Item), Describe(e.Error)); }); };
        return list;
    }

    private void Poll()
    {
        var session = _player.PlaybackSession;
        Volatile.Write(ref _position, session.Position.TotalSeconds);
        _duration = session.NaturalDuration is { TotalSeconds: > 0 } d ? d.TotalSeconds : null;
        // Watchdog: now and then Media Foundation takes a Play() for a list it is still swapping in and never starts.
        // Asked again after 2.5 s; after 6 s the list is attached anew. (Seen about once in 40 loads in the tests.)
        if (_wantPlay && _state == EngineState.Loading && session.PlaybackState is MediaPlaybackState.Paused or MediaPlaybackState.None)
        {
            double waited = (DateTime.UtcNow - _loadingSince).TotalSeconds;
            if (waited > 6 && _nudges < 2) { _nudges = 2; Log.Write($"[engine] play did not start in 6 s: attaching the list again ({_currentId})"); _player.Source = null; _player.Source = _list; _player.Play(); }
            else if (waited > 2.5 && _nudges < 1) { _nudges = 1; Log.Write($"[engine] play did not start in 2.5 s: asking again ({_currentId})"); _player.Play(); }
        }
    }

    /// <summary>Lets go of a song's stream at once: an HTTP connection left open per song (a MediaSource is only closed when
    /// disposed) piles up until Windows' connections to the server run out and the next song waits for one.</summary>
    private static void Release(MediaPlaybackItem? item)
    {
        try { item?.Source?.Dispose(); } catch (Exception ex) { Log.Write($"[engine] release: {ex.Message}"); }
    }

    private static void Release(MediaPlaybackList list)
    {
        foreach (var item in list.Items.ToList()) Release(item);
        list.Items.Clear();
    }

    private static string? Id(MediaPlaybackItem? item) => item?.Source?.CustomProperties.TryGetValue("id", out var id) == true ? id as string : null;

    private int CurrentIndex => _list.CurrentItem is { } item ? _list.Items.IndexOf(item) : 0;

    private void Remember()
    {
        _currentId = Id(_list.CurrentItem) ?? (_list.Items.Count > 0 ? Id(_list.Items[0]) : null);
        int at = CurrentIndex;
        _nextId = _list.Items.Count > at + 1 ? Id(_list.Items[at + 1]) : null;
    }

    private static MediaPlaybackItem Item(EngineItem e)
    {
        var source = MediaSource.CreateFromUri(new Uri(e.Url));
        source.CustomProperties["id"] = e.Id;
        var item = e.StartAt > 0 ? new MediaPlaybackItem(source, TimeSpan.FromSeconds(e.StartAt)) : new MediaPlaybackItem(source);
        var props = item.GetDisplayProperties();
        props.Type = MediaPlaybackType.Music;
        props.MusicProperties.Title = e.Title;
        props.MusicProperties.Artist = e.Artist;
        props.MusicProperties.AlbumTitle = e.Album;
        if (e.CoverUrl is { } cover) props.Thumbnail = RandomAccessStreamReference.CreateFromUri(new Uri(cover));
        item.ApplyDisplayProperties(props);
        return item;
    }

    // ---------------------------------------------------------------- commands (from the UI thread; they return at once)
    /// <summary>Loads a song (and the one after it), and plays it unless <paramref name="autoplay"/> is false.</summary>
    public void Load(EngineItem item, EngineItem? next, bool autoplay)
    {
        Interlocked.Increment(ref _generation);
        _error = null;
        _currentId = item.Id; _nextId = next?.Id;
        Volatile.Write(ref _position, item.StartAt);
        _duration = null;
        SetState(autoplay ? EngineState.Loading : EngineState.Paused);
        Do(() =>
        {
            _wantPlay = autoplay;
            _pendingSeek = item.StartAt;
            _player.Pause();
            // a new list each time: rebuilding the one attached to the player sometimes leaves Play() unanswered
            var list = NewList();
            list.Items.Add(Item(item));
            if (next is not null) list.Items.Add(Item(next));
            var old = _list;
            _list = list;
            _player.Source = list;
            Release(old);
            Remember();
            _nudges = 0;
            _loadingSince = autoplay ? DateTime.UtcNow : DateTime.MaxValue;
            _loadClock = autoplay ? System.Diagnostics.Stopwatch.StartNew() : null; _openedAt = -1;
            if (autoplay) _player.Play();
        });
    }

    // how long the song being loaded took to open and to start (the log)
    private System.Diagnostics.Stopwatch? _loadClock;
    private long _openedAt = -1;

    /// <summary>Replaces what comes after the current song (the queue changed).</summary>
    public void SetNext(EngineItem? next)
    {
        if (next?.Id == _nextId) return;
        _nextId = next?.Id;
        Do(() =>
        {
            if (_list.Items.Count == 0) return;
            int at = CurrentIndex;
            if (next is not null && _list.Items.Count > at + 1 && Id(_list.Items[at + 1]) == next.Id) return;
            while (_list.Items.Count > at + 1) { Release(_list.Items[^1]); _list.Items.RemoveAt(_list.Items.Count - 1); }
            if (next is not null) _list.Items.Add(Item(next));
            Remember();
        });
    }

    public void Play()
    {
        if (_state is EngineState.Error or EngineState.Stopped) return; // the service reloads instead
        SetState(EngineState.Loading);
        Do(() => { _wantPlay = true; _nudges = 0; _loadingSince = DateTime.UtcNow; _player.Play(); });
    }

    public void Pause()
    {
        if (_state is EngineState.Playing or EngineState.Loading) SetState(EngineState.Paused);
        Do(() => { _wantPlay = false; _player.Pause(); });
    }

    public void Stop()
    {
        Interlocked.Increment(ref _generation);
        SetState(EngineState.Stopped);
        _currentId = null; _nextId = null;
        Do(() => { _wantPlay = false; _player.Pause(); var old = _list; _list = NewList(); _player.Source = _list; Release(old); });
    }

    public void Seek(double seconds)
    {
        Volatile.Write(ref _position, Math.Max(0, seconds));
        Do(() => { _pendingSeek = 0; _player.PlaybackSession.Position = TimeSpan.FromSeconds(Math.Max(0, seconds)); });
    }

    public double Volume
    {
        get => Volatile.Read(ref _volume);
        set { double v = Math.Clamp(value, 0, 1); Volatile.Write(ref _volume, v); Do(() => _player.Volume = v); }
    }

    public bool Muted
    {
        get => _muted;
        set { _muted = value; Do(() => _player.IsMuted = value); }
    }

    // ---------------------------------------------------------------- what Media Foundation reports (engine thread)
    /// <summary>A start position given with the song (continuing on another device) once the song is open: the start time a
    /// MediaPlaybackItem is created with is not kept when the song is loaded paused and played later.</summary>
    private void ApplyPendingSeek()
    {
        if (_pendingSeek <= 0) return;
        _player.PlaybackSession.Position = TimeSpan.FromSeconds(_pendingSeek);
        Volatile.Write(ref _position, _pendingSeek);
        _pendingSeek = 0;
    }

    private void OnSessionState(MediaPlaybackState s)
    {
        if (_state == EngineState.Error) return;
        if (s == MediaPlaybackState.Playing) ApplyPendingSeek();
        switch (s)
        {
            case MediaPlaybackState.Playing:
                if (_loadClock is { } c) { Log.Write($"[engine] {_currentId} playing after {c.ElapsedMilliseconds} ms (opened after {_openedAt} ms)"); _loadClock = null; }
                SetState(EngineState.Playing);
                break;
            case MediaPlaybackState.Paused when _state == EngineState.Playing: _wantPlay = false; SetState(EngineState.Paused); break; // the media keys
            case MediaPlaybackState.Opening or MediaPlaybackState.Buffering when _wantPlay: SetState(EngineState.Loading); break;
        }
    }

    private void OnItemChanged(CurrentMediaPlaybackItemChangedEventArgs e, int generation)
    {
        // The list moved on by itself (the song ended): the preloaded next song is playing now. Only for the list as it is
        // (an event from before a new load names an item no longer in it, and must not clear the new one).
        if (generation != Volatile.Read(ref _generation) || e.Reason != MediaPlaybackItemChangedReason.EndOfStream || Id(e.NewItem) is not { } id) return;
        if (e.NewItem is null || _list.Items.IndexOf(e.NewItem) < 0) return;
        while (_list.Items.Count > 0 && _list.Items[0] != e.NewItem) { Release(_list.Items[0]); _list.Items.RemoveAt(0); }
        Remember();
        Volatile.Write(ref _position, 0);
        Post(generation, () => Advanced?.Invoke(id));
    }

    private void Fail(string? id, string message)
    {
        if (id is not null && id != _currentId)
        {
            // the preloaded next song failed: dropped now, loaded again (and reported) when its turn comes
            int at = CurrentIndex;
            while (_list.Items.Count > at + 1) { Release(_list.Items[^1]); _list.Items.RemoveAt(_list.Items.Count - 1); }
            Remember();
            return;
        }
        _error = message;
        _wantPlay = false;
        _player.Pause();
        SetState(EngineState.Error);
    }

    private static string Describe(MediaPlaybackItemError e) => e.ErrorCode switch
    {
        MediaPlaybackItemErrorCode.NetworkError => "网络错误，服务器没有给出音频",
        MediaPlaybackItemErrorCode.DecodeError => "解码失败",
        MediaPlaybackItemErrorCode.SourceNotSupportedError => "格式不受支持或文件无法读取",
        MediaPlaybackItemErrorCode.EncryptionError => "文件受保护",
        _ => e.ExtendedError?.Message ?? "未知错误",
    };

    private void SetState(EngineState s)
    {
        if (_state == s) return;
        _state = s;
        Post(() => StateChanged?.Invoke());
    }

    // ---------------------------------------------------------------- output devices
    public static async Task<List<OutputDevice>> OutputDevicesAsync()
    {
        string? defaultId = MediaDevice.GetDefaultAudioRenderId(AudioDeviceRole.Default);
        var devices = await DeviceInformation.FindAllAsync(MediaDevice.GetAudioRenderSelector());
        return [new OutputDevice("", "系统默认设备", true), .. devices.Select(d => new OutputDevice(d.Id, d.Name, d.Id == defaultId))];
    }

    /// <summary>Plays to a device; "" or null follows Windows' default.</summary>
    public async Task SetOutputAsync(string? deviceId)
    {
        var device = string.IsNullOrEmpty(deviceId) ? null : await DeviceInformation.CreateFromIdAsync(deviceId);
        var done = new TaskCompletionSource();
        Do(() => { try { _player.AudioDevice = device; done.SetResult(); } catch (Exception ex) { done.SetException(ex); } });
        await done.Task;
    }

    public void Dispose()
    {
        Interlocked.Increment(ref _generation);
        Do(() => { _poll?.Dispose(); _player.Pause(); _player.Source = null; Release(_list); _player.Dispose(); });
        _work.CompleteAdding(); // the engine thread finishes what is queued (releasing the player), then ends
    }
}
