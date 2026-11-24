using System.Text.Json;
using Sonus.Core.Connect;

namespace Sonus.Core.Tests;

/// <summary>
/// The test vectors of Sonus Connect version 2 (docs/protocol/connect-vectors.json, made by the reference session logic in
/// tools/demo-server/connect-session.mjs) replayed on this app's own <see cref="PlayQueue"/>: every step that moves the
/// queue is done here too, with the same random numbers, and the queue must then be what the vector says. So the server's
/// queue is PlayQueue's, as the protocol promises. (Shuffling by album or folder is arranged by the sending device and
/// is left out here.)
/// </summary>
public class ConnectVectorsTests
{
    /// <summary>Random numbers as the vectors hand them out: the case's list in turn, each modulo n, then 0s.</summary>
    private sealed class SequenceRandom(int[] values) : Random
    {
        private int _at;
        public override int Next(int maxValue) => _at < values.Length ? ((values[_at++] % maxValue) + maxValue) % maxValue : 0;
    }

    private static JsonElement Vectors()
    {
        string root = AppContext.BaseDirectory;
        while (!File.Exists(Path.Combine(root, "docs", "protocol", "connect-vectors.json"))) root = Path.GetDirectoryName(root) ?? throw new InvalidOperationException("docs/protocol/connect-vectors.json not found");
        return JsonDocument.Parse(File.ReadAllText(Path.Combine(root, "docs", "protocol", "connect-vectors.json"))).RootElement.Clone();
    }

    private static string? S(JsonElement e, string name) => e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
    private static List<string> Ids(JsonElement e, string name) => e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Array ? v.EnumerateArray().Select(x => x.GetString()!).ToList() : [];
    private static bool B(JsonElement e, string name) => e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.True;

    [Fact]
    public void TheVectorsQueueIsWhatPlayQueueDoes()
    {
        var file = Vectors();
        var library = file.GetProperty("library").EnumerateObject().ToDictionary(p => p.Name, p => new Track
        {
            Id = p.Name, Title = S(p.Value, "title")!, Artist = S(p.Value, "artist")!, ArtistId = "ar", Album = S(p.Value, "album")!, AlbumId = S(p.Value, "albumId")!, AlbumArtist = "A",
            Duration = p.Value.GetProperty("durationMs").GetDouble() / 1000,
        });
        int checkedSteps = 0, cases = 0;
        foreach (var c in file.GetProperty("cases").EnumerateArray())
        {
            string name = S(c, "name")!;
            if (c.GetRawText().Contains("shuffleAlbums") || c.GetRawText().Contains("shuffleFolders")) continue; // the sender arranges those
            cases++;
            var q = new PlayQueue(id => library.GetValueOrDefault(id), new SequenceRandom(c.GetProperty("random").EnumerateArray().Select(x => x.GetInt32()).ToArray()));
            JsonElement? before = null;
            int n = 0;
            foreach (var step in c.GetProperty("steps").EnumerateArray())
            {
                n++;
                var expect = step.GetProperty("expect");
                if (step.TryGetProperty("send", out var msg)) Apply(q, msg, step.GetProperty("at").GetInt64(), before, expect);
                string where = $"{name}, step {n}";
                var queue = expect.GetProperty("queue");
                var session = expect.GetProperty("session");
                Assert.True(Ids(queue, "order").SequenceEqual(q.ContextIds), $"{where}: order {string.Join(",", q.ContextIds)}");
                Assert.True(queue.GetProperty("pointer").GetInt32() == q.Pointer, $"{where}: pointer {q.Pointer}");
                var manual = queue.GetProperty("manual").EnumerateArray().Select(m => $"{S(m, "key")}:{S(m, "trackId")}");
                Assert.True(manual.SequenceEqual(q.Entries.Where(e => e.Manual).Select(e => $"{e.Id}:{e.TrackId}")), $"{where}: manual");
                string? current = session.GetProperty("current") is { ValueKind: JsonValueKind.Object } cur ? S(cur, "trackId") : null;
                Assert.True(current == q.Current, $"{where}: current {q.Current}, expected {current}");
                Assert.True(S(session, "mode") == SessionModes.Of(q.Order), $"{where}: mode {q.Order}");
                Assert.True(B(session, "stopAfterCurrent") == q.StopAfterCurrent, $"{where}: stop after current");
                Assert.True(S(session, "next") == q.Peek(), $"{where}: next {q.Peek()}");
                before = session;
                checkedSteps++;
            }
        }
        Assert.True(cases >= 10 && checkedSteps >= 100, $"{cases} cases, {checkedSteps} steps");
    }

    /// <summary>What a step does to the queue, as the session logic decides it.</summary>
    private static void Apply(PlayQueue q, JsonElement msg, long at, JsonElement? before, JsonElement expect)
    {
        var errors = expect.GetProperty("replies").EnumerateArray().Where(r => r.TryGetProperty("msg", out var m) && S(m, "type") == "error").Select(r => S(r.GetProperty("msg"), "code")).ToList();
        string type = S(msg, "type") ?? "";
        string action = S(msg, type == "report" ? "event" : "action") ?? "";
        // refused: nothing changed (a remove with stale keys still removes the rest; a failed song is answered "unplayable")
        if (errors.Any(e => e is "nothing" or "invalid" or "cannotPlay" or "notActive" or "offline") || (errors.Contains("stale") && action != "remove")) return;
        if (type == "report")
        {
            if (action == "ended") q.Next(ended: true);
            else if (action == "failed") q.Next();
            return;
        }
        if (type != "command") return;
        switch (action)
        {
            case "playContext":
                var context = msg.TryGetProperty("context", out var ctx) && ctx.ValueKind == JsonValueKind.Object ? new PlayContext(S(ctx, "kind") ?? "", S(ctx, "id") ?? "", S(ctx, "label") ?? "") : new PlayContext("", "", "");
                q.Start(context, Ids(msg, "ids"), S(msg, "startId"), B(msg, "shuffle"));
                break;
            case "next": q.Next(); break;
            case "play" when before?.GetProperty("current").ValueKind == JsonValueKind.Null: q.Next(); break; // songs queued by hand, nothing current yet
            case "previous":
                var b = before!.Value;
                long position = b.GetProperty("positionMs").GetInt64() + (B(b, "playing") ? Math.Max(0, at - b.GetProperty("at").GetInt64()) : 0);
                long duration = b.GetProperty("durationMs").GetInt64();
                if (duration > 0) position = Math.Min(position, duration);
                if (position <= 3000) q.Previous(); // more than 3 s in: back to the start of the same song
                break;
            case "jump": q.Jump(S(msg, "entry")!); break;
            case "add": q.Add(Ids(msg, "ids"), B(msg, "next")); break;
            case "move": q.Move(Ids(msg, "order"), Ids(msg, "keys"), B(msg, "manual")); break;
            case "remove": q.Remove(Ids(msg, "entries")); break;
            case "clear": q.Clear(B(msg, "manual")); break;
            case "mode": q.SetOrder(SessionModes.Parse(S(msg, "mode"))); break;
            case "stopAfterCurrent": q.StopAfterCurrent = B(msg, "on"); break;
        }
    }
}
