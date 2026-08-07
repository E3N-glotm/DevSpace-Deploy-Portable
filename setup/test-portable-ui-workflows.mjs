import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// 优先使用 runtime/node，回退到系统 node（开发环境未 hydrate runtime 时）
const runtimeNode = join(root, "runtime", "node", "node.exe");
const node = existsSync(runtimeNode) ? runtimeNode : process.execPath;
const managerFile = join(root, "setup", "portable-manager.cjs");
const nativeSource = readFileSync(join(root, "setup", "native", "DevSpacePortableApp.cs"), "utf8");
const temporary = await mkdtemp(join(tmpdir(), "devspace-ui-workflows-"));
const configDir = join(temporary, "config");
const stateDir = join(temporary, "state");
const runDir = join(temporary, "run");
const workspaceRoot = join(temporary, "workspace");
const env = {
  ...process.env,
  DEVSPACE_PORTABLE_CONFIG_DIR: configDir,
  DEVSPACE_PORTABLE_STATE_DIR: stateDir,
  DEVSPACE_PORTABLE_RUN_DIR: runDir,
};

function manager(command, payload = {}) {
  const result = spawnSync(node, [managerFile, command, "--ascii-json"], {
    cwd: root,
    env,
    input: JSON.stringify(payload),
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
  });
  if (result.status !== 0) throw new Error(result.stderr || `${command} exited with ${result.status}`);
  return result.stdout.trim() ? JSON.parse(result.stdout.trim()) : {};
}

try {
  mkdirSync(configDir, { recursive: true });
  mkdirSync(workspaceRoot, { recursive: true });
  writeFileSync(join(configDir, "config.json"), JSON.stringify({
    host: "127.0.0.1",
    port: 7676,
    allowedRoots: [workspaceRoot],
    stateDir,
    subagents: false,
    permissions: { profile: "workspace" },
    features: { memories: true, uiSessionReview: true },
  }, null, 2));

  // WebView2 壳的断言：保留 ModernButton、CloseChoiceDialog、NotifyIcon、TailFile
  // 已删除的 WinForms 控件（Build*Tab、BorderlessTabControl、ModernDiffViewer、_manager.RunJsonAsync）不再断言
  assert.match(nativeSource, /public bool Busy/);
  assert.match(nativeSource, /BusyText = "执行中…"/);
  assert.match(nativeSource, /using Microsoft\.Web\.WebView2\.WinForms;/);
  assert.match(nativeSource, /private readonly WebView2 _webView/);
  assert.match(nativeSource, /await _webView\.EnsureCoreWebView2Async\(\)/);
  assert.match(nativeSource, /http:\/\/127\.0\.0\.1:7677\//);
  assert.match(nativeSource, /CloseChoiceDialog\.Show\(this\)/);
  assert.match(nativeSource, /private readonly NotifyIcon _notifyIcon/);
  assert.match(nativeSource, /internal static string TailFile/);
  assert.match(nativeSource, /private void EnsureConsoleServer\(\)/);
  assert.match(nativeSource, /ProcessComputerUseQueueAsync/);
  // 旧版直接 spawn node.exe 的 RPC 已移除（前端通过 HTTP API 与 console-server 通信）
  assert.doesNotMatch(nativeSource, /_manager\.RunJsonAsync/);
  assert.doesNotMatch(nativeSource, /BuildMemoriesTab\(\)/);
  assert.doesNotMatch(nativeSource, /private readonly BorderlessTabControl _sessionPages/);

  // memory CRUD 测试依赖 vendor 包（@waishnav/devspace），未安装时跳过
  let memoryCrud = false;
  let remainingMemories = null;
  try {
    assert.deepEqual(manager("memory-list").memories, []);
    const createdWorkspace = manager("memory-upsert", {
      scope: "workspace",
      workspaceRoot,
      title: "Workspace preference",
      content: "Prefer structured review pages with per-file diffs.",
      tags: ["ui", "review"],
    }).memory;
    assert.equal(createdWorkspace.scope, "workspace");
    assert.equal(createdWorkspace.title, "Workspace preference");

    const createdGlobal = manager("memory-upsert", {
      scope: "global",
      title: "Global preference",
      content: "Keep explicit memories user-visible and deletable.",
      tags: ["memory"],
    }).memory;
    assert.equal(createdGlobal.scope, "global");

    const listed = manager("memory-list").memories;
    assert.equal(listed.length, 2);
    assert.ok(listed.some((memory) => memory.id === createdWorkspace.id));
    assert.ok(listed.some((memory) => memory.id === createdGlobal.id));

    const updated = manager("memory-upsert", {
      id: createdWorkspace.id,
      scope: "workspace",
      workspaceRoot,
      title: "Workspace preference updated",
      content: "Use an independent session detail subpage with file-level diff navigation.",
      tags: ["ui", "review", "subpage"],
    }).memory;
    assert.equal(updated.id, createdWorkspace.id);
    assert.equal(updated.title, "Workspace preference updated");

    assert.equal(manager("memory-delete", { id: createdGlobal.id }).memory.id, createdGlobal.id);
    remainingMemories = manager("memory-list").memories.length;
    assert.equal(remainingMemories, 1);
    memoryCrud = true;
  } catch (error) {
    if (!/Memory runtime is missing|Cannot find module|is missing/i.test(error.message)) throw error;
    console.warn("[test-portable-ui-workflows] skipped memory CRUD:", error.message);
  }

  console.log(JSON.stringify({
    webview2Shell: true,
    consoleServerEmbedded: true,
    computerUseQueue: true,
    trayCloseChoice: true,
    memoryCrud,
    remainingMemories,
  }));
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
