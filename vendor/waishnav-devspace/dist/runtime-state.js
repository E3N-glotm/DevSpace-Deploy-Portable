import { randomUUID } from "node:crypto";
import { openDatabase } from "./db/client.js";
import { redactValue, redactedJson } from "./redaction.js";

const DEFAULT_TASK_CONTRACT_MILESTONES = [
    "Complete the original user-requested DevSpace work",
    "Run necessary verification and deliver completion evidence",
];
const TASK_CONTRACT_VERSION = 2;
const ANCHOR_LEASE_MS = 90_000;
// This is an activity-suspicion threshold, not a ChatGPT turn deadline. Its
// expiry only moves an unfinished task to SUSPECTED_STALL. Request silence can
// persist for minutes while the model reasons outside DevSpace, so it is never
// sufficient to authorize a replacement Host turn.
const COMPLETION_STALL_SUSPECT_MS = 25_000;
// MCP Apps does not expose a standard authoritative "assistant turn finished"
// event. A surviving/verified iframe heartbeat therefore proves only that the
// card is alive; repeated heartbeats themselves MUST NOT arm a continuation.
// Recovery is authorized only by independent current-turn Host/lifecycle end
// evidence. Historical cutoff observations remain telemetry only.
const HOST_CUTOFF_MIN_SAMPLE_MS = 30_000;
const HOST_CUTOFF_REGIME_DOWN_RATIO = 0.80;
const HOST_CUTOFF_REGIME_UP_RATIO = 1.20;
const HOST_CUTOFF_SAMPLE_WINDOW = 8;
const DELIVERY_ACK_RETRY_BASE_MS = 15_000;
const DELIVERY_ACK_RETRY_MAX_MS = 45_000;
// A synthetic resumed turn must not be considered successful merely because it
// reached DevSpace once, performed one real tool call, or wrote one material
// checkpoint. Keep a short, renewable ownership lease for the whole resumed
// work interval. While required milestones are still runnable, synthetic work
// has the same stopping rule as a manual "continue" turn: keep executing and
// polling owned work until the milestone set is complete, explicitly blocked,
// paused/cancelled, or the Host forcibly truncates the model turn.
// The synthetic ownership lease is not a turn budget.  It only protects the
// server-owned generation from being orphaned forever if a Host never starts
// the delivered turn.  Once a resumed turn exists it must have essentially the
// same reasoning/execution room as a manual `continue`, so keep this lease far
// above the short 20-60 second windows that previously produced truncated
// synthetic work.  Manual takeover can revoke this ownership immediately and
// therefore remains the higher-priority preemption mechanism.
const SYNTHETIC_WORK_OWNER_LEASE_MS = 30 * 60_000;
// A synthetic turn with runnable milestones may not voluntarily sign an
// incomplete-stage boundary immediately after a few quick tool calls.  This is
// only a minimum for *voluntary incomplete turn-complete*; it never delays a
// completed task and never authorizes a continuation by elapsed time.
const SYNTHETIC_MIN_ACTIVE_WORK_MS = 120_000;
const CONTINUATION_SENDER_CLAIM_LEASE_MS = 15_000;
// ChatGPT's current Apps host does not emit resource teardown after an ordinary
// assistant final.  A model-signed ATCC completion intent would therefore stay
// in COMPLETION_REQUESTED forever if teardown were mandatory.  This short
// handoff window is *not* a silence detector: it is reachable only after the
// model explicitly signs completion for the exact current turn lease.  Any
// later substantive DevSpace request revokes that intent back to GENERATING,
// while an in-flight request blocks promotion.  The grace only gives the Host
// time to finish rendering the already-intended final response before sender
// delivery is armed.
const MODEL_COMPLETION_HANDOFF_GRACE_MS = 8_000;
const CONTINUATION_COOLDOWN_MS = 45_000;
const AUTO_TASK_ABANDON_AFTER_MS = 24 * 60 * 60 * 1000;
const TERMINAL_CONTINUATION_STATES = new Set([
    "SUCCEEDED",
    "FAILED_TERMINAL",
    "CANCELLED_BY_USER",
    "ABORTED_NO_PROGRESS",
    "BUDGET_EXHAUSTED",
    "ABANDONED_AUTO_TASK",
]);

function isCanonicalConversationScope(value) {
    return /^v1\//.test(String(value ?? "").trim());
}

function normalizedContinuationMode(value, fallback = "compat") {
    const mode = String(value ?? "").trim().toLowerCase();
    if (mode === "resident")
        return "resident";
    if (mode === "completion-driven")
        return "completion-driven";
    if (mode === "timeout-recovery" || mode === "explicit-long")
        return "timeout-recovery";
    if (mode === "compat")
        return "compat";
    return fallback;
}

function parseJson(value, fallback) {
    try {
        return JSON.parse(value);
    }
    catch {
        return fallback;
    }
}
function numericSamples(value) {
    const parsed = Array.isArray(value) ? value : parseJson(value, []);
    return (Array.isArray(parsed) ? parsed : []).map((entry) => Number(entry))
        .filter((entry) => Number.isFinite(entry) && entry >= HOST_CUTOFF_MIN_SAMPLE_MS)
        .slice(-HOST_CUTOFF_SAMPLE_WINDOW);
}
function median(values) {
    const sorted = [...values].sort((left, right) => left - right);
    if (sorted.length === 0)
        return undefined;
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1
        ? sorted[middle]
        : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}
function deliveryAckRetryDelayMs(retryCount) {
    const exponent = Math.max(0, Math.min(8, Math.round(Number(retryCount || 1)) - 1));
    return Math.min(DELIVERY_ACK_RETRY_MAX_MS, DELIVERY_ACK_RETRY_BASE_MS * (2 ** exponent));
}
function anchorMountRecoveryRequired(row, nowMs = Date.now(), _currentHostTurnFingerprint) {
    if (!row)
        return true;
    // Exactly one UI-bearing continuation_anchor may be issued in the current
    // manual user round. A new manual round explicitly rotates/reset these
    // fields first; synthetic continuations never do. Within one round an
    // unverified issuance is fail-closed and may not mint a duplicate card.
    return !row.anchor_mount_verified_at && !row.anchor_mount_requested_at;
}
function anchorMountProvisionalUntil(row) {
    return undefined;
}
function adaptHostCutoffRegime({ elapsedMs, confirmedTurnLimitMs, confirmedTurnLimitSource, cutoffSamples, cutoffEpoch, cutoffRegimeChangedAt, nowIso, }) {
    const elapsed = Math.round(Number(elapsedMs || 0));
    let confirmed = Number(confirmedTurnLimitMs || 0);
    let source = String(confirmedTurnLimitSource || "");
    let samples = numericSamples(cutoffSamples);
    let epoch = Math.max(0, Math.round(Number(cutoffEpoch || 0)));
    let regimeChangedAt = cutoffRegimeChangedAt || null;
    if (elapsed < HOST_CUTOFF_MIN_SAMPLE_MS) {
        return { confirmedTurnLimitMs: confirmed || null, confirmedTurnLimitSource: source || null, cutoffSamples: samples, cutoffEpoch: epoch, cutoffRegimeChangedAt: regimeChangedAt };
    }
    if (confirmed < HOST_CUTOFF_MIN_SAMPLE_MS) {
        confirmed = elapsed;
        source = "host-timeout-initial-regime";
        samples = [elapsed];
        regimeChangedAt = nowIso;
        return { confirmedTurnLimitMs: confirmed, confirmedTurnLimitSource: source, cutoffSamples: samples, cutoffEpoch: epoch, cutoffRegimeChangedAt: regimeChangedAt };
    }
    if (elapsed < confirmed * HOST_CUTOFF_REGIME_DOWN_RATIO) {
        epoch += 1;
        confirmed = elapsed;
        source = "host-timeout-regime-down";
        samples = [elapsed];
        regimeChangedAt = nowIso;
        return { confirmedTurnLimitMs: confirmed, confirmedTurnLimitSource: source, cutoffSamples: samples, cutoffEpoch: epoch, cutoffRegimeChangedAt: regimeChangedAt };
    }
    const previousSample = samples.length > 0 ? samples[samples.length - 1] : undefined;
    if (elapsed > confirmed * HOST_CUTOFF_REGIME_UP_RATIO
        && Number.isFinite(previousSample)
        && previousSample > confirmed * HOST_CUTOFF_REGIME_UP_RATIO) {
        epoch += 1;
        samples = [previousSample, elapsed];
        confirmed = median(samples) ?? elapsed;
        source = "host-timeout-regime-up";
        regimeChangedAt = nowIso;
        return { confirmedTurnLimitMs: confirmed, confirmedTurnLimitSource: source, cutoffSamples: samples, cutoffEpoch: epoch, cutoffRegimeChangedAt: regimeChangedAt };
    }
    samples = [...samples, elapsed].slice(-HOST_CUTOFF_SAMPLE_WINDOW);
    const inRegime = samples.filter((value) => value >= confirmed * HOST_CUTOFF_REGIME_DOWN_RATIO
        && value <= confirmed * HOST_CUTOFF_REGIME_UP_RATIO);
    const estimate = median(inRegime);
    if (Number.isFinite(estimate))
        confirmed = Math.round(estimate);
    source = "host-timeout-adaptive-regime";
    return { confirmedTurnLimitMs: confirmed, confirmedTurnLimitSource: source, cutoffSamples: samples, cutoffEpoch: epoch, cutoffRegimeChangedAt: regimeChangedAt };
}

export class StructuredRuntimeState {
    database;
    continuationModelRequests = new Map();
    constructor(stateDir) {
        this.database = openDatabase(stateDir);
    }
    beginContinuationModelRequest(conversationScopeId) {
        const scope = String(conversationScopeId ?? "").trim();
        if (!scope)
            return () => { };
        this.continuationModelRequests.set(scope, Number(this.continuationModelRequests.get(scope) || 0) + 1);
        let released = false;
        return () => {
            if (released)
                return;
            released = true;
            const next = Math.max(0, Number(this.continuationModelRequests.get(scope) || 0) - 1);
            if (next > 0)
                this.continuationModelRequests.set(scope, next);
            else
                this.continuationModelRequests.delete(scope);
        };
    }
    continuationModelRequestInFlight(conversationScopeId) {
        return Number(this.continuationModelRequests.get(String(conversationScopeId ?? "").trim()) || 0) > 0;
    }
    promoteMatureAssistantCompletionIntent(taskId, nowMs = Date.now()) {
        const id = String(taskId ?? "").trim();
        if (!id)
            return { promoted: false, reason: "task-id-required" };
        const effectiveNowMs = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
        const nowIso = new Date(effectiveNowMs).toISOString();
        return this.database.sqlite.transaction(() => {
            const current = this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(id);
            if (!current)
                return { promoted: false, reason: "task-not-found" };
            if (current.state !== "RUNNING"
                || normalizedContinuationMode(current.continuation_mode, "compat") !== "completion-driven"
                || String(current.assistant_turn_state || "") !== "COMPLETION_REQUESTED") {
                return { promoted: false, reason: "completion-intent-not-pending", task: current };
            }
            const turnLeaseId = String(current.turn_lease_id || "").trim();
            if (!turnLeaseId || String(current.assistant_turn_completion_lease_id || "") !== turnLeaseId) {
                return { promoted: false, reason: "completion-intent-stale-turn", task: current };
            }
            const requestedAtMs = Date.parse(String(current.assistant_turn_completion_requested_at || ""));
            if (!Number.isFinite(requestedAtMs))
                return { promoted: false, reason: "completion-intent-time-missing", task: current };
            const handoffDueAtMs = requestedAtMs + MODEL_COMPLETION_HANDOFF_GRACE_MS;
            if (effectiveNowMs < handoffDueAtMs) {
                return {
                    promoted: false,
                    reason: "completion-handoff-grace-active",
                    retryAfterMs: Math.max(1, handoffDueAtMs - effectiveNowMs),
                    task: current,
                };
            }
            if (this.continuationModelRequestInFlight(current.conversation_scope_id)) {
                return { promoted: false, reason: "model-request-still-in-flight", task: current };
            }
            const required = parseJson(current.required_milestones_json, []);
            const completed = new Set(parseJson(current.completed_milestones_json, []));
            const incomplete = required.length > 0 && required.some((milestone) => !completed.has(milestone));
            if (!incomplete)
                return { promoted: false, reason: "no-incomplete-milestones", task: current };
            const changed = this.database.sqlite.prepare(`
              update continuation_tasks set
                assistant_turn_state='COMPLETED',assistant_turn_completed_at=?,
                assistant_turn_completion_source='model-completion-handoff-grace',
                stall_state='CONTINUATION_ARMED',stall_armed_at=?,
                stall_evidence='atcc-model-completion-handoff-grace',updated_at=?
              where id=? and state='RUNNING' and continuation_mode='completion-driven'
                and assistant_turn_state='COMPLETION_REQUESTED'
                and turn_lease_id=? and assistant_turn_completion_lease_id=?
                and assistant_turn_completion_requested_at=?
            `).run(nowIso, nowIso, nowIso, id, turnLeaseId, turnLeaseId,
                current.assistant_turn_completion_requested_at);
            if (Number(changed.changes || 0) !== 1) {
                return {
                    promoted: false,
                    reason: "completion-intent-race-lost",
                    task: this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(id),
                };
            }
            this.database.sqlite.prepare(`
              update continuation_worksets set continuation_due_at=?,updated_at=?
              where legacy_task_id=? and state in ('RUNNING','SUSPECTED_STALL')
            `).run(nowIso, nowIso, id);
            return {
                promoted: true,
                reason: "assistant-turn-completion-promoted-after-handoff-grace",
                task: this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(id),
            };
        })();
    }
    continuationModelToolAuthorization(input = {}) {
        const conversationScopeId = String(input.conversationScopeId ?? "").trim();
        if (!conversationScopeId)
            return { accepted: true, reason: "conversation-scope-unavailable" };
        const task = this.database.sqlite.prepare(`
          select * from continuation_tasks
          where conversation_scope_id=?
          order by
            case when state not in ('SUCCEEDED','FAILED_TERMINAL','CANCELLED_BY_USER','ABORTED_NO_PROGRESS','BUDGET_EXHAUSTED','ABANDONED_AUTO_TASK') then 0 else 1 end,
            updated_at desc
          limit 1
        `).get(conversationScopeId);
        if (!task || TERMINAL_CONTINUATION_STATES.has(String(task.state || "")))
            return { accepted: true, reason: task ? "task-terminal" : "task-not-found" };
        const currentToken = String(task.delivery_token ?? "").trim();
        const owner = String(task.delivery_owner ?? "").trim();
        const syntheticOwned = ["synthetic-pending", "synthetic-active"].includes(owner);
        const continuationPending = Number(task.continuation_pending || 0);
        // The status claim consumes the model-visible capability and persists
        // generation ownership here. Ordinary tools are authorized solely by
        // that server-owned lease; their schemas must never grow a transport
        // token that the underlying MCP tools do not understand.
        if (owner === "synthetic-active" && continuationPending === 0) {
            const activeCard = this.database.sqlite.prepare(`
              select active_workset_id from continuation_conversation_cards where conversation_scope_id=?
            `).get(conversationScopeId);
            const activeGeneration = activeCard?.active_workset_id
                ? this.database.sqlite.prepare(`
                    select generation from continuation_generations
                    where workset_id=? and owner_type='synthetic' and state in ('TURN_ACKED','WORK_REQUIRED')
                    order by generation desc limit 1
                  `).get(activeCard.active_workset_id)
                : undefined;
            return {
                accepted: true,
                reason: "synthetic-generation-lease-authorized",
                taskId: task.id,
                owner: "synthetic",
                deliveryGeneration: Number(activeGeneration?.generation ?? task.delivery_generation ?? 0),
                turnLeaseId: task.turn_lease_id ?? undefined,
            };
        }

        const card = this.database.sqlite.prepare(`
          select active_workset_id from continuation_conversation_cards where conversation_scope_id=?
        `).get(conversationScopeId);
        const preDeliveryGeneration = card?.active_workset_id
            ? this.database.sqlite.prepare(`
                select id,generation,state,delivery_token,created_at from continuation_generations
                where workset_id=? and owner_type='synthetic' and state in ('READY','CLAIMED')
                order by generation asc limit 1
              `).get(card.active_workset_id)
            : undefined;
        if (syntheticOwned || currentToken || preDeliveryGeneration) {
            return {
                accepted: false,
                reason: "turn-origin-handshake-required",
                taskId: task.id,
                readyGeneration: preDeliveryGeneration?.state === "READY" ? preDeliveryGeneration?.generation : undefined,
                syntheticOwnerActive: syntheticOwned,
                syntheticTokenPending: Boolean(currentToken),
            };
        }
        // A manual user round is not authorized for ordinary DevSpace side
        // effects until that round has issued its single visible milestone
        // surface.  Server prose alone is not a sufficient invariant: a model
        // can miss the required continuation_anchor after connector discovery,
        // workspace switching, or a cached tool-schema refresh.  Fail closed at
        // the runtime boundary instead.  Issuance (mount_requested_at) is enough
        // to release ordinary work; iframe verification may arrive later and
        // must never force a duplicate card inside the same manual round.
        if (anchorMountRecoveryRequired(task, Date.now())) {
            return {
                accepted: false,
                reason: "manual-round-card-required",
                taskId: task.id,
                owner: "manual",
                manualRoundCardRequired: true,
                anchorMountGeneration: Number(task.anchor_mount_generation || 0),
            };
        }
        return { accepted: true, reason: "manual-owner-authorized", taskId: task.id, owner: "manual" };
    }
    rotateContinuationManualRoundCard(taskId, nowIso = new Date().toISOString()) {
        const id = String(taskId ?? "").trim();
        if (!id)
            return undefined;
        const transaction = this.database.sqlite.transaction(() => {
            const task = this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(id);
            if (!task)
                return undefined;
            const card = this.database.sqlite.prepare(`
              select * from continuation_conversation_cards where conversation_scope_id=?
            `).get(task.conversation_scope_id);
            const nextGeneration = Math.max(
                0,
                Number(task.anchor_mount_generation || 0),
                Number(card?.mount_generation || 0),
            ) + 1;
            // A visible milestone surface belongs to one milestone-card
            // generation, not to the lifetime ChatGPT thread. Every real manual
            // user message starts a fresh generation. Synthetic continuations
            // reuse that generation while the required milestone set is stable,
            // but a synthetic checkpoint that changes that set also rotates the
            // card so the transcript exposes the new milestone contract.
            this.database.sqlite.prepare(`
              update continuation_tasks set
                anchor_mount_token=null,anchor_mount_requested_at=null,anchor_mount_verified_at=null,
                anchor_mount_coordinator_id=null,anchor_mount_generation=?,anchor_mount_host_turn_hash=null,
                last_anchor_mounted_at=null,anchor_lease_expires_at=null,
                coordinator_instance_id=null,last_ui_heartbeat_at=null,updated_at=?
              where id=?
            `).run(nextGeneration, nowIso, id);
            const cardId = `card:${task.conversation_scope_id}:g${nextGeneration}`;
            if (card) {
                this.database.sqlite.prepare(`
                  update continuation_conversation_cards set
                    card_id=?,schema_epoch=3,mount_state='UNMOUNTED',mount_token=null,
                    mount_requested_at=null,mount_verified_at=null,mount_generation=?,
                    coordinator_instance_id=null,sender_instance_id=null,updated_at=?
                  where conversation_scope_id=?
                `).run(cardId, nextGeneration, nowIso, task.conversation_scope_id);
            }
            else {
                this.database.sqlite.prepare(`
                  insert into continuation_conversation_cards(
                    conversation_scope_id,card_id,schema_epoch,mount_state,mount_token,
                    mount_requested_at,mount_verified_at,mount_generation,coordinator_instance_id,
                    sender_instance_id,active_workset_id,created_at,updated_at
                  ) values(?,?,3,'UNMOUNTED',null,null,null,?,null,null,null,?,?)
                `).run(task.conversation_scope_id, cardId, nextGeneration, nowIso, nowIso);
            }
            return this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(id);
        });
        return transaction();
    }
    trackContinuationActivityProcess(input = {}) {
        const conversationScopeId = String(input.conversationScopeId ?? "").trim();
        const processHandle = String(input.processHandle ?? "").trim();
        if (!conversationScopeId || !processHandle)
            return { accepted: false, reason: "conversation-scope-and-process-handle-required", handles: [] };
        const row = this.database.sqlite.prepare(`
          select * from continuation_tasks where conversation_scope_id=? order by created_at asc limit 1
        `).get(conversationScopeId);
        if (!row || row.state !== "RUNNING" || normalizedContinuationMode(row.continuation_mode, "compat") !== "completion-driven")
            return { accepted: false, reason: row ? "not-active-completion-driven" : "task-not-found", handles: [] };
        const handles = new Set(parseJson(row.watch_process_handles_json, []));
        if (input.running === true)
            handles.add(processHandle);
        else if (input.running === false)
            handles.delete(processHandle);
        else
            return { accepted: false, reason: "running-state-required", handles: [...handles] };
        const nowMs = Date.now();
        const nowIso = new Date(nowMs).toISOString();
        const nextLeaseAt = new Date(nowMs + COMPLETION_STALL_SUSPECT_MS).toISOString();
        this.database.sqlite.prepare(`
          update continuation_tasks set
            watch_process_handles_json=?,
            stall_state='ACTIVE',stall_suspected_at=null,stall_armed_at=null,
            stall_probe_count=0,stall_last_probe_at=null,stall_evidence=null,
            turn_lease_expires_at=?,last_activity_at=?,updated_at=?
          where id=?
        `).run(JSON.stringify([...handles]), nextLeaseAt, nowIso, nowIso, row.id);
        return { accepted: true, handles: [...handles], running: input.running };
    }
    continuationActivityProcessGuards() {
        return this.database.sqlite.prepare(`
          select id,conversation_scope_id,workspace_id,watch_process_handles_json
          from continuation_tasks
          where state='RUNNING' and continuation_mode='completion-driven'
            and watch_process_handles_json is not null and watch_process_handles_json <> '[]'
          order by updated_at asc
        `).all().map((row) => ({
            taskId: row.id,
            conversationScopeId: row.conversation_scope_id,
            workspaceId: row.workspace_id ?? undefined,
            processHandles: parseJson(row.watch_process_handles_json, []),
        })).filter((entry) => entry.processHandles.length > 0);
    }
    closeTerminalContinuationArtifacts(taskId, reason = "task-terminal", nowIso = new Date().toISOString()) {
        const id = String(taskId ?? "").trim();
        if (!id)
            return { accepted: false, reason: "task-required" };
        const task = this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(id);
        if (!task)
            return { accepted: false, reason: "task-not-found" };
        const scope = String(task.conversation_scope_id ?? "").trim();
        const terminalReason = `task-terminal:${String(reason || task.terminal_reason || task.state || "terminal").trim()}`;
        const syntheticClosed = this.database.sqlite.prepare(`
          update continuation_generations set state='NO_WORK',due_at=null,
            closed_at=coalesce(closed_at,?),failure_reason=coalesce(failure_reason,?),updated_at=?
          where workset_id in (select id from continuation_worksets where legacy_task_id=? and conversation_scope_id=?)
            and owner_type='synthetic' and state not in ('CLOSED','SUPERSEDED','NO_WORK')
        `).run(nowIso, terminalReason, nowIso, id, scope);
        this.database.sqlite.prepare(`
          update continuation_generations set state='CLOSED',due_at=null,
            closed_at=coalesce(closed_at,?),failure_reason=coalesce(failure_reason,?),updated_at=?
          where workset_id in (select id from continuation_worksets where legacy_task_id=? and conversation_scope_id=?)
            and owner_type<>'synthetic' and state not in ('CLOSED','SUPERSEDED','NO_WORK')
        `).run(nowIso, terminalReason, nowIso, id, scope);
        this.database.sqlite.prepare("update continuation_worksets set continuation_due_at=null,updated_at=? where legacy_task_id=? and conversation_scope_id=?")
            .run(nowIso, id, scope);
        this.database.sqlite.prepare(`
          update continuation_conversation_cards set active_workset_id=null,updated_at=?
          where conversation_scope_id=? and active_workset_id in
            (select id from continuation_worksets where legacy_task_id=? and conversation_scope_id=?)
        `).run(nowIso, scope, id, scope);
        this.database.sqlite.prepare(`
          update continuation_tasks set continuation_pending=0,
            superseded_delivery_token=coalesce(delivery_token,superseded_delivery_token),
            delivery_token=null,delivery_owner=null,delivery_owner_expires_at=null,
            delivery_ack_started_at=null,delivery_ack_retry_count=0,delivery_ack_retry_after_at=null,
            delivery_work_baseline_count=0,watch_process_handles_json='[]',turn_lease_expires_at=null,
            anchor_lease_expires_at=null,stall_state='ACTIVE',stall_suspected_at=null,stall_probe_count=0,
            stall_last_probe_at=null,stall_armed_at=null,stall_evidence=null,updated_at=? where id=?
        `).run(nowIso, id);
        return { accepted: true, syntheticClosed: Number(syntheticClosed.changes || 0) };
    }
    continuationSenderCapability(input = {}) {
        const taskId = String(input.taskId ?? "").trim();
        const conversationScopeId = String(input.conversationScopeId ?? "").trim();
        const recoveredTask = this.recoverCanonicalConversationTaskProjection({ taskId, conversationScopeId });
        const task = recoveredTask ?? (taskId
            ? this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(taskId)
            : conversationScopeId
                ? this.database.sqlite.prepare(`
                    select * from continuation_tasks where conversation_scope_id=? order by created_at asc limit 1
                  `).get(conversationScopeId)
                : undefined);
        if (!task || TERMINAL_CONTINUATION_STATES.has(String(task.state || "")))
            return undefined;
        const card = this.database.sqlite.prepare(`
          select * from continuation_conversation_cards where conversation_scope_id=?
        `).get(task.conversation_scope_id);
        // The current manual user round owns exactly one visible card capability.
        // Once that round's card is issued, its generation/token remain stable
        // across synthetic continuations, iframe rehydrates and workspace
        // switches. A later manual user round rotates to a new generation while
        // the old transcript card remains historical UI.
        if (!card || !card.mount_requested_at || !card.mount_token || Number(card.mount_generation || 0) <= 0)
            return undefined;
        return {
            taskId: task.id,
            conversationScopeId: task.conversation_scope_id,
            workspaceId: task.workspace_id ?? undefined,
            anchorMountToken: card.mount_token,
            anchorMountGeneration: Number(card.mount_generation),
            anchorMountVerified: Boolean(card.mount_verified_at),
        };
    }
    bindContinuationSender(input = {}) {
        const trustedConversationScopeId = String(input.conversationScopeId ?? "").trim();
        const claimedConversationScopeId = String(input.claimedConversationScopeId ?? "").trim();
        const taskId = String(input.taskId ?? "").trim();
        const senderInstanceId = String(input.senderInstanceId ?? "").trim();
        if (!senderInstanceId)
            return { accepted: false, reason: "sender-required" };
        // Prefer the authenticated Host request scope. Some App->MCP calls do
        // not preserve it, so allow a narrow app-only fallback bound to the
        // exact random taskId + canonical conversation scope + current manual-
        // round card generation already present in that App's structured result.
        // This restores transport authority without minting a duplicate card
        // inside the same manual round or trusting a scope by itself.
        const recoveredTask = this.recoverCanonicalConversationTaskProjection({
            taskId,
            conversationScopeId: trustedConversationScopeId || claimedConversationScopeId,
        });
        const task = recoveredTask ?? (trustedConversationScopeId
            ? this.database.sqlite.prepare(`
                select * from continuation_tasks where conversation_scope_id=? order by created_at asc limit 1
              `).get(trustedConversationScopeId)
            : taskId && claimedConversationScopeId
                ? this.database.sqlite.prepare(`
                    select * from continuation_tasks where id=? and conversation_scope_id=?
                  `).get(taskId, claimedConversationScopeId)
                : undefined);
        if (!task)
            return { accepted: false, reason: trustedConversationScopeId ? "task-not-found" : "verified-task-capability-required" };
        if (!task || TERMINAL_CONTINUATION_STATES.has(String(task.state || "")))
            return { accepted: false, reason: task ? "task-terminal" : "task-not-found" };
        const capability = this.continuationSenderCapability({ taskId: task.id });
        if (!capability)
            return { accepted: false, reason: "issued-card-capability-unavailable" };
        if (!trustedConversationScopeId) {
            const requestedGeneration = Number(input.anchorMountGeneration || 0);
            if (!Number.isInteger(requestedGeneration) || requestedGeneration <= 0
                || requestedGeneration !== capability.anchorMountGeneration) {
                return { accepted: false, reason: "verified-card-generation-mismatch" };
            }
        }
        const conversationScopeId = task.conversation_scope_id;
        const nowIso = new Date().toISOString();
        this.database.sqlite.prepare(`
          update continuation_conversation_cards
          set sender_instance_id=?,updated_at=?
          where conversation_scope_id=?
            and mount_requested_at is not null and mount_token is not null and mount_generation>0
        `).run(senderInstanceId, nowIso, conversationScopeId);
        this.database.sqlite.prepare(`
          update continuation_tasks set last_ui_heartbeat_at=?,updated_at=? where id=?
        `).run(nowIso, nowIso, task.id);
        const reboundCard = this.database.sqlite.prepare(`
          select active_workset_id from continuation_conversation_cards where conversation_scope_id=?
        `).get(conversationScopeId);
        const readyGeneration = reboundCard?.active_workset_id
            ? this.database.sqlite.prepare(`
                select generation from continuation_generations
                where workset_id=? and owner_type='synthetic' and state='READY'
                order by generation asc limit 1
              `).get(reboundCard.active_workset_id)
            : undefined;
        const refreshedTask = this.continuationTask({
            action: "status",
            taskId: task.id,
            conversationScopeId,
        }).task;
        return {
            accepted: true,
            ...capability,
            senderInstanceId,
            lastUiHeartbeatAt: nowIso,
            readyGeneration: readyGeneration ? Number(readyGeneration.generation) : undefined,
            task: refreshedTask,
        };
    }
    recoverCanonicalConversationTaskProjection(input = {}) {
        const requestedTaskId = String(input.taskId ?? "").trim();
        let conversationScopeId = String(input.conversationScopeId ?? "").trim();
        if (!conversationScopeId && requestedTaskId) {
            const lineage = this.database.sqlite.prepare(`
              select conversation_scope_id from continuation_worksets
              where legacy_task_id=? and conversation_scope_id glob 'v1/*'
              order by sequence asc,created_at asc limit 1
            `).get(requestedTaskId);
            conversationScopeId = String(lineage?.conversation_scope_id ?? "").trim();
        }
        if (!isCanonicalConversationScope(conversationScopeId)) return undefined;
        const card = this.database.sqlite.prepare(`
          select * from continuation_conversation_cards where conversation_scope_id=?
        `).get(conversationScopeId);
        // A requested card is the immutable issuance for the *current manual
        // user round*. Recover the lifetime task projection even if the iframe
        // ACK never arrived, otherwise the same round can allocate a shadow task
        // and accidentally request a duplicate visible card.
        if (!card?.mount_requested_at || !card?.mount_token || Number(card?.mount_generation || 0) <= 0) return undefined;
        const lineage = this.database.sqlite.prepare(`
          select * from continuation_worksets
          where conversation_scope_id=? and legacy_task_id is not null and trim(legacy_task_id)<>''
          order by sequence asc,created_at asc limit 1
        `).get(conversationScopeId);
        const canonicalTaskId = String(lineage?.legacy_task_id ?? "").trim();
        if (!canonicalTaskId) return undefined;
        const hintedRequired = Array.isArray(input.requiredMilestones)
            ? [...new Set(input.requiredMilestones.map((value) => String(value).trim()).filter(Boolean))].slice(0, 64)
            : [];
        const hintedCompleted = new Set(Array.isArray(input.completedMilestones)
            ? input.completedMilestones.map((value) => String(value).trim()).filter(Boolean)
            : []);
        const forceRunning = input.forceRunning === true;
        const nowIso = new Date().toISOString();
        const transaction = this.database.sqlite.transaction(() => {
            // Prefer the newest unfinished active Workset as the authoritative
            // execution projection. A compatibility/shadow task may have
            // created that Workset after the canonical legacy row was already
            // terminal. Retiring the shadow before adopting its active Workset
            // loses the newest objective/milestones and can resurrect an older
            // SUCCEEDED projection on the next status call.
            const preferredActiveWorkset = this.database.sqlite.prepare(`
              select w.* from continuation_worksets w
              where w.conversation_scope_id=?
                and w.state in ('RUNNING','WAITING_EXTERNAL','SUSPECTED_STALL','PAUSED')
                and exists (
                  select 1 from continuation_milestones m
                  where m.workset_id=w.id and m.state='PENDING'
                )
              order by w.sequence desc,w.updated_at desc,w.created_at desc limit 1
            `).get(conversationScopeId);
            const activeShadowTasks = this.database.sqlite.prepare(`
              select * from continuation_tasks
              where conversation_scope_id=? and id<>?
                and state not in ('SUCCEEDED','FAILED_TERMINAL','CANCELLED_BY_USER','ABORTED_NO_PROGRESS','BUDGET_EXHAUSTED','ABANDONED_AUTO_TASK')
              order by updated_at desc
            `).all(conversationScopeId, canonicalTaskId);
            const activeShadowTask = activeShadowTasks[0];
            const activeShadowWorksets = this.database.sqlite.prepare(`
              select id,legacy_task_id from continuation_worksets
              where conversation_scope_id=? and state in ('RUNNING','WAITING_EXTERNAL','SUSPECTED_STALL')
                and coalesce(legacy_task_id,'')<>?
            `).all(conversationScopeId, canonicalTaskId);
            if (preferredActiveWorkset
                && String(preferredActiveWorkset.legacy_task_id ?? '') !== canonicalTaskId) {
                this.database.sqlite.prepare(`
                  update continuation_worksets set legacy_task_id=?,updated_at=? where id=?
                `).run(canonicalTaskId, nowIso, preferredActiveWorkset.id);
            }
            if (activeShadowTasks.length > 0) {
                this.database.sqlite.prepare(`
                  update continuation_tasks set state='ABANDONED_AUTO_TASK',
                    terminal_reason='recovered-canonical-conversation-contract',continuation_pending=0,
                    delivery_token=null,delivery_owner=null,delivery_owner_expires_at=null,
                    watch_process_handles_json='[]',updated_at=?
                  where conversation_scope_id=? and id<>?
                    and state not in ('SUCCEEDED','FAILED_TERMINAL','CANCELLED_BY_USER','ABORTED_NO_PROGRESS','BUDGET_EXHAUSTED','ABANDONED_AUTO_TASK')
                `).run(nowIso, conversationScopeId, canonicalTaskId);
            }
            for (const shadowWorkset of activeShadowWorksets) {
                if (preferredActiveWorkset?.id === shadowWorkset.id) continue;
                this.database.sqlite.prepare(`
                  update continuation_worksets set state='SUPERSEDED',continuation_due_at=null,
                    completed_at=coalesce(completed_at,?),updated_at=? where id=?
                `).run(nowIso, nowIso, shadowWorkset.id);
                this.database.sqlite.prepare(`
                  update continuation_generations set state='SUPERSEDED',closed_at=coalesce(closed_at,?),
                    failure_reason=coalesce(failure_reason,'recovered-canonical-conversation-contract'),updated_at=?
                  where workset_id=? and state not in ('CLOSED','SUPERSEDED','NO_WORK')
                `).run(nowIso, nowIso, shadowWorkset.id);
            }
            this.database.sqlite.prepare(`
              update continuation_conversation_cards set
                mount_state=case
                  when mount_verified_at is not null then 'VERIFIED'
                  when mount_requested_at is not null then 'REQUESTED'
                  else mount_state
                end,
                mount_generation=max(1,mount_generation),
                active_workset_id=case
                  when active_workset_id in (
                    select id from continuation_worksets
                    where conversation_scope_id=? and coalesce(legacy_task_id,'')<>?
                  ) then null else active_workset_id end,
                updated_at=? where conversation_scope_id=?
            `).run(conversationScopeId, canonicalTaskId, nowIso, conversationScopeId);
            let canonical = this.database.sqlite.prepare('select * from continuation_tasks where id=? and conversation_scope_id=?')
                .get(canonicalTaskId, conversationScopeId);
            const latestWorkset = this.database.sqlite.prepare(`
              select w.* from continuation_worksets w
              where w.conversation_scope_id=? and w.legacy_task_id=?
              order by
                case when w.state in ('RUNNING','WAITING_EXTERNAL','SUSPECTED_STALL','PAUSED')
                  and exists (
                    select 1 from continuation_milestones m
                    where m.workset_id=w.id and m.state='PENDING'
                  ) then 0 else 1 end,
                w.sequence desc,w.updated_at desc,w.created_at desc
              limit 1
            `).get(conversationScopeId, canonicalTaskId) ?? lineage;
            const milestoneRows = latestWorkset?.id ? this.database.sqlite.prepare(`
              select * from continuation_milestones
              where workset_id=? and state<>'ARCHIVED'
              order by ordinal asc,created_at asc
            `).all(latestWorkset.id) : [];
            const authoritativeActiveWorkset = Boolean(latestWorkset
                && ['RUNNING','WAITING_EXTERNAL','SUSPECTED_STALL','PAUSED'].includes(String(latestWorkset.state ?? ''))
                && milestoneRows.some((row) => String(row.state) === 'PENDING'));
            const lifetimeMilestoneRows = this.database.sqlite.prepare(`
              select m.* from continuation_milestones m
              join continuation_worksets w on w.id=m.workset_id
              where w.conversation_scope_id=? and w.legacy_task_id=? and m.state<>'ARCHIVED'
              order by w.sequence asc,m.ordinal asc,m.created_at asc
            `).all(conversationScopeId, canonicalTaskId);
            const canonicalRequired = parseJson(canonical?.required_milestones_json, [])
                .map((value) => String(value ?? '').trim()).filter(Boolean);
            const canonicalCompleted = parseJson(canonical?.completed_milestones_json, [])
                .map((value) => String(value ?? '').trim()).filter(Boolean);
            const shadowRequired = parseJson(activeShadowTask?.required_milestones_json, [])
                .map((value) => String(value ?? '').trim()).filter(Boolean);
            const shadowCompleted = parseJson(activeShadowTask?.completed_milestones_json, [])
                .map((value) => String(value ?? '').trim()).filter(Boolean);
            // When a current active Workset exists, it is the authoritative
            // milestone plan for this user/synthetic round.  Historical
            // SUPERSEDED worksets are lineage/audit only and must never be
            // folded back into the active task projection.  Re-merging lifetime
            // rows here caused a manual user message that intentionally switched
            // tasks to resurrect the previous milestones as soon as its fresh
            // card was prepared, which in turn manufactured another workset/card
            // on the next manual message.  Lifetime union remains only as a
            // recovery fallback when no unfinished active Workset exists.
            const isolateCurrentActivePlan = authoritativeActiveWorkset
                && Boolean(canonical)
                && !activeShadowTask;
            const projectedMilestoneRows = isolateCurrentActivePlan
                ? milestoneRows
                : lifetimeMilestoneRows;
            const projectedCanonicalRequired = isolateCurrentActivePlan
                ? []
                : canonicalRequired;
            const requiredMilestones = [...new Set([
                ...projectedCanonicalRequired,
                ...projectedMilestoneRows.map((row) => String(row.description ?? '').trim()).filter(Boolean),
                ...shadowRequired,
                ...hintedRequired,
            ])].slice(0, 64);
            const completedSet = new Set([
                ...(isolateCurrentActivePlan ? [] : canonicalCompleted),
                ...shadowCompleted,
                ...projectedMilestoneRows.filter((row) => String(row.state) === 'COMPLETED')
                    .map((row) => String(row.description ?? '').trim()).filter(Boolean),
                ...hintedCompleted,
            ]);
            const completedMilestones = requiredMilestones.filter((milestone) => completedSet.has(milestone));
            const hasUnfinishedMilestones = requiredMilestones.some((milestone) => !completedSet.has(milestone));
            const stateMap = {
                RUNNING: 'RUNNING', WAITING_EXTERNAL: 'WAITING_EXTERNAL', SUSPECTED_STALL: 'FAILED_RETRYABLE',
                PAUSED: 'PAUSED_BY_USER', SUCCEEDED: 'SUCCEEDED', CANCELLED: 'CANCELLED_BY_USER',
            };
            const recoveredState = hasUnfinishedMilestones
                ? (forceRunning ? 'RUNNING'
                    : String(latestWorkset?.state ?? '') === 'WAITING_EXTERNAL' ? 'WAITING_EXTERNAL'
                        : String(latestWorkset?.state ?? '') === 'PAUSED' ? 'PAUSED_BY_USER'
                            : 'RUNNING')
                : (stateMap[String(latestWorkset?.state ?? '')] ?? 'SUCCEEDED');
            const objective = String(input.objective ?? activeShadowTask?.objective ?? latestWorkset?.objective
                ?? canonical?.objective ?? 'Recovered conversation-lifetime DevSpace task.').trim();
            const workspaceId = String(input.workspaceId ?? activeShadowTask?.workspace_id ?? latestWorkset?.workspace_id
                ?? canonical?.workspace_id ?? '').trim() || null;
            const recoveredEvidence = {
                ...parseJson(canonical?.evidence_json, {}),
                ...parseJson(activeShadowTask?.evidence_json, {}),
                ...(input.evidence && typeof input.evidence === 'object' ? input.evidence : {}),
                canonicalProjectionRecovered: true,
                recoveredAt: nowIso,
                cardId: card.card_id,
                sourceWorksetId: latestWorkset?.id ?? null,
                migratedShadowTaskId: activeShadowTask?.id ?? undefined,
            };
            if (canonical) {
                if (hasUnfinishedMilestones
                    && (forceRunning || activeShadowTask || authoritativeActiveWorkset)) {
                    this.database.sqlite.prepare(`
                      update continuation_tasks set objective=?,workspace_id=coalesce(?,workspace_id),state=?,
                        required_milestones_json=?,completed_milestones_json=?,evidence_json=?,
                        terminal_reason=null,task_source='model-refined',source_tool='architecture-recovery',updated_at=?
                      where id=? and conversation_scope_id=?
                    `).run(objective, workspaceId, recoveredState,
                        JSON.stringify(requiredMilestones), JSON.stringify(completedMilestones), JSON.stringify(recoveredEvidence),
                        nowIso, canonicalTaskId, conversationScopeId);
                    canonical = this.database.sqlite.prepare('select * from continuation_tasks where id=? and conversation_scope_id=?')
                        .get(canonicalTaskId, conversationScopeId);
                }
                return canonical;
            }
            const createdAt = String(lineage.created_at ?? card.created_at ?? nowIso);
            this.database.sqlite.prepare(`
              insert into continuation_tasks(
                id,conversation_scope_id,workspace_id,objective,state,continuation_mode,
                required_milestones_json,completed_milestones_json,evidence_json,
                max_continuations,max_no_progress,max_same_failure,continuation_pending,
                turn_started_at,last_activity_at,last_model_activity_at,task_source,source_tool,contract_version,auto_created,
                substantive_activity_count,turn_lease_id,turn_lease_expires_at,last_anchor_mounted_at,
                coordinator_instance_id,anchor_mount_verified_at,anchor_mount_token,anchor_mount_requested_at,
                anchor_mount_coordinator_id,anchor_mount_generation,delivery_generation,created_at,updated_at
              ) values(?,?,?,?,?,'completion-driven',?,?,?,0,2,2,0,?,?,?,'model-refined','architecture-recovery',?,0,0,null,null,?,?,?,?,?,?,?, ?,?,?)
            `).run(canonicalTaskId, conversationScopeId, workspaceId, objective, recoveredState,
                JSON.stringify(requiredMilestones), JSON.stringify(completedMilestones), JSON.stringify(recoveredEvidence),
                latestWorkset?.last_model_activity_at ?? latestWorkset?.updated_at ?? nowIso,
                latestWorkset?.last_model_activity_at ?? latestWorkset?.updated_at ?? nowIso,
                latestWorkset?.last_model_activity_at ?? latestWorkset?.updated_at ?? nowIso,
                TASK_CONTRACT_VERSION, card.mount_verified_at, card.coordinator_instance_id ?? null,
                card.mount_verified_at, card.mount_token ?? null, card.mount_requested_at ?? null,
                card.coordinator_instance_id ?? null, Math.max(1, Number(card.mount_generation || 1)),
                Math.max(0, Number(latestWorkset?.current_generation || 0)), createdAt, nowIso);
            canonical = this.database.sqlite.prepare('select * from continuation_tasks where id=? and conversation_scope_id=?')
                .get(canonicalTaskId, conversationScopeId);
            return canonical;
        });
        return transaction();
    }
    continuationArchitectureSnapshot(conversationScopeId) {
        const scope = String(conversationScopeId ?? "").trim();
        if (!scope)
            return { card: undefined, worksets: [], milestones: [], generations: [] };
        const card = this.database.sqlite.prepare(`
          select * from continuation_conversation_cards where conversation_scope_id=?
        `).get(scope);
        const worksets = this.database.sqlite.prepare(`
          select * from continuation_worksets where conversation_scope_id=?
          order by sequence asc, created_at asc
        `).all(scope);
        const worksetIds = worksets.map((row) => row.id);
        const milestones = worksetIds.length === 0 ? [] : this.database.sqlite.prepare(`
          select m.* from continuation_milestones m
          join continuation_worksets w on w.id=m.workset_id
          where w.conversation_scope_id=?
          order by w.sequence asc, m.ordinal asc, m.created_at asc
        `).all(scope);
        const generations = worksetIds.length === 0 ? [] : this.database.sqlite.prepare(`
          select g.* from continuation_generations g
          join continuation_worksets w on w.id=g.workset_id
          where w.conversation_scope_id=?
          order by w.sequence asc, g.generation asc
        `).all(scope);
        return { card, worksets, milestones, generations };
    }
    syncContinuationArchitectureForLegacyTask(taskId, input = {}) {
        const id = String(taskId ?? "").trim();
        if (!id)
            return undefined;
        const task = this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(id);
        if (!task || !isCanonicalConversationScope(task.conversation_scope_id))
            return undefined;
        const nowIso = new Date().toISOString();
        const forceNewWorkset = Boolean(input.forceNewWorkset);
        const required = [...new Set(parseJson(task.required_milestones_json, [])
            .map((value) => String(value).trim()).filter(Boolean))];
        const completed = new Set(parseJson(task.completed_milestones_json, [])
            .map((value) => String(value).trim()).filter(Boolean));
        const cardMountState = task.anchor_mount_verified_at
            ? "VERIFIED"
            : task.anchor_mount_requested_at ? "REQUESTED" : "UNMOUNTED";
        const worksetState = task.state === "RUNNING" ? "RUNNING"
            : task.state === "WAITING_EXTERNAL" || task.state === "WAITING_SUPERVISOR" ? "WAITING_EXTERNAL"
                : task.state === "PAUSED_BY_USER" ? "PAUSED"
                    : task.state === "SUCCEEDED" ? "SUCCEEDED"
                        : task.state === "CANCELLED_BY_USER" ? "CANCELLED"
                            : task.state === "FAILED_RETRYABLE" ? "SUSPECTED_STALL"
                                : TERMINAL_CONTINUATION_STATES.has(String(task.state)) ? "ARCHIVED"
                                    : "RUNNING";
        const activeWorksetState = new Set(["RUNNING", "WAITING_EXTERNAL", "SUSPECTED_STALL"]);
        const transaction = this.database.sqlite.transaction(() => {
            this.database.sqlite.prepare(`
              insert into continuation_conversation_cards(
                conversation_scope_id,card_id,schema_epoch,mount_state,mount_token,
                mount_requested_at,mount_verified_at,mount_generation,coordinator_instance_id,
                active_workset_id,created_at,updated_at
              ) values(?, ?, 3, ?, ?, ?, ?, ?, ?, null, ?, ?)
              on conflict(conversation_scope_id) do update set
                card_id=case when
                  excluded.mount_generation>continuation_conversation_cards.mount_generation
                  or (excluded.mount_generation=continuation_conversation_cards.mount_generation and
                    case excluded.mount_state when 'VERIFIED' then 2 when 'REQUESTED' then 1 else 0 end
                    >= case continuation_conversation_cards.mount_state when 'VERIFIED' then 2 when 'REQUESTED' then 1 else 0 end)
                  then excluded.card_id else continuation_conversation_cards.card_id end,
                schema_epoch=3,
                mount_state=case when
                  excluded.mount_generation>continuation_conversation_cards.mount_generation
                  or (excluded.mount_generation=continuation_conversation_cards.mount_generation and
                    case excluded.mount_state when 'VERIFIED' then 2 when 'REQUESTED' then 1 else 0 end
                    >= case continuation_conversation_cards.mount_state when 'VERIFIED' then 2 when 'REQUESTED' then 1 else 0 end)
                  then excluded.mount_state else continuation_conversation_cards.mount_state end,
                mount_token=case when
                  excluded.mount_generation>continuation_conversation_cards.mount_generation
                  or (excluded.mount_generation=continuation_conversation_cards.mount_generation and
                    case excluded.mount_state when 'VERIFIED' then 2 when 'REQUESTED' then 1 else 0 end
                    >= case continuation_conversation_cards.mount_state when 'VERIFIED' then 2 when 'REQUESTED' then 1 else 0 end)
                  then excluded.mount_token else continuation_conversation_cards.mount_token end,
                mount_requested_at=case when
                  excluded.mount_generation>continuation_conversation_cards.mount_generation
                  or (excluded.mount_generation=continuation_conversation_cards.mount_generation and
                    case excluded.mount_state when 'VERIFIED' then 2 when 'REQUESTED' then 1 else 0 end
                    >= case continuation_conversation_cards.mount_state when 'VERIFIED' then 2 when 'REQUESTED' then 1 else 0 end)
                  then excluded.mount_requested_at else continuation_conversation_cards.mount_requested_at end,
                mount_verified_at=case when
                  excluded.mount_generation>continuation_conversation_cards.mount_generation
                  or (excluded.mount_generation=continuation_conversation_cards.mount_generation and
                    case excluded.mount_state when 'VERIFIED' then 2 when 'REQUESTED' then 1 else 0 end
                    >= case continuation_conversation_cards.mount_state when 'VERIFIED' then 2 when 'REQUESTED' then 1 else 0 end)
                  then excluded.mount_verified_at else continuation_conversation_cards.mount_verified_at end,
                mount_generation=max(continuation_conversation_cards.mount_generation,excluded.mount_generation),
                coordinator_instance_id=case when
                  excluded.mount_generation>continuation_conversation_cards.mount_generation
                  or (excluded.mount_generation=continuation_conversation_cards.mount_generation and
                    case excluded.mount_state when 'VERIFIED' then 2 when 'REQUESTED' then 1 else 0 end
                    >= case continuation_conversation_cards.mount_state when 'VERIFIED' then 2 when 'REQUESTED' then 1 else 0 end)
                  then excluded.coordinator_instance_id else continuation_conversation_cards.coordinator_instance_id end,
                updated_at=excluded.updated_at
            `).run(task.conversation_scope_id, `card:${task.conversation_scope_id}:g${Math.max(1, Number(task.anchor_mount_generation || 1))}`,
                cardMountState,
                task.anchor_mount_token ?? null, task.anchor_mount_requested_at ?? null, task.anchor_mount_verified_at ?? null,
                Math.max(1, Number(task.anchor_mount_generation || 1)), task.anchor_mount_coordinator_id ?? null,
                task.created_at || nowIso, nowIso);
            const card = this.database.sqlite.prepare(`
              select * from continuation_conversation_cards where conversation_scope_id=?
            `).get(task.conversation_scope_id);
            let workset = card?.active_workset_id
                ? this.database.sqlite.prepare("select * from continuation_worksets where id=?").get(card.active_workset_id)
                : undefined;
            if (!workset) {
                workset = this.database.sqlite.prepare(`
                  select * from continuation_worksets
                  where conversation_scope_id=? and state in ('RUNNING','WAITING_EXTERNAL','SUSPECTED_STALL')
                  order by sequence desc limit 1
                `).get(task.conversation_scope_id);
            }
            if (!workset && !forceNewWorkset) {
                // Portable owner pause intentionally detaches the active card
                // from a PAUSED workset.  A later owner resume is the same
                // unfinished work, not a new milestone set: reclaim that
                // workset instead of silently allocating a shadow sequence.
                workset = this.database.sqlite.prepare(`
                  select * from continuation_worksets
                  where conversation_scope_id=? and legacy_task_id=? and state='PAUSED'
                  order by sequence desc limit 1
                `).get(task.conversation_scope_id, task.id);
            }
            const reusablePausedWorkset = Boolean(workset
                && !forceNewWorkset
                && String(workset.state) === "PAUSED"
                && String(workset.legacy_task_id) === String(task.id));
            if (forceNewWorkset && workset && activeWorksetState.has(String(workset.state))) {
                this.database.sqlite.prepare(`
                  update continuation_worksets set state='SUPERSEDED',completed_at=?,updated_at=? where id=?
                `).run(nowIso, nowIso, workset.id);
                this.database.sqlite.prepare(`
                  update continuation_generations set state='SUPERSEDED',closed_at=?,failure_reason='manual-new-workset',updated_at=?
                  where workset_id=? and state not in ('CLOSED','SUPERSEDED','NO_WORK')
                `).run(nowIso, nowIso, workset.id);
                workset = undefined;
            }
            if (activeWorksetState.has(worksetState)) {
                if (!workset || (!activeWorksetState.has(String(workset.state)) && !reusablePausedWorkset)) {
                    const sequenceRow = this.database.sqlite.prepare(`
                      select coalesce(max(sequence),0) as sequence from continuation_worksets where conversation_scope_id=?
                    `).get(task.conversation_scope_id);
                    const sequence = Number(sequenceRow?.sequence || 0) + 1;
                    const worksetId = `workset_${randomUUID()}`;
                    this.database.sqlite.prepare(`
                      insert into continuation_worksets(
                        id,conversation_scope_id,legacy_task_id,sequence,workspace_id,objective,state,
                        continuation_due_at,current_generation,last_model_activity_at,created_at,updated_at
                      ) values(?,?,?,?,?,?,?,?,?,?,?,?)
                    `).run(worksetId, task.conversation_scope_id, task.id, sequence, task.workspace_id ?? null,
                        task.objective, worksetState, task.turn_lease_expires_at ?? null,
                        Math.max(1, Number(task.delivery_generation || 1)), task.last_model_activity_at ?? null,
                        nowIso, nowIso);
                    workset = this.database.sqlite.prepare("select * from continuation_worksets where id=?").get(worksetId);
                }
                else {
                    this.database.sqlite.prepare(`
                      update continuation_worksets set legacy_task_id=?,workspace_id=?,objective=?,state=?,
                        continuation_due_at=?,current_generation=max(current_generation,?),last_model_activity_at=?,
                        completed_at=null,updated_at=? where id=?
                    `).run(task.id, task.workspace_id ?? null, task.objective, worksetState,
                        task.turn_lease_expires_at ?? null, Math.max(1, Number(task.delivery_generation || 1)),
                        task.last_model_activity_at ?? null, nowIso, workset.id);
                    workset = this.database.sqlite.prepare("select * from continuation_worksets where id=?").get(workset.id);
                }
                this.database.sqlite.prepare(`
                  update continuation_conversation_cards set active_workset_id=?,updated_at=? where conversation_scope_id=?
                `).run(workset.id, nowIso, task.conversation_scope_id);
            }
            else {
                if (!workset) {
                    workset = this.database.sqlite.prepare(`
                      select * from continuation_worksets where conversation_scope_id=? and legacy_task_id=?
                      order by sequence desc limit 1
                    `).get(task.conversation_scope_id, task.id);
                }
                if (workset) {
                    this.database.sqlite.prepare(`
                      update continuation_worksets set workspace_id=?,objective=?,state=?,continuation_due_at=null,
                        last_model_activity_at=?,completed_at=coalesce(completed_at,?),updated_at=? where id=?
                    `).run(task.workspace_id ?? null, task.objective, worksetState,
                        task.last_model_activity_at ?? null, nowIso, nowIso, workset.id);
                    this.database.sqlite.prepare(`
                      update continuation_generations set state=case when state='SUPERSEDED' then state else 'CLOSED' end,
                        closed_at=coalesce(closed_at,?),updated_at=?
                      where workset_id=? and state not in ('CLOSED','SUPERSEDED','NO_WORK')
                    `).run(nowIso, nowIso, workset.id);
                }
                this.database.sqlite.prepare(`
                  update continuation_conversation_cards set active_workset_id=null,updated_at=? where conversation_scope_id=?
                `).run(nowIso, task.conversation_scope_id);
            }
            if (workset) {
                this.database.sqlite.prepare(`
                  update continuation_milestones set state='ARCHIVED',updated_at=?
                  where workset_id=? and state not in ('COMPLETED','ARCHIVED')
                `).run(nowIso, workset.id);
                const upsertMilestone = this.database.sqlite.prepare(`
                  insert into continuation_milestones(
                    id,workset_id,stable_key,description,state,evidence_json,ordinal,created_at,updated_at,completed_at
                  ) values(?,?,?,?,?,'{}',?,?,?,?)
                  on conflict(workset_id,stable_key) do update set
                    description=excluded.description,state=excluded.state,ordinal=excluded.ordinal,
                    completed_at=excluded.completed_at,updated_at=excluded.updated_at
                `);
                required.forEach((description, ordinal) => {
                    const done = completed.has(description);
                    const stableKey = `legacy:${ordinal}:${description}`;
                    upsertMilestone.run(`milestone_${randomUUID()}`, workset.id, stableKey, description,
                        done ? "COMPLETED" : "PENDING", ordinal, nowIso, nowIso, done ? nowIso : null);
                });
                let generation = Math.max(1, Number(workset.current_generation || task.delivery_generation || 1));
                let existingGeneration = this.database.sqlite.prepare(`
                  select * from continuation_generations where workset_id=? and generation=?
                `).get(workset.id, generation);
                if (reusablePausedWorkset
                    && existingGeneration
                    && ["CLOSED", "SUPERSEDED", "NO_WORK"].includes(String(existingGeneration.state))) {
                    // Pausing intentionally closes the active generation while preserving
                    // the unfinished workset.  A later owner resume must therefore open a
                    // fresh manual generation on that same workset, even when the legacy
                    // delivery counter (notably its 0 -> 1 bootstrap) collides with the
                    // already-closed architecture generation.
                    const maxGenerationRow = this.database.sqlite.prepare(`
                      select coalesce(max(generation),0) as generation
                      from continuation_generations where workset_id=?
                    `).get(workset.id);
                    generation = Math.max(generation + 1, Number(maxGenerationRow?.generation || 0) + 1);
                    this.database.sqlite.prepare(`
                      update continuation_worksets set current_generation=?,updated_at=? where id=?
                    `).run(generation, nowIso, workset.id);
                    this.database.sqlite.prepare(`
                      update continuation_tasks set delivery_generation=max(coalesce(delivery_generation,0),?),updated_at=?
                      where id=?
                    `).run(generation, nowIso, task.id);
                    workset = this.database.sqlite.prepare("select * from continuation_worksets where id=?").get(workset.id);
                    existingGeneration = this.database.sqlite.prepare(`
                      select * from continuation_generations where workset_id=? and generation=?
                    `).get(workset.id, generation);
                }
                if (!existingGeneration) {
                    this.database.sqlite.prepare(`
                      insert into continuation_generations(
                        id,workset_id,generation,owner_type,state,due_at,substantive_baseline_count,
                        substantive_activity_count,last_activity_at,created_at,updated_at
                      ) values(?,?,?,?,?,?,?,?,?,?,?)
                    `).run(`generation:${workset.id}:${generation}`, workset.id, generation, "manual",
                        activeWorksetState.has(worksetState) ? "WORK_REQUIRED" : "CLOSED",
                        task.turn_lease_expires_at ?? null, Number(task.substantive_activity_count || 0),
                        Number(task.substantive_activity_count || 0), task.last_model_activity_at ?? task.updated_at ?? nowIso,
                        nowIso, nowIso);
                }
                else if (input.substantive) {
                    this.database.sqlite.prepare(`
                      update continuation_generations set
                        state=case when owner_type='synthetic' and state='TURN_ACKED' then 'WORK_REQUIRED' else state end,
                        substantive_activity_count=max(substantive_activity_count,?),
                        last_activity_at=?,updated_at=? where id=?
                    `).run(Number(task.substantive_activity_count || 0), task.last_model_activity_at ?? nowIso, nowIso, existingGeneration.id);
                }
            }
            return this.continuationArchitectureSnapshot(task.conversation_scope_id);
        });
        return transaction();
    }
    continuationSupervisorSweep(input = {}) {
        const nowMs = Number.isFinite(Number(input.nowMs)) ? Number(input.nowMs) : Date.now();
        const nowIso = new Date(nowMs).toISOString();
        const candidates = this.database.sqlite.prepare(`
          select w.* from continuation_worksets w
          where w.state in ('RUNNING','SUSPECTED_STALL')
            and exists(
              select 1 from continuation_milestones m
              where m.workset_id=w.id and m.state='PENDING'
            )
            and (
              (w.continuation_due_at is not null and w.continuation_due_at<=?)
              or exists(
                select 1 from continuation_generations g
                where g.workset_id=w.id and g.owner_type='synthetic'
                  and g.state='CLAIMED' and g.due_at is not null and g.due_at<=?
              )
            )
          order by coalesce(w.continuation_due_at, ?) asc
          limit 128
        `).all(nowIso, nowIso, nowIso);
        const ready = [];
        for (const candidate of candidates) {
            const outcome = this.database.sqlite.transaction(() => {
                const current = this.database.sqlite.prepare("select * from continuation_worksets where id=?").get(candidate.id);
                if (!current || !["RUNNING", "SUSPECTED_STALL"].includes(String(current.state)))
                    return undefined;
                const pendingMilestone = this.database.sqlite.prepare(`
                  select 1 as pending from continuation_milestones where workset_id=? and state='PENDING' limit 1
                `).get(current.id);
                if (!pendingMilestone)
                    return undefined;
                const liveSynthetic = this.database.sqlite.prepare(`
                  select * from continuation_generations
                  where workset_id=? and owner_type='synthetic'
                    and state in ('READY','CLAIMED','DELIVERING','DELIVERED','TURN_ACKED','WORK_REQUIRED')
                  order by generation desc limit 1
                `).get(current.id);
                const currentSyntheticDue = liveSynthetic?.due_at ? Date.parse(liveSynthetic.due_at) : NaN;
                const expiredSenderClaim = String(liveSynthetic?.state || "") === "CLAIMED"
                    && Number.isFinite(currentSyntheticDue) && currentSyntheticDue <= nowMs;
                const worksetDue = current.continuation_due_at ? Date.parse(current.continuation_due_at) : NaN;
                if ((!Number.isFinite(worksetDue) || worksetDue > nowMs) && !expiredSenderClaim)
                    return undefined;
                let retryAuthorized = false;
                if (liveSynthetic) {
                    const syntheticOwnerTask = current.legacy_task_id
                        ? this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(current.legacy_task_id)
                        : undefined;
                    const syntheticDue = liveSynthetic.due_at ? Date.parse(liveSynthetic.due_at) : NaN;
                    // CLAIMED is pre-send: if its short claim lease expires,
                    // no app.sendMessage authorization was ever granted and it
                    // is safe to create a replacement generation. DELIVERING is
                    // ambiguous: Host delivery may already be in flight or may
                    // even have succeeded while the result callback was lost.
                    // Retrying DELIVERING from a timer can visibly duplicate the
                    // continuation message, so it must wait for an explicit
                    // delivery result or manual takeover instead of lease expiry.
                    const senderClaimExpired = expiredSenderClaim;
                    const syntheticWorkOwnerExpiresAt = syntheticOwnerTask?.delivery_owner_expires_at
                        ? Date.parse(syntheticOwnerTask.delivery_owner_expires_at) : NaN;
                    const syntheticTurnStartedAt = syntheticOwnerTask?.turn_started_at
                        ? Date.parse(syntheticOwnerTask.turn_started_at) : NaN;
                    const syntheticTurnLeaseId = String(syntheticOwnerTask?.turn_lease_id || "");
                    const syntheticCompletionLeaseId = String(syntheticOwnerTask?.assistant_turn_completion_lease_id || "");
                    const syntheticMode = normalizedContinuationMode(syntheticOwnerTask?.continuation_mode, "compat");
                    const syntheticTurnState = String(syntheticOwnerTask?.assistant_turn_state || "UNKNOWN");
                    const syntheticTurnEnded = ((syntheticMode === "completion-driven"
                        && ["COMPLETED", "TIMED_OUT"].includes(syntheticTurnState))
                        || (syntheticMode === "timeout-recovery" && syntheticTurnState === "TIMED_OUT"))
                        && Boolean(syntheticTurnLeaseId)
                        && syntheticCompletionLeaseId === syntheticTurnLeaseId
                        && String(syntheticOwnerTask?.stall_state || "ACTIVE") === "CONTINUATION_ARMED";
                    // The short synthetic owner lease is only a stale-ownership
                    // detector. Connector discovery, long reasoning, workspace
                    // switching, and other Host-side work are invisible to the
                    // DevSpace request counter and may legitimately exceed it.
                    // Never manufacture a second ChatGPT turn from owner-lease or
                    // request silence alone. The Host exposes no authoritative
                    // distinction between "the model is still reasoning" and
                    // "the assistant turn ended", so any fixed quiet threshold
                    // can preempt a valid multi-minute reasoning interval. Retry
                    // only after the Assistant Turn Completion Contract has a
                    // durable end state for this exact turn lease. A previously
                    // observed Host cutoff remains telemetry only.
                    const abandonedSyntheticWork = ["TURN_ACKED", "WORK_REQUIRED"].includes(String(liveSynthetic.state))
                        && String(syntheticOwnerTask?.delivery_owner || "") === "synthetic-active"
                        && Number.isFinite(syntheticWorkOwnerExpiresAt) && syntheticWorkOwnerExpiresAt <= nowMs
                        && syntheticTurnEnded
                        && !this.continuationModelRequestInFlight(current.conversation_scope_id);
                    const noWork = ["TURN_ACKED", "WORK_REQUIRED"].includes(String(liveSynthetic.state))
                        && Number.isFinite(syntheticDue) && syntheticDue <= nowMs
                        && syntheticTurnEnded
                        && (Number(liveSynthetic.substantive_activity_count || 0) <= Number(liveSynthetic.substantive_baseline_count || 0)
                            || abandonedSyntheticWork)
                        && !this.continuationModelRequestInFlight(current.conversation_scope_id);
                    if (!senderClaimExpired && !noWork)
                        return undefined;
                    const failureReason = senderClaimExpired
                        ? (liveSynthetic.state === "DELIVERING" ? "sender-delivery-expired" : "sender-claim-expired")
                        : abandonedSyntheticWork ? "synthetic-resume-work-lease-expired" : "synthetic-no-substantive-work";
                    const expectedState = String(liveSynthetic.state);
                    this.database.sqlite.prepare(`
                      update continuation_generations set state='NO_WORK',closed_at=?,failure_reason=?,updated_at=?
                      where id=? and state=?
                    `).run(nowIso, failureReason, nowIso, liveSynthetic.id, expectedState);
                    if (current.legacy_task_id && liveSynthetic.delivery_token) {
                        const clearTaskSql = `
                          update continuation_tasks set
                            superseded_delivery_token=coalesce(delivery_token,?,superseded_delivery_token),
                            delivery_token=null,continuation_pending=0,delivery_owner=null,
                            delivery_owner_expires_at=null,delivery_ack_started_at=null,
                            delivery_ack_retry_count=0,delivery_ack_retry_after_at=null,
                            delivery_work_baseline_count=0,updated_at=?
                          where id=? ${senderClaimExpired
                            ? "and delivery_token=? and delivery_owner='synthetic-pending'"
                            : "and ? is not null and delivery_owner='synthetic-active'"}
                        `;
                        this.database.sqlite.prepare(clearTaskSql).run(
                            liveSynthetic.delivery_token,
                            nowIso,
                            current.legacy_task_id,
                            senderClaimExpired ? liveSynthetic.delivery_token : liveSynthetic.delivery_token,
                        );
                    }
                    retryAuthorized = true;
                }
                if (!retryAuthorized) {
                    let legacy = current.legacy_task_id
                        ? this.database.sqlite.prepare(`
                            select * from continuation_tasks where id=?
                          `).get(current.legacy_task_id)
                        : undefined;
                    if (legacy
                        && String(legacy.assistant_turn_state || "") === "COMPLETION_REQUESTED"
                        && normalizedContinuationMode(legacy.continuation_mode, "compat") === "completion-driven") {
                        // Normal ChatGPT finals currently do not emit Apps
                        // resource teardown.  Promote only an explicit,
                        // exact-turn model completion intent after the bounded
                        // handoff grace. GENERATING silence can never enter this
                        // branch, and any in-flight/later model request keeps it
                        // fail-closed.
                        this.promoteMatureAssistantCompletionIntent(legacy.id, nowMs);
                        legacy = this.database.sqlite.prepare(`
                          select * from continuation_tasks where id=?
                        `).get(legacy.id);
                    }
                    const legacyTurnLeaseId = String(legacy?.turn_lease_id || "");
                    const legacyCompletionLeaseId = String(legacy?.assistant_turn_completion_lease_id || "");
                    const legacyMode = normalizedContinuationMode(legacy?.continuation_mode, "compat");
                    const legacyTurnState = String(legacy?.assistant_turn_state || "UNKNOWN");
                    const atccArmed = (legacyMode === "completion-driven"
                        ? ["COMPLETED", "TIMED_OUT"].includes(legacyTurnState)
                        : legacyMode === "timeout-recovery" && legacyTurnState === "TIMED_OUT")
                        && legacy?.state === "RUNNING"
                        && Boolean(legacyTurnLeaseId)
                        && legacyCompletionLeaseId === legacyTurnLeaseId
                        && String(legacy?.stall_state || "ACTIVE") === "CONTINUATION_ARMED";
                    let armed = atccArmed || [2, 3].includes(Number(legacy?.continuation_pending || 0));
                    if (!armed && legacy
                        && legacy.state === "RUNNING"
                        && normalizedContinuationMode(legacy.continuation_mode, "compat") === "completion-driven"
                        && !this.continuationModelRequestInFlight(current.conversation_scope_id)
                        && parseJson(legacy.watch_process_handles_json, []).length === 0) {
                        const turnLeaseExpiresAt = Date.parse(String(legacy.turn_lease_expires_at || ""));
                        const leaseExpired = Number.isFinite(turnLeaseExpiresAt) && nowMs >= turnLeaseExpiresAt;
                        if (leaseExpired && String(legacy.stall_state || "ACTIVE") === "ACTIVE") {
                            // Stage 1 is deliberately non-authorizing. The resident server
                            // may persist the same weak suspicion that a verified Anchor
                            // heartbeat used to record, but it cannot create a generation
                            // until a later sweep confirms continued model quiet.
                            this.database.sqlite.prepare(`
                              update continuation_tasks set
                                stall_state='SUSPECTED_STALL',stall_suspected_at=?,
                                stall_probe_count=1,stall_last_probe_at=?,stall_armed_at=null,
                                stall_evidence='server-turn-lease-expired-no-inflight-model-request',updated_at=?
                              where id=? and state='RUNNING' and continuation_mode='completion-driven'
                                and stall_state='ACTIVE'
                            `).run(nowIso, nowIso, nowIso, legacy.id);
                        }
                        else if (leaseExpired && String(legacy.stall_state || "ACTIVE") === "SUSPECTED_STALL") {
                            // Silence remains diagnostic only. Repeated resident
                            // sweeps refresh the probe without authorizing a new
                            // Host turn. Only explicit current-turn Host/lifecycle
                            // end evidence may advance to ARMED.
                            this.database.sqlite.prepare(`
                              update continuation_tasks set
                                stall_probe_count=stall_probe_count+1,stall_last_probe_at=?,
                                stall_evidence='server-turn-lease-expired-no-inflight-model-request',updated_at=?
                              where id=? and state='RUNNING' and continuation_mode='completion-driven'
                                and stall_state='SUSPECTED_STALL'
                            `).run(nowIso, nowIso, legacy.id);
                        }
                    }
                    if (!armed)
                        return undefined;
                }
                const previous = this.database.sqlite.prepare(`
                  select * from continuation_generations where workset_id=? and generation=?
                `).get(current.id, Number(current.current_generation || 0));
                if (previous && previous.owner_type === "manual" && !["CLOSED", "SUPERSEDED", "NO_WORK"].includes(String(previous.state))) {
                    this.database.sqlite.prepare(`
                      update continuation_generations set state='SUPERSEDED',closed_at=?,failure_reason='watchdog-expired',updated_at=? where id=?
                    `).run(nowIso, nowIso, previous.id);
                }
                const nextGeneration = Math.max(1, Number(current.current_generation || 0) + 1);
                const generationId = `generation:${current.id}:${nextGeneration}`;
                this.database.sqlite.prepare(`
                  insert into continuation_generations(
                    id,workset_id,generation,owner_type,state,due_at,substantive_baseline_count,
                    substantive_activity_count,last_activity_at,created_at,updated_at
                  ) values(?,?,?,'synthetic','READY',?,?,?,?,?,?)
                `).run(generationId, current.id, nextGeneration, nowIso,
                    Number(previous?.substantive_activity_count || 0), Number(previous?.substantive_activity_count || 0),
                    current.last_model_activity_at ?? nowIso, nowIso, nowIso);
                this.database.sqlite.prepare(`
                  update continuation_worksets set state='SUSPECTED_STALL',current_generation=?,updated_at=? where id=?
                `).run(nextGeneration, nowIso, current.id);
                this.appendEvent({
                    kind: "continuation-generation-ready",
                    subject: current.conversation_scope_id,
                    workspaceId: current.workspace_id ?? undefined,
                    payload: { worksetId: current.id, generation: nextGeneration },
                });
                return { conversationScopeId: current.conversation_scope_id, worksetId: current.id, generation: nextGeneration, generationId };
            })();
            if (outcome)
                ready.push(outcome);
        }
        return { scanned: candidates.length, ready };
    }
    claimReadyContinuationGeneration(input = {}) {
        const conversationScopeId = String(input.conversationScopeId ?? "").trim();
        const taskId = String(input.taskId ?? "").trim();
        const senderInstanceId = String(input.senderInstanceId ?? "").trim();
        const anchorMountToken = String(input.anchorMountToken ?? "").trim();
        const anchorMountGeneration = Number(input.anchorMountGeneration || 0);
        if (!conversationScopeId || !taskId || !senderInstanceId || !anchorMountToken || !Number.isInteger(anchorMountGeneration) || anchorMountGeneration <= 0)
            return { accepted: false, reason: "sender-capability-required" };
        const nowMs = Date.now();
        const nowIso = new Date(nowMs).toISOString();
        const claimDueAt = new Date(nowMs + CONTINUATION_SENDER_CLAIM_LEASE_MS).toISOString();
        return this.database.sqlite.transaction(() => {
            const task = this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(taskId);
            if (!task)
                return { accepted: false, reason: "task-not-found" };
            if (String(task.conversation_scope_id || "") !== conversationScopeId)
                return { accepted: false, reason: "conversation-task-mismatch" };
            if (TERMINAL_CONTINUATION_STATES.has(String(task.state || ""))) {
                this.closeTerminalContinuationArtifacts(task.id, task.terminal_reason || task.state, nowIso);
                return { accepted: false, reason: "task-terminal" };
            }
            const card = this.database.sqlite.prepare(`
              select * from continuation_conversation_cards where conversation_scope_id=?
            `).get(conversationScopeId);
            if (!card || !card.mount_requested_at || !card.mount_token || Number(card.mount_generation || 0) <= 0)
                return { accepted: false, reason: "card-not-issued" };
            if (String(card.mount_token || "") !== anchorMountToken)
                return { accepted: false, reason: "sender-mount-token-mismatch" };
            if (Number(card.mount_generation || 0) !== anchorMountGeneration)
                return { accepted: false, reason: "sender-mount-generation-mismatch" };
            if (!card || !card.active_workset_id)
                return { accepted: false, reason: "no-active-workset" };
            const workset = this.database.sqlite.prepare("select * from continuation_worksets where id=?").get(card.active_workset_id);
            if (!workset || String(workset.conversation_scope_id || "") !== conversationScopeId || String(workset.legacy_task_id || "") !== taskId)
                return { accepted: false, reason: "active-workset-task-mismatch" };
            const generation = this.database.sqlite.prepare(`
              select * from continuation_generations
              where workset_id=? and owner_type='synthetic' and state='READY'
              order by generation asc limit 1
            `).get(card.active_workset_id);
            if (!generation)
                return { accepted: false, reason: "no-ready-generation" };
            const deliveryToken = randomUUID();
            const changed = this.database.sqlite.prepare(`
              update continuation_generations set state='CLAIMED',delivery_token=?,claimed_at=?,due_at=?,updated_at=?
              where id=? and state='READY'
            `).run(deliveryToken, nowIso, claimDueAt, nowIso, generation.id);
            if (Number(changed.changes || 0) !== 1)
                return { accepted: false, reason: "generation-race-lost" };
            this.database.sqlite.prepare(`
              update continuation_conversation_cards set sender_instance_id=?,updated_at=? where conversation_scope_id=?
            `).run(senderInstanceId, nowIso, conversationScopeId);
            this.database.sqlite.prepare(`
              update continuation_tasks set
                superseded_delivery_token=coalesce(delivery_token,superseded_delivery_token),
                delivery_token=?,delivery_generation=coalesce(delivery_generation,0)+1,
                delivery_owner='synthetic-pending',delivery_owner_expires_at=?,
                continuation_pending=5,delivery_ack_started_at=null,
                delivery_ack_retry_count=0,delivery_ack_retry_after_at=null,
                delivery_work_baseline_count=0,updated_at=?
              where id=? and conversation_scope_id=?
            `).run(deliveryToken, claimDueAt, nowIso, taskId, conversationScopeId);
            return {
                accepted: true,
                conversationScopeId,
                cardId: card.card_id,
                worksetId: workset.id,
                legacyTaskId: workset.legacy_task_id ?? undefined,
                generation: generation.generation,
                deliveryToken,
                claimDueAt,
            };
        })();
    }
    heartbeatContinuationSender(input = {}) {
        const conversationScopeId = String(input.conversationScopeId ?? "").trim();
        const taskId = String(input.taskId ?? "").trim();
        const anchorMountToken = String(input.anchorMountToken ?? "").trim();
        const anchorMountGeneration = Number(input.anchorMountGeneration || 0);
        if (!conversationScopeId || !taskId || !anchorMountToken || !Number.isInteger(anchorMountGeneration) || anchorMountGeneration <= 0)
            return { accepted: false, reason: "sender-capability-required" };
        const task = this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(taskId);
        if (!task || String(task.conversation_scope_id || "") !== conversationScopeId)
            return { accepted: false, reason: task ? "conversation-task-mismatch" : "task-not-found" };
        const card = this.database.sqlite.prepare(`
          select * from continuation_conversation_cards where conversation_scope_id=?
        `).get(conversationScopeId);
        if (!card || !card.mount_requested_at || !card.mount_token || Number(card.mount_generation || 0) <= 0)
            return { accepted: false, reason: "card-not-issued" };
        if (card.sender_instance_id && String(card.sender_instance_id) !== String(input.senderInstanceId ?? "").trim())
            return { accepted: false, reason: "sender-instance-superseded" };
        if (String(card.mount_token || "") !== anchorMountToken)
            return { accepted: false, reason: "sender-mount-token-mismatch" };
        if (Number(card.mount_generation || 0) !== anchorMountGeneration)
            return { accepted: false, reason: "sender-mount-generation-mismatch" };
        const nowIso = new Date().toISOString();
        this.database.sqlite.prepare(`
          update continuation_tasks set last_ui_heartbeat_at=?,updated_at=? where id=?
        `).run(nowIso, nowIso, taskId);
        // Do not call continuationTask(status) here: a token-less model-side
        // status intentionally means "manual turn took over" when a synthetic
        // delivery is pending. Sender liveness is App control traffic and must
        // never participate in that ownership transition.
        return { accepted: true, lastUiHeartbeatAt: nowIso };
    }
    recordContinuationHostTelemetry(input = {}) {
        const conversationScopeId = String(input.conversationScopeId ?? "").trim();
        const taskId = String(input.taskId ?? "").trim();
        const senderInstanceId = String(input.senderInstanceId ?? "").trim();
        const anchorMountToken = String(input.anchorMountToken ?? "").trim();
        const anchorMountGeneration = Number(input.anchorMountGeneration || 0);
        if (!conversationScopeId || !taskId || !senderInstanceId || !anchorMountToken
            || !Number.isInteger(anchorMountGeneration) || anchorMountGeneration <= 0) {
            return { accepted: false, reason: "sender-capability-required" };
        }
        const task = this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(taskId);
        if (!task || String(task.conversation_scope_id || "") !== conversationScopeId)
            return { accepted: false, reason: task ? "conversation-task-mismatch" : "task-not-found" };
        if (TERMINAL_CONTINUATION_STATES.has(String(task.state || "")))
            return { accepted: false, reason: "task-terminal" };
        const card = this.database.sqlite.prepare(`
          select * from continuation_conversation_cards where conversation_scope_id=?
        `).get(conversationScopeId);
        if (!card || !card.mount_requested_at || !card.mount_token || Number(card.mount_generation || 0) <= 0)
            return { accepted: false, reason: "card-not-issued" };
        if (String(card.sender_instance_id || "") !== senderInstanceId)
            return { accepted: false, reason: "sender-instance-superseded" };
        if (String(card.mount_token || "") !== anchorMountToken)
            return { accepted: false, reason: "sender-mount-token-mismatch" };
        if (Number(card.mount_generation || 0) !== anchorMountGeneration)
            return { accepted: false, reason: "sender-mount-generation-mismatch" };
        const telemetry = input.telemetry && typeof input.telemetry === "object" ? input.telemetry : {};
        const normalizeNames = (value) => Array.isArray(value)
            ? [...new Set(value
                .map((item) => String(item ?? "").trim())
                .filter((item) => /^[A-Za-z0-9._:/-]{1,160}$/.test(item)))]
                .sort()
                .slice(0, 128)
            : [];
        const eventSequence = this.appendEvent({
            kind: "continuation-host-telemetry",
            subject: conversationScopeId,
            workspaceId: task.workspace_id ?? undefined,
            payload: {
                source: "chatgpt-host-surface-v1",
                senderInstanceId,
                anchorMountGeneration,
                openaiKeys: normalizeNames(telemetry.openaiKeys),
                hostContextKeys: normalizeNames(telemetry.hostContextKeys),
                globalsKeys: normalizeNames(telemetry.globalsKeys),
                parentMethods: normalizeNames(telemetry.parentMethods),
            },
        });
        // Observational only. Do not touch continuation_tasks, card/workset
        // ownership, turn leases, Assistant Turn state, or Generation state.
        return { accepted: true, eventSequence };
    }
    authorizeContinuationGenerationDelivery(input = {}) {
        const conversationScopeId = String(input.conversationScopeId ?? "").trim();
        const taskId = String(input.taskId ?? "").trim();
        const senderInstanceId = String(input.senderInstanceId ?? "").trim();
        const anchorMountToken = String(input.anchorMountToken ?? "").trim();
        const anchorMountGeneration = Number(input.anchorMountGeneration || 0);
        const deliveryToken = String(input.deliveryToken ?? "").trim();
        if (!conversationScopeId || !taskId || !senderInstanceId || !anchorMountToken || !deliveryToken
            || !Number.isInteger(anchorMountGeneration) || anchorMountGeneration <= 0) {
            return { accepted: false, reason: "sender-capability-required" };
        }
        const nowMs = Date.now();
        const nowIso = new Date(nowMs).toISOString();
        const deliveryDueAt = new Date(nowMs + CONTINUATION_SENDER_CLAIM_LEASE_MS).toISOString();
        return this.database.sqlite.transaction(() => {
            const task = this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(taskId);
            if (!task)
                return { accepted: false, reason: "task-not-found" };
            if (String(task.conversation_scope_id || "") !== conversationScopeId)
                return { accepted: false, reason: "conversation-task-mismatch" };
            if (TERMINAL_CONTINUATION_STATES.has(String(task.state || ""))) {
                this.closeTerminalContinuationArtifacts(task.id, task.terminal_reason || task.state, nowIso);
                return { accepted: false, reason: "task-terminal" };
            }
            if (String(task.delivery_token || "") !== deliveryToken
                || String(task.delivery_owner || "") !== "synthetic-pending"
                || Number(task.continuation_pending || 0) !== 5) {
                return { accepted: false, reason: "synthetic-ownership-superseded" };
            }
            const card = this.database.sqlite.prepare(`
              select * from continuation_conversation_cards where conversation_scope_id=?
            `).get(conversationScopeId);
            if (!card || !card.mount_requested_at || !card.mount_token || Number(card.mount_generation || 0) <= 0)
                return { accepted: false, reason: "card-not-issued" };
            if (String(card.mount_token || "") !== anchorMountToken)
                return { accepted: false, reason: "sender-mount-token-mismatch" };
            if (Number(card.mount_generation || 0) !== anchorMountGeneration)
                return { accepted: false, reason: "sender-mount-generation-mismatch" };
            if (String(card.sender_instance_id || "") !== senderInstanceId)
                return { accepted: false, reason: "sender-instance-superseded" };
            if (!card.active_workset_id)
                return { accepted: false, reason: "no-active-workset" };
            const workset = this.database.sqlite.prepare("select * from continuation_worksets where id=?").get(card.active_workset_id);
            if (!workset || String(workset.conversation_scope_id || "") !== conversationScopeId
                || String(workset.legacy_task_id || "") !== taskId) {
                return { accepted: false, reason: "active-workset-task-mismatch" };
            }
            const generation = this.database.sqlite.prepare(`
              select * from continuation_generations where workset_id=? and delivery_token=?
            `).get(workset.id, deliveryToken);
            if (!generation)
                return { accepted: false, reason: "delivery-token-not-found" };
            if (String(generation.state || "") !== "CLAIMED")
                return { accepted: false, reason: "delivery-token-not-claimable" };
            const claimDueAt = generation.due_at ? Date.parse(generation.due_at) : NaN;
            if (Number.isFinite(claimDueAt) && claimDueAt <= nowMs)
                return { accepted: false, reason: "sender-claim-expired" };
            const changed = this.database.sqlite.prepare(`
              update continuation_generations set state='DELIVERING',due_at=?,updated_at=?
              where id=? and delivery_token=? and state='CLAIMED'
            `).run(deliveryDueAt, nowIso, generation.id, deliveryToken);
            if (Number(changed.changes || 0) !== 1)
                return { accepted: false, reason: "delivery-authorization-race-lost" };
            return {
                accepted: true,
                conversationScopeId,
                cardId: card.card_id,
                worksetId: workset.id,
                legacyTaskId: workset.legacy_task_id ?? undefined,
                generation: generation.generation,
                deliveryToken,
                deliveryDueAt,
            };
        })();
    }
    recordContinuationGenerationDelivery(input = {}) {
        const deliveryToken = String(input.deliveryToken ?? "").trim();
        if (!deliveryToken)
            return { accepted: false, reason: "delivery-token-required" };
        const result = String(input.result ?? "").trim().toLowerCase();
        if (!result)
            return { accepted: false, reason: "delivery-result-required" };
        const nowMs = Date.now();
        const nowIso = new Date(nowMs).toISOString();
        const dueAt = new Date(nowMs + SYNTHETIC_WORK_OWNER_LEASE_MS).toISOString();
        return this.database.sqlite.transaction(() => {
            const generation = this.database.sqlite.prepare(`
              select g.*,w.legacy_task_id,w.conversation_scope_id,w.id as workset_id
              from continuation_generations g
              join continuation_worksets w on w.id=g.workset_id
              where g.delivery_token=?
            `).get(deliveryToken);
            if (!generation)
                return { accepted: false, reason: "delivery-token-not-found" };
            const legacyTask = generation.legacy_task_id
                ? this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(generation.legacy_task_id)
                : undefined;
            if (legacyTask && TERMINAL_CONTINUATION_STATES.has(String(legacyTask.state || ""))) {
                this.closeTerminalContinuationArtifacts(legacyTask.id, legacyTask.terminal_reason || legacyTask.state, nowIso);
                return {
                    accepted: false,
                    reason: "task-terminal-no-work",
                    terminal: true,
                    generation: this.database.sqlite.prepare("select * from continuation_generations where id=?").get(generation.id),
                };
            }
            const acceptedDelivery = result === "accepted" || result === "fallback-accepted";
            if (acceptedDelivery) {
                const changed = this.database.sqlite.prepare(`
                  update continuation_generations set state='WORK_REQUIRED',delivered_at=coalesce(delivered_at,?),
                    due_at=?,updated_at=? where delivery_token=? and state='DELIVERING'
                `).run(nowIso, dueAt, nowIso, deliveryToken);
                if (Number(changed.changes || 0) !== 1)
                    return { accepted: false, reason: "delivery-token-not-claimable" };
                if (generation.legacy_task_id) {
                    this.database.sqlite.prepare(`
                      update continuation_tasks set last_send_attempt_at=?,last_send_result=?,
                        continuation_pending=5,delivery_owner='synthetic-pending',delivery_owner_expires_at=?,updated_at=?
                      where id=? and delivery_token=?
                    `).run(nowIso, JSON.stringify({ result, method: input.method ?? undefined, note: input.note ?? undefined }),
                        dueAt, nowIso, generation.legacy_task_id, deliveryToken);
                }
                return {
                    accepted: true,
                    generation: this.database.sqlite.prepare("select * from continuation_generations where delivery_token=?").get(deliveryToken),
                };
            }
            if (result === "unknown") {
                // DELIVERING is an outcome-uncertain zone. The Host may have
                // accepted app.sendMessage even when its result callback was
                // lost. Retrying from an unknown result can visibly duplicate
                // the continuation, so preserve the same generation and wait
                // for manual takeover or an explicit accepted/rejected/failed
                // result instead of manufacturing another READY generation.
                if (generation.legacy_task_id) {
                    this.database.sqlite.prepare(`
                      update continuation_tasks set last_send_attempt_at=?,last_send_result=?,updated_at=?
                      where id=? and delivery_token=?
                    `).run(nowIso, JSON.stringify({ result, method: input.method ?? undefined, note: input.note ?? undefined }),
                        nowIso, generation.legacy_task_id, deliveryToken);
                }
                return {
                    accepted: true,
                    retryRequired: false,
                    outcomeUncertain: true,
                    generation: this.database.sqlite.prepare("select * from continuation_generations where delivery_token=?").get(deliveryToken),
                };
            }
            const changed = this.database.sqlite.prepare(`
              update continuation_generations set state='NO_WORK',closed_at=?,failure_reason=?,updated_at=?
              where delivery_token=? and state in ('CLAIMED','DELIVERING','DELIVERED','TURN_ACKED','WORK_REQUIRED')
            `).run(nowIso, `delivery-${result}`, nowIso, deliveryToken);
            if (Number(changed.changes || 0) !== 1)
                return { accepted: false, reason: "delivery-token-not-claimable" };
            if (generation.legacy_task_id) {
                this.database.sqlite.prepare(`
                  update continuation_tasks set
                    superseded_delivery_token=coalesce(delivery_token,superseded_delivery_token),
                    delivery_token=null,continuation_pending=0,delivery_owner=null,
                    delivery_owner_expires_at=null,delivery_ack_started_at=null,
                    delivery_ack_retry_count=0,delivery_ack_retry_after_at=null,
                    delivery_work_baseline_count=0,last_send_attempt_at=?,last_send_result=?,
                    stall_state='CONTINUATION_ARMED',stall_armed_at=?,
                    stall_evidence='host-delivery-rejected',updated_at=?
                  where id=? and delivery_token=?
                `).run(nowIso, JSON.stringify({ result, method: input.method ?? undefined, note: input.note ?? undefined }),
                    nowIso, nowIso, generation.legacy_task_id, deliveryToken);
            }
            this.database.sqlite.prepare(`
              update continuation_worksets set state='SUSPECTED_STALL',continuation_due_at=?,updated_at=? where id=?
            `).run(nowIso, nowIso, generation.workset_id);
            return { accepted: true, retryRequired: true, result };
        })();
    }
    markContinuationGenerationDelivered(input = {}) {
        return this.recordContinuationGenerationDelivery({ ...input, result: "accepted" });
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
        if (!conversationScopeId)
            return undefined;
        const nowIso = new Date().toISOString();
        const row = isCanonicalConversationScope(conversationScopeId)
            ? this.database.sqlite.prepare(`
              select * from continuation_tasks
              where conversation_scope_id=?
                and state not in ('SUCCEEDED','FAILED_TERMINAL','CANCELLED_BY_USER','ABORTED_NO_PROGRESS','BUDGET_EXHAUSTED','ABANDONED_AUTO_TASK')
              order by updated_at desc limit 1
            `).get(conversationScopeId)
            : workspaceId ? this.database.sqlite.prepare(`
              select * from continuation_tasks
              where workspace_id=? and conversation_scope_id=?
                and state not in ('SUCCEEDED','FAILED_TERMINAL','CANCELLED_BY_USER','ABORTED_NO_PROGRESS','BUDGET_EXHAUSTED','ABANDONED_AUTO_TASK')
              order by updated_at desc limit 1
            `).get(workspaceId, conversationScopeId) : undefined;
        if (!row)
            return undefined;
        const substantiveIncrement = input.substantive === false ? 0 : 1;
        const syntheticOwnerActive = substantiveIncrement > 0
            && ["synthetic-pending", "synthetic-active"].includes(String(row.delivery_owner || ""));
        const syntheticOwnerExpiresAt = syntheticOwnerActive
            ? new Date(Date.now() + SYNTHETIC_WORK_OWNER_LEASE_MS).toISOString()
            : row.delivery_owner_expires_at;
        const turnLeaseExpiresAt = new Date(Date.now() + COMPLETION_STALL_SUSPECT_MS).toISOString();
        this.database.sqlite.prepare(`
          update continuation_tasks
          set workspace_id=coalesce(?,workspace_id), last_model_activity_at=?, last_activity_at=?,
              substantive_activity_count=coalesce(substantive_activity_count,0)+?,
              delivery_owner_expires_at=?,
              assistant_turn_state=case
                when continuation_mode='completion-driven' and assistant_turn_state='COMPLETION_REQUESTED'
                  then 'GENERATING'
                else assistant_turn_state
              end,
              assistant_turn_completion_lease_id=case
                when continuation_mode='completion-driven' and assistant_turn_state='COMPLETION_REQUESTED'
                  then null
                else assistant_turn_completion_lease_id
              end,
              assistant_turn_completion_requested_at=case
                when continuation_mode='completion-driven' and assistant_turn_state='COMPLETION_REQUESTED'
                  then null
                else assistant_turn_completion_requested_at
              end,
              assistant_turn_completed_at=case
                when continuation_mode='completion-driven' and assistant_turn_state='COMPLETION_REQUESTED'
                  then null
                else assistant_turn_completed_at
              end,
              assistant_turn_completion_source=case
                when continuation_mode='completion-driven' and assistant_turn_state='COMPLETION_REQUESTED'
                  then null
                else assistant_turn_completion_source
              end,
              assistant_turn_completion_note=case
                when continuation_mode='completion-driven' and assistant_turn_state='COMPLETION_REQUESTED'
                  then null
                else assistant_turn_completion_note
              end,
              turn_lease_expires_at=case when continuation_mode='completion-driven' then ? else turn_lease_expires_at end,
              stall_state=case when continuation_mode='completion-driven' then 'ACTIVE' else stall_state end,
              stall_suspected_at=case when continuation_mode='completion-driven' then null else stall_suspected_at end,
              stall_probe_count=case when continuation_mode='completion-driven' then 0 else stall_probe_count end,
              stall_last_probe_at=case when continuation_mode='completion-driven' then null else stall_last_probe_at end,
              stall_armed_at=case when continuation_mode='completion-driven' then null else stall_armed_at end,
              stall_evidence=case when continuation_mode='completion-driven' then null else stall_evidence end,
              updated_at=?
          where id=?
        `).run(workspaceId || null, nowIso, nowIso, substantiveIncrement,
            syntheticOwnerExpiresAt, turnLeaseExpiresAt, nowIso, row.id);
        if (substantiveIncrement > 0 && !syntheticOwnerActive) {
            this.database.sqlite.transaction(() => {
                const card = this.database.sqlite.prepare(`
                  select * from continuation_conversation_cards where conversation_scope_id=?
                `).get(row.conversation_scope_id);
                if (!card?.active_workset_id)
                    return;
                const workset = this.database.sqlite.prepare("select * from continuation_worksets where id=?").get(card.active_workset_id);
                if (!workset)
                    return;
                const ready = this.database.sqlite.prepare(`
                  select * from continuation_generations
                  where workset_id=? and owner_type='synthetic' and state='READY'
                  order by generation desc limit 1
                `).get(workset.id);
                if (!ready)
                    return;
                const superseded = this.database.sqlite.prepare(`
                  update continuation_generations
                  set state='SUPERSEDED',closed_at=?,failure_reason='manual-substantive-work-before-sender-claim',updated_at=?
                  where id=? and state='READY'
                `).run(nowIso, nowIso, ready.id);
                if (Number(superseded.changes || 0) !== 1)
                    return;
                const nextGeneration = Math.max(
                    Number(workset.current_generation || 0),
                    Number(ready.generation || 0),
                    Number(row.delivery_generation || 0),
                ) + 1;
                this.database.sqlite.prepare(`
                  update continuation_worksets
                  set current_generation=?,state='RUNNING',continuation_due_at=?,last_model_activity_at=?,updated_at=?
                  where id=?
                `).run(nextGeneration, turnLeaseExpiresAt, nowIso, nowIso, workset.id);
                this.database.sqlite.prepare(`
                  update continuation_tasks set
                    continuation_pending=0,delivery_owner='manual',delivery_token=null,
                    delivery_owner_expires_at=null,delivery_generation=?,
                    manual_takeover_at=?,delivery_ack_started_at=null,delivery_ack_retry_count=0,
                    delivery_ack_retry_after_at=null,delivery_work_baseline_count=0,
                    superseded_delivery_token=coalesce(delivery_token,superseded_delivery_token),updated_at=?
                  where id=?
                `).run(nextGeneration, nowIso, nowIso, row.id);
            })();
        }
        this.syncContinuationArchitectureForLegacyTask(row.id, {
            substantive: substantiveIncrement > 0,
        });
        return row.id;
    }
    prepareContinuationAnchorMount(input = {}) {
        const taskId = String(input.taskId ?? "").trim();
        const conversationScopeId = String(input.conversationScopeId ?? "").trim();
        const hostTurnFingerprint = String(input.hostTurnFingerprint ?? "").trim() || undefined;
        if (!taskId || !conversationScopeId)
            return { task: undefined, accepted: false, reason: "task-and-conversation-required" };
        const row = this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(taskId);
        if (!row || (row.conversation_scope_id && row.conversation_scope_id !== conversationScopeId))
            return { task: undefined, accepted: false, reason: "task-conversation-mismatch" };
        const status = this.continuationTask({
            action: "status",
            taskId,
            conversationScopeId,
            internalAnchorPreparation: true,
        });
        if (row.anchor_mount_verified_at && !anchorMountRecoveryRequired(row, Date.now(), hostTurnFingerprint)) {
            return { ...status, accepted: true, alreadyVerified: true };
        }
        const nowMs = Date.now();
        const nowIso = new Date(nowMs).toISOString();
        if (row.anchor_mount_requested_at) {
            return {
                ...status,
                accepted: false,
                reason: "anchor-mount-verification-pending",
                alreadyRequested: true,
                alreadyVerified: false,
                anchorMountGeneration: Math.max(1, Number(row.anchor_mount_generation || 1)),
            };
        }
        const token = row.anchor_mount_token || randomUUID();
        const requestedAt = nowIso;
        const previousGeneration = Math.max(0, Number(row.anchor_mount_generation || 0));
        const generation = Math.max(1, previousGeneration || 1);
        // Legacy host-turn hashes may exist in upgraded databases, but they no
        // longer participate in issuance identity. Preserve the first value only
        // for forensic compatibility; never rotate because a later model turn
        // presents a different fingerprint.
        const storedHostTurnFingerprint = row.anchor_mount_host_turn_hash ?? hostTurnFingerprint ?? null;
        this.database.sqlite.prepare(`
          update continuation_tasks
          set anchor_mount_token=?, anchor_mount_requested_at=?, anchor_mount_generation=?,
              anchor_mount_host_turn_hash=?,
              anchor_mount_verified_at=anchor_mount_verified_at,
              anchor_mount_coordinator_id=anchor_mount_coordinator_id,
              anchor_lease_expires_at=anchor_lease_expires_at,
              coordinator_instance_id=coordinator_instance_id,
              last_ui_heartbeat_at=last_ui_heartbeat_at,
              updated_at=?
          where id=?
        `).run(token, requestedAt, generation, storedHostTurnFingerprint,
            nowIso, taskId);
        // Persist the one-shot issuance into the architecture card immediately.
        // Waiting for the iframe ACK here leaves the card row UNMOUNTED even
        // though the Host already owns a visible tool result, which can make
        // later transports treat the conversation as if no card had ever been
        // issued and can trigger shadow-task/second-card recovery paths.
        this.syncContinuationArchitectureForLegacyTask(taskId);
        return {
            ...this.continuationTask({
                action: "status",
                taskId,
                conversationScopeId,
                hostTurnFingerprint,
                internalAnchorPreparation: true,
            }),
            accepted: true,
            anchorMountToken: token,
            anchorMountGeneration: generation,
            alreadyVerified: false,
            recoveryRetry: false,
        };
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
        if (!conversationScopeId)
            return { task: undefined, created: false, accepted: false, reason: "conversation-required" };
        this.reapAbandonedContinuationTasks();
        const now = new Date();
        const nowIso = now.toISOString();
        if (isCanonicalConversationScope(conversationScopeId)) {
            this.recoverCanonicalConversationTaskProjection({
                conversationScopeId,
                workspaceId,
                objective: input.objective,
                requiredMilestones: input.requiredMilestones,
                forceRunning: Boolean(input.substantive),
            });
        }
        const existing = isCanonicalConversationScope(conversationScopeId)
            ? this.database.sqlite.prepare(`
              select * from continuation_tasks
              where conversation_scope_id=?
              order by
                case when state not in ('SUCCEEDED','FAILED_TERMINAL','CANCELLED_BY_USER','ABORTED_NO_PROGRESS','BUDGET_EXHAUSTED','ABANDONED_AUTO_TASK') then 0 else 1 end,
                case when anchor_mount_verified_at is not null then 0 else 1 end,
                updated_at desc
              limit 1
            `).get(conversationScopeId)
            : workspaceId ? this.database.sqlite.prepare(`
              select * from continuation_tasks
              where workspace_id=? and conversation_scope_id=?
                and state not in ('SUCCEEDED','FAILED_TERMINAL','CANCELLED_BY_USER','ABORTED_NO_PROGRESS','BUDGET_EXHAUSTED','ABANDONED_AUTO_TASK')
              order by updated_at desc limit 1
            `).get(workspaceId, conversationScopeId) : undefined;
        if (existing) {
            if (input.substantive) {
                this.touchContinuationModelActivity({ workspaceId, conversationScopeId, substantive: true });
            }
            else if (workspaceId && isCanonicalConversationScope(conversationScopeId) && existing.workspace_id !== workspaceId) {
                this.database.sqlite.prepare("update continuation_tasks set workspace_id=?, updated_at=? where id=?")
                    .run(workspaceId, nowIso, existing.id);
                this.syncContinuationArchitectureForLegacyTask(existing.id);
            }
            const status = this.continuationTask({ action: "status", taskId: existing.id, ...(workspaceId ? { workspaceId } : {}), conversationScopeId, hostTurnFingerprint: input.hostTurnFingerprint });
            return {
                ...status,
                created: false,
                taskContract: true,
                conversationLifetimeTaskContract: isCanonicalConversationScope(conversationScopeId),
                conversationLifetimeSingleton: false,
                manualRoundCardRequired: anchorMountRecoveryRequired(existing, now.getTime(), input.hostTurnFingerprint),
                newMilestoneRequired: TERMINAL_CONTINUATION_STATES.has(String(status.task?.state ?? "")),
                initialAnchorRequired: anchorMountRecoveryRequired(existing, now.getTime(), input.hostTurnFingerprint),
                anchorMountVerificationPending: !existing.anchor_mount_verified_at && Boolean(existing.anchor_mount_requested_at),
            };
        }
        const required = Array.isArray(input.requiredMilestones)
            ? [...new Set(input.requiredMilestones.map((value) => String(value).trim()).filter(Boolean))].slice(0, 64)
            : [];
        const milestones = required.length > 0 ? required : DEFAULT_TASK_CONTRACT_MILESTONES;
        const id = `task_${randomUUID()}`;
        const sourceTool = String(input.sourceTool ?? "open_workspace").trim().slice(0, 120) || "open_workspace";
        const turnLeaseId = `turn_${randomUUID()}`;
        const turnLeaseExpiresAt = new Date(now.getTime() + COMPLETION_STALL_SUSPECT_MS).toISOString();
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
        `).run(id, conversationScopeId, workspaceId || null,
            String(input.objective ?? "Complete the original user-requested DevSpace work and verify the result before ending the task."),
            JSON.stringify(milestones),
            Math.max(1, Math.min(Number(input.maxNoProgress ?? 3), 20)),
            Math.max(1, Math.min(Number(input.maxSameFailure ?? 3), 20)),
            nowIso, nowIso, nowIso, sourceTool, TASK_CONTRACT_VERSION,
            input.substantive ? 1 : 0, turnLeaseId, turnLeaseExpiresAt, nowIso, nowIso);
        this.syncContinuationArchitectureForLegacyTask(id, { substantive: Boolean(input.substantive) });
        const status = this.continuationTask({ action: "status", taskId: id, ...(workspaceId ? { workspaceId } : {}), conversationScopeId, hostTurnFingerprint: input.hostTurnFingerprint });
        return {
            ...status,
            created: true,
            taskContract: true,
            needsRefinement: required.length === 0,
            conversationLifetimeTaskContract: isCanonicalConversationScope(conversationScopeId),
            conversationLifetimeSingleton: false,
            manualRoundCardRequired: true,
            initialAnchorRequired: true,
        };
    }
    continuationSupervisorDirective(input = {}) {
        const workspaceId = String(input.workspaceId ?? "").trim();
        const conversationScopeId = String(input.conversationScopeId ?? "").trim();
        if (!conversationScopeId)
            return undefined;
        const row = isCanonicalConversationScope(conversationScopeId)
            ? this.database.sqlite.prepare(`
              select * from continuation_tasks
              where conversation_scope_id=?
                and state not in ('SUCCEEDED','FAILED_TERMINAL','CANCELLED_BY_USER','ABORTED_NO_PROGRESS','BUDGET_EXHAUSTED','ABANDONED_AUTO_TASK')
              order by updated_at desc limit 1
            `).get(conversationScopeId)
            : workspaceId ? this.database.sqlite.prepare(`
              select * from continuation_tasks
              where workspace_id=? and conversation_scope_id=?
                and state not in ('SUCCEEDED','FAILED_TERMINAL','CANCELLED_BY_USER','ABORTED_NO_PROGRESS','BUDGET_EXHAUSTED','ABANDONED_AUTO_TASK')
              order by updated_at desc limit 1
            `).get(workspaceId, conversationScopeId) : undefined;
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
        const activeTurnNeedsSupervisor = row.state === "RUNNING"
            && (unfinished || anchorMountRecoveryRequired(row, Date.now(), input.hostTurnFingerprint));
        const residentWaitNeedsSupervisor = continuationMode === "resident"
            && ["WAITING_EXTERNAL", "WAITING_SUPERVISOR"].includes(row.state)
            && watchedHandles.length > 0;
        if (!activeTurnNeedsSupervisor && !residentWaitNeedsSupervisor)
            return undefined;
        // Each manual user round gets one UI-bearing anchor. Synthetic
        // continuations, reconnects and workspace switches stay on that same
        // generation; a later explicit manual-round status rotates the slot.
        // Within the current round, a requested card is never duplicated.
        if (!anchorMountRecoveryRequired(row, Date.now(), input.hostTurnFingerprint))
            return undefined;
        return {
            taskId: row.id,
            workspaceId: row.workspace_id ?? (workspaceId || undefined),
            continuationMode,
            reanchorRequired: true,
            initialAnchorRequired: true,
            reason: "initial-anchor-required",
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
        const completionTurnLeaseExpiresAt = () => new Date(now.getTime() + COMPLETION_STALL_SUSPECT_MS).toISOString();
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
            assistantTurnState: row.assistant_turn_state ?? "UNKNOWN",
            assistantTurnOwner: row.assistant_turn_owner ?? undefined,
            assistantTurnCompletionLeaseId: row.assistant_turn_completion_lease_id ?? undefined,
            assistantTurnCompletionRequestedAt: row.assistant_turn_completion_requested_at ?? undefined,
            assistantTurnCompletedAt: row.assistant_turn_completed_at ?? undefined,
            assistantTurnCompletionSource: row.assistant_turn_completion_source ?? undefined,
            assistantTurnCompletionNote: row.assistant_turn_completion_note ?? undefined,
            lastContinuationAt: row.last_continuation_at ?? undefined,
            lastActivityAt: row.last_activity_at ?? undefined,
            lastModelActivityAt: row.last_model_activity_at ?? undefined,
            lastUiHeartbeatAt: row.last_ui_heartbeat_at ?? undefined,
            lastSendAttemptAt: row.last_send_attempt_at ?? undefined,
            lastSendResult: row.last_send_result ? parseJson(row.last_send_result, row.last_send_result) : undefined,
            deliveryAckStartedAt: row.delivery_ack_started_at ?? undefined,
            deliveryAckRetryCount: Number(row.delivery_ack_retry_count ?? 0),
            deliveryAckRetryAfterAt: row.delivery_ack_retry_after_at ?? undefined,
            deliveryGeneration: Number(row.delivery_generation ?? 0),
            deliveryToken: row.delivery_token ?? undefined,
            deliveryOwner: row.delivery_owner ?? undefined,
            syntheticResumeWorkRequired: row.delivery_owner === "synthetic-active",
            deliveryOwnerExpiresAt: row.delivery_owner_expires_at ?? undefined,
            deliveryWorkBaselineCount: Number(row.delivery_work_baseline_count ?? 0),
            manualTakeoverAt: row.manual_takeover_at ?? undefined,
            coordinatorInstanceId: row.coordinator_instance_id ?? undefined,
            hostProfileId: row.host_profile_id ?? undefined,
            observedTurnBudgetMs: row.observed_turn_budget_ms ?? undefined,
            recommendedContinueAfterMs: row.recommended_continue_after_ms ?? undefined,
            hostTimeoutSamples: row.host_timeout_samples ?? 0,
            confirmedTurnLimitMs: row.confirmed_turn_limit_ms ?? undefined,
            confirmedTurnLimitAt: row.confirmed_turn_limit_at ?? undefined,
            confirmedTurnLimitSource: row.confirmed_turn_limit_source ?? undefined,
            cutoffSamples: numericSamples(row.cutoff_samples_json),
            cutoffEpoch: Number(row.cutoff_epoch ?? 0),
            cutoffRegimeChangedAt: row.cutoff_regime_changed_at ?? undefined,
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
            stallState: row.stall_state ?? "ACTIVE",
            stallSuspectedAt: row.stall_suspected_at ?? undefined,
            stallProbeCount: Number(row.stall_probe_count ?? 0),
            stallLastProbeAt: row.stall_last_probe_at ?? undefined,
            stallArmedAt: row.stall_armed_at ?? undefined,
            stallEvidence: row.stall_evidence ?? undefined,
            lastAnchorMountedAt: row.last_anchor_mounted_at ?? undefined,
            anchorLeaseExpiresAt: row.anchor_lease_expires_at ?? undefined,
            anchorMountVerifiedAt: row.anchor_mount_verified_at ?? undefined,
            anchorMountRequestedAt: row.anchor_mount_requested_at ?? undefined,
            anchorMountCoordinatorId: row.anchor_mount_coordinator_id ?? undefined,
            anchorMountGeneration: Math.max(0, Number(row.anchor_mount_generation ?? 0)),
            anchorMountRecoveryRequired: anchorMountRecoveryRequired(row, now.getTime(), input.hostTurnFingerprint),
            anchorMountVerificationPending: !row.anchor_mount_verified_at && Boolean(row.anchor_mount_requested_at),
            anchorMountProvisionalUntil: anchorMountProvisionalUntil(row),
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
            // Only an unissued current manual round can request its one
            // UI-bearing anchor. Synthetic continuations, verification-pending
            // and verified states stay headless until the next manual-round
            // rotation explicitly resets these mount fields.
            return anchorMountRecoveryRequired(row, now.getTime(), input.hostTurnFingerprint);
        };
        const continuationDirective = (task) => {
            if (!task) return {
                continueRequired: false,
                continueInSameTurn: false,
                syntheticWorkMustContinue: false,
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
            const syntheticWorkMustContinue = continueRequired
                && String(task.deliveryOwner || "") === "synthetic-active"
                && task.assistantTurnState !== "COMPLETION_REQUESTED";
            const normalTurnCompletionRequested = continueRequired
                && task.assistantTurnState === "COMPLETION_REQUESTED";
            return {
                continueRequired,
                continueInSameTurn: syntheticWorkMustContinue,
                syntheticWorkMustContinue,
                nextRequiredMilestones: continueRequired ? remainingMilestones : [],
                taskIncomplete,
                remainingMilestones,
                // A normal model-driven stage boundary becomes legal only after
                // the model explicitly signs the Assistant Turn Completion
                // Contract for the current turn lease. The Host still must
                // confirm lifecycle teardown before a continuation can be sent.
                finalResponseAllowed: !taskIncomplete || blocked || normalTurnCompletionRequested,
            };
        };
        // checkpoint is the authoritative mutation boundary for its required /
        // completed milestone deltas and evidence. Feeding those same values
        // into canonical projection recovery first would pre-apply the delta,
        // making the checkpoint unable to detect a milestone-set revision or
        // any other material progress. Keep projection recovery structural on
        // checkpoint calls; the action-specific block below performs the merge.
        const checkpointOwnsMutation = action === "checkpoint";
        const recoveredCanonicalProjection = this.recoverCanonicalConversationTaskProjection({
            conversationScopeId: input.conversationScopeId,
            taskId: input.taskId,
            workspaceId: input.workspaceId,
            objective: input.objective,
            requiredMilestones: checkpointOwnsMutation ? undefined : input.requiredMilestones,
            completedMilestones: checkpointOwnsMutation ? undefined : input.completedMilestones,
            evidence: checkpointOwnsMutation ? undefined : input.evidence,
            // Do not let projection recovery pre-reactivate a terminal lifetime
            // task for explicit begin/begin-auto.  The begin state machine below
            // must still observe the terminal row so it can rotate exactly one
            // fresh manual-round card (or keep begin-auto terminal/no-work).
            // Active/shadow Worksets are still recovered as RUNNING by the
            // authoritativeActiveWorkset path inside projection recovery.
            forceRunning: false,
        });
        const find = () => {
            if (recoveredCanonicalProjection && (
                action === 'begin' || action === 'begin-auto' || !input.taskId ||
                String(input.taskId) === String(recoveredCanonicalProjection.id)
            )) {
                return this.database.sqlite.prepare('select * from continuation_tasks where id=?').get(recoveredCanonicalProjection.id);
            }
            if (input.taskId) {
                const taskId = String(input.taskId);
                const conversationScopeId = input.conversationScopeId ? String(input.conversationScopeId) : undefined;
                const workspaceId = input.workspaceId ? String(input.workspaceId) : undefined;
                if (conversationScopeId && workspaceId) {
                    if (isCanonicalConversationScope(conversationScopeId)) {
                        return this.database.sqlite.prepare("select * from continuation_tasks where id=? and conversation_scope_id=?")
                            .get(taskId, conversationScopeId);
                    }
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
                if (isCanonicalConversationScope(input.conversationScopeId)) {
                    return this.database.sqlite.prepare(`
                      select * from continuation_tasks
                      where conversation_scope_id=?
                      order by
                        case when state not in ('SUCCEEDED','FAILED_TERMINAL','CANCELLED_BY_USER','ABORTED_NO_PROGRESS','BUDGET_EXHAUSTED','ABANDONED_AUTO_TASK') then 0 else 1 end,
                        case when anchor_mount_verified_at is not null then 0 else 1 end,
                        updated_at desc
                      limit 1
                    `).get(String(input.conversationScopeId));
                }
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
            let row = find();
            const deliveryToken = input.deliveryToken ? String(input.deliveryToken) : "";
            const manualTakeover = input.manualTakeover === true
                || String(input.note ?? "").trim() === "manual-user-turn-takeover";
            // dev12 manual-round priority contract: when the first status of a
            // real user message supplies a new milestone plan, commit that plan
            // before issuing the message's fresh card.  This keeps "manual
            // takeover + different task" atomic: the user never sees an old
            // milestone card followed by a second correction card, and any
            // automatic generation belongs to the superseded workset.
            const applyManualRoundPlan = (currentRow) => {
                if (!currentRow || !manualTakeover || deliveryToken || input.internalAnchorPreparation === true)
                    return { row: currentRow, milestoneSetChanged: false };
                const suppliedRequired = [...new Set((Array.isArray(input.requiredMilestones) ? input.requiredMilestones : [])
                    .map((value) => String(value).trim()).filter(Boolean))].slice(0, 64);
                const existingRequired = parseJson(currentRow.required_milestones_json, [])
                    .map((value) => String(value).trim()).filter(Boolean);
                const milestoneSetChanged = suppliedRequired.length > 0
                    && JSON.stringify(suppliedRequired) !== JSON.stringify(existingRequired);
                const suppliedObjective = input.objective === undefined
                    ? ""
                    : String(input.objective).trim().slice(0, 4000);
                const objectiveChanged = Boolean(suppliedObjective)
                    && suppliedObjective !== String(currentRow.objective || "");
                if (!milestoneSetChanged && !objectiveChanged)
                    return { row: currentRow, milestoneSetChanged: false };
                const nextRequired = milestoneSetChanged ? suppliedRequired : existingRequired;
                const nextRequiredSet = new Set(nextRequired);
                const nextCompleted = parseJson(currentRow.completed_milestones_json, [])
                    .map((value) => String(value).trim()).filter((value) => nextRequiredSet.has(value));
                this.database.sqlite.prepare(`
                  update continuation_tasks set
                    objective=?,required_milestones_json=?,completed_milestones_json=?,
                    progress_fingerprint=null,failure_fingerprint=null,
                    no_progress_count=0,same_failure_count=0,updated_at=?
                  where id=?
                `).run(
                    objectiveChanged ? suppliedObjective : currentRow.objective,
                    JSON.stringify(nextRequired), JSON.stringify(nextCompleted), nowIso, currentRow.id,
                );
                this.syncContinuationArchitectureForLegacyTask(currentRow.id,
                    milestoneSetChanged ? { forceNewWorkset: true } : {});
                return {
                    row: this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(currentRow.id),
                    milestoneSetChanged,
                };
            };
            if (row && terminalStates.has(String(row.state || ""))) {
                this.closeTerminalContinuationArtifacts(row.id, row.terminal_reason || row.state, nowIso);
                row = this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(row.id);
                if (manualTakeover && !deliveryToken && input.internalAnchorPreparation !== true) {
                    // A terminal lifetime task still needs one visible card for
                    // each new manual message, but that first-status call is
                    // also the durable identity of the manual round. Persist
                    // the same marker used by non-terminal manual takeover so
                    // a later begin/continuation_anchor in THIS user message can
                    // refine/reactivate work without manufacturing a second
                    // card after the first card has already mounted.
                    const turnLeaseId = `turn_${randomUUID()}`;
                    const turnLeaseExpiresAt = normalizedMode(row.continuation_mode, "compat") === "completion-driven"
                        ? completionTurnLeaseExpiresAt()
                        : row.turn_lease_expires_at;
                    this.database.sqlite.prepare(`
                      update continuation_tasks set
                        continuation_pending=0,delivery_token=null,delivery_owner='manual',delivery_owner_expires_at=null,
                        delivery_work_baseline_count=coalesce(substantive_activity_count,0),
                        manual_takeover_at=?,turn_started_at=?,turn_lease_id=?,turn_lease_expires_at=?,
                        assistant_turn_state='GENERATING',assistant_turn_owner='manual',
                        assistant_turn_completion_lease_id=null,assistant_turn_completion_requested_at=null,
                        assistant_turn_completed_at=null,assistant_turn_completion_source=null,
                        assistant_turn_completion_note=null,
                        last_model_activity_at=?,last_activity_at=?,last_host_signal='connected',last_host_signal_at=?,
                        updated_at=? where id=?
                    `).run(nowIso, nowIso, turnLeaseId, turnLeaseExpiresAt,
                        nowIso, nowIso, nowIso, nowIso, row.id);
                    row = this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(row.id);
                    const rotated = this.rotateContinuationManualRoundCard(row.id, nowIso) || row;
                    const task = rowToTask(rotated);
                    return {
                        task,
                        accepted: true,
                        reason: "manual-round-started",
                        manualRoundCardRequired: true,
                        milestoneCardRequired: true,
                        initialAnchorRequired: true,
                        reanchorRequired: true,
                        conversationLifetimeSingleton: false,
                        ...continuationDirective(task),
                    };
                }
                const task = rowToTask(row);
                return {
                    task,
                    accepted: false,
                    reason: "task-terminal-no-work",
                    ...(input.deliveryToken ? { superseded: true } : {}),
                    ...continuationDirective(task),
                };
            }
            // The Workspace App supervisor already polls status on every tick.
            // Only the verified coordinator for the current anchor generation is
            // authoritative UI liveness. Old/review/patch iframes may still call
            // status after supersession, but they must not steal coordinator
            // ownership, refresh the anchor lease, or acknowledge supervisor state.
            // Model-originated plain status is handled below as read-only control
            // traffic and never renews model activity.
            if (row && input.coordinatorInstanceId) {
                const watchedHandles = parseJson(row.watch_process_handles_json, []);
                const coordinatorInstanceId = String(input.coordinatorInstanceId);
                const verifiedAnchorHeartbeat = Boolean(row.anchor_mount_verified_at)
                    && coordinatorInstanceId === row.anchor_mount_coordinator_id;
                const acknowledgedState = verifiedAnchorHeartbeat
                    && row.state === "WAITING_SUPERVISOR" && watchedHandles.length > 0
                    ? "WAITING_EXTERNAL"
                    : row.state;
                const anchorLeaseExpiresAt = verifiedAnchorHeartbeat
                    ? new Date(now.getTime() + ANCHOR_LEASE_MS).toISOString()
                    : row.anchor_lease_expires_at;
                const lastUiHeartbeatAt = verifiedAnchorHeartbeat ? nowIso : row.last_ui_heartbeat_at;
                const authoritativeCoordinatorId = verifiedAnchorHeartbeat ? coordinatorInstanceId : row.coordinator_instance_id;
                this.database.sqlite.prepare(`
                  update continuation_tasks set state=?, last_activity_at=?, last_ui_heartbeat_at=?,
                    coordinator_instance_id=?, anchor_lease_expires_at=?, updated_at=? where id=?
                `).run(acknowledgedState, nowIso, lastUiHeartbeatAt, authoritativeCoordinatorId,
                    anchorLeaseExpiresAt, nowIso, row.id);
                return { task: rowToTask(this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(row.id)) };
            }
            // Some already-open ChatGPT conversations keep an older cached
            // continuation_task schema even after Portable is upgraded. Keep a
            // narrow compatibility CAS on the long-standing `note` field so a
            // real manual user turn can still supersede READY/synthetic ownership
            // without relying on an undeclared input property. Coordinator/App
            // status calls never send this exact marker, and synthetic resume
            // context explicitly omits it, so ambiguous tokenless status remains
            // fail-closed.
            const expectedGeneration = row?.delivery_token
                ? this.database.sqlite.prepare(`
                    select state from continuation_generations
                    where delivery_token=? order by generation desc limit 1
                  `).get(String(row.delivery_token))
                : undefined;
            const expectedSyntheticClaim = Boolean(row
                && !deliveryToken
                && !manualTakeover
                && [4, 5].includes(Number(row.continuation_pending))
                && String(row.delivery_owner || "") === "synthetic-pending"
                && row.delivery_token
                && ["DELIVERED", "WORK_REQUIRED"].includes(String(expectedGeneration?.state || ""))
                && (!row.delivery_owner_expires_at || Date.parse(row.delivery_owner_expires_at) > now.getTime()));
            if (deliveryToken && manualTakeover) {
                const task = rowToTask(row);
                return {
                    task,
                    accepted: false,
                    reason: "turn-origin-conflict",
                    retryRequired: true,
                    ...continuationDirective(task),
                };
            }
            if (row && deliveryToken && row.superseded_delivery_token === deliveryToken) {
                return {
                    task: rowToTask(row),
                    accepted: false,
                    reason: "synthetic-continuation-superseded",
                    superseded: true,
                    continueRequired: false,
                    nextRequiredMilestones: [],
                    taskIncomplete: false,
                    remainingMilestones: [],
                    finalResponseAllowed: true,
                };
            }
            if (row && deliveryToken && row.delivery_token && deliveryToken !== row.delivery_token) {
                return {
                    task: rowToTask(row),
                    accepted: false,
                    reason: "synthetic-continuation-superseded",
                    superseded: true,
                    continueRequired: false,
                    nextRequiredMilestones: [],
                    taskIncomplete: false,
                    remainingMilestones: [],
                    finalResponseAllowed: true,
                };
            }
            if (row && !deliveryToken && input.internalAnchorPreparation !== true) {
                const activeCard = this.database.sqlite.prepare(`
                  select * from continuation_conversation_cards where conversation_scope_id=?
                `).get(row.conversation_scope_id);
                const activeWorkset = activeCard?.active_workset_id
                    ? this.database.sqlite.prepare("select * from continuation_worksets where id=?").get(activeCard.active_workset_id)
                    : undefined;
                const readySynthetic = activeWorkset
                    ? this.database.sqlite.prepare(`
                        select * from continuation_generations
                        where workset_id=? and owner_type='synthetic' and state='READY'
                        order by generation asc limit 1
                      `).get(activeWorkset.id)
                    : undefined;
                const pendingSynthetic = String(row.delivery_owner || "") === "synthetic-pending";
                if ((readySynthetic || pendingSynthetic || row.delivery_token) && !manualTakeover && !expectedSyntheticClaim) {
                    const task = rowToTask(row);
                    return {
                        task,
                        accepted: false,
                        reason: "turn-origin-handshake-required",
                        retryRequired: true,
                        readyGeneration: readySynthetic?.generation,
                        syntheticOwnerActive: String(row.delivery_owner || "") === "synthetic-active",
                        syntheticTokenPending: Boolean(row.delivery_token),
                        ...continuationDirective(task),
                    };
                }
            }
            if (row && manualTakeover && !deliveryToken && input.internalAnchorPreparation !== true) {
                const readyManualTakeover = this.database.sqlite.transaction(() => {
                    const fresh = this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(row.id);
                    if (!fresh || TERMINAL_CONTINUATION_STATES.has(String(fresh.state || "")))
                        return undefined;
                    const card = this.database.sqlite.prepare(`
                      select * from continuation_conversation_cards where conversation_scope_id=?
                    `).get(fresh.conversation_scope_id);
                    if (!card?.active_workset_id)
                        return undefined;
                    const workset = this.database.sqlite.prepare("select * from continuation_worksets where id=?").get(card.active_workset_id);
                    if (!workset)
                        return undefined;
                    const ready = this.database.sqlite.prepare(`
                      select * from continuation_generations
                      where workset_id=? and owner_type='synthetic' and state='READY'
                      order by generation asc limit 1
                    `).get(workset.id);
                    if (!ready)
                        return undefined;
                    const superseded = this.database.sqlite.prepare(`
                      update continuation_generations
                      set state='SUPERSEDED',closed_at=?,failure_reason='manual-turn-took-over-before-sender-claim',updated_at=?
                      where id=? and state='READY'
                    `).run(nowIso, nowIso, ready.id);
                    if (Number(superseded.changes || 0) !== 1)
                        return undefined;
                    const nextGeneration = Math.max(
                        Number(workset.current_generation || 0),
                        Number(ready.generation || 0),
                        Number(fresh.delivery_generation || 0),
                    ) + 1;
                    const turnLeaseId = `turn_${randomUUID()}`;
                    const turnLeaseExpiresAt = normalizedMode(fresh.continuation_mode, "compat") === "completion-driven"
                        ? completionTurnLeaseExpiresAt()
                        : fresh.turn_lease_expires_at;
                    this.database.sqlite.prepare(`
                      update continuation_worksets
                      set current_generation=?,state='RUNNING',continuation_due_at=?,last_model_activity_at=?,updated_at=?
                      where id=?
                    `).run(nextGeneration, turnLeaseExpiresAt, nowIso, nowIso, workset.id);
                    this.database.sqlite.prepare(`
                      update continuation_tasks set continuation_pending=0,
                        delivery_generation=?,superseded_delivery_token=coalesce(delivery_token,superseded_delivery_token),
                        delivery_token=null,delivery_owner='manual',delivery_owner_expires_at=null,
                        delivery_work_baseline_count=coalesce(substantive_activity_count,0),manual_takeover_at=?,
                        delivery_ack_started_at=null,delivery_ack_retry_count=0,delivery_ack_retry_after_at=null,
                        turn_started_at=?,turn_lease_id=?,turn_lease_expires_at=?,
                        assistant_turn_state='GENERATING',assistant_turn_owner='manual',
                        assistant_turn_completion_lease_id=null,assistant_turn_completion_requested_at=null,
                        assistant_turn_completed_at=null,assistant_turn_completion_source=null,
                        assistant_turn_completion_note=null,
                        last_model_activity_at=?,last_activity_at=?,last_host_signal='connected',last_host_signal_at=?,
                        stall_state='ACTIVE',stall_suspected_at=null,stall_probe_count=0,
                        stall_last_probe_at=null,stall_armed_at=null,stall_evidence=null,updated_at=?
                      where id=?
                    `).run(nextGeneration, nowIso, nowIso, turnLeaseId, turnLeaseExpiresAt,
                        nowIso, nowIso, nowIso, nowIso, fresh.id);
                    this.syncContinuationArchitectureForLegacyTask(fresh.id);
                    return this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(fresh.id);
                })();
                if (readyManualTakeover) {
                    const manualPlan = applyManualRoundPlan(readyManualTakeover);
                    const rotated = this.rotateContinuationManualRoundCard(row.id, nowIso) || manualPlan.row;
                    const refreshedTask = rowToTask(rotated);
                    return {
                        task: refreshedTask,
                        accepted: true,
                        reason: "manual-turn-took-over-ready-generation",
                        manualRoundCardRequired: true,
                        milestoneCardRequired: true,
                        initialAnchorRequired: true,
                        reanchorRequired: true,
                        conversationLifetimeSingleton: false,
                        ...(manualPlan.milestoneSetChanged ? { manualMilestoneSetChanged: true } : {}),
                        ...continuationDirective(refreshedTask),
                    };
                }
                // A sender claim may have won immediately before the transaction.
                // Re-read authoritative ownership so the branch below can still
                // revoke that synthetic owner before any manual side effect.
                row = find();
            }
            const syntheticOwned = row && ["synthetic-pending", "synthetic-active"].includes(String(row.delivery_owner || ""));
            if (row && syntheticOwned && manualTakeover && !deliveryToken && input.internalAnchorPreparation !== true) {
                // The Apps SDK does not expose a generic "user sent a chat
                // message" event. Require an explicit manualTakeover marker on
                // the model-side status handshake before revoking synthetic
                // ownership. A missing delivery token alone is ambiguous: an
                // automatically resumed model may simply have omitted the token,
                // and must never be allowed to supersede itself.
                const turnLeaseId = `turn_${randomUUID()}`;
                const turnLeaseExpiresAt = normalizedMode(row.continuation_mode, "compat") === "completion-driven"
                    ? completionTurnLeaseExpiresAt()
                    : row.turn_lease_expires_at;
                if (row.delivery_token) {
                    this.database.sqlite.prepare(`
                      update continuation_generations set state='SUPERSEDED',closed_at=?,
                        failure_reason='manual-turn-took-over',updated_at=?
                      where delivery_token=? and state in ('READY','CLAIMED','DELIVERING','DELIVERED','TURN_ACKED','WORK_REQUIRED')
                    `).run(nowIso, nowIso, row.delivery_token);
                }
                else {
                    const card = this.database.sqlite.prepare(`
                      select active_workset_id from continuation_conversation_cards where conversation_scope_id=?
                    `).get(row.conversation_scope_id);
                    if (card?.active_workset_id) {
                        this.database.sqlite.prepare(`
                          update continuation_generations set state='SUPERSEDED',closed_at=?,
                            failure_reason='manual-turn-took-over',updated_at=?
                          where workset_id=? and owner_type='synthetic'
                            and state in ('READY','CLAIMED','DELIVERING','DELIVERED','TURN_ACKED','WORK_REQUIRED')
                        `).run(nowIso, nowIso, card.active_workset_id);
                    }
                }
                this.database.sqlite.prepare(`
                  update continuation_tasks set continuation_pending=0,
                    delivery_generation=coalesce(delivery_generation,0)+1,
                    superseded_delivery_token=delivery_token, delivery_token=null,
                    delivery_owner='manual', delivery_owner_expires_at=null,
                    delivery_work_baseline_count=coalesce(substantive_activity_count,0), manual_takeover_at=?,
                    delivery_ack_started_at=null, delivery_ack_retry_count=0, delivery_ack_retry_after_at=null,
                    turn_started_at=?, turn_lease_id=?, turn_lease_expires_at=?,
                    assistant_turn_state='GENERATING',assistant_turn_owner='manual',
                    assistant_turn_completion_lease_id=null,assistant_turn_completion_requested_at=null,
                    assistant_turn_completed_at=null,assistant_turn_completion_source=null,
                    assistant_turn_completion_note=null,
                    last_model_activity_at=?, last_activity_at=?, last_host_signal='connected', last_host_signal_at=?,
                    stall_state='ACTIVE', stall_suspected_at=null, stall_probe_count=0,
                    stall_last_probe_at=null, stall_armed_at=null, stall_evidence=null, updated_at=? where id=?
                `).run(nowIso, nowIso, turnLeaseId, turnLeaseExpiresAt, nowIso, nowIso, nowIso, nowIso, row.id);
                const manualPlan = applyManualRoundPlan(
                    this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(row.id),
                );
                const rotated = this.rotateContinuationManualRoundCard(row.id, nowIso) || manualPlan.row;
                const refreshedTask = rowToTask(rotated);
                return {
                    task: refreshedTask,
                    accepted: true,
                    reason: "manual-turn-took-over",
                    manualRoundCardRequired: true,
                    milestoneCardRequired: true,
                    initialAnchorRequired: true,
                    reanchorRequired: true,
                    conversationLifetimeSingleton: false,
                    ...(manualPlan.milestoneSetChanged ? { manualMilestoneSetChanged: true } : {}),
                    ...continuationDirective(refreshedTask),
                };
            }
            if (row && manualTakeover && !deliveryToken && input.internalAnchorPreparation !== true) {
                // The explicit first-status manual marker is also the durable
                // boundary between transcript user rounds.  Even when there is
                // no synthetic owner to supersede, a new manual round must get
                // its own visible milestone card generation.
                const turnLeaseId = `turn_${randomUUID()}`;
                const turnLeaseExpiresAt = normalizedMode(row.continuation_mode, "compat") === "completion-driven"
                    ? completionTurnLeaseExpiresAt()
                    : row.turn_lease_expires_at;
                this.database.sqlite.prepare(`
                  update continuation_tasks set
                    continuation_pending=0,delivery_token=null,delivery_owner='manual',delivery_owner_expires_at=null,
                    delivery_work_baseline_count=coalesce(substantive_activity_count,0),manual_takeover_at=?,turn_started_at=?,
                    turn_lease_id=?,turn_lease_expires_at=?,last_model_activity_at=?,last_activity_at=?,
                    assistant_turn_state='GENERATING',assistant_turn_owner='manual',
                    assistant_turn_completion_lease_id=null,assistant_turn_completion_requested_at=null,
                    assistant_turn_completed_at=null,assistant_turn_completion_source=null,
                    assistant_turn_completion_note=null,
                    last_host_signal='connected',last_host_signal_at=?,stall_state='ACTIVE',
                    stall_suspected_at=null,stall_probe_count=0,stall_last_probe_at=null,
                    stall_armed_at=null,stall_evidence=null,updated_at=? where id=?
                `).run(nowIso, nowIso, turnLeaseId, turnLeaseExpiresAt, nowIso, nowIso, nowIso, nowIso, row.id);
                const manualPlan = applyManualRoundPlan(
                    this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(row.id),
                );
                const rotated = this.rotateContinuationManualRoundCard(row.id, nowIso) || manualPlan.row;
                const refreshedTask = rowToTask(rotated);
                return {
                    task: refreshedTask,
                    accepted: true,
                    reason: "manual-round-started",
                    manualRoundCardRequired: true,
                    milestoneCardRequired: true,
                    initialAnchorRequired: true,
                    reanchorRequired: true,
                    conversationLifetimeSingleton: false,
                    ...(manualPlan.milestoneSetChanged ? { manualMilestoneSetChanged: true } : {}),
                    ...continuationDirective(refreshedTask),
                };
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
                if (row.delivery_token && deliveryToken && deliveryToken !== row.delivery_token) {
                    return {
                        task: rowToTask(row),
                        accepted: false,
                        reason: "synthetic-continuation-token-required",
                        continueRequired: false,
                        finalResponseAllowed: true,
                    };
                }
                const claimed = this.database.sqlite.transaction(() => {
                    const fresh = this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(row.id);
                    if (!fresh || ![4, 5].includes(Number(fresh.continuation_pending))
                        || String(fresh.delivery_owner || "") !== "synthetic-pending"
                        || !fresh.delivery_token) {
                        return { accepted: false, reason: "synthetic-ownership-superseded" };
                    }
                    const claimToken = String(fresh.delivery_token);
                    if (deliveryToken && deliveryToken !== claimToken)
                        return { accepted: false, reason: "synthetic-continuation-superseded", superseded: true };
                    if (!deliveryToken) {
                        const expectedLeaseAt = Date.parse(String(fresh.delivery_owner_expires_at || ""));
                        if (Number.isFinite(expectedLeaseAt) && expectedLeaseAt <= now.getTime())
                            return { accepted: false, reason: "expected-next-turn-lease-expired" };
                    }
                    const turnLeaseId = `turn_${randomUUID()}`;
                    const turnLeaseExpiresAt = normalizedMode(fresh.continuation_mode, "compat") === "completion-driven"
                        ? completionTurnLeaseExpiresAt()
                        : fresh.turn_lease_expires_at;
                    const syntheticOwnerExpiresAt = new Date(now.getTime() + SYNTHETIC_WORK_OWNER_LEASE_MS).toISOString();
                    const generation = this.database.sqlite.prepare(`
                      select g.* from continuation_generations g
                      join continuation_worksets w on w.id=g.workset_id
                      where w.legacy_task_id=? and g.delivery_token=?
                        and g.state in ('DELIVERED','WORK_REQUIRED','TURN_ACKED')
                      order by g.generation desc limit 1
                    `).get(fresh.id, claimToken);
                    if (generation) {
                        this.database.sqlite.prepare(`
                          update continuation_generations set state='TURN_ACKED',due_at=?,updated_at=?
                          where id=? and state in ('DELIVERED','WORK_REQUIRED','TURN_ACKED')
                        `).run(syntheticOwnerExpiresAt, nowIso, generation.id);
                    }
                    const changed = this.database.sqlite.prepare(`
                      update continuation_tasks set continuation_pending=0,
                        turn_started_at=?, last_model_activity_at=?, last_activity_at=?,
                        turn_lease_id=?, turn_lease_expires_at=?,
                        assistant_turn_state='GENERATING',assistant_turn_owner='synthetic',
                        assistant_turn_completion_lease_id=null,assistant_turn_completion_requested_at=null,
                        assistant_turn_completed_at=null,assistant_turn_completion_source=null,
                        assistant_turn_completion_note=null,
                        stall_state='ACTIVE', stall_suspected_at=null, stall_probe_count=0,
                        stall_last_probe_at=null, stall_armed_at=null, stall_evidence=null,
                        delivery_ack_started_at=?, delivery_ack_retry_count=0, delivery_ack_retry_after_at=null,
                        superseded_delivery_token=coalesce(delivery_token,superseded_delivery_token),
                        delivery_token=null, delivery_owner='synthetic-active',
                        delivery_owner_expires_at=?,
                        delivery_work_baseline_count=coalesce(substantive_activity_count,0),
                        last_host_signal='connected', last_host_signal_at=?, updated_at=?
                      where id=? and delivery_token=? and delivery_owner='synthetic-pending'
                        and continuation_pending in (4,5)
                    `).run(nowIso, nowIso, nowIso, turnLeaseId, turnLeaseExpiresAt,
                        nowIso, syntheticOwnerExpiresAt, nowIso, nowIso, fresh.id, claimToken);
                    if (Number(changed.changes || 0) !== 1)
                        return { accepted: false, reason: "synthetic-claim-race-lost" };
                    return {
                        accepted: true,
                        claimedWithoutToken: !deliveryToken,
                        row: this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(fresh.id),
                    };
                })();
                if (!claimed.accepted) {
                    const task = rowToTask(this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(row.id));
                    return {
                        task,
                        accepted: false,
                        reason: claimed.reason,
                        ...(claimed.superseded ? { superseded: true } : {}),
                        retryRequired: claimed.reason === "expected-next-turn-lease-expired",
                        ...continuationDirective(task),
                    };
                }
                this.syncContinuationArchitectureForLegacyTask(row.id);
                const refreshedRow = this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(row.id);
                const refreshedTask = rowToTask(refreshedRow);
                const reanchorRequired = taskNeedsCurrentTurnSupervisor(refreshedRow, refreshedTask);
                return {
                    task: refreshedTask,
                    accepted: true,
                    reason: claimed.claimedWithoutToken
                        ? "server-owned-expected-generation-claimed"
                        : "continuation-resume-acknowledged",
                    reanchorRequired,
                    ...continuationDirective(refreshedTask),
                };
            }
            // Plain model-side status is control traffic, not evidence that the
            // assistant is still doing substantive work. Keeping this path
            // read-only is essential: otherwise every status probe renews the
            // completion activity lease and can suppress stall recovery forever.
            // Synthetic resumed-turn ACKs above remain the only status path that
            // intentionally establishes a fresh ownership/turn lease.
            const statusRow = row;
            const task = rowToTask(statusRow);
            return {
                task,
                ...continuationDirective(task),
                ...(taskNeedsCurrentTurnSupervisor(statusRow, task) ? { reanchorRequired: true } : {}),
            };
        }
        if (action === "begin" || action === "begin-auto") {
            let existing = find();
            let beginManualCardRequired = false;
            let beginMustRotateCard = false;
            if (existing && existing.deadline_at && Date.parse(existing.deadline_at) <= now.getTime()) {
                if (existing.owner_locked) {
                    this.database.sqlite.prepare("update continuation_tasks set waiting_reason='Owner lock prevented automatic wall-clock termination.', owner_control_note='wall-clock-budget-reached-while-locked', updated_at=? where id=?")
                        .run(nowIso, existing.id);
                }
                else {
                    this.database.sqlite.transaction(() => {
                        this.database.sqlite.prepare("update continuation_tasks set state='BUDGET_EXHAUSTED', terminal_reason='wall-clock-budget', continuation_pending=0, updated_at=? where id=?")
                            .run(nowIso, existing.id);
                        this.closeTerminalContinuationArtifacts(existing.id, "wall-clock-budget", nowIso);
                    })();
                    existing = action === "begin"
                        ? this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(existing.id)
                        : undefined;
                }
            }
            if (existing && action === "begin" && terminalStates.has(existing.state)) {
                const suppliedRequired = [...new Set((Array.isArray(input.requiredMilestones) ? input.requiredMilestones : [])
                    .map((value) => String(value).trim()).filter(Boolean))].slice(0, 64);
                const terminalCompleted = new Set(parseJson(existing.completed_milestones_json, [])
                    .map((value) => String(value).trim()).filter(Boolean));
                const sameTerminalManualRound = Boolean(existing.manual_takeover_at
                    && existing.turn_started_at
                    && String(existing.manual_takeover_at) === String(existing.turn_started_at)
                    && String(existing.assistant_turn_owner ?? "") === "manual");
                const terminalAnchorReplay = input.replaceActiveMilestones === true
                    && String(input.sourceTool ?? "") === "continuation_anchor";
                const terminalAnchorHasUnfinishedWork = suppliedRequired.some((milestone) => !terminalCompleted.has(milestone));
                // A new manual message still owns one fresh visible card even
                // when the lifetime task is already complete.  The card is a
                // per-message UI surface, however, and is not itself evidence
                // of new work.  continuation_anchor therefore must not revive a
                // terminal Task Contract when it merely replays the already
                // completed plan.  Doing so creates a transient RUNNING task
                // with no pending milestone; the next ordinary tool/recovery
                // pass can then manufacture the generic fallback milestones.
                // Explicit continuation_task begin calls remain the API for
                // genuinely new work and retain the historical reactivation
                // behavior, including callers that intentionally reuse a
                // milestone description.
                if (terminalAnchorReplay && !terminalAnchorHasUnfinishedWork) {
                    const task = rowToTask(existing);
                    return {
                        task,
                        created: false,
                        upgraded: false,
                        ...continuationDirective(task),
                    };
                }
                // Direct begin on a terminal task represents a new manual round
                // and therefore owns a new card.  If first-status already
                // established this exact manual round, however, begin is only
                // plan refinement/reactivation and MUST reuse that round's card
                // even when the card has already mounted and verified.
                beginManualCardRequired = !sameTerminalManualRound;
                const cardBeforeBegin = this.database.sqlite.prepare(`
                  select * from continuation_conversation_cards where conversation_scope_id=?
                `).get(existing.conversation_scope_id);
                const pendingFreshCard = Number(existing.anchor_mount_generation || 0) > 0
                    && !existing.anchor_mount_verified_at
                    && Number(cardBeforeBegin?.mount_generation || 0) === Number(existing.anchor_mount_generation || 0)
                    && !cardBeforeBegin?.mount_verified_at;
                beginMustRotateCard = beginManualCardRequired && !pendingFreshCard;
                const turnLeaseId = sameTerminalManualRound && existing.turn_lease_id
                    ? existing.turn_lease_id
                    : `turn_${randomUUID()}`;
                const turnStartedAt = sameTerminalManualRound && existing.turn_started_at
                    ? existing.turn_started_at
                    : nowIso;
                const turnLeaseExpiresAt = sameTerminalManualRound && existing.turn_lease_expires_at
                    ? existing.turn_lease_expires_at
                    : completionTurnLeaseExpiresAt();
                this.database.sqlite.prepare(`
                  update continuation_tasks set state='RUNNING', terminal_reason=null, waiting_reason=null,
                    continuation_pending=0, watch_process_handles_json='[]',
                    delivery_work_baseline_count=coalesce(substantive_activity_count,0),
                    delivery_ack_started_at=null, delivery_ack_retry_count=0, delivery_ack_retry_after_at=null,
                    turn_started_at=?, turn_lease_id=?, turn_lease_expires_at=?,
                    assistant_turn_state='GENERATING',assistant_turn_owner='manual',
                    assistant_turn_completion_lease_id=null,assistant_turn_completion_requested_at=null,
                    assistant_turn_completed_at=null,assistant_turn_completion_source=null,
                    assistant_turn_completion_note=null,
                    last_model_activity_at=?, last_activity_at=?,
                    stall_state='ACTIVE', stall_suspected_at=null, stall_probe_count=0,
                    stall_last_probe_at=null, stall_armed_at=null, stall_evidence=null,
                    updated_at=? where id=?
                `).run(turnStartedAt, turnLeaseId, turnLeaseExpiresAt, nowIso, nowIso, nowIso, existing.id);
                existing = this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(existing.id);
                // Do not allocate the reactivated Workset yet. This same begin
                // call may carry the new manual-round objective/milestones, and
                // the action-specific begin block below is the authoritative
                // mutation boundary for that plan. Allocating here and then
                // forceNewWorkset again after plan replacement creates a
                // transient sequence and skips 2 -> 3 for one user task.
                // The later sync allocates exactly one Workset even when begin
                // carries no replacement milestones because the terminal close
                // already detached the previous active Workset from the card.
                if (beginMustRotateCard) {
                    existing = this.rotateContinuationManualRoundCard(existing.id, nowIso) || existing;
                    beginMustRotateCard = false;
                }
            }
            if (existing && action === "begin-auto" && terminalStates.has(existing.state)
                && isCanonicalConversationScope(input.conversationScopeId ?? existing.conversation_scope_id)) {
                const task = rowToTask(existing);
                return { task, created: false, ...continuationDirective(task) };
            }
            if (existing && !terminalStates.has(existing.state)) {
                if (action === "begin") {
                    const suppliedRequired = [...new Set((Array.isArray(input.requiredMilestones) ? input.requiredMilestones : [])
                        .map((value) => String(value).trim()).filter(Boolean))].slice(0, 64);
                    const existingRequired = parseJson(existing.required_milestones_json, []);
                    const trustedAnchorPlanReplacement = input.replaceActiveMilestones === true
                        && String(input.sourceTool ?? "") === "continuation_anchor"
                        && suppliedRequired.length > 0;
                    // The first control call of a real user message is status
                    // with manualTakeover=true. That call may intentionally know
                    // only the turn origin; the refined objective/milestones can
                    // arrive on the following begin/continuation_anchor. If a
                    // later begin in that SAME manual round supplies an explicit
                    // plan, it is the round's authoritative active plan rather
                    // than an append-only extension of the lifetime projection.
                    // This closes the takeover-without-plan window that could
                    // copy historical milestones into the current Workset.
                    // Generic compatibility begin calls outside a fresh manual
                    // round retain their merge semantics, and begin-auto never
                    // enters this branch.
                    const sameManualRoundTakeover = Boolean(existing.manual_takeover_at
                        && existing.turn_started_at
                        && String(existing.manual_takeover_at) === String(existing.turn_started_at)
                        && String(existing.assistant_turn_owner ?? "") === "manual");
                    const replaceActiveMilestones = suppliedRequired.length > 0
                        && (trustedAnchorPlanReplacement || beginManualCardRequired || sameManualRoundTakeover);
                    const canRefineFallback = Boolean(existing.auto_created)
                        && Number(existing.contract_version || 0) >= TASK_CONTRACT_VERSION
                        && suppliedRequired.length > 0
                        && existingRequired.length === DEFAULT_TASK_CONTRACT_MILESTONES.length
                        && existingRequired.every((value, index) => value === DEFAULT_TASK_CONTRACT_MILESTONES[index])
                        && parseJson(existing.completed_milestones_json, []).length === 0;
                    const currentRequired = new Set((canRefineFallback || replaceActiveMilestones) ? [] : existingRequired);
                    for (const value of suppliedRequired) {
                        const item = String(value).trim();
                        if (item) currentRequired.add(item);
                    }
                    if (currentRequired.size === 0) {
                        for (const value of DEFAULT_TASK_CONTRACT_MILESTONES) currentRequired.add(value);
                    }
                    const nextRequired = [...currentRequired].slice(0, 64);
                    const nextRequiredSet = new Set(nextRequired);
                    const existingCompleted = parseJson(existing.completed_milestones_json, [])
                        .map((value) => String(value).trim()).filter(Boolean);
                    const nextCompleted = replaceActiveMilestones
                        ? existingCompleted.filter((value) => nextRequiredSet.has(value))
                        : existingCompleted;
                    const milestoneSetChanged = JSON.stringify(nextRequired) !== JSON.stringify(existingRequired);
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
                      update continuation_tasks set objective=?, required_milestones_json=?, completed_milestones_json=?,
                        continuation_mode=?, max_continuations=?, max_no_progress=?, max_same_failure=?, deadline_at=?,
                        task_source=?, source_tool=?, contract_version=?, turn_lease_id=?, turn_lease_expires_at=?,
                        workspace_id=coalesce(?,workspace_id),
                        progress_fingerprint=?,failure_fingerprint=?,no_progress_count=?,same_failure_count=?,
                        last_model_activity_at=?, last_activity_at=?,
                        stall_state=case when ?='completion-driven' then 'ACTIVE' else stall_state end,
                        stall_suspected_at=case when ?='completion-driven' then null else stall_suspected_at end,
                        stall_probe_count=case when ?='completion-driven' then 0 else stall_probe_count end,
                        stall_last_probe_at=case when ?='completion-driven' then null else stall_last_probe_at end,
                        stall_armed_at=case when ?='completion-driven' then null else stall_armed_at end,
                        stall_evidence=case when ?='completion-driven' then null else stall_evidence end,
                        updated_at=? where id=?
                    `).run(objective, JSON.stringify(nextRequired), JSON.stringify(nextCompleted), requestedMode,
                        maxContinuations,
                        Math.max(1, Math.min(Number(input.maxNoProgress ?? existing.max_no_progress), 20)),
                        Math.max(1, Math.min(Number(input.maxSameFailure ?? existing.max_same_failure), 20)), deadlineAt,
                        taskSource, sourceTool, Math.max(Number(existing.contract_version || 0), TASK_CONTRACT_VERSION),
                        turnLeaseId, turnLeaseExpiresAt, input.workspaceId ?? null,
                        replaceActiveMilestones ? null : existing.progress_fingerprint,
                        replaceActiveMilestones ? null : existing.failure_fingerprint,
                        replaceActiveMilestones ? 0 : Number(existing.no_progress_count || 0),
                        replaceActiveMilestones ? 0 : Number(existing.same_failure_count || 0),
                        nowIso, nowIso,
                        requestedMode, requestedMode, requestedMode, requestedMode, requestedMode, requestedMode,
                        nowIso, existing.id);
                    this.syncContinuationArchitectureForLegacyTask(existing.id,
                        replaceActiveMilestones && milestoneSetChanged ? { forceNewWorkset: true } : {});
                    let refreshed = this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(existing.id);
                    if (beginManualCardRequired && beginMustRotateCard)
                        refreshed = this.rotateContinuationManualRoundCard(existing.id, nowIso) || refreshed;
                    const task = rowToTask(refreshed);
                    return {
                        task,
                        created: false,
                        upgraded: true,
                        ...(beginManualCardRequired ? {
                            manualRoundCardRequired: true,
                            milestoneCardRequired: true,
                            initialAnchorRequired: true,
                            reanchorRequired: true,
                            conversationLifetimeSingleton: false,
                        } : {}),
                        ...continuationDirective(task),
                    };
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
                substantive_activity_count, turn_lease_id, turn_lease_expires_at,
                assistant_turn_state,assistant_turn_owner,delivery_work_baseline_count,
                created_at, updated_at
              ) values (?, ?, ?, ?, 'RUNNING', ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                'GENERATING', ?, 0, ?, ?)
            `).run(id, String(input.conversationScopeId || "unknown"), input.workspaceId ? String(input.workspaceId) : null,
                String(input.objective ?? "Continue the current DevSpace task until the original user goal is verified complete."),
                mode, JSON.stringify(required), JSON.stringify(input.evidence ?? {}),
                maxContinuations, maxNoProgress, maxSameFailure, deadlineAt,
                nowIso, nowIso, nowIso, taskSource, sourceTool, TASK_CONTRACT_VERSION,
                action === "begin-auto" ? 1 : 0, 0, turnLeaseId, turnLeaseExpiresAt,
                action === "begin-auto" ? "synthetic" : "manual", nowIso, nowIso);
            this.syncContinuationArchitectureForLegacyTask(id);
            const task = rowToTask(this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(id));
            return { task, created: true, ...continuationDirective(task) };
        }
        const row = find();
        if (!row) return { task: undefined, accepted: false, reason: "task-not-found" };
        if (terminalStates.has(row.state) && !["status", "anchor-mounted"].includes(action)) {
            return { task: rowToTask(row), accepted: false, reason: "task-terminal" };
        }
        const taskId = row.id;
        if (action === "anchor-mounted") {
            const token = String(input.anchorMountToken ?? "").trim();
            const coordinatorInstanceId = String(input.coordinatorInstanceId ?? "").trim();
            if (!token || !coordinatorInstanceId)
                return { task: rowToTask(row), accepted: false, reason: "anchor-mount-token-and-coordinator-required" };
            if (row.anchor_mount_verified_at) {
                if (coordinatorInstanceId === row.anchor_mount_coordinator_id)
                    return { task: rowToTask(row), accepted: true, reason: "anchor-mount-already-verified" };
                const requestedGeneration = Math.max(0, Number(input.anchorMountGeneration || 0));
                const authoritativeGeneration = Math.max(0, Number(row.anchor_mount_generation || 0));
                if (!requestedGeneration || requestedGeneration !== authoritativeGeneration)
                    return { task: rowToTask(row), accepted: false, reason: "stale-anchor-generation" };
                // 1.1.53+ keeps the current generation's card capability so the
                // same immutable ChatGPT card can rehydrate after browser/service
                // restart without creating a second visible card. Upgraded rows
                // from older 1.1.53 candidates cleared the token after first ACK;
                // exact-generation matching is the one-time legacy bridge. Older
                // generations are rejected above and cannot steal coordinator
                // ownership.
                if (row.anchor_mount_token && token !== row.anchor_mount_token)
                    return { task: rowToTask(row), accepted: false, reason: "anchor-mount-token-mismatch" };
                const leaseExpiresAt = new Date(now.getTime() + ANCHOR_LEASE_MS).toISOString();
                this.database.sqlite.prepare(`
                  update continuation_tasks set anchor_mount_coordinator_id=?,
                    anchor_mount_token=coalesce(anchor_mount_token,?),
                    anchor_lease_expires_at=?, last_ui_heartbeat_at=?,
                    coordinator_instance_id=?, last_activity_at=?, updated_at=?
                  where id=? and anchor_mount_generation=?
                `).run(coordinatorInstanceId, token, leaseExpiresAt, nowIso, coordinatorInstanceId, nowIso, nowIso, taskId, authoritativeGeneration);
                this.syncContinuationArchitectureForLegacyTask(taskId);
                return {
                    task: rowToTask(this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(taskId)),
                    accepted: true,
                    reason: "anchor-coordinator-rebound",
                };
            }
            if (!row.anchor_mount_token || token !== row.anchor_mount_token) {
                return { task: rowToTask(row), accepted: false, reason: "anchor-mount-token-mismatch" };
            }
            const leaseExpiresAt = new Date(now.getTime() + ANCHOR_LEASE_MS).toISOString();
            this.database.sqlite.prepare(`
              update continuation_tasks set anchor_mount_verified_at=?, anchor_mount_coordinator_id=?,
                last_anchor_mounted_at=?, anchor_lease_expires_at=?,
                last_ui_heartbeat_at=?, coordinator_instance_id=?, last_activity_at=?, updated_at=?
              where id=?
            `).run(nowIso, coordinatorInstanceId, nowIso, leaseExpiresAt,
                nowIso, coordinatorInstanceId, nowIso, nowIso, taskId);
            this.syncContinuationArchitectureForLegacyTask(taskId);
            return {
                task: rowToTask(this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(taskId)),
                accepted: true,
                reason: "anchor-mount-verified",
            };
        }
        // ChatGPT may keep a cached continuation_task schema across an MCP
        // service restart.  dev12 exposes the dedicated turn-complete action,
        // but an already-open Host can therefore still see the older action
        // enum while talking to the upgraded runtime.  Preserve ATCC semantics
        // without falling back to silence/lease heuristics: an exact reserved
        // checkpoint note is a model-owned compatibility signature and is
        // routed through the *same* current-turn/work-delta gate below.  Any
        // other checkpoint keeps its ordinary persistence semantics.
        const checkpointCompletionIntent = action === "checkpoint"
            && String(input.note ?? "").trim() === "atcc-turn-complete";
        if (action === "turn-complete" || checkpointCompletionIntent) {
            const mode = normalizedMode(row.continuation_mode, "compat");
            if (mode !== "completion-driven") {
                return { task: rowToTask(row), accepted: false, reason: "completion-driven-mode-required" };
            }
            if (row.state !== "RUNNING") {
                return { task: rowToTask(row), accepted: false, reason: "assistant-turn-not-running" };
            }
            if (input.coordinatorInstanceId) {
                // Completion intent is model-owned. The Workspace App/Host may
                // confirm the lifecycle later, but it must never manufacture
                // model intent on the assistant's behalf.
                return { task: rowToTask(row), accepted: false, reason: "turn-complete-model-only" };
            }
            const required = parseJson(row.required_milestones_json, []);
            const completed = new Set(parseJson(row.completed_milestones_json, []));
            const incomplete = required.length > 0 && required.some((milestone) => !completed.has(milestone));
            if (!incomplete) {
                return { task: rowToTask(row), accepted: false, reason: "no-incomplete-milestones" };
            }
            const turnLeaseId = String(row.turn_lease_id || "").trim();
            if (!turnLeaseId) {
                return { task: rowToTask(row), accepted: false, reason: "assistant-turn-lease-required" };
            }
            if (row.assistant_turn_state === "COMPLETION_REQUESTED"
                && String(row.assistant_turn_completion_lease_id || "") === turnLeaseId) {
                const task = rowToTask(row);
                return { task, accepted: true, reason: "assistant-turn-completion-already-requested", ...continuationDirective(task) };
            }
            if (!["GENERATING", "UNKNOWN"].includes(String(row.assistant_turn_state || "UNKNOWN"))) {
                return { task: rowToTask(row), accepted: false, reason: "assistant-turn-completion-state-conflict" };
            }
            const owner = String(row.delivery_owner || "") === "synthetic-active" ? "synthetic" : "manual";
            const workDelta = Math.max(0,
                Number(row.substantive_activity_count || 0) - Number(row.delivery_work_baseline_count || 0));
            // Synthetic resumes must not collapse into the short two-call loops
            // observed in live ChatGPT runs (status/one inspection/early final).
            // Four substantive post-ACK operations is still a work-based gate,
            // not an artificial sleep: simple work can finish quickly, while a
            // resumed multi-step task must demonstrate sustained execution before
            // it may voluntarily sign an incomplete-stage boundary.
            const minimumWorkDelta = owner === "synthetic" ? 4 : 1;
            if (workDelta < minimumWorkDelta) {
                return {
                    task: rowToTask(row),
                    accepted: false,
                    reason: "assistant-turn-substantive-work-required",
                    substantiveWorkDelta: workDelta,
                    minimumSubstantiveWorkDelta: minimumWorkDelta,
                    ...continuationDirective(rowToTask(row)),
                };
            }
            const turnStartedAtMs = Date.parse(String(row.turn_started_at || ""));
            const activeWorkMs = Number.isFinite(turnStartedAtMs)
                ? Math.max(0, now.getTime() - turnStartedAtMs)
                : 0;
            const minimumActiveWorkMs = owner === "synthetic" ? SYNTHETIC_MIN_ACTIVE_WORK_MS : 0;
            if (owner === "synthetic" && activeWorkMs < minimumActiveWorkMs) {
                return {
                    task: rowToTask(row),
                    accepted: false,
                    reason: "synthetic-turn-min-active-work-required",
                    substantiveWorkDelta: workDelta,
                    minimumSubstantiveWorkDelta: minimumWorkDelta,
                    activeWorkMs,
                    minimumActiveWorkMs,
                    retryAfterMs: Math.max(1, minimumActiveWorkMs - activeWorkMs),
                    ...continuationDirective(rowToTask(row)),
                };
            }
            const completionNote = checkpointCompletionIntent
                ? "atcc-turn-complete (cached-schema compatibility)"
                : String(input.note ?? "normal-stage-complete").trim().slice(0, 1000)
                    || "normal-stage-complete";
            const completionHandoffDueAt = new Date(now.getTime() + MODEL_COMPLETION_HANDOFF_GRACE_MS).toISOString();
            this.database.sqlite.prepare(`
              update continuation_tasks set
                assistant_turn_state='COMPLETION_REQUESTED',
                assistant_turn_owner=?,assistant_turn_completion_lease_id=turn_lease_id,
                assistant_turn_completion_requested_at=?,assistant_turn_completed_at=null,
                assistant_turn_completion_source='model-stage-complete-intent',
                assistant_turn_completion_note=?,
                stall_state='ACTIVE',stall_armed_at=null,
                stall_evidence='atcc-awaiting-model-completion-handoff-grace',updated_at=?
              where id=? and state='RUNNING' and turn_lease_id=?
                and assistant_turn_state in ('GENERATING','UNKNOWN')
            `).run(owner, nowIso, completionNote, nowIso, taskId, turnLeaseId);
            // Make the resident supervisor revisit this exact workset when the
            // explicit completion handoff grace matures. This does not arm a
            // continuation: the sweep still must atomically promote the exact
            // COMPLETION_REQUESTED turn lease, and GENERATING tasks never pass
            // that gate.
            this.database.sqlite.prepare(`
              update continuation_worksets set continuation_due_at=?,updated_at=?
              where legacy_task_id=? and state in ('RUNNING','SUSPECTED_STALL')
            `).run(completionHandoffDueAt, nowIso, taskId);
            const refreshed = this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(taskId);
            const task = rowToTask(refreshed);
            return {
                task,
                accepted: String(refreshed?.assistant_turn_state || "") === "COMPLETION_REQUESTED"
                    && String(refreshed?.assistant_turn_completion_lease_id || "") === turnLeaseId,
                reason: checkpointCompletionIntent
                    ? "assistant-turn-completion-requested-via-checkpoint-compat"
                    : "assistant-turn-completion-requested",
                ...continuationDirective(task),
            };
        }
        if (action === "heartbeat") {
            const coordinatorInstanceId = input.coordinatorInstanceId ? String(input.coordinatorInstanceId) : row.coordinator_instance_id;
            const anchorMountAckPrefix = "anchor-mount-ack:";
            const heartbeatNote = String(input.note ?? "");
            if (!row.anchor_mount_verified_at && heartbeatNote.startsWith(anchorMountAckPrefix)) {
                const token = heartbeatNote.slice(anchorMountAckPrefix.length).trim();
                if (!token || !coordinatorInstanceId)
                    return { task: rowToTask(row), accepted: false, reason: "anchor-mount-token-and-coordinator-required" };
                if (!row.anchor_mount_token || token !== row.anchor_mount_token)
                    return { task: rowToTask(row), accepted: false, reason: "anchor-mount-token-mismatch" };
                const leaseExpiresAt = new Date(now.getTime() + ANCHOR_LEASE_MS).toISOString();
                this.database.sqlite.prepare(`
                  update continuation_tasks set anchor_mount_verified_at=?, anchor_mount_coordinator_id=?,
                    last_anchor_mounted_at=?, anchor_lease_expires_at=?,
                    last_ui_heartbeat_at=?, coordinator_instance_id=?, last_activity_at=?, updated_at=?
                  where id=?
                `).run(nowIso, coordinatorInstanceId, nowIso, leaseExpiresAt,
                    nowIso, coordinatorInstanceId, nowIso, nowIso, taskId);
                this.syncContinuationArchitectureForLegacyTask(taskId);
                return {
                    task: rowToTask(this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(taskId)),
                    accepted: true,
                    reason: "anchor-mount-verified-via-heartbeat",
                };
            }
            const verifiedAnchorHeartbeat = Boolean(row.anchor_mount_verified_at)
                && Boolean(coordinatorInstanceId)
                && coordinatorInstanceId === row.anchor_mount_coordinator_id;
            const anchorLeaseExpiresAt = verifiedAnchorHeartbeat
                ? new Date(now.getTime() + ANCHOR_LEASE_MS).toISOString()
                : row.anchor_lease_expires_at;
            const mode = normalizedMode(row.continuation_mode, "compat");
            const required = parseJson(row.required_milestones_json, []);
            const completed = new Set(parseJson(row.completed_milestones_json, []));
            const incomplete = required.length > 0 && required.some((milestone) => !completed.has(milestone));
            const leaseExpiresAt = row.turn_lease_expires_at ? Date.parse(row.turn_lease_expires_at) : NaN;
            const leaseExpired = verifiedAnchorHeartbeat
                && mode === "completion-driven" && row.state === "RUNNING" && incomplete
                && Number.isFinite(leaseExpiresAt) && now.getTime() >= leaseExpiresAt;
            let stallState = String(row.stall_state || "ACTIVE");
            let stallSuspectedAt = row.stall_suspected_at ?? null;
            let stallProbeCount = Number(row.stall_probe_count || 0);
            let stallLastProbeAt = row.stall_last_probe_at ?? null;
            let stallArmedAt = row.stall_armed_at ?? null;
            let stallEvidence = row.stall_evidence ?? null;
            if (leaseExpired) {
                if (stallState === "ACTIVE") {
                    stallState = "SUSPECTED_STALL";
                    stallSuspectedAt = nowIso;
                    stallProbeCount = 1;
                    stallLastProbeAt = nowIso;
                    stallArmedAt = null;
                    stallEvidence = "model-activity-lease-expired";
                }
                else if (stallState === "SUSPECTED_STALL") {
                    stallProbeCount += 1;
                    stallLastProbeAt = nowIso;
                }
                // A verified card heartbeat only proves UI liveness. Historical
                // cutoff observations are telemetry, not current-turn end
                // evidence, so heartbeat must leave SUSPECTED_STALL fail-closed
                // regardless of how far the current turn exceeds prior samples.
            }
            const lastUiHeartbeatAt = verifiedAnchorHeartbeat ? nowIso : row.last_ui_heartbeat_at;
            const authoritativeCoordinatorId = verifiedAnchorHeartbeat ? coordinatorInstanceId : row.coordinator_instance_id;
            this.database.sqlite.prepare(`
              update continuation_tasks set last_activity_at=?, last_ui_heartbeat_at=?, coordinator_instance_id=?,
                anchor_lease_expires_at=?,
                stall_state=?, stall_suspected_at=?, stall_probe_count=?, stall_last_probe_at=?, stall_armed_at=?, stall_evidence=?,
                updated_at=?
              where id=?
            `).run(nowIso, lastUiHeartbeatAt, authoritativeCoordinatorId, anchorLeaseExpiresAt,
                stallState, stallSuspectedAt, stallProbeCount, stallLastProbeAt, stallArmedAt, stallEvidence,
                nowIso, taskId);
            return { task: rowToTask(this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(taskId)), accepted: true };
        }
        if (action === "host-signal") {
            const requestingCoordinatorId = input.coordinatorInstanceId ? String(input.coordinatorInstanceId) : "";
            if (row.anchor_mount_verified_at && requestingCoordinatorId
                && requestingCoordinatorId !== String(row.anchor_mount_coordinator_id || "")) {
                return { task: rowToTask(row), accepted: false, reason: "stale-anchor-coordinator" };
            }
            const hostProfileId = String(input.hostProfileId ?? row.host_profile_id ?? "unknown-host").trim().slice(0, 160) || "unknown-host";
            const hostSignal = String(input.hostSignal ?? "unknown").trim().slice(0, 80) || "unknown";
            const mode = normalizedMode(row.continuation_mode, "compat");
            const authoritativeLifecycleCoordinator = Boolean(row.anchor_mount_verified_at)
                && Boolean(requestingCoordinatorId)
                && requestingCoordinatorId === String(row.anchor_mount_coordinator_id || "");
            if (["completion-driven", "timeout-recovery"].includes(mode) && ["timeout", "teardown"].includes(hostSignal)
                && !authoritativeLifecycleCoordinator) {
                // A model can call continuation_task too, so a lifecycle signal
                // without the verified current Workspace App coordinator is not
                // Host evidence. This prevents a short model turn from forging
                // its own timeout/teardown in order to obtain another turn.
                return { task: rowToTask(row), accepted: false, reason: "verified-anchor-coordinator-required" };
            }
            const elapsedRaw = Number(input.elapsedMs ?? 0);
            const elapsedMs = Number.isFinite(elapsedRaw) ? Math.max(0, Math.min(Math.round(elapsedRaw), 24 * 60 * 60 * 1000)) : 0;
            const profile = this.database.sqlite.prepare("select * from continuation_host_profiles where id=?").get(hostProfileId);
            let observedTurnBudgetMs = profile?.observed_turn_budget_ms ?? row.observed_turn_budget_ms ?? null;
            let recommendedContinueAfterMs = profile?.recommended_continue_after_ms ?? row.recommended_continue_after_ms ?? null;
            let timeoutSamples = Number(profile?.timeout_samples ?? row.host_timeout_samples ?? 0);
            let confirmedTurnLimitMs = profile?.confirmed_turn_limit_ms ?? row.confirmed_turn_limit_ms ?? null;
            let confirmedTurnLimitAt = profile?.confirmed_turn_limit_at ?? row.confirmed_turn_limit_at ?? null;
            let confirmedTurnLimitSource = profile?.confirmed_turn_limit_source ?? row.confirmed_turn_limit_source ?? null;
            let cutoffSamples = numericSamples(profile?.cutoff_samples_json ?? row.cutoff_samples_json);
            let cutoffEpoch = Number(profile?.cutoff_epoch ?? row.cutoff_epoch ?? 0);
            let cutoffRegimeChangedAt = profile?.cutoff_regime_changed_at ?? row.cutoff_regime_changed_at ?? null;
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
                const adapted = adaptHostCutoffRegime({
                    elapsedMs, confirmedTurnLimitMs, confirmedTurnLimitSource,
                    cutoffSamples, cutoffEpoch, cutoffRegimeChangedAt, nowIso,
                });
                if (adapted.confirmedTurnLimitMs) {
                    confirmedTurnLimitMs = adapted.confirmedTurnLimitMs;
                    confirmedTurnLimitAt = nowIso;
                    confirmedTurnLimitSource = adapted.confirmedTurnLimitSource;
                }
                cutoffSamples = adapted.cutoffSamples;
                cutoffEpoch = adapted.cutoffEpoch;
                cutoffRegimeChangedAt = adapted.cutoffRegimeChangedAt;
            }
            if (profile) {
                this.database.sqlite.prepare(`
                  update continuation_host_profiles set observed_turn_budget_ms=?, recommended_continue_after_ms=?,
                    timeout_samples=?, last_timeout_at=?, last_signal=?, last_signal_at=?,
                    confirmed_turn_limit_ms=?, confirmed_turn_limit_at=?, confirmed_turn_limit_source=?,
                    cutoff_samples_json=?, cutoff_epoch=?, cutoff_regime_changed_at=?, updated_at=? where id=?
                `).run(observedTurnBudgetMs, recommendedContinueAfterMs, timeoutSamples,
                    hostSignal === "timeout" ? nowIso : profile.last_timeout_at,
                    hostSignal, nowIso, confirmedTurnLimitMs, confirmedTurnLimitAt, confirmedTurnLimitSource,
                    JSON.stringify(cutoffSamples), cutoffEpoch, cutoffRegimeChangedAt, nowIso, hostProfileId);
            }
            else {
                this.database.sqlite.prepare(`
                  insert into continuation_host_profiles (
                    id, observed_turn_budget_ms, recommended_continue_after_ms, timeout_samples,
                    last_timeout_at, last_signal, last_signal_at,
                    confirmed_turn_limit_ms, confirmed_turn_limit_at, confirmed_turn_limit_source,
                    cutoff_samples_json, cutoff_epoch, cutoff_regime_changed_at,
                    created_at, updated_at
                  ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `).run(hostProfileId, observedTurnBudgetMs, recommendedContinueAfterMs, timeoutSamples,
                    hostSignal === "timeout" ? nowIso : null, hostSignal, nowIso,
                    confirmedTurnLimitMs, confirmedTurnLimitAt, confirmedTurnLimitSource,
                    JSON.stringify(cutoffSamples), cutoffEpoch, cutoffRegimeChangedAt, nowIso, nowIso);
            }
            const currentTurnLeaseId = String(row.turn_lease_id || "").trim();
            const completionIntentMatchesCurrentTurn = hostSignal === "teardown"
                && mode === "completion-driven"
                && row.state === "RUNNING"
                && String(row.assistant_turn_state || "") === "COMPLETION_REQUESTED"
                && Boolean(currentTurnLeaseId)
                && String(row.assistant_turn_completion_lease_id || "") === currentTurnLeaseId;
            const explicitTimeoutEndsCurrentTurn = hostSignal === "timeout"
                && ["completion-driven", "timeout-recovery"].includes(mode)
                && row.state === "RUNNING"
                && Boolean(currentTurnLeaseId);
            const assistantTurnEnded = explicitTimeoutEndsCurrentTurn || completionIntentMatchesCurrentTurn;
            const assistantTurnState = explicitTimeoutEndsCurrentTurn
                ? "TIMED_OUT"
                : completionIntentMatchesCurrentTurn
                    ? "COMPLETED"
                    : String(row.assistant_turn_state || "UNKNOWN");
            const assistantTurnCompletionLeaseId = assistantTurnEnded
                ? currentTurnLeaseId
                : row.assistant_turn_completion_lease_id;
            const assistantTurnCompletedAt = assistantTurnEnded ? nowIso : row.assistant_turn_completed_at;
            const assistantTurnCompletionSource = explicitTimeoutEndsCurrentTurn
                ? "explicit-host-timeout"
                : completionIntentMatchesCurrentTurn
                    ? "model-intent+host-teardown"
                    : row.assistant_turn_completion_source;
            const assistantTurnCompletionNote = explicitTimeoutEndsCurrentTurn
                ? String(input.note ?? "explicit-host-timeout").slice(0, 1000)
                : row.assistant_turn_completion_note;
            const nextStallState = assistantTurnEnded ? "CONTINUATION_ARMED" : String(row.stall_state || "ACTIVE");
            const nextStallArmedAt = assistantTurnEnded ? nowIso : row.stall_armed_at;
            const nextStallEvidence = explicitTimeoutEndsCurrentTurn
                ? "atcc-explicit-host-timeout"
                : completionIntentMatchesCurrentTurn
                    ? "atcc-model-completion+host-teardown"
                    : row.stall_evidence;
            this.database.sqlite.prepare(`
              update continuation_tasks set host_profile_id=?, observed_turn_budget_ms=?, recommended_continue_after_ms=?,
                host_timeout_samples=?, confirmed_turn_limit_ms=?, confirmed_turn_limit_at=?, confirmed_turn_limit_source=?,
                cutoff_samples_json=?, cutoff_epoch=?, cutoff_regime_changed_at=?,
                last_host_signal=?, last_host_signal_at=?, coordinator_instance_id=?,
                assistant_turn_state=?,assistant_turn_completion_lease_id=?,assistant_turn_completed_at=?,
                assistant_turn_completion_source=?,assistant_turn_completion_note=?,
                stall_state=?,stall_armed_at=?,stall_evidence=?,
                updated_at=?
              where id=?
            `).run(hostProfileId, observedTurnBudgetMs, recommendedContinueAfterMs, timeoutSamples,
                confirmedTurnLimitMs, confirmedTurnLimitAt, confirmedTurnLimitSource,
                JSON.stringify(cutoffSamples), cutoffEpoch, cutoffRegimeChangedAt,
                hostSignal, nowIso, input.coordinatorInstanceId ? String(input.coordinatorInstanceId) : row.coordinator_instance_id,
                assistantTurnState, assistantTurnCompletionLeaseId, assistantTurnCompletedAt,
                assistantTurnCompletionSource, assistantTurnCompletionNote,
                nextStallState, nextStallArmedAt, nextStallEvidence,
                nowIso, taskId);
            const task = rowToTask(this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(taskId));
            return {
                task,
                accepted: true,
                reason: explicitTimeoutEndsCurrentTurn
                    ? "assistant-turn-timeout-confirmed"
                    : completionIntentMatchesCurrentTurn
                        ? "assistant-turn-completion-confirmed"
                        : "host-signal-recorded-no-turn-completion",
                ...continuationDirective(task),
            };
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
            const previousConfirmed = Number(row.confirmed_turn_limit_ms || 0);
            const materialRegimeChange = previousConfirmed >= HOST_CUTOFF_MIN_SAMPLE_MS
                && (confirmedTurnLimitMs < previousConfirmed * HOST_CUTOFF_REGIME_DOWN_RATIO
                    || confirmedTurnLimitMs > previousConfirmed * HOST_CUTOFF_REGIME_UP_RATIO);
            const cutoffEpoch = Number(row.cutoff_epoch || 0) + (materialRegimeChange ? 1 : 0);
            this.database.sqlite.prepare(`
              update continuation_tasks set confirmed_turn_limit_ms=?, confirmed_turn_limit_at=?,
                confirmed_turn_limit_source=?, cutoff_samples_json=?, cutoff_epoch=?, cutoff_regime_changed_at=?,
                last_activity_at=?, updated_at=? where id=?
            `).run(confirmedTurnLimitMs, nowIso, source, JSON.stringify([confirmedTurnLimitMs]), cutoffEpoch,
                materialRegimeChange ? nowIso : row.cutoff_regime_changed_at, nowIso, nowIso, taskId);
            const hostProfileId = String(row.host_profile_id ?? "").trim();
            if (hostProfileId) {
                const profile = this.database.sqlite.prepare("select * from continuation_host_profiles where id=?").get(hostProfileId);
                if (profile) {
                    const profilePrevious = Number(profile.confirmed_turn_limit_ms || 0);
                    const profileRegimeChange = profilePrevious >= HOST_CUTOFF_MIN_SAMPLE_MS
                        && (confirmedTurnLimitMs < profilePrevious * HOST_CUTOFF_REGIME_DOWN_RATIO
                            || confirmedTurnLimitMs > profilePrevious * HOST_CUTOFF_REGIME_UP_RATIO);
                    const profileEpoch = Number(profile.cutoff_epoch || 0) + (profileRegimeChange ? 1 : 0);
                    this.database.sqlite.prepare(`
                      update continuation_host_profiles set confirmed_turn_limit_ms=?, confirmed_turn_limit_at=?,
                        confirmed_turn_limit_source=?, cutoff_samples_json=?, cutoff_epoch=?, cutoff_regime_changed_at=?,
                        updated_at=? where id=?
                    `).run(confirmedTurnLimitMs, nowIso, source, JSON.stringify([confirmedTurnLimitMs]), profileEpoch,
                        profileRegimeChange ? nowIso : profile.cutoff_regime_changed_at, nowIso, hostProfileId);
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
            const awaitingModelAck = delivered && [4, 5].includes(nextPending);
            const nextRetryCount = awaitingModelAck
                ? Math.max(1, Number(row.delivery_ack_retry_count || 0) + 1)
                : 0;
            const retryAfterAt = awaitingModelAck
                ? new Date(now.getTime() + deliveryAckRetryDelayMs(nextRetryCount)).toISOString()
                : null;
            const ackStartedAt = awaitingModelAck ? (row.delivery_ack_started_at ?? nowIso) : null;
            this.database.sqlite.prepare(`
              update continuation_tasks set last_send_attempt_at=?, last_send_result=?, coordinator_instance_id=?,
                continuation_pending=?, delivery_ack_started_at=?, delivery_ack_retry_count=?,
                delivery_ack_retry_after_at=?, updated_at=?
              where id=?
            `).run(nowIso, JSON.stringify(delivery), input.coordinatorInstanceId ? String(input.coordinatorInstanceId) : row.coordinator_instance_id,
                nextPending, ackStartedAt, nextRetryCount, retryAfterAt, nowIso, taskId);
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
            const requiredBefore = parseJson(row.required_milestones_json, []);
            const required = new Set(requiredBefore);
            for (const value of Array.isArray(input.requiredMilestones) ? input.requiredMilestones : []) {
                const item = String(value).trim();
                if (item) required.add(item);
            }
            const requiredMilestones = [...required].slice(0, 64);
            const requiredMilestoneSetChanged = requiredBefore.length !== requiredMilestones.length
                || requiredBefore.some((value, index) => value !== requiredMilestones[index]);
            const syntheticMilestoneRevision = String(row.delivery_owner || "") === "synthetic-active"
                && requiredMilestoneSetChanged;
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
            const completedBefore = new Set(parseJson(row.completed_milestones_json, []));
            const gainedCompletedMilestone = [...completed].some((item) => !completedBefore.has(item));
            const progressChanged = input.progressFingerprint !== undefined
                && Boolean(progress)
                && progress !== String(row.progress_fingerprint || "");
            const evidenceChanged = Object.keys(checkpointEvidence).some((key) => {
                try {
                    return JSON.stringify(priorEvidence?.[key]) !== JSON.stringify(checkpointEvidence[key]);
                }
                catch {
                    return true;
                }
            });
            const materialCheckpoint = gainedCompletedMilestone || progressChanged || evidenceChanged;
            const realToolAfterSyntheticAck = String(row.delivery_owner || "") === "synthetic-active"
                && Number(row.substantive_activity_count || 0) > Number(row.delivery_work_baseline_count || 0);
            const watchedHandles = parseJson(row.watch_process_handles_json, []);
            const waitingForSupervisorAck = Boolean(input.waitingExternal && watchedHandles.length > 0);
            const pausedByUser = row.state === "PAUSED_BY_USER";
            let state = pausedByUser
                ? "PAUSED_BY_USER"
                : input.waitingExternal
                    ? (waitingForSupervisorAck ? "WAITING_SUPERVISOR" : "WAITING_EXTERNAL")
                    : "RUNNING";
            const remainingAfterCheckpoint = requiredMilestones.filter((milestone) => !completed.has(milestone));
            // A checkpoint is persistence, not permission to stop. Keep the
            // synthetic generation active while runnable milestones remain so
            // an early model final cannot be mistaken for a successful resume.
            // The generation may retire only after real post-ACK work plus a
            // material checkpoint AND a legitimate yield condition: all
            // milestones are complete or the task is explicitly non-runnable.
            const syntheticTurnMayYield = remainingAfterCheckpoint.length === 0 || state !== "RUNNING";
            const fulfillsSyntheticResume = realToolAfterSyntheticAck && materialCheckpoint && syntheticTurnMayYield;
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
            const completionEvidencePresent = Object.keys(evidence).length > 0;
            const canonicalCompletionSurfaceReady = !isCanonicalConversationScope(row.conversation_scope_id)
                || Boolean(row.anchor_mount_verified_at);
            const checkpointCanSealCompletion = completionDriven
                && state === "RUNNING"
                && requiredMilestones.length > 0
                && remainingAfterCheckpoint.length === 0
                && !row.owner_locked
                && canonicalCompletionSurfaceReady
                && completionEvidencePresent;
            if (checkpointCanSealCompletion) {
                // A completion-driven checkpoint already carries the same durable
                // proof that explicit complete() requires. Once every required
                // milestone is satisfied, leaving the task RUNNING creates a
                // stale control-plane object that can later be mistaken for work
                // needing another continuation. Seal it atomically instead.
                state = "SUCCEEDED";
                terminalReason = "completed";
                progressWarning = null;
            }
            const checkpointLeaseExpiresAt = normalizedMode(row.continuation_mode, "compat") === "completion-driven" && state === "RUNNING"
                ? completionTurnLeaseExpiresAt()
                : row.turn_lease_expires_at;
            this.database.sqlite.prepare(`
              update continuation_tasks set state=?, required_milestones_json=?, completed_milestones_json=?, evidence_json=?, progress_fingerprint=?, failure_fingerprint=?,
                no_progress_count=?, same_failure_count=?, waiting_reason=?, terminal_reason=?, continuation_pending=0,
                last_model_activity_at=?, last_activity_at=?, turn_lease_expires_at=?,
                superseded_delivery_token=case when ? then coalesce(delivery_token,superseded_delivery_token) else superseded_delivery_token end,
                delivery_token=case when ? then null else delivery_token end,
                delivery_owner=case when ? then 'synthetic-worked' else delivery_owner end,
                delivery_owner_expires_at=case when ? then null else delivery_owner_expires_at end,
                delivery_ack_started_at=case when ? then null else delivery_ack_started_at end,
                delivery_work_baseline_count=case when ? then 0 else delivery_work_baseline_count end,
                stall_state=case when ?='RUNNING' and continuation_mode='completion-driven' then 'ACTIVE' else stall_state end,
                stall_suspected_at=case when ?='RUNNING' and continuation_mode='completion-driven' then null else stall_suspected_at end,
                stall_probe_count=case when ?='RUNNING' and continuation_mode='completion-driven' then 0 else stall_probe_count end,
                stall_last_probe_at=case when ?='RUNNING' and continuation_mode='completion-driven' then null else stall_last_probe_at end,
                stall_armed_at=case when ?='RUNNING' and continuation_mode='completion-driven' then null else stall_armed_at end,
                stall_evidence=case when ?='RUNNING' and continuation_mode='completion-driven' then null else stall_evidence end,
                updated_at=?
              where id=?
            `).run(state, JSON.stringify(requiredMilestones), JSON.stringify([...completed]), JSON.stringify(evidence), progress || null, failure || null, noProgress, sameFailure,
                pausedByUser ? (row.waiting_reason || "Paused by Portable owner UI.")
                    : input.waitingExternal ? String(input.note ?? "Waiting for an external condition.") : progressWarning,
                terminalReason, nowIso, nowIso, checkpointLeaseExpiresAt,
                fulfillsSyntheticResume ? 1 : 0, fulfillsSyntheticResume ? 1 : 0,
                fulfillsSyntheticResume ? 1 : 0, fulfillsSyntheticResume ? 1 : 0,
                fulfillsSyntheticResume ? 1 : 0, fulfillsSyntheticResume ? 1 : 0,
                state, state, state, state, state, state, nowIso, taskId);
            if (terminalStates.has(state))
                this.closeTerminalContinuationArtifacts(taskId, terminalReason || state, nowIso);
            this.syncContinuationArchitectureForLegacyTask(taskId);
            let refreshed = this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(taskId);
            if (syntheticMilestoneRevision && !terminalStates.has(state)) {
                const card = this.database.sqlite.prepare(`
                  select * from continuation_conversation_cards where conversation_scope_id=?
                `).get(refreshed.conversation_scope_id);
                const alreadyPendingFreshCard = Number(refreshed.anchor_mount_generation || 0) > 0
                    && !refreshed.anchor_mount_verified_at
                    && Number(card?.mount_generation || 0) === Number(refreshed.anchor_mount_generation || 0)
                    && !card?.mount_verified_at;
                if (!alreadyPendingFreshCard)
                    refreshed = this.rotateContinuationManualRoundCard(taskId, nowIso) || refreshed;
            }
            const task = rowToTask(refreshed);
            return {
                task,
                accepted: true,
                ...(waitingForSupervisorAck ? { reason: "supervisor-ack-pending" } : {}),
                ...(syntheticMilestoneRevision && !terminalStates.has(state) ? {
                    milestoneCardRequired: true,
                    initialAnchorRequired: true,
                    reanchorRequired: true,
                    conversationLifetimeSingleton: false,
                } : {}),
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
            this.syncContinuationArchitectureForLegacyTask(taskId);
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
            this.database.sqlite.prepare(`
              update continuation_tasks set state='RUNNING',waiting_reason=null,continuation_pending=0,
                turn_started_at=?,turn_lease_id=?,turn_lease_expires_at=?,
                assistant_turn_state='GENERATING',assistant_turn_owner=case
                  when delivery_owner='synthetic-active' then 'synthetic' else 'manual' end,
                assistant_turn_completion_lease_id=null,assistant_turn_completion_requested_at=null,
                assistant_turn_completed_at=null,assistant_turn_completion_source=null,
                assistant_turn_completion_note=null,
                delivery_work_baseline_count=coalesce(substantive_activity_count,0),
                last_model_activity_at=?,last_activity_at=?,stall_state='ACTIVE',
                stall_suspected_at=null,stall_probe_count=0,stall_last_probe_at=null,
                stall_armed_at=null,stall_evidence=null,updated_at=? where id=?
            `).run(nowIso, turnLeaseId, turnLeaseExpiresAt, nowIso, nowIso, nowIso, taskId);
            this.syncContinuationArchitectureForLegacyTask(taskId);
            const task = rowToTask(this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(taskId));
            return { task, accepted: true, ...continuationDirective(task) };
        }
        if (action === "cancel") {
            if (row.owner_locked) {
                return { task: rowToTask(row), accepted: false, reason: "task-owner-locked" };
            }
            this.database.sqlite.transaction(() => {
                this.database.sqlite.prepare("update continuation_tasks set state='CANCELLED_BY_USER', terminal_reason='user-cancelled', continuation_pending=0, updated_at=? where id=?")
                    .run(nowIso, taskId);
                this.closeTerminalContinuationArtifacts(taskId, "user-cancelled", nowIso);
            })();
            this.syncContinuationArchitectureForLegacyTask(taskId);
            return { task: rowToTask(this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(taskId)), accepted: true };
        }
        if (action === "fail") {
            const terminal = input.terminal !== false;
            if (terminal && row.owner_locked) {
                return { task: rowToTask(row), accepted: false, reason: "task-owner-locked" };
            }
            const failureReason = String(input.note ?? "Task failed.");
            this.database.sqlite.transaction(() => {
                this.database.sqlite.prepare("update continuation_tasks set state=?, terminal_reason=?, continuation_pending=0, updated_at=? where id=?")
                    .run(terminal ? "FAILED_TERMINAL" : "FAILED_RETRYABLE", failureReason, nowIso, taskId);
                if (terminal)
                    this.closeTerminalContinuationArtifacts(taskId, failureReason, nowIso);
            })();
            this.syncContinuationArchitectureForLegacyTask(taskId);
            return { task: rowToTask(this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(taskId)), accepted: true };
        }
        if (action === "complete") {
            if (row.owner_locked) {
                return { task: rowToTask(row), accepted: false, reason: "task-owner-locked" };
            }
            if (isCanonicalConversationScope(row.conversation_scope_id) && !row.anchor_mount_verified_at) {
                return {
                    task: rowToTask(row),
                    accepted: false,
                    reason: row.anchor_mount_requested_at
                        ? "anchor-mount-verification-pending"
                        : "continuation-anchor-required",
                };
            }
            const persistedRequiredMilestones = parseJson(row.required_milestones_json, [])
                .map((value) => String(value).trim()).filter(Boolean);
            const suppliedRequiredMilestones = [...new Set((Array.isArray(input.requiredMilestones) ? input.requiredMilestones : [])
                .map((value) => String(value).trim()).filter(Boolean))].slice(0, 64);
            const suppliedRequiredSet = new Set(suppliedRequiredMilestones);
            const omittedPersistedMilestones = suppliedRequiredMilestones.length > 0
                ? persistedRequiredMilestones.filter((milestone) => !suppliedRequiredSet.has(milestone))
                : [];
            const legacyFallbackOnlyRepair = suppliedRequiredMilestones.length > 0
                && omittedPersistedMilestones.length > 0
                && omittedPersistedMilestones.every((milestone) => DEFAULT_TASK_CONTRACT_MILESTONES.includes(milestone));
            // dev15 could transiently resurrect an already-completed terminal
            // task when continuation_anchor mounted the next manual card.  A
            // following architecture recovery then appended the two generic
            // default milestones.  Allow complete() to repair exactly that
            // legacy contamination when the caller supplies an authoritative
            // completed plan and every omitted persisted item is one of the
            // built-in fallback placeholders.  Custom/user milestones can
            // never be removed through this compatibility path.
            const requiredMilestones = legacyFallbackOnlyRepair
                ? suppliedRequiredMilestones
                : persistedRequiredMilestones;
            const required = new Set(requiredMilestones);
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
            this.database.sqlite.transaction(() => {
                this.database.sqlite.prepare(`
                  update continuation_tasks set state='SUCCEEDED', required_milestones_json=?, completed_milestones_json=?, evidence_json=?,
                    terminal_reason='completed', continuation_pending=0,
                    turn_lease_expires_at=null, anchor_lease_expires_at=null, updated_at=? where id=?
                `).run(JSON.stringify(requiredMilestones), JSON.stringify([...completed]), JSON.stringify(evidence), nowIso, taskId);
                this.closeTerminalContinuationArtifacts(taskId, "completed", nowIso);
            })();
            this.syncContinuationArchitectureForLegacyTask(taskId);
            return { task: rowToTask(this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(taskId)), accepted: true };
        }
        if (action === "claim-continuation") {
            const transaction = this.database.sqlite.transaction(() => {
                let current = this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(taskId);
                if (!current || terminalStates.has(current.state)) return { accepted: false, reason: "task-terminal", task: rowToTask(current) };
                if (current.state === "PAUSED_BY_USER") return { accepted: false, reason: "task-paused-by-user", task: rowToTask(current) };
                if (current.state === "WAITING_EXTERNAL") return { accepted: false, reason: "waiting-external", task: rowToTask(current) };
                const requestingCoordinatorId = String(input.coordinatorInstanceId ?? "").trim();
                if (requestingCoordinatorId) {
                    const verifiedCoordinatorId = String(current.anchor_mount_coordinator_id ?? "").trim();
                    if (!current.anchor_mount_verified_at || !verifiedCoordinatorId || requestingCoordinatorId !== verifiedCoordinatorId) {
                        return { accepted: false, reason: "stale-anchor-coordinator", task: rowToTask(current) };
                    }
                }
                let pendingState = Number(current.continuation_pending || 0);
                const wakePending = pendingState === 2 || pendingState === 3 || pendingState === 4;
                let deliveryAckRetryAuthorized = false;
                if (wakePending && normalizedMode(current.continuation_mode, "compat") !== "resident") {
                    this.database.sqlite.prepare("update continuation_tasks set continuation_pending=0, updated_at=? where id=?").run(nowIso, taskId);
                    return { accepted: false, reason: "resident-mode-required", task: rowToTask(this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(taskId)) };
                }
                if (pendingState === 4 || pendingState === 5) {
                    const retryCount = Math.max(1, Number(current.delivery_ack_retry_count || 1));
                    const retryAfterAt = current.delivery_ack_retry_after_at ? Date.parse(current.delivery_ack_retry_after_at) : NaN;
                    const sendAt = current.last_send_attempt_at ? Date.parse(current.last_send_attempt_at) : NaN;
                    const fallbackRetryAt = Number.isFinite(sendAt) ? sendAt + deliveryAckRetryDelayMs(retryCount) : NaN;
                    const effectiveRetryAt = Number.isFinite(retryAfterAt) ? retryAfterAt : fallbackRetryAt;
                    if (Number.isFinite(effectiveRetryAt) && now.getTime() < effectiveRetryAt) {
                        return {
                            accepted: false,
                            reason: "continuation-delivery-awaiting-ack",
                            deliveryAckRetryCount: retryCount,
                            retryAfterMs: Math.max(0, effectiveRetryAt - now.getTime()),
                            task: rowToTask(current),
                        };
                    }
                    // This is a retransmission of an already-authorized logical
                    // continuation, not a fresh timeout/stall inference. Keep it
                    // durable even if the original Host signal is now older than
                    // the ordinary authorization freshness window.
                    deliveryAckRetryAuthorized = true;
                    pendingState = pendingState === 4 ? 2 : 0;
                    this.database.sqlite.prepare("update continuation_tasks set continuation_pending=?, updated_at=? where id=?")
                        .run(pendingState, nowIso, taskId);
                    current.continuation_pending = pendingState;
                }
                if (pendingState === 1 || pendingState === 3) {
                    const pendingAge = current.last_continuation_at ? now.getTime() - Date.parse(current.last_continuation_at) : 0;
                    const leaseMs = pendingState === 3 ? 15_000 : 45_000;
                    if (pendingAge < leaseMs) {
                        return { accepted: false, reason: "continuation-already-pending", task: rowToTask(current) };
                    }
                    pendingState = pendingState === 3 ? 2 : 0;
                    this.database.sqlite.prepare("update continuation_tasks set continuation_pending=?, updated_at=? where id=?").run(pendingState, nowIso, taskId);
                    current.continuation_pending = pendingState;
                }
                const currentMode = normalizedMode(current.continuation_mode, "compat");
                if (currentMode === "completion-driven"
                    && String(current.assistant_turn_state || "") === "COMPLETION_REQUESTED") {
                    this.promoteMatureAssistantCompletionIntent(current.id, now.getTime());
                    current = this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(taskId);
                }
                const continuationNote = String(input.note ?? "");
                const manualRecovery = /manual recovery/i.test(continuationNote);
                const requiredMilestones = parseJson(current.required_milestones_json, []);
                const completedMilestones = new Set(parseJson(current.completed_milestones_json, []));
                const taskIncomplete = requiredMilestones.length > 0
                    && requiredMilestones.some((milestone) => !completedMilestones.has(milestone));
                const assistantTurnState = String(current.assistant_turn_state || "UNKNOWN");
                const assistantTurnLeaseId = String(current.assistant_turn_completion_lease_id || "");
                const currentTurnLeaseId = String(current.turn_lease_id || "");
                const assistantTurnEnded = (currentMode === "completion-driven"
                    ? ["COMPLETED", "TIMED_OUT"].includes(assistantTurnState)
                    : currentMode === "timeout-recovery" && assistantTurnState === "TIMED_OUT")
                    && current.state === "RUNNING"
                    && taskIncomplete
                    && Boolean(currentTurnLeaseId)
                    && assistantTurnLeaseId === currentTurnLeaseId
                    && String(current.stall_state || "ACTIVE") === "CONTINUATION_ARMED";
                if (!wakePending && !deliveryAckRetryAuthorized && !manualRecovery && !assistantTurnEnded) {
                    return { accepted: false, reason: "continuation-trigger-not-authorized", task: rowToTask(current) };
                }
                if (!wakePending && !deliveryAckRetryAuthorized && !assistantTurnEnded
                    && current.last_continuation_at && now.getTime() - Date.parse(current.last_continuation_at) < CONTINUATION_COOLDOWN_MS) {
                    return { accepted: false, reason: "continuation-cooldown", task: rowToTask(current) };
                }
                if (current.deadline_at && Date.parse(current.deadline_at) <= now.getTime()) {
                    if (current.owner_locked) {
                        this.database.sqlite.prepare("update continuation_tasks set waiting_reason='Owner lock prevented automatic wall-clock termination.', owner_control_note='wall-clock-budget-reached-while-locked', updated_at=? where id=?").run(nowIso, taskId);
                        return { accepted: false, reason: "task-owner-locked-budget", task: rowToTask(this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(taskId)) };
                    }
                    this.database.sqlite.prepare("update continuation_tasks set state='BUDGET_EXHAUSTED', terminal_reason='wall-clock-budget', updated_at=? where id=?").run(nowIso, taskId);
                    this.closeTerminalContinuationArtifacts(taskId, "wall-clock-budget", nowIso);
                    return { accepted: false, reason: "wall-clock-budget", task: rowToTask(this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(taskId)) };
                }
                if (!deliveryAckRetryAuthorized && Number(current.max_continuations || 0) > 0 && current.continuation_count >= current.max_continuations) {
                    if (current.owner_locked) {
                        this.database.sqlite.prepare("update continuation_tasks set waiting_reason='Owner lock prevented automatic continuation-budget termination.', owner_control_note='continuation-budget-reached-while-locked', updated_at=? where id=?").run(nowIso, taskId);
                        return { accepted: false, reason: "task-owner-locked-budget", task: rowToTask(this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(taskId)) };
                    }
                    this.database.sqlite.prepare("update continuation_tasks set state='BUDGET_EXHAUSTED', terminal_reason='continuation-budget', updated_at=? where id=?").run(nowIso, taskId);
                    this.closeTerminalContinuationArtifacts(taskId, "continuation-budget", nowIso);
                    return { accepted: false, reason: "continuation-budget", task: rowToTask(this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(taskId)) };
                }
                const nextContinuationCount = Number(current.continuation_count || 0) + (deliveryAckRetryAuthorized ? 0 : 1);
                const nextDeliveryGeneration = deliveryAckRetryAuthorized
                    ? Number(current.delivery_generation || 0)
                    : Number(current.delivery_generation || 0) + 1;
                const nextDeliveryToken = deliveryAckRetryAuthorized && current.delivery_token
                    ? current.delivery_token
                    : randomUUID();
                this.database.sqlite.prepare(`
                  update continuation_tasks set continuation_pending=?, continuation_count=?,
                    delivery_generation=?, delivery_token=?, delivery_owner='synthetic-pending',
                    delivery_owner_expires_at=?, delivery_work_baseline_count=0, superseded_delivery_token=null,
                    last_continuation_at=?, updated_at=? where id=?
                `).run(wakePending ? 3 : 1, nextContinuationCount, nextDeliveryGeneration, nextDeliveryToken,
                    new Date(now.getTime() + 10 * 60_000).toISOString(), nowIso, nowIso, taskId);
                return {
                    accepted: true,
                    ...(deliveryAckRetryAuthorized ? { deliveryAckRetry: true } : {}),
                    ...(assistantTurnEnded ? { assistantTurnCompletion: assistantTurnState } : {}),
                    deliveryToken: nextDeliveryToken,
                    deliveryGeneration: nextDeliveryGeneration,
                    task: rowToTask(this.database.sqlite.prepare("select * from continuation_tasks where id=?").get(taskId)),
                };
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
