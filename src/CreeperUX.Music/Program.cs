using System.Runtime.InteropServices;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.Windows.AppLifecycle;

namespace CreeperUX.Music;

/// <summary>
/// Entry point, in place of the XAML-generated one: one window per data folder (a second start brings the first forward;
/// a test instance with its own CXMUSIC_DATA_DIR never finds the user's).
/// CreeperUX Music.exe [--demo http://127.0.0.1:4533]: the sign-in page offers that demo server's account.
/// </summary>
public static partial class Program
{
    public static string? DemoServer { get; private set; }

    [STAThread]
    private static int Main(string[] args)
    {
        WinRT.ComWrappersSupport.InitializeComWrappers();
        int demo = Array.IndexOf(args, "--demo");
        DemoServer = demo >= 0 && demo + 1 < args.Length ? args[demo + 1] : Environment.GetEnvironmentVariable("CXMUSIC_DEMO");
        // The system media controls and the taskbar group the app by this id, not by the executable's path
        SetCurrentProcessExplicitAppUserModelID(AppPaths.IsTestInstance ? "CreeperUX.Music.Test" : "CreeperUX.Music");
        if (RedirectToRunningInstance()) return 0;
        // The songs stream through WinINet (Media Foundation's HTTP source) and so do the media controls' cover thumbnails.
        // WinINet allows 2 connections per server: the playing song, the next one (loaded ahead) and the thumbnail queue
        // behind each other, and a new song can wait seconds for a connection (seen against a remote server).
        foreach (int option in new[] { InternetOptionMaxConnsPerServer, InternetOptionMaxConnsPer10Server })
        {
            int connections = 16;
            if (!InternetSetOptionW(IntPtr.Zero, option, ref connections, sizeof(int))) Log.Write($"connections per server: error {Marshal.GetLastPInvokeError()}");
        }
        Application.Start(p =>
        {
            SynchronizationContext.SetSynchronizationContext(new DispatcherQueueSynchronizationContext(DispatcherQueue.GetForCurrentThread()));
            _ = new App();
            WatchUiThread(DispatcherQueue.GetForCurrentThread());
        });
        return 0;
    }

    private static bool RedirectToRunningInstance()
    {
        var instance = AppInstance.FindOrRegisterForKey("CreeperUX Music:" + AppPaths.DataDirectory.ToLowerInvariant());
        if (instance.IsCurrent) return false;
        if (!Testing.E2EChannel.Enabled) AllowSetForegroundWindow(instance.ProcessId); // test instances never take the foreground
        var activation = AppInstance.GetCurrent().GetActivatedEventArgs();
        using var done = new ManualResetEventSlim();
        // a cross-process COM call: waited for off this STA thread, which would otherwise deadlock
        Task.Run(async () => { try { await instance.RedirectActivationToAsync(activation); } finally { done.Set(); } });
        done.Wait();
        return true;
    }

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool AllowSetForegroundWindow(uint processId);

    /// <summary>Writes to the log whenever the window stops answering for a quarter of a second or more (the UI thread is
    /// busy): when it happened and for how long, to find what makes the window stall.</summary>
    private static void WatchUiThread(DispatcherQueue ui)
    {
        var watch = new Thread(() =>
        {
            while (true)
            {
                Thread.Sleep(200);
                var answered = new ManualResetEventSlim(); // one per question: a late answer never counts for the next
                long asked = System.Diagnostics.Stopwatch.GetTimestamp();
                if (!ui.TryEnqueue(DispatcherQueuePriority.High, answered.Set)) return; // the window is gone
                if (answered.Wait(250)) continue;
                if (!answered.Wait(TimeSpan.FromSeconds(60))) { Log.Write("[ui] the window has not answered for 60 s"); answered.Wait(); }
                Log.Write($"[ui] the window did not answer for {System.Diagnostics.Stopwatch.GetElapsedTime(asked).TotalMilliseconds:0} ms");
            }
        }) { IsBackground = true, Priority = ThreadPriority.BelowNormal, Name = "UI watch" };
        watch.Start();
    }

    private const int InternetOptionMaxConnsPerServer = 73, InternetOptionMaxConnsPer10Server = 74;

    [LibraryImport("wininet.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool InternetSetOptionW(IntPtr internet, int option, ref int buffer, int length);

    [LibraryImport("shell32.dll", StringMarshalling = StringMarshalling.Utf16)]
    private static partial int SetCurrentProcessExplicitAppUserModelID(string appId);
}
