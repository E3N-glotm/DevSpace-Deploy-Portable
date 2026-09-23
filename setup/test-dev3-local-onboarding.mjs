import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// A real first-run backend exercise with isolated E-drive config/state.
// It never touches D-live or creates a second C-drive worktree.
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const reports = join(root, "reports");
mkdirSync(reports, { recursive: true });
const scratch = mkdtempSync(join(reports, ".tmp-dev3-local-"));
const configDir = join(scratch, "config");
const stateDir = join(scratch, "state");
const runDir = join(scratch, "run");
for (const d of [configDir, stateDir, runDir]) mkdirSync(d);
const env = {
  ...process.env,
  DEVSPACE_PORTABLE_CONFIG_DIR: configDir,
  DEVSPACE_PORTABLE_STATE_DIR: stateDir,
  DEVSPACE_PORTABLE_RUN_DIR: runDir,
};
function command(action, value) {
  const r = spawnSync(process.execPath,
    [join(root, "setup", "portable-manager.cjs"), action, "--ascii-json"],
    {cwd: root, env, encoding: "utf8", timeout: 90_000, input: value === undefined ? "" : JSON.stringify(value)},
  );
  if (r.status !== 0) throw new Error(action + " failed with code " + r.status + ": " + String(r.stderr || "").slice(0, 600));
  return JSON.parse(r.stdout);
}
try {
  const initial = command("show-config");
  assert.equal(initial.configured, false);
  const input = {
    localOnly: true, tunnelProvider: "ngrok", publicBaseUrl: "", port: 17676,
    allowedRoots: [join(root, "setup")], permissions: {profile: "workspace"},
    toolMode: "full",
  };
  const created = command("configure", input);
  assert.equal(created.ok, true);
  assert.equal(created.generatedOwnerToken, true);
  assert.equal(created.mcpUrl, "http://127.0.0.1:17676/mcp");
  const saved = command("show-config");
  assert.equal(saved.localOnly, true);
  assert.equal(saved.configured, true);
  assert.equal(saved.hasOwnerToken, true);
  assert.equal(saved.hasNgrokToken, false);
  assert.equal(saved.hasCloudflareToken, false);
  assert.equal(saved.mcpUrl, created.mcpUrl);
  assert.equal(saved.publicBaseUrl, "");
  assert.equal(JSON.parse(readFileSync(join(configDir, "config.json"), "utf8")).publicBaseUrl,
    "http://127.0.0.1:17676");
  assert.equal(saved.permissions.profile, "workspace");
  assert.deepEqual(saved.allowedRoots, input.allowedRoots);
  const originalToken = JSON.parse(readFileSync(join(configDir, "auth.json"), "utf8")).ownerToken;
  assert.ok(originalToken.length >= 16);
  const again = command("configure", {...input, port: 17677});
  assert.equal(again.generatedOwnerToken, false);
  assert.equal(again.ownerToken, null);
  assert.equal(JSON.parse(readFileSync(join(configDir, "auth.json"), "utf8")).ownerToken, originalToken);
  assert.equal(command("show-config").port, 17677);
  assert.ok(existsSync(join(configDir, "deployment.json")));
  console.log(JSON.stringify({
    localFirstRunWithoutPublicDomainOrTunnelToken: true,
    initialOwnerGenerated: true,
    existingOwnerKeptWithoutRendererSecret: true,
    permissionsAndFolderRetained: true,
  }));
} finally {
  rmSync(scratch, {recursive: true, force: true, maxRetries: 3, retryDelay: 250});
}
