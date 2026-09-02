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
  assert.match(serverSource, /z\.enum\(\["bind",\s*"heartbeat",\s*"claim",\s*"authorize-delivery",\s*"delivery-result"\]\)/,
    "continuation_sender must expose context-derived bind, relay heartbeat, and final authorize-delivery before Host user-role transport");
  assert.match(serverSource, /function enablePortableContinuationAnchorRenderer[\s\S]{0,1200}continuation_anchor[\s\S]{0,800}open_workspace/,
    "the Portable server must adapt the upstream Workspace App renderer so continuation_anchor is a real visible result card instead of an ACK-only ghost iframe");
  assert.match(serverSource, /openAiConversationScopeId\(context\?\._meta\)[\s\S]{0,900}input\.action === "bind"[\s\S]{0,700}bindContinuationSender/,
    "sender bind must derive the real conversation scope from the authenticated App call context rather than trust Host-forwarded result metadata");
  assert.match(serverSource, /claimedConversationScopeId:\s*input\.conversationScopeId[\s\S]{0,220}anchorMountGeneration:\s*input\.anchorMountGeneration/,
    "sender bind must forward the verified task/card fallback when the Host strips App call conversation metadata");
  assert.match(coordinatorSource, /async function bindSenderTransport\([\s\S]{0,900}action:\s*"bind"/,
    "every current Workspace App transport must be able to bind sender authority directly even if Host strips custom tool-result _meta");
  assert.match(runtimeSource, /bindContinuationSender\(input = \{\}\)[\s\S]{0,3600}sender_instance_id/,
    "runtime state must persist the currently bound sender independently of the immutable visible card identity");
  assert.match(runtimeSource, /bindContinuationSender\(input = \{\}\)[\s\S]{0,5200}state='READY'[\s\S]{0,1200}readyGeneration/,
    "sender bind must reveal a durable READY generation to the newly bound ordinary App transport");
  assert.match(coordinatorSource, /async function consumeReadyAfterSenderBind\([\s\S]{0,1300}readyGeneration[\s\S]{0,800}attemptContinuation\(reason, \{ force: true \}\)/,
    "a current ordinary Workspace App must consume READY immediately after sender rebind instead of waiting for the old milestone iframe");
  assert.match(serverSource, /"devspace\/continuation-sender": capability/,
    "ordinary UI-bearing DevSpace results must be able to inherit a hidden verified sender capability without minting another milestone card");
  assert.match(coordinatorSource, /function senderCapabilityFromResult\(params\)[\s\S]*?devspace\/continuation-sender/,
    "the Workspace App coordinator must parse hidden inherited sender capability from ordinary UI-bearing tool results");
  assert.match(coordinatorSource, /function activeSenderCapability\(\)[\s\S]*?state\.senderCapability[\s\S]*?state\.anchorSurface[\s\S]*?return undefined;/,
    "sender transport selection must prefer inherited sender capability while retaining the verified anchor surface only as a transport fallback");
  assert.match(coordinatorSource, /function senderTransportAvailable\(\)[\s\S]{0,500}anchorMountRequestedAt[\s\S]{0,240}activeSenderCapability\(\)/,
    "sender availability must start from the single issued card capability even when iframe verification is delayed");
  assert.match(coordinatorSource, /callSender\("heartbeat"/,
    "a transport-only DevSpace App must renew sender liveness through the app-only bridge rather than pretending to be the anchor coordinator");
  assert.match(runtimeSource, /beginContinuationModelRequest[\s\S]{0,1800}continuationModelRequestInFlight/,
    "the runtime must explicitly track model-originated DevSpace requests so a long command cannot look like an ended assistant turn");
  assert.doesNotMatch(serverSource, /continuationDeliveryToken:\s*z\.string\(\)/,
    "ordinary DevSpace tool schemas must never expose a synthetic delivery token that their real MCP contracts do not accept");
  assert.match(serverSource, /continuationModelToolAuthorization\([\s\S]{0,1200}turn-ownership precondition blocked/,
    "manual/synthetic ownership must be checked before the requested tool handler can run");
  assert.match(runtimeSource, /continuationModelToolAuthorization\(input = \{\}\)[\s\S]{0,4200}turn-origin-handshake-required/,
    "runtime ownership authorization must fail closed without guessing whether an ambiguous request is manual or synthetic");
  assert.match(serverSource, /manualTakeover:\s*z\.boolean\(\)\.optional\(\)/,
    "manual takeover must be an explicit status CAS marker instead of being inferred from a missing synthetic token");
  assert.match(serverSource, /manual user turn that races a READY or active automatic generation sets manualTakeover=true/,
    "the capabilities guidance must teach the same explicit manual takeover handshake as the tool schema");
  assert.match(runtimeSource, /String\(input\.note \?\? ""\)\.trim\(\) === "manual-user-turn-takeover"/,
    "already-open Hosts with a cached old continuation_task schema must retain a narrow note-field manual takeover CAS");
  assert.match(serverSource, /older cached schema without manualTakeover[\s\S]{0,500}manual-user-turn-takeover/,
    "server guidance must teach the old-schema takeover compatibility marker only for manual turns");
  assert.doesNotMatch(serverSource, /manual user turn omits it so the server atomically supersedes/,
    "stale implicit manual takeover guidance must not survive beside the fail-closed runtime contract");
  assert.match(runtimeSource, /synthetic-generation-lease-authorized[\s\S]{0,500}deliveryGeneration[\s\S]{0,300}turnLeaseId/,
    "ordinary tools must inherit a persisted server-owned generation lease after the one-time status claim");
  assert.doesNotMatch(coordinatorSource, /continuationDeliveryToken|syntheticDeliveryToken|DevSpace resume token/,
    "neither the visible synthetic message nor hidden context may ask the model to transport generation UUIDs");
  assert.match(runtimeSource, /COMPLETION_QUIET_RECOVERY_MS = 40_000/,
    "legacy rows without a usable turn lease must recover inside the one-minute ceiling");
  assert.match(runtimeSource, /COMPLETION_STALL_SUSPECT_MS = 25_000/,
    "the primary completion-driven inactivity lease must remain below the one-minute ceiling");
  assert.match(runtimeSource, /COMPLETION_STALL_CONFIRM_MS = 10_000/,
    "completion-driven recovery must use a second server-side confirmation window while remaining below one minute");
  assert.match(runtimeSource, /DELIVERY_ACK_RETRY_MAX_MS = 45_000/,
    "unacknowledged Host delivery must never back off beyond one minute");
  assert.match(runtimeSource, /server-turn-lease-expired-no-inflight-model-request[\s\S]{0,2600}server-turn-lease-confirmed-no-inflight-model-request/,
    "the resident supervisor must recover through a two-stage lease path without requiring a surviving Anchor iframe");
  assert.match(coordinatorSource, /callSender\("claim"[\s\S]{0,4200}updateModelContext[\s\S]{0,2600}callSender\("authorize-delivery"[\s\S]{0,2200}sendFollowUp\(visibleContinuationTrigger\(state\.task\),\s*async \(\) =>/,
    "automatic delivery must re-authorize synthetic ownership immediately before the visible Host trigger");
  assert.match(coordinatorSource, /authorize-delivery[\s\S]{0,1800}sendFollowUp\(visibleContinuationTrigger\(state\.task\),\s*async \(\) => \{[\s\S]{0,900}callTask\("status"\)/,
    "the coordinator must re-read authoritative terminal state inside the final Host-send barrier after delivery authorization");
  assert.match(coordinatorSource, /function startSupervisor\(\)[\s\S]{0,700}terminal\(state\.task\)/,
    "terminal tasks must not retain a retry or quiet-probe supervisor timer");
  assert.match(runtimeSource, /closeTerminalContinuationArtifacts\(taskId[\s\S]{0,4200}state='NO_WORK'[\s\S]{0,2600}delivery_token=null[\s\S]{0,1600}stall_armed_at=null/,
    "terminal transitions must seal live synthetic generations and clear retry/delivery/quiet-recovery latches");
  assert.match(coordinatorSource, /callSender\("delivery-result"/,
    "Host delivery results must return to the Generation FSM through the sender bridge");
  assert.doesNotMatch(coordinatorSource, /callTask\("claim-continuation"/,
    "the App delivery path must not fall back to the legacy coordinator claim API");
  assert.match(serverSource, /const continuationSupervisorTimer = setInterval\(\(\) => \{[\s\S]*?runtimeState\.continuationSupervisorSweep\(\)[\s\S]*?\},\s*5_000\);/,
    "the continuation watchdog must stay resident in the server process");
  assert.doesNotMatch(runtimeSource, /last_send_result_json/,
    "generation delivery must update the canonical continuation_tasks.last_send_result column");

  const migration = db.prepare("select max(version) as version from devspace_schema_migrations").get();
  assert.equal(Number(migration.version), 31, "1.1.56 continuation runtime reset migration must be applied");
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
  snapshot = runtime.continuationArchitectureSnapshot(scope);
  assert.equal(snapshot.card.mount_state, "REQUESTED",
    "issuing the single card must persist REQUESTED before any iframe ACK");
  const pendingStatus = runtime.continuationTask({
    action: "status",
    taskId: first.task.id,
    conversationScopeId: scope,
  });
  assert.equal(pendingStatus.task.anchorMountVerificationPending, true);
  const pendingCapability = runtime.continuationSenderCapability({ taskId: first.task.id });
  assert.ok(pendingCapability,
    "the issued card must provide sender capability before iframe ACK so a later App relay can recover transport");
  assert.equal(pendingCapability.anchorMountToken, mount.anchorMountToken);
  assert.equal(pendingCapability.anchorMountGeneration, mount.anchorMountGeneration);
  assert.equal(pendingCapability.anchorMountVerified, false);
  const pendingBind = runtime.bindContinuationSender({
    claimedConversationScopeId: scope,
    taskId: first.task.id,
    senderInstanceId: "ui_pending_transport",
    anchorMountGeneration: mount.anchorMountGeneration,
  });
  assert.equal(pendingBind.accepted, true,
    "a trusted App relay must bind the already-issued generation without fabricating an iframe ACK or second card");
  assert.equal(runtime.continuationModelToolAuthorization({ conversationScopeId: scope }).accepted, true,
    "pending iframe ACK must not block substantive model tools after the one card has been issued");
  const pendingHeartbeat = runtime.heartbeatContinuationSender({
    conversationScopeId: scope,
    taskId: first.task.id,
    senderInstanceId: "ui_pending_transport",
    anchorMountToken: mount.anchorMountToken,
    anchorMountGeneration: mount.anchorMountGeneration,
  });
  assert.equal(pendingHeartbeat.accepted, true,
    "the requested-but-unverified card must sustain sender heartbeat through a trusted App relay");
  const pendingArmAt = new Date().toISOString();
  db.prepare(`
    update continuation_tasks set stall_state='CONTINUATION_ARMED',stall_armed_at=?,
      stall_evidence='pending-anchor-transport-test',continuation_pending=0,
      delivery_token=null,delivery_owner='manual',delivery_owner_expires_at=null,updated_at=?
    where id=?
  `).run(pendingArmAt, pendingArmAt, first.task.id);
  db.prepare(`
    update continuation_worksets set state='RUNNING',continuation_due_at=?,updated_at=?
    where id=(select active_workset_id from continuation_conversation_cards where conversation_scope_id=?)
  `).run(pendingArmAt, pendingArmAt, scope);
  const pendingReady = runtime.continuationSupervisorSweep();
  assert.equal(pendingReady.ready.length, 1,
    "the resident supervisor must be able to create a generation while iframe ACK is pending");
  const pendingClaim = runtime.claimReadyContinuationGeneration({
    conversationScopeId: scope,
    taskId: first.task.id,
    senderInstanceId: "ui_pending_transport",
    anchorMountToken: mount.anchorMountToken,
    anchorMountGeneration: mount.anchorMountGeneration,
  });
  assert.equal(pendingClaim.accepted, true,
    "a trusted App relay must claim the server-owned automatic generation before iframe ACK");
  const pendingDelivery = runtime.authorizeContinuationGenerationDelivery({
    conversationScopeId: scope,
    taskId: first.task.id,
    senderInstanceId: "ui_pending_transport",
    anchorMountToken: mount.anchorMountToken,
    anchorMountGeneration: mount.anchorMountGeneration,
    deliveryToken: pendingClaim.deliveryToken,
  });
  assert.equal(pendingDelivery.accepted, true,
    "missing iframe ACK must not block final automatic delivery authorization for the issued card generation");
  const pendingRejected = runtime.recordContinuationGenerationDelivery({
    deliveryToken: pendingClaim.deliveryToken,
    result: "failed",
    method: "pending-anchor-test",
  });
  assert.equal(pendingRejected.accepted, true,
    "the pending-anchor delivery fixture must release its synthetic generation before the verified-card tests continue");
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
  const wrongFallbackBind = runtime.bindContinuationSender({
    claimedConversationScopeId: scope,
    taskId: first.task.id,
    senderInstanceId: "ui_wrong_generation",
    anchorMountGeneration: inheritedSenderCapability.anchorMountGeneration + 1,
  });
  assert.equal(wrongFallbackBind.accepted, false);
  assert.equal(wrongFallbackBind.reason, "verified-card-generation-mismatch",
    "an App call without authenticated Host scope must not bind a stale or fabricated card generation");
  const fallbackBind = runtime.bindContinuationSender({
    claimedConversationScopeId: scope,
    taskId: first.task.id,
    senderInstanceId: "ui_transport_relay",
    anchorMountGeneration: inheritedSenderCapability.anchorMountGeneration,
  });
  assert.equal(fallbackBind.accepted, true,
    "a current ordinary DevSpace App must recover sender transport from its exact verified task/card result even when Host call metadata omits conversation scope");
  assert.equal(fallbackBind.anchorMountToken, inheritedSenderCapability.anchorMountToken);
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
  assert.equal(snapshot.card.sender_instance_id, "ui_transport_relay",
    "transport relay bind must move only sender ownership, independently of immutable card identity");

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

  const durableProcessGuard = runtime.trackContinuationActivityProcess({
    conversationScopeId: scope,
    processHandle: "architecture-long-process",
    running: true,
  });
  assert.equal(durableProcessGuard.accepted, true);
  assert.deepEqual(durableProcessGuard.handles, ["architecture-long-process"]);
  db.prepare(`
    update continuation_tasks set turn_lease_expires_at=?,last_model_activity_at=?,
      stall_state='SUSPECTED_STALL',stall_suspected_at=?
    where id=?
  `).run(
    new Date(Date.now() - 60_000).toISOString(),
    new Date(Date.now() - 10 * 60_000).toISOString(),
    new Date(Date.now() - 60_000).toISOString(),
    first.task.id,
  );
  assert.equal(runtime.continuationSupervisorSweep().ready.length, 0,
    "a durable completion-driven process guard must suppress READY even after both lease and confirmation windows have expired");
  assert.equal(runtime.continuationActivityProcessGuards().length, 1,
    "the resident server must be able to discover persisted completion-driven process guards after the originating tool call returns");
  const releasedProcessGuard = runtime.trackContinuationActivityProcess({
    conversationScopeId: scope,
    processHandle: "architecture-long-process",
    running: false,
  });
  assert.equal(releasedProcessGuard.accepted, true);
  assert.deepEqual(releasedProcessGuard.handles, []);
  assert.equal(runtime.continuationActivityProcessGuards().length, 0,
    "a completed durable process must release the guard so ordinary lease recovery can resume");

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
    "after the real request ends, a persistently suspected completion-driven task may recover through the server-side lease confirmation path");
  const quietRecoveryLegacy = db.prepare("select stall_state,stall_evidence from continuation_tasks where id=?").get(first.task.id);
  assert.equal(quietRecoveryLegacy.stall_state, "CONTINUATION_ARMED");
  assert.equal(quietRecoveryLegacy.stall_evidence, "server-turn-lease-confirmed-no-inflight-model-request");
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

  const preAckManualTool = runtime.continuationModelToolAuthorization({ conversationScopeId: scope });
  assert.equal(preAckManualTool.accepted, false,
    "a manual-looking tool call must be blocked before execution while a synthetic delivery owns the turn");
  assert.equal(preAckManualTool.reason, "turn-origin-handshake-required");
  const preAckSyntheticTool = runtime.continuationModelToolAuthorization({ conversationScopeId: scope });
  assert.equal(preAckSyntheticTool.accepted, false,
    "ordinary work must not bypass the first server-owned status/readiness claim");
  assert.equal(preAckSyntheticTool.reason, "turn-origin-handshake-required");

  const syntheticAck = runtime.continuationTask({
    action: "status",
    taskId: first.task.id,
    conversationScopeId: scope,
    workspaceId: "ws_architecture",
  });
  assert.equal(syntheticAck.accepted, true, JSON.stringify(syntheticAck));
  assert.equal(syntheticAck.reason, "server-owned-expected-generation-claimed");
  assert.equal(syntheticAck.task.deliveryOwner, "synthetic-active");
  assert.equal(syntheticAck.task.deliveryToken, undefined,
    "the one-time delivery capability must be consumed from Task state immediately after claim");
  const claimedGeneration = db.prepare("select state from continuation_generations where delivery_token=?").get(senderDelivered.deliveryToken);
  assert.equal(claimedGeneration.state, "TURN_ACKED",
    "the generation FSM must persist the server-owned expected-turn claim");
  const authorizedSyntheticTool = runtime.continuationModelToolAuthorization({ conversationScopeId: scope });
  assert.equal(authorizedSyntheticTool.accepted, true,
    "after status claim, an ordinary substantive call must be authorized without a delivery token");
  assert.equal(authorizedSyntheticTool.owner, "synthetic");
  assert.equal(authorizedSyntheticTool.deliveryGeneration, senderDelivered.generation);

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

  const partialScope = "v1/synthetic-placeholder-after-one-tool";
  const partialTask = runtime.continuationTask({
    action: "begin", conversationScopeId: partialScope, workspaceId: "ws_architecture",
    continuationMode: "completion-driven", objective: "recover placeholder after one tool",
    requiredMilestones: ["keep working after the first tool"],
  });
  const partialMount = runtime.prepareContinuationAnchorMount({
    taskId: partialTask.task.id, conversationScopeId: partialScope,
  });
  runtime.continuationTask({
    action: "anchor-mounted", taskId: partialTask.task.id, conversationScopeId: partialScope,
    coordinatorInstanceId: "ui_partial_tool", anchorMountToken: partialMount.anchorMountToken,
  });
  const partialWorksetId = runtime.continuationArchitectureSnapshot(partialScope).card.active_workset_id;
  const partialNow = new Date().toISOString();
  const partialGenerationId = `generation:${partialWorksetId}:2`;
  db.prepare("update continuation_generations set state='SUPERSEDED',closed_at=?,updated_at=? where workset_id=? and owner_type='manual'")
    .run(partialNow, partialNow, partialWorksetId);
  db.prepare(`
    insert into continuation_generations(
      id,workset_id,generation,owner_type,state,due_at,delivery_token,
      substantive_baseline_count,substantive_activity_count,last_activity_at,created_at,updated_at
    ) values(?,?,2,'synthetic','WORK_REQUIRED',?,'partial-token',77,78,?,?,?)
  `).run(partialGenerationId, partialWorksetId, past, partialNow, partialNow, partialNow);
  db.prepare("update continuation_worksets set current_generation=2,continuation_due_at=?,updated_at=? where id=?")
    .run(past, partialNow, partialWorksetId);
  db.prepare(`
    update continuation_tasks set delivery_owner='synthetic-active',delivery_owner_expires_at=?,
      turn_lease_expires_at=?,delivery_work_baseline_count=77,updated_at=? where id=?
  `).run(past, past, partialNow, partialTask.task.id);
  const partialRecoverySweep = runtime.continuationSupervisorSweep();
  assert.ok(partialRecoverySweep.ready.some((entry) => entry.conversationScopeId === partialScope),
    "a synthetic turn that made one real tool call but abandoned pending milestones must get another READY generation after its dedicated work lease expires");
  const abandonedPartialGeneration = db.prepare("select state,failure_reason from continuation_generations where id=?").get(partialGenerationId);
  assert.equal(abandonedPartialGeneration.state, "NO_WORK");
  assert.equal(abandonedPartialGeneration.failure_reason, "synthetic-resume-work-lease-expired");

  const cutoffScope = "v1/confirmed-cutoff-stall-guard";
  const cutoffTask = runtime.continuationTask({
    action: "begin", conversationScopeId: cutoffScope, workspaceId: "ws_architecture",
    continuationMode: "completion-driven", objective: "respect confirmed Host cutoff",
    requiredMilestones: ["do not duplicate a long legitimate turn"],
  });
  const cutoffMount = runtime.prepareContinuationAnchorMount({ taskId: cutoffTask.task.id, conversationScopeId: cutoffScope });
  runtime.continuationTask({
    action: "anchor-mounted", taskId: cutoffTask.task.id, conversationScopeId: cutoffScope,
    coordinatorInstanceId: "ui_cutoff_guard", anchorMountToken: cutoffMount.anchorMountToken,
  });
  const cutoffWorksetId = runtime.continuationArchitectureSnapshot(cutoffScope).card.active_workset_id;
  db.prepare("update continuation_worksets set continuation_due_at=? where id=?").run(past, cutoffWorksetId);
  db.prepare(`
    update continuation_tasks set turn_lease_expires_at=?,confirmed_turn_limit_ms=1552000,
      stall_state='ACTIVE',stall_suspected_at=null where id=?
  `).run(past, cutoffTask.task.id);
  assert.equal(runtime.continuationSupervisorSweep().ready.some((entry) => entry.conversationScopeId === cutoffScope), false);
  db.prepare("update continuation_tasks set stall_state='SUSPECTED_STALL',stall_suspected_at=? where id=?")
    .run(new Date(Date.now() - 30_000).toISOString(), cutoffTask.task.id);
  assert.equal(runtime.continuationSupervisorSweep().ready.some((entry) => entry.conversationScopeId === cutoffScope), false,
    "a short activity-lease confirmation must not create a duplicate turn before the persisted ~25m52s Host cutoff");
  db.prepare("update continuation_tasks set stall_suspected_at=? where id=?")
    .run(new Date(Date.now() - 1_552_001).toISOString(), cutoffTask.task.id);
  assert.equal(runtime.continuationSupervisorSweep().ready.some((entry) => entry.conversationScopeId === cutoffScope), true,
    "the conservative generic recovery may arm only after the persisted confirmed Host cutoff has elapsed");

  const readyBeforeManualStatus = runtime.continuationModelToolAuthorization({ conversationScopeId: scope });
  assert.equal(readyBeforeManualStatus.accepted, false);
  assert.equal(readyBeforeManualStatus.reason, "turn-origin-handshake-required",
    "a READY-but-unclaimed automatic generation must block manual side effects before execution");
  const readyGenerationBeforeManualStatus = db.prepare(`
    select * from continuation_generations
    where workset_id=(select active_workset_id from continuation_conversation_cards where conversation_scope_id=?)
      and owner_type='synthetic' and state='READY'
    order by generation asc limit 1
  `).get(scope);
  assert.ok(readyGenerationBeforeManualStatus,
    "the pre-claim race fixture must contain one READY synthetic generation");
  const readyRelayBind = runtime.bindContinuationSender({
    conversationScopeId: scope,
    taskId: first.task.id,
    senderInstanceId: "ui_ready_relay",
  });
  assert.equal(readyRelayBind.accepted, true);
  assert.equal(readyRelayBind.readyGeneration, Number(readyGenerationBeforeManualStatus.generation),
    "a newly bound ordinary App must learn the already-READY generation immediately without consuming or rotating it");
  const ambiguousReadyStatus = runtime.continuationTask({
    action: "status",
    taskId: first.task.id,
    conversationScopeId: scope,
    workspaceId: "ws_architecture",
  });
  assert.equal(ambiguousReadyStatus.accepted, false,
    "a tokenless status must not be guessed to be manual while a synthetic READY generation exists");
  assert.equal(ambiguousReadyStatus.reason, "turn-origin-handshake-required");
  const stillReadyAfterAmbiguousStatus = db.prepare("select state,failure_reason from continuation_generations where id=?")
    .get(readyGenerationBeforeManualStatus.id);
  assert.equal(stillReadyAfterAmbiguousStatus.state, "READY",
    "an auto-resumed model that forgets deliveryToken must not supersede its own READY generation");
  assert.equal(stillReadyAfterAmbiguousStatus.failure_reason, null);
  const readyManualTakeover = runtime.continuationTask({
    action: "status",
    taskId: first.task.id,
    conversationScopeId: scope,
    workspaceId: "ws_architecture",
    note: "manual-user-turn-takeover",
  });
  assert.equal(readyManualTakeover.accepted, true);
  assert.equal(readyManualTakeover.reason, "manual-turn-took-over-ready-generation",
    "the old-schema-compatible manual status marker must atomically win even before any sender has claimed the READY generation");
  const supersededReady = db.prepare("select state,failure_reason from continuation_generations where id=?")
    .get(readyGenerationBeforeManualStatus.id);
  assert.equal(supersededReady.state, "SUPERSEDED");
  assert.equal(supersededReady.failure_reason, "manual-turn-took-over-before-sender-claim");
  assert.equal(runtime.continuationModelToolAuthorization({ conversationScopeId: scope }).accepted, true,
    "once manual status supersedes the READY generation, untagged substantive calls may execute");

  const raceRearmAt = new Date().toISOString();
  db.prepare(`
    update continuation_tasks set stall_state='CONTINUATION_ARMED',stall_armed_at=?,
      stall_evidence='architecture-manual-race-rearm',continuation_pending=0,
      delivery_token=null,delivery_owner='manual',delivery_owner_expires_at=null,updated_at=?
    where id=?
  `).run(raceRearmAt, raceRearmAt, first.task.id);
  db.prepare(`
    update continuation_worksets set state='RUNNING',continuation_due_at=?,updated_at=?
    where id=(select active_workset_id from continuation_conversation_cards where conversation_scope_id=?)
  `).run(raceRearmAt, raceRearmAt, scope);
  const raceReadySweep = runtime.continuationSupervisorSweep();
  assert.equal(raceReadySweep.ready.length, 1,
    "the claimed-sender race fixture must create one fresh generation after the READY pre-claim takeover test");

  const raceSender = runtime.claimReadyContinuationGeneration({
    conversationScopeId: scope,
    senderInstanceId: "sender-manual-race",
    ...senderCapability,
  });
  assert.equal(raceSender.accepted, true);
  assert.ok(raceSender.deliveryToken);
  const raceBeforeStatus = runtime.continuationModelToolAuthorization({ conversationScopeId: scope });
  assert.equal(raceBeforeStatus.accepted, false);
  assert.equal(raceBeforeStatus.reason, "turn-origin-handshake-required",
    "manual side effects must be blocked until status atomically revokes a claimed automatic owner");
  const ambiguousClaimedStatus = runtime.continuationTask({
    action: "status",
    taskId: first.task.id,
    conversationScopeId: scope,
    workspaceId: "ws_architecture",
  });
  assert.equal(ambiguousClaimedStatus.accepted, false);
  assert.equal(ambiguousClaimedStatus.reason, "turn-origin-handshake-required",
    "a claimed synthetic owner must survive a tokenless ambiguous status instead of self-superseding");
  const claimedAfterAmbiguousStatus = db.prepare("select state,failure_reason from continuation_generations where delivery_token=?")
    .get(raceSender.deliveryToken);
  assert.notEqual(claimedAfterAmbiguousStatus.state, "SUPERSEDED");
  const manualTakeover = runtime.continuationTask({
    action: "status",
    taskId: first.task.id,
    conversationScopeId: scope,
    workspaceId: "ws_architecture",
    manualTakeover: true,
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
  const staleSyntheticTool = runtime.continuationModelToolAuthorization({
    conversationScopeId: scope,
    deliveryToken: raceSender.deliveryToken,
  });
  assert.equal(staleSyntheticTool.accepted, true,
    "ordinary-tool authorization must ignore obsolete caller token fields because generation transport is no longer model-owned");
  assert.equal(staleSyntheticTool.reason, "manual-owner-authorized");
  const manualToolAfterTakeover = runtime.continuationModelToolAuthorization({ conversationScopeId: scope });
  assert.equal(manualToolAfterTakeover.accepted, true,
    "manual status takeover must make later untagged tools safe to execute");

  const terminalRaceScope = "v1/terminal-delivery-race";
  const terminalRaceTask = runtime.continuationTask({
    action: "begin", conversationScopeId: terminalRaceScope, workspaceId: "ws_architecture",
    continuationMode: "completion-driven", objective: "terminal delivery race",
    requiredMilestones: ["terminal-race-done"],
  });
  const terminalRaceMount = runtime.prepareContinuationAnchorMount({
    taskId: terminalRaceTask.task.id, conversationScopeId: terminalRaceScope,
  });
  assert.equal(runtime.continuationTask({
    action: "anchor-mounted", taskId: terminalRaceTask.task.id, conversationScopeId: terminalRaceScope,
    coordinatorInstanceId: "ui_terminal_race", anchorMountToken: terminalRaceMount.anchorMountToken,
  }).accepted, true);
  const terminalRaceCapability = runtime.continuationSenderCapability({ taskId: terminalRaceTask.task.id });
  const terminalRaceNow = new Date().toISOString();
  db.prepare(`update continuation_tasks set stall_state='CONTINUATION_ARMED',stall_armed_at=?,stall_evidence='terminal-race-test',continuation_pending=0,delivery_token=null,delivery_owner='manual',delivery_owner_expires_at=null,updated_at=? where id=?`)
    .run(terminalRaceNow, terminalRaceNow, terminalRaceTask.task.id);
  db.prepare(`update continuation_worksets set state='RUNNING',continuation_due_at=?,updated_at=? where id=(select active_workset_id from continuation_conversation_cards where conversation_scope_id=?)`)
    .run(terminalRaceNow, terminalRaceNow, terminalRaceScope);
  assert.equal(runtime.continuationSupervisorSweep().ready.length, 1);
  const terminalRaceClaim = runtime.claimReadyContinuationGeneration({
    conversationScopeId: terminalRaceScope, taskId: terminalRaceTask.task.id,
    senderInstanceId: "ui_terminal_race", anchorMountToken: terminalRaceCapability.anchorMountToken,
    anchorMountGeneration: terminalRaceCapability.anchorMountGeneration,
  });
  assert.equal(terminalRaceClaim.accepted, true);
  assert.equal(runtime.authorizeContinuationGenerationDelivery({
    conversationScopeId: terminalRaceScope, taskId: terminalRaceTask.task.id,
    senderInstanceId: "ui_terminal_race", anchorMountToken: terminalRaceCapability.anchorMountToken,
    anchorMountGeneration: terminalRaceCapability.anchorMountGeneration, deliveryToken: terminalRaceClaim.deliveryToken,
  }).accepted, true);
  assert.equal(db.prepare("select state from continuation_generations where delivery_token=?").get(terminalRaceClaim.deliveryToken).state, "DELIVERING");
  const terminalRaceCompleted = runtime.continuationTask({
    action: "complete", taskId: terminalRaceTask.task.id, conversationScopeId: terminalRaceScope,
    workspaceId: "ws_architecture", completedMilestones: ["terminal-race-done"],
    evidence: { terminalRace: "completed-before-host-send" },
  });
  assert.equal(terminalRaceCompleted.accepted, true);
  assert.equal(terminalRaceCompleted.task.state, "SUCCEEDED");
  const terminalLegacy = db.prepare(`select continuation_pending,delivery_token,delivery_owner,delivery_owner_expires_at,delivery_ack_started_at,delivery_ack_retry_count,delivery_ack_retry_after_at,turn_lease_expires_at,stall_armed_at,watch_process_handles_json from continuation_tasks where id=?`).get(terminalRaceTask.task.id);
  assert.equal(Number(terminalLegacy.continuation_pending), 0);
  assert.equal(terminalLegacy.delivery_token, null);
  assert.equal(terminalLegacy.delivery_owner, null);
  assert.equal(terminalLegacy.delivery_owner_expires_at, null);
  assert.equal(terminalLegacy.delivery_ack_started_at, null);
  assert.equal(Number(terminalLegacy.delivery_ack_retry_count), 0);
  assert.equal(terminalLegacy.delivery_ack_retry_after_at, null);
  assert.equal(terminalLegacy.turn_lease_expires_at, null);
  assert.equal(terminalLegacy.stall_armed_at, null);
  assert.equal(terminalLegacy.watch_process_handles_json, "[]");
  const terminalGeneration = db.prepare("select state,failure_reason,due_at from continuation_generations where delivery_token=?").get(terminalRaceClaim.deliveryToken);
  assert.equal(terminalGeneration.state, "NO_WORK",
    "completion between sender authorization and Host send must cancel the claimed synthetic generation");
  assert.match(terminalGeneration.failure_reason, /task-terminal:completed/);
  assert.equal(terminalGeneration.due_at, null);
  assert.equal(runtime.continuationArchitectureSnapshot(terminalRaceScope).card.active_workset_id, null);
  const staleAcceptedAfterTerminal = runtime.recordContinuationGenerationDelivery({
    deliveryToken: terminalRaceClaim.deliveryToken, result: "accepted", method: "app.sendMessage",
    note: "Host result arrived after terminal transition",
  });
  assert.equal(staleAcceptedAfterTerminal.accepted, false);
  assert.equal(staleAcceptedAfterTerminal.reason, "task-terminal-no-work");
  assert.equal(staleAcceptedAfterTerminal.generation.state, "NO_WORK");
  assert.equal(runtime.continuationSupervisorSweep().ready.length, 0,
    "terminal worksets must never produce another generation after a stale Host delivery result");
  const terminalStatus = runtime.continuationTask({
    action: "status", taskId: terminalRaceTask.task.id, conversationScopeId: terminalRaceScope,
    deliveryToken: terminalRaceClaim.deliveryToken,
  });
  assert.equal(terminalStatus.accepted, false);
  assert.equal(terminalStatus.reason, "task-terminal-no-work");
  assert.equal(terminalStatus.continueRequired, false);
  assert.equal(terminalStatus.finalResponseAllowed, true);

  const recoveryScope = "v1/recover-missing-legacy-projection";
  const recoveryFirst = runtime.continuationTask({
    action: "begin",
    conversationScopeId: recoveryScope,
    workspaceId: "ws_architecture",
    continuationMode: "completion-driven",
    objective: "recovery first workset",
    requiredMilestones: ["recover-a"],
  });
  const recoveryMount = runtime.prepareContinuationAnchorMount({
    taskId: recoveryFirst.task.id,
    conversationScopeId: recoveryScope,
  });
  const recoveryMounted = runtime.continuationTask({
    action: "anchor-mounted",
    taskId: recoveryFirst.task.id,
    conversationScopeId: recoveryScope,
    coordinatorInstanceId: "ui_recovery_test",
    anchorMountToken: recoveryMount.anchorMountToken,
  });
  assert.equal(recoveryMounted.accepted, true);
  const recoveryCompleted = runtime.continuationTask({
    action: "complete",
    taskId: recoveryFirst.task.id,
    conversationScopeId: recoveryScope,
    workspaceId: "ws_architecture",
    completedMilestones: ["recover-a"],
    evidence: { recovery: "seed-complete" },
  });
  assert.equal(recoveryCompleted.accepted, true);
  let recoverySnapshot = runtime.continuationArchitectureSnapshot(recoveryScope);
  const recoveryCardId = recoverySnapshot.card.card_id;
  const recoveryGeneration = Number(recoverySnapshot.card.mount_generation);
  assert.equal(recoverySnapshot.card.mount_state, "VERIFIED");
  db.prepare("delete from continuation_tasks where id=?").run(recoveryFirst.task.id);
  const shadowId = "task_shadow_missing_legacy_projection";
  const shadowNow = new Date().toISOString();
  db.prepare(`
    insert into continuation_tasks(
      id,conversation_scope_id,workspace_id,objective,state,continuation_mode,required_milestones_json,
      created_at,updated_at,task_source,contract_version,auto_created
    ) values(?,?,?,?, 'RUNNING','completion-driven',?,?,?,'auto-conversation',2,1)
  `).run(shadowId, recoveryScope, "ws_architecture", "shadow fallback", JSON.stringify(["shadow"]), shadowNow, shadowNow);
  runtime.syncContinuationArchitectureForLegacyTask(shadowId);
  recoverySnapshot = runtime.continuationArchitectureSnapshot(recoveryScope);
  assert.equal(recoverySnapshot.card.mount_state, "VERIFIED",
    "a shadow compatibility projection must never downgrade an already verified conversation card");
  assert.equal(Number(recoverySnapshot.card.mount_generation), recoveryGeneration);
  const directRecoveredProjection = runtime.recoverCanonicalConversationTaskProjection({
    taskId: recoveryFirst.task.id,
    conversationScopeId: recoveryScope,
    workspaceId: "ws_architecture",
    objective: "recovered second workset",
    requiredMilestones: ["recover-b"],
    forceRunning: true,
  });
  assert.equal(directRecoveredProjection.id, recoveryFirst.task.id);
  assert.equal(directRecoveredProjection.state, "RUNNING",
    "recovery with new unfinished work must never reconstruct the lifetime task as SUCCEEDED from an older completed workset");
  const directlyRecoveredRequired = JSON.parse(directRecoveredProjection.required_milestones_json);
  const directlyRecoveredCompleted = JSON.parse(directRecoveredProjection.completed_milestones_json);
  assert.ok(directlyRecoveredRequired.includes("recover-a"));
  assert.ok(directlyRecoveredRequired.includes("recover-b"),
    "begin-time milestone hints must survive projection recovery before the begin action mutates the task");
  assert.ok(directlyRecoveredRequired.includes("shadow"),
    "unfinished work held only by the compatibility shadow must migrate into the canonical lifetime projection before shadow retirement");
  assert.ok(directlyRecoveredCompleted.includes("recover-a"));
  assert.ok(!directlyRecoveredCompleted.includes("recover-b"));
  assert.equal(db.prepare("select state from continuation_tasks where id=?").get(shadowId).state, "ABANDONED_AUTO_TASK",
    "projection recovery must retire the shadow only after its current unfinished contract has been captured");
  const recoverySecond = runtime.continuationTask({
    action: "begin",
    taskId: recoveryFirst.task.id,
    conversationScopeId: recoveryScope,
    workspaceId: "ws_architecture",
    continuationMode: "completion-driven",
    objective: "recovered second workset",
    requiredMilestones: ["recover-b"],
  });
  assert.equal(recoverySecond.task.id, recoveryFirst.task.id,
    "a missing legacy task row must be reconstructed from the verified card/workset lineage instead of allocating a shadow task id");
  assert.equal(recoverySecond.task.anchorMountVerifiedAt, recoveryMounted.task.anchorMountVerifiedAt);
  assert.equal(recoverySecond.task.anchorMountGeneration, recoveryGeneration);
  assert.ok(recoverySecond.task.requiredMilestones.includes("shadow"));
  recoverySnapshot = runtime.continuationArchitectureSnapshot(recoveryScope);
  assert.equal(recoverySnapshot.card.card_id, recoveryCardId);
  assert.equal(recoverySnapshot.card.mount_state, "VERIFIED");
  assert.equal(Number(recoverySnapshot.card.mount_generation), recoveryGeneration);
  const recoveryActiveWorkset = recoverySnapshot.worksets.find((row) => row.id === recoverySnapshot.card.active_workset_id);
  assert.equal(recoveryActiveWorkset.legacy_task_id, recoveryFirst.task.id,
    "the recovered lifetime task must own the only active workset");
  assert.equal(recoverySnapshot.worksets.filter((row) => ["RUNNING","WAITING_EXTERNAL","SUSPECTED_STALL"].includes(row.state)).length, 1);

  // Regression: the canonical legacy projection can be terminal while a newer
  // canonical Workset is still active. A read-only status/recovery call has no
  // forceRunning hint and no shadow task to rescue it, so recovery itself must
  // prefer the newest active unfinished Workset over the historical completed
  // Workset and reactivate the lifetime projection.
  const activePriorityScope = "v1/recover-active-workset-priority";
  const activePriorityFirst = runtime.continuationTask({
    action: "begin", conversationScopeId: activePriorityScope, workspaceId: "ws_architecture",
    continuationMode: "completion-driven", objective: "historical completed objective",
    requiredMilestones: ["historical-done"],
  });
  const activePriorityMount = runtime.prepareContinuationAnchorMount({
    taskId: activePriorityFirst.task.id, conversationScopeId: activePriorityScope,
  });
  runtime.continuationTask({
    action: "anchor-mounted", taskId: activePriorityFirst.task.id, conversationScopeId: activePriorityScope,
    coordinatorInstanceId: "ui_active_priority", anchorMountToken: activePriorityMount.anchorMountToken,
  });
  runtime.continuationTask({
    action: "complete", taskId: activePriorityFirst.task.id, conversationScopeId: activePriorityScope,
    workspaceId: "ws_architecture", completedMilestones: ["historical-done"],
  });
  const priorityNow = new Date().toISOString();
  const priorityWorksetId = "workset_active_priority_new";
  db.prepare(`
    insert into continuation_worksets(
      id,conversation_scope_id,legacy_task_id,sequence,workspace_id,objective,state,current_generation,created_at,updated_at
    ) values(?,?,?,?,?,?, 'RUNNING',1,?,?)
  `).run(priorityWorksetId, activePriorityScope, activePriorityFirst.task.id, 2,
    "ws_architecture", "new active unfinished objective", priorityNow, priorityNow);
  db.prepare(`
    insert into continuation_milestones(
      id,workset_id,stable_key,description,state,evidence_json,ordinal,created_at,updated_at
    ) values(?,?,?,?, 'PENDING','{}',1,?,?)
  `).run("milestone_active_priority_new", priorityWorksetId, "active-priority-new", "new-active-pending", priorityNow, priorityNow);
  db.prepare(`update continuation_conversation_cards set active_workset_id=?,updated_at=? where conversation_scope_id=?`)
    .run(priorityWorksetId, priorityNow, activePriorityScope);
  const activePriorityRecovered = runtime.recoverCanonicalConversationTaskProjection({
    taskId: activePriorityFirst.task.id, conversationScopeId: activePriorityScope,
  });
  assert.equal(activePriorityRecovered.state, "RUNNING",
    "a newer active unfinished Workset must reactivate a stale terminal canonical projection without forceRunning or a shadow task");
  assert.equal(activePriorityRecovered.objective, "new active unfinished objective",
    "recovery must take objective/workspace context from the authoritative active unfinished Workset before historical canonical fields");
  assert.ok(JSON.parse(activePriorityRecovered.required_milestones_json).includes("new-active-pending"));
  assert.ok(!JSON.parse(activePriorityRecovered.completed_milestones_json).includes("new-active-pending"));
  assert.equal(runtime.continuationArchitectureSnapshot(activePriorityScope).card.active_workset_id, priorityWorksetId);

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
