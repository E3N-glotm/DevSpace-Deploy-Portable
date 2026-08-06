import { randomUUID } from "node:crypto";
import { openDatabase } from "./db/client.js";
import { redactValue, redactedJson } from "./redaction.js";

function parseJson(value, fallback) {
    try {
        return JSON.parse(value);
    }
    catch {
        return fallback;
    }
}

export class StructuredRuntimeState {
    database;
    constructor(stateDir) {
        this.database = openDatabase(stateDir);
    }
    appendEvent(input) {
        const createdAt = new Date().toISOString();
        const result = this.database.sqlite.prepare(`
      insert into event_journal (kind, subject, workspace_id, payload_json, created_at)
      values (?, ?, ?, ?, ?)
    `).run(input.kind, input.subject ?? null, input.workspaceId ?? null, redactedJson(input.payload ?? {}), createdAt);
        return Number(result.lastInsertRowid);
    }
    pollEvents(input = {}) {
        const clauses = ["sequence > @afterSequence"];
        const params = { afterSequence: Math.max(0, Number(input.afterSequence ?? 0)) };
        if (input.kind) {
            clauses.push("kind = @kind");
            params.kind = input.kind;
        }
        if (input.subject) {
            clauses.push("subject = @subject");
            params.subject = input.subject;
        }
        if (input.workspaceId) {
            clauses.push("workspace_id = @workspaceId");
            params.workspaceId = input.workspaceId;
        }
        params.limit = Math.max(1, Math.min(Number(input.limit ?? 100), 1000));
        const rows = this.database.sqlite.prepare(`
      select * from event_journal
      where ${clauses.join(" and ")}
      order by sequence asc
      limit @limit
    `).all(params);
        const events = rows.map((row) => ({
            sequence: row.sequence,
            kind: row.kind,
            subject: row.subject ?? undefined,
            workspaceId: row.workspace_id ?? undefined,
            payload: parseJson(row.payload_json, {}),
            createdAt: row.created_at,
        }));
        return {
            events,
            nextSequence: events.length > 0 ? events[events.length - 1].sequence : params.afterSequence,
        };
    }
    recordToolCall(fields) {
        const safe = redactValue(fields);
        this.database.sqlite.prepare(`
      insert into structured_tool_calls (
        request_id, tool, workspace_id, process_handle, success,
        duration_ms, exit_code, signal, details_json, created_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(safe.requestId ?? null, safe.tool ?? "unknown", safe.workspaceId ?? null, safe.processHandle ?? null, safe.success ? 1 : 0, safe.durationMs ?? null, safe.exitCode ?? null, safe.signal ?? null, JSON.stringify(safe), new Date().toISOString());
    }
    listToolCalls(input = {}) {
        const clauses = [];
        const params = {};
        if (input.workspaceId) {
            clauses.push("workspace_id=@workspaceId");
            params.workspaceId = input.workspaceId;
        }
        if (input.tool) {
            clauses.push("tool=@tool");
            params.tool = input.tool;
        }
        if (input.success !== undefined) {
            clauses.push("success=@success");
            params.success = input.success ? 1 : 0;
        }
        params.limit = Math.max(1, Math.min(Number(input.limit ?? 100), 1000));
        const where = clauses.length ? `where ${clauses.join(" and ")}` : "";
        return this.database.sqlite.prepare(`
      select * from structured_tool_calls
      ${where}
      order by id desc
      limit @limit
    `).all(params).map((row) => ({
            id: row.id,
            requestId: row.request_id ?? undefined,
            tool: row.tool,
            workspaceId: row.workspace_id ?? undefined,
            processHandle: row.process_handle ?? undefined,
            success: Boolean(row.success),
            durationMs: row.duration_ms ?? undefined,
            exitCode: row.exit_code ?? undefined,
            signal: row.signal ?? undefined,
            details: parseJson(row.details_json, {}),
            createdAt: row.created_at,
        }));
    }
    recordDiagnostic(report) {
        const runId = `doctor_${randomUUID()}`;
        const suggestedFixes = report.suggestedFixes ?? [];
        const transaction = this.database.sqlite.transaction(() => {
            this.database.sqlite.prepare(`
        insert into diagnostic_runs (id, overall_status, summary_json, suggested_fixes_json, created_at)
        values (?, ?, ?, ?, ?)
      `).run(runId, report.overallStatus, redactedJson(report.summary), redactedJson(suggestedFixes), report.generatedAt);
            const insertCheck = this.database.sqlite.prepare(`
        insert into diagnostic_checks (
          run_id, check_id, category, status, summary, details_json, remediation
        ) values (?, ?, ?, ?, ?, ?, ?)
      `);
            for (const item of Object.values(report.checks)) {
                insertCheck.run(runId, item.id, item.category, item.status, item.summary, redactedJson(item.details ?? {}), item.remediation ?? null);
            }
        });
        transaction();
        return runId;
    }
    diagnosticHistory(input = {}) {
        const limit = Math.max(1, Math.min(Number(input.limit ?? 20), 200));
        const rows = this.database.sqlite.prepare(`
      select * from diagnostic_runs
      order by created_at desc
      limit ?
    `).all(limit);
        return rows.map((row) => ({
            id: row.id,
            overallStatus: row.overall_status,
            summary: parseJson(row.summary_json, {}),
            suggestedFixes: parseJson(row.suggested_fixes_json, []),
            createdAt: row.created_at,
        }));
    }
    upsertWatch(input) {
        const now = new Date().toISOString();
        this.database.sqlite.prepare(`
      insert into file_watches (watch_id, workspace_id, path, recursive, status, created_at, updated_at)
      values (?, ?, ?, ?, 'active', ?, ?)
      on conflict(watch_id) do update set
        workspace_id=excluded.workspace_id,
        path=excluded.path,
        recursive=excluded.recursive,
        status='active',
        updated_at=excluded.updated_at
    `).run(input.watchId, input.workspaceId, input.path, input.recursive === false ? 0 : 1, now, now);
    }
    stopWatch(watchId) {
        this.database.sqlite.prepare(`
      update file_watches set status='stopped', updated_at=? where watch_id=?
    `).run(new Date().toISOString(), watchId);
    }
    listWatches(input = {}) {
        const clauses = [];
        const params = {};
        if (input.workspaceId) {
            clauses.push("workspace_id=@workspaceId");
            params.workspaceId = input.workspaceId;
        }
        if (!input.includeStopped)
            clauses.push("status='active'");
        const where = clauses.length ? `where ${clauses.join(" and ")}` : "";
        return this.database.sqlite.prepare(`select * from file_watches ${where} order by updated_at desc`).all(params).map((row) => ({
            watchId: row.watch_id,
            workspaceId: row.workspace_id,
            path: row.path,
            recursive: Boolean(row.recursive),
            status: row.status,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        }));
    }
    close() {
        this.database.close();
    }
}
