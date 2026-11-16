param([string]$Target = 'gemini:antigravity')
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class AgyCredReader {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public uint Flags;
    public uint Type;
    public string TargetName;
    public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist;
    public uint AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredReadW(string target, uint type, uint flags, out IntPtr credential);
  [DllImport("advapi32.dll", SetLastError = true)]
  public static extern void CredFree(IntPtr buffer);
}
"@
$ptr = [IntPtr]::Zero
if (-not [AgyCredReader]::CredReadW($Target, 1, 0, [ref]$ptr)) {
  $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  [Console]::Error.WriteLine("credential '$Target' is not present (Win32 error $code)")
  exit 2
}
$cred = [Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][AgyCredReader+CREDENTIAL])
$length = [int]$cred.CredentialBlobSize
$bytes = New-Object byte[] $length
[Runtime.InteropServices.Marshal]::Copy($cred.CredentialBlob, $bytes, 0, $length)
[AgyCredReader]::CredFree($ptr) | Out-Null
$text = [Text.Encoding]::UTF8.GetString($bytes)
[Console]::Out.Write($text)
