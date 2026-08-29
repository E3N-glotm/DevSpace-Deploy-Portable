import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_NODE = join(SOURCE_ROOT, "runtime", "node", "node.exe");
const SOURCE_UPDATER = join(SOURCE_ROOT, "setup", "portable-updater.ps1");
const POWERSHELL = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const NOOP_EXE = join(process.env.SystemRoot || "C:\\Windows", "System32", "where.exe");
const LONG_RUNNING_EXE = join(process.env.SystemRoot || "C:\\Windows", "System32", "ping.exe");

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
}

function installNode(target, { allowHardLink = true } = {}) {
  mkdirSync(dirname(target), { recursive: true });
  if (allowHardLink) {
    try {
      linkSync(SOURCE_NODE, target);
      return;
    } catch { }
  }
  copyFileSync(SOURCE_NODE, target);
}

function samePhysicalFile(left, right) {
  const a = statSync(left, { bigint: true });
  const b = statSync(right, { bigint: true });
  return a.dev === b.dev && a.ino === b.ino;
}

function createFixture({ failFirstStart = false, badTargetManifest = false, failStop = false, isolatedRuntimeNode = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "devspace-updater-apply-"));
  const state = join(root, "data", "state");
  const config = join(root, "data", "config");
  const setup = join(root, "setup");
  const stage = join(root, ".update-staging", `1.1.27-full-${Date.now()}`);
  const payload = join(stage, "payload");
  mkdirSync(state, { recursive: true });
  mkdirSync(config, { recursive: true });
  mkdirSync(setup, { recursive: true });
  mkdirSync(payload, { recursive: true });
  writeJson(join(config, "config.json"), { configured: true });
  writeJson(join(config, "auth.json"), { ownerToken: "test-owner-token-123456" });
  writeJson(join(root, "VERSION-MANIFEST.json"), { runtime: { devspacePortable: "1.1.26" } });
  copyFileSync(NOOP_EXE, join(root, "DevSpace-Portable.exe"));

  installNode(join(root, "runtime", "node", "node.exe"), { allowHardLink: !isolatedRuntimeNode });
  writeFileSync(join(setup, "portable-manager.cjs"), String.raw`
"use strict";
const fs = require("fs");
const path = require("path");
const root = path.resolve(__dirname, "..");
const state = path.join(root, "data", "state");
fs.mkdirSync(state, { recursive: true });
const events = path.join(state, "mock-manager-events.jsonl");
const tasks = path.join(state, "mock-tasks-installed");
const starts = path.join(state, "mock-start-count");
const command = process.argv[2] || "";
fs.appendFileSync(events, JSON.stringify({ command, at: new Date().toISOString() }) + "\n");
if (command === "stop") {
  if (process.env.DEVSPACE_TEST_FAIL_STOP === "1") {
    process.stderr.write("simulated pre-update stop failure\n");
    process.exit(6);
  }
  process.stdout.write("mock services stopped\n");
  process.exit(0);
}
if (command === "install-tasks") {
  fs.writeFileSync(tasks, "installed\n");
  process.stdout.write("mock tasks installed\n");
  process.exit(0);
}
if (command === "start") {
  if (!fs.existsSync(tasks)) {
    process.stderr.write("Portable scheduled tasks are not installed.\n");
    process.exit(4);
  }
  const count = fs.existsSync(starts) ? Number(fs.readFileSync(starts, "utf8")) + 1 : 1;
  fs.writeFileSync(starts, String(count));
  if (process.env.DEVSPACE_TEST_FAIL_FIRST_START === "1" && count === 1) {
    process.stderr.write("simulated post-update start failure\n");
    process.exit(5);
  }
  process.stdout.write("mock services started\n");
  process.exit(0);
}
process.stderr.write("unexpected manager command: " + command + "\n");
process.exit(9);
`, "utf8");

  copyFileSync(NOOP_EXE, join(payload, "DevSpace-Portable.exe"));
  writeJson(join(payload, "VERSION-MANIFEST.json"), {
    runtime: { devspacePortable: badTargetManifest ? "9.9.9" : "1.1.27" },
  });
  copyFileSync(SOURCE_UPDATER, join(stage, "portable-updater.ps1"));
  writeJson(join(stage, "stage-info.json"), {
    targetVersion: "1.1.27",
    updateMode: "full",
    payloadRoot: payload,
  });
  return { root, stage, failFirstStart, badTargetManifest, failStop };
}

function runApply(fixture) {
  return spawnSync(POWERSHELL, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", join(fixture.stage, "portable-updater.ps1"),
    "-Action", "Apply",
    "-Root", fixture.root,
    "-Repository", "E3N-glotm/DevSpace-Deploy-Portable",
    "-CurrentVersion", "1.1.26",
    "-StagingPath", fixture.stage,
    "-UiPid", "0",
  ], {
    cwd: fixture.root,
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000,
    env: {
      ...process.env,
      DEVSPACE_TEST_FAIL_FIRST_START: fixture.failFirstStart ? "1" : "0",
      DEVSPACE_TEST_FAIL_STOP: fixture.failStop ? "1" : "0",
    },
  });
}

function runApplyThroughRuntimeNode(fixture) {
  const runtimeNode = join(fixture.root, "runtime", "node", "node.exe");
  // This scenario models an installed Portable runtime launching its updater.
  // It must use a distinct physical executable. A hard link to SOURCE_NODE
  // would also be held open by this test runner itself and would manufacture
  // a lock that no real D:\DevSpacePortable installation has.
  assert.equal(samePhysicalFile(SOURCE_NODE, runtimeNode), false,
    "locked-runtime fixture must not hard-link the test runner's node.exe");
  installNode(join(fixture.stage, "payload", "runtime", "node", "node.exe"), { allowHardLink: false });
  const childScript = String.raw`
const { spawnSync } = require("node:child_process");
const p = spawnSync(${JSON.stringify(POWERSHELL)}, [
  "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
  "-File", ${JSON.stringify(join(fixture.stage, "portable-updater.ps1"))},
  "-Action", "Apply",
  "-Root", ${JSON.stringify(fixture.root)},
  "-Repository", "E3N-glotm/DevSpace-Deploy-Portable",
  "-CurrentVersion", "1.1.26",
  "-StagingPath", ${JSON.stringify(fixture.stage)},
  "-UiPid", "0",
], { encoding: "utf8", windowsHide: true });
process.stdout.write(JSON.stringify({ status: p.status, stdout: p.stdout, stderr: p.stderr }));
process.exit(p.status ?? 1);
`;
  return spawnSync(runtimeNode, ["-e", childScript], {
    cwd: fixture.root,
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000,
    env: { ...process.env, DEVSPACE_TEST_FAIL_FIRST_START: "0", DEVSPACE_TEST_FAIL_STOP: "0" },
  });
}

function waitFor(predicate, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  return predicate();
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function startLongRunningImage(path) {
  const child = spawn(path, ["-t", "127.0.0.1"], {
    cwd: dirname(path),
    stdio: "ignore",
    windowsHide: true,
  });
  const started = waitFor(() => Number.isInteger(child.pid) && child.pid > 0 && processExists(child.pid), 2_000);
  assert.equal(started, true, `long-running image failed to start: ${path}`);
  return child;
}

function updateBackups(root) {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(".update-backup-"))
    .map((entry) => entry.name);
}

function managerCommands(root) {
  return readFileSync(join(root, "data", "state", "mock-manager-events.jsonl"), "utf8")
    .trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line).command);
}

const successFixture = createFixture();
const serviceRecoveryFixture = createFixture({ failFirstStart: true });
const rollbackFixture = createFixture({ badTargetManifest: true });
const stopFailureFixture = createFixture({ failStop: true });
const lockedRuntimeFixture = createFixture({ isolatedRuntimeNode: true });
const directUiFixture = createFixture();
const residualWorkerFixture = createFixture();
let directUiProcess = null;
let residualWorkerProcess = null;
try {
  const success = runApply(successFixture);
  assert.equal(success.status, 0, success.stderr || success.stdout);
  const successManifest = readJson(join(successFixture.root, "VERSION-MANIFEST.json"));
  const successResult = readJson(join(successFixture.root, "data", "state", "update-result.json"));
  assert.equal(successManifest.runtime.devspacePortable, "1.1.27");
  assert.equal(successResult.success, true);
  assert.match(successResult.tasks, /tasks installed/i);
  assert.match(successResult.services, /services started/i);
  assert.equal(existsSync(join(successFixture.root, "data", "state", "mock-tasks-installed")), true);
  assert.deepEqual(managerCommands(successFixture.root), ["stop", "install-tasks", "start"]);

  const serviceRecovery = runApply(serviceRecoveryFixture);
  assert.equal(serviceRecovery.status, 0, serviceRecovery.stderr || serviceRecovery.stdout);
  const serviceRecoveryManifest = readJson(join(serviceRecoveryFixture.root, "VERSION-MANIFEST.json"));
  const serviceRecoveryResult = readJson(join(serviceRecoveryFixture.root, "data", "state", "update-result.json"));
  assert.equal(serviceRecoveryManifest.runtime.devspacePortable, "1.1.27");
  assert.equal(serviceRecoveryResult.success, true);
  assert.equal(serviceRecoveryResult.servicesRecovered, false);
  assert.match(serviceRecoveryResult.serviceRecoveryError, /simulated post-update start failure/i);
  assert.deepEqual(managerCommands(serviceRecoveryFixture.root), ["stop", "install-tasks", "start"]);

  const rollback = runApply(rollbackFixture);
  assert.notEqual(rollback.status, 0, "forced target-manifest mismatch should exercise file rollback");
  const rollbackManifest = readJson(join(rollbackFixture.root, "VERSION-MANIFEST.json"));
  const rollbackResult = readJson(join(rollbackFixture.root, "data", "state", "update-result.json"));
  assert.equal(rollbackManifest.runtime.devspacePortable, "1.1.26");
  assert.equal(rollbackResult.success, false);
  assert.equal(rollbackResult.rolledBack, true);
  assert.equal(rollbackResult.servicesRecovered, true);
  assert.deepEqual(rollbackResult.rollbackErrors, []);
  assert.deepEqual(managerCommands(rollbackFixture.root), ["stop", "stop", "install-tasks", "start"]);
  assert.match(`${rollback.stdout}\n${rollback.stderr}`, /DevSpace update error:.*Applied version manifest does not report 1\.1\.27/is);
  assert.doesNotMatch(`${rollback.stdout}\n${rollback.stderr}`.trim().split(/\r?\n/).at(-1) || "", /FullyQualifiedErrorId/i);

  const stopFailure = runApply(stopFailureFixture);
  assert.notEqual(stopFailure.status, 0, "failed pre-update stop must abort before moving program files");
  const stopFailureManifest = readJson(join(stopFailureFixture.root, "VERSION-MANIFEST.json"));
  assert.equal(stopFailureManifest.runtime.devspacePortable, "1.1.26");
  assert.equal(existsSync(join(stopFailureFixture.root, ".update-backup-1.1.27")), false);
  assert.deepEqual(managerCommands(stopFailureFixture.root), ["stop", "stop", "stop"]);
  assert.match(`${stopFailure.stdout}\n${stopFailure.stderr}`, /No program files were changed/i);

  const lockedRuntime = runApplyThroughRuntimeNode(lockedRuntimeFixture);
  assert.equal(lockedRuntime.status, 0, lockedRuntime.stderr || lockedRuntime.stdout);
  const stageRemoved = waitFor(() => !existsSync(lockedRuntimeFixture.stage));
  assert.equal(stageRemoved, true, "deferred cleanup should remove the staged update");
  const cleanupResultUpdated = waitFor(() => {
    try { return readJson(join(lockedRuntimeFixture.root, "data", "state", "update-result.json")).backupRemoved === true; }
    catch { return false; }
  });
  assert.equal(cleanupResultUpdated, true, "deferred cleanup should update the result after the runtime-node image lock is released");
  const lockedResult = readJson(join(lockedRuntimeFixture.root, "data", "state", "update-result.json"));
  assert.equal(lockedResult.success, true);
  assert.equal(lockedResult.backupRemoved, true);
  assert.equal(lockedResult.stageRemoved, true);
  assert.equal(lockedResult.cleanupScheduled, true);
  assert.deepEqual(updateBackups(lockedRuntimeFixture.root), []);

  const directUiPath = join(directUiFixture.root, "DevSpace-Portable.exe");
  copyFileSync(LONG_RUNNING_EXE, directUiPath);
  directUiProcess = startLongRunningImage(directUiPath);
  const directUiPid = directUiProcess.pid;
  const directUi = runApply(directUiFixture);
  assert.equal(directUi.status, 0, directUi.stderr || directUi.stdout);
  assert.equal(readJson(join(directUiFixture.root, "VERSION-MANIFEST.json")).runtime.devspacePortable, "1.1.27");
  assert.equal(waitFor(() => !processExists(directUiPid), 3_000), true,
    `direct Apply should close the exact-path Control Center PID ${directUiPid}`);

  const residualWorkerPath = join(residualWorkerFixture.root, "Portable-Test-Worker.exe");
  copyFileSync(LONG_RUNNING_EXE, residualWorkerPath);
  residualWorkerProcess = startLongRunningImage(residualWorkerPath);
  const residualWorkerPid = residualWorkerProcess.pid;
  const residualWorker = runApply(residualWorkerFixture);
  assert.notEqual(residualWorker.status, 0,
    "an unrelated Portable-root executable must block the transaction before file moves");
  assert.equal(readJson(join(residualWorkerFixture.root, "VERSION-MANIFEST.json")).runtime.devspacePortable, "1.1.26");
  assert.deepEqual(updateBackups(residualWorkerFixture.root), []);
  assert.match(`${residualWorker.stdout}\n${residualWorker.stderr}`, /Portable executable images are still running/i);
  assert.match(`${residualWorker.stdout}\n${residualWorker.stderr}`, /No program files were changed/i);
  assert.match(`${residualWorker.stdout}\n${residualWorker.stderr}`, /Portable-Test-Worker\.exe/i);
  assert.equal(processExists(residualWorkerPid), true,
    "preflight must not terminate unrelated Portable-root executable images");

  console.log(JSON.stringify({
    missingTasksReinstalledBeforeStart: true,
    updatedServicesStartedAfterTaskRepair: true,
    postUpdateServiceFailureDoesNotRollbackValidProgramFiles: true,
    serviceRecoveryFailureIsReportedSeparately: true,
    fileTransactionFailureRestoresPreviousFiles: true,
    rollbackReinstallsTasksBeforeRestart: true,
    rollbackRecoversPreviousServices: true,
    failedPreUpdateStopDoesNotTouchProgramFiles: true,
    conciseBackendFailurePreservedForOlderUpdaterUi: true,
    lockedRuntimeNodeUsesDeferredCleanup: true,
    cleanupResultReflectsActualFilesystemState: true,
    directApplyClosesExactPortableControlCenter: true,
    unrelatedPortableRootExecutableFailsBeforeTransaction: true,
  }));
} finally {
  try { directUiProcess?.kill(); } catch { }
  try { residualWorkerProcess?.kill(); } catch { }
  // The no-op control-center stand-in exits immediately, but give Windows a
  // brief opportunity to release its image section before removing fixtures.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  const cleanupOptions = { recursive: true, force: true, maxRetries: 30, retryDelay: 100 };
  rmSync(successFixture.root, cleanupOptions);
  rmSync(serviceRecoveryFixture.root, cleanupOptions);
  rmSync(rollbackFixture.root, cleanupOptions);
  rmSync(stopFailureFixture.root, cleanupOptions);
  rmSync(lockedRuntimeFixture.root, cleanupOptions);
  rmSync(directUiFixture.root, cleanupOptions);
  rmSync(residualWorkerFixture.root, cleanupOptions);
}
