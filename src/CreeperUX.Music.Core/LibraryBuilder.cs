using System.Text.Json;
using static CreeperUX.Music.Core.SubsonicClient;

namespace CreeperUX.Music.Core;

/// <summary>Server JSON → tracks, albums and artists. Albums and artists keep the server's ids, so they group the way the
/// server groups them (album artist, compilations).</summary>
public static class LibraryBuilder
{
    private static readonly HashSet<string> Lossy = ["mp3", "aac", "m4a", "ogg", "oga", "opus", "mpc", "wma", "mp2"];
    private static readonly Dictionary<string, string> Codecs = new()
    {
        ["flac"] = "FLAC", ["mp3"] = "MP3", ["aac"] = "AAC", ["ogg"] = "Vorbis", ["oga"] = "Vorbis", ["opus"] = "Opus", ["ape"] = "Monkey's Audio",
        ["wv"] = "WavPack", ["wav"] = "PCM", ["aif"] = "PCM", ["aiff"] = "PCM", ["wma"] = "WMA", ["mpc"] = "Musepack", ["tta"] = "TTA", ["tak"] = "TAK", ["mp2"] = "MP2",
    };

    public static string CodecOf(string suffix, int sampleRate, int bitDepth, string contentType)
    {
        string x = suffix.ToLowerInvariant();
        if (x is "dsf" or "dff") return $"DSD{Math.Max(1, (int)Math.Round((sampleRate > 0 ? sampleRate : 2822400) / 2822400.0)) * 64}";
        if (x is "m4a" or "mp4" or "alac") return bitDepth > 0 || contentType.Contains("alac", StringComparison.OrdinalIgnoreCase) ? "ALAC" : "AAC";
        return Codecs.GetValueOrDefault(x) ?? (x.Length > 0 ? x.ToUpperInvariant() : "?");
    }

    public static Album AlbumOf(JsonElement a)
    {
        var types = Array(a, "releaseTypes").Select(t => (t.GetString() ?? "").ToLowerInvariant()).ToList();
        AlbumType? type = types.Contains("compilation") || Bool(a, "isCompilation") ? AlbumType.Compilation
            : types.Contains("ep") ? AlbumType.Ep : types.Contains("single") ? AlbumType.Single : types.Contains("album") ? AlbumType.Album : null;
        string artist = Str(a, "artist") ?? Str(a, "displayArtist") ?? "未知艺人";
        return new Album
        {
            Id = Str(a, "id")!, Title = Str(a, "name") ?? Str(a, "album") ?? "未知专辑", Artist = artist, ArtistId = Str(a, "artistId") ?? "ar-" + artist.ToLowerInvariant(),
            Year = Int(a, "year"), Genre = Str(a, "genre") ?? Array(a, "genres").Select(g => Str(g, "name")).FirstOrDefault(n => n is not null) ?? "—",
            Label = Array(a, "recordLabels").Select(l => Str(l, "name")).FirstOrDefault(n => n is not null) ?? "", Type = type, CoverArt = Str(a, "coverArt"),
        };
    }

    public static Track TrackOf(JsonElement s, IReadOnlyDictionary<string, Album> albums)
    {
        albums.TryGetValue(Str(s, "albumId") ?? "", out var al);
        string suffix = (Str(s, "suffix") ?? "").ToLowerInvariant(), contentType = Str(s, "contentType") ?? "";
        int sampleRate = Int(s, "samplingRate"), bitDepth = Int(s, "bitDepth");
        string codec = CodecOf(suffix, sampleRate, bitDepth, contentType);
        bool dsd = codec.StartsWith("DSD", StringComparison.Ordinal), lossy = Lossy.Contains(suffix) && codec != "ALAC";
        string albumArtist = al?.Artist ?? Str(s, "displayAlbumArtist") ?? Array(s, "albumArtists").Select(x => Str(x, "name")).FirstOrDefault(n => n is not null) ?? Str(s, "artist") ?? "未知艺人";
        string albumTitle = Str(s, "album") ?? al?.Title ?? "未知专辑";
        var rg = Obj(s, "replayGain");
        string path = Str(s, "path") ?? "";
        return new Track
        {
            Id = Str(s, "id")!, Title = Str(s, "title") is { Length: > 0 } title ? title : path.Split('/', '\\').Last() is { Length: > 0 } file ? file : Str(s, "id")!,
            Artist = Str(s, "artist") ?? albumArtist,
            ArtistId = al?.ArtistId ?? Array(s, "albumArtists").Select(x => Str(x, "id")).FirstOrDefault(n => n is not null) ?? Str(s, "artistId") ?? "ar-" + albumArtist.ToLowerInvariant(),
            Album = albumTitle, AlbumId = Str(s, "albumId") ?? "al-" + albumTitle.ToLowerInvariant(), AlbumArtist = albumArtist,
            Number = Int(s, "track"), Disc = Math.Max(1, Int(s, "discNumber")), Duration = Num(s, "duration"),
            Genre = Str(s, "genre") ?? Array(s, "genres").Select(g => Str(g, "name")).FirstOrDefault(n => n is not null) ?? "—", Year = Int(s, "year"),
            Codec = codec, Bitrate = Int(s, "bitRate"), SampleRate = sampleRate, BitDepth = dsd ? 1 : lossy ? 0 : bitDepth, Channels = Int(s, "channelCount") is > 0 and var ch ? ch : 2,
            Path = path, Size = (long)Num(s, "size"), Added = Date(s, "created"), PlayCount = Int(s, "playCount"), LastPlayed = Date(s, "played"),
            Liked = Str(s, "starred") is not null, StarredAt = Date(s, "starred"), TrackGain = NumOrNull(rg, "trackGain"), AlbumGain = NumOrNull(rg, "albumGain"),
            Suffix = suffix, ContentType = contentType, CoverArt = Str(s, "coverArt") ?? al?.CoverArt, Label = al?.Label ?? "",
        };
    }

    public static LibrarySnapshot Build(IEnumerable<JsonElement> albumJson, IEnumerable<JsonElement> songJson)
    {
        var albums = new Dictionary<string, Album>();
        foreach (var a in albumJson) { var al = AlbumOf(a); albums[al.Id] = al; }
        var tracks = new List<Track>();
        var seen = new HashSet<string>();
        foreach (var s in songJson) { var t = TrackOf(s, albums); if (seen.Add(t.Id)) tracks.Add(t); }
        return Group(tracks, albums);
    }

    /// <summary>Tracks into albums (disc and track order) and artists; albums without songs are left out.</summary>
    public static LibrarySnapshot Group(IReadOnlyList<Track> tracks, Dictionary<string, Album> albums)
    {
        var byId = tracks.ToDictionary(t => t.Id);
        foreach (var al in albums.Values) al.TrackIds.Clear(); // grouping again (a song added later) starts from scratch
        foreach (var t in tracks)
        {
            if (!albums.TryGetValue(t.AlbumId, out var al))
                albums[t.AlbumId] = al = new Album { Id = t.AlbumId, Title = t.Album, Artist = t.AlbumArtist, ArtistId = t.ArtistId, Year = t.Year, Genre = t.Genre, CoverArt = t.CoverArt };
            al.TrackIds.Add(t.Id);
        }
        var artists = new Dictionary<string, Artist>();
        var keptAlbums = new List<Album>();
        foreach (var al in albums.Values)
        {
            if (al.TrackIds.Count == 0) continue;
            var ordered = al.TrackIds.Select(id => byId[id]).OrderBy(t => t.Disc).ThenBy(t => t.Number).ThenBy(t => t.Path, StringComparer.Ordinal).Select(t => t.Id).ToList();
            al.TrackIds.Clear(); al.TrackIds.AddRange(ordered);
            if (al.Year == 0) al.Year = ordered.Max(id => byId[id].Year);
            al.Type ??= ordered.Count <= 3 ? AlbumType.Single : ordered.Count <= 6 ? AlbumType.Ep : AlbumType.Album;
            if (!artists.TryGetValue(al.ArtistId, out var ar)) artists[al.ArtistId] = ar = new Artist { Id = al.ArtistId, Name = al.Artist, Genre = al.Genre };
            ar.AlbumIds.Add(al.Id);
            keptAlbums.Add(al);
        }
        foreach (var t in tracks)
            if (!artists.ContainsKey(t.ArtistId)) artists[t.ArtistId] = new Artist { Id = t.ArtistId, Name = t.AlbumArtist, Genre = t.Genre };
        return new LibrarySnapshot(tracks, keptAlbums, artists.Values.ToList());
    }
}
