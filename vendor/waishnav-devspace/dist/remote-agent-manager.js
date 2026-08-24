import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { WebSocketServer, WebSocket } from "ws";
import { createRemoteAgentStore } from "./remote-agent-store.js";

export const DEVSPACE_REMOTE_AGENT_PROTOCOL = 1;
export const DEVSPACE_LINUX_AGENT_VERSION = "1.1.43";
const AGENT_PATH = "/agent/v1/connect";
const MAX_RPC_PAYLOAD_BYTES = 8 * 1024 * 1024;
const DEFAULT_RPC_TIMEOUT_MS = 30_000;
const DEFAULT_RECONNECT_GRACE_MS = 15_000;
const TRANSFER_CHUNK_BYTES = 512 * 1024;

function sha256Buffer(value) {
    return createHash("sha256").update(value).digest("hex");
}
function assetPath(name) {
    return fileURLToPath(new URL(`./linux-agent/${name}`, import.meta.url));
}

export function linuxAgentAsset(name) {
    const path = assetPath(name);
    const bytes = readFileSync(path);
    return { path, bytes, sha256: sha256Buffer(bytes) };
}

function parseMessage(data) {
    const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
    if (Buffer.byteLength(text, "utf8") > MAX_RPC_PAYLOAD_BYTES)
        throw new Error("Remote agent message exceeded the bounded RPC payload size.");
    return JSON.parse(text);
}

function encodeContent(buffer) {
    if (!Buffer.isBuffer(buffer))
        buffer = Buffer.from(buffer);
    if (buffer.length < 4096)
        return { encoding: "base64", data: buffer.toString("base64") };
    const compressed = gzipSync(buffer, { level: 6 });
    if (compressed.length + 128 < buffer.length)
        return { encoding: "gzip-base64", data: compressed.toString("base64") };
    return { encoding: "base64", data: buffer.toString("base64") };
}

export function decodeAgentContent(value) {
    if (!value)
        return Buffer.alloc(0);
    const data = Buffer.from(String(value.data ?? ""), "base64");
    if (value.encoding === "gzip-base64")
        return gunzipSync(data);
    if (value.encoding === "base64")
        return data;
    throw new Error(`Unsupported remote content encoding: ${value.encoding}`);
}

function normalizeRemotePath(value) {
    let text = String(value ?? "").replace(/\\/g, "/");
    if (!text.startsWith("/"))
        throw new Error(`Remote path must be absolute: ${value}`);
    const parts = [];
    for (const segment of text.split("/")) {
        if (!segment || segment === ".")
            continue;
        if (segment === "..") {
            if (parts.length === 0)
                throw new Error(`Remote path escapes root: ${value}`);
            parts.pop();
        }
        else {
            parts.push(segment);
        }
    }
    return `/${parts.join("/")}`;
}

export class RemoteAgentManager {
    config;
    runtimeState;
    store;
    connections = new Map();
    connectionWaiters = new Map();
    wss;
    httpServer;
    upgradeHandler;
    heartbeatTimer;
    constructor(config, runtimeState) {
        this.config = config;
        this.runtimeState = runtimeState;
        this.store = createRemoteAgentStore(config.stateDir);
        this.store.pruneEnrollments();
        this.heartbeatTimer = setInterval(() => this.heartbeat(), 15_000);
        this.heartbeatTimer.unref?.();
    }
    attachHttpServer(httpServer) {
        if (this.httpServer === httpServer)
            return;
        if (this.httpServer)
            throw new Error("Remote Agent Manager is already attached to an HTTP server.");
        this.httpServer = httpServer;
        this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_RPC_PAYLOAD_BYTES });
        this.upgradeHandler = (request, socket, head) => {
            let pathname;
            try {
                pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
            }
            catch {
                socket.destroy();
                return;
            }
            if (pathname !== AGENT_PATH)
                return;
            if (!this.agentHostAllowed(request)) {
                socket.destroy();
                return;
            }
            this.wss.handleUpgrade(request, socket, head, (ws) => this.acceptSocket(ws, request));
        };
        httpServer.on("upgrade", this.upgradeHandler);
    }
    agentHostAllowed(request) {
        if (this.config.allowedHosts?.includes("*"))
            return true;
        const host = String(request.headers.host ?? "").trim().toLowerCase().replace(/^\[([^\]]+)\](?::\d+)?$/, "$1").replace(/:\d+$/, "");
        if (!host)
            return false;
        const allowed = new Set([
            String(this.config.host ?? "").toLowerCase(),
            ...(this.config.allowedHosts ?? []).map((value) => String(value).toLowerCase()),
        ]);
        try {
            allowed.add(new URL(this.config.publicBaseUrl).hostname.toLowerCase());
        }
        catch {
            // Invalid publicBaseUrl is already rejected by normal config validation.
        }
        return allowed.has(host);
    }
    acceptSocket(ws, request) {
        const state = {
            ws,
            agentId: undefined,
            authenticated: false,
            pending: new Map(),
            lastSeenAt: Date.now(),
            remoteAddress: request.socket.remoteAddress,
        };
        const helloTimer = setTimeout(() => {
            if (!state.authenticated)
                ws.close(4401, "hello timeout");
        }, 10_000);
        helloTimer.unref?.();
        ws.on("message", (data) => {
            state.lastSeenAt = Date.now();
            try {
                const message = parseMessage(data);
                if (!state.authenticated) {
                    this.handleHello(state, message);
                    if (state.authenticated)
                        clearTimeout(helloTimer);
                    return;
                }
                this.store.markSeen(state.agentId);
                if (message.type === "enrollment_confirm") {
                    if (String(message.agentId ?? "") !== state.agentId)
                        throw new Error("Remote agent enrollment confirmation identity mismatch.");
                    if (this.store.confirmEnrollment(state.agentId)) {
                        this.runtimeState.appendEvent({
                            kind: "remote.agent.enrollment_confirmed",
                            subject: state.agentId,
                            payload: { agentId: state.agentId },
                        });
                    }
                    return;
                }
                if (message.type === "response") {
                    const pending = state.pending.get(message.id);
                    if (!pending)
                        return;
                    state.pending.delete(message.id);
                    clearTimeout(pending.timer);
                    if (message.ok === false)
                        pending.reject(new Error(String(message.error ?? "Remote agent RPC failed.")));
                    else
                        pending.resolve(message.result);
                    return;
                }
                if (message.type === "event") {
                    this.runtimeState.appendEvent({
                        kind: String(message.kind ?? "remote.event"),
                        subject: message.subject ? String(message.subject) : state.agentId,
                        workspaceId: message.workspaceId ? String(message.workspaceId) : undefined,
                        payload: { agentId: state.agentId, ...(message.payload ?? {}) },
                    });
                    return;
                }
            }
            catch (error) {
                ws.close(4400, error instanceof Error ? error.message.slice(0, 120) : "invalid message");
            }
        });
        ws.on("pong", () => {
            state.lastSeenAt = Date.now();
            if (state.agentId)
                this.store.markSeen(state.agentId);
        });
        ws.on("close", () => this.dropConnection(state));
        ws.on("error", () => this.dropConnection(state));
    }
    handleHello(state, message) {
        if (message?.type !== "hello" || Number(message.protocol) !== DEVSPACE_REMOTE_AGENT_PROTOCOL)
            throw new Error(`Remote agent protocol mismatch. Expected ${DEVSPACE_REMOTE_AGENT_PROTOCOL}.`);
        let identity;
        let enrolled = false;
        if (message.enrollmentToken) {
            identity = this.store.consumeEnrollment(String(message.enrollmentToken), message);
            enrolled = true;
        }
        else {
            const agent = this.store.authenticate(String(message.agentId ?? ""), String(message.agentSecret ?? ""));
            if (!agent)
                throw new Error("Remote agent authentication failed.");
            identity = {
                agentId: agent.id,
                name: agent.name,
                allowedRoots: agent.allowedRoots,
                writableRoots: agent.writableRoots ?? agent.allowedRoots,
                accessMode: agent.accessMode ?? "scoped",
                installRoot: agent.installRoot,
            };
        }
        const previous = this.connections.get(identity.agentId);
        if (previous && previous !== state) {
            previous.ws.close(4001, "replaced by newer connection");
            this.rejectPending(previous, new Error("Remote agent reconnected."));
        }
        state.agentId = identity.agentId;
        state.authenticated = true;
        this.connections.set(identity.agentId, state);
        this.resolveConnectionWaiters(identity.agentId, state);
        this.store.markConnected(identity.agentId, message);
        const agentScript = linuxAgentAsset("devspace-agent.py");
        const ack = {
            type: "hello_ack",
            protocol: DEVSPACE_REMOTE_AGENT_PROTOCOL,
            agentId: identity.agentId,
            agentSecret: enrolled ? identity.agentSecret : undefined,
            name: identity.name,
            allowedRoots: identity.allowedRoots,
            writableRoots: identity.writableRoots ?? identity.allowedRoots ?? [],
            accessMode: identity.accessMode ?? "scoped",
            installRoot: identity.installRoot,
            serverTime: new Date().toISOString(),
            agentVersion: DEVSPACE_LINUX_AGENT_VERSION,
            agentScriptSha256: agentScript.sha256,
            agentScriptUrl: `${this.config.publicBaseUrl.replace(/\/+$/, "")}/agent/v1/devspace-agent.py`,
            enrollmentRecovered: Boolean(identity.recovered),
        };
        state.ws.send(JSON.stringify(ack));
        this.runtimeState.appendEvent({
            kind: enrolled ? "remote.agent.enrolled" : "remote.agent.connected",
            subject: identity.agentId,
            payload: { agentId: identity.agentId, name: identity.name, hostname: message.hostname, platform: message.platform },
        });
        if (!enrolled && message.agentVersion && message.agentVersion !== DEVSPACE_LINUX_AGENT_VERSION && message.capabilities?.autoUpdate) {
            setTimeout(() => {
                void this.rpc(identity.agentId, "agent.selfUpdate", {
                    url: ack.agentScriptUrl,
                    sha256: ack.agentScriptSha256,
                    version: DEVSPACE_LINUX_AGENT_VERSION,
                }, 120_000).catch(() => {});
            }, 1000).unref?.();
        }
    }
    dropConnection(state) {
        if (state.agentId && this.connections.get(state.agentId) === state) {
            this.connections.delete(state.agentId);
            this.store.markOffline(state.agentId);
            this.runtimeState.appendEvent({ kind: "remote.agent.disconnected", subject: state.agentId, payload: { agentId: state.agentId } });
        }
        this.rejectPending(state, new Error("Remote agent disconnected."));
    }
    resolveConnectionWaiters(agentId, state) {
        const waiters = this.connectionWaiters.get(agentId);
        if (!waiters)
            return;
        this.connectionWaiters.delete(agentId);
        for (const waiter of waiters) {
            clearTimeout(waiter.timer);
            waiter.resolve(state);
        }
    }
    async waitForConnection(agentId, timeoutMs = DEFAULT_RECONNECT_GRACE_MS) {
        const existing = this.connections.get(String(agentId));
        if (existing && existing.ws.readyState === WebSocket.OPEN)
            return existing;
        const id = String(agentId);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                const waiters = this.connectionWaiters.get(id) ?? [];
                const filtered = waiters.filter((item) => item.resolve !== resolve);
                if (filtered.length > 0)
                    this.connectionWaiters.set(id, filtered);
                else
                    this.connectionWaiters.delete(id);
                reject(new Error(`Remote agent did not reconnect within ${timeoutMs} ms: ${id}`));
            }, Math.max(1000, timeoutMs));
            timer.unref?.();
            const waiters = this.connectionWaiters.get(id) ?? [];
            waiters.push({ resolve, reject, timer });
            this.connectionWaiters.set(id, waiters);
        });
    }
    rejectPending(state, error) {
        for (const pending of state.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        state.pending.clear();
    }
    heartbeat() {
        const now = Date.now();
        for (const state of this.connections.values()) {
            const persisted = state.agentId ? this.store.get(state.agentId, true) : undefined;
            if (!persisted || persisted.status === "revoked") {
                state.ws.close(4403, "agent revoked");
                continue;
            }
            if (now - state.lastSeenAt > 60_000) {
                state.ws.terminate();
                continue;
            }
            if (state.ws.readyState === WebSocket.OPEN)
                state.ws.ping();
        }
    }
    connectedIds() {
        return new Set(this.connections.keys());
    }
    list() {
        return this.store.list(this.connectedIds());
    }
    resolveAgent(reference, requireOnline = true) {
        const agent = this.store.resolve(reference, this.connectedIds());
        if (agent.status === "revoked")
            throw new Error(`Remote agent is revoked: ${agent.id}`);
        if (requireOnline && !this.connections.has(agent.id))
            throw new Error(`Remote agent is offline: ${agent.name} (${agent.id})`);
        return agent;
    }
    async rpc(agentId, method, params = {}, timeoutMs = DEFAULT_RPC_TIMEOUT_MS, options = {}) {
        const persisted = this.store.get(String(agentId), this.connections.has(String(agentId)));
        if (!persisted || persisted.status === "revoked")
            throw new Error(`Remote agent is revoked or unknown: ${agentId}`);
        const reconnectGraceMs = Math.max(0, Number(options.reconnectGraceMs ?? DEFAULT_RECONNECT_GRACE_MS));
        let state = this.connections.get(String(agentId));
        if (!state || state.ws.readyState !== WebSocket.OPEN) {
            if (reconnectGraceMs <= 0)
                throw new Error(`Remote agent is offline: ${agentId}`);
            // Only queue calls that have not yet been transmitted. Once an RPC
            // frame has been sent, a disconnect produces an explicit error and
            // the caller decides whether retrying is safe; mutations are never
            // replayed blindly after an ambiguous connection loss.
            state = await this.waitForConnection(String(agentId), Math.min(reconnectGraceMs, timeoutMs));
        }
        const id = `rpc_${randomUUID()}`;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                state.pending.delete(id);
                reject(new Error(`Remote agent RPC timed out: ${method}`));
            }, Math.max(1000, timeoutMs));
            timer.unref?.();
            state.pending.set(id, { resolve, reject, timer, method });
            state.ws.send(JSON.stringify({ type: "request", id, method, params }), (error) => {
                if (!error)
                    return;
                state.pending.delete(id);
                clearTimeout(timer);
                reject(error);
            });
        });
    }
    rpcWorkspace(workspace, method, params = {}, timeoutMs) {
        if (workspace.backend !== "remote-agent" || !workspace.backendId)
            throw new Error("Workspace is not backed by a remote agent.");
        return this.rpc(workspace.backendId, method, { workspaceId: workspace.id, root: workspace.root, ...params }, timeoutMs);
    }
    async inspectWorkspace(agentReference, path, options = {}) {
        const agent = this.resolveAgent(agentReference, true);
        const result = await this.rpc(agent.id, options.mode === "worktree" ? "workspace.createWorktree" : "workspace.inspect", {
            path: normalizeRemotePath(path),
            baseRef: options.baseRef,
        }, 60_000);
        return { agent, ...result };
    }
    async capture(workspace, path) {
        const result = await this.rpcWorkspace(workspace, "fs.capture", { path });
        return {
            descriptor: result.descriptor,
            content: result.content ? decodeAgentContent(result.content) : undefined,
        };
    }
    async restore(workspace, path, descriptor, content) {
        return this.rpcWorkspace(workspace, "fs.restore", {
            path,
            descriptor,
            content: content === undefined || content === null ? undefined : encodeContent(content),
        }, 60_000);
    }
    async read(workspace, path, options = {}) {
        return this.rpcWorkspace(workspace, "fs.read", { path, offset: options.offset, limit: options.limit }, 60_000);
    }
    async readWhole(workspace, path) {
        const meta = await this.rpcWorkspace(workspace, "fs.stat", { path });
        if (!meta.exists)
            return null;
        if (meta.type !== "file")
            throw new Error(`Remote path is not a regular file: ${path}`);
        const chunks = [];
        let offset = 0;
        while (offset < meta.size) {
            const result = await this.rpcWorkspace(workspace, "fs.readChunk", { path, offset, length: Math.min(TRANSFER_CHUNK_BYTES, meta.size - offset) }, 60_000);
            const bytes = decodeAgentContent(result.content);
            chunks.push(bytes);
            offset += bytes.length;
            if (bytes.length === 0)
                break;
        }
        return Buffer.concat(chunks);
    }
    async writeBuffer(workspace, path, content, options = {}) {
        const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
        if (buffer.length <= TRANSFER_CHUNK_BYTES) {
            return this.rpcWorkspace(workspace, "fs.write", {
                path,
                mode: options.mode,
                sha256: sha256Buffer(buffer),
                content: encodeContent(buffer),
            }, 60_000);
        }
        const chunks = [];
        for (let offset = 0; offset < buffer.length; offset += TRANSFER_CHUNK_BYTES) {
            const chunk = buffer.subarray(offset, Math.min(buffer.length, offset + TRANSFER_CHUNK_BYTES));
            chunks.push({ index: chunks.length, sha256: sha256Buffer(chunk), size: chunk.length, chunk });
        }
        const transferId = `transfer_${randomUUID()}`;
        const prepare = await this.rpcWorkspace(workspace, "fs.prepareWrite", {
            transferId,
            path,
            size: buffer.length,
            sha256: sha256Buffer(buffer),
            mode: options.mode,
            chunks: chunks.map(({ index, sha256, size }) => ({ index, sha256, size })),
        }, 60_000);
        const missing = new Set(prepare.missingChunks ?? chunks.map((item) => item.index));
        for (const chunk of chunks) {
            if (!missing.has(chunk.index))
                continue;
            await this.rpcWorkspace(workspace, "fs.writeChunk", {
                transferId,
                index: chunk.index,
                sha256: chunk.sha256,
                content: encodeContent(chunk.chunk),
            }, 60_000);
        }
        return this.rpcWorkspace(workspace, "fs.commitWrite", { transferId }, 120_000);
    }
    async close() {
        clearInterval(this.heartbeatTimer);
        if (this.httpServer && this.upgradeHandler)
            this.httpServer.off?.("upgrade", this.upgradeHandler);
        for (const state of this.connections.values())
            state.ws.close(1001, "server shutdown");
        this.connections.clear();
        for (const waiters of this.connectionWaiters.values()) {
            for (const waiter of waiters) {
                clearTimeout(waiter.timer);
                waiter.reject(new Error("Remote Agent Manager is shutting down."));
            }
        }
        this.connectionWaiters.clear();
        await new Promise((resolve) => this.wss ? this.wss.close(() => resolve()) : resolve());
        this.store.close();
    }
}
