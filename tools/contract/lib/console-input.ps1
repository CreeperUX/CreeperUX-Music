# Runs a program in a pseudo console (Windows ConPTY) and types lines into it: for a command that reads from a real
# console only, as `navidrome user edit --set-password` does (term.ReadPassword fails on a pipe).
#   powershell -NoProfile -File console-input.ps1 -Exe <program> -ArgsLine "<arguments>" -Cwd <folder>
# The lines to type come from the environment variable CONSOLE_INPUT (lines separated by "\n"), so they are on no
# command line. The program's console output is printed (the typed lines are not echoed by a password prompt).
# Exit code: the program's.
param([Parameter(Mandatory)][string]$Exe, [string]$ArgsLine = '', [string]$Cwd = (Get-Location).Path, [int]$TimeoutMs = 60000)
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class ConsoleInput {
    [StructLayout(LayoutKind.Sequential)] struct COORD { public short X, Y; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO {
        public int cb; public string lpReserved, lpDesktop, lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
    [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }

    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CreatePipe(out SafeFileHandle r, out SafeFileHandle w, IntPtr sa, int size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern int CreatePseudoConsole(COORD size, SafeFileHandle input, SafeFileHandle output, uint flags, out IntPtr pc);
    [DllImport("kernel32.dll", SetLastError = true)] static extern void ClosePseudoConsole(IntPtr pc);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attr, IntPtr value, IntPtr size, IntPtr prev, IntPtr retSize);
    [DllImport("kernel32.dll", SetLastError = true)] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcessW(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFOEX si, out PROCESS_INFORMATION pi);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr h, uint ms);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr h, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr h);

    const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    static readonly IntPtr PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE = (IntPtr)0x00020016;

    public static int Run(string commandLine, string cwd, string[] lines, int timeoutMs, StringBuilder output) {
        SafeFileHandle inRead, inWrite, outRead, outWrite;
        if (!CreatePipe(out inRead, out inWrite, IntPtr.Zero, 0) || !CreatePipe(out outRead, out outWrite, IntPtr.Zero, 0))
            throw new Exception("CreatePipe failed: " + Marshal.GetLastWin32Error());
        IntPtr pc;
        int hr = CreatePseudoConsole(new COORD { X = 200, Y = 50 }, inRead, outWrite, 0, out pc);
        if (hr != 0) throw new Exception("CreatePseudoConsole failed: 0x" + hr.ToString("x"));
        inRead.Dispose(); outWrite.Dispose();

        // the console's output must be read all along, or the program blocks writing to it
        var outStream = new FileStream(outRead, FileAccess.Read);
        var reader = new Thread(() => {
            var buf = new byte[4096]; int n;
            try { while ((n = outStream.Read(buf, 0, buf.Length)) > 0) lock (output) output.Append(Encoding.UTF8.GetString(buf, 0, n)); } catch (IOException) { }
        });
        reader.IsBackground = true; reader.Start();

        IntPtr size = IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
        var si = new STARTUPINFOEX();
        si.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
        // empty standard handles: else the program gets this process's (pipes, when it runs under node) and not the
        // pseudo console's
        si.StartupInfo.dwFlags = 0x00000100; // STARTF_USESTDHANDLES
        si.lpAttributeList = Marshal.AllocHGlobal(size);
        if (!InitializeProcThreadAttributeList(si.lpAttributeList, 1, 0, ref size)) throw new Exception("InitializeProcThreadAttributeList failed");
        if (!UpdateProcThreadAttribute(si.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, pc, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero))
            throw new Exception("UpdateProcThreadAttribute failed: " + Marshal.GetLastWin32Error());
        PROCESS_INFORMATION pi;
        if (!CreateProcessW(null, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, false, EXTENDED_STARTUPINFO_PRESENT, IntPtr.Zero, cwd, ref si, out pi))
            throw new Exception("CreateProcess failed: " + Marshal.GetLastWin32Error());

        var input = new FileStream(inWrite, FileAccess.Write);
        foreach (var line in lines) {
            // each line once the program has had time to ask for it
            Thread.Sleep(1500);
            var bytes = Encoding.UTF8.GetBytes(line + "\r");
            try { input.Write(bytes, 0, bytes.Length); input.Flush(); } catch (IOException) { break; }
        }
        uint code = 1;
        if (WaitForSingleObject(pi.hProcess, (uint)timeoutMs) != 0) { TerminateProcess(pi.hProcess, 124); code = 124; }
        else GetExitCodeProcess(pi.hProcess, out code);
        ClosePseudoConsole(pc);
        reader.Join(2000);
        input.Dispose();
        CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
        DeleteProcThreadAttributeList(si.lpAttributeList); Marshal.FreeHGlobal(si.lpAttributeList);
        return (int)code;
    }
}
'@

$lines = @()
if ($env:CONSOLE_INPUT) { $lines = $env:CONSOLE_INPUT -split "`n" }
$out = New-Object System.Text.StringBuilder
$cmd = '"' + $Exe + '"' + $(if ($ArgsLine) { ' ' + $ArgsLine } else { '' })
$code = [ConsoleInput]::Run($cmd, $Cwd, $lines, $TimeoutMs, $out)
# without the console's control sequences
[Console]::Out.Write(($out.ToString() -replace "\x1b\[[0-9;?]*[A-Za-z]", '' -replace "\x1b\][^\x07]*\x07", ''))
exit $code
