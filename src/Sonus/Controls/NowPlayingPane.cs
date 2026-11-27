using Sonus.Core;
using Sonus.Services;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Hosting;
using Microsoft.UI.Xaml.Media;

namespace Sonus.Controls;

/// <summary>The right-hand panel: Now playing (cover, title, a lyrics card, audio facts, the artist, what comes next), the
/// Queue (hand-queued songs, then the rest of what is playing), or the devices (Sonus Connect, as Spotify's Connect
/// panel: DevicesView).</summary>
public sealed class NowPlayingPane : UserControl
{
    private readonly MusicService _music;
    private readonly IShell _shell;
    private readonly ConnectService _connect;
    private readonly SessionService? _session;
    private DevicesView? _devices;
    private readonly TextBlock _heading = Ui.Text("正在播放", size: 15, foreground: Ui.Brush("TextPrimaryBrush"), bold: true);
    // Sonus Connect version 2: where the session played last, when no device plays it
    private readonly TextBlock _whereLine = Ui.Text("", size: 12, foreground: Ui.Brush("AccentTextBrush"));
    private readonly StackPanel _titles;
    private readonly ContentControl _body = new() { HorizontalContentAlignment = HorizontalAlignment.Stretch, VerticalContentAlignment = VerticalAlignment.Stretch, IsTabStop = false };
    // the devices' sheet: opaque, the panel's colour and bottom corners, over the body
    private readonly Border _sheet = new() { Background = Ui.Brush("PanelBrush"), CornerRadius = new CornerRadius(0, 0, 8, 8), Visibility = Visibility.Collapsed };
    private const float SheetRise = 48; // px the devices' sheet rises as it comes and sinks as it goes
    private bool _sheetLeaving;
    private int _sheetMoves;
    private string _mode = "now";
    private string? _shownTrack;
    private IReadOnlyList<LyricLine>? _lyrics;
    private StackPanel? _lyricLines;
    private ScrollViewer? _lyricScroll;
    private int _lyricAt = -2, _lyricLoad;

    public NowPlayingPane(MusicService music, IShell shell, ConnectService connect, SessionService? session)
    {
        _music = music; _shell = shell; _connect = connect; _session = session;
        // the same head as the library's: a 36 px line 12 px down (so both titles sit on one line), the button 16 px in
        var head = new Grid { Padding = new Thickness(16, 12, 16, 8), MinHeight = 56 };
        _titles = Ui.Column(0, _heading, _whereLine);
        _titles.VerticalAlignment = VerticalAlignment.Center;
        _whereLine.Visibility = Visibility.Collapsed;
        head.Children.Add(_titles);
        var close = Ui.IconButton(Glyphs.Close, "关闭右侧面板", (_, _) => CloseRequested?.Invoke(), 32, 12);
        close.HorizontalAlignment = HorizontalAlignment.Right; close.VerticalAlignment = VerticalAlignment.Center;
        close.Resources["ButtonForegroundPointerOver"] = Ui.Brush("TextPrimaryBrush");
        head.Children.Add(close);
        var root = new Grid();
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        root.RowDefinitions.Add(new RowDefinition());
        root.Children.Add(head);
        // the devices are a sheet over the rest (Spotify's Connect menu): it rises from the panel's bottom edge, toward the
        // bar's devices button, and sinks back into it; the body's area clips it
        var bodyArea = new Grid { Children = { _body, _sheet } };
        Grid.SetRow(bodyArea, 1); root.Children.Add(bodyArea);
        var area = ElementCompositionPreview.GetElementVisual(bodyArea);
        area.Clip = area.Compositor.CreateInsetClip();
        Content = root;
        music.PlayerChanged += () => { if (_mode == "now" && music.Queue.Current != _shownTrack) RenderNow(); else if (_mode == "queue") RenderQueue(); UpdateHeading(); };
        music.QueueChanged += () => { if (_mode == "queue") RenderQueue(); else RenderNext(); };
        music.TrackChanged += t => { if (_mode == "now" && t.Id == _shownTrack) RenderNow(force: true); };
        music.PositionChanged += FollowLyrics;
        RenderNow();
    }

    public event Action? CloseRequested;
    /// <summary>It shows something else now (now, queue, devices).</summary>
    public event Action? ModeChanged;
    public string Mode => _mode;

    /// <summary>Shows now playing, the queue or the devices. <paramref name="animate"/> false: the panel is coming in
    /// itself, and that is the motion.</summary>
    public void Show(string mode, bool animate = true)
    {
        string was = _mode;
        _mode = mode;
        animate &= was != mode;
        if (mode == "devices")
        {
            _devices ??= new DevicesView(_music, _connect, _session);
            _devices.Refresh(force: true);
            OpenSheet(animate);
        }
        else
        {
            if (mode == "queue") RenderQueue(animate); else RenderNow(force: true);
            if (was == "devices") CloseSheet(animate); // it sinks away from what is under it
            else if (animate) Motion.Enter(_body, rise: 14, move: TimeSpan.FromMilliseconds(240)); // now playing and the queue: one rises in where the other was
        }
        UpdateHeading();
        if (animate) Motion.Swap(_titles);
        ModeChanged?.Invoke();
    }

    /// <summary>The devices' sheet rises over the body and fades in (--cx-motion-sheet); once it is up, the body under it
    /// leaves the layout (nothing hidden is reachable).</summary>
    private void OpenSheet(bool animate)
    {
        int move = ++_sheetMoves;
        bool leaving = _sheetLeaving;
        _sheetLeaving = false;
        _sheet.Child ??= _devices; // in the window only while shown: it follows the devices then
        _sheet.Visibility = Visibility.Visible;
        _sheet.IsHitTestVisible = true;
        void Covered() { if (move == _sheetMoves) _body.Visibility = Visibility.Collapsed; }
        if (leaving) Motion.SlideBack(_sheet); // it was sinking: back up from there
        else if (animate) Motion.Enter(_sheet, rise: SheetRise, move: Motion.Sheet);
        else { Covered(); return; }
        if (Motion.Enabled) Motion.After(Motion.Sheet, Covered); else Covered();
    }

    /// <summary>The devices' sheet sinks and fades out (the exit curve), showing what is under it, then leaves.</summary>
    private void CloseSheet(bool animate)
    {
        int move = ++_sheetMoves;
        _body.Visibility = Visibility.Visible;
        void Gone() { if (move != _sheetMoves) return; _sheetLeaving = false; _sheet.Visibility = Visibility.Collapsed; _sheet.Child = null; }
        if (!animate || !Motion.Enabled) { Gone(); return; }
        _sheetLeaving = true;
        _sheet.IsHitTestVisible = false;
        Motion.SlideOut(_sheet, Gone, drop: SheetRise);
    }

    private void UpdateHeading()
    {
        _heading.Text = _mode switch { "queue" => "播放队列", "devices" => "连接到设备", _ => _music.Queue.Context?.Label is { Length: > 0 } l ? l : "正在播放" };
        // where it played last (where it plays now is the strip under the bar; the devices say it themselves)
        string? last = _mode != "devices" && _session?.ActiveElsewhere is null ? _music.Where : null;
        _whereLine.Text = last ?? "";
        _whereLine.Visibility = last is null ? Visibility.Collapsed : Visibility.Visible;
    }

    // ---------------------------------------------------------------- Now playing
    private StackPanel? _nextBox;

    private void RenderNow(bool force = false)
    {
        var t = _music.Current;
        if (!force && t?.Id == _shownTrack && _body.Content is not null) return;
        bool another = t?.Id != _shownTrack; // a new song comes in; the same one redrawn (liked, say) does not move
        _shownTrack = t?.Id;
        _lyrics = null; _lyricLines = null; _lyricAt = -2; CurrentLyric = null;
        if (t is null)
        {
            var icon = Ui.Icon(Glyphs.Music, 32, Ui.Brush("TextTertiaryBrush"));
            var heading = Ui.Text("还没有播放任何歌曲", size: 15, foreground: Ui.Brush("TextPrimaryBrush"), bold: true);
            heading.HorizontalAlignment = HorizontalAlignment.Center;
            var hint = Ui.Text("双击任意歌曲开始播放。", "MutedTextStyle");
            hint.HorizontalAlignment = HorizontalAlignment.Center;
            var empty = Ui.Column(8, icon, heading, hint);
            empty.HorizontalAlignment = HorizontalAlignment.Center;
            empty.VerticalAlignment = VerticalAlignment.Center;
            empty.Margin = new Thickness(24, 0, 24, 48);
            _body.Content = empty;
            return;
        }
        var body = new StackPanel { Spacing = 16, Padding = new Thickness(16, 0, 16, 24) };
        var artBox = new Viewbox { Child = new Grid { Width = 300, Height = 300, Children = { new Artwork(300, false, Glyphs.Album, 8) { Url = _music.CoverUrl(t.AlbumId, 600) } } }, Stretch = Stretch.Uniform };
        body.Children.Add(artBox);
        if (another) Motion.ScaleIn(artBox, 0.9f);

        var title = Ui.Link(t.Title, () => _shell.Navigate($"album:{t.AlbumId}"), 22, Ui.Brush("TextPrimaryBrush"), bold: true);
        var artist = Ui.Link(t.Artist, () => _shell.Navigate($"artist:{t.ArtistId}"), 14);
        Button? like = null;
        like = Ui.IconButton(t.Liked ? Glyphs.HeartFill : Glyphs.Heart, t.Liked ? "取消喜欢" : "喜欢", async (_, _) => { Motion.Pop(like!); await _shell.Run(() => _music.SetLikedAsync(t.Id, !t.Liked)); });
        like.Foreground = t.Liked ? Ui.Brush("AccentBrush") : Ui.Brush("TextSecondaryBrush");
        var titleRow = new Grid();
        titleRow.ColumnDefinitions.Add(new ColumnDefinition());
        titleRow.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        titleRow.Children.Add(Ui.Column(0, title, artist));
        Grid.SetColumn(like, 1); titleRow.Children.Add(like);
        body.Children.Add(titleRow);

        // lyrics card: a few lines around the current one
        _lyricLines = new StackPanel { Spacing = 6 };
        _lyricScroll = new ScrollViewer { Content = _lyricLines, Height = 170, VerticalScrollBarVisibility = ScrollBarVisibility.Hidden };
        var full = Ui.IconButton(Glyphs.Expand, "全屏查看歌词", (_, _) => _shell.Navigate("lyrics"), 30, 12);
        body.Children.Add(Card("歌词", _lyricScroll, full));
        _ = LoadLyrics(t);

        var facts = new StackPanel { Spacing = 6 };
        void Fact(string k, string v, bool mono = false, bool quiet = false)
        {
            var g = new Grid(); g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(80) }); g.ColumnDefinitions.Add(new ColumnDefinition());
            g.Children.Add(Ui.Text(k, "MutedTextStyle"));
            var val = Ui.Text(v, mono ? "FigureTextStyle" : null, size: mono ? 12.5 : 13, foreground: Ui.Brush(quiet ? "TextSecondaryBrush" : "TextPrimaryBrush"));
            val.TextWrapping = TextWrapping.Wrap; Grid.SetColumn(val, 1); g.Children.Add(val); facts.Children.Add(g);
        }
        Fact("编码", t.Codec + (t.IsLossless ? "（无损）" : t.Codec.StartsWith("DSD", StringComparison.Ordinal) ? "" : "（有损）"));
        if (t.SampleRate > 0) Fact("采样率", t.SampleRate >= 1_000_000 ? $"{t.SampleRate / 1_000_000.0:0.###} MHz" : $"{t.SampleRate / 1000.0:0.#} kHz", mono: true);
        if (t.BitDepth > 1) Fact("位深", $"{t.BitDepth} bit", mono: true);
        if (t.Bitrate > 0) Fact("比特率", $"{t.Bitrate} kbps", mono: true);
        Fact("回放增益", t.TrackGain is null && t.AlbumGain is null ? "无" : $"音轨 {t.TrackGain:+0.00;-0.00} dB · 专辑 {t.AlbumGain:+0.00;-0.00} dB", mono: t.TrackGain is not null || t.AlbumGain is not null);
        if (t.Size > 0) Fact("文件大小", Formats.Size(t.Size), mono: true);
        Fact("播放次数", $"{t.PlayCount} 次 · 上次 {Formats.Relative(t.LastPlayed)}");
        if (t.Path.Length > 0) Fact("位置", t.Path, mono: true, quiet: true);
        body.Children.Add(Card("音频信息", facts, null));

        if (_music.Library.Artist(t.ArtistId) is { } a)
        {
            var artistBody = Ui.Row(12, new Artwork(56, true, Glyphs.Artist) { Url = _music.CoverUrl(a.AlbumIds.FirstOrDefault(), 128) },
                Ui.Column(2, Ui.Link(a.Name, () => _shell.Navigate($"artist:{a.Id}"), 15, Ui.Brush("TextPrimaryBrush"), bold: true), Ui.Text($"{a.Genre} · {a.AlbumIds.Count} 张专辑", "MutedTextStyle")));
            body.Children.Add(Card("关于艺人", artistBody, null));
        }

        _nextBox = new StackPanel();
        var openQueue = Ui.Link("打开播放队列", () => Show("queue"), 13);
        body.Children.Add(Card("接下来播放", _nextBox, openQueue));
        RenderNext();
        _body.Content = new ScrollViewer { Content = body, HorizontalScrollMode = ScrollMode.Disabled };
        if (another) Motion.Enter(body, rise: 8);
    }

    private void RenderNext()
    {
        if (_nextBox is null) return;
        _nextBox.Children.Clear();
        var next = _music.Library.Track(_music.Queue.Peek());
        if (next is null) { _nextBox.Children.Add(Ui.Text("队列里没有歌曲", "MutedTextStyle")); return; }
        _nextBox.Children.Add(Ui.Row(12, new Artwork(44, false) { Url = _music.CoverUrl(next.AlbumId, 96) }, Ui.Column(2, Ui.Text(next.Title, "CardTitleStyle"), Ui.Text(next.Artist, "MutedTextStyle"))));
    }

    private static Border Card(string title, UIElement content, UIElement? action)
    {
        var head = new Grid { Margin = new Thickness(0, 0, 0, 10) };
        head.Children.Add(Ui.Text(title, size: 15, foreground: Ui.Brush("TextPrimaryBrush"), bold: true));
        if (action is FrameworkElement a) { a.HorizontalAlignment = HorizontalAlignment.Right; a.VerticalAlignment = VerticalAlignment.Center; head.Children.Add(a); }
        var card = new Border { Background = Ui.Brush("RaisedBrush"), CornerRadius = new CornerRadius(8), Padding = new Thickness(16), Child = Ui.Column(0, head, content) };
        AutomationProperties.SetName(card, title);
        return card;
    }

    private async Task LoadLyrics(Track t)
    {
        int load = ++_lyricLoad;
        IReadOnlyList<LyricLine>? lyrics = null;
        try { lyrics = await _music.LyricsAsync(t); } catch (Exception ex) { Log.Write($"lyrics: {ex.Message}"); }
        if (load != _lyricLoad || _shownTrack != t.Id || _lyricLines is null) return; // a newer load (or another song) owns the card
        _lyrics = lyrics;
        _lyricAt = -2;
        _lyricLines.Children.Clear();
        if (_lyrics is not { Count: > 0 }) { _lyricLines.Children.Add(Ui.Text("这首歌没有歌词", "MutedTextStyle")); return; }
        foreach (var l in _lyrics)
        {
            var tb = Ui.Text(l.Text.Length > 0 ? l.Text : "♪", size: 15, foreground: Ui.Brush("TextPrimaryBrush"), bold: true);
            tb.TextWrapping = TextWrapping.Wrap;
            tb.Opacity = Dim;
            Motion.OpacityFade(tb);
            _lyricLines.Children.Add(tb);
        }
        FollowLyrics(_music.Position);
    }

    private void FollowLyrics(double position)
    {
        if (_lyrics is not { Count: > 0 } || _lyricLines is null || _lyricScroll is null) return;
        int at = LyricsParser.CurrentLine(_lyrics, position);
        if (at == _lyricAt) return;
        _lyricAt = at;
        for (int i = 0; i < _lyricLines.Children.Count; i++)
            if (_lyricLines.Children[i] is TextBlock tb) tb.Opacity = i == at ? 1 : Dim;
        CurrentLyric = at >= 0 && _lyricLines.Children[at] is TextBlock line ? line.Text : null;
        if (at >= 0 && _lyricLines.Children[at] is FrameworkElement el)
        {
            _lyricScroll.UpdateLayout(); // lines just added are not measured yet: scrolling to them would do nothing
            var p = el.TransformToVisual(_lyricLines).TransformPoint(new Windows.Foundation.Point(0, 0));
            _lyricScroll.ChangeView(null, Math.Max(0, p.Y - 50), null, disableAnimation: !Motion.Enabled);
        }
    }

    private const double Dim = 0.45; // lines that are not being sung

    /// <summary>The lyrics card's lit line (tests read it), or null.</summary>
    public string? CurrentLyric { get; private set; }

    // ---------------------------------------------------------------- Queue
    private void RenderQueue(bool animate = false)
    {
        var body = new StackPanel { Spacing = 8, Padding = new Thickness(8, 0, 8, 24) };
        int rowIndex = 0;
        void AddRow(Grid row) { if (animate && rowIndex < 8) Motion.Stagger(row, rowIndex, rise: 12); rowIndex++; body.Children.Add(row); }
        var current = _music.Current;
        if (current is not null)
        {
            body.Children.Add(Section("正在播放", null));
            AddRow(Row(current, null, playing: true));
        }
        var entries = _music.Queue.Entries;
        var manual = entries.Where(e => e.Manual).ToList();
        var rest = entries.Where(e => !e.Manual).Take(100).ToList();
        if (manual.Count > 0)
        {
            body.Children.Add(Section("接下来播放", () => _music.QueueClear(manual: true)));
            foreach (var e in manual) if (_music.Library.Track(e.TrackId) is { } t) AddRow(Row(t, e));
        }
        if (rest.Count > 0)
        {
            body.Children.Add(Section($"接下来：{_music.Queue.Context?.Label}", () => _music.QueueClear(manual: false)));
            foreach (var e in rest) if (_music.Library.Track(e.TrackId) is { } t) AddRow(Row(t, e));
        }
        if (current is null && entries.Count == 0) body.Children.Add(Ui.Text("队列里没有歌曲", "MutedTextStyle"));
        AutomationProperties.SetName(body, "播放队列");
        _body.Content = new ScrollViewer { Content = body, HorizontalScrollMode = ScrollMode.Disabled };
    }

    private static Grid Section(string title, Action? clear)
    {
        var g = new Grid { Padding = new Thickness(8, 12, 8, 4) };
        g.Children.Add(Ui.Text(title, size: 14, foreground: Ui.Brush("TextPrimaryBrush"), bold: true));
        if (clear is not null)
        {
            var b = Ui.Link("清除", clear, 13);
            AutomationProperties.SetName(b, $"清除{title}");
            b.HorizontalAlignment = HorizontalAlignment.Right;
            g.Children.Add(b);
        }
        return g;
    }

    private Grid Row(Track t, QueueEntry? entry, bool playing = false)
    {
        var g = new Grid { ColumnSpacing = 12, Padding = new Thickness(8, 4, 4, 4), CornerRadius = new CornerRadius(6), Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent) };
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        g.ColumnDefinitions.Add(new ColumnDefinition());
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        g.Children.Add(new Artwork(40, false) { Url = _music.CoverUrl(t.AlbumId, 96) });
        var title = Ui.Text(t.Title, "CardTitleStyle");
        if (playing) title.Foreground = Ui.Brush("AccentTextBrush");
        var text = Ui.Column(1, title, Ui.Text(t.Artist, "MutedTextStyle"));
        text.VerticalAlignment = VerticalAlignment.Center;
        Grid.SetColumn(text, 1); g.Children.Add(text);
        AutomationProperties.SetName(g, $"{t.Title} · {t.Artist}");
        if (entry is not null)
        {
            var remove = Ui.IconButton(Glyphs.Close, $"从队列中移除 {t.Title}", (_, _) => _music.QueueRemove([entry.Id]), 30, 11);
            Grid.SetColumn(remove, 2); g.Children.Add(remove);
            g.DoubleTapped += (_, _) => _music.QueueJump(entry.Id);
            Motion.BrushFade(g);
            g.PointerEntered += (_, _) => g.Background = Ui.Brush("HoverBrush");
            g.PointerExited += (_, _) => g.Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent);
            var menu = new MenuFlyout();
            menu.Items.Add(Ui.Item("立即播放", Glyphs.Play, () => _music.QueueJump(entry.Id)));
            menu.Items.Add(Ui.Item("从队列中移除", Glyphs.Delete, () => _music.QueueRemove([entry.Id])));
            g.ContextFlyout = menu;
        }
        return g;
    }
}
