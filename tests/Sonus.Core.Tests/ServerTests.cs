using System.Net;
using System.Net.Sockets;
using System.Text.Json;
using Sonus.Core;
using Xunit.Abstractions;

namespace Sonus.Core.Tests;

/// <summary>The client against a server: the demo server, whose catalogue the assertions know exactly, or any server
/// (SONUS_TEST_SERVER: <see cref="TestServer"/>), where the same behaviour is checked with what that server reports.</summary>
public class ServerTests(TestServer server, ITestOutputHelper output) : IClassFixture<TestServer>
{
    private const string Client = "Sonus (tests)";
    private static string Id(JsonElement j) => SubsonicClient.Str(j, "id")!;
    private string User => server.Main.User;
    private string Wrong => server.Main.Password == "nope" ? "nope!" : "nope";
    private async Task<SubsonicClient> SignedIn() => new(await SubsonicClient.SignInAsync(server.Url, User, server.Main.Password, Client), Client);

    /// <summary>Songs the tests can use on any server (not the one whose file is gone, nor DSD).</summary>
    private IEnumerable<Track> Usable(LibrarySnapshot lib) => lib.Tracks.Where(t => t.Id != server.Id("track.missingFile") && !t.Codec.StartsWith("DSD", StringComparison.Ordinal));

    /// <summary>A raw call (the client's own transport), to compare what the client makes of an answer with the answer.</summary>
    private static Task<JsonElement> Raw(SubsonicClient c, string method, params (string Key, object? Value)[] p) =>
        c.CallAsync(method, p.Select(x => new KeyValuePair<string, object?>(x.Key, x.Value)));

    [Fact]
    public async Task AWrongPasswordIsRefusedWithAClearMessage()
    {
        var e = await Assert.ThrowsAsync<SubsonicException>(() => SubsonicClient.SignInAsync(server.Url + "/rest/", User, Wrong, Client));
        Assert.True(e.IsAuthentication);
        Assert.Equal("用户名或密码不正确。", e.Message);
    }

    [Fact]
    public async Task AnUnreachableServerSaysSoAndReportsOffline()
    {
        var probe = new TcpListener(IPAddress.Loopback, 0); probe.Start(); int port = ((IPEndPoint)probe.LocalEndpoint).Port; probe.Stop();
        await Assert.ThrowsAsync<ServerUnreachableException>(() => SubsonicClient.SignInAsync($"http://127.0.0.1:{port}", "demo", "demo", Client));
        var c = new SubsonicClient(new Login($"http://127.0.0.1:{port}", "demo", "s", "t"), Client);
        bool? online = null;
        c.ConnectionChanged += (_, on) => online = on;
        await Assert.ThrowsAsync<ServerUnreachableException>(() => c.ConnectAsync());
        Assert.False(online);
    }

    [Fact]
    public async Task APrivateAddressWithoutASchemeIsTriedOverHttpThenHttps()
    {
        string bare = server.Url["http://".Length..]; // the demo server or the proxy: http://127.0.0.1:<port>
        Assert.Equal(server.Url, (await SubsonicClient.SignInAsync(bare, User, server.Main.Password, Client)).Server);
        // the server answered over HTTP, so a wrong password is said as such (HTTPS is not tried)
        Assert.True((await Assert.ThrowsAsync<SubsonicException>(() => SubsonicClient.SignInAsync(bare, User, Wrong, Client))).IsAuthentication);
        var probe = new TcpListener(IPAddress.Loopback, 0); probe.Start(); int port = ((IPEndPoint)probe.LocalEndpoint).Port; probe.Stop();
        var e = await Assert.ThrowsAsync<ServerUnreachableException>(() => SubsonicClient.SignInAsync($"127.0.0.1:{port}", "demo", "demo", Client));
        Assert.Contains($"http://127.0.0.1:{port}", e.Message);
        Assert.Contains($"https://127.0.0.1:{port}", e.Message);
        // typed with its scheme, an address is taken as it is
        var typed = await Assert.ThrowsAsync<ServerUnreachableException>(() => SubsonicClient.SignInAsync($"http://127.0.0.1:{port}", "demo", "demo", Client));
        Assert.DoesNotContain("https://", typed.Message);
    }

    [Fact]
    public async Task ConnectsAndReadsTheWholeLibrary()
    {
        var c = await SignedIn();
        var info = await c.ConnectAsync();
        Assert.Contains("songLyrics", c.Extensions);
        var lib = await c.LoadLibraryAsync();
        if (server.IsDemo)
        {
            Assert.Equal("Navidrome", info.Name);
            Assert.Equal(293, lib.Tracks.Count);
            Assert.Equal(34, lib.Albums.Count);
            Assert.Equal(17, lib.Artists.Count);
            Assert.Contains(lib.Tracks, t => t.Codec == "DSD64" && t.BitDepth == 1);
            Assert.Contains(lib.Tracks, t => t.Liked);
        }
        else
        {
            // whatever the server has, it holds together: every song in an album the library has, every album's songs there
            output.WriteLine($"{info.Name} {info.Version}: {lib.Tracks.Count} songs, {lib.Albums.Count} albums, {lib.Artists.Count} artists");
            Assert.NotEmpty(lib.Tracks);
            Assert.NotEmpty(lib.Albums);
            Assert.NotEmpty(lib.Artists);
            Assert.All(lib.Tracks, t => Assert.NotNull(lib.Album(t.AlbumId)));
            Assert.All(lib.Albums, a => Assert.All(a.TrackIds, id => Assert.NotNull(lib.Track(id))));
            Assert.Equal(lib.Tracks.Count, lib.Tracks.Select(t => t.Id).Distinct().Count());
        }
        // an album's songs in disc and track order (the demo's first album of more than 8; another server's album.multiDisc)
        var album = server.IsDemo ? lib.Albums.First(a => a.TrackIds.Count > 8)
            : lib.Albums.FirstOrDefault(a => a.Id == server.Id("album.multiDisc")) ?? lib.Albums.FirstOrDefault(a => a.TrackIds.Select(id => lib.Track(id)!.Disc).Distinct().Count() > 1) ?? lib.Albums.OrderByDescending(a => a.TrackIds.Count).First();
        var numbers = album.TrackIds.Select(id => (lib.Track(id)!.Disc, lib.Track(id)!.Number)).ToList();
        Assert.Equal(numbers.OrderBy(x => x.Disc).ThenBy(x => x.Number), numbers);
        Assert.Equal(await c.SongCountAsync(), lib.Tracks.Count);
    }

    [Fact]
    public async Task AServerWithSmallPagesStillGivesTheWholeLibrary()
    {
        // a server that gives at most 40 songs or albums per page, whatever is asked for (some cap it below 500): the
        // client's paging, against a demo server of its own whatever the server under test
        using var capped = new DemoServer("--scale=3 --page-cap=40");
        var c = new SubsonicClient(await SubsonicClient.SignInAsync(capped.Url, "demo", "demo", Client), Client);
        var lib = await c.LoadLibraryAsync();
        Assert.Equal(293 * 3, lib.Tracks.Count);
        Assert.Equal(34 * 3, lib.Albums.Count);
        Assert.Equal(lib.Tracks.Count, lib.Tracks.Select(t => t.Id).Distinct().Count());
    }

    [Fact]
    public async Task PlaylistsCanBeMadeReorderedTrimmedRenamedAndDeleted()
    {
        var c = await SignedIn();
        var lists = await c.GetPlaylistsAsync(Id);
        Playlist? other;
        string[] ids;
        string? made = null;
        if (server.IsDemo)
        {
            Assert.Contains(lists, p => p.Name == "朋友的歌单" && p.Kind == PlaylistKind.ReadOnly && p.Owner == "friend");
            Assert.Contains(lists, p => p.Name == "深夜写代码" && p.Kind == PlaylistKind.User);
            other = lists.First(p => p.Kind == PlaylistKind.ReadOnly);
            ids = ["t1", "t2", "t3", "t9"];
        }
        else
        {
            ids = [.. Usable(await c.LoadLibraryAsync()).Take(4).Select(t => t.Id)];
            Assert.Equal(4, ids.Length);
            // another user's public playlist: the manifest's, one listed, or one the second test user makes now
            other = lists.FirstOrDefault(p => p.Id == server.Id("playlist.otherPublic")) ?? lists.FirstOrDefault(p => p.Owner != User);
            if (other is null && server.Other is { } friendLogin)
            {
                var friend = new SubsonicClient(await SubsonicClient.SignInAsync(server.Url, friendLogin.User, friendLogin.Password, Client), Client);
                made = (await friend.CreatePlaylistAsync("朋友的测试歌单", ids[..2]))!;
                await Raw(friend, "updatePlaylist", ("playlistId", made), ("public", "true"));
                other = (await c.GetPlaylistsAsync(Id)).FirstOrDefault(p => p.Id == made);
            }
            Assert.All(lists.Where(p => p.Owner == User), p => Assert.Equal(PlaylistKind.User, p.Kind));
            if (other is not null) Assert.True(other.Kind == PlaylistKind.ReadOnly && other.Owner != User, $"{other.Name}: {other.Kind}, {other.Owner}");
            else output.WriteLine("no other user's public playlist, and no second test user (users.other): the read-only part is not checked");
        }
        try
        {
            string id = (await c.CreatePlaylistAsync("tests", ids[..3]))!;
            async Task<List<string>> Entries() => (await c.GetPlaylistsAsync(Id)).Single(p => p.Id == id).Entries;
            Assert.Equal(ids[..3], await Entries());
            await c.OverwritePlaylistAsync(id, [ids[1], ids[0], ids[2]]);
            Assert.Equal([ids[1], ids[0], ids[2]], await Entries());
            await c.UpdatePlaylistAsync(id, name: "tests 2", add: [ids[3]], removeIndexes: [1]);
            Assert.Equal([ids[1], ids[2], ids[3]], await Entries());
            Assert.Equal("tests 2", (await c.GetPlaylistsAsync(Id)).Single(p => p.Id == id).Name);
            await c.DeletePlaylistAsync(id);
            Assert.DoesNotContain(await c.GetPlaylistsAsync(Id), p => p.Id == id);
            if (other is not null)
            {
                var e = await Assert.ThrowsAsync<SubsonicException>(() => c.UpdatePlaylistAsync(other.Id, add: [ids[0]]));
                Assert.Equal(50, e.Code);
            }
        }
        finally
        {
            if (made is not null && server.Other is { } o)
                await new SubsonicClient(await SubsonicClient.SignInAsync(server.Url, o.User, o.Password, Client), Client).DeletePlaylistAsync(made);
        }
    }

    [Fact]
    public async Task LikesAndPlaysAreKeptOnTheServer()
    {
        var c = await SignedIn();
        string id = server.IsDemo ? "t20" : Usable(await c.LoadLibraryAsync()).First().Id;
        var before = (await c.LoadLibraryAsync()).Track(id)!;
        await c.SetStarredAsync(id, !before.Liked);
        await c.ScrobbleAsync(id, submission: false);
        await c.ScrobbleAsync(id, submission: true, DateTimeOffset.Now);
        var after = (await c.LoadLibraryAsync()).Track(id)!;
        Assert.Equal(!before.Liked, after.Liked);
        Assert.Equal(before.PlayCount + 1, after.PlayCount);
        Assert.NotNull(after.LastPlayed);
        await c.SetStarredAsync(id, before.Liked);
    }

    [Fact]
    public async Task SearchLyricsRadioAndArtistInfo()
    {
        var c = await SignedIn();
        await c.ConnectAsync();
        var lib = await c.LoadLibraryAsync();
        var album = lib.Albums.First();
        Assert.Contains(album.Id, (await c.SearchAsync(album.Title)).Albums);
        Assert.Equal(0, (await c.SearchAsync("zzzz-nothing")).Count);

        if (server.IsDemo)
        {
            var song = lib.Tracks.First(t => t.Genre == "City Pop");
            var lyrics = await c.LyricsAsync(song);
            Assert.NotNull(lyrics);
            Assert.True(lyrics!.Count > 5 && lyrics[0].Time == 8);
            var similar = await c.SimilarSongsAsync(song.Id, Id);
            Assert.NotEmpty(similar);
            Assert.All(similar, id => Assert.Contains(lib.Track(id)!.Genre, new[] { "City Pop", "J-Pop", "Dream Pop" }));
            var info = await c.ArtistInfoAsync(lib.Artists[0].Id);
            Assert.NotNull(info);
            Assert.DoesNotContain("<", info!.Biography);
            Assert.Contains("演示数据", info.Biography);
            return;
        }

        // synced lyrics: the manifest's song, or the first that has some; its lines are the server's, offset applied
        Track? withLyrics = server.Id("track.syncedLyrics") is { } lid ? lib.Track(lid) : null;
        JsonElement synced = default;
        foreach (var t in withLyrics is not null ? new[] { withLyrics } : Usable(lib).Take(120))
        {
            var list = SubsonicClient.Array(SubsonicClient.Obj(await Raw(c, "getLyricsBySongId", ("id", t.Id)), "lyricsList"), "structuredLyrics");
            synced = list.FirstOrDefault(l => SubsonicClient.Bool(l, "synced") && SubsonicClient.Array(l, "line").Any());
            if (synced.ValueKind == JsonValueKind.Object) { withLyrics = t; break; }
        }
        if (synced.ValueKind == JsonValueKind.Object)
        {
            var lines = await c.LyricsAsync(withLyrics!);
            var first = SubsonicClient.Array(synced, "line").First();
            Assert.NotNull(lines);
            Assert.Equal(SubsonicClient.Array(synced, "line").Count(), lines!.Count);
            Assert.Equal(Math.Max(0, SubsonicClient.Num(first, "start") / 1000 - SubsonicClient.Num(synced, "offset") / 1000), lines[0].Time!.Value, 3);
            Assert.All(lines, l => Assert.NotNull(l.Time));
        }
        else output.WriteLine("no song with synced lyrics on this server (manifest key track.syncedLyrics)");

        // a radio: the server's similar songs (a server may pick them at random each time, so not compared call to call):
        // the client asks for 50 at most and gets songs, each once
        var seed = Usable(lib).First();
        var similarIds = await c.SimilarSongsAsync(seed.Id, Id);
        Assert.InRange(similarIds.Count, 0, 50);
        Assert.Equal(similarIds.Count, similarIds.Distinct().Count());
        Assert.All(similarIds, id => Assert.False(string.IsNullOrEmpty(id)));
        output.WriteLine($"getSimilarSongs2: {similarIds.Count} songs, {similarIds.Count(id => lib.Track(id) is not null)} of them in the library");

        // the biography as text: shown when the server has one
        var artist = lib.Artists[0];
        string bio = SubsonicClient.Str(SubsonicClient.Obj(await Raw(c, "getArtistInfo2", ("id", artist.Id)), "artistInfo2"), "biography") ?? "";
        var about = await c.ArtistInfoAsync(artist.Id);
        if (System.Text.RegularExpressions.Regex.Replace(bio, "<[^>]+>", "").Trim().Length > 0)
        {
            Assert.NotNull(about);
            Assert.DoesNotContain("<", about!.Biography);
        }
        else Assert.True(about is null || about.Biography.Length == 0, about?.Biography);
        output.WriteLine($"getArtistInfo2: {(bio.Length > 0 ? "a biography" : "no biography")}");
    }

    [Fact]
    public async Task ThePlayQueueIsSavedForAnotherDevice()
    {
        var c = await SignedIn();
        string[] ids = server.IsDemo ? ["t1", "t2", "t3"] : [.. Usable(await c.LoadLibraryAsync()).Take(3).Select(t => t.Id)];
        await c.SavePlayQueueAsync(ids, ids[1], 42.5);
        var q = await new SubsonicClient(c.Login, "Sonus (other)").GetPlayQueueAsync(Id);
        Assert.NotNull(q);
        Assert.Equal(ids, q!.TrackIds);
        Assert.Equal(ids[1], q.Current);
        Assert.Equal(42.5, q.Position, 3);
        Assert.Equal(Client, q.ChangedBy);
    }

    [Fact]
    public async Task CoverAndStreamUrlsServeImagesAndRanges()
    {
        var c = await SignedIn();
        using var http = new HttpClient();
        if (server.IsDemo)
        {
            var cover = await http.GetAsync(c.CoverUrl("al0"));
            Assert.Equal("image/jpeg", cover.Content.Headers.ContentType?.MediaType);
        }
        else
        {
            var lib = await c.LoadLibraryAsync();
            var art = lib.Albums.First(a => a.CoverArt is not null).CoverArt!;
            var cover = await http.GetAsync(c.CoverUrl(art));
            Assert.Equal(HttpStatusCode.OK, cover.StatusCode);
            Assert.StartsWith("image/", cover.Content.Headers.ContentType?.MediaType);
        }
        string song = server.IsDemo ? "t1" : Usable(await c.LoadLibraryAsync()).First().Id;
        using var req = new HttpRequestMessage(HttpMethod.Get, c.StreamUrl(song));
        req.Headers.Range = new System.Net.Http.Headers.RangeHeaderValue(0, 43);
        var audio = await http.SendAsync(req);
        Assert.Equal(HttpStatusCode.PartialContent, audio.StatusCode);
        var bytes = await audio.Content.ReadAsByteArrayAsync();
        if (server.IsDemo) Assert.Equal("RIFF", System.Text.Encoding.ASCII.GetString(bytes[..4]));
        else Assert.Equal(44, bytes.Length);
    }
}
