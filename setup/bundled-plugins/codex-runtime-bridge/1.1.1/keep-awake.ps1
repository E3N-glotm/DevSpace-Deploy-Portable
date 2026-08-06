param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateSet('start', 'status', 'stop')]
    [string]$Action,

    [Parameter(Mandatory = $true, Position = 1)]
    [string]$PidFile
)

$ErrorActionPreference = 'Stop'
$pidDirectory = Split-Path -Parent $PidFile
if (-not (Test-Path -LiteralPath $pidDirectory)) {
    New-Item -ItemType Directory -Path $pidDirectory -Force | Out-Null
}

function Read-KeepAwakePid {
    if (-not (Test-Path -LiteralPath $PidFile)) { return $null }
    $value = (Get-Content -LiteralPath $PidFile -Raw).Trim()
    if ($value -notmatch '^\d+$') { return $null }
    return [int]$value
}

function Get-KeepAwakeProcess {
    $savedPid = Read-KeepAwakePid
    if (-not $savedPid) { return $null }
    return Get-Process -Id $savedPid -ErrorAction SilentlyContinue
}

if ($Action -eq 'status') {
    $process = Get-KeepAwakeProcess
    [ordered]@{
        running = [bool]$process
        pid = if ($process) { $process.Id } else { $null }
        pidFile = $PidFile
    } | ConvertTo-Json -Depth 4
    exit 0
}

if ($Action -eq 'stop') {
    $process = Get-KeepAwakeProcess
    if ($process) {
        Stop-Process -Id $process.Id -Force
    }
    Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
    [ordered]@{
        stopped = [bool]$process
        pid = if ($process) { $process.Id } else { $null }
        pidFile = $PidFile
    } | ConvertTo-Json -Depth 4
    exit 0
}

$existing = Get-KeepAwakeProcess
if ($existing -and $existing.Id -ne $PID) {
    throw "A keep-awake process is already running with PID $($existing.Id)."
}

Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class DevSpacePower {
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint SetThreadExecutionState(uint esFlags);
}
'@

[uint32]$ES_CONTINUOUS = 2147483648
[uint32]$ES_SYSTEM_REQUIRED = 1
[uint32]$ES_AWAYMODE_REQUIRED = 64
[uint32]$flags = $ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED -bor $ES_AWAYMODE_REQUIRED
$result = [DevSpacePower]::SetThreadExecutionState($flags)
if ($result -eq 0) {
    throw "SetThreadExecutionState failed."
}

Set-Content -LiteralPath $PidFile -Value $PID -Encoding ASCII
[ordered]@{
    running = $true
    pid = $PID
    pidFile = $PidFile
    mode = 'system-required+away-mode'
} | ConvertTo-Json -Depth 4

try {
    while ($true) {
        Start-Sleep -Seconds 60
    }
}
finally {
    [void][DevSpacePower]::SetThreadExecutionState($ES_CONTINUOUS)
    Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
}
