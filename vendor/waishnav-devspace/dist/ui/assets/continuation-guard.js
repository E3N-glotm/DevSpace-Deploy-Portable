const ARM_AFTER_MS = 24.5 * 60 * 1000;
const FORCE_AFTER_MS = 25.75 * 60 * 1000;
const TASK_TOOL = "continuation_task";
const DRIVING_TOOLS = new Set([
  "open_workspace",
  "exec_command",
  "write_stdin",
  "process_attach",
  "process_kill",
  "apply_patch",
  "write",
  "edit",
  "bash",
]);

const pending = new Map();
let nextId = 1;
let hostCapabilities;
let currentTool;
let currentInput = {};
let workspaceId;
let task;
let ensuringTask;
let armTimer;
let forceTimer;
let armed = false;
let tornDown = false;

function postRequest(method, params, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const id = `devspace-continuation-${nextId++}`;
    const timer = window.setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        window.clearTimeout(timer);
        reject(error);
      },
    });
    window.parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
  });
}

async function callTask(action, extra = {}) {
  const response = await postRequest("tools/call", {
    name: TASK_TOOL,
    arguments: {
      action,
      ...(task?.id ? { taskId: task.id } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      ...extra,
    },
  }, 20000);
  const structured = response?.structuredContent ?? response;
  const outcome = structured?.task || structured?.accepted !== undefined
    ? structured
    : (() => {
        try {
          const text = response?.content?.find((item) => item?.type === "text")?.text;
          return text ? JSON.parse(text) : {};
        } catch {
          return {};
        }
      })();
  if (outcome?.task) task = outcome.task;
  return outcome;
}

function clearWatchdog() {
  if (armTimer) window.clearTimeout(armTimer);
  if (forceTimer) window.clearTimeout(forceTimer);
  armTimer = undefined;
  forceTimer = undefined;
}

function terminalState(value) {
  return ["SUCCEEDED", "FAILED_TERMINAL", "CANCELLED_BY_USER", "ABORTED_NO_PROGRESS", "BUDGET_EXHAUSTED"].includes(value);
}

function scheduleWatchdog() {
  clearWatchdog();
  if (!task || terminalState(task.state) || task.state === "WAITING_EXTERNAL") return;
  const turnStart = Date.parse(task.turnStartedAt || task.updatedAt || new Date().toISOString());
  const elapsed = Math.max(0, Date.now() - (Number.isFinite(turnStart) ? turnStart : Date.now()));
  const armDelay = Math.max(0, ARM_AFTER_MS - elapsed);
  const forceDelay = Math.max(0, FORCE_AFTER_MS - elapsed);
  armTimer = window.setTimeout(async () => {
    armed = true;
    try {
      const status = await callTask("status");
      if (status?.task) task = status.task;
      if (!task || terminalState(task.state) || task.state === "WAITING_EXTERNAL") {
        armed = false;
        clearWatchdog();
      }
    } catch {
      // The force timer remains as a bounded fallback; it will re-check state.
    }
  }, armDelay);
  forceTimer = window.setTimeout(() => {
    armed = true;
    void attemptContinuation("watchdog");
  }, forceDelay);
}

async function ensureTask() {
  if (!workspaceId || !DRIVING_TOOLS.has(currentTool || "")) return task;
  if (ensuringTask) return ensuringTask;
  ensuringTask = (async () => {
    try {
      const outcome = await callTask("begin-auto", {
        objective: "Continue the current DevSpace work until the original user request is verified complete; preserve existing workspace and process state across assistant turns.",
      });
      if (outcome?.task) task = outcome.task;
      if (task?.continuationPending || task?.state === "FAILED_RETRYABLE") {
        const resumed = await callTask("resume");
        if (resumed?.task) task = resumed.task;
      }
      scheduleWatchdog();
      return task;
    } catch {
      return task;
    } finally {
      ensuringTask = undefined;
    }
  })();
  return ensuringTask;
}

function continuationText(reason) {
  const id = task?.id ? ` ${task.id}` : "";
  return `继续 DevSpace 任务${id}。上一轮因 ${reason} 需要续轮；恢复现有 workspace、processHandle、持久任务状态和已完成里程碑，不要重新开始。先读取 continuation_task status，再继续原始用户目标；只有目标经验证完成后才调用 complete 并结束。`;
}

async function sendFollowUp(text) {
  if (hostCapabilities?.message) {
    await postRequest("ui/message", {
      role: "user",
      content: [{ type: "text", text }],
    }, 15000);
    return "ui/message";
  }
  const fallback = window.openai?.sendFollowUpMessage;
  if (typeof fallback === "function") {
    try {
      await fallback({ prompt: text });
    } catch {
      await fallback({ role: "user", content: [{ type: "text", text }] });
    }
    return "sendFollowUpMessage";
  }
  throw new Error("Host exposes neither ui/message nor sendFollowUpMessage");
}

async function attemptContinuation(reason) {
  if (!armed || tornDown && reason !== "resource-teardown") return false;
  try {
    await ensureTask();
    if (!task) return false;
    const status = await callTask("status");
    if (status?.task) task = status.task;
    if (!task || terminalState(task.state) || task.state === "WAITING_EXTERNAL") {
      armed = false;
      clearWatchdog();
      return false;
    }
    const claim = await callTask("claim-continuation", { note: reason });
    if (!claim?.accepted) return false;
    if (claim.task) task = claim.task;
    try {
      await sendFollowUp(continuationText(reason));
      clearWatchdog();
      return true;
    } catch (error) {
      await callTask("release-continuation", { note: String(error?.message || error) }).catch(() => undefined);
      return false;
    }
  } catch {
    return false;
  }
}

function workspaceFromResult(params) {
  return params?.structuredContent?.workspaceId
    || params?._meta?.card?.workspaceId
    || params?.structuredContent?.result?.workspaceId;
}

function cancellationIsUserAction(reason) {
  return /user|manual|cancel|stop|abort/i.test(String(reason || "")) && !/timeout/i.test(String(reason || ""));
}

function mergeHostContext(value) {
  const context = value?.hostContext ?? value;
  const toolName = context?.toolInfo?.tool?.name;
  if (typeof toolName === "string") currentTool = toolName;
}

function handleMessage(message) {
  if (!message || message.jsonrpc !== "2.0") return;
  if (message.id !== undefined && pending.has(String(message.id))) {
    const waiter = pending.get(String(message.id));
    pending.delete(String(message.id));
    if (message.error) waiter.reject(new Error(message.error.message || "Host request failed"));
    else waiter.resolve(message.result);
    return;
  }
  if (message.result?.hostCapabilities) {
    hostCapabilities = message.result.hostCapabilities;
  }
  if (message.result?.hostContext) mergeHostContext(message.result.hostContext);
  if (message.method === "ui/initialize" && message.params?.hostCapabilities) {
    hostCapabilities = message.params.hostCapabilities;
  }
  if (message.method === "ui/initialize") mergeHostContext(message.params);
  if (message.method === "ui/notifications/host-context-changed") mergeHostContext(message.params);
  if (message.method === "ui/notifications/tool-input" || message.method === "ui/notifications/tool-input-partial") {
    currentInput = { ...currentInput, ...(message.params?.arguments ?? {}) };
    workspaceId = currentInput.workspaceId || workspaceId;
    void ensureTask();
    return;
  }
  if (message.method === "ui/notifications/tool-result") {
    currentTool = message.params?._meta?.tool ?? currentTool;
    workspaceId = workspaceFromResult(message.params) || workspaceId;
    void ensureTask();
    return;
  }
  if (message.method === "ui/notifications/tool-cancelled") {
    const reason = String(message.params?.reason || "cancelled");
    if (/timeout/i.test(reason)) {
      armed = true;
      void attemptContinuation("host timeout");
    } else if (cancellationIsUserAction(reason) && task?.id) {
      armed = false;
      clearWatchdog();
      void callTask("cancel", { note: reason });
    }
    return;
  }
  if (message.method === "ui/resource-teardown") {
    tornDown = true;
    if (armed) void attemptContinuation("resource teardown");
  }
}

window.addEventListener("message", (event) => {
  if (event.source !== window.parent) return;
  handleMessage(event.data);
});

// The bundled workspace App performs the official ui/initialize handshake.
// This script intentionally piggybacks on that same iframe rather than
// inventing a second protocol stack.  It stays visually collapsed and only
// issues server-tool/ui-message requests after host initialization traffic is
// observed.
window.addEventListener("beforeunload", () => {
  tornDown = true;
});
