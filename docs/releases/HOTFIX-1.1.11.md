# DevSpace Portable 1.1.11

1.1.11 修复 1.1.10 中影响磁盘安全、首次部署、启停和 RDP Computer Use 的高优先级问题，Portable Protocol 继续保持 1.5，顶层 MCP 工具 Schema 不变。

## P0：有界稀疏会话审阅

- 删除对整个工作区执行 `git add -A -f` 的 shadow Git 快照路径。
- 只保存结构化修改明确声明路径的修改前镜像。
- 内容以 gzip 压缩并按 SHA-256 去重。
- 单文件保存上限 4 MiB；单会话 32 MiB；全部 review 状态 512 MiB；最多保留 30 个会话目录。
- 任意 Shell 未声明路径时不扫描工作区，只明确标记回退覆盖范围为 `tracked-paths-only`。
- 启动时异步隔离并删除旧 `review-sessions-v3` 和 `review-repositories-v3`。

## 部署与启停

- 首次部署改为“安装任务后直接启动”，删除重复 restart。
- 启动前校验真实 HTTPS 根地址、Owner Password 和当前隧道提供商 Token。
- MCP 与隧道分别最多重试三次，以本地和公网 OAuth metadata 实际可达为成功条件。
- 部分启动会自动清理后重建；最终失败自动回滚为全停状态。
- 停止前临时禁用任务，避免计划任务 RestartOnFailure 与清理过程竞争。
- 停止等待窗口扩展为 20 秒，并清理 PID 文件、Broker 请求和 Portable 所属进程。
- “停止并禁用”先阻断任务再停止，保持禁用；重复调用是幂等操作。

## Computer Use

- 原生 WinForms UI 直接消费 Computer Use 本地队列并在交互桌面截图。
- RDP 会话不再依赖隐藏 Node 进程访问桌面捕获表面。
- 原生输入 Helper 和旧 Broker 保留为兼容回退。
- 截图会验证画面非空后才返回 PNG。

## 版本与 Codex Runtime Bridge

- `capabilities.serverVersion` 修正为 1.1.11。
- Codex 子进程固定使用可交互 TERM 元数据和宿主 npm prefix。
- Doctor 的真实失败与外部历史数据 advisory 分开返回；`failingChecks` 不再混入 warning。
