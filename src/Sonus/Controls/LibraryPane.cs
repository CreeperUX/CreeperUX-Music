using Sonus.Core;
using Sonus.Services;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;

namespace Sonus.Controls;

/// <summary>"音乐库": liked songs and the library pinned on top, then playlists, albums and artists; filter, find and sort.
/// The playing context is marked. Collapses to a rail of covers.</summary>
public sealed class LibraryPane : UserControl
{
    private sealed record Entry(string Route, string Type, string Id, string Name, string Sub, string? Cover, Playlist? Playlist, bool Pinned, DateTimeOffset Recent, DateTimeOffset Added, string Creator);

    private readonly MusicService _music;
    private readonly IShell _shell;
    private readonly AppSettings _settings;
    private readonly ItemsRepeater _items;
    private readonly HashSet<Button> _shown = []; // the items' buttons that exist now (those in view and around)
    private readonly TextBox _find = new() { PlaceholderText = "在音乐库中搜索", MinWidth = 0 };
    private readonly ComboBox _sort = new() { MinWidth = 120 };
    private readonly Chips _chips;
    private readonly StackPanel _tools;
    private readonly TextBlock _title;
    private bool _rail;
    private Grid? _head;
    private Button? _titleButton, _create;

    public LibraryPane(MusicService music, IShell shell, AppSettings settings)
    {
        _music = music; _shell = shell; _settings = settings;
        // only the items in view (and a screen or so around) are built: a library can have thousands of albums
        _items = Ui.Repeater<Entry>(new StackLayout { Spacing = 2 }, Item, el => { if (el is Button b) { _shown.Add(b); Mark(b); } }, el => { if (el is Button b) _shown.Remove(b); });
        // edges line up: the title's icon, the chips, the search box and the items all start 16 px in; "+" and the sort box end 16 px in
        var head = new Grid { Padding = new Thickness(12, 12, 16, 4), RowSpacing = 8 };
        head.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        head.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        _head = head;
        _title = Ui.Text("音乐库", size: 15, foreground: Ui.Brush("TextSecondaryBrush"), bold: true);
        var titleIcon = Ui.Icon(Glyphs.Library, 20);
        titleIcon.VerticalAlignment = VerticalAlignment.Center; _title.VerticalAlignment = VerticalAlignment.Center;
        var titleButton = new Button { Content = Ui.Row(12, titleIcon, _title), Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent), BorderThickness = new Thickness(0), Padding = new Thickness(4), Height = 36, VerticalAlignment = VerticalAlignment.Center };
        // muted, the text colour under the pointer (foobar2k's)
        titleButton.Resources["ButtonBackgroundPointerOver"] = new SolidColorBrush(Microsoft.UI.Colors.Transparent);
        titleButton.Resources["ButtonBackgroundPressed"] = new SolidColorBrush(Microsoft.UI.Colors.Transparent);
        titleButton.PointerEntered += (_, _) => { _title.Foreground = Ui.Brush("TextPrimaryBrush"); titleIcon.Foreground = Ui.Brush("TextPrimaryBrush"); };
        titleButton.PointerExited += (_, _) => { _title.Foreground = Ui.Brush("TextSecondaryBrush"); titleIcon.Foreground = Ui.Brush("TextSecondaryBrush"); };
        AutomationProperties.SetName(titleButton, "收起或展开音乐库");
        ToolTipService.SetToolTip(titleButton, "收起或展开音乐库");
        titleButton.Click += (_, _) => SetRail(!_rail);
        var create = Ui.IconButton(Glyphs.Add, "新建歌单", async (_, _) => await shell.Run(async () =>
        {
            var p = await music.CreatePlaylistAsync($"我的歌单 #{music.Playlists.Count(x => x.Kind == PlaylistKind.User) + 1}", []);
            shell.Navigate($"playlist:{p.Id}");
        }), 32, 14);
        create.HorizontalAlignment = HorizontalAlignment.Right; create.VerticalAlignment = VerticalAlignment.Center;
        create.Background = Ui.Brush("RaisedBrush"); // foobar2k's round raised "+"
        create.Resources["ButtonBackgroundPointerOver"] = Ui.Brush("RaisedHiBrush");
        create.Resources["ButtonBackgroundPressed"] = Ui.Brush("RaisedHiBrush");
        create.Resources["ButtonForegroundPointerOver"] = Ui.Brush("TextPrimaryBrush");
        head.Children.Add(titleButton); head.Children.Add(create);
        _titleButton = titleButton; _create = create;

        _chips = new Chips("筛选", [("playlist", "歌单"), ("album", "专辑"), ("artist", "艺人")], settings.LibraryFilter.Length > 0 ? settings.LibraryFilter : null) { Margin = new Thickness(16, 6, 16, 6) };
        _chips.Changed += v => { settings.LibraryFilter = v ?? ""; settings.Save(); Render(); };
        AutomationProperties.SetName(_find, "在音乐库中搜索");
        _find.TextChanged += (_, _) => Render();
        foreach (var (v, l) in new[] { ("recent", "最近播放"), ("added", "最近添加"), ("alpha", "字母顺序"), ("creator", "创作者") }) _sort.Items.Add(new ComboBoxItem { Content = l, Tag = v });
        _sort.SelectedIndex = Math.Max(0, new[] { "recent", "added", "alpha", "creator" }.ToList().IndexOf(settings.LibrarySort));
        AutomationProperties.SetName(_sort, "排序");
        // the find field and the sort box: no box of their own until used, as foobar2k's (the field gets the raised colour
        // while typing); both 32 high, so they line up
        // its natural height (32) so the text sits on the middle line; room at the start for the search icon
        _find.FontSize = 13; _find.CornerRadius = new CornerRadius(6); _find.BorderThickness = new Thickness(0);
        _find.Padding = new Thickness(32, 6, 8, 6); _find.VerticalAlignment = VerticalAlignment.Center;
        var clear = new SolidColorBrush(Microsoft.UI.Colors.Transparent);
        foreach (var key in new[] { "TextControlBackground", "TextControlBorderBrush", "TextControlBorderBrushPointerOver", "TextControlBorderBrushFocused" }) _find.Resources[key] = clear;
        _find.Resources["TextControlBackgroundPointerOver"] = Ui.Brush("HoverBrush");
        _find.Resources["TextControlBackgroundFocused"] = Ui.Brush("RaisedBrush");
        _find.Resources["TextControlBorderThemeThicknessFocused"] = new Thickness(0);
        foreach (var key in new[] { "TextControlPlaceholderForeground", "TextControlPlaceholderForegroundPointerOver", "TextControlPlaceholderForegroundFocused" }) _find.Resources[key] = Ui.Brush("TextSecondaryBrush");
        _sort.Height = 32; _sort.MinHeight = 0; _sort.FontSize = 13; _sort.CornerRadius = new CornerRadius(6); _sort.BorderThickness = new Thickness(0);
        _sort.Background = clear; _sort.Foreground = Ui.Brush("TextSecondaryBrush");
        _sort.Resources["ComboBoxBackgroundPointerOver"] = Ui.Brush("HoverBrush");
        _sort.Resources["ComboBoxBackgroundPressed"] = Ui.Brush("HoverBrush");
        _sort.Resources["ComboBoxBorderBrushPointerOver"] = clear;
        _sort.Resources["ComboBoxBorderBrushPressed"] = clear;
        _sort.SelectionChanged += (_, _) => { if (_sort.SelectedItem is ComboBoxItem { Tag: string s }) { settings.LibrarySort = s; settings.Save(); Render(); } };
        var findRow = new Grid { ColumnSpacing = 8, Margin = new Thickness(16, 2, 16, 6) };
        findRow.ColumnDefinitions.Add(new ColumnDefinition());
        findRow.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var glass = Ui.Icon(Glyphs.Search, 14, Ui.Brush("TextTertiaryBrush"));
        glass.IsHitTestVisible = false; glass.VerticalAlignment = VerticalAlignment.Center; glass.HorizontalAlignment = HorizontalAlignment.Left; glass.Margin = new Thickness(10, 0, 0, 0);
        _sort.VerticalAlignment = VerticalAlignment.Center;
        findRow.Children.Add(_find); findRow.Children.Add(glass); Grid.SetColumn(_sort, 1); findRow.Children.Add(_sort);
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
        // the rail (80 px): the icon and "+" one above the other, centred, as foobar2k's; the covers centred below them
        _head!.Padding = rail ? new Thickness(8, 12, 8, 4) : new Thickness(12, 12, 16, 4);
        _titleButton!.HorizontalAlignment = rail ? HorizontalAlignment.Center : HorizontalAlignment.Left;
        _create!.HorizontalAlignment = rail ? HorizontalAlignment.Center : HorizontalAlignment.Right;
        Grid.SetRow(_create, rail ? 1 : 0);
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
        var items = list.ToList();
        // the same items as shown (a refresh that changed nothing here): keep them, rather than build them all again
        // (the rail is part of it: its items are built without their text)
        var shown = items.Select(x => (x.Route, x.Name, x.Sub, x.Cover, _rail)).ToList();
        if (_items.ItemsSource is not null && shown.SequenceEqual(_shownItems)) return;
        _shownItems = shown;
        _items.ItemsSource = items;
    }

    private List<(string Route, string Name, string Sub, string? Cover, bool Rail)> _shownItems = [];

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
        var playing = new Border { Width = 16, Height = 16, VerticalAlignment = VerticalAlignment.Center }; // level bars while its context plays
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
    private void Mark() { foreach (var b in _shown) Mark(b); }

    private void Mark(Button b)
    {
        if (b.Tag is not ValueTuple<Entry, TextBlock, Border> tag) return;
        var (e, name, host) = tag;
        bool current = _music.IsContext(e.Type, e.Id);
        name.Foreground = current ? Ui.Brush("AccentTextBrush") : Ui.Brush("TextPrimaryBrush");
        string state = current && !_rail ? _music.IsActive ? "playing" : "paused" : "";
        if (Equals(host.Tag, state)) return; // new bars only when it changes, so the moving ones keep moving
        host.Tag = state;
        host.Child = state.Length == 0 ? null : new EqBars(state == "playing", 13);
    }
}
