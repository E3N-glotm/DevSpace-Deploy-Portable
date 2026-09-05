import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const runtimeStatePath = join(
  ROOT,
  "app",
  "node_modules",
  "@waishnav",
  "devspace",
  "dist",
  "runtime-state.js",
);

const { StructuredRuntimeState } = await import(
  `${pathToFileURL(runtimeStatePath).href}?atcc=${Date.now()}`
);

const stateDir = mkdtempSync(join(tmpdir(), "devspace-atcc-test-"));
const runtime = new StructuredRuntimeState(stateDir);

function begin(scope, workspace = `ws_${scope}`) {
  const outcome = runtime.continuationTask({
    action: "begin",
    conversationScopeId: scope,
    workspaceId: workspace,
    objective: `ATCC test ${scope}`,
    requiredMilestones: ["finish"],
  });
  assert.equal(outcome.task.state, "RUNNING");
  assert.equal(outcome.task.continuationMode, "completion-driven");
  assert.equal(outcome.task.assistantTurnState, "GENERATING");
  assert.ok(outcome.task.turnLeaseId);
  return outcome;
}

function mount(outcome, scope, coordinator) {
  const requested = runtime.prepareContinuationAnchorMount({
    taskId: outcome.task.id,
    conversationScopeId: scope,
  });
  assert.ok(requested.anchorMountToken);
  const mounted = runtime.continuationTask({
    action: "anchor-mounted",
    taskId: outcome.task.id,
    conversationScopeId: scope,
    coordinatorInstanceId: coordinator,
    anchorMountToken: requested.anchorMountToken,
  });
  assert.equal(mounted.accepted, true);
  assert.ok(mounted.task.anchorMountVerifiedAt);
  return mounted;
}

function work(outcome, scope, count = 1) {
  for (let index = 0; index < count; index += 1) {
    runtime.touchContinuationModelActivity({
      workspaceId: outcome.task.workspaceId,
      conversationScopeId: scope,
      substantive: true,
    });
  }
  return runtime.continuationTask({ action: "status", taskId: outcome.task.id });
}

try {
  const migration = runtime.database.sqlite
    .prepare("select max(version) as version from devspace_schema_migrations")
    .get();
  assert.equal(migration.version, 33, "ATCC plus the permanent lifetime singleton repair must reach schema migration 33");
  const columns = new Set(
    runtime.database.sqlite
      .prepare("pragma table_info('continuation_tasks')")
      .all()
      .map((row) => row.name),
  );
  for (const column of [
    "assistant_turn_state",
    "assistant_turn_owner",
    "assistant_turn_completion_lease_id",
    "assistant_turn_completion_requested_at",
    "assistant_turn_completed_at",
    "assistant_turn_completion_source",
    "assistant_turn_completion_note",
  ]) assert.ok(columns.has(column), `missing ATCC column ${column}`);

  // A new conversation starts with status before any workspace exists.
  // The first manual handshake must already own a durable GENERATING turn.
  const firstManualScope = "v1/atcc-first-manual-status";
  const firstManual = runtime.continuationTask({ action: "status",
    conversationScopeId: firstManualScope, manualTakeover: true,
    objective: "First user request", requiredMilestones: ["finish"] });
  assert.ok(firstManual.task?.id, "first manual status must persist a lifetime task");
  assert.equal(firstManual.task.assistantTurnOwner, "manual");
  assert.equal(firstManual.task.assistantTurnState, "GENERATING");
  assert.ok(firstManual.task.manualTakeoverAt);
  assert.equal(firstManual.manualRoundCardRequired, true);
  const firstCard = runtime.prepareContinuationAnchorMount({
    taskId: firstManual.task.id, conversationScopeId: firstManualScope });
  assert.ok(firstCard.anchorMountToken);
  const firstRebound = runtime.continuationTask({ action: "begin",
    taskId: firstManual.task.id, conversationScopeId: firstManualScope,
    workspaceId: "ws_first_manual", requiredMilestones: ["finish"] });
  assert.equal(firstRebound.task.id, firstManual.task.id);
  assert.equal(firstRebound.task.turnLeaseId, firstManual.task.turnLeaseId);
  assert.equal(firstRebound.task.anchorMountGeneration, firstCard.anchorMountGeneration,
    "binding the first workspace must not issue a second manual card");
  assert.equal(firstRebound.task.assistantTurnOwner, "manual");

  // Long reasoning/request silence is telemetry only. Neither an expired
  // activity lease nor an old learned Host cutoff may create another turn.
  const longThinkScope = "conversation-atcc-long-think";
  const longThink = begin(longThinkScope);
  mount(longThink, longThinkScope, "ui_atcc_long_think");
  runtime.continuationTask({
    action: "confirm-turn-limit",
    taskId: longThink.task.id,
    elapsedMs: 30_000,
    note: "historical-only",
  });
  runtime.database.sqlite.prepare(`
    update continuation_tasks set
      turn_started_at=?,last_model_activity_at=?,turn_lease_expires_at=?
    where id=?
  `).run(
    new Date(Date.now() - 120_000).toISOString(),
    new Date(Date.now() - 90_000).toISOString(),
    new Date(Date.now() - 60_000).toISOString(),
    longThink.task.id,
  );
  const longThinkHeartbeat = runtime.continuationTask({
    action: "heartbeat",
    taskId: longThink.task.id,
    coordinatorInstanceId: "ui_atcc_long_think",
  });
  assert.equal(longThinkHeartbeat.task.assistantTurnState, "GENERATING");
  assert.equal(longThinkHeartbeat.task.stallState, "SUSPECTED_STALL");
  const longThinkClaim = runtime.continuationTask({
    action: "claim-continuation",
    taskId: longThink.task.id,
    note: "forged elapsed-time recovery",
  });
  assert.equal(longThinkClaim.accepted, false);
  assert.equal(longThinkClaim.reason, "continuation-trigger-not-authorized");

  // Generic teardown is not an assistant completion signal because the MCP
  // Apps SDK exposes resource teardown without a response-done reason.
  const genericScope = "conversation-atcc-generic-teardown";
  const generic = begin(genericScope);
  mount(generic, genericScope, "ui_atcc_generic");
  const genericTeardown = runtime.continuationTask({
    action: "host-signal",
    taskId: generic.task.id,
    coordinatorInstanceId: "ui_atcc_generic",
    hostProfileId: "chatgpt@atcc-generic",
    hostSignal: "teardown",
    elapsedMs: 5_000,
  });
  assert.equal(genericTeardown.accepted, true);
  assert.equal(genericTeardown.reason, "host-signal-recorded-no-turn-completion");
  assert.equal(genericTeardown.task.assistantTurnState, "GENERATING");
  assert.notEqual(genericTeardown.task.stallState, "CONTINUATION_ARMED");
  assert.equal(runtime.continuationTask({
    action: "claim-continuation",
    taskId: generic.task.id,
  }).accepted, false);

  // The model cannot sign a stage completion before it has actually performed
  // substantive work in the current manual turn.
  const normalScope = "conversation-atcc-normal-completion";
  const normal = begin(normalScope);
  mount(normal, normalScope, "ui_atcc_normal");
  const tooShort = runtime.continuationTask({
    action: "turn-complete",
    taskId: normal.task.id,
    note: "too-short-stage",
  });
  assert.equal(tooShort.accepted, false);
  assert.equal(tooShort.reason, "assistant-turn-substantive-work-required");
  assert.equal(tooShort.minimumSubstantiveWorkDelta, 1);

  work(normal, normalScope, 1);
  const requested = runtime.continuationTask({
    action: "turn-complete",
    taskId: normal.task.id,
    note: "normal-stage-ready-to-end",
  });
  assert.equal(requested.accepted, true);
  assert.equal(requested.task.assistantTurnState, "COMPLETION_REQUESTED");
  assert.equal(requested.task.assistantTurnCompletionLeaseId, requested.task.turnLeaseId);
  assert.equal(requested.finalResponseAllowed, true,
    "a signed normal stage may return its current assistant response while the overall task remains incomplete");
  assert.equal(runtime.continuationTask({
    action: "claim-continuation",
    taskId: normal.task.id,
  }).accepted, false, "model intent alone must never create a new Host turn");

  // Any later substantive tool activity proves that the same assistant turn is
  // still alive and automatically revokes the pending completion intent.
  const firstRequestedAt = Date.parse(requested.task.assistantTurnCompletionRequestedAt);
  const revoked = work(normal, normalScope, 1);
  assert.equal(revoked.task.assistantTurnState, "GENERATING");
  assert.equal(revoked.task.assistantTurnCompletionLeaseId, undefined);
  assert.equal(revoked.finalResponseAllowed, false);
  assert.equal(runtime.continuationSupervisorSweep({ nowMs: firstRequestedAt + 30_000 }).ready.length, 0,
    "a completion intent revoked by later substantive work must stay non-authorizing even after the old handoff deadline");

  const requestedAgain = runtime.continuationTask({
    action: "turn-complete",
    taskId: normal.task.id,
    note: "normal-stage-ready-after-more-work",
  });
  assert.equal(requestedAgain.accepted, true);
  const completed = runtime.continuationTask({
    action: "host-signal",
    taskId: normal.task.id,
    coordinatorInstanceId: "ui_atcc_normal",
    hostProfileId: "chatgpt@atcc-normal",
    hostSignal: "teardown",
    elapsedMs: 20_000,
  });
  assert.equal(completed.accepted, true);
  assert.equal(completed.reason, "assistant-turn-completion-confirmed");
  assert.equal(completed.task.assistantTurnState, "COMPLETED");
  assert.equal(completed.task.assistantTurnCompletionLeaseId, completed.task.turnLeaseId);
  assert.equal(completed.task.stallState, "CONTINUATION_ARMED");
  const normalClaim = runtime.continuationTask({
    action: "claim-continuation",
    taskId: normal.task.id,
  });
  assert.equal(normalClaim.accepted, true,
    "model completion intent plus matching Host teardown must authorize exactly one continuation");
  assert.equal(normalClaim.assistantTurnCompletion, "COMPLETED");

  // Real ChatGPT live validation showed that an ordinary assistant final does
  // not emit Apps resource teardown. The explicit model completion intent must
  // therefore become authoritative after a short handoff grace, but only for
  // that exact turn lease and only when no model-originated DevSpace request is
  // still in flight. GENERATING silence is tested separately above and never
  // reaches this path.
  const handoffScope = "v1/atcc-normal-handoff-no-teardown";
  const handoff = begin(handoffScope, "ws_atcc_normal_handoff_no_teardown");
  mount(handoff, handoffScope, "ui_atcc_handoff");
  work(handoff, handoffScope, 1);
  const handoffRequested = runtime.continuationTask({
    action: "turn-complete",
    taskId: handoff.task.id,
    note: "normal-final-without-host-teardown",
  });
  assert.equal(handoffRequested.accepted, true);
  assert.equal(handoffRequested.task.assistantTurnState, "COMPLETION_REQUESTED");
  const handoffRequestedAt = Date.parse(handoffRequested.task.assistantTurnCompletionRequestedAt);
  assert.equal(runtime.continuationSupervisorSweep({ nowMs: handoffRequestedAt + 7_000 }).ready.length, 0,
    "the explicit completion handoff must not create a continuation before its rendering grace matures");
  const releaseInFlight = runtime.beginContinuationModelRequest(handoffScope);
  assert.equal(runtime.continuationSupervisorSweep({ nowMs: handoffRequestedAt + 9_000 }).ready.length, 0,
    "even a mature explicit completion intent must fail closed while a model-originated DevSpace request is still in flight");
  assert.equal(runtime.continuationTask({ action: "status", taskId: handoff.task.id }).task.assistantTurnState,
    "COMPLETION_REQUESTED");
  releaseInFlight();
  const handoffReady = runtime.continuationSupervisorSweep({ nowMs: handoffRequestedAt + 9_001 });
  assert.equal(handoffReady.ready.length, 1,
    "a mature exact-turn completion intent must create one timely READY continuation even when normal Host teardown never arrives");
  const handoffCompleted = runtime.continuationTask({ action: "status", taskId: handoff.task.id });
  assert.equal(handoffCompleted.task.assistantTurnState, "COMPLETED");
  assert.equal(handoffCompleted.task.assistantTurnCompletionLeaseId, handoffCompleted.task.turnLeaseId);
  assert.equal(handoffCompleted.task.assistantTurnCompletionSource, "model-completion-handoff-grace");
  assert.equal(handoffCompleted.task.stallState, "CONTINUATION_ARMED");
  assert.equal(runtime.continuationSupervisorSweep({ nowMs: handoffRequestedAt + 20_000 }).ready.length, 0,
    "the handoff promotion must be idempotent and may create only one READY generation");

  // timeout/teardown are Host-owned evidence. A model call without the current
  // verified App coordinator cannot forge them.
  const timeoutScope = "conversation-atcc-timeout";
  const timeout = begin(timeoutScope);
  mount(timeout, timeoutScope, "ui_atcc_timeout");
  const forgedTimeout = runtime.continuationTask({
    action: "host-signal",
    taskId: timeout.task.id,
    hostProfileId: "chatgpt@atcc-timeout",
    hostSignal: "timeout",
    elapsedMs: 60_000,
  });
  assert.equal(forgedTimeout.accepted, false);
  assert.equal(forgedTimeout.reason, "verified-anchor-coordinator-required");
  const hostTimeout = runtime.continuationTask({
    action: "host-signal",
    taskId: timeout.task.id,
    coordinatorInstanceId: "ui_atcc_timeout",
    hostProfileId: "chatgpt@atcc-timeout",
    hostSignal: "timeout",
    elapsedMs: 60_000,
    note: "actual-host-budget-cutoff",
  });
  assert.equal(hostTimeout.accepted, true);
  assert.equal(hostTimeout.task.assistantTurnState, "TIMED_OUT");
  assert.equal(hostTimeout.task.stallState, "CONTINUATION_ARMED");
  assert.equal(runtime.continuationTask({
    action: "claim-continuation",
    taskId: timeout.task.id,
  }).accepted, true);

  // ChatGPT may render the continuation_anchor tool result without ever
  // instantiating the new milestone-card iframe. Keep that mount fact truthful:
  // a current hidden sender relay may report only an explicit Host timeout, and
  // only when its conversation/task/card/sender/exact-turn capability all match.
  // Generic teardown deliberately has no sender fallback.
  const senderTimeoutScope = "v1/atcc-sender-timeout-pending-anchor";
  const senderTimeout = begin(senderTimeoutScope);
  const senderTimeoutMount = runtime.prepareContinuationAnchorMount({
    taskId: senderTimeout.task.id,
    conversationScopeId: senderTimeoutScope,
  });
  assert.ok(senderTimeoutMount.anchorMountToken);
  assert.notEqual(senderTimeoutMount.anchorMountVerified, true,
    "a requested-but-unmounted card must not be reported as verified");
  const senderTimeoutBind = runtime.bindContinuationSender({
    claimedConversationScopeId: senderTimeoutScope,
    taskId: senderTimeout.task.id,
    senderInstanceId: "ui_atcc_sender_timeout",
    anchorMountGeneration: senderTimeoutMount.anchorMountGeneration,
  });
  assert.equal(senderTimeoutBind.accepted, true, JSON.stringify(senderTimeoutBind));
  const senderTimeoutBefore = runtime.continuationTask({ action: "status", taskId: senderTimeout.task.id });
  assert.equal(senderTimeoutBefore.task.anchorMountVerificationPending, true);
  assert.equal(senderTimeoutBefore.task.anchorMountVerifiedAt, undefined);
  const staleSenderTurn = runtime.recordContinuationSenderHostTimeout({
    conversationScopeId: senderTimeoutScope,
    taskId: senderTimeout.task.id,
    senderInstanceId: "ui_atcc_sender_timeout",
    anchorMountToken: senderTimeoutMount.anchorMountToken,
    anchorMountGeneration: senderTimeoutMount.anchorMountGeneration,
    turnLeaseId: "turn_stale_sender_timeout",
    hostProfileId: "chatgpt@atcc-sender-timeout",
    elapsedMs: 60_000,
  });
  assert.equal(staleSenderTurn.accepted, false);
  assert.equal(staleSenderTurn.reason, "stale-sender-turn-lease");
  const staleSenderGeneration = runtime.recordContinuationSenderHostTimeout({
    conversationScopeId: senderTimeoutScope,
    taskId: senderTimeout.task.id,
    senderInstanceId: "ui_atcc_sender_timeout",
    anchorMountToken: senderTimeoutMount.anchorMountToken,
    anchorMountGeneration: senderTimeoutMount.anchorMountGeneration + 1,
    turnLeaseId: senderTimeoutBefore.task.turnLeaseId,
    hostProfileId: "chatgpt@atcc-sender-timeout",
    elapsedMs: 60_000,
  });
  assert.equal(staleSenderGeneration.accepted, false);
  assert.equal(staleSenderGeneration.reason, "sender-mount-generation-mismatch");
  const staleSenderInstance = runtime.recordContinuationSenderHostTimeout({
    conversationScopeId: senderTimeoutScope,
    taskId: senderTimeout.task.id,
    senderInstanceId: "ui_atcc_sender_timeout_stale",
    anchorMountToken: senderTimeoutMount.anchorMountToken,
    anchorMountGeneration: senderTimeoutMount.anchorMountGeneration,
    turnLeaseId: senderTimeoutBefore.task.turnLeaseId,
    hostProfileId: "chatgpt@atcc-sender-timeout",
    elapsedMs: 60_000,
  });
  assert.equal(staleSenderInstance.accepted, false);
  assert.equal(staleSenderInstance.reason, "sender-instance-superseded");
  const pendingAnchorTeardown = runtime.continuationTask({
    action: "host-signal",
    taskId: senderTimeout.task.id,
    hostProfileId: "chatgpt@atcc-sender-timeout",
    hostSignal: "teardown",
    elapsedMs: 60_000,
    note: "relay-disposal-is-not-turn-end",
  });
  assert.equal(pendingAnchorTeardown.accepted, false);
  assert.equal(pendingAnchorTeardown.reason, "verified-anchor-coordinator-required");
  const senderHostTimeout = runtime.recordContinuationSenderHostTimeout({
    conversationScopeId: senderTimeoutScope,
    taskId: senderTimeout.task.id,
    senderInstanceId: "ui_atcc_sender_timeout",
    anchorMountToken: senderTimeoutMount.anchorMountToken,
    anchorMountGeneration: senderTimeoutMount.anchorMountGeneration,
    turnLeaseId: senderTimeoutBefore.task.turnLeaseId,
    hostProfileId: "chatgpt@atcc-sender-timeout",
    elapsedMs: 60_000,
    note: "actual-host-timeout-without-current-card-iframe",
  });
  assert.equal(senderHostTimeout.accepted, true);
  assert.equal(senderHostTimeout.task.assistantTurnState, "TIMED_OUT");
  assert.equal(senderHostTimeout.task.assistantTurnCompletionLeaseId, senderTimeoutBefore.task.turnLeaseId);
  assert.equal(senderHostTimeout.task.stallState, "CONTINUATION_ARMED");
  assert.equal(senderHostTimeout.task.anchorMountVerifiedAt, undefined,
    "sender timeout fallback must never fabricate visible-card mount verification");
  assert.equal(senderHostTimeout.task.anchorMountVerificationPending, true,
    "the card must remain honestly pending when ChatGPT never mounted its iframe");
  const senderTimeoutSamples = senderHostTimeout.task.hostTimeoutSamples;
  const duplicateSenderTimeout = runtime.recordContinuationSenderHostTimeout({
    conversationScopeId: senderTimeoutScope,
    taskId: senderTimeout.task.id,
    senderInstanceId: "ui_atcc_sender_timeout",
    anchorMountToken: senderTimeoutMount.anchorMountToken,
    anchorMountGeneration: senderTimeoutMount.anchorMountGeneration,
    turnLeaseId: senderTimeoutBefore.task.turnLeaseId,
    hostProfileId: "chatgpt@atcc-sender-timeout",
    elapsedMs: 60_000,
    note: "duplicate-host-timeout",
  });
  assert.equal(duplicateSenderTimeout.accepted, true);
  assert.equal(duplicateSenderTimeout.reason, "assistant-turn-timeout-already-confirmed");
  assert.equal(duplicateSenderTimeout.task.hostTimeoutSamples, senderTimeoutSamples,
    "duplicate timeout delivery must be idempotent and must not double-count Host calibration samples");

  // Synthetic resumed turns use a stricter substantive-work floor so a status
  // ACK plus a couple of trivial operations cannot immediately end the new
  // model turn. This specifically guards the short 20-60 second synthetic
  // loops observed in live ChatGPT runs.
  const syntheticScope = "conversation-atcc-synthetic-quality";
  const synthetic = begin(syntheticScope);
  runtime.database.sqlite.prepare(`
    update continuation_tasks set
      delivery_owner='synthetic-active',assistant_turn_owner='synthetic',
      delivery_work_baseline_count=coalesce(substantive_activity_count,0)
    where id=?
  `).run(synthetic.task.id);
  work(synthetic, syntheticScope, 1);
  const syntheticTooShort = runtime.continuationTask({
    action: "turn-complete",
    taskId: synthetic.task.id,
    note: "one-tool-short-loop",
  });
  assert.equal(syntheticTooShort.accepted, false);
  assert.equal(syntheticTooShort.minimumSubstantiveWorkDelta, 4);
  work(synthetic, syntheticScope, 2);
  const syntheticStillTooShort = runtime.continuationTask({
    action: "turn-complete",
    taskId: synthetic.task.id,
    note: "three-tool-short-loop",
  });
  assert.equal(syntheticStillTooShort.accepted, false);
  assert.equal(syntheticStillTooShort.substantiveWorkDelta, 3);
  assert.equal(syntheticStillTooShort.minimumSubstantiveWorkDelta, 4);
  work(synthetic, syntheticScope, 1);
  const syntheticTooEarly = runtime.continuationTask({
    action: "turn-complete",
    taskId: synthetic.task.id,
    note: "synthetic-stage-had-four-ops-but-host-budget-is-uncalibrated",
  });
  assert.equal(syntheticTooEarly.accepted, false);
  assert.equal(syntheticTooEarly.reason, "synthetic-host-budget-calibration-required");
  assert.equal(syntheticTooEarly.minimumActiveWorkMs, undefined,
    "an uncalibrated Host must not fall back to a hard-coded synthetic duration");
  assert.equal(syntheticTooEarly.retryAfterMs, undefined,
    "an uncalibrated Host must not manufacture a fixed wait before completion");
  runtime.database.sqlite.prepare("update continuation_tasks set turn_started_at=? where id=?")
    .run(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(), synthetic.task.id);
  const syntheticStillUncalibrated = runtime.continuationTask({
    action: "turn-complete",
    taskId: synthetic.task.id,
    note: "elapsed-time-alone-must-never-become-a-fixed-fallback",
  });
  assert.equal(syntheticStillUncalibrated.accepted, false);
  assert.equal(syntheticStillUncalibrated.reason, "synthetic-host-budget-calibration-required");

  // dev19: an Owner/manual seed is telemetry only. It must never become a
  // permanent synthetic turn cap because a later Host deployment may expose a
  // different window. Only verified timeout samples calibrate the gate.
  const seedScope = "conversation-atcc-synthetic-owner-seed";
  const seedSynthetic = begin(seedScope);
  mount(seedSynthetic, seedScope, "ui_atcc_synthetic_owner_seed");
  runtime.continuationTask({
    action: "confirm-turn-limit",
    taskId: seedSynthetic.task.id,
    elapsedMs: 420_000,
    note: "owner-telemetry-seed-only",
  });
  runtime.database.sqlite.prepare(`
    update continuation_tasks set
      delivery_owner='synthetic-active',assistant_turn_owner='synthetic',
      delivery_work_baseline_count=coalesce(substantive_activity_count,0)
    where id=?
  `).run(seedSynthetic.task.id);
  work(seedSynthetic, seedScope, 4);
  runtime.database.sqlite.prepare("update continuation_tasks set turn_started_at=? where id=?")
    .run(new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), seedSynthetic.task.id);
  const seedCannotAuthorizeBoundary = runtime.continuationTask({
    action: "turn-complete",
    taskId: seedSynthetic.task.id,
    note: "owner-seed-must-not-be-a-hard-coded-cap",
  });
  assert.equal(seedCannotAuthorizeBoundary.accepted, false);
  assert.equal(seedCannotAuthorizeBoundary.reason, "synthetic-host-budget-calibration-required");
  assert.equal(seedCannotAuthorizeBoundary.hostTimeoutSamples, 0);
  assert.equal(seedCannotAuthorizeBoundary.confirmedHostTurnLimitMs, 420_000,
    "the telemetry seed may be reported but must not authorize a boundary");

  // A verified timeout sample calibrates the current Host profile. The numbers
  // below are arbitrary fixtures: changing the sample changes the derived gate
  // without changing runtime source constants.
  const calibrationProfile = "chatgpt@atcc-adaptive-budget";
  const calibrationScope = "conversation-atcc-host-budget-calibration";
  const calibration = begin(calibrationScope);
  mount(calibration, calibrationScope, "ui_atcc_budget_calibration");
  const calibratedByTimeout = runtime.continuationTask({
    action: "host-signal",
    taskId: calibration.task.id,
    coordinatorInstanceId: "ui_atcc_budget_calibration",
    hostProfileId: calibrationProfile,
    hostSignal: "timeout",
    elapsedMs: 600_000,
    note: "verified-host-timeout-sample",
  });
  assert.equal(calibratedByTimeout.accepted, true);
  assert.equal(calibratedByTimeout.task.hostTimeoutSamples, 1);

  const budgetScope = "conversation-atcc-synthetic-host-budget";
  const budgetSynthetic = begin(budgetScope);
  mount(budgetSynthetic, budgetScope, "ui_atcc_synthetic_host_budget");
  const inheritedProfile = runtime.continuationTask({
    action: "host-signal",
    taskId: budgetSynthetic.task.id,
    hostProfileId: calibrationProfile,
    hostSignal: "connected",
    elapsedMs: 0,
    note: "inherit-live-host-profile",
  });
  assert.equal(inheritedProfile.accepted, true);
  assert.equal(inheritedProfile.task.hostTimeoutSamples, 1);
  runtime.database.sqlite.prepare(`
    update continuation_tasks set
      delivery_owner='synthetic-active',assistant_turn_owner='synthetic',
      delivery_work_baseline_count=coalesce(substantive_activity_count,0)
    where id=?
  `).run(budgetSynthetic.task.id);
  work(budgetSynthetic, budgetScope, 4);
  runtime.database.sqlite.prepare("update continuation_tasks set turn_started_at=? where id=?")
    .run(new Date(Date.now() - 120_000).toISOString(), budgetSynthetic.task.id);
  const budgetTooEarly = runtime.continuationTask({
    action: "turn-complete",
    taskId: budgetSynthetic.task.id,
    note: "live-calibrated-budget-not-yet-consumed",
  });
  assert.equal(budgetTooEarly.accepted, false);
  assert.equal(budgetTooEarly.reason, "synthetic-turn-min-active-work-required");
  assert.equal(budgetTooEarly.confirmedHostTurnLimitMs, 600_000);
  assert.equal(budgetTooEarly.hostTimeoutSamples, 1);
  assert.equal(budgetTooEarly.syntheticHostBudgetRatio, 0.95);
  assert.equal(budgetTooEarly.minimumActiveWorkMs, Math.floor(600_000 * 0.95));
  runtime.database.sqlite.prepare("update continuation_tasks set turn_started_at=? where id=?")
    .run(new Date(Date.now() - budgetTooEarly.minimumActiveWorkMs - 1_000).toISOString(), budgetSynthetic.task.id);
  const budgetReady = runtime.continuationTask({
    action: "turn-complete",
    taskId: budgetSynthetic.task.id,
    note: "synthetic-stage-consumed-manual-equivalent-budget",
  });
  assert.equal(budgetReady.accepted, true);
  assert.equal(budgetReady.task.assistantTurnState, "COMPLETION_REQUESTED");

  // The adaptive duration gate owns only a voluntary incomplete-stage boundary. A real
  // verified Host cutoff remains independently authoritative and must recover
  // even if it occurs before any profile calibration or learned work target.
  const budgetTimeoutScope = "conversation-atcc-synthetic-host-budget-timeout";
  const budgetTimeout = begin(budgetTimeoutScope);
  mount(budgetTimeout, budgetTimeoutScope, "ui_atcc_synthetic_budget_timeout");
  runtime.database.sqlite.prepare(`
    update continuation_tasks set delivery_owner='synthetic-active',assistant_turn_owner='synthetic'
    where id=?
  `).run(budgetTimeout.task.id);
  const earlyRealTimeout = runtime.continuationTask({
    action: "host-signal",
    taskId: budgetTimeout.task.id,
    coordinatorInstanceId: "ui_atcc_synthetic_budget_timeout",
    hostProfileId: "chatgpt@atcc-synthetic-budget-timeout",
    hostSignal: "timeout",
    elapsedMs: 60_000,
    note: "verified-host-cutoff-still-authoritative",
  });
  assert.equal(earlyRealTimeout.accepted, true);
  assert.equal(earlyRealTimeout.task.assistantTurnState, "TIMED_OUT",
    "a verified Host cutoff must bypass the voluntary synthetic duration gate");

  // An already-open ChatGPT Host can cache the pre-dev11 action enum even
  // after the MCP service has upgraded.  The exact reserved checkpoint note
  // is therefore a model-owned compatibility signature for turn-complete.
  // It must use the identical four-operation synthetic quality gate and Host
  // ownership restrictions; ordinary checkpoint notes remain checkpoints.
  const cachedSchemaScope = "v1/atcc-cached-schema";
  const cachedSchema = begin(cachedSchemaScope, "ws_atcc_cached_schema");
  runtime.database.sqlite.prepare(`
    update continuation_tasks set
      delivery_owner='synthetic-active',assistant_turn_owner='synthetic',
      delivery_work_baseline_count=coalesce(substantive_activity_count,0)
    where id=?
  `).run(cachedSchema.task.id);
  work(cachedSchema, cachedSchemaScope, 3);
  const cachedTooShort = runtime.continuationTask({
    action: "checkpoint",
    taskId: cachedSchema.task.id,
    note: "atcc-turn-complete",
  });
  assert.equal(cachedTooShort.accepted, false);
  assert.equal(cachedTooShort.reason, "assistant-turn-substantive-work-required");
  assert.equal(cachedTooShort.substantiveWorkDelta, 3);
  assert.equal(cachedTooShort.minimumSubstantiveWorkDelta, 4);
  work(cachedSchema, cachedSchemaScope, 1);
  const cachedHostForgery = runtime.continuationTask({
    action: "checkpoint",
    taskId: cachedSchema.task.id,
    note: "atcc-turn-complete",
    coordinatorInstanceId: "ui_must_not_sign_model_completion",
  });
  assert.equal(cachedHostForgery.accepted, false);
  assert.equal(cachedHostForgery.reason, "turn-complete-model-only");
  // Cached-schema compatibility uses the same adaptive gate. Seed this row as
  // if the Host profile had already observed one verified timeout; this is a
  // test fixture, not a product duration constant.
  const cachedHostSampleMs = 300_000;
  runtime.database.sqlite.prepare(`
    update continuation_tasks set
      host_timeout_samples=1,
      confirmed_turn_limit_ms=?,
      confirmed_turn_limit_source='host-timeout-initial-regime',
      cutoff_samples_json=?,cutoff_epoch=0
    where id=?
  `).run(cachedHostSampleMs, JSON.stringify([cachedHostSampleMs]), cachedSchema.task.id);
  const cachedTooEarly = runtime.continuationTask({
    action: "checkpoint",
    taskId: cachedSchema.task.id,
    note: "atcc-turn-complete",
  });
  assert.equal(cachedTooEarly.accepted, false);
  assert.equal(cachedTooEarly.reason, "synthetic-turn-min-active-work-required");
  assert.equal(cachedTooEarly.minimumActiveWorkMs, Math.floor(cachedHostSampleMs * 0.95));
  runtime.database.sqlite.prepare("update continuation_tasks set turn_started_at=? where id=?")
    .run(new Date(Date.now() - cachedTooEarly.minimumActiveWorkMs - 1_000).toISOString(), cachedSchema.task.id);
  const cachedRequested = runtime.continuationTask({
    action: "checkpoint",
    taskId: cachedSchema.task.id,
    note: "atcc-turn-complete",
  });
  assert.equal(cachedRequested.accepted, true);
  assert.equal(cachedRequested.reason, "assistant-turn-completion-requested-via-checkpoint-compat");
  assert.equal(cachedRequested.task.assistantTurnState, "COMPLETION_REQUESTED");
  assert.equal(cachedRequested.finalResponseAllowed, true);
  const cachedRequestedAt = Date.parse(cachedRequested.task.assistantTurnCompletionRequestedAt);
  assert.equal(runtime.continuationSupervisorSweep({ nowMs: cachedRequestedAt + 7_000 }).ready.length, 0,
    "cached-schema completion compatibility must use the same bounded handoff grace");
  const cachedReady = runtime.continuationSupervisorSweep({ nowMs: cachedRequestedAt + 9_000 });
  assert.equal(cachedReady.ready.length, 1,
    "cached-schema checkpoint completion must recover a normal final without requiring Host teardown");
  const cachedCompleted = runtime.continuationTask({ action: "status", taskId: cachedSchema.task.id });
  assert.equal(cachedCompleted.task.assistantTurnState, "COMPLETED");
  assert.equal(cachedCompleted.task.assistantTurnCompletionSource, "model-completion-handoff-grace");

  const ordinaryCheckpointScope = "conversation-atcc-ordinary-checkpoint";
  const ordinaryCheckpoint = begin(ordinaryCheckpointScope);
  work(ordinaryCheckpoint, ordinaryCheckpointScope, 1);
  const ordinaryCheckpointResult = runtime.continuationTask({
    action: "checkpoint",
    taskId: ordinaryCheckpoint.task.id,
    note: "atcc-turn-complete-not-exact",
  });
  assert.equal(ordinaryCheckpointResult.accepted, true);
  assert.equal(ordinaryCheckpointResult.task.assistantTurnState, "GENERATING");
  assert.notEqual(ordinaryCheckpointResult.reason, "assistant-turn-completion-requested-via-checkpoint-compat");

  // Expiring the synthetic ownership lease is only stale-ownership telemetry.
  // It must never manufacture a replacement turn while ATCC still says the
  // current assistant turn is GENERATING.
  runtime.database.sqlite.prepare(`
    update continuation_tasks set delivery_owner='synthetic-active',
      delivery_owner_expires_at=?,assistant_turn_state='GENERATING',
      assistant_turn_completion_lease_id=null,stall_state='ACTIVE'
    where id=?
  `).run(new Date(Date.now() - 60_000).toISOString(), synthetic.task.id);
  const expiredOwnerClaim = runtime.continuationTask({
    action: "claim-continuation",
    taskId: synthetic.task.id,
    note: "synthetic resume work ownership lease expired",
  });
  assert.equal(expiredOwnerClaim.accepted, false);
  assert.equal(expiredOwnerClaim.reason, "continuation-trigger-not-authorized");

  // A new manual turn creates a new lease and invalidates stale completion
  // intent from the previous assistant turn before any side effect is allowed.
  const takeoverScope = "conversation-atcc-manual-takeover";
  const takeover = begin(takeoverScope);
  mount(takeover, takeoverScope, "ui_atcc_takeover");
  work(takeover, takeoverScope, 1);
  const takeoverIntent = runtime.continuationTask({
    action: "turn-complete",
    taskId: takeover.task.id,
    note: "old-turn-stage-ready",
  });
  const oldLease = takeoverIntent.task.turnLeaseId;
  const manualTakeover = runtime.continuationTask({
    action: "status",
    taskId: takeover.task.id,
    manualTakeover: true,
  });
  assert.equal(manualTakeover.accepted, true);
  assert.equal(manualTakeover.task.assistantTurnOwner, "manual",
    "manual takeover must replace any persisted synthetic assistant-turn owner, not only delivery ownership");
  const takeoverStatus = runtime.continuationTask({ action: "status", taskId: takeover.task.id });
  assert.equal(takeoverStatus.task.assistantTurnState, "GENERATING");
  assert.equal(takeoverStatus.task.assistantTurnOwner, "manual");
  assert.notEqual(takeoverStatus.task.turnLeaseId, oldLease);
  assert.equal(takeoverStatus.task.assistantTurnCompletionLeaseId, undefined);
  const staleTeardown = runtime.continuationTask({
    action: "host-signal",
    taskId: takeover.task.id,
    coordinatorInstanceId: "ui_atcc_takeover",
    hostProfileId: "chatgpt@atcc-takeover",
    hostSignal: "teardown",
    elapsedMs: 1_000,
  });
  assert.equal(staleTeardown.task.assistantTurnState, "GENERATING");
  assert.equal(runtime.continuationTask({
    action: "claim-continuation",
    taskId: takeover.task.id,
  }).accepted, false);

  // dev12 manual priority contract: the first status of a real user message
  // may carry a completely different milestone plan.  The runtime must replace
  // the active plan before rotating that message's one fresh card, rather than
  // rendering the old plan and requiring a second begin/revision card.
  const manualPlanScope = "v1/atcc-dev12-manual-plan";
  const manualPlan = begin(manualPlanScope, "ws_atcc_dev12_manual_plan");
  mount(manualPlan, manualPlanScope, "ui_atcc_dev12_manual_plan_initial");
  const beforeManualPlan = runtime.continuationArchitectureSnapshot(manualPlanScope);
  const beforeManualWorksetId = beforeManualPlan.card.active_workset_id;
  const beforeManualGeneration = manualPlan.task.anchorMountGeneration;
  const plannedManualTurn = runtime.continuationTask({
    action: "status",
    taskId: manualPlan.task.id,
    manualTakeover: true,
    objective: "new highest-priority manual user task",
    requiredMilestones: ["manual-new-a", "manual-new-b"],
  });
  assert.equal(plannedManualTurn.accepted, true);
  assert.equal(plannedManualTurn.manualMilestoneSetChanged, true);
  assert.equal(plannedManualTurn.manualRoundCardRequired, true);
  assert.equal(plannedManualTurn.milestoneCardRequired, true);
  assert.equal(plannedManualTurn.task.objective, "new highest-priority manual user task");
  assert.deepEqual(plannedManualTurn.task.requiredMilestones, ["manual-new-a", "manual-new-b"]);
  assert.ok(plannedManualTurn.task.anchorMountGeneration > beforeManualGeneration,
    "every manual DevSpace user turn must rotate one fresh visible card generation");
  const afterManualPlan = runtime.continuationArchitectureSnapshot(manualPlanScope);
  assert.notEqual(afterManualPlan.card.active_workset_id, beforeManualWorksetId,
    "a materially different manual milestone plan must atomically switch active worksets");
  assert.equal(afterManualPlan.worksets.find((entry) => entry.id === beforeManualWorksetId)?.state, "SUPERSEDED");
  const activeManualMilestones = afterManualPlan.milestones
    .filter((entry) => entry.workset_id === afterManualPlan.card.active_workset_id)
    .map((entry) => entry.description);
  assert.deepEqual(activeManualMilestones, ["manual-new-a", "manual-new-b"]);
  mount(plannedManualTurn, manualPlanScope, "ui_atcc_dev12_manual_plan_second");
  const samePlanNextManualTurn = runtime.continuationTask({
    action: "status",
    taskId: manualPlan.task.id,
    manualTakeover: true,
    requiredMilestones: ["manual-new-a", "manual-new-b"],
  });
  assert.equal(samePlanNextManualTurn.accepted, true);
  assert.equal(samePlanNextManualTurn.manualMilestoneSetChanged, undefined,
    "same manual plan should still get a new manual-turn card without manufacturing a new workset");
  assert.equal(samePlanNextManualTurn.manualRoundCardRequired, true);
  assert.ok(samePlanNextManualTurn.task.anchorMountGeneration > plannedManualTurn.task.anchorMountGeneration);
  assert.equal(runtime.continuationArchitectureSnapshot(manualPlanScope).card.active_workset_id,
    afterManualPlan.card.active_workset_id);

  // dev14: continuation_anchor is the authoritative visible plan for a new
  // manual round. Its internal begin must replace the active milestone set,
  // not append it to the lifetime task history. Historical worksets/evidence
  // remain available for lineage, but must never leak back into the current
  // card or remainingMilestones projection.
  const anchorReplaceScope = "v1/atcc-dev14-anchor-plan-replace";
  const anchorReplace = runtime.continuationTask({
    action: "begin",
    conversationScopeId: anchorReplaceScope,
    workspaceId: "ws_atcc_dev14_anchor_plan_replace",
    objective: "old manual plan",
    requiredMilestones: ["old-a", "old-b"],
    evidence: { historicalProof: "keep-me" },
  });
  mount(anchorReplace, anchorReplaceScope, "ui_atcc_dev14_anchor_old");
  const oldAnchorSnapshot = runtime.continuationArchitectureSnapshot(anchorReplaceScope);
  const oldAnchorWorksetId = oldAnchorSnapshot.card.active_workset_id;
  const replacedAnchorPlan = runtime.continuationTask({
    action: "begin",
    taskId: anchorReplace.task.id,
    conversationScopeId: anchorReplaceScope,
    workspaceId: "ws_atcc_dev14_anchor_plan_replace",
    objective: "new manual plan",
    requiredMilestones: ["dev14-a", "dev14-b"],
    sourceTool: "continuation_anchor",
    replaceActiveMilestones: true,
  });
  assert.deepEqual(replacedAnchorPlan.task.requiredMilestones, ["dev14-a", "dev14-b"],
    "continuation_anchor must replace, not union, the active manual milestone plan");
  assert.deepEqual(replacedAnchorPlan.remainingMilestones, ["dev14-a", "dev14-b"]);
  const replacedAnchorSnapshot = runtime.continuationArchitectureSnapshot(anchorReplaceScope);
  assert.notEqual(replacedAnchorSnapshot.card.active_workset_id, oldAnchorWorksetId,
    "a changed continuation_anchor plan must switch to one fresh active workset");
  assert.equal(replacedAnchorSnapshot.worksets.find((entry) => entry.id === oldAnchorWorksetId)?.state, "SUPERSEDED",
    "the prior manual plan remains historical lineage only");
  assert.deepEqual(
    replacedAnchorSnapshot.milestones
      .filter((entry) => entry.workset_id === replacedAnchorSnapshot.card.active_workset_id)
      .map((entry) => entry.description),
    ["dev14-a", "dev14-b"],
  );
  const recoveredAnchorPlan = runtime.prepareContinuationAnchorMount({
    taskId: anchorReplace.task.id,
    conversationScopeId: anchorReplaceScope,
  });
  assert.deepEqual(recoveredAnchorPlan.task.requiredMilestones, ["dev14-a", "dev14-b"],
    "canonical projection recovery must not resurrect superseded historical milestones");
  assert.equal(recoveredAnchorPlan.task.evidence?.historicalProof, "keep-me",
    "active-plan replacement must preserve lifetime evidence");

  // Manual input is the highest-priority owner at every pre-/post-delivery
  // automatic state.  Seed the persisted generation states directly so this
  // regression covers the CAS boundary independently of App timing.
  for (const [generationState, deliveryOwner] of [
    ["READY", null],
    ["CLAIMED", "synthetic-pending"],
    ["DELIVERING", "synthetic-pending"],
    ["WORK_REQUIRED", "synthetic-active"],
  ]) {
    const priorityScope = `v1/atcc-dev12-manual-priority-${generationState.toLowerCase()}`;
    const priority = begin(priorityScope, `ws_atcc_priority_${generationState.toLowerCase()}`);
    mount(priority, priorityScope, `ui_atcc_priority_${generationState.toLowerCase()}`);
    const architecture = runtime.continuationArchitectureSnapshot(priorityScope);
    const generation = architecture.generations.at(-1);
    assert.ok(generation, `missing generation fixture for ${generationState}`);
    const deliveryToken = `dev12-${generationState.toLowerCase()}-token`;
    runtime.database.sqlite.prepare(`
      update continuation_generations set owner_type='synthetic',state=?,delivery_token=?,updated_at=? where id=?
    `).run(generationState, deliveryToken, new Date().toISOString(), generation.id);
    runtime.database.sqlite.prepare(`
      update continuation_tasks set delivery_owner=?,delivery_token=?,assistant_turn_owner='synthetic',
        delivery_owner_expires_at=?,continuation_pending=? where id=?
    `).run(deliveryOwner, deliveryOwner ? deliveryToken : null,
      new Date(Date.now() + 30 * 60_000).toISOString(), deliveryOwner === "synthetic-pending" ? 5 : 0,
      priority.task.id);
    const manualWins = runtime.continuationTask({
      action: "status",
      taskId: priority.task.id,
      manualTakeover: true,
      objective: `manual priority over ${generationState}`,
      requiredMilestones: [`manual-after-${generationState.toLowerCase()}`],
    });
    assert.equal(manualWins.accepted, true, `manual takeover must win over ${generationState}`);
    assert.equal(manualWins.task.assistantTurnOwner, "manual");
    assert.equal(manualWins.task.deliveryOwner, "manual");
    assert.equal(manualWins.task.deliveryToken, undefined);
    assert.equal(manualWins.manualRoundCardRequired, true);
    assert.equal(manualWins.milestoneCardRequired, true);
    assert.equal(runtime.database.sqlite.prepare(
      "select state from continuation_generations where id=?",
    ).get(generation.id).state, "SUPERSEDED",
    `manual takeover must supersede the ${generationState} automatic generation`);
  }

  // Strict timeout-recovery remains a supported compatibility mode, but its
  // only automatic turn-end authority is a verified Host timeout. Normal
  // teardown and model turn-complete intent must not broaden that contract.
  const strictScope = "conversation-atcc-timeout-recovery";
  const strict = runtime.continuationTask({
    action: "begin",
    conversationScopeId: strictScope,
    workspaceId: "ws_atcc_timeout_recovery",
    continuationMode: "timeout-recovery",
    objective: "strict timeout recovery",
    requiredMilestones: ["finish"],
  });
  assert.equal(strict.task.continuationMode, "timeout-recovery");
  mount(strict, strictScope, "ui_atcc_timeout_recovery");
  const strictTurnComplete = runtime.continuationTask({
    action: "turn-complete",
    taskId: strict.task.id,
    note: "normal-completion-not-valid-for-strict-timeout-mode",
  });
  assert.equal(strictTurnComplete.accepted, false);
  assert.equal(strictTurnComplete.reason, "completion-driven-mode-required");
  const strictTeardown = runtime.continuationTask({
    action: "host-signal",
    taskId: strict.task.id,
    coordinatorInstanceId: "ui_atcc_timeout_recovery",
    hostProfileId: "chatgpt@atcc-timeout-recovery",
    hostSignal: "teardown",
    elapsedMs: 5_000,
  });
  assert.equal(strictTeardown.accepted, true);
  assert.notEqual(strictTeardown.task.assistantTurnState, "TIMED_OUT");
  assert.equal(runtime.continuationTask({
    action: "claim-continuation",
    taskId: strict.task.id,
  }).accepted, false, "strict timeout-recovery teardown must remain fail-closed");
  const forgedStrictTimeout = runtime.continuationTask({
    action: "host-signal",
    taskId: strict.task.id,
    coordinatorInstanceId: "ui_not_the_verified_anchor",
    hostProfileId: "chatgpt@atcc-timeout-recovery",
    hostSignal: "timeout",
    elapsedMs: 60_000,
  });
  assert.equal(forgedStrictTimeout.accepted, false);
  assert.ok(["verified-anchor-coordinator-required", "stale-anchor-coordinator"].includes(forgedStrictTimeout.reason),
    "a timeout from any coordinator other than the currently verified anchor must fail closed");
  const strictTimeout = runtime.continuationTask({
    action: "host-signal",
    taskId: strict.task.id,
    coordinatorInstanceId: "ui_atcc_timeout_recovery",
    hostProfileId: "chatgpt@atcc-timeout-recovery",
    hostSignal: "timeout",
    elapsedMs: 60_000,
  });
  assert.equal(strictTimeout.accepted, true);
  assert.equal(strictTimeout.task.assistantTurnState, "TIMED_OUT");
  assert.equal(strictTimeout.task.assistantTurnCompletionLeaseId, strictTimeout.task.turnLeaseId);
  assert.equal(strictTimeout.task.stallState, "CONTINUATION_ARMED");
  const strictClaim = runtime.continuationTask({
    action: "claim-continuation",
    taskId: strict.task.id,
  });
  assert.equal(strictClaim.accepted, true);
  assert.equal(strictClaim.assistantTurnCompletion, "TIMED_OUT");

  console.log(JSON.stringify({
    ok: true,
    schemaVersion: migration.version,
    longThinkDoesNotContinue: true,
    genericTeardownDoesNotContinue: true,
    normalCompletionUsesExplicitIntentWithHostTeardownFastPathOrGuardedHandoffGrace: true,
    normalCompletionWithoutHostTeardownContinuesAfterGuardedHandoff: true,
    handoffBlocksWhileModelRequestInFlight: true,
    laterSubstantiveWorkRevokesIntent: true,
    explicitHostTimeoutContinues: true,
    pendingAnchorSenderTimeoutFallback: true,
    senderTimeoutRequiresExactTurnLease: true,
    senderTimeoutKeepsMountVerificationTruthful: true,
    senderTimeoutIsIdempotent: true,
    genericTeardownHasNoSenderFallback: true,
    syntheticMinimumSubstantiveWorkDelta: 4,
    syntheticVoluntaryBoundaryTracksConfirmedHostBudget: true,
    verifiedHostTimeoutBypassesSyntheticVoluntaryDurationGate: true,
    cachedSchemaCheckpointCompletionCompatibility: true,
    syntheticOwnerLeaseExpiryDoesNotContinue: true,
    manualTakeoverInvalidatesOldTurnIntent: true,
    continuationAnchorReplacesActiveManualPlanWithoutLosingHistory: true,
    strictTimeoutRecoveryRequiresVerifiedHostTimeout: true,
  }, null, 2));
} finally {
  runtime.close?.();
  rmSync(stateDir, { recursive: true, force: true });
}
