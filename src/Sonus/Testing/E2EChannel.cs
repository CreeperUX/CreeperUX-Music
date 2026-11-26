using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text.Json;
using Sonus.Core;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Automation.Peers;
using Microsoft.UI.Xaml.Automation.Provider;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;

namespace Sonus.Testing;

/// <summary>
/// End-to-end test hooks (tools/e2e), active only when SONUS_E2E names a pipe (the approach of Lumen's E2EChannel). The
/// test instance then opens cloaked — rendered and capturable with PrintWindow, never on screen, out of the taskbar, never
/// activated — and the scripts drive it over that named pipe: controls are found by their accessible names and invoked
/// in-process, so tests run silently while the user keeps working. One command per line, one reply per line.
/// </summary>
internal static class E2EChannel
{
    public static string? PipeName { get; } = Environment.GetEnvironmentVariable("SONUS_E2E") is { Length: > 0 } name ? name : null;
    public static bool Enabled => PipeName is not null;

    [DllImport("dwmapi.dll")] private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] private static extern IntPtr GetWindowLongPtr(IntPtr hwnd, int index);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] private static extern IntPtr SetWindowLongPtr(IntPtr hwnd, int index, IntPtr value);
    [DllImport("user32.dll")] private static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);
    private const int DwmwaCloak = 13, GwlExStyle = -20;
    private const long WsExNoActivate = 0x08000000;
    private const string Separator = "\u001e";

    public static void ShowInBackground(Window window)
    {
        IntPtr hwnd = WinRT.Interop.WindowNative.GetWindowHandle(window);
        int cloak = 1;
        DwmSetWindowAttribute(hwnd, DwmwaCloak, ref cloak, sizeof(int));
        SetWindowLongPtr(hwnd, GwlExStyle, new IntPtr(GetWindowLongPtr(hwnd, GwlExStyle).ToInt64() | WsExNoActivate));
        window.AppWindow.IsShownInSwitchers = false;
        window.AppWindow.Show(activateWindow: false);
    }

    public static void Start(DispatcherQueue ui)
    {
        if (PipeName is not { } pipe) return;
        Log.Write($"[e2e] channel on pipe {pipe}");
        EndWithTheRun();
        _ = Task.Run(async () =>
        {
            while (true)
            {
                try
                {
                    using var server = new NamedPipeServerStream(pipe, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
                    await server.WaitForConnectionAsync();
                    using var reader = new StreamReader(server);
                    using var writer = new StreamWriter(server) { AutoFlush = true };
                    while (await reader.ReadLineAsync() is { } line)
                        await writer.WriteLineAsync((await RunOnUi(ui, line)).ReplaceLineEndings(" "));
                }
                catch (IOException) { await Task.Delay(100); }
                catch (Exception ex) { Log.Write($"[e2e] {ex.Message}"); await Task.Delay(100); }
            }
        });
    }

    /// <summary>
    /// The test run's process (SONUS_E2E_PARENT): when it ends, this instance ends too. tools/e2e starts instances outside
    /// node's job object, so that a crash reaches Windows Error Reporting (inside it, a crash ends the process silently);
    /// that job used to end them with node.
    /// </summary>
    private static void EndWithTheRun()
    {
        if (!int.TryParse(Environment.GetEnvironmentVariable("SONUS_E2E_PARENT"), out int pid)) return;
        System.Diagnostics.Process run;
        try { run = System.Diagnostics.Process.GetProcessById(pid); }
        catch (ArgumentException) { Log.Write("[e2e] the test run has already ended: closing"); Environment.Exit(3); return; }
        new Thread(() =>
        {
            run.WaitForExit();
            Log.Write("[e2e] the test run ended: closing");
            Environment.Exit(3);
        }) { IsBackground = true, Name = "test run watch" }.Start();
    }

    /// <summary>
    /// "reentrancy": 0.6.2's crash, without the crash. The UI thread waits 400 ms for a lock another thread holds while a
    /// third thread calls into the UI thread's COM context, as the finalizer does when it releases a XAML object. "after the
    /// wait": the call waited for the UI thread to be free (UiSynchronizationContext); "during the wait": the CLR pumped
    /// and ran it inside the wait, which XAML in the middle of a layout does not survive.
    /// </summary>
    private static async Task<string> Reentrancy()
    {
        Guid iid = IidContextCallback;
        if (CoGetObjectContext(ref iid, out IntPtr context) < 0) return "error: no COM context";
        var gate = new object();
        using var held = new ManualResetEventSlim();
        var clock = System.Diagnostics.Stopwatch.StartNew();
        long ran = -1;
        var holder = new Thread(() => { lock (gate) { held.Set(); Thread.Sleep(400); } }) { IsBackground = true };
        holder.Start();
        held.Wait();
        var caller = new Thread(() => { Thread.Sleep(100); CallIn(context, () => ran = clock.ElapsedMilliseconds); Marshal.Release(context); }) { IsBackground = true };
        caller.Start();
        lock (gate) { }
        long acquired = clock.ElapsedMilliseconds;
        await Task.Run(caller.Join); // back to the message loop: the call can come in now
        return ran < 0 ? "error: the call did not run" : $"{(ran < acquired ? "during" : "after")} the wait (call at {ran} ms, lock at {acquired} ms)";
    }

    private static string LongWait()
    {
        var gate = new object();
        using var held = new ManualResetEventSlim();
        var holder = new Thread(() => { lock (gate) { held.Set(); Thread.Sleep(1500); } }) { IsBackground = true };
        holder.Start();
        held.Wait();
        var clock = System.Diagnostics.Stopwatch.StartNew();
        lock (gate) { }
        return $"waited {clock.ElapsedMilliseconds} ms";
    }

    private static readonly Guid IidContextCallback = new("000001da-0000-0000-C000-000000000046");
    // what CsWinRT passes for its calls into a context (Context.CallInContext)
    private static readonly Guid IidCallbackWithNoReentrancyToApplicationSta = new("0A299774-3E4E-FC42-1D9D-72CEE105CA57");

    [StructLayout(LayoutKind.Sequential)]
    private struct ComCallData { public uint Dispid, Reserved; public IntPtr UserDefined; }

    private static unsafe void CallIn(IntPtr context, Action action)
    {
        var handle = GCHandle.Alloc(action);
        try
        {
            var data = new ComCallData { UserDefined = GCHandle.ToIntPtr(handle) };
            Guid iid = IidCallbackWithNoReentrancyToApplicationSta;
            // IContextCallback::ContextCallback, the vtable's fourth method
            var call = (delegate* unmanaged[Stdcall]<IntPtr, delegate* unmanaged[Stdcall]<ComCallData*, int>, ComCallData*, Guid*, int, IntPtr, int>)(*(IntPtr**)context)[3];
            Marshal.ThrowExceptionForHR(call(context, &RunCallback, &data, &iid, 5, IntPtr.Zero));
        }
        finally { handle.Free(); }
    }

    [UnmanagedCallersOnly(CallConvs = [typeof(System.Runtime.CompilerServices.CallConvStdcall)])]
    private static unsafe int RunCallback(ComCallData* data)
    {
        ((Action)GCHandle.FromIntPtr(data->UserDefined).Target!)();
        return 0;
    }

    [DllImport("ole32.dll")] private static extern int CoGetObjectContext(ref Guid iid, out IntPtr context);

    private static Task<string> RunOnUi(DispatcherQueue ui, string line)
    {
        var done = new TaskCompletionSource<string>();
        ui.TryEnqueue(async () =>
        {
            try { done.SetResult(line.StartsWith("shot ", StringComparison.Ordinal) ? await Shot(line[5..].Trim()) : line.Trim() == "reentrancy" ? await Reentrancy() : Execute(line.Trim())); }
            catch (Exception ex) { Log.Write($"[e2e] {line}: {ex}"); done.SetResult("error: " + ex.Message); }
        });
        return done.Task;
    }

    /// <summary>"shot <file.png>": the window's content as XAML renders it (RenderTargetBitmap), at half size, plus any open
    /// popups (menus, dialogs) composed on top. Silent: nothing is shown or activated.</summary>
    private static async Task<string> Shot(string path)
    {
        bool full = path.EndsWith(" full", StringComparison.Ordinal); // "shot x.png full": at the screen's resolution, not half
        if (full) path = path[..^5];
        if (W?.Content is not FrameworkElement root) return "error: no window";
        var layers = new List<(UIElement Element, Windows.Foundation.Point At)> { (root, new(0, 0)) };
        foreach (var popup in VisualTreeHelper.GetOpenPopupsForXamlRoot(root.XamlRoot))
        {
            if (popup.Child is not FrameworkElement child) continue;
            // a menu that has just opened may not be laid out yet: RenderTargetBitmap refuses an element without a size
            // (a Flyout's popup draws nothing here: printWindow in tools/e2e takes those)
            for (int i = 0; i < 20 && (child.ActualWidth <= 0 || child.ActualHeight <= 0); i++) await Task.Delay(25);
            if (child.ActualWidth > 0 && child.ActualHeight > 0)
                layers.Add((child, child.TransformToVisual(root).TransformPoint(new Windows.Foundation.Point(0, 0))));
        }
        double scale = root.XamlRoot.RasterizationScale;
        int width = (int)(root.ActualWidth * scale), height = (int)(root.ActualHeight * scale);
        var canvas = new byte[width * height * 4];
        foreach (var (element, at) in layers)
        {
            var rtb = new Microsoft.UI.Xaml.Media.Imaging.RenderTargetBitmap();
            try { await rtb.RenderAsync(element); }
            catch (ArgumentException) when (element != root)
            {
                // a popup XAML cannot render into a bitmap (one in its own window, a tooltip say): left out of the shot
                Log.Write($"[e2e] shot: popup {element.GetType().Name} ({VisualTreeHelper.GetParent(element)?.GetType().Name}) could not be rendered");
                continue;
            }
            var pixels = System.Runtime.InteropServices.WindowsRuntime.WindowsRuntimeBufferExtensions.ToArray(await rtb.GetPixelsAsync());
            int ox = (int)(at.X * scale), oy = (int)(at.Y * scale);
            for (int y = 0; y < rtb.PixelHeight; y++)
            {
                int ty = oy + y; if (ty < 0 || ty >= height) continue;
                for (int x = 0; x < rtb.PixelWidth; x++)
                {
                    int tx = ox + x; if (tx < 0 || tx >= width) continue;
                    int s = (y * rtb.PixelWidth + x) * 4, d = (ty * width + tx) * 4;
                    byte a = pixels[s + 3];
                    if (a == 0) continue;
                    for (int c = 0; c < 3; c++) canvas[d + c] = (byte)((pixels[s + c] * a + canvas[d + c] * (255 - a)) / 255); // premultiplied over
                    canvas[d + 3] = 255;
                }
            }
        }
        using var file = new Windows.Storage.Streams.InMemoryRandomAccessStream();
        var encoder = await Windows.Graphics.Imaging.BitmapEncoder.CreateAsync(Windows.Graphics.Imaging.BitmapEncoder.PngEncoderId, file);
        encoder.SetPixelData(Windows.Graphics.Imaging.BitmapPixelFormat.Bgra8, Windows.Graphics.Imaging.BitmapAlphaMode.Ignore, (uint)width, (uint)height, 96, 96, canvas);
        if (!full) { encoder.BitmapTransform.ScaledWidth = (uint)(width / 2); encoder.BitmapTransform.ScaledHeight = (uint)(height / 2); }
        encoder.BitmapTransform.InterpolationMode = Windows.Graphics.Imaging.BitmapInterpolationMode.Fant;
        await encoder.FlushAsync();
        var bytes = new byte[file.Size];
        file.Seek(0);
        using (var reader = new Windows.Storage.Streams.DataReader(file)) { await reader.LoadAsync((uint)file.Size); reader.ReadBytes(bytes); }
        await File.WriteAllBytesAsync(path, bytes);
        return "saved " + path;
    }

    private static MainWindow? W => App.MainWindow;
    private static Services.MusicService? M => App.MainWindow?.Music;

    private static string Execute(string line)
    {
        int space = line.IndexOf(' ');
        string command = space < 0 ? line : line[..space], arg = space < 0 ? "" : line[(space + 1)..].Trim();
        return command switch
        {
            "ping" => "pong",
            "pid" => Environment.ProcessId.ToString(System.Globalization.CultureInfo.InvariantCulture),
            "ready" => W?.Ready == true ? "yes" : "no",
            "state" => State(),
            "nav" => W is { } w && M is not null ? Done(() => w.Navigate(arg)) : "error: not signed in",
            "back" => W is { } wb ? Done(wb.GoBack) : "error: no window",
            "do" => Do(arg),
            "invoke" => Invoke(arg),
            "context" => Context(arg),
            "names" => string.Join(Separator, Named().Select(x => $"{x.Name} [{x.Element.GetType().Name}]" + (x.Element is ToggleButton { IsChecked: true } or RadioMenuFlyoutItem { IsChecked: true } ? " ✓" : ""))),
            "texts" => string.Join(Separator, Live().OfType<TextBlock>().Where(t => t.ActualWidth > 0 && t.Text.Length > 0).Select(t => t.Text)),
            "set" => SetText(arg),
            "choose" => Choose(arg),
            "scroll" => Scroll(arg),
            "audit" => string.Join(Separator, Audit()),
            "popups" => W?.Content is UIElement root ? VisualTreeHelper.GetOpenPopupsForXamlRoot(root.XamlRoot).Count.ToString(System.Globalization.CultureInfo.InvariantCulture) : "0",
            "closepopups" => W?.Content is UIElement r2 ? Done(() => { foreach (var p in VisualTreeHelper.GetOpenPopupsForXamlRoot(r2.XamlRoot)) p.IsOpen = false; }) : "error: no window",
            "resize" => Resize(arg),
            "tabs" => Tabs(arg),
            "iconcolor" => IconColor(arg),
            "bounds" => W?.Content is UIElement broot ? string.Join(Separator, Named().Where(x => Matches(x.Name, arg)).Select(x =>
                { var r = x.Element.TransformToVisual(broot).TransformBounds(new Windows.Foundation.Rect(0, 0, x.Element.ActualWidth, x.Element.ActualHeight));
                  return FormattableString.Invariant($"{x.Name} [{x.Element.GetType().Name}] {r.X:0.#},{r.Y:0.#} {r.Width:0.#}x{r.Height:0.#}"); })) : "error: no window",
            // managed memory after a full collection, in KB (pages left behind must not pile up)
            "memory" => Done(() => { GC.Collect(); GC.WaitForPendingFinalizers(); GC.Collect(); }) is var _ ? (GC.GetTotalMemory(true) / 1024).ToString(System.Globalization.CultureInfo.InvariantCulture) : "",
            "ws" => (Environment.WorkingSet / (1024 * 1024)).ToString(System.Globalization.CultureInfo.InvariantCulture), // MB
            "elements" => W?.Content is UIElement el ? Descend(el).Count().ToString(System.Globalization.CultureInfo.InvariantCulture) : "0",
            "window" => W is { } ww ? FormattableString.Invariant($"{ww.AppWindow.Size.Width} {ww.AppWindow.Size.Height} {ww.Title}") : "error: no window",
            // the title bar's insets for the window buttons (physical px) and the scale: what the top bar must leave free
            "insets" => W is { } wi && wi.Content is FrameworkElement ri ? FormattableString.Invariant($"left {wi.AppWindow.TitleBar.LeftInset} right {wi.AppWindow.TitleBar.RightInset} scale {ri.XamlRoot.RasterizationScale} width {ri.ActualWidth}") : "error: no window",
            // where the window buttons begin, the top bar's clickable parts and where its end's buttons are (window pixels)
            "titlebar" => W?.TitleBarState() ?? "error: no window",
            // by hand only: the UI thread waits 1.5 s for a lock another thread holds, so UiSynchronizationContext logs its
            // "[ui] waited … without pumping" line and pumps (acceptance fails on that line, by design)
            "longwait" => LongWait(),
            "close" => W is { } wc && PostMessage(WinRT.Interop.WindowNative.GetWindowHandle(wc), 0x0010, IntPtr.Zero, IntPtr.Zero) ? "closing" : "error: no window",
            _ => "error: unknown command " + command,
        };
    }

    private static string Done(Action a) { a(); return "ok"; }

    /// <summary>What the app is doing, as JSON (assertions read it rather than pixels).</summary>
    private static string State()
    {
        var m = M;
        return JsonSerializer.Serialize(new
        {
            syncContext = SynchronizationContext.Current?.GetType().Name, // UiSynchronizationContext, also after signing in again
            ready = W?.Ready == true, route = W?.Route, title = W?.Title, view = W?.CurrentView?.GetType().Name,
            track = m?.Queue.Current, trackTitle = m?.Current?.Title, state = m?.State.ToString(), error = m?.Error, position = m?.Position, duration = m?.Duration,
            engine = m?.Engine.State.ToString(), engineTrack = m?.Engine.CurrentId, engineNext = m?.Engine.NextId, enginePosition = m?.Engine.Position, engineDuration = m?.Engine.Duration, volume = m?.Engine.Volume,
            order = m?.Queue.Order.ToString(), context = m?.Queue.Context, queue = m?.Queue.Entries.Select(e => e.TrackId).Take(20), manual = m?.Queue.Entries.Count(e => e.Manual),
            online = m?.IsOnline, lyric = W?.Panel?.CurrentLyric, services = Services.MusicService.Alive, songs = m?.Library.Tracks.Count, albums = m?.Library.Albums.Count, artists = m?.Library.Artists.Count,
            playlists = m?.Playlists.Select(p => new { p.Id, p.Name, kind = p.Kind.ToString(), count = p.TrackIds.Count, p.Owner }),
            liked = m?.Playlists.FirstOrDefault(p => p.Kind == PlaylistKind.Liked)?.Entries.Take(5),
            connect = W?.Devices is { } c ? new
            {
                available = c.IsAvailable, connected = c.IsConnected, id = c.ThisId, target = c.Target?.Name,
                others = c.Others.Select(d => new { d.Id, d.Name, playing = d.State?.Playing, track = d.State?.TrackId }),
            } : null,
            // Sonus Connect version 2: the user's session as this device last heard it
            session = W?.Session is { } v2 ? new
            {
                connected = v2.IsConnected, id = v2.Id, here = v2.IsActiveHere, rev = v2.Session.Rev,
                active = v2.Session.ActiveDevice is { } a ? v2.NameOf(a) : null, last = v2.Session.LastDevice?.Name, where = m?.Where,
                track = v2.Session.Current?.TrackId, key = v2.Session.Current?.Key, playing = v2.Session.Playing, mode = v2.Session.Mode,
                position = v2.Session.PositionAt(v2.ServerNow) / 1000.0,
                devices = v2.Devices.Select(d => new { d.Id, d.Name, d.Volume, d.Muted }),
            } : null,
            toasts = W?.Content is FrameworkElement root ? Descend(root).OfType<Border>().Where(b => AutomationProperties.GetLiveSetting(b) == AutomationLiveSetting.Polite).Select(AutomationProperties.GetName) : null,
        });
    }

    /// <summary>Service actions for setting a scene: "play album al3 2", "seek 30", "pause", "resume", "next", "volume 0.5",
    /// "order ShuffleTracks", "like t5 on", "replaygain Track", "refresh", "track t5" (JSON of one song).</summary>
    private static string Do(string arg)
    {
        if (M is not { } m) return "error: not signed in";
        var p = arg.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        string Arg(int i) => i < p.Length ? p[i] : "";
        double Num(int i) => double.Parse(Arg(i), System.Globalization.CultureInfo.InvariantCulture);
        switch (Arg(0))
        {
            case "play":
                string kind = Arg(1), id = Arg(2);
                var ids = m.ContextOf(kind, id).Ids;
                string? start = p.Length > 3 ? int.TryParse(Arg(3), out int index) ? ids.ElementAtOrDefault(index) : Arg(3) : null;
                m.PlayContext(kind, id, start);
                return "ok";
            case "seek": m.Seek(Num(1)); return "ok";
            case "pause": m.Pause(); return "ok";
            case "resume": m.Resume(); return "ok";
            case "next": m.Next(); return "ok";
            case "previous": m.Previous(); return "ok";
            case "volume": m.SetVolume(Num(1)); return "ok";
            case "order": m.SetOrder(Enum.Parse<PlaybackOrder>(Arg(1))); return "ok";
            case "stopafter": m.SetStopAfterCurrent(Arg(1) == "on"); return "ok";
            case "replaygain": m.SetReplayGain(Enum.Parse<ReplayGainMode>(Arg(1))); return "ok";
            case "queue": m.QueueAdd(p.Skip(1), next: false); return "ok";
            case "like": _ = m.SetLikedAsync(Arg(1), Arg(2) == "on"); return "ok";
            case "radio": _ = m.StartRadioAsync(Arg(1)); return "ok";
            case "playsearch":
                // the search page's song list: plays the results of a search (the context keeps them, as a double-click does)
                string query = string.Join(' ', p.Skip(1));
                async void PlaySearch() { try { var r = await m.SearchAsync(query); m.Play(new PlayContext("search", query, $"搜索“{query}”"), r.Tracks); } catch (Exception ex) { Log.Write($"[e2e] playsearch: {ex.Message}"); } }
                PlaySearch();
                return "ok";
            case "refresh": _ = m.RefreshAsync(); return "ok";
            case "online": _ = m.GoOnlineAsync(); return "ok";
            case "track":
                var t = m.Library.Track(Arg(1));
                return t is null ? "null" : JsonSerializer.Serialize(new { t.Id, t.Title, t.Liked, t.PlayCount, t.Codec, t.Suffix, t.TrackGain, t.AlbumGain, t.Duration });
            default: return "error: unknown action " + Arg(0);
        }
    }

    // ---- In-process UI driving: works while the window is cloaked ----
    private static IEnumerable<DependencyObject> Live()
    {
        if (W?.Content is not UIElement root) return [];
        var popups = VisualTreeHelper.GetOpenPopupsForXamlRoot(root.XamlRoot).Select(p => p.Child).OfType<UIElement>();
        return popups.SelectMany(p => Descend(p)).Concat(Descend(root, skipCollapsed: true));
    }

    private static IEnumerable<DependencyObject> Descend(DependencyObject root, bool skipCollapsed = false)
    {
        var stack = new Stack<DependencyObject>();
        stack.Push(root);
        while (stack.Count > 0)
        {
            var node = stack.Pop();
            if (skipCollapsed && node is UIElement { Visibility: Visibility.Collapsed }) continue;
            yield return node;
            int n = VisualTreeHelper.GetChildrenCount(node);
            for (int i = n - 1; i >= 0; i--) stack.Push(VisualTreeHelper.GetChild(node, i));
        }
    }

    private static IEnumerable<(string Name, FrameworkElement Element, AutomationPeer Peer)> Named()
    {
        foreach (var e in Live().OfType<FrameworkElement>())
        {
            if (e.ActualWidth <= 0 || e.Opacity <= 0) continue;
            AutomationPeer? peer;
            string name;
            // an element on its way out (a list row in its remove transition) can refuse a peer: it is not there to find
            try { peer = FrameworkElementAutomationPeer.CreatePeerForElement(e); name = peer?.GetName() ?? ""; }
            catch (ArgumentException) { continue; }
            if (peer is not null && name.Length > 0) yield return (name, e, peer);
        }
    }

    private static bool Matches(string name, string pattern) => pattern.EndsWith('*') ? name.StartsWith(pattern[..^1], StringComparison.Ordinal) : name == pattern;

    /// <summary>Menus drawn inside the window: as their own popup windows they would activate the test window.</summary>
    private static void KeepInWindow(FrameworkElement e)
    {
        if (e.ContextFlyout is { } context) context.ShouldConstrainToRootBounds = true;
        if (e is Button { Flyout: { } flyout }) flyout.ShouldConstrainToRootBounds = true;
    }

    private static string Invoke(string pattern)
    {
        foreach (var (name, element, peer) in Named().Where(x => Matches(x.Name, pattern)))
        {
            KeepInWindow(element);
            if (peer.GetPattern(PatternInterface.Invoke) is IInvokeProvider invoke) { invoke.Invoke(); return "invoked: " + name; }
            if (peer.GetPattern(PatternInterface.Toggle) is IToggleProvider toggle) { toggle.Toggle(); return "toggled: " + name; }
            if (peer.GetPattern(PatternInterface.SelectionItem) is ISelectionItemProvider item) { item.Select(); return "selected: " + name; }
            if (peer.GetPattern(PatternInterface.ExpandCollapse) is IExpandCollapseProvider expand) { expand.Expand(); return "expanded: " + name; }
        }
        return "error: nothing invokable named " + pattern;
    }

    /// <summary>Opens the context menu of the element with that name (a library item, a queue row), inside the window.</summary>
    private static string Context(string pattern)
    {
        foreach (var (name, element, _) in Named().Where(x => Matches(x.Name, pattern)))
        {
            if (element.ContextFlyout is not { } flyout) continue;
            flyout.ShouldConstrainToRootBounds = true;
            flyout.ShowAt(element);
            return "opened: " + name;
        }
        return "error: no context menu on " + pattern;
    }

    private static string SetText(string spec)
    {
        int eq = spec.IndexOf('=');
        if (eq <= 0) return "error: set <name>=<text>";
        string name = spec[..eq], text = spec[(eq + 1)..];
        foreach (var (_, element, _) in Named().Where(x => x.Name == name))
        {
            switch (element)
            {
                case TextBox box: box.Text = text; return "set: " + name;
                case PasswordBox box: box.Password = text; return "set: " + name;
                case RangeBase range: range.Value = double.Parse(text, System.Globalization.CultureInfo.InvariantCulture); return "set: " + name;
            }
        }
        return "error: no text box named " + name;
    }

    private static string Choose(string arg)
    {
        int eq = arg.IndexOf('=');
        if (eq <= 0) return "error: choose <name>=<option>";
        string name = arg[..eq], option = arg[(eq + 1)..];
        foreach (var (_, element, _) in Named().Where(x => Matches(x.Name, name)))
        {
            if (element is not ComboBox box) continue;
            int index = box.Items.Select(i => (i as ComboBoxItem)?.Content?.ToString() ?? i?.ToString()).ToList().IndexOf(option);
            if (index < 0) return "error: no option " + option;
            box.SelectedIndex = index;
            return "chosen: " + option;
        }
        return "error: no combo box named " + name;
    }

    private static string Scroll(string percent)
    {
        var viewer = Live().OfType<ScrollViewer>().Where(s => s.ScrollableHeight > 0).MaxBy(s => s.ActualWidth * s.ActualHeight);
        if (viewer is null) return "error: nothing to scroll";
        double fraction = double.TryParse(percent, System.Globalization.CultureInfo.InvariantCulture, out var p) ? p / 100 : 1;
        viewer.ChangeView(null, viewer.ScrollableHeight * Math.Clamp(fraction, 0, 1), null, disableAnimation: true);
        return "scrolled";
    }

    /// <summary>"tabs <name> <n>": the keyboard's Tab order from that element, n steps, as the focus manager computes it
    /// (focus moves inside the app only; nothing is typed or activated).</summary>
    private static string Tabs(string arg)
    {
        int cut = arg.LastIndexOf(' ');
        if (cut <= 0 || !int.TryParse(arg[(cut + 1)..], out int n) || W?.Content is not UIElement root) return "error: tabs <name> <n>";
        string name = arg[..cut];
        // the first control with that name (a text with the same words is not a place the keyboard can be)
        // programmatic focus: keyboard focus would open the elements' tooltips, which are windows of their own
        if (Named().Select(x => x.Element).OfType<Control>().FirstOrDefault(c => Matches(FrameworkElementAutomationPeer.CreatePeerForElement(c)?.GetName() ?? "", name)) is not { } c
            || !c.Focus(FocusState.Programmatic)) return "error: cannot focus " + name;
        var order = new List<string>();
        for (int i = 0; i < n; i++)
        {
            if (FocusManager.FindNextElement(FocusNavigationDirection.Next, new FindNextElementOptions { SearchRoot = root }) is not Control next || !next.Focus(FocusState.Programmatic)) break;
            var peer = FrameworkElementAutomationPeer.CreatePeerForElement(next);
            order.Add($"{peer?.GetName()} [{next.GetType().Name}]");
        }
        return string.Join(Separator, order);
    }

    /// <summary>"iconcolor <name>": the colour the icon inside that control is drawn in, as #AARRGGBB (what the screen shows,
    /// not what the control asks for).</summary>
    private static string IconColor(string name)
    {
        foreach (var (_, element, _) in Named().Where(x => Matches(x.Name, name)))
        {
            var icon = element as Controls.KitIcon ?? Controls.Ui.Descendant<Controls.KitIcon>(element);
            if (icon is null) continue;
            // what PathIcon fills its outline with (or FontIcon writes its glyph in)
            var shape = Controls.Ui.Descendant<Microsoft.UI.Xaml.Shapes.Shape>(icon);
            var brush = shape is not null ? shape.Fill : Controls.Ui.Descendant<TextBlock>(icon)?.Foreground;
            if (brush is SolidColorBrush { Color: var c }) return FormattableString.Invariant($"#{c.A:X2}{c.R:X2}{c.G:X2}{c.B:X2}");
            return "error: the icon has no colour";
        }
        return "error: no icon in " + name;
    }

    private static string Resize(string size)
    {
        var p = size.Split(' ');
        if (p.Length != 2 || !int.TryParse(p[0], out int w) || !int.TryParse(p[1], out int h) || W is not { } window) return "error: resize <w> <h>";
        window.AppWindow.Resize(new Windows.Graphics.SizeInt32(w, h));
        return "resized";
    }

    /// <summary>Every interactive control on screen: problems only (no name, a click area under 24×24, an icon-only button
    /// without a tooltip), as "problem: what [type] at x,y".</summary>
    private static IEnumerable<string> Audit()
    {
        if (W?.Content is not UIElement root) yield break;
        foreach (var e in Live().OfType<Control>().Where(c => c.IsEnabled && c.ActualWidth > 0 && c.Visibility == Visibility.Visible && c is ButtonBase or TextBox or PasswordBox or Slider or ComboBox or ToggleSwitch))
        {
            if (e is ListViewItem) continue;
            var peer = FrameworkElementAutomationPeer.CreatePeerForElement(e);
            string name = peer?.GetName() ?? "";
            var at = e.TransformToVisual(root).TransformPoint(new Windows.Foundation.Point(0, 0));
            string where = FormattableString.Invariant($"[{e.GetType().Name}] at {at.X:0},{at.Y:0}");
            if (name.Length == 0 && e is not (TextBox { Header: not null } or PasswordBox { Header: not null } or ComboBox { Header: not null })) yield return $"no name: {where}";
            if (e.ActualWidth < 24 || e.ActualHeight < 24) yield return $"small ({e.ActualWidth:0}×{e.ActualHeight:0}): {name} {where}";
            if (e is ButtonBase { Content: string glyph } && glyph.Length == 1 && glyph[0] >= '' && ToolTipService.GetToolTip(e) is null && name.Length == 0) yield return $"icon without tooltip: {where}";
        }
    }
}
