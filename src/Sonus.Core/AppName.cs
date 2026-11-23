namespace Sonus.Core;

/// <summary>
/// The app's name, and what it was before 0.4: CreeperUX Music. That build kept its data folder in
/// %LOCALAPPDATA%\CreeperUX Music and its Credential Manager entries as CreeperUXMusic:&lt;name&gt;, and it told the server
/// it was "CreeperUX Music (&lt;device&gt;)". Sonus takes those over on its first start and still reads the old client name.
/// </summary>
public static class AppName
{
    public const string Name = "Sonus";
    public const string Former = "CreeperUX Music";
    /// <summary>The former Credential Manager entries' prefix ("CreeperUXMusic:server").</summary>
    public const string FormerCredentialPrefix = "CreeperUXMusic";

    /// <summary>The client name the server keeps with a saved play queue ("Sonus (PC)").</summary>
    public static string Client(string device) => $"{Name} ({device})";

    /// <summary>The device in a client name, from this app or its former name ("Sonus (PC)", "CreeperUX Music (PC)" → "PC");
    /// another client's name as it is.</summary>
    public static string DeviceOf(string client)
    {
        foreach (string app in new[] { Name, Former })
        {
            if (client.StartsWith(app + " (", StringComparison.Ordinal) && client.EndsWith(')')) return client[(app.Length + 2)..^1];
        }
        return client;
    }

    /// <summary>
    /// Moves the former data folder (from) to the new one (to), once: nothing when to already exists or from does not.
    /// When the folder can't be moved as a whole (a file in it still open), its files are copied instead, and from is left
    /// as it is. Returns what happened, for the log, or null when there was nothing to do.
    /// </summary>
    public static string? AdoptFolder(string from, string to)
    {
        if (Directory.Exists(to) || !Directory.Exists(from)) return null;
        try
        {
            Directory.Move(from, to);
            return $"moved {from} to {to}";
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            int copied = 0, skipped = 0;
            Directory.CreateDirectory(to);
            foreach (string file in Directory.EnumerateFiles(from, "*", SearchOption.AllDirectories))
            {
                string target = Path.Combine(to, Path.GetRelativePath(from, file));
                try
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(target)!);
                    File.Copy(file, target, overwrite: false);
                    copied++;
                }
                catch (Exception e) when (e is IOException or UnauthorizedAccessException) { skipped++; }
            }
            return $"copied {copied} files from {from} to {to}, {skipped} not ({ex.Message})";
        }
    }
}
