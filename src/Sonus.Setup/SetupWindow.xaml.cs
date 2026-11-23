using System.ComponentModel;
using System.IO;
using System.Windows;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Imaging;
using System.Windows.Threading;

namespace Sonus.Setup;

/// <summary>
/// The installer, as Lumen's: what Sonus is and where it goes, then the MSI's progress, then a finish page
/// (open it now), or why it didn't finish. Runs as the user, as the MSI is per-user.
/// </summary>
public partial class SetupWindow : Window
{
    private enum Stage { Welcome, License, Installing, Done, Failed }

    private static readonly IEasingFunction Ease = new CubicEase { EasingMode = EasingMode.EaseOut };

    private readonly string _version = MsiPackage.Version;
    private readonly string? _installed;
    private readonly bool _newerInstalled;
    private readonly DispatcherTimer? _runningCheck;
    private Stage _stage;
    private bool _appRunning;
    private bool _animate = true; // off while drawing the pages for review (--shots)

    public SetupWindow() : this(MsiPackage.InstalledVersion(), watchRunning: true) { }

    /// <param name="installed">The installed version, or null.</param>
    /// <param name="watchRunning">Keep checking whether the app runs (its files couldn't be replaced meanwhile).</param>
    internal SetupWindow(string? installed, bool watchRunning)
    {
        InitializeComponent();
        _installed = installed;
        _newerInstalled = installed is not null && Version.TryParse(installed, out var have) && Version.TryParse(_version, out var mine) && have > mine;
        VersionText.Text = _version;

        if (_newerInstalled)
        {
            WelcomeTitle.Text = $"Sonus {_version}";
            WelcomeNote.Text = $"这台电脑已经装了更新的 {installed}，不能换成旧版本。";
        }
        else if (installed is null)
        {
            WelcomeTitle.Text = $"安装 Sonus {_version}";
            WelcomeNote.Text = "为你自己的 Navidrome 打造的 Windows 音乐播放器。";
        }
        else if (installed == _version)
        {
            WelcomeTitle.Text = $"重新安装 Sonus {_version}";
            WelcomeNote.Text = "这台电脑已装了这个版本。重新安装会修复程序文件，登录和设置保留。";
        }
        else
        {
            WelcomeTitle.Text = $"升级到 Sonus {_version}";
            // 0.3 and earlier were named CreeperUX Music (the same MSI, by its UpgradeCode)
            bool former = Version.TryParse(installed, out var old) && old < new Version(0, 4);
            WelcomeNote.Text = former
                ? $"这台电脑已安装 CreeperUX Music {installed}，它现在改名叫 Sonus。升级会替换它，登录和设置会保留。"
                : $"这台电脑已安装 {installed}。登录和设置会保留。";
        }

        if (watchRunning)
        {
            _runningCheck = new DispatcherTimer { Interval = TimeSpan.FromSeconds(1) };
            _runningCheck.Tick += (_, _) => SetAppRunning(AppInstall.IsRunning());
            _runningCheck.Start();
            _appRunning = AppInstall.IsRunning();
        }
        KeyDown += Window_KeyDown;
        Show(Stage.Welcome);
    }

    private void Window_SourceInitialized(object? sender, EventArgs e) => Native.StyleWindow(this);

    private string ActionText => _installed is null ? "安装" : _installed == _version ? "重新安装" : "升级";

    private void Show(Stage stage)
    {
        _stage = stage;
        var page = stage switch
        {
            Stage.Welcome => WelcomePage,
            Stage.License => LicensePage,
            Stage.Installing => ProgressPage,
            Stage.Done => DonePage,
            _ => FailedPage,
        };
        foreach (var p in new FrameworkElement[] { WelcomePage, LicensePage, ProgressPage, DonePage, FailedPage })
            p.Visibility = p == page ? Visibility.Visible : Visibility.Collapsed;

        PrimaryButton.Content = stage switch
        {
            Stage.Welcome or Stage.License => ActionText,
            Stage.Installing => _installed is null ? "正在安装…" : "正在升级…",
            Stage.Done => "完成",
            _ => "关闭",
        };
        SecondaryButton.Content = stage == Stage.License ? "返回" : "取消";
        SecondaryButton.Visibility = stage is Stage.Welcome or Stage.License ? Visibility.Visible : Visibility.Collapsed;
        CloseButton.IsEnabled = stage != Stage.Installing;
        UpdatePrimaryEnabled();

        if (_animate)
        {
            SlideIn(page);
            if (stage == Stage.Done) Pop(DoneBadge);
        }
    }

    private void UpdatePrimaryEnabled()
    {
        bool waiting = _stage is Stage.Welcome or Stage.License && (_appRunning || _newerInstalled);
        PrimaryButton.IsEnabled = _stage != Stage.Installing && !waiting;
        RunningNotice.Visibility = _stage == Stage.Welcome && _appRunning ? Visibility.Visible : Visibility.Collapsed;
    }

    private void SetAppRunning(bool running)
    {
        if (running == _appRunning) return;
        _appRunning = running;
        UpdatePrimaryEnabled();
    }

    private async void Primary_Click(object sender, RoutedEventArgs e)
    {
        switch (_stage)
        {
            case Stage.Welcome or Stage.License:
                await InstallAsync();
                break;
            case Stage.Done:
                if (LaunchBox.IsChecked == true) AppInstall.Launch();
                Close();
                break;
            default:
                Close();
                break;
        }
    }

    private void Secondary_Click(object sender, RoutedEventArgs e)
    {
        if (_stage == Stage.License) Show(Stage.Welcome);
        else Close();
    }

    private async Task InstallAsync()
    {
        if (AppInstall.IsRunning()) // closed and opened again since the last check
        {
            SetAppRunning(true);
            return;
        }
        _runningCheck?.Stop();
        ProgressTitle.Text = _installed is null ? "正在安装" : "正在升级";
        Show(Stage.Installing);
        var result = await Task.Run(() => MsiPackage.Install((fraction, step) => Dispatcher.BeginInvoke(() => ShowProgress(fraction, step))));
        if (result.Succeeded)
        {
            ShowProgress(1, "已完成");
            ShowDone(restartNeeded: result.Code == 3010);
            await Task.Delay(300); // the bar reaches the end before the page changes
            Show(Stage.Done);
        }
        else ShowFailed(result.Error);
    }

    private void ShowDone(bool restartNeeded)
    {
        DoneTitle.Text = _installed is null ? "Sonus 已安装" : _installed == _version ? "Sonus 已重新安装" : $"已升级到 Sonus {_version}";
        if (restartNeeded)
        {
            // opening it now would start the old program with some new files: after the restart instead
            DoneNote.Text += "\n有文件要在重新启动后才能替换，请重新启动后再打开 Sonus。";
            LaunchBox.IsChecked = false;
            LaunchBox.IsEnabled = false;
        }
    }

    private void ShowFailed(string? error)
    {
        FailedNote.Text = $"{error}\n没有改动的部分保持原样，可以重新运行安装程序再试。";
        Show(Stage.Failed);
    }

    private void ShowProgress(double fraction, string? step)
    {
        if (step is not null) StepText.Text = step;
        PercentText.Text = $"{Math.Round(fraction * 100)}%";
        double width = Track.ActualWidth * fraction;
        if (_animate) Fill.BeginAnimation(WidthProperty, new DoubleAnimation(width, TimeSpan.FromMilliseconds(220)) { EasingFunction = Ease });
        else Fill.Width = width;
    }

    private void License_Click(object sender, RoutedEventArgs e) => Show(Stage.License);
    private void OpenLog_Click(object sender, RoutedEventArgs e) => AppInstall.Open(MsiPackage.LogPath);
    private void Close_Click(object sender, RoutedEventArgs e) => Close();

    private void Window_KeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.Escape && _stage != Stage.Installing) Close();
    }

    protected override void OnClosing(CancelEventArgs e)
    {
        e.Cancel = _stage == Stage.Installing; // Alt+F4 mid-install: the MSI finishes first
        if (!e.Cancel) _runningCheck?.Stop();
        base.OnClosing(e);
    }

    /// <summary>The app's page motion: fade in while rising 8 px.</summary>
    private static void SlideIn(FrameworkElement page)
    {
        var move = page.RenderTransform as TranslateTransform ?? (TranslateTransform)(page.RenderTransform = new TranslateTransform());
        page.BeginAnimation(OpacityProperty, new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(220)) { EasingFunction = Ease });
        move.BeginAnimation(TranslateTransform.YProperty, new DoubleAnimation(8, 0, TimeSpan.FromMilliseconds(280)) { EasingFunction = Ease });
    }

    private static void Pop(FrameworkElement badge)
    {
        var scale = badge.RenderTransform as ScaleTransform ?? (ScaleTransform)(badge.RenderTransform = new ScaleTransform());
        var ease = new BackEase { EasingMode = EasingMode.EaseOut, Amplitude = 0.4 };
        scale.BeginAnimation(ScaleTransform.ScaleXProperty, new DoubleAnimation(0.6, 1, TimeSpan.FromMilliseconds(320)) { EasingFunction = ease });
        scale.BeginAnimation(ScaleTransform.ScaleYProperty, new DoubleAnimation(0.6, 1, TimeSpan.FromMilliseconds(320)) { EasingFunction = ease });
    }

    // ---- Review images (--shots): every page drawn off screen, no window shown, nothing installed ----

    /// <summary>Draws each page as the user would see it, into PNGs in <paramref name="folder"/>.</summary>
    internal static void RenderShots(string folder)
    {
        Directory.CreateDirectory(folder);
        Shoot(folder, "1-welcome", installed: null, w => { });
        Shoot(folder, "1-welcome-upgrade", installed: "0.2.9", w => { });
        Shoot(folder, "1-welcome-running", installed: "0.2.9", w => w.SetAppRunning(true));
        Shoot(folder, "1-welcome-newer", installed: "9.9.9", w => { });
        Shoot(folder, "2-license", installed: null, w => w.Show(Stage.License));
        Shoot(folder, "3-progress", installed: "0.2.9", w =>
        {
            w.ProgressTitle.Text = "正在升级";
            w.Show(Stage.Installing);
            w.Layout();
            w.ShowProgress(0.62, "正在复制文件…");
        });
        Shoot(folder, "4-done", installed: null, w => { w.ShowDone(restartNeeded: false); w.Show(Stage.Done); });
        Shoot(folder, "4-done-restart", installed: "0.2.9", w => { w.ShowDone(restartNeeded: true); w.Show(Stage.Done); });
        Shoot(folder, "5-failed", installed: null, w => w.ShowFailed("另一个安装正在进行，请等它结束后再试。"));
    }

    private static void Shoot(string folder, string name, string? installed, Action<SetupWindow> setUp)
    {
        var window = new SetupWindow(installed, watchRunning: false) { _animate = false };
        window.Show(Stage.Welcome);
        setUp(window);
        var root = window.Layout();
        const double scale = 1.5;
        var bitmap = new RenderTargetBitmap((int)Math.Ceiling(root.ActualWidth * scale), (int)Math.Ceiling(root.ActualHeight * scale), 96 * scale, 96 * scale, PixelFormats.Pbgra32);
        bitmap.Render(root);
        var png = new PngBitmapEncoder();
        png.Frames.Add(BitmapFrame.Create(bitmap));
        using var file = File.Create(Path.Combine(folder, name + ".png"));
        png.Save(file);
        window.Close();
    }

    /// <summary>Lays the content out at the window's width without showing it.</summary>
    private FrameworkElement Layout()
    {
        Root.Measure(new Size(Width, double.PositiveInfinity));
        Root.Arrange(new Rect(new Point(0, 0), new Size(Width, Root.DesiredSize.Height)));
        Root.UpdateLayout();
        return Root;
    }
}
