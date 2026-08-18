import { and, eq } from "drizzle-orm";
import { openDatabase } from "./db/client.js";
import { workspaceConversationBindings, workspaceSessions } from "./db/schema.js";

export class SqliteWorkspaceStore {
    database;
    constructor(stateDir) {
        this.database = openDatabase(stateDir);
    }
    createSession(input) {
        const now = new Date().toISOString();
        const session = {
            id: input.id,
            root: input.root,
            status: "active",
            mode: input.mode ?? "checkout",
            sourceRoot: input.sourceRoot,
            baseRef: input.baseRef,
            baseSha: input.baseSha,
            managed: input.managed ?? false,
            title: input.title,
            gitSha: input.gitSha,
            gitBranch: input.gitBranch,
            gitOriginUrl: input.gitOriginUrl,
            backend: input.backend ?? "local",
            backendId: input.backendId,
            createdAt: now,
            lastUsedAt: now,
        };
        this.database.db.insert(workspaceSessions).values({
            id: session.id,
            root: session.root,
            status: session.status,
            mode: session.mode,
            sourceRoot: session.sourceRoot ?? null,
            baseRef: session.baseRef ?? null,
            baseSha: session.baseSha ?? null,
            managed: String(session.managed),
            title: session.title ?? null,
            gitSha: session.gitSha ?? null,
            gitBranch: session.gitBranch ?? null,
            gitOriginUrl: session.gitOriginUrl ?? null,
            backend: session.backend,
            backendId: session.backendId ?? null,
            archivedAt: null,
            createdAt: session.createdAt,
            lastUsedAt: session.lastUsedAt,
        }).run();
        return session;
    }
    getSession(id) {
        const row = this.database.db.select().from(workspaceSessions).where(eq(workspaceSessions.id, id)).get();
        return row ? rowToWorkspaceSession(row) : undefined;
    }
    touchSession(id, metadata) {
        const values = { lastUsedAt: new Date().toISOString() };
        if (metadata) {
            values.gitSha = metadata.gitSha ?? null;
            values.gitBranch = metadata.gitBranch ?? null;
            values.gitOriginUrl = metadata.gitOriginUrl ?? null;
            values.title = metadata.title ?? null;
        }
        this.database.db.update(workspaceSessions).set(values).where(eq(workspaceSessions.id, id)).run();
    }
    getConversationBinding(conversationScopeId, targetKey) {
        const row = this.database.db
            .select()
            .from(workspaceConversationBindings)
            .where(and(eq(workspaceConversationBindings.conversationScopeId, conversationScopeId), eq(workspaceConversationBindings.targetKey, targetKey)))
            .get();
        return row ? rowToWorkspaceConversationBinding(row) : undefined;
    }
    setConversationBinding(input) {
        const now = new Date().toISOString();
        const row = this.database.db
            .insert(workspaceConversationBindings)
            .values({
            conversationScopeId: input.conversationScopeId,
            targetKey: input.targetKey,
            workspaceSessionId: input.workspaceSessionId,
            createdAt: now,
            lastUsedAt: now,
        })
            .onConflictDoUpdate({
            target: [workspaceConversationBindings.conversationScopeId, workspaceConversationBindings.targetKey],
            set: {
                workspaceSessionId: input.workspaceSessionId,
                lastUsedAt: now,
            },
        })
            .returning()
            .get();
        if (!row)
            throw new Error("Conversation workspace binding upsert returned no row.");
        return rowToWorkspaceConversationBinding(row);
    }
    touchConversationBinding(conversationScopeId, targetKey) {
        this.database.db
            .update(workspaceConversationBindings)
            .set({ lastUsedAt: new Date().toISOString() })
            .where(and(eq(workspaceConversationBindings.conversationScopeId, conversationScopeId), eq(workspaceConversationBindings.targetKey, targetKey)))
            .run();
    }
    deleteConversationBinding(conversationScopeId, targetKey) {
        this.database.db
            .delete(workspaceConversationBindings)
            .where(and(eq(workspaceConversationBindings.conversationScopeId, conversationScopeId), eq(workspaceConversationBindings.targetKey, targetKey)))
            .run();
    }
    listSessions(input = {}) {
        const clauses = [];
        const params = {};
        if (!input.includeArchived)
            clauses.push("status = 'active'");
        if (input.status) {
            clauses.push("status = @status");
            params.status = input.status;
        }
        const where = clauses.length > 0 ? `where ${clauses.join(" and ")}` : "";
        const limit = Math.max(1, Math.min(Number(input.limit ?? 100), 1000));
        return this.database.sqlite.prepare(`
      select * from workspace_sessions
      ${where}
      order by last_used_at desc
      limit @limit
    `).all({ ...params, limit }).map(rowToWorkspaceSession);
    }
    archiveSession(id) {
        const now = new Date().toISOString();
        const result = this.database.sqlite.prepare(`
      update workspace_sessions
      set status='archived', archived_at=?, last_used_at=?
      where id=?
    `).run(now, now, id);
        if (result.changes === 0)
            throw new Error(`Unknown workspace session: ${id}`);
        return this.getSession(id);
    }
    activateSession(id) {
        const now = new Date().toISOString();
        const result = this.database.sqlite.prepare(`
      update workspace_sessions
      set status='active', archived_at=null, last_used_at=?
      where id=?
    `).run(now, id);
        if (result.changes === 0)
            throw new Error(`Unknown workspace session: ${id}`);
        return this.getSession(id);
    }
    close() {
        this.database.close();
    }
}

export function createWorkspaceStore(stateDir) {
    return new SqliteWorkspaceStore(stateDir);
}

function rowToWorkspaceSession(row) {
    return {
        id: row.id,
        root: row.root,
        status: row.status,
        mode: row.mode === "worktree" ? "worktree" : "checkout",
        sourceRoot: row.sourceRoot ?? row.source_root ?? undefined,
        baseRef: row.baseRef ?? row.base_ref ?? undefined,
        baseSha: row.baseSha ?? row.base_sha ?? undefined,
        managed: (row.managed ?? "false") === "true",
        title: row.title ?? undefined,
        gitSha: row.gitSha ?? row.git_sha ?? undefined,
        gitBranch: row.gitBranch ?? row.git_branch ?? undefined,
        gitOriginUrl: row.gitOriginUrl ?? row.git_origin_url ?? undefined,
        backend: row.backend ?? "local",
        backendId: row.backendId ?? row.backend_id ?? undefined,
        archivedAt: row.archivedAt ?? row.archived_at ?? undefined,
        createdAt: row.createdAt ?? row.created_at,
        lastUsedAt: row.lastUsedAt ?? row.last_used_at,
    };
}
function rowToWorkspaceConversationBinding(row) {
    return {
        conversationScopeId: row.conversationScopeId,
        targetKey: row.targetKey,
        workspaceSessionId: row.workspaceSessionId,
        createdAt: row.createdAt,
        lastUsedAt: row.lastUsedAt,
    };
}
