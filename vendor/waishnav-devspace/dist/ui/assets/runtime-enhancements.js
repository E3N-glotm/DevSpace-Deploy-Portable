const root = document.querySelector("#app");

const RUNTIME_TOOLS = new Set([
  "exec_command",
  "write_stdin",
  "process_attach",
  "process_kill",
  "bash",
]);
const REVIEW_TOOLS = new Set(["apply_patch", "show_changes", "session_changes", "write", "edit"]);
// Keep the conversation milestone surface single-entry. Ordinary tools,
// including open_workspace, stay headless so repeated calls cannot create a
// second ChatGPT card for the same conversation.
const CONTINUATION_TOOLS = new Set(["continuation_anchor"]);
const ZH = String(navigator.language || "").toLowerCase().startsWith("zh");

const state = {
  tool: undefined,
  input: {},
  result: undefined,
  mode: undefined,
  cancelled: undefined,
  continuationTask: undefined,
};

const pendingServerCalls = new Map();
let nextServerCallId = 1;
let reviewLoadTimer;

let renderScheduled = false;
let rendering = false;

function element(tag, options = {}) {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = String(options.text);
  if (options.title) node.title = options.title;
  return node;
}

function callServerTool(name, args) {
  const app = window.__DEVSPACE_MCP_APP__;
  if (app && typeof app.callServerTool === "function") {
    return app.callServerTool({ name, arguments: args });
  }
  return new Promise((resolve, reject) => {
    const id = `devspace-ui-${nextServerCallId++}`;
    const timeout = window.setTimeout(() => {
      pendingServerCalls.delete(id);
      reject(new Error(`Timed out calling ${name}.`));
    }, 30000);
    pendingServerCalls.set(id, {
      resolve: (value) => {
        window.clearTimeout(timeout);
        resolve(value);
      },
      reject: (error) => {
        window.clearTimeout(timeout);
        reject(error);
      },
    });
    window.parent.postMessage({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    }, "*");
  });
}

function redactText(value) {
  return String(value ?? "")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer <redacted>")
    .replace(/([?&](?:token|access_token|auth|key|secret|password)=)[^&#\s]+/gi, "$1<redacted>")
    .replace(/((?:password|passwd|pwd|token|secret|authorization|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi, "$1<redacted>")
    .replace(/(--(?:password|passwd|token|secret|api-key)\s+)("[^"]*"|'[^']*'|\S+)/gi, "$1<redacted>");
}

function quoteArgument(value) {
  const text = String(value);
  if (!text) return '""';
  return /[\s"&|<>^]/.test(text) ? JSON.stringify(text) : text;
}

function commandFromInput(input = {}) {
  if (typeof input.cmd === "string") return redactText(input.cmd);
  if (Array.isArray(input.argv)) return redactText(input.argv.map(quoteArgument).join(" "));
  return "";
}

function toolFromHostContext(context) {
  const name = context?.toolInfo?.tool?.name;
  return typeof name === "string" ? name : undefined;
}

function mergeHostContext(params) {
  const context = params?.hostContext ?? params;
  const tool = toolFromHostContext(context);
  if (tool) state.tool = tool;
}

function toolResultCard(result) {
  const structured = result?.structuredContent;
  const card = result?._meta?.card;
  if (card && typeof card === "object") return { ...(structured ?? {}), ...card };
  return structured && typeof structured === "object" ? structured : {};
}

function textContent(blocks) {
  return (blocks ?? [])
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n\n");
}

function formatDuration(value) {
  if (!Number.isFinite(value)) return undefined;
  if (value < 1000) return `${Math.round(value)} ms`;
  return `${(value / 1000).toFixed(value < 10000 ? 1 : 0)} s`;
}

function durationPhrase(value) {
  const formatted = formatDuration(value);
  if (!formatted) return undefined;
  return ZH ? `已在 ${formatted} 内` : `in ${formatted}`;
}

function runtimeSummary(status, command, duration) {
  const label = (() => {
    if (status.tone === "running") return ZH ? "正在运行" : "Running";
    if (status.tone === "cancelled") return ZH ? "已取消" : "Cancelled";
    if (status.tone === "failed") return ZH ? "运行失败" : "Failed";
    const phrase = durationPhrase(duration);
    return ZH ? `${phrase || "已"}运行` : `Ran ${phrase || ""}`.trim();
  })();
  return { label, command: command || state.tool || (ZH ? "进程操作" : "Process operation") };
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return "";
  const units = ["B", "KB", "MB", "GB"];
  let amount = Number(value);
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index += 1;
  }
  return `${amount.toFixed(index === 0 || amount >= 10 ? 0 : 1)} ${units[index]}`;
}

function statusFromRuntime(runtime = {}) {
  if (state.cancelled) return { label: "Cancelled", tone: "cancelled" };
  if (runtime.running === true) return { label: "Running", tone: "running" };
  if (runtime.signal) return { label: `Signal ${runtime.signal}`, tone: "failed" };
  if (Number.isFinite(runtime.exitCode)) {
    return runtime.exitCode === 0
      ? { label: "Completed", tone: "success" }
      : { label: `Exit ${runtime.exitCode}`, tone: "failed" };
  }
  return { label: "Starting", tone: "running" };
}

function metadataRow(label, value) {
  if (value === undefined || value === null || value === "") return undefined;
  const row = element("div", { className: "runtime-meta-row" });
  row.append(
    element("span", { className: "runtime-meta-label", text: label }),
    element("span", { className: "runtime-meta-value", text: value, title: String(value) }),
  );
  return row;
}

function buildEnvironment(environment) {
  if (!environment || typeof environment !== "object" || Object.keys(environment).length === 0) return undefined;
  const details = element("details", { className: "runtime-environment" });
  details.append(element("summary", { text: `Environment overrides (${Object.keys(environment).length})` }));
  details.append(element("pre", { text: JSON.stringify(environment, null, 2) }));
  return details;
}

function buildRuntimeCard() {
  const card = toolResultCard(state.result);
  const runtime = card?.payload?.runtime ?? {};
  const input = state.input ?? {};
  const command = runtime.command || card?.summary?.command || commandFromInput(input);
  const output = textContent(card?.payload?.content ?? state.result?.content);
  const status = statusFromRuntime({
    running: runtime.running ?? card?.summary?.running ?? (state.result ? false : true),
    exitCode: runtime.exitCode ?? card?.summary?.exitCode,
    signal: runtime.signal ?? card?.summary?.signal,
  });
  const duration = runtime.wallTimeMs ?? card?.summary?.wallTimeMs;
  const compact = runtimeSummary(status, command, duration);

  const shell = element("main", { className: "shell" });
  const panel = element("details", { className: `tool-card shell codex-runtime-card compact-log ${status.tone}` });
  panel.dataset.devspaceRuntime = "true";
  panel.open = status.tone === "running" || status.tone === "failed";

  const header = element("summary", { className: "compact-log-summary" });
  header.append(
    element("span", { className: `compact-log-icon ${status.tone}`, text: status.tone === "failed" ? "×" : status.tone === "running" ? "›" : "✓" }),
    element("span", { className: "compact-log-verb", text: compact.label }),
    element("code", { className: "compact-log-command", text: compact.command, title: compact.command }),
    element("span", { className: `runtime-status ${status.tone}`, text: status.label }),
  );
  panel.append(header);

  const body = element("div", { className: "codex-runtime-body" });
  if (command) {
    const commandSection = element("section", { className: "runtime-section" });
    commandSection.append(
      element("div", { className: "runtime-section-title", text: "Command" }),
      element("pre", { className: "runtime-command", text: command }),
    );
    body.append(commandSection);
  }

  const metadata = element("div", { className: "runtime-meta-grid" });
  const rows = [
    metadataRow("Working directory", runtime.workingDirectory ?? input.workingDirectory ?? "."),
    metadataRow("Process", runtime.processHandle ?? card?.summary?.processHandle ?? input.processHandle),
    metadataRow("PID", runtime.pid ?? card?.summary?.pid),
    metadataRow("Session", runtime.sessionId ?? card?.summary?.sessionId ?? input.sessionId),
    metadataRow(ZH ? "耗时" : "Duration", formatDuration(duration)),
    metadataRow("PTY", runtime.tty === true || input.tty === true ? "enabled" : runtime.tty === false ? "disabled" : undefined),
    metadataRow("Permission", runtime.permissionDecision ? `${runtime.permissionDecision} · ${runtime.permissionRule ?? "default"}` : undefined),
  ].filter(Boolean);
  if (rows.length) {
    rows.forEach((row) => metadata.append(row));
    body.append(metadata);
  }

  const environment = buildEnvironment(runtime.environment);
  if (environment) body.append(environment);

  const outputSection = element("section", { className: "runtime-section runtime-output-section" });
  outputSection.append(element("div", { className: "runtime-section-title", text: runtime.running ? (ZH ? "实时输出" : "Live output") : (ZH ? "输出" : "Output") }));
  if (output) {
    outputSection.append(element("pre", { className: "runtime-output", text: output }));
  } else {
    outputSection.append(element("div", { className: "runtime-output-empty", text: runtime.running ? "Waiting for process output…" : "No output." }));
  }
  body.append(outputSection);
  panel.append(body);
  shell.append(panel);
  return shell;
}

function continuationStateTone(task = {}) {
  const value = String(task.state || "RUNNING");
  if (["SUCCEEDED"].includes(value)) return "success";
  if (["FAILED_TERMINAL", "CANCELLED_BY_USER", "ABORTED_NO_PROGRESS", "BUDGET_EXHAUSTED", "ABANDONED_AUTO_TASK"].includes(value)) return "failed";
  if (["WAITING_EXTERNAL", "WAITING_SUPERVISOR", "PAUSED_BY_USER"].includes(value)) return "waiting";
  return "running";
}

function buildContinuationCard() {
  const structuredTask = state.result?.structuredContent?.task;
  const task = state.continuationTask ?? structuredTask ?? {};
  const tone = continuationStateTone(task);
  const required = Array.isArray(task.requiredMilestones) ? task.requiredMilestones : [];
  const completed = new Set(Array.isArray(task.completedMilestones) ? task.completedMilestones : []);
  const shell = element("main", { className: "shell" });
  const panel = element("details", { className: `tool-card shell codex-runtime-card compact-log continuation-card ${tone}` });
  panel.dataset.devspaceContinuation = "true";
  panel.open = true;
  const header = element("summary", { className: "compact-log-summary" });
  const lockLabel = task.ownerLocked ? (ZH ? " · 已锁定" : " · Locked") : "";
  header.append(
    element("span", { className: `compact-log-icon ${tone}`, text: tone === "success" ? "✓" : tone === "failed" ? "×" : "↻" }),
    element("span", { className: "compact-log-verb", text: ZH ? "自动续轮任务" : "Continuation task" }),
    element("code", { className: "compact-log-command", text: task.objective || state.input?.objective || (ZH ? "等待任务状态" : "Waiting for task state") }),
    element("span", { className: `runtime-status ${tone}`, text: `${task.state || "STARTING"}${lockLabel}` }),
  );
  panel.append(header);

  const body = element("div", { className: "codex-runtime-body" });
  const summary = element("div", { className: "runtime-meta-grid" });
  [
    metadataRow(ZH ? "任务 ID" : "Task ID", task.id),
    metadataRow(ZH ? "状态" : "State", task.state),
    metadataRow(ZH ? "来源" : "Source", task.taskSource),
    metadataRow(ZH ? "工作区" : "Workspace", task.workspaceId),
    metadataRow(ZH ? "模式" : "Mode", task.continuationMode === "resident"
      ? (ZH ? "常驻 / 监控" : "Resident / monitor")
      : task.continuationMode === "completion-driven"
        ? (ZH ? "里程碑驱动" : "Completion driven")
      : task.continuationMode === "timeout-recovery"
        ? (ZH ? "仅截断恢复" : "Timeout recovery only")
        : (ZH ? "兼容任务" : "Compatibility task")),
    metadataRow(ZH ? "里程碑" : "Milestones", `${completed.size}/${required.length}`),
    metadataRow(ZH ? "续轮" : "Continuations", `${task.continuationCount ?? 0}/${Number(task.maxContinuations || 0) <= 0 ? "∞" : task.maxContinuations}`),
    metadataRow(ZH ? "Turn Lease" : "Turn Lease", task.turnLeaseExpiresAt),
    metadataRow(ZH ? "总时限" : "Wall clock", task.unlimitedWallClock || !task.deadlineAt ? (ZH ? "无限" : "Unlimited") : task.deadlineAt),
    metadataRow(ZH ? "Owner 锁" : "Owner lock", task.ownerLocked ? (ZH ? "已锁定" : "Locked") : (ZH ? "未锁定" : "Unlocked")),
    metadataRow(ZH ? "等待原因" : "Waiting", task.waitingReason),
  ].filter(Boolean).forEach((row) => summary.append(row));
  body.append(summary);

  if (required.length) {
    const milestoneSection = element("section", { className: "runtime-section" });
    milestoneSection.append(element("div", { className: "runtime-section-title", text: ZH ? "任务里程碑" : "Milestones" }));
    const list = element("div", { className: "operation-list continuation-milestones" });
    for (const milestone of required) {
      const done = completed.has(milestone);
      const row = element("div", { className: "operation-summary" });
      row.append(
        element("span", { className: `compact-log-icon ${done ? "success" : "running"}`, text: done ? "✓" : "·" }),
        element("span", { className: "operation-verb", text: milestone }),
      );
      list.append(row);
    }
    milestoneSection.append(list);
    body.append(milestoneSection);
  }
  const note = task.continuationDeliveryAwaitingAck
    ? (ZH ? "续轮消息已被宿主接受，正在等待新 assistant 轮重新连接 DevSpace 并 ACK。" : "Follow-up accepted; waiting for the resumed assistant turn to ACK DevSpace connectivity.")
    : task.continuationWakePending
      ? (ZH ? "已产生持久续轮唤醒，Workspace App 将自动 claim 并发送续轮消息。" : "A durable continuation wake is pending and will be claimed automatically.")
      : task.continuationMode === "resident"
        ? (ZH ? "常驻/监控任务只有在 Host 明确超时，或模型显式声明阶段完成 / 显式 watch 的进程结束时才会续轮。" : "Resident/monitor tasks continue only on an explicit Host timeout or an explicit stage/process wake.")
        : task.continuationMode === "completion-driven"
          ? (ZH ? "里程碑驱动任务默认没有总时限和最大续轮上限。模型每次实际 DevSpace 工作都会续租 Turn Lease；只要里程碑未完成，模型提前结束、Turn Lease 到期或资源 teardown 时都可恢复同一任务，直到显式 complete。" : "Completion-driven tasks default to unlimited wall-clock duration and continuation count. Substantive DevSpace work renews the model Turn Lease; while milestones remain, premature turn end, lease expiry, or resource teardown can resume the same task until explicit complete.")
        : task.continuationMode === "timeout-recovery"
          ? (ZH ? "仅截断恢复不会使用学习预算、普通静默、早期 teardown 或普通进程结束抢跑。若用户已确认真实 Host cutoff 下界，越过下界与宽限期后可由仍存活的 Anchor Lease 做保守恢复探测。" : "Timeout recovery never pre-empts on learned budgets, generic silence, early teardown, or ordinary process completion. After a user-confirmed real Host cutoff lower bound plus its grace period, a surviving Anchor Lease may make a conservative recovery probe.")
        : (ZH ? "兼容任务不会自动创建下一轮；需要截断恢复时使用 timeout-recovery，需要常驻/监控时由用户明确选择 resident。" : "Compatibility tasks never auto-create a new turn; use timeout-recovery for truncation recovery and explicitly choose resident for user-authorized persistent monitoring.");
  body.append(element("div", { className: "runtime-output-empty", text: note }));
  panel.append(body);
  shell.append(panel);
  return shell;
}

function buildPatchPendingCard() {
  const input = state.input ?? {};
  const shell = element("main", { className: "shell" });
  const panel = element("details", { className: "tool-card edit codex-runtime-card compact-log running" });
  panel.dataset.devspaceRuntime = "true";
  panel.open = true;
  const header = element("summary", { className: "compact-log-summary" });
  header.append(
    element("span", { className: "compact-log-icon running", text: "✎" }),
    element("span", { className: "compact-log-verb", text: ZH ? "正在应用补丁" : "Applying patch" }),
    element("code", { className: "compact-log-command", text: ZH ? "检查并修改工作区文件" : "Reviewing and modifying workspace files" }),
    element("span", { className: "runtime-status running", text: "Running" }),
  );
  const body = element("div", { className: "codex-runtime-body" });
  body.append(
    element("div", { className: "runtime-section-title", text: "Planned modification" }),
    element("pre", { className: "runtime-patch", text: typeof input.patch === "string" ? input.patch : "Waiting for patch input…" }),
  );
  panel.append(header, body);
  shell.append(panel);
  return shell;
}

function buildPreviewGallery(card) {
  const previews = Array.isArray(card?.previews) ? card.previews : [];
  const artifacts = Array.isArray(card?.artifacts) ? card.artifacts : [];
  if (!previews.length && !artifacts.length) return undefined;

  const section = element("section", { className: "devspace-preview-gallery" });
  section.dataset.devspacePreview = "true";
  section.append(element("div", { className: "preview-title", text: "Result preview" }));

  if (previews.length) {
    const grid = element("div", { className: "preview-grid" });
    for (const preview of previews) {
      const figure = element("figure", { className: "preview-item" });
      const image = element("img", { className: "preview-image", title: preview.path });
      image.src = preview.dataUrl || `data:${preview.mimeType};base64,${preview.data}`;
      image.alt = preview.path || "Generated preview";
      figure.append(image);
      const caption = element("figcaption", { className: "preview-caption" });
      caption.append(
        element("span", { className: "preview-path", text: preview.path ?? "image" }),
        element("span", { className: "preview-size", text: formatBytes(preview.size) }),
      );
      figure.append(caption);
      grid.append(figure);
    }
    section.append(grid);
  }

  const inlinePaths = new Set(previews.map((preview) => preview.path));
  const remaining = artifacts.filter((artifact) => !inlinePaths.has(artifact.path));
  if (remaining.length) {
    const list = element("div", { className: "artifact-list" });
    for (const artifact of remaining) {
      const row = element("div", { className: "artifact-row" });
      row.append(
        element("span", { className: "artifact-kind", text: String(artifact.kind ?? "file").toUpperCase() }),
        element("span", { className: "artifact-path", text: artifact.path, title: artifact.path }),
        element("span", { className: "artifact-size", text: formatBytes(artifact.size) }),
      );
      list.append(row);
    }
    section.append(list);
  }
  return section;
}

function operationLabel(operation) {
  if (operation.command) return operation.command;
  if (operation.path) return operation.path;
  if (operation.processHandle) return operation.processHandle;
  return operation.tool ?? "operation";
}

function fileOperationLabel(file) {
  const type = file.operation ?? file.type ?? "update";
  if (ZH) {
    if (type === "add" || type === "new") return "已创建";
    if (type === "delete" || type === "deleted") return "已删除";
    if (type === "move" || type === "rename-pure" || type === "rename-changed") return "已移动";
    return "已修改";
  }
  if (type === "add" || type === "new") return "Created";
  if (type === "delete" || type === "deleted") return "Deleted";
  if (type === "move" || type === "rename-pure" || type === "rename-changed") return "Moved";
  return "Modified";
}

function appendOperationDetails(details, rows) {
  const values = rows.filter(([, value]) => value !== undefined && value !== null && value !== "");
  if (!values.length) return;
  const body = element("div", { className: "operation-details" });
  for (const [label, value] of values) body.append(metadataRow(label, value));
  details.append(body);
}

function buildOperationTimeline(card) {
  const operations = Array.isArray(card?.operations) ? card.operations : [];
  const files = Array.isArray(card?.files) ? card.files : [];
  if (!operations.length && !files.length) return undefined;
  const section = element("details", { className: "devspace-operation-timeline" });
  section.dataset.devspaceOperations = "true";
  section.open = operations.some((operation) => operation.success === false);
  section.append(element("summary", {
    className: "preview-title operation-timeline-summary",
    text: ZH ? `操作日志（${operations.length + files.length} 项）` : `Operations (${operations.length + files.length})`,
  }));
  const list = element("div", { className: "operation-list" });
  for (const operation of operations) {
    const row = element("details", { className: "operation-row compact-operation" });
    const status = operation.success === false ? "failed" : "success";
    const label = operationLabel(operation);
    const summary = element("summary", { className: "operation-summary" });
    const meta = [
      formatDuration(operation.durationMs),
      Number.isFinite(operation.exitCode) ? `exit ${operation.exitCode}` : undefined,
    ].filter(Boolean).join(" · ");
    const verb = operation.tool === "exec_command" || operation.tool === "bash"
      ? (operation.success === false ? (ZH ? "运行失败" : "Failed") : (ZH ? `${durationPhrase(operation.durationMs) || "已"}运行` : `Ran ${durationPhrase(operation.durationMs) || ""}`.trim()))
      : (ZH ? "已执行" : "Executed");
    summary.append(
      element("span", { className: `compact-log-icon ${status}`, text: status === "failed" ? "×" : "✓" }),
      element("span", { className: "operation-verb", text: verb }),
      element("code", { className: "operation-label", text: label, title: label }),
      element("span", { className: "operation-meta", text: meta }),
    );
    row.append(summary);
    appendOperationDetails(row, [
      [ZH ? "工具" : "Tool", operation.tool],
      [ZH ? "工作目录" : "Working directory", operation.workingDirectory],
      [ZH ? "进程" : "Process", operation.processHandle],
      [ZH ? "权限" : "Permission", operation.permissionDecision ? `${operation.permissionDecision} · ${operation.permissionRule ?? "default"}` : undefined],
      [ZH ? "信号" : "Signal", operation.signal],
    ]);
    list.append(row);
  }
  for (const file of files) {
    const row = element("details", { className: "operation-row compact-operation file-operation" });
    const summary = element("summary", { className: "operation-summary" });
    const additions = Number.isFinite(file.additions) ? `+${file.additions}` : undefined;
    const removals = Number.isFinite(file.removals) ? `-${file.removals}` : undefined;
    const meta = [additions, removals].filter(Boolean).join(" ");
    summary.append(
      element("span", { className: "compact-log-icon success", text: "✎" }),
      element("span", { className: "operation-verb", text: fileOperationLabel(file) }),
      element("code", { className: "operation-label", text: file.path, title: file.path }),
      element("span", { className: "operation-meta diff-stat", text: meta }),
    );
    row.append(summary);
    appendOperationDetails(row, [
      [ZH ? "路径" : "Path", file.path],
      [ZH ? "原路径" : "Previous path", file.previousPath],
      [ZH ? "变更" : "Changes", meta],
    ]);
    list.append(row);
  }
  section.append(list);
  return section;
}

function buildSessionReview(card) {
  const review = card?.sessionReview ?? card?.payload?.sessionReview;
  if (!review || typeof review !== "object") return undefined;
  const section = element("section", { className: "devspace-session-review" });
  section.dataset.devspaceSessionReview = "true";
  const titleRow = element("div", { className: "session-review-title-row" });
  titleRow.append(
    element("div", { className: "preview-title", text: ZH ? "本地 UI 会话总修改" : "Local UI session changes" }),
    element("span", {
      className: `session-review-state ${review.active ? "active" : "inactive"}`,
      text: review.active ? (ZH ? "UI 在线" : "UI active") : (ZH ? "UI 已关闭" : "UI inactive"),
    }),
  );
  section.append(titleRow);
  if (!review.active) {
    section.append(element("div", {
      className: "session-review-note",
      text: review.reason || (ZH ? "打开本地 DevSpace Portable UI 后才会启用会话统计与回退。" : "Open the local DevSpace Portable UI to enable session review and rollback."),
    }));
    return section;
  }

  const summary = review.summary ?? { files: 0, additions: 0, removals: 0 };
  const metrics = element("div", { className: "session-review-metrics" });
  for (const [label, value, tone] of [
    [ZH ? "文件" : "Files", summary.files ?? 0, "neutral"],
    [ZH ? "新增行" : "Added", `+${summary.additions ?? 0}`, "added"],
    [ZH ? "删除行" : "Removed", `-${summary.removals ?? 0}`, "removed"],
  ]) {
    const metric = element("div", { className: `session-review-metric ${tone}` });
    metric.append(
      element("span", { className: "session-review-metric-label", text: label }),
      element("strong", { className: "session-review-metric-value", text: value }),
    );
    metrics.append(metric);
  }
  section.append(metrics);

  const files = Array.isArray(review.files) ? review.files : [];
  if (files.length) {
    const list = element("div", { className: "session-review-files" });
    for (const file of files.slice(0, 30)) {
      const row = element("div", { className: "session-review-file" });
      row.append(
        element("code", { className: "session-review-path", text: file.path, title: file.path }),
        element("span", { className: "session-review-diff", text: `+${file.additions ?? 0} -${file.removals ?? 0}` }),
      );
      list.append(row);
    }
    if (files.length > 30) {
      list.append(element("div", { className: "session-review-note", text: `${files.length - 30} more file(s)…` }));
    }
    section.append(list);
  }

  const limitations = Array.isArray(review.limitations) ? review.limitations : [];
  for (const limitation of limitations) {
    section.append(element("div", { className: "session-review-warning", text: limitation }));
  }
  if (review.confirmationToken) {
    const confirmation = element("div", { className: "session-review-confirmation" });
    confirmation.append(
      element("span", { text: ZH ? "回退确认令牌" : "Rollback confirmation" }),
      element("code", { text: review.confirmationToken }),
    );
    section.append(confirmation);
  }

  const actions = element("div", { className: "session-review-actions" });
  const status = element("span", { className: "session-review-action-status" });
  const rollback = element("button", {
    className: "session-review-rollback",
    text: ZH ? "回退本次 UI 会话修改" : "Rollback UI session",
  });
  rollback.type = "button";
  rollback.disabled = !review.canRollback;
  let rollbackConfirmationArmed = false;
  let rollbackConfirmationTimer;
  rollback.addEventListener("click", async () => {
    if (!review.canRollback || !review.confirmationToken || !card.workspaceId) return;
    if (!rollbackConfirmationArmed) {
      rollbackConfirmationArmed = true;
      rollback.classList.add("session-review-confirm-pending");
      rollback.textContent = ZH ? "确认回退本次修改" : "Confirm rollback";
      status.textContent = ZH
        ? "再次点击确认；将恢复到本次 UI 会话开始时的基线，Git 暂存区保持不变。"
        : "Click again to confirm. The working tree returns to the UI-session baseline; the Git index is preserved.";
      window.clearTimeout(rollbackConfirmationTimer);
      rollbackConfirmationTimer = window.setTimeout(() => {
        rollbackConfirmationArmed = false;
        rollback.classList.remove("session-review-confirm-pending");
        rollback.textContent = ZH ? "回退本次 UI 会话修改" : "Rollback UI session";
        status.textContent = "";
      }, 15_000);
      return;
    }
    window.clearTimeout(rollbackConfirmationTimer);
    rollbackConfirmationArmed = false;
    rollback.disabled = true;
    rollback.classList.remove("session-review-confirm-pending");
    status.textContent = ZH ? "正在回退…" : "Rolling back…";
    try {
      const response = await callServerTool("session_rollback", {
        workspaceId: card.workspaceId,
        confirmation: review.confirmationToken,
      });
      if (response?.isError) throw new Error(textContent(response.content) || "Rollback failed.");
      status.textContent = ZH ? "回退完成，正在刷新会话修改…" : "Rollback completed; refreshing session changes…";
      const refreshed = await callServerTool("session_changes", { workspaceId: card.workspaceId });
      if (refreshed?.isError) throw new Error(textContent(refreshed.content) || "Session refresh failed after rollback.");
      const refreshedCard = toolResultCard(refreshed);
      const nextReview = refreshedCard?.sessionReview ?? refreshed?.structuredContent?.sessionReview;
      if (nextReview) {
        const replacement = buildSessionReview({ ...card, sessionReview: nextReview });
        if (replacement) section.replaceWith(replacement);
      } else {
        status.textContent = ZH ? "回退完成。" : "Rollback completed.";
      }
    } catch (error) {
      rollback.disabled = false;
      rollback.textContent = ZH ? "回退本次 UI 会话修改" : "Rollback UI session";
      status.textContent = error instanceof Error ? error.message : String(error);
    }
  });
  actions.append(rollback, status);
  section.append(actions);
  return section;
}

function ensureVersionFooter() {
  if (!root || root.querySelector("[data-devspace-version='true']")) return;
  const footer = element("div", {
    className: "devspace-version-footer",
    text: "DevSpace Portable 1.1.54 · Protocol 1.5",
  });
  footer.dataset.devspaceVersion = "true";
  root.append(footer);
}

function renderRuntime() {
  if (!root || rendering || !RUNTIME_TOOLS.has(state.tool)) return;
  rendering = true;
  try {
    root.replaceChildren(buildRuntimeCard());
    ensureVersionFooter();
  } finally {
    rendering = false;
  }
}

function renderPatchPending() {
  if (!root || rendering || state.tool !== "apply_patch" || state.result) return;
  rendering = true;
  try {
    root.replaceChildren(buildPatchPendingCard());
    ensureVersionFooter();
  } finally {
    rendering = false;
  }
}

function renderContinuation() {
  if (!root || rendering || !CONTINUATION_TOOLS.has(state.tool)) return;
  rendering = true;
  try {
    root.replaceChildren(buildContinuationCard());
    ensureVersionFooter();
  } finally {
    rendering = false;
  }
}

function injectReviewEnhancements() {
  if (!root || !state.result || !REVIEW_TOOLS.has(state.tool)) return;
  const card = toolResultCard(state.result);
  const reviewSummary = root.querySelector(".review-summary");
  const toolBody = root.querySelector(".tool-body");
  const reviewCard = root.querySelector(".tool-card.review") ?? root.querySelector(".tool-card");
  const target = reviewSummary ?? toolBody;
  if (!target) {
    window.clearTimeout(reviewLoadTimer);
    reviewLoadTimer = undefined;
    reviewCard?.classList.add("devspace-review-collapsed");
    root.querySelectorAll("[data-devspace-preview='true'], [data-devspace-operations='true'], [data-devspace-session-review='true']")
      .forEach((node) => node.remove());
    ensureVersionFooter();
    return;
  }
  reviewCard?.classList.remove("devspace-review-collapsed");
  stabilizeReviewLoadingState();
  if (target) {
    if (!root.querySelector("[data-devspace-preview='true']")) {
      const gallery = buildPreviewGallery(card);
      if (gallery) target.prepend(gallery);
    }
    if (!root.querySelector("[data-devspace-operations='true']")) {
      const timeline = buildOperationTimeline(card);
      if (timeline) target.prepend(timeline);
    }
    if (!root.querySelector("[data-devspace-session-review='true']")) {
      const sessionReview = buildSessionReview(card);
      if (sessionReview) target.prepend(sessionReview);
    }
  }
  ensureVersionFooter();
}

function stabilizeReviewLoadingState() {
  const status = root?.querySelector(".review-payload .status");
  const loading = status && /^Loading (?:review|diff)\.\.\.$/i.test(String(status.textContent || "").trim());
  if (!loading) {
    window.clearTimeout(reviewLoadTimer);
    reviewLoadTimer = undefined;
    return;
  }
  status.classList.add("review-loading-state");
  if (reviewLoadTimer) return;
  reviewLoadTimer = window.setTimeout(() => {
    reviewLoadTimer = undefined;
    const current = root?.querySelector(".review-payload .status");
    if (!current || !/^Loading (?:review|diff)\.\.\.$/i.test(String(current.textContent || "").trim())) return;
    current.classList.remove("muted", "review-loading-state");
    current.classList.add("error", "review-error-state");
    const message = document.createElement("span");
    message.textContent = ZH
      ? "详细 diff 加载失败或超时。折叠后重新展开即可重试；上方会话修改摘要仍可正常使用。"
      : "Detailed diff failed to load or timed out. Collapse and expand to retry; the session-change summary above remains usable.";
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "review-retry-button";
    retry.textContent = ZH ? "重新加载详细 diff" : "Retry detailed diff";
    retry.addEventListener("click", () => {
      const header = root?.querySelector(".review-header");
      if (!(header instanceof HTMLButtonElement) || header.disabled) return;
      header.click();
      window.setTimeout(() => {
        const reopenedHeader = root?.querySelector(".review-header");
        if (reopenedHeader instanceof HTMLButtonElement && !reopenedHeader.disabled) reopenedHeader.click();
      }, 0);
    });
    current.replaceChildren(message, retry);
  }, 8_000);
}

function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  queueMicrotask(() => {
    renderScheduled = false;
    if (state.mode === "runtime") renderRuntime();
    else if (state.mode === "patch-pending") renderPatchPending();
    else if (state.mode === "continuation") renderContinuation();
    else if (state.mode === "review") injectReviewEnhancements();
    else ensureVersionFooter();
  });
}

function handleMessage(message) {
  if (!message || message.jsonrpc !== "2.0") return;
  if (message.id !== undefined && pendingServerCalls.has(String(message.id))) {
    const pending = pendingServerCalls.get(String(message.id));
    pendingServerCalls.delete(String(message.id));
    if (message.error) pending.reject(new Error(message.error.message || "Server tool call failed."));
    else pending.resolve(message.result);
    return;
  }
  if (message.result?.hostContext || message.result?.toolInfo) {
    mergeHostContext(message.result);
  }
  if (message.method === "ui/initialize") {
    mergeHostContext(message.params);
    return;
  }
  if (message.method === "ui/notifications/host-context-changed") {
    mergeHostContext(message.params);
    return;
  }
  if (message.method === "ui/notifications/tool-input" || message.method === "ui/notifications/tool-input-partial") {
    state.input = { ...state.input, ...(message.params?.arguments ?? {}) };
    state.result = undefined;
    state.cancelled = undefined;
    if (RUNTIME_TOOLS.has(state.tool)) state.mode = "runtime";
    else if (state.tool === "apply_patch") state.mode = "patch-pending";
    else if (CONTINUATION_TOOLS.has(state.tool)) state.mode = "continuation";
    scheduleRender();
    return;
  }
  if (message.method === "ui/notifications/tool-result") {
    state.result = message.params;
    state.tool = message.params?._meta?.tool ?? state.tool;
    if (message.params?.structuredContent?.task) state.continuationTask = message.params.structuredContent.task;
    state.cancelled = undefined;
    if (RUNTIME_TOOLS.has(state.tool)) state.mode = "runtime";
    else if (REVIEW_TOOLS.has(state.tool)) state.mode = "review";
    else if (CONTINUATION_TOOLS.has(state.tool)) state.mode = "continuation";
    scheduleRender();
    setTimeout(scheduleRender, 25);
    setTimeout(scheduleRender, 150);
    return;
  }
  if (message.method === "ui/notifications/tool-cancelled") {
    state.cancelled = message.params?.reason ?? "Cancelled by host";
    if (RUNTIME_TOOLS.has(state.tool)) state.mode = "runtime";
    scheduleRender();
  }
}

window.addEventListener("message", (event) => {
  if (event.source !== window.parent) return;
  handleMessage(event.data);
});

window.addEventListener("devspace:continuation-task", (event) => {
  if (!event?.detail || typeof event.detail !== "object") return;
  state.continuationTask = event.detail;
  if (CONTINUATION_TOOLS.has(state.tool)) {
    state.mode = "continuation";
    scheduleRender();
  }
});

if (root) {
  ensureVersionFooter();
  new MutationObserver(() => {
    if (rendering) return;
    if (state.mode === "runtime" && !root.querySelector("[data-devspace-runtime='true']")) scheduleRender();
    if (state.mode === "patch-pending" && !root.querySelector("[data-devspace-runtime='true']")) scheduleRender();
    if (state.mode === "continuation" && !root.querySelector("[data-devspace-continuation='true']")) scheduleRender();
    if (state.mode === "review") scheduleRender();
    ensureVersionFooter();
  }).observe(root, { childList: true, subtree: true });
}
