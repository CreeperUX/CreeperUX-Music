using Sonus.Core;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Automation.Peers;
using Microsoft.UI.Xaml.Controls;

namespace Sonus.Controls;

/// <summary>Sign-in to a music server (Navidrome or another Subsonic-compatible one). With a demo server (the demo launcher
/// passes --demo), one button signs in to its account.</summary>
public sealed class LoginView : UserControl
{
    public static readonly (string User, string Password) DemoAccount = ("demo", "demo");
    public const string PlainWarning = "这是明文 HTTP 连接：登录令牌会随每个请求明文经过互联网，被截获就能冒用你的账号。外网的服务器请用 HTTPS，或通过 Tailscale 这类虚拟内网连接。";

    private readonly TextBox _server, _user;
    private readonly Grid _plain;
    private readonly PasswordBox _password;
    private readonly TextBlock _error;
    private readonly Button _submit, _browser;
    private Button? _demo;
    private bool _busy;
    // the browser sign-in under way: its code, shown while the user allows this app in the browser
    private readonly StackPanel _waiting;
    private readonly TextBlock _code;
    private CancellationTokenSource? _browserCancel;
    private DeviceLoginStart? _started;

    public Func<string, string, string, Task<Login>>? SignIn { get; set; }
    public event Func<Login, Task>? SignedIn;
    /// <summary>What this computer is called in the browser sign-in (the key's name on the server: "Sonus · 书房电脑").</summary>
    public string DeviceName { get; set; } = Environment.MachineName;
    /// <summary>Opens the approval page (the default browser; a test instance only logs it).</summary>
    public Func<Uri, Task>? OpenBrowser { get; set; }

    public LoginView(string lastServer, string? demoServer, string? error, bool windowActive)
    {
        _server = new TextBox { Header = "服务器地址", PlaceholderText = "例如 https://music.example.com 或 http://192.168.1.10:4533", Text = lastServer, InputScope = new Microsoft.UI.Xaml.Input.InputScope { Names = { new Microsoft.UI.Xaml.Input.InputScopeName(Microsoft.UI.Xaml.Input.InputScopeNameValue.Url) } } };
        // plain HTTP to a server on the internet: said as the address is typed, not refused (the choice is the user's)
        _plain = Ui.Note(Glyphs.Error, PlainWarning, Ui.Brush("WarnBrush"));
        void Check() => _plain.Visibility = SubsonicClient.IsPlainOverInternet(_server.Text) ? Visibility.Visible : Visibility.Collapsed;
        _server.TextChanged += (_, _) => Check();
        Check();
        _user = new TextBox { Header = "用户名" };
        _password = new PasswordBox { Header = "密码" };
        _error = Ui.Text(error ?? "", size: 13, foreground: Ui.Brush("BadBrush"));
        _error.TextWrapping = TextWrapping.Wrap;
        _error.Visibility = error is null ? Visibility.Collapsed : Visibility.Visible;
        AutomationProperties.SetLiveSetting(_error, Microsoft.UI.Xaml.Automation.Peers.AutomationLiveSetting.Assertive);
        _submit = new Button { Content = "登录", Style = Ui.Style("AccentButtonStyle"), MinWidth = 120, Padding = new Thickness(20, 8, 20, 8), CornerRadius = new CornerRadius(18) };
        Motion.Press(_submit);
        _submit.Click += async (_, _) => await Go(_server.Text, _user.Text, _password.Password);
        _password.KeyDown += async (_, e) => { if (e.Key == Windows.System.VirtualKey.Enter) await Go(_server.Text, _user.Text, _password.Password); };
        _browser = new Button { Content = Ui.Row(8, Ui.Icon(Glyphs.External, 14), Ui.Text("在浏览器中登录")), Style = Ui.Style("PillButtonStyle"), Padding = new Thickness(16, 8, 16, 8) };
        Motion.Press(_browser);
        AutomationProperties.SetName(_browser, "在浏览器中登录");
        ToolTipService.SetToolTip(_browser, "在服务器的网页上登录并允许这台电脑，不用在这里输密码；开启了二步验证的服务器用这个最方便。");
        _browser.Click += async (_, _) => await GoBrowser();
        var actions = Ui.Row(12, _submit, _browser);

        _code = new TextBlock { FontSize = 30, FontFamily = new Microsoft.UI.Xaml.Media.FontFamily("Cascadia Mono, Consolas"), CharacterSpacing = 200, Foreground = Ui.Brush("AccentTextBrush"), HorizontalAlignment = HorizontalAlignment.Center, IsTextSelectionEnabled = true };
        AutomationProperties.SetName(_code, "登录代码");
        var codePlate = new Border { Background = Ui.Brush("PanelBrush"), BorderBrush = Ui.Brush("LineBrush"), BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(8), Padding = new Thickness(16, 10, 16, 10), Child = _code };
        // buttons inside the raised waiting box need a distinct raised surface + hairline so they read as buttons
        Button WaitButton(string label)
        {
            var b = new Button { Content = label, Style = Ui.Style("PillButtonStyle"), Background = Ui.Brush("RaisedHiBrush"), BorderBrush = Ui.Brush("LineBrush"), BorderThickness = new Thickness(1) };
            b.Resources["ButtonBackgroundPointerOver"] = Ui.Brush("SurfaceHoverBrush");
            b.Resources["ButtonBackgroundPressed"] = Ui.Brush("HoverBrush");
            b.Resources["ButtonBorderBrushPointerOver"] = Ui.Brush("LineBrush");
            b.Resources["ButtonBorderBrushPressed"] = Ui.Brush("LineBrush");
            Motion.Press(b);
            return b;
        }
        var reopen = WaitButton("重新打开浏览器");
        reopen.Click += async (_, _) => { if (_started is { } s && OpenBrowser is { } open) await open(s.VerificationUrl); };
        var cancelBrowser = WaitButton("取消");
        AutomationProperties.SetName(cancelBrowser, "取消在浏览器中登录");
        cancelBrowser.Click += (_, _) => _browserCancel?.Cancel();
        var waitingText = Ui.Text("已在浏览器中打开服务器的登录页。在那里登录（开启了二步验证时还要输验证码），确认网页上显示的是下面这个代码，然后点“允许”。这里会自动完成登录。", size: 13);
        waitingText.TextWrapping = TextWrapping.Wrap;
        _waiting = new StackPanel { Spacing = 12, Visibility = Visibility.Collapsed, Padding = new Thickness(16), CornerRadius = new CornerRadius(10), Background = Ui.Brush("RaisedBrush"), BorderBrush = Ui.Brush("LineBrush"), BorderThickness = new Thickness(1) };
        foreach (var e in new UIElement[] { waitingText, codePlate, Ui.Row(8, reopen, cancelBrowser) }) _waiting.Children.Add(e);
        AutomationProperties.SetLiveSetting(_waiting, Microsoft.UI.Xaml.Automation.Peers.AutomationLiveSetting.Polite);

        // the demo's own row: three buttons do not fit across the card
        StackPanel? demoRow = null;
        if (demoServer is not null)
        {
            var demo = _demo = new Button { Content = Ui.Row(8, Ui.Icon(Glyphs.Music, 14), Ui.Text("使用本机的演示服务器")), Style = Ui.Style("PillButtonStyle"), Padding = new Thickness(16, 8, 16, 8) };
            Motion.Press(demo);
            AutomationProperties.SetName(demo, "使用本机的演示服务器");
            demo.Click += async (_, _) => await Go(demoServer, DemoAccount.User, DemoAccount.Password);
            demoRow = Ui.Row(12, demo);
        }

        var brand = Ui.Row(10, new Image { Source = new Microsoft.UI.Xaml.Media.Imaging.BitmapImage(new Uri("ms-appx:///Assets/Logo-64.png")), Width = 40, Height = 40 },
            new TextBlock { FontSize = 22, FontWeight = Microsoft.UI.Text.FontWeights.SemiBold, FontFamily = (Microsoft.UI.Xaml.Media.FontFamily)Application.Current.Resources["AppDisplayFont"], VerticalAlignment = VerticalAlignment.Center, Text = "Sonus" });
        var title = Ui.Text("连接你的音乐服务器", "PageTitleStyle");
        AutomationProperties.SetHeadingLevel(title, AutomationHeadingLevel.Level1);
        var intro = Ui.Text("登录你自己的 Navidrome（或其他兼容 Subsonic 的服务器）。歌单、喜欢和播放次数都保存在服务器上，所有设备共用。", "MutedTextStyle");
        intro.TextWrapping = TextWrapping.Wrap;
        var note = Ui.Note(Glyphs.Info, "密码不会保存：Windows 凭据管理器里只保存由它算出的登录令牌，或在浏览器中登录时服务器发给这台电脑的应用密钥。");
        var card = new StackPanel
        {
            Spacing = 16, Width = 460, Padding = new Thickness(36), CornerRadius = new CornerRadius(12),
            Background = Ui.Brush("PanelBrush"), BorderBrush = Ui.Brush("LineBrush"), BorderThickness = new Thickness(1),
            HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center,
            Shadow = new Microsoft.UI.Xaml.Media.ThemeShadow(), Translation = new System.Numerics.Vector3(0, 0, 24),
        };
        foreach (var e in new UIElement?[] { brand, title, intro, _server, _plain, _user, _password, _error, actions, demoRow, _waiting, note }) if (e is not null) card.Children.Add(e);
        Motion.Enter(card, rise: 14, move: Motion.Push, transitions: true);
        Content = new ScrollViewer { Content = card, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
        Loaded += (_, _) => { if (windowActive) ((Control)(_server.Text.Length > 0 ? _user : _server)).Focus(FocusState.Programmatic); };
    }

    private async Task Go(string server, string user, string password)
    {
        if (SignIn is null || _busy) return; // Enter pressed twice, or the demo button during a sign-in: one at a time
        _busy = true;
        _error.Visibility = Visibility.Collapsed;
        _submit.IsEnabled = false; _submit.Content = "正在连接…";
        if (_demo is not null) _demo.IsEnabled = false;
        try
        {
            var login = await SignIn(server, user, password);
            if (SignedIn is { } done) await done(login);
        }
        catch (Exception ex) when (ex is SubsonicException or ServerUnreachableException or ArgumentException)
        {
            _error.Text = ex is SubsonicException { IsAuthentication: true }
                ? ex.Message + "如果这个服务器开启了二步验证，请点“在浏览器中登录”，或者在密码栏填应用专用密码。"
                : ex.Message;
            _error.Visibility = Visibility.Visible;
            Ready();
        }
    }

    private void Ready()
    {
        _submit.IsEnabled = true; _submit.Content = "登录";
        _browser.IsEnabled = true;
        if (_demo is not null) _demo.IsEnabled = true;
        _waiting.Visibility = Visibility.Collapsed;
        _started = null;
        _busy = false;
    }

    /// <summary>The browser sign-in (<see cref="DeviceLogin"/>): the server's approval page opens in the browser, this
    /// waits with the code shown until the user allowed (or refused) this app there.</summary>
    private async Task GoBrowser()
    {
        if (_busy) return;
        _busy = true;
        _error.Visibility = Visibility.Collapsed;
        _submit.IsEnabled = false; _browser.IsEnabled = false;
        if (_demo is not null) _demo.IsEnabled = false;
        using var cancel = _browserCancel = new CancellationTokenSource();
        try
        {
            var (server, supported) = await DeviceLogin.ProbeAsync(_server.Text, cancel: cancel.Token);
            if (!supported) throw new ArgumentException("这个服务器不支持在浏览器中登录（需要 Sonus 的 Navidrome 改版）。请用用户名和密码登录。");
            var start = _started = await DeviceLogin.StartAsync(server, "Sonus", DeviceName, cancel: cancel.Token);
            _code.Text = start.UserCode;
            _waiting.Visibility = Visibility.Visible;
            Motion.Enter(_waiting, rise: 12, move: Motion.Push);
            if (OpenBrowser is { } open) await open(start.VerificationUrl);
            var (state, login) = await DeviceLogin.WaitAsync(start, cancel: cancel.Token);
            switch (state)
            {
                case DeviceLoginState.Approved when login is not null:
                    _waiting.Visibility = Visibility.Collapsed;
                    if (SignedIn is { } done) await done(login);
                    return;
                case DeviceLoginState.Denied:
                    throw new ArgumentException("在浏览器中拒绝了这次登录。");
                default:
                    throw new ArgumentException("登录请求已过期（10 分钟内没有允许）。请重新点“在浏览器中登录”。");
            }
        }
        catch (OperationCanceledException) when (cancel.IsCancellationRequested)
        {
            Ready();
        }
        catch (Exception ex) when (ex is SubsonicException or ServerUnreachableException or ArgumentException or HttpRequestException or System.Text.Json.JsonException)
        {
            _error.Text = ex is HttpRequestException or System.Text.Json.JsonException ? $"在浏览器中登录没有成功：{ex.Message}" : ex.Message;
            _error.Visibility = Visibility.Visible;
            Ready();
        }
        finally { _browserCancel = null; }
    }

    /// <summary>Stops a browser sign-in under way (the window is closing, or another sign-in took over).</summary>
    public void CancelBrowser() => _browserCancel?.Cancel();
}
