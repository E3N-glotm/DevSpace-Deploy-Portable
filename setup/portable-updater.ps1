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

# Windows PowerShell 5.1 can negotiate an older/default Schannel protocol set
# through local HTTP proxies and intermittently fail GitHub requests with
# "The underlying connection was closed: An error occurred on a send." GitHub
# supports TLS 1.2, so pin that capability for this updater process only.
try {
    [Net.ServicePointManager]::SecurityProtocol =
        [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    [Net.ServicePointManager]::Expect100Continue = $false
} catch {
    # Keep startup compatible with future PowerShell/.NET runtimes where these
    # legacy ServicePointManager knobs may no longer be writable.
}

$Root = [IO.Path]::GetFullPath($Root).TrimEnd('\')
$UpdateRoot = Join-Path $Root ".update-staging"
$StateDirectory = Join-Path $Root "data\state"
$LogDirectory = Join-Path $Root "logs"
$ResultFile = Join-Path $StateDirectory "update-result.json"
$ProgressFile = Join-Path $StateDirectory "update-progress.json"
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

function Write-UpdateProgress {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Phase,
        [Parameter(Mandatory = $true)]
        [string]$Message,
        [int64]$BytesReceived = 0,
        [int64]$BytesTotal = 0,
        [double]$SpeedBytesPerSecond = 0,
        [string]$Transport = ""
    )
    New-Item -ItemType Directory -Force -Path $StateDirectory | Out-Null
    $percent = 0.0
    if ($BytesTotal -gt 0) {
        $percent = [Math]::Min(100.0, [Math]::Max(0.0, ($BytesReceived * 100.0 / $BytesTotal)))
    }
    $eta = -1
    if ($SpeedBytesPerSecond -gt 1 -and $BytesTotal -gt $BytesReceived) {
        $eta = [int][Math]::Ceiling(($BytesTotal - $BytesReceived) / $SpeedBytesPerSecond)
    }
    $value = [ordered]@{
        phase = $Phase
        message = $Message
        bytesReceived = $BytesReceived
        bytesTotal = $BytesTotal
        percent = [Math]::Round($percent, 1)
        speedBytesPerSecond = [Math]::Round($SpeedBytesPerSecond, 0)
        etaSeconds = $eta
        transport = $Transport
        updatedAt = (Get-Date).ToUniversalTime().ToString("o")
    }
    $temporary = "$ProgressFile.tmp-$PID"
    $value | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $temporary -Encoding UTF8
    Move-Item -LiteralPath $temporary -Destination $ProgressFile -Force
}

function Invoke-WithRetry {
    param(
        [Parameter(Mandatory = $true)]
        [scriptblock]$Operation,
        [Parameter(Mandatory = $true)]
        [string]$Description,
        [int]$Attempts = 3
    )
    $lastError = $null
    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        try {
            return & $Operation
        } catch {
            $lastError = $_
            if ($attempt -ge $Attempts) { break }
            $delayMs = 500 * [Math]::Pow(2, $attempt - 1)
            Write-UpdateLog "$Description failed on attempt $attempt/${Attempts}: $($_.Exception.Message). Retrying."
            Start-Sleep -Milliseconds ([int]$delayMs)
        }
    }
    if ($lastError) { throw $lastError }
    throw "$Description failed without an exception."
}

function Get-CurlExecutable {
    $bundledCandidates = @(
        (Join-Path $Root "runtime\git\mingw64\bin\curl.exe"),
        (Join-Path $Root "runtime\git\usr\bin\curl.exe")
    )
    foreach ($candidate in $bundledCandidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
    $command = Get-Command curl.exe -ErrorAction SilentlyContinue
    if (-not $command) { return $null }
    return [string]$command.Source
}

function Invoke-CurlJson {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Uri,
        [hashtable]$Headers = @{},
        [int]$TimeoutSec = 30,
        [switch]$Direct
    )
    $curl = Get-CurlExecutable
    if (-not $curl) { throw "curl.exe is not available for the GitHub fallback transport." }
    $arguments = @(
        "--silent",
        "--show-error",
        "--fail",
        "--location",
        "--connect-timeout", "8",
        "--max-time", [string]$TimeoutSec
    )
    if ($Direct) { $arguments += @("--noproxy", "*") }
    foreach ($key in $Headers.Keys) {
        $arguments += @("--header", "${key}: $($Headers[$key])")
    }
    $arguments += $Uri
    $output = & $curl @arguments
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) { throw "curl.exe GitHub request failed with exit code $exitCode." }
    $json = ($output -join "`n")
    if ([string]::IsNullOrWhiteSpace($json)) { throw "curl.exe GitHub request returned an empty response." }
    try {
        return $json | ConvertFrom-Json
    } catch {
        throw "curl.exe GitHub response was not valid JSON: $($_.Exception.Message)"
    }
}

function Invoke-GitHubJson {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Uri,
        [hashtable]$Headers = @{},
        [int]$TimeoutSec = 30,
        [string]$Description = "GitHub request"
    )
    Write-UpdateProgress -Phase "metadata" -Message $Description -Transport "curl"
    $proxyAwareError = ""
    try {
        return Invoke-CurlJson -Uri $Uri -Headers $Headers -TimeoutSec ([Math]::Min($TimeoutSec, 20))
    } catch {
        $proxyAwareError = $_.Exception.Message
        Write-UpdateLog "$Description failed through proxy-aware curl: $proxyAwareError. Trying direct curl without proxy."
    }
    try {
        Write-UpdateProgress -Phase "metadata" -Message "$Description - direct retry" -Transport "curl-direct"
        return Invoke-CurlJson -Uri $Uri -Headers $Headers -TimeoutSec ([Math]::Min($TimeoutSec, 25)) -Direct
    } catch {
        $directError = $_.Exception.Message
        Write-UpdateLog "$Description failed through direct curl: $directError."
        # The Portable package always ships curl, but keep one short PowerShell
        # compatibility fallback in case the bundled runtime is damaged. This
        # is intentionally a single bounded attempt rather than the previous
        # 3 x long-timeout chain that could make the UI appear frozen.
        try {
            Write-UpdateProgress -Phase "metadata" -Message "$Description - PowerShell compatibility fallback" -Transport "powershell"
            return Invoke-RestMethod -Uri $Uri -Headers $Headers -Method Get -TimeoutSec ([Math]::Min($TimeoutSec, 20))
        } catch {
            throw "$Description failed through proxy-aware curl, direct curl, and the bounded PowerShell fallback. curl: $proxyAwareError; direct: $directError; PowerShell: $($_.Exception.Message)"
        }
    }
}

function Invoke-CurlDownload {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Uri,
        [Parameter(Mandatory = $true)]
        [string]$OutFile,
        [hashtable]$Headers = @{},
        [int]$TimeoutSec = 1800,
        [int64]$ExpectedBytes = 0,
        [string]$Description = "GitHub download",
        [switch]$Direct
    )
    $curl = Get-CurlExecutable
    if (-not $curl) { throw "curl.exe is not available for the GitHub fallback transport." }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutFile) | Out-Null
    $arguments = @(
        "--silent",
        "--show-error",
        "--fail",
        "--location",
        "--retry", "2",
        "--retry-delay", "1",
        "--retry-all-errors",
        "--connect-timeout", "8",
        "--speed-limit", "2048",
        "--speed-time", "20",
        "--max-time", [string]$TimeoutSec,
        "--output", $OutFile
    )
    if ($Direct) { $arguments += @("--noproxy", "*") }
    if ((Test-Path -LiteralPath $OutFile -PathType Leaf) -and (Get-Item -LiteralPath $OutFile).Length -gt 0) {
        $arguments += @("--continue-at", "-")
    }
    foreach ($key in $Headers.Keys) {
        $arguments += @("--header", "${key}: $($Headers[$key])")
    }
    $arguments += $Uri
    $quoted = $arguments | ForEach-Object {
        ([char]34) + ([string]$_) + ([char]34)
    }
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = $curl
    $info.Arguments = ($quoted -join ' ')
    $info.WorkingDirectory = $Root
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardError = $true
    $info.RedirectStandardOutput = $true
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $info
    if (-not $process.Start()) { throw "Unable to start curl.exe for $Description." }
    $transport = if ($Direct) { "curl-direct" } else { "curl" }
    $lastAt = Get-Date
    $lastBytes = if (Test-Path -LiteralPath $OutFile) { (Get-Item -LiteralPath $OutFile).Length } else { 0 }
    Write-UpdateProgress -Phase "downloading" -Message $Description -BytesReceived $lastBytes -BytesTotal $ExpectedBytes -Transport $transport
    while (-not $process.WaitForExit(500)) {
        $now = Get-Date
        $bytes = if (Test-Path -LiteralPath $OutFile) { (Get-Item -LiteralPath $OutFile).Length } else { 0 }
        $seconds = [Math]::Max(0.001, ($now - $lastAt).TotalSeconds)
        $speed = [Math]::Max(0, ($bytes - $lastBytes) / $seconds)
        Write-UpdateProgress -Phase "downloading" -Message $Description -BytesReceived $bytes -BytesTotal $ExpectedBytes -SpeedBytesPerSecond $speed -Transport $transport
        $lastAt = $now
        $lastBytes = $bytes
    }
    $process.WaitForExit()
    $exitCode = $process.ExitCode
    $stderr = $process.StandardError.ReadToEnd().Trim()
    $process.Dispose()
    if ($exitCode -ne 0) {
        throw "curl.exe GitHub download failed with exit code $exitCode$(if ($stderr) { ': ' + $stderr } else { '' })."
    }
    if (-not (Test-Path -LiteralPath $OutFile -PathType Leaf)) {
        throw "curl.exe GitHub download completed without creating the output file."
    }
    $finalBytes = (Get-Item -LiteralPath $OutFile).Length
    Write-UpdateProgress -Phase "downloaded" -Message "$Description completed" -BytesReceived $finalBytes -BytesTotal $ExpectedBytes -Transport $transport
}

function Invoke-GitHubDownload {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Uri,
        [Parameter(Mandatory = $true)]
        [string]$OutFile,
        [hashtable]$Headers = @{},
        [int]$TimeoutSec = 1800,
        [string]$Description = "GitHub download",
        [int64]$ExpectedBytes = 0
    )
    $proxyAwareError = ""
    try {
        Invoke-CurlDownload -Uri $Uri -OutFile $OutFile -Headers $Headers -TimeoutSec $TimeoutSec -ExpectedBytes $ExpectedBytes -Description $Description
        return
    } catch {
        $proxyAwareError = $_.Exception.Message
        Write-UpdateLog "$Description failed through proxy-aware curl: $proxyAwareError. Retrying the same partial file through direct curl."
    }
    try {
        Invoke-CurlDownload -Uri $Uri -OutFile $OutFile -Headers $Headers -TimeoutSec $TimeoutSec -ExpectedBytes $ExpectedBytes -Description "$Description - direct" -Direct
        return
    } catch {
        $directError = $_.Exception.Message
        Write-UpdateLog "$Description direct curl retry failed: $directError."
    }
    # Range resume can fail if a CDN edge rejects the existing partial file.
    # Retry direct once from zero before giving up; still never alter Windows,
    # EasyConnect, v2rayN, WinINET, or WinHTTP proxy settings.
    if (Test-Path -LiteralPath $OutFile) { Remove-Item -LiteralPath $OutFile -Force -ErrorAction SilentlyContinue }
    try {
        Invoke-CurlDownload -Uri $Uri -OutFile $OutFile -Headers $Headers -TimeoutSec $TimeoutSec -ExpectedBytes $ExpectedBytes -Description "$Description - clean direct retry" -Direct
        return
    } catch {
        throw "$Description failed after proxy-aware curl, direct resume, and direct clean retry. Proxy-aware: $proxyAwareError; direct: $directError; clean direct: $($_.Exception.Message)"
    }
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
    $release = Invoke-GitHubJson -Uri "https://api.github.com/repos/$Repository/releases/latest" -Headers $headers -TimeoutSec 60 -Description "GitHub latest-release metadata request"
    $version = ([string]$release.tag_name).TrimStart('v')
    Assert-Version $version "Release version"
    $manifestAsset = @($release.assets) | Where-Object { $_.name -eq "update-manifest.json" } | Select-Object -First 1
    $zipName = "DevSpacePortable-Windows-x64-$version.zip"
    $zipAsset = @($release.assets) | Where-Object { $_.name -eq $zipName } | Select-Object -First 1
    if (-not $manifestAsset) { throw "Latest Release has no update-manifest.json asset." }
    if (-not $zipAsset) { throw "Latest Release has no $zipName asset." }
    $manifest = Invoke-GitHubJson -Uri $manifestAsset.browser_download_url -Headers @{ "User-Agent" = "DevSpace-Portable-Updater/$CurrentVersion" } -TimeoutSec 60 -Description "GitHub update-manifest request"
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

function ConvertTo-SafeRelativePath([string]$Value) {
    $normalized = ([string]$Value).Replace('\','/')
    if ([string]::IsNullOrWhiteSpace($normalized)) { throw "Update path is empty." }
    if ($normalized.StartsWith('/') -or $normalized -match '(^|/)\.\.(/|$)' -or $normalized -match '^[A-Za-z]:') {
        throw "Unsafe update path: $Value"
    }
    $first = ($normalized -split '/')[0]
    if (@("data", "logs", "reports") -contains $first) {
        throw "Incremental updates may not modify persistent path: $normalized"
    }
    return $normalized
}

function Get-IncrementalCandidate([object]$Latest) {
    $entries = @($Latest.manifest.incrementalAssets)
    $candidate = $entries | Where-Object {
        ([string]$_.format -eq "file-delta-v1") -and
        ([string]$_.fromVersion -eq $CurrentVersion) -and
        ([string]$_.toVersion -eq $Latest.version)
    } | Select-Object -First 1
    if (-not $candidate) { return $null }
    $asset = @($Latest.release.assets) | Where-Object { $_.name -eq [string]$candidate.name } | Select-Object -First 1
    if (-not $asset) { throw "Release manifest references a missing incremental asset: $($candidate.name)" }
    if ([int64]$asset.size -ne [int64]$candidate.size) { throw "Incremental asset size does not match the release manifest." }
    return [pscustomobject]@{ manifest = $candidate; asset = $asset }
}

function Get-UpdateStatus {
    $latest = Get-LatestRelease
    $comparison = Compare-Version $latest.version $CurrentVersion
    $incremental = $null
    $incrementalFallbackReason = ""
    if ($comparison -gt 0) {
        try { $incremental = Get-IncrementalCandidate $latest }
        catch { $incrementalFallbackReason = $_.Exception.Message }
    }
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
        updateStrategy = [string]$latest.manifest.updateStrategy
        preferredMode = if ($incremental) { "incremental" } else { "full" }
        incrementalAssetName = if ($incremental) { [string]$incremental.manifest.name } else { "" }
        incrementalAssetSize = if ($incremental) { [int64]$incremental.manifest.size } else { 0 }
        incrementalAssetSha256 = if ($incremental) { ([string]$incremental.manifest.sha256).ToLowerInvariant() } else { "" }
        incrementalFallbackReason = $incrementalFallbackReason
        fullAssetSize = [int64]$latest.manifest.asset.size
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

function Stage-FullUpdate([object]$Latest, [string]$FallbackReason = "") {
    New-Item -ItemType Directory -Force -Path $UpdateRoot | Out-Null
    $stage = Join-Path $UpdateRoot ("{0}-full-{1}" -f $Latest.version, [guid]::NewGuid().ToString("N"))
    $payload = Join-Path $stage "payload"
    $zip = Join-Path $stage $Latest.zipName
    New-Item -ItemType Directory -Force -Path $stage,$payload | Out-Null
    try {
        if ($FallbackReason) {
            Write-UpdateLog "Using full update fallback: $FallbackReason"
            Write-UpdateProgress -Phase "fallback" -Message "Incremental update unavailable; switching to the full package: $FallbackReason" -BytesTotal ([int64]$Latest.manifest.asset.size)
        }
        Write-UpdateLog "Downloading full package $($Latest.zipName) from GitHub Release $($Latest.version)."
        Invoke-GitHubDownload -Uri $Latest.zipAsset.browser_download_url -Headers @{ "User-Agent" = "DevSpace-Portable-Updater/$CurrentVersion" } -OutFile $zip -TimeoutSec 3600 -Description "Full update package $($Latest.zipName)" -ExpectedBytes ([int64]$Latest.manifest.asset.size)
        $actualSize = (Get-Item -LiteralPath $zip).Length
        $expectedSize = [int64]$Latest.manifest.asset.size
        if ($actualSize -ne $expectedSize) { throw "Downloaded ZIP size mismatch: expected $expectedSize, received $actualSize." }
        Write-UpdateProgress -Phase "verifying" -Message "Verifying full update package SHA-256" -BytesReceived $actualSize -BytesTotal $expectedSize
        $actualHash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
        $expectedHash = ([string]$Latest.manifest.asset.sha256).ToLowerInvariant()
        if ($actualHash -ne $expectedHash) { throw "Downloaded ZIP SHA-256 mismatch." }

        Write-UpdateProgress -Phase "extracting" -Message "Safely extracting full update package" -BytesReceived $actualSize -BytesTotal $expectedSize
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
            targetVersion = $Latest.version
            repository = $Repository
            updateMode = "full"
            fallbackReason = $FallbackReason
            stagedAt = (Get-Date).ToUniversalTime().ToString("o")
            zipName = $Latest.zipName
            zipSize = $actualSize
            zipSha256 = $actualHash
            payloadRoot = $portableRoot
        }
        $stageInfo | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $stage "stage-info.json") -Encoding UTF8
        Write-UpdateLog "Update $($latest.version) staged successfully at $stage."
        Write-UpdateProgress -Phase "staged" -Message "Full update package downloaded, verified, and staged" -BytesReceived $actualSize -BytesTotal $expectedSize
        return [pscustomobject]@{
            currentVersion = $CurrentVersion
            latestVersion = $Latest.version
            updateAvailable = $true
            staged = $true
            updateMode = "full"
            fallbackReason = $FallbackReason
            stagingPath = $stage
            assetSize = $actualSize
            assetSha256 = $actualHash
            releaseUrl = [string]$Latest.release.html_url
        }
    } catch {
        Write-UpdateLog "Update staging failed: $($_.Exception.Message)"
        Write-UpdateProgress -Phase "error" -Message "Full update staging failed: $($_.Exception.Message)"
        Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
        throw
    }
}

function Stage-IncrementalUpdate([object]$Latest, [object]$Incremental) {
    New-Item -ItemType Directory -Force -Path $UpdateRoot | Out-Null
    $stage = Join-Path $UpdateRoot ("{0}-delta-{1}" -f $Latest.version, [guid]::NewGuid().ToString("N"))
    $payload = Join-Path $stage "payload"
    $zip = Join-Path $stage ([string]$Incremental.manifest.name)
    New-Item -ItemType Directory -Force -Path $stage,$payload | Out-Null
    try {
        Write-UpdateLog "Downloading incremental package $($Incremental.manifest.name) for $CurrentVersion -> $($Latest.version)."
        Invoke-GitHubDownload -Uri $Incremental.asset.browser_download_url -Headers @{ "User-Agent" = "DevSpace-Portable-Updater/$CurrentVersion" } -OutFile $zip -TimeoutSec 1800 -Description "Incremental update package $($Incremental.manifest.name)" -ExpectedBytes ([int64]$Incremental.manifest.size)
        $actualSize = (Get-Item -LiteralPath $zip).Length
        $expectedSize = [int64]$Incremental.manifest.size
        if ($actualSize -ne $expectedSize) { throw "Downloaded incremental ZIP size mismatch: expected $expectedSize, received $actualSize." }
        Write-UpdateProgress -Phase "verifying" -Message "Verifying incremental update package SHA-256" -BytesReceived $actualSize -BytesTotal $expectedSize
        $actualHash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
        $expectedHash = ([string]$Incremental.manifest.sha256).ToLowerInvariant()
        if ($actualHash -ne $expectedHash) { throw "Downloaded incremental ZIP SHA-256 mismatch." }

        Write-UpdateProgress -Phase "extracting" -Message "Safely extracting and validating incremental files" -BytesReceived $actualSize -BytesTotal $expectedSize
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $archive = [System.IO.Compression.ZipFile]::OpenRead($zip)
        try {
            foreach ($entry in $archive.Entries) {
                $name = ([string]$entry.FullName).Replace('\','/')
                if (-not $name.StartsWith("DevSpacePortableDelta/", [StringComparison]::Ordinal)) { throw "Incremental archive entry is outside DevSpacePortableDelta/: $name" }
                if ($name.StartsWith("/", [StringComparison]::Ordinal) -or $name -match '(^|/)\.\.(/|$)' -or $name -match '^[A-Za-z]:') {
                    throw "Unsafe incremental archive entry: $name"
                }
            }
        } finally {
            $archive.Dispose()
        }
        [System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $payload)
        $deltaRoot = Join-Path $payload "DevSpacePortableDelta"
        $deltaManifestFile = Join-Path $deltaRoot "delta-manifest.json"
        if (-not (Test-Path $deltaManifestFile)) { throw "Incremental package has no delta-manifest.json." }
        $delta = Get-Content -LiteralPath $deltaManifestFile -Raw | ConvertFrom-Json
        if ([string]$delta.format -ne "file-delta-v1") { throw "Unsupported incremental update format." }
        if ([string]$delta.fromVersion -ne $CurrentVersion -or [string]$delta.toVersion -ne $Latest.version) {
            throw "Incremental package version range does not match the current update."
        }
        $filesRoot = Join-Path $deltaRoot "files"
        $changedPaths = New-Object System.Collections.Generic.List[string]
        foreach ($entry in @($delta.changedFiles)) {
            $relative = ConvertTo-SafeRelativePath ([string]$entry.path)
            $source = Join-Path $filesRoot ($relative.Replace('/','\'))
            if (-not (Test-Path $source -PathType Leaf)) { throw "Incremental package is missing changed file: $relative" }
            if ((Get-Item -LiteralPath $source).Length -ne [int64]$entry.size) { throw "Incremental file size mismatch: $relative" }
            $sourceHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($sourceHash -ne ([string]$entry.sha256).ToLowerInvariant()) { throw "Incremental file SHA-256 mismatch: $relative" }
            $currentTarget = Join-Path $Root ($relative.Replace('/','\'))
            $baseHash = ([string]$entry.baseSha256).ToLowerInvariant()
            if ($baseHash) {
                if (-not (Test-Path $currentTarget -PathType Leaf)) { throw "Incremental base file is missing: $relative" }
                $installedHash = (Get-FileHash -LiteralPath $currentTarget -Algorithm SHA256).Hash.ToLowerInvariant()
                if ($installedHash -ne $baseHash) { throw "Incremental base file has local drift: $relative" }
            } elseif (Test-Path $currentTarget) {
                throw "Incremental package expected a new path but it already exists: $relative"
            }
            [void]$changedPaths.Add($relative)
        }
        $deletedPaths = New-Object System.Collections.Generic.List[string]
        foreach ($entry in @($delta.deletedFiles)) {
            $relative = ConvertTo-SafeRelativePath ([string]$entry.path)
            $currentTarget = Join-Path $Root ($relative.Replace('/','\'))
            if (Test-Path $currentTarget -PathType Leaf) {
                $installedHash = (Get-FileHash -LiteralPath $currentTarget -Algorithm SHA256).Hash.ToLowerInvariant()
                if ($installedHash -ne ([string]$entry.baseSha256).ToLowerInvariant()) { throw "Incremental deleted file has local drift: $relative" }
            }
            [void]$deletedPaths.Add($relative)
        }
        Copy-Item -LiteralPath $PSCommandPath -Destination (Join-Path $stage "portable-updater.ps1") -Force
        $stageInfo = [ordered]@{
            formatVersion = 1
            currentVersion = $CurrentVersion
            targetVersion = $Latest.version
            repository = $Repository
            updateMode = "incremental"
            stagedAt = (Get-Date).ToUniversalTime().ToString("o")
            zipName = [string]$Incremental.manifest.name
            zipSize = $actualSize
            zipSha256 = $actualHash
            payloadRoot = $filesRoot
            deltaManifestPath = $deltaManifestFile
            changedFiles = @($changedPaths)
            deletedFiles = @($deletedPaths)
        }
        $stageInfo | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $stage "stage-info.json") -Encoding UTF8
        Write-UpdateLog "Incremental update $CurrentVersion -> $($Latest.version) staged successfully at $stage."
        Write-UpdateProgress -Phase "staged" -Message "Incremental update package downloaded, verified, and staged" -BytesReceived $actualSize -BytesTotal $expectedSize
        return [pscustomobject]@{
            currentVersion = $CurrentVersion
            latestVersion = $Latest.version
            updateAvailable = $true
            staged = $true
            updateMode = "incremental"
            stagingPath = $stage
            assetSize = $actualSize
            assetSha256 = $actualHash
            fullFallbackSize = [int64]$Latest.manifest.asset.size
            releaseUrl = [string]$Latest.release.html_url
        }
    } catch {
        Write-UpdateLog "Incremental staging failed: $($_.Exception.Message)"
        Write-UpdateProgress -Phase "fallback" -Message "Incremental staging failed; preparing full-package fallback: $($_.Exception.Message)"
        Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
        throw
    }
}

function Stage-Update {
    Write-UpdateProgress -Phase "metadata" -Message "Reading GitHub Release metadata and update manifest"
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
    $incremental = $null
    try { $incremental = Get-IncrementalCandidate $latest }
    catch {
        $reason = $_.Exception.Message
        Write-UpdateLog "Incremental release metadata cannot be used; automatically falling back to the full package: $reason"
        return Stage-FullUpdate $latest $reason
    }
    if ($incremental) {
        try {
            return Stage-IncrementalUpdate $latest $incremental
        } catch {
            $reason = $_.Exception.Message
            Write-UpdateLog "Incremental update cannot be used; automatically falling back to the full package: $reason"
            return Stage-FullUpdate $latest $reason
        }
    }
    return Stage-FullUpdate $latest "No incremental package matches installed version $CurrentVersion."
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
    $updateMode = if ([string]$stageInfo.updateMode) { [string]$stageInfo.updateMode } else { "full" }
    if (@("full", "incremental") -notcontains $updateMode) { throw "Unsupported staged update mode: $updateMode" }
    $payloadRoot = [IO.Path]::GetFullPath([string]$stageInfo.payloadRoot).TrimEnd('\')
    if (-not $payloadRoot.StartsWith(($stage + '\'), [StringComparison]::OrdinalIgnoreCase)) { throw "Staged payload path is invalid." }
    $deltaManifest = $null
    if ($updateMode -eq "full") {
        if (-not (Test-Path (Join-Path $payloadRoot "DevSpace-Portable.exe"))) { throw "Staged Portable executable is missing." }
    } else {
        $deltaManifestPath = [IO.Path]::GetFullPath([string]$stageInfo.deltaManifestPath)
        if (-not $deltaManifestPath.StartsWith(($stage + '\'), [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path $deltaManifestPath)) {
            throw "Staged incremental manifest path is invalid."
        }
        $deltaManifest = Get-Content -LiteralPath $deltaManifestPath -Raw | ConvertFrom-Json
        if ([string]$deltaManifest.fromVersion -ne $CurrentVersion -or [string]$deltaManifest.toVersion -ne $targetVersion) {
            throw "Staged incremental manifest version range is invalid."
        }
    }

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
        Write-UpdateProgress -Phase "applying" -Message "Stopping Portable-owned processes and applying $targetVersion"
        Write-UpdateLog "Stopping Portable services before applying $targetVersion."
        Invoke-Manager "stop" -IgnoreFailure | Out-Null

        if ($updateMode -eq "incremental") {
            foreach ($entry in @($deltaManifest.changedFiles)) {
                $relative = ConvertTo-SafeRelativePath ([string]$entry.path)
                $relativeWindows = $relative.Replace('/','\')
                $source = Join-Path $payloadRoot $relativeWindows
                $target = Join-Path $Root $relativeWindows
                $backupTarget = Join-Path $backup $relativeWindows
                if (-not (Test-Path $source -PathType Leaf)) { throw "Staged changed file disappeared before apply: $relative" }
                if (Test-Path $target) {
                    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $backupTarget) | Out-Null
                    Move-Item -LiteralPath $target -Destination $backupTarget -Force
                    [void]$movedOld.Add($relative)
                }
                New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
                Move-Item -LiteralPath $source -Destination $target -Force
                [void]$movedNew.Add($relative)
            }
            foreach ($entry in @($deltaManifest.deletedFiles)) {
                $relative = ConvertTo-SafeRelativePath ([string]$entry.path)
                $relativeWindows = $relative.Replace('/','\')
                $target = Join-Path $Root $relativeWindows
                if (-not (Test-Path $target)) { continue }
                $backupTarget = Join-Path $backup $relativeWindows
                New-Item -ItemType Directory -Force -Path (Split-Path -Parent $backupTarget) | Out-Null
                Move-Item -LiteralPath $target -Destination $backupTarget -Force
                [void]$movedOld.Add($relative)
            }
            foreach ($entry in @($deltaManifest.changedFiles)) {
                $relative = ConvertTo-SafeRelativePath ([string]$entry.path)
                $target = Join-Path $Root ($relative.Replace('/','\'))
                if (-not (Test-Path $target -PathType Leaf)) { throw "Incremental target file is missing after apply: $relative" }
                $targetHash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
                if ($targetHash -ne ([string]$entry.sha256).ToLowerInvariant()) { throw "Incremental target file failed SHA-256 validation: $relative" }
            }
        } else {
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
        }

        $newManifest = Get-Content -LiteralPath (Join-Path $Root "VERSION-MANIFEST.json") -Raw | ConvertFrom-Json
        if ([string]$newManifest.runtime.devspacePortable -ne $targetVersion) { throw "Applied version manifest does not report $targetVersion." }
        $startOutput = if ($shouldRestartServices) { Invoke-Manager "start" } else { "Portable is not configured; service restart was skipped." }
        Start-Process -FilePath (Join-Path $Root "DevSpace-Portable.exe") -WorkingDirectory $Root
        $result = [ordered]@{
            success = $true
            version = $targetVersion
            updateMode = $updateMode
            appliedAt = (Get-Date).ToUniversalTime().ToString("o")
            services = $startOutput
            backupRemoved = $true
        }
        Write-UpdateResult $result
        Write-UpdateLog "Update $targetVersion applied successfully."
        Write-UpdateProgress -Phase "completed" -Message "DevSpace Portable $targetVersion update completed"
        Remove-Item -LiteralPath $backup -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
        return $result
    } catch {
        $message = $_.Exception.Message
        Write-UpdateLog "Update apply failed; restoring previous version: $message"
        Write-UpdateProgress -Phase "rollback" -Message "Update failed; restoring the previous version: $message"
        Invoke-Manager "stop" -IgnoreFailure | Out-Null
        foreach ($name in $movedNew) {
            Remove-Item -LiteralPath (Join-Path $Root $name) -Recurse -Force -ErrorAction SilentlyContinue
        }
        foreach ($name in $movedOld) {
            $source = Join-Path $backup $name
            if (Test-Path $source) {
                $destination = Join-Path $Root $name
                New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
                Move-Item -LiteralPath $source -Destination $destination -Force
            }
        }
        Invoke-Manager "start" -IgnoreFailure | Out-Null
        if (Test-Path (Join-Path $Root "DevSpace-Portable.exe")) {
            Start-Process -FilePath (Join-Path $Root "DevSpace-Portable.exe") -WorkingDirectory $Root
        }
        $result = [ordered]@{
            success = $false
            version = $targetVersion
            updateMode = $updateMode
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
    Write-UpdateProgress -Phase "error" -Message "$Action failed: $($_.Exception.Message)"
    Write-Error $_
    exit 1
}
