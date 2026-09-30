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
Write-Output "Installed Open with Lumen for files, folders, folder backgrounds, and drives. Executable: $executable"
