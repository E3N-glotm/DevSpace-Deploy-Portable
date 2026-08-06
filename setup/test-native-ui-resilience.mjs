import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const node = join(root, "runtime", "node", "node.exe");
const managerFile = join(root, "setup", "portable-manager.cjs");
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

async function waitForFile(file, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Timed out waiting for ${file}`);
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
  }));
} finally {
  if (firstUi && firstUi.pid) {
    spawnSync("taskkill.exe", ["/PID", String(firstUi.pid), "/T", "/F"], { windowsHide: true, encoding: "utf8" });
  }
  rmSync(temporary, { recursive: true, force: true });
}
