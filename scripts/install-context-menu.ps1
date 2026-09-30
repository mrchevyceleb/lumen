param(
  [string]$SourceDirectory = (Join-Path $PSScriptRoot '..\release\win-unpacked'),
  [string]$InstallDirectory = (Join-Path $env:LOCALAPPDATA 'Programs\Lumen')
)
$ErrorActionPreference = 'Stop'
$source = (Resolve-Path -LiteralPath $SourceDirectory).Path
if (-not (Test-Path -LiteralPath (Join-Path $source 'Lumen.exe') -PathType Leaf)) { throw 'Build Lumen first with npm run package.' }
$destination = [IO.Path]::GetFullPath($InstallDirectory)
if ($source.TrimEnd('\') -eq $destination.TrimEnd('\')) { throw 'Choose a separate installation folder.' }
$executable = Join-Path $destination 'Lumen.exe'
$running = Get-CimInstance Win32_Process -Filter "Name='Lumen.exe'" | Where-Object { $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath) -eq $executable }
if ($running) { throw 'Close the installed Lumen app before updating. No application files or menu entries were changed.' }
New-Item -ItemType Directory -Path $destination -Force | Out-Null
Get-ChildItem -LiteralPath $source -Force | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $destination -Recurse -Force }
$entries = @{
  '*\shell\Lumen.Open' = '%1'
  'Directory\shell\Lumen.Open' = '%1\.'
  'Directory\Background\shell\Lumen.Open' = '%V\.'
  'Drive\shell\Lumen.Open' = '%1\.'
}
foreach ($entry in $entries.GetEnumerator()) {
  $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Software\Classes\' + $entry.Key)
  try {
    $key.SetValue('', 'Open with Lumen')
    $key.SetValue('Icon', '"' + $executable + '",0')
    $key.SetValue('MultiSelectModel', 'Document')
    $command = $key.CreateSubKey('command')
    try { $command.SetValue('', '"' + $executable + '" --open "' + $entry.Value + '"') } finally { $command.Dispose() }
  } finally { $key.Dispose() }
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
# SHCNE_ASSOCCHANGED + SHCNF_IDLIST | SHCNF_FLUSH reload Explorer's shell registrations.
[LumenShellChanges]::SHChangeNotify(0x08000000, 0x1000, [IntPtr]::Zero, [IntPtr]::Zero)
} catch {
  Write-Warning 'The menu entries were installed, but Explorer could not refresh them. Sign out and back in to reload the menu.'
}
Write-Output "Installed Open with Lumen for files, folders, folder backgrounds, and drives. Executable: $executable"
