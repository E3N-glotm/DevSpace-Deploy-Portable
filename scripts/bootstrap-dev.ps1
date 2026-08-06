[CmdletBinding()]
param(
    [switch]$SkipInstall,
    [switch]$SkipNativeBuild
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $Root

$BundledNode = Join-Path $Root "runtime\node\node.exe"
$BundledNpm = Join-Path $Root "runtime\node\npm.cmd"
if (Test-Path $BundledNode) {
    $Node = $BundledNode
} else {
    $Node = (Get-Command node.exe -ErrorAction Stop).Source
}
if (Test-Path $BundledNpm) {
    $Npm = $BundledNpm
} else {
    $Npm = (Get-Command npm.cmd -ErrorAction Stop).Source
}

$NodeVersion = (& $Node -p "process.versions.node").Trim()
$NodeMajor = [int]($NodeVersion.Split('.')[0])
if ($NodeMajor -lt 22 -or $NodeMajor -ge 27) {
    throw "DevSpace requires Node >=22.19 and <27; found $NodeVersion."
}

Write-Host "Node: $NodeVersion"
& $Node scripts\pack-devspace-core.mjs
if ($LASTEXITCODE -ne 0) { throw "Portable core packaging failed." }

if (-not $SkipInstall) {
    & $Npm ci --prefix app
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed." }
}

& $Node setup\harden-nested-dependencies.mjs
if ($LASTEXITCODE -ne 0) { throw "Dependency hardening failed." }

& $Node scripts\verify-source-tree.mjs
if ($LASTEXITCODE -ne 0) { throw "Source-tree verification failed." }

if (-not $SkipNativeBuild) {
    $VsWhere = "C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe"
    if (Test-Path $VsWhere) {
        & $Node setup\build-native-ui.cjs
        if ($LASTEXITCODE -ne 0) { throw "Native UI build failed." }
    } else {
        Write-Warning "Visual Studio Build Tools were not found; native UI build was skipped."
    }
}

Write-Host "Development bootstrap completed."

