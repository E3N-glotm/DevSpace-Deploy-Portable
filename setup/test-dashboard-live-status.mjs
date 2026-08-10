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

const dashboardStart = source.indexOf("private TabPage BuildDashboardTab()");
const dashboardEnd = source.indexOf("private TabPage BuildConfigurationTab()", dashboardStart);
assert.ok(dashboardStart >= 0 && dashboardEnd > dashboardStart, "dashboard source block was not found");
const dashboard = source.slice(dashboardStart, dashboardEnd);

assert.match(source, /class StatusIndicatorCard/);
assert.match(source, /class DiagnosticsDetailsDialog/);
assert.match(source, /_statusTimer\.Interval = 7000/);
assert.match(source, /RunJsonAsync\("dashboard-status"\)/);
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
    DEVSPACE_TEST_NETWORK_CONFLICT: JSON.stringify({
      sangforActive: true,
      sangforConnected: true,
      competingTunDefault: true,
      tunInterfaces: ["singbox_tun"],
      source: "test",
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
assert.equal(value.indicators.network.state, "warning");
assert.match(value.indicators.network.title, /EasyConnect.*TUN/);
assert.equal(value.indicators.network.coexistence.competingTunDefault, true);
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
  externalTunConflictVisible: true,
  recentOperationsRemoved: true,
}));
