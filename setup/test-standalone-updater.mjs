import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const updaterSource = readFileSync(join(root, "setup", "native", "DevSpaceUpdaterApp.cs"), "utf8");
const mainSource = readFileSync(join(root, "setup", "native", "DevSpacePortableApp.cs"), "utf8");
const buildSource = readFileSync(join(root, "setup", "build-native-ui.cjs"), "utf8");
const updaterExe = join(root, "Update.exe");

assert.match(buildSource, /DevSpaceUpdaterApp\.cs/);
assert.match(buildSource, /Update\.exe/);
assert.match(updaterSource, /--apply-helper/);
assert.match(updaterSource, /Path\.GetTempPath\(\), "DevSpacePortableUpdater"/);
assert.match(updaterSource, /CloseValidatedParentUiAsync/);
assert.match(updaterSource, /parent-ui PID 已被其他程序复用/);
assert.match(updaterSource, /_handoffToApply = true/);
assert.match(updaterSource, /_busy && !_handoffToApply && !_allowBusyClose/);
assert.match(updaterSource, /_allowBusyClose = true/);
assert.match(updaterSource, /RunPortableUpdaterAsync\("Stage"/);
assert.match(updaterSource, /RunPowerShellAsync\(stagedUpdater, "Apply"/);
assert.match(updaterSource, /update-progress\.json/);
assert.match(updaterSource, /源码工作区不执行在线覆盖更新/);
assert.match(updaterSource, /CleanupOldTemporaryControllers/);
assert.doesNotMatch(updaterSource, /schtasks/i);

const checkFunction = mainSource.match(/private async Task CheckForUpdatesAsync\(\)[\s\S]*?\n        }/i)?.[0] || "";
assert.match(checkFunction, /Path\.Combine\(_root, "Update\.exe"\)/);
assert.match(checkFunction, /Process\.Start/);
assert.doesNotMatch(checkFunction, /update-check|update-stage|update-launch/);

const temporary = mkdtempSync(join(tmpdir(), "devspace-updater-selftest-"));
try {
  const reportFile = join(temporary, "report.json");
  const result = spawnSync(updaterExe, ["--self-test", reportFile], {
    cwd: root,
    windowsHide: true,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout || "Update.exe self-test failed");
  const report = JSON.parse(readFileSync(reportFile, "utf8"));
  assert.equal(report.standaloneUpdater, true);
  assert.equal(report.mainUiOnlyLaunchesUpdater, true);
  assert.equal(report.tempApplyController, true);
  assert.equal(report.scheduledTaskRequired, false);
  assert.equal(report.progressPolling, true);
  assert.equal(report.validatedUiTermination, true);
  assert.equal(report.transactionalPowerShellBackend, true);
  console.log(JSON.stringify(report));
}
finally {
  rmSync(temporary, { recursive: true, force: true });
}
