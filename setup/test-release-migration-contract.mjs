import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workflow = readFileSync(join(root, ".github", "workflows", "release.yml"), "utf8");

assert.match(workflow, /steps\.version\.outputs\.version == '1\.1\.40'/);
assert.match(workflow, /steps\.version\.outputs\.version == '1\.1\.41'/);
for (let patch = 32; patch <= 39; patch += 1) {
  const version = `1.1.${patch}`;
  assert.ok(workflow.includes(`"${version}"`), `legacy migration base missing: ${version}`);
  assert.ok(
    workflow.includes('DevSpacePortable-Update-$baseVersion-to-$env:VERSION.zip'),
    "migration delta naming contract is missing",
  );
}
assert.match(workflow, /MIGRATION_BASE_DIR/);
assert.match(workflow, /DevSpacePortable-Rescue-1\.1\.33-to-\$env:VERSION\.zip/);
assert.match(workflow, /DevSpacePortable-Update-1\.1\.40-to-1\.1\.41\.zip/);
assert.match(workflow, /1\.1\.41 release requires v1\.1\.40 as the previous stable base/);
assert.match(workflow, /After the 1\.1\.41 stable compatibility Release/);
assert.match(workflow, /DevSpacePortable-Update-\$env:BASE_VERSION-to-\$env:VERSION\.zip/);
assert.match(workflow, /create-update-manifest\.py @manifestArgs/);
assert.match(workflow, /BASE_UPDATE_MANIFEST/);
assert.match(workflow, /--carry-forward-manifest/);
assert.doesNotMatch(workflow, /git add .*DevSpacePortable-Update/);

console.log(JSON.stringify({
  migrationCheckpoint: "1.1.40",
  stableCompatibilityRelease: "1.1.41",
  legacyExactMigrationBases: 8,
  stableReleaseCurrentEdges: 9,
  releaseAssetsOnly: true,
  futureAdjacentDeltaOnlyAfterStableCompatibilityRelease: true,
  carryForwardGraphManifest: true,
  legacy113RescueOnCompatibilityReleases: true,
}));
