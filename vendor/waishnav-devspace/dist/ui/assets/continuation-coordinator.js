const TASK_TOOL = "continuation_task";
const DEFAULT_SUPERVISOR_TICK_MS = 15_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000;

const TERMINAL_STATES = new Set([
  "SUCCEEDED",
  "FAILED_TERMINAL",
  "CANCELLED_BY_USER",
  "ABORTED_NO_PROGRESS",
  "BUDGET_EXHAUSTED",
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

function taskElapsedMs(task) {
  const raw = task?.turnStartedAt ?? task?.updatedAt;
  const started = Date.parse(raw || "");
  return Number.isFinite(started) ? Math.max(0, Date.now() - started) : 0;
}

function recommendedContinueAfterMs(task) {
  const value = Number(task?.recommendedContinueAfterMs);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function cancellationIsUserAction(reason) {
  return /user|manual|cancel|stop|abort/i.test(String(reason || "")) && !/timeout|deadline|budget/i.test(String(reason || ""));
}

function isChinese() {
  return typeof navigator !== "undefined" && String(navigator.language || "").toLowerCase().startsWith("zh");
}

function continuationText(task, reason) {
  const id = task?.id ? ` ${task.id}` : "";
  return `继续 DevSpace 任务${id}。上一轮因 ${reason} 需要续轮；恢复现有 workspace、processHandle、持久任务状态和已完成里程碑，不要重新开始。先读取 continuation_task status，再继续原始用户目标；只有原始目标经验证完成后才调用 complete 并结束。`;
}

function continuationContext(task, workspaceId, reason) {
  return [
    "DevSpace durable continuation state:",
    `taskId: ${task?.id ?? "unknown"}`,
    `workspaceId: ${workspaceId ?? task?.workspaceId ?? "unknown"}`,
    `state: ${task?.state ?? "unknown"}`,
    `objective: ${task?.objective ?? "Continue the original DevSpace request."}`,
    `completedMilestones: ${(task?.completedMilestones ?? []).join(" | ") || "none recorded"}`,
    `requiredMilestones: ${(task?.requiredMilestones ?? []).join(" | ") || "none recorded"}`,
    `continuationReason: ${reason}`,
    "Resume existing process handles and workspace state. Do not restart completed work.",
  ].join("\n");
}

function renderRecoveryStatus(controller, message, tone = "info", allowManual = false) {
  if (typeof document === "undefined") return;
  let node = document.getElementById("devspace-continuation-status");
  if (!node) {
    node = document.createElement("aside");
    node.id = "devspace-continuation-status";
    Object.assign(node.style, {
      position: "fixed",
      right: "10px",
      bottom: "10px",
      zIndex: "2147483000",
      maxWidth: "440px",
      padding: "8px 10px",
      border: "1px solid color-mix(in srgb, currentColor 20%, transparent)",
      borderRadius: "10px",
      background: "Canvas",
      color: "CanvasText",
      boxShadow: "0 4px 18px rgba(0,0,0,.14)",
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
    ensuringTask: undefined,
    supervisorTimer: undefined,
    lastHeartbeatAt: 0,
    deliveryInFlight: false,
    hostProfileId: undefined,
  };
  const supervisorTickMs = Math.max(250, Number(options.supervisorTickMs ?? DEFAULT_SUPERVISOR_TICK_MS));
  const heartbeatIntervalMs = Math.max(supervisorTickMs, Number(options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS));
  const timersEnabled = options.timers !== false;

  function buildHostProfileId() {
    const info = app.getHostVersion?.() ?? {};
    return `${safeProfilePart(info.name, "unknown-host")}@${safeProfilePart(info.version, "unknown-version")}`;
  }

  async function callTask(action, extra = {}) {
    if (!state.connected) throw new Error("DevSpace Workspace App is not connected to the host yet.");
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
    const outcome = normalizeTaskOutcome(result);
    if (outcome?.task) state.task = outcome.task;
    return outcome;
  }

  function stopSupervisor() {
    if (state.supervisorTimer) clearInterval(state.supervisorTimer);
    state.supervisorTimer = undefined;
  }

  async function heartbeat(note = "workspace-app") {
    if (!state.task?.id || terminal(state.task)) return;
    state.lastHeartbeatAt = Date.now();
    await callTask("heartbeat", { note }).catch(() => undefined);
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
      if (!state.task || terminal(state.task) || state.task.state === "WAITING_EXTERNAL") return false;
      const status = await callTask("status");
      if (status?.task) state.task = status.task;
      if (!state.task || terminal(state.task) || state.task.state === "WAITING_EXTERNAL") return false;
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

  async function sendFollowUp(text) {
    let officialError;
    if (typeof app.sendMessage === "function") {
      try {
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
      }
    }
    const fallback = typeof window !== "undefined" ? window.openai?.sendFollowUpMessage : undefined;
    if (typeof fallback === "function") {
      try {
        await fallback({ prompt: text });
      } catch {
        await fallback({ role: "user", content: [{ type: "text", text }] });
      }
      return { method: "window.openai.sendFollowUpMessage", result: "fallback-accepted" };
    }
    throw officialError ?? new Error("The host exposes no supported follow-up messaging path.");
  }

  async function attemptContinuation(reason, { force = false } = {}) {
    if (state.deliveryInFlight) return false;
    if (state.disposed && !force) return false;
    const recommended = recommendedContinueAfterMs(state.task);
    if (!force && (!recommended || taskElapsedMs(state.task) < recommended)) return false;
    state.deliveryInFlight = true;
    try {
      const prepared = await prepareContinuation(reason);
      if (!prepared || !state.task || terminal(state.task) || state.task.state === "WAITING_EXTERNAL") {
        stopSupervisor();
        return false;
      }
      const claim = await callTask("claim-continuation", { note: reason });
      if (!claim?.accepted) return false;
      if (claim.task) state.task = claim.task;
      try {
        const delivery = await sendFollowUp(continuationText(state.task, reason));
        await callTask("delivery-result", {
          deliveryResult: delivery.result,
          deliveryMethod: delivery.method,
          note: reason,
        }).catch(() => undefined);
        renderRecoveryStatus(controller, isChinese() ? "DevSpace 已请求自动续轮。" : "DevSpace requested an automatic continuation.", "success", false);
        stopSupervisor();
        return true;
      } catch (error) {
        const note = String(error?.message || error);
        await callTask("delivery-result", {
          deliveryResult: /reject/i.test(note) ? "rejected" : "failed",
          deliveryMethod: "app.sendMessage",
          note,
        }).catch(() => undefined);
        await callTask("release-continuation", { note }).catch(() => undefined);
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

  async function supervisorTick() {
    if (state.disposed || !state.task || terminal(state.task) || state.task.state === "WAITING_EXTERNAL") return;
    if (Date.now() - state.lastHeartbeatAt >= heartbeatIntervalMs) await heartbeat("adaptive supervisor");
    if (Array.isArray(state.task.watchProcessHandles) && state.task.watchProcessHandles.length > 0) {
      const watched = await callTask("watch-status").catch(() => undefined);
      if (watched?.task) state.task = watched.task;
      if (watched?.wakeReady) {
        await attemptContinuation("watched process completed", { force: true });
        return;
      }
    }
    const recommended = recommendedContinueAfterMs(state.task);
    if (recommended && taskElapsedMs(state.task) >= recommended) {
      await attemptContinuation("adaptive host-budget watchdog", { force: true });
    }
  }

  function startSupervisor() {
    if (!timersEnabled || state.supervisorTimer || !state.task || terminal(state.task) || state.task.state === "WAITING_EXTERNAL") return;
    state.supervisorTimer = setInterval(() => void supervisorTick(), supervisorTickMs);
    void supervisorTick();
  }

  async function ensureTask() {
    if (!state.connected || !state.workspaceId) return state.task;
    if (state.currentTool && state.currentTool !== "continuation_anchor" && !state.task?.id) return state.task;
    if (state.ensuringTask) return state.ensuringTask;
    state.ensuringTask = (async () => {
      try {
        if (!state.task?.id) {
          const outcome = await callTask("begin-auto", {
            objective: "Continue the current DevSpace work until the original user request is verified complete; preserve the existing workspace, process handles, milestones, and evidence across assistant turns.",
          });
          if (outcome?.task) state.task = outcome.task;
        }
        if (state.task?.continuationPending || state.task?.state === "FAILED_RETRYABLE") {
          const resumed = await callTask("resume");
          if (resumed?.task) state.task = resumed.task;
        }
        state.hostProfileId = state.hostProfileId ?? buildHostProfileId();
        await recordHostSignal("connected", "workspace-app connected");
        await heartbeat("anchor activity");
        startSupervisor();
        return state.task;
      } finally {
        state.ensuringTask = undefined;
      }
    })().catch(() => state.task);
    return state.ensuringTask;
  }

  function mergeContext(context) {
    const tool = toolFromContext(context);
    if (tool) state.currentTool = tool;
  }

  function onToolInput(params) {
    state.currentInput = { ...state.currentInput, ...(params?.arguments ?? {}) };
    if (state.currentInput.workspaceId) state.workspaceId = String(state.currentInput.workspaceId);
    void ensureTask();
  }

  function onToolResult(params) {
    state.currentTool = params?._meta?.tool ?? state.currentTool;
    state.workspaceId = workspaceFromResult(params) || state.workspaceId;
    const resultTask = taskFromResult(params);
    if (resultTask) state.task = resultTask;
    void ensureTask();
  }

  function onToolCancelled(params) {
    const reason = String(params?.reason || "cancelled");
    if (/timeout|deadline|budget/i.test(reason)) {
      void (async () => {
        await recordHostSignal("timeout", reason);
        await attemptContinuation(`host timeout: ${reason}`, { force: true });
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
    },
    ensureTask,
    prepareContinuation,
    attemptContinuation,
    async onTeardown(params) {
      if (state.disposed) return;
      const reason = String(params?.reason ?? "resource teardown");
      const timedOut = /timeout|deadline|budget/i.test(reason);
      await recordHostSignal(timedOut ? "timeout" : "teardown", reason);
      const recommended = recommendedContinueAfterMs(state.task);
      if (timedOut || (recommended && taskElapsedMs(state.task) >= recommended)) {
        await attemptContinuation(timedOut ? `host teardown: ${reason}` : "adaptive teardown recovery", { force: true });
      }
      controller.dispose();
    },
    dispose() {
      if (state.disposed) return;
      state.disposed = true;
      stopSupervisor();
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
