# DevSpace Portable 1.0.8

## 新增功能

- 工作区会话继续存储在 `data/state/devspace.sqlite`，并增加标题、Git HEAD、Git 分支、Git origin 和归档时间。
- `session_list`：把工作区会话分成 active 与 history。
- `session_resume`：按原 workspace/session ID 恢复工作区，并重新读取项目指令、Skill、Agent 配置和当前 Git 元数据。
- `session_archive`：归档会话但不删除项目文件或 Git worktree。
- MCP 连接断开后，仍由当前 DevSpace 实例管理的进程可通过 `process_attach` 继续接入。
- DevSpace 服务重启后，SQLite 中仍标记为运行的 PID 会被重新核查：存活时标记为 `detached-running`，不存在时标记为 `lost`。
- 显式命名且使用非 PTY 管道的持久进程在正常 DevSpace 关闭时会尝试脱离父进程，以便新实例识别。
- 重启后识别到的进程可通过 `process_list` 查询，并可通过 `process_kill` 终止。

## 边界说明

操作系统不支持把新进程重新绑定到旧进程已经丢失的匿名 stdin/stdout 管道或 ConPTY。因此：

- MCP 仅重连、DevSpace 进程未重启：可完整重新接管输入输出。
- DevSpace 服务进程已重启：可识别 PID、查看元数据和终止，但 `reattachable=false`，不能恢复已丢失的终端流。
- PTY 进程在正常关闭时不承诺脱离存活；非 PTY 显式持久进程是主要恢复对象。

## 数据迁移

SQLite migration 5 为 `workspace_sessions` 增加元数据列，不修改 OAuth 表。
