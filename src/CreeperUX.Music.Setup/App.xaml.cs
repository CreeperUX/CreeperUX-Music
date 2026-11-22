using System.Windows;

namespace CreeperUX.Music.Setup;

/// <summary>
/// CreeperUX-Music-Setup.exe: the installer window. For tests, nothing shown and nothing installed, as Lumen's:
/// <c>--shots &lt;folder&gt;</c> draws every page into PNGs, <c>--extract-msi &lt;file&gt;</c> writes out the MSI inside
/// (exit code 1 if there is none).
/// </summary>
public partial class App : Application
{
    private void App_Startup(object sender, StartupEventArgs e)
    {
        int shots = Array.IndexOf(e.Args, "--shots");
        if (shots >= 0 && shots + 1 < e.Args.Length)
        {
            ShutdownMode = ShutdownMode.OnExplicitShutdown;
            SetupWindow.RenderShots(e.Args[shots + 1]);
            Shutdown();
            return;
        }
        int extract = Array.IndexOf(e.Args, "--extract-msi");
        if (extract >= 0 && extract + 1 < e.Args.Length)
        {
            ShutdownMode = ShutdownMode.OnExplicitShutdown;
            Shutdown(MsiPackage.Extract(e.Args[extract + 1]) is null ? 0 : 1);
            return;
        }
        MainWindow = new SetupWindow();
        MainWindow.Show();
    }
}
