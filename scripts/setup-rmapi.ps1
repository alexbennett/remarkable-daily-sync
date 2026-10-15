param([string]$OutputDirectory = (Join-Path $PSScriptRoot '../bin'))
$ErrorActionPreference = 'Stop'
$revision = 'aa60dac8a8dbb1b4eb6a25f2caf2f3daea573373'
if (-not (Get-Command go -ErrorAction SilentlyContinue)) { throw 'Install Go 1.23 or newer before rebuilding rMAPI.' }
$buildDirectory = Join-Path ([IO.Path]::GetTempPath()) ('remarkable-rmapi-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $buildDirectory | Out-Null
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$outputPath = [IO.Path]::GetFullPath((Join-Path $OutputDirectory 'rmapi.exe'))
Expand-Archive -LiteralPath (Join-Path $PSScriptRoot '../bin/rmapi-source.zip') -DestinationPath (Join-Path $buildDirectory 'source')
Push-Location (Join-Path $buildDirectory 'source')
try {
  & go test . ./api ./auth ./config ./transport ./api/sync15 ./shell -run 'Authentication|Unexpired|RateLimit|RetryAfter|SaveTokens|AuthFailure|Append|Unvisited|ContentHash'
  if ($LASTEXITCODE -ne 0) { throw 'Guarded append tests failed.' }
  & go build -trimpath -ldflags "-X github.com/juruen/rmapi/version.Version=$revision-append-v1-auth-v1-cache-v1" -o $outputPath .
  if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }
} finally { Pop-Location }
Write-Output "Built $outputPath from $revision. Source retained at $buildDirectory."
