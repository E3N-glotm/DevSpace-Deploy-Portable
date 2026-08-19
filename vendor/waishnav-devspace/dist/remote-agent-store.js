import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openDatabase } from "./db/client.js";

const DEFAULT_ENROLLMENT_TTL_MINUTES = 15;
const MAX_ENROLLMENT_TTL_MINUTES = 24 * 60;
const ENROLLMENT_RECOVERY_WINDOW_MS = 2 * 60_000;

function sha256(value) {
    return createHash("sha256").update(String(value), "utf8").digest("hex");
}
function bundledAgentAsset(name) {
    const path = fileURLToPath(new URL(`./linux-agent/${name}`, import.meta.url));
    const bytes = readFileSync(path);
    return { sha256: createHash("sha256").update(bytes).digest("hex") };
}

function parseJson(value, fallback) {
    try {
        return JSON.parse(value);
    }
    catch {
        return fallback;
    }
}

function normalizeRoots(value) {
    const roots = Array.isArray(value) ? value : [value];
    const normalized = [];
    const seen = new Set();
    for (const item of roots) {
        let root = String(item ?? "").trim().replace(/\\/g, "/");
        if (!root)
            continue;
        if (!root.startsWith("/"))
            throw new Error(`Linux agent allowed root must be absolute: ${root}`);
        root = root.replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/";
        if (root === "/")
            throw new Error("Linux agent allowed root cannot be the filesystem root '/'. Choose a narrower project parent such as /home/ubuntu/workspace.");
        if (!seen.has(root)) {
            seen.add(root);
            normalized.push(root);
        }
    }
    if (normalized.length === 0)
        throw new Error("At least one Linux agent allowed root is required.");
    return normalized;
}

function publicAgent(row, connected = false) {
    const recentlySeen = row.last_seen_at && (Date.now() - Date.parse(row.last_seen_at) < 45_000);
    return {
        id: row.id,
        name: row.name,
        status: row.revoked_at ? "revoked" : connected ? "online" : row.status === "online" && recentlySeen ? "online-recent" : "offline",
        connected,
        allowedRoots: parseJson(row.allowed_roots_json, []),
        hostname: row.hostname ?? undefined,
        platform: row.platform ?? undefined,
        agentVersion: row.agent_version ?? undefined,
        capabilities: parseJson(row.capabilities_json, {}),
        metadata: parseJson(row.metadata_json, {}),
        createdAt: row.created_at,
        connectedAt: row.connected_at ?? undefined,
        lastSeenAt: row.last_seen_at ?? undefined,
        revokedAt: row.revoked_at ?? undefined,
    };
}

export class RemoteAgentStore {
    database;
    constructor(stateDir) {
        this.database = openDatabase(stateDir);
    }
    createEnrollment(input = {}) {
        const name = String(input.name ?? "").trim();
        if (!name)
            throw new Error("Remote agent name is required.");
        const allowedRoots = normalizeRoots(input.allowedRoots);
        const ttlMinutes = Math.max(1, Math.min(Number(input.ttlMinutes ?? DEFAULT_ENROLLMENT_TTL_MINUTES), MAX_ENROLLMENT_TTL_MINUTES));
        const token = `dve_${randomBytes(32).toString("base64url")}`;
        const now = new Date();
        const expiresAt = new Date(now.getTime() + ttlMinutes * 60_000).toISOString();
        this.database.sqlite.prepare(`
      insert into remote_agent_enrollments
        (token_hash, name, allowed_roots_json, expires_at, created_at, used_at)
      values (?, ?, ?, ?, ?, null)
    `).run(sha256(token), name, JSON.stringify(allowedRoots), expiresAt, now.toISOString());
        return { token, name, allowedRoots, expiresAt, ttlMinutes };
    }
    consumeEnrollment(token, hello = {}) {
        const tokenHash = sha256(token);
        const transaction = this.database.sqlite.transaction(() => {
            const row = this.database.sqlite.prepare(`
        select * from remote_agent_enrollments where token_hash=?
      `).get(tokenHash);
            if (!row)
                throw new Error("Enrollment token is invalid.");
            if (Date.parse(row.expires_at) <= Date.now())
                throw new Error("Enrollment token has expired.");
            const allowedRoots = normalizeRoots(parseJson(row.allowed_roots_json, []));
            if (row.used_at) {
                const recoveryAge = Date.now() - Date.parse(row.used_at);
                if (!row.agent_id || !Number.isFinite(recoveryAge) || recoveryAge < 0 || recoveryAge > ENROLLMENT_RECOVERY_WINDOW_MS)
                    throw new Error("Enrollment token has already been used.");
                const agent = this.database.sqlite.prepare(`select * from remote_agents where id=?`).get(row.agent_id);
                if (!agent || agent.revoked_at)
                    throw new Error("Enrollment recovery is no longer available for this Agent.");
                const agentSecret = `dva_${randomBytes(32).toString("base64url")}`;
                this.database.sqlite.prepare(`
          update remote_agents set secret_hash=?, status='online' where id=? and revoked_at is null
        `).run(sha256(agentSecret), row.agent_id);
                return { agentId: row.agent_id, agentSecret, name: row.name, allowedRoots, recovered: true };
            }
            const agentId = `agent_${randomBytes(5).toString("hex")}`;
            const agentSecret = `dva_${randomBytes(32).toString("base64url")}`;
            const now = new Date().toISOString();
            this.database.sqlite.prepare(`
        insert into remote_agents (
          id, name, secret_hash, status, allowed_roots_json, hostname, platform,
          agent_version, capabilities_json, metadata_json, created_at,
          connected_at, last_seen_at, revoked_at
        ) values (?, ?, ?, 'online', ?, ?, ?, ?, ?, ?, ?, ?, ?, null)
      `).run(agentId, row.name, sha256(agentSecret), JSON.stringify(allowedRoots), hello.hostname ?? null, hello.platform ?? null, hello.agentVersion ?? null, JSON.stringify(hello.capabilities ?? {}), JSON.stringify(hello.metadata ?? {}), now, now, now);
            this.database.sqlite.prepare(`update remote_agent_enrollments set used_at=?, agent_id=? where token_hash=?`).run(now, agentId, tokenHash);
            return { agentId, agentSecret, name: row.name, allowedRoots, recovered: false };
        });
        return transaction();
    }
    confirmEnrollment(agentId) {
        return this.database.sqlite.prepare(`
      delete from remote_agent_enrollments where agent_id=? and used_at is not null
    `).run(String(agentId)).changes > 0;
    }
    authenticate(agentId, secret) {
        const row = this.database.sqlite.prepare(`select * from remote_agents where id=?`).get(String(agentId));
        if (!row || row.revoked_at)
            return undefined;
        if (sha256(secret) !== row.secret_hash)
            return undefined;
        return publicAgent(row, false);
    }
    markConnected(agentId, hello = {}) {
        const now = new Date().toISOString();
        this.database.sqlite.prepare(`
      update remote_agents set
        status='online', hostname=?, platform=?, agent_version=?,
        capabilities_json=?, metadata_json=?, connected_at=?, last_seen_at=?
      where id=? and revoked_at is null
    `).run(hello.hostname ?? null, hello.platform ?? null, hello.agentVersion ?? null, JSON.stringify(hello.capabilities ?? {}), JSON.stringify(hello.metadata ?? {}), now, now, agentId);
    }
    markSeen(agentId) {
        this.database.sqlite.prepare(`update remote_agents set last_seen_at=?, status='online' where id=? and revoked_at is null`).run(new Date().toISOString(), agentId);
    }
    markOffline(agentId) {
        this.database.sqlite.prepare(`update remote_agents set status='offline', last_seen_at=? where id=? and revoked_at is null`).run(new Date().toISOString(), agentId);
    }
    list(connectedIds = new Set()) {
        return this.database.sqlite.prepare(`select * from remote_agents order by name collate nocase, created_at`).all()
            .map((row) => publicAgent(row, connectedIds.has(row.id)));
    }
    get(agentId, connected = false) {
        const row = this.database.sqlite.prepare(`select * from remote_agents where id=?`).get(String(agentId));
        return row ? publicAgent(row, connected) : undefined;
    }
    resolve(reference, connectedIds = new Set()) {
        const text = String(reference ?? "").trim();
        if (!text)
            throw new Error("Remote agent id or name is required.");
        const byId = this.get(text, connectedIds.has(text));
        if (byId)
            return byId;
        const rows = this.database.sqlite.prepare(`select * from remote_agents where lower(name)=lower(?) and revoked_at is null`).all(text);
        if (rows.length === 0)
            throw new Error(`Remote agent not found: ${text}`);
        if (rows.length > 1)
            throw new Error(`Remote agent name is ambiguous: ${text}. Use the agent id instead.`);
        return publicAgent(rows[0], connectedIds.has(rows[0].id));
    }
    revoke(agentId) {
        const now = new Date().toISOString();
        const result = this.database.sqlite.prepare(`update remote_agents set status='revoked', revoked_at=?, last_seen_at=? where id=? and revoked_at is null`).run(now, now, String(agentId));
        if (result.changes !== 1)
            throw new Error(`Remote agent not found or already revoked: ${agentId}`);
        return this.get(agentId, false);
    }
    delete(agentId) {
        const result = this.database.sqlite.prepare(`delete from remote_agents where id=?`).run(String(agentId));
        if (result.changes !== 1)
            throw new Error(`Remote agent not found: ${agentId}`);
        return { deleted: true, agentId: String(agentId) };
    }
    pruneEnrollments() {
        const now = new Date();
        const recoveryCutoff = new Date(now.getTime() - ENROLLMENT_RECOVERY_WINDOW_MS).toISOString();
        this.database.sqlite.prepare(`
      delete from remote_agent_enrollments
      where expires_at < ? or (used_at is not null and used_at < ?)
    `).run(now.toISOString(), recoveryCutoff);
    }
    close() {
        this.database.close();
    }
}

export function createRemoteAgentStore(stateDir) {
    return new RemoteAgentStore(stateDir);
}

export function remoteAgentAdmin({ stateDir, action, payload = {}, publicBaseUrl }) {
    const store = createRemoteAgentStore(stateDir);
    try {
        store.pruneEnrollments();
        if (action === "list")
            return { agents: store.list() };
        if (action === "create-enrollment") {
            const enrollment = store.createEnrollment(payload);
            const base = String(publicBaseUrl ?? payload.publicBaseUrl ?? "").replace(/\/+$/, "");
            const rootArgs = enrollment.allowedRoots.map((root) => `--allowed-root '${root.replace(/'/g, `'"'"'`)}'`).join(" ");
            const installer = bundledAgentAsset("install.sh");
            const agent = bundledAgentAsset("devspace-agent.py");
            const installCommand = base
                ? `tmp=$(mktemp); curl -fsSL '${base}/agent/v1/install.sh' -o "$tmp" && echo '${installer.sha256}  '"$tmp" | sha256sum -c - && sudo bash "$tmp" --server '${base}' --token '${enrollment.token}' --name '${enrollment.name.replace(/'/g, `'"'"'`)}' --agent-sha256 '${agent.sha256}' ${rootArgs}; rc=$?; rm -f "$tmp"; exit $rc`
                : undefined;
            return { enrollment, installCommand, installerSha256: installer.sha256, agentSha256: agent.sha256 };
        }
        if (action === "revoke")
            return { agent: store.revoke(String(payload.agentId ?? "")) };
        if (action === "delete")
            return store.delete(String(payload.agentId ?? ""));
        throw new Error(`Unsupported remote agent admin action: ${action}`);
    }
    finally {
        store.close();
    }
}
