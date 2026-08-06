# DevSpace Portable 1.1.2

## Codex 风格运行时展示

- `exec_command`、`write_stdin` 和 `process_attach` 在 Codex 模式下挂载固定 Workspace App；
- 工具输入到达时先显示命令、参数和工作目录，完成后更新状态、PID、进程句柄、耗时、权限规则和输出；
- `apply_patch` 在执行前显示待应用的 Codex patch，完成后继续使用原有逐文件差异视图；
- 命令、argv、环境覆盖和卡片元数据在显示前执行递归脱敏；
- 不向卡片返回 `write_stdin` 的具体输入字符，只返回写入字符数和终端尺寸变化。

## 产物预览

- `apply_patch` 和 `show_changes` 自动识别本轮新增或修改的 PNG、JPEG、WebP、GIF、SVG、PDF、HTML、Markdown、文本、CSV 和 JSON；
- 单个不超过 2 MiB、总计不超过 6 MiB、最多 4 张的小型图片可直接嵌入卡片；
- PNG、JPEG、WebP 和 GIF 同时作为标准 MCP image content block 返回，支持宿主直接在对话中显示；
- PDF、HTML 和其他文本产物只显示类型、路径和大小，不在卡片内执行不可信 HTML；
- 所有预览路径仍经过工作区路径校验，删除文件和路径逃逸不会被读取。
- 现有 `show_changes` 卡片同时汇总本轮命令、进程和修改操作；旧 App 即使没有加载命令工具的新 UI 描述符，也能在最终差异卡中查看操作时间线。

## 兼容性

- 不新增顶层 MCP 工具，沿用 `exec_command`、`apply_patch`、`show_changes` 等固定工具名；
- 插件热插拔继续使用 1.1.1 的 `plugin_query`、`plugin_action` 和兼容 CLI；
- 1.1.2 首次部署后需要让 ChatGPT 重新读取一次核心工具描述符，之后普通插件更新仍不需要刷新 App；
- `widgets=changes` 在 Codex 模式下自动扩展为命令和编辑卡片，不改变 full/minimal 模式的既有行为。
