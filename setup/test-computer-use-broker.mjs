import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const NODE = resolve(ROOT, "runtime", "node", "node.exe");
const MANAGER = resolve(ROOT, "setup", "portable-manager.cjs");
const temporary = mkdtempSync(join(tmpdir(), "devspace-computer-use-broker-"));
const configDir = join(temporary, "config");
const stateDir = join(temporary, "state");
const runDir = join(temporary, "run");
const env = {
  ...process.env,
  DEVSPACE_PORTABLE_ROOT: ROOT,
  DEVSPACE_PORTABLE_CONFIG_DIR: configDir,
  DEVSPACE_PORTABLE_STATE_DIR: stateDir,
  DEVSPACE_PORTABLE_RUN_DIR: runDir,
};
Object.assign(process.env, env);
mkdirSync(configDir, { recursive: true });
writeFileSync(join(configDir, "deployment.json"), JSON.stringify({
  formatVersion: 5,
  toolMode: "full",
  permissions: { profile: "full-access" },
  features: { computerUse: true, memories: true, hooks: true, uiSessionReview: true },
}, null, 2));

function manager(command, payload) {
  const result = spawnSync(NODE, [MANAGER, command, "--ascii-json"], {
    cwd: ROOT,
    input: payload === undefined ? undefined : JSON.stringify(payload),
    env,
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || `${command} exited with ${result.status}`);
  }
  return result.stdout.trim() ? JSON.parse(result.stdout.trim()) : {};
}

const { performComputerAction } = await import("../app/node_modules/@waishnav/devspace/dist/computer-use.js");
const lease = manager("ui-open");
let brokerPid = null;

try {
  assert.ok(lease.leaseId);
  assert.equal(lease.broker?.ready, true);
  assert.equal(lease.broker?.running, true);
  assert.ok(Number.isInteger(lease.broker?.pid));
  assert.equal(lease.computerUseEnabled, true);
  assert.equal(lease.broker?.pollIntervalMs, 500);
  brokerPid = lease.broker.pid;
  const startedAt = performance.now();
  const result = await performComputerAction({
    action: "broker_probe",
    screenshotAfter: false,
  }, { leaseId: lease.leaseId });
  const elapsedMs = Math.round(performance.now() - startedAt);
  assert.equal(result.metadata.action, "broker_probe");
  assert.equal(result.metadata.screenshot, false);
  assert.ok(result.metadata.width > 0);
  assert.ok(result.metadata.height > 0);
  assert.ok(elapsedMs < 2_500, `compatibility broker probe took ${elapsedMs} ms`);
  const heartbeatResult = manager("ui-heartbeat", { leaseId: lease.leaseId });
  assert.equal(heartbeatResult.broker?.pid, brokerPid);
  const combinedPoll = manager("ui-runtime-poll", { leaseId: lease.leaseId, dashboard: false, continuations: false });
  assert.equal(combinedPoll.lease?.leaseId, lease.leaseId);
  assert.equal(combinedPoll.lease?.computerUseEnabled, true);
  const status = manager("ui-status");
  assert.equal(status.active, true);
  assert.equal(status.broker?.ready, true);
  assert.equal(status.broker?.pid, brokerPid);

  const disabled = manager("set-computer-use", { enabled: false });
  assert.equal(disabled.computerUseEnabled, false);
  assert.equal(disabled.broker?.disabled, true);
  const disabledStatus = manager("ui-status");
  assert.equal(disabledStatus.computerUseEnabled, false);
  assert.equal(disabledStatus.broker?.disabled, true);

  const pendingId = crypto.randomUUID();
  const requestDir = join(runDir, "computer-use", "requests");
  mkdirSync(requestDir, { recursive: true });
  const pendingFile = join(requestDir, `${pendingId}.json`);
  writeFileSync(pendingFile, JSON.stringify({
    formatVersion: 1,
    requestId: pendingId,
    leaseId: lease.leaseId,
    payload: { action: "broker_probe", screenshotAfter: false },
  }));
  const require = createRequire(import.meta.url);
  const managerModule = require(MANAGER);
  const persistedLease = managerModule.readJson(managerModule.UI_LEASE_FILE, {});
  assert.equal(persistedLease.computerUseEnabled, false,
    "the persisted UI lease must become an immediate Computer Use kill-switch");
  const guardedDrain = managerModule.processComputerUseRequests(persistedLease);
  assert.equal(guardedDrain.disabled, true);
  assert.equal(guardedDrain.processed, 0);
  assert.equal(existsSync(pendingFile), true,
    "a disabled broker must not claim a late/stale request for native input");
  console.log("DevSpace Computer Use broker/disable protocol test passed.");
}
finally {
  if (lease.leaseId) {
    const closed = manager("ui-close", { leaseId: lease.leaseId });
    assert.equal(closed.closed, true);
  }
  rmSync(temporary, { recursive: true, force: true });
}
