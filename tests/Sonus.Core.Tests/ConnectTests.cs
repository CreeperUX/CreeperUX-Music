using Sonus.Core.Connect;

namespace Sonus.Core.Tests;

/// <summary>Sonus Connect against the demo server (tools/demo-server/connect.mjs, the protocol of the CreeperUX/navidrome fork).</summary>
public class ConnectTests(DemoServer server) : IClassFixture<DemoServer>
{
    private async Task<(SubsonicClient Client, ConnectClient Connect)> Device(string clientName, string name)
    {
        var client = new SubsonicClient(await SubsonicClient.SignInAsync(server.Url, "demo", "demo", clientName), clientName);
        await client.ConnectAsync();
        Assert.True(ConnectClient.Supported(client));
        var connect = new ConnectClient(client, name);
        connect.Start();
        return (client, connect);
    }

    private static async Task<T> Until<T>(Func<T?> value, string what, int ms = 8000) where T : class
    {
        var clock = System.Diagnostics.Stopwatch.StartNew();
        for (;;)
        {
            if (value() is { } v) return v;
            if (clock.ElapsedMilliseconds > ms) throw new TimeoutException(what);
            await Task.Delay(30);
        }
    }

    private static Task Until(Func<bool> ok, string what, int ms = 8000) => Until(() => ok() ? "" : null, what, ms);

    [Fact]
    public async Task TwoDevicesSeeEachOtherByTheNamesTheyGive()
    {
        var (_, a) = await Device("Connect test A", "书房电脑");
        var (_, b) = await Device("Connect test B", "客厅电脑");
        await using (a) await using (b)
        {
            await Until(() => a.Devices.Count == 2 && a.Devices.All(d => d.Kind == "desktop"), "both listed, named");
            Assert.Equivalent(new[] { "书房电脑", "客厅电脑" }, a.Devices.Select(d => d.Name).ToArray());
            Assert.NotEqual(a.DeviceId, b.DeviceId);
        }
        await Until(() => !a.IsConnected, "closed");
    }

    [Fact]
    public async Task AStateIsSharedAndItsPositionMovesOnWhilePlaying()
    {
        var (_, a) = await Device("Connect test C", "C");
        var (_, b) = await Device("Connect test D", "D");
        await using (a) await using (b)
        {
            await Until(() => a.IsConnected && b.IsConnected, "connected");
            await a.SendStateAsync(new ConnectState { TrackId = "t1", Title = "Song", PositionMs = 1000, DurationMs = 60_000, Playing = true, Count = 3 },
                new ConnectQueue(["t0", "t1", "t2"], 1));
            var seen = await Until(() => b.Devices.FirstOrDefault(d => d.Id == a.DeviceId && d.State is not null)?.State, "B sees A's state");
            Assert.Equal("t1", seen.TrackId);
            await Task.Delay(300);
            Assert.InRange(seen.PositionAt(b.ServerNow), 1200, 5000);
        }
    }

    [Fact]
    public async Task ACommandReachesTheDeviceItNamesAndAnOfflineOneIsReported()
    {
        var (_, a) = await Device("Connect test E", "E");
        var (_, b) = await Device("Connect test F", "F");
        await using (a) await using (b)
        {
            await Until(() => a.Devices.Count >= 2 && b.DeviceId is not null, "both connected");
            (string From, ConnectCommand Command)? got = null;
            b.CommandReceived += (from, command) => got = (from, command);
            await a.SendCommandAsync(b.DeviceId!, new ConnectCommand(ConnectCommand.Seek) { PositionMs = 42_000 });
            await Until(() => got is not null, "B got the command");
            Assert.Equal(a.DeviceId, got!.Value.From);
            Assert.Equal((ConnectCommand.Seek, 42_000L), (got.Value.Command.Action, got.Value.Command.PositionMs!.Value));

            string? failure = null;
            a.Failed += (code, _) => failure = code;
            await a.SendCommandAsync("nobody", new ConnectCommand(ConnectCommand.Pause));
            await Until(() => failure is not null, "offline reported");
            Assert.Equal("offline", failure);
        }
    }

    [Fact]
    public async Task ATransferLoadsTheQueueOnTheTargetAndStopsTheSource()
    {
        var (_, a) = await Device("Connect test G", "G");
        var (_, b) = await Device("Connect test H", "H");
        await using (a) await using (b)
        {
            await Until(() => a.Devices.Count >= 2 && b.DeviceId is not null, "both connected");
            var commands = new List<(string Device, ConnectCommand Command)>();
            a.CommandReceived += (_, c) => { lock (commands) commands.Add(("a", c)); };
            b.CommandReceived += (_, c) => { lock (commands) commands.Add(("b", c)); };
            await a.SendStateAsync(new ConnectState { TrackId = "t2", PositionMs = 30_000, Playing = false, Index = 2, Count = 3, Context = new ConnectContext("album", "al1", "Orbit") },
                new ConnectQueue(["t0", "t1", "t2"], 2));
            await Until(() => b.Devices.Any(d => d.Id == a.DeviceId && d.State is not null), "state arrived");
            await b.TransferAsync(a.DeviceId!, b.DeviceId!);
            await Until(() => { lock (commands) return commands.Count == 2; }, "load and stop");
            var load = commands.Single(c => c.Device == "b").Command;
            Assert.Equal(ConnectCommand.Load, load.Action);
            Assert.Equal(["t0", "t1", "t2"], load.Queue!.Ids);
            Assert.Equal((2, 30_000L, false, "al1"), (load.Queue.Index, load.PositionMs!.Value, load.Start!.Value, load.Context!.Id));
            Assert.Equal(a.DeviceId, load.Source); // where it came from, though B asked
            Assert.Equal(ConnectCommand.Stop, commands.Single(c => c.Device == "a").Command.Action);
        }
    }

    [Fact]
    public async Task AfterTheServerDropsTheConnectionItComesBackAndSaysItsStateAgain()
    {
        var (_, a) = await Device("Connect test I", "I");
        var (_, b) = await Device("Connect test J", "J");
        await using (a) await using (b)
        {
            await Until(() => a.IsConnected && b.IsConnected, "connected");
            await a.SendStateAsync(new ConnectState { TrackId = "t9", PositionMs = 0, Playing = false }, null);
            using var http = new HttpClient();
            await http.GetAsync($"{server.Url}/__test/offline?on=1");
            await Until(() => !a.IsConnected, "dropped");
            await http.GetAsync($"{server.Url}/__test/offline?on=0");
            await Until(() => a.IsConnected && b.IsConnected, "back", 15_000);
            await Until(() => b.Devices.Any(d => d.Id == a.DeviceId && d.State?.TrackId == "t9"), "A's state said again", 15_000);
        }
    }
}
