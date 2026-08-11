import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { resolveShellCommand, terminateProcessTree } from "./process-platform.js";
import { ProcessRegistryStore, processExists } from "./process-registry.js";

const DEFAULT_EXEC_YIELD_MS = 10_000;
const DEFAULT_INTERACTIVE_YIELD_MS = 250;
const DEFAULT_POLL_YIELD_MS = 5_000;
const MAX_COMMAND_YIELD_MS = 30_000;
const MAX_POLL_YIELD_MS = 110_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 10_000;
const DEFAULT_BUFFER_CHARACTERS = 512_000;
const COMPLETED_SESSION_TTL_MS = 5 * 60 * 1_000;
const MAX_LIVE_PROCESS_SESSIONS = 128;
const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;

function boundedInteger(value, fallback, maximum) {
    if (value === undefined)
        return fallback;
    if (!Number.isFinite(value) || value < 0) {
        throw new Error("Duration and output limits must be non-negative.");
    }
    return Math.min(Math.floor(value), maximum);
}

function terminalSize(value, fallback) {
    if (value === undefined)
        return fallback;
    if (!Number.isInteger(value) || value < 1 || value > 1_000) {
        throw new Error("Terminal dimensions must be integers between 1 and 1000.");
    }
    return value;
}

function processEnvironment(input) {
    const environment = {
        ...Object.fromEntries(Object.entries(process.env).filter((entry) => entry[1] !== undefined)),
        NO_COLOR: input?.tty ? "0" : "1",
        TERM: input?.tty ? "xterm-256color" : "dumb",
        PAGER: "cat",
        GIT_PAGER: "cat",
        GH_PAGER: "cat",
        CODEX_CI: "1",
        LANG: process.env.LANG ?? "C.UTF-8",
        LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
        ...(input?.workspaceId ? { DEVSPACE_WORKSPACE_ID: input.workspaceId } : {}),
        ...(input?.workspaceRoot ? { DEVSPACE_WORKSPACE_ROOT: input.workspaceRoot } : {}),
        ...(input?.processHandle ? { DEVSPACE_PROCESS_HANDLE: input.processHandle } : {}),
    };
    if (shouldUseHostPath(input) && process.env.DEVSPACE_HOST_PATH) {
        environment.PATH = process.env.DEVSPACE_HOST_PATH;
    }
    for (const [name, value] of Object.entries(input?.env ?? {})) {
        if (value === null || value === undefined)
            delete environment[name];
        else
            environment[name] = String(value);
    }
    return environment;
}

function shouldUseHostPath(input) {
    const executable = input?.argv?.[0]
        ? String(input.argv[0]).split(/[\\/]/).pop()?.toLowerCase()
        : undefined;
    if (executable && ["codex", "codex.cmd", "codex.exe"].includes(executable))
        return true;
    const command = String(input?.command ?? "").trim();
    return /^(?:call\s+)?(?:"[^"]*[\\/])?codex(?:\.cmd|\.exe)?(?:"|\s|$)/i.test(command);
}

function codePointLength(value) {
    return value.length;
}
function sliceCodePoints(value, start, end) {
    return value.slice(start, end);
}
function takeHead(value, count) {
    if (count <= 0)
        return "";
    return sliceCodePoints(value, 0, count);
}
function takeTail(value, count) {
    if (count <= 0)
        return "";
    return value.slice(Math.max(0, value.length - count));
}
function splitBudget(maxCharacters) {
    return {
        head: Math.ceil(maxCharacters / 2),
        tail: Math.floor(maxCharacters / 2),
    };
}
function formatHeadTail(head, tail, omittedCharacters) {
    if (omittedCharacters <= 0)
        return head + tail;
    return `${head}\n... output truncated (${omittedCharacters} characters omitted) ...\n${tail}`;
}

export class HeadTailBuffer {
    maxCharacters;
    head = "";
    tail = "";
    totalCharacters = 0;
    constructor(maxCharacters) {
        this.maxCharacters = maxCharacters;
        if (!Number.isInteger(maxCharacters) || maxCharacters < 1) {
            throw new Error("Head/tail buffer limit must be a positive integer.");
        }
    }
    append(output) {
        if (!output)
            return;
        const previousTotal = this.totalCharacters;
        this.totalCharacters += codePointLength(output);
        if (this.totalCharacters <= this.maxCharacters) {
            this.head += output;
            return;
        }
        const budget = splitBudget(this.maxCharacters);
        if (previousTotal <= this.maxCharacters) {
            const previousHead = this.head;
            this.head = previousHead.length >= budget.head
                ? takeHead(previousHead, budget.head)
                : takeHead(previousHead + output, budget.head);
            this.tail = output.length >= budget.tail
                ? takeTail(output, budget.tail)
                : takeTail(previousHead + output, budget.tail);
            return;
        }
        this.tail = output.length >= budget.tail
            ? takeTail(output, budget.tail)
            : takeTail(this.tail + output, budget.tail);
    }
    hasOutput() {
        return this.totalCharacters > 0;
    }
    drain(maxCharacters) {
        if (!Number.isInteger(maxCharacters) || maxCharacters < 1) {
            throw new Error("Output limit must be a positive integer.");
        }
        const omittedByBuffer = Math.max(0, this.totalCharacters - codePointLength(this.head) - codePointLength(this.tail));
        const retained = formatHeadTail(this.head, this.tail, omittedByBuffer);
        const output = truncateOutput(retained, maxCharacters);
        const truncated = omittedByBuffer > 0 || output.truncated;
        this.head = "";
        this.tail = "";
        this.totalCharacters = 0;
        return { output: output.output, truncated };
    }
}

function truncateOutput(output, maxCharacters) {
    const outputCharacters = codePointLength(output);
    if (outputCharacters <= maxCharacters)
        return { output, truncated: false };
    const marker = "\n... output truncated ...\n";
    const markerCharacters = codePointLength(marker);
    const available = Math.max(0, maxCharacters - markerCharacters);
    const budget = splitBudget(available);
    return {
        output: takeHead(output, budget.head) + marker + takeTail(output, budget.tail),
        truncated: true,
    };
}

function validateExecutionInput(input) {
    const hasCommand = typeof input.command === "string" && input.command.trim().length > 0;
    const hasArgv = Array.isArray(input.argv) && input.argv.length > 0 && input.argv.every((value) => typeof value === "string");
    if (hasCommand === hasArgv) {
        throw new Error("Provide exactly one of cmd or argv.");
    }
    return { hasCommand, hasArgv };
}

function executionSummary(input) {
    return input.argv ? { argv: [...input.argv] } : { cmd: input.command };
}

export class ProcessSessionManager {
    sessions = new Map();
    handles = new Map();
    maxBufferCharacters;
    completedSessionTtlMs;
    nextSessionId = 1;
    registry;
    recoveredProcesses = [];
    runtimeState;
    constructor(options = {}) {
        this.maxBufferCharacters = options.maxBufferCharacters ?? DEFAULT_BUFFER_CHARACTERS;
        this.completedSessionTtlMs = options.completedSessionTtlMs ?? COMPLETED_SESSION_TTL_MS;
        if (!options.stateDir)
            throw new Error("ProcessSessionManager requires stateDir for the persistent process registry.");
        this.registry = new ProcessRegistryStore(options.stateDir);
        this.recoveredProcesses = this.registry.reconcilePreviousRuntime();
        this.runtimeState = options.runtimeState;
        for (const process of this.recoveredProcesses) {
            this.runtimeState?.appendEvent({
                kind: "process.recovered",
                subject: process.processHandle,
                workspaceId: process.workspaceId,
                payload: { pid: process.pid, status: process.status, reattachable: false },
            });
        }
    }
    async start(input) {
        validateExecutionInput(input);
        if (this.liveCount() >= MAX_LIVE_PROCESS_SESSIONS) {
            throw new Error(`DevSpace refuses to retain more than ${MAX_LIVE_PROCESS_SESSIONS} live process sessions. Reuse or stop an existing process before starting another.`);
        }
        const session = this.createSession(input);
        const existing = this.handles.get(session.processHandle);
        if (existing?.running) {
            throw new Error(`Process handle is already active: ${session.processHandle}`);
        }
        this.sessions.set(session.id, session);
        this.handles.set(session.processHandle, session);
        try {
            if (input.tty)
                await this.startPty(session, input);
            else
                this.startPipe(session, input);
            this.registry.upsertRunning({
                processHandle: session.processHandle,
                workspaceId: session.workspaceId,
                workspaceRoot: input.workspaceRoot,
                sessionId: session.id,
                ...executionSummary(input),
                cwd: input.cwd,
                env: input.env,
                tty: Boolean(input.tty),
                persistent: Boolean(input.persistent),
                pid: session.pid,
                startedAt: new Date(session.startedAt).toISOString(),
            });
            if (!session.running) {
                this.registry.markExited(session.processHandle, {
                    exitCode: session.exitCode,
                    signal: session.signal,
                });
            }
            this.runtimeState?.appendEvent({
                kind: "process.started",
                subject: session.processHandle,
                workspaceId: session.workspaceId,
                payload: { pid: session.pid, tty: Boolean(input.tty), persistent: Boolean(input.persistent) },
            });
        }
        catch (error) {
            this.sessions.delete(session.id);
            this.handles.delete(session.processHandle);
            throw error;
        }
        const yieldTimeMs = boundedInteger(input.yieldTimeMs, DEFAULT_EXEC_YIELD_MS, MAX_COMMAND_YIELD_MS);
        await this.waitForExit(session, yieldTimeMs);
        const snapshot = this.consume(session, input.maxOutputTokens);
        if (!session.running)
            this.scheduleRemoval(session);
        return snapshot;
    }
    async write(input) {
        const session = this.resolveOwnedSession(input);
        const chars = input.chars ?? "";
        const interactionRequested = chars.length > 0 || input.columns !== undefined || input.rows !== undefined;
        if (input.columns !== undefined || input.rows !== undefined) {
            session.columns = terminalSize(input.columns, session.columns);
            session.rows = terminalSize(input.rows, session.rows);
            if (!session.process?.resize) {
                throw new Error(`Process ${session.processHandle} is not a PTY and cannot be resized.`);
            }
            session.process.resize(session.columns, session.rows);
        }
        const interruptRequested = chars.includes("\u0003") && session.running;
        if (interruptRequested)
            session.process?.kill("SIGINT");
        const writableChars = chars.replaceAll("\u0003", "");
        if (writableChars && session.running)
            session.process?.write(writableChars);
        if ((interactionRequested || !session.buffer.hasOutput()) && session.running) {
            const fallback = interactionRequested ? DEFAULT_INTERACTIVE_YIELD_MS : DEFAULT_POLL_YIELD_MS;
            const maximum = interactionRequested ? MAX_COMMAND_YIELD_MS : MAX_POLL_YIELD_MS;
            const yieldTimeMs = boundedInteger(input.yieldTimeMs, fallback, maximum);
            await this.waitForExit(session, yieldTimeMs);
        }
        const snapshot = this.consume(session, input.maxOutputTokens);
        if (!session.running)
            this.scheduleRemoval(session);
        return snapshot;
    }
    async attach(input) {
        const session = this.handles.get(input.processHandle);
        if (!session) {
            const record = this.registry.get(input.processHandle);
            if (!record)
                throw new Error(`Unknown process handle: ${input.processHandle}`);
            if (record.workspaceId !== input.workspaceId)
                throw new Error(`Process ${input.processHandle} does not belong to workspace ${input.workspaceId}.`);
            return {
                processHandle: record.processHandle,
                sessionId: record.sessionId,
                output: "",
                outputTruncated: false,
                running: record.running,
                exitCode: record.exitCode,
                signal: record.signal,
                wallTimeMs: Math.max(0, Date.now() - Date.parse(record.startedAt)),
                pid: record.pid,
                reattachable: false,
                status: record.status,
            };
        }
        if (session.workspaceId !== input.workspaceId)
            throw new Error(`Process ${input.processHandle} does not belong to workspace ${input.workspaceId}.`);
        if (session.running && !session.buffer.hasOutput()) {
            const yieldTimeMs = boundedInteger(input.yieldTimeMs, DEFAULT_POLL_YIELD_MS, MAX_POLL_YIELD_MS);
            await this.waitForExit(session, yieldTimeMs);
        }
        return { ...this.consume(session, input.maxOutputTokens), reattachable: true, status: session.running ? "running" : "exited" };
    }
    list(input = {}) {
        const records = this.registry.list(input);
        return records.map((record) => {
            const live = this.handles.get(record.processHandle);
            return live
                ? {
                    ...record,
                    sessionId: live.id,
                    pid: live.pid,
                    running: live.running,
                    status: live.running ? "running" : "exited",
                    reattachable: true,
                }
                : { ...record, reattachable: false };
        });
    }
    terminate(workspaceId, sessionId) {
        const session = this.getOwnedSession(workspaceId, sessionId);
        if (session.running)
            session.process?.kill("SIGTERM");
    }
    killByHandle(workspaceId, processHandle, signal = "SIGTERM") {
        const session = this.handles.get(processHandle);
        if (!session) {
            const record = this.registry.get(processHandle);
            if (!record)
                throw new Error(`Unknown process handle: ${processHandle}`);
            if (record.workspaceId !== workspaceId)
                throw new Error(`Process ${processHandle} does not belong to workspace ${workspaceId}.`);
            if (!record.running || !processExists(record.pid))
                throw new Error(`Process ${processHandle} is not running.`);
            process.kill(record.pid, signal);
            this.registry.markStatus(processHandle, "stopping");
            this.runtimeState?.appendEvent({
                kind: "process.kill.requested",
                subject: processHandle,
                workspaceId,
                payload: { pid: record.pid, signal },
            });
            return { ...record, status: "stopping", running: true, reattachable: false };
        }
        if (session.workspaceId !== workspaceId)
            throw new Error(`Process ${processHandle} does not belong to workspace ${workspaceId}.`);
        if (session.running)
            session.process?.kill(signal);
        return this.describeSession(session);
    }
    registrySummary() {
        return this.registry.summary();
    }
    liveCount() {
        return [...this.sessions.values()].filter((session) => session.running).length;
    }
    shutdown(options = {}) {
        for (const session of this.sessions.values()) {
            if (session.cleanupTimer)
                clearTimeout(session.cleanupTimer);
            if (!session.running)
                continue;
            if (options.preservePersistent && session.persistent && session.process?.detach) {
                session.running = false;
                session.resolveExit();
                session.process.detach();
                this.registry.markStatus(session.processHandle, "detached-running");
                this.runtimeState?.appendEvent({
                    kind: "process.detached",
                    subject: session.processHandle,
                    workspaceId: session.workspaceId,
                    payload: { pid: session.pid },
                });
                continue;
            }
            session.process?.kill("SIGTERM");
        }
        this.sessions.clear();
        this.handles.clear();
        this.registry.close();
    }
    async waitForExit(session, yieldTimeMs) {
        let timer;
        try {
            await Promise.race([
                session.exitPromise,
                new Promise((resolve) => {
                    timer = setTimeout(resolve, yieldTimeMs);
                }),
            ]);
        }
        finally {
            if (timer)
                clearTimeout(timer);
        }
    }
    createSession(input) {
        let resolveExit = () => undefined;
        const exitPromise = new Promise((resolve) => {
            resolveExit = resolve;
        });
        const processHandle = input.processHandle?.trim() || `proc_${randomUUID()}`;
        if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(processHandle)) {
            throw new Error("processHandle must be 1-128 characters using letters, numbers, dot, underscore, colon, or hyphen.");
        }
        return {
            id: this.nextSessionId++,
            processHandle,
            workspaceId: input.workspaceId,
            startedAt: Date.now(),
            columns: terminalSize(input.columns, DEFAULT_COLUMNS),
            rows: terminalSize(input.rows, DEFAULT_ROWS),
            buffer: new HeadTailBuffer(this.maxBufferCharacters),
            persistent: Boolean(input.persistent),
            running: true,
            exitPromise,
            resolveExit,
        };
    }
    startPipe(session, input) {
        const environment = processEnvironment({
            workspaceId: input.workspaceId,
            workspaceRoot: input.workspaceRoot,
            processHandle: session.processHandle,
            tty: false,
            env: input.env,
            argv: input.argv,
            command: input.command,
        });
        const detached = Boolean(input.persistent) || process.platform !== "win32";
        let child;
        if (input.argv) {
            child = spawn(input.argv[0], input.argv.slice(1), {
                cwd: input.cwd,
                env: environment,
                stdio: "pipe",
                windowsHide: true,
                detached,
                shell: false,
            });
        }
        else {
            const shell = resolveShellCommand(input.command);
            child = spawn(input.command, {
                cwd: input.cwd,
                env: environment,
                stdio: "pipe",
                windowsHide: true,
                detached,
                shell: shell.executable,
            });
        }
        session.pid = child.pid;
        session.process = {
            write: (data) => child.stdin.write(data),
            kill: (signal = "SIGTERM") => terminateProcessTree(child, signal, detached),
            detach: input.persistent
                ? () => {
                    try {
                        child.stdin.end();
                    }
                    catch { }
                    try {
                        child.stdout.destroy();
                        child.stderr.destroy();
                    }
                    catch { }
                    child.unref();
                }
                : undefined,
        };
        child.stdout.on("data", (data) => this.append(session, data.toString("utf8")));
        child.stderr.on("data", (data) => this.append(session, data.toString("utf8")));
        child.on("error", (error) => this.append(session, `${error.message}\n`));
        child.on("close", (code, signal) => this.finish(session, code ?? undefined, signal ?? undefined));
    }
    async startPty(session, input) {
        let nodePty;
        try {
            nodePty = await import("node-pty");
        }
        catch {
            throw new Error("PTY support requires the optional node-pty dependency.");
        }
        const execution = input.argv
            ? { executable: input.argv[0], args: input.argv.slice(1) }
            : resolveShellCommand(input.command);
        const pty = nodePty.spawn(execution.executable, execution.args, {
            cwd: input.cwd,
            env: processEnvironment({
                workspaceId: input.workspaceId,
                workspaceRoot: input.workspaceRoot,
                processHandle: session.processHandle,
                tty: true,
                env: input.env,
                argv: input.argv,
                command: input.command,
            }),
            name: "xterm-256color",
            cols: session.columns,
            rows: session.rows,
        });
        session.pid = pty.pid;
        session.process = {
            write: (data) => pty.write(data),
            kill: (signal) => pty.kill(signal),
            resize: (columns, rows) => pty.resize(columns, rows),
        };
        pty.onData((data) => this.append(session, data));
        pty.onExit(({ exitCode, signal }) => {
            this.finish(session, exitCode, signal === 0 ? undefined : String(signal));
        });
    }
    finish(session, exitCode, signal) {
        if (!session.running)
            return;
        session.running = false;
        session.exitCode = exitCode;
        session.signal = signal;
        session.resolveExit();
        this.registry.markExited(session.processHandle, { exitCode, signal });
        this.runtimeState?.appendEvent({
            kind: "process.exited",
            subject: session.processHandle,
            workspaceId: session.workspaceId,
            payload: { pid: session.pid, exitCode, signal },
        });
        this.scheduleRemoval(session);
    }
    append(session, output) {
        session.buffer.append(output);
    }
    consume(session, maxOutputTokens) {
        const limit = boundedInteger(maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS, 100_000);
        const maxCharacters = Math.max(256, limit * 4);
        const buffered = session.buffer.drain(maxCharacters);
        return {
            processHandle: session.processHandle,
            sessionId: session.running ? session.id : session.id,
            output: buffered.output,
            outputTruncated: buffered.truncated,
            running: session.running,
            exitCode: session.exitCode,
            signal: session.signal,
            wallTimeMs: Date.now() - session.startedAt,
            pid: session.pid,
        };
    }
    describeSession(session) {
        return {
            processHandle: session.processHandle,
            sessionId: session.id,
            workspaceId: session.workspaceId,
            pid: session.pid,
            running: session.running,
            exitCode: session.exitCode,
            signal: session.signal,
            persistent: session.persistent,
            startedAt: new Date(session.startedAt).toISOString(),
            reattachable: true,
        };
    }
    resolveOwnedSession(input) {
        if (input.processHandle) {
            const session = this.handles.get(input.processHandle);
            if (!session)
                throw new Error(`Unknown process handle: ${input.processHandle}`);
            if (session.workspaceId !== input.workspaceId)
                throw new Error(`Process ${input.processHandle} does not belong to workspace ${input.workspaceId}.`);
            return session;
        }
        if (input.sessionId === undefined)
            throw new Error("Provide sessionId or processHandle.");
        return this.getOwnedSession(input.workspaceId, input.sessionId);
    }
    getOwnedSession(workspaceId, sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session)
            throw new Error(`Unknown process session: ${sessionId}`);
        if (session.workspaceId !== workspaceId)
            throw new Error(`Process session ${sessionId} does not belong to workspace ${workspaceId}.`);
        return session;
    }
    scheduleRemoval(session) {
        if (session.cleanupTimer)
            return;
        session.cleanupTimer = setTimeout(() => this.removeSession(session.id), this.completedSessionTtlMs);
        session.cleanupTimer.unref();
    }
    removeSession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (session?.cleanupTimer)
            clearTimeout(session.cleanupTimer);
        if (session)
            this.handles.delete(session.processHandle);
        this.sessions.delete(sessionId);
    }
}
