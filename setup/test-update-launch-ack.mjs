import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const NODE = join(ROOT, "runtime", "node", "node.exe");
const MANAGER = join(ROOT, "setup", "portable-manager.cjs");
const STAGING_ROOT = join(ROOT, ".update-staging");
const stage = join(STAGING_ROOT, `launch-ack-test-${process.pid}-${Date.now()}`);
const updater = join(stage, "portable-updater.ps1");
const stageInfo = join(stage, "stage-info.json");

mkdirSync(stage, { recursive: true });
writeFileSync(stageInfo, JSON.stringify({ targetVersion: "9.9.9", updateMode: "full" }, null, 2));
writeFileSync(updater, String.raw`param(
  [string]$Action,
  [string]$Root,
  [string]$Repository,
  [string]$CurrentVersion,
  [string]$StagingPath,
  [int]$UiPid,
  [string]$LaunchAckPath,
  [string]$UpdateTaskName
)
$value = [ordered]@{
  acknowledged = $true
  updaterPid = $PID
  currentVersion = $CurrentVersion
  targetVersion = '9.9.9'
  updateMode = 'full'
  stagingPath = $StagingPath
}
$value | ConvertTo-Json | Set-Content -LiteralPath $LaunchAckPath -Encoding UTF8
Start-Sleep -Milliseconds 500
& "$env:SystemRoot\System32\schtasks.exe" /delete /tn $UpdateTaskName /f 2>$null | Out-Null
`, "utf8");

try {
  const result = spawnSync(NODE, [MANAGER, "update-launch"], {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true,
    timeout: 20_000,
    input: JSON.stringify({ stagingPath: stage, uiPid: process.pid }),
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout.trim());
  assert.equal(output.launched, true);
  assert.equal(output.acknowledged, true);
  assert.equal(output.acknowledgement.acknowledged, true);
  assert.equal(output.acknowledgement.updaterPid, output.updaterPid);

  writeFileSync(updater, String.raw`param(
  [string]$Action,
  [string]$Root,
  [string]$Repository,
  [string]$CurrentVersion,
  [string]$StagingPath,
  [int]$UiPid,
  [string]$LaunchAckPath,
  [string]$UpdateTaskName
)
Write-Error 'intentional launch failure before acknowledgement'
exit 7
`, "utf8");
  const failed = spawnSync(NODE, [MANAGER, "update-launch"], {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true,
    timeout: 20_000,
    input: JSON.stringify({ stagingPath: stage, uiPid: process.pid }),
  });
  assert.notEqual(failed.status, 0);
  assert.match(`${failed.stdout}\n${failed.stderr}`, /failed to acknowledge launch/i);

  console.log(JSON.stringify({
    detachedUpdaterAcknowledgement: true,
    prematureUpdaterExitRejected: true,
    launchErrorCaptured: true,
  }));
} finally {
  if (process.env.DEVSPACE_KEEP_TEST_STAGE === "1") console.error(`kept test stage: ${stage}`);
  else rmSync(stage, { recursive: true, force: true });
}
