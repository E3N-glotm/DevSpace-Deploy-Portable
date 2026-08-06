# DevSpace Portable 1.0.7

## 本版目标

将 DevSpace 从临时命令桥接器升级为具备稳定进程身份和可诊断运行时的执行器。

## 新增功能

- `doctor`：输出结构化、默认脱敏的运行时诊断报告。
- 稳定 `processHandle`：允许为 SSH、训练和推理任务设置长期可识别名称。
- `process_list`：查询当前和历史进程注册记录。
- `process_attach`：MCP 重连后按稳定句柄重新接入仍由当前 DevSpace 实例管理的进程。
- `process_kill`：按稳定句柄终止进程。
- `exec_command` 新增结构化 `argv` 与 `env`，同时保留原 `cmd` 字符串入口。
- 进程状态写入 `data/state/devspace.sqlite` 的 `process_registry` 表。
- 启动日志记录 Portable 根目录、Node、Git、SSH 和 PATH 选择结果。

## 兼容性

- 原 `sessionId` 和 `write_stdin` 调用方式继续保留。
- 原 `cmd` 字符串命令继续保留。
- `workspace`、`custom` 和 `full-access` 权限档位保持不变。
- 未加入新的输出字节上限、输出游标上限或专用截断标志功能。

## 数据迁移

首次启动会自动执行 SQLite migration 4，创建 `process_registry`。原 OAuth、工作区和本地 Agent 表不变。
