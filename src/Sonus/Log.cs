using System.Collections.Concurrent;

namespace Sonus;

/// <summary>A small text log in the data folder (app.log), kept under 1 MB. Writing never waits: a thread that finds the
/// file busy leaves its line to the thread writing (see <see cref="UiSynchronizationContext"/> for why the UI thread
/// must not wait on a lock).</summary>
public static class Log
{
    private static readonly object Gate = new();
    private static readonly ConcurrentQueue<string> Lines = new();
    private static string FilePath => Path.Combine(AppPaths.DataDirectory, "app.log");

    public static void Write(string message)
    {
        Lines.Enqueue($"{DateTime.Now:yyyy-MM-dd HH:mm:ss.fff} {message}{Environment.NewLine}");
        // whoever holds the gate writes what is queued, and looks again once it lets go: a line queued meanwhile is
        // written by the holder or by this loop, never left behind
        while (!Lines.IsEmpty && Monitor.TryEnter(Gate))
        {
            try { WriteQueued(); }
            finally { Monitor.Exit(Gate); }
        }
    }

    private static void WriteQueued()
    {
        var text = new System.Text.StringBuilder();
        while (Lines.TryDequeue(out var line)) text.Append(line);
        if (text.Length == 0) return;
        try
        {
            Directory.CreateDirectory(AppPaths.DataDirectory);
            var info = new FileInfo(FilePath);
            if (info.Exists && info.Length > 1 << 20) File.Move(FilePath, FilePath + ".1", overwrite: true);
            File.AppendAllText(FilePath, text.ToString());
        }
        catch (IOException) { /* the log is not essential */ }
        catch (UnauthorizedAccessException) { }
    }
}
