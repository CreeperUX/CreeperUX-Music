using CreeperUX.Music.Controls;
using CreeperUX.Music.Core;
using CreeperUX.Music.Services;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Automation.Peers;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;

namespace CreeperUX.Music.Pages;

/// <summary>Home: a greeting, quick tiles for what played lately, then shelves from the server's play counts and dates.</summary>
public sealed class HomePage : View
{
    public override string Title => "首页";

    public HomePage(MusicService music, IShell shell) : base(music, shell)
    {
        var (_, body, tint) = Scaffold();
        var col = HomeShelves.From(music.Library, music.Playlists);
        TintFrom(tint, col.Recent.FirstOrDefault()?.Id ?? music.Library.Albums.FirstOrDefault()?.Id);
        var chips = new Chips("视图", [("album", "专辑"), ("playlist", "歌单"), ("artist", "艺人")]);
        body.Children.Add(chips);
        var greeting = Ui.Text(Formats.Greeting(DateTime.Now), "PageTitleStyle");
        AutomationProperties.SetHeadingLevel(greeting, AutomationHeadingLevel.Level1);
        body.Children.Add(greeting);

        // quick tiles: liked songs, then the latest albums and playlists
        var quick = new Grid { ColumnSpacing = 8, RowSpacing = 8 };
        var refs = new List<CardRef> { new("playlist", "liked") };
        refs.AddRange(col.Recent.Take(3));
        refs.AddRange(col.Playlists.Where(p => p.Id is not "liked").Take(2));
        refs.AddRange(col.Recent.Skip(3).Take(5));
        foreach (var r in refs.Take(8)) quick.Children.Add(QuickTile(r));
        int columns = 0;
        void Arrange(double width)
        {
            int n = width >= 1100 ? 4 : width >= 560 ? 2 : 1;
            if (n == columns) return;
            columns = n;
            quick.ColumnDefinitions.Clear(); quick.RowDefinitions.Clear();
            for (int c = 0; c < n; c++) quick.ColumnDefinitions.Add(new ColumnDefinition());
            for (int r = 0; r < (quick.Children.Count + n - 1) / n; r++) quick.RowDefinitions.Add(new RowDefinition { Height = new GridLength(64) });
            for (int i = 0; i < quick.Children.Count; i++) { Grid.SetColumn((FrameworkElement)quick.Children[i], i % n); Grid.SetRow((FrameworkElement)quick.Children[i], i / n); }
        }
        quick.SizeChanged += (_, e) => Arrange(e.NewSize.Width);
        Arrange(900);
        AutomationProperties.SetName(quick, "快捷入口");
        body.Children.Add(quick);

        var shelves = new StackPanel { Spacing = 28 };
        body.Children.Add(shelves);
        void Render(string? filter)
        {
            shelves.Children.Clear();
            bool Want(string type) => filter is null || filter == type;
            if (Want("album")) shelves.Children.Add(Cards.Shelf(music, shell, "最近播放", col.Recent, "shelf:recent"));
            if (Want("playlist")) shelves.Children.Add(Cards.Shelf(music, shell, "你的歌单", col.Playlists, "shelf:playlists"));
            if (Want("artist")) shelves.Children.Add(Cards.Shelf(music, shell, "你常听的艺人", col.TopArtists, "shelf:artists"));
            if (Want("album")) shelves.Children.Add(Cards.Shelf(music, shell, "高解析度收藏", col.HiRes, "shelf:hires"));
            if (Want("album")) shelves.Children.Add(Cards.Shelf(music, shell, "最近添加到媒体库", col.Added, "shelf:added"));
            if (Want("album")) shelves.Children.Add(Cards.Shelf(music, shell, "很久没听了", col.Forgotten, "shelf:forgotten"));
        }
        chips.Changed += Render;
        Render(null);
    }

    private FrameworkElement QuickTile(CardRef r)
    {
        var (title, _, cover, _, glyph) = Cards.Describe(Music, r);
        var art = new Artwork(64, false, glyph, 0) { Url = cover };
        if (r.Type == "playlist") Cards.Decorate(art, Music.Playlist(r.Id));
        var name = Ui.Text(title, "CardTitleStyle");
        name.VerticalAlignment = VerticalAlignment.Center;
        var play = Ui.PlayButton($"播放 {title}", (_, _) => Music.TogglePlayContext(r.Type, r.Id), 36);
        play.Margin = new Thickness(0, 0, 12, 0);
        // foobar2k's quick tiles: the text colour at 9 %, 17 % under the pointer
        var g = new Grid { Background = Ui.Brush("SurfaceBrush"), CornerRadius = new CornerRadius(6), ColumnSpacing = 12 };
        Motion.BrushFade(g);
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        g.ColumnDefinitions.Add(new ColumnDefinition());
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var open = new Button { Content = name, Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent), BorderThickness = new Thickness(0), HorizontalAlignment = HorizontalAlignment.Stretch, VerticalAlignment = VerticalAlignment.Stretch, HorizontalContentAlignment = HorizontalAlignment.Left, Padding = new Thickness(0) };
        AutomationProperties.SetName(open, title);
        open.Click += (_, _) => Shell.Navigate(Cards.RouteOf(r));
        g.Children.Add(art);
        Grid.SetColumn(open, 1); g.Children.Add(open);
        Grid.SetColumn(play, 2); g.Children.Add(play);
        bool hover = false;
        void Sync()
        {
            bool current = Music.IsContext(r.Type, r.Id);
            Ui.SetPlaying(play, Music.IsContextPlaying(r.Type, r.Id), title);
            name.Foreground = current ? Ui.Brush("AccentTextBrush") : Ui.Brush("TextPrimaryBrush");
            g.Background = hover || play.FocusState != FocusState.Unfocused ? Ui.Brush("SurfaceHoverBrush") : Ui.Brush("SurfaceBrush");
            Motion.Reveal(play, hover || current || play.FocusState != FocusState.Unfocused);
        }
        g.PointerEntered += (_, _) => { hover = true; Sync(); };
        g.PointerExited += (_, _) => { hover = false; Sync(); };
        play.GotFocus += (_, _) => Sync(); play.LostFocus += (_, _) => Sync();
        Sync();
        On(() => Music.PlayerChanged += Sync, () => Music.PlayerChanged -= Sync);
        return g;
    }
}

/// <summary>An album: its cover and facts, Play / Shuffle, the songs by disc and number, the label.</summary>
public sealed class AlbumPage : View
{
    private readonly string _title = "";
    public override string Title => _title;

    public AlbumPage(MusicService music, IShell shell, string id) : base(music, shell)
    {
        if (music.Library.Album(id) is not { } a) { Scaffold().Body.Children.Add(Ui.Text("找不到这张专辑。", "SectionTitleStyle")); return; }
        var (body, tint) = ListScaffold();
        _title = a.Title;
        TintFrom(tint, a.Id);
        double total = a.TrackIds.Sum(t => music.Library.Track(t)?.Duration ?? 0);
        var artist = Ui.Link(a.Artist, () => shell.Navigate($"artist:{a.ArtistId}"), 13, Ui.Brush("TextPrimaryBrush"), bold: true);
        body.Children.Add(Hero.Build(Formats.AlbumType(a.Type), a.Title, [artist, Hero.Fact(a.Year.ToString()), Hero.Fact($"{Formats.Songs(a.TrackIds.Count)}，{Formats.LongDuration(total)}")],
            new Artwork(220, false, Glyphs.Album, 8) { Url = music.CoverUrl(a.Id, 600) }));
        var first = music.Library.Track(a.TrackIds.FirstOrDefault());
        var more = new MenuFlyout();
        more.Items.Add(Ui.Item("加入播放队列", Glyphs.Queue, () => { music.QueueAdd(a.TrackIds); shell.ShowToast(new($"已将 {a.TrackIds.Count} 首加入播放队列")); }));
        more.Items.Add(Ui.Item("查看艺人", Glyphs.Artist, () => shell.Navigate($"artist:{a.ArtistId}")));
        body.Children.Add(Hero.Actions(music, "album", a.Id, a.Title, more, sync => On(() => music.PlayerChanged += sync, () => music.PlayerChanged -= sync)));
        if (first is not null) body.Children.Add(Ui.Text(Formats.Quality(first) + (first.IsHiRes ? " · Hi-Res" : ""), "FigureTextStyle"));
        TextBlock? label = null;
        if (a.Label.Length > 0 || a.Year > 0)
        {
            label = Ui.Text($"{(a.Year > 0 ? $"发行于 {a.Year} 年" : "")}{(a.Label.Length > 0 ? $"  ©  {a.Label}" : "")}", "MutedTextStyle");
            label.Margin = new Thickness(0, 18, 0, 0);
        }
        ShowList(new TrackList(music, shell, "album", a.Id, a.TrackIds, showAlbum: false, label: $"{a.Title} 的歌曲"), body, tint, label);
    }
}

/// <summary>A playlist: liked songs, the whole library, one of yours (rename, delete, drag to reorder) or one you can only play.</summary>
public sealed class PlaylistPage : View
{
    private readonly string _title = "";
    public override string Title => _title;

    public PlaylistPage(MusicService music, IShell shell, string id) : base(music, shell)
    {
        if (music.Playlist(id) is not { } p) { Scaffold().Body.Children.Add(Ui.Text("找不到这个歌单。", "SectionTitleStyle")); return; }
        var (body, tint) = ListScaffold();
        _title = p.Name;
        var ids = p.TrackIds;
        if (p.Kind == PlaylistKind.Liked) tint.Background = Ui.Tint(Ui.Rgb(0x8a, 0x62, 0x00)); // the special covers' colours
        else if (p.Kind == PlaylistKind.Library) tint.Background = Ui.Tint(Ui.Rgb(0x3c, 0x4f, 0x59));
        else TintFrom(tint, music.Library.Track(ids.FirstOrDefault())?.AlbumId);
        var art = new Artwork(220, false, Glyphs.Playlist, 8) { Url = Cards.PlaylistCover(music, p) };
        Cards.Decorate(art, p);
        string kind = p.Kind switch { PlaylistKind.Library => "媒体库", PlaylistKind.ReadOnly => "歌单（只读）", _ => "歌单" };
        // "12 首歌曲，约 48 分钟"; an empty playlist has no length
        string Size(IReadOnlyList<string> songs) => songs.Count == 0 ? Formats.Songs(0) : $"{Formats.Songs(songs.Count)}，{Formats.LongDuration(songs.Sum(t => music.Library.Track(t)?.Duration ?? 0))}";
        var size = Hero.Fact(Size(ids));
        body.Children.Add(Hero.Build(kind, p.Name, [Hero.Fact(p.Owner, strong: true), size], art,
            p.Comment ?? (p.Kind == PlaylistKind.ReadOnly ? $"{p.Owner} 的歌单，只能播放。" : null)));
        MenuFlyout? more = null;
        if (p.IsEditable)
        {
            more = new MenuFlyout();
            more.Items.Add(Ui.Item("重命名", Glyphs.Edit, () => _ = Rename(p)));
            more.Items.Add(Ui.Item("删除歌单", Glyphs.Delete, () => _ = Delete(p)));
        }
        body.Children.Add(Hero.Actions(music, "playlist", p.Id, p.Name, more, sync => On(() => music.PlayerChanged += sync, () => music.PlayerChanged -= sync)));
        var empty = Ui.Column(6, Ui.Text("这个歌单还是空的", "SectionTitleStyle"), Ui.Text("在任意歌曲的“更多选项”里选择“加入歌单”。", "MutedTextStyle"));
        var list = new TrackList(music, shell, "playlist", p.Id, ids, covers: true, reorderable: p.IsEditable, label: $"{p.Name} 的歌曲") { PlaylistId = p.Kind is PlaylistKind.User or PlaylistKind.Liked ? p.Id : null };
        list.Reordered += (moved, before) => _ = shell.Run(() => music.ReorderPlaylistAsync(p.Id, list.Ids, moved, before));
        empty.Visibility = list.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
        body.Children.Add(empty);
        ShowList(list, body, tint);
        void Sync()
        {
            if (music.Playlist(id) is not { } now) return;
            list.SetIds(now.TrackIds);
            size.Text = Size(now.TrackIds);
            empty.Visibility = list.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
        }
        On(() => music.PlaylistsChanged += Sync, () => music.PlaylistsChanged -= Sync);
    }

    private async Task Rename(Playlist p)
    {
        if (await Shell.AskText("重命名歌单", "名称", p.Name) is { Length: > 0 } name && name != p.Name) await Shell.Run(() => Music.RenamePlaylistAsync(p.Id, name));
    }

    private async Task Delete(Playlist p)
    {
        if (!await Shell.Confirm($"删除“{p.Name}”？", "只删除这个歌单，媒体库里的歌曲不受影响。", "删除")) return;
        await Shell.Run(async () => { await Music.DeletePlaylistAsync(p.Id); Shell.ShowToast(new($"已删除“{p.Name}”")); Shell.Navigate("home"); });
    }
}

/// <summary>An artist: Play / Shuffle, the most played songs, the releases (with a filter), the biography, similar artists.</summary>
public sealed class ArtistPage : View
{
    private readonly string _title = "";
    public override string Title => _title;

    public ArtistPage(MusicService music, IShell shell, string id) : base(music, shell)
    {
        var (_, body, tint) = Scaffold();
        if (music.Library.Artist(id) is not { } a) { body.Children.Add(Ui.Text("找不到这位艺人。", "SectionTitleStyle")); return; }
        _title = a.Name;
        var albums = a.AlbumIds.Select(music.Library.Album).OfType<Album>().OrderByDescending(x => x.Year).ToList();
        TintFrom(tint, albums.FirstOrDefault()?.Id);
        var ids = albums.SelectMany(x => x.TrackIds).ToList();
        int plays = ids.Sum(t => music.Library.Track(t)?.PlayCount ?? 0);
        body.Children.Add(Hero.Build($"艺人 · {a.Genre}", a.Name, [Hero.Fact($"{albums.Count} 张专辑"), Hero.Fact(Formats.Songs(ids.Count)), Hero.Fact(Formats.Plays(plays))],
            new Artwork(200, true, Glyphs.Artist) { Url = music.CoverUrl(albums.FirstOrDefault()?.Id, 600) }));
        var more = new MenuFlyout();
        more.Items.Add(Ui.Item("加入播放队列", Glyphs.Queue, () => { music.QueueAdd(ids); shell.ShowToast(new($"已将 {ids.Count} 首加入播放队列")); }));
        body.Children.Add(Hero.Actions(music, "artist", a.Id, a.Name, more, sync => On(() => music.PlayerChanged += sync, () => music.PlayerChanged -= sync)));

        var top = ids.OrderByDescending(t => music.Library.Track(t)?.PlayCount ?? 0).ToList();
        body.Children.Add(Ui.Text("热门", "SectionTitleStyle"));
        var popular = new TrackList(music, shell, "artist-popular", a.Id, top.Take(5).ToList(), covers: true, contextIds: () => top, label: "热门歌曲", header: false);
        body.Children.Add(popular);
        if (top.Count > 5)
        {
            bool expanded = false;
            var toggle = Ui.Link("显示更多", () => { }, 13, Ui.Brush("TextSecondaryBrush"), bold: true);
            toggle.Click += (_, _) => { expanded = !expanded; popular.SetIds(top.Take(expanded ? 10 : 5).ToList()); ((TextBlock)toggle.Content).Text = expanded ? "收起" : "显示更多"; };
            body.Children.Add(toggle);
        }

        body.Children.Add(Ui.Text("唱片", "SectionTitleStyle"));
        var host = new ContentControl { HorizontalContentAlignment = HorizontalAlignment.Stretch, IsTabStop = false };
        void Releases(string? filter) => host.Content = Cards.Grid(music, shell, albums.Where(x => filter is null || (filter == "album" ? x.Type == AlbumType.Album : x.Type != AlbumType.Album)).Select(x => new CardRef("album", x.Id)));
        if (albums.Any(x => x.Type != AlbumType.Album))
        {
            var chips = new Chips("唱片", [("album", "专辑"), ("single", "单曲和 EP")]);
            chips.Changed += Releases;
            body.Children.Add(chips);
        }
        body.Children.Add(host);
        Releases(null);

        var bio = new StackPanel { Spacing = 8, Visibility = Visibility.Collapsed, MaxWidth = 760, HorizontalAlignment = HorizontalAlignment.Left };
        body.Children.Add(bio);
        _ = LoadBio(a.Id, bio);

        var related = music.Library.Artists.Where(x => x.Id != a.Id && x.AlbumIds.Count > 0).OrderBy(x => x.Genre == a.Genre ? 0 : 1).Take(8).Select(x => new CardRef("artist", x.Id)).ToList();
        body.Children.Add(Cards.Shelf(music, shell, "同流派艺人", related));
    }

    private async Task LoadBio(string id, StackPanel box)
    {
        try
        {
            if (await Music.ArtistInfoAsync(id) is not { Biography.Length: > 0 } info) return;
            box.Children.Add(Ui.Text("简介", "SectionTitleStyle"));
            var text = Ui.Text(info.Biography, "MutedTextStyle");
            text.TextWrapping = TextWrapping.Wrap; text.MaxLines = 6; text.LineHeight = 22;
            box.Children.Add(text);
            if (info.Url is { } url)
            {
                var link = new HyperlinkButton { Content = "在 Last.fm 上阅读全文", NavigateUri = new Uri(url), Padding = new Thickness(0) };
                box.Children.Add(link);
            }
            box.Visibility = Visibility.Visible;
        }
        catch (Exception ex) { Log.Write($"artist info: {ex.Message}"); }
    }
}
