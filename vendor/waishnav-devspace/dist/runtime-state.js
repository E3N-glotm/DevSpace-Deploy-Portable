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
            and state not in ('SUCCEEDED','FAILED_TERMINAL','CANCELLED_BY_USER','ABORTED_NO_PROGRESS','BUDGET_EXHAUSTED')
          order by updated_at desc limit 1
        `).get(workspaceId, conversationScopeId);
        if (!row)
            return undefined;
        this.database.sqlite.prepare(`
          update continuation_tasks
          set last_model_activity_at=?, last_activity_at=?, updated_at=?
          where id=?
        `).run(nowIso, nowIso, nowIso, row.id);
        return row.id;
    }
    continuationTask(input = {}) {
        const action = String(input.action ?? "status");
        const now = new Date();
        const nowIso = now.toISOString();
        const terminalStates = new Set(["SUCCEEDED", "FAILED_TERMINAL", "CANCELLED_BY_USER", "ABORTED_NO_PROGRESS", "BUDGET_EXHAUSTED"]);
        const rowToTask = (row) => row ? ({
            id: row.id,
            workspaceId: row.workspace_id ?? undefined,
            objective: row.objective,
            state: row.state,
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
            lastHostSignal: row.last_host_signal ?? undefined,
            lastHostSignalAt: row.last_host_signal_at ?? undefined,
            watchProcessHandles: parseJson(row.watch_process_handles_json, []),
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        }) : undefined;
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
                    and state not in ('SUCCEEDED','FAILED_TERMINAL','CANCELLED_BY_USER','ABORTED_NO_PROGRESS','BUDGET_EXHAUSTED')
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
            // Model-originated status calls do not carry coordinatorInstanceId
            // and therefore remain read-only.
            if (row && input.coordinatorInstanceId) {
                const watchedHandles = parseJson(row.watch_process_handles_json, []);
                const acknowledgedState = row.state === "WAITING_SUPERVISOR" && watchedHandles.length > 0
                    ? "WAITING_EXTERNAL"
                    : row.state;
                this.database.sqlite.prepare(`
                  update continuation_tasks set state=?, last_activity_at=?, last_ui_heartbeat_at=?,
                    coordinator_instance_id=?, updated_at=? where id=?
                `).run(acknowledgedState, nowIso, nowIso, String(input.coordinatorInstanceId), nowIso, row.id);
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
                this.database.sqlite.prepare(`
                  update continuation_tasks set continuation_pending=0,
                    turn_started_at=?, last_model_activity_at=?, last_activity_at=?, updated_at=? where id=?
                `).run(nowIso, nowIso, nowIso, nowIso, row.id);
                return {
                    task: rowToTask(this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(row.id)),
                    accepted: true,
                    reason: "continuation-resume-acknowledged",
                };
            }
            return { task: rowToTask(row) };
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
                    const currentRequired = new Set(parseJson(existing.required_milestones_json, []));
                    for (const value of Array.isArray(input.requiredMilestones) ? input.requiredMilestones : []) {
                        const item = String(value).trim();
                        if (item) currentRequired.add(item);
                    }
                    const objective = String(input.objective ?? existing.objective).trim() || existing.objective;
                    const requestedWallClockMinutes = input.wallClockMinutes === undefined
                        ? undefined
                        : Math.max(10, Math.min(Number(input.wallClockMinutes), 24 * 60));
                    const requestedDeadlineAt = requestedWallClockMinutes === undefined
                        ? existing.deadline_at
                        : new Date(now.getTime() + requestedWallClockMinutes * 60_000).toISOString();
                    const deadlineAt = existing.deadline_at && requestedDeadlineAt
                        ? new Date(Math.max(Date.parse(existing.deadline_at), Date.parse(requestedDeadlineAt))).toISOString()
                        : requestedDeadlineAt ?? existing.deadline_at;
                    this.database.sqlite.prepare(`
                      update continuation_tasks set objective=?, required_milestones_json=?,
                        max_continuations=?, max_no_progress=?, max_same_failure=?, deadline_at=?, last_activity_at=?, updated_at=? where id=?
                    `).run(objective, JSON.stringify([...currentRequired].slice(0, 64)),
                        Math.max(existing.max_continuations, Math.max(1, Math.min(Number(input.maxContinuations ?? existing.max_continuations), 100))),
                        Math.max(1, Math.min(Number(input.maxNoProgress ?? existing.max_no_progress), 20)),
                        Math.max(1, Math.min(Number(input.maxSameFailure ?? existing.max_same_failure), 20)), deadlineAt, nowIso, nowIso, existing.id);
                    return { task: rowToTask(this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(existing.id)), created: false, upgraded: true };
                }
                return { task: rowToTask(existing), created: false };
            }
            const id = `task_${randomUUID()}`;
            const required = Array.isArray(input.requiredMilestones)
                ? [...new Set(input.requiredMilestones.map((value) => String(value).trim()).filter(Boolean))].slice(0, 64)
                : [];
            const maxContinuations = Math.max(1, Math.min(Number(input.maxContinuations ?? 5), 100));
            const maxNoProgress = Math.max(1, Math.min(Number(input.maxNoProgress ?? 2), 20));
            const maxSameFailure = Math.max(1, Math.min(Number(input.maxSameFailure ?? 2), 20));
            const wallClockMinutes = Math.max(10, Math.min(Number(input.wallClockMinutes ?? 180), 24 * 60));
            const deadlineAt = new Date(now.getTime() + wallClockMinutes * 60_000).toISOString();
            this.database.sqlite.prepare(`
              insert into continuation_tasks (
                id, conversation_scope_id, workspace_id, objective, state, required_milestones_json,
                completed_milestones_json, evidence_json, max_continuations,
                max_no_progress, max_same_failure, deadline_at, turn_started_at, last_activity_at,
                last_model_activity_at, created_at, updated_at
              ) values (?, ?, ?, ?, 'RUNNING', ?, '[]', '{}', ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(id, String(input.conversationScopeId || "unknown"), input.workspaceId ? String(input.workspaceId) : null,
                String(input.objective ?? "Continue the current DevSpace task until the original user goal is verified complete."),
                JSON.stringify(required), maxContinuations, maxNoProgress, maxSameFailure, deadlineAt, nowIso, nowIso, nowIso, nowIso, nowIso);
            return { task: rowToTask(this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(id)), created: true };
        }
        const row = find();
        if (!row) return { task: undefined, accepted: false, reason: "task-not-found" };
        if (terminalStates.has(row.state) && !["status"].includes(action)) {
            return { task: rowToTask(row), accepted: false, reason: "task-terminal" };
        }
        const taskId = row.id;
        if (action === "heartbeat") {
            this.database.sqlite.prepare(`
              update continuation_tasks set last_activity_at=?, last_ui_heartbeat_at=?, coordinator_instance_id=?, updated_at=?
              where id=?
            `).run(nowIso, nowIso, input.coordinatorInstanceId ? String(input.coordinatorInstanceId) : row.coordinator_instance_id, nowIso, taskId);
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
            }
            if (profile) {
                this.database.sqlite.prepare(`
                  update continuation_host_profiles set observed_turn_budget_ms=?, recommended_continue_after_ms=?,
                    timeout_samples=?, last_timeout_at=?, last_signal=?, last_signal_at=?, updated_at=? where id=?
                `).run(observedTurnBudgetMs, recommendedContinueAfterMs, timeoutSamples,
                    hostSignal === "timeout" ? nowIso : profile.last_timeout_at,
                    hostSignal, nowIso, nowIso, hostProfileId);
            }
            else {
                this.database.sqlite.prepare(`
                  insert into continuation_host_profiles (
                    id, observed_turn_budget_ms, recommended_continue_after_ms, timeout_samples,
                    last_timeout_at, last_signal, last_signal_at, created_at, updated_at
                  ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
                `).run(hostProfileId, observedTurnBudgetMs, recommendedContinueAfterMs, timeoutSamples,
                    hostSignal === "timeout" ? nowIso : null, hostSignal, nowIso, nowIso, nowIso);
            }
            this.database.sqlite.prepare(`
              update continuation_tasks set host_profile_id=?, observed_turn_budget_ms=?, recommended_continue_after_ms=?,
                host_timeout_samples=?, last_host_signal=?, last_host_signal_at=?, coordinator_instance_id=?, updated_at=?
              where id=?
            `).run(hostProfileId, observedTurnBudgetMs, recommendedContinueAfterMs, timeoutSamples,
                hostSignal, nowIso, input.coordinatorInstanceId ? String(input.coordinatorInstanceId) : row.coordinator_instance_id,
                nowIso, taskId);
            return { task: rowToTask(this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(taskId)), accepted: true };
        }
        if (action === "watch-process" || action === "unwatch-process") {
            const handle = String(input.processHandle ?? "").trim();
            if (!handle) return { task: rowToTask(row), accepted: false, reason: "process-handle-required" };
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
            this.database.sqlite.prepare(`
              update continuation_tasks set state='RUNNING', waiting_reason=null,
                continuation_pending=case when continuation_pending in (1,4) then continuation_pending else 2 end,
                turn_started_at=?, last_activity_at=?, updated_at=? where id=?
            `).run(nowIso, nowIso, nowIso, taskId);
            return { task: rowToTask(this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(taskId)), accepted: true };
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
            const watchedHandles = parseJson(row.watch_process_handles_json, []);
            const waitingForSupervisorAck = Boolean(input.waitingExternal && watchedHandles.length > 0);
            let state = input.waitingExternal
                ? (waitingForSupervisorAck ? "WAITING_SUPERVISOR" : "WAITING_EXTERNAL")
                : "RUNNING";
            let terminalReason = null;
            if (noProgress >= row.max_no_progress && !input.waitingExternal) {
                if (row.owner_locked) {
                    state = "RUNNING";
                    terminalReason = null;
                }
                else {
                    state = "ABORTED_NO_PROGRESS";
                    terminalReason = "no-progress-limit";
                }
            }
            if (sameFailure >= row.max_same_failure && failure) {
                if (row.owner_locked) {
                    state = "RUNNING";
                    terminalReason = null;
                }
                else {
                    state = "ABORTED_NO_PROGRESS";
                    terminalReason = "same-failure-limit";
                }
            }
            this.database.sqlite.prepare(`
              update continuation_tasks set state=?, completed_milestones_json=?, progress_fingerprint=?, failure_fingerprint=?,
                no_progress_count=?, same_failure_count=?, waiting_reason=?, terminal_reason=?, continuation_pending=0, updated_at=?
              where id=?
            `).run(state, JSON.stringify([...completed]), progress || null, failure || null, noProgress, sameFailure,
                input.waitingExternal ? String(input.note ?? "Waiting for an external condition.") : null,
                terminalReason, nowIso, taskId);
            return {
                task: rowToTask(this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(taskId)),
                accepted: true,
                ...(waitingForSupervisorAck ? { reason: "supervisor-ack-pending" } : {}),
            };
        }
        if (action === "wait") {
            const watchedHandles = parseJson(row.watch_process_handles_json, []);
            const waitingForSupervisorAck = watchedHandles.length > 0;
            this.database.sqlite.prepare("update continuation_tasks set state=?, waiting_reason=?, continuation_pending=0, updated_at=? where id=?")
                .run(waitingForSupervisorAck ? "WAITING_SUPERVISOR" : "WAITING_EXTERNAL",
                String(input.note ?? "Waiting for an external condition."), nowIso, taskId);
            return {
                task: rowToTask(this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(taskId)),
                accepted: true,
                ...(waitingForSupervisorAck ? { reason: "supervisor-ack-pending" } : {}),
            };
        }
        if (action === "resume") {
            this.database.sqlite.prepare("update continuation_tasks set state='RUNNING', waiting_reason=null, continuation_pending=0, turn_started_at=?, updated_at=? where id=?")
                .run(nowIso, nowIso, taskId);
            return { task: rowToTask(this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(taskId)), accepted: true };
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
            const evidence = input.evidence && typeof input.evidence === "object" ? redactValue(input.evidence) : {};
            if (Object.keys(evidence).length === 0) {
                return { task: rowToTask(row), accepted: false, reason: "completion-evidence-required" };
            }
            this.database.sqlite.prepare(`
              update continuation_tasks set state='SUCCEEDED', completed_milestones_json=?, evidence_json=?,
                terminal_reason='completed', continuation_pending=0, updated_at=? where id=?
            `).run(JSON.stringify([...completed]), JSON.stringify(evidence), nowIso, taskId);
            return { task: rowToTask(this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(taskId)), accepted: true };
        }
        if (action === "claim-continuation") {
            const transaction = this.database.sqlite.transaction(() => {
                const current = this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(taskId);
                if (!current || terminalStates.has(current.state)) return { accepted: false, reason: "task-terminal", task: rowToTask(current) };
                if (current.state === "WAITING_EXTERNAL") return { accepted: false, reason: "waiting-external", task: rowToTask(current) };
                let pendingState = Number(current.continuation_pending || 0);
                const wakePending = pendingState === 2 || pendingState === 3 || pendingState === 4;
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
                if (current.continuation_count >= current.max_continuations) {
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
