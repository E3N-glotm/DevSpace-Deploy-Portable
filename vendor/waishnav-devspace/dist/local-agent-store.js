import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { openDatabase } from "./db/client.js";
export class LocalAgentStore {
    database;
    constructor(stateDir) {
        this.database = openDatabase(stateDir);
    }
    list(scope = {}) {
        let rows;
        if (scope.workspaceId) {
            rows = this.database.sqlite
                .prepare(`select * from local_agent_sessions
           where workspace_id = ?
           order by updated_at desc`)
                .all(scope.workspaceId);
        }
        else if (scope.workspaceRoot) {
            rows = this.database.sqlite
                .prepare(`select * from local_agent_sessions
           where workspace_root = ?
           order by updated_at desc`)
                .all(resolve(scope.workspaceRoot));
        }
        else {
            rows = this.database.sqlite
                .prepare("select * from local_agent_sessions order by updated_at desc")
                .all();
        }
        return rows.map(rowToLocalAgentRecord);
    }
    create(input) {
        const now = new Date().toISOString();
        const record = {
            id: `agt_${randomUUID().replaceAll("-", "").slice(0, 8)}`,
            workspaceId: input.workspaceId,
            workspaceRoot: resolve(input.workspaceRoot),
            profileName: input.profileName,
            provider: input.provider,
            model: input.model,
            thinking: input.thinking,
            status: "starting",
            createdAt: now,
            updatedAt: now,
        };
        this.database.sqlite
            .prepare(`insert into local_agent_sessions (
          id,
          workspace_id,
          workspace_root,
          profile_name,
          provider,
          model,
          thinking,
          status,
          created_at,
          updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(record.id, record.workspaceId ?? null, record.workspaceRoot, record.profileName, record.provider, record.model ?? null, record.thinking ?? null, record.status, record.createdAt, record.updatedAt);
        return record;
    }
    get(idOrPrefix) {
        const exact = this.database.sqlite
            .prepare(`select * from local_agent_sessions
         where id = ? or provider_session_id = ?
         limit 1`)
            .get(idOrPrefix, idOrPrefix);
        if (exact)
            return rowToLocalAgentRecord(exact);
        const matches = this.database.sqlite
            .prepare(`select * from local_agent_sessions
         where id like ? escape '\\' or provider_session_id like ? escape '\\'
         order by updated_at desc`)
            .all(`${escapeLike(idOrPrefix)}%`, `${escapeLike(idOrPrefix)}%`);
        return matches.length === 1 ? rowToLocalAgentRecord(matches[0]) : undefined;
    }
    update(id, patch) {
        const current = this.getById(id);
        if (!current)
            throw new Error(`Unknown subagent id: ${id}`);
        const updated = {
            ...current,
            ...patch,
            updatedAt: new Date().toISOString(),
        };
        this.database.sqlite
            .prepare(`update local_agent_sessions set
          workspace_id = ?,
          workspace_root = ?,
          profile_name = ?,
          provider = ?,
          model = ?,
          thinking = ?,
          provider_session_id = ?,
          status = ?,
          latest_response = ?,
          error = ?,
          updated_at = ?
         where id = ?`)
            .run(updated.workspaceId ?? null, resolve(updated.workspaceRoot), updated.profileName, updated.provider, updated.model ?? null, updated.thinking ?? null, updated.providerSessionId ?? null, updated.status, updated.latestResponse ?? null, updated.error ?? null, updated.updatedAt, updated.id);
        return updated;
    }
    close() {
        this.database.close();
    }
    getById(id) {
        const row = this.database.sqlite
            .prepare("select * from local_agent_sessions where id = ?")
            .get(id);
        return row ? rowToLocalAgentRecord(row) : undefined;
    }
}
export function createLocalAgentStore(config) {
    return new LocalAgentStore(config.stateDir);
}
function rowToLocalAgentRecord(row) {
    return {
        id: row.id,
        workspaceId: row.workspace_id ?? undefined,
        workspaceRoot: row.workspace_root,
        profileName: row.profile_name,
        provider: row.provider,
        model: row.model ?? undefined,
        thinking: row.thinking ?? undefined,
        providerSessionId: row.provider_session_id ?? undefined,
        status: readStatus(row.status),
        latestResponse: row.latest_response ?? undefined,
        error: row.error ?? undefined,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}
function readStatus(status) {
    if (status === "starting" ||
        status === "running" ||
        status === "idle" ||
        status === "error" ||
        status === "stopped") {
        return status;
    }
    return "error";
}
function escapeLike(value) {
    return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}
