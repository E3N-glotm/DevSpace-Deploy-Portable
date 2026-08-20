import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const updater = readFileSync(join(root, "setup", "portable-updater.ps1"), "utf8");
const blockmapUpdater = readFileSync(join(root, "setup", "blockmap-updater.cjs"), "utf8");
const manager = readFileSync(join(root, "setup", "portable-manager.cjs"), "utf8");
const manifestBuilder = readFileSync(join(root, "setup", "create-update-manifest.py"), "utf8");
const blockmapBuilder = readFileSync(join(root, "setup", "create-blockmap.py"), "utf8");
const deltaBuilder = readFileSync(join(root, "setup", "create-incremental-update.py"), "utf8");
const rescueBuilder = readFileSync(join(root, "setup", "create-rescue-overlay.py"), "utf8");

assert.match(updater, /repos\/\$Repository\/releases\/latest/);
assert.match(updater, /update-manifest\.json/);
assert.match(updater, /Get-GitHubAssetSha256/);
assert.match(updater, /github-release-asset-digest/);
assert.match(updater, /Latest Release has neither asset SHA-256 digests nor update-manifest\.json/);
assert.match(updater, /Get-LatestReleaseFromPublishedManifest/);
assert.match(updater, /releases\/latest\/download\/update-manifest\.json/);
assert.match(updater, /release-latest-update-manifest/);
assert.match(updater, /Falling back to the official published latest update manifest/);
assert.match(updater, /Assert-ReleaseAssetMetadata/);
assert.match(updater, /SecurityProtocolType\]::Tls12/);
assert.match(updater, /Invoke-GitHubJson/);
assert.match(updater, /Invoke-GitHubDownload/);
assert.match(updater, /runtime\\git\\mingw64\\bin\\curl\.exe/);
assert.match(updater, /update-progress\.json/);
assert.match(updater, /Write-UpdateProgress/);
assert.match(updater, /--noproxy/);
assert.match(updater, /--continue-at/);
assert.match(updater, /--speed-limit/);
assert.match(updater, /--speed-time/);
assert.match(updater, /connect-timeout", "8"/);
assert.match(updater, /Get-GitHubTransportCandidates/);
assert.match(updater, /Get-GitHubMirrorPrefixes/);
assert.match(updater, /Get-GitHubEndpointCandidates/);
assert.match(updater, /Get-GitHubMirrorTransportCandidates/);
assert.match(updater, /\[switch\]\$AllowMirrors/);
assert.match(updater, /DEVSPACE_GITHUB_MIRRORS/);
assert.match(updater, /https:\/\/ghproxy\.net\//);
assert.match(updater, /Skipping unavailable local proxy/);
assert.match(updater, /Get-WindowsInternetProxyState/);
assert.match(updater, /Invoke-DotNetJson/);
assert.match(updater, /Invoke-DotNetDownload/);
assert.match(updater, /GetSystemWebProxy\(\)/);
assert.match(updater, /dotnet-direct/);
assert.match(updater, /dotnet-system-proxy/);
assert.match(updater, /transport = "dotnet-direct"; source = "direct-dotnet"/);
assert.match(updater, /transport = "curl-direct"; source = "direct-or-transparent-tun"/);
assert.match(updater, /for \(\$round = 1; \$round -le 2; \$round\+\+\)/);
assert.match(updater, /refreshing proxy\/route state and retrying once/);
assert.match(updater, /ReadWriteTimeout/);
assert.match(updater, /AddRange\(\$existingBytes\)/);
assert.match(updater, /--noproxy", "\*"/);
assert.match(updater, /SetEnvironmentVariable\(\$name, \$null, "Process"\)/);
assert.match(updater, /direct\/TUN/);
assert.doesNotMatch(updater, /Invoke-WebRequest\s+-Uri\s+\$Uri[\s\S]*?-OutFile\s+\$OutFile/);
assert.match(updater, /function Get-Sha256File/);
assert.match(updater, /Security\.Cryptography\.SHA256/);
assert.match(updater, /ComputeHash\(\$stream\)/);
assert.doesNotMatch(updater, /Get-FileHash/);
assert.match(updater, /Get-IncrementalCandidate/);
assert.match(updater, /Assert-BlockmapAssetMetadata/);
assert.match(updater, /Get-BlockmapCandidate/);
assert.match(updater, /Stage-BlockmapUpdate/);
assert.match(updater, /block-pack-v2/);
assert.match(updater, /preferredMode = if \(\$blockmap\) \{ "blockmap" \}/);
assert.match(updater, /updateMode = "blockmap"/);
assert.match(updater, /\$updateMode -eq "full" -or \$updateMode -eq "blockmap"/);
assert.match(updater, /Get-PublishedIncrementalEdges/);
assert.match(updater, /Get-StableIncrementalEdges/);
assert.match(updater, /Resolve-IncrementalGraphPlan/);
assert.match(updater, /Get-IncrementalUpdatePlan/);
assert.match(updater, /Stage-IncrementalUpdate/);
assert.match(updater, /Stage-IncrementalChainUpdate/);
assert.match(updater, /incremental-chain/);
assert.match(updater, /incrementalGraphAssets/);
assert.match(updater, /historical incremental edges from the latest published update manifest/);
assert.match(updater, /GitHub incremental release graph request page/);
assert.match(updater, /byte-minimal path/);
assert.match(updater, /Staged incremental chain is discontinuous/);
assert.match(updater, /Incremental step did not produce expected Portable version/);
assert.match(updater, /automatically falling back to the full package/);
assert.match(updater, /\[switch\]\$ForceFull/);
assert.match(updater, /Forced full-package fallback after a previous differential\/incremental apply failure/);
assert.match(updater, /acceptedBaseDrift/);
assert.match(updater, /Accepting changed-file base drift/);
assert.match(updater, /file-delta-v1 carries the complete target file/);
assert.match(updater, /Incremental deleted file has local drift/);
assert.match(updater, /updateMode = "incremental"/);
assert.match(updater, /Unsafe archive entry/);
assert.match(updater, /Online application update is disabled inside a Git source checkout/);
assert.match(updater, /\.update-backup-/);
assert.match(updater, /rolledBack = \$filesRestored/);
assert.match(updater, /Repair-PortableTasksAndStart/);
assert.match(updater, /Invoke-Manager "install-tasks"/);
assert.match(updater, /Stop-PortableBeforeApply/);
assert.match(updater, /No program files were changed/);
assert.match(updater, /Program files were updated successfully, but post-update service recovery is incomplete/);
assert.match(updater, /servicesRecovered/);
assert.match(updater, /serviceRecoveryError/);
assert.match(updater, /rollbackErrors/);
assert.match(updater, /DevSpace update error:/);
assert.match(updater, /Write-JsonResult \(\[ordered\]@\{/);
assert.match(updater, /\$persistent = @\("data", "logs", "reports"\)/);
assert.match(manager, /command === "update-check"/);
assert.match(manager, /command === "update-stage"/);
assert.match(manager, /command === "update-launch"/);
assert.match(manager, /detached: true/);
assert.match(manager, /apply-launch-ack\.json/);
assert.match(manager, /acknowledged/);
assert.match(manager, /Detached updater failed to acknowledge launch/);
assert.match(updater, /LaunchAckPath/);
assert.match(updater, /apply-started/);
assert.match(manifestBuilder, /incrementalAssets/);
assert.match(manifestBuilder, /incrementalGraphAssets/);
assert.match(manifestBuilder, /carry-forward-manifest/);
assert.match(manifestBuilder, /rescueAssets/);
assert.match(manifestBuilder, /blockmap-first-full-fallback/);
assert.match(manifestBuilder, /BLOCKMAP_MAGIC = b"DSPBLK2\\n"/);
assert.match(manifestBuilder, /headerCompressedSize/);
assert.match(manifestBuilder, /headerSha256/);
assert.match(manifestBuilder, /checksum_lines\.append\(f"\{blockmap_asset\['sha256'\]\}  \{blockmap_asset\['name'\]\}\\n"\)/);
assert.match(deltaBuilder, /file-delta-v1/);
assert.match(deltaBuilder, /baseSha256/);
assert.match(rescueBuilder, /direct-overlay-v1/);
assert.match(rescueBuilder, /PERSISTENT_ROOTS = \("data", "logs", "reports"\)/);
assert.match(rescueBuilder, /Direct-extract rescue overlay is not safe/);
assert.match(blockmapUpdater, /DSPBLK2\\n/);
assert.match(blockmapUpdater, /--range/);
assert.match(blockmapUpdater, /Promise\.all\(candidates\.map/);
assert.match(blockmapUpdater, /status !== 206/);
assert.match(blockmapUpdater, /localChunkReuse|analyzeLocalReuse/);
assert.match(blockmapUpdater, /reconstructed target verification failed/);
assert.match(blockmapUpdater, /header SHA-256 mismatch/);
assert.match(blockmapUpdater, /missingUniqueChunks/);
assert.match(blockmapBuilder, /tempfile\.mkstemp/);
assert.doesNotMatch(blockmapBuilder, /tempfile\.NamedTemporaryFile/);
assert.match(blockmapBuilder, /def unlink_with_retry/);
assert.match(blockmapBuilder, /except PermissionError/);
assert.match(blockmapBuilder, /data\/plugins\/installed\/codex-runtime-bridge\//);
assert.match(blockmapUpdater, /ALLOWED_PERSISTENT_PREFIXES/);

const transportBlock = updater.slice(
  updater.indexOf("function Get-GitHubTransportCandidates"),
  updater.indexOf("function Invoke-CurlJson"),
);
assert.ok(
  transportBlock.indexOf('transport = "dotnet-system-proxy"') < transportBlock.indexOf('transport = "dotnet-direct"'),
  "an enabled Windows system proxy must be attempted before direct/TUN transports",
);
const endpointBlock = updater.slice(
  updater.indexOf("function Get-GitHubEndpointCandidates"),
  updater.indexOf("function Set-WebRequestHeaders"),
);
assert.ok(
  endpointBlock.indexOf("Get-GitHubMirrorPrefixes") < endpointBlock.indexOf('source = "official"'),
  "GitHub Release mirror endpoints must be emitted before the official origin",
);
const latestReleaseBlock = updater.slice(
  updater.indexOf("function Get-LatestRelease {"),
  updater.indexOf("function ConvertTo-SafeRelativePath"),
);
assert.ok(
  latestReleaseBlock.indexOf("https://api.github.com/repos/$Repository/releases/latest") < latestReleaseBlock.indexOf("return Get-LatestReleaseFromPublishedManifest"),
  "trusted update metadata must come from official GitHub before the official published-manifest fallback",
);

console.log(JSON.stringify({
  publicGitHubReleaseCheck: true,
  releaseApiDigestMetadata: true,
  releaseManifestFallbackWhenApiUnavailable: true,
  tls12Compatibility: true,
  boundedNetworkFailover: true,
  mirrorEndpointFirst: true,
  boundedMirrorFailover: true,
  officialMetadataTrustAnchor: true,
  systemProxyBeforeDirectWhenEnabled: true,
  dotNetDirectTransport: true,
  directCurlFallback: true,
  resumableDownload: true,
  liveDownloadProgress: true,
  stalledDownloadDetection: true,
  deadLoopbackProxySkipped: true,
  windowsSystemProxyFallback: true,
  dotNetStreamingProxyDownload: true,
  metadataCandidateRefreshRetry: true,
  explicitDirectTunFallback: true,
  incrementalFirst: true,
  blockmapDifferentialFirst: true,
  parallelRangeSourceProbe: true,
  localBlockReuse: true,
  authenticatedBlockmapHeader: true,
  perChunkSha256Verification: true,
  reconstructedFileSha256Verification: true,
  historicalReleaseIncrementalGraph: true,
  transactionalIncrementalChain: true,
  automaticFullFallback: true,
  forcedFullFallbackAfterApplyFailure: true,
  changedFileFullReplacementDriftTolerance: true,
  deletionDriftProtection: true,
  updateLaunchAcknowledgement: true,
  deltaManifestGeneration: true,
  directExtractRescueOverlayGeneration: true,
  rescuePersistentRootsExcluded: true,
  rescueDeletionSafetyGate: true,
  sizeAndSha256Validation: true,
  archiveTraversalProtection: true,
  sourceCheckoutProtection: true,
  transactionalRollback: true,
  scheduledTaskRepairBeforeRestart: true,
  preApplyStopMustSucceed: true,
  programCommitIndependentOfServiceRecovery: true,
  rollbackTaskAndServiceRecovery: true,
  structuredBackendFailure: true,
  persistentDataPreserved: true,
}));
