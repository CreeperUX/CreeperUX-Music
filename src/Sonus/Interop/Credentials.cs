using System.Runtime.InteropServices;
using System.Text;

namespace Sonus.Interop;

/// <summary>
/// The server sign-in (server, user, salt, token as JSON) in Windows Credential Manager, as a generic credential named
/// "Sonus:server" ("Sonus-test:server" for test instances). It shows under Control Panel →
/// Credential Manager → Windows Credentials. The password itself is never stored. Before 0.4 (CreeperUX Music) it was
/// "CreeperUXMusic:server": AdoptFormer takes that over.
/// </summary>
internal static partial class Credentials
{
    private static string TargetOf(string name) => $"{(AppPaths.IsTestInstance ? "Sonus-test" : "Sonus")}:{name}";
    private static string FormerTargetOf(string name) => $"{Core.AppName.FormerCredentialPrefix}{(AppPaths.IsTestInstance ? "-test" : "")}:{name}";
    private static string Target => TargetOf("server");
    /// <summary>Every entry the app keeps: the sign-in.</summary>
    private static readonly string[] Names = ["server"];
    /// <summary>Entries earlier versions kept that nothing reads any more: the GitHub token updates needed while the
    /// repository was private (0.5.0 and earlier, "Sonus:github", before 0.4 "CreeperUXMusic:github").</summary>
    private static readonly string[] Retired = ["github"];
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

    public static string? Read() => ReadTarget(Target);
    public static void Write(string value, string user) => WriteTarget(Target, value, user, "Sonus: music server sign-in (a token, not the password)");
    public static void Delete() => CredDelete(Target, CredTypeGeneric, 0);

    /// <summary>
    /// Deletes what earlier versions kept and nothing reads any more (Retired), under either name, once (later starts
    /// find nothing). Returns what went, for the log.
    /// </summary>
    public static List<string> DropRetired()
    {
        var done = new List<string>();
        foreach (string name in Retired)
            foreach (string target in new[] { TargetOf(name), FormerTargetOf(name) })
                if (ReadEntry(target) is not null && CredDelete(target, CredTypeGeneric, 0)) done.Add($"{target} deleted (no longer used)");
        return done;
    }

    /// <summary>
    /// Takes over the entries the app kept under its former name (CreeperUXMusic:server; "CreeperUXMusic-test:server"
    /// for a test instance), once: each is written under the new name with the same user, then deleted. One
    /// that already has an entry under the new name is only deleted. Returns what happened, for the log (no secrets).
    /// </summary>
    public static List<string> AdoptFormer()
    {
        var done = new List<string>();
        foreach (string name in Names)
        {
            string former = FormerTargetOf(name), target = TargetOf(name);
            if (ReadEntry(former) is not { } old) continue;
            if (ReadEntry(target) is null)
            {
                try { WriteTarget(target, old.Value, old.User ?? name, (old.Comment ?? "").Replace(Core.AppName.Former, Core.AppName.Name)); }
                catch (InvalidOperationException ex) { done.Add($"{former} not taken over: {ex.Message}"); continue; }
                done.Add($"{former} → {target}");
            }
            else done.Add($"{former} dropped ({target} already saved)");
            CredDelete(former, CredTypeGeneric, 0);
        }
        return done;
    }

    private static string? ReadTarget(string target) => ReadEntry(target)?.Value;

    private static (string Value, string? User, string? Comment)? ReadEntry(string target)
    {
        if (!CredRead(target, CredTypeGeneric, 0, out var ptr)) return null;
        try
        {
            var cred = Marshal.PtrToStructure<Credential>(ptr);
            if (cred.CredentialBlob == IntPtr.Zero || cred.CredentialBlobSize == 0) return null;
            var bytes = new byte[cred.CredentialBlobSize];
            Marshal.Copy(cred.CredentialBlob, bytes, 0, bytes.Length);
            return (Encoding.Unicode.GetString(bytes), cred.UserName, cred.Comment);
        }
        finally { CredFree(ptr); }
    }

    private static void WriteTarget(string target, string value, string user, string comment)
    {
        var bytes = Encoding.Unicode.GetBytes(value);
        if (bytes.Length > 2560) throw new InvalidOperationException("登录信息太长，凭据管理器放不下。");
        var blob = Marshal.AllocHGlobal(bytes.Length);
        try
        {
            Marshal.Copy(bytes, 0, blob, bytes.Length);
            var cred = new Credential
            {
                Type = CredTypeGeneric, TargetName = target, CredentialBlobSize = (uint)bytes.Length, CredentialBlob = blob, Persist = CredPersistLocalMachine,
                UserName = user, Comment = comment,
            };
            if (!CredWrite(ref cred, 0)) throw new InvalidOperationException($"凭据管理器拒绝保存（错误 {Marshal.GetLastWin32Error()}）。");
        }
        finally { Marshal.FreeHGlobal(blob); }
    }
}
