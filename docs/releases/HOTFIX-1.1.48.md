# DevSpace Portable 1.1.48

1.1.48 当前源码同时收口三类真实运行问题：公网 DNS/路径短暂波动被健康监督误判成 tunnel failure 后主动杀 ngrok；continuation 把普通空闲、正常 teardown 或普通进程结束当成必须续轮；以及 Workspace App 长操作记录/偶发 `Waiting for a tool result.` 的可用性问题。

## Continuation 改为“截断或显式长任务”触发

原始目标不是“只要调用了 MCP 就一直续”，而是两种明确场景：Host 单轮时间上限真正截断了未完成工作；或者任务本身明确要求一个长进程跨 assistant turn 持续运行。因此当前实现不再把普通工具活动当作隐式 long-task intent。

`exec_command` 即使返回仍在运行的 persistent process，也**不会自动**写入 continuation watch。只有确认该进程确实需要跨轮等待时，才显式调用 `continuation_task(action="watch-process")`；这使普通测试、诊断和构建进程结束不会平白制造新一轮。显式 process watch 的既有 durable wake / takeover / delivery-ACK 机制保持不变。

Migration 18 为 continuation task 增加 `continuation_mode`。兼容/`begin-auto` task 保持 `compat`，显式 `continuation_anchor`/`begin` 会创建或升级为 `explicit-long`。普通兼容任务的 `resource teardown` 和 model/MCP inactivity 都不触发 follow-up；proactive learned-budget watchdog 仍要求未完成 milestone 且至少存在一个真实 Host timeout sample。

显式长任务增加两层只对它生效的截断保护。第一层：即使 Host 只发普通 `resource teardown` 而没有标注 timeout，只要 required milestones 仍未完成，就允许一次续轮。第二层：真实 ChatGPT Host 有时既不发 timeout 也不发 teardown；这种情况下，只有 `explicit-long + RUNNING + required milestones 未完成 + 没有活动显式 process watch` 同时成立，并且模型侧连续约 3 分钟没有新的 DevSpace activity，才触发 `explicit long-task silent truncation guard`。这比旧的通用 60 秒 idle watchdog 更保守，也不会作用于普通任务。

主动 follow-up 与 process-wake follow-up 仍必须等待新 assistant turn 首次 `continuation_task status` ACK 后才退役 delivery lease；如果 Host 接受消息但新轮没有真正连回 DevSpace，ACK lease 到期后 surviving Workspace App 可以重试。ACK 现在还返回 `reanchorRequired`：显式长任务仍未完成时，续轮文本要求第二步用相同 `taskId/workspaceId` 再调用 `continuation_anchor`，重新挂载**当前 assistant turn** 的 supervisor。这样不会依赖上一轮可能已被 Host 回收/虚拟化的 iframe。

同一个 `reanchorRequired` 也用于手工恢复路径。model-side `status` 发现 `explicit-long + RUNNING + required milestones 未完成`，但最近约 45 秒没有 Workspace App coordinator heartbeat 时，会直接要求当前 turn re-anchor。这样即使自动 follow-up 本身没有发生、用户稍后手工发送“继续”，也能恢复同一 task 的 supervisor，而不是继续依赖已经失活的旧 iframe。

## 公网健康监督：自检失败不等于 tunnel failure

公网 `/mcp` 探测现在保留 curl exit code，并把失败区分为 DNS、connect、timeout、TLS 或其它 curl 错误；这些信息写入 `tunnel-network.json`，不再统一折叠成 `status 0`。

更关键的是，连续三次公网 probe 失败只增加诊断计数，**不是** kill ngrok 的充分条件。ngrok provider 还必须满足：当前 supervisor 自己拥有的 ngrok Agent API 可达，并连续三次确认预期 public URL 的 tunnel 已经不存在。Agent API 不可达、Agent 仍报告 matching tunnel、DNS 暂时失败或公网 hairpin 路径抖动，都保持 child 不动，交给 ngrok 自身 control session 重连。真正满足 owned-agent mismatch 后也受 5 分钟 restart cooldown 限制。

## Owner Continuation 控制中心

Windows 原生控制中心新增“续轮任务 / CONTINUATION”一级页面，位置在“插件管理”和“会话与回退”之间。它直接读取同一 SQLite continuation task 状态，展示：

- task ID、目标和当前状态；
- required/completed milestones；
- continuation count / budget；
- 最近活动、最后 Host signal、waiting reason；
- continuation pending / durable wake / delivery ACK；
- Owner 锁。

本机 Owner 可以对列表执行 Ctrl/Shift 多选，并批量暂停、恢复、锁定、解锁、手动结束和删除。Migration 16 持久保存 Owner lock；新的 `PAUSED_BY_USER` 直接复用 task state 字段，不需要新 schema。暂停会清除 pending continuation 但保留 task/process watch，Coordinator、claim、arm-wake 和模型侧 resume 都不能绕过 Owner pause。

列表新增“下一轮”倒计时。已存在真实 timeout sample 时显示“预算”倒计时；尚未学习 Host budget、但 task 是 `explicit-long` 时显示“静默”兜底倒计时（基于 `lastModelActivityAt + 3 min`）。显式 process watch 活跃时显示“等待进程”；暂停、等待、终态或已完成 milestones 不显示虚假倒计时。

## 修复 `Waiting for a tool result.` 空卡竞态

MCP App iframe 的 HTML/模块加载与 ChatGPT Host 的一次性 `ui/notifications/tool-result` 没有保证严格先后关系。旧实现直到 runtime enhancement module 完成后才注册 message listener；如果 Host 更早发送初始 initialize/tool-input/tool-result，结果不会再次发送，UI 就永久停留在最初占位文本。

1.1.48 在 Workspace App bootstrap 最早阶段安装同步 message buffer，暂存模块 listener 就绪前收到的 Host JSON-RPC 消息。所有正式 listener 注册完成后按原顺序 replay；bootstrap 窗口内对原消息使用 `stopImmediatePropagation()`，避免“原消息处理一次 + replay 再处理一次”的重复事件。该机制同时覆盖 continuation card 和 `show_changes` 聚合卡片。

## 聚合工具卡片与 Continuation 专属卡片

Portable 默认仍为 `DEVSPACE_WIDGETS=changes`。普通 read/run/write/edit/process 调用保持 headless，避免 ChatGPT 为几十个内部操作各创建一张 MCP App 卡；修改完成后只调用一次 `show_changes`。其中 operation history 改为 `<details>` 折叠区：成功记录默认收起，失败记录默认展开，隐藏内容仍完整保留在 DOM 中。`DEVSPACE_WIDGETS=full` 仅保留兼容模式。

`continuation_anchor` 是另一个明确需要 UI 的入口。1.1.48 为它增加专属聚合卡片，持续更新同一个 task 的 state、objective、Owner lock、milestones、continuation count、waiting/wake/ACK，而内部 status/checkpoint/heartbeat 继续保持 headless。

## 回归与兼容性

新增/扩展回归覆盖：

- compat task 的正常 teardown / model inactivity 不得产生 follow-up；
- explicit-long task 的普通 teardown 在 milestones 未完成时允许恢复；
- explicit-long task 在无 timeout/teardown 的持续静默后必须能恢复，而 compat task 同样静默不得续轮；
- resumed model `status` ACK 必须在显式长任务未完成时返回 `reanchorRequired=true`；
- `exec_command` 不得自动把每个 persistent process 变成 continuation wake；
- 显式 `watch-process` 的 process completion wake 继续可靠工作；
- `PAUSED_BY_USER` 必须阻止 claim、arm-wake、模型 resume 和 coordinator 自动续轮；
- native 任务列表多选、批量 pause/resume/lock/unlock/stop/delete 与 learned-budget / silent-fallback 双模式倒计时；
- curl DNS/connect/timeout/TLS 分类、owned ngrok Agent mismatch recovery gate 和 5 分钟 cooldown；
- proactive follow-up 与 process-wake follow-up 都必须完成 resume ACK 才能清除 delivery lease；
- Owner lock 阻止模型终止，Owner stop 仍可结束；
- early Host tool-result buffer/replay；
- continuation task card 与可折叠 aggregated operation history；
- 既有 resume-ACK durable wake、process completion wake、WAITING_SUPERVISOR handshake、delivery ACK lease 和 tunnel recovery 回归继续保留。

Protocol 仍为 1.5。1.1.48 没有改变 Linux Remote Agent wire protocol、Landlock runtime compatibility 或 scoped/full-access 权限语义，因此远端 Agent 不需要因为本次 Portable UI/Continuation 更新重新注册。
