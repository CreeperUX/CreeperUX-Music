using System.Numerics;
using Microsoft.UI.Composition;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Hosting;
using Microsoft.UI.Xaml.Markup;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Shapes;

namespace CreeperUX.Music.Controls;

/// <summary>
/// An icon from the CreeperUX kit (foobar2k's set, KitIcons): drawn by XAML's own PathIcon, filling the icon's outline on
/// the kit's 24 px grid (tools/kit-icons.mjs makes the outlines from the kit's 1.6 px strokes). Being an IconElement, it
/// takes its colour from whatever holds it, as text does, and the framework keeps it in step: a button's colour, its
/// pointer-over, pressed and checked colours. A colour of its own can be given (<see cref="Foreground"/>).
/// Glyphs the kit has no icon for (Glyphs.Radio, say) are Segoe Fluent's.
/// </summary>
public sealed class KitIcon : Grid
{
    /// <summary>Segoe Fluent glyph → the kit's icon.</summary>
    private static readonly Dictionary<string, string> Names = new()
    {
        [Glyphs.Play] = "play", [Glyphs.Pause] = "pause", [Glyphs.Next] = "skip-next", [Glyphs.Previous] = "skip-previous",
        [Glyphs.Shuffle] = "shuffle", [Glyphs.Repeat] = "repeat", [Glyphs.RepeatOne] = "repeat-one", [Glyphs.Volume] = "volume",
        [Glyphs.Mute] = "volume-mute", [Glyphs.Heart] = "heart", [Glyphs.HeartFill] = "heart-filled", [Glyphs.More] = "more",
        [Glyphs.Home] = "home", [Glyphs.Search] = "search", [Glyphs.Settings] = "settings", [Glyphs.Library] = "library",
        [Glyphs.Queue] = "queue", [Glyphs.Lyrics] = "lyrics", [Glyphs.Speaker] = "speaker", [Glyphs.Back] = "arrow-left",
        [Glyphs.Add] = "plus", [Glyphs.Delete] = "trash", [Glyphs.Edit] = "edit", [Glyphs.Info] = "info", [Glyphs.Album] = "album",
        [Glyphs.Artist] = "artist", [Glyphs.Music] = "music", [Glyphs.Close] = "close", [Glyphs.Panel] = "panel-right",
        [Glyphs.Browse] = "browse", [Glyphs.Filter] = "filter", [Glyphs.Clock] = "clock", [Glyphs.Equalizer] = "waveform",
        [Glyphs.Error] = "alert", [Glyphs.Refresh] = "refresh", [Glyphs.Download] = "download",[Glyphs.Playlist] = "playlist", [Glyphs.Folder] = "folder", [Glyphs.Sort] = "sort", [Glyphs.Expand] = "expand",
    };

    private readonly double _size;
    private string _glyph = "";
    private Brush? _foreground;
    private IconElement? _icon;

    /// <param name="glyph">A Glyphs constant.</param>
    /// <param name="size">The size a Segoe glyph would have had; the kit's icons, which leave a margin on their grid, are
    /// drawn a quarter larger so the two read the same.</param>
    public KitIcon(string glyph, double size = 16)
    {
        _size = size;
        IsHitTestVisible = false;
        HorizontalAlignment = HorizontalAlignment.Center;
        VerticalAlignment = VerticalAlignment.Center;
        Glyph = glyph;
    }

    /// <summary>The kit's icon for a glyph as an icon element of its own (a menu item's Icon: menus draw it 16 px).</summary>
    public static IconElement Element(string glyph, double size = 16) =>
        Names.TryGetValue(glyph, out var name) && KitIcons.All.TryGetValue(name, out var outline)
            ? new PathIcon { Data = Outline(outline), Width = 24, Height = 24 }
            : new FontIcon { Glyph = glyph, FontSize = size, FontFamily = (FontFamily)Application.Current.Resources["SymbolThemeFontFamily"] };

    /// <summary>Its own colour; null (the default) takes the colour of whatever holds it.</summary>
    public Brush? Foreground
    {
        get => _foreground;
        set { _foreground = value; Colour(); }
    }

    public string Glyph
    {
        get => _glyph;
        set
        {
            if (_glyph == value && _icon is not null) return;
            _glyph = value;
            Children.Clear();
            _icon = Element(value, _size);
            if (_icon is PathIcon)
            {
                double box = Math.Round(_size * 1.25);
                Children.Add(new Viewbox { Width = box, Height = box, Child = _icon });
            }
            else Children.Add(_icon);
            Colour();
        }
    }

    private void Colour()
    {
        if (_icon is null) return;
        if (_foreground is null) _icon.ClearValue(IconElement.ForegroundProperty);
        else _icon.Foreground = _foreground;
    }

    // a geometry belongs to one element: each icon parses its own
    private static Geometry Outline(string data) => (Geometry)XamlBindingHelper.ConvertValue(typeof(Geometry), data);
}

/// <summary>
/// What is playing, as foobar2k marks it: three bars rising and falling at their own pace (on the compositor), still while
/// paused. In the accent colour.
/// </summary>
public sealed class EqBars : UserControl
{
    private readonly Rectangle[] _bars;
    private readonly bool _playing;
    private static readonly float[] Rest = [0.45f, 1f, 0.7f];
    private static readonly double[] Periods = [0.82, 1.06, 0.74];

    public EqBars(bool playing, double height = 14)
    {
        _playing = playing;
        IsTabStop = false; IsHitTestVisible = false;
        HorizontalAlignment = HorizontalAlignment.Center; VerticalAlignment = VerticalAlignment.Center;
        var row = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 2, Height = height, VerticalAlignment = VerticalAlignment.Center };
        _bars = [.. Enumerable.Range(0, 3).Select(_ => new Rectangle { Width = 3, Height = height, RadiusX = 1, RadiusY = 1, Fill = Ui.Brush("AccentBrush"), VerticalAlignment = VerticalAlignment.Bottom })];
        foreach (var b in _bars) row.Children.Add(b);
        Content = row;
        Loaded += (_, _) => Start(height);
    }

    private void Start(double height)
    {
        for (int i = 0; i < _bars.Length; i++)
        {
            var visual = ElementCompositionPreview.GetElementVisual(_bars[i]);
            visual.CenterPoint = new Vector3(1.5f, (float)height, 0);
            if (!_playing || !Motion.Enabled) { visual.Scale = new Vector3(1, Rest[i], 1); continue; }
            var c = visual.Compositor;
            var bounce = c.CreateVector3KeyFrameAnimation();
            var ease = c.CreateCubicBezierEasingFunction(new Vector2(0.45f, 0f), new Vector2(0.55f, 1f));
            bounce.InsertKeyFrame(0f, new Vector3(1, 0.25f, 1));
            bounce.InsertKeyFrame(0.5f, new Vector3(1, 1f, 1), ease);
            bounce.InsertKeyFrame(1f, new Vector3(1, 0.25f, 1), ease);
            bounce.Duration = TimeSpan.FromSeconds(Periods[i]);
            bounce.DelayTime = TimeSpan.FromMilliseconds(i * 140);
            bounce.DelayBehavior = AnimationDelayBehavior.SetInitialValueBeforeDelay;
            bounce.IterationBehavior = AnimationIterationBehavior.Forever;
            visual.StartAnimation("Scale", bounce);
        }
    }
}
