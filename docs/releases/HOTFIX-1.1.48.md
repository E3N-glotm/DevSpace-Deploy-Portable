# DevSpace Portable 1.1.48

1.1.48 当前源码同时收口三类真实运行问题：公网 DNS/路径短暂波动被健康监督误判成 tunnel failure 后主动杀 ngrok；continuation 把普通空闲、正常 teardown 或普通进程结束当成必须续轮；以及 Workspace App 长操作记录/偶发 `Waiting for a tool result.` 的可用性问题。

## Continuation 收敛为严格双模式

原始目标不是“只要调用了 MCP 就一直续”，而是只有两种自动开启下一轮的场景：第一，Host 单轮时间上限**已经实际截断**未完成工作；第二，用户明确要求常驻/监控任务，并授权当前阶段结束后进入下一轮。当前实现因此改为 fail-closed：无法证明已经截断时，宁可等待用户手工继续，也不提前打断仍在运行的 assistant turn。

`exec_command` 即使返回仍在运行的 persistent process，也**不会自动**写入 continuation watch。普通测试、诊断和构建进程结束不会平白制造新一轮。只有用户明确要求常驻/监控行为并把 task 建为 `continuationMode="resident"` 后，才允许显式调用 `continuation_task(action="watch-process")`；resident 还可以在模型完成当前监控阶段后调用 `stage-complete`，明确请求下一轮继续监控。

Migration 18 为 continuation task 增加 `continuation_mode`；Migration 19 将模式进一步规范为 `compat`、`timeout-recovery`、`resident`。兼容/`begin-auto` task 保持 `compat`；显式 `continuation_anchor` 默认创建或升级为 `timeout-recovery`。历史 `explicit-long` 会保守迁移为 `timeout-recovery`，并清理旧 process watch / wake pending，避免升级后延续过宽的自动触发语义。

`timeout-recovery` 只接受 Host 明确发出的 `timeout/deadline/budget` 作为自动续轮证据，同时要求 required milestones 尚未完成。普通 `resource teardown`、model/MCP 静默、MCP/tunnel 网络断开、learned Host budget 到点和普通 process completion 都**不会**触发 follow-up。Host budget 仍保留为诊断/UI 参考值，但不再用于 proactive continuation；原先的 silent-truncation heuristic 也已删除。

`resident` 是唯一允许“模型正常完成当前阶段后主动开下一轮”的模式。它同样接受真实 Host timeout，并额外允许两个显式 wake：受监控 durable process 完成，或模型调用 `stage-complete` 表示本阶段监控/检查已结束、应进入下一阶段。非 resident task 调用 `watch-process`、`arm-wake` 或 `stage-complete` 会被 runtime 以 `resident-mode-required` 拒绝。

合法 follow-up 仍必须等待新 assistant turn 首次 `continuation_task status` ACK 后才退役 delivery lease；如果 Host 接受消息但新轮没有真正连回 DevSpace，ACK lease 到期后 surviving Workspace App 可以重试。ACK 还可返回 `reanchorRequired`：未完成的 `timeout-recovery`/`resident` task 会要求用相同 `taskId/workspaceId` 再调用 `continuation_anchor`，重新挂载**当前 assistant turn** 的 supervisor。

真实运行还暴露了一个独立故障：ChatGPT UI 仍显示“续轮锚点已就绪”，但该卡片对应的 iframe/supervisor 可能早已停止 heartbeat。此时即使最终真的到达 Host 时长上限，也没有活着的 `app.sendMessage()` 发送器。因此当前源码增加**同轮 stale-supervisor maintenance**：model-side `status` 仍会在约 45 秒无 coordinator heartbeat 时返回 `reanchorRequired=true`；此外，当前 assistant turn 后续普通 DevSpace 工具调用也会检测 stale supervisor，并在工具结果中要求本轮用同一 task 调用 `continuation_anchor`。这个维护动作本身绝不调用 `app.sendMessage()`、绝不创建下一轮，只是在当前轮重新挂载发送器。

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

列表新增“下一轮”状态。`timeout-recovery` 已存在真实 timeout sample 时，只按已观测 Host turn 长度显示“参考 mm:ss”；参考时间到点后显示“等待截断”，强调它不是自动触发器。`resident` 显示“等待阶段”，存在显式 process watch 时显示“等待进程”；暂停、等待、终态或已完成 milestones 不显示虚假倒计时。

## 修复 `Waiting for a tool result.` 空卡竞态

MCP App iframe 的 HTML/模块加载与 ChatGPT Host 的一次性 `ui/notifications/tool-result` 没有保证严格先后关系。旧实现直到 runtime enhancement module 完成后才注册 message listener；如果 Host 更早发送初始 initialize/tool-input/tool-result，结果不会再次发送，UI 就永久停留在最初占位文本。

1.1.48 在 Workspace App bootstrap 最早阶段安装同步 message buffer，暂存模块 listener 就绪前收到的 Host JSON-RPC 消息。所有正式 listener 注册完成后按原顺序 replay；bootstrap 窗口内对原消息使用 `stopImmediatePropagation()`，避免“原消息处理一次 + replay 再处理一次”的重复事件。该机制同时覆盖 continuation card 和 `show_changes` 聚合卡片。

## 聚合工具卡片与 Continuation 专属卡片

Portable 默认仍为 `DEVSPACE_WIDGETS=changes`。普通 read/run/write/edit/process 调用保持 headless，避免 ChatGPT 为几十个内部操作各创建一张 MCP App 卡；修改完成后只调用一次 `show_changes`。其中 operation history 改为 `<details>` 折叠区：成功记录默认收起，失败记录默认展开，隐藏内容仍完整保留在 DOM 中。`DEVSPACE_WIDGETS=full` 仅保留兼容模式。

`continuation_anchor` 是另一个明确需要 UI 的入口。1.1.48 为它增加专属聚合卡片，持续更新同一个 task 的 state、objective、Owner lock、milestones、continuation count、waiting/wake/ACK，而内部 status/checkpoint/heartbeat 继续保持 headless。

## 回归与兼容性

新增/扩展回归覆盖：

- compat task 的正常 teardown / model inactivity 不得产生 follow-up；
- timeout-recovery task 的普通 teardown、持续静默和 learned budget 到点都不得产生 follow-up；
- timeout-recovery task 只有收到明确 Host timeout/deadline/budget 且 milestones 未完成时才允许 claim/sendMessage；
- resident task 才允许显式 process completion wake 与 `stage-complete` wake；
- 非 resident 的 `watch-process` / `arm-wake` / `stage-complete` 必须被拒绝；
- resumed model `status` ACK 必须在未完成的 timeout-recovery/resident task 上返回必要的 `reanchorRequired=true`；
- 当前 assistant turn 中普通 DevSpace 工具活动必须能发现 stale supervisor，并只要求同轮 re-anchor，不得因此调用 `sendMessage`；
- `exec_command` 不得自动把每个 persistent process 变成 continuation wake；
- resident 显式 `watch-process` 的 process completion wake 继续可靠工作；
- `PAUSED_BY_USER` 必须阻止 claim、arm-wake、模型 resume 和 coordinator 自动续轮；
- native 任务列表多选、批量 pause/resume/lock/unlock/stop/delete 与 timeout-recovery / resident 双模式状态；
- curl DNS/connect/timeout/TLS 分类、owned ngrok Agent mismatch recovery gate 和 5 分钟 cooldown；
- timeout-triggered follow-up 与 resident process/stage wake follow-up 都必须完成 resume ACK 才能清除 delivery lease；
- Owner lock 阻止模型终止，Owner stop 仍可结束；
- early Host tool-result buffer/replay；
- continuation task card 与可折叠 aggregated operation history；
- 既有 resume-ACK durable wake、resident process/stage wake、WAITING_SUPERVISOR handshake、delivery ACK lease 和 tunnel recovery 回归继续保留。

Protocol 仍为 1.5。1.1.48 没有改变 Linux Remote Agent wire protocol、Landlock runtime compatibility 或 scoped/full-access 权限语义，因此远端 Agent 不需要因为本次 Portable UI/Continuation 更新重新注册。
