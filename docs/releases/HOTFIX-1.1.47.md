# DevSpace Portable 1.1.47

## 最终同版本热修复：两阶段等待、resume ACK 与公网自愈

1.1.47 最终 repack 又完成了一轮真实 ChatGPT Host 端到端验收，覆盖此前仅靠单元测试无法证明的三条时序链路。

第一，durable process 等待改为两阶段握手。模型调用 `wait` 且已经注册 `watch-process` 时，任务先进入 `WAITING_SUPERVISOR`；只有仍然存活的 Workspace App Coordinator 用带 `coordinatorInstanceId` 的 `status` 明确 ACK 后，服务端才切换到 `WAITING_EXTERNAL`。这样不会再出现模型轮已经结束、但唯一负责继续轮询的 App 实际没有接管任务的假等待状态。

第二，`app.sendMessage()` 的 accepted 只被视为传输层接受，不再立即清除 durable wake。发送成功后任务进入 delivery-awaiting-ACK 状态；新 assistant 轮的第一条 `continuation_task status` 必须成功连回 DevSpace，服务端才返回 `continuation-resume-acknowledged` 并退役 wake。如果新轮刚创建就遇到 `UNAVAILABLE` / `Connection failed`，60 秒 ACK lease 到期后 surviving Workspace App 可以重新 claim/send，而不会把一次“Host 接受了消息但新轮没有连回 MCP”的失败误判为成功。

第三，tunnel supervisor 增加独立于本地 MCP 的公网 `/mcp` 健康探测：每 15 秒检查本地和公网端点；只有本地 `/mcp` 正常而公网连续 3 次失败时才重建 tunnel，并带 60 秒 cooldown/debounce，避免网络路径抖动导致重启风暴。该恢复逻辑不会把本地 MCP 故障误归因到 ngrok/cloudflared。

最终 live acceptance 使用一个干净 90 秒 durable process 验证：

```text
WAITING_SUPERVISOR
  -> Coordinator status ACK
  -> WAITING_EXTERNAL
  -> process exited 0
  -> durable wake
  -> claim-continuation
  -> app.sendMessage accepted
  -> 新 assistant 轮第一步 continuation_task status
  -> continuation-resume-acknowledged
  -> wake / delivery lease / watch handle 全部清零
```

同一轮验收中还真实遇到过一次公网 MCP `Connection failed`，无需人工重启 DevSpace 即恢复。最终 source/Portable regression 全部通过，production dependency audit 为 0 vulnerabilities。

## 同版本运行时热修复：watch-process 自动唤醒

正式 1.1.47 上线后的真实 75 秒 durable process 测试暴露了一个单元测试没有覆盖的时序缺陷：`continuation_anchor` 首先挂载时本地 App task 还没有任何 `watchProcessHandles`，随后模型通过 headless `continuation_task(action="watch-process")` 注册进程，再调用 `wait` 进入 `WAITING_EXTERNAL`。原 Coordinator 既不会主动刷新这个后注册的服务端 watch，又会在 `WAITING_EXTERNAL` 时停止 supervisor，因此事件日志虽然已经记录 `process.exited`，却不会触发任何 continuation claim 或 follow-up message。

热修复后的路径为：

```text
continuation_anchor 已挂载
        ↓
headless watch-process 后注册
        ↓
Supervisor 每 tick 先刷新 authoritative task state
        ↓
WAITING_EXTERNAL + watched process 仍继续 watch-status
        ↓
running=false / process.exited
        ↓
unwatch + resume RUNNING
        ↓
claim-continuation
        ↓
app.sendMessage 自动续轮
```

普通 `WAITING_EXTERNAL` 且没有受监控进程时仍保持抑制，不会因为等待人工审批、外部文件或其他未知条件而自行续轮。Server 侧 `watch-status` 和 App Coordinator 都提供 resume 保护，因此即使 App/Server 在升级边界上有短暂状态差异，也不会让已完成的 watched process 卡在 waiting gate。

此外，Workspace App 静态资源继续使用一年 immutable cache，但 `continuation-coordinator.js` 的引用 URL 现在加入基于文件 SHA-256 的 revision query；同版本重新发布时浏览器会请求新的 URL，而不是继续使用初始 1.1.47 的旧 Coordinator。回归测试也改为覆盖真实顺序“anchor 无 watch → 后注册 watch → WAITING_EXTERNAL → process complete → 自动 follow-up”，不再只测试连接前就预置 watch 的理想化场景。

本轮排查还发现 `portableProcessSnapshot()` 的枚举 PowerShell 自身命令行必然包含 Portable root，而旧 wrapper heuristic 会把这个枚举器本身也识别为 Portable-owned。snapshot 现在显式排除当前 PowerShell `$PID`，避免 strict stop 反复看到一个仅为下一次 snapshot 新建的 PowerShell 而无法在超时前收敛。

## 目标

1.1.47 专门收口 1.1.46 Continuation Guard 在真实 ChatGPT Host 中没有自动续轮的问题。该问题不是持久任务控制器或后台进程恢复失败：1.1.46 的 `continuation_task` SQLite 状态机、`processHandle` reattach、WAITING_EXTERNAL、原子 claim 和预算治理均已实测工作；真实 27 分钟测试中失败的是 UI guard 自身没有执行任何新的 `claim-continuation`。

本版本不新增第二个 MCP Server、不新增第二个公网域名，也不要求用户重新注册一个独立 MCP App。所有续轮能力仍封装在现有 DevSpace Portable、现有 `/mcp` endpoint、现有 OAuth 和现有 Workspace App 内。

## 1.1.46 真实失败根因

1.1.46 为 headless driving tools 注册了一个独立的 `ui://devspace/continuation-guard.html` resource。Guard JS 依赖另一个 Workspace App bundle “顺便”完成 `ui/initialize`，但两者实际上是不同的 sandboxed iframe。Guard 自己没有拥有已经完成 Apps SDK `App.connect()` 的协议实例，因此 `tools/call -> continuation_task` 与 `ui/message` 的生命周期并不可靠。

真实测试进一步确认：预期 24.5–25.75 分钟窗口过去后，SQLite 中 `continuationCount`、`lastContinuationAt`、`continuationPending` 都没有任何变化；即使 deadline 已过后重新挂载 guard，也没有产生新的 claim。这把问题定位到了 UI lifecycle，而不是 ChatGPT 收到了 `ui/message` 但没有显示。

## 单 App 集成架构

1.1.47 移除独立 Continuation Guard resource，同时不再把 UI descriptor 附加到每个 workspace/runtime/write/edit 工具。真实 ChatGPT 页面证明这种做法会为每次 MCP 调用生成一张额外 App activity card，形成连续的 “DevSpace MCP / CSP” 卡片。

新版本增加单一：

```text
continuation_anchor
```

一个非平凡长任务在 `open_workspace` 后只调用一次 anchor。只有这个工具挂载已有：

```text
ui://devspace/workspace-app.html
```

普通 read/run/write/edit/process 工具继续使用原来的 headless descriptor，所以任务有几十次甚至几百次工具调用时也不会堆积几十张 Workspace App 卡片。

同时把未显式设置 `DEVSPACE_WIDGETS` 时的默认模式从旧的 `full` 改为 `changes`。因此 Portable 的正常默认行为是：普通工具 headless，`show_changes` 在需要汇总审阅时才挂载 Workspace App，`continuation_anchor` 则独立承担续轮锚点。明确设置 `DEVSPACE_WIDGETS=full` 的用户仍可保留旧的逐工具 App 渲染模式，不破坏兼容开关的语义。

Workspace App 原有 Vite bundle 已经使用 `@modelcontextprotocol/ext-apps` 的 `App` 并执行真实：

```text
await app.connect()
```

1.1.47 在这个已有 App 实例上安装 `continuation-coordinator.js`，不再创建第二套 JSON-RPC transport。Coordinator 使用：

- `app.callServerTool({name: "continuation_task", ...})`
- `app.updateModelContext(...)`
- `app.sendMessage(...)`
- `app.addEventListener("toolinput" / "toolresult" / "toolcancelled" / "hostcontextchanged")`
- Workspace App 的现有 `onteardown`

`window.openai.sendFollowUpMessage` 仅在正式 `app.sendMessage()` 失败且 Host 暴露兼容接口时尝试；没有 textarea/composer selector、模拟点击或 DOM 输入路径。

## 自适应 Host budget 与 lifecycle recovery

1.1.47 不再假设 ChatGPT 的 assistant turn 一定是 25 或 26 分钟，也没有 23m/25m/25.55m 之类的固定 send 常量。

优先级变为：

```text
Host toolcancelled(timeout/deadline/budget)
        ↓
立即记录真实 elapsed 并尝试 continuation
        ↓
按 Host name/version 持久学习 observed turn budget
        ↓
后续 turn 使用 learned budget 的安全比例提前 proactive continuation
```

因此宿主以后把限制改短时，第一次实际 timeout 会立刻向下修正预算；限制变长时旧的保守预算仍能继续工作，不会因为平台从“26 分钟”改成别的数字而整个功能失效。

Workspace App `onteardown` 同样记录 Host signal；若 teardown 明确携带 timeout/deadline/budget，立即进入 force continuation。如果只是普通资源回收，则只有已经达到学习阈值时才续轮，避免用户滚动页面或 Host 正常卸载 UI 时无故插入“继续”。

一个轻量 supervisor interval 只负责 heartbeat 和比较 `elapsed >= recommendedContinueAfterMs`，它的 tick 周期不是 Host turn limit。多个 anchor/历史 iframe 即使同时存在也只能由一个实例成功 `claim-continuation`；`WAITING_EXTERNAL`、terminal state 和用户明确 cancel 不会自动续轮。

对于构建、训练、下载、评估这类有 durable `processHandle` 的后台任务，还有一条优先级更高的事件路径：

```text
continuation_task watch-process
        ↓
Anchor supervisor → process.attach/status
        ↓
running=false
        ↓
消费 watch + 立即 continuation
```

因此“监控任务跑完再继续”不需要猜 Host 单轮分钟数。Local process registry 与 Remote Agent process registry 都通过现有结构化 `process.attach` 状态读取，不新建 SSH 或第二个后台服务。

## 可观测性

SQLite schema migration 14 在 `continuation_tasks` 中增加：

- `last_activity_at`
- `last_ui_heartbeat_at`
- `last_send_attempt_at`
- `last_send_result`
- `coordinator_instance_id`

migration 15 增加：

- `host_profile_id`
- `observed_turn_budget_ms`
- `recommended_continue_after_ms`
- `host_timeout_samples`
- `last_host_signal`
- `last_host_signal_at`
- `continuation_host_profiles` 持久 Host 学习表

因此一次失败后可以直接判断：

```text
Workspace App 是否真正连接
→ 是否 heartbeat
→ 是否进入 claim
→ claim 是否被 dedupe/budget/waiting gate 拒绝
→ 使用 app.sendMessage 还是 compatibility fallback
→ Host 返回 accepted / rejected / failed
```

自动发送失败时 Workspace App 会显示一个小型 manual recovery 控件，允许用户显式点击“继续任务”；这只是 Host policy 不允许自动 user message 时的最后 fallback，不替代自动续轮主路径。

## Task Controller 增强

1.1.46 的持久控制器继续保留：

- conversation + workspace 隔离；
- required milestones + evidence completion gate；
- continuation count / wall-clock budget；
- no-progress / same-failure governor；
- 60 秒 cooldown；
- stale pending recovery；
- WAITING_EXTERNAL suppression；
- user cancellation；
- atomic continuation claim/release。

1.1.47 额外允许显式 `begin` 用更大的 `wallClockMinutes` 延长已有 active task 的 deadline，但不能绕开 no-progress、same-failure 或 continuation-count 限制。

## Remote Agent

1.1.47 没有改变 Linux Agent runtime、协议或权限边界，因此 `DEVSPACE_LINUX_AGENT_VERSION` 继续保持 1.1.46，避免为了 Portable UI/Continuation 改动无意义地重启所有远端 Agent。

1.1.46 已验证的修复继续保留：NVIDIA NVML/CUDA character-device `O_RDWR`、`/tmp`/`/var/tmp`/`/dev/shm`、动态 `/dev/pts/<n>`、DRM/KFD 和 RDMA runtime compatibility；persistent writableRoots 与 block-device 防护不改变。

## Regression

1.1.47 自动覆盖：

- migration 13 + 14 + 15；
- persistent continuation state；
- conversation isolation；
- milestone/evidence completion gate；
- WAITING_EXTERNAL；
- no-progress / same-failure governor；
- atomic claim、pending dedupe、cooldown、budget；
- explicit wall-clock extension；
- UI heartbeat / delivery result diagnostics；
- connected Workspace App `callServerTool` / `sendMessage` / `updateModelContext` 路径；
- 缩短 supervisor tick 的自适应 watchdog 自动发送测试；
- timeout teardown recovery；
- Host timeout budget 学习、跨 task profile 复用和限制缩短后的快速下调；
- durable processHandle watch、进程完成即时 wake 和 watch 消费防重复；
- 单一 `continuation_anchor` UI descriptor，普通工具不得因 continuation 被附加 Workspace App；
- Vite bundle App-created / connected / teardown hooks；
- 禁止 raw `window.parent.postMessage` continuation transport；
- 禁止 ChatGPT DOM composer automation；
- 完整 source/runtime regression；
- production dependency audit。

## Host 边界

DevSpace 1.1.47 可以保证自己的持久状态、App lifecycle、Host signal 学习、adaptive supervisor、claim 和发送诊断按上述规则工作，但 `ui/message` 最终仍是 MCP App View 向 ChatGPT Host 发起的请求。若 Host 将来改变 turn 时长，只要它仍按 MCP Apps lifecycle 发送 timeout/deadline/budget cancellation 或 teardown，DevSpace 不需要修改固定分钟常量即可重新学习。若 Host 在没有任何 cancellation/teardown 通知的情况下直接杀死所有 App iframe，则 MCP App 没有标准通道凭空创建新的 ChatGPT user message；这种 Host 行为属于平台边界，1.1.47 会在能收到的诊断信号中明确记录，而不会伪造 DOM 输入。
