# DevSpace Portable 1.1.0

## 插件目录

本地插件安装目录：

```text
data/plugins/installed/<plugin-id>/<version>/manifest.json
```

示例插件位于 `setup/plugin-example`。复制后的示例结构应为：

```text
data/plugins/installed/devspace-example/1.0.0/manifest.json
data/plugins/installed/devspace-example/1.0.0/skills/devspace-plugin-example/SKILL.md
```

## 新增 MCP 工具

- `plugin_list`
- `plugin_read`
- `plugin_refresh`
- `plugin_enable`
- `plugin_disable`
- `capabilities`
- `schema_generate`

启用插件的工具按 `plugin_<plugin-id>_<tool-name>` 动态注册，非字母数字字符转换为下划线。

## 版本缓存与 Skill 根

SQLite migration 7 新增 `plugin_versions` 和 `plugin_state`。每个版本缓存 manifest、SHA-256、成熟度、实际路径和最后发现时间；启用状态与选中版本独立保存。

启用插件后，其 `skillRoots` 合并进 DevSpace Skill 搜索路径。新打开或恢复的工作区会加载这些 Skill。禁用或切换版本后，旧会话中的旧动态工具会拒绝执行。

## 动态工具执行边界

- manifest 中的 `argv` 与 `command` 必须二选一。
- `${parameter}` 或 `{{parameter}}` 用于模板替换。
- 内置变量包括 `workspaceRoot`、`pluginDir`、`pluginId`、`pluginVersion` 和 `cwd`。
- 插件命令仍经过工作区解析、权限规则、进程注册表、结构化审计和日志脱敏。
- 插件启停、版本切换或缓存刷新后，需要建立新的 MCP 会话刷新工具清单。

## 协议与 Schema

- MCP server version：`1.1.0`
- Portable protocol version：`1.1`
- `capabilities` 返回 `stable`、`experimental`、`deprecated` 功能成熟度。
- `schema_generate` 在指定工作区写出插件 manifest、权限规则和动态工具的 JSON Schema bundle。

本版没有新增输出字节上限或专用输出截断标志功能。
