# DevSpace Portable 1.0.9

## 新增功能

- `file_watch_start`、`file_watch_poll`、`file_watch_stop`、`file_watch_list`：监听工作区文件与目录变化。
- `event_poll`：使用单调递增 `sequence` 游标读取进程、文件、Watch 和权限事件。
- `audit_log_list`：读取存储在 SQLite 中的结构化工具调用记录。
- `permission_rules_list`、`permission_rules_reload`、`permission_rules_test`：管理并验证确定性的 `allow`、`deny`、`audit` 命令规则。
- `doctor_history`：查看历史诊断结果和自动生成的修复建议。
- 日志与事件写入前递归脱敏，包括密码、Token、Authorization、Cookie、API Key、Credential 和常见 URL 查询参数。

## 权限规则文件

默认路径：

```text
data/config/permission-rules.json
```

参考模板：

```text
setup/permission-rules.example.json
```

未配置规则文件时默认 `allow`，保持旧版本行为。`audit` 只记录，不中断执行；`deny` 返回明确规则 ID 并拒绝执行。

## 数据迁移

SQLite migration 6 新增：

- `event_journal`
- `structured_tool_calls`
- `diagnostic_runs`
- `diagnostic_checks`
- `file_watches`

OAuth 表和既有凭据不变。

## 边界

- Watch 注册会持久化，但 Node `fs.watch` 句柄不会跨 DevSpace 服务重启自动恢复；重启后记录显示为未附着，需要重新启动 Watch。
- 本版没有新增输出字节上限或专用输出截断功能。
