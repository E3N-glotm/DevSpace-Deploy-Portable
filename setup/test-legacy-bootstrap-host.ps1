param([Parameter(Mandatory=$true)][string]$FixtureRoot)
$ErrorActionPreference = "Stop"
$fixture = Get-Content -LiteralPath (Join-Path $FixtureRoot "fixtures.json") -Raw | ConvertFrom-Json
Add-Type -AssemblyName System.IO.Compression.FileSystem
foreach ($version in @("1.1.36", "1.1.49", "1.1.58")) {
    $tokens = $null
    $errors = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $FixtureRoot "v$version.ps1"), [ref]$tokens, [ref]$errors)
    if ($errors.Count) { throw "Historical updater parse failed: $version" }
    $functions = $ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $true)
    foreach ($name in @("Get-IncrementalCandidate", "Resolve-IncrementalGraphPlan")) {
        $definition = $functions | Where-Object { $_.Name -eq $name } | Select-Object -First 1
        if ($definition) { . ([scriptblock]::Create($definition.Extent.Text)) }
    }
    # Only pure planner functions execute; no old updater startup/side effects.
    $CurrentVersion = $version
    $direct = Get-IncrementalCandidate $fixture.baseline
    if (-not $direct -or $direct.manifest.toVersion -ne "1.1.60") { throw "Missing baseline route: $version" }
    if ($version -eq "1.1.36") {
        $futureDirect = Get-IncrementalCandidate $fixture.future
        if (-not $futureDirect) { throw "Direct-only legacy updater lost its future route." }
    } else {
        $plan = Resolve-IncrementalGraphPlan @($fixture.edges) "1.1.61"
        if (-not $plan -or @($plan.steps).Count -ne 2) { throw "Historical two-hop route failed: $version" }
    }
    $archive = Join-Path $FixtureRoot $direct.manifest.name
    $destination = Join-Path $FixtureRoot ("extract-$version-" + ('d' * 75))
    [IO.Compression.ZipFile]::ExtractToDirectory($archive, $destination)
    $payload = Join-Path $destination "DevSpacePortableDelta\files"
    if (-not (Test-Path (Join-Path $payload "setup\legacy-upgrade-bootstrap.json"))) { throw "Old .NET extraction failed: $version" }
    Write-Output "PASS historical ${version}: baseline selection, future route, shallow .NET extraction"
}
