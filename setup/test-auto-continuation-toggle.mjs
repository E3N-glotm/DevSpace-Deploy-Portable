import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
// Test data stays under the existing E-drive source tree, not a C-drive worktree.
const sandbox = mkdtempSync(join(root, "reports", ".tmp-auto-continuation-"));
const stateDir = join(sandbox, "state");
const configDir = join(sandbox, "config");
mkdirSync(stateDir);
mkdirSync(configDir);
const settingsFile = join(configDir, "auto-continuation.json");
const manager = join(root, "setup", "portable-manager.cjs");
const env = {
  ...process.env,
  DEVSPACE_PORTABLE_CONFIG_DIR: configDir,
  DEVSPACE_PORTABLE_STATE_DIR: stateDir,
  DEVSPACE_PORTABLE_RUN_DIR: join(sandbox, "run"),
};
const invoke = (command, input) => {
  const result = spawnSync(process.execPath, [manager, command, "--ascii-json"], {
    cwd: root, env, encoding: "utf8", timeout: 20_000,
    ...(input === undefined ? {} : { input: JSON.stringify(input) }),
  });
  if (result.status !== 0) throw new Error(`${command}: ${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout.trim());
};

const originalEnv = process.env.DEVSPACE_PORTABLE_CONFIG_DIR;
let runtime;
try {
  // Old installations start enabled without creating a config file.
  process.env.DEVSPACE_PORTABLE_CONFIG_DIR = configDir;
  const { StructuredRuntimeState } = await import(pathToFileURL(join(root,
    "app", "node_modules", "@waishnav", "devspace", "dist", "runtime-state.js")).href);
  runtime = new StructuredRuntimeState(stateDir);
  assert.equal(existsSync(settingsFile), false);
  assert.equal(runtime.autoContinuationEnabled(), true);
  assert.equal(invoke("show-config").autoContinuationEnabled, true);

  // Standalone switch must not mutate deployment, authorization, or CU state.
  const configFile = join(configDir, "config.json");
  const deploymentFile = join(configDir, "deployment.json");
  writeFileSync(configFile, '{"features":{"computerUse":true},"sentinel":"unchanged"}\n');
  writeFileSync(deploymentFile, '{"features":{"computerUse":true},"sentinel":"unchanged"}\n');
  const originalConfig = readFileSync(configFile, "utf8");
  const originalDeployment = readFileSync(deploymentFile, "utf8");

  assert.equal(invoke("set-auto-continuation", { enabled: false }).enabled, false);
  assert.equal(JSON.parse(readFileSync(settingsFile, "utf8")).enabled, false);
  assert.equal(invoke("show-config").autoContinuationEnabled, false);
  assert.equal(runtime.autoContinuationEnabled(), false,
    "the running MCP must observe the saved switch without a service restart");
  assert.deepEqual(runtime.continuationSupervisorSweep().ready, []);
  assert.equal(runtime.claimReadyContinuationGeneration({}).reason, "automatic-continuation-disabled");
  assert.equal(runtime.authorizeContinuationGenerationDelivery({}).reason, "automatic-continuation-disabled");
  const manual = runtime.continuationTask({
    action: "status", manualTakeover: true, conversationScopeId: "v1/test-auto-continuation-toggle",
  });
  assert.equal(manual.accepted, true, "OFF must not disable manual MCP task creation");
  assert.ok(manual.task.id);
  assert.equal(readFileSync(configFile, "utf8"), originalConfig);
  assert.equal(readFileSync(deploymentFile, "utf8"), originalDeployment);

  assert.equal(invoke("set-auto-continuation", { enabled: true }).enabled, true);
  assert.equal(runtime.autoContinuationEnabled(), true);
  assert.equal(invoke("show-config").autoContinuationEnabled, true);
  assert.equal(runtime.claimReadyContinuationGeneration({}).reason, "sender-capability-required");
  assert.equal(runtime.authorizeContinuationGenerationDelivery({}).reason, "sender-capability-required");
  runtime.close(); runtime = undefined;
  runtime = new StructuredRuntimeState(stateDir);
  assert.equal(runtime.autoContinuationEnabled(), true, "policy must survive server restart");

  const bad = spawnSync(process.execPath, [manager, "set-auto-continuation"], {
    cwd: root, env, encoding: "utf8", input: '{"enabled":"false"}', timeout: 20_000,
  });
  assert.notEqual(bad.status, 0, "string-valued toggle must be rejected, not truthy-coerced");
  assert.equal(runtime.autoContinuationEnabled(), true);
  writeFileSync(settingsFile, "not valid JSON");
  assert.equal(runtime.autoContinuationEnabled(), false, "unreadable explicit policy must fail closed");
  assert.equal(invoke("set-auto-continuation", { enabled: false }).enabled, false);
  assert.equal(runtime.autoContinuationEnabled(), false);

  const native = readFileSync(join(root, "setup", "native", "DevSpacePortableApp.cs"), "utf8");
  assert.match(native, /headerActions\.Controls\.Add\(_computerUseToggle\);\s*headerActions\.Controls\.Add\(_autoContinuationToggle\);/);
  assert.match(native, /RunJsonAsync\("set-auto-continuation", new \{ enabled = enabled \}\)/);
  assert.match(native, /GetBool\(_currentConfig, "autoContinuationEnabled", true\)/);
  console.log(JSON.stringify({ defaultEnabled: true, disabledBlocksNewSynthetic: true,
    manualMcpStillAllowed: true, cardsUnchanged: true, enablesWithoutRestart: true,
    persistent: true, failClosed: true, nativeHeaderToggle: true, isolatedFromComputerUse: true }));
} finally {
  runtime?.close();
  if (originalEnv === undefined) delete process.env.DEVSPACE_PORTABLE_CONFIG_DIR;
  else process.env.DEVSPACE_PORTABLE_CONFIG_DIR = originalEnv;
  rmSync(sandbox, { recursive: true, force: true });
}
