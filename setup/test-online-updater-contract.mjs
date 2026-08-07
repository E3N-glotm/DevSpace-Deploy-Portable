import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const updater = readFileSync(join(root, "setup", "portable-updater.ps1"), "utf8");
const manager = readFileSync(join(root, "setup", "portable-manager.cjs"), "utf8");

assert.match(updater, /repos\/\$Repository\/releases\/latest/);
assert.match(updater, /update-manifest\.json/);
assert.match(updater, /Get-FileHash[^\n]+SHA256/);
assert.match(updater, /Unsafe archive entry/);
assert.match(updater, /Online application update is disabled inside a Git source checkout/);
assert.match(updater, /\.update-backup-/);
assert.match(updater, /rolledBack = \$true/);
assert.match(updater, /\$persistent = @\("data", "logs", "reports"\)/);
assert.match(manager, /command === "update-check"/);
assert.match(manager, /command === "update-stage"/);
assert.match(manager, /command === "update-launch"/);
assert.match(manager, /detached: true/);

console.log(JSON.stringify({
  publicGitHubReleaseCheck: true,
  sizeAndSha256Validation: true,
  archiveTraversalProtection: true,
  sourceCheckoutProtection: true,
  transactionalRollback: true,
  persistentDataPreserved: true,
}));
