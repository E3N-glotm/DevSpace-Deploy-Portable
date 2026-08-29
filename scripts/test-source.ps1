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
$ProgressLog = [string]$env:DEVSPACE_TEST_PROGRESS_LOG

function Write-TestProgress([string]$Message) {
    if ([string]::IsNullOrWhiteSpace($ProgressLog)) { return }
    $line = "[{0}] {1}" -f ([DateTime]::UtcNow.ToString("o")), $Message
    [IO.File]::AppendAllText($ProgressLog, $line + [Environment]::NewLine, [Text.Encoding]::UTF8)
}

$Node = Join-Path $Root "runtime\node\node.exe"
if (-not (Test-Path $Node)) {
    & (Join-Path $PSScriptRoot "prepare-ci-runtime.ps1")
}
$Npm = Join-Path $Root "runtime\node\npm.cmd"
if (-not (Test-Path $Npm)) {
    $Npm = (Get-Command npm.cmd -ErrorAction Stop).Source
}

function Invoke-NativeChecked {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,
        [string[]]$ArgumentList = @(),
        [Parameter(Mandatory = $true)]
        [string]$FailureMessage
    )

    # Windows PowerShell 5.1 may surface a native process' stderr as a
    # NativeCommandError when ErrorActionPreference=Stop even when that
    # process exits successfully. Treat the real process exit code as the
    # authoritative result for every native gate while keeping stderr visible.
    Write-TestProgress "BEGIN $FailureMessage :: $FilePath $($ArgumentList -join ' ')"
    $PreviousErrorActionPreference = $ErrorActionPreference
    $NativeExitCode = 0
    try {
        $ErrorActionPreference = "Continue"
        & $FilePath @ArgumentList
        $NativeExitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $PreviousErrorActionPreference
    }
    if ($NativeExitCode -ne 0) {
        Write-TestProgress "FAIL exit=$NativeExitCode :: $FailureMessage"
        throw "$FailureMessage (exit $NativeExitCode)"
    }
    Write-TestProgress "PASS exit=0 :: $FailureMessage"
}

Invoke-NativeChecked -FilePath $Node -ArgumentList @("scripts\verify-source-tree.mjs") -FailureMessage "Source-tree verification failed."
Invoke-NativeChecked -FilePath $Node -ArgumentList @("scripts\pack-devspace-core.mjs") -FailureMessage "Portable core packaging failed."

if (-not $SkipInstall) {
    Invoke-NativeChecked -FilePath $Npm -ArgumentList @("ci", "--prefix", "app") -FailureMessage "npm ci failed."
}

Invoke-NativeChecked -FilePath $Node -ArgumentList @("setup\harden-nested-dependencies.mjs") -FailureMessage "Dependency hardening failed."

if (-not $SkipNativeBuild) {
    Invoke-NativeChecked -FilePath $Node -ArgumentList @("setup\build-native-ui.cjs") -FailureMessage "Native UI build failed."
}

Write-Host "==> setup/test-incremental-update.py"
Invoke-NativeChecked -FilePath "python" -ArgumentList @("setup\test-incremental-update.py") -FailureMessage "Test failed: setup/test-incremental-update.py"

Write-Host "==> setup/test-incremental-chain.py"
Invoke-NativeChecked -FilePath "python" -ArgumentList @("setup\test-incremental-chain.py") -FailureMessage "Test failed: setup/test-incremental-chain.py"

Write-Host "==> setup/test-update-manifest-graph.py"
Invoke-NativeChecked -FilePath "python" -ArgumentList @("setup\test-update-manifest-graph.py") -FailureMessage "Test failed: setup/test-update-manifest-graph.py"

Write-Host "==> setup/test-rescue-overlay.py"
Invoke-NativeChecked -FilePath "python" -ArgumentList @("setup\test-rescue-overlay.py") -FailureMessage "Test failed: setup/test-rescue-overlay.py"

Write-Host "==> setup/test-release-plugin-layout.py"
Invoke-NativeChecked -FilePath "python" -ArgumentList @("setup\test-release-plugin-layout.py") -FailureMessage "Test failed: setup/test-release-plugin-layout.py"

$Tests = @(
    "setup/test-runtime-cards.mjs",
    "setup/test-runtime-log-ui.mjs",
    "setup/test-portable-ui-workflows.mjs",
    "setup/test-oauth-client-compatibility.mjs",
    "setup/test-standalone-updater.mjs",
    "setup/test-selected-file-diff.mjs",
    "setup/test-online-updater-contract.mjs",
    "setup/test-blockmap-update.mjs",
    "setup/test-release-migration-contract.mjs",
    "setup/test-updater-apply-recovery.mjs",
    "setup/test-update-launch-ack.mjs",
    "setup/test-dashboard-live-status.mjs",
    "setup/test-dashboard-probe-concurrency.mjs",
    "setup/test-strict-stop.mjs",
    "setup/test-ui-open-process-safety.mjs",
    "setup/test-tunnel-network-coexistence.mjs",
    "setup/test-network-isolation-contract.mjs",
    "setup/test-core-memory-bounds.mjs",
    "setup/test-native-ui-resilience.mjs",
    "setup/test-native-close-tray.mjs",
    "setup/test-upstream-workspace-reuse.mjs",
    "setup/test-remote-workspace-backend.mjs",
    "setup/test-linux-agent-contract.mjs",
    "setup/test-continuation-guard.mjs",
    "setup/test-remote-agent-ssh-rescue.mjs",
    "setup/test-session-capabilities.mjs",
    "setup/test-portable-ui-heartbeat.mjs",
    "setup/test-plugin-manager.mjs",
    "setup/test-computer-use-batch.mjs",
    "setup/test-computer-use-broker.mjs"
)
foreach ($Test in $Tests) {
    Write-Host "==> $Test"
    Invoke-NativeChecked -FilePath $Node -ArgumentList @($Test) -FailureMessage "Test failed: $Test"
}

if (-not $SkipAudit) {
    Invoke-NativeChecked -FilePath $Npm -ArgumentList @("audit", "--omit=dev", "--prefix", "app") -FailureMessage "Production dependency audit failed."
}

Write-Host "All source and Portable regression tests passed."
Write-TestProgress "PASS ALL source and Portable regression tests"
exit 0

