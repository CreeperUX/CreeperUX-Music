using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Shapes;
using CreeperUX.Music.Controls;

namespace CreeperUX.Music.Setup;

/// <summary>
/// One of the app's icons (the CreeperUX kit's outlines, KitIcons.g.cs shared with the app), filled on the kit's 24 px
/// grid and scaled to <see cref="FrameworkElement.Width"/>. Muted unless given a <see cref="Fill"/>.
/// </summary>
public sealed class KitGlyph : Viewbox
{
    private readonly Path _path = new();

    public KitGlyph()
    {
        Width = Height = 18;
        _path.SetResourceReference(Shape.FillProperty, "TextSecondaryBrush");
        Child = new Canvas { Width = 24, Height = 24, Children = { _path } };
    }

    /// <summary>The kit's name for it ("music", "check").</summary>
    public string Icon
    {
        get => _icon;
        set { _icon = value; _path.Data = KitIcons.All.TryGetValue(value, out var data) ? Geometry.Parse(data) : null; }
    }
    private string _icon = "";

    public Brush Fill
    {
        get => _path.Fill;
        set => _path.Fill = value;
    }
}
