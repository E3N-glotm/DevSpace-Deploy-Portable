import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
const serverSource = readFileSync(join(ROOT, "vendor", "waishnav-devspace", "dist", "server.js"), "utf8");
const TEST_SENDER_PROTOCOL_EPOCH = Number(serverSource.match(/const CONTINUATION_SENDER_PROTOCOL_EPOCH = (\d+);/)?.[1]);
const TEST_SENDER_ASSET_REVISION = "0123456789abcdef";
assert.ok(Number.isInteger(TEST_SENDER_PROTOCOL_EPOCH) && TEST_SENDER_PROTOCOL_EPOCH > 0,
  "ATCC regression must use the server's current sender protocol epoch");

const { StructuredRuntimeState } = await import(
  `${pathToFileURL(runtimeStatePath).href}?atcc=${Date.now()}`
);

const stateDir = mkdtempSync(join(tmpdir(), "devspace-atcc-test-"));
const runtime = new StructuredRuntimeState(stateDir);
runtime.configureContinuationSenderTransport({
  protocolEpoch: TEST_SENDER_PROTOCOL_EPOCH,
  assetRevision: TEST_SENDER_ASSET_REVISION,
});

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
  const senderBound = runtime.bindContinuationSender({
    conversationScopeId: scope,
    taskId: outcome.task.id,
    senderInstanceId: coordinator,
    anchorMountGeneration: requested.anchorMountGeneration,
  });
  assert.equal(senderBound.accepted, true,
    "a verified positive-path ATCC fixture must also model the current-process Workspace App sender required to deliver a future synthetic turn");
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

function readyForScope(sweep, scope) {
  return (sweep?.ready ?? []).filter((item) => item.conversationScopeId === scope);
}

try {
  const migration = runtime.database.sqlite
    .prepare("select max(version) as version from devspace_schema_migrations")
    .get();
  assert.equal(migration.version, 35,
    "ATCC, sender-lease state, and the dev75 resume execution capsule must reach schema migration 35");
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
  const longThinkScope = "v1/atcc-long-think";
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

  // A single learned cutoff observation is still telemetry only. It must not
  // manufacture a continuation just because the turn is old and quiet.
  const singleCutoffScope = "v1/atcc-single-cutoff-telemetry";
  const singleCutoff = begin(singleCutoffScope);
  mount(singleCutoff, singleCutoffScope, "ui_atcc_single_cutoff");
  runtime.continuationTask({
    action: "confirm-turn-limit", taskId: singleCutoff.task.id,
    elapsedMs: 30_000, note: "single-owner-observation",
  });
  const singleOld = new Date(Date.now() - 90_000).toISOString();
  runtime.database.sqlite.prepare(`
    update continuation_tasks set turn_started_at=?,turn_lease_expires_at=? where id=?
  `).run(singleOld, singleOld, singleCutoff.task.id);
  runtime.database.sqlite.prepare(`
    update continuation_worksets set continuation_due_at=? where legacy_task_id=?
  `).run(singleOld, singleCutoff.task.id);
  const singleSweep = runtime.continuationSupervisorSweep({ nowMs: Date.now() });
  assert.equal(readyForScope(singleSweep, singleCutoffScope).length, 0,
    "one cutoff observation must remain non-authorizing telemetry");
  assert.equal(runtime.continuationTask({ action: "status", taskId: singleCutoff.task.id }).task.assistantTurnState,
    "GENERATING");

  // Even clustered historical cutoffs cannot prove that the current model
  // stopped. They remain telemetry when the Host window length changes.
  const learnedCutoffScope = "v1/atcc-learned-hard-cutoff";
  const learnedCutoff = begin(learnedCutoffScope);
  mount(learnedCutoff, learnedCutoffScope, "ui_atcc_learned_cutoff");
  runtime.continuationTask({
    action: "confirm-turn-limit", taskId: learnedCutoff.task.id,
    elapsedMs: 30_000, note: "owner-observation-1",
  });
  runtime.continuationTask({
    action: "confirm-turn-limit", taskId: learnedCutoff.task.id,
    elapsedMs: 30_100, note: "owner-observation-2",
  });
  const learnedStatus = runtime.continuationTask({ action: "status", taskId: learnedCutoff.task.id });
  assert.deepEqual(learnedStatus.task.cutoffSamples, [30_000, 30_100]);
  const learnedStartedAt = Date.now() - 31_500;
  runtime.database.sqlite.prepare(`
    update continuation_tasks set turn_started_at=?,turn_lease_expires_at=? where id=?
  `).run(new Date(learnedStartedAt).toISOString(), new Date(learnedStartedAt).toISOString(), learnedCutoff.task.id);
  runtime.database.sqlite.prepare(`
    update continuation_worksets set continuation_due_at=? where legacy_task_id=?
  `).run(new Date(learnedStartedAt).toISOString(), learnedCutoff.task.id);
  const beforeLearnedDeadline = runtime.continuationSupervisorSweep({ nowMs: learnedStartedAt + 30_500 });
  assert.equal(readyForScope(beforeLearnedDeadline, learnedCutoffScope).length, 0,
    "learned cutoff fallback must preserve its adaptive safety margin");
  const afterLearnedDeadline = runtime.continuationSupervisorSweep({ nowMs: learnedStartedAt + 31_000 });
  assert.equal(readyForScope(afterLearnedDeadline, learnedCutoffScope).length, 0,
    "historical samples must not replace a currently silent model turn");
  const inferredTimedOut = runtime.continuationTask({ action: "status", taskId: learnedCutoff.task.id });
  assert.equal(inferredTimedOut.task.assistantTurnState, "GENERATING");
  assert.equal(inferredTimedOut.task.assistantTurnCompletionSource, undefined);
  assert.notEqual(inferredTimedOut.task.stallState, "CONTINUATION_ARMED");
  assert.equal(readyForScope(
    runtime.continuationSupervisorSweep({ nowMs: learnedStartedAt + 32_000 }), learnedCutoffScope,
  ).length, 0, "repeated watchdog sweeps must not mint a duplicate READY generation");

  // Repeating the exact same owner observation cannot manufacture two-sample
  // confidence, including when migrating a pre-dev67 confirmed limit that had
  // no sample window yet.
  const duplicateCutoffScope = "v1/atcc-duplicate-cutoff-sample";
  const duplicateCutoff = begin(duplicateCutoffScope);
  mount(duplicateCutoff, duplicateCutoffScope, "ui_atcc_duplicate_cutoff");
  runtime.database.sqlite.prepare(`
    update continuation_tasks set confirmed_turn_limit_ms=?,cutoff_samples_json='[]' where id=?
  `).run(30_000, duplicateCutoff.task.id);
  runtime.continuationTask({
    action: "confirm-turn-limit", taskId: duplicateCutoff.task.id,
    elapsedMs: 30_000, note: "same-observation-retry",
  });
  const duplicateStatus = runtime.continuationTask({ action: "status", taskId: duplicateCutoff.task.id });
  assert.deepEqual(duplicateStatus.task.cutoffSamples, [30_000]);

  // Conversely, a distinct same-regime observation must migrate the one
  // pre-dev67 confirmed cutoff into the sample window so already-observed live
  // evidence can participate in the new conservative fallback.
  const migratedCutoffScope = "v1/atcc-migrated-cutoff-sample";
  const migratedCutoff = begin(migratedCutoffScope);
  mount(migratedCutoff, migratedCutoffScope, "ui_atcc_migrated_cutoff");
  runtime.database.sqlite.prepare(`
    update continuation_tasks set confirmed_turn_limit_ms=?,cutoff_samples_json='[]' where id=?
  `).run(30_000, migratedCutoff.task.id);
  runtime.continuationTask({
    action: "confirm-turn-limit", taskId: migratedCutoff.task.id,
    elapsedMs: 30_100, note: "distinct-new-observation",
  });
  assert.deepEqual(
    runtime.continuationTask({ action: "status", taskId: migratedCutoff.task.id }).task.cutoffSamples,
    [30_000, 30_100],
  );

  // If a real model-originated substantive operation survives beyond the
  // learned fallback deadline, the Host regime has lengthened. The stale
  // cutoff authority must invalidate immediately rather than interrupting the
  // now-longer live turn.
  const survivalScope = "v1/atcc-cutoff-survival-invalidation";
  const survival = begin(survivalScope);
  mount(survival, survivalScope, "ui_atcc_cutoff_survival");
  runtime.continuationTask({ action: "confirm-turn-limit", taskId: survival.task.id, elapsedMs: 30_000 });
  runtime.continuationTask({ action: "confirm-turn-limit", taskId: survival.task.id, elapsedMs: 30_100 });
  runtime.database.sqlite.prepare("update continuation_tasks set turn_started_at=? where id=?")
    .run(new Date(Date.now() - 40_000).toISOString(), survival.task.id);
  runtime.touchContinuationModelActivity({
    workspaceId: survival.task.workspaceId,
    conversationScopeId: survivalScope,
    substantive: true,
  });
  const survivalStatus = runtime.continuationTask({ action: "status", taskId: survival.task.id });
  assert.deepEqual(survivalStatus.task.cutoffSamples, []);
  assert.equal(survivalStatus.task.confirmedTurnLimitMs, undefined);
  assert.equal(survivalStatus.task.confirmedTurnLimitSource, "invalidated-by-live-turn-survival");
  assert.equal(survivalStatus.task.assistantTurnState, "GENERATING");


  // Exercise the inferred-cutoff gate against the conditions that can still
  // be live when the original MCP request has returned.
  for (const scenario of ["unstable", "inflight", "process", "manual", "profile", "synthetic"]) {
    const scope = `v1/atcc-learned-guard-${scenario}`;
    const fixture = begin(scope);
    mount(fixture, scope, `ui_atcc_learned_guard_${scenario}`);
    runtime.continuationTask({ action: "confirm-turn-limit", taskId: fixture.task.id, elapsedMs: 30_000 });
    runtime.continuationTask({
      action: "confirm-turn-limit", taskId: fixture.task.id,
      elapsedMs: scenario === "unstable" ? 34_000 : 30_100,
    });
    const old = new Date(Date.now() - 60_000).toISOString();
    runtime.database.sqlite.prepare(
      "update continuation_tasks set turn_started_at=?,turn_lease_expires_at=? where id=?",
    ).run(old, old, fixture.task.id);
    runtime.database.sqlite.prepare(
      "update continuation_worksets set continuation_due_at=? where legacy_task_id=?",
    ).run(old, fixture.task.id);
    let releaseRequest;
    if (scenario === "inflight") releaseRequest = runtime.beginContinuationModelRequest(scope);
    if (scenario === "process") runtime.database.sqlite.prepare(
      "update continuation_tasks set watch_process_handles_json='[\"active-build\"]' where id=?",
    ).run(fixture.task.id);
    if (scenario === "manual") {
      const newTurn = runtime.continuationTask({ action: "status", taskId: fixture.task.id, manualTakeover: true });
      assert.notEqual(newTurn.task.turnLeaseId, fixture.task.turnLeaseId);
    }
    if (scenario === "profile") {
      runtime.continuationTask({
        action: "host-signal", taskId: fixture.task.id,
        coordinatorInstanceId: "ui_atcc_learned_guard_profile",
        hostProfileId: "chatgpt@atcc-revoked-profile", hostSignal: "connected",
      });
      runtime.database.sqlite.prepare(
        "update continuation_host_profiles set cutoff_epoch=cutoff_epoch+1,cutoff_samples_json='[]' where id=?",
      ).run("chatgpt@atcc-revoked-profile");
    }
    if (scenario === "synthetic") {
      const snapshot = runtime.continuationArchitectureSnapshot(scope);
      const generation = snapshot.generations.at(-1);
      runtime.database.sqlite.prepare(`
        update continuation_generations set owner_type='synthetic',state='WORK_REQUIRED',
          due_at=?,substantive_baseline_count=0,substantive_activity_count=4 where id=?
      `).run(old, generation.id);
      runtime.database.sqlite.prepare(`
        update continuation_tasks set delivery_owner='synthetic-active',assistant_turn_owner='synthetic',
          delivery_owner_expires_at=?,substantive_activity_count=4 where id=?
      `).run(new Date(Date.now() + 180_000).toISOString(), fixture.task.id);
    }
    const sweep = runtime.continuationSupervisorSweep({ nowMs: Date.now() });
    releaseRequest?.();
    assert.equal(readyForScope(sweep, scope).length, 0,
      `learned-cutoff ${scenario} gate`);
    const after = runtime.continuationTask({ action: "status", taskId: fixture.task.id });
    assert.equal(after.task.assistantTurnState, "GENERATING");
    if (scenario === "synthetic") {
      assert.equal(readyForScope(runtime.continuationSupervisorSweep({ nowMs: Date.now() }), scope).length, 0);
    }
  }
  // Generic teardown is not an assistant completion signal because the MCP
  // Apps SDK exposes resource teardown without a response-done reason.
  const genericScope = "v1/atcc-generic-teardown";
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
  const normalScope = "v1/atcc-normal-completion";
  const normal = begin(normalScope);
  mount(normal, normalScope, "ui_atcc_normal");
  const normalStatus = runtime.continuationTask({
    action: "status",
    taskId: normal.task.id,
  });
  assert.equal(normalStatus.preFinalControlRequired, true,
    "an incomplete RUNNING turn must explicitly advertise its required pre-final control action");
  assert.match(normalStatus.requiredBeforeFinal, /turn-complete/,
    "the pre-final directive must tell the model how to sign an intentional stage boundary");
  assert.match(normalStatus.requiredBeforeFinal, /waitingExternal=true/,
    "the pre-final directive must distinguish a genuine external wait from a normal stage boundary");
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
  assert.equal(requested.preFinalControlRequired, false,
    "a valid turn-complete lease must satisfy the pre-final control requirement");
  assert.equal(requested.task.assistantTurnCompletionLeaseId, requested.task.turnLeaseId);
  assert.equal(requested.finalResponseAllowed, true,
    "a signed normal stage may return its current assistant response while the overall task remains incomplete");
  assert.equal(runtime.continuationTask({
    action: "claim-continuation",
    taskId: normal.task.id,
  }).accepted, false, "model intent alone must never create a new Host turn");

  // Real ChatGPT validation exposed a projection rollback when turn-complete
  // reported an additional completed milestone. The legacy task row received
  // the hint, but the active Workset still held the old PENDING state, so the
  // synthetic turn's first status recovery temporarily changed 2/3 back to
  // 1/3. The accepted completion boundary must make both projections agree
  // before the continuation handoff can mature.
  const projectionScope = "v1/atcc-turn-complete-milestone-projection";
  const projection = runtime.continuationTask({
    action: "begin",
    conversationScopeId: projectionScope,
    workspaceId: "ws_atcc_turn_complete_projection",
    objective: "preserve turn-complete milestone progress",
    requiredMilestones: ["first", "stage-boundary", "final"],
  });
  mount(projection, projectionScope, "ui_atcc_projection");
  work(projection, projectionScope, 1);
  const projectionSeed = runtime.continuationTask({
    action: "checkpoint",
    taskId: projection.task.id,
    completedMilestones: ["first"],
    evidence: { first: "verified" },
    progressFingerprint: "projection-first-complete",
  });
  assert.deepEqual(projectionSeed.task.completedMilestones, ["first"]);
  const projectionRequested = runtime.continuationTask({
    action: "turn-complete",
    taskId: projection.task.id,
    completedMilestones: ["first", "stage-boundary"],
    note: "stage-boundary-complete-final-remains",
  });
  assert.equal(projectionRequested.accepted, true);
  assert.deepEqual(projectionRequested.task.completedMilestones, ["first", "stage-boundary"]);
  const projectionArchitecture = runtime.continuationArchitectureSnapshot(projectionScope);
  const projectionWorkset = projectionArchitecture.worksets.find(
    (item) => item.id === projectionArchitecture.card.active_workset_id,
  );
  const projectionMilestoneStates = new Map(
    projectionArchitecture.milestones
      .filter((item) => item.workset_id === projectionWorkset.id)
      .map((item) => [item.description, item.state]),
  );
  assert.equal(projectionMilestoneStates.get("stage-boundary"), "COMPLETED",
    "turn-complete must synchronize its milestone delta into the authoritative active Workset");
  assert.equal(projectionMilestoneStates.get("final"), "PENDING");
  const projectionSyntheticStatus = runtime.continuationTask({
    action: "status",
    taskId: projection.task.id,
  });
  assert.deepEqual(projectionSyntheticStatus.task.completedMilestones, ["first", "stage-boundary"],
    "the synthetic turn's first canonical recovery must not roll completed milestones backward");
  assert.deepEqual(projectionSyntheticStatus.remainingMilestones, ["final"]);
  const projectionCleanup = runtime.continuationTask({
    action: "cancel",
    taskId: projection.task.id,
    note: "isolated projection regression complete",
  });
  assert.equal(projectionCleanup.accepted, true);

  // Any later substantive tool activity proves that the same assistant turn is
  // still alive and automatically revokes the pending completion intent.
  const firstRequestedAt = Date.parse(requested.task.assistantTurnCompletionRequestedAt);
  const revoked = work(normal, normalScope, 1);
  assert.equal(revoked.task.assistantTurnState, "GENERATING");
  assert.equal(revoked.task.assistantTurnCompletionLeaseId, undefined);
  assert.equal(revoked.finalResponseAllowed, false);
  assert.equal(readyForScope(runtime.continuationSupervisorSweep({ nowMs: firstRequestedAt + 30_000 }), normalScope).length, 0,
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
  const completedSweep = runtime.continuationSupervisorSweep({ nowMs: Date.now() + 1 });
  assert.equal(readyForScope(completedSweep, normalScope).length, 1,
    "model completion intent plus matching Host teardown must authorize exactly one modern READY continuation");
  const normalLegacyClaim = runtime.continuationTask({
    action: "claim-continuation",
    taskId: normal.task.id,
  });
  assert.equal(normalLegacyClaim.accepted, false);
  assert.equal(normalLegacyClaim.reason, "generation-sender-required",
    "once exact turn-end recovery is reserved, the legacy task sender must not race the modern generation sender");

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
  const handoffPrearm = runtime.continuationSupervisorSweep({ nowMs: handoffRequestedAt + 1 });
  assert.equal(readyForScope(handoffPrearm, handoffScope).length, 1,
    "an explicit completion signature must pre-arm one READY continuation while the current Host sender is most likely alive");
  assert.equal(runtime.continuationTask({ action: "status", taskId: handoff.task.id }).task.assistantTurnState,
    "COMPLETION_REQUESTED",
    "pre-arming delivery must not skip the guarded completion handoff state");
  assert.equal(readyForScope(runtime.continuationSupervisorSweep({ nowMs: handoffRequestedAt + 7_000 }), handoffScope).length, 0,
    "pre-grace supervisor sweeps must not create duplicate READY generations");
  const releaseInFlight = runtime.beginContinuationModelRequest(handoffScope);
  assert.equal(readyForScope(runtime.continuationSupervisorSweep({ nowMs: handoffRequestedAt + 9_000 }), handoffScope).length, 0,
    "even a mature explicit completion intent must fail closed while a model-originated DevSpace request is still in flight");
  assert.equal(runtime.continuationTask({ action: "status", taskId: handoff.task.id }).task.assistantTurnState,
    "COMPLETION_REQUESTED");
  releaseInFlight();
  const handoffReady = runtime.continuationSupervisorSweep({ nowMs: handoffRequestedAt + 9_001 });
  assert.equal(readyForScope(handoffReady, handoffScope).length, 0,
    "mature handoff must reuse the pre-armed READY continuation instead of creating a second generation");
  const handoffCompleted = runtime.continuationTask({ action: "status", taskId: handoff.task.id });
  assert.equal(handoffCompleted.task.assistantTurnState, "COMPLETED");
  assert.equal(handoffCompleted.task.assistantTurnCompletionLeaseId, handoffCompleted.task.turnLeaseId);
  assert.equal(handoffCompleted.task.assistantTurnCompletionSource, "model-completion-handoff-grace");
  assert.equal(handoffCompleted.task.stallState, "CONTINUATION_ARMED");
  const handoffArchitecture = runtime.continuationArchitectureSnapshot(handoffScope);
  assert.equal(handoffArchitecture.generations.filter(
    (entry) => entry.workset_id === handoffArchitecture.card.active_workset_id
      && entry.owner_type === "synthetic" && entry.state === "READY",
  ).length, 1,
    "the pre-armed continuation must remain the singleton durable READY generation after handoff promotion");
  assert.equal(readyForScope(runtime.continuationSupervisorSweep({ nowMs: handoffRequestedAt + 20_000 }), handoffScope).length, 0,
    "the handoff promotion must be idempotent and may create only one READY generation");

  // If the model performs real work after signing turn-complete, that newer
  // activity owns the turn. Revoke both the completion signature and any
  // unclaimed pre-arm so an early READY can never interrupt continuing work.
  const revokedScope = "v1/atcc-prearm-revoked-by-later-work";
  const revokedPrearmTask = begin(revokedScope, "ws_atcc_prearm_revoked_by_later_work");
  mount(revokedPrearmTask, revokedScope, "ui_atcc_prearm_revoked");
  work(revokedPrearmTask, revokedScope, 1);
  const revokedRequested = runtime.continuationTask({
    action: "turn-complete",
    taskId: revokedPrearmTask.task.id,
    note: "stage looked complete but model continued working",
  });
  assert.equal(revokedRequested.accepted, true);
  const revokedRequestedAt = Date.parse(revokedRequested.task.assistantTurnCompletionRequestedAt);
  assert.equal(readyForScope(runtime.continuationSupervisorSweep({ nowMs: revokedRequestedAt + 1 }), revokedScope).length, 1);
  runtime.touchContinuationModelActivity({
    workspaceId: "ws_atcc_prearm_revoked_by_later_work",
    conversationScopeId: revokedScope,
    substantive: true,
  });
  const revokedStatus = runtime.continuationTask({ action: "status", taskId: revokedPrearmTask.task.id });
  assert.equal(revokedStatus.task.assistantTurnState, "GENERATING",
    "later substantive work must revoke the model-owned completion signature");
  const revokedArchitecture = runtime.continuationArchitectureSnapshot(revokedScope);
  assert.equal(revokedArchitecture.generations.some(
    (entry) => entry.workset_id === revokedArchitecture.card.active_workset_id
      && entry.owner_type === "synthetic" && entry.state === "READY",
  ), false,
    "later substantive work must supersede an unclaimed pre-armed READY generation");

  // dev52 regression: browser sender availability is a delivery prerequisite,
  // not authority for the model-owned completion boundary.  A protocol upgrade
  // can leave an old cached iframe unable to bind.  The exact signed completion
  // must still mature into one durable READY generation so a later compatible
  // sender can discover it instead of leaving the conversation silently parked
  // in COMPLETION_REQUESTED forever.
  const senderlessScope = "v1/atcc-dev52-senderless-handoff";
  const senderless = begin(senderlessScope, "ws_atcc_dev52_senderless_handoff");
  const senderlessMount = runtime.prepareContinuationAnchorMount({
    taskId: senderless.task.id,
    conversationScopeId: senderlessScope,
  });
  assert.ok(senderlessMount.anchorMountToken,
    "the manual round may issue a card even if no compatible sender ever binds");
  work(senderless, senderlessScope, 1);
  const senderlessRequested = runtime.continuationTask({
    action: "turn-complete",
    taskId: senderless.task.id,
    note: "dev52-signed-final-with-incompatible-cached-sender",
  });
  assert.equal(senderlessRequested.accepted, true);
  const senderlessRequestedAt = Date.parse(senderlessRequested.task.assistantTurnCompletionRequestedAt);
  const senderlessReady = runtime.continuationSupervisorSweep({ nowMs: senderlessRequestedAt + 9_001 });
  assert.equal(readyForScope(senderlessReady, senderlessScope).length, 1,
    "a mature signed completion must create READY even when senderStatus is unavailable");
  const senderlessCompleted = runtime.continuationTask({ action: "status", taskId: senderless.task.id });
  assert.equal(senderlessCompleted.task.assistantTurnState, "COMPLETED");
  const senderlessArchitecture = runtime.continuationArchitectureSnapshot(senderlessScope);
  const senderlessGeneration = senderlessArchitecture.generations.find(
    (entry) => entry.workset_id === senderlessArchitecture.card.active_workset_id && entry.owner_type === "synthetic",
  );
  assert.equal(senderlessGeneration?.state, "READY");
  const senderlessManualTakeover = runtime.continuationTask({
    action: "status",
    taskId: senderless.task.id,
    manualTakeover: true,
  });
  assert.equal(senderlessManualTakeover.accepted, true);
  assert.equal(senderlessManualTakeover.task.assistantTurnOwner, "manual");
  assert.equal(senderlessManualTakeover.task.assistantTurnState, "GENERATING");
  assert.equal(readyForScope(runtime.continuationSupervisorSweep({ nowMs: senderlessRequestedAt + 20_000 }), senderlessScope).length, 0,
    "manual takeover must supersede a senderless READY generation before any later relay can deliver it");

  // timeout/teardown are Host-owned evidence. A model call without the current
  // verified App coordinator cannot forge them.
  const timeoutScope = "v1/atcc-timeout";
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
  const timeoutReady = runtime.continuationSupervisorSweep({ nowMs: Date.now() + 1 });
  assert.equal(readyForScope(timeoutReady, timeoutScope).length, 1,
    "verified exact-turn Host timeout must create one modern READY continuation");
  const timeoutLegacyClaim = runtime.continuationTask({
    action: "claim-continuation",
    taskId: timeout.task.id,
  });
  assert.equal(timeoutLegacyClaim.accepted, false);
  assert.equal(timeoutLegacyClaim.reason, "generation-sender-required");

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

  // Synthetic resumed turns use a stronger anti-idle floor than a manual
  // continue, but reaching the four-operation floor must not unlock an
  // unfinished synthetic stage boundary. Synthetic ownership keeps the same
  // runnable milestone set in the current Host turn until completion,
  // explicit non-runnable state, or Host truncation.
  const syntheticScope = "v1/atcc-synthetic-quality";
  const synthetic = begin(syntheticScope);
  mount(synthetic, syntheticScope, "ui_atcc_synthetic_quality");
  runtime.database.sqlite.prepare(`
    update continuation_tasks set
      delivery_owner='synthetic-active',assistant_turn_owner='synthetic',
      delivery_work_baseline_count=coalesce(substantive_activity_count,0)
    where id=?
  `).run(synthetic.task.id);
  const syntheticTooShort = runtime.continuationTask({
    action: "turn-complete",
    taskId: synthetic.task.id,
    note: "empty-handshake-loop",
  });
  assert.equal(syntheticTooShort.accepted, false);
  assert.equal(syntheticTooShort.minimumSubstantiveWorkDelta, 4);
  work(synthetic, syntheticScope, 3);
  const syntheticStillTooShort = runtime.continuationTask({
    action: "turn-complete",
    taskId: synthetic.task.id,
    note: "three-operations-still-too-short",
  });
  assert.equal(syntheticStillTooShort.accepted, false);
  assert.equal(syntheticStillTooShort.substantiveWorkDelta, 3);
  assert.equal(syntheticStillTooShort.minimumSubstantiveWorkDelta, 4);
  work(synthetic, syntheticScope, 1);
  const syntheticRequested = runtime.continuationTask({
    action: "turn-complete",
    taskId: synthetic.task.id,
    note: "model-owned-stage-boundary-after-real-work",
  });
  assert.equal(syntheticRequested.accepted, false);
  assert.equal(syntheticRequested.reason, "synthetic-turn-runnable-milestones-remain");
  assert.equal(syntheticRequested.task.assistantTurnState, "GENERATING");
  assert.equal(syntheticRequested.substantiveWorkDelta, 4);
  assert.equal(syntheticRequested.minimumSubstantiveWorkDelta, 4);
  assert.ok(Array.isArray(syntheticRequested.remainingMilestones));
  assert.ok(syntheticRequested.remainingMilestones.length > 0);
  assert.equal(syntheticRequested.minimumActiveWorkMs, undefined);
  assert.equal(syntheticRequested.retryAfterMs, undefined);

  // Confirmed or learned Host windows remain timeout diagnostics. They must
  // never create a shorter synthetic completion budget or percentage gate.
  const budgetScope = "v1/atcc-synthetic-time-telemetry-only";
  const budgetSynthetic = begin(budgetScope);
  mount(budgetSynthetic, budgetScope, "ui_atcc_synthetic_time_telemetry");
  runtime.continuationTask({
    action: "confirm-turn-limit",
    taskId: budgetSynthetic.task.id,
    elapsedMs: 420_000,
    note: "owner-telemetry-only",
  });
  runtime.database.sqlite.prepare(`
    update continuation_tasks set
      delivery_owner='synthetic-active',assistant_turn_owner='synthetic',
      delivery_work_baseline_count=coalesce(substantive_activity_count,0)
    where id=?
  `).run(budgetSynthetic.task.id);
  work(budgetSynthetic, budgetScope, 4);
  runtime.database.sqlite.prepare("update continuation_tasks set turn_started_at=? where id=?")
    .run(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(), budgetSynthetic.task.id);
  const budgetRequested = runtime.continuationTask({
    action: "turn-complete",
    taskId: budgetSynthetic.task.id,
    note: "elapsed-time-and-owner-telemetry-do-not-gate-model-boundary",
  });
  assert.equal(budgetRequested.accepted, false);
  assert.equal(budgetRequested.reason, "synthetic-turn-runnable-milestones-remain");
  assert.equal(budgetRequested.minimumActiveWorkMs, undefined);
  assert.equal(budgetRequested.syntheticHostBudgetRatio, undefined);

  // The adaptive duration gate owns only a voluntary incomplete-stage boundary. A real
  // verified Host cutoff remains independently authoritative and must recover
  // even if it occurs before any profile calibration or learned work target.
  const budgetTimeoutScope = "v1/atcc-synthetic-host-budget-timeout";
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
    "a verified Host cutoff remains independently authoritative");

  // An already-open ChatGPT Host can cache the pre-dev11 action enum even
  // after the MCP service has upgraded.  The exact reserved checkpoint note
  // is therefore a model-owned compatibility signature for turn-complete.
  // It must use the identical four-operation synthetic anti-idle gate and Host
  // ownership restrictions; ordinary checkpoint notes remain checkpoints.
  const cachedSchemaScope = "v1/atcc-cached-schema";
  const cachedSchema = begin(cachedSchemaScope, "ws_atcc_cached_schema");
  mount(cachedSchema, cachedSchemaScope, "ui_atcc_cached_schema");
  runtime.database.sqlite.prepare(`
    update continuation_tasks set
      delivery_owner='synthetic-active',assistant_turn_owner='synthetic',
      delivery_work_baseline_count=coalesce(substantive_activity_count,0)
    where id=?
  `).run(cachedSchema.task.id);
  const cachedTooShort = runtime.continuationTask({
    action: "checkpoint",
    taskId: cachedSchema.task.id,
    note: "atcc-turn-complete",
  });
  assert.equal(cachedTooShort.accepted, false);
  assert.equal(cachedTooShort.reason, "assistant-turn-substantive-work-required");
  assert.equal(cachedTooShort.substantiveWorkDelta, 0);
  assert.equal(cachedTooShort.minimumSubstantiveWorkDelta, 4);
  work(cachedSchema, cachedSchemaScope, 4);
  const cachedHostForgery = runtime.continuationTask({
    action: "checkpoint",
    taskId: cachedSchema.task.id,
    note: "atcc-turn-complete",
    coordinatorInstanceId: "ui_must_not_sign_model_completion",
  });
  assert.equal(cachedHostForgery.accepted, false);
  assert.equal(cachedHostForgery.reason, "turn-complete-model-only");
  const cachedRequested = runtime.continuationTask({
    action: "checkpoint",
    taskId: cachedSchema.task.id,
    note: "atcc-turn-complete",
  });
  assert.equal(cachedRequested.accepted, false);
  assert.equal(cachedRequested.reason, "synthetic-turn-runnable-milestones-remain");
  assert.equal(cachedRequested.task.assistantTurnState, "GENERATING");
  // Cached-schema compatibility remains valid for an ordinary manual turn;
  // the synthetic runnable-milestone gate must not disable the compatibility
  // signature globally.
  runtime.database.sqlite.prepare(`
    update continuation_tasks set delivery_owner='manual',assistant_turn_owner='manual'
    where id=?
  `).run(cachedSchema.task.id);
  const cachedManualRequested = runtime.continuationTask({
    action: "checkpoint",
    taskId: cachedSchema.task.id,
    note: "atcc-turn-complete",
  });
  assert.equal(cachedManualRequested.accepted, true);
  assert.equal(cachedManualRequested.reason, "assistant-turn-completion-requested-via-checkpoint-compat");
  assert.equal(cachedManualRequested.task.assistantTurnState, "COMPLETION_REQUESTED");
  assert.equal(cachedManualRequested.finalResponseAllowed, true);
  const cachedRequestedAt = Date.parse(cachedManualRequested.task.assistantTurnCompletionRequestedAt);
  assert.equal(readyForScope(runtime.continuationSupervisorSweep({ nowMs: cachedRequestedAt + 1 }), cachedSchemaScope).length, 1,
    "cached-schema completion compatibility must pre-arm the same singleton READY generation as native turn-complete");
  assert.equal(runtime.continuationTask({ action: "status", taskId: cachedSchema.task.id }).task.assistantTurnState,
    "COMPLETION_REQUESTED",
    "cached-schema pre-arm must still preserve the bounded completion handoff state");
  assert.equal(readyForScope(runtime.continuationSupervisorSweep({ nowMs: cachedRequestedAt + 7_000 }), cachedSchemaScope).length, 0,
    "cached-schema pre-grace sweeps must not mint duplicate READY generations");
  const cachedReady = runtime.continuationSupervisorSweep({ nowMs: cachedRequestedAt + 9_000 });
  assert.equal(readyForScope(cachedReady, cachedSchemaScope).length, 0,
    "cached-schema checkpoint completion must reuse the pre-armed READY generation after handoff promotion");
  const cachedCompleted = runtime.continuationTask({ action: "status", taskId: cachedSchema.task.id });
  assert.equal(cachedCompleted.task.assistantTurnState, "COMPLETED");
  assert.equal(cachedCompleted.task.assistantTurnCompletionSource, "model-completion-handoff-grace");
  const cachedArchitecture = runtime.continuationArchitectureSnapshot(cachedSchemaScope);
  assert.equal(cachedArchitecture.generations.filter(
    (entry) => entry.workset_id === cachedArchitecture.card.active_workset_id
      && entry.owner_type === "synthetic" && entry.state === "READY",
  ).length, 1,
    "cached-schema compatibility must preserve exactly one durable READY generation");

  const ordinaryCheckpointScope = "v1/atcc-ordinary-checkpoint";
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
      assistant_turn_completion_lease_id=null,stall_state='ACTIVE',
      turn_started_at=?,turn_lease_expires_at=?
    where id=?
  `).run(
    new Date(Date.now() - 15 * 60_000).toISOString(),
    new Date(Date.now() - 45 * 60_000).toISOString(),
    new Date(Date.now() - 10 * 60_000).toISOString(),
    synthetic.task.id,
  );
  const expiredOwnerClaim = runtime.continuationTask({
    action: "claim-continuation",
    taskId: synthetic.task.id,
    note: "synthetic resume work ownership lease expired",
  });
  assert.equal(expiredOwnerClaim.accepted, false);
  assert.equal(expiredOwnerClaim.reason, "continuation-trigger-not-authorized");
  const longRunningSyntheticSweep = runtime.continuationSupervisorSweep({ nowMs: Date.now() + 120_000 });
  assert.equal(readyForScope(longRunningSyntheticSweep, syntheticScope).length, 0,
    "even a >30-minute GENERATING synthetic turn with expired activity/owner leases must never manufacture a replacement turn");
  const longRunningSyntheticStatus = runtime.continuationTask({ action: "status", taskId: synthetic.task.id });
  assert.equal(longRunningSyntheticStatus.task.assistantTurnState, "GENERATING");
  assert.equal(longRunningSyntheticStatus.task.deliveryOwner, "synthetic-active",
    "lease expiry is telemetry only and must not revoke an actually GENERATING synthetic turn");

  // A new manual turn creates a new lease and invalidates stale completion
  // intent from the previous assistant turn before any side effect is allowed.
  const takeoverScope = "v1/atcc-manual-takeover";
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

  // dev76 production regression: canonical projection recovery may leave the
  // compatibility task row saying "manual" while the authoritative generation
  // ledger still contains an ACKed WORK_REQUIRED synthetic turn. Manual input
  // must fence that generation too; otherwise it survives the user message and
  // prevents the next model turn-complete from scheduling a fresh continuation.
  const recoveredOwnerScope = "v1/atcc-dev76-recovered-owner-drift";
  const recoveredOwner = begin(recoveredOwnerScope, "ws_atcc_dev76_recovered_owner");
  mount(recoveredOwner, recoveredOwnerScope, "ui_atcc_dev76_recovered_owner");
  const recoveredOwnerArchitecture = runtime.continuationArchitectureSnapshot(recoveredOwnerScope);
  const recoveredOwnerGeneration = recoveredOwnerArchitecture.generations.at(-1);
  assert.ok(recoveredOwnerGeneration, "missing recovered-owner generation fixture");
  runtime.database.sqlite.prepare(`
    update continuation_generations
    set owner_type='synthetic',state='WORK_REQUIRED',delivery_token='dev76-owner-drift-token',
      delivered_at=?,turn_acked_at=?,updated_at=? where id=?
  `).run(new Date().toISOString(), new Date().toISOString(), new Date().toISOString(), recoveredOwnerGeneration.id);
  runtime.database.sqlite.prepare(`
    update continuation_tasks set delivery_owner='manual',delivery_token=null,
      assistant_turn_owner='manual',continuation_pending=0 where id=?
  `).run(recoveredOwner.task.id);
  const recoveredOwnerManual = runtime.continuationTask({
    action: "status",
    taskId: recoveredOwner.task.id,
    conversationScopeId: recoveredOwnerScope,
    manualTakeover: true,
  });
  assert.equal(recoveredOwnerManual.accepted, true);
  assert.equal(recoveredOwnerManual.task.assistantTurnOwner, "manual");
  assert.equal(runtime.database.sqlite.prepare(
    "select state,failure_reason from continuation_generations where id=?",
  ).get(recoveredOwnerGeneration.id).state, "SUPERSEDED",
  "manual takeover must revoke an authoritative WORK_REQUIRED generation even when task delivery_owner drifted to manual");
  const recoveredOwnerActiveSynthetic = runtime.database.sqlite.prepare(`
    select count(*) as count from continuation_generations g
    join continuation_conversation_cards c on c.active_workset_id=g.workset_id
    where c.conversation_scope_id=? and g.owner_type='synthetic'
      and g.state in ('READY','CLAIMED','DELIVERING','DELIVERED','TURN_ACKED','WORK_REQUIRED')
  `).get(recoveredOwnerScope);
  assert.equal(Number(recoveredOwnerActiveSynthetic?.count || 0), 0,
    "manual takeover must leave no live synthetic generation behind after projection-owner drift");

  // Strict timeout-recovery remains a supported compatibility mode, but its
  // only automatic turn-end authority is a verified Host timeout. Normal
  // teardown and model turn-complete intent must not broaden that contract.
  const strictScope = "v1/atcc-timeout-recovery";
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
  const strictReady = runtime.continuationSupervisorSweep({ nowMs: Date.now() + 1 });
  assert.equal(readyForScope(strictReady, strictScope).length, 1,
    "strict timeout-recovery must expose exactly one modern READY generation after verified Host timeout");
  const strictLegacyClaim = runtime.continuationTask({
    action: "claim-continuation",
    taskId: strict.task.id,
  });
  assert.equal(strictLegacyClaim.accepted, false);
  assert.equal(strictLegacyClaim.reason, "generation-sender-required");

  // Regression for the JSTARS desktop-only request: pending old milestones
  // must survive an explicit user handoff without creating another Host turn.
  for (const mode of ["completion-driven", "timeout-recovery", "resident"]) {
    const scope = `v1/dev75-await-user-${mode}`;
    const fixture = runtime.continuationTask({ action: "begin", conversationScopeId: scope,
      workspaceId: `ws_await_${mode}`, objective: "User takes over submission", continuationMode: mode,
      requiredMilestones: ["pending submission", "user review"] });
    mount(fixture, scope, `ui_await_${mode}`);
    work(fixture, scope, 1);
    const handoff = runtime.continuationTask({ action: "turn-complete", taskId: fixture.task.id,
      completionDisposition: "await-user", note: "User explicitly owns the remaining submission" });
    assert.equal(handoff.accepted, true);
    assert.equal(handoff.finalResponseAllowed, true);
    assert.equal(handoff.task.state, "WAITING_EXTERNAL");
    assert.equal(handoff.task.assistantTurnCompletionSource, "model-await-user");
    assert.deepEqual(handoff.remainingMilestones, ["pending submission", "user review"]);
    assert.equal(readyForScope(runtime.continuationSupervisorSweep({ nowMs: Date.now() + 60_000 }), scope).length, 0);
    assert.equal(runtime.continuationTask({ action: "resume", taskId: fixture.task.id,
      coordinatorInstanceId: `ui_await_${mode}` }).accepted, false,
      "iframe reconnect cannot undo explicit user takeover");
    const manual = runtime.continuationTask({ action: "status", taskId: fixture.task.id,
      conversationScopeId: scope, manualTakeover: true, objective: "New desktop request",
      requiredMilestones: ["copy package"] });
    assert.equal(manual.task.state, "RUNNING");
    assert.deepEqual(manual.task.requiredMilestones, ["copy package"]);
  }
  const compatAwaitScope = "v1/dev75-await-user-cached-schema";
  const compatAwait = begin(compatAwaitScope);
  mount(compatAwait, compatAwaitScope, "ui_compat_await");
  assert.equal(runtime.continuationTask({ action: "checkpoint", taskId: compatAwait.task.id,
    note: "atcc-await-user", coordinatorInstanceId: "ui_compat_await" }).accepted, false);
  assert.equal(runtime.continuationTask({ action: "checkpoint", taskId: compatAwait.task.id,
    note: "atcc-await-user" }).reason, "awaiting-user");
  const continuedByUser = runtime.continuationTask({ action: "status", taskId: compatAwait.task.id,
    conversationScopeId: compatAwaitScope, manualTakeover: true });
  assert.equal(continuedByUser.task.state, "RUNNING", "plain manual continue resumes the preserved plan");
  assert.deepEqual(continuedByUser.task.requiredMilestones, ["finish"]);
  assert.equal(continuedByUser.task.assistantTurnCompletionSource, undefined);

  // Pre-cutoff acceptance must connect all the way to sender authorization,
  // including strict timeout-recovery; merely accepting turn-complete is not enough.
  for (const mode of ["completion-driven", "timeout-recovery"]) for (const cachedSchema of [false, true]) {
    const scope = `v1/dev75-prehandoff-${mode}-${cachedSchema}`;
    const fixture = runtime.continuationTask({ action: "begin", conversationScopeId: scope,
      workspaceId: `ws_prehandoff_${mode}`, objective: "Continue complex work", continuationMode: mode,
      requiredMilestones: ["finish"] });
    mount(fixture, scope, `ui_prehandoff_${mode}`);
    work(fixture, scope, 4);
    runtime.database.sqlite.prepare(`update continuation_tasks set cutoff_samples_json='[600000,601000]',
      turn_started_at=?,delivery_owner='synthetic-active',assistant_turn_owner='synthetic',
      delivery_work_baseline_count=0 where id=?`).run(new Date(Date.now() - 300_000).toISOString(), fixture.task.id);
    const early = runtime.continuationTask({ action: "turn-complete", taskId: fixture.task.id });
    assert.equal(early.accepted, false, "window must not authorize an early synthetic final");
    runtime.database.sqlite.prepare("update continuation_tasks set turn_started_at=? where id=?")
      .run(new Date(Date.now() - 560_000).toISOString(), fixture.task.id);
    const request = runtime.continuationTask({ taskId: fixture.task.id,
      ...(cachedSchema ? { action: "checkpoint", note: "atcc-turn-complete" } : { action: "turn-complete" }) });
    assert.equal(request.accepted, true, `pre-handoff request ${mode}`);
    assert.equal(request.task.assistantTurnCompletionNote, "learned-host-cutoff-prehandoff");
    const requestedAt = Date.parse(request.task.assistantTurnCompletionRequestedAt);
    runtime.continuationSupervisorSweep({ nowMs: requestedAt + 9_001 });
    const ended = runtime.continuationTask({ action: "status", taskId: fixture.task.id, readOnlyStatus: true });
    assert.equal(ended.task.assistantTurnState, "COMPLETED", `pre-handoff promotion ${mode}`);
    const architecture = runtime.continuationArchitectureSnapshot(scope);
    assert.equal(architecture.generations.filter(g => g.owner_type === "synthetic" && g.state === "READY").length, 1);
    const capability = runtime.continuationSenderCapability({ taskId: fixture.task.id });
    const senderArgs = { conversationScopeId: scope, taskId: fixture.task.id,
      senderInstanceId: `ui_prehandoff_${mode}`, anchorMountToken: capability.anchorMountToken,
      anchorMountGeneration: capability.anchorMountGeneration };
    const claim = runtime.claimReadyContinuationGeneration(senderArgs);
    assert.equal(claim.accepted, true, `pre-handoff claim ${mode}/${cachedSchema}`);
    const authorization = runtime.authorizeContinuationGenerationDelivery({ ...senderArgs,
      deliveryToken: claim.deliveryToken });
    assert.equal(authorization.accepted, true, `pre-handoff delivery ${mode}/${cachedSchema}`);
  }

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
    manualMinimumSubstantiveWorkDelta: 1,
    syntheticMinimumSubstantiveWorkDelta: 4,
    singleOrUnstableHostBudgetIsTelemetryOnly: true,
    clusteredCutoffInfersTimeoutWithoutHostEvent: true,
    learnedCutoffProtectsRequestsProcessesAndManualTakeover: true,
    learnedCutoffRejectsRevokedHostProfile: true,
    learnedCutoffRecoversSyntheticWorkWithoutDuplicateReady: true,
    verifiedHostTimeoutRemainsAuthoritative: true,
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
