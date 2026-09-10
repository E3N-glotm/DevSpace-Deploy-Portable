# DevSpace Portable 1.1.59 Hotfix

## dev47：按 dev46 调查结果统一收紧 Host 投递、续轮执行与卡片生命周期

dev47 不再把 transport Promise fulfilled 当成 Host 已创建模型轮次：`ui/message` 返回 `{isError:true}` 会作为拒绝持久化，且只有明确 method unsupported 才能使用旧 compatibility bridge。Host 已接受但 resumed-model 尚未 ACK 的 generation 保持 outcome-uncertain，只显示启动健康告警，不再按 45/60 秒 deadline 重发可见 user message；这样不会在模型已经启动但较慢时插入第二条“继续”。tool cancellation 与 iframe teardown 的自由文本也不再被提升为 Host timeout，只有经过精确 turn/card capability 验证的 timeout 路径拥有截断权限。

内联 coordinator 的 wake endpoint 改由 server 以绝对 HTTP(S) URL 注入；`srcdoc/about:blank` 环境不再执行 `new URL(..., import.meta.url)` 并在安装 listener 前崩溃。缺少有效 URL 时仅关闭 SSE wake，保留权威 status/timer 恢复。sender wire contract 因此升至 epoch 10。

synthetic 与手动 continue 现在采用相同的 1 次实质操作防空转证明；旧的 4 次操作和已学习 Host 窗口 95% 门槛已删除。操作次数和时间只用于诊断，不能成为提前结束或触发另一轮的权限。自动续轮仍必须以完整里程碑集为目标，在同一 Host turn 中持续读取、修改、执行、验证并可完成多个里程碑，直到全部完成、真实外部阻塞/暂停、模型在持续工作后签署明确阶段边界，或 Host 自身截断。

业务完成与卡片 iframe mount telemetry 已解耦：里程碑和证据齐全时可以进入 `SUCCEEDED`，同时保留缺失 mount ACK 作为独立 UI 事件，避免 UI 故障复活已完成任务。卡片刷新改为保留根节点和交互状态的递归增量 reconcile，并移除同一 tool-result 上的 25/150ms 双重延迟 render，从源头降低整卡替换导致的滚动锚定和 ResizeObserver 抖动。真实 D-live E2E 未通过前，本迭代不部署生产，也不构建或发布 Release。

## dev44：标准 `ui/message` 负责真正的 user-role 续轮，并立即释放 superseded sender claim

dev43 的真实网页验收把故障进一步收窄到了 Host delivery 层。前一轮已经成功签署 `COMPLETION_REQUESTED`、promotion 成功并创建 synthetic generation；但 generation 3 在 15:45:36、15:46:59、15:48:58 三次进入 delivery，三次 `window.openai.sendFollowUpMessage` Promise 都在 0–1 ms 内 fulfilled，却始终没有 resumed model 的 `continuation_task status` ACK，`turn_acked_at` 一直为空，直到 15:49:38 人工输入接管。也就是说，dev43 的 generation FSM、sender recovery 和 ACK retry 已经实际工作，但 compatibility `sendFollowUpMessage` 的“调用成功”并不等于 ChatGPT 创建了一条真正的 user-role 模型轮次；继续重复同一 compatibility API 只会得到更多 transport-level fulfilled，而不会自动完成任务。

本地当前打包的 `@modelcontextprotocol/ext-apps` 同时给出了标准协议证据：`App.sendMessage()` 发送的就是 MCP Apps `ui/message` 请求，其参数角色必须为 `user`，内容为标准 MCP content blocks。dev44 因此撤销 dev32 以来“自动续轮必须 native-only、标准 `ui/message` 只能渲染气泡”的经验性假设，改为由标准 `ui/message` 承担首发与同 generation ACK retry：`{ role: "user", content: [{ type: "text", text }] }`。`window.openai.sendFollowUpMessage` 只保留给明确拒绝 `ui/message` 的旧 Host 做 compatibility fallback；如果 `ui/message` fulfilled，则记录 `method=ui/message/result=accepted/model-turn-unconfirmed` 并等待真实模型 ACK；如果 Promise 在 settlement deadline 后仍 pending，则记录 `result=unknown`，保持 outcome-uncertain 并禁止立刻调用 compatibility API，避免第一条标准 user message 已跨过 Host 边界时再制造第二条重复消息。无论 transport 使用哪条路径，唯一成功证明仍是 resumed synthetic model 的 server-owned generation ACK，而不是 Promise fulfillment。

同一次 live 记录还暴露出另一个独立的 sender claim 竞态。generation 2 在 15:44:33 被 sender A CLAIMED，但新的 milestone/App iframe 在 sender A 完成 `authorize-delivery` 前重新 bind，同一 Conversation Card 的 `sender_instance_id` 被 sender B 替换。旧 claimant 此后会正确收到 `sender-instance-superseded`，但 dev43 仍让 generation 2 保持 CLAIMED，直到 15:45:18 左右完整 45 秒 claim lease 到期后才以 `sender-claim-expired` 关闭并重新创建后续 generation。这不是安全要求，而是换绑后的无效等待。

dev44 把 sender replacement 与该 claim 的恢复放进一个 SQLite 事务。仅当当前 card 正在替换 sender 且 active Workset 存在尚未完成 authorize 的 synthetic `CLAIMED` generation 时，runtime 才释放这个已失去发送资格的旧 claim：初次 delivery claim 回到 `READY` 并清除旧 token/ownership；如果它本身是同 generation 的 ACK retry claim，则回到 `DELIVERED` 并保留原 delivery token。随后才写入新的 `sender_instance_id`，因此新 sender 的 bind 返回可以立即暴露原 generation 为 `readyGeneration`，不再等待 45 秒。该处理不旋转 lifetime card、不增加 continuationCount、不创建 sibling generation，也不允许任意 heartbeat 抢占已经绑定的 sender；人工输入依旧能随时 supersede 全部 synthetic ownership。

新增动态回归分别覆盖四个关键边界：Host 同时有标准与 compatibility API 时首发/ACK retry 必须都只走 `ui/message`；标准请求永不 settle 时不得调用 compatibility transport；标准请求明确 reject 时允许且只允许一次 compatibility fallback；sender A 已 CLAIM、sender B 随后 bind 时原 generation 必须立刻回到 READY，并由 sender B 在同一次测试中立即重新 claim。隐藏 sender wire contract 因发送与 rebind 语义变化升至 epoch 8，升级前存活 iframe fail-closed；Portable Protocol 继续保持 1.6。真实 D-live `turn-complete → ui/message → synthetic status ACK → substantive DevSpace work` 仍是 dev44 最终验收门槛。

## dev43：解除 turn-complete 与 Host sender 初始化的前置死锁

dev42 的真实 D-live 验收证明，`continuation_anchor` 工具外壳出现在 ChatGPT transcript 并不代表 Apps iframe 已完成 `ui/initialize`：当前 generation 长时间保持 `mount_state=REQUESTED`，`mount_verified_at`、`coordinator_instance_id`、`sender_instance_id` 与 `last_ui_heartbeat_at` 均为空，`continuation_sender` 审计也没有任何 bind/heartbeat。与此同时，旧版 1.1.48 并不存在 `continuation-sender-unavailable` 的模型签署前置门禁，而是由仍存活的 Workspace App 直接尝试 Host follow-up；这解释了“旧版至少能自动续，但续轮只工作几十秒/工具能力差”，而新版本在更严格的 exactly-once/sender 安全边界下反而完全不续。

根因是 dev39 为避免 orphan READY 将 sender readiness 放在了 `turn-complete` 之前。ATCC 要求模型在可见 final 前签署当前 turn lease 的阶段完成意图，但 ChatGPT Host 可能直到 assistant/tool render 正在提交最终边界时才真正初始化 App iframe，因此产生循环依赖：没有 final 边界就没有 sender，没有 sender 又拒绝 `turn-complete`，最终既没有 completion intent 也没有自动续轮。

dev43 将安全边界移动到正确层级。`turn-complete` 只验证模型当前阶段是否真的结束、里程碑仍未完成以及 manual/synthetic substantive-work/Host-budget 门禁；它不再依赖 browser transport。模型签署后持久化 `COMPLETION_REQUESTED` 和精确 turn lease。resident 在 8 秒 handoff grace 到期后调用 `promoteMatureAssistantCompletionIntent()`，此时才要求当前 process-local sender 已绑定且 heartbeat 在 `ANCHOR_LEASE_MS` 内新鲜；sender 缺失时保持原 completion intent，既不回退 GENERATING，也不创建 READY。合法 App 稍后 bind/heartbeat 后，同一 completion lease 会在下一次 sweep 被 promotion 并创建 READY，不需要第二次 `turn-complete`，因此不会丢失模型已经发生的真实阶段边界。

新的动态回归覆盖生产时序：无 sender 时模型完成 substantive work 后 `turn-complete` 必须成功进入 `COMPLETION_REQUESTED`；handoff grace 后 promotion 必须以 `continuation-sender-unavailable` fail-closed，且 synthetic READY 数量严格为 0；随后当前 generation sender bind，旧 completion lease 无需重签即可 promotion，下一 supervisor sweep 必须产生 READY。这样保留 dev39 的 orphan-READY 防护、唯一卡片、人工输入最高优先级和 generation CAS，同时恢复旧版“至少能进入续轮”的能力边界。

## dev42：MCP 重启后由合法 heartbeat 恢复 process-local sender

dev41 部署后的真实 D-live 验收暴露了一个此前单元测试没有覆盖的服务重启生命周期缺陷。`StructuredRuntimeState` 在每个新 MCP 进程构造时会按安全设计清空持久化的 `continuation_conversation_cards.sender_instance_id`，防止旧进程的 sender authority 跨服务实例继承；但 ChatGPT 页面中已经存活的当前 milestone iframe 在 MCP 短暂重启后不保证再次收到 Workspace App `onConnected()`。现场因此出现了一个看似矛盾但可稳定解释的状态：iframe/sender heartbeat 继续刷新 `last_ui_heartbeat_at`，浏览器内也仍持有正确的 card capability，而服务端 `sender_instance_id` 已为 `NULL`。`turn-complete` 的 sender readiness gate 随后正确 fail-closed 为 `continuation-sender-unavailable`，导致模型已经明确结束当前阶段、里程碑仍未完成时仍无法创建 READY synthetic generation。

dev42 不把 sender authority 改成跨进程持久信任，也不依赖 Host 重新触发 `onConnected()`。`heartbeatContinuationSender()` 现在要求非空 sender instance，并继续完整验证当前 task/conversation、已发行 Conversation Card 的 mount token 与 generation；`continuation_sender` server wrapper 仍先验证当前 sender protocol epoch。只有这些 capability 全部匹配时，heartbeat 才通过 SQLite 条件更新把 `sender_instance_id` 从 `NULL` 原子填为当前 sender。若槽位已经属于同一 sender，只刷新 heartbeat；若已经属于另一个 sender，则仍返回 `sender-instance-superseded`，竞争 iframe 不能借 heartbeat 抢占 sender。该恢复不改变 card id/generation/coordinator，不创建 synthetic generation，也不改 manual/synthetic turn ownership，因此保持唯一卡片、人工输入最高优先级和 generation CAS 边界。

专项动态回归直接模拟生产故障：Runtime A 创建并验证卡片、绑定 sender 后关闭 SQLite；Runtime B 在同一状态目录重新构造并确认 sender 被清空而 card generation 保持不变；原合法 iframe 的第一条 sender heartbeat 必须重新绑定 sender，竞争 sender heartbeat 必须被拒绝；随后当前模型的 substantive activity 后 `turn-complete` 必须成功进入 `COMPLETION_REQUESTED`，不再出现 `continuation-sender-unavailable`。`test-continuation-guard.mjs` 与 `test-continuation-architecture.mjs` 已分别通过；完整 source tree、正式 Portable 构建和真实 `turn-complete → synthetic model ACK` 仍作为 dev42 的最终发布前门禁。

## dev41：保护 synthetic ACK 等待状态并区分 Host 调用与模型启动

dev40 真实 E2E 诊断确认了两个相互叠加的缺陷。第一，普通 Workspace App 重连会把 `continuationPending=true && continuationWakePending=false` 当成执行 `resume` 的理由；对已完成发送、正在等待 resumed-model ACK 的 pending 4/5 generation，这会清除 pending、旋转 turn lease，并可能把 assistant owner 改写为 manual，却留下 synthetic delivery token。第二，native `window.openai.sendFollowUpMessage` 的 Promise 正常 fulfilled 与 bounded settlement deadline 后仍 pending 都曾被归入 `fallback-accepted`，使 transport settlement 与 Host 是否真正启动模型轮次混在同一状态标签里。

dev41 将重连恢复与模型 ownership mutation 分离。coordinator 只允许不带 synthetic ACK 状态的 `FAILED_RETRYABLE` 继续走 legacy `resume`；已存在 delivery token 或 `continuationDeliveryAwaitingAck` 时只通过 sender bind/supervisor 恢复原 generation。runtime-state 同时增加服务端防线：当 `delivery_token` 存在、`continuation_pending` 为 4/5 且 owner 为 `synthetic-pending`/`synthetic-active` 时，普通 `resume` 返回 `synthetic-delivery-resume-forbidden`，不会清 pending、不会改 owner、不会生成新的 manual turn lease。这样即使浏览器仍缓存旧 coordinator，也不能破坏迟到 ACK 或同 generation 恢复资格。

发送结果语义同步收紧。native Host Promise 超过 bounded settlement deadline 仍未结束时记录 `result=unknown`，canonical generation 保持 outcome-uncertain，不把它伪装成 DELIVERED，也不立即换 payload 或自动重复发送；如果 Promise fulfilled，则仍使用 transport-compatible `fallback-accepted`，但 note 明确写入 `model-turn-unconfirmed`，只有 resumed model 的 DevSpace ACK 才证明模型轮次真正启动。诊断只记录 payload 形状、实际 settlement 耗时、返回类型和最多 8 个安全字段名，不记录返回字段值、delivery token 或完整提示词。由于隐藏 sender wire contract 的结果语义发生不兼容变化，sender protocol epoch 升为 7；Portable Protocol 继续保持 1.5。

## dev38：修复 `fallback-accepted` 后 sender relay 消失导致 ACK retry 无人接管

2026-09-08 真实网页 E2E 对 dev37 给出了新的确定性证据：本会话在 22:47:15.944（14:47:15.944Z）签署 `turn-complete`，generation 3 于 22:47:24.763 READY、22:47:45 左右 CLAIMED、22:47:48.686 完成发送前授权，并在 22:47:58.655 由 superseded card 的 headless sender relay 调用 `window.openai.sendFollowUpMessage` 后记录 `fallback-accepted`。该 generation 随后保持 `DELIVERED` 且 `turn_acked_at` 为空，ACK retry deadline 为 22:48:43.654。resident server 从 22:48:44 起约每 5 秒持续识别 `delivery_ack_retry_due` 并广播 continuation wake，说明 SQLite generation FSM、ACK deadline 和 server sweep 均正常；但直到 22:50:41 用户人工输入触发 manual takeover 前，数据库没有第二次 delivery authorization / delivery，网页也没有 synthetic turn。

根因位于 App/Host sender relay 生命周期：第一次 native Host 调用恰好由已经 supersede 的旧卡 headless relay 完成；该 iframe teardown 后会 `dispose()`，同时关闭 EventSource 与 supervisor。后续新的 current-generation Workspace App 可以重新获得 sender capability，但旧 bind 快路径只在 server 返回 `readyGeneration` 时立即调用 `attemptContinuation()`，不会把已经到期的 `continuationDeliveryAwaitingAck` 当作同等恢复条件，因此 durable ACK retry 可能长期无人消费。dev38 将该快路径升级为 `consumeRecoveryAfterSenderBind()`：bind、rehydrate、connected 以及 superseded relay rebound 都会同时检查 READY 和 overdue delivery ACK retry；replacement App 一旦证明当前 card sender capability，就立即通过既有 `continuation_sender claim` CAS 对**同一个 DELIVERED generation / delivery token**执行 reclaim。runtime 原有 CAS 已保证该恢复复用 token、continuationCount 不增加，并在 sibling App 竞争时只有一个 claim 成功，所以修复不创建新的 synthetic generation，也不降低人工输入最高优先级。

同时，`fallback-accepted` 不再以绿色 success UI 表示“自动续轮已经成功”。它只表示 native Host 调用已发出、但 resumed model turn 尚未得到 DevSpace 证明；界面改为 warning，并明确只有 resumed synthetic model 的首个 `continuation_task status` ACK 才能把 generation 视为真正启动。新增动态回归完整模拟“原 sender 首发后进入 awaiting ACK → ACK deadline 到期 → 原 controller/iframe 销毁 → replacement App 重建并 onConnected”，要求 replacement 立即 retransmit、delivery token 与原值完全相同、continuationCount 不增加且实际进入 atomic sender claim；focused `setup/test-continuation-guard.mjs` 已通过。完整源码回归和真实 D-live `turn-complete → synthetic` 仍是 dev38 的最终验收门槛。

完整回归随后又暴露一处同属恢复路径的 stale snapshot 覆盖：`bindSenderTransport()` 返回的 task 快照早于可见卡随后的 authenticated mount ACK；旧 `consumeRecoveryAfterSenderBind()` 会再次 `acceptTask(outcome.task)`，从而把刚写入的 `anchorMountVerifiedAt` / `anchorMountCoordinatorId` 擦掉，使已验证卡错误退回未验证状态。dev38 现在由 bind 负责一次性接纳 bind 快照，recovery consumer 只读取 controller 的最新 state，不再回放旧 outcome.task；missing-toolresult 的 Host 排序回归要求 capability 恢复后 mount verification 在 `onConnected()` 返回前保持有效且不能被后续 recovery 覆盖。

## dev37：修复 native follow-up Promise 永久 pending

2026-09-08 本会话真实 E2E 进一步确认：13:57:09.086Z generation 2 已 READY，13:59:57.303Z 被 sender CLAIMED，14:00:00.338Z 已记录 `continuation-generation-delivery-authorized`，但直到 14:02:29.033Z 人工接管前没有任何 `continuation-generation-delivery`，数据库的 `last_send_attempt_at` / `last_send_result` 也始终为空。结合 coordinator 控制流可确定，阻塞发生在授权成功后的 `await window.openai.sendFollowUpMessage(...)`；该 Host Promise 可以既不 resolve 也不 reject，旧实现没有 settlement timeout，因此 generation 会无限留在结果不确定的 `DELIVERING`。

dev37 给 native follow-up Promise 增加 4 秒 settlement 上限，但该上限只限制“等待 Host Promise 返回”的时间，不把沉默解释为发送失败，也不立即调用第二种 payload 形态。超时表示 native Host 调用已经发起但结果 Promise 不可靠，coordinator 会记录 `fallback-accepted` 与 `native-follow-up-settlement-timeout-*` 证据，让既有同 generation、同 delivery token 的 ACK 恢复状态机继续负责启动确认；这样既消除永久挂死，又保持人工输入最高优先级和避免立即重复可见续轮的 at-most-once 边界。新增 Fake Host 永不 settle 回归，要求 `attemptContinuation()` 有界返回、`delivery-result` 被记录且 Host 调用次数严格为 1。

## dev36：修复 sender 前后端协议漂移

2026-09-08 实际读取 vendor、installed core 与 D-live，均确认 dev35 的 coordinator 声明 sender epoch 5，而 server.js 仍要求 epoch 4。原测试分别断言这两个不同值，未验证互操作性。新增两端相等断言在原 dev35 上真实失败（5 !== 4）；修复服务端 epoch 后，测试还会检查 installed core 与源码一致，并让 FakeApp 按真实服务端 epoch 校验 bind、claim、authorize-delivery 和 delivery-result 请求。

本会话上次 E2E 的数据库记录为 10:35:00.500Z READY、10:35:17.820Z CLAIMED、10:35:21.012Z delivery-authorized，随后没有 delivery result / TURN_ACKED，直到人工接管。协议漂移是确定性的发送阻断；历史 DELIVERING 的原生 Host 调用是否已经执行仍无完整证据，不伪造发送失败或用计时器重发。dev36 保留该边界，并须在真实网页上重新验证模型 ACK 与实质工作后才能称为通过。

## 目标

1.1.59 当前 hotfix 同时收口 Remote Workspace / Linux Agent 配置更新链路，以及 ChatGPT Host 自动续轮 / 里程碑卡片状态机中的确定性竞态。

第一，原生控制中心的按钮虽然叫“**一键恢复 / 更新 Agent**”，但 existing-agent 分支实际上以已登记的 `_selectedAgent` 配置为优先来源；只要 Agent heartbeat 正常就直接返回，离线时也先按旧 `installRoot / writableRoots / accessMode` 重启。结果是用户在界面里修改 Writable Roots、切换 Full Access 或更改 Agent install root 后，按钮并不会把这些新值写回同一个 Agent。

第二，Full Access 本来不应该依赖任何 Writable Root，但 SSH enrollment 的旧 fallback 在 roots 为空时仍把 install root 硬编码为 `/home/ubuntu/workspace`。如果服务器没有该目录，即使 Full Access 已启用，安装链路仍会因为这个无关路径不存在而失败。

第三，自动续轮此前把“模型一段时间没有 DevSpace 活动”与“Host 已经结束当前 assistant turn”混在一起，短 owner lease、普通静默和 Host follow-up 回调不确定状态都有机会被错误解释成可重发条件。这既可能制造重复续轮，也可能在真实 send 已经发生但 ACK 丢失时重复发送。

第四，server resident sweep 可以在 Workspace App sender 已经绑定之后才创建新的 `READY` generation；旧 coordinator 只在 bind/onConnected 当下消费 READY，导致这种“后出现 READY”可以长期无人 claim。真实现场曾出现 READY 约 18 分钟，直到用户手动发送消息才被 supersede。

第五，真实 Host 已观察到第一条 synthetic `ui/message` 被模型误判为“只是系统续接说明”，首个 resumed turn 只复述恢复信息、不做实质工具操作，直到第二次续轮才开始工作。synthetic visible/hidden contract 现已明确首轮就是本轮实际用户角色工作请求，并要求 status/discovery 后在同一 turn 继续实质 DevSpace 操作。

第六，进一步 live 验证证明：真实 ChatGPT 网页里的“模型正在长时间纯推理”与“assistant turn 已经结束”在 DevSpace 侧都可能表现为一段没有模型 DevSpace 请求的静默，因此任何固定的 server-quiet 阈值都存在误抢占风险。最终 1.1.59 不再把纯静默、Turn Lease 过期、`SUSPECTED_STALL` 或 historical cutoff 升级为 continuation authorization。普通模型主动结束一个仍有未完成 milestone 的阶段时，必须由模型在本轮充分实质工作后显式签署 `continuation_task action=turn-complete`；它绑定当前 `turnLeaseId`，后续新实质工作或人工 takeover 都会撤销旧签名。显式、已验证的当前-turn Host timeout 则是另一条独立合法恢复路径。iframe heartbeat 只证明卡片存活，不证明 turn 已结束。

第七，最终全量回归暴露了一个与自动续轮发布可靠性相关的 Windows stop/restart 竞态：服务命令行与监听端口已经消失后，被 `taskkill /F` 的 PID 仍可能在极短窗口内继续出现在进程表。旧 `stop-local` 会在此时提前报告成功，使紧接着的 `restart-local` 或 strict-stop 验收看到“成功返回但旧 PID 尚在”。1.1.59 现在复用既有总 stop deadline，对 manager 自己明确终止过的 PID 做退出 drain；不增加第二套固定 grace，不使用 `/T`，也不扩大到无关后代进程。

## 关键修复

### 1. 手动“恢复 / 更新”真正变成配置更新

- 用户主动点击按钮时，控制中心从**当前编辑器**读取服务器显示名、Agent install root、Writable Roots 与 Full Access 开关，不再让已登记的旧值覆盖 UI 草稿。
- Existing Agent 使用原 `agentId` 创建 repair enrollment，并通过现有 SSH 本地安装链重新写入同一个 Agent 的 endpoint、凭据、访问模式与 roots。
- Full Access 会明确把 `writableRoots` 置为空数组；Scoped 则使用当前多行编辑器里的 roots。
- 更新完成后重新等待同一个 `agentId` heartbeat 并刷新列表，从而避免“看起来保存了、实际仍是旧配置”。

### 2. 后台自动恢复与人工更新分离

- `silent` 自动 SSH 救援继续使用最后一次已持久化的 Agent 配置，并保持 restart-first；它不会因为用户恰好打开界面、但尚未主动提交某个草稿值而擅自修改服务器权限。
- 非 `silent` 的显式按钮路径才执行 repair enrollment 和配置更新。
- 因此“自动救活旧配置”和“用户确认应用新配置”不再共用一个模糊分支。

### 3. Full Access 不再依赖 `/home/ubuntu/workspace`

- SSH 端先验证当前 install root 是否为存在且 `r/w/x` 的绝对目录。
- Full Access 下，如果该路径不存在、不可写或用户没有提供有效路径，则自动使用 `${XDG_STATE_HOME:-$HOME/.local/state}`，必要时创建该目录，并再次验证权限。
- Enrollment 不再存在 `roots 为空 -> /home/ubuntu/workspace` 的硬编码 fallback。
- Scoped 模式保持严格：指定 install root 不存在或不可写时直接失败，而不是静默把受限 Agent 安装到范围之外。

### 4. install root 变化时安全迁移运行实例

- 更新前会用旧的已登记 install root / roots 以及标准 state 目录候选定位现存 Agent state，并在可用时核对 `config.json` 里的 `agentId`。
- 如果新 install root 不再包含旧 state，先读取旧 PID，并且只有 `/proc/<pid>/cmdline` 同时匹配旧 state 下的 `devspace-agent.py` 与 `config.json` 时才终止该进程。
- 随后在新位置安装并启动 repair enrollment，避免同一 Agent 的旧进程继续用旧权限策略在线。

### 5. 自动续轮状态机 fail-closed

- 普通静默、Turn Lease 到期的第一阶段只允许进入 `SUSPECTED_STALL`，不会在 25 秒阈值处直接生成新的 Host turn。
- 明确、已验证的当前-turn Host timeout 继续作为真正 Host 截断的恢复证据；普通模型主动结束未完成阶段则使用当前-turn 的 model-signed `turn-complete` ATCC 路径。
- **纯 request silence 永远不再作为 continuation authorization。** 25 秒 lease 过期后只记录 `SUSPECTED_STALL`；即使随后持续数分钟没有 DevSpace 请求，也不得据此创建 READY generation。这样模型在长推理、上下文压缩或等待非 DevSpace 工作期间不会被 watchdog 抢占。
- 历史 Host cutoff 现在只保留为遥测/诊断。live 验证已经证明后续 assistant turn 可以合法超过先前观测到的 cutoff，因此它不能在缺少当前 turn 结束信号时授权 READY。
- completion-driven 自动恢复只接受两类权威结束信号：**当前 turn 的已验证显式 Host timeout**，或**当前模型在充分工作后签署的 `turn-complete`**。`turn-complete` 后若还有任何 substantive DevSpace 调用，签名立即撤销回 `GENERATING`；人工输入同样通过新 `turnLeaseId` 原子废弃旧 synthetic 权限。
- `CLAIMED` 是发送前状态，可以在 claim lease 到期后安全回收；`DELIVERING` 是结果不确定区，timer 永远不能据此重发。
- 原生 `window.openai.sendFollowUpMessage` 返回 `unknown` 时保留原 generation 的 `DELIVERING`，不转换成 READY；只有明确 `failed/rejected` 才允许下一次 generation。
- 自动续轮首发和同 generation/token 的 ACK 重试都固定使用原生 `window.openai.sendFollowUpMessage`；标准 Apps `ui/message` 不作为首发或回退，因为 Host 接受并显示用户气泡不等价于启动完整模型推理与工具链。
- synthetic work owner 的 45 秒短 lease 只用于检测 stale ownership，不能凭自身到期制造第二个 ChatGPT turn；后续 synthetic→synthetic 同样必须有显式 Host timeout / teardown 或 confirmed-cutoff 证据。

### 6. READY-after-bind 不再饿死

- `continuation_task status` 已能暴露当前 durable `readyGeneration`，coordinator supervisor 现在会在常规权威状态刷新时消费它。
- 因此 READY 无论是在 sender bind 前还是 bind 后由 resident sweep 生成，都会进入同一个原子 `claim -> authorize-delivery -> window.openai.sendFollowUpMessage -> delivery-result` 路径。
- 多个可用 Workspace App relay 即使同时看到 READY，也依靠 server CAS 只有一个 sender 能 claim，避免重复消息。

### 7. 第一次 synthetic turn 必须直接干活

- Host-visible continuation 文本明确声明：这是**当前 assistant turn 的实际用户角色工作请求**，不是仅供参考的系统恢复说明。
- 恢复后的第一步仍要求 `continuation_task status`；如果 DevSpace_MCP schema 未预加载，先通过 connector/tool discovery 加载。
- status/discovery 只属于 control plane。只要仍有 runnable milestone，同一 synthetic turn 必须继续至少一次实质 DevSpace 工具工作，不能只复述提示、只报状态、回复“继续处理中”，也不能等第二次续轮才开始执行。

### 8. Apply 前残留进程检查保持安全但不再超时

- Portable-root executable preflight 仍然 fail-closed：检测到无关的运行中可执行文件时，在任何 program-file move 前拒绝 Apply。
- 首次使用全量进程扫描定位残留；等待退出期间只复核已经证明属于 Portable root 的 PID，避免在高进程数机器上每 250 ms 对所有进程重复读取 `MainModule.FileName`。
- 已知残留清空后必须再次执行全量扫描才能进入事务，因此性能优化不降低“开始移动文件前无 Portable-root 残留”的安全不变量。

### 9. 同一真实 assistant turn 不再被 weak quiet-backstop 抢占

- 真实网页 Host 可能在模型长推理、上下文压缩或等待外部工具返回期间保持当前 assistant turn 存活，但这一段时间未必持续产生 DevSpace 调用；旧 bounded quiet-backstop 因而仍存在把“同一轮仍在工作”误判成“上一轮已经结束”的窗口。
- 模型发起新的 DevSpace 请求时，server 现在先登记 model-originated request in-flight，再执行 continuation ownership authorization，关闭“授权检查通过后、in-flight 尚未可见前”被 supervisor 抢占的竞态。
- 最终架构已经**停止生成新的 quiet-backstop READY**。升级兼容代码仍能识别旧 runtime 遗留的 `server-quiet-backstop-no-inflight-model-request` READY/CLAIMED，并在真实同轮模型活动重新出现时安全撤销这些 stale generation，防止升级过程中旧状态继续阻塞。
- 已经 claim、已经进入 `DELIVERING` 或拥有更强 Host/cutoff 证据的 generation 不会被该规则撤销；因此修复只消除 weak false-positive，不削弱 durable delivery 的去重语义。
- 同一手动用户消息的异常恢复继续复用当前 visible card generation；weak quiet recovery 不得自行旋转新卡。

### 10. canonical-repair SQLite 快照改为有界 retention

- `devspace-before-canonical-repair-<timestamp>.sqlite` 维护快照现在通过独立的纯文件系统 retention 模块管理，并在 state DB 打开路径中自动收敛历史遗留文件。
- 只匹配严格 canonical-repair 文件名，不触碰主 `devspace.sqlite`、WAL/SHM 或其他 SQLite 文件。
- 默认保留最近 **3** 份，同时施加 **512 MiB** 总体积上限；清理失败 fail-open，不允许因历史维护文件权限异常阻塞 DevSpace 服务启动。
- D live 已从 39 份、约 3.16 GB 历史快照收敛到 3 份、约 256 MB；清理前后 `PRAGMA quick_check` 均为 `ok`，主库大小未改变。

### 11. process registry 终态历史改为有界 compaction

- persistent process registry 不再无限累积 `exited/lost` 等终态行。
- `running`、`detached-running`、`stopping` 等活动/过渡状态明确永不进入历史 DELETE 条件。
- 终态历史默认保留最近 **5000** 条，并额外淘汰超过 **30 天**的旧记录，在保留诊断窗口的同时阻止长期无界膨胀。
- D live 已从 26,798 行压缩到 5,003 行，删除 21,796 条终态历史；活动记录全部保留，主库 `quick_check` 仍为 `ok`。

### 12. milestone 全部完成后原子封口 Task Contract

- completion-driven Task Contract 不再允许出现 `remainingMilestones=[] / taskIncomplete=false` 但 task state 仍长期停在 `RUNNING` 的僵尸终态。
- checkpoint 只有在 required milestones 非空且全部完成、存在 durable evidence、当前不处于 owner lock、canonical visible card 已完成验证等终态安全条件同时成立时，才原子进入 `SUCCEEDED`。
- 原子封口后同时执行 terminal continuation cleanup，清除 synthetic delivery owner/token 等残余控制面状态；因此 late duplicate delivery 会被更强的 `task-terminal-no-work` 门直接拒绝。
- 没有 evidence、卡片仍待 ACK、仍有 owner lock 或 milestone 未完成时，checkpoint 保持旧的 fail-closed RUNNING 行为，不会通过“自动成功”绕过原有门禁。

### 13. 正式版 pre-final barrier 防止 incomplete 裸 final

- 现场再次复现了一条与 sender 无关的漏续轮：用户已经看到 assistant 回复结束，但数据库仍是 `RUNNING / GENERATING`，没有 `COMPLETION_REQUESTED`，也没有 READY generation。直接原因不是 delivery 延迟，而是模型在最后一个普通 DevSpace 工具结果之后直接输出了可见 final，没有执行合法阶段边界 `turn-complete`。
- 仅把 `preFinalControlRequired / finalResponseAllowed` 埋在长 Task Contract 文本里仍可能被模型在“结果已经拿到、准备回答”时忽略。现在每个普通 DevSpace 工具结果都会先插入一个短的 `DEVSPACE PRE-FINAL BARRIER`，位置在原始工具 payload **之前**，并同步提供 `devspacePreFinalBarrier` 结构化状态。
- barrier 在 `taskIncomplete=true` 且 `preFinalControlRequired=true` 或 `finalResponseAllowed=false` 时明确禁止用户可见 final：继续本轮实质工作；若本阶段确实应该主动结束，则最后一个 DevSpace 控制调用必须是 `continuation_task action=turn-complete`；只有真实不可用外部依赖才允许 `checkpoint waitingExternal=true`。
- barrier 只是把已有 ATCC 控制协议提升到普通工具结果的首部和结构化输出，不新增任何静默计时授权。`SUSPECTED_STALL`、lease expiry、heartbeat、historical cutoff、单个工具错误和“已完成一个 milestone”仍然不能自行创建新 Host turn。

### 14. superseded 历史里程碑卡不再变成空白外壳

- 旧实现检测到更高 `anchorMountGeneration` 后，会把旧 iframe 降级为 headless sender relay，同时直接清空 `document.body` 并强制高度为 0。ChatGPT 外层 App 容器不会同步删除，因此用户看到的不是卡片真正消失，而是保留边框和标题的大片空白；Host 异步尺寸缓存还会放大这一现象。
- coordinator 过去会先把新 generation 的 authoritative task 广播给旧卡，再执行清空，因此旧卡可能短暂显示下一轮内容后突然变白，形成抽搐。
- dev33 保留 sender 权限退役语义，但将“headless”限定为控制权限，不再等同于删除可见历史：旧卡冻结自己的最后任务快照，显示“已由后续消息接替”，保持用户原有折叠选择与非零稳定高度，并忽略后续 generation 的 UI 广播。
- 新 generation 仍拥有唯一有效 anchor/coordinator；旧 iframe 只能重新绑定私有 sender relay，不能 ACK 新卡、不能提供 Host 生命周期证据，也不能绕过 generation CAS。该修复未改动 ATCC、native follow-up、ACK 重试、人工 takeover 或动态 Host budget。

### 15. volatile lease 刷新不再触发整卡 DOM 替换

- 现场继续观察到卡片不再变空后，ChatGPT 页面仍可能在 DevSpace 工具调用期间上下抽搐。根因不是新的卡片 generation，而是可见卡片包含 `turnLeaseExpiresAt`：该字段会随每次模型/工具活动刷新，导致 runtime 的 `outerHTML` 去重永远判定“卡片已变化”，从而反复 `replaceChildren()` 整张 `<details>`。
- Host 侧 iframe SDK 对 DOM 尺寸使用 `ResizeObserver`；即使最终测量高度相同，连续销毁/重建卡片节点仍会触发布局、尺寸探测和浏览器滚动锚定，产生肉眼可见的上下抖动。`Turn Lease` 本身只是内部防并发诊断信息，并不代表用户进度。
- dev34 保留权威任务状态里的 lease，但把该高频字段移出可见结构。任务 ID、状态、工作区、模式、里程碑进度、续轮次数、总时限、Owner 锁和真实等待原因仍正常显示；只有这些用户可见语义发生变化时才更新卡片 DOM。
- 浏览器回归新增 volatile-only 刷新：连续改变 `turnLeaseExpiresAt`、`lastActivityAt`、`lastUiHeartbeatAt`、`updatedAt` 时，要求同一 `<details>` DOM identity 保持不变、折叠选择保持不变，并且集成 SDK 不产生 Host iframe 高度振荡。该 UI 修复不把 lease 到期升级为续轮授权。

### 16. sender claim 与 startup ACK 恢复窗口对齐实际 Host 时序

- DrugCrop 与当前会话的权威 generation 记录表明，15 秒 sender claim lease 可能短于 coordinator 自身的完整发送前路径：有界 MCP transport retry、advisory `updateModelContext` 和最终 `authorize-delivery` 尚未结束时，generation 就可能被 supervisor 判为 `sender-claim-expired`。dev35 将 claim lease 提高到 45 秒，使合法 sender 能覆盖完整发送前重试 envelope；这不是模型 turn budget，人工 takeover 仍可立即撤销旧 synthetic 权限。
- 对已经得到 Host 接受、但真实 resumed model 尚未通过首个 `continuation_task status` ACK 的 `DELIVERED` generation，恢复仍严格复用同一 generation 与同一 delivery token，不制造新 generation/新卡。首轮 startup ACK 健康窗口由 60 秒调整到 45 秒，后续退避上限由 120 秒调整到 60 秒，减少 transport/startup 层自身造成的多分钟等待。
- `DELIVERING` 的回调结果如果不确定，仍然不能靠 timer 重发，因为 Host 可能已经收到消息；静默、25 秒 activity lease 与 `SUSPECTED_STALL` 也继续只是诊断信号，不能成为续轮授权。合法自动续轮触发保持不变：当前轮存在已验证 Host 截断，或模型对精确当前 turn lease 签署 `turn-complete`。
- hidden sender protocol epoch 升到 5，使升级前仍驻留内存的旧 iframe 无法按旧 60/120 秒语义继续发送。architecture/guard 回归同步锁定 45 秒 claim、45/60 秒 startup ACK 以及 same-generation/token 恢复语义。

## 回归覆盖

1. `test-remote-agent-ssh-rescue.mjs` 断言显式更新读取 `_fullAccess.Checked` 与 `_roots.Lines`，Full Access 时 roots 归零，并且 existing Agent 仍传入原 `agentId` repair enrollment。
2. 同一测试锁定 Full Access 的 `${XDG_STATE_HOME:-$HOME/.local/state}` fallback，并明确禁止恢复旧的 `/home/ubuntu/workspace` 硬编码表达式。
3. 同一测试锁定 install root 改变时旧 state 的安全停止逻辑，同时确认后台 `silent` recovery 仍读取 persisted Agent 配置。
4. `test-native-ui-resilience.mjs`、`test-linux-agent-contract.mjs`、`test-remote-workspace-backend.mjs` 与 `verify-source-tree.mjs` 继续作为 UI 生命周期、Linux Agent 权限契约、后端 repair enrollment 和版本身份门禁。
5. `test-continuation-guard.mjs` 新增 READY-after-bind 模拟：初次 sender bind 没有 READY，后续 supervisor status 才出现 READY，必须在下一次 refresh 原子 claim 且只发送一次；同时锁定首条 visible synthetic message 的“actual user-role work request / 首轮必须实质工作”语义。
6. `test-continuation-architecture.mjs` 继续覆盖 generation ownership、manual takeover、card/workset singleton，并新增 fail-closed 静默/历史 cutoff 验证：真实模型 DevSpace 请求结束后，即使长期静默或超过旧 confirmed cutoff，也只能停在 `SUSPECTED_STALL`；只有显式当前-turn Host end 证据才能生成 READY。
7. `test-updater-apply-recovery.mjs` 覆盖无关 Portable-root executable 在文件事务前阻断更新，并要求 stderr/stdout 保留具体 PID/文件路径和 `No program files were changed` 诊断。
8. `test-continuation-guard.mjs` 额外锁定 synthetic owner lease 不能单独重发、`DELIVERING/unknown` 仍不可 timer retry，以及 synthetic 只能通过显式当前-turn Host-end/lifecycle gate 进入下一轮；固定 quiet threshold 和 historical-cutoff 无信号 gate 都不得重新出现。
9. `test-continuation-architecture.mjs` / `test-continuation-guard.mjs` 同时锁定 model request in-flight 登记顺序、纯静默只能产生 `SUSPECTED_STALL`、以及对 pre-upgrade weak READY/CLAIMED 的兼容撤销逻辑。
10. canonical-repair retention 专项回归锁定严格文件名匹配、最近 3 份 / 512 MiB 双上限，并验证主库、WAL/SHM 与非目标 SQLite 文件不会被删除。
11. `test-process-registry-retention.mjs` 验证活动/过渡状态永不清理，终态历史受到 5000 条 + 30 天双重约束。
12. `test-continuation-guard.mjs` 新增 checkpoint 终态卫生覆盖：具备 durable evidence 且最后 milestone 完成时必须原子 `SUCCEEDED` 并清除 synthetic ownership；缺失 evidence 时必须继续 RUNNING。
13. `test-continuation-guard.mjs` 进一步锁定普通 DevSpace 工具结果的 `devspace-pre-final-barrier-v1`：短 barrier 必须排在原始工具内容之前、结构化输出必须携带同一 barrier，且 incomplete stage 的合法可见结束必须指向 `turn-complete`，不能退化为普通 checkpoint/静默承诺。
14. `test-card-disclosure-browser.mjs` 在真实浏览器 DOM 中验证 superseded 历史卡保持非零可见高度、冻结原目标和里程碑、不接受新 generation 覆盖，并继续维持折叠选择与 iframe 尺寸稳定；`test-continuation-guard.mjs` 同时禁止恢复 `document.body.replaceChildren()` 清空路径。
15. 正式发行仍要求 D 盘 live 同步、真实 ChatGPT Host E2E，以及真实 Remote Agent 的 Scoped / Full Access 更新验收。

Protocol 继续为 1.5。
