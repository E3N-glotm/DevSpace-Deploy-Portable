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
const featureTools = readFileSync(join(ROOT, "vendor", "waishnav-devspace", "dist", "feature-tools.js"), "utf8");
const coordinatorPath = join(ROOT, "vendor", "waishnav-devspace", "dist", "ui", "assets", "continuation-coordinator.js");
const coordinator = readFileSync(coordinatorPath, "utf8");
const visibleTriggerSource = coordinator.match(/function visibleContinuationTrigger\(task\) \{[\s\S]*?\n\}/)?.[0] ?? "";
const finalizeRelease = readFileSync(join(ROOT, "setup", "finalize-release.py"), "utf8");
const uiManifest = JSON.parse(readFileSync(join(ROOT, "vendor", "waishnav-devspace", "dist", "ui", ".vite", "manifest.json"), "utf8"));
const workspaceEntry = uiManifest["workspace-app.html"];
assert.ok(workspaceEntry?.file, "workspace-app.html must exist in the Vite manifest");
const workspaceBundle = readFileSync(join(ROOT, "vendor", "waishnav-devspace", "dist", "ui", workspaceEntry.file), "utf8");
assert.match(finalizeRelease,
  /app\/node_modules\/@waishnav\/devspace\/dist\/ui\/assets\/continuation-coordinator\.js/,
  "release metadata must fingerprint the continuation coordinator so same-version live/source drift is detectable");

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
]) assert.match(migrations, pattern);
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
  /continuationCoordinatorSource/,
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
assert.match(server, /resident[^\n]{0,300}(?:watch-process|stage\/process wakes)[\s\S]{0,500}(?:stage-complete|watch-process)/,
  "server guidance must reserve process/stage wakes for explicit resident or monitoring work");
assert.doesNotMatch(server, /snapshot\.running && effectivePersistent && config\.features\?\.continuationGuard && runtimeState/,
  "exec_command must not auto-register every still-running persistent process as a continuation wake");
assert.doesNotMatch(server, /action: "watch-process",[\s\S]{0,220}processHandle: snapshot\.processHandle/,
  "process completion wake must require an explicit continuation_task watch-process call");
assert.doesNotMatch(server, /<script[^>]+src="\$\{continuationCoordinatorUrl\}"/, "continuation coordinator must be delivered inline with the MCP App resource so same-version host asset caches cannot pin stale logic");
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
  /app\.sendMessage/,
  /app\.updateModelContext/,
  /addEventListener\("toolcancelled"/,
  /sendFollowUpMessage/,
  /host-signal/,
  /watch-status/,
  /resident watched process completed/,
  /resident stage completed/,
  /delivery ACK retry/,
  /continuation_sender/,
  /callSender/,
  /delivery-result/,
  /WAITING_EXTERNAL/,
  /PAUSED_BY_USER/,
  /continuationPending/,
  /manual recovery/,
  /onTeardown/,
]) assert.match(coordinator, pattern);
assert.doesNotMatch(coordinator, /claim-continuation|release-continuation/,
  "legacy continuation_task claim/release sender paths must stay removed");
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
  "historical Host cutoff observations must not arm completion-driven recovery without a current-turn end signal");
assert.doesNotMatch(runtimeStateSource, /earlyCompletionCorroborated|short-confirmed-probe/,
  "runtime state must not arm recovery from repeated UI heartbeat probes alone");
assert.match(runtimeStateSource, /COMPLETION_STALL_SUSPECT_MS = 25_000/,
  "the primary completion-driven inactivity lease must remain below the one-minute ceiling");
assert.doesNotMatch(runtimeStateSource, /COMPLETION_SERVER_QUIET_BACKSTOP_MS/,
  "request silence must not be promoted into a continuation authorization timer");
assert.doesNotMatch(runtimeStateSource, /COMPLETION_QUIET_RECOVERY_MS|COMPLETION_STALL_CONFIRM_MS/,
  "the old heartbeat-confirmation quiet-window implementations must stay removed");
assert.match(runtimeStateSource, /DELIVERY_ACK_RETRY_MAX_MS = 45_000/,
  "delivery ACK retransmission must remain bounded below one minute");
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
assert.match(runtimeStateSource, /action === "turn-complete"[\s\S]{0,3600}assistant_turn_completion_lease_id/,
  "normal assistant completion intent must be explicitly signed and bound to the current turn lease");
assert.match(runtimeStateSource, /MODEL_COMPLETION_HANDOFF_GRACE_MS = 8_000/,
  "normal ChatGPT finals without Apps teardown must use a prompt bounded handoff grace only after explicit ATCC intent");
assert.match(runtimeStateSource, /promoteMatureAssistantCompletionIntent\(taskId[\s\S]{0,4200}assistant_turn_state='COMPLETED'[\s\S]{0,1200}model-completion-handoff-grace/,
  "the resident runtime must promote only a durable explicit completion request into a completed turn after the handoff grace");
assert.match(runtimeStateSource, /promoteMatureAssistantCompletionIntent\(taskId[\s\S]{0,3000}assistant_turn_state \|\| ""\) !== "COMPLETION_REQUESTED"[\s\S]{0,2400}continuationModelRequestInFlight\(current\.conversation_scope_id\)/,
  "the handoff grace must be unreachable from GENERATING silence and must fail closed while any model-originated DevSpace request is in flight");
assert.match(runtimeStateSource, /touchContinuationModelActivity[\s\S]{0,4200}assistant_turn_state='COMPLETION_REQUESTED'[\s\S]{0,300}then 'GENERATING'/,
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
  "historical cutoff values must remain telemetry-only and must not create a no-signal continuation path");
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
assert.match(coordinator, /resource teardown carries no reason payload[\s\S]{0,700}teardown alone[\s\S]{0,700}confirmation fast path[\s\S]{0,700}COMPLETION_REQUESTED lease after its guarded handoff grace/,
  "generic teardown must remain non-authorizing by itself while acting only as an optional fast path for an explicit ATCC completion request");
assert.match(coordinator, /recordHostSignal\(timedOut \? "timeout" : "teardown"[\s\S]{0,700}assistantTurnCompletionArmed\(state\.task\)[\s\S]{0,800}ATCC normal assistant completion confirmed by Host teardown/,
  "verified teardown may still trigger the immediate ATCC fast path when the same exact turn already signed completion");
assert.doesNotMatch(coordinator, /syntheticDeliveryToken:|continuationDeliveryToken|DevSpace resume token/,
  "the coordinator must keep generation capabilities inside App/runtime transport instead of exposing them to the model");
assert.match(coordinator, /TRANSIENT_RETRY_DELAYS_MS[\s\S]{0,2200}transientTransportFailure/,
  "Workspace App server calls must retry transient Connection failed/TLS style transport errors with bounded backoff");
assert.match(coordinator, /function visibleContinuationTrigger\(task\)[\s\S]{0,2200}继续执行未完成的 DevSpace 任务[\s\S]{0,500}当前任务[\s\S]{0,500}下一未完成里程碑[\s\S]{0,700}不要只回复状态[\s\S]{0,240}继续处理中/,
  "the visible synthetic continuation trigger must carry sustained-work semantics in the actual Host user-role turn instead of relying only on hidden context");
assert.match(coordinator, /Continue the unfinished DevSpace task[\s\S]{0,500}Current task[\s\S]{0,500}Next unfinished milestone[\s\S]{0,1800}do not reply with only a status[\s\S]{0,240}still working/,
  "the English visible synthetic trigger must also forbid a status-only premature final");
assert.match(coordinator, /One failed command\/test[\s\S]{0,500}two or three quick tool calls[\s\S]{0,900}action=turn-complete[\s\S]{0,300}finalResponseAllowed=true/,
  "the visible synthetic trigger must explicitly reject short failure-driven turns and require the ATCC stage-boundary handshake before a voluntary incomplete final");
assert.doesNotMatch(coordinator, /继续。直接完成当前未完成的任务。|Continue\. Directly complete the current unfinished task\./,
  "the visible synthetic continuation trigger must not pressure the model to skip state reconstruction or verification");
assert.match(visibleTriggerSource, /task\?\.objective[\s\S]{0,500}nextUnresolvedMilestone\(task\)/,
  "the visible synthetic message must carry durable task semantics when hidden model context is not replayed by the Host");
assert.doesNotMatch(visibleTriggerSource, /taskId=|workspaceId=|deliveryToken|generation capability/,
  "taskId/workspaceId/recovery policy must not be emitted as a visible user message");
assert.match(coordinator, /function continuationContext\(/,
  "the coordinator must define hidden continuation context for resumed turns");
assert.match(coordinator, /runtime atomically claims any server-owned expected synthetic generation/,
  "hidden context must direct the first status call while leaving UUID transport to the runtime");
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
assert.match(coordinator, /callSender\("claim"[\s\S]{0,4200}updateModelContext[\s\S]{0,2600}callSender\("authorize-delivery"[\s\S]{0,2200}sendFollowUp\(visibleContinuationTrigger\(state\.task\),\s*async \(\) =>/,
  "automatic delivery must re-authorize synthetic ownership immediately before the visible Host trigger");
assert.match(coordinator, /sendFollowUp\(visibleContinuationTrigger\(state\.task\),\s*async \(\) => \{[\s\S]{0,800}callTask\("status"\)[\s\S]{0,600}!terminal\(state\.task\)/,
  "the irreversible Host send must have a final authoritative terminal-state recheck");
assert.match(coordinator, /function acceptTask\([\s\S]{0,700}terminal\(state\.task\)[\s\S]{0,300}stopSupervisor\(\)[\s\S]{0,200}stopLifecycleRefresh\(\)/,
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
assert.match(runtimeStateSource, /bindContinuationSender\(input = \{\}\)[\s\S]{0,5200}state='READY'[\s\S]{0,1200}readyGeneration/,
  "sender bind must surface an already-durable READY generation so a newly mounted ordinary App can consume it immediately");
assert.match(runtimeStateSource, /recordContinuationHostTelemetry\(input = \{\}\)[\s\S]{0,6200}continuation-host-telemetry/,
  "Host-surface telemetry must remain an event-journal diagnostic instead of becoming continuation authorization state");
assert.match(coordinator, /function safeTelemetryName\(value\)[\s\S]{0,260}A-Za-z0-9\._:\/-/,
  "the coordinator must bound telemetry to safe Host API key/method names instead of arbitrary content");
assert.match(coordinator, /window\.addEventListener\("openai:set_globals",\s*onOpenAiGlobals\)/,
  "the coordinator must observe Host global-surface changes");
assert.match(coordinator, /callSender\("telemetry",\s*\{\s*telemetry:\s*payload\s*\}\)/,
  "the coordinator must report Host-surface names through the hidden sender bridge");
assert.match(coordinator, /async function consumeReadyAfterSenderBind\([\s\S]{0,1300}readyGeneration[\s\S]{0,800}attemptContinuation\(reason, \{ force: true \}\)/,
  "a newly bound sender transport must immediately consume READY instead of waiting for the old milestone iframe or another supervisor tick");
assert.match(coordinator, /bindSenderTransport\(\)[\s\S]{0,700}consumeReadyAfterSenderBind\(bound/,
  "ordinary Workspace App bind/rehydrate must wire directly into deterministic READY delivery");
assert.match(coordinator, /const current = await callTask\("status"\)[\s\S]{0,3200}current\?\.readyGeneration[\s\S]{0,900}attemptContinuation\("supervisor discovered READY generation", \{ force: true \}\)/,
  "an already-bound or generation-safely rebound sender must consume a READY generation that appears later during an ordinary supervisor status refresh");
assert.match(runtimeStateSource, /manual-user-turn-takeover/,
  "runtime must retain an old-schema-compatible manual takeover CAS marker on the existing note field");
assert.match(server, /older cached schema without manualTakeover[\s\S]{0,500}manual-user-turn-takeover/,
  "server guidance must document the manual takeover fallback for already-open Hosts whose continuation_task schema is stale");
assert.match(coordinator, /function senderTransportAvailable\(\)[\s\S]{0,500}anchorMountRequestedAt[\s\S]{0,240}activeSenderCapability\(\)/,
  "a later trusted Workspace App relay must keep sender transport available while the original iframe ACK is pending");
assert.match(coordinator, /same full Host reasoning budget and sustained execution semantics as a manual 'continue'[\s\S]{0,500}polling owned long-running processes[\s\S]{0,500}Host truncates the turn/,
  "hidden recovery context must give synthetic turns the same reasoning/execution budget and natural stopping point as manual continuation");
assert.match(runtimeStateSource, /syntheticResumeWorkRequired:\s*row\.delivery_owner === "synthetic-active"[\s\S]{0,220}deliveryOwnerExpiresAt/,
  "runtime status must retain a durable resumed-turn work obligation after the connectivity ACK");
assert.match(runtimeStateSource, /SYNTHETIC_WORK_OWNER_LEASE_MS = 30 \* 60_000/,
  "synthetic ownership must remain durable across manual-like reasoning/execution intervals rather than expiring after a few tens of seconds");
assert.match(runtimeStateSource, /const minimumWorkDelta = owner === "synthetic" \? 4 : 1/,
  "synthetic turn-complete must require a stronger post-ACK substantive-work floor than the old two-call short-loop contract");
assert.match(runtimeStateSource, /SYNTHETIC_MIN_ACTIVE_WORK_MS = 120_000/,
  "an incomplete synthetic stage must receive a manual-like minimum active work window before voluntary turn-complete is legal");
assert.match(runtimeStateSource, /SYNTHETIC_CONFIRMED_HOST_BUDGET_RATIO = 0\.95/,
  "a synthetic incomplete-stage boundary must reserve only a small finalization margin from a confirmed Host budget");
assert.match(runtimeStateSource, /function syntheticMinimumActiveWorkMs\(row\)[\s\S]{0,600}confirmed_turn_limit_ms[\s\S]{0,500}SYNTHETIC_CONFIRMED_HOST_BUDGET_RATIO/,
  "synthetic voluntary completion must derive its duration gate from the learned real Host cutoff instead of a fixed two-minute target");
assert.match(runtimeStateSource, /const activeWorkMs =[\s\S]{0,700}synthetic-turn-min-active-work-required[\s\S]{0,700}minimumActiveWorkMs/,
  "synthetic turn-complete must enforce the active-work quality gate without using that timer as continuation authority");
assert.match(coordinator, /Four substantive operations are only the post-ACK minimum, not a target duration[\s\S]{0,500}confirmed Host cutoff[\s\S]{0,500}two-minute synthetic turn/,
  "synthetic Host-visible context must explicitly reject treating four tool calls or two minutes as the target work duration");
assert.match(coordinator, /synthetic-turn-min-active-work-required[\s\S]{0,300}retryAfterMs[\s\S]{0,300}raw final/,
  "a rejected synthetic turn-complete must instruct the model to keep working rather than bypassing the duration gate with a raw final");
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
assert.match(coordinator, /Never end an automatically resumed turn with a placeholder\/status-only reply[\s\S]{0,500}There is no background model execution after a final assistant message/,
  "synthetic recovery context must explicitly forbid placeholder finals such as '继续处理中。'");
assert.match(runtimeStateSource, /const syntheticTurnLeaseId = String\(syntheticOwnerTask\?\.turn_lease_id[\s\S]{0,260}const syntheticCompletionLeaseId = String\(syntheticOwnerTask\?\.assistant_turn_completion_lease_id[\s\S]{0,420}const syntheticMode = normalizedContinuationMode[\s\S]{0,420}const syntheticTurnEnded =[\s\S]{0,520}syntheticCompletionLeaseId === syntheticTurnLeaseId/,
  "synthetic retry must require a terminal ATCC state bound to the exact current resumed-turn lease");
assert.match(runtimeStateSource, /const abandonedSyntheticWork =[\s\S]{0,1200}&& syntheticTurnEnded/,
  "an expired synthetic ownership lease must not manufacture a duplicate Host turn unless the separate syntheticTurnEnded gate corroborates the resumed turn boundary");
assert.ok(runtimeStateSource.includes("synthetic owner lease is only a stale-ownership")
  && runtimeStateSource.includes("Never manufacture a second ChatGPT turn from owner-lease")
  && runtimeStateSource.includes("fixed quiet threshold"),
  "connector discovery, reasoning, and workspace switching may outlive ownership bookkeeping; silence must remain non-authorizing");
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
  "historical Host cutoff samples must not participate in automatic continuation authorization");
assert.match(runtimeStateSource, /if \(result === "unknown"\)[\s\S]{0,1800}outcomeUncertain:\s*true/,
  "an unknown Host delivery result must remain outcome-uncertain instead of being converted into an automatic retry");
assert.match(runtimeStateSource, /DELIVERING is an outcome-uncertain zone[\s\S]{0,900}preserve the same generation/,
  "the delivery FSM must explicitly document that a lost send callback cannot authorize a duplicate continuation");
assert.match(coordinator, /deliveryAckRetryDue[\s\S]{0,1500}deliveryAckRetryAfterAt/,
  "delivery ACK retransmission must honor the persisted retry schedule instead of polling new turns every supervisor tick");
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
assert.match(server, /Do not end with an ACK[\s\S]{0,260}checkpoint[\s\S]{0,520}same assistant turn[\s\S]{0,700}runnable milestone set/,
  "an unfinished Task Contract must forbid status/checkpoint-only final responses and require same-turn work through the runnable milestone set");
assert.match(server, /successful checkpoint persists progress[\s\S]{0,500}does not make a final response legal[\s\S]{0,650}long-running process[\s\S]{0,500}same sustained-work stopping rule as a manual user 'continue'/,
  "Task Contract rendering must forbid checkpoint-as-yield and require owned long-process completion in synthetic turns");
assert.match(server, /nextRequiredMilestones/,
  "Task Contract results must expose remaining milestones as structured state instead of relying on a prose ACK convention");
assert.match(server, /taskIncomplete=\$\{Boolean\(outcome\.taskIncomplete\)\};[\s\S]{0,260}finalResponseAllowed=\$\{finalResponseAllowed\};[\s\S]{0,260}remainingMilestones=/,
  "ordinary DevSpace work must surface machine-readable incomplete/sustained-work/final-response state while milestones remain");
assert.match(server, /continueInSameTurn=\$\{Boolean\(outcome\.continueInSameTurn\)\}/,
  "continuation_task text must expose the same-turn sustained-work directive");
assert.match(server, /syntheticWorkMustContinue=\$\{Boolean\(outcome\.syntheticWorkMustContinue\)\}/,
  "continuation_task text must expose the synthetic sustained-work directive");
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
assert.match(coordinator, /anchorSurface:\s*false/,
  "the continuation coordinator must distinguish the dedicated anchor iframe from ordinary Workspace App surfaces");
assert.match(coordinator, /anchorMountToken:\s*undefined/,
  "the continuation coordinator must still keep the original anchor generation capability separate from ordinary result state");
assert.match(coordinator, /senderCapability:\s*undefined/,
  "a separate transport capability slot must exist so sender ownership can move without changing the visible anchor-card identity");
assert.match(coordinator, /senderCapabilityFromResult[\s\S]{0,1800}devspace\/continuation-sender/,
  "transport sender authority must come from private tool-result metadata rather than a second continuation_anchor invocation");
assert.match(coordinator, /anchorMountGeneration:\s*undefined[\s\S]{0,200}anchorSuperseded:\s*false/,
  "the anchor surface must track its issuance generation and whether a newer recovery card superseded it");
assert.match(coordinator, /authoritativeGeneration[\s\S]{0,500}surfaceGeneration[\s\S]{0,500}markAnchorSuperseded\(\)/,
  "a lazily mounted old ghost generation must retire its visible-card authority before it can ACK the newer card");
assert.match(coordinator, /data-devspace-anchor-superseded[\s\S]{0,500}replaceChildren\(\)/,
  "a superseded immutable historical card must collapse its own iframe surface instead of remaining a second active milestone UI");
assert.match(coordinator, /headlessSenderRelay:\s*false/,
  "the coordinator state must explicitly track headless sender-relay demotion");
assert.match(coordinator, /function markAnchorSuperseded\(\)[\s\S]{0,700}state\.headlessSenderRelay = true/,
  "a superseded visible card must demote to a headless sender relay instead of killing the only surviving Host transport");
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
assert.match(coordinator, /if \(!state\.anchorSurface \|\| state\.headlessSenderRelay\) \{[\s\S]{0,700}never arm recovery from it/,
  "teardown of a transport-only or superseded headless App must not impersonate authoritative current-card lifecycle evidence");
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
assert.match(coordinator, /authoritativeGeneration > surfaceGeneration\) markAnchorSuperseded\(\)/,
  "every authoritative coordinator result must immediately retire a historical card whose generation is stale");
assert.match(coordinator, /preClaim = await callTask\("status"\)[\s\S]{0,800}state\.anchorSuperseded[\s\S]{0,500}bindSenderTransport\(\)[\s\S]{0,500}callSender\("claim"/,
  "the App must re-check authoritative generation and rebind a superseded relay before claiming a continuation");
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
assert.doesNotMatch(coordinator, /window\.parent\.postMessage|querySelector\([^)]*(?:textarea|composer|send)/i, "continuation must use the connected App rather than raw host/DOM automation");
assert.doesNotMatch(coordinator, /23\s*\*\s*60\s*\*\s*1000|24\.5\s*\*\s*60\s*\*\s*1000|25(?:\.\d+)?\s*\*\s*60\s*\*\s*1000/, "continuation must not depend on a fixed ChatGPT minute limit");
assert.match(workspaceBundle, /window\.__DEVSPACE_MCP_APP__=Y_/);
assert.match(workspaceBundle, /window\.__DEVSPACE_ATTACH_CONTINUATION__\?\.\(Y_\)/);
assert.match(workspaceBundle, /window\.__DEVSPACE_CONTINUATION_CONNECTED__\?\.\(Y_\)/);
assert.match(workspaceBundle, /window\.__DEVSPACE_CONTINUATION_TEARDOWN__\?\.\(Y_,e,t\)/);

const { toolWidgetDescriptorMeta, workspaceAppGenerationUri, workspaceAppHtml, workspaceAppResourceResult, workspaceAppResultMeta, workspaceAppUri } = await import(`${pathToFileURL(packagedServerPath).href}?descriptor=${Date.now()}`);
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
const anchorUri = workspaceAppUri(descriptorConfig);
const workspaceMeta = toolWidgetDescriptorMeta(descriptorConfig, "workspace");
assert.equal(workspaceMeta?._meta?.ui?.resourceUri, undefined,
  "open_workspace must stay headless in widgets=changes so workspace reuse cannot accumulate duplicate recovery cards");
assert.equal(workspaceMeta?._meta?.["openai/outputTemplate"], undefined);
assert.match(anchorUri, /^ui:\/\/devspace\/workspace-app-[0-9a-f]{16}\.html$/);
assert.equal(anchorMeta?._meta?.ui?.resourceUri, anchorUri);
assert.equal(anchorMeta?._meta?.["openai/outputTemplate"], anchorUri);
const generation7Uri = workspaceAppGenerationUri(descriptorConfig, 7);
const generation8Uri = workspaceAppGenerationUri(descriptorConfig, 8);
assert.match(generation7Uri, /^ui:\/\/devspace\/workspace-app-[0-9a-f]{16}-g7\.html$/,
  "a deliberate milestone-card generation must receive a generation-specific result cache key");
assert.equal(workspaceAppGenerationUri(descriptorConfig, 7), generation7Uri,
  "replaying the same generation must preserve the same result cache key");
assert.notEqual(generation8Uri, generation7Uri,
  "a later deliberate milestone-card generation must not reuse an earlier generation cache key");
assert.equal(workspaceAppGenerationUri(descriptorConfig, 0), anchorUri,
  "invalid/non-positive generations must fall back to the stable revisioned Workspace App URI");
const generation7Meta = workspaceAppResultMeta(descriptorConfig, 7);
assert.equal(generation7Meta?.ui?.resourceUri, generation7Uri);
assert.equal(generation7Meta?.["ui/resourceUri"], generation7Uri);
assert.equal(generation7Meta?.["openai/outputTemplate"], generation7Uri);
const fullWorkspaceMeta = toolWidgetDescriptorMeta({ ...descriptorConfig, widgets: "full" }, "workspace");
assert.equal(fullWorkspaceMeta?._meta?.ui?.resourceUri, anchorUri,
  "widgets=full keeps the explicit compatibility behavior where workspace calls render cards");
assert.equal(fullWorkspaceMeta?._meta?.["openai/outputTemplate"], anchorUri);
assert.notEqual(workspaceAppUri({ ...descriptorConfig, publicBaseUrl: "https://other.example.test" }), anchorUri, "changing the public asset origin must produce a fresh Workspace App URI");
const renderedWorkspaceApp = workspaceAppHtml(descriptorConfig);
assert.match(renderedWorkspaceApp, /return\s+[A-Za-z_$][\w$]*===`continuation_anchor`\|\|[A-Za-z_$][\w$]*===`open_workspace`/,
  "the final self-contained Workspace App resource must really route continuation_anchor into the visible renderer after minification");
assert.match(renderedWorkspaceApp, /<script type="module">[\s\S]*installContinuationCoordinator/, "Workspace App HTML must embed the continuation coordinator directly in the versioned MCP App resource");
assert.doesNotMatch(renderedWorkspaceApp, /data:text\/javascript;base64,/, "Workspace App HTML must not depend on a data: module that ChatGPT may block before widget CSP compatibility metadata is applied");
assert.doesNotMatch(renderedWorkspaceApp, /src="[^"]*continuation-coordinator\.js/, "Workspace App HTML must not depend on an externally cached continuation coordinator script");
assert.match(renderedWorkspaceApp, /window\.__DEVSPACE_MCP_APP__=/, "Workspace App HTML must inline the MCP Apps bootstrap bundle so ChatGPT does not need a second script request before connecting");
assert.match(renderedWorkspaceApp, /RUNTIME_TOOLS/, "Workspace App HTML must inline runtime enhancements used by the render surface");
assert.match(renderedWorkspaceApp, /__devspaceEarlyHostMessages/, "Workspace App must buffer host notifications that arrive before module listeners are ready");
assert.match(renderedWorkspaceApp, /stopImmediatePropagation\(\)/, "early host notifications must be delivered exactly once after module bootstrap");
assert.match(renderedWorkspaceApp, /devspace:workspace-app-ready/, "Workspace App must announce completion of early-message replay");
assert.doesNotMatch(renderedWorkspaceApp, /<section class="empty">Waiting for a tool result\.<\/section>/, "the legacy permanently-stuck placeholder must not remain in the Workspace App shell");
assert.match(renderedWorkspaceApp, /data-devspace-continuation/, "Workspace App must include the dedicated continuation task card renderer");
assert.match(renderedWorkspaceApp, /<style>[\s\S]*\.shell/, "Workspace App HTML must inline its initial styles so the iframe is self-contained");
assert.doesNotMatch(renderedWorkspaceApp, /<script[^>]+src=/, "Workspace App bootstrap must not depend on external script requests");
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
assert.match(generationResource.contents?.[0]?.text ?? "", /installContinuationCoordinator/,
  "generation-specific result cache keys must still resolve to the current self-contained Workspace App");
const historicalContinuationGuardUri = "ui://devspace/continuation-guard.html";
const historicalContinuationGuardResource = workspaceAppResourceResult(descriptorConfig, historicalContinuationGuardUri);
assert.equal(historicalContinuationGuardResource.contents?.[0]?.uri, historicalContinuationGuardUri);
assert.match(historicalContinuationGuardResource.contents?.[0]?.text ?? "", /installContinuationCoordinator/, "historical continuation-guard URI must resolve to the current coordinator");
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
    this.autoEmitAnchorResult = true;
    this.anchorMountToken = "00000000-0000-4000-8000-00000000a001";
    this.anchorMountGeneration = 1;
    this.bindReadyGeneration = undefined;
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
    this.calls.push(input.action);
    this.callInputs.push({ name, ...input });
    this.verifyExistingAnchor();
    if (name === "continuation_sender") {
      assert.equal(input.taskId, this.task?.id);
      assert.equal(input.conversationScopeId, this.task?.conversationScopeId);
      assert.equal(input.anchorMountGeneration, this.anchorMountGeneration);
      if (input.action === "bind") {
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
        return { structuredContent: { accepted: true, lastUiHeartbeatAt: new Date().toISOString() } };
      }
      if (input.action === "claim") {
        const deliveryToken = "00000000-0000-4000-8000-000000000001";
        this.task = {
          ...this.task,
          continuationPending: true,
          continuationCount: 1,
          deliveryToken,
          deliveryOwner: "synthetic-claimed",
        };
        return { structuredContent: { task: this.task, accepted: true, deliveryToken } };
      }
      if (input.action === "authorize-delivery") {
        const accepted = this.task?.deliveryOwner === "synthetic-claimed"
          && this.task?.deliveryToken === input.deliveryToken;
        if (accepted) this.task = { ...this.task, deliveryOwner: "synthetic-delivering" };
        return { structuredContent: { task: this.task, accepted } };
      }
      if (input.action === "delivery-result") {
        const deliveredAt = new Date();
        this.task = {
          ...this.task,
          continuationPending: input.result === "accepted" || input.result === "fallback-accepted",
          continuationDeliveryAwaitingAck: input.result === "accepted" || input.result === "fallback-accepted",
          deliveryOwner: "synthetic-pending",
          lastSendAttemptAt: deliveredAt.toISOString(),
          deliveryAckRetryAfterAt: new Date(deliveredAt.getTime() + 15_000).toISOString(),
        };
        return { structuredContent: { task: this.task, accepted: true } };
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
      if (wakeReady) this.task = { ...this.task, watchProcessHandles: [] };
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
}

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
assert.match(visibleSyntheticText, /继续执行未完成的 DevSpace 任务|Continue the unfinished DevSpace task/,
  "automatic recovery must carry the unfinished DevSpace task intent in the Host-visible user-role turn");
assert.match(visibleSyntheticText, /finish fake task/,
  "the visible continuation trigger must carry the durable objective so a resumed turn does not have to infer which prior task is meant");
assert.match(visibleSyntheticText, /done/,
  "the visible continuation trigger must carry the next unresolved milestone when hidden Host model context is absent");
assert.match(visibleSyntheticText, /continuation_task status/i,
  "the visible continuation trigger must tell the resumed turn how to recover authoritative durable state");
assert.match(visibleSyntheticText, /DevSpace_MCP/i,
  "the visible continuation trigger must preserve the turn-scoped connector discovery recovery path");
assert.match(visibleSyntheticText, /不要只回复状态|do not reply with only a status/i,
  "the visible continuation trigger must explicitly reject status-only premature finals");
assert.match(visibleSyntheticText, /用户角色工作请求|actual user-role work request/i,
  "the visible continuation trigger must identify itself as this turn's actual user-role work request rather than system-only recovery metadata");
assert.match(visibleSyntheticText, /不要把它判定为“系统续接指令”|do not classify it as a system-only continuation instruction/i,
  "the visible continuation trigger must explicitly reject the observed first-resume misclassification");
assert.match(visibleSyntheticText, /不要等待第二次续轮|do not wait for a second continuation/i,
  "the first synthetic turn must be told to start substantive work without waiting for another continuation");
assert.match(visibleSyntheticText, /继续处理中|still working/i,
  "the visible continuation trigger must name the observed placeholder-final failure mode");
assert.doesNotMatch(visibleSyntheticText, /token|UUID|task_fake|ws_fake|authorized recovery/i,
  "the visible Host trigger may name safe recovery actions, including the cached-schema checkpoint compatibility action, but must not expose task/workspace identity or generation capabilities");
assert.match(visibleSyntheticText, /checkpoint[^\n]{0,120}note=atcc-turn-complete/i,
  "the visible Host trigger must expose only the exact reserved checkpoint completion signature needed by Hosts with a cached pre-dev11 schema");
assert.doesNotMatch(visibleSyntheticText, /task_fake|ws_fake|authorized recovery/,
  "durable task/workspace internals must remain out of the visible synthetic message even though the ephemeral resume capability is intentionally visible");
const hiddenSyntheticContext = fakeApp.contextUpdates.at(-1)?.content?.[0]?.text ?? "";
assert.match(hiddenSyntheticContext, /Call continuation_task status first/,
  "hidden model context must request the status claim before substantive work");
assert.match(hiddenSyntheticContext, /server-owned expected synthetic generation/,
  "hidden model context must explain that generation ownership is runtime-managed");
assert.match(hiddenSyntheticContext, /reconstruct the current durable state[\s\S]{0,500}latest available DevSpace evidence/,
  "hidden model context must rebuild task state from durable evidence before choosing the next action");
assert.match(hiddenSyntheticContext, /failure, race, or regression risks[\s\S]{0,500}do not emit a chain-of-thought transcript/,
  "hidden model context must check relevant risks while keeping private reasoning private");
assert.doesNotMatch(hiddenSyntheticContext, /00000000-0000-4000-8000-000000000001|syntheticDeliveryToken|continuationDeliveryToken/,
  "hidden model context must not expose or require generation UUID transport");
assert.ok(fakeApp.calls.includes("begin-auto"));
assert.ok(fakeApp.calls.includes("heartbeat"));
assert.ok(fakeApp.callInputs.some((entry) => entry.name === "continuation_sender" && entry.action === "claim"));
assert.ok(fakeApp.callInputs.some((entry) => entry.name === "continuation_sender" && entry.action === "authorize-delivery"));
assert.ok(fakeApp.calls.includes("delivery-result"));
fakeController.dispose();

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
assert.ok(lateReadyApp.callInputs.some((entry) => entry.name === "continuation_sender" && entry.action === "claim"),
  "late READY delivery must still go through the atomic sender claim path");
lateReadyController.dispose();

const legacyPipApp = new FakeApp();
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
    if (request.name === "continuation_sender"
      && input.action === "authorize-delivery"
      && this.task?.deliveryOwner === "synthetic-claimed") {
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
assert.equal(explicitBindingApp.callInputs.find((entry) => entry.action === "status")?.taskId, "task_explicit");
assert.equal(
  explicitBindingApp.callInputs.some((entry) => entry.name === "continuation_sender" && entry.action === "heartbeat"),
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
    if (request.name === "continuation_task" && input.action === "heartbeat"
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
assert.ok(missingToolResultAnchorApp.callInputs.some((entry) => entry.name === "continuation_sender" && entry.action === "bind"),
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
  (entry) => entry.name === "continuation_sender" && entry.action === "claim",
).length;
await supersededSurfaceController.refreshNow();
assert.equal(supersededSurfaceController.state.anchorSuperseded, true,
  "an old card must retire its visible surface as soon as authoritative status reports a newer generation");
assert.equal(supersededSurfaceController.state.headlessSenderRelay, true,
  "the retired historical card must stay alive only as a headless sender relay");
assert.equal(supersededSurfaceController.state.anchorMountGeneration, 1,
  "headless relay demotion must never mutate the historical iframe into the new visible-card generation");
assert.equal(supersededSurfaceController.state.senderCapability?.anchorMountGeneration, 2,
  "the private sender capability must rebind independently to the current generation");
assert.equal(
  supersededSurfaceApp.callInputs.filter(
    (entry) => entry.name === "continuation_sender" && entry.action === "claim",
  ).length,
  staleClaimCountBeforeRefresh + 1,
  "the headless relay must claim the current READY generation exactly once after generation-safe rebind",
);
assert.equal(supersededSurfaceApp.messages.length, 1,
  "a surviving historical App relay must deliver READY even when the new visible card never ACKed");
assert.equal(supersededSurfaceApp.callInputs.some(
  (entry) => entry.name === "continuation_task" && entry.action === "anchor-mounted"
    && Number(entry.anchorMountGeneration) === 2,
), false, "a headless historical relay must never impersonate the new card's mount ACK");
// Real sender claim atomically removes the READY generation. The fake server
// does not implement the generation table, so clear its synthetic READY fixture
// before verifying that the next supervisor refresh remains exactly-once.
supersededSurfaceApp.statusReadyGeneration = undefined;
supersededSurfaceApp.bindReadyGeneration = undefined;
await supersededSurfaceController.refreshNow();
assert.equal(supersededSurfaceApp.messages.length, 1,
  "repeated headless refreshes must remain exactly-once after the READY generation was claimed");
supersededSurfaceController.dispose();

class FlakyTransportApp extends FakeApp {
  constructor() {
    super();
    this.transientFailuresRemaining = 1;
  }
  async callServerTool({ name, arguments: input }) {
    if (input.action === "status" && this.transientFailuresRemaining > 0) {
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
  (entry) => entry.name === "continuation_sender" && entry.action === "claim",
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
  (entry) => entry.name === "continuation_sender" && entry.action === "claim",
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
  (entry) => entry.name === "continuation_sender" && entry.action === "claim",
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
  (entry) => entry.name === "continuation_sender" && entry.action === "claim",
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
await new Promise((resolvePromise) => setTimeout(resolvePromise, 40));
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
assert.ok(lateProcessWatchApp.calls.includes("resume"), "completed watched process must resume a waiting task before continuation claim");
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
const persistentWakeController = installContinuationCoordinator(persistentWakeApp, {
  supervisorTickMs: 5,
  heartbeatIntervalMs: 25,
  instanceId: "ui_persistent_wake",
});
persistentWakeApp.emit("toolinput", { arguments: { workspaceId: "ws_persistent_wake" } });
await persistentWakeController.onConnected();
await new Promise((resolvePromise) => setTimeout(resolvePromise, 40));
assert.ok(persistentWakeApp.callInputs.some(
  (entry) => entry.name === "continuation_sender" && entry.action === "claim",
), "a sibling iframe must claim a persisted wake without a process handle");
assert.equal(persistentWakeApp.messages.length, 1, "a persisted wake must be deliverable by any surviving iframe");
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
assert.equal(teardownApp.messages.length, 1, "timeout teardown should force one continuation attempt");
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
try {
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
    return mounted;
  }

  const a = runtime.continuationTask({
    action: "begin-auto",
    conversationScopeId: "conversation-a",
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
    conversationScopeId: "conversation-a",
    workspaceId: "ws_shared",
  });
  assert.equal(touchedTaskId, a.task.id);
  const touchedActivity = runtime.continuationTask({ action: "status", taskId: a.task.id });
  assert.ok(Date.parse(touchedActivity.task.lastModelActivityAt) >= Date.parse(modelActivityBefore));
  assert.equal(runtime.continuationSupervisorDirective({
    conversationScopeId: "conversation-a",
    workspaceId: "ws_shared",
  })?.reanchorRequired, true, "automatic Task Contracts must request a supervisor until the open-workspace anchor is live");
  const aVerifiedAnchor = verifyRuntimeAnchor(a, "conversation-a", "ui_test");

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
    conversationScopeId: "conversation-a",
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
  const staleComplete = runtime.continuationTask({
    action: "complete",
    taskId: ghostAnchor.task.id,
    evidence: { work: "done but the issued card never actually mounted" },
  });
  assert.equal(staleComplete.accepted, false);
  assert.equal(staleComplete.reason, "anchor-mount-verification-pending",
    "an unverified card must not be canonically completed as if the user had a working milestone card");

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
    conversationScopeId: "conversation-a",
  });
  assert.equal(exactScopeLookup.task?.id, a.task.id);

  const upgraded = runtime.continuationTask({
    action: "begin",
    taskId: a.task.id,
    conversationScopeId: "conversation-a",
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
    conversationScopeId: "conversation-a",
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
    conversationScopeId: "conversation-a",
    workspaceId: "ws_shared",
  }), undefined, "a fresh supervisor heartbeat must suppress same-turn re-anchor maintenance");

  const completionLeaseRuntime = runtime.continuationTask({
    action: "begin",
    conversationScopeId: "conversation-completion-lease-runtime",
    workspaceId: "ws_completion_lease_runtime",
    requiredMilestones: ["finish"],
  });
  assert.equal(completionLeaseRuntime.task.continuationMode, "completion-driven");
  assert.equal(completionLeaseRuntime.task.maxContinuations, 0);
  assert.equal(completionLeaseRuntime.task.deadlineAt, undefined);
  const completionLeaseMounted = verifyRuntimeAnchor(
    completionLeaseRuntime,
    "conversation-completion-lease-runtime",
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

  const verifiedSurfaceTeardownTask = runtime.continuationTask({
    action: "begin",
    conversationScopeId: "conversation-verified-surface-teardown",
    workspaceId: "ws_verified_surface_teardown",
    requiredMilestones: ["finish"],
  });
  const verifiedSurfaceMounted = verifyRuntimeAnchor(
    verifiedSurfaceTeardownTask,
    "conversation-verified-surface-teardown",
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
    conversationScopeId: "conversation-verified-surface-teardown",
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
  const verifiedTeardownClaim = runtime.continuationTask({
    action: "claim-continuation",
    taskId: verifiedSurfaceTeardownTask.task.id,
    coordinatorInstanceId: "ui_verified_surface_teardown",
    note: "verified surface teardown",
  });
  assert.equal(verifiedTeardownClaim.accepted, true,
    "an unfinished verified current card may continue only after same-turn model completion intent plus Host teardown");
  assert.equal(verifiedTeardownClaim.task.continuationCount, 1);

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
    elapsedMs: 1_549_000,
    note: "user-observed-25m49s",
  });
  assert.equal(confirmedLimit.accepted, true);
  assert.equal(confirmedLimit.reason, "confirmed-turn-limit-recorded");
  assert.equal(confirmedLimit.task.confirmedTurnLimitMs, 1_549_000);
  assert.equal(confirmedLimit.task.confirmedTurnLimitSource, "user-observed-25m49s");
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
  const rejectedWatch = runtime.continuationTask({ action: "watch-process", taskId: a.task.id, processHandle: "build-1" });
  assert.equal(rejectedWatch.accepted, false);
  assert.equal(rejectedWatch.reason, "resident-mode-required",
    "ordinary timeout-recovery work must not gain a process-completion wake source");
  const resident = runtime.continuationTask({
    action: "begin",
    conversationScopeId: "conversation-resident",
    workspaceId: "ws_resident",
    continuationMode: "resident",
    objective: "monitor training across stages",
    requiredMilestones: ["monitor until done"],
  });
  assert.equal(resident.task.continuationMode, "resident");
  verifyRuntimeAnchor(resident, "conversation-resident", "ui_resident_anchor");
  const watched = runtime.continuationTask({ action: "watch-process", taskId: resident.task.id, processHandle: "training-1" });
  assert.equal(watched.accepted, true);
  assert.deepEqual(watched.task.watchProcessHandles, ["training-1"]);
  runtime.database.sqlite.prepare("update continuation_tasks set state='WAITING_EXTERNAL', last_ui_heartbeat_at=? where id=?")
    .run(new Date(Date.now() - 60_000).toISOString(), resident.task.id);
  const residentWaitDirective = runtime.continuationSupervisorDirective({
    conversationScopeId: "conversation-resident",
    workspaceId: "ws_resident",
  });
  assert.equal(residentWaitDirective, undefined,
    "once the visible resident anchor exists, supervisor staleness must stay headless instead of creating a duplicate ChatGPT card");
  runtime.database.sqlite.prepare("update continuation_tasks set state='RUNNING', last_ui_heartbeat_at=null where id=?")
    .run(resident.task.id);
  const residentStage = runtime.continuationTask({ action: "stage-complete", taskId: resident.task.id, note: "epoch review complete" });
  assert.equal(residentStage.accepted, true);
  assert.equal(residentStage.reason, "resident-stage-complete");
  assert.equal(residentStage.task.continuationWakePending, true);
  const rejectedStage = runtime.continuationTask({ action: "stage-complete", taskId: a.task.id });
  assert.equal(rejectedStage.accepted, false);
  assert.equal(rejectedStage.reason, "resident-mode-required");
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
    conversationScopeId: "conversation-budget-reuse",
    workspaceId: "ws_budget_reuse",
  });
  verifyRuntimeAnchor(learnedReuseTask, "conversation-budget-reuse", "ui_reuse");
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
    conversationScopeId: "conversation-supervisor-guard",
    workspaceId: "ws_supervisor_guard",
    continuationMode: "resident",
  });
  const supervisorGuardMounted = verifyRuntimeAnchor(
    supervisorGuard,
    "conversation-supervisor-guard",
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
    conversationScopeId: "conversation-supervisor-guard",
    coordinatorInstanceId: "ui_stale_guard",
  });
  assert.equal(staleOwnerAttempt.task.state, "WAITING_SUPERVISOR",
    "an old/unverified card must not acknowledge another generation's supervisor wait");
  assert.equal(staleOwnerAttempt.task.coordinatorInstanceId, "ui_guard",
    "an old/unverified status poll must not steal coordinator ownership");
  const acknowledgedWait = runtime.continuationTask({
    action: "status",
    taskId: supervisorGuard.task.id,
    conversationScopeId: "conversation-supervisor-guard",
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
    conversationScopeId: "conversation-supervisor-guard",
    coordinatorInstanceId: "ui_guard",
  });
  assert.equal(coordinatorTouch.task.coordinatorInstanceId, "ui_guard");
  assert.ok(coordinatorTouch.task.lastUiHeartbeatAt, "coordinator status polling must count as supervisor liveness");
  assert.equal(coordinatorTouch.task.state, "WAITING_EXTERNAL");
  runtime.continuationTask({ action: "resume", taskId: supervisorGuard.task.id });

  const wake = runtime.continuationTask({
    action: "begin",
    conversationScopeId: "conversation-persistent-wake",
    workspaceId: "ws_persistent_wake_state",
    continuationMode: "resident",
    maxContinuations: 3,
  });
  runtime.continuationTask({ action: "wait", taskId: wake.task.id, note: "external process running" });
  const armedWake = runtime.continuationTask({ action: "arm-wake", taskId: wake.task.id });
  assert.equal(armedWake.task.state, "RUNNING");
  assert.equal(armedWake.task.continuationPending, false);
  assert.equal(armedWake.task.continuationWakePending, true);
  const wakeClaimOne = runtime.continuationTask({ action: "claim-continuation", taskId: wake.task.id });
  assert.equal(wakeClaimOne.accepted, true);
  assert.equal(wakeClaimOne.task.continuationPending, true);
  assert.equal(wakeClaimOne.task.continuationWakePending, true, "a claimed process wake must remain identifiable until delivery succeeds");
  const wakeClaimBlocked = runtime.continuationTask({ action: "claim-continuation", taskId: wake.task.id });
  assert.equal(wakeClaimBlocked.accepted, false);
  assert.equal(wakeClaimBlocked.reason, "continuation-already-pending");
  runtime.database.sqlite.prepare("update continuation_tasks set last_continuation_at=? where id=?")
    .run(new Date(Date.now() - 31_000).toISOString(), wake.task.id);
  const wakeLeaseTakeover = runtime.continuationTask({ action: "claim-continuation", taskId: wake.task.id });
  assert.equal(wakeLeaseTakeover.accepted, true, "a sibling coordinator must be able to take over an expired wake claim lease");
  assert.equal(wakeLeaseTakeover.task.continuationPending, true);
  assert.equal(wakeLeaseTakeover.task.continuationWakePending, true);
  assert.equal(wakeLeaseTakeover.task.continuationCount, 2);
  const wakeRetry = runtime.continuationTask({ action: "release-continuation", taskId: wake.task.id });
  assert.equal(wakeRetry.task.continuationPending, false);
  assert.equal(wakeRetry.task.continuationWakePending, true);
  const wakeClaimTwo = runtime.continuationTask({ action: "claim-continuation", taskId: wake.task.id });
  assert.equal(wakeClaimTwo.accepted, true, "persisted wake retries must bypass the ordinary cooldown");
  assert.equal(wakeClaimTwo.task.continuationCount, 3);
  const wakeDelivered = runtime.continuationTask({
    action: "delivery-result",
    taskId: wake.task.id,
    deliveryResult: "accepted",
    deliveryMethod: "app.sendMessage",
  });
  assert.equal(wakeDelivered.task.continuationPending, true);
  assert.equal(wakeDelivered.task.continuationWakePending, true);
  assert.equal(wakeDelivered.task.continuationDeliveryAwaitingAck, true,
    "host acceptance must keep a wake durable until the resumed model proves DevSpace connectivity");
  const deliveryStillLeased = runtime.continuationTask({ action: "claim-continuation", taskId: wake.task.id });
  assert.equal(deliveryStillLeased.accepted, false);
  assert.equal(deliveryStillLeased.reason, "continuation-delivery-awaiting-ack");
  runtime.database.sqlite.prepare("update continuation_tasks set delivery_ack_retry_after_at=? where id=?")
    .run(new Date(Date.now() - 1_000).toISOString(), wake.task.id);
  const deliveryRetry = runtime.continuationTask({ action: "claim-continuation", taskId: wake.task.id });
  assert.equal(deliveryRetry.accepted, true,
    "an already-authorized delivery-ACK retry must not consume or be blocked by the logical continuation budget");
  assert.equal(deliveryRetry.deliveryAckRetry, true);
  assert.equal(deliveryRetry.task.continuationCount, 3,
    "transport retransmission is the same logical continuation and must not increment continuationCount");

  const ackWake = runtime.continuationTask({
    action: "begin",
    conversationScopeId: "conversation-delivery-ack",
    workspaceId: "ws_delivery_ack",
    continuationMode: "resident",
    requiredMilestones: ["finish after resumed turn"],
    maxContinuations: 4,
  });
  verifyRuntimeAnchor(ackWake, "conversation-delivery-ack", "ui_delivery_ack_anchor");
  runtime.continuationTask({ action: "arm-wake", taskId: ackWake.task.id });
  const ackClaim = runtime.continuationTask({ action: "claim-continuation", taskId: ackWake.task.id });
  assert.equal(ackClaim.accepted, true);
  assert.match(ackClaim.deliveryToken, /^[0-9a-f-]{36}$/i,
    "every logical synthetic continuation must receive a durable delivery token");
  const ackDelivered = runtime.continuationTask({
    action: "delivery-result",
    taskId: ackWake.task.id,
    deliveryResult: "accepted",
    deliveryMethod: "app.sendMessage",
  });
  assert.equal(ackDelivered.task.continuationDeliveryAwaitingAck, true);
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
    conversationScopeId: "conversation-delivery-ack",
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
    conversationScopeId: "conversation-proactive-ack",
    workspaceId: "ws_proactive_ack",
    requiredMilestones: ["finish after timeout recovery"],
    maxContinuations: 4,
  });
  verifyRuntimeAnchor(proactiveAck, "conversation-proactive-ack", "ui_proactive_ack_anchor");
  runtime.continuationTask({
    action: "host-signal",
    taskId: proactiveAck.task.id,
    coordinatorInstanceId: "ui_proactive_ack_anchor",
    hostProfileId: "proactive-timeout@test",
    hostSignal: "timeout",
    elapsedMs: 10_000,
  });
  const proactiveClaim = runtime.continuationTask({ action: "claim-continuation", taskId: proactiveAck.task.id });
  assert.equal(proactiveClaim.accepted, true);
  assert.match(proactiveClaim.deliveryToken, /^[0-9a-f-]{36}$/i);
  assert.equal(proactiveClaim.deliveryGeneration, 1);
  const proactiveDelivered = runtime.continuationTask({
    action: "delivery-result",
    taskId: proactiveAck.task.id,
    deliveryResult: "accepted",
    deliveryMethod: "app.sendMessage",
  });
  assert.equal(proactiveDelivered.task.continuationDeliveryAwaitingAck, true,
    "timeout-triggered continuations must retain a delivery lease until the resumed model reconnects");
  assert.equal(proactiveDelivered.task.continuationWakePending, false,
    "timeout-triggered delivery ACK state must not masquerade as a resident process/stage wake");
  assert.equal(proactiveDelivered.task.deliveryAckRetryCount, 1);
  assert.ok(Date.parse(proactiveDelivered.task.deliveryAckRetryAfterAt) > Date.now(),
    "first accepted synthetic turn must persist a future readiness retry instead of immediately creating another turn");
  const proactiveRetryTooSoon = runtime.continuationTask({
    action: "claim-continuation",
    taskId: proactiveAck.task.id,
    note: "delivery ACK retry",
  });
  assert.equal(proactiveRetryTooSoon.accepted, false);
  assert.equal(proactiveRetryTooSoon.reason, "continuation-delivery-awaiting-ack");
  assert.ok(proactiveRetryTooSoon.retryAfterMs > 0);
  runtime.database.sqlite.prepare(`
    update continuation_tasks
    set delivery_ack_retry_after_at=?, last_host_signal_at=?, last_continuation_at=?
    where id=?
  `).run(
    new Date(Date.now() - 1_000).toISOString(),
    new Date(Date.now() - 5 * 60_000).toISOString(),
    new Date().toISOString(),
    proactiveAck.task.id,
  );
  const proactiveRetryClaim = runtime.continuationTask({
    action: "claim-continuation",
    taskId: proactiveAck.task.id,
    note: "delivery ACK retry",
  });
  assert.equal(proactiveRetryClaim.accepted, true,
    "an unacknowledged synthetic turn must remain retransmittable after the original Host timeout freshness window expires");
  assert.equal(proactiveRetryClaim.deliveryAckRetry, true);
  assert.equal(proactiveRetryClaim.deliveryToken, proactiveClaim.deliveryToken,
    "readiness retransmission must reuse the same synthetic delivery generation token");
  assert.equal(proactiveRetryClaim.deliveryGeneration, proactiveClaim.deliveryGeneration,
    "readiness retransmission must not create a second delivery generation");
  assert.equal(proactiveRetryClaim.task.continuationCount, proactiveClaim.task.continuationCount,
    "connector-readiness retransmission must not count as a second logical continuation");
  const proactiveRedelivered = runtime.continuationTask({
    action: "delivery-result",
    taskId: proactiveAck.task.id,
    deliveryResult: "accepted",
    deliveryMethod: "app.sendMessage",
    note: "delivery ACK retry",
  });
  assert.equal(proactiveRedelivered.task.deliveryAckRetryCount, 2);
  assert.ok(Date.parse(proactiveRedelivered.task.deliveryAckRetryAfterAt) - Date.now() > 20_000,
    "second accepted synthetic delivery must back off longer than the first readiness retry");
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
    conversationScopeId: "conversation-proactive-ack",
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
    conversationScopeId: "conversation-proactive-ack",
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

  const statusOnlyRetryTooEarly = runtime.continuationTask({
    action: "claim-continuation",
    taskId: proactiveAck.task.id,
    note: "synthetic resume work ownership lease expired",
  });
  assert.equal(statusOnlyRetryTooEarly.accepted, false,
    "status-only recovery must not create a second assistant turn while its dedicated synthetic-work ownership lease is still active");
  runtime.database.sqlite.prepare(`
    update continuation_tasks set delivery_owner_expires_at=?, turn_lease_expires_at=? where id=?
  `).run(
    new Date(Date.now() - 1_000).toISOString(),
    new Date(Date.now() + 60_000).toISOString(),
    proactiveAck.task.id,
  );
  const statusOnlyRetry = runtime.continuationTask({
    action: "claim-continuation",
    taskId: proactiveAck.task.id,
    note: "synthetic resume work ownership lease expired",
  });
  assert.equal(statusOnlyRetry.accepted, false,
    "an expired synthetic work-ownership lease alone must not manufacture a second assistant turn while the Host outcome is still unknown");
  runtime.continuationTask({
    action: "host-signal",
    taskId: proactiveAck.task.id,
    coordinatorInstanceId: "ui_proactive_ack_anchor",
    hostProfileId: "synthetic-status-only@test",
    hostSignal: "timeout",
    elapsedMs: 60_000,
  });
  const statusOnlyRetryAfterHostEnd = runtime.continuationTask({
    action: "claim-continuation",
    taskId: proactiveAck.task.id,
    note: "synthetic resume work ownership lease expired",
  });
  assert.equal(statusOnlyRetryAfterHostEnd.accepted, true,
    "a status-only synthetic turn may retry after independent Host timeout evidence proves that the resumed turn ended");
  assert.equal(statusOnlyRetryAfterHostEnd.assistantTurnCompletion, "TIMED_OUT",
    "dev11 must authorize the retry from the exact-turn ATCC timeout state rather than a synthetic owner-lease retry flag");
  assert.notEqual(statusOnlyRetryAfterHostEnd.deliveryToken, proactiveClaim.deliveryToken,
    "status-only recovery must create a new generation so a late failed turn cannot execute in parallel");
  assert.equal(statusOnlyRetryAfterHostEnd.deliveryGeneration, proactiveClaim.deliveryGeneration + 1);
  assert.equal(statusOnlyRetryAfterHostEnd.task.continuationCount, proactiveClaim.task.continuationCount + 1);
  runtime.continuationTask({
    action: "delivery-result",
    taskId: proactiveAck.task.id,
    deliveryResult: "accepted",
    deliveryMethod: "app.sendMessage",
    note: "synthetic resume work ownership lease expired",
  });
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
    conversationScopeId: "conversation-proactive-ack",
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
    conversationScopeId: "conversation-direct-synthetic-work",
    workspaceId: "ws_direct_synthetic_work",
    requiredMilestones: ["perform direct resumed work"],
    maxContinuations: 4,
  });
  verifyRuntimeAnchor(directWork, "conversation-direct-synthetic-work", "ui_direct_work_anchor");
  runtime.continuationTask({
    action: "host-signal",
    taskId: directWork.task.id,
    coordinatorInstanceId: "ui_direct_work_anchor",
    hostProfileId: "direct-work@test",
    hostSignal: "timeout",
    elapsedMs: 10_000,
  });
  const directWorkClaim = runtime.continuationTask({ action: "claim-continuation", taskId: directWork.task.id });
  assert.equal(directWorkClaim.accepted, true);
  runtime.continuationTask({
    action: "delivery-result",
    taskId: directWork.task.id,
    deliveryResult: "accepted",
    deliveryMethod: "app.sendMessage",
  });
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
    conversationScopeId: "conversation-direct-synthetic-work",
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
    conversationScopeId: "conversation-direct-synthetic-work",
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
    conversationScopeId: "conversation-manual-takeover",
    workspaceId: "ws_manual_takeover",
    requiredMilestones: ["finish exactly once"],
    maxContinuations: 4,
  });
  verifyRuntimeAnchor(manualTakeover, "conversation-manual-takeover", "ui_manual_takeover_anchor");
  runtime.continuationTask({
    action: "host-signal",
    taskId: manualTakeover.task.id,
    coordinatorInstanceId: "ui_manual_takeover_anchor",
    hostProfileId: "manual-race@test",
    hostSignal: "timeout",
    elapsedMs: 10_000,
  });
  const manualRaceClaim = runtime.continuationTask({
    action: "claim-continuation",
    taskId: manualTakeover.task.id,
  });
  assert.equal(manualRaceClaim.accepted, true);
  const supersededToken = manualRaceClaim.deliveryToken;
  const manualDelivered = runtime.continuationTask({
    action: "delivery-result",
    taskId: manualTakeover.task.id,
    deliveryResult: "accepted",
    deliveryMethod: "app.sendMessage",
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
  assert.equal(lateSynthetic.continueRequired, false);
  assert.equal(lateSynthetic.finalResponseAllowed, true);

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
    officialAppSendMessagePath: true,
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
    durableSyntheticTurnRetransmission: true,
    syntheticResumeRequiresSubstantiveWork: true,
    syntheticStatusOnlyTurnRecovery: true,
    syntheticControlTrafficNotSubstantive: true,
    syntheticDirectWorkFulfillsPendingGeneration: true,
    syntheticVisibleTriggerRequiresExecution: true,
    residentProcessCompletionWake: true,
    residentStageWake: true,
    nonResidentProcessWakeRejected: true,
    singleContinuationAnchor: true,
    teardownRecoveryPath: true,
    continuationDeliveryDiagnostics: true,
    explicitWallClockExtension: true,
    followUpCompatibilityFallback: true,
    persistentProcessWakeTakeover: true,
    staleSupervisorWaitGuard: true,
    coordinatorStatusLivenessTouch: true,
    supervisorAckWaitHandshake: true,
    continuationResumeAckRetry: true,
    explicitAnchorTaskBinding: true,
    exactTaskConversationIsolation: true,
    historicalContinuationGuardAlias: true,
    domAutomationAbsent: true,
  }));
} finally {
  runtime.close();
  rmSync(stateDir, { recursive: true, force: true });
}
