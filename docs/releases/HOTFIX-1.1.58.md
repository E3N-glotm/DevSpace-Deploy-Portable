# DevSpace Portable 1.1.58 Hotfix

## 目标

1.1.58 修复 1.1.57 仍存在的自动续轮上下文 P0：续轮本身已经可以被 Host 拉起、也可以恢复工具，但新的 assistant turn 有时只看到一条泛化的“继续执行未完成的 DevSpace 任务”，不知道具体要继续哪一个任务、上一轮已经做到哪里。真实用户截图已经证明，这会让模型停下来解释“没有指定具体是哪一个 DevSpace 任务”，或者从同一 conversation 的其他历史任务中猜错目标。

这个问题不是模型不能思考，也不是 DevSpace 授权整体失效。根因是 MCP Apps 的两个 Host 通道语义不同：`app.updateModelContext()` 是隐藏上下文提示，但 ChatGPT Host 不保证它在被截断后的新 synthetic turn 中作为可靠的跨轮 transcript bridge 被完整重放；`app.sendMessage()` 创建的 user-role message 才是确定进入新轮次可见 conversation 的内容。1.1.57 虽然已经在 hidden context 中保存完整 Task Contract，却让真正的可见 synthetic message 只携带泛化 continuation intent，因此形成任务语义断层。

## 关键修复

### 1. Host-visible continuation 自带 durable task semantics

- `visibleContinuationTrigger(task)` 直接从当前权威 Task Contract 读取 `objective` 和 `nextUnresolvedMilestone(task)`。
- objective 与 milestone 会做空白折叠和长度上限，避免把整个 lifetime task 历史重复灌进 conversation；同时足以让新 assistant turn 知道“具体要做什么”和“下一步做到哪里”。
- 中文/英文 Host message 都不再依赖“上一条消息”才能解析 continuation intent。

### 2. 工具恢复与任务上下文恢复分开

- 可见 continuation message 明确要求第一步调用 `continuation_task status`，从 SQLite-backed Task Contract 恢复权威状态，而不是根据 transcript 猜测。
- 如果该 synthetic turn 没有直接暴露 `DevSpace_MCP` namespace，则先通过 Host connector/tool discovery 加载已授权 connector，再继续实际工具工作。
- 因此“本轮工具 schema 没预加载”仍是可恢复的 turn-scoped discovery 问题；它不再被误判为“用户没有告诉我要继续哪个任务”。

### 3. 保持 capability 隐私与单卡约束

- Host-visible message 只携带自然语言 objective、下一 milestone 和安全的工具名/恢复动作。
- taskId、workspaceId、delivery token、generation UUID/capability 继续只存在于 App/runtime transport，不写入用户聊天记录。
- conversation-lifetime 单 Task Contract / 单 verified milestone Card、generation CAS、manual takeover、terminal send barrier 均保持不变。

### 4. 发布清单在最终生成步骤后重新锁定

- `build-release.py` 在 native UI 等 release-time generator 全部结束后、开始 checksum/ZIP 之前，重新计算 `VERSION-MANIFEST.json` 里现有全部 key-file SHA-256。
- manifest 引用的关键文件若缺失则直接 fail closed；重新写入后立即再做一次 hash 验证，避免原生 EXE、重新打包的 core、installed core 或 lockfile 在 finalize 之后变化，却继续携带旧摘要进入发行包。
- 发布回归会对当前 key-file 集执行同一套最终刷新/核对；正式 ZIP 还需逐项验证 embedded manifest 与 ZIP 内实际 payload 0 missing / 0 mismatch 后才允许部署和发布。

## 回归覆盖

1. 模拟 Host 完全忽略 hidden `updateModelContext`，只检查 `app.sendMessage()` 的 user-role text；它必须仍包含 fake task 的 objective 与下一未完成 milestone。
2. 可见 message 必须同时包含 `continuation_task status` 和 `DevSpace_MCP` discovery recovery 路径，并继续禁止“继续处理中 / still working”之类 status-only final。
3. 可见 message 不得泄漏 fake taskId/workspaceId、token、UUID 或 generation capability。
4. `test-continuation-guard.mjs` 与 `test-continuation-architecture.mjs` 锁定 `visibleContinuationTrigger(state.task)` 位于最终 `authorize-delivery -> app.sendMessage` barrier 内。
5. 正式发布继续要求 source-tree/version identity、runtime cards、完整 `npm test`、D 盘 live 同步和 GitHub Release asset/hash 验证全部通过。
6. release builder 最终刷新全部 key-file digest，并验证 ZIP 内 `VERSION-MANIFEST.json` 与实际 payload 完全一致。

Protocol 继续为 1.5。
