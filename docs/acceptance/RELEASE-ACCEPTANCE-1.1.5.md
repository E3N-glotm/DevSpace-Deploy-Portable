# DevSpace Portable 1.1.5 发布验收

## 结论

1.1.5 修正了 1.1.4 对“Codex 风格日志”的过度表述，并完成可由 MCP 服务端实际控制的优化：工具调用状态文本、数据工具与渲染工具分离、最终 `show_changes` 聚合时间线，以及减少无意义工具调用的服务端指导。

ChatGPT 右侧“活动”面板属于宿主原生界面。MCP 调用的参数 JSON、空输入 `{}`、宿主生成标题、图标和折叠方式不在 DevSpace iframe 或服务器控制范围内，因此本版明确不把这些项目列为已解决。

## 版本

- DevSpace Server：`1.1.5`
- Portable Protocol：`1.4`
- 顶层工具名称变化：`0`
- 顶层工具输入/输出 Schema 变化：`0`
- Workspace App URI：`ui://devspace/workspace-app.html`

## 已验收功能

### 渲染工具分离

在 `DEVSPACE_WIDGETS=changes` 下：

- `runtime`：无 UI 模板；
- `edit`：无 UI 模板；
- `workspace`：无 UI 模板；
- `show_changes`：唯一绑定 Workspace App 的渲染工具；
- `show_changes` 同时声明 `_meta.ui.resourceUri` 和 `_meta["openai/outputTemplate"]`。

### 工具状态文本

核心工具和插件工具均包含：

- `_meta["openai/toolInvocation/invoking"]`；
- `_meta["openai/toolInvocation/invoked"]`。

状态按工作区、命令、读取、修改、搜索、目录、差异和插件操作分类，不再统一显示模糊的通用文案。

### 紧凑调用指导

服务端初始化指令明确要求：

- 不得仅为展示 UI 调用 `capabilities`；
- 不得仅为展示 UI 调用 `doctor`；
- 不得无必要调用 `session_list` 或 `session_resume`；
- 已知结果后不得追加无操作诊断；
- 实际修改后只调用一次 `show_changes`。

### Workspace App

- 折叠命令日志保留；
- 操作时间线保留；
- 文件创建、修改、删除和移动记录保留；
- 图片和文件产物预览保留；
- 命令、参数、环境变量和输出脱敏保留；
- 资源继续使用 `no-store`；
- 组件资源增加边框偏好与描述。

## 自动化测试

### `setup/test-runtime-cards.mjs`

```json
{
  "previewFiles": 1,
  "artifacts": 2,
  "imageBlocks": 1,
  "argvRedacted": true,
  "runtimeResponseRedacted": true,
  "operationTimeline": true,
  "runtimeAssets": true,
  "decoupledRenderTool": true,
  "invocationStatusMetadata": true
}
```

### `setup/test-runtime-log-ui.mjs`

```json
{
  "compactRuntimeLog": true,
  "operationTimeline": true,
  "fileTimeline": true,
  "redaction": true
}
```

### `setup/test-plugin-manager.mjs`

```json
{
  "pluginInstall": true,
  "pluginEnableDisable": true,
  "reservedSlots": 16,
  "safeSlotSchema": true,
  "versionHashPin": true,
  "failClosed": true,
  "portableManagerInterface": true,
  "uninstall": true
}
```

### 生产依赖审计

- `npm audit --omit=dev --json`：退出码 `0`；
- 已知生产依赖漏洞：`0`。

## 无法由 DevSpace 验收或保证的宿主行为

- 活动面板是否显示 `{}`；
- 活动面板是否展示完整、部分或脱敏后的工具参数；
- 活动面板调用标题是否采用工具元数据、模型生成文案或宿主本地化文案；
- 工具描述符状态文本何时被已有 App 快照重新读取；
- ChatGPT 后续版本对 MCP 调用行的视觉样式。

## 升级要求

- 工具调用本身不要求删除或重装 App；
- 服务端文件替换后需要重启本机 DevSpace；
- 固定 Workspace App 静态资源可在下一次 `show_changes` 时重新读取；
- 新的调用状态文本属于工具描述符元数据，若当前 App 快照仍使用旧元数据，只能等待宿主重取描述符或执行一次 App 刷新；这不影响工具功能。
