# DevSpace Portable 1.1.57 Hotfix

## 目标

1.1.57 修复 1.1.56 在真实 ChatGPT 自动续轮中暴露的两个相互放大的 P0。**P0-A**：server 已经生成 `READY` generation，但旧 milestone iframe/sender transport 已失活时，READY 可能长期躺在 SQLite 中，直到某个 Workspace App 偶然重新获得 Host `app.sendMessage()` 能力；**P0-B**：synthetic continuation 已成功进入新 assistant turn、完成 status ACK 并执行过真实工具后，模型仍可能错误地以“继续处理中。”之类状态消息主动 final。旧 supervisor 又只恢复“完全没有 substantive work”的 generation，于是 `substantive_activity_count > substantive_baseline_count` 会让这一代永久失去 READY 重试路径，形成“自动继续 -> 做一点 -> 状态 final -> READY 无 sender -> 长时间不再继续”的循环。

同时，本版收紧普通 completion-driven stall recovery：已经从真实 Host 截断学习到更长 turn cutoff 时，短 activity lease 只能记录 suspicion，不能在该动态 cutoff 之前创建并行 synthetic turn。

## 关键修复

### 1. `WORK_REQUIRED` 即使已经做过一次真实工具工作也能恢复

- `continuationSupervisorSweep()` 现在显式读取 active synthetic owner 的 `delivery_owner_expires_at`。
- generation 处于 `TURN_ACKED` / `WORK_REQUIRED`、task 仍由 `synthetic-active` 持有、专属 work-owner lease 已过期、当前没有 model-originated DevSpace request in-flight，并且 Workset 仍有 PENDING milestone 时，视为“resumed turn 已被 Host/模型提前结束但任务未完成”。
- 旧 generation 原子关闭为 `NO_WORK`，failure reason 为 `synthetic-resume-work-lease-expired`，旧 delivery owner/token/ACK 状态被清理；同一个 Workset 随后只生成一代新的 READY continuation。
- 该恢复条件不再要求 `substantive_activity_count <= baseline`。因此真实故障中的 `77 -> 78` 不会因为“已经成功读过一次飞书文档”反而永远失去恢复资格。

### 2. READY 与 sender transport 解耦后立即完成最后一跳

- `continuation_sender bind` 在完成 conversation/Card capability 校验和 sender rebind 后，会同时返回当前 active Workset 已存在的最早 `READY` generation。
- 普通 `show_changes` 等 Workspace App、页面 rehydrate 或新的可信 App transport 一旦 bind 成功，如果发现 `readyGeneration`，会**立即**执行同一个原子 `claim -> authorize -> app.sendMessage`，不再依赖旧 milestone iframe 仍存活，也不再等待其五秒 supervisor tick。
- 多个 App 同时恢复不会制造重复消息：generation claim 仍由 server SQLite CAS 保证唯一；后来的 sender 只会看到 claim race lost / no-ready-generation。
- 这里有一个无法由 MCP server 绕过的 Host 边界：当 ChatGPT 页面里**完全没有任何 MCP App iframe transport 存活**时，纯后端没有 API 可直接向 conversation 注入 user-role 消息。1.1.57 不伪造“server-only send”能力；它保证的是 READY 已经存在时，**首个可信普通 App 一重新出现就立即消费 READY**，把之前可能达到十几分钟的 sender 空窗压缩到 transport 恢复时刻。

### 3. 禁止 synthetic turn 用占位 final 假装后台继续

- 自动续轮隐藏上下文明确写入：不得用“继续处理中。”、“继续处理。”、`still working`、`I will continue` 等占位/状态-only reply 结束一个仍有 runnable milestone 的 resumed turn。
- 真实 Host 已证明，仅依赖 `updateModelContext` 的隐藏恢复约束不够可靠。因此 `app.sendMessage()` 真正创建下一轮时写进 conversation 的 user-role trigger 也不再只是裸 `继续` / `Continue.`；它明确要求 runnable milestone 存在时继续调用工具完成，并禁止只回复状态或“继续处理中 / still working”。协议 token、taskId、workspaceId、generation capability 仍保持隐藏。
- final assistant message 之后不存在后台模型继续执行；因此 discovery、status、单次 read、checkpoint 或状态说明都不能代替同一 turn 内的后续实际工具执行。
- MCP Apps 目前没有“拒绝 Host 接受 assistant final”的同步拦截 API，所以 completion barrier 采用三层组合：Host-visible sustained-work trigger + Task Contract/material checkpoint 义务 + 45 秒 synthetic work-owner lease 到期后的 durable generation requeue。即使 Host 仍接受一次过早 final，也不会把该 generation 当作任务完成。

### 4. 旧 Host schema 的人工 takeover 兼容

- 新 schema 继续使用 `manualTakeover=true` 作为显式人工 CAS；READY、claimed 或 active synthetic generation 会在任何人工副作用前被 supersede。
- 已经打开的 ChatGPT conversation 可能缓存升级前的 `continuation_task` schema，导致模型看不到新增的 `manualTakeover` 字段。为避免“升级后旧窗口反而无法人工继续”，1.1.57 在一直存在的 `note` 字段提供精确兼容 marker：`note=manual-user-turn-takeover`。
- 只有真实人工 turn 的 status handshake 使用该 marker；Workspace App coordinator 与 synthetic resume context 永远不发送它。缺少 marker 的 tokenless ambiguous status 仍 fail closed，不能把 synthetic turn 猜成人工 turn。

### 5. 已确认的真实 Host cutoff 优先于短 activity lease

- 25 秒 activity lease 仍只负责进入 `SUSPECTED_STALL`，不是 Host turn deadline。
- 当 task 已持久化 `confirmed_turn_limit_ms` 时，generic completion stall 的二阶段 confirmation 使用 `max(COMPLETION_STALL_CONFIRM_MS, confirmed_turn_limit_ms)`，不会因为 10 秒 quiet confirmation 就在一个仍可能正常思考的长 turn 内开启第二个 assistant turn。
- 当前真实观测为约 `1,552,000 ms`（25 分 52 秒）；这是运行时 Host profile 的动态证据，不是新增固定常量。Host 后续真实 timeout 样本仍可通过既有 adaptive regime 更新该值。
- 没有 confirmed Host cutoff 的新/旧环境继续使用既有短 confirmation/backstop 行为，不把某一台机器的 25 分钟级观测写死给所有 Host。

## 回归覆盖

1. 构造 generation baseline=77、substantive=78、state=`WORK_REQUIRED`、synthetic owner lease 已过期且 milestone 仍 PENDING；supervisor 必须关闭旧 generation 为 `synthetic-resume-work-lease-expired` 并生成新的 READY。
2. 构造 `confirmed_turn_limit_ms=1552000` 的 completion-driven task；短 activity lease 与 30 秒 suspicion 不得生成 READY，只有 conservative confirmation 超过已确认 cutoff 后 generic recovery 才可继续。
3. 构造“旧 milestone iframe 已失活，但普通 Workspace App 重新挂载且数据库已有 READY”的场景；`bind` 必须直接返回 `readyGeneration`，relay 不经过人工 `attemptContinuation()` 就完成唯一 claim/send。
4. 构造仍持有 READY 的旧 schema 人工 turn；`status note=manual-user-turn-takeover` 必须与 `manualTakeover=true` 一样原子 supersede synthetic generation，同时普通 ambiguous status 仍不得夺权。
5. 静态 continuation guard 必须锁定 runtime requeue、sender bind/READY bridge、Host-visible anti-placeholder trigger 与旧 schema takeover 兼容语义。
6. `test-continuation-guard.mjs`、`test-continuation-architecture.mjs`、`test-runtime-cards.mjs`、`verify-source-tree.mjs` 以及完整 `npm test` 均为正式发布门禁；最终发布记录以本次重新执行后的结果为准，不复用修复前候选包的测试时间。

此外，1.1.57 将 Portable 版本身份纳入发布门禁：`package.json`、`VERSION-MANIFEST.json`、portable manager、Linux launcher、server capabilities、Workspace App UI 和原生控制中心必须声明同一版本。`verify-source-tree.mjs` 会在完整测试前检查这些来源，`finalize-release.py` 也会在生成发布 manifest 前 fail-closed；从而禁止再次出现“ZIP/manifest 已标为新版本，但 live runtime 仍通过旧 `PORTABLE_VERSION` 报告旧版本”的同版本漂移。

Protocol 继续为 1.5。
