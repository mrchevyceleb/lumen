$ErrorActionPreference = 'Stop'
foreach ($entry in @('*\shell\Lumen.Open', 'Directory\shell\Lumen.Open', 'Directory\Background\shell\Lumen.Open', 'Drive\shell\Lumen.Open')) {
  [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree('Software\Classes\' + $entry, $false)
}
try {
if (-not ('LumenShellChanges' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class LumenShellChanges {
  [DllImport("shell32.dll")]
  public static extern void SHChangeNotify(int eventId, uint flags, IntPtr item1, IntPtr item2);
}
'@
}
[LumenShellChanges]::SHChangeNotify(0x08000000, 0x1000, [IntPtr]::Zero, [IntPtr]::Zero)
} catch {
  Write-Warning 'The menu entries were removed, but Explorer could not refresh them. Sign out and back in to reload the menu.'
}
Write-Output 'Removed Open with Lumen. Your application and data remain saved.'
