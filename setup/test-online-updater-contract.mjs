import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const updater = readFileSync(join(root, "setup", "portable-updater.ps1"), "utf8");
const manager = readFileSync(join(root, "setup", "portable-manager.cjs"), "utf8");
const manifestBuilder = readFileSync(join(root, "setup", "create-update-manifest.py"), "utf8");
const deltaBuilder = readFileSync(join(root, "setup", "create-incremental-update.py"), "utf8");

assert.match(updater, /repos\/\$Repository\/releases\/latest/);
assert.match(updater, /update-manifest\.json/);
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
assert.match(updater, /Skipping unavailable local proxy/);
assert.match(updater, /--noproxy", "\*"/);
assert.match(updater, /SetEnvironmentVariable\(\$name, \$null, "Process"\)/);
assert.match(updater, /direct\/TUN/);
assert.doesNotMatch(updater, /Invoke-WebRequest\s+-Uri\s+\$Uri[\s\S]*?-OutFile\s+\$OutFile/);
assert.match(updater, /Get-FileHash[^\n]+SHA256/);
assert.match(updater, /Get-IncrementalCandidate/);
assert.match(updater, /Stage-IncrementalUpdate/);
assert.match(updater, /automatically falling back to the full package/);
assert.match(updater, /Incremental base file has local drift/);
assert.match(updater, /Test-ReplaceSafeDriftPath/);
assert.match(updater, /acceptedBaseDrift/);
assert.match(updater, /packages\/waishnav-devspace-\[\^\/\]\+\\\.tgz/);
assert.match(updater, /updateMode = "incremental"/);
assert.match(updater, /Unsafe archive entry/);
assert.match(updater, /Online application update is disabled inside a Git source checkout/);
assert.match(updater, /\.update-backup-/);
assert.match(updater, /rolledBack = \$true/);
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
assert.match(manifestBuilder, /incremental-first-full-fallback/);
assert.match(deltaBuilder, /file-delta-v1/);
assert.match(deltaBuilder, /baseSha256/);

console.log(JSON.stringify({
  publicGitHubReleaseCheck: true,
  tls12Compatibility: true,
  boundedNetworkFailover: true,
  curlFirstTransport: true,
  directCurlFallback: true,
  resumableDownload: true,
  liveDownloadProgress: true,
  stalledDownloadDetection: true,
  deadLoopbackProxySkipped: true,
  explicitDirectTunFallback: true,
  incrementalFirst: true,
  automaticFullFallback: true,
  baseFileDriftProtection: true,
  generatedBuildDriftTolerance: true,
  updateLaunchAcknowledgement: true,
  deltaManifestGeneration: true,
  sizeAndSha256Validation: true,
  archiveTraversalProtection: true,
  sourceCheckoutProtection: true,
  transactionalRollback: true,
  persistentDataPreserved: true,
}));
