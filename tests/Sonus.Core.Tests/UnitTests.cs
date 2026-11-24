using Sonus.Core;

namespace Sonus.Core.Tests;

public class SignInTests
{
    [Theory]
    [InlineData("music.example.com", "https://music.example.com")]
    [InlineData("http://host:4533/", "http://host:4533")]
    [InlineData("https://host/rest", "https://host")]
    [InlineData("https://host/app/", "https://host")]
    [InlineData("192.168.1.10:4533", "http://192.168.1.10:4533")]
    [InlineData("localhost:4533", "http://localhost:4533")]
    [InlineData("172.20.0.5:4533", "http://172.20.0.5:4533")]                 // a private range (Docker's, among others)
    [InlineData("100.101.102.103:4533", "http://100.101.102.103:4533")]       // Tailscale
    [InlineData("[fd7a:115c:a1e0::1]:4533", "http://[fd7a:115c:a1e0::1]:4533")] // Tailscale over IPv6 (unique-local)
    [InlineData("nas:4533", "http://nas:4533")]
    [InlineData("nas.local:4533", "http://nas.local:4533")]
    [InlineData("nas.tail1234.ts.net:4533", "http://nas.tail1234.ts.net:4533")]
    [InlineData("10.example.com", "https://10.example.com")]                  // a name, not the 10/8 range
    [InlineData("172.32.0.1", "https://172.32.0.1")]
    [InlineData("100.128.0.1", "https://100.128.0.1")]
    [InlineData("[2001:db8::1]:4533", "https://[2001:db8::1]:4533")]
    [InlineData("  ", "")]
    public void NormalizesServerAddresses(string input, string expected) => Assert.Equal(expected, SubsonicClient.NormalizeServer(input));

    [Theory]
    [InlineData("http://music.example.com", true)]
    [InlineData("http://203.0.113.5:4533", true)]
    [InlineData("http://[2001:db8::1]:4533", true)]
    [InlineData("https://music.example.com", false)]
    [InlineData("music.example.com", false)]          // becomes https://
    [InlineData("http://192.168.1.10:4533", false)]
    [InlineData("http://100.101.102.103:4533", false)]
    [InlineData("http://nas.local", false)]
    [InlineData("http://localhost:4533", false)]
    [InlineData("http://[::1]:4533", false)]
    [InlineData("", false)]
    public void PlainHttpIsFlaggedOnlyOverTheInternet(string server, bool plain) => Assert.Equal(plain, SubsonicClient.IsPlainOverInternet(server));

    [Theory]
    [InlineData("", "d41d8cd98f00b204e9800998ecf8427e")]
    [InlineData("sesame2b7a8c", "677360458cc1b212589d3375381847cd")] // the Subsonic documentation's example token
    [InlineData("中文密码salt", "fa0f54b75c93ce66abceebf516b0cd4f")]
    public void TokenIsMd5OfPasswordAndSalt(string text, string md5) => Assert.Equal(md5, SubsonicClient.Md5Hex(text));

    [Fact]
    public void LoginRoundTripsAndRejectsIncompleteJson()
    {
        var login = new Login("http://h", "u", "abcd", "0123");
        Assert.Equal(login, Login.FromJson(login.ToJson()));
        Assert.Null(Login.FromJson("{\"server\":\"http://h\",\"user\":\"u\"}"));
        Assert.Null(Login.FromJson("not json"));
        Assert.DoesNotContain("password", login.ToJson());
    }

    [Fact]
    public void UrlsCarryTheTokenAndAreStable()
    {
        var c = new SubsonicClient(new Login("http://h:4533", "demo", "s1", "t1"), "Sonus (PC)");
        string a = c.CoverUrl("al1"), b = c.CoverUrl("al1");
        Assert.Equal(a, b);
        Assert.StartsWith("http://h:4533/rest/getCoverArt.view?u=demo&t=t1&s=s1&v=1.16.1&c=Sonus%20%28PC%29&f=json&id=al1&size=600", a);
        Assert.Contains("format=mp3", c.StreamUrl("t1", "mp3"));
        Assert.DoesNotContain("format", c.StreamUrl("t1"));
    }

    [Fact]
    public void ApiKeyLoginRoundTripsAndKeepsTheKeyOutOfLogs()
    {
        var login = Login.WithApiKey("https://h", "u", "k3y-secret");
        Assert.True(login.IsApiKey);
        Assert.False(new Login("http://h", "u", "abcd", "0123").IsApiKey);
        Assert.Equal(login, Login.FromJson(login.ToJson()));
        Assert.Contains("\"apiKey\"", login.ToJson());
        Assert.DoesNotContain("token", login.ToJson());
        Assert.DoesNotContain("k3y-secret", login.ToString());
    }

    [Fact]
    public void ApiKeyUrlsCarryTheKeyAndNoUser()
    {
        // OpenSubsonic apiKeyAuthentication: the key alone; u with it is error 43
        var c = new SubsonicClient(Login.WithApiKey("http://h:4533", "demo", "abc"), "Sonus (PC)");
        string url = c.CoverUrl("al1");
        Assert.StartsWith("http://h:4533/rest/getCoverArt.view?apiKey=abc&v=1.16.1&c=Sonus%20%28PC%29&f=json&id=al1", url);
        Assert.DoesNotContain("u=", url);
        Assert.DoesNotContain("t=", url.Replace("format=", ""));
    }
}

public class DeviceLoginTests
{
    /// <summary>A server answering from a table: path → (status, JSON body); every request is recorded.</summary>
    private sealed class FakeServer(Func<HttpRequestMessage, (int Status, string Body)> answer) : HttpMessageHandler
    {
        public List<(string Path, string Body)> Requests { get; } = [];
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancel)
        {
            string body = request.Content is null ? "" : await request.Content.ReadAsStringAsync(cancel);
            Requests.Add((request.RequestUri!.AbsolutePath, body));
            var (status, json) = answer(request);
            return new HttpResponseMessage((System.Net.HttpStatusCode)status) { Content = new StringContent(json, System.Text.Encoding.UTF8, "application/json") };
        }
    }

    private const string Extensions = "{\"subsonic-response\":{\"status\":\"ok\",\"openSubsonicExtensions\":[{\"name\":\"apiKeyAuthentication\",\"versions\":[1]},{\"name\":\"sonusDeviceLogin\",\"versions\":[1]}]}}";

    [Fact]
    public async Task ProbeSaysWhetherTheServerOffersIt()
    {
        using var with = new HttpClient(new FakeServer(_ => (200, Extensions)));
        Assert.Equal(("http://192.168.1.10:4533", true), await DeviceLogin.ProbeAsync("192.168.1.10:4533", with));
        using var without = new HttpClient(new FakeServer(_ => (200, "{\"subsonic-response\":{\"status\":\"ok\",\"openSubsonicExtensions\":[]}}")));
        Assert.Equal(("https://music.example.com", false), await DeviceLogin.ProbeAsync("https://music.example.com/", without));
    }

    [Fact]
    public async Task StartsPollsAndGetsAKey()
    {
        int polls = 0;
        var server = new FakeServer(r => r.RequestUri!.AbsolutePath switch
        {
            "/music/auth/device/start" => (200, "{\"deviceCode\":\"dev-1\",\"userCode\":\"BCDF-GHJK\",\"verificationPath\":\"/music/app/#/device?code=BCDF-GHJK\",\"expiresIn\":600,\"interval\":1}"),
            "/music/auth/device/poll" => (200, ++polls < 2 ? "{\"status\":\"pending\"}" : "{\"status\":\"approved\",\"apiKey\":\"the-key\",\"username\":\"alice\"}"),
            _ => (404, "{}"),
        });
        using var http = new HttpClient(server);
        var start = await DeviceLogin.StartAsync("https://h/music", "Sonus", "书房电脑", http);
        Assert.Equal("BCDF-GHJK", start.UserCode);
        Assert.Equal("https://h/music/app/#/device?code=BCDF-GHJK", start.VerificationUrl.ToString());
        Assert.Equal("书房电脑", System.Text.Json.JsonDocument.Parse(server.Requests[0].Body).RootElement.GetProperty("device").GetString());

        var (state, login) = await DeviceLogin.WaitAsync(start, http);
        Assert.Equal(DeviceLoginState.Approved, state);
        Assert.Equal(Login.WithApiKey("https://h/music", "alice", "the-key"), login);
        Assert.Equal(2, polls);
        Assert.All(server.Requests.Skip(1), r => Assert.Contains("dev-1", r.Body));
    }

    [Theory]
    [InlineData("{\"status\":\"denied\"}", DeviceLoginState.Denied)]
    [InlineData("{\"status\":\"expired\"}", DeviceLoginState.Expired)]
    [InlineData("{\"status\":\"approved\"}", DeviceLoginState.Pending)] // approved without a key: not a sign-in
    public async Task PollReadsTheDecision(string answer, DeviceLoginState expected)
    {
        using var http = new HttpClient(new FakeServer(_ => (200, answer)));
        var start = new DeviceLoginStart("https://h", "dev-1", "BCDF-GHJK", new Uri("https://h/app/#/device"), TimeSpan.FromSeconds(1), DateTimeOffset.UtcNow.AddMinutes(1));
        Assert.Equal(expected, (await DeviceLogin.PollAsync(start, http)).State);
    }

    [Fact]
    public async Task RevokeGivesTheKeyBackAndSkipsPasswordSignIns()
    {
        var server = new FakeServer(_ => (200, "{}"));
        using var http = new HttpClient(server);
        Assert.True(await DeviceLogin.RevokeAsync(Login.WithApiKey("https://h", "alice", "the-key"), http));
        Assert.Equal("/auth/device/revoke", server.Requests.Single().Path);
        Assert.Contains("the-key", server.Requests.Single().Body);
        Assert.False(await DeviceLogin.RevokeAsync(new Login("https://h", "alice", "s", "t"), http));
        Assert.Single(server.Requests);
    }
}

public class LyricsTests
{
    [Fact]
    public void ParsesLrcWithSeveralStampsAndHeaders()
    {
        var lines = LyricsParser.Parse("[ar:Someone]\n[00:12.50]Hello\n[00:05.00][00:20]Twice\n\n[01:02.123]End")!;
        Assert.Equal([5.0, 12.5, 20.0, 62.123], lines.Select(l => l.Time!.Value));
        Assert.Equal(["Twice", "Hello", "Twice", "End"], lines.Select(l => l.Text));
    }

    [Fact]
    public void PlainTextIsUntimedAndTrimmed()
    {
        var lines = LyricsParser.Parse("one\ntwo\n\n")!;
        Assert.Equal(["one", "two"], lines.Select(l => l.Text));
        Assert.All(lines, l => Assert.Null(l.Time));
        Assert.Null(LyricsParser.Parse("  \n "));
    }

    [Fact]
    public void FindsTheCurrentLine()
    {
        var lines = LyricsParser.Parse("[00:05]a\n[00:10]b\n[00:15]c")!;
        Assert.Equal(-1, LyricsParser.CurrentLine(lines, 2));
        Assert.Equal(0, LyricsParser.CurrentLine(lines, 5));
        Assert.Equal(1, LyricsParser.CurrentLine(lines, 14.9));
        Assert.Equal(2, LyricsParser.CurrentLine(lines, 99));
    }
}

public class PlayQueueTests
{
    private static readonly Dictionary<string, Track> Tracks = Enumerable.Range(0, 10).ToDictionary(i => $"t{i}", i => new Track
    {
        Id = $"t{i}", Title = $"Song {i}", Artist = "A", ArtistId = "ar", Album = $"Album {i / 4}", AlbumId = $"al{i / 4}", AlbumArtist = "A", Path = $"A/Album {i / 4}/{i}.flac",
    });
    private static PlayQueue Queue(int seed = 1) => new(id => Tracks.GetValueOrDefault(id), new Random(seed));
    private static readonly PlayContext Ctx = new("album", "x", "X");
    private static readonly string[] All = Tracks.Keys.ToArray();

    [Fact]
    public void PlaysInOrderAndStopsAtTheEnd()
    {
        var q = Queue();
        Assert.Equal("t8", q.Start(Ctx, All, "t8"));
        Assert.Equal("t9", q.Peek());
        Assert.Equal("t9", q.Next());
        Assert.Null(q.Peek());
        Assert.Null(q.Next());
    }

    [Fact]
    public void RepeatPlaylistWrapsAndRepeatTrackReplays()
    {
        var q = Queue();
        q.Start(Ctx, All, "t9");
        q.SetOrder(PlaybackOrder.RepeatPlaylist);
        Assert.Equal("t0", q.Peek());
        Assert.Equal("t0", q.Next());
        q.SetOrder(PlaybackOrder.RepeatTrack);
        Assert.Null(q.Peek());
        Assert.Equal("t0", q.Next(ended: true));
        Assert.Equal("t1", q.Next()); // the Next button still moves on
    }

    [Fact]
    public void HandQueuedSongsPlayFirstAndPlayNextGoesInFront()
    {
        var q = Queue();
        q.Start(Ctx, All, "t0");
        q.Add(["t5", "t6"]);
        q.Add(["t9"], next: true);
        Assert.Equal(["t9", "t5", "t6", "t1"], q.Entries.Take(4).Select(e => e.TrackId));
        Assert.Equal("t9", q.Next());
        Assert.Equal("t5", q.Next());
        Assert.Equal("t6", q.Next());
        Assert.Equal("t1", q.Next()); // back in the context where it left off
    }

    [Fact]
    public void StopAfterCurrentStopsOnceAtTheEndOfTheSong()
    {
        var q = Queue();
        q.Start(Ctx, All, "t0");
        q.StopAfterCurrent = true;
        Assert.Null(q.Peek());
        Assert.Null(q.Next(ended: true));
        Assert.False(q.StopAfterCurrent);
    }

    [Fact]
    public void ShuffleKeepsTheChosenSongFirstAndEverySongOnce()
    {
        var q = Queue(7);
        q.SetOrder(PlaybackOrder.ShuffleTracks);
        q.Start(Ctx, All, "t3");
        Assert.Equal("t3", q.ContextIds[0]);
        Assert.Equal(All.Order(), q.ContextIds.Order());
        Assert.NotEqual(All, q.ContextIds);
        q.SetOrder(PlaybackOrder.Default);
        Assert.Equal(All, q.ContextIds); // back to the album's order
        Assert.Equal("t3", q.Current);
        Assert.Equal(3, q.Pointer);
    }

    [Fact]
    public void ShuffleAlbumsKeepsAlbumsTogether()
    {
        var q = Queue(3);
        q.SetOrder(PlaybackOrder.ShuffleAlbums);
        q.Start(Ctx, All, "t5");
        var albums = q.ContextIds.Select(id => Tracks[id].AlbumId).ToList();
        Assert.Equal("al1", albums[0]);
        Assert.Equal(3, albums.Select((a, i) => i == 0 || albums[i - 1] != a).Count(x => x)); // three runs, one per album
    }

    [Fact]
    public void MoveRemoveClearAndJump()
    {
        var q = Queue();
        q.Start(Ctx, All, "t0");
        q.Add(["t7"]);
        var entries = q.Entries.Select(e => e.Id).ToList(); // q1, c1:t1, c2:t2 …
        var order = new List<string> { entries[1], entries[0] }.Concat(entries.Skip(2)).ToList();
        q.Move(order, [entries[1]], manual: true); // t1 dragged above the queued t7, into the queue section
        Assert.Equal(["t1", "t7", "t2"], q.Entries.Take(3).Select(e => e.TrackId));
        Assert.True(q.Entries[0].Manual);
        q.Remove([q.Entries[2].Id]); // t2
        Assert.DoesNotContain("t2", q.Entries.Select(e => e.TrackId));
        Assert.Equal("t4", q.Jump(q.Entries.First(e => e.TrackId == "t4").Id));
        q.Clear(manual: false);
        Assert.All(q.Entries, e => Assert.True(e.Manual));
        q.Clear(manual: true);
        Assert.Empty(q.Entries);
    }

    [Fact]
    public void TheServerCopyHasTheCurrentSongAndWhatComes()
    {
        var q = Queue();
        q.Start(Ctx, All, "t2");
        q.Add(["t8"]);
        Assert.Equal(["t0", "t1", "t2", "t8", "t3", "t4", "t5", "t6", "t7", "t8", "t9"], q.ForServer());
        var other = Queue();
        Assert.Equal("t2", other.Adopt(Ctx, q.ForServer(), "t2"));
        Assert.Equal("t8", other.Peek());
    }

    // ---- found in code review: the preloaded next song must be the one Next(ended) moves to
    [Theory]
    [InlineData(PlaybackOrder.RepeatTrack, false)]
    [InlineData(PlaybackOrder.Default, true)]
    public void PeekAgreesWithTheEndOfTheSongWhenSongsAreQueuedByHand(PlaybackOrder order, bool stopAfter)
    {
        var q = Queue();
        q.Start(Ctx, All, "t0");
        q.SetOrder(order);
        q.StopAfterCurrent = stopAfter;
        q.Add(["t7"]);
        Assert.Null(q.Peek()); // nothing different follows by itself: nothing is preloaded
        var ended = q.Next(ended: true);
        Assert.Equal(order == PlaybackOrder.RepeatTrack ? "t0" : null, ended);
        Assert.Equal(1, q.Entries.Count(e => e.Manual)); // the hand-queued song is still waiting
    }

    [Fact]
    public void PeekIsTheHandQueuedSongOtherwise()
    {
        var q = Queue();
        q.Start(Ctx, All, "t0");
        q.Add(["t7"]);
        Assert.Equal(q.Peek(), q.Next(ended: true));
    }

    [Fact]
    public void ShuffleOffGoesBackToTheContextsOwnOrderForSearchesAndRadios()
    {
        var q = Queue(11);
        string[] results = ["t9", "t2", "t5", "t1"]; // a search: an order no lookup can rebuild
        q.Start(new PlayContext("search", "x", "搜索"), results, "t9");
        q.SetOrder(PlaybackOrder.ShuffleTracks);
        q.SetOrder(PlaybackOrder.Default);
        Assert.Equal(results, q.ContextIds);
        Assert.Equal("t2", q.Peek());
    }

    [Fact]
    public void AStaleQueueEntryIdRemovesNothing()
    {
        var q = Queue();
        q.Start(Ctx, All, "t0");
        string stale = q.Entries[0].Id; // c1:t1
        q.Next(); q.Next(); // t1 and t2 played: index 1 is behind the pointer now
        q.Remove([stale]);
        Assert.Equal(["t3", "t4"], q.Entries.Take(2).Select(e => e.TrackId));
        q.Remove(["c5:t9"]); // index 5 holds t5, not t9
        Assert.Contains("t5", q.Entries.Select(e => e.TrackId));
    }

    [Fact]
    public void PreviousAfterAHandQueuedSongGoesBackToTheContextSong()
    {
        var q = Queue();
        q.Start(Ctx, All, "t3");
        q.Add(["t8"], next: true);
        Assert.Equal("t8", q.Next());
        Assert.Equal("t3", q.Previous());
        Assert.Equal("t2", q.Previous());
    }

    [Fact]
    public void UnknownSongsAreLeftOut()
    {
        var q = Queue();
        Assert.Null(q.Start(Ctx, ["nope"], null));
        Assert.Equal("t1", q.Start(Ctx, ["nope", "t1"], null));
    }
}

public class LibraryTests
{
    [Fact]
    public void GroupingAgainDoesNotRepeatAlbumSongs()
    {
        // found in code review: adding a song the library did not know (from a playlist) grouped every album again
        Track T(string id, int n) => new() { Id = id, Title = id, Artist = "A", ArtistId = "ar", Album = "X", AlbumId = "al", AlbumArtist = "A", Number = n };
        var albums = new Dictionary<string, Album> { ["al"] = new() { Id = "al", Title = "X", Artist = "A", ArtistId = "ar" } };
        var first = LibraryBuilder.Group([T("a", 1), T("b", 2)], albums);
        var second = LibraryBuilder.Group([.. first.Tracks, T("c", 3)], albums);
        Assert.Equal(["a", "b", "c"], second.Album("al")!.TrackIds);
        Assert.Single(second.Artists);
    }
}

public class FormatTests
{
    [Fact]
    public void Durations()
    {
        Assert.Equal("3:05", Formats.Duration(185.9));
        Assert.Equal("1:02:03", Formats.Duration(3723));
        Assert.Equal("0:00", Formats.Duration(double.NaN));
        Assert.Equal("约 1 小时 20 分钟", Formats.LongDuration(4800));
        Assert.Equal("约 1 分钟", Formats.LongDuration(10));
    }

    [Fact]
    public void Codecs()
    {
        Assert.Equal("DSD64", LibraryBuilder.CodecOf("dsf", 2822400, 1, "audio/x-dsf"));
        Assert.Equal("DSD128", LibraryBuilder.CodecOf("dff", 5644800, 1, ""));
        Assert.Equal("ALAC", LibraryBuilder.CodecOf("m4a", 48000, 24, "audio/mp4"));
        Assert.Equal("AAC", LibraryBuilder.CodecOf("m4a", 44100, 0, "audio/mp4"));
        Assert.Equal("Monkey's Audio", LibraryBuilder.CodecOf("ape", 44100, 16, ""));
        Assert.Equal("XYZ", LibraryBuilder.CodecOf("xyz", 0, 0, ""));
    }

    [Fact]
    public void Relative()
    {
        var now = new DateTimeOffset(2026, 11, 22, 12, 0, 0, TimeSpan.Zero);
        Assert.Equal("从未", Formats.Relative(null, now));
        Assert.Equal("5 分钟前", Formats.Relative(now.AddMinutes(-5), now));
        Assert.Equal("3 天前", Formats.Relative(now.AddDays(-3), now));
    }
}
