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
const uiManifest = JSON.parse(readFileSync(join(ROOT, "vendor", "waishnav-devspace", "dist", "ui", ".vite", "manifest.json"), "utf8"));
const workspaceEntry = uiManifest["workspace-app.html"];
assert.ok(workspaceEntry?.file, "workspace-app.html must exist in the Vite manifest");
const workspaceBundle = readFileSync(join(ROOT, "vendor", "waishnav-devspace", "dist", "ui", workspaceEntry.file), "utf8");

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
]) assert.match(migrations, pattern);
assert.match(migrations, /migrated-1\.1\.49/,
  "1.1.50 migration must explicitly identify active legacy 1.1.49 Task Contracts that are upgraded to completion-driven mode");
assert.match(migrations, /contract_version=0[\s\S]{0,500}task_source='legacy'[\s\S]{0,500}continuation_mode='timeout-recovery'[\s\S]{0,500}required_milestones_json/,
  "active 1.1.49 timeout-recovery tasks with real milestones must migrate into the new completion-driven contract instead of remaining on the old P0-prone semantics");
assert.match(migrations, /max_continuations=0[\s\S]{0,500}deadline_at=null[\s\S]{0,700}strftime\([^)]*\+3 minutes/,
  "migrated Task Contracts must start unlimited and receive an initial Turn Lease");

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
  /claim-continuation/,
  /delivery-result/,
  /release-continuation/,
  /WAITING_EXTERNAL/,
  /PAUSED_BY_USER/,
  /continuationPending/,
  /manual recovery/,
  /onTeardown/,
]) assert.match(coordinator, pattern);
assert.doesNotMatch(coordinator, /model activity idle watchdog|DEFAULT_MODEL_IDLE_CONTINUE_MS|modelIdleContinueMs|adaptive host-budget watchdog|explicit long-task silent truncation guard|DEFAULT_EXPLICIT_SILENT_CONTINUE_MS/,
  "legacy generic inactivity and learned-budget watchdogs must stay removed");
assert.match(coordinator, /completionActivityLeaseExpired[\s\S]{0,2200}SUSPECTED_STALL[\s\S]{0,2200}task contract stall corroborated/,
  "completion-driven activity-lease expiry must enter a two-phase suspected-stall path before any continuation delivery");
assert.doesNotMatch(coordinator, /attemptContinuation\("task contract turn lease expired"/,
  "plain activity-lease expiry must never directly create another assistant turn");
assert.match(coordinator, /completionStallArmed[\s\S]{0,1800}CONTINUATION_ARMED/,
  "completion-driven recovery must require persisted corroborated stall state");
assert.match(server, /completion-driven[\s\S]{0,900}timeout-recovery[\s\S]{0,900}resident/,
  "tool contract must expose completion-driven, strict timeout-recovery, and explicit resident modes");
assert.match(server, /maxContinuations[\s\S]{0,260}0 or omitted means unlimited[\s\S]{0,900}wallClockMinutes[\s\S]{0,260}0 or omitted means unlimited/,
  "completion-driven Task Contracts must expose unlimited continuation/wall-clock defaults");
assert.match(server, /completion-driven means required milestones and evidence, not elapsed time, own completion/,
  "completion-driven Task Contracts must remain milestone/evidence-owned instead of becoming timer-owned");
assert.match(server, /"confirm-turn-limit"/,
  "continuation_task must retain the explicit confirm-turn-limit control action");
assert.match(coordinator, /SUSPECTED_STALL[\s\S]{0,2600}CONTINUATION_ARMED/,
  "coordinator recovery must preserve the two-phase suspected/armed stall state machine");
assert.match(coordinator, /CONFIRMED_TURN_LIMIT_TEARDOWN_GRACE_MS/);
assert.match(coordinator, /confirmed turn-limit teardown/);
assert.match(coordinator, /CONFIRMED_TURN_LIMIT_RECOVERY_GRACE_MS/);
assert.match(coordinator, /confirmed turn-limit lease expired/,
  "a user-confirmed real cutoff must have a conservative no-host-signal recovery path after the lower bound expires");
assert.doesNotMatch(coordinator, /attemptContinuation\("task contract resource teardown"/,
  "ordinary resource teardown must fail closed instead of creating another model turn");
assert.match(coordinator, /Resource teardown is not proof that ChatGPT truncated the model turn/,
  "coordinator must document the fail-closed teardown rule explicitly");
assert.match(coordinator, /syntheticDeliveryToken:/,
  "synthetic continuation model context must carry a durable delivery generation token so manual turns can supersede late automatic turns");
assert.match(coordinator, /TRANSIENT_RETRY_DELAYS_MS[\s\S]{0,2200}transientTransportFailure/,
  "Workspace App server calls must retry transient Connection failed/TLS style transport errors with bounded backoff");
assert.match(coordinator, /visibleContinuationTrigger\(task\)[\s\S]{0,1200}不要回复确认、计划、状态说明或“我会继续”[\s\S]{0,900}至少产生一次非控制 DevSpace 工具调用/,
  "the visible synthetic continuation trigger must explicitly require execution instead of permitting a text-only acknowledgement turn");
assert.doesNotMatch(coordinator, /return `继续执行用户尚未完成的 DevSpace 任务/,
  "taskId/workspaceId/recovery policy must not be emitted as a visible user message");
assert.match(coordinator, /function continuationContext\(/,
  "detailed continuation instructions must remain in hidden model context");
assert.match(coordinator, /syntheticDeliveryToken:/,
  "hidden model context must carry the synthetic delivery generation token");
assert.match(coordinator, /NO user-visible response/,
  "synthetic supersession must remain a hidden no-response path instead of leaking internal recovery chatter");
assert.match(coordinator, /claim-continuation[\s\S]{0,3000}updateModelContext[\s\S]{0,2200}deliveryOwner === "synthetic-pending"[\s\S]{0,1800}sendFollowUp\(visibleContinuationTrigger\(state\.task\)\)/,
  "automatic delivery must re-check synthetic ownership immediately before the visible Host trigger");
assert.match(server, /const continuationControlCall = name === "continuation_anchor" \|\| name === "continuation_task"[\s\S]{0,1300}touchContinuationModelActivity\([\s\S]{0,260}substantive: false/,
  "continuation control-plane calls must never count as substantive resumed work");
assert.match(server, /const setupOnlyCall = name === "open_workspace"/,
  "server wrapper must classify open_workspace as setup-only");
assert.match(server, /substantive: !setupOnlyCall/,
  "successful non-control tool completion must provide substantive resumed-work proof while open_workspace does not");
assert.match(coordinator, /text-only acknowledgement[\s\S]{0,500}FAILED recovery[\s\S]{0,900}do NOT prove substantive resumed work/,
  "hidden recovery context must explicitly distinguish control traffic from real resumed work");
assert.match(coordinator, /syntheticResumeWorkRetryDue[\s\S]{0,900}syntheticResumeWorkRequired[\s\S]{0,600}deliveryToken/,
  "the coordinator must retain a durable resumed-turn work obligation after the connectivity ACK");
assert.match(coordinator, /deliveryOwnerExpiresAt[\s\S]{0,900}completionActivityLeaseExpired/,
  "status-only synthetic recovery must prefer its dedicated ownership lease and keep the generic Turn Lease only as a compatibility fallback");
assert.match(coordinator, /synthetic resume work ownership lease expired/,
  "status-only resumed turns must have a dedicated recovery path rather than being treated as successfully completed continuations");
assert.match(coordinator, /deliveryAckRetryDue[\s\S]{0,1500}deliveryAckRetryAfterAt/,
  "delivery ACK retransmission must honor the persisted retry schedule instead of polling new turns every supervisor tick");
assert.match(coordinator, /TRANSIENT_RETRY_DELAYS_MS = \[0, 750, 2_000, 5_000, 8_000, 12_000\]/,
  "post-sendMessage MCP readiness must retain the roughly 30-second bounded retry window");
assert.match(server, /conversation milestone precondition: initial card required[\s\S]{0,900}continuation_anchor exactly once/,
  "substantive workspace work must hard-gate on the one initial visible continuation card");
assert.match(server, /const finalResponseAllowed = outcome\.finalResponseAllowed !== false/,
  "Task Contract rendering must preserve the structured finalResponseAllowed gate");
assert.match(server, /Do not end with an ACK[\s\S]{0,700}same assistant turn[\s\S]{0,700}checkpoint completed milestones/,
  "an unfinished Task Contract must forbid a status-only final response and require same-turn work");
assert.match(server, /nextRequiredMilestones/,
  "Task Contract results must expose remaining milestones as structured state instead of relying on a prose ACK convention");
assert.match(server, /taskIncomplete=\$\{Boolean\(outcome\.taskIncomplete\)\}; finalResponseAllowed=\$\{finalResponseAllowed\}/,
  "ordinary DevSpace work must surface machine-readable task/final-response state while milestones remain");
assert.match(server, /UNAVAILABLE\/Connection failed\/fetch\/ECONN\/TLS\/handshake\/timeout[\s\S]{0,500}readiness backoff/,
  "server guidance must retain bounded transport-readiness retries");
assert.match(server, /Before replaying uncertain side effects[\s\S]{0,300}durable process\/file\/task state/,
  "transport recovery must remain side-effect aware before replaying uncertain mutations");
assert.match(server, /initialAnchorRequired[\s\S]{0,1400}isError: true[\s\S]{0,1400}continuation_anchor exactly once/,
  "the server must block later substantive tools until the initial anchor is mounted instead of merely advising the model");
assert.match(server, /name === "open_workspace"[\s\S]{0,900}initialAnchorRequired[\s\S]{0,1600}MANDATORY NEXT TOOL CALL: continuation_anchor[\s\S]{0,1200}isError: true/,
  "the first headless open_workspace result must hard-require the one visible anchor instead of relying on a soft success hint");
assert.match(server, /anchorToolCallRequired: true/,
  "the first open_workspace response must expose a machine-readable anchor-call requirement");
assert.match(server, /sourceTool: "continuation_task", anchorMounted: false/,
  "headless continuation_task begin must never mark the visible continuation anchor as mounted");
assert.match(server, /sourceTool: "continuation_anchor"[\s\S]{0,180}anchorMounted: false[\s\S]{0,500}prepareContinuationAnchorMount/,
  "the model-side continuation_anchor invocation must issue the single card result and mount token without fabricating actual iframe telemetry");
assert.match(server, /anchorMountToken[\s\S]{0,1400}anchor-mounted/,
  "the continuation tool contract must retain a one-time iframe mount ACK as optional telemetry");
assert.match(coordinator, /anchorSurface:\s*false/,
  "the continuation coordinator must distinguish the dedicated anchor iframe from ordinary Workspace App surfaces");
assert.match(coordinator, /anchorMountToken:\s*undefined/,
  "the continuation coordinator must hold the server-issued one-time mount capability only inside the anchor surface");
assert.match(coordinator, /const mountToken = state\.anchorMountToken[\s\S]{0,500}callTask\("heartbeat",\s*\{\s*note:\s*`anchor-mount-ack:\$\{mountToken\}`\s*\}\)/,
  "the actual continuation_anchor iframe must support an old-schema-compatible token-authenticated heartbeat ACK");
assert.match(coordinator, /callTask\("anchor-mounted",\s*\{\s*anchorMountToken:\s*mountToken\s*\}\)/,
  "the actual continuation_anchor iframe must retain the explicit anchor-mounted ACK as the preferred/new-schema telemetry path");
assert.match(coordinator, /!state\.anchorSurface \|\| !state\.task\?\.anchorMountVerifiedAt/,
  "generic Workspace App cards must not run the continuation supervisor or impersonate the milestone card");
assert.match(server, /anchorMountRequestedAt[\s\S]{0,600}best-effort UI telemetry[\s\S]{0,500}must never re-lock substantive work/,
  "server gating must use the one card issuance as the hard precondition while keeping iframe execution as best-effort telemetry");
assert.match(runtimeStateSource, /initialAnchorRequired:\s*!status\.task\?\.anchorMountRequestedAt/,
  "initial hard gating must clear after the single continuation anchor result is issued, even if the Host never executes its iframe");
assert.match(runtimeStateSource, /if \(row\.anchor_mount_requested_at\)\s*return undefined/,
  "supervisor gating must not request duplicate immutable cards after anchor issuance");
assert.match(runtimeStateSource, /const verifiedAnchorHeartbeat = Boolean\(row\.anchor_mount_verified_at\)/,
  "ordinary liveness maintenance must require an already-verified milestone surface");
assert.match(runtimeStateSource, /coordinatorInstanceId === row\.anchor_mount_coordinator_id/,
  "ordinary liveness maintenance must be bound to the verified milestone coordinator instead of any Workspace App iframe");
assert.match(server, /Later new work reactivates the same taskId with continuation_task action=begin/,
  "server instructions must make the one-card invariant span sequential user tasks, not only one active task epoch");
assert.match(server, /new milestone required on the existing card[\s\S]{0,1000}continuation_task action=begin[\s\S]{0,900}continuation_anchor is NOT needed/,
  "a completed conversation ledger must hard-gate new substantive work until the same taskId is reactivated with a new milestone");
assert.match(server, /continue\/resume reuses unfinished milestones/,
  "continue/resume must reuse unfinished milestones instead of manufacturing duplicate work items");
assert.match(coordinator, /TRANSIENT_RETRY_DELAYS_MS = \[0, 750, 2_000, 5_000, 8_000, 12_000\]/,
  "resumed-turn MCP readiness retry must cover roughly 30 seconds instead of the old ~8-second window");
assert.match(coordinator, /supervisorTickInFlight[\s\S]{0,1200}supervisorTickImpl/,
  "the continuation supervisor must single-flight long retry ticks during network instability");
assert.doesNotMatch(coordinator, /window\.parent\.postMessage|querySelector\([^)]*(?:textarea|composer|send)/i, "continuation must use the connected App rather than raw host/DOM automation");
assert.doesNotMatch(coordinator, /23\s*\*\s*60\s*\*\s*1000|24\.5\s*\*\s*60\s*\*\s*1000|25(?:\.\d+)?\s*\*\s*60\s*\*\s*1000/, "continuation must not depend on a fixed ChatGPT minute limit");
assert.match(workspaceBundle, /window\.__DEVSPACE_MCP_APP__=Y_/);
assert.match(workspaceBundle, /window\.__DEVSPACE_ATTACH_CONTINUATION__\?\.\(Y_\)/);
assert.match(workspaceBundle, /window\.__DEVSPACE_CONTINUATION_CONNECTED__\?\.\(Y_\)/);
assert.match(workspaceBundle, /window\.__DEVSPACE_CONTINUATION_TEARDOWN__\?\.\(Y_,e,t\)/);

const { toolWidgetDescriptorMeta, workspaceAppHtml, workspaceAppResourceResult, workspaceAppUri } = await import(`${pathToFileURL(packagedServerPath).href}?descriptor=${Date.now()}`);
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
const fullWorkspaceMeta = toolWidgetDescriptorMeta({ ...descriptorConfig, widgets: "full" }, "workspace");
assert.equal(fullWorkspaceMeta?._meta?.ui?.resourceUri, anchorUri,
  "widgets=full keeps the explicit compatibility behavior where workspace calls render cards");
assert.equal(fullWorkspaceMeta?._meta?.["openai/outputTemplate"], anchorUri);
assert.notEqual(workspaceAppUri({ ...descriptorConfig, publicBaseUrl: "https://other.example.test" }), anchorUri, "changing the public asset origin must produce a fresh Workspace App URI");
const renderedWorkspaceApp = workspaceAppHtml(descriptorConfig);
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
    this.task = undefined;
    this.autoVerifyAnchor = true;
  }
  verifyExistingAnchor() {
    if (this.task && this.autoVerifyAnchor !== false && !this.task.anchorMountVerifiedAt) {
      this.task = {
        ...this.task,
        anchorMountVerifiedAt: "2026-01-01T00:00:00.000Z",
        anchorMountCoordinatorId: "ui_test_verified_anchor",
      };
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
  }
  getHostContext() {
    return { toolInfo: { tool: { name: "continuation_anchor" } } };
  }
  getHostVersion() {
    return { name: "test-host", version: "1" };
  }
  async callServerTool({ name, arguments: input }) {
    assert.equal(name, "continuation_task");
    this.calls.push(input.action);
    this.callInputs.push({ ...input });
    this.verifyExistingAnchor();
    if (input.action === "begin-auto") {
      this.task ??= {
        id: "task_fake",
        workspaceId: input.workspaceId,
        state: "RUNNING",
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
        this.task = { ...this.task, observedTurnBudgetMs: observed, recommendedContinueAfterMs: Math.floor(observed * 0.88), hostTimeoutSamples: 1 };
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
      return { structuredContent: { task: this.task, accepted: true } };
    }
    if (input.action === "claim-continuation") {
      const deliveryToken = "00000000-0000-4000-8000-000000000001";
      this.task = {
        ...this.task,
        continuationPending: true,
        continuationCount: 1,
        deliveryToken,
        deliveryOwner: "synthetic-pending",
      };
      return { structuredContent: { task: this.task, accepted: true, deliveryToken } };
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
assert.equal(await fakeController.attemptContinuation("unit test", { force: true }), true);
assert.equal(fakeApp.messages.length, 1);
assert.equal(fakeApp.contextUpdates.length >= 1, true);
const visibleSyntheticText = fakeApp.messages[0]?.content?.[0]?.text ?? "";
assert.match(visibleSyntheticText, /继续当前 DevSpace 任务。|Continue the current DevSpace task\./,
  "automatic recovery must still create a localized continuation trigger");
assert.match(visibleSyntheticText, /不要回复确认|Do not reply with an acknowledgement/,
  "the visible continuation trigger must forbid a text-only acknowledgement turn");
assert.match(visibleSyntheticText, /非控制 DevSpace 工具调用|non-control DevSpace tool operation/,
  "the visible continuation trigger must require real non-control DevSpace execution before replying");
assert.doesNotMatch(visibleSyntheticText, /task_fake|ws_fake|deliveryToken|authorized recovery|continuation_task/,
  "internal recovery state must never leak into the visible synthetic message");
const hiddenSyntheticContext = fakeApp.contextUpdates.at(-1)?.content?.[0]?.text ?? "";
assert.match(hiddenSyntheticContext, /syntheticDeliveryToken: 00000000-0000-4000-8000-000000000001/,
  "the delivery token must be carried in hidden model context for the resumed turn");
assert.match(hiddenSyntheticContext, /NO user-visible response/,
  "a superseded late synthetic turn must be instructed to terminate silently");
assert.ok(fakeApp.calls.includes("begin-auto"));
assert.ok(fakeApp.calls.includes("heartbeat"));
assert.ok(fakeApp.calls.includes("claim-continuation"));
assert.ok(fakeApp.calls.includes("delivery-result"));
fakeController.dispose();

class ManualTakeoverBeforeSendApp extends FakeApp {
  async callServerTool(request) {
    const input = request.arguments;
    if (input.action === "status" && this.task?.deliveryOwner === "synthetic-pending") {
      this.task = {
        ...this.task,
        continuationPending: false,
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
assert.ok(explicitBindingApp.calls.includes("heartbeat"));
explicitBindingController.dispose();

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
assert.equal(completionLeaseApp.callInputs.some((entry) => entry.action === "claim-continuation"), false,
  "the first stall phase must not even claim a continuation");
completionLeaseController.dispose();

const completionArmedApp = new FakeApp();
completionArmedApp.task = {
  ...completionLeaseApp.task,
  id: "task_completion_armed",
  workspaceId: "ws_completion_armed",
  stallState: "CONTINUATION_ARMED",
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
  "a corroborated completion-driven stall should resume the persisted task");
assert.equal(completionArmedApp.callInputs.find((entry) => entry.action === "claim-continuation")?.note,
  "task contract stall corroborated");
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
assert.equal(completionTeardownApp.callInputs.some((entry) => entry.action === "claim-continuation"), false,
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
assert.equal(confirmedLeaseElapsedApp.messages.length, 1,
  "after a user-confirmed real cutoff lower bound + grace + model quiet, a surviving Anchor Lease must recover even when the Host omitted formal lifecycle signals");
assert.ok(confirmedLeaseElapsedApp.callInputs.some((entry) => entry.action === "claim-continuation" && /confirmed turn-limit lease expired/i.test(entry.note ?? "")));
confirmedLeaseElapsedController.dispose();

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
assert.equal(pausedApp.calls.includes("claim-continuation"), false, "paused tasks must never be claimed automatically");
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
assert.ok(persistentWakeApp.calls.includes("claim-continuation"), "a sibling iframe must claim a persisted wake without a process handle");
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
assert.equal(confirmedLimitElapsedApp.messages.length, 1,
  "resource teardown may recover only after a user/Owner-confirmed Host turn limit has already elapsed");
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
  function verifyRuntimeAnchor(outcome, conversationScopeId, coordinatorInstanceId = "ui_runtime_verified_anchor") {
    const requested = runtime.prepareContinuationAnchorMount({
      taskId: outcome.task.id,
      conversationScopeId,
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
  assert.deepEqual(secondEpoch.task.requiredMilestones, ["first user task", "second user task"]);
  assert.deepEqual(secondEpoch.task.completedMilestones, ["first user task"]);
  assert.equal(secondEpoch.task.lastAnchorMountedAt, firstAnchorMountedAt,
    "reactivating later user work must preserve the original visible card mount instead of mounting again");
  assert.equal(secondEpoch.task.anchorMountVerifiedAt, firstAnchorVerifiedAt,
    "reactivating later work must preserve the original verified iframe mount instead of requesting a second card");
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
  assert.equal(runtime.continuationSupervisorDirective({
    conversationScopeId: "v1/test-conversation-lifetime-singleton",
    workspaceId: "ws_lifetime_c",
  }), undefined, "reactivated work with an already-mounted card must keep all liveness maintenance headless");

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
  assert.equal(ghostMountRequest.task.anchorMountVerifiedAt, undefined,
    "issuing the one-time token must not fabricate actual iframe mount telemetry");
  const ghostAfterIssuance = runtime.ensureContinuationTaskContract({
    conversationScopeId: "v1/test-ghost-anchor",
    workspaceId: "ws_ghost_anchor",
    sourceTool: "read",
    substantive: true,
  });
  assert.equal(ghostAfterIssuance.initialAnchorRequired, false,
    "once the single UI-bearing anchor result is issued, Host lazy iframe execution must not re-lock substantive work");
  assert.equal(runtime.continuationSupervisorDirective({
    conversationScopeId: "v1/test-ghost-anchor",
    workspaceId: "ws_ghost_anchor",
  }), undefined,
    "anchor issuance must suppress duplicate immutable-card requests even while mount telemetry is absent");
  const ghostCompleted = runtime.continuationTask({
    action: "complete",
    taskId: ghostAnchor.task.id,
    evidence: { work: "done", anchor: "issued; iframe telemetry remains optional" },
  });
  assert.equal(ghostCompleted.task.state, "SUCCEEDED",
    "completion must depend on one-card issuance plus milestone evidence, not Host iframe scheduling");
  assert.equal(ghostCompleted.task.anchorMountVerifiedAt, undefined,
    "completion after issuance must not backfill fake iframe mount telemetry");
  const wrongGhostAck = runtime.continuationTask({
    action: "anchor-mounted",
    taskId: ghostAnchor.task.id,
    conversationScopeId: "v1/test-ghost-anchor",
    coordinatorInstanceId: "ui_real_anchor",
    anchorMountToken: "00000000-0000-4000-8000-000000000099",
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
  const verifiedAt = correctGhostAck.task.anchorMountVerifiedAt;
  const ghostAfterOtherApp = runtime.continuationTask({ action: "status", taskId: ghostAnchor.task.id });
  assert.equal(ghostAfterOtherApp.task.anchorMountVerifiedAt, verifiedAt);
  assert.equal(ghostAfterOtherApp.task.anchorMountCoordinatorId, "ui_real_anchor",
    "a later review/patch iframe must not steal ownership from the one verified milestone card");

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
    "the first independent UI probe after activity-lease expiry should persist SUSPECTED_STALL only");
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
  assert.equal(armedCompletionStall.task.stallState, "CONTINUATION_ARMED",
    "confirmed Host cutoff + quiet window + surviving UI heartbeat should corroborate a suspected stall");
  const armedCompletionClaim = runtime.continuationTask({
    action: "claim-continuation",
    taskId: completionLeaseRuntime.task.id,
    note: "task contract stall corroborated",
  });
  assert.equal(armedCompletionClaim.accepted, true,
    "only a persisted CONTINUATION_ARMED completion-driven task may recover through the stall path");
  assert.equal(armedCompletionClaim.task.continuationCount, 1);
  assert.equal(armedCompletionClaim.task.maxContinuations, 0,
    "unlimited continuation mode must still count resumptions without imposing a terminal maximum");

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
  assert.equal(confirmedElapsedClaim.accepted, true,
    "a teardown may be claimed only after an explicitly confirmed limit plus safety grace has elapsed");

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
  assert.equal(leaseElapsedClaim.accepted, true,
    "the no-host-signal recovery claim must be authorized only after confirmed cutoff + recovery grace + model quiet");
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
    completedMilestones: ["verified"],
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
    completedMilestones: ["follow-up task", "second follow-up"],
    progressFingerprint: "follow-up-milestones-complete",
  });
  assert.deepEqual(checkpointMilestoneIdempotent.task.requiredMilestones,
    ["verified", "follow-up task", "second follow-up"],
    "repeated milestone refinement must not duplicate milestones in the conversation task");
  const completedFromCheckpointEvidence = runtime.continuationTask({
    action: "complete",
    taskId: checkpointEvidenceTask.task.id,
  });
  assert.equal(completedFromCheckpointEvidence.accepted, true,
    "durable checkpoint evidence should satisfy the final evidence gate without forcing the resumed turn to reconstruct it");

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
  runtime.continuationTask({ action: "watch-process", taskId: supervisorGuard.task.id, processHandle: "guard-process" });
  const staleWait = runtime.continuationTask({ action: "wait", taskId: supervisorGuard.task.id, note: "must not wait without a live supervisor" });
  assert.equal(staleWait.accepted, true);
  assert.equal(staleWait.reason, "supervisor-ack-pending");
  assert.equal(staleWait.task.state, "WAITING_SUPERVISOR", "a watched wait must persist intent without pretending the supervisor already acknowledged it");
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
    "resume ACK must reuse the already-mounted resident card instead of creating a duplicate anchor");
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
    "an unfinished resumed Task Contract must reuse its existing visible anchor");
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
  assert.equal(afterControlOnlyTouch.delivery_token, proactiveClaim.deliveryToken,
    "control-plane liveness must leave the active synthetic generation intact");
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
  assert.equal(statusOnlyRetry.accepted, true,
    "a synthetic turn that only ACKed status and failed to do real work must be recoverable when its dedicated work-ownership lease expires even while the generic model Turn Lease remains active");
  assert.equal(statusOnlyRetry.syntheticResumeWorkRetry, true);
  assert.notEqual(statusOnlyRetry.deliveryToken, proactiveClaim.deliveryToken,
    "status-only recovery must create a new generation so a late failed turn cannot execute in parallel");
  assert.equal(statusOnlyRetry.deliveryGeneration, proactiveClaim.deliveryGeneration + 1);
  assert.equal(statusOnlyRetry.task.continuationCount, proactiveClaim.task.continuationCount + 1);
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
    deliveryToken: statusOnlyRetry.deliveryToken,
  });
  assert.equal(retriedModelAck.reason, "continuation-resume-acknowledged");
  assert.equal(retriedModelAck.task.syntheticResumeWorkRequired, true);
  const fulfilledToken = statusOnlyRetry.deliveryToken;
  const touchedAfterResume = runtime.touchContinuationModelActivity({
    workspaceId: "ws_proactive_ack",
    conversationScopeId: "conversation-proactive-ack",
    substantive: true,
  });
  assert.equal(touchedAfterResume, proactiveAck.task.id);
  const fulfilledResume = runtime.continuationTask({ action: "status", taskId: proactiveAck.task.id });
  assert.equal(fulfilledResume.task.syntheticResumeWorkRequired, false,
    "the first substantive non-control DevSpace operation must fulfill the synthetic resumed-turn work obligation");
  assert.equal(fulfilledResume.task.deliveryOwner, "synthetic-worked");
  const lateFulfilledSynthetic = runtime.continuationTask({
    action: "status",
    taskId: proactiveAck.task.id,
    deliveryToken: fulfilledToken,
  });
  assert.equal(lateFulfilledSynthetic.accepted, false);
  assert.equal(lateFulfilledSynthetic.reason, "synthetic-continuation-superseded",
    "once real work fulfills a synthetic generation, duplicate delivery of that old generation must be rejected");

  const directWork = runtime.continuationTask({
    action: "begin",
    conversationScopeId: "conversation-direct-synthetic-work",
    workspaceId: "ws_direct_synthetic_work",
    requiredMilestones: ["perform direct resumed work"],
    maxContinuations: 4,
  });
  runtime.continuationTask({
    action: "host-signal",
    taskId: directWork.task.id,
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
           delivery_ack_retry_count, delivery_ack_retry_after_at
    from continuation_tasks where id=?
  `).get(directWork.task.id);
  assert.equal(afterDirectWork.delivery_owner, "synthetic-worked",
    "a real non-control DevSpace operation must be able to fulfill a synthetic generation even if the model skipped the status ACK");
  assert.equal(Number(afterDirectWork.continuation_pending), 0);
  assert.equal(afterDirectWork.delivery_ack_started_at, null);
  assert.equal(Number(afterDirectWork.delivery_ack_retry_count || 0), 0);
  assert.equal(afterDirectWork.delivery_ack_retry_after_at, null,
    "real work must clear the stale delivery-ACK retry state so the coordinator cannot emit a duplicate continuation");
  assert.equal(afterDirectWork.delivery_token, null);
  assert.equal(afterDirectWork.superseded_delivery_token, directWorkClaim.deliveryToken,
    "real work must supersede the synthetic generation token before clearing it");
  const lateDirectSynthetic = runtime.continuationTask({
    action: "status",
    taskId: directWork.task.id,
    deliveryToken: directWorkClaim.deliveryToken,
  });
  assert.equal(lateDirectSynthetic.accepted, false);
  assert.equal(lateDirectSynthetic.reason, "synthetic-continuation-superseded",
    "a late copy of a generation already fulfilled by direct real work must be rejected");

  const manualTakeover = runtime.continuationTask({
    action: "begin",
    conversationScopeId: "conversation-manual-takeover",
    workspaceId: "ws_manual_takeover",
    requiredMilestones: ["finish exactly once"],
    maxContinuations: 4,
  });
  runtime.continuationTask({
    action: "host-signal",
    taskId: manualTakeover.task.id,
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
  runtime.continuationTask({
    action: "delivery-result",
    taskId: manualTakeover.task.id,
    deliveryResult: "accepted",
    deliveryMethod: "app.sendMessage",
  });
  const manualOwner = runtime.continuationTask({
    action: "status",
    taskId: manualTakeover.task.id,
  });
  assert.equal(manualOwner.accepted, true);
  assert.equal(manualOwner.reason, "manual-turn-took-over",
    "a real/manual model turn that reaches DevSpace without the synthetic token must win the race");
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
