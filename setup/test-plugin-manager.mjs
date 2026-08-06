import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = new URL("../", import.meta.url).pathname.replace(/^\/(?:([A-Za-z]):)/, "$1:");
const NODE = join(ROOT, "runtime", "node", "node.exe");
const MANAGER = join(ROOT, "setup", "portable-manager.cjs");
const PLUGIN_MANAGER_URL = new URL("../app/node_modules/@waishnav/devspace/dist/plugin-manager.js", import.meta.url).href;
const PLUGIN_TOOLS_URL = new URL("../app/node_modules/@waishnav/devspace/dist/plugin-tools.js", import.meta.url).href;

function manifest(id, version = "1.0.0") {
  return JSON.stringify({
    id,
    version,
    maturity: "stable",
    enabledByDefault: false,
    tools: [
      { name: "probe", readOnly: true, argv: ["cmd.exe", "/d", "/c", "echo", "${value}"] },
      { name: "act", readOnly: false, argv: ["cmd.exe", "/d", "/c", "echo", "ACTION"] },
    ],
  });
}

function run(file, args, options = {}) {
  const result = spawnSync(file, args, { encoding: "utf8", windowsHide: true, ...options });
  if (result.status !== 0) throw new Error(`${file} failed: ${result.stdout}${result.stderr}`);
  return String(result.stdout).trim();
}

const base = mkdtempSync(join(tmpdir(), "devspace-plugin-manager-"));
try {
  const source = join(base, "source");
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "manifest.json"), manifest("test-plugin"), "utf8");
  process.env.DEVSPACE_PLUGIN_ROOT = join(base, "plugins", "installed");
  const { PluginManager } = await import(PLUGIN_MANAGER_URL);
  const { registerReservedPluginSlots } = await import(PLUGIN_TOOLS_URL);
  const manager = new PluginManager({ stateDir: join(base, "state") });
  try {
    manager.installFromPath(source);
    manager.setEnabled("test-plugin", true, "1.0.0");
    manager.bindSlot(1, "test-plugin", "probe");
    if (manager.slots()[0].status !== "ready") throw new Error("slot did not become ready");

    const registered = [];
    let starts = 0;
    registerReservedPluginSlots(
      { registerTool(name, definition, handler) { registered.push({ name, definition, handler }); } },
      { oauth: { scopes: ["devspace"] } },
      { getWorkspace() { return { root: base }; }, resolveWorkingDirectory() { return base; } },
      { async start(input) {
        starts += 1;
        if (input.argv.at(-1) !== "hello") throw new Error("template parameter was not rendered");
        return { processHandle: "slot-test", running: false, exitCode: 0, pid: 1, wallTimeMs: 1, output: "OK\n" };
      } },
      { evaluate() { return { decision: "allow", ruleId: "test" }; } },
      manager,
      { recordToolCall() {} },
    );
    if (registered.length !== 16) throw new Error("reserved slot tool count mismatch");
    for (const tool of registered) {
      const keys = Object.keys(tool.definition.inputSchema ?? {});
      for (const forbidden of ["pluginId", "toolName", "cmd", "argv", "env"]) {
        if (keys.includes(forbidden)) throw new Error(`${tool.name} exposes ${forbidden}`);
      }
    }
    const response = await registered[0].handler({ workspaceId: "ws", parameters: { value: "hello" } });
    if (response.structuredContent.reservedSlot !== 1 || starts !== 1) throw new Error("reserved slot execution failed");

    appendFileSync(join(base, "plugins", "installed", "test-plugin", "1.0.0", "manifest.json"), "\n");
    manager.refresh();
    if (manager.slots()[0].status !== "content-changed") throw new Error("content hash pin did not detect modification");
    let rejected = false;
    try { await registered[0].handler({ workspaceId: "ws", parameters: { value: "hello" } }); }
    catch { rejected = true; }
    if (!rejected || starts !== 1) throw new Error("stale slot did not fail before process start");
    manager.uninstall("test-plugin");
  }
  finally {
    manager.close();
  }

  const adminSource = join(base, "admin-source");
  mkdirSync(adminSource, { recursive: true });
  writeFileSync(join(adminSource, "manifest.json"), manifest("admin-plugin"), "utf8");
  const adminEnv = {
    ...process.env,
    DEVSPACE_PORTABLE_STATE_DIR: join(base, "admin-state"),
    DEVSPACE_PLUGIN_ROOT: join(base, "admin-plugins", "installed"),
  };
  const callAdmin = (command, payload = {}) => JSON.parse(run(NODE, [MANAGER, command], {
    env: adminEnv,
    input: JSON.stringify(payload),
  }) || "{}");
  callAdmin("plugin-install", { sourcePath: adminSource });
  callAdmin("plugin-enable", { pluginId: "admin-plugin", version: "1.0.0" });
  callAdmin("plugin-slot-bind", { slot: 16, pluginId: "admin-plugin", toolName: "probe" });
  const listed = callAdmin("plugin-list");
  if (listed.plugins.length !== 1 || listed.slots[15].status !== "ready") throw new Error("portable manager plugin interface failed");
  callAdmin("plugin-uninstall", { pluginId: "admin-plugin" });

  console.log(JSON.stringify({
    pluginInstall: true,
    pluginEnableDisable: true,
    reservedSlots: 16,
    safeSlotSchema: true,
    versionHashPin: true,
    failClosed: true,
    portableManagerInterface: true,
    uninstall: true,
  }));
}
finally {
  rmSync(base, { recursive: true, force: true });
}
