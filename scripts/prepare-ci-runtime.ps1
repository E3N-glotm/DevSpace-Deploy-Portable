[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$NodeCommand = Get-Command node.exe -ErrorAction Stop
$TargetDirectory = Join-Path $Root "runtime\node"
$Target = Join-Path $TargetDirectory "node.exe"
$CurlCommand = Get-Command curl.exe -ErrorAction Stop
$CurlTargetDirectory = Join-Path $Root "runtime\git\mingw64\bin"
$CurlTarget = Join-Path $CurlTargetDirectory "curl.exe"

New-Item -ItemType Directory -Force -Path $TargetDirectory | Out-Null
Copy-Item -LiteralPath $NodeCommand.Source -Destination $Target -Force
New-Item -ItemType Directory -Force -Path $CurlTargetDirectory | Out-Null
Copy-Item -LiteralPath $CurlCommand.Source -Destination $CurlTarget -Force

Write-Host "Prepared CI runtime node: $Target"
& $Target -p "process.versions.node"
Write-Host "Prepared CI runtime curl: $CurlTarget"
& $CurlTarget --version | Select-Object -First 1
