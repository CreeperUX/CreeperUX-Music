using Microsoft.UI;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Imaging;
using Windows.UI;

namespace CreeperUX.Music.Controls;

/// <summary>Segoe Fluent Icons code points used across the app.</summary>
public static class Glyphs
{
    public const string Play = "", Pause = "", Next = "", Previous = "", Shuffle = "", Repeat = "", RepeatOne = "";
    public const string Volume = "", Mute = "", Heart = "", HeartFill = "", More = "", Home = "", Search = "";
    public const string Settings = "", Library = "", Queue = "", Lyrics = "", Speaker = "", Back = "", Add = "";
    public const string Delete = "", Edit = "", Info = "", Album = "", Artist = "", Music = "", Radio = "";
    public const string Close = "", Panel = "", Browse = "", Filter = "", Clock = "", Equalizer = "", SignOut = "";
    public const string Error = "";
    public const string Refresh = "", Download = "";
    public const string Devices = "", Headphones = "";
    public const string Playlist = "", Folder = "", Sort = "", Expand = "";
}

/// <summary>Small factories so views read as layout, not property plumbing.</summary>
public static class Ui
{
    public static Brush Brush(string key) => (Brush)Application.Current.Resources[key];
    public static Color ColorOf(string key) => (Color)Application.Current.Resources[key];
    public static Style Style(string key) => (Style)Application.Current.Resources[key];
    public static SolidColorBrush Solid(Color c) => new(c);
    public static Color Rgb(byte r, byte g, byte b, byte a = 255) => Color.FromArgb(a, r, g, b);

    /// <summary>An icon (the kit's, KitIcon) in a colour of its own.</summary>
    public static KitIcon Icon(string glyph, double size = 16, Brush? foreground = null) => new(glyph, size) { Foreground = foreground ?? Brush("TextSecondaryBrush") };

    /// <summary>Changes a button's icon; <paramref name="pop"/> makes the new one swell in (Play becoming Pause).</summary>
    public static void SetIcon(ContentControl c, string glyph, bool pop = false)
    {
        var icon = c.Content as KitIcon ?? (c.Content as Panel)?.Children.OfType<KitIcon>().FirstOrDefault();
        if (icon is null) { c.Content = new KitIcon(glyph, c.FontSize); return; }
        if (icon.Glyph == glyph) return;
        icon.Glyph = glyph;
        if (pop) Motion.Pop(icon, 1.22f);
    }

    /// <summary>A note with an icon before it (sign-in notes, warnings), its text wrapping beside the icon. Muted, or in
    /// <paramref name="foreground"/> (WarnBrush for a warning).</summary>
    public static Grid Note(string glyph, string text, Brush? foreground = null)
    {
        var g = new Grid { ColumnSpacing = 8 };
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        g.ColumnDefinitions.Add(new ColumnDefinition());
        var icon = Icon(glyph, 14, foreground);
        icon.VerticalAlignment = VerticalAlignment.Top; icon.Margin = new Thickness(0, 2, 0, 0);
        var t = Text(text, "MutedTextStyle", foreground: foreground);
        t.TextWrapping = TextWrapping.Wrap;
        Grid.SetColumn(t, 1);
        g.Children.Add(icon); g.Children.Add(t);
        return g;
    }

    public static TextBlock Text(string text, string? style = null, double? size = null, Brush? foreground = null, bool bold = false)
    {
        var t = new TextBlock { Text = text, TextTrimming = TextTrimming.CharacterEllipsis };
        if (style is not null) t.Style = Style(style);
        if (size is { } s) t.FontSize = s;
        if (foreground is not null) t.Foreground = foreground;
        if (bold) t.FontWeight = Microsoft.UI.Text.FontWeights.Bold;
        return t;
    }

    /// <summary>A round icon button with an accessible name and a tooltip.</summary>
    public static Button IconButton(string glyph, string name, RoutedEventHandler? click = null, double size = 36, double glyphSize = 16)
    {
        var b = new Button { Style = Style("IconButtonStyle"), Content = new KitIcon(glyph, glyphSize), Width = size, Height = size, CornerRadius = new CornerRadius(size / 2), FontSize = glyphSize };
        AutomationProperties.SetName(b, name);
        ToolTipService.SetToolTip(b, name);
        if (click is not null) b.Click += click;
        return b;
    }

    /// <summary>Checked shows as an amber glyph, not a filled button (lightweight styling of the toggle's template).</summary>
    public static void QuietChecked(ToggleButton b, Brush? background = null, Brush? foreground = null)
    {
        var clear = new SolidColorBrush(Microsoft.UI.Colors.Transparent);
        b.Resources["ToggleButtonBackgroundChecked"] = background ?? clear;
        b.Resources["ToggleButtonBackgroundCheckedPointerOver"] = background ?? Brush("HoverBrush");
        b.Resources["ToggleButtonBackgroundCheckedPressed"] = background ?? Brush("HoverBrush");
        b.Resources["ToggleButtonBorderBrushChecked"] = clear;
        b.Resources["ToggleButtonBorderBrushCheckedPointerOver"] = clear;
        b.Resources["ToggleButtonBorderBrushCheckedPressed"] = clear;
        foreach (var k in new[] { "ToggleButtonForegroundChecked", "ToggleButtonForegroundCheckedPointerOver", "ToggleButtonForegroundCheckedPressed" })
            b.Resources[k] = foreground ?? Brush("AccentTextBrush");
    }

    /// <param name="dot">Marks "on" with a dot under the icon as well as the amber (foobar2k's media toggles).</param>
    public static ToggleButton IconToggle(string glyph, string name, double size = 36, bool dot = false, double glyphSize = 16)
    {
        var icon = new KitIcon(glyph, glyphSize);
        var b = new ToggleButton { Style = Style("IconToggleStyle"), Width = size, Height = size, CornerRadius = new CornerRadius(size / 2), FontSize = glyphSize, Padding = new Thickness(0) };
        if (dot)
        {
            var mark = new Microsoft.UI.Xaml.Shapes.Ellipse { Width = 4, Height = 4, Fill = Brush("AccentBrush"), HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Bottom, Margin = new Thickness(0, 0, 0, -1), Opacity = 0 };
            Motion.OpacityFade(mark);
            b.Content = new Grid { Width = size, Height = size, Children = { icon, mark } };
            b.RegisterPropertyChangedCallback(ToggleButton.IsCheckedProperty, (_, _) => mark.Opacity = b.IsChecked == true ? 1 : 0);
        }
        else b.Content = icon;
        QuietChecked(b);
        AutomationProperties.SetName(b, name);
        ToolTipService.SetToolTip(b, name);
        return b;
    }

    /// <summary>The amber Play / Pause button of pages and cards.</summary>
    public static Button PlayButton(string name, RoutedEventHandler click, double size = 56)
    {
        var b = new Button { Style = Style("PlayButtonStyle"), Content = new KitIcon(Glyphs.Play, size * 0.4), Width = size, Height = size, CornerRadius = new CornerRadius(size / 2), FontSize = size * 0.4 };
        AutomationProperties.SetName(b, name);
        ToolTipService.SetToolTip(b, name);
        b.Click += click;
        Motion.Press(b);
        return b;
    }

    public static void SetPlaying(Button b, bool playing, string name)
    {
        SetIcon(b, playing ? Glyphs.Pause : Glyphs.Play, pop: true);
        string label = (playing ? "暂停 " : "播放 ") + name;
        AutomationProperties.SetName(b, label);
        ToolTipService.SetToolTip(b, label);
    }

    public static StackPanel Row(double spacing = 8, params UIElement[] children)
    {
        var p = new StackPanel { Orientation = Orientation.Horizontal, Spacing = spacing };
        foreach (var c in children) p.Children.Add(c);
        return p;
    }

    public static StackPanel Column(double spacing = 8, params UIElement[] children)
    {
        var p = new StackPanel { Spacing = spacing };
        foreach (var c in children) p.Children.Add(c);
        return p;
    }

    /// <summary>A quiet text link (artist and album names).</summary>
    public static HyperlinkButton Link(string text, Action click, double size = 13, Brush? foreground = null, bool bold = false)
    {
        var l = new HyperlinkButton
        {
            Content = new TextBlock { Text = text, TextTrimming = TextTrimming.CharacterEllipsis, FontSize = size, FontWeight = bold ? Microsoft.UI.Text.FontWeights.Bold : Microsoft.UI.Text.FontWeights.Normal },
            Padding = new Thickness(0), Foreground = foreground ?? Brush("TextSecondaryBrush"), MinHeight = 0,
        };
        AutomationProperties.SetName(l, text);
        l.Click += (_, _) => click();
        return l;
    }

    /// <summary>A darker shade of a colour (−1 black … 0 the colour).</summary>
    public static Color Shade(Color c, double amount)
    {
        double f = 1 + amount;
        return Color.FromArgb(c.A, (byte)Math.Clamp(c.R * f, 0, 255), (byte)Math.Clamp(c.G * f, 0, 255), (byte)Math.Clamp(c.B * f, 0, 255));
    }

    /// <summary><paramref name="a"/> mixed into <paramref name="b"/>: <paramref name="amount"/> of a (CSS color-mix).</summary>
    public static Color Mix(Color a, Color b, double amount) => Rgb(
        (byte)Math.Round(a.R * amount + b.R * (1 - amount)), (byte)Math.Round(a.G * amount + b.G * (1 - amount)), (byte)Math.Round(a.B * amount + b.B * (1 - amount)));

    /// <summary>The page's tint, as foobar2k's: the colour mixed into the panel (66 %) at the top, a deeper shade of it in
    /// the middle, the panel by the bottom of the tint layer.</summary>
    public static Brush Tint(Color c)
    {
        var panel = ColorOf("PanelColor");
        return new LinearGradientBrush
        {
            StartPoint = new Windows.Foundation.Point(0, 0), EndPoint = new Windows.Foundation.Point(0, 1),
            GradientStops =
            {
                new GradientStop { Color = Mix(c, panel, 0.66), Offset = 0 },
                new GradientStop { Color = Mix(Shade(c, -0.5), panel, 0.46), Offset = 0.55 },
                new GradientStop { Color = panel, Offset = 1 },
            },
        };
    }

    public static readonly Color NeutralTint = Rgb(0x3a, 0x41, 0x48);

    public static void Name(FrameworkElement e, string name) => AutomationProperties.SetName(e, name);

    private static DataTemplate? _host;
    /// <summary>The element an <see cref="ItemsRepeater"/> recycles: an empty presenter, filled in code.</summary>
    private static DataTemplate Host => _host ??= (DataTemplate)Microsoft.UI.Xaml.Markup.XamlReader.Load(
        "<DataTemplate xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\"><ContentPresenter HorizontalContentAlignment=\"Stretch\" VerticalContentAlignment=\"Stretch\"/></DataTemplate>");

    /// <summary>
    /// A list or grid of items whose elements <paramref name="make"/> builds in code, only for the items in view and a screen or
    /// so around them, inside whatever scrolls (a library of thousands of albums must not mean thousands of cards).
    /// <paramref name="prepared"/> and <paramref name="cleared"/> are told when an element comes and goes.
    /// </summary>
    /// <param name="stagger">The elements shown when it first appears come in one after another (a page's cards).</param>
    public static ItemsRepeater Repeater<T>(Layout layout, Func<T, FrameworkElement> make, Action<FrameworkElement>? prepared = null, Action<FrameworkElement>? cleared = null, bool stagger = false)
    {
        var r = new ItemsRepeater { Layout = layout, ItemTemplate = Host };
        var shown = DateTime.MaxValue;
        r.Loaded += (_, _) => shown = DateTime.UtcNow;
        r.ElementPrepared += (s, e) =>
        {
            var el = make((T)s.ItemsSourceView.GetAt(e.Index));
            ((ContentPresenter)e.Element).Content = el;
            if (stagger && (shown == DateTime.MaxValue || DateTime.UtcNow - shown < TimeSpan.FromMilliseconds(600))) Motion.Stagger(el, e.Index);
            prepared?.Invoke(el);
        };
        r.ElementClearing += (_, e) =>
        {
            var host = (ContentPresenter)e.Element;
            if (host.Content is FrameworkElement el) cleared?.Invoke(el);
            host.Content = null;
        };
        return r;
    }

    /// <summary>The first element of that type below <paramref name="root"/> (a control's own scroller, say).</summary>
    public static T? Descendant<T>(DependencyObject root) where T : DependencyObject
    {
        for (int i = 0; i < VisualTreeHelper.GetChildrenCount(root); i++)
        {
            var child = VisualTreeHelper.GetChild(root, i);
            if (child is T found) return found;
            if (Descendant<T>(child) is { } deeper) return deeper;
        }
        return null;
    }

    /// <summary>A flyout menu item.</summary>
    public static MenuFlyoutItem Item(string text, string glyph, Action click, bool enabled = true)
    {
        var i = new MenuFlyoutItem { Text = text, Icon = KitIcon.Element(glyph), IsEnabled = enabled };
        i.Click += (_, _) => click();
        return i;
    }
}

/// <summary>Album art (or an artist's picture) in a rounded or round frame, with a glyph while it loads or when there is none.</summary>
public sealed class Artwork : Grid
{
    private readonly Image _image = new() { Stretch = Stretch.UniformToFill };
    private readonly KitIcon _placeholder;
    private string? _url;

    public Artwork(double size, bool circle = false, string glyph = Glyphs.Music, double radius = 6)
    {
        Width = size; Height = size;
        CornerRadius = new CornerRadius(circle ? size / 2 : radius);
        Background = Ui.Brush("RaisedBrush");
        _placeholder = Ui.Icon(glyph, Math.Max(14, size * 0.36), Ui.Brush("TextTertiaryBrush"));
        _placeholder.HorizontalAlignment = HorizontalAlignment.Center;
        _placeholder.VerticalAlignment = VerticalAlignment.Center;
        Children.Add(_placeholder);
        Children.Add(_image);
        _image.Opacity = 0;
        _image.OpacityTransition = new ScalarTransition { Duration = Motion.Control };
        IsHitTestVisible = false;
    }

    /// <summary>The art arrived: it fades in over the placeholder (art already decoded is there at once, no fade).</summary>
    private void Shown(bool instant)
    {
        if (instant)
        {
            var fade = _image.OpacityTransition;
            _image.OpacityTransition = null;
            _image.Opacity = 1;
            _image.OpacityTransition = fade;
        }
        else _image.Opacity = 1;
        _placeholder.Visibility = Visibility.Collapsed;
    }

    /// <summary>Shows a special tile (liked songs, the library): a diagonal gradient of these colours and a glyph instead of
    /// art.</summary>
    public void Special(Color[] gradient, string glyph, Color foreground)
    {
        var brush = new LinearGradientBrush { StartPoint = new Windows.Foundation.Point(0, 0), EndPoint = new Windows.Foundation.Point(1, 1) };
        // foobar2k's liked cover: dark gold, the amber at 55 %, pale gold
        for (int i = 0; i < gradient.Length; i++)
            brush.GradientStops.Add(new GradientStop { Color = gradient[i], Offset = gradient.Length == 3 && i == 1 ? 0.55 : (double)i / (gradient.Length - 1) });
        Background = brush;
        _placeholder.Glyph = glyph;
        _placeholder.Foreground = new SolidColorBrush(foreground);
        _placeholder.Visibility = Visibility.Visible;
        _url = null;
        Covers.Show(_image, null, 0);
    }

    public string? Url
    {
        get => _url;
        set
        {
            if (_url == value) return;
            _url = value;
            _placeholder.Visibility = Visibility.Visible;
            _image.Opacity = 0;
            // the app downloads it (Covers), not XAML: songs streaming from the same server cannot hold it up
            Covers.Show(_image, value, (int)Math.Min(1024, double.IsNaN(Width) ? 600 : Width), (ok, instant) => { if (ok && _url == value) Shown(instant); });
        }
    }
}

/// <summary>A colour from an image (the average of a small copy), for page tints. Cached per URL.</summary>
public static class ArtworkColor
{
    private static readonly Dictionary<string, Task<Color?>> Cache = [];

    public static Task<Color?> GetAsync(string? url)
    {
        if (url is null) return Task.FromResult<Color?>(null);
        if (!Cache.TryGetValue(url, out var task)) Cache[url] = task = Sample(url);
        return task;
    }

    private static async Task<Color?> Sample(string url)
    {
        try
        {
            if (await Covers.BytesAsync(url) is not { } bytes) return null;
            using var stream = new Windows.Storage.Streams.InMemoryRandomAccessStream();
            await stream.WriteAsync(System.Runtime.InteropServices.WindowsRuntime.WindowsRuntimeBufferExtensions.AsBuffer(bytes));
            stream.Seek(0);
            var decoder = await Windows.Graphics.Imaging.BitmapDecoder.CreateAsync(stream);
            var transform = new Windows.Graphics.Imaging.BitmapTransform { ScaledWidth = 12, ScaledHeight = 12 };
            var data = await decoder.GetPixelDataAsync(Windows.Graphics.Imaging.BitmapPixelFormat.Bgra8, Windows.Graphics.Imaging.BitmapAlphaMode.Ignore, transform,
                Windows.Graphics.Imaging.ExifOrientationMode.IgnoreExifOrientation, Windows.Graphics.Imaging.ColorManagementMode.DoNotColorManage);
            var px = data.DetachPixelData();
            long r = 0, g = 0, b = 0; int n = px.Length / 4;
            for (int i = 0; i < px.Length; i += 4) { b += px[i]; g += px[i + 1]; r += px[i + 2]; }
            var c = Ui.Rgb((byte)(r / n), (byte)(g / n), (byte)(b / n));
            // keep text readable on it: not too bright, not grey-black
            double lum = 0.2126 * c.R + 0.7152 * c.G + 0.0722 * c.B;
            return lum > 120 ? Ui.Shade(c, -(1 - 120 / lum)) : c;
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or System.Runtime.InteropServices.COMException or ArgumentException)
        {
            return null; // SVG covers (the demo server) and broken images: the neutral tint
        }
    }
}
