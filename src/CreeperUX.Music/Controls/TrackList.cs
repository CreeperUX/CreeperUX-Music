using System.Collections.ObjectModel;
using System.ComponentModel;
using CreeperUX.Music.Core;
using CreeperUX.Music.Services;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Markup;
using Microsoft.UI.Xaml.Media;

namespace CreeperUX.Music.Controls;

/// <summary>One row of a track list: the song and how it shows (playing, liked).</summary>
public sealed class TrackRow(Track track, int index) : INotifyPropertyChanged
{
    public Track Track { get; } = track;
    public int Index { get; set; } = index;
    public string Title => Track.Title;
    public string Artist => Track.Artist;
    public string Album => Track.Album;
    public string Duration => Formats.Duration(Track.Duration);
    public string? Cover { get; init; }
    public bool IsCurrent { get; private set; }
    public bool IsPlaying { get; private set; }

    public string IndexText => IsCurrent ? IsPlaying ? Glyphs.Volume : Glyphs.Pause : Index.ToString(System.Globalization.CultureInfo.InvariantCulture);
    public FontFamily IndexFont => IsCurrent ? (FontFamily)Application.Current.Resources["SymbolThemeFontFamily"] : (FontFamily)Application.Current.Resources["AppFigureFont"];
    public Brush TitleBrush => IsCurrent ? Ui.Brush("AccentTextBrush") : Ui.Brush("TextPrimaryBrush");
    public Brush IndexBrush => IsCurrent ? Ui.Brush("AccentTextBrush") : Ui.Brush("TextSecondaryBrush");
    public string HeartGlyph => Track.Liked ? Glyphs.HeartFill : Glyphs.Heart;
    public Brush HeartBrush => Track.Liked ? Ui.Brush("AccentBrush") : Ui.Brush("TextTertiaryBrush");
    public string HeartName => (Track.Liked ? "取消喜欢 " : "喜欢 ") + Track.Title;
    public string MoreName => $"{Track.Title} 的更多选项";

    public void SetState(bool current, bool playing)
    {
        if (IsCurrent == current && IsPlaying == playing) return;
        IsCurrent = current; IsPlaying = playing;
        Raise(nameof(IndexText), nameof(IndexFont), nameof(TitleBrush), nameof(IndexBrush));
    }

    public void RefreshLike() => Raise(nameof(HeartGlyph), nameof(HeartBrush), nameof(HeartName));

    private void Raise(params string[] names) { foreach (var n in names) PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(n)); }
    public event PropertyChangedEventHandler? PropertyChanged;

    /// <summary>The row's accessible name.</summary>
    public override string ToString() => $"{Track.Title} · {Track.Artist}";
}

/// <summary>
/// A list of songs (album, playlist, artist's popular songs, search results, the queue's context): number or cover, title and
/// artist, album, like, duration and "more". Double-click or Enter plays from that song within the list's context; the
/// right button or "…" opens the song menu. Own playlists can be reordered by dragging.
/// </summary>
public sealed class TrackList : UserControl
{
    private readonly ListView _list;
    private readonly ObservableCollection<TrackRow> _rows = [];
    private readonly MusicService _music;
    private readonly IShell _shell;
    private readonly Func<IReadOnlyList<string>>? _contextIds;
    private readonly bool _showAlbum, _covers;

    public string ContextKind { get; }
    public string ContextId { get; }
    /// <summary>The playlist the rows belong to (its menu offers "remove from playlist").</summary>
    public string? PlaylistId { get; init; }
    public event Action<IReadOnlyList<string>, string?>? Reordered;

    private const string RowTemplate = """
        <DataTemplate xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
          <Grid Height="54" ColumnSpacing="12" Background="Transparent">
            <Grid.ColumnDefinitions>
              <ColumnDefinition Width="32"/><ColumnDefinition Width="{{CoverWidth}}"/><ColumnDefinition Width="3*"/><ColumnDefinition Width="{{AlbumWidth}}"/>
              <ColumnDefinition Width="32"/><ColumnDefinition Width="48"/><ColumnDefinition Width="32"/>
            </Grid.ColumnDefinitions>
            <TextBlock Text="{Binding IndexText}" FontFamily="{Binding IndexFont}" Foreground="{Binding IndexBrush}" FontSize="13" HorizontalAlignment="Right" VerticalAlignment="Center"/>
            <Border Grid.Column="1" Width="40" Height="40" CornerRadius="4" Background="{StaticResource RaisedBrush}" Visibility="{{CoverVisibility}}">
              <Image Source="{Binding Cover}" Stretch="UniformToFill"/>
            </Border>
            <StackPanel Grid.Column="2" VerticalAlignment="Center" Spacing="1">
              <TextBlock Text="{Binding Title}" Foreground="{Binding TitleBrush}" FontSize="14" TextTrimming="CharacterEllipsis"/>
              <TextBlock Text="{Binding Artist}" Foreground="{StaticResource TextSecondaryBrush}" FontSize="12.5" TextTrimming="CharacterEllipsis"/>
            </StackPanel>
            <TextBlock Grid.Column="3" Text="{Binding Album}" Foreground="{StaticResource TextSecondaryBrush}" FontSize="13" VerticalAlignment="Center" TextTrimming="CharacterEllipsis"/>
            <Button x:Name="LikeButton" Grid.Column="4" Style="{StaticResource IconButtonStyle}" Width="32" Height="32" FontSize="14" Content="{Binding HeartGlyph}" Foreground="{Binding HeartBrush}" AutomationProperties.Name="{Binding HeartName}"/>
            <TextBlock Grid.Column="5" Text="{Binding Duration}" Style="{StaticResource FigureTextStyle}" FontSize="13" HorizontalAlignment="Right" VerticalAlignment="Center"/>
            <Button x:Name="MoreButton" Grid.Column="6" Style="{StaticResource IconButtonStyle}" Width="32" Height="32" Content="&#xE712;" AutomationProperties.Name="{Binding MoreName}"/>
          </Grid>
        </DataTemplate>
        """;

    public TrackList(MusicService music, IShell shell, string contextKind, string contextId, IReadOnlyList<string> ids, bool showAlbum = true, bool covers = false,
        bool reorderable = false, Func<IReadOnlyList<string>>? contextIds = null, string label = "歌曲", bool header = true)
    {
        _music = music; _shell = shell; ContextKind = contextKind; ContextId = contextId; _showAlbum = showAlbum; _covers = covers; _contextIds = contextIds;
        string xaml = RowTemplate.Replace("{{CoverWidth}}", covers ? "40" : "0").Replace("{{CoverVisibility}}", covers ? "Visible" : "Collapsed").Replace("{{AlbumWidth}}", showAlbum ? "2*" : "0");
        _list = new ListView
        {
            ItemsSource = _rows, ItemTemplate = (DataTemplate)XamlReader.Load(xaml), SelectionMode = ListViewSelectionMode.Single,
            IsItemClickEnabled = false, CanReorderItems = reorderable, AllowDrop = reorderable, CanDragItems = reorderable, Padding = new Thickness(0),
        };
        ScrollViewer.SetVerticalScrollMode(_list, ScrollMode.Disabled);
        ScrollViewer.SetVerticalScrollBarVisibility(_list, ScrollBarVisibility.Disabled);
        AutomationProperties.SetName(_list, label);
        _list.ContainerContentChanging += Wire;
        _list.DoubleTapped += (_, e) => { if ((e.OriginalSource as FrameworkElement)?.DataContext is TrackRow r) PlayFrom(r); };
        _list.KeyDown += (_, e) => { if (e.Key == Windows.System.VirtualKey.Enter && _list.SelectedItem is TrackRow r) { PlayFrom(r); e.Handled = true; } };
        _list.RightTapped += (_, e) =>
        {
            if ((e.OriginalSource as FrameworkElement)?.DataContext is TrackRow r && e.OriginalSource is FrameworkElement fe) { ShowMenu(r, fe, e.GetPosition(fe)); e.Handled = true; }
        };
        if (reorderable) _list.DragItemsCompleted += OnDragged;

        var root = new StackPanel();
        if (header) root.Children.Add(Header());
        root.Children.Add(_list);
        Content = root;
        SetIds(ids);
        music.PlayerChanged += SyncState;
        music.TrackChanged += OnTrackChanged;
        Unloaded += (_, _) => { music.PlayerChanged -= SyncState; music.TrackChanged -= OnTrackChanged; };
        Loaded += (_, _) => { music.PlayerChanged -= SyncState; music.TrackChanged -= OnTrackChanged; music.PlayerChanged += SyncState; music.TrackChanged += OnTrackChanged; SyncState(); };
    }

    private Grid Header()
    {
        var g = new Grid { ColumnSpacing = 12, Padding = new Thickness(12, 0, 12, 8), BorderBrush = Ui.Brush("LineBrush"), BorderThickness = new Thickness(0, 0, 0, 1), Margin = new Thickness(0, 0, 0, 8) };
        foreach (var w in new[] { new GridLength(32), new GridLength(_covers ? 40 : 0), new GridLength(3, GridUnitType.Star), _showAlbum ? new GridLength(2, GridUnitType.Star) : new GridLength(0), new GridLength(32), new GridLength(48), new GridLength(32) })
            g.ColumnDefinitions.Add(new ColumnDefinition { Width = w });
        void Add(FrameworkElement e, int col) { Grid.SetColumn(e, col); g.Children.Add(e); }
        var hash = Ui.Text("#", "MutedTextStyle"); hash.HorizontalAlignment = HorizontalAlignment.Right; Add(hash, 0);
        Add(Ui.Text("标题", "MutedTextStyle"), 2);
        if (_showAlbum) Add(Ui.Text("专辑", "MutedTextStyle"), 3);
        var clock = Ui.Icon(Glyphs.Clock, 13); clock.HorizontalAlignment = HorizontalAlignment.Right; Ui.Name(clock, "时长"); Add(clock, 5);
        return g;
    }

    public void SetIds(IReadOnlyList<string> ids)
    {
        _rows.Clear();
        int i = 0;
        foreach (var id in ids)
            if (_music.Library.Track(id) is { } t)
                _rows.Add(new TrackRow(t, _covers ? ++i : t.Number > 0 && ContextKind == "album" ? t.Number : ++i) { Cover = _covers ? _music.CoverUrl(t.AlbumId, 96) : null });
        if (ContextKind != "album") for (int k = 0; k < _rows.Count; k++) _rows[k].Index = k + 1;
        SyncState();
    }

    public IReadOnlyList<string> Ids => _rows.Select(r => r.Track.Id).ToList();
    public int Count => _rows.Count;

    private void SyncState()
    {
        string? current = _music.Queue.Current;
        bool here = _music.IsContext(ContextKind, ContextId) || ContextKind is "artist-popular" or "search";
        foreach (var r in _rows) r.SetState(here && r.Track.Id == current, _music.IsActive);
    }

    private void OnTrackChanged(Track t) { foreach (var r in _rows.Where(r => r.Track.Id == t.Id)) r.RefreshLike(); }

    private void Wire(ListViewBase sender, ContainerContentChangingEventArgs args)
    {
        if (args.InRecycleQueue || args.ItemContainer.ContentTemplateRoot is not Grid root || root.Tag is "wired") return;
        root.Tag = "wired";
        if (root.FindName("LikeButton") is Button like)
            like.Click += async (s, _) => { if (((FrameworkElement)s).DataContext is TrackRow r) await _shell.Run(() => _music.SetLikedAsync(r.Track.Id, !r.Track.Liked)); };
        if (root.FindName("MoreButton") is Button more)
            more.Click += (s, _) => { if (((FrameworkElement)s).DataContext is TrackRow r) ShowMenu(r, (FrameworkElement)s, null); };
    }

    /// <summary>Plays the list's context from that song.</summary>
    public void PlayFrom(TrackRow r)
    {
        var ids = _contextIds?.Invoke() ?? Ids;
        string kind = ContextKind == "artist-popular" ? "artist" : ContextKind;
        _music.PlayContext(kind, ContextId, r.Track.Id, ids: ids);
    }

    private void ShowMenu(TrackRow r, FrameworkElement anchor, Windows.Foundation.Point? at)
    {
        var flyout = TrackMenu.Build(_music, _shell, [r.Track.Id], PlaylistId);
        flyout.ShouldConstrainToRootBounds = Testing.E2EChannel.Enabled || flyout.ShouldConstrainToRootBounds;
        if (at is { } p) flyout.ShowAt(anchor, new Microsoft.UI.Xaml.Controls.Primitives.FlyoutShowOptions { Position = p });
        else flyout.ShowAt(anchor);
    }

    private async void OnDragged(ListViewBase sender, DragItemsCompletedEventArgs args)
    {
        if (args.DropResult == Windows.ApplicationModel.DataTransfer.DataPackageOperation.None || PlaylistId is null) return;
        var moved = args.Items.OfType<TrackRow>().Select(r => r.Track.Id).ToList();
        var order = Ids.ToList();
        int last = order.IndexOf(moved[^1]);
        string? before = last + 1 < order.Count ? order[last + 1] : null;
        for (int k = 0; k < _rows.Count; k++) _rows[k].Index = k + 1;
        Reordered?.Invoke(moved, before);
        await Task.CompletedTask;
    }
}

/// <summary>The song menu: queue, play next, add to playlist, radio, like, go to artist / album, properties, remove.</summary>
public static class TrackMenu
{
    public static MenuFlyout Build(MusicService music, IShell shell, IReadOnlyList<string> ids, string? playlistId = null)
    {
        var menu = new MenuFlyout();
        var one = ids.Count == 1 ? music.Library.Track(ids[0]) : null;
        menu.Items.Add(Ui.Item("加入播放队列", Glyphs.Queue, () => { music.QueueAdd(ids); shell.ShowToast(new(ids.Count > 1 ? $"已将 {ids.Count} 首加入播放队列" : "已加入播放队列")); }));
        menu.Items.Add(Ui.Item("下一首播放", Glyphs.Next, () => { music.QueueAdd(ids, next: true); shell.ShowToast(new("将在下一首播放")); }));
        var add = new MenuFlyoutSubItem { Text = "加入歌单", Icon = new FontIcon { Glyph = Glyphs.Add } };
        add.Items.Add(Ui.Item("新建歌单", Glyphs.Add, () => _ = shell.Run(async () =>
        {
            var p = await music.CreatePlaylistAsync($"我的歌单 #{music.Playlists.Count(x => x.Kind == PlaylistKind.User) + 1}", ids);
            shell.ShowToast(new($"已创建“{p.Name}”", ActionLabel: "查看", Action: () => shell.Navigate($"playlist:{p.Id}")));
        })));
        var own = music.Playlists.Where(p => p.Kind == PlaylistKind.User).ToList();
        if (own.Count > 0) add.Items.Add(new MenuFlyoutSeparator());
        foreach (var p in own)
            add.Items.Add(Ui.Item(p.Name, Glyphs.Playlist, () => _ = shell.Run(async () => { await music.AddToPlaylistAsync(p.Id, ids); shell.ShowToast(new($"已将 {ids.Count} 首加入“{p.Name}”")); })));
        menu.Items.Add(add);
        if (playlistId is not null && music.Playlist(playlistId) is { Kind: PlaylistKind.User or PlaylistKind.Liked } pl)
            menu.Items.Add(Ui.Item(pl.Kind == PlaylistKind.Liked ? "从我喜欢的音乐中移除" : "从歌单中移除", Glyphs.Delete, () => _ = shell.Run(async () =>
            {
                var before = pl.Entries.ToList();
                await music.RemoveFromPlaylistAsync(pl.Id, ids);
                shell.ShowToast(new($"已移除 {ids.Count} 首", ActionLabel: pl.Kind == PlaylistKind.User ? "撤销" : null,
                    Action: pl.Kind == PlaylistKind.User ? () => _ = shell.Run(() => music.ReorderPlaylistAsync(pl.Id, before)) : null));
            })));
        if (one is not null)
        {
            menu.Items.Add(Ui.Item("开始电台", Glyphs.Radio, () => _ = shell.Run(async () => { if (!await music.StartRadioAsync(one.Id)) shell.ShowToast(new("没有找到相似的歌曲。")); })));
            menu.Items.Add(Ui.Item(one.Liked ? "取消喜欢" : "喜欢", one.Liked ? Glyphs.HeartFill : Glyphs.Heart, () => _ = shell.Run(() => music.SetLikedAsync(one.Id, !one.Liked))));
            menu.Items.Add(new MenuFlyoutSeparator());
            menu.Items.Add(Ui.Item("查看艺人", Glyphs.Artist, () => shell.Navigate($"artist:{one.ArtistId}")));
            menu.Items.Add(Ui.Item("查看专辑", Glyphs.Album, () => shell.Navigate($"album:{one.AlbumId}")));
            menu.Items.Add(new MenuFlyoutSeparator());
            menu.Items.Add(Ui.Item("属性", Glyphs.Info, () => shell.ShowProperties(one)));
        }
        return menu;
    }
}
