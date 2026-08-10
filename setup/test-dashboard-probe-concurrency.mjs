import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const NODE = join(ROOT, "runtime", "node", "node.exe");
const MANAGER = join(ROOT, "setup", "portable-manager.cjs");
const temporary = mkdtempSync(join(tmpdir(), "devspace-dashboard-probes-"));
const configDir = join(temporary, "config");
const stateDir = join(temporary, "state");
const runDir = join(temporary, "run");
mkdirSync(configDir, { recursive: true });
mkdirSync(stateDir, { recursive: true });
mkdirSync(runDir, { recursive: true });

const helperSource = String.raw`
const http = require("http");
const net = require("net");
const service = http.createServer((request, response) => {
  const status = request.url === "/mcp" ? 401 : 200;
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", connection: "close" });
  response.end("{}\n");
});
const proxySockets = new Set();
const proxy = net.createServer((socket) => {
  proxySockets.add(socket);
  socket.on("close", () => proxySockets.delete(socket));
  // Intentionally accept and never answer. Public curl requests must time out
  // without starving the independent loopback HTTP checks.
});
function close() {
  for (const socket of proxySockets) socket.destroy();
  proxy.close();
  service.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on("SIGTERM", close);
process.on("SIGINT", close);
service.listen(0, "127.0.0.1", () => {
  proxy.listen(0, "127.0.0.1", () => {
    process.stdout.write(JSON.stringify({ servicePort: service.address().port, proxyPort: proxy.address().port }) + "\n");
  });
});
`;

const helper = spawn(NODE, ["-e", helperSource], {
  cwd: ROOT,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});

function helperPorts() {
  return new Promise((resolvePorts, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`probe helper did not start: ${stderr}`)), 8_000);
    helper.stdout.setEncoding("utf8");
    helper.stderr.setEncoding("utf8");
    helper.stderr.on("data", (chunk) => { stderr += chunk; });
    helper.stdout.on("data", (chunk) => {
      stdout += chunk;
      const newline = stdout.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      try { resolvePorts(JSON.parse(stdout.slice(0, newline))); }
      catch (error) { reject(error); }
    });
    helper.once("error", reject);
    helper.once("exit", (code) => reject(new Error(`probe helper exited early (${code}): ${stderr}`)));
  });
}

function runDashboardAsync(env) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(NODE, [MANAGER, "dashboard-status"], {
      cwd: ROOT,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      reject(new Error(`dashboard did not stop after topology quiescence: ${stderr}`));
    }, 10_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolveResult({ status: code, stdout, stderr });
    });
  });
}

try {
  const { servicePort, proxyPort } = await helperPorts();
  writeFileSync(join(runDir, "tunnel-supervisor.pid"), `${helper.pid}\n`);
  writeFileSync(join(configDir, "deployment.json"), JSON.stringify({
    formatVersion: 5,
    port: servicePort,
    tunnelProvider: "ngrok",
    tunnelNetworkCompatibility: true,
  }));
  writeFileSync(join(configDir, "config.json"), JSON.stringify({
    port: servicePort,
    publicBaseUrl: "https://dashboard-probe.invalid",
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
        proxyUrl: `http://127.0.0.1:${proxyPort}`,
        proxySource: "ngrok-config",
        policy: "non-invasive",
        reason: "network-path-stable",
        transition: "stable",
      }),
    },
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
  });
  const elapsedMs = Date.now() - startedAt;
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const dashboard = JSON.parse(result.stdout.trim());
  assert.equal(dashboard.indicators.http.localMetadata.status, 200);
  assert.equal(dashboard.indicators.http.localMcp.status, 401);
  assert.equal(dashboard.indicators.http.state, "warning");
  assert.ok(elapsedMs < 10_000, `dashboard probes exceeded bounded runtime: ${elapsedMs} ms`);
  assert.equal(dashboard.indicators.http.publicMetadata.transport, "failed");
  assert.match(dashboard.indicators.http.publicMetadata.error, /ngrok-config/);

  const quietStartedAt = Date.now();
  const quietResult = spawnSync(NODE, [MANAGER, "dashboard-status"], {
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
        mode: "system-routed",
        proxyUrl: "",
        proxySource: "none",
        policy: "non-invasive",
        reason: "network-path-settling",
        transition: "network-path-quiescing",
        status: "paused",
        publicProbesSuppressed: true,
        updatedAt: new Date().toISOString(),
      }),
    },
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  });
  const quietElapsedMs = Date.now() - quietStartedAt;
  assert.equal(quietResult.status, 0, quietResult.stderr || quietResult.stdout);
  const quietDashboard = JSON.parse(quietResult.stdout.trim());
  assert.equal(quietDashboard.indicators.http.localMetadata.status, 200);
  assert.equal(quietDashboard.indicators.http.localMcp.status, 401);
  assert.equal(quietDashboard.indicators.http.publicMetadata.transport, "suppressed");
  assert.equal(quietDashboard.indicators.http.publicVerification.suppressed, true);
  assert.equal(quietDashboard.indicators.tunnel.state, "warning");
  assert.equal(quietDashboard.indicators.network.state, "warning");
  assert.ok(quietElapsedMs < 4_000, `quiet-window dashboard unexpectedly used public network: ${quietElapsedMs} ms`);

  writeFileSync(join(configDir, "config.json"), JSON.stringify({
    port: servicePort,
    publicBaseUrl: "https://dashboard-cancel.invalid",
  }));
  rmSync(join(runDir, "dashboard-public-probe.json"), { force: true });
  writeFileSync(join(runDir, "tunnel-network.json"), JSON.stringify({
    paused: false,
    mode: "manual-proxy",
    proxyUrl: `http://127.0.0.1:${proxyPort}`,
    proxySource: "ngrok-config",
    policy: "non-invasive",
    reason: "network-path-stable",
    transition: "stable",
    status: "running",
    publicProbesSuppressed: false,
    updatedAt: new Date().toISOString(),
  }));
  const cancellationStartedAt = Date.now();
  const cancellationPending = runDashboardAsync({
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
    DEVSPACE_TEST_TUNNEL_NETWORK_STATE: "",
  });
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 600));
  writeFileSync(join(runDir, "tunnel-network.json"), JSON.stringify({
    paused: false,
    mode: "system-routed",
    proxyUrl: "",
    proxySource: "none",
    policy: "non-invasive",
    reason: "network-path-settling",
    transition: "network-path-quiescing",
    status: "paused",
    publicProbesSuppressed: true,
    updatedAt: new Date().toISOString(),
  }));
  const cancellationResult = await cancellationPending;
  const cancellationElapsedMs = Date.now() - cancellationStartedAt;
  assert.equal(cancellationResult.status, 0, cancellationResult.stderr || cancellationResult.stdout);
  const cancelledDashboard = JSON.parse(cancellationResult.stdout.trim());
  assert.equal(cancelledDashboard.indicators.http.localMetadata.status, 200);
  assert.equal(cancelledDashboard.indicators.http.localMcp.status, 401);
  assert.equal(cancelledDashboard.indicators.http.publicMetadata.transport, "suppressed");
  assert.equal(cancelledDashboard.indicators.http.publicVerification.suppressed, true);
  assert.ok(cancellationElapsedMs < 4_000,
    `in-flight public probes were not cancelled promptly: ${cancellationElapsedMs} ms`);

  console.log(JSON.stringify({
    loopbackProbeSurvivesSlowPublicProxy: true,
    localMetadataStatus: dashboard.indicators.http.localMetadata.status,
    localMcpStatus: dashboard.indicators.http.localMcp.status,
    publicFallbackToDirect: false,
    elapsedMs,
    publicProbeSuppressedDuringTopologyChange: true,
    localServiceRemainsVisibleDuringTopologyChange: true,
    quietElapsedMs,
    inFlightPublicProbeCancelledOnTopologyChange: true,
    cancellationElapsedMs,
  }));
} finally {
  if (!helper.killed) helper.kill();
  rmSync(temporary, { recursive: true, force: true });
}
