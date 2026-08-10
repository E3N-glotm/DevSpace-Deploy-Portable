import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const NODE = resolve(ROOT, "runtime", "node", "node.exe");
const LAUNCHER = resolve(ROOT, "setup", "tunnel-launcher.cjs");
const temporary = mkdtempSync(join(tmpdir(), "devspace-tunnel-coexistence-"));
const configDir = join(temporary, "config");
const runDir = join(temporary, "run");
mkdirSync(configDir, { recursive: true });
mkdirSync(runDir, { recursive: true });
writeFileSync(join(configDir, "deployment.json"), JSON.stringify({
  formatVersion: 5,
  tunnelProvider: "ngrok",
  tunnelNetworkCompatibility: true,
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
    HTTP_PROXY: "",
    HTTPS_PROXY: "",
    ALL_PROXY: "",
    http_proxy: "",
    https_proxy: "",
    all_proxy: "",
    DEVSPACE_TEST_SANGFOR_STATE: "absent",
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

try {
  const registryBefore = registrySnapshot();

  const isolatedFromAmbientProxy = resolveNetwork({
    HTTP_PROXY: "http://127.0.0.1:10809",
    HTTPS_PROXY: "http://127.0.0.1:10809",
    DEVSPACE_TEST_PROXY_HEALTHY: "1",
  });
  assert.equal(isolatedFromAmbientProxy.paused, false);
  assert.equal(isolatedFromAmbientProxy.mode, "direct");
  assert.equal(isolatedFromAmbientProxy.proxyUrl, "");
  assert.equal(isolatedFromAmbientProxy.reason, "ambient-proxy-isolated-direct-or-transparent-tun");
  assert.equal(isolatedFromAmbientProxy.vpnState, "absent");

  writeFileSync(join(configDir, "ngrok.yml"), 'version: "3"\nagent:\n  authtoken: "test-token-value"\n  proxy_url: "http://127.0.0.1:10809"\n');
  const explicitProxy = resolveNetwork({ DEVSPACE_TEST_PROXY_HEALTHY: "1" });
  assert.equal(explicitProxy.paused, false);
  assert.equal(explicitProxy.mode, "manual-proxy");
  assert.equal(explicitProxy.proxyUrl, "http://127.0.0.1:10809");
  assert.equal(explicitProxy.proxySource, "ngrok-config");
  writeFileSync(join(configDir, "ngrok.yml"), 'version: "3"\nagent:\n  authtoken: "test-token-value"\n');

  const tun = resolveNetwork();
  assert.equal(tun.paused, false);
  assert.equal(tun.mode, "direct");
  assert.equal(tun.reason, "ambient-proxy-isolated-direct-or-transparent-tun");
  assert.equal(tun.vpnState, "absent");

  const negotiating = resolveNetwork({ DEVSPACE_TEST_SANGFOR_STATE: "negotiating" });
  assert.equal(negotiating.paused, true);
  assert.equal(negotiating.mode, "paused");
  assert.equal(negotiating.vpnState, "negotiating");
  assert.equal(negotiating.reason, "sangfor-vpn-session-isolation");

  const connected = resolveNetwork({ DEVSPACE_TEST_SANGFOR_STATE: "connected" });
  assert.equal(connected.paused, true);
  assert.equal(connected.vpnState, "connected");
  assert.equal(connected.reason, "sangfor-vpn-session-isolation");

  const cloudflareNormal = resolveNetwork({ DEVSPACE_TEST_TUNNEL_PROVIDER: "cloudflare" });
  assert.equal(cloudflareNormal.paused, false);
  assert.equal(cloudflareNormal.mode, "provider-managed");
  const cloudflareWithSangfor = resolveNetwork({
    DEVSPACE_TEST_TUNNEL_PROVIDER: "cloudflare",
    DEVSPACE_TEST_SANGFOR_STATE: "connected",
  });
  assert.equal(cloudflareWithSangfor.paused, true);
  assert.equal(cloudflareWithSangfor.reason, "sangfor-vpn-session-isolation");

  const launcherSource = await import("node:fs/promises").then(({ readFile }) => readFile(LAUNCHER, "utf8"));
  assert.match(launcherSource, /EasyConnect\|SangforCSClient/,
    "the tunnel supervisor must recognize active Sangfor clients");
  assert.match(launcherSource, /ServiceName -eq 'SangforVnic'/,
    "the tunnel supervisor must read the Sangfor VNIC state without mutating it");
  assert.match(launcherSource, /if \(child\) terminateChild\(`network-state:\$\{network\.reason\}`\)/,
    "network transitions may stop only the child object spawned by this supervisor");
  assert.doesNotMatch(launcherSource, /taskkill\.exe/i,
    "the tunnel supervisor must terminate through its owned ChildProcess handle, not an unverified PID");
  assert.match(launcherSource, /reason: "stop-request",[\s\S]*?shutdown\(\);/,
    "an explicit stop request must also end the tunnel supervisor");
  assert.doesNotMatch(launcherSource, /taskkill\.exe[^\n]*(EasyConnect|Sangfor)|Stop-Process[^\n]*(EasyConnect|Sangfor)/i,
    "the tunnel supervisor must never terminate a third-party VPN process");

  const registryAfter = registrySnapshot();
  assert.equal(registryAfter, registryBefore, "tunnel self-test modified WinINET proxy settings");

  console.log(JSON.stringify({
    ambientSystemProxyIsolatedFromNgrok: true,
    explicitNgrokProxyStillSupported: true,
    transparentTunUsesDirectPath: true,
    sangforNegotiationPause: true,
    fullSangforSessionIsolation: true,
    allPublicTunnelProvidersIsolated: true,
    thirdPartyVpnMutation: false,
    registryMutation: false,
  }));
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
