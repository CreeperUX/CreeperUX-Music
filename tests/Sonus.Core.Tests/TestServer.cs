using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text.Json;

namespace Sonus.Core.Tests;

/// <summary>
/// The server the tests talk to, once per test class: the demo server (tools/demo-server, the default), or the server
/// named by SONUS_TEST_SERVER, reached through the recording proxy (tools/e2e/proxy.mjs) so that its /__test/log and
/// /__test/offline work as the demo server's do. The test users come from SONUS_TEST_CREDENTIALS and the entities from
/// SONUS_TEST_MANIFEST (optional), as tools/e2e/target.mjs reads them (tools/e2e/README.md has the keys).
/// </summary>
public sealed class TestServer : IDisposable
{
    /// <summary>SONUS_TEST_SERVER, or null for the demo server.</summary>
    public static string? External { get; } = Environment.GetEnvironmentVariable("SONUS_TEST_SERVER")?.Trim().TrimEnd('/') is { Length: > 0 } url ? url : null;

    private readonly DemoServer? _demo;
    private readonly Process? _proxy;

    /// <summary>What the clients sign in to: the demo server, or the proxy in front of the server.</summary>
    public string Url { get; }
    public bool IsDemo => _demo is not null;
    public (string User, string Password) Main { get; }
    /// <summary>A second user (the demo's friend), when there is one.</summary>
    public (string User, string Password)? Other { get; }
    public IReadOnlyDictionary<string, string> Manifest { get; }

    public TestServer()
    {
        if (External is null)
        {
            _demo = new DemoServer();
            Url = _demo.Url;
            (Main, Other, Manifest) = (("demo", "demo"), ("friend", "friend"), new Dictionary<string, string>());
            return;
        }
        var creds = Read("SONUS_TEST_CREDENTIALS");
        Manifest = Read("SONUS_TEST_MANIFEST");
        Main = UserAt(creds, "users.main") ?? UserAt(creds, "main") ?? UserAt(creds, "") ?? UserAt(Manifest, "users.main")
            ?? throw new InvalidOperationException("SONUS_TEST_SERVER needs a test user: SONUS_TEST_CREDENTIALS (a JSON file, see tools/e2e/README.md)");
        Other = UserAt(creds, "users.other") ?? UserAt(creds, "other") ?? UserAt(Manifest, "users.other");
        _proxy = Process.Start(new ProcessStartInfo("node", $"\"{Path.Combine(Repo.Root, "tools", "e2e", "proxy.mjs")}\" \"{External}\" 0") { RedirectStandardOutput = true, UseShellExecute = false, CreateNoWindow = true })!;
        string? line = _proxy.StandardOutput.ReadLine();
        if (line is null || !line.StartsWith("recording proxy: ", StringComparison.Ordinal)) throw new InvalidOperationException("the recording proxy did not start: " + line);
        Url = line["recording proxy: ".Length..].Split(' ')[0];
    }

    /// <summary>The manifest's id for a key (track.syncedLyrics, album.multiDisc, …), or null.</summary>
    public string? Id(string key) => Manifest.TryGetValue(key, out var v) ? v : null;

    public void Dispose()
    {
        _demo?.Dispose();
        if (_proxy is null) return;
        try { _proxy.Kill(); } catch (InvalidOperationException) { }
        _proxy.Dispose();
    }

    private static Dictionary<string, string> Read(string variable)
    {
        var flat = new Dictionary<string, string>();
        if (Environment.GetEnvironmentVariable(variable) is not { Length: > 0 } path) return flat;
        using var doc = JsonDocument.Parse(File.ReadAllText(path));
        Flatten(doc.RootElement, "", flat);
        return flat;
    }

    /// <summary>{ "a": { "b": 1 } } → "a.b" = "1"; an "ids" or "entities" wrapper is looked through.</summary>
    private static void Flatten(JsonElement e, string prefix, Dictionary<string, string> into)
    {
        if (e.ValueKind == JsonValueKind.Object)
        {
            foreach (var p in e.EnumerateObject()) Flatten(p.Value, prefix.Length > 0 ? $"{prefix}.{p.Name}" : p.Name, into);
            return;
        }
        if (prefix.Length == 0 || e.ValueKind is JsonValueKind.Array or JsonValueKind.Null) return;
        into[prefix] = e.ValueKind == JsonValueKind.String ? e.GetString()! : e.GetRawText();
        foreach (string wrapper in new[] { "ids.", "entities." })
            if (prefix.StartsWith(wrapper, StringComparison.Ordinal)) into.TryAdd(prefix[wrapper.Length..], into[prefix]);
    }

    private static (string, string)? UserAt(IReadOnlyDictionary<string, string> flat, string key)
    {
        string K(string s) => key.Length > 0 ? $"{key}.{s}" : s;
        string? user = flat.GetValueOrDefault(K("username")) ?? flat.GetValueOrDefault(K("user")) ?? flat.GetValueOrDefault(K("name"));
        string? password = flat.GetValueOrDefault(K("password")) ?? flat.GetValueOrDefault(K("pass"));
        return user is { Length: > 0 } && password is { Length: > 0 } ? (user, password) : null;
    }
}

/// <summary>Starts the demo server (tools/demo-server/demo-server.mjs, Node.js): for <see cref="TestServer"/>, and on its own
/// where a test needs one whatever the server under test (a server that caps its pages).</summary>
public sealed class DemoServer : IDisposable
{
    private readonly Process _node;
    public string Url { get; }

    public DemoServer() : this("") { }

    /// <param name="options">Extra options for the demo server, as "--scale=3 --page-cap=40".</param>
    internal DemoServer(string options)
    {
        var probe = new TcpListener(IPAddress.Loopback, 0); probe.Start(); int port = ((IPEndPoint)probe.LocalEndpoint).Port; probe.Stop();
        _node = Process.Start(new ProcessStartInfo("node", $"\"{Path.Combine(Repo.Root, "tools", "demo-server", "demo-server.mjs")}\" {port} {options}") { RedirectStandardOutput = true, UseShellExecute = false, CreateNoWindow = true })!;
        string? line = _node.StandardOutput.ReadLine();
        if (line is null || !line.Contains("demo server")) throw new InvalidOperationException("the demo server did not start: " + line);
        Url = $"http://127.0.0.1:{port}";
    }

    public void Dispose() { try { _node.Kill(); } catch (InvalidOperationException) { } _node.Dispose(); }
}

internal static class Repo
{
    /// <summary>The repository (where tools/demo-server is), found from the test assembly up.</summary>
    public static string Root { get; } = Find();

    private static string Find()
    {
        string root = AppContext.BaseDirectory;
        while (!File.Exists(Path.Combine(root, "tools", "demo-server", "demo-server.mjs"))) root = Path.GetDirectoryName(root) ?? throw new InvalidOperationException("tools/demo-server/demo-server.mjs not found");
        return root;
    }
}
