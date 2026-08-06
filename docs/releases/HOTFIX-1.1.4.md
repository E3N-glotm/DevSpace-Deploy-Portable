# DevSpace Portable 1.1.4

1.1.4 将 1.1.2/1.1.3 的运行时卡片进一步收敛为接近 Codex 客户端的折叠操作日志，同时保持现有顶层 MCP 工具名称和输入 Schema 不变。

## 运行日志

- `exec_command`、`write_stdin`、`process_attach` 和 `process_kill` 使用紧凑折叠行；
- 运行中显示“正在运行”，成功显示“已在 N ms/s 内运行”，失败和取消显示对应状态；
- 成功命令默认收起，运行中和失败命令默认展开；
- 展开后显示命令、工作目录、PID、sessionId、processHandle、PTY、权限规则、耗时和脱敏输出；
- `apply_patch` 在执行前展示计划补丁，完成后沿用逐文件差异卡。

## 最终操作时间线

`show_changes` 会在最终差异卡中展示：

- 本轮命令及耗时、退出码；
- 可展开的工作目录、进程和权限信息；
- 逐文件“已创建 / 已修改 / 已删除 / 已移动”；
- 每个文件的 `+additions -removals`；
- 原有图片预览和 PDF/HTML/文本产物卡。

## 无需刷新网页 MCP App

本版不新增任何顶层 MCP 工具，也不改变工具输入 Schema。Workspace App 仍使用固定 URI：

```text
ui://devspace/workspace-app.html
```

运行时 JS/CSS 资源增加 `Cache-Control: no-store`。覆盖程序文件并重启 DevSpace 后，下一次工具调用会读取新 UI；不需要移除、重装或刷新 ChatGPT App 工具定义。

ChatGPT 宿主最外层的原生工具行样式不属于 MCP 服务端控制范围。本版实现的是固定 Workspace App 内的等价日志体验。
