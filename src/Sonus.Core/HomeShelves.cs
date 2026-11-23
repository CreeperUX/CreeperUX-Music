namespace Sonus.Core;

/// <summary>A card on a shelf: an album, a playlist or an artist.</summary>
public sealed record CardRef(string Type, string Id);

/// <summary>The home page's shelves, from the play counts and dates the server keeps.</summary>
public sealed class HomeShelves
{
    public required IReadOnlyList<CardRef> Recent { get; init; }
    public required IReadOnlyList<CardRef> Playlists { get; init; }
    public required IReadOnlyList<CardRef> TopArtists { get; init; }
    public required IReadOnlyList<CardRef> HiRes { get; init; }
    public required IReadOnlyList<CardRef> Added { get; init; }
    public required IReadOnlyList<CardRef> Forgotten { get; init; }

    public static HomeShelves From(LibrarySnapshot lib, IEnumerable<Playlist> playlists)
    {
        var last = new Dictionary<string, DateTimeOffset>();
        var plays = new Dictionary<string, int>();
        var added = new Dictionary<string, DateTimeOffset>();
        foreach (var t in lib.Tracks)
        {
            if (t.LastPlayed is { } lp && (!last.TryGetValue(t.AlbumId, out var l) || lp > l)) last[t.AlbumId] = lp;
            plays[t.ArtistId] = plays.GetValueOrDefault(t.ArtistId) + t.PlayCount;
            if (t.Added is { } ad && (!added.TryGetValue(t.AlbumId, out var a) || ad > a)) added[t.AlbumId] = ad;
        }
        DateTimeOffset Last(Album a) => last.GetValueOrDefault(a.Id, DateTimeOffset.MinValue);
        var albums = lib.Albums;
        return new HomeShelves
        {
            Recent = albums.Where(a => last.ContainsKey(a.Id)).OrderByDescending(Last).Select(a => new CardRef("album", a.Id)).ToList(),
            Playlists = playlists.Where(p => p.Kind != PlaylistKind.Library).Select(p => new CardRef("playlist", p.Id)).ToList(),
            TopArtists = lib.Artists.Where(a => a.AlbumIds.Count > 0).OrderByDescending(a => plays.GetValueOrDefault(a.Id)).Select(a => new CardRef("artist", a.Id)).ToList(),
            HiRes = albums.Where(a => lib.Track(a.TrackIds.FirstOrDefault())?.IsHiRes == true).Select(a => new CardRef("album", a.Id)).ToList(),
            Added = albums.OrderByDescending(a => added.GetValueOrDefault(a.Id, DateTimeOffset.MinValue)).Select(a => new CardRef("album", a.Id)).ToList(),
            Forgotten = albums.Where(a => last.ContainsKey(a.Id)).OrderBy(Last).Select(a => new CardRef("album", a.Id)).ToList(),
        };
    }
}
