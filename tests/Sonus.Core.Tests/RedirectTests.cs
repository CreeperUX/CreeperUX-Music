using System.Net;
using System.Net.Sockets;
using System.Text;
using Xunit;

namespace Sonus.Core.Tests;

/// <summary>Where the redirects lead, unit by unit.</summary>
public class RedirectsUnitTests
{
    [Theory]
    [InlineData("http://music.example.com/rest/ping.view?u=a", "https://music.example.com/rest/ping.view?u=a", "/rest/ping.view", "https://music.example.com")]
    [InlineData("http://h/rest/ping.view", "https://h/music/rest/ping.view", "/rest/ping.view", "https://h/music")]
    [InlineData("http://h/rest/ping.view", "https://h:8443/rest/ping.view", "/rest/ping.view", "https://h:8443")]
    [InlineData("http://[fd00::1]:4533/auth/device/start", "https://[fd00::1]/auth/device/start", "/auth/device/start", "https://[fd00::1]")]
    [InlineData("https://h/rest/ping.view", "https://h/rest/ping.view", "/rest/ping.view", null)] // not redirected
    [InlineData("http://h/rest/ping.view", "https://h/login", "/rest/ping.view", null)] // not the API (a sign-in page)
    public void TheAddressARedirectLedTo(string sent, string ended, string path, string? expected) =>
        Assert.Equal(expected, Redirects.MovedBase(new Uri(sent), new Uri(ended), path));

    [Theory]
    [InlineData("http://h/a", "https://h/a", true)]
    [InlineData("http://h/a", "http://h:8080/a", true)]
    [InlineData("https://h/a", "http://h/a", false)] // never down to http
    [InlineData("https://h/a", "https://other/a", false)] // never to another host
    public void APostFollowsOnlyToTheSameHostAndNeverDownToHttp(string from, string to, bool expected) =>
        Assert.Equal(expected, Redirects.MayFollow(new Uri(from), new Uri(to)));
}

/// <summary>
/// A server behind an address that redirects, as the owner's reverse proxy answers every http:// request with 301 to
/// https://: here a small front on its own port answers everything with a redirect to the demo server (another port, so
/// another server address, as http:// → https:// is). HttpClient turns a redirected POST into a GET without its content;
/// the probe, the browser sign-in (its POSTs), the password sign-in and the API's POSTs must all work through the front,
/// and the client must keep the address the redirect led to.
/// </summary>
public sealed class RedirectTests(DemoServer demo) : IClassFixture<DemoServer>, IDisposable
{
    private readonly List<RedirectFront> _fronts = [];
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(20) };

    public void Dispose() { foreach (var f in _fronts) f.Dispose(); }

    private string Front(string target, int status = 301)
    {
        var f = new RedirectFront(target, status);
        _fronts.Add(f);
        return f.Url;
    }

    [Fact]
    public async Task TheProbeGivesTheAddressTheRedirectLedTo()
    {
        var (server, supported) = await DeviceLogin.ProbeAsync(Front(demo.Url), Http);
        Assert.Equal(demo.Url, server);
        Assert.True(supported);
    }

    [Fact]
    public async Task BrowserSignInWorksThroughARedirectingAddress()
    {
        string redirecting = Front(demo.Url);
        // started at the redirecting address itself (the POST is sent on as a POST, not turned into a GET)
        var start = await DeviceLogin.StartAsync(redirecting, "Sonus", "书房电脑", Http);
        Assert.Equal(demo.Url, start.Server);
        Assert.StartsWith($"{demo.Url}/app/#/device", start.VerificationUrl.ToString());
        var waiting = DeviceLogin.WaitAsync(start, Http);
        await Task.Delay(300);
        Assert.Contains("\"decided\":true", await Http.GetStringAsync($"{demo.Url}/__test/device?code={start.UserCode}&decide=allow"));
        var (state, login) = await waiting;
        Assert.Equal(DeviceLoginState.Approved, state);
        Assert.Equal(demo.Url, login!.Server);
        var client = new SubsonicClient(login, "Sonus (Test)", Http);
        Assert.Equal("Navidrome", (await client.ConnectAsync()).Name);
        // given back through the redirecting address too (a POST): the key stops working
        Assert.True(await DeviceLogin.RevokeAsync(login with { Server = redirecting }, Http));
        var e = await Assert.ThrowsAsync<SubsonicException>(() => client.ConnectAsync());
        Assert.Equal(44, e.Code); // OpenSubsonic: an API key that is not (any more) valid
    }

    [Theory]
    [InlineData(302)]
    [InlineData(303)]
    [InlineData(307)] // a POST by itself
    [InlineData(308)]
    public async Task OtherRedirectsWorkToo(int status)
    {
        var start = await DeviceLogin.StartAsync(Front(demo.Url, status), "Sonus", "书房电脑", Http);
        Assert.Equal(demo.Url, start.Server);
    }

    [Fact]
    public async Task PasswordSignInKeepsTheAddressTheRedirectLedTo()
    {
        var login = await SubsonicClient.SignInAsync(Front(demo.Url), "demo", "demo", "Sonus (Test)", Http);
        Assert.Equal(demo.Url, login.Server);
    }

    [Fact]
    public async Task AKeptSignInAtARedirectingAddressMovesAndItsPostsStayPosts()
    {
        // a sign-in kept from before (0.6.2 kept the address typed): the first request moves it
        var kept = (await SubsonicClient.SignInAsync(demo.Url, "demo", "demo", "Sonus (Test)", Http)) with { Server = Front(demo.Url) };
        var client = new SubsonicClient(kept, "Sonus (Test)", Http);
        await client.ConnectAsync();
        Assert.Equal(demo.Url, client.Login.Server);
        Assert.Contains("formPost", client.Extensions);
        // a POSTed form through a redirecting address: sent on as a POST with its form, not as a GET without it
        var other = new SubsonicClient(kept with { Server = Front(demo.Url) }, "Sonus (Test)", Http);
        foreach (string x in client.Extensions) other.Extensions.Add(x); // as ConnectAsync finds them, without a request that would move the address first
        string? id = await other.CreatePlaylistAsync("经过重定向", ["t1", "t2"]);
        Assert.False(string.IsNullOrEmpty(id));
        Assert.Equal(demo.Url, other.Login.Server);
        await other.DeletePlaylistAsync(id!);
    }

    [Fact]
    public async Task APostIsNotSentOnToAnotherHost()
    {
        // the same demo server by another host name: a POST (with what it carries) is not handed to another host
        string elsewhere = Front(demo.Url.Replace("127.0.0.1", "localhost", StringComparison.Ordinal));
        var e = await Assert.ThrowsAsync<SubsonicException>(() => DeviceLogin.StartAsync(elsewhere, "Sonus", "书房电脑", Http));
        Assert.Contains("没有跟过去", e.Message);
    }
}

/// <summary>A tiny HTTP server on 127.0.0.1 that answers every request (any method) with a redirect to the same path and
/// query at the target.</summary>
internal sealed class RedirectFront : IDisposable
{
    private readonly TcpListener _listener = new(IPAddress.Loopback, 0);
    private readonly CancellationTokenSource _stop = new();
    public string Url { get; }

    public RedirectFront(string target, int status)
    {
        _listener.Start();
        Url = $"http://127.0.0.1:{((IPEndPoint)_listener.LocalEndpoint).Port}";
        _ = Task.Run(async () =>
        {
            while (!_stop.IsCancellationRequested)
            {
                TcpClient client;
                try { client = await _listener.AcceptTcpClientAsync(_stop.Token); }
                catch (Exception) { return; }
                _ = Task.Run(() => Answer(client, target, status));
            }
        });
    }

    private static async Task Answer(TcpClient client, string target, int status)
    {
        using (client)
        {
            var stream = client.GetStream();
            var head = new StringBuilder();
            var one = new byte[1];
            while (!head.ToString().EndsWith("\r\n\r\n", StringComparison.Ordinal) && await stream.ReadAsync(one) == 1) head.Append((char)one[0]);
            string[] lines = head.ToString().Split("\r\n");
            string path = lines[0].Split(' ') is { Length: >= 2 } parts ? parts[1] : "/";
            int length = lines.Select(l => l.Split(':', 2)).Where(p => p.Length == 2 && p[0].Trim().Equals("Content-Length", StringComparison.OrdinalIgnoreCase)).Select(p => int.Parse(p[1].Trim(), System.Globalization.CultureInfo.InvariantCulture)).FirstOrDefault();
            if (lines.Any(l => l.StartsWith("Transfer-Encoding:", StringComparison.OrdinalIgnoreCase) && l.Contains("chunked", StringComparison.OrdinalIgnoreCase)))
            {
                // a body of unknown length (JsonContent's): read to its last chunk, so the connection closes cleanly
                var rest = new StringBuilder();
                while (!rest.ToString().EndsWith("0\r\n\r\n", StringComparison.Ordinal) && await stream.ReadAsync(one) == 1) rest.Append((char)one[0]);
            }
            var body = new byte[length];
            for (int read = 0; read < length;) { int n = await stream.ReadAsync(body.AsMemory(read)); if (n == 0) break; read += n; }
            byte[] answer = Encoding.ASCII.GetBytes($"HTTP/1.1 {status} Redirect\r\nLocation: {target}{path}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            await stream.WriteAsync(answer);
        }
    }

    public void Dispose()
    {
        _stop.Cancel();
        _listener.Stop();
    }
}
