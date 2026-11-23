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
/// buttons are then that device's, and a line in the accent colour says which device plays.</summary>
public sealed class PlaybackBar : UserControl
{
    private readonly MusicService _music;
    private readonly ConnectService _connect;
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

    public PlaybackBar(MusicService music, ConnectService connect, IShell shell)
    {
        _music = music; _connect = connect; _shell = shell;
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
        var devices = new Grid { Visibility = connect.IsAvailable ? Visibility.Visible : Visibility.Collapsed };
        devices.Children.Add(_devices); devices.Children.Add(_devicesDot);
        var output = Ui.IconButton(Glyphs.Speaker, "输出设备", null, 32, 15);
        output.Flyout = OutputMenu();
        _mute = Ui.IconButton(Glyphs.Volume, "静音", (_, _) => music.SetMuted(!music.Muted), 32, 15);
        AutomationProperties.SetName(_volume, "音量");
        _volume.ValueChanged += (_, e) =>
        {
            if (_syncing) return;
            if (Remote is null) music.SetVolume(e.NewValue / 100);
            else { _volumeSend.Stop(); _volumeSend.Start(); } // dragging: the latest value, a few times a second
        };
        _volumeSend.Tick += (_, _) => { _volumeSend.Stop(); if (Remote is not null) Send(ConnectCommand.Volume, c => c with { Level = _volume.Value / 100 }); };
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
    /// <summary>The user's devices, as Spotify's device picker: this one, then the others with what they play; picking
    /// one plays there (what plays moves along) and the bar controls it.</summary>
    private Flyout DevicesFlyout()
    {
        var list = new StackPanel { Spacing = 2, Width = 320, Padding = new Thickness(4) };
        var flyout = new Flyout { Content = list, Placement = FlyoutPlacementMode.Top };
        // a test window draws it inside itself: as a popup window of its own it would take the foreground (as menus)
        flyout.ShouldConstrainToRootBounds = Testing.E2EChannel.Enabled || flyout.ShouldConstrainToRootBounds;
        void Fill()
        {
            list.Children.Clear();
            var heading = Ui.Text("在哪台设备上播放", size: 15, foreground: Ui.Brush("TextPrimaryBrush"), bold: true);
            heading.Margin = new Thickness(8, 4, 8, 8);
            list.Children.Add(heading);
            if (!_connect.IsConnected)
            {
                var note = Ui.Note(Glyphs.Info, "正在连接服务器上的 Sonus Connect…");
                note.Margin = new Thickness(8, 0, 8, 8);
                list.Children.Add(note);
                return;
            }
            var m = _music;
            string hereStatus = m.Current is { } t ? $"{(m.IsActive ? "正在播放" : "已暂停")} · {t.Title}" : "空闲";
            list.Children.Add(Row(null, "这台电脑", Glyphs.Devices, hereStatus, m.IsActive, Remote is null));
            foreach (var d in _connect.Others)
            {
                string status = d.State is { TrackId: not null } s ? $"{(s.Playing ? "正在播放" : "已暂停")} · {s.Title ?? m.Library.Track(s.TrackId)?.Title}" : "空闲";
                string glyph = d.Kind switch { "phone" => Glyphs.Headphones, "speaker" => Glyphs.Speaker, _ => Glyphs.Devices };
                list.Children.Add(Row(d, d.Name, glyph, status, d.State?.Playing == true, Remote?.Id == d.Id));
            }
            if (_connect.Others.Count == 0)
            {
                var note = Ui.Note(Glyphs.Info, "没有其他设备在线。在另一台电脑或手机上打开 Sonus，登录同一个账号，就会出现在这里。");
                note.Margin = new Thickness(8, 4, 8, 8);
                list.Children.Add(note);
            }
        }
        Button Row(ConnectDevice? device, string name, string glyph, string status, bool playing, bool current)
        {
            var icon = Ui.Icon(glyph, 18, current ? Ui.Brush("AccentTextBrush") : Ui.Brush("TextSecondaryBrush"));
            var title = Ui.Text(name, size: 14, foreground: current ? Ui.Brush("AccentTextBrush") : Ui.Brush("TextPrimaryBrush"), bold: current);
            var sub = Ui.Text(status, size: 12, foreground: Ui.Brush("TextSecondaryBrush"));
            var text = Ui.Column(1, title, sub);
            text.VerticalAlignment = VerticalAlignment.Center;
            var grid = new Grid { ColumnSpacing = 12 };
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(24) });
            grid.ColumnDefinitions.Add(new ColumnDefinition());
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            grid.Children.Add(icon);
            Grid.SetColumn(text, 1); grid.Children.Add(text);
            if (playing) { var bars = new EqBars(true, 12); Grid.SetColumn(bars, 2); grid.Children.Add(bars); }
            var b = new Button
            {
                Content = grid, HorizontalAlignment = HorizontalAlignment.Stretch, HorizontalContentAlignment = HorizontalAlignment.Stretch,
                Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent), BorderThickness = new Thickness(0), Padding = new Thickness(8, 8, 8, 8), CornerRadius = new CornerRadius(6),
            };
            b.Resources["ButtonBackgroundPointerOver"] = Ui.Brush("HoverBrush");
            b.Resources["ButtonBackgroundPressed"] = Ui.Brush("HoverBrush");
            AutomationProperties.SetName(b, name);
            AutomationProperties.SetHelpText(b, status);
            b.Click += async (_, _) => { flyout.Hide(); await _connect.SelectAsync(device); };
            return b;
        }
        flyout.Opening += (_, _) => Fill();
        _connect.Changed += () => { if (flyout.IsOpen) Fill(); };
        return flyout;
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
        _where.Visibility = Visibility.Collapsed;
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
        _volume.Value = m.Volume * 100;
        Ui.SetIcon(_mute, m.Muted || m.Volume == 0 ? Glyphs.Mute : Glyphs.Volume);
        AutomationProperties.SetName(_mute, m.Muted ? "取消静音" : "静音");
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
        bool remote = Remote is not null;
        _devices.Foreground = remote ? Ui.Brush("AccentTextBrush") : Ui.Brush("TextSecondaryBrush");
        _devicesDot.Visibility = remote || _connect.OtherPlaying ? Visibility.Visible : Visibility.Collapsed;
        string name = remote ? $"正在「{Remote!.Name}」上播放，选择设备" : "在其他设备上播放";
        AutomationProperties.SetName(_devices, name);
        ToolTipService.SetToolTip(_devices, name);
    }
}
