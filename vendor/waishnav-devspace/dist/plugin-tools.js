import { dirname } from "node:path";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import * as z from "zod/v4";
import { buildCapabilities } from "./capabilities.js";
import { RESERVED_PLUGIN_SLOT_COUNT } from "./plugin-manager.js";
import { generateSchemaBundle, writeSchemaBundle } from "./schema-bundle.js";

const READ_ONLY_ANNOTATIONS = {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
};
const WRITE_ANNOTATIONS = {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
};
const SHELL_ANNOTATIONS = {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
};

function toolMetadata(config, invoking = "正在执行插件操作…", invoked = "插件操作已完成") {
    const securitySchemes = [{ type: "oauth2", scopes: [...config.oauth.scopes] }];
    return {
        securitySchemes,
        _meta: {
            securitySchemes,
            "openai/toolInvocation/invoking": invoking,
            "openai/toolInvocation/invoked": invoked,
        },
    };
}

export function synchronizePluginSkillRoots(config, pluginManager) {
    if (!Object.prototype.hasOwnProperty.call(config, "_devspaceBaseSkillPaths")) {
        Object.defineProperty(config, "_devspaceBaseSkillPaths", {
            value: [...(config.skillPaths ?? [])],
            enumerable: false,
            configurable: false,
            writable: false,
        });
    }
    config.skillPaths = Array.from(new Set([
        ...config._devspaceBaseSkillPaths,
        ...pluginManager.enabledSkillRoots(),
    ]));
    return config.skillPaths;
}

function textResult(value, extra = {}) {
    const result = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    return {
        content: [{ type: "text", text: result }],
        structuredContent: { result, ...extra },
    };
}

function primitiveParameters(parameters = {}) {
    const result = {};
    for (const [key, value] of Object.entries(parameters)) {
        if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
            result[key] = value;
            continue;
        }
        throw new Error(`Plugin parameter ${key} must be a string, number, boolean, or null.`);
    }
    return result;
}

function renderTemplate(value, variables) {
    if (typeof value !== "string")
        return value;
    return value.replace(/\$\{([a-zA-Z0-9_.-]+)\}|\{\{([a-zA-Z0-9_.-]+)\}\}/g, (_match, dollarName, braceName) => {
        const name = dollarName ?? braceName;
        if (!(name in variables))
            throw new Error(`Missing plugin template parameter: ${name}`);
        const replacement = variables[name];
        return replacement === null ? "" : String(replacement);
    });
}

function renderedEnvironment(environment, variables) {
    if (!environment)
        return undefined;
    return Object.fromEntries(Object.entries(environment).map(([key, value]) => [
        key,
        value === null ? null : renderTemplate(String(value), variables),
    ]));
}

function pluginProcessResponse(tool, snapshot) {
    const status = snapshot.running
        ? `Process ${snapshot.processHandle} is running.`
        : snapshot.signal
            ? `Process ${snapshot.processHandle} exited after signal ${snapshot.signal}.`
            : `Process ${snapshot.processHandle} exited with code ${snapshot.exitCode ?? "unknown"}.`;
    const result = snapshot.output ? `${snapshot.output.replace(/\n$/, "")}\n${status}` : status;
    return {
        content: [{ type: "text", text: result }],
        structuredContent: {
            result,
            pluginId: tool.pluginId,
            pluginVersion: tool.pluginVersion,
            ...(tool.reservedSlot ? {
                reservedSlot: tool.reservedSlot,
                reservedSlotName: tool.reservedSlotName,
            } : {}),
            processHandle: snapshot.processHandle,
            sessionId: snapshot.sessionId,
            running: snapshot.running,
            exitCode: snapshot.exitCode,
            signal: snapshot.signal,
            pid: snapshot.pid,
            wallTimeMs: snapshot.wallTimeMs,
        },
    };
}

export async function executePluginTool(tool, input, services) {
    const startedAt = performance.now();
    const { workspaces, processSessions, permissionRules, runtimeState } = services;
    const workspace = workspaces.getWorkspace(input.workspaceId);
    const manifestDirectory = dirname(tool.manifestPath);
    const values = {
        ...primitiveParameters(input.parameters),
        workspaceRoot: workspace.root,
        pluginDir: manifestDirectory,
        pluginId: tool.pluginId,
        pluginVersion: tool.pluginVersion,
    };
    const configuredWorkingDirectory = input.workingDirectory
        ?? (tool.workingDirectory ? renderTemplate(tool.workingDirectory, values) : undefined);
    const cwd = workspaces.resolveWorkingDirectory(workspace, configuredWorkingDirectory);
    values.cwd = cwd;
    const argv = tool.argv?.map((value) => renderTemplate(value, values));
    const cmd = tool.command ? renderTemplate(tool.command, values) : undefined;
    const env = renderedEnvironment(tool.env, values);
    const permissionDecision = permissionRules.evaluate({
        workspaceId: input.workspaceId,
        workspaceRoot: workspace.root,
        cwd,
        cmd,
        argv,
    });
    if (permissionDecision.decision === "deny")
        throw new Error(`Plugin command denied by permission rule ${permissionDecision.ruleId}.`);
    const snapshot = await processSessions.start({
        workspaceId: input.workspaceId,
        workspaceRoot: workspace.root,
        cwd,
        command: cmd,
        argv,
        env,
        processHandle: input.processHandle,
        persistent: tool.persistent ?? Boolean(input.processHandle),
        tty: Boolean(tool.tty),
        yieldTimeMs: input.yieldTimeMs,
    });
    runtimeState.recordToolCall({
        tool: input.auditToolName ?? tool.registeredName,
        pluginId: tool.pluginId,
        pluginTool: tool.name,
        pluginVersion: tool.pluginVersion,
        workspaceId: input.workspaceId,
        processHandle: snapshot.processHandle,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
        permissionRule: permissionDecision.ruleId,
        permissionDecision: permissionDecision.decision,
    });
    return pluginProcessResponse(tool, snapshot);
}

export function registerPluginDispatchTools(server, config, workspaces, processSessions, permissionRules, pluginManager, runtimeState) {
    const sharedInputSchema = {
        pluginId: z.string().describe("Enabled plugin id from plugin_list."),
        toolName: z.string().describe("Manifest tool name inside the selected plugin version."),
        workspaceId: z.string(),
        parameters: z.record(z.string(), z.unknown()).optional(),
        workingDirectory: z.string().optional(),
        processHandle: z.string().min(1).max(128).optional(),
        yieldTimeMs: z.number().int().min(0).max(30_000).optional(),
    };
    const sharedOutputSchema = {
        result: z.string(),
        pluginId: z.string(),
        pluginVersion: z.string(),
        processHandle: z.string(),
        sessionId: z.number().optional(),
        running: z.boolean(),
        exitCode: z.number().int().optional(),
        signal: z.string().optional(),
        pid: z.number().int().optional(),
        wallTimeMs: z.number().nonnegative(),
        reservedSlot: z.number().int().optional(),
        reservedSlotName: z.string().optional(),
    };
    registerAppTool(server, "plugin_query", {
        title: "Run read-only plugin tool",
        description: "Stable hot-plug dispatcher for enabled read-only plugin tools. The top-level MCP schema never changes when plugins are added, upgraded, enabled, or disabled. Call plugin_list to discover pluginId and toolName. This dispatcher refuses tools whose manifest does not declare readOnly=true.",
        inputSchema: sharedInputSchema,
        outputSchema: sharedOutputSchema,
        ...toolMetadata(config, "正在运行只读插件工具…", "只读插件工具已完成"),
        annotations: READ_ONLY_ANNOTATIONS,
    }, async (input) => {
        const tool = pluginManager.resolveTool(input.pluginId, input.toolName);
        if (tool.readOnly !== true)
            throw new Error(`Plugin tool ${input.pluginId}/${input.toolName} is not read-only; use plugin_action.`);
        return executePluginTool(tool, { ...input, auditToolName: "plugin_query" }, {
            workspaces, processSessions, permissionRules, runtimeState,
        });
    });
    registerAppTool(server, "plugin_action", {
        title: "Run modifying plugin tool",
        description: "Stable hot-plug dispatcher for enabled plugin actions that may modify local or remote state. The top-level MCP schema never changes when plugins are added, upgraded, enabled, or disabled. Call plugin_list to discover pluginId and toolName. This dispatcher refuses tools whose manifest declares readOnly=true.",
        inputSchema: sharedInputSchema,
        outputSchema: sharedOutputSchema,
        ...toolMetadata(config, "正在运行插件操作…", "插件操作已完成"),
        annotations: SHELL_ANNOTATIONS,
    }, async (input) => {
        const tool = pluginManager.resolveTool(input.pluginId, input.toolName);
        if (tool.readOnly === true)
            throw new Error(`Plugin tool ${input.pluginId}/${input.toolName} is read-only; use plugin_query.`);
        return executePluginTool(tool, { ...input, auditToolName: "plugin_action" }, {
            workspaces, processSessions, permissionRules, runtimeState,
        });
    });
}

export function registerReservedPluginSlots(server, config, workspaces, processSessions, permissionRules, pluginManager, runtimeState) {
    const inputSchema = {
        workspaceId: z.string().describe("Workspace used by the locally bound plugin tool."),
        parameters: z.record(z.string(), z.unknown()).optional().describe("Primitive manifest template parameters. The slot cannot choose a plugin, tool, command, argv, or environment."),
        workingDirectory: z.string().optional(),
        processHandle: z.string().min(1).max(128).optional(),
        yieldTimeMs: z.number().int().min(0).max(30_000).optional(),
    };
    const outputSchema = {
        result: z.string(),
        pluginId: z.string(),
        pluginVersion: z.string(),
        reservedSlot: z.number().int(),
        reservedSlotName: z.string(),
        processHandle: z.string(),
        sessionId: z.number().optional(),
        running: z.boolean(),
        exitCode: z.number().int().optional(),
        signal: z.string().optional(),
        pid: z.number().int().optional(),
        wallTimeMs: z.number().nonnegative(),
    };
    for (let slot = 1; slot <= RESERVED_PLUGIN_SLOT_COUNT; slot += 1) {
        const slotName = `plugin_slot_${String(slot).padStart(2, "0")}`;
        registerAppTool(server, slotName, {
            title: `Reserved plugin slot ${String(slot).padStart(2, "0")}`,
            description: `Fixed-schema reserved plugin interface ${String(slot).padStart(2, "0")}. It executes only the enabled plugin tool explicitly bound from the local DevSpace Portable UI. The binding is pinned to plugin version and content hash; unbound, disabled, upgraded, modified, or removed plugins fail closed. This tool never accepts pluginId, toolName, cmd, argv, or env.`,
            inputSchema,
            outputSchema,
            ...toolMetadata(config, `正在运行预留插件接口 ${String(slot).padStart(2, "0")}…`, `预留插件接口 ${String(slot).padStart(2, "0")} 已完成`),
            annotations: SHELL_ANNOTATIONS,
        }, async (input) => {
            const tool = pluginManager.resolveSlot(slot);
            return executePluginTool(tool, { ...input, auditToolName: slotName }, {
                workspaces,
                processSessions,
                permissionRules,
                runtimeState,
            });
        });
    }
}

export function registerPluginManagementTools(server, config, workspaces, pluginManager) {
    registerAppTool(server, "plugin_list", {
        title: "List plugins",
        description: "List cached local DevSpace plugins, selected versions, enablement state, dynamic tools, maturity, and Skill roots.",
        inputSchema: {},
        outputSchema: { result: z.string(), plugins: z.array(z.unknown()), slots: z.array(z.unknown()) },
        ...toolMetadata(config, "正在读取插件列表…", "插件列表已读取"),
        annotations: READ_ONLY_ANNOTATIONS,
    }, async () => {
        const plugins = pluginManager.list();
        const slots = pluginManager.slots();
        return textResult({ plugins, slots }, { plugins, slots });
    });
    registerAppTool(server, "plugin_read", {
        title: "Read plugin",
        description: "Read one cached plugin manifest and selected version. Sensitive manifest fields are redacted.",
        inputSchema: { pluginId: z.string() },
        outputSchema: { result: z.string(), plugin: z.unknown() },
        ...toolMetadata(config, "正在读取插件信息…", "插件信息已读取"),
        annotations: READ_ONLY_ANNOTATIONS,
    }, async ({ pluginId }) => {
        const plugin = pluginManager.read(pluginId);
        return textResult(plugin, { plugin });
    });
    registerAppTool(server, "plugin_refresh", {
        title: "Refresh plugin cache",
        description: "Rescan data/plugins/installed and refresh the SQLite plugin version cache.",
        inputSchema: {},
        outputSchema: { result: z.string(), plugins: z.array(z.unknown()), reconnectRequired: z.boolean(), dynamicToolRefreshRequired: z.boolean() },
        ...toolMetadata(config, "正在刷新插件缓存…", "插件缓存已刷新"),
        annotations: WRITE_ANNOTATIONS,
    }, async () => {
        const plugins = pluginManager.refresh();
        const skillPaths = synchronizePluginSkillRoots(config, pluginManager);
        return textResult({ plugins, skillPaths, reconnectRequired: false, dynamicToolRefreshRequired: false }, {
            plugins,
            reconnectRequired: false,
            dynamicToolRefreshRequired: false,
        });
    });
    for (const enabled of [true, false]) {
        const name = enabled ? "plugin_enable" : "plugin_disable";
        registerAppTool(server, name, {
            title: enabled ? "Enable plugin" : "Disable plugin",
            description: `${enabled ? "Enable" : "Disable"} a cached plugin. plugin_query/plugin_action use the new state immediately. A refreshed MCP action snapshot is only needed when the optional per-plugin top-level dynamic tools are desired.`,
            inputSchema: {
                pluginId: z.string(),
                version: z.string().optional().describe("Optional selected version when enabling."),
            },
            outputSchema: { result: z.string(), plugin: z.unknown(), reconnectRequired: z.boolean(), dynamicToolRefreshRequired: z.boolean() },
            ...toolMetadata(config, enabled ? "正在启用插件…" : "正在禁用插件…", enabled ? "插件已启用" : "插件已禁用"),
            annotations: WRITE_ANNOTATIONS,
        }, async ({ pluginId, version }) => {
            const plugin = pluginManager.setEnabled(pluginId, enabled, enabled ? version : undefined);
            synchronizePluginSkillRoots(config, pluginManager);
            const response = { ...plugin, reconnectRequired: false, dynamicToolRefreshRequired: false };
            return textResult(response, { plugin: response, reconnectRequired: false, dynamicToolRefreshRequired: false });
        });
    }
    registerAppTool(server, "capabilities", {
        title: "DevSpace capabilities",
        description: "Return the DevSpace protocol version, server version, feature maturity catalog, permission profile, tool mode, and plugin capabilities.",
        inputSchema: {},
        outputSchema: { result: z.string(), capabilities: z.unknown() },
        ...toolMetadata(config, "正在读取 DevSpace 能力…", "DevSpace 能力已读取"),
        annotations: READ_ONLY_ANNOTATIONS,
    }, async () => {
        const capabilities = buildCapabilities(config, pluginManager);
        return textResult(capabilities, { capabilities });
    });
    registerAppTool(server, "schema_generate", {
        title: "Generate schemas",
        description: "Generate a JSON Schema bundle for DevSpace plugin manifests, permission rules, features, protocol versions, and current dynamic plugin tools.",
        inputSchema: {
            workspaceId: z.string().describe("Workspace where the schema bundle will be written."),
            path: z.string().optional().describe("Destination path. Defaults to .devspace/devspace-schema-bundle.json."),
        },
        outputSchema: { result: z.string(), path: z.string(), bundle: z.unknown() },
        ...toolMetadata(config, "正在生成 Schema…", "Schema 已生成"),
        annotations: WRITE_ANNOTATIONS,
    }, async ({ workspaceId, path }) => {
        const workspace = workspaces.getWorkspace(workspaceId);
        const absolutePath = workspaces.resolvePath(workspace, path ?? ".devspace/devspace-schema-bundle.json");
        const bundle = generateSchemaBundle(pluginManager);
        await writeSchemaBundle(absolutePath, bundle);
        return textResult({ path: absolutePath, bundle }, { path: absolutePath, bundle });
    });
}

export function registerDynamicPluginTools(server, config, workspaces, processSessions, permissionRules, pluginManager, runtimeState) {
    for (const tool of pluginManager.dynamicTools()) {
        registerAppTool(server, tool.registeredName, {
            title: tool.title ?? `${tool.pluginId}: ${tool.name}`,
            description: `${tool.description ?? "Run a local DevSpace plugin tool."} Plugin ${tool.pluginId}@${tool.pluginVersion}; maturity=${tool.maturity}.`,
            inputSchema: {
                workspaceId: z.string(),
                parameters: z.record(z.string(), z.unknown()).optional(),
                workingDirectory: z.string().optional(),
                processHandle: z.string().min(1).max(128).optional(),
                yieldTimeMs: z.number().int().min(0).max(30_000).optional(),
            },
            outputSchema: {
                result: z.string(),
                pluginId: z.string(),
                pluginVersion: z.string(),
                processHandle: z.string(),
                sessionId: z.number().optional(),
                running: z.boolean(),
                exitCode: z.number().int().optional(),
                signal: z.string().optional(),
                pid: z.number().int().optional(),
                wallTimeMs: z.number().nonnegative(),
            },
            ...toolMetadata(config, "正在运行动态插件工具…", "动态插件工具已完成"),
            annotations: tool.readOnly ? READ_ONLY_ANNOTATIONS : SHELL_ANNOTATIONS,
        }, async ({ workspaceId, parameters, workingDirectory, processHandle, yieldTimeMs }) => {
            const startedAt = performance.now();
            const activePlugin = pluginManager.list().find((plugin) => plugin.id === tool.pluginId);
            if (!activePlugin?.enabled || activePlugin.selectedVersion !== tool.pluginVersion) {
                throw new Error(`Plugin ${tool.pluginId}@${tool.pluginVersion} is no longer active. Start a new MCP session to refresh the tool list.`);
            }
            const workspace = workspaces.getWorkspace(workspaceId);
            const manifestDirectory = dirname(tool.manifestPath);
            const values = {
                ...primitiveParameters(parameters),
                workspaceRoot: workspace.root,
                pluginDir: manifestDirectory,
                pluginId: tool.pluginId,
                pluginVersion: tool.pluginVersion,
            };
            const configuredWorkingDirectory = workingDirectory
                ?? (tool.workingDirectory ? renderTemplate(tool.workingDirectory, values) : undefined);
            const cwd = workspaces.resolveWorkingDirectory(workspace, configuredWorkingDirectory);
            values.cwd = cwd;
            const argv = tool.argv?.map((value) => renderTemplate(value, values));
            const cmd = tool.command ? renderTemplate(tool.command, values) : undefined;
            const env = renderedEnvironment(tool.env, values);
            const permissionDecision = permissionRules.evaluate({
                workspaceId,
                workspaceRoot: workspace.root,
                cwd,
                cmd,
                argv,
            });
            if (permissionDecision.decision === "deny")
                throw new Error(`Plugin command denied by permission rule ${permissionDecision.ruleId}.`);
            const snapshot = await processSessions.start({
                workspaceId,
                workspaceRoot: workspace.root,
                cwd,
                command: cmd,
                argv,
                env,
                processHandle,
                persistent: tool.persistent ?? Boolean(processHandle),
                tty: Boolean(tool.tty),
                yieldTimeMs,
            });
            runtimeState.recordToolCall({
                tool: tool.registeredName,
                pluginId: tool.pluginId,
                pluginVersion: tool.pluginVersion,
                workspaceId,
                processHandle: snapshot.processHandle,
                success: true,
                durationMs: Math.round(performance.now() - startedAt),
                permissionRule: permissionDecision.ruleId,
                permissionDecision: permissionDecision.decision,
            });
            return pluginProcessResponse(tool, snapshot);
        });
    }
}
