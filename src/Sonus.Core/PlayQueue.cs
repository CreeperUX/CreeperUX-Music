namespace Sonus.Core;

/// <summary>One row of the queue panel: a song queued by hand ("queue"), or what follows in the playing context ("context").</summary>
public sealed record QueueEntry(string Id, string TrackId, bool Manual);

/// <summary>
/// What plays and what comes next: the playing context (an album, a playlist … in playback order), the position in it,
/// and the songs queued by hand, which play first. The player asks it for the next song; nothing here plays audio.
/// </summary>
public sealed class PlayQueue(Func<string, Track?> lookup, Random? random = null)
{
    private readonly Random _random = random ?? Random.Shared;
    private List<string> _context = [];
    private List<string> _source = []; // the context in its own order (an album's, a search's), to come back to from shuffling
    private int _pointer = -1;
    private List<(string Id, string TrackId)> _manual = [];
    private int _nextId;

    public PlayContext? Context { get; private set; }
    public string? Current { get; private set; }
    public PlaybackOrder Order { get; set; } = PlaybackOrder.Default;
    public bool StopAfterCurrent { get; set; }

    /// <summary>The order or the songs to come changed.</summary>
    public event EventHandler? Changed;

    public IReadOnlyList<string> ContextIds => _context;
    public int Pointer => _pointer;

    /// <summary>Hand-queued songs first, then the rest of the context.</summary>
    public IReadOnlyList<QueueEntry> Entries =>
        _manual.Select(m => new QueueEntry(m.Id, m.TrackId, true))
            .Concat(_context.Skip(_pointer + 1).Select((t, i) => new QueueEntry($"c{_pointer + 1 + i}:{t}", t, false))).ToList();

    private static bool Shuffled(PlaybackOrder o) => o is PlaybackOrder.ShuffleTracks or PlaybackOrder.ShuffleAlbums or PlaybackOrder.ShuffleFolders;

    /// <summary>Plays from a context: from <paramref name="startId"/>, or its first song (a random one when shuffling).
    /// Returns the song to play, or null when the context has none.</summary>
    public string? Start(PlayContext context, IReadOnlyList<string> ids, string? startId, bool shuffle = false)
    {
        if (shuffle && !Shuffled(Order)) Order = PlaybackOrder.ShuffleTracks;
        var known = ids.Where(id => lookup(id) is not null).ToList();
        if (known.Count == 0) return null;
        string start = startId is not null && known.Contains(startId) ? startId
            : Shuffled(Order) || Order == PlaybackOrder.Random ? known[_random.Next(known.Count)] : known[0];
        _source = known;
        _context = Arrange(known, Order, start);
        _pointer = Math.Max(0, _context.IndexOf(start));
        Context = context;
        Current = _context[_pointer];
        Changed?.Invoke(this, EventArgs.Empty);
        return Current;
    }

    /// <summary>Takes over a queue saved elsewhere (continue on another device).</summary>
    public string? Adopt(PlayContext context, IReadOnlyList<string> ids, string current)
    {
        var known = ids.Where(id => lookup(id) is not null).ToList();
        if (!known.Contains(current)) return null;
        _context = known; _source = known; _pointer = known.IndexOf(current); _manual = [];
        Context = context; Current = current;
        Changed?.Invoke(this, EventArgs.Empty);
        return current;
    }

    /// <summary>The song that follows when the current one ends — what <see cref="Next"/>(ended: true) will return — without
    /// moving there (to load it early), or null when that is not a different song known now (stop after current, repeat one,
    /// random).</summary>
    public string? Peek()
    {
        if (StopAfterCurrent || Order == PlaybackOrder.RepeatTrack) return null;
        if (_manual.Count > 0) return _manual[0].TrackId;
        if (Order == PlaybackOrder.Random) return null;
        if (_pointer + 1 < _context.Count) return _context[_pointer + 1];
        return (Order == PlaybackOrder.RepeatPlaylist || Shuffled(Order)) && _context.Count > 0 ? _context[0] : null;
    }

    /// <summary>Moves to the next song (hand-queued first). Null: the end, playback stops.</summary>
    public string? Next(bool ended = false)
    {
        if (ended && StopAfterCurrent) { StopAfterCurrent = false; return null; }
        if (ended && Order == PlaybackOrder.RepeatTrack) return Current;
        if (_manual.Count > 0)
        {
            Current = _manual[0].TrackId;
            _manual.RemoveAt(0);
            Changed?.Invoke(this, EventArgs.Empty);
            return Current;
        }
        return Step(1);
    }

    /// <summary>Moves to the previous song in the context (null at the start, unless repeating). While a hand-queued song plays,
    /// that is the context song that played before it.</summary>
    public string? Previous()
    {
        if (Current is not null && _pointer >= 0 && _pointer < _context.Count && _context[_pointer] != Current)
        {
            Current = _context[_pointer];
            Changed?.Invoke(this, EventArgs.Empty);
            return Current;
        }
        return Step(-1);
    }

    private string? Step(int dir)
    {
        if (_context.Count == 0) return null;
        int at = _pointer + dir;
        if (Order == PlaybackOrder.Random) at = _random.Next(_context.Count);
        if (at >= _context.Count || at < 0)
        {
            if (Order == PlaybackOrder.RepeatPlaylist || Shuffled(Order)) at = dir > 0 ? 0 : _context.Count - 1;
            else return null;
        }
        _pointer = at;
        Current = _context[_pointer];
        Changed?.Invoke(this, EventArgs.Empty);
        return Current;
    }

    public void SetOrder(PlaybackOrder order)
    {
        var was = Order;
        Order = order;
        if (_context.Count > 0 && (Shuffled(order) || Shuffled(was)))
        {
            // back from shuffling: the context's own order, without the songs removed from the queue meanwhile
            var basis = Shuffled(order) ? _context : _source.Where(_context.Contains).Distinct().ToList();
            _context = Arrange(basis, order, Current);
            _pointer = Math.Max(0, Current is null ? 0 : _context.IndexOf(Current));
        }
        Changed?.Invoke(this, EventArgs.Empty);
    }

    public void Add(IEnumerable<string> trackIds, bool next = false)
    {
        var added = trackIds.Where(id => lookup(id) is not null).Select(id => ($"q{++_nextId}", id)).ToList();
        _manual = next ? [.. added, .. _manual] : [.. _manual, .. added];
        Changed?.Invoke(this, EventArgs.Empty);
    }

    /// <summary>A drag in the queue panel: <paramref name="order"/> is every entry id in the new order, <paramref name="keys"/>
    /// the moved ones, which now belong to <paramref name="manual"/>'s section.</summary>
    public void Move(IReadOnlyList<string> order, IReadOnlyList<string> keys, bool manual)
    {
        var entries = Entries.ToDictionary(e => e.Id);
        var placed = order.Where(entries.ContainsKey).Select(id => keys.Contains(id) ? entries[id] with { Manual = manual } : entries[id]).ToList();
        _manual = placed.Where(e => e.Manual).Select(e => e.Id.StartsWith('q') ? (e.Id, e.TrackId) : ($"q{++_nextId}", e.TrackId)).ToList();
        _context = [.. _context.Take(_pointer + 1), .. placed.Where(e => !e.Manual).Select(e => e.TrackId)];
        Changed?.Invoke(this, EventArgs.Empty);
    }

    public void Remove(IEnumerable<string> entryIds)
    {
        var ids = entryIds.ToHashSet();
        // a context entry is "c<index>:<song>": only removed when that index still holds that song and is still to come
        // (an id from a menu left open across a song change must not remove another song)
        var contextIndexes = ids.Where(id => id.StartsWith('c')).Select(ContextIndex).Where(i => i >= 0).ToHashSet();
        _manual = _manual.Where(m => !ids.Contains(m.Id)).ToList();
        _context = _context.Where((_, i) => !contextIndexes.Contains(i)).ToList();
        Changed?.Invoke(this, EventArgs.Empty);
    }

    public void Clear(bool manual)
    {
        if (manual) _manual = []; else _context = _context.Take(_pointer + 1).ToList();
        Changed?.Invoke(this, EventArgs.Empty);
    }

    private int ContextIndex(string entryId)
    {
        int colon = entryId.IndexOf(':');
        if (colon < 2 || !int.TryParse(entryId[1..colon], System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out int i)) return -1;
        return i > _pointer && i < _context.Count && _context[i] == entryId[(colon + 1)..] ? i : -1;
    }

    /// <summary>Jumps to a queue entry; returns its song.</summary>
    public string? Jump(string entryId)
    {
        var e = Entries.FirstOrDefault(x => x.Id == entryId);
        if (e is null) return null;
        if (e.Manual) _manual = _manual.Where(m => m.Id != entryId).ToList();
        else _pointer = int.Parse(entryId[1..entryId.IndexOf(':')], System.Globalization.CultureInfo.InvariantCulture);
        Current = e.TrackId;
        Changed?.Invoke(this, EventArgs.Empty);
        return Current;
    }

    /// <summary>The queue as saved on the server: what played, the current song, what comes (hand-queued first), at most 500
    /// songs around the current one.</summary>
    public IReadOnlyList<string> ForServer() => Snapshot().Ids;

    /// <summary><see cref="ForServer"/>'s list and the current song's place in it (a song may be there twice): what
    /// another device takes over (Sonus Connect).</summary>
    public (IReadOnlyList<string> Ids, int Index) Snapshot()
    {
        if (Current is null) return ([], -1);
        var before = _context.Take(_pointer + 1).ToList();
        if (before.Count == 0 || before[^1] != Current) before.Add(Current);
        var all = before.Concat(_manual.Select(m => m.TrackId)).Concat(_context.Skip(_pointer + 1)).ToList();
        int from = Math.Max(0, before.Count - 100);
        return (all.Skip(from).Take(500).ToList(), before.Count - 1 - from);
    }

    private List<string> Arrange(IReadOnlyList<string> ids, PlaybackOrder order, string? start)
    {
        if (order == PlaybackOrder.ShuffleTracks)
        {
            var rest = Shuffle(ids.Where(id => id != start));
            return start is not null && ids.Contains(start) ? [start, .. rest] : rest;
        }
        if (order is PlaybackOrder.ShuffleAlbums or PlaybackOrder.ShuffleFolders)
        {
            string Key(string id) => order == PlaybackOrder.ShuffleAlbums ? lookup(id)?.AlbumId ?? "" : System.IO.Path.GetDirectoryName(lookup(id)?.Path ?? "") ?? "";
            var groups = Shuffle(ids.Select(Key).Distinct());
            if (start is not null && groups.Remove(Key(start))) groups.Insert(0, Key(start));
            return groups.SelectMany(g => ids.Where(id => Key(id) == g)).ToList();
        }
        return ids.ToList();
    }

    private List<string> Shuffle(IEnumerable<string> items)
    {
        var list = items.ToList();
        for (int i = list.Count - 1; i > 0; i--) { int j = _random.Next(i + 1); (list[i], list[j]) = (list[j], list[i]); }
        return list;
    }
}
