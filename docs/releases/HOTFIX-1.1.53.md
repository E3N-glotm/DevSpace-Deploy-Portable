# DevSpace Portable 1.1.53

1.1.53 收口 1.1.50～1.1.52 在 ChatGPT Workspace App continuation 上暴露出的最后一组 P0：里程碑卡可能漏挂或重复、服务重启后旧卡与新卡争抢 supervisor、正常结束后续轮过慢、synthetic resumed turn 只 ACK 不继续工作、人工消息与自动续轮竞态，以及 Portable 控制中心长期残留历史/终态任务。

## Conversation-lifetime 唯一卡片

1.1.53 把 Task Contract 和用户可见里程碑卡统一为 **conversation-lifetime singleton**：

- 某个真实 ChatGPT conversation 第一次进行 substantive DevSpace 工作时，服务端创建或复用唯一 Task Contract，并只允许一次初始 `continuation_anchor` 可见挂载。
- `anchor_mount_requested_at` 只表示结果已经交给 Host；只有 Workspace App iframe 使用当前 mount token ACK 后才写入 `anchor_mount_verified_at`。
- 一旦任何 generation 已 verified，`anchorMountRecoveryRequired()` 永久返回 false。后续 assistant turn、自动续轮、页面刷新、MCP reconnect、DevSpace 服务重启、workspace 切换都必须复用同一个 taskId 和同一张已存在卡，不得再生成第二张。
- generation/token 仅用于 **首次卡尚未 verified 的真实 ghost recovery**。未验证 provisional issuance 超时后允许同 task 轮换一次恢复 generation；一旦 verified，generation 不再随 assistant turn 变化。
- Host 私有 tracing header、`x-datadog-trace-id`、traceparent、MCP request id 和 `assistantTurnNonce` 都不再作为“每轮生成一张新卡”的依据。服务重启丢失内存 turn identity 也不能使已验证卡失效。
- 历史/过期 iframe 若看到 authoritative generation 更高，会立即 self-supersede，停止 supervisor、heartbeat、lifecycle refresh 与 `app.sendMessage`；服务端同时用 verified coordinator fence 拒绝 stale `claim-continuation`。

因此产品不变量是：**一个使用 DevSpace 的 conversation 恰好一张里程碑卡，不能为零，也不能超过一张。**

## Requested / verified / superseded 边界

1. **requested**：服务端签发 mount token 并把 UI-bearing result 交给 Host，仅为 provisional。
2. **verified**：iframe 已启动并携带 token/coordinator identity ACK；此时才认为用户真正拥有可工作的里程碑卡。
3. **superseded**：仅用于首次 ghost recovery 产生的旧未验证 surface；它永远失去 supervisor/send 权限，不能形成第二个活动卡。

Pre-workspace 场景下 `continuation_anchor.workspaceId` 可选，因此 conversation 可以先挂载唯一卡，再由后续 `open_workspace` 绑定执行目录；切换 workspace 只更新绑定，不创建 shadow task/card。

## <=60 秒 completion-driven 自动续轮

1.1.53 将 completion-driven 的 ordinary stall 恢复窗口收紧为有证据的两阶段状态机，而不是固定等 3～5 分钟：

- 每次 substantive DevSpace 模型活动把 activity suspicion lease 续到 **35 秒**。
- lease 到期后的第一条 verified current-card probe 只进入 `SUSPECTED_STALL`，不能单独创建新 assistant turn。
- 至少 **8 秒**后第二条 verified probe 仍未观察到新的 substantive activity，才进入 `CONTINUATION_ARMED`。
- Workspace App supervisor 约每 5 秒检查一次，因此 ordinary no-cutoff 路径通常约在最后一次真实 DevSpace 工作后的 **43～48 秒**尝试 claim/send，设计上低于 60 秒。
- 已确认 Host timeout/cutoff 仍有独立证据门；满足后不需要再等待 ordinary stall debounce。
- `continuation_task status`、heartbeat、anchor/control 流量都不能冒充模型实际工作，也不能无限刷新 model activity lease。

该机制的目标不是缩短 Host 给模型的正常思考预算，而是在**模型已经真正停止推进**时快速恢复；长时间正常思考/持续 substantive 工具活动会持续持有当前 turn，不应被 supervisor 抢跑。

## 自动续轮与普通人工消息走同一 Host 对话路径

Workspace App 使用 Apps SDK 的 `app.sendMessage()` 创建 synthetic user-role continuation，而不是 DOM 自动化或独立后台模型。恢复轮进入同一个 ChatGPT conversation，随后走正常 assistant turn 与 DevSpace MCP 工具链。

`app.sendMessage()` 返回 accepted 只表示 Host 接收传输，不等于任务已经继续。每个 synthetic generation 都有持久 `deliveryToken + deliveryGeneration`：

- resumed turn 的第一条 `continuation_task status` 必须携带准确 deliveryToken，证明该 synthetic generation 仍拥有任务；
- status/ACK/计划/摘要不满足续轮义务；必须继续执行真实非 continuation-control DevSpace 操作，并持久 checkpoint，才算 synthetic resume 实际推进；
- required milestones 尚未完成时，completion-driven supervisor 会继续下一轮恢复，不允许只回复“继续中”后永久停住。

这保证自动续轮使用与普通用户输入相同的 Host 对话路径和模型/工具执行面，而不是另起一个能力受限的内部 worker。

## 人工输入原子抢占 synthetic continuation

当 task 处于 `synthetic-pending` / `synthetic-active` 时，模型侧出现不带当前 deliveryToken 的真实人工轮 status，被视为 manual takeover：

- 原子清空 continuation pending；
- `delivery_generation` 前进；
- 当前 delivery token 移入 `superseded_delivery_token` 并清空 active token；
- owner 切换为 `manual`，记录 takeover 时间并重置 ACK retry；
- 迟到 synthetic turn 再携带旧 token 时收到 `synthetic-continuation-superseded`，必须静默停止，不得重复调用工具或发送消息。

Coordinator 在 `claim-continuation` 与 `app.sendMessage()` 紧邻之前再次读取 authoritative status，因此人工消息与 automatic claim 的竞态也以最新 generation/owner 为准。

## 卡片权威刷新与旧 iframe 失权

里程碑卡不会再把 iframe 内缓存状态当作最终事实。Coordinator 在 pageshow、focus、online、pointer/visibility/intersection、Host context change 等重新激活点强制 authoritative refresh；终态卡保留低频刷新，因此 checkpoint/complete 后卡片会追平 SQLite 状态，同一个 task 后续重新激活时也能立即恢复显示。

如果 surface 已 superseded，它会清空/折叠自身活动内容并永久停止自动续轮能力；历史卡最多保留不可操作的留痕，不会成为第二个 supervisor。

## Portable 续轮任务列表与清理

控制中心的 continuation 页面补齐任务管理闭环：

- 默认列表只显示非终态任务；`SUCCEEDED`、`FAILED_TERMINAL`、`CANCELLED_BY_USER`、`ABORTED_NO_PROGRESS`、`BUDGET_EXHAUSTED`、`ABANDONED_AUTO_TASK` 不再长期堆在主列表。
- 显式“显示终态”仍可查看历史记录。
- 支持“全选当前”和批量删除，`continuation-delete` 会从 `continuation_tasks` 账本实际删除所选 taskId。
- legacy/provisional 零进展幽灵任务继续由 reap/reconciliation 清理；conversation singleton 约束防止同一 canonical conversation 再生成多个活动 task。

## UI / Review / MCP 稳定性相关回归

历史项目对话里提到的关联问题也纳入当前回归面：

- `show_changes` / operation history 长卡默认折叠，失败项可展开；Review / Apply Patch 的 loading 状态有界，不再永久停在 `Loading review...`。
- Native continuation 页支持全选、批量控制和删除，终态默认隐藏。
- MCP reconnect、session registry、Remote Workspace、插件、Computer Use、Updater transaction 与 native close/tray 均保留专项回归，避免 continuation 修复破坏既有运行面。

## 回归与发行安全

最新源码已通过 continuation、Native UI、native close/tray、runtime cards 与 runtime log UI 专项回归；真实长时间 `scripts/test-source.ps1` 也以 exit code 0 结束。发行包仍执行内容无关的状态隔离：`workspace-archives` / `data` / `logs` 等运行目录不进入 ZIP，任何 `auth.json`、`.sqlite`、`.sqlite3` 命中都会在 checksum/ZIP 前 fail closed。

Protocol 保持 **1.5**。Remote Agent wire protocol、OAuth、权限模型、插件用户数据与 Portable `data/` 不需要因 1.1.53 重建。

> 1.1.53 在 live ChatGPT 验收全部通过前保持未发布：最终需要在部署后的真实 conversation 中确认单卡、服务重启不重挂、<=60 秒 unattended continuation、resumed turn substantive work 与 manual takeover 竞态。
