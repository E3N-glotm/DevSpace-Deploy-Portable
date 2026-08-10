import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const NODE = join(ROOT, "runtime", "node", "node.exe");
const MANAGER = join(ROOT, "setup", "portable-manager.cjs");
const UI = join(ROOT, "setup", "native", "DevSpacePortableApp.cs");
const source = readFileSync(UI, "utf8");
const managerSource = readFileSync(MANAGER, "utf8");

const dashboardStart = source.indexOf("private TabPage BuildDashboardTab()");
const dashboardEnd = source.indexOf("private TabPage BuildConfigurationTab()", dashboardStart);
assert.ok(dashboardStart >= 0 && dashboardEnd > dashboardStart, "dashboard source block was not found");
const dashboard = source.slice(dashboardStart, dashboardEnd);

assert.match(source, /class StatusIndicatorCard/);
assert.match(source, /class DiagnosticsDetailsDialog/);
assert.match(source, /网络隔离监测（推荐）/);
assert.match(source, /_statusTimer\.Interval = 3000/);
assert.match(source, /RunJsonAsync\("dashboard-status"\)/);
assert.match(source, /private async Task ShowDiagnosticsDetailsAsync\(\)[\s\S]*?dialog\.StatusChanged \+= async delegate[\s\S]*?await RefreshDashboardStatusAsync\(\)/);
assert.match(source, /private async Task DeployAsync\(\)[\s\S]*?await ExecuteBusyAsync[\s\S]*?\}\);\s*await RefreshDashboardStatusAsync\(\);/);
assert.match(managerSource, /childProcess\.spawn\(CURL_EXE/);
assert.doesNotMatch(managerSource.slice(managerSource.indexOf("function curlProbe"), managerSource.indexOf("function loopbackProbe")), /spawnSync/);
assert.match(managerSource, /function loopbackProbe/);
assert.match(managerSource, /function cachedDashboardPublicProbes/);
const dashboardStatusStart = managerSource.indexOf("async function dashboardStatus()");
const dashboardStatusEnd = managerSource.indexOf("async function testEndpoints()", dashboardStatusStart);
assert.ok(dashboardStatusStart >= 0 && dashboardStatusEnd > dashboardStatusStart);
const dashboardManagerBlock = managerSource.slice(dashboardStatusStart, dashboardStatusEnd);
assert.doesNotMatch(dashboardManagerBlock, /dashboardPublicProbes\(/,
  "homepage status must never actively call the public DevSpace URL");
assert.match(dashboardManagerBlock, /cachedDashboardPublicProbes\(/,
  "homepage may only consume a previously recorded explicit public verification");
assert.match(dashboard, /ActionButton\("详细信息"/);
assert.doesNotMatch(dashboard, /ActionButton\("刷新状态"/);
assert.doesNotMatch(dashboard, /ActionButton\("验证 HTTP"/);
assert.doesNotMatch(dashboard, /ActionButton\("诊断隧道"/);
assert.match(source, /ActionButton\("验证 HTTP"/);
assert.match(source, /ActionButton\("诊断隧道"/);
assert.match(source, /ActionButton\("验证文件"/);
assert.match(source, /=== Update ===/);

const result = spawnSync(NODE, [MANAGER, "dashboard-status"], {
  cwd: ROOT,
  env: {
    ...process.env,
    DEVSPACE_TEST_NETWORK_PATH: JSON.stringify({
      defaultRouteCount: 2,
      multipleDefaultRoutes: true,
      routes: [
        { ifIndex: 7, interfaceAlias: "path-a", nextHop: "192.0.2.1", routeMetric: 0, interfaceMetric: 25 },
        { ifIndex: 9, interfaceAlias: "path-b", nextHop: "198.51.100.1", routeMetric: 5, interfaceMetric: 25 },
      ],
      source: "test",
    }),
    DEVSPACE_TEST_TUNNEL_NETWORK_STATE: JSON.stringify({
      paused: false,
      mode: "system-routed",
      proxySource: "none",
      policy: "non-invasive",
      reason: "network-path-stable",
      transition: "stable",
      reconnectCount: 1,
    }),
  },
  encoding: "utf8",
  windowsHide: true,
  timeout: 30_000,
});
assert.equal(result.status, 0, result.stderr || result.stdout);
const value = JSON.parse(result.stdout.trim());
assert.ok(value.overall && typeof value.overall.state === "string");
for (const key of ["service", "tunnel", "http", "files", "network"]) {
  assert.ok(value.indicators?.[key], `missing dashboard indicator: ${key}`);
  assert.ok(["ready", "warning", "error", "stopped", "working"].includes(value.indicators[key].state));
  assert.equal(typeof value.indicators[key].title, "string");
  assert.equal(typeof value.indicators[key].detail, "string");
}
assert.equal(value.indicators.network.state, "ready");
assert.match(value.indicators.network.title, /网络路径自适应正常/);
assert.equal(value.indicators.network.networkPath.multipleDefaultRoutes, true);
assert.equal(value.indicators.network.networkPath.defaultRouteCount, 2);
assert.match(value.indicators.network.detail, /不按软件名称干预/);
assert.doesNotMatch(managerSource, /EasyConnect|Sangfor|SangforVnic/i);
const routeOnlyResult = spawnSync(NODE, [MANAGER, "dashboard-status"], {
  cwd: ROOT,
  env: {
    ...process.env,
    DEVSPACE_TEST_NETWORK_PATH: JSON.stringify({
      defaultRouteCount: 1,
      multipleDefaultRoutes: false,
      routes: [{ ifIndex: 7, interfaceAlias: "path-a", nextHop: "192.0.2.1", routeMetric: 0, interfaceMetric: 25 }],
      source: "test",
    }),
    DEVSPACE_TEST_TUNNEL_NETWORK_STATE: "null",
  },
  encoding: "utf8",
  windowsHide: true,
  timeout: 30_000,
});
assert.equal(routeOnlyResult.status, 0, routeOnlyResult.stderr || routeOnlyResult.stdout);
const routeOnlyValue = JSON.parse(routeOnlyResult.stdout.trim());
assert.match(routeOnlyValue.indicators.network.title, /网络路径已读取，等待隧道运行/);
assert.match(source, /连续两次确认后才会标记为异常/);
assert.doesNotMatch(dashboard, /NewGroup\("最近操作"\)/);

console.log(JSON.stringify({
  automaticStatusIndicators: true,
  manualRefreshRemovedFromHomepage: true,
  detailedDiagnosticsDialog: true,
  httpTunnelFileChecksPreserved: true,
  logDetailsPreserved: true,
  structuredDashboardStatus: true,
  transientFailureDebounce: true,
  homepagePublicProbeDisabled: true,
  directLoopbackProbe: true,
  cachedExplicitPublicVerification: true,
  threeSecondLocalRefresh: true,
  dashboardRefreshesAfterDeployment: true,
  detailsRefreshesHomepage: true,
  multipleDefaultRoutesAreInformational: true,
  vendorNeutralNetworkDiagnostics: true,
  routeStateTitleConvergesWithoutTunnelState: true,
  recentOperationsRemoved: true,
}));
