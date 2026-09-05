const TASK_TOOL = "continuation_task";
const SENDER_TOOL = "continuation_sender";
// Keep completion delivery responsive after the guarded ATCC handoff without
// turning polling into a completion signal.  The runtime still authorizes only
// exact-turn COMPLETED/TIMED_OUT state; this tick merely notices it promptly.
const DEFAULT_SUPERVISOR_TICK_MS = 2_000;
const CONTINUATION_WAKE_URL = new URL("./continuation-wake", import.meta.url).toString();
const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000;
const DEFAULT_TERMINAL_REFRESH_MS = 60_000;
// A resumed ChatGPT turn can be created before its MCP connector has fully
// rehydrated. Keep retrying the same idempotent control call across roughly a
// 30-second readiness window instead of giving up after ~8 seconds.
// Keep the complete client-side readiness backoff to ten seconds. Combined
// with the resident five-second sweep and the server's bounded recovery leases,
// a healthy Host never waits more than one minute before a continuation attempt.
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
  return /user|manual|cancel|stop|abort/i.test(String(reason || "")) && !/timeout|deadline|budget/i.test(String(reason || ""));
}

function isChinese() {
  return typeof navigator !== "undefined" && String(navigator.language || "").toLowerCase().startsWith("zh");
}

function compactContinuationField(value, maxLength = 520) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length <= maxLength ? text : `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

function visibleContinuationTrigger(task) {
  // app.sendMessage is the Host-supported way to create the resumed model turn,
  // so the recovery instruction must survive even when updateModelContext is
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
  return isChinese()
    ? [
      "@DevSpace MCP 继续执行未完成任务。",
      "这是本轮要立即执行的用户角色工作请求，不是仅供参考的系统续接说明。",
      "继续执行未完成的 DevSpace 任务。",
      objective ? `当前任务：${objective}` : "",
      milestone ? `下一未完成里程碑：${milestone}` : "",
      "先调用 continuation_task status 恢复权威状态；如果本轮未直接提供 DevSpace_MCP 工具，先通过连接器工具发现加载它。自动续轮获得与手动“继续”相同的完整 Host 思考/执行预算，不要因为它是 synthetic turn 就主动缩短本轮。随后必须在本轮继续实际 DevSpace 工具操作并推进下一未完成里程碑。四次 substantive 操作只是最低质量门槛，不代表已经可以结束。运行时不使用固定分钟数作为 synthetic 时长：只有当前 Host profile 的真实 timeout/cutoff 样本才能校准可选阶段边界；如果 Host 以后缩短或延长窗口，预算应由新样本自动重估而不是修改代码。已学习预算也只是最早允许的 voluntary boundary，不是停止目标；只要当前里程碑仍可继续推进，就继续工作直到任务完成、确实外部阻塞/暂停，或 Host 自己截断。一次命令/测试失败、一次工具报错、只完成少量快速工具调用，都不是主动结束本轮的理由；应在同一轮继续诊断、修复和验证。需要合法阶段边界时优先调用 continuation_task action=turn-complete；如果它返回 synthetic-host-budget-calibration-required、synthetic-turn-min-active-work-required 或 finalResponseAllowed=false，必须继续工作；只有返回 retryAfterMs 时才按该动态值处理，绝不能自行等待一个写死时长后结束。如果当前 ChatGPT 缓存的 schema 没有 turn-complete，则调用 action=checkpoint 且 note=atcc-turn-complete，同样必须确认 finalResponseAllowed=true 后才能结束。不要只复述这条消息，不要把它判定为“系统续接指令”，不要因为看不到上一条消息、工具未预加载或只完成状态检查就停止，也不要只回复状态或“继续处理中”，更不要等待第二次续轮才开始工作。",
    ].filter(Boolean).join("\n")
    : [
      "@DevSpace MCP Continue the unfinished task.",
      "This is the actual user-role work request for this assistant turn, not system-only continuation metadata.",
      "Continue the unfinished DevSpace task.",
      objective ? `Current task: ${objective}` : "",
      milestone ? `Next unfinished milestone: ${milestone}` : "",
      "Call continuation_task status first to restore authoritative state. If DevSpace_MCP is not directly exposed in this turn, load it through connector/tool discovery. An automatic resumed turn receives the same full Host reasoning/execution budget as a manual 'continue'; do not shorten it merely because it is synthetic. Then, in this same turn, perform substantive DevSpace tool work that advances the next unfinished milestone. Four substantive operations are only a minimum quality floor, not permission to stop. The runtime uses no fixed number of minutes as a synthetic turn duration: only verified timeout/cutoff samples from the current Host profile may calibrate an optional stage boundary, and later shorter or longer Host windows must be relearned from new samples without a source change. A learned budget is only the earliest permitted voluntary boundary, never a stop target; while the current milestone remains runnable, keep working until the task completes, becomes genuinely blocked/paused, or the Host itself truncates the turn. One failed command/test, one tool error, or a few quick tool calls is not a valid reason to voluntarily end the turn; keep diagnosing, fixing, and validating in the same turn. If a genuine stage boundary is necessary, prefer continuation_task action=turn-complete. If it returns synthetic-host-budget-calibration-required, synthetic-turn-min-active-work-required, or finalResponseAllowed=false, keep working; honor retryAfterMs only when the runtime actually returns that dynamic value, and never invent a fixed wait. If the current ChatGPT cached schema does not expose turn-complete, use action=checkpoint with note=atcc-turn-complete instead and still require finalResponseAllowed=true. Do not merely restate this message, do not classify it as a system-only continuation instruction, do not stop because the previous message is not visible, tools were not preloaded, or only a status check has completed, do not reply with only a status or 'still working', and do not wait for a second continuation before starting work.",
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
    "Call continuation_task status first. The runtime atomically claims any server-owned expected synthetic generation; do not search for, expose, or pass a continuation token to ordinary tools. Then continue substantive work with the same full Host reasoning budget and sustained execution semantics as a manual 'continue': keep reading, editing, executing, validating, and polling owned long-running processes until the current milestones are complete, genuinely externally blocked, explicitly paused/cancelled, or the Host truncates the turn. Four substantive operations are only the post-ACK minimum, not a target duration. Synthetic duration is never a fixed number of minutes. A current Host profile becomes calibrated only from verified timeout/cutoff samples, and later Host-window changes must update that profile from new observations without a source-code change. Even a calibrated budget is merely the earliest legal incomplete-stage boundary, not an instruction to stop; keep working while the milestone is runnable. A checkpoint persists progress but never permits an early final while runnable milestones remain. Reuse the conversation-lifetime taskId and existing process/workspace state. Synthetic continuations reuse the current visible milestone-card generation while the required milestone set is unchanged. If and only if a status/checkpoint reports milestoneCardRequired/reanchorRequired because the synthetic checkpoint changed the required milestone set, issue continuation_anchor exactly once for that new generation; otherwise never create a duplicate card.",
    "Never end an automatically resumed turn with a placeholder/status-only reply such as '继续处理中。', '继续处理。', 'still working', or 'I will continue'. There is no background model execution after a final assistant message. A failed command/test or a small number of quick tool calls is not a legitimate yield boundary. If runnable milestones remain, keep diagnosing and invoking the required tools in this same turn instead of promising future work. If a genuine incomplete-stage boundary is necessary after sustained work, prefer continuation_task action=turn-complete; if it is rejected with synthetic-host-budget-calibration-required, synthetic-turn-min-active-work-required, or reports finalResponseAllowed=false, continue substantive work. Respect retryAfterMs only if the runtime actually supplies that dynamically learned value; never invent or wait for a hard-coded duration. If the current cached schema does not expose that action, use continuation_task action=checkpoint with note=atcc-turn-complete. Do not voluntarily final while the returned finalResponseAllowed is false.",
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

  const state = {
    instanceId: options.instanceId ?? uniqueId(),
    connected: false,
    disposed: false,
    currentTool: undefined,
    currentInput: {},
    workspaceId: undefined,
    task: undefined,
    anchorSurface: false,
    anchorMountToken: undefined,
    anchorMountGeneration: undefined,
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
  const timersEnabled = options.timers !== false;

  function acceptTask(task) {
    if (!task || typeof task !== "object") return;
    state.task = task;
    publishTaskForCard(state.task);
    const authoritativeGeneration = Math.max(0, Number(state.task?.anchorMountGeneration || 0));
    const surfaceGeneration = Math.max(0, Number(state.anchorMountGeneration || 0));
    if (surfaceGeneration > 0 && authoritativeGeneration > surfaceGeneration) markAnchorSuperseded();
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
    return Boolean(state.connected
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
        const result = await app.callServerTool({
          name: TASK_TOOL,
          arguments: {
            action,
            ...(state.task?.id ? { taskId: state.task.id } : {}),
            ...(state.workspaceId ? { workspaceId: state.workspaceId } : {}),
            coordinatorInstanceId: state.instanceId,
            ...extra,
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

  async function callSender(action, extra = {}) {
    if (!state.connected) throw new Error("DevSpace Workspace App is not connected to the host yet.");
    const capability = activeSenderCapability();
    if (!capability) {
      return { accepted: false, reason: "sender-capability-unavailable" };
    }
    let lastError;
    for (let attempt = 0; attempt < TRANSIENT_RETRY_DELAYS_MS.length; attempt += 1) {
      if (TRANSIENT_RETRY_DELAYS_MS[attempt] > 0) await sleep(TRANSIENT_RETRY_DELAYS_MS[attempt]);
      try {
        const result = await app.callServerTool({
          name: SENDER_TOOL,
          arguments: {
            action,
            taskId: capability.taskId,
            conversationScopeId: capability.conversationScopeId,
            senderInstanceId: state.instanceId,
            anchorMountToken: capability.anchorMountToken,
            anchorMountGeneration: capability.anchorMountGeneration,
            ...extra,
          },
        });
        if (result?.isError && transientTransportFailure(textFromToolResult(result))) {
          throw new Error(textFromToolResult(result) || "Transient MCP transport failure");
        }
        return normalizeTaskOutcome(result);
      } catch (error) {
        lastError = error;
        if (!transientTransportFailure(error) || attempt === TRANSIENT_RETRY_DELAYS_MS.length - 1) throw error;
      }
    }
    throw lastError ?? new Error("DevSpace continuation sender retry exhausted.");
  }

  async function bindSenderTransport() {
    if (!state.connected || typeof app.callServerTool !== "function") return undefined;
    if (terminal(state.task)) return { accepted: false, reason: "task-terminal" };
    let lastError;
    for (let attempt = 0; attempt < TRANSIENT_RETRY_DELAYS_MS.length; attempt += 1) {
      if (TRANSIENT_RETRY_DELAYS_MS[attempt] > 0) await sleep(TRANSIENT_RETRY_DELAYS_MS[attempt]);
      try {
        const result = await app.callServerTool({
          name: SENDER_TOOL,
          arguments: {
            action: "bind",
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
          if (state.anchorSurface && state.currentTool === "continuation_anchor") {
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

  async function consumeReadyAfterSenderBind(outcome, reason = "sender transport rebound with READY generation") {
    const readyGeneration = Number(outcome?.readyGeneration || 0);
    if (!outcome?.accepted || !Number.isInteger(readyGeneration) || readyGeneration <= 0) return false;
    // Do not wait for the old milestone iframe's five-second supervisor tick.
    // A newly mounted ordinary Workspace App is the recovery transport: once
    // bind proves the same conversation/card capability and the server reports
    // a durable READY generation, consume it immediately. Generation claim is
    // atomic, so concurrent sibling Apps safely lose the claim instead of
    // sending duplicate visible continuations.
    return attemptContinuation(reason, { force: true });
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

  function markAnchorSuperseded() {
    if (state.anchorSuperseded) return;
    state.anchorSuperseded = true;
    state.headlessSenderRelay = true;
    state.anchorMountToken = undefined;
    state.anchorMountAcked = false;
    // Do not stop the supervisor/lifecycle loop. The old *visible surface* is
    // retired, but its already-connected App remains a transport relay. The
    // next authoritative refresh will bind a fresh private sender capability
    // for the new generation without ever ACKing that new visible card.
    if (typeof document !== "undefined") {
      document.documentElement?.setAttribute?.("data-devspace-anchor-superseded", "true");
      if (document.body) {
        document.body.replaceChildren();
        Object.assign(document.body.style, { margin: "0", padding: "0", minHeight: "0", height: "0", overflow: "hidden" });
      }
    }
  }

  async function heartbeat(note = "workspace-app") {
    if (!senderTransportAvailable() || !state.task?.id || terminal(state.task)) return;
    state.lastHeartbeatAt = Date.now();
    if (state.anchorSurface && !state.anchorSuperseded && state.task?.anchorMountVerifiedAt) {
      await callTask("heartbeat", { note }).catch(() => undefined);
    } else {
      await callSender("heartbeat", { note }).catch(() => undefined);
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
      if (typeof app.updateModelContext === "function") {
        await app.updateModelContext({
          content: [{ type: "text", text: continuationContext(state.task, state.workspaceId, reason) }],
        }).catch(() => undefined);
      }
      return true;
    } catch {
      return false;
    }
  }

  async function sendFollowUp(text, beforeSend) {
    const ensureStillRunnable = async () => {
      if (typeof beforeSend !== "function") return;
      if (!(await beforeSend())) throw new Error("terminal-continuation-cancelled");
    };
    let officialError;
    if (typeof app.sendMessage === "function") {
      for (let attempt = 0; attempt < TRANSIENT_RETRY_DELAYS_MS.length; attempt += 1) {
        if (TRANSIENT_RETRY_DELAYS_MS[attempt] > 0) await sleep(TRANSIENT_RETRY_DELAYS_MS[attempt]);
        try {
          await ensureStillRunnable();
          const result = await app.sendMessage(
            { role: "user", content: [{ type: "text", text }] },
            typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
              ? { signal: AbortSignal.timeout(15000) }
              : undefined,
          );
          if (result?.isError) throw new Error("Host rejected ui/message.");
          return { method: "app.sendMessage", result: "accepted" };
        } catch (error) {
          officialError = error;
          if (!transientTransportFailure(error) || attempt === TRANSIENT_RETRY_DELAYS_MS.length - 1) break;
        }
      }
    }
    const fallback = typeof window !== "undefined" ? window.openai?.sendFollowUpMessage : undefined;
    if (typeof fallback === "function") {
      await ensureStillRunnable();
      try {
        await fallback({ prompt: text });
      } catch {
        await fallback({ role: "user", content: [{ type: "text", text }] });
      }
      return { method: "window.openai.sendFollowUpMessage", result: "fallback-accepted" };
    }
    throw officialError ?? new Error("The host exposes no supported follow-up messaging path.");
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
        if (typeof app.updateModelContext === "function") {
          await app.updateModelContext({
            content: [{ type: "text", text: continuationContext(state.task, state.workspaceId, reason) }],
          }).catch(() => undefined);
        }

        // A manual user turn may revoke this synthetic owner while the Host
        // context update above is in flight. Re-check the exact sender
        // capability/token immediately before the irreversible user-role send.
        // If ownership was superseded, do not enqueue a stale continuation.
        const authorized = await callSender("authorize-delivery", { deliveryToken, note: reason }).catch(() => undefined);
        if (!authorized?.accepted) return false;

        const delivery = await sendFollowUp(visibleContinuationTrigger(state.task), async () => {
          const latest = await callTask("status").catch(() => undefined);
          if (latest?.task) acceptTask(latest.task);
          return Boolean(state.task && !terminal(state.task) && !automationSuppressed(state.task));
        });
        const recorded = await callSender("delivery-result", {
          deliveryToken,
          result: delivery.result,
          method: delivery.method,
          note: reason,
        }).catch(() => undefined);
        if (recorded?.task) state.task = recorded.task;
        if (recorded?.accepted) {
          renderRecoveryStatus(
            controller,
            isChinese() ? "DevSpace 已请求自动续轮，正在等待新一轮确认连接；若公网连接失败会自动重试。" : "DevSpace requested an automatic continuation and is waiting for the resumed turn to acknowledge connectivity; transport failures will be retried.",
            "success",
            false,
          );
          // The server-resident Generation FSM owns retries from this point.
          // Keep the App supervisor alive so this verified card can act as the
          // Host ui/message transport whenever the server exposes a new READY
          // generation.
          return true;
        }
        return false;
      } catch (error) {
        const note = String(error?.message || error);
        if (note.includes("terminal-continuation-cancelled")) {
          await callSender("delivery-result", {
            deliveryToken,
            result: "failed",
            method: "app.sendMessage",
            note: "task became terminal before Host send",
          }).catch(() => undefined);
          return false;
        }
        await callSender("delivery-result", {
          deliveryToken,
          result: /reject/i.test(note) ? "rejected" : "failed",
          method: "app.sendMessage",
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
      if (await consumeReadyAfterSenderBind(
        rebound,
        "superseded card headless relay rebound with READY generation",
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

    // app.sendMessage acceptance is not proof that a resumed assistant turn
    // reached DevSpace. Keep retrying the same persisted continuation after its
    // ACK lease expires, for both process-wake and proactive continuations.
    if (state.task.continuationDeliveryAwaitingAck) {
      if (!deliveryAckRetryDue(state.task)) return;
      await attemptContinuation("delivery ACK retry", { force: true });
      return;
    }

    // Persisted process wakes are claimable by any surviving/recreated iframe.
    // This prevents a single watch-status winner from consuming the wake and
    // disappearing before claim/sendMessage while sibling App cards see nothing.
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
    if (state.wakeSource || state.disposed || typeof EventSource !== "function") return;
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
    if (!timersEnabled || terminal(state.task) || !senderTransportAvailable() || state.supervisorTimer || !state.task?.id) return;
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
          }
          state.anchorMountAcked = true;
        }
        if ((state.task?.continuationPending && !state.task?.continuationWakePending) || state.task?.state === "FAILED_RETRYABLE") {
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
        await consumeReadyAfterSenderBind(bound);
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
    if (/timeout|deadline|budget/i.test(reason)) {
      void (async () => {
        await recordHostSignal("timeout", reason);
        if (state.task?.continuationMode !== "compat" && hasUnfinishedMilestones(state.task)) {
          await attemptContinuation(`host timeout: ${reason}`, { force: true });
        }
      })();
      return;
    }
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
      await consumeReadyAfterSenderBind(bound, "sender transport connected with READY generation").catch(() => false);
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
      const timedOut = /timeout|deadline|budget/i.test(reason);
      // The MCP Apps SDK does not expose an assistant-final event and generic
      // resource teardown carries no reason payload. Therefore teardown alone
      // is never interpreted as model completion. If it does arrive after the
      // model signed ATCC for this exact turn lease, it is an immediate
      // confirmation fast path. Ordinary ChatGPT finals may emit no teardown at
      // all; the resident runtime separately promotes only the explicit signed
      // COMPLETION_REQUESTED lease after its guarded handoff grace. Explicit
      // Host timeout remains independently authoritative. GENERATING silence is
      // never converted into a completion signal by either path.
      const lifecycle = await recordHostSignal(timedOut ? "timeout" : "teardown", reason);
      if (lifecycle?.task) state.task = lifecycle.task;
      if (assistantTurnCompletionArmed(state.task) || timeoutRecoveryArmed(state.task)) {
        await attemptContinuation(
          state.task?.assistantTurnState === "TIMED_OUT"
            ? `ATCC Host timeout: ${reason}`
            : "ATCC normal assistant completion confirmed by Host teardown",
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
