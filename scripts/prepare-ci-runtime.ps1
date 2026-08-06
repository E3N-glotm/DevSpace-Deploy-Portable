[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$NodeCommand = Get-Command node.exe -ErrorAction Stop
$TargetDirectory = Join-Path $Root "runtime\node"
$Target = Join-Path $TargetDirectory "node.exe"

New-Item -ItemType Directory -Force -Path $TargetDirectory | Out-Null
Copy-Item -LiteralPath $NodeCommand.Source -Destination $Target -Force

Write-Host "Prepared CI runtime node: $Target"
& $Target -p "process.versions.node"

