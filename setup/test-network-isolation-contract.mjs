import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const managerSource = readFileSync(resolve(ROOT, "setup", "portable-manager.cjs"), "utf8");
const launcherSource = readFileSync(resolve(ROOT, "setup", "tunnel-launcher.cjs"), "utf8");
const uiSource = readFileSync(resolve(ROOT, "setup", "native", "DevSpacePortableApp.cs"), "utf8");

function functionBlock(source, name, nextName) {
  const start = source.indexOf(name);
  assert.ok(start >= 0, `missing source block: ${name}`);
  const end = nextName ? source.indexOf(nextName, start + name.length) : -1;
  return source.slice(start, end > start ? end : source.length);
}

const installTasks = functionBlock(managerSource, "function installTasks()", "function taskCommand");
const startLocal = functionBlock(managerSource, "async function startLocalOnly()", "async function startTunnelOnly()");
const startTunnel = functionBlock(managerSource, "async function startTunnelOnly()", "async function startServices()");
const startServices = functionBlock(managerSource, "async function startServices()", "async function enableServices()");
const dashboard = functionBlock(managerSource, "async function dashboardStatus()", "async function testEndpoints()");
const ngrokAgent = functionBlock(managerSource, "async function ngrokAgentState(", "async function statusText()");
const ownedNgrokProcesses = functionBlock(managerSource, "function verifiedOwnedNgrokProcesses()", "function ownedLoopbackListenerPorts(");
const ownedNgrokPorts = functionBlock(managerSource, "function ownedLoopbackListenerPorts(", "async function ngrokAgentState(");
const reconcile = functionBlock(launcherSource, "function reconcile()", "function shutdown()");
const childEnvironment = functionBlock(launcherSource, "function childEnvironment(network)", "function writeNetworkState");

assert.match(startLocal, /ensureLocalRuntime\(\)/,
  "local MCP startup must require only the local runtime");
assert.doesNotMatch(startLocal, /ensureRuntime\(/,
  "local MCP startup must not depend on tunnel runtime availability");
assert.doesNotMatch(startLocal, /startPublicTunnel|publicServiceReady|ngrokAgentState/,
  "local MCP startup must not touch public tunnel state");

assert.match(installTasks, /preserveTunnelEnabled = taskOwnedByRoot\(TASK_TUNNEL\)/,
  "task repair must detect the previous public-tunnel enabled state");
assert.match(installTasks, /setOwnedTaskEnabled\(TASK_TUNNEL, preserveTunnelEnabled\)/,
  "fresh installs must keep tunnel opt-in while updates preserve an existing disabled state");
assert.doesNotMatch(installTasks, /existingNgrokToken|existingCloudflareToken/,
  "installing local MCP tasks must not require public tunnel credentials");

assert.match(startTunnel, /setOwnedTaskEnabled\(TASK_TUNNEL, true\)/,
  "explicit tunnel startup may enable only the DevSpace tunnel task");
assert.doesNotMatch(startTunnel, /stopLocalServiceOnly|stopServices\(/,
  "starting the tunnel must not restart or stop local MCP");

assert.match(startServices, /const tunnelEnabled = taskEnabled\(TASK_TUNNEL\)/,
  "compatibility/update startup must respect the persisted tunnel task state");
assert.match(startServices, /if \(!tunnelEnabled\)[\s\S]*?tunnel remains disabled/,
  "an update/start operation must not silently enable a tunnel the user left disabled");
assert.doesNotMatch(startServices, /setOwnedTaskEnabled\(TASK_TUNNEL, true\)/,
  "only an explicit tunnel/all-services action may enable the public tunnel");

assert.doesNotMatch(dashboard, /dashboardPublicProbes\(/,
  "homepage refresh must not create active public traffic");
assert.match(dashboard, /cachedDashboardPublicProbes\(/,
  "homepage may consume only cached explicit public verification");
assert.match(dashboard, /const tunnelState = tunnelIntentionallyOff[\s\S]*?\? "idle"/,
  "an intentionally disabled tunnel must use a neutral idle state instead of green ready");
assert.doesNotMatch(ngrokAgent, /4040\s*\+|4040-4049|Array\.from\(\{\s*length:\s*10/,
  "ngrok agent discovery must never scan guessed localhost ports");
assert.match(ngrokAgent, /verifiedOwnedNgrokProcesses\(\)/,
  "ngrok agent discovery must begin from a verified DevSpace-owned ngrok process");
assert.match(ngrokAgent, /ownedLoopbackListenerPorts\(ownedProcesses\)/,
  "ngrok agent discovery may probe only listeners owned by the verified ngrok process");
assert.match(ownedNgrokProcesses, /NGROK_EXE/,
  "ngrok ownership must validate the exact bundled executable path");
assert.match(ownedNgrokProcesses, /NGROK_CONFIG/,
  "ngrok ownership fallback must require the Portable-owned config path");
assert.match(ownedNgrokPorts, /allowedPids\.has\(pid\)/,
  "listener discovery must filter netstat results by verified owned PID before probing");

assert.match(reconcile, /topology-changed-no-restart/,
  "route and adapter changes must be observed without proactive tunnel restart");
assert.doesNotMatch(reconcile, /network-path-quiescing|network-path-settled-reconnect/,
  "third-party topology transitions must not churn the DevSpace tunnel");
assert.match(reconcile, /maybeRecoverPublicEndpoint\(network\)/,
  "the tunnel supervisor must recover a persistently unhealthy public endpoint even when the child process is still alive");
assert.match(launcherSource, /PUBLIC_HEALTH_FAILURE_THRESHOLD = 3/,
  "end-to-end tunnel recovery must require consecutive failures");
assert.match(launcherSource, /PUBLIC_HEALTH_AGENT_MISMATCH_THRESHOLD = 3/,
  "public recovery must also require repeated owned-agent evidence that the expected tunnel is missing");
assert.match(launcherSource, /PUBLIC_HEALTH_RESTART_COOLDOWN_MS = 5 \* 60_000/,
  "end-to-end tunnel recovery must use a multi-minute restart cooldown");
assert.match(launcherSource, /agent\.reachable === true && agent\.matchingTunnel === false/,
  "public curl failure alone must never be sufficient to restart ngrok");
assert.match(launcherSource, /terminateChild\("owned-ngrok-agent-missing-expected-tunnel"\)/,
  "public recovery may terminate only the child owned by the tunnel supervisor after agent confirmation");
assert.match(launcherSource, /curlErrorKind[\s\S]*?"dns"[\s\S]*?"connect"[\s\S]*?"timeout"[\s\S]*?"tls"/,
  "public probe diagnostics must preserve DNS/connect/timeout/TLS failure classes");

for (const variable of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "NGROK_PROXY"]) {
  assert.match(childEnvironment, new RegExp(`\\"${variable}\\"`),
    `tunnel child environment must explicitly control inherited ${variable}`);
}
assert.match(childEnvironment, /if \(network\.proxyUrl\)/,
  "only an explicitly configured DevSpace tunnel proxy may be injected into the child");

assert.doesNotMatch(launcherSource,
  /EasyConnect|Sangfor|v2ray|Clash|sing-box|WireGuard|OpenVPN|AnyConnect|GlobalProtect/i,
  "network coexistence must be vendor-neutral rather than product-specific");
assert.doesNotMatch(launcherSource,
  /(?:New|Set|Remove)-NetRoute|route\.exe|netsh\.exe|Set-NetIPInterface|Set-NetRoute|Set-DnsClientServerAddress|Set-ItemProperty[^\n]+Internet Settings/i,
  "normal tunnel operation must never mutate routes, adapters, DNS, or system proxy");

assert.match(uiSource, /启动本地 MCP/);
assert.match(uiSource, /启动公网隧道/);
assert.match(uiSource, /停止公网隧道/);
assert.match(uiSource, /保存并部署本地 MCP/);

console.log(JSON.stringify({
  localMcpAndPublicTunnelLifecycleSeparated: true,
  tunnelCredentialsNotRequiredForLocalInstall: true,
  publicTunnelOptInByDefault: true,
  updaterPreservesTunnelDisabledState: true,
  homepagePublicTrafficDisabled: true,
  intentionallyDisabledTunnelIsNeutralIdle: true,
  ngrokAgentDiscoveryUsesOwnedPidOnly: true,
  arbitraryLocalhostAgentPortScanning: false,
  topologyChangesAreReadOnly: true,
  ambientProxyEnvironmentIsScrubbed: true,
  explicitTunnelProxyStillSupported: true,
  vendorNeutral: true,
  normalNetworkMutation: false,
}));
