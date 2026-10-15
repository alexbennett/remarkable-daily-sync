param([Parameter(Mandatory=$true)][string]$StateDirectory, [string]$BinaryPath = (Join-Path $PSScriptRoot '../bin/rmapi.exe'))
$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 uses .NET Framework, which lacks IsPathFullyQualified.
# IsPathRooted alone also accepts drive-relative paths such as C:folder.
if ($StateDirectory -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$))') { throw 'Use the absolute private state directory shown in plugin settings, outside the vault.' }
$StateDirectory = [IO.Path]::GetFullPath($StateDirectory)
New-Item -ItemType Directory -Path $StateDirectory -Force | Out-Null
$previousConfig = $env:RMAPI_CONFIG
$previousCache = $env:LOCALAPPDATA
try {
  $env:RMAPI_CONFIG = Join-Path $StateDirectory 'rmapi.conf'
  $env:LOCALAPPDATA = $StateDirectory
  Write-Output 'Enter the pairing code when prompted. Cloud listing is read-only. Do not share the generated rmapi.conf file.'
  & $BinaryPath ls /
  if ($LASTEXITCODE -ne 0) { throw 'Pairing or cloud connection failed.' }
} finally {
  $env:RMAPI_CONFIG = $previousConfig
  $env:LOCALAPPDATA = $previousCache
}
