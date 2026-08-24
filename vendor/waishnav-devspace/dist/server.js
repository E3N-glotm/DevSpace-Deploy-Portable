import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { checkResourceAllowed, resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE, } from "@modelcontextprotocol/ext-apps/server";
import express from "express";
import * as z from "zod/v4";
import { applyHunks, applyPatch, countPatchStats, parsePatch, unifiedFilePatch } from "./apply-patch.js";
import { isArtifactDownloadSupportedPlatform, registerArtifactTools, } from "./artifact-tools.js";
import { loadConfig } from "./config.js";
import { createOpenAIIncomingArtifactAdapter, } from "./incoming-artifacts.js";
import { logEvent, requestIp, requestPath, commandPreview, sessionIdPrefix, } from "./logger.js";
import { editFileTool, findFilesTool, grepFilesTool, listDirectoryTool, readFileTool, runShellTool, writeFileTool, } from "./pi-tools.js";
import { SingleUserOAuthProvider } from "./oauth-provider.js";
import { McpSessionRegistry, } from "./mcp-sessions.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { runDoctor } from "./doctor.js";
import { StructuredRuntimeState } from "./runtime-state.js";
import { FileWatchManager } from "./file-watch.js";
import { PermissionRuleEngine } from "./permission-rules.js";
import { PluginManager } from "./plugin-manager.js";
import { registerDynamicPluginTools, registerPluginDispatchTools, registerPluginManagementTools, registerReservedPluginSlots, synchronizePluginSkillRoots } from "./plugin-tools.js";
import { redactValue } from "./redaction.js";
import { DEVSPACE_PROTOCOL_VERSION, DEVSPACE_SERVER_VERSION } from "./capabilities.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { UiSessionLease } from "./ui-session.js";
import { MemoryStore } from "./memory-store.js";
import { HookManager } from "./hook-manager.js";
import { registerFeatureTools } from "./feature-tools.js";
import { shutdownHttpServer } from "./server-shutdown.js";
import { formatPathForPrompt } from "./skills.js";
import { createWorkspaceStore } from "./workspace-store.js";
import { formatAgentsPath, isRemoteWorkspace, WorkspaceRegistry } from "./workspaces.js";
import { openAiConversationScopeId } from "./request-meta.js";
import { summarizeLocalAgentProfile } from "./local-agent-profiles.js";
import { formatLocalAgentProviderAvailabilitySummary, getLocalAgentProviderAvailabilitySnapshot, } from "./local-agent-availability.js";
import { linuxAgentAsset, RemoteAgentManager } from "./remote-agent-manager.js";
// MCP clients can reconnect without closing the previous transport. Bound stale
// session retention so abandoned MCP servers do not accumulate for the life of the process.
// Each MCP transport owns a complete McpServer/tool registration graph. A
// disconnected client is not guaranteed to send a close request, especially
// across tunnels/VPN changes, so keeping abandoned sessions for a full day can
// retain gigabytes of otherwise unreachable server state. Keep this cache
// explicitly bounded instead of increasing V8's heap limit.
const MCP_SESSION_IDLE_TIMEOUT_MS = 60 * 60 * 1_000;
const MCP_SESSION_CLEANUP_INTERVAL_MS = 60 * 1_000;
const MCP_SESSION_MAX_ACTIVE = 32;
const WORKSPACE_APP_URI = "ui://devspace/workspace-app.html";
const WORKSPACE_APP_MANIFEST_ENTRY = "workspace-app.html";
let structuredRuntimeState;
const WRITE_TOOL_ANNOTATIONS = {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
};
const EDIT_TOOL_ANNOTATIONS = {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
};
const SHELL_TOOL_ANNOTATIONS = {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
};
const READ_ONLY_TOOL_ANNOTATIONS = {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
};
function shouldAttachWidget(config, kind) {
    switch (config.widgets) {
        case "off":
            return false;
        case "changes":
            // Keep data-processing and mutation tools headless. ChatGPT renders every
            // MCP invocation in its own native activity stream, so attaching the same
            // iframe to open/read/run/edit calls only creates repeated cards. The final
            // show_changes call is the dedicated render tool for the consolidated
            // operation timeline, diff, and artifact previews.
            return kind === "show_changes";
        case "full":
            return true;
    }
}
function toolInvocationStatus(kind) {
    switch (kind) {
        case "workspace":
            return { invoking: "正在打开工作区…", invoked: "工作区已就绪" };
        case "runtime":
        case "shell":
            return { invoking: "正在运行命令…", invoked: "命令已完成" };
        case "read":
            return { invoking: "正在读取文件…", invoked: "文件读取完成" };
        case "write":
        case "edit":
            return { invoking: "正在修改文件…", invoked: "文件修改完成" };
        case "show_changes":
            return { invoking: "正在汇总文件变更…", invoked: "文件变更已汇总" };
        case "search":
            return { invoking: "正在搜索工作区…", invoked: "工作区搜索完成" };
        case "directory":
            return { invoking: "正在查看目录…", invoked: "目录读取完成" };
        default:
            return { invoking: "正在执行 DevSpace 操作…", invoked: "DevSpace 操作已完成" };
    }
}
function toolWidgetDescriptorMeta(config, kind) {
    const securitySchemes = [
        {
            type: "oauth2",
            scopes: [...config.oauth.scopes],
        },
    ];
    const status = toolInvocationStatus(kind);
    const baseMeta = {
        securitySchemes,
        "openai/toolInvocation/invoking": status.invoking,
        "openai/toolInvocation/invoked": status.invoked,
    };
    if (!shouldAttachWidget(config, kind)) {
        return {
            securitySchemes,
            _meta: baseMeta,
        };
    }
    return {
        securitySchemes,
        _meta: {
            ...baseMeta,
            ui: {
                resourceUri: WORKSPACE_APP_URI,
                visibility: ["model"],
            },
            // ChatGPT compatibility alias. The standards-first ui.resourceUri field
            // remains authoritative, but this improves rendering on older snapshots.
            "openai/outputTemplate": WORKSPACE_APP_URI,
        },
    };
}
const toolNames = {
    openWorkspace: "open_workspace",
    read: "read",
    attachment: "read_attachment",
    write: "write",
    edit: "edit",
    grep: "grep",
    glob: "glob",
    ls: "ls",
    shell: "bash",
};
function permissionInstruction(config) {
    const permissions = config.permissions;
    if (permissions.profile === "full-access") {
        return "The owner has explicitly enabled full local-user access on the Windows control plane. Local commands may use any current-user-accessible Windows path. Remote Linux workspaces follow each enrolled Agent's own remote access mode and the Linux service user's OS permissions. Commands may perform requested network access, credential-manager access, shell-based file changes, installers, package managers, and long-running or interactive processes within the active backend's OS boundary. This does not grant administrator, SYSTEM, UAC-elevated, root, or sudo privileges.";
    }
    if (permissions.profile === "custom") {
        const enabled = [
            permissions.allowExternalPaths ? "external paths" : undefined,
            permissions.allowArbitraryCommands ? "arbitrary commands" : undefined,
            permissions.allowShellMutation ? "shell file mutation" : undefined,
            permissions.allowNetworkAccess ? "network and SSH access" : undefined,
            permissions.allowCredentialAccess ? "credential API access" : undefined,
            permissions.allowInteractiveProcesses ? "interactive PTY processes" : undefined,
            permissions.allowPersistentProcesses ? "persistent process sessions" : undefined,
        ].filter(Boolean);
        const disabled = [
            !permissions.allowExternalPaths ? "external paths" : undefined,
            !permissions.allowArbitraryCommands ? "arbitrary commands outside ordinary coding workflows" : undefined,
            !permissions.allowShellMutation ? "shell file mutation" : undefined,
            !permissions.allowNetworkAccess ? "network and SSH access" : undefined,
            !permissions.allowCredentialAccess ? "credential API access" : undefined,
            !permissions.allowInteractiveProcesses ? "interactive PTY processes" : undefined,
            !permissions.allowPersistentProcesses ? "persistent process sessions" : undefined,
        ].filter(Boolean);
        return `The owner selected a custom permission profile. Enabled: ${enabled.join(", ") || "none"}. Disabled: ${disabled.join(", ") || "none"}. Follow those owner-selected capability declarations.`;
    }
    return "The workspace permission profile is active. Keep file paths inside the opened workspace, prefer structured file tools for changes, and use command tools for ordinary coding, inspection, build, test, package, and version-control workflows.";
}
function commandToolDescription(config, toolName) {
    if (config.permissions.allowArbitraryCommands) {
        return `Run a command in the opened workspace backend. Local workspaces execute as the current Windows user; remote-agent workspaces execute directly on the selected Linux host as the Agent service user, without SSH/SFTP. The owner has authorized arbitrary host commands, network operations, credential helpers, shell-based file changes, installers, and long-running or interactive processes when requested. Use tty=true for commands that require a real console. Call open_workspace first and pass workspaceId. Windows ACLs/UAC apply locally; Linux allowedRoots and the Agent user's permissions apply remotely.`;
    }
    const mutation = config.permissions.allowShellMutation
        ? "Shell-based file changes are authorized."
        : "Prefer structured write/edit/apply_patch tools for file changes.";
    return `Run a command inside an open workspace for coding, inspection, tests, builds, package scripts, version control, and other owner-authorized operations. ${mutation} Call open_workspace first and pass workspaceId.`;
}
function workingDirectoryDescription(config) {
    return config.permissions.allowExternalPaths
        ? "Working directory. Relative paths resolve from the workspace root. Local absolute paths may use current-user-accessible Windows locations; remote absolute paths remain confined to the opened Linux workspace root. Defaults to the workspace root."
        : "Working directory relative to the workspace root. Remote Linux paths remain confined by the opened workspace and Agent allowedRoots. Defaults to the workspace root.";
}
function serverInstructions(config) {
    const artifactInstruction = config.artifactsEnabled && isArtifactDownloadSupportedPlatform()
        ? " When the user supplies or generates a file that is not present on the DevSpace host, use download_artifact with its native file value, the existing workspace ID, and a suitable relative destination path chosen from the user's request and project structure. The tool refuses to overwrite an existing destination and returns the normalized workspace-relative path. Use normal workspace tools when explicit inspection, replacement, movement, renaming, or deletion is needed. Do not recreate binary files with write/edit calls or place signed URLs, native file objects, base64 content, or invented host paths in shell commands or logs."
        : "";
    const showChangesInstruction = config.widgets !== "off"
        ? " If the turn successfully modifies files by creating, editing, overwriting, deleting, moving, or applying patches, call show_changes exactly once for that workspace after the final related file change and before your final response so the user can inspect the aggregate diff for that turn. Do not call it after every individual file change; do not skip it because individual file-change tools already returned diffs."
        : "";
    const permissions = permissionInstruction(config);
    const featureInstruction = [
        config.features?.memories
            ? " Explicit DevSpace memories are user-managed local records returned by open_workspace or memory_list; use them only when relevant and never infer or save a memory without an explicit memory_upsert call."
            : "",
        config.features?.hooks
            ? " Configured lifecycle hooks run deterministically around workspace, command, mutation, review, and rollback events; do not simulate hooks with ad-hoc shell commands."
            : "",
        config.features?.computerUse && config.permissions.allowComputerUse
            ? " Computer Use is available only while the local Portable UI is open. Use computer_snapshot before coordinate-based actions, keep actions bounded and user-directed, and prefer workspace/file tools for code and file operations."
            : "",
        config.features?.uiSessionReview
            ? " show_changes also reports aggregate changes since the persisted workspace session captured its first structured-mutation baseline. Session rollback restores the tracked structured paths, creates a pre-rollback safety snapshot, and requires the exact confirmation token returned by the review result. The same bounded sparse-journal model is used for local and remote-agent workspaces; arbitrary shell side effects outside tracked paths are not claimed as rollback-safe."
            : "",
    ].join("");
    const compactActivityInstruction = " Keep tool calls task-driven and minimal because the client may expose every MCP invocation and its JSON arguments in a native activity panel. Do not call capabilities, doctor, session_list, session_resume, or show_changes merely to demonstrate or test the UI. Do not issue no-op diagnostics after the required result is already known. Use show_changes only once after actual file modifications.";
    if (config.toolMode === "codex") {
        return `Use DevSpace as a local-or-remote coding workspace. Call ${toolNames.openWorkspace} once per project folder or worktree and reuse its workspaceId. Remote Linux projects use devspace://<agent-id-or-name>/absolute/linux/path and then use the same tools as local projects; do not fall back to SSH merely because the workspace is remote. Use ${toolNames.read} for direct file reads, apply_patch for structured multi-file modifications, exec_command for commands, and write_stdin to poll or interact with running processes. ${permissions} Follow instructions returned by ${toolNames.openWorkspace}; read applicable instruction files before working in their scope.${featureInstruction}${artifactInstruction}${showChangesInstruction}${compactActivityInstruction}`;
    }
    const inspection = config.toolMode !== "full"
        ? `In minimal tool mode, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} are disabled; use ${toolNames.shell} with command-line tools such as grep, rg, find, ls, and tree for search and directory inspection. `
        : `Prefer ${toolNames.read}, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} for file inspection. `;
    const skills = config.skillsEnabled
        ? `When ${toolNames.openWorkspace} returns available skills and a task matches a skill, use ${toolNames.read} to read that skill's path before proceeding. Skill paths may be outside the workspace, but ${toolNames.read} only permits advertised SKILL.md files and files under already-loaded skill directories. `
        : "";
    const agentsMd = `Follow instructions returned by ${toolNames.openWorkspace}. Before working under a path listed in availableAgentsFiles, use ${toolNames.read} to inspect that instruction file and follow it. `;
    const shellGuidance = config.permissions.allowArbitraryCommands
        ? `${toolNames.shell} may run arbitrary owner-requested commands in the active workspace backend: current Windows user for local workspaces, Linux Agent service user for remote workspaces. `
        : `Prefer ${toolNames.edit} for targeted modifications, ${toolNames.write} only for new files or complete rewrites, and ${toolNames.shell} for tests, builds, git inspection, package scripts, and commands that are better executed by the shell. `;
    return `Use DevSpace as a local-or-remote coding workspace. Remote Linux projects use devspace://<agent-id-or-name>/absolute/linux/path and remain transparent after open_workspace: reuse the returned workspaceId with the same file/search/edit/review/process tools instead of opening SSH/SFTP sessions. Call ${toolNames.openWorkspace} once per project folder or worktree to obtain a workspaceId. Reuse that same workspaceId for all later file, search, edit, write, show-changes, and shell tools in that folder; do not call ${toolNames.openWorkspace} again unless switching folders/worktrees, changing checkout/worktree mode, the workspaceId is rejected as unknown, or the user explicitly asks to reopen. ${agentsMd}${skills}${inspection}${shellGuidance}${permissions}${featureInstruction}${artifactInstruction}${showChangesInstruction}${compactActivityInstruction}`;
}
function formatVisibleAgent(agent) {
    const model = agent.model ? `, model ${agent.model}` : "";
    const thinking = agent.thinking ? `, thinking ${agent.thinking}` : "";
    const availability = agent.providerAvailable === false
        ? `, unavailable: ${agent.providerUnavailableReason ?? "provider unavailable"}`
        : "";
    return `${agent.name} (${agent.provider}${model}${thinking}${availability})`;
}
function formatUnavailableAgentProvider(provider) {
    return `${provider.name} (${provider.reason ?? "unavailable"})`;
}
function resultOutputSchema(extra = {}) {
    return {
        result: z
            .string()
            .describe("Model-readable result text for follow-up reasoning and plain MCP hosts."),
        ...extra,
    };
}
const workspaceSkillOutputSchema = z.object({
    name: z.string(),
    description: z.string(),
    path: z.string(),
});
const workspaceAgentsFileOutputSchema = z.object({
    path: z.string(),
    content: z.string(),
});
const workspaceLocalAgentOutputSchema = z.object({
    name: z.string(),
    description: z.string(),
    provider: z.string(),
    model: z.string().optional(),
    thinking: z.string().optional(),
    providerAvailable: z.boolean().optional(),
    providerUnavailableReason: z.string().optional(),
});
const workspaceLocalAgentProviderOutputSchema = z.object({
    name: z.string(),
    available: z.boolean(),
    reason: z.string().optional(),
});
const workspaceAvailableAgentsFileOutputSchema = z.object({
    path: z.string(),
});
const remoteWorkspaceAgentOutputSchema = z.object({
    id: z.string(),
    name: z.string(),
    status: z.string(),
    hostname: z.string().optional(),
    agentVersion: z.string().optional(),
    allowedRoots: z.array(z.string()),
    writableRoots: z.array(z.string()).optional(),
    accessMode: z.enum(["scoped", "full-access"]).optional(),
    installRoot: z.string().optional(),
    system: z.unknown().optional(),
});
const reviewFileOutputSchema = z.object({
    path: z.string(),
    previousPath: z.string().optional(),
    type: z.enum(["change", "rename-pure", "rename-changed", "new", "deleted"]),
    additions: z.number(),
    removals: z.number(),
});
const reviewSummaryOutputSchema = z.object({
    files: z.number(),
    additions: z.number(),
    removals: z.number(),
});
function sendJsonRpcError(res, status, code, message) {
    res.status(status).json({
        jsonrpc: "2.0",
        error: { code, message },
        id: null,
    });
}
function requestLogFields(req, config) {
    return {
        ip: requestIp(req, config.logging.trustProxy),
        host: req.header("host"),
        userAgent: req.header("user-agent"),
        origin: req.header("origin"),
        referer: req.header("referer"),
        contentLength: req.header("content-length"),
    };
}
function logToolCall(config, fields) {
    structuredRuntimeState?.recordToolCall(fields);
    if (!config.logging.toolCalls)
        return;
    const { command, ...safeFields } = fields;
    logEvent(config.logging, fields.success ? "info" : "warn", "tool_call", {
        ...safeFields,
        commandPreview: config.logging.shellCommands && command ? commandPreview(command) : undefined,
    });
}
function contentText(content) {
    return content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n");
}
function toolErrorPreview(content) {
    const text = contentText(content).replace(/\s+/g, " ").trim();
    if (!text)
        return undefined;
    return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}
function logFailedToolResponse(config, fields, content, startedAt) {
    logToolCall(config, {
        ...fields,
        success: false,
        durationMs: Math.round(performance.now() - startedAt),
        error: toolErrorPreview(content),
    });
}

async function prepareMutation(reviewCheckpoints, hookManager, context) {
    await reviewCheckpoints.beforeMutation({
        workspaceId: context.workspaceId,
        root: context.workspaceRoot,
        paths: context.paths ?? [],
        kind: context.kind ?? "structured",
    });
    if (context.kind !== "shell"
        && (hookManager.hasEvent("before_mutation") || hookManager.hasEvent("after_mutation"))) {
        await reviewCheckpoints.beforeMutation({
            workspaceId: context.workspaceId,
            root: context.workspaceRoot,
            kind: "shell",
        });
    }
    await hookManager.runEvent("before_mutation", {
        workspaceId: context.workspaceId,
        workspaceRoot: context.workspaceRoot,
        toolName: context.toolName,
    }, { strict: true });
}

async function finishMutation(reviewCheckpoints, hookManager, context) {
    await reviewCheckpoints.afterMutation({
        workspaceId: context.workspaceId,
        root: context.workspaceRoot,
        paths: context.paths ?? [],
        kind: context.kind ?? "structured",
        success: context.success,
    });
    await hookManager.runEvent("after_mutation", {
        workspaceId: context.workspaceId,
        workspaceRoot: context.workspaceRoot,
        toolName: context.toolName,
        success: context.success,
    });
}
function textBlock(text) {
    return { type: "text", text };
}
function textSummary(content) {
    const text = contentText(content);
    return {
        lines: text.length === 0 ? 0 : text.split("\n").length,
        characters: text.length,
    };
}
function contentLineCount(content) {
    if (content.length === 0)
        return 0;
    return content.endsWith("\n")
        ? content.slice(0, -1).split("\n").length
        : content.split("\n").length;
}
function countDiffStats(diff) {
    if (!diff)
        return { additions: 0, removals: 0 };
    let additions = 0;
    let removals = 0;
    for (const line of diff.split("\n")) {
        if (line.startsWith("+") && !line.startsWith("+++"))
            additions++;
        if (line.startsWith("-") && !line.startsWith("---"))
            removals++;
    }
    return { additions, removals };
}
function newFilePatch(path, content) {
    const lines = content.length === 0
        ? []
        : content.endsWith("\n")
            ? content.slice(0, -1).split("\n")
            : content.split("\n");
    const hunkLength = lines.length;
    const hunkRange = hunkLength === 0 ? "+0,0" : `+1,${hunkLength}`;
    const body = lines.map((line) => `+${line}`).join("\n");
    return [
        `diff --git a/${path} b/${path}`,
        "new file mode 100644",
        "index 0000000..0000000",
        "--- /dev/null",
        `+++ b/${path}`,
        `@@ -0,0 ${hunkRange} @@`,
        body,
    ]
        .filter((line) => line.length > 0)
        .join("\n");
}
function remoteTextToolResponse(text) {
    return { content: [textBlock(String(text ?? ""))], isError: false };
}
function decodeRemoteUtf8(buffer, displayPath) {
    try {
        const value = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
        if (value.includes("\0"))
            throw new Error("binary");
        return value;
    }
    catch {
        throw new Error(`Remote patch target is not valid UTF-8 text: ${displayPath}`);
    }
}
function applyRemoteStructuredEdits(path, original, edits) {
    const replacements = [];
    for (const edit of edits) {
        const oldText = String(edit.oldText ?? "");
        const newText = String(edit.newText ?? "");
        if (!oldText)
            throw new Error(`Edit oldText must not be empty: ${path}`);
        const first = original.indexOf(oldText);
        if (first < 0)
            throw new Error(`oldText did not match in ${path}.`);
        if (original.indexOf(oldText, first + oldText.length) >= 0)
            throw new Error(`oldText must match exactly once in ${path}.`);
        replacements.push({ start: first, end: first + oldText.length, newText });
    }
    replacements.sort((left, right) => left.start - right.start);
    for (let index = 1; index < replacements.length; index += 1) {
        if (replacements[index].start < replacements[index - 1].end)
            throw new Error(`Edits overlap in ${path}; merge nearby changes into one edit.`);
    }
    let cursor = 0;
    let updated = "";
    for (const replacement of replacements) {
        updated += original.slice(cursor, replacement.start);
        updated += replacement.newText;
        cursor = replacement.end;
    }
    updated += original.slice(cursor);
    return updated;
}
async function applyRemotePatch(workspace, patch, workspaces, remoteAgents) {
    const actions = parsePatch(patch);
    const results = [];
    const patches = [];
    const staged = new Map();
    const confined = (displayPath) => {
        const text = String(displayPath ?? "").replace(/\\/g, "/");
        if (!text || text.startsWith("/") || text.split("/").includes(".."))
            throw new Error(`Invalid patch: path must be relative to the workspace: ${displayPath}`);
        return workspaces.resolvePath(workspace, text);
    };
    const readOptional = async (displayPath) => {
        const absolute = confined(displayPath);
        if (staged.has(absolute))
            return staged.get(absolute);
        const info = await remoteAgents.rpcWorkspace(workspace, "fs.stat", { path: displayPath });
        if (!info.exists) {
            staged.set(absolute, null);
            return null;
        }
        if (info.type !== "file")
            throw new Error(`Invalid patch: path is not a regular file: ${displayPath}`);
        const bytes = await remoteAgents.readWhole(workspace, displayPath);
        const value = { content: decodeRemoteUtf8(bytes ?? Buffer.alloc(0), displayPath), mode: info.mode };
        staged.set(absolute, value);
        return value;
    };
    const readRequired = async (displayPath) => {
        const value = await readOptional(displayPath);
        if (!value)
            throw new Error(`Invalid patch: file does not exist: ${displayPath}`);
        return value;
    };
    for (const action of actions) {
        if (action.kind === "add") {
            const absolute = confined(action.path);
            const original = await readOptional(action.path);
            staged.set(absolute, { displayPath: action.path, content: action.content, mode: original?.mode });
            patches.push(unifiedFilePatch(action.path, action.path, original?.content ?? null, action.content));
            results.push({ path: action.path, operation: "add" });
            continue;
        }
        const absolute = confined(action.path);
        const file = await readRequired(action.path);
        if (action.kind === "delete") {
            staged.set(absolute, { displayPath: action.path, deleted: true });
            patches.push(unifiedFilePatch(action.path, action.path, file.content, null));
            results.push({ path: action.path, operation: "delete" });
            continue;
        }
        const updated = applyHunks(action.path, file.content, action.hunks);
        if (action.moveTo) {
            const destination = confined(action.moveTo);
            if (destination !== absolute)
                await readOptional(action.moveTo);
            staged.set(destination, { displayPath: action.moveTo, content: updated, mode: file.mode });
            if (destination !== absolute)
                staged.set(absolute, { displayPath: action.path, deleted: true });
            patches.push(unifiedFilePatch(action.path, action.moveTo, file.content, updated));
            results.push({ path: action.moveTo, previousPath: action.path, operation: "move" });
        }
        else {
            staged.set(absolute, { displayPath: action.path, content: updated, mode: file.mode });
            patches.push(unifiedFilePatch(action.path, action.path, file.content, updated));
            results.push({ path: action.path, operation: "update" });
        }
    }
    for (const value of staged.values()) {
        if (value && !value.deleted)
            await remoteAgents.writeBuffer(workspace, value.displayPath, Buffer.from(value.content, "utf8"), { mode: value.mode });
    }
    for (const value of staged.values()) {
        if (value?.deleted)
            await remoteAgents.rpcWorkspace(workspace, "fs.remove", { path: value.displayPath }, 60_000);
    }
    const unifiedPatch = patches.filter(Boolean).join("\n");
    return { files: results, patch: unifiedPatch, ...countPatchStats(unifiedPatch) };
}
function remoteGrepText(result) {
    const lines = (result.matches ?? []).map((match) => `${match.path}:${match.line}:${match.text}`);
    if (result.truncated)
        lines.push("[results truncated]");
    return lines.join("\n");
}
function remoteGlobText(result) {
    const lines = [...(result.matches ?? [])];
    if (result.truncated)
        lines.push("[results truncated]");
    return lines.join("\n");
}
function remoteListText(result) {
    return (result.entries ?? []).map((entry) => `${entry.type === "directory" ? "d" : entry.type === "symlink" ? "l" : "-"}\t${entry.size}\t${entry.name}`).join("\n");
}
function assetBaseUrl(config) {
    return `${config.publicBaseUrl.replace(/\/+$/, "")}/mcp-app-assets`;
}
function uiManifestUrl() {
    return new URL("../dist/ui/.vite/manifest.json", import.meta.url);
}
function readWorkspaceAppManifest() {
    return JSON.parse(readFileSync(uiManifestUrl(), "utf8"));
}
function getWorkspaceAppManifestEntry() {
    const manifest = readWorkspaceAppManifest();
    const entry = manifest[WORKSPACE_APP_MANIFEST_ENTRY];
    if (!entry?.file) {
        throw new Error(`Missing ${WORKSPACE_APP_MANIFEST_ENTRY} in UI manifest.`);
    }
    return entry;
}
function assetUrl(baseUrl, assetPath) {
    return `${baseUrl}/${assetPath.replace(/^\/+/, "")}`;
}
function workspaceAppHtml(config) {
    const baseUrl = assetBaseUrl(config);
    const entry = getWorkspaceAppManifestEntry();
    const runtimeEnhancementUrl = assetUrl(baseUrl, "assets/runtime-enhancements.js");
    const runtimeEnhancementStylesheet = assetUrl(baseUrl, "assets/runtime-enhancements.css");
    const sessionReviewStylesheet = assetUrl(baseUrl, "assets/session-review.css");
    const runtimeTimelineStylesheet = assetUrl(baseUrl, "assets/runtime-timeline.css");
    const stylesheets = (entry.css ?? [])
        .map((stylesheet) => `    <link rel="stylesheet" crossorigin href="${assetUrl(baseUrl, stylesheet)}" />`)
        .join("\n");
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>DevSpace Workspace</title>
    <link rel="stylesheet" crossorigin href="${runtimeEnhancementStylesheet}" />
    <link rel="stylesheet" crossorigin href="${sessionReviewStylesheet}" />
    <link rel="stylesheet" crossorigin href="${runtimeTimelineStylesheet}" />
    <script type="module" crossorigin src="${runtimeEnhancementUrl}"></script>
    <script type="module" crossorigin src="${assetUrl(baseUrl, entry.file)}"></script>
${stylesheets}
  </head>
  <body>
    <main id="app" class="shell">
      <section class="empty">Waiting for a tool result.</section>
    </main>
  </body>
</html>`;
}
function appCsp(config) {
    const publicBaseUrl = config.publicBaseUrl.replace(/\/+$/, "");
    return {
        resourceDomains: [publicBaseUrl, "data:"],
        connectDomains: [publicBaseUrl],
    };
}

const INLINE_PREVIEW_MAX_FILES = 4;
const INLINE_PREVIEW_MAX_FILE_BYTES = 2 * 1024 * 1024;
const INLINE_PREVIEW_MAX_TOTAL_BYTES = 6 * 1024 * 1024;
const NATIVE_ATTACHMENT_MAX_BYTES = 32 * 1024 * 1024;
const PREVIEW_MIME_TYPES = new Map([
    [".png", "image/png"],
    [".jpg", "image/jpeg"],
    [".jpeg", "image/jpeg"],
    [".webp", "image/webp"],
    [".gif", "image/gif"],
    [".svg", "image/svg+xml"],
    [".pdf", "application/pdf"],
    [".html", "text/html"],
    [".htm", "text/html"],
    [".md", "text/markdown"],
    [".txt", "text/plain"],
    [".csv", "text/csv"],
    [".json", "application/json"],
]);

function quoteDisplayArgument(value) {
    const text = String(value);
    if (text.length === 0)
        return '""';
    return /[\s"&|<>^]/.test(text) ? JSON.stringify(text) : text;
}

const SENSITIVE_ARG_OPTION = /^--?(?:password|passwd|pwd|token|secret|authorization|api[-_]?key|private[-_]?key|client[-_]?secret)$/i;

function redactDisplayArgv(argv) {
    if (!Array.isArray(argv))
        return undefined;
    const result = [];
    let redactNext = false;
    for (const value of argv) {
        const text = String(value);
        if (redactNext) {
            result.push("<redacted>");
            redactNext = false;
            continue;
        }
        const equals = text.match(/^(--?(?:password|passwd|pwd|token|secret|authorization|api[-_]?key|private[-_]?key|client[-_]?secret))=(.*)$/i);
        if (equals) {
            result.push(`${equals[1]}=<redacted>`);
            continue;
        }
        result.push(redactValue(text));
        if (SENSITIVE_ARG_OPTION.test(text))
            redactNext = true;
    }
    return result;
}

function displayCommand(cmd, argv) {
    return redactValue(cmd ?? redactDisplayArgv(argv)?.map(quoteDisplayArgument).join(" ") ?? "");
}

function previewKind(mimeType) {
    if (mimeType.startsWith("image/"))
        return "image";
    if (mimeType === "application/pdf")
        return "pdf";
    if (mimeType === "text/html")
        return "html";
    return "text";
}

function nativeAttachmentContent(workspaceId, path, mimeType, bytes) {
    const data = Buffer.from(bytes).toString("base64");
    const rasterImage = mimeType.startsWith("image/") && mimeType !== "image/svg+xml";
    if (rasterImage) {
        return [{ type: "image", data, mimeType }];
    }
    return [{
        type: "resource",
        resource: {
            uri: `devspace-attachment://${encodeURIComponent(workspaceId)}/${encodeURIComponent(path)}`,
            mimeType,
            blob: data,
        },
    }];
}

async function loadNativeAttachmentBytes(workspace, path, readPath, workspaces, remoteAgents) {
    let size = 0;
    let bytes;
    if (isRemoteWorkspace(workspace)) {
        const metadata = await remoteAgents.rpcWorkspace(workspace, "fs.stat", { path });
        if (!metadata.exists)
            throw new Error(`Remote attachment does not exist: ${path}`);
        if (metadata.type !== "file")
            throw new Error(`Remote attachment is not a regular file: ${path}`);
        size = Number(metadata.size ?? 0);
        if (!Number.isSafeInteger(size) || size < 0)
            throw new Error(`Remote attachment reported an invalid size: ${path}`);
        if (size > NATIVE_ATTACHMENT_MAX_BYTES)
            throw new Error(`Native attachment exceeds the ${Math.floor(NATIVE_ATTACHMENT_MAX_BYTES / (1024 * 1024))} MiB inline MCP limit: ${path} (${size} bytes). Do not fall back to a local model; reduce/split the source or use a future streamed resource path.`);
        bytes = await remoteAgents.readWhole(workspace, path);
        if (bytes === null)
            throw new Error(`Remote attachment disappeared while reading: ${path}`);
    }
    else {
        const metadata = await stat(readPath.absolutePath);
        if (!metadata.isFile())
            throw new Error(`Attachment is not a regular file: ${path}`);
        size = metadata.size;
        if (size > NATIVE_ATTACHMENT_MAX_BYTES)
            throw new Error(`Native attachment exceeds the ${Math.floor(NATIVE_ATTACHMENT_MAX_BYTES / (1024 * 1024))} MiB inline MCP limit: ${path} (${size} bytes). Do not fall back to a local model; reduce/split the source or use a future streamed resource path.`);
        bytes = await readFile(readPath.absolutePath);
    }
    if (bytes.length !== size)
        throw new Error(`Attachment changed while being read: ${path}; expected ${size} bytes, received ${bytes.length}.`);
    workspaces.markReadPathLoaded(workspace, readPath);
    return { bytes, size };
}

const REVIEW_OPERATION_TOOLS = new Set([
    "exec_command",
    "write_stdin",
    "process_attach",
    "process_kill",
    "bash",
    "apply_patch",
    "write",
    "edit",
]);

function reviewOperation(record) {
    const details = record.details ?? {};
    return redactValue({
        id: record.id,
        tool: record.tool,
        success: record.success,
        createdAt: record.createdAt,
        durationMs: record.durationMs ?? details.durationMs,
        command: details.command,
        path: details.path,
        workingDirectory: details.workingDirectory,
        processHandle: record.processHandle ?? details.processHandle,
        exitCode: record.exitCode ?? details.exitCode,
        signal: record.signal ?? details.signal,
        permissionDecision: details.permissionDecision,
        permissionRule: details.permissionRule,
    });
}

async function collectWorkspacePreviews(workspace, files, workspaces, remoteAgents) {
    const previews = [];
    const artifacts = [];
    const imageContent = [];
    let inlineBytes = 0;
    for (const file of files ?? []) {
        if (file.operation === "delete" || file.type === "deleted")
            continue;
        const path = file.path;
        const mimeType = PREVIEW_MIME_TYPES.get(extname(path ?? "").toLowerCase());
        if (!path || !mimeType)
            continue;
        try {
            let metadata;
            let remoteBytes;
            if (isRemoteWorkspace(workspace)) {
                if (!remoteAgents)
                    continue;
                metadata = await remoteAgents.rpcWorkspace(workspace, "fs.stat", { path });
                if (!metadata.exists || metadata.type !== "file")
                    continue;
            }
            else {
                const absolutePath = workspaces.resolvePath(workspace, path);
                const localMetadata = await stat(absolutePath);
                if (!localMetadata.isFile())
                    continue;
                metadata = localMetadata;
            }
            const artifact = {
                path,
                mimeType,
                kind: previewKind(mimeType),
                size: metadata.size,
                inline: false,
            };
            artifacts.push(artifact);
            if (!mimeType.startsWith("image/")
                || previews.length >= INLINE_PREVIEW_MAX_FILES
                || metadata.size > INLINE_PREVIEW_MAX_FILE_BYTES
                || inlineBytes + metadata.size > INLINE_PREVIEW_MAX_TOTAL_BYTES) {
                continue;
            }
            if (isRemoteWorkspace(workspace))
                remoteBytes = await remoteAgents.readWhole(workspace, path);
            const data = isRemoteWorkspace(workspace)
                ? (remoteBytes ?? Buffer.alloc(0)).toString("base64")
                : (await readFile(workspaces.resolvePath(workspace, path))).toString("base64");
            inlineBytes += metadata.size;
            artifact.inline = true;
            const preview = {
                path,
                mimeType,
                size: metadata.size,
                data,
                dataUrl: `data:${mimeType};base64,${data}`,
            };
            previews.push(preview);
            if (mimeType !== "image/svg+xml") {
                imageContent.push({ type: "image", data, mimeType });
            }
        }
        catch {
            // A file can disappear between the Git snapshot and preview read.
        }
    }
    return { previews, artifacts, imageContent };
}
function uiBuildDirectory() {
    return fileURLToPath(new URL("../dist/ui", import.meta.url));
}
function setAssetHeaders(res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    // Runtime-card assets intentionally stay on a stable URL so existing ChatGPT
    // App snapshots can receive UI updates without a tool-definition refresh.
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.setHeader("Pragma", "no-cache");
}
async function assertWorkspaceAppAssets() {
    const entry = getWorkspaceAppManifestEntry();
    const candidates = [
        entry.file,
        ...(entry.css ?? []),
        "assets/runtime-enhancements.js",
        "assets/runtime-enhancements.css",
        "assets/session-review.css",
        "assets/runtime-timeline.css",
    ].map((assetPath) => new URL(`../dist/ui/${assetPath}`, import.meta.url));
    for (const candidate of candidates) {
        await access(candidate);
    }
}
function processResult(snapshot) {
    const status = snapshot.running
        ? `Process running with session ID ${snapshot.sessionId}.`
        : snapshot.signal
            ? `Process exited after signal ${snapshot.signal}.`
            : `Process exited with code ${snapshot.exitCode ?? "unknown"}.`;
    return snapshot.output ? `${snapshot.output.replace(/\n$/, "")}\n${status}` : status;
}
function processOutputSchema() {
    return resultOutputSchema({
        processHandle: z.string(),
        sessionId: z.number().optional(),
        running: z.boolean(),
        exitCode: z.number().int().optional(),
        signal: z.string().optional(),
        wallTimeMs: z.number().nonnegative(),
        pid: z.number().int().optional(),
        reattachable: z.boolean().optional(),
        status: z.string().optional(),
        outputTruncated: z.boolean(),
    });
}
function processToolResponse(tool, workspaceId, snapshot, summary, runtime = {}) {
    const result = processResult(snapshot);
    const content = [textBlock(result)];
    const outputSummary = textSummary(snapshot.output ? [textBlock(snapshot.output)] : []);
    const safeSummary = redactValue({
        ...summary,
        ...outputSummary,
        processHandle: snapshot.processHandle,
        sessionId: snapshot.sessionId,
        pid: snapshot.pid,
        status: snapshot.status,
        signal: snapshot.signal,
        reattachable: snapshot.reattachable,
    });
    const safeRuntime = redactValue({
        ...runtime,
        processHandle: snapshot.processHandle,
        sessionId: snapshot.sessionId,
        pid: snapshot.pid,
        running: snapshot.running,
        exitCode: snapshot.exitCode,
        signal: snapshot.signal,
        status: snapshot.status,
        wallTimeMs: snapshot.wallTimeMs,
        reattachable: snapshot.reattachable,
    });
    return {
        content,
        _meta: {
            tool,
            card: {
                workspaceId,
                summary: safeSummary,
                payload: { content, runtime: safeRuntime },
            },
        },
        structuredContent: {
            result,
            processHandle: snapshot.processHandle,
            sessionId: snapshot.sessionId,
            running: snapshot.running,
            exitCode: snapshot.exitCode,
            signal: snapshot.signal,
            wallTimeMs: snapshot.wallTimeMs,
            pid: snapshot.pid,
            reattachable: snapshot.reattachable,
            status: snapshot.status,
            outputTruncated: snapshot.outputTruncated,
        },
    };
}
function registerCodexProcessTools(server, config, workspaces, processSessions, permissionRules, reviewCheckpoints, hookManager, remoteAgents) {
    registerAppTool(server, "exec_command", {
        title: "Execute command",
        description: `${commandToolDescription(config, "exec_command")} Returns its result when it exits during the yield window; otherwise returns a sessionId for write_stdin.`,
        inputSchema: {
            workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
            cmd: z.string().min(1).optional().describe("Shell command to execute. Provide cmd or argv, not both."),
            argv: z
                .array(z.string())
                .min(1)
                .optional()
                .describe("Structured executable and argument vector. Provide argv or cmd, not both."),
            processHandle: z
                .string()
                .min(1)
                .max(128)
                .optional()
                .describe("Stable process handle. When omitted, DevSpace generates one."),
            env: z
                .record(z.string(), z.string().nullable())
                .optional()
                .describe("Environment overrides. Use null to remove an inherited variable."),
            persistent: z
                .boolean()
                .optional()
                .describe("Register this as a durable named process. Defaults to true when processHandle is supplied."),
            tty: z
                .boolean()
                .optional()
                .describe("Allocate a pseudo-terminal for interactive commands. Defaults to false."),
            columns: z.number().int().min(1).max(1_000).optional().describe("Initial PTY width. Defaults to 80."),
            rows: z.number().int().min(1).max(1_000).optional().describe("Initial PTY height. Defaults to 24."),
            workingDirectory: z
                .string()
                .optional()
                .describe(workingDirectoryDescription(config)),
            yieldTimeMs: z
                .number()
                .int()
                .min(0)
                .max(30_000)
                .optional()
                .describe("Milliseconds to wait before returning a running session. Defaults to 10000."),
            maxOutputTokens: z
                .number()
                .int()
                .positive()
                .max(100_000)
                .optional()
                .describe("Approximate output token budget. Defaults to 10000."),
        },
        outputSchema: processOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "runtime"),
        annotations: SHELL_TOOL_ANNOTATIONS,
    }, async ({ workspaceId, cmd, argv, processHandle, env, persistent, tty, columns, rows, workingDirectory, yieldTimeMs, maxOutputTokens }) => {
        const startedAt = performance.now();
        if (Boolean(cmd) === Boolean(argv)) {
            throw new Error("Provide exactly one of cmd or argv.");
        }
        if (tty && !config.permissions.allowInteractiveProcesses) {
            throw new Error("Interactive PTY processes are disabled by the selected DevSpace permission profile.");
        }
        const workspace = workspaces.getWorkspace(workspaceId);
        const cwd = workspaces.resolveWorkingDirectory(workspace, workingDirectory);
        await prepareMutation(reviewCheckpoints, hookManager, {
            workspaceId,
            workspaceRoot: workspace.root,
            kind: "shell",
            toolName: "exec_command",
        });
        await hookManager.runEvent("before_command", {
            workspaceId,
            workspaceRoot: workspace.root,
            toolName: "exec_command",
        }, { strict: true });
        const permissionDecision = permissionRules.evaluate({
            workspaceId,
            workspaceRoot: workspace.root,
            cwd,
            cmd,
            argv: redactDisplayArgv(argv),
        });
        if (permissionDecision.decision === "deny") {
            throw new Error(`Command denied by permission rule ${permissionDecision.ruleId}.`);
        }
        let snapshot = isRemoteWorkspace(workspace)
            ? await remoteAgents.rpcWorkspace(workspace, "process.start", {
                command: cmd,
                argv,
                processHandle,
                env,
                persistent: persistent ?? Boolean(processHandle),
                cwd,
                tty,
                columns,
                rows,
                yieldTimeMs,
                maxOutputTokens,
            }, Math.max(60_000, Number(yieldTimeMs ?? 10_000) + 30_000))
            : await processSessions.start({
                workspaceId,
                command: cmd,
                argv,
                processHandle,
                env,
                persistent: persistent ?? Boolean(processHandle),
                cwd,
                workspaceRoot: workspace.root,
                tty,
                columns,
                rows,
                yieldTimeMs,
                maxOutputTokens,
            });
        if (snapshot.running && !config.permissions.allowPersistentProcesses && snapshot.sessionId !== undefined) {
            if (isRemoteWorkspace(workspace)) {
                snapshot = await remoteAgents.rpcWorkspace(workspace, "process.kill", {
                    processHandle: snapshot.processHandle,
                    signal: "SIGTERM",
                }, 30_000);
            }
            else {
                processSessions.terminate(workspaceId, snapshot.sessionId);
                snapshot = await processSessions.write({
                    workspaceId,
                    sessionId: snapshot.sessionId,
                    yieldTimeMs: 1_000,
                    maxOutputTokens,
                });
            }
        }
        await hookManager.runEvent("after_command", {
            workspaceId,
            workspaceRoot: workspace.root,
            toolName: "exec_command",
            success: snapshot.running || snapshot.exitCode === 0,
        });
        await finishMutation(reviewCheckpoints, hookManager, {
            workspaceId,
            workspaceRoot: workspace.root,
            toolName: "exec_command",
            success: snapshot.running || snapshot.exitCode === 0,
        });
        logToolCall(config, {
            tool: "exec_command",
            workspaceId,
            workingDirectory: workingDirectory ?? ".",
            command: cmd ?? argv?.join(" "),
            commandLength: cmd?.length ?? argv?.join(" ").length ?? 0,
            permissionRule: permissionDecision.ruleId,
            permissionDecision: permissionDecision.decision,
            success: true,
            durationMs: Math.round(performance.now() - startedAt),
        });
        const command = displayCommand(cmd, argv);
        return processToolResponse("exec_command", workspaceId, snapshot, {
            command,
            workingDirectory: workingDirectory ?? ".",
            running: snapshot.running,
            exitCode: snapshot.exitCode,
            wallTimeMs: snapshot.wallTimeMs,
        }, {
            command,
            argv,
            workingDirectory: cwd,
            requestedWorkingDirectory: workingDirectory ?? ".",
            environment: env,
            tty: Boolean(tty),
            persistent: persistent ?? Boolean(processHandle),
            permissionRule: permissionDecision.ruleId,
            permissionDecision: permissionDecision.decision,
        });
    });
    registerAppTool(server, "write_stdin", {
        title: "Write to process",
        description: "Poll or write characters to a process returned by exec_command. Omit chars or pass an empty string to poll. Pass \\u0003 to send Ctrl-C.",
        inputSchema: {
            workspaceId: z.string().describe("Workspace identifier used to start the process."),
            sessionId: z.number().optional().describe("Legacy process session identifier returned by exec_command."),
            processHandle: z.string().optional().describe("Stable process handle returned by exec_command."),
            chars: z.string().optional().describe("Characters to write. Omit or pass an empty string to poll."),
            columns: z.number().int().min(1).max(1_000).optional().describe("Resize a PTY to this width."),
            rows: z.number().int().min(1).max(1_000).optional().describe("Resize a PTY to this height."),
            yieldTimeMs: z
                .number()
                .int()
                .min(0)
                .max(30_000)
                .optional()
                .describe("Milliseconds to wait for process output or completion. Defaults to 10000."),
            maxOutputTokens: z
                .number()
                .int()
                .positive()
                .max(100_000)
                .optional()
                .describe("Approximate output token budget. Defaults to 10000."),
        },
        outputSchema: processOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "runtime"),
        annotations: SHELL_TOOL_ANNOTATIONS,
    }, async ({ workspaceId, sessionId, processHandle, chars, columns, rows, yieldTimeMs, maxOutputTokens }) => {
        const startedAt = performance.now();
        if (sessionId === undefined && !processHandle)
            throw new Error("Provide sessionId or processHandle.");
        const workspace = workspaces.getWorkspace(workspaceId);
        const snapshot = isRemoteWorkspace(workspace)
            ? await remoteAgents.rpcWorkspace(workspace, "process.write", {
                sessionId,
                processHandle,
                chars,
                columns,
                rows,
                yieldTimeMs,
                maxOutputTokens,
            }, Math.max(45_000, Number(yieldTimeMs ?? 10_000) + 20_000))
            : await processSessions.write({
                workspaceId,
                sessionId,
                processHandle,
                chars,
                columns,
                rows,
                yieldTimeMs,
                maxOutputTokens,
            });
        logToolCall(config, {
            tool: "write_stdin",
            workspaceId,
            success: true,
            durationMs: Math.round(performance.now() - startedAt),
        });
        return processToolResponse("write_stdin", workspaceId, snapshot, {
            sessionId: sessionId ?? snapshot.sessionId,
            processHandle: processHandle ?? snapshot.processHandle,
            charactersWritten: chars?.length ?? 0,
            running: snapshot.running,
            exitCode: snapshot.exitCode,
            wallTimeMs: snapshot.wallTimeMs,
        }, {
            operation: chars ? "write" : "poll",
            charactersWritten: chars?.length ?? 0,
            resize: columns || rows ? { columns, rows } : undefined,
        });
    });
    registerAppTool(server, "process_list", {
        title: "List processes",
        description: "List active and optionally completed processes from the persistent DevSpace process registry.",
        inputSchema: {
            workspaceId: z.string().optional().describe("Optional workspace filter."),
            includeCompleted: z.boolean().optional().describe("Include exited and historical processes."),
            limit: z.number().int().min(1).max(1000).optional().describe("Maximum records. Defaults to 100."),
        },
        outputSchema: resultOutputSchema({
            processes: z.array(z.unknown()),
        }),
        ...toolWidgetDescriptorMeta(config, "shell"),
        annotations: READ_ONLY_TOOL_ANNOTATIONS,
    }, async ({ workspaceId, includeCompleted, limit }) => {
        const workspace = workspaceId ? workspaces.getWorkspace(workspaceId) : undefined;
        const processes = workspace && isRemoteWorkspace(workspace)
            ? await remoteAgents.rpcWorkspace(workspace, "process.list", { includeCompleted, limit }, 30_000)
            : processSessions.list({ workspaceId, includeCompleted, limit });
        const result = JSON.stringify(processes, null, 2);
        return {
            content: [textBlock(result)],
            structuredContent: { result, processes },
        };
    });
    registerAppTool(server, "process_attach", {
        title: "Attach process",
        description: "Attach to a stable processHandle after an MCP reconnect. Returns current status and any newly buffered output. Processes only recognized after a full DevSpace restart are reported but may not have reattachable stdin/output streams.",
        inputSchema: {
            workspaceId: z.string().describe("Workspace that owns the process."),
            processHandle: z.string().describe("Stable process handle."),
            yieldTimeMs: z.number().int().min(0).max(30_000).optional().describe("Milliseconds to wait for output or exit."),
        },
        outputSchema: processOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "runtime"),
        annotations: READ_ONLY_TOOL_ANNOTATIONS,
    }, async ({ workspaceId, processHandle, yieldTimeMs }) => {
        const workspace = workspaces.getWorkspace(workspaceId);
        const snapshot = isRemoteWorkspace(workspace)
            ? await remoteAgents.rpcWorkspace(workspace, "process.attach", { processHandle, yieldTimeMs }, Math.max(45_000, Number(yieldTimeMs ?? 10_000) + 20_000))
            : await processSessions.attach({ workspaceId, processHandle, yieldTimeMs });
        return processToolResponse("process_attach", workspaceId, snapshot, {
            processHandle,
            running: snapshot.running,
            reattachable: snapshot.reattachable,
        }, {
            operation: "attach",
        });
    });
    registerAppTool(server, "process_kill", {
        title: "Kill process",
        description: "Terminate a process by stable processHandle.",
        inputSchema: {
            workspaceId: z.string().describe("Workspace that owns the process."),
            processHandle: z.string().describe("Stable process handle."),
            signal: z.enum(["SIGINT", "SIGTERM", "SIGKILL"]).optional().describe("Termination signal. Defaults to SIGTERM."),
        },
        outputSchema: resultOutputSchema({ process: z.unknown() }),
        ...toolWidgetDescriptorMeta(config, "runtime"),
        annotations: SHELL_TOOL_ANNOTATIONS,
    }, async ({ workspaceId, processHandle, signal }) => {
        const workspace = workspaces.getWorkspace(workspaceId);
        const process = isRemoteWorkspace(workspace)
            ? await remoteAgents.rpcWorkspace(workspace, "process.kill", { processHandle, signal: signal ?? "SIGTERM" }, 30_000)
            : processSessions.killByHandle(workspaceId, processHandle, signal ?? "SIGTERM");
        const result = JSON.stringify(process, null, 2);
        const content = [textBlock(result)];
        return {
            content,
            _meta: {
                tool: "process_kill",
                card: {
                    workspaceId,
                    summary: {
                        processHandle,
                        pid: process.pid,
                        running: process.running,
                        signal: signal ?? "SIGTERM",
                    },
                    payload: {
                        content,
                        runtime: redactValue({
                            operation: "kill",
                            processHandle,
                            pid: process.pid,
                            running: process.running,
                            signal: signal ?? "SIGTERM",
                        }),
                    },
                },
            },
            structuredContent: { result, process },
        };
    });
}

function registerDoctorTool(server, config, processSessions, runtimeState) {
    registerAppTool(server, "doctor", {
        title: "DevSpace doctor",
        description: "Run redacted structured diagnostics for DevSpace configuration, runtime provenance, PATH selection, PTY support, SQLite state, and the persistent process registry.",
        inputSchema: {
            summary: z.boolean().optional().describe("Return only the grouped summary and failing checks in the text result."),
        },
        outputSchema: resultOutputSchema({ report: z.unknown() }),
        ...toolWidgetDescriptorMeta(config, "shell"),
        annotations: READ_ONLY_TOOL_ANNOTATIONS,
    }, async ({ summary }) => {
        const report = await runDoctor(config, processSessions);
        report.runId = runtimeState.recordDiagnostic(report);
        const visible = summary
            ? {
                schemaVersion: report.schemaVersion,
                generatedAt: report.generatedAt,
                overallStatus: report.overallStatus,
                summary: report.summary,
                checks: Object.fromEntries(Object.entries(report.checks).filter(([, value]) => value.status !== "ok")),
            }
            : report;
        const result = JSON.stringify(visible, null, 2);
        return { content: [textBlock(result)], structuredContent: { result, report } };
    });
    registerAppTool(server, "doctor_history", {
        title: "Doctor history",
        description: "List prior structured diagnostic runs with generated remediation suggestions.",
        inputSchema: {
            limit: z.number().int().min(1).max(200).optional().describe("Maximum runs. Defaults to 20."),
        },
        outputSchema: resultOutputSchema({ history: z.array(z.unknown()) }),
        ...toolWidgetDescriptorMeta(config, "shell"),
        annotations: READ_ONLY_TOOL_ANNOTATIONS,
    }, async ({ limit }) => {
        const history = runtimeState.diagnosticHistory({ limit });
        const result = JSON.stringify(history, null, 2);
        return { content: [textBlock(result)], structuredContent: { result, history } };
    });
}
function registerRuntimeStateTools(server, config, workspaces, runtimeState, fileWatches, permissionRules, remoteAgents) {
    registerAppTool(server, "event_poll", {
        title: "Poll events",
        description: "Read ordered DevSpace events after a sequence cursor. Events cover process lifecycle, file changes, watches, and permission audits.",
        inputSchema: {
            afterSequence: z.number().int().nonnegative().optional(),
            kind: z.string().optional(),
            subject: z.string().optional(),
            workspaceId: z.string().optional(),
            limit: z.number().int().min(1).max(1000).optional(),
        },
        outputSchema: resultOutputSchema({ events: z.array(z.unknown()), nextSequence: z.number().int() }),
        ...toolWidgetDescriptorMeta(config, "shell"),
        annotations: READ_ONLY_TOOL_ANNOTATIONS,
    }, async (input) => {
        if (input.workspaceId)
            workspaces.getWorkspace(input.workspaceId);
        const page = runtimeState.pollEvents(input);
        const result = JSON.stringify(page, null, 2);
        return { content: [textBlock(result)], structuredContent: { result, ...page } };
    });
    registerAppTool(server, "audit_log_list", {
        title: "List audit logs",
        description: "List redacted structured tool-call audit records from SQLite.",
        inputSchema: {
            workspaceId: z.string().optional(),
            tool: z.string().optional(),
            success: z.boolean().optional(),
            limit: z.number().int().min(1).max(1000).optional(),
        },
        outputSchema: resultOutputSchema({ records: z.array(z.unknown()) }),
        ...toolWidgetDescriptorMeta(config, "shell"),
        annotations: READ_ONLY_TOOL_ANNOTATIONS,
    }, async (input) => {
        if (input.workspaceId)
            workspaces.getWorkspace(input.workspaceId);
        const records = runtimeState.listToolCalls(input);
        const result = JSON.stringify(records, null, 2);
        return { content: [textBlock(result)], structuredContent: { result, records } };
    });
    registerAppTool(server, "file_watch_start", {
        title: "Start file watch",
        description: "Watch a workspace file or directory and append ordered fs.changed events to the SQLite event journal.",
        inputSchema: {
            workspaceId: z.string(),
            path: z.string(),
            watchId: z.string().min(1).max(128).optional(),
            recursive: z.boolean().optional(),
        },
        outputSchema: resultOutputSchema({ watch: z.unknown() }),
        ...toolWidgetDescriptorMeta(config, "shell"),
        annotations: READ_ONLY_TOOL_ANNOTATIONS,
    }, async ({ workspaceId, path, watchId, recursive }) => {
        const workspace = workspaces.getWorkspace(workspaceId);
        const absolutePath = workspaces.resolvePath(workspace, path);
        const watch = isRemoteWorkspace(workspace)
            ? await remoteAgents.rpcWorkspace(workspace, "watch.start", { path, watchId, recursive }, 30_000)
            : fileWatches.start({ workspaceId, path: absolutePath, watchId, recursive });
        const result = JSON.stringify(watch, null, 2);
        return { content: [textBlock(result)], structuredContent: { result, watch } };
    });
    registerAppTool(server, "file_watch_poll", {
        title: "Poll file watch",
        description: "Read file-watch events after a sequence cursor.",
        inputSchema: {
            workspaceId: z.string(),
            watchId: z.string(),
            afterSequence: z.number().int().nonnegative().optional(),
            limit: z.number().int().min(1).max(1000).optional(),
        },
        outputSchema: resultOutputSchema({ events: z.array(z.unknown()), nextSequence: z.number().int() }),
        ...toolWidgetDescriptorMeta(config, "shell"),
        annotations: READ_ONLY_TOOL_ANNOTATIONS,
    }, async (input) => {
        const workspace = workspaces.getWorkspace(input.workspaceId);
        const page = isRemoteWorkspace(workspace)
            ? await remoteAgents.rpcWorkspace(workspace, "watch.poll", input, 30_000)
            : fileWatches.poll(input);
        const result = JSON.stringify(page, null, 2);
        return { content: [textBlock(result)], structuredContent: { result, ...page } };
    });
    registerAppTool(server, "file_watch_stop", {
        title: "Stop file watch",
        description: "Stop an active file watch.",
        inputSchema: { workspaceId: z.string(), watchId: z.string() },
        outputSchema: resultOutputSchema({ watch: z.unknown() }),
        ...toolWidgetDescriptorMeta(config, "shell"),
        annotations: EDIT_TOOL_ANNOTATIONS,
    }, async ({ workspaceId, watchId }) => {
        const workspace = workspaces.getWorkspace(workspaceId);
        const watch = isRemoteWorkspace(workspace)
            ? await remoteAgents.rpcWorkspace(workspace, "watch.stop", { watchId }, 30_000)
            : fileWatches.stop(watchId);
        const result = JSON.stringify(watch, null, 2);
        return { content: [textBlock(result)], structuredContent: { result, watch } };
    });
    registerAppTool(server, "file_watch_list", {
        title: "List file watches",
        description: "List active and optionally stopped file-watch registrations.",
        inputSchema: { workspaceId: z.string().optional(), includeStopped: z.boolean().optional() },
        outputSchema: resultOutputSchema({ watches: z.array(z.unknown()) }),
        ...toolWidgetDescriptorMeta(config, "shell"),
        annotations: READ_ONLY_TOOL_ANNOTATIONS,
    }, async (input) => {
        const workspace = input.workspaceId ? workspaces.getWorkspace(input.workspaceId) : undefined;
        const watches = workspace && isRemoteWorkspace(workspace)
            ? await remoteAgents.rpcWorkspace(workspace, "watch.list", input, 30_000)
            : fileWatches.list(input);
        const result = JSON.stringify(watches, null, 2);
        return { content: [textBlock(result)], structuredContent: { result, watches } };
    });
    registerAppTool(server, "permission_rules_list", {
        title: "List permission rules",
        description: "Read effective allow/deny/audit command rules. Sensitive values are redacted.",
        inputSchema: {},
        outputSchema: resultOutputSchema({ rules: z.unknown() }),
        ...toolWidgetDescriptorMeta(config, "shell"),
        annotations: READ_ONLY_TOOL_ANNOTATIONS,
    }, async () => {
        const rules = permissionRules.list();
        const result = JSON.stringify(rules, null, 2);
        return { content: [textBlock(result)], structuredContent: { result, rules } };
    });
    registerAppTool(server, "permission_rules_reload", {
        title: "Reload permission rules",
        description: "Reload permission-rules.json after the owner changes it.",
        inputSchema: {},
        outputSchema: resultOutputSchema({ rules: z.unknown() }),
        ...toolWidgetDescriptorMeta(config, "shell"),
        annotations: EDIT_TOOL_ANNOTATIONS,
    }, async () => {
        const rules = permissionRules.reload();
        const result = JSON.stringify(rules, null, 2);
        return { content: [textBlock(result)], structuredContent: { result, rules } };
    });
    registerAppTool(server, "permission_rules_test", {
        title: "Test permission rules",
        description: "Evaluate a command without executing it.",
        inputSchema: {
            workspaceId: z.string(),
            cmd: z.string().optional(),
            argv: z.array(z.string()).min(1).optional(),
            workingDirectory: z.string().optional(),
        },
        outputSchema: resultOutputSchema({ decision: z.unknown() }),
        ...toolWidgetDescriptorMeta(config, "shell"),
        annotations: READ_ONLY_TOOL_ANNOTATIONS,
    }, async ({ workspaceId, cmd, argv, workingDirectory }) => {
        if (Boolean(cmd) === Boolean(argv))
            throw new Error("Provide exactly one of cmd or argv.");
        const workspace = workspaces.getWorkspace(workspaceId);
        const cwd = workspaces.resolveWorkingDirectory(workspace, workingDirectory);
        const decision = permissionRules.evaluate({ workspaceId, workspaceRoot: workspace.root, cwd, cmd, argv });
        const result = JSON.stringify(decision, null, 2);
        return { content: [textBlock(result)], structuredContent: { result, decision } };
    });
}
function createMcpServer(config, workspaces, reviewCheckpoints, processSessions, localAgentProviders, incomingArtifactAdapters, runtimeServices) {
    const reviewToolCursors = new Map();
    const server = new McpServer({
        name: "devspace",
        title: "DevSpace",
        version: DEVSPACE_SERVER_VERSION,
        description: "Local coding workspace and durable execution runtime for MCP clients, with persistent processes, sessions, diagnostics, events, permission rules, and local plugins.",
    }, {
        instructions: serverInstructions(config),
    });
    registerAppResource(server, "DevSpace Diff Card", WORKSPACE_APP_URI, {
        description: "Interactive card for viewing DevSpace file diffs.",
        _meta: {
            ui: {
                prefersBorder: true,
                csp: appCsp(config),
            },
            "openai/widgetDescription": "DevSpace consolidated operation timeline, file diffs, and generated artifact previews.",
            "openai/widgetPrefersBorder": true,
        },
    }, async () => {
        await assertWorkspaceAppAssets();
        return {
            contents: [
                {
                    uri: WORKSPACE_APP_URI,
                    mimeType: RESOURCE_MIME_TYPE,
                    text: workspaceAppHtml(config),
                    _meta: {
                        ui: {
                            prefersBorder: true,
                            csp: appCsp(config),
                        },
                        "openai/widgetDescription": "DevSpace consolidated operation timeline, file diffs, and generated artifact previews.",
                        "openai/widgetPrefersBorder": true,
                    },
                },
            ],
        };
    });
    registerDoctorTool(server, config, processSessions, runtimeServices.runtimeState);
    registerRuntimeStateTools(server, config, workspaces, runtimeServices.runtimeState, runtimeServices.fileWatches, runtimeServices.permissionRules, runtimeServices.remoteAgents);
    registerPluginManagementTools(server, config, workspaces, runtimeServices.pluginManager);
    registerPluginDispatchTools(server, config, workspaces, processSessions, runtimeServices.permissionRules, runtimeServices.pluginManager, runtimeServices.runtimeState);
    registerReservedPluginSlots(server, config, workspaces, processSessions, runtimeServices.permissionRules, runtimeServices.pluginManager, runtimeServices.runtimeState);
    registerFeatureTools(server, {
        config,
        workspaces,
        runtimeState: runtimeServices.runtimeState,
        memoryStore: runtimeServices.memoryStore,
        hookManager: runtimeServices.hookManager,
        reviewCheckpoints,
        uiLease: runtimeServices.uiLease,
        toolMeta: (kind) => toolWidgetDescriptorMeta(config, kind),
    });
    if (process.env.DEVSPACE_DYNAMIC_PLUGIN_ALIASES !== "0")
        registerDynamicPluginTools(server, config, workspaces, processSessions, runtimeServices.permissionRules, runtimeServices.pluginManager, runtimeServices.runtimeState);
    registerAppTool(server, "open_workspace", {
        title: "Open workspace",
        description: `Open a local or enrolled Linux-agent project directory as a coding workspace. Remote Linux paths use devspace://<agent-id-or-name>/absolute/linux/path and then work with the same read/edit/search/process/review tools as local workspaces. Call this once per project folder or worktree before reading, editing, searching, writing, showing changes, or running commands. Reuse the returned workspaceId for later calls in the same folder; do not call open_workspace again unless switching folders/worktrees, changing checkout/worktree mode, the workspaceId is rejected as unknown, or the user explicitly asks to reopen. By default this opens the actual checkout; set mode="worktree" when the user asks for an isolated or parallel coding session. ${config.permissions.allowExternalPaths ? "For local workspaces the owner enabled full path access, so any path accessible to the current Windows user may be opened. Remote workspaces remain independently confined by each Linux Agent's allowed roots and Linux user permissions." : "Local paths must be inside a configured allowed root; remote paths must be inside the selected Linux Agent's allowed roots."} Returns a workspaceId, backend identity, loaded root project instructions, and nested instruction file paths the model should read before working in those directories.`,
        inputSchema: {
            path: z
                .string()
                .describe(config.permissions.allowExternalPaths
                ? "Local absolute/home path, or remote URI devspace://<agent-id-or-name>/absolute/linux/path."
                : "Local absolute/home path inside an allowed root, or remote URI devspace://<agent-id-or-name>/absolute/linux/path inside that agent's allowed roots."),
            mode: z
                .enum(["checkout", "worktree"])
                .optional()
                .describe("Defaults to checkout. Use checkout to work in the actual directory. Use worktree to create an isolated managed Git worktree for parallel work."),
            baseRef: z
                .string()
                .optional()
                .describe("Git ref to base a worktree on. Only used with mode=\"worktree\". Defaults to HEAD."),
        },
        outputSchema: {
            workspaceId: z.string(),
            root: z.string(),
            backend: z.enum(["local", "remote-agent"]),
            backendId: z.string().optional(),
            title: z.string().optional(),
            mode: z.enum(["checkout", "worktree"]),
            git: z
                .object({
                sha: z.string().optional(),
                branch: z.string().optional(),
                originUrl: z.string().optional(),
            })
                .optional(),
            sourceRoot: z.string().optional(),
            worktree: z
                .object({
                path: z.string(),
                baseRef: z.string(),
                baseSha: z.string(),
                dirtySource: z.boolean(),
                detached: z.boolean(),
                managed: z.boolean(),
            })
                .optional(),
            agentsFiles: z.array(workspaceAgentsFileOutputSchema),
            availableAgentsFiles: z.array(workspaceAvailableAgentsFileOutputSchema),
            skills: z.array(workspaceSkillOutputSchema),
            agentProviders: z.array(workspaceLocalAgentProviderOutputSchema),
            agents: z.array(workspaceLocalAgentOutputSchema),
            skillDiagnostics: z.array(z.unknown()),
            memories: z.array(z.unknown()),
            remoteAgent: remoteWorkspaceAgentOutputSchema.optional(),
            instruction: z.string(),
        },
        ...toolWidgetDescriptorMeta(config, "workspace"),
        annotations: READ_ONLY_TOOL_ANNOTATIONS,
    }, async ({ path, mode, baseRef }, { _meta } = {}) => {
        const startedAt = performance.now();
        synchronizePluginSkillRoots(config, runtimeServices.pluginManager);
        const { workspace, agentsFiles, availableAgentsFiles, workspaceReused, includeBootstrapContext } = await workspaces.openWorkspace({ path, mode, baseRef }, { conversationScopeId: openAiConversationScopeId(_meta) });
        if (config.widgets !== "off" || config.features?.uiSessionReview) {
            await reviewCheckpoints.initializeWorkspace({
                workspaceId: workspace.id,
                root: workspace.root,
            });
        }
        if (!workspaceReused && runtimeServices.hookManager.hasEvent("workspace_open")) {
            await reviewCheckpoints.beforeMutation({ workspaceId: workspace.id, root: workspace.root, kind: "shell" });
        }
        const cardMemories = config.features?.memories
            ? runtimeServices.memoryStore.summaries(workspace.root)
            : [];
        if (!workspaceReused) {
            await runtimeServices.hookManager.runEvent("workspace_open", {
                workspaceId: workspace.id,
                workspaceRoot: workspace.root,
                toolName: "open_workspace",
                success: true,
            });
        }
        const cardSkills = workspace.skills
            .filter((skill) => !skill.disableModelInvocation)
            .map((skill) => ({
            name: skill.name,
            description: skill.description,
            path: formatPathForPrompt(skill.filePath),
        }));
        const cardAgentProviders = config.subagents ? localAgentProviders : [];
        const cardAgents = workspace.agentProfiles.map((profile) => {
            const summary = summarizeLocalAgentProfile(profile);
            const availability = cardAgentProviders.find((provider) => provider.name === summary.provider);
            return {
                ...summary,
                providerAvailable: availability?.available,
                providerUnavailableReason: availability?.reason,
            };
        });
        const cardAgentsFiles = agentsFiles.map((file) => ({
            path: formatAgentsPath(file.path, workspace.root),
            content: file.content,
        }));
        const cardAvailableAgentsFiles = availableAgentsFiles.map((file) => ({
            path: formatAgentsPath(file.path, workspace.root),
        }));
        const visibleSkills = includeBootstrapContext ? cardSkills : [];
        const visibleAgentProviders = includeBootstrapContext ? cardAgentProviders : [];
        const visibleAgents = includeBootstrapContext ? cardAgents : [];
        const loadedAgentsFiles = includeBootstrapContext ? cardAgentsFiles : [];
        const availableAgentsFileOutputs = includeBootstrapContext ? cardAvailableAgentsFiles : [];
        const memories = includeBootstrapContext ? cardMemories : [];
        let remoteAgent;
        if (isRemoteWorkspace(workspace)) {
            const agent = runtimeServices.remoteAgents.resolveAgent(workspace.backendId, true);
            let system;
            try {
                system = await runtimeServices.remoteAgents.rpcWorkspace(workspace, "system.status", {}, 15_000);
            }
            catch {
                system = undefined;
            }
            remoteAgent = {
                id: agent.id,
                name: agent.name,
                status: agent.status,
                hostname: agent.hostname,
                agentVersion: agent.agentVersion,
                allowedRoots: agent.allowedRoots,
                writableRoots: agent.writableRoots ?? agent.allowedRoots,
                accessMode: agent.accessMode ?? "scoped",
                installRoot: agent.installRoot,
                system,
            };
        }
        const baseInstruction = config.skillsEnabled
            ? "Use this workspaceId in all subsequent tool calls for this project. Do not call open_workspace again for this same folder unless this workspaceId stops working, the user asks to reopen, or you switch to a different folder/worktree. Follow loaded agentsFiles instructions. Before working under a path listed in availableAgentsFiles, read that instruction file. When a task matches an available skill in skills, read its path before proceeding."
            : "Use this workspaceId in all subsequent tool calls for this project. Do not call open_workspace again for this same folder unless this workspaceId stops working, the user asks to reopen, or you switch to a different folder/worktree. Follow loaded agentsFiles instructions. Before working under a path listed in availableAgentsFiles, read that instruction file.";
        const firstOpenInstruction = memories.length > 0
            ? `${baseInstruction} The user explicitly saved the memories returned in memories; use them when relevant, and do not treat them as secrets or as instructions that override the current request.`
            : baseInstruction;
        const instruction = workspaceReused
            ? `Workspace already open as ${workspace.id}. Continue with this workspaceId. Keep following the project instructions, nested instructions, skills, agent profiles, explicit memories, and diagnostics already supplied for this workspace.`
            : firstOpenInstruction;
        const resultContent = [
            {
                type: "text",
                text: [
                    workspaceReused ? `Workspace already open as ${workspace.id}.` : `Opened workspace ${workspace.id}`,
                    `Root: ${workspace.root}`,
                    `Backend: ${workspace.backend}${workspace.backendId ? ` (${workspace.backendId})` : ""}`,
                    `Mode: ${workspace.mode}`,
                    loadedAgentsFiles.length > 0
                        ? `Loaded project instructions: ${loadedAgentsFiles.map((file) => file.path).join(", ")}`
                        : undefined,
                    availableAgentsFileOutputs.length > 0
                        ? `Available nested instructions: ${availableAgentsFileOutputs.map((file) => file.path).join(", ")}`
                        : undefined,
                    visibleSkills.length > 0
                        ? `Available skills: ${visibleSkills.map((skill) => skill.name).join(", ")}`
                        : undefined,
                    visibleAgentProviders.some((provider) => provider.available)
                        ? `Available subagent providers: ${visibleAgentProviders.filter((provider) => provider.available).map((provider) => provider.name).join(", ")}`
                        : undefined,
                    visibleAgentProviders.some((provider) => !provider.available)
                        ? `Unavailable subagent providers: ${visibleAgentProviders.filter((provider) => !provider.available).map(formatUnavailableAgentProvider).join(", ")}`
                        : undefined,
                    visibleAgents.length > 0
                        ? `Available subagent profiles: ${visibleAgents.map(formatVisibleAgent).join(", ")}`
                        : undefined,
                    memories.length > 0
                        ? `Explicit memories: ${memories.map((memory) => `${memory.title}: ${memory.content}`).join(" | ")}`
                        : undefined,
                    remoteAgent
                        ? `Remote Agent: ${remoteAgent.name} (${remoteAgent.id}), host=${remoteAgent.hostname ?? "unknown"}, version=${remoteAgent.agentVersion ?? "unknown"}, access=${remoteAgent.accessMode ?? "scoped"}, installRoot=${remoteAgent.installRoot ?? "unknown"}, writableRoots=${(remoteAgent.writableRoots ?? remoteAgent.allowedRoots).join(", ") || "none"}`
                        : undefined,
                    Array.isArray(remoteAgent?.system?.gpus) && remoteAgent.system.gpus.length > 0
                        ? `Remote GPUs: ${remoteAgent.system.gpus.map((gpu) => `GPU${gpu.index} ${gpu.name}, ${gpu.memoryUsedMiB}/${gpu.memoryTotalMiB} MiB, util ${gpu.utilizationPercent}%`).join(" | ")}`
                        : undefined,
                    instruction,
                ].filter(Boolean).join("\n"),
            },
        ];
        logToolCall(config, {
            tool: "open_workspace",
            workspaceId: workspace.id,
            path: workspace.root,
            success: true,
            durationMs: Math.round(performance.now() - startedAt),
        });
        const latestToolCall = runtimeServices.runtimeState.listToolCalls({ workspaceId: workspace.id, limit: 1 })[0];
        reviewToolCursors.set(workspace.id, latestToolCall?.id ?? 0);
        return {
            content: resultContent,
            _meta: {
                tool: "open_workspace",
                card: {
                    workspaceId: workspace.id,
                    root: workspace.root,
                    path: workspace.root,
                    summary: {
                        mode: workspace.mode,
                        backend: workspace.backend,
                        backendId: workspace.backendId,
                        workspaceReused,
                        includeBootstrapContext,
                        agentsFiles: cardAgentsFiles.length,
                        availableAgentsFiles: cardAvailableAgentsFiles.length,
                        skills: cardSkills.length,
                        agentProviders: cardAgentProviders.length,
                        agents: cardAgents.length,
                        skillDiagnostics: workspace.skillDiagnostics.length,
                        memories: cardMemories.length,
                        remoteAgent: remoteAgent ? remoteAgent.id : undefined,
                    },
                },
            },
            structuredContent: {
                workspaceId: workspace.id,
                root: workspace.root,
                backend: workspace.backend,
                backendId: workspace.backendId,
                title: workspace.title,
                mode: workspace.mode,
                git: workspace.git,
                sourceRoot: workspace.sourceRoot,
                worktree: workspace.worktree,
                agentsFiles: loadedAgentsFiles,
                availableAgentsFiles: availableAgentsFileOutputs,
                skills: visibleSkills,
                agentProviders: visibleAgentProviders,
                agents: visibleAgents,
                skillDiagnostics: includeBootstrapContext ? workspace.skillDiagnostics : [],
                memories,
                remoteAgent,
                instruction,
            },
        };
    });
    registerAppTool(server, "session_list", {
        title: "List workspace sessions",
        description: "List persisted workspace sessions, separated into active and archived history, including Git branch, HEAD, origin, root, and last-used metadata.",
        inputSchema: {
            includeArchived: z.boolean().optional().describe("Include archived history. Defaults to true."),
            limit: z.number().int().min(1).max(1000).optional().describe("Maximum records. Defaults to 100."),
        },
        outputSchema: resultOutputSchema({
            active: z.array(z.unknown()),
            history: z.array(z.unknown()),
        }),
        ...toolWidgetDescriptorMeta(config, "workspace"),
        annotations: READ_ONLY_TOOL_ANNOTATIONS,
    }, async ({ includeArchived, limit }) => {
        const sessions = workspaces.listSessions({ includeArchived: includeArchived ?? true, limit });
        const active = sessions.filter((session) => session.status === "active");
        const history = sessions.filter((session) => session.status !== "active");
        const result = JSON.stringify({ active, history }, null, 2);
        return { content: [textBlock(result)], structuredContent: { result, active, history } };
    });
    registerAppTool(server, "session_resume", {
        title: "Resume workspace session",
        description: "Resume a persisted workspace session by ID, reload project instructions, skills, local agent profiles, and current Git metadata, and reactivate archived sessions.",
        inputSchema: {
            sessionId: z.string().describe("Persisted workspace session ID."),
        },
        outputSchema: resultOutputSchema({ workspace: z.unknown() }),
        ...toolWidgetDescriptorMeta(config, "workspace"),
        annotations: READ_ONLY_TOOL_ANNOTATIONS,
    }, async ({ sessionId }) => {
        synchronizePluginSkillRoots(config, runtimeServices.pluginManager);
        const { workspace, agentsFiles, availableAgentsFiles } = await workspaces.resumeWorkspace(sessionId);
        if (config.widgets !== "off" || config.features?.uiSessionReview) {
            await reviewCheckpoints.initializeWorkspace({ workspaceId: workspace.id, root: workspace.root });
        }
        if (runtimeServices.hookManager.hasEvent("workspace_open")) {
            await reviewCheckpoints.beforeMutation({ workspaceId: workspace.id, root: workspace.root, kind: "shell" });
        }
        const memories = config.features?.memories
            ? runtimeServices.memoryStore.summaries(workspace.root)
            : [];
        await runtimeServices.hookManager.runEvent("workspace_open", {
            workspaceId: workspace.id,
            workspaceRoot: workspace.root,
            toolName: "session_resume",
            success: true,
        });
        const latestToolCall = runtimeServices.runtimeState.listToolCalls({ workspaceId: workspace.id, limit: 1 })[0];
        reviewToolCursors.set(workspace.id, latestToolCall?.id ?? 0);
        const value = {
            workspaceId: workspace.id,
            root: workspace.root,
            title: workspace.title,
            mode: workspace.mode,
            sourceRoot: workspace.sourceRoot,
            git: workspace.git,
            agentsFiles: agentsFiles.map((file) => ({ path: formatAgentsPath(file.path, workspace.root), content: file.content })),
            availableAgentsFiles: availableAgentsFiles.map((file) => ({ path: formatAgentsPath(file.path, workspace.root) })),
            skills: workspace.skills.filter((skill) => !skill.disableModelInvocation).map((skill) => ({
                name: skill.name,
                description: skill.description,
                path: formatPathForPrompt(skill.filePath),
            })),
            memories,
        };
        const result = JSON.stringify(value, null, 2);
        return { content: [textBlock(result)], structuredContent: { result, workspace: value } };
    });
    registerAppTool(server, "session_archive", {
        title: "Archive workspace session",
        description: "Move a persisted workspace session from the active list into history. Files and Git worktrees are not deleted.",
        inputSchema: {
            sessionId: z.string().describe("Persisted workspace session ID."),
        },
        outputSchema: resultOutputSchema({ session: z.unknown() }),
        ...toolWidgetDescriptorMeta(config, "workspace"),
        annotations: EDIT_TOOL_ANNOTATIONS,
    }, async ({ sessionId }) => {
        const session = workspaces.archiveSession(sessionId);
        const result = JSON.stringify(session, null, 2);
        return { content: [textBlock(result)], structuredContent: { result, session } };
    });
    registerAppTool(server, toolNames.read, {
        title: "Read file",
        description: [
            "Read a file inside an open workspace. Use this for file inspection instead of shell commands like cat or sed. Call open_workspace first and pass workspaceId.",
            "Use this tool to inspect relevant AGENTS.md or CLAUDE.md files listed by open_workspace before working in nested directories.",
            config.skillsEnabled
                ? "If available skills were returned and a task matches one, read that skill's path before proceeding. Skill paths may be outside the workspace; only advertised SKILL.md files and files under already-loaded skill directories are readable."
                : "",
        ]
            .filter(Boolean)
            .join(" "),
        inputSchema: {
            workspaceId: z
                .string()
                .describe("Workspace identifier returned by open_workspace."),
            path: z
                .string()
                .describe(config.skillsEnabled
                ? "File path to read, relative to the workspace root. May also be an advertised skill path from open_workspace skills."
                : "File path to read, relative to the workspace root."),
            offset: z
                .number()
                .int()
                .positive()
                .optional()
                .describe("1-indexed line number to start reading from."),
            limit: z
                .number()
                .int()
                .positive()
                .optional()
                .describe("Maximum number of lines to read."),
        },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "read"),
        annotations: READ_ONLY_TOOL_ANNOTATIONS,
    }, async ({ workspaceId, ...input }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        const readPath = workspaces.resolveReadPath(workspace, input.path);
        const attachmentMimeType = PREVIEW_MIME_TYPES.get(extname(input.path).toLowerCase());
        const nativeAttachment = attachmentMimeType
            && (attachmentMimeType.startsWith("image/") || attachmentMimeType === "application/pdf");
        if (nativeAttachment) {
            const { bytes, size } = await loadNativeAttachmentBytes(workspace, input.path, readPath, workspaces, runtimeServices.remoteAgents);
            const attachmentKind = attachmentMimeType.startsWith("image/") && attachmentMimeType !== "image/svg+xml" ? "image" : "resource";
            const result = `Native attachment: ${input.path} (${attachmentMimeType}, ${size} bytes).`;
            logToolCall(config, {
                tool: toolNames.read,
                workspaceId,
                path: input.path,
                nativeAttachment: true,
                mimeType: attachmentMimeType,
                size,
                success: true,
                durationMs: Math.round(performance.now() - startedAt),
            });
            return {
                content: [textBlock(result), ...nativeAttachmentContent(workspace.id, input.path, attachmentMimeType, bytes)],
                structuredContent: { result, path: input.path, mimeType: attachmentMimeType, size, attachmentKind },
            };
        }
        const response = isRemoteWorkspace(workspace)
            ? await runtimeServices.remoteAgents.read(workspace, input.path, { offset: input.offset, limit: input.limit }).then((remote) => {
                if (remote.kind === "text")
                    return remoteTextToolResponse(remote.text);
                return remoteTextToolResponse(`[remote binary file: ${input.path}; ${remote.size} bytes${remote.truncated ? "; preview truncated" : ""}]`);
            })
            : await readFileTool({ ...input, path: readPath.absolutePath }, {
                cwd: workspace.root,
                root: workspace.root,
                readRoots: readPath.readRoots,
                allowExternalPaths: config.permissions.allowExternalPaths,
            });
        if (response.isError) {
            logFailedToolResponse(config, {
                tool: toolNames.read,
                workspaceId,
                path: input.path,
            }, response.content, startedAt);
            return response;
        }
        workspaces.markReadPathLoaded(workspace, readPath);
        const summary = {
            ...textSummary(response.content),
            offset: input.offset ?? 1,
            limited: input.limit !== undefined,
        };
        logToolCall(config, {
            tool: toolNames.read,
            workspaceId,
            path: input.path,
            success: true,
            durationMs: Math.round(performance.now() - startedAt),
        });
        return {
            ...response,
            _meta: {
                tool: toolNames.read,
                card: {
                    workspaceId,
                    path: input.path,
                    summary,
                    payload: { content: response.content },
                },
            },
            structuredContent: {
                result: contentText(response.content),
            },
        };
    });
    registerAppTool(server, toolNames.attachment, {
        title: "Read image or PDF attachment",
        description: [
            "Return a local or Remote Workspace image/PDF directly to the MCP client as native multimodal content.",
            "Use this instead of shell, local subagents, OCR, pdftotext, or Codex runtime tools when the model needs to inspect a PNG, JPEG, WebP, GIF, SVG, or PDF from a workspace.",
            "Raster images are returned as MCP image blocks; PDF and SVG files are returned as embedded MCP resource blocks. No local model or Codex invocation is performed.",
            "Call open_workspace first and pass workspaceId.",
        ].join(" "),
        inputSchema: {
            workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
            path: z.string().describe("Image or PDF path, relative to the workspace root."),
        },
        outputSchema: resultOutputSchema({
            path: z.string(),
            mimeType: z.string(),
            size: z.number(),
            attachmentKind: z.enum(["image", "resource"]),
        }),
        ...toolWidgetDescriptorMeta(config, "read"),
        annotations: READ_ONLY_TOOL_ANNOTATIONS,
    }, async ({ workspaceId, path }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        const readPath = workspaces.resolveReadPath(workspace, path);
        const extension = extname(path).toLowerCase();
        const mimeType = PREVIEW_MIME_TYPES.get(extension);
        const rasterImage = mimeType?.startsWith("image/") && mimeType !== "image/svg+xml";
        const embeddedResource = mimeType === "application/pdf" || mimeType === "image/svg+xml";
        if (!mimeType || (!rasterImage && !embeddedResource)) {
            throw new Error(`Unsupported native attachment type: ${extension || "(no extension)"}. Supported: PNG, JPEG, WebP, GIF, SVG, PDF.`);
        }

        const { bytes, size } = await loadNativeAttachmentBytes(workspace, path, readPath, workspaces, runtimeServices.remoteAgents);
        const attachmentKind = rasterImage ? "image" : "resource";
        const metadataText = `Native attachment: ${path} (${mimeType}, ${size} bytes).`;
        const content = [textBlock(metadataText), ...nativeAttachmentContent(workspace.id, path, mimeType, bytes)];
        logToolCall(config, {
            tool: toolNames.attachment,
            workspaceId,
            path,
            mimeType,
            size,
            success: true,
            durationMs: Math.round(performance.now() - startedAt),
        });
        return {
            content,
            structuredContent: {
                result: metadataText,
                path,
                mimeType,
                size,
                attachmentKind,
            },
        };
    });
    if (config.toolMode !== "codex") {
        registerAppTool(server, toolNames.write, {
            title: "Write file",
            description: `Create or completely overwrite a file inside an open workspace. Prefer ${toolNames.edit} for targeted changes to existing files. Call open_workspace first and pass workspaceId.`,
            inputSchema: {
                workspaceId: z
                    .string()
                    .describe("Workspace identifier returned by open_workspace."),
                path: z
                    .string()
                    .describe("File path to write, relative to the workspace root."),
                content: z.string().describe("Complete new file content."),
            },
            outputSchema: resultOutputSchema(),
            ...toolWidgetDescriptorMeta(config, "write"),
            annotations: WRITE_TOOL_ANNOTATIONS,
        }, async ({ workspaceId, ...input }) => {
            const startedAt = performance.now();
            const workspace = workspaces.getWorkspace(workspaceId);
            workspaces.resolvePath(workspace, input.path);
            await prepareMutation(reviewCheckpoints, runtimeServices.hookManager, {
                workspaceId,
                workspaceRoot: workspace.root,
                paths: [input.path],
                toolName: toolNames.write,
            });
            const response = isRemoteWorkspace(workspace)
                ? await runtimeServices.remoteAgents.writeBuffer(workspace, input.path, Buffer.from(input.content, "utf8")).then((result) => remoteTextToolResponse(`Wrote ${input.path} (${result.bytes} bytes).`))
                : await writeFileTool(input, {
                    cwd: workspace.root,
                    root: workspace.root,
                    allowExternalPaths: config.permissions.allowExternalPaths,
                });
            if (response.isError) {
                await finishMutation(reviewCheckpoints, runtimeServices.hookManager, {
                    workspaceId,
                    workspaceRoot: workspace.root,
                    toolName: toolNames.write,
                    success: false,
                });
                logFailedToolResponse(config, {
                    tool: toolNames.write,
                    workspaceId,
                    path: input.path,
                }, response.content, startedAt);
                return response;
            }
            const patch = newFilePatch(input.path, input.content);
            const stats = countDiffStats(patch);
            const summary = {
                ...stats,
                lines: contentLineCount(input.content),
                characters: input.content.length,
            };
            await finishMutation(reviewCheckpoints, runtimeServices.hookManager, {
                workspaceId,
                workspaceRoot: workspace.root,
                paths: [input.path],
                toolName: toolNames.write,
                success: true,
            });
            logToolCall(config, {
                tool: toolNames.write,
                workspaceId,
                path: input.path,
                success: true,
                durationMs: Math.round(performance.now() - startedAt),
            });
            return {
                ...response,
                _meta: {
                    tool: toolNames.write,
                    card: {
                        workspaceId,
                        path: input.path,
                        summary,
                        payload: {
                            content: response.content,
                            patch,
                        },
                    },
                },
                structuredContent: {
                    result: contentText(response.content),
                },
            };
        });
        registerAppTool(server, toolNames.edit, {
            title: "Edit file",
            description: `Edit one file inside an open workspace by replacing exact text blocks. Prefer this over ${toolNames.write} for targeted changes. Each oldText must match a unique, non-overlapping region of the original file; merge nearby changes into one edit and keep oldText as small as possible while still unique. Call open_workspace first and pass workspaceId.`,
            inputSchema: {
                workspaceId: z
                    .string()
                    .describe("Workspace identifier returned by open_workspace."),
                path: z
                    .string()
                    .describe("File path to edit, relative to the workspace root."),
                edits: z
                    .array(z.object({
                    oldText: z
                        .string()
                        .describe("Exact text to replace. Must match uniquely in the original file."),
                    newText: z.string().describe("Replacement text."),
                }))
                    .min(1),
            },
            outputSchema: resultOutputSchema({
                status: z.literal("applied"),
            }),
            ...toolWidgetDescriptorMeta(config, "edit"),
            annotations: EDIT_TOOL_ANNOTATIONS,
        }, async ({ workspaceId, ...input }) => {
            const startedAt = performance.now();
            const workspace = workspaces.getWorkspace(workspaceId);
            workspaces.resolvePath(workspace, input.path);
            await prepareMutation(reviewCheckpoints, runtimeServices.hookManager, {
                workspaceId,
                workspaceRoot: workspace.root,
                paths: [input.path],
                toolName: toolNames.edit,
            });
            let response;
            if (isRemoteWorkspace(workspace)) {
                const beforeBytes = await runtimeServices.remoteAgents.readWhole(workspace, input.path);
                if (beforeBytes === null)
                    throw new Error(`Remote edit target does not exist: ${input.path}`);
                const before = decodeRemoteUtf8(beforeBytes, input.path);
                const after = applyRemoteStructuredEdits(input.path, before, input.edits);
                await runtimeServices.remoteAgents.writeBuffer(workspace, input.path, Buffer.from(after, "utf8"));
                const patch = unifiedFilePatch(input.path, input.path, before, after);
                response = { ...remoteTextToolResponse(`Edited ${input.path}.`), details: { diff: patch, patch } };
            }
            else {
                response = await editFileTool(input, {
                    cwd: workspace.root,
                    root: workspace.root,
                    allowExternalPaths: config.permissions.allowExternalPaths,
                });
            }
            if (response.isError) {
                await finishMutation(reviewCheckpoints, runtimeServices.hookManager, {
                    workspaceId,
                    workspaceRoot: workspace.root,
                    toolName: toolNames.edit,
                    success: false,
                });
                logFailedToolResponse(config, {
                    tool: toolNames.edit,
                    workspaceId,
                    path: input.path,
                }, response.content, startedAt);
                return response;
            }
            const stats = countDiffStats(response.details?.patch ?? response.details?.diff);
            const summary = {
                ...stats,
                editCount: input.edits.length,
            };
            const editResultText = `Edited ${input.path} (+${stats.additions} -${stats.removals}).`;
            const editContent = [textBlock(editResultText)];
            await finishMutation(reviewCheckpoints, runtimeServices.hookManager, {
                workspaceId,
                workspaceRoot: workspace.root,
                paths: [input.path],
                toolName: toolNames.edit,
                success: true,
            });
            logToolCall(config, {
                tool: toolNames.edit,
                workspaceId,
                path: input.path,
                success: true,
                durationMs: Math.round(performance.now() - startedAt),
            });
            return {
                content: editContent,
                _meta: {
                    tool: toolNames.edit,
                    card: {
                        workspaceId,
                        path: input.path,
                        summary,
                        payload: {
                            diff: response.details?.diff,
                            patch: response.details?.patch,
                        },
                    },
                },
                structuredContent: {
                    status: "applied",
                    result: contentText(editContent),
                },
            };
        });
    }
    if (config.toolMode === "codex") {
        registerAppTool(server, "apply_patch", {
            title: "Apply patch",
            description: "Apply one Codex-style patch inside an open workspace. Supports adding, overwriting, updating, deleting, and moving files. Use this for all file modifications. Paths must be relative to the workspace. Call open_workspace first and pass workspaceId.",
            inputSchema: {
                workspaceId: z
                    .string()
                    .describe("Workspace identifier returned by open_workspace."),
                patch: z
                    .string()
                    .describe("Patch text enclosed by *** Begin Patch and *** End Patch markers."),
            },
            outputSchema: resultOutputSchema({
                additions: z.number(),
                removals: z.number(),
                files: z.array(z.object({
                    path: z.string(),
                    previousPath: z.string().optional(),
                    operation: z.enum(["add", "update", "delete", "move"]),
                })),
            }),
            ...toolWidgetDescriptorMeta(config, "edit"),
            annotations: EDIT_TOOL_ANNOTATIONS,
        }, async ({ workspaceId, patch }) => {
            const startedAt = performance.now();
            const workspace = workspaces.getWorkspace(workspaceId);
            const actions = parsePatch(patch);
            const mutationPaths = Array.from(new Set(actions.flatMap((action) => [action.path, action.moveTo].filter(Boolean))));
            await prepareMutation(reviewCheckpoints, runtimeServices.hookManager, {
                workspaceId,
                workspaceRoot: workspace.root,
                paths: mutationPaths,
                toolName: "apply_patch",
            });
            const applied = isRemoteWorkspace(workspace)
                ? await applyRemotePatch(workspace, patch, workspaces, runtimeServices.remoteAgents)
                : await applyPatch(workspace.root, patch);
            const paths = applied.files.map((file) => file.path).join(", ");
            const result = `Applied patch to ${applied.files.length} file(s): ${paths}`;
            const preview = await collectWorkspacePreviews(workspace, applied.files, workspaces, runtimeServices.remoteAgents);
            const content = [textBlock(result), ...preview.imageContent];
            const displayPath = applied.files.length === 1
                ? applied.files[0]?.path
                : `${applied.files.length} files`;
            await finishMutation(reviewCheckpoints, runtimeServices.hookManager, {
                workspaceId,
                workspaceRoot: workspace.root,
                paths: mutationPaths,
                toolName: "apply_patch",
                success: true,
            });
            logToolCall(config, {
                tool: "apply_patch",
                workspaceId,
                success: true,
                durationMs: Math.round(performance.now() - startedAt),
            });
            return {
                content,
                _meta: {
                    tool: "apply_patch",
                    card: {
                        workspaceId,
                        path: displayPath,
                        summary: {
                            files: applied.files.length,
                            additions: applied.additions,
                            removals: applied.removals,
                        },
                        files: applied.files,
                        previews: preview.previews,
                        artifacts: preview.artifacts,
                        payload: { patch: applied.patch },
                    },
                },
                structuredContent: {
                    result,
                    additions: applied.additions,
                    removals: applied.removals,
                    files: applied.files,
                },
            };
        });
    }
    if (config.widgets !== "off") {
        registerAppTool(server, "show_changes", {
            title: "Show changes",
            description: "Show aggregate file changes for an open workspace. If the current turn successfully modified files, call this exactly once after the final related file change and before your final response so the user can inspect the combined diff for the turn. Do not call it after every individual file change, and do not skip it because prior file-change tools already displayed per-tool diffs.",
            inputSchema: {
                workspaceId: z
                    .string()
                    .describe("Workspace identifier returned by open_workspace."),
            },
            outputSchema: resultOutputSchema({
                operations: z.array(z.unknown()),
                sessionReview: z.unknown(),
            }),
            ...toolWidgetDescriptorMeta(config, "show_changes"),
            annotations: READ_ONLY_TOOL_ANNOTATIONS,
        }, async ({ workspaceId }) => {
            const startedAt = performance.now();
            const workspace = workspaces.getWorkspace(workspaceId);
            if (runtimeServices.hookManager.hasEvent("before_review")
                || runtimeServices.hookManager.hasEvent("after_review")) {
                await reviewCheckpoints.beforeMutation({
                    workspaceId,
                    root: workspace.root,
                    kind: "shell",
                });
            }
            await runtimeServices.hookManager.runEvent("before_review", {
                workspaceId,
                workspaceRoot: workspace.root,
                toolName: "show_changes",
            }, { strict: true });
            const review = await reviewCheckpoints.reviewChanges({
                workspaceId,
                root: workspace.root,
                since: "last_shown",
                markReviewed: true,
            });
            const sessionReview = await reviewCheckpoints.sessionReview({
                workspaceId,
                root: workspace.root,
            });
            const previousCursor = reviewToolCursors.get(workspaceId) ?? 0;
            const operationRecords = runtimeServices.runtimeState
                .listToolCalls({ workspaceId, limit: 500 })
                .filter((record) => record.id > previousCursor && REVIEW_OPERATION_TOOLS.has(record.tool))
                .sort((left, right) => left.id - right.id);
            const operations = operationRecords.map(reviewOperation);
            const latestOperationId = operationRecords.at(-1)?.id;
            if (latestOperationId !== undefined)
                reviewToolCursors.set(workspaceId, latestOperationId);
            const preview = await collectWorkspacePreviews(workspace, review.files, workspaces, runtimeServices.remoteAgents);
            const content = [textBlock(review.result), ...preview.imageContent];
            await runtimeServices.hookManager.runEvent("after_review", {
                workspaceId,
                workspaceRoot: workspace.root,
                toolName: "show_changes",
                success: true,
            });
            logToolCall(config, {
                tool: "show_changes",
                workspaceId,
                success: true,
                durationMs: Math.round(performance.now() - startedAt),
            });
            return {
                content,
                _meta: {
                    tool: "show_changes",
                    card: {
                        workspaceId,
                        summary: review.summary,
                        files: review.files,
                        operations,
                        previews: preview.previews,
                        artifacts: preview.artifacts,
                        sessionReview,
                        payload: {
                            patch: review.patch,
                        },
                    },
                },
                structuredContent: {
                    result: contentText(content),
                    operations,
                    sessionReview,
                },
            };
        });
    }
    if (config.toolMode === "full") {
        registerAppTool(server, toolNames.grep, {
            title: "Grep",
            description: "Search file contents inside an open workspace. Use this before broad reads when looking for symbols, text, or usage sites. Respects project ignore rules. Call open_workspace first and pass workspaceId.",
            inputSchema: {
                workspaceId: z
                    .string()
                    .describe("Workspace identifier returned by open_workspace."),
                pattern: z.string().describe("Search pattern."),
                path: z
                    .string()
                    .optional()
                    .describe("Optional path or glob scope relative to the workspace root."),
                include: z.string().optional().describe("Optional include glob."),
            },
            outputSchema: resultOutputSchema(),
            ...toolWidgetDescriptorMeta(config, "search"),
            annotations: READ_ONLY_TOOL_ANNOTATIONS,
        }, async ({ workspaceId, ...input }) => {
            const startedAt = performance.now();
            const workspace = workspaces.getWorkspace(workspaceId);
            if (input.path)
                workspaces.resolvePath(workspace, input.path);
            const response = isRemoteWorkspace(workspace)
                ? await runtimeServices.remoteAgents.rpcWorkspace(workspace, "search.grep", input, 60_000).then((result) => remoteTextToolResponse(remoteGrepText(result)))
                : await grepFilesTool(input, {
                    cwd: workspace.root,
                    root: workspace.root,
                    allowExternalPaths: config.permissions.allowExternalPaths,
                });
            if (response.isError) {
                logFailedToolResponse(config, {
                    tool: toolNames.grep,
                    workspaceId,
                    path: input.path,
                }, response.content, startedAt);
                return response;
            }
            const summary = {
                pattern: input.pattern,
                scope: input.path ?? ".",
                ...textSummary(response.content),
            };
            logToolCall(config, {
                tool: toolNames.grep,
                workspaceId,
                path: input.path,
                success: true,
                durationMs: Math.round(performance.now() - startedAt),
            });
            return {
                ...response,
                _meta: {
                    tool: toolNames.grep,
                    card: {
                        workspaceId,
                        path: input.path,
                        summary,
                        payload: { content: response.content },
                    },
                },
                structuredContent: {
                    result: contentText(response.content),
                },
            };
        });
        registerAppTool(server, toolNames.glob, {
            title: "Glob",
            description: "Find files by glob pattern inside an open workspace. Use this to discover filenames or narrow file sets before reading. Respects project ignore rules. Call open_workspace first and pass workspaceId.",
            inputSchema: {
                workspaceId: z
                    .string()
                    .describe("Workspace identifier returned by open_workspace."),
                pattern: z.string().describe("File glob pattern."),
                path: z
                    .string()
                    .optional()
                    .describe("Optional path scope relative to the workspace root."),
            },
            outputSchema: resultOutputSchema(),
            ...toolWidgetDescriptorMeta(config, "search"),
            annotations: READ_ONLY_TOOL_ANNOTATIONS,
        }, async ({ workspaceId, ...input }) => {
            const startedAt = performance.now();
            const workspace = workspaces.getWorkspace(workspaceId);
            if (input.path)
                workspaces.resolvePath(workspace, input.path);
            const response = isRemoteWorkspace(workspace)
                ? await runtimeServices.remoteAgents.rpcWorkspace(workspace, "search.glob", input, 60_000).then((result) => remoteTextToolResponse(remoteGlobText(result)))
                : await findFilesTool(input, {
                    cwd: workspace.root,
                    root: workspace.root,
                    allowExternalPaths: config.permissions.allowExternalPaths,
                });
            if (response.isError) {
                logFailedToolResponse(config, {
                    tool: toolNames.glob,
                    workspaceId,
                    path: input.path,
                }, response.content, startedAt);
                return response;
            }
            const summary = {
                pattern: input.pattern,
                scope: input.path ?? ".",
                ...textSummary(response.content),
            };
            logToolCall(config, {
                tool: toolNames.glob,
                workspaceId,
                path: input.path,
                success: true,
                durationMs: Math.round(performance.now() - startedAt),
            });
            return {
                ...response,
                _meta: {
                    tool: toolNames.glob,
                    card: {
                        workspaceId,
                        path: input.path,
                        summary,
                        payload: { content: response.content },
                    },
                },
                structuredContent: {
                    result: contentText(response.content),
                },
            };
        });
        registerAppTool(server, toolNames.ls, {
            title: "Ls",
            description: "List a directory inside an open workspace. Use this for directory inspection before reading files. Call open_workspace first and pass workspaceId.",
            inputSchema: {
                workspaceId: z
                    .string()
                    .describe("Workspace identifier returned by open_workspace."),
                path: z
                    .string()
                    .describe("Directory path to list, relative to the workspace root."),
            },
            outputSchema: resultOutputSchema(),
            ...toolWidgetDescriptorMeta(config, "directory"),
            annotations: READ_ONLY_TOOL_ANNOTATIONS,
        }, async ({ workspaceId, ...input }) => {
            const startedAt = performance.now();
            const workspace = workspaces.getWorkspace(workspaceId);
            workspaces.resolvePath(workspace, input.path);
            const response = isRemoteWorkspace(workspace)
                ? await runtimeServices.remoteAgents.rpcWorkspace(workspace, "fs.list", input, 60_000).then((result) => remoteTextToolResponse(remoteListText(result)))
                : await listDirectoryTool(input, {
                    cwd: workspace.root,
                    root: workspace.root,
                    allowExternalPaths: config.permissions.allowExternalPaths,
                });
            if (response.isError) {
                logFailedToolResponse(config, {
                    tool: toolNames.ls,
                    workspaceId,
                    path: input.path,
                }, response.content, startedAt);
                return response;
            }
            const summary = textSummary(response.content);
            logToolCall(config, {
                tool: toolNames.ls,
                workspaceId,
                path: input.path,
                success: true,
                durationMs: Math.round(performance.now() - startedAt),
            });
            return {
                ...response,
                _meta: {
                    tool: toolNames.ls,
                    card: {
                        workspaceId,
                        path: input.path,
                        summary,
                        payload: { content: response.content },
                    },
                },
                structuredContent: {
                    result: contentText(response.content),
                },
            };
        });
    }
    if (config.toolMode !== "codex") {
        registerAppTool(server, toolNames.shell, {
            title: "Bash",
            description: commandToolDescription(config, toolNames.shell),
            inputSchema: {
                workspaceId: z
                    .string()
                    .describe("Workspace identifier returned by open_workspace."),
                command: z
                    .string()
                    .describe(config.permissions.allowArbitraryCommands
                    ? "Arbitrary command authorized by the owner and executed as the current Windows user."
                    : `Shell command to run. ${config.permissions.allowShellMutation ? "Shell file changes are authorized." : `Prefer ${toolNames.edit} or ${toolNames.write} for file changes.`}`),
                workingDirectory: z
                    .string()
                    .optional()
                    .describe(workingDirectoryDescription(config)),
                timeout: z
                    .number()
                    .positive()
                    .max(300)
                    .optional()
                    .describe("Timeout in seconds. Defaults to 30, max 300."),
            },
            outputSchema: resultOutputSchema(),
            ...toolWidgetDescriptorMeta(config, "shell"),
            annotations: SHELL_TOOL_ANNOTATIONS,
        }, async ({ workspaceId, workingDirectory, ...input }) => {
            const startedAt = performance.now();
            const workspace = workspaces.getWorkspace(workspaceId);
            const cwd = workspaces.resolveWorkingDirectory(workspace, workingDirectory);
            await prepareMutation(reviewCheckpoints, runtimeServices.hookManager, {
                workspaceId,
                workspaceRoot: workspace.root,
                kind: "shell",
                toolName: toolNames.shell,
            });
            await runtimeServices.hookManager.runEvent("before_command", {
                workspaceId,
                workspaceRoot: workspace.root,
                toolName: toolNames.shell,
            }, { strict: true });
            const response = isRemoteWorkspace(workspace)
                ? await runtimeServices.remoteAgents.rpcWorkspace(workspace, "shell.run", { ...input, cwd }, Math.min(310_000, Math.max(30_000, Number(input.timeout ?? 30) * 1000 + 10_000))).then((result) => ({ ...remoteTextToolResponse(result.output), details: { exitCode: result.exitCode } }))
                : await runShellTool(input, {
                    cwd,
                    root: workspace.root,
                    allowExternalPaths: config.permissions.allowExternalPaths,
                });
            if (response.isError) {
                await runtimeServices.hookManager.runEvent("after_command", {
                    workspaceId,
                    workspaceRoot: workspace.root,
                    toolName: toolNames.shell,
                    success: false,
                });
                await finishMutation(reviewCheckpoints, runtimeServices.hookManager, {
                    workspaceId,
                    workspaceRoot: workspace.root,
                    toolName: toolNames.shell,
                    success: false,
                });
                logFailedToolResponse(config, {
                    tool: toolNames.shell,
                    workspaceId,
                    workingDirectory: workingDirectory ?? ".",
                    command: input.command,
                    commandLength: input.command.length,
                }, response.content, startedAt);
                return response;
            }
            const summary = {
                command: input.command,
                workingDirectory: workingDirectory ?? ".",
                ...textSummary(response.content),
            };
            await runtimeServices.hookManager.runEvent("after_command", {
                workspaceId,
                workspaceRoot: workspace.root,
                toolName: toolNames.shell,
                success: true,
            });
            await finishMutation(reviewCheckpoints, runtimeServices.hookManager, {
                workspaceId,
                workspaceRoot: workspace.root,
                toolName: toolNames.shell,
                success: true,
            });
            logToolCall(config, {
                tool: toolNames.shell,
                workspaceId,
                workingDirectory: workingDirectory ?? ".",
                command: input.command,
                commandLength: input.command.length,
                success: true,
                durationMs: Math.round(performance.now() - startedAt),
            });
            return {
                ...response,
                _meta: {
                    tool: toolNames.shell,
                    card: {
                        workspaceId,
                        path: workingDirectory,
                        summary,
                        payload: { content: response.content },
                    },
                },
                structuredContent: {
                    result: contentText(response.content),
                },
            };
        });
    }
    if (config.toolMode === "codex") {
        registerCodexProcessTools(server, config, workspaces, processSessions, runtimeServices.permissionRules, reviewCheckpoints, runtimeServices.hookManager, runtimeServices.remoteAgents);
    }
    if (config.artifactsEnabled && isArtifactDownloadSupportedPlatform()) {
        registerArtifactTools(server, {
            config,
            workspaces,
            incomingArtifactAdapters,
        });
    }
    return server;
}
export function createServer(config = loadConfig(), options = {}) {
    const incomingArtifactAdapters = options.incomingArtifactAdapters
        ?? [createOpenAIIncomingArtifactAdapter()];
    const allowedHosts = config.allowedHosts.includes("*")
        ? undefined
        : Array.from(new Set([config.host, ...config.allowedHosts]));
    const app = createMcpExpressApp({
        host: config.host,
        ...(allowedHosts ? { allowedHosts } : {}),
    });
    const transports = new McpSessionRegistry({ maxSessions: MCP_SESSION_MAX_ACTIVE });
    const mcpUrl = new URL("/mcp", config.publicBaseUrl);
    const resourceServerUrl = resourceUrlFromServerUrl(mcpUrl);
    const oauthProvider = new SingleUserOAuthProvider(config.oauth, mcpUrl, config.stateDir);
    const bearerAuth = requireBearerAuth({
        verifier: oauthProvider,
        requiredScopes: [config.oauth.scopes[0] ?? "devspace"],
        resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl),
    });
    const runtimeState = new StructuredRuntimeState(config.stateDir);
    structuredRuntimeState = runtimeState;
    const remoteAgents = new RemoteAgentManager(config, runtimeState);
    const pluginManager = new PluginManager(config, runtimeState);
    if (!Object.prototype.hasOwnProperty.call(config, "_devspaceBaseSkillPaths")) {
        Object.defineProperty(config, "_devspaceBaseSkillPaths", {
            value: [...(config.skillPaths ?? [])],
            enumerable: false,
            configurable: false,
            writable: false,
        });
    }
    config.skillPaths = Array.from(new Set([...config._devspaceBaseSkillPaths, ...pluginManager.enabledSkillRoots()]));
    const workspaceStore = createWorkspaceStore(config.stateDir);
    const workspaces = new WorkspaceRegistry(config, workspaceStore, remoteAgents);
    const uiLease = new UiSessionLease(config);
    const memoryStore = new MemoryStore(runtimeState.database.sqlite);
    const hookManager = new HookManager(config, runtimeState, workspaces, remoteAgents);
    const reviewCheckpoints = createReviewCheckpointManager({
        stateDir: config.stateDir,
        uiLease,
        sessionReviewEnabled: config.features?.uiSessionReview,
        resolveIo: (workspaceId) => {
            const workspace = workspaces.getWorkspace(workspaceId);
            if (!isRemoteWorkspace(workspace))
                return undefined;
            return {
                kind: "remote-agent",
                root: workspace.root,
                backendId: workspace.backendId,
                resolvePath: (value) => workspaces.resolvePath(workspace, value),
                capture: (value) => remoteAgents.capture(workspace, value),
                restore: (value, descriptor, content) => remoteAgents.restore(workspace, value, descriptor, content),
            };
        },
    });
    const processSessions = new ProcessSessionManager({ stateDir: config.stateDir, runtimeState });
    const fileWatches = new FileWatchManager(runtimeState);
    const permissionRules = new PermissionRuleEngine(config, runtimeState);
    const localAgentProviders = config.subagents
        ? getLocalAgentProviderAvailabilitySnapshot()
        : [];
    const logSessionCloseResults = (reason, results) => {
        for (const result of results) {
            if (result.error) {
                logEvent(config.logging, "warn", "mcp_session_close_failed", {
                    reason,
                    sessionIdPrefix: sessionIdPrefix(result.sessionId),
                    error: result.error instanceof Error
                        ? result.error.message
                        : String(result.error),
                });
                continue;
            }
            logEvent(config.logging, "info", "mcp_session_closed", {
                reason,
                sessionIdPrefix: sessionIdPrefix(result.sessionId),
            });
        }
    };
    const sessionCleanupTimer = setInterval(() => {
        void transports
            .closeIdle(MCP_SESSION_IDLE_TIMEOUT_MS)
            .then((results) => logSessionCloseResults("idle_timeout", results));
    }, MCP_SESSION_CLEANUP_INTERVAL_MS);
    sessionCleanupTimer.unref();
    if (config.logging.trustProxy) {
        // The supported deployments terminate TLS at a single local reverse proxy
        // (for example ngrok or Tailscale Funnel). Trusting every proxy allows a
        // remote client to spoof X-Forwarded-For and bypass IP-based rate limits.
        app.set("trust proxy", 1);
    }
    app.use((req, res, next) => {
        const requestId = randomUUID();
        const startedAt = performance.now();
        res.locals.requestId = requestId;
        res.on("finish", () => {
            const path = requestPath(req);
            if (!config.logging.requests)
                return;
            if (!config.logging.assets && path.startsWith("/mcp-app-assets"))
                return;
            logEvent(config.logging, "info", "http_request", {
                requestId,
                method: req.method,
                path,
                status: res.statusCode,
                durationMs: Math.round(performance.now() - startedAt),
                ...requestLogFields(req, config),
            });
        });
        next();
    });
    app.get("/agent/v1/devspace-agent.py", (_req, res) => {
        const asset = linuxAgentAsset("devspace-agent.py");
        res.setHeader("Content-Type", "text/x-python; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache, no-store, max-age=0");
        res.setHeader("X-Content-SHA256", asset.sha256);
        res.send(asset.bytes);
    });
    app.get("/agent/v1/install.sh", (_req, res) => {
        const asset = linuxAgentAsset("install.sh");
        res.setHeader("Content-Type", "text/x-shellscript; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache, no-store, max-age=0");
        res.setHeader("X-Content-SHA256", asset.sha256);
        res.send(asset.bytes);
    });
    app.use(mcpAuthRouter({
        provider: oauthProvider,
        issuerUrl: new URL(config.publicBaseUrl),
        baseUrl: new URL(config.publicBaseUrl),
        resourceServerUrl,
        scopesSupported: config.oauth.scopes,
        resourceName: "DevSpace",
    }));
    app.options("/mcp-app-assets/{*asset}", (_req, res) => {
        setAssetHeaders(res);
        res.sendStatus(204);
    });
    app.use("/mcp-app-assets", express.static(uiBuildDirectory(), {
        immutable: true,
        maxAge: "1y",
        fallthrough: false,
        setHeaders: setAssetHeaders,
    }));
    app.get("/healthz", (_req, res) => {
        res.json({ ok: true, name: "devspace" });
    });
    app.all("/mcp", async (req, res) => {
        const requestId = res.locals.requestId;
        const sessionId = req.header("mcp-session-id");
        const initializeRequest = req.method === "POST" && isInitializeRequest(req.body);
        await new Promise((resolve, reject) => {
            bearerAuth(req, res, (error) => {
                if (error)
                    reject(error);
                else
                    resolve();
            });
        });
        if (res.headersSent)
            return;
        if (!req.auth?.resource || !checkResourceAllowed({ requestedResource: req.auth.resource, configuredResource: resourceServerUrl })) {
            logEvent(config.logging, "warn", "auth_denied", {
                requestId,
                method: req.method,
                path: requestPath(req),
                reason: "invalid_oauth_resource",
                ...requestLogFields(req, config),
            });
            sendJsonRpcError(res, 401, -32001, "Unauthorized");
            return;
        }
        logEvent(config.logging, "debug", "mcp_request", {
            requestId,
            method: req.method,
            sessionIdPresent: Boolean(sessionId),
            sessionIdPrefix: sessionIdPrefix(sessionId),
            isInitialize: initializeRequest,
        });
        try {
            let transport;
            if (sessionId) {
                transport = transports.get(sessionId);
                if (!transport) {
                    sendJsonRpcError(res, 404, -32000, "Unknown MCP session");
                    return;
                }
            }
            else if (initializeRequest) {
                transport = new StreamableHTTPServerTransport({
                    sessionIdGenerator: () => randomUUID(),
                    onsessioninitialized: (newSessionId) => {
                        if (transport)
                            transports.register(newSessionId, transport);
                        logEvent(config.logging, "info", "mcp_session_created", {
                            requestId,
                            sessionIdPrefix: sessionIdPrefix(newSessionId),
                            ...requestLogFields(req, config),
                        });
                    },
                });
                transport.onclose = () => {
                    const closedSessionId = transport?.sessionId;
                    if (closedSessionId && transports.remove(closedSessionId)) {
                        logEvent(config.logging, "info", "mcp_session_closed", {
                            reason: "transport_close",
                            sessionIdPrefix: sessionIdPrefix(closedSessionId),
                        });
                    }
                };
                const server = createMcpServer(config, workspaces, reviewCheckpoints, processSessions, localAgentProviders, incomingArtifactAdapters, {
                    runtimeState,
                    fileWatches,
                    permissionRules,
                    pluginManager,
                    uiLease,
                    memoryStore,
                    hookManager,
                    remoteAgents,
                });
                await server.connect(transport);
            }
            else {
                sendJsonRpcError(res, 400, -32000, "No valid MCP session");
                return;
            }
            await transport.handleRequest(req, res, req.body);
        }
        catch (error) {
            logEvent(config.logging, "error", "mcp_request_error", {
                requestId,
                error: error instanceof Error ? error.message : String(error),
            });
            if (!res.headersSent) {
                sendJsonRpcError(res, 500, -32603, "Internal server error");
            }
        }
    });
    let closePromise;
    return {
        app,
        config,
        localAgentProviders,
        processSessions,
        runtimeState,
        fileWatches,
        permissionRules,
        pluginManager,
        remoteAgents,
        attachAgentHttpServer: (httpServer) => remoteAgents.attachHttpServer(httpServer),
        close: () => {
            closePromise ??= (async () => {
                clearInterval(sessionCleanupTimer);
                const results = await transports.closeAll();
                logSessionCloseResults("server_shutdown", results);
                fileWatches.close();
                processSessions.shutdown({ preservePersistent: true });
                await remoteAgents.close();
                oauthProvider.close();
                workspaceStore.close?.();
                pluginManager.close();
                runtimeState.close();
                if (structuredRuntimeState === runtimeState)
                    structuredRuntimeState = undefined;
            })();
            return closePromise;
        },
    };
}
async function isMainModule() {
    if (!process.argv[1])
        return false;
    const modulePath = await realpath(fileURLToPath(import.meta.url));
    const entrypointPath = await realpath(process.argv[1]);
    return modulePath === entrypointPath;
}
if (await isMainModule()) {
    const { app, config, close, localAgentProviders, processSessions, pluginManager, remoteAgents, attachAgentHttpServer } = createServer();
    const httpServer = app.listen(config.port, config.host, () => {
        console.log(`devspace listening on http://${config.host}:${config.port}/mcp`);
        console.log(`allowed roots: ${config.allowedRoots.join(", ")}`);
        console.log(`access profile: ${config.permissions.profile}`);
        console.log(`external paths: ${config.permissions.allowExternalPaths ? "allowed" : "workspace only"}`);
        console.log(`arbitrary commands: ${config.permissions.allowArbitraryCommands ? "allowed" : "coding workflow"}`);
        console.log(`interactive/persistent processes: ${config.permissions.allowInteractiveProcesses ? "enabled" : "disabled"}/${config.permissions.allowPersistentProcesses ? "enabled" : "disabled"}`);
        console.log(`recovered process records: ${processSessions.recoveredProcesses.length}`);
        console.log(`protocol/server version: ${DEVSPACE_PROTOCOL_VERSION}/${DEVSPACE_SERVER_VERSION}`);
        console.log(`plugins: ${pluginManager.list().filter((plugin) => plugin.enabled).length} enabled, ${pluginManager.list().length} cached`);
        console.log(`remote agents: ${remoteAgents.list().filter((agent) => agent.connected).length} connected, ${remoteAgents.list().length} enrolled`);
        console.log("auth: oauth owner-token flow required");
        console.log(`logging: ${config.logging.level} ${config.logging.format}`);
        console.log(`request logging: ${config.logging.requests ? "enabled" : "disabled"}`);
        console.log(`asset logging: ${config.logging.assets ? "enabled" : "disabled"}`);
        console.log(`trust proxy: ${config.logging.trustProxy ? "enabled" : "disabled"}`);
        const artifactDownloadStatus = !config.artifactsEnabled
            ? "disabled"
            : isArtifactDownloadSupportedPlatform()
                ? "enabled"
                : `unsupported on ${process.platform}`;
        console.log(`native artifact download: ${artifactDownloadStatus}`);
        if (config.subagents) {
            console.log(`subagent providers: ${formatLocalAgentProviderAvailabilitySummary(localAgentProviders)}`);
        }
    });
    attachAgentHttpServer(httpServer);
    let shuttingDown = false;
    const shutdown = async () => {
        if (shuttingDown)
            return;
        shuttingDown = true;
        await shutdownHttpServer(httpServer, close);
        process.exit(0);
    };
    const handleShutdown = () => {
        void shutdown().catch((error) => {
            console.error("devspace shutdown failed", error);
            process.exit(1);
        });
    };
    process.once("SIGINT", handleShutdown);
    process.once("SIGTERM", handleShutdown);
}

// Export pure response/preview helpers for packaged smoke tests. They do not
// bypass workspace path validation or expose server state.
export { collectWorkspacePreviews, nativeAttachmentContent, processToolResponse, redactDisplayArgv, reviewOperation, shouldAttachWidget, toolInvocationStatus, toolWidgetDescriptorMeta, workspaceAppHtml };
