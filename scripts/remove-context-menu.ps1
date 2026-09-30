$ErrorActionPreference = 'Stop'
foreach ($entry in @('*\shell\Lumen.Open', 'Directory\shell\Lumen.Open', 'Directory\Background\shell\Lumen.Open', 'Drive\shell\Lumen.Open')) {
  [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree('Software\Classes\' + $entry, $false)
}
Write-Output 'Removed Open with Lumen. Your application and data remain saved.'
