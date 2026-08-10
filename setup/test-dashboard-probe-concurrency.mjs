import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const NODE = join(ROOT, "runtime", "node", "node.exe");
const MANAGER = join(ROOT, "setup", "portable-manager.cjs");
const temporary = mkdtempSync(join(tmpdir(), "devspace-dashboard-passive-"));
const configDir = join(temporary, "config");
const stateDir = join(temporary, "state");
const runDir = join(temporary, "run");
mkdirSync(configDir, { recursive: true });
mkdirSync(stateDir, { recursive: true });
mkdirSync(runDir, { recursive: true });

const helperSource = String.raw`
const http = require("http");
const service = http.createServer((request, response) => {
  const status = request.url === "/mcp" ? 401 : 200;
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", connection: "close" });
  response.end("{}\n");
});
service.listen(0, "127.0.0.1", () => {
  process.stdout.write(JSON.stringify({ servicePort: service.address().port }) + "\n");
});
process.on("SIGTERM", () => service.close(() => process.exit(0)));
`;

const helper = spawn(NODE, ["-e", helperSource], {
  cwd: ROOT,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});

function helperPort() {
  return new Promise((resolvePort, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`dashboard helper did not start: ${stderr}`)), 8_000);
    helper.stdout.setEncoding("utf8");
    helper.stderr.setEncoding("utf8");
    helper.stderr.on("data", (chunk) => { stderr += chunk; });
    helper.stdout.on("data", (chunk) => {
      stdout += chunk;
      const newline = stdout.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      resolvePort(JSON.parse(stdout.slice(0, newline)).servicePort);
    });
    helper.once("error", reject);
  });
}

try {
  const servicePort = await helperPort();
  writeFileSync(join(configDir, "deployment.json"), JSON.stringify({
    formatVersion: 5,
    port: servicePort,
    tunnelProvider: "ngrok",
    tunnelNetworkCompatibility: true,
  }));
  writeFileSync(join(configDir, "config.json"), JSON.stringify({
    port: servicePort,
    publicBaseUrl: "https://dashboard-must-not-be-contacted.invalid",
  }));

  const startedAt = Date.now();
  const result = spawnSync(NODE, [MANAGER, "dashboard-status"], {
    cwd: ROOT,
    env: {
      ...process.env,
      DEVSPACE_PORTABLE_CONFIG_DIR: configDir,
      DEVSPACE_PORTABLE_STATE_DIR: stateDir,
      DEVSPACE_PORTABLE_RUN_DIR: runDir,
      DEVSPACE_TEST_NETWORK_PATH: JSON.stringify({
        defaultRouteCount: 1,
        multipleDefaultRoutes: false,
        routes: [{ ifIndex: 1, interfaceAlias: "test", nextHop: "192.0.2.1", routeMetric: 0, interfaceMetric: 1 }],
        source: "test",
      }),
      DEVSPACE_TEST_TUNNEL_NETWORK_STATE: JSON.stringify({
        paused: false,
        mode: "manual-proxy",
        proxyUrl: "http://127.0.0.1:9",
        proxySource: "explicit-test-proxy",
        policy: "non-invasive",
        reason: "network-path-stable",
        transition: "stable",
      }),
    },
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  });
  const elapsedMs = Date.now() - startedAt;
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const dashboard = JSON.parse(result.stdout.trim());
  assert.equal(dashboard.indicators.http.localMetadata.status, 200);
  assert.equal(dashboard.indicators.http.localMcp.status, 401);
  assert.equal(dashboard.indicators.http.publicMetadata.transport, "passive");
  assert.equal(dashboard.indicators.http.publicMcp.transport, "passive");
  assert.equal(dashboard.indicators.http.publicVerification.passive, true);
  assert.ok(elapsedMs < 4_000, `homepage status unexpectedly waited on public networking: ${elapsedMs} ms`);

  console.log(JSON.stringify({
    dashboardUsesOnlyLocalActiveProbes: true,
    publicVerificationIsPassiveOnHomepage: true,
    explicitProxyIsNotTouchedByHomepage: true,
    boundedDashboardLatency: true,
  }));
}
finally {
  try { helper.kill(); } catch {}
}
