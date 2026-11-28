using System.Collections.Concurrent;
using Microsoft.UI.Dispatching;
using Sonus.Core.Audio;
using Windows.Devices.Enumeration;
using Windows.Media;
using Windows.Media.Core;
using Windows.Media.Playback;
using Windows.Storage.Streams;

namespace Sonus.Playback;

/// <summary>
/// Legacy playback backend built on Windows' MediaPlayer + MediaPlaybackList (Media Foundation).
/// Preserved verbatim alongside <see cref="NativeAudioBackend"/> so the user can switch back at any time
/// in Settings -> Advanced if a track or device hits an issue, and as an automatic per-track fallback for
/// formats outside the built-in decoders (such as original M4A/AAC/ALAC files).
/// </summary>
internal sealed class LegacyAudioBackend : IAudioBackend
{
    private readonly DispatcherQueue _ui;
    private readonly BlockingCollection<Action> _work = [];
    private readonly Thread _thread;
    private MediaPlayer _player = null!;
    private MediaPlaybackList _list = null!;
    private Timer? _poll;
    private bool _wantPlay;
    private double _pendingSeek;
    private double _startAt;
    // A song loaded to play from a position plays once it is open and there (SeekCompleted), as a song loaded paused and
    // played later does. Played at once, Media Foundation's FLAC decoder starts from the beginning, and the seek once open
    // fails it (DecodeError): a song taken over from another device mid-song was skipped (the owner's FLACs, 0.7.0).
    private bool _playWhenOpen;
    private DateTime _loadingSince = DateTime.MaxValue;
    private int _nudges;

    private volatile EngineState _state = EngineState.Stopped;
    private volatile string? _currentId, _nextId, _error;
    private double _position, _volume = 1, _gainMultiplier = 1;
    private double? _duration;
    private double? _staleDuration;
    private volatile bool _muted;
    private static readonly bool Silent = Environment.GetEnvironmentVariable("SONUS_E2E_SILENT") == "1";
    private int _generation;

    private System.Diagnostics.Stopwatch? _loadClock;
    private long _openedAt = -1;

    public LegacyAudioBackend(DispatcherQueue ui)
    {
        _ui = ui;
        _thread = new Thread(Run) { IsBackground = true, Name = "audio engine (legacy)" };
        _thread.SetApartmentState(ApartmentState.MTA);
        _thread.Start();
        Do(Create);
    }

    public EngineState State => _state;
    public string? CurrentId => _currentId;
    public string? NextId => _nextId;
    public double Position => Volatile.Read(ref _position);
    public double? Duration => _duration;
    public string? Error => _error;
    public StreamMetadata? ActiveStream => null;

    public event Action? StateChanged;
    public event Action<string>? Advanced;
    public event Action? Ended;
    public event Action? NextRequested, PreviousRequested;

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
        catch (InvalidOperationException) { /* disposed */ }
    }

    private void Post(int generation, Action action) => Post(() => { if (generation == Volatile.Read(ref _generation)) action(); });
    private void Post(Action action) => _ui.TryEnqueue(() => { try { action(); } catch (Exception ex) { Log.Write($"[engine ui] {ex}"); } });

    private double EffectivePlayerVolume => Math.Clamp(Volatile.Read(ref _volume) * Volatile.Read(ref _gainMultiplier), 0, 1);

    private void Create()
    {
        _player = new MediaPlayer { AudioCategory = MediaPlayerAudioCategory.Media, AutoPlay = false, Volume = EffectivePlayerVolume, IsMuted = _muted || Silent };
        _list = NewList();
        _player.Source = _list;
        _player.MediaOpened += (_, _) => Do(() =>
        {
            if (_loadClock is { } c && _openedAt < 0) _openedAt = c.ElapsedMilliseconds;
            bool moving = _pendingSeek > 0;
            ApplyPendingSeek();
            if (!moving) PlayWhenOpen();
        });
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
        if (_wantPlay && _state == EngineState.Loading && session.PlaybackState is MediaPlaybackState.Paused or MediaPlaybackState.None)
        {
            double waited = (DateTime.UtcNow - _loadingSince).TotalSeconds;
            bool moved = _startAt > 0 && !_playWhenOpen;
            if (waited > 6 && _nudges < 2 && moved) { _nudges = 2; Log.Write($"[engine] play did not start in 6 s from {_startAt:0} s: asking again, the stream is still on its way ({_currentId})"); _player.Play(); }
            else if (waited > 6 && _nudges < 2) { _nudges = 2; Log.Write($"[engine] play did not start in 6 s: attaching the list again ({_currentId})"); _player.Source = null; _player.Source = _list; if (!_playWhenOpen) _player.Play(); }
            else if (waited > 2.5 && _nudges < 1) { _nudges = 1; Log.Write($"[engine] play did not start in 2.5 s: asking again ({_currentId}{(moved ? $", from {_startAt:0} s" : "")})"); if (!_playWhenOpen) _player.Play(); }
        }
    }

    private double? CurrentDuration(MediaPlaybackSession session)
    {
        var item = _list.CurrentItem ?? (_list.Items.Count > 0 ? _list.Items[0] : null);
        if (item is not null && Id(item) == _currentId && item.Source?.Duration is { TotalSeconds: > 0 } own) { _staleDuration = null; return own.TotalSeconds; }
        if (session.NaturalDuration is not { TotalSeconds: > 0 } natural) return null;
        if (_staleDuration is { } stale && Math.Abs(natural.TotalSeconds - stale) < 0.01) return null;
        _staleDuration = null;
        return natural.TotalSeconds;
    }

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
            _startAt = item.StartAt;
            _playWhenOpen = autoplay && item.StartAt > 0;
            if (autoplay && !_playWhenOpen) _player.Play();
        });
    }

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
        if (_state is EngineState.Error or EngineState.Stopped) return;
        SetState(EngineState.Loading);
        Do(() =>
        {
            _wantPlay = true; _nudges = 0; _loadingSince = DateTime.UtcNow;
            if (_pendingSeek > 0) _playWhenOpen = true;
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
        set { double v = Math.Clamp(value, 0, 1); Volatile.Write(ref _volume, v); Do(() => _player.Volume = EffectivePlayerVolume); }
    }

    public double GainMultiplier
    {
        get => Volatile.Read(ref _gainMultiplier);
        set { double g = Math.Max(0, value); Volatile.Write(ref _gainMultiplier, g); Do(() => _player.Volume = EffectivePlayerVolume); }
    }

    public bool Muted
    {
        get => _muted;
        set { _muted = value; Do(() => _player.IsMuted = value || Silent); }
    }

    private void PlayWhenOpen()
    {
        if (!_playWhenOpen) return;
        _playWhenOpen = false;
        if (_wantPlay) _player.Play();
    }

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
                _startAt = 0;
                if (_loadClock is { } c) { Log.Write($"[engine] {_currentId} playing (legacy) after {c.ElapsedMilliseconds} ms (opened after {_openedAt} ms)"); _loadClock = null; }
                SetState(EngineState.Playing);
                break;
            case MediaPlaybackState.Paused when _state == EngineState.Playing: _wantPlay = false; SetState(EngineState.Paused); break;
            case MediaPlaybackState.Opening or MediaPlaybackState.Buffering when _wantPlay: SetState(EngineState.Loading); break;
        }
    }

    private void OnItemChanged(CurrentMediaPlaybackItemChangedEventArgs e, int generation)
    {
        if (generation != Volatile.Read(ref _generation) || e.Reason != MediaPlaybackItemChangedReason.EndOfStream || Id(e.NewItem) is not { } id) return;
        if (e.NewItem is null || _list.Items.IndexOf(e.NewItem) < 0) return;
        while (_list.Items.Count > 0 && _list.Items[0] != e.NewItem) { Release(_list.Items[0]); _list.Items.RemoveAt(0); }
        Remember();
        Volatile.Write(ref _position, 0);
        _staleDuration = _duration;
        _duration = null;
        Post(generation, () => Advanced?.Invoke(id));
    }

    private void Fail(string? id, string message)
    {
        if (id is not null && id != _currentId)
        {
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
        _work.CompleteAdding();
    }
}
