using Sonus.Core.Connect;
using Sonus.Services;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Microsoft.UI.Xaml.Media;

namespace Sonus.Controls;

/// <summary>
/// The right panel's "连接到设备" view, as Spotify's Connect panel: the device that plays in a card on top (with its
/// volume), the other devices under it (a click moves playback there; each has its own volume, rule 8), and a hint at
/// the bottom. With Connect version 2 it shows the session's devices (SessionService); with version 1, the devices and
/// which one the bar controls (ConnectService).
/// </summary>
public sealed class DevicesView : UserControl
{
    private readonly MusicService _music;
    private readonly ConnectService _connect;
    private readonly SessionService? _session;
    private readonly StackPanel _list = new() { Spacing = 2 };
    private string _shown = "";
    private string? _lastActiveId;
    private Slider? _cardLevel;               // the card's volume slider, kept in step while not being dragged
    private DispatcherTimer? _cardSend;

    public DevicesView(MusicService music, ConnectService connect, SessionService? session)
    {
        _music = music; _connect = connect; _session = session;
        var footer = Ui.Column(2,
            Ui.Text("没看到你的设备？", size: 14, foreground: Ui.Brush("TextPrimaryBrush"), bold: true),
            Wrapped(Ui.Text("在那台电脑或手机上打开 Sonus，登录同一个账号，它就会出现在这里。", size: 12.5, foreground: Ui.Brush("TextSecondaryBrush"))));
        footer.Margin = new Thickness(4, 16, 4, 0);
        var root = new Grid { Padding = new Thickness(16, 0, 16, 16) };
        root.RowDefinitions.Add(new RowDefinition());
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        root.Children.Add(new ScrollViewer { Content = _list, HorizontalScrollMode = ScrollMode.Disabled });
        Grid.SetRow(footer, 1); root.Children.Add(footer);
        AutomationProperties.SetName(root, "连接到设备");
        Content = root;
        // subscribed while it is in the window: the services it shows go away on signing out
        Loaded += (_, _) =>
        {
            if (session is not null) { session.Changed -= Refresh; session.Changed += Refresh; }
            connect.Changed -= Refresh; connect.Changed += Refresh;
            music.PlayerChanged -= Refresh; music.PlayerChanged += Refresh;
            Refresh(force: true);
        };
        Unloaded += (_, _) =>
        {
            if (session is not null) session.Changed -= Refresh;
            connect.Changed -= Refresh;
            music.PlayerChanged -= Refresh;
        };
    }

    private void Refresh() => Refresh(force: false);

    /// <summary>Drawn again when what it lists changes (a volume only moves its slider: one being dragged stays).</summary>
    public void Refresh(bool force)
    {
        if (!IsLoaded && !force) return;
        string shown = _session is { } s
            ? $"{s.IsConnected}|{s.Session.ActiveDevice}|{s.Session.Playing}|{s.Session.Current is null}|{string.Join(',', s.Devices.Select(d => d.Id + d.Name + d.CanPlay))}"
            : $"{_connect.IsConnected}|{_connect.Target?.Id}|{_music.IsActive}|{_music.Current?.Id}|{string.Join(',', _connect.Others.Select(d => d.Id + d.Name + d.State?.Playing + d.State?.TrackId))}";
        if (!force && shown == _shown) { KeepCardVolume(); return; }
        _shown = shown;
        _list.Children.Clear();
        _cardLevel = null;
        if (_session is { } session) FillSession(session); else Fill();
    }

    // ---------------------------------------------------------------- version 2: the session's devices
    private void FillSession(SessionService session)
    {
        if (!session.IsConnected) { _list.Children.Add(Note("正在连接服务器上的 Sonus Connect…")); return; }
        var now = session.Session;
        // this computer first, then the others as they joined (and the one that plays during its grace period)
        var devices = new List<SessionDevice> { new(session.Id, "这台电脑", "desktop", "", true, 0, _music.Volume, _music.Muted) };
        devices.AddRange(session.Devices.Where(d => d.Id != session.Id));
        if (now.ActiveDevice is { } activeId && devices.All(d => d.Id != activeId) && session.ActiveElsewhere is { } gone) devices.Add(gone);
        // the card: the device that plays; when none does, this one (pressing play plays here, rule 6)
        var current = devices.FirstOrDefault(d => d.Id == now.ActiveDevice) ?? devices[0];
        string status = now.ActiveDevice is null ? "没有设备在播放" : now.Playing ? "正在播放" : "已暂停";
        var card = Card(current.Id, current.Name, Glyph(current.Kind), status, now.ActiveDevice is not null && now.Playing,
            Volume(current.Id, current.Name, current.Volume, current.Muted, session));
        if (_lastActiveId is not null && _lastActiveId != current.Id && IsLoaded) Motion.Enter(card, rise: 10, move: Motion.Push);
        _lastActiveId = current.Id;
        _list.Children.Add(card);
        foreach (var d in devices.Where(d => d.Id != current.Id))
        {
            var row = Row(d.Name, Glyph(d.Kind), d.CanPlay ? null : "只能遥控", d.CanPlay, () => session.Transfer(d.Id), VolumeButton(d.Id, d.Name, session));
            _list.Children.Add(row);
        }
    }

    // ---------------------------------------------------------------- version 1: the devices, and the one the bar controls
    private void Fill()
    {
        if (!_connect.IsConnected) { _list.Children.Add(Note("正在连接服务器上的 Sonus Connect…")); return; }
        var m = _music;
        string State(ConnectState? s) => s is { TrackId: not null } ? $"{(s.Playing ? "正在播放" : "已暂停")} · {s.Title ?? m.Library.Track(s.TrackId)?.Title}" : "空闲";
        string here = m.Current is { } t ? $"{(m.IsActive ? "正在播放" : "已暂停")} · {t.Title}" : "空闲";
        if (_connect.Target is { } target)
        {
            _list.Children.Add(Card(target.Id, target.Name, Glyph(target.Kind), State(target.State), target.State?.Playing == true, null));
            _list.Children.Add(Row("这台电脑", Glyphs.Devices, here, true, () => _ = _connect.SelectAsync(null), null));
        }
        else _list.Children.Add(Card("", "这台电脑", Glyphs.Devices, here, m.IsActive, null));
        foreach (var d in _connect.Others.Where(d => d.Id != _connect.Target?.Id))
            _list.Children.Add(Row(d.Name, Glyph(d.Kind), State(d.State), true, () => _ = _connect.SelectAsync(d), null));
    }

    // ---------------------------------------------------------------- the parts
    /// <summary>The device that plays: a raised card, its name in the accent colour, and its volume under a hairline.</summary>
    private static Border Card(string id, string name, string glyph, string status, bool playing, FrameworkElement? volume)
    {
        var icon = Ui.Icon(glyph, 24, Ui.Brush("AccentTextBrush"));
        icon.VerticalAlignment = VerticalAlignment.Center;
        var title = Ui.Text(name, size: 16, foreground: Ui.Brush("AccentTextBrush"), bold: true);
        title.TextTrimming = TextTrimming.CharacterEllipsis;
        var sub = Ui.Text(status, size: 13, foreground: Ui.Brush("TextSecondaryBrush"));
        sub.TextTrimming = TextTrimming.CharacterEllipsis;
        var text = Ui.Column(2, title, sub);
        text.VerticalAlignment = VerticalAlignment.Center;
        var top = new Grid { ColumnSpacing = 14 };
        top.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        top.ColumnDefinitions.Add(new ColumnDefinition());
        top.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        top.Children.Add(icon);
        Grid.SetColumn(text, 1); top.Children.Add(text);
        if (playing) { var bars = new EqBars(true, 14); bars.VerticalAlignment = VerticalAlignment.Center; Grid.SetColumn(bars, 2); top.Children.Add(bars); }
        var body = Ui.Column(0, top);
        if (volume is not null)
        {
            body.Children.Add(new Border { Height = 1, Background = Ui.Brush("LineBrush"), Margin = new Thickness(0, 14, 0, 10) });
            body.Children.Add(volume);
        }
        var card = new Border { Background = Ui.Brush("RaisedBrush"), CornerRadius = new CornerRadius(8), Padding = new Thickness(16, 14, 16, volume is null ? 14 : 8), Margin = new Thickness(0, 0, 0, 12), Child = body };
        AutomationProperties.SetName(card, $"当前设备：{name}");
        return card;
    }

    /// <summary>Another device: a tall line that moves playback there when clicked; its volume button at the end.</summary>
    private static Grid Row(string name, string glyph, string? status, bool canPlay, Action pick, FrameworkElement? volume)
    {
        var icon = Ui.Icon(glyph, 22, Ui.Brush("TextSecondaryBrush"));
        icon.VerticalAlignment = VerticalAlignment.Center;
        var title = Ui.Text(name, size: 15, foreground: Ui.Brush("TextPrimaryBrush"));
        title.TextTrimming = TextTrimming.CharacterEllipsis;
        FrameworkElement text = title;
        if (status is not null)
        {
            var sub = Ui.Text(status, size: 12.5, foreground: Ui.Brush("TextSecondaryBrush"));
            sub.TextTrimming = TextTrimming.CharacterEllipsis;
            text = Ui.Column(1, title, sub);
        }
        text.VerticalAlignment = VerticalAlignment.Center;
        var label = new Grid { ColumnSpacing = 14, MinHeight = 32 };
        label.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(24) });
        label.ColumnDefinitions.Add(new ColumnDefinition());
        label.Children.Add(icon);
        Grid.SetColumn(text, 1); label.Children.Add(text);
        var clear = new SolidColorBrush(Microsoft.UI.Colors.Transparent);
        var button = new Button
        {
            Content = label, HorizontalAlignment = HorizontalAlignment.Stretch, HorizontalContentAlignment = HorizontalAlignment.Stretch,
            Background = clear, BorderThickness = new Thickness(0), Padding = new Thickness(12, 10, 8, 10), CornerRadius = new CornerRadius(6), IsEnabled = canPlay,
        };
        button.Resources["ButtonBackgroundPointerOver"] = clear; // the whole line lights up instead
        button.Resources["ButtonBackgroundPressed"] = clear;
        button.Resources["ButtonBackgroundDisabled"] = clear;
        AutomationProperties.SetName(button, name);
        AutomationProperties.SetHelpText(button, canPlay ? "在这台设备上播放" : "只能遥控，不能播放");
        button.Click += (_, _) => pick();
        var line = new Grid { CornerRadius = new CornerRadius(6), Background = clear };
        line.ColumnDefinitions.Add(new ColumnDefinition());
        line.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        line.Children.Add(button);
        if (volume is not null) { volume.Margin = new Thickness(0, 0, 6, 0); Grid.SetColumn(volume, 1); line.Children.Add(volume); }
        Motion.BrushFade(line);
        line.PointerEntered += (_, _) => line.Background = Ui.Brush("HoverBrush");
        line.PointerExited += (_, _) => line.Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent);
        return line;
    }

    /// <summary>The card's volume: a speaker and a slider across the card (rule 8).</summary>
    private FrameworkElement Volume(string id, string name, double volume, bool muted, SessionService session)
    {
        var (row, level, send) = VolumeSlider(id, name, volume, muted, session);
        _cardLevel = level; _cardSend = send;
        _cardId = id;
        return row;
    }

    private string? _cardId;

    /// <summary>Another device's volume behind a speaker button: a slider in a small flyout (rule 8).</summary>
    private FrameworkElement VolumeButton(string id, string name, SessionService session)
    {
        var button = Ui.IconButton(Glyphs.Volume, $"「{name}」的音量", null, 32, 14);
        button.Foreground = Ui.Brush("TextTertiaryBrush");
        button.VerticalAlignment = VerticalAlignment.Center;
        var holder = new Border { Width = 220, Padding = new Thickness(4, 2, 4, 2) };
        var flyout = new Flyout { Content = holder, Placement = FlyoutPlacementMode.Left };
        flyout.ShouldConstrainToRootBounds = Testing.E2EChannel.Enabled || flyout.ShouldConstrainToRootBounds; // a test window draws it inside itself
        // made when it opens, with the volume the device has then
        flyout.Opening += (_, _) =>
        {
            var d = id == session.Id ? new SessionDevice(id, name, "desktop", "", true, 0, _music.Volume, _music.Muted) : session.Devices.FirstOrDefault(x => x.Id == id);
            holder.Child = VolumeSlider(id, name, d?.Volume ?? 1, d?.Muted ?? false, session).Row;
        };
        button.Flyout = flyout;
        return button;
    }

    /// <summary>A speaker and a slim slider (a 3 px track, a 12 px thumb), sent a few times a second while dragged.</summary>
    private (Grid Row, Slider Level, DispatcherTimer Send) VolumeSlider(string id, string name, double volume, bool muted, SessionService session)
    {
        var level = new Slider { Minimum = 0, Maximum = 100, StepFrequency = 1, Value = muted ? 0 : volume * 100, IsThumbToolTipEnabled = false, VerticalAlignment = VerticalAlignment.Center };
        level.Resources["SliderHorizontalHeight"] = 24.0;
        level.Resources["SliderTrackThemeHeight"] = 3.0;
        level.Resources["SliderHorizontalThumbWidth"] = 12.0;
        level.Resources["SliderHorizontalThumbHeight"] = 12.0;
        level.Resources["SliderInnerThumbWidth"] = 6.0;
        level.Resources["SliderInnerThumbHeight"] = 6.0;
        level.Resources["SliderThumbCornerRadius"] = new CornerRadius(6);
        AutomationProperties.SetName(level, $"「{name}」的音量");
        var speaker = Ui.Icon(muted || volume == 0 ? Glyphs.Mute : Glyphs.Volume, 15, Ui.Brush("TextSecondaryBrush"));
        speaker.VerticalAlignment = VerticalAlignment.Center;
        var send = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(120) };
        send.Tick += (_, _) => { send.Stop(); session.SetVolume(id, level.Value / 100, level.Value > 0 && muted ? false : null); };
        level.ValueChanged += (_, e) =>
        {
            speaker.Glyph = e.NewValue == 0 ? Glyphs.Mute : Glyphs.Volume;
            if (!_keeping) { send.Stop(); send.Start(); }
        };
        var row = new Grid { ColumnSpacing = 10 };
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        row.ColumnDefinitions.Add(new ColumnDefinition());
        row.Children.Add(speaker);
        Grid.SetColumn(level, 1); row.Children.Add(level);
        return (row, level, send);
    }

    private bool _keeping;

    /// <summary>The card's slider follows the device's volume when it changes elsewhere, unless the user's change is on its way.</summary>
    private void KeepCardVolume()
    {
        if (_cardLevel is not { } level || _cardSend is { IsEnabled: true } || _session is not { } s || _cardId is null) return;
        var (volume, muted) = _cardId == s.Id ? (_music.Volume, _music.Muted) : s.Devices.FirstOrDefault(d => d.Id == _cardId) is { } d ? (d.Volume, d.Muted) : (level.Value / 100, false);
        double want = muted ? 0 : volume * 100;
        if (Math.Abs(level.Value - want) < 0.5) return;
        _keeping = true;
        level.Value = want;
        _keeping = false;
    }

    private static Grid Note(string text)
    {
        var note = Ui.Note(Glyphs.Info, text);
        note.Margin = new Thickness(4, 4, 4, 4);
        return note;
    }

    private static TextBlock Wrapped(TextBlock t) { t.TextWrapping = TextWrapping.Wrap; t.TextTrimming = TextTrimming.None; return t; }

    private static string Glyph(string kind) => kind switch { "phone" or "tablet" => Glyphs.Headphones, "speaker" => Glyphs.Speaker, _ => Glyphs.Devices };
}
