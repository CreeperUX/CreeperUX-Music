using Sonus.Core;
using Sonus.Core.Connect;
using Sonus.Playback;
using Sonus.Services;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Microsoft.UI.Xaml.Media;

namespace Sonus.Controls;

/// <summary>The bar along the bottom: the song (cover, title, artist, like), the transport (shuffle, previous, play, next,
/// repeat) with the progress, and lyrics / queue / devices / output / volume. With Sonus Connect it can show and
/// control another of the user's devices instead of this one (ConnectService.Target): the song, the position and the
/// buttons are then that device's, and a line in the accent colour says which device plays. With version 2 (SessionService)
/// the bar always shows the user's one session (MusicService follows it): the line says where it plays ("正在「手机」上播放",
/// or "上次在「书房电脑」播放" when nothing plays), the devices button moves playback, and the volume is that device's.</summary>
public sealed class PlaybackBar : UserControl
{
    private readonly MusicService _music;
    private readonly ConnectService _connect;
    private readonly SessionService? _session;
    private readonly IShell _shell;
    private readonly Artwork _art = new(56, false, Glyphs.Music, 4);
    private readonly HyperlinkButton _title, _artist;
    private readonly Button _like, _play, _prev, _next, _devices;
    private readonly ToggleButton _shuffle, _repeat, _lyrics, _queue;
    private readonly Slider _progress = new() { Minimum = 0, Maximum = 1, StepFrequency = 0.1, IsThumbToolTipEnabled = false, VerticalAlignment = VerticalAlignment.Center };
    private readonly TextBlock _at = Ui.Text("0:00", "FigureTextStyle"), _length = Ui.Text("0:00", "FigureTextStyle");
    private readonly Slider _volume = new() { Minimum = 0, Maximum = 100, Width = 110, StepFrequency = 1, VerticalAlignment = VerticalAlignment.Center };
    private readonly Button _mute;
    private readonly TextBlock _error = Ui.Text("", size: 12, foreground: Ui.Brush("BadBrush"));
    private readonly TextBlock _where = Ui.Text("", size: 12, foreground: Ui.Brush("AccentTextBrush"));
    private readonly Microsoft.UI.Xaml.Shapes.Ellipse _devicesDot = new() { Width = 5, Height = 5, Fill = Ui.Brush("AccentBrush"), HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Bottom, Margin = new Thickness(0, 0, 0, 2), IsHitTestVisible = false };
    private readonly DispatcherTimer _volumeSend = new() { Interval = TimeSpan.FromMilliseconds(120) };
    private bool _seeking, _syncing;

    // The position between the service's updates (four a second), carried on frame by frame while playing, so the bar
    // glides instead of stepping. A little ahead of the engine, it waits for it rather than stepping back.
    private double _knownAt;
    private long _knownWhen;
    private bool _gliding;

    private ConnectDevice? Remote => _connect.Target;
    /// <summary>Version 2: the device that plays the session when it is not this one (the volume is that device's).</summary>
    private SessionDevice? VolumeTarget => _session?.ActiveElsewhere;
    /// <summary>The song shown: this device's, or the controlled device's when this library has it.</summary>
    private Track? Shown => Remote is { } r ? _music.Library.Track(r.State?.TrackId) : _music.Current;

    private void Glide(bool on)
    {
        on &= Motion.Enabled && IsLoaded;
        if (on == _gliding) return;
        _gliding = on;
        if (on) CompositionTarget.Rendering += OnFrame; else CompositionTarget.Rendering -= OnFrame;
    }

    private void OnFrame(object? sender, object e)
    {
        if (_seeking) return;
        double at = Math.Min(_knownAt + System.Diagnostics.Stopwatch.GetElapsedTime(_knownWhen).TotalSeconds, _progress.Maximum);
        double behind = _progress.Value - at;
        if (behind > 0 && behind < 0.75) return;
        string text = Formats.Duration(at);
        if (_at.Text != text) _at.Text = text; // every second, even where the thumb moves less than a pixel a second
        // the thumb only when it would move by a screen pixel: the layout rounds to pixels anyway
        double pixels = _progress.ActualWidth * (XamlRoot?.RasterizationScale ?? 1) / Math.Max(1, _progress.Maximum);
        if (Math.Abs(at - _progress.Value) * pixels < 1) return;
        ShowPosition(at);
    }

    private void ShowPosition(double at)
    {
        bool was = _syncing; // also called from Sync, which is syncing already
        _syncing = true;
        _progress.Value = Math.Min(at, _progress.Maximum);
        _syncing = was;
        string text = Formats.Duration(at);
        if (_at.Text != text) _at.Text = text;
    }

    private void Known(double at) { _knownAt = at; _knownWhen = System.Diagnostics.Stopwatch.GetTimestamp(); }

    /// <summary>A command for the controlled device; failures to deliver come back as a toast from the service.</summary>
    private void Send(string action, Func<ConnectCommand, ConnectCommand>? with = null)
    {
        var command = new ConnectCommand(action);
        _ = _connect.SendAsync(with is null ? command : with(command));
    }

    public PlaybackBar(MusicService music, ConnectService connect, SessionService? session, IShell shell)
    {
        _music = music; _connect = connect; _session = session; _shell = shell;
        Height = 88; // the transport (40) and the progress row (32) between 8 px paddings
        // left: the song
        _title = Ui.Link("", () => { if (Shown is { } t) shell.Navigate($"album:{t.AlbumId}"); }, 14, Ui.Brush("TextPrimaryBrush"), bold: true);
        _artist = Ui.Link("", () => { if (Shown is { } t) shell.Navigate($"artist:{t.ArtistId}"); }, 12.5);
        _like = Ui.IconButton(Glyphs.Heart, "喜欢", async (_, _) => { if (Shown is { } t) { Motion.Pop(_like!); await shell.Run(() => music.SetLikedAsync(t.Id, !t.Liked)); } }, 32, 15);
        _where.Visibility = Visibility.Collapsed;
        AutomationProperties.SetLiveSetting(_where, Microsoft.UI.Xaml.Automation.Peers.AutomationLiveSetting.Polite);
        var songText = Ui.Column(0, _title, _artist, _error, _where);
        songText.VerticalAlignment = VerticalAlignment.Center;
        songText.MaxWidth = 240;
        // the heart sits right after the title, as in foobar2k (not at the far end of the column)
        var song = new Grid { ColumnSpacing = 12 };
        song.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        song.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        song.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        song.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        song.Children.Add(_art);
        Grid.SetColumn(songText, 1); song.Children.Add(songText);
        Grid.SetColumn(_like, 2); _like.VerticalAlignment = VerticalAlignment.Center; song.Children.Add(_like);

        // middle: the transport and the progress
        _shuffle = Ui.IconToggle(Glyphs.Shuffle, "随机播放", 32, dot: true);
        _shuffle.Click += (_, _) => music.SetOrder(_shuffle.IsChecked == true ? PlaybackOrder.ShuffleTracks : PlaybackOrder.Default);
        _prev = Ui.IconButton(Glyphs.Previous, "上一首", (_, _) => { if (Remote is not null) Send(ConnectCommand.Previous); else music.Previous(); }, 32, 15);
        _play = new Button { Width = 40, Height = 40, CornerRadius = new CornerRadius(20), Padding = new Thickness(0), Background = Ui.Brush("TextPrimaryBrush"), Foreground = Ui.Brush("OnAccentBrush"), BorderThickness = new Thickness(0), FontSize = 16, Content = new KitIcon(Glyphs.Play, 16) };
        _play.Resources["ButtonBackgroundPointerOver"] = Ui.Brush("TextPrimaryBrush");
        _play.Resources["ButtonBackgroundPressed"] = Ui.Brush("TextPrimaryBrush");
        _play.Resources["ButtonForegroundPointerOver"] = Ui.Brush("OnAccentBrush");
        _play.Resources["ButtonForegroundPressed"] = Ui.Brush("OnAccentBrush");
        Motion.Press(_play);
        AutomationProperties.SetName(_play, "播放");
        _play.Click += (_, _) =>
        {
            if (Remote is not null) Send(ConnectCommand.Toggle);
            else if (music.State == PlayerState.Error) music.Resume();
            else music.TogglePlay();
        };
        _next = Ui.IconButton(Glyphs.Next, "下一首", (_, _) => { if (Remote is not null) Send(ConnectCommand.Next); else music.Next(); }, 32, 15);
        _repeat = Ui.IconToggle(Glyphs.Repeat, "循环播放", 32, dot: true);
        _repeat.Click += (_, _) => music.SetOrder(music.Queue.Order switch { PlaybackOrder.RepeatPlaylist => PlaybackOrder.RepeatTrack, PlaybackOrder.RepeatTrack => PlaybackOrder.Default, _ => PlaybackOrder.RepeatPlaylist });
        var transport = Ui.Row(12, _shuffle, _prev, _play, _next, _repeat);
        transport.HorizontalAlignment = HorizontalAlignment.Center;
        AutomationProperties.SetName(_progress, "播放进度");
        _progress.ValueChanged += (_, e) => { if (!_syncing) { _seeking = true; _at.Text = Formats.Duration(e.NewValue); } };
        _progress.PointerCaptureLost += (_, _) => Commit();
        _progress.KeyUp += (_, _) => Commit();
        var progress = new Grid { ColumnSpacing = 8, MaxWidth = 720 };
        progress.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(48) });
        progress.ColumnDefinitions.Add(new ColumnDefinition());
        progress.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(48) });
        _at.HorizontalAlignment = HorizontalAlignment.Right; _at.VerticalAlignment = VerticalAlignment.Center; _length.VerticalAlignment = VerticalAlignment.Center;
        progress.Children.Add(_at);
        Grid.SetColumn(_progress, 1); progress.Children.Add(_progress);
        Grid.SetColumn(_length, 2); progress.Children.Add(_length);
        var middle = Ui.Column(0, transport, progress);
        middle.VerticalAlignment = VerticalAlignment.Center;

        // right: lyrics, queue, devices, output, volume
        _lyrics = Ui.IconToggle(Glyphs.Lyrics, "歌词", 32, dot: true);
        _lyrics.Click += (_, _) => { shell.Navigate(_lyrics.IsChecked == true ? "lyrics" : "back"); };
        _queue = Ui.IconToggle(Glyphs.Queue, "播放队列", 32, dot: true);
        _queue.Click += (_, _) => QueueToggled?.Invoke(_queue.IsChecked == true);
        _devices = Ui.IconButton(Glyphs.Devices, "在其他设备上播放", null, 32, 15);
        _devices.Flyout = DevicesFlyout();
        var devices = new Grid { Visibility = connect.IsAvailable || session is not null ? Visibility.Visible : Visibility.Collapsed };
        devices.Children.Add(_devices); devices.Children.Add(_devicesDot);
        var output = Ui.IconButton(Glyphs.Speaker, "输出设备", null, 32, 15);
        output.Flyout = OutputMenu();
        _mute = Ui.IconButton(Glyphs.Volume, "静音", (_, _) => { if (VolumeTarget is { } d) _session!.SetVolume(d.Id, null, !d.Muted); else music.SetMuted(!music.Muted); }, 32, 15);
        AutomationProperties.SetName(_volume, "音量");
        _volume.ValueChanged += (_, e) =>
        {
            if (_syncing) return;
            if (Remote is null && VolumeTarget is null) music.SetVolume(e.NewValue / 100);
            else { _volumeSend.Stop(); _volumeSend.Start(); } // dragging: the latest value, a few times a second
        };
        _volumeSend.Tick += (_, _) =>
        {
            _volumeSend.Stop();
            if (Remote is not null) Send(ConnectCommand.Volume, c => c with { Level = _volume.Value / 100 });
            else if (VolumeTarget is { } d) _session!.SetVolume(d.Id, _volume.Value / 100); // rule 8: the device that plays
        };
        // shuffle, repeat and mute are this device's own: while the bar controls another they are off, dimmed, with no plate
        var none = new SolidColorBrush(Microsoft.UI.Colors.Transparent);
        foreach (var t in new[] { _shuffle, _repeat }) { t.Resources["ToggleButtonBackgroundDisabled"] = none; t.Resources["ToggleButtonBackgroundCheckedDisabled"] = none; }
        _mute.Resources["ButtonBackgroundDisabled"] = none;
        var right = Ui.Row(4, _lyrics, _queue, devices, output, _mute, _volume);
        right.HorizontalAlignment = HorizontalAlignment.Right; right.VerticalAlignment = VerticalAlignment.Center;

        // the sides are equal (foobar2k's 1 : 2 : 1), so the transport sits on the window's middle line
        var root = new Grid { Padding = new Thickness(16, 8, 16, 8), ColumnSpacing = 12 };
        root.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star), MinWidth = 240 });
        root.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(2, GridUnitType.Star) });
        root.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star), MinWidth = 240 });
        root.Children.Add(song);
        Grid.SetColumn(middle, 1); root.Children.Add(middle);
        Grid.SetColumn(right, 2); root.Children.Add(right);
        AutomationProperties.SetName(root, "播放器");
        Content = root;
        // a narrow window: a shorter volume slider, so the end's buttons stay in their column
        SizeChanged += (_, e) => _volume.Width = e.NewSize.Width < 900 ? 72 : 110;

        music.PlayerChanged += Sync;
        music.TrackChanged += t => { if (t.Id == Shown?.Id) Sync(); };
        music.PositionChanged += p =>
        {
            if (Remote is not null) return; // the bar shows the other device's position
            Known(p);
            if (!_seeking && (!_gliding || Math.Abs(p - _progress.Value) > 1)) ShowPosition(p); // paused, or a jump: at once
        };
        connect.Changed += Sync;
        if (session is not null) session.Changed += Sync;
        Loaded += (_, _) => Glide(Remote?.State?.Playing ?? _music.State == PlayerState.Playing);
        Unloaded += (_, _) => Glide(false);
        Sync();
    }

    public event Action<bool>? QueueToggled;

    public void SetPanelMode(bool queueOpen, bool lyricsOpen) { _queue.IsChecked = queueOpen; _lyrics.IsChecked = lyricsOpen; }

    private void Commit()
    {
        if (!_seeking) return;
        _seeking = false;
        if (Remote is not null) { Send(ConnectCommand.Seek, c => c with { PositionMs = (long)(_progress.Value * 1000) }); Known(_progress.Value); }
        else _music.Seek(_progress.Value);
    }

    private MenuFlyout OutputMenu()
    {
        var menu = new MenuFlyout();
        menu.Opening += async (_, _) =>
        {
            menu.Items.Clear();
            try
            {
                foreach (var d in await AudioEngine.OutputDevicesAsync())
                {
                    var item = new RadioMenuFlyoutItem { Text = d.Id.Length == 0 ? d.Name : d.Name + (d.IsDefault ? "（默认）" : ""), GroupName = "output", IsChecked = d.Id == _music.OutputId };
                    item.Click += (_, _) => _ = _shell.Run(() => _music.SetOutputAsync(d.Id));
                    menu.Items.Add(item);
                }
            }
            catch (Exception ex) { menu.Items.Add(new MenuFlyoutItem { Text = "无法列出输出设备：" + ex.Message, IsEnabled = false }); }
        };
        menu.Items.Add(new MenuFlyoutItem { Text = "正在读取设备…", IsEnabled = false });
        return menu;
    }

    // ---------------------------------------------------------------- devices (Sonus Connect)
    /// <summary>The user's devices, as Spotify's device picker. With version 2: the device that plays on top ("当前设备",
    /// with its volume), then the others on one line each (a click moves playback there; each has a small volume slider,
    /// rule 8). With version 1: this one and the others with what each plays; picking one controls it.</summary>
    private Flyout DevicesFlyout()
    {
        var list = new StackPanel { Width = 300 };
        var flyout = new Flyout { Content = list, Placement = FlyoutPlacementMode.Top };
        flyout.FlyoutPresenterStyle = new Style(typeof(FlyoutPresenter))
        {
            Setters = { new Setter(Control.PaddingProperty, new Thickness(6, 8, 6, 8)), new Setter(Control.CornerRadiusProperty, new CornerRadius(10)) },
        };
        // a test window draws it inside itself: as a popup window of its own it would take the foreground (as menus)
        flyout.ShouldConstrainToRootBounds = Testing.E2EChannel.Enabled || flyout.ShouldConstrainToRootBounds;

        void Heading()
        {
            list.Children.Clear();
            var heading = Ui.Text("在哪台设备上播放", size: 14, foreground: Ui.Brush("TextPrimaryBrush"), bold: true);
            heading.Margin = new Thickness(10, 2, 10, 6);
            list.Children.Add(heading);
        }
        void Note(string text)
        {
            var note = Ui.Note(Glyphs.Info, text);
            note.Margin = new Thickness(10, 4, 10, 4);
            list.Children.Add(note);
        }
        void Caption(string text)
        {
            var caption = Ui.Text(text, size: 12, foreground: Ui.Brush("TextTertiaryBrush"));
            caption.Margin = new Thickness(10, 8, 10, 2);
            list.Children.Add(caption);
        }

        // version 1: each device with what it plays; picking one controls it (and moves what plays here)
        void Fill()
        {
            Heading();
            if (!_connect.IsConnected) { Note("正在连接服务器上的 Sonus Connect…"); return; }
            var m = _music;
            string hereStatus = m.Current is { } t ? $"{(m.IsActive ? "正在播放" : "已暂停")} · {t.Title}" : "空闲";
            list.Children.Add(Row("这台电脑", Glyphs.Devices, hereStatus, m.IsActive, Remote is null, () => _ = _connect.SelectAsync(null)));
            foreach (var d in _connect.Others)
            {
                string status = d.State is { TrackId: not null } s ? $"{(s.Playing ? "正在播放" : "已暂停")} · {s.Title ?? m.Library.Track(s.TrackId)?.Title}" : "空闲";
                list.Children.Add(Row(d.Name, GlyphOf(d.Kind), status, d.State?.Playing == true, Remote?.Id == d.Id, () => _ = _connect.SelectAsync(d)));
            }
            if (_connect.Others.Count == 0) Note("没有其他设备在线。在另一台电脑或手机上打开 Sonus，登录同一个账号，就会出现在这里。");
        }
        Button Row(string name, string glyph, string? status, bool playing, bool current, Action click)
        {
            var grid = Label(name, glyph, status, current, 18);
            if (playing) { var bars = new EqBars(true, 12); Grid.SetColumn(bars, 2); grid.Children.Add(bars); }
            var b = Plain(grid, new Thickness(10, 7, 10, 7));
            b.Resources["ButtonBackgroundPointerOver"] = Ui.Brush("HoverBrush");
            b.Resources["ButtonBackgroundPressed"] = Ui.Brush("HoverBrush");
            AutomationProperties.SetName(b, name);
            if (status is not null) AutomationProperties.SetHelpText(b, status);
            b.Click += (_, _) => { flyout.Hide(); click(); };
            return b;
        }

        // version 2: the session's devices
        string shown = "";
        string Shown(SessionService v2) =>
            $"{v2.IsConnected}|{v2.Session.ActiveDevice}|{v2.Session.Playing}|{v2.Session.Current?.TrackId}|{string.Join(',', v2.Devices.Select(d => d.Id + d.Name + d.CanPlay))}";
        void FillSession(SessionService session)
        {
            shown = Shown(session);
            Heading();
            if (!session.IsConnected) { Note("正在连接服务器上的 Sonus Connect…"); return; }
            var now = session.Session;
            // this computer first, then the others as they joined
            var devices = new List<(string Id, string Name, string Glyph, bool CanPlay, double Volume, bool Muted)> { (session.Id, "这台电脑", Glyphs.Devices, true, _music.Volume, _music.Muted) };
            devices.AddRange(session.Devices.Where(d => d.Id != session.Id).Select(d => (d.Id, d.Name, GlyphOf(d.Kind), d.CanPlay, d.Volume, d.Muted)));
            if (now.ActiveDevice is { } activeId && devices.All(d => d.Id != activeId) && session.ActiveElsewhere is { } gone)
                devices.Add((gone.Id, gone.Name, GlyphOf(gone.Kind), true, gone.Volume, gone.Muted)); // in its grace period
            var active = devices.FirstOrDefault(d => d.Id == now.ActiveDevice);
            if (active.Id is not null)
            {
                string? title = _music.Current?.Title ?? now.Now?.Title;
                list.Children.Add(Current(session, active.Id, active.Name, active.Glyph, $"{(now.Playing ? "正在播放" : "已暂停")}{(title is null ? "" : " · " + title)}", now.Playing, active.Volume, active.Muted));
            }
            var others = devices.Where(d => d.Id != active.Id).ToList();
            if (others.Count > 0) Caption(active.Id is null ? "选择设备" : "选择其他设备");
            foreach (var d in others) list.Children.Add(Other(session, d.Id, d.Name, d.Glyph, d.CanPlay, d.Volume, d.Muted));
            if (devices.Count == 1) Note("没有其他设备在线。在另一台电脑或手机上打开 Sonus，登录同一个账号，就会出现在这里。");
        }

        // the device that plays: a card in the accent colour, with what it plays and its volume
        FrameworkElement Current(SessionService session, string id, string name, string glyph, string status, bool playing, double volume, bool muted)
        {
            var top = Label(name, glyph, status, current: true, 20);
            if (playing) { var bars = new EqBars(true, 12); Grid.SetColumn(bars, 2); top.Children.Add(bars); }
            var level = Volume(session, id, name, volume, muted);
            level.Margin = new Thickness(30, 2, 0, 0); // under the name, past the icon
            var card = new Border
            {
                Background = Ui.Brush("SurfaceBrush"), CornerRadius = new CornerRadius(8), Padding = new Thickness(10, 10, 12, 6), Margin = new Thickness(0, 0, 0, 2),
                Child = Ui.Column(4, top, level),
            };
            AutomationProperties.SetName(card, $"当前设备：{name}");
            return card;
        }

        // another device, on one line: a click moves playback there (rule 4); its volume at the end of the line (rule 8)
        FrameworkElement Other(SessionService session, string id, string name, string glyph, bool canPlay, double volume, bool muted)
        {
            var pick = Plain(Label(name, glyph, canPlay ? null : "只能遥控", current: false, 18), new Thickness(10, 7, 4, 7));
            pick.Resources["ButtonBackgroundPointerOver"] = new SolidColorBrush(Microsoft.UI.Colors.Transparent); // the line lights up instead
            pick.Resources["ButtonBackgroundPressed"] = new SolidColorBrush(Microsoft.UI.Colors.Transparent);
            pick.IsEnabled = canPlay;
            AutomationProperties.SetName(pick, name);
            AutomationProperties.SetHelpText(pick, canPlay ? "在这台设备上播放" : "只能遥控，不能播放");
            pick.Click += (_, _) => { flyout.Hide(); session.Transfer(id); };
            var level = Volume(session, id, name, volume, muted);
            level.Width = 104;
            level.Margin = new Thickness(0, 0, 10, 0);
            var line = new Grid { CornerRadius = new CornerRadius(6), Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent) };
            line.ColumnDefinitions.Add(new ColumnDefinition());
            line.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            line.Children.Add(pick);
            Grid.SetColumn(level, 1); line.Children.Add(level);
            Motion.BrushFade(line);
            line.PointerEntered += (_, _) => line.Background = Ui.Brush("HoverBrush");
            line.PointerExited += (_, _) => line.Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent);
            return line;
        }

        flyout.Opening += (_, _) => { if (_session is { } s) FillSession(s); else Fill(); };
        // focus starts on the first device to pick, not on a volume slider (which would show its focus frame at once)
        flyout.Opened += (_, _) => { if (Ui.Descendant<Button>(list) is { IsEnabled: true } first) first.Focus(FocusState.Programmatic); };
        _connect.Changed += () => { if (flyout.IsOpen && _session is null) Fill(); };
        // drawn again when what it lists changes (not for a volume: a slider being dragged stays)
        if (_session is { } session) session.Changed += () => { if (flyout.IsOpen && shown != Shown(session)) FillSession(session); };
        return flyout;
    }

    /// <summary>A device's icon, name and (when there is one) a status line under it; column 2 is free for the bars.</summary>
    private static Grid Label(string name, string glyph, string? status, bool current, double iconSize)
    {
        var icon = Ui.Icon(glyph, iconSize, current ? Ui.Brush("AccentTextBrush") : Ui.Brush("TextSecondaryBrush"));
        icon.VerticalAlignment = VerticalAlignment.Center;
        var title = Ui.Text(name, size: 14, foreground: current ? Ui.Brush("AccentTextBrush") : Ui.Brush("TextPrimaryBrush"), bold: current);
        title.TextTrimming = TextTrimming.CharacterEllipsis;
        FrameworkElement text = title;
        if (status is not null)
        {
            var sub = Ui.Text(status, size: 12, foreground: Ui.Brush("TextSecondaryBrush"));
            sub.TextTrimming = TextTrimming.CharacterEllipsis;
            text = Ui.Column(0, title, sub);
        }
        text.VerticalAlignment = VerticalAlignment.Center;
        var grid = new Grid { ColumnSpacing = 10 };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(iconSize + 2) });
        grid.ColumnDefinitions.Add(new ColumnDefinition());
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        grid.Children.Add(icon);
        Grid.SetColumn(text, 1); grid.Children.Add(text);
        return grid;
    }

    /// <summary>A flat, full-width button around some content (a device line).</summary>
    private static Button Plain(UIElement content, Thickness padding) => new()
    {
        Content = content, HorizontalAlignment = HorizontalAlignment.Stretch, HorizontalContentAlignment = HorizontalAlignment.Stretch,
        Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent), BorderThickness = new Thickness(0), Padding = padding, CornerRadius = new CornerRadius(6),
    };

    /// <summary>A device's volume in the picker: a speaker and a slim slider, sent a few times a second while dragged.</summary>
    private FrameworkElement Volume(SessionService session, string id, string name, double volume, bool muted)
    {
        var level = new Slider { Minimum = 0, Maximum = 100, StepFrequency = 1, Value = muted ? 0 : volume * 100, IsThumbToolTipEnabled = false, VerticalAlignment = VerticalAlignment.Center };
        // slimmer than the bar's: a 3 px track and a 12 px thumb
        level.Resources["SliderHorizontalHeight"] = 24.0;
        level.Resources["SliderTrackThemeHeight"] = 3.0;
        level.Resources["SliderHorizontalThumbWidth"] = 12.0;
        level.Resources["SliderHorizontalThumbHeight"] = 12.0;
        level.Resources["SliderInnerThumbWidth"] = 6.0;
        level.Resources["SliderInnerThumbHeight"] = 6.0;
        level.Resources["SliderThumbCornerRadius"] = new CornerRadius(6);
        AutomationProperties.SetName(level, $"「{name}」的音量");
        var speaker = Ui.Icon(muted || volume == 0 ? Glyphs.Mute : Glyphs.Volume, 13, Ui.Brush("TextTertiaryBrush"));
        speaker.VerticalAlignment = VerticalAlignment.Center;
        var send = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(120) };
        send.Tick += (_, _) => { send.Stop(); session.SetVolume(id, level.Value / 100, level.Value > 0 && muted ? false : null); };
        level.ValueChanged += (_, e) =>
        {
            speaker.Glyph = e.NewValue == 0 ? Glyphs.Mute : Glyphs.Volume;
            send.Stop(); send.Start();
        };
        var row = new Grid { ColumnSpacing = 8 };
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        row.ColumnDefinitions.Add(new ColumnDefinition());
        row.Children.Add(speaker);
        Grid.SetColumn(level, 1); row.Children.Add(level);
        return row;
    }

    private static string GlyphOf(string kind) => kind switch { "phone" or "tablet" => Glyphs.Headphones, "speaker" => Glyphs.Speaker, _ => Glyphs.Devices };

    // ---------------------------------------------------------------- showing it
    private void Sync()
    {
        if (Remote is { } remote) { SyncRemote(remote); return; }
        var m = _music;
        var t = m.Current;
        _syncing = true;
        ShowSong(t, t is null ? null : m.CoverUrl(t.AlbumId, 128), t?.Title, t?.Artist);
        bool active = m.IsActive;
        ShowPlay(m.State == PlayerState.Error ? Glyphs.Refresh : active ? Glyphs.Pause : Glyphs.Play, m.State == PlayerState.Error ? "重试" : active ? "暂停" : "播放");
        _error.Text = m.State == PlayerState.Error ? m.Error ?? "" : "";
        _error.Visibility = m.State == PlayerState.Error ? Visibility.Visible : Visibility.Collapsed;
        _artist.Visibility = m.State == PlayerState.Error || t is null ? Visibility.Collapsed : Visibility.Visible;
        if (_session is not null && t is null && _session.Session.Now is { } shown) ShowSong(null, shown.CoverArt is { } art ? m.Client.CoverUrl(art, 128) : null, shown.Title, shown.Artist); // a song this library lacks
        // version 2: where the session plays, when not here
        _where.Text = m.Where ?? "";
        _where.Visibility = m.Where is null ? Visibility.Collapsed : Visibility.Visible;
        AutomationProperties.SetName(_where, _where.Text);
        var order = m.Queue.Order;
        _shuffle.IsChecked = order is PlaybackOrder.ShuffleTracks or PlaybackOrder.ShuffleAlbums or PlaybackOrder.ShuffleFolders or PlaybackOrder.Random;
        _repeat.IsChecked = order is PlaybackOrder.RepeatPlaylist or PlaybackOrder.RepeatTrack;
        Ui.SetIcon(_repeat, order == PlaybackOrder.RepeatTrack ? Glyphs.RepeatOne : Glyphs.Repeat, pop: true);
        string repeatName = order == PlaybackOrder.RepeatTrack ? "单曲循环" : order == PlaybackOrder.RepeatPlaylist ? "列表循环" : "循环播放";
        AutomationProperties.SetName(_repeat, repeatName);
        ToolTipService.SetToolTip(_repeat, repeatName);
        foreach (var c in new Control[] { _shuffle, _repeat }) { c.IsEnabled = true; c.Foreground = ((ToggleButton)c).IsChecked == true ? Ui.Brush("AccentTextBrush") : Ui.Brush("TextSecondaryBrush"); }
        _mute.IsEnabled = true;
        double d = m.Duration;
        _progress.Maximum = d > 0 ? d : 1;
        _progress.IsEnabled = t is not null;
        _length.Text = Formats.Duration(d);
        if (!_seeking && (!_gliding || Math.Abs(m.Position - _progress.Value) > 1)) ShowPosition(m.Position);
        Glide(m.State == PlayerState.Playing);
        var (volume, muted) = VolumeTarget is { } target ? (target.Volume, target.Muted) : (m.Volume, m.Muted);
        if (!_volumeSend.IsEnabled) _volume.Value = volume * 100; // not while the user's own change is on its way
        Ui.SetIcon(_mute, muted || volume == 0 ? Glyphs.Mute : Glyphs.Volume);
        AutomationProperties.SetName(_mute, muted ? "取消静音" : "静音");
        ShowDevicesButton();
        _syncing = false;
    }

    /// <summary>Another device's playback: its song (from this library when it has it), position and volume; shuffle,
    /// repeat and mute are that device's own and are not offered from here.</summary>
    private void SyncRemote(ConnectDevice remote)
    {
        var s = remote.State;
        var t = _music.Library.Track(s?.TrackId);
        _syncing = true;
        string? cover = t is not null ? _music.CoverUrl(t.AlbumId, 128) : s?.CoverArt is { } art ? _music.Client.CoverUrl(art, 128) : null;
        ShowSong(t, cover, t?.Title ?? s?.Title, t?.Artist ?? s?.Artist);
        bool playing = s?.Playing == true;
        ShowPlay(playing ? Glyphs.Pause : Glyphs.Play, playing ? "暂停" : "播放");
        _error.Visibility = Visibility.Collapsed;
        _artist.Visibility = s?.TrackId is null ? Visibility.Collapsed : Visibility.Visible;
        _where.Text = $"正在「{remote.Name}」上播放";
        _where.Visibility = Visibility.Visible;
        AutomationProperties.SetName(_where, _where.Text);
        foreach (var c in new Control[] { _shuffle, _repeat }) { c.IsEnabled = false; c.Foreground = Ui.Brush("TextTertiaryBrush"); }
        _mute.IsEnabled = false;
        double d = s is { DurationMs: > 0 } ? s.DurationMs / 1000.0 : t?.Duration ?? 0;
        _progress.Maximum = d > 0 ? d : 1;
        _progress.IsEnabled = s?.TrackId is not null;
        _length.Text = Formats.Duration(d);
        double at = s is null ? 0 : s.PositionAt(_connect.ServerNow) / 1000.0;
        Known(at);
        if (!_seeking) ShowPosition(at);
        Glide(playing);
        if (s?.Volume is { } v) _volume.Value = v * 100;
        ShowDevicesButton();
        _syncing = false;
    }

    private void ShowSong(Track? t, string? cover, string? title, string? artist)
    {
        _art.Url = cover;
        ((TextBlock)_title.Content).Text = title ?? "";
        ((TextBlock)_artist.Content).Text = artist ?? "";
        AutomationProperties.SetName(_title, title ?? "");
        AutomationProperties.SetName(_artist, artist ?? "");
        _like.Visibility = t is null ? Visibility.Collapsed : Visibility.Visible;
        _title.Visibility = title is null ? Visibility.Collapsed : Visibility.Visible; // no song: no empty links
        Ui.SetIcon(_like, t?.Liked == true ? Glyphs.HeartFill : Glyphs.Heart);
        _like.Foreground = t?.Liked == true ? Ui.Brush("AccentBrush") : Ui.Brush("TextSecondaryBrush");
        AutomationProperties.SetName(_like, t?.Liked == true ? "取消喜欢" : "喜欢");
    }

    private void ShowPlay(string glyph, string name)
    {
        Ui.SetIcon(_play, glyph, pop: true);
        AutomationProperties.SetName(_play, name);
        ToolTipService.SetToolTip(_play, name);
    }

    /// <summary>The devices button: in the accent colour while controlling another device, with a dot while another plays.</summary>
    private void ShowDevicesButton()
    {
        if (_session is { } session)
        {
            var elsewhere = session.ActiveElsewhere;
            _devices.Foreground = elsewhere is not null ? Ui.Brush("AccentTextBrush") : Ui.Brush("TextSecondaryBrush");
            _devicesDot.Visibility = elsewhere is not null && session.Session.Playing ? Visibility.Visible : Visibility.Collapsed;
            string label = elsewhere is not null ? $"正在「{elsewhere.Name}」上播放，选择设备" : "在其他设备上播放";
            AutomationProperties.SetName(_devices, label);
            ToolTipService.SetToolTip(_devices, label);
            return;
        }
        bool remote = Remote is not null;
        _devices.Foreground = remote ? Ui.Brush("AccentTextBrush") : Ui.Brush("TextSecondaryBrush");
        _devicesDot.Visibility = remote || _connect.OtherPlaying ? Visibility.Visible : Visibility.Collapsed;
        string name = remote ? $"正在「{Remote!.Name}」上播放，选择设备" : "在其他设备上播放";
        AutomationProperties.SetName(_devices, name);
        ToolTipService.SetToolTip(_devices, name);
    }
}
