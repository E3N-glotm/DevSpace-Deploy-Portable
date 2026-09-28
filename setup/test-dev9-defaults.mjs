import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const reportsDir = join(root, "reports");
mkdirSync(reportsDir, { recursive: true });
const sandbox = mkdtempSync(join(reportsDir, ".tmp-dev9-defaults-"));
const configDir = join(sandbox, "config");
const stateDir = join(sandbox, "state");
mkdirSync(configDir);
mkdirSync(stateDir);

try {
  const result = spawnSync(process.execPath, [
    join(root, "setup", "portable-manager.cjs"), "show-config", "--ascii-json",
  ], {
    cwd: root,
    env: {
      ...process.env,
      DEVSPACE_PORTABLE_CONFIG_DIR: configDir,
      DEVSPACE_PORTABLE_STATE_DIR: stateDir,
      DEVSPACE_PORTABLE_RUN_DIR: join(sandbox, "run"),
    },
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const fresh = JSON.parse(result.stdout.trim());
  assert.equal(fresh.autoContinuationEnabled, false);
  assert.equal(fresh.toolMode, "codex");

  const manifest = JSON.parse(readFileSync(join(root, "VERSION-MANIFEST.json"), "utf8"));
  assert.equal(manifest.displayVersion, "1.1.62");
  assert.equal(manifest.development, undefined);
  assert.equal(manifest.toolModes?.default, "codex");

  const uiPackage = JSON.parse(readFileSync(join(root, "ui-next", "package.json"), "utf8"));
  assert.equal(uiPackage.version, "1.1.62");
  const app = readFileSync(join(root, "ui-next", "src", "App.tsx"), "utf8");
  const electron = readFileSync(join(root, "ui-next", "electron", "main.cjs"), "utf8");
  const native = readFileSync(join(root, "setup", "native", "DevSpacePortableApp.cs"), "utf8");
  const coreConfig = readFileSync(join(root, "vendor", "waishnav-devspace", "dist", "config.js"), "utf8");
  assert.match(app, /toolMode: c\.toolMode \|\| 'codex'/);
  assert.match(electron, /toolMode: input\.toolMode \|\| 'codex'/);
  assert.match(native, /GetString\(_currentConfig, "toolMode", "codex"\)/);
  assert.match(native, /SelectedItem \?\? "codex"/);
  assert.match(coreConfig, /function parseToolMode[\s\S]{0,700}return "codex";/);

  console.log(JSON.stringify({
    autoContinuationDefault: false,
    toolModeDefault: "codex",
    displayVersion: manifest.displayVersion,
    uiVersion: uiPackage.version,
  }));
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
