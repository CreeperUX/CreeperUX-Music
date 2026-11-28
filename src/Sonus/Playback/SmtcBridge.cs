using System.Runtime.InteropServices;
using Microsoft.UI.Dispatching;
using Windows.Media;
using Windows.Storage.Streams;

namespace Sonus.Playback;

/// <summary>
/// Publishes playback state, metadata, cover art, and timeline to Windows System Media Transport Controls
/// (hardware media keys, volume flyout card, lock screen) for the native WASAPI backend.
/// Uses <c>ISystemMediaTransportControlsInterop::GetForWindow</c> bound directly to the app's Win32 HWND
/// so Windows registers our session in <c>GlobalSystemMediaTransportControlsSessionManager</c> without
/// requiring a Media Foundation MediaPlayer.
/// </summary>
internal sealed unsafe class SmtcBridge : IDisposable
{
    private static readonly Guid IidSmtcInterop = new("DDB0472D-C911-4A1F-86D9-DC3D71A95F5A");
    private static readonly Guid IidSmtc = new("99FA3FF4-1742-42A6-902E-087D41F965EC");

    private readonly DispatcherQueue _ui;
    private SystemMediaTransportControls? _smtc;
    private bool _disposed;

    public SmtcBridge(DispatcherQueue ui) => _ui = ui;

    public event Action? PlayPressed;
    public event Action? PausePressed;
    public event Action? NextPressed;
    public event Action? PreviousPressed;

    /// <summary>Acquires the window's SMTC instance on the UI thread (blocking briefly if called off-UI).</summary>
    public void Initialize()
    {
        if (_disposed || _smtc is not null) return;
        var ready = new ManualResetEventSlim(false);
        bool queued = _ui.TryEnqueue(() =>
        {
            try
            {
                if (_disposed || App.MainWindow is not { } win) return;
                IntPtr hwnd = WinRT.Interop.WindowNative.GetWindowHandle(win);
                if (hwnd == IntPtr.Zero) return;
                var smtc = GetForWindow(hwnd);
                smtc.IsEnabled = true;
                smtc.IsPlayEnabled = true;
                smtc.IsPauseEnabled = true;
                smtc.IsStopEnabled = true;
                smtc.IsNextEnabled = true;
                smtc.IsPreviousEnabled = true;
                smtc.PlaybackStatus = MediaPlaybackStatus.Stopped;
                smtc.ButtonPressed += OnButtonPressed;
                _smtc = smtc;
                Log.Write($"[smtc] ready (hwnd=0x{hwnd:X})");
            }
            catch (Exception ex)
            {
                Log.Write($"[smtc] init failed: {ex.Message}");
            }
            finally
            {
                ready.Set();
            }
        });
        if (queued) ready.Wait(TimeSpan.FromSeconds(2));
        ready.Dispose();
    }

    private static SystemMediaTransportControls GetForWindow(IntPtr hwnd)
    {
        const string className = "Windows.Media.SystemMediaTransportControls";
        int hr = WindowsCreateString(className, className.Length, out IntPtr hstring);
        Marshal.ThrowExceptionForHR(hr);
        IntPtr factory = IntPtr.Zero;
        IntPtr smtcAbi = IntPtr.Zero;
        try
        {
            Guid interopIid = IidSmtcInterop;
            hr = RoGetActivationFactory(hstring, ref interopIid, out factory);
            Marshal.ThrowExceptionForHR(hr);

            // ISystemMediaTransportControlsInterop inherits IInspectable (6 slots), so GetForWindow is vtable[6]
            var getForWindow = (delegate* unmanaged[Stdcall]<IntPtr, IntPtr, Guid*, IntPtr*, int>)(*(IntPtr**)factory)[6];
            Guid smtcIid = IidSmtc;
            hr = getForWindow(factory, hwnd, &smtcIid, &smtcAbi);
            Marshal.ThrowExceptionForHR(hr);

            return WinRT.MarshalInspectable<SystemMediaTransportControls>.FromAbi(smtcAbi);
        }
        finally
        {
            if (smtcAbi != IntPtr.Zero) Marshal.Release(smtcAbi);
            if (factory != IntPtr.Zero) Marshal.Release(factory);
            WindowsDeleteString(hstring);
        }
    }

    private void OnButtonPressed(SystemMediaTransportControls sender, SystemMediaTransportControlsButtonPressedEventArgs args)
    {
        switch (args.Button)
        {
            case SystemMediaTransportControlsButton.Play: PlayPressed?.Invoke(); break;
            case SystemMediaTransportControlsButton.Pause: PausePressed?.Invoke(); break;
            case SystemMediaTransportControlsButton.Stop: PausePressed?.Invoke(); break;
            case SystemMediaTransportControlsButton.Next: NextPressed?.Invoke(); break;
            case SystemMediaTransportControlsButton.Previous: PreviousPressed?.Invoke(); break;
        }
    }

    public void UpdateMetadata(EngineItem item)
    {
        if (_disposed) return;
        if (_smtc is null) Initialize();
        var smtc = _smtc;
        if (smtc is null) return;
        try
        {
            var u = smtc.DisplayUpdater;
            u.ClearAll();
            u.Type = MediaPlaybackType.Music;
            u.MusicProperties.Title = item.Title ?? "";
            u.MusicProperties.Artist = item.Artist ?? "";
            u.MusicProperties.AlbumTitle = item.Album ?? "";
            if (item.CoverUrl is { Length: > 0 } cover && Uri.TryCreate(cover, UriKind.Absolute, out var uri))
                u.Thumbnail = RandomAccessStreamReference.CreateFromUri(uri);
            u.Update();
        }
        catch (Exception ex)
        {
            Log.Write($"[smtc] metadata failed: {ex.Message}");
        }
    }

    public void UpdateStatus(EngineState state)
    {
        if (_disposed || _smtc is not { } smtc) return;
        try
        {
            smtc.PlaybackStatus = state switch
            {
                EngineState.Playing => MediaPlaybackStatus.Playing,
                EngineState.Paused => MediaPlaybackStatus.Paused,
                EngineState.Loading => MediaPlaybackStatus.Changing,
                _ => MediaPlaybackStatus.Stopped,
            };
        }
        catch (Exception ex)
        {
            Log.Write($"[smtc] status failed: {ex.Message}");
        }
    }

    public void UpdateTimeline(double positionSeconds, double? durationSeconds)
    {
        if (_disposed || _smtc is not { } smtc || durationSeconds is not { } dur || dur <= 0) return;
        try
        {
            var t = new SystemMediaTransportControlsTimelineProperties
            {
                StartTime = TimeSpan.Zero,
                MinSeekTime = TimeSpan.Zero,
                Position = TimeSpan.FromSeconds(Math.Clamp(positionSeconds, 0, dur)),
                EndTime = TimeSpan.FromSeconds(dur),
                MaxSeekTime = TimeSpan.FromSeconds(dur),
            };
            smtc.UpdateTimelineProperties(t);
        }
        catch { /* timeline updates are best-effort */ }
    }

    public void Clear()
    {
        if (_disposed || _smtc is not { } smtc) return;
        try
        {
            smtc.PlaybackStatus = MediaPlaybackStatus.Stopped;
            smtc.DisplayUpdater.ClearAll();
            smtc.DisplayUpdater.Update();
        }
        catch { }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        var smtc = _smtc;
        _smtc = null;
        if (smtc is null) return;
        try
        {
            smtc.ButtonPressed -= OnButtonPressed;
            smtc.PlaybackStatus = MediaPlaybackStatus.Stopped;
            smtc.DisplayUpdater.ClearAll();
            smtc.DisplayUpdater.Update();
            smtc.IsEnabled = false;
        }
        catch { }
    }

    [DllImport("combase.dll", PreserveSig = true)]
    private static extern int RoGetActivationFactory(IntPtr activatableClassId, ref Guid iid, out IntPtr factory);

    [DllImport("combase.dll", PreserveSig = true)]
    private static extern int WindowsCreateString([MarshalAs(UnmanagedType.LPWStr)] string sourceString, int length, out IntPtr hstring);

    [DllImport("combase.dll", PreserveSig = true)]
    private static extern int WindowsDeleteString(IntPtr hstring);
}
