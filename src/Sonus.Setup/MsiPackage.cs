using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;

namespace Sonus.Setup;

/// <summary>
/// Runs the embedded Sonus MSI (installer\Package.wxs) with Windows Installer's own dialogs turned off, as
/// Lumen's installer does, and turns its progress messages into a fraction and a step name for the window. The MSI does
/// all the work just as when double-clicked: major upgrade, the Start menu shortcut; uninstalling stays in Settings › Apps.
/// </summary>
internal static class MsiPackage
{
    /// <summary>installer\Package.wxs.</summary>
    private const string UpgradeCode = "{1CE8ADE0-F27F-42B5-BA8E-15AC5372DB2C}";

    /// <summary>The version inside ("0.3.0": package.ps1 builds the installer with the app's version).</summary>
    public static string Version { get; } = Assembly.GetEntryAssembly()!.GetName().Version!.ToString(3);

    public static string LogPath { get; } = Path.Combine(Path.GetTempPath(), "Sonus-Setup.log");

    /// <summary>The installed version ("0.3.0"), or null.</summary>
    public static string? InstalledVersion()
    {
        var code = new StringBuilder(39);
        for (uint i = 0; MsiEnumRelatedProductsW(UpgradeCode, 0, i, code) == 0; i++)
        {
            uint size = 32;
            var version = new StringBuilder((int)size);
            if (MsiGetProductInfoW(code.ToString(), "VersionString", version, ref size) == 0)
                return version.ToString();
        }
        return null;
    }

    public sealed record Result(int Code, string? Error)
    {
        /// <summary>0, or 3010 (done; a restart finishes it).</summary>
        public bool Succeeded => Code is 0 or 3010;
    }

    /// <param name="progress">0–1 and the current step; called on Windows Installer's thread.</param>
    public static Result Install(Action<double, string?> progress)
    {
        string msi = Path.Combine(Path.GetTempPath(), $"Sonus-{Version}-setup.msi");
        if (Extract(msi) is { } extractError)
            return new Result(-1, extractError);

        // This very package already installed (running the same installer again): Windows Installer would only
        // open its maintenance mode and change nothing. Asked to put every file back instead, as 重新安装 says.
        string arguments = "REBOOT=ReallySuppress";
        if (ProductCodeOf(msi) is { } productCode && MsiQueryProductStateW(productCode) == InstallStateDefault)
            arguments += " REINSTALL=ALL REINSTALLMODE=vomus";

        var tracker = new ProgressTracker(progress);
        InstallUiHandlerRecord handler = tracker.Handle; // kept alive for the call
        MsiSetInternalUI(InstallUiLevelNone, IntPtr.Zero);
        if (MsiSetExternalUIRecord(handler, Filter, IntPtr.Zero, IntPtr.Zero) != 0)
            progress(0, "正在安装…"); // no progress messages to show: the install still runs
        MsiEnableLogW(LogVerbose, LogPath, 0);
        try
        {
            int code = (int)MsiInstallProductW(msi, arguments);
            GC.KeepAlive(handler);
            return new Result(code, code is 0 or 3010 ? null : tracker.LastError ?? Describe(code));
        }
        finally
        {
            MsiSetExternalUIRecord(null, 0, IntPtr.Zero, IntPtr.Zero);
            try { File.Delete(msi); } catch (IOException) { } // Windows Installer keeps its own copy
        }
    }

    /// <summary>Writes the embedded MSI to <paramref name="path"/>; the reason when it can't (also --extract-msi, for tests).</summary>
    public static string? Extract(string path)
    {
        try
        {
            using var embedded = Assembly.GetEntryAssembly()!.GetManifestResourceStream("Sonus.msi");
            if (embedded is null)
                return "安装程序里没有找到安装包，请重新下载。";
            using var file = File.Create(path);
            embedded.CopyTo(file);
            return null;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return $"无法解出安装包：{ex.Message}";
        }
    }

    /// <summary>The package's ProductCode (another build of the same version has another one), or null.</summary>
    private static string? ProductCodeOf(string msi)
    {
        if (MsiOpenPackageExW(msi, OpenPackageIgnoreMachineState, out uint package) != 0)
            return null;
        try
        {
            uint size = 39;
            var code = new StringBuilder((int)size);
            return MsiGetProductPropertyW(package, "ProductCode", code, ref size) == 0 ? code.ToString() : null;
        }
        finally
        {
            MsiCloseHandle(package);
        }
    }

    private static string Describe(int code) => code switch
    {
        1602 => "安装被取消。",
        1618 => "另一个安装正在进行，请等它结束后再试。",
        1638 => "已经安装了另一个版本的 Sonus。",
        _ => $"Windows Installer 返回了错误 {code}。",
    };

    /// <summary>
    /// The standard progress algorithm (Windows Installer docs, "Parsing Windows Installer Messages"), with the two
    /// passes (generating the script, then running it) laid end to end: the first takes the first 15% of the bar.
    /// </summary>
    private sealed class ProgressTracker(Action<double, string?> report)
    {
        private long _total, _position;
        private bool _forward = true;
        private int _passes;
        private double _shown, _passStart;
        private string? _step;
        public string? LastError;

        public int Handle(IntPtr context, uint messageType, uint record)
        {
            switch (messageType & 0xFF000000)
            {
                case InstallMessageProgress:
                    Progress(record);
                    break;
                case InstallMessageActionStart:
                    if (StepName(Field(record, 1)) is { } step)
                    {
                        _step = step;
                        report(_shown, _step);
                    }
                    break;
                case InstallMessageError:
                case InstallMessageFatalExit:
                    LastError = Format(record);
                    break;
            }
            return 0; // nothing decided here: Windows Installer goes on as with no UI
        }

        private void Progress(uint record)
        {
            switch (MsiRecordGetInteger(record, 1))
            {
                case 0: // reset: a new pass
                    _total = MsiRecordGetInteger(record, 2);
                    _forward = MsiRecordGetInteger(record, 3) == 0;
                    _position = _forward ? 0 : _total;
                    _passes++;
                    _passStart = _shown;
                    if (!_forward)
                        _step = "正在撤销更改…";
                    break;
                case 2: // a step of the current pass
                    if (_total > 0)
                        _position += _forward ? MsiRecordGetInteger(record, 2) : -MsiRecordGetInteger(record, 2);
                    break;
                case 3: // more to do in this pass
                    _total += MsiRecordGetInteger(record, 2);
                    break;
            }
            if (_total <= 0)
                return;
            double pass = Math.Clamp((double)_position / _total, 0, 1);
            // The first pass (writing the script) fills the first 15%. Each later pass fills what is left, except
            // while the old version is removed (an upgrade): that has passes of its own and stays below 30%, so the
            // bar doesn't reach the end before the files are even copied.
            double end = _step == ReplacingStep ? Math.Max(0.3, _passStart) : 1;
            double overall = _passes <= 1 ? pass * 0.15 : _passStart + pass * (end - _passStart);
            if (overall > _shown || !_forward)
                _shown = overall;
            report(_shown, _step);
        }

        /// <summary>Plain words for the actions that take time; others keep the last step shown.</summary>
        private const string ReplacingStep = "正在替换旧版本…";

        private static string? StepName(string? action) => action switch
        {
            "InstallValidate" or "CostFinalize" => "正在检查…",
            "RemoveExistingProducts" => ReplacingStep,
            "InstallFiles" => "正在复制文件…",
            
            "CreateShortcuts" => "正在创建开始菜单快捷方式…",
            "InstallFinalize" => "正在完成…",
            _ => null,
        };

        private static string? Format(uint record)
        {
            uint size = 0;
            var empty = new StringBuilder(1);
            MsiFormatRecordW(0, record, empty, ref size);
            var text = new StringBuilder((int)++size);
            return MsiFormatRecordW(0, record, text, ref size) == 0 ? text.ToString() : null;
        }

        private static string? Field(uint record, uint field)
        {
            uint size = 128;
            var text = new StringBuilder((int)size);
            return MsiRecordGetStringW(record, field, text, ref size) == 0 ? text.ToString() : null;
        }
    }

    private const int InstallUiLevelNone = 2;
    private const uint InstallMessageFatalExit = 0x00000000, InstallMessageError = 0x01000000;
    private const uint InstallMessageActionStart = 0x08000000, InstallMessageProgress = 0x0A000000;
    // INSTALLLOGMODE_FATALEXIT | ERROR | WARNING | USER | ACTIONSTART | PROGRESS
    private const uint Filter = 0x1 | 0x2 | 0x4 | 0x8 | 0x100 | 0x400;
    // Everything a support log wants, verbose included
    private const uint LogVerbose = 0x1 | 0x2 | 0x4 | 0x8 | 0x10 | 0x40 | 0x80 | 0x100 | 0x200 | 0x400 | 0x800 | 0x1000;

    // MSIHANDLE is a 32-bit handle on every architecture
    private delegate int InstallUiHandlerRecord(IntPtr context, uint messageType, uint record);

    [DllImport("msi.dll", CharSet = CharSet.Unicode)] private static extern uint MsiEnumRelatedProductsW(string upgradeCode, uint reserved, uint index, StringBuilder productCode);
    [DllImport("msi.dll", CharSet = CharSet.Unicode)] private static extern uint MsiGetProductInfoW(string product, string property, StringBuilder value, ref uint size);
    [DllImport("msi.dll")] private static extern int MsiSetInternalUI(int level, IntPtr window);
    [DllImport("msi.dll")] private static extern int MsiSetExternalUIRecord(InstallUiHandlerRecord? handler, uint filter, IntPtr context, IntPtr previous);
    [DllImport("msi.dll", CharSet = CharSet.Unicode)] private static extern uint MsiEnableLogW(uint mode, string path, uint attributes);
    [DllImport("msi.dll", CharSet = CharSet.Unicode)] private static extern uint MsiInstallProductW(string package, string commandLine);
    [DllImport("msi.dll")] private static extern int MsiRecordGetInteger(uint record, uint field);
    [DllImport("msi.dll", CharSet = CharSet.Unicode)] private static extern uint MsiRecordGetStringW(uint record, uint field, StringBuilder value, ref uint size);
    [DllImport("msi.dll", CharSet = CharSet.Unicode)] private static extern uint MsiFormatRecordW(uint install, uint record, StringBuilder result, ref uint size);
    [DllImport("msi.dll", CharSet = CharSet.Unicode)] private static extern uint MsiOpenPackageExW(string path, uint options, out uint package);
    [DllImport("msi.dll", CharSet = CharSet.Unicode)] private static extern uint MsiGetProductPropertyW(uint package, string property, StringBuilder value, ref uint size);
    [DllImport("msi.dll")] private static extern uint MsiCloseHandle(uint handle);
    [DllImport("msi.dll", CharSet = CharSet.Unicode)] private static extern int MsiQueryProductStateW(string product);

    private const uint OpenPackageIgnoreMachineState = 1;
    private const int InstallStateDefault = 5;
}
