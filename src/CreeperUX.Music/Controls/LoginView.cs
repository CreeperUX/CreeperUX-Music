using CreeperUX.Music.Core;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Automation.Peers;
using Microsoft.UI.Xaml.Controls;

namespace CreeperUX.Music.Controls;

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
    private readonly Button _submit;
    private Button? _demo;
    private bool _busy;

    public Func<string, string, string, Task<Login>>? SignIn { get; set; }
    public event Func<Login, Task>? SignedIn;

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
        _submit.Click += async (_, _) => await Go(_server.Text, _user.Text, _password.Password);
        _password.KeyDown += async (_, e) => { if (e.Key == Windows.System.VirtualKey.Enter) await Go(_server.Text, _user.Text, _password.Password); };
        var actions = Ui.Row(12, _submit);
        if (demoServer is not null)
        {
            var demo = _demo = new Button { Content = Ui.Row(8, Ui.Icon(Glyphs.Music, 14), Ui.Text("使用本机的演示服务器")), Style = Ui.Style("PillButtonStyle"), Padding = new Thickness(16, 8, 16, 8) };
            AutomationProperties.SetName(demo, "使用本机的演示服务器");
            demo.Click += async (_, _) => await Go(demoServer, DemoAccount.User, DemoAccount.Password);
            actions.Children.Add(demo);
        }

        var brand = Ui.Row(10, new Image { Source = new Microsoft.UI.Xaml.Media.Imaging.BitmapImage(new Uri("ms-appx:///Assets/Logo-64.png")), Width = 40, Height = 40 },
            new TextBlock { FontSize = 22, FontWeight = Microsoft.UI.Text.FontWeights.Bold, VerticalAlignment = VerticalAlignment.Center, Inlines = { new Microsoft.UI.Xaml.Documents.Run { Text = "CreeperUX " }, new Microsoft.UI.Xaml.Documents.Run { Text = "Music", Foreground = Ui.Brush("AccentTextBrush") } } });
        var title = Ui.Text("连接你的音乐服务器", "PageTitleStyle");
        AutomationProperties.SetHeadingLevel(title, AutomationHeadingLevel.Level1);
        var intro = Ui.Text("登录你自己的 Navidrome（或其他兼容 Subsonic 的服务器）。歌单、喜欢和播放次数都保存在服务器上，所有设备共用。", "MutedTextStyle");
        intro.TextWrapping = TextWrapping.Wrap;
        var note = Ui.Note(Glyphs.Info, "密码不会保存：只在 Windows 凭据管理器里保存由它算出的登录令牌。");
        var card = new StackPanel { Spacing = 16, Width = 460, Padding = new Thickness(36), CornerRadius = new CornerRadius(12), Background = Ui.Brush("PanelBrush"), HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
        foreach (var e in new UIElement[] { brand, title, intro, _server, _plain, _user, _password, _error, actions, note }) card.Children.Add(e);
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
            _error.Text = ex.Message;
            _error.Visibility = Visibility.Visible;
            _submit.IsEnabled = true; _submit.Content = "登录";
            if (_demo is not null) _demo.IsEnabled = true;
            _busy = false;
        }
    }
}
