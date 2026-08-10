[CmdletBinding()]
param(
    [switch]$SkipInstall,
    [switch]$SkipAudit,
    [switch]$SkipNativeBuild
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $Root
$env:DEVSPACE_WINDOWS_TEXT_ENCODING = "utf-8"

$Node = Join-Path $Root "runtime\node\node.exe"
if (-not (Test-Path $Node)) {
    & (Join-Path $PSScriptRoot "prepare-ci-runtime.ps1")
}
$Npm = Join-Path $Root "runtime\node\npm.cmd"
if (-not (Test-Path $Npm)) {
    $Npm = (Get-Command npm.cmd -ErrorAction Stop).Source
}

& $Node scripts\verify-source-tree.mjs
if ($LASTEXITCODE -ne 0) { throw "Source-tree verification failed." }
& $Node scripts\pack-devspace-core.mjs
if ($LASTEXITCODE -ne 0) { throw "Portable core packaging failed." }

if (-not $SkipInstall) {
    & $Npm ci --prefix app
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed." }
}

& $Node setup\harden-nested-dependencies.mjs
if ($LASTEXITCODE -ne 0) { throw "Dependency hardening failed." }

if (-not $SkipNativeBuild) {
    & $Node setup\build-native-ui.cjs
    if ($LASTEXITCODE -ne 0) { throw "Native UI build failed." }
}

Write-Host "==> setup/test-incremental-update.py"
& python setup\test-incremental-update.py
if ($LASTEXITCODE -ne 0) { throw "Test failed: setup/test-incremental-update.py" }

Write-Host "==> setup/test-release-plugin-layout.py"
& python setup\test-release-plugin-layout.py
if ($LASTEXITCODE -ne 0) { throw "Test failed: setup/test-release-plugin-layout.py" }

$Tests = @(
    "setup/test-runtime-cards.mjs",
    "setup/test-runtime-log-ui.mjs",
    "setup/test-portable-ui-workflows.mjs",
    "setup/test-standalone-updater.mjs",
    "setup/test-selected-file-diff.mjs",
    "setup/test-online-updater-contract.mjs",
    "setup/test-updater-apply-recovery.mjs",
    "setup/test-update-launch-ack.mjs",
    "setup/test-dashboard-live-status.mjs",
    "setup/test-strict-stop.mjs",
    "setup/test-ui-open-process-safety.mjs",
    "setup/test-tunnel-network-coexistence.mjs",
    "setup/test-native-ui-resilience.mjs",
    "setup/test-native-close-tray.mjs",
    "setup/test-session-capabilities.mjs",
    "setup/test-portable-ui-heartbeat.mjs",
    "setup/test-plugin-manager.mjs",
    "setup/test-computer-use-batch.mjs",
    "setup/test-computer-use-broker.mjs"
)
foreach ($Test in $Tests) {
    Write-Host "==> $Test"
    & $Node $Test
    if ($LASTEXITCODE -ne 0) { throw "Test failed: $Test" }
}

if (-not $SkipAudit) {
    & $Npm audit --omit=dev --prefix app
    if ($LASTEXITCODE -ne 0) { throw "Production dependency audit failed." }
}

Write-Host "All source and Portable regression tests passed."

