import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const runtimeStatePath = join(ROOT, "app", "node_modules", "@waishnav", "devspace", "dist", "runtime-state.js");
const packagedServerPath = join(ROOT, "app", "node_modules", "@waishnav", "devspace", "dist", "server.js");
const packagedConfigPath = join(ROOT, "app", "node_modules", "@waishnav", "devspace", "dist", "config.js");
const migrations = readFileSync(join(ROOT, "vendor", "waishnav-devspace", "dist", "db", "migrations.js"), "utf8");
const server = readFileSync(join(ROOT, "vendor", "waishnav-devspace", "dist", "server.js"), "utf8");
const runtimeStateSource = readFileSync(join(ROOT, "vendor", "waishnav-devspace", "dist", "runtime-state.js"), "utf8");
const supervisorSource = readFileSync(join(ROOT, "vendor", "waishnav-devspace", "dist", "continuation-supervisor.js"), "utf8");
const featureTools = readFileSync(join(ROOT, "vendor", "waishnav-devspace", "dist", "feature-tools.js"), "utf8");
const coordinatorPath = join(ROOT, "vendor", "waishnav-devspace", "dist", "ui", "assets", "continuation-coordinator.js");
const coordinator = readFileSync(coordinatorPath, "utf8");
const senderEpoch = (source) => Number(source.match(/const CONTINUATION_SENDER_PROTOCOL_EPOCH = (\d+);/)?.[1]);
const TEST_SENDER_ASSET_REVISION = "0123456789abcdef";
const STALE_TEST_SENDER_ASSET_REVISION = "fedcba9876543210";
const withTestSenderProtocol = (input = {}) => ({
  ...input,
  senderProtocolEpoch: senderEpoch(server),
  senderAssetRevision: TEST_SENDER_ASSET_REVISION,
});
const withStaleTestSenderProtocol = (input = {}) => ({
  ...input,
  senderProtocolEpoch: senderEpoch(server),
  senderAssetRevision: STALE_TEST_SENDER_ASSET_REVISION,
});
const configureTestSenderTransport = (runtimeState) => runtimeState.configureContinuationSenderTransport({
  protocolEpoch: senderEpoch(server),
  assetRevision: TEST_SENDER_ASSET_REVISION,
});
assert.ok(Number.isInteger(senderEpoch(server)) && senderEpoch(server) > 0,
  "server must declare a valid sender protocol epoch");
assert.equal(senderEpoch(coordinator), senderEpoch(server),
  "the actual coordinator and server must agree on the sender protocol epoch; individually valid constants cannot prove interoperability");
assert.match(server,
  /CONTINUATION_SENDER_COMPATIBLE_PROTOCOL_EPOCHS = new Set\(\[12, CONTINUATION_SENDER_PROTOCOL_EPOCH\]\)/,
  "only the verified wire-compatible epoch 12 may join the current sender epoch; arbitrary old/future epochs stay fenced");
assert.match(server,
  /normalizedSenderProtocolEpoch = CONTINUATION_SENDER_PROTOCOL_EPOCH[\s\S]{0,2600}bindContinuationSender\([\s\S]{0,900}senderProtocolEpoch: normalizedSenderProtocolEpoch[\s\S]{0,1800}heartbeatContinuationSender\([\s\S]{0,900}senderProtocolEpoch: normalizedSenderProtocolEpoch/,
  "compatible cached senders must be normalized into the current runtime epoch before strict sender lease/CAS checks");
assert.equal(senderEpoch(readFileSync(packagedServerPath, "utf8")), senderEpoch(server),
  "installed core must enforce the same sender protocol as source");
const visibleTriggerSource = coordinator.match(/function visibleContinuationTrigger\(task, deliveryToken\) \{[\s\S]*?\n\}/)?.[0] ?? "";
const finalizeRelease = readFileSync(join(ROOT, "setup", "finalize-release.py"), "utf8");
const uiManifest = JSON.parse(readFileSync(join(ROOT, "vendor", "waishnav-devspace", "dist", "ui", ".vite", "manifest.json"), "utf8"));
const workspaceEntry = uiManifest["workspace-app.html"];
assert.ok(workspaceEntry?.file, "workspace-app.html must exist in the Vite manifest");
const workspaceBundle = readFileSync(join(ROOT, "vendor", "waishnav-devspace", "dist", "ui", workspaceEntry.file), "utf8");
assert.match(finalizeRelease,
  /app\/node_modules\/@waishnav\/devspace\/dist\/ui\/assets\/continuation-coordinator\.js/,
  "release metadata must fingerprint the continuation coordinator so same-version live/source drift is detectable");
assert.match(server,
  /\/mcp-app-assets\/continuation-runtime\.js[\s\S]{0,1800}Cache-Control[\s\S]{0,160}no-cache, no-store/,
  "the legacy continuation coordinator hot-upgrade endpoint must remain available as a no-store compatibility/diagnostic URL");
assert.match(server,
  /const continuationCoordinatorSource = escapeInlineScript\([\s\S]{0,240}continuation-coordinator\.js/,
  "the revisioned Workspace App HTML generator must inline the continuation coordinator so visible card startup and sender startup cannot diverge");
assert.doesNotMatch(server,
  /<script type="module" src=\$\{JSON\.stringify\(continuationRuntimeUrl\)\}><\/script>/,
  "automatic continuation must not depend on a secondary external module request that the Host may skip while still rendering the inline card");
assert.match(server,
  /globalThis\.__DEVSPACE_CONTINUATION_SENDER_ASSET_REVISION__=/,
  "the live runtime endpoint must stamp the provenance revision for the bytes it actually serves");
assert.match(runtimeStateSource,
  /assistant_turn_state='COMPLETION_REQUESTED'[\s\S]{0,420}assistant_turn_completion_lease_id=t\.turn_lease_id[\s\S]{0,260}\+8 seconds/,
  "resident supervisor candidate discovery must include a mature exact signed completion even before promotion has written workset continuation_due_at");

for (const pattern of [
  /version: 13/,
  /continuation-task-controller/,
  /version: 14/,
  /continuation-app-coordinator-observability/,
  /version: 15/,
  /continuation-host-budget-learning/,
  /version: 16/,
  /continuation-owner-controls/,
  /version: 17/,
  /continuation-model-activity-watchdog/,
  /version: 18/,
  /continuation-explicit-long-task-mode/,
  /version: 19/,
  /continuation-strict-trigger-modes/,
  /version: 20/,
  /continuation-confirmed-turn-limit/,
  /version: 21/,
  /continuation-task-contract-turn-lease/,
  /version: 22/,
  /continuation-completion-driven-unbounded/,
  /version: 23/,
  /continuation-stall-detector-host-regimes/,
  /version: 24/,
  /continuation-delivery-readiness-backoff/,
  /version: 25/,
  /continuation-conversation-singleton/,
  /version: 26/,
  /continuation-manual-takeover-and-singleton-repair/,
  /continuation_tasks_conversation_active_unique/,
  /merged-duplicate-conversation-contract/,
  /delivery_generation/,
  /delivery_token/,
  /delivery_owner/,
  /manual_takeover_at/,
  /superseded_delivery_token/,
  /continuation_mode[\s\S]{0,80}default 'compat'/,
  /owner_locked[\s\S]{0,80}integer not null default 0/,
  /last_model_activity_at/,
  /owner_locked_at/,
  /owner_control_note/,
  /create table if not exists continuation_host_profiles/,
  /create table if not exists continuation_tasks/,
  /conversation_scope_id text not null/,
  /turn_started_at text/,
  /continuation_pending integer not null default 0/,
  /last_ui_heartbeat_at/,
  /last_send_result/,
  /observed_turn_budget_ms/,
  /recommended_continue_after_ms/,
  /confirmed_turn_limit_ms/,
  /confirmed_turn_limit_source/,
  /task_source/,
  /contract_version/,
  /auto_created/,
  /substantive_activity_count/,
  /turn_lease_id/,
  /turn_lease_expires_at/,
  /last_anchor_mounted_at/,
  /anchor_lease_expires_at/,
  /stall_state/,
  /stall_suspected_at/,
  /stall_probe_count/,
  /stall_armed_at/,
  /stall_evidence/,
  /cutoff_samples_json/,
  /cutoff_epoch/,
  /cutoff_regime_changed_at/,
  /delivery_ack_started_at/,
  /delivery_ack_retry_count/,
  /delivery_ack_retry_after_at/,
  /version: 31/,
  /continuation-1\.1\.56-runtime-reset/,
  /version: 33/,
  /continuation-permanent-lifetime-singleton/,
  /continuation_tasks_conversation_lifetime_unique/,
]) assert.match(migrations, pattern);
assert.match(migrations,
  /create unique index if not exists continuation_tasks_conversation_lifetime_unique[\s\S]{0,240}conversation_scope_id glob 'v1\/\*'/,
  "canonical conversations must have one permanent lifetime task even after that task reaches a terminal state");
assert.match(runtimeStateSource,
  /if \(input\.conversationScopeId && isCanonicalConversationScope\(input\.conversationScopeId\)\)[\s\S]{0,500}order by created_at asc,id asc[\s\S]{0,120}limit 1/,
  "first manual status must recover the lifetime task by conversation scope even before a workspace or card exists");
assert.match(runtimeStateSource,
  /conversationLifetimeSingleton:\s*isCanonicalConversationScope\(/,
  "canonical conversation status must truthfully report the permanent lifetime singleton guarantee");
assert.doesNotMatch(runtimeStateSource,
  /conversationLifetimeSingleton:\s*false/,
  "runtime responses must derive the singleton guarantee from conversation scope instead of emitting a stale hard-coded false");
assert.match(migrations, /delete from continuation_tasks[\s\S]{0,120}conversation_scope_id not glob 'v1\/\*'/,
  "1.1.56 migration must remove non-canonical shadow tasks created by stripped Host metadata");
assert.match(migrations, /migrated-1\.1\.49/,
  "1.1.50 migration must explicitly identify active legacy 1.1.49 Task Contracts that are upgraded to completion-driven mode");
assert.match(migrations, /contract_version=0[\s\S]{0,500}task_source='legacy'[\s\S]{0,500}continuation_mode='timeout-recovery'[\s\S]{0,500}required_milestones_json/,
  "active 1.1.49 timeout-recovery tasks with real milestones must migrate into the new completion-driven contract instead of remaining on the old P0-prone semantics");
assert.match(migrations, /max_continuations=0[\s\S]{0,500}deadline_at=null[\s\S]{0,700}strftime\([^)]*\+3 minutes/,
  "migrated Task Contracts must start unlimited and receive an initial Turn Lease");
assert.match(migrations, /version:\s*28[\s\S]{0,180}continuation-anchor-generation-turn-fingerprint/,
  "ghost-card recovery must persist a monotonic anchor generation and opaque Host-turn fingerprint");
assert.match(migrations, /anchor_mount_generation[\s\S]{0,240}integer not null default 0[\s\S]{0,500}anchor_mount_host_turn_hash/,
  "the migration must store generation plus only a hashed Host-turn hint, never the raw trace id");

for (const pattern of [
  /registerAppTool\(server, "continuation_anchor"/,
  /toolWidgetDescriptorMeta\(config, "continuation-anchor"\)/,
  /resourceUri: appUri/,
  /assets\/continuation-coordinator\.js/,
  /workspaceAppRevision/,
  /workspaceAppUri/,
  /WORKSPACE_APP_URI_PREFIX/,
  /sendToolListChanged\(\)/,
  /sendResourceListChanged\(\)/,
  /mcp_metadata_refresh_notification_failed/,
  /createHash\("sha256"\)/,
  /appOpenAiWidgetCsp/,
  /"openai\/widgetCSP": appOpenAiWidgetCsp\(config\)/,
  /"openai\/widgetDomain": publicBaseUrl/,
  /ResourceTemplate/,
  /WORKSPACE_APP_URI_PREFIX[^\n]*\{revision\}\.html/,
  /DevSpace Diff Card Compatibility/,
  /DevSpace Diff Card Legacy Compatibility/,
  /function appCallableToolMeta/,
  /visibility: \["model", "app"\]/,
  /"openai\/widgetAccessible": true/,
  /registerAppTool\(server, "continuation_task"/,
  /registerAppTool\(server, "continuation_task",[\s\S]{0,10000}\.\.\.appCallableToolMeta\(config, "shell"\)/,
  /openAiConversationScopeId\(_meta\)/,
  /requiredMilestones/,
  /completion.*evidence|provide concrete evidence/is,
]) assert.match(server, pattern);
assert.match(server, /resident[^\n]{0,500}(?:persistent process monitoring|process monitoring)[\s\S]{0,700}(?:running process never blocks recovery|completed process never ends a live model turn)/,
  "server guidance must define resident as persistent process monitoring plus ordinary assistant-turn recovery");
assert.doesNotMatch(server, /snapshot\.running && effectivePersistent && config\.features\?\.continuationGuard && runtimeState/,
  "exec_command must not auto-register every still-running persistent process as a continuation wake");
assert.doesNotMatch(server, /action: "watch-process",[\s\S]{0,220}processHandle: snapshot\.processHandle/,
  "process completion wake must require an explicit continuation_task watch-process call");
assert.doesNotMatch(server, /<script[^>]+src="\$\{continuationCoordinatorUrl\}"/,
  "continuation sender must not use an immutable revisioned asset URL that a Host-cached App document can pin across a live upgrade");
assert.doesNotMatch(server, /"openai\/outputTemplate"\s*:\s*LEGACY_CONTINUATION_GUARD_URI/, "historical continuation-guard URI may exist only as a resource alias, never as the current output template");
assert.doesNotMatch(server, /CONTINUATION_APP_KINDS/, "ordinary DevSpace tools must not gain UI metadata merely because continuation is enabled");
assert.match(server, /const attachWorkspaceApp = shouldAttachWidget\(config, kind\);/, "only explicitly UI-bearing tools may mount the Workspace App");
assert.match(featureTools, /registerAppTool\(server, "session_changes",[\s\S]{0,1200}\.\.\.appToolMeta\("review"\)/, "session_changes must stay visually headless while remaining callable from the existing Workspace App");
assert.match(featureTools, /registerAppTool\(server, "session_rollback",[\s\S]{0,1200}\.\.\.appToolMeta\("write"\)/, "session_rollback must be callable from the existing Workspace App instead of leaving its rollback button inert");
assert.doesNotMatch(featureTools, /registerAppTool\(server, "session_changes",[\s\S]{0,1200}\.\.\.toolMeta\("show_changes"\)/, "session_changes must not create a second review App card");

for (const pattern of [
  /DEFAULT_SUPERVISOR_TICK_MS/,
  /DEFAULT_HEARTBEAT_INTERVAL_MS/,
  /app\.callServerTool/,
  /app\.updateModelContext/,
  /addEventListener\("toolcancelled"/,
  /sendFollowUpMessage/,
  /host-signal/,
  /watch-status/,
  /Process completion only refreshes durable business state/,
  /Assistant Turn Completion Contract armed/,
  /delivery ACK retry/,
  /continuation_sender/,
  /callSender/,
  /delivery-result/,
  /WAITING_EXTERNAL/,
  /PAUSED_BY_USER/,
  /manual recovery/,
  /onTeardown/,
]) assert.match(coordinator, pattern);
assert.doesNotMatch(coordinator, /claim-continuation|release-continuation/,
  "legacy continuation_task claim/release sender paths must stay removed");
assert.match(visibleTriggerSource, /deliveryToken：\$\{handshakeToken\}/,
  "the compact live synthetic user-role handoff must still carry the sender-issued one-time delivery token so Host turn-origin binding can complete before substantive work");
assert.match(visibleTriggerSource, /continuation_task action=status[\s\S]{0,220}deliveryToken[\s\S]{0,220}(?:不要设置|不设置) manualTakeover/,
  "the resumed turn must be instructed to echo the exact one-time delivery token on its first status without impersonating a manual takeover");
assert.match(coordinator, /visibleContinuationTrigger\(state\.task, deliveryToken\)/,
  "the exact token returned by continuation_sender claim must flow into the Host-visible synthetic handoff");
assert.doesNotMatch(coordinator, /do not search for, expose, or pass a continuation token/,
  "the dev45 tokenless-only instruction must not survive after live Host turn-origin handshake evidence proved an explicit first-status capability is required");
assert.match(server, /deliveryToken:[\s\S]{0,220}One-time synthetic turn-origin capability/,
  "continuation_task schema guidance must describe the current one-time turn-origin ACK contract rather than labeling it legacy-only");
assert.match(runtimeStateSource,
  /action === "claim-continuation"[\s\S]{0,3200}liveSyntheticGeneration[\s\S]{0,1200}exactTurnEndReserved[\s\S]{0,700}continuation_pending \|\| 0\) === 2[\s\S]{0,500}generation-sender-required/,
  "legacy task-level claim must fail closed from explicit wake/end reservation onward, including before a modern ContinuationGeneration receives a delivery token");
assert.match(runtimeStateSource,
  /action === "release-continuation"[\s\S]{0,2400}liveSyntheticGeneration[\s\S]{0,1000}exactTurnEndReserved[\s\S]{0,700}continuation_pending \|\| 0\) === 2[\s\S]{0,500}generation-sender-required/,
  "legacy task-level release must not clear a modern wake/end reservation or generation-backed delivery/ACK lease");
assert.doesNotMatch(coordinator, /model activity idle watchdog|DEFAULT_MODEL_IDLE_CONTINUE_MS|modelIdleContinueMs|adaptive host-budget watchdog|explicit long-task silent truncation guard|DEFAULT_EXPLICIT_SILENT_CONTINUE_MS/,
  "legacy generic inactivity and learned-budget watchdogs must stay removed");
assert.match(coordinator, /completionActivityLeaseExpired[\s\S]{0,1800}SUSPECTED_STALL/,
  "completion-driven activity-lease expiry must persist a suspected stall without treating silence as turn completion");
assert.doesNotMatch(coordinator, /attemptContinuation\("task contract turn lease expired"/,
  "plain activity-lease expiry must never directly create another assistant turn");
assert.doesNotMatch(coordinator, /COMPLETION_STALL_CONFIRM_MS|shortConfirmDue|activity lease still expired after short stall confirmation/,
  "repeated iframe heartbeat probes must never turn silence into an automatic recovery authorization");
assert.match(coordinator, /function assistantTurnCompletionArmed\(task\)[\s\S]{0,900}\["COMPLETED", "TIMED_OUT"\][\s\S]{0,500}assistantTurnCompletionLeaseId === task\?\.turnLeaseId[\s\S]{0,300}CONTINUATION_ARMED/,
  "completion-driven recovery must require an explicit ATCC terminal state bound to the exact current turn lease in addition to the armed delivery state");
assert.match(server, /completion-driven[\s\S]{0,900}timeout-recovery[\s\S]{0,900}resident/,
  "tool contract must expose completion-driven, strict timeout-recovery, and explicit resident modes");
assert.match(server, /maxContinuations[\s\S]{0,260}0 or omitted means unlimited[\s\S]{0,900}wallClockMinutes[\s\S]{0,260}0 or omitted means unlimited/,
  "completion-driven Task Contracts must expose unlimited continuation/wall-clock defaults");
assert.match(server, /completion-driven means required milestones and evidence, not elapsed time, own completion/,
  "completion-driven Task Contracts must remain milestone/evidence-owned instead of becoming timer-owned");
assert.match(server, /"confirm-turn-limit"/,
  "continuation_task must retain the explicit confirm-turn-limit control action");
assert.match(coordinator, /SUSPECTED_STALL/,
  "coordinator recovery must retain the fail-closed suspected-stall state");
assert.doesNotMatch(runtimeStateSource, /confirmedCutoffCorroborated[\s\S]{0,1200}CONTINUATION_ARMED/,
  "the old single-cutoff corroboration path must remain removed; guarded learned-cutoff recovery is tested behaviorally by ATCC");
assert.doesNotMatch(runtimeStateSource, /earlyCompletionCorroborated|short-confirmed-probe/,
  "runtime state must not arm recovery from repeated UI heartbeat probes alone");
assert.match(runtimeStateSource, /COMPLETION_STALL_SUSPECT_MS = 25_000/,
  "the primary completion-driven inactivity lease must remain below the one-minute ceiling");
assert.doesNotMatch(runtimeStateSource, /COMPLETION_SERVER_QUIET_BACKSTOP_MS/,
  "request silence must not be promoted into a continuation authorization timer");
assert.doesNotMatch(runtimeStateSource, /COMPLETION_QUIET_RECOVERY_MS|COMPLETION_STALL_CONFIRM_MS/,
  "the old heartbeat-confirmation quiet-window implementations must stay removed");
assert.match(runtimeStateSource, /DELIVERY_ACK_RETRY_BASE_MS = 45_000/,
  "delivery ACK retransmission must allow a bounded first synthetic status handshake window without consuming the full continuation SLA");
assert.match(runtimeStateSource, /DELIVERY_ACK_RETRY_MAX_MS = 60_000/,
  "delivery ACK retransmission backoff must remain bounded at one minute");
assert.match(runtimeStateSource, /CONTINUATION_SENDER_CLAIM_LEASE_MS = 45_000/,
  "sender claim ownership must outlive the coordinator's full bounded pre-send retry envelope");
assert.ok(runtimeStateSource.includes("server-turn-lease-expired-no-inflight-model-request")
  && !runtimeStateSource.includes("server-confirmed-host-cutoff-no-inflight-model-request"),
  "resident recovery must keep historical cutoff telemetry out of the authorization evidence set");
assert.match(runtimeStateSource, /!this\.continuationModelRequestInFlight\(current\.conversation_scope_id\)[\s\S]{0,5200}server-turn-lease-expired-no-inflight-model-request/,
  "the resident lease-suspicion/cutoff recovery branch must be forbidden while a real model-originated DevSpace request is in flight");
assert.doesNotMatch(runtimeStateSource, /const serverQuietBackstop/,
  "server request silence must never arm a replacement Host turn");
assert.doesNotMatch(runtimeStateSource, /QUIET_BACKSTOP_SENDER_GRACE_MS|quiet-backstop-claim-grace|same-turn-model-activity-superseded-quiet-claim/,
  "dev12 must keep the last quiet-backstop sender compatibility path removed instead of retaining a timer-owned pre-delivery race");
assert.match(runtimeStateSource, /assistant_turn_state[\s\S]{0,2200}COMPLETION_REQUESTED/,
  "runtime must persist the Assistant Turn Completion Contract rather than infer completion from request silence");
assert.match(runtimeStateSource, /preFinalControlRequired[\s\S]{0,1800}turn-complete[\s\S]{0,700}waitingExternal=true/,
  "task directives must fail closed when an incomplete RUNNING turn has not recorded a legal pre-final control action");
assert.match(server, /Before ANY user-visible final response[\s\S]{0,1800}preFinalControlRequired=true[\s\S]{0,2200}waitingExternal=true[\s\S]{0,1600}RUNNING\/GENERATING/,
  "server instructions must forbid a bare final from leaving an incomplete DevSpace turn in RUNNING/GENERATING");
assert.doesNotMatch(server, /function taskContractText/,
  "ordinary data-plane tools must not rebuild and replay the full Task Contract prose after every operation");
assert.match(server, /function continuationTransportOutputFields\(\)[\s\S]{0,2200}preFinalControlRequired: z\.boolean\(\)\.optional\(\)[\s\S]{0,500}requiredBeforeFinal: z\.string\(\)\.optional\(\)/,
  "continuation_task output schema must preserve the pre-final directive fields across the MCP boundary");
assert.match(server, /staleSyntheticTurn: z\.boolean\(\)\.optional\(\)[\s\S]{0,160}suppressVisibleFinal: z\.boolean\(\)\.optional\(\)/,
  "continuation status output must explicitly publish stale synthetic turn suppression fields");
assert.equal((server.match(/outputSchema: resultOutputSchema\(continuationTransportOutputFields\(\)\)/g) ?? []).length, 3,
  "task, anchor and sender must advertise the same complete continuation transport contract");
assert.match(runtimeStateSource, /action === "turn-complete"[\s\S]{0,3600}assistant_turn_completion_lease_id/,
  "normal assistant completion intent must be explicitly signed and bound to the current turn lease");
assert.match(runtimeStateSource, /constructor\(stateDir\)[\s\S]{0,1200}continuation_conversation_cards[\s\S]{0,500}sender_instance_id=null/,
  "a restarted MCP runtime must invalidate persisted Workspace App sender authority before any new continuation can be armed");
assert.doesNotMatch(runtimeStateSource, /promoteMatureAssistantCompletionIntent\(taskId[\s\S]{0,6200}continuation-sender-unavailable/,
  "a mature exact ATCC signature must be allowed to persist durable READY even when no sender is currently available");
assert.doesNotMatch(runtimeStateSource, /if \(action === "turn-complete"[\s\S]{0,9000}continuation-sender-unavailable/,
  "turn-complete must not deadlock on a browser sender that ChatGPT may initialize only while the assistant final is being committed");
assert.match(runtimeStateSource, /promoteMatureAssistantCompletionIntent\(taskId[\s\S]{0,6200}continuationSenderStatus\(\{[\s\S]{0,500}taskId:[\s\S]{0,500}conversationScopeId:/,
  "promotion must still record canonical sender readiness as diagnostics without using it as authority for the model-owned completion boundary");
assert.match(runtimeStateSource, /authorizeContinuationGenerationDelivery\(input = \{\}\)[\s\S]{0,5000}continuationSenderStatus\(\{[\s\S]{0,1200}!senderStatus\.eligible/,
  "actual synthetic delivery authorization must still fail closed unless the current sender passes the canonical eligibility check");
assert.match(runtimeStateSource, /continuationSenderStatus\(input = \{\}, nowMs = Date\.now\(\)\)[\s\S]{0,5200}senderHeartbeatAgeMs[\s\S]{0,900}ANCHOR_LEASE_MS/,
  "the canonical sender eligibility check must enforce a bounded sender heartbeat freshness lease");
assert.match(runtimeStateSource, /MODEL_COMPLETION_HANDOFF_GRACE_MS = 8_000/,
  "normal ChatGPT finals without Apps teardown must use a prompt bounded handoff grace only after explicit ATCC intent");
assert.match(runtimeStateSource, /promoteMatureAssistantCompletionIntent\(taskId[\s\S]{0,9000}assistant_turn_state='COMPLETED'[\s\S]{0,1200}model-completion-handoff-grace/,
  "the resident runtime must promote only a durable explicit completion request into a completed turn after the handoff grace");
assert.match(runtimeStateSource, /promoteMatureAssistantCompletionIntent\(taskId[\s\S]{0,4000}assistant_turn_state \|\| ""\) !== "COMPLETION_REQUESTED"[\s\S]{0,3600}continuationModelRequestInFlight\(current\.conversation_scope_id\)/,
  "the handoff grace must be unreachable from GENERATING silence and must fail closed while any model-originated DevSpace request is in flight");
assert.match(runtimeStateSource.slice(runtimeStateSource.indexOf("    touchContinuationModelActivity(input = {}) {"), runtimeStateSource.indexOf("    continuationTask(input = {}) {")), /assistant_turn_state='COMPLETION_REQUESTED'[\s\S]{0,300}then 'GENERATING'/,
  "later substantive model activity must revoke a pending completion intent before its handoff deadline can authorize anything");
assert.doesNotMatch(runtimeStateSource, /const syntheticQuietBackstop/,
  "synthetic request silence must never be treated as proof that the Host turn ended");
assert.match(runtimeStateSource, /trackContinuationActivityProcess\(input = \{\}\)[\s\S]{0,2200}watch_process_handles_json/,
  "completion-driven durable process liveness must be persisted independently of the short MCP handler lifetime");
assert.match(runtimeStateSource, /parseJson\(legacy\.watch_process_handles_json, \[\]\)\.length === 0/,
  "completion-driven stall recovery must be suppressed while any durable activity process is still tracked");
assert.match(server, /continuationActivityProcessGuards\(\)[\s\S]{0,2600}"process\.list"/,
  "the resident process guard must inspect process registry metadata without consuming process output");
assert.doesNotMatch(server, /continuationActivityProcessGuards\(\)[\s\S]{0,2600}"process\.attach"/,
  "the resident completion-driven process guard must never consume stdout through process.attach");
assert.match(server, /\["exec_command", "write_stdin", "process_attach", "process_kill"\][\s\S]{0,1000}trackContinuationActivityProcess/,
  "process-bearing model tool results must automatically register or release the completion-driven activity guard");
assert.doesNotMatch(coordinator, /CONFIRMED_TURN_LIMIT_TEARDOWN_GRACE_MS/,
  "historical Host cutoff timing must not survive as a teardown authorization heuristic");
assert.doesNotMatch(coordinator, /confirmedCutoffRecoveryReady|confirmed turn-limit lease expired|confirmed turn-limit teardown/,
  "the browser must not infer cutoff authorization; guarded learned-cutoff recovery belongs to the server");
for (const lifecyclePattern of [/visibilitychange/, /pageshow/, /focus/, /online/, /IntersectionObserver/, /forceAuthoritative/]) {
  assert.match(coordinator, lifecyclePattern,
    "a reactivated/recreated task card must immediately refresh authoritative continuation state");
}
assert.match(coordinator, /startSupervisor\(\);\s*startLifecycleRefresh\(\);/,
  "verified continuation anchors must actually install lifecycle refresh hooks in production, not merely define them");
assert.match(coordinator, /DEFAULT_SUPERVISOR_TICK_MS = 2_000/,
  "an active visible card should notice an already-authorized ATCC continuation promptly without making polling itself an authorization signal");
assert.match(coordinator, /DEFAULT_TERMINAL_REFRESH_MS/,
  "terminal refresh compatibility metadata may remain, but terminal transition must cancel active timers below");
assert.match(coordinator, /const cachedTerminal = terminal\(state\.task\)/,
  "the supervisor must distinguish cached terminal state before its authoritative refresh");
assert.match(coordinator, /Always begin from authoritative server state[\s\S]{0,1200}callTask\("status"\)/,
  "a still-mounted turn card must query authoritative state so it can observe terminal transitions or same-task reactivation while it remains alive");
assert.doesNotMatch(coordinator, /attemptContinuation\("task contract resource teardown"/,
  "ordinary resource teardown must fail closed instead of creating another model turn");
assert.match(coordinator, /resource teardown carries no reason payload[\s\S]{0,500}teardown alone[\s\S]{0,500}confirmation fast path[\s\S]{0,500}never promoted to timeout/,
  "generic teardown must remain non-authorizing by itself while acting only as an optional fast path for an explicit ATCC completion request");
assert.match(coordinator, /recordHostSignal\("teardown", reason\)[\s\S]{0,500}assistantTurnCompletionArmed\(state\.task\)[\s\S]{0,500}ATCC normal assistant completion confirmed by Host teardown/,
  "verified teardown may still trigger the immediate ATCC fast path when the same exact turn already signed completion");
assert.doesNotMatch(coordinator, /syntheticDeliveryToken:|continuationDeliveryToken|DevSpace resume token/,
  "the coordinator must keep generation capabilities inside App/runtime transport instead of exposing them to the model");
assert.match(coordinator, /TRANSIENT_RETRY_DELAYS_MS[\s\S]{0,2200}transientTransportFailure/,
  "Workspace App server calls must retry transient Connection failed/TLS style transport errors with bounded backoff");
assert.match(coordinator, /standardUiMessage[\s\S]{0,500}app\.sendMessage\.bind\(app\)/,
  "automatic continuation must retain the standards-level MCP Apps ui/message path for non-ChatGPT Hosts");
assert.match(coordinator, /standardPayload = \{ role: "user", content: \[\{ type: "text", text \}\] \}/,
  "ui/message continuation must use the exact standard user-role content-block shape");
assert.match(coordinator, /method: "ui\/message"[\s\S]{0,300}result: "accepted"[\s\S]{0,500}model-turn-unconfirmed/,
  "ui/message fulfillment must remain transport acceptance only until the resumed model ACKs DevSpace");
assert.match(coordinator, /standard\.status === "pending"[\s\S]{0,500}result: "unknown"[\s\S]{0,500}mcp-app-ui-message-settlement-unknown/,
  "an outcome-uncertain ui/message request must never trigger a second transport and risk a duplicate user turn");
assert.match(coordinator, /window\.openai\?\.sendFollowUpMessage[\s\S]{0,600}window\.openai\.sendFollowUpMessage\.bind\(window\.openai\)/,
  "ChatGPT Hosts must expose the native follow-up bridge as a first-class transport candidate");
assert.match(coordinator, /if \(typeof standardUiMessage === "function"\)[\s\S]{0,2200}standardPayload = \{ role: "user", content: \[\{ type: "text", text \}\] \}[\s\S]{0,2600}invokeWithSettlementBound\(nativeFollowUp, \{ prompt: text \}\)/,
  "ui/message must be attempted before any native compatibility fallback when ChatGPT exposes window.openai.sendFollowUpMessage");
assert.doesNotMatch(coordinator, /headlessSenderRelay|headless-relay-native-follow-up-disabled/,
  "superseded milestone cards must be inert history rather than a second hidden sender architecture");
assert.doesNotMatch(coordinator, /appTestFollowUp|app\.sendFollowUpMessage\.bind\(app\)/,
  "automatic production delivery must not confuse an App-level lookalike sendFollowUpMessage with a Host user-turn API");
assert.match(coordinator, /invokeWithSettlementBound\(nativeFollowUp, \{ prompt: text \}\)[\s\S]{0,1600}method: "window\.openai\.sendFollowUpMessage"/,
  "the native compatibility fallback must retain bounded settlement diagnostics");
assert.match(coordinator, /DEFAULT_NATIVE_FOLLOW_UP_SETTLEMENT_TIMEOUT_MS = 4_000/,
  "native Host follow-up promise settlement must have a bounded production default");
assert.match(coordinator, /nativeFollowUpSettlementTimeoutMs = Math\.max\(1,[\s\S]{0,240}DEFAULT_NATIVE_FOLLOW_UP_SETTLEMENT_TIMEOUT_MS/,
  "the coordinator must apply the bounded native Host follow-up settlement timeout so DELIVERING cannot hang forever");
assert.match(coordinator, /primary\.status === "pending"[\s\S]{0,900}result: "unknown"[\s\S]{0,900}native-follow-up-settlement-unknown/,
  "a never-settling native Host promise must remain outcome-uncertain instead of being mislabeled as delivered");
assert.match(coordinator, /native-follow-up-call-fulfilled;model-turn-unconfirmed/,
  "a fulfilled native Host API call must remain explicitly distinct from a resumed model ACK");
assert.match(coordinator, /safeSettlementReturnMetadata[\s\S]{0,1200}returnKeys[\s\S]{0,800}elapsedMs/,
  "transport diagnostics must record only bounded structural return metadata and settlement latency");
assert.match(coordinator, /CONTINUATION_SENDER_PROTOCOL_EPOCH = 13/,
  "the Workspace App sender must carry an explicit compatibility epoch so stale in-memory iframes can be fenced after an upgrade");
assert.match(coordinator, /action === "status" \? \{ readOnlyStatus: true \} : \{\}/,
  "every coordinator-owned status probe must be explicitly read-only and unable to ACK a synthetic model turn");
assert.match(coordinator, /async function callSender[\s\S]{0,1600}senderProtocolEpoch: CONTINUATION_SENDER_PROTOCOL_EPOCH/,
  "every hidden sender action must carry the current protocol epoch");
assert.match(coordinator, /async function bindSenderTransport[\s\S]{0,1600}senderProtocolEpoch: CONTINUATION_SENDER_PROTOCOL_EPOCH/,
  "sender bind must carry the current protocol epoch");
assert.match(coordinator, /async function bindSenderTransport\(\)[\s\S]{0,1000}if \(state\.task && terminal\(state\.task\)\) return \{ accepted: false, reason: "task-terminal" \}/,
  "a newly connected Workspace App must be allowed to perform the server-authenticated scope-only sender bind before toolresult hydrates state.task");
assert.doesNotMatch(coordinator, /async function bindSenderTransport\(\)[\s\S]{0,1000}if \(terminal\(state\.task\)\) return \{ accepted: false, reason: "task-terminal" \}/,
  "undefined pre-hydration task state must never be mistaken for a terminal task and suppress the first sender bind");
assert.match(coordinator, /async function heartbeat\(note = "workspace-app"\)[\s\S]{0,1800}senderHeartbeatAuthorized[\s\S]{0,500}state\.anchorMountAcked[\s\S]{0,500}callSender\("heartbeat", \{ note \}\)[\s\S]{0,2200}callTask\("heartbeat", \{ note \}\)/,
  "a verified visible anchor must renew process-local sender authority as well as the durable task/card lease after MCP restart");
assert.match(runtimeStateSource, /const requestedCoordinatorInstanceId = input\.coordinatorInstanceId[\s\S]{0,180}const coordinatorInstanceId = requestedCoordinatorInstanceId \|\| row\.coordinator_instance_id/,
  "task heartbeat may retain legacy display bookkeeping fallback while preserving whether coordinator authority was explicitly presented");
assert.match(runtimeStateSource, /const verifiedAnchorHeartbeat = Boolean\(row\.anchor_mount_verified_at\)[\s\S]{0,220}Boolean\(requestedCoordinatorInstanceId\)[\s\S]{0,220}requestedCoordinatorInstanceId === row\.anchor_mount_coordinator_id/,
  "task heartbeat must require an explicitly presented coordinator identity before renewing visible-card liveness");
const taskHeartbeatSection = runtimeStateSource.match(/if \(action === "heartbeat"\) \{[\s\S]*?\n\s*if \(action === "host-signal"\)/)?.[0] ?? "";
assert.ok(taskHeartbeatSection,
  "continuation_task heartbeat implementation must remain discoverable for sender-authority regression checks");
assert.doesNotMatch(taskHeartbeatSection, /sender_instance_id\s*=|sender_lease_state\s*=|sender_last_heartbeat_at\s*=/,
  "ordinary task/card heartbeat must never create, restore, or renew sender transport authority");
assert.match(runtimeStateSource, /heartbeatContinuationSender\(input = \{\}\)[\s\S]{0,5200}sender_instance_id=\?[\s\S]{0,600}sender_protocol_epoch=\?[\s\S]{0,600}sender_asset_revision=\?[\s\S]{0,600}sender_server_boot_id=\?[\s\S]{0,600}sender_mount_generation=\?[\s\S]{0,600}sender_lease_state='ACTIVE'/,
  "sender heartbeat must renew only the exact already-bound ACTIVE epoch/asset/boot/generation lease");
assert.match(runtimeStateSource, /heartbeatContinuationSender\(input = \{\}\)[\s\S]{0,5200}sender-rebind-required/,
  "sender heartbeat after restart or identity drift must require an explicit bind instead of recreating authority");
assert.match(coordinator, /async function heartbeat\([\s\S]{0,2600}senderHeartbeat\?\.reason === "sender-rebind-required"[\s\S]{0,700}bindSenderTransport\(\)[\s\S]{0,900}consumeRecoveryAfterSenderBind/,
  "a surviving Workspace App must escalate an explicit sender-rebind-required heartbeat to the authenticated bind path and immediately consume recovered READY/ACK work");
assert.match(coordinator, /\.\.\.extra,[\s\S]{0,400}action === "status" \? \{ readOnlyStatus: true \} : \{\}/,
  "coordinator callers must not be able to override readOnlyStatus on a control-plane status probe");
assert.match(server, /CONTINUATION_SENDER_PROTOCOL_EPOCH = 13/,
  "the server must publish the same hidden sender compatibility epoch");
assert.match(server, /sender-protocol-epoch-mismatch/,
  "the server must fail closed when a stale or missing sender epoch reaches the hidden sender bridge");
assert.match(server, /sender-asset-revision-required/,
  "the hidden sender bridge must still require the iframe to identify its concrete resource revision");
assert.match(runtimeStateSource, /assetRevisionDrift:/,
  "resource revision drift must remain observable in diagnostics");
assert.match(runtimeStateSource, /Protocol epoch is the broad wire-compatibility boundary[\s\S]{0,500}exact executable-provenance[\s\S]{0,80}boundary/,
  "runtime must document the separate wire-ABI and exact executable sender authority boundaries");
assert.match(runtimeStateSource, /reason: "sender-asset-revision-mismatch"/,
  "runtime must fail closed when a same-epoch sender carries stale executable App bytes");
assert.match(server, /action: "status", taskId: input\.taskId, readOnlyStatus: true/,
  "server-internal taskId-to-scope lookups must use side-effect-free status rather than consuming synthetic delivery ownership");
assert.match(server, /if \(input\.action === "watch-status"\)[\s\S]{0,700}readOnlyStatus: true/,
  "watch-status must inspect task state without using coordinator liveness traffic as a synthetic model ACK");
assert.match(runtimeStateSource, /reason: "read-only-status"[\s\S]{0,1000}syntheticTokenPending/,
  "runtime read-only status must preserve pending synthetic ownership while exposing enough state for the coordinator supervisor");
assert.match(coordinator, /sendFollowUp\(visibleContinuationTrigger\(state\.task, deliveryToken\)[\s\S]{0,2400}\}\)/,
  "all Host user-message transports must remain behind the exact durable synthetic generation ownership barrier");
assert.match(runtimeStateSource, /state='TURN_ACKED',[\s\S]{0,180}delivered_at=coalesce\(delivered_at,\?\),turn_acked_at=coalesce\(turn_acked_at,\?\)[\s\S]{0,260}state in \('DELIVERING','DELIVERED','WORK_REQUIRED','TURN_ACKED'\)/,
  "the first synthetic status ACK must recover a missing iframe receipt from DELIVERING and persist both delivery and exact generation ACK timestamps");
assert.match(runtimeStateSource, /kind: "continuation-generation-delivery-authorized"[\s\S]{0,900}retryCount[\s\S]{0,600}eventSequence/,
  "generation authorization must journal the timestamp immediately before native Host invocation so scheduling and Host startup latency remain distinguishable");
assert.match(runtimeStateSource, /kind: "continuation-generation-delivery"[\s\S]{0,900}method/,
  "native delivery completion must remain separately journaled for live timing diagnosis");
assert.match(runtimeStateSource, /kind: "continuation-generation-turn-acked"[\s\S]{0,900}deliveryAckStartedAt/,
  "genuine resumed-model ACK must remain separately journaled from transport completion");
assert.match(runtimeStateSource, /if \(result === "unknown"\)[\s\S]{0,1400}outcomeUncertain:\s*true/,
  "an unknown Host settlement must preserve the same canonical generation instead of manufacturing a retry or success state");
assert.match(runtimeStateSource, /syntheticDeliveryPending[\s\S]{0,900}synthetic-delivery-resume-forbidden/,
  "generic resume must fail closed while a generation-backed synthetic delivery still owns pending ACK state");
assert.match(coordinator, /state\.task\?\.state === "FAILED_RETRYABLE"[\s\S]{0,300}!state\.task\?\.continuationDeliveryAwaitingAck[\s\S]{0,300}!state\.task\?\.deliveryToken[\s\S]{0,300}callTask\("resume"\)/,
  "coordinator reconnect must never infer model resume from continuationPending or destroy an ACK-waiting synthetic generation");
assert.ok(visibleTriggerSource,
  "the continuation coordinator must expose one visibleContinuationTrigger(task, deliveryToken) function for the actual Host user-role turn");
for (const [pattern, message] of [
  [/继续。@DevSpace MCP/, "the compact Chinese synthetic turn must begin like the proven manual continue while explicitly activating DevSpace MCP"],
  [/Continue\. @DevSpace MCP/, "the compact English synthetic turn must begin like the proven manual continue while explicitly activating DevSpace MCP"],
  [/像人工发送“继续”一样持续完成未完成任务/, "the Chinese visible handoff must stay close to the proven manual continue baseline"],
  [/exactly like a manual 'continue'/, "the English visible handoff must stay close to the proven manual continue baseline"],
  [/continuation_task action=status/, "the visible handoff must still require the mandatory first status call"],
]) {
  assert.match(visibleTriggerSource, pattern, message);
}
assert.doesNotMatch(coordinator, /继续。直接完成当前未完成的任务。|Continue\. Directly complete the current unfinished task\./,
  "the visible synthetic continuation trigger must not pressure the model to skip state reconstruction or verification");
assert.doesNotMatch(visibleTriggerSource, /当前任务：\$\{objective\}|下一未完成里程碑：\$\{milestone\}|Current task: \$\{objective\}|Next unfinished milestone: \$\{milestone\}/,
  "the visible Host envelope must not replay the durable objective/milestone payload after a delayed stale message can no longer be cancelled");
assert.doesNotMatch(visibleTriggerSource, /taskId=|workspaceId=|generation capability/,
  "taskId/workspaceId/recovery policy must not be emitted as a visible user message; only the exact one-time deliveryToken may cross the live Host turn-origin boundary");
assert.match(coordinator, /function continuationContext\(/,
  "the coordinator must define hidden continuation context for resumed turns");
assert.match(coordinator, /Call continuation_task status first\.[\s\S]{0,900}one-time deliveryToken[\s\S]{0,900}echo that exact token[\s\S]{0,900}omit manualTakeover[\s\S]{0,900}runtime consumes it immediately/,
  "hidden context must require the exact one-time deliveryToken on the first synthetic status while keeping manualTakeover absent");
assert.match(coordinator, /Tool availability is turn-scoped[\s\S]{0,900}api_tool\.list_resources[\s\S]{0,300}DevSpace_MCP[\s\S]{0,300}continuation_task/,
  "synthetic continuation hidden context must discover DevSpace_MCP through the Host connector path when tool schemas were not preloaded for the resumed turn");
assert.match(coordinator, /do not stop or claim that DevSpace is unavailable/,
  "missing preloaded DevSpace schemas must not be treated as lost conversation authorization");
assert.match(coordinator, /reconstruct the current durable state[\s\S]{0,500}latest available DevSpace evidence[\s\S]{0,500}failure, race, or regression risks[\s\S]{0,500}do not emit a chain-of-thought transcript/,
  "hidden recovery context must require evidence-backed state reconstruction and risk checks before action without exposing private reasoning");
assert.match(coordinator, /function nextUnresolvedMilestone\([\s\S]{0,900}required\.find\(\(milestone\) => !completed\.has\(milestone\)\)/,
  "automatic continuation context must identify the first unresolved milestone instead of forcing the resumed model to rediscover it from a long lifetime history");
assert.match(coordinator, /nextUnresolvedMilestone:/,
  "hidden recovery context must include the durable next unresolved milestone");
assert.match(coordinator, /Connector discovery and continuation_task status are control-plane setup, not successful resumed work/,
  "hidden recovery context must classify discovery/status as setup rather than resumed work");
assert.match(coordinator, /do not produce a final response after discovery\/status, one ordinary tool call, or a checkpoint/,
  "hidden recovery context must forbid early finalization while runnable milestones remain");
assert.match(coordinator, /discovery-only\/status-only or one-tool-and-final turn is an invalid automatic continuation/,
  "hidden recovery context must make substantive post-status work mandatory whenever runnable milestones remain");
assert.match(coordinator, /const modelContextUpdate = updateModelContextBestEffort[\s\S]{0,800}callSender\("claim"[\s\S]{0,900}await modelContextUpdate[\s\S]{0,1400}callSender\("authorize-delivery"[\s\S]{0,2200}sendFollowUp\(visibleContinuationTrigger\(state\.task,\s*deliveryToken\),\s*async \(\) =>/,
  "automatic delivery may overlap advisory model-context hydration with claim, but must still re-authorize synthetic ownership immediately before the visible Host trigger");
assert.match(coordinator, /sendFollowUp\(visibleContinuationTrigger\(state\.task,\s*deliveryToken\),\s*async \(\) => \{[\s\S]{0,800}callTask\("status"\)[\s\S]{0,600}!terminal\(latest\.task\)/,
  "the irreversible Host send must have a final authoritative terminal-state recheck");
assert.match(coordinator, /function acceptTask\([\s\S]{0,1700}terminal\(state\.task\)[\s\S]{0,300}stopSupervisor\(\)[\s\S]{0,200}stopLifecycleRefresh\(\)/,
  "observing terminal state must synchronously cancel supervisor and lifecycle timers");
assert.match(runtimeStateSource, /closeTerminalContinuationArtifacts\([\s\S]{0,5200}state='NO_WORK'[\s\S]{0,3400}delivery_token=null[\s\S]{0,2200}stall_armed_at=null/,
  "terminal task transitions must seal synthetic generations and clear pending delivery/retry/stall state");
assert.match(server, /if \(!coordinatorCall && !continuationControlCall && conversationScopeId && structuredRuntimeState\)[\s\S]{0,1300}touchContinuationModelActivity\([\s\S]{0,260}substantive: false/,
  "the wrapper may retain non-substantive telemetry for ordinary tools only after excluding all continuation control-plane calls");
assert.doesNotMatch(server, /if \(!coordinatorCall && conversationScopeId && structuredRuntimeState\)[\s\S]{0,1300}touchContinuationModelActivity/,
  "continuation_anchor/continuation_task must be excluded before the wrapper can touch model activity or renew the Turn Lease");
assert.match(server, /const boundTaskConversationScopeId = input\.taskId[\s\S]{0,1200}const conversationScopeId = input\.coordinatorInstanceId[\s\S]{0,500}requestConversationScopeId \?\? boundTaskConversationScopeId/,
  "model continuation control calls with stripped Host metadata must reuse the exact existing task scope instead of creating host-scope-unavailable shadows");
assert.doesNotMatch(server, /\?\? "host-scope-unavailable"/,
  "1.1.56 must never fabricate a shared non-canonical conversation identity");
assert.match(server, /const setupOnlyCall = name === "open_workspace"/,
  "server wrapper must classify open_workspace as setup-only");
assert.match(server, /substantive: !setupOnlyCall/,
  "successful non-control tool completion must provide substantive resumed-work proof while open_workspace does not");
const beginRequestIndex = server.indexOf("beginContinuationModelRequest(conversationScopeId)");
const authorizeRequestIndex = server.indexOf("continuationModelToolAuthorization({ conversationScopeId })");
const handlerIndex = server.indexOf("result = await handler(input, context)", authorizeRequestIndex);
const finalReleaseIndex = server.indexOf("releaseModelRequest?.();", handlerIndex);
assert.ok(beginRequestIndex >= 0 && authorizeRequestIndex > beginRequestIndex,
  "ordinary model-originated DevSpace requests must register their in-flight lease before ownership authorization");
assert.ok(handlerIndex > authorizeRequestIndex && finalReleaseIndex > handlerIndex,
  "ordinary model-originated DevSpace handlers must hold the in-flight lease through their real execution lifetime and release it in finally");
assert.match(server.slice(authorizeRequestIndex, handlerIndex), /authorization\?\.accepted === false[\s\S]{0,180}releaseModelRequest\?\.\(\)/,
  "an ownership rejection must release the pre-registered in-flight lease before returning fail-closed");
assert.match(server, /"devspace\/continuation-sender": capability/,
  "an issued conversation card must be able to pass sender authority privately through result _meta to a newer ordinary Workspace App transport");
assert.doesNotMatch(server, /Substantive DevSpace work remains fail-closed|No substantive workspace operation is permitted while verification is pending|keep substantive work fail-closed until the original iframe ACK/,
  "a delayed or missing iframe ACK must never indefinitely block read/edit/shell work after the one card was issued");
assert.match(server, /anchorMountVerificationPending[\s\S]{0,900}substantive work remains enabled/,
  "pending iframe verification must be informational after the immutable card issuance, not an execution gate");
assert.match(runtimeStateSource, /continuationSenderCapability\(input = \{\}\)[\s\S]{0,2200}mount_requested_at[\s\S]{0,1000}anchorMountVerified/,
  "sender capability must exist from the requested card generation even before iframe ACK");
const bindContinuationSenderIndex = runtimeStateSource.indexOf("bindContinuationSender(input = {})");
const recoverCanonicalProjectionIndex = runtimeStateSource.indexOf("recoverCanonicalConversationTaskProjection(input = {})", bindContinuationSenderIndex);
const bindContinuationSenderSource = bindContinuationSenderIndex >= 0 && recoverCanonicalProjectionIndex > bindContinuationSenderIndex
  ? runtimeStateSource.slice(bindContinuationSenderIndex, recoverCanonicalProjectionIndex)
  : "";
assert.match(bindContinuationSenderSource, /state='READY'[\s\S]*readyGeneration/,
  "sender bind must surface an already-durable READY generation so a newly mounted ordinary App can consume it immediately");
assert.match(bindContinuationSenderSource, /sender-claim-owned-by-live-sender/,
  "sender bind must preserve a live sender's still-valid CLAIMED generation instead of returning it to READY");
assert.match(runtimeStateSource, /recordContinuationHostTelemetry\(input = \{\}\)[\s\S]{0,6200}continuation-host-telemetry/,
  "Host-surface telemetry must remain an event-journal diagnostic instead of becoming continuation authorization state");
assert.match(runtimeStateSource, /recordContinuationSenderHostTimeout\(input = \{\}\)[\s\S]{0,3600}stale-sender-turn-lease[\s\S]{0,2600}sender-mount-generation-mismatch/,
  "a missing current card iframe may fall back only to a sender capability bound to the exact current turn and card generation");
assert.match(runtimeStateSource, /senderTimeoutCapabilityVerified[\s\S]{0,500}expectedTurnLeaseId[\s\S]{0,600}exactTurnSenderTimeout/,
  "runtime Host-signal authorization must distinguish an internally verified exact-turn sender timeout from model-visible lifecycle calls");
assert.match(server, /z\.enum\(\["bind",\s*"heartbeat",\s*"telemetry",\s*"host-timeout",\s*"claim",\s*"authorize-delivery",\s*"delivery-result"\]\)/,
  "the dedicated sender bridge must expose the exact-turn host-timeout action without adding sender actions to continuation_task");
assert.match(server, /function senderHostCompatibleToolMeta\([\s\S]{0,900}visibility:\s*\["model",\s*"app"\][\s\S]{0,220}"openai\/widgetAccessible":\s*true/,
  "the sender bridge must use the Host-compatible model+app Apps-SDK visibility while keeping server-side capability fencing authoritative");
assert.match(server,
  /registerAppTool\(server,\s*"continuation_anchor"[\s\S]{0,14000}\.\.\.toolWidgetDescriptorMeta\(config,\s*"continuation-anchor"\)/,
  "the visible continuation anchor must use the model-only UI-source descriptor from the last live Host-proven mount contract");
assert.doesNotMatch(server,
  /registerAppTool\(server,\s*"continuation_anchor"[\s\S]{0,14000}\.\.\.appCallableToolMeta\(config,\s*"continuation-anchor"\)/,
  "the UI-bearing continuation anchor must not also be widgetAccessible/model+app");
assert.match(server, /workspace-app-self-contained-bootstrap-v13-stale-synthetic-self-suppression/,
  "dev66 must rotate the immutable Workspace App revision so Host caches receive stale synthetic self-suppression");
assert.doesNotMatch(coordinator, /const ANCHOR_TOOL = "continuation_anchor";/,
  "new Workspace Apps must not depend on calling back through the visible source tool");
assert.match(coordinator,
  /async function callTask[\s\S]{0,1800}name: TASK_TOOL[\s\S]{0,500}\baction,/,
  "all mounted Apps must route task control through the separately app-callable continuation_task target");
assert.match(coordinator,
  /async function callSender[\s\S]{0,2000}name: SENDER_TOOL[\s\S]{0,500}\baction,/,
  "all mounted Apps must route sender control through the dedicated Host-compatible continuation_sender target");
assert.match(coordinator,
  /async function bindSenderTransport[\s\S]{0,2600}name: SENDER_TOOL[\s\S]{0,500}action: "bind"/,
  "sender bind must use the dedicated Host-compatible sender target rather than the UI source tool");
assert.match(server,
  /bridgeAction: z\.enum\([\s\S]{0,900}"sender-authorize-delivery"/,
  "continuation_anchor must retain cached-App same-source sender bridge actions for compatibility");
assert.match(server,
  /if \(input\.bridgeAction\)[\s\S]{0,700}runContinuationSenderBridge\(/,
  "cached same-source sender calls must still delegate into the existing capability-fenced runtime path");
assert.match(server,
  /if \(input\.bridgeAction\)[\s\S]{0,1800}Never emit outputTemplate\/_meta here/,
  "cached same-source control calls must never create a second visible milestone card");
assert.doesNotMatch(server, /function appOnlyToolMeta\(/,
  "dev59 must not depend on the Host-unreliable app-only sender visibility path");
assert.match(server, /input\.action === "host-timeout"[\s\S]{0,700}recordContinuationSenderHostTimeout/,
  "the sender host-timeout route must terminate in the runtime capability validator");
assert.match(coordinator, /hostSignal === "timeout"[\s\S]{0,1200}callSender\("host-timeout"[\s\S]{0,500}turnLeaseId:\s*state\.task\.turnLeaseId/,
  "when ChatGPT omits a current card iframe, explicit timeout must retain exact-turn Host authority through the current sender relay");
assert.doesNotMatch(coordinator, /callSender\("host-(?:teardown|signal)"/,
  "generic teardown must remain excluded from the sender fallback so iframe disposal cannot become a false continuation trigger");
assert.match(coordinator, /function safeTelemetryName\(value\)[\s\S]{0,260}A-Za-z0-9\._:\/-/,
  "the coordinator must bound telemetry to safe Host API key/method names instead of arbitrary content");
assert.match(coordinator, /window\.addEventListener\("openai:set_globals",\s*onOpenAiGlobals\)/,
  "the coordinator must observe Host global-surface changes");
assert.match(coordinator, /callSender\("telemetry",\s*\{\s*telemetry:\s*payload\s*\}\)/,
  "the coordinator must report Host-surface names through the hidden sender bridge");
assert.match(coordinator, /async function consumeRecoveryAfterSenderBind\([\s\S]{0,1800}readyGeneration[\s\S]{0,900}attemptContinuation\(readyReason, \{ force: true, skipPrepare: true \}\)/,
  "a newly bound sender transport must still immediately consume READY instead of waiting for another supervisor tick");
assert.match(coordinator, /continuationDeliveryAwaitingAck\)[\s\S]{0,180}deliveryAckRetryDue\(state\.task\)[\s\S]{0,900}no visible message will be retransmitted/,
  "an overdue delivery ACK must remain diagnostic and must not retransmit a visible message that could interrupt a slow-starting model");
assert.doesNotMatch(coordinator, /continuationDeliveryAwaitingAck\)[\s\S]{0,180}deliveryAckRetryDue\(state\.task\)[\s\S]{0,500}attemptContinuation/,
  "ACK uncertainty must never call the visible continuation transport again");
assert.match(coordinator, /bindSenderTransport\(\)[\s\S]{0,900}consumeRecoveryAfterSenderBind\(bound/,
  "ordinary Workspace App bind/rehydrate must wire directly into deterministic READY/ACK-retry recovery");
assert.match(coordinator, /const current = await callTask\("status"\)[\s\S]{0,3200}current\?\.readyGeneration[\s\S]{0,900}attemptContinuation\("supervisor discovered READY generation", \{ force: true, skipPrepare: true \}\)/,
  "an already-bound or generation-safely rebound sender must consume a READY generation that appears later during an ordinary supervisor status refresh");
assert.match(server, /const continuationWakeClients = new Set\(\)/,
  "the resident server must keep a bounded wake-only subscriber set instead of relying exclusively on a background iframe timer");
assert.match(server, /res\.write\(`event: wake\\ndata: \$\{JSON\.stringify\(\{ reason \}\)\}\\n\\n`\)/,
  "the resident wake channel must emit only a wake reason payload rather than continuation authority");
assert.match(server, /createContinuationSupervisorScheduler\(\{[\s\S]{0,1600}if \(sweep\.ready\.length > 0\)[\s\S]{0,1200}broadcastContinuationWake\("ready-generation"\)/,
  "the resident server must push a wake-only event specifically when the authoritative supervisor persists a READY generation");
assert.doesNotMatch(server, /wakeMcpAppSessions|continuation-host-metadata-wake/,
  "READY and ACK health must not broadcast catalog notifications as an unverified Host execution API");
assert.match(server, /continuation-sender-ready-observed[\s\S]{0,100}continuation-sender-claim-result/,
  "sender diagnostics must distinguish READY observation from an actual claim decision");
assert.match(supervisorSource, /runtimeState\.continuationSupervisorSweep\(\)/,
  "the durable supervisor scheduler must execute the authoritative runtime sweep rather than invent continuation state");
assert.match(supervisorSource, /run\("startup"\)[\s\S]{0,300}setInterval\(\(\) => run\("interval"\), intervalMs\)/,
  "the durable supervisor scheduler must immediately recover persisted state at startup and remain resident independently of Workspace App timers");
assert.match(server, /input\.action === "claim" && outcome\?\.accepted[\s\S]{0,320}scheduleClaimRecovery\?\.\(outcome\)/,
  "the server must register a sender-claim recovery timer as soon as the generation CAS succeeds");
assert.match(supervisorSource, /claim\.claimDueAt[\s\S]{0,1000}run\("sender-claim-lease"\)/,
  "a CLAIMED generation must receive a lease-exact recovery sweep even if the ordinary resident interval is delayed");
assert.match(server, /sweep\.deliveryAckRetryDue[\s\S]{0,1200}broadcastContinuationWake\("delivery-ack-retry-due"\)/,
  "the resident server must also wake surviving sender Apps when a persisted pre-ACK startup retry deadline matures without manufacturing a new generation");
assert.match(server, /app\.get\("\/mcp-app-assets\/continuation-wake"[\s\S]{0,500}text\/event-stream[\s\S]{0,700}writeContinuationWake\(res, "connected"\)/,
  "a recreated/surviving Workspace App must be able to subscribe to the same-origin READY wake channel and immediately refresh durable state");
assert.match(server, /writeContinuationWake[\s\S]{0,900}res\.flush\?\.\(\)/,
  "wake frames must be explicitly flushed instead of relying on proxy/chunk buffering latency");
assert.match(server, /continuation-wake[\s\S]{0,650}X-Accel-Buffering[\s\S]{0,120}no/,
  "the SSE wake endpoint must opt out of intermediary response buffering");
assert.doesNotMatch(server, /writeContinuationWake\([\s\S]{0,180}taskId|writeContinuationWake\([\s\S]{0,180}deliveryToken|writeContinuationWake\([\s\S]{0,180}anchorMountToken/,
  "wake events must not carry task or delivery authority");
assert.match(coordinator, /new EventSource\(CONTINUATION_WAKE_URL\)[\s\S]{0,500}addEventListener\("wake"[\s\S]{0,350}supervisorTick\(\{ forceAuthoritative: true \}\)/,
  "a wake event must force authoritative status/CAS handling rather than directly manufacturing a Host follow-up");
assert.match(coordinator, /startFetchWakeSource\(\)[\s\S]{0,1800}fetch\(CONTINUATION_WAKE_URL[\s\S]{0,1800}event:\\s\*wake[\s\S]{0,700}supervisorTick\(\{ forceAuthoritative: true \}\)/,
  "the wake channel must retain a streamed-fetch hedge so background iframe timer/EventSource throttling cannot be the only READY discovery path");
assert.match(coordinator, /const modelContextUpdate = updateModelContextBestEffort[\s\S]{0,650}const claim = await callSender\("claim"[\s\S]{0,500}await modelContextUpdate[\s\S]{0,900}callSender\("authorize-delivery"/,
  "model-context hydration must overlap the generation claim while the final authorize-delivery CAS remains immediately before Host send");
assert.match(coordinator, /继续。@DevSpace MCP/,
  "the compact synthetic user-role request must preserve an explicit DevSpace connector activation cue");
assert.match(runtimeStateSource, /manual-user-turn-takeover/,
  "runtime must retain an old-schema-compatible manual takeover CAS marker on the existing note field");
assert.match(server, /older cached schema without manualTakeover[\s\S]{0,500}manual-user-turn-takeover/,
  "server guidance must document the manual takeover fallback for already-open Hosts whose continuation_task schema is stale");
assert.match(coordinator, /function senderTransportAvailable\(\)[\s\S]{0,500}anchorMountRequestedAt[\s\S]{0,240}activeSenderCapability\(\)/,
  "a later trusted Workspace App relay must keep sender transport available while the original iframe ACK is pending");
assert.match(coordinator, /same full Host reasoning budget and sustained execution semantics as a manual 'continue'[\s\S]{0,500}polling owned long-running processes[\s\S]{0,900}genuine coherent stage boundary/,
  "hidden recovery context must give synthetic turns the same reasoning/execution budget and model-owned stage boundary as manual continuation");
assert.match(runtimeStateSource, /syntheticResumeWorkRequired:\s*row\.delivery_owner === "synthetic-active"[\s\S]{0,220}deliveryOwnerExpiresAt/,
  "runtime status must retain a durable resumed-turn work obligation after the connectivity ACK");
assert.match(runtimeStateSource, /SYNTHETIC_WORK_OWNER_LEASE_MS = 30 \* 60_000/,
  "synthetic ownership must remain durable across manual-like reasoning/execution intervals rather than expiring after a few tens of seconds");
assert.match(runtimeStateSource, /const minimumWorkDelta = owner === "synthetic" \? 4 : 1/,
  "manual turn-complete must keep the one-operation anti-empty floor while synthetic resumes require four post-ACK substantive operations");
assert.doesNotMatch(runtimeStateSource, /SYNTHETIC_MIN_ACTIVE_WORK_MS|syntheticMinimumActiveWorkMs/,
  "synthetic voluntary completion must not retain a fixed-duration fallback");
assert.doesNotMatch(runtimeStateSource, /SYNTHETIC_CONFIRMED_HOST_BUDGET_RATIO|syntheticAdaptiveActiveWorkGate|synthetic-host-budget-calibration-required|synthetic-turn-min-active-work-required/,
  "Host timing telemetry must not become a synthetic completion budget or percentage gate");

for (const [pattern, message] of [
  [/at least four substantive DevSpace operations after its ACK/, "hidden synthetic context must require the four-operation post-ACK anti-idle floor"],
  [/four operations are only an anti-idle floor and are never a target duration or an automatic reason to stop/, "hidden synthetic context must keep the four-operation floor from becoming a target"],
  [/genuine coherent stage boundary[\s\S]{0,260}turn-complete[\s\S]{0,260}next automatic continuation/, "hidden synthetic context must allow a real stage handoff that chains remaining milestones"],
  [/never a fixed number of minutes or a learned Host-budget percentage/, "hidden synthetic context must reject both fixed and learned duration budgets"],
  [/across multiple milestones/, "hidden synthetic context must keep one resumed turn working across multiple milestones"],
]) {
  assert.match(coordinator, pattern, message);
}
assert.match(runtimeStateSource, /const materialCheckpoint = gainedCompletedMilestone \|\| progressChanged \|\| evidenceChanged/,
  "synthetic resume completion must require a material checkpoint rather than an arbitrary control checkpoint");
assert.match(runtimeStateSource, /Number\(row\.substantive_activity_count \|\| 0\) > Number\(row\.delivery_work_baseline_count \|\| 0\)/,
  "synthetic resume completion must prove post-ACK work with a monotonic activity-count baseline rather than timestamp ordering");
assert.match(runtimeStateSource, /const syntheticTurnMayYield = remainingAfterCheckpoint\.length === 0 \|\| state !== "RUNNING"[\s\S]{0,220}const fulfillsSyntheticResume = realToolAfterSyntheticAck && materialCheckpoint && syntheticTurnMayYield/,
  "synthetic resume ownership must survive material checkpoints until the runnable milestone set is complete or explicitly blocked");
assert.match(migrations, /version: 29[\s\S]{0,180}continuation-synthetic-work-baseline[\s\S]{0,240}migrateContinuationSyntheticWorkBaseline/,
  "the synthetic work baseline must be added through a durable SQLite migration");
assert.doesNotMatch(coordinator, /synthetic resume work ownership lease expired|syntheticResumeWorkRetryDue/,
  "synthetic ownership expiry must not be a client-side continuation trigger in dev12");
assert.match(coordinator, /Never end an automatically resumed turn with prose[\s\S]{0,700}There is no background model execution after a plain assistant final[\s\S]{0,900}turn-complete[\s\S]{0,600}concise visible progress summary/,
  "synthetic recovery context must forbid placeholder finals while allowing a legal visible stage summary after turn-complete");
assert.match(runtimeStateSource, /const syntheticTurnLeaseId = String\(syntheticOwnerTask\?\.turn_lease_id[\s\S]{0,260}const syntheticCompletionLeaseId = String\(syntheticOwnerTask\?\.assistant_turn_completion_lease_id[\s\S]{0,420}const syntheticMode = normalizedContinuationMode[\s\S]{0,420}const syntheticTurnEnded =[\s\S]{0,520}syntheticCompletionLeaseId === syntheticTurnLeaseId/,
  "synthetic retry must require a terminal ATCC state bound to the exact current resumed-turn lease");
assert.match(runtimeStateSource, /const endedSyntheticWork =[\s\S]{0,500}syntheticTurnEnded[\s\S]{0,300}!this\.continuationModelRequestInFlight/,
  "a synthetic generation may be retired immediately only after exact ended-turn evidence and with no model request still in flight");
assert.ok(runtimeStateSource.includes("lease expiry alone never retires a live turn")
  && runtimeStateSource.includes("Waiting for a 30-minute owner lease after a proven")
  && runtimeStateSource.includes("strands healthy long-running monitoring work"),
  "the long synthetic ownership lease must be bookkeeping only: it cannot authorize a duplicate live turn, and it cannot delay a turn whose exact end is already proven");
assert.ok(runtimeStateSource.includes("const applyManualRoundPlan = (currentRow) =>")
  && runtimeStateSource.includes("milestoneSetChanged ? { forceNewWorkset: true } : {}")
  && runtimeStateSource.includes("manualMilestoneSetChanged: true"),
  "the first manual status must atomically install a different user milestone plan before rotating that user message's fresh card");
assert.ok(runtimeStateSource.includes("const isolateCurrentActivePlan = authoritativeActiveWorkset")
  && runtimeStateSource.includes("const freezeCompletedCanonicalPlan = canonicalPlanAlreadyComplete")
  && runtimeStateSource.includes("&& !activeShadowTask\n                && !authoritativeActiveWorkset;")
  && runtimeStateSource.includes("const projectedMilestoneRows = isolateCurrentActivePlan")
  && runtimeStateSource.includes(": freezeCompletedCanonicalPlan ? [] : lifetimeMilestoneRows;"),
  "canonical projection recovery must isolate the active plan and freeze an already-completed canonical plan while card ACK is pending, without discarding lifetime lineage needed for disaster recovery");
assert.doesNotMatch(runtimeStateSource, /const confirmedHostCutoff|const confirmedSyntheticCutoff/,
  "old single-sample and synthetic quiet-cutoff heuristics must remain removed");
assert.match(runtimeStateSource, /if \(result === "unknown"\)[\s\S]{0,1800}outcomeUncertain:\s*true/,
  "an unknown Host delivery result must remain outcome-uncertain instead of being converted into an automatic retry");
assert.match(runtimeStateSource, /DELIVERING is an outcome-uncertain zone[\s\S]{0,900}preserve the same generation/,
  "the delivery FSM must explicitly document that a lost send callback cannot authorize a duplicate continuation");
assert.match(coordinator, /deliveryAckRetryDue[\s\S]{0,1800}no visible message will be retransmitted/,
  "delivery ACK deadline may drive diagnostics but never visible retransmission");
assert.match(coordinator, /TRANSIENT_RETRY_DELAYS_MS = \[0, 500, 1_500, 3_000, 5_000\]/,
  "post-sendMessage MCP readiness must stay inside a ten-second bounded retry window");
assert.match(server, /call continuation_anchor exactly once before substantive DevSpace work/,
  "each manual round must issue its milestone card exactly once before substantive DevSpace work");
assert.match(server, /Repeated checkpoints with the same required milestone set[\s\S]{0,260}reuse the current generation and must not render duplicates/,
  "same-milestone synthetic work must reuse the current visible-card generation without duplicate rendering");
assert.match(server, /anchorMountVerificationPending is true, keep using the requested generation while verification arrives/,
  "pending iframe verification must keep using the requested generation instead of minting a duplicate card");
assert.match(server, /const finalResponseAllowed = outcome\.finalResponseAllowed !== false/,
  "Task Contract rendering must preserve the structured finalResponseAllowed gate");
assert.match(server, /protocol:\s*"devspace-pre-final-barrier-v1"[\s\S]{0,900}mustContinueSameTurn/,
  "ordinary DevSpace results must expose a compact machine-readable pre-final barrier while unfinished work remains");
assert.match(server, /workTicket:\s*"synthetic-execution-v3"[\s\S]{0,1200}nextAction:\s*"CALL_SUBSTANTIVE_DEVSPACE_TOOL_NOW"/,
  "a resumed synthetic ACK must be an execution handoff, not a generic status ticket");
assert.match(server, /recordContinuationResumeOperation\([\s\S]{0,1800}continuationResumeOperation\(name, input, result\)/,
  "ordinary successful tools must persist a bounded execution resume capsule");
assert.match(runtimeStateSource, /resumeContext:\s*parseJson\(row\.resume_context_json, \{\}\)/,
  "runtime task projection must expose the durable execution resume capsule");
assert.match(runtimeStateSource, /RESUME_CONTEXT_MAX_OPERATIONS\s*=\s*20/,
  "resume capsule must keep a bounded recent-operation window");
assert.match(coordinator, /resumeExecutionContext:[\s\S]{0,1400}latest concrete operation/,
  "the final Host model context must carry the durable execution resume capsule");
assert.match(server, /requiredMilestones[\s\S]{0,700}completedMilestones[\s\S]{0,700}nextMilestone[\s\S]{0,900}executionContract/,
  "the synthetic ACK must restore the exact actionable milestone ledger omitted by the dev71 compact projection");
assert.match(server, /MANDATORY NEXT OUTPUT:[\s\S]{0,320}ACK\/status is not work[\s\S]{0,700}genuine stage boundary[\s\S]{0,700}concise visible progress summary/,
  "synthetic ACK must forbid zero-work/placeholder finals while preserving a legal visible stage handoff");
assert.match(coordinator, /像人工发送“继续”一样直接做实质工作[\s\S]{0,320}达到真实阶段边界时先调用 turn-complete[\s\S]{0,260}若里程碑仍未完成，随后应继续自动续下一轮/,
  "the visible synthetic handoff must require real work, a legal visible stage summary, and automatic chaining");
assert.match(coordinator, /Host rendering of text between tool calls is not reliable[\s\S]{0,420}reliable user-visible checkpoint is the stage summary after a legal turn-complete/,
  "automatic continuation must not depend on unreliable in-turn prose for visibility");
assert.match(coordinator, /Once turn-complete is accepted[\s\S]{0,320}concise visible progress summary[\s\S]{0,320}next synthetic continuation should be scheduled automatically/,
  "a legal synthetic stage boundary must produce visible output and chain remaining work");
assert.match(server, /DEVSPACE SYNTHETIC EXECUTION HANDOFF \[P0\][\s\S]{0,900}executionDirective/,
  "the synthetic execution directive must precede the JSON result so the resumed model sees it before status data");
assert.match(server, /DEVSPACE PRE-FINAL BARRIER \[MUST OBEY BEFORE ANY USER-VISIBLE FINAL\][\s\S]{0,900}nextAction=\$\{barrier\.nextAction\}/,
  "the pre-final barrier must expose a machine-readable next action before any legal final boundary");
assert.match(server, /CONTINUE_SUBSTANTIVE_WORK_OR_LEGAL_CONTROL[\s\S]{0,1600}PLAIN OR EMPTY FINAL IS FORBIDDEN[\s\S]{0,1600}turn-complete[\s\S]{0,1000}progress summary/,
  "an unfinished synthetic data-plane result must forbid bare finals while exposing the legal turn-complete stage handoff");
assert.match(server, /FINAL DevSpace control call MUST be continuation_task action=turn-complete/,
  "manual incomplete-stage boundaries must retain explicit turn-complete guidance");
assert.match(server, /content:\s*\[\.\.\.barrierContent, \.\.\.\(Array\.isArray\(senderCapableResult\?\.content\)/,
  "the pre-final barrier must precede the ordinary tool payload so the model cannot overlook it after a successful result");
assert.match(server, /devspacePreFinalBarrier:\s*barrier/,
  "ordinary structured tool results must expose the same pre-final barrier as machine-readable state");
assert.doesNotMatch(server, /task:\s*taskContractOutcome\?\.task|taskContract:\s*taskContractOutcome/,
  "ordinary data-plane results must not echo the full mutable task, evidence, or resume capsule on every operation");
assert.doesNotMatch(server, /outputSchema:[\s\S]{0,420}task:\s*z\.unknown\(\)\.optional\(\)[\s\S]{0,220}taskContract:\s*z\.unknown\(\)\.optional\(\)/,
  "ordinary tool schemas must expose only the compact barrier rather than advertising full control-plane projections");
assert.match(server, /DO NOT produce a final response now[\s\S]{0,420}same assistant turn[\s\S]{0,620}turn-complete[\s\S]{0,520}waitingExternal=true/,
  "the compact ordinary-tool barrier must forbid a bare final and expose only the legal same-turn/stage-boundary/external-wait exits");
assert.match(server, /status\/progress\/checkpoint summary[\s\S]{0,420}not a legal final boundary/,
  "the compact data-plane barrier must forbid using a checkpoint/progress summary as a yield boundary");
assert.match(server, /Manual and synthetic turns otherwise use the same full Host reasoning budget[\s\S]{0,700}resumed turn is not one-milestone-per-turn/,
  "the control-plane contract must preserve manual-equivalent sustained-work semantics without replaying them on every data-plane result");
assert.match(server, /nextRequiredMilestones/,
  "Task Contract results must expose remaining milestones as structured state instead of relying on a prose ACK convention");
assert.match(server, /taskIncomplete:\s*Boolean\(outcome\.taskIncomplete\)[\s\S]{0,520}finalResponseAllowed/,
  "ordinary DevSpace work must surface compact machine-readable incomplete/final-response state without replaying the full contract");
assert.match(server, /nextAction:\s*mustContinueSameTurn[\s\S]{0,520}CONTINUE_SUBSTANTIVE_WORK_OR_LEGAL_CONTROL[\s\S]{0,700}remainingMilestones/,
  "the compact barrier must carry the legal-work-or-stage-boundary action together with remaining milestones");
assert.match(server, /continueInSameTurn:\s*outcome\.continueInSameTurn/,
  "continuation_task structured projection must expose the same-turn sustained-work directive without duplicating it into prose");
assert.match(server, /syntheticWorkMustContinue:\s*outcome\.syntheticWorkMustContinue/,
  "continuation_task structured projection must expose the synthetic sustained-work directive without duplicating it into prose");
assert.match(server, /continueInSameTurn:\s*z\.boolean\(\)\.optional\(\)/,
  "continuation_task structured output must expose continueInSameTurn");
assert.match(server, /syntheticWorkMustContinue:\s*z\.boolean\(\)\.optional\(\)/,
  "continuation_task structured output must expose syntheticWorkMustContinue");
assert.match(server, /Retry transient transport failures over bounded readiness backoff before declaring failure/,
  "server guidance must retain bounded transport-readiness retries");
assert.match(server, /Before replaying uncertain side effects, inspect durable state/,
  "transport recovery must remain side-effect aware before replaying uncertain mutations");
assert.match(server, /CONVERSATION_CARD_PRECONDITION[\s\S]{0,1300}Every manual user message that actually uses DevSpace owns exactly one fresh visible milestone card/,
  "every ordinary DevSpace tool description must establish one visible milestone card per manual user message");
assert.match(server, /manualTakeover=true exactly once[\s\S]{0,800}continuation_anchor exactly once before substantive DevSpace work/,
  "manual turn ownership and card issuance must each happen exactly once");
assert.match(server, /Synthetic\/App continuation turns MUST omit manualTakeover and reuse the current card while requiredMilestones is unchanged/,
  "synthetic continuations must reuse the current manual-round card while the milestone set is unchanged");
assert.match(server, /sourceTool: "continuation_task", anchorMounted: false/,
  "headless continuation_task begin must never mark the visible continuation anchor as mounted");
assert.match(server, /sourceTool: "continuation_anchor"[\s\S]{0,900}replaceActiveMilestones: true[\s\S]{0,500}anchorMounted: false/,
  "continuation_anchor must use the trusted active-plan replacement path without fabricating actual iframe telemetry");
assert.match(server, /anchorMounted: false[\s\S]{0,1200}prepareContinuationAnchorMount/,
  "the model-side continuation_anchor invocation must issue the single card result and mount token only after the unmounted task transition");
assert.match(server, /anchorMountToken:\s*z\.string\(\)\.uuid\(\)\.optional\(\)\.describe\("Card-generation capability returned only by continuation_anchor\./,
  "the continuation tool contract must retain the immutable-card token capability needed for same-card iframe rehydration");
assert.match(server, /anchorMountGeneration:\s*z\.number\(\)\.int\(\)\.nonnegative\(\)\.optional\(\)\.describe\("Immutable visible-card generation\. Rehydrated cards must echo the exact current generation/,
  "the continuation tool contract must require the exact visible-card generation when rebinding a rehydrated iframe");
assert.match(coordinator, /resourceIdentifiesAnchor[\s\S]{0,180}kind === "continuation-anchor"/,
  "the continuation coordinator must derive anchor identity only from the dedicated immutable App resource");
assert.match(coordinator, /anchorSurface:\s*resourceIdentifiesAnchor/,
  "the dedicated anchor resource must recover anchor identity when Host tool lifecycle notifications are omitted");
assert.match(coordinator, /anchorMountToken:\s*undefined/,
  "the continuation coordinator must still keep the original anchor generation capability separate from ordinary result state");
assert.match(coordinator, /senderCapability:\s*undefined/,
  "a separate transport capability slot must exist so sender ownership can move without changing the visible anchor-card identity");
assert.match(coordinator, /senderCapabilityFromResult[\s\S]{0,1800}devspace\/continuation-sender/,
  "transport sender authority must come from private tool-result metadata rather than a second continuation_anchor invocation");
assert.match(coordinator, /anchorMountGeneration:\s*Number\.isInteger\(resourceGeneration\)[\s\S]{0,260}anchorSuperseded:\s*false/,
  "the anchor surface must recover its immutable resource generation and track whether a newer recovery card superseded it");
assert.match(coordinator, /authoritativeGeneration[\s\S]{0,500}surfaceGeneration[\s\S]{0,500}markAnchorSuperseded\(\)/,
  "a lazily mounted old ghost generation must retire its visible-card authority before it can ACK the newer card");
assert.match(coordinator, /data-devspace-anchor-superseded[\s\S]{0,700}devspace:continuation-superseded/,
  "a superseded immutable historical card must freeze its own visible snapshot instead of leaving a blank Host widget shell");
assert.doesNotMatch(coordinator, /function markAnchorSuperseded\([\s\S]{0,1400}document\.body\.replaceChildren\(\)/,
  "superseding a historical card must never erase the iframe body while the Host keeps its outer card shell");
assert.match(coordinator, /if \(surfaceGeneration > 0 && authoritativeGeneration > surfaceGeneration\) \{[\s\S]{0,900}markAnchorSuperseded\(authoritativeGeneration\);[\s\S]{0,120}\} else \{[\s\S]{0,120}publishTaskForCard/,
  "an old immutable card must retire before a newer generation can be published into its visible renderer");
assert.match(coordinator, /function markAnchorSuperseded\([^)]*\)[\s\S]{0,1200}state\.senderCapability = undefined[\s\S]{0,900}stopSupervisor\(\)[\s\S]{0,300}stopWakeSource\(\)[\s\S]{0,300}stopLifecycleRefresh\(\)/,
  "a superseded visible card must atomically retire sender/supervisor activity while preserving only its frozen UI snapshot");
assert.match(coordinator, /function startSupervisor\(\)[\s\S]{0,350}if \(state\.disposed \|\| state\.anchorSuperseded\) return;[\s\S]{0,160}startWakeSource\(\)/,
  "a disposed or superseded historical card must fail closed before it can restart wake/sender supervision");
assert.match(coordinator, /function startLifecycleRefresh\(\)[\s\S]{0,300}state\.disposed \|\| state\.anchorSuperseded/,
  "late async tool-result settlement must not reinstall lifecycle listeners after dispose or supersession");
assert.doesNotMatch(coordinator, /recoverableHeadlessRelay|superseded card headless relay/,
  "the continuation architecture must not depend on a throttled historical iframe for current-generation delivery");
assert.match(coordinator, /activeSenderCapability\(\)[\s\S]{0,900}anchorMountGeneration[\s\S]{0,700}authoritativeGeneration/,
  "a headless relay must reject its stale sender capability until private bind refreshes it to the authoritative current generation");
assert.match(coordinator, /const mountToken = state\.anchorMountToken[\s\S]{0,500}callTask\("heartbeat",\s*\{\s*note:\s*`anchor-mount-ack:\$\{mountToken\}`\s*\}\)/,
  "the actual continuation_anchor iframe must support an old-schema-compatible token-authenticated heartbeat ACK");
assert.match(coordinator, /callTask\("anchor-mounted",\s*\{[\s\S]{0,180}anchorMountToken:\s*mountToken,[\s\S]{0,180}anchorMountGeneration:\s*state\.anchorMountGeneration/,
  "the actual continuation_anchor iframe must ACK both card-generation token and exact generation so same-card rehydration cannot revive a stale card");
assert.match(coordinator, /ChatGPT can mount the visible continuation_anchor iframe[\s\S]{0,1000}state\.anchorMountToken = String\(outcome\.anchorMountToken\)[\s\S]{0,500}state\.anchorMountGeneration = generation/,
  "an anchor iframe that misses the one-shot toolresult must recover its exact current-generation mount capability from private sender bind");
assert.match(coordinator, /bindSenderTransport\(\)[\s\S]{0,900}state\.anchorSurface[\s\S]{0,500}state\.anchorMountToken[\s\S]{0,500}await ensureTask\(\)/,
  "after private bind recovers a missing anchor capability, onConnected must immediately retry the authenticated visible-card ACK");
assert.doesNotMatch(coordinator, /Reuse the one conversation-lifetime task\/card/,
  "synthetic recovery guidance must distinguish lifetime task identity from the current manual-round card generation");
assert.match(coordinator, /Reuse the conversation-lifetime taskId and existing process\/workspace state/,
  "synthetic guidance must explicitly reuse the lifetime taskId and durable workspace/process state");
assert.match(coordinator, /Synthetic continuations reuse the current visible milestone-card generation while the required milestone set is unchanged/,
  "synthetic guidance must explicitly preserve the current milestone-card generation while the milestone set is unchanged");
assert.match(coordinator, /If and only if a status\/checkpoint reports milestoneCardRequired\/reanchorRequired because the synthetic checkpoint changed the required milestone set[\s\S]{0,260}continuation_anchor exactly once for that new generation/,
  "synthetic guidance must rotate the visible card only when the milestone set actually changes");
assert.match(coordinator, /syntheticWorkMustContinue/,
  "synthetic prompt/context must carry the runtime sustained-work directive");
assert.match(coordinator, /continueInSameTurn/,
  "synthetic prompt/context must carry the same-turn directive");
assert.match(coordinator, /finalResponseAllowed/,
  "synthetic prompt/context must carry the final-response gate");
assert.match(coordinator, /one-tool-and-final/,
  "synthetic guidance must reject one-tool-and-final short automatic turns");
assert.match(coordinator, /senderTransportAvailable\(\)[\s\S]{0,1600}callSender\("heartbeat"/,
  "a generic current Workspace App may run only the sender transport path after receiving a verified private capability");
assert.match(coordinator, /if \(!state\.anchorSurface \|\| state\.anchorSuperseded\) \{[\s\S]{0,700}never arm recovery from it/,
  "teardown of a transport-only or superseded historical App must not impersonate authoritative current-card lifecycle evidence");
assert.ok(server.includes("Every real ChatGPT thread owns one lifetime DevSpace Task Contract/taskId")
  && server.includes("Every manual user message that actually uses DevSpace owns exactly one fresh visible continuation_anchor milestone card")
  && server.includes("Synthetic resumed turns omit manualTakeover")
  && server.includes("reuse the current card while requiredMilestones is unchanged")
  && server.includes("If a synthetic checkpoint changes requiredMilestones, the runtime rotates one new generation"),
  "server guidance must keep task identity thread-lifetime, rotate once per manual message, and rotate synthetic cards only on required-milestone-set revision");
assert.match(runtimeStateSource, /function anchorMountRecoveryRequired[\s\S]{0,1000}return !row\.anchor_mount_verified_at && !row\.anchor_mount_requested_at/,
  "runtime gating must permit exactly one UI-bearing anchor issuance inside the current manual user round");
assert.match(runtimeStateSource, /Exactly one UI-bearing continuation_anchor may be issued in the current[\s\S]{0,500}new manual round explicitly rotates\/reset these[\s\S]{0,500}synthetic continuations never do/,
  "manual user rounds must rotate visible card generation while synthetic turns remain on the current round card");
assert.match(runtimeStateSource, /rotateContinuationManualRoundCard\(taskId[\s\S]{0,3200}card:\$\{task\.conversation_scope_id\}:g\$\{nextGeneration\}/,
  "runtime must persist a generation-specific current manual-round card slot without allocating a shadow lifetime task");
const continuationModelToolAuthorizationStart = runtimeStateSource.indexOf("continuationModelToolAuthorization(input = {})");
const continuationModelToolAuthorizationEnd = runtimeStateSource.indexOf("rotateContinuationManualRoundCard(", continuationModelToolAuthorizationStart);
const continuationModelToolAuthorizationBody = continuationModelToolAuthorizationStart >= 0
  && continuationModelToolAuthorizationEnd > continuationModelToolAuthorizationStart
  ? runtimeStateSource.slice(continuationModelToolAuthorizationStart, continuationModelToolAuthorizationEnd)
  : "";
assert.ok(
  continuationModelToolAuthorizationBody.includes("anchorMountRecoveryRequired(task, Date.now())")
  && continuationModelToolAuthorizationBody.includes('reason: "manual-round-card-required"'),
  "ordinary manual-round DevSpace work must fail closed until that round's single visible milestone card has actually been issued",
);
assert.match(runtimeStateSource, /initialAnchorRequired:\s*anchorMountRecoveryRequired\(existing, now\.getTime\(\), input\.hostTurnFingerprint\)/,
  "initial hard gating must expose whether the current manual round still needs its single visible anchor");
assert.match(runtimeStateSource, /if \(!anchorMountRecoveryRequired\(row, Date\.now\(\), input\.hostTurnFingerprint\)\)\s*return undefined/,
  "supervisor gating must remain headless after the current manual round has already issued its visible card");
assert.match(runtimeStateSource, /anchor-mount-verification-pending[\s\S]{0,500}alreadyRequested:\s*true[\s\S]{0,800}const generation = Math\.max\(1, previousGeneration \|\| 1\)/,
  "duplicate anchor attempts inside one manual user round must not rotate or disclose another mount capability");
assert.doesNotMatch(server, /assistantTurnNonce|rememberExplicitModelTurn|effectiveModelTurnFingerprint|assistant-turn:/,
  "private assistant-turn heuristics must not replace the explicit manual-round status boundary used for visible card rotation");
assert.doesNotMatch(server, /x-datadog-trace-id|allowHostTrace|hostTurnFingerprint\(/,
  "private per-request Host tracing metadata must never participate in assistant-turn identity");
assert.match(runtimeStateSource, /const reanchorRequired = taskNeedsCurrentTurnSupervisor\(refreshedRow, refreshedTask\)/,
  "synthetic resume ACK must preserve current-manual-round mount-state gating and never rotate the card");
assert.match(runtimeStateSource, /const verifiedAnchorHeartbeat = Boolean\(row\.anchor_mount_verified_at\)/,
  "ordinary liveness maintenance must require an already-verified milestone surface");
assert.match(runtimeStateSource, /coordinatorInstanceId === row\.anchor_mount_coordinator_id/,
  "ordinary liveness maintenance must be bound to the verified milestone coordinator instead of any Workspace App iframe");
assert.match(runtimeStateSource, /requestingCoordinatorId[\s\S]{0,700}anchor_mount_coordinator_id[\s\S]{0,500}stale-anchor-coordinator/,
  "only the currently verified milestone coordinator may claim an automatic continuation");
assert.match(coordinator, /authoritativeGeneration > surfaceGeneration\)[\s\S]{0,900}markAnchorSuperseded\([^)]*\)/,
  "every authoritative coordinator result must immediately retire a historical card whose generation is stale");
const attemptContinuationSource = coordinator.match(/async function attemptContinuation\([\s\S]*?\n  async function supervisorTickImpl/)?.[0] ?? "";
assert.match(attemptContinuationSource, /if \(!senderTransportAvailable\(\)\) return false;[\s\S]*callSender\("claim"[\s\S]*callSender\("authorize-delivery"/,
  "READY delivery requires a current local sender plus server claim and final authorization, without redundant pre-claim RPCs");
assert.ok(server.includes("Later new work reactivates that taskId with continuation_task action=begin")
  || server.includes("Later user work reactivates the same taskId through continuation_task begin"),
  "server instructions must keep one thread-lifetime taskId across sequential user tasks");
assert.ok(server.includes("Later new work reactivates that taskId with continuation_task action=begin")
  && server.includes("Every manual user message that actually uses DevSpace owns exactly one fresh visible continuation_anchor milestone card")
  && server.includes("All card generations reuse the same lifetime taskId"),
  "a completed lifetime ledger must reactivate the same taskId while each later manual DevSpace message receives one fresh visible card generation");
assert.match(server, /continue\/resume reuses unfinished milestones/,
  "continue/resume must reuse unfinished milestones instead of manufacturing duplicate work items");
assert.match(coordinator, /TRANSIENT_RETRY_DELAYS_MS = \[0, 500, 1_500, 3_000, 5_000\]/,
  "resumed-turn MCP readiness retry must cover roughly 30 seconds instead of the old ~8-second window");
assert.match(coordinator, /supervisorTickInFlight[\s\S]{0,1200}supervisorTickImpl/,
  "the continuation supervisor must single-flight long retry ticks during network instability");
assert.match(coordinator, /ACTIVE_SYNTHETIC_CONTEXT_REFRESH_MS = 30_000/,
  "an ACKed unfinished synthetic turn must retain a bounded official model-context refresh cadence");
assert.match(coordinator, /function activeSyntheticExecutionContext\([\s\S]{0,1800}ACTIVE SYNTHETIC EXECUTION LEASE/,
  "active synthetic refreshes must carry a current-turn unfinished execution lease rather than a generic status message");
assert.match(coordinator, /refreshActiveSyntheticExecutionContext\("authoritative synthetic supervisor refresh"\)/,
  "authoritative supervisor refresh must keep the unfinished synthetic execution lease salient during long turns");
assert.match(coordinator, /refreshActiveSyntheticExecutionContext\("synthetic tool-result refresh"\)/,
  "tool results must refresh the synthetic execution lease when milestone state changes instead of relying only on the startup prompt");
assert.match(server, /UNFINISHED SYNTHETIC TURN: A PLAIN OR EMPTY FINAL IS FORBIDDEN[\s\S]{0,700}genuine coherent stage boundary[\s\S]{0,700}turn-complete[\s\S]{0,900}concise user-visible progress summary/,
  "the pre-final barrier must expose a compact legal synthetic stage-boundary contract ahead of ordinary tool payloads");
assert.doesNotMatch(runtimeStateSource, /function syntheticActiveOrphanFallback|const orphan = syntheticActiveOrphanFallback/,
  "DevSpace tool silence must never be promoted into synthetic turn-end authority because the Host may still be reasoning/generating outside MCP");
assert.doesNotMatch(runtimeStateSource, /update continuation_tasks set[\s\S]{0,700}assistant_turn_state='ORPHANED'/,
  "completion-driven/resident runtime must not create new ORPHANED assistant turns from cadence/quiet inference");
assert.match(runtimeStateSource, /continuation-synthetic-active-orphan-revoked/,
  "historical ORPHANED rows from older dev builds must remain revocable during live upgrade compatibility cleanup");
assert.doesNotMatch(coordinator, /window\.parent\.postMessage|querySelector\([^)]*(?:textarea|composer|send)/i, "continuation must use the connected App rather than raw host/DOM automation");
assert.doesNotMatch(coordinator, /23\s*\*\s*60\s*\*\s*1000|24\.5\s*\*\s*60\s*\*\s*1000|25(?:\.\d+)?\s*\*\s*60\s*\*\s*1000/, "continuation must not depend on a fixed ChatGPT minute limit");
assert.match(workspaceBundle, /window\.__DEVSPACE_MCP_APP__=Y_/);
assert.match(workspaceBundle, /window\.__DEVSPACE_ATTACH_CONTINUATION__\?\.\(Y_\)/);
assert.match(workspaceBundle, /window\.__DEVSPACE_CONTINUATION_CONNECTED__\?\.\(Y_\)/);
assert.match(workspaceBundle, /window\.__DEVSPACE_CONTINUATION_TEARDOWN__\?\.\(Y_,e,t\)/);

const { toolWidgetDescriptorMeta, workspaceAppAnchorUri, workspaceAppGenerationUri, workspaceAppHtml, workspaceAppResourceResult, workspaceAppResultMeta, workspaceAppUri } = await import(`${pathToFileURL(packagedServerPath).href}?descriptor=${Date.now()}`);
const descriptorConfig = {
  widgets: "changes",
  features: { continuationGuard: true },
  oauth: { scopes: ["devspace"] },
  publicBaseUrl: "https://devspace.example.test",
};
for (const kind of ["runtime", "shell", "write", "edit", "read", "search", "directory"]) {
  const meta = toolWidgetDescriptorMeta(descriptorConfig, kind);
  assert.equal(meta?._meta?.ui?.resourceUri, undefined, `${kind} must remain headless when widgets=changes`);
  assert.equal(meta?._meta?.["openai/outputTemplate"], undefined, `${kind} must not render a continuation card`);
}
const anchorMeta = toolWidgetDescriptorMeta(descriptorConfig, "continuation-anchor");
const workspaceUri = workspaceAppUri(descriptorConfig);
const anchorUri = workspaceAppAnchorUri(descriptorConfig);
const workspaceMeta = toolWidgetDescriptorMeta(descriptorConfig, "workspace");
assert.equal(workspaceMeta?._meta?.ui?.resourceUri, undefined,
  "open_workspace must stay headless in widgets=changes so workspace reuse cannot accumulate duplicate recovery cards");
assert.equal(workspaceMeta?._meta?.["openai/outputTemplate"], undefined);
assert.match(workspaceUri, /^ui:\/\/devspace\/workspace-app-[0-9a-f]{16}\.html$/);
assert.match(anchorUri, /^ui:\/\/devspace\/workspace-app-[0-9a-f]{16}-continuation-anchor\.html$/);
assert.notEqual(anchorUri, workspaceUri,
  "the legacy continuation-anchor compatibility alias must remain distinct from the primary Workspace App URI");
assert.equal(anchorMeta?._meta?.ui?.resourceUri, workspaceUri,
  "new continuation_anchor calls must advertise the same Host-proven Workspace App URI as other visible DevSpace results");
assert.equal(anchorMeta?._meta?.["openai/outputTemplate"], workspaceUri);
assert.match(server,
  /structuredContent: \{ result, \.\.\.payload \},\s*_meta: workspaceAppResultMeta\(config, mount\.anchorMountGeneration\)/,
  "continuation_anchor must carry a standards-first generation-specific resource hint so a live-updated App cannot be trapped behind a cached descriptor body");
assert.match(server,
  /function workspaceAppResultMeta\(config, generation\)[\s\S]{0,900}workspaceAppGenerationUri\(config, generation\)[\s\S]{0,900}ui:\s*\{[\s\S]{0,300}resourceUri/,
  "the result-level resource hint must use the immutable generation-specific URI rather than the descriptor URI");
assert.doesNotMatch(server,
  /function workspaceAppResultMeta\(config, generation\)[\s\S]{0,1400}"openai\/outputTemplate"/,
  "the result cache-busting hint must not reintroduce dev15's second legacy outputTemplate identity");
assert.match(server,
  /withContinuationSenderCapability\(result, taskContractOutcome, guardedDefinition,\s*\{\s*includeLegacyOutputTemplate:\s*name\s*!==\s*"continuation_anchor",?\s*\}\s*\)/,
  "the generic sender-capability wrapper must preserve continuation_anchor as standards-first result metadata instead of silently restoring legacy outputTemplate");
const generation7Uri = workspaceAppGenerationUri(descriptorConfig, 7);
const generation8Uri = workspaceAppGenerationUri(descriptorConfig, 8);
assert.match(generation7Uri, /^ui:\/\/devspace\/workspace-app-[0-9a-f]{16}-continuation-anchor-g7\.html$/,
  "a deliberate milestone-card generation must receive a generation-specific result cache key");
assert.equal(workspaceAppGenerationUri(descriptorConfig, 7), generation7Uri,
  "replaying the same generation must preserve the same result cache key");
assert.notEqual(generation8Uri, generation7Uri,
  "a later deliberate milestone-card generation must not reuse an earlier generation cache key");
assert.equal(workspaceAppGenerationUri(descriptorConfig, 0), anchorUri,
  "legacy generation aliases must still fall back to the stable legacy continuation-anchor alias");
const generation7Meta = workspaceAppResultMeta(descriptorConfig, 7);
const generation8Meta = workspaceAppResultMeta(descriptorConfig, 8);
assert.equal(generation7Meta?.ui?.resourceUri, generation7Uri,
  "a continuation_anchor result must force a fresh standards-first resource identity for its exact card generation");
assert.equal(generation7Meta?.["ui/resourceUri"], generation7Uri);
assert.equal(generation7Meta?.["openai/outputTemplate"], undefined,
  "legacy outputTemplate stays descriptor-owned so the dev15 double-template mount failure cannot return");
assert.equal(generation8Meta?.ui?.resourceUri, generation8Uri,
  "rotating the durable milestone generation must rotate the result cache key without rotating the descriptor identity");
assert.equal(generation8Meta?.["ui/resourceUri"], generation8Uri);
assert.equal(generation8Meta?.["openai/outputTemplate"], undefined);
assert.notEqual(generation7Uri, anchorUri,
  "legacy generation-specific resource URIs remain distinct compatibility aliases only");
const fullWorkspaceMeta = toolWidgetDescriptorMeta({ ...descriptorConfig, widgets: "full" }, "workspace");
assert.equal(fullWorkspaceMeta?._meta?.ui?.resourceUri, workspaceUri,
  "widgets=full keeps the explicit compatibility behavior where workspace calls render cards");
assert.equal(fullWorkspaceMeta?._meta?.["openai/outputTemplate"], workspaceUri);
assert.notEqual(workspaceAppAnchorUri({ ...descriptorConfig, publicBaseUrl: "https://other.example.test" }), anchorUri, "changing the public asset origin must produce a fresh Workspace App anchor URI");
const renderedWorkspaceApp = workspaceAppHtml(descriptorConfig);
assert.match(renderedWorkspaceApp, /return\s+[A-Za-z_$][\w$]*===`continuation_anchor`\|\|[A-Za-z_$][\w$]*===`open_workspace`/,
  "the final self-contained Workspace App resource must really route continuation_anchor into the visible renderer after minification");
assert.match(renderedWorkspaceApp, /const SENDER_TOOL = "continuation_sender";/,
  "Workspace App HTML must inline the continuation coordinator so sender startup does not depend on a secondary Host module request");
assert.doesNotMatch(renderedWorkspaceApp, /data:text\/javascript;base64,/, "Workspace App HTML must not depend on a data: module that ChatGPT may block before widget CSP compatibility metadata is applied");
assert.doesNotMatch(renderedWorkspaceApp, /src="[^"]*continuation-coordinator\.js/, "Workspace App HTML must not depend on an externally cached continuation coordinator script");
assert.doesNotMatch(renderedWorkspaceApp, /<script[^>]+src=["'][^"']*continuation-runtime\.js["']/,
  "the continuation sender must not depend on the dev52 external runtime bootstrap that can be skipped by the Host while the card UI still renders");
assert.match(renderedWorkspaceApp, /window\.__DEVSPACE_MCP_APP__=/, "Workspace App HTML must inline the MCP Apps bootstrap bundle so ChatGPT does not need a second script request before connecting");
assert.match(renderedWorkspaceApp, /RUNTIME_TOOLS/, "Workspace App HTML must inline runtime enhancements used by the render surface");
assert.match(renderedWorkspaceApp, /__devspaceEarlyHostMessages/, "Workspace App must buffer host notifications that arrive before module listeners are ready");
assert.match(renderedWorkspaceApp, /stopImmediatePropagation\(\)/, "early host notifications must be delivered exactly once after module bootstrap");
assert.match(renderedWorkspaceApp, /devspace:workspace-app-ready/, "Workspace App must announce completion of early-message replay");
assert.doesNotMatch(renderedWorkspaceApp, /<section class="empty">Waiting for a tool result\.<\/section>/, "the legacy permanently-stuck placeholder must not remain in the Workspace App shell");
assert.match(renderedWorkspaceApp, /data-devspace-continuation/, "Workspace App must include the dedicated continuation task card renderer");
assert.match(renderedWorkspaceApp, /<style>[\s\S]*\.shell/, "Workspace App HTML must inline its initial styles so the iframe is self-contained");
assert.equal([...renderedWorkspaceApp.matchAll(/<script[^>]+src=/g)].length, 0,
  "the continuation/milestone bootstrap must remain fully self-contained so card rendering and sender startup have the same Host lifecycle");
assert.doesNotMatch(renderedWorkspaceApp, /<link[^>]+rel="stylesheet"/, "Workspace App bootstrap must not depend on external stylesheet requests");
assert.match(renderedWorkspaceApp, /https:\/\/devspace\.example\.test\/mcp-app-assets\/assets\/heavy-payload-[^"']+\.js/, "inline Vite entry must rewrite lazy chunk URLs to the public asset origin");
const staleResourceUri = "ui://devspace/workspace-app-deadbeefdeadbeef.html";
const staleResource = workspaceAppResourceResult(descriptorConfig, staleResourceUri);
assert.equal(staleResource.contents?.[0]?.uri, staleResourceUri, "compatibility reads must preserve the stale URI requested by the host");
assert.equal(staleResource.contents?.[0]?.mimeType, "text/html;profile=mcp-app");
assert.match(staleResource.contents?.[0]?.text ?? "", /window\.__DEVSPACE_MCP_APP__=/, "compatibility reads must return the current self-contained Workspace App");
assert.equal(staleResource.contents?.[0]?._meta?.ui?.domain, descriptorConfig.publicBaseUrl);
const generationResource = workspaceAppResourceResult(descriptorConfig, generation7Uri);
assert.equal(generationResource.contents?.[0]?.uri, generation7Uri,
  "generation-specific compatibility reads must preserve the exact result-level URI requested by the host");
assert.match(generationResource.contents?.[0]?.text ?? "", /const SENDER_TOOL = "continuation_sender";/,
  "generation-specific compatibility reads must resolve to a self-contained App document with the current continuation sender runtime inline");
const historicalContinuationGuardUri = "ui://devspace/continuation-guard.html";
const historicalContinuationGuardResource = workspaceAppResourceResult(descriptorConfig, historicalContinuationGuardUri);
assert.equal(historicalContinuationGuardResource.contents?.[0]?.uri, historicalContinuationGuardUri);
assert.match(historicalContinuationGuardResource.contents?.[0]?.text ?? "", /const SENDER_TOOL = "continuation_sender";/,
  "historical continuation-guard URI must resolve to a self-contained App document with the current continuation sender runtime inline");
assert.match(server, /DevSpace Continuation Guard Legacy Compatibility/);
assert.match(server, /ui:\/\/devspace\/continuation-guard\.html/);

const { loadConfig } = await import(`${pathToFileURL(packagedConfigPath).href}?config=${Date.now()}`);
const configRoot = mkdtempSync(join(tmpdir(), "devspace-1147-config-"));
try {
  const defaultWidgetConfig = loadConfig({
    DEVSPACE_CONFIG_DIR: configRoot,
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-1147",
    DEVSPACE_ALLOWED_ROOTS: ROOT,
    DEVSPACE_PUBLIC_BASE_URL: "https://devspace.invalid",
  });
  assert.equal(defaultWidgetConfig.widgets, "changes", "Portable default must consolidate ordinary tool UI into show_changes");

  const explicitFullWidgetConfig = loadConfig({
    DEVSPACE_CONFIG_DIR: configRoot,
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-1147",
    DEVSPACE_ALLOWED_ROOTS: ROOT,
    DEVSPACE_PUBLIC_BASE_URL: "https://devspace.invalid",
    DEVSPACE_WIDGETS: "full",
  });
  assert.equal(explicitFullWidgetConfig.widgets, "full", "explicit full widget compatibility mode must remain available");
} finally {
  rmSync(configRoot, { recursive: true, force: true });
}

// Production Workspace App HTML injects the immutable sender asset revision
// before the inlined coordinator module executes. This test imports the module
// directly, so reproduce that boot contract explicitly; otherwise dev48 must
// (correctly) fail closed before any FakeApp sender behavior can be exercised.
globalThis.__DEVSPACE_CONTINUATION_SENDER_ASSET_REVISION__ = TEST_SENDER_ASSET_REVISION;
const { installContinuationCoordinator } = await import(`${pathToFileURL(coordinatorPath).href}?coordinator=${Date.now()}`);
class FakeApp {
  constructor() {
    this.handlers = new Map();
    this.calls = [];
    this.callInputs = [];
    this.messages = [];
    this.contextUpdates = [];
    this.displayModeRequests = [];
    this.hostDisplayMode = "inline";
    this.task = undefined;
    this.autoVerifyAnchor = true;
    this.anchorMountAccepted = true;
    this.autoEmitAnchorResult = true;
    this.anchorMountToken = "00000000-0000-4000-8000-00000000a001";
    this.anchorMountGeneration = 1;
    this.bindReadyGeneration = undefined;
    this.senderBindCount = 0;
    this.senderHeartbeatRebindRequiredOnce = false;
    this.senderClaimRebindRequiredOnce = false;
  }
  verifyExistingAnchor() {
    if (this.task) {
      this.task = {
        conversationScopeId: this.task.conversationScopeId ?? "conversation_fake",
        anchorMountGeneration: this.task.anchorMountGeneration ?? this.anchorMountGeneration,
        ...this.task,
      };
      if (this.autoVerifyAnchor !== false && !this.task.anchorMountVerifiedAt) {
        this.task = {
          ...this.task,
          anchorMountVerifiedAt: "2026-01-01T00:00:00.000Z",
          anchorMountCoordinatorId: "ui_test_verified_anchor",
        };
      }
    }
    return this.task;
  }
  addEventListener(name, handler) {
    const handlers = this.handlers.get(name) ?? [];
    handlers.push(handler);
    this.handlers.set(name, handlers);
  }
  removeEventListener(name, handler) {
    this.handlers.set(name, (this.handlers.get(name) ?? []).filter((entry) => entry !== handler));
  }
  emit(name, params) {
    for (const handler of this.handlers.get(name) ?? []) handler(params);
    if (name === "toolinput"
      && this.autoEmitAnchorResult !== false
      && (params?.name === "continuation_anchor" || !params?.name)) {
      for (const handler of this.handlers.get("toolresult") ?? []) {
        handler({
          name: "continuation_anchor",
          structuredContent: {
            continuationAnchor: true,
            anchorMountToken: this.anchorMountToken,
            anchorMountGeneration: this.anchorMountGeneration,
            ...(this.task ? { task: this.verifyExistingAnchor() } : {}),
          },
        });
      }
    }
  }
  getHostContext() {
    return {
      toolInfo: { tool: { name: "continuation_anchor" } },
      platform: "mobile",
      displayMode: this.hostDisplayMode,
      availableDisplayModes: ["inline", "pip"],
    };
  }
  getHostVersion() {
    return { name: "test-host", version: "1" };
  }
  async callServerTool({ name, arguments: input }) {
    const rawName = name;
    const rawInput = input;
    // dev61 models the current ChatGPT Host behavior: an anchor iframe routes
    // component control traffic back through the source continuation_anchor
    // tool. Normalize that same-source bridge into the pre-existing fake task
    // and sender handlers so all lease/CAS/delivery assertions below still
    // exercise the exact same state transitions.
    if (name === "continuation_anchor" && typeof input?.bridgeAction === "string") {
      const bridgeAction = input.bridgeAction;
      if (bridgeAction.startsWith("sender-")) {
        name = "continuation_sender";
        input = { ...input, action: bridgeAction.slice("sender-".length) };
      }
      else if (bridgeAction.startsWith("task-")) {
        name = "continuation_task";
        input = { ...input, action: bridgeAction.slice("task-".length) };
      }
    }
    this.calls.push(input.action);
    this.callInputs.push({ name: rawName, ...rawInput });
    this.verifyExistingAnchor();
    if (name === "continuation_sender") {
      assert.equal(input.senderProtocolEpoch, senderEpoch(server),
        "the coordinator must send the epoch accepted by the real server, including bind and delivery callbacks");
      assert.equal(input.senderAssetRevision, TEST_SENDER_ASSET_REVISION,
        "the coordinator must send the immutable asset revision injected by the real Workspace App resource");
      assert.equal(input.taskId, this.task?.id);
      assert.equal(input.conversationScopeId, this.task?.conversationScopeId);
      assert.equal(input.anchorMountGeneration, this.anchorMountGeneration);
      if (input.action === "bind") {
        this.senderBindCount += 1;
        return {
          structuredContent: {
            accepted: true,
            taskId: this.task?.id,
            conversationScopeId: this.task?.conversationScopeId,
            workspaceId: this.task?.workspaceId,
            anchorMountToken: this.anchorMountToken,
            anchorMountGeneration: this.anchorMountGeneration,
            ...(this.bindReadyGeneration ? { readyGeneration: this.bindReadyGeneration } : {}),
            task: this.task,
          },
        };
      }
      assert.equal(input.anchorMountToken, this.anchorMountToken);
      if (input.action === "heartbeat") {
        if (this.senderHeartbeatRebindRequiredOnce) {
          this.senderHeartbeatRebindRequiredOnce = false;
          return {
            structuredContent: {
              accepted: false,
              reason: "sender-rebind-required",
            },
          };
        }
        return { structuredContent: { accepted: true, lastUiHeartbeatAt: new Date().toISOString() } };
      }
      if (input.action === "claim") {
        if (this.senderClaimRebindRequiredOnce) {
          this.senderClaimRebindRequiredOnce = false;
          return {
            structuredContent: {
              accepted: false,
              reason: "sender-rebind-required",
            },
          };
        }
        const retryExisting = Boolean(this.task?.continuationDeliveryAwaitingAck
          && this.task?.deliveryToken
          && Date.parse(this.task?.deliveryAckRetryAfterAt || "") <= Date.now());
        const deliveryToken = retryExisting
          ? this.task.deliveryToken
          : "00000000-0000-4000-8000-000000000001";
        this.statusReadyGeneration = undefined;
        this.bindReadyGeneration = undefined;
        this.task = {
          ...this.task,
          continuationPending: true,
          continuationCount: retryExisting ? Number(this.task?.continuationCount || 1) : 1,
          deliveryToken,
          deliveryOwner: "synthetic-pending",
          continuationDeliveryAwaitingAck: true,
          deliveryAckRetryAfterAt: undefined,
        };
        return { structuredContent: { task: this.task, accepted: true, deliveryToken, retryExisting } };
      }
      if (input.action === "authorize-delivery") {
        const accepted = this.task?.deliveryOwner === "synthetic-pending"
          && this.task?.deliveryToken === input.deliveryToken;
        this.lastAuthorizeAccepted = accepted;
        if (accepted) this.task = { ...this.task, deliveryOwner: "synthetic-pending" };
        return { structuredContent: { task: this.task, accepted } };
      }
      if (input.action === "delivery-result") {
        const deliveredAt = new Date();
        const callFulfilled = input.result === "accepted" || input.result === "fallback-accepted";
        const outcomeUnknown = input.result === "unknown";
        this.task = {
          ...this.task,
          continuationPending: outcomeUnknown ? this.task?.continuationPending : callFulfilled,
          continuationDeliveryAwaitingAck: outcomeUnknown
            ? this.task?.continuationDeliveryAwaitingAck
            : callFulfilled,
          deliveryOwner: "synthetic-pending",
          lastSendAttemptAt: deliveredAt.toISOString(),
          ...(callFulfilled
            ? { deliveryAckRetryAfterAt: new Date(deliveredAt.getTime() + 15_000).toISOString() }
            : {}),
        };
        return {
          structuredContent: {
            task: this.task,
            accepted: true,
            ...(outcomeUnknown ? { outcomeUncertain: true, retryRequired: false } : {}),
          },
        };
      }
      throw new Error(`Unexpected fake sender action ${input.action}`);
    }
    assert.equal(name, "continuation_task");
    if (input.action === "begin-auto") {
      this.task ??= {
        id: "task_fake",
        conversationScopeId: "conversation_fake",
        workspaceId: input.workspaceId,
        state: "RUNNING",
        continuationMode: "completion-driven",
        objective: "finish fake task",
        requiredMilestones: ["done"],
        completedMilestones: [],
        continuationPending: false,
        watchProcessHandles: this.initialWatchHandles ?? [],
        turnStartedAt: new Date(Date.now() - 1000).toISOString(),
      };
      this.verifyExistingAnchor();
      return { structuredContent: { task: this.task, created: true } };
    }
    if (input.action === "host-signal") {
      if (input.hostSignal === "connected" && this.profileRecommendedMs) {
        this.task = {
          ...this.task,
          recommendedContinueAfterMs: this.profileRecommendedMs,
          observedTurnBudgetMs: Math.round(this.profileRecommendedMs / 0.88),
          hostTimeoutSamples: this.profileTimeoutSamples ?? 1,
        };
      }
      if (input.hostSignal === "timeout") {
        const observed = Math.max(1000, Number(input.elapsedMs || 1000));
        const turnLeaseId = this.task?.turnLeaseId ?? `turn_${this.task?.id ?? "fake"}`;
        this.task = {
          ...this.task,
          turnLeaseId,
          observedTurnBudgetMs: observed,
          recommendedContinueAfterMs: Math.floor(observed * 0.88),
          hostTimeoutSamples: 1,
          assistantTurnState: "TIMED_OUT",
          assistantTurnCompletionLeaseId: turnLeaseId,
          stallState: "CONTINUATION_ARMED",
        };
      }
      return { structuredContent: { task: this.task, accepted: true } };
    }
    if (input.action === "watch-status") {
      const wakeReady = Boolean(this.watchWakeReady);
      if (wakeReady) {
        const wasExplicitWait = this.task?.state === "WAITING_EXTERNAL"
          && this.task?.continuationMode === "resident";
        this.task = {
          ...this.task,
          watchProcessHandles: [],
          ...(wasExplicitWait ? { state: "RUNNING", continuationWakePending: true } : {}),
        };
        // The real server-side process guard arms the resident wake, then the
        // independent continuation supervisor materializes a durable READY
        // generation. Model that durable outcome rather than reviving the old
        // client-side "process completed => send now" shortcut.
        if (wasExplicitWait) this.statusReadyGeneration = 2;
      }
      return { structuredContent: { task: this.task, accepted: true, wakeReady, watchedProcesses: [] } };
    }
    if (input.action === "heartbeat") {
      if (this.task?.continuationMode === "completion-driven"
        && this.task?.stallState !== "CONTINUATION_ARMED"
        && Date.parse(this.task?.turnLeaseExpiresAt || "") <= Date.now()) {
        this.task = { ...this.task, stallState: "SUSPECTED_STALL", stallProbeCount: Number(this.task?.stallProbeCount || 0) + 1 };
      }
      return { structuredContent: { task: this.task, accepted: true } };
    }
    if (input.action === "anchor-mounted") {
      const accepted = this.anchorMountAccepted !== false
        && input.anchorMountToken === this.anchorMountToken
        && Number(input.anchorMountGeneration || 0) === Number(this.anchorMountGeneration || 0);
      if (accepted) {
        this.task = {
          ...this.task,
          anchorMountVerifiedAt: this.task?.anchorMountVerifiedAt ?? "2026-01-01T00:00:00.000Z",
          anchorMountCoordinatorId: input.coordinatorInstanceId,
          anchorMountGeneration: this.anchorMountGeneration,
        };
      }
      return { structuredContent: { task: this.task, accepted, reason: accepted ? "anchor-rebound" : "anchor-capability-mismatch" } };
    }
    if (input.action === "status" || input.action === "delivery-result" || input.action === "release-continuation") {
      return {
        structuredContent: {
          task: this.task,
          accepted: true,
          ...(input.action === "status" && this.statusReadyGeneration
            ? { readyGeneration: this.statusReadyGeneration }
            : {}),
        },
      };
    }
    if (input.action === "resume") {
      this.task = { ...this.task, continuationPending: false, state: "RUNNING", turnStartedAt: new Date().toISOString() };
      return { structuredContent: { task: this.task, accepted: true } };
    }
    throw new Error(`Unexpected fake action ${input.action}`);
  }
  async updateModelContext(value) {
    this.contextUpdates.push(value);
    return {};
  }
  async requestDisplayMode({ mode }) {
    this.displayModeRequests.push(mode);
    this.hostDisplayMode = mode;
    return { mode };
  }
  async sendMessage(value) {
    this.messages.push(value);
    return {};
  }
  async sendFollowUpMessage(value) {
    const normalized = value?.prompt
      ? { role: "user", content: [{ type: "text", text: value.prompt }] }
      : value;
    this.messages.push(normalized);
    return {};
  }
}

const isSenderControlCall = (entry, action) => entry?.name === "continuation_sender"
  && entry?.action === action;
const isTaskControlCall = (entry, action) => entry?.name === "continuation_task"
  && entry?.action === action;

const fakeApp = new FakeApp();
const fakeController = installContinuationCoordinator(fakeApp, { timers: false, instanceId: "ui_test" });
fakeApp.emit("toolinput", { arguments: { workspaceId: "ws_fake" } });
await fakeController.onConnected();
assert.equal(fakeController.state.task?.id, "task_fake");
assert.deepEqual(fakeApp.displayModeRequests, [],
  "an unfinished milestone App must stay inline even when the Host advertises PiP");
assert.equal(await fakeController.attemptContinuation("unit test", { force: true }), true);
assert.equal(fakeApp.messages.length, 1);
assert.equal(fakeApp.contextUpdates.length >= 1, true);
const visibleSyntheticText = fakeApp.messages[0]?.content?.[0]?.text ?? "";
assert.match(visibleSyntheticText, /继续。@DevSpace MCP|Continue\. @DevSpace MCP/,
  "automatic recovery must preserve an explicit compact DevSpace connector activation cue in the Host-visible user-role turn");
assert.match(visibleSyntheticText, /continuation_task(?:\s+action=)?status/i,
  "the visible continuation trigger must tell the resumed turn how to recover authoritative durable state");
assert.match(visibleSyntheticText, /deliveryToken[^\n]*00000000-0000-4000-8000-000000000001/i,
  "the Host-visible synthetic turn must carry the exact one-time sender claim token required by the live turn-origin handshake");
assert.match(visibleSyntheticText, /(?:不要设置|不设置) manualTakeover|without manualTakeover/i,
  "the first synthetic status must be explicitly distinguished from a manual takeover");
assert.match(visibleSyntheticText, /像人工发送“继续”一样持续完成未完成任务|exactly like a manual 'continue'/i,
  "the Host-visible synthetic turn must mimic the proven manual-continue execution cue instead of looking like a status protocol");
assert.doesNotMatch(visibleSyntheticText,
  /staleSyntheticTurn=true|suppressVisibleFinal=true|synthetic-continuation-superseded|Task Contract|至少完成 4 次实质 DevSpace 操作|at least four substantive DevSpace operations/,
  "detailed stale/work-floor policy must stay out of the visible user-role message; only the minimal stage-boundary turn-complete cue may be visible");
assert.doesNotMatch(visibleSyntheticText, /finish fake task|\bdone\b/i,
  "durable objective and milestone text must stay out of the uncancellable Host-visible synthetic envelope");
assert.doesNotMatch(visibleSyntheticText, /task_fake|ws_fake|authorized recovery/i,
  "the visible Host trigger may carry only the one-time deliveryToken capability; durable task/workspace identity and broader generation authority must remain hidden");
const hiddenSyntheticContext = fakeApp.contextUpdates.at(-1)?.content?.[0]?.text ?? "";
assert.match(hiddenSyntheticContext, /finish fake task/,
  "hidden model context must retain the durable objective removed from the Host-visible synthetic envelope");
assert.match(hiddenSyntheticContext, /done/,
  "hidden model context must retain the next unresolved milestone removed from the Host-visible synthetic envelope");
assert.match(hiddenSyntheticContext, /Call continuation_task status first/,
  "hidden model context must request the status claim before substantive work");
assert.match(hiddenSyntheticContext, /one-time deliveryToken[\s\S]{0,500}echo that exact token[\s\S]{0,500}omit manualTakeover[\s\S]{0,500}consumes it immediately/,
  "hidden model context must describe the exact first-status token ACK and immediate one-time consumption semantics");
assert.match(hiddenSyntheticContext, /reconstruct the current durable state[\s\S]{0,500}latest available DevSpace evidence/,
  "hidden model context must rebuild task state from durable evidence before choosing the next action");
assert.match(hiddenSyntheticContext, /failure, race, or regression risks[\s\S]{0,500}do not emit a chain-of-thought transcript/,
  "hidden model context must check relevant risks while keeping private reasoning private");
assert.doesNotMatch(hiddenSyntheticContext, /00000000-0000-4000-8000-000000000001|syntheticDeliveryToken|continuationDeliveryToken/,
  "hidden model context must describe token handling without duplicating the concrete one-time capability outside the Host-visible user-role handoff");
assert.ok(fakeApp.calls.includes("begin-auto"));
assert.ok(fakeApp.calls.includes("heartbeat"));
assert.ok(fakeApp.callInputs.some((entry) => isSenderControlCall(entry, "claim")),
  "the milestone anchor must claim READY through the dedicated continuation_sender bridge");
assert.ok(fakeApp.callInputs.some((entry) => isSenderControlCall(entry, "authorize-delivery")),
  "the milestone anchor must authorize delivery through the dedicated continuation_sender bridge");
assert.ok(fakeApp.calls.includes("delivery-result"));
fakeController.dispose();

// Reproduce the live dev48 failure: an already-mounted App survives while its
// process-local sender lease is invalidated. Heartbeat must remain fail-closed
// server-side, but the App must react to the explicit rebind requirement by
// executing the authenticated bind path instead of waiting forever for a new
// Host onConnected/toolresult event.
const senderRebindApp = new FakeApp();
const senderRebindController = installContinuationCoordinator(senderRebindApp, {
  supervisorTickMs: 250,
  heartbeatIntervalMs: 250,
  instanceId: "ui_sender_rebind_recovery",
});
senderRebindApp.emit("toolinput", { arguments: { workspaceId: "ws_sender_rebind_recovery" } });
await senderRebindController.onConnected();
const senderBindCountBeforeLeaseLoss = senderRebindApp.senderBindCount;
senderRebindApp.senderHeartbeatRebindRequiredOnce = true;
await new Promise((resolvePromise) => setTimeout(resolvePromise, 650));
assert.ok(senderRebindApp.senderBindCount > senderBindCountBeforeLeaseLoss,
  "an explicit sender-rebind-required heartbeat must cause the surviving App to execute a fresh authenticated sender bind");
assert.equal(senderRebindApp.senderHeartbeatRebindRequiredOnce, false,
  "the recovery test must actually exercise the rejected heartbeat rather than pass through the initial bind path");
assert.equal(senderRebindApp.messages.length, 0,
  "re-establishing sender authority alone must not invent a synthetic continuation when no READY generation exists");
senderRebindController.dispose();

// An already-ACKed synthetic turn can remain active for many minutes. Its
// current unfinished execution lease must be refreshed through the official
// model-context channel without creating another visible Host message.
const syntheticContextApp = new FakeApp();
syntheticContextApp.task = {
  id: "task_synthetic_context_refresh",
  conversationScopeId: "conversation_synthetic_context_refresh",
  workspaceId: "ws_synthetic_context_refresh",
  state: "RUNNING",
  continuationMode: "resident",
  objective: "finish the synthetic context refresh fixture",
  requiredMilestones: ["still runnable"],
  completedMilestones: [],
  continuationPending: false,
  deliveryOwner: "synthetic-active",
  deliveryGeneration: 7,
  syntheticResumeWorkRequired: true,
  assistantTurnOwner: "synthetic",
  assistantTurnState: "GENERATING",
  turnLeaseId: "turn_synthetic_context_refresh",
  turnLeaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  turnStartedAt: new Date(Date.now() - 120_000).toISOString(),
  watchProcessHandles: [],
};
const syntheticContextController = installContinuationCoordinator(syntheticContextApp, {
  supervisorTickMs: 250,
  heartbeatIntervalMs: 500,
  instanceId: "ui_synthetic_context_refresh",
});
syntheticContextApp.emit("toolinput", { arguments: { workspaceId: "ws_synthetic_context_refresh" } });
await syntheticContextController.onConnected();
await new Promise((resolvePromise) => setTimeout(resolvePromise, 650));
assert.ok(syntheticContextApp.contextUpdates.some((value) =>
  /ACTIVE SYNTHETIC EXECUTION LEASE/.test(value?.content?.[0]?.text ?? "")),
"an active unfinished synthetic turn must receive an official model-context refresh after ACK");
assert.equal(syntheticContextApp.messages.length, 0,
  "model-context refresh must never create another visible continuation message on its own");
assert.equal(syntheticContextApp.task.deliveryGeneration, 7,
  "advisory model-context refresh must not rotate generation ownership");
syntheticContextController.dispose();

// Reproduce the dev53 production ordering more precisely: the current visible
// card has been issued but its iframe mount ACK is still pending, the MCP
// service restarts and invalidates the server-side sender lease, then ATCC
// creates durable READY work.  Security hardening intentionally prevents this
// unverified current anchor from manufacturing a sender heartbeat, so claim
// itself must recover sender authority through one authenticated bind.  The
// recovery must not turn the private sender bind into a fake visible-card ACK.
const pendingAnchorRestartApp = new FakeApp();
pendingAnchorRestartApp.autoVerifyAnchor = false;
pendingAnchorRestartApp.anchorMountAccepted = false;
const pendingAnchorRestartController = installContinuationCoordinator(pendingAnchorRestartApp, {
  timers: false,
  instanceId: "ui_pending_anchor_restart_recovery",
});
pendingAnchorRestartApp.emit("toolinput", {
  name: "continuation_anchor",
  arguments: { workspaceId: "ws_pending_anchor_restart_recovery" },
});
await pendingAnchorRestartController.onConnected();
const pendingIssuedTask = {
  ...pendingAnchorRestartController.state.task,
  anchorMountRequestedAt: "2026-01-01T00:00:00.000Z",
};
pendingAnchorRestartController.state.task = pendingIssuedTask;
pendingAnchorRestartApp.task = pendingIssuedTask;
assert.equal(Boolean(pendingAnchorRestartApp.task?.anchorMountVerifiedAt), false,
  "the restart regression must keep the current visible card genuinely unverified");
assert.equal(pendingAnchorRestartController.state.anchorMountAcked, false,
  "a private sender bind must not manufacture visible-card mount authority");
const pendingAnchorBindCountBeforeLeaseLoss = pendingAnchorRestartApp.senderBindCount;
pendingAnchorRestartApp.senderClaimRebindRequiredOnce = true;
assert.equal(await pendingAnchorRestartController.attemptContinuation("post-restart READY", { force: true }), true,
  "READY claim must recover a restarted sender lease even while the current anchor mount ACK is pending");
assert.equal(pendingAnchorRestartApp.senderClaimRebindRequiredOnce, false,
  "the restart regression must exercise the rejected claim rather than succeed through stale local sender state");
assert.ok(pendingAnchorRestartApp.senderBindCount > pendingAnchorBindCountBeforeLeaseLoss,
  "sender-rebind-required from claim must execute one fresh authenticated sender bind");
assert.equal(pendingAnchorRestartController.state.anchorMountAcked, false,
  "claim recovery must preserve the separation between sender authority and visible-card mount ACK authority");
assert.equal(pendingAnchorRestartApp.messages.length, 1,
  "post-restart READY recovery must create exactly one Host-visible continuation request");
const pendingAnchorClaims = pendingAnchorRestartApp.callInputs
  .filter((entry) => isSenderControlCall(entry, "claim"));
assert.equal(pendingAnchorClaims.length, 2,
  "the failed post-restart claim may be retried exactly once after authenticated sender rebind");
pendingAnchorRestartController.dispose();

// Real production evidence is stronger than API naming: the only observed
// synthetic Host turn that reached a DevSpace ACK used ui/message, while both
// dev43 and the dev52 E2E observed window.openai.sendFollowUpMessage fulfill in
// 0-1 ms without creating a model generation. ui/message must therefore remain
// primary even when both transports exist. Transport fulfillment is still not
// model-start proof; the resumed DevSpace status ACK remains authoritative.
const transportOrder = [];
class NativeOnlyTransportApp extends FakeApp {
  async sendMessage(value) {
    transportOrder.push("ui-message");
    return super.sendMessage(value);
  }
  async sendFollowUpMessage(value) {
    transportOrder.push("app-lookalike");
    return super.sendFollowUpMessage(value);
  }
}
const transportApp = new NativeOnlyTransportApp();
const previousWindow = globalThis.window;
const browserWindowStub = new EventTarget();
browserWindowStub.parent = browserWindowStub;
browserWindowStub.openai = {
    async sendFollowUpMessage(value) {
      transportOrder.push("window-openai");
      return FakeApp.prototype.sendFollowUpMessage.call(transportApp, value);
    },
};
globalThis.window = browserWindowStub;
try {
  const transportController = installContinuationCoordinator(transportApp, { timers: false, instanceId: "ui_transport_order" });
  transportApp.emit("toolinput", { arguments: { workspaceId: "ws_transport_order" } });
  await transportController.onConnected();
  const firstTransportResult = await transportController.attemptContinuation("first delivery", { force: true });
  assert.equal(firstTransportResult, true);
  assert.deepEqual(transportOrder, ["ui-message"],
    "when both transports exist, the first delivery must use the proven ui/message user-role path and must not touch the native bridge");
  transportApp.task = {
    ...transportApp.task,
    deliveryAckRetryCount: 1,
    continuationDeliveryAwaitingAck: true,
    deliveryAckRetryAfterAt: new Date(Date.now() - 1_000).toISOString(),
  };
  transportController.state.task = transportApp.task;
  await transportController.refreshNow();
  assert.deepEqual(transportOrder, ["ui-message"],
    "an overdue ACK must remain diagnostic and must not retransmit a visible message");
  const deliveryMethods = transportApp.callInputs
    .filter((entry) => isSenderControlCall(entry, "delivery-result"))
    .map((entry) => entry.method);
  assert.deepEqual(deliveryMethods, ["ui/message"]);
  transportController.dispose();
} finally {
  if (previousWindow === undefined) delete globalThis.window;
  else globalThis.window = previousWindow;
}

// Any user-message transport can become outcome-uncertain after authorization.
// If the standard ui/message promise never settles, the coordinator must not
// immediately fall back to the compatibility API because the standard request
// may already have crossed the Host boundary and a second request can duplicate
// the visible continuation.
let hangingUiMessageCalls = 0;
let hangingCompatCalls = 0;
class HangingNativeTransportApp extends FakeApp {
  async sendMessage() {
    hangingUiMessageCalls += 1;
    return new Promise(() => {});
  }
}
const hangingTransportApp = new HangingNativeTransportApp();
const hangingTransportController = installContinuationCoordinator(hangingTransportApp, {
  timers: false,
  instanceId: "ui_hanging_native",
  nativeFollowUpSettlementTimeoutMs: 5,
  nativeFollowUp: async () => {
    hangingCompatCalls += 1;
    return undefined;
  },
});
hangingTransportApp.emit("toolinput", { arguments: { workspaceId: "ws_hanging_native" } });
await hangingTransportController.onConnected();
const hangingStartedAt = Date.now();
assert.equal(await hangingTransportController.attemptContinuation("hanging native follow-up", { force: true }), true,
  "a never-settling native Host promise must still finish the sender transaction");
assert.ok(Date.now() - hangingStartedAt < 500,
  "the unit override must prove the sender no longer waits indefinitely for Host promise settlement");
assert.equal(hangingUiMessageCalls, 1,
  "the standard ui/message request must be attempted exactly once");
assert.equal(hangingCompatCalls, 0,
  "an outcome-uncertain ui/message must not invoke the compatibility bridge and risk a duplicate visible continuation");
const hangingDeliveryResult = hangingTransportApp.callInputs.find((entry) =>
  isSenderControlCall(entry, "delivery-result"));
assert.equal(hangingDeliveryResult?.result, "unknown");
assert.equal(hangingDeliveryResult?.method, "ui/message");
assert.match(String(hangingDeliveryResult?.note || ""),
  /mcp-app-ui-message-settlement-unknown;payload=role-content;elapsedMs=\d+;returnType=thenable-pending;returnKeys=none/,
  "bounded settlement must record outcome-uncertain structural evidence without claiming that a model turn started");
hangingTransportController.dispose();

// MCP tool results can fulfill their Promise while carrying isError:true.
// That semantic error is a rejection, not an accepted Host message and not
// permission to try a second transport.
let semanticErrorCompatCalls = 0;
class SemanticErrorTransportApp extends FakeApp {
  async sendMessage() {
    return { isError: true, content: [{ type: "text", text: "permission denied" }] };
  }
}
const semanticErrorApp = new SemanticErrorTransportApp();
const semanticErrorController = installContinuationCoordinator(semanticErrorApp, {
  timers: false,
  instanceId: "ui_semantic_error",
  nativeFollowUp: async () => {
    semanticErrorCompatCalls += 1;
    return undefined;
  },
});
semanticErrorApp.emit("toolinput", { arguments: { workspaceId: "ws_semantic_error" } });
await semanticErrorController.onConnected();
assert.equal(await semanticErrorController.attemptContinuation("semantic ui/message rejection", { force: true }), false);
assert.equal(semanticErrorCompatCalls, 0,
  "fulfilled isError:true must not be recorded as accepted or retried through a second Host API");
const semanticErrorDeliveryResult = semanticErrorApp.callInputs.find((entry) =>
  isSenderControlCall(entry, "delivery-result"));
assert.equal(semanticErrorDeliveryResult?.result, "rejected");
semanticErrorController.dispose();

// Compatibility remains available only when ui/message explicitly reports
// that the method itself is unsupported.
let rejectedStandardCalls = 0;
let compatibilityFallbackCalls = 0;
class RejectingStandardTransportApp extends FakeApp {
  async sendMessage() {
    rejectedStandardCalls += 1;
    throw new Error("ui/message unsupported by legacy host");
  }
}
const rejectingStandardApp = new RejectingStandardTransportApp();
const rejectingStandardController = installContinuationCoordinator(rejectingStandardApp, {
  timers: false,
  instanceId: "ui_standard_rejected",
  nativeFollowUp: async (value) => {
    compatibilityFallbackCalls += 1;
    return FakeApp.prototype.sendFollowUpMessage.call(rejectingStandardApp, value);
  },
});
rejectingStandardApp.emit("toolinput", { arguments: { workspaceId: "ws_standard_rejected" } });
await rejectingStandardController.onConnected();
assert.equal(await rejectingStandardController.attemptContinuation("legacy ui/message rejection", { force: true }), true);
assert.equal(rejectedStandardCalls, 1);
assert.equal(compatibilityFallbackCalls, 1,
  "an explicit ui/message rejection may use exactly one compatibility Host follow-up attempt");
const compatibilityDeliveryResult = rejectingStandardApp.callInputs.find((entry) =>
  isSenderControlCall(entry, "delivery-result"));
assert.equal(compatibilityDeliveryResult?.method, "window.openai.sendFollowUpMessage");
rejectingStandardController.dispose();

// dev40 live failure: a coordinator reconnect while the synthetic generation
// is waiting for its first model ACK must be read-only with respect to model
// ownership. The old onConnected branch called ordinary resume merely because
// continuationPending=true, clearing pending state while leaving the delivery
// token behind. Rehydration must now preserve the exact generation/token and
// must not issue continuation_task resume.
const ackWaitingReconnectApp = new FakeApp();
ackWaitingReconnectApp.task = {
  id: "task_ack_wait_reconnect",
  conversationScopeId: "conversation_ack_wait_reconnect",
  workspaceId: "ws_ack_wait_reconnect",
  state: "RUNNING",
  continuationMode: "completion-driven",
  objective: "keep ACK wait intact",
  requiredMilestones: ["finish"],
  completedMilestones: [],
  continuationPending: true,
  continuationWakePending: false,
  continuationDeliveryAwaitingAck: true,
  deliveryToken: "00000000-0000-4000-8000-00000000a041",
  deliveryOwner: "synthetic-pending",
  deliveryAckRetryAfterAt: new Date(Date.now() + 60_000).toISOString(),
  anchorMountGeneration: 1,
};
const ackWaitingTokenBeforeReconnect = ackWaitingReconnectApp.task.deliveryToken;
const ackWaitingReconnectController = installContinuationCoordinator(ackWaitingReconnectApp, {
  timers: false,
  instanceId: "ui_ack_wait_reconnect",
});
ackWaitingReconnectApp.emit("toolinput", { arguments: { workspaceId: "ws_ack_wait_reconnect" } });
await ackWaitingReconnectController.onConnected();
assert.equal(ackWaitingReconnectApp.callInputs.some((entry) =>
  entry.name === "continuation_task" && entry.action === "resume"), false,
"reconnect during synthetic ACK wait must never call ordinary model resume");
assert.equal(ackWaitingReconnectApp.task.deliveryToken, ackWaitingTokenBeforeReconnect,
  "reconnect must preserve the generation delivery token");
assert.equal(ackWaitingReconnectApp.task.continuationPending, true,
  "reconnect must preserve synthetic pending state until ACK, takeover, or generation closure");
assert.equal(ackWaitingReconnectApp.task.deliveryOwner, "synthetic-pending");
ackWaitingReconnectController.dispose();

// If the sender that issued a Host message disappears before model ACK, a
// replacement App must preserve the outcome-uncertain DELIVERED generation.
// Re-sending can create a duplicate turn or interrupt a slow-starting model.
const relayLossApp = new NativeOnlyTransportApp();
const relayLossController = installContinuationCoordinator(relayLossApp, {
  timers: false,
  instanceId: "ui_relay_loss_original",
});
relayLossApp.emit("toolinput", { arguments: { workspaceId: "ws_relay_loss" } });
await relayLossController.onConnected();
assert.equal(await relayLossController.attemptContinuation("relay loss first delivery", { force: true }), true);
assert.equal(relayLossApp.messages.length, 1);
const relayLossDeliveryToken = relayLossApp.task.deliveryToken;
const relayLossContinuationCount = relayLossApp.task.continuationCount;
relayLossApp.task = {
  ...relayLossApp.task,
  continuationDeliveryAwaitingAck: true,
  deliveryOwner: "synthetic-pending",
  deliveryToken: relayLossDeliveryToken,
  deliveryAckRetryCount: 1,
  deliveryAckRetryAfterAt: new Date(Date.now() - 1_000).toISOString(),
};
relayLossController.state.task = relayLossApp.task;
relayLossController.dispose();

const reboundAfterRelayLossApp = new NativeOnlyTransportApp();
reboundAfterRelayLossApp.autoEmitAnchorResult = false;
reboundAfterRelayLossApp.anchorMountToken = relayLossApp.anchorMountToken;
reboundAfterRelayLossApp.anchorMountGeneration = relayLossApp.anchorMountGeneration;
reboundAfterRelayLossApp.task = { ...relayLossApp.task };
const reboundAfterRelayLossController = installContinuationCoordinator(reboundAfterRelayLossApp, {
  timers: false,
  instanceId: "ui_relay_loss_replacement",
});
reboundAfterRelayLossApp.emit("toolinput", {
  name: "continuation_anchor",
  arguments: {
    workspaceId: "ws_relay_loss",
    taskId: reboundAfterRelayLossApp.task.id,
  },
});
await reboundAfterRelayLossController.onConnected();
assert.equal(reboundAfterRelayLossApp.messages.length, 0,
  "a replacement App bind must not retransmit an outcome-uncertain unacked delivery");
assert.equal(reboundAfterRelayLossApp.task.deliveryToken, relayLossDeliveryToken,
  "replacement bind must preserve the same logical delivery token for an eventual idempotent ACK or manual takeover");
assert.equal(reboundAfterRelayLossApp.task.continuationCount, relayLossContinuationCount,
  "observing overdue ACK health must not consume another continuation budget");
assert.equal(reboundAfterRelayLossApp.callInputs.some((entry) =>
  isSenderControlCall(entry, "claim")), false,
"replacement App bind must not claim an already delivered outcome-uncertain generation");
reboundAfterRelayLossController.dispose();

// A server-resident sweep can create READY after the sender has already bound.
// The old coordinator only consumed READY in onConnected/onToolResult, leaving
// this generation stranded until a manual user turn superseded it.  An ordinary
// supervisor status refresh must now claim and deliver it exactly once.
const lateReadyApp = new FakeApp();
const lateReadyController = installContinuationCoordinator(lateReadyApp, { timers: false, instanceId: "ui_late_ready" });
lateReadyApp.emit("toolinput", { arguments: { workspaceId: "ws_late_ready" } });
await lateReadyController.onConnected();
assert.equal(lateReadyApp.messages.length, 0,
  "initial sender bind must not invent a continuation when no generation is READY");
lateReadyApp.statusReadyGeneration = 7;
await lateReadyController.refreshNow();
assert.equal(lateReadyApp.messages.length, 1,
  "a READY generation discovered after sender bind must be delivered by the next supervisor refresh");
assert.ok(lateReadyApp.callInputs.some((entry) => isSenderControlCall(entry, "claim")),
  "late READY delivery must still go through the atomic sender claim path");
lateReadyController.dispose();

// A READY snapshot is already authoritative. Host presentation and repeated
// mount/heartbeat/status work must not hold it before the atomic sender claim.
const stalledAdvisoryApp = new FakeApp();
const stalledAdvisoryController = installContinuationCoordinator(stalledAdvisoryApp, {
  timers: false, instanceId: "ui_ready_stalled_advisory",
});
stalledAdvisoryApp.emit("toolinput", { arguments: { workspaceId: "ws_ready_stalled_advisory" } });
await stalledAdvisoryController.onConnected();
const readyCallsStart = stalledAdvisoryApp.callInputs.length;
const originalReadyCall = stalledAdvisoryApp.callServerTool.bind(stalledAdvisoryApp);
let readyStatusCalls = 0;
stalledAdvisoryApp.callServerTool = (request) => {
  const action = request.arguments?.action;
  if (action === "status" && ++readyStatusCalls > 1) return new Promise(() => {});
  if (["anchor-mounted", "heartbeat", "host-signal"].includes(action)) return new Promise(() => {});
  return originalReadyCall(request);
};
stalledAdvisoryApp.hostDisplayMode = "pip";
stalledAdvisoryController.state.hostContext = {
  displayMode: "pip", availableDisplayModes: ["inline", "pip"],
};
stalledAdvisoryApp.requestDisplayMode = () => new Promise(() => {});
stalledAdvisoryApp.statusReadyGeneration = 8;
let stalledAdvisoryDeadline;
try {
  const settled = await Promise.race([
    stalledAdvisoryController.refreshNow().then(() => true),
    new Promise((resolve) => { stalledAdvisoryDeadline = setTimeout(() => resolve(false), 250); }),
  ]);
  assert.equal(settled, true, "READY must not wait for stalled display/mount/heartbeat/redundant status calls");
  assert.equal(stalledAdvisoryApp.messages.length, 1);
  const readyCalls = stalledAdvisoryApp.callInputs.slice(readyCallsStart);
  assert.equal(readyStatusCalls, 1, "the authoritative discovery status is sufficient before claim");
  assert.ok(readyCalls.some((entry) => isSenderControlCall(entry, "claim")));
  assert.ok(readyCalls.some((entry) => isSenderControlCall(entry, "authorize-delivery")),
    "the fast READY path must retain final server authorization");
} finally {
  clearTimeout(stalledAdvisoryDeadline);
  stalledAdvisoryController.dispose();
}

const legacyPipApp = new FakeApp();
// The fast path must recover stale liveness through an authenticated bind,
// while a server-side manual takeover must still suppress every visible send.
for (const readyClaimCase of ["stale-heartbeat", "manual-takeover"]) {
  const app = new FakeApp();
  const controller = installContinuationCoordinator(app, {
    timers: false, instanceId: "ui_ready_" + readyClaimCase,
  });
  app.emit("toolinput", { arguments: { workspaceId: "ws_ready_" + readyClaimCase } });
  await controller.onConnected();
  const original = app.callServerTool.bind(app);
  const bindsBefore = app.senderBindCount;
  let claims = 0;
  app.callServerTool = (request) => {
    if (request.name === "continuation_sender" && request.arguments?.action === "claim"
      && ++claims === 1) {
      return Promise.resolve({ structuredContent: {
        accepted: false,
        reason: readyClaimCase === "stale-heartbeat" ? "sender-heartbeat-stale" : "no-ready-generation",
      } });
    }
    return original(request);
  };
  app.statusReadyGeneration = 9;
  await controller.refreshNow();
  assert.equal(app.messages.length, readyClaimCase === "stale-heartbeat" ? 1 : 0);
  if (readyClaimCase === "stale-heartbeat") {
    assert.equal(claims, 2);
    assert.equal(app.senderBindCount, bindsBefore + 1,
      "a stale sender must authenticate a fresh bind before retrying claim");
  } else {
    assert.equal(claims, 1, "manual takeover must not be retried as a transport failure");
    assert.equal(app.callInputs.some((entry) => isSenderControlCall(entry, "authorize-delivery")), false);
  }
  controller.dispose();
}

legacyPipApp.hostDisplayMode = "pip";
const legacyPipController = installContinuationCoordinator(legacyPipApp, { timers: false, instanceId: "ui_legacy_pip" });
legacyPipApp.emit("toolinput", { arguments: { workspaceId: "ws_legacy_pip" } });
await legacyPipController.onConnected();
assert.deepEqual(legacyPipApp.displayModeRequests, ["inline"],
  "a milestone card left in PiP by an older build must be returned to the normal inline transcript surface");
legacyPipController.dispose();

// The immutable milestone card is a conversation identity, not a permanent
// transport requirement. ChatGPT/mobile may virtualize that old iframe while a
// newer ordinary DevSpace card remains mounted. A private result capability
// must let that newer iframe relay continuation delivery without becoming a
// second continuation_anchor surface.
class TransportRelayApp extends FakeApp {
  constructor() {
    super();
    this.autoEmitAnchorResult = false;
  }
  getHostContext() {
    return { toolInfo: { tool: { name: "show_changes" } } };
  }
}
const relayApp = new TransportRelayApp();
relayApp.task = {
  id: "task_transport_relay",
  conversationScopeId: "conversation_transport_relay",
  workspaceId: "ws_transport_relay",
  state: "RUNNING",
  continuationMode: "completion-driven",
  objective: "relay unfinished work after old anchor iframe virtualization",
  requiredMilestones: ["done"],
  completedMilestones: [],
  continuationPending: false,
  watchProcessHandles: [],
  stallState: "CONTINUATION_ARMED",
  anchorMountVerifiedAt: "2026-01-01T00:00:00.000Z",
  anchorMountCoordinatorId: "ui_old_anchor",
  anchorMountGeneration: 1,
  turnLeaseExpiresAt: new Date(Date.now() - 1000).toISOString(),
  turnStartedAt: new Date(Date.now() - 60_000).toISOString(),
};
const relayController = installContinuationCoordinator(relayApp, { timers: false, instanceId: "ui_transport_relay" });
await relayController.onConnected();
relayApp.bindReadyGeneration = 2;
relayApp.emit("toolresult", {
  name: "show_changes",
  _meta: {
    tool: "show_changes",
    "devspace/continuation-sender": {
      taskId: relayApp.task.id,
      conversationScopeId: relayApp.task.conversationScopeId,
      workspaceId: relayApp.task.workspaceId,
      anchorMountToken: relayApp.anchorMountToken,
      anchorMountGeneration: relayApp.anchorMountGeneration,
    },
  },
  structuredContent: { task: relayApp.task },
});
await new Promise((resolve) => setTimeout(resolve, 20));
assert.equal(relayController.state.anchorSurface, false,
  "an ordinary show_changes relay must never become a second milestone-card surface");
assert.equal(relayController.state.senderCapability?.taskId, relayApp.task.id,
  "ordinary App result metadata must bind the verified sender capability");
assert.ok(relayApp.callInputs.some((entry) => entry.name === "continuation_sender" && entry.action === "heartbeat"),
  "the transport relay must prove its own liveness through continuation_sender");
assert.equal(relayApp.messages.length, 1,
  "a transport-only current App must immediately consume an already-READY generation after bind instead of waiting for the old anchor iframe or a later tick");
assert.ok(relayApp.callInputs.some((entry) => entry.name === "continuation_sender" && entry.action === "bind"),
  "the ordinary relay must rebind sender transport before consuming READY");
assert.ok(relayApp.callInputs.some((entry) => entry.name === "continuation_sender" && entry.action === "claim"));
assert.ok(relayApp.callInputs.some((entry) => entry.name === "continuation_sender" && entry.action === "authorize-delivery"));
relayController.dispose();

class ManualTakeoverBeforeSendApp extends FakeApp {
  async callServerTool(request) {
    const input = request.arguments;
    const senderAction = request.name === "continuation_sender"
      ? input.action
      : request.name === "continuation_anchor" && String(input.bridgeAction || "").startsWith("sender-")
        ? String(input.bridgeAction).slice("sender-".length)
        : undefined;
    if (senderAction === "authorize-delivery"
      && this.task?.deliveryOwner === "synthetic-pending") {
      // A manual user action that wins before the final authorization CAS must
      // make authorize-delivery reject. After a successful CAS the first Host
      // call is intentionally immediate; later transport retries recheck state.
      this.task = {
        ...this.task,
        continuationPending: false,
        continuationDeliveryAwaitingAck: false,
        deliveryToken: undefined,
        deliveryOwner: "manual",
        manualTakeoverAt: new Date().toISOString(),
      };
    }
    return super.callServerTool(request);
  }
}
const manualFenceApp = new ManualTakeoverBeforeSendApp();
manualFenceApp.task = {
  id: "task_manual_fence",
  workspaceId: "ws_manual_fence",
  state: "RUNNING",
  continuationMode: "completion-driven",
  objective: "manual user turn must win before visible synthetic delivery",
  requiredMilestones: ["done"],
  completedMilestones: [],
  continuationPending: false,
  watchProcessHandles: [],
  stallState: "CONTINUATION_ARMED",
  turnLeaseExpiresAt: new Date(Date.now() - 1000).toISOString(),
  turnStartedAt: new Date(Date.now() - 60_000).toISOString(),
};
const manualFenceController = installContinuationCoordinator(manualFenceApp, { timers: false, instanceId: "ui_manual_fence" });
manualFenceApp.emit("toolinput", { arguments: { workspaceId: "ws_manual_fence", taskId: "task_manual_fence" } });
await manualFenceController.onConnected();
assert.equal(await manualFenceController.attemptContinuation("manual fence test", { force: true }), false);
assert.equal(manualFenceApp.messages.length, 0,
  "if a manual turn takes ownership after claim but before sendMessage, the stale synthetic message must be suppressed completely");
manualFenceController.dispose();

// The authorization response can settle after this iframe has been disposed
// or superseded. A successful server CAS does not resurrect its local lifetime.
for (const retiredBy of ["dispose", "supersede"]) {
  let retiringController;
  class RetiredAfterAuthorizationApp extends FakeApp {
    async callServerTool(request) {
      const response = await super.callServerTool(request);
      if (request.name === "continuation_sender"
          && request.arguments.action === "authorize-delivery"
          && response.structuredContent?.accepted) {
        if (retiredBy === "dispose") retiringController.dispose();
        else this.emit("toolresult", {
          name: "continuation_task",
          structuredContent: { task: { ...this.task,
            anchorMountGeneration: this.anchorMountGeneration + 1,
            deliveryOwner: "manual", deliveryToken: undefined } },
        });
      }
      return response;
    }
  }
  const retiringApp = new RetiredAfterAuthorizationApp();
  retiringController = installContinuationCoordinator(retiringApp,
    { timers: false, instanceId: `ui_retired_${retiredBy}` });
  retiringApp.emit("toolinput", { arguments: { workspaceId: `ws_retired_${retiredBy}` } });
  await retiringController.onConnected();
  assert.equal(await retiringController.attemptContinuation("retired during authorization", { force: true }), false);
  assert.equal(retiringApp.messages.length, 0,
    `${retiredBy} while authorization is in flight must suppress the first Host send`);
  const before = retiringApp.callInputs.length;
  assert.equal(await retiringController.attemptContinuation("retired forced retry", { force: true, skipPrepare: true }), false);
  assert.equal(retiringApp.callInputs.length, before,
    "force/skipPrepare cannot revive a retired controller or start another claim");
  retiringController.dispose();
}

// ChatGPT may create the iframe and deliver toolinput but omit the one-shot
// initial toolresult. An explicit anchor taskId must bind that persisted task
// directly and must never create a begin-auto shadow task.
const explicitBindingApp = new FakeApp();
explicitBindingApp.autoEmitAnchorResult = false;
explicitBindingApp.task = {
  id: "task_explicit",
  workspaceId: "ws_explicit",
  state: "RUNNING",
  objective: "bind exact anchor task",
  requiredMilestones: ["done"],
  completedMilestones: [],
  continuationPending: false,
  watchProcessHandles: [],
  turnStartedAt: new Date(Date.now() - 1000).toISOString(),
};
const explicitBindingController = installContinuationCoordinator(explicitBindingApp, { timers: false, instanceId: "ui_explicit" });
explicitBindingApp.emit("toolinput", { arguments: { workspaceId: "ws_explicit", taskId: "task_explicit" } });
await explicitBindingController.onConnected();
assert.equal(explicitBindingController.state.task?.id, "task_explicit");
assert.ok(explicitBindingApp.calls.includes("status"), "explicit anchor taskId must be resolved through status when toolresult is absent");
assert.equal(explicitBindingApp.calls.includes("begin-auto"), false, "explicit anchor taskId must suppress begin-auto shadow task creation");
assert.equal(explicitBindingApp.callInputs.find((entry) => entry.name === "continuation_task"
  && entry.action === "status")?.taskId, "task_explicit");
assert.equal(
  explicitBindingApp.callInputs.some((entry) => isSenderControlCall(entry, "heartbeat")),
  false,
  "taskId-only recovery may bind the lifetime task, but a missing one-shot anchor capability must fail closed instead of fabricating sender authority",
);
explicitBindingController.dispose();

// Real Host ordering observed on 1.1.59: the visible manual-round card can be
// mounted and run sender heartbeats even when ChatGPT omits the one-shot
// continuation_anchor toolresult. The anchor surface must recover the exact
// current-generation capability from private sender bind, then immediately ACK
// that same card instead of remaining REQUESTED forever or minting another card.
class MissingToolResultAnchorApp extends FakeApp {
  constructor() {
    super();
    this.autoEmitAnchorResult = false;
    this.autoVerifyAnchor = false;
  }
  async callServerTool(request) {
    const input = request.arguments;
    const taskHeartbeat = (request.name === "continuation_task" && input.action === "heartbeat")
      || (request.name === "continuation_anchor" && input.bridgeAction === "task-heartbeat");
    if (taskHeartbeat
      && String(input.note || "").startsWith("anchor-mount-ack:")) {
      assert.equal(input.note, `anchor-mount-ack:${this.anchorMountToken}`);
      this.task = {
        ...this.task,
        anchorMountVerifiedAt: "2026-01-01T00:00:01.000Z",
        anchorMountCoordinatorId: input.coordinatorInstanceId,
        anchorMountGeneration: this.anchorMountGeneration,
      };
      this.calls.push(input.action);
      this.callInputs.push({ name: request.name, ...input });
      return { structuredContent: { task: this.task, accepted: true, reason: "anchor-mount-verified-via-heartbeat" } };
    }
    return super.callServerTool(request);
  }
}
const missingToolResultAnchorApp = new MissingToolResultAnchorApp();
missingToolResultAnchorApp.task = {
  id: "task_missing_toolresult_anchor",
  conversationScopeId: "conversation_missing_toolresult_anchor",
  workspaceId: "ws_missing_toolresult_anchor",
  state: "RUNNING",
  continuationMode: "completion-driven",
  objective: "verify the visible manual-round card even when toolresult is omitted",
  requiredMilestones: ["done"],
  completedMilestones: [],
  continuationPending: false,
  watchProcessHandles: [],
  anchorMountGeneration: 2,
  anchorMountRequestedAt: "2026-01-01T00:00:00.000Z",
  turnStartedAt: new Date(Date.now() - 1000).toISOString(),
};
missingToolResultAnchorApp.anchorMountGeneration = 2;
const missingToolResultAnchorController = installContinuationCoordinator(
  missingToolResultAnchorApp,
  { timers: false, instanceId: "ui_missing_toolresult_anchor" },
);
missingToolResultAnchorApp.emit("toolinput", {
  name: "continuation_anchor",
  arguments: {
    workspaceId: "ws_missing_toolresult_anchor",
    taskId: "task_missing_toolresult_anchor",
  },
});
await missingToolResultAnchorController.onConnected();
assert.equal(missingToolResultAnchorController.state.anchorMountToken, missingToolResultAnchorApp.anchorMountToken,
  "private sender bind must recover the mount token on the actual anchor surface when toolresult is absent");
assert.equal(missingToolResultAnchorController.state.anchorMountGeneration, 2,
  "private sender bind must recover only the authoritative current manual-round generation");
assert.equal(missingToolResultAnchorController.state.task?.anchorMountVerifiedAt, "2026-01-01T00:00:01.000Z",
  "the recovered capability must be used immediately to verify the already-visible manual-round card");
assert.ok(missingToolResultAnchorApp.callInputs.some((entry) => isSenderControlCall(entry, "bind")),
  "missing-toolresult recovery must still obtain capability only through the private sender bind path");
assert.ok(missingToolResultAnchorApp.callInputs.some((entry) => entry.name === "continuation_task"
  && entry.action === "heartbeat" && String(entry.note || "").startsWith("anchor-mount-ack:")),
  "the visible anchor must authenticate the recovered capability through the normal mount-ACK path");
missingToolResultAnchorController.dispose();

// Live dev12 failure: a historical card can remain mounted after a later manual
// turn rotates the lifetime task to a newer card generation, while ChatGPT may
// delay/omit mounting the *new* continuation_anchor iframe. The old visible UI
// must retire immediately, but killing its App transport strands a later READY
// generation forever (claimed_at/delivered_at stay null). Demote the old card to
// a sender-only relay, privately rebind it to the new generation, and let the
// atomic sender claim deliver exactly once without ACKing the new visible card.
const supersededSurfaceApp = new FakeApp();
supersededSurfaceApp.autoVerifyAnchor = false;
supersededSurfaceApp.task = {
  id: "task_superseded_surface",
  workspaceId: "ws_superseded_surface",
  state: "RUNNING",
  continuationMode: "completion-driven",
  objective: "only the newest milestone card may supervise",
  requiredMilestones: ["done"],
  completedMilestones: [],
  continuationPending: false,
  watchProcessHandles: [],
  stallState: "CONTINUATION_ARMED",
  anchorMountVerifiedAt: "2026-01-01T00:00:00.000Z",
  anchorMountCoordinatorId: "ui_generation_one",
  anchorMountGeneration: 1,
  anchorMountRequestedAt: "2026-01-01T00:00:00.000Z",
  turnLeaseExpiresAt: new Date(Date.now() - 1000).toISOString(),
  turnStartedAt: new Date(Date.now() - 60_000).toISOString(),
};
const supersededSurfaceController = installContinuationCoordinator(
  supersededSurfaceApp,
  { timers: false, instanceId: "ui_generation_one" },
);
supersededSurfaceApp.emit("toolinput", {
  name: "continuation_anchor",
  arguments: { workspaceId: "ws_superseded_surface", taskId: "task_superseded_surface" },
});
supersededSurfaceApp.emit("toolresult", {
  name: "continuation_anchor",
  structuredContent: {
    continuationAnchor: true,
    anchorMountGeneration: 1,
    task: supersededSurfaceApp.task,
  },
});
await supersededSurfaceController.onConnected();
assert.equal(supersededSurfaceController.state.anchorSuperseded, false);
assert.equal(supersededSurfaceController.state.anchorMountGeneration, 1);
supersededSurfaceApp.task = {
  ...supersededSurfaceApp.task,
  anchorMountVerifiedAt: undefined,
  anchorMountCoordinatorId: undefined,
  anchorMountGeneration: 2,
  anchorMountRequestedAt: "2026-01-01T00:01:00.000Z",
};
supersededSurfaceApp.anchorMountGeneration = 2;
supersededSurfaceApp.anchorMountToken = "00000000-0000-4000-8000-00000000a002";
supersededSurfaceApp.statusReadyGeneration = 13;
supersededSurfaceApp.bindReadyGeneration = 13;
const staleClaimCountBeforeRefresh = supersededSurfaceApp.callInputs.filter(
  (entry) => isSenderControlCall(entry, "claim"),
).length;
await supersededSurfaceController.refreshNow();
assert.equal(supersededSurfaceController.state.anchorSuperseded, true,
  "an old card must retire its visible surface as soon as authoritative status reports a newer generation");
assert.equal(supersededSurfaceController.state.anchorMountGeneration, 1,
  "supersession must never mutate the historical iframe into the new visible-card generation");
assert.equal(supersededSurfaceController.state.senderCapability, undefined,
  "a superseded historical card must discard sender authority and become inert presentation history");
assert.equal(
  supersededSurfaceApp.callInputs.filter(
    (entry) => isSenderControlCall(entry, "claim"),
  ).length,
  staleClaimCountBeforeRefresh,
  "a superseded historical card must never claim a current-generation READY",
);
assert.equal(supersededSurfaceApp.messages.length, 0,
  "a superseded historical card must never emit a continuation message");
assert.equal(supersededSurfaceApp.callInputs.some(
  (entry) => ((entry.name === "continuation_task" && entry.action === "anchor-mounted")
    || (entry.name === "continuation_anchor" && entry.bridgeAction === "task-anchor-mounted"))
    && Number(entry.anchorMountGeneration) === 2,
), false, "a superseded historical card must never impersonate the new card's mount ACK");
await supersededSurfaceController.refreshNow();
assert.equal(supersededSurfaceApp.messages.length, 0,
  "repeated refresh attempts on a superseded historical card must remain inert");
supersededSurfaceController.dispose();

class FlakyTransportApp extends FakeApp {
  constructor() {
    super();
    this.transientFailuresRemaining = 1;
  }
  async callServerTool({ name, arguments: input }) {
    const taskStatus = input.action === "status"
      || (name === "continuation_anchor" && input.bridgeAction === "task-status");
    if (taskStatus && this.transientFailuresRemaining > 0) {
      this.transientFailuresRemaining -= 1;
      throw new Error("Connection failed: transient TLS handshake");
    }
    return super.callServerTool({ name, arguments: input });
  }
}
const flakyTransportApp = new FlakyTransportApp();
flakyTransportApp.autoEmitAnchorResult = false;
flakyTransportApp.task = {
  id: "task_flaky_transport",
  workspaceId: "ws_flaky_transport",
  state: "RUNNING",
  continuationMode: "timeout-recovery",
  objective: "survive a transient MCP transport failure",
  requiredMilestones: ["done"],
  completedMilestones: [],
  continuationPending: false,
  watchProcessHandles: [],
  turnStartedAt: new Date(Date.now() - 1000).toISOString(),
  lastModelActivityAt: new Date().toISOString(),
};
const flakyTransportController = installContinuationCoordinator(flakyTransportApp, { timers: false, instanceId: "ui_flaky_transport" });
flakyTransportApp.emit("toolinput", { arguments: { workspaceId: "ws_flaky_transport", taskId: "task_flaky_transport" } });
await flakyTransportController.onConnected();
assert.equal(flakyTransportApp.transientFailuresRemaining, 0,
  "a transient Connection failed/TLS error must be retried by the Workspace App instead of abandoning the recovery task");
assert.equal(flakyTransportController.state.task?.id, "task_flaky_transport");
flakyTransportController.dispose();

const timerApp = new FakeApp();
timerApp.profileRecommendedMs = 10;
const timerController = installContinuationCoordinator(timerApp, {
  supervisorTickMs: 5,
  heartbeatIntervalMs: 25,
  instanceId: "ui_timer",
});
timerApp.emit("toolinput", { arguments: { workspaceId: "ws_timer" } });
await timerController.onConnected();
await new Promise((resolvePromise) => setTimeout(resolvePromise, 60));
assert.equal(timerApp.messages.length, 0,
  "a learned host budget must never pre-empt a still-running assistant turn");
timerController.dispose();

// Compatibility/implicit tasks must never turn ordinary model inactivity into
// a fresh conversation turn. This is the key false-positive regression from
// the old generic 60-second idle watchdog.
const compatSilentApp = new FakeApp();
compatSilentApp.task = {
  id: "task_compat_silent",
  workspaceId: "ws_compat_silent",
  state: "RUNNING",
  continuationMode: "compat",
  objective: "do not infer a long task from silence",
  requiredMilestones: ["done"],
  completedMilestones: [],
  continuationPending: false,
  watchProcessHandles: [],
  lastModelActivityAt: new Date(Date.now() - 1000).toISOString(),
  turnStartedAt: new Date(Date.now() - 1000).toISOString(),
};
const compatSilentController = installContinuationCoordinator(compatSilentApp, {
  supervisorTickMs: 5,
  heartbeatIntervalMs: 25,
  explicitSilentContinueMs: 20,
  instanceId: "ui_compat_silent",
});
compatSilentApp.emit("toolinput", { arguments: { workspaceId: "ws_compat_silent", taskId: "task_compat_silent" } });
await compatSilentController.onConnected();
await new Promise((resolvePromise) => setTimeout(resolvePromise, 60));
assert.equal(compatSilentApp.messages.length, 0,
  "compatibility/implicit task silence must never auto-continue");
compatSilentController.dispose();

// Even an explicitly anchored timeout-recovery task must fail closed when the
// Host emits no timeout/deadline/budget signal. Silence is not proof of truncation.
const explicitSilentApp = new FakeApp();
explicitSilentApp.task = {
  id: "task_explicit_silent",
  workspaceId: "ws_explicit_silent",
  state: "RUNNING",
  continuationMode: "timeout-recovery",
  objective: "do not resume until an explicit host timeout arrives",
  requiredMilestones: ["done"],
  completedMilestones: [],
  continuationPending: false,
  watchProcessHandles: [],
  lastModelActivityAt: new Date(Date.now() - 1000).toISOString(),
  turnStartedAt: new Date(Date.now() - 1000).toISOString(),
};
const explicitSilentController = installContinuationCoordinator(explicitSilentApp, {
  supervisorTickMs: 5,
  heartbeatIntervalMs: 25,
  instanceId: "ui_explicit_silent",
});
explicitSilentApp.emit("toolinput", { arguments: { workspaceId: "ws_explicit_silent", taskId: "task_explicit_silent" } });
await explicitSilentController.onConnected();
await new Promise((resolvePromise) => setTimeout(resolvePromise, 60));
assert.equal(explicitSilentApp.messages.length, 0,
  "timeout-recovery mode must not infer truncation from silence");
explicitSilentController.dispose();

const completionLeaseApp = new FakeApp();
completionLeaseApp.task = {
  id: "task_completion_lease",
  workspaceId: "ws_completion_lease",
  state: "RUNNING",
  continuationMode: "completion-driven",
  objective: "finish every milestone even if the model prematurely ends",
  requiredMilestones: ["done"],
  completedMilestones: [],
  continuationPending: false,
  watchProcessHandles: [],
  stallState: "ACTIVE",
  turnLeaseId: "turn_completion_lease",
  turnLeaseExpiresAt: new Date(Date.now() - 1000).toISOString(),
  lastModelActivityAt: new Date(Date.now() - 4 * 60_000).toISOString(),
  turnStartedAt: new Date(Date.now() - 4 * 60_000).toISOString(),
};
const completionLeaseController = installContinuationCoordinator(completionLeaseApp, {
  supervisorTickMs: 5,
  heartbeatIntervalMs: 25,
  instanceId: "ui_completion_lease",
});
completionLeaseApp.emit("toolinput", { arguments: { workspaceId: "ws_completion_lease", taskId: "task_completion_lease" } });
await completionLeaseController.onConnected();
await new Promise((resolvePromise) => setTimeout(resolvePromise, 60));
assert.equal(completionLeaseApp.messages.length, 0,
  "activity-lease expiry alone must not create another assistant turn during a long model think");
assert.equal(completionLeaseApp.task.stallState, "SUSPECTED_STALL",
  "activity-lease expiry should only persist a suspected stall");
assert.equal(completionLeaseApp.callInputs.some(
  (entry) => isSenderControlCall(entry, "claim"),
), false,
  "the first stall phase must not even claim a continuation");
completionLeaseController.dispose();

const completionArmedApp = new FakeApp();
completionArmedApp.task = {
  ...completionLeaseApp.task,
  id: "task_completion_armed",
  workspaceId: "ws_completion_armed",
  stallState: "CONTINUATION_ARMED",
  assistantTurnState: "COMPLETED",
  assistantTurnCompletionLeaseId: "turn_completion_lease",
  turnLeaseExpiresAt: new Date(Date.now() - 1000).toISOString(),
};
const completionArmedController = installContinuationCoordinator(completionArmedApp, {
  supervisorTickMs: 5,
  heartbeatIntervalMs: 25,
  instanceId: "ui_completion_armed",
});
completionArmedApp.emit("toolinput", { arguments: { workspaceId: "ws_completion_armed", taskId: "task_completion_armed" } });
await completionArmedController.onConnected();
await new Promise((resolvePromise) => setTimeout(resolvePromise, 60));
assert.equal(completionArmedApp.messages.length, 1,
  "an ATCC-completed current turn should resume the persisted task");
assert.equal(completionArmedApp.callInputs.find(
  (entry) => isSenderControlCall(entry, "claim"),
)?.note,
  "Assistant Turn Completion Contract armed");
completionArmedController.dispose();

const completionTeardownApp = new FakeApp();
completionTeardownApp.task = {
  id: "task_completion_teardown",
  workspaceId: "ws_completion_teardown",
  state: "RUNNING",
  continuationMode: "completion-driven",
  objective: "recover an incomplete task after the assistant ends",
  requiredMilestones: ["done"],
  completedMilestones: [],
  continuationPending: false,
  watchProcessHandles: [],
  turnLeaseExpiresAt: new Date(Date.now() + 2 * 60_000).toISOString(),
  turnStartedAt: new Date(Date.now() - 30_000).toISOString(),
  lastModelActivityAt: new Date().toISOString(),
};
const completionTeardownController = installContinuationCoordinator(completionTeardownApp, { timers: false, instanceId: "ui_completion_teardown" });
completionTeardownApp.emit("toolinput", { arguments: { workspaceId: "ws_completion_teardown", taskId: "task_completion_teardown" } });
await completionTeardownController.onConnected();
await completionTeardownController.onTeardown({ reason: "resource teardown" });
assert.equal(completionTeardownApp.messages.length, 0,
  "ordinary completion-driven resource teardown must fail closed before an explicit timeout or confirmed cutoff gate");
assert.equal(completionTeardownApp.callInputs.some(
  (entry) => isSenderControlCall(entry, "claim"),
), false,
  "ordinary iframe teardown must not even claim a continuation");
completionTeardownController.dispose();

const confirmedLeaseEarlyApp = new FakeApp();
confirmedLeaseEarlyApp.task = {
  id: "task_confirmed_lease_early",
  workspaceId: "ws_confirmed_lease_early",
  state: "RUNNING",
  continuationMode: "timeout-recovery",
  objective: "do not recover before the confirmed real cutoff",
  requiredMilestones: ["done"],
  completedMilestones: [],
  continuationPending: false,
  watchProcessHandles: [],
  confirmedTurnLimitMs: 30_000,
  turnStartedAt: new Date(Date.now() - 10_000).toISOString(),
  lastModelActivityAt: new Date(Date.now() - 40_000).toISOString(),
};
const confirmedLeaseEarlyController = installContinuationCoordinator(confirmedLeaseEarlyApp, {
  supervisorTickMs: 5,
  heartbeatIntervalMs: 25,
  instanceId: "ui_confirmed_lease_early",
});
confirmedLeaseEarlyApp.emit("toolinput", { arguments: { workspaceId: "ws_confirmed_lease_early", taskId: "task_confirmed_lease_early" } });
await confirmedLeaseEarlyController.onConnected();
await new Promise((resolvePromise) => setTimeout(resolvePromise, 60));
assert.equal(confirmedLeaseEarlyApp.messages.length, 0,
  "a confirmed cutoff lower bound must never become a pre-emptive timer before that bound elapses");
confirmedLeaseEarlyController.dispose();

const confirmedLeaseElapsedApp = new FakeApp();
confirmedLeaseElapsedApp.task = {
  id: "task_confirmed_lease_elapsed",
  workspaceId: "ws_confirmed_lease_elapsed",
  state: "RUNNING",
  continuationMode: "timeout-recovery",
  objective: "recover after confirmed cutoff when Host omits timeout and teardown",
  requiredMilestones: ["done"],
  completedMilestones: [],
  continuationPending: false,
  watchProcessHandles: [],
  confirmedTurnLimitMs: 30_000,
  turnStartedAt: new Date(Date.now() - 60_000).toISOString(),
  lastModelActivityAt: new Date(Date.now() - 40_000).toISOString(),
};
const confirmedLeaseElapsedController = installContinuationCoordinator(confirmedLeaseElapsedApp, {
  supervisorTickMs: 5,
  heartbeatIntervalMs: 25,
  instanceId: "ui_confirmed_lease_elapsed",
});
confirmedLeaseElapsedApp.emit("toolinput", { arguments: { workspaceId: "ws_confirmed_lease_elapsed", taskId: "task_confirmed_lease_elapsed" } });
await confirmedLeaseElapsedController.onConnected();
await new Promise((resolvePromise) => setTimeout(resolvePromise, 60));
assert.equal(confirmedLeaseElapsedApp.messages.length, 0,
  "an elapsed historical cutoff must remain telemetry-only when the current Host omitted a real end signal");
confirmedLeaseElapsedController.dispose();

// Completion-driven tasks must also refuse historical-cutoff-only recovery.
const completionConfirmedCutoffApp = new FakeApp();
completionConfirmedCutoffApp.task = {
  id: "task_completion_confirmed_cutoff",
  workspaceId: "ws_completion_confirmed_cutoff",
  state: "RUNNING",
  continuationMode: "completion-driven",
  objective: "recover completion-driven work after a confirmed Host cutoff",
  requiredMilestones: ["done"],
  completedMilestones: [],
  continuationPending: false,
  watchProcessHandles: [],
  stallState: "ACTIVE",
  confirmedTurnLimitMs: 30_000,
  turnStartedAt: new Date(Date.now() - 60_000).toISOString(),
  lastModelActivityAt: new Date(Date.now() - 40_000).toISOString(),
  // Deliberately keep the short activity lease unexpired. Recovery here must
  // come from the confirmed Host-cutoff gate, not from a heartbeat stall probe.
  turnLeaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
};
const completionConfirmedCutoffController = installContinuationCoordinator(completionConfirmedCutoffApp, {
  timers: false,
  instanceId: "ui_completion_confirmed_cutoff",
});
completionConfirmedCutoffApp.emit("toolinput", {
  arguments: { workspaceId: "ws_completion_confirmed_cutoff", taskId: "task_completion_confirmed_cutoff" },
});
await completionConfirmedCutoffController.onConnected();
assert.equal(completionConfirmedCutoffApp.messages.length, 0);
await completionConfirmedCutoffController.refreshNow();
assert.equal(completionConfirmedCutoffApp.messages.length, 0,
  "a reactivated completion-driven App must not infer current-turn completion from an old cutoff sample");
completionConfirmedCutoffController.dispose();

// A still-mounted turn card must catch up when a headless checkpoint/complete
// changes server state, and it must also observe same-task reactivation while
// that iframe remains alive instead of freezing forever at SUCCEEDED.
const authoritativeCardApp = new FakeApp();
authoritativeCardApp.task = {
  id: "task_authoritative_card",
  workspaceId: "ws_authoritative_card",
  state: "RUNNING",
  continuationMode: "completion-driven",
  objective: "authoritative card state",
  requiredMilestones: ["done"],
  completedMilestones: [],
  continuationPending: false,
  watchProcessHandles: [],
  stallState: "ACTIVE",
  turnStartedAt: new Date().toISOString(),
  turnLeaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
  lastModelActivityAt: new Date().toISOString(),
};
const authoritativeCardController = installContinuationCoordinator(authoritativeCardApp, {
  timers: false,
  terminalRefreshMs: 60_000,
  instanceId: "ui_authoritative_card",
});
authoritativeCardApp.emit("toolinput", { arguments: { workspaceId: "ws_authoritative_card", taskId: "task_authoritative_card" } });
await authoritativeCardController.onConnected();
authoritativeCardApp.task = {
  ...authoritativeCardApp.task,
  state: "SUCCEEDED",
  completedMilestones: ["done"],
};
await authoritativeCardController.refreshNow();
assert.equal(authoritativeCardController.state.task?.state, "SUCCEEDED",
  "an authoritative refresh must replace stale RUNNING card state with the persisted terminal state");
assert.deepEqual(authoritativeCardController.state.task?.completedMilestones, ["done"]);
authoritativeCardApp.task = {
  ...authoritativeCardApp.task,
  state: "RUNNING",
  objective: "next user task in the same conversation",
  requiredMilestones: ["next"],
  completedMilestones: [],
  turnStartedAt: new Date().toISOString(),
  turnLeaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
  lastModelActivityAt: new Date().toISOString(),
};
await authoritativeCardController.refreshNow();
assert.equal(authoritativeCardController.state.task?.state, "RUNNING",
  "a forced lifecycle refresh must bypass terminal polling cadence and observe same-task reactivation immediately");
assert.deepEqual(authoritativeCardController.state.task?.requiredMilestones, ["next"]);
authoritativeCardController.dispose();

const idleSuppressedByProcessApp = new FakeApp();
idleSuppressedByProcessApp.task = {
  id: "task_idle_process",
  workspaceId: "ws_idle_process",
  state: "RUNNING",
  continuationMode: "resident",
  objective: "do not preempt running durable process",
  requiredMilestones: ["done"],
  completedMilestones: [],
  continuationPending: false,
  watchProcessHandles: ["still-running"],
  lastModelActivityAt: new Date(Date.now() - 1000).toISOString(),
  turnStartedAt: new Date(Date.now() - 1000).toISOString(),
};
idleSuppressedByProcessApp.watchWakeReady = false;
const idleSuppressedByProcessController = installContinuationCoordinator(idleSuppressedByProcessApp, {
  supervisorTickMs: 5,
  heartbeatIntervalMs: 25,
  instanceId: "ui_idle_process",
});
idleSuppressedByProcessApp.emit("toolinput", { arguments: { workspaceId: "ws_idle_process", taskId: "task_idle_process" } });
await idleSuppressedByProcessController.onConnected();
await new Promise((resolvePromise) => setTimeout(resolvePromise, 60));
assert.equal(idleSuppressedByProcessApp.messages.length, 0,
  "a still-running durable process must not be preempted by unrelated timer activity");
assert.ok(idleSuppressedByProcessApp.calls.includes("watch-status"));
idleSuppressedByProcessController.dispose();

const pausedApp = new FakeApp();
pausedApp.task = {
  id: "task_paused",
  workspaceId: "ws_paused",
  state: "PAUSED_BY_USER",
  objective: "remain paused until the owner resumes it",
  requiredMilestones: ["done"],
  completedMilestones: [],
  continuationPending: false,
  watchProcessHandles: ["paused-process"],
  recommendedContinueAfterMs: 5,
  hostTimeoutSamples: 3,
  turnStartedAt: new Date(Date.now() - 1000).toISOString(),
};
pausedApp.watchWakeReady = true;
const pausedController = installContinuationCoordinator(pausedApp, {
  supervisorTickMs: 5,
  heartbeatIntervalMs: 25,
  instanceId: "ui_paused",
});
pausedApp.emit("toolinput", { arguments: { workspaceId: "ws_paused", taskId: "task_paused" } });
await pausedController.onConnected();
await new Promise((resolvePromise) => setTimeout(resolvePromise, 40));
assert.equal(pausedApp.messages.length, 0, "owner-paused tasks must suppress every automatic continuation path");
assert.equal(pausedApp.callInputs.some(
  (entry) => isSenderControlCall(entry, "claim"),
), false, "paused tasks must never be claimed automatically");
assert.equal(pausedApp.calls.includes("watch-status"), false, "paused tasks must preserve process watches without consuming them");
pausedController.dispose();

const processWatchApp = new FakeApp();
processWatchApp.task = {
  id: "task_process_watch",
  workspaceId: "ws_process_watch",
  state: "WAITING_EXTERNAL",
  continuationMode: "resident",
  objective: "monitor a resident process",
  requiredMilestones: ["done"],
  completedMilestones: [],
  continuationPending: false,
  watchProcessHandles: ["build-process"],
  turnStartedAt: new Date(Date.now() - 1000).toISOString(),
};
processWatchApp.watchWakeReady = true;
const processWatchController = installContinuationCoordinator(processWatchApp, {
  supervisorTickMs: 5,
  heartbeatIntervalMs: 25,
  instanceId: "ui_process_watch",
});
processWatchApp.emit("toolinput", { arguments: { workspaceId: "ws_process_watch", taskId: "task_process_watch" } });
await processWatchController.onConnected();
// First refresh observes process completion and lets the server-side wake
// transition materialize READY; the second observes/claims that durable READY.
await processWatchController.refreshNow();
await processWatchController.refreshNow();
assert.equal(processWatchApp.messages.length, 1, "resident watched process completion should wake without any learned minute budget");
processWatchController.dispose();

// Reproduce the real host ordering: the anchor renders first with no process
// watches, then a headless continuation_task call registers a watch and the
// assistant marks the task WAITING_EXTERNAL. The existing Workspace App must
// refresh authoritative server state, continue supervising the wait, resume it
// when the process completes, and deliver one follow-up.
const lateProcessWatchApp = new FakeApp();
const lateProcessWatchController = installContinuationCoordinator(lateProcessWatchApp, {
  supervisorTickMs: 5,
  heartbeatIntervalMs: 25,
  instanceId: "ui_late_process_watch",
});
lateProcessWatchApp.emit("toolinput", { arguments: { workspaceId: "ws_late_process_watch" } });
await lateProcessWatchController.onConnected();
lateProcessWatchApp.task = {
  ...lateProcessWatchApp.task,
  state: "WAITING_EXTERNAL",
  continuationMode: "resident",
  watchProcessHandles: ["late-build-process"],
};
lateProcessWatchApp.watchWakeReady = true;
await new Promise((resolvePromise) => setTimeout(resolvePromise, 650));
assert.ok(lateProcessWatchApp.calls.includes("status"), "supervisor must refresh task state after anchor render");
assert.ok(lateProcessWatchApp.calls.includes("watch-status"), "WAITING_EXTERNAL with a process watch must still poll watch-status");
assert.equal(lateProcessWatchApp.calls.includes("resume"), false,
  "process completion must not use the legacy client-side resume shortcut; the server owns the durable resident wake and READY transition");
assert.equal(lateProcessWatchApp.messages.length, 1, "late registered watched process should wake exactly once");
lateProcessWatchController.dispose();

const persistentWakeApp = new FakeApp();
persistentWakeApp.task = {
  id: "task_fake",
  workspaceId: "ws_persistent_wake",
  state: "RUNNING",
  continuationMode: "resident",
  objective: "finish persistent wake task",
  requiredMilestones: ["done"],
  completedMilestones: [],
  continuationPending: false,
  continuationWakePending: true,
  watchProcessHandles: [],
  turnStartedAt: new Date(Date.now() - 1000).toISOString(),
};
persistentWakeApp.bindReadyGeneration = 2;
const persistentWakeController = installContinuationCoordinator(persistentWakeApp, {
  supervisorTickMs: 5,
  heartbeatIntervalMs: 25,
  instanceId: "ui_persistent_wake",
});
persistentWakeApp.emit("toolinput", { arguments: { workspaceId: "ws_persistent_wake" } });
await persistentWakeController.onConnected();
await persistentWakeController.refreshNow();
assert.ok(persistentWakeApp.callInputs.some(
  (entry) => isSenderControlCall(entry, "claim"),
), "a current sender iframe must claim the durable READY created from a persisted resident wake");
assert.equal(persistentWakeApp.lastAuthorizeAccepted, true,
  "a persisted resident wake must reach the final sender authorization CAS through its durable READY generation; Host transport delivery is covered independently by relay/wire tests");
persistentWakeController.dispose();

const teardownApp = new FakeApp();
teardownApp.task = {
  id: "task_teardown",
  workspaceId: "ws_teardown",
  state: "RUNNING",
  continuationMode: "timeout-recovery",
  objective: "recover only after explicit host timeout",
  requiredMilestones: ["done"],
  completedMilestones: [],
  continuationPending: false,
  watchProcessHandles: [],
  turnStartedAt: new Date(Date.now() - 1000).toISOString(),
};
const teardownController = installContinuationCoordinator(teardownApp, { timers: false, instanceId: "ui_teardown" });
teardownApp.emit("toolinput", { arguments: { workspaceId: "ws_teardown", taskId: "task_teardown" } });
await teardownController.onConnected();
await teardownController.onTeardown({ reason: "host timeout" });
assert.equal(teardownApp.messages.length, 0,
  "free-form teardown reason text must not impersonate an authenticated exact-turn Host timeout");
assert.ok(teardownApp.callInputs.some(
  (entry) => isTaskControlCall(entry, "host-signal") && entry.hostSignal === "teardown",
), "generic resource teardown must be reported as teardown telemetry even when its reason string contains timeout");
teardownController.dispose();

const normalTeardownApp = new FakeApp();
const normalTeardownController = installContinuationCoordinator(normalTeardownApp, { timers: false, instanceId: "ui_normal_teardown" });
normalTeardownApp.emit("toolinput", { arguments: { workspaceId: "ws_normal_teardown" } });
await normalTeardownController.onConnected();
await normalTeardownController.onTeardown({ reason: "resource teardown" });
assert.equal(normalTeardownApp.messages.length, 0,
  "a normal host/resource teardown must not continue merely because milestones remain outstanding");
normalTeardownController.dispose();

const explicitTeardownApp = new FakeApp();
explicitTeardownApp.task = {
  id: "task_explicit_teardown",
  workspaceId: "ws_explicit_teardown",
  state: "RUNNING",
  continuationMode: "timeout-recovery",
  objective: "ordinary teardown must not pre-empt current work",
  requiredMilestones: ["done"],
  completedMilestones: [],
  continuationPending: false,
  watchProcessHandles: [],
  lastModelActivityAt: new Date().toISOString(),
  turnStartedAt: new Date().toISOString(),
};
const explicitTeardownController = installContinuationCoordinator(explicitTeardownApp, { timers: false, instanceId: "ui_explicit_teardown" });
explicitTeardownApp.emit("toolinput", { arguments: { workspaceId: "ws_explicit_teardown", taskId: "task_explicit_teardown" } });
await explicitTeardownController.onConnected();
await explicitTeardownController.onTeardown({ reason: "resource teardown" });
assert.equal(explicitTeardownApp.messages.length, 0,
  "timeout-recovery mode must ignore ordinary resource teardown without explicit timeout evidence");
explicitTeardownController.dispose();

const confirmedLimitEarlyTeardownApp = new FakeApp();
confirmedLimitEarlyTeardownApp.task = {
  id: "task_confirmed_limit_early",
  workspaceId: "ws_confirmed_limit_early",
  state: "RUNNING",
  continuationMode: "timeout-recovery",
  objective: "do not continue before confirmed host limit",
  requiredMilestones: ["done"],
  completedMilestones: [],
  continuationPending: false,
  confirmedTurnLimitMs: 30_000,
  turnStartedAt: new Date(Date.now() - 10_000).toISOString(),
};
const confirmedLimitEarlyController = installContinuationCoordinator(confirmedLimitEarlyTeardownApp, { timers: false, instanceId: "ui_confirmed_limit_early" });
confirmedLimitEarlyTeardownApp.emit("toolinput", { arguments: { workspaceId: "ws_confirmed_limit_early", taskId: "task_confirmed_limit_early" } });
await confirmedLimitEarlyController.onConnected();
await confirmedLimitEarlyController.onTeardown({});
assert.equal(confirmedLimitEarlyTeardownApp.messages.length, 0,
  "resource teardown before an explicitly confirmed Host limit must never start a new turn");
confirmedLimitEarlyController.dispose();

const confirmedLimitElapsedApp = new FakeApp();
confirmedLimitElapsedApp.task = {
  id: "task_confirmed_limit_elapsed",
  workspaceId: "ws_confirmed_limit_elapsed",
  state: "RUNNING",
  continuationMode: "timeout-recovery",
  objective: "continue only after confirmed host limit and teardown",
  requiredMilestones: ["done"],
  completedMilestones: [],
  continuationPending: false,
  confirmedTurnLimitMs: 30_000,
  turnStartedAt: new Date(Date.now() - 60_000).toISOString(),
  lastModelActivityAt: new Date(Date.now() - 35_000).toISOString(),
};
const confirmedLimitElapsedController = installContinuationCoordinator(confirmedLimitElapsedApp, { timers: false, instanceId: "ui_confirmed_limit_elapsed" });
confirmedLimitElapsedApp.emit("toolinput", { arguments: { workspaceId: "ws_confirmed_limit_elapsed", taskId: "task_confirmed_limit_elapsed" } });
await confirmedLimitElapsedController.onConnected();
await confirmedLimitElapsedController.onTeardown({});
assert.equal(confirmedLimitElapsedApp.messages.length, 0,
  "ordinary resource teardown must stay non-authorizing even after a historical Host cutoff elapsed; only verified current-card lifecycle teardown may recover");
confirmedLimitElapsedController.dispose();

const finishedTeardownApp = new FakeApp();
finishedTeardownApp.task = {
  id: "task_finished_teardown",
  workspaceId: "ws_finished_teardown",
  state: "RUNNING",
  continuationMode: "timeout-recovery",
  objective: "already finished milestones",
  requiredMilestones: ["done"],
  completedMilestones: ["done"],
  continuationPending: false,
  watchProcessHandles: [],
  turnStartedAt: new Date(Date.now() - 1000).toISOString(),
};
const finishedTeardownController = installContinuationCoordinator(finishedTeardownApp, { timers: false, instanceId: "ui_finished_teardown" });
finishedTeardownApp.emit("toolinput", { arguments: { workspaceId: "ws_finished_teardown", taskId: "task_finished_teardown" } });
await finishedTeardownController.onConnected();
await finishedTeardownController.onTeardown({ reason: "resource teardown" });
assert.equal(finishedTeardownApp.messages.length, 0,
  "normal teardown must not create a follow-up when every required milestone is already complete");
finishedTeardownController.dispose();

const { StructuredRuntimeState } = await import(`${pathToFileURL(runtimeStatePath).href}?continuation=${Date.now()}`);
const stateDir = mkdtempSync(join(tmpdir(), "devspace-continuation-test-"));
const runtime = new StructuredRuntimeState(stateDir);
configureTestSenderTransport(runtime);
try {
  const resumeFenceTask = runtime.continuationTask({
    action: "begin",
    conversationScopeId: "conversation-resume-fence",
    workspaceId: "ws_resume_fence",
    requiredMilestones: ["finish"],
  });
  const resumeFenceDeliveryToken = "00000000-0000-4000-8000-00000000f041";
  runtime.database.sqlite.prepare(`
    update continuation_tasks set
      continuation_pending=5,
      delivery_token=?,
      delivery_owner='synthetic-pending',
      assistant_turn_owner='synthetic'
    where id=?
  `).run(resumeFenceDeliveryToken, resumeFenceTask.task.id);
  const resumeFenceBefore = runtime.continuationTask({
    action: "status",
    taskId: resumeFenceTask.task.id,
    readOnlyStatus: true,
  }).task;
  const rejectedSyntheticResume = runtime.continuationTask({
    action: "resume",
    taskId: resumeFenceTask.task.id,
    note: "simulated coordinator reconnect",
  });
  assert.equal(rejectedSyntheticResume.accepted, false,
    "generic resume must be rejected while an ACK-waiting generation owns the synthetic delivery token");
  assert.equal(rejectedSyntheticResume.reason, "synthetic-delivery-resume-forbidden");
  const resumeFenceAfter = runtime.continuationTask({
    action: "status",
    taskId: resumeFenceTask.task.id,
    readOnlyStatus: true,
  }).task;
  assert.equal(resumeFenceAfter.deliveryToken, resumeFenceDeliveryToken,
    "rejected reconnect resume must preserve the exact delivery token for late model ACK/recovery");
  assert.equal(resumeFenceAfter.continuationPending, true,
    "rejected reconnect resume must preserve pending=5 rather than rewriting it as an ordinary manual turn");
  assert.equal(resumeFenceAfter.deliveryOwner, "synthetic-pending");
  assert.equal(resumeFenceAfter.assistantTurnOwner, "synthetic");
  assert.equal(resumeFenceAfter.turnLeaseId, resumeFenceBefore.turnLeaseId,
    "rejected reconnect resume must not mint a new manual turn lease");

  function verifyRuntimeAnchor(outcome, conversationScopeId, coordinatorInstanceId = "ui_runtime_verified_anchor", hostTurnFingerprint) {
    const requested = runtime.prepareContinuationAnchorMount({
      taskId: outcome.task.id,
      conversationScopeId,
      ...(hostTurnFingerprint ? { hostTurnFingerprint } : {}),
    });
    assert.ok(requested.anchorMountToken, "a never-mounted continuation card must receive a one-time mount token");
    const mounted = runtime.continuationTask({
      action: "anchor-mounted",
      taskId: outcome.task.id,
      conversationScopeId,
      coordinatorInstanceId,
      anchorMountToken: requested.anchorMountToken,
    });
    assert.equal(mounted.accepted, true);
    assert.ok(mounted.task.anchorMountVerifiedAt, "the actual iframe ACK must persist verified mount truth");
    const senderBound = runtime.bindContinuationSender(withTestSenderProtocol({
      conversationScopeId,
      taskId: outcome.task.id,
      senderInstanceId: coordinatorInstanceId,
      anchorMountGeneration: requested.anchorMountGeneration,
    }));
    assert.equal(senderBound.accepted, true,
      "a verified test App surface must also bind the current-process continuation sender just like the real coordinator does");
    return mounted;
  }

  function claimModernReadyGeneration(outcome, conversationScopeId, senderInstanceId, nowMs = Date.now() + 9_000) {
    const sweep = runtime.continuationSupervisorSweep({ nowMs });
    assert.equal(sweep.ready.some((item) => item.conversationScopeId === conversationScopeId), true,
      `expected modern READY generation for ${conversationScopeId}: ${JSON.stringify(sweep)}`);
    const card = runtime.database.sqlite.prepare(`
      select mount_token,mount_generation,sender_instance_id
      from continuation_conversation_cards where conversation_scope_id=?
    `).get(conversationScopeId);
    assert.ok(card?.mount_token);
    assert.equal(card?.sender_instance_id, senderInstanceId);
    const claim = runtime.claimReadyContinuationGeneration({
      conversationScopeId,
      taskId: outcome.task.id,
      senderInstanceId,
      anchorMountToken: card.mount_token,
      anchorMountGeneration: Number(card.mount_generation || 0),
    });
    assert.equal(claim.accepted, true, `modern generation claim failed: ${JSON.stringify(claim)}`);
    return { claim, card, sweep };
  }

  function authorizeModernGeneration(outcome, conversationScopeId, senderInstanceId, card, claim) {
    const authorized = runtime.authorizeContinuationGenerationDelivery({
      conversationScopeId,
      taskId: outcome.task.id,
      senderInstanceId,
      anchorMountToken: card.mount_token,
      anchorMountGeneration: Number(card.mount_generation || 0),
      deliveryToken: claim.deliveryToken,
    });
    assert.equal(authorized.accepted, true, `modern generation authorization failed: ${JSON.stringify(authorized)}`);
    return authorized;
  }

  // Sender authority is process-local even though the lifetime card itself is
  // durable. Reopening the same SQLite state must preserve the card generation
  // but invalidate the previous process's in-memory sender binding.
  const senderRestartStateDir = mkdtempSync(join(tmpdir(), "devspace-continuation-sender-restart-"));
  const senderRestartRuntimeA = new StructuredRuntimeState(senderRestartStateDir);
  configureTestSenderTransport(senderRestartRuntimeA);
  const senderRestartScope = "v1/test-sender-restart";
  const senderRestartTask = senderRestartRuntimeA.continuationTask({
    action: "begin",
    conversationScopeId: senderRestartScope,
    workspaceId: "ws_sender_restart",
    requiredMilestones: ["finish"],
  });
  const senderRestartAnchor = senderRestartRuntimeA.prepareContinuationAnchorMount({
    taskId: senderRestartTask.task.id,
    conversationScopeId: senderRestartScope,
  });
  const senderRestartMounted = senderRestartRuntimeA.continuationTask({
    action: "anchor-mounted",
    taskId: senderRestartTask.task.id,
    conversationScopeId: senderRestartScope,
    coordinatorInstanceId: "ui_sender_restart",
    anchorMountToken: senderRestartAnchor.anchorMountToken,
  });
  assert.equal(senderRestartMounted.accepted, true);
  const senderRestartBound = senderRestartRuntimeA.bindContinuationSender(withTestSenderProtocol({
    conversationScopeId: senderRestartScope,
    taskId: senderRestartTask.task.id,
    senderInstanceId: "ui_sender_restart",
    anchorMountGeneration: senderRestartAnchor.anchorMountGeneration,
  }));
  assert.equal(senderRestartBound.accepted, true, JSON.stringify(senderRestartBound));
  assert.equal(
    senderRestartRuntimeA.database.sqlite.prepare(
      "select sender_instance_id from continuation_conversation_cards where conversation_scope_id=?",
    ).get(senderRestartScope)?.sender_instance_id,
    "ui_sender_restart",
  );
  senderRestartRuntimeA.database.sqlite.close();
  const senderRestartRuntimeB = new StructuredRuntimeState(senderRestartStateDir);
  configureTestSenderTransport(senderRestartRuntimeB);
  assert.equal(
    senderRestartRuntimeB.database.sqlite.prepare(
      "select sender_instance_id from continuation_conversation_cards where conversation_scope_id=?",
    ).get(senderRestartScope)?.sender_instance_id,
    null,
    "a newly constructed MCP runtime must discard a sender binding owned by the previous process",
  );
  assert.equal(
    senderRestartRuntimeB.database.sqlite.prepare(
      "select mount_generation from continuation_conversation_cards where conversation_scope_id=?",
    ).get(senderRestartScope)?.mount_generation,
    senderRestartAnchor.anchorMountGeneration,
    "runtime restart must not rotate or destroy the durable lifetime-card generation while invalidating sender authority",
  );
  const staleCoordinatorHeartbeat = senderRestartRuntimeB.continuationTask({
    action: "heartbeat",
    taskId: senderRestartTask.task.id,
    conversationScopeId: senderRestartScope,
    coordinatorInstanceId: "ui_sender_restart_stale",
    note: "stale verified-anchor compatibility heartbeat",
  });
  assert.equal(staleCoordinatorHeartbeat.accepted, true,
    "a stale coordinator heartbeat may remain harmless control traffic");
  assert.equal(
    senderRestartRuntimeB.database.sqlite.prepare(
      "select sender_instance_id from continuation_conversation_cards where conversation_scope_id=?",
    ).get(senderRestartScope)?.sender_instance_id,
    null,
    "a stale/non-authoritative coordinator heartbeat must not reclaim sender authority",
  );
  const legacyVerifiedAnchorHeartbeat = senderRestartRuntimeB.continuationTask({
    action: "heartbeat",
    taskId: senderRestartTask.task.id,
    conversationScopeId: senderRestartScope,
    coordinatorInstanceId: "ui_sender_restart",
    note: "verified anchor heartbeat from pre-upgrade iframe",
  });
  assert.equal(legacyVerifiedAnchorHeartbeat.accepted, true,
    "the previously verified current coordinator must remain a valid lifetime-card heartbeat after MCP restart");
  assert.equal(
    senderRestartRuntimeB.database.sqlite.prepare(
      "select sender_instance_id from continuation_conversation_cards where conversation_scope_id=?",
    ).get(senderRestartScope)?.sender_instance_id,
    null,
    "ordinary lifetime-card heartbeat must never recreate sender authority after MCP restart",
  );
  const senderRestartPreBindHeartbeat = senderRestartRuntimeB.heartbeatContinuationSender(withTestSenderProtocol({
    conversationScopeId: senderRestartScope,
    taskId: senderRestartTask.task.id,
    senderInstanceId: "ui_sender_restart",
    anchorMountToken: senderRestartAnchor.anchorMountToken,
    anchorMountGeneration: senderRestartAnchor.anchorMountGeneration,
  }));
  assert.equal(senderRestartPreBindHeartbeat.accepted, false,
    "a sender heartbeat from the previous MCP process must not recreate authority in the new process");
  assert.equal(senderRestartPreBindHeartbeat.reason, "sender-rebind-required");
  assert.equal(
    senderRestartRuntimeB.database.sqlite.prepare(
      "select sender_instance_id from continuation_conversation_cards where conversation_scope_id=?",
    ).get(senderRestartScope)?.sender_instance_id,
    null,
    "restart recovery must remain unbound until the Workspace App performs a new sender bind",
  );
  const senderRestartRebound = senderRestartRuntimeB.bindContinuationSender(withStaleTestSenderProtocol({
    conversationScopeId: senderRestartScope,
    taskId: senderRestartTask.task.id,
    senderInstanceId: "ui_sender_restart",
    anchorMountGeneration: senderRestartAnchor.anchorMountGeneration,
  }));
  assert.equal(senderRestartRebound.accepted, false, JSON.stringify(senderRestartRebound));
  assert.equal(senderRestartRebound.reason, "sender-asset-revision-mismatch",
    "a cached same-epoch iframe must not regain sender authority after executable App bytes change");
  assert.equal(
    senderRestartRuntimeB.database.sqlite.prepare(
      "select sender_instance_id from continuation_conversation_cards where conversation_scope_id=?",
    ).get(senderRestartScope)?.sender_instance_id,
    null,
    "revision-drifted sender must leave the lifetime card unbound until the current resource rebinds",
  );
  assert.equal(
    senderRestartRuntimeB.database.sqlite.prepare(
      "select sender_last_failure_reason from continuation_conversation_cards where conversation_scope_id=?",
    ).get(senderRestartScope)?.sender_last_failure_reason,
    "sender-asset-revision-mismatch",
    "revision drift must remain explicit durable diagnostics rather than silently recovering stale code",
  );
  const senderRestartDiagnosticsAfterStale = senderRestartRuntimeB.continuationSenderDiagnostics();
  assert.equal(Number(senderRestartDiagnosticsAfterStale.upgradeRequiredCount || 0), 0,
    "same-epoch asset drift requires resource rebind, not an ABI upgrade");
  const senderRestartStaleHeartbeat = senderRestartRuntimeB.heartbeatContinuationSender(withStaleTestSenderProtocol({
    conversationScopeId: senderRestartScope,
    taskId: senderRestartTask.task.id,
    senderInstanceId: "ui_sender_restart",
    anchorMountToken: senderRestartAnchor.anchorMountToken,
    anchorMountGeneration: senderRestartAnchor.anchorMountGeneration,
  }));
  assert.equal(senderRestartStaleHeartbeat.accepted, false);
  assert.equal(senderRestartStaleHeartbeat.reason, "sender-asset-revision-mismatch",
    "stale revision heartbeat must not recreate or prolong sender authority");
  const senderRestartCurrentRebound = senderRestartRuntimeB.bindContinuationSender(withTestSenderProtocol({
    conversationScopeId: senderRestartScope,
    taskId: senderRestartTask.task.id,
    senderInstanceId: "ui_sender_restart_current",
    anchorMountGeneration: senderRestartAnchor.anchorMountGeneration,
  }));
  assert.equal(senderRestartCurrentRebound.accepted, true, JSON.stringify(senderRestartCurrentRebound));
  assert.equal(senderRestartCurrentRebound.anchorMountGeneration, senderRestartAnchor.anchorMountGeneration,
    "a current-revision iframe must rebind the existing lifetime card generation rather than minting a duplicate card");
  assert.equal(senderRestartCurrentRebound.senderStatus?.assetRevisionMatches, true);
  const senderRestartHeartbeat = senderRestartRuntimeB.heartbeatContinuationSender(withTestSenderProtocol({
    conversationScopeId: senderRestartScope,
    taskId: senderRestartTask.task.id,
    senderInstanceId: "ui_sender_restart_current",
    anchorMountToken: senderRestartAnchor.anchorMountToken,
    anchorMountGeneration: senderRestartAnchor.anchorMountGeneration,
  }));
  assert.equal(senderRestartHeartbeat.accepted, true,
    "after a fresh bind, sender heartbeat may refresh the current-process lease");
  const senderRestartCompetingHeartbeat = senderRestartRuntimeB.heartbeatContinuationSender(withTestSenderProtocol({
    conversationScopeId: senderRestartScope,
    taskId: senderRestartTask.task.id,
    senderInstanceId: "ui_sender_restart_competitor",
    anchorMountToken: senderRestartAnchor.anchorMountToken,
    anchorMountGeneration: senderRestartAnchor.anchorMountGeneration,
  }));
  assert.equal(senderRestartCompetingHeartbeat.accepted, false,
    "a heartbeat must never steal an already-restored process-local sender binding");
  assert.equal(senderRestartCompetingHeartbeat.reason, "sender-instance-superseded");
  senderRestartRuntimeB.touchContinuationModelActivity({
    workspaceId: "ws_sender_restart",
    conversationScopeId: senderRestartScope,
    substantive: true,
  });
  const senderRestartCompletion = senderRestartRuntimeB.continuationTask({
    action: "turn-complete",
    taskId: senderRestartTask.task.id,
    note: "restart fresh bind restored sender",
  });
  assert.equal(senderRestartCompletion.accepted, true,
    "after restart recovery performs a fresh sender bind, turn-complete must no longer fail with continuation-sender-unavailable");
  assert.equal(senderRestartCompletion.task.assistantTurnState, "COMPLETION_REQUESTED");
  senderRestartRuntimeB.database.sqlite.close();
  rmSync(senderRestartStateDir, { recursive: true, force: true });

  // dev71 live acceptance exposed the inverse of the old dev43 race: sender A
  // claimed READY, then a sibling iframe rebound the same card while A's claim
  // and heartbeat were both still valid. Returning that healthy claim to READY
  // added minutes before the same generation was reclaimed and delivered.
  // Preserve a live claim; only an expired claim, stale sender, or runtime
  // restart may transfer ownership to the replacement iframe.
  const rebindClaimScope = "v1/test-sender-rebind-claim-release";
  const rebindClaimTask = runtime.continuationTask({
    action: "begin",
    conversationScopeId: rebindClaimScope,
    workspaceId: "ws_sender_rebind_claim",
    requiredMilestones: ["finish"],
  });
  const rebindClaimAnchor = runtime.prepareContinuationAnchorMount({
    taskId: rebindClaimTask.task.id,
    conversationScopeId: rebindClaimScope,
  });
  assert.equal(runtime.continuationTask({
    action: "anchor-mounted",
    taskId: rebindClaimTask.task.id,
    conversationScopeId: rebindClaimScope,
    coordinatorInstanceId: "ui_rebind_claim_a",
    anchorMountToken: rebindClaimAnchor.anchorMountToken,
  }).accepted, true);
  assert.equal(runtime.bindContinuationSender(withTestSenderProtocol({
    conversationScopeId: rebindClaimScope,
    taskId: rebindClaimTask.task.id,
    senderInstanceId: "ui_rebind_claim_a",
    anchorMountGeneration: rebindClaimAnchor.anchorMountGeneration,
  })).accepted, true);
  runtime.touchContinuationModelActivity({
    workspaceId: "ws_sender_rebind_claim",
    conversationScopeId: rebindClaimScope,
    substantive: true,
  });
  const rebindClaimCompletion = runtime.continuationTask({
    action: "turn-complete",
    taskId: rebindClaimTask.task.id,
    note: "prepare READY for sender rebind race",
  });
  assert.equal(rebindClaimCompletion.accepted, true);
  const rebindClaimRequestedAt = Date.parse(rebindClaimCompletion.task.assistantTurnCompletionRequestedAt);
  const rebindClaimSweep = runtime.continuationSupervisorSweep({ nowMs: rebindClaimRequestedAt + 9_000 });
  assert.equal(rebindClaimSweep.ready.some((item) => item.conversationScopeId === rebindClaimScope), true);
  const senderAClaim = runtime.claimReadyContinuationGeneration({
    conversationScopeId: rebindClaimScope,
    taskId: rebindClaimTask.task.id,
    senderInstanceId: "ui_rebind_claim_a",
    anchorMountToken: rebindClaimAnchor.anchorMountToken,
    anchorMountGeneration: rebindClaimAnchor.anchorMountGeneration,
  });
  assert.equal(senderAClaim.accepted, true);
  const claimedGeneration = senderAClaim.generation;
  const senderAStatusBeforeSiblingBind = runtime.continuationSenderStatus({
    conversationScopeId: rebindClaimScope,
    taskId: rebindClaimTask.task.id,
  });
  assert.equal(senderAStatusBeforeSiblingBind.eligible, true,
    `sender A must be a healthy current-runtime transport before testing sibling-bind protection: ${JSON.stringify(senderAStatusBeforeSiblingBind)}`);
  const claimedBeforeSiblingBind = runtime.database.sqlite.prepare(`
    select state,delivery_token,due_at from continuation_generations
    where workset_id=(select active_workset_id from continuation_conversation_cards where conversation_scope_id=?)
      and generation=?
  `).get(rebindClaimScope, claimedGeneration);
  assert.equal(claimedBeforeSiblingBind?.state, "CLAIMED");
  assert.equal(claimedBeforeSiblingBind?.delivery_token, senderAClaim.deliveryToken);
  assert.ok(Date.parse(claimedBeforeSiblingBind?.due_at) > Date.now(),
    `sender A claim must still be inside its 45-second lease: ${JSON.stringify(claimedBeforeSiblingBind)}`);
  const senderBRebind = runtime.bindContinuationSender(withTestSenderProtocol({
    conversationScopeId: rebindClaimScope,
    taskId: rebindClaimTask.task.id,
    senderInstanceId: "ui_rebind_claim_b",
    anchorMountGeneration: rebindClaimAnchor.anchorMountGeneration,
  }));
  assert.equal(senderBRebind.accepted, false,
    "a sibling iframe must not steal a still-valid claim from a healthy current sender");
  assert.equal(senderBRebind.reason, "sender-claim-owned-by-live-sender");
  assert.ok(Date.parse(senderBRebind.retryAfterAt) > Date.now(),
    "the rejected sibling bind must expose the existing claim deadline rather than spin immediately");
  const preservedGeneration = runtime.database.sqlite.prepare(`
    select state,delivery_token from continuation_generations
    where workset_id=(select active_workset_id from continuation_conversation_cards where conversation_scope_id=?)
      and generation=?
  `).get(rebindClaimScope, claimedGeneration);
  assert.equal(preservedGeneration?.state, "CLAIMED");
  assert.equal(preservedGeneration?.delivery_token, senderAClaim.deliveryToken,
    "the protected generation must keep the exact sender-A delivery capability");
  assert.equal(runtime.database.sqlite.prepare(`
    select sender_instance_id from continuation_conversation_cards where conversation_scope_id=?
  `).get(rebindClaimScope)?.sender_instance_id, "ui_rebind_claim_a",
    "a rejected sibling bind must leave card sender ownership on the live claimant");

  runtime.database.sqlite.prepare(`
    update continuation_generations set due_at=?
    where workset_id=(select active_workset_id from continuation_conversation_cards where conversation_scope_id=?)
      and generation=? and state='CLAIMED'
  `).run(new Date(Date.now() - 1_000).toISOString(), rebindClaimScope, claimedGeneration);
  const senderBRebindAfterClaimExpiry = runtime.bindContinuationSender(withTestSenderProtocol({
    conversationScopeId: rebindClaimScope,
    taskId: rebindClaimTask.task.id,
    senderInstanceId: "ui_rebind_claim_b",
    anchorMountGeneration: rebindClaimAnchor.anchorMountGeneration,
  }));
  assert.equal(senderBRebindAfterClaimExpiry.accepted, true,
    "an expired claim must no longer pin sender ownership");
  assert.equal(senderBRebindAfterClaimExpiry.senderRebindReleasedClaim, true,
    "claim expiry must preserve the established safe release-to-READY recovery path");
  assert.equal(senderBRebindAfterClaimExpiry.senderRebindReleasedGeneration, claimedGeneration);
  assert.equal(senderBRebindAfterClaimExpiry.readyGeneration, claimedGeneration);
  const releasedGeneration = runtime.database.sqlite.prepare(`
    select state,delivery_token from continuation_generations
    where workset_id=(select active_workset_id from continuation_conversation_cards where conversation_scope_id=?)
      and generation=?
  `).get(rebindClaimScope, claimedGeneration);
  assert.equal(releasedGeneration?.state, "READY");
  assert.equal(releasedGeneration?.delivery_token, null);
  const senderBClaim = runtime.claimReadyContinuationGeneration({
    conversationScopeId: rebindClaimScope,
    taskId: rebindClaimTask.task.id,
    senderInstanceId: "ui_rebind_claim_b",
    anchorMountToken: rebindClaimAnchor.anchorMountToken,
    anchorMountGeneration: rebindClaimAnchor.anchorMountGeneration,
  });
  assert.equal(senderBClaim.accepted, true,
    "the replacement sender must be able to reclaim the released generation without waiting for the old 45-second claim lease");
  assert.equal(senderBClaim.generation, claimedGeneration);
  const rebindClaimLegacyAfterReclaim = runtime.database.sqlite.prepare(`
    select delivery_generation from continuation_tasks where id=?
  `).get(rebindClaimTask.task.id);
  assert.equal(Number(rebindClaimLegacyAfterReclaim?.delivery_generation), claimedGeneration,
    "the lifetime task projection must stay pinned to the architecture generation after repeated sender claims");
  const senderBAuthorized = runtime.authorizeContinuationGenerationDelivery({
    conversationScopeId: rebindClaimScope,
    taskId: rebindClaimTask.task.id,
    senderInstanceId: "ui_rebind_claim_b",
    anchorMountToken: rebindClaimAnchor.anchorMountToken,
    anchorMountGeneration: rebindClaimAnchor.anchorMountGeneration,
    deliveryToken: senderBClaim.deliveryToken,
  });
  assert.equal(senderBAuthorized.accepted, true);
  const deliveringBeforeAck = runtime.database.sqlite.prepare(`
    select state,delivered_at from continuation_generations
    where workset_id=(select active_workset_id from continuation_conversation_cards where conversation_scope_id=?)
      and generation=? and owner_type='synthetic'
  `).get(rebindClaimScope, claimedGeneration);
  assert.equal(deliveringBeforeAck?.state, "DELIVERING");
  assert.equal(deliveringBeforeAck?.delivered_at, null,
    "the production regression must omit the old iframe delivery receipt before the new model ACK");
  const senderBModelAck = runtime.continuationTask({
    action: "status",
    taskId: rebindClaimTask.task.id,
    deliveryToken: senderBClaim.deliveryToken,
  });
  assert.equal(senderBModelAck.accepted, true);
  assert.equal(senderBModelAck.reason, "continuation-resume-acknowledged");
  assert.equal(senderBModelAck.task.deliveryOwner, "synthetic-active");
  assert.equal(senderBModelAck.task.deliveryGeneration, claimedGeneration,
    "the resumed synthetic turn must retain the exact delivered architecture generation after ACK");
  const deliveringRecoveredByAck = runtime.database.sqlite.prepare(`
    select state,delivered_at,turn_acked_at from continuation_generations
    where workset_id=(select active_workset_id from continuation_conversation_cards where conversation_scope_id=?)
      and generation=? and owner_type='synthetic'
  `).get(rebindClaimScope, claimedGeneration);
  assert.equal(deliveringRecoveredByAck?.state, "TURN_ACKED");
  assert.ok(deliveringRecoveredByAck?.delivered_at);
  assert.ok(deliveringRecoveredByAck?.turn_acked_at,
    "an exact-token model ACK must recover a lost iframe receipt and establish real Host/tool-layer ownership");
  const recoveredAckEvents = runtime.pollEvents({
    kind: "continuation-generation-turn-acked",
    subject: rebindClaimScope,
    limit: 20,
  }).events;
  assert.equal(recoveredAckEvents.at(-1)?.payload?.deliveryReceiptRecoveredByModelAck, true,
    "the recovered DELIVERING->TURN_ACKED transition must remain observable in the event journal");
  const rebindSyntheticBeforeWork = runtime.database.sqlite.prepare(`
    select substantive_activity_count from continuation_generations
    where workset_id=(select active_workset_id from continuation_conversation_cards where conversation_scope_id=?)
      and generation=? and owner_type='synthetic'
  `).get(rebindClaimScope, claimedGeneration);
  runtime.touchContinuationModelActivity({
    workspaceId: "ws_sender_rebind_claim",
    conversationScopeId: rebindClaimScope,
    substantive: true,
  });
  const rebindSyntheticAfterWork = runtime.database.sqlite.prepare(`
    select state,substantive_activity_count from continuation_generations
    where workset_id=(select active_workset_id from continuation_conversation_cards where conversation_scope_id=?)
      and generation=? and owner_type='synthetic'
  `).get(rebindClaimScope, claimedGeneration);
  assert.equal(rebindSyntheticAfterWork?.state, "WORK_REQUIRED",
    "the first post-ACK substantive operation must advance the same synthetic generation to WORK_REQUIRED");
  assert.ok(Number(rebindSyntheticAfterWork?.substantive_activity_count) > Number(rebindSyntheticBeforeWork?.substantive_activity_count),
    "post-ACK substantive work must accumulate on the delivered synthetic generation");
  const rebindShadowManualGenerationCount = runtime.database.sqlite.prepare(`
    select count(*) as count from continuation_generations
    where workset_id=(select active_workset_id from continuation_conversation_cards where conversation_scope_id=?)
      and generation>? and owner_type='manual'
  `).get(rebindClaimScope, claimedGeneration)?.count ?? 0;
  assert.equal(rebindShadowManualGenerationCount, 0,
    "sender rebind and synthetic post-ACK work must never materialize a larger shadow manual generation");

  const staleSenderScope = "v1/test-sender-rebind-stale-heartbeat";
  const staleSenderTask = runtime.continuationTask({
    action: "begin",
    conversationScopeId: staleSenderScope,
    workspaceId: "ws_sender_rebind_stale_heartbeat",
    requiredMilestones: ["finish"],
  });
  const staleSenderAnchor = runtime.prepareContinuationAnchorMount({
    taskId: staleSenderTask.task.id,
    conversationScopeId: staleSenderScope,
  });
  assert.equal(runtime.continuationTask({
    action: "anchor-mounted",
    taskId: staleSenderTask.task.id,
    conversationScopeId: staleSenderScope,
    coordinatorInstanceId: "ui_stale_sender_a",
    anchorMountToken: staleSenderAnchor.anchorMountToken,
  }).accepted, true);
  assert.equal(runtime.bindContinuationSender(withTestSenderProtocol({
    conversationScopeId: staleSenderScope,
    taskId: staleSenderTask.task.id,
    senderInstanceId: "ui_stale_sender_a",
    anchorMountGeneration: staleSenderAnchor.anchorMountGeneration,
  })).accepted, true);
  runtime.touchContinuationModelActivity({
    workspaceId: "ws_sender_rebind_stale_heartbeat",
    conversationScopeId: staleSenderScope,
    substantive: true,
  });
  const staleSenderCompletion = runtime.continuationTask({
    action: "turn-complete",
    taskId: staleSenderTask.task.id,
    note: "prepare READY for stale sender takeover",
  });
  assert.equal(staleSenderCompletion.accepted, true);
  const staleSenderRequestedAt = Date.parse(staleSenderCompletion.task.assistantTurnCompletionRequestedAt);
  assert.equal(runtime.continuationSupervisorSweep({ nowMs: staleSenderRequestedAt + 9_000 }).ready
    .some((item) => item.conversationScopeId === staleSenderScope), true);
  const staleSenderAClaim = runtime.claimReadyContinuationGeneration({
    conversationScopeId: staleSenderScope,
    taskId: staleSenderTask.task.id,
    senderInstanceId: "ui_stale_sender_a",
    anchorMountToken: staleSenderAnchor.anchorMountToken,
    anchorMountGeneration: staleSenderAnchor.anchorMountGeneration,
  });
  assert.equal(staleSenderAClaim.accepted, true);
  const staleClaimBeforeTakeover = runtime.database.sqlite.prepare(`
    select state,delivery_token,due_at from continuation_generations
    where workset_id=(select active_workset_id from continuation_conversation_cards where conversation_scope_id=?)
      and generation=?
  `).get(staleSenderScope, staleSenderAClaim.generation);
  assert.ok(Date.parse(staleClaimBeforeTakeover?.due_at) > Date.now(),
    "stale-heartbeat takeover must be tested while the old sender's generation claim itself is still valid");
  runtime.database.sqlite.prepare(`
    update continuation_conversation_cards set sender_last_heartbeat_at=? where conversation_scope_id=?
  `).run(new Date(Date.now() - 91_000).toISOString(), staleSenderScope);
  const staleSenderBTakeover = runtime.bindContinuationSender(withTestSenderProtocol({
    conversationScopeId: staleSenderScope,
    taskId: staleSenderTask.task.id,
    senderInstanceId: "ui_stale_sender_b",
    anchorMountGeneration: staleSenderAnchor.anchorMountGeneration,
  }));
  assert.equal(staleSenderBTakeover.accepted, true,
    "a stale sender heartbeat must remove live-claim protection even before the 45-second generation claim expires");
  assert.equal(staleSenderBTakeover.senderRebindReleasedClaim, true);
  assert.equal(staleSenderBTakeover.senderRebindReleasedGeneration, staleSenderAClaim.generation);
  assert.equal(staleSenderBTakeover.readyGeneration, staleSenderAClaim.generation);
  assert.equal(runtime.database.sqlite.prepare(`
    select sender_instance_id from continuation_conversation_cards where conversation_scope_id=?
  `).get(staleSenderScope)?.sender_instance_id, "ui_stale_sender_b",
    "the replacement iframe must become sender owner once the previous heartbeat is stale");

  const a = runtime.continuationTask({
    action: "begin-auto",
    conversationScopeId: "v1/test-conversation-a",
    workspaceId: "ws_shared",
    objective: "generic",
    maxNoProgress: 2,
    maxSameFailure: 2,
  });
  assert.equal(a.created, true);
  assert.equal(a.task.state, "RUNNING");
  assert.equal(a.task.continuationMode, "completion-driven");
  assert.equal(a.task.maxContinuations, 0, "automatic Task Contracts must default to unlimited continuations");
  assert.equal(a.task.unlimitedContinuations, true);
  assert.equal(a.task.deadlineAt, undefined, "automatic Task Contracts must have no wall-clock deadline by default");
  assert.equal(a.task.unlimitedWallClock, true);
  assert.equal(a.task.autoCreated, true);
  assert.equal(a.task.taskSource, "auto-conversation");
  assert.equal(a.task.contractVersion, 2);
  assert.ok(a.task.requiredMilestones.length >= 2, "automatic task contracts must never be 0/0");
  assert.ok(a.task.turnStartedAt);
  assert.ok(a.task.turnLeaseId);
  assert.ok(a.task.turnLeaseExpiresAt, "completion-driven Task Contracts must persist a renewable model Turn Lease");
  assert.ok(a.task.lastModelActivityAt);
  const automaticDirective = runtime.continuationTask({ action: "status", taskId: a.task.id });
  assert.equal(automaticDirective.taskIncomplete, true);
  assert.equal(automaticDirective.finalResponseAllowed, false,
    "an unfinished automatic task contract must forbid a status-only final response");
  assert.deepEqual(automaticDirective.remainingMilestones, a.task.requiredMilestones);
  assert.equal(automaticDirective.task.lastModelActivityAt, a.task.lastModelActivityAt,
    "plain status control traffic must not renew model activity");
  assert.equal(automaticDirective.task.turnLeaseExpiresAt, a.task.turnLeaseExpiresAt,
    "plain status control traffic must not push the completion activity lease forward");
  assert.equal(automaticDirective.task.stallState, a.task.stallState,
    "plain status control traffic must not reset a stall state to ACTIVE");

  const modelActivityBefore = a.task.lastModelActivityAt;
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 2));
  const touchedTaskId = runtime.touchContinuationModelActivity({
    conversationScopeId: "v1/test-conversation-a",
    workspaceId: "ws_shared",
  });
  assert.equal(touchedTaskId, a.task.id);
  const touchedActivity = runtime.continuationTask({ action: "status", taskId: a.task.id });
  assert.ok(Date.parse(touchedActivity.task.lastModelActivityAt) >= Date.parse(modelActivityBefore));
  assert.equal(runtime.continuationSupervisorDirective({
    conversationScopeId: "v1/test-conversation-a",
    workspaceId: "ws_shared",
  })?.reanchorRequired, true, "automatic Task Contracts must request a supervisor until the open-workspace anchor is live");
  const aVerifiedAnchor = verifyRuntimeAnchor(a, "v1/test-conversation-a", "ui_test");

  // ChatGPT App-originated callServerTool requests may omit openai/session even
  // though the model-side continuation_anchor call had a canonical scope. The
  // exact taskId/workspaceId plus one-time capability must still bind the same
  // task; a forged capability must remain fail-closed.
  const appOriginMount = runtime.continuationTask({
    action: "begin",
    conversationScopeId: "v1/test-app-origin-missing-scope",
    workspaceId: "ws_app_origin_missing_scope",
    objective: "verify anchor ACK when App proxy omits conversation metadata",
    requiredMilestones: ["mounted"],
    continuationMode: "completion-driven",
  });
  const appOriginMountRequest = runtime.prepareContinuationAnchorMount({
    taskId: appOriginMount.task.id,
    conversationScopeId: "v1/test-app-origin-missing-scope",
    hostTurnFingerprint: "host-turn-app-origin",
  });
  const appOriginBadAck = runtime.continuationTask({
    action: "anchor-mounted",
    taskId: appOriginMount.task.id,
    workspaceId: "ws_app_origin_missing_scope",
    coordinatorInstanceId: "ui_app_origin",
    anchorMountToken: "00000000-0000-4000-8000-000000000000",
  });
  assert.equal(appOriginBadAck.accepted, false,
    "missing conversation metadata must not weaken the one-time anchor capability check");
  assert.equal(appOriginBadAck.reason, "anchor-mount-token-mismatch");
  const appOriginGoodAck = runtime.continuationTask({
    action: "anchor-mounted",
    taskId: appOriginMount.task.id,
    workspaceId: "ws_app_origin_missing_scope",
    coordinatorInstanceId: "ui_app_origin",
    anchorMountToken: appOriginMountRequest.anchorMountToken,
  });
  assert.equal(appOriginGoodAck.accepted, true,
    "an App-origin ACK with exact task/workspace/token must bind even when the Host omits openai/session metadata");
  assert.equal(appOriginGoodAck.task.conversationScopeId, "v1/test-app-origin-missing-scope",
    "App-origin fallback lookup must preserve the task's canonical conversation identity rather than rewriting it");
  assert.equal(appOriginGoodAck.task.anchorMountCoordinatorId, "ui_app_origin");
  assert.ok(appOriginGoodAck.task.anchorMountVerifiedAt);

  // A completion-driven task may become quiet before the Host hard cutoff, but
  // DevSpace cannot observe hidden model reasoning.  Expired-lease heartbeats
  // therefore remain suspicion only unless independent Host/cutoff evidence
  // proves that the assistant turn actually ended.
  const earlyStop = runtime.continuationTask({
    action: "begin",
    conversationScopeId: "v1/test-early-voluntary-stop",
    workspaceId: "ws_early_stop",
    objective: "resume unfinished work after the model voluntarily ends",
    requiredMilestones: ["finish"],
    continuationMode: "completion-driven",
  });
  const earlyStopMount = runtime.prepareContinuationAnchorMount({
    taskId: earlyStop.task.id,
    conversationScopeId: "v1/test-early-voluntary-stop",
    hostTurnFingerprint: "host-turn-early-stop",
  });
  const earlyStopVerified = runtime.continuationTask({
    action: "anchor-mounted",
    taskId: earlyStop.task.id,
    conversationScopeId: "v1/test-early-voluntary-stop",
    coordinatorInstanceId: "ui_early_stop",
    anchorMountToken: earlyStopMount.anchorMountToken,
  });
  assert.equal(earlyStopVerified.accepted, true);
  runtime.database.sqlite.prepare(`
    update continuation_tasks set turn_lease_expires_at=?, last_model_activity_at=?,
      stall_state='ACTIVE', stall_suspected_at=null, stall_probe_count=0,
      stall_last_probe_at=null, stall_armed_at=null, stall_evidence=null where id=?
  `).run(
    new Date(Date.now() - 1000).toISOString(),
    new Date(Date.now() - 6 * 60_000).toISOString(),
    earlyStop.task.id,
  );
  const nonOwnerProbe = runtime.continuationTask({
    action: "heartbeat",
    taskId: earlyStop.task.id,
    coordinatorInstanceId: "ui_unrelated_card",
    note: "unrelated card must not corroborate stall",
  });
  assert.equal(nonOwnerProbe.task.stallState, "ACTIVE",
    "only the verified current-generation milestone card may advance completion stall state");
  assert.equal(nonOwnerProbe.task.anchorMountCoordinatorId, "ui_early_stop");
  const firstEarlyProbe = runtime.continuationTask({
    action: "heartbeat",
    taskId: earlyStop.task.id,
    coordinatorInstanceId: "ui_early_stop",
    note: "first completion stall probe",
  });
  assert.equal(firstEarlyProbe.task.stallState, "SUSPECTED_STALL",
    "the first quiet lease expiry must not immediately create another assistant turn");
  assert.equal(firstEarlyProbe.task.stallProbeCount, 1);
  const prematureSecondEarlyProbe = runtime.continuationTask({
    action: "heartbeat",
    taskId: earlyStop.task.id,
    coordinatorInstanceId: "ui_early_stop",
    note: "premature second completion stall probe",
  });
  assert.equal(prematureSecondEarlyProbe.task.stallState, "SUSPECTED_STALL",
    "a second probe inside the short debounce must not create another assistant turn");
  runtime.database.sqlite.prepare("update continuation_tasks set stall_suspected_at=? where id=?")
    .run(new Date(Date.now() - 13_000).toISOString(), earlyStop.task.id);
  const laterHeartbeatProbe = runtime.continuationTask({
    action: "heartbeat",
    taskId: earlyStop.task.id,
    coordinatorInstanceId: "ui_early_stop",
    note: "later completion stall liveness probe",
  });
  assert.equal(laterHeartbeatProbe.task.stallState, "SUSPECTED_STALL",
    "even a much later verified iframe heartbeat must not infer that a long-running assistant turn has ended");
  assert.equal(laterHeartbeatProbe.task.stallEvidence, "model-activity-lease-expired",
    "heartbeat-only evidence must remain a weak liveness suspicion rather than a recovery authorization");
  const earlyStopClaim = runtime.continuationTask({
    action: "claim-continuation",
    taskId: earlyStop.task.id,
    note: "task contract stall corroborated",
  });
  assert.equal(earlyStopClaim.accepted, false,
    "heartbeat-only silence must fail closed and must not authorize a synthetic continuation during long-running work");
  assert.equal(earlyStopClaim.reason, "continuation-trigger-not-authorized");

  const ensured = runtime.ensureContinuationTaskContract({
    conversationScopeId: "v1/test-conversation-a",
    workspaceId: "ws_shared",
    sourceTool: "read",
    substantive: true,
  });
  assert.equal(ensured.created, false);
  assert.equal(ensured.task.id, a.task.id, "the same conversation+workspace must reuse one Task Contract");
  assert.ok(ensured.task.substantiveActivityCount >= 1);
  runtime.database.sqlite.prepare("update continuation_tasks set last_activity_at=?, updated_at=? where id=?")
    .run(new Date(Date.now() - 48 * 60 * 60_000).toISOString(), new Date(Date.now() - 48 * 60 * 60_000).toISOString(), a.task.id);
  const completionContractReap = runtime.reapAbandonedContinuationTasks({ maxAgeMs: 60_000 });
  assert.equal(completionContractReap.abandoned, 0,
    "completion-driven Task Contracts must never be auto-abandoned because their total wall-clock lifetime is intentionally unlimited");
  assert.equal(runtime.continuationTask({ action: "status", taskId: a.task.id }).task.state, "RUNNING");

  const conversationSingletonA = runtime.continuationTask({
    action: "begin-auto",
    conversationScopeId: "v1/test-conversation-singleton",
    workspaceId: "ws_singleton_a",
  });
  const conversationSingletonB = runtime.ensureContinuationTaskContract({
    conversationScopeId: "v1/test-conversation-singleton",
    workspaceId: "ws_singleton_b",
    sourceTool: "read",
    substantive: true,
  });
  assert.equal(conversationSingletonB.task.id, conversationSingletonA.task.id,
    "one real ChatGPT conversation must reuse the same active Task Contract across workspace switches");
  assert.equal(conversationSingletonB.task.workspaceId, "ws_singleton_b",
    "workspaceId is current execution context, not Task Contract identity");
  const singletonRows = runtime.database.sqlite.prepare(`
    select count(*) as count from continuation_tasks
    where conversation_scope_id='v1/test-conversation-singleton'
      and state not in ('SUCCEEDED','FAILED_TERMINAL','CANCELLED_BY_USER','ABORTED_NO_PROGRESS','BUDGET_EXHAUSTED','ABANDONED_AUTO_TASK')
  `).get();
  assert.equal(Number(singletonRows.count), 1, "SQLite must enforce one active task per real conversation scope");

  const lifetimeSingleton = runtime.continuationTask({
    action: "begin",
    conversationScopeId: "v1/test-conversation-lifetime-singleton",
    workspaceId: "ws_lifetime_a",
    objective: "finish the first user task",
    requiredMilestones: ["first user task"],
    sourceTool: "continuation_anchor",
    anchorMounted: false,
  });
  assert.equal(lifetimeSingleton.task.anchorMountVerifiedAt, undefined,
    "the model-side continuation_anchor request must not count as a visible card before iframe ACK");
  const lifetimeVerified = verifyRuntimeAnchor(lifetimeSingleton, "v1/test-conversation-lifetime-singleton", "ui_lifetime_anchor");
  const firstAnchorMountedAt = lifetimeVerified.task.lastAnchorMountedAt;
  const firstAnchorVerifiedAt = lifetimeVerified.task.anchorMountVerifiedAt;
  const firstAnchorGeneration = lifetimeVerified.task.anchorMountGeneration;
  runtime.continuationTask({
    action: "checkpoint",
    taskId: lifetimeSingleton.task.id,
    completedMilestones: ["first user task"],
    evidence: { first: "verified" },
    progressFingerprint: "first-user-task-complete",
  });
  const firstEpochCompleted = runtime.continuationTask({
    action: "complete",
    taskId: lifetimeSingleton.task.id,
    evidence: { first: "verified" },
  });
  assert.equal(firstEpochCompleted.task.state, "SUCCEEDED");
  const terminalAutoReuse = runtime.continuationTask({
    action: "begin-auto",
    conversationScopeId: "v1/test-conversation-lifetime-singleton",
    workspaceId: "ws_lifetime_b",
  });
  assert.equal(terminalAutoReuse.task.id, lifetimeSingleton.task.id,
    "begin-auto after completion must return the existing real-conversation ledger instead of creating a second task/card");
  assert.equal(terminalAutoReuse.task.state, "SUCCEEDED",
    "automatic App rehydrate must not silently reactivate completed work without a new semantic milestone");
  const completedLedgerReuse = runtime.ensureContinuationTaskContract({
    conversationScopeId: "v1/test-conversation-lifetime-singleton",
    workspaceId: "ws_lifetime_b",
    sourceTool: "open_workspace",
    substantive: false,
  });
  assert.equal(completedLedgerReuse.task.id, lifetimeSingleton.task.id,
    "a completed real-conversation Task Contract must remain the lifetime ledger instead of creating a second task/card");
  assert.equal(completedLedgerReuse.newMilestoneRequired, true,
    "a new user work epoch must be explicitly represented by a new milestone before substantive tools run");
  assert.equal(completedLedgerReuse.initialAnchorRequired, false,
    "a completed conversation ledger with an existing card must never request another visible anchor");
  const secondEpoch = runtime.continuationTask({
    action: "begin",
    taskId: lifetimeSingleton.task.id,
    conversationScopeId: "v1/test-conversation-lifetime-singleton",
    workspaceId: "ws_lifetime_b",
    objective: "finish the second user task",
    requiredMilestones: ["second user task"],
    sourceTool: "continuation_task",
    anchorMounted: false,
  });
  assert.equal(secondEpoch.task.id, lifetimeSingleton.task.id,
    "new user work after SUCCEEDED must reactivate the same taskId rather than create a shadow task");
  assert.equal(secondEpoch.task.state, "RUNNING");
  assert.deepEqual(secondEpoch.task.requiredMilestones, ["second user task"],
    "a later manual user task must replace the active milestone plan instead of projecting the lifetime history union");
  assert.deepEqual(secondEpoch.task.completedMilestones, [],
    "completed milestones from the previous manual task must remain historical rather than leak into the new active plan");
  const secondEpochArchitecture = runtime.continuationArchitectureSnapshot("v1/test-conversation-lifetime-singleton");
  const historicalFirstWorkset = secondEpochArchitecture.worksets.find((row) => row.sequence === 1);
  const activeSecondWorkset = secondEpochArchitecture.worksets.find((row) => row.id === secondEpochArchitecture.card.active_workset_id);
  assert.equal(historicalFirstWorkset?.state, "SUCCEEDED",
    "replacing the active plan must preserve the completed first user task as historical Workset lineage");
  assert.equal(activeSecondWorkset?.sequence, 2,
    "the second manual task must allocate exactly one sequential active Workset");
  assert.deepEqual(
    secondEpochArchitecture.milestones
      .filter((row) => row.workset_id === historicalFirstWorkset?.id && row.state !== "ARCHIVED")
      .map((row) => row.description),
    ["first user task"],
    "historical Workset lineage must retain the first task milestone after active-plan replacement",
  );
  assert.equal(secondEpoch.task.lastAnchorMountedAt, undefined,
    "reactivating later manual user work must clear the prior card mount while keeping the same lifetime task row");
  assert.equal(secondEpoch.task.anchorMountVerifiedAt, undefined,
    "reactivating later manual work must require the fresh card generation to ACK independently");
  assert.equal(secondEpoch.task.anchorMountGeneration, firstAnchorGeneration + 1,
    "reactivating a completed lifetime ledger for a later manual message must rotate exactly one fresh card generation");
  assert.equal(secondEpoch.manualRoundCardRequired, true);
  assert.equal(secondEpoch.initialAnchorRequired, true);
  const lifetimeRows = runtime.database.sqlite.prepare(`
    select count(*) as count from continuation_tasks
    where conversation_scope_id='v1/test-conversation-lifetime-singleton'
  `).get();
  assert.equal(Number(lifetimeRows.count), 1,
    "a real ChatGPT conversation must retain exactly one lifetime Task Contract row across completed and reactivated work epochs");
  const lifetimeEnsuredAgain = runtime.ensureContinuationTaskContract({
    conversationScopeId: "v1/test-conversation-lifetime-singleton",
    workspaceId: "ws_lifetime_c",
    sourceTool: "read",
    substantive: true,
  });
  assert.equal(lifetimeEnsuredAgain.task.id, lifetimeSingleton.task.id);
  assert.equal(lifetimeEnsuredAgain.newMilestoneRequired, false);
  const secondEpochAnchorDirective = runtime.continuationSupervisorDirective({
    conversationScopeId: "v1/test-conversation-lifetime-singleton",
    workspaceId: "ws_lifetime_c",
  });
  assert.equal(secondEpochAnchorDirective?.taskId, lifetimeSingleton.task.id);
  assert.equal(secondEpochAnchorDirective?.initialAnchorRequired, true,
    "later manual user work must request the newly-rotated visible card before becoming headless again");
  assert.equal(secondEpochAnchorDirective?.reanchorRequired, true);
  assert.equal(secondEpochAnchorDirective?.reason, "initial-anchor-required");
  const secondEpochVerified = verifyRuntimeAnchor(
    secondEpoch,
    "v1/test-conversation-lifetime-singleton",
    "ui_lifetime_anchor_second",
  );
  assert.equal(secondEpochVerified.task.anchorMountGeneration, firstAnchorGeneration + 1);
  assert.ok(secondEpochVerified.task.anchorMountVerifiedAt);
  assert.equal(runtime.continuationSupervisorDirective({
    conversationScopeId: "v1/test-conversation-lifetime-singleton",
    workspaceId: "ws_lifetime_c",
  }), undefined, "after the fresh later-manual card ACK, liveness maintenance must become headless again");

  const headlessAuto = runtime.continuationTask({
    action: "begin-auto",
    conversationScopeId: "v1/test-headless-refine",
    workspaceId: "ws_headless_refine",
  });
  const headlessRefined = runtime.continuationTask({
    action: "begin",
    taskId: headlessAuto.task.id,
    conversationScopeId: "v1/test-headless-refine",
    workspaceId: "ws_headless_refine",
    objective: "headless model refinement",
    requiredMilestones: ["verify visible anchor"],
    sourceTool: "continuation_task",
    anchorMounted: false,
  });
  assert.equal(headlessRefined.task.lastAnchorMountedAt, undefined,
    "headless continuation_task begin must not impersonate a mounted Workspace App card");
  assert.equal(runtime.continuationSupervisorDirective({
    conversationScopeId: "v1/test-headless-refine",
    workspaceId: "ws_headless_refine",
  })?.reason, "initial-anchor-required",
    "headless refinement must continue to require exactly one initial visible anchor");
  const visibleAnchor = runtime.continuationTask({
    action: "begin",
    taskId: headlessAuto.task.id,
    conversationScopeId: "v1/test-headless-refine",
    workspaceId: "ws_headless_refine",
    sourceTool: "continuation_anchor",
    anchorMounted: false,
  });
  assert.equal(visibleAnchor.task.anchorMountVerifiedAt, undefined,
    "calling the UI-bearing tool still must not mark the card mounted before its iframe initializes");
  const verifiedVisibleAnchor = verifyRuntimeAnchor(visibleAnchor, "v1/test-headless-refine", "ui_headless_visible_anchor");
  assert.ok(verifiedVisibleAnchor.task.lastAnchorMountedAt);
  assert.equal(runtime.continuationSupervisorDirective({
    conversationScopeId: "v1/test-headless-refine",
    workspaceId: "ws_headless_refine",
  }), undefined,
    "after the one visible anchor mounts, no later supervisor maintenance may request a duplicate card");

  const ghostAnchor = runtime.continuationTask({
    action: "begin",
    conversationScopeId: "v1/test-ghost-anchor",
    workspaceId: "ws_ghost_anchor",
    objective: "prove actual milestone iframe mount",
    requiredMilestones: ["prove mount"],
    sourceTool: "continuation_anchor",
    anchorMounted: true,
  });
  assert.equal(ghostAnchor.task.anchorMountVerifiedAt, undefined,
    "even legacy anchorMounted=true input must not let a model-side tool invocation impersonate a rendered iframe");
  assert.equal(ghostAnchor.task.lastAnchorMountedAt, undefined,
    "legacy lastAnchorMountedAt must remain empty until the verified iframe ACK");
  const ghostStatus = runtime.continuationTask({
    action: "status",
    taskId: ghostAnchor.task.id,
    conversationScopeId: "v1/test-ghost-anchor",
    coordinatorInstanceId: "ui_unrelated_review_status",
  });
  const ghostHeartbeat = runtime.continuationTask({
    action: "heartbeat",
    taskId: ghostAnchor.task.id,
    conversationScopeId: "v1/test-ghost-anchor",
    coordinatorInstanceId: "ui_unrelated_review_heartbeat",
  });
  for (const outcome of [ghostStatus, ghostHeartbeat]) {
    assert.equal(outcome.task.anchorMountVerifiedAt, undefined,
      "ordinary Workspace App status/heartbeat traffic must never create mount truth");
    assert.equal(outcome.task.lastAnchorMountedAt, undefined,
      "ordinary Workspace App liveness must not mutate the legacy visible-anchor diagnostic either");
  }
  const ghostEnsured = runtime.ensureContinuationTaskContract({
    conversationScopeId: "v1/test-ghost-anchor",
    workspaceId: "ws_ghost_anchor",
    sourceTool: "read",
    substantive: true,
  });
  assert.equal(ghostEnsured.initialAnchorRequired, true,
    "substantive work must remain fail-closed while only ghost UI liveness exists");
  runtime.continuationTask({
    action: "checkpoint",
    taskId: ghostAnchor.task.id,
    completedMilestones: ["prove mount"],
    evidence: { work: "done but card still absent" },
    progressFingerprint: "ghost-work-finished-before-card",
  });
  const prematureComplete = runtime.continuationTask({
    action: "complete",
    taskId: ghostAnchor.task.id,
    evidence: { work: "done but card still absent" },
  });
  assert.equal(prematureComplete.accepted, false);
  assert.equal(prematureComplete.reason, "continuation-anchor-required",
    "a canonical conversation may not complete before its one UI-bearing continuation anchor result is issued");
  const ghostMountRequest = runtime.prepareContinuationAnchorMount({
    taskId: ghostAnchor.task.id,
    conversationScopeId: "v1/test-ghost-anchor",
  });
  assert.ok(ghostMountRequest.anchorMountToken);
  assert.equal(ghostMountRequest.recoveryRetry, false,
    "the first UI-bearing issuance is not a recovery retry");
  assert.equal(ghostMountRequest.anchorMountProvisionalUntil, undefined,
    "a one-shot anchor must not advertise a future duplicate-issuance deadline");
  assert.equal(ghostMountRequest.task.anchorMountVerifiedAt, undefined,
    "issuing the one-time token must not fabricate actual iframe mount telemetry");
  const ghostAfterIssuance = runtime.ensureContinuationTaskContract({
    conversationScopeId: "v1/test-ghost-anchor",
    workspaceId: "ws_ghost_anchor",
    sourceTool: "read",
    substantive: true,
  });
  assert.equal(ghostAfterIssuance.initialAnchorRequired, false,
    "an issued UI-bearing result must never authorize another card");
  assert.equal(ghostAfterIssuance.task.anchorMountRecoveryRequired, false,
    "an unverified issuance must not request a duplicate card");
  assert.equal(ghostAfterIssuance.anchorMountVerificationPending, true,
    "server wrappers must fail closed substantive work until the card ACKs");
  assert.equal(runtime.continuationSupervisorDirective({
    conversationScopeId: "v1/test-ghost-anchor",
    workspaceId: "ws_ghost_anchor",
  }), undefined,
    "an unverified issuance must suppress every duplicate immutable-card request");

  runtime.database.sqlite.prepare(
    "update continuation_tasks set anchor_mount_requested_at=? where id=?",
  ).run("2020-01-01T00:00:00.000Z", ghostAnchor.task.id);
  const ghostAfterStaleIssuance = runtime.ensureContinuationTaskContract({
    conversationScopeId: "v1/test-ghost-anchor",
    workspaceId: "ws_ghost_anchor",
    sourceTool: "read",
    substantive: false,
  });
  assert.equal(ghostAfterStaleIssuance.initialAnchorRequired, false,
    "an aged unverified issuance must never permit a second transcript card");
  assert.equal(ghostAfterStaleIssuance.task.anchorMountRecoveryRequired, false);
  assert.equal(ghostAfterStaleIssuance.anchorMountVerificationPending, true,
    "stale unverified card state must remain a machine-readable fail-closed condition");
  const ghostStaleDirective = runtime.continuationSupervisorDirective({
    conversationScopeId: "v1/test-ghost-anchor",
    workspaceId: "ws_ghost_anchor",
  });
  assert.equal(ghostStaleDirective, undefined,
    "stale unverified issuance must not request another UI-bearing anchor");
  const ghostRecoveryRequest = runtime.prepareContinuationAnchorMount({
    taskId: ghostAnchor.task.id,
    conversationScopeId: "v1/test-ghost-anchor",
  });
  assert.equal(ghostRecoveryRequest.accepted, false);
  assert.equal(ghostRecoveryRequest.reason, "anchor-mount-verification-pending");
  assert.equal(ghostRecoveryRequest.anchorMountToken, undefined,
    "a repeated call must not disclose or rotate another mount capability");
  assert.equal(ghostRecoveryRequest.task.anchorMountRequestedAt, "2020-01-01T00:00:00.000Z",
    "a repeated call must not rewrite the immutable issuance timestamp");
  const ghostAfterRecoveryIssuance = runtime.ensureContinuationTaskContract({
    conversationScopeId: "v1/test-ghost-anchor",
    workspaceId: "ws_ghost_anchor",
    sourceTool: "read",
    substantive: false,
  });
  assert.equal(ghostAfterRecoveryIssuance.initialAnchorRequired, false,
    "the original issuance must remain the only anchor generation");
  assert.equal(ghostAfterRecoveryIssuance.anchorMountVerificationPending, true);
  assert.equal(runtime.continuationSupervisorDirective({
    conversationScopeId: "v1/test-ghost-anchor",
    workspaceId: "ws_ghost_anchor",
  }), undefined,
    "verification-pending state must remain headless without requesting another card");

  const wrongGhostAck = runtime.continuationTask({
    action: "anchor-mounted",
    taskId: ghostAnchor.task.id,
    conversationScopeId: "v1/test-ghost-anchor",
    coordinatorInstanceId: "ui_real_anchor",
    anchorMountToken: "00000000-0000-4000-8000-000000000001",
  });
  assert.equal(wrongGhostAck.accepted, false);
  assert.equal(wrongGhostAck.reason, "anchor-mount-token-mismatch");
  const correctGhostAck = runtime.continuationTask({
    action: "anchor-mounted",
    taskId: ghostAnchor.task.id,
    conversationScopeId: "v1/test-ghost-anchor",
    coordinatorInstanceId: "ui_real_anchor",
    anchorMountToken: ghostMountRequest.anchorMountToken,
  });
  assert.equal(correctGhostAck.accepted, true);
  assert.ok(correctGhostAck.task.anchorMountVerifiedAt);
  assert.equal(correctGhostAck.task.anchorMountCoordinatorId, "ui_real_anchor");
  assert.equal(correctGhostAck.task.anchorMountRecoveryRequired, false,
    "a token-authenticated iframe ACK must permanently clear verification-pending state");
  const verifiedAt = correctGhostAck.task.anchorMountVerifiedAt;
  const ghostAfterOtherApp = runtime.continuationTask({ action: "status", taskId: ghostAnchor.task.id });
  assert.equal(ghostAfterOtherApp.task.anchorMountVerifiedAt, verifiedAt);
  assert.equal(ghostAfterOtherApp.task.anchorMountCoordinatorId, "ui_real_anchor",
    "a later review/patch iframe must not steal ownership from the one verified milestone card");
  runtime.database.sqlite.prepare(
    "update continuation_tasks set anchor_mount_requested_at=? where id=?",
  ).run("2020-01-01T00:00:00.000Z", ghostAnchor.task.id);
  const verifiedStillHeadless = runtime.ensureContinuationTaskContract({
    conversationScopeId: "v1/test-ghost-anchor",
    workspaceId: "ws_ghost_anchor",
    sourceTool: "read",
    substantive: false,
  });
  assert.equal(verifiedStillHeadless.initialAnchorRequired, false,
    "verified mount truth must permanently suppress duplicate conversation cards regardless of later turn identity");
  assert.equal(runtime.continuationSupervisorDirective({
    conversationScopeId: "v1/test-ghost-anchor",
    workspaceId: "ws_ghost_anchor",
  }), undefined,
    "a verified conversation card must not duplicate because of age, reconnect, or missing turn metadata");
  const noThirdAnchor = runtime.prepareContinuationAnchorMount({
    taskId: ghostAnchor.task.id,
    conversationScopeId: "v1/test-ghost-anchor",
  });
  assert.equal(noThirdAnchor.alreadyVerified, true,
    "continuation_anchor remains idempotent forever after verified conversation-card truth");
  assert.equal(noThirdAnchor.anchorMountToken, undefined,
    "a verified conversation card must never mint another mount token");
  const ghostCompleted = runtime.continuationTask({
    action: "complete",
    taskId: ghostAnchor.task.id,
    evidence: { work: "done", anchor: "token-authenticated" },
  });
  assert.equal(ghostCompleted.task.state, "SUCCEEDED",
    "verified mount truth plus milestone evidence must allow canonical completion");

  const unmountedCompletion = runtime.continuationTask({
    action: "begin",
    conversationScopeId: "v1/test-unmounted-completion",
    workspaceId: "ws_unmounted_completion",
    objective: "finish business work independently of UI health",
    requiredMilestones: ["business work complete"],
    sourceTool: "continuation_anchor",
    anchorMounted: false,
  });
  runtime.continuationTask({
    action: "checkpoint",
    taskId: unmountedCompletion.task.id,
    completedMilestones: ["business work complete"],
    evidence: { work: "verified while card mount remained pending" },
  });
  const unmountedIssuance = runtime.prepareContinuationAnchorMount({
    taskId: unmountedCompletion.task.id,
    conversationScopeId: "v1/test-unmounted-completion",
  });
  assert.ok(unmountedIssuance.anchorMountToken);
  const completedWithoutMountAck = runtime.continuationTask({
    action: "complete",
    taskId: unmountedCompletion.task.id,
    evidence: { work: "verified while card mount remained pending" },
  });
  assert.equal(completedWithoutMountAck.accepted, true,
    "verified business completion must not be blocked by an independent iframe mount failure");
  assert.equal(completedWithoutMountAck.task.state, "SUCCEEDED");
  assert.equal(completedWithoutMountAck.task.anchorMountVerifiedAt, undefined,
    "terminal business state must preserve the missing-mount UI incident for diagnostics");

  const turnGhostAnchor = runtime.continuationTask({
    action: "begin",
    conversationScopeId: "v1/test-turn-aware-ghost-anchor",
    workspaceId: "ws_turn_aware_ghost",
    objective: "recover only a genuinely stale unverified conversation card",
    requiredMilestones: ["verify conversation-lifetime single-card recovery"],
    sourceTool: "continuation_anchor",
    anchorMounted: false,
  });
  const turnAFirstIssuance = runtime.prepareContinuationAnchorMount({
    taskId: turnGhostAnchor.task.id,
    conversationScopeId: "v1/test-turn-aware-ghost-anchor",
    hostTurnFingerprint: "host-turn-a-hash",
  });
  assert.equal(turnAFirstIssuance.recoveryRetry, false);
  assert.equal(turnAFirstIssuance.anchorMountGeneration, 1,
    "the first visible issuance must start at generation one");
  assert.ok(turnAFirstIssuance.anchorMountToken);
  const turnASameTurnRepeat = runtime.prepareContinuationAnchorMount({
    taskId: turnGhostAnchor.task.id,
    conversationScopeId: "v1/test-turn-aware-ghost-anchor",
    hostTurnFingerprint: "host-turn-a-hash",
  });
  assert.equal(turnASameTurnRepeat.accepted, false,
    "repeated initial issuance calls must be rejected so the Host cannot create a second UI-bearing transcript node");
  assert.equal(turnASameTurnRepeat.reason, "anchor-mount-verification-pending");
  assert.equal(turnASameTurnRepeat.alreadyRequested, true);
  assert.equal(turnASameTurnRepeat.anchorMountGeneration, 1);
  assert.equal(turnASameTurnRepeat.anchorMountToken, undefined,
    "a repeated call must never disclose a mount capability that could render another card");
  const turnAWork = runtime.ensureContinuationTaskContract({
    conversationScopeId: "v1/test-turn-aware-ghost-anchor",
    workspaceId: "ws_turn_aware_ghost",
    sourceTool: "read",
    substantive: false,
    hostTurnFingerprint: "host-turn-a-hash",
  });
  assert.equal(turnAWork.initialAnchorRequired, false,
    "an already-issued anchor must never authorize another UI-bearing result");
  assert.equal(turnAWork.anchorMountVerificationPending, true,
    "substantive work must remain fail-closed until the one permitted card ACKs");
  assert.equal(runtime.continuationSupervisorDirective({
    conversationScopeId: "v1/test-turn-aware-ghost-anchor",
    workspaceId: "ws_turn_aware_ghost",
    hostTurnFingerprint: "host-turn-a-hash",
  }), undefined,
    "a fresh unverified issuance must not immediately request a second immutable card");

  const turnBWork = runtime.ensureContinuationTaskContract({
    conversationScopeId: "v1/test-turn-aware-ghost-anchor",
    workspaceId: "ws_turn_aware_ghost",
    sourceTool: "read",
    substantive: false,
    hostTurnFingerprint: "host-turn-b-hash",
  });
  assert.equal(turnBWork.initialAnchorRequired, false,
    "a different assistant-turn fingerprint must not rotate a fresh unverified conversation card");
  assert.equal(turnBWork.task.anchorMountRecoveryRequired, false);
  assert.equal(turnBWork.anchorMountVerificationPending, true);
  assert.equal(runtime.continuationSupervisorDirective({
    conversationScopeId: "v1/test-turn-aware-ghost-anchor",
    workspaceId: "ws_turn_aware_ghost",
    hostTurnFingerprint: "host-turn-b-hash",
  }), undefined,
    "turn identity alone must never request another visible milestone card");
  const turnBFreshRepeat = runtime.prepareContinuationAnchorMount({
    taskId: turnGhostAnchor.task.id,
    conversationScopeId: "v1/test-turn-aware-ghost-anchor",
    hostTurnFingerprint: "host-turn-b-hash",
  });
  assert.equal(turnBFreshRepeat.accepted, false);
  assert.equal(turnBFreshRepeat.reason, "anchor-mount-verification-pending");
  assert.equal(turnBFreshRepeat.alreadyRequested, true);
  assert.equal(turnBFreshRepeat.anchorMountGeneration, 1);
  assert.equal(turnBFreshRepeat.anchorMountToken, undefined,
    "a later turn must not receive another UI mount capability");

  runtime.database.sqlite.prepare(
    "update continuation_tasks set anchor_mount_requested_at=? where id=?",
  ).run("2020-01-01T00:00:00.000Z", turnGhostAnchor.task.id);
  const staleGhostWork = runtime.ensureContinuationTaskContract({
    conversationScopeId: "v1/test-turn-aware-ghost-anchor",
    workspaceId: "ws_turn_aware_ghost",
    sourceTool: "read",
    substantive: false,
    hostTurnFingerprint: "host-turn-b-hash",
  });
  assert.equal(staleGhostWork.initialAnchorRequired, false,
    "even a very old unverified issuance must not permit a second transcript card");
  assert.equal(staleGhostWork.task.anchorMountRecoveryRequired, false);
  assert.equal(staleGhostWork.anchorMountVerificationPending, true);
  assert.equal(runtime.continuationSupervisorDirective({
    conversationScopeId: "v1/test-turn-aware-ghost-anchor",
    workspaceId: "ws_turn_aware_ghost",
    hostTurnFingerprint: "host-turn-b-hash",
  }), undefined,
    "an aged unverified issuance must stay fail-closed instead of requesting a duplicate card");
  const turnBRecovery = runtime.prepareContinuationAnchorMount({
    taskId: turnGhostAnchor.task.id,
    conversationScopeId: "v1/test-turn-aware-ghost-anchor",
    hostTurnFingerprint: "host-turn-b-hash",
  });
  assert.equal(turnBRecovery.accepted, false);
  assert.equal(turnBRecovery.reason, "anchor-mount-verification-pending");
  assert.equal(turnBRecovery.anchorMountGeneration, 1,
    "an unverified issuance must keep generation one permanently");
  assert.equal(turnBRecovery.anchorMountToken, undefined,
    "single-card enforcement must not disclose a second mount capability");
  const turnBSameTurnRepeat = runtime.prepareContinuationAnchorMount({
    taskId: turnGhostAnchor.task.id,
    conversationScopeId: "v1/test-turn-aware-ghost-anchor",
    hostTurnFingerprint: "host-turn-b-hash",
  });
  assert.equal(turnBSameTurnRepeat.accepted, false);
  assert.equal(turnBSameTurnRepeat.reason, "anchor-mount-verification-pending");
  assert.equal(turnBSameTurnRepeat.anchorMountGeneration, 1);
  assert.equal(turnBSameTurnRepeat.anchorMountToken, undefined);
  const turnBWorkAfterRecovery = runtime.ensureContinuationTaskContract({
    conversationScopeId: "v1/test-turn-aware-ghost-anchor",
    workspaceId: "ws_turn_aware_ghost",
    sourceTool: "read",
    substantive: false,
    hostTurnFingerprint: "host-turn-b-hash",
  });
  assert.equal(turnBWorkAfterRecovery.initialAnchorRequired, false);
  assert.equal(turnBWorkAfterRecovery.anchorMountVerificationPending, true,
    "the Task Contract must remain blocked until the original card verifies");
  const turnBVerified = runtime.continuationTask({
    action: "anchor-mounted",
    taskId: turnGhostAnchor.task.id,
    conversationScopeId: "v1/test-turn-aware-ghost-anchor",
    coordinatorInstanceId: "ui_generation_one",
    anchorMountToken: turnAFirstIssuance.anchorMountToken,
    anchorMountGeneration: 1,
  });
  assert.equal(turnBVerified.accepted, true);
  assert.ok(turnBVerified.task.anchorMountVerifiedAt);
  assert.equal(turnBVerified.task.anchorMountGeneration, 1);
  const persistedGenerationCapability = runtime.database.sqlite.prepare(
    "select anchor_mount_token, anchor_mount_generation from continuation_tasks where id=?",
  ).get(turnGhostAnchor.task.id);
  assert.equal(persistedGenerationCapability.anchor_mount_token, turnAFirstIssuance.anchorMountToken,
    "the verified immutable card must retain its generation capability so the same transcript card can rehydrate after refresh/restart");
  assert.equal(Number(persistedGenerationCapability.anchor_mount_generation), 1);
  const wrongRehydrateToken = runtime.continuationTask({
    action: "anchor-mounted",
    taskId: turnGhostAnchor.task.id,
    conversationScopeId: "v1/test-turn-aware-ghost-anchor",
    coordinatorInstanceId: "ui_generation_one_wrong_token",
    anchorMountToken: "00000000-0000-4000-8000-000000000001",
    anchorMountGeneration: 1,
  });
  assert.equal(wrongRehydrateToken.accepted, false);
  assert.equal(wrongRehydrateToken.reason, "anchor-mount-token-mismatch",
    "a new iframe cannot steal the immutable card with the right generation but wrong card capability");
  const staleRehydrateGeneration = runtime.continuationTask({
    action: "anchor-mounted",
    taskId: turnGhostAnchor.task.id,
    conversationScopeId: "v1/test-turn-aware-ghost-anchor",
    coordinatorInstanceId: "ui_generation_two_invalid",
    anchorMountToken: turnAFirstIssuance.anchorMountToken,
    anchorMountGeneration: 2,
  });
  assert.equal(staleRehydrateGeneration.accepted, false);
  assert.equal(staleRehydrateGeneration.reason, "stale-anchor-generation",
    "a non-authoritative card generation cannot regain supervisor ownership even with the current token");
  const turnBRehydrated = runtime.continuationTask({
    action: "anchor-mounted",
    taskId: turnGhostAnchor.task.id,
    conversationScopeId: "v1/test-turn-aware-ghost-anchor",
    coordinatorInstanceId: "ui_generation_one_rehydrated",
    anchorMountToken: turnAFirstIssuance.anchorMountToken,
    anchorMountGeneration: 1,
  });
  assert.equal(turnBRehydrated.accepted, true);
  assert.equal(turnBRehydrated.reason, "anchor-coordinator-rebound");
  assert.equal(turnBRehydrated.task.anchorMountGeneration, 1,
    "same-card iframe rehydration must never mint a second visible generation");
  assert.equal(turnBRehydrated.task.anchorMountCoordinatorId, "ui_generation_one_rehydrated");
  const oldCoordinatorSignal = runtime.continuationTask({
    action: "host-signal",
    taskId: turnGhostAnchor.task.id,
    conversationScopeId: "v1/test-turn-aware-ghost-anchor",
    coordinatorInstanceId: "ui_generation_one",
    hostProfileId: "chatgpt@rehydrate-test",
    hostSignal: "teardown",
    elapsedMs: 1_000,
  });
  assert.equal(oldCoordinatorSignal.accepted, false);
  assert.equal(oldCoordinatorSignal.reason, "stale-anchor-coordinator",
    "the previous iframe must become inert immediately after same-card coordinator rebind");
  const currentCoordinatorSignal = runtime.continuationTask({
    action: "host-signal",
    taskId: turnGhostAnchor.task.id,
    conversationScopeId: "v1/test-turn-aware-ghost-anchor",
    coordinatorInstanceId: "ui_generation_one_rehydrated",
    hostProfileId: "chatgpt@rehydrate-test",
    hostSignal: "connected",
    elapsedMs: 0,
  });
  assert.equal(currentCoordinatorSignal.accepted, true);
  assert.equal(currentCoordinatorSignal.task.lastHostSignal, "connected");
  const turnCAfterVerified = runtime.ensureContinuationTaskContract({
    conversationScopeId: "v1/test-turn-aware-ghost-anchor",
    workspaceId: "ws_turn_aware_ghost",
    sourceTool: "read",
    substantive: false,
    hostTurnFingerprint: "host-turn-c-hash",
  });
  assert.equal(turnCAfterVerified.initialAnchorRequired, false,
    "after verification, a later assistant turn must reuse the same conversation card instead of mounting a fresh one");
  assert.equal(runtime.continuationSupervisorDirective({
    conversationScopeId: "v1/test-turn-aware-ghost-anchor",
    workspaceId: "ws_turn_aware_ghost",
    hostTurnFingerprint: "host-turn-c-hash",
  }), undefined,
    "verified conversation-card truth must suppress later-turn reanchor directives");
  const turnCAfterVerifiedAnchorAttempt = runtime.prepareContinuationAnchorMount({
    taskId: turnGhostAnchor.task.id,
    conversationScopeId: "v1/test-turn-aware-ghost-anchor",
    hostTurnFingerprint: "host-turn-c-hash",
  });
  assert.equal(turnCAfterVerifiedAnchorAttempt.alreadyVerified, true,
    "even a direct later-turn anchor attempt must be idempotent after verified mount truth");
  assert.equal(turnCAfterVerifiedAnchorAttempt.anchorMountToken, undefined,
    "verified conversation cards must not mint later-turn mount capabilities");
  assert.equal(turnCAfterVerifiedAnchorAttempt.task.anchorMountGeneration, 1,
    "verified conversation cards must keep their generation stable across later turns");
  const turnCAfterServerRestartWithoutExplicitIdentity = runtime.ensureContinuationTaskContract({
    conversationScopeId: "v1/test-turn-aware-ghost-anchor",
    workspaceId: "ws_turn_aware_ghost",
    sourceTool: "read",
    substantive: false,
  });
  assert.equal(turnCAfterServerRestartWithoutExplicitIdentity.initialAnchorRequired, false,
    "a DevSpace service restart must not manufacture a second card after verified conversation-card truth");
  assert.equal(runtime.continuationSupervisorDirective({
    conversationScopeId: "v1/test-turn-aware-ghost-anchor",
    workspaceId: "ws_turn_aware_ghost",
  }), undefined,
    "the verified conversation card must remain authoritative after service restart");
  const staleGenerationClaim = runtime.continuationTask({
    action: "claim-continuation",
    taskId: turnGhostAnchor.task.id,
    conversationScopeId: "v1/test-turn-aware-ghost-anchor",
    coordinatorInstanceId: "ui_generation_one",
    note: "manual recovery",
  });
  assert.equal(staleGenerationClaim.accepted, false,
    "a superseded historical card must never retain automatic continuation authority");
  assert.equal(staleGenerationClaim.reason, "stale-anchor-coordinator");
  const currentGenerationClaim = runtime.continuationTask({
    action: "claim-continuation",
    taskId: turnGhostAnchor.task.id,
    conversationScopeId: "v1/test-turn-aware-ghost-anchor",
    coordinatorInstanceId: "ui_generation_one_rehydrated",
    note: "manual recovery",
  });
  assert.equal(currentGenerationClaim.accepted, true,
    "the currently verified milestone coordinator must retain continuation authority");
  runtime.continuationTask({
    action: "release-continuation",
    taskId: turnGhostAnchor.task.id,
    conversationScopeId: "v1/test-turn-aware-ghost-anchor",
  });
  const turnAwareRows = runtime.database.sqlite.prepare(
    "select count(*) as count from continuation_tasks where conversation_scope_id=?",
  ).get("v1/test-turn-aware-ghost-anchor");
  assert.equal(Number(turnAwareRows.count), 1,
    "all anchor attempts and later turns must remain inside one lifetime task instead of creating shadow tasks");

  const globalFirst = runtime.ensureContinuationTaskContract({
    conversationScopeId: "v1/test-global-first-card",
    sourceTool: "doctor",
    substantive: true,
  });
  assert.equal(globalFirst.created, true);
  assert.equal(globalFirst.task.workspaceId, undefined,
    "a conversation-level Task Contract must exist before any workspace is known");
  assert.equal(globalFirst.initialAnchorRequired, true,
    "a first global DevSpace call must be fail-closed behind the same one-card precondition");
  const globalVerified = verifyRuntimeAnchor(globalFirst, "v1/test-global-first-card", "ui_global_first_anchor");
  const globalBound = runtime.ensureContinuationTaskContract({
    conversationScopeId: "v1/test-global-first-card",
    workspaceId: "ws_global_bound_later",
    sourceTool: "open_workspace",
    substantive: false,
  });
  assert.equal(globalBound.task.id, globalVerified.task.id,
    "opening a workspace later must bind execution context onto the same conversation/card ledger");
  assert.equal(globalBound.task.workspaceId, "ws_global_bound_later");
  assert.equal(globalBound.initialAnchorRequired, false);

  const boundedCompatibility = runtime.continuationTask({
    action: "begin",
    conversationScopeId: "conversation-bounded-compatibility",
    workspaceId: "ws_bounded_compatibility",
    requiredMilestones: ["done"],
    maxContinuations: 2,
    wallClockMinutes: 60,
  });
  assert.equal(boundedCompatibility.task.maxContinuations, 2,
    "positive continuation budgets must remain available as an explicit compatibility override");
  assert.ok(boundedCompatibility.task.deadlineAt,
    "positive wall-clock budgets must remain available as an explicit compatibility override");

  // dev69 regression: a previous explicit wall-clock budget belongs to the
  // execution workset that requested it.  Once that workset expires, a new
  // manual plan on the same conversation-lifetime task must not inherit either
  // the stale deadline or verification evidence from the historical run.  The
  // terminal projection must also be archived so the replacement workset is
  // visible to the supervisor instead of producing RUNNING + scanned=0.
  const staleBudgetScope = "v1/test-new-workset-resets-stale-budget";
  const staleBudget = runtime.continuationTask({
    action: "begin",
    conversationScopeId: staleBudgetScope,
    workspaceId: "ws_stale_budget",
    objective: "historical bounded validation",
    requiredMilestones: ["old validation"],
    wallClockMinutes: 10,
    evidence: { verdict: "PASS", historicalRun: true },
  });
  const staleBudgetOldWorkset = runtime.continuationArchitectureSnapshot(staleBudgetScope).worksets.at(-1);
  assert.ok(staleBudgetOldWorkset?.id);
  runtime.database.sqlite.prepare("update continuation_tasks set deadline_at=? where id=?")
    .run(new Date(Date.now() - 60_000).toISOString(), staleBudget.task.id);
  const staleBudgetReplacement = runtime.continuationTask({
    action: "begin",
    taskId: staleBudget.task.id,
    conversationScopeId: staleBudgetScope,
    workspaceId: "ws_stale_budget",
    continuationMode: "timeout-recovery",
    objective: "fresh unbounded validation",
    requiredMilestones: ["fresh validation"],
  });
  assert.equal(staleBudgetReplacement.task.state, "RUNNING");
  assert.equal(staleBudgetReplacement.task.deadlineAt, undefined,
    "a replacement workset must recompute its budget instead of inheriting an expired deadline");
  assert.equal(staleBudgetReplacement.task.evidence?.verdict, undefined,
    "a replacement workset must not inherit PASS evidence from a historical validation run");
  const staleBudgetSnapshot = runtime.continuationArchitectureSnapshot(staleBudgetScope);
  const archivedStaleWorkset = staleBudgetSnapshot.worksets.find((row) => row.id === staleBudgetOldWorkset.id);
  const freshStaleWorkset = staleBudgetSnapshot.worksets.at(-1);
  assert.equal(archivedStaleWorkset?.state, "ARCHIVED",
    "wall-clock termination must archive the old workset instead of leaving a dead RUNNING projection");
  assert.notEqual(freshStaleWorkset?.id, staleBudgetOldWorkset.id,
    "reactivating new work must allocate a fresh workset");
  assert.equal(freshStaleWorkset?.state, "RUNNING");
  assert.ok(freshStaleWorkset?.continuation_due_at,
    "the fresh timeout-recovery workset must retain a supervisor scheduling cursor");
  const staleBudgetSweep = runtime.continuationSupervisorSweep({
    nowMs: Date.parse(freshStaleWorkset.continuation_due_at) + 1,
  });
  assert.ok(staleBudgetSweep.scanned > 0,
    "the recovered fresh workset must be visible to the supervisor instead of scanned=0");

  const b = runtime.continuationTask({
    action: "begin-auto",
    conversationScopeId: "conversation-b",
    workspaceId: "ws_shared",
  });
  assert.notEqual(a.task.id, b.task.id, "two conversations sharing a workspace must not share continuation state");
  const wrongScopeLookup = runtime.continuationTask({
    action: "status",
    taskId: a.task.id,
    workspaceId: "ws_shared",
    conversationScopeId: "conversation-b",
  });
  assert.equal(wrongScopeLookup.task, undefined, "an exact taskId must not cross the ChatGPT conversation scope boundary");
  const exactScopeLookup = runtime.continuationTask({
    action: "status",
    taskId: a.task.id,
    workspaceId: "ws_shared",
    conversationScopeId: "v1/test-conversation-a",
  });
  assert.equal(exactScopeLookup.task?.id, a.task.id);

  const preRefinementRow = runtime.database.sqlite.prepare(`
    select auto_created, required_milestones_json, completed_milestones_json
    from continuation_tasks where id=?
  `).get(a.task.id);
  assert.equal(Number(preRefinementRow?.auto_created || 0), 1,
    `canonical card/anchor recovery must preserve auto_created until the first explicit model refinement: ${JSON.stringify(preRefinementRow)}`);
  assert.deepEqual(JSON.parse(preRefinementRow.required_milestones_json), [
    "Complete the original user-requested DevSpace work",
    "Run necessary verification and deliver completion evidence",
  ]);
  assert.deepEqual(JSON.parse(preRefinementRow.completed_milestones_json), []);

  const upgraded = runtime.continuationTask({
    action: "begin",
    taskId: a.task.id,
    conversationScopeId: "v1/test-conversation-a",
    workspaceId: "ws_shared",
    objective: "publish release",
    requiredMilestones: ["tests", "git", "release"],
  });
  assert.equal(upgraded.upgraded, true);
  assert.equal(upgraded.task.continuationMode, "completion-driven", "Task Contract refinement must preserve completion-driven mode by default");
  assert.deepEqual(upgraded.task.requiredMilestones, ["tests", "git", "release"]);
  assert.equal(upgraded.task.taskSource, "model-refined",
    "model refinement must replace generic automatic milestones on the same task rather than creating a shadow task");
  assert.equal(upgraded.task.deadlineAt, undefined, "model refinement must preserve the unlimited wall-clock default");
  assert.equal(upgraded.task.maxContinuations, 0, "model refinement must preserve unlimited continuations unless a positive compatibility budget is requested");
  const staleSupervisorStatus = runtime.continuationTask({ action: "status", taskId: a.task.id });
  assert.equal(Boolean(staleSupervisorStatus.reanchorRequired), false,
    "once the initial visible anchor has mounted, heartbeat aging must never request another immutable ChatGPT card");
  assert.equal(staleSupervisorStatus.continueRequired, true,
    "an unfinished completion-driven task must explicitly require real work after the model-side status ACK");
  assert.deepEqual(staleSupervisorStatus.nextRequiredMilestones, ["tests", "git", "release"]);
  const staleDirective = runtime.continuationSupervisorDirective({
    conversationScopeId: "v1/test-conversation-a",
    workspaceId: "ws_shared",
  });
  assert.equal(staleDirective, undefined,
    "a previously mounted task must keep all heartbeat/lease maintenance headless");
  const heartbeat = runtime.continuationTask({ action: "heartbeat", taskId: a.task.id, coordinatorInstanceId: "ui_test" });
  assert.equal(heartbeat.accepted, true);
  assert.ok(heartbeat.task.lastUiHeartbeatAt);
  assert.equal(heartbeat.task.coordinatorInstanceId, "ui_test");
  assert.equal(heartbeat.task.lastAnchorMountedAt, aVerifiedAnchor.task.lastAnchorMountedAt,
    "heartbeat may refresh liveness for the verified anchor coordinator but must never create a new mount timestamp");
  assert.equal(heartbeat.task.anchorMountVerifiedAt, aVerifiedAnchor.task.anchorMountVerifiedAt);
  const liveSupervisorStatus = runtime.continuationTask({ action: "status", taskId: a.task.id });
  assert.equal(Boolean(liveSupervisorStatus.reanchorRequired), false,
    "a fresh coordinator heartbeat must suppress redundant re-anchor requests");
  assert.equal(liveSupervisorStatus.continueRequired, true,
    "a live supervisor does not make an unfinished completion-driven task safe to end after a status-only response");
  assert.equal(runtime.continuationSupervisorDirective({
    conversationScopeId: "v1/test-conversation-a",
    workspaceId: "ws_shared",
  }), undefined, "a fresh supervisor heartbeat must suppress same-turn re-anchor maintenance");

  const completionLeaseRuntime = runtime.continuationTask({
    action: "begin",
    conversationScopeId: "v1/test-completion-lease-runtime",
    workspaceId: "ws_completion_lease_runtime",
    requiredMilestones: ["finish"],
  });
  assert.equal(completionLeaseRuntime.task.continuationMode, "completion-driven");
  assert.equal(completionLeaseRuntime.task.maxContinuations, 0);
  assert.equal(completionLeaseRuntime.task.deadlineAt, undefined);
  const completionLeaseMounted = verifyRuntimeAnchor(
    completionLeaseRuntime,
    "v1/test-completion-lease-runtime",
    "ui_stall_probe",
  );
  assert.equal(completionLeaseMounted.accepted, true);
  const prematureCompletionLeaseClaim = runtime.continuationTask({
    action: "claim-continuation",
    taskId: completionLeaseRuntime.task.id,
    note: "task contract stall corroborated",
  });
  assert.equal(prematureCompletionLeaseClaim.accepted, false,
    "corroborated-stall reason text must not be enough before persisted state is armed");
  assert.equal(prematureCompletionLeaseClaim.reason, "continuation-trigger-not-authorized");
  runtime.database.sqlite.prepare("update continuation_tasks set turn_lease_expires_at=? where id=?")
    .run(new Date(Date.now() - 1000).toISOString(), completionLeaseRuntime.task.id);
  const expiredCompletionLeaseClaim = runtime.continuationTask({
    action: "claim-continuation",
    taskId: completionLeaseRuntime.task.id,
    note: "task contract stall corroborated",
  });
  assert.equal(expiredCompletionLeaseClaim.accepted, false,
    "an expired activity lease alone must remain fail-closed during a long model think");
  const suspectedCompletionStall = runtime.continuationTask({
    action: "heartbeat",
    taskId: completionLeaseRuntime.task.id,
    coordinatorInstanceId: "ui_stall_probe",
  });
  assert.equal(suspectedCompletionStall.task.stallState, "SUSPECTED_STALL",
    "the first verified current-card probe after activity-lease expiry should persist SUSPECTED_STALL only");
  const suspectedClaim = runtime.continuationTask({
    action: "claim-continuation",
    taskId: completionLeaseRuntime.task.id,
    note: "task contract stall corroborated",
  });
  assert.equal(suspectedClaim.accepted, false,
    "SUSPECTED_STALL without a corroborating Host/lifecycle signal must not create another turn");
  runtime.continuationTask({
    action: "confirm-turn-limit",
    taskId: completionLeaseRuntime.task.id,
    elapsedMs: 30_000,
    note: "test-confirmed-cutoff",
  });
  runtime.database.sqlite.prepare("update continuation_tasks set turn_started_at=?, last_model_activity_at=?, turn_lease_expires_at=? where id=?")
    .run(new Date(Date.now() - 60_000).toISOString(), new Date(Date.now() - 40_000).toISOString(), new Date(Date.now() - 1000).toISOString(), completionLeaseRuntime.task.id);
  const armedCompletionStall = runtime.continuationTask({
    action: "heartbeat",
    taskId: completionLeaseRuntime.task.id,
    coordinatorInstanceId: "ui_stall_probe",
  });
  assert.equal(armedCompletionStall.task.stallState, "SUSPECTED_STALL",
    "confirmed Host cutoff + quiet window + surviving UI heartbeat must remain non-authorizing telemetry");
  const armedCompletionClaim = runtime.continuationTask({
    action: "claim-continuation",
    taskId: completionLeaseRuntime.task.id,
    note: "task contract stall corroborated",
  });
  assert.equal(armedCompletionClaim.accepted, false,
    "historical cutoff telemetry must not turn a suspected stall into a recoverable continuation");

  const completionTeardownRuntime = runtime.continuationTask({
    action: "begin",
    conversationScopeId: "conversation-completion-teardown-runtime",
    workspaceId: "ws_completion_teardown_runtime",
    requiredMilestones: ["finish"],
  });
  const atomicCompletionTeardown = runtime.continuationTask({
    action: "claim-continuation",
    taskId: completionTeardownRuntime.task.id,
    note: "task contract resource teardown",
  });
  assert.equal(atomicCompletionTeardown.accepted, false,
    "ordinary resource teardown must not authorize a completion-driven continuation");
  assert.equal(atomicCompletionTeardown.reason, "continuation-trigger-not-authorized");

  // dev55 live evidence showed the inverse of the old senderless concern:
  // model-owned turn-complete reached READY only after the handoff grace, by
  // which point the current Host sender had already disappeared. Pre-arm one
  // durable READY generation immediately after the exact turn-complete
  // signature while keeping the task itself COMPLETION_REQUESTED until the
  // normal 8-second promotion grace matures.
  const missingSenderTask = runtime.continuationTask({
    action: "begin",
    conversationScopeId: "v1/test-turn-complete-missing-sender",
    workspaceId: "ws_turn_complete_missing_sender",
    requiredMilestones: ["finish"],
  });
  const missingSenderAnchor = runtime.prepareContinuationAnchorMount({
    taskId: missingSenderTask.task.id,
    conversationScopeId: "v1/test-turn-complete-missing-sender",
  });
  const missingSenderMounted = runtime.continuationTask({
    action: "anchor-mounted",
    taskId: missingSenderTask.task.id,
    conversationScopeId: "v1/test-turn-complete-missing-sender",
    coordinatorInstanceId: "ui_turn_complete_missing_sender",
    anchorMountToken: missingSenderAnchor.anchorMountToken,
  });
  assert.equal(missingSenderMounted.accepted, true);
  runtime.touchContinuationModelActivity({
    workspaceId: "ws_turn_complete_missing_sender",
    conversationScopeId: "v1/test-turn-complete-missing-sender",
    substantive: true,
  });
  const missingSenderCompletion = runtime.continuationTask({
    action: "turn-complete",
    taskId: missingSenderTask.task.id,
    note: "model stage complete before Host App sender initializes",
  });
  assert.equal(missingSenderCompletion.accepted, true,
    "turn-complete must preserve the model's exact-turn completion signature even when the Host App sender has not initialized yet");
  assert.equal(missingSenderCompletion.task.assistantTurnState, "COMPLETION_REQUESTED");
  const missingSenderPrearm = runtime.continuationSupervisorSweep({
    nowMs: Date.parse(missingSenderCompletion.task.assistantTurnCompletionRequestedAt) + 1,
  });
  assert.equal(missingSenderPrearm.ready.some(item => item.conversationScopeId === "v1/test-turn-complete-missing-sender"), true,
    "explicit turn-complete must pre-arm READY immediately instead of waiting until the Host sender is likely gone");
  const missingSenderPromotionAt = Date.parse(missingSenderCompletion.task.assistantTurnCompletionRequestedAt) + 8_001;
  const missingSenderPromotion = runtime.promoteMatureAssistantCompletionIntent(
    missingSenderTask.task.id,
    missingSenderPromotionAt,
  );
  assert.equal(missingSenderPromotion.promoted, true,
    "a mature exact-turn ATCC signature must become durable even when the current App sender has not initialized yet");
  assert.equal(missingSenderPromotion.senderReadyAtPromotion, false,
    "sender availability is delivery telemetry at promotion time, not permission to discard the signed completion boundary");
  assert.equal(runtime.continuationTask({ action: "status", taskId: missingSenderTask.task.id }).task.assistantTurnState,
    "COMPLETED",
    "missing sender must preserve the signed completion as a completed turn while transport catches up");
  const missingSenderSweep = runtime.continuationSupervisorSweep({ nowMs: missingSenderPromotionAt + 1 });
  assert.equal(missingSenderSweep.ready.filter(item => item.conversationScopeId === "v1/test-turn-complete-missing-sender").length <= 1, true,
    "post-grace sweeps must preserve the already pre-armed singleton READY generation");
  const generationBeforeSenderBind = runtime.database.sqlite.prepare(`
    select generation,state from continuation_generations
    where workset_id=(
      select active_workset_id from continuation_conversation_cards
      where conversation_scope_id=?
    ) and owner_type='synthetic' and state='READY'
    order by generation asc limit 1
  `).get("v1/test-turn-complete-missing-sender");
  assert.ok(generationBeforeSenderBind,
    "senderless pre-arm must leave one discoverable durable READY generation rather than a silent COMPLETION_REQUESTED task");
  const senderlessClaim = runtime.claimReadyContinuationGeneration({
    conversationScopeId: "v1/test-turn-complete-missing-sender",
    taskId: missingSenderTask.task.id,
    senderInstanceId: "ui_not_bound_yet",
    anchorMountToken: missingSenderAnchor.anchorMountToken,
    anchorMountGeneration: missingSenderAnchor.anchorMountGeneration,
  });
  assert.equal(senderlessClaim.accepted, false,
    "durable READY must remain non-deliverable until a current sender owns the exact issued card");
  assert.equal(runtime.database.sqlite.prepare(`
    select state from continuation_generations
    where workset_id=(select active_workset_id from continuation_conversation_cards where conversation_scope_id=?)
      and generation=? and owner_type='synthetic'
  `).get("v1/test-turn-complete-missing-sender", generationBeforeSenderBind.generation)?.state, "READY",
    "a rejected senderless claim must not consume or mutate the durable READY generation");
  const missingSenderBound = runtime.bindContinuationSender(withTestSenderProtocol({
    conversationScopeId: "v1/test-turn-complete-missing-sender",
    taskId: missingSenderTask.task.id,
    senderInstanceId: "ui_turn_complete_missing_sender",
    anchorMountGeneration: missingSenderAnchor.anchorMountGeneration,
  }));
  assert.equal(missingSenderBound.accepted, true,
    "the current App may recover by binding its sender without rotating the lifetime card");
  assert.equal(missingSenderBound.readyGeneration, generationBeforeSenderBind.generation,
    "late sender bind must discover and reuse the already-persisted READY generation instead of creating a shadow generation");
  const recoveredSenderPromotion = runtime.promoteMatureAssistantCompletionIntent(
    missingSenderTask.task.id,
    missingSenderPromotionAt + 1,
  );
  assert.equal(recoveredSenderPromotion.promoted, false,
    "late sender bind must not re-promote an already completed turn or mint a duplicate continuation boundary");
  assert.equal(recoveredSenderPromotion.reason, "completion-intent-not-pending");
  const recoveredSenderSweep = runtime.continuationSupervisorSweep({ nowMs: missingSenderPromotionAt + 2 });
  assert.equal(recoveredSenderSweep.ready.filter(item => item.conversationScopeId === "v1/test-turn-complete-missing-sender").length <= 1, true,
    "later supervisor sweeps must preserve a singleton runnable generation for the same signed turn completion");
  const readyCountAfterBind = runtime.database.sqlite.prepare(`
    select count(*) as count from continuation_generations
    where workset_id=(select active_workset_id from continuation_conversation_cards where conversation_scope_id=?)
      and owner_type='synthetic' and state='READY'
  `).get("v1/test-turn-complete-missing-sender")?.count ?? 0;
  assert.equal(readyCountAfterBind, 1,
    "late sender recovery must keep exactly one READY generation before delivery claim");

  const verifiedSurfaceTeardownTask = runtime.continuationTask({
    action: "begin",
    conversationScopeId: "v1/test-verified-surface-teardown",
    workspaceId: "ws_verified_surface_teardown",
    requiredMilestones: ["finish"],
  });
  const verifiedSurfaceMounted = verifyRuntimeAnchor(
    verifiedSurfaceTeardownTask,
    "v1/test-verified-surface-teardown",
    "ui_verified_surface_teardown",
  );
  assert.equal(verifiedSurfaceMounted.accepted, true);
  const firstVerifiedTeardown = runtime.continuationTask({
    action: "host-signal",
    taskId: verifiedSurfaceTeardownTask.task.id,
    coordinatorInstanceId: "ui_verified_surface_teardown",
    hostProfileId: "chatgpt@verified-surface-teardown",
    hostSignal: "teardown",
    elapsedMs: 1_000,
  });
  assert.equal(firstVerifiedTeardown.accepted, true);
  assert.equal(firstVerifiedTeardown.task.assistantTurnState, "GENERATING",
    "verified generic teardown alone must not complete an active assistant turn");
  const tooEarlyVerifiedTeardownClaim = runtime.continuationTask({
    action: "claim-continuation",
    taskId: verifiedSurfaceTeardownTask.task.id,
    coordinatorInstanceId: "ui_verified_surface_teardown",
    note: "verified surface teardown",
  });
  assert.equal(tooEarlyVerifiedTeardownClaim.accepted, false,
    "generic verified-card teardown must remain non-authorizing without a model completion intent");
  assert.equal(tooEarlyVerifiedTeardownClaim.reason, "continuation-trigger-not-authorized");
  runtime.touchContinuationModelActivity({
    workspaceId: "ws_verified_surface_teardown",
    conversationScopeId: "v1/test-verified-surface-teardown",
    substantive: true,
  });
  const completionRequested = runtime.continuationTask({
    action: "turn-complete",
    taskId: verifiedSurfaceTeardownTask.task.id,
    note: "verified normal assistant stage complete",
  });
  assert.equal(completionRequested.accepted, true);
  assert.equal(completionRequested.task.assistantTurnState, "COMPLETION_REQUESTED");
  const secondVerifiedTeardown = runtime.continuationTask({
    action: "host-signal",
    taskId: verifiedSurfaceTeardownTask.task.id,
    coordinatorInstanceId: "ui_verified_surface_teardown",
    hostProfileId: "chatgpt@verified-surface-teardown",
    hostSignal: "teardown",
    elapsedMs: 2_000,
  });
  assert.equal(secondVerifiedTeardown.accepted, true);
  assert.equal(secondVerifiedTeardown.task.assistantTurnState, "COMPLETED");
  assert.equal(secondVerifiedTeardown.task.assistantTurnCompletionLeaseId, secondVerifiedTeardown.task.turnLeaseId);
  const { claim: verifiedTeardownClaim } = claimModernReadyGeneration(
    verifiedSurfaceTeardownTask,
    "v1/test-verified-surface-teardown",
    "ui_verified_surface_teardown",
  );
  assert.equal(verifiedTeardownClaim.accepted, true,
    "an unfinished verified current card may expose a modern READY generation only after same-turn model completion intent plus Host teardown");

  runtime.continuationTask({
    action: "host-signal",
    taskId: a.task.id,
    coordinatorInstanceId: "ui_test",
    hostProfileId: "chatgpt@test",
    hostSignal: "connected",
    elapsedMs: 0,
  });
  const confirmedLimit = runtime.continuationTask({
    action: "confirm-turn-limit",
    taskId: a.task.id,
    elapsedMs: 1_000_000,
    note: "owner-observed-telemetry-seed",
  });
  assert.equal(confirmedLimit.accepted, true);
  assert.equal(confirmedLimit.reason, "confirmed-turn-limit-recorded");
  assert.equal(confirmedLimit.task.confirmedTurnLimitMs, 1_000_000);
  assert.equal(confirmedLimit.task.confirmedTurnLimitSource, "owner-observed-telemetry-seed");
  const observedCutoff = runtime.continuationTask({
    action: "confirm-turn-limit", taskId: a.task.id,
    elapsedMs: 1_003_000, note: "owner-second-observed-cutoff",
  });
  assert.deepEqual(observedCutoff.task.cutoffSamples.slice(-2), [1_000_000, 1_003_000],
    "independent same-regime confirmations must retain earlier observations");
  const repeatedCutoff = runtime.continuationTask({
    action: "confirm-turn-limit", taskId: a.task.id,
    elapsedMs: 1_003_000, note: "owner-second-observed-cutoff",
  });
  assert.deepEqual(repeatedCutoff.task.cutoffSamples, observedCutoff.task.cutoffSamples,
    "retrying a confirmation must not inflate the observation count");
  const cutoffProfile = runtime.database.sqlite.prepare("select cutoff_samples_json from continuation_host_profiles where id=?").get("chatgpt@test");
  assert.deepEqual(JSON.parse(cutoffProfile.cutoff_samples_json), repeatedCutoff.task.cutoffSamples,
    "task and host-profile observations must remain consistent");
  const confirmedGateEarly = runtime.continuationTask({
    action: "begin",
    conversationScopeId: "conversation-confirmed-gate-early",
    workspaceId: "ws_confirmed_gate_early",
    requiredMilestones: ["done"],
    maxContinuations: 2,
  });
  runtime.continuationTask({
    action: "host-signal",
    taskId: confirmedGateEarly.task.id,
    hostProfileId: "chatgpt@confirmed-early",
    hostSignal: "connected",
    elapsedMs: 0,
  });
  runtime.continuationTask({ action: "confirm-turn-limit", taskId: confirmedGateEarly.task.id, elapsedMs: 30_000, note: "owner-confirmed" });
  runtime.database.sqlite.prepare("update continuation_tasks set turn_started_at=? where id=?")
    .run(new Date(Date.now() - 10_000).toISOString(), confirmedGateEarly.task.id);
  runtime.continuationTask({
    action: "host-signal",
    taskId: confirmedGateEarly.task.id,
    hostProfileId: "chatgpt@confirmed-early",
    hostSignal: "teardown",
    elapsedMs: 10_000,
  });
  const confirmedEarlyClaim = runtime.continuationTask({
    action: "claim-continuation",
    taskId: confirmedGateEarly.task.id,
    note: "confirmed turn-limit teardown",
  });
  assert.equal(confirmedEarlyClaim.accepted, false,
    "a teardown before the confirmed limit plus safety grace must fail closed even if its reason text is forged");
  assert.equal(confirmedEarlyClaim.reason, "continuation-trigger-not-authorized");

  const confirmedGateElapsed = runtime.continuationTask({
    action: "begin",
    conversationScopeId: "conversation-confirmed-gate-elapsed",
    workspaceId: "ws_confirmed_gate_elapsed",
    requiredMilestones: ["done"],
    maxContinuations: 2,
  });
  runtime.continuationTask({
    action: "host-signal",
    taskId: confirmedGateElapsed.task.id,
    hostProfileId: "chatgpt@confirmed-elapsed",
    hostSignal: "connected",
    elapsedMs: 0,
  });
  runtime.continuationTask({ action: "confirm-turn-limit", taskId: confirmedGateElapsed.task.id, elapsedMs: 30_000, note: "owner-confirmed" });
  runtime.database.sqlite.prepare("update continuation_tasks set turn_started_at=? where id=?")
    .run(new Date(Date.now() - 40_000).toISOString(), confirmedGateElapsed.task.id);
  runtime.continuationTask({
    action: "host-signal",
    taskId: confirmedGateElapsed.task.id,
    hostProfileId: "chatgpt@confirmed-elapsed",
    hostSignal: "teardown",
    elapsedMs: 40_000,
  });
  const confirmedElapsedClaim = runtime.continuationTask({
    action: "claim-continuation",
    taskId: confirmedGateElapsed.task.id,
    note: "confirmed turn-limit teardown",
  });
  assert.equal(confirmedElapsedClaim.accepted, false,
    "legacy confirmed-limit reason text is no longer an authorization path; verified lifecycle teardown has its own explicit gate");

  const confirmedLeaseGate = runtime.continuationTask({
    action: "begin",
    conversationScopeId: "conversation-confirmed-lease",
    workspaceId: "ws_confirmed_lease",
    requiredMilestones: ["done"],
    maxContinuations: 2,
  });
  runtime.continuationTask({ action: "confirm-turn-limit", taskId: confirmedLeaseGate.task.id, elapsedMs: 30_000, note: "owner-confirmed" });
  runtime.database.sqlite.prepare("update continuation_tasks set turn_started_at=?, last_model_activity_at=? where id=?")
    .run(new Date(Date.now() - 10_000).toISOString(), new Date(Date.now() - 40_000).toISOString(), confirmedLeaseGate.task.id);
  const leaseEarlyClaim = runtime.continuationTask({
    action: "claim-continuation",
    taskId: confirmedLeaseGate.task.id,
    note: "confirmed turn-limit lease expired",
  });
  assert.equal(leaseEarlyClaim.accepted, false,
    "forging the lease-expiry reason before the confirmed cutoff must fail closed");
  assert.equal(leaseEarlyClaim.reason, "continuation-trigger-not-authorized");
  runtime.database.sqlite.prepare("update continuation_tasks set turn_started_at=?, last_model_activity_at=? where id=?")
    .run(new Date(Date.now() - 60_000).toISOString(), new Date(Date.now() - 40_000).toISOString(), confirmedLeaseGate.task.id);
  const leaseElapsedClaim = runtime.continuationTask({
    action: "claim-continuation",
    taskId: confirmedLeaseGate.task.id,
    note: "confirmed turn-limit lease expired",
  });
  assert.equal(leaseElapsedClaim.accepted, false,
    "no-host-signal recovery must remain fail-closed even after an old confirmed cutoff elapsed");

  // timeout-recovery must stay fail-closed for one historical cutoff sample,
  // but two independent, tightly clustered real cutoff observations are the
  // guarded fallback for Hosts that hard-stop the model without ever emitting
  // timeout/teardown to the Workspace App. This reproduces the dev67 live
  // failure: the downstream TIMED_OUT/READY machinery already supported
  // timeout-recovery, while inferLearnedHostCutoffTimeout accidentally allowed
  // only completion-driven tasks.
  const timeoutRecoverySingleSample = runtime.continuationTask({
    action: "begin",
    conversationScopeId: "v1/test-timeout-recovery-single-cutoff",
    workspaceId: "ws_timeout_recovery_single_cutoff",
    continuationMode: "timeout-recovery",
    requiredMilestones: ["done"],
    maxContinuations: 2,
  });
  runtime.continuationTask({
    action: "confirm-turn-limit",
    taskId: timeoutRecoverySingleSample.task.id,
    elapsedMs: 30_000,
    note: "owner-first-real-cutoff",
  });
  const singleSampleStartedAt = Date.now() - 40_000;
  runtime.database.sqlite.prepare("update continuation_tasks set turn_started_at=? where id=?")
    .run(new Date(singleSampleStartedAt).toISOString(), timeoutRecoverySingleSample.task.id);
  runtime.database.sqlite.prepare(`
    update continuation_worksets set continuation_due_at=?
    where legacy_task_id=? and state in ('RUNNING','SUSPECTED_STALL')
  `).run(new Date(singleSampleStartedAt + 1_000).toISOString(), timeoutRecoverySingleSample.task.id);
  const singleSampleSweep = runtime.continuationSupervisorSweep({ nowMs: Date.now() });
  assert.equal(singleSampleSweep.ready.some(
    (item) => item.conversationScopeId === "v1/test-timeout-recovery-single-cutoff",
  ), false,
  "timeout-recovery must not infer a Host cutoff from only one historical observation");
  assert.equal(runtime.continuationTask({
    action: "status", taskId: timeoutRecoverySingleSample.task.id,
  }).task.assistantTurnState, "GENERATING");

  const timeoutRecoveryClusteredCutoffs = runtime.continuationTask({
    action: "begin",
    conversationScopeId: "v1/test-timeout-recovery-clustered-cutoffs",
    workspaceId: "ws_timeout_recovery_clustered_cutoffs",
    continuationMode: "timeout-recovery",
    requiredMilestones: ["done"],
    maxContinuations: 2,
  });
  runtime.continuationTask({
    action: "confirm-turn-limit",
    taskId: timeoutRecoveryClusteredCutoffs.task.id,
    elapsedMs: 30_000,
    note: "owner-first-real-cutoff",
  });
  const clusteredSecond = runtime.continuationTask({
    action: "confirm-turn-limit",
    taskId: timeoutRecoveryClusteredCutoffs.task.id,
    elapsedMs: 30_500,
    note: "owner-second-real-cutoff",
  });
  assert.deepEqual(clusteredSecond.task.cutoffSamples.slice(-2), [30_000, 30_500]);
  const clusteredStartedAt = Date.now() - 40_000;
  runtime.database.sqlite.prepare("update continuation_tasks set turn_started_at=? where id=?")
    .run(new Date(clusteredStartedAt).toISOString(), timeoutRecoveryClusteredCutoffs.task.id);
  runtime.database.sqlite.prepare(`
    update continuation_worksets set continuation_due_at=?
    where legacy_task_id=? and state in ('RUNNING','SUSPECTED_STALL')
  `).run(new Date(clusteredStartedAt + 1_000).toISOString(), timeoutRecoveryClusteredCutoffs.task.id);
  const clusteredSweepAt = Date.now();
  const clusteredSweep = runtime.continuationSupervisorSweep({ nowMs: clusteredSweepAt });
  assert.equal(clusteredSweep.ready.some(
    (item) => item.conversationScopeId === "v1/test-timeout-recovery-clustered-cutoffs",
  ), false,
  "clustered history cannot establish that a currently silent model stopped");
  const clusteredRecovered = runtime.continuationTask({
    action: "status", taskId: timeoutRecoveryClusteredCutoffs.task.id,
  }).task;
  assert.equal(clusteredRecovered.assistantTurnState, "GENERATING");
  assert.equal(clusteredRecovered.assistantTurnCompletionSource, undefined);
  assert.equal(clusteredRecovered.assistantTurnCompletionLeaseId, undefined);
  const clusteredReady = runtime.database.sqlite.prepare(`
    select state,owner_type from continuation_generations
    where workset_id=(
      select active_workset_id from continuation_conversation_cards where conversation_scope_id=?
    ) order by generation desc limit 1
  `).get("v1/test-timeout-recovery-clustered-cutoffs");
  assert.equal(clusteredReady?.owner_type, "manual");
  assert.equal(clusteredReady?.state, "WORK_REQUIRED");
  const inferredTimeoutEvent = runtime.pollEvents({
    kind: "continuation-host-timeout-inferred",
    subject: "v1/test-timeout-recovery-clustered-cutoffs",
    limit: 20,
  });
  assert.equal(inferredTimeoutEvent.events.length, 0,
    "historical observations must not manufacture timeout evidence");

  const rejectedWatch = runtime.continuationTask({ action: "watch-process", taskId: a.task.id, processHandle: "build-1" });
  assert.equal(rejectedWatch.accepted, false,
    "ordinary milestone/timeout policies must not silently gain resident process-monitoring semantics");
  assert.equal(rejectedWatch.reason, "resident-mode-required");
  const resident = runtime.continuationTask({
    action: "begin",
    conversationScopeId: "v1/test-resident",
    workspaceId: "ws_resident",
    continuationMode: "resident",
    objective: "monitor training across stages",
    requiredMilestones: ["monitor until done"],
  });
  assert.equal(resident.task.continuationMode, "resident");
  verifyRuntimeAnchor(resident, "v1/test-resident", "ui_resident_anchor");
  const watched = runtime.continuationTask({ action: "watch-process", taskId: resident.task.id, processHandle: "training-1" });
  assert.equal(watched.accepted, true);
  assert.deepEqual(watched.task.watchProcessHandles, ["training-1"]);
  runtime.database.sqlite.prepare("update continuation_tasks set state='WAITING_EXTERNAL', last_ui_heartbeat_at=? where id=?")
    .run(new Date(Date.now() - 60_000).toISOString(), resident.task.id);
  const residentWaitDirective = runtime.continuationSupervisorDirective({
    conversationScopeId: "v1/test-resident",
    workspaceId: "ws_resident",
  });
  assert.equal(residentWaitDirective, undefined,
    "once the visible resident anchor exists, supervisor staleness must stay headless instead of creating a duplicate ChatGPT card");
  runtime.database.sqlite.prepare("update continuation_tasks set state='RUNNING', last_ui_heartbeat_at=null where id=?")
    .run(resident.task.id);
  runtime.touchContinuationModelActivity({ conversationScopeId: "v1/test-resident", substantive: true });
  const residentStage = runtime.continuationTask({ action: "stage-complete", taskId: resident.task.id, note: "epoch review complete" });
  assert.equal(residentStage.accepted, true);
  assert.equal(residentStage.reason, "assistant-turn-completion-requested");
  assert.equal(residentStage.task.assistantTurnState, "COMPLETION_REQUESTED");
  const ordinaryStage = runtime.continuationTask({ action: "stage-complete", taskId: a.task.id });
  assert.equal(ordinaryStage.accepted, true,
    "legacy stage-complete must share the ordinary model-owned turn-complete contract instead of being resident-only");
  assert.equal(ordinaryStage.reason, "assistant-turn-completion-requested");
  const learnedBudget = runtime.continuationTask({
    action: "host-signal",
    taskId: a.task.id,
    coordinatorInstanceId: "ui_test",
    hostProfileId: "chatgpt@test",
    hostSignal: "timeout",
    elapsedMs: 600000,
  });
  assert.equal(learnedBudget.accepted, true);
  assert.equal(learnedBudget.task.observedTurnBudgetMs, 600000);
  assert.equal(learnedBudget.task.recommendedContinueAfterMs, 528000);
  assert.equal(learnedBudget.task.hostTimeoutSamples, 1);
  assert.equal(learnedBudget.task.confirmedTurnLimitMs, 600000,
    "an authoritative materially shorter Host timeout must start a new cutoff regime instead of preserving a stale 25-minute lower bound");
  assert.ok(learnedBudget.task.cutoffEpoch >= 1,
    "a material downward Host cutoff change must advance the regime epoch");
  assert.equal(learnedBudget.task.confirmedTurnLimitSource, "host-timeout-regime-down");
  const learnedReuseTask = runtime.continuationTask({
    action: "begin-auto",
    conversationScopeId: "v1/test-budget-reuse",
    workspaceId: "ws_budget_reuse",
  });
  verifyRuntimeAnchor(learnedReuseTask, "v1/test-budget-reuse", "ui_reuse");
  const learnedReuse = runtime.continuationTask({
    action: "host-signal",
    taskId: learnedReuseTask.task.id,
    coordinatorInstanceId: "ui_reuse",
    hostProfileId: "chatgpt@test",
    hostSignal: "connected",
    elapsedMs: 0,
  });
  assert.equal(learnedReuse.task.observedTurnBudgetMs, 600000, "new tasks should reuse the learned host budget");
  assert.equal(learnedReuse.task.recommendedContinueAfterMs, 528000);
  assert.equal(learnedReuse.task.confirmedTurnLimitMs, 600000,
    "new tasks on the same Host profile should inherit the current adaptive cutoff regime");
  assert.equal(learnedReuse.task.cutoffEpoch, learnedBudget.task.cutoffEpoch);
  const shorterBudget = runtime.continuationTask({
    action: "host-signal",
    taskId: learnedReuseTask.task.id,
    coordinatorInstanceId: "ui_reuse",
    hostProfileId: "chatgpt@test",
    hostSignal: "timeout",
    elapsedMs: 300000,
  });
  assert.equal(shorterBudget.task.observedTurnBudgetMs, 330000, "a shorter host limit should be learned aggressively");
  assert.equal(shorterBudget.task.recommendedContinueAfterMs, 290400);
  assert.equal(shorterBudget.task.confirmedTurnLimitMs, 300000,
    "a second material downward change must remain learnable rather than being blocked by monotonic confirmedTurnLimit logic");
  assert.ok(shorterBudget.task.cutoffEpoch > learnedReuse.task.cutoffEpoch);
  const shorterEpoch = shorterBudget.task.cutoffEpoch;
  const duplicateShorterBudget = runtime.continuationTask({
    action: "host-signal", taskId: learnedReuseTask.task.id,
    coordinatorInstanceId: "ui_reuse", hostProfileId: "chatgpt@test",
    hostSignal: "timeout", elapsedMs: 600000,
  });
  assert.equal(duplicateShorterBudget.reason, "assistant-turn-timeout-already-confirmed");
  assert.equal(duplicateShorterBudget.task.hostTimeoutSamples, shorterBudget.task.hostTimeoutSamples,
    "repeated delivery for one turn must not become another calibration sample");
  // Independent actual turns supply the longer samples; retransmitting one
  // timeout must never count twice just to satisfy the upward-regime test.
  const longerTask1 = runtime.continuationTask({ action: "begin-auto",
    conversationScopeId: "v1/test-budget-longer-1", workspaceId: "ws_budget_longer_1" });
  verifyRuntimeAnchor(longerTask1, "v1/test-budget-longer-1", "ui_longer_1");
  const longerProbe1 = runtime.continuationTask({
    action: "host-signal",
    taskId: longerTask1.task.id,
    coordinatorInstanceId: "ui_longer_1",
    hostProfileId: "chatgpt@test",
    hostSignal: "timeout",
    elapsedMs: 600000,
  });
  assert.equal(longerProbe1.task.confirmedTurnLimitMs, 300000,
    "one longer timeout must not immediately double the adaptive Host budget on a single outlier");
  const longerTask2 = runtime.continuationTask({ action: "begin-auto",
    conversationScopeId: "v1/test-budget-longer-2", workspaceId: "ws_budget_longer_2" });
  verifyRuntimeAnchor(longerTask2, "v1/test-budget-longer-2", "ui_longer_2");
  const longerProbe2 = runtime.continuationTask({
    action: "host-signal",
    taskId: longerTask2.task.id,
    coordinatorInstanceId: "ui_longer_2",
    hostProfileId: "chatgpt@test",
    hostSignal: "timeout",
    elapsedMs: 600000,
  });
  assert.equal(longerProbe2.task.confirmedTurnLimitMs, 600000,
    "two consistent materially longer Host timeouts must promote the adaptive regime without a source-code change");
  assert.equal(longerProbe2.task.confirmedTurnLimitSource, "host-timeout-regime-up");
  assert.ok(longerProbe2.task.cutoffEpoch > shorterEpoch,
    "a confirmed upward Host-window regime change must advance the cutoff epoch");
  const delivery = runtime.continuationTask({
    action: "delivery-result",
    taskId: a.task.id,
    coordinatorInstanceId: "ui_test",
    deliveryResult: "accepted",
    deliveryMethod: "app.sendMessage",
    note: "unit",
  });
  assert.equal(delivery.task.lastSendResult.result, "accepted");

  const incomplete = runtime.continuationTask({
    action: "complete",
    taskId: a.task.id,
    completedMilestones: ["tests"],
    evidence: { tests: "pass" },
  });
  assert.equal(incomplete.accepted, false);
  assert.deepEqual(incomplete.missingMilestones, ["git", "release"]);

  runtime.continuationTask({ action: "checkpoint", taskId: a.task.id, completedMilestones: ["tests", "git", "release"], progressFingerprint: "release-published" });
  const noEvidence = runtime.continuationTask({ action: "complete", taskId: a.task.id });
  assert.equal(noEvidence.accepted, false);
  assert.equal(noEvidence.reason, "completion-evidence-required");
  const completed = runtime.continuationTask({ action: "complete", taskId: a.task.id, evidence: { release: "verified" } });
  assert.equal(completed.accepted, true);
  assert.equal(completed.task.state, "SUCCEEDED");
  assert.equal(runtime.continuationTask({ action: "claim-continuation", taskId: a.task.id }).accepted, false);

  const checkpointEvidenceTask = runtime.continuationTask({
    action: "begin",
    conversationScopeId: "conversation-checkpoint-evidence",
    workspaceId: "ws_checkpoint_evidence",
    requiredMilestones: ["verified"],
  });
  const checkpointEvidence = runtime.continuationTask({
    action: "checkpoint",
    taskId: checkpointEvidenceTask.task.id,
    requiredMilestones: ["follow-up task", "second follow-up"],
    evidence: { verification: "exit 0" },
    progressFingerprint: "verified",
  });
  assert.deepEqual(checkpointEvidence.task.evidence, { verification: "exit 0" },
    "checkpoint evidence must be durable across assistant turns");
  const checkpointMilestoneAppend = runtime.continuationTask({
    action: "checkpoint",
    taskId: checkpointEvidenceTask.task.id,
    requiredMilestones: ["follow-up task", "verified", "second follow-up"],
    progressFingerprint: "follow-up-milestones-added",
  });
  assert.deepEqual(checkpointMilestoneAppend.task.requiredMilestones,
    ["verified", "follow-up task", "second follow-up"],
    "checkpoint requiredMilestones must append new work to the existing conversation task in order without duplicates");
  const checkpointMilestoneIdempotent = runtime.continuationTask({
    action: "checkpoint",
    taskId: checkpointEvidenceTask.task.id,
    requiredMilestones: ["second follow-up", "follow-up task"],
    completedMilestones: ["verified", "follow-up task", "second follow-up"],
    progressFingerprint: "follow-up-milestones-complete",
  });
  assert.deepEqual(checkpointMilestoneIdempotent.task.requiredMilestones,
    ["verified", "follow-up task", "second follow-up"],
    "repeated milestone refinement must not duplicate milestones in the conversation task");
  assert.equal(checkpointMilestoneIdempotent.task.state, "SUCCEEDED",
    "a completion-driven checkpoint with durable evidence and no remaining milestones must seal the Task Contract instead of leaving stale RUNNING state");
  assert.equal(checkpointMilestoneIdempotent.taskIncomplete, false);
  assert.equal(checkpointMilestoneIdempotent.continueRequired, false);
  assert.equal(checkpointMilestoneIdempotent.finalResponseAllowed, true);
  assert.equal(runtime.continuationTask({ action: "claim-continuation", taskId: checkpointEvidenceTask.task.id }).accepted, false,
    "a checkpoint-sealed Task Contract must not mint another continuation generation");

  const timeoutRecoveryCheckpointTask = runtime.continuationTask({
    action: "begin",
    conversationScopeId: "conversation-timeout-recovery-checkpoint-evidence",
    workspaceId: "ws_timeout_recovery_checkpoint_evidence",
    continuationMode: "timeout-recovery",
    requiredMilestones: ["verified"],
  });
  const timeoutRecoveryCheckpoint = runtime.continuationTask({
    action: "checkpoint",
    taskId: timeoutRecoveryCheckpointTask.task.id,
    completedMilestones: ["verified"],
    evidence: { verification: "timeout-recovery exit 0" },
    progressFingerprint: "timeout-recovery-verified",
  });
  assert.equal(timeoutRecoveryCheckpoint.task.state, "SUCCEEDED",
    "a verified timeout-recovery checkpoint with 1/1 milestones complete must seal instead of remaining RUNNING");
  assert.equal(timeoutRecoveryCheckpoint.taskIncomplete, false);
  assert.equal(timeoutRecoveryCheckpoint.continueRequired, false);
  assert.equal(timeoutRecoveryCheckpoint.finalResponseAllowed, true);
  const timeoutRecoveryCheckpointArchitecture = runtime.continuationArchitectureSnapshot(
    "conversation-timeout-recovery-checkpoint-evidence",
  );
  assert.equal(timeoutRecoveryCheckpointArchitecture.card?.active_workset_id ?? null, null,
    "terminal checkpoint cleanup must clear the active workset pointer");
  assert.ok(timeoutRecoveryCheckpointArchitecture.worksets.every((workset) => workset.state !== "RUNNING"),
    "terminal checkpoint cleanup must not leave a RUNNING workset behind");
  assert.equal(runtime.continuationTask({
    action: "claim-continuation",
    taskId: timeoutRecoveryCheckpointTask.task.id,
  }).accepted, false,
  "a checkpoint-sealed timeout-recovery task must not mint another continuation generation");

  const noEvidenceCheckpointTask = runtime.continuationTask({
    action: "begin",
    conversationScopeId: "conversation-checkpoint-no-evidence",
    workspaceId: "ws_checkpoint_no_evidence",
    requiredMilestones: ["verified"],
  });
  const noEvidenceCheckpoint = runtime.continuationTask({
    action: "checkpoint",
    taskId: noEvidenceCheckpointTask.task.id,
    completedMilestones: ["verified"],
    progressFingerprint: "verified-without-evidence",
  });
  assert.equal(noEvidenceCheckpoint.task.state, "RUNNING",
    "checkpoint auto-seal must retain the existing completion evidence gate");

  const loop = runtime.continuationTask({
    action: "begin",
    conversationScopeId: "conversation-loop",
    workspaceId: "ws_loop",
    maxNoProgress: 2,
    maxSameFailure: 2,
  });
  runtime.continuationTask({ action: "checkpoint", taskId: loop.task.id, progressFingerprint: "same" });
  runtime.continuationTask({ action: "checkpoint", taskId: loop.task.id, progressFingerprint: "same" });
  const loopStopped = runtime.continuationTask({ action: "checkpoint", taskId: loop.task.id, progressFingerprint: "same" });
  assert.equal(loopStopped.task.state, "RUNNING",
    "completion-driven Task Contracts must not auto-terminate while required milestones remain");
  assert.match(loopStopped.task.waitingReason ?? "", /No-progress threshold reached/);
  assert.equal(loopStopped.taskIncomplete, true);
  assert.equal(loopStopped.finalResponseAllowed, false);

  const strictLoop = runtime.continuationTask({
    action: "begin",
    conversationScopeId: "conversation-strict-loop",
    workspaceId: "ws_strict_loop",
    continuationMode: "timeout-recovery",
    requiredMilestones: ["finish"],
    maxNoProgress: 2,
    maxSameFailure: 2,
  });
  runtime.continuationTask({ action: "checkpoint", taskId: strictLoop.task.id, progressFingerprint: "same" });
  runtime.continuationTask({ action: "checkpoint", taskId: strictLoop.task.id, progressFingerprint: "same" });
  const strictLoopStopped = runtime.continuationTask({ action: "checkpoint", taskId: strictLoop.task.id, progressFingerprint: "same" });
  assert.equal(strictLoopStopped.task.state, "ABORTED_NO_PROGRESS",
    "strict timeout-recovery compatibility mode may retain the no-progress terminal governor");
  assert.equal(strictLoopStopped.task.terminalReason, "no-progress-limit");

  const locked = runtime.continuationTask({
    action: "begin",
    conversationScopeId: "conversation-owner-lock",
    workspaceId: "ws_owner_lock",
    requiredMilestones: ["owner releases lock"],
    maxNoProgress: 1,
    maxSameFailure: 1,
  });
  runtime.database.sqlite.prepare("update continuation_tasks set owner_locked=1, owner_locked_at=? where id=?")
    .run(new Date().toISOString(), locked.task.id);
  const lockedStatus = runtime.continuationTask({ action: "status", taskId: locked.task.id });
  assert.equal(lockedStatus.task.ownerLocked, true);
  assert.ok(lockedStatus.task.ownerLockedAt);
  const lockedCancel = runtime.continuationTask({ action: "cancel", taskId: locked.task.id });
  assert.equal(lockedCancel.accepted, false);
  assert.equal(lockedCancel.reason, "task-owner-locked");
  const lockedComplete = runtime.continuationTask({
    action: "complete",
    taskId: locked.task.id,
    completedMilestones: ["owner releases lock"],
    evidence: { test: "locked" },
  });
  assert.equal(lockedComplete.accepted, false);
  assert.equal(lockedComplete.reason, "task-owner-locked");
  runtime.continuationTask({ action: "checkpoint", taskId: locked.task.id, progressFingerprint: "locked-same" });
  const lockedNoProgress = runtime.continuationTask({ action: "checkpoint", taskId: locked.task.id, progressFingerprint: "locked-same" });
  assert.equal(lockedNoProgress.task.state, "RUNNING", "owner lock must prevent automatic no-progress termination");
  runtime.database.sqlite.prepare("update continuation_tasks set owner_locked=0, owner_locked_at=null where id=?").run(locked.task.id);
  const unlockedCancel = runtime.continuationTask({ action: "cancel", taskId: locked.task.id });
  assert.equal(unlockedCancel.accepted, true);
  assert.equal(unlockedCancel.task.state, "CANCELLED_BY_USER");

  const paused = runtime.continuationTask({
    action: "begin",
    conversationScopeId: "conversation-paused-owner",
    workspaceId: "ws_paused_owner",
    requiredMilestones: ["finish later"],
  });
  runtime.database.sqlite.prepare("update continuation_tasks set state='PAUSED_BY_USER', waiting_reason='Paused by Portable owner UI.', continuation_pending=0 where id=?")
    .run(paused.task.id);
  const pausedClaim = runtime.continuationTask({ action: "claim-continuation", taskId: paused.task.id });
  assert.equal(pausedClaim.accepted, false);
  assert.equal(pausedClaim.reason, "task-paused-by-user");
  const pausedWake = runtime.continuationTask({ action: "arm-wake", taskId: paused.task.id });
  assert.equal(pausedWake.accepted, false);
  assert.equal(pausedWake.reason, "task-paused-by-user");
  const pausedResume = runtime.continuationTask({ action: "resume", taskId: paused.task.id });
  assert.equal(pausedResume.accepted, false,
    "assistant/runtime resume must not override an owner pause; only the Portable owner UI may release it");
  const pausedCheckpoint = runtime.continuationTask({
    action: "checkpoint",
    taskId: paused.task.id,
    completedMilestones: ["finish later"],
    progressFingerprint: "progress-recorded-while-paused",
  });
  assert.equal(pausedCheckpoint.task.state, "PAUSED_BY_USER",
    "checkpoint bookkeeping may advance while paused but must not silently resume automation");

  const wait = runtime.continuationTask({
    action: "begin",
    conversationScopeId: "conversation-wait",
    workspaceId: "ws_wait",
    maxContinuations: 2,
  });
  runtime.continuationTask({ action: "wait", taskId: wait.task.id, note: "CI running" });
  assert.equal(runtime.continuationTask({ action: "claim-continuation", taskId: wait.task.id }).reason, "waiting-external");
  runtime.continuationTask({ action: "resume", taskId: wait.task.id });
  const firstClaim = runtime.continuationTask({ action: "claim-continuation", taskId: wait.task.id, note: "manual recovery" });
  assert.equal(firstClaim.accepted, true);
  assert.equal(runtime.continuationTask({ action: "claim-continuation", taskId: wait.task.id, note: "manual recovery" }).reason, "continuation-already-pending");
  runtime.continuationTask({ action: "release-continuation", taskId: wait.task.id });
  assert.equal(runtime.continuationTask({ action: "claim-continuation", taskId: wait.task.id, note: "manual recovery" }).reason, "continuation-cooldown");
  runtime.database.sqlite.prepare("update continuation_tasks set last_continuation_at=? where id=?").run(new Date(Date.now() - 180_000).toISOString(), wait.task.id);
  const secondClaim = runtime.continuationTask({ action: "claim-continuation", taskId: wait.task.id, note: "manual recovery" });
  assert.equal(secondClaim.accepted, true);
  runtime.continuationTask({ action: "release-continuation", taskId: wait.task.id });
  runtime.database.sqlite.prepare("update continuation_tasks set last_continuation_at=? where id=?").run(new Date(Date.now() - 180_000).toISOString(), wait.task.id);
  const exhausted = runtime.continuationTask({ action: "claim-continuation", taskId: wait.task.id, note: "manual recovery" });
  assert.equal(exhausted.accepted, false);
  assert.equal(exhausted.reason, "continuation-budget");
  assert.equal(exhausted.task.state, "BUDGET_EXHAUSTED");

  const supervisorGuard = runtime.continuationTask({
    action: "begin",
    conversationScopeId: "v1/test-supervisor-guard",
    workspaceId: "ws_supervisor_guard",
    continuationMode: "resident",
  });
  const supervisorGuardMounted = verifyRuntimeAnchor(
    supervisorGuard,
    "v1/test-supervisor-guard",
    "ui_guard",
  );
  assert.equal(supervisorGuardMounted.accepted, true);
  runtime.continuationTask({ action: "watch-process", taskId: supervisorGuard.task.id, processHandle: "guard-process" });
  const staleWait = runtime.continuationTask({ action: "wait", taskId: supervisorGuard.task.id, note: "must not wait without a live supervisor" });
  assert.equal(staleWait.accepted, true);
  assert.equal(staleWait.reason, "supervisor-ack-pending");
  assert.equal(staleWait.task.state, "WAITING_SUPERVISOR", "a watched wait must persist intent without pretending the supervisor already acknowledged it");
  const staleOwnerAttempt = runtime.continuationTask({
    action: "status",
    taskId: supervisorGuard.task.id,
    conversationScopeId: "v1/test-supervisor-guard",
    coordinatorInstanceId: "ui_stale_guard",
  });
  assert.equal(staleOwnerAttempt.task.state, "WAITING_SUPERVISOR",
    "an old/unverified card must not acknowledge another generation's supervisor wait");
  assert.equal(staleOwnerAttempt.task.coordinatorInstanceId, "ui_guard",
    "an old/unverified status poll must not steal coordinator ownership");
  const acknowledgedWait = runtime.continuationTask({
    action: "status",
    taskId: supervisorGuard.task.id,
    conversationScopeId: "v1/test-supervisor-guard",
    coordinatorInstanceId: "ui_guard",
  });
  assert.equal(acknowledgedWait.task.state, "WAITING_EXTERNAL", "the next coordinator status poll must atomically acknowledge the pending wait");
  assert.equal(acknowledgedWait.task.coordinatorInstanceId, "ui_guard");
  runtime.continuationTask({ action: "resume", taskId: supervisorGuard.task.id });
  const staleCheckpointWait = runtime.continuationTask({
    action: "checkpoint",
    taskId: supervisorGuard.task.id,
    waitingExternal: true,
    note: "checkpoint wait also requires a live supervisor",
  });
  assert.equal(staleCheckpointWait.accepted, true);
  assert.equal(staleCheckpointWait.reason, "supervisor-ack-pending");
  assert.equal(staleCheckpointWait.task.state, "WAITING_SUPERVISOR");
  const coordinatorTouch = runtime.continuationTask({
    action: "status",
    taskId: supervisorGuard.task.id,
    conversationScopeId: "v1/test-supervisor-guard",
    coordinatorInstanceId: "ui_guard",
  });
  assert.equal(coordinatorTouch.task.coordinatorInstanceId, "ui_guard");
  assert.ok(coordinatorTouch.task.lastUiHeartbeatAt, "coordinator status polling must count as supervisor liveness");
  assert.equal(coordinatorTouch.task.state, "WAITING_EXTERNAL");
  runtime.continuationTask({ action: "resume", taskId: supervisorGuard.task.id });

  const wake = runtime.continuationTask({
    action: "begin",
    conversationScopeId: "v1/test-persistent-wake",
    workspaceId: "ws_persistent_wake_state",
    continuationMode: "resident",
    maxContinuations: 3,
  });
  verifyRuntimeAnchor(wake, "v1/test-persistent-wake", "ui_persistent_wake_state");
  runtime.continuationTask({ action: "wait", taskId: wake.task.id, note: "external process running" });
  const armedWake = runtime.continuationTask({ action: "arm-wake", taskId: wake.task.id });
  assert.equal(armedWake.task.state, "RUNNING");
  assert.equal(armedWake.task.continuationPending, false);
  assert.equal(armedWake.task.continuationWakePending, true);
  const wakeSweep = runtime.continuationSupervisorSweep({ nowMs: Date.now() + 9_000 });
  assert.equal(wakeSweep.ready.some((item) => item.conversationScopeId === "v1/test-persistent-wake"), true,
    "a persisted resident wake with a verified current card must become a durable READY generation without using the legacy task-level sender protocol");
  const legacyWakeClaim = runtime.continuationTask({ action: "claim-continuation", taskId: wake.task.id });
  assert.equal(legacyWakeClaim.accepted, false,
    "modern resident READY generations must not be consumed through the legacy task-level claim path");
  assert.equal(legacyWakeClaim.reason, "generation-sender-required");

  const ackWake = runtime.continuationTask({
    action: "begin",
    conversationScopeId: "v1/test-delivery-ack",
    workspaceId: "ws_delivery_ack",
    continuationMode: "resident",
    requiredMilestones: ["finish after resumed turn"],
    maxContinuations: 4,
  });
  verifyRuntimeAnchor(ackWake, "v1/test-delivery-ack", "ui_delivery_ack_anchor");
  const ackWait = runtime.continuationTask({
    action: "wait",
    taskId: ackWake.task.id,
    note: "resident external process still running",
  });
  assert.equal(ackWait.accepted, true);
  const ackArmedWake = runtime.continuationTask({ action: "arm-wake", taskId: ackWake.task.id });
  assert.equal(ackArmedWake.accepted, true);
  const { claim: ackClaim, card: ackCard } = claimModernReadyGeneration(
    ackWake,
    "v1/test-delivery-ack",
    "ui_delivery_ack_anchor",
  );
  assert.match(ackClaim.deliveryToken, /^[0-9a-f-]{36}$/i,
    "every logical synthetic continuation must receive a durable delivery token");
  authorizeModernGeneration(ackWake, "v1/test-delivery-ack", "ui_delivery_ack_anchor", ackCard, ackClaim);
  const ackAwaiting = runtime.continuationTask({
    action: "status",
    taskId: ackWake.task.id,
    readOnlyStatus: true,
  });
  assert.equal(ackAwaiting.task.continuationDeliveryAwaitingAck, true);
  const modelAck = runtime.continuationTask({
    action: "status",
    taskId: ackWake.task.id,
    deliveryToken: ackClaim.deliveryToken,
  });
  assert.equal(modelAck.accepted, true);
  assert.equal(modelAck.reason, "continuation-resume-acknowledged");
  assert.equal(Boolean(modelAck.reanchorRequired), false,
    "a synthetic resumed turn must reuse the already-verified conversation card instead of mounting another one");
  const ackWakeResumedMount = runtime.prepareContinuationAnchorMount({
    taskId: ackWake.task.id,
    conversationScopeId: "v1/test-delivery-ack",
  });
  assert.equal(ackWakeResumedMount.alreadyVerified, true,
    "even a direct anchor attempt from the resumed turn must be idempotent after verified mount truth");
  assert.equal(ackWakeResumedMount.anchorMountToken, undefined);
  assert.equal(ackWakeResumedMount.task.anchorMountGeneration, 1,
    "synthetic resume must not rotate the conversation card generation");
  const ackWakeSameTurnStatus = runtime.continuationTask({
    action: "status",
    taskId: ackWake.task.id,
    deliveryToken: ackClaim.deliveryToken,
  });
  assert.equal(Boolean(ackWakeSameTurnStatus.reanchorRequired), false,
    "repeated synthetic status must remain headless while the lifetime conversation card is already verified");
  assert.equal(modelAck.continueRequired, true,
    "resume ACK must explicitly tell the model to continue tool work in the same assistant turn");
  assert.deepEqual(modelAck.nextRequiredMilestones, ["finish after resumed turn"]);
  assert.equal(modelAck.task.continuationPending, false);
  assert.equal(modelAck.task.continuationWakePending, false);
  assert.equal(modelAck.task.continuationDeliveryAwaitingAck, false);

  const proactiveAck = runtime.continuationTask({
    action: "begin",
    conversationScopeId: "v1/test-proactive-ack",
    workspaceId: "ws_proactive_ack",
    requiredMilestones: ["finish after timeout recovery"],
    maxContinuations: 4,
  });
  verifyRuntimeAnchor(proactiveAck, "v1/test-proactive-ack", "ui_proactive_ack_anchor");
  runtime.continuationTask({
    action: "host-signal",
    taskId: proactiveAck.task.id,
    coordinatorInstanceId: "ui_proactive_ack_anchor",
    hostProfileId: "proactive-timeout@test",
    hostSignal: "timeout",
    elapsedMs: 10_000,
  });
  const { claim: proactiveClaim, card: proactiveCard } = claimModernReadyGeneration(
    proactiveAck,
    "v1/test-proactive-ack",
    "ui_proactive_ack_anchor",
  );
  assert.match(proactiveClaim.deliveryToken, /^[0-9a-f-]{36}$/i);
  assert.ok(Number(proactiveClaim.generation) >= 1);
  authorizeModernGeneration(
    proactiveAck,
    "v1/test-proactive-ack",
    "ui_proactive_ack_anchor",
    proactiveCard,
    proactiveClaim,
  );
  const proactiveDelivered = runtime.recordContinuationGenerationDelivery({
    deliveryToken: proactiveClaim.deliveryToken,
    result: "accepted",
    method: "ui/message",
  });
  assert.equal(proactiveDelivered.accepted, true);
  assert.equal(proactiveDelivered.retryCount, 1);
  assert.ok(Date.parse(proactiveDelivered.retryAfterAt) > Date.now(),
    "first accepted synthetic turn must persist a future model-ACK health deadline");
  const proactiveDeliveredStatus = runtime.continuationTask({
    action: "status",
    taskId: proactiveAck.task.id,
    readOnlyStatus: true,
  }).task;
  assert.equal(proactiveDeliveredStatus.continuationDeliveryAwaitingAck, true,
    "timeout-triggered continuations must retain a delivery lease until the resumed model reconnects");
  assert.equal(proactiveDeliveredStatus.continuationWakePending, false,
    "timeout-triggered delivery ACK state must not masquerade as a resident process/stage wake");
  assert.equal(proactiveDeliveredStatus.deliveryAckRetryCount, 1);
  const proactiveRetryDueSweep = runtime.continuationSupervisorSweep({
    nowMs: Date.parse(proactiveDelivered.retryAfterAt) + 1,
  });
  assert.equal(proactiveRetryDueSweep.deliveryAckRetryDue.some(
    (item) => item.conversationScopeId === "v1/test-proactive-ack",
  ), true,
  "missing model ACK should become a health/wake signal without authorizing a duplicate visible Host message");
  assert.equal(proactiveRetryDueSweep.ready.some(
    (item) => item.conversationScopeId === "v1/test-proactive-ack",
  ), false,
  "an ACK-health deadline must not manufacture another READY generation while the original model may be alive");
  const proactiveDuplicateClaim = runtime.claimReadyContinuationGeneration({
    conversationScopeId: "v1/test-proactive-ack",
    taskId: proactiveAck.task.id,
    senderInstanceId: "ui_proactive_ack_anchor",
    anchorMountToken: proactiveCard.mount_token,
    anchorMountGeneration: Number(proactiveCard.mount_generation || 0),
  });
  assert.equal(proactiveDuplicateClaim.accepted, false);
  assert.equal(proactiveDuplicateClaim.reason, "delivery-in-flight-no-retransmit",
    "the modern sender must refuse visible retransmission of a Host-accepted generation that has not model-ACKed yet");

  const unackedRecovery = runtime.continuationTask({
    action: "begin",
    conversationScopeId: "v1/test-unacked-execution-recovery",
    workspaceId: "ws_unacked_execution_recovery",
    continuationMode: "resident",
    requiredMilestones: ["survive an unconfirmed synthetic execution"],
    maxContinuations: 4,
  });
  verifyRuntimeAnchor(unackedRecovery, "v1/test-unacked-execution-recovery", "ui_unacked_execution_recovery");
  runtime.touchContinuationModelActivity({
    workspaceId: "ws_unacked_execution_recovery",
    conversationScopeId: "v1/test-unacked-execution-recovery",
    substantive: true,
  });
  const unackedCompletion = runtime.continuationTask({
    action: "turn-complete",
    taskId: unackedRecovery.task.id,
    note: "fixture first stage complete before synthetic no-ACK reproduction",
  });
  assert.equal(unackedCompletion.accepted, true);
  const { claim: unackedClaim, card: unackedCard } = claimModernReadyGeneration(
    unackedRecovery,
    "v1/test-unacked-execution-recovery",
    "ui_unacked_execution_recovery",
  );
  authorizeModernGeneration(
    unackedRecovery,
    "v1/test-unacked-execution-recovery",
    "ui_unacked_execution_recovery",
    unackedCard,
    unackedClaim,
  );
  const unackedDelivered = runtime.recordContinuationGenerationDelivery({
    deliveryToken: unackedClaim.deliveryToken,
    result: "accepted",
    method: "ui/message",
    note: "fixture transport accepted but model intentionally never ACKs",
  });
  assert.equal(unackedDelivered.accepted, true);
  runtime.database.sqlite.prepare(`
    update continuation_tasks set
      cutoff_samples_json='[1552000,1555000]',
      confirmed_turn_limit_ms=1555000,
      confirmed_turn_limit_source='fixture-two-clustered-real-host-cutoffs'
    where id=?
  `).run(unackedRecovery.task.id);
  const unackedDeliveredAtMs = Date.parse(String(unackedDelivered.generation?.delivered_at || ""));
  assert.ok(Number.isFinite(unackedDeliveredAtMs));
  const shortUnackedSweep = runtime.continuationSupervisorSweep({
    nowMs: unackedDeliveredAtMs + 120_000,
  });
  assert.equal(shortUnackedSweep.ready.some(
    (item) => item.conversationScopeId === "v1/test-unacked-execution-recovery",
  ), false,
  "a short no-ACK timer must never create a replacement turn that could interrupt a slow-starting model");
  assert.equal(shortUnackedSweep.deliveryAckRetryDue.some(
    (item) => item.conversationScopeId === "v1/test-unacked-execution-recovery",
  ), true,
  "after the short ACK-health deadline the delivery must remain explicitly execution-unconfirmed rather than be treated as success");
  const cutoffSafeUnackedSweep = runtime.continuationSupervisorSweep({
    nowMs: unackedDeliveredAtMs + 1_600_000,
  });
  const recoveredUnacked = cutoffSafeUnackedSweep.recoveredUnackedExecution.find(
    (item) => item.conversationScopeId === "v1/test-unacked-execution-recovery",
  );
  assert.ok(recoveredUnacked,
    "two tightly clustered Host-cutoff samples must eventually recover a transport-accepted synthetic message that never produced the mandatory model ACK");
  assert.equal(recoveredUnacked.generation, unackedClaim.generation + 1,
    "safe no-ACK recovery must advance architecture generation instead of replaying the ambiguous old delivery token");
  const supersededUnackedGeneration = runtime.database.sqlite.prepare(`
    select state,failure_reason from continuation_generations where delivery_token=?
  `).get(unackedClaim.deliveryToken);
  assert.equal(supersededUnackedGeneration.state, "SUPERSEDED");
  assert.equal(supersededUnackedGeneration.failure_reason, "synthetic-execution-unconfirmed-cutoff");
  const lateUnackedAck = runtime.continuationTask({
    action: "status",
    taskId: unackedRecovery.task.id,
    deliveryToken: unackedClaim.deliveryToken,
  });
  assert.equal(lateUnackedAck.accepted, false);
  assert.equal(lateUnackedAck.reason, "synthetic-continuation-superseded");
  assert.equal(lateUnackedAck.staleSyntheticTurn, true);
  assert.equal(lateUnackedAck.suppressVisibleFinal, true,
    "a late first model turn must self-suppress after strict no-ACK recovery has advanced to a new generation");
  const recoveredUnackedCard = runtime.database.sqlite.prepare(`
    select mount_token,mount_generation,sender_instance_id
    from continuation_conversation_cards where conversation_scope_id=?
  `).get("v1/test-unacked-execution-recovery");
  const recoveredUnackedClaim = runtime.claimReadyContinuationGeneration({
    conversationScopeId: "v1/test-unacked-execution-recovery",
    taskId: unackedRecovery.task.id,
    senderInstanceId: "ui_unacked_execution_recovery",
    anchorMountToken: recoveredUnackedCard.mount_token,
    anchorMountGeneration: Number(recoveredUnackedCard.mount_generation || 0),
  });
  assert.equal(recoveredUnackedClaim.accepted, true,
    `the READY generation created by strict no-ACK recovery must remain claimable without manufacturing a second READY: ${JSON.stringify(recoveredUnackedClaim)}`);
  assert.notEqual(recoveredUnackedClaim.deliveryToken, unackedClaim.deliveryToken);
  assert.equal(recoveredUnackedClaim.generation, unackedClaim.generation + 1);
  runtime.continuationTask({ action: "cancel", taskId: unackedRecovery.task.id, note: "fixture complete" });

  const proactiveModelAck = runtime.continuationTask({
    action: "status",
    taskId: proactiveAck.task.id,
    deliveryToken: proactiveClaim.deliveryToken,
  });
  assert.equal(proactiveModelAck.reason, "continuation-resume-acknowledged");
  assert.equal(Boolean(proactiveModelAck.reanchorRequired), false,
    "an unfinished resumed Task Contract must reuse the verified conversation card without creating a second visible card");
  const proactiveResumedMount = runtime.prepareContinuationAnchorMount({
    taskId: proactiveAck.task.id,
    conversationScopeId: "v1/test-proactive-ack",
  });
  assert.equal(proactiveResumedMount.alreadyVerified, true);
  assert.equal(proactiveResumedMount.anchorMountToken, undefined);
  assert.equal(proactiveResumedMount.task.anchorMountGeneration, 1,
    "timeout recovery must not rotate the already-verified lifetime card");
  assert.equal(proactiveModelAck.continueRequired, true,
    "a resumed unfinished task must force real work after the connectivity ACK");
  assert.equal(proactiveModelAck.finalResponseAllowed, false);
  assert.deepEqual(proactiveModelAck.remainingMilestones, ["finish after timeout recovery"]);
  assert.equal(proactiveModelAck.task.continuationDeliveryAwaitingAck, false);
  assert.equal(proactiveModelAck.task.syntheticResumeWorkRequired, true,
    "a connectivity status ACK must retain a durable obligation to perform real DevSpace work");
  assert.equal(proactiveModelAck.task.deliveryOwner, "synthetic-active");
  assert.equal(proactiveModelAck.task.deliveryAckRetryCount, 0);
  assert.equal(proactiveModelAck.task.deliveryAckRetryAfterAt, undefined,
    "a successful model-side status ACK must clear the persisted readiness retry schedule");
  assert.ok(proactiveModelAck.task.turnStartedAt);
  assert.ok(proactiveModelAck.task.lastModelActivityAt);

  const controlOnlyCountBefore = proactiveModelAck.task.substantiveActivityCount;
  const controlOnlyTouch = runtime.touchContinuationModelActivity({
    workspaceId: "ws_proactive_ack",
    conversationScopeId: "v1/test-proactive-ack",
    substantive: false,
  });
  assert.equal(controlOnlyTouch, proactiveAck.task.id);
  const afterControlOnlyTouch = runtime.database.sqlite.prepare(`
    select delivery_owner, delivery_token, substantive_activity_count
    from continuation_tasks where id=?
  `).get(proactiveAck.task.id);
  assert.equal(afterControlOnlyTouch.delivery_owner, "synthetic-active",
    "control-plane liveness must not fulfill a synthetic resumed-turn work obligation");
  assert.equal(afterControlOnlyTouch.delivery_token, null,
    "the one-time delivery capability must remain consumed after the server-owned synthetic claim");
  assert.equal(Number(afterControlOnlyTouch.substantive_activity_count), controlOnlyCountBefore,
    "control-plane liveness must not increment substantiveActivityCount");

  const statusOnlyRetryTooEarly = runtime.continuationSupervisorSweep({ nowMs: Date.now() + 1_000 });
  assert.equal(statusOnlyRetryTooEarly.ready.some(
    (item) => item.conversationScopeId === "v1/test-proactive-ack",
  ), false,
  "a live synthetic resumed turn must not create a second assistant turn while its exact turn has not ended");
  runtime.database.sqlite.prepare(`
    update continuation_tasks set delivery_owner_expires_at=?, turn_lease_expires_at=? where id=?
  `).run(
    new Date(Date.now() - 1_000).toISOString(),
    new Date(Date.now() + 60_000).toISOString(),
    proactiveAck.task.id,
  );
  const statusOnlyRetry = runtime.continuationSupervisorSweep({ nowMs: Date.now() + 1_000 });
  assert.equal(statusOnlyRetry.ready.some(
    (item) => item.conversationScopeId === "v1/test-proactive-ack",
  ), false,
    "an expired synthetic work-ownership lease alone must not manufacture a second assistant turn while the Host outcome is still unknown");
  runtime.continuationTask({
    action: "host-signal",
    taskId: proactiveAck.task.id,
    coordinatorInstanceId: "ui_proactive_ack_anchor",
    hostProfileId: "synthetic-status-only@test",
    hostSignal: "timeout",
    elapsedMs: 60_000,
  });
  const {
    claim: statusOnlyRetryAfterHostEnd,
    card: retryAfterHostEndCard,
  } = claimModernReadyGeneration(
    proactiveAck,
    "v1/test-proactive-ack",
    "ui_proactive_ack_anchor",
  );
  assert.notEqual(statusOnlyRetryAfterHostEnd.deliveryToken, proactiveClaim.deliveryToken,
    "status-only recovery must create a new generation so a late failed turn cannot execute in parallel");
  assert.equal(statusOnlyRetryAfterHostEnd.generation, proactiveClaim.generation + 1,
    "exact Host timeout must advance directly to the next architecture generation without waiting for the stale 30-minute owner lease");
  authorizeModernGeneration(
    proactiveAck,
    "v1/test-proactive-ack",
    "ui_proactive_ack_anchor",
    retryAfterHostEndCard,
    statusOnlyRetryAfterHostEnd,
  );
  const retriedModelAck = runtime.continuationTask({
    action: "status",
    taskId: proactiveAck.task.id,
    deliveryToken: statusOnlyRetryAfterHostEnd.deliveryToken,
  });
  assert.equal(retriedModelAck.reason, "continuation-resume-acknowledged");
  assert.equal(retriedModelAck.task.syntheticResumeWorkRequired, true);
  const fulfilledToken = statusOnlyRetryAfterHostEnd.deliveryToken;
  const touchedAfterResume = runtime.touchContinuationModelActivity({
    workspaceId: "ws_proactive_ack",
    conversationScopeId: "v1/test-proactive-ack",
    substantive: true,
  });
  assert.equal(touchedAfterResume, proactiveAck.task.id);
  const afterRealToolBeforeCheckpoint = runtime.continuationTask({
    action: "status",
    taskId: proactiveAck.task.id,
  });
  assert.equal(afterRealToolBeforeCheckpoint.task.syntheticResumeWorkRequired, true,
    "a single ordinary tool call must not by itself retire the synthetic resumed-turn obligation");
  assert.equal(afterRealToolBeforeCheckpoint.task.deliveryOwner, "synthetic-active");
  assert.equal(afterRealToolBeforeCheckpoint.task.deliveryToken, undefined,
    "ordinary status/tool traffic after claim must not require the consumed delivery capability");
  const noOpResumeCheckpoint = runtime.continuationTask({
    action: "checkpoint",
    taskId: proactiveAck.task.id,
  });
  assert.equal(noOpResumeCheckpoint.task.syntheticResumeWorkRequired, true,
    "a no-op checkpoint must not let a synthetic turn satisfy the resume contract");
  const fulfilledResume = runtime.continuationTask({
    action: "checkpoint",
    taskId: proactiveAck.task.id,
    progressFingerprint: "synthetic-resume-made-material-progress",
    evidence: { syntheticResumeMaterialWork: true },
  });
  assert.equal(fulfilledResume.task.syntheticResumeWorkRequired, true,
    "material progress must not let a synthetic turn stop while a runnable milestone still remains");
  assert.equal(fulfilledResume.task.deliveryOwner, "synthetic-active");
  assert.equal(fulfilledResume.task.deliveryToken, undefined);
  const completedResume = runtime.continuationTask({
    action: "checkpoint",
    taskId: proactiveAck.task.id,
    completedMilestones: ["finish after timeout recovery"],
    progressFingerprint: "synthetic-resume-finished-milestone",
    evidence: { syntheticResumeMilestoneFinished: true },
  });
  assert.equal(completedResume.task.syntheticResumeWorkRequired, false,
    "real post-ACK work may retire synthetic ownership once the runnable milestone set is actually complete");
  assert.equal(completedResume.task.state, "SUCCEEDED",
    "a verified completion-driven checkpoint must atomically seal the task once its last resumed milestone is complete");
  assert.equal(completedResume.task.deliveryOwner, undefined,
    "terminal cleanup must not leave synthetic ownership artifacts on a succeeded task");
  assert.equal(completedResume.task.deliveryToken, undefined);
  const lateFulfilledSynthetic = runtime.continuationTask({
    action: "status",
    taskId: proactiveAck.task.id,
    deliveryToken: fulfilledToken,
  });
  assert.equal(lateFulfilledSynthetic.accepted, false);
  assert.equal(lateFulfilledSynthetic.reason, "task-terminal-no-work",
    "once the completed resumed work seals the task, duplicate delivery must be rejected by the stronger terminal-task gate");

  const directWork = runtime.continuationTask({
    action: "begin",
    conversationScopeId: "v1/test-direct-synthetic-work",
    workspaceId: "ws_direct_synthetic_work",
    requiredMilestones: ["perform direct resumed work"],
    maxContinuations: 4,
  });
  verifyRuntimeAnchor(directWork, "v1/test-direct-synthetic-work", "ui_direct_work_anchor");
  runtime.continuationTask({
    action: "host-signal",
    taskId: directWork.task.id,
    coordinatorInstanceId: "ui_direct_work_anchor",
    hostProfileId: "direct-work@test",
    hostSignal: "timeout",
    elapsedMs: 10_000,
  });
  const { claim: directWorkClaim, card: directWorkCard } = claimModernReadyGeneration(
    directWork,
    "v1/test-direct-synthetic-work",
    "ui_direct_work_anchor",
  );
  authorizeModernGeneration(
    directWork,
    "v1/test-direct-synthetic-work",
    "ui_direct_work_anchor",
    directWorkCard,
    directWorkClaim,
  );
  const directWorkDelivered = runtime.recordContinuationGenerationDelivery({
    deliveryToken: directWorkClaim.deliveryToken,
    result: "accepted",
    method: "ui/message",
  });
  assert.equal(directWorkDelivered.accepted, true);
  const pendingDirectStatus = runtime.database.sqlite.prepare(`
    select delivery_owner, delivery_token, continuation_pending,
           delivery_ack_started_at, delivery_ack_retry_after_at
    from continuation_tasks where id=?
  `).get(directWork.task.id);
  assert.equal(pendingDirectStatus.delivery_owner, "synthetic-pending",
    "before model ACK or real work the synthetic generation must remain pending");
  assert.equal(pendingDirectStatus.delivery_token, directWorkClaim.deliveryToken);
  assert.ok(Number(pendingDirectStatus.continuation_pending) > 0,
    "accepted transport delivery must remain pending until the model ACKs or performs real work");
  assert.ok(pendingDirectStatus.delivery_ack_started_at || pendingDirectStatus.delivery_ack_retry_after_at,
    "accepted transport delivery must retain durable ACK-retry state before real work begins");
  const directSubstantiveTouch = runtime.touchContinuationModelActivity({
    workspaceId: "ws_direct_synthetic_work",
    conversationScopeId: "v1/test-direct-synthetic-work",
    substantive: true,
  });
  assert.equal(directSubstantiveTouch, directWork.task.id);
  const afterDirectWork = runtime.database.sqlite.prepare(`
    select delivery_owner, delivery_token, superseded_delivery_token,
           continuation_pending, delivery_ack_started_at,
           delivery_ack_retry_count, delivery_ack_retry_after_at,
           delivery_owner_expires_at
    from continuation_tasks where id=?
  `).get(directWork.task.id);
  assert.equal(afterDirectWork.delivery_owner, "synthetic-pending",
    "a tool call that skipped the mandatory token ACK must not silently fulfill the synthetic generation");
  assert.ok(Number(afterDirectWork.continuation_pending) > 0);
  assert.equal(afterDirectWork.delivery_token, directWorkClaim.deliveryToken);
  assert.ok(afterDirectWork.delivery_ack_started_at || afterDirectWork.delivery_ack_retry_after_at,
    "pre-ACK work must retain the delivery readiness obligation");
  assert.ok(afterDirectWork.delivery_owner_expires_at,
    "real tool traffic may renew ownership while leaving the synthetic generation pending");
  const directAck = runtime.continuationTask({
    action: "status",
    taskId: directWork.task.id,
    deliveryToken: directWorkClaim.deliveryToken,
  });
  assert.equal(directAck.reason, "continuation-resume-acknowledged");
  runtime.touchContinuationModelActivity({
    workspaceId: "ws_direct_synthetic_work",
    conversationScopeId: "v1/test-direct-synthetic-work",
    substantive: true,
  });
  const directMaterialCheckpoint = runtime.continuationTask({
    action: "checkpoint",
    taskId: directWork.task.id,
    progressFingerprint: "direct-synthetic-work-checkpointed",
    evidence: { directSyntheticWork: "verified" },
  });
  assert.equal(directMaterialCheckpoint.task.deliveryOwner, "synthetic-active",
    "a progress-only checkpoint must preserve synthetic ownership while the direct-work milestone remains runnable");
  assert.equal(directMaterialCheckpoint.task.deliveryToken, undefined,
    "the generation remains server-owned after the one-time status claim");
  const directCompletedCheckpoint = runtime.continuationTask({
    action: "checkpoint",
    taskId: directWork.task.id,
    completedMilestones: ["perform direct resumed work"],
    progressFingerprint: "direct-synthetic-work-complete",
    evidence: { directSyntheticWorkComplete: true },
  });
  assert.equal(directCompletedCheckpoint.task.state, "SUCCEEDED");
  assert.equal(directCompletedCheckpoint.task.deliveryOwner, undefined,
    "terminal cleanup must clear direct synthetic ownership after the completed checkpoint seals the task");
  assert.equal(directCompletedCheckpoint.task.deliveryToken, undefined);
  const lateDirectSynthetic = runtime.continuationTask({
    action: "status",
    taskId: directWork.task.id,
    deliveryToken: directWorkClaim.deliveryToken,
  });
  assert.equal(lateDirectSynthetic.accepted, false);
  assert.equal(lateDirectSynthetic.reason, "task-terminal-no-work",
    "a late copy after direct real work seals the task must be rejected by the terminal-task gate");

  const manualTakeover = runtime.continuationTask({
    action: "begin",
    conversationScopeId: "v1/test-manual-takeover",
    workspaceId: "ws_manual_takeover",
    requiredMilestones: ["finish exactly once"],
    maxContinuations: 4,
  });
  verifyRuntimeAnchor(manualTakeover, "v1/test-manual-takeover", "ui_manual_takeover_anchor");
  runtime.continuationTask({
    action: "host-signal",
    taskId: manualTakeover.task.id,
    coordinatorInstanceId: "ui_manual_takeover_anchor",
    hostProfileId: "manual-race@test",
    hostSignal: "timeout",
    elapsedMs: 10_000,
  });
  const { claim: manualRaceClaim, card: manualRaceCard } = claimModernReadyGeneration(
    manualTakeover,
    "v1/test-manual-takeover",
    "ui_manual_takeover_anchor",
  );
  authorizeModernGeneration(
    manualTakeover,
    "v1/test-manual-takeover",
    "ui_manual_takeover_anchor",
    manualRaceCard,
    manualRaceClaim,
  );
  const supersededToken = manualRaceClaim.deliveryToken;
  const manualDeliveryReceipt = runtime.recordContinuationGenerationDelivery({
    deliveryToken: supersededToken,
    result: "accepted",
    method: "ui/message",
  });
  assert.equal(manualDeliveryReceipt.accepted, true);
  const manualDelivered = runtime.continuationTask({
    action: "status",
    taskId: manualTakeover.task.id,
    readOnlyStatus: true,
  });
  assert.equal(manualDelivered.task.deliveryToken, supersededToken);
  assert.equal(manualDelivered.task.deliveryOwner, "synthetic-pending");
  assert.equal(manualDelivered.task.continuationPending, true);
  const manualOwner = runtime.continuationTask({
    action: "status",
    taskId: manualTakeover.task.id,
    manualTakeover: true,
  });
  assert.equal(manualOwner.accepted, true);
  assert.equal(manualOwner.reason, "manual-turn-took-over",
    "a real/manual model turn must explicitly claim takeover before it can revoke synthetic ownership");
  assert.equal(manualOwner.task.deliveryOwner, "manual");
  assert.equal(manualOwner.task.continuationPending, false);
  assert.ok(manualOwner.task.manualTakeoverAt);
  assert.equal(manualOwner.continueRequired, true,
    "manual takeover preserves the original unfinished Task Contract instead of cancelling the user's work");
  const lateSynthetic = runtime.continuationTask({
    action: "status",
    taskId: manualTakeover.task.id,
    deliveryToken: supersededToken,
  });
  assert.equal(lateSynthetic.accepted, false);
  assert.equal(lateSynthetic.reason, "synthetic-continuation-superseded",
    "a late automatic turn must stop instead of executing alongside the newer manual turn");
  assert.equal(lateSynthetic.superseded, true);
  assert.equal(lateSynthetic.staleSyntheticTurn, true,
    "a Host-delayed automatic user message must be classified as a stale synthetic turn");
  assert.equal(lateSynthetic.suppressVisibleFinal, true,
    "a stale synthetic turn must instruct the model to terminate without adding visible status noise");
  assert.equal(lateSynthetic.continueRequired, false);
  assert.equal(lateSynthetic.finalResponseAllowed, true);
  assert.match(coordinator, /function continuationContext\([\s\S]{0,9000}staleSyntheticTurn=true[\s\S]{0,220}suppressVisibleFinal=true[\s\S]{0,320}synthetic-continuation-superseded/,
    "hidden continuation context must explicitly self-suppress a delayed superseded synthetic message after its first status call");
  assert.doesNotMatch(coordinator, /当前任务：\$\{objective\}[\s\S]{0,160}下一未完成里程碑：\$\{milestone\}/,
    "the visible synthetic Host envelope must stay compact instead of replaying the full durable task contract into the transcript");

  console.log(JSON.stringify({
      persistentTaskState: true,
      conversationLifetimeSingleton: true,
      conversationIsolation: true,
    milestoneCompletionGate: true,
    completionEvidenceGate: true,
    completionDrivenNoProgressNonTerminal: true,
    strictModeNoProgressLoopGovernor: true,
    waitingExternalGate: true,
    continuationDedupe: true,
    continuationCooldown: true,
    continuationBudget: true,
    integratedWorkspaceApp: true,
    nativeChatGptFollowUpPath: true,
    officialAppToolCallPath: true,
    backgroundSupervisorTimer: true,
    hostBudgetTelemetryOnly: true,
    modelIdleAutoContinuationRemoved: true,
    compatNormalTeardownDoesNotContinue: true,
    timeoutRecoverySilenceFailsClosed: true,
    timeoutRecoveryNormalTeardownFailsClosed: true,
    completionDrivenCorroboratedStallRecovery: true,
    activityLeaseSilenceDoesNotContinue: true,
    adaptiveHostCutoffRegime: true,
    completionDrivenNormalTeardownFailsClosed: true,
    unlimitedCompletionDrivenBudgets: true,
    openWorkspaceHeadlessSingleAnchor: true,
    explicitHostTimeoutRecovery: true,
    resumedTurnSingleAnchor: true,
    staleSupervisorHeadlessRecovery: true,
    ownerPauseSuppressesAutomation: true,
    timeoutDeliveryResumeAck: true,
    syntheticDeliveryGenerationToken: true,
    manualTurnSupersedesLateSyntheticTurn: true,
    deliveryReadinessBackoff: true,
    durableSyntheticDeliveryNoRetransmission: true,
    staleSyntheticHostMessageSelfSuppression: true,
    syntheticResumeRequiresSubstantiveWork: true,
    syntheticStatusOnlyTurnRecovery: true,
    syntheticControlTrafficNotSubstantive: true,
    syntheticDirectWorkFulfillsPendingGeneration: true,
    syntheticVisibleTriggerRequiresExecution: true,
    residentProcessCompletionWake: true,
    residentStageWake: true,
    nonResidentProcessWakeRejected: true,
    singleContinuationAnchor: true,
    verifiedTeardownCompletionFastPath: true,
    continuationDeliveryDiagnostics: true,
    explicitWallClockExtension: true,
    nativeOnlyFollowUpRecovery: true,
    persistentProcessWakeTakeover: true,
    staleSupervisorWaitGuard: true,
    coordinatorStatusLivenessTouch: true,
    supervisorAckWaitHandshake: true,
    continuationAckDiagnosticNoRetransmission: true,
    explicitAnchorTaskBinding: true,
    exactTaskConversationIsolation: true,
    historicalContinuationGuardAlias: true,
    domAutomationAbsent: true,
  }));
} finally {
  runtime.close();
  rmSync(stateDir, { recursive: true, force: true });
}
