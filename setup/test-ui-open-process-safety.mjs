import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const NODE = resolve(ROOT, "runtime", "node", "node.exe");
const MANAGER = resolve(ROOT, "setup", "portable-manager.cjs");
const temporary = mkdtempSync(join(tmpdir(), "devspace-ui-open-process-safety-"));
const configDir = join(temporary, "config");
const stateDir = join(temporary, "state");
const runDir = join(temporary, "run");
const computerUseDir = join(runDir, "computer-use");
const brokerFile = join(computerUseDir, "broker.json");
const leaseFile = join(runDir, "ui-session.json");
const pingExe = join(process.env.SystemRoot || "C:\\Windows", "System32", "PING.EXE");

function processExists(pid) {
  const result = spawnSync("tasklist.exe", ["/fi", `PID eq ${pid}`, "/fo", "csv", "/nh"], {
    encoding: "utf8",
    windowsHide: true,
  });
  return String(result.stdout || "").includes(`\"${pid}\"`);
}

function manager(command, payload, env) {
  const result = spawnSync(NODE, [MANAGER, command, "--ascii-json"], {
    cwd: ROOT,
    env,
    input: payload === undefined ? undefined : JSON.stringify(payload),
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `${command} exited with ${result.status}`);
  return result.stdout.trim() ? JSON.parse(result.stdout.trim()) : {};
}

let external = null;
try {
  mkdirSync(configDir, { recursive: true });
  mkdirSync(computerUseDir, { recursive: true });
  writeFileSync(join(configDir, "deployment.json"), JSON.stringify({
    formatVersion: 5,
    toolMode: "full",
    permissions: { profile: "full-access" },
    features: { computerUse: true, memories: true, hooks: true, uiSessionReview: true },
  }, null, 2));

  external = spawn(pingExe, ["-t", "127.0.0.1"], {
    detached: true,
    windowsHide: true,
    stdio: "ignore",
  });
  external.unref();
  assert.ok(Number.isInteger(external.pid) && external.pid > 0);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  assert.equal(processExists(external.pid), true, "external safety process did not start");

  const staleLeaseId = "11111111-2222-4333-8444-555555555555";
  writeFileSync(leaseFile, JSON.stringify({
    formatVersion: 1,
    leaseId: staleLeaseId,
    uiPid: 999999,
    nativeQueueWorker: false,
    openedAt: new Date().toISOString(),
    lastHeartbeatAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    portableVersion: "1.1.27",
  }, null, 2));
  writeFileSync(brokerFile, JSON.stringify({
    formatVersion: 1,
    leaseId: staleLeaseId,
    pid: external.pid,
    startedAt: new Date().toISOString(),
    status: "running",
  }, null, 2));

  const env = {
    ...process.env,
    DEVSPACE_PORTABLE_ROOT: ROOT,
    DEVSPACE_PORTABLE_CONFIG_DIR: configDir,
    DEVSPACE_PORTABLE_STATE_DIR: stateDir,
    DEVSPACE_PORTABLE_RUN_DIR: runDir,
    DEVSPACE_NATIVE_UI_PID: String(process.pid),
    DEVSPACE_NATIVE_UI_QUEUE_WORKER: "1",
  };
  const lease = manager("ui-open", undefined, env);
  assert.ok(lease.leaseId);
  assert.equal(lease.broker?.ready, true);
  assert.equal(lease.broker?.pid, process.pid);
  assert.equal(existsSync(brokerFile), false, "stale broker record should be removed on UI open");
  assert.equal(
    processExists(external.pid),
    true,
    "opening the DevSpace UI terminated an unrelated process referenced by a stale broker PID",
  );

  const closed = manager("ui-close", { leaseId: lease.leaseId }, env);
  assert.equal(closed.closed, true);
  assert.equal(processExists(external.pid), true, "closing the UI terminated the unrelated safety process");

  console.log(JSON.stringify({
    uiOpenStalePidSafety: true,
    unrelatedProcessPreserved: true,
    staleBrokerRecordRemoved: true,
    externalPid: external.pid,
  }));
} finally {
  if (external?.pid && processExists(external.pid)) {
    spawnSync("taskkill.exe", ["/pid", String(external.pid), "/f"], { windowsHide: true });
  }
  rmSync(temporary, { recursive: true, force: true });
}
