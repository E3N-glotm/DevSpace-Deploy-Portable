import { randomUUID } from "node:crypto";
import { openDatabase } from "./db/client.js";
import { redactValue, redactedJson } from "./redaction.js";

const DEFAULT_TASK_CONTRACT_MILESTONES = [
    "Complete the original user-requested DevSpace work",
    "Run necessary verification and deliver completion evidence",
];
const TASK_CONTRACT_VERSION = 1;
const ANCHOR_LEASE_MS = 90_000;
const ANCHOR_REFRESH_AHEAD_MS = 30_000;
const COMPLETION_TURN_LEASE_MS = 3 * 60_000;
const CONFIRMED_LIMIT_RECOVERY_GRACE_MS = 20_000;
const CONFIRMED_LIMIT_MODEL_QUIET_MS = 30_000;
const AUTO_TASK_ABANDON_AFTER_MS = 24 * 60 * 60 * 1000;
const TERMINAL_CONTINUATION_STATES = new Set([
    "SUCCEEDED",
    "FAILED_TERMINAL",
    "CANCELLED_BY_USER",
    "ABORTED_NO_PROGRESS",
    "BUDGET_EXHAUSTED",
    "ABANDONED_AUTO_TASK",
]);

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
            conversationScopeId: row.conversation_scope_id,
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
    touchContinuationModelActivity(input = {}) {
        const workspaceId = String(input.workspaceId ?? "").trim();
        const conversationScopeId = String(input.conversationScopeId ?? "").trim();
        if (!workspaceId || !conversationScopeId)
            return undefined;
        const nowIso = new Date().toISOString();
        const row = this.database.sqlite.prepare(`
          select * from continuation_tasks
          where workspace_id=? and conversation_scope_id=?
            and state not in ('SUCCEEDED','FAILED_TERMINAL','CANCELLED_BY_USER','ABORTED_NO_PROGRESS','BUDGET_EXHAUSTED','ABANDONED_AUTO_TASK')
          order by updated_at desc limit 1
        `).get(workspaceId, conversationScopeId);
        if (!row)
            return undefined;
        const substantiveIncrement = input.substantive === false ? 0 : 1;
        const turnLeaseExpiresAt = new Date(Date.now() + COMPLETION_TURN_LEASE_MS).toISOString();
        this.database.sqlite.prepare(`
          update continuation_tasks
          set last_model_activity_at=?, last_activity_at=?,
              substantive_activity_count=coalesce(substantive_activity_count,0)+?,
              turn_lease_expires_at=case when continuation_mode='completion-driven' then ? else turn_lease_expires_at end,
              updated_at=?
          where id=?
        `).run(nowIso, nowIso, substantiveIncrement, turnLeaseExpiresAt, nowIso, row.id);
        return row.id;
    }
    reapAbandonedContinuationTasks(input = {}) {
        const now = Date.now();
        const cutoffIso = new Date(now - Math.max(60_000, Number(input.maxAgeMs ?? AUTO_TASK_ABANDON_AFTER_MS))).toISOString();
        const nowIso = new Date(now).toISOString();
        const result = this.database.sqlite.prepare(`
          update continuation_tasks
          set state='ABANDONED_AUTO_TASK', terminal_reason='stale-auto-task',
              continuation_pending=0, watch_process_handles_json='[]', updated_at=?
          where auto_created=1 and task_source='legacy-auto' and owner_locked=0 and state='RUNNING'
            and continuation_pending=0
            and coalesce(watch_process_handles_json,'[]')='[]'
            and coalesce(last_activity_at,updated_at,created_at) < ?
        `).run(nowIso, cutoffIso);
        return { abandoned: Number(result.changes || 0), cutoffAt: cutoffIso };
    }
    ensureContinuationTaskContract(input = {}) {
        const workspaceId = String(input.workspaceId ?? "").trim();
        const conversationScopeId = String(input.conversationScopeId ?? "").trim();
        if (!workspaceId || !conversationScopeId)
            return { task: undefined, created: false, accepted: false, reason: "workspace-and-conversation-required" };
        this.reapAbandonedContinuationTasks();
        const now = new Date();
        const nowIso = now.toISOString();
        const existing = this.database.sqlite.prepare(`
          select * from continuation_tasks
          where workspace_id=? and conversation_scope_id=?
            and state not in ('SUCCEEDED','FAILED_TERMINAL','CANCELLED_BY_USER','ABORTED_NO_PROGRESS','BUDGET_EXHAUSTED','ABANDONED_AUTO_TASK')
          order by updated_at desc limit 1
        `).get(workspaceId, conversationScopeId);
        if (existing) {
            if (input.substantive) {
                this.touchContinuationModelActivity({ workspaceId, conversationScopeId, substantive: true });
            }
            const status = this.continuationTask({ action: "status", taskId: existing.id, workspaceId, conversationScopeId });
            return { ...status, created: false, taskContract: true };
        }
        const required = Array.isArray(input.requiredMilestones)
            ? [...new Set(input.requiredMilestones.map((value) => String(value).trim()).filter(Boolean))].slice(0, 64)
            : [];
        const milestones = required.length > 0 ? required : DEFAULT_TASK_CONTRACT_MILESTONES;
        const id = `task_${randomUUID()}`;
        const sourceTool = String(input.sourceTool ?? "open_workspace").trim().slice(0, 120) || "open_workspace";
        const turnLeaseId = `turn_${randomUUID()}`;
        const turnLeaseExpiresAt = new Date(now.getTime() + COMPLETION_TURN_LEASE_MS).toISOString();
        this.database.sqlite.prepare(`
          insert into continuation_tasks (
            id, conversation_scope_id, workspace_id, objective, state, continuation_mode,
            required_milestones_json, completed_milestones_json, evidence_json,
            max_continuations, max_no_progress, max_same_failure, deadline_at,
            turn_started_at, last_activity_at, last_model_activity_at,
            task_source, source_tool, contract_version, auto_created,
            substantive_activity_count, turn_lease_id, turn_lease_expires_at, created_at, updated_at
          ) values (?, ?, ?, ?, 'RUNNING', 'completion-driven', ?, '[]', '{}',
            0, ?, ?, null, ?, ?, ?, 'auto-conversation', ?, ?, 1, ?, ?, ?, ?, ?)
        `).run(id, conversationScopeId, workspaceId,
            String(input.objective ?? "Complete the original user-requested DevSpace work and verify the result before ending the task."),
            JSON.stringify(milestones),
            Math.max(1, Math.min(Number(input.maxNoProgress ?? 3), 20)),
            Math.max(1, Math.min(Number(input.maxSameFailure ?? 3), 20)),
            nowIso, nowIso, nowIso, sourceTool, TASK_CONTRACT_VERSION,
            input.substantive ? 1 : 0, turnLeaseId, turnLeaseExpiresAt, nowIso, nowIso);
        const status = this.continuationTask({ action: "status", taskId: id, workspaceId, conversationScopeId });
        return { ...status, created: true, taskContract: true, needsRefinement: required.length === 0 };
    }
    continuationSupervisorDirective(input = {}) {
        const workspaceId = String(input.workspaceId ?? "").trim();
        const conversationScopeId = String(input.conversationScopeId ?? "").trim();
        if (!workspaceId || !conversationScopeId)
            return undefined;
        const row = this.database.sqlite.prepare(`
          select * from continuation_tasks
          where workspace_id=? and conversation_scope_id=?
            and state not in ('SUCCEEDED','FAILED_TERMINAL','CANCELLED_BY_USER','ABORTED_NO_PROGRESS','BUDGET_EXHAUSTED','ABANDONED_AUTO_TASK')
          order by updated_at desc limit 1
        `).get(workspaceId, conversationScopeId);
        if (!row)
            return undefined;
        const rawMode = String(row.continuation_mode ?? "compat").trim().toLowerCase();
        const continuationMode = rawMode === "resident"
            ? "resident"
            : rawMode === "completion-driven"
                ? "completion-driven"
            : rawMode === "timeout-recovery" || rawMode === "explicit-long"
                ? "timeout-recovery"
                : "compat";
        if (continuationMode === "compat" || row.state === "PAUSED_BY_USER")
            return undefined;
        const required = parseJson(row.required_milestones_json, []);
        const completed = new Set(parseJson(row.completed_milestones_json, []));
        const unfinished = required.length > 0 && required.some((milestone) => !completed.has(milestone));
        const watchedHandles = parseJson(row.watch_process_handles_json, []);
        const activeTurnNeedsSupervisor = row.state === "RUNNING" && unfinished;
        const residentWaitNeedsSupervisor = continuationMode === "resident"
            && ["WAITING_EXTERNAL", "WAITING_SUPERVISOR"].includes(row.state)
            && watchedHandles.length > 0;
        if (!activeTurnNeedsSupervisor && !residentWaitNeedsSupervisor)
            return undefined;
        const heartbeatAt = row.last_ui_heartbeat_at ? Date.parse(row.last_ui_heartbeat_at) : NaN;
        const supervisorHeartbeatAgeMs = Number.isFinite(heartbeatAt)
            ? Math.max(0, Date.now() - heartbeatAt)
            : Number.POSITIVE_INFINITY;
        const staleAfterMs = 45_000;
        const anchorLeaseExpiresAt = row.anchor_lease_expires_at ? Date.parse(row.anchor_lease_expires_at) : NaN;
        const anchorLeaseRemainingMs = Number.isFinite(anchorLeaseExpiresAt)
            ? anchorLeaseExpiresAt - Date.now()
            : Number.NEGATIVE_INFINITY;
        const heartbeatStale = supervisorHeartbeatAgeMs > staleAfterMs;
        const leaseNeedsRefresh = anchorLeaseRemainingMs <= ANCHOR_REFRESH_AHEAD_MS;
        if (!heartbeatStale && !leaseNeedsRefresh)
            return undefined;
        return {
            taskId: row.id,
            workspaceId: row.workspace_id ?? workspaceId,
            continuationMode,
            reanchorRequired: true,
            supervisorHeartbeatAgeMs: Number.isFinite(supervisorHeartbeatAgeMs) ? supervisorHeartbeatAgeMs : undefined,
            staleAfterMs,
            anchorLeaseRemainingMs: Number.isFinite(anchorLeaseRemainingMs) ? anchorLeaseRemainingMs : undefined,
            reason: heartbeatStale
                ? (residentWaitNeedsSupervisor ? "resident-supervisor-stale" : "active-turn-supervisor-stale")
                : "anchor-lease-refresh-required",
        };
    }
    continuationTask(input = {}) {
        const action = String(input.action ?? "status");
        const now = new Date();
        const nowIso = now.toISOString();
        const terminalStates = TERMINAL_CONTINUATION_STATES;
        const normalizedMode = (value, fallback = "compat") => {
            const mode = String(value ?? "").trim().toLowerCase();
            if (mode === "resident") return "resident";
            if (mode === "completion-driven") return "completion-driven";
            if (mode === "timeout-recovery" || mode === "explicit-long") return "timeout-recovery";
            return fallback;
        };
        const normalizeContinuationLimit = (value, fallback = 0) => {
            if (value === undefined || value === null || value === "") return Math.max(0, Number(fallback || 0));
            const numeric = Number(value);
            if (!Number.isFinite(numeric) || numeric <= 0) return 0;
            return Math.max(1, Math.min(Math.round(numeric), 100));
        };
        const normalizeWallClockMinutes = (value) => {
            if (value === undefined || value === null || value === "") return undefined;
            const numeric = Number(value);
            if (!Number.isFinite(numeric) || numeric <= 0) return 0;
            return Math.max(10, Math.min(Math.round(numeric), 24 * 60));
        };
        const completionTurnLeaseExpiresAt = () => new Date(now.getTime() + COMPLETION_TURN_LEASE_MS).toISOString();
        const rowToTask = (row) => row ? ({
            id: row.id,
            conversationScopeId: row.conversation_scope_id ?? undefined,
            workspaceId: row.workspace_id ?? undefined,
            objective: row.objective,
            state: row.state,
            continuationMode: normalizedMode(row.continuation_mode, "compat"),
            requiredMilestones: parseJson(row.required_milestones_json, []),
            completedMilestones: parseJson(row.completed_milestones_json, []),
            evidence: parseJson(row.evidence_json, {}),
            progressFingerprint: row.progress_fingerprint ?? undefined,
            failureFingerprint: row.failure_fingerprint ?? undefined,
            continuationCount: row.continuation_count,
            noProgressCount: row.no_progress_count,
            sameFailureCount: row.same_failure_count,
            maxContinuations: row.max_continuations,
            maxNoProgress: row.max_no_progress,
            maxSameFailure: row.max_same_failure,
            continuationPending: [1, 3, 4, 5].includes(Number(row.continuation_pending)),
            continuationWakePending: [2, 3, 4].includes(Number(row.continuation_pending)),
            continuationDeliveryAwaitingAck: [4, 5].includes(Number(row.continuation_pending)),
            ownerLocked: Boolean(row.owner_locked),
            ownerLockedAt: row.owner_locked_at ?? undefined,
            ownerControlNote: row.owner_control_note ?? undefined,
            waitingReason: row.waiting_reason ?? undefined,
            terminalReason: row.terminal_reason ?? undefined,
            deadlineAt: row.deadline_at ?? undefined,
            turnStartedAt: row.turn_started_at ?? undefined,
            lastContinuationAt: row.last_continuation_at ?? undefined,
            lastActivityAt: row.last_activity_at ?? undefined,
            lastModelActivityAt: row.last_model_activity_at ?? undefined,
            lastUiHeartbeatAt: row.last_ui_heartbeat_at ?? undefined,
            lastSendAttemptAt: row.last_send_attempt_at ?? undefined,
            lastSendResult: row.last_send_result ? parseJson(row.last_send_result, row.last_send_result) : undefined,
            coordinatorInstanceId: row.coordinator_instance_id ?? undefined,
            hostProfileId: row.host_profile_id ?? undefined,
            observedTurnBudgetMs: row.observed_turn_budget_ms ?? undefined,
            recommendedContinueAfterMs: row.recommended_continue_after_ms ?? undefined,
            hostTimeoutSamples: row.host_timeout_samples ?? 0,
            confirmedTurnLimitMs: row.confirmed_turn_limit_ms ?? undefined,
            confirmedTurnLimitAt: row.confirmed_turn_limit_at ?? undefined,
            confirmedTurnLimitSource: row.confirmed_turn_limit_source ?? undefined,
            lastHostSignal: row.last_host_signal ?? undefined,
            lastHostSignalAt: row.last_host_signal_at ?? undefined,
            watchProcessHandles: parseJson(row.watch_process_handles_json, []),
            taskSource: row.task_source ?? "legacy",
            sourceTool: row.source_tool ?? undefined,
            contractVersion: Number(row.contract_version ?? 0),
            autoCreated: Boolean(row.auto_created),
            contractNeedsRefinement: row.task_source === "auto-conversation"
                && JSON.stringify(parseJson(row.required_milestones_json, [])) === JSON.stringify(DEFAULT_TASK_CONTRACT_MILESTONES),
            substantiveActivityCount: Number(row.substantive_activity_count ?? 0),
            turnLeaseId: row.turn_lease_id ?? undefined,
            turnLeaseExpiresAt: row.turn_lease_expires_at ?? undefined,
            lastAnchorMountedAt: row.last_anchor_mounted_at ?? undefined,
            anchorLeaseExpiresAt: row.anchor_lease_expires_at ?? undefined,
            unlimitedContinuations: Number(row.max_continuations || 0) <= 0,
            unlimitedWallClock: !row.deadline_at,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        }) : undefined;
        const taskNeedsCurrentTurnSupervisor = (row, task = rowToTask(row)) => {
            if (!row || !task || task.state !== "RUNNING" || task.continuationMode === "compat") return false;
            const required = Array.isArray(task.requiredMilestones) ? task.requiredMilestones : [];
            if (required.length === 0) return false;
            const completed = new Set(Array.isArray(task.completedMilestones) ? task.completedMilestones : []);
            if (!required.some((milestone) => !completed.has(milestone))) return false;
            const heartbeatAt = row.last_ui_heartbeat_at ? Date.parse(row.last_ui_heartbeat_at) : NaN;
            const leaseExpiresAt = row.anchor_lease_expires_at ? Date.parse(row.anchor_lease_expires_at) : NaN;
            // Coordinator status polling normally refreshes this about every
            // 15 seconds. A 45-second gap is therefore strong evidence that the
            // previous Workspace App iframe is no longer supervising this turn.
            return !Number.isFinite(heartbeatAt)
                || now.getTime() - heartbeatAt > 45_000
                || !Number.isFinite(leaseExpiresAt)
                || leaseExpiresAt - now.getTime() <= ANCHOR_REFRESH_AHEAD_MS;
        };
        const continuationDirective = (task) => {
            if (!task) return {
                continueRequired: false,
                nextRequiredMilestones: [],
                taskIncomplete: false,
                remainingMilestones: [],
                finalResponseAllowed: true,
            };
            const required = Array.isArray(task.requiredMilestones) ? task.requiredMilestones : [];
            const completed = new Set(Array.isArray(task.completedMilestones) ? task.completedMilestones : []);
            const remainingMilestones = required.filter((milestone) => !completed.has(milestone));
            const taskIncomplete = remainingMilestones.length > 0 && !terminalStates.has(task.state);
            const blocked = ["WAITING_EXTERNAL", "WAITING_SUPERVISOR", "PAUSED_BY_USER"].includes(task.state);
            const continueRequired = taskIncomplete && task.state === "RUNNING" && task.continuationMode !== "compat";
            return {
                continueRequired,
                nextRequiredMilestones: continueRequired ? remainingMilestones : [],
                taskIncomplete,
                remainingMilestones,
                finalResponseAllowed: !taskIncomplete || blocked,
            };
        };
        const find = () => {
            if (input.taskId) {
                const taskId = String(input.taskId);
                const conversationScopeId = input.conversationScopeId ? String(input.conversationScopeId) : undefined;
                const workspaceId = input.workspaceId ? String(input.workspaceId) : undefined;
                if (conversationScopeId && workspaceId) {
                    return this.database.sqlite.prepare("select * from continuation_tasks where id=? and conversation_scope_id=? and workspace_id=?")
                        .get(taskId, conversationScopeId, workspaceId);
                }
                if (conversationScopeId) {
                    return this.database.sqlite.prepare("select * from continuation_tasks where id=? and conversation_scope_id=?")
                        .get(taskId, conversationScopeId);
                }
                if (workspaceId) {
                    return this.database.sqlite.prepare("select * from continuation_tasks where id=? and workspace_id=?")
                        .get(taskId, workspaceId);
                }
                return this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(taskId);
            }
            if (input.workspaceId && input.conversationScopeId) {
                return this.database.sqlite.prepare(`
                  select * from continuation_tasks
                  where workspace_id=? and conversation_scope_id=?
                    and state not in ('SUCCEEDED','FAILED_TERMINAL','CANCELLED_BY_USER','ABORTED_NO_PROGRESS','BUDGET_EXHAUSTED','ABANDONED_AUTO_TASK')
                  order by updated_at desc limit 1
                `).get(String(input.workspaceId), String(input.conversationScopeId));
            }
            return undefined;
        };
        if (action === "status") {
            const row = find();
            // The Workspace App supervisor already polls status on every
            // supervisor tick. Treat a status request carrying a coordinator id
            // as authoritative UI liveness instead of requiring the separate
            // one-minute heartbeat timer to beat a shorter freshness gate.
            // Model-originated status calls do not carry coordinatorInstanceId.
            // In completion-driven mode they prove the resumed/current model is
            // alive, so renew the model Turn Lease without touching UI liveness.
            if (row && input.coordinatorInstanceId) {
                const watchedHandles = parseJson(row.watch_process_handles_json, []);
                const acknowledgedState = row.state === "WAITING_SUPERVISOR" && watchedHandles.length > 0
                    ? "WAITING_EXTERNAL"
                    : row.state;
                const coordinatorInstanceId = String(input.coordinatorInstanceId);
                const newlyMounted = !row.coordinator_instance_id || row.coordinator_instance_id !== coordinatorInstanceId;
                const lastAnchorMountedAt = newlyMounted ? nowIso : (row.last_anchor_mounted_at ?? nowIso);
                const anchorLeaseExpiresAt = new Date(now.getTime() + ANCHOR_LEASE_MS).toISOString();
                this.database.sqlite.prepare(`
                  update continuation_tasks set state=?, last_activity_at=?, last_ui_heartbeat_at=?,
                    coordinator_instance_id=?, last_anchor_mounted_at=?, anchor_lease_expires_at=?, updated_at=? where id=?
                `).run(acknowledgedState, nowIso, nowIso, coordinatorInstanceId,
                    lastAnchorMountedAt, anchorLeaseExpiresAt, nowIso, row.id);
                return { task: rowToTask(this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(row.id)) };
            }
            // A wake-driven app.sendMessage is only transport-level acceptance.
            // The resumed model must prove that the new turn can actually reach
            // DevSpace before the durable wake is retired. continuationText asks
            // the resumed turn to make this exact status call first. If the host
            // creates the turn but its first MCP connection fails, states 4/5
            // stay retryable and a surviving Workspace App can resend after the
            // delivery ACK lease. State 4 is backed by a durable process wake;
            // state 5 is a proactive/host-lifecycle continuation.
            if (row && [4, 5].includes(Number(row.continuation_pending))) {
                const turnLeaseId = `turn_${randomUUID()}`;
                const turnLeaseExpiresAt = normalizedMode(row.continuation_mode, "compat") === "completion-driven"
                    ? completionTurnLeaseExpiresAt()
                    : row.turn_lease_expires_at;
                this.database.sqlite.prepare(`
                  update continuation_tasks set continuation_pending=0,
                    turn_started_at=?, last_model_activity_at=?, last_activity_at=?,
                    turn_lease_id=?, turn_lease_expires_at=?,
                    last_host_signal='connected', last_host_signal_at=?, updated_at=? where id=?
                `).run(nowIso, nowIso, nowIso, turnLeaseId, turnLeaseExpiresAt, nowIso, nowIso, row.id);
                const refreshedTask = rowToTask(this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(row.id));
                const required = Array.isArray(refreshedTask?.requiredMilestones) ? refreshedTask.requiredMilestones : [];
                const completed = new Set(Array.isArray(refreshedTask?.completedMilestones) ? refreshedTask.completedMilestones : []);
                const reanchorRequired = refreshedTask?.state === "RUNNING"
                    && refreshedTask?.continuationMode !== "compat"
                    && required.length > 0
                    && required.some((milestone) => !completed.has(milestone));
                return {
                    task: refreshedTask,
                    accepted: true,
                    reason: "continuation-resume-acknowledged",
                    reanchorRequired,
                    ...continuationDirective(refreshedTask),
                };
            }
            let statusRow = row;
            if (row && normalizedMode(row.continuation_mode, "compat") === "completion-driven") {
                this.database.sqlite.prepare(`
                  update continuation_tasks set last_model_activity_at=?, last_activity_at=?,
                    turn_lease_expires_at=?, updated_at=? where id=?
                `).run(nowIso, nowIso, completionTurnLeaseExpiresAt(), nowIso, row.id);
                statusRow = this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(row.id);
            }
            const task = rowToTask(statusRow);
            return {
                task,
                ...continuationDirective(task),
                ...(taskNeedsCurrentTurnSupervisor(statusRow, task) ? { reanchorRequired: true } : {}),
            };
        }
        if (action === "begin" || action === "begin-auto") {
            let existing = find();
            if (existing && existing.deadline_at && Date.parse(existing.deadline_at) <= now.getTime()) {
                if (existing.owner_locked) {
                    this.database.sqlite.prepare("update continuation_tasks set waiting_reason='Owner lock prevented automatic wall-clock termination.', owner_control_note='wall-clock-budget-reached-while-locked', updated_at=? where id=?")
                        .run(nowIso, existing.id);
                }
                else {
                    this.database.sqlite.prepare("update continuation_tasks set state='BUDGET_EXHAUSTED', terminal_reason='wall-clock-budget', continuation_pending=0, updated_at=? where id=?")
                        .run(nowIso, existing.id);
                    existing = undefined;
                }
            }
            if (existing && !terminalStates.has(existing.state)) {
                if (action === "begin") {
                    const suppliedRequired = [...new Set((Array.isArray(input.requiredMilestones) ? input.requiredMilestones : [])
                        .map((value) => String(value).trim()).filter(Boolean))].slice(0, 64);
                    const existingRequired = parseJson(existing.required_milestones_json, []);
                    const canRefineFallback = Boolean(existing.auto_created)
                        && Number(existing.contract_version || 0) >= TASK_CONTRACT_VERSION
                        && suppliedRequired.length > 0
                        && existingRequired.length === DEFAULT_TASK_CONTRACT_MILESTONES.length
                        && existingRequired.every((value, index) => value === DEFAULT_TASK_CONTRACT_MILESTONES[index])
                        && parseJson(existing.completed_milestones_json, []).length === 0;
                    const currentRequired = new Set(canRefineFallback ? [] : existingRequired);
                    for (const value of suppliedRequired) {
                        const item = String(value).trim();
                        if (item) currentRequired.add(item);
                    }
                    if (currentRequired.size === 0) {
                        for (const value of DEFAULT_TASK_CONTRACT_MILESTONES) currentRequired.add(value);
                    }
                    const objective = String(input.objective ?? existing.objective).trim() || existing.objective;
                    const requestedWallClockMinutes = normalizeWallClockMinutes(input.wallClockMinutes);
                    const requestedDeadlineAt = requestedWallClockMinutes === undefined
                        ? existing.deadline_at
                        : requestedWallClockMinutes === 0
                            ? null
                            : new Date(now.getTime() + requestedWallClockMinutes * 60_000).toISOString();
                    const deadlineAt = existing.deadline_at && requestedDeadlineAt
                        ? new Date(Math.max(Date.parse(existing.deadline_at), Date.parse(requestedDeadlineAt))).toISOString()
                        : requestedDeadlineAt === null ? null : requestedDeadlineAt ?? existing.deadline_at;
                    const currentMode = normalizedMode(existing.continuation_mode, "compat");
                    const requestedMode = input.continuationMode === undefined
                        ? (currentMode === "compat" ? "completion-driven" : currentMode)
                        : normalizedMode(input.continuationMode, "completion-driven");
                    const taskSource = existing.auto_created ? "model-refined" : (existing.task_source || "explicit-anchor");
                    const sourceTool = String(input.sourceTool ?? "continuation_anchor").trim().slice(0, 120) || "continuation_anchor";
                    const turnLeaseId = existing.turn_lease_id || `turn_${randomUUID()}`;
                    const turnLeaseExpiresAt = requestedMode === "completion-driven"
                        ? completionTurnLeaseExpiresAt()
                        : existing.turn_lease_expires_at;
                    const maxContinuations = input.maxContinuations === undefined
                        ? normalizeContinuationLimit(existing.max_continuations, 0)
                        : normalizeContinuationLimit(input.maxContinuations, 0);
                    this.database.sqlite.prepare(`
                      update continuation_tasks set objective=?, required_milestones_json=?,
                        continuation_mode=?, max_continuations=?, max_no_progress=?, max_same_failure=?, deadline_at=?,
                        task_source=?, source_tool=?, contract_version=?, turn_lease_id=?, turn_lease_expires_at=?,
                        last_model_activity_at=?, last_activity_at=?, updated_at=? where id=?
                    `).run(objective, JSON.stringify([...currentRequired].slice(0, 64)), requestedMode,
                        maxContinuations,
                        Math.max(1, Math.min(Number(input.maxNoProgress ?? existing.max_no_progress), 20)),
                        Math.max(1, Math.min(Number(input.maxSameFailure ?? existing.max_same_failure), 20)), deadlineAt,
                        taskSource, sourceTool, Math.max(Number(existing.contract_version || 0), TASK_CONTRACT_VERSION),
                        turnLeaseId, turnLeaseExpiresAt, nowIso, nowIso, nowIso, existing.id);
                    const task = rowToTask(this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(existing.id));
                    return { task, created: false, upgraded: true, ...continuationDirective(task) };
                }
                const task = rowToTask(existing);
                return { task, created: false, ...continuationDirective(task) };
            }
            const id = `task_${randomUUID()}`;
            const suppliedRequired = Array.isArray(input.requiredMilestones)
                ? [...new Set(input.requiredMilestones.map((value) => String(value).trim()).filter(Boolean))].slice(0, 64)
                : [];
            const required = suppliedRequired.length > 0 ? suppliedRequired : DEFAULT_TASK_CONTRACT_MILESTONES;
            const maxContinuations = normalizeContinuationLimit(input.maxContinuations, 0);
            const maxNoProgress = Math.max(1, Math.min(Number(input.maxNoProgress ?? 2), 20));
            const maxSameFailure = Math.max(1, Math.min(Number(input.maxSameFailure ?? 2), 20));
            const wallClockMinutes = normalizeWallClockMinutes(input.wallClockMinutes);
            const deadlineAt = !wallClockMinutes ? null : new Date(now.getTime() + wallClockMinutes * 60_000).toISOString();
            const mode = normalizedMode(input.continuationMode, "completion-driven");
            const taskSource = action === "begin-auto" ? "auto-conversation" : "explicit-anchor";
            const sourceTool = String(input.sourceTool ?? (action === "begin-auto" ? "compatibility-fallback" : "continuation_anchor")).trim().slice(0, 120);
            const turnLeaseId = `turn_${randomUUID()}`;
            const turnLeaseExpiresAt = mode === "completion-driven" ? completionTurnLeaseExpiresAt() : null;
            this.database.sqlite.prepare(`
              insert into continuation_tasks (
                id, conversation_scope_id, workspace_id, objective, state, continuation_mode, required_milestones_json,
                completed_milestones_json, evidence_json, max_continuations,
                max_no_progress, max_same_failure, deadline_at, turn_started_at, last_activity_at,
                last_model_activity_at, task_source, source_tool, contract_version, auto_created,
                substantive_activity_count, turn_lease_id, turn_lease_expires_at, created_at, updated_at
              ) values (?, ?, ?, ?, 'RUNNING', ?, ?, '[]', '{}', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(id, String(input.conversationScopeId || "unknown"), input.workspaceId ? String(input.workspaceId) : null,
                String(input.objective ?? "Continue the current DevSpace task until the original user goal is verified complete."),
                mode, JSON.stringify(required), maxContinuations, maxNoProgress, maxSameFailure, deadlineAt,
                nowIso, nowIso, nowIso, taskSource, sourceTool, TASK_CONTRACT_VERSION,
                action === "begin-auto" ? 1 : 0, 0, turnLeaseId, turnLeaseExpiresAt, nowIso, nowIso);
            const task = rowToTask(this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(id));
            return { task, created: true, ...continuationDirective(task) };
        }
        const row = find();
        if (!row) return { task: undefined, accepted: false, reason: "task-not-found" };
        if (terminalStates.has(row.state) && !["status"].includes(action)) {
            return { task: rowToTask(row), accepted: false, reason: "task-terminal" };
        }
        const taskId = row.id;
        if (action === "heartbeat") {
            const coordinatorInstanceId = input.coordinatorInstanceId ? String(input.coordinatorInstanceId) : row.coordinator_instance_id;
            const newlyMounted = coordinatorInstanceId && coordinatorInstanceId !== row.coordinator_instance_id;
            const lastAnchorMountedAt = newlyMounted ? nowIso : (row.last_anchor_mounted_at ?? (coordinatorInstanceId ? nowIso : null));
            const anchorLeaseExpiresAt = coordinatorInstanceId ? new Date(now.getTime() + ANCHOR_LEASE_MS).toISOString() : row.anchor_lease_expires_at;
            this.database.sqlite.prepare(`
              update continuation_tasks set last_activity_at=?, last_ui_heartbeat_at=?, coordinator_instance_id=?,
                last_anchor_mounted_at=?, anchor_lease_expires_at=?, updated_at=?
              where id=?
            `).run(nowIso, nowIso, coordinatorInstanceId, lastAnchorMountedAt, anchorLeaseExpiresAt, nowIso, taskId);
            return { task: rowToTask(this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(taskId)), accepted: true };
        }
        if (action === "host-signal") {
            const hostProfileId = String(input.hostProfileId ?? row.host_profile_id ?? "unknown-host").trim().slice(0, 160) || "unknown-host";
            const hostSignal = String(input.hostSignal ?? "unknown").trim().slice(0, 80) || "unknown";
            const elapsedRaw = Number(input.elapsedMs ?? 0);
            const elapsedMs = Number.isFinite(elapsedRaw) ? Math.max(0, Math.min(Math.round(elapsedRaw), 24 * 60 * 60 * 1000)) : 0;
            const profile = this.database.sqlite.prepare("select * from continuation_host_profiles where id=?").get(hostProfileId);
            let observedTurnBudgetMs = profile?.observed_turn_budget_ms ?? row.observed_turn_budget_ms ?? null;
            let recommendedContinueAfterMs = profile?.recommended_continue_after_ms ?? row.recommended_continue_after_ms ?? null;
            let timeoutSamples = Number(profile?.timeout_samples ?? row.host_timeout_samples ?? 0);
            let confirmedTurnLimitMs = profile?.confirmed_turn_limit_ms ?? row.confirmed_turn_limit_ms ?? null;
            let confirmedTurnLimitAt = profile?.confirmed_turn_limit_at ?? row.confirmed_turn_limit_at ?? null;
            let confirmedTurnLimitSource = profile?.confirmed_turn_limit_source ?? row.confirmed_turn_limit_source ?? null;
            if (hostSignal === "timeout" && elapsedMs >= 1000) {
                if (!observedTurnBudgetMs) {
                    observedTurnBudgetMs = elapsedMs;
                }
                else if (elapsedMs < observedTurnBudgetMs) {
                    // Adapt downward immediately when the host shortens its turn budget.
                    observedTurnBudgetMs = Math.round(elapsedMs * 0.9 + observedTurnBudgetMs * 0.1);
                }
                else {
                    // Adapt upward slowly; a conservative learned budget is safer than
                    // assuming a transient long turn means the host limit increased.
                    observedTurnBudgetMs = Math.round(observedTurnBudgetMs * 0.9 + elapsedMs * 0.1);
                }
                recommendedContinueAfterMs = Math.max(1000, Math.floor(observedTurnBudgetMs * 0.88));
                timeoutSamples += 1;
                if (elapsedMs >= Number(confirmedTurnLimitMs || 0)) {
                    confirmedTurnLimitMs = elapsedMs;
                    confirmedTurnLimitAt = nowIso;
                    confirmedTurnLimitSource = "host-timeout";
                }
            }
            if (profile) {
                this.database.sqlite.prepare(`
                  update continuation_host_profiles set observed_turn_budget_ms=?, recommended_continue_after_ms=?,
                    timeout_samples=?, last_timeout_at=?, last_signal=?, last_signal_at=?,
                    confirmed_turn_limit_ms=?, confirmed_turn_limit_at=?, confirmed_turn_limit_source=?, updated_at=? where id=?
                `).run(observedTurnBudgetMs, recommendedContinueAfterMs, timeoutSamples,
                    hostSignal === "timeout" ? nowIso : profile.last_timeout_at,
                    hostSignal, nowIso, confirmedTurnLimitMs, confirmedTurnLimitAt, confirmedTurnLimitSource, nowIso, hostProfileId);
            }
            else {
                this.database.sqlite.prepare(`
                  insert into continuation_host_profiles (
                    id, observed_turn_budget_ms, recommended_continue_after_ms, timeout_samples,
                    last_timeout_at, last_signal, last_signal_at,
                    confirmed_turn_limit_ms, confirmed_turn_limit_at, confirmed_turn_limit_source,
                    created_at, updated_at
                  ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `).run(hostProfileId, observedTurnBudgetMs, recommendedContinueAfterMs, timeoutSamples,
                    hostSignal === "timeout" ? nowIso : null, hostSignal, nowIso,
                    confirmedTurnLimitMs, confirmedTurnLimitAt, confirmedTurnLimitSource, nowIso, nowIso);
            }
            this.database.sqlite.prepare(`
              update continuation_tasks set host_profile_id=?, observed_turn_budget_ms=?, recommended_continue_after_ms=?,
                host_timeout_samples=?, confirmed_turn_limit_ms=?, confirmed_turn_limit_at=?, confirmed_turn_limit_source=?,
                last_host_signal=?, last_host_signal_at=?, coordinator_instance_id=?, updated_at=?
              where id=?
            `).run(hostProfileId, observedTurnBudgetMs, recommendedContinueAfterMs, timeoutSamples,
                confirmedTurnLimitMs, confirmedTurnLimitAt, confirmedTurnLimitSource,
                hostSignal, nowIso, input.coordinatorInstanceId ? String(input.coordinatorInstanceId) : row.coordinator_instance_id,
                nowIso, taskId);
            return { task: rowToTask(this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(taskId)), accepted: true };
        }
        if (action === "confirm-turn-limit") {
            if (normalizedMode(row.continuation_mode, "compat") === "compat") {
                return { task: rowToTask(row), accepted: false, reason: "continuation-mode-required" };
            }
            const elapsedRaw = Number(input.elapsedMs ?? 0);
            const confirmedTurnLimitMs = Number.isFinite(elapsedRaw)
                ? Math.max(0, Math.min(Math.round(elapsedRaw), 24 * 60 * 60 * 1000))
                : 0;
            if (confirmedTurnLimitMs < 30_000) {
                return { task: rowToTask(row), accepted: false, reason: "confirmed-turn-limit-too-small" };
            }
            const source = String(input.note ?? "owner-confirmed").trim().slice(0, 160) || "owner-confirmed";
            this.database.sqlite.prepare(`
              update continuation_tasks set confirmed_turn_limit_ms=?, confirmed_turn_limit_at=?,
                confirmed_turn_limit_source=?, last_activity_at=?, updated_at=? where id=?
            `).run(confirmedTurnLimitMs, nowIso, source, nowIso, nowIso, taskId);
            const hostProfileId = String(row.host_profile_id ?? "").trim();
            if (hostProfileId) {
                const profile = this.database.sqlite.prepare("select id from continuation_host_profiles where id=?").get(hostProfileId);
                if (profile) {
                    this.database.sqlite.prepare(`
                      update continuation_host_profiles set confirmed_turn_limit_ms=?, confirmed_turn_limit_at=?,
                        confirmed_turn_limit_source=?, updated_at=? where id=?
                    `).run(confirmedTurnLimitMs, nowIso, source, nowIso, hostProfileId);
                }
            }
            return {
                task: rowToTask(this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(taskId)),
                accepted: true,
                reason: "confirmed-turn-limit-recorded",
            };
        }
        if (action === "watch-process" || action === "unwatch-process") {
            const handle = String(input.processHandle ?? "").trim();
            if (!handle) return { task: rowToTask(row), accepted: false, reason: "process-handle-required" };
            if (action === "watch-process" && normalizedMode(row.continuation_mode, "compat") !== "resident") {
                return { task: rowToTask(row), accepted: false, reason: "resident-mode-required" };
            }
            const handles = new Set(parseJson(row.watch_process_handles_json, []));
            if (action === "watch-process") handles.add(handle);
            else handles.delete(handle);
            this.database.sqlite.prepare(`
              update continuation_tasks set watch_process_handles_json=?, last_activity_at=?, updated_at=? where id=?
            `).run(JSON.stringify([...handles].slice(0, 64)), nowIso, nowIso, taskId);
            return { task: rowToTask(this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(taskId)), accepted: true };
        }
        if (action === "delivery-result") {
            const delivery = {
                result: String(input.deliveryResult ?? "unknown"),
                method: input.deliveryMethod ? String(input.deliveryMethod) : undefined,
                note: input.note ? String(input.note).slice(0, 1000) : undefined,
            };
            const delivered = delivery.result === "accepted" || delivery.result === "fallback-accepted";
            const pendingState = Number(row.continuation_pending || 0);
            // State 4 means the host accepted a wake-driven follow-up message,
            // but the resumed model has not yet acknowledged that it can reach
            // DevSpace. Keep the wake durable until that model-side status ACK.
            const nextPending = delivered
                ? (pendingState === 3 ? 4 : pendingState === 1 ? 5 : 0)
                : pendingState;
            this.database.sqlite.prepare(`
              update continuation_tasks set last_send_attempt_at=?, last_send_result=?, coordinator_instance_id=?,
                continuation_pending=?, updated_at=?
              where id=?
            `).run(nowIso, JSON.stringify(delivery), input.coordinatorInstanceId ? String(input.coordinatorInstanceId) : row.coordinator_instance_id,
                nextPending, nowIso, taskId);
            return { task: rowToTask(this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(taskId)), accepted: true };
        }
        if (action === "arm-wake") {
            if (row.state === "PAUSED_BY_USER") {
                return { task: rowToTask(row), accepted: false, reason: "task-paused-by-user" };
            }
            if (normalizedMode(row.continuation_mode, "compat") !== "resident") {
                return { task: rowToTask(row), accepted: false, reason: "resident-mode-required" };
            }
            this.database.sqlite.prepare(`
              update continuation_tasks set state='RUNNING', waiting_reason=null,
                continuation_pending=case when continuation_pending in (1,4) then continuation_pending else 2 end,
                turn_started_at=?, last_activity_at=?, updated_at=? where id=?
            `).run(nowIso, nowIso, nowIso, taskId);
            return { task: rowToTask(this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(taskId)), accepted: true };
        }
        if (action === "stage-complete") {
            if (row.state === "PAUSED_BY_USER") {
                return { task: rowToTask(row), accepted: false, reason: "task-paused-by-user" };
            }
            if (normalizedMode(row.continuation_mode, "compat") !== "resident") {
                return { task: rowToTask(row), accepted: false, reason: "resident-mode-required" };
            }
            this.database.sqlite.prepare(`
              update continuation_tasks set state='RUNNING', waiting_reason='Resident stage completed; next turn requested.',
                continuation_pending=case when continuation_pending in (1,4,5) then continuation_pending else 2 end,
                last_activity_at=?, updated_at=? where id=?
            `).run(nowIso, nowIso, taskId);
            return { task: rowToTask(this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(taskId)), accepted: true, reason: "resident-stage-complete" };
        }
        if (action === "checkpoint") {
            const completed = new Set(parseJson(row.completed_milestones_json, []));
            for (const value of Array.isArray(input.completedMilestones) ? input.completedMilestones : []) {
                const item = String(value).trim();
                if (item) completed.add(item);
            }
            const progress = input.progressFingerprint === undefined ? row.progress_fingerprint : String(input.progressFingerprint || "");
            const failure = input.failureFingerprint === undefined ? row.failure_fingerprint : String(input.failureFingerprint || "");
            let noProgress = row.no_progress_count;
            if (input.progressFingerprint !== undefined) {
                noProgress = row.progress_fingerprint && progress === row.progress_fingerprint ? row.no_progress_count + 1 : 0;
            }
            let sameFailure = row.same_failure_count;
            if (input.failureFingerprint !== undefined) {
                sameFailure = failure && failure === row.failure_fingerprint ? row.same_failure_count + 1 : 0;
            }
            const priorEvidence = parseJson(row.evidence_json, {});
            const checkpointEvidence = input.evidence && typeof input.evidence === "object" ? redactValue(input.evidence) : {};
            const evidence = { ...priorEvidence, ...checkpointEvidence };
            const watchedHandles = parseJson(row.watch_process_handles_json, []);
            const waitingForSupervisorAck = Boolean(input.waitingExternal && watchedHandles.length > 0);
            const pausedByUser = row.state === "PAUSED_BY_USER";
            let state = pausedByUser
                ? "PAUSED_BY_USER"
                : input.waitingExternal
                    ? (waitingForSupervisorAck ? "WAITING_SUPERVISOR" : "WAITING_EXTERNAL")
                    : "RUNNING";
            let terminalReason = null;
            let progressWarning = null;
            const completionDriven = normalizedMode(row.continuation_mode, "compat") === "completion-driven";
            if (!pausedByUser && noProgress >= row.max_no_progress && !input.waitingExternal) {
                if (row.owner_locked || completionDriven) {
                    state = "RUNNING";
                    terminalReason = null;
                    progressWarning = completionDriven
                        ? "No-progress threshold reached; completion-driven Task Contract remains active until milestones complete or an explicit stop/cancel/fail occurs."
                        : null;
                }
                else {
                    state = "ABORTED_NO_PROGRESS";
                    terminalReason = "no-progress-limit";
                }
            }
            if (!pausedByUser && sameFailure >= row.max_same_failure && failure) {
                if (row.owner_locked || completionDriven) {
                    state = "RUNNING";
                    terminalReason = null;
                    progressWarning = completionDriven
                        ? "Repeated-failure threshold reached; completion-driven Task Contract remains active until milestones complete or an explicit stop/cancel/fail occurs."
                        : null;
                }
                else {
                    state = "ABORTED_NO_PROGRESS";
                    terminalReason = "same-failure-limit";
                }
            }
            const checkpointLeaseExpiresAt = normalizedMode(row.continuation_mode, "compat") === "completion-driven" && state === "RUNNING"
                ? completionTurnLeaseExpiresAt()
                : row.turn_lease_expires_at;
            this.database.sqlite.prepare(`
              update continuation_tasks set state=?, completed_milestones_json=?, evidence_json=?, progress_fingerprint=?, failure_fingerprint=?,
                no_progress_count=?, same_failure_count=?, waiting_reason=?, terminal_reason=?, continuation_pending=0,
                last_model_activity_at=?, last_activity_at=?, turn_lease_expires_at=?, updated_at=?
              where id=?
            `).run(state, JSON.stringify([...completed]), JSON.stringify(evidence), progress || null, failure || null, noProgress, sameFailure,
                pausedByUser ? (row.waiting_reason || "Paused by Portable owner UI.")
                    : input.waitingExternal ? String(input.note ?? "Waiting for an external condition.") : progressWarning,
                terminalReason, nowIso, nowIso, checkpointLeaseExpiresAt, nowIso, taskId);
            const task = rowToTask(this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(taskId));
            return {
                task,
                accepted: true,
                ...(waitingForSupervisorAck ? { reason: "supervisor-ack-pending" } : {}),
                ...continuationDirective(task),
            };
        }
        if (action === "wait") {
            if (row.state === "PAUSED_BY_USER") {
                return { task: rowToTask(row), accepted: false, reason: "task-paused-by-user" };
            }
            const watchedHandles = parseJson(row.watch_process_handles_json, []);
            const waitingForSupervisorAck = watchedHandles.length > 0;
            this.database.sqlite.prepare("update continuation_tasks set state=?, waiting_reason=?, continuation_pending=0, turn_lease_expires_at=null, last_model_activity_at=?, last_activity_at=?, updated_at=? where id=?")
                .run(waitingForSupervisorAck ? "WAITING_SUPERVISOR" : "WAITING_EXTERNAL",
                String(input.note ?? "Waiting for an external condition."), nowIso, nowIso, nowIso, taskId);
            const task = rowToTask(this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(taskId));
            return {
                task,
                accepted: true,
                ...(waitingForSupervisorAck ? { reason: "supervisor-ack-pending" } : {}),
                ...continuationDirective(task),
            };
        }
        if (action === "resume") {
            if (row.state === "PAUSED_BY_USER") {
                return { task: rowToTask(row), accepted: false, reason: "task-paused-by-user" };
            }
            const turnLeaseId = `turn_${randomUUID()}`;
            const turnLeaseExpiresAt = normalizedMode(row.continuation_mode, "compat") === "completion-driven"
                ? completionTurnLeaseExpiresAt()
                : row.turn_lease_expires_at;
            this.database.sqlite.prepare("update continuation_tasks set state='RUNNING', waiting_reason=null, continuation_pending=0, turn_started_at=?, turn_lease_id=?, turn_lease_expires_at=?, last_model_activity_at=?, last_activity_at=?, updated_at=? where id=?")
                .run(nowIso, turnLeaseId, turnLeaseExpiresAt, nowIso, nowIso, nowIso, taskId);
            const task = rowToTask(this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(taskId));
            return { task, accepted: true, ...continuationDirective(task) };
        }
        if (action === "cancel") {
            if (row.owner_locked) {
                return { task: rowToTask(row), accepted: false, reason: "task-owner-locked" };
            }
            this.database.sqlite.prepare("update continuation_tasks set state='CANCELLED_BY_USER', terminal_reason='user-cancelled', continuation_pending=0, updated_at=? where id=?")
                .run(nowIso, taskId);
            return { task: rowToTask(this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(taskId)), accepted: true };
        }
        if (action === "fail") {
            const terminal = input.terminal !== false;
            if (terminal && row.owner_locked) {
                return { task: rowToTask(row), accepted: false, reason: "task-owner-locked" };
            }
            this.database.sqlite.prepare("update continuation_tasks set state=?, terminal_reason=?, continuation_pending=0, updated_at=? where id=?")
                .run(terminal ? "FAILED_TERMINAL" : "FAILED_RETRYABLE", String(input.note ?? "Task failed."), nowIso, taskId);
            return { task: rowToTask(this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(taskId)), accepted: true };
        }
        if (action === "complete") {
            if (row.owner_locked) {
                return { task: rowToTask(row), accepted: false, reason: "task-owner-locked" };
            }
            const required = new Set(parseJson(row.required_milestones_json, []));
            const completed = new Set(parseJson(row.completed_milestones_json, []));
            for (const value of Array.isArray(input.completedMilestones) ? input.completedMilestones : []) {
                const item = String(value).trim();
                if (item) completed.add(item);
            }
            const missing = [...required].filter((item) => !completed.has(item));
            if (missing.length > 0) {
                return { task: rowToTask(row), accepted: false, reason: "required-milestones-missing", missingMilestones: missing };
            }
            const persistedEvidence = parseJson(row.evidence_json, {});
            const suppliedEvidence = input.evidence && typeof input.evidence === "object" ? redactValue(input.evidence) : {};
            const evidence = { ...persistedEvidence, ...suppliedEvidence };
            if (Object.keys(evidence).length === 0) {
                return { task: rowToTask(row), accepted: false, reason: "completion-evidence-required" };
            }
            this.database.sqlite.prepare(`
              update continuation_tasks set state='SUCCEEDED', completed_milestones_json=?, evidence_json=?,
                terminal_reason='completed', continuation_pending=0,
                turn_lease_expires_at=null, anchor_lease_expires_at=null, updated_at=? where id=?
            `).run(JSON.stringify([...completed]), JSON.stringify(evidence), nowIso, taskId);
            return { task: rowToTask(this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(taskId)), accepted: true };
        }
        if (action === "claim-continuation") {
            const transaction = this.database.sqlite.transaction(() => {
                const current = this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(taskId);
                if (!current || terminalStates.has(current.state)) return { accepted: false, reason: "task-terminal", task: rowToTask(current) };
                if (current.state === "PAUSED_BY_USER") return { accepted: false, reason: "task-paused-by-user", task: rowToTask(current) };
                if (current.state === "WAITING_EXTERNAL") return { accepted: false, reason: "waiting-external", task: rowToTask(current) };
                let pendingState = Number(current.continuation_pending || 0);
                const wakePending = pendingState === 2 || pendingState === 3 || pendingState === 4;
                if (wakePending && normalizedMode(current.continuation_mode, "compat") !== "resident") {
                    this.database.sqlite.prepare("update continuation_tasks set continuation_pending=0, updated_at=? where id=?").run(nowIso, taskId);
                    return { accepted: false, reason: "resident-mode-required", task: rowToTask(this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(taskId)) };
                }
                if (pendingState === 4 || pendingState === 5) {
                    const sendAt = current.last_send_attempt_at ? Date.parse(current.last_send_attempt_at) : NaN;
                    const deliveryAckAge = Number.isFinite(sendAt) ? Math.max(0, now.getTime() - sendAt) : Number.POSITIVE_INFINITY;
                    const deliveryAckLeaseMs = 60_000;
                    if (deliveryAckAge < deliveryAckLeaseMs) {
                        return {
                            accepted: false,
                            reason: "continuation-delivery-awaiting-ack",
                            deliveryAckAgeMs: deliveryAckAge,
                            deliveryAckLeaseMs,
                            task: rowToTask(current),
                        };
                    }
                    pendingState = pendingState === 4 ? 2 : 0;
                    this.database.sqlite.prepare("update continuation_tasks set continuation_pending=?, updated_at=? where id=?")
                        .run(pendingState, nowIso, taskId);
                    current.continuation_pending = pendingState;
                }
                if (pendingState === 1 || pendingState === 3) {
                    const pendingAge = current.last_continuation_at ? now.getTime() - Date.parse(current.last_continuation_at) : 0;
                    const leaseMs = pendingState === 3 ? 30_000 : 120_000;
                    if (pendingAge < leaseMs) {
                        return { accepted: false, reason: "continuation-already-pending", task: rowToTask(current) };
                    }
                    pendingState = pendingState === 3 ? 2 : 0;
                    this.database.sqlite.prepare("update continuation_tasks set continuation_pending=?, updated_at=? where id=?").run(pendingState, nowIso, taskId);
                    current.continuation_pending = pendingState;
                }
                const currentMode = normalizedMode(current.continuation_mode, "compat");
                const lastHostSignalAt = current.last_host_signal_at ? Date.parse(current.last_host_signal_at) : NaN;
                const recentTimeout = current.last_host_signal === "timeout"
                    && Number.isFinite(lastHostSignalAt)
                    && now.getTime() - lastHostSignalAt <= 2 * 60_000;
                const continuationNote = String(input.note ?? "");
                const manualRecovery = /manual recovery/i.test(continuationNote);
                const confirmedLimitTeardown = /confirmed turn-limit teardown/i.test(continuationNote);
                const confirmedLimitLeaseExpired = /confirmed turn-limit lease expired/i.test(continuationNote);
                const completionTurnLeaseExpired = /task contract turn lease expired/i.test(continuationNote);
                const completionResourceTeardown = /task contract resource teardown/i.test(continuationNote);
                const turnStartedAt = current.turn_started_at ? Date.parse(current.turn_started_at) : NaN;
                const confirmedLimitMs = Number(current.confirmed_turn_limit_ms || 0);
                const lastModelActivityAt = current.last_model_activity_at ? Date.parse(current.last_model_activity_at) : NaN;
                const turnLeaseExpiresAt = current.turn_lease_expires_at ? Date.parse(current.turn_lease_expires_at) : NaN;
                const requiredMilestones = parseJson(current.required_milestones_json, []);
                const completedMilestones = new Set(parseJson(current.completed_milestones_json, []));
                const taskIncomplete = requiredMilestones.length > 0
                    && requiredMilestones.some((milestone) => !completedMilestones.has(milestone));
                const recentConfirmedTeardown = confirmedLimitTeardown
                    && currentMode !== "compat"
                    && current.last_host_signal === "teardown"
                    && Number.isFinite(lastHostSignalAt)
                    && now.getTime() - lastHostSignalAt <= 2 * 60_000
                    && Number.isFinite(turnStartedAt)
                    && confirmedLimitMs >= 30_000
                    && now.getTime() - turnStartedAt >= confirmedLimitMs + 5_000;
                const confirmedLeaseRecoveryReady = confirmedLimitLeaseExpired
                    && currentMode !== "compat"
                    && current.state === "RUNNING"
                    && Number.isFinite(turnStartedAt)
                    && confirmedLimitMs >= 30_000
                    && now.getTime() - turnStartedAt >= confirmedLimitMs + CONFIRMED_LIMIT_RECOVERY_GRACE_MS
                    && Number.isFinite(lastModelActivityAt)
                    && now.getTime() - lastModelActivityAt >= CONFIRMED_LIMIT_MODEL_QUIET_MS;
                const completionLeaseRecoveryReady = completionTurnLeaseExpired
                    && currentMode === "completion-driven"
                    && current.state === "RUNNING"
                    && taskIncomplete
                    && Number.isFinite(turnLeaseExpiresAt)
                    && now.getTime() >= turnLeaseExpiresAt;
                const completionTeardownRecoveryReady = completionResourceTeardown
                    && currentMode === "completion-driven"
                    && current.state === "RUNNING"
                    && taskIncomplete
                    && current.last_host_signal === "teardown"
                    && Number.isFinite(lastHostSignalAt)
                    && now.getTime() - lastHostSignalAt <= 2 * 60_000;
                if (!wakePending && !manualRecovery && !(currentMode !== "compat" && recentTimeout)
                    && !recentConfirmedTeardown && !confirmedLeaseRecoveryReady
                    && !completionLeaseRecoveryReady && !completionTeardownRecoveryReady) {
                    return { accepted: false, reason: "continuation-trigger-not-authorized", task: rowToTask(current) };
                }
                if (!wakePending && current.last_continuation_at && now.getTime() - Date.parse(current.last_continuation_at) < 60_000) {
                    return { accepted: false, reason: "continuation-cooldown", task: rowToTask(current) };
                }
                if (current.deadline_at && Date.parse(current.deadline_at) <= now.getTime()) {
                    if (current.owner_locked) {
                        this.database.sqlite.prepare("update continuation_tasks set waiting_reason='Owner lock prevented automatic wall-clock termination.', owner_control_note='wall-clock-budget-reached-while-locked', updated_at=? where id=?").run(nowIso, taskId);
                        return { accepted: false, reason: "task-owner-locked-budget", task: rowToTask(this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(taskId)) };
                    }
                    this.database.sqlite.prepare("update continuation_tasks set state='BUDGET_EXHAUSTED', terminal_reason='wall-clock-budget', updated_at=? where id=?").run(nowIso, taskId);
                    return { accepted: false, reason: "wall-clock-budget", task: rowToTask(this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(taskId)) };
                }
                if (Number(current.max_continuations || 0) > 0 && current.continuation_count >= current.max_continuations) {
                    if (current.owner_locked) {
                        this.database.sqlite.prepare("update continuation_tasks set waiting_reason='Owner lock prevented automatic continuation-budget termination.', owner_control_note='continuation-budget-reached-while-locked', updated_at=? where id=?").run(nowIso, taskId);
                        return { accepted: false, reason: "task-owner-locked-budget", task: rowToTask(this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(taskId)) };
                    }
                    this.database.sqlite.prepare("update continuation_tasks set state='BUDGET_EXHAUSTED', terminal_reason='continuation-budget', updated_at=? where id=?").run(nowIso, taskId);
                    return { accepted: false, reason: "continuation-budget", task: rowToTask(this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(taskId)) };
                }
                this.database.sqlite.prepare(`
                  update continuation_tasks set continuation_pending=?, continuation_count=continuation_count+1,
                    last_continuation_at=?, updated_at=? where id=?
                `).run(wakePending ? 3 : 1, nowIso, nowIso, taskId);
                return { accepted: true, task: rowToTask(this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(taskId)) };
            });
            return transaction();
        }
        if (action === "release-continuation") {
            const pendingState = Number(row.continuation_pending);
            const pending = [3, 4].includes(pendingState) ? 2 : 0;
            this.database.sqlite.prepare("update continuation_tasks set continuation_pending=?, updated_at=? where id=?").run(pending, nowIso, taskId);
            return { accepted: true, task: rowToTask(this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(taskId)) };
        }
        throw new Error(`Unsupported continuation task action: ${action}`);
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
