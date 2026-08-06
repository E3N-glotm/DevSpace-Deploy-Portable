# DevSpace Portable 1.1.4 验收

## 功能验收

- [x] 命令输入到达后显示运行中折叠日志；
- [x] 成功命令显示人类可读耗时并默认收起；
- [x] 失败或运行中命令默认展开；
- [x] 命令、环境变量和输出继续执行敏感信息脱敏；
- [x] `show_changes` 同时展示命令操作与文件操作；
- [x] 文件记录包含创建、修改、删除、移动和增删行数；
- [x] 图片及其他产物预览保持兼容；
- [x] 顶层 MCP 工具集合和输入 Schema 未变化；
- [x] 静态 UI 资源使用 no-store，不要求网页端刷新工具状态。

## 自动化测试

```text
node --check runtime-enhancements.js
node setup/test-runtime-cards.mjs
node setup/test-runtime-log-ui.mjs
```

Edge Headless 测试模拟 `tool-input → tool-result → show_changes`，确认：

```text
compactRuntimeLog = true
operationTimeline = true
fileTimeline = true
redaction = true
```

## 安全边界

- 不把密码、Token 或交互式 stdin 内容写入日志卡；
- 不执行不可信 HTML 预览；
- 不更改插件槽位、权限档位或 OAuth 配置；
- 不尝试控制 ChatGPT 宿主原生 UI，仅更新 DevSpace Workspace App。
