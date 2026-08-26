# DevSpace Portable 1.1.48

1.1.48 收口两个在真实 ChatGPT Host 中才能稳定复现的问题：一是持久 continuation task 明明仍为 `RUNNING`，上一轮回复也说明任务尚未完成，但正常结束的 assistant turn 没有产生下一轮；二是 Workspace App 偶发只显示 `Waiting for a tool result.`，同一套代码在不同会话、甚至同一天不同时间表现不一致。

## Continuation 不再依赖模型记住额外的 watch/wait

1.1.47 的完整链路已经能处理 `watch-process -> WAITING_EXTERNAL -> process complete -> durable wake -> claim -> app.sendMessage -> resume ACK`，但仍有一个人为依赖：模型启动长进程后必须显式再调用 `continuation_task(action="watch-process")`，并在需要结束当前 turn 时正确进入等待。如果模型只是启动了测试、在文字里写“后续会继续”，然后正常结束 turn，服务端 task 会继续保持 `RUNNING`，但 `watchProcessHandles=[]`、`continuationPending=false`、`continuationWakePending=false`；正常结束又不会产生 timeout sample，因此 Coordinator 没有任何合法触发源可以凭文字承诺创建下一轮。

1.1.48 将这条依赖移到服务端。`exec_command` 返回仍在运行的 durable process 时，如果当前 conversation/workspace 已存在 active continuation，服务端自动把其 `processHandle` 加入该 task 的 watch 列表。模型仍可显式使用 `watch-process` 管理特殊流程，但不再需要靠模型每次记住它才能保证基本可靠性。

同时，Workspace App 的 `onTeardown` 不再只在 timeout/deadline/budget 或学习预算达到阈值时恢复。若 task 仍为 `RUNNING` 且 required milestones 尚有未完成项，正常 resource teardown 也会通过正式 Apps SDK `app.sendMessage()` 请求续轮。`WAITING_EXTERNAL`、`WAITING_SUPERVISOR`、terminal task 和已完成全部 required milestones 的任务不会因此被无条件续轮。

真实 ChatGPT Web 验收进一步发现，Host 强制截断并不保证发送 `resource teardown` 或 `toolcancelled(timeout)`。因此 1.1.48 最终版又增加独立于 Host 生命周期回调的 **model-activity idle watchdog**：服务端对同一 conversation/workspace 的模型发起 DevSpace 工具调用维护 `lastModelActivityAt`，而 Workspace App 自己的 status/heartbeat 不会刷新该时钟。任务仍为 `RUNNING`、required milestones 未完成、没有仍在运行的 watched process 且模型侧约 60 秒没有继续推进时，Coordinator 会主动走 `claim -> app.sendMessage -> resume ACK`。这不是猜测 ChatGPT 的固定分钟上限；Host 即使以后改变截断时间或完全不发 teardown，静默任务仍可恢复。长时间 durable process 继续由 process watch 独立接管，因此 idle watchdog 不会抢占正在执行的测试/构建。

主动 watchdog 产生的 follow-up 与 process-wake follow-up 现在都必须等待新 assistant turn 首次 `continuation_task status` ACK 后才退役 delivery lease；如果 Host 接受了消息但新轮没有真正连回 DevSpace，60 秒 ACK lease 到期后 surviving Workspace App 会再次尝试送达。ACK 成功时会重置 turn clock，避免达到阈值后重复续轮。

这仍然不是一个写死的 25 分钟定时器。`continuation_anchor` 只需在非平凡多步任务开始时挂载一次；之后 process completion、Host lifecycle、durable wake 和学习到的 turn budget 共同提供触发源。

## Owner Continuation 控制中心

Windows 原生控制中心新增“续轮任务 / CONTINUATION”一级页面，位置在“插件管理”和“会话与回退”之间。它直接读取同一 SQLite continuation task 状态，展示：

- task ID、目标和当前状态；
- required/completed milestones；
- continuation count / budget；
- 最近活动、最后 Host signal、waiting reason；
- continuation pending / durable wake / delivery ACK；
- Owner 锁。

本机 Owner 可以锁定/解锁、手动结束和恢复任务。Migration 16 持久保存 Owner lock。锁定 task 后，模型侧 `complete`、`cancel`、terminal failure，以及 no-progress、same-failure、continuation-count 和 wall-clock 自动终止都不能把它结束；本机 Owner 的手动 stop 不受锁限制，保证用户始终拥有最终终止权。

## 修复 `Waiting for a tool result.` 空卡竞态

MCP App iframe 的 HTML/模块加载与 ChatGPT Host 的一次性 `ui/notifications/tool-result` 没有保证严格先后关系。旧实现直到 runtime enhancement module 完成后才注册 message listener；如果 Host 更早发送初始 initialize/tool-input/tool-result，结果不会再次发送，UI 就永久停留在最初占位文本。

1.1.48 在 Workspace App bootstrap 最早阶段安装同步 message buffer，暂存模块 listener 就绪前收到的 Host JSON-RPC 消息。所有正式 listener 注册完成后按原顺序 replay；bootstrap 窗口内对原消息使用 `stopImmediatePropagation()`，避免“原消息处理一次 + replay 再处理一次”的重复事件。该机制同时覆盖 continuation card 和 `show_changes` 聚合卡片。

## 聚合工具卡片与 Continuation 专属卡片

Portable 默认仍为 `DEVSPACE_WIDGETS=changes`。普通 read/run/write/edit/process 调用保持 headless，避免 ChatGPT 为几十个内部操作各创建一张 MCP App 卡；修改完成后只调用一次 `show_changes`，在一张可展开卡片内查看 operation timeline、文件统计、diff 和预览。`DEVSPACE_WIDGETS=full` 仅保留兼容模式。

`continuation_anchor` 是另一个明确需要 UI 的入口。1.1.48 为它增加专属聚合卡片，持续更新同一个 task 的 state、objective、Owner lock、milestones、continuation count、waiting/wake/ACK，而内部 status/checkpoint/heartbeat 继续保持 headless。

## 回归与兼容性

新增/扩展回归覆盖：

- 正常 teardown + 未完成 required milestone 必须产生一次 follow-up；
- 正常 teardown + required milestones 全部完成不得产生 follow-up；
- 无 teardown/timeout 的模型静默仍必须由 model-activity idle watchdog 续轮；
- 正在运行的 watched process 必须抑制 model-idle 抢跑；
- proactive follow-up 与 process-wake follow-up 都必须完成 resume ACK 才能清除 delivery lease；
- durable `exec_command` 自动绑定当前 conversation/workspace continuation watch；
- Owner lock 阻止模型终止，Owner stop 仍可结束；
- early Host tool-result buffer/replay；
- continuation task card 与默认 aggregated operation card；
- 既有 resume-ACK durable wake、process completion wake、WAITING_SUPERVISOR handshake、delivery ACK lease 和 tunnel recovery 回归继续保留。

Protocol 仍为 1.5。1.1.48 没有改变 Linux Remote Agent wire protocol、Landlock runtime compatibility 或 scoped/full-access 权限语义，因此远端 Agent 不需要因为本次 Portable UI/Continuation 更新重新注册。
