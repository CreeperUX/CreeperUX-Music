using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.UI.Dispatching;

namespace Sonus;

/// <summary>
/// The UI thread's SynchronizationContext: WinUI's DispatcherQueueSynchronizationContext (Post, Send unchanged), except
/// that a wait on the UI thread does not pump at first.
/// <para>While an STA thread waits, the CLR pumps COM, and an incoming cross-apartment call runs right there, in the middle
/// of whatever the thread was doing. That was 0.6.2's crash after signing in again (the WER dump of the test instance,
/// read with dotnet-dump):
/// - XAML was laying out the library's ItemsRepeater. LibraryPane.Item set a tooltip, and wrapping its string for COM
///   (ComWrappers.GetOrCreateComInterfaceForObject) waited for a ConditionalWeakTable lock that another thread held.
/// - The finalizer thread was releasing the signed-out window's XAML objects, each a call into the UI thread
///   (IObjectReference.Finalize, Context.CallInContext).
/// - The CLR's pumping wait ran one of those calls inside the layout, and XAML failed fast (E_UNEXPECTED, 0xc000027b).</para>
/// <para>With SetWaitNotificationRequired the CLR hands every wait on this thread to <see cref="Wait"/>: a contended lock
/// (Monitor or System.Threading.Lock), Monitor.Wait, ManualResetEventSlim, SemaphoreSlim, Task.Wait and .Result,
/// WaitHandle, Thread.Join, ReaderWriterLockSlim, the runtime's and CsWinRT's locks too (measured; Thread.Sleep never
/// pumps). It first waits without pumping, for up to a second: a lock is held for microseconds to milliseconds. A longer
/// wait is logged and pumps, as the CLR would, so that a wait whose holder needs this thread (a call into this
/// apartment) costs at most a second instead of a deadlock. WPF does the same while it lays out.</para>
/// <para>Not covered, as before: COM's own modal loop while the UI thread makes an outgoing cross-apartment call, and waits
/// inside native code (XAML, CoreMessaging).</para>
/// </summary>
internal sealed partial class UiSynchronizationContext : DispatcherQueueSynchronizationContext
{
    private const int Grace = 1000; // ms
    private const uint WaitTimeout = 0x102;
    private readonly DispatcherQueue _queue;

    public UiSynchronizationContext(DispatcherQueue queue) : base(queue)
    {
        _queue = queue;
        SetWaitNotificationRequired();
    }

    /// <summary>A copy that waits the same way (the base's copy is a plain DispatcherQueueSynchronizationContext).</summary>
    public override SynchronizationContext CreateCopy() => new UiSynchronizationContext(_queue);

    public override int Wait(IntPtr[] waitHandles, bool waitAll, int millisecondsTimeout)
    {
        int first = millisecondsTimeout == Timeout.Infinite ? Grace : Math.Min(Grace, millisecondsTimeout);
        long start = Stopwatch.GetTimestamp();
        uint result = WaitForMultipleObjectsEx((uint)waitHandles.Length, waitHandles, waitAll, (uint)first, false);
        if (result != WaitTimeout || first == millisecondsTimeout) return (int)result;
        // acceptance fails on this line: the UI thread stood still for a second, then pumped (re-entrancy possible again)
        Log.Write($"[ui] waited {Stopwatch.GetElapsedTime(start).TotalMilliseconds:0} ms without pumping, pumping now: {Waiter()}");
        return base.Wait(waitHandles, waitAll, millisecondsTimeout == Timeout.Infinite ? Timeout.Infinite : millisecondsTimeout - first);
    }

    /// <summary>What waited: the managed frames above the runtime's wait (the lock's or the wait's caller).</summary>
    private static string Waiter()
    {
        var frames = new StackTrace(2, false).GetFrames()
            .Select(f => f.GetMethod())
            .Where(m => m?.DeclaringType is { } t && t.Namespace is not ("System.Threading" or "System.Threading.Tasks"))
            .Take(4)
            .Select(m => $"{m!.DeclaringType!.Name}.{m.Name}");
        return string.Join(" < ", frames);
    }

    [LibraryImport("kernel32.dll")]
    private static partial uint WaitForMultipleObjectsEx(uint count, IntPtr[] handles, [MarshalAs(UnmanagedType.Bool)] bool waitAll, uint milliseconds, [MarshalAs(UnmanagedType.Bool)] bool alertable);
}
