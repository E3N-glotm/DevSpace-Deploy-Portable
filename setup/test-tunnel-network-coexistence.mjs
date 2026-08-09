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
    DEVSPACE_TEST_SYSTEM_PROXY: "",
    DEVSPACE_TEST_PROXY_HEALTHY: "",
    DEVSPACE_TEST_SANGFOR_STATE: "absent",
    DEVSPACE_TEST_SANGFOR_SETTLED: "",
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

  const proxy = resolveNetwork({
    DEVSPACE_TEST_SYSTEM_PROXY: "http://127.0.0.1:10809",
    DEVSPACE_TEST_PROXY_HEALTHY: "1",
  });
  assert.equal(proxy.paused, false);
  assert.equal(proxy.mode, "auto-proxy");
  assert.equal(proxy.proxyUrl, "http://127.0.0.1:10809");
  assert.equal(proxy.proxySource, "test-system-proxy");

  const negotiating = resolveNetwork({
    DEVSPACE_TEST_SYSTEM_PROXY: "http://127.0.0.1:10809",
    DEVSPACE_TEST_PROXY_HEALTHY: "1",
    DEVSPACE_TEST_SANGFOR_STATE: "negotiating",
  });
  assert.equal(negotiating.paused, true);
  assert.equal(negotiating.mode, "paused");
  assert.equal(negotiating.reason, "sangfor-vpn-negotiating");

  const connected = resolveNetwork({
    DEVSPACE_TEST_SYSTEM_PROXY: "http://127.0.0.1:10809",
    DEVSPACE_TEST_PROXY_HEALTHY: "1",
    DEVSPACE_TEST_SANGFOR_STATE: "connected",
    DEVSPACE_TEST_SANGFOR_SETTLED: "1",
  });
  assert.equal(connected.paused, false);
  assert.equal(connected.mode, "auto-proxy");
  assert.equal(connected.vpnState, "connected");

  const direct = resolveNetwork({ DEVSPACE_TEST_SANGFOR_STATE: "absent" });
  assert.equal(direct.paused, false);
  assert.ok(["direct", "auto-proxy"].includes(direct.mode));

  const registryAfter = registrySnapshot();
  assert.equal(registryAfter, registryBefore, "tunnel compatibility self-test modified WinINET proxy settings");

  console.log(JSON.stringify({
    autoProxyFollow: true,
    sangforNegotiationPause: true,
    sangforSettledResume: true,
    registryMutation: false,
  }));
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

