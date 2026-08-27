import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const node = join(root, "runtime", "node", "node.exe");
const managerFile = join(root, "setup", "portable-manager.cjs");
const nativeSource = readFileSync(join(root, "setup", "native", "DevSpacePortableApp.cs"), "utf8");
const nativeExe = join(root, "DevSpace-Portable.exe");
const temporary = await mkdtemp(join(tmpdir(), "devspace-ui-resilience-"));
const configDir = join(temporary, "config");
const stateDir = join(temporary, "state");
const runDir = join(temporary, "run");
const env = {
  ...process.env,
  DEVSPACE_PORTABLE_CONFIG_DIR: configDir,
  DEVSPACE_PORTABLE_STATE_DIR: stateDir,
  DEVSPACE_PORTABLE_RUN_DIR: runDir,
};

function manager(command, payload) {
  const result = spawnSync(node, [managerFile, command, "--ascii-json"], {
    cwd: root,
    env,
    input: payload === undefined ? undefined : JSON.stringify(payload),
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
  });
  if (result.status !== 0) throw new Error(result.stderr || `${command} exited with ${result.status}`);
  return result.stdout.trim() ? JSON.parse(result.stdout.trim()) : {};
}

async function waitForFile(file, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Timed out waiting for ${file}`);
}

async function waitForChildExit(child, timeoutMs = 10_000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise((resolveWait) => child.once("close", resolveWait)),
    new Promise((resolveWait) => setTimeout(resolveWait, timeoutMs)),
  ]);
}

async function removeTemporaryDirectory(path, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      rmSync(path, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
      return;
    } catch (error) {
      if (!["EPERM", "EBUSY", "ENOTEMPTY"].includes(error?.code)) throw error;
      lastError = error;
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
  }
  if (!existsSync(path)) return;

  // A better-sqlite3 handle owned by this Node test process can keep the WAL
  // mapping alive until process teardown on Windows even after close(). In
  // that case retrying rmSync in the same process can never succeed, while the
  // directory becomes removable immediately after this process exits. Defer
  // only the final filesystem cleanup to a detached helper instead of turning
  // an already-successful functional regression into a false failure.
  const parentPid = process.pid;
  const cleanupScript = `
    const { existsSync, rmSync } = require("node:fs");
    const target = ${JSON.stringify(path)};
    const parentPid = ${parentPid};
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    (async () => {
      for (let attempt = 0; attempt < 120; attempt += 1) {
        try { process.kill(parentPid, 0); }
        catch { break; }
        await sleep(250);
      }
      for (let attempt = 0; attempt < 120; attempt += 1) {
        try {
          rmSync(target, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
          process.exit(0);
        } catch (error) {
          if (!["EPERM", "EBUSY", "ENOTEMPTY"].includes(error?.code)) process.exit(2);
          await sleep(250);
        }
      }
      process.exit(existsSync(target) ? 3 : 0);
    })();
  `;
  const cleaner = spawn(process.execPath, ["-e", cleanupScript], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  cleaner.unref();
  console.warn(`Deferred temporary cleanup until test process exit: ${path} (${lastError?.code ?? "locked"})`);
}

mkdirSync(configDir, { recursive: true });
writeFileSync(join(configDir, "deployment.json"), JSON.stringify({
  formatVersion: 5,
  toolMode: "codex",
  permissions: { profile: "full-access" },
  features: { computerUse: false, memories: true, hooks: true, uiSessionReview: true },
}, null, 2));

let firstUi;
try {
  // Portable owner UI must support real multi-selection and batch continuation
  // controls without relying on ChatGPT or reviving already-completed tasks.
  const runtimeStatePath = join(root, "app", "node_modules", "@waishnav", "devspace", "dist", "runtime-state.js");
  const { StructuredRuntimeState } = await import(`${pathToFileURL(runtimeStatePath).href}?owner-ui=${Date.now()}`);
  const continuationRuntime = new StructuredRuntimeState(stateDir);
  const ownerTask = continuationRuntime.continuationTask({
    action: "begin",
    conversationScopeId: "native-ui-owner-test",
    workspaceId: "ws_native_owner",
    objective: "verify owner continuation controls",
    requiredMilestones: ["lock", "stop"],
  });
  const secondOwnerTask = continuationRuntime.continuationTask({
    action: "begin",
    conversationScopeId: "native-ui-owner-test-2",
    workspaceId: "ws_native_owner_2",
    objective: "verify batch owner continuation controls",
    requiredMilestones: ["pause", "delete"],
  });
  continuationRuntime.continuationTask({
    action: "host-signal",
    taskId: ownerTask.task.id,
    hostProfileId: "native-ui-test-host",
    hostSignal: "timeout",
    elapsedMs: 30_000,
  });
  const initialTasks = manager("continuation-list", { includeTerminal: true });
  assert.ok(initialTasks.tasks.some((task) => task.id === ownerTask.task.id));
  const listedOwnerTask = initialTasks.tasks.find((task) => task.id === ownerTask.task.id);
  assert.ok(listedOwnerTask.turnStartedAt);
  assert.equal(listedOwnerTask.continuationMode, "completion-driven");
  assert.equal(listedOwnerTask.unlimitedContinuations, true);
  assert.equal(listedOwnerTask.unlimitedWallClock, true);
  assert.ok(listedOwnerTask.lastModelActivityAt);
  assert.equal(listedOwnerTask.hostTimeoutSamples, 1);
  assert.equal(listedOwnerTask.recommendedContinueAfterMs, 26_400);
  assert.equal(listedOwnerTask.confirmedTurnLimitMs, 30_000);
  assert.equal(listedOwnerTask.confirmedTurnLimitSource, "host-timeout-initial-regime");
  const batchIds = [ownerTask.task.id, secondOwnerTask.task.id];
  const lockedTasks = manager("continuation-lock", { taskIds: batchIds });
  assert.equal(lockedTasks.affected, 2);
  assert.equal(lockedTasks.tasks.length, 2);
  assert.ok(lockedTasks.tasks.every((task) => task.ownerLocked));
  assert.equal(continuationRuntime.continuationTask({ action: "cancel", taskId: ownerTask.task.id }).reason, "task-owner-locked");
  const pausedTasks = manager("continuation-pause", { taskIds: batchIds });
  assert.equal(pausedTasks.affected, 2);
  assert.ok(pausedTasks.tasks.every((task) => task.state === "PAUSED_BY_USER"));
  assert.equal(continuationRuntime.continuationTask({ action: "claim-continuation", taskId: ownerTask.task.id }).reason, "task-paused-by-user");
  const resumedTasks = manager("continuation-resume", { taskIds: batchIds });
  assert.equal(resumedTasks.affected, 2);
  assert.ok(resumedTasks.tasks.every((task) => task.state === "RUNNING"));
  const unlockedTasks = manager("continuation-unlock", { taskIds: batchIds });
  assert.ok(unlockedTasks.tasks.every((task) => !task.ownerLocked));
  const stoppedTask = manager("continuation-stop", { taskId: ownerTask.task.id });
  assert.equal(stoppedTask.task.state, "CANCELLED_BY_USER");
  assert.equal(stoppedTask.task.terminalReason, "owner-stopped");
  assert.equal(stoppedTask.task.continuationWakePending, false);
  const deletedTask = manager("continuation-delete", { taskIds: [secondOwnerTask.task.id] });
  assert.deepEqual(deletedTask.deletedIds, [secondOwnerTask.task.id]);
  assert.equal(manager("continuation-list", { includeTerminal: true }).tasks.some((task) => task.id === secondOwnerTask.task.id), false);
  assert.match(nativeSource, /_continuationGrid\.MultiSelect = true/);
  assert.match(nativeSource, /Dictionary<string, object> value = await _manager\.RunJsonAsync\("continuation-list"[\s\S]*?HashSet<string> selectedIds = new HashSet<string>\(SelectedContinuationIds\(\), StringComparer\.OrdinalIgnoreCase\)/);
  assert.doesNotMatch(nativeSource, /HashSet<string> selectedIds = new HashSet<string>\(SelectedContinuationIds\(\), StringComparer\.OrdinalIgnoreCase\);[\s\S]{0,300}?Dictionary<string, object> value = await _manager\.RunJsonAsync\("continuation-list"/);
  assert.match(nativeSource, /Name = "continuationCountdown"[\s\S]*?HeaderText = "恢复状态"/);
  assert.match(nativeSource, /_continuationCountdownTimer\.Interval = 1000/);
  assert.doesNotMatch(nativeSource, /prefix = "静默 "|explicitSilentContinueAfterMs|explicit-long/);
  assert.match(nativeSource, /continuationMode[\s\S]*?completion-driven/);
  assert.match(nativeSource, /continuationMode[\s\S]*?timeout-recovery/);
  assert.match(nativeSource, /continuationMode[\s\S]*?resident/);
  assert.match(nativeSource, /无限/);
  assert.match(nativeSource, /等待 Host 信号/);
  assert.match(nativeSource, /Host 已截断/);
  assert.match(nativeSource, /等待阶段/);
  assert.match(nativeSource, /SUSPECTED_STALL/);
  assert.match(nativeSource, /CONTINUATION_ARMED/);
  assert.match(nativeSource, /等待恢复 ACK #/);
  assert.match(nativeSource, /MCP readiness retry #/);
  assert.match(nativeSource, /confirmedTurnLimitMs/);
  assert.match(nativeSource, /continuation-pause[\s\S]*?taskIds = ids/);
  assert.match(nativeSource, /continuation-delete[\s\S]*?taskIds = ids/);
  assert.match(nativeSource, /Name = "RemoteAgentNewButton"/);
  assert.match(nativeSource, /SetAgentEditorVisible\(false\)/);
  assert.match(nativeSource, /BeginNewAgentEditor\(\)[\s\S]*?_creatingNewAgent = true[\s\S]*?SetAgentEditorVisible\(true\)/);
  assert.match(nativeSource, /bool createNew = _creatingNewAgent \|\| string\.IsNullOrWhiteSpace\(agentId\)/);
  assert.match(nativeSource, /if \(createNew\)[\s\S]*?CreateSshEnrollmentAsync\(_manager, "", agentName[\s\S]*?新的 Remote Workspace Agent 已部署并上线/);
  assert.match(nativeSource, /remoteAgentDefaultEditorCollapsed/);
  assert.match(nativeSource, /remoteAgentExplicitEditorExpanded/);
  continuationRuntime.close?.();

  // A deleted lease must be replaced automatically by the next heartbeat.
  const firstLease = manager("ui-open");
  rmSync(join(runDir, "ui-session.json"), { force: true });
  const recovered = manager("ui-heartbeat", { leaseId: firstLease.leaseId });
  assert.equal(recovered.recovered, true);
  assert.notEqual(recovered.leaseId, firstLease.leaseId);
  manager("ui-close", { leaseId: recovered.leaseId });

  // Disabled Computer Use must never create or retain a broker.
  const disabled = manager("set-computer-use", { enabled: false });
  assert.equal(disabled.enabled, false);
  const disabledLease = manager("ui-open");
  assert.equal(disabledLease.computerUseEnabled, false);
  assert.equal(disabledLease.broker.disabled, true);
  assert.equal(existsSync(join(runDir, "computer-use", "broker.json")), false);
  manager("ui-close", { leaseId: disabledLease.leaseId });

  // The native log reader must work while another process still holds the append handle.
  const logFile = join(temporary, "held-open.log");
  const logOutput = join(temporary, "tail-output.txt");
  writeFileSync(logFile, "first line\r\nsecond line\r\n", "utf8");
  const heldLog = openSync(logFile, "a");
  try {
    const readResult = spawnSync(nativeExe, ["--tail-file-test", logFile, logOutput], {
      cwd: root, env, encoding: "utf8", windowsHide: true, timeout: 30_000,
    });
    assert.equal(readResult.status, 0, readResult.stderr);
    assert.match(readFileSync(logOutput, "utf8"), /second line/);
  } finally {
    closeSync(heldLog);
  }

  // A second process for the same Portable root exits without replacing the first UI lease.
  firstUi = spawn(nativeExe, [], { cwd: root, env, windowsHide: true, stdio: "ignore" });
  const leaseFile = join(runDir, "ui-session.json");
  await waitForFile(leaseFile);
  const originalLease = JSON.parse(readFileSync(leaseFile, "utf8"));
  const secondUi = spawnSync(nativeExe, [], { cwd: root, env, encoding: "utf8", windowsHide: true, timeout: 15_000 });
  assert.equal(secondUi.status, 0, secondUi.stderr);
  const retainedLease = JSON.parse(readFileSync(leaseFile, "utf8"));
  assert.equal(retainedLease.leaseId, originalLease.leaseId);
  assert.equal(retainedLease.uiPid, originalLease.uiPid);
  assert.equal(retainedLease.openedAt, originalLease.openedAt);

  console.log(JSON.stringify({
    leaseRecovery: true,
    disabledBroker: true,
    sharedLogRead: true,
    singleInstanceLease: true,
    continuationOwnerControls: true,
    continuationBatchControls: true,
    continuationCountdownUi: true,
  }));
} finally {
  if (firstUi && firstUi.pid) {
    spawnSync("taskkill.exe", ["/PID", String(firstUi.pid), "/T", "/F"], { windowsHide: true, encoding: "utf8" });
    await waitForChildExit(firstUi);
  }
  // Windows can keep a just-terminated WinForms process' directory handles
  // alive for a short interval after taskkill returns. Node's recursive rm
  // supports bounded EPERM/EBUSY retries specifically for this case; without
  // them the GitHub Windows runner can fail after every functional assertion
  // has already passed.
  await removeTemporaryDirectory(temporary);
}
