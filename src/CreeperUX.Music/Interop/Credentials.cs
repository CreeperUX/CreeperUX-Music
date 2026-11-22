using System.Runtime.InteropServices;
using System.Text;

namespace CreeperUX.Music.Interop;

/// <summary>
/// The server sign-in (server, user, salt, token as JSON) in Windows Credential Manager, as a generic credential named
/// "CreeperUXMusic:server" ("CreeperUXMusic-test:server" for test instances). It shows under Control Panel →
/// Credential Manager → Windows Credentials. The password itself is never stored.
/// </summary>
internal static partial class Credentials
{
    private static string Target => AppPaths.IsTestInstance ? "CreeperUXMusic-test:server" : "CreeperUXMusic:server";
    private const uint CredTypeGeneric = 1, CredPersistLocalMachine = 2;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct Credential
    {
        public uint Flags, Type;
        public string TargetName;
        public string? Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist, AttributeCount;
        public IntPtr Attributes;
        public string? TargetAlias, UserName;
    }

    [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredWrite(ref Credential credential, uint flags);
    [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);
    [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredDelete(string target, uint type, uint flags);
    [DllImport("advapi32.dll")]
    private static extern void CredFree(IntPtr buffer);

    public static string? Read()
    {
        if (!CredRead(Target, CredTypeGeneric, 0, out var ptr)) return null;
        try
        {
            var cred = Marshal.PtrToStructure<Credential>(ptr);
            if (cred.CredentialBlob == IntPtr.Zero || cred.CredentialBlobSize == 0) return null;
            var bytes = new byte[cred.CredentialBlobSize];
            Marshal.Copy(cred.CredentialBlob, bytes, 0, bytes.Length);
            return Encoding.Unicode.GetString(bytes);
        }
        finally { CredFree(ptr); }
    }

    public static void Write(string value, string user)
    {
        var bytes = Encoding.Unicode.GetBytes(value);
        if (bytes.Length > 2560) throw new InvalidOperationException("登录信息太长，凭据管理器放不下。");
        var blob = Marshal.AllocHGlobal(bytes.Length);
        try
        {
            Marshal.Copy(bytes, 0, blob, bytes.Length);
            var cred = new Credential
            {
                Type = CredTypeGeneric, TargetName = Target, CredentialBlobSize = (uint)bytes.Length, CredentialBlob = blob, Persist = CredPersistLocalMachine,
                UserName = user, Comment = "CreeperUX Music: music server sign-in (a token, not the password)",
            };
            if (!CredWrite(ref cred, 0)) throw new InvalidOperationException($"凭据管理器拒绝保存登录信息（错误 {Marshal.GetLastWin32Error()}）。");
        }
        finally { Marshal.FreeHGlobal(blob); }
    }

    public static void Delete() => CredDelete(Target, CredTypeGeneric, 0);
}
