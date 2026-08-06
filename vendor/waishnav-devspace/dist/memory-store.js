import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

const SECRET_PATTERN = /\b(?:password|passwd|pwd|token|secret|authorization|api[_-]?key|private[_-]?key|client[_-]?secret)\b\s*[:=]/i;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}/i;

function normalizeWorkspaceRoot(root) {
    return resolve(root).replace(/\\/g, "/").toLowerCase();
}

function normalizeTags(tags) {
    return Array.from(new Set((tags ?? [])
        .map((tag) => String(tag).trim())
        .filter(Boolean)))
        .slice(0, 20);
}

function rowToMemory(row) {
    return {
        id: row.id,
        scope: row.scope,
        workspaceRoot: row.workspace_root ?? undefined,
        title: row.title,
        content: row.content,
        tags: JSON.parse(row.tags_json || "[]"),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export class MemoryStore {
    sqlite;
    constructor(sqlite) {
        this.sqlite = sqlite;
        sqlite.exec(`
          create table if not exists devspace_memories (
            id text primary key,
            scope text not null check (scope in ('global', 'workspace')),
            workspace_root text,
            title text not null,
            content text not null,
            tags_json text not null default '[]',
            created_at text not null,
            updated_at text not null
          );
          create index if not exists devspace_memories_scope_idx
            on devspace_memories(scope, workspace_root, updated_at desc);
        `);
    }
    list({ workspaceRoot, includeGlobal = true, query, limit = 50 } = {}) {
        const clauses = [];
        const parameters = { limit: Math.max(1, Math.min(Number(limit) || 50, 200)) };
        if (workspaceRoot) {
            parameters.workspaceRoot = normalizeWorkspaceRoot(workspaceRoot);
            clauses.push(includeGlobal
                ? "(scope='global' or (scope='workspace' and workspace_root=@workspaceRoot))"
                : "scope='workspace' and workspace_root=@workspaceRoot");
        }
        else if (!includeGlobal) {
            clauses.push("scope='workspace'");
        }
        if (query) {
            parameters.query = `%${String(query).trim()}%`;
            clauses.push("(title like @query or content like @query or tags_json like @query)");
        }
        const rows = this.sqlite.prepare(`
          select * from devspace_memories
          ${clauses.length ? `where ${clauses.join(" and ")}` : ""}
          order by updated_at desc
          limit @limit
        `).all(parameters);
        return rows.map(rowToMemory);
    }
    upsert({ id, scope, workspaceRoot, title, content, tags, allowSensitive = false }) {
        const normalizedScope = scope === "global" ? "global" : "workspace";
        const normalizedTitle = String(title ?? "").trim();
        const normalizedContent = String(content ?? "").trim();
        if (!normalizedTitle)
            throw new Error("Memory title cannot be empty.");
        if (!normalizedContent)
            throw new Error("Memory content cannot be empty.");
        if (normalizedTitle.length > 200)
            throw new Error("Memory title exceeds 200 characters.");
        if (normalizedContent.length > 8_000)
            throw new Error("Memory content exceeds 8000 characters.");
        if (!allowSensitive && (SECRET_PATTERN.test(normalizedContent) || BEARER_PATTERN.test(normalizedContent))) {
            throw new Error("Memory looks like it contains a credential or secret. Store a reference to the secure location instead, or explicitly set allowSensitive=true.");
        }
        if (normalizedScope === "workspace" && !workspaceRoot)
            throw new Error("workspaceRoot is required for workspace-scoped memory.");
        const memoryId = id ? String(id) : randomUUID();
        const existing = this.sqlite.prepare("select created_at from devspace_memories where id=?").get(memoryId);
        const now = new Date().toISOString();
        this.sqlite.prepare(`
          insert into devspace_memories (
            id, scope, workspace_root, title, content, tags_json, created_at, updated_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?)
          on conflict(id) do update set
            scope=excluded.scope,
            workspace_root=excluded.workspace_root,
            title=excluded.title,
            content=excluded.content,
            tags_json=excluded.tags_json,
            updated_at=excluded.updated_at
        `).run(
            memoryId,
            normalizedScope,
            normalizedScope === "workspace" ? normalizeWorkspaceRoot(workspaceRoot) : null,
            normalizedTitle,
            normalizedContent,
            JSON.stringify(normalizeTags(tags)),
            existing?.created_at ?? now,
            now,
        );
        return this.get(memoryId);
    }
    get(id) {
        const row = this.sqlite.prepare("select * from devspace_memories where id=?").get(String(id));
        if (!row)
            throw new Error(`Unknown memory: ${id}`);
        return rowToMemory(row);
    }
    delete(id) {
        const memory = this.get(id);
        this.sqlite.prepare("delete from devspace_memories where id=?").run(String(id));
        return memory;
    }
    summaries(workspaceRoot, limit = 12) {
        return this.list({ workspaceRoot, includeGlobal: true, limit }).map((memory) => ({
            id: memory.id,
            scope: memory.scope,
            title: memory.title,
            content: memory.content.length > 600 ? `${memory.content.slice(0, 597)}...` : memory.content,
            tags: memory.tags,
            updatedAt: memory.updatedAt,
        }));
    }
}

