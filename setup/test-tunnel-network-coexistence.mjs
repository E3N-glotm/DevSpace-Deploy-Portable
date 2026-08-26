import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const NODE = resolve(ROOT, "runtime", "node", "node.exe");
const LAUNCHER = resolve(ROOT, "setup", "tunnel-launcher.cjs");
const MANAGER = resolve(ROOT, "setup", "portable-manager.cjs");
const temporary = mkdtempSync(join(tmpdir(), "devspace-tunnel-coexistence-"));
const configDir = join(temporary, "config");
const runDir = join(temporary, "run");
mkdirSync(configDir, { recursive: true });
mkdirSync(runDir, { recursive: true });
writeFileSync(join(configDir, "deployment.json"), JSON.stringify({
  formatVersion: 5,
  tunnelProvider: "ngrok",
  tunnelNetworkCompatibility: true,
  publicBaseUrl: "https://example.invalid",
  port: 7676,
}, null, 2));
writeFileSync(join(configDir, "ngrok.yml"), 'version: "3"\nagent:\n  authtoken: "test-token-value"\n');

function registrySnapshot() {
  const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
  const query = (name) => spawnSync("reg.exe", ["query", key, "/v", name], {
    encoding: "utf8",
    windowsHide: true,
  }).stdout || "";
  return `${query("ProxyEnable")}\n${query("ProxyServer")}`;
}

function resolveNetwork(overrides = {}) {
  const env = {
    ...process.env,
    DEVSPACE_PORTABLE_CONFIG_DIR: configDir,
    DEVSPACE_PORTABLE_RUN_DIR: runDir,
    DEVSPACE_TEST_PROXY_HEALTHY: "",
    DEVSPACE_TEST_ROUTE_SIGNATURE: "route-a",
    DEVSPACE_TEST_DEFAULT_ROUTE_COUNT: "1",
    HTTP_PROXY: "",
    HTTPS_PROXY: "",
    ALL_PROXY: "",
    http_proxy: "",
    https_proxy: "",
    all_proxy: "",
    ...overrides,
  };
  const result = spawnSync(NODE, [LAUNCHER, "--network-self-test"], {
    cwd: ROOT,
    env,
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `launcher exited ${result.status}`);
  return JSON.parse(result.stdout.trim());
}

function resolvePublicHealth(mode, agentMode = "") {
  const result = spawnSync(NODE, [LAUNCHER, "--public-health-self-test"], {
    cwd: ROOT,
    env: {
      ...process.env,
      DEVSPACE_PORTABLE_CONFIG_DIR: configDir,
      DEVSPACE_PORTABLE_RUN_DIR: runDir,
      DEVSPACE_TEST_ROUTE_SIGNATURE: "route-a",
      DEVSPACE_TEST_PUBLIC_HEALTH: mode,
      DEVSPACE_TEST_NGROK_AGENT_HEALTH: agentMode,
    },
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `launcher exited ${result.status}`);
  return JSON.parse(result.stdout.trim());
}

try {
  const registryBefore = registrySnapshot();

  const systemRouted = resolveNetwork({
    HTTP_PROXY: "http://127.0.0.1:10809",
    HTTPS_PROXY: "http://127.0.0.1:10809",
    DEVSPACE_TEST_PROXY_HEALTHY: "1",
  });
  assert.equal(systemRouted.paused, false);
  assert.equal(systemRouted.mode, "system-routed");
  assert.equal(systemRouted.proxyUrl, "");
  assert.equal(systemRouted.reason, "network-path-stable");
  assert.equal(systemRouted.pathSignature, "route-a");
  assert.equal(systemRouted.adaptation, true);

  writeFileSync(join(configDir, "ngrok.yml"), 'version: "3"\nagent:\n  authtoken: "test-token-value"\n  proxy_url: "http://127.0.0.1:10809"\n');
  const explicitProxy = resolveNetwork({ DEVSPACE_TEST_PROXY_HEALTHY: "1" });
  assert.equal(explicitProxy.paused, false);
  assert.equal(explicitProxy.mode, "manual-proxy");
  assert.equal(explicitProxy.proxyUrl, "http://127.0.0.1:10809");
  assert.equal(explicitProxy.proxySource, "ngrok-config");
  assert.equal(explicitProxy.egressPolicy, "explicit-proxy");
  assert.equal(explicitProxy.crossPathFallback, false);

  const unavailableExplicitProxy = resolveNetwork({ DEVSPACE_TEST_PROXY_HEALTHY: "0" });
  assert.equal(unavailableExplicitProxy.paused, true);
  assert.equal(unavailableExplicitProxy.reason, "explicit-local-proxy-unavailable");
  writeFileSync(join(configDir, "ngrok.yml"), 'version: "3"\nagent:\n  authtoken: "test-token-value"\n');

  const multipleRoutes = resolveNetwork({ DEVSPACE_TEST_DEFAULT_ROUTE_COUNT: "3" });
  assert.equal(multipleRoutes.paused, false);
  assert.equal(multipleRoutes.multipleDefaultRoutes, true);
  assert.equal(multipleRoutes.defaultRouteCount, 3);

  const cloudflare = resolveNetwork({ DEVSPACE_TEST_TUNNEL_PROVIDER: "cloudflare" });
  assert.equal(cloudflare.paused, false);
  assert.equal(cloudflare.mode, "provider-managed");
  assert.equal(cloudflare.reason, "network-path-stable");

  const publicHealthy = resolvePublicHealth("healthy");
  assert.equal(publicHealthy.actionable, true);
  assert.equal(publicHealthy.healthy, true);
  assert.equal(publicHealthy.localStatus, 401);
  assert.equal(publicHealthy.publicStatus, 401);
  const publicBroken = resolvePublicHealth("failing");
  assert.equal(publicBroken.actionable, true);
  assert.equal(publicBroken.healthy, false);
  assert.equal(publicBroken.localStatus, 401);
  assert.equal(publicBroken.publicStatus, 0);
  assert.equal(publicBroken.publicCurlExitCode, 28);
  assert.equal(publicBroken.publicErrorKind, "timeout");
  assert.equal(publicBroken.recoveryEligible, false,
    "a public probe failure without owned-agent mismatch evidence must stay non-destructive");
  const dnsBrokenButAgentHealthy = resolvePublicHealth("dns-failing", "matching");
  assert.equal(dnsBrokenButAgentHealthy.publicErrorKind, "dns");
  assert.equal(dnsBrokenButAgentHealthy.agentReachable, true);
  assert.equal(dnsBrokenButAgentHealthy.agentMatchingTunnel, true);
  assert.equal(dnsBrokenButAgentHealthy.recoveryEligible, false,
    "transient DNS failure must not make a healthy owned ngrok tunnel restartable");
  const missingOwnedTunnel = resolvePublicHealth("connect-failing", "missing");
  assert.equal(missingOwnedTunnel.publicErrorKind, "connect");
  assert.equal(missingOwnedTunnel.agentReachable, true);
  assert.equal(missingOwnedTunnel.agentMatchingTunnel, false);
  assert.equal(missingOwnedTunnel.recoveryEligible, true,
    "only a reachable owned agent that repeatedly reports the expected tunnel missing may authorize recovery");
  const tlsBroken = resolvePublicHealth("tls-failing", "matching");
  assert.equal(tlsBroken.publicCurlExitCode, 60);
  assert.equal(tlsBroken.publicErrorKind, "tls");
  const localBroken = resolvePublicHealth("local-failing");
  assert.equal(localBroken.actionable, false,
    "a local MCP outage must not be misdiagnosed as a tunnel fault");

  writeFileSync(join(configDir, "deployment.json"), JSON.stringify({
    formatVersion: 5,
    tunnelProvider: "ngrok",
    tunnelNetworkCompatibility: false,
  }, null, 2));
  const adaptationDisabled = resolveNetwork();
  assert.equal(adaptationDisabled.paused, false);
  assert.equal(adaptationDisabled.adaptation, false);
  assert.equal(adaptationDisabled.pathSignature, "");
  assert.equal(adaptationDisabled.reason, "network-adaptation-disabled");
  writeFileSync(join(configDir, "deployment.json"), `\uFEFF${JSON.stringify({
    formatVersion: 5,
    tunnelProvider: "ngrok",
    tunnelNetworkCompatibility: false,
  }, null, 2)}`);
  const bomEncodedConfiguration = resolveNetwork();
  assert.equal(bomEncodedConfiguration.adaptation, false,
    "a UTF-8 BOM must not silently re-enable network compatibility");
  writeFileSync(join(configDir, "deployment.json"), JSON.stringify({
    formatVersion: 5,
    tunnelProvider: "ngrok",
    tunnelNetworkCompatibility: true,
  }, null, 2));

  const launcherSource = readFileSync(LAUNCHER, "utf8");
  const managerSource = readFileSync(MANAGER, "utf8");
  assert.match(launcherSource, /Get-NetIPAddress[^\n]+ActiveStore/,
    "the supervisor must observe connected IPv4 addresses without identifying a vendor");
  assert.match(launcherSource, /Get-NetRoute[^\n]+ActiveStore/,
    "the supervisor must observe all active IPv4 routes, including split routes");
  assert.match(launcherSource, /transition: pathChanged \? "topology-changed-no-restart" : "stable"/,
    "third-party route or adapter changes must be recorded without restarting the owned tunnel");
  assert.doesNotMatch(launcherSource, /terminateChild\("network-path-quiescing"\)|network-path-settled-reconnect/,
    "third-party topology changes must not trigger proactive tunnel churn");
  assert.match(launcherSource, /PUBLIC_HEALTH_FAILURE_THRESHOLD = 3/,
    "a single public probe failure must not churn the tunnel");
  assert.match(launcherSource, /PUBLIC_HEALTH_AGENT_MISMATCH_THRESHOLD = 3/,
    "recovery must require repeated owned-agent mismatch evidence in addition to public failures");
  assert.match(launcherSource, /PUBLIC_HEALTH_RESTART_COOLDOWN_MS = 5 \* 60_000/,
    "public-health recovery must use hysteresis/backoff during wider internet outages");
  assert.match(launcherSource, /agent\.reachable === true && agent\.matchingTunnel === false/,
    "public self-probe failure alone must not authorize a destructive restart");
  assert.match(launcherSource, /terminateChild\("owned-ngrok-agent-missing-expected-tunnel"\)/,
    "only confirmed owned-agent mismatch may restart the owned tunnel child");
  assert.match(launcherSource, /local\.status !== 401[\s\S]*?actionable: false/,
    "tunnel recovery must not fire when the local MCP itself is unhealthy");
  assert.match(launcherSource, /publicHealthCurlExitCode[\s\S]*?publicHealthErrorKind[\s\S]*?publicHealthErrorDetail/,
    "network state must persist detailed curl failure diagnostics instead of collapsing everything to status 0");
  assert.match(launcherSource, /ownedChild\.kill\(\)/,
    "network transitions may stop only the ChildProcess owned by this supervisor");
  assert.doesNotMatch(launcherSource, /EasyConnect|Sangfor|SangforVnic|WireGuard|OpenVPN|AnyConnect|GlobalProtect/i,
    "the tunnel lifecycle must not depend on product or vendor names");
  assert.doesNotMatch(launcherSource, /tasklist\.exe|Get-CimInstance\s+Win32_Process/i,
    "the tunnel lifecycle must not infer network state from third-party processes");
  assert.doesNotMatch(launcherSource, /taskkill\.exe/i,
    "the supervisor must not terminate an unverified PID");
  assert.doesNotMatch(launcherSource, /(?:New|Set|Remove)-NetRoute|route\.exe|netsh\.exe|Set-ItemProperty[^\n]+Internet Settings/i,
    "network adaptation must never mutate routes, adapters, or system proxy settings");
  assert.doesNotMatch(launcherSource, /winInetLocalProxyCandidate|discoverAmbientLocalProxy|isolated-proxy/,
    "ambient proxies must not be injected into ngrok because that capability may require a paid account");
  assert.match(launcherSource, /egressPolicy: manualProxy \? "explicit-proxy" : "windows-system-route"/,
    "only an explicit ngrok proxy may override Windows system routing");
  assert.match(launcherSource, /reason: "stop-request",[\s\S]*?shutdown\(\);/,
    "an explicit stop request must also end the tunnel supervisor");
  assert.match(managerSource, /if \(supervisor\.running\) \{[\s\S]*?deferred: true,[\s\S]*?public-tunnel-recovering-on-current-network-path/,
    "a live tunnel supervisor must preserve local MCP while public readiness recovers");
  assert.doesNotMatch(managerSource, /EasyConnect|Sangfor|SangforVnic/i,
    "dashboard and service readiness must also remain vendor-neutral");

  const registryAfter = registrySnapshot();
  assert.equal(registryAfter, registryBefore, "tunnel self-test modified WinINET proxy settings");

  console.log(JSON.stringify({
    vendorNeutralNetworkPathAdaptation: true,
    publicTunnelRemainsStableAcrossRouteChanges: true,
    publicEndpointHealthRecovery: true,
    publicProbeFailureClassification: true,
    ownedAgentRecoveryGate: true,
    publicReadinessFailurePreservesLocalService: true,
    topologyChangeDoesNotRestartOwnedTunnel: true,
    splitRouteAndAddressChangesAreObserved: true,
    explicitNgrokProxyStillSupported: true,
    ambientProxyInjection: false,
    utf8BomConfigurationSupported: true,
    thirdPartyProcessMutation: false,
    routeOrRegistryMutation: false,
  }));
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
