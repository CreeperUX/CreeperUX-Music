using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using Sonus.Core.Connect;

namespace Sonus.Core.Tests;

/// <summary>
/// Sonus Connect version 2 (docs/protocol/connect.md) against the demo server (tools/demo-server/connect2.mjs): devices
/// share one session, the sender of the first play becomes the active device, remotes' commands change the session, a
/// transfer moves playback, a network loss with the grace period and resume, a device leaving with a goodbye, and the
/// session outliving its devices. Each test has a demo server of its own (one session per user), with a grace period of
/// 3 s instead of 10.
/// </summary>
public class ConnectSessionTests
{
    private const int GraceMs = 3000;

    /// <summary>A demo server for one test.</summary>
    private sealed class Demo : IAsyncDisposable
    {
        private readonly Process _node;
        public string Url { get; }
        private readonly List<SessionClient> _devices = [];

        private Demo(Process node, string url) { _node = node; Url = url; }

        public static Task<Demo> StartAsync()
        {
            string root = AppContext.BaseDirectory;
            while (!File.Exists(Path.Combine(root, "tools", "demo-server", "demo-server.mjs"))) root = Path.GetDirectoryName(root) ?? throw new InvalidOperationException("tools/demo-server/demo-server.mjs not found");
            var probe = new TcpListener(IPAddress.Loopback, 0); probe.Start(); int port = ((IPEndPoint)probe.LocalEndpoint).Port; probe.Stop();
            var start = new ProcessStartInfo("node", $"\"{Path.Combine(root, "tools", "demo-server", "demo-server.mjs")}\" {port}") { RedirectStandardOutput = true, UseShellExecute = false, CreateNoWindow = true };
            start.Environment["SONUS_DEMO_CONNECT_GRACE"] = GraceMs.ToString(System.Globalization.CultureInfo.InvariantCulture);
            start.Environment.Remove("SONUS_DEMO_CONNECT");
            start.Environment.Remove("SONUS_DEMO_CONNECT_STORE");
            var node = Process.Start(start)!;
            string? line = node.StandardOutput.ReadLine();
            if (line is null || !line.Contains("demo server")) throw new InvalidOperationException("the demo server did not start: " + line);
            return Task.FromResult(new Demo(node, $"http://127.0.0.1:{port}"));
        }

        /// <summary>A device of the demo user, connected.</summary>
        public async Task<SessionClient> DeviceAsync(string id, string name, bool canPlay = true, Func<SessionResume?>? resume = null)
        {
            var client = new SubsonicClient(await SubsonicClient.SignInAsync(Url, "demo", "demo", $"Sonus (tests {name})"), $"Sonus (tests {name})");
            await client.ConnectAsync();
            Assert.True(SessionClient.Supported(client), "the demo server offers version 2");
            var device = new SessionClient(client, id, name, "desktop", canPlay, "Sonus tests") { Resume = resume };
            device.Start();
            _devices.Add(device);
            await Until(() => device.IsConnected, $"{name} connected");
            return device;
        }

        /// <summary>Cuts that device's connection without a goodbye (a network loss), refusing its reconnecting for a while.</summary>
        public async Task DropAsync(SessionClient device, int holdMs = 0)
        {
            using var http = new HttpClient();
            var r = await http.GetStringAsync($"{Url}/__test/connect2/drop?u=demo&device={device.DeviceId}&hold={holdMs}");
            Assert.Contains("\"dropped\":true", r);
        }

        public async ValueTask DisposeAsync()
        {
            foreach (var d in _devices) await d.DisposeAsync();
            try { _node.Kill(); } catch (InvalidOperationException) { }
            _node.Dispose();
        }
    }

    private static async Task Until(Func<bool> ok, string what, int ms = 8000)
    {
        var clock = Stopwatch.StartNew();
        while (!ok())
        {
            if (clock.ElapsedMilliseconds > ms) throw new TimeoutException(what);
            await Task.Delay(25);
        }
    }

    private static readonly object Album = new { kind = "album", id = "al3", label = "Orbit" };
    private static readonly string[] Songs = ["t20", "t21", "t22", "t23"];

    [Fact]
    public async Task EveryDeviceSeesTheSessionAndTheFirstToPlayBecomesTheActiveDevice()
    {
        await using var demo = await Demo.StartAsync();
        var pc = await demo.DeviceAsync("tests-pc-0001", "书房电脑");
        var phone = await demo.DeviceAsync("tests-phone-01", "手机");
        Assert.Null(phone.Session.Current); // an empty session to begin with
        await Until(() => phone.Devices.Count == 2, "both listed");
        var reply = await pc.CommandAsync("playContext", new { context = Album, ids = Songs, startId = "t21" });
        Assert.True(reply.Ok, reply.Message);
        await Until(() => phone.Session.Current?.TrackId == "t21", "the phone sees the song");
        Assert.Equal("tests-pc-0001", phone.Session.ActiveDevice);
        Assert.True(phone.Session.Playing);
        Assert.Equal(new SessionDeviceRef("tests-pc-0001", "书房电脑"), phone.Session.LastDevice);
        Assert.Equal("Orbit", phone.Session.Context?.Label);
        Assert.Equal(["t20", "t21", "t22", "t23"], phone.Queue.Order);
        Assert.False(string.IsNullOrEmpty(phone.Session.Now?.Title)); // shown without a lookup
        // the position moves on while it plays, on the server's clock
        await Task.Delay(400);
        Assert.InRange(phone.Session.PositionAt(phone.ServerNow), 300, 3000);
    }

    [Fact]
    public async Task ARemotesCommandChangesTheSessionAndNotTheActiveDevice()
    {
        await using var demo = await Demo.StartAsync();
        var pc = await demo.DeviceAsync("tests-pc-0002", "书房电脑");
        var phone = await demo.DeviceAsync("tests-phone-02", "手机");
        await pc.CommandAsync("playContext", new { context = Album, ids = Songs, startId = "t20" });
        Assert.True((await phone.CommandAsync("next")).Ok);
        await Until(() => pc.Session.Current?.TrackId == "t21", "the active device is told");
        Assert.True(pc.IsActive);
        Assert.False(phone.IsActive);
        Assert.True((await phone.CommandAsync("add", new { ids = new[] { "t40" }, next = true })).Ok);
        await Until(() => pc.Queue.Manual.Count == 1, "one queue");
        Assert.Equal("t40", pc.Session.Next);
        Assert.True((await phone.CommandAsync("pause")).Ok);
        await Until(() => !pc.Session.Playing, "paused");
        // a report from a device that is not the active one is refused
        var report = await phone.ReportAsync("position", phone.Session.Current!.Key, 1000, phone.Session.Rev);
        Assert.Equal("notActive", report.Code);
    }

    [Fact]
    public async Task ATransferMovesPlaybackWhereItWasAndPlayHereWorksFromTheRemote()
    {
        await using var demo = await Demo.StartAsync();
        var pc = await demo.DeviceAsync("tests-pc-0003", "书房电脑");
        var phone = await demo.DeviceAsync("tests-phone-03", "手机");
        await pc.CommandAsync("playContext", new { context = Album, ids = Songs, startId = "t22" });
        Assert.True((await pc.CommandAsync("seek", new { positionMs = 30_000 })).Ok);
        Assert.True((await phone.CommandAsync("transfer", new { to = phone.DeviceId })).Ok); // play here
        await Until(() => pc.Session.ActiveDevice == phone.DeviceId, "the phone plays now");
        Assert.True(phone.IsActive);
        Assert.False(pc.IsActive); // the device it left is a remote
        Assert.Equal("t22", phone.Session.Current!.TrackId);
        Assert.InRange(phone.Session.PositionAt(phone.ServerNow), 30_000, 33_000);
        Assert.True(phone.Session.Playing);
        Assert.Equal("offline", (await pc.CommandAsync("transfer", new { to = "tests-nobody-1" })).Code);
    }

    [Fact]
    public async Task AfterANetworkLossWithinTheGracePeriodTheDeviceIsStillActive()
    {
        await using var demo = await Demo.StartAsync();
        var phone = await demo.DeviceAsync("tests-phone-04", "手机");
        var pc = await demo.DeviceAsync("tests-pc-0004", "书房电脑");
        await pc.CommandAsync("playContext", new { context = Album, ids = Songs, startId = "t20" });
        await Until(() => pc.IsActive, "active");
        await demo.DropAsync(pc); // the connection goes without a goodbye
        await Until(() => !pc.IsConnected, "pc noticed");
        Assert.Equal("tests-pc-0004", phone.Session.ActiveDevice); // still active, still playing
        Assert.True(phone.Session.Playing);
        await Until(() => pc.IsConnected, "pc reconnected by itself", GraceMs); // the backoff's first second
        Assert.True(pc.IsActive);
        await Task.Delay(GraceMs + 500);
        Assert.True(pc.IsActive);
        Assert.True(phone.Session.Playing);
    }

    [Fact]
    public async Task AfterTheGracePeriodTheSessionStopsWhereItWasAndAResumeMakesTheDeviceActiveAgain()
    {
        await using var demo = await Demo.StartAsync();
        var phone = await demo.DeviceAsync("tests-phone-05", "手机");
        var pc = await demo.DeviceAsync("tests-pc-0005", "书房电脑");
        // it keeps playing through a network loss, and says so when it is back (the rev it last saw: kept while away)
        pc.Resume = () => new SessionResume(pc.Session.Rev, true, 9_000);
        await pc.CommandAsync("playContext", new { context = Album, ids = Songs, startId = "t20" });
        await Until(() => pc.Session.Playing && pc.IsActive, "playing");
        await demo.DropAsync(pc, holdMs: GraceMs + 1500); // away for longer than the grace period
        await Until(() => phone.Session.ActiveDevice is null, "stopped after the grace period", GraceMs + 3000);
        Assert.False(phone.Session.Playing);
        Assert.InRange(phone.Session.PositionMs, 0, 2000); // where it was when the connection dropped, not where the grace ended
        Assert.Equal("书房电脑", phone.Session.LastDevice?.Name);
        await Until(() => pc.IsConnected, "pc back", 15_000);
        Assert.True(pc.IsActive); // the resume was taken
        await Until(() => phone.Session.ActiveDevice == pc.DeviceId && phone.Session.Playing, "the phone sees it play again");
        Assert.InRange(phone.Session.PositionAt(phone.ServerNow), 9_000, 11_000);
    }

    [Fact]
    public async Task AResumeAfterTheSessionChangedIsRefused()
    {
        await using var demo = await Demo.StartAsync();
        var phone = await demo.DeviceAsync("tests-phone-06", "手机");
        var pc = await demo.DeviceAsync("tests-pc-0006", "书房电脑");
        pc.Resume = () => new SessionResume(pc.Session.Rev, true, 9_000);
        await pc.CommandAsync("playContext", new { context = Album, ids = Songs, startId = "t20" });
        await Until(() => pc.IsActive, "active");
        await demo.DropAsync(pc, holdMs: GraceMs + 2500);
        await Until(() => phone.Session.ActiveDevice is null, "stopped", GraceMs + 3000);
        Assert.True((await phone.CommandAsync("next")).Ok); // the session moves on without it
        await Until(() => pc.IsConnected, "pc back", 15_000);
        Assert.False(pc.IsActive); // it stops, and shows the session as it now is
        Assert.Equal("t21", pc.Session.Current?.TrackId);
        Assert.False(pc.Session.Playing);
    }

    [Fact]
    public async Task ADeviceThatLeavesWithAGoodbyeStopsTheSessionAtOnceAndItOutlivesItsDevices()
    {
        await using var demo = await Demo.StartAsync();
        var pc = await demo.DeviceAsync("tests-pc-0007", "书房电脑");
        await pc.CommandAsync("playContext", new { context = Album, ids = Songs, startId = "t23" });
        await pc.CommandAsync("seek", new { positionMs = 83_000 });
        await pc.DisposeAsync(); // the app closes: no grace period
        var laptop = await demo.DeviceAsync("tests-laptop-07", "笔记本");
        Assert.Null(laptop.Session.ActiveDevice);
        Assert.False(laptop.Session.Playing);
        Assert.Equal("t23", laptop.Session.Current?.TrackId);
        Assert.InRange(laptop.Session.PositionMs, 83_000, 84_000); // stopped where it was
        Assert.Equal("书房电脑", laptop.Session.LastDevice?.Name); // "上次在「书房电脑」播放"
        Assert.True((await laptop.CommandAsync("play")).Ok);
        await Until(() => laptop.IsActive && laptop.Session.Playing, "the laptop plays it now");
        Assert.InRange(laptop.Session.PositionAt(laptop.ServerNow), 83_000, 86_000);
        await laptop.DisposeAsync();
        var phone = await demo.DeviceAsync("tests-phone-07", "手机"); // every device gone: the session is still there
        Assert.Null(phone.Session.ActiveDevice);
        Assert.Equal("t23", phone.Session.Current?.TrackId);
        Assert.Equal("笔记本", phone.Session.LastDevice?.Name);
    }

    [Fact]
    public async Task AnyDeviceSetsAnyDevicesVolumeAndARemoteOnlyDeviceCannotPlay()
    {
        await using var demo = await Demo.StartAsync();
        var pc = await demo.DeviceAsync("tests-pc-0008", "书房电脑");
        var remote = await demo.DeviceAsync("tests-remote-08", "遥控器", canPlay: false);
        (double? Volume, bool? Muted, string From)? asked = null;
        pc.VolumeAsked += (v, m, from) => asked = (v, m, from);
        Assert.True((await remote.CommandAsync("volume", new { device = pc.DeviceId, volume = 0.3 })).Ok);
        await Until(() => asked is not null, "the pc is asked");
        Assert.Equal((0.3, (bool?)null, remote.DeviceId), (asked!.Value.Volume!.Value, asked.Value.Muted, asked.Value.From));
        await pc.DeviceAsync(0.3, false); // as the app says its volume once set
        await Until(() => remote.Devices.FirstOrDefault(d => d.Id == pc.DeviceId)?.Volume == 0.3, "the list shows it");
        // nothing plays and this one can't: it can't start the session
        Assert.Equal("cannotPlay", (await remote.CommandAsync("playContext", new { context = Album, ids = Songs })).Code);
        Assert.Equal("nothing", (await remote.CommandAsync("play")).Code);
    }
}
