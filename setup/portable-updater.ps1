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
    [int]$UiPid = 0,
    [string]$LaunchAckPath = "",
    [string]$UpdateTaskName = "",
    [switch]$ForceFull
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

function Get-Sha256File([string]$Path) {
    $absolute = [IO.Path]::GetFullPath($Path)
    $stream = [IO.File]::Open($absolute, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        $sha256 = [Security.Cryptography.SHA256]::Create()
        try {
            $bytes = $sha256.ComputeHash($stream)
            return ([BitConverter]::ToString($bytes)).Replace("-", "").ToLowerInvariant()
        } finally {
            $sha256.Dispose()
        }
    } finally {
        $stream.Dispose()
    }
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

function Remove-TransientUpdateTask {
    if ([string]::IsNullOrWhiteSpace($UpdateTaskName)) { return }
    if ($UpdateTaskName -notmatch '^DevSpace Portable Update [0-9a-fA-F]{32}$') {
        Write-UpdateLog "Refusing to delete unexpected update task name: $UpdateTaskName"
        return
    }
    $schtasks = Join-Path $env:SystemRoot "System32\schtasks.exe"
    try {
        & $schtasks /delete /tn $UpdateTaskName /f 2>$null | Out-Null
        Write-UpdateLog "Transient update task removed: $UpdateTaskName"
    } catch {
        Write-UpdateLog "Unable to remove transient update task ${UpdateTaskName}: $($_.Exception.Message)"
    }
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

function ConvertTo-ProxyUrl([string]$Value) {
    $raw = ([string]$Value).Trim()
    if ([string]::IsNullOrWhiteSpace($raw)) { return "" }
    if ($raw -notmatch '^[A-Za-z][A-Za-z0-9+.-]*://') { $raw = "http://$raw" }
    try {
        $uri = [Uri]$raw
        if (@("http", "https", "socks5") -notcontains $uri.Scheme.ToLowerInvariant()) { return "" }
        if ([string]::IsNullOrWhiteSpace($uri.Host) -or $uri.Port -le 0 -or -not [string]::IsNullOrWhiteSpace($uri.UserInfo)) { return "" }
        return $uri.AbsoluteUri.TrimEnd('/')
    } catch {
        return ""
    }
}

function ConvertFrom-WindowsProxyServer([string]$Value) {
    $raw = ([string]$Value).Trim()
    if ([string]::IsNullOrWhiteSpace($raw)) { return "" }
    if ($raw -notmatch '[=;]') { return ConvertTo-ProxyUrl $raw }
    $values = @{}
    foreach ($piece in ($raw -split ';')) {
        $parts = $piece -split '=', 2
        if ($parts.Count -ne 2) { continue }
        $values[$parts[0].Trim().ToLowerInvariant()] = $parts[1].Trim()
    }
    foreach ($key in @("https", "http", "socks", "socks5")) {
        if (-not $values.ContainsKey($key)) { continue }
        $scheme = if ($key.StartsWith("socks")) { "socks5" } else { "http" }
        $candidate = ConvertTo-ProxyUrl "${scheme}://$($values[$key])"
        if ($candidate) { return $candidate }
    }
    return ""
}

function Test-LocalProxyHealthy([string]$ProxyUrl) {
    if ([string]::IsNullOrWhiteSpace($ProxyUrl)) { return $false }
    try { $uri = [Uri]$ProxyUrl } catch { return $false }
    if (@("127.0.0.1", "localhost", "::1", "[::1]") -notcontains $uri.Host.ToLowerInvariant()) { return $true }
    if ($uri.Port -le 0) { return $false }
    $pattern = "(?:127\.0\.0\.1|0\.0\.0\.0|\[::\]|\[::1\]|::):$([Regex]::Escape([string]$uri.Port))\s+\S+\s+LISTENING"
    $netstat = & "$env:SystemRoot\System32\netstat.exe" -ano -p TCP 2>$null | Out-String
    return [Regex]::IsMatch($netstat, $pattern, [Text.RegularExpressions.RegexOptions]::IgnoreCase)
}

function Get-WindowsInternetProxyState {
    try {
        $internetSettings = Get-ItemProperty -LiteralPath "HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings" -ErrorAction Stop
        $proxyEnabled = [int]$internetSettings.ProxyEnable -ne 0
        $proxyServer = [string]$internetSettings.ProxyServer
        $autoConfigUrl = [string]$internetSettings.AutoConfigURL
        return [pscustomobject]@{
            configured = $proxyEnabled -or -not [string]::IsNullOrWhiteSpace($autoConfigUrl)
            proxyEnabled = $proxyEnabled
            proxyUrl = if ($proxyEnabled) { ConvertFrom-WindowsProxyServer $proxyServer } else { "" }
            autoConfigUrl = $autoConfigUrl
        }
    } catch {
        return [pscustomobject]@{
            configured = $false
            proxyEnabled = $false
            proxyUrl = ""
            autoConfigUrl = ""
        }
    }
}

function Get-GitHubMirrorPrefixes {
    $configured = [Environment]::GetEnvironmentVariable("DEVSPACE_GITHUB_MIRRORS")
    $values = if ([string]::IsNullOrWhiteSpace($configured)) {
        @(
            "https://ghproxy.net/",
            "https://gh-proxy.com/",
            "https://github.moeyy.xyz/",
            "https://gh-proxy.net/"
        )
    } else {
        @($configured -split '[;,\r\n]')
    }
    $result = New-Object System.Collections.Generic.List[string]
    $seen = New-Object System.Collections.Generic.HashSet[string]([StringComparer]::OrdinalIgnoreCase)
    foreach ($value in $values) {
        $text = ([string]$value).Trim()
        if ([string]::IsNullOrWhiteSpace($text)) { continue }
        try { $uri = [Uri]$text } catch { continue }
        if ($uri.Scheme -ne "https" -or [string]::IsNullOrWhiteSpace($uri.Host) -or -not [string]::IsNullOrWhiteSpace($uri.UserInfo)) { continue }
        $prefix = $uri.AbsoluteUri
        if (-not $prefix.EndsWith('/')) { $prefix += '/' }
        if ($seen.Add($prefix)) { [void]$result.Add($prefix) }
    }
    return $result.ToArray()
}

function Get-GitHubEndpointCandidates([string]$Uri) {
    $items = New-Object System.Collections.ArrayList
    try { $parsed = [Uri]$Uri } catch { throw "Invalid GitHub URI: $Uri" }
    $mirrorable = $parsed.Scheme -eq "https" -and $parsed.Host.Equals("github.com", [StringComparison]::OrdinalIgnoreCase)
    if ($mirrorable) {
        foreach ($prefix in @(Get-GitHubMirrorPrefixes)) {
            [void]$items.Add([pscustomobject]@{
                uri = "$prefix$Uri"
                source = "mirror:$(([Uri]$prefix).Host)"
                mirrored = $true
            })
        }
    }
    [void]$items.Add([pscustomobject]@{ uri = $Uri; source = "official"; mirrored = $false })
    return $items.ToArray()
}

function Set-WebRequestHeaders($Request, [hashtable]$Headers) {
    foreach ($key in $Headers.Keys) {
        $name = [string]$key
        $value = [string]$Headers[$key]
        if ($name.Equals("User-Agent", [StringComparison]::OrdinalIgnoreCase)) {
            $Request.UserAgent = $value
        } elseif ($name.Equals("Accept", [StringComparison]::OrdinalIgnoreCase)) {
            $Request.Accept = $value
        } elseif ($name.Equals("Content-Type", [StringComparison]::OrdinalIgnoreCase)) {
            $Request.ContentType = $value
        } else {
            $Request.Headers[$name] = $value
        }
    }
}

function New-DotNetWebRequest {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Uri,
        [hashtable]$Headers = @{},
        [int]$TimeoutSec = 30,
        [ValidateSet("direct", "system")]
        [string]$ProxyMode = "direct",
        [switch]$Decompress
    )
    $request = [System.Net.HttpWebRequest][System.Net.WebRequest]::Create($Uri)
    $request.Method = "GET"
    $request.AllowAutoRedirect = $true
    $request.MaximumAutomaticRedirections = 10
    $request.KeepAlive = $false
    $request.Timeout = [Math]::Min(15000, [Math]::Max(3000, $TimeoutSec * 1000))
    $request.ReadWriteTimeout = [Math]::Min(30000, [Math]::Max(5000, $TimeoutSec * 1000))
    if ($ProxyMode -eq "system") {
        $request.Proxy = [System.Net.WebRequest]::GetSystemWebProxy()
        if ($request.Proxy) { $request.Proxy.Credentials = [System.Net.CredentialCache]::DefaultCredentials }
    } else {
        $request.Proxy = $null
    }
    if ($Decompress) {
        $request.AutomaticDecompression = [System.Net.DecompressionMethods]::GZip -bor [System.Net.DecompressionMethods]::Deflate
    }
    Set-WebRequestHeaders -Request $request -Headers $Headers
    return $request
}

function Invoke-DotNetJson {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Uri,
        [hashtable]$Headers = @{},
        [int]$TimeoutSec = 30,
        [ValidateSet("direct", "system")]
        [string]$ProxyMode = "direct",
        [string]$Transport = "dotnet-direct"
    )
    $request = New-DotNetWebRequest -Uri $Uri -Headers $Headers -TimeoutSec $TimeoutSec -ProxyMode $ProxyMode -Decompress
    $response = $null
    $reader = $null
    try {
        $response = [System.Net.HttpWebResponse]$request.GetResponse()
        $status = [int]$response.StatusCode
        if ($status -lt 200 -or $status -ge 300) { throw "$Transport GitHub request returned HTTP $status." }
        $reader = New-Object System.IO.StreamReader($response.GetResponseStream(), [Text.Encoding]::UTF8, $true)
        $json = $reader.ReadToEnd()
        if ([string]::IsNullOrWhiteSpace($json)) { throw "$Transport GitHub request returned an empty response." }
        try { return $json | ConvertFrom-Json }
        catch { throw "$Transport GitHub response was not valid JSON: $($_.Exception.Message)" }
    } catch {
        throw "$Transport GitHub request failed: $($_.Exception.Message)"
    } finally {
        if ($reader) { $reader.Dispose() }
        if ($response) { $response.Dispose() }
        try { $request.Abort() } catch {}
    }
}

function Invoke-DotNetDownload {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Uri,
        [Parameter(Mandatory = $true)]
        [string]$OutFile,
        [hashtable]$Headers = @{},
        [int]$TimeoutSec = 1800,
        [int64]$ExpectedBytes = 0,
        [string]$Description = "GitHub download",
        [ValidateSet("direct", "system")]
        [string]$ProxyMode = "direct",
        [string]$Transport = "dotnet-direct"
    )
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutFile) | Out-Null
    [int64]$existingBytes = if (Test-Path -LiteralPath $OutFile -PathType Leaf) { (Get-Item -LiteralPath $OutFile).Length } else { 0 }
    $request = New-DotNetWebRequest -Uri $Uri -Headers $Headers -TimeoutSec $TimeoutSec -ProxyMode $ProxyMode
    if ($existingBytes -gt 0) { $request.AddRange($existingBytes) }
    $response = $null
    $input = $null
    $output = $null
    $startedAt = Get-Date
    try {
        try {
            $response = [System.Net.HttpWebResponse]$request.GetResponse()
        } catch [System.Net.WebException] {
            $webResponse = $_.Exception.Response -as [System.Net.HttpWebResponse]
            if ($webResponse -and [int]$webResponse.StatusCode -eq 416 -and $ExpectedBytes -gt 0 -and $existingBytes -eq $ExpectedBytes) {
                $webResponse.Dispose()
                Write-UpdateProgress -Phase "downloaded" -Message "$Description completed" -BytesReceived $existingBytes -BytesTotal $ExpectedBytes -Transport $Transport
                return
            }
            if ($webResponse) { $webResponse.Dispose() }
            throw
        }
        $status = [int]$response.StatusCode
        if ($status -ne 200 -and $status -ne 206) { throw "$Transport GitHub download returned HTTP $status." }
        $resume = $existingBytes -gt 0 -and $status -eq 206
        if (-not $resume) { $existingBytes = 0 }
        $mode = if ($resume) { [IO.FileMode]::Append } else { [IO.FileMode]::Create }
        $output = New-Object IO.FileStream($OutFile, $mode, [IO.FileAccess]::Write, [IO.FileShare]::Read)
        $input = $response.GetResponseStream()
        [int64]$bytes = $existingBytes
        [int64]$total = if ($ExpectedBytes -gt 0) { $ExpectedBytes } elseif ($response.ContentLength -gt 0) { $existingBytes + [int64]$response.ContentLength } else { 0 }
        $buffer = New-Object byte[] (256 * 1024)
        $lastAt = Get-Date
        [int64]$lastBytes = $bytes
        Write-UpdateProgress -Phase "downloading" -Message $Description -BytesReceived $bytes -BytesTotal $total -Transport $Transport
        while (($read = $input.Read($buffer, 0, $buffer.Length)) -gt 0) {
            $output.Write($buffer, 0, $read)
            $bytes += $read
            $now = Get-Date
            if (($now - $startedAt).TotalSeconds -gt $TimeoutSec) { throw "$Transport GitHub download exceeded the $TimeoutSec second limit." }
            if (($now - $lastAt).TotalMilliseconds -ge 500) {
                $seconds = [Math]::Max(0.001, ($now - $lastAt).TotalSeconds)
                $speed = [Math]::Max(0, ($bytes - $lastBytes) / $seconds)
                Write-UpdateProgress -Phase "downloading" -Message $Description -BytesReceived $bytes -BytesTotal $total -SpeedBytesPerSecond $speed -Transport $Transport
                $lastAt = $now
                $lastBytes = $bytes
            }
        }
        $output.Flush()
        $finalBytes = (Get-Item -LiteralPath $OutFile).Length
        if ($ExpectedBytes -gt 0 -and $finalBytes -ne $ExpectedBytes) {
            throw "$Transport GitHub download size mismatch: expected $ExpectedBytes bytes, got $finalBytes."
        }
        Write-UpdateProgress -Phase "downloaded" -Message "$Description completed" -BytesReceived $finalBytes -BytesTotal $(if ($ExpectedBytes -gt 0) { $ExpectedBytes } else { $finalBytes }) -Transport $Transport
    } catch {
        throw "$Transport GitHub download failed: $($_.Exception.Message)"
    } finally {
        if ($input) { $input.Dispose() }
        if ($output) { $output.Dispose() }
        if ($response) { $response.Dispose() }
        try { $request.Abort() } catch {}
    }
}

function Get-GitHubTransportCandidates {
    $items = New-Object System.Collections.ArrayList
    $seen = New-Object System.Collections.Generic.HashSet[string]([StringComparer]::OrdinalIgnoreCase)
    $addProxy = {
        param([string]$ProxyUrl, [string]$Name)
        $normalized = ConvertTo-ProxyUrl $ProxyUrl
        if ([string]::IsNullOrWhiteSpace($normalized) -or $seen.Contains($normalized)) { return }
        [void]$seen.Add($normalized)
        if (-not (Test-LocalProxyHealthy $normalized)) {
            Write-UpdateLog "Skipping unavailable local proxy $normalized from $Name."
            return
        }
        [void]$items.Add([pscustomobject]@{ proxyUrl = $normalized; transport = "curl-proxy"; source = $Name })
    }

    # Respect an explicitly enabled Windows/system proxy first. If no usable
    # proxy is configured, or it fails, fall back to direct/TUN transports.
    # Endpoint ordering (mirror first, official GitHub second) is handled
    # separately by Get-GitHubEndpointCandidates.
    $windowsProxy = Get-WindowsInternetProxyState
    if ($windowsProxy.configured) {
        [void]$items.Add([pscustomobject]@{ proxyUrl = ""; transport = "dotnet-system-proxy"; source = "windows-system-proxy" })
    }
    if ($windowsProxy.proxyEnabled -and $windowsProxy.proxyUrl) { & $addProxy ([string]$windowsProxy.proxyUrl) "wininet" }
    foreach ($name in @("HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "all_proxy")) {
        $value = [Environment]::GetEnvironmentVariable($name)
        if ($value) { & $addProxy $value "env:$name" }
    }
    [void]$items.Add([pscustomobject]@{ proxyUrl = ""; transport = "dotnet-direct"; source = "direct-dotnet" })
    [void]$items.Add([pscustomobject]@{ proxyUrl = ""; transport = "curl-direct"; source = "direct-or-transparent-tun" })
    return $items.ToArray()
}

function Get-GitHubMirrorTransportCandidates {
    $all = @(Get-GitHubTransportCandidates)
    $items = New-Object System.Collections.ArrayList
    $preferredProxy = $all | Where-Object {
        $_.transport -eq "dotnet-system-proxy" -or -not [string]::IsNullOrWhiteSpace([string]$_.proxyUrl)
    } | Select-Object -First 1
    if ($preferredProxy) { [void]$items.Add($preferredProxy) }

    $directDotNet = $all | Where-Object { $_.transport -eq "dotnet-direct" } | Select-Object -First 1
    if ($directDotNet) { [void]$items.Add($directDotNet) }

    # With no proxy configured, keep curl as the second independent direct/TUN
    # implementation. With a system proxy, two mirror attempts are enough;
    # failures should move quickly to the official GitHub endpoint.
    if (-not $preferredProxy) {
        $directCurl = $all | Where-Object { $_.transport -eq "curl-direct" } | Select-Object -First 1
        if ($directCurl) { [void]$items.Add($directCurl) }
    }
    return $items.ToArray()
}

function Invoke-CurlJson {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Uri,
        [hashtable]$Headers = @{},
        [int]$TimeoutSec = 30,
        [string]$ProxyUrl = "",
        [string]$Transport = "curl-direct"
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
    if ($ProxyUrl) { $arguments += @("--proxy", $ProxyUrl) }
    else { $arguments += @("--noproxy", "*") }
    foreach ($key in $Headers.Keys) {
        $arguments += @("--header", "${key}: $($Headers[$key])")
    }
    $arguments += $Uri
    $proxyNames = @("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy")
    $savedProxyEnvironment = @{}
    foreach ($name in $proxyNames) {
        $savedProxyEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
        [Environment]::SetEnvironmentVariable($name, $null, "Process")
    }
    try {
        $output = & $curl @arguments
        $exitCode = $LASTEXITCODE
    } finally {
        foreach ($name in $proxyNames) {
            [Environment]::SetEnvironmentVariable($name, $savedProxyEnvironment[$name], "Process")
        }
    }
    if ($exitCode -ne 0) { throw "$Transport GitHub request failed with exit code $exitCode." }
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
        [string]$Description = "GitHub request",
        [switch]$AllowMirrors
    )
    $errors = New-Object System.Collections.Generic.List[string]
    for ($round = 1; $round -le 2; $round++) {
        $endpoints = if ($AllowMirrors) {
            @(Get-GitHubEndpointCandidates $Uri)
        } else {
            @([pscustomobject]@{ uri = $Uri; source = "official"; mirrored = $false })
        }
        foreach ($endpoint in $endpoints) {
            $transportCandidates = if ($endpoint.mirrored) { @(Get-GitHubMirrorTransportCandidates) } else { @(Get-GitHubTransportCandidates) }
            foreach ($candidate in $transportCandidates) {
                try {
                    $route = if ($endpoint.mirrored) { "$($endpoint.source)" } else { "official GitHub" }
                    $transportLabel = if ($candidate.transport -eq "dotnet-system-proxy") { "Windows system proxy" } elseif ($candidate.proxyUrl) { $candidate.source } elseif ($candidate.transport -eq "dotnet-direct") { "direct/TUN (.NET)" } else { "direct/TUN (curl)" }
                    $label = "$Description - $route via $transportLabel"
                    Write-UpdateProgress -Phase "metadata" -Message $label -Transport ([string]$candidate.transport)
                    if ($candidate.transport -eq "dotnet-system-proxy" -or $candidate.transport -eq "dotnet-direct") {
                        $proxyMode = if ($candidate.transport -eq "dotnet-system-proxy") { "system" } else { "direct" }
                        $result = Invoke-DotNetJson -Uri ([string]$endpoint.uri) -Headers $Headers -TimeoutSec ([Math]::Min($TimeoutSec, 10)) -ProxyMode $proxyMode -Transport ([string]$candidate.transport)
                        Write-UpdateLog "$Description succeeded through $($endpoint.source) / $($candidate.source)."
                        return $result
                    }
                    $result = Invoke-CurlJson -Uri ([string]$endpoint.uri) -Headers $Headers -TimeoutSec ([Math]::Min($TimeoutSec, 12)) -ProxyUrl ([string]$candidate.proxyUrl) -Transport ([string]$candidate.transport)
                    Write-UpdateLog "$Description succeeded through $($endpoint.source) / $($candidate.source)."
                    return $result
                } catch {
                    $message = $_.Exception.Message
                    [void]$errors.Add("round${round}/$($endpoint.source)/$($candidate.source): $message")
                    Write-UpdateLog "$Description failed through $($endpoint.source) / $($candidate.source) on round ${round}: $message"
                }
            }
        }
        if ($round -lt 2) {
            Write-UpdateLog "$Description exhausted the current official/proxy network candidates; refreshing proxy/route state and retrying once."
            Start-Sleep -Milliseconds 900
        }
    }
    throw "$Description failed through Windows/configured proxies and official direct/TUN fallbacks. $($errors -join '; ')"
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
        [string]$ProxyUrl = "",
        [string]$Transport = "curl-direct"
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
    if ($ProxyUrl) { $arguments += @("--proxy", $ProxyUrl) }
    else { $arguments += @("--noproxy", "*") }
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
    foreach ($name in @("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy")) {
        if ($info.EnvironmentVariables.ContainsKey($name)) { $info.EnvironmentVariables.Remove($name) }
    }
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $info
    if (-not $process.Start()) { throw "Unable to start curl.exe for $Description." }
    $transport = $Transport
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
    $errors = New-Object System.Collections.Generic.List[string]
    foreach ($endpoint in @(Get-GitHubEndpointCandidates $Uri)) {
        $transportCandidates = if ($endpoint.mirrored) { @(Get-GitHubMirrorTransportCandidates) } else { @(Get-GitHubTransportCandidates) }
        foreach ($candidate in $transportCandidates) {
            try {
                $route = if ($endpoint.mirrored) { "$($endpoint.source)" } else { "official GitHub" }
                $transportLabel = if ($candidate.transport -eq "dotnet-system-proxy") { "Windows system proxy" } elseif ($candidate.proxyUrl) { $candidate.source } elseif ($candidate.transport -eq "dotnet-direct") { "direct/TUN (.NET)" } else { "direct/TUN (curl)" }
                $label = "$Description - $route via $transportLabel"
                if ($candidate.transport -eq "dotnet-system-proxy" -or $candidate.transport -eq "dotnet-direct") {
                    $proxyMode = if ($candidate.transport -eq "dotnet-system-proxy") { "system" } else { "direct" }
                    Invoke-DotNetDownload -Uri ([string]$endpoint.uri) -OutFile $OutFile -Headers $Headers -TimeoutSec $TimeoutSec -ExpectedBytes $ExpectedBytes -Description $label -ProxyMode $proxyMode -Transport ([string]$candidate.transport)
                } else {
                    Invoke-CurlDownload -Uri ([string]$endpoint.uri) -OutFile $OutFile -Headers $Headers -TimeoutSec $TimeoutSec -ExpectedBytes $ExpectedBytes -Description $label -ProxyUrl ([string]$candidate.proxyUrl) -Transport ([string]$candidate.transport)
                }
                Write-UpdateLog "$Description succeeded through $($endpoint.source) / $($candidate.source)."
                return
            } catch {
                $message = $_.Exception.Message
                [void]$errors.Add("$($endpoint.source)/$($candidate.source): $message")
                Write-UpdateLog "$Description failed through $($endpoint.source) / $($candidate.source): $message"
            }
        }
    }
    # A CDN may reject resuming a partial file after the outbound path changes.
    # One last clean direct/TUN retry avoids getting stuck on a poisoned partial
    # file while still keeping the entire update bounded and visible in the UI.
    if (Test-Path -LiteralPath $OutFile) { Remove-Item -LiteralPath $OutFile -Force -ErrorAction SilentlyContinue }
    try {
        Invoke-CurlDownload -Uri $Uri -OutFile $OutFile -Headers $Headers -TimeoutSec $TimeoutSec -ExpectedBytes $ExpectedBytes -Description "$Description - clean direct/TUN retry" -Transport "curl-direct"
        return
    } catch {
        [void]$errors.Add("clean-direct: $($_.Exception.Message)")
        throw "$Description failed through mirror-first endpoints, proxy candidates, official direct/TUN, and a clean official retry. $($errors -join '; ')"
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

function Get-GitHubAssetSha256([object]$Asset) {
    $digest = ([string]$Asset.digest).Trim().ToLowerInvariant()
    if ($digest -match '^sha256:([0-9a-f]{64})$') { return $Matches[1] }
    return ""
}

function Assert-ReleaseAssetMetadata([object]$Asset, [string]$Version, [string]$ExpectedName) {
    if (-not $Asset) { throw "Release metadata is missing asset $ExpectedName." }
    if ([string]$Asset.name -ne $ExpectedName) { throw "Release metadata references an unexpected asset name." }
    if ([int64]$Asset.size -le 0) { throw "Release metadata has an invalid asset size for $ExpectedName." }
    $sha256 = ([string]$Asset.sha256).Trim().ToLowerInvariant()
    if ($sha256 -notmatch '^[0-9a-f]{64}$') { throw "Release metadata has an invalid SHA-256 for $ExpectedName." }
    $downloadUrl = ([string]$Asset.downloadUrl).Trim()
    $expectedPrefix = "https://github.com/$Repository/releases/download/v$Version/"
    if (-not $downloadUrl.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Release metadata has an unexpected download URL for $ExpectedName."
    }
}

function Assert-BlockmapAssetMetadata([object]$Asset, [string]$Version) {
    if (-not $Asset) { throw "Release metadata has no blockmap asset." }
    $expectedName = "DevSpacePortable-Windows-x64-$Version.blockmap"
    Assert-ReleaseAssetMetadata -Asset $Asset -Version $Version -ExpectedName $expectedName
    if ([string]$Asset.format -ne "block-pack-v2") { throw "Release metadata references an unsupported blockmap format." }
    if ([string]$Asset.targetVersion -ne $Version) { throw "Blockmap target version does not match the Release version." }
    $headerSize = [int64]$Asset.headerCompressedSize
    $headerRawSize = [int64]$Asset.headerRawSize
    $headerSha256 = ([string]$Asset.headerSha256).Trim().ToLowerInvariant()
    if ($headerSize -le 0 -or $headerSize -gt 67108864) { throw "Blockmap headerCompressedSize is invalid." }
    if ($headerRawSize -le 0 -or $headerRawSize -gt 134217728) { throw "Blockmap headerRawSize is invalid." }
    if ($headerSha256 -notmatch '^[0-9a-f]{64}$') { throw "Blockmap header SHA-256 is invalid." }
}

function Get-LatestReleaseFromPublishedManifest {
    $manifestUrl = "https://github.com/$Repository/releases/latest/download/update-manifest.json"
    $manifest = Invoke-GitHubJson -Uri $manifestUrl -Headers @{ "User-Agent" = "DevSpace-Portable-Updater/$CurrentVersion" } -TimeoutSec 45 -Description "GitHub latest published update-manifest request"
    $version = ([string]$manifest.version).TrimStart('v')
    Assert-Version $version "Release version"
    if ([string]$manifest.repository -ne $Repository) { throw "Published update manifest repository does not match the configured repository." }
    $zipName = "DevSpacePortable-Windows-x64-$version.zip"
    Assert-ReleaseAssetMetadata -Asset $manifest.asset -Version $version -ExpectedName $zipName

    $assets = New-Object System.Collections.ArrayList
    $zipAsset = [pscustomobject]@{
        name = [string]$manifest.asset.name
        size = [int64]$manifest.asset.size
        digest = "sha256:$(([string]$manifest.asset.sha256).ToLowerInvariant())"
        browser_download_url = [string]$manifest.asset.downloadUrl
    }
    [void]$assets.Add($zipAsset)
    $blockmapAsset = $null
    if ($manifest.blockmapAsset) {
        Assert-BlockmapAssetMetadata -Asset $manifest.blockmapAsset -Version $version
        $blockmapAsset = [pscustomobject]@{
            name = [string]$manifest.blockmapAsset.name
            size = [int64]$manifest.blockmapAsset.size
            digest = "sha256:$(([string]$manifest.blockmapAsset.sha256).ToLowerInvariant())"
            browser_download_url = [string]$manifest.blockmapAsset.downloadUrl
        }
        [void]$assets.Add($blockmapAsset)
    }
    foreach ($candidate in @($manifest.incrementalAssets)) {
        $name = [string]$candidate.name
        if ([string]::IsNullOrWhiteSpace($name)) { continue }
        if ([string]$candidate.format -ne "file-delta-v1") { continue }
        if ([string]$candidate.toVersion -ne $version) { continue }
        Assert-ReleaseAssetMetadata -Asset $candidate -Version $version -ExpectedName $name
        [void]$assets.Add([pscustomobject]@{
            name = $name
            size = [int64]$candidate.size
            digest = "sha256:$(([string]$candidate.sha256).ToLowerInvariant())"
            browser_download_url = [string]$candidate.downloadUrl
        })
    }
    $release = [pscustomobject]@{
        tag_name = "v$version"
        html_url = "https://github.com/$Repository/releases/tag/v$version"
        name = "DevSpace Portable $version"
        published_at = [string]$manifest.publishedAt
        assets = $assets.ToArray()
    }
    return [pscustomobject]@{
        release = $release
        version = $version
        manifest = $manifest
        manifestAsset = $null
        manifestSource = "release-latest-update-manifest"
        zipAsset = $zipAsset
        zipName = $zipName
        blockmapAsset = $blockmapAsset
    }
}

function Get-LatestRelease {
    $headers = @{
        Accept = "application/vnd.github+json"
        "X-GitHub-Api-Version" = "2022-11-28"
        "User-Agent" = "DevSpace-Portable-Updater/$CurrentVersion"
    }
    try {
        $release = Invoke-GitHubJson -Uri "https://api.github.com/repos/$Repository/releases/latest" -Headers $headers -TimeoutSec 60 -Description "GitHub latest-release metadata request"
    } catch {
        Write-UpdateLog "GitHub Release API metadata path failed: $($_.Exception.Message). Falling back to the official published latest update manifest."
        return Get-LatestReleaseFromPublishedManifest
    }
    $version = ([string]$release.tag_name).TrimStart('v')
    Assert-Version $version "Release version"
    $manifestAsset = @($release.assets) | Where-Object { $_.name -eq "update-manifest.json" } | Select-Object -First 1
    $zipName = "DevSpacePortable-Windows-x64-$version.zip"
    $zipAsset = @($release.assets) | Where-Object { $_.name -eq $zipName } | Select-Object -First 1
    if (-not $zipAsset) { throw "Latest Release has no $zipName asset." }
    $blockmapName = "DevSpacePortable-Windows-x64-$version.blockmap"
    $blockmapAsset = @($release.assets) | Where-Object { $_.name -eq $blockmapName } | Select-Object -First 1
    $zipSha256 = Get-GitHubAssetSha256 $zipAsset
    $manifestSource = ""
    $manifest = $null

    # Blockmap metadata contains the authenticated header digest and exact
    # Range layout needed before any partial block download can be trusted.
    # Therefore, when a blockmap asset is present, the published manifest is
    # the trust anchor even if GitHub also exposes server-side asset digests.
    if ($blockmapAsset -and $manifestAsset) {
        try {
            $published = Invoke-GitHubJson -Uri $manifestAsset.browser_download_url -Headers @{ "User-Agent" = "DevSpace-Portable-Updater/$CurrentVersion" } -TimeoutSec 60 -Description "GitHub blockmap update-manifest request"
            if ([string]$published.version -ne $version) { throw "Release tag and blockmap update manifest version do not match." }
            if ([string]$published.repository -ne $Repository) { throw "Blockmap update manifest repository does not match the configured repository." }
            Assert-ReleaseAssetMetadata -Asset $published.asset -Version $version -ExpectedName $zipName
            Assert-BlockmapAssetMetadata -Asset $published.blockmapAsset -Version $version
            if ([string]$published.blockmapAsset.name -ne [string]$blockmapAsset.name -or [int64]$published.blockmapAsset.size -ne [int64]$blockmapAsset.size) {
                throw "Blockmap Release asset metadata does not match update-manifest.json."
            }
            if ($zipSha256 -and ([string]$published.asset.sha256).ToLowerInvariant() -ne $zipSha256) {
                throw "Full ZIP SHA-256 differs between GitHub Release metadata and update-manifest.json."
            }
            $blockmapSha256 = Get-GitHubAssetSha256 $blockmapAsset
            if ($blockmapSha256 -and ([string]$published.blockmapAsset.sha256).ToLowerInvariant() -ne $blockmapSha256) {
                throw "Blockmap SHA-256 differs between GitHub Release metadata and update-manifest.json."
            }
            $manifest = $published
            $manifestSource = "release-update-manifest-blockmap"
        } catch {
            # A malformed or temporarily inaccessible new-format manifest must
            # not strand an installed client. Log the rejection and continue
            # through the previously proven legacy/full Release path.
            Write-UpdateLog "Blockmap manifest path is unavailable or invalid; legacy/full fallback remains available: $($_.Exception.Message)"
            $manifest = $null
        }
    }

    # GitHub's Release API exposes a server-computed SHA-256 digest for uploaded
    # assets. Prefer that API metadata so "check for updates" does not depend on
    # a second request to the Release CDN just to read update-manifest.json.
    # Older GitHub responses without asset digests still use the signed manifest.
    if (-not $manifest -and $zipSha256) {
        $incrementalAssets = @()
        $deltaName = "DevSpacePortable-Update-$CurrentVersion-to-$version.zip"
        $deltaAsset = @($release.assets) | Where-Object { $_.name -eq $deltaName } | Select-Object -First 1
        if ($deltaAsset) {
            $deltaSha256 = Get-GitHubAssetSha256 $deltaAsset
            if ($deltaSha256) {
                $incrementalAssets = @([pscustomobject]@{
                    format = "file-delta-v1"
                    fromVersion = $CurrentVersion
                    toVersion = $version
                    name = [string]$deltaAsset.name
                    size = [int64]$deltaAsset.size
                    sha256 = $deltaSha256
                    downloadUrl = [string]$deltaAsset.browser_download_url
                })
            }
        }
        $manifest = [pscustomobject]@{
            schemaVersion = 2
            channel = "stable"
            version = $version
            repository = $Repository
            restartRequired = $true
            updateStrategy = "incremental-first-full-fallback"
            asset = [pscustomobject]@{
                name = $zipName
                size = [int64]$zipAsset.size
                sha256 = $zipSha256
                downloadUrl = [string]$zipAsset.browser_download_url
            }
            incrementalAssets = $incrementalAssets
        }
        $manifestSource = "github-release-asset-digest"
    } elseif (-not $manifest) {
        if (-not $manifestAsset) { throw "Latest Release has neither asset SHA-256 digests nor update-manifest.json." }
        $manifest = Invoke-GitHubJson -Uri $manifestAsset.browser_download_url -Headers @{ "User-Agent" = "DevSpace-Portable-Updater/$CurrentVersion" } -TimeoutSec 60 -Description "GitHub update-manifest request"
        if ([string]$manifest.version -ne $version) { throw "Release tag and update manifest version do not match." }
        if ([string]$manifest.asset.name -ne $zipName) { throw "Update manifest references an unexpected ZIP name." }
        if ([string]$manifest.repository -ne $Repository) { throw "Update manifest repository does not match the configured repository." }
        $manifestSource = "release-update-manifest"
    }
    return [pscustomobject]@{
        release = $release
        version = $version
        manifest = $manifest
        manifestAsset = $manifestAsset
        manifestSource = $manifestSource
        zipAsset = $zipAsset
        zipName = $zipName
        blockmapAsset = $blockmapAsset
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

function Get-BlockmapCandidate([object]$Latest) {
    $candidate = $Latest.manifest.blockmapAsset
    if (-not $candidate) { return $null }
    Assert-BlockmapAssetMetadata -Asset $candidate -Version ([string]$Latest.version)
    $asset = @($Latest.release.assets) | Where-Object { $_.name -eq [string]$candidate.name } | Select-Object -First 1
    if (-not $asset -and $Latest.blockmapAsset) { $asset = $Latest.blockmapAsset }
    if (-not $asset) { throw "Release manifest references a missing blockmap asset: $($candidate.name)" }
    if ([int64]$asset.size -ne [int64]$candidate.size) { throw "Blockmap asset size does not match the release manifest." }
    $releaseDigest = Get-GitHubAssetSha256 $asset
    if ($releaseDigest -and $releaseDigest -ne ([string]$candidate.sha256).ToLowerInvariant()) {
        throw "Blockmap asset SHA-256 does not match GitHub Release metadata."
    }
    return [pscustomobject]@{ manifest = $candidate; asset = $asset }
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

function Get-PublishedIncrementalEdges([object]$Latest) {
    $manifest = $Latest.manifest
    $entries = @($manifest.incrementalGraphAssets)

    # When the Release API already supplied trusted server-side digests we do
    # not fetch update-manifest.json during an ordinary direct update. A jump
    # update needs the tiny historical edge graph, so fetch the signed manifest
    # lazily only in that case. If this request is unavailable, the historical
    # Release API graph below remains a bounded fallback.
    if ($entries.Count -eq 0 -and $Latest.manifestAsset) {
        try {
            $published = Invoke-GitHubJson `
                -Uri ([string]$Latest.manifestAsset.browser_download_url) `
                -Headers @{ "User-Agent" = "DevSpace-Portable-Updater/$CurrentVersion" } `
                -TimeoutSec 60 `
                -Description "GitHub published incremental graph manifest request"
            if ([string]$published.version -ne [string]$Latest.version) { throw "Published incremental graph manifest version mismatch." }
            if ([string]$published.repository -ne $Repository) { throw "Published incremental graph manifest repository mismatch." }
            $entries = @($published.incrementalGraphAssets)
            Write-UpdateLog "Loaded $($entries.Count) historical incremental edges from the latest published update manifest."
        } catch {
            Write-UpdateLog "Published incremental graph manifest is unavailable: $($_.Exception.Message)"
            $entries = @()
        }
    }

    $edges = New-Object System.Collections.ArrayList
    foreach ($candidate in $entries) {
        if ([string]$candidate.format -ne "file-delta-v1") { continue }
        $fromVersion = ([string]$candidate.fromVersion).Trim()
        $toVersion = ([string]$candidate.toVersion).Trim()
        if ($fromVersion -notmatch '^\d+\.\d+\.\d+$' -or $toVersion -notmatch '^\d+\.\d+\.\d+$') { continue }
        if ((Compare-Version $fromVersion $toVersion) -ge 0) { continue }
        if ((Compare-Version $fromVersion $CurrentVersion) -lt 0) { continue }
        if ((Compare-Version $toVersion $Latest.version) -gt 0) { continue }
        $name = [string]$candidate.name
        $expectedName = "DevSpacePortable-Update-$fromVersion-to-$toVersion.zip"
        if ($name -ne $expectedName) { continue }
        $size = [int64]$candidate.size
        $sha256 = ([string]$candidate.sha256).Trim().ToLowerInvariant()
        $downloadUrl = ([string]$candidate.downloadUrl).Trim()
        $expectedUrl = "https://github.com/$Repository/releases/download/v$toVersion/$expectedName"
        if ($size -le 0 -or $sha256 -notmatch '^[0-9a-f]{64}$' -or $downloadUrl -ne $expectedUrl) { continue }
        $manifestEdge = [pscustomobject]@{
            format = "file-delta-v1"
            fromVersion = $fromVersion
            toVersion = $toVersion
            name = $name
            size = $size
            sha256 = $sha256
            downloadUrl = $downloadUrl
        }
        $asset = [pscustomobject]@{
            name = $name
            size = $size
            digest = "sha256:$sha256"
            state = "uploaded"
            browser_download_url = $downloadUrl
        }
        [void]$edges.Add([pscustomobject]@{ manifest = $manifestEdge; asset = $asset })
    }
    return @($edges.ToArray())
}

function Get-StableIncrementalEdges([object]$Latest) {
    $headers = @{
        Accept = "application/vnd.github+json"
        "X-GitHub-Api-Version" = "2022-11-28"
        "User-Agent" = "DevSpace-Portable-Updater/$CurrentVersion"
    }
    $edges = New-Object System.Collections.ArrayList
    for ($pageNumber = 1; $pageNumber -le 10; $pageNumber++) {
        try {
            $page = Invoke-GitHubJson `
                -Uri "https://api.github.com/repos/$Repository/releases?per_page=100&page=$pageNumber" `
                -Headers $headers `
                -TimeoutSec 60 `
                -Description "GitHub incremental release graph request page $pageNumber"
        } catch {
            Write-UpdateLog "Incremental release graph lookup failed on page ${pageNumber}: $($_.Exception.Message)"
            return @()
        }
        $releases = @($page)
        foreach ($release in $releases) {
            if ([bool]$release.draft -or [bool]$release.prerelease) { continue }
            $releaseVersion = ([string]$release.tag_name).TrimStart('v')
            if ($releaseVersion -notmatch '^\d+\.\d+\.\d+$') { continue }
            if ((Compare-Version $releaseVersion $CurrentVersion) -le 0) { continue }
            if ((Compare-Version $releaseVersion $Latest.version) -gt 0) { continue }
            foreach ($asset in @($release.assets)) {
                $name = [string]$asset.name
                if ($name -notmatch '^DevSpacePortable-Update-(\d+\.\d+\.\d+)-to-(\d+\.\d+\.\d+)\.zip$') { continue }
                $fromVersion = $Matches[1]
                $toVersion = $Matches[2]
                if ($toVersion -ne $releaseVersion) { continue }
                if ((Compare-Version $fromVersion $toVersion) -ge 0) { continue }
                if ((Compare-Version $fromVersion $CurrentVersion) -lt 0) { continue }
                $sha256 = Get-GitHubAssetSha256 $asset
                if (-not $sha256 -or [int64]$asset.size -le 0 -or [string]$asset.state -ne "uploaded") { continue }
                [void]$edges.Add([pscustomobject]@{
                    manifest = [pscustomobject]@{
                        format = "file-delta-v1"
                        fromVersion = $fromVersion
                        toVersion = $toVersion
                        name = $name
                        size = [int64]$asset.size
                        sha256 = $sha256
                        downloadUrl = [string]$asset.browser_download_url
                    }
                    asset = $asset
                })
            }
        }
        if ($releases.Count -lt 100) { break }
    }
    return @($edges.ToArray())
}

function Resolve-IncrementalGraphPlan([object[]]$Edges, [string]$LatestVersion) {
    if (-not $Edges -or $Edges.Count -eq 0) { return $null }
    $distance = @{}
    $paths = @{}
    $distance[$CurrentVersion] = [int64]0
    $paths[$CurrentVersion] = @()

    # Every accepted edge moves forward in semantic-version order. Repeated
    # relaxation therefore finds a byte-minimal path without requiring every
    # intermediate version to be present or contiguous.
    for ($pass = 0; $pass -le $Edges.Count; $pass++) {
        $changed = $false
        foreach ($edge in $Edges) {
            $fromVersion = [string]$edge.manifest.fromVersion
            $toVersion = [string]$edge.manifest.toVersion
            if (-not $distance.ContainsKey($fromVersion)) { continue }
            $candidateBytes = [int64]$distance[$fromVersion] + [int64]$edge.manifest.size
            if (-not $distance.ContainsKey($toVersion) -or $candidateBytes -lt [int64]$distance[$toVersion]) {
                $distance[$toVersion] = $candidateBytes
                $paths[$toVersion] = @($paths[$fromVersion]) + @($edge)
                $changed = $true
            }
        }
        if (-not $changed) { break }
    }
    if (-not $paths.ContainsKey($LatestVersion)) { return $null }
    $steps = @($paths[$LatestVersion])
    if ($steps.Count -eq 0) { return $null }
    return [pscustomobject]@{
        mode = if ($steps.Count -gt 1) { "incremental-chain" } else { "incremental" }
        steps = $steps
        totalBytes = [int64]$distance[$LatestVersion]
    }
}

function Get-IncrementalUpdatePlan([object]$Latest) {
    $direct = Get-IncrementalCandidate $Latest
    if ($direct) {
        return [pscustomobject]@{
            mode = "incremental"
            steps = @($direct)
            totalBytes = [int64]$direct.manifest.size
        }
    }

    $publishedEdges = @(Get-PublishedIncrementalEdges $Latest)
    $publishedPlan = Resolve-IncrementalGraphPlan $publishedEdges ([string]$Latest.version)
    if ($publishedPlan) { return $publishedPlan }

    # Older manifests or a temporarily unavailable manifest CDN can still be
    # recovered from GitHub's stable Release history. This path is deliberately
    # secondary so future clients do not have to enumerate every historical
    # Release on each jump update.
    $releaseEdges = @(Get-StableIncrementalEdges $Latest)
    return Resolve-IncrementalGraphPlan $releaseEdges ([string]$Latest.version)
}

function Get-UpdateStatus {
    $latest = Get-LatestRelease
    $comparison = Compare-Version $latest.version $CurrentVersion
    $blockmap = $null
    $blockmapFallbackReason = ""
    $incrementalPlan = $null
    $incrementalFallbackReason = ""
    if ($comparison -gt 0) {
        try { $blockmap = Get-BlockmapCandidate $latest }
        catch { $blockmapFallbackReason = $_.Exception.Message }
        if (-not $blockmap) {
            try { $incrementalPlan = Get-IncrementalUpdatePlan $latest }
            catch { $incrementalFallbackReason = $_.Exception.Message }
        }
    }
    $incrementalSteps = if ($incrementalPlan) { @($incrementalPlan.steps) } else { @() }
    $firstIncremental = if ($incrementalSteps.Count -gt 0) { $incrementalSteps[0] } else { $null }
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
        preferredMode = if ($blockmap) { "blockmap" } elseif ($incrementalPlan) { [string]$incrementalPlan.mode } else { "full" }
        blockmapAssetName = if ($blockmap) { [string]$blockmap.manifest.name } else { "" }
        blockmapAssetSize = if ($blockmap) { [int64]$blockmap.manifest.size } else { 0 }
        blockmapAssetSha256 = if ($blockmap) { ([string]$blockmap.manifest.sha256).ToLowerInvariant() } else { "" }
        blockmapHeaderCompressedSize = if ($blockmap) { [int64]$blockmap.manifest.headerCompressedSize } else { 0 }
        blockmapFallbackReason = $blockmapFallbackReason
        incrementalAssetName = if ($firstIncremental) { [string]$firstIncremental.manifest.name } else { "" }
        incrementalAssetSize = if ($incrementalPlan) { [int64]$incrementalPlan.totalBytes } else { 0 }
        incrementalAssetSha256 = if ($incrementalSteps.Count -eq 1) { ([string]$firstIncremental.manifest.sha256).ToLowerInvariant() } else { "" }
        incrementalChainLength = $incrementalSteps.Count
        incrementalChain = @($incrementalSteps | ForEach-Object { [string]$_.manifest.name })
        incrementalFallbackReason = $incrementalFallbackReason
        fullAssetSize = [int64]$latest.manifest.asset.size
        metadataSource = [string]$latest.manifestSource
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
        $actualHash = Get-Sha256File $zip
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

function Stage-BlockmapUpdate([object]$Latest, [object]$Blockmap) {
    New-Item -ItemType Directory -Force -Path $UpdateRoot | Out-Null
    $stage = Join-Path $UpdateRoot ("{0}-blockmap-{1}" -f $Latest.version, [guid]::NewGuid().ToString("N"))
    $payload = Join-Path $stage "payload"
    $portableRoot = Join-Path $payload "DevSpacePortable"
    New-Item -ItemType Directory -Force -Path $stage,$payload | Out-Null
    try {
        $node = Join-Path $Root "runtime\node\node.exe"
        $engine = Join-Path $Root "setup\blockmap-updater.cjs"
        $curl = Get-CurlExecutable
        if (-not (Test-Path -LiteralPath $node -PathType Leaf)) { throw "Portable Node runtime is missing for the blockmap updater." }
        if (-not (Test-Path -LiteralPath $engine -PathType Leaf)) { throw "Blockmap updater engine is missing." }
        if (-not $curl) { throw "curl.exe is unavailable for blockmap HTTP Range downloads." }

        $arguments = @(
            $engine,
            "stage",
            "--root", $Root,
            "--asset-url", ([string]$Blockmap.asset.browser_download_url),
            "--asset-size", ([string][int64]$Blockmap.manifest.size),
            "--header-size", ([string][int64]$Blockmap.manifest.headerCompressedSize),
            "--header-sha256", ([string]$Blockmap.manifest.headerSha256),
            "--payload", $portableRoot,
            "--target-version", ([string]$Latest.version),
            "--progress-file", $ProgressFile,
            "--curl", ([string]$curl)
        )
        $windowsProxy = Get-WindowsInternetProxyState
        if ($windowsProxy.proxyEnabled -and -not [string]::IsNullOrWhiteSpace([string]$windowsProxy.proxyUrl) -and (Test-LocalProxyHealthy ([string]$windowsProxy.proxyUrl))) {
            $arguments += @("--proxy", ([string]$windowsProxy.proxyUrl))
        }

        Write-UpdateLog "Starting blockmap differential staging for $CurrentVersion -> $($Latest.version)."
        Write-UpdateProgress -Phase "probing" -Message "Selecting the fastest HTTP Range source for blockmap differential update" -BytesTotal ([int64]$Blockmap.manifest.size)
        $rawOutput = & $node @arguments 2>&1 | Out-String
        $exitCode = $LASTEXITCODE
        if ($exitCode -ne 0) {
            $diagnostic = $rawOutput.Trim()
            if ([string]::IsNullOrWhiteSpace($diagnostic)) { $diagnostic = "blockmap helper exited with code $exitCode" }
            throw "Blockmap differential staging failed: $diagnostic"
        }
        $jsonLine = @($rawOutput -split "`r?`n") | Where-Object { $_.TrimStart().StartsWith("{") } | Select-Object -Last 1
        if (-not $jsonLine) { throw "Blockmap updater returned no structured result." }
        try { $blockmapResult = $jsonLine | ConvertFrom-Json }
        catch { throw "Blockmap updater returned invalid JSON: $($_.Exception.Message)" }
        if (-not [bool]$blockmapResult.success) { throw "Blockmap updater did not report a successful staging result." }

        foreach ($required in @("DevSpace-Portable.exe", "runtime\node\node.exe", "setup\portable-manager.cjs", "VERSION-MANIFEST.json")) {
            if (-not (Test-Path (Join-Path $portableRoot $required) -PathType Leaf)) { throw "Blockmap staged update is incomplete: $required" }
        }
        $targetManifest = Get-Content -LiteralPath (Join-Path $portableRoot "VERSION-MANIFEST.json") -Raw | ConvertFrom-Json
        if ([string]$targetManifest.runtime.devspacePortable -ne [string]$Latest.version) {
            throw "Blockmap staged version manifest does not report $($Latest.version)."
        }

        Copy-Item -LiteralPath $PSCommandPath -Destination (Join-Path $stage "portable-updater.ps1") -Force
        $stageInfo = [ordered]@{
            formatVersion = 3
            currentVersion = $CurrentVersion
            targetVersion = $Latest.version
            repository = $Repository
            updateMode = "blockmap"
            stagedAt = (Get-Date).ToUniversalTime().ToString("o")
            payloadRoot = $portableRoot
            blockmapName = [string]$Blockmap.manifest.name
            blockmapSize = [int64]$Blockmap.manifest.size
            blockmapSha256 = ([string]$Blockmap.manifest.sha256).ToLowerInvariant()
            blockmapHeaderSha256 = ([string]$Blockmap.manifest.headerSha256).ToLowerInvariant()
            downloadedBytes = [int64]$blockmapResult.downloadedBytes
            reusedBytes = [int64]$blockmapResult.reusedBytes
            targetBytes = [int64]$blockmapResult.targetBytes
            missingUniqueChunks = [int]$blockmapResult.missingUniqueChunks
            rangeRequestGroups = [int]$blockmapResult.rangeRequestGroups
            selectedTransport = [string]$blockmapResult.selectedTransport
        }
        $stageInfo | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $stage "stage-info.json") -Encoding UTF8
        Write-UpdateLog "Blockmap update $CurrentVersion -> $($Latest.version) staged successfully: downloaded=$($blockmapResult.downloadedBytes), reused=$($blockmapResult.reusedBytes), ranges=$($blockmapResult.rangeRequestGroups), transport=$($blockmapResult.selectedTransport)."
        return [pscustomobject]@{
            currentVersion = $CurrentVersion
            latestVersion = $Latest.version
            updateAvailable = $true
            staged = $true
            updateMode = "blockmap"
            stagingPath = $stage
            assetSize = [int64]$blockmapResult.downloadedBytes
            downloadedBytes = [int64]$blockmapResult.downloadedBytes
            reusedBytes = [int64]$blockmapResult.reusedBytes
            targetBytes = [int64]$blockmapResult.targetBytes
            missingUniqueChunks = [int]$blockmapResult.missingUniqueChunks
            rangeRequestGroups = [int]$blockmapResult.rangeRequestGroups
            selectedTransport = [string]$blockmapResult.selectedTransport
            fullFallbackSize = [int64]$Latest.manifest.asset.size
            releaseUrl = [string]$Latest.release.html_url
        }
    } catch {
        Write-UpdateLog "Blockmap staging failed: $($_.Exception.Message)"
        Write-UpdateProgress -Phase "fallback" -Message "Blockmap differential update failed; trying the compatibility updater: $($_.Exception.Message)"
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
        $actualHash = Get-Sha256File $zip
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
        $acceptedBaseDrift = New-Object System.Collections.Generic.List[string]
        foreach ($entry in @($delta.changedFiles)) {
            $relative = ConvertTo-SafeRelativePath ([string]$entry.path)
            $source = Join-Path $filesRoot ($relative.Replace('/','\'))
            if (-not (Test-Path $source -PathType Leaf)) { throw "Incremental package is missing changed file: $relative" }
            if ((Get-Item -LiteralPath $source).Length -ne [int64]$entry.size) { throw "Incremental file size mismatch: $relative" }
            $sourceHash = Get-Sha256File $source
            if ($sourceHash -ne ([string]$entry.sha256).ToLowerInvariant()) { throw "Incremental file SHA-256 mismatch: $relative" }
            $currentTarget = Join-Path $Root ($relative.Replace('/','\'))
            $baseHash = ([string]$entry.baseSha256).ToLowerInvariant()
            if ($baseHash) {
                if (-not (Test-Path $currentTarget -PathType Leaf)) {
                    Write-UpdateLog "Accepting missing changed-file base for $relative. file-delta-v1 carries the complete target file and final SHA-256 is verified after apply."
                    [void]$acceptedBaseDrift.Add($relative)
                } else {
                    $installedHash = Get-Sha256File $currentTarget
                    if ($installedHash -ne $baseHash) {
                        Write-UpdateLog "Accepting changed-file base drift for $relative. file-delta-v1 carries the complete target file; persistent roots are excluded and the final target hash is verified."
                        [void]$acceptedBaseDrift.Add($relative)
                    }
                }
            } elseif (Test-Path $currentTarget) {
                Write-UpdateLog "Accepting pre-existing changed-file target for $relative. file-delta-v1 will transactionally replace it with the manifest-pinned target file."
                [void]$acceptedBaseDrift.Add($relative)
            }
            [void]$changedPaths.Add($relative)
        }
        $deletedPaths = New-Object System.Collections.Generic.List[string]
        foreach ($entry in @($delta.deletedFiles)) {
            $relative = ConvertTo-SafeRelativePath ([string]$entry.path)
            $currentTarget = Join-Path $Root ($relative.Replace('/','\'))
            if (Test-Path $currentTarget -PathType Leaf) {
                $installedHash = Get-Sha256File $currentTarget
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
            acceptedBaseDrift = @($acceptedBaseDrift)
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
            acceptedBaseDrift = @($acceptedBaseDrift)
            releaseUrl = [string]$Latest.release.html_url
        }
    } catch {
        Write-UpdateLog "Incremental staging failed: $($_.Exception.Message)"
        Write-UpdateProgress -Phase "fallback" -Message "Incremental staging failed; preparing full-package fallback: $($_.Exception.Message)"
        Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
        throw
    }
}

function Stage-IncrementalChainUpdate([object]$Latest, [object]$Plan) {
    $steps = @($Plan.steps)
    if ($steps.Count -lt 2) { throw "Incremental chain requires at least two steps." }
    New-Item -ItemType Directory -Force -Path $UpdateRoot | Out-Null
    $stage = Join-Path $UpdateRoot ("{0}-chain-{1}" -f $Latest.version, [guid]::NewGuid().ToString("N"))
    $stepsRoot = Join-Path $stage "steps"
    New-Item -ItemType Directory -Force -Path $stage,$stepsRoot | Out-Null
    $stagedSteps = New-Object System.Collections.ArrayList
    $expectedFrom = $CurrentVersion
    $receivedTotal = [int64]0
    try {
        for ($index = 0; $index -lt $steps.Count; $index++) {
            $step = $steps[$index]
            $manifest = $step.manifest
            $asset = $step.asset
            $fromVersion = [string]$manifest.fromVersion
            $toVersion = [string]$manifest.toVersion
            if ($fromVersion -ne $expectedFrom) {
                throw "Incremental chain is discontinuous: expected $expectedFrom, received $fromVersion -> $toVersion."
            }
            $stepDirectory = Join-Path $stepsRoot ("{0:D3}-{1}-to-{2}" -f ($index + 1), $fromVersion, $toVersion)
            $payload = Join-Path $stepDirectory "payload"
            $zip = Join-Path $stepDirectory ([string]$manifest.name)
            New-Item -ItemType Directory -Force -Path $stepDirectory,$payload | Out-Null
            Write-UpdateLog "Downloading incremental chain step $($index + 1)/$($steps.Count): $fromVersion -> $toVersion."
            Write-UpdateProgress -Phase "downloading" -Message "Downloading incremental step $($index + 1)/$($steps.Count): $fromVersion -> $toVersion" -BytesReceived $receivedTotal -BytesTotal ([int64]$Plan.totalBytes)
            Invoke-GitHubDownload `
                -Uri ([string]$asset.browser_download_url) `
                -Headers @{ "User-Agent" = "DevSpace-Portable-Updater/$CurrentVersion" } `
                -OutFile $zip `
                -TimeoutSec 1800 `
                -Description "Incremental chain package $($manifest.name)" `
                -ExpectedBytes ([int64]$manifest.size)
            $actualSize = (Get-Item -LiteralPath $zip).Length
            if ($actualSize -ne [int64]$manifest.size) {
                throw "Downloaded incremental chain ZIP size mismatch for $($manifest.name)."
            }
            $actualHash = Get-Sha256File $zip
            if ($actualHash -ne ([string]$manifest.sha256).ToLowerInvariant()) {
                throw "Downloaded incremental chain ZIP SHA-256 mismatch for $($manifest.name)."
            }
            $receivedTotal += $actualSize

            Add-Type -AssemblyName System.IO.Compression.FileSystem
            $archive = [System.IO.Compression.ZipFile]::OpenRead($zip)
            try {
                foreach ($entry in $archive.Entries) {
                    $name = ([string]$entry.FullName).Replace('\','/')
                    if (-not $name.StartsWith("DevSpacePortableDelta/", [StringComparison]::Ordinal)) {
                        throw "Incremental archive entry is outside DevSpacePortableDelta/: $name"
                    }
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
            if (-not (Test-Path $deltaManifestFile)) { throw "Incremental chain package has no delta-manifest.json." }
            $delta = Get-Content -LiteralPath $deltaManifestFile -Raw | ConvertFrom-Json
            if ([string]$delta.format -ne "file-delta-v1") { throw "Unsupported incremental chain format." }
            if ([string]$delta.fromVersion -ne $fromVersion -or [string]$delta.toVersion -ne $toVersion) {
                throw "Incremental chain package metadata does not match the selected Release edge."
            }
            $filesRoot = Join-Path $deltaRoot "files"
            $changedPaths = New-Object System.Collections.Generic.List[string]
            foreach ($entry in @($delta.changedFiles)) {
                $relative = ConvertTo-SafeRelativePath ([string]$entry.path)
                $source = Join-Path $filesRoot ($relative.Replace('/','\'))
                if (-not (Test-Path $source -PathType Leaf)) { throw "Incremental chain package is missing changed file: $relative" }
                if ((Get-Item -LiteralPath $source).Length -ne [int64]$entry.size) { throw "Incremental chain file size mismatch: $relative" }
                $sourceHash = Get-Sha256File $source
                if ($sourceHash -ne ([string]$entry.sha256).ToLowerInvariant()) { throw "Incremental chain file SHA-256 mismatch: $relative" }
                [void]$changedPaths.Add($relative)
            }
            $deletedPaths = New-Object System.Collections.Generic.List[string]
            foreach ($entry in @($delta.deletedFiles)) {
                [void]$deletedPaths.Add((ConvertTo-SafeRelativePath ([string]$entry.path)))
            }
            [void]$stagedSteps.Add([pscustomobject]@{
                fromVersion = $fromVersion
                toVersion = $toVersion
                zipName = [string]$manifest.name
                zipSize = $actualSize
                zipSha256 = $actualHash
                payloadRoot = $filesRoot
                deltaManifestPath = $deltaManifestFile
                changedFiles = @($changedPaths)
                deletedFiles = @($deletedPaths)
            })
            $expectedFrom = $toVersion
        }
        if ($expectedFrom -ne [string]$Latest.version) {
            throw "Incremental chain ends at $expectedFrom instead of $($Latest.version)."
        }
        Copy-Item -LiteralPath $PSCommandPath -Destination (Join-Path $stage "portable-updater.ps1") -Force
        $stageInfo = [ordered]@{
            formatVersion = 2
            currentVersion = $CurrentVersion
            targetVersion = $Latest.version
            repository = $Repository
            updateMode = "incremental-chain"
            stagedAt = (Get-Date).ToUniversalTime().ToString("o")
            zipSize = $receivedTotal
            chainLength = $stagedSteps.Count
            steps = @($stagedSteps)
        }
        $stageInfo | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $stage "stage-info.json") -Encoding UTF8
        Write-UpdateLog "Incremental chain $CurrentVersion -> $($Latest.version) staged successfully with $($stagedSteps.Count) steps."
        Write-UpdateProgress -Phase "staged" -Message "Incremental chain downloaded, verified, and staged" -BytesReceived $receivedTotal -BytesTotal ([int64]$Plan.totalBytes)
        return [pscustomobject]@{
            currentVersion = $CurrentVersion
            latestVersion = $Latest.version
            updateAvailable = $true
            staged = $true
            updateMode = "incremental-chain"
            stagingPath = $stage
            assetSize = $receivedTotal
            chainLength = $stagedSteps.Count
            chain = @($stagedSteps | ForEach-Object { "$($_.fromVersion)->$($_.toVersion)" })
            fullFallbackSize = [int64]$Latest.manifest.asset.size
            releaseUrl = [string]$Latest.release.html_url
        }
    } catch {
        Write-UpdateLog "Incremental chain staging failed: $($_.Exception.Message)"
        Write-UpdateProgress -Phase "fallback" -Message "Incremental chain failed; preparing full-package fallback: $($_.Exception.Message)"
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
    if ($ForceFull) {
        $reason = "Forced full-package fallback after a previous differential/incremental apply failure."
        Write-UpdateLog $reason
        return Stage-FullUpdate $latest $reason
    }

    $blockmapFailure = ""
    try {
        $blockmap = Get-BlockmapCandidate $latest
        if ($blockmap) {
            try {
                return Stage-BlockmapUpdate $latest $blockmap
            } catch {
                $blockmapFailure = $_.Exception.Message
                Write-UpdateLog "Blockmap differential update cannot be used; trying the legacy incremental compatibility path: $blockmapFailure"
            }
        }
    } catch {
        $blockmapFailure = $_.Exception.Message
        Write-UpdateLog "Blockmap Release metadata cannot be used; trying the legacy incremental compatibility path: $blockmapFailure"
    }

    $plan = $null
    try { $plan = Get-IncrementalUpdatePlan $latest }
    catch {
        $reason = $_.Exception.Message
        if ($blockmapFailure) { $reason = "Blockmap: $blockmapFailure Legacy incremental: $reason" }
        Write-UpdateLog "Incremental release metadata cannot be used; automatically falling back to the full package: $reason"
        return Stage-FullUpdate $latest $reason
    }
    if ($plan) {
        try {
            $steps = @($plan.steps)
            if ($steps.Count -eq 1) {
                return Stage-IncrementalUpdate $latest $steps[0]
            }
            return Stage-IncrementalChainUpdate $latest $plan
        } catch {
            $reason = $_.Exception.Message
            if ($blockmapFailure) { $reason = "Blockmap: $blockmapFailure Legacy incremental: $reason" }
            Write-UpdateLog "Incremental update cannot be used; automatically falling back to the full package: $reason"
            return Stage-FullUpdate $latest $reason
        }
    }
    $reason = "No incremental package matches installed version $CurrentVersion."
    if ($blockmapFailure) { $reason = "Blockmap: $blockmapFailure $reason" }
    return Stage-FullUpdate $latest $reason
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

function Stop-PortableBeforeApply {
    try {
        $output = Invoke-WithRetry -Description "Portable pre-update stop" -Attempts 3 -Operation {
            Invoke-Manager "stop"
        }
        Write-UpdateLog "Portable pre-update stop completed successfully."
        return $output
    } catch {
        # Never begin moving program files after a failed stop. The old updater
        # ignored this failure and could continue into locked directories,
        # turning a recoverable stop problem into a partially applied full
        # package plus a fragile rollback.
        $message = $_.Exception.Message
        Write-UpdateLog "Portable pre-update stop failed; no program files were changed: $message"
        throw "Portable could not be stopped safely before the update. No program files were changed. $message"
    }
}

function Repair-PortableTasksAndStart([switch]$IgnoreFailure) {
    $result = [ordered]@{
        success = $false
        tasks = ""
        services = ""
        error = ""
    }
    try {
        # Task definitions are executable deployment state, not durable user
        # data. Recreate them after every program-file transaction so a missing,
        # stale, or externally cleaned task cannot leave an otherwise valid
        # update in a half-applied state.
        $result.tasks = Invoke-Manager "install-tasks"
        $result.services = Invoke-Manager "start"
        $result.success = $true
    } catch {
        $result.error = $_.Exception.Message
        if (-not $IgnoreFailure) { throw }
    }
    return [pscustomobject]$result
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
    if (@("full", "blockmap", "incremental", "incremental-chain") -notcontains $updateMode) { throw "Unsupported staged update mode: $updateMode" }
    $payloadRoot = ""
    if ($updateMode -ne "incremental-chain") {
        $payloadRoot = [IO.Path]::GetFullPath([string]$stageInfo.payloadRoot).TrimEnd('\')
        if (-not $payloadRoot.StartsWith(($stage + '\'), [StringComparison]::OrdinalIgnoreCase)) { throw "Staged payload path is invalid." }
    }
    $deltaManifest = $null
    $deltaSteps = New-Object System.Collections.ArrayList
    if ($updateMode -eq "full" -or $updateMode -eq "blockmap") {
        if (-not (Test-Path (Join-Path $payloadRoot "DevSpace-Portable.exe"))) { throw "Staged Portable executable is missing." }
    } elseif ($updateMode -eq "incremental") {
        $deltaManifestPath = [IO.Path]::GetFullPath([string]$stageInfo.deltaManifestPath)
        if (-not $deltaManifestPath.StartsWith(($stage + '\'), [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path $deltaManifestPath)) {
            throw "Staged incremental manifest path is invalid."
        }
        $deltaManifest = Get-Content -LiteralPath $deltaManifestPath -Raw | ConvertFrom-Json
        if ([string]$deltaManifest.fromVersion -ne $CurrentVersion -or [string]$deltaManifest.toVersion -ne $targetVersion) {
            throw "Staged incremental manifest version range is invalid."
        }
        [void]$deltaSteps.Add([pscustomobject]@{ manifest = $deltaManifest; payloadRoot = $payloadRoot })
    } else {
        $expectedFrom = $CurrentVersion
        foreach ($step in @($stageInfo.steps)) {
            $stepPayloadRoot = [IO.Path]::GetFullPath([string]$step.payloadRoot).TrimEnd('\')
            $stepManifestPath = [IO.Path]::GetFullPath([string]$step.deltaManifestPath)
            if (-not $stepPayloadRoot.StartsWith(($stage + '\'), [StringComparison]::OrdinalIgnoreCase)) {
                throw "Staged incremental-chain payload path is invalid."
            }
            if (-not $stepManifestPath.StartsWith(($stage + '\'), [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path $stepManifestPath)) {
                throw "Staged incremental-chain manifest path is invalid."
            }
            $stepManifest = Get-Content -LiteralPath $stepManifestPath -Raw | ConvertFrom-Json
            if ([string]$stepManifest.format -ne "file-delta-v1") { throw "Unsupported staged incremental-chain format." }
            if ([string]$stepManifest.fromVersion -ne $expectedFrom) {
                throw "Staged incremental chain is discontinuous at $expectedFrom."
            }
            if ([string]$stepManifest.fromVersion -ne [string]$step.fromVersion -or [string]$stepManifest.toVersion -ne [string]$step.toVersion) {
                throw "Staged incremental-chain step metadata is inconsistent."
            }
            [void]$deltaSteps.Add([pscustomobject]@{ manifest = $stepManifest; payloadRoot = $stepPayloadRoot })
            $expectedFrom = [string]$stepManifest.toVersion
        }
        if ($deltaSteps.Count -lt 2 -or $expectedFrom -ne $targetVersion) {
            throw "Staged incremental chain does not reach $targetVersion."
        }
    }

    # The Portable manager intentionally terminates processes whose executable
    # or command line belongs to this installation. Exclude this detached
    # controller and its child manager process so the transactional update can
    # finish after stopping every other Portable-owned process.
    $env:DEVSPACE_STOP_EXCLUDE_PID = [string]$PID

    if (-not [string]::IsNullOrWhiteSpace($LaunchAckPath)) {
        $ack = [IO.Path]::GetFullPath($LaunchAckPath)
        if (-not $ack.StartsWith(($stage + '\'), [StringComparison]::OrdinalIgnoreCase)) {
            throw "LaunchAckPath is outside the staged update directory."
        }
        $ackValue = [ordered]@{
            acknowledged = $true
            updaterPid = $PID
            currentVersion = $CurrentVersion
            targetVersion = $targetVersion
            updateMode = $updateMode
            stagingPath = $stage
            acknowledgedAt = (Get-Date).ToUniversalTime().ToString("o")
        }
        $ackTemp = "$ack.tmp-$PID"
        $ackValue | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $ackTemp -Encoding UTF8
        Move-Item -LiteralPath $ackTemp -Destination $ack -Force
        Write-UpdateLog "Detached updater launch acknowledged by PID $PID for $CurrentVersion -> $targetVersion."
        Write-UpdateProgress -Phase "apply-started" -Message "Detached updater is running and waiting for the control center to close"
    }

    if ($UiPid -gt 0) {
        Write-UpdateLog "Waiting for native UI PID $UiPid to exit before applying $targetVersion."
        Wait-Process -Id $UiPid -Timeout 90 -ErrorAction SilentlyContinue
    }

    $shouldRestartServices = (Test-Path (Join-Path $Root "data\config\config.json")) -and (Test-Path (Join-Path $Root "data\config\auth.json"))
    Write-UpdateProgress -Phase "applying" -Message "Stopping Portable-owned processes before applying $targetVersion"
    Write-UpdateLog "Stopping Portable services before applying $targetVersion."
    Stop-PortableBeforeApply | Out-Null

    $backup = Join-Path $Root (".update-backup-{0}-{1}" -f $targetVersion, [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Force -Path $backup | Out-Null
    $movedOld = New-Object System.Collections.Generic.List[string]
    $movedNew = New-Object System.Collections.Generic.List[string]
    $backedOriginals = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    $installedDuringUpdate = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    try {
        Write-UpdateProgress -Phase "applying" -Message "Applying DevSpace Portable $targetVersion program files"

        if ($updateMode -eq "incremental" -or $updateMode -eq "incremental-chain") {
            $stepIndex = 0
            foreach ($deltaStep in @($deltaSteps)) {
                $stepIndex++
                $stepManifest = $deltaStep.manifest
                $stepPayloadRoot = [string]$deltaStep.payloadRoot
                Write-UpdateLog "Applying incremental step $stepIndex/$($deltaSteps.Count): $($stepManifest.fromVersion) -> $($stepManifest.toVersion)."
                foreach ($entry in @($stepManifest.changedFiles)) {
                    $relative = ConvertTo-SafeRelativePath ([string]$entry.path)
                    $relativeWindows = $relative.Replace('/','\')
                    $source = Join-Path $stepPayloadRoot $relativeWindows
                    $target = Join-Path $Root $relativeWindows
                    $backupTarget = Join-Path $backup $relativeWindows
                    if (-not (Test-Path $source -PathType Leaf)) { throw "Staged changed file disappeared before apply: $relative" }
                    $sourceHash = Get-Sha256File $source
                    if ($sourceHash -ne ([string]$entry.sha256).ToLowerInvariant()) { throw "Staged changed file failed SHA-256 revalidation: $relative" }
                    if (Test-Path $target) {
                        if ($backedOriginals.Add($relative)) {
                            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $backupTarget) | Out-Null
                            Move-Item -LiteralPath $target -Destination $backupTarget -Force
                            [void]$movedOld.Add($relative)
                        } else {
                            Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction Stop
                        }
                    }
                    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
                    Move-Item -LiteralPath $source -Destination $target -Force
                    if ($installedDuringUpdate.Add($relative)) { [void]$movedNew.Add($relative) }
                }
                foreach ($entry in @($stepManifest.deletedFiles)) {
                    $relative = ConvertTo-SafeRelativePath ([string]$entry.path)
                    $relativeWindows = $relative.Replace('/','\')
                    $target = Join-Path $Root $relativeWindows
                    if (-not (Test-Path $target)) { continue }
                    $expectedBaseHash = ([string]$entry.baseSha256).ToLowerInvariant()
                    if ($expectedBaseHash -and (Test-Path $target -PathType Leaf)) {
                        $installedHash = Get-Sha256File $target
                        if ($installedHash -ne $expectedBaseHash) { throw "Incremental deleted file has local drift during apply: $relative" }
                    }
                    $backupTarget = Join-Path $backup $relativeWindows
                    if ($backedOriginals.Add($relative)) {
                        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $backupTarget) | Out-Null
                        Move-Item -LiteralPath $target -Destination $backupTarget -Force
                        [void]$movedOld.Add($relative)
                    } else {
                        Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction Stop
                    }
                }
                foreach ($entry in @($stepManifest.changedFiles)) {
                    $relative = ConvertTo-SafeRelativePath ([string]$entry.path)
                    $target = Join-Path $Root ($relative.Replace('/','\'))
                    if (-not (Test-Path $target -PathType Leaf)) { throw "Incremental target file is missing after apply: $relative" }
                    $targetHash = Get-Sha256File $target
                    if ($targetHash -ne ([string]$entry.sha256).ToLowerInvariant()) { throw "Incremental target file failed SHA-256 validation: $relative" }
                }
                $stepVersionManifest = Get-Content -LiteralPath (Join-Path $Root "VERSION-MANIFEST.json") -Raw | ConvertFrom-Json
                if ([string]$stepVersionManifest.runtime.devspacePortable -ne [string]$stepManifest.toVersion) {
                    throw "Incremental step did not produce expected Portable version $($stepManifest.toVersion)."
                }
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
        $taskOutput = "Portable is not configured; task reconciliation was skipped."
        $startOutput = "Portable is not configured; service restart was skipped."
        $servicesRecovered = -not $shouldRestartServices
        $serviceRecoveryError = ""
        if ($shouldRestartServices) {
            # Program-file replacement is the update transaction. Task/tunnel
            # recovery happens after the new manifest has already been
            # validated and must not roll back a valid installation merely
            # because the current network path, tunnel provider, or task host
            # is temporarily unavailable.
            $serviceRecovery = Repair-PortableTasksAndStart -IgnoreFailure
            $taskOutput = [string]$serviceRecovery.tasks
            $startOutput = [string]$serviceRecovery.services
            $servicesRecovered = [bool]$serviceRecovery.success
            $serviceRecoveryError = [string]$serviceRecovery.error
            if (-not $servicesRecovered) {
                Write-UpdateLog "Program files were updated successfully, but post-update service recovery is incomplete: $serviceRecoveryError"
            }
        }
        $uiStarted = $false
        $uiStartError = ""
        try {
            Start-Process -FilePath (Join-Path $Root "DevSpace-Portable.exe") -WorkingDirectory $Root
            $uiStarted = $true
        } catch {
            # The program transaction and service recovery already succeeded.
            # A shell/UI launch failure must not roll the installed version back.
            $uiStartError = $_.Exception.Message
            Write-UpdateLog "Update completed, but the control center could not be started automatically: $uiStartError"
        }
        $result = [ordered]@{
            success = $true
            version = $targetVersion
            updateMode = $updateMode
            appliedAt = (Get-Date).ToUniversalTime().ToString("o")
            tasks = $taskOutput
            services = $startOutput
            servicesRecovered = $servicesRecovered
            serviceRecoveryError = $serviceRecoveryError
            uiStarted = $uiStarted
            uiStartError = $uiStartError
            backupRemoved = $true
        }
        Write-UpdateResult $result
        Write-UpdateLog "Update $targetVersion program files applied successfully. servicesRecovered=$servicesRecovered"
        $completionMessage = if ($servicesRecovered) {
            "DevSpace Portable $targetVersion update completed"
        } else {
            "DevSpace Portable $targetVersion files updated; service recovery needs attention"
        }
        Write-UpdateProgress -Phase "completed" -Message $completionMessage
        Remove-TransientUpdateTask
        Remove-Item -LiteralPath $backup -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
        return $result
    } catch {
        $originalError = $_
        $message = $originalError.Exception.Message
        Write-UpdateLog "Update apply failed; restoring previous version: $message"
        Write-UpdateProgress -Phase "rollback" -Message "Update failed; restoring the previous version: $message"
        $rollbackErrors = New-Object System.Collections.Generic.List[string]
        try { Invoke-Manager "stop" -IgnoreFailure | Out-Null }
        catch { [void]$rollbackErrors.Add("Unable to stop the partially updated runtime: $($_.Exception.Message)") }
        foreach ($name in $movedNew) {
            try {
                $newTarget = Join-Path $Root $name
                if (Test-Path -LiteralPath $newTarget) {
                    Remove-Item -LiteralPath $newTarget -Recurse -Force -ErrorAction Stop
                }
            } catch {
                [void]$rollbackErrors.Add("Unable to remove partially applied path ${name}: $($_.Exception.Message)")
            }
        }
        foreach ($name in $movedOld) {
            $source = Join-Path $backup $name
            try {
                if (-not (Test-Path -LiteralPath $source)) {
                    throw "Backup path is missing: $source"
                }
                $destination = Join-Path $Root $name
                New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
                Move-Item -LiteralPath $source -Destination $destination -Force -ErrorAction Stop
            } catch {
                [void]$rollbackErrors.Add("Unable to restore ${name}: $($_.Exception.Message)")
            }
        }
        $filesRestored = $rollbackErrors.Count -eq 0
        $servicesRecovered = -not $shouldRestartServices
        $serviceRecoveryError = ""
        if ($filesRestored -and $shouldRestartServices) {
            $rollbackServiceRecovery = Repair-PortableTasksAndStart -IgnoreFailure
            $servicesRecovered = [bool]$rollbackServiceRecovery.success
            $serviceRecoveryError = [string]$rollbackServiceRecovery.error
            if (-not $servicesRecovered) {
                [void]$rollbackErrors.Add("Previous-version tasks or services could not be recovered: $serviceRecoveryError")
            }
        }
        $rollbackUiStarted = $false
        if ($filesRestored -and (Test-Path (Join-Path $Root "DevSpace-Portable.exe"))) {
            try {
                Start-Process -FilePath (Join-Path $Root "DevSpace-Portable.exe") -WorkingDirectory $Root
                $rollbackUiStarted = $true
            } catch {
                [void]$rollbackErrors.Add("Previous control center could not be started automatically: $($_.Exception.Message)")
            }
        }
        $result = [ordered]@{
            success = $false
            version = $targetVersion
            updateMode = $updateMode
            failedAt = (Get-Date).ToUniversalTime().ToString("o")
            error = $message
            rolledBack = $filesRestored
            servicesRecovered = $servicesRecovered
            serviceRecoveryError = $serviceRecoveryError
            uiStarted = $rollbackUiStarted
            rollbackErrors = @($rollbackErrors)
            backupPath = $backup
        }
        Write-UpdateResult $result
        if ($rollbackErrors.Count -gt 0) {
            $rollbackMessage = $rollbackErrors -join "; "
            Write-UpdateLog "Rollback completed with errors: $rollbackMessage"
            throw "${message} Rollback diagnostics: $rollbackMessage"
        }
        Write-UpdateLog "Previous version, scheduled tasks, and service state were restored after the failed update."
        throw $originalError
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
    $failureMessage = $_.Exception.Message
    Write-UpdateLog "$Action failed: $failureMessage"
    if ($_.ScriptStackTrace) { Write-UpdateLog "Updater stack: $($_.ScriptStackTrace)" }
    Write-UpdateProgress -Phase "error" -Message "$Action failed: $failureMessage"
    if ($Action -eq "Apply") { Remove-TransientUpdateTask }
    Write-JsonResult ([ordered]@{
        success = $false
        action = $Action
        error = $failureMessage
    })
    Write-Error $_ -ErrorAction Continue
    # Older Update.exe builds selected only the last stderr line. Keep a
    # concise final line so upgrades into this release expose the real cause
    # instead of PowerShell's FullyQualifiedErrorId metadata.
    [Console]::Error.WriteLine("DevSpace update error: $failureMessage")
    exit 1
}
