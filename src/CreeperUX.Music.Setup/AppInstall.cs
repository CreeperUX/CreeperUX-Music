using System.Diagnostics;
using System.IO;

namespace CreeperUX.Music.Setup;

/// <summary>The installed CreeperUX Music as the installer sees it: where it is, whether it runs.</summary>
internal static class AppInstall
{
    private static readonly string LocalAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);

    /// <summary>installer\Package.wxs: INSTALLFOLDER.</summary>
    public static string InstallDir { get; } = Path.Combine(LocalAppData, "Programs", "CreeperUX Music");

    public static string Exe => Path.Combine(InstallDir, "CreeperUX Music.exe");

    /// <summary>
    /// The installed app runs (its files couldn't be replaced). Another copy elsewhere (a build, a test instance) doesn't
    /// count. Asked with the least access there is, which also answers for one started as administrator.
    /// </summary>
    public static bool IsRunning()
    {
        foreach (var process in Process.GetProcessesByName("CreeperUX Music"))
        {
            using (process)
            {
                if (string.Equals(ImagePath(process.Id), Exe, StringComparison.OrdinalIgnoreCase)) return true;
            }
        }
        return false;
    }

    private static string? ImagePath(int processId)
    {
        IntPtr handle = OpenProcess(ProcessQueryLimitedInformation, false, (uint)processId);
        if (handle == IntPtr.Zero) return null; // exited meanwhile
        try
        {
            var path = new System.Text.StringBuilder(1024);
            uint size = (uint)path.Capacity;
            return QueryFullProcessImageNameW(handle, 0, path, ref size) ? path.ToString() : null;
        }
        finally { CloseHandle(handle); }
    }

    private const uint ProcessQueryLimitedInformation = 0x1000;

    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);

    [System.Runtime.InteropServices.DllImport("kernel32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode, SetLastError = true)]
    private static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, System.Text.StringBuilder path, ref uint size);

    [System.Runtime.InteropServices.DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    public static void Launch()
    {
        if (File.Exists(Exe)) Open(Exe, InstallDir);
    }

    public static void Open(string target, string? workingDirectory = null)
    {
        try { Process.Start(new ProcessStartInfo(target) { UseShellExecute = true, WorkingDirectory = workingDirectory ?? "" })?.Dispose(); }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException or FileNotFoundException) { }
    }
}
