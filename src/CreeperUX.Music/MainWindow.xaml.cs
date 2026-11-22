using CreeperUX.Music.Controls;
using CreeperUX.Music.Core;
using CreeperUX.Music.Pages;
using CreeperUX.Music.Services;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Windows.System;

namespace CreeperUX.Music;

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
    private Button? _connection;
    private Microsoft.UI.Xaml.Controls.Primitives.ToggleButton? _panelToggle;
    private DispatcherTimer? _searchTimer;

    public MainWindow()
    {
        InitializeComponent();
        ExtendsContentIntoTitleBar = true;
        SetTitleBar(AppTitleBar);
        AppWindow.TitleBar.PreferredHeightOption = TitleBarHeightOption.Tall;
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
            _music.Dispose();
            Close();
        };
        RootGrid.SizeChanged += (_, _) => Fit();
        RootGrid.AddHandler(UIElement.PointerPressedEvent, new PointerEventHandler(OnPointerPressed), true);
        RootGrid.AddHandler(UIElement.KeyDownEvent, new KeyEventHandler(OnKeyDown), true);
        _ = Start();
    }

    private bool _closing;

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
    private static string ClientName => $"CreeperUX Music ({(AppPaths.IsTestInstance ? "测试 " : "")}{Environment.MachineName})";

    private async Task Start()
    {
        if (Login.FromJson(Interop.Credentials.Read()) is { } login) await Connect(login);
        else ShowLogin();
    }

    private void ShowLogin(string? error = null)
    {
        Panels.Visibility = Visibility.Collapsed; BarHost.Visibility = Visibility.Collapsed;
        TopCenter.Children.Clear(); TopEnd.Children.Clear();
        var login = new LoginView(_settings.LastServer, Program.DemoServer, error, IsActive);
        login.SignedIn += async l => { Interop.Credentials.Write(l.ToJson(), l.User); _settings.LastServer = l.Server; _settings.Save(); await Connect(l); };
        login.SignIn = (server, user, password) => SubsonicClient.SignInAsync(server, user, password, ClientName);
        LoginHost.Child = login;
        LoginHost.Visibility = Visibility.Visible;
        Title = "登录 · CreeperUX Music";
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
        Build(music);
        Navigate("home");
        Log.Write($"[start] {music.Server.Version}: {music.Library.Tracks.Count} songs, {music.Library.Albums.Count} albums, {music.Playlists.Count - 2} playlists");
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
        _music?.Dispose();
        _music = null; Ready = false;
        _view?.Leave(); _view = null;
        Interop.Credentials.Delete();
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
            LibraryColumn.Width = new GridLength(rail ? 88 : 300);
            if (byUser) { _settings.LibraryOpen = !rail; _settings.Save(); }
        };
        LibraryHost.Child = _library;
        if (!_settings.LibraryOpen) _library.SetRail(true, byUser: false);
        _panel = new NowPlayingPane(music, this);
        _panel.CloseRequested += () => SetPanel(false);
        PanelHost.Child = _panel;
        _bar = new PlaybackBar(music, this);
        _bar.QueueToggled += open => { SetPanel(true); _panel.Show(open ? "queue" : "now"); };
        BarHost.Child = _bar;
        BarHost.Visibility = Visibility.Visible;
        SetPanel(_settings.PanelOpen);

        // the top bar
        TopCenter.Children.Clear(); TopEnd.Children.Clear();
        var home = Ui.IconButton(Glyphs.Home, "首页", (_, _) => Navigate("home"), 44, 18);
        home.Background = Ui.Brush("RaisedBrush");
        _search = new TextBox { PlaceholderText = "想听什么？", Width = 420, Height = 44, CornerRadius = new CornerRadius(22), Padding = new Thickness(18, 11, 18, 0), FontSize = 15, VerticalContentAlignment = VerticalAlignment.Center };
        AutomationProperties.SetName(_search, "搜索");
        _search.TextChanged += (_, _) =>
        {
            _searchTimer ??= new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(250) };
            _searchTimer.Stop();
            _searchTimer.Tick -= SearchTick; _searchTimer.Tick += SearchTick;
            _searchTimer.Start();
        };
        _search.GotFocus += (_, _) => { if (!_route.StartsWith("search:", StringComparison.Ordinal)) Navigate("search:" + _search.Text.Trim()); };
        var browse = Ui.IconButton(Glyphs.Browse, "浏览全部", (_, _) => Navigate("search:"), 44, 16);
        browse.Background = Ui.Brush("RaisedBrush");
        TopCenter.Children.Add(home); TopCenter.Children.Add(_search); TopCenter.Children.Add(browse);
        _browse = browse;

        var dot = new Microsoft.UI.Xaml.Shapes.Ellipse { Width = 8, Height = 8, Fill = Ui.Brush("GoodBrush"), VerticalAlignment = VerticalAlignment.Center };
        var label = Ui.Text(music.Server.Name, size: 13, foreground: Ui.Brush("TextPrimaryBrush"));
        _connection = new Button { Content = Ui.Row(8, dot, label), Style = Ui.Style("PillButtonStyle"), Tag = (dot, label) };
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
        var settings = Ui.IconButton(Glyphs.Settings, "设置", (_, _) => Navigate("settings"), 40, 16);
        _panelToggle = Ui.IconToggle(Glyphs.Panel, "显示或隐藏正在播放", 40);
        _panelToggle.IsChecked = _settings.PanelOpen;
        _panelToggle.Click += (_, _) => { SetPanel(_panelToggle.IsChecked == true); if (_panelToggle.IsChecked == true) _panel?.Show("now"); };
        TopEnd.Children.Add(_connection); TopEnd.Children.Add(settings); TopEnd.Children.Add(_panelToggle);

        music.Toast += ShowToast;
        music.PlayerChanged += () => { if (_route == "lyrics") _bar?.SetPanelMode(_panel?.Mode == "queue" && PanelColumn.Width.Value > 0, true); };
        Fit();
    }

    private void SearchTick(object? sender, object e)
    {
        _searchTimer?.Stop();
        if (_search is null) return;
        string route = "search:" + _search.Text.Trim();
        if (_route.StartsWith("search:", StringComparison.Ordinal)) Navigate(route, replace: true);
        else Navigate(route);
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
        PanelColumn.Width = new GridLength(open ? 340 : 0);
        PanelHost.Visibility = open ? Visibility.Visible : Visibility.Collapsed;
        if (_panelToggle is not null) _panelToggle.IsChecked = open;
        if (byUser) { _settings.PanelOpen = open; _settings.Save(); }
        _bar?.SetPanelMode(open && _panel?.Mode == "queue", _route == "lyrics");
    }

    private bool _narrowPanel, _narrowLibrary;
    private Button? _browse;

    /// <summary>Narrow windows: the panel closes below 1100 px, the library becomes a rail below 860 px, the brand shrinks to
    /// its icon and the search field to what is left. Widening puts back what the person chose; none of it is saved.</summary>
    private void Fit()
    {
        double w = RootGrid.ActualWidth;
        BrandName.Visibility = w < 1000 ? Visibility.Collapsed : Visibility.Visible;
        if (_search is not null) _search.Width = Math.Clamp(w - (w < 1000 ? 600 : 760), 100, 420);
        if (_browse is not null) _browse.Visibility = w < 1000 ? Visibility.Collapsed : Visibility.Visible; // "浏览全部" is the empty search page too
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
        Title = view.Title.Length > 0 ? $"{view.Title} · CreeperUX Music" : "CreeperUX Music";
        if (_search is not null && kind != "search" && _search.FocusState == FocusState.Unfocused) _search.Text = "";
        _bar?.SetPanelMode(_panel?.Mode == "queue" && PanelColumn.Width.Value > 0, kind == "lyrics");
        Navigated?.Invoke(route);
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
        switch (e.Key)
        {
            case VirtualKey.Space when !typing && !mods && !alt: m.TogglePlay(); e.Handled = true; break;
            case VirtualKey.Right when mods: m.Next(); e.Handled = true; break;
            case VirtualKey.Left when mods: m.Previous(); e.Handled = true; break;
            case VirtualKey.Up when mods: m.SetVolume(m.Volume + 0.05); e.Handled = true; break;
            case VirtualKey.Down when mods: m.SetVolume(m.Volume - 0.05); e.Handled = true; break;
            case VirtualKey.K when mods: case (VirtualKey)191 when !typing:
                if (IsActive) _search?.Focus(FocusState.Keyboard);
                e.Handled = true; break;
            case VirtualKey.Left when alt: GoBack(); e.Handled = true; break;
            case VirtualKey.Right when alt: GoForward(); e.Handled = true; break;
            case VirtualKey.B when alt && shift: if (m.Current is { } t) _ = Run(() => m.SetLikedAsync(t.Id, !t.Liked)); e.Handled = true; break;
        }
    }

    // ---------------------------------------------------------------- continue on another device
    private DateTimeOffset _offeredAt = DateTimeOffset.MinValue;

    /// <summary>At start: the queue saved on the server is taken over paused at its position, and a toast offers to play.
    /// Later (the window comes to the front, nothing playing): a queue saved since by another device is offered.</summary>
    private async Task OfferContinue(bool atStart)
    {
        if (_music is not { } m || (!atStart && (m.IsActive || DateTimeOffset.Now - _offeredAt < TimeSpan.FromSeconds(15)))) return;
        _offeredAt = DateTimeOffset.Now;
        RemoteQueue? q;
        try { q = await m.RemoteQueueAsync(); } catch (Exception ex) { Log.Write($"play queue: {ex.Message}"); return; }
        if (q is null || m.Library.Track(q.Current) is not { } t) return;
        bool mine = q.ChangedBy == m.Client.ClientName;
        if (atStart ? m.Current is not null : mine || q.Changed <= m.QueueSavedAt || m.IsActive) return;
        string from = mine ? "" : q.ChangedBy.Replace("CreeperUX Music (", "").TrimEnd(')');
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
        var text = Ui.Text(message.Text, size: 14, foreground: Ui.Brush("OnAccentBrush"));
        text.TextWrapping = TextWrapping.Wrap; text.MaxWidth = 520; text.VerticalAlignment = VerticalAlignment.Center;
        var row = Ui.Row(16, text);
        var toast = new Border
        {
            Background = message.IsError ? Ui.Solid(Ui.Rgb(0xF2, 0xB8, 0xB5)) : Ui.Brush("TextPrimaryBrush"), CornerRadius = new CornerRadius(8),
            Padding = new Thickness(16, 10, 10, 10), Child = row, Translation = new System.Numerics.Vector3(0, 0, 32), Shadow = new ThemeShadow(),
        };
        AutomationProperties.SetName(toast, message.Text);
        AutomationProperties.SetLiveSetting(toast, Microsoft.UI.Xaml.Automation.Peers.AutomationLiveSetting.Polite);
        void Dismiss() => ToastHost.Children.Remove(toast);
        if (message.ActionLabel is { } label && message.Action is { } action)
        {
            var b = new Button { Content = label, Padding = new Thickness(12, 4, 12, 4), CornerRadius = new CornerRadius(14), Background = Ui.Brush("OnAccentBrush"), Foreground = Ui.Brush("TextPrimaryBrush"), BorderThickness = new Thickness(0) };
            AutomationProperties.SetName(b, label);
            b.Click += (_, _) => { Dismiss(); action(); };
            row.Children.Add(b);
        }
        var close = new Button { Content = Glyphs.Close, FontFamily = (FontFamily)Application.Current.Resources["SymbolThemeFontFamily"], FontSize = 10, Width = 28, Height = 28, Padding = new Thickness(0), Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent), BorderThickness = new Thickness(0), Foreground = Ui.Brush("OnAccentBrush") };
        AutomationProperties.SetName(close, "关闭提示");
        close.Click += (_, _) => Dismiss();
        row.Children.Add(close);
        while (ToastHost.Children.Count >= 3) ToastHost.Children.RemoveAt(0);
        ToastHost.Children.Add(toast);
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
