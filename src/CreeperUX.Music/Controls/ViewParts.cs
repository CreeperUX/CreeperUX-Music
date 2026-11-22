using CreeperUX.Music.Core;
using CreeperUX.Music.Services;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Automation.Peers;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Microsoft.UI.Xaml.Media;
using Windows.UI;

namespace CreeperUX.Music.Controls;

/// <summary>What views need from the window.</summary>
public interface IShell
{
    /// <summary>"home", "album:al3", "playlist:x", "artist:y", "search:q", "genre:g", "shelf:recent", "lyrics", "settings".</summary>
    void Navigate(string route);
    void ShowToast(ToastMessage message);
    /// <summary>Runs a server request; a failure becomes a toast.</summary>
    Task Run(Func<Task> action);
    void ShowProperties(Track track);
    Task<string?> AskText(string title, string label, string value);
    Task<bool> Confirm(string title, string message, string action);
}

/// <summary>A page in the main panel. Subscriptions made with <see cref="On"/> end when the page is left.</summary>
public abstract class View : UserControl
{
    private readonly List<Action> _cleanups = [];
    protected View(MusicService music, IShell shell) { Music = music; Shell = shell; }
    protected MusicService Music { get; }
    protected IShell Shell { get; }
    public virtual string Title => "";

    protected void On(Action subscribe, Action unsubscribe) { subscribe(); _cleanups.Add(unsubscribe); }

    public void Leave() { foreach (var c in _cleanups) c(); _cleanups.Clear(); OnLeave(); }
    protected virtual void OnLeave() { }

    /// <summary>The page body: a scroller with the page's tint behind the top of the content.</summary>
    protected (ScrollViewer Scroller, StackPanel Body, Border TintLayer) Scaffold(double padding = 24)
    {
        var tint = new Border { Background = Ui.Tint(Ui.NeutralTint), Height = 420, VerticalAlignment = VerticalAlignment.Top, IsHitTestVisible = false };
        var body = new StackPanel { Padding = new Thickness(padding, padding, padding, 32), Spacing = 18 };
        var grid = new Grid();
        grid.Children.Add(tint);
        grid.Children.Add(body);
        var scroller = new ScrollViewer { Content = grid, HorizontalScrollMode = ScrollMode.Disabled, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
        Content = scroller;
        return (scroller, body, tint);
    }

    /// <summary>Tints the page from an album's cover, once its colour is known.</summary>
    protected async void TintFrom(Border layer, string? albumId)
    {
        if (await ArtworkColor.GetAsync(Music.CoverUrl(albumId, 64)) is { } c) layer.Background = Ui.Tint(c);
    }
}

/// <summary>Cards (album, playlist, artist) and shelves of them.</summary>
public static class Cards
{
    public static (string Title, string Subtitle, string? Cover, bool Circle, string Glyph) Describe(MusicService music, CardRef r)
    {
        switch (r.Type)
        {
            case "album":
                var a = music.Library.Album(r.Id);
                return (a?.Title ?? "", a is null ? "" : $"{a.Year} · {a.Artist}", music.CoverUrl(r.Id), false, Glyphs.Album);
            case "artist":
                var ar = music.Library.Artist(r.Id);
                return (ar?.Name ?? "", "艺人", music.CoverUrl(ar?.AlbumIds.FirstOrDefault()), true, Glyphs.Artist);
            default:
                var p = music.Playlist(r.Id);
                return (p?.Name ?? "", p is null ? "" : $"歌单 · {p.Owner}", PlaylistCover(music, p), false, Glyphs.Playlist);
        }
    }

    public static string? PlaylistCover(MusicService music, Playlist? p) =>
        p is null || p.Kind is PlaylistKind.Liked or PlaylistKind.Library ? null : music.CoverUrl(p.TrackIds.Select(id => music.Library.Track(id)?.AlbumId).FirstOrDefault(a => a is not null));

    /// <summary>Liked songs and the library show a colour and a glyph, not art.</summary>
    public static void Decorate(Artwork art, Playlist? p)
    {
        if (p?.Kind == PlaylistKind.Liked) art.Special(Ui.Rgb(0xC7, 0x8B, 0x00), Glyphs.HeartFill, Ui.Rgb(0x11, 0x14, 0x16));
        else if (p?.Kind == PlaylistKind.Library) art.Special(Ui.Rgb(0x34, 0x42, 0x4b), Glyphs.Library, Ui.Rgb(0xEF, 0xEB, 0xE5));
    }

    public static string RouteOf(CardRef r) => $"{r.Type}:{r.Id}";

    /// <summary>A card: art, title, subtitle; a Play button appears on hover (always there for keyboard and screen readers).</summary>
    public static FrameworkElement Card(MusicService music, IShell shell, CardRef r, double size = 168)
    {
        var (title, subtitle, cover, circle, glyph) = Describe(music, r);
        var art = new Artwork(size, circle, glyph, 8) { Url = cover };
        if (r.Type == "playlist") Decorate(art, music.Playlist(r.Id));
        var play = Ui.PlayButton($"播放 {title}", (_, _) => music.TogglePlayContext(r.Type, r.Id), 44);
        play.HorizontalAlignment = HorizontalAlignment.Right; play.VerticalAlignment = VerticalAlignment.Bottom; play.Margin = new Thickness(0, 0, 8, 8);
        play.Opacity = music.IsContext(r.Type, r.Id) ? 1 : 0;
        Ui.SetPlaying(play, music.IsContextPlaying(r.Type, r.Id), title);
        var artBox = new Grid { Width = size, Height = size };
        artBox.Children.Add(art); artBox.Children.Add(play);
        var titleText = Ui.Text(title, "CardTitleStyle");
        if (music.IsContext(r.Type, r.Id)) titleText.Foreground = Ui.Brush("AccentTextBrush");
        var text = Ui.Column(2, titleText, Ui.Text(subtitle, "MutedTextStyle"));
        var open = new Button
        {
            Content = Ui.Column(10, artBox, text), Padding = new Thickness(10), Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent),
            BorderThickness = new Thickness(0), CornerRadius = new CornerRadius(8), HorizontalContentAlignment = HorizontalAlignment.Left, Width = size + 20,
        };
        AutomationProperties.SetName(open, title);
        open.Click += (_, _) => shell.Navigate(RouteOf(r));
        var root = new Grid();
        root.Children.Add(open);
        // the Play button sits over the card's art, outside the card button (a button in a button is not reachable)
        var overlay = new Grid { Width = size, Height = size, Margin = new Thickness(10), HorizontalAlignment = HorizontalAlignment.Left, VerticalAlignment = VerticalAlignment.Top };
        artBox.Children.Remove(play); overlay.Children.Add(play); root.Children.Add(overlay);
        root.PointerEntered += (_, _) => play.Opacity = 1;
        root.PointerExited += (_, _) => play.Opacity = music.IsContext(r.Type, r.Id) ? 1 : 0;
        play.GotFocus += (_, _) => play.Opacity = 1;
        void Sync() { Ui.SetPlaying(play, music.IsContextPlaying(r.Type, r.Id), title); titleText.Foreground = music.IsContext(r.Type, r.Id) ? Ui.Brush("AccentTextBrush") : Ui.Brush("TextPrimaryBrush"); }
        root.Loaded += (_, _) => music.PlayerChanged += Sync;
        root.Unloaded += (_, _) => music.PlayerChanged -= Sync;
        return root;
    }

    /// <summary>A titled row of cards, with "显示全部" when there are more.</summary>
    public static FrameworkElement Shelf(MusicService music, IShell shell, string title, IReadOnlyList<CardRef> refs, string? more = null, int limit = 12)
    {
        var head = new Grid();
        head.Children.Add(Ui.Text(title, "SectionTitleStyle"));
        if (more is not null && refs.Count > 0)
        {
            var all = Ui.Link("显示全部", () => shell.Navigate(more), 13, Ui.Brush("TextSecondaryBrush"), bold: true);
            AutomationProperties.SetName(all, $"显示全部：{title}");
            all.HorizontalAlignment = HorizontalAlignment.Right; all.VerticalAlignment = VerticalAlignment.Center;
            head.Children.Add(all);
        }
        var row = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 4, Margin = new Thickness(-10, 0, 0, 0) };
        foreach (var r in refs.Take(limit)) row.Children.Add(Card(music, shell, r));
        var scroller = new ScrollViewer { Content = row, HorizontalScrollMode = ScrollMode.Enabled, HorizontalScrollBarVisibility = ScrollBarVisibility.Auto, VerticalScrollMode = ScrollMode.Disabled, VerticalScrollBarVisibility = ScrollBarVisibility.Disabled };
        var shelf = Ui.Column(8, head, scroller);
        AutomationProperties.SetName(shelf, title);
        shelf.Visibility = refs.Count > 0 ? Visibility.Visible : Visibility.Collapsed;
        return shelf;
    }

    /// <summary>A wrapping grid of cards (show-all pages, an artist's releases, search results by kind).</summary>
    public static FrameworkElement Grid(MusicService music, IShell shell, IEnumerable<CardRef> refs)
    {
        var wrap = new VariableSizedWrapGrid { Orientation = Orientation.Horizontal, ItemWidth = 192, ItemHeight = 250, Margin = new Thickness(-10, 0, 0, 0) };
        foreach (var r in refs) wrap.Children.Add(Card(music, shell, r));
        return wrap;
    }
}

/// <summary>The big header of an album, a playlist or an artist: art, kind, title, a line of facts.</summary>
public static class Hero
{
    public static Grid Build(string kind, string title, IEnumerable<UIElement> meta, Artwork? art, string? description = null)
    {
        var g = new Grid { ColumnSpacing = 24, Margin = new Thickness(0, 24, 0, 4) };
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        if (art is not null)
        {
            art.Shadow = new ThemeShadow();
            art.Translation = new System.Numerics.Vector3(0, 0, 24);
            g.Children.Add(art);
        }
        var text = new StackPanel { VerticalAlignment = VerticalAlignment.Bottom, Spacing = 8 };
        text.Children.Add(Ui.Text(kind, size: 13, foreground: Ui.Brush("TextPrimaryBrush"), bold: true));
        var heading = Ui.Text(title, "HeroTitleStyle");
        AutomationProperties.SetHeadingLevel(heading, AutomationHeadingLevel.Level1);
        text.Children.Add(heading);
        if (!string.IsNullOrWhiteSpace(description)) { var d = Ui.Text(description!, "MutedTextStyle"); d.TextWrapping = TextWrapping.Wrap; d.MaxLines = 2; text.Children.Add(d); }
        var line = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6 };
        bool first = true;
        foreach (var m in meta)
        {
            if (!first) line.Children.Add(Ui.Text("·", size: 13, foreground: Ui.Brush("TextSecondaryBrush")));
            line.Children.Add(m); first = false;
        }
        text.Children.Add(line);
        Grid.SetColumn(text, 1);
        g.Children.Add(text);
        return g;
    }

    public static TextBlock Fact(string text, bool strong = false) => Ui.Text(text, size: 13, foreground: strong ? Ui.Brush("TextPrimaryBrush") : Ui.Brush("TextSecondaryBrush"), bold: strong);

    /// <summary>Play / pause, shuffle, and "more" for a context.</summary>
    public static StackPanel Actions(MusicService music, string kind, string id, string name, MenuFlyout? more, Action<Action> keepInSync)
    {
        var play = Ui.PlayButton($"播放 {name}", (_, _) => music.TogglePlayContext(kind, id));
        play.Name = "PagePlay";
        var shuffle = Ui.IconButton(Glyphs.Shuffle, $"随机播放 {name}", (_, _) => music.PlayContext(kind, id, shuffle: true), 44, 20);
        var row = Ui.Row(20, play, shuffle);
        if (more is not null)
        {
            var m = Ui.IconButton(Glyphs.More, $"{name} 的更多选项", null, 44, 20);
            m.Flyout = more;
            row.Children.Add(m);
        }
        row.Margin = new Thickness(0, 8, 0, 4);
        void Sync() => Ui.SetPlaying(play, music.IsContextPlaying(kind, id), name);
        Sync();
        keepInSync(Sync);
        return row;
    }
}

/// <summary>Filter chips (single choice; choosing the chosen one again clears it).</summary>
public sealed class Chips : StackPanel
{
    private readonly List<ToggleButton> _buttons = [];
    public string? Value { get; private set; }
    public event Action<string?>? Changed;

    public Chips(string label, IEnumerable<(string Value, string Label)> options, string? value = null)
    {
        Orientation = Orientation.Horizontal; Spacing = 8; Value = value;
        AutomationProperties.SetName(this, label);
        foreach (var (v, l) in options)
        {
            var b = new ToggleButton { Content = l, Style = Ui.Style("ChipStyle"), IsChecked = v == value, Tag = v };
            Ui.QuietChecked(b, Ui.Brush("TextPrimaryBrush"), Ui.Brush("OnAccentBrush")); // the chosen chip: light, as in Spotify
            b.Click += (_, _) =>
            {
                Value = b.IsChecked == true ? v : null;
                foreach (var o in _buttons) o.IsChecked = (string)o.Tag == Value;
                Changed?.Invoke(Value);
            };
            _buttons.Add(b);
            Children.Add(b);
        }
    }
}
