# DevSpace Portable 1.1.68 dev14 — Agent Runtime

新增长期任务运行时、模型组和 Agent 工作台；旧 Worker 接口保持兼容。模型组保存已配置模型 ID，可以使用不同上下文的配置。单组任务使用独立的 Agent 上下文，按轮次调度；同一 HTTP 后端的请求保守地串行排队。

新增 MCP `agent_task_start`、`agent_task_list`、`agent_task_status`、`agent_task_events`、`agent_task_pause`、`agent_task_resume` 和 `agent_task_cancel`。省略 modelId 与 groupId 时使用默认组；显式 modelId 运行单 Agent。旧 `model_delegate_task` 不变。

任务与事件使用 SQLite 持久化。明确授权 Shell、文件修改、Computer Use、插件、记忆写入；通过原 MCP 工具处理器执行并沿用权限检查。Computer Use 支持原有 50 Step 序列，视觉输入需要显式开启模型视觉能力。工作区记忆自动检索；上下文压缩基于持久化事件提取检查点，保留目标和完整工具调用事务。独立审查通过后可写入工作区记忆；单 Agent 提交结果后等待人工验收。

重启恢复保留已完成工作，未确认的工具副作用不自动重放。工作台可查看任务、成员、消息、实际提供商返回的 reasoning 内容、工具参数/结果、审查和 Token 用量。兼容 SSE 的提供商实时返回生成增量；普通 JSON 响应则在该步结束时显示。模型配置变更或禁用后任务安全暂停。没有持续桌面监控，也不依赖 ChatGPT 自动续轮。

限制：每组采用轮转式调度而非同时执行所有成员；同源模型共用保守单槽，尚不从后端自动探测 KV 池。上下文 Token 是保守估算，提供商实际 Token 使用量另行统计。真实模型功能与思考参数支持依赖各 API，原生 DeepSeek 默认无思考工具模式；非 DeepSeek 的 OpenAI reasoning 参数必须显式适配。
