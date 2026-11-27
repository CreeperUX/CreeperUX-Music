using System.Text.Json;
using Sonus.Core;
using Sonus.Core.Connect;
using Sonus.Playback;
using Microsoft.UI.Dispatching;

namespace Sonus.Services;

public enum PlayerState { Stopped, Loading, Playing, Paused, Error }

/// <summary>A message for the bottom of the window, with an optional action.</summary>
public sealed record ToastMessage(string Text, bool IsError = false, string? ActionLabel = null, Action? Action = null);

/// <summary>
/// Everything the window shows and does with the music: the server (client), the library and playlists, the queue, the
/// player. Lives on the UI thread; every event is raised there. Pages read it and call it. What it shows is what the server
/// and the engine report, except a like: that shows at once and goes back if the server refuses it.
/// With Sonus Connect version 2 (<see cref="Session"/>) the queue and what plays are the user's session on the server: the
/// actions below become its commands, what it shows is the session, and the engine plays only while this device is the
/// session's active device.
/// </summary>
public sealed class MusicService : IDisposable
{
    /// <summary>Services not yet disposed (tests check a sign-out leaves none behind).</summary>
    public static int Alive;
    private bool _disposed;
    private readonly DispatcherQueue _ui;
    private readonly AppSettings _settings;
    private readonly DispatcherQueueTimer _tick;
    private DateTimeOffset _started;
    private bool _counted;
    private DateTimeOffset _savedAt = DateTimeOffset.MinValue, _refreshedAt = DateTimeOffset.MinValue;
    private DispatcherQueueTimer? _saveTimer;

    public MusicService(SubsonicClient client, AppSettings settings, DispatcherQueue ui)
    {
        Client = client; _settings = settings; _ui = ui;
        Interlocked.Increment(ref Alive);
        Queue = new PlayQueue(id => Library.Track(id)) { Order = settings.Order };
        Engine = new AudioEngine(ui) { Volume = settings.Volume, Muted = settings.Muted };
        Engine.StateChanged += OnEngineState;
        Engine.Advanced += OnAdvanced;
        Engine.Ended += OnEnded;
        Engine.NextRequested += () => Next();
        Engine.PreviousRequested += () => Previous();
        Queue.Changed += (_, _) => { QueueChanged?.Invoke(); RefreshPreload(); ScheduleSave(); };
        client.ConnectionChanged += OnConnection;
        _tick = ui.CreateTimer();
        _tick.Interval = TimeSpan.FromMilliseconds(250);
        _tick.Tick += (_, _) => UiThread.Run("the player's tick", OnTick);
        _tick.Start();
        ReplayGain = settings.ReplayGain;
    }

    private void OnConnection(object? sender, bool online) => UiThread.Post(_ui, "server reachable", () => { if (_disposed) return; IsOnline = online; ConnectionChanged?.Invoke(); });

    /// <summary>Stops everything this session runs (the player, its thread, the timers) and lets go of the window's handlers:
    /// a signed-out or failed session must not keep playing or saving the queue.</summary>
    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _tick.Stop();
        _saveTimer?.Stop();
        Client.ConnectionChanged -= OnConnection;
        LibraryChanged = PlaylistsChanged = PlayerChanged = QueueChanged = ConnectionChanged = null;
        TrackChanged = null; PositionChanged = null; Toast = null;
        Engine.Stop();
        Engine.Dispose();
        Interlocked.Decrement(ref Alive);
    }

    public SubsonicClient Client { get; }
    public AudioEngine Engine { get; }
    public PlayQueue Queue { get; }
    public ServerInfo Server { get; private set; } = new("Navidrome", "Navidrome", SubsonicClient.ApiVersion, false);
    public LibrarySnapshot Library { get; private set; } = LibrarySnapshot.Empty;
    public List<Playlist> Playlists { get; private set; } = [];
    public bool IsOnline { get; private set; } = true;

    public Track? Current => Library.Track(Queue.Current);
    public PlayerState State { get; private set; } = PlayerState.Stopped;
    public string? Error { get; private set; }
    public double Position { get; private set; }
    /// <summary>The current song's length: the library's (the engine's only when the library has none; while another device
    /// plays, the session's).</summary>
    public double Duration => Elsewhere ? (_session is { DurationMs: > 0 } s ? s.DurationMs / 1000.0 : Current?.Duration ?? 0)
        : Current is { Duration: > 0 } t ? t.Duration : Engine.CurrentId == Current?.Id ? Engine.Duration ?? 0 : 0;
    public double Volume { get; private set; }
    public bool Muted => Engine.Muted;
    public ReplayGainMode ReplayGain { get; private set; }
    public string OutputId => _settings.OutputDeviceId ?? "";
    public bool IsActive => State is PlayerState.Playing or PlayerState.Loading;

    public event Action? LibraryChanged, PlaylistsChanged, PlayerChanged, QueueChanged, ConnectionChanged;
    /// <summary>A song's like, play count or last played changed.</summary>
    public event Action<Track>? TrackChanged;
    public event Action<double>? PositionChanged;
    public event Action<ToastMessage>? Toast;

    // ---------------------------------------------------------------- start and stay in step
    public async Task StartAsync()
    {
        var clock = System.Diagnostics.Stopwatch.StartNew();
        Server = await Client.ConnectAsync();
        long connected = clock.ElapsedMilliseconds;
        // the library and the playlists at the same time (songs of playlists are matched against the library afterwards)
        var library = Client.LoadLibraryAsync();
        var playlists = Client.GetPlaylistsAsync(Remember);
        try { Library = await library; }
        catch { _ = playlists.ContinueWith(p => _ = p.Exception, TaskScheduler.Default); throw; } // its failure is not ours to report
        long loaded = clock.ElapsedMilliseconds;
        var server = await playlists;
        MergeUnknown();
        Playlists = [LikedPlaylist(), LibraryPlaylist(), .. server];
        Log.Write($"[start] connected in {connected} ms, library in {loaded - connected} ms, playlists done at {clock.ElapsedMilliseconds} ms");
        _refreshedAt = DateTimeOffset.Now;
        Volume = _settings.Volume;
        ApplyVolume();
        if (!string.IsNullOrEmpty(_settings.OutputDeviceId))
        {
            try { await Engine.SetOutputAsync(_settings.OutputDeviceId); } catch (Exception ex) { Log.Write($"output device gone: {ex.Message}"); _settings.OutputDeviceId = null; }
        }
    }

    private readonly System.Collections.Concurrent.ConcurrentQueue<JsonElement> _unknown = new(); // no lock: the UI thread takes them (UiSynchronizationContext)

    /// <summary>A song from a playlist, the play queue or a radio: called by the client on any thread. Songs the library does
    /// not have are kept aside and added by <see cref="MergeUnknown"/> on the UI thread, all at once.</summary>
    private string Remember(JsonElement song)
    {
        string id = song.GetProperty("id").GetString()!;
        if (!Library.TrackById.ContainsKey(id)) _unknown.Enqueue(song.Clone());
        return id;
    }

    /// <summary>Adds the songs <see cref="Remember"/> kept aside to the library (one regrouping, on the UI thread).</summary>
    private void MergeUnknown()
    {
        List<JsonElement> songs = [];
        while (_unknown.TryDequeue(out var song)) songs.Add(song);
        // songs set aside while the library was still loading are mostly in it now: only the rest are read
        songs = songs.Where(s => !Library.TrackById.ContainsKey(s.GetProperty("id").GetString()!)).ToList();
        if (songs.Count == 0) return;
        var albums = Library.AlbumById.ToDictionary(x => x.Key, x => x.Value);
        var added = songs.Select(s => LibraryBuilder.TrackOf(s, albums)).DistinctBy(t => t.Id).ToList();
        if (added.Count == 0) return;
        Library = LibraryBuilder.Group([.. Library.Tracks, .. added], albums);
        Log.Write($"[library] {added.Count} songs from playlists or the queue were not in the library: added");
    }

    private Playlist LikedPlaylist() => new()
    {
        Id = "liked", Name = "我喜欢的音乐", Kind = PlaylistKind.Liked, Owner = Client.Login.User,
        Entries = Library.Tracks.Where(t => t.Liked).OrderByDescending(t => t.StarredAt ?? DateTimeOffset.MinValue).Select(t => t.Id).ToList(),
    };
    private Playlist LibraryPlaylist() => new()
    {
        Id = "library", Name = "媒体库 · 全部歌曲", Kind = PlaylistKind.Library, Owner = Server.Name,
        Comment = $"{Server.Name} 媒体库（{new Uri(Client.Login.Server).Authority}）", Entries = Library.Tracks.Select(t => t.Id).ToList(),
    };
    private void RebuildSpecialPlaylists()
    {
        Playlists = [LikedPlaylist(), LibraryPlaylist(), .. Playlists.Where(p => p.Kind is PlaylistKind.User or PlaylistKind.ReadOnly)];
        PlaylistsChanged?.Invoke();
    }

    public Playlist? Playlist(string id) => Playlists.FirstOrDefault(p => p.Id == id);

    /// <summary>Reads the playlists again, and the library when the server's song count changed (another device, a rescan).</summary>
    public async Task RefreshAsync()
    {
        _refreshedAt = DateTimeOffset.Now;
        try
        {
            if (await Client.SongCountAsync() is { } n && n != Library.Tracks.Count)
            {
                Library = await Client.LoadLibraryAsync();
                LibraryChanged?.Invoke();
            }
            var server = await Client.GetPlaylistsAsync(Remember);
            MergeUnknown();
            Playlists = [LikedPlaylist(), LibraryPlaylist(), .. server];
            PlaylistsChanged?.Invoke();
        }
        catch (Exception ex) when (ex is ServerUnreachableException or SubsonicException) { Log.Write($"refresh: {ex.Message}"); }
    }

    /// <summary>The window came to the front: refresh at most once a minute.</summary>
    public void OnActivated()
    {
        if (DateTimeOffset.Now - _refreshedAt > TimeSpan.FromMinutes(1)) _ = RefreshAsync();
    }

    public async Task GoOnlineAsync()
    {
        try { await Client.ConnectAsync(); await RefreshAsync(); }
        catch (Exception ex) when (ex is ServerUnreachableException or SubsonicException) { Toast?.Invoke(new(ex.Message, true)); }
    }

    // ---------------------------------------------------------------- playing
    /// <summary>The songs of a context: an album, a playlist, an artist, a genre, the library.</summary>
    public (PlayContext Context, IReadOnlyList<string> Ids) ContextOf(string kind, string id, IReadOnlyList<string>? ids = null)
    {
        switch (kind)
        {
            case "album": { var a = Library.Album(id); return (new(kind, id, a?.Title ?? ""), ids ?? a?.TrackIds ?? []); }
            case "playlist": { var p = Playlist(id); return (new(kind, id, p?.Name ?? ""), ids ?? p?.TrackIds ?? []); }
            case "artist": return (new(kind, id, Library.Artist(id)?.Name ?? ""), ids ?? Library.ArtistTracks(id));
            case "genre": return (new(kind, id, id), ids ?? Library.Tracks.Where(t => t.Genre == id).Select(t => t.Id).ToList());
            case "search": return (new(kind, id, $"搜索“{id}”"), ids ?? []);
            default: return (new("library", "all", "媒体库"), ids ?? Library.Tracks.Select(t => t.Id).ToList());
        }
    }

    public bool IsContext(string kind, string id) => Queue.Context is { } c && c.Kind == kind && c.Id == id;
    public bool IsContextPlaying(string kind, string id) => IsContext(kind, id) && IsActive;

    public void PlayContext(string kind, string id, string? trackId = null, bool shuffle = false, IReadOnlyList<string>? ids = null)
    {
        var (context, list) = ContextOf(kind, id, ids);
        Play(context, list, trackId, shuffle);
    }

    public void Play(PlayContext context, IReadOnlyList<string> ids, string? trackId = null, bool shuffle = false)
    {
        if (Session is { } session) { session.PlayContext(context, ids, trackId, shuffle); return; }
        _failures = 0;
        if (Queue.Start(context, ids, trackId, shuffle) is { } start)
        {
            SaveOrder();
            Load(start, autoplay: true);
        }
    }

    /// <summary>Play / pause a context's big button: pauses it when it is the one playing.</summary>
    public void TogglePlayContext(string kind, string id)
    {
        if (IsContext(kind, id)) { if (IsActive) Pause(); else Resume(); }
        else PlayContext(kind, id);
    }

    public void TogglePlay()
    {
        if (Current is null) { PlayContext("playlist", Playlist("liked")?.Entries.Count > 0 ? "liked" : "library"); return; }
        if (IsActive) Pause(); else Resume();
    }

    private EngineItem ItemFor(Track t, double startAt = 0)
    {
        // Media Foundation decodes FLAC, ALAC, AAC, MP3, WAV, Opus/Vorbis (Windows' web media extensions); the rest is
        // asked for as MP3, which every server can transcode to (Navidrome's default transcodings include it)
        string? transcode = t.Suffix is "dsf" or "dff" or "ape" or "wv" or "tta" or "tak" or "mpc" or "wma" ? "mp3" : null;
        string? cover = (Library.Album(t.AlbumId)?.CoverArt ?? t.CoverArt) is { } art ? Client.CoverUrl(art, 512) : null;
        return new EngineItem(t.Id, Client.StreamUrl(t.Id, transcode), t.Title, t.Artist, t.Album, cover, startAt);
    }

    private void Load(string trackId, bool autoplay, double at = 0)
    {
        if (Library.Track(trackId) is not { } t) { SetState(PlayerState.Error, "这首歌已不在媒体库中。"); return; }
        _counted = false;
        _started = DateTimeOffset.Now;
        Position = at;
        Error = null;
        ApplyVolume(t);
        Engine.Load(ItemFor(t, at), PreloadFor(trackId), autoplay);
        SetState(autoplay ? PlayerState.Loading : PlayerState.Paused);
        PositionChanged?.Invoke(at);
    }

    /// <summary>What to load after <paramref name="current"/>: what the queue (or the session) says follows.</summary>
    private EngineItem? PreloadFor(string current) =>
        (Session is not null ? _session?.Next : Queue.Peek()) is { } n && n != current && Library.Track(n) is { } nt ? ItemFor(nt) : null;

    private void RefreshPreload()
    {
        if (Current is null || Engine.CurrentId != Queue.Current) return;
        Engine.SetNext(PreloadFor(Queue.Current!));
    }

    private void OnEnded()
    {
        if (Session is { } s) { if (s.IsActiveHere && _engineKey is { } key) s.Report("ended", key, Duration); return; } // the session says what follows
        if (Queue.Next(ended: true) is { } id) Load(id, autoplay: true); else Stop();
    }

    private void OnAdvanced(string id)
    {
        if (Session is { } s)
        {
            // the engine went on by itself to the preloaded song (gapless): the session moves there on the report
            if (!s.IsActiveHere) return;
            if (_engineKey is { } key) s.Report("ended", key, Duration);
            _advancedTo = id;
            if (!s.IsConnected && Queue.Peek() == id) Queue.Next(ended: true); // shown at once while the server can't be told
            _counted = false;
            _started = DateTimeOffset.Now;
            ApplyVolume(Library.Track(id));
            SetState(PlayerState.Playing);
            NowPlaying(Library.Track(id));
            return;
        }
        // The engine moved on by itself (gapless): move the queue there too, then load what comes after
        if (Queue.Peek() == id) Queue.Next(ended: true);
        else if (Queue.Current != id) { Load(Queue.Next(ended: true) ?? id, autoplay: true); return; }
        _counted = false;
        _started = DateTimeOffset.Now;
        ApplyVolume(Current);
        SetState(PlayerState.Playing);
        NowPlaying();
    }

    private void OnEngineState()
    {
        switch (Engine.State)
        {
            case EngineState.Playing:
                _failures = 0;
                bool started = State is PlayerState.Loading;
                SetState(PlayerState.Playing);
                if (started) NowPlaying();
                SayHere("playing");
                break;
            case EngineState.Paused: SetState(PlayerState.Paused); ScheduleSave(soon: true); SayHere("paused"); break;
            case EngineState.Loading: SetState(PlayerState.Loading); break;
            case EngineState.Error:
                if (Session is null && SkipUnplayable()) break;
                SetState(PlayerState.Error, $"无法播放“{Current?.Title}”：{Engine.Error}");
                SayHere("failed"); // with a session: the server skips it and says so
                break;
            case EngineState.Stopped when State is not PlayerState.Error: break; // Ended decides what follows
        }
    }

    private int _failures; // songs in a row that could not play

    /// <summary>A song that can't play is skipped, as Spotify does (the next song: repeat one does not loop on it), with a
    /// toast that names it; after five in a row, or at the end, it stops on the error with 重试. True when it skipped.</summary>
    private bool SkipUnplayable()
    {
        string name = Current is { } t ? $"“{t.Title}”" : "这首歌";
        if (++_failures >= 5)
        {
            Toast?.Invoke(new($"无法播放{name}；连续 {_failures} 首都无法播放，已停止播放。", true));
            return false;
        }
        if (Queue.Next() is not { } next) return false;
        Toast?.Invoke(new($"无法播放{name}，已跳到下一首。"));
        Load(next, autoplay: true);
        return true;
    }

    private void NowPlaying(Track? song = null)
    {
        if ((song ?? Current) is { } t) _ = Quietly(() => Client.ScrobbleAsync(t.Id, submission: false));
        ScheduleSave(soon: true);
    }

    private void OnTick()
    {
        if (_disposed) return;
        if (Elsewhere)
        {
            // another device plays (or none): the session's position, moving on while it plays there
            if (State == PlayerState.Playing && _session is { } s) { Position = s.PositionAt(Session!.ServerNow) / 1000.0; PositionChanged?.Invoke(Position); }
            return;
        }
        if (Session is not null && _sayPositionAt > 0 && Environment.TickCount64 >= _sayPositionAt) { _sayPositionAt = 0; SayHere("position"); } // a seek done
        if (State != PlayerState.Playing) return;
        Position = Engine.Position;
        PositionChanged?.Invoke(Position);
        double d = Duration;
        if (!_counted && d > 0 && Position >= Math.Min(240, d / 2) && Current is { } t)
        {
            _counted = true; // a play counts past half the song or four minutes
            _ = CountPlay(t, _started);
        }
        if (DateTimeOffset.Now - _savedAt > TimeSpan.FromSeconds(30)) ScheduleSave(soon: true); // the position, for another device
        if (Session is not null && Environment.TickCount64 - _saidAt > 30_000) SayHere("position"); // at least every 30 s
    }

    private async Task CountPlay(Track t, DateTimeOffset started)
    {
        try
        {
            await Client.ScrobbleAsync(t.Id, submission: true, started);
            t.PlayCount++;
            t.LastPlayed = DateTimeOffset.Now;
            TrackChanged?.Invoke(t);
        }
        catch (Exception ex) when (ex is ServerUnreachableException or SubsonicException) { Log.Write($"scrobble: {ex.Message}"); }
    }

    public void Pause()
    {
        if (Command("pause", engineOffline: true)) return;
        Engine.Pause(); SetState(PlayerState.Paused); ScheduleSave(soon: true);
    }

    public void Resume()
    {
        if (Session is { } s)
        {
            // a song that failed here: tried again here
            if (s.IsActiveHere && State == PlayerState.Error && Queue.Current is { } again) { Load(again, autoplay: true, at: Position); return; }
            if (Command("play", engineOffline: true)) return;
        }
        if (Queue.Current is not { } id) return;
        _failures = 0;
        if (State is PlayerState.Error or PlayerState.Stopped || Engine.CurrentId != id) { Load(id, autoplay: true, at: State == PlayerState.Stopped ? 0 : Position); return; }
        Engine.Play();
        SetState(PlayerState.Loading);
    }

    public void Next()
    {
        if (Command("next")) return;
        _failures = 0;
        if (Queue.Next() is { } id) Load(id, autoplay: true); else Stop();
    }

    public void Previous()
    {
        if (Command("previous")) return; // the server goes back to the start more than 3 s in, as below
        _failures = 0;
        if (Position > 3) { Seek(0); return; }
        if (Queue.Previous() is { } id) Load(id, autoplay: true); else Seek(0);
    }

    public void Stop()
    {
        Engine.Stop();
        Position = 0;
        SetState(PlayerState.Stopped);
        PositionChanged?.Invoke(0);
    }

    public void Seek(double seconds)
    {
        if (Command("seek", new { positionMs = (long)(Math.Max(0, seconds) * 1000) }, engineOffline: true)) { Position = Math.Max(0, seconds); PositionChanged?.Invoke(Position); return; }
        Position = Math.Clamp(seconds, 0, Duration > 0 ? Duration : seconds);
        Engine.Seek(Position);
        PositionChanged?.Invoke(Position);
        ScheduleSave();
    }

    public void SetVolume(double v)
    {
        Volume = Math.Clamp(v, 0, 1);
        if (Volume > 0 && Engine.Muted) Engine.Muted = false;
        ApplyVolume();
        _settings.Volume = Volume; _settings.Muted = Engine.Muted; _settings.Save();
        PlayerChanged?.Invoke();
    }

    public void SetMuted(bool muted) { Engine.Muted = muted; _settings.Muted = muted; _settings.Save(); PlayerChanged?.Invoke(); }

    public void SetReplayGain(ReplayGainMode mode) { ReplayGain = mode; _settings.ReplayGain = mode; _settings.Save(); ApplyVolume(); PlayerChanged?.Invoke(); }

    /// <summary>The volume after replay gain: MediaPlayer cannot go above full volume, so gains only lower it.</summary>
    public double EffectiveVolume(Track? t)
    {
        double? gain = t is null || ReplayGain == ReplayGainMode.Off ? null
            : ReplayGain == ReplayGainMode.Album ? t.AlbumGain ?? t.TrackGain : t.TrackGain ?? t.AlbumGain;
        return Volume * (gain is { } g ? Math.Min(1, Math.Pow(10, g / 20)) : 1);
    }

    private void ApplyVolume(Track? t = null) => Engine.Volume = EffectiveVolume(t ?? Current);

    public void SetOrder(PlaybackOrder order)
    {
        if (Session is { } s) { s.SetMode(order); return; } // the session's order (the setting stays this device's own)
        Queue.SetOrder(order); // the queue keeps the context's own order (search results, a radio) to come back to
        SaveOrder();
        PlayerChanged?.Invoke();
    }

    private void SaveOrder() { _settings.Order = Queue.Order; _settings.Save(); }

    public void SetStopAfterCurrent(bool on)
    {
        if (Command("stopAfterCurrent", new { on })) return;
        Queue.StopAfterCurrent = on; RefreshPreload(); PlayerChanged?.Invoke();
    }

    public async Task SetOutputAsync(string deviceId)
    {
        await Engine.SetOutputAsync(deviceId);
        _settings.OutputDeviceId = deviceId; _settings.Save();
        PlayerChanged?.Invoke();
    }

    private void SetState(PlayerState s, string? error = null)
    {
        State = s;
        Error = s == PlayerState.Error ? error : null;
        PlayerChanged?.Invoke();
    }

    // ---------------------------------------------------------------- the queue
    public void QueueAdd(IEnumerable<string> ids, bool next = false) { if (!Command("add", new { ids = ids.ToList(), next })) Queue.Add(ids, next); }
    public void QueueRemove(IEnumerable<string> entryIds) { if (!Command("remove", new { entries = entryIds.ToList() })) Queue.Remove(entryIds); }
    public void QueueClear(bool manual) { if (!Command("clear", new { manual })) Queue.Clear(manual); }
    public void QueueJump(string entryId) { if (!Command("jump", new { entry = entryId }) && Queue.Jump(entryId) is { } id) { _failures = 0; Load(id, autoplay: true); } }

    /// <summary>A radio from a song: the song, then similar ones from the server (without Last.fm there: songs of the same
    /// artist or genre from the library).</summary>
    public async Task<bool> StartRadioAsync(string trackId)
    {
        if (Library.Track(trackId) is not { } seed) return false;
        var ids = (await Client.SimilarSongsAsync(trackId, Remember)).Where(id => id != trackId).ToList();
        MergeUnknown();
        if (ids.Count == 0)
            ids = Library.Tracks.Where(x => x.Id != trackId && (x.ArtistId == seed.ArtistId || x.Genre == seed.Genre)).OrderBy(_ => Random.Shared.Next()).Take(50).Select(x => x.Id).ToList();
        if (ids.Count == 0) return false;
        Play(new PlayContext("radio", trackId, $"{seed.Title} 电台"), [trackId, .. ids], trackId);
        return true;
    }

    // ---------------------------------------------------------------- continue on another device
    private void ScheduleSave(bool soon = false)
    {
        if (Queue.Current is null || Session is not null) return; // with a session the server keeps it (rule 6)
        _saveTimer ??= _ui.CreateTimer();
        _saveTimer.Stop();
        _saveTimer.Interval = TimeSpan.FromMilliseconds(soon ? 1 : 1500);
        _saveTimer.IsRepeating = false;
        _saveTimer.Tick -= SaveNow;
        _saveTimer.Tick += SaveNow;
        _saveTimer.Start();
    }

    private void SaveNow(DispatcherQueueTimer sender, object args) => UiThread.Run("saving the queue", () =>
    {
        if (_disposed || Queue.Current is not { } current) return;
        _savedAt = DateTimeOffset.Now;
        var ids = Queue.ForServer();
        double at = Engine.CurrentId == current ? Engine.Position : Position;
        _ = Quietly(() => Client.SavePlayQueueAsync(ids, current, at));
    });

    /// <summary>Saves the queue now (the window is closing).</summary>
    public async Task SaveQueueNowAsync()
    {
        if (Queue.Current is not { } current || State == PlayerState.Stopped || Session is not null) return;
        try { await Client.SavePlayQueueAsync(Queue.ForServer(), current, Engine.Position).WaitAsync(TimeSpan.FromSeconds(2)); }
        catch (Exception ex) { Log.Write($"queue not saved on close: {ex.Message}"); }
    }

    public DateTimeOffset QueueSavedAt => _savedAt;

    public async Task<RemoteQueue?> RemoteQueueAsync()
    {
        var q = await Client.GetPlayQueueAsync(Remember);
        MergeUnknown();
        return q;
    }

    /// <summary>Takes over a saved queue: its song at its position, paused.</summary>
    public void ContinueQueue(RemoteQueue q, string label)
    {
        if (Queue.Adopt(new PlayContext("queue", "continue", label), q.TrackIds, q.Current) is { } id) Load(id, autoplay: false, at: q.Position);
    }

    /// <summary>Takes over another device's playback (a Sonus Connect transfer): its queue, at its song and position,
    /// playing or paused as asked. False when the song is not in this library.</summary>
    public bool TakeOver(PlayContext context, IReadOnlyList<string> ids, int index, double position, bool play)
    {
        string? current = index >= 0 && index < ids.Count ? ids[index] : null;
        if (current is null || Queue.Adopt(context, ids, current) is not { } id) return false;
        Load(id, autoplay: play, at: Math.Max(0, position));
        return true;
    }

    // ---------------------------------------------------------------- Sonus Connect version 2: the session
    /// <summary>The user's playback session on the server (Sonus Connect version 2), when the server offers it.</summary>
    public SessionService? Session { get; private set; }
    internal void AttachSession(SessionService session) => Session = session;

    private PlaybackSession? _session;   // the session as last applied
    private string? _engineKey;          // the session entry the engine has loaded
    private string? _advancedTo;         // the song the engine went on to by itself (gapless), until the session follows
    private bool _loadedSaid;            // `loaded` was reported for _engineKey
    private long _saidAt, _sayPositionAt;

    /// <summary>With a session, another device plays it (or none does): this one shows it and its engine is silent.</summary>
    private bool Elsewhere => Session is { } s && !s.IsActiveHere;

    /// <summary>Where the session plays, for the bar and the panel ("正在「手机」上播放", "上次在「书房电脑」播放"); null while this
    /// device plays it, or without a session.</summary>
    public string? Where => Session?.Where;

    /// <summary>The user's action as a command for the session (true: done that way). Without a connection the active
    /// device does what its engine can do by itself (<paramref name="engineOffline"/>: pause, play, seek; false: the
    /// caller does it, and the reports tell the server later); anything else waits a moment for the connection.</summary>
    private bool Command(string action, object? fields = null, bool engineOffline = false)
    {
        if (Session is not { } s) return false;
        if (!s.IsConnected && engineOffline && s.IsActiveHere) return false;
        s.Send(action, fields);
        return true;
    }

    /// <summary>The session changed: its queue is shown; this device's engine follows it while this is the active device,
    /// and is stopped at once otherwise (rule 4).</summary>
    internal void ApplySession(PlaybackSession s, SessionQueue q, bool here)
    {
        if (_disposed) return;
        _session = s;
        var context = s.Context is { } c ? new PlayContext(c.Kind ?? "queue", c.Id ?? "", c.Label ?? "") : null;
        Queue.Mirror(context, q.Order, q.Pointer, q.Manual.Select(m => (m.Key, m.TrackId)).ToList(), s.Current?.TrackId, SessionModes.Parse(s.Mode), s.StopAfterCurrent);
        if (here) FollowHere(s); else ShowElsewhere(s);
        PlayerChanged?.Invoke();
    }

    private void ShowElsewhere(PlaybackSession s)
    {
        if (_engineKey is not null || Engine.CurrentId is not null) Engine.Stop(); // the device playback left stops at once
        _engineKey = null; _advancedTo = null;
        State = s.Current is null ? PlayerState.Stopped : s.Playing ? PlayerState.Playing : PlayerState.Paused;
        Error = null;
        Position = s.PositionAt(Session!.ServerNow) / 1000.0;
        PositionChanged?.Invoke(Position);
    }

    /// <summary>The active device's engine made to match the session: the current entry loaded, the position (when more than
    /// 1.5 s off), playing or paused, the next song preloaded.</summary>
    private void FollowHere(PlaybackSession s)
    {
        if (s.Current is not { } cur)
        {
            if (_engineKey is not null) Engine.Stop();
            _engineKey = null; _advancedTo = null; Position = 0;
            SetState(PlayerState.Stopped);
            return;
        }
        double want = s.PositionAt(Session!.ServerNow) / 1000.0;
        if (cur.Key != _engineKey)
        {
            if (_advancedTo is not null && _advancedTo == cur.TrackId && Engine.CurrentId == cur.TrackId)
            {
                // the engine is there already (it went on by itself): only the entry is new
                _engineKey = cur.Key; _advancedTo = null; _loadedSaid = false;
                if (Engine.State == EngineState.Playing) SayHere("playing");
            }
            else
            {
                _engineKey = cur.Key; _advancedTo = null; _loadedSaid = false;
                Load(cur.TrackId, autoplay: s.Playing, at: want);
                if (State == PlayerState.Error) SayHere("failed"); // not in this library
                return;
            }
        }
        else if (_advancedTo is not null) return; // the session has not yet followed the engine to the next song
        switch (Engine.State)
        {
            case EngineState.Error: return; // reported: the session moves on
            case EngineState.Stopped:
                // the song ended here: played again from the session's position when the session plays on (repeat one,
                // play after the end); near its end the session has not yet heard of it
                if (s.Playing && (Duration <= 0 || want < Duration - 2)) { Load(cur.TrackId, autoplay: true, at: want); return; }
                if (!s.Playing) { Position = want; SetState(PlayerState.Paused); PositionChanged?.Invoke(want); }
                return;
        }
        if (Engine.State != EngineState.Loading && Math.Abs(Engine.Position - want) > 1.5)
        {
            Engine.Seek(want);
            Position = want;
            PositionChanged?.Invoke(want);
            _sayPositionAt = Environment.TickCount64 + 500;
        }
        if (s.Playing && Engine.State == EngineState.Paused) { Engine.Play(); SetState(PlayerState.Loading); }
        else if (!s.Playing && Engine.State is EngineState.Playing or EngineState.Loading) { Engine.Pause(); SetState(PlayerState.Paused); }
        RefreshPreload();
    }

    /// <summary>What the engine really did, for the session (the active device only): `loaded` first for a new entry.</summary>
    private void SayHere(string evt)
    {
        if (Session is not { } s || !s.IsActiveHere || _engineKey is not { } key) return;
        if (!_loadedSaid && evt != "failed")
        {
            _loadedSaid = true;
            var t = Library.Track(Engine.CurrentId ?? Queue.Current);
            // the library's length first: the engine's can lag behind a gapless change (it would hold every device's position)
            s.Report("loaded", key, Engine.Position, t is { Duration: > 0 } ? t.Duration : Engine.Duration,
                t is null ? null : new SessionNow(t.Title, t.Artist, t.Album, t.AlbumId, Library.Album(t.AlbumId)?.CoverArt ?? t.CoverArt));
        }
        s.Report(evt, key, Engine.Position);
        _saidAt = Environment.TickCount64;
    }

    // ---------------------------------------------------------------- likes and playlists
    // likes wanted but not yet sent, and the songs whose like is on its way to the server
    private readonly Dictionary<string, bool> _likeWanted = [];
    private readonly HashSet<string> _likeSending = [];

    /// <summary>
    /// Likes or unlikes a song. The heart changes at once and the server is told after. One request per song is on its way
    /// at a time and the last wish is sent last (liking and unliking quickly could otherwise reach the server the other way
    /// round); if the server refuses or cannot be reached, the heart shows what the server has.
    /// </summary>
    public async Task SetLikedAsync(string trackId, bool liked)
    {
        if (Library.Track(trackId) is not { } t || t.Liked == liked) return;
        var before = t.StarredAt;
        void Show(bool on, DateTimeOffset? at) { t.Liked = on; t.StarredAt = at; TrackChanged?.Invoke(t); RebuildSpecialPlaylists(); }
        Show(liked, liked ? DateTimeOffset.Now : null);
        _likeWanted[trackId] = liked;
        if (!_likeSending.Add(trackId)) return; // the request on its way sends this wish after it
        bool server = !liked; // what the server has
        try
        {
            while (_likeWanted[trackId] is var want && want != server)
            {
                await Client.SetStarredAsync(trackId, want);
                server = want;
            }
        }
        catch
        {
            if (Library.Track(trackId) is { } now && now.Liked != server) { t = now; Show(server, server ? before ?? DateTimeOffset.Now : null); }
            throw;
        }
        finally { _likeSending.Remove(trackId); _likeWanted.Remove(trackId); }
    }

    private Playlist Own(string id) =>
        Playlist(id) is { } p ? p.IsEditable ? p : throw new InvalidOperationException("这是别人的歌单，只能播放，不能修改。") : throw new InvalidOperationException("找不到这个歌单。");

    public async Task<Playlist> CreatePlaylistAsync(string name, IReadOnlyList<string> trackIds)
    {
        string? id = await Client.CreatePlaylistAsync(name, trackIds);
        var server = await Client.GetPlaylistsAsync(Remember);
        MergeUnknown();
        Playlists = [LikedPlaylist(), LibraryPlaylist(), .. server];
        PlaylistsChanged?.Invoke();
        return (id is not null ? Playlist(id) : server.Where(p => p.Name == name).MaxBy(p => p.Changed)) ?? throw new InvalidOperationException("歌单已创建，但没能读回来。");
    }

    public async Task RenamePlaylistAsync(string id, string name)
    {
        var p = Own(id);
        await Client.UpdatePlaylistAsync(id, name: name);
        p.Name = name; p.Changed = DateTimeOffset.Now;
        PlaylistsChanged?.Invoke();
    }

    public async Task DeletePlaylistAsync(string id)
    {
        Own(id);
        await Client.DeletePlaylistAsync(id);
        Playlists.RemoveAll(p => p.Id == id);
        PlaylistsChanged?.Invoke();
    }

    public async Task AddToPlaylistAsync(string id, IReadOnlyList<string> trackIds)
    {
        if (id == "liked") { foreach (var t in trackIds) await SetLikedAsync(t, true); return; }
        var p = Own(id);
        await Client.UpdatePlaylistAsync(id, add: trackIds);
        p.Entries = [.. p.Entries, .. trackIds]; p.Changed = DateTimeOffset.Now;
        PlaylistsChanged?.Invoke();
    }

    public async Task RemoveFromPlaylistAsync(string id, IReadOnlyList<string> trackIds)
    {
        if (id == "liked") { foreach (var t in trackIds) await SetLikedAsync(t, false); return; }
        var p = Own(id);
        var drop = trackIds.ToHashSet();
        var indexes = p.Entries.Select((t, i) => (t, i)).Where(x => drop.Contains(x.t)).Select(x => x.i).ToList();
        if (indexes.Count == 0) return;
        await Client.UpdatePlaylistAsync(id, removeIndexes: indexes);
        p.Entries = p.Entries.Where(t => !drop.Contains(t)).ToList(); p.Changed = DateTimeOffset.Now;
        PlaylistsChanged?.Invoke();
    }

    /// <summary>A playlist in a new order: <paramref name="moved"/> now sit before <paramref name="before"/> (null: at the end);
    /// songs listed twice keep both places. Without a move, <paramref name="order"/> is the order wanted (Undo).</summary>
    public async Task ReorderPlaylistAsync(string id, IReadOnlyList<string> order, IReadOnlyList<string>? moved = null, string? before = null)
    {
        var p = Own(id);
        List<string> entries;
        if (moved is null || moved.Count == 0) entries = [.. order];
        else
        {
            var set = moved.ToHashSet();
            var kept = p.Entries.Where(t => !set.Contains(t)).ToList();
            var movedEntries = p.Entries.Where(set.Contains).ToList();
            int at = before is null ? kept.Count : Math.Max(0, kept.IndexOf(before));
            entries = [.. kept.Take(at), .. movedEntries, .. kept.Skip(at)];
        }
        await Client.OverwritePlaylistAsync(id, entries);
        p.Entries = entries; p.Changed = DateTimeOffset.Now;
        PlaylistsChanged?.Invoke();
    }

    // ---------------------------------------------------------------- searching and reading
    public async Task<SearchResult> SearchAsync(string query)
    {
        var r = await Client.SearchAsync(query);
        return new SearchResult(r.Tracks.Where(id => Library.Track(id) is not null).ToList(), r.Albums.Where(id => Library.Album(id)?.TrackIds.Count > 0).ToList(),
            r.Artists.Where(id => Library.Artist(id) is not null).ToList());
    }

    public IEnumerable<Playlist> SearchPlaylists(string query) => Playlists.Where(p => p.Name.Contains(query, StringComparison.CurrentCultureIgnoreCase));

    public Task<IReadOnlyList<LyricLine>?> LyricsAsync(Track t) => Client.LyricsAsync(t);

    public Task<ArtistInfo?> ArtistInfoAsync(string artistId) => Client.ArtistInfoAsync(artistId);

    public string? CoverUrl(string? albumId, int size = 300) => (Library.Album(albumId)?.CoverArt) is { } art ? Client.CoverUrl(art, size) : null;

    /// <summary>Runs a request whose failure only needs logging (now playing, saving the queue).</summary>
    private static async Task Quietly(Func<Task> request)
    {
        try { await request(); }
        catch (Exception ex) when (ex is ServerUnreachableException or SubsonicException or JsonException) { Log.Write($"background request: {ex.Message}"); }
    }

    public void RaiseToast(ToastMessage message) => Toast?.Invoke(message);
}
