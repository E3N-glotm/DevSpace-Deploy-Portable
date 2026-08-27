const TASK_TOOL = "continuation_task";
const DEFAULT_SUPERVISOR_TICK_MS = 15_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000;
const CONFIRMED_TURN_LIMIT_TEARDOWN_GRACE_MS = 5_000;
const CONFIRMED_TURN_LIMIT_RECOVERY_GRACE_MS = 20_000;
const CONFIRMED_TURN_LIMIT_MODEL_QUIET_MS = 30_000;
// A resumed ChatGPT turn can be created before its MCP connector has fully
// rehydrated. Keep retrying the same idempotent control call across roughly a
// 30-second readiness window instead of giving up after ~8 seconds.
const TRANSIENT_RETRY_DELAYS_MS = [0, 750, 2_000, 5_000, 8_000, 12_000];

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
  return completionActivityLeaseExpired(task)
    && task?.syntheticResumeWorkRequired === true
    && Boolean(task?.deliveryToken);
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

function continuationText(task, reason) {
  const id = task?.id ? ` ${task.id}` : "";
  const workspace = task?.workspaceId ? `，workspaceId=${task.workspaceId}` : "";
  return `继续执行用户尚未完成的 DevSpace 任务${id}${workspace}；这是已授权的恢复续轮，不要等待新的用户指令，不要新建任务。第一项业务动作必须调用 continuation_task action=status，并传入同一个 taskId${task?.workspaceId ? " 和 workspaceId" : ""}。若 status 暂时出现 UNAVAILABLE/Connection failed/fetch/ECONN/TLS/handshake/timeout，只重试同一个 status 直到约 30 秒 readiness 窗口结束。status 成功后：若 continueRequired=true 或 finalResponseAllowed=false，禁止输出 ACK、状态汇报或进度总结，必须立刻调用实际 DevSpace 工具执行 nextRequiredMilestones/remainingMilestones；本轮至少完成一次非 continuation 控制类的 substantive DevSpace 工具工作，或进入真实 WAITING_EXTERNAL，或验证完成并 complete。若 reanchorRequired=true，先用同一个 taskId/workspaceId 调 continuation_anchor，再立即继续实际工作。上一轮恢复原因：${reason}。`;
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
    "This is an authorized recovery of the user's already-active unfinished Task Contract. Do not wait for a new user instruction and do not treat the synthetic Workspace App message as non-actionable. completion-driven mode is an explicit Task Contract completion guard. Model-side DevSpace activity renews an activity lease, but lease expiry is only a weak SUSPECTED_STALL signal and never creates a new turn by itself. A continuation requires independent Host/lifecycle evidence that arms CONTINUATION_ARMED. timeout-recovery remains fail-closed before a proven Host cutoff, and resident additionally permits explicit stage/process wakes. Learned budgets and ordinary process completion never trigger completion-driven/timeout-recovery tasks. The resumed turn must prove MCP readiness with continuation_task status before side-effecting work. Transient UNAVAILABLE/Connection failed/TLS/fetch errors immediately after app.sendMessage are a connector-readiness race: retry the same status across an increasing-backoff readiness window instead of concluding the service is down or asking the user to continue manually. If status returns continueRequired=true or finalResponseAllowed=false, do not stop after ACK, re-anchor, or a status summary. Continue real tool work in the same assistant turn and checkpoint progress. If reanchorRequired=true, re-mount continuation_anchor with the same taskId/workspaceId first. Resume existing process handles and workspace state. Do not restart completed work.",
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
    ensuringTask: undefined,
    supervisorTimer: undefined,
    lastHeartbeatAt: 0,
    deliveryInFlight: false,
    supervisorTickInFlight: false,
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
        if (outcome?.task) {
          state.task = outcome.task;
          publishTaskForCard(state.task);
        }
        return outcome;
      } catch (error) {
        lastError = error;
        if (!transientTransportFailure(error) || attempt === TRANSIENT_RETRY_DELAYS_MS.length - 1) throw error;
      }
    }
    throw lastError ?? new Error("DevSpace continuation transport retry exhausted.");
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
      if (!state.task || terminal(state.task) || automationSuppressed(state.task)) return false;
      const status = await callTask("status");
      if (status?.task) state.task = status.task;
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

  async function sendFollowUp(text) {
    let officialError;
    if (typeof app.sendMessage === "function") {
      for (let attempt = 0; attempt < TRANSIENT_RETRY_DELAYS_MS.length; attempt += 1) {
        if (TRANSIENT_RETRY_DELAYS_MS[attempt] > 0) await sleep(TRANSIENT_RETRY_DELAYS_MS[attempt]);
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
          if (!transientTransportFailure(error) || attempt === TRANSIENT_RETRY_DELAYS_MS.length - 1) break;
        }
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
      const claim = await callTask("claim-continuation", { note: reason });
      if (!claim?.accepted) return false;
      if (claim.task) state.task = claim.task;
      const deliveryToken = claim.deliveryToken ?? claim.task?.deliveryToken;
      try {
        const tokenInstruction = deliveryToken
          ? `\n\nDevSpace continuation deliveryToken=${deliveryToken}. The first continuation_task status call in this synthetic resumed turn MUST include exactly this deliveryToken. If status returns synthetic-continuation-superseded, a newer manual/user turn took ownership: stop this synthetic turn immediately and do not execute or replay side effects.`
          : "";
        const delivery = await sendFollowUp(continuationText(state.task, reason) + tokenInstruction);
        const recorded = await callTask("delivery-result", {
          deliveryResult: delivery.result,
          deliveryMethod: delivery.method,
          note: reason,
        }).catch(() => undefined);
        if (recorded?.task) state.task = recorded.task;
        if (state.task?.continuationDeliveryAwaitingAck) {
          renderRecoveryStatus(
            controller,
            isChinese() ? "DevSpace 已请求自动续轮，正在等待新一轮确认连接；若公网连接失败会自动重试。" : "DevSpace requested an automatic continuation and is waiting for the resumed turn to acknowledge connectivity; transport failures will be retried.",
            "success",
            false,
          );
          // Do not stop the supervisor yet. State 4 keeps the durable wake alive
          // until the resumed model performs its first continuation_task status
          // ACK. If that new turn dies on an MCP UNAVAILABLE error, the claim
          // lease expires and this surviving App can resend automatically.
          return true;
        }
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

  async function supervisorTickImpl() {
    if (state.disposed || !state.task || terminal(state.task)) return;

    // The assistant registers watch-process through a headless continuation_task
    // call after the continuation_anchor has already rendered. That later tool
    // result is not guaranteed to be delivered to the existing Workspace App,
    // so refresh authoritative task state before deciding whether anything is
    // being watched. Without this refresh the App can cache an empty watch list
    // forever even though the server has a durable process handle registered.
    const current = await callTask("status").catch(() => undefined);
    if (current?.task) state.task = current.task;
    if (!state.task || terminal(state.task)) return;
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
    // call reached DevSpace.  Keep the already-authorized continuation
    // obligation durable until the model performs a real non-control DevSpace
    // operation.  If that obligation survives the normal model Turn Lease,
    // retry it as a failed resumed turn rather than inventing a new Host cutoff.
    if (syntheticResumeWorkRetryDue(state.task)) {
      await attemptContinuation("synthetic resume work lease expired", { force: true });
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
      // P0 two-phase guard: model inactivity alone is not proof that ChatGPT
      // ended the assistant turn. Ask the server to persist SUSPECTED_STALL;
      // this heartbeat is only a liveness probe and cannot authorize delivery.
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
    if (state.task?.continuationMode !== "completion-driven" && confirmedCutoffRecoveryReady(state.task)) {
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

  async function supervisorTick() {
    if (state.supervisorTickInFlight) return;
    state.supervisorTickInFlight = true;
    try {
      await supervisorTickImpl();
    } finally {
      state.supervisorTickInFlight = false;
    }
  }

  function startSupervisor() {
    // Keep a lightweight supervisor alive for non-terminal waiting tasks too. A
    // watch-process registration may arrive after the anchor is mounted, and a
    // stopped timer would otherwise never discover that new server-side watch.
    if (!timersEnabled || state.supervisorTimer || !state.task || terminal(state.task)) return;
    state.supervisorTimer = setInterval(() => void supervisorTick(), supervisorTickMs);
    void supervisorTick();
  }

  async function ensureTask() {
    if (!state.connected || !state.workspaceId) return state.task;
    if (state.currentTool && state.currentTool !== "continuation_anchor" && !state.task?.id) return state.task;
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
        if ((state.task?.continuationPending && !state.task?.continuationWakePending) || state.task?.state === "FAILED_RETRYABLE") {
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
    const previousTaskId = state.currentInput?.taskId ? String(state.currentInput.taskId) : undefined;
    state.currentInput = { ...state.currentInput, ...(params?.arguments ?? {}) };
    if (state.currentInput.workspaceId) state.workspaceId = String(state.currentInput.workspaceId);
    const nextTaskId = state.currentInput?.taskId ? String(state.currentInput.taskId) : undefined;
    if (nextTaskId && previousTaskId && nextTaskId !== previousTaskId) {
      stopSupervisor();
      state.task = undefined;
      state.lastHeartbeatAt = 0;
    }
    void ensureTask();
  }

  function onToolResult(params) {
    state.currentTool = params?._meta?.tool ?? state.currentTool;
    state.workspaceId = workspaceFromResult(params) || state.workspaceId;
    const resultTask = taskFromResult(params);
    if (resultTask) {
      state.task = resultTask;
      publishTaskForCard(state.task);
    }
    void ensureTask();
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
      // Resource teardown is not proof that ChatGPT truncated the model turn.
      // It can happen during ordinary iframe replacement, navigation, UI asset
      // refresh, or connector lifecycle churn. Fail closed unless the Host
      // explicitly reports timeout/deadline/budget, or the persisted confirmed
      // cutoff lower bound + recovery grace + model-quiet gate has elapsed.
      const confirmedLimitElapsed = !timedOut && confirmedCutoffRecoveryReady(state.task);
      if ((timedOut || confirmedLimitElapsed)
        && state.task?.continuationMode !== "compat"
        && state.task?.state === "RUNNING"
        && hasUnfinishedMilestones(state.task)) {
        await recordHostSignal(timedOut ? "timeout" : "teardown", reason);
        await attemptContinuation(
          timedOut ? `host teardown: ${reason}` : "confirmed turn-limit teardown",
          { force: true },
        );
      } else {
        await recordHostSignal(timedOut ? "timeout" : "teardown", reason);
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
