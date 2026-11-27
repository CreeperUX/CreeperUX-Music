using System.Runtime.InteropServices;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.Windows.AppLifecycle;

namespace Sonus;

/// <summary>
/// Entry point, in place of the XAML-generated one: one window per data folder (a second start brings the first forward;
/// a test instance with its own SONUS_DATA_DIR never finds the user's).
/// Sonus.exe [--demo http://127.0.0.1:4533]: the sign-in page offers that demo server's account.
/// </summary>
public static partial class Program
{
    public static string? DemoServer { get; private set; }

    [STAThread]
    private static int Main(string[] args)
    {
        WinRT.ComWrappersSupport.InitializeComWrappers();
        int demo = Array.IndexOf(args, "--demo");
        DemoServer = demo >= 0 && demo + 1 < args.Length ? args[demo + 1] : Environment.GetEnvironmentVariable("SONUS_DEMO");
        // The system media controls and the taskbar group the app by this id, not by the executable's path
        SetCurrentProcessExplicitAppUserModelID(AppPaths.IsTestInstance ? "Sonus.Test" : "Sonus");
        TakeOverFormerName();
        if (RedirectToRunningInstance()) return 0;
        // the start and the end of each process, so a log section can be matched with an exit code
        Log.Write($"[process] {Environment.ProcessId} started: Sonus {Updates.UpdateService.CurrentText} {RuntimeInformation.ProcessArchitecture} on {RuntimeInformation.OSArchitecture}");
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
            SynchronizationContext.SetSynchronizationContext(new UiSynchronizationContext(DispatcherQueue.GetForCurrentThread()));
            _ = new App();
            WatchUiThread(DispatcherQueue.GetForCurrentThread());
        });
        // The message loop has ended, and nothing is laid out any more: waits on this thread pump again, as the CLR's do.
        // The runtime's shutdown waits here for the finalizer thread, which may still be releasing objects that live on
        // this thread (calls into it): without pumping, the process lingered a second before it ended.
        SynchronizationContext.SetSynchronizationContext(null);
        Log.Write("[exit] the window closed: the app ends");
        return 0;
    }

    /// <summary>Before 0.4 the app was CreeperUX Music: its data folder and its Credential Manager entries become Sonus's,
    /// once (later starts find nothing left to take). The GitHub token earlier versions kept for updates is deleted.</summary>
    private static void TakeOverFormerName()
    {
        if (AppPaths.FormerDataDirectory is { } former && Core.AppName.AdoptFolder(former, AppPaths.DataDirectory) is { } moved) Log.Write($"[former name] {moved}");
        foreach (string entry in Interop.Credentials.AdoptFormer()) Log.Write($"[former name] {entry}");
        foreach (string entry in Interop.Credentials.DropRetired()) Log.Write($"[credentials] {entry}");
    }

    private static bool RedirectToRunningInstance()
    {
        var instance = AppInstance.FindOrRegisterForKey("Sonus:" + AppPaths.DataDirectory.ToLowerInvariant());
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
