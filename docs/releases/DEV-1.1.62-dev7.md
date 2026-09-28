# DevSpace Portable 1.1.62 dev7 — 功能分层与桌面 UI 收束

仅在 `E:\program\Python\DevSpaceDeploy` 原始源码目录迭代；开发和验收不覆盖 `D:\DevSpacePortable`，不建立 C 盘工作树。

## 用户可见变更

- 首页保留状态总览，配置服务、服务管理、保存、应用并重启、MCP/隧道重启、复制地址、检查更新、添加工作目录及文件/操作权限模式等高频操作保留一步入口。
- 设置分为基本设置、连接与部署、文件访问、操作权限、更新、高级六个子页面，不再把所有控件堆放在同一长页面；文件访问范围和操作能力保持独立的设置及持久化逻辑。
- 关闭窗口的 Electron 内部确认框采用统一的应用卡片、按钮、字体和间距，不再模拟旧版系统窗口；保留最小化到系统托盘、仅退出控制中心、取消、记住选择、托盘恢复及“每次询问”。设置页也可以直接更改关闭行为。
- 服务管理页优先显示常用的启动/重启和 Computer Use 开关，把停用、卸载、任务维护收进高级区域；诊断页将代理修复与恢复收进高级区域，保留原有二次确认。
- 更新仍在设置 → 更新子页面；从首页单击“检查更新”会打开该子页面并执行一次检查，安装更新仍须单独确认。

## 安全与兼容

- Owner Password、OAuth/Token 继续仅在主进程读取；渲染进程只显示掩码和受限复制接口。
- `setClosePreference` IPC 严格只接受 `''`、`minimize-tray`、`exit-ui`，仅保存 UI 偏好，不改变服务和隧道状态。
- 不删除旧功能后端，不打开旧 WinForms；现有计划任务、OAuth、配置和 SQLite 保持不变。

## 验收

在 E 盘隔离配置目录下执行 `ui-next/runtime/electron.exe ui-next --devspace-ui-navigation-smoke` 与 `--devspace-ui-close-smoke`，并完成 `npm --prefix ui-next run build`、`npm --prefix ui-next test`；随后运行版本清单更新、正式构建、ZIP 哈希与敏感状态排除检查。

这份文档描述开发版，不表示已部署到 D-live；只有正式安装后再核验真实 UI 与长期连接状态。
