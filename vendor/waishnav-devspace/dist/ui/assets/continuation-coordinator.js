const TASK_TOOL = "continuation_task";
const SENDER_TOOL = "continuation_sender";
const ANCHOR_TOOL = "continuation_anchor";
// Increment only when the hidden sender contract changes incompatibly. The
// server rejects all sender actions from older in-memory iframes, so an App
// surface loaded before a live Portable upgrade cannot continue delivering
// continuations using stale semantics.
const CONTINUATION_SENDER_PROTOCOL_EPOCH = 12;
// The server derives this revision from the exact self-contained Workspace App
// resource bytes and injects it before this module executes. Sender authority
// is unavailable when it is missing: silently substituting a server-side value
// would allow a stale cached iframe to masquerade as the current App asset.
const CONTINUATION_SENDER_ASSET_REVISION = String(
  globalThis.__DEVSPACE_CONTINUATION_SENDER_ASSET_REVISION__ ?? "",
).trim();
// Keep completion delivery responsive after the guarded ATCC handoff without
// turning polling into a completion signal.  The runtime still authorizes only
// exact-turn COMPLETED/TIMED_OUT state; this tick merely notices it promptly.
const DEFAULT_SUPERVISOR_TICK_MS = 2_000;
// This module is inlined into the Workspace App HTML. In srcdoc/about:blank
// sandboxes import.meta.url is not a usable network base and may throw before
// any App listener is installed. The server injects the authenticated absolute
// wake endpoint; missing/invalid configuration degrades to timer reconciliation
// instead of aborting coordinator startup.
const CONTINUATION_WAKE_URL = (() => {
  const value = String(globalThis.__DEVSPACE_CONTINUATION_WAKE_URL__ ?? "").trim();
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : undefined;
  } catch {
    return undefined;
  }
})();
const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000;
const DEFAULT_TERMINAL_REFRESH_MS = 60_000;
// Host model-context updates are advisory. They must never hold a synthetic
// generation in CLAIMED indefinitely before the authoritative delivery CAS.
const MODEL_CONTEXT_UPDATE_TIMEOUT_MS = 1_500;
// ChatGPT's native follow-up bridge can expose a thenable that never settles
// even after the invocation has crossed the Host boundary. Waiting forever
// strands an authorized generation in DELIVERING and prevents the durable
// delivery receipt from being recorded. Bound only the settlement wait;
// a timeout must not immediately fire a second payload shape because the first
// Host invocation may already have been accepted.
const DEFAULT_NATIVE_FOLLOW_UP_SETTLEMENT_TIMEOUT_MS = 4_000;
// A resumed ChatGPT turn can be created before its MCP connector has fully
// rehydrated. Retry only the resumed turn's idempotent control call across a
// bounded ten-second readiness window; never resend the visible Host message.
const TRANSIENT_RETRY_DELAYS_MS = [0, 500, 1_500, 3_000, 5_000];

const TERMINAL_STATES = new Set([
  "SUCCEEDED",
  "FAILED_TERMINAL",
  "CANCELLED_BY_USER",
  "ABORTED_NO_PROGRESS",
  "BUDGET_EXHAUSTED",
  "ABANDONED_AUTO_TASK",
]);

function uniqueId() {
  try {
    return `ui_${crypto.randomUUID()}`;
  } catch {
    return `ui_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }
}

function safeProfilePart(value, fallback) {
  const text = String(value ?? "").trim().replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 72);
  return text || fallback;
}

function safeTelemetryName(value) {
  const text = String(value ?? "").trim();
  return /^[A-Za-z0-9._:/-]{1,160}$/.test(text) ? text : undefined;
}

function ownTelemetryKeys(value) {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return [];
  try {
    return Object.getOwnPropertyNames(value).map(safeTelemetryName).filter(Boolean);
  } catch {
    return [];
  }
}

function textFromToolResult(result) {
  return (result?.content ?? [])
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
}

function parseJsonObject(value) {
  if (!value) return undefined;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function normalizeTaskOutcome(result) {
  const structured = result?.structuredContent;
  if (structured && typeof structured === "object") {
    if (structured.task || structured.accepted !== undefined || structured.created !== undefined) return structured;
    const nested = parseJsonObject(structured.result);
    if (nested) return nested;
  }
  return parseJsonObject(textFromToolResult(result)) ?? {};
}

function taskFromResult(params) {
  const structured = params?.structuredContent;
  if (structured?.task && typeof structured.task === "object") return structured.task;
  const nested = parseJsonObject(structured?.result) ?? parseJsonObject(textFromToolResult(params));
  return nested?.task && typeof nested.task === "object" ? nested.task : undefined;
}

function anchorMountFromResult(params) {
  const structured = params?.structuredContent;
  const nested = parseJsonObject(structured?.result) ?? parseJsonObject(textFromToolResult(params)) ?? {};
  const continuationAnchor = structured?.continuationAnchor ?? nested?.continuationAnchor;
  const anchorMountToken = structured?.anchorMountToken ?? nested?.anchorMountToken;
  const rawGeneration = structured?.anchorMountGeneration ?? nested?.anchorMountGeneration;
  const anchorMountGeneration = Number(rawGeneration);
  return {
    continuationAnchor: continuationAnchor === true,
    anchorMountToken: typeof anchorMountToken === "string" ? anchorMountToken : undefined,
    anchorMountGeneration: Number.isFinite(anchorMountGeneration) && anchorMountGeneration > 0
      ? Math.floor(anchorMountGeneration)
      : undefined,
  };
}

function senderCapabilityFromResult(params) {
  const raw = params?._meta?.["devspace/continuation-sender"];
  if (!raw || typeof raw !== "object") return undefined;
  const generation = Number(raw.anchorMountGeneration || 0);
  if (!raw.taskId || !raw.conversationScopeId || !raw.anchorMountToken || !Number.isInteger(generation) || generation <= 0) return undefined;
  return {
    taskId: String(raw.taskId),
    conversationScopeId: String(raw.conversationScopeId),
    workspaceId: raw.workspaceId ? String(raw.workspaceId) : undefined,
    anchorMountToken: String(raw.anchorMountToken),
    anchorMountGeneration: generation,
  };
}

function workspaceFromResult(params) {
  const structured = params?.structuredContent;
  const direct = structured?.workspaceId
    ?? structured?.workspace?.workspaceId
    ?? structured?.workspace?.id
    ?? params?._meta?.card?.workspaceId;
  if (direct) return String(direct);
  const nested = parseJsonObject(structured?.result) ?? parseJsonObject(textFromToolResult(params));
  return nested?.workspaceId ?? nested?.workspace?.workspaceId ?? nested?.workspace?.id;
}

function toolFromContext(context) {
  const name = context?.toolInfo?.tool?.name;
  return typeof name === "string" ? name : undefined;
}

function terminal(task) {
  return !task || TERMINAL_STATES.has(task.state);
}

function automationSuppressed(task) {
  return ["WAITING_EXTERNAL", "WAITING_SUPERVISOR", "PAUSED_BY_USER"].includes(task?.state);
}

function residentTask(task) {
  return task?.continuationMode === "resident";
}

function completionDrivenTask(task) {
  return task?.continuationMode === "completion-driven";
}

function hasUnfinishedMilestones(task) {
  if (!task || terminal(task)) return false;
  const required = Array.isArray(task.requiredMilestones) ? task.requiredMilestones : [];
  // Automatic continuation needs an objective completion gate. An Owner lock
  // protects a task from termination but is not evidence that work remains.
  // Automatic modes should therefore provide at least one required milestone;
  // tasks without milestones can still be resumed manually.
  if (required.length === 0) return false;
  const completed = new Set(Array.isArray(task.completedMilestones) ? task.completedMilestones : []);
  return required.some((milestone) => !completed.has(milestone));
}

function taskElapsedMs(task) {
  const raw = task?.turnStartedAt ?? task?.updatedAt;
  const started = Date.parse(raw || "");
  return Number.isFinite(started) ? Math.max(0, Date.now() - started) : 0;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));
}

function transientTransportFailure(value) {
  const text = String(value?.message ?? value ?? "").toLowerCase();
  return /unavailable|connection failed|network|fetch|econn|socket|tls|ssl|handshake|temporar|timed?\s*out|timeout/.test(text);
}

function transportMethodUnsupported(value) {
  const text = String(value?.message ?? value ?? "").toLowerCase();
  return /method not found|unknown method|not implemented|not supported|unsupported/.test(text);
}

function semanticTransportError(value) {
  if (!value || typeof value !== "object" || value.isError !== true) return undefined;
  const message = textFromToolResult(value).trim()
    || String(value?.error?.message ?? value?.message ?? "Host rejected the message.");
  const error = new Error(message.slice(0, 1000));
  error.code = transportMethodUnsupported(message) ? "METHOD_UNSUPPORTED" : "HOST_REJECTED";
  return error;
}

function deliveryAckRetryDue(task) {
  if (!task?.continuationDeliveryAwaitingAck) return false;
  const retryAt = Date.parse(task.deliveryAckRetryAfterAt || "");
  if (Number.isFinite(retryAt)) return Date.now() >= retryAt;
  const sentAt = Date.parse(task.lastSendAttemptAt || "");
  return !Number.isFinite(sentAt) || Date.now() - sentAt >= 15_000;
}

function completionActivityLeaseExpired(task) {
  if (!completionDrivenTask(task) || task?.state !== "RUNNING" || !hasUnfinishedMilestones(task)) return false;
  const expiresAt = Date.parse(task.turnLeaseExpiresAt || "");
  return Number.isFinite(expiresAt) && Date.now() >= expiresAt;
}

function assistantTurnCompletionArmed(task) {
  return completionDrivenTask(task)
    && task?.state === "RUNNING"
    && hasUnfinishedMilestones(task)
    && ["COMPLETED", "TIMED_OUT"].includes(String(task?.assistantTurnState || "UNKNOWN"))
    && Boolean(task?.turnLeaseId)
    && task?.assistantTurnCompletionLeaseId === task?.turnLeaseId
    && task?.stallState === "CONTINUATION_ARMED";
}

function timeoutRecoveryArmed(task) {
  return task?.continuationMode === "timeout-recovery"
    && task?.state === "RUNNING"
    && hasUnfinishedMilestones(task)
    && task?.assistantTurnState === "TIMED_OUT"
    && Boolean(task?.turnLeaseId)
    && task?.assistantTurnCompletionLeaseId === task?.turnLeaseId
    && task?.stallState === "CONTINUATION_ARMED";
}

function cancellationIsUserAction(reason) {
  const text = String(reason || "");
  return (/(?:user|manual).*(?:cancel|stop|abort)|(?:cancel|stop|abort).*(?:user|manual)/i.test(text))
    && !/timeout|deadline|budget/i.test(text);
}

function isChinese() {
  return typeof navigator !== "undefined" && String(navigator.language || "").toLowerCase().startsWith("zh");
}

function compactContinuationField(value, maxLength = 520) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length <= maxLength ? text : `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

async function updateModelContextBestEffort(app, content) {
  if (!app || typeof app.updateModelContext !== "function") return false;
  let timer;
  try {
    const update = Promise.resolve()
      .then(() => app.updateModelContext({ content }))
      .then(() => true, () => false);
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), MODEL_CONTEXT_UPDATE_TIMEOUT_MS);
    });
    return await Promise.race([update, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function visibleContinuationTrigger(task, deliveryToken) {
  // The native ChatGPT follow-up bridge creates the resumed model turn, so the
  // recovery instruction must survive even when updateModelContext is
  // ignored or not replayed into the resumed model turn. Real Host evidence
  // showed that a bare "继续" can still produce a status-only assistant final.
  // Keep protocol/task ids hidden, but make sustained execution explicit in the
  // actual user-role message that creates the turn.
  // updateModelContext is useful but Host behavior has shown it is not a
  // reliable cross-turn transcript bridge. The synthetic user-role message is
  // the only context that is guaranteed to become part of the resumed turn's
  // visible conversation. Carry the durable objective and next unresolved
  // milestone in that message so the model does not have to guess what
  // "unfinished DevSpace task" refers to when the preceding assistant turn was
  // truncated or its hidden model context was not replayed.
  const objective = compactContinuationField(task?.objective, 620);
  const milestone = compactContinuationField(nextUnresolvedMilestone(task), 420);
  // Live ChatGPT production evidence from dev45 showed that standards-level
  // ui/message can create the resumed user turn while the Host still refuses
  // the model's first continuation_task status with
  // `turn-origin-handshake-required`.  The runtime already supports an exact,
  // one-time deliveryToken ACK path and clears the token as soon as that ACK
  // succeeds.  Carry that generation-bound capability in the user-role handoff
  // so the resumed model can prove its origin on its *first* status call.
  //
  // Keep tokenless server-owned generation claiming in runtime-state as a
  // compatibility path for Hosts that bind turn origin out-of-band.  The
  // visible handoff nevertheless prefers the explicit capability because it is
  // the only form verified to cross the current live Host boundary.
  const handshakeToken = typeof deliveryToken === "string"
    && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/.test(deliveryToken)
    ? deliveryToken
    : "";
  return isChinese()
    ? [
      "@DevSpace MCP 继续执行未完成任务。",
      "这是本轮要立即执行的用户角色工作请求，不是仅供参考的系统续接说明。",
      "继续执行未完成的 DevSpace 任务。",
      objective ? `当前任务：${objective}` : "",
      milestone ? `下一未完成里程碑：${milestone}` : "",
      handshakeToken ? `DevSpace 一次性续轮握手 deliveryToken：${handshakeToken}` : "",
      handshakeToken
        ? "首个 DevSpace 调用必须是 continuation_task action=status，并原样携带上面的 deliveryToken；不要设置 manualTakeover。该 token 只用于本轮首个 status 的 turn-origin/ACK 握手，成功后会立即失效，后续调用不要再携带。"
        : "首个 DevSpace 调用必须是 continuation_task action=status；不要设置 manualTakeover。当前 Host 若提供等价的 turn-origin 绑定，运行时会使用 server-owned expected generation 兼容认领。",
      "如果本轮未直接提供 DevSpace_MCP 工具，先通过连接器工具发现并加载它。自动续轮与手动“继续”拥有相同的完整 Host 思考/执行预算；synthetic 身份、固定分钟数、已学习窗口百分比或已完成一个里程碑都不是停止条件。运行时不使用固定分钟数；如果观察到 Host 窗口缩短或延长，可以重新学习为遥测，但绝不能把它变成主动停止或提前续轮的权限。第一条 DevSpace 调用必须用本消息携带的一次性 deliveryToken 执行 continuation_task action=status 且不得设置 manualTakeover；ACK 后立即继续真实工具工作。手动轮和自动轮都至少需要一次实质 DevSpace 操作以排除空转，但一次操作只是反空转底线，不是本轮结束门槛。一个续轮可以连续完成多个里程碑，只要任务仍可推进，就继续诊断、修改、测试和验证，直到所有里程碑完成、遇到真实外部阻塞/用户暂停、模型明确签署当前阶段边界，或 Host 自己截断。单次命令/测试失败、工具错误、短暂 connector rehydrate、只完成状态检查、少量快速工具调用或只完成一个里程碑都不是主动结束理由。需要合法阶段边界时调用 continuation_task action=turn-complete，并且只有 finalResponseAllowed=true 才能结束；若返回 false 就继续实际工作。当前 schema 没有 turn-complete 时，使用 action=checkpoint 且 note=atcc-turn-complete，并遵守同一判据。不要只复述本消息、不要把它判定为“系统续接指令”、不要只回复状态、进度摘要或“继续处理中”，也不要等待第二次续轮才开始工作。",
    ].filter(Boolean).join("\n")
    : [
      "@DevSpace MCP Continue the unfinished task.",
      "This is the actual user-role work request for this assistant turn, not system-only continuation metadata.",
      "Continue the unfinished DevSpace task.",
      objective ? `Current task: ${objective}` : "",
      milestone ? `Next unfinished milestone: ${milestone}` : "",
      handshakeToken ? `DevSpace one-time continuation handshake deliveryToken: ${handshakeToken}` : "",
      handshakeToken
        ? "The first DevSpace call must be continuation_task action=status with the exact deliveryToken above and without manualTakeover. The token is only for this resumed turn's first turn-origin/ACK handshake; it is invalidated immediately after a successful ACK and must not be reused on later calls."
        : "The first DevSpace call must be continuation_task action=status without manualTakeover. If this Host provides equivalent turn-origin binding out-of-band, the runtime can compatibly claim the server-owned expected generation without a token.",
      "If DevSpace_MCP is not directly exposed in this turn, load it through connector/tool discovery. An automatic resumed turn receives the same full Host reasoning/execution budget and sustained-work stopping rules as a manual 'continue'; do not shorten it merely because it is synthetic. Then, in this same turn, perform substantive DevSpace tool work that advances the next unfinished milestone. A synthetic resumed turn must perform at least four substantive DevSpace operations after its ACK before it may voluntarily sign an unfinished stage boundary. This four-operation floor is only anti-idle evidence, never permission or a target to stop; even after four operations, keep working while runnable milestones remain. The runtime uses no fixed number of minutes and no learned percentage as a synthetic turn duration. Observed shorter or longer Host windows may be relearned as telemetry, never as authority to stop or enqueue early. While milestones remain runnable, keep working across as many milestones as fit until the task completes, becomes genuinely blocked/paused, a genuine model-owned stage boundary is reached after sustained work, or the Host itself truncates the turn. One failed command/test, one tool error, or a few quick tool calls is not a valid reason to voluntarily end the turn; keep diagnosing, fixing, and validating in the same turn. If a genuine stage boundary is necessary, prefer continuation_task action=turn-complete. If it returns finalResponseAllowed=false, keep working. If the current ChatGPT cached schema does not expose turn-complete, use action=checkpoint with note=atcc-turn-complete instead and still require finalResponseAllowed=true. Do not merely restate this message, do not classify it as a system-only continuation instruction, do not stop because the previous message is not visible, tools were not preloaded, or only a status check has completed, do not reply with only a status or 'still working', and do not wait for a second continuation before starting work.",
    ].filter(Boolean).join("\n");
}

function nextUnresolvedMilestone(task) {
  const required = Array.isArray(task?.requiredMilestones) ? task.requiredMilestones : [];
  const completed = new Set(Array.isArray(task?.completedMilestones) ? task.completedMilestones : []);
  return required.find((milestone) => !completed.has(milestone));
}

function continuationContext(task, workspaceId, reason) {
  const nextMilestone = nextUnresolvedMilestone(task);
  const syntheticWorkMustContinue = task?.syntheticWorkMustContinue === true;
  const continueInSameTurn = task?.continueInSameTurn === true;
  const finalResponseAllowed = task?.finalResponseAllowed !== false;
  const lines = [
    "DevSpace durable continuation state:",
    `taskId: ${task?.id ?? "unknown"}`,
    `workspaceId: ${workspaceId ?? task?.workspaceId ?? "unknown"}`,
    `state: ${task?.state ?? "unknown"}`,
    `objective: ${task?.objective ?? "Continue the original DevSpace request."}`,
    `completedMilestones: ${(task?.completedMilestones ?? []).join(" | ") || "none recorded"}`,
    `requiredMilestones: ${(task?.requiredMilestones ?? []).join(" | ") || "none recorded"}`,
    `nextUnresolvedMilestone: ${nextMilestone ?? "none"}`,
    `continuationReason: ${reason}`,
    `syntheticWorkMustContinue: ${syntheticWorkMustContinue}`,
    `continueInSameTurn: ${continueInSameTurn}`,
    `finalResponseAllowed: ${finalResponseAllowed}`,
    "Before acting, reconstruct the current durable state from this Task Contract and the latest available DevSpace evidence. Verify which milestones are actually complete, identify the next unresolved runnable milestone, and check relevant failure, race, or regression risks before choosing the next action. Keep that evaluation internal: do not emit a chain-of-thought transcript, and do not substitute a plan/status-only response for execution.",
    "Tool availability is turn-scoped, not conversation authorization. If the resumed turn does not directly expose the DevSpace_MCP tool namespace, do not stop or claim that DevSpace is unavailable. Use the Host's available connector/tool discovery path first; in ChatGPT, call api_tool.list_resources for DevSpace_MCP (query continuation_task is sufficient), then invoke the discovered DevSpace_MCP tools. Only treat DevSpace as unavailable after that discovery path itself actually fails.",
    "Connector discovery and continuation_task status are control-plane setup, not successful resumed work. After the first status, obey its machine-readable continuation directive: if syntheticWorkMustContinue=true, continueInSameTurn=true, or finalResponseAllowed=false, do not produce a final response after discovery/status, one ordinary tool call, or a checkpoint. In that same assistant turn, keep invoking substantive DevSpace tools that actually advance or verify nextUnresolvedMilestone until the runnable milestone set is completed, genuinely externally blocked, explicitly paused/cancelled, or the Host truncates the turn. A discovery-only/status-only or one-tool-and-final turn is an invalid automatic continuation and must not voluntarily yield.",
    "The Host-visible ui/message that created this resumed turn is the actual user-role work request for this assistant turn, not system-only recovery metadata. The first synthetic turn must start substantive DevSpace work after its control-plane status/discovery setup. Never classify that visible request as 'only a system continuation instruction', merely restate it, or defer real work until a second synthetic continuation.",
    "Call continuation_task status first. If the visible synthetic user-role request carries a one-time deliveryToken, echo that exact token on this first status call and omit manualTakeover; the runtime consumes it immediately when the turn-origin/ACK handshake succeeds. If no token was supplied, the runtime may compatibly claim a server-owned expected generation when the Host provides equivalent origin binding. Never invent, search for, or reuse a token after the first successful status. Then continue substantive work with the same full Host reasoning budget and sustained execution semantics as a manual 'continue': keep reading, editing, executing, validating, and polling owned long-running processes across multiple milestones until the current milestone set is complete, genuinely externally blocked, explicitly paused/cancelled, a genuine model-owned stage boundary is reached after sustained work, or the Host truncates the turn. A synthetic resumed turn must perform at least four substantive DevSpace operations after its ACK before it may voluntarily sign an unfinished stage boundary. This four-operation rule only rejects empty or very short handshake-and-final loops; it is not a target duration or permission to stop. Synthetic duration is never a fixed number of minutes or a learned Host-budget percentage. A checkpoint persists progress but never permits an early final while runnable milestones remain. Reuse the conversation-lifetime taskId and existing process/workspace state. Synthetic continuations reuse the current visible milestone-card generation while the required milestone set is unchanged. If and only if a status/checkpoint reports milestoneCardRequired/reanchorRequired because the synthetic checkpoint changed the required milestone set, issue continuation_anchor exactly once for that new generation; otherwise never create a duplicate card.",
    "Never end an automatically resumed turn with a placeholder/status-only reply such as '继续处理中。', '继续处理。', 'still working', or 'I will continue'. There is no background model execution after a final assistant message. A failed command/test or a small number of quick tool calls is not a legitimate yield boundary. If runnable milestones remain, keep diagnosing and invoking the required tools in this same turn instead of promising future work. If a genuine incomplete-stage boundary is necessary after sustained work, prefer continuation_task action=turn-complete; if it reports finalResponseAllowed=false, continue substantive work. If the current cached schema does not expose that action, use continuation_task action=checkpoint with note=atcc-turn-complete. Do not voluntarily final while the returned finalResponseAllowed is false.",
  ];
  return lines.join("\n");
}

function renderRecoveryStatus(controller, message, tone = "info", allowManual = false) {
  if (typeof document === "undefined") return;
  let node = document.getElementById("devspace-continuation-status");
  if (!node) {
    node = document.createElement("aside");
    node.id = "devspace-continuation-status";
    Object.assign(node.style, {
      position: "static",
      maxWidth: "none",
      margin: "10px 0 0",
      padding: "8px 10px",
      border: "1px solid color-mix(in srgb, currentColor 20%, transparent)",
      borderRadius: "10px",
      background: "Canvas",
      color: "CanvasText",
      boxShadow: "none",
      font: "12px/1.4 system-ui, sans-serif",
    });
    document.body?.append(node);
  }
  node.dataset.tone = tone;
  node.replaceChildren();
  const text = document.createElement("span");
  text.textContent = message;
  node.append(text);
  if (allowManual) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = isChinese() ? "继续任务" : "Continue task";
    Object.assign(button.style, { marginLeft: "8px", cursor: "pointer" });
    button.addEventListener("click", () => void controller.attemptContinuation("manual recovery", { force: true }));
    node.append(button);
  }
}

function publishTaskForCard(task) {
  if (!task || typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("devspace:continuation-task", { detail: task }));
}

export function installContinuationCoordinator(app, options = {}) {
  if (!app || typeof app.addEventListener !== "function") throw new Error("A connected MCP Apps App instance is required.");

  const resourceSurface = typeof window !== "undefined"
    && window.__DEVSPACE_CONTINUATION_SURFACE__
    && typeof window.__DEVSPACE_CONTINUATION_SURFACE__ === "object"
    ? window.__DEVSPACE_CONTINUATION_SURFACE__
    : {};
  const resourceIdentifiesAnchor = resourceSurface.kind === "continuation-anchor";
  const resourceGeneration = Number(resourceSurface.anchorMountGeneration || 0);

  const state = {
    instanceId: options.instanceId ?? uniqueId(),
    connected: false,
    disposed: false,
    currentTool: resourceIdentifiesAnchor ? "continuation_anchor" : undefined,
    currentInput: {},
    workspaceId: undefined,
    task: undefined,
    anchorSurface: resourceIdentifiesAnchor,
    // UI/context may describe the current resource as a continuation anchor,
    // but that is not itself a capability. Track whether this App instance has
    // actually observed anchor resource/tool identity so sender bind cannot
    // upgrade a taskId-only recovery into visible-card authority.
    anchorToolEventObserved: resourceIdentifiesAnchor,
    anchorMountToken: undefined,
    anchorMountGeneration: Number.isInteger(resourceGeneration) && resourceGeneration > 0
      ? resourceGeneration
      : undefined,
    anchorMountAcked: false,
    anchorSuperseded: false,
    // A historical visible card may outlive the manual round that created it.
    // When a newer card generation is issued, collapse only this iframe's UI.
    // Keep the connected App alive as a sender-only relay so a READY generation
    // cannot be stranded merely because ChatGPT delays/omits mounting the new
    // card iframe. Sender bind re-authenticates against the current generation;
    // this flag never grants mount/ACK authority for the new card.
    headlessSenderRelay: false,
    senderCapability: undefined,
    ensuringTask: undefined,
    supervisorTimer: undefined,
    wakeSource: undefined,
    lifecycleRefreshTimer: undefined,
    lifecycleCleanup: undefined,
    lastHeartbeatAt: 0,
    lastTerminalRefreshAt: 0,
    deliveryInFlight: false,
    supervisorTickInFlight: false,
    hostProfileId: undefined,
    hostContext: undefined,
    displayModeRequestInFlight: false,
    hostTelemetry: {
      openaiKeys: new Set(),
      hostContextKeys: new Set(),
      globalsKeys: new Set(),
      parentMethods: new Set(),
      lastFingerprint: "",
      flushTimer: undefined,
      cleanup: undefined,
    },
  };
  const supervisorTickMs = Math.max(250, Number(options.supervisorTickMs ?? DEFAULT_SUPERVISOR_TICK_MS));
  const heartbeatIntervalMs = Math.max(supervisorTickMs, Number(options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS));
  const terminalRefreshMs = Math.max(supervisorTickMs, Number(options.terminalRefreshMs ?? DEFAULT_TERMINAL_REFRESH_MS));
  const nativeFollowUpSettlementTimeoutMs = Math.max(1,
    Number(options.nativeFollowUpSettlementTimeoutMs ?? DEFAULT_NATIVE_FOLLOW_UP_SETTLEMENT_TIMEOUT_MS));
  const timersEnabled = options.timers !== false;

  function acceptTask(task) {
    if (!task || typeof task !== "object") return;
    state.task = task;
    const authoritativeGeneration = Math.max(0, Number(state.task?.anchorMountGeneration || 0));
    const surfaceGeneration = Math.max(0, Number(state.anchorMountGeneration || 0));
    if (surfaceGeneration > 0 && authoritativeGeneration > surfaceGeneration) {
      // Never publish a newer generation into an older immutable card. Doing
      // so makes the historical card briefly display the next manual round
      // before it is demoted, which presents as a visible UI twitch. Freeze
      // this card at its own last snapshot and retire only its coordinator
      // authority; the App instance may remain alive as a private sender relay.
      markAnchorSuperseded(authoritativeGeneration);
    } else {
      publishTaskForCard(state.task);
    }
    if (terminal(state.task)) {
      state.lastTerminalRefreshAt = Date.now();
      stopSupervisor();
      stopLifecycleRefresh();
    }
  }

  function activeSenderCapability() {
    const authoritativeGeneration = Math.max(0, Number(state.task?.anchorMountGeneration || 0));
    if (state.senderCapability?.taskId === state.task?.id
      && state.senderCapability?.conversationScopeId === state.task?.conversationScopeId
      && (!authoritativeGeneration
        || Number(state.senderCapability?.anchorMountGeneration || 0) === authoritativeGeneration)) {
      return state.senderCapability;
    }
    if (!state.anchorSuperseded
      && state.anchorSurface && state.task?.id && state.task?.conversationScopeId
      && state.anchorMountToken && state.anchorMountGeneration
      && (!authoritativeGeneration || Number(state.anchorMountGeneration) === authoritativeGeneration)) {
      return {
        taskId: state.task.id,
        conversationScopeId: state.task.conversationScopeId,
        workspaceId: state.workspaceId,
        anchorMountToken: state.anchorMountToken,
        anchorMountGeneration: state.anchorMountGeneration,
      };
    }
    return undefined;
  }

  function senderTransportAvailable() {
    // Card issuance, not iframe ACK, owns the durable sender capability. A
    // missing/delayed ACK must not disable a newer ordinary Workspace App from
    // acting as the continuation transport for the already-issued generation.
    return Boolean(CONTINUATION_SENDER_ASSET_REVISION
      && state.connected
      && (state.task?.anchorMountRequestedAt || state.task?.anchorMountVerifiedAt)
      && activeSenderCapability());
  }

  async function syncPersistentDisplayMode() {
    if (state.disposed || !state.connected || !state.anchorSurface || typeof app.requestDisplayMode !== "function") return;
    if (state.displayModeRequestInFlight) return;
    const context = state.hostContext ?? app.getHostContext?.() ?? {};
    const available = Array.isArray(context?.availableDisplayModes) ? context.availableDisplayModes : [];
    // Keep the milestone surface in the normal ChatGPT transcript. Host PiP is
    // visually intrusive and also makes a conversation-lifetime card look like
    // a global floating controller. We never opt into PiP. If an older build
    // already left this surface in PiP, explicitly return it to inline mode.
    const requestedMode = context?.displayMode === "pip" && available.includes("inline")
      ? "inline"
      : undefined;
    if (!requestedMode || context?.displayMode === requestedMode) return;
    state.displayModeRequestInFlight = true;
    try {
      const result = await app.requestDisplayMode({ mode: requestedMode });
      if (result?.mode) {
        state.hostContext = { ...(state.hostContext ?? context), displayMode: result.mode };
      }
    } catch {
      // Display mode is a Host-owned progressive enhancement. Failure or Host
      // refusal must never block the continuation state machine itself.
    } finally {
      state.displayModeRequestInFlight = false;
    }
  }

  function buildHostProfileId() {
    const info = app.getHostVersion?.() ?? {};
    return `${safeProfilePart(info.name, "unknown-host")}@${safeProfilePart(info.version, "unknown-version")}`;
  }

  function addTelemetryNames(target, values) {
    let changed = false;
    for (const value of values ?? []) {
      const safe = safeTelemetryName(value);
      if (!safe || target.has(safe) || target.size >= 128) continue;
      target.add(safe);
      changed = true;
    }
    return changed;
  }

  function hostTelemetryPayload() {
    const sorted = (set) => [...set].sort();
    return {
      openaiKeys: sorted(state.hostTelemetry.openaiKeys),
      hostContextKeys: sorted(state.hostTelemetry.hostContextKeys),
      globalsKeys: sorted(state.hostTelemetry.globalsKeys),
      parentMethods: sorted(state.hostTelemetry.parentMethods),
    };
  }

  async function flushHostTelemetry() {
    if (state.disposed || !state.connected || !senderTransportAvailable()) return false;
    const payload = hostTelemetryPayload();
    const fingerprint = JSON.stringify(payload);
    if (fingerprint === state.hostTelemetry.lastFingerprint) return false;
    const outcome = await callSender("telemetry", { telemetry: payload }).catch(() => undefined);
    if (!outcome?.accepted) return false;
    state.hostTelemetry.lastFingerprint = fingerprint;
    return true;
  }

  function scheduleHostTelemetryFlush() {
    if (state.hostTelemetry.flushTimer || state.disposed) return;
    state.hostTelemetry.flushTimer = setTimeout(() => {
      state.hostTelemetry.flushTimer = undefined;
      void flushHostTelemetry();
    }, 250);
  }

  function collectOpenAiTelemetry() {
    if (typeof window === "undefined") return;
    if (addTelemetryNames(state.hostTelemetry.openaiKeys, ownTelemetryKeys(window.openai))) {
      scheduleHostTelemetryFlush();
    }
  }

  function startHostTelemetryObserver() {
    if (state.hostTelemetry.cleanup || typeof window === "undefined" || typeof window.addEventListener !== "function") return;
    const onParentMessage = (event) => {
      if (event?.source !== window.parent) return;
      const method = safeTelemetryName(event?.data?.method);
      if (method && addTelemetryNames(state.hostTelemetry.parentMethods, [method])) scheduleHostTelemetryFlush();
    };
    const onOpenAiGlobals = (event) => {
      const detail = event?.detail?.globals ?? event?.detail;
      if (addTelemetryNames(state.hostTelemetry.globalsKeys, ownTelemetryKeys(detail))) scheduleHostTelemetryFlush();
      collectOpenAiTelemetry();
    };
    window.addEventListener("message", onParentMessage);
    window.addEventListener("openai:set_globals", onOpenAiGlobals);
    state.hostTelemetry.cleanup = () => {
      window.removeEventListener?.("message", onParentMessage);
      window.removeEventListener?.("openai:set_globals", onOpenAiGlobals);
      if (state.hostTelemetry.flushTimer) clearTimeout(state.hostTelemetry.flushTimer);
      state.hostTelemetry.flushTimer = undefined;
    };
    collectOpenAiTelemetry();
  }

  async function callTask(action, extra = {}) {
    if (!state.connected) throw new Error("DevSpace Workspace App is not connected to the host yet.");
    let lastError;
    for (let attempt = 0; attempt < TRANSIENT_RETRY_DELAYS_MS.length; attempt += 1) {
      if (TRANSIENT_RETRY_DELAYS_MS[attempt] > 0) await sleep(TRANSIENT_RETRY_DELAYS_MS[attempt]);
      try {
        const useAnchorBridge = state.anchorSurface;
        const taskId = state.task?.id ?? state.currentInput?.taskId;
        const result = await app.callServerTool({
          name: useAnchorBridge ? ANCHOR_TOOL : TASK_TOOL,
          arguments: {
            ...(useAnchorBridge ? { bridgeAction: `task-${action}` } : { action }),
            ...(taskId ? { taskId: String(taskId) } : {}),
            ...(state.workspaceId ? { workspaceId: state.workspaceId } : {}),
            ...(useAnchorBridge && state.anchorMountGeneration
              ? { anchorMountGeneration: Number(state.anchorMountGeneration) }
              : {}),
            coordinatorInstanceId: state.instanceId,
            ...extra,
            // `extra` is intentionally before this marker. No internal caller
            // may turn a coordinator control-plane status back into the model's
            // mutating first-turn ACK by passing readOnlyStatus:false.
            ...(action === "status" ? { readOnlyStatus: true } : {}),
          },
        });
        if (result?.isError && transientTransportFailure(textFromToolResult(result))) {
          throw new Error(textFromToolResult(result) || "Transient MCP transport failure");
        }
        const outcome = normalizeTaskOutcome(result);
        if (outcome?.task) acceptTask(outcome.task);
        return outcome;
      } catch (error) {
        lastError = error;
        if (!transientTransportFailure(error) || attempt === TRANSIENT_RETRY_DELAYS_MS.length - 1) throw error;
      }
    }
    throw lastError ?? new Error("DevSpace continuation transport retry exhausted.");
  }

  async function callSender(action, extra = {}, { rebindAttempted = false } = {}) {
    if (!state.connected) throw new Error("DevSpace Workspace App is not connected to the host yet.");
    let capability = activeSenderCapability();
    if (!capability) {
      return { accepted: false, reason: "sender-capability-unavailable" };
    }
    let lastError;
    for (let attempt = 0; attempt < TRANSIENT_RETRY_DELAYS_MS.length; attempt += 1) {
      if (TRANSIENT_RETRY_DELAYS_MS[attempt] > 0) await sleep(TRANSIENT_RETRY_DELAYS_MS[attempt]);
      try {
        const useAnchorBridge = state.anchorSurface;
        const result = await app.callServerTool({
          name: useAnchorBridge ? ANCHOR_TOOL : SENDER_TOOL,
          arguments: {
            ...(useAnchorBridge ? { bridgeAction: `sender-${action}` } : { action }),
            senderProtocolEpoch: CONTINUATION_SENDER_PROTOCOL_EPOCH,
            senderAssetRevision: CONTINUATION_SENDER_ASSET_REVISION,
            taskId: capability.taskId,
            conversationScopeId: capability.conversationScopeId,
            senderInstanceId: state.instanceId,
            anchorMountToken: capability.anchorMountToken,
            anchorMountGeneration: capability.anchorMountGeneration,
            ...extra,
            // The epoch is a server-owned compatibility boundary, not an
            // overridable caller option. The asset revision is the matching
            // immutable resource identity and is equally non-overridable.
            senderProtocolEpoch: CONTINUATION_SENDER_PROTOCOL_EPOCH,
            senderAssetRevision: CONTINUATION_SENDER_ASSET_REVISION,
          },
        });
        if (result?.isError && transientTransportFailure(textFromToolResult(result))) {
          throw new Error(textFromToolResult(result) || "Transient MCP transport failure");
        }
        const outcome = normalizeTaskOutcome(result);
        // MCP service restart deliberately invalidates every process-local
        // sender lease while a ChatGPT iframe can survive with the same issued
        // card capability.  Do not weaken that restart fence and do not grant
        // mount/ACK authority to an unverified card.  Instead, if any normal
        // sender operation proves that its server-side lease needs rebinding,
        // run the authenticated bind path and retry the exact operation once.
        //
        // This recovery belongs here rather than only in heartbeat(): a current
        // anchor whose iframe mount ACK is still pending is intentionally barred
        // from sender heartbeat, yet it may be the only surviving transport when
        // ATCC later exposes a durable READY generation.  In dev53 that ordering
        // left READY unclaimed until manual takeover.  bindContinuationSender
        // revalidates protocol epoch, task/conversation identity and the current
        // immutable card generation, so stale/manual-superseded capabilities
        // remain fail-closed.
        if (!rebindAttempted && outcome?.accepted === false && outcome?.reason === "sender-rebind-required") {
          const rebound = await bindSenderTransport().catch(() => undefined);
          if (!rebound?.accepted) return outcome;
          capability = activeSenderCapability();
          if (!capability) return { accepted: false, reason: "sender-capability-unavailable-after-rebind" };
          return callSender(action, extra, { rebindAttempted: true });
        }
        return outcome;
      } catch (error) {
        lastError = error;
        if (!transientTransportFailure(error) || attempt === TRANSIENT_RETRY_DELAYS_MS.length - 1) throw error;
      }
    }
    throw lastError ?? new Error("DevSpace continuation sender retry exhausted.");
  }

  async function bindSenderTransport() {
    if (!state.connected || typeof app.callServerTool !== "function") return undefined;
    // A freshly connected ordinary Workspace App can enter here before its
    // one-shot toolresult has populated state.task.  Do not classify that
    // pre-hydration state as terminal: the server can authenticate the App's
    // MCP conversation scope and recover the current lifetime task/card
    // capability from that trusted scope alone.  Once an actual task object is
    // known, keep the existing terminal fence fail-closed.
    if (state.task && terminal(state.task)) return { accepted: false, reason: "task-terminal" };
    let lastError;
    for (let attempt = 0; attempt < TRANSIENT_RETRY_DELAYS_MS.length; attempt += 1) {
      if (TRANSIENT_RETRY_DELAYS_MS[attempt] > 0) await sleep(TRANSIENT_RETRY_DELAYS_MS[attempt]);
      try {
        const useAnchorBridge = state.anchorSurface;
        const result = await app.callServerTool({
          name: useAnchorBridge ? ANCHOR_TOOL : SENDER_TOOL,
          arguments: {
            ...(useAnchorBridge ? { bridgeAction: "sender-bind" } : { action: "bind" }),
            senderProtocolEpoch: CONTINUATION_SENDER_PROTOCOL_EPOCH,
            senderAssetRevision: CONTINUATION_SENDER_ASSET_REVISION,
            senderInstanceId: state.instanceId,
            ...(state.task?.id ? { taskId: state.task.id } : {}),
            ...(state.task?.conversationScopeId ? { conversationScopeId: state.task.conversationScopeId } : {}),
            ...(state.task?.anchorMountGeneration
              ? { anchorMountGeneration: Number(state.task.anchorMountGeneration) }
              : state.anchorMountGeneration ? { anchorMountGeneration: Number(state.anchorMountGeneration) } : {}),
          },
        });
        if (result?.isError && transientTransportFailure(textFromToolResult(result))) {
          throw new Error(textFromToolResult(result) || "Transient MCP transport failure");
        }
        const outcome = normalizeTaskOutcome(result);
        const generation = Number(outcome?.anchorMountGeneration || 0);
        if (outcome?.accepted && outcome?.taskId && outcome?.conversationScopeId
          && outcome?.anchorMountToken && Number.isInteger(generation) && generation > 0) {
          state.senderCapability = {
            taskId: String(outcome.taskId),
            conversationScopeId: String(outcome.conversationScopeId),
            workspaceId: outcome.workspaceId ? String(outcome.workspaceId) : undefined,
            anchorMountToken: String(outcome.anchorMountToken),
            anchorMountGeneration: generation,
          };
          // ChatGPT can mount the visible continuation_anchor iframe while
          // omitting the one-shot toolresult event. In that ordering,
          // ensureTask() runs first and cannot ACK because it has no mount
          // capability yet; the private sender bind that follows is the first
          // place this same anchor App learns the authoritative token. Recover
          // that capability only on the actual anchor surface. Ordinary relay
          // Apps may keep senderCapability, but they must never impersonate a
          // visible milestone-card ACK.
          if (state.anchorToolEventObserved
            && state.anchorSurface && state.currentTool === "continuation_anchor") {
            const knownSurfaceGeneration = Math.max(0, Number(state.anchorMountGeneration || 0));
            if (knownSurfaceGeneration > 0 && generation > knownSurfaceGeneration) {
              markAnchorSuperseded();
            } else if (!knownSurfaceGeneration || knownSurfaceGeneration === generation) {
              state.anchorMountToken = String(outcome.anchorMountToken);
              state.anchorMountGeneration = generation;
            }
          }
          if (outcome.workspaceId) state.workspaceId = String(outcome.workspaceId);
          if (outcome.task) acceptTask(outcome.task);
        }
        return outcome;
      } catch (error) {
        lastError = error;
        if (!transientTransportFailure(error) || attempt === TRANSIENT_RETRY_DELAYS_MS.length - 1) throw error;
      }
    }
    throw lastError ?? new Error("DevSpace continuation sender bind retry exhausted.");
  }

  async function consumeRecoveryAfterSenderBind(
    outcome,
    readyReason = "sender transport rebound with READY generation",
    _ackRetryReason = "sender transport rebound with overdue delivery ACK retry",
  ) {
    if (!outcome?.accepted) return false;
    const readyGeneration = Number(outcome?.readyGeneration || 0);
    if (Number.isInteger(readyGeneration) && readyGeneration > 0) {
      // Do not wait for the old milestone iframe's five-second supervisor tick.
      // A newly mounted ordinary Workspace App is the recovery transport: once
      // bind proves the same conversation/card capability and the server reports
      // a durable READY generation, consume it immediately. Generation claim is
      // atomic, so concurrent sibling Apps safely lose the claim instead of
      // sending duplicate visible continuations.
      return attemptContinuation(readyReason, { force: true });
    }

    // A Host-accepted message with no model ACK is outcome-uncertain. Its
    // deadline is a startup-health signal only; retransmitting a visible user
    // message can interrupt a model that started slowly or create a duplicate
    // turn. Recovery waits for a real Host receipt/status capability, manual
    // takeover, or the original turn's idempotent ACK.
    return false;
  }

  function stopSupervisor() {
    if (state.supervisorTimer) clearInterval(state.supervisorTimer);
    state.supervisorTimer = undefined;
  }

  function stopLifecycleRefresh() {
    if (state.lifecycleRefreshTimer) clearTimeout(state.lifecycleRefreshTimer);
    state.lifecycleRefreshTimer = undefined;
    state.lifecycleCleanup?.();
    state.lifecycleCleanup = undefined;
  }

  function scheduleAuthoritativeRefresh(reason = "app lifecycle resume") {
    if (state.disposed || terminal(state.task) || !state.task?.id) return;
    // A superseded visible card is still allowed to refresh as a headless
    // sender relay. It may temporarily have no current-generation capability;
    // supervisorTick() will rebind it before any sender claim is attempted.
    if (!state.anchorSuperseded && !senderTransportAvailable()) return;
    if (state.lifecycleRefreshTimer) return;
    state.lifecycleRefreshTimer = setTimeout(() => {
      state.lifecycleRefreshTimer = undefined;
      void supervisorTick({ forceAuthoritative: true }).catch(() => undefined);
    }, 0);
  }

  function startLifecycleRefresh() {
    if (terminal(state.task) || state.lifecycleCleanup || typeof window === "undefined") return;
    const listeners = [];
    const add = (target, name, handler, options) => {
      target?.addEventListener?.(name, handler, options);
      listeners.push(() => target?.removeEventListener?.(name, handler, options));
    };
    const refresh = () => scheduleAuthoritativeRefresh("app lifecycle resume");
    const visibility = () => {
      if (typeof document === "undefined" || document.visibilityState === "visible") refresh();
    };
    add(window, "pageshow", refresh);
    add(window, "focus", refresh);
    add(window, "online", refresh);
    add(window, "pointerdown", refresh, { passive: true });
    if (typeof document !== "undefined") add(document, "visibilitychange", visibility);
    let observer;
    if (typeof IntersectionObserver !== "undefined" && typeof document !== "undefined" && document.documentElement) {
      observer = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) refresh();
      });
      observer.observe(document.documentElement);
    }
    state.lifecycleCleanup = () => {
      for (const remove of listeners) remove();
      observer?.disconnect?.();
    };
  }

  function markAnchorSuperseded(authoritativeGeneration) {
    if (state.anchorSuperseded) return;
    state.anchorSuperseded = true;
    state.headlessSenderRelay = true;
    state.anchorMountToken = undefined;
    state.anchorMountAcked = false;
    // Do not stop the supervisor/lifecycle loop. The old *coordinator
    // authority* is retired, but its already-connected App remains a transport
    // relay. Keep the immutable historical card visible as a frozen snapshot:
    // clearing document.body leaves ChatGPT's outer widget shell behind as a
    // large blank card, and forcing height=0 races the Host's async size cache.
    // The dedicated event lets the renderer label the frozen snapshot without
    // accepting the newer generation's task payload.
    if (typeof document !== "undefined") {
      document.documentElement?.setAttribute?.("data-devspace-anchor-superseded", "true");
      window.dispatchEvent(new CustomEvent("devspace:continuation-superseded", {
        detail: {
          surfaceGeneration: Number(state.anchorMountGeneration || 0),
          authoritativeGeneration: Number(authoritativeGeneration || state.task?.anchorMountGeneration || 0),
        },
      }));
    }
  }

  async function heartbeat(note = "workspace-app") {
    if (!senderTransportAvailable() || !state.task?.id || terminal(state.task)) return;
    state.lastHeartbeatAt = Date.now();
    // Sender authority is process-local and is deliberately cleared whenever
    // the MCP server restarts. A verified lifetime card, however, can remain
    // mounted in ChatGPT across that restart. The heartbeat itself is
    // intentionally fail-closed and cannot recreate sender authority; when the
    // server explicitly reports sender-rebind-required, escalate to the normal
    // authenticated bind path so the surviving iframe can recover without
    // waiting for another Host onConnected()/toolresult event. The bind path
    // revalidates protocol epoch, immutable asset revision, task/card identity,
    // mount token, and generation, so this does not weaken the restart fence.
    // A bare taskId-only recovery can locate the lifetime task, but without a
    // concrete Host tool identity it is not proof that this iframe owns an App
    // sender transport. Real anchor surfaces and ordinary named tool relays do
    // carry that identity; anonymous recovery must remain read-only here.
    const senderHeartbeatAuthorized = state.headlessSenderRelay
      || (state.currentTool && (!state.anchorSurface || state.anchorMountAcked));
    if (senderHeartbeatAuthorized) {
      const senderHeartbeat = await callSender("heartbeat", { note }).catch(() => undefined);
      if (senderHeartbeat?.accepted === false && senderHeartbeat?.reason === "sender-rebind-required") {
        const rebound = await bindSenderTransport().catch(() => undefined);
        if (rebound?.accepted && senderTransportAvailable()) {
          await consumeRecoveryAfterSenderBind(
            rebound,
            "sender heartbeat rebound with READY generation",
            "sender heartbeat rebound with overdue delivery ACK retry",
          ).catch(() => false);
          await callSender("heartbeat", { note: `${note}; after authenticated sender rebind` }).catch(() => undefined);
        }
      }
    }
    if (state.anchorSurface && !state.anchorSuperseded && state.task?.anchorMountVerifiedAt) {
      await callTask("heartbeat", { note }).catch(() => undefined);
    }
  }

  async function recordHostSignal(hostSignal, note) {
    if (!state.task?.id || terminal(state.task)) return undefined;
    const payload = {
      hostProfileId: state.hostProfileId ?? buildHostProfileId(),
      elapsedMs: Math.round(taskElapsedMs(state.task)),
      note,
    };
    const verifiedVisibleCoordinator = Boolean(state.task?.anchorMountVerifiedAt)
      && state.anchorSurface && !state.anchorSuperseded && state.anchorMountAcked;
    // ChatGPT does not always instantiate a newly issued milestone-card iframe.
    // Keep mount verification truthful: never turn a sender relay into a fake
    // visible-card ACK. Explicit timeout is a separate Host lifecycle fact, so
    // when the visible coordinator is unavailable let only the already-bound
    // current-generation sender report it. The server additionally requires the
    // exact current turn lease, which prevents a stale relay/old turn from
    // timing out a later manual or synthetic turn. Generic teardown has no such
    // fallback because ordinary relay disposal is not evidence that the model
    // turn ended.
    const outcome = hostSignal === "timeout" && !verifiedVisibleCoordinator
      ? await callSender("host-timeout", {
          ...payload,
          turnLeaseId: state.task.turnLeaseId,
        }).catch(() => undefined)
      : await callTask("host-signal", {
          ...payload,
          hostSignal,
        }).catch(() => undefined);
    if (outcome?.task) state.task = outcome.task;
    return outcome;
  }

  async function prepareContinuation(reason = "continuation") {
    if (state.disposed) return false;
    try {
      await ensureTask();
      if (!senderTransportAvailable() || !state.task || terminal(state.task) || automationSuppressed(state.task)) return false;
      const status = await callTask("status");
      if (status?.task) state.task = status.task;
      if (state.anchorSuperseded && !senderTransportAvailable()) {
        const rebound = await bindSenderTransport().catch(() => undefined);
        if (!rebound?.accepted || !senderTransportAvailable()) return false;
      }
      if (!state.task || terminal(state.task) || automationSuppressed(state.task)) return false;
      await heartbeat(reason);
      await updateModelContextBestEffort(app, [
        { type: "text", text: continuationContext(state.task, state.workspaceId, reason) },
      ]);
      return true;
    } catch {
      return false;
    }
  }

  // Prefer the standards-level MCP Apps ui/message request for automatic
  // continuation. Live dev43 production evidence showed three separate
  // window.openai.sendFollowUpMessage() calls resolving successfully in 0-1 ms
  // without ever creating a resumed model turn. By contrast, ui/message is the
  // protocol operation whose schema explicitly carries a user-role message.
  // A fulfilled transport request is still not model-start proof: the resumed
  // model's continuation_task status ACK remains authoritative.
  //
  // Keep window.openai.sendFollowUpMessage only as a compatibility fallback for
  // an older/non-standard Host that explicitly rejects ui/message. Never invoke
  // both when ui/message is pending or fulfilled, because the first request may
  // already have crossed the Host boundary and a second request could create a
  // duplicate visible user turn.
  async function sendFollowUp(text, beforeSend) {
    const ensureStillRunnable = async () => {
      if (typeof beforeSend !== "function") return;
      if (!(await beforeSend())) throw new Error("terminal-continuation-cancelled");
    };
    const standardUiMessage = typeof options.uiMessage === "function"
      ? options.uiMessage
      : typeof app.sendMessage === "function"
        ? app.sendMessage.bind(app)
        : undefined;
    const optionNativeFollowUp = typeof options.nativeFollowUp === "function" ? options.nativeFollowUp : undefined;
    const hostNativeFollowUp = typeof window !== "undefined" && typeof window.openai?.sendFollowUpMessage === "function"
      ? window.openai.sendFollowUpMessage.bind(window.openai)
      : undefined;
    const nativeFollowUp = optionNativeFollowUp ?? hostNativeFollowUp;
    const safeSettlementReturnMetadata = (value) => {
      const returnType = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
      const returnKeys = value && typeof value === "object" && !Array.isArray(value)
        ? Object.keys(value)
          .filter((key) => /^[A-Za-z0-9_.-]{1,64}$/.test(key))
          .slice(0, 8)
        : [];
      return { returnType, returnKeys };
    };
    const settlementNote = (prefix, payloadShape, outcome) => {
      const elapsedMs = Math.max(0, Number(outcome?.elapsedMs || 0));
      const returnType = String(outcome?.returnType || "unknown");
      const returnKeys = Array.isArray(outcome?.returnKeys) && outcome.returnKeys.length > 0
        ? outcome.returnKeys.join(",")
        : "none";
      return `${prefix};payload=${payloadShape};elapsedMs=${elapsedMs};returnType=${returnType};returnKeys=${returnKeys}`;
    };
    const invokeWithSettlementBound = async (invoke, payload) => {
      let timer;
      const startedAt = Date.now();
      try {
        // Invoke the Host API synchronously before yielding back to the iframe
        // event loop. ChatGPT may replace/tear down the current App surface as
        // soon as a follow-up is accepted; deferring the irreversible call to
        // a Promise microtask creates an avoidable gap where an authorized
        // generation can be stranded in DELIVERING without ever reaching the
        // Host message API.
        let invocation;
        try {
          invocation = invoke(payload);
        } catch (error) {
          return { status: "rejected", error, elapsedMs: Date.now() - startedAt };
        }
        const settled = Promise.resolve(invocation)
          .then(
            (value) => {
              const semanticError = semanticTransportError(value);
              return {
                status: semanticError ? "rejected" : "fulfilled",
                ...(semanticError ? { error: semanticError } : {}),
                elapsedMs: Date.now() - startedAt,
                ...safeSettlementReturnMetadata(value),
              };
            },
            (error) => ({ status: "rejected", error, elapsedMs: Date.now() - startedAt }),
          );
        const timeout = new Promise((resolve) => {
          timer = setTimeout(() => resolve({
            status: "pending",
            elapsedMs: Date.now() - startedAt,
            returnType: "thenable-pending",
            returnKeys: [],
          }), nativeFollowUpSettlementTimeoutMs);
        });
        return await Promise.race([settled, timeout]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    // Live evidence is authoritative here. dev43 observed native
    // sendFollowUpMessage resolve in 0-1 ms without creating a model turn, and
    // the dev52 E2E reproduced the same failure after READY/claim/authorize:
    // native fulfilled, delivery was recorded, but turn_acked_at stayed null.
    // The only observed real synthetic Host turn in this conversation used the
    // standards-level ui/message user-role payload and ACKed ~6 s later.
    // Therefore ui/message is the primary ChatGPT path as well as the standards
    // path. Native remains a compatibility fallback only after ui/message
    // explicitly reports that the method itself is unsupported.
    if (typeof standardUiMessage === "function") {
      await ensureStillRunnable();
      const standardPayload = { role: "user", content: [{ type: "text", text }] };
      const standard = await invokeWithSettlementBound(standardUiMessage, standardPayload);
      if (standard.status === "pending") {
        return {
          method: "ui/message",
          result: "unknown",
          note: settlementNote("mcp-app-ui-message-settlement-unknown", "role-content", standard),
        };
      }
      if (standard.status === "fulfilled") {
        return {
          method: "ui/message",
          result: "accepted",
          note: `mcp-app-ui-message-fulfilled;model-turn-unconfirmed;${settlementNote("transport", "role-content", standard).replace(/^transport;/, "")}`,
        };
      }
      // Only an explicit method-unavailable response may use the compatibility
      // bridge. Permission denial, cancellation, validation errors and
      // fulfilled {isError:true} responses are real rejections, not permission
      // to try a second API that could create a duplicate user turn.
      if (!transportMethodUnsupported(standard.error) || typeof nativeFollowUp !== "function") {
        throw standard.error;
      }
    }
    // A superseded card is allowed to remain alive as a private sender relay so
    // durable READY work is not stranded when ChatGPT delays mounting the next
    // visible milestone card. That relay is not an active Host surface,
    // however. dev52 proved that invoking the native bridge from this state can
    // fulfill synchronously while creating no user/model generation. Keep the
    // relay useful for ui/message, but never let it fall back to the surface-
    // scoped native bridge and falsely mark an undelivered generation sent.
    if (state.headlessSenderRelay) {
      const error = new Error("headless-relay-native-follow-up-disabled");
      error.code = "METHOD_UNSUPPORTED";
      throw error;
    }
    if (typeof nativeFollowUp !== "function") {
      throw new Error("The host exposes neither MCP Apps ui/message nor the legacy ChatGPT follow-up bridge.");
    }
    let lastError;
    for (let attempt = 0; attempt < TRANSIENT_RETRY_DELAYS_MS.length; attempt += 1) {
      if (TRANSIENT_RETRY_DELAYS_MS[attempt] > 0) await sleep(TRANSIENT_RETRY_DELAYS_MS[attempt]);
      try {
        await ensureStillRunnable();
        const primary = await invokeWithSettlementBound(nativeFollowUp, { prompt: text });
        if (primary.status === "pending") {
          return {
            method: "window.openai.sendFollowUpMessage",
            result: "unknown",
            note: settlementNote("native-follow-up-settlement-unknown", "prompt", primary),
          };
        }
        if (primary.status === "rejected") throw primary.error;
        return {
          method: "window.openai.sendFollowUpMessage",
          result: "fallback-accepted",
          note: `native-follow-up-call-fulfilled;model-turn-unconfirmed;${settlementNote("transport", "prompt", primary).replace(/^transport;/, "")}`,
        };
      } catch (error) {
        lastError = error;
        if (!transientTransportFailure(error) || attempt === TRANSIENT_RETRY_DELAYS_MS.length - 1) break;
      }
    }
    throw lastError ?? new Error("Native ChatGPT follow-up delivery failed.");
  }

  async function attemptContinuation(reason, { force = false, skipPrepare = false } = {}) {
    if (state.deliveryInFlight) return false;
    if (state.disposed && !force) return false;
    if (!force) return false;
    const wakeRetry = Boolean(state.task?.continuationWakePending) || reason === "watched process completed";
    state.deliveryInFlight = true;
    try {
      const prepared = skipPrepare ? true : await prepareContinuation(reason);
      if (!prepared || !state.task || terminal(state.task) || automationSuppressed(state.task)) {
        if (!wakeRetry || !state.task || terminal(state.task)) stopSupervisor();
        return false;
      }
      const preClaim = await callTask("status").catch(() => undefined);
      if (preClaim?.task) state.task = preClaim.task;
      if (state.anchorSuperseded && !senderTransportAvailable()) {
        const rebound = await bindSenderTransport().catch(() => undefined);
        if (!rebound?.accepted || !senderTransportAvailable()) return false;
      }
      const claim = await callSender("claim", { note: reason });
      if (!claim?.accepted) return false;
      const deliveryToken = claim.deliveryToken;
      if (!deliveryToken) return false;
      try {
        // Keep task ids, workspace ids, delivery tokens, recovery reasons, and
        // execution policy in model context rather than leaking the synthetic
        // recovery envelope into the visible conversation history.
        await updateModelContextBestEffort(app, [
          { type: "text", text: continuationContext(state.task, state.workspaceId, reason) },
        ]);

        // A manual user turn may revoke this synthetic owner while the Host
        // context update above is in flight. Re-check the exact sender
        // capability/token immediately before the irreversible user-role send.
        // If ownership was superseded, do not enqueue a stale continuation.
        const authorized = await callSender("authorize-delivery", { deliveryToken, note: reason }).catch(() => undefined);
        if (!authorized?.accepted) return false;

        let hostSendAttempt = 0;
        const delivery = await sendFollowUp(visibleContinuationTrigger(state.task, deliveryToken), async () => {
          hostSendAttempt += 1;
          // authorize-delivery is already the final server-side CAS over the
          // exact manual/synthetic owner, card generation, sender lease and
          // delivery token. Do not insert another Host->server request before
          // the first irreversible send: a background iframe can be frozen or
          // replaced in that extra round-trip. Retries/fallback attempts still
          // re-read authoritative state so a later manual takeover always wins.
          if (hostSendAttempt === 1) return true;
          const latest = await callTask("status").catch(() => undefined);
          if (latest?.task) acceptTask(latest.task);
          // Check fresh ownership on every transport attempt, including retries
          // and fallback. A manual takeover keeps the task RUNNING but revokes
          // this delivery; cached state or a failed status cannot authorize it.
          return Boolean(latest?.task
            && !terminal(latest.task)
            && !automationSuppressed(latest.task)
            && latest.task.deliveryToken === deliveryToken
            && latest.task.deliveryOwner === "synthetic-pending"
            && latest.task.continuationDeliveryAwaitingAck);
        });
        const recorded = await callSender("delivery-result", {
          deliveryToken,
          result: delivery.result,
          method: delivery.method,
          note: delivery.note ? `${reason}; ${delivery.note}` : reason,
        }).catch(() => undefined);
        if (recorded?.task) state.task = recorded.task;
        if (recorded?.accepted) {
          renderRecoveryStatus(
            controller,
            isChinese()
              ? "DevSpace 已向宿主发出自动续轮请求，但新一轮尚未确认创建；只有 resumed turn 的 DevSpace ACK 才算成功。为避免重复消息或打断慢启动模型，未收到 ACK 时不会重发可见消息。"
              : "DevSpace issued an automatic continuation request to the Host, but creation of a resumed turn is not yet confirmed. Only the resumed turn's DevSpace ACK counts as success. To avoid duplicates or interrupting a slow-starting model, no visible message is retransmitted while ACK is missing.",
            "warning",
            false,
          );
          // Keep the App supervisor alive for the ACK/health signal and for a
          // genuinely new READY generation. The accepted visible message is
          // outcome-uncertain and is never retransmitted.
          return true;
        }
        return false;
      } catch (error) {
        const note = String(error?.message || error);
        if (note.includes("terminal-continuation-cancelled")) {
          await callSender("delivery-result", {
            deliveryToken,
            result: "failed",
            method: "window.openai.sendFollowUpMessage",
            note: "task became terminal before Host send",
          }).catch(() => undefined);
          return false;
        }
        const semanticallyRejected = ["HOST_REJECTED", "METHOD_UNSUPPORTED"].includes(String(error?.code || ""))
          || /reject/i.test(note);
        await callSender("delivery-result", {
          deliveryToken,
          result: semanticallyRejected ? "rejected" : "failed",
          method: "window.openai.sendFollowUpMessage",
          note,
        }).catch(() => undefined);
        renderRecoveryStatus(
          controller,
          isChinese() ? "自动续轮被宿主拒绝或未送达，可手动继续。" : "Automatic continuation was rejected or not delivered; manual recovery is available.",
          "warning",
          true,
        );
        return false;
      }
    } catch (error) {
      renderRecoveryStatus(controller, String(error?.message || error), "warning", true);
      return false;
    } finally {
      state.deliveryInFlight = false;
    }
  }

  async function supervisorTickImpl({ forceAuthoritative = false } = {}) {
    if (state.disposed || !state.connected || !state.task?.id) return;
    if (!state.anchorSuperseded && !senderTransportAvailable()) return;
    const cachedTerminal = terminal(state.task);
    if (!forceAuthoritative && cachedTerminal && Date.now() - state.lastTerminalRefreshAt < terminalRefreshMs) return;

    // Always begin from authoritative server state, even when the locally
    // rendered card is terminal. The same conversation-lifetime task can be
    // reactivated for later user work, and checkpoint/complete calls are
    // headless, so the card must not become a permanently frozen snapshot.
    // Terminal cards use a slower cadence to avoid needless steady-state load.
    if (cachedTerminal) state.lastTerminalRefreshAt = Date.now();

    // The assistant registers watch-process through a headless continuation_task
    // call after the continuation_anchor has already rendered. That later tool
    // result is not guaranteed to be delivered to the existing Workspace App,
    // so refresh authoritative task state before deciding whether anything is
    // being watched. Without this refresh the App can cache an empty watch list
    // forever even though the server has a durable process handle registered.
    const current = await callTask("status").catch(() => undefined);
    if (current?.task) acceptTask(current.task);
    await syncPersistentDisplayMode();
    if (state.anchorSuperseded) {
      // Generation rotation intentionally invalidates the old card's mount
      // capability. Rebind only the private sender capability to the current
      // generation. This closes the live failure where ATCC created READY but
      // claimed_at/delivered_at stayed null until the next manual user message.
      const rebound = await bindSenderTransport().catch(() => undefined);
      if (!rebound?.accepted || !senderTransportAvailable()) return;
      if (await consumeRecoveryAfterSenderBind(
        rebound,
        "superseded card headless relay rebound with READY generation",
        "superseded card headless relay rebound with overdue delivery ACK retry",
      ).catch(() => false)) return;
    }
    if (!state.task || terminal(state.task)) {
      state.lastTerminalRefreshAt = Date.now();
      stopSupervisor();
      stopLifecycleRefresh();
      return;
    }
    state.lastTerminalRefreshAt = 0;
    if (state.task.state === "PAUSED_BY_USER") return;

    // READY may be created by the server-resident generation sweep *after*
    // this App already bound its sender transport.  The bind path consumes a
    // READY that existed at mount/rebind time, but without this status path a
    // later READY can sit indefinitely while the verified App is still alive.
    // continuation_task status already exposes readyGeneration without
    // transferring sender authority; the subsequent sender claim is atomic, so
    // sibling Apps can safely race here without producing duplicate messages.
    const readyGeneration = Number(current?.readyGeneration || 0);
    if (Number.isInteger(readyGeneration) && readyGeneration > 0) {
      await attemptContinuation("supervisor discovered READY generation", { force: true });
      return;
    }

    // Host acceptance is not proof that a resumed assistant turn reached
    // DevSpace. Missing ACK is diagnostic only and must never retransmit a
    // visible message: the first model may be alive but slow to call DevSpace.
    if (state.task.continuationDeliveryAwaitingAck) {
      if (deliveryAckRetryDue(state.task)) {
        renderRecoveryStatus(
          controller,
          isChinese()
            ? "宿主已接受续轮消息，但尚未收到新 assistant 轮的 DevSpace ACK；为避免重复或打断正在启动的模型，本程序不会自动重发可见消息。"
            : "The Host accepted the continuation message, but the resumed assistant has not ACKed DevSpace. To avoid duplicates or interrupting a slow-starting model, no visible message will be retransmitted.",
          "warning",
          true,
        );
      }
      return;
    }

    // Persisted process wakes are claimable by any surviving/recreated iframe.
    // This prevents a single watch-status winner from consuming the wake and
    // disappearing before the native Host send while sibling App cards see nothing.
    if (state.task.continuationWakePending) {
      if (!residentTask(state.task)) return;
      const reason = /stage completed/i.test(String(state.task.waitingReason || ""))
        ? "resident stage completed"
        : "resident watched process completed";
      await attemptContinuation(reason, { force: true });
      return;
    }

    const hasWatchedProcesses = Array.isArray(state.task.watchProcessHandles)
      && state.task.watchProcessHandles.length > 0;

    // WAITING_EXTERNAL must suppress time-budget continuations, but it must not
    // suppress a process watch whose explicit purpose is to wake the task when
    // that external process completes.
    if (state.task.state === "WAITING_EXTERNAL" && !hasWatchedProcesses) return;

    if (Date.now() - state.lastHeartbeatAt >= heartbeatIntervalMs) await heartbeat("adaptive supervisor");
    if (hasWatchedProcesses) {
      if (!residentTask(state.task)) return;
      const watched = await callTask("watch-status").catch(() => undefined);
      if (watched?.task) state.task = watched.task;
      if (watched?.wakeReady) {
        // Current servers arm a durable wake and move the task to RUNNING.
        // Keep the defensive resume for older/partially upgraded servers.
        if (state.task?.state === "WAITING_EXTERNAL") {
          const resumed = await callTask("resume", { note: "watched process completed" }).catch(() => undefined);
          if (resumed?.task) state.task = resumed.task;
        }
        await attemptContinuation("resident watched process completed", { force: true });
        return;
      }
      return;
    }

    if (automationSuppressed(state.task)) return;
    if (completionActivityLeaseExpired(state.task) && state.task?.stallState === "ACTIVE") {
      // P0 fail-closed guard: model inactivity alone is not proof that ChatGPT
      // ended the assistant turn. Ask the server to persist SUSPECTED_STALL;
      // this verified-card heartbeat is only a liveness probe and can never
      // authorize delivery, no matter how many times it repeats.
      const probed = await callTask("heartbeat", {
        note: "activity lease expired; mark suspected stall only",
      }).catch(() => undefined);
      if (probed?.task) state.task = probed.task;
      if (state.task) publishTaskForCard(state.task);
    }
    if (assistantTurnCompletionArmed(state.task)) {
      await attemptContinuation("Assistant Turn Completion Contract armed", { force: true });
      return;
    }
    // Intentionally no learned-budget or ordinary process-completion trigger.
    // Generic inactivity remains disabled outside explicit completion-driven mode.
  }

  async function supervisorTick(options = {}) {
    if (state.supervisorTickInFlight) return;
    state.supervisorTickInFlight = true;
    try {
      await supervisorTickImpl(options);
    } finally {
      state.supervisorTickInFlight = false;
    }
  }

  function stopWakeSource() {
    const source = state.wakeSource;
    state.wakeSource = undefined;
    try {
      source?.close?.();
    } catch {
      // Best-effort teardown only.
    }
  }

  function startWakeSource() {
    if (state.wakeSource || state.disposed || typeof EventSource !== "function" || !CONTINUATION_WAKE_URL) return;
    try {
      const source = new EventSource(CONTINUATION_WAKE_URL);
      state.wakeSource = source;
      source.addEventListener("wake", () => {
        // Wake hints are never continuation authority. The forced tick re-reads
        // durable server state and still has to win continuation_sender CAS.
        void supervisorTick({ forceAuthoritative: true });
      });
      source.addEventListener("error", () => {
        // EventSource reconnects automatically; timer/lifecycle paths remain
        // independent fallbacks and no send is manufactured from an error.
      });
    } catch {
      state.wakeSource = undefined;
    }
  }

  function startSupervisor() {
    startWakeSource();
    // Keep a lightweight supervisor alive for non-terminal waiting tasks too. A
    // watch-process registration may arrive after the anchor is mounted, and a
    // stopped timer would otherwise never discover that new server-side watch.
    // A superseded historical anchor is a special authenticated recovery case:
    // it may have deliberately discarded its stale sender capability when a new
    // card generation was issued. Allow that already-connected App to keep the
    // supervisor alive long enough to refresh authoritative state and privately
    // bind the current generation. supervisorTickImpl still requires the
    // generation-safe bind/CAS before any claim/send, so this does not grant an
    // arbitrary transport App sender authority.
    const recoverableHeadlessRelay = state.anchorSuperseded && state.headlessSenderRelay;
    if (!timersEnabled || terminal(state.task)
        || (!senderTransportAvailable() && !recoverableHeadlessRelay)
        || state.supervisorTimer || !state.task?.id) return;
    state.supervisorTimer = setInterval(() => void supervisorTick(), supervisorTickMs);
    void supervisorTick();
  }

  async function ensureTask() {
    if (!state.connected || !state.anchorSurface || state.currentTool !== "continuation_anchor" || state.anchorSuperseded) return state.task;
    if (state.ensuringTask) return state.ensuringTask;
    state.ensuringTask = (async () => {
      try {
        const explicitTaskId = state.currentInput?.taskId ? String(state.currentInput.taskId) : undefined;
        if (explicitTaskId && state.task?.id !== explicitTaskId) {
          // The anchor input is authoritative. ChatGPT can instantiate the App
          // without delivering the one-shot initial toolresult notification, so
          // bind the already-persisted task from toolinput before considering the
          // legacy begin-auto fallback. This also prevents an orphan shadow task
          // from being created under a different host request scope.
          state.task = undefined;
          const bound = await callTask("status", { taskId: explicitTaskId });
          if (bound?.task?.id === explicitTaskId) state.task = bound.task;
          if (!state.task?.id) return state.task;
        }
        if (!state.task?.id) {
          // Older callers may not supply taskId. Keep begin-auto as a compatibility
          // fallback, but never race it against an explicit continuation_anchor
          // task binding.
          if (explicitTaskId) return state.task;
          const outcome = await callTask("begin-auto", {
            objective: "Continue the current DevSpace work until the original user request is verified complete; preserve the existing workspace, process handles, milestones, and evidence across assistant turns.",
          });
          if (outcome?.task) state.task = outcome.task;
        }
        const authoritativeGeneration = Math.max(0, Number(state.task?.anchorMountGeneration || 0));
        const surfaceGeneration = Math.max(0, Number(state.anchorMountGeneration || 0));
        if (surfaceGeneration > 0 && authoritativeGeneration > surfaceGeneration) {
          markAnchorSuperseded();
          return state.task;
        }
        if (!state.task?.anchorMountVerifiedAt) {
          if (!state.anchorMountToken) return state.task;
          const mountToken = state.anchorMountToken;
          let mounted = await callTask("heartbeat", { note: `anchor-mount-ack:${mountToken}` }).catch(() => undefined);
          if (mounted?.task) state.task = mounted.task;
          if (!state.task?.anchorMountVerifiedAt) {
            mounted = await callTask("anchor-mounted", {
              anchorMountToken: mountToken,
              anchorMountGeneration: state.anchorMountGeneration,
            }).catch(() => undefined);
            if (mounted?.task) state.task = mounted.task;
          }
          if (!state.task?.anchorMountVerifiedAt) return state.task;
          state.anchorMountAcked = true;
        } else {
          // A transcript/page/service rehydrate creates a fresh App instance for
          // the same immutable card. Rebind coordinator ownership using the same
          // generation capability instead of issuing another continuation_anchor.
          if (state.anchorMountToken && state.anchorMountGeneration) {
            const rebound = await callTask("anchor-mounted", {
              anchorMountToken: state.anchorMountToken,
              anchorMountGeneration: state.anchorMountGeneration,
            }).catch(() => undefined);
            if (rebound?.task) state.task = rebound.task;
            if (rebound && rebound.accepted === false) {
              if (rebound.reason === "stale-anchor-generation") markAnchorSuperseded();
              return state.task;
            }
            // Do not inherit mount authority merely because durable server
            // state says this card generation was VERIFIED in the past.  The
            // current iframe must present the immutable generation capability
            // and receive an accepted rebind before it can act as the visible
            // coordinator/sender heartbeat owner.  This keeps taskId-only or
            // Host-context-only recovery read-only while allowing a genuine
            // surviving/rehydrated card to recover cleanly after MCP restart.
            if (!rebound?.accepted) return state.task;
            state.anchorMountAcked = true;
          }
        }
        // Reconnect/rehydration is transport recovery, not permission to mutate
        // model-turn ownership. In particular, pending=4/5 belongs to an
        // already-authorized synthetic generation and may be waiting for its
        // first model ACK. Ordinary resume() clears continuation_pending and
        // can rewrite that generation as a manual turn, which destroys late
        // ACK/retry eligibility. Only an explicit retryable task state may use
        // the legacy resume path; synthetic pending state is recovered by the
        // sender supervisor using the existing generation/token.
        if (state.task?.state === "FAILED_RETRYABLE"
            && !state.task?.continuationDeliveryAwaitingAck
            && !state.task?.deliveryToken) {
          const resumed = await callTask("resume");
          if (resumed?.task) state.task = resumed.task;
        }
        state.hostProfileId = state.hostProfileId ?? buildHostProfileId();
        await recordHostSignal("connected", "workspace-app connected");
        await heartbeat("anchor activity");
        startSupervisor();
        startLifecycleRefresh();
        return state.task;
      } finally {
        state.ensuringTask = undefined;
      }
    })().catch(() => state.task);
    return state.ensuringTask;
  }

  function mergeContext(context) {
    if (context && typeof context === "object") {
      if (addTelemetryNames(state.hostTelemetry.hostContextKeys, ownTelemetryKeys(context))) scheduleHostTelemetryFlush();
      state.hostContext = { ...(state.hostContext ?? {}), ...context };
    }
    const tool = toolFromContext(context);
    if (tool) {
      state.currentTool = tool;
      if (tool === "continuation_anchor") state.anchorSurface = true;
    }
  }

  function onToolInput(params) {
    if (typeof params?.name === "string") state.currentTool = params.name;
    const previousTaskId = state.currentInput?.taskId ? String(state.currentInput.taskId) : undefined;
    state.currentInput = { ...state.currentInput, ...(params?.arguments ?? {}) };
    if (state.currentInput.workspaceId) state.workspaceId = String(state.currentInput.workspaceId);
    if (params?.name === "continuation_anchor") state.anchorToolEventObserved = true;
    if (state.currentTool === "continuation_anchor" || params?.name === "continuation_anchor") state.anchorSurface = true;
    const nextTaskId = state.currentInput?.taskId ? String(state.currentInput.taskId) : undefined;
    if (nextTaskId && previousTaskId && nextTaskId !== previousTaskId) {
      stopSupervisor();
      state.task = undefined;
      state.lastHeartbeatAt = 0;
    }
    void ensureTask();
  }

  function onToolResult(params) {
    state.currentTool = params?.name ?? params?._meta?.tool ?? state.currentTool;
    state.workspaceId = workspaceFromResult(params) || state.workspaceId;
    const mount = anchorMountFromResult(params);
    if (params?.name === "continuation_anchor" || params?._meta?.tool === "continuation_anchor" || mount.continuationAnchor) {
      state.anchorToolEventObserved = true;
    }
    if (mount.continuationAnchor || state.currentTool === "continuation_anchor") state.anchorSurface = true;
    if (mount.anchorMountToken) state.anchorMountToken = mount.anchorMountToken;
    if (mount.anchorMountGeneration) state.anchorMountGeneration = mount.anchorMountGeneration;
    const senderCapability = senderCapabilityFromResult(params);
    if (senderCapability) {
      state.senderCapability = senderCapability;
      if (senderCapability.workspaceId) state.workspaceId = senderCapability.workspaceId;
    }
    const resultTask = taskFromResult(params);
    if (resultTask) acceptTask(resultTask);
    void ensureTask()
      .then(() => bindSenderTransport())
      .then(async (bound) => {
        await consumeRecoveryAfterSenderBind(bound);
        return bound;
      })
      .then(() => syncPersistentDisplayMode())
      .then(() => heartbeat("sender transport mounted"))
      .catch(() => undefined)
      .finally(() => {
        startSupervisor();
        startLifecycleRefresh();
      });
  }

  function onToolCancelled(params) {
    const reason = String(params?.reason || "cancelled");
    // tool-cancelled applies to one MCP tool, not the assistant turn. Even a
    // timeout/deadline string cannot authorize another Host turn.
    if (cancellationIsUserAction(reason) && state.task?.id) {
      stopSupervisor();
      void callTask("cancel", { note: reason }).catch(() => undefined);
    }
  }

  function onHostContextChanged(params) {
    mergeContext(params);
    void syncPersistentDisplayMode();
    scheduleAuthoritativeRefresh("host context changed");
  }

  app.addEventListener("toolinput", onToolInput);
  app.addEventListener("toolinputpartial", onToolInput);
  app.addEventListener("toolresult", onToolResult);
  app.addEventListener("toolcancelled", onToolCancelled);
  app.addEventListener("hostcontextchanged", onHostContextChanged);
  startHostTelemetryObserver();

  const controller = {
    state,
    async onConnected() {
      if (state.disposed) return;
      state.connected = true;
      state.hostProfileId = buildHostProfileId();
      mergeContext(app.getHostContext?.());
      await ensureTask();
      const bound = await bindSenderTransport().catch(() => undefined);
      // If the Host omitted toolresult, bindSenderTransport() may just have
      // recovered the current anchor generation capability. Give the visible
      // anchor surface one immediate second chance to perform its authenticated
      // mount ACK before starting sender/supervisor traffic.
      if (state.anchorSurface && state.currentTool === "continuation_anchor"
        && state.anchorMountToken && !state.task?.anchorMountVerifiedAt && !state.anchorSuperseded) {
        await ensureTask();
      }
      await consumeRecoveryAfterSenderBind(
        bound,
        "sender transport connected with READY generation",
        "sender transport connected with overdue delivery ACK retry",
      ).catch(() => false);
      await syncPersistentDisplayMode();
      await heartbeat("sender transport connected").catch(() => undefined);
      await flushHostTelemetry().catch(() => false);
      startSupervisor();
    },
    ensureTask,
    prepareContinuation,
    attemptContinuation,
    async refreshNow() {
      await supervisorTick({ forceAuthoritative: true });
      return state.task;
    },
    async onTeardown(params) {
      if (state.disposed) return;
      if (!state.anchorSurface || state.headlessSenderRelay) {
        // Ordinary tool-result Apps may act as transport relays, but their UI
        // teardown says only that this relay iframe is going away. The same is
        // true for a superseded historical card after it has been demoted to a
        // headless sender relay: it no longer owns the current visible card or
        // Host lifecycle evidence. It is not
        // evidence that the assistant turn ended, so never arm recovery from it.
        controller.dispose();
        return;
      }
      const reason = String(params?.reason ?? "resource teardown");
      // The MCP Apps SDK does not expose an assistant-final event and generic
      // resource teardown carries no reason payload. Therefore teardown alone
      // is never interpreted as model completion. If it does arrive after the
      // model signed ATCC for this exact turn lease, it is an immediate
      // confirmation fast path. Teardown is never promoted to timeout based on
      // free-form reason text. A future Host adapter must provide a verified
      // turn-scoped timeout event through its own authenticated path.
      const lifecycle = await recordHostSignal("teardown", reason);
      if (lifecycle?.task) state.task = lifecycle.task;
      if (assistantTurnCompletionArmed(state.task) || timeoutRecoveryArmed(state.task)) {
        await attemptContinuation(
          "ATCC normal assistant completion confirmed by Host teardown",
          { force: true },
        );
      }
      controller.dispose();
    },
    dispose() {
      if (state.disposed) return;
      state.disposed = true;
      stopSupervisor();
      stopWakeSource();
      stopLifecycleRefresh();
      app.removeEventListener?.("toolinput", onToolInput);
      app.removeEventListener?.("toolinputpartial", onToolInput);
      app.removeEventListener?.("toolresult", onToolResult);
      app.removeEventListener?.("toolcancelled", onToolCancelled);
      app.removeEventListener?.("hostcontextchanged", onHostContextChanged);
      state.hostTelemetry.cleanup?.();
      state.hostTelemetry.cleanup = undefined;
    },
  };
  return controller;
}

const controllers = new WeakMap();

function attachGlobalApp(app) {
  if (!app) return undefined;
  let controller = controllers.get(app);
  if (!controller) {
    controller = installContinuationCoordinator(app);
    controllers.set(app, controller);
  }
  return controller;
}

if (typeof window !== "undefined") {
  window.__DEVSPACE_ATTACH_CONTINUATION__ = (app) => attachGlobalApp(app);
  window.__DEVSPACE_CONTINUATION_CONNECTED__ = (app) => void attachGlobalApp(app)?.onConnected();
  window.__DEVSPACE_CONTINUATION_TEARDOWN__ = (app, params) => attachGlobalApp(app)?.onTeardown(params);
  if (window.__DEVSPACE_MCP_APP__) attachGlobalApp(window.__DEVSPACE_MCP_APP__);
}
