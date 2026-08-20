[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^\d+\.\d+\.\d+$')]
    [string]$Version,

    [string]$Repository = "E3N-glotm/DevSpace-Deploy-Portable",

    [switch]$BypassProxy,

    [switch]$AllowRepack
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $Root

function Get-GitHubToken {
    if ($env:GH_TOKEN) { return $env:GH_TOKEN }
    if ($env:GITHUB_TOKEN) { return $env:GITHUB_TOKEN }

    $CredentialFile = Join-Path $env:USERPROFILE ".git-credentials"
    if (-not (Test-Path $CredentialFile)) {
        throw "No GitHub token is available. Run 'gh auth login' or set GH_TOKEN."
    }
    $Credential = Get-Content -LiteralPath $CredentialFile |
        Where-Object { $_ -match '^https?://.*github\.com' } |
        Select-Object -First 1
    if (-not $Credential) {
        throw "No GitHub credential entry was found. Run 'gh auth login' or set GH_TOKEN."
    }
    $Uri = [Uri]$Credential
    $Parts = $Uri.UserInfo.Split(':', 2)
    if ($Parts.Count -ne 2 -or -not $Parts[1]) {
        throw "The GitHub credential entry does not contain a token."
    }
    return [Uri]::UnescapeDataString($Parts[1])
}

function Get-GitHubCli {
    $Command = Get-Command gh.exe -ErrorAction SilentlyContinue
    if ($Command) { return $Command.Source }

    $WingetRoot = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages"
    if (Test-Path $WingetRoot) {
        $Installed = Get-ChildItem -LiteralPath $WingetRoot -Recurse -Filter gh.exe -File -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -match 'GitHub\.cli_' } |
            Select-Object -First 1
        if ($Installed) { return $Installed.FullName }
    }
    throw "GitHub CLI is required. Install it with: winget install --id GitHub.cli --exact --scope user"
}

$Tag = "v$Version"
$ReleaseNotes = Join-Path $Root "docs\releases\HOTFIX-$Version.md"
$Zip = Join-Path $Root "DevSpacePortable-Windows-x64-$Version.zip"
$Blockmap = Join-Path $Root "DevSpacePortable-Windows-x64-$Version.blockmap"
$UpdateManifest = Join-Path $Root "release-assets\update-manifest.json"
$ReleaseChecksums = Join-Path $Root "release-assets\SHA256SUMS-release.txt"
$IncrementalAssets = @(Get-ChildItem -LiteralPath $Root -Filter "DevSpacePortable-Update-*-to-$Version.zip" -File -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName)
$RescueAssets = @(Get-ChildItem -LiteralPath $Root -Filter "DevSpacePortable-Rescue-*-to-$Version.zip" -File -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName)
$Assets = @($Zip, $Blockmap) + $IncrementalAssets + $RescueAssets + @($UpdateManifest, $ReleaseChecksums)

foreach ($Required in @($ReleaseNotes) + $Assets) {
    if (-not (Test-Path $Required)) { throw "Required release file is missing: $Required" }
}

$env:GH_TOKEN = Get-GitHubToken
if ($BypassProxy) {
    Remove-Item Env:HTTP_PROXY, Env:HTTPS_PROXY, Env:ALL_PROXY -ErrorAction SilentlyContinue
}
$Gh = Get-GitHubCli

$ExistingRelease = $null
$ExistingReleaseJson = & $Gh release view $Tag --repo $Repository --json tagName,assets 2>$null
if ($LASTEXITCODE -ne 0) {
    & $Gh release create $Tag `
        --repo $Repository `
        --title "DevSpace Portable $Version" `
        --notes-file $ReleaseNotes `
        --verify-tag
    if ($LASTEXITCODE -ne 0) { throw "GitHub Release creation failed." }
    $ExistingRelease = [pscustomobject]@{ assets = @() }
} else {
    $ExistingRelease = $ExistingReleaseJson | ConvertFrom-Json
}

foreach ($Asset in $Assets) {
    $Item = Get-Item -LiteralPath $Asset
    $LocalDigest = (Get-FileHash -LiteralPath $Item.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    $ExistingAsset = @($ExistingRelease.assets) | Where-Object { $_.name -eq $Item.Name } | Select-Object -First 1
    if ($ExistingAsset) {
        $ExistingDigest = [string]$ExistingAsset.digest
        $MatchesDigest = $ExistingDigest -eq "sha256:$LocalDigest"
        $MatchesSize = [int64]$ExistingAsset.size -eq $Item.Length
        $IsUploaded = [string]$ExistingAsset.state -eq "uploaded"
        if ($MatchesDigest -and $MatchesSize -and $IsUploaded) {
            Write-Host "Already matches GitHub Release: $($Item.Name)"
            continue
        }
        if (-not $AllowRepack) {
            throw (
                "GitHub Release already contains a different asset named '$($Item.Name)'. " +
                "Refusing to clobber an existing same-version asset by default. " +
                "Local SHA-256: $LocalDigest; remote digest: $ExistingDigest; " +
                "local bytes: $($Item.Length); remote bytes: $($ExistingAsset.size). " +
                "Re-run with -AllowRepack only after intentionally validating a same-version repack."
            )
        }
    }

    Write-Host "Uploading $($Item.Name) ($($Item.Length) bytes)..."
    if ($ExistingAsset) {
        & $Gh release upload $Tag $Item.FullName --repo $Repository --clobber
    } else {
        & $Gh release upload $Tag $Item.FullName --repo $Repository
    }
    if ($LASTEXITCODE -ne 0) { throw "GitHub Release upload failed: $($Item.Name)" }
}

$ReleaseJson = & $Gh release view $Tag --repo $Repository --json tagName,name,isDraft,isPrerelease,url,assets
if ($LASTEXITCODE -ne 0) { throw "GitHub Release verification failed." }
$Release = $ReleaseJson | ConvertFrom-Json

$VerifiedAssets = @()
foreach ($Asset in $Assets) {
    $Item = Get-Item -LiteralPath $Asset
    $Remote = @($Release.assets) | Where-Object { $_.name -eq $Item.Name } | Select-Object -First 1
    if (-not $Remote) { throw "Release asset is missing after upload: $($Item.Name)" }
    $LocalDigest = (Get-FileHash -LiteralPath $Item.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    $RemoteDigest = [string]$Remote.digest
    if (
        [int64]$Remote.size -ne $Item.Length -or
        $Remote.state -ne "uploaded" -or
        ($RemoteDigest -and $RemoteDigest -ne "sha256:$LocalDigest")
    ) {
        throw "Release asset verification failed: $($Item.Name)"
    }
    $VerifiedAssets += [pscustomobject]@{
        Name = $Remote.name
        Size = [int64]$Remote.size
        State = $Remote.state
    }
}

[pscustomobject]@{
    Repository = $Repository
    Tag = $Release.tagName
    Name = $Release.name
    Url = $Release.url
    Draft = $Release.isDraft
    Prerelease = $Release.isPrerelease
    Assets = $VerifiedAssets
} | ConvertTo-Json -Depth 6
