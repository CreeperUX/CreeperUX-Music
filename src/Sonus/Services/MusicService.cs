using System.Text.Json;
using Sonus.Core;
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
        Engine.Ended += () => { if (Queue.Next(ended: true) is { } id) Load(id, autoplay: true); else Stop(); };
        Engine.NextRequested += () => Next();
        Engine.PreviousRequested += () => Previous();
        Queue.Changed += (_, _) => { QueueChanged?.Invoke(); RefreshPreload(); ScheduleSave(); };
        client.ConnectionChanged += OnConnection;
        _tick = ui.CreateTimer();
        _tick.Interval = TimeSpan.FromMilliseconds(250);
        _tick.Tick += (_, _) => OnTick();
        _tick.Start();
        ReplayGain = settings.ReplayGain;
    }

    private void OnConnection(object? sender, bool online) => _ui.TryEnqueue(() => { if (_disposed) return; IsOnline = online; ConnectionChanged?.Invoke(); });

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
    public double Duration => Engine.Duration ?? Current?.Duration ?? 0;
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

    private readonly List<JsonElement> _unknown = [];

    /// <summary>A song from a playlist, the play queue or a radio: called by the client on any thread. Songs the library does
    /// not have are kept aside and added by <see cref="MergeUnknown"/> on the UI thread, all at once.</summary>
    private string Remember(JsonElement song)
    {
        string id = song.GetProperty("id").GetString()!;
        if (!Library.TrackById.ContainsKey(id)) lock (_unknown) _unknown.Add(song.Clone());
        return id;
    }

    /// <summary>Adds the songs <see cref="Remember"/> kept aside to the library (one regrouping, on the UI thread).</summary>
    private void MergeUnknown()
    {
        List<JsonElement> songs;
        lock (_unknown) { songs = [.. _unknown]; _unknown.Clear(); }
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
        var next = Queue.Peek() is { } n && n != trackId && Library.Track(n) is { } nt ? ItemFor(nt) : null;
        ApplyVolume(t);
        Engine.Load(ItemFor(t, at), next, autoplay);
        SetState(autoplay ? PlayerState.Loading : PlayerState.Paused);
        PositionChanged?.Invoke(at);
    }

    private void RefreshPreload()
    {
        if (Current is null || Engine.CurrentId != Queue.Current) return;
        var next = Queue.Peek() is { } n && n != Queue.Current && Library.Track(n) is { } nt ? ItemFor(nt) : null;
        Engine.SetNext(next);
    }

    private void OnAdvanced(string id)
    {
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
                bool started = State is PlayerState.Loading;
                SetState(PlayerState.Playing);
                if (started) NowPlaying();
                break;
            case EngineState.Paused: SetState(PlayerState.Paused); ScheduleSave(soon: true); break;
            case EngineState.Loading: SetState(PlayerState.Loading); break;
            case EngineState.Error: SetState(PlayerState.Error, $"无法播放“{Current?.Title}”：{Engine.Error}"); break;
            case EngineState.Stopped when State is not PlayerState.Error: break; // Ended decides what follows
        }
    }

    private void NowPlaying()
    {
        if (Current is { } t) _ = Quietly(() => Client.ScrobbleAsync(t.Id, submission: false));
        ScheduleSave(soon: true);
    }

    private void OnTick()
    {
        if (_disposed || State != PlayerState.Playing) return;
        Position = Engine.Position;
        PositionChanged?.Invoke(Position);
        double d = Duration;
        if (!_counted && d > 0 && Position >= Math.Min(240, d / 2) && Current is { } t)
        {
            _counted = true; // a play counts past half the song or four minutes
            _ = CountPlay(t, _started);
        }
        if (DateTimeOffset.Now - _savedAt > TimeSpan.FromSeconds(30)) ScheduleSave(soon: true); // the position, for another device
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

    public void Pause() { Engine.Pause(); SetState(PlayerState.Paused); ScheduleSave(soon: true); }

    public void Resume()
    {
        if (Queue.Current is not { } id) return;
        if (State is PlayerState.Error or PlayerState.Stopped || Engine.CurrentId != id) { Load(id, autoplay: true, at: State == PlayerState.Stopped ? 0 : Position); return; }
        Engine.Play();
        SetState(PlayerState.Loading);
    }

    public void Next() { if (Queue.Next() is { } id) Load(id, autoplay: true); else Stop(); }

    public void Previous()
    {
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
        Queue.SetOrder(order); // the queue keeps the context's own order (search results, a radio) to come back to
        SaveOrder();
        PlayerChanged?.Invoke();
    }

    private void SaveOrder() { _settings.Order = Queue.Order; _settings.Save(); }

    public void SetStopAfterCurrent(bool on) { Queue.StopAfterCurrent = on; RefreshPreload(); PlayerChanged?.Invoke(); }

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
    public void QueueAdd(IEnumerable<string> ids, bool next = false) => Queue.Add(ids, next);
    public void QueueRemove(IEnumerable<string> entryIds) => Queue.Remove(entryIds);
    public void QueueClear(bool manual) => Queue.Clear(manual);
    public void QueueJump(string entryId) { if (Queue.Jump(entryId) is { } id) Load(id, autoplay: true); }

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
        if (Queue.Current is null) return;
        _saveTimer ??= _ui.CreateTimer();
        _saveTimer.Stop();
        _saveTimer.Interval = TimeSpan.FromMilliseconds(soon ? 1 : 1500);
        _saveTimer.IsRepeating = false;
        _saveTimer.Tick -= SaveNow;
        _saveTimer.Tick += SaveNow;
        _saveTimer.Start();
    }

    private void SaveNow(DispatcherQueueTimer sender, object args)
    {
        if (_disposed || Queue.Current is not { } current) return;
        _savedAt = DateTimeOffset.Now;
        var ids = Queue.ForServer();
        double at = Engine.CurrentId == current ? Engine.Position : Position;
        _ = Quietly(() => Client.SavePlayQueueAsync(ids, current, at));
    }

    /// <summary>Saves the queue now (the window is closing).</summary>
    public async Task SaveQueueNowAsync()
    {
        if (Queue.Current is not { } current || State == PlayerState.Stopped) return;
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
