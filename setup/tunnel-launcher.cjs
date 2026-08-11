"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
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
const NETWORK_POLL_MS = 5_000;
let child = null;
let stopping = false;
let restartTimer = null;
let pollTimer = null;
let lastConfigurationSignature = "";
let lastObservedPathSignature = "";
let reconnectCount = 0;
let lastReconnectAt = "";

function readJson(file, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")); } catch { return fallback; }
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
  if (process.env.DEVSPACE_TEST_PROXY_HEALTHY === "0") return false;
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

function activeNetworkPath() {
  const testSignature = String(process.env.DEVSPACE_TEST_ROUTE_SIGNATURE || "").trim();
  if (testSignature) {
    return {
      available: true,
      signature: testSignature,
      source: "test",
      defaultRoutes: [],
      defaultRouteCount: Number(process.env.DEVSPACE_TEST_DEFAULT_ROUTE_COUNT || 1),
      connectedInterfaceCount: Number(process.env.DEVSPACE_TEST_INTERFACE_COUNT || 1),
      addressCount: Number(process.env.DEVSPACE_TEST_ADDRESS_COUNT || 1),
      routeCount: Number(process.env.DEVSPACE_TEST_ROUTE_COUNT || 1),
    };
  }
  const script = [
    "$ErrorActionPreference='Stop'",
    "[Console]::OutputEncoding=(New-Object System.Text.UTF8Encoding($false))",
    "$OutputEncoding=[Console]::OutputEncoding",
    "$interfaces=@(Get-NetIPInterface -AddressFamily IPv4 -PolicyStore ActiveStore | Where-Object {$_.ConnectionState -eq 'Connected'} | ForEach-Object {[pscustomobject]@{ifIndex=[int]$_.InterfaceIndex;interfaceAlias=[string]$_.InterfaceAlias;interfaceMetric=[int]$_.InterfaceMetric;dhcp=[string]$_.Dhcp}} | Sort-Object ifIndex,interfaceAlias)",
    "$connected=@{}",
    "foreach($item in $interfaces){$connected[[int]$item.ifIndex]=$item}",
    "$addresses=@(Get-NetIPAddress -AddressFamily IPv4 -PolicyStore ActiveStore | Where-Object {$connected.ContainsKey([int]$_.InterfaceIndex)} | ForEach-Object {[pscustomobject]@{ifIndex=[int]$_.InterfaceIndex;ipAddress=[string]$_.IPAddress;prefixLength=[int]$_.PrefixLength;addressState=[string]$_.AddressState;prefixOrigin=[string]$_.PrefixOrigin;suffixOrigin=[string]$_.SuffixOrigin}} | Sort-Object ifIndex,ipAddress,prefixLength)",
    "$routes=@(Get-NetRoute -AddressFamily IPv4 -PolicyStore ActiveStore | Where-Object {$connected.ContainsKey([int]$_.ifIndex)} | ForEach-Object {[pscustomobject]@{ifIndex=[int]$_.ifIndex;destinationPrefix=[string]$_.DestinationPrefix;nextHop=[string]$_.NextHop;routeMetric=[int]$_.RouteMetric;interfaceMetric=[int]$connected[[int]$_.ifIndex].interfaceMetric;protocol=[string]$_.Protocol}} | Sort-Object ifIndex,destinationPrefix,nextHop,routeMetric)",
    "$defaults=@($routes | Where-Object {$_.destinationPrefix -eq '0.0.0.0/0'} | ForEach-Object {[pscustomobject]@{ifIndex=[int]$_.ifIndex;interfaceAlias=[string]$connected[[int]$_.ifIndex].interfaceAlias;nextHop=[string]$_.nextHop;routeMetric=[int]$_.routeMetric;interfaceMetric=[int]$_.interfaceMetric}} | Sort-Object routeMetric,interfaceMetric,ifIndex,nextHop)",
    "[pscustomobject]@{interfaces=$interfaces;addresses=$addresses;routes=$routes;defaultRoutes=$defaults;source='windows-active-ipv4-topology'} | ConvertTo-Json -Compress -Depth 6",
  ].join(";");
  const output = commandOutput(powershellExe, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script,
  ], 4_000).trim();
  try {
    const parsed = JSON.parse(output || "{}");
    const values = Array.isArray(parsed.defaultRoutes) ? parsed.defaultRoutes : parsed.defaultRoutes ? [parsed.defaultRoutes] : [];
    const defaultRoutes = values.map((route) => ({
      ifIndex: Number(route.ifIndex || 0),
      interfaceAlias: String(route.interfaceAlias || ""),
      nextHop: String(route.nextHop || ""),
      routeMetric: Number(route.routeMetric || 0),
      interfaceMetric: Number(route.interfaceMetric || 0),
    }));
    const interfaces = Array.isArray(parsed.interfaces) ? parsed.interfaces : parsed.interfaces ? [parsed.interfaces] : [];
    const addresses = Array.isArray(parsed.addresses) ? parsed.addresses : parsed.addresses ? [parsed.addresses] : [];
    const routes = Array.isArray(parsed.routes) ? parsed.routes : parsed.routes ? [parsed.routes] : [];
    const topology = { interfaces, addresses, routes };
    const signature = crypto.createHash("sha256").update(JSON.stringify(topology)).digest("hex").slice(0, 16);
    return {
      available: true,
      signature,
      source: String(parsed.source || "windows-active-ipv4-topology"),
      defaultRoutes,
      defaultRouteCount: defaultRoutes.length,
      connectedInterfaceCount: interfaces.length,
      addressCount: addresses.length,
      routeCount: routes.length,
    };
  } catch {
    return {
      available: false,
      signature: "",
      source: "route-state-unavailable",
      defaultRoutes: [],
      defaultRouteCount: 0,
      connectedInterfaceCount: 0,
      addressCount: 0,
      routeCount: 0,
    };
  }
}

function resolveNetworkState() {
  const compatibility = compatibilityEnabled();
  const manualProxy = requestedProvider === "ngrok" ? configuredNgrokProxy() : "";
  const networkPath = compatibility ? activeNetworkPath() : {
    available: false,
    signature: "",
    source: "adaptation-disabled",
    defaultRoutes: [],
    defaultRouteCount: 0,
    connectedInterfaceCount: 0,
    addressCount: 0,
    routeCount: 0,
  };
  const common = {
    compatibility,
    adaptation: compatibility,
    pathAvailable: networkPath.available,
    pathSignature: networkPath.signature,
    pathSource: networkPath.source,
    defaultRoutes: networkPath.defaultRoutes,
    defaultRouteCount: networkPath.defaultRouteCount,
    multipleDefaultRoutes: networkPath.defaultRouteCount > 1,
    connectedInterfaceCount: networkPath.connectedInterfaceCount,
    addressCount: networkPath.addressCount,
    routeCount: networkPath.routeCount,
    egressPolicy: manualProxy ? "explicit-proxy" : "windows-system-route",
    crossPathFallback: false,
  };

  if (!compatibility) {
    return {
      ...common,
      paused: false,
      mode: requestedProvider === "ngrok" ? (manualProxy ? "manual-proxy" : "system-routed") : "provider-managed",
      proxyUrl: manualProxy,
      proxySource: manualProxy ? "ngrok-config" : "none",
      reason: "network-adaptation-disabled",
    };
  }
  if (requestedProvider !== "ngrok") {
    return {
      ...common,
      paused: false,
      mode: "provider-managed",
      proxyUrl: "",
      proxySource: "none",
      reason: "network-path-stable",
    };
  }
  if (manualProxy) {
    return localProxyHealthy(manualProxy)
      ? {
          ...common,
          paused: false,
          mode: "manual-proxy",
          proxyUrl: manualProxy,
          proxySource: "ngrok-config",
          reason: "network-path-stable",
        }
      : {
          ...common,
          paused: true,
          mode: "paused",
          proxyUrl: manualProxy,
          proxySource: "ngrok-config",
          reason: "explicit-local-proxy-unavailable",
      };
  }
  return {
    ...common,
    paused: false,
    mode: "system-routed",
    proxyUrl: "",
    proxySource: "none",
    reason: "network-path-stable",
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
    formatVersion: 4,
    provider: requestedProvider,
    supervisorPid: process.pid,
    childPid: child?.pid || null,
    policy: "non-invasive",
    reconnectCount,
    lastReconnectAt: lastReconnectAt || null,
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

function launchChild(network, extra = {}) {
  if (stopping || network.paused || fs.existsSync(stopFile)) return;
  child = childProcess.spawn(requestedExecutable, process.argv.slice(3), {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
    env: childEnvironment(network),
  });
  writePid(pidFile, child.pid);
  writeNetworkState(network, { ...extra, childPid: child.pid, status: "running" });
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

function networkConfigurationSignature(network) {
  return JSON.stringify({
    paused: Boolean(network.paused),
    mode: network.mode,
    proxyUrl: network.proxyUrl,
    reason: network.reason,
    compatibility: network.compatibility,
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
      adaptation: compatibilityEnabled(),
      pathAvailable: false,
      pathSignature: "",
      pathSource: "stop-request",
      defaultRoutes: [],
      defaultRouteCount: 0,
      multipleDefaultRoutes: false,
      connectedInterfaceCount: 0,
      addressCount: 0,
      routeCount: 0,
      egressPolicy: "none",
      crossPathFallback: false,
      reason: "stop-request",
    }, { status: "stopped" });
    shutdown();
    return;
  }
  const network = resolveNetworkState();
  const configurationSignature = networkConfigurationSignature(network);
  if (!lastConfigurationSignature) {
    lastConfigurationSignature = configurationSignature;
  } else if (configurationSignature !== lastConfigurationSignature) {
    if (child) terminateChild(`network-configuration:${network.reason}`);
    lastConfigurationSignature = configurationSignature;
  }
  if (network.paused) {
    if (child) terminateChild(`network-configuration:${network.reason}`);
    writeNetworkState(network, {
      status: "paused",
      transition: "waiting-for-explicit-proxy",
      appliedPathSignature: lastObservedPathSignature || network.pathSignature || null,
    });
    return;
  }
  const currentPathSignature = network.pathAvailable ? network.pathSignature : "";
  const pathChanged = Boolean(lastObservedPathSignature && currentPathSignature && currentPathSignature !== lastObservedPathSignature);
  const previousPathSignature = lastObservedPathSignature;
  if (currentPathSignature) lastObservedPathSignature = currentPathSignature;
  if (!child) {
    launchChild(network, {
      transition: pathChanged ? "topology-changed-provider-recovered" : "stable",
      previousPathSignature: pathChanged ? previousPathSignature : undefined,
      appliedPathSignature: lastObservedPathSignature || network.pathSignature || null,
    });
    return;
  }
  writeNetworkState(network, {
    childPid: child.pid,
    status: "running",
    transition: pathChanged ? "topology-changed-no-restart" : "stable",
    previousPathSignature: pathChanged ? previousPathSignature : undefined,
    appliedPathSignature: lastObservedPathSignature || network.pathSignature || null,
    publicProbesSuppressed: false,
  });
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
