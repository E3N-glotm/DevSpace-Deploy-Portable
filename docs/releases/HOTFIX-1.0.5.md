# DevSpace Portable 1.0.5

本版本基于 1.0.4，新增图形界面的 DevSpace 工具模式选择，并保持原有 ngrok、Cloudflare Tunnel、OAuth 状态和最低权限计划任务逻辑不变。

## 新增功能

- 在 `Portable-Setup.hta` 中新增“DevSpace 工具模式”下拉框；
- 支持 DevSpace 1.0.5 核心允许的全部三种模式：
  - `full`：默认且推荐，提供完整文件、搜索和目录工具；
  - `codex`：实验模式，提供 `apply_patch`、`exec_command` 和 `write_stdin`，适合跨文件补丁；
  - `minimal`：精简模式，只保留基础读写编辑与 shell 工具；
- 工具模式写入 `data\config\deployment.json`，迁移目录或重启电脑后仍会保留；
- `scripts\start-devspace.sh` 在每次启动时读取持久化模式，不再把 `full` 写死；
- “保存并自动部署”改为保存后重启服务，确保新模式立即加载；
- “查看状态”和启动日志会显示当前工具模式。

## 兼容性

旧版 `deployment.json` 没有 `toolMode` 字段时自动使用 `full`，无需迁移或删除现有配置。切换工具模式不会启用 Subagent，`DEVSPACE_SUBAGENTS=0` 仍保持不变。

工具模式会改变 MCP 暴露的工具定义。DevSpace 重启后，ChatGPT 网页端需要刷新插件工具；若当前界面没有刷新入口，应删除并重新创建同一 MCP URL 的插件连接。Owner Password、`auth.json` 和 OAuth SQLite 状态不需要删除。
