# DevSpace Portable 1.1.50

1.1.50 是一次以 continuation 可靠性为 P0 的修复。真实使用中确认了一个与 1.1.49 严格 cutoff 语义不同的问题：Task Contract 仍有未完成里程碑时，模型可能主动输出普通 final response。此时 Host 没有 timeout，Workspace App 也没有获得合法 continuation trigger，因此不会自动产生下一轮。1.1.50 将普通多步任务从“等待证明 Host 截断”改为“由 Task Contract 的显式完成状态驱动生命周期”。

## P0：completion-driven Task Contract

开启 continuationGuard 后，`open_workspace` 会按 ChatGPT conversation scope + workspace 创建或复用唯一 Task Contract。默认 `widgets=changes` 模式下 `open_workspace` 本身保持 headless；需要续轮保护的普通多步工作随后只调用一次 `continuation_anchor` 挂载 Workspace App recovery sender。自动 Contract 永远带有非空 fallback milestones，模型随后给出具体任务目标时会细化同一个 task，而不是创建 0/0 guard 或 shadow task。

这项拆分同时修复会话中重复 continuation 卡片的问题。ChatGPT 对每一次带 Workspace App output template 的 MCP tool invocation 都会创建独立会话卡片，它不会因为两个调用返回了同一个 task ID 就把后一个结果更新到前一张卡片。旧实现让 `workspace` 类工具和 `continuation_anchor` 都携带相同 App，因此 workspace 重连、重开或恢复时会产生多张展示同一 Task Contract 的卡片，甚至可能留下旧的 `Waiting for a tool result.` 壳。现在默认模式中只有 `continuation_anchor` 是 recovery UI 入口；已有 sender 保持心跳时不重复挂载，只有返回 `reanchorRequired=true`、确认原 sender 已失活时才创建替代 anchor。`widgets=full` 仍保留显式的逐工具 UI 兼容行为。历史会话里已经生成的旧卡片无法由服务端追溯删除，但新版本不会再因普通 workspace 调用持续堆叠它们。

普通多步任务的默认模式变为 `completion-driven`。只要 required milestones 仍有未完成项：

- 模型侧真实 DevSpace 工具活动会续租 model Turn Lease；
- `status`、`checkpoint`、`resume` 和 task refinement 会保持当前 Turn Lease 有效；
- Turn Lease 只是“近期是否看到模型侧 DevSpace 活动”的弱 liveness 信号，不是 ChatGPT turn deadline。Lease 到期只把持久任务从 `ACTIVE` 推进到 `SUSPECTED_STALL`，**绝不能单独 claim continuation 或创建新 assistant turn**；
- 只有第二个独立 Host/lifecycle 证据成立后，任务才进入 `CONTINUATION_ARMED`，例如明确 Host timeout/teardown，或此前经真实观测确认的 adaptive cutoff 已经过期且满足 quiet/grace gate；
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

- **Turn Lease**：只表示“最近一次模型侧 DevSpace 活动仍在 lease 内”。普通 DevSpace 活动会续租；到期只产生 `SUSPECTED_STALL`，它既不是 Host 剩余时间，也不能单独发送新轮。
- **Anchor Lease**：证明当前 Workspace App recovery sender 仍在。coordinator 的 status/heartbeat 会续租；lease 接近到期或 heartbeat stale 时，model-side 工具结果要求当前 assistant turn 用相同 `taskId/workspaceId` re-anchor。

re-anchor 是同轮 maintenance，不是一个新的 continuation trigger，也不会创建 shadow task。

因此 3 分钟活动阈值不会被解释成“ChatGPT 还剩 3 分钟”或“3 分钟后一定续轮”。控制中心展示的是 `Turn 活跃 / 疑似静默 / 恢复已就绪` 这类状态，而不是伪造 Host 截断倒计时。

## Host cutoff 与三种模式

三种 continuation mode 在 1.1.50 中职责如下：

1. `completion-driven`：普通多步任务默认值。目标是“所有 milestones 完成前持续同一个 Task Contract”。Turn Lease expiry 只能进入 `SUSPECTED_STALL`；只有独立 Host/lifecycle 证据把它推进到 `CONTINUATION_ARMED` 后才允许恢复。incomplete resource teardown 仍属于直接的高置信生命周期证据。
2. `timeout-recovery`：严格 cutoff-only。只接受 Host 明确 timeout/deadline/budget，或用户/Owner 明确观察过真实 Host cutoff 后通过 `confirm-turn-limit` 记录的保守恢复条件。
3. `resident`：只用于用户明确要求的常驻/监控任务；除 Host cutoff 外，还允许显式 stage/process wake。

learned Host budget 继续只用于 telemetry/参考，不作为 proactive timer。普通进程完成不会自动唤醒 completion-driven/timeout-recovery；只有 resident 的显式 watch 才能产生 process wake。

真实 Host timeout 的 cutoff profile 也不再是“只能越来越大”的永久单值。1.1.50 维护有限样本窗口和 `cutoffEpoch`：当权威 timeout 显著短于当前 regime 时可以直接降档；显著变长则要求更保守的连续样本确认。这样 ChatGPT 将来改变 turn 时长时，不需要依赖写死的 25 分钟级常量。

## MCP / 网络波动

Workspace App 对 continuation 控制面的瞬时 transport error 增加有界退避。识别 `UNAVAILABLE`、`Connection failed`、fetch/network、`ECONN*`、TLS/SSL/handshake 和 timeout 类错误后，按短退避窗口重试同一控制操作，而不是立即放弃 Task Contract。

真实测试还暴露了另一种 race：`app.sendMessage()` 返回 accepted 只证明 Host 接受了 synthetic continuation message，不证明**新 assistant turn 的 MCP connector / OAuth / tool routing 已经完成 rehydrate**。因此 1.1.50 增加两层 recovery-readiness 保护：

- synthetic continuation 文本明确声明它是用户已有授权任务的恢复，不是“等待新的用户指令”；模型不能回复“没有收到新的用户指令/请手动继续”，也不能创建新的 shadow task；
- resumed turn 的第一项业务动作必须是同 `taskId/workspaceId` 的 `continuation_task status`。若此时遇到 `Connection failed` / `UNAVAILABLE` / TLS / fetch 等错误，按 readiness race 处理，在约 30 秒窗口内递增退避重试相同 status，成功前不执行有副作用的业务操作；
- server 会把 delivery ACK 的起始时间、retry count 和下一次 retry time 持久化。若 `app.sendMessage` 已 accepted 但一直没有 model-side `status` ACK，surviving Workspace App 按 `15s → 30s → 60s → 120s → 240s → 300s cap` 重发**同一个逻辑 continuation**；
- 这些 delivery-ACK retransmission 不要求原 Host timeout 仍处于短 freshness window，也不增加 `continuationCount`，因此不会把一次真实续轮误计为多次任务续轮；model-side `status` 一旦成功，会清除持久 retry schedule。

对于可能已经产生副作用的命令或文件修改，恢复连接后应先检查 durable process/file/task state，再决定是否重放，以避免“服务端已执行但客户端只丢了响应”造成重复操作。

1.1.49 的 tunnel 非破坏性恢复门保持不变：公网 curl/DNS/TLS 失败自身不能杀健康 ngrok；只有当前 supervisor 自己拥有的 Agent API 可达并连续确认预期 tunnel 缺失时，才允许重启 owned ngrok child。

## 控制中心与可观测性

续轮页继续支持批量暂停、恢复、锁定、解锁、结束、删除，并新增/强化显示：

- Task Contract 来源（自动契约、模型细化、显式任务、历史任务）；
- Conversation scope 与 workspace；
- completion mode；
- milestone 完成度；
- continuation count，默认上限显示为 `∞`；
- recovery state（`Turn 活跃`、`疑似静默`、`恢复已就绪`、`等待恢复 ACK #N`）与 Anchor Lease；
- 等待 synthetic-turn MCP readiness ACK 时显示 retry 次数和下一次退避窗口；
- 总 wall-clock，默认显示“无限”。

旧版 `legacy-auto` 空 guard 仍可做孤儿回收；新的 completion-driven Task Contract 不会因为 24 小时无活动而被自动回收，因为其总任务生命周期默认明确为无限。

## 数据库迁移

1.1.50 增加 migration 21～24：

- migration 21：Task Contract 来源、contract version、自动创建标记、substantive activity、Turn Lease ID、Anchor mount/expiry 等字段；
- migration 22：`turn_lease_expires_at`，并将当前 1.1.50 自动/模型细化 Contract 迁移为 `completion-driven`、`max_continuations=0`、`deadline_at=NULL`；同时识别 1.1.49 中已经存在、具有非空 milestones 的 legacy `timeout-recovery` 活跃任务，将其标记为 `migrated-1.1.49`、切换到 completion-driven、清除旧预算并初始化 3 分钟 Turn Lease，使升级后当前任务本身也获得 P0 修复，而不是只对新会话生效。
- migration 23：持久化 `stall_state` / suspected / probe / armed evidence，以及 adaptive Host cutoff samples、`cutoff_epoch` 和 regime-change 时间；
- migration 24：持久化 synthetic continuation delivery ACK 的 started/retry-count/retry-after，使 connector readiness 重试跨 Workspace App 重挂仍然可靠。

## 验证原则

本版本回归覆盖：conversation isolation、非空自动 milestones、fallback refinement、checkpoint evidence、`finalResponseAllowed=false`、activity lease 只进入 `SUSPECTED_STALL`、corroborated `CONTINUATION_ARMED` recovery、resource teardown recovery、adaptive Host cutoff 降档/换 regime、1.1.49 legacy active-task migration、completion-driven no-progress 非终止语义、timeout-recovery silence fail-closed、resident process/stage wake、Owner pause/lock、无限默认预算、Anchor re-mount、synthetic-turn connector readiness、持久 delivery-ACK exponential backoff、logical continuation count 不重复增加、Connection failed/TLS retry，以及原有 tunnel/network 非破坏性恢复路径。

Protocol 保持 **1.5**。Linux Remote Agent wire protocol、scoped/full-access 权限模型和上游核心基线保持不变。
