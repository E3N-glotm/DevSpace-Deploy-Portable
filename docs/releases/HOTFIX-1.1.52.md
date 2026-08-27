# DevSpace Portable 1.1.52

1.1.52 修复的是 1.1.51 发布前真实会话验收暴露出的最后一类 continuation 断点：Workspace App 已经成功 `app.sendMessage()`，ChatGPT 也确实进入了新的 synthetic assistant turn，但新轮只执行第一条 `continuation_task status`，随后约 32 秒便输出 Task Contract 状态摘要并结束。此时任务仍为 `RUNNING`、`continueRequired=true`、`finalResponseAllowed=false`，required milestones 也没有完成。

这说明“能创建下一轮”和“下一轮一定继续实际工作”是两个不同问题。MCP/Apps SDK 没有 Host 级接口可以硬阻止 ChatGPT 输出 final response；`finalResponseAllowed=false` 本质上仍是模型可读的 Task Contract 指令。因此 1.1.52 不再继续堆叠提示词，而把恢复后的实际工作义务写入持久状态机。

## 根因

1.1.51 的 delivery 流程已经能安全处理 connector readiness：

1. `app.sendMessage()` 创建 synthetic continuation；
2. delivery generation/token 持久化；
3. 新模型轮以相同 token 调 `continuation_task status`；
4. status ACK 清除 readiness retry，并把 delivery owner 置为 `synthetic-active`。

问题出在第 4 步之后。旧实现把“status 已 ACK”视为 delivery 恢复完成，却没有另一个持久条件要求当前 generation 必须发生实际 DevSpace 工作。若模型把 status 结果理解为“恢复状态已经确认”，它仍可能直接结束当前 assistant turn。

## Synthetic resumed-turn substantive-work obligation

1.1.52 将连接 ACK 和工作履约拆开：

- synthetic token 的第一次正确 `status` 仍完成 MCP readiness ACK，但任务继续保持 `deliveryOwner=synthetic-active`；
- 对外状态新增 `syntheticResumeWorkRequired=true`，明确表示该 resumed generation 尚未执行实际工作；
- continuation 自身的 `status/heartbeat/checkpoint` 等控制流不计作这一义务的 substantive work；
- 第一次真正的非 continuation 控制类 DevSpace 操作会原子地：
  - 把当前 token 移入 superseded token；
  - 清除 active delivery token；
  - 将 owner 变为 `synthetic-worked`；
  - 清除 synthetic work obligation；
  - 正常刷新 completion-driven Turn Lease。

因此，读文件、执行命令、编辑、进程操作等实际工作可以证明续轮已经真正恢复；单纯 ACK、re-anchor 或进度摘要不能。

## Status-only 短轮的自动恢复

如果 synthetic turn 已经 status ACK，但一直没有 substantive DevSpace work，1.1.52 不引入新的固定秒数 watchdog，而复用 completion-driven 已有的 Turn Lease：

- Turn Lease 未到期时，禁止再创建第二个 synthetic generation；
- Lease 到期、任务仍 `RUNNING`、required milestones 仍未完成、owner 仍为 `synthetic-active` 时，Workspace App 才把它识别为“已授权 synthetic resume obligation 未履行”；
- 该恢复创建新的 delivery generation/token，而不是复用旧 token；
- 旧 generation 因 token supersession 失效，防止迟到的 status-only turn 与新轮同时持有恢复所有权。

这条路径不依赖截图中的 32 秒，也不依赖此前观察到的 25m52 Host cutoff。未来 ChatGPT 调整 turn 限制时仍然使用同一状态机。

## 为什么不使用普通 teardown 立即续轮

Apps SDK 的 iframe/resource teardown 可能来自卡片刷新、UI 回收或资源重建，不能可靠证明模型已经结束。1.1.52 因此继续保持 1.1.51 的 fail-closed 原则：

- 普通 resource teardown 不会因为 `synthetic-active` 就立刻新开 assistant turn；
- 明确 `timeout/deadline/budget`、confirmed cutoff、已 corroborate 的 completion stall 仍按原规则处理；
- resident 模式的显式 stage/process wake 仍独立处理。

这样避免为了修复“短轮停住”而重新制造重复/并行 continuation。

## Synthetic continuation 文本收敛

原来的 synthetic message 同时解释 Task Contract、Host cutoff、readiness race、teardown、re-anchor 等大量恢复协议。真实截图表明，过长的协议文本会让模型更容易把新轮理解成“检查恢复状态”。

1.1.52 将 synthetic message 改为 action-first：

1. 第一项业务动作必须是同 task/workspace 的 `continuation_task status`；
2. connector 暂态错误只对同一个 status 做约 30 秒有界 readiness retry；
3. status 成功后，只要 `continueRequired=true` 或 `finalResponseAllowed=false`，立即调用实际 DevSpace 工具执行 remaining milestones；
4. 当前轮必须完成至少一次 substantive DevSpace work、进入真实 `WAITING_EXTERNAL`，或验证任务完成并 `complete`；
5. re-anchor 只是恢复协议，不是任务进展。

## 回归覆盖

`setup/test-continuation-guard.mjs` 新增并验证：

- `syntheticResumeRequiresSubstantiveWork`；
- `syntheticStatusOnlyTurnRecovery`；
- status ACK 后 obligation 仍保持；
- Turn Lease 到期前 status-only recovery 被拒绝；
- Lease 到期后产生新的 generation/token；
- 第一次 substantive DevSpace work 清除 obligation；
- 已履约 generation 的旧 token 再到达时返回 `synthetic-continuation-superseded`；
- 普通 teardown 继续 fail-closed。

`setup/test-core-memory-bounds.mjs` 同时验证 MCP reconnect grace、in-flight session protection、registry hard bound、persistent process output 等既有鲁棒性没有回归。

Protocol 保持 1.5；Linux Remote Agent wire protocol 与权限模型没有变化。
