import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PluginManager } from "./node_modules/@waishnav/devspace/dist/plugin-manager.js";

const APP_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(APP_DIR, "..");
const STATE_DIR = process.env.DEVSPACE_PORTABLE_STATE_DIR
  ? resolve(process.env.DEVSPACE_PORTABLE_STATE_DIR)
  : join(ROOT, "data", "state");

async function readInput() {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text.trim() ? JSON.parse(text) : {};
}

function output(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function main() {
  const command = process.argv[2] ?? "list";
  const input = await readInput();
  const manager = new PluginManager({ stateDir: STATE_DIR });
  try {
    if (command === "list") {
      output({ plugins: manager.list(), slots: manager.slots() });
      return;
    }
    if (command === "refresh") {
      output({ plugins: manager.refresh(), slots: manager.slots(), reconnectRequired: false });
      return;
    }
    if (command === "install") {
      output({
        plugin: manager.installFromPath(input.sourcePath, { replace: input.replace === true }),
        plugins: manager.list(),
        slots: manager.slots(),
        reconnectRequired: false,
      });
      return;
    }
    if (command === "export") {
      output({
        result: manager.exportToPath(input.pluginId, input.version, input.destinationPath),
        plugins: manager.list(),
        slots: manager.slots(),
        reconnectRequired: false,
      });
      return;
    }
    if (command === "enable" || command === "disable") {
      const enabled = command === "enable";
      output({
        plugin: manager.setEnabled(input.pluginId, enabled, enabled ? input.version : undefined),
        plugins: manager.list(),
        slots: manager.slots(),
        reconnectRequired: false,
      });
      return;
    }
    if (command === "uninstall") {
      output({
        result: manager.uninstall(input.pluginId, input.version),
        plugins: manager.list(),
        slots: manager.slots(),
        reconnectRequired: false,
      });
      return;
    }
    if (command === "bind-slot") {
      output({
        slot: manager.bindSlot(input.slot, input.pluginId, input.toolName),
        plugins: manager.list(),
        slots: manager.slots(),
        reconnectRequired: false,
      });
      return;
    }
    if (command === "unbind-slot") {
      output({
        slot: manager.unbindSlot(input.slot),
        plugins: manager.list(),
        slots: manager.slots(),
        reconnectRequired: false,
      });
      return;
    }
    throw new Error(`Unknown plugin admin command: ${command}`);
  }
  finally {
    manager.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
