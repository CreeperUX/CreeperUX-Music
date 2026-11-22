using CreeperUX.Music.Core;
using CreeperUX.Music.Playback;
using CreeperUX.Music.Services;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Microsoft.UI.Xaml.Media;

namespace CreeperUX.Music.Controls;

/// <summary>The bar along the bottom: the song (cover, title, artist, like), the transport (shuffle, previous, play, next,
/// repeat) with the progress, and lyrics / queue / output / volume.</summary>
public sealed class PlaybackBar : UserControl
{
    private readonly MusicService _music;
    private readonly IShell _shell;
    private readonly Artwork _art = new(56, false, Glyphs.Music, 4);
    private readonly HyperlinkButton _title, _artist;
    private readonly Button _like, _play, _prev, _next;
    private readonly ToggleButton _shuffle, _repeat, _lyrics, _queue;
    private readonly Slider _progress = new() { Minimum = 0, Maximum = 1, StepFrequency = 0.1, IsThumbToolTipEnabled = false, VerticalAlignment = VerticalAlignment.Center };
    private readonly TextBlock _at = Ui.Text("0:00", "FigureTextStyle"), _length = Ui.Text("0:00", "FigureTextStyle");
    private readonly Slider _volume = new() { Minimum = 0, Maximum = 100, Width = 110, StepFrequency = 1, VerticalAlignment = VerticalAlignment.Center };
    private readonly Button _mute;
    private readonly TextBlock _error = Ui.Text("", size: 12, foreground: Ui.Brush("BadBrush"));
    private bool _seeking, _syncing;

    // The position between the service's updates (four a second), carried on frame by frame while playing, so the bar
    // glides instead of stepping. A little ahead of the engine, it waits for it rather than stepping back.
    private double _knownAt;
    private long _knownWhen;
    private bool _gliding;

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

    public PlaybackBar(MusicService music, IShell shell)
    {
        _music = music; _shell = shell;
        Height = 88; // the transport (40) and the progress row (32) between 8 px paddings
        // left: the song
        _title = Ui.Link("", () => { if (music.Current is { } t) shell.Navigate($"album:{t.AlbumId}"); }, 14, Ui.Brush("TextPrimaryBrush"), bold: true);
        _artist = Ui.Link("", () => { if (music.Current is { } t) shell.Navigate($"artist:{t.ArtistId}"); }, 12.5);
        _like = Ui.IconButton(Glyphs.Heart, "喜欢", async (_, _) => { if (music.Current is { } t) { Motion.Pop(_like!); await shell.Run(() => music.SetLikedAsync(t.Id, !t.Liked)); } }, 32, 15);
        var songText = Ui.Column(0, _title, _artist, _error);
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
        _prev = Ui.IconButton(Glyphs.Previous, "上一首", (_, _) => music.Previous(), 32, 15);
        _play = new Button { Width = 40, Height = 40, CornerRadius = new CornerRadius(20), Padding = new Thickness(0), Background = Ui.Brush("TextPrimaryBrush"), Foreground = Ui.Brush("OnAccentBrush"), BorderThickness = new Thickness(0), FontSize = 16, Content = new KitIcon(Glyphs.Play, 16) };
        _play.Resources["ButtonBackgroundPointerOver"] = Ui.Brush("TextPrimaryBrush");
        _play.Resources["ButtonBackgroundPressed"] = Ui.Brush("TextPrimaryBrush");
        _play.Resources["ButtonForegroundPointerOver"] = Ui.Brush("OnAccentBrush");
        _play.Resources["ButtonForegroundPressed"] = Ui.Brush("OnAccentBrush");
        Motion.Press(_play);
        AutomationProperties.SetName(_play, "播放");
        _play.Click += (_, _) => { if (music.State == PlayerState.Error) music.Resume(); else music.TogglePlay(); };
        _next = Ui.IconButton(Glyphs.Next, "下一首", (_, _) => music.Next(), 32, 15);
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

        // right: lyrics, queue, output, volume
        _lyrics = Ui.IconToggle(Glyphs.Lyrics, "歌词", 32, dot: true);
        _lyrics.Click += (_, _) => { shell.Navigate(_lyrics.IsChecked == true ? "lyrics" : "back"); };
        _queue = Ui.IconToggle(Glyphs.Queue, "播放队列", 32, dot: true);
        _queue.Click += (_, _) => QueueToggled?.Invoke(_queue.IsChecked == true);
        var output = Ui.IconButton(Glyphs.Speaker, "输出设备", null, 32, 15);
        output.Flyout = OutputMenu();
        _mute = Ui.IconButton(Glyphs.Volume, "静音", (_, _) => music.SetMuted(!music.Muted), 32, 15);
        AutomationProperties.SetName(_volume, "音量");
        _volume.ValueChanged += (_, e) => { if (!_syncing) music.SetVolume(e.NewValue / 100); };
        var right = Ui.Row(4, _lyrics, _queue, output, _mute, _volume);
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
        music.TrackChanged += t => { if (t.Id == music.Queue.Current) Sync(); };
        music.PositionChanged += p =>
        {
            _knownAt = p; _knownWhen = System.Diagnostics.Stopwatch.GetTimestamp();
            if (!_seeking && (!_gliding || Math.Abs(p - _progress.Value) > 1)) ShowPosition(p); // paused, or a jump: at once
        };
        Loaded += (_, _) => Glide(_music.State == PlayerState.Playing);
        Unloaded += (_, _) => Glide(false);
        Sync();
    }

    public event Action<bool>? QueueToggled;

    public void SetPanelMode(bool queueOpen, bool lyricsOpen) { _queue.IsChecked = queueOpen; _lyrics.IsChecked = lyricsOpen; }

    private void Commit()
    {
        if (!_seeking) return;
        _seeking = false;
        _music.Seek(_progress.Value);
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

    private void Sync()
    {
        var m = _music;
        var t = m.Current;
        _syncing = true;
        _art.Url = t is null ? null : m.CoverUrl(t.AlbumId, 128);
        ((TextBlock)_title.Content).Text = t?.Title ?? "";
        ((TextBlock)_artist.Content).Text = t?.Artist ?? "";
        AutomationProperties.SetName(_title, t?.Title ?? "");
        AutomationProperties.SetName(_artist, t?.Artist ?? "");
        _like.Visibility = t is null ? Visibility.Collapsed : Visibility.Visible;
        _title.Visibility = t is null ? Visibility.Collapsed : Visibility.Visible; // no song: no empty links
        Ui.SetIcon(_like, t?.Liked == true ? Glyphs.HeartFill : Glyphs.Heart);
        _like.Foreground = t?.Liked == true ? Ui.Brush("AccentBrush") : Ui.Brush("TextSecondaryBrush");
        AutomationProperties.SetName(_like, t?.Liked == true ? "取消喜欢" : "喜欢");
        bool active = m.IsActive;
        Ui.SetIcon(_play, m.State == PlayerState.Error ? Glyphs.Refresh : active ? Glyphs.Pause : Glyphs.Play, pop: true);
        string playName = m.State == PlayerState.Error ? "重试" : active ? "暂停" : "播放";
        AutomationProperties.SetName(_play, playName);
        ToolTipService.SetToolTip(_play, playName);
        _error.Text = m.State == PlayerState.Error ? m.Error ?? "" : "";
        _error.Visibility = m.State == PlayerState.Error ? Visibility.Visible : Visibility.Collapsed;
        _artist.Visibility = m.State == PlayerState.Error || t is null ? Visibility.Collapsed : Visibility.Visible;
        var order = m.Queue.Order;
        _shuffle.IsChecked = order is PlaybackOrder.ShuffleTracks or PlaybackOrder.ShuffleAlbums or PlaybackOrder.ShuffleFolders or PlaybackOrder.Random;
        _repeat.IsChecked = order is PlaybackOrder.RepeatPlaylist or PlaybackOrder.RepeatTrack;
        Ui.SetIcon(_repeat, order == PlaybackOrder.RepeatTrack ? Glyphs.RepeatOne : Glyphs.Repeat, pop: true);
        string repeatName = order == PlaybackOrder.RepeatTrack ? "单曲循环" : order == PlaybackOrder.RepeatPlaylist ? "列表循环" : "循环播放";
        AutomationProperties.SetName(_repeat, repeatName);
        ToolTipService.SetToolTip(_repeat, repeatName);
        foreach (var c in new Control[] { _shuffle, _repeat }) c.Foreground = ((ToggleButton)c).IsChecked == true ? Ui.Brush("AccentTextBrush") : Ui.Brush("TextSecondaryBrush");
        double d = m.Duration;
        _progress.Maximum = d > 0 ? d : 1;
        _progress.IsEnabled = t is not null;
        _length.Text = Formats.Duration(d);
        if (!_seeking && (!_gliding || Math.Abs(m.Position - _progress.Value) > 1)) ShowPosition(m.Position);
        Glide(m.State == PlayerState.Playing);
        _volume.Value = m.Volume * 100;
        Ui.SetIcon(_mute, m.Muted || m.Volume == 0 ? Glyphs.Mute : Glyphs.Volume);
        AutomationProperties.SetName(_mute, m.Muted ? "取消静音" : "静音");
        _syncing = false;
    }
}
