using Sonus.Controls;
using Sonus.Core;
using Sonus.Playback;
using Sonus.Services;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Automation.Peers;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;

namespace Sonus.Pages;

/// <summary>Search. Empty: one tile per genre. With words: the top result, songs, then artists, albums and playlists.</summary>
public sealed class SearchPage : View
{
    private readonly string _query;
    public override string Title => _query.Length > 0 ? $"搜索：{_query}" : "搜索";

    public SearchPage(MusicService music, IShell shell, string query) : base(music, shell)
    {
        _query = query.Trim();
        var searchTint = Ui.Tint(Ui.Rgb(0x2b, 0x34, 0x39));
        if (_query.Length == 0)
        {
            var (_, body, tint) = Scaffold();
            tint.Background = searchTint;
            Browse(body);
            return;
        }
        // the results are the head of a list of songs, which fills when "歌曲" is chosen (up to 200: only those in view are built)
        var (head, listTint) = ListScaffold();
        listTint.Background = searchTint;
        var status = Ui.Text("正在搜索…", "MutedTextStyle");
        head.Children.Add(status);
        var songs = new TrackList(music, shell, "search", _query, [], covers: true, label: "歌曲");
        ShowList(songs, head, listTint);
        _ = Results(head, status, songs);
    }

    private void Browse(StackPanel body)
    {
        var heading = Ui.Text("浏览全部", "PageTitleStyle");
        AutomationProperties.SetHeadingLevel(heading, AutomationHeadingLevel.Level1);
        body.Children.Add(heading);
        body.Children.Add(Ui.Row(8, Ui.Icon(Glyphs.Info, 14), Ui.Text("在媒体库中搜索标题、艺人和专辑。", "MutedTextStyle")));
        var genres = Music.Library.Albums.GroupBy(a => a.Genre).OrderByDescending(g => g.Count()).ToList();
        var tiles = Ui.Repeater<IGrouping<string, Album>>(
            new UniformGridLayout { MinItemWidth = 188, MinItemHeight = 108, MinColumnSpacing = 12, MinRowSpacing = 12, ItemsStretch = UniformGridLayoutItemsStretch.Fill },
            g =>
            {
                var tile = new Button
                {
                    HorizontalAlignment = HorizontalAlignment.Stretch, VerticalAlignment = VerticalAlignment.Stretch,
                    HorizontalContentAlignment = HorizontalAlignment.Stretch, VerticalContentAlignment = VerticalAlignment.Stretch,
                    CornerRadius = new CornerRadius(8), Padding = new Thickness(14), BorderThickness = new Thickness(0),
                    Background = new SolidColorBrush(Ui.Shade(ColorFor(g.Key), -0.2)),
                };
                var grid = new Grid();
                var name = Ui.Text(g.Key, size: 18, foreground: new SolidColorBrush(Microsoft.UI.Colors.White), bold: true);
                name.HorizontalAlignment = HorizontalAlignment.Left; name.VerticalAlignment = VerticalAlignment.Top;
                var art = new Artwork(64, false, Glyphs.Album, 4) { Url = Music.CoverUrl(g.First().Id, 128), HorizontalAlignment = HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Bottom, Margin = new Thickness(0, 0, -22, -24) };
                art.CenterPoint = new System.Numerics.Vector3(32, 32, 0);
                art.Rotation = 25;
                if (Motion.Enabled)
                {
                    art.RotationTransition = new ScalarTransition { Duration = Motion.Control };
                    art.ScaleTransition = new Vector3Transition { Duration = Motion.Control };
                    tile.PointerEntered += (_, _) => { art.Rotation = 20; art.Scale = new System.Numerics.Vector3(1.04f, 1.04f, 1); };
                    tile.PointerExited += (_, _) => { art.Rotation = 25; art.Scale = System.Numerics.Vector3.One; };
                }
                grid.Children.Add(art); grid.Children.Add(name);
                tile.Content = grid;
                AutomationProperties.SetName(tile, g.Key);
                tile.Click += (_, _) => Shell.Navigate($"genre:{g.Key}");
                _ = Recolor(tile, g.First().Id);
                return tile;
            }, stagger: true);
        tiles.ItemsSource = genres;
        AutomationProperties.SetName(tiles, "按流派浏览");
        body.Children.Add(tiles);
    }

    private static Windows.UI.Color ColorFor(string key)
    {
        uint h = 2166136261; foreach (char c in key) { h ^= c; h *= 16777619; }
        return Ui.Rgb((byte)(60 + h % 120), (byte)(50 + (h >> 8) % 110), (byte)(60 + (h >> 16) % 120));
    }

    private async Task Recolor(Button tile, string albumId)
    {
        if (await ArtworkColor.GetAsync(Music.CoverUrl(albumId, 64)) is { } c) tile.Background = new SolidColorBrush(Ui.Shade(c, -0.15));
    }

    private async Task Results(StackPanel body, TextBlock status, TrackList songList)
    {
        SearchResult r;
        try { r = await Music.SearchAsync(_query); }
        catch (Exception ex) when (ex is ServerUnreachableException or SubsonicException) { status.Text = ex.Message; return; }
        var playlists = Music.SearchPlaylists(_query).Select(p => p.Id).ToList();
        if (r.Count + playlists.Count == 0)
        {
            status.Text = "";
            body.Children.Add(Ui.Column(6, Ui.Text($"没有找到“{_query}”", "SectionTitleStyle"), Ui.Text("换个关键词，或检查拼写。", "MutedTextStyle")));
            return;
        }
        status.Text = $"找到 {r.Count + playlists.Count} 项";
        var options = new List<(string, string)>();
        if (r.Tracks.Count > 0) options.Add(("track", "歌曲"));
        if (r.Artists.Count > 0) options.Add(("artist", "艺人"));
        if (r.Albums.Count > 0) options.Add(("album", "专辑"));
        if (playlists.Count > 0) options.Add(("playlist", "歌单"));
        var chips = new Chips("搜索结果", options);
        body.Children.Add(chips);
        var host = new StackPanel { Spacing = 28 };
        body.Children.Add(host);
        void Render(string? kind)
        {
            host.Children.Clear();
            songList.SetIds(kind == "track" ? r.Tracks : []);
            if (kind is null)
            {
                var top = new Grid { ColumnSpacing = 24 };
                top.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(2, GridUnitType.Star), MaxWidth = 460 });
                top.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(3, GridUnitType.Star) });
                CardRef? best = r.Artists.Count > 0 ? new("artist", r.Artists[0]) : r.Albums.Count > 0 ? new("album", r.Albums[0]) : playlists.Count > 0 ? new("playlist", playlists[0]) : null;
                if (best is not null) top.Children.Add(TopResult(best));
                if (r.Tracks.Count > 0)
                {
                    var songs = Ui.Column(8, Ui.Text("歌曲", "SectionTitleStyle"), new TrackList(Music, Shell, "search", _query, r.Tracks.Take(4).ToList(), showAlbum: false, covers: true, contextIds: () => r.Tracks, label: "歌曲", header: false));
                    Grid.SetColumn(songs, best is null ? 0 : 1);
                    if (best is null) Grid.SetColumnSpan(songs, 2);
                    top.Children.Add(songs);
                }
                host.Children.Add(top);
                host.Children.Add(Cards.Shelf(Music, Shell, "艺人", r.Artists.Select(id => new CardRef("artist", id)).ToList()));
                host.Children.Add(Cards.Shelf(Music, Shell, "专辑", r.Albums.Select(id => new CardRef("album", id)).ToList()));
                host.Children.Add(Cards.Shelf(Music, Shell, "歌单", playlists.Select(id => new CardRef("playlist", id)).ToList()));
            }
            else if (kind != "track") host.Children.Add(Cards.Grid(Music, Shell, (kind == "artist" ? r.Artists : kind == "album" ? r.Albums : playlists).Select(id => new CardRef(kind, id))));
        }
        chips.Changed += Render;
        Render(null);
    }

    private FrameworkElement TopResult(CardRef best)
    {
        var (title, subtitle, cover, circle, glyph) = Cards.Describe(Music, best);
        var card = new Grid { Background = Ui.Brush("HoverBrush"), CornerRadius = new CornerRadius(8), Padding = new Thickness(20), MinHeight = 220 };
        Motion.BrushFade(card);
        card.PointerEntered += (_, _) => card.Background = Ui.Brush("SurfaceHoverBrush");
        card.PointerExited += (_, _) => card.Background = Ui.Brush("HoverBrush");
        var art = new Artwork(96, circle, glyph, 6) { Url = cover, HorizontalAlignment = HorizontalAlignment.Left, Shadow = new ThemeShadow(), Translation = new System.Numerics.Vector3(0, 0, 16) };
        if (best.Type == "playlist") Cards.Decorate(art, Music.Playlist(best.Id));
        var name = Ui.Link(title, () => Shell.Navigate(Cards.RouteOf(best)), 28, Ui.Brush("TextPrimaryBrush"), bold: true);
        var kind = best.Type == "artist" ? "艺人" : best.Type == "album" ? $"专辑 · {Music.Library.Album(best.Id)?.Artist}" : "歌单";
        card.Children.Add(Ui.Column(12, art, name, Ui.Text(kind, "MutedTextStyle")));
        var play = Ui.PlayButton($"播放 {title}", (_, _) => Music.TogglePlayContext(best.Type, best.Id), 48);
        play.HorizontalAlignment = HorizontalAlignment.Right; play.VerticalAlignment = VerticalAlignment.Bottom;
        card.Children.Add(play);
        void Sync() => Ui.SetPlaying(play, Music.IsContextPlaying(best.Type, best.Id), title);
        Sync();
        On(() => Music.PlayerChanged += Sync, () => Music.PlayerChanged -= Sync);
        return Ui.Column(8, Ui.Text("最佳结果", "SectionTitleStyle"), card);
    }
}

/// <summary>"显示全部" of a home shelf, or a genre (its albums and songs).</summary>
public sealed class CollectionPage : View
{
    private readonly string _title;
    public override string Title => _title;

    public CollectionPage(MusicService music, IShell shell, string kind, string id) : base(music, shell)
    {
        if (kind == "genre")
        {
            var (head, genreTint) = ListScaffold();
            _title = id;
            var albums = music.Library.Albums.Where(a => a.Genre == id).ToList();
            TintFrom(genreTint, albums.FirstOrDefault()?.Id);
            var ids = music.Library.Tracks.Where(t => t.Genre == id).OrderByDescending(t => t.PlayCount).Select(t => t.Id).ToList();
            head.Children.Add(Hero.Build("流派", id, [Hero.Fact($"{albums.Count} 张专辑"), Hero.Fact(Formats.Songs(ids.Count))], null));
            head.Children.Add(Hero.Actions(music, "genre", id, id, null, sync => On(() => music.PlayerChanged += sync, () => music.PlayerChanged -= sync)));
            head.Children.Add(Cards.Shelf(music, shell, "专辑", albums.Select(a => new CardRef("album", a.Id)).ToList(), limit: 50));
            head.Children.Add(Ui.Text("歌曲", "SectionTitleStyle"));
            ShowList(new TrackList(music, shell, "genre", id, ids, covers: true, label: $"{id} 的歌曲"), head, genreTint);
            return;
        }
        var (_, body, tint) = Scaffold();
        var col = HomeShelves.From(music.Library, music.Playlists);
        (string title, IReadOnlyList<CardRef> refs) = id switch
        {
            "recent" => ("最近播放", col.Recent), "playlists" => ("你的歌单", col.Playlists), "artists" => ("你常听的艺人", col.TopArtists),
            "hires" => ("高解析度收藏", col.HiRes), "added" => ("最近添加到媒体库", col.Added), _ => ("很久没听了", col.Forgotten),
        };
        _title = title;
        TintFrom(tint, refs.FirstOrDefault(r => r.Type == "album")?.Id);
        var heading = Ui.Text(title, "PageTitleStyle");
        AutomationProperties.SetHeadingLevel(heading, AutomationHeadingLevel.Level1);
        body.Children.Add(heading);
        body.Children.Add(Cards.Grid(music, shell, refs));
    }
}

/// <summary>The playing song's lyrics, large; the current line lit and kept in view; click a line to go there.</summary>
public sealed class LyricsPage : View
{
    public override string Title => "歌词";
    private readonly StackPanel _head = new() { Spacing = 2, Margin = new Thickness(0, 0, 0, 12) };
    private readonly StackPanel _lines = new() { Spacing = 14 };
    private readonly ScrollViewer _scroller;
    private IReadOnlyList<LyricLine>? _lyrics;
    private string? _for;
    private int _current = -2;

    public LyricsPage(MusicService music, IShell shell) : base(music, shell)
    {
        var (scroller, body, tint) = Scaffold(48);
        _scroller = scroller;
        tint.Height = 2000;
        TintFrom(tint, music.Current?.AlbumId);
        body.Children.Add(_head);
        body.Children.Add(_lines);
        On(() => music.PlayerChanged += Reload, () => music.PlayerChanged -= Reload);
        On(() => music.PositionChanged += Follow, () => music.PositionChanged -= Follow);
        Reload();
    }

    private async void Reload()
    {
        var t = Music.Current;
        if (t?.Id == _for) return;
        _for = t?.Id; _current = -2; _lyrics = null;
        _head.Children.Clear();
        _lines.Children.Clear();
        if (t is null) { _head.Visibility = Visibility.Collapsed; _lines.Children.Add(Ui.Text("没有正在播放的歌曲", "PageTitleStyle")); return; }
        // song title and artist at the top (foobar2k's .f2k-lyrics-head), so the page still names what plays when the right panel is closed
        var songTitle = Ui.Link(t.Title, () => Shell.Navigate($"album:{t.AlbumId}"), 22, Ui.Brush("TextPrimaryBrush"), bold: true);
        if (songTitle.Content is TextBlock tb) tb.FontFamily = (FontFamily)Application.Current.Resources["AppDisplayFont"];
        var artist = Ui.Link(t.Artist, () => Shell.Navigate($"artist:{t.ArtistId}"), 14, Ui.Brush("TextSecondaryBrush"));
        _head.Children.Add(songTitle);
        _head.Children.Add(artist);
        _head.Visibility = Visibility.Visible;
        try { _lyrics = await Music.LyricsAsync(t); } catch (Exception ex) { Log.Write($"lyrics: {ex.Message}"); }
        if (_for != t.Id) return;
        if (_lyrics is not { Count: > 0 }) { _lines.Children.Add(Ui.Text("这首歌没有歌词", "PageTitleStyle")); return; }
        foreach (var l in _lyrics)
        {
            var line = new Button
            {
                Content = new TextBlock { Text = l.Text.Length > 0 ? l.Text : "♪", FontSize = 28, FontWeight = Microsoft.UI.Text.FontWeights.Bold, TextWrapping = TextWrapping.Wrap, FontFamily = (FontFamily)Application.Current.Resources["AppDisplayFont"] },
                Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent), BorderThickness = new Thickness(0), Padding = new Thickness(0), Foreground = Ui.Brush("TextPrimaryBrush"),
                Opacity = Ahead,
            };
            // a line is lit by its opacity (the change fades); under the pointer it brightens instead of getting a box
            foreach (var key in new[] { "ButtonBackgroundPointerOver", "ButtonBackgroundPressed" }) line.Resources[key] = new SolidColorBrush(Microsoft.UI.Colors.Transparent);
            foreach (var key in new[] { "ButtonForegroundPointerOver", "ButtonForegroundPressed" }) line.Resources[key] = Ui.Brush("TextPrimaryBrush");
            Motion.OpacityFade(line);
            Motion.ScaleFade(line);
            line.Scale = new System.Numerics.Vector3(Behind, Behind, 1);
            line.SizeChanged += (_, e) => line.CenterPoint = new System.Numerics.Vector3(0, (float)e.NewSize.Height / 2, 0); // from its start
            int index = _lines.Children.Count;
            line.PointerEntered += (_, _) => line.Opacity = Math.Max(line.Opacity, 0.85);
            line.PointerExited += (_, _) => line.Opacity = OpacityOf(index);
            AutomationProperties.SetName(line, l.Text.Length > 0 ? l.Text : "间奏");
            if (l.Time is { } time) line.Click += (_, _) => Music.Seek(time);
            _lines.Children.Add(line);
        }
        Follow(Music.Position);
    }

    private const double Sung = 0.6, Ahead = 0.38; // the lit line is 1
    private const float Behind = 0.94f;              // the other lines' size: the sung one comes forward

    private double OpacityOf(int line) => line == _current ? 1 : line < _current ? Sung : Ahead;

    private void Follow(double position)
    {
        if (_lyrics is null || _lyrics.Count == 0) return;
        int at = LyricsParser.CurrentLine(_lyrics, position);
        if (at == _current) return;
        _current = at;
        for (int i = 0; i < _lines.Children.Count; i++)
            if (_lines.Children[i] is Button b) { b.Opacity = OpacityOf(i); float s = i == at ? 1 : Behind; b.Scale = new System.Numerics.Vector3(s, s, 1); }
        if (at >= 0 && _lines.Children[at] is FrameworkElement el)
        {
            _scroller.UpdateLayout();
            var p = el.TransformToVisual(_lines).TransformPoint(new Windows.Foundation.Point(0, 0));
            _scroller.ChangeView(null, Math.Max(0, p.Y - _scroller.ViewportHeight / 3), null, disableAnimation: !Motion.Enabled);
        }
    }
}

/// <summary>Settings: playback, the output device, the account, keyboard shortcuts, about.</summary>
public sealed class SettingsPage : View
{
    public override string Title => "设置";

    public SettingsPage(MusicService music, IShell shell, Func<Task> signOut) : base(music, shell)
    {
        var (_, body, _) = Scaffold();
        body.MaxWidth = 820; body.HorizontalAlignment = HorizontalAlignment.Left;
        var heading = Ui.Text("设置", "PageTitleStyle");
        AutomationProperties.SetHeadingLevel(heading, AutomationHeadingLevel.Level1);
        body.Children.Add(heading);

        StackPanel Section(string title, string? intro = null)
        {
            var s = new StackPanel { Spacing = 12, Padding = new Thickness(20), CornerRadius = new CornerRadius(8), Background = Ui.Brush("HoverBrush") };
            var h = Ui.Text(title, "SectionTitleStyle"); h.FontSize = 18;
            AutomationProperties.SetHeadingLevel(h, AutomationHeadingLevel.Level2);
            s.Children.Add(h);
            if (intro is not null) { var i = Ui.Text(intro, "MutedTextStyle"); i.TextWrapping = TextWrapping.Wrap; s.Children.Add(i); }
            body.Children.Add(s);
            return s;
        }

        // WinUI's RadioButtons fills column-first and gives each item a wide MinWidth, which wrapped "90%" under "80%"
        // while "100% / 110% / 125%" stayed on row 1. Row-major grids / rows keep options in natural reading order.
        bool syncingPlay = false;
        var orderButtons = new Dictionary<PlaybackOrder, RadioButton>();
        var orderGrid = new Grid { ColumnSpacing = 16, RowSpacing = 4 };
        for (int c = 0; c < 4; c++) orderGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var orders = Enum.GetValues<PlaybackOrder>();
        for (int r = 0; r < (orders.Length + 3) / 4; r++) orderGrid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        for (int i = 0; i < orders.Length; i++)
        {
            var o = orders[i];
            var rb = new RadioButton { Content = Formats.Order(o), GroupName = "PlaybackOrder", MinWidth = 0, IsChecked = o == music.Queue.Order };
            rb.Checked += (_, _) => { if (!syncingPlay && o != music.Queue.Order) music.SetOrder(o); };
            Grid.SetRow(rb, i / 4); Grid.SetColumn(rb, i % 4);
            orderGrid.Children.Add(rb);
            orderButtons[o] = rb;
        }
        var orderBox = Ui.Column(6, Ui.Text("播放顺序", size: 14, foreground: Ui.Brush("TextPrimaryBrush")), orderGrid);
        AutomationProperties.SetName(orderBox, "播放顺序");
        var play = Section("播放");
        play.Children.Add(orderBox);
        var stop = new ToggleSwitch { Header = "播完当前歌曲后停止", IsOn = music.Queue.StopAfterCurrent };
        stop.Toggled += (_, _) => music.SetStopAfterCurrent(stop.IsOn);
        play.Children.Add(stop);
        var rgRow = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 20 };
        foreach (var (mode, label) in new[] { (ReplayGainMode.Album, "按专辑"), (ReplayGainMode.Track, "按音轨"), (ReplayGainMode.Off, "不使用") })
        {
            var rb = new RadioButton { Content = label, GroupName = "ReplayGain", MinWidth = 0, IsChecked = mode == music.ReplayGain };
            rb.Checked += (_, _) => { if (!syncingPlay) music.SetReplayGain(mode); };
            rgRow.Children.Add(rb);
        }
        var rgBox = Ui.Column(6, Ui.Text("回放增益", size: 14, foreground: Ui.Brush("TextPrimaryBrush")), rgRow);
        AutomationProperties.SetName(rgBox, "回放增益");
        play.Children.Add(rgBox);
        var rgNote = Ui.Text("回放增益只降低音量，不会提高（Windows 播放器的音量上限是 100%）。", "MutedTextStyle"); rgNote.TextWrapping = TextWrapping.Wrap;
        play.Children.Add(rgNote);
        void SyncPlay()
        {
            syncingPlay = true;
            if (orderButtons.TryGetValue(music.Queue.Order, out var rb)) rb.IsChecked = true;
            stop.IsOn = music.Queue.StopAfterCurrent;
            syncingPlay = false;
        }
        On(() => music.PlayerChanged += SyncPlay, () => music.PlayerChanged -= SyncPlay);

        var look = Section("显示", "整个窗口一起缩放，像浏览器的缩放一样；也可以按 Ctrl + = 和 Ctrl + -，Ctrl + 0 恢复 100%。");
        bool syncingZoom = false;
        var zoomRow = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 20 };
        foreach (var z in Zooms)
        {
            var rb = new RadioButton { Content = $"{z * 100:0}%", GroupName = "UiZoom", MinWidth = 0, IsChecked = Math.Abs(z - shell.Zoom) < 0.001 };
            rb.Checked += (_, _) => { if (!syncingZoom && Math.Abs(z - shell.Zoom) > 0.001) shell.SetZoom(z); };
            zoomRow.Children.Add(rb);
        }
        var zoomBox = Ui.Column(6, Ui.Text("界面缩放", size: 14, foreground: Ui.Brush("TextPrimaryBrush")), zoomRow);
        AutomationProperties.SetName(zoomBox, "界面缩放");
        look.Children.Add(zoomBox);

        var output = Section("输出设备", "这台电脑上的音频输出设备。选“系统默认设备”时跟随 Windows 的设置。");
        var devices = new ComboBox { Header = "输出设备", MinWidth = 360 };
        output.Children.Add(devices);
        _ = FillDevices(devices);

        var acc = Section("账号", "歌单、喜欢、播放次数和“接着听”的队列都保存在这个服务器上，所有设备共用。");
        acc.Children.Add(Fact("服务器", music.Client.Login.Server));
        if (SubsonicClient.IsPlainOverInternet(music.Client.Login.Server))
        {
            var plain = Ui.Note(Glyphs.Error, "这个服务器用的是明文 HTTP：登录令牌会随每个请求明文经过互联网，被截获就能冒用你的账号。在服务器上配好 HTTPS 后，退出登录，再用 https:// 地址重新登录。", Ui.Brush("WarnBrush"));
            plain.Margin = new Thickness(196, 0, 0, 0); // under the value, past Fact's 180 px key and 16 px gap
            acc.Children.Add(plain);
        }
        acc.Children.Add(Fact("用户", music.Client.Login.User));
        acc.Children.Add(Fact("本机名称", music.Client.ClientName));
        acc.Children.Add(Fact("登录方式", music.Client.Login.IsApiKey ? "在浏览器中登录（应用密钥，可在服务器网页上撤销）" : "用户名和密码"));
        acc.Children.Add(Fact("登录信息保存在", music.Client.Login.IsApiKey ? "Windows 凭据管理器（只有这台电脑的应用密钥，没有密码）" : "Windows 凭据管理器（只有令牌，没有密码）"));
        var signOutButton = new Button { Content = Ui.Row(8, Ui.Icon(Glyphs.SignOut, 14), Ui.Text("退出登录")), Style = Ui.Style("PillButtonStyle") };
        AutomationProperties.SetName(signOutButton, "退出登录");
        signOutButton.Click += async (_, _) => await signOut();
        acc.Children.Add(signOutButton);

        AddUpdates(Section("更新", "有新版本时右上角会出现提示。安装时下载这台电脑架构的安装程序，按 GitHub 记录的 SHA-256 校验，然后关闭程序、打开安装程序；登录和设置保留。"), shell.Updates);

        var keys = Section("键盘快捷键");
        foreach (var (k, what) in new[] { ("空格", "播放 / 暂停"), ("Ctrl + →  /  Ctrl + ←", "下一首 / 上一首"), ("Ctrl + ↑  /  Ctrl + ↓", "音量"), ("Ctrl + K  或  /", "搜索"), ("Alt + ←", "后退"), ("Alt + Shift + B", "喜欢正在播放的歌曲"), ("Ctrl + =  /  Ctrl + -  /  Ctrl + 0", "放大 / 缩小 / 恢复 100%"), ("媒体键", "播放、暂停、上一首、下一首") })
            keys.Children.Add(Fact(k, what));

        var about = Section("关于");
        about.Children.Add(Fact("程序", $"Sonus {typeof(App).Assembly.GetName().Version?.ToString(3)} · WinUI 3"));
        about.Children.Add(Fact("服务器", music.Server.Version));
        about.Children.Add(Fact("协议", $"Subsonic API {music.Server.ApiVersion}{(music.Server.OpenSubsonic ? " + OpenSubsonic" : "")}"));
        about.Children.Add(Fact("数据目录", AppPaths.DataDirectory));
        var note = Ui.Text("媒体库文件夹、转码、用户和 Last.fm 在 Navidrome 自己的网页里设置。", "MutedTextStyle"); note.TextWrapping = TextWrapping.Wrap;
        about.Children.Add(note);
    }

    /// <summary>
    /// 设置 › 更新, as Lumen's 设置 › 关于: where things stand, 检查更新 / 安装更新, the daily check and test versions, and
    /// where updates come from (the public repository's releases, nothing to sign in with).
    /// </summary>
    private void AddUpdates(StackPanel section, Updates.UpdateService updates)
    {
        var settings = updates.Settings;
        var status = Ui.Text("", size: 13, foreground: Ui.Brush("TextPrimaryBrush"));
        status.TextWrapping = TextWrapping.Wrap;
        AutomationProperties.SetName(status, "更新状态");
        AutomationProperties.SetLiveSetting(status, AutomationLiveSetting.Polite);
        var ring = new ProgressRing { Width = 18, Height = 18, IsActive = false, VerticalAlignment = VerticalAlignment.Center };
        var check = new Button { Content = Ui.Row(8, Ui.Icon(Glyphs.Refresh, 14), Ui.Text("检查更新")), Style = Ui.Style("PillButtonStyle") };
        AutomationProperties.SetName(check, "检查更新");
        var install = new Button { Content = "安装更新", Style = Ui.Style("AccentButtonStyle"), Padding = new Thickness(20, 8, 20, 8), CornerRadius = new CornerRadius(18) };
        AutomationProperties.SetName(install, "安装更新");
        var auto = new ToggleSwitch { Header = "启动时自动检查（每天一次）", IsOn = settings.AutoCheckUpdates };
        var pre = new ToggleSwitch { Header = "接收测试版", IsOn = settings.UpdatePrerelease };

        string repository = Core.Updates.GitHubUpdates.Repository;
        var sourceNote = Ui.Note(Glyphs.Info, $"更新来自 GitHub 上 Sonus 的公开仓库（{repository}）的发布版，不用登录。");
        var link = new HyperlinkButton { Content = "在 GitHub 上查看所有版本", NavigateUri = new Uri($"https://github.com/{repository}/releases"), Padding = new Thickness(0), Margin = new Thickness(22, -6, 0, 0) };

        string current = Updates.UpdateService.CurrentText;
        void Sync(string? message = null)
        {
            var available = updates.Available;
            install.Visibility = available is null ? Visibility.Collapsed : Visibility.Visible;
            string last = settings.LastUpdateCheck is { } at ? $"上次检查：{at.ToLocalTime():yyyy-MM-dd HH:mm}。" : "";
            status.Text = message ?? (available is { } r ? $"当前版本 {current}，发现新版本 {r.DisplayVersion}{(r.IsPrerelease ? "（测试版）" : "")}。"
                : $"当前版本 {current}。{last}");
        }
        check.Click += async (_, _) =>
        {
            check.IsEnabled = false; ring.IsActive = true;
            try { Sync((await updates.CheckAsync()) is null ? $"当前版本 {current}，已是最新版本。" : null); }
            catch (Core.Updates.UpdateException ex) { Sync(ex.Message); }
            finally { ring.IsActive = false; check.IsEnabled = true; }
        };
        install.Click += async (_, _) => { if (updates.Available is { } r) await Updates.UpdateDialog.ShowAsync(XamlRoot, updates, r); };
        auto.Toggled += (_, _) => { settings.AutoCheckUpdates = auto.IsOn; settings.Save(); };
        pre.Toggled += (_, _) => { settings.UpdatePrerelease = pre.IsOn; settings.Save(); };
        void OnAvailable() => Sync();
        On(() => updates.AvailableChanged += OnAvailable, () => updates.AvailableChanged -= OnAvailable);
        Sync();

        section.Children.Add(status);
        section.Children.Add(Ui.Row(12, check, install, ring));
        section.Children.Add(auto);
        section.Children.Add(pre);
        section.Children.Add(sourceNote);
        section.Children.Add(link);
    }

    /// <summary>The zoom steps offered (the keyboard steps through the same ones).</summary>
    public static readonly double[] Zooms = [0.8, 0.9, 1.0, 1.1, 1.25];

    private static Grid Fact(string key, string value)
    {
        var g = new Grid { ColumnSpacing = 16 };
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(180) });
        g.ColumnDefinitions.Add(new ColumnDefinition());
        g.Children.Add(Ui.Text(key, "MutedTextStyle"));
        var v = Ui.Text(value, size: 13, foreground: Ui.Brush("TextPrimaryBrush"));
        v.IsTextSelectionEnabled = true; v.TextWrapping = TextWrapping.Wrap;
        Grid.SetColumn(v, 1);
        g.Children.Add(v);
        return g;
    }

    private async Task FillDevices(ComboBox box)
    {
        try
        {
            var list = await AudioEngine.OutputDevicesAsync();
            foreach (var d in list) box.Items.Add(new ComboBoxItem { Content = d.IsDefault && d.Id.Length > 0 ? $"{d.Name}（当前默认）" : d.Name, Tag = d.Id });
            box.SelectedIndex = Math.Max(0, list.FindIndex(d => d.Id == Music.OutputId));
            box.SelectionChanged += (_, _) => { if (box.SelectedItem is ComboBoxItem { Tag: string id }) _ = Shell.Run(() => Music.SetOutputAsync(id)); };
        }
        catch (Exception ex) { box.Items.Add(new ComboBoxItem { Content = "无法列出输出设备：" + ex.Message }); }
    }
}
