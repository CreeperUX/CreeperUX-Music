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
        Application.Start(p =>
        {
            SynchronizationContext.SetSynchronizationContext(new DispatcherQueueSynchronizationContext(DispatcherQueue.GetForCurrentThread()));
            _ = new App();
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

    [LibraryImport("shell32.dll", StringMarshalling = StringMarshalling.Utf16)]
    private static partial int SetCurrentProcessExplicitAppUserModelID(string appId);
}
