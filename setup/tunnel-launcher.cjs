"use strict";

const fs = require("fs");
const path = require("path");
const childProcess = require("child_process");

const root = path.resolve(__dirname, "..");
const configDir = process.env.DEVSPACE_PORTABLE_CONFIG_DIR
  ? path.resolve(process.env.DEVSPACE_PORTABLE_CONFIG_DIR)
  : path.join(root, "data", "config");
const runDir = process.env.DEVSPACE_PORTABLE_RUN_DIR
  ? path.resolve(process.env.DEVSPACE_PORTABLE_RUN_DIR)
  : path.join(root, "data", "run");
const deploymentFile = path.join(configDir, "deployment.json");
const ngrokConfigFile = path.join(configDir, "ngrok.yml");
const pidFile = process.env.TUNNEL_PID_FILE || path.join(runDir, "tunnel.pid");
const supervisorPidFile = path.join(runDir, "tunnel-supervisor.pid");
const networkStateFile = path.join(runDir, "tunnel-network.json");
const stopFile = path.join(runDir, "tunnel.stop");
const powershellExe = path.join(
  process.env.SystemRoot || "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);
const requestedExecutable = path.resolve(String(process.argv[2] || ""));
const allowedExecutables = new Set([
  path.join(root, "runtime", "ngrok", "ngrok.exe").toLowerCase(),
  path.join(root, "runtime", "cloudflared", "cloudflared.exe").toLowerCase(),
]);
const isNetworkSelfTest = process.argv.includes("--network-self-test");
const requestedProvider = isNetworkSelfTest
  ? (String(process.env.DEVSPACE_TEST_TUNNEL_PROVIDER || "ngrok").toLowerCase() === "cloudflare" ? "cloudflare" : "ngrok")
  : requestedExecutable.toLowerCase().endsWith("cloudflared.exe") ? "cloudflare" : "ngrok";
const NETWORK_POLL_MS = 2_000;
let child = null;
let stopping = false;
let restartTimer = null;
let pollTimer = null;
let lastSignature = "";

function readJson(file, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.rmSync(file, { force: true });
  fs.renameSync(temporary, file);
}

function writePid(file, pid) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${pid}\n`, "ascii");
}

function removeOwnPidFile(file, pid) {
  try {
    if (fs.readFileSync(file, "ascii").trim() === String(pid)) fs.rmSync(file, { force: true });
  } catch {}
}

function commandOutput(executable, args, timeout = 3_000) {
  const result = childProcess.spawnSync(executable, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout,
    maxBuffer: 2 * 1024 * 1024,
  });
  return result.status === 0 ? String(result.stdout || "") : "";
}

function normalizeProxyUrl(value) {
  let raw = String(value || "").trim();
  if (!raw) return "";
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `http://${raw}`;
  try {
    const url = new URL(raw);
    if (!["http:", "https:", "socks5:"].includes(url.protocol)) return "";
    if (!url.hostname || !url.port || url.username || url.password) return "";
    return url.href.replace(/\/$/, "");
  } catch {
    return "";
  }
}

function parseWindowsProxyServer(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (!raw.includes("=") && !raw.includes(";")) return normalizeProxyUrl(raw);
  const entries = new Map();
  for (const item of raw.split(";")) {
    const [key, ...rest] = item.split("=");
    if (!key || !rest.length) continue;
    entries.set(key.trim().toLowerCase(), rest.join("=").trim());
  }
  for (const key of ["https", "http", "socks", "socks5"]) {
    if (!entries.has(key)) continue;
    const protocol = key.startsWith("socks") ? "socks5" : "http";
    const candidate = normalizeProxyUrl(`${protocol}://${entries.get(key)}`);
    if (candidate) return candidate;
  }
  return "";
}

function configuredNgrokProxy() {
  try {
    const text = fs.readFileSync(ngrokConfigFile, "utf8");
    const match = text.match(/^\s*proxy_url:\s*["']?([^"'\r\n]+)["']?\s*$/m);
    return match ? normalizeProxyUrl(match[1]) : "";
  } catch {
    return "";
  }
}

function localProxyHealthy(proxyUrl) {
  if (!proxyUrl) return false;
  if (process.env.DEVSPACE_TEST_PROXY_HEALTHY === "1") return true;
  let parsed;
  try { parsed = new URL(proxyUrl); } catch { return false; }
  const host = parsed.hostname.toLowerCase();
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) return true;
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port <= 0) return false;
  const output = commandOutput("netstat.exe", ["-ano", "-p", "TCP"]);
  const escaped = String(port).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\[::\\]|\\[::1\\]|::):${escaped}\\s+\\S+\\s+LISTENING`, "i").test(output);
}

function compatibilityEnabled() {
  const deployment = readJson(deploymentFile, {});
  return deployment.tunnelNetworkCompatibility !== false;
}

function sangforState() {
  const testValue = String(process.env.DEVSPACE_TEST_SANGFOR_STATE || "").trim().toLowerCase();
  if (["absent", "negotiating", "connected"].includes(testValue)) {
    return {
      clientActive: testValue !== "absent",
      connected: testValue === "connected",
      source: "test",
    };
  }
  const taskOutput = commandOutput("tasklist.exe", ["/fo", "csv", "/nh"]);
  const clientActive = /"(?:EasyConnect|SangforCSClient)\.exe"/i.test(taskOutput);
  if (!clientActive) return { clientActive: false, connected: false, source: "process" };
  const script = [
    "$a=Get-CimInstance Win32_NetworkAdapter | Where-Object {$_.ServiceName -eq 'SangforVnic'} | Select-Object -First 1 NetEnabled,NetConnectionStatus",
    "if($null -eq $a){'{\"present\":false}'}else{$a | Add-Member -NotePropertyName present -NotePropertyValue $true -PassThru | ConvertTo-Json -Compress}",
  ].join(";");
  const output = commandOutput(powershellExe, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script,
  ], 4_000).trim();
  try {
    const adapter = JSON.parse(output || "{}");
    return {
      clientActive: true,
      connected: Boolean(adapter.present && adapter.NetEnabled && Number(adapter.NetConnectionStatus) === 2),
      source: "sangfor-vnic",
    };
  } catch {
    return { clientActive: true, connected: false, source: "sangfor-vnic-unreadable" };
  }
}

function resolveNetworkState() {
  const compatibility = compatibilityEnabled();
  const manualProxy = requestedProvider === "ngrok" ? configuredNgrokProxy() : "";
  const vpn = sangforState();
  const vpnState = vpn.clientActive ? (vpn.connected ? "connected" : "negotiating") : "absent";

  if (!compatibility) {
    return {
      compatibility,
      paused: false,
      mode: requestedProvider === "ngrok" ? (manualProxy ? "manual-proxy" : "direct") : "provider-managed",
      proxyUrl: manualProxy,
      proxySource: manualProxy ? "ngrok-config" : "none",
      vpnState,
      reason: "compatibility-disabled",
    };
  }
  if (vpn.clientActive) {
    return {
      compatibility,
      paused: true,
      mode: "paused",
      proxyUrl: "",
      proxySource: "none",
      vpnState,
      reason: "sangfor-vpn-session-isolation",
    };
  }
  if (requestedProvider !== "ngrok") {
    return {
      compatibility,
      paused: false,
      mode: "provider-managed",
      proxyUrl: "",
      proxySource: "none",
      vpnState,
      reason: "provider-managed-network",
    };
  }
  if (manualProxy) {
    return localProxyHealthy(manualProxy)
      ? {
          compatibility,
          paused: false,
          mode: "manual-proxy",
          proxyUrl: manualProxy,
          proxySource: "ngrok-config",
          vpnState,
          reason: "explicit-proxy",
        }
      : {
          compatibility,
          paused: true,
          mode: "paused",
          proxyUrl: manualProxy,
          proxySource: "ngrok-config",
          vpnState,
          reason: "explicit-local-proxy-unavailable",
      };
  }
  return {
    compatibility,
    paused: false,
    mode: "direct",
    proxyUrl: "",
    proxySource: "none",
    vpnState,
    reason: "ambient-proxy-isolated-direct-or-transparent-tun",
  };
}

function childEnvironment(network) {
  const env = { ...process.env };
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "NGROK_PROXY"]) delete env[name];
  if (network.proxyUrl) {
    env.HTTP_PROXY = network.proxyUrl;
    env.HTTPS_PROXY = network.proxyUrl;
    env.http_proxy = network.proxyUrl;
    env.https_proxy = network.proxyUrl;
    if (network.proxyUrl.toLowerCase().startsWith("socks5://")) {
      env.ALL_PROXY = network.proxyUrl;
      env.all_proxy = network.proxyUrl;
    }
  }
  return env;
}

function writeNetworkState(network, extra = {}) {
  writeJson(networkStateFile, {
    formatVersion: 2,
    provider: requestedProvider,
    supervisorPid: process.pid,
    childPid: child?.pid || null,
    policy: "non-invasive",
    ...network,
    ...extra,
    updatedAt: new Date().toISOString(),
  });
}

function terminateChild(reason = "network-transition") {
  if (!child?.pid) return;
  const ownedChild = child;
  const pid = ownedChild.pid;
  child = null;
  try { ownedChild.kill(); } catch {}
  removeOwnPidFile(pidFile, pid);
  process.stderr.write(`Tunnel child ${pid} stopped for ${reason}.\n`);
}

function launchChild(network) {
  if (stopping || network.paused || fs.existsSync(stopFile)) return;
  child = childProcess.spawn(requestedExecutable, process.argv.slice(3), {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
    env: childEnvironment(network),
  });
  writePid(pidFile, child.pid);
  writeNetworkState(network, { childPid: child.pid, status: "running" });
  const ownChild = child;
  ownChild.once("error", (error) => {
    removeOwnPidFile(pidFile, ownChild.pid);
    if (child === ownChild) child = null;
    process.stderr.write(`${error.stack || error}\n`);
    scheduleReconcile();
  });
  ownChild.once("exit", (code, signal) => {
    removeOwnPidFile(pidFile, ownChild.pid);
    if (child === ownChild) child = null;
    if (!stopping) {
      process.stderr.write(`Tunnel child exited code=${code ?? "none"} signal=${signal || "none"}; re-evaluating network path.\n`);
      scheduleReconcile();
    }
  });
}

function scheduleReconcile(delay = 1_500) {
  if (stopping || restartTimer) return;
  restartTimer = setTimeout(() => {
    restartTimer = null;
    reconcile();
  }, delay);
}

function networkSignature(network) {
  return JSON.stringify({
    paused: Boolean(network.paused),
    mode: network.mode,
    proxyUrl: network.proxyUrl,
    vpnState: network.vpnState,
    reason: network.reason,
  });
}

function reconcile() {
  if (stopping) return;
  if (fs.existsSync(stopFile)) {
    terminateChild("stop-request");
    writeNetworkState({
      compatibility: compatibilityEnabled(),
      paused: true,
      mode: "paused",
      proxyUrl: "",
      proxySource: "none",
      vpnState: "unknown",
      reason: "stop-request",
    }, { status: "stopped" });
    shutdown();
    return;
  }
  const network = resolveNetworkState();
  const signature = networkSignature(network);
  if (signature !== lastSignature) {
    if (child) terminateChild(`network-state:${network.reason}`);
    lastSignature = signature;
  }
  if (network.paused) {
    writeNetworkState(network, { status: "paused" });
    return;
  }
  if (!child) launchChild(network);
  else writeNetworkState(network, { childPid: child.pid, status: "running" });
}

function shutdown() {
  if (stopping) return;
  stopping = true;
  if (restartTimer) clearTimeout(restartTimer);
  if (pollTimer) clearInterval(pollTimer);
  terminateChild("supervisor-shutdown");
  removeOwnPidFile(supervisorPidFile, process.pid);
  process.exitCode = 0;
}

if (isNetworkSelfTest) {
  process.stdout.write(`${JSON.stringify(resolveNetworkState())}\n`);
  process.exit(0);
}

if (!allowedExecutables.has(requestedExecutable.toLowerCase())) throw new Error(`Refusing unapproved tunnel executable: ${requestedExecutable}`);
if (!fs.existsSync(requestedExecutable)) throw new Error(`Tunnel executable is missing: ${requestedExecutable}`);

fs.mkdirSync(runDir, { recursive: true });
writePid(supervisorPidFile, process.pid);
reconcile();
pollTimer = setInterval(reconcile, NETWORK_POLL_MS);

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("exit", () => {
  removeOwnPidFile(supervisorPidFile, process.pid);
  if (child?.pid) removeOwnPidFile(pidFile, child.pid);
});
