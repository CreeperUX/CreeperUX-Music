namespace CreeperUX.Music.Core;

/// <summary>A song as the server reports it. Liked, play count and last played change while the app runs.</summary>
public sealed class Track
{
    public required string Id { get; init; }
    public required string Title { get; init; }
    public required string Artist { get; init; }
    /// <summary>The album artist's id: what "go to artist" opens and what groups the library.</summary>
    public required string ArtistId { get; init; }
    public required string Album { get; init; }
    public required string AlbumId { get; init; }
    public required string AlbumArtist { get; init; }
    public int Number { get; init; }
    public int Disc { get; init; } = 1;
    /// <summary>Seconds.</summary>
    public double Duration { get; init; }
    public string Genre { get; init; } = "—";
    public int Year { get; init; }
    /// <summary>"FLAC", "MP3", "AAC", "ALAC", "Opus", "DSD64", "Monkey's Audio" …</summary>
    public string Codec { get; init; } = "?";
    /// <summary>kbps.</summary>
    public int Bitrate { get; init; }
    public int SampleRate { get; init; }
    /// <summary>Bits per sample: 0 for lossy formats, 1 for DSD.</summary>
    public int BitDepth { get; init; }
    public int Channels { get; init; } = 2;
    public string Path { get; init; } = "";
    public long Size { get; init; }
    public DateTimeOffset? Added { get; init; }
    public double? TrackGain { get; init; }
    public double? AlbumGain { get; init; }
    /// <summary>The file's extension, lower case ("flac", "dsf" …).</summary>
    public string Suffix { get; init; } = "";
    public string ContentType { get; init; } = "";
    public string? CoverArt { get; init; }
    public string Label { get; init; } = "";

    public int PlayCount { get; set; }
    public DateTimeOffset? LastPlayed { get; set; }
    public bool Liked { get; set; }
    public DateTimeOffset? StarredAt { get; set; }

    public bool IsLossless => BitDepth > 0;
    public bool IsHiRes => BitDepth > 16 || SampleRate > 48000;
}

public enum AlbumType { Album, Ep, Single, Compilation }

public sealed class Album
{
    public required string Id { get; init; }
    public required string Title { get; init; }
    public required string Artist { get; init; }
    public required string ArtistId { get; init; }
    public int Year { get; set; }
    public string Genre { get; init; } = "—";
    public string Label { get; init; } = "";
    public AlbumType? Type { get; set; }
    public string? CoverArt { get; init; }
    /// <summary>In disc and track order.</summary>
    public List<string> TrackIds { get; } = [];
}

public sealed class Artist
{
    public required string Id { get; init; }
    public required string Name { get; init; }
    public string Genre { get; init; } = "—";
    public List<string> AlbumIds { get; } = [];
}

public enum PlaylistKind { Liked, Library, User, ReadOnly }

public sealed class Playlist
{
    public required string Id { get; init; }
    public required string Name { get; set; }
    public required PlaylistKind Kind { get; init; }
    public string Owner { get; init; } = "";
    public string? Comment { get; init; }
    public DateTimeOffset Changed { get; set; } = DateTimeOffset.Now;
    /// <summary>The playlist as stored: a song may appear more than once.</summary>
    public List<string> Entries { get; set; } = [];
    /// <summary>Each song once, in order (what lists show).</summary>
    public IReadOnlyList<string> TrackIds => Entries.Distinct().ToList();
    public bool IsEditable => Kind == PlaylistKind.User;
}

/// <summary>The whole library: songs, albums and artists, with lookups.</summary>
public sealed class LibrarySnapshot
{
    public static readonly LibrarySnapshot Empty = new([], [], []);

    public LibrarySnapshot(IReadOnlyList<Track> tracks, IReadOnlyList<Album> albums, IReadOnlyList<Artist> artists)
    {
        Tracks = tracks; Albums = albums; Artists = artists;
        TrackById = tracks.ToDictionary(t => t.Id);
        AlbumById = albums.ToDictionary(a => a.Id);
        ArtistById = artists.ToDictionary(a => a.Id);
    }

    public IReadOnlyList<Track> Tracks { get; }
    public IReadOnlyList<Album> Albums { get; }
    public IReadOnlyList<Artist> Artists { get; }
    public IReadOnlyDictionary<string, Track> TrackById { get; }
    public IReadOnlyDictionary<string, Album> AlbumById { get; }
    public IReadOnlyDictionary<string, Artist> ArtistById { get; }

    public Track? Track(string? id) => id is not null && TrackById.TryGetValue(id, out var t) ? t : null;
    public Album? Album(string? id) => id is not null && AlbumById.TryGetValue(id, out var a) ? a : null;
    public Artist? Artist(string? id) => id is not null && ArtistById.TryGetValue(id, out var a) ? a : null;

    /// <summary>An artist's songs, newest album first.</summary>
    public IReadOnlyList<string> ArtistTracks(string artistId) =>
        Artist(artistId)?.AlbumIds.Select(Album).OfType<Album>().OrderByDescending(a => a.Year).SelectMany(a => a.TrackIds).ToList() ?? [];
}

public enum PlaybackOrder { Default, RepeatPlaylist, RepeatTrack, Random, ShuffleTracks, ShuffleAlbums, ShuffleFolders }

public enum ReplayGainMode { Album, Track, Off }

/// <summary>Where the playing songs come from: an album, a playlist, an artist, search results, a radio …</summary>
public sealed record PlayContext(string Kind, string Id, string Label);

public sealed record LyricLine(double? Time, string Text);

/// <summary>The queue another device (or this one, last time) saved on the server.</summary>
public sealed record RemoteQueue(IReadOnlyList<string> TrackIds, string Current, double Position, DateTimeOffset Changed, string ChangedBy);

public sealed record ServerInfo(string Name, string Version, string ApiVersion, bool OpenSubsonic);

public sealed record ArtistInfo(string Biography, string? Url);

public sealed record SearchResult(IReadOnlyList<string> Tracks, IReadOnlyList<string> Albums, IReadOnlyList<string> Artists)
{
    public static readonly SearchResult None = new([], [], []);
    public int Count => Tracks.Count + Albums.Count + Artists.Count;
}
