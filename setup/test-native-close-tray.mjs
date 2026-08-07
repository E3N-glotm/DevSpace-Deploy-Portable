import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (value) => value.slice(1)));
const nativeExe = join(root, "DevSpace-Portable.exe");
const temporary = await mkdtemp(join(tmpdir(), "devspace-native-close-"));
const configDir = join(temporary, "config");
const stateDir = join(temporary, "state");
const runDir = join(temporary, "run");
await Promise.all([mkdir(configDir), mkdir(stateDir), mkdir(runDir)]);
const activeChildren = [];

const baseEnvironment = {
  ...process.env,
  DEVSPACE_PORTABLE_CONFIG_DIR: configDir,
  DEVSPACE_PORTABLE_STATE_DIR: stateDir,
  DEVSPACE_PORTABLE_RUN_DIR: runDir,
  DEVSPACE_WINDOWS_TEXT_ENCODING: "utf-8",
};

async function waitFor(predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error("Timed out waiting for native close behavior.");
}

async function lease() {
  try {
    return JSON.parse(await readFile(join(runDir, "ui-session.json"), "utf8"));
  } catch {
    return null;
  }
}

function processAlive(child) {
  return child.exitCode === null && child.signalCode === null;
}

function closeWindow(pid) {
  const script = [
    "Add-Type -MemberDefinition '[System.Runtime.InteropServices.DllImport(\"user32.dll\")] public static extern bool PostMessage(System.IntPtr hWnd, uint Msg, System.IntPtr wParam, System.IntPtr lParam);' -Name NativeClose -Namespace DevSpaceTest",
    `$p=Get-Process -Id ${pid} -ErrorAction Stop`,
    "if($p.MainWindowHandle -eq 0){exit 2}",
    "if(-not [DevSpaceTest.NativeClose]::PostMessage($p.MainWindowHandle,0x0010,[IntPtr]::Zero,[IntPtr]::Zero)){exit 3}",
  ].join(";");
  return spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
  });
}

async function startWithPreference(closeChoice) {
  await writeFile(join(configDir, "ui-preferences.json"), JSON.stringify({ formatVersion: 1, closeChoice }), "utf8");
  const child = spawn(nativeExe, [], { cwd: root, env: baseEnvironment, windowsHide: false, stdio: "ignore" });
  activeChildren.push(child);
  await waitFor(async () => {
    const current = await lease();
    return current && Number(current.uiPid) === child.pid ? current : null;
  });
  await waitFor(() => {
    const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", `(Get-Process -Id ${child.pid} -ErrorAction SilentlyContinue).MainWindowHandle`], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
    });
    return Number(String(result.stdout || "").trim()) > 0;
  });
  return child;
}

try {
  await writeFile(join(configDir, "deployment.json"), JSON.stringify({
    formatVersion: 5,
    toolMode: "codex",
    permissions: { profile: "workspace" },
    features: { computerUse: false, memories: true, hooks: true, uiSessionReview: true },
  }), "utf8");

  const minimized = await startWithPreference("minimize-tray");
  const before = await lease();
  const minimizeClose = closeWindow(minimized.pid);
  if (minimizeClose.status !== 0) throw new Error(`Unable to close native window for tray test: ${minimizeClose.stderr}`);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 3500));
  const after = await lease();
  if (!processAlive(minimized)) throw new Error("Remembered tray choice unexpectedly exited the UI process.");
  if (!after || after.leaseId !== before.leaseId || after.lastHeartbeatAt === before.lastHeartbeatAt) {
    throw new Error("Tray minimization did not preserve and heartbeat the UI lease.");
  }
  spawnSync("taskkill.exe", ["/pid", String(minimized.pid), "/t", "/f"], { windowsHide: true, encoding: "utf8" });
  await waitFor(() => !processAlive(minimized), 15_000);
  await rm(join(runDir, "ui-session.json"), { force: true });

  const exited = await startWithPreference("exit-ui");
  const exitClose = closeWindow(exited.pid);
  if (exitClose.status !== 0) throw new Error(`Unable to close native window for exit test: ${exitClose.stderr}`);
  await waitFor(() => !processAlive(exited), 20_000);
  await waitFor(async () => !(await lease()), 10_000);

  console.log(JSON.stringify({
    rememberedTrayChoice: true,
    trayPreservesLease: true,
    rememberedExitChoice: true,
    exitClosesLease: true,
  }));
} finally {
  for (const child of activeChildren) {
    if (processAlive(child)) {
      spawnSync("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, encoding: "utf8" });
    }
  }
  for (const processInfo of [
    ...spawnSync("powershell.exe", ["-NoProfile", "-Command", `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${temporary.replaceAll("'", "''")}*' } | Select-Object -ExpandProperty ProcessId`], { encoding: "utf8", windowsHide: true }).stdout.split(/\s+/).filter(Boolean),
  ]) {
    spawnSync("taskkill.exe", ["/pid", processInfo, "/t", "/f"], { windowsHide: true, encoding: "utf8" });
  }
  await rm(temporary, { recursive: true, force: true });
}
