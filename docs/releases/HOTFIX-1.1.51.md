# DevSpace Portable 1.1.51

1.1.51 是对 1.1.50 continuation 与 MCP transport 的根因级收口。现场审计发现，部分 1.1.50 安装仍运行旧的同版本文件和数据库迁移，因此“源码测试已通过”不能等价为“live 已生效”；同时真实 ChatGPT 连接会在短时间创建大量 MCP session，旧 registry 对这种 churn 缺少在途请求保护。

## Continuation Task Contract 单例与自愈

- `conversation_scope_id` 是 Task Contract 的持久身份；workspace 只表示当前执行上下文。
- migration 25 使用 SQLite partial unique index 保证一个真实 `v1/*` conversation 最多一个 active Task Contract。
- migration 26 会再次执行 singleton reconciliation，用于修复同版本热修复、中断升级或旧 runtime 与新文件交错启动留下的重复记录。
- 历史记录若明确 `source_tool='continuation_anchor'`，但 `last_anchor_mounted_at` 因旧实现缺陷为空，migration 26 会修复 mount 元数据，而不是要求 ChatGPT 再生成一张重复卡片。
- 控制中心只自动回收 24 小时以上、没有 anchor、没有 evidence/checkpoint、没有 watch、没有 continuation、没有 owner lock、`substantive_activity_count=0` 的 provisional fallback。真正执行过工作的任务不会被当作垃圾清理。

## 未完成里程碑与自动续轮

1.1.51 明确区分“触发事件”和“授权证据”。普通 resource teardown、普通 process completion、模型静默都不是 Host cutoff 证据，默认 fail-closed。

completion-driven 自动恢复仅允许以下路径：

1. Host 明确报告 `timeout/deadline/budget`；或
2. 已由真实观测确认 Host cutoff，并且当前 turn 已超过 cutoff + recovery grace、模型已经满足 quiet window、Task Contract 仍有未完成 required milestones；或
3. completion-driven stall 已经由独立证据推进到持久 `CONTINUATION_ARMED`；或
4. `resident` 模式下用户明确授权的 stage/process wake。

因此，普通 UI iframe 重建不会误制造新轮，而真正被 Host 截断、且任务未完成时仍有持久恢复路径。`finalResponseAllowed=false` 仍要求当前模型继续实际工具工作，不能以 ACK/进度说明代替里程碑完成。

## 用户手动消息与自动续轮竞态

Apps SDK 没有可靠的通用“用户刚发送聊天消息”事件，因此 1.1.51 不在前端猜测用户输入，而把竞争控制下沉到 SQLite 状态机：

- 每次逻辑 synthetic continuation 分配持久 `deliveryGeneration` 和 UUID `deliveryToken`。
- 自动恢复的新模型轮第一条 `continuation_task status` 必须携带对应 token。
- 如果此时一个没有 synthetic token 的真实模型轮先访问 DevSpace，视为用户/人工轮接管；服务端清空旧 pending delivery、推进 generation，并把旧 token 标记为 superseded。
- 迟到的旧 synthetic turn 再访问时收到 `synthetic-continuation-superseded`，必须停止且不得重放副作用。
- transport readiness retransmission 复用同一个 token/generation，不会被计算为第二次逻辑 continuation。

## MCP 高频断连与 session churn

现场日志没有显示 owned ngrok tunnel 持续重连或 TLS/5xx 风暴，但 `openai-mcp/1.0.0` 会在短时间创建大量 MCP session。旧 registry 的固定 32-session LRU 没有在途引用保护，可能在 connector churn 时过早关闭仍在服务请求或刚被 Workspace App 使用的 session。

1.1.51 改为：

- steady-state soft cap 32；
- reconnect-storm hard cap 96；
- 新/近期 session 默认保留 2 分钟 reconnect grace；
- `acquire/release` 在途引用计数，任何 `inFlight > 0` 的 session 禁止被 idle/容量淘汰；
- 请求结束后异步重新 trim；
- 新增 `mcp_session_missing` 结构化诊断，区分“客户端请求了已不存在 session”与 tunnel/TLS/本地服务真实故障。

这不是把容量粗暴调大，而是在有界资源前提下避免连接重建风暴扩大成软件侧断线。

## 保留的既有修复

- Workspace App early `toolresult` 缓存/重放，避免永久 `Waiting for a tool result`。
- versioned Workspace App resource URI 和 inline coordinator，避免同版本 stale iframe 缓存旧逻辑。
- 默认 headless 普通工具 + `show_changes` 聚合 operation card + 单一 continuation anchor/card。
- Owner 批量 pause/resume/lock/unlock/stop/delete。
- transport 不确定结果下先查 durable state，再决定是否重放有副作用操作。

Protocol 保持 1.5；Linux Remote Agent wire protocol 与权限模型没有变化。
