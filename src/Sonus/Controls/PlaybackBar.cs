using Sonus.Core;
using Sonus.Core.Connect;
using Sonus.Playback;
using Sonus.Services;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Microsoft.UI.Xaml.Hosting;
using Microsoft.UI.Xaml.Media;

namespace Sonus.Controls;

/// <summary>The bar along the bottom: the song (cover, title, artist, like), the transport (shuffle, previous, play, next,
/// repeat) with the progress, and lyrics / queue / devices / output / volume. With Sonus Connect it can show and
/// control another of the user's devices instead of this one (ConnectService.Target): the song, the position and the
/// buttons are then that device's. With version 2 (SessionService) the bar always shows the user's one session (MusicService
/// follows it), and the volume is that of the device that plays. As in Spotify, a strip in the accent colour under the bar
/// says where it plays while another device does ("正在「手机」上播放"; a click opens the devices), the line under the
/// song says where it played last when none does, and the devices button opens the right panel's devices.</summary>
public sealed class PlaybackBar : UserControl
{
    private readonly MusicService _music;
    private readonly ConnectService _connect;
    private readonly SessionService? _session;
    private readonly IShell _shell;
    private readonly Artwork _art = new(56, false, Glyphs.Music, 4);
    private readonly StackPanel _songText;
    private readonly HyperlinkButton _title, _artist;
    private readonly Button _like, _play, _prev, _next;
    private readonly ToggleButton _shuffle, _repeat, _lyrics, _queue, _devices;
    private readonly Slider _progress = new() { Minimum = 0, Maximum = 1, StepFrequency = 0.1, IsThumbToolTipEnabled = false, VerticalAlignment = VerticalAlignment.Center };
    private readonly TextBlock _at = Ui.Text("0:00", "FigureTextStyle"), _length = Ui.Text("0:00", "FigureTextStyle");
    private readonly Slider _volume = new() { Minimum = 0, Maximum = 100, Width = 110, StepFrequency = 1, IsThumbToolTipEnabled = false, VerticalAlignment = VerticalAlignment.Center };
    private readonly Button _mute;
    private readonly TextBlock _error = Ui.Text("", size: 12, foreground: Ui.Brush("BadBrush"));
    private readonly TextBlock _where = Ui.Text("", size: 12, foreground: Ui.Brush("AccentTextBrush"));
    private readonly TextBlock _qualityText = Ui.Text("", size: 10.5, foreground: Ui.Brush("TextSecondaryBrush"), bold: true);
    private readonly Border _qualityBadge = new()
    {
        HorizontalAlignment = HorizontalAlignment.Left,
        Padding = new Thickness(6, 1, 6, 1),
        Margin = new Thickness(0, 3, 0, 0),
        CornerRadius = new CornerRadius(4),
        BorderThickness = new Thickness(1),
        Visibility = Visibility.Collapsed,
    };
    // Spotify's strip under the bar while another device plays
    private readonly TextBlock _elsewhereText = Ui.Text("", size: 12.5, foreground: Ui.Brush("OnAccentBrush"), bold: true);
    private readonly Button _elsewhere = new() { HorizontalAlignment = HorizontalAlignment.Stretch, HorizontalContentAlignment = HorizontalAlignment.Right, Height = 26, Margin = new Thickness(8, 0, 8, 6), Padding = new Thickness(12, 0, 12, 0), CornerRadius = new CornerRadius(4), BorderThickness = new Thickness(0), Visibility = Visibility.Collapsed };
    private readonly DispatcherTimer _volumeSend = new() { Interval = TimeSpan.FromMilliseconds(120) };
    private bool _seeking, _syncing;
    private string? _shownTrackKey;
    private bool _elsewhereShown, _elsewhereLeaving;
    private int _elsewhereMoves;

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
        // left: the song
        _title = Ui.Link("", () => { if (Shown is { } t) shell.Navigate($"album:{t.AlbumId}"); }, 14, Ui.Brush("TextPrimaryBrush"), bold: true);
        _artist = Ui.Link("", () => { if (Shown is { } t) shell.Navigate($"artist:{t.ArtistId}"); }, 12.5);
        // the heart swells inside the button: Press scales the button itself, so Pop on the button would throw (see Motion.Pop)
        _like = Ui.IconButton(Glyphs.Heart, "喜欢", async (_, _) => { if (Shown is { } t) { Motion.PopIcon(_like!, 1.28f); await shell.Run(() => music.SetLikedAsync(t.Id, !t.Liked)); } }, 32, 15);
        Motion.Press(_like);
        _where.Visibility = Visibility.Collapsed;
        AutomationProperties.SetLiveSetting(_where, Microsoft.UI.Xaml.Automation.Peers.AutomationLiveSetting.Polite);
        _qualityBadge.Background = Ui.Brush("HoverBrush");
        _qualityBadge.BorderBrush = Ui.Brush("SurfaceHoverBrush");
        _qualityBadge.Child = _qualityText;
        var songText = _songText = Ui.Column(0, _title, _artist, _qualityBadge, _error, _where);
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
        Motion.Press(_shuffle);
        _shuffle.Click += (_, _) => { Motion.PopIcon(_shuffle); music.SetOrder(_shuffle.IsChecked == true ? PlaybackOrder.ShuffleTracks : PlaybackOrder.Default); };
        _prev = Ui.IconButton(Glyphs.Previous, "上一首", (_, _) => { if (Remote is not null) Send(ConnectCommand.Previous); else music.Previous(); }, 32, 15);
        Motion.Press(_prev);
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
        Motion.Press(_next);
        _repeat = Ui.IconToggle(Glyphs.Repeat, "循环播放", 32, dot: true);
        Motion.Press(_repeat);
        _repeat.Click += (_, _) => { Motion.PopIcon(_repeat); music.SetOrder(music.Queue.Order switch { PlaybackOrder.RepeatPlaylist => PlaybackOrder.RepeatTrack, PlaybackOrder.RepeatTrack => PlaybackOrder.Default, _ => PlaybackOrder.RepeatPlaylist }); };
        var transport = Ui.Row(12, _shuffle, _prev, _play, _next, _repeat);
        transport.HorizontalAlignment = HorizontalAlignment.Center;
        AutomationProperties.SetName(_progress, "播放进度");
        StyleSlimSlider(_progress, whiteAtRest: true);
        _progress.ValueChanged += (_, e) => { if (!_syncing) { _seeking = true; _at.Text = Formats.Duration(e.NewValue); } };
        _progress.PointerCaptureLost += (_, _) => Commit();
        _progress.KeyUp += (_, _) => Commit();
        var atCol = new ColumnDefinition { Width = new GridLength(48) };
        var lenCol = new ColumnDefinition { Width = new GridLength(48) };
        var progress = new Grid { ColumnSpacing = 8, MaxWidth = 720 };
        progress.ColumnDefinitions.Add(atCol);
        progress.ColumnDefinitions.Add(new ColumnDefinition());
        progress.ColumnDefinitions.Add(lenCol);
        _at.HorizontalAlignment = HorizontalAlignment.Right; _at.VerticalAlignment = VerticalAlignment.Center; _length.VerticalAlignment = VerticalAlignment.Center;
        progress.Children.Add(_at);
        Grid.SetColumn(_progress, 1); progress.Children.Add(_progress);
        Grid.SetColumn(_length, 2); progress.Children.Add(_length);
        var middle = Ui.Column(0, transport, progress);
        middle.VerticalAlignment = VerticalAlignment.Center;

        // right: lyrics, queue, devices, output, volume
        _lyrics = Ui.IconToggle(Glyphs.Lyrics, "歌词", 32, dot: true);
        Motion.Press(_lyrics);
        _lyrics.Click += (_, _) => { Motion.PopIcon(_lyrics); shell.Navigate(_lyrics.IsChecked == true ? "lyrics" : "back"); };
        _queue = Ui.IconToggle(Glyphs.Queue, "播放队列", 32, dot: true);
        Motion.Press(_queue);
        _queue.Click += (_, _) => { Motion.PopIcon(_queue); QueueToggled?.Invoke(_queue.IsChecked == true); };
        _devices = Ui.IconToggle(Glyphs.Devices, "在其他设备上播放", 32, dot: true);
        _devices.Visibility = connect.IsAvailable || session is not null ? Visibility.Visible : Visibility.Collapsed;
        Motion.Press(_devices);
        _devices.Click += (_, _) => { Motion.PopIcon(_devices); DevicesToggled?.Invoke(_devices.IsChecked == true); };
        var output = Ui.IconButton(Glyphs.Speaker, "输出设备", null, 32, 15);
        Motion.Press(output);
        output.Flyout = OutputMenu();
        _mute = Ui.IconButton(Glyphs.Volume, "静音", (_, _) => { Motion.PopIcon(_mute!); if (VolumeTarget is { } d) _session!.SetVolume(d.Id, null, !d.Muted); else music.SetMuted(!music.Muted); }, 32, 15);
        Motion.Press(_mute);
        AutomationProperties.SetName(_volume, "音量");
        StyleSlimSlider(_volume, whiteAtRest: false);
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
        var right = Ui.Row(4, _lyrics, _queue, _devices, output, _mute, _volume);
        right.HorizontalAlignment = HorizontalAlignment.Right; right.VerticalAlignment = VerticalAlignment.Center;

        // the sides are equal (foobar2k's 1 : 2 : 1), so the transport sits on the window's middle line
        var leftCol = new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star), MinWidth = 240 };
        var rightCol = new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star), MinWidth = 240 };
        var root = new Grid { Padding = new Thickness(16, 8, 16, 8), ColumnSpacing = 12, Height = 88 }; // the transport (40) and the progress row (32) between 8 px paddings
        root.ColumnDefinitions.Add(leftCol);
        root.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(2, GridUnitType.Star) });
        root.ColumnDefinitions.Add(rightCol);
        root.Children.Add(song);
        Grid.SetColumn(middle, 1); root.Children.Add(middle);
        Grid.SetColumn(right, 2); root.Children.Add(right);
        AutomationProperties.SetName(root, "播放器");
        var accent = Ui.Brush("AccentBrush");
        _elsewhere.Background = accent;
        _elsewhere.Resources["ButtonBackgroundPointerOver"] = Ui.Brush("AccentHiBrush");
        _elsewhere.Resources["ButtonBackgroundPressed"] = Ui.Brush("AccentHiBrush");
        _elsewhere.Content = Ui.Row(6, Ui.Icon(Glyphs.Devices, 14, Ui.Brush("OnAccentBrush")), _elsewhereText);
        _elsewhere.Click += (_, _) => { _devices.IsChecked = true; DevicesToggled?.Invoke(true); };
        // clipped so the amber strip rises cleanly from the bottom edge
        var elsewhereHost = new Grid { Children = { _elsewhere } };
        var elsewhereVisual = ElementCompositionPreview.GetElementVisual(elsewhereHost);
        elsewhereVisual.Clip = elsewhereVisual.Compositor.CreateInsetClip();
        Content = Ui.Column(0, root, elsewhereHost);
        // narrow windows: tighten both ends so the seek bar keeps comfortable room instead of collapsing to a stub
        SizeChanged += (_, e) =>
        {
            bool narrow = e.NewSize.Width < 900;
            _volume.Width = narrow ? 58 : 110;
            right.Spacing = narrow ? 1 : 4;
            leftCol.MinWidth = narrow ? 172 : 240;
            rightCol.MinWidth = narrow ? 222 : 240;
            songText.MaxWidth = narrow ? 116 : 240;
            atCol.Width = lenCol.Width = new GridLength(narrow ? 38 : 48);
            progress.ColumnSpacing = narrow ? 6 : 8;
            root.ColumnSpacing = narrow ? 8 : 12;
        };

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

    /// <summary>Matches DevicesView's slim 3 px track / 12 px thumb geometry; the seek bar sits in white at rest and
    /// lights up in amber on hover or drag (foobar2k's .ui-seek).</summary>
    private static void StyleSlimSlider(Slider s, bool whiteAtRest)
    {
        s.Resources["SliderHorizontalHeight"] = 24.0;
        s.Resources["SliderTrackThemeHeight"] = 3.0;
        s.Resources["SliderHorizontalThumbWidth"] = 12.0;
        s.Resources["SliderHorizontalThumbHeight"] = 12.0;
        s.Resources["SliderInnerThumbWidth"] = 6.0;
        s.Resources["SliderInnerThumbHeight"] = 6.0;
        s.Resources["SliderThumbCornerRadius"] = new CornerRadius(6);
        if (!whiteAtRest) return;
        s.Resources["SliderTrackValueFill"] = Ui.Brush("TextPrimaryBrush");
        s.Resources["SliderTrackValueFillPointerOver"] = Ui.Brush("AccentBrush");
        s.Resources["SliderTrackValueFillPressed"] = Ui.Brush("AccentBrush");
        s.Resources["SliderThumbBackground"] = Ui.Brush("TextPrimaryBrush");
        s.Resources["SliderThumbBackgroundPointerOver"] = Ui.Brush("AccentHiBrush");
        s.Resources["SliderThumbBackgroundPressed"] = Ui.Brush("AccentBrush");
    }

    public event Action<bool>? QueueToggled;
    /// <summary>The devices button: the right panel shows the devices (true) or Now playing (false).</summary>
    public event Action<bool>? DevicesToggled;

    public void SetPanelMode(bool queueOpen, bool lyricsOpen, bool devicesOpen) { _queue.IsChecked = queueOpen; _lyrics.IsChecked = lyricsOpen; _devices.IsChecked = devicesOpen; }

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
        // version 2: where it played last, when none plays (where it plays now: the strip)
        string? last = _session is { } v2 && v2.ActiveElsewhere is null ? m.Where : null;
        _where.Text = last ?? "";
        _where.Visibility = last is null ? Visibility.Collapsed : Visibility.Visible;
        AutomationProperties.SetName(_where, _where.Text);
        var badge = m.QualityBadge;
        bool showBadge = m.State != PlayerState.Error && last is null && !string.IsNullOrEmpty(badge.Text);
        _qualityText.Text = badge.Text;
        _qualityText.Foreground = badge.IsLossless ? Ui.Brush("AccentTextBrush") : Ui.Brush("TextSecondaryBrush");
        _qualityBadge.BorderBrush = badge.IsLossless ? Ui.Brush("AccentBrush") : Ui.Brush("SurfaceHoverBrush");
        _qualityBadge.Visibility = showBadge ? Visibility.Visible : Visibility.Collapsed;
        AutomationProperties.SetName(_qualityText, showBadge ? $"当前音质：{badge.Text}" : "");
        ToolTipService.SetToolTip(_qualityBadge, showBadge ? badge.Text : null);
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
        _qualityBadge.Visibility = Visibility.Collapsed;
        _where.Visibility = Visibility.Collapsed; // the strip says it
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
        string? key = t?.Id ?? (title is null ? null : $"{title}|{artist}");
        bool changed = key is not null && key != _shownTrackKey && IsLoaded;
        _shownTrackKey = key;
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
        if (changed)
        {
            Motion.ScaleIn(_art, 0.88f);
            Motion.Enter(_songText, rise: 0, slide: -10, move: TimeSpan.FromMilliseconds(240));
        }
    }

    private void ShowPlay(string glyph, string name)
    {
        Ui.SetIcon(_play, glyph, pop: true);
        AutomationProperties.SetName(_play, name);
        ToolTipService.SetToolTip(_play, name);
    }

    /// <summary>The devices button, named for where it plays; and the strip under the bar while another device plays.</summary>
    private void ShowDevicesButton()
    {
        string? elsewhere = _session is { } session ? session.ActiveElsewhere?.Name : Remote?.Name;
        string label = elsewhere is not null ? $"正在「{elsewhere}」上播放，选择设备" : "在其他设备上播放";
        AutomationProperties.SetName(_devices, label);
        ToolTipService.SetToolTip(_devices, label);
        _elsewhereText.Text = elsewhere is null ? "" : $"正在「{elsewhere}」上播放";
        AutomationProperties.SetName(_elsewhere, _elsewhereText.Text);
        bool show = elsewhere is not null;
        if (show)
        {
            bool wasLeaving = _elsewhereLeaving;
            bool wasShown = _elsewhereShown;
            _elsewhereShown = true;
            _elsewhere.Visibility = Visibility.Visible;
            _elsewhere.IsHitTestVisible = true;
            if (wasLeaving)
            {
                _elsewhereMoves++;
                _elsewhereLeaving = false;
                Motion.SlideBack(_elsewhere, TimeSpan.FromMilliseconds(240));
            }
            else if (!wasShown && IsLoaded)
            {
                Motion.Enter(_elsewhere, rise: 18, move: TimeSpan.FromMilliseconds(240));
                Motion.PopIcon(_devices, 1.16f);
            }
        }
        else if (_elsewhereShown)
        {
            _elsewhereShown = false;
            int move = ++_elsewhereMoves;
            if (IsLoaded && Motion.Enabled)
            {
                _elsewhereLeaving = true;
                _elsewhere.IsHitTestVisible = false;
                Motion.SlideOut(_elsewhere, () => { if (move == _elsewhereMoves) { _elsewhereLeaving = false; _elsewhere.Visibility = Visibility.Collapsed; } }, drop: 18);
            }
            else _elsewhere.Visibility = Visibility.Collapsed;
        }
    }
}
