using CreeperUX.Music.Controls;
using CreeperUX.Music.Core;
using CreeperUX.Music.Playback;
using CreeperUX.Music.Services;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Automation.Peers;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;

namespace CreeperUX.Music.Pages;

/// <summary>Search. Empty: one tile per genre. With words: the top result, songs, then artists, albums and playlists.</summary>
public sealed class SearchPage : View
{
    private readonly string _query;
    public override string Title => _query.Length > 0 ? $"搜索：{_query}" : "搜索";

    public SearchPage(MusicService music, IShell shell, string query) : base(music, shell)
    {
        _query = query.Trim();
        var (_, body, tint) = Scaffold();
        tint.Background = Ui.Tint(Ui.Rgb(0x2b, 0x34, 0x39));
        if (_query.Length == 0) { Browse(body); return; }
        var status = Ui.Text("正在搜索…", "MutedTextStyle");
        body.Children.Add(status);
        _ = Results(body, status);
    }

    private void Browse(StackPanel body)
    {
        var heading = Ui.Text("浏览全部", "PageTitleStyle");
        AutomationProperties.SetHeadingLevel(heading, AutomationHeadingLevel.Level1);
        body.Children.Add(heading);
        body.Children.Add(Ui.Row(8, Ui.Icon(Glyphs.Info, 14), Ui.Text("在媒体库中搜索标题、艺人和专辑。", "MutedTextStyle")));
        var wrap = new VariableSizedWrapGrid { Orientation = Orientation.Horizontal, ItemWidth = 200, ItemHeight = 120 };
        var genres = Music.Library.Albums.GroupBy(a => a.Genre).OrderByDescending(g => g.Count());
        foreach (var g in genres)
        {
            var tile = new Button
            {
                Width = 188, Height = 108, CornerRadius = new CornerRadius(8), Padding = new Thickness(14), BorderThickness = new Thickness(0),
                Background = new SolidColorBrush(Ui.Shade(ColorFor(g.Key), -0.2)), HorizontalContentAlignment = HorizontalAlignment.Left, VerticalContentAlignment = VerticalAlignment.Top,
            };
            var grid = new Grid { Width = 160, Height = 80 };
            var name = Ui.Text(g.Key, size: 18, foreground: new SolidColorBrush(Microsoft.UI.Colors.White), bold: true);
            var art = new Artwork(64, false, Glyphs.Album, 4) { Url = Music.CoverUrl(g.First().Id, 128), HorizontalAlignment = HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Bottom, Margin = new Thickness(0, 0, -22, -24) };
            art.RenderTransform = new RotateTransform { Angle = 25 };
            grid.Children.Add(art); grid.Children.Add(name);
            tile.Content = grid;
            AutomationProperties.SetName(tile, g.Key);
            tile.Click += (_, _) => Shell.Navigate($"genre:{g.Key}");
            wrap.Children.Add(tile);
            _ = Recolor(tile, g.First().Id);
        }
        AutomationProperties.SetName(wrap, "按流派浏览");
        body.Children.Add(wrap);
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

    private async Task Results(StackPanel body, TextBlock status)
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
            else if (kind == "track") host.Children.Add(new TrackList(Music, Shell, "search", _query, r.Tracks, covers: true, label: "歌曲"));
            else host.Children.Add(Cards.Grid(Music, Shell, (kind == "artist" ? r.Artists : kind == "album" ? r.Albums : playlists).Select(id => new CardRef(kind, id))));
        }
        chips.Changed += Render;
        Render(null);
    }

    private FrameworkElement TopResult(CardRef best)
    {
        var (title, subtitle, cover, circle, glyph) = Cards.Describe(Music, best);
        var card = new Grid { Background = Ui.Brush("HoverBrush"), CornerRadius = new CornerRadius(8), Padding = new Thickness(20), MinHeight = 220 };
        var art = new Artwork(96, circle, glyph, 6) { Url = cover };
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
        var (_, body, tint) = Scaffold();
        if (kind == "genre")
        {
            _title = id;
            var albums = music.Library.Albums.Where(a => a.Genre == id).ToList();
            TintFrom(tint, albums.FirstOrDefault()?.Id);
            var ids = music.Library.Tracks.Where(t => t.Genre == id).OrderByDescending(t => t.PlayCount).Select(t => t.Id).ToList();
            body.Children.Add(Hero.Build("流派", id, [Hero.Fact($"{albums.Count} 张专辑"), Hero.Fact(Formats.Songs(ids.Count))], null));
            body.Children.Add(Hero.Actions(music, "genre", id, id, null, sync => On(() => music.PlayerChanged += sync, () => music.PlayerChanged -= sync)));
            body.Children.Add(Cards.Shelf(music, shell, "专辑", albums.Select(a => new CardRef("album", a.Id)).ToList(), limit: 50));
            body.Children.Add(Ui.Text("歌曲", "SectionTitleStyle"));
            body.Children.Add(new TrackList(music, shell, "genre", id, ids, covers: true, label: $"{id} 的歌曲"));
            return;
        }
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
        _lines.Children.Clear();
        if (t is null) { _lines.Children.Add(Ui.Text("没有正在播放的歌曲", "PageTitleStyle")); return; }
        try { _lyrics = await Music.LyricsAsync(t); } catch (Exception ex) { Log.Write($"lyrics: {ex.Message}"); }
        if (_for != t.Id) return;
        if (_lyrics is not { Count: > 0 }) { _lines.Children.Add(Ui.Text("这首歌没有歌词", "PageTitleStyle")); return; }
        foreach (var l in _lyrics)
        {
            var line = new Button
            {
                Content = new TextBlock { Text = l.Text.Length > 0 ? l.Text : "♪", FontSize = 28, FontWeight = Microsoft.UI.Text.FontWeights.Bold, TextWrapping = TextWrapping.Wrap, FontFamily = (FontFamily)Application.Current.Resources["AppDisplayFont"] },
                Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent), BorderThickness = new Thickness(0), Padding = new Thickness(0), Foreground = Ui.Brush("TextTertiaryBrush"),
            };
            AutomationProperties.SetName(line, l.Text.Length > 0 ? l.Text : "间奏");
            if (l.Time is { } time) line.Click += (_, _) => Music.Seek(time);
            _lines.Children.Add(line);
        }
        Follow(Music.Position);
    }

    private void Follow(double position)
    {
        if (_lyrics is null || _lyrics.Count == 0) return;
        int at = LyricsParser.CurrentLine(_lyrics, position);
        if (at == _current) return;
        _current = at;
        for (int i = 0; i < _lines.Children.Count; i++)
            if (_lines.Children[i] is Button b) b.Foreground = i == at ? Ui.Brush("TextPrimaryBrush") : i < at ? Ui.Brush("TextSecondaryBrush") : Ui.Brush("TextTertiaryBrush");
        if (at >= 0 && _lines.Children[at] is FrameworkElement el)
        {
            _scroller.UpdateLayout();
            var p = el.TransformToVisual(_lines).TransformPoint(new Windows.Foundation.Point(0, 0));
            _scroller.ChangeView(null, Math.Max(0, p.Y - _scroller.ViewportHeight / 3), null);
        }
    }
}

/// <summary>Settings: playback, the output device, the account, keyboard shortcuts, about.</summary>
public sealed class SettingsPage : View
{
    public override string Title => "设置";

    public SettingsPage(MusicService music, IShell shell, Func<Task> signOut) : base(music, shell)
    {
        var (_, body, _) = Scaffold(32);
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

        var play = Section("播放");
        var order = new RadioButtons { Header = "播放顺序", MaxColumns = 4 };
        foreach (var o in Enum.GetValues<PlaybackOrder>()) order.Items.Add(new RadioButton { Content = Formats.Order(o), Tag = o });
        order.SelectedIndex = (int)music.Queue.Order;
        order.SelectionChanged += (_, _) => { if (order.SelectedItem is RadioButton { Tag: PlaybackOrder o } && o != music.Queue.Order) music.SetOrder(o); };
        play.Children.Add(order);
        var stop = new ToggleSwitch { Header = "播完当前歌曲后停止", IsOn = music.Queue.StopAfterCurrent };
        stop.Toggled += (_, _) => music.SetStopAfterCurrent(stop.IsOn);
        play.Children.Add(stop);
        var rg = new RadioButtons { Header = "回放增益", MaxColumns = 3 };
        foreach (var (mode, label) in new[] { (ReplayGainMode.Album, "按专辑"), (ReplayGainMode.Track, "按音轨"), (ReplayGainMode.Off, "不使用") }) rg.Items.Add(new RadioButton { Content = label, Tag = mode });
        rg.SelectedIndex = music.ReplayGain switch { ReplayGainMode.Album => 0, ReplayGainMode.Track => 1, _ => 2 };
        rg.SelectionChanged += (_, _) => { if (rg.SelectedItem is RadioButton { Tag: ReplayGainMode m }) music.SetReplayGain(m); };
        play.Children.Add(rg);
        var rgNote = Ui.Text("回放增益只降低音量，不会提高（Windows 播放器的音量上限是 100%）。", "MutedTextStyle"); rgNote.TextWrapping = TextWrapping.Wrap;
        play.Children.Add(rgNote);
        void SyncPlay() { order.SelectedIndex = (int)music.Queue.Order; stop.IsOn = music.Queue.StopAfterCurrent; }
        On(() => music.PlayerChanged += SyncPlay, () => music.PlayerChanged -= SyncPlay);

        var output = Section("输出设备", "这台电脑上的音频输出设备。选“系统默认设备”时跟随 Windows 的设置。");
        var devices = new ComboBox { Header = "输出设备", MinWidth = 360 };
        output.Children.Add(devices);
        _ = FillDevices(devices);

        var acc = Section("账号", "歌单、喜欢、播放次数和“接着听”的队列都保存在这个服务器上，所有设备共用。");
        acc.Children.Add(Fact("服务器", music.Client.Login.Server));
        acc.Children.Add(Fact("用户", music.Client.Login.User));
        acc.Children.Add(Fact("本机名称", music.Client.ClientName));
        acc.Children.Add(Fact("登录信息保存在", "Windows 凭据管理器（只有令牌，没有密码）"));
        var signOutButton = new Button { Content = Ui.Row(8, Ui.Icon(Glyphs.SignOut, 14), Ui.Text("退出登录")), Style = Ui.Style("PillButtonStyle") };
        AutomationProperties.SetName(signOutButton, "退出登录");
        signOutButton.Click += async (_, _) => await signOut();
        acc.Children.Add(signOutButton);

        var keys = Section("键盘快捷键");
        foreach (var (k, what) in new[] { ("空格", "播放 / 暂停"), ("Ctrl + →  /  Ctrl + ←", "下一首 / 上一首"), ("Ctrl + ↑  /  Ctrl + ↓", "音量"), ("Ctrl + K  或  /", "搜索"), ("Alt + ←", "后退"), ("Alt + Shift + B", "喜欢正在播放的歌曲"), ("媒体键", "播放、暂停、上一首、下一首") })
            keys.Children.Add(Fact(k, what));

        var about = Section("关于");
        about.Children.Add(Fact("程序", $"CreeperUX Music {typeof(App).Assembly.GetName().Version?.ToString(3)} · WinUI 3"));
        about.Children.Add(Fact("服务器", music.Server.Version));
        about.Children.Add(Fact("协议", $"Subsonic API {music.Server.ApiVersion}{(music.Server.OpenSubsonic ? " + OpenSubsonic" : "")}"));
        about.Children.Add(Fact("数据目录", AppPaths.DataDirectory));
        var note = Ui.Text("媒体库文件夹、转码、用户和 Last.fm 在 Navidrome 自己的网页里设置。", "MutedTextStyle"); note.TextWrapping = TextWrapping.Wrap;
        about.Children.Add(note);
    }

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
