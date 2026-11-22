using Microsoft.UI.Xaml;

namespace CreeperUX.Music;

public partial class App : Application
{
    public static MainWindow? MainWindow { get; private set; }

    public App()
    {
        InitializeComponent();
        // Logged and survived: losing the window (and the music playing) is worse than one action that did not finish
        UnhandledException += (_, e) => { Log.Write($"Unhandled: {e.Exception}"); e.Handled = true; };
    }

    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        MainWindow = new MainWindow();
        if (Testing.E2EChannel.Enabled)
        {
            Testing.E2EChannel.ShowInBackground(MainWindow);
            Testing.E2EChannel.Start(Microsoft.UI.Dispatching.DispatcherQueue.GetForCurrentThread());
        }
        else MainWindow.Activate();

        // a second start of the app arrives here (Program redirects it): bring this window forward
        var ui = Microsoft.UI.Dispatching.DispatcherQueue.GetForCurrentThread();
        Microsoft.Windows.AppLifecycle.AppInstance.GetCurrent().Activated += (_, _) => ui.TryEnqueue(() => { if (!Testing.E2EChannel.Enabled) MainWindow?.AppWindow.Show(); MainWindow?.Activate(); });
    }
}
