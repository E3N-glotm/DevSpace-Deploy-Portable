# DevSpace Portable 1.1.56 Hotfix

## 目标

1.1.56 收口 1.1.55 在真实 ChatGPT Host 中暴露的 continuation P0：后端已经把 `continuation_anchor` 标记为 verified，但最终 Workspace App bundle 没有把该工具路由到可见卡片；旧 anchor iframe 停止后，当前普通 DevSpace App 可能因为 Host 丢失 conversation scope 或一次性 `_meta` 而无法绑定 sender；另外 live synthetic turn 在首次 status 漏传 `deliveryToken` 时会被旧逻辑错误识别成 manual takeover，从而自己 supersede 自己，表现为自动续轮只思考十几秒、只做控制调用然后静默结束。

完成标准仍是：一个真实 conversation 恰好一个逻辑/可见 milestone Card、最多一个 active Workset；未完成任务在没有真实工作 in-flight 时最迟于 activity lease + confirmation 窗口恢复；人工输入优先；长请求和持久进程不误触发。

## 关键修复

### 1. 验证最终 Workspace App 产物，而不是只验证源码函数存在

- Portable server 在生成自包含 Workspace App HTML 时，按 whitelist 函数的语义起点插入 `continuation_anchor`，不依赖 minifier 参数名或固定的 `open_workspace || show_changes` 两项文本。
- 若上游 bundle 结构变化且无法安全定位 whitelist，资源生成 fail closed，不再静默提供只 ACK、不显示卡片的 ghost renderer。
- 回归直接调用 `workspaceAppHtml()`，断言最终交给 Host 的 HTML 中确实存在 `continuation_anchor -> visible renderer` 路径。

### 2. 可见 Card identity 与 sender transport 分离

- `anchorMountVerifiedAt` 一旦存在，`anchorMountRecoveryRequired()` 永久返回 false；刷新、重连、workspace 切换、synthetic resume 和旧 iframe 消失都不得再次发出 UI-bearing `continuation_anchor`。
- verified anchor Card 始终留在 ChatGPT transcript 的 inline surface，不再主动请求 MCP Apps PiP；如果旧 build 已把当前 surface 留在 PiP，则新 coordinator 在 Host 支持 inline 时主动请求恢复 inline。卡片内部 recovery/status 提示也使用普通文档流，不再 `position: fixed` 悬浮覆盖对话。
- 当前普通 DevSpace App 可以调用 app-only `continuation_sender bind`。优先使用认证 Host scope；缺失时必须同时匹配随机 taskId、canonical conversationScopeId 和 verified mount generation，才可取得当前 sender capability。
- bind 只移动 `sender_instance_id`，不改变 `card_id`、mount generation 或 anchor coordinator identity。

### 3. 删除 shadow identity 与旧 delivery 污染

- continuation control metadata 缺失时，若携带已有 taskId，则从该 task 恢复 canonical conversation scope。
- 既无真实 scope、也无已有 task capability 时 fail closed，不再创建 `host-scope-unavailable` 任务。
- migration 31 一次性 supersede 旧 READY/CLAIMED/DELIVERING/DELIVERED/WORK_REQUIRED generations，归档未完成 workset，清除 sender ownership 和非 canonical shadow tasks；ConversationCard identity 与已验证 mount truth 保留。

### 4. synthetic / manual turn origin 改为显式握手

- 自动续轮的 generation capability 由 server/runtime 持有。恢复轮首次 `continuation_task status` 原子 claim expected generation，随后普通 DevSpace 工具只依赖持久 generation lease；模型不再需要、也不应该把 continuation token 搬运到普通工具参数。
- READY 或 synthetic-owned generation 存在时，模糊的 tokenless manual-looking status 不再自动等价于 manual takeover。只有 runtime 认定为 expected synthetic claim 时才取得 synthetic ownership；其他歧义路径返回 `turn-origin-handshake-required` 且不修改 generation/ownership。
- 真正由用户输入触发、需要抢占自动 generation 的 manual turn 必须显式以 `manualTakeover=true` 做 CAS。只有该显式路径才允许 supersede READY/CLAIMED/DELIVERING/WORK_REQUIRED synthetic generation；旧/迟到 synthetic token 继续 fail closed，不能产生副作用。

### 5. terminal cancellation barrier：完成后不再继续排队“继续”

- `SUCCEEDED`、terminal failure、用户取消和 budget terminal 现在在同一 SQLite transaction 中关闭 continuation transport：清零 pending/wake/ACK retry，清除 delivery token/owner/lease、Turn Lease、process watch 和 stall/quiet-recovery latch，并取消 workset 的 `continuation_due_at`。
- terminal transition 会把该 task 尚未关闭的 synthetic generation 原子转为 `NO_WORK`，manual generation 正常 `CLOSED`，同时解绑 ConversationCard 的 active Workset；历史 `last_send_*` 仍保留作取证。
- `claim`、`authorize-delivery`、`delivery-result` 都增加 terminal gate。即使 Host 已经接受一条无法撤回的 synthetic user-role 消息，迟到 delivery result/status 也只能得到 `task-terminal-no-work`，不能重新写回 pending/owner/stall，也不能生成下一代 continuation。
- Coordinator 在 sender authorization 之后、每一次实际 `app.sendMessage` / fallback 之前再次读取 authoritative `continuation_task status`，消除 `arm -> complete -> send` 的主要 TOCTOU 窗口；一旦观察到 terminal，立即停止 supervisor interval、lifecycle refresh、delivery retry 和 quiet-probe timer。

### 6. resumed turn 工具发现与 active Workset 优先恢复

- ChatGPT 的工具 schema 是 turn-scoped surface，不等价于 conversation authorization。synthetic `app.sendMessage()` 进入的新模型轮次如果没有直接展开 `DevSpace_MCP` namespace，隐藏恢复上下文要求先走 Host connector/tool discovery；在 ChatGPT 中使用 `api_tool.list_resources` 加载 `DevSpace_MCP` 后继续原任务，禁止把“本轮 schema 未预加载”误报成“会话没有 DevSpace 权限”。
- `recoverCanonicalConversationTaskProjection()` 不再仅按历史 sequence 取最后一个 canonical Workset。恢复时首先寻找最新、active、且仍有 PENDING milestone 的 Workset，并把它视为 authoritative execution projection。
- 若最新 unfinished Workset 暂时属于 compatibility/shadow task，恢复事务会先把该 Workset 的 `legacy_task_id` 迁回 conversation lifetime canonical task，再退役其余 shadow task/workset；因此不会在捕获当前 objective/milestone 之前把真正未完成的工作一起 supersede。
- canonical legacy row 即使已经因为历史 Workset 完成而处于 `SUCCEEDED`，只要 authoritative active Workset 仍有 PENDING milestone，就必须重新投影为 `RUNNING` / `WAITING_EXTERNAL` / `PAUSED_BY_USER`，并优先继承 active Workset 的 objective/workspace。普通 `status` 无需 `forceRunning` 或 shadow task 才能自愈。
- release metadata 现在把 `continuation-coordinator.js` 纳入 `VERSION-MANIFEST.json` 的 keyFiles 哈希；以后同版本 live/source 漂移不再只靠版本字符串判断，D/E 半同步可以直接从关键文件指纹发现。

## 验收矩阵

1. 新 conversation 第一次 substantive DevSpace 调用显示恰好一张 milestone Card；同轮连续工具调用、用户继续、workspace 切换、MCP reconnect、页面刷新均不增加第二张。
2. 最终 `workspaceAppHtml()` 产物包含真实 `continuation_anchor` renderer，不能只检查 server 适配函数文本。
3. Host scope 正常、Host scope 丢失但 task/card capability 正确两种 bind 都成功；错误 task/scope/generation 必须拒绝。
4. 旧 anchor iframe 不存活但有当前普通 DevSpace App 时，READY generation 可被唯一 sender claim、authorize、send、record。
5. 25 秒 activity lease 到期仅进入 `SUSPECTED_STALL`；再持续至少 10 秒 server quiet confirmation，且没有 model request in-flight / durable process guard 时，才允许进入 `CONTINUATION_ARMED` 并产生单个 READY。旧数据没有可用 turn lease 时使用 40 秒兼容 backstop。
6. synthetic status-only 或只输出计划不算推进；必须发生真实非 control DevSpace 操作并有 material checkpoint。
7. synthetic 首次 status 必须取得 server-owned expected-generation claim；普通工具不携带 continuation token。歧义 status 不得 self-supersede；真正人工 turn 使用 `manualTakeover=true` 后才原子 supersede 旧 generation。
8. milestone Card 不主动请求 PiP；Host 已处于 PiP 时会退回 inline，内部状态提示不得使用 fixed/floating overlay。
9. migration 后不存在 `host-scope-unavailable` active task、旧 READY delivery 或同 conversation 多 active workset。
10. generation 已进入 CLAIMED/DELIVERING 后若 task 在 Host send 前完成，terminal barrier 必须把 generation 置为 `NO_WORK`、清空所有 delivery/retry/stall latch；迟到 accepted delivery/status 不得重启 task，后续 supervisor sweep 必须保持 0 个 READY。
11. synthetic resume 即使本轮未预加载 `DevSpace_MCP` schema，也必须先通过 Host connector discovery 恢复工具并继续执行；不得以“工具入口不可用”为由结束仍有 runnable milestone 的任务。
12. 历史 Workset 已 SUCCEEDED、但同 conversation 存在更新的 active + PENDING Workset 时，projection recovery 必须选择后者并把 lifetime task 恢复为非 terminal；不得返回 `task-terminal-no-work`。

Protocol 继续为 1.5。
