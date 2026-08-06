import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import * as z from "zod/v4";
import { captureDesktop, performComputerAction } from "./computer-use.js";

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
const COMPUTER_ANNOTATIONS = {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
};

function textBlock(text) {
    return { type: "text", text };
}

function jsonResult(value, extra = {}) {
    const result = JSON.stringify(value, null, 2);
    return {
        content: [textBlock(result)],
        structuredContent: { result, ...extra },
    };
}

function requireFeature(config, key, label) {
    if (!config.features?.[key])
        throw new Error(`${label} is disabled in the local DevSpace Portable UI. Enable it and restart DevSpace.`);
}

function computerUseGuard(config, uiLease) {
    requireFeature(config, "computerUse", "Computer Use");
    if (!config.permissions.allowComputerUse) {
        throw new Error("Computer Use is not authorized by the active permission profile. Use full-access or enable Computer Use in the custom profile.");
    }
    return uiLease.requireActive("Computer Use");
}

function validateComputerAction(input) {
    if (Array.isArray(input.steps)) {
        if (input.steps.length < 1 || input.steps.length > 50)
            throw new Error("computer_action steps must contain 1 to 50 actions.");
        const totalDelay = input.steps.reduce((sum, step) => sum + Number(step?.delayMs || 0), 0);
        if (totalDelay > 30_000)
            throw new Error("computer_action sequence delay must not exceed 30000 ms in total.");
        const totalText = input.steps.reduce((sum, step) => sum + (typeof step?.text === "string" ? step.text.length : 0), 0);
        if (totalText > 80_000)
            throw new Error("computer_action sequence text must not exceed 80000 characters in total.");
        for (const step of input.steps)
            validateComputerAction(step);
        return;
    }
    if (!input.action)
        throw new Error("computer_action requires action or steps.");
    const pointActions = new Set(["move", "click", "double_click", "right_click"]);
    if (pointActions.has(input.action)
        && (!Number.isInteger(input.x) || !Number.isInteger(input.y))) {
        throw new Error(`${input.action} requires integer x and y coordinates.`);
    }
    if (input.action === "scroll" && !Number.isInteger(input.delta))
        throw new Error("scroll requires an integer delta.");
    if (input.action === "keypress" && (!Array.isArray(input.keys) || input.keys.length === 0))
        throw new Error("keypress requires at least one allowlisted key.");
    if (input.action === "type_text" && typeof input.text !== "string")
        throw new Error("type_text requires text.");
}

export function registerFeatureTools(server, services) {
    const {
        config,
        workspaces,
        runtimeState,
        memoryStore,
        hookManager,
        reviewCheckpoints,
        uiLease,
        toolMeta,
    } = services;

    registerAppTool(server, "memory_list", {
        title: "List memories",
        description: "List explicit DevSpace memories relevant to an open workspace. Memories are user-visible, deletable, and never inferred from command output or browsing history.",
        inputSchema: {
            workspaceId: z.string(),
            includeGlobal: z.boolean().optional(),
            query: z.string().max(500).optional(),
            limit: z.number().int().min(1).max(200).optional(),
        },
        outputSchema: { result: z.string(), memories: z.array(z.unknown()) },
        ...toolMeta("read"),
        annotations: READ_ONLY_ANNOTATIONS,
    }, async ({ workspaceId, includeGlobal, query, limit }) => {
        requireFeature(config, "memories", "Memories");
        const workspace = workspaces.getWorkspace(workspaceId);
        const memories = memoryStore.list({
            workspaceRoot: workspace.root,
            includeGlobal: includeGlobal ?? true,
            query,
            limit,
        });
        runtimeState.appendEvent({ kind: "memory.listed", workspaceId, payload: { count: memories.length, query: query ?? null } });
        return jsonResult(memories, { memories });
    });

    registerAppTool(server, "memory_upsert", {
        title: "Save memory",
        description: "Create or update an explicit global or workspace-scoped DevSpace memory. The tool rejects credential-looking content by default; store references to secret locations instead of the secrets themselves.",
        inputSchema: {
            workspaceId: z.string(),
            id: z.string().optional(),
            scope: z.enum(["global", "workspace"]).optional(),
            title: z.string().min(1).max(200),
            content: z.string().min(1).max(8000),
            tags: z.array(z.string().max(80)).max(20).optional(),
            allowSensitive: z.boolean().optional(),
        },
        outputSchema: { result: z.string(), memory: z.unknown() },
        ...toolMeta("write"),
        annotations: WRITE_ANNOTATIONS,
    }, async ({ workspaceId, ...input }) => {
        requireFeature(config, "memories", "Memories");
        const workspace = workspaces.getWorkspace(workspaceId);
        const memory = memoryStore.upsert({
            ...input,
            scope: input.scope ?? "workspace",
            workspaceRoot: workspace.root,
        });
        runtimeState.appendEvent({ kind: "memory.saved", subject: memory.id, workspaceId, payload: { scope: memory.scope, title: memory.title, tags: memory.tags } });
        return jsonResult(memory, { memory });
    });

    registerAppTool(server, "memory_delete", {
        title: "Delete memory",
        description: "Delete one explicit DevSpace memory by id.",
        inputSchema: { workspaceId: z.string(), id: z.string() },
        outputSchema: { result: z.string(), memory: z.unknown() },
        ...toolMeta("write"),
        annotations: WRITE_ANNOTATIONS,
    }, async ({ workspaceId, id }) => {
        requireFeature(config, "memories", "Memories");
        workspaces.getWorkspace(workspaceId);
        const memory = memoryStore.delete(id);
        runtimeState.appendEvent({ kind: "memory.deleted", subject: id, workspaceId, payload: { scope: memory.scope, title: memory.title } });
        return jsonResult(memory, { memory });
    });

    registerAppTool(server, "hook_list", {
        title: "List hooks",
        description: "List configured deterministic DevSpace lifecycle hooks. Sensitive arguments are redacted.",
        inputSchema: { workspaceId: z.string().optional() },
        outputSchema: { result: z.string(), hooks: z.array(z.unknown()) },
        ...toolMeta("read"),
        annotations: READ_ONLY_ANNOTATIONS,
    }, async ({ workspaceId }) => {
        requireFeature(config, "hooks", "Hooks");
        if (workspaceId)
            workspaces.getWorkspace(workspaceId);
        const hooks = hookManager.list();
        return jsonResult(hooks, { hooks });
    });

    registerAppTool(server, "hook_upsert", {
        title: "Save hook",
        description: "Create or update a deterministic lifecycle hook using an executable plus argv. Shell command strings are not accepted. Hooks require arbitrary-command permission and are fully audited.",
        inputSchema: {
            workspaceId: z.string(),
            id: z.string().optional(),
            name: z.string().max(120).optional(),
            event: z.enum([
                "workspace_open",
                "before_command",
                "after_command",
                "before_mutation",
                "after_mutation",
                "before_review",
                "after_review",
                "before_rollback",
                "after_rollback",
            ]),
            executable: z.string().min(1),
            args: z.array(z.string()).max(100).optional(),
            workingDirectory: z.string().optional(),
            timeoutMs: z.number().int().min(100).max(30_000).optional(),
            blocking: z.boolean().optional(),
            enabled: z.boolean().optional(),
        },
        outputSchema: { result: z.string(), hook: z.unknown() },
        ...toolMeta("shell"),
        annotations: WRITE_ANNOTATIONS,
    }, async ({ workspaceId, ...input }) => {
        requireFeature(config, "hooks", "Hooks");
        workspaces.getWorkspace(workspaceId);
        if (!config.permissions.allowArbitraryCommands)
            throw new Error("Hooks require arbitrary-command permission.");
        const hook = hookManager.upsert(input);
        return jsonResult(hook, { hook });
    });

    registerAppTool(server, "hook_delete", {
        title: "Delete hook",
        description: "Delete one configured lifecycle hook.",
        inputSchema: { workspaceId: z.string(), id: z.string() },
        outputSchema: { result: z.string(), hook: z.unknown() },
        ...toolMeta("shell"),
        annotations: WRITE_ANNOTATIONS,
    }, async ({ workspaceId, id }) => {
        requireFeature(config, "hooks", "Hooks");
        workspaces.getWorkspace(workspaceId);
        const hook = hookManager.delete(id);
        return jsonResult(hook, { hook });
    });

    registerAppTool(server, "hook_run", {
        title: "Run hook",
        description: "Run one configured hook explicitly for testing. The hook uses the saved executable and argv and is audited.",
        inputSchema: { workspaceId: z.string(), id: z.string() },
        outputSchema: { result: z.string(), hookResult: z.unknown() },
        ...toolMeta("shell"),
        annotations: COMPUTER_ANNOTATIONS,
    }, async ({ workspaceId, id }) => {
        requireFeature(config, "hooks", "Hooks");
        const workspace = workspaces.getWorkspace(workspaceId);
        await reviewCheckpoints.beforeMutation({ workspaceId, root: workspace.root, kind: "shell" });
        const hookResult = await hookManager.runById(id, { workspaceId, workspaceRoot: workspace.root, toolName: "hook_run", success: true });
        return jsonResult(hookResult, { hookResult });
    });

    registerAppTool(server, "session_changes", {
        title: "Session changes",
        description: "Show aggregate file and line changes since this persisted workspace session captured its first-mutation baseline. The session remains reviewable after the local UI, MCP connection, or DevSpace service closes.",
        inputSchema: { workspaceId: z.string() },
        outputSchema: { result: z.string(), sessionReview: z.unknown() },
        ...toolMeta("show_changes"),
        annotations: READ_ONLY_ANNOTATIONS,
    }, async ({ workspaceId }) => {
        requireFeature(config, "uiSessionReview", "UI session review");
        const workspace = workspaces.getWorkspace(workspaceId);
        if (hookManager.hasEvent("before_review") || hookManager.hasEvent("after_review")) {
            await reviewCheckpoints.beforeMutation({ workspaceId, root: workspace.root, kind: "shell" });
        }
        await hookManager.runEvent("before_review", { workspaceId, workspaceRoot: workspace.root, toolName: "session_changes" }, { strict: true });
        const sessionReview = await reviewCheckpoints.sessionReview({ workspaceId, root: workspace.root });
        await hookManager.runEvent("after_review", { workspaceId, workspaceRoot: workspace.root, toolName: "session_changes", success: true });
        const result = sessionReview.active
            ? `Workspace session changed ${sessionReview.summary.files} file(s) (+${sessionReview.summary.additions} -${sessionReview.summary.removals}).`
            : `Workspace session review inactive: ${sessionReview.reason}.`;
        return {
            content: [textBlock(result)],
            _meta: {
                tool: "session_changes",
                card: {
                    workspaceId,
                    summary: sessionReview.summary,
                    files: sessionReview.files,
                    sessionReview,
                    payload: { patch: sessionReview.patch ?? "" },
                },
            },
            structuredContent: { result, sessionReview },
        };
    });

    registerAppTool(server, "session_rollback", {
        title: "Rollback workspace session",
        description: "Restore the complete workspace tree to the persisted first-mutation baseline. Requires the exact confirmation token returned by session_changes/show_changes. The baseline is stored outside the project, works for Git and non-Git workspaces, preserves the project's own Git index, and creates a pre-rollback safety snapshot.",
        inputSchema: {
            workspaceId: z.string(),
            confirmation: z.string(),
            forcePartial: z.boolean().optional(),
        },
        outputSchema: { result: z.string(), rollback: z.unknown() },
        ...toolMeta("write"),
        annotations: WRITE_ANNOTATIONS,
    }, async ({ workspaceId, confirmation, forcePartial }) => {
        requireFeature(config, "uiSessionReview", "UI session review");
        const workspace = workspaces.getWorkspace(workspaceId);
        if (hookManager.hasEvent("before_rollback") || hookManager.hasEvent("after_rollback")) {
            await reviewCheckpoints.beforeMutation({ workspaceId, root: workspace.root, kind: "shell" });
        }
        await hookManager.runEvent("before_rollback", { workspaceId, workspaceRoot: workspace.root, toolName: "session_rollback" }, { strict: true });
        const rollback = await reviewCheckpoints.rollbackSession({
            workspaceId,
            root: workspace.root,
            confirmation,
            forcePartial,
        });
        await hookManager.runEvent("after_rollback", { workspaceId, workspaceRoot: workspace.root, toolName: "session_rollback", success: true });
        runtimeState.appendEvent({ kind: "review.session.rolled_back", subject: rollback.checkpointId, workspaceId, payload: rollback });
        return jsonResult(rollback, { rollback });
    });

    registerAppTool(server, "computer_snapshot", {
        title: "Capture desktop",
        description: "Capture the current Windows virtual desktop. Requires explicit Computer Use enablement, permission, and an active local Portable UI heartbeat.",
        inputSchema: { workspaceId: z.string() },
        outputSchema: { result: z.string(), screen: z.unknown() },
        ...toolMeta("runtime"),
        annotations: READ_ONLY_ANNOTATIONS,
    }, async ({ workspaceId }) => {
        const lease = computerUseGuard(config, uiLease);
        workspaces.getWorkspace(workspaceId);
        const captured = await captureDesktop({ leaseId: lease.leaseId });
        const data = captured.image.toString("base64");
        const result = `Captured Windows virtual desktop ${captured.metadata.width}x${captured.metadata.height}.`;
        runtimeState.appendEvent({ kind: "computer.snapshot", workspaceId, payload: captured.metadata });
        return {
            content: [textBlock(result), { type: "image", data, mimeType: "image/png" }],
            structuredContent: { result, screen: captured.metadata },
        };
    });

    registerAppTool(server, "computer_action", {
        title: "Use computer",
        description: "Perform one bounded Windows desktop action, or a sequence of up to 50 actions, and optionally return one final screenshot. Use steps to reduce round trips for predictable multi-step interactions. Actions are explicit and audited. Requires Computer Use enablement, permission, and an active local Portable UI heartbeat.",
        inputSchema: {
            workspaceId: z.string(),
            action: z.enum(["move", "click", "double_click", "right_click", "scroll", "keypress", "type_text"]).optional(),
            x: z.number().int().optional(),
            y: z.number().int().optional(),
            delta: z.number().int().min(-12_000).max(12_000).optional(),
            keys: z.array(z.string()).max(20).optional(),
            text: z.string().max(20_000).optional(),
            delayMs: z.number().int().min(0).max(3000).optional(),
            screenshotAfter: z.boolean().optional(),
            steps: z.array(z.object({
                action: z.enum(["move", "click", "double_click", "right_click", "scroll", "keypress", "type_text"]),
                x: z.number().int().optional(),
                y: z.number().int().optional(),
                delta: z.number().int().min(-12_000).max(12_000).optional(),
                keys: z.array(z.string()).max(20).optional(),
                text: z.string().max(20_000).optional(),
                delayMs: z.number().int().min(0).max(3000).optional(),
            })).min(1).max(50).optional(),
        },
        outputSchema: { result: z.string(), actionResult: z.unknown() },
        ...toolMeta("runtime"),
        annotations: COMPUTER_ANNOTATIONS,
    }, async ({ workspaceId, ...input }) => {
        const lease = computerUseGuard(config, uiLease);
        workspaces.getWorkspace(workspaceId);
        validateComputerAction(input);
        const payload = Array.isArray(input.steps)
            ? { action: "sequence", steps: input.steps, screenshotAfter: input.screenshotAfter === true }
            : { ...input, screenshotAfter: input.screenshotAfter === true };
        const actionResult = await performComputerAction(payload, { leaseId: lease.leaseId });
        const actionName = Array.isArray(input.steps) ? `sequence (${input.steps.length} steps)` : input.action;
        const result = `Computer Use action completed: ${actionName}.`;
        runtimeState.appendEvent({
            kind: "computer.action",
            subject: Array.isArray(input.steps) ? "sequence" : input.action,
            workspaceId,
            payload: {
                action: Array.isArray(input.steps) ? "sequence" : input.action,
                stepCount: input.steps?.length,
                x: input.x,
                y: input.y,
                delta: input.delta,
                keyCount: input.keys?.length,
                textLength: input.text?.length,
                screen: actionResult.metadata,
            },
        });
        const content = [textBlock(result)];
        if (actionResult.image) {
            content.push({ type: "image", data: actionResult.image.toString("base64"), mimeType: "image/png" });
        }
        return { content, structuredContent: { result, actionResult: actionResult.metadata } };
    });
}
