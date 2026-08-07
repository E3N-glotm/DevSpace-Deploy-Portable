[CmdletBinding()]
param(
    [string]$Version = "",
    [string]$Repository = "E3N-glotm/DevSpace-Deploy-Portable",
    [switch]$Force,
    [string]$ArchiveOutput = "",
    [string]$MetadataOutput = ""
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Runtime = Join-Path $Root "runtime"
if ((Test-Path $Runtime) -and -not $Force) {
    throw "runtime already exists. Use -Force to replace it from a Release."
}

$Headers = @{
    Accept = "application/vnd.github+json"
    "X-GitHub-Api-Version" = "2022-11-28"
    "User-Agent" = "DevSpace-Deploy-Portable-Updater"
}
$Token = if ($env:GH_TOKEN) { $env:GH_TOKEN } elseif ($env:GITHUB_TOKEN) { $env:GITHUB_TOKEN } else { "" }
if ($Token) { $Headers.Authorization = "Bearer $Token" }
$ReleaseUri = if ($Version) {
    "https://api.github.com/repos/$Repository/releases/tags/v$Version"
} else {
    "https://api.github.com/repos/$Repository/releases/latest"
}
$Release = Invoke-RestMethod -Uri $ReleaseUri -Headers $Headers -Method Get
$ResolvedVersion = ([string]$Release.tag_name).TrimStart('v')
$ZipName = "DevSpacePortable-Windows-x64-$ResolvedVersion.zip"
$ZipAsset = $Release.assets | Where-Object { $_.name -eq $ZipName } | Select-Object -First 1
if (-not $ZipAsset) { throw "Release $($Release.tag_name) has no asset named $ZipName." }

$Temporary = Join-Path ([IO.Path]::GetTempPath()) ("devspace-runtime-" + [guid]::NewGuid().ToString("N"))
$ZipPath = Join-Path $Temporary $ZipName
$Extracted = Join-Path $Temporary "extracted"
New-Item -ItemType Directory -Force -Path $Temporary,$Extracted | Out-Null

try {
    $DownloadHeaders = @{
        Accept = "application/octet-stream"
        "X-GitHub-Api-Version" = "2022-11-28"
        "User-Agent" = "DevSpace-Deploy-Portable-Updater"
    }
    if ($Token) { $DownloadHeaders.Authorization = "Bearer $Token" }
    Invoke-WebRequest -Uri $ZipAsset.url -Headers $DownloadHeaders -OutFile $ZipPath -UseBasicParsing

    $ChecksumAsset = $Release.assets | Where-Object { $_.name -eq "SHA256SUMS-release.txt" } | Select-Object -First 1
    if ($ChecksumAsset) {
        $ChecksumPath = Join-Path $Temporary "SHA256SUMS-release.txt"
        Invoke-WebRequest -Uri $ChecksumAsset.url -Headers $DownloadHeaders -OutFile $ChecksumPath -UseBasicParsing
        $Line = Get-Content -LiteralPath $ChecksumPath | Where-Object { $_ -match [regex]::Escape($ZipName) } | Select-Object -First 1
        if (-not $Line) { throw "Release checksum file does not contain $ZipName." }
        $Expected = ($Line -split '\s+')[0].ToLowerInvariant()
        $Actual = (Get-FileHash -LiteralPath $ZipPath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($Actual -ne $Expected) { throw "Release ZIP SHA-256 mismatch." }
    } else {
        Write-Warning "Release has no SHA256SUMS-release.txt; relying on the authenticated GitHub asset response."
    }

    if ($ArchiveOutput) {
        $ResolvedArchiveOutput = [IO.Path]::GetFullPath($ArchiveOutput)
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ResolvedArchiveOutput) | Out-Null
        Copy-Item -LiteralPath $ZipPath -Destination $ResolvedArchiveOutput -Force
    }
    if ($MetadataOutput) {
        $ResolvedMetadataOutput = [IO.Path]::GetFullPath($MetadataOutput)
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ResolvedMetadataOutput) | Out-Null
        [ordered]@{
            version = $ResolvedVersion
            tag = [string]$Release.tag_name
            releaseUrl = [string]$Release.html_url
            zipName = $ZipName
            zipSize = (Get-Item -LiteralPath $ZipPath).Length
            zipSha256 = (Get-FileHash -LiteralPath $ZipPath -Algorithm SHA256).Hash.ToLowerInvariant()
            archiveOutput = if ($ArchiveOutput) { [IO.Path]::GetFullPath($ArchiveOutput) } else { "" }
        } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $ResolvedMetadataOutput -Encoding UTF8
    }

    Expand-Archive -LiteralPath $ZipPath -DestinationPath $Extracted -Force
    $SourceRuntime = Join-Path $Extracted "DevSpacePortable\runtime"
    if (-not (Test-Path (Join-Path $SourceRuntime "node\node.exe"))) {
        throw "The Release ZIP does not contain the expected Portable runtime."
    }
    if (Test-Path $Runtime) { Remove-Item -LiteralPath $Runtime -Recurse -Force }
    Copy-Item -LiteralPath $SourceRuntime -Destination $Runtime -Recurse -Force
    Write-Host "Restored runtime from release $($Release.tag_name): $Runtime"
} finally {
    Remove-Item -LiteralPath $Temporary -Recurse -Force -ErrorAction SilentlyContinue
}

