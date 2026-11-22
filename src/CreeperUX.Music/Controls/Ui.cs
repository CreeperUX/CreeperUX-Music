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
    public const string Playlist = "", Folder = "", Sort = "", Expand = "";
}

/// <summary>Small factories so views read as layout, not property plumbing.</summary>
public static class Ui
{
    public static Brush Brush(string key) => (Brush)Application.Current.Resources[key];
    public static Style Style(string key) => (Style)Application.Current.Resources[key];
    public static SolidColorBrush Solid(Color c) => new(c);
    public static Color Rgb(byte r, byte g, byte b, byte a = 255) => Color.FromArgb(a, r, g, b);

    public static FontIcon Icon(string glyph, double size = 16, Brush? foreground = null) =>
        new() { Glyph = glyph, FontSize = size, Foreground = foreground ?? Brush("TextSecondaryBrush"), FontFamily = (FontFamily)Application.Current.Resources["SymbolThemeFontFamily"] };

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
        var b = new Button { Style = Style("IconButtonStyle"), Content = glyph, Width = size, Height = size, CornerRadius = new CornerRadius(size / 2), FontSize = glyphSize };
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

    public static ToggleButton IconToggle(string glyph, string name, double size = 36)
    {
        var b = new ToggleButton { Style = Style("IconToggleStyle"), Content = glyph, Width = size, Height = size, CornerRadius = new CornerRadius(size / 2) };
        QuietChecked(b);
        AutomationProperties.SetName(b, name);
        ToolTipService.SetToolTip(b, name);
        return b;
    }

    /// <summary>The amber Play / Pause button of pages and cards.</summary>
    public static Button PlayButton(string name, RoutedEventHandler click, double size = 56)
    {
        var b = new Button { Style = Style("PlayButtonStyle"), Content = Glyphs.Play, Width = size, Height = size, CornerRadius = new CornerRadius(size / 2), FontSize = size * 0.38 };
        AutomationProperties.SetName(b, name);
        ToolTipService.SetToolTip(b, name);
        b.Click += click;
        return b;
    }

    public static void SetPlaying(Button b, bool playing, string name)
    {
        b.Content = playing ? Glyphs.Pause : Glyphs.Play;
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

    /// <summary>The page's tint: the colour at the top, fading into the panel by the bottom of the tint layer.</summary>
    public static Brush Tint(Color c) => new LinearGradientBrush
    {
        StartPoint = new Windows.Foundation.Point(0, 0), EndPoint = new Windows.Foundation.Point(0, 1),
        GradientStops =
        {
            new GradientStop { Color = Shade(c, -0.25), Offset = 0 },
            new GradientStop { Color = Shade(c, -0.55), Offset = 0.55 },
            new GradientStop { Color = Rgb(0x12, 0x15, 0x18), Offset = 1 },
        },
    };

    public static readonly Color NeutralTint = Rgb(0x3a, 0x41, 0x48);

    public static void Name(FrameworkElement e, string name) => AutomationProperties.SetName(e, name);

    /// <summary>A flyout menu item.</summary>
    public static MenuFlyoutItem Item(string text, string glyph, Action click, bool enabled = true)
    {
        var i = new MenuFlyoutItem { Text = text, Icon = new FontIcon { Glyph = glyph }, IsEnabled = enabled };
        i.Click += (_, _) => click();
        return i;
    }
}

/// <summary>Album art (or an artist's picture) in a rounded or round frame, with a glyph while it loads or when there is none.</summary>
public sealed class Artwork : Grid
{
    private readonly Image _image = new() { Stretch = Stretch.UniformToFill };
    private readonly FontIcon _placeholder;
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
        _image.ImageOpened += (_, _) => _placeholder.Visibility = Visibility.Collapsed;
        _image.ImageFailed += (_, _) =>
        {
            // a server that sends SVG covers: BitmapImage cannot decode them, SvgImageSource can
            if (_url is { } u && _image.Source is BitmapImage)
            {
                var svg = new SvgImageSource(new Uri(u)) { RasterizePixelWidth = Width * 2, RasterizePixelHeight = Height * 2 };
                svg.Opened += (_, _) => _placeholder.Visibility = Visibility.Collapsed;
                _image.Source = svg;
            }
            else _placeholder.Visibility = Visibility.Visible;
        };
        IsHitTestVisible = false;
    }

    /// <summary>Shows a special tile (liked songs, the library): a colour and a glyph instead of art.</summary>
    public void Special(Color background, string glyph, Color foreground)
    {
        Background = new LinearGradientBrush
        {
            StartPoint = new Windows.Foundation.Point(0, 0), EndPoint = new Windows.Foundation.Point(1, 1),
            GradientStops = { new GradientStop { Color = background, Offset = 0 }, new GradientStop { Color = Ui.Shade(background, -0.45), Offset = 1 } },
        };
        _placeholder.Glyph = glyph;
        _placeholder.Foreground = new SolidColorBrush(foreground);
        _placeholder.Visibility = Visibility.Visible;
        _image.Source = null;
    }

    public string? Url
    {
        get => _url;
        set
        {
            if (_url == value) return;
            _url = value;
            _placeholder.Visibility = Visibility.Visible;
            _image.Source = value is null ? null : new BitmapImage(new Uri(value)) { DecodePixelWidth = (int)Math.Min(1024, Width * 2), DecodePixelType = DecodePixelType.Logical };
        }
    }
}

/// <summary>A colour from an image (the average of a small copy), for page tints. Cached per URL.</summary>
public static class ArtworkColor
{
    private static readonly Dictionary<string, Task<Color?>> Cache = [];
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(10) };

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
            var bytes = await Http.GetByteArrayAsync(url);
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
