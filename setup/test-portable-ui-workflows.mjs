import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const node = join(root, "runtime", "node", "node.exe");
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

  assert.match(nativeSource, /public bool Busy/);
  assert.match(nativeSource, /BusyText = "执行中…"/);
  assert.match(nativeSource, /private readonly BorderlessTabControl _sessionPages/);
  assert.match(nativeSource, /private readonly ModernDiffViewer _diffViewer/);
  assert.match(nativeSource, /文件差异 · 仅显示当前选择/);
  assert.match(nativeSource, /不会在未选择时展示整轮差异/);
  assert.match(nativeSource, /GroupBy\(session => NormalizeSessionTitle/);
  assert.match(nativeSource, /ThenByDescending\(SessionUpdatedAt\)/);
  assert.match(nativeSource, /CloseChoiceDialog\.Show\(this\)/);
  assert.match(nativeSource, /private readonly NotifyIcon _notifyIcon/);
  assert.match(nativeSource, /_manager\.RunJsonAsync\("update-check"\)/);
  assert.match(nativeSource, /_manager\.RunJsonAsync\("update-stage"\)/);
  assert.match(nativeSource, /_manager\.RunJsonAsync\("update-launch"/);
  assert.match(nativeSource, /BuildMemoriesTab\(\)/);
  const executeBusy = nativeSource.match(/private async Task ExecuteBusyAsync[\s\S]*?\n        }/i)?.[0] || "";
  assert.doesNotMatch(executeBusy, /Enabled\s*=\s*false/);

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
  assert.equal(manager("memory-list").memories.length, 1);

  console.log(JSON.stringify({
    nonWhiteningBusyState: true,
    sessionSubpage: true,
    sessionNameGrouping: true,
    selectedFileDiffOnly: true,
    trayCloseChoice: true,
    onlineUpdateUi: true,
    memoryCrud: true,
    remainingMemories: 1,
  }));
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
