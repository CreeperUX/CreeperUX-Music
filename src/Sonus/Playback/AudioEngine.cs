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
    private double _startAt; // where the song being loaded starts (the watchdog in Poll)
    // A song loaded to play from a position plays once it is open and there (SeekCompleted), as a song loaded paused and
    // played later does. Played at once, Media Foundation's FLAC decoder starts from the beginning, and the seek once open
    // fails it (DecodeError): a song taken over from another device mid-song was skipped (the owner's FLACs, 0.7.0).
    private bool _playWhenOpen;
    private DateTime _loadingSince = DateTime.MaxValue; // a play that has not started yet (the watchdog in Poll)
    private int _nudges;

    // read by the UI thread, written by the engine thread
    private volatile EngineState _state = EngineState.Stopped;
    private volatile string? _currentId, _nextId, _error;
    private double _position, _volume = 1;
    private double? _duration;
    private double? _staleDuration; // the song before a gapless change: the session can report its length for a while
    private volatile bool _muted;
    /// <summary>A test instance that must not be heard (SONUS_E2E_SILENT=1, set by tools/e2e): its player stays muted, whatever
    /// the app's own volume and mute say (the tests read those, and set them).</summary>
    private static readonly bool Silent = Environment.GetEnvironmentVariable("SONUS_E2E_SILENT") == "1";
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
        _player = new MediaPlayer { AudioCategory = MediaPlayerAudioCategory.Media, AutoPlay = false, Volume = _volume, IsMuted = _muted || Silent };
        _list = NewList();
        _player.Source = _list;
        _player.MediaOpened += (_, _) => Do(() =>
        {
            if (_loadClock is { } c && _openedAt < 0) _openedAt = c.ElapsedMilliseconds;
            bool moving = _pendingSeek > 0;
            ApplyPendingSeek();
            if (!moving) PlayWhenOpen(); // nowhere to move to: now
        });
        // the move to a loaded song's start position is done: it plays now
        _player.PlaybackSession.SeekCompleted += (_, _) => Do(PlayWhenOpen);
        _player.MediaEnded += (_, _) =>
        {
            int g = Volatile.Read(ref _generation);
            Do(() => { if (g == Volatile.Read(ref _generation) && _state != EngineState.Error) { SetState(EngineState.Stopped); Post(g, () => Ended?.Invoke()); } });
        };
        _player.MediaFailed += (_, e) =>
        {
            int g = Volatile.Read(ref _generation);
            var error = e.Error;
            string message = e.ErrorMessage is { Length: > 0 } m ? m : error.ToString();
            Do(() =>
            {
                if (g != Volatile.Read(ref _generation)) return;
                // The player's failure names no song. While the current one plays on, it is not that song's: a list just
                // replaced (its sources are released) or the preloaded next one can raise it. A song that really fails stops.
                if (_player.PlaybackSession.PlaybackState == MediaPlaybackState.Playing && _state == EngineState.Playing)
                {
                    Log.Write($"[engine] a failure ({error}) while {_currentId} plays on: not this song's, ignored");
                    return;
                }
                Log.Write($"[engine] {_currentId} failed ({error})");
                Fail(_currentId, message);
            });
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
        // a list replaced by a newer one (its sources released) can still report a failure: only the attached list's count
        list.ItemFailed += (_, e) =>
        {
            string? id = Id(e.Item);
            var error = e.Error;
            Do(() =>
            {
                if (!ReferenceEquals(list, _list)) { Log.Write($"[engine] {id} failed in a list no longer playing ({error.ErrorCode}): ignored"); return; }
                Log.Write($"[engine] {id} failed ({error.ErrorCode}){(id != _currentId ? ", the preloaded next song" : "")}");
                Fail(id, Describe(error));
            });
        };
        return list;
    }

    private void Poll()
    {
        var session = _player.PlaybackSession;
        Volatile.Write(ref _position, session.Position.TotalSeconds);
        _duration = CurrentDuration(session);
        // Watchdog: now and then Media Foundation takes a Play() for a list it is still swapping in and never starts.
        // Asked again after 2.5 s; after 6 s the list is attached anew. (Seen about once in 40 loads in the tests.)
        if (_wantPlay && _state == EngineState.Loading && session.PlaybackState is MediaPlaybackState.Paused or MediaPlaybackState.None)
        {
            double waited = (DateTime.UtcNow - _loadingSince).TotalSeconds;
            // A song from a position, open and moved there, waits for its stream to get that far (Media Foundation reads a
            // FLAC from the start: seconds for a song taken over late in it): asked again, never attached again (a list
            // attached again after that move fails the song, DecodeError). One not yet open is not played before it is.
            bool moved = _startAt > 0 && !_playWhenOpen;
            if (waited > 6 && _nudges < 2 && moved) { _nudges = 2; Log.Write($"[engine] play did not start in 6 s from {_startAt:0} s: asking again, the stream is still on its way ({_currentId})"); _player.Play(); }
            else if (waited > 6 && _nudges < 2) { _nudges = 2; Log.Write($"[engine] play did not start in 6 s: attaching the list again ({_currentId})"); _player.Source = null; _player.Source = _list; if (!_playWhenOpen) _player.Play(); }
            else if (waited > 2.5 && _nudges < 1) { _nudges = 1; Log.Write($"[engine] play did not start in 2.5 s: asking again ({_currentId}{(moved ? $", from {_startAt:0} s" : "")})"); if (!_playWhenOpen) _player.Play(); }
        }
    }

    /// <summary>The current song's length: its own source's when known; else the session's, unless that is still the length
    /// of the song before a gapless change (Media Foundation can keep reporting it for a while after the switch).</summary>
    private double? CurrentDuration(MediaPlaybackSession session)
    {
        var item = _list.CurrentItem ?? (_list.Items.Count > 0 ? _list.Items[0] : null);
        if (item is not null && Id(item) == _currentId && item.Source?.Duration is { TotalSeconds: > 0 } own) { _staleDuration = null; return own.TotalSeconds; }
        if (session.NaturalDuration is not { TotalSeconds: > 0 } natural) return null;
        if (_staleDuration is { } stale && Math.Abs(natural.TotalSeconds - stale) < 0.01) return null;
        _staleDuration = null;
        return natural.TotalSeconds;
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
        // no start time on the item: the position it starts from is set once it is open (ApplyPendingSeek). Both together
        // added up (a song taken over 172 s in started at 344 s, past its end, and the next one played at once).
        var item = new MediaPlaybackItem(source);
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
        _duration = null; _staleDuration = null;
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
            // from the start: played at once; from a position: once open and there (_playWhenOpen)
            _startAt = item.StartAt;
            _playWhenOpen = autoplay && item.StartAt > 0;
            if (autoplay && !_playWhenOpen) _player.Play();
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
        Do(() =>
        {
            _wantPlay = true; _nudges = 0; _loadingSince = DateTime.UtcNow;
            if (_pendingSeek > 0) _playWhenOpen = true; // loaded paused from a position, not yet open: played once open and there
            if (!_playWhenOpen) _player.Play();
        });
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
        Do(() => { _wantPlay = false; _playWhenOpen = false; _startAt = 0; _player.Pause(); var old = _list; _list = NewList(); _player.Source = _list; Release(old); });
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
        set { _muted = value; Do(() => _player.IsMuted = value || Silent); }
    }

    // ---------------------------------------------------------------- what Media Foundation reports (engine thread)
    /// <summary>A song loaded to play from a position (<see cref="_playWhenOpen"/>): played now, open and moved there.</summary>
    private void PlayWhenOpen()
    {
        if (!_playWhenOpen) return;
        _playWhenOpen = false;
        if (_wantPlay) _player.Play();
    }

    /// <summary>A start position given with the song (taking it over on another device, continuing where it stopped), set
    /// once the song is open; the only place it is set (a start time on the MediaPlaybackItem too would add up with it, and
    /// is not kept anyway when the song is loaded paused and played later).</summary>
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
                _startAt = 0; // it plays: no longer a song waiting to reach its start position
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
        // the previous song's length is not this one's (and the session may report it for a while yet)
        _staleDuration = _duration;
        _duration = null;
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
