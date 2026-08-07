[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("Check", "Stage", "Apply")]
    [string]$Action,

    [Parameter(Mandatory = $true)]
    [string]$Root,

    [string]$Repository = "E3N-glotm/DevSpace-Deploy-Portable",
    [string]$CurrentVersion = "0.0.0",
    [string]$StagingPath = "",
    [int]$UiPid = 0
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

$Root = [IO.Path]::GetFullPath($Root).TrimEnd('\')
$UpdateRoot = Join-Path $Root ".update-staging"
$StateDirectory = Join-Path $Root "data\state"
$LogDirectory = Join-Path $Root "logs"
$ResultFile = Join-Path $StateDirectory "update-result.json"
$UpdateLog = Join-Path $LogDirectory "update.log"

function Write-JsonResult([object]$Value) {
    $Value | ConvertTo-Json -Depth 12 -Compress
}

function Write-UpdateLog([string]$Message) {
    New-Item -ItemType Directory -Force -Path $LogDirectory | Out-Null
    $line = "[{0}] {1}" -f (Get-Date).ToString("yyyy-MM-dd HH:mm:ss"), $Message
    Add-Content -LiteralPath $UpdateLog -Value $line -Encoding UTF8
}

function Write-UpdateResult([object]$Value) {
    New-Item -ItemType Directory -Force -Path $StateDirectory | Out-Null
    $Value | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $ResultFile -Encoding UTF8
}

function Assert-Version([string]$Value, [string]$Name) {
    if ($Value -notmatch '^\d+\.\d+\.\d+$') {
        throw "$Name is not a supported semantic version: $Value"
    }
}

function Compare-Version([string]$Left, [string]$Right) {
    Assert-Version $Left "Left version"
    Assert-Version $Right "Right version"
    return ([Version]$Left).CompareTo([Version]$Right)
}

function Get-LatestRelease {
    $headers = @{
        Accept = "application/vnd.github+json"
        "X-GitHub-Api-Version" = "2022-11-28"
        "User-Agent" = "DevSpace-Portable-Updater/$CurrentVersion"
    }
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repository/releases/latest" -Headers $headers -Method Get -TimeoutSec 60
    $version = ([string]$release.tag_name).TrimStart('v')
    Assert-Version $version "Release version"
    $manifestAsset = @($release.assets) | Where-Object { $_.name -eq "update-manifest.json" } | Select-Object -First 1
    $zipName = "DevSpacePortable-Windows-x64-$version.zip"
    $zipAsset = @($release.assets) | Where-Object { $_.name -eq $zipName } | Select-Object -First 1
    if (-not $manifestAsset) { throw "Latest Release has no update-manifest.json asset." }
    if (-not $zipAsset) { throw "Latest Release has no $zipName asset." }
    $manifest = Invoke-RestMethod -Uri $manifestAsset.browser_download_url -Headers @{ "User-Agent" = "DevSpace-Portable-Updater/$CurrentVersion" } -Method Get -TimeoutSec 60
    if ([string]$manifest.version -ne $version) { throw "Release tag and update manifest version do not match." }
    if ([string]$manifest.asset.name -ne $zipName) { throw "Update manifest references an unexpected ZIP name." }
    if ([string]$manifest.repository -ne $Repository) { throw "Update manifest repository does not match the configured repository." }
    return [pscustomobject]@{
        release = $release
        version = $version
        manifest = $manifest
        manifestAsset = $manifestAsset
        zipAsset = $zipAsset
        zipName = $zipName
    }
}

function Get-UpdateStatus {
    $latest = Get-LatestRelease
    $comparison = Compare-Version $latest.version $CurrentVersion
    return [pscustomobject]@{
        currentVersion = $CurrentVersion
        latestVersion = $latest.version
        updateAvailable = $comparison -gt 0
        sameVersion = $comparison -eq 0
        releaseUrl = [string]$latest.release.html_url
        releaseName = [string]$latest.release.name
        publishedAt = [string]$latest.release.published_at
        assetName = [string]$latest.manifest.asset.name
        assetSize = [int64]$latest.manifest.asset.size
        assetSha256 = ([string]$latest.manifest.asset.sha256).ToLowerInvariant()
        sourceCheckout = Test-Path (Join-Path $Root ".git")
        restartRequired = [bool]$latest.manifest.restartRequired
    }
}

function Remove-OldStagingDirectories {
    if (-not (Test-Path $UpdateRoot)) { return }
    $cutoff = (Get-Date).AddDays(-7)
    Get-ChildItem -LiteralPath $UpdateRoot -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTime -lt $cutoff } |
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}

function Stage-Update {
    $latest = Get-LatestRelease
    if ((Compare-Version $latest.version $CurrentVersion) -le 0) {
        return [pscustomobject]@{
            currentVersion = $CurrentVersion
            latestVersion = $latest.version
            updateAvailable = $false
            staged = $false
        }
    }
    Remove-OldStagingDirectories
    New-Item -ItemType Directory -Force -Path $UpdateRoot | Out-Null
    $stage = Join-Path $UpdateRoot ("{0}-{1}" -f $latest.version, [guid]::NewGuid().ToString("N"))
    $payload = Join-Path $stage "payload"
    $zip = Join-Path $stage $latest.zipName
    New-Item -ItemType Directory -Force -Path $stage,$payload | Out-Null
    try {
        Write-UpdateLog "Downloading $($latest.zipName) from GitHub Release $($latest.version)."
        Invoke-WebRequest -Uri $latest.zipAsset.browser_download_url -Headers @{ "User-Agent" = "DevSpace-Portable-Updater/$CurrentVersion" } -OutFile $zip -UseBasicParsing -TimeoutSec 3600
        $actualSize = (Get-Item -LiteralPath $zip).Length
        $expectedSize = [int64]$latest.manifest.asset.size
        if ($actualSize -ne $expectedSize) { throw "Downloaded ZIP size mismatch: expected $expectedSize, received $actualSize." }
        $actualHash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
        $expectedHash = ([string]$latest.manifest.asset.sha256).ToLowerInvariant()
        if ($actualHash -ne $expectedHash) { throw "Downloaded ZIP SHA-256 mismatch." }

        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $archive = [System.IO.Compression.ZipFile]::OpenRead($zip)
        try {
            foreach ($entry in $archive.Entries) {
                $name = ([string]$entry.FullName).Replace('\','/')
                if (-not $name.StartsWith("DevSpacePortable/", [StringComparison]::Ordinal)) { throw "Archive entry is outside DevSpacePortable/: $name" }
                if ($name.StartsWith("/", [StringComparison]::Ordinal) -or $name -match '(^|/)\.\.(/|$)' -or $name -match '^[A-Za-z]:') {
                    throw "Unsafe archive entry: $name"
                }
            }
        } finally {
            $archive.Dispose()
        }
        [System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $payload)
        $portableRoot = Join-Path $payload "DevSpacePortable"
        foreach ($required in @("DevSpace-Portable.exe", "runtime\node\node.exe", "setup\portable-manager.cjs", "VERSION-MANIFEST.json")) {
            if (-not (Test-Path (Join-Path $portableRoot $required))) { throw "Staged update is incomplete: $required" }
        }
        Copy-Item -LiteralPath $PSCommandPath -Destination (Join-Path $stage "portable-updater.ps1") -Force
        $stageInfo = [ordered]@{
            formatVersion = 1
            currentVersion = $CurrentVersion
            targetVersion = $latest.version
            repository = $Repository
            stagedAt = (Get-Date).ToUniversalTime().ToString("o")
            zipName = $latest.zipName
            zipSize = $actualSize
            zipSha256 = $actualHash
            payloadRoot = $portableRoot
        }
        $stageInfo | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $stage "stage-info.json") -Encoding UTF8
        Write-UpdateLog "Update $($latest.version) staged successfully at $stage."
        return [pscustomobject]@{
            currentVersion = $CurrentVersion
            latestVersion = $latest.version
            updateAvailable = $true
            staged = $true
            stagingPath = $stage
            assetSize = $actualSize
            assetSha256 = $actualHash
            releaseUrl = [string]$latest.release.html_url
        }
    } catch {
        Write-UpdateLog "Update staging failed: $($_.Exception.Message)"
        Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
        throw
    }
}

function Invoke-Manager([string]$Command, [switch]$IgnoreFailure) {
    $node = Join-Path $Root "runtime\node\node.exe"
    $manager = Join-Path $Root "setup\portable-manager.cjs"
    if (-not (Test-Path $node) -or -not (Test-Path $manager)) {
        if ($IgnoreFailure) { return "" }
        throw "Portable manager runtime is missing."
    }
    $output = & $node $manager $Command 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0 -and -not $IgnoreFailure) { throw "Portable manager $Command failed: $output" }
    return $output.Trim()
}

function Apply-StagedUpdate {
    if ([string]::IsNullOrWhiteSpace($StagingPath)) { throw "StagingPath is required for Apply." }
    $stage = [IO.Path]::GetFullPath($StagingPath).TrimEnd('\')
    $allowedPrefix = [IO.Path]::GetFullPath($UpdateRoot).TrimEnd('\') + '\'
    if (-not $stage.StartsWith($allowedPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw "StagingPath is outside the update staging directory." }
    if (Test-Path (Join-Path $Root ".git")) { throw "Online application update is disabled inside a Git source checkout. Build or run an extracted Release instead." }
    $stageInfoFile = Join-Path $stage "stage-info.json"
    if (-not (Test-Path $stageInfoFile)) { throw "Staged update metadata is missing." }
    $stageInfo = Get-Content -LiteralPath $stageInfoFile -Raw | ConvertFrom-Json
    $targetVersion = [string]$stageInfo.targetVersion
    Assert-Version $targetVersion "Target version"
    $payloadRoot = [IO.Path]::GetFullPath([string]$stageInfo.payloadRoot).TrimEnd('\')
    if (-not $payloadRoot.StartsWith(($stage + '\'), [StringComparison]::OrdinalIgnoreCase)) { throw "Staged payload path is invalid." }
    if (-not (Test-Path (Join-Path $payloadRoot "DevSpace-Portable.exe"))) { throw "Staged Portable executable is missing." }

    # The Portable manager intentionally terminates processes whose executable
    # or command line belongs to this installation. Exclude this detached
    # controller and its child manager process so the transactional update can
    # finish after stopping every other Portable-owned process.
    $env:DEVSPACE_STOP_EXCLUDE_PID = [string]$PID

    if ($UiPid -gt 0) {
        Write-UpdateLog "Waiting for native UI PID $UiPid to exit before applying $targetVersion."
        Wait-Process -Id $UiPid -Timeout 90 -ErrorAction SilentlyContinue
    }

    $backup = Join-Path $Root (".update-backup-{0}-{1}" -f $targetVersion, [guid]::NewGuid().ToString("N"))
    $shouldRestartServices = (Test-Path (Join-Path $Root "data\config\config.json")) -and (Test-Path (Join-Path $Root "data\config\auth.json"))
    New-Item -ItemType Directory -Force -Path $backup | Out-Null
    $movedOld = New-Object System.Collections.Generic.List[string]
    $movedNew = New-Object System.Collections.Generic.List[string]
    try {
        Write-UpdateLog "Stopping Portable services before applying $targetVersion."
        Invoke-Manager "stop" -IgnoreFailure | Out-Null

        $persistent = @("data", "logs", "reports")
        foreach ($item in Get-ChildItem -LiteralPath $payloadRoot -Force) {
            if ($persistent -contains $item.Name) { continue }
            $target = Join-Path $Root $item.Name
            if (Test-Path $target) {
                Move-Item -LiteralPath $target -Destination (Join-Path $backup $item.Name) -Force
                [void]$movedOld.Add($item.Name)
            }
            Move-Item -LiteralPath $item.FullName -Destination $target -Force
            [void]$movedNew.Add($item.Name)
        }

        $newManifest = Get-Content -LiteralPath (Join-Path $Root "VERSION-MANIFEST.json") -Raw | ConvertFrom-Json
        if ([string]$newManifest.runtime.devspacePortable -ne $targetVersion) { throw "Applied version manifest does not report $targetVersion." }
        $startOutput = if ($shouldRestartServices) { Invoke-Manager "start" } else { "Portable is not configured; service restart was skipped." }
        Start-Process -FilePath (Join-Path $Root "DevSpace-Portable.exe") -WorkingDirectory $Root
        $result = [ordered]@{
            success = $true
            version = $targetVersion
            appliedAt = (Get-Date).ToUniversalTime().ToString("o")
            services = $startOutput
            backupRemoved = $true
        }
        Write-UpdateResult $result
        Write-UpdateLog "Update $targetVersion applied successfully."
        Remove-Item -LiteralPath $backup -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
        return $result
    } catch {
        $message = $_.Exception.Message
        Write-UpdateLog "Update apply failed; restoring previous version: $message"
        Invoke-Manager "stop" -IgnoreFailure | Out-Null
        foreach ($name in $movedNew) {
            Remove-Item -LiteralPath (Join-Path $Root $name) -Recurse -Force -ErrorAction SilentlyContinue
        }
        foreach ($name in $movedOld) {
            $source = Join-Path $backup $name
            if (Test-Path $source) { Move-Item -LiteralPath $source -Destination (Join-Path $Root $name) -Force }
        }
        Invoke-Manager "start" -IgnoreFailure | Out-Null
        if (Test-Path (Join-Path $Root "DevSpace-Portable.exe")) {
            Start-Process -FilePath (Join-Path $Root "DevSpace-Portable.exe") -WorkingDirectory $Root
        }
        $result = [ordered]@{
            success = $false
            version = $targetVersion
            failedAt = (Get-Date).ToUniversalTime().ToString("o")
            error = $message
            rolledBack = $true
        }
        Write-UpdateResult $result
        throw
    }
}

try {
    Assert-Version $CurrentVersion "CurrentVersion"
    switch ($Action) {
        "Check" { Write-JsonResult (Get-UpdateStatus) }
        "Stage" { Write-JsonResult (Stage-Update) }
        "Apply" { Write-JsonResult (Apply-StagedUpdate) }
    }
} catch {
    Write-UpdateLog "$Action failed: $($_.Exception.Message)"
    Write-Error $_
    exit 1
}
