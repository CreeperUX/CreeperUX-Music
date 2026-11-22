using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text.Json;
using CreeperUX.Music.Core;

namespace CreeperUX.Music.Core.Tests;

/// <summary>Starts the demo server (server/demo-server.mjs, Node.js) once for the tests that talk to a server.</summary>
public sealed class DemoServer : IDisposable
{
    private readonly Process _node;
    public string Url { get; }

    public DemoServer()
    {
        string root = AppContext.BaseDirectory;
        while (!File.Exists(Path.Combine(root, "server", "demo-server.mjs"))) root = Path.GetDirectoryName(root) ?? throw new InvalidOperationException("server/demo-server.mjs not found");
        var probe = new TcpListener(IPAddress.Loopback, 0); probe.Start(); int port = ((IPEndPoint)probe.LocalEndpoint).Port; probe.Stop();
        _node = Process.Start(new ProcessStartInfo("node", $"\"{Path.Combine(root, "server", "demo-server.mjs")}\" {port}") { RedirectStandardOutput = true, UseShellExecute = false, CreateNoWindow = true })!;
        string? line = _node.StandardOutput.ReadLine();
        if (line is null || !line.Contains("demo server")) throw new InvalidOperationException("the demo server did not start: " + line);
        Url = $"http://127.0.0.1:{port}";
    }

    public void Dispose() { try { _node.Kill(); } catch (InvalidOperationException) { } _node.Dispose(); }
}

public class ServerTests(DemoServer server) : IClassFixture<DemoServer>
{
    private const string Client = "CreeperUX Music (tests)";
    private static string Id(JsonElement j) => SubsonicClient.Str(j, "id")!;
    private async Task<SubsonicClient> SignedIn() => new(await SubsonicClient.SignInAsync(server.Url, "demo", "demo", Client), Client);

    [Fact]
    public async Task AWrongPasswordIsRefusedWithAClearMessage()
    {
        var e = await Assert.ThrowsAsync<SubsonicException>(() => SubsonicClient.SignInAsync(server.Url + "/rest/", "demo", "nope", Client));
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
    public async Task ConnectsAndReadsTheWholeLibrary()
    {
        var c = await SignedIn();
        var info = await c.ConnectAsync();
        Assert.Equal("Navidrome", info.Name);
        Assert.Contains("songLyrics", c.Extensions);
        var lib = await c.LoadLibraryAsync();
        Assert.Equal(293, lib.Tracks.Count);
        Assert.Equal(34, lib.Albums.Count);
        Assert.Equal(17, lib.Artists.Count);
        Assert.Contains(lib.Tracks, t => t.Codec == "DSD64" && t.BitDepth == 1);
        Assert.Contains(lib.Tracks, t => t.Liked);
        var album = lib.Albums.First(a => a.TrackIds.Count > 8);
        var numbers = album.TrackIds.Select(id => (lib.Track(id)!.Disc, lib.Track(id)!.Number)).ToList();
        Assert.Equal(numbers.OrderBy(x => x.Disc).ThenBy(x => x.Number), numbers);
        Assert.Equal(await c.SongCountAsync(), lib.Tracks.Count);
    }

    [Fact]
    public async Task PlaylistsCanBeMadeReorderedTrimmedRenamedAndDeleted()
    {
        var c = await SignedIn();
        var lists = await c.GetPlaylistsAsync(Id);
        Assert.Contains(lists, p => p.Name == "朋友的歌单" && p.Kind == PlaylistKind.ReadOnly && p.Owner == "friend");
        Assert.Contains(lists, p => p.Name == "深夜写代码" && p.Kind == PlaylistKind.User);
        string id = (await c.CreatePlaylistAsync("tests", ["t1", "t2", "t3"]))!;
        async Task<List<string>> Entries() => (await c.GetPlaylistsAsync(Id)).Single(p => p.Id == id).Entries;
        Assert.Equal(["t1", "t2", "t3"], await Entries());
        await c.OverwritePlaylistAsync(id, ["t2", "t1", "t3"]);
        Assert.Equal(["t2", "t1", "t3"], await Entries());
        await c.UpdatePlaylistAsync(id, name: "tests 2", add: ["t9"], removeIndexes: [1]);
        Assert.Equal(["t2", "t3", "t9"], await Entries());
        Assert.Equal("tests 2", (await c.GetPlaylistsAsync(Id)).Single(p => p.Id == id).Name);
        await c.DeletePlaylistAsync(id);
        Assert.DoesNotContain(await c.GetPlaylistsAsync(Id), p => p.Id == id);
        var other = lists.First(p => p.Kind == PlaylistKind.ReadOnly);
        var e = await Assert.ThrowsAsync<SubsonicException>(() => c.UpdatePlaylistAsync(other.Id, add: ["t1"]));
        Assert.Equal(50, e.Code);
    }

    [Fact]
    public async Task LikesAndPlaysAreKeptOnTheServer()
    {
        var c = await SignedIn();
        var before = (await c.LoadLibraryAsync()).Track("t20")!;
        await c.SetStarredAsync("t20", !before.Liked);
        await c.ScrobbleAsync("t20", submission: false);
        await c.ScrobbleAsync("t20", submission: true, DateTimeOffset.Now);
        var after = (await c.LoadLibraryAsync()).Track("t20")!;
        Assert.Equal(!before.Liked, after.Liked);
        Assert.Equal(before.PlayCount + 1, after.PlayCount);
        Assert.NotNull(after.LastPlayed);
        await c.SetStarredAsync("t20", before.Liked);
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
    }

    [Fact]
    public async Task ThePlayQueueIsSavedForAnotherDevice()
    {
        var c = await SignedIn();
        await c.SavePlayQueueAsync(["t1", "t2", "t3"], "t2", 42.5);
        var q = await new SubsonicClient(c.Login, "CreeperUX Music (other)").GetPlayQueueAsync(Id);
        Assert.NotNull(q);
        Assert.Equal(["t1", "t2", "t3"], q!.TrackIds);
        Assert.Equal("t2", q.Current);
        Assert.Equal(42.5, q.Position, 3);
        Assert.Equal(Client, q.ChangedBy);
    }

    [Fact]
    public async Task CoverAndStreamUrlsServeImagesAndRanges()
    {
        var c = await SignedIn();
        using var http = new HttpClient();
        var cover = await http.GetAsync(c.CoverUrl("al0"));
        Assert.Equal("image/jpeg", cover.Content.Headers.ContentType?.MediaType);
        using var req = new HttpRequestMessage(HttpMethod.Get, c.StreamUrl("t1"));
        req.Headers.Range = new System.Net.Http.Headers.RangeHeaderValue(0, 43);
        var wav = await http.SendAsync(req);
        Assert.Equal(HttpStatusCode.PartialContent, wav.StatusCode);
        Assert.Equal("RIFF", System.Text.Encoding.ASCII.GetString((await wav.Content.ReadAsByteArrayAsync())[..4]));
    }
}
