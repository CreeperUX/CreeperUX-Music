using System.Runtime.InteropServices;
using Microsoft.UI.Dispatching;

namespace Sonus;

/// <summary>
/// The UI thread's SynchronizationContext: the DispatcherQueue's, except that a wait on the UI thread does not pump at
/// first.
/// <para>While an STA thread waits (a contended lock, Task.Wait, a WaitHandle), the CLR pumps COM messages, and an incoming
/// cross-apartment call runs right there, in the middle of whatever the thread was doing. That was 0.6.2's crash after
/// signing in again (the WER dump in %LOCALAPPDATA%\CrashDumps):
/// - XAML was laying out an ItemsRepeater, and the handler building its rows waited for a lock another thread held;
/// - meanwhile the finalizer thread was releasing the signed-out window's XAML objects, each a call into the UI thread;
/// - the CLR's pumping wait ran one of those calls inside the layout, and XAML failed fast (E_UNEXPECTED, 0xc000027b).</para>
/// <para>So a wait here first waits without pumping, for up to a second (a lock is held for microseconds to
/// milliseconds). Only a longer wait pumps, as the CLR would, so that a wait for something that needs this thread (a
/// call into this apartment) cannot deadlock. WPF does the same while it lays out (DispatcherSynchronizationContext.Wait).</para>
/// </summary>
internal sealed partial class UiSynchronizationContext : DispatcherQueueSynchronizationContext
{
    private const int Grace = 1000; // ms
    private const uint WaitTimeout = 0x102;
    private readonly DispatcherQueue _queue;

    public UiSynchronizationContext(DispatcherQueue queue) : base(queue)
    {
        _queue = queue;
        SetWaitNotificationRequired(); // the CLR then calls Wait below for every wait on this thread, a contended lock too
    }

    public override SynchronizationContext CreateCopy() => new UiSynchronizationContext(_queue);

    public override int Wait(IntPtr[] waitHandles, bool waitAll, int millisecondsTimeout)
    {
        int first = millisecondsTimeout == Timeout.Infinite ? Grace : Math.Min(Grace, millisecondsTimeout);
        uint result = WaitForMultipleObjectsEx((uint)waitHandles.Length, waitHandles, waitAll, (uint)first, false);
        if (result != WaitTimeout || first == millisecondsTimeout) return (int)result;
        Log.Write($"[ui] a wait on the UI thread took over {Grace} ms: waiting on, pumping");
        return base.Wait(waitHandles, waitAll, millisecondsTimeout == Timeout.Infinite ? Timeout.Infinite : millisecondsTimeout - first);
    }

    [LibraryImport("kernel32.dll")]
    private static partial uint WaitForMultipleObjectsEx(uint count, IntPtr[] handles, [MarshalAs(UnmanagedType.Bool)] bool waitAll, uint milliseconds, [MarshalAs(UnmanagedType.Bool)] bool alertable);
}
