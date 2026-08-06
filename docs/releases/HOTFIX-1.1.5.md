# DevSpace Portable 1.1.5

## 修正目标

1.1.4 将 Workspace App 内的折叠操作时间线描述得过于接近 Codex 原生活动日志。实际运行中，ChatGPT 右侧“活动”面板仍会为每次 MCP 调用展示宿主生成的参数 JSON；无输入工具显示 `{}`，命令或补丁参数也可能因宿主安全策略被折叠成 `{}`。

这些原生活动条目位于 ChatGPT 宿主页面，不在 DevSpace iframe 内。MCP 服务端不能访问父页面 DOM，也没有工具元数据字段可以隐藏调用参数块。因此 1.1.5 不再宣称能够替换或逐像素复刻 Codex 原生活动面板。

## 已完成修正

- `DEVSPACE_WIDGETS=changes` 时，仅 `show_changes` 绑定 Workspace App；
- `open_workspace`、读取、搜索、目录、命令和文件修改工具保持无 iframe 的数据工具；
- `show_changes` 作为唯一渲染工具，集中显示操作时间线、文件差异和产物预览；
- 工具描述符增加 `_meta["openai/toolInvocation/invoking"]` 与 `_meta["openai/toolInvocation/invoked"]`；
- `show_changes` 同时声明标准 `_meta.ui.resourceUri` 与 ChatGPT 兼容字段 `_meta["openai/outputTemplate"]`；
- Workspace App 资源增加边框偏好和组件说明；
- 服务端指令要求模型减少无意义调用，不得仅为展示 UI 调用 `capabilities`、`doctor`、`session_list`、`session_resume` 或空操作；
- 1.1.4 能力名 `native-style-collapsible-runtime-log` 更正为 `workspace-app-collapsible-runtime-log`。

## 仍无法由 DevSpace 控制的内容

- ChatGPT “活动”面板是否显示参数 JSON；
- 空输入工具是否显示 `{}`；
- 宿主对命令、补丁或敏感参数的折叠与脱敏方式；
- 宿主生成的工具调用标题、图标、连线、滚动位置和折叠行为；
- 已保存 App 工具描述符元数据何时刷新。

## 升级影响

- 顶层 MCP 工具名称和输入/输出 Schema 不变；
- Portable Protocol 保持 `1.4`；
- 不需要为了继续调用工具而删除或重新安装 App；
- 固定 Workspace App 资源仍使用 `ui://devspace/workspace-app.html`；
- 新的工具调用状态文本属于工具描述符元数据，旧 App 快照是否立即采用由 ChatGPT 决定；
- 静态 UI 与最终 `show_changes` 卡仍可在服务重启后通过固定资源 URI 获取更新。

## 验收重点

- `changes` 模式下 `runtime` 和 `edit` 工具不含 UI 模板；
- `show_changes` 同时含标准 UI URI 与 OpenAI 兼容 URI；
- 所有核心工具包含调用中和调用完成状态文本；
- 运行卡、差异、图片预览和脱敏回归测试继续通过；
- 文档不再把 Workspace App 卡片称为 ChatGPT/Codex 原生日志。
