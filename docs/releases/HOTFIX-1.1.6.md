# DevSpace Portable 1.1.6

## 目标

1.1.6 对照本机 Codex CLI 0.146.0，补齐适合远程 MCP 执行桥的运行时能力，同时保持顶层 MCP 工具 Schema 不变。新增能力统一通过现有 `plugin_query` / `plugin_action` 热调度，不要求刷新 ChatGPT App。

## 新增能力

- 插件 manifest 可声明平台、必需/可选可执行文件、环境变量和文件依赖；插件状态分为 `ready`、`degraded` 和 `blocked`，必需依赖缺失时在启动进程前拒绝执行。
- Portable UI 显示插件依赖状态及缺失项。
- 新增内置 `codex-runtime-bridge` 插件：
  - 本机 Codex 版本、稳定功能、已安装插件和 doctor 异常清单；
  - 脱敏 Shell/环境/PATH/可执行文件/Git 快照；
  - Git 工作区隐藏检查点、列表和精确确认恢复；恢复前自动创建安全检查点，不移动 HEAD；
  - Windows 长任务防休眠的启动、状态和停止；
  - 桥接本机存在的 documents、pdf、spreadsheets、presentations、template-creator、sites、visualize 和 GitHub Skills。
- 启动器保存宿主 PATH；直接运行 Codex 时自动使用宿主 PATH，避免 Portable Node/npm 让 Codex 更新到错误安装目录。普通 DevSpace、Git、SSH 和 Python 命令继续使用 Portable 可重复环境。
- Portable 配置、启动或插件刷新时自动种子安装内置插件；已存在的同 ID/版本不会被覆盖。

## 权限边界

DevSpace `full-access` 比 Codex 默认 `OnRequest + restricted sandbox` 更开放，但不等于具备 Codex 的原生审批 UI。MCP 服务端无法在 ChatGPT 内复制 Codex 桌面端的 Guardian/审批弹窗。DevSpace 继续使用权限档位、确定性 allow/deny/audit 规则、固定插件工具和本地 UI 管理来缩小风险面。

以下能力不复制进 DevSpace 核心：

- Browser、Chrome、Computer Use、Image Generation：由 ChatGPT/Codex 宿主提供；
- ChatGPT/Codex 模型路由、额度、云任务和远程压缩；
- Codex Memories 和 Multi-agent：DevSpace 是执行桥，不默认保存对话记忆，也保持 `DEVSPACE_SUBAGENTS=0`；
- Slack 等连接器：继续由 ChatGPT Apps 或独立受限插件提供。

## 兼容性

- 顶层 MCP 工具名和输入 Schema 不变；不需要刷新 ChatGPT App。
- `codex-runtime-bridge` 通过稳定调度器调用。
- 当前已安装的旧插件版本保留；1.1.6 内置桥接插件为 1.1.0。全新安装默认选择最高版本，已明确选择旧版本的部署不会被强制切换，可在本机插件 UI 中选择 1.1.0。
