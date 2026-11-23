namespace Sonus;

/// <summary>A small text log in the data folder (app.log), kept under 1 MB.</summary>
public static class Log
{
    private static readonly object Gate = new();
    private static string FilePath => Path.Combine(AppPaths.DataDirectory, "app.log");

    public static void Write(string message)
    {
        try
        {
            lock (Gate)
            {
                Directory.CreateDirectory(AppPaths.DataDirectory);
                var info = new FileInfo(FilePath);
                if (info.Exists && info.Length > 1 << 20) File.Move(FilePath, FilePath + ".1", overwrite: true);
                File.AppendAllText(FilePath, $"{DateTime.Now:yyyy-MM-dd HH:mm:ss.fff} {message}{Environment.NewLine}");
            }
        }
        catch (IOException) { /* the log is not essential */ }
        catch (UnauthorizedAccessException) { }
    }
}
