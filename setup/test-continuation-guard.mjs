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
  /registerAppTool\(server, "continuation_task",[\s\S]{0,5200}\.\.\.appCallableToolMeta\(config, "shell"\)/,
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
assert.match(featureTools, /registerAppTool\(server, "session_changes",[\s\S]{0,1200}\.\.\.toolMeta\("review"\)/, "session_changes must stay headless in default changes mode");
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
assert.match(coordinator, /completionTurnLeaseExpired[\s\S]{0,1800}task contract turn lease expired/,
  "completion-driven Task Contracts must have a dedicated Turn Lease fallback instead of the removed generic idle watchdog");
assert.match(coordinator, /Generic inactivity remains disabled outside explicit completion-driven mode/,
  "timeout-recovery/resident modes must remain protected from generic inactivity wakeups");
assert.match(server, /completion-driven[\s\S]{0,900}timeout-recovery[\s\S]{0,900}resident/,
  "tool contract must expose completion-driven, strict timeout-recovery, and explicit resident modes");
assert.match(server, /maxContinuations[\s\S]{0,260}0 or omitted means unlimited[\s\S]{0,900}wallClockMinutes[\s\S]{0,260}0 or omitted means unlimited/,
  "completion-driven Task Contracts must expose unlimited continuation/wall-clock defaults");
assert.match(server, /completion-driven no-progress\/repeated-failure counters are diagnostic warnings only[\s\S]{0,500}must not auto-terminate/,
  "completion-driven Task Contracts must not be closed automatically by progress/failure counters while milestones remain");
assert.match(server, /confirm-turn-limit[\s\S]{0,900}(?:real observed Host cutoff|learned budgets never pre-empt)/,
  "tool contract must reserve confirm-turn-limit for an explicitly observed real Host cutoff and keep learned budgets non-preemptive");
assert.match(coordinator, /CONFIRMED_TURN_LIMIT_TEARDOWN_GRACE_MS/);
assert.match(coordinator, /confirmed turn-limit teardown/);
assert.match(coordinator, /CONFIRMED_TURN_LIMIT_RECOVERY_GRACE_MS/);
assert.match(coordinator, /confirmed turn-limit lease expired/,
  "a user-confirmed real cutoff must have a conservative no-host-signal recovery path after the lower bound expires");
assert.match(coordinator, /task contract resource teardown/,
  "completion-driven Task Contracts must be able to recover a prematurely-ended assistant turn on resource teardown");
assert.match(coordinator, /TRANSIENT_RETRY_DELAYS_MS[\s\S]{0,2200}transientTransportFailure/,
  "Workspace App server calls must retry transient Connection failed/TLS style transport errors with bounded backoff");
assert.match(server, /reanchorRequired=true[\s\S]{0,900}continuation_anchor[\s\S]{0,500}same taskId\/workspaceId/,
  "a resumed or manually recovered assistant turn must re-mount the same continuation task supervisor instead of relying on an old iframe");
assert.match(server, /finalResponseAllowed=false[\s\S]{0,900}same assistant turn[\s\S]{0,1400}nextRequiredMilestones/,
  "a resumed Task Contract must make same-turn work continuation machine-readable instead of relying on a prose ACK convention");
assert.match(server, /Task Contract[\s\S]{0,1200}finalResponseAllowed=false[\s\S]{0,1000}checkpoint/,
  "ordinary DevSpace work must surface a conversation task contract that forbids a status-only final response while milestones remain");
assert.match(server, /transient MCP transport failures[\s\S]{0,900}bounded backoff[\s\S]{0,900}avoid duplicating/,
  "server guidance must make Connection failed/UNAVAILABLE retries bounded and side-effect aware");
assert.match(server, /continuationSupervisorDirective[\s\S]{0,1200}same assistant turn; this is NOT a continuation trigger/,
  "ordinary DevSpace tool results must surface a stale-supervisor re-anchor advisory without creating a new turn");
assert.match(server, /Before the next substantive DevSpace step, call continuation_anchor[\s\S]{0,500}Do not send or infer a new conversation turn/,
  "stale-supervisor maintenance must explicitly re-anchor inside the current assistant turn");
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
assert.equal(workspaceMeta?._meta?.ui?.resourceUri, anchorUri,
  "open_workspace must mount the single Workspace App so ordinary users automatically receive a recovery sender");
assert.equal(workspaceMeta?._meta?.["openai/outputTemplate"], anchorUri);
assert.match(anchorUri, /^ui:\/\/devspace\/workspace-app-[0-9a-f]{16}\.html$/);
assert.equal(anchorMeta?._meta?.ui?.resourceUri, anchorUri);
assert.equal(anchorMeta?._meta?.["openai/outputTemplate"], anchorUri);
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
    if (input.action === "status" || input.action === "heartbeat" || input.action === "delivery-result" || input.action === "release-continuation") {
      return { structuredContent: { task: this.task, accepted: true } };
    }
    if (input.action === "claim-continuation") {
      this.task = { ...this.task, continuationPending: true, continuationCount: 1 };
      return { structuredContent: { task: this.task, accepted: true } };
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
assert.ok(fakeApp.calls.includes("begin-auto"));
assert.ok(fakeApp.calls.includes("heartbeat"));
assert.ok(fakeApp.calls.includes("claim-continuation"));
assert.ok(fakeApp.calls.includes("delivery-result"));
fakeController.dispose();

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
assert.equal(completionLeaseApp.messages.length, 1,
  "an incomplete completion-driven Task Contract must recover when its model Turn Lease expires");
assert.equal(completionLeaseApp.callInputs.find((entry) => entry.action === "claim-continuation")?.note,
  "task contract turn lease expired");
completionLeaseController.dispose();

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
assert.equal(completionTeardownApp.messages.length, 1,
  "completion-driven resource teardown must recover the same unfinished Task Contract even before the Turn Lease expires");
assert.equal(completionTeardownApp.callInputs.find((entry) => entry.action === "claim-continuation")?.note,
  "task contract resource teardown");
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
  turnStartedAt: new Date(Date.now() - 40_000).toISOString(),
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
  assert.equal(a.task.contractVersion, 1);
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
  assert.equal(staleSupervisorStatus.reanchorRequired, true,
    "an unfinished completion-driven task with no live coordinator heartbeat must request a current-turn re-anchor");
  assert.equal(staleSupervisorStatus.continueRequired, true,
    "an unfinished completion-driven task must explicitly require real work after the model-side status ACK");
  assert.deepEqual(staleSupervisorStatus.nextRequiredMilestones, ["tests", "git", "release"]);
  const staleDirective = runtime.continuationSupervisorDirective({
    conversationScopeId: "conversation-a",
    workspaceId: "ws_shared",
  });
  assert.equal(staleDirective?.reanchorRequired, true,
    "an active completion-driven task must surface stale-supervisor maintenance on ordinary model tool activity");
  assert.equal(staleDirective?.taskId, a.task.id);
  assert.equal(staleDirective?.continuationMode, "completion-driven");
  const heartbeat = runtime.continuationTask({ action: "heartbeat", taskId: a.task.id, coordinatorInstanceId: "ui_test" });
  assert.equal(heartbeat.accepted, true);
  assert.ok(heartbeat.task.lastUiHeartbeatAt);
  assert.equal(heartbeat.task.coordinatorInstanceId, "ui_test");
  assert.ok(heartbeat.task.lastAnchorMountedAt);
  assert.ok(heartbeat.task.anchorLeaseExpiresAt);
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
    note: "task contract turn lease expired",
  });
  assert.equal(prematureCompletionLeaseClaim.accepted, false,
    "completion Turn Lease reason text must not be enough before the persisted lease actually expires");
  assert.equal(prematureCompletionLeaseClaim.reason, "continuation-trigger-not-authorized");
  runtime.database.sqlite.prepare("update continuation_tasks set turn_lease_expires_at=? where id=?")
    .run(new Date(Date.now() - 1000).toISOString(), completionLeaseRuntime.task.id);
  const expiredCompletionLeaseClaim = runtime.continuationTask({
    action: "claim-continuation",
    taskId: completionLeaseRuntime.task.id,
    note: "task contract turn lease expired",
  });
  assert.equal(expiredCompletionLeaseClaim.accepted, true,
    "an expired completion-driven model Turn Lease must authorize recovery while milestones remain");
  assert.equal(expiredCompletionLeaseClaim.task.continuationCount, 1);
  assert.equal(expiredCompletionLeaseClaim.task.maxContinuations, 0,
    "unlimited continuation mode must still count resumptions without imposing a terminal maximum");

  const completionTeardownRuntime = runtime.continuationTask({
    action: "begin",
    conversationScopeId: "conversation-completion-teardown-runtime",
    workspaceId: "ws_completion_teardown_runtime",
    requiredMilestones: ["finish"],
  });
  const forgedCompletionTeardown = runtime.continuationTask({
    action: "claim-continuation",
    taskId: completionTeardownRuntime.task.id,
    note: "task contract resource teardown",
  });
  assert.equal(forgedCompletionTeardown.accepted, false,
    "completion-driven teardown recovery must require a fresh persisted Host teardown signal");
  runtime.continuationTask({
    action: "host-signal",
    taskId: completionTeardownRuntime.task.id,
    hostProfileId: "completion-teardown@test",
    hostSignal: "teardown",
    elapsedMs: 30_000,
  });
  const acceptedCompletionTeardown = runtime.continuationTask({
    action: "claim-continuation",
    taskId: completionTeardownRuntime.task.id,
    note: "task contract resource teardown",
  });
  assert.equal(acceptedCompletionTeardown.accepted, true,
    "a fresh resource teardown must authorize recovery only for an unfinished completion-driven Task Contract");

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
  const watched = runtime.continuationTask({ action: "watch-process", taskId: resident.task.id, processHandle: "training-1" });
  assert.equal(watched.accepted, true);
  assert.deepEqual(watched.task.watchProcessHandles, ["training-1"]);
  runtime.database.sqlite.prepare("update continuation_tasks set state='WAITING_EXTERNAL', last_ui_heartbeat_at=? where id=?")
    .run(new Date(Date.now() - 60_000).toISOString(), resident.task.id);
  const residentWaitDirective = runtime.continuationSupervisorDirective({
    conversationScopeId: "conversation-resident",
    workspaceId: "ws_resident",
  });
  assert.equal(residentWaitDirective?.reason, "resident-supervisor-stale",
    "a resident process wait must re-anchor in the current turn if its supervisor dies before the process completes");
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
  assert.equal(learnedBudget.task.confirmedTurnLimitMs, 1_549_000,
    "a shorter timeout sample must not lower an explicitly confirmed no-preemption bound");
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
  assert.equal(learnedReuse.task.confirmedTurnLimitMs, 1_549_000,
    "new tasks on the same Host profile should inherit the explicitly confirmed turn limit");
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
  runtime.database.sqlite.prepare("update continuation_tasks set last_send_attempt_at=? where id=?")
    .run(new Date(Date.now() - 61_000).toISOString(), wake.task.id);
  const deliveryRetry = runtime.continuationTask({ action: "claim-continuation", taskId: wake.task.id });
  assert.equal(deliveryRetry.accepted, false, "the configured continuation budget is already exhausted in this fixture after the retry becomes eligible");
  assert.equal(deliveryRetry.reason, "continuation-budget");

  const ackWake = runtime.continuationTask({
    action: "begin",
    conversationScopeId: "conversation-delivery-ack",
    workspaceId: "ws_delivery_ack",
    continuationMode: "resident",
    requiredMilestones: ["finish after resumed turn"],
    maxContinuations: 4,
  });
  runtime.continuationTask({ action: "arm-wake", taskId: ackWake.task.id });
  const ackClaim = runtime.continuationTask({ action: "claim-continuation", taskId: ackWake.task.id });
  assert.equal(ackClaim.accepted, true);
  const ackDelivered = runtime.continuationTask({
    action: "delivery-result",
    taskId: ackWake.task.id,
    deliveryResult: "accepted",
    deliveryMethod: "app.sendMessage",
  });
  assert.equal(ackDelivered.task.continuationDeliveryAwaitingAck, true);
  const modelAck = runtime.continuationTask({ action: "status", taskId: ackWake.task.id });
  assert.equal(modelAck.accepted, true);
  assert.equal(modelAck.reason, "continuation-resume-acknowledged");
  assert.equal(modelAck.reanchorRequired, true,
    "an unfinished resident task must tell the resumed model to re-mount the same supervisor");
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
  runtime.continuationTask({
    action: "host-signal",
    taskId: proactiveAck.task.id,
    hostProfileId: "proactive-timeout@test",
    hostSignal: "timeout",
    elapsedMs: 10_000,
  });
  const proactiveClaim = runtime.continuationTask({ action: "claim-continuation", taskId: proactiveAck.task.id });
  assert.equal(proactiveClaim.accepted, true);
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
  const proactiveModelAck = runtime.continuationTask({ action: "status", taskId: proactiveAck.task.id });
  assert.equal(proactiveModelAck.reason, "continuation-resume-acknowledged");
  assert.equal(proactiveModelAck.reanchorRequired, true,
    "an unfinished Task Contract must request a fresh Anchor Lease in the resumed turn");
  assert.equal(proactiveModelAck.continueRequired, true,
    "a resumed unfinished task must force real work after the connectivity ACK");
  assert.equal(proactiveModelAck.finalResponseAllowed, false);
  assert.deepEqual(proactiveModelAck.remainingMilestones, ["finish after timeout recovery"]);
  assert.equal(proactiveModelAck.task.continuationDeliveryAwaitingAck, false);
  assert.ok(proactiveModelAck.task.turnStartedAt);
  assert.ok(proactiveModelAck.task.lastModelActivityAt);

  console.log(JSON.stringify({
    persistentTaskState: true,
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
    completionDrivenTurnLeaseRecovery: true,
    completionDrivenTeardownRecovery: true,
    unlimitedCompletionDrivenBudgets: true,
    openWorkspaceAutoAnchor: true,
    explicitHostTimeoutRecovery: true,
    resumedTurnReanchorRequired: true,
    staleSupervisorSameTurnReanchor: true,
    ownerPauseSuppressesAutomation: true,
    timeoutDeliveryResumeAck: true,
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
