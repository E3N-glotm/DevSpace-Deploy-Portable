# DevSpace Portable 1.0.4

## 新增

- 图形界面可在 `ngrok 固定域名` 与 `Cloudflare Tunnel + 自定义域名` 之间切换，并分别记住两套公网根地址。
- 新增通用计划任务 `DevSpace Portable Tunnel`，根据 `deployment.json` 启动当前提供商。
- 新增 Cloudflare remotely-managed named tunnel Token 支持。
- Cloudflare Token 通过 `--token-file` 传递，不出现在 `cloudflared.exe` 命令行中。
- 发行包内置并校验固定版 `cloudflared 2026.7.3`；若运行时文件缺失，保存 Cloudflare 配置时会自动恢复下载：
  - 官方资产：`cloudflared-windows-amd64.exe`
  - SHA-256：`8635da433b6df8194746e88ed9d2589566c20e38bfc2a80e431a348b7c765841`
- 状态、HTTP 验证、诊断、日志与安全脱敏均按当前隧道提供商工作。

## 兼容与迁移

- 原 `ngrok.yml`、`auth.json` 和 `devspace.sqlite` 保留，不重置 OAuth 身份。
- Cloudflare Token 单独保存到 `data\config\cloudflare.token`；切回 ngrok 不删除该文件。
- 从 1.0.3 升级后，应打开界面并点击一次“保存并自动部署”。程序会停止并删除旧任务
  `DevSpace Portable ngrok Tunnel`，改用通用 Tunnel 任务。
- 旧的 `scripts\start-ngrok.cmd` 和 `start-ngrok.sh` 保留为兼容入口，但会转发到通用启动器。

## Cloudflare 控制台前置条件

1. 域名 DNS 已接入 Cloudflare。
2. 创建 remotely-managed named tunnel。
3. 在该 Tunnel 中创建 Published application：
   - Hostname：与 DevSpace Portable 中填写的公网域名完全一致；
   - Service URL：`http://127.0.0.1:7676`，或实际配置的本地端口。
4. 从 Tunnel 的 `Add a replica` 页面复制 `eyJ...` Tunnel Token。

随机 `trycloudflare.com` Quick Tunnel 不作为长期 OAuth MCP 部署模式。

## 验证范围

- Node 语法检查：通过。
- Git Bash 启动脚本语法检查：通过。
- ngrok 兼容配置写入：通过。
- Cloudflare 缺少 Token 时失败关闭且不下载运行时：通过。
- Cloudflare 实际公网连接必须使用用户自己的域名、Tunnel Token 和 Published application，
  因此本次代码阶段未进行真实账号端到端连接。
