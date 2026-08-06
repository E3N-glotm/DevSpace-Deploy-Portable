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
  assert.deepEqual(report.uiTabs, ["状态与部署", "配置与权限", "插件管理", "会话与回退", "显式 Memories", "日志与诊断", "会话列表", "会话详情"]);
  const requiredButtons = [
    "添加工作目录", "安装插件", "刷新插件", "启用", "禁用",
    "绑定", "解除", "保存并自动部署", "只保存设置",
    "启动服务", "重启服务", "停止全部并退出", "停止并禁用",
    "恢复并启动", "刷新状态", "验证 HTTP", "诊断隧道",
    "验证文件", "打开日志目录", "任务计划程序", "查看本轮修改",
    "← 返回会话", "回退此次修改", "新建 Memory", "保存 Memory", "删除所选",
  ];
  for (const button of requiredButtons) {
    assert.ok(report.uiButtons.includes(button), `native UI button is missing: ${button}`);
  }
  console.log(JSON.stringify({ nativeExe: true, browserUi: false, tabs: report.uiTabs.length, buttons: report.uiButtons.length }));
}
finally {
  await rm(temporary, { recursive: true, force: true });
}
