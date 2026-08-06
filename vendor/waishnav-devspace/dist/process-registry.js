import { randomUUID } from "node:crypto";
import { openDatabase } from "./db/client.js";

function parseJson(value, fallback) {
    if (!value)
        return fallback;
    try {
        return JSON.parse(value);
    }
    catch {
        return fallback;
    }
}

function rowToRecord(row) {
    return {
        processHandle: row.handle,
        workspaceId: row.workspace_id,
        workspaceRoot: row.workspace_root,
        sessionId: row.legacy_session_id ?? undefined,
        argv: parseJson(row.command_json, undefined),
        cmd: row.shell_command ?? undefined,
        cwd: row.cwd,
        env: parseJson(row.env_json, undefined),
        tty: Boolean(row.tty),
        persistent: Boolean(row.persistent),
        pid: row.pid ?? undefined,
        status: row.status,
        running: row.status === "running" || row.status === "detached-running",
        exitCode: row.exit_code ?? undefined,
        signal: row.signal ?? undefined,
        ownerInstanceId: row.owner_instance_id ?? undefined,
        startedAt: row.started_at,
        updatedAt: row.updated_at,
        completedAt: row.completed_at ?? undefined,
    };
}

export function processExists(pid) {
    if (!Number.isInteger(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return error && typeof error === "object" && error.code === "EPERM";
    }
}

export class ProcessRegistryStore {
    database;
    instanceId;
    constructor(stateDir) {
        this.database = openDatabase(stateDir);
        this.instanceId = `devspace_${randomUUID()}`;
    }
    upsertRunning(input) {
        const now = new Date().toISOString();
        this.database.sqlite.prepare(`
      insert into process_registry (
        handle, workspace_id, workspace_root, legacy_session_id,
        command_json, shell_command, cwd, env_json, tty, persistent,
        pid, status, exit_code, signal, owner_instance_id,
        started_at, updated_at, completed_at
      ) values (
        @handle, @workspaceId, @workspaceRoot, @sessionId,
        @commandJson, @shellCommand, @cwd, @envJson, @tty, @persistent,
        @pid, 'running', null, null, @ownerInstanceId,
        @startedAt, @updatedAt, null
      )
      on conflict(handle) do update set
        workspace_id=excluded.workspace_id,
        workspace_root=excluded.workspace_root,
        legacy_session_id=excluded.legacy_session_id,
        command_json=excluded.command_json,
        shell_command=excluded.shell_command,
        cwd=excluded.cwd,
        env_json=excluded.env_json,
        tty=excluded.tty,
        persistent=excluded.persistent,
        pid=excluded.pid,
        status='running',
        exit_code=null,
        signal=null,
        owner_instance_id=excluded.owner_instance_id,
        started_at=excluded.started_at,
        updated_at=excluded.updated_at,
        completed_at=null
    `).run({
            handle: input.processHandle,
            workspaceId: input.workspaceId,
            workspaceRoot: input.workspaceRoot,
            sessionId: input.sessionId ?? null,
            commandJson: input.argv ? JSON.stringify(input.argv) : null,
            shellCommand: input.cmd ?? null,
            cwd: input.cwd,
            envJson: input.env ? JSON.stringify(input.env) : null,
            tty: input.tty ? 1 : 0,
            persistent: input.persistent ? 1 : 0,
            pid: input.pid ?? null,
            ownerInstanceId: this.instanceId,
            startedAt: input.startedAt ?? now,
            updatedAt: now,
        });
        return this.get(input.processHandle);
    }
    markExited(processHandle, input = {}) {
        const now = new Date().toISOString();
        this.database.sqlite.prepare(`
      update process_registry
      set status=@status,
          exit_code=@exitCode,
          signal=@signal,
          updated_at=@updatedAt,
          completed_at=@completedAt
      where handle=@handle
    `).run({
            handle: processHandle,
            status: input.status ?? "exited",
            exitCode: input.exitCode ?? null,
            signal: input.signal ?? null,
            updatedAt: now,
            completedAt: now,
        });
    }
    markStatus(processHandle, status) {
        this.database.sqlite.prepare(`
      update process_registry
      set status=?, updated_at=?
      where handle=?
    `).run(status, new Date().toISOString(), processHandle);
    }
    get(processHandle) {
        const row = this.database.sqlite.prepare("select * from process_registry where handle = ?").get(processHandle);
        return row ? rowToRecord(row) : undefined;
    }
    list(input = {}) {
        const clauses = [];
        const params = {};
        if (input.workspaceId) {
            clauses.push("workspace_id = @workspaceId");
            params.workspaceId = input.workspaceId;
        }
        if (!input.includeCompleted) {
            clauses.push("status in ('running', 'detached-running')");
        }
        const where = clauses.length > 0 ? `where ${clauses.join(" and ")}` : "";
        const limit = Math.max(1, Math.min(Number(input.limit ?? 100), 1000));
        return this.database.sqlite.prepare(`
      select * from process_registry
      ${where}
      order by updated_at desc
      limit @limit
    `).all({ ...params, limit }).map(rowToRecord);
    }
    summary() {
        const rows = this.database.sqlite.prepare(`
      select status, count(*) as count
      from process_registry
      group by status
    `).all();
        return Object.fromEntries(rows.map((row) => [row.status, row.count]));
    }
    reconcilePreviousRuntime() {
        const candidates = this.database.sqlite.prepare(`
      select * from process_registry
      where status in ('running', 'detached-running', 'stopping')
      order by updated_at desc
    `).all().map(rowToRecord);
        const results = [];
        for (const record of candidates) {
            if (processExists(record.pid)) {
                this.markStatus(record.processHandle, "detached-running");
                results.push({ ...record, status: "detached-running", running: true, reattachable: false });
            }
            else {
                this.markExited(record.processHandle, { status: "lost", signal: "runtime-restart" });
                results.push({ ...record, status: "lost", running: false, reattachable: false });
            }
        }
        return results;
    }
    close() {
        this.database.close();
    }
}
