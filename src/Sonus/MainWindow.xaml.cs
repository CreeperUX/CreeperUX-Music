using Sonus.Controls;
using Sonus.Core;
using Sonus.Pages;
using Sonus.Services;
using Sonus.Updates;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Windows.System;

namespace Sonus;

/// <summary>
/// The window: the top bar in the title bar, the library on the left, the page in the middle, Now playing / Queue on the
/// right, the playback bar along the bottom; or the sign-in page while there is no sign-in. Pages are addressed by routes
/// ("album:al3") and kept in a back / forward history.
/// </summary>
public sealed partial class MainWindow : Window, IShell
{
    private readonly AppSettings _settings = AppSettings.Load();
    private readonly List<string> _back = [], _forward = [];
    private MusicService? _music;
    private LibraryPane? _library;
    private NowPlayingPane? _panel;
    private PlaybackBar? _bar;
    private View? _view;
    private string _route = "home";
    private TextBox? _search;
    private Border? _searchPill;
    private UIElement? _browseSeparator;
    private Button? _connection;
    private Microsoft.UI.Xaml.Controls.Primitives.ToggleButton? _panelToggle;
    private DispatcherTimer? _searchTimer;

    public MainWindow()
    {
        InitializeComponent();
        ExtendsContentIntoTitleBar = true;
        SetTitleBar(TopBar);
        AppWindow.TitleBar.PreferredHeightOption = TitleBarHeightOption.Tall;
        // the window buttons on the app's colours: no plate of their own, the raised colour under the pointer
        var buttons = AppWindow.TitleBar;
        buttons.ButtonBackgroundColor = buttons.ButtonInactiveBackgroundColor = Microsoft.UI.Colors.Transparent;
        buttons.ButtonForegroundColor = Ui.ColorOf("TextColor");
        buttons.ButtonInactiveForegroundColor = Ui.ColorOf("QuietColor");
        buttons.ButtonHoverBackgroundColor = Ui.ColorOf("RaisedColor");
        buttons.ButtonHoverForegroundColor = Ui.ColorOf("TextColor");
        buttons.ButtonPressedBackgroundColor = Ui.ColorOf("RaisedHiColor");
        buttons.ButtonPressedForegroundColor = Ui.ColorOf("TextColor");
        AppWindow.SetIcon(Path.Combine(AppContext.BaseDirectory, "Assets", "AppIcon.ico"));
        SizeAndCenter(1440, 900);
        // below this the top bar cannot hold Home and the search field next to the window buttons
        if (AppWindow.Presenter is OverlappedPresenter presenter)
        {
            double scale = GetDpiForWindow(WinRT.Interop.WindowNative.GetWindowHandle(this)) / 96.0;
            presenter.PreferredMinimumWidth = (int)(760 * scale);
            presenter.PreferredMinimumHeight = (int)(560 * scale);
        }
        Activated += (_, e) =>
        {
            IsActive = e.WindowActivationState != WindowActivationState.Deactivated;
            if (IsActive && _music is { } m) { m.OnActivated(); _ = OfferContinue(atStart: false); }
        };
        AppWindow.Closing += async (_, e) =>
        {
            if (_music is null || _closing) return;
            e.Cancel = true; _closing = true;
            await _music.SaveQueueNowAsync(); // the position, for another device
            _connect?.Dispose();
            _session?.Dispose();
            _music.Dispose();
            Close();
        };
        RootGrid.SizeChanged += (_, _) => Fit();
        foreach (var part in new FrameworkElement[] { TopBar, TopCenter, TopEnd, Brand }) part.SizeChanged += (_, _) => FitTopBar();
        // after every layout pass: the parts may have moved without changing size (a new margin, a maximized window)
        TopBar.LayoutUpdated += (_, _) => UpdatePassthrough();
        RootGrid.Loaded += (_, _) => { RootGrid.XamlRoot.Changed += (_, _) => ApplyZoom(); ApplyZoom(); };
        AppWindow.Changed += (_, e) =>
        {
            if (!e.DidSizeChange && !e.DidPresenterChange) return;
            FitTopBar();
            // the window buttons' room (RightInset) can settle after the change itself (maximizing): fit again then
            DispatcherQueue.TryEnqueue(Microsoft.UI.Dispatching.DispatcherQueuePriority.Low, FitTopBar);
        };
        RootGrid.AddHandler(UIElement.PointerPressedEvent, new PointerEventHandler(OnPointerPressed), true);
        RootGrid.AddHandler(UIElement.KeyDownEvent, new KeyEventHandler(OnKeyDown), true);
        Updates = new UpdateService(_settings);
        Updates.AvailableChanged += SyncUpdatePill;
        _ = Start();
        Updates.CheckOnStartup();
    }

    private bool _closing;

    /// <summary>Newer versions on GitHub (设置 › 更新, the pill in the top bar).</summary>
    public UpdateService Updates { get; }

    /// <summary>Closes the app as the window's close button does (the queue saved for another device first): the
    /// update's installer replaces its files.</summary>
    public async Task CloseAppAsync()
    {
        if (_closing) return;
        _closing = true;
        if (_music is { } m) { await m.SaveQueueNowAsync(); _connect?.Dispose(); _session?.Dispose(); m.Dispose(); }
        Close();
    }

    private ConnectService? _connect;
    private SessionService? _session;

    /// <summary>Sonus Connect version 1 (the user's other devices), while signed in.</summary>
    public ConnectService? Devices => _connect;

    /// <summary>Sonus Connect version 2 (the user's one playback session), while signed in to a server that offers it.</summary>
    public SessionService? Session => _session;

    /// <summary>The window is the active one; moving keyboard focus while it is not could take the foreground from the user.</summary>
    public bool IsActive { get; private set; }

    public MusicService? Music => _music;
    public string Route => _route;
    public View? CurrentView => _view;
    public NowPlayingPane? Panel => _panel;

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern uint GetDpiForWindow(IntPtr hwnd);

    private void SizeAndCenter(int width, int height)
    {
        double scale = GetDpiForWindow(WinRT.Interop.WindowNative.GetWindowHandle(this)) / 96.0;
        var area = DisplayArea.GetFromWindowId(AppWindow.Id, DisplayAreaFallback.Primary).WorkArea;
        int w = Math.Min((int)(width * scale), (int)(area.Width * 0.94)), h = Math.Min((int)(height * scale), (int)(area.Height * 0.94));
        AppWindow.MoveAndResize(new Windows.Graphics.RectInt32(area.X + (area.Width - w) / 2, area.Y + (area.Height - h) / 2, w, h));
    }

    // ---------------------------------------------------------------- signing in and starting
    /// <summary>This computer as the server and the user's other devices know it. A test instance may be given a name of its
    /// own (SONUS_DEVICE_NAME), so two on one computer are two devices.</summary>
    private static string DeviceName => AppPaths.IsTestInstance && Environment.GetEnvironmentVariable("SONUS_DEVICE_NAME") is { Length: > 0 } name ? name : Environment.MachineName;
    private static string ClientName => Core.AppName.Client($"{(AppPaths.IsTestInstance ? "测试 " : "")}{DeviceName}");

    private async Task Start()
    {
        if (Login.FromJson(Interop.Credentials.Read()) is { } login) await Connect(login);
        else ShowLogin();
    }

    private void ShowLogin(string? error = null)
    {
        Panels.Visibility = Visibility.Collapsed; BarHost.Visibility = Visibility.Collapsed;
        TopCenter.Children.Clear(); TopEnd.Children.Clear(); _updatePill = null;
        var login = new LoginView(_settings.LastServer, Program.DemoServer, error, IsActive);
        login.SignedIn += async l => { Interop.Credentials.Write(l.ToJson(), l.User); _settings.LastServer = l.Server; _settings.Save(); await Connect(l); };
        login.SignIn = (server, user, password) => SubsonicClient.SignInAsync(server, user, password, ClientName);
        // the browser sign-in: the key is named after this computer on the server; a test instance only logs the page
        login.DeviceName = (AppPaths.IsTestInstance ? "测试 " : "") + DeviceName;
        login.OpenBrowser = async url =>
        {
            Log.Write($"[browser sign-in] {url}");
            if (!AppPaths.IsTestInstance) await Launcher.LaunchUriAsync(url);
        };
        LoginHost.Child = login;
        LoginHost.Visibility = Visibility.Visible;
        Title = "登录 · Sonus";
    }

    private async Task Connect(Login login)
    {
        LoginHost.Visibility = Visibility.Collapsed;
        Panels.Visibility = Visibility.Visible;
        MainHost.Child = Loading("正在载入媒体库…");
        var music = new MusicService(new SubsonicClient(login, ClientName), _settings, DispatcherQueue);
        try { await music.StartAsync(); }
        catch (SubsonicException ex) when (ex.IsAuthentication)
        {
            music.Dispose();
            Interop.Credentials.Delete();
            ShowLogin(ex.Message);
            return;
        }
        catch (Exception ex) when (ex is ServerUnreachableException or SubsonicException or System.Text.Json.JsonException or HttpRequestException)
        {
            music.Dispose(); // 重试 starts a new one
            MainHost.Child = Offline(ex.Message, () => _ = Connect(login));
            return;
        }
        _music = music;
        var clock = System.Diagnostics.Stopwatch.StartNew();
        Build(music);
        Navigate("home");
        Log.Write($"[start] {music.Server.Version}: {music.Library.Tracks.Count} songs, {music.Library.Albums.Count} albums, {music.Playlists.Count - 2} playlists; window built in {clock.ElapsedMilliseconds} ms");
        Ready = true;
        await OfferContinue(atStart: true);
    }

    /// <summary>Signed in and the library loaded (tests wait for it).</summary>
    public bool Ready { get; private set; }

    private static FrameworkElement Loading(string text)
    {
        var ring = new ProgressRing { IsActive = true, Width = 28, Height = 28 };
        var p = Ui.Row(12, ring, Ui.Text(text, "MutedTextStyle"));
        p.HorizontalAlignment = HorizontalAlignment.Center; p.VerticalAlignment = VerticalAlignment.Center;
        return p;
    }

    private static FrameworkElement Offline(string message, Action retry)
    {
        var b = new Button { Content = "重试", Style = Ui.Style("PillButtonStyle") };
        b.Click += (_, _) => retry();
        var p = Ui.Column(12, Ui.Text("无法连接到音乐服务器", "SectionTitleStyle"), Ui.Text(message, "MutedTextStyle"), b);
        p.HorizontalAlignment = HorizontalAlignment.Center; p.VerticalAlignment = VerticalAlignment.Center;
        return p;
    }

    private async Task SignOut()
    {
        // a key from the browser sign-in is given back: it stops working on the server at once (best effort; the user
        // can also revoke it on the server's web page)
        if (_music?.Client.Login is { IsApiKey: true } keyed) _ = DeviceLogin.RevokeAsync(keyed);
        _connect?.Dispose(); _connect = null;
        _session?.Dispose(); _session = null;
        _music?.Dispose();
        _music = null; Ready = false;
        _view?.Leave(); _view = null;
        Interop.Credentials.Delete();
        ToastHost.Children.Clear(); // their actions ("接着播放") belong to the session just closed
        LibraryHost.Child = null; PanelHost.Child = null; BarHost.Child = null; MainHost.Child = null;
        _back.Clear(); _forward.Clear();
        ShowLogin();
        await Task.CompletedTask;
    }

    // ---------------------------------------------------------------- the shell
    private void Build(MusicService music)
    {
        _library = new LibraryPane(music, this, _settings);
        _library.RailChanged += (rail, byUser) =>
        {
            LibraryColumn.Width = new GridLength(rail ? 80 : 300); // 80: a 48 px cover with 16 px either side
            if (byUser) { _settings.LibraryOpen = !rail; _settings.Save(); }
        };
        LibraryHost.Child = _library;
        if (!_settings.LibraryOpen) _library.SetRail(true, byUser: false);
        _panel = new NowPlayingPane(music, this);
        _panel.CloseRequested += () => SetPanel(false);
        PanelHost.Child = _panel;
        _connect?.Dispose();
        _connect = new ConnectService(music, DispatcherQueue, DeviceName); // version 1, where the server offers only that
        _session?.Dispose();
        _session = Core.Connect.SessionClient.Supported(music.Client) ? new SessionService(music, DispatcherQueue, _settings, DeviceName) : null;
        _bar = new PlaybackBar(music, _connect, _session, this);
        _bar.QueueToggled += open => { SetPanel(true); _panel.Show(open ? "queue" : "now"); };
        BarHost.Child = _bar;
        BarHost.Visibility = Visibility.Visible;
        SetPanel(_settings.PanelOpen);

        // the top bar
        TopCenter.Children.Clear(); TopEnd.Children.Clear(); _updatePill = null;
        // foobar2k's top bar: a raised round Home button (48) that grows under the pointer, and the search pill (48): a search
        // icon, the field (no box, no underline), a hairline, the Browse button
        var home = Ui.IconButton(Glyphs.Home, "首页", (_, _) => Navigate("home"), 48, 20);
        home.Background = Ui.Brush("RaisedBrush");
        home.Resources["ButtonBackgroundPointerOver"] = Ui.Brush("RaisedBrush");
        home.Resources["ButtonBackgroundPressed"] = Ui.Brush("RaisedBrush");
        home.Resources["ButtonForegroundPointerOver"] = Ui.Brush("TextPrimaryBrush");
        home.VerticalAlignment = VerticalAlignment.Center;
        Motion.Press(home);
        _home = home;
        _search = new TextBox { PlaceholderText = "想听什么？", FontSize = 14, BorderThickness = new Thickness(0), Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent), Padding = new Thickness(10, 6, 4, 6), VerticalAlignment = VerticalAlignment.Center };
        Plain(_search);
        AutomationProperties.SetName(_search, "搜索");
        _search.TextChanged += (_, _) =>
        {
            _searchTimer ??= new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(250) };
            _searchTimer.Stop();
            _searchTimer.Tick -= SearchTick; _searchTimer.Tick += SearchTick;
            _searchTimer.Start();
        };
        _search.GotFocus += (_, _) => { if (!_route.StartsWith("search:", StringComparison.Ordinal)) Navigate("search:" + _search.Text.Trim()); };
        var browse = Ui.IconButton(Glyphs.Browse, "浏览全部", (_, _) => Navigate("search:"), 40, 18);
        browse.Resources["ButtonForegroundPointerOver"] = Ui.Brush("TextPrimaryBrush");
        browse.VerticalAlignment = VerticalAlignment.Center;
        var glass = Ui.Icon(Glyphs.Search, 18);
        glass.VerticalAlignment = VerticalAlignment.Center; glass.Margin = new Thickness(12, 0, 0, 0); glass.IsHitTestVisible = false;
        var separator = new Microsoft.UI.Xaml.Shapes.Rectangle { Width = 1, Height = 24, Fill = Ui.Brush("LineBrush"), VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(4, 0, 2, 0) };
        var pillRow = new Grid { ColumnSpacing = 0 };
        foreach (var width in new[] { GridLength.Auto, new GridLength(1, GridUnitType.Star), GridLength.Auto, GridLength.Auto })
            pillRow.ColumnDefinitions.Add(new ColumnDefinition { Width = width });
        pillRow.Children.Add(glass);
        Grid.SetColumn(_search, 1); pillRow.Children.Add(_search);
        Grid.SetColumn(separator, 2); pillRow.Children.Add(separator);
        Grid.SetColumn(browse, 3); pillRow.Children.Add(browse);
        // the pill: raised, lighter with a hairline under the pointer, a ring in the text colour while typing (foobar2k's)
        var pill = new Border
        {
            Height = 48, CornerRadius = new CornerRadius(24), Background = Ui.Brush("RaisedBrush"), BorderThickness = new Thickness(2),
            BorderBrush = new SolidColorBrush(Microsoft.UI.Colors.Transparent), Padding = new Thickness(0, 0, 2, 0), Child = pillRow, VerticalAlignment = VerticalAlignment.Center,
            BackgroundTransition = new BrushTransition { Duration = Motion.Control },
        };
        bool over = false;
        void Ring()
        {
            bool typing = _search.FocusState != FocusState.Unfocused;
            pill.Background = over && !typing ? Ui.Brush("RaisedHiBrush") : Ui.Brush("RaisedBrush");
            pill.BorderBrush = typing ? Ui.Brush("TextPrimaryBrush") : over ? Ui.Brush("LineBrush") : new SolidColorBrush(Microsoft.UI.Colors.Transparent);
        }
        pill.PointerEntered += (_, _) => { over = true; Ring(); };
        pill.PointerExited += (_, _) => { over = false; Ring(); };
        _search.GotFocus += (_, _) => Ring();
        _search.LostFocus += (_, _) => Ring();
        _searchPill = pill;
        TopCenter.Children.Add(home); TopCenter.Children.Add(pill);
        _browse = browse; _browseSeparator = separator;

        var dot = new Microsoft.UI.Xaml.Shapes.Ellipse { Width = 8, Height = 8, Fill = Ui.Brush("GoodBrush"), VerticalAlignment = VerticalAlignment.Center };
        // the connection: a quiet pill (muted text, the hover colour under the pointer), as foobar2k's
        var label = Ui.Text(music.Server.Name, size: 12, foreground: Ui.Brush("TextSecondaryBrush"));
        _connection = new Button { Content = Ui.Row(8, dot, label), Style = Ui.Style("PillButtonStyle"), Tag = (dot, label), Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent), Height = 36, CornerRadius = new CornerRadius(18), Padding = new Thickness(14, 0, 14, 0), VerticalAlignment = VerticalAlignment.Center };
        _connection.Resources["ButtonBackgroundPointerOver"] = Ui.Brush("HoverBrush");
        _connection.Resources["ButtonBackgroundPressed"] = Ui.Brush("HoverBrush");
        _connection.PointerEntered += (_, _) => label.Foreground = Ui.Brush("TextPrimaryBrush");
        _connection.PointerExited += (_, _) => label.Foreground = Ui.Brush("TextSecondaryBrush");
        _connection.Click += async (_, _) =>
        {
            if (!music.IsOnline) { await music.GoOnlineAsync(); return; }
            ShowToast(new($"已连接 · {music.Server.Version} · {new Uri(music.Client.Login.Server).Authority}"));
        };
        SyncConnection();
        music.ConnectionChanged += () =>
        {
            SyncConnection();
            ShowToast(music.IsOnline ? new("已重新连接服务器") : new("无法连接到音乐服务器。检查网络，然后重新连接。", true, "重新连接", () => _ = music.GoOnlineAsync()));
        };
        var settings = Ui.IconButton(Glyphs.Settings, "设置", (_, _) => Navigate("settings"), 36, 16);
        settings.Resources["ButtonForegroundPointerOver"] = Ui.Brush("TextPrimaryBrush");
        _panelToggle = Ui.IconToggle(Glyphs.Panel, "显示或隐藏正在播放", 36);
        _panelToggle.IsChecked = _settings.PanelOpen;
        _panelToggle.Click += (_, _) => { SetPanel(_panelToggle.IsChecked == true); if (_panelToggle.IsChecked == true) _panel?.Show("now"); };
        TopEnd.Children.Add(_connection); TopEnd.Children.Add(settings); TopEnd.Children.Add(_panelToggle);
        SyncUpdatePill();

        music.Toast += ShowToast;
        music.PlayerChanged += () => { if (_route == "lyrics") _bar?.SetPanelMode(_panel?.Mode == "queue" && PanelColumn.Width.Value > 0, true); };
        Fit();
        DispatcherQueue.TryEnqueue(Microsoft.UI.Dispatching.DispatcherQueuePriority.Low, FitTopBar); // once the new parts are measured
    }

    private void SearchTick(object? sender, object e)
    {
        _searchTimer?.Stop();
        if (_search is null) return;
        string route = "search:" + _search.Text.Trim();
        if (_route.StartsWith("search:", StringComparison.Ordinal)) Navigate(route, replace: true);
        else Navigate(route);
    }

    private Button? _updatePill;
    private string? _updateToasted;

    /// <summary>A newer version: a quiet pill before the connection, in the accent colour, opening the update dialog
    /// (and, the first time, a toast unless 设置 is showing it).</summary>
    private void SyncUpdatePill()
    {
        if (_music is null) return; // signed out: the top bar has no end part
        if (Updates.Available is not { } release)
        {
            if (_updatePill is not null) { TopEnd.Children.Remove(_updatePill); _updatePill = null; }
            return;
        }
        if (_updatePill is null)
        {
            var icon = Ui.Icon(Glyphs.Download, 14, Ui.Brush("AccentTextBrush"));
            var text = Ui.Text("", size: 12, foreground: Ui.Brush("AccentTextBrush"));
            _updatePill = new Button
            {
                Content = Ui.Row(8, icon, text), Tag = text, Style = Ui.Style("PillButtonStyle"), Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent),
                Height = 36, CornerRadius = new CornerRadius(18), Padding = new Thickness(12, 0, 14, 0), VerticalAlignment = VerticalAlignment.Center,
            };
            _updatePill.Resources["ButtonBackgroundPointerOver"] = Ui.Brush("HoverBrush");
            _updatePill.Resources["ButtonBackgroundPressed"] = Ui.Brush("HoverBrush");
            _updatePill.Click += (_, _) => ShowUpdate();
            TopEnd.Children.Insert(0, _updatePill);
            Motion.Enter(_updatePill, rise: 0, slide: 8);
        }
        ((TextBlock)_updatePill.Tag).Text = $"新版本 {release.DisplayVersion}";
        string name = $"更新到 Sonus {release.DisplayVersion}";
        AutomationProperties.SetName(_updatePill, name);
        ToolTipService.SetToolTip(_updatePill, name);
        if (_updateToasted != release.Tag && _route != "settings")
        {
            _updateToasted = release.Tag;
            ShowToast(new($"Sonus {release.DisplayVersion} 可以更新了", false, "查看", ShowUpdate));
        }
    }

    private void ShowUpdate()
    {
        if (Updates.Available is { } release) _ = UpdateDialog.ShowAsync(Content.XamlRoot, Updates, release);
    }

    private void SyncConnection()
    {
        if (_connection?.Tag is not ValueTuple<Microsoft.UI.Xaml.Shapes.Ellipse, TextBlock> parts || _music is not { } m) return;
        var (dot, label) = parts;
        dot.Fill = m.IsOnline ? Ui.Brush("GoodBrush") : Ui.Brush("BadBrush");
        label.Text = m.IsOnline ? m.Server.Name : "未连接到服务器";
        string name = m.IsOnline ? $"已连接 · {m.Server.Version}" : "未连接到服务器，点击重新连接";
        AutomationProperties.SetName(_connection, name);
        ToolTipService.SetToolTip(_connection, name);
    }

    private void SetPanel(bool open, bool byUser = true)
    {
        if (open && PanelColumn.Width.Value == 0) Motion.Enter(PanelHost, rise: 0, slide: 16); // it comes in from the side
        PanelColumn.Width = new GridLength(open ? 340 : 0);
        PanelHost.Visibility = open ? Visibility.Visible : Visibility.Collapsed;
        if (_panelToggle is not null) _panelToggle.IsChecked = open;
        if (byUser) { _settings.PanelOpen = open; _settings.Save(); }
        _bar?.SetPanelMode(open && _panel?.Mode == "queue", _route == "lyrics");
    }

    private Button? _home;

    /// <summary>A text field without its own box and underline (the search pill draws them).</summary>
    private static void Plain(TextBox box)
    {
        var clear = new SolidColorBrush(Microsoft.UI.Colors.Transparent);
        foreach (var key in new[] { "TextControlBackground", "TextControlBackgroundPointerOver", "TextControlBackgroundFocused", "TextControlBorderBrush", "TextControlBorderBrushPointerOver", "TextControlBorderBrushFocused" })
            box.Resources[key] = clear;
        box.Resources["TextControlBorderThemeThicknessFocused"] = new Thickness(0);
        foreach (var key in new[] { "TextControlPlaceholderForeground", "TextControlPlaceholderForegroundPointerOver", "TextControlPlaceholderForegroundFocused" })
            box.Resources[key] = Ui.Brush("TextSecondaryBrush");
    }

    /// <summary>
    /// The top bar's geometry: room for the window buttons at the end; and the search pill as wide as it can be while Home
    /// and the pill stay on the window's middle line clear of both ends (foobar2k's middle column: at most 544 px). The
    /// parts the pointer must reach follow once they are laid out (UpdatePassthrough).
    /// </summary>
    private void FitTopBar()
    {
        if (TopBar.XamlRoot is not { } root) return;
        double scale = root.RasterizationScale, width = TopBar.ActualWidth;
        double caption = AppWindow.TitleBar.RightInset / (scale * Zoom); // in the zoomed layout's units
        var end = new Thickness(0, 0, caption + 12, 0);
        if (TopEnd.Margin != end) TopEnd.Margin = end;
        if (_searchPill is not null && width > 0)
        {
            double left = Brand.ActualWidth + Brand.Margin.Left + Brand.Margin.Right;
            double right = TopEnd.ActualWidth + end.Right + 16;
            double pill = Math.Clamp(width - 2 * Math.Max(left, right) - 56, 120, 488);
            if (double.IsNaN(_searchPill.Width) || Math.Abs(_searchPill.Width - pill) > 0.5) _searchPill.Width = pill;
        }
        UpdatePassthrough();
    }

    private Windows.Graphics.RectInt32[] _passthrough = [];

    /// <summary>
    /// The parts of the top bar the pointer must reach (Home, the pill, the end's buttons), taken out of the window's drag
    /// area where they are now laid out, in the window's pixels. Measured after layout, on every pass, and set only when
    /// they changed: measured before the layout followed a new margin, they stayed where the end's buttons had been and
    /// covered the window buttons, which then took no clicks. Never over the window buttons whatever happens.
    /// </summary>
    private void UpdatePassthrough()
    {
        if (TopBar.XamlRoot is not { } root || _closing) return;
        double scale = root.RasterizationScale;
        int buttons = (int)Math.Floor(root.Size.Width * scale) - AppWindow.TitleBar.RightInset; // where the window buttons begin
        var parts = new List<Windows.Graphics.RectInt32>(2);
        foreach (var part in new FrameworkElement[] { TopCenter, TopEnd })
        {
            if (part.ActualWidth <= 0 || part.Visibility != Visibility.Visible) continue;
            var r = part.TransformToVisual(null).TransformBounds(new Windows.Foundation.Rect(0, 0, part.ActualWidth, part.ActualHeight));
            int x = (int)Math.Floor(r.X * scale), y = (int)Math.Floor(r.Y * scale);
            int right = Math.Min((int)Math.Ceiling(r.Right * scale), buttons);
            if (right > x) parts.Add(new Windows.Graphics.RectInt32(x, y, right - x, (int)Math.Ceiling(r.Height * scale)));
        }
        if (parts.SequenceEqual(_passthrough)) return;
        _passthrough = [.. parts];
        Microsoft.UI.Input.InputNonClientPointerSource.GetForWindowId(AppWindow.Id).SetRegionRects(Microsoft.UI.Input.NonClientRegionKind.Passthrough, _passthrough);
    }

    /// <summary>For tests: the window's pixels where the window buttons begin, the clickable parts set in the top bar, and
    /// where the end's buttons are laid out now ("buttons 2394; passthrough 797,28,1088,72 1995,28,374,72; end 1995,28,374,72").</summary>
    public string TitleBarState()
    {
        if (TopBar.XamlRoot is not { } root) return "not laid out";
        double scale = root.RasterizationScale;
        var r = TopEnd.TransformToVisual(null).TransformBounds(new Windows.Foundation.Rect(0, 0, TopEnd.ActualWidth, TopEnd.ActualHeight));
        string Rect(int x, int y, int w, int h) => FormattableString.Invariant($"{x},{y},{w},{h}");
        return $"buttons {(int)Math.Floor(root.Size.Width * scale) - AppWindow.TitleBar.RightInset}; passthrough {string.Join(' ', _passthrough.Select(p => Rect(p.X, p.Y, p.Width, p.Height)))}; " +
               $"end {Rect((int)Math.Floor(r.X * scale), (int)Math.Floor(r.Y * scale), (int)Math.Ceiling(r.Right * scale) - (int)Math.Floor(r.X * scale), (int)Math.Ceiling(r.Height * scale))}";
    }

    public double Zoom => Math.Clamp(_settings.Zoom, 0.5, 2);

    /// <summary>Zooms the whole window (1 = 100 %), as a browser does: the layout is made for the window's size divided by
    /// the zoom and drawn scaled by it, the text rasterized at the final size so it stays sharp. Saved.</summary>
    public void SetZoom(double zoom)
    {
        _settings.Zoom = Math.Round(Math.Clamp(zoom, 0.8, 1.25), 2);
        _settings.Save();
        ApplyZoom();
        ShowToast(new($"界面缩放 {_settings.Zoom * 100:0}%"));
    }

    private void ApplyZoom()
    {
        if (RootGrid.XamlRoot is not { } root) return;
        double z = Zoom, scale = root.RasterizationScale;
        Covers.Zoom = z;
        RootGrid.HorizontalAlignment = HorizontalAlignment.Left;
        RootGrid.VerticalAlignment = VerticalAlignment.Top;
        RootGrid.Width = root.Size.Width / z;
        RootGrid.Height = root.Size.Height / z;
        RootGrid.RenderTransform = Math.Abs(z - 1) < 0.001 ? null : new ScaleTransform { ScaleX = z, ScaleY = z };
        RootGrid.RasterizationScale = scale * z;
        // the narrowest window still has room for the layout made at 100 %
        if (AppWindow.Presenter is OverlappedPresenter presenter)
        {
            presenter.PreferredMinimumWidth = (int)(760 * scale * Math.Max(1, z));
            presenter.PreferredMinimumHeight = (int)(560 * scale * Math.Max(1, z));
        }
        FitTopBar();
    }

    private void StepZoom(int step)
    {
        var zooms = Pages.SettingsPage.Zooms;
        int at = Array.FindIndex(zooms, z => Math.Abs(z - Zoom) < 0.001);
        if (at < 0) at = Array.IndexOf(zooms, 1.0);
        int next = step == 0 ? Array.IndexOf(zooms, 1.0) : Math.Clamp(at + step, 0, zooms.Length - 1);
        if (next != at || step == 0) SetZoom(zooms[next]);
    }

    private bool _narrowPanel, _narrowLibrary;
    private Button? _browse;

    /// <summary>Narrow windows: the panel closes below 1100 px, the library becomes a rail below 860 px, the brand shrinks to
    /// its icon and the search field to what is left. Widening puts back what the person chose; none of it is saved.</summary>
    private void Fit()
    {
        double w = RootGrid.ActualWidth;
        BrandName.Visibility = w < 1000 ? Visibility.Collapsed : Visibility.Visible;
        if (_browse is not null) _browse.Visibility = _browseSeparator!.Visibility = w < 1000 ? Visibility.Collapsed : Visibility.Visible; // "浏览全部" is the empty search page too
        FitTopBar();
        if (_connection?.Tag is ValueTuple<Microsoft.UI.Xaml.Shapes.Ellipse, TextBlock> parts) parts.Item2.Visibility = w < 760 ? Visibility.Collapsed : Visibility.Visible;
        if (_music is null) return;
        if (w < 1100 && PanelColumn.Width.Value > 0) { _narrowPanel = true; SetPanel(false, byUser: false); }
        else if (w >= 1100 && _narrowPanel) { _narrowPanel = false; SetPanel(_settings.PanelOpen, byUser: false); }
        if (w < 860 && _library is { IsRail: false }) { _narrowLibrary = true; _library.SetRail(true, byUser: false); }
        else if (w >= 860 && _narrowLibrary && _library is not null) { _narrowLibrary = false; _library.SetRail(!_settings.LibraryOpen, byUser: false); }
    }

    // ---------------------------------------------------------------- navigation
    public void Navigate(string route) => Navigate(route, replace: false);

    public void Navigate(string route, bool replace)
    {
        if (_music is not { } music) return;
        if (route == "back") { GoBack(); return; }
        if (!replace && route != _route) { _back.Add(_route); _forward.Clear(); }
        Show(route, music);
    }

    public void GoBack()
    {
        if (_back.Count == 0 || _music is null) return;
        _forward.Add(_route);
        var r = _back[^1]; _back.RemoveAt(_back.Count - 1);
        Show(r, _music);
    }

    public void GoForward()
    {
        if (_forward.Count == 0 || _music is null) return;
        _back.Add(_route);
        var r = _forward[^1]; _forward.RemoveAt(_forward.Count - 1);
        Show(r, _music);
    }

    private void Show(string route, MusicService music)
    {
        var clock = System.Diagnostics.Stopwatch.StartNew();
        _view?.Leave();
        _route = route;
        int colon = route.IndexOf(':');
        string kind = colon < 0 ? route : route[..colon], arg = colon < 0 ? "" : route[(colon + 1)..];
        View view = kind switch
        {
            "album" => new AlbumPage(music, this, arg),
            "playlist" => new PlaylistPage(music, this, arg),
            "artist" => new ArtistPage(music, this, arg),
            "search" => new SearchPage(music, this, arg),
            "genre" => new CollectionPage(music, this, "genre", arg),
            "shelf" => new CollectionPage(music, this, "shelf", arg),
            "lyrics" => new LyricsPage(music, this),
            "settings" => new SettingsPage(music, this, SignOut),
            _ => new HomePage(music, this),
        };
        _view = view;
        MainHost.Child = view;
        Motion.Enter(view, rise: 6, move: Motion.Push); // the page fades in; its rows and cards rise in after it
        Title = view.Title.Length > 0 ? $"{view.Title} · Sonus" : "Sonus";
        if (_search is not null && kind != "search" && _search.FocusState == FocusState.Unfocused) _search.Text = "";
        _bar?.SetPanelMode(_panel?.Mode == "queue" && PanelColumn.Width.Value > 0, kind == "lyrics");
        Navigated?.Invoke(route);
        if (clock.ElapsedMilliseconds >= 150) Log.Write($"[page] {route} built in {clock.ElapsedMilliseconds} ms");
    }

    public event Action<string>? Navigated;

    private void OnPointerPressed(object sender, PointerRoutedEventArgs e)
    {
        var props = e.GetCurrentPoint(RootGrid).Properties;
        if (props.IsXButton1Pressed) { GoBack(); e.Handled = true; }
        else if (props.IsXButton2Pressed) { GoForward(); e.Handled = true; }
    }

    /// <summary>Space plays or pauses (not while typing); Ctrl + ← → change songs, Ctrl + ↑ ↓ the volume, Ctrl + K or / search,
    /// Alt + ← → navigate, Alt + Shift + B likes the playing song.</summary>
    private void OnKeyDown(object sender, KeyRoutedEventArgs e)
    {
        if (_music is not { } m) return;
        var focused = FocusManager.GetFocusedElement(Content.XamlRoot);
        bool typing = focused is TextBox or PasswordBox or AutoSuggestBox;
        var mods = Microsoft.UI.Input.InputKeyboardSource.GetKeyStateForCurrentThread(VirtualKey.Control).HasFlag(Windows.UI.Core.CoreVirtualKeyStates.Down);
        var alt = Microsoft.UI.Input.InputKeyboardSource.GetKeyStateForCurrentThread(VirtualKey.Menu).HasFlag(Windows.UI.Core.CoreVirtualKeyStates.Down);
        var shift = Microsoft.UI.Input.InputKeyboardSource.GetKeyStateForCurrentThread(VirtualKey.Shift).HasFlag(Windows.UI.Core.CoreVirtualKeyStates.Down);
        // while the bar controls another device (Sonus Connect), the transport keys do too
        var remote = _connect?.Target;
        bool Remote(string action, double? level = null)
        {
            if (remote is null) return false;
            _ = _connect!.SendAsync(new Core.Connect.ConnectCommand(action) { Level = level });
            return true;
        }
        double remoteVolume = remote?.State?.Volume ?? 0.5;
        // version 2: the volume keys change the volume of the device that plays
        var playsElsewhere = _session?.ActiveElsewhere;
        bool Volume(double step)
        {
            if (playsElsewhere is null) return false;
            _session!.SetVolume(playsElsewhere.Id, Math.Clamp(playsElsewhere.Volume + step, 0, 1));
            return true;
        }
        switch (e.Key)
        {
            case VirtualKey.Space when !typing && !mods && !alt: if (!Remote(Core.Connect.ConnectCommand.Toggle)) m.TogglePlay(); e.Handled = true; break;
            case VirtualKey.Right when mods: if (!Remote(Core.Connect.ConnectCommand.Next)) m.Next(); e.Handled = true; break;
            case VirtualKey.Left when mods: if (!Remote(Core.Connect.ConnectCommand.Previous)) m.Previous(); e.Handled = true; break;
            case VirtualKey.Up when mods: if (!Remote(Core.Connect.ConnectCommand.Volume, Math.Min(1, remoteVolume + 0.05)) && !Volume(0.05)) m.SetVolume(m.Volume + 0.05); e.Handled = true; break;
            case VirtualKey.Down when mods: if (!Remote(Core.Connect.ConnectCommand.Volume, Math.Max(0, remoteVolume - 0.05)) && !Volume(-0.05)) m.SetVolume(m.Volume - 0.05); e.Handled = true; break;
            case VirtualKey.K when mods: case (VirtualKey)191 when !typing:
                if (IsActive) _search?.Focus(FocusState.Keyboard);
                e.Handled = true; break;
            case VirtualKey.Left when alt: GoBack(); e.Handled = true; break;
            case VirtualKey.Right when alt: GoForward(); e.Handled = true; break;
            case VirtualKey.B when alt && shift: if (m.Current is { } t) _ = Run(() => m.SetLikedAsync(t.Id, !t.Liked)); e.Handled = true; break;
            // the zoom, as a browser's: Ctrl + = (or the keypad's +), Ctrl + -, Ctrl + 0
            case (VirtualKey)187 or VirtualKey.Add when mods: StepZoom(+1); e.Handled = true; break;
            case (VirtualKey)189 or VirtualKey.Subtract when mods: StepZoom(-1); e.Handled = true; break;
            case VirtualKey.Number0 or VirtualKey.NumberPad0 when mods: StepZoom(0); e.Handled = true; break;
        }
    }

    // ---------------------------------------------------------------- continue on another device
    private DateTimeOffset _offeredAt = DateTimeOffset.MinValue;

    /// <summary>At start: the queue saved on the server is taken over paused at its position, and a toast offers to play.
    /// Later (the window comes to the front, nothing playing): a queue saved since by another device is offered.</summary>
    private async Task OfferContinue(bool atStart)
    {
        if (_session is not null) return; // version 2: the session stays on the server and every device shows it (rule 6)
        if (_music is not { } m || (!atStart && (m.IsActive || DateTimeOffset.Now - _offeredAt < TimeSpan.FromSeconds(15)))) return;
        _offeredAt = DateTimeOffset.Now;
        RemoteQueue? q;
        try { q = await m.RemoteQueueAsync(); } catch (Exception ex) { Log.Write($"play queue: {ex.Message}"); return; }
        if (q is null || m.Library.Track(q.Current) is not { } t) return;
        bool mine = q.ChangedBy == m.Client.ClientName;
        if (atStart ? m.Current is not null : mine || q.Changed <= m.QueueSavedAt || m.IsActive) return;
        string from = mine ? "" : Core.AppName.DeviceOf(q.ChangedBy);
        string text = from.Length > 0 ? $"从「{from}」接着听：{t.Title}" : $"接着上次听：{t.Title}";
        if (atStart)
        {
            m.ContinueQueue(q, text);
            ShowToast(new(text, ActionLabel: "接着播放", Action: m.Resume));
        }
        else ShowToast(new(text, ActionLabel: "接着播放", Action: () => { m.ContinueQueue(q, text); m.Resume(); }));
    }

    // ---------------------------------------------------------------- toasts, dialogs, errors
    public void ShowToast(ToastMessage message)
    {
        var icon = Ui.Icon(message.IsError ? Glyphs.Error : Glyphs.Info, 14, message.IsError ? Ui.Brush("BadBrush") : Ui.Brush("InfoBrush"));
        icon.VerticalAlignment = VerticalAlignment.Top; icon.Margin = new Thickness(0, 7, 0, 0);
        var text = Ui.Text(message.Text, size: 13, foreground: Ui.Brush("TextPrimaryBrush"));
        text.TextWrapping = TextWrapping.Wrap; text.TextTrimming = TextTrimming.None; text.VerticalAlignment = VerticalAlignment.Center; text.Margin = new Thickness(0, 4, 0, 4);
        var row = new Grid { ColumnSpacing = 10 };
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        row.ColumnDefinitions.Add(new ColumnDefinition());
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        row.Children.Add(icon);
        Grid.SetColumn(text, 1); row.Children.Add(text);
        var edge = new Border { Width = 3, Background = Ui.Brush("BadBrush"), HorizontalAlignment = HorizontalAlignment.Left, Visibility = message.IsError ? Visibility.Visible : Visibility.Collapsed };
        var toast = new Border
        {
            Background = Ui.Brush("ToastBrush"), BorderBrush = Ui.Brush("LineBrush"), BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(7), Width = 360,
            Child = new Grid { Children = { edge, new Border { Padding = new Thickness(12, 6, 4, 6), Child = row } } },
            Translation = new System.Numerics.Vector3(0, 0, 32), Shadow = new ThemeShadow(),
        };
        AutomationProperties.SetName(toast, message.Text);
        AutomationProperties.SetLiveSetting(toast, Microsoft.UI.Xaml.Automation.Peers.AutomationLiveSetting.Polite);
        bool gone = false;
        void Dismiss() { if (gone) return; gone = true; Motion.Exit(toast, () => ToastHost.Children.Remove(toast)); }
        if (message.ActionLabel is { } label && message.Action is { } action)
        {
            var b = new Button { Content = label, Padding = new Thickness(10, 4, 10, 4), MinHeight = 28, CornerRadius = new CornerRadius(5), Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent), Foreground = Ui.Brush("AccentTextBrush"), BorderThickness = new Thickness(0), FontWeight = Microsoft.UI.Text.FontWeights.Bold, FontSize = 13, VerticalAlignment = VerticalAlignment.Top };
            b.Resources["ButtonBackgroundPointerOver"] = Ui.Brush("HoverBrush");
            b.Resources["ButtonForegroundPointerOver"] = Ui.Brush("AccentHiBrush");
            b.Resources["ButtonBackgroundPressed"] = Ui.Brush("HoverBrush");
            b.Resources["ButtonForegroundPressed"] = Ui.Brush("AccentTextBrush");
            AutomationProperties.SetName(b, label);
            b.Click += (_, _) => { Dismiss(); action(); };
            Grid.SetColumn(b, 2); row.Children.Add(b);
        }
        var close = Ui.IconButton(Glyphs.Close, "关闭提示", (_, _) => Dismiss(), 28, 10);
        close.VerticalAlignment = VerticalAlignment.Top;
        Grid.SetColumn(close, 3); row.Children.Add(close);
        while (ToastHost.Children.Count >= 3) ToastHost.Children.RemoveAt(0);
        ToastHost.Children.Add(toast);
        Motion.Enter(toast, rise: 12, transitions: true);
        var timer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(message.Action is null ? 5 : 12) };
        timer.Tick += (_, _) => { timer.Stop(); Dismiss(); };
        timer.Start();
    }

    public async Task Run(Func<Task> action)
    {
        try { await action(); }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            // server answers, the network, and Windows (an output device that was unplugged: COMException) alike
            Log.Write($"[action] {ex.GetType().Name}: {ex.Message}");
            ShowToast(new(ex is System.Runtime.InteropServices.COMException ? $"Windows 拒绝了这个操作：{ex.Message}" : ex.Message, true));
        }
    }

    public async Task<string?> AskText(string title, string label, string value)
    {
        var box = new TextBox { Header = label, Text = value, MaxLength = 80 };
        var dialog = new ContentDialog { Title = title, Content = box, PrimaryButtonText = "保存", CloseButtonText = "取消", DefaultButton = ContentDialogButton.Primary, XamlRoot = Content.XamlRoot };
        return await dialog.ShowAsync() == ContentDialogResult.Primary ? box.Text.Trim() : null;
    }

    public async Task<bool> Confirm(string title, string message, string action)
    {
        var dialog = new ContentDialog { Title = title, Content = message, PrimaryButtonText = action, CloseButtonText = "取消", DefaultButton = ContentDialogButton.Close, XamlRoot = Content.XamlRoot };
        return await dialog.ShowAsync() == ContentDialogResult.Primary;
    }

    public void ShowProperties(Track t)
    {
        var facts = new StackPanel { Spacing = 8, MinWidth = 420 };
        void Fact(string k, string v)
        {
            var g = new Grid { ColumnSpacing = 16 };
            g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(90) }); g.ColumnDefinitions.Add(new ColumnDefinition());
            g.Children.Add(Ui.Text(k, "MutedTextStyle"));
            var tb = Ui.Text(v, size: 13, foreground: Ui.Brush("TextPrimaryBrush")); tb.TextWrapping = TextWrapping.Wrap; tb.IsTextSelectionEnabled = true;
            Grid.SetColumn(tb, 1); g.Children.Add(tb);
            facts.Children.Add(g);
        }
        Fact("标题", t.Title); Fact("艺人", t.Artist); Fact("专辑", t.Album); Fact("音轨", $"{t.Disc}-{t.Number}"); Fact("年份", t.Year.ToString()); Fact("流派", t.Genre);
        Fact("时长", Formats.Duration(t.Duration)); Fact("格式", Formats.Quality(t)); Fact("声道", t.Channels == 2 ? "立体声" : $"{t.Channels} 声道");
        Fact("文件大小", Formats.Size(t.Size)); Fact("位置", t.Path); Fact("播放次数", $"{t.PlayCount} 次"); Fact("上次播放", Formats.Relative(t.LastPlayed));
        Fact("回放增益", t.TrackGain is null && t.AlbumGain is null ? "无" : $"音轨 {t.TrackGain:+0.00;-0.00} dB · 专辑 {t.AlbumGain:+0.00;-0.00} dB");
        _ = new ContentDialog { Title = "属性", Content = new ScrollViewer { Content = facts, MaxHeight = 520 }, CloseButtonText = "关闭", XamlRoot = Content.XamlRoot }.ShowAsync();
    }
}
