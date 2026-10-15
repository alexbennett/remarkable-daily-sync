param([Parameter(Mandatory=$true)][string]$VaultPath)
$ErrorActionPreference = 'Stop'
$projectPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$vaultRoot = (Resolve-Path -LiteralPath $VaultPath).Path
if (-not (Test-Path -LiteralPath (Join-Path $vaultRoot '.obsidian') -PathType Container)) { throw 'This directory is not an existing Obsidian vault.' }
$destination = [IO.Path]::GetFullPath((Join-Path $vaultRoot '.obsidian\plugins\remarkable-daily-sync'))
if (-not $destination.StartsWith($vaultRoot.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Plugin destination escaped the vault.' }
foreach ($file in @('main.js','manifest.json','styles.css','README.md')) {
  if (-not (Test-Path -LiteralPath (Join-Path $projectPath $file))) { throw "Build output missing: $file" }
}
New-Item -ItemType Directory -Force -Path $destination | Out-Null
foreach ($file in @('main.js','manifest.json','styles.css','README.md')) { Copy-Item -LiteralPath (Join-Path $projectPath $file) -Destination $destination -Force }
foreach ($folder in @('assets','bin','scripts','licenses')) {
  if (Test-Path -LiteralPath (Join-Path $projectPath $folder)) { Copy-Item -LiteralPath (Join-Path $projectPath $folder) -Destination $destination -Recurse -Force }
}
Write-Output "Installed files to $destination"
Write-Output 'Enable reMarkable Daily Sync in Obsidian community plugins. It starts paused; pair and validate before enabling automatic edits.'
