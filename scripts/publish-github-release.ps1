[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^\d+\.\d+\.\d+$')]
    [string]$Version,

    [string]$Repository = "E3N-glotm/DevSpace-Deploy-Portable",

    [switch]$ReplaceExistingAssets
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $Root

function Get-GitHubToken {
    if ($env:GH_TOKEN) { return $env:GH_TOKEN }
    if ($env:GITHUB_TOKEN) { return $env:GITHUB_TOKEN }

    $CredentialFile = Join-Path $env:USERPROFILE ".git-credentials"
    if (-not (Test-Path $CredentialFile)) {
        throw "No GitHub token is available. Set GH_TOKEN or GITHUB_TOKEN."
    }
    $Credential = Get-Content -LiteralPath $CredentialFile |
        Where-Object { $_ -match '^https?://.*github\.com' } |
        Select-Object -First 1
    if (-not $Credential) {
        throw "No GitHub credential entry was found. Set GH_TOKEN or GITHUB_TOKEN."
    }
    $Uri = [Uri]$Credential
    $Parts = $Uri.UserInfo.Split(':', 2)
    if ($Parts.Count -ne 2 -or -not $Parts[1]) {
        throw "The GitHub credential entry does not contain a token."
    }
    return [Uri]::UnescapeDataString($Parts[1])
}

function Get-CurlPath {
    $Candidates = @(
        (Join-Path $Root "runtime\git\mingw64\bin\curl.exe"),
        "C:\Windows\System32\curl.exe"
    )
    foreach ($Candidate in $Candidates) {
        if (Test-Path $Candidate) { return $Candidate }
    }
    $Command = Get-Command curl.exe -ErrorAction SilentlyContinue
    if ($Command) { return $Command.Source }
    throw "curl.exe was not found."
}

function ConvertTo-CurlQuotedValue([string]$Value) {
    return $Value.Replace('\', '/').Replace('"', '\"')
}

function Invoke-GitHubRequest {
    param(
        [Parameter(Mandatory = $true)][string]$Method,
        [Parameter(Mandatory = $true)][string]$Url,
        [string]$BodyFile = "",
        [string]$ContentType = "application/vnd.github+json"
    )

    $RequestId = [Guid]::NewGuid().ToString("N")
    $ConfigPath = Join-Path $env:TEMP "devspace-github-$RequestId.curl"
    $ResponsePath = Join-Path $env:TEMP "devspace-github-$RequestId.response"
    $Lines = [System.Collections.Generic.List[string]]::new()
    $Lines.Add('url = "' + (ConvertTo-CurlQuotedValue $Url) + '"')
    $Lines.Add('request = "' + $Method.ToUpperInvariant() + '"')
    $Lines.Add('header = "Authorization: Bearer ' + $script:GitHubToken + '"')
    $Lines.Add('header = "Accept: application/vnd.github+json"')
    $Lines.Add('header = "X-GitHub-Api-Version: 2022-11-28"')
    $Lines.Add('header = "User-Agent: DevSpace-Deploy-Portable"')
    if ($ContentType) { $Lines.Add('header = "Content-Type: ' + $ContentType + '"') }
    if ($BodyFile) {
        $ResolvedBody = (Resolve-Path $BodyFile).Path
        $Lines.Add('data-binary = "@' + (ConvertTo-CurlQuotedValue $ResolvedBody) + '"')
    }
    $Lines.Add('output = "' + (ConvertTo-CurlQuotedValue $ResponsePath) + '"')
    $Lines.Add('write-out = "%{http_code}"')
    $Lines.Add('silent')
    $Lines.Add('show-error')
    $Lines.Add('location')
    $Lines.Add('connect-timeout = 30')

    try {
        [IO.File]::WriteAllLines($ConfigPath, $Lines, [Text.UTF8Encoding]::new($false))
        $StatusText = (& $script:CurlPath --config $ConfigPath)
        if ($LASTEXITCODE -ne 0) {
            throw "GitHub request transport failed with curl exit code $LASTEXITCODE."
        }
        $StatusCode = [int]([string]$StatusText).Trim()
        $Bytes = if (Test-Path $ResponsePath) { [IO.File]::ReadAllBytes($ResponsePath) } else { [byte[]]@() }
        $Text = if ($Bytes.Length) { [Text.Encoding]::UTF8.GetString($Bytes) } else { "" }
        return [pscustomobject]@{
            StatusCode = $StatusCode
            Text = $Text
            Bytes = $Bytes
        }
    } finally {
        Remove-Item -LiteralPath $ConfigPath, $ResponsePath -Force -ErrorAction SilentlyContinue
    }
}

$script:GitHubToken = Get-GitHubToken
$script:CurlPath = Get-CurlPath
$Tag = "v$Version"
$ApiRoot = "https://api.github.com/repos/$Repository"
$ReleaseNotes = Join-Path $Root "docs\releases\HOTFIX-$Version.md"
$Zip = Join-Path $Root "DevSpacePortable-Windows-x64-$Version.zip"
$UpdateManifest = Join-Path $Root "release-assets\update-manifest.json"
$ReleaseChecksums = Join-Path $Root "release-assets\SHA256SUMS-release.txt"

foreach ($Required in @($ReleaseNotes, $Zip, $UpdateManifest, $ReleaseChecksums)) {
    if (-not (Test-Path $Required)) { throw "Required release file is missing: $Required" }
}

$ReleaseResponse = Invoke-GitHubRequest -Method GET -Url "$ApiRoot/releases/tags/$Tag" -ContentType ""
if ($ReleaseResponse.StatusCode -eq 404) {
    $CreateBodyPath = Join-Path $env:TEMP ("devspace-release-" + [Guid]::NewGuid().ToString("N") + ".json")
    try {
        $CreateBody = @{
            tag_name = $Tag
            target_commitish = "main"
            name = "DevSpace Portable $Version"
            body = Get-Content -LiteralPath $ReleaseNotes -Raw
            draft = $false
            prerelease = $false
            generate_release_notes = $false
        } | ConvertTo-Json -Depth 6
        [IO.File]::WriteAllText($CreateBodyPath, $CreateBody, [Text.UTF8Encoding]::new($false))
        $ReleaseResponse = Invoke-GitHubRequest -Method POST -Url "$ApiRoot/releases" -BodyFile $CreateBodyPath -ContentType "application/json"
    } finally {
        Remove-Item -LiteralPath $CreateBodyPath -Force -ErrorAction SilentlyContinue
    }
}
if ($ReleaseResponse.StatusCode -lt 200 -or $ReleaseResponse.StatusCode -ge 300) {
    throw "GitHub Release lookup/create failed: HTTP $($ReleaseResponse.StatusCode) $($ReleaseResponse.Text)"
}
$Release = $ReleaseResponse.Text | ConvertFrom-Json

$Assets = @(
    @{ Path = $Zip; ContentType = "application/zip" },
    @{ Path = $UpdateManifest; ContentType = "application/json" },
    @{ Path = $ReleaseChecksums; ContentType = "text/plain" }
)

$Uploaded = @()
foreach ($AssetDefinition in $Assets) {
    $AssetPath = [string]$AssetDefinition.Path
    $AssetName = [IO.Path]::GetFileName($AssetPath)
    $ExpectedSize = (Get-Item -LiteralPath $AssetPath).Length
    $Existing = @($Release.assets) | Where-Object { $_.name -eq $AssetName } | Select-Object -First 1
    if ($Existing) {
        if (-not $ReplaceExistingAssets -and [int64]$Existing.size -eq $ExpectedSize -and $Existing.state -eq "uploaded") {
            $Uploaded += [pscustomobject]@{ Name = $AssetName; Size = $ExpectedSize; Reused = $true; State = $Existing.state }
            continue
        }
        if (-not $ReplaceExistingAssets) {
            throw "Release asset already exists with a conflicting state or size: $AssetName. Use -ReplaceExistingAssets."
        }
        $DeleteResponse = Invoke-GitHubRequest -Method DELETE -Url "$ApiRoot/releases/assets/$($Existing.id)" -ContentType ""
        if ($DeleteResponse.StatusCode -ne 204) {
            throw "Unable to delete existing asset ${AssetName}: HTTP $($DeleteResponse.StatusCode)"
        }
    }

    $EncodedName = [Uri]::EscapeDataString($AssetName)
    $UploadUrl = "https://uploads.github.com/repos/$Repository/releases/$($Release.id)/assets?name=$EncodedName"
    Write-Host "Uploading $AssetName ($ExpectedSize bytes)..."
    $UploadResponse = Invoke-GitHubRequest -Method POST -Url $UploadUrl -BodyFile $AssetPath -ContentType ([string]$AssetDefinition.ContentType)
    if ($UploadResponse.StatusCode -lt 200 -or $UploadResponse.StatusCode -ge 300) {
        throw "Asset upload failed for ${AssetName}: HTTP $($UploadResponse.StatusCode) $($UploadResponse.Text)"
    }
    $UploadedAsset = $UploadResponse.Text | ConvertFrom-Json
    if ([int64]$UploadedAsset.size -ne $ExpectedSize -or $UploadedAsset.state -ne "uploaded") {
        throw "GitHub returned an invalid asset state for $AssetName."
    }
    $Uploaded += [pscustomobject]@{ Name = $AssetName; Size = $ExpectedSize; Reused = $false; State = $UploadedAsset.state }
}

$VerifiedResponse = Invoke-GitHubRequest -Method GET -Url "$ApiRoot/releases/tags/$Tag" -ContentType ""
if ($VerifiedResponse.StatusCode -ne 200) {
    throw "Release verification failed: HTTP $($VerifiedResponse.StatusCode)"
}
$Verified = $VerifiedResponse.Text | ConvertFrom-Json

[pscustomobject]@{
    Repository = $Repository
    Tag = $Verified.tag_name
    ReleaseId = $Verified.id
    Url = $Verified.html_url
    Draft = $Verified.draft
    Prerelease = $Verified.prerelease
    Assets = $Uploaded
} | ConvertTo-Json -Depth 6

