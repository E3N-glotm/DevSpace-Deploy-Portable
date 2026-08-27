# DevSpace Portable 1.1.50

1.1.50 是一次以 continuation 可靠性为 P0 的修复。真实使用中确认了一个与 1.1.49 严格 cutoff 语义不同的问题：Task Contract 仍有未完成里程碑时，模型可能主动输出普通 final response。此时 Host 没有 timeout，Workspace App 也没有获得合法 continuation trigger，因此不会自动产生下一轮。1.1.50 将普通多步任务从“等待证明 Host 截断”改为“由 Task Contract 的显式完成状态驱动生命周期”。

## P0：completion-driven Task Contract

开启 continuationGuard 后，`open_workspace` 会按 ChatGPT conversation scope + workspace 创建或复用唯一 Task Contract，并自动挂载同一个 Workspace App recovery sender。自动 Contract 永远带有非空 fallback milestones，模型随后给出具体任务目标时会细化同一个 task，而不是创建 0/0 guard 或 shadow task。

普通多步任务的默认模式变为 `completion-driven`。只要 required milestones 仍有未完成项：

- 模型侧真实 DevSpace 工具活动会续租 model Turn Lease；
- `status`、`checkpoint`、`resume` 和 task refinement 会保持当前 Turn Lease 有效；
- 如果模型提前结束且 iframe 仍存活，Turn Lease 到期后可 claim `task contract turn lease expired` 并恢复同一 task；
- 如果 Workspace App 收到 resource teardown 且 Task Contract 仍不完整，可立即 claim `task contract resource teardown`；
- 新 assistant turn 必须先 `status` ACK，必要时刷新同一个 Anchor Lease，然后继续 remaining milestones，而不是停在状态摘要。

这条机制只属于 `completion-driven`。1.1.49 的严格 `timeout-recovery` 仍然不会把普通静默、早期 teardown、learned budget 或普通进程结束当作 cutoff；`resident` 也仍然只在用户明确授权常驻/监控行为时允许 `watch-process` / `stage-complete` wake。

## 默认无总时限、无最大续轮

completion-driven Task Contract 的默认预算改为：

- `max_continuations = 0`：无限；
- `deadline_at = NULL`：无限 wall-clock；
- continuation count 仍记录真实续轮次数，但不会因为计数达到某个默认上限自动变成 `BUDGET_EXHAUSTED`；
- 只有显式传入正数 `maxContinuations` / `wallClockMinutes` 时才启用兼容预算。

因此正常任务生命周期由 milestones 决定，而不是由时间/次数决定。模型只有在全部 required milestones 已完成，且 completion evidence 已经通过 checkpoint/complete 验证后，才调用 `continuation_task action=complete` 显式关闭 Task Contract。Owner 的 pause/stop/delete 仍保留最终人工控制权。对 `completion-driven` 而言，no-progress / repeated-failure 计数只保留为诊断告警，不再把尚有未完成 milestones 的 Task Contract 自动置为 terminal；如果确实需要放弃任务，必须由用户/Owner 显式 stop/cancel，或由模型在真实终止条件下显式 terminal fail。

## finalResponseAllowed 与持久 checkpoint

Task Contract 对模型公开机器可读完成协议：

- `taskIncomplete`
- `remainingMilestones`
- `continueRequired`
- `nextRequiredMilestones`
- `finalResponseAllowed`

当 `finalResponseAllowed=false` 时，ACK、re-anchor、进度汇报、状态摘要或“下一轮继续”都不是任务完成。模型必须在同一 assistant turn 继续实际 DevSpace 操作，并使用 `checkpoint` 持久化已完成 milestones、progress fingerprint 与 evidence。续轮后无需重新猜测上一轮验证结果。

## Turn Lease 与 Anchor Lease

1.1.50 将两个不同的 lease 分开：

- **Turn Lease**：证明模型近期仍在推进 completion-driven Task Contract；普通 DevSpace 活动会续租。到期只对 completion-driven 生效。
- **Anchor Lease**：证明当前 Workspace App recovery sender 仍在。coordinator 的 status/heartbeat 会续租；lease 接近到期或 heartbeat stale 时，model-side 工具结果要求当前 assistant turn 用相同 `taskId/workspaceId` re-anchor。

re-anchor 是同轮 maintenance，不是一个新的 continuation trigger，也不会创建 shadow task。

## Host cutoff 与三种模式

三种 continuation mode 在 1.1.50 中职责如下：

1. `completion-driven`：普通多步任务默认值。目标是“所有 milestones 完成前持续同一个 Task Contract”。允许 Turn Lease expiry 和 incomplete resource teardown 恢复。
2. `timeout-recovery`：严格 cutoff-only。只接受 Host 明确 timeout/deadline/budget，或用户/Owner 明确观察过真实 Host cutoff 后通过 `confirm-turn-limit` 记录的保守恢复条件。
3. `resident`：只用于用户明确要求的常驻/监控任务；除 Host cutoff 外，还允许显式 stage/process wake。

learned Host budget 继续只用于 telemetry/参考，不作为 proactive timer。普通进程完成不会自动唤醒 completion-driven/timeout-recovery；只有 resident 的显式 watch 才能产生 process wake。

## MCP / 网络波动

Workspace App 对 continuation 控制面的瞬时 transport error 增加有界退避。识别 `UNAVAILABLE`、`Connection failed`、fetch/network、`ECONN*`、TLS/SSL/handshake 和 timeout 类错误后，按短退避窗口重试同一控制操作，而不是立即放弃 Task Contract。

对于可能已经产生副作用的命令或文件修改，恢复连接后应先检查 durable process/file/task state，再决定是否重放，以避免“服务端已执行但客户端只丢了响应”造成重复操作。

1.1.49 的 tunnel 非破坏性恢复门保持不变：公网 curl/DNS/TLS 失败自身不能杀健康 ngrok；只有当前 supervisor 自己拥有的 Agent API 可达并连续确认预期 tunnel 缺失时，才允许重启 owned ngrok child。

## 控制中心与可观测性

续轮页继续支持批量暂停、恢复、锁定、解锁、结束、删除，并新增/强化显示：

- Task Contract 来源（自动契约、模型细化、显式任务、历史任务）；
- Conversation scope 与 workspace；
- completion mode；
- milestone 完成度；
- continuation count，默认上限显示为 `∞`；
- Turn Lease / Anchor Lease；
- 总 wall-clock，默认显示“无限”。

旧版 `legacy-auto` 空 guard 仍可做孤儿回收；新的 completion-driven Task Contract 不会因为 24 小时无活动而被自动回收，因为其总任务生命周期默认明确为无限。

## 数据库迁移

1.1.50 增加 migration 21/22：

- migration 21：Task Contract 来源、contract version、自动创建标记、substantive activity、Turn Lease ID、Anchor mount/expiry 等字段；
- migration 22：`turn_lease_expires_at`，并将当前 1.1.50 自动/模型细化 Contract 迁移为 `completion-driven`、`max_continuations=0`、`deadline_at=NULL`；同时识别 1.1.49 中已经存在、具有非空 milestones 的 legacy `timeout-recovery` 活跃任务，将其标记为 `migrated-1.1.49`、切换到 completion-driven、清除旧预算并初始化 3 分钟 Turn Lease，使升级后当前任务本身也获得 P0 修复，而不是只对新会话生效。

## 验证原则

本版本回归覆盖：conversation isolation、非空自动 milestones、fallback refinement、checkpoint evidence、`finalResponseAllowed=false`、Turn Lease renew/expiry、resource teardown recovery、1.1.49 legacy active-task migration、completion-driven no-progress 非终止语义、timeout-recovery silence fail-closed、resident process/stage wake、Owner pause/lock、无限默认预算、显式正数兼容预算、Anchor re-mount、Connection failed/TLS retry，以及原有 tunnel/network 非破坏性恢复路径。

Protocol 保持 **1.5**。Linux Remote Agent wire protocol、scoped/full-access 权限模型和上游核心基线保持不变。
