import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { redactText, redactValue } from "./redaction.js";

const execFileAsync = promisify(execFile);
export const HOOK_EVENTS = [
    "workspace_open",
    "before_command",
    "after_command",
    "before_mutation",
    "after_mutation",
    "before_review",
    "after_review",
    "before_rollback",
    "after_rollback",
];

function readHooks(file) {
    if (!existsSync(file))
        return [];
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(parsed.hooks) ? parsed.hooks : [];
}

function writeHooks(file, hooks) {
    mkdirSync(dirname(file), { recursive: true });
    const temporary = `${file}.tmp-${process.pid}`;
    writeFileSync(temporary, JSON.stringify({ formatVersion: 1, hooks }, null, 2) + "\n", { mode: 0o600 });
    renameSync(temporary, file);
}

function renderTemplate(value, context) {
    return String(value).replace(/\$\{(workspaceRoot|toolName|event|success|workspaceId)\}/g, (_match, key) => String(context[key] ?? ""));
}

function normalizeHook(input, prior = {}) {
    const event = String(input.event ?? prior.event ?? "");
    if (!HOOK_EVENTS.includes(event))
        throw new Error(`Unsupported hook event: ${event}`);
    const executable = String(input.executable ?? prior.executable ?? "").trim();
    if (!executable)
        throw new Error("Hook executable cannot be empty.");
    const args = (input.args ?? prior.args ?? []).map((item) => String(item));
    if (args.length > 100)
        throw new Error("Hook args exceed 100 entries.");
    return {
        id: String(input.id ?? prior.id ?? randomUUID()),
        name: String(input.name ?? prior.name ?? event).trim().slice(0, 120),
        event,
        executable,
        args,
        workingDirectory: input.workingDirectory ?? prior.workingDirectory ?? ".",
        timeoutMs: Math.max(100, Math.min(Number(input.timeoutMs ?? prior.timeoutMs ?? 10_000), 30_000)),
        blocking: Boolean(input.blocking ?? prior.blocking),
        enabled: input.enabled === undefined ? prior.enabled !== false : Boolean(input.enabled),
        updatedAt: new Date().toISOString(),
        createdAt: prior.createdAt ?? new Date().toISOString(),
    };
}

export class HookManager {
    config;
    file;
    runtimeState;
    workspaces;
    constructor(config, runtimeState, workspaces) {
        this.config = config;
        this.runtimeState = runtimeState;
        this.workspaces = workspaces;
        this.file = join(config.stateDir, "hooks.json");
    }
    list() {
        return readHooks(this.file).map((hook) => redactValue(hook));
    }
    hasEvent(event) {
        return Boolean(this.config.features?.hooks)
            && readHooks(this.file).some((hook) => hook.enabled !== false && hook.event === event);
    }
    upsert(input) {
        const hooks = readHooks(this.file);
        const index = input.id ? hooks.findIndex((hook) => hook.id === input.id) : -1;
        const hook = normalizeHook(input, index >= 0 ? hooks[index] : {});
        if (index >= 0)
            hooks[index] = hook;
        else
            hooks.push(hook);
        writeHooks(this.file, hooks);
        this.runtimeState.appendEvent({ kind: "hook.saved", subject: hook.id, payload: hook });
        return redactValue(hook);
    }
    delete(id) {
        const hooks = readHooks(this.file);
        const index = hooks.findIndex((hook) => hook.id === String(id));
        if (index < 0)
            throw new Error(`Unknown hook: ${id}`);
        const [removed] = hooks.splice(index, 1);
        writeHooks(this.file, hooks);
        this.runtimeState.appendEvent({ kind: "hook.deleted", subject: removed.id, payload: removed });
        return redactValue(removed);
    }
    async runEvent(event, context, options = {}) {
        if (!this.config.features?.hooks)
            return [];
        const hooks = readHooks(this.file).filter((hook) => hook.enabled !== false && hook.event === event);
        const results = [];
        for (const hook of hooks) {
            const result = await this.runHook(hook, { ...context, event });
            results.push(result);
            if (!result.success && hook.blocking && options.strict) {
                throw new Error(`Blocking hook ${hook.name || hook.id} failed: ${result.error ?? `exit ${result.exitCode}`}`);
            }
        }
        return results;
    }
    async runById(id, context) {
        const hook = readHooks(this.file).find((item) => item.id === String(id));
        if (!hook)
            throw new Error(`Unknown hook: ${id}`);
        return this.runHook(hook, { ...context, event: hook.event });
    }
    async runHook(hook, context) {
        if (!this.config.permissions.allowArbitraryCommands)
            throw new Error("Hooks require the full-access profile or custom arbitrary-command permission.");
        const workspace = context.workspaceId ? this.workspaces.getWorkspace(context.workspaceId) : undefined;
        const workspaceRoot = workspace?.root ?? context.workspaceRoot;
        const templateContext = {
            workspaceRoot,
            workspaceId: context.workspaceId,
            toolName: context.toolName,
            event: context.event,
            success: context.success,
        };
        const configuredWorkingDirectory = renderTemplate(hook.workingDirectory ?? ".", templateContext);
        let cwd = workspaceRoot ?? process.cwd();
        if (configuredWorkingDirectory && configuredWorkingDirectory !== ".") {
            cwd = workspace
                ? this.workspaces.resolveWorkingDirectory(workspace, configuredWorkingDirectory)
                : isAbsolute(configuredWorkingDirectory)
                    ? resolve(configuredWorkingDirectory)
                    : resolve(cwd, configuredWorkingDirectory);
        }
        const executable = renderTemplate(hook.executable, templateContext);
        const args = (hook.args ?? []).map((arg) => renderTemplate(arg, templateContext));
        const environment = {
            ...process.env,
            DEVSPACE_HOOK_EVENT: String(context.event ?? ""),
            DEVSPACE_HOOK_TOOL: String(context.toolName ?? ""),
            DEVSPACE_HOOK_WORKSPACE_ID: String(context.workspaceId ?? ""),
            DEVSPACE_HOOK_WORKSPACE_ROOT: String(workspaceRoot ?? ""),
            DEVSPACE_HOOK_SUCCESS: context.success === undefined ? "" : String(Boolean(context.success)),
        };
        const startedAt = performance.now();
        try {
            const { stdout, stderr } = await execFileAsync(executable, args, {
                cwd,
                env: environment,
                timeout: hook.timeoutMs,
                maxBuffer: 1024 * 1024,
                windowsHide: true,
            });
            const result = {
                hookId: hook.id,
                name: hook.name,
                event: context.event,
                success: true,
                exitCode: 0,
                durationMs: Math.round(performance.now() - startedAt),
                stdout: redactText(String(stdout ?? "")).slice(-16_000),
                stderr: redactText(String(stderr ?? "")).slice(-16_000),
            };
            this.runtimeState.appendEvent({ kind: "hook.completed", subject: hook.id, workspaceId: context.workspaceId, payload: result });
            return result;
        }
        catch (error) {
            const result = {
                hookId: hook.id,
                name: hook.name,
                event: context.event,
                success: false,
                exitCode: Number.isInteger(error?.code) ? error.code : undefined,
                durationMs: Math.round(performance.now() - startedAt),
                error: redactText(error instanceof Error ? error.message : String(error)),
                stdout: redactText(String(error?.stdout ?? "")).slice(-16_000),
                stderr: redactText(String(error?.stderr ?? "")).slice(-16_000),
            };
            this.runtimeState.appendEvent({ kind: "hook.failed", subject: hook.id, workspaceId: context.workspaceId, payload: result });
            return result;
        }
    }
}

