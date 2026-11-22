using CreeperUX.Music.Core;
using CreeperUX.Music.Services;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;

namespace CreeperUX.Music.Controls;

/// <summary>"音乐库": liked songs and the library pinned on top, then playlists, albums and artists; filter, find and sort.
/// The playing context is marked. Collapses to a rail of covers.</summary>
public sealed class LibraryPane : UserControl
{
    private sealed record Entry(string Route, string Type, string Id, string Name, string Sub, string? Cover, Playlist? Playlist, bool Pinned, DateTimeOffset Recent, DateTimeOffset Added, string Creator);

    private readonly MusicService _music;
    private readonly IShell _shell;
    private readonly AppSettings _settings;
    private readonly StackPanel _items = new() { Spacing = 2 };
    private readonly TextBox _find = new() { PlaceholderText = "在音乐库中搜索", MinWidth = 0 };
    private readonly ComboBox _sort = new() { MinWidth = 120 };
    private readonly Chips _chips;
    private readonly StackPanel _tools;
    private readonly TextBlock _title;
    private bool _rail;

    public LibraryPane(MusicService music, IShell shell, AppSettings settings)
    {
        _music = music; _shell = shell; _settings = settings;
        var head = new Grid { Padding = new Thickness(16, 12, 8, 4) };
        _title = Ui.Text("音乐库", size: 16, foreground: Ui.Brush("TextSecondaryBrush"), bold: true);
        var titleButton = new Button { Content = Ui.Row(10, Ui.Icon(Glyphs.Library, 18), _title), Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent), BorderThickness = new Thickness(0), Padding = new Thickness(4) };
        AutomationProperties.SetName(titleButton, "收起或展开音乐库");
        ToolTipService.SetToolTip(titleButton, "收起或展开音乐库");
        titleButton.Click += (_, _) => SetRail(!_rail);
        var create = Ui.IconButton(Glyphs.Add, "新建歌单", async (_, _) => await shell.Run(async () =>
        {
            var p = await music.CreatePlaylistAsync($"我的歌单 #{music.Playlists.Count(x => x.Kind == PlaylistKind.User) + 1}", []);
            shell.Navigate($"playlist:{p.Id}");
        }), 32, 14);
        create.HorizontalAlignment = HorizontalAlignment.Right;
        head.Children.Add(titleButton); head.Children.Add(create);

        _chips = new Chips("筛选", [("playlist", "歌单"), ("album", "专辑"), ("artist", "艺人")], settings.LibraryFilter.Length > 0 ? settings.LibraryFilter : null) { Margin = new Thickness(16, 4, 16, 4) };
        _chips.Changed += v => { settings.LibraryFilter = v ?? ""; settings.Save(); Render(); };
        AutomationProperties.SetName(_find, "在音乐库中搜索");
        _find.TextChanged += (_, _) => Render();
        foreach (var (v, l) in new[] { ("recent", "最近播放"), ("added", "最近添加"), ("alpha", "字母顺序"), ("creator", "创作者") }) _sort.Items.Add(new ComboBoxItem { Content = l, Tag = v });
        _sort.SelectedIndex = Math.Max(0, new[] { "recent", "added", "alpha", "creator" }.ToList().IndexOf(settings.LibrarySort));
        AutomationProperties.SetName(_sort, "排序");
        _sort.SelectionChanged += (_, _) => { if (_sort.SelectedItem is ComboBoxItem { Tag: string s }) { settings.LibrarySort = s; settings.Save(); Render(); } };
        var findRow = new Grid { ColumnSpacing = 8, Margin = new Thickness(16, 4, 12, 6) };
        findRow.ColumnDefinitions.Add(new ColumnDefinition());
        findRow.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        findRow.Children.Add(_find); Grid.SetColumn(_sort, 1); findRow.Children.Add(_sort);
        _tools = Ui.Column(0, _chips, findRow);

        var scroller = new ScrollViewer { Content = _items, Padding = new Thickness(8, 0, 8, 8), HorizontalScrollMode = ScrollMode.Disabled };
        AutomationProperties.SetName(_items, "音乐库");
        var root = new Grid();
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        root.RowDefinitions.Add(new RowDefinition());
        root.Children.Add(head);
        Grid.SetRow(_tools, 1); root.Children.Add(_tools);
        Grid.SetRow(scroller, 2); root.Children.Add(scroller);
        Content = root;

        music.PlaylistsChanged += Render;
        music.LibraryChanged += Render;
        music.PlayerChanged += Mark;
        Render();
    }

    /// <summary>The rail changed: (rail, chosen by the user rather than by the window's width).</summary>
    public event Action<bool, bool>? RailChanged;
    public bool IsRail => _rail;

    public void SetRail(bool rail, bool byUser = true)
    {
        if (_rail == rail) return;
        _rail = rail;
        _tools.Visibility = rail ? Visibility.Collapsed : Visibility.Visible;
        _title.Visibility = rail ? Visibility.Collapsed : Visibility.Visible;
        RailChanged?.Invoke(rail, byUser);
        Render();
    }

    private IEnumerable<Entry> Entries()
    {
        var lib = _music.Library;
        var lastAlbum = new Dictionary<string, DateTimeOffset>(); var addedAlbum = new Dictionary<string, DateTimeOffset>(); var lastArtist = new Dictionary<string, DateTimeOffset>();
        foreach (var t in lib.Tracks)
        {
            if (t.LastPlayed is { } lp) { if (lp > lastAlbum.GetValueOrDefault(t.AlbumId)) lastAlbum[t.AlbumId] = lp; if (lp > lastArtist.GetValueOrDefault(t.ArtistId)) lastArtist[t.ArtistId] = lp; }
            if (t.Added is { } ad && ad > addedAlbum.GetValueOrDefault(t.AlbumId)) addedAlbum[t.AlbumId] = ad;
        }
        foreach (var p in _music.Playlists)
        {
            var recent = p.TrackIds.Take(50).Select(id => lib.Track(id)?.LastPlayed ?? DateTimeOffset.MinValue).DefaultIfEmpty(DateTimeOffset.MinValue).Max();
            string sub = p.Kind == PlaylistKind.Library ? $"媒体库 · {Formats.Songs(p.TrackIds.Count)}" : $"歌单 · {(p.Kind == PlaylistKind.ReadOnly ? p.Owner : Formats.Songs(p.TrackIds.Count))}";
            yield return new($"playlist:{p.Id}", "playlist", p.Id, p.Name, sub, Cards.PlaylistCover(_music, p), p, p.Kind is PlaylistKind.Liked or PlaylistKind.Library, recent > p.Changed ? recent : p.Changed, p.Changed, p.Owner);
        }
        foreach (var a in lib.Albums) yield return new($"album:{a.Id}", "album", a.Id, a.Title, $"专辑 · {a.Artist}", _music.CoverUrl(a.Id, 96), null, false, lastAlbum.GetValueOrDefault(a.Id), addedAlbum.GetValueOrDefault(a.Id), a.Artist);
        foreach (var a in lib.Artists.Where(a => a.AlbumIds.Count > 0)) yield return new($"artist:{a.Id}", "artist", a.Id, a.Name, "艺人", _music.CoverUrl(a.AlbumIds[0], 96), null, false, lastArtist.GetValueOrDefault(a.Id), DateTimeOffset.MinValue, a.Name);
    }

    private void Render()
    {
        _items.Children.Clear();
        string find = _find.Text.Trim();
        var list = Entries().Where(e => _chips.Value is null || e.Type == _chips.Value)
            .Where(e => find.Length == 0 || e.Name.Contains(find, StringComparison.CurrentCultureIgnoreCase) || e.Sub.Contains(find, StringComparison.CurrentCultureIgnoreCase));
        // pinned on top in a fixed order (liked songs, then the library), the rest sorted
        static int Pin(Entry e) => e.Playlist?.Kind == PlaylistKind.Liked ? 0 : e.Playlist?.Kind == PlaylistKind.Library ? 1 : 2;
        var pinned = list.OrderBy(Pin);
        list = _settings.LibrarySort switch
        {
            "added" => pinned.ThenByDescending(e => e.Added),
            "alpha" => pinned.ThenBy(e => e.Name, StringComparer.CurrentCulture),
            "creator" => pinned.ThenBy(e => e.Creator, StringComparer.CurrentCulture),
            _ => pinned.ThenByDescending(e => e.Recent),
        };
        foreach (var e in list.Take(400)) _items.Children.Add(Item(e));
        Mark();
    }

    private Button Item(Entry e)
    {
        var art = new Artwork(48, e.Type == "artist", e.Type == "artist" ? Glyphs.Artist : e.Type == "album" ? Glyphs.Album : Glyphs.Playlist, 4) { Url = e.Cover };
        Cards.Decorate(art, e.Playlist);
        var name = Ui.Text(e.Name, "CardTitleStyle");
        name.FontWeight = Microsoft.UI.Text.FontWeights.Normal;
        var text = Ui.Column(2, name, Ui.Text(e.Sub, "MutedTextStyle"));
        text.VerticalAlignment = VerticalAlignment.Center;
        var row = new Grid { ColumnSpacing = 12 };
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        row.ColumnDefinitions.Add(new ColumnDefinition());
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        row.Children.Add(art);
        Grid.SetColumn(text, 1); row.Children.Add(text);
        var playing = Ui.Icon(Glyphs.Volume, 14, Ui.Brush("AccentTextBrush"));
        playing.Visibility = Visibility.Collapsed; playing.VerticalAlignment = VerticalAlignment.Center;
        Grid.SetColumn(playing, 2); row.Children.Add(playing);
        if (_rail) { text.Visibility = Visibility.Collapsed; }
        var b = new Button
        {
            Content = row, Tag = (e, name, playing), Padding = new Thickness(8), HorizontalAlignment = HorizontalAlignment.Stretch, HorizontalContentAlignment = HorizontalAlignment.Stretch,
            Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent), BorderThickness = new Thickness(0), CornerRadius = new CornerRadius(6),
        };
        AutomationProperties.SetName(b, $"{e.Name}，{e.Sub}");
        ToolTipService.SetToolTip(b, e.Name);
        b.Click += (_, _) => _shell.Navigate(e.Route);
        var menu = new MenuFlyout();
        menu.Items.Add(Ui.Item("播放", Glyphs.Play, () => _music.PlayContext(e.Type, e.Id)));
        menu.Items.Add(Ui.Item("随机播放", Glyphs.Shuffle, () => _music.PlayContext(e.Type, e.Id, shuffle: true)));
        if (e.Playlist is { IsEditable: true } p)
        {
            menu.Items.Add(new MenuFlyoutSeparator());
            menu.Items.Add(Ui.Item("重命名", Glyphs.Edit, async () => { if (await _shell.AskText("重命名歌单", "名称", p.Name) is { Length: > 0 } n && n != p.Name) await _shell.Run(() => _music.RenamePlaylistAsync(p.Id, n)); }));
            menu.Items.Add(Ui.Item("删除歌单", Glyphs.Delete, async () => { if (await _shell.Confirm($"删除“{p.Name}”？", "只删除这个歌单，媒体库里的歌曲不受影响。", "删除")) await _shell.Run(() => _music.DeletePlaylistAsync(p.Id)); }));
        }
        b.ContextFlyout = menu;
        return b;
    }

    /// <summary>Marks the playing context: amber name and a speaker.</summary>
    private void Mark()
    {
        foreach (var b in _items.Children.OfType<Button>())
        {
            if (b.Tag is not ValueTuple<Entry, TextBlock, FontIcon> tag) continue;
            var (e, name, icon) = tag;
            bool current = _music.IsContext(e.Type, e.Id);
            name.Foreground = current ? Ui.Brush("AccentTextBrush") : Ui.Brush("TextPrimaryBrush");
            icon.Visibility = current && _music.IsActive && !_rail ? Visibility.Visible : Visibility.Collapsed;
        }
    }
}
