import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PluginManager } from "../app/node_modules/@waishnav/devspace/dist/plugin-manager.js";
import { loadConfig } from "../app/node_modules/@waishnav/devspace/dist/config.js";
import { createServer } from "../app/node_modules/@waishnav/devspace/dist/server.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NODE = join(ROOT, "runtime", "node", "node.exe");
const POWERSHELL = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const BRIDGE = join(ROOT, "setup", "bundled-plugins", "codex-runtime-bridge", "1.1.1");
const RUNTIME = join(BRIDGE, "runtime.mjs");
const KEEP_AWAKE = join(BRIDGE, "keep-awake.ps1");
const TEMP = join(tmpdir(), `devspace-codex-bridge-test-${process.pid}`);

try {
  rmSync(TEMP, { recursive: true, force: true });
  mkdirSync(TEMP, { recursive: true });
  testBundledSeeding();
  testDependenciesAndSkillRoots();
  testInventory();
  testCheckpoints();
  await testKeepAwake();
  await testServerCreation();
  console.log("CODEX_RUNTIME_BRIDGE_TEST=PASS");
} finally {
  rmSync(TEMP, { recursive: true, force: true });
}

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: options.cwd ?? ROOT,
    env: options.env ?? process.env,
    input: options.input,
    encoding: "utf8",
    windowsHide: true,
    timeout: options.timeout ?? 60_000,
    maxBuffer: options.maxBuffer ?? 128 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${executable} ${args.join(" ")} failed (${result.status}): ${result.stdout}${result.stderr}`);
  }
  return String(result.stdout ?? "");
}

function testBundledSeeding() {
  const portable = join(TEMP, "portable");
  mkdirSync(join(portable, "setup"), { recursive: true });
  cpSync(join(ROOT, "setup", "portable-manager.cjs"), join(portable, "setup", "portable-manager.cjs"));
  cpSync(join(ROOT, "setup", "bundled-plugins"), join(portable, "setup", "bundled-plugins"), { recursive: true });
  const first = JSON.parse(run(NODE, [join(portable, "setup", "portable-manager.cjs"), "seed-bundled-plugins"]));
  const second = JSON.parse(run(NODE, [join(portable, "setup", "portable-manager.cjs"), "seed-bundled-plugins"]));
  assert(first.seeded.includes("codex-runtime-bridge@1.1.1"), "bundled plugin was not seeded");
  assert(second.preserved.includes("codex-runtime-bridge@1.1.1"), "existing bundled plugin was overwritten instead of preserved");
  assert(existsSync(join(portable, "data", "plugins", "installed", "codex-runtime-bridge", "1.1.1", "manifest.json")), "seeded manifest is missing");
}

function testDependenciesAndSkillRoots() {
  const root = join(TEMP, "dependency");
  const stateDir = join(root, "state");
  const pluginRoot = join(root, "plugins", "installed");
  cpSync(BRIDGE, join(pluginRoot, "codex-runtime-bridge", "1.1.1"), { recursive: true });
  const blockedRoot = join(pluginRoot, "blocked-test", "1.0.0");
  mkdirSync(blockedRoot, { recursive: true });
  writeFileSync(join(blockedRoot, "manifest.json"), JSON.stringify({
    id: "blocked-test",
    version: "1.0.0",
    enabledByDefault: true,
    dependencies: { executables: ["definitely-missing-devspace-test"] },
    tools: [{ name: "probe", readOnly: true, argv: ["node", "--version"] }],
  }, null, 2));
  const priorRoot = process.env.DEVSPACE_PLUGIN_ROOT;
  process.env.DEVSPACE_PLUGIN_ROOT = pluginRoot;
  const manager = new PluginManager({ stateDir });
  try {
    const list = manager.list();
    assert(list.find((item) => item.id === "codex-runtime-bridge")?.dependencyStatus?.status === "ready", "bridge dependency status is not ready");
    assert(list.find((item) => item.id === "blocked-test")?.dependencyStatus?.status === "blocked", "missing required executable did not block plugin");
    assert(manager.enabledSkillRoots().every((path) => !path.includes("%USERPROFILE%")), "environment-backed Skill root was not expanded");
    let rejected = false;
    try { manager.resolveTool("blocked-test", "probe"); } catch { rejected = true; }
    assert(rejected, "blocked plugin was allowed to resolve");
  } finally {
    manager.close();
    if (priorRoot === undefined) delete process.env.DEVSPACE_PLUGIN_ROOT;
    else process.env.DEVSPACE_PLUGIN_ROOT = priorRoot;
  }
}

function testInventory() {
  const inventory = JSON.parse(run(NODE, [RUNTIME, "inventory"], { timeout: 90_000 }));
  if (inventory.available) {
    assert(/^codex-cli\s+\d+/.test(inventory.version ?? ""), "Codex version was not parsed");
    assert(Array.isArray(inventory.installedPlugins), "Codex plugin inventory is missing");
  }
}

function testCheckpoints() {
  const repository = join(TEMP, "checkpoint-repo");
  mkdirSync(repository, { recursive: true });
  run("git", ["init"], { cwd: repository });
  run("git", ["config", "user.name", "DevSpace Test"], { cwd: repository });
  run("git", ["config", "user.email", "devspace-test@local"], { cwd: repository });
  writeFileSync(join(repository, "state.txt"), "baseline\n");
  run("git", ["add", "state.txt"], { cwd: repository });
  run("git", ["commit", "-m", "baseline"], { cwd: repository });
  writeFileSync(join(repository, "state.txt"), "checkpoint\n");
  writeFileSync(join(repository, "new.txt"), "created\n");
  const created = JSON.parse(run(NODE, [RUNTIME, "checkpoint-create", "--workspace", repository, "--name", "test"]));
  writeFileSync(join(repository, "state.txt"), "after\n");
  rmSync(join(repository, "new.txt"));
  writeFileSync(join(repository, "other.txt"), "remove-me\n");
  const restored = JSON.parse(run(NODE, [
    RUNTIME, "checkpoint-restore", "--workspace", repository,
    "--checkpoint", created.id, "--confirm", created.id,
  ]));
  assert(readFileSync(join(repository, "state.txt"), "utf8").trim() === "checkpoint", "checkpoint file content was not restored");
  assert(existsSync(join(repository, "new.txt")), "checkpoint untracked file was not restored");
  assert(!existsSync(join(repository, "other.txt")), "post-checkpoint file was not removed");
  assert(Boolean(restored.safetyCheckpoint), "restore did not create a safety checkpoint");
}

async function testKeepAwake() {
  const pidFile = join(TEMP, "keep-awake.pid");
  const child = spawn(POWERSHELL, [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
    `& '${KEEP_AWAKE.replaceAll("'", "''")}' start '${pidFile.replaceAll("'", "''")}'`,
  ], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  try {
    const deadline = Date.now() + 10_000;
    while (!existsSync(pidFile) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
    assert(existsSync(pidFile), "keep-awake PID file was not created");
    const status = JSON.parse(run(POWERSHELL, [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
      `& '${KEEP_AWAKE.replaceAll("'", "''")}' status '${pidFile.replaceAll("'", "''")}'`,
    ]));
    assert(status.running === true, "keep-awake status did not report running");
    const stopped = JSON.parse(run(POWERSHELL, [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
      `& '${KEEP_AWAKE.replaceAll("'", "''")}' stop '${pidFile.replaceAll("'", "''")}'`,
    ]));
    assert(stopped.stopped === true, "keep-awake process was not stopped");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((_, reject) => setTimeout(() => reject(new Error("keep-awake process did not exit")), 5_000)),
    ]);
  } finally {
    if (!child.killed) child.kill();
    rmSync(pidFile, { force: true });
  }
}

async function testServerCreation() {
  const root = join(TEMP, "server");
  const configDir = join(root, "config");
  const stateDir = join(root, "state");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "config.json"), JSON.stringify({
    host: "127.0.0.1",
    port: 17676,
    allowedRoots: [ROOT],
    publicBaseUrl: "http://127.0.0.1:17676",
    stateDir,
    subagents: false,
    permissions: {
      profile: "full-access",
      allowExternalPaths: true,
      allowArbitraryCommands: true,
      allowShellMutation: true,
      allowNetworkAccess: true,
      allowCredentialAccess: true,
      allowInteractiveProcesses: true,
      allowPersistentProcesses: true,
    },
  }, null, 2));
  writeFileSync(join(configDir, "auth.json"), JSON.stringify({ ownerToken: "devspace-test-owner-token-1234567890" }, null, 2));
  const priorPluginRoot = process.env.DEVSPACE_PLUGIN_ROOT;
  process.env.DEVSPACE_PLUGIN_ROOT = join(ROOT, "setup", "bundled-plugins");
  const config = loadConfig({
    ...process.env,
    DEVSPACE_CONFIG_DIR: configDir,
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_TOOL_MODE: "codex",
    DEVSPACE_WIDGETS: "changes",
    DEVSPACE_SUBAGENTS: "0",
    DEVSPACE_LOG_REQUESTS: "0",
    DEVSPACE_LOG_TOOL_CALLS: "0",
  });
  const server = createServer(config);
  try {
    const bridge = server.pluginManager.list().find((plugin) => plugin.id === "codex-runtime-bridge");
    assert(bridge?.selectedVersion === "1.1.1", "fresh server did not load bundled Codex bridge");
    assert(bridge?.dependencyStatus?.status === "ready", "fresh server bridge dependencies are not ready");
  } finally {
    await server.close();
    if (priorPluginRoot === undefined) delete process.env.DEVSPACE_PLUGIN_ROOT;
    else process.env.DEVSPACE_PLUGIN_ROOT = priorPluginRoot;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
