# Run only on the disposable GitHub Actions Windows runner.
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'Installer validation requires a GitHub Actions runner.' }
$ErrorActionPreference = 'Stop'
$version = (Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\package.json') -Raw | ConvertFrom-Json).version
$setup = Join-Path $PSScriptRoot "..\release\Lumen-Setup-$version.exe"
$process = Start-Process -FilePath $setup -ArgumentList '/S' -PassThru -Wait -WindowStyle Hidden
if ($process.ExitCode -ne 0) { throw "Installer exited with $($process.ExitCode)." }
$entries = @('*', 'Directory', 'Directory\Background', 'Drive')
foreach ($entry in $entries) {
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Software\Classes\$entry\shell\Lumen.Open\command")
  if (-not $key) { throw "Missing Open with Lumen for $entry." }
  try { $command = $key.GetValue('') } finally { $key.Dispose() }
  if ($command -notmatch '^"(.+\\Lumen\.exe)" --open ".+"$') { throw "Invalid menu command for $entry." }
  $executable = $Matches[1]
  if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) { throw 'Installed executable missing.' }
}
if ((Get-Item -LiteralPath $executable).VersionInfo.ProductVersion -ne "$version.0") { throw 'Installed version mismatch.' }
if (-not (Test-Path -LiteralPath (Join-Path (Split-Path $executable) 'Uninstall Lumen.exe'))) { throw 'Uninstaller missing.' }
if (-not (Test-Path -LiteralPath (Join-Path (Split-Path $executable) 'resources\app-update.yml'))) { throw 'Update configuration missing.' }
if (-not (Test-Path -LiteralPath (Join-Path ([Environment]::GetFolderPath('Programs')) 'Lumen.lnk'))) { throw 'Start menu shortcut missing.' }
Write-Output 'Silent installation, installed version, four menu entries, Start menu shortcut, uninstaller, and update configuration passed.'
