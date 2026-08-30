import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const runtimePath = join(ROOT, "app", "node_modules", "@waishnav", "devspace", "dist", "runtime-state.js");
const serverSource = readFileSync(join(ROOT, "vendor", "waishnav-devspace", "dist", "server.js"), "utf8");
const runtimeSource = readFileSync(join(ROOT, "vendor", "waishnav-devspace", "dist", "runtime-state.js"), "utf8");
const coordinatorSource = readFileSync(join(ROOT, "vendor", "waishnav-devspace", "dist", "ui", "assets", "continuation-coordinator.js"), "utf8");
const { StructuredRuntimeState } = await import(pathToFileURL(runtimePath).href);

const stateDir = mkdtempSync(join(tmpdir(), "devspace-continuation-architecture-"));
const runtime = new StructuredRuntimeState(stateDir);
const db = runtime.database.sqlite;
const scope = "v1/test-continuation-architecture";

try {
  assert.match(serverSource, /registerAppTool\(server,\s*"continuation_sender"/,
    "1.1.54 must register a dedicated continuation_sender bridge");
  assert.match(serverSource, /ui:\s*\{\s*visibility:\s*\["app"\]/s,
    "continuation_sender metadata must support app-only visibility without a model-visible card surface");
  assert.match(coordinatorSource, /const SENDER_TOOL = "continuation_sender";/,
    "the verified card App must use the dedicated sender bridge");
  assert.match(coordinatorSource, /callSender\("claim"/,
    "Host delivery must claim a server ContinuationGeneration through the sender bridge");
  assert.match(serverSource, /z\.enum\(\["heartbeat",\s*"claim",\s*"authorize-delivery",\s*"delivery-result"\]\)/,
    "continuation_sender must expose relay heartbeat plus a final authorize-delivery phase before Host user-role transport");
  assert.match(serverSource, /"devspace\/continuation-sender": capability/,
    "ordinary UI-bearing DevSpace results must be able to inherit a hidden verified sender capability without minting another milestone card");
  assert.match(coordinatorSource, /function senderCapabilityFromResult\(params\)[\s\S]*?devspace\/continuation-sender/,
    "the Workspace App coordinator must parse hidden inherited sender capability from ordinary UI-bearing tool results");
  assert.match(coordinatorSource, /function activeSenderCapability\(\)[\s\S]*?state\.senderCapability[\s\S]*?state\.anchorSurface[\s\S]*?return undefined;/,
    "sender transport selection must prefer inherited sender capability while retaining the verified anchor surface only as a transport fallback");
  assert.match(coordinatorSource, /function senderTransportAvailable\(\)\s*\{\s*return Boolean\(state\.connected && state\.task\?\.anchorMountVerifiedAt && activeSenderCapability\(\)\);\s*\}/,
    "sender availability must depend on a verified conversation card plus an active transport capability, not on visible anchor-card identity");
  assert.match(coordinatorSource, /callSender\("heartbeat"/,
    "a transport-only DevSpace App must renew sender liveness through the app-only bridge rather than pretending to be the anchor coordinator");
  assert.match(runtimeSource, /beginContinuationModelRequest[\s\S]{0,1800}continuationModelRequestInFlight/,
    "the runtime must explicitly track model-originated DevSpace requests so a long command cannot look like an ended assistant turn");
  assert.match(runtimeSource, /COMPLETION_QUIET_RECOVERY_MS = 120_000/,
    "silent-turn recovery must use a conservative server-side quiet backstop instead of the old short iframe heuristic");
  assert.match(coordinatorSource, /callSender\("claim"[\s\S]{0,3500}updateModelContext[\s\S]{0,2200}callSender\("authorize-delivery"[\s\S]{0,1600}sendFollowUp\(visibleContinuationTrigger\(state\.task, deliveryToken\)\)/,
    "automatic delivery must re-authorize synthetic ownership immediately before the visible Host trigger");
  assert.match(coordinatorSource, /callSender\("delivery-result"/,
    "Host delivery results must return to the Generation FSM through the sender bridge");
  assert.doesNotMatch(coordinatorSource, /callTask\("claim-continuation"/,
    "the App delivery path must not fall back to the legacy coordinator claim API");
  assert.match(serverSource, /const continuationSupervisorTimer = setInterval\(\(\) => \{[\s\S]*?runtimeState\.continuationSupervisorSweep\(\)[\s\S]*?\},\s*5_000\);/,
    "the continuation watchdog must stay resident in the server process");
  assert.doesNotMatch(runtimeSource, /last_send_result_json/,
    "generation delivery must update the canonical continuation_tasks.last_send_result column");

  const migration = db.prepare("select max(version) as version from devspace_schema_migrations").get();
  assert.equal(Number(migration.version), 30, "1.1.54 architecture migration must be applied");
  assert.equal(db.prepare("select value from continuation_runtime_meta where key='schema_epoch'").get().value, "2");

  const expectedTables = [
    "continuation_conversation_cards",
    "continuation_worksets",
    "continuation_milestones",
    "continuation_generations",
  ];
  const tables = new Set(db.prepare("select name from sqlite_master where type='table'").all().map((row) => row.name));
  for (const table of expectedTables) assert.ok(tables.has(table), `${table} must exist`);

  const first = runtime.continuationTask({
    action: "begin",
    conversationScopeId: scope,
    workspaceId: "ws_architecture",
    continuationMode: "completion-driven",
    objective: "first workset",
    requiredMilestones: ["first-a", "first-b"],
  });
  assert.equal(first.created, true, "the first explicit begin must create the lifetime compatibility task/workset");
  assert.ok(first.task?.id);

  let snapshot = runtime.continuationArchitectureSnapshot(scope);
  assert.ok(snapshot.card, "first DevSpace work must allocate the conversation card identity");
  const stableCardId = snapshot.card.card_id;
  assert.equal(snapshot.worksets.length, 1);
  assert.equal(snapshot.worksets[0].sequence, 1);
  assert.equal(snapshot.card.active_workset_id, snapshot.worksets[0].id);
  assert.deepEqual(snapshot.milestones.map((row) => row.description), ["first-a", "first-b"]);

  const duplicateCard = db.prepare("select conversation_scope_id,count(*) as count from continuation_conversation_cards group by conversation_scope_id having count(*)!=1").all();
  assert.equal(duplicateCard.length, 0, "every persisted conversation card identity must be unique");

  assert.throws(() => db.prepare(`
    insert into continuation_worksets(
      id,conversation_scope_id,sequence,objective,state,current_generation,created_at,updated_at
    ) values('workset_illegal_second_active',?,99,'illegal','RUNNING',1,?,?)
  `).run(scope, new Date().toISOString(), new Date().toISOString()), /UNIQUE|constraint/i,
    "database partial UNIQUE must physically forbid two active worksets for one conversation");

  const mount = runtime.prepareContinuationAnchorMount({
    taskId: first.task.id,
    conversationScopeId: scope,
  });
  assert.ok(mount.anchorMountToken);
  const mounted = runtime.continuationTask({
    action: "anchor-mounted",
    taskId: first.task.id,
    conversationScopeId: scope,
    coordinatorInstanceId: "ui_architecture_test",
    anchorMountToken: mount.anchorMountToken,
  });
  assert.equal(mounted.accepted, true);
  snapshot = runtime.continuationArchitectureSnapshot(scope);
  assert.equal(snapshot.card.mount_state, "VERIFIED");
  assert.equal(snapshot.card.card_id, stableCardId);
  assert.ok(snapshot.card.mount_token);
  assert.ok(Number(snapshot.card.mount_generation) > 0);
  const senderCapability = {
    taskId: first.task.id,
    anchorMountToken: snapshot.card.mount_token,
    anchorMountGeneration: Number(snapshot.card.mount_generation),
  };
  const inheritedSenderCapability = runtime.continuationSenderCapability({ taskId: first.task.id });
  assert.equal(inheritedSenderCapability.taskId, first.task.id);
  assert.equal(inheritedSenderCapability.conversationScopeId, scope);
  assert.equal(inheritedSenderCapability.anchorMountToken, senderCapability.anchorMountToken);
  assert.equal(inheritedSenderCapability.anchorMountGeneration, senderCapability.anchorMountGeneration,
    "a newer ordinary App relay must inherit the verified card capability without changing card identity or generation");
  const relayHeartbeat = runtime.heartbeatContinuationSender({
    conversationScopeId: scope,
    taskId: first.task.id,
    senderInstanceId: "ui_transport_relay",
    anchorMountToken: inheritedSenderCapability.anchorMountToken,
    anchorMountGeneration: inheritedSenderCapability.anchorMountGeneration,
  });
  assert.equal(relayHeartbeat.accepted, true);
  snapshot = runtime.continuationArchitectureSnapshot(scope);
  assert.equal(snapshot.card.card_id, stableCardId);
  assert.equal(snapshot.card.coordinator_instance_id, "ui_architecture_test",
    "transport relay heartbeat must never steal the unique milestone card's anchor coordinator identity");

  const checkpoint = runtime.continuationTask({
    action: "checkpoint",
    taskId: first.task.id,
    workspaceId: "ws_architecture",
    completedMilestones: ["first-a"],
    evidence: { first: "checkpoint" },
  });
  assert.equal(checkpoint.accepted, true);
  snapshot = runtime.continuationArchitectureSnapshot(scope);
  assert.equal(snapshot.milestones.find((row) => row.description === "first-a").state, "COMPLETED");
  assert.equal(snapshot.milestones.find((row) => row.description === "first-b").state, "PENDING");

  const completed = runtime.continuationTask({
    action: "complete",
    taskId: first.task.id,
    workspaceId: "ws_architecture",
    completedMilestones: ["first-b"],
    evidence: { first: "done" },
  });
  assert.equal(completed.accepted, true);
  snapshot = runtime.continuationArchitectureSnapshot(scope);
  assert.equal(snapshot.card.card_id, stableCardId, "completed work must not delete or replace the card");
  assert.equal(snapshot.card.active_workset_id, null);
  assert.equal(snapshot.worksets[0].state, "SUCCEEDED");

  const second = runtime.continuationTask({
    action: "begin",
    conversationScopeId: scope,
    workspaceId: "ws_architecture",
    continuationMode: "completion-driven",
    objective: "second workset",
    requiredMilestones: ["second-a", "second-b"],
  });
  assert.equal(second.task?.state, "RUNNING", "a new explicit begin after completion must reactivate work on the lifetime card");
  assert.equal(second.task.id, first.task.id, "legacy compatibility projection may keep the lifetime task id during 1.1.54 bridge");
  snapshot = runtime.continuationArchitectureSnapshot(scope);
  assert.equal(snapshot.card.card_id, stableCardId, "a new user task must reuse the same conversation card");
  assert.equal(snapshot.worksets.length, 2, "a new user task must create a sequential workset");
  assert.deepEqual(snapshot.worksets.map((row) => row.sequence), [1, 2]);
  const active = snapshot.worksets[1];
  assert.equal(snapshot.card.active_workset_id, active.id);
  assert.equal(active.state, "RUNNING");

  runtime.touchContinuationModelActivity({
    conversationScopeId: scope,
    workspaceId: "ws_architecture",
    substantive: true,
  });
  snapshot = runtime.continuationArchitectureSnapshot(scope);
  const activeGeneration = snapshot.generations.filter((row) => row.workset_id === active.id).at(-1);
  assert.ok(activeGeneration.substantive_activity_count >= 1,
    "substantive model activity must propagate into generation accounting");

  const past = new Date(Date.now() - 5_000).toISOString();
  db.prepare("update continuation_worksets set continuation_due_at=? where id=?").run(past, active.id);
  const firstSweep = runtime.continuationSupervisorSweep();
  assert.equal(firstSweep.ready.length, 0,
    "an expired short model-activity lease must not independently authorize a new ChatGPT turn");

  db.prepare(`
    update continuation_tasks set turn_lease_expires_at=?,last_model_activity_at=?,
      stall_state='ACTIVE',stall_suspected_at=null,stall_probe_count=0,
      stall_last_probe_at=null,stall_armed_at=null,stall_evidence=null
    where id=?
  `).run(
    new Date(Date.now() - 5_000).toISOString(),
    new Date(Date.now() - 10 * 60_000).toISOString(),
    first.task.id,
  );
  const releaseLongModelRequest = runtime.beginContinuationModelRequest(scope);
  assert.equal(runtime.continuationModelRequestInFlight(scope), true,
    "the long-command regression must explicitly model an in-flight DevSpace request rather than infer it from silence alone");
  const firstLongCommandHeartbeat = runtime.continuationTask({
    action: "heartbeat",
    taskId: first.task.id,
    coordinatorInstanceId: "ui_architecture_test",
    note: "long command still in flight",
  });
  assert.equal(firstLongCommandHeartbeat.task.stallState, "SUSPECTED_STALL",
    "an expired model-activity lease may only record a weak stall suspicion");
  db.prepare("update continuation_tasks set stall_suspected_at=? where id=?")
    .run(new Date(Date.now() - 10 * 60_000).toISOString(), first.task.id);
  const repeatedLongCommandHeartbeat = runtime.continuationTask({
    action: "heartbeat",
    taskId: first.task.id,
    coordinatorInstanceId: "ui_architecture_test",
    note: "same long command remains in flight after repeated verified-card probes",
  });
  assert.equal(repeatedLongCommandHeartbeat.task.stallState, "SUSPECTED_STALL",
    "repeated verified-card heartbeats, even after a long silence interval, must never infer assistant-turn completion");
  assert.equal(runtime.continuationSupervisorSweep().ready.length, 0,
    "even ten minutes of apparent model silence plus repeated iframe heartbeats must not create a continuation while the originating DevSpace request is still in flight");
  releaseLongModelRequest();
  assert.equal(runtime.continuationModelRequestInFlight(scope), false);
  const quietRecoverySweep = runtime.continuationSupervisorSweep();
  assert.equal(quietRecoverySweep.ready.length, 1,
    "after the real request ends, a persistently unfinished completion-driven task may recover through the conservative server-quiet backstop");
  const quietRecoveryLegacy = db.prepare("select stall_state,stall_evidence from continuation_tasks where id=?").get(first.task.id);
  assert.equal(quietRecoveryLegacy.stall_state, "CONTINUATION_ARMED");
  assert.equal(quietRecoveryLegacy.stall_evidence, "server-quiet-no-inflight-model-request");
  const quietGeneration = quietRecoverySweep.ready[0].generation;
  assert.ok(quietGeneration > activeGeneration.generation);
  db.prepare(`
    update continuation_generations set state='NO_WORK',closed_at=?,failure_reason='test-reset',updated_at=?
    where workset_id=? and generation=?
  `).run(new Date().toISOString(), new Date().toISOString(), active.id, quietGeneration);
  db.prepare(`
    update continuation_tasks set stall_state='ACTIVE',stall_armed_at=null,stall_evidence=null,
      last_model_activity_at=?,turn_lease_expires_at=?,continuation_pending=0 where id=?
  `).run(new Date().toISOString(), new Date(Date.now() + 60_000).toISOString(), first.task.id);
  db.prepare("update continuation_worksets set state='RUNNING',continuation_due_at=? where id=?")
    .run(new Date(Date.now() - 1000).toISOString(), active.id);

  db.prepare("update continuation_tasks set stall_state='CONTINUATION_ARMED',continuation_pending=0 where id=?")
    .run(first.task.id);
  const armedSweep = runtime.continuationSupervisorSweep();
  assert.equal(armedSweep.ready.length, 1,
    "resident supervisor must create a READY generation only after independent Host/lifecycle stall authorization");
  const syntheticGeneration = armedSweep.ready[0].generation;
  assert.ok(syntheticGeneration > activeGeneration.generation);
  assert.equal(runtime.continuationSupervisorSweep().ready.length, 0,
    "repeated watchdog sweeps must not create duplicate READY generations");

  const missingCapability = runtime.claimReadyContinuationGeneration({
    conversationScopeId: scope,
    senderInstanceId: "sender-missing-capability",
  });
  assert.equal(missingCapability.accepted, false);
  assert.equal(missingCapability.reason, "sender-capability-required");

  const wrongMountToken = runtime.claimReadyContinuationGeneration({
    conversationScopeId: scope,
    senderInstanceId: "sender-wrong-token",
    ...senderCapability,
    anchorMountToken: "00000000-0000-4000-8000-000000000000",
  });
  assert.equal(wrongMountToken.accepted, false);
  assert.equal(wrongMountToken.reason, "sender-mount-token-mismatch");

  const wrongMountGeneration = runtime.claimReadyContinuationGeneration({
    conversationScopeId: scope,
    senderInstanceId: "sender-wrong-generation",
    ...senderCapability,
    anchorMountGeneration: senderCapability.anchorMountGeneration + 1,
  });
  assert.equal(wrongMountGeneration.accepted, false);
  assert.equal(wrongMountGeneration.reason, "sender-mount-generation-mismatch");

  const senderA = runtime.claimReadyContinuationGeneration({
    conversationScopeId: scope,
    senderInstanceId: "sender-a",
    ...senderCapability,
  });
  assert.equal(senderA.accepted, true);
  assert.ok(senderA.deliveryToken);
  let legacyTask = db.prepare("select * from continuation_tasks where id=?").get(first.task.id);
  assert.equal(legacyTask.delivery_token, senderA.deliveryToken,
    "the delivery token must be mirrored before app.sendMessage so a fast resumed turn can ACK it immediately");
  assert.equal(legacyTask.delivery_owner, "synthetic-pending");
  assert.equal(Number(legacyTask.continuation_pending), 5);

  const senderB = runtime.claimReadyContinuationGeneration({
    conversationScopeId: scope,
    senderInstanceId: "sender-b",
    ...senderCapability,
  });
  assert.equal(senderB.accepted, false, "CAS claim must allow only one sender/tab to own a generation");
  assert.equal(senderB.reason, "no-ready-generation");

  db.prepare("update continuation_generations set due_at=? where delivery_token=?")
    .run(past, senderA.deliveryToken);
  db.prepare("update continuation_worksets set continuation_due_at=? where id=?")
    .run(past, active.id);
  const senderCrashSweep = runtime.continuationSupervisorSweep();
  assert.equal(senderCrashSweep.ready.length, 1,
    "a claimed sender that disappears before Host delivery must expire and produce a new READY generation");
  const expiredClaim = db.prepare("select state,failure_reason from continuation_generations where delivery_token=?").get(senderA.deliveryToken);
  assert.equal(expiredClaim.state, "NO_WORK");
  assert.equal(expiredClaim.failure_reason, "sender-claim-expired");
  legacyTask = db.prepare("select * from continuation_tasks where id=?").get(first.task.id);
  assert.equal(legacyTask.delivery_token, null);

  const senderRetry = runtime.claimReadyContinuationGeneration({
    conversationScopeId: scope,
    senderInstanceId: "sender-retry",
    ...senderCapability,
  });
  assert.equal(senderRetry.accepted, true);
  assert.ok(senderRetry.deliveryToken);

  const retryAuthorization = runtime.authorizeContinuationGenerationDelivery({
    conversationScopeId: scope,
    senderInstanceId: "sender-retry",
    deliveryToken: senderRetry.deliveryToken,
    ...senderCapability,
  });
  assert.equal(retryAuthorization.accepted, true,
    "a claimed verified sender must pass a final server-side ownership gate immediately before Host delivery");
  let authorizedRow = db.prepare("select state from continuation_generations where delivery_token=?").get(senderRetry.deliveryToken);
  assert.equal(authorizedRow.state, "DELIVERING");

  db.prepare("update continuation_generations set due_at=? where delivery_token=?")
    .run(past, senderRetry.deliveryToken);
  db.prepare("update continuation_worksets set continuation_due_at=? where id=?")
    .run(past, active.id);
  const deliveryCrashSweep = runtime.continuationSupervisorSweep();
  assert.equal(deliveryCrashSweep.ready.length, 1,
    "an authorized sender that disappears before reporting Host delivery must expire and remain retryable");
  const expiredDelivery = db.prepare("select state,failure_reason from continuation_generations where delivery_token=?").get(senderRetry.deliveryToken);
  assert.equal(expiredDelivery.state, "NO_WORK");
  assert.equal(expiredDelivery.failure_reason, "sender-delivery-expired");

  const senderDelivered = runtime.claimReadyContinuationGeneration({
    conversationScopeId: scope,
    senderInstanceId: "sender-delivered",
    ...senderCapability,
  });
  assert.equal(senderDelivered.accepted, true);
  assert.ok(senderDelivered.deliveryToken);
  const deliveredAuthorization = runtime.authorizeContinuationGenerationDelivery({
    conversationScopeId: scope,
    senderInstanceId: "sender-delivered",
    deliveryToken: senderDelivered.deliveryToken,
    ...senderCapability,
  });
  assert.equal(deliveredAuthorization.accepted, true);

  const delivered = runtime.recordContinuationGenerationDelivery({
    deliveryToken: senderDelivered.deliveryToken,
    result: "accepted",
    method: "app.sendMessage",
  });
  assert.equal(delivered.accepted, true);
  assert.equal(delivered.generation.state, "WORK_REQUIRED");

  const syntheticAck = runtime.continuationTask({
    action: "status",
    taskId: first.task.id,
    conversationScopeId: scope,
    workspaceId: "ws_architecture",
    deliveryToken: senderDelivered.deliveryToken,
  });
  assert.equal(syntheticAck.accepted, true);
  assert.equal(syntheticAck.reason, "continuation-resume-acknowledged");
  assert.equal(syntheticAck.task.deliveryOwner, "synthetic-active");

  db.prepare("update continuation_generations set due_at=? where delivery_token=?")
    .run(past, senderDelivered.deliveryToken);
  db.prepare("update continuation_worksets set continuation_due_at=? where id=?")
    .run(past, active.id);
  const noWorkSweep = runtime.continuationSupervisorSweep();
  assert.equal(noWorkSweep.ready.length, 1,
    "a delivered synthetic turn that performs no substantive work must immediately create the next recovery generation after its short deadline");
  const oldSynthetic = db.prepare("select state,failure_reason from continuation_generations where delivery_token=?").get(senderDelivered.deliveryToken);
  assert.equal(oldSynthetic.state, "NO_WORK");
  assert.equal(oldSynthetic.failure_reason, "synthetic-no-substantive-work");

  const rejectedSender = runtime.claimReadyContinuationGeneration({
    conversationScopeId: scope,
    senderInstanceId: "sender-rejected",
    ...senderCapability,
  });
  assert.equal(rejectedSender.accepted, true);
  const rejectedAuthorization = runtime.authorizeContinuationGenerationDelivery({
    conversationScopeId: scope,
    senderInstanceId: "sender-rejected",
    deliveryToken: rejectedSender.deliveryToken,
    ...senderCapability,
  });
  assert.equal(rejectedAuthorization.accepted, true);
  const rejectedDelivery = runtime.recordContinuationGenerationDelivery({
    deliveryToken: rejectedSender.deliveryToken,
    result: "rejected",
    method: "app.sendMessage",
    note: "test rejection",
  });
  assert.equal(rejectedDelivery.accepted, true);
  assert.equal(rejectedDelivery.retryRequired, true);
  const rejectedRow = db.prepare("select state,failure_reason from continuation_generations where delivery_token=?").get(rejectedSender.deliveryToken);
  assert.equal(rejectedRow.state, "NO_WORK");
  assert.equal(rejectedRow.failure_reason, "delivery-rejected");
  legacyTask = db.prepare("select stall_state,stall_armed_at,stall_evidence,delivery_token,continuation_pending from continuation_tasks where id=?").get(first.task.id);
  assert.equal(legacyTask.delivery_token, null);
  assert.equal(Number(legacyTask.continuation_pending), 0);
  assert.equal(legacyTask.stall_state, "CONTINUATION_ARMED",
    "a rejected Host transport must durably re-arm continuation instead of depending on another model/UI request");
  assert.ok(legacyTask.stall_armed_at);
  assert.equal(legacyTask.stall_evidence, "host-delivery-rejected");
  const rejectedRetrySweep = runtime.continuationSupervisorSweep();
  assert.equal(rejectedRetrySweep.ready.length, 1,
    "a Host delivery rejection must remain retryable without requiring a fresh model request");

  const raceSender = runtime.claimReadyContinuationGeneration({
    conversationScopeId: scope,
    senderInstanceId: "sender-manual-race",
    ...senderCapability,
  });
  assert.equal(raceSender.accepted, true);
  assert.ok(raceSender.deliveryToken);
  const manualTakeover = runtime.continuationTask({
    action: "status",
    taskId: first.task.id,
    conversationScopeId: scope,
    workspaceId: "ws_architecture",
  });
  assert.equal(manualTakeover.accepted, true);
  assert.equal(manualTakeover.reason, "manual-turn-took-over");
  const staleAuthorization = runtime.authorizeContinuationGenerationDelivery({
    conversationScopeId: scope,
    senderInstanceId: "sender-manual-race",
    deliveryToken: raceSender.deliveryToken,
    ...senderCapability,
  });
  assert.equal(staleAuthorization.accepted, false,
    "manual user work must revoke a claimed synthetic sender before app.sendMessage can enqueue a stale continuation");
  assert.equal(staleAuthorization.reason, "synthetic-ownership-superseded");
  const supersededRace = db.prepare("select state,failure_reason from continuation_generations where delivery_token=?").get(raceSender.deliveryToken);
  assert.equal(supersededRace.state, "SUPERSEDED");
  assert.equal(supersededRace.failure_reason, "manual-turn-took-over");

  const cardInvariantRows = db.prepare(`
    select conversation_scope_id,count(*) as count
    from continuation_conversation_cards
    group by conversation_scope_id having count(*) != 1
  `).all();
  const activeWorksetInvariantRows = db.prepare(`
    select conversation_scope_id,count(*) as count
    from continuation_worksets
    where state in ('RUNNING','WAITING_EXTERNAL','SUSPECTED_STALL')
    group by conversation_scope_id having count(*) > 1
  `).all();
  assert.equal(cardInvariantRows.length, 0);
  assert.equal(activeWorksetInvariantRows.length, 0);

  console.log("PASS: continuation card/workset/milestone/generation architecture");
} finally {
  runtime.close();
  rmSync(stateDir, { recursive: true, force: true });
}
