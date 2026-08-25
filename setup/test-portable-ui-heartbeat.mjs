import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const setupDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(setupDir, "..");
const redirectHta = await readFile(join(setupDir, "Portable-Setup.hta"), "utf8");
const rootCmd = await readFile(join(root, "DevSpace-Portable.cmd"), "utf8");
const nativeSource = await readFile(join(setupDir, "native", "DevSpacePortableApp.cs"), "utf8");

assert.match(rootCmd, /DevSpace-Portable\.exe/i);
assert.doesNotMatch(rootCmd, /start[^\r\n]*mshta\.exe/i);
assert.match(redirectHta, /DevSpace-Portable\.exe/i);
assert.doesNotMatch(redirectHta, /portable-manager\.cjs/i);
assert.match(nativeSource, /_heartbeatTimer\.Interval\s*=\s*1500/);
assert.match(nativeSource, /RunJsonAsync\("ui-heartbeat"/);
assert.match(nativeSource, /RunJson\("ui-close"/);
assert.match(nativeSource, /停止全部并退出/);
assert.match(nativeSource, /会话与回退/);
assert.match(nativeSource, /显式 Memories/);
assert.match(nativeSource, /日志与诊断/);
assert.match(nativeSource, /正在执行，请稍候/);
assert.match(nativeSource, /internal static class SafeSplitLayout/);
assert.match(nativeSource, /SafeSplitLayout\.Bind\(split, 260, 240, 0\.55D\)/);
assert.match(nativeSource, /Text = "创建手动 OAuth 客户端"/);
assert.match(nativeSource, /Text = "选中客户端凭据"/);
assert.match(nativeSource, /new SurfacePanel/);
assert.match(nativeSource, /new FieldHost\(_clientId\)/);
assert.match(nativeSource, /new FieldHost\(_clientSecret\)/);
assert.match(nativeSource, /internal sealed class RemoteAgentTile/);
assert.match(nativeSource, /internal sealed class RemoteInputHost/);
assert.match(nativeSource, /internal sealed class RemoteCard/);
assert.match(nativeSource, /点击磁贴选择 Agent/);
assert.match(nativeSource, /默认无 sudo/);
assert.match(nativeSource, /AddNavigation\(navStack, 5, "远程服务器", "LINUX AGENTS", 2\)/);
assert.match(nativeSource, /BuildRemoteAgentsTab\(\)/);
assert.doesNotMatch(nativeSource, /ActionButton\("远程服务器 \/ Linux Agent", delegate \{ OpenRemoteAgentsDialog\(\); \}\)/);
assert.match(nativeSource, /Name = "RemoteAgentScrollViewport"/);
assert.match(nativeSource, /Name = "RemoteAgentScrollableContent"/);
assert.match(nativeSource, /IsAgentHeartbeatHealthy\("online-recent"\)/);
assert.match(nativeSource, /AutoScaleMode\s*=\s*AutoScaleMode\.Dpi/);
assert.doesNotMatch(nativeSource, /SplitterDistance\s*=\s*610/);

const temporary = await mkdtemp(join(tmpdir(), "devspace-native-ui-test-"));
try {
  const reportFile = join(temporary, "self-test.json");
  execFileSync(join(root, "DevSpace-Portable.exe"), ["--self-test", reportFile], {
    cwd: root,
    env: {
      ...process.env,
      DEVSPACE_PORTABLE_CONFIG_DIR: join(temporary, "config"),
      DEVSPACE_PORTABLE_STATE_DIR: join(temporary, "state"),
    },
    windowsHide: true,
    timeout: 60_000,
  });
  const report = JSON.parse((await readFile(reportFile, "utf8")).replace(/^\uFEFF/, ""));
  assert.equal(report.passed, true);
  assert.equal(report.splitterLayout?.passed, true);
  assert.equal(report.splitterLayout?.oauthDialog, true);
  assert.equal(report.splitterLayout?.oauthResponsiveColumns, true);
  assert.equal(report.splitterLayout?.remoteAgentsStableLayout, true);
  assert.ok(report.splitterLayout?.remoteAgentTileCount >= 1);
  assert.ok(report.splitterLayout?.remoteAgentInputHostCount >= 3);
  assert.ok(report.splitterLayout?.remoteAgentCardCount >= 2);
  assert.ok(report.splitterLayout?.remoteAgentButtonMinHeight >= 44);
  assert.equal(report.splitterLayout?.remoteAgentButtonsUnclipped, true);
  assert.equal(report.splitterLayout?.remoteAgentHintsUnclipped, true, JSON.stringify({
    ssh: [report.splitterLayout?.remoteAgentSshHintPreferredHeight, report.splitterLayout?.remoteAgentSshHintHeight],
    privilege: [report.splitterLayout?.remoteAgentPrivilegeHintPreferredHeight, report.splitterLayout?.remoteAgentPrivilegeHintHeight],
  }));
  assert.equal(report.splitterLayout?.remoteAgentScrollableLayout, true, JSON.stringify({
    contentHeight: report.splitterLayout?.remoteAgentScrollContentHeight,
    viewportHeight: report.splitterLayout?.remoteAgentScrollViewportHeight,
  }));
  assert.equal(report.splitterLayout?.remoteAgentAdminHeartbeatStatus, true);
  assert.equal(report.splitterLayout?.inputHostsFullHitTarget, true);
  assert.equal(report.splitterLayout?.fieldHostLowerHalfHitTarget, true);
  assert.equal(report.splitterLayout?.remoteInputLowerHalfHitTarget, true);
  assert.equal(report.splitterLayout?.comboBoxUnclipped, true);
  assert.equal(report.splitterLayout?.remoteAgentOfflineSshInstall, true);
  assert.ok(report.splitterLayout?.remoteAgentCommandHostHeight >= 64);
  assert.deepEqual(report.splitterLayout?.remoteAgentSizes, ["1040x760", "1120x800", "1220x860", "1440x920"]);
  assert.equal(report.splitterLayout?.dpiSafeDeferredLayout, true);
  assert.deepEqual(report.splitterLayout?.verticalWidths, [120, 240, 480, 820, 940, 1180, 1800]);
  assert.deepEqual(report.splitterLayout?.horizontalHeights, [90, 180, 360, 520, 700, 980]);
  assert.deepEqual(report.uiTabs, ["状态与部署", "配置与权限", "远程服务器", "插件管理", "续轮任务", "会话与回退", "显式 Memories", "日志与诊断", "会话列表", "会话详情"]);
  const requiredButtons = [
    "添加工作目录", "安装插件", "刷新插件", "启用", "禁用",
    "绑定", "解除", "保存并部署本地 MCP", "只保存设置",
    "保存 SSH 配置", "测试 SSH", "一键恢复 / 安装 Agent", "生成一次性安装命令", "刷新列表",
    "启动本地 MCP", "重启本地 MCP", "启动公网隧道", "重启公网隧道", "停止公网隧道",
    "停止全部并退出", "停止并禁用", "恢复并启动全部", "详细信息", "检查更新", "查看本轮修改",
    "刷新任务", "锁定 / 解锁", "手动结束", "恢复任务",
    "全部折叠", "全部展开",
    "← 返回会话", "打开差异窗口", "回退此次修改", "打开完整内容窗口",
    "新建 Memory", "保存 Memory", "删除所选",
  ];
  for (const button of requiredButtons) {
    assert.ok(report.uiButtons.includes(button), `native UI button is missing: ${button}`);
  }
  console.log(JSON.stringify({
    nativeExe: true,
    browserUi: false,
    splitterLayout: true,
    oauthClientDialogLayout: "responsive-surface-columns",
    remoteAgentDialogLayout: "responsive-hover-tile-layout",
    tabs: report.uiTabs.length,
    buttons: report.uiButtons.length,
  }));
}
finally {
  await rm(temporary, { recursive: true, force: true });
}
