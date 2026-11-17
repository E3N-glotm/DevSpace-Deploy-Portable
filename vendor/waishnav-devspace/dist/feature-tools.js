import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import * as z from "zod/v4";
import { captureDesktop, performComputerAction } from "./computer-use.js";
import { useBrowser } from "./computer-browser.js";

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
const SCREEN_REGION = z.object({x:z.number().int(),y:z.number().int(),width:z.number().int().positive(),height:z.number().int().positive()});
function screenshotText(captured) {
    const m=captured.metadata;
    if (!captured.image) return ` Screenshot unavailable: ${m.screenshotError??'no image'}. ${m.recovery??''}`;
    const settle=m.screenshotSettled===false?" Desktop was still changing; inspect the current state before another coordinate action.":"";
    return ` Image ${m.imageWidth}x${m.imageHeight}. Use snapshotId ${m.snapshotId} with image pixels or normalized coordinates, and DevSpace will convert the point.${settle}`;
}

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
    // The Portable Computer Use toggle is mutable while the MCP server stays
    // running. The server's config object is a startup snapshot, so the active
    // UI lease is the authoritative live kill-switch. Check it first to fence
    // stale server config immediately after the owner disables Computer Use.
    return uiLease.requireComputerUseActive();
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
        && (!Number.isFinite(input.x) || !Number.isFinite(input.y))) {
        throw new Error(`${input.action} requires x and y coordinates.`);
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
        appToolMeta,
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
        // session_changes is a structured read API used by rollback/review
        // workflows. Keep it headless in the default `changes` mode; only the
        // explicit show_changes tool owns the consolidated review App card.
        ...appToolMeta("review"),
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
        ...appToolMeta("write"),
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

    registerAppTool(server, "session_restore_safety", {
        title: "Restore rollback safety snapshot",
        description: "Restore a pre-rollback safety snapshot created by session_rollback. Works for local and active Linux-agent workspaces and requires exact confirmation RESTORE <snapshotId>.",
        inputSchema: {
            workspaceId: z.string(),
            snapshotId: z.string(),
            confirmation: z.string(),
        },
        outputSchema: { result: z.string(), restore: z.unknown() },
        ...toolMeta("write"),
        annotations: WRITE_ANNOTATIONS,
    }, async ({ workspaceId, snapshotId, confirmation }) => {
        requireFeature(config, "uiSessionReview", "UI session review");
        const workspace = workspaces.getWorkspace(workspaceId);
        await hookManager.runEvent("before_rollback", { workspaceId, workspaceRoot: workspace.root, toolName: "session_restore_safety" }, { strict: true });
        const restore = await reviewCheckpoints.restoreSafetySnapshot({
            workspaceId,
            root: workspace.root,
            snapshotId,
            confirmation,
        });
        await hookManager.runEvent("after_rollback", { workspaceId, workspaceRoot: workspace.root, toolName: "session_restore_safety", success: true });
        runtimeState.appendEvent({ kind: "review.safety.restored", subject: snapshotId, workspaceId, payload: restore });
        return jsonResult(restore, { restore });
    });

    registerAppTool(server, "computer_browser", {
        title:"Inspect a local browser",
        description:"Prefer this tool to screenshots or clipboard clicks for browser work. List local Chrome/Edge tabs, read rendered DOM text and labeled controls with an optional CSS selector, get selected text, or reload one tab and check its ready state. Requires the Computer Use permission, a live UI lease, and the user's enabled browser debugging connection. If unavailable, use keypress F5 to refresh the focused browser.",
        inputSchema:{
            workspaceId:z.string(),
            operation:z.enum(["tabs","read","selection","reload"]),
            tabId:z.string().max(250).optional(),
            browser:z.enum(["chrome","edge"]).optional(),
            selector:z.string().max(600).optional(),
            offset:z.number().int().min(0).optional(),
            limit:z.number().int().min(1).max(40000).optional(),
        },
        outputSchema:{result:z.string(),browser:z.unknown()},
        ...toolMeta("runtime"),
        annotations:COMPUTER_ANNOTATIONS,
    },async({workspaceId,...input})=>{
        const lease=computerUseGuard(config,uiLease);
        workspaces.getWorkspace(workspaceId);
        const browser=await useBrowser(input,()=>{
            if(computerUseGuard(config,uiLease).leaseId!==lease.leaseId)
                throw Error("The Computer Use lease changed.");
        });
        runtimeState.appendEvent({kind:"computer.browser",workspaceId,payload:{operation:input.operation,tabId:input.tabId}});
        return jsonResult(browser,{browser});
    });

    registerAppTool(server, "computer_snapshot", {
        title: "Capture desktop",
        description: "Capture the current Windows virtual desktop or a region in absolute desktop coordinates. Large images are automatically encoded within the MCP transport budget. Use region for fine text instead of waiting or repeating oversized captures. Requires explicit Computer Use enablement, permission, and an active local Portable UI heartbeat.",
        inputSchema: { workspaceId: z.string(), region: SCREEN_REGION.optional(), settleMs:z.number().int().min(0).max(5000).optional() },
        outputSchema: { result: z.string(), screen: z.unknown() },
        ...toolMeta("runtime"),
        annotations: READ_ONLY_ANNOTATIONS,
    }, async ({ workspaceId, region, settleMs }) => {
        const lease = computerUseGuard(config, uiLease);
        workspaces.getWorkspace(workspaceId);
        const captured = await captureDesktop({ leaseId: lease.leaseId, workspaceId, region, settleMs });
        const result = `Captured Windows virtual desktop ${captured.metadata.width}x${captured.metadata.height}.`+screenshotText(captured);
        runtimeState.appendEvent({ kind: "computer.snapshot", workspaceId, payload: captured.metadata });
        return {
            content: [textBlock(result), ...(captured.image ? [{ type: "image", data: captured.image.toString("base64"), mimeType: captured.mimeType }] : [])],
            structuredContent: { result, screen: captured.metadata },
        };
    });

    registerAppTool(server, "computer_action", {
        title: "Use computer",
        description: "Perform a Windows desktop action or predictable steps. For a focused browser use keypress with F5 to reload, Ctrl+L for the address bar, or Ctrl+C for an existing selection. Prefer computer_browser for reading web pages. For pixels in an observation pass its snapshotId and use image coordinates, or use coordinateSpace=normalized to pass ratios from 0 to 1. Without a snapshotId, x/y are absolute desktop pixels. screenshotAfter waits briefly for rendering after input; settleMs overrides the minimum settling time. Requires Computer Use permission and a live local UI.",
        inputSchema: {
            workspaceId: z.string(),
            action: z.enum(["move", "click", "double_click", "right_click", "scroll", "keypress", "type_text"]).optional(),
            x: z.number().optional(),
            y: z.number().optional(),
            snapshotId: z.string().uuid().optional(),
            coordinateSpace:z.enum(["desktop","image","normalized"]).optional(),
            delta: z.number().int().min(-12_000).max(12_000).optional(),
            keys: z.array(z.string()).max(20).optional(),
            text: z.string().max(20_000).optional(),
            delayMs: z.number().int().min(0).max(3000).optional(),
            screenshotAfter: z.boolean().optional(),
            settleMs: z.number().int().min(0).max(5000).optional(),
            region: SCREEN_REGION.optional(),
            steps: z.array(z.object({
                action: z.enum(["move", "click", "double_click", "right_click", "scroll", "keypress", "type_text"]),
                x: z.number().optional(),
                y: z.number().optional(),
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
        if((input.coordinateSpace??(input.snapshotId?"image":"desktop"))==="desktop"){
            for(const point of input.steps??[input])
                if([point.x,point.y].some(v=>v!==undefined&&!Number.isInteger(v)))
                    throw Error("Desktop coordinates require integer physical pixels.");
        }
        const payload = Array.isArray(input.steps)
            ? { action: "sequence", steps: input.steps, snapshotId:input.snapshotId,coordinateSpace:input.coordinateSpace,settleMs:input.settleMs,screenshotAfter: input.screenshotAfter === true }
            : { ...input, screenshotAfter: input.screenshotAfter === true };
        const actionResult = await performComputerAction(payload, { leaseId: lease.leaseId, workspaceId, region: input.region });
        const actionName = Array.isArray(input.steps) ? `sequence (${input.steps.length} steps)` : input.action;
        const result = `Computer Use action completed: ${actionName}.`+(input.screenshotAfter===true?screenshotText(actionResult):'');
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
            content.push({ type: "image", data: actionResult.image.toString("base64"), mimeType: actionResult.mimeType });
        }
        return { content, structuredContent: { result, actionResult: actionResult.metadata } };
    });
}
