const TASK_TOOL = "continuation_task";
const SENDER_TOOL = "continuation_sender";
const DEFAULT_SUPERVISOR_TICK_MS = 5_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000;
const DEFAULT_TERMINAL_REFRESH_MS = 60_000;
const CONFIRMED_TURN_LIMIT_TEARDOWN_GRACE_MS = 5_000;
const CONFIRMED_TURN_LIMIT_RECOVERY_GRACE_MS = 20_000;
const CONFIRMED_TURN_LIMIT_MODEL_QUIET_MS = 30_000;
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

function confirmedCutoffRecoveryReady(task) {
  if (!task || task.state !== "RUNNING" || task.continuationMode === "compat" || !hasUnfinishedMilestones(task)) return false;
  const confirmedLimitMs = Number(task.confirmedTurnLimitMs || 0);
  if (confirmedLimitMs < 30_000) return false;
  if (taskElapsedMs(task) < confirmedLimitMs + CONFIRMED_TURN_LIMIT_RECOVERY_GRACE_MS) return false;
  const lastModelAt = Date.parse(task.lastModelActivityAt || "");
  if (!Number.isFinite(lastModelAt)) return false;
  return Date.now() - lastModelAt >= CONFIRMED_TURN_LIMIT_MODEL_QUIET_MS;
}

function completionActivityLeaseExpired(task) {
  if (!completionDrivenTask(task) || task?.state !== "RUNNING" || !hasUnfinishedMilestones(task)) return false;
  const expiresAt = Date.parse(task.turnLeaseExpiresAt || "");
  return Number.isFinite(expiresAt) && Date.now() >= expiresAt;
}

function syntheticResumeWorkRetryDue(task) {
  if (!completionDrivenTask(task) || task?.state !== "RUNNING" || !hasUnfinishedMilestones(task)) return false;
  if (task?.syntheticResumeWorkRequired !== true) return false;
  // The resumed synthetic turn has a dedicated work-ownership lease after its
  // connectivity status ACK. This lease answers only whether the synthetic
  // owner ever progressed beyond control traffic; it is not a task-completion
  // timer. Prefer it over the generic model Turn Lease so a short status-only
  // turn can be retried sooner without lowering the normal stall threshold.
  const workOwnerExpiresAt = Date.parse(task?.deliveryOwnerExpiresAt || "");
  if (Number.isFinite(workOwnerExpiresAt)) return Date.now() >= workOwnerExpiresAt;
  // Backward compatibility for persisted tasks created before the dedicated
  // synthetic ownership lease existed.
  return completionActivityLeaseExpired(task);
}

function completionStallArmed(task) {
  return completionDrivenTask(task)
    && task?.state === "RUNNING"
    && hasUnfinishedMilestones(task)
    && task?.stallState === "CONTINUATION_ARMED";
}

function cancellationIsUserAction(reason) {
  return /user|manual|cancel|stop|abort/i.test(String(reason || "")) && !/timeout|deadline|budget/i.test(String(reason || ""));
}

function isChinese() {
  return typeof navigator !== "undefined" && String(navigator.language || "").toLowerCase().startsWith("zh");
}

function visibleContinuationTrigger() {
  // app.sendMessage is the Host-supported way to create the resumed model turn,
  // so a short visible user-role message is still required. Keep it equivalent
  // to the owner's normal manual continuation instead of adding urgency or a
  // "complete directly" bias. Ownership and generation fencing remain
  // entirely server-side and never enter chat history.
  return isChinese() ? "继续" : "Continue.";
}

function continuationContext(task, workspaceId, reason) {
  const lines = [
    "DevSpace durable continuation state:",
    `taskId: ${task?.id ?? "unknown"}`,
    `workspaceId: ${workspaceId ?? task?.workspaceId ?? "unknown"}`,
    `state: ${task?.state ?? "unknown"}`,
    `objective: ${task?.objective ?? "Continue the original DevSpace request."}`,
    `completedMilestones: ${(task?.completedMilestones ?? []).join(" | ") || "none recorded"}`,
    `requiredMilestones: ${(task?.requiredMilestones ?? []).join(" | ") || "none recorded"}`,
    `continuationReason: ${reason}`,
    "Before acting, reconstruct the current durable state from this Task Contract and the latest available DevSpace evidence. Verify which milestones are actually complete, identify the next unresolved runnable milestone, and check relevant failure, race, or regression risks before choosing the next action. Keep that evaluation internal: do not emit a chain-of-thought transcript, and do not substitute a plan/status-only response for execution.",
    "Call continuation_task status first. The runtime atomically claims any server-owned expected synthetic generation; do not search for, expose, or pass a continuation token to ordinary tools. Then continue substantive work with the same sustained execution semantics as a manual 'continue': keep reading, editing, executing, validating, and polling owned long-running processes until the current milestones are complete, genuinely externally blocked, explicitly paused/cancelled, or the Host truncates the turn. A checkpoint persists progress but never permits an early final while runnable milestones remain. Reuse the one conversation-lifetime task/card and existing process/workspace state.",
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
    senderCapability: undefined,
    ensuringTask: undefined,
    supervisorTimer: undefined,
    lifecycleRefreshTimer: undefined,
    lifecycleCleanup: undefined,
    lastHeartbeatAt: 0,
    lastTerminalRefreshAt: 0,
    deliveryInFlight: false,
    supervisorTickInFlight: false,
    hostProfileId: undefined,
    hostContext: undefined,
    displayModeRequestInFlight: false,
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
    if (state.senderCapability?.taskId === state.task?.id
      && state.senderCapability?.conversationScopeId === state.task?.conversationScopeId) {
      return state.senderCapability;
    }
    if (state.anchorSurface && state.task?.id && state.task?.conversationScopeId && state.anchorMountToken && state.anchorMountGeneration) {
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
    if (state.disposed || state.anchorSuperseded || terminal(state.task) || !senderTransportAvailable() || !state.task?.id) return;
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
    state.anchorSuperseded = true;
    state.anchorMountToken = undefined;
    state.anchorMountAcked = false;
    stopSupervisor();
    stopLifecycleRefresh();
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
    if (state.anchorSurface && state.task?.anchorMountVerifiedAt) {
      await callTask("heartbeat", { note }).catch(() => undefined);
    } else {
      await callSender("heartbeat", { note }).catch(() => undefined);
    }
  }

  async function recordHostSignal(hostSignal, note) {
    if (!state.task?.id || terminal(state.task)) return undefined;
    const outcome = await callTask("host-signal", {
      hostProfileId: state.hostProfileId ?? buildHostProfileId(),
      hostSignal,
      elapsedMs: Math.round(taskElapsedMs(state.task)),
      note,
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
      if (state.anchorSuperseded) return false;
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
      if (state.anchorSuperseded) return false;
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

        const delivery = await sendFollowUp(visibleContinuationTrigger(), async () => {
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
    if (state.disposed || !senderTransportAvailable() || !state.task?.id) return;
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
    if (state.anchorSuperseded) return;
    if (!state.task || terminal(state.task)) {
      state.lastTerminalRefreshAt = Date.now();
      stopSupervisor();
      stopLifecycleRefresh();
      return;
    }
    state.lastTerminalRefreshAt = 0;
    if (state.task.state === "PAUSED_BY_USER") return;

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

    // A synthetic resumed turn is not healthy merely because its first status
    // call reached DevSpace. Keep the already-authorized continuation
    // obligation durable until the model performs a real non-control DevSpace
    // operation. Prefer its dedicated work-ownership lease; the generic model
    // Turn Lease remains only a compatibility fallback. Elapsed time never
    // marks the task complete: milestones and substantive work still do.
    if (syntheticResumeWorkRetryDue(state.task)) {
      await attemptContinuation("synthetic resume work ownership lease expired", { force: true });
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
    if (completionStallArmed(state.task)) {
      await attemptContinuation("task contract stall corroborated", { force: true });
      return;
    }
    if (confirmedCutoffRecoveryReady(state.task)) {
      // This is deliberately NOT a generic silence/learned-budget watchdog. It
      // is available only after a user/Owner-confirmed real Host cutoff lower
      // bound has already elapsed, plus a grace period and model quiet window.
      // It covers hosts that visibly truncate the assistant turn but omit both
      // toolcancelled timeout and resource-teardown reason signals.
      await attemptContinuation("confirmed turn-limit lease expired", { force: true });
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

  function startSupervisor() {
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

  const controller = {
    state,
    async onConnected() {
      if (state.disposed) return;
      state.connected = true;
      state.hostProfileId = buildHostProfileId();
      mergeContext(app.getHostContext?.());
      await ensureTask();
      await bindSenderTransport().catch(() => undefined);
      await syncPersistentDisplayMode();
      await heartbeat("sender transport connected").catch(() => undefined);
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
      if (!state.anchorSurface) {
        // Ordinary tool-result Apps may act as transport relays, but their UI
        // teardown says only that this relay iframe is going away. It is not
        // evidence that the assistant turn ended, so never arm recovery from it.
        controller.dispose();
        return;
      }
      const reason = String(params?.reason ?? "resource teardown");
      const timedOut = /timeout|deadline|budget/i.test(reason);
      const completionRecoveryCandidate = completionDrivenTask(state.task)
        && state.task?.state === "RUNNING"
        && hasUnfinishedMilestones(state.task)
        && state.anchorSurface
        && Boolean(state.task?.anchorMountVerifiedAt);
      // Explicit Host timeout/deadline/budget is authoritative and may recover
      // immediately. A generic teardown is weaker: persist it, wait a short
      // grace window, then recover only if no replacement iframe has connected
      // and no newer model activity has appeared. A replacement App writes a
      // later "connected" Host signal and therefore cancels the old iframe's
      // recovery. This covers ordinary assistant completion without confusing
      // same-conversation iframe replacement with a stopped model turn.
      const teardown = await recordHostSignal(timedOut ? "timeout" : "teardown", reason);
      if (timedOut
        && state.task?.continuationMode !== "compat"
        && state.task?.state === "RUNNING"
        && hasUnfinishedMilestones(state.task)) {
        await attemptContinuation(`host teardown: ${reason}`, { force: true });
        controller.dispose();
        return;
      }
      const confirmedLimitElapsed = confirmedCutoffRecoveryReady(state.task);
      if (confirmedLimitElapsed
        && state.task?.continuationMode !== "compat"
        && state.task?.state === "RUNNING"
        && hasUnfinishedMilestones(state.task)) {
        await attemptContinuation("confirmed turn-limit teardown", { force: true });
        controller.dispose();
        return;
      }
      if (completionRecoveryCandidate && teardown?.task?.lastHostSignal === "teardown") {
        const teardownSignalAt = Date.parse(teardown.task.lastHostSignalAt || "");
        const modelActivityAtTeardown = Date.parse(teardown.task.lastModelActivityAt || "");
        await sleep(CONFIRMED_TURN_LIMIT_TEARDOWN_GRACE_MS);
        const current = await callTask("status").catch(() => undefined);
        if (current?.task) state.task = current.task;
        const authoritativeSignalAt = Date.parse(state.task?.lastHostSignalAt || "");
        const authoritativeModelAt = Date.parse(state.task?.lastModelActivityAt || "");
        const sameTeardownStillAuthoritative = state.task?.lastHostSignal === "teardown"
          && Number.isFinite(teardownSignalAt)
          && Number.isFinite(authoritativeSignalAt)
          && authoritativeSignalAt === teardownSignalAt;
        const noNewModelActivity = !Number.isFinite(authoritativeModelAt)
          || !Number.isFinite(modelActivityAtTeardown)
          || authoritativeModelAt <= Math.max(modelActivityAtTeardown, teardownSignalAt + 1_000);
        if (sameTeardownStillAuthoritative
          && noNewModelActivity
          && completionDrivenTask(state.task)
          && state.task?.state === "RUNNING"
          && hasUnfinishedMilestones(state.task)) {
          await attemptContinuation("verified surface teardown", { force: true });
        }
      }
      controller.dispose();
    },
    dispose() {
      if (state.disposed) return;
      state.disposed = true;
      stopSupervisor();
      stopLifecycleRefresh();
      app.removeEventListener?.("toolinput", onToolInput);
      app.removeEventListener?.("toolinputpartial", onToolInput);
      app.removeEventListener?.("toolresult", onToolResult);
      app.removeEventListener?.("toolcancelled", onToolCancelled);
      app.removeEventListener?.("hostcontextchanged", onHostContextChanged);
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
