import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StructuredRuntimeState } from "../app/node_modules/@waishnav/devspace/dist/runtime-state.js";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
for (const file of ["runtime-state.js", "server.js", "ui/assets/continuation-coordinator.js"]) {
  assert.ok(readFileSync(join(ROOT, "vendor/waishnav-devspace/dist", file)).equals(
    readFileSync(join(ROOT, "app/node_modules/@waishnav/devspace/dist", file))),
  `Tests require the installed core to equal canonical ${file}`);
}
const cache = join(ROOT, ".test-cache");
mkdirSync(cache, { recursive: true });
const temp = mkdtempSync(join(cache, "resident-turns-"));
const runtime = new StructuredRuntimeState(temp);
const epoch = Number(readFileSync(join(ROOT, "vendor/waishnav-devspace/dist/server.js"), "utf8")
  .match(/const CONTINUATION_SENDER_PROTOCOL_EPOCH = (\d+);/)[1]);
runtime.configureContinuationSenderTransport({ protocolEpoch: epoch, assetRevision: "0123456789abcdef" });
let counter = 0;
function fixture(mode = "resident", { watch = mode === "resident" } = {}) {
  const scope = `v1/resident-contract-${++counter}`;
  const started = runtime.continuationTask({ action: "begin", conversationScopeId: scope,
    workspaceId: `ws_resident_${counter}`, continuationMode: mode,
    objective: "Monitor a long process across model turns", requiredMilestones: ["review", "finish"] });
  const taskId = started.task.id;
  const mount = runtime.prepareContinuationAnchorMount({ taskId, conversationScopeId: scope });
  const sender = { taskId, conversationScopeId: scope, senderInstanceId: `sender_${counter}`,
    anchorMountToken: mount.anchorMountToken, anchorMountGeneration: mount.anchorMountGeneration };
  assert.equal(runtime.continuationTask({ action: "anchor-mounted", taskId,
    conversationScopeId: scope, coordinatorInstanceId: sender.senderInstanceId,
    anchorMountToken: mount.anchorMountToken }).accepted, true);
  assert.equal(runtime.bindContinuationSender(sender).accepted, true);
  if (watch) {
    assert.equal(runtime.continuationTask({ action: "watch-process", taskId, processHandle: "training" }).accepted, true);
  }
  return { taskId, scope, sender, lease: started.task.turnLeaseId };
}
const status = f => runtime.continuationTask({ action: "status", taskId: f.taskId, readOnlyStatus: true }).task;
const work = f => runtime.touchContinuationModelActivity({ conversationScopeId: f.scope, substantive: true });
const ready = (f, nowMs = Date.now()) => runtime.continuationSupervisorSweep({ nowMs }).ready.filter(g => g.conversationScopeId === f.scope);
function timeout(f) {
  return runtime.recordContinuationSenderHostTimeout({ ...f.sender, turnLeaseId: status(f).turnLeaseId,
    hostProfileId: "test-host", elapsedMs: 60_000, note: "isolated test fixture, not a live Host event" });
}
function ageIntent(f) {
  runtime.database.sqlite.prepare("update continuation_tasks set assistant_turn_completion_requested_at=? where id=?")
    .run(new Date(Date.now() - 9000).toISOString(), f.taskId);
}
function teachClusteredCutoff(f, firstMs = 30_000, secondMs = 30_500) {
  assert.equal(runtime.continuationTask({ action: "confirm-turn-limit", taskId: f.taskId,
    elapsedMs: firstMs, note: `fixture-cutoff-${firstMs}` }).accepted, true);
  assert.equal(runtime.continuationTask({ action: "confirm-turn-limit", taskId: f.taskId,
    elapsedMs: secondMs, note: `fixture-cutoff-${secondMs}` }).accepted, true);
}
function ageTurnPastLearnedCutoff(f, elapsedMs = 45_000) {
  const startedAt = Date.now() - elapsedMs;
  runtime.database.sqlite.prepare(`
    update continuation_tasks set turn_started_at=?,last_model_activity_at=?,turn_lease_expires_at=? where id=?
  `).run(new Date(startedAt).toISOString(), new Date(startedAt + 1000).toISOString(),
    new Date(Date.now() - 1000).toISOString(), f.taskId);
  runtime.database.sqlite.prepare(`
    update continuation_worksets set continuation_due_at=?,last_model_activity_at=?
    where legacy_task_id=? and state in ('RUNNING','SUSPECTED_STALL')
  `).run(new Date(Date.now() - 1000).toISOString(), new Date(startedAt + 1000).toISOString(), f.taskId);
}
function deliver(f) {
  const claim = runtime.claimReadyContinuationGeneration(f.sender);
  assert.equal(claim.accepted, true, JSON.stringify(claim));
  const args = { ...f.sender, deliveryToken: claim.deliveryToken };
  const auth = runtime.authorizeContinuationGenerationDelivery(args);
  assert.equal(auth.accepted, true, JSON.stringify(auth));
  const delivered = runtime.markContinuationGenerationDelivered(args);
  assert.equal(delivered.accepted, true, JSON.stringify(delivered));
  const ack = runtime.continuationTask({ action: "status", taskId: f.taskId,
    conversationScopeId: f.scope, deliveryToken: claim.deliveryToken });
  assert.equal(ack.accepted, true, JSON.stringify(ack));
  return ack;
}
function seedSyntheticCadence(f, { operationCount = 10, gapMs = 10_000 } = {}) {
  assert.ok(operationCount >= 8);
  for (let i = 0; i < operationCount; i++) work(f);
  const baseMs = Date.now();
  const operations = Array.from({ length: operationCount }, (_, index) => ({
    tool: index % 2 ? "read" : "exec_command",
    success: true,
    capturedAt: new Date(baseMs + (index + 1) * gapMs).toISOString(),
  }));
  const lastActivityMs = Date.parse(operations.at(-1).capturedAt);
  const resumeContext = {
    protocol: "devspace-resume-execution-v1",
    capturedAt: operations.at(-1).capturedAt,
    taskId: f.taskId,
    assistantTurnOwner: "synthetic",
    deliveryGeneration: status(f).deliveryGeneration,
    operations,
  };
  runtime.database.sqlite.prepare(`
    update continuation_tasks set
      turn_started_at=?,last_model_activity_at=?,last_activity_at=?,
      last_ui_heartbeat_at=?,turn_lease_expires_at=?,resume_context_json=?
    where id=?
  `).run(new Date(baseMs).toISOString(), new Date(lastActivityMs).toISOString(),
    new Date(lastActivityMs).toISOString(), new Date(lastActivityMs + 80_000).toISOString(),
    new Date(lastActivityMs + 25_000).toISOString(), JSON.stringify(resumeContext), f.taskId);
  runtime.database.sqlite.prepare(`
    update continuation_worksets set continuation_due_at=?,last_model_activity_at=?,updated_at=?
    where legacy_task_id=? and state in ('RUNNING','SUSPECTED_STALL')
  `).run(new Date(lastActivityMs + 25_000).toISOString(), new Date(lastActivityMs).toISOString(),
    new Date(lastActivityMs).toISOString(), f.taskId);
  return { baseMs, lastActivityMs, operations };
}
function ageSyntheticUnderfloor(f, quietMs = 130_000) {
  const nowMs = Date.now();
  const lastActivityMs = nowMs - quietMs;
  const generation = runtime.database.sqlite.prepare(`
    select g.* from continuation_conversation_cards c
    join continuation_generations g on g.workset_id=c.active_workset_id
    where c.conversation_scope_id=? and g.owner_type='synthetic'
      and g.state in ('TURN_ACKED','WORK_REQUIRED')
    order by g.generation desc limit 1
  `).get(f.scope);
  assert.ok(generation, "fixture requires one ACKed synthetic generation");
  runtime.database.sqlite.prepare(`
    update continuation_generations
    set turn_acked_at=?,last_activity_at=?,updated_at=? where id=?
  `).run(
    new Date(lastActivityMs - 10_000).toISOString(),
    new Date(lastActivityMs).toISOString(),
    new Date(lastActivityMs).toISOString(),
    generation.id,
  );
  runtime.database.sqlite.prepare(`
    update continuation_tasks set
      last_model_activity_at=?,last_activity_at=?,turn_lease_expires_at=?,
      stall_state='ACTIVE',stall_suspected_at=null,stall_probe_count=0,
      stall_last_probe_at=null,stall_armed_at=null,stall_evidence=null
    where id=?
  `).run(
    new Date(lastActivityMs).toISOString(),
    new Date(lastActivityMs).toISOString(),
    new Date(lastActivityMs + 25_000).toISOString(),
    f.taskId,
  );
  runtime.database.sqlite.prepare(`
    update continuation_worksets set continuation_due_at=?,last_model_activity_at=?,updated_at=?
    where legacy_task_id=? and state in ('RUNNING','SUSPECTED_STALL')
  `).run(
    new Date(lastActivityMs + 25_000).toISOString(),
    new Date(lastActivityMs).toISOString(),
    new Date(lastActivityMs).toISOString(),
    f.taskId,
  );
  return { nowMs, lastActivityMs, generation };
}
try {
  for (const mode of ["resident", "completion-driven", "timeout-recovery"]) {
    const f = fixture(mode);
    assert.equal(timeout(f).accepted, true);
    assert.equal(status(f).assistantTurnState, "TIMED_OUT");
    assert.equal(ready(f).length, 1, `${mode} timeout must recover while process runs`);
    assert.equal(ready(f).length, 0, "one READY per ended turn");
    const ack = deliver(f);
    assert.equal(ack.task.assistantTurnOwner, "synthetic");
    assert.deepEqual(ack.task.watchProcessHandles, mode === "resident" ? ["training"] : []);
    assert.notEqual(ack.task.turnLeaseId, f.lease);
    for (let i = 0; i < 4; i++) work(f);
    runtime.continuationTask({ action: "checkpoint", taskId: f.taskId,
      completedMilestones: ["review"], evidence: { reviewed: true } });
    assert.equal(status(f).state, "RUNNING", "one milestone does not end the workset");
    assert.deepEqual(status(f).watchProcessHandles, mode === "resident" ? ["training"] : []);
    assert.equal(ready(f, Date.now() + 3600_000).length, 0, "a live synthetic turn cannot be replaced by duration");
    assert.equal(timeout(f).accepted, true);
    assert.equal(ready(f).length, 1, "a second actual timeout must recover the same monitored workset");
    deliver(f);
    runtime.continuationTask({ action: "checkpoint", taskId: f.taskId,
      completedMilestones: ["finish"], evidence: { verified: true } });
    const done = runtime.continuationTask({ action: "complete", taskId: f.taskId, evidence: { verified: true } });
    assert.equal(done.task.state, "SUCCEEDED");
    assert.equal(ready(f).length, 0);
  }
  for (const mode of ["completion-driven", "timeout-recovery"]) {
    const f = fixture(mode);
    const rejectedWatch = runtime.continuationTask({ action: "watch-process", taskId: f.taskId, processHandle: "training" });
    assert.equal(rejectedWatch.accepted, false);
    assert.equal(rejectedWatch.reason, "resident-mode-required");
  }
  const inferredResident = fixture("resident");
  teachClusteredCutoff(inferredResident);
  ageTurnPastLearnedCutoff(inferredResident);
  assert.equal(ready(inferredResident).length, 1,
    "resident must recover a silent Host cutoff after a clustered adaptive deadline even while its external process is still watched");
  const inferredResidentStatus = status(inferredResident);
  assert.equal(inferredResidentStatus.assistantTurnState, "TIMED_OUT");
  assert.equal(inferredResidentStatus.assistantTurnCompletionSource, "learned-host-cutoff-inferred");
  assert.deepEqual(inferredResidentStatus.watchProcessHandles, ["training"],
    "external process lifetime must remain independent of the inferred assistant-turn end");
  assert.equal(runtime.pollEvents({ kind: "continuation-host-timeout-inferred",
    subject: inferredResident.scope, limit: 20 }).events.length, 1);
  work(inferredResident);
  const revivedResident = status(inferredResident);
  assert.equal(revivedResident.assistantTurnState, "GENERATING",
    "a substantive request that survives the learned boundary must revoke a false-positive inferred timeout");
  assert.deepEqual(revivedResident.cutoffSamples, [],
    "surviving the learned boundary must invalidate the old Host cutoff regime");
  assert.equal(runtime.claimReadyContinuationGeneration(inferredResident.sender).accepted, false,
    "revoking an inferred timeout must fence its unconsumed READY generation");
  assert.equal(runtime.pollEvents({ kind: "continuation-host-timeout-inference-revoked",
    subject: inferredResident.scope, limit: 20 }).events.length, 1);

  const inferredAcrossSynthetic = fixture("resident");
  teachClusteredCutoff(inferredAcrossSynthetic);
  ageTurnPastLearnedCutoff(inferredAcrossSynthetic);
  assert.equal(ready(inferredAcrossSynthetic).length, 1);
  deliver(inferredAcrossSynthetic);
  assert.equal(status(inferredAcrossSynthetic).assistantTurnOwner, "synthetic");
  ageTurnPastLearnedCutoff(inferredAcrossSynthetic);
  assert.equal(ready(inferredAcrossSynthetic).length, 1,
    "the same resident watched process must survive and recover a later synthetic Host cutoff without waiting for the 30-minute owner lease");
  assert.deepEqual(status(inferredAcrossSynthetic).watchProcessHandles, ["training"]);

  const earlyFinal = fixture("resident", { watch: false });
  assert.equal(timeout(earlyFinal).accepted, true);
  assert.equal(ready(earlyFinal).length, 1);
  deliver(earlyFinal);
  const earlyCadence = seedSyntheticCadence(earlyFinal, { operationCount: 10, gapMs: 10_000 });
  assert.equal(ready(earlyFinal, earlyCadence.lastActivityMs + 89_000).length, 0,
    "dense synthetic tool cadence must not authorize a replacement Host turn from ordinary quiet");
  assert.equal(ready(earlyFinal, earlyCadence.lastActivityMs + 91_000).length, 0,
    "an ACKed synthetic turn must remain live across the former orphan threshold because MCP silence cannot prove the Host turn ended");
  assert.equal(status(earlyFinal).assistantTurnState, "GENERATING");
  assert.equal(runtime.pollEvents({ kind: "continuation-synthetic-active-orphan-inferred",
    subject: earlyFinal.scope, limit: 20 }).events.length, 0,
    "dev87 must not create new synthetic orphan inference events");
  work(earlyFinal);
  assert.equal(status(earlyFinal).assistantTurnState, "GENERATING",
    "late substantive work remains ordinary activity because no orphan inference was allowed");
  assert.equal(runtime.claimReadyContinuationGeneration(earlyFinal.sender).accepted, false,
    "ordinary silence must not have created a replacement READY to claim");

  const recoverEarlyFinal = fixture("resident", { watch: false });
  assert.equal(timeout(recoverEarlyFinal).accepted, true);
  assert.equal(ready(recoverEarlyFinal).length, 1);
  deliver(recoverEarlyFinal);
  const recoverCadence = seedSyntheticCadence(recoverEarlyFinal, { operationCount: 10, gapMs: 10_000 });
  assert.equal(ready(recoverEarlyFinal, recoverCadence.lastActivityMs + 91_000).length, 0,
    "former orphan-recovery timing must no longer create sender authority");
  assert.equal(runtime.claimReadyContinuationGeneration(recoverEarlyFinal.sender).accepted, false,
    "without model completion or Host-timeout recovery there must be no replacement generation to claim");

  // Production generation 19 (2026-09-18) delivered and ACKed correctly, ran
  // only two substantive DevSpace tools, then the Host/model turn disappeared
  // without turn-complete.  This is not ordinary healthy synthetic silence:
  // it violates the resumed turn's mandatory four-operation anti-idle floor.
  // Recover that exact narrow state after a two-stage quiet window while
  // preserving the old no-silence-inference rule for healthy/resident turns.
  const underfloor = fixture("completion-driven", { watch: false });
  assert.equal(timeout(underfloor).accepted, true);
  assert.equal(ready(underfloor).length, 1);
  deliver(underfloor);
  work(underfloor);
  work(underfloor);
  const underfloorAge = ageSyntheticUnderfloor(underfloor, 130_000);
  assert.equal(ready(underfloor, underfloorAge.nowMs).length, 0,
    "the first underfloor watchdog sweep must only persist SUSPECTED_STALL");
  const underfloorSuspected = status(underfloor);
  assert.equal(underfloorSuspected.stallState, "SUSPECTED_STALL");
  assert.equal(underfloorSuspected.stallEvidence, "synthetic-underfloor-stall-watchdog");
  const recoveredUnderfloor = ready(underfloor, underfloorAge.nowMs + 31_000);
  assert.equal(recoveredUnderfloor.length, 1,
    "an ACKed completion-driven synthetic turn still below the four-tool floor must recover after sustained quiet");
  const orphanedUnderfloor = status(underfloor);
  assert.equal(orphanedUnderfloor.assistantTurnState, "ORPHANED");
  assert.equal(orphanedUnderfloor.assistantTurnCompletionSource, "synthetic-underfloor-stall-inferred");
  const retiredUnderfloorGeneration = runtime.database.sqlite.prepare(`
    select state,failure_reason,substantive_activity_count,substantive_baseline_count
    from continuation_generations where id=?
  `).get(underfloorAge.generation.id);
  assert.equal(retiredUnderfloorGeneration.state, "NO_WORK");
  assert.equal(retiredUnderfloorGeneration.failure_reason, "synthetic-underfloor-stall-recovered");
  assert.equal(
    Number(retiredUnderfloorGeneration.substantive_activity_count)
      - Number(retiredUnderfloorGeneration.substantive_baseline_count),
    2,
  );
  assert.equal(runtime.pollEvents({
    kind: "continuation-synthetic-underfloor-recovered",
    subject: underfloor.scope,
    limit: 20,
  }).events.length, 1);
  const quarantinedClaim = runtime.claimReadyContinuationGeneration(underfloor.sender);
  assert.equal(quarantinedClaim.accepted, false);
  assert.equal(quarantinedClaim.reason, "generation-not-due",
    "underfloor replacement must keep a short quarantine before visible Host delivery");
  runtime.database.sqlite.prepare(`
    update continuation_generations set due_at=?
    where workset_id=(select active_workset_id from continuation_conversation_cards where conversation_scope_id=?)
      and owner_type='synthetic' and state='READY'
  `).run(new Date(Date.now() - 1_000).toISOString(), underfloor.scope);
  const postQuarantineClaim = runtime.claimReadyContinuationGeneration(underfloor.sender);
  assert.equal(postQuarantineClaim.accepted, true,
    "the replacement generation must become claimable after its short quarantine");
  runtime.continuationTask({ action: "cancel", taskId: underfloor.taskId, note: "fixture complete" });

  const underfloorLongThink = fixture("completion-driven", { watch: false });
  assert.equal(timeout(underfloorLongThink).accepted, true);
  assert.equal(ready(underfloorLongThink).length, 1);
  deliver(underfloorLongThink);
  work(underfloorLongThink);
  work(underfloorLongThink);
  const longThinkAge = ageSyntheticUnderfloor(underfloorLongThink, 100_000);
  assert.equal(ready(underfloorLongThink, longThinkAge.nowMs).length, 0);
  assert.equal(ready(underfloorLongThink, longThinkAge.nowMs + 10_000).length, 0,
    "sub-four synthetic reasoning gaps below the 120-second recovery boundary must remain protected");
  assert.equal(status(underfloorLongThink).assistantTurnState, "GENERATING");
  runtime.continuationTask({ action: "cancel", taskId: underfloorLongThink.taskId, note: "fixture complete" });

  const healthySyntheticQuiet = fixture("completion-driven", { watch: false });
  assert.equal(timeout(healthySyntheticQuiet).accepted, true);
  assert.equal(ready(healthySyntheticQuiet).length, 1);
  deliver(healthySyntheticQuiet);
  for (let i = 0; i < 4; i++) work(healthySyntheticQuiet);
  const healthyAge = ageSyntheticUnderfloor(healthySyntheticQuiet, 180_000);
  assert.equal(ready(healthySyntheticQuiet, healthyAge.nowMs).length, 0);
  assert.equal(ready(healthySyntheticQuiet, healthyAge.nowMs + 60_000).length, 0,
    "once the four-tool floor is met, arbitrary synthetic silence must never become continuation authority");
  assert.equal(status(healthySyntheticQuiet).assistantTurnState, "GENERATING");
  runtime.continuationTask({ action: "cancel", taskId: healthySyntheticQuiet.taskId, note: "fixture complete" });

  const residentUnderfloor = fixture("resident", { watch: false });
  assert.equal(timeout(residentUnderfloor).accepted, true);
  assert.equal(ready(residentUnderfloor).length, 1);
  deliver(residentUnderfloor);
  work(residentUnderfloor);
  work(residentUnderfloor);
  const residentUnderfloorAge = ageSyntheticUnderfloor(residentUnderfloor, 180_000);
  assert.equal(ready(residentUnderfloor, residentUnderfloorAge.nowMs).length, 0);
  assert.equal(ready(residentUnderfloor, residentUnderfloorAge.nowMs + 60_000).length, 0,
    "resident/process-monitor turns must not use the completion-driven underfloor watchdog");
  runtime.continuationTask({ action: "cancel", taskId: residentUnderfloor.taskId, note: "fixture complete" });

  const underfloorInFlight = fixture("completion-driven", { watch: false });
  assert.equal(timeout(underfloorInFlight).accepted, true);
  assert.equal(ready(underfloorInFlight).length, 1);
  deliver(underfloorInFlight);
  work(underfloorInFlight);
  work(underfloorInFlight);
  const inFlightAge = ageSyntheticUnderfloor(underfloorInFlight, 130_000);
  assert.equal(ready(underfloorInFlight, inFlightAge.nowMs).length, 0);
  const releaseInFlight = runtime.beginContinuationModelRequest(underfloorInFlight.scope);
  assert.equal(ready(underfloorInFlight, inFlightAge.nowMs + 31_000).length, 0,
    "an in-flight model-originated DevSpace request must fence underfloor recovery");
  releaseInFlight();
  assert.equal(ready(underfloorInFlight, inFlightAge.nowMs + 32_000).length, 1,
    "underfloor recovery may proceed after the exact model request has drained");
  runtime.continuationTask({ action: "cancel", taskId: underfloorInFlight.taskId, note: "fixture complete" });

  const longThink = fixture("resident", { watch: false });
  assert.equal(timeout(longThink).accepted, true);
  assert.equal(ready(longThink).length, 1);
  deliver(longThink);
  const longThinkCadence = seedSyntheticCadence(longThink, { operationCount: 8, gapMs: 60_000 });
  assert.equal(ready(longThink, longThinkCadence.lastActivityMs + 120_000).length, 0,
    "a turn whose own observed tool cadence already contains long gaps must not be interrupted by a fixed two-minute silence rule");

  const orphanManual = fixture("resident", { watch: false });
  assert.equal(timeout(orphanManual).accepted, true);
  assert.equal(ready(orphanManual).length, 1);
  deliver(orphanManual);
  const manualCadence = seedSyntheticCadence(orphanManual, { operationCount: 10, gapMs: 10_000 });
  assert.equal(ready(orphanManual, manualCadence.lastActivityMs + 91_000).length, 0,
    "manual takeover must not be racing a cadence-created orphan generation because that authority no longer exists");
  runtime.continuationTask({ action: "status", taskId: orphanManual.taskId, manualTakeover: true });
  assert.equal(status(orphanManual).assistantTurnOwner, "manual");
  for (const mode of ["resident", "completion-driven"]) {
    const f = fixture(mode);
    work(f);
    const signed = runtime.continuationTask({ action: "turn-complete", taskId: f.taskId });
    assert.equal(signed.accepted, true, JSON.stringify(signed));
    assert.equal(ready(f).length, 1, "completion intent can pre-arm one generation");
    const claim = runtime.claimReadyContinuationGeneration(f.sender);
    assert.equal(claim.accepted, true);
    const args = { ...f.sender, deliveryToken: claim.deliveryToken };
    assert.equal(runtime.authorizeContinuationGenerationDelivery(args).accepted, false, "handoff grace blocks early delivery");
    ageIntent(f);
    assert.equal(runtime.authorizeContinuationGenerationDelivery(args).accepted, true);
  }
  const active = fixture();
  work(active);
  runtime.trackContinuationActivityProcess({ conversationScopeId: active.scope, processHandle: "training", running: false });
  assert.equal(status(active).assistantTurnState, "GENERATING");
  assert.equal(ready(active, Date.now() + 3600_000).length, 0, "process completion cannot interrupt reasoning");
  assert.equal(runtime.continuationTask({ action: "stage-complete", taskId: active.taskId,
    coordinatorInstanceId: active.sender.senderInstanceId }).accepted, false, "UI cannot sign model completion");
  const revoked = fixture();
  work(revoked);
  runtime.continuationTask({ action: "turn-complete", taskId: revoked.taskId });
  assert.equal(ready(revoked).length, 1);
  work(revoked);
  assert.equal(status(revoked).assistantTurnState, "GENERATING");
  assert.equal(runtime.claimReadyContinuationGeneration(revoked.sender).accepted, false, "new work revokes pre-armed READY");
  const manual = fixture();
  assert.equal(timeout(manual).accepted, true);
  assert.equal(ready(manual).length, 1);
  const claimed = runtime.claimReadyContinuationGeneration(manual.sender);
  assert.equal(claimed.accepted, true);
  runtime.continuationTask({ action: "status", taskId: manual.taskId, manualTakeover: true });
  assert.equal(runtime.authorizeContinuationGenerationDelivery({ ...manual.sender,
    deliveryToken: claimed.deliveryToken }).accepted, false, "manual takeover fences an already claimed generation");
  const waiting = fixture();
  work(waiting);
  runtime.continuationTask({ action: "checkpoint", taskId: waiting.taskId, waitingExternal: true,
    evidence: { process: "training" }, note: "Wait for the monitored result" });
  assert.ok(runtime.continuationActivityProcessGuards().some(g => g.taskId === waiting.taskId),
    "server must monitor waiting tasks without an iframe");
  ageIntent(waiting);
  runtime.trackContinuationActivityProcess({ conversationScopeId: waiting.scope, processHandle: "training", running: false });
  assert.equal(ready(waiting).length, 1, "explicit wait + completed process must resume without an iframe");
  assert.equal(ready(waiting).length, 0);
  deliver(waiting);
  for (const receipt of ["rejected", "failed", "unknown", "accepted", "fallback-accepted"]) {
    const f = fixture();
    assert.equal(timeout(f).accepted, true);
    assert.equal(ready(f).length, 1);
    const ack = deliver(f);
    work(f);
    const token = runtime.database.sqlite.prepare(`select g.delivery_token from continuation_generations g
      join continuation_worksets w on w.id=g.workset_id where w.legacy_task_id=?
      and g.owner_type=\'synthetic\' order by g.generation desc limit 1`).get(f.taskId)?.delivery_token;
    assert.ok(token, "the delayed receipt must carry the original authorized generation token");
    const taskBefore = runtime.database.sqlite.prepare("select * from continuation_tasks where id=?").get(f.taskId);
    const generationBefore = runtime.database.sqlite.prepare("select * from continuation_generations where delivery_token=?").get(token);
    const late = runtime.recordContinuationGenerationDelivery({ deliveryToken: token,
      result: receipt, method: "ui/message", note: "late transport settlement after real model ACK" });
    assert.equal(late.accepted, true, `late ${receipt} must be handled idempotently`);
    assert.deepEqual(runtime.database.sqlite.prepare("select * from continuation_tasks where id=?").get(f.taskId), taskBefore,
      `late ${receipt} must not alter a model turn already acknowledged and working`);
    assert.deepEqual(runtime.database.sqlite.prepare("select * from continuation_generations where delivery_token=?").get(token), generationBefore,
      `late ${receipt} must not downgrade an acknowledged generation`);
    runtime.continuationTask({ action: "status", taskId: f.taskId, manualTakeover: true });
    const manualBefore = runtime.database.sqlite.prepare("select * from continuation_tasks where id=?").get(f.taskId);
    const supersededBefore = runtime.database.sqlite.prepare("select * from continuation_generations where delivery_token=?").get(token);
    runtime.recordContinuationGenerationDelivery({ deliveryToken: token,
      result: receipt, method: "ui/message", note: "late settlement after manual takeover" });
    assert.deepEqual(runtime.database.sqlite.prepare("select * from continuation_tasks where id=?").get(f.taskId), manualBefore);
    assert.deepEqual(runtime.database.sqlite.prepare("select * from continuation_generations where delivery_token=?").get(token), supersededBefore);
    assert.equal(ready(f).length, 0, "a stale receipt cannot create a fresh READY behind the manual turn");
  }
  console.log(JSON.stringify({ ok: true, fixtures: counter,
    residentRunningProcessSurvivesTwoSyntheticTurns: true, normalCompletionAndTimeout: true,
    manualWins: true, processCompletionDoesNotInterrupt: true, backgroundWaitWake: true,
    clusteredCutoffFallbackIsLeaseBoundAndRevocable: true,
    residentWatchedProcessDoesNotBlockCutoffRecovery: true,
    syntheticToolSilenceDoesNotAuthorizeContinuation: true,
    syntheticLateWorkRemainsSameTurn: true,
    longThinkingGapsRemainProtected: true,
    lateReceiptCannotDowngradeModelAckOrManualTakeover: true,
    liveHostAcceptance: false }, null, 2));
} finally {
  runtime.close();
  rmSync(temp, { recursive: true, force: true });
}

