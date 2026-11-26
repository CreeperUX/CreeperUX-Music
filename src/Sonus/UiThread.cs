using Microsoft.UI.Dispatching;

namespace Sonus;

/// <summary>
/// Work the DispatcherQueue itself runs later: a TryEnqueue callback, a DispatcherQueueTimer's tick. An exception thrown
/// there does not reach Application.UnhandledException: WinUI stows it and fails fast (exit code 0xc000027b), and the app
/// is gone without a line in its log (0.6.2's x64 crash after signing in again). XAML event handlers, DispatcherTimer
/// ticks and async void methods are different: theirs do reach it (logged as "Unhandled:", and the app goes on).
/// So everything the queue runs goes through here: an exception is logged with its type, HRESULT and stack ("[ui] …
/// failed", which the acceptance run looks for), and the app goes on (losing the window and the music is worse than one
/// update that did not happen).
/// </summary>
public static class UiThread
{
    /// <summary>Runs <paramref name="action"/> later on that queue's thread; <paramref name="what"/> names it in the log.</summary>
    public static bool Post(DispatcherQueue queue, string what, Action action, DispatcherQueuePriority priority = DispatcherQueuePriority.Normal) =>
        queue.TryEnqueue(priority, () => Run(what, action));

    /// <summary>Runs it now, catching and logging what it throws (a DispatcherQueueTimer's tick).</summary>
    public static void Run(string what, Action action)
    {
        try { action(); }
        catch (Exception ex) { Failed(what, ex); }
    }

    private static void Failed(string what, Exception ex) =>
        Log.Write($"[ui] {what} failed: {ex.GetType().FullName} 0x{ex.HResult:X8} {ex.Message}{Environment.NewLine}{ex.StackTrace}");
}
