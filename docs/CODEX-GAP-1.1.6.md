# DevSpace 1.1.6 与本机 Codex 0.146.0 能力对照

| 能力 | Codex 桌面/CLI | DevSpace 1.1.5 | 1.1.6 处理 |
|---|---|---|---|
| 本机任意命令、SSH、凭据接口 | 可用，默认受沙箱/审批约束 | full-access 可用 | 保持；仍受 Windows/远端权限约束 |
| 持久进程和重连 | app-server/thread/process | processHandle/SQLite | DevSpace 已具备 |
| Shell Snapshot | stable | 无固定入口 | 新增脱敏快照 |
| 工作区回滚 | thread rollback/checkpoints | 只有 show_changes 基线 | 新增隐藏 Git 检查点和安全恢复 |
| 插件依赖 | Skill/MCP/workspace dependencies | manifest 不校验依赖 | 新增 ready/degraded/blocked 契约 |
| 本地 Skill 发现 | Codex 插件/Skill 搜索 | DevSpace Skill 根 | 桥接安全的本地 Codex Skill 根 |
| 防休眠 | 客户端长任务管理 | 无 | 新增 Windows keep-awake |
| PATH/安装 provenance | doctor 检查 | Portable PATH 会污染 Codex npm | Codex 子进程改用宿主 PATH |
| Browser/Computer Use | 宿主原生 | 不属于执行桥 | 不复制，继续使用宿主能力 |
| 文档/PDF/表格/演示 | 插件 Skills | DevSpace 可加载 Skills | 桥接本机已安装 Skills |
| 原生审批弹窗/Guardian | 宿主原生 | 无法在 MCP iframe 复制 | 继续使用规则、固定插件和本地 UI |
| Memories/Multi-agent | stable | 默认关闭 | 不默认导入，避免隐私和额度副作用 |
| App-server/Remote Control | Codex 客户端协议 | DevSpace 有独立公网 MCP/OAuth | 不复制 OpenAI 内部控制面 |

## 本机 Codex 已安装插件

- documents、pdf、spreadsheets、presentations、template-creator；
- sites、browser、chrome、computer-use、visualize；
- Slack、GitHub。

1.1.6 只桥接不依赖 Codex 宿主控制面的本地 Skills：documents、pdf、spreadsheets、presentations、template-creator、sites、visualize 和 GitHub。Browser、Chrome、Computer Use 与 Slack 不自动导入。
