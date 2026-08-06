#!/usr/bin/env node
import { resolve } from "node:path";
import { loadConfig } from "./node_modules/@waishnav/devspace/dist/config.js";
import { PluginManager } from "./node_modules/@waishnav/devspace/dist/plugin-manager.js";
import { executePluginTool } from "./node_modules/@waishnav/devspace/dist/plugin-tools.js";
import { StructuredRuntimeState } from "./node_modules/@waishnav/devspace/dist/runtime-state.js";
import { PermissionRuleEngine } from "./node_modules/@waishnav/devspace/dist/permission-rules.js";
import { ProcessSessionManager } from "./node_modules/@waishnav/devspace/dist/process-sessions.js";
import { createWorkspaceStore } from "./node_modules/@waishnav/devspace/dist/workspace-store.js";
import { WorkspaceRegistry } from "./node_modules/@waishnav/devspace/dist/workspaces.js";

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

function option(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}.`);
  return value;
}

function parseParameters(value) {
  if (!value) return undefined;
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("--parameters-json must contain one JSON object.");
  }
  return parsed;
}

function usage() {
  return [
    "DevSpace plugin dispatcher",
    "",
    "Usage:",
    "  DevSpace-Plugin.cmd list",
    "  DevSpace-Plugin.cmd refresh",
    "  DevSpace-Plugin.cmd query <pluginId> <toolName> --workspace <path> [--parameters-json <json>] [--yield-ms <ms>] [--process-handle <name>]",
    "  DevSpace-Plugin.cmd action <pluginId> <toolName> --workspace <path> [--parameters-json <json>] [--yield-ms <ms>] [--process-handle <name>]",
    "",
    "query only runs manifest tools with readOnly=true; action refuses read-only tools.",
    "No SSH host, password, remote command, executable, or manifest command can be supplied through this CLI.",
  ].join("\n");
}

async function main(argv) {
  const [command, pluginId, toolName, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(usage());
    return;
  }

  const config = loadConfig();
  const runtimeState = new StructuredRuntimeState(config.stateDir);
  const pluginManager = new PluginManager(config, runtimeState);
  try {
    if (command === "list") {
      console.log(JSON.stringify(pluginManager.list(), null, 2));
      return;
    }
    if (command === "refresh") {
      console.log(JSON.stringify({
        plugins: pluginManager.refresh(),
        hotReloaded: true,
        appRefreshRequired: false,
      }, null, 2));
      return;
    }
    if (command !== "query" && command !== "action") {
      throw new Error(`Unknown plugin dispatcher command: ${command}`);
    }
    if (!pluginId || !toolName) throw new Error("pluginId and toolName are required.");
    const workspacePath = option(rest, "--workspace");
    if (!workspacePath) throw new Error("--workspace is required.");
    const parameters = parseParameters(option(rest, "--parameters-json"));
    const yieldText = option(rest, "--yield-ms");
    const yieldTimeMs = yieldText === undefined ? undefined : Number(yieldText);
    if (yieldTimeMs !== undefined && (!Number.isInteger(yieldTimeMs) || yieldTimeMs < 0 || yieldTimeMs > 30_000)) {
      throw new Error("--yield-ms must be an integer from 0 through 30000.");
    }
    const processHandle = option(rest, "--process-handle");
    const tool = pluginManager.resolveTool(pluginId, toolName);
    if (command === "query" && tool.readOnly !== true) {
      throw new Error(`Plugin tool ${pluginId}/${toolName} is not read-only; use action.`);
    }
    if (command === "action" && tool.readOnly === true) {
      throw new Error(`Plugin tool ${pluginId}/${toolName} is read-only; use query.`);
    }

    const workspaceStore = createWorkspaceStore(config.stateDir);
    const workspaces = new WorkspaceRegistry(config, workspaceStore);
    const opened = await workspaces.openWorkspace({ path: resolve(workspacePath), mode: "checkout" });
    const workspace = opened.workspace;
    const processSessions = new ProcessSessionManager({ stateDir: config.stateDir, runtimeState });
    const permissionRules = new PermissionRuleEngine(config, runtimeState);
    try {
      const response = await executePluginTool(tool, {
        workspaceId: workspace.id,
        parameters,
        processHandle,
        yieldTimeMs,
        auditToolName: `plugin_cli_${command}`,
      }, {
        workspaces,
        processSessions,
        permissionRules,
        runtimeState,
      });
      console.log(JSON.stringify(response.structuredContent, null, 2));
    } finally {
      workspaceStore.close();
    }
  } finally {
    pluginManager.close();
    runtimeState.close();
  }
}

main(process.argv.slice(2)).catch((error) => {
  fail(error instanceof Error ? error.stack ?? error.message : String(error));
});
