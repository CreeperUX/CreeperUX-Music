using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;

namespace Sonus.Setup;

internal static partial class Native
{
    private const int DwmwaUseImmersiveDarkMode = 20, DwmwaWindowCornerPreference = 33, DwmwaBorderColor = 34;
    private const int DwmwcpRound = 2;
    private const int BorderColor = 0x0038332A; // COLORREF (0x00BBGGRR): the kit's raised hover colour, #2A3338

    [LibraryImport("dwmapi.dll")]
    private static partial int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

    /// <summary>The borderless window gets Windows 11's rounded corners, a dark frame and a thin border.</summary>
    public static void StyleWindow(Window window)
    {
        var hwnd = new WindowInteropHelper(window).Handle;
        int dark = 1, corners = DwmwcpRound, border = BorderColor;
        DwmSetWindowAttribute(hwnd, DwmwaUseImmersiveDarkMode, ref dark, sizeof(int));
        DwmSetWindowAttribute(hwnd, DwmwaWindowCornerPreference, ref corners, sizeof(int));
        DwmSetWindowAttribute(hwnd, DwmwaBorderColor, ref border, sizeof(int));
    }
}
