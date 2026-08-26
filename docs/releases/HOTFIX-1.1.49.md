# DevSpace Portable 1.1.49

1.1.49 是一次针对真实 ChatGPT Host 行为的 continuation 与公网 tunnel 稳定性修复。它撤回 1.1.48 中过于积极的自动续轮策略，改为“宁可在无法证明截断时等待用户继续，也不提前终止仍在工作的 assistant turn”；同时修复 Windows/DNS 短暂异常被公网健康监督放大为主动重启 ngrok 的问题。

## 自动续轮严格收敛为两类授权场景

显式 `continuation_anchor` 默认使用 `continuationMode="timeout-recovery"`。普通长任务只有在 Host 明确报告 `timeout/deadline/budget`、required milestones 尚未完成时才允许自动 follow-up。以下情况不再是自动续轮证据：

- 普通 `resource teardown`；
- model/MCP 静默；
- learned Host budget 到点；
- 普通 `exec_command` 或 persistent process 结束；
- tunnel/MCP 网络断开本身。

Host budget 仍保留用于遥测和 UI 参考，但不再作为 proactive watchdog。原先的通用 model-idle watchdog、silent-truncation heuristic 和普通 teardown 自动恢复均已删除。

如果用户明确要求训练监控、持续观察等跨阶段常驻任务，可以使用 `continuationMode="resident"`。只有 resident task 才允许显式 `watch-process` 或 `stage-complete` 产生下一轮；非 resident task 调用这些 wake API 会返回 `resident-mode-required`。这把“模型正常完成当前监控阶段后继续下一轮”的需求与普通长任务彻底分开。

Migration 19 会把开发阶段曾使用的 `explicit-long` 保守迁移为 `timeout-recovery`，并清理旧的 process-wake pending，防止升级后继承过宽触发条件。

## 真实 turn 上限：只做截断后的判定，不做提前计时

标准 MCP Apps SDK 的 `ui/resource-teardown` 不携带 teardown reason，HostContext 也没有标准 assistant-turn deadline 字段。因此 1.1.49 新增可选的“确认 turn 上限”记录：只有用户或 Owner 明确观察到真实 Host 截断时间时，才通过 `confirm-turn-limit` 持久保存该 lower bound。

确认值**不会启动 proactive timer**。只有在 resource teardown 已实际发生、当前 turn elapsed 已达到确认上限并越过安全 grace 后，普通 teardown 才可以被解释为真实时长截断。低于确认上限的 teardown 继续 fail closed。Host 若明确发送 timeout，则仍以 Host timeout 为权威信号并更新遥测样本。

## 自动续轮后必须继续真实工作，而不是只 ACK

真实验收发现，旧续轮提示可能导致新 assistant turn 只执行 `status` ACK、输出一段“当前任务仍在运行”的状态说明，然后几十秒内结束。1.1.49 为恢复协议增加机器可读字段：

- `continueRequired`：当前 task 是否仍要求本轮继续实际工作；
- `nextRequiredMilestones`：尚未完成的 required milestones；
- `reanchorRequired`：当前 assistant turn 是否需要重新挂载同一个 Workspace App supervisor。

当 `continueRequired=true` 时，ACK/re-anchor 不算任务进展；本轮应继续调用实际 DevSpace 工具并推进至少一个未完成 milestone，除非确有外部阻塞条件。

## stale supervisor 只在同一轮自愈

另一个真实故障是：ChatGPT UI 仍显示“续轮锚点已就绪”，但对应 iframe/supervisor 已经停止 heartbeat。这样即使最终真正到达 Host 上限，也没有活着的 `app.sendMessage()` sender。

1.1.49 会在 model-side `status` 以及后续普通 DevSpace 工具活动中检测 stale supervisor。约 45 秒没有 coordinator heartbeat 时，只要求当前 assistant turn 用相同 `taskId/workspaceId` 再调用 `continuation_anchor`。这是同轮 maintenance，不调用 `app.sendMessage()`、不创建新对话，也不允许因为 supervisor stale 本身触发续轮。

## Owner 控制：多选、批量操作与真正暂停

原生“续轮任务 / CONTINUATION”页升级为完整的 Owner 管理面板：

- Ctrl/Shift 多选；
- 批量暂停、恢复；
- 批量锁定、解锁；
- 批量手动结束；
- 批量删除任务记录；
- 新增“下一轮”状态列。

`PAUSED_BY_USER` 是持久状态。暂停会清除 pending continuation，但保留任务、里程碑和 resident process watch；Workspace App、claim、arm-wake 和模型侧 resume 都不能绕过 Owner pause。只有本机 Owner 恢复操作会重新进入 `RUNNING`。

`timeout-recovery` 的“下一轮”只显示确认/参考时间；到参考时间后显示“等待截断”，不会自己续轮。`resident` 显示“等待阶段”或“等待进程”。

## 公网 tunnel：自检失败不等于 tunnel failure

1.1.48 的公网健康监督会在连续公网 `/mcp` 自检失败后主动结束 owned ngrok child。真实 Windows 现场证明 DNS、连接、TLS 或公网 hairpin 的短暂异常会让本机 curl 失败，而 ngrok 自身 control session 仍可能可以恢复；主动 kill 会把短暂网络抖动放大为更明显的 MCP 断线。

1.1.49 现在：

- 保存 curl exit code；
- 区分 DNS、connect、timeout、TLS 和其它 curl 错误；
- 公网自检失败本身不再足以重启 ngrok；
- 只探测当前 supervisor 自己拥有的 ngrok Agent API；
- 只有 owned Agent API 可达、并连续三次确认“预期 public tunnel 不存在”时才允许重启 owned child；
- 重启 cooldown 提升到 5 分钟。

Agent API 不可达、Agent 仍报告 matching tunnel、普通 DNS 失败或公网路径抖动都会保持 child 不动，让 ngrok 自身先尝试重连。

## Workspace App 与操作记录

`show_changes` 的 operation history 改为可折叠 `<details>`：成功操作默认收起，失败操作默认展开；折叠只影响展示，完整明细仍保留在 DOM。Continuation 卡片继续显示 task mode、Owner 状态和 milestones。

## 回归与兼容性

1.1.49 新增/更新回归覆盖：

- `timeout-recovery` 普通 teardown / silence / learned budget / 普通 process completion 均不得 follow-up；
- 明确 Host timeout 且 milestones 未完成才允许 timeout recovery；
- confirmed turn limit 之前 teardown 必须拒绝，达到确认上限且 teardown 后才允许恢复；
- `resident` 才允许 process completion / `stage-complete` wake；
- 非 resident process/stage wake 必须拒绝；
- 自动续轮 `status` ACK 必须返回必要的 `continueRequired` / `nextRequiredMilestones`；
- stale supervisor 只产生同轮 re-anchor advisory；
- Owner pause 阻止自动 claim/wake/resume；
- native UI 多选、批量控制和“下一轮”状态；
- tunnel curl 错误分类、owned-agent mismatch recovery gate 与 5 分钟 cooldown；
- 完整 source/Portable regression 与 production dependency audit。

Portable Protocol 仍为 **1.5**。Linux Remote Agent wire protocol、Landlock runtime compatibility 和 scoped/full-access 权限模型没有变化，已登记远端 Agent 不需要重新注册。
