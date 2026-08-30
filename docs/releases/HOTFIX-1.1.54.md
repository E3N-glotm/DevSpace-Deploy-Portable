# DevSpace Portable 1.1.54

1.1.54 不再继续给 1.1.53 的 continuation stall heuristic 叠加时间阈值，而是重新划分 **conversation/card identity、workset ownership、model request lifetime 与 sender transport** 的职责边界。目标仍然是一个真实 ChatGPT conversation 只有一张用户可见里程碑卡，但这张卡不能再同时被当成唯一任务身份、唯一 sender 以及 assistant turn 存活探针。

## 唯一卡片与 sender transport 解耦

`continuation_anchor` 继续承担 conversation-lifetime 唯一可见里程碑卡身份；一旦 mount token 被 Workspace App iframe 验证，后续 assistant turn、服务重启、workspace 切换与 synthetic resume 都不得生成第二张 anchor。

发送能力改为独立 capability。后续仍存活的 UI-bearing DevSpace Workspace App surface 可以从 tool-result 私有 `_meta["devspace/continuation-sender"]` 继承当前 conversation 的 sender capability，并通过 app-only `continuation_sender` bridge 执行 heartbeat、claim、authorize-delivery 与 delivery-result。该 surface 的 `anchorSurface` 仍为 false，因此取得传输能力不会创建第二张里程碑卡或更换卡片 identity。

这一拆分针对移动端/ChatGPT Host 可能虚拟化早期 iframe 的真实行为：最早 anchor iframe 不再必须永久存活，只要会话里仍有当前 DevSpace App surface，sender transport 就可以迁移到新的 surface。

## 长命令不再被静默误判

1.1.53 曾使用 35 秒 activity lease 加第二次 iframe heartbeat 作为 ordinary completion-driven 恢复证据。真实测试证明这会在长命令、MCP transport 抖动或模型仍等待工具时产生错误 synthetic continuation，因此 1.1.54 删除这条授权路径。

- activity lease 到期最多把任务置为 `SUSPECTED_STALL`；
- 任意次数 iframe heartbeat 都只能证明 UI liveness，不能证明 assistant turn 已结束；
- server/runtime 显式维护 model-originated DevSpace request in-flight 计数；
- 一个真实 `exec_command`、`write_stdin` 或其他 substantive DevSpace 请求尚未返回时，quiet recovery 被抑制，不依赖“最近有没有新的 MCP 调用”猜测长请求是否结束。

架构回归会模拟 10 分钟模型静默、重复 verified-card heartbeat 且请求仍 in-flight 的情况，要求 resident supervisor 始终产生 0 个 READY synthetic generation。

## 无 Host lifecycle signal 时的保守恢复

MCP Apps 当前没有标准的“assistant turn 正常结束”权威事件，MCP server 也不能在 Host 已销毁所有 App iframe 时凭空调用 `app.sendMessage()`。因此 1.1.54 对 Host 不发送 timeout/teardown 的场景采用保守 server-side backstop，而不是重新引入短时猜测：

- task 必须仍为 RUNNING 且 required milestones 未完成；
- continuation mode 必须为 completion-driven；
- 当前 conversation 没有 model-originated DevSpace request in-flight；
- last model activity 已持续静默至少 120 秒。

满足后 server 才允许以 `server-quiet-no-inflight-model-request` 证据进入恢复并产生 READY generation。若没有任何可用 App iframe，READY generation 会持久等待 sender；纯 MCP server 不伪装成 Host，也不使用 DOM 自动化。

## Watchdog 生产级崩溃修复

在新增 quiet recovery 回归时发现 `continuationSupervisorSweep()` 的新分支引用了作用域外的 `normalizedMode`，一旦真正扫描到对应 workset 就会抛 `ReferenceError`，从而直接破坏后台 watchdog。1.1.54 增加顶层 `normalizedContinuationMode()` 并让 supervisor 使用该 helper；自动化必须实际走过该恢复分支，避免只靠静态字符串检查漏掉同类错误。

## Manual takeover 与 sender 安全边界

已有 `deliveryToken + deliveryGeneration` manual takeover 语义保持：人工 turn 优先于迟到 synthetic generation，旧 token 被 supersede 后不能继续产生副作用。sender capability 同样 fail closed：如果 Host 只保留 taskId、却丢失一次性的 verified sender capability，客户端可以通过 status 找回 lifetime task，但不能根据 taskId 自行伪造 sender token。

## 浏览器无关

DevSpace 产品运行在 MCP Apps / ChatGPT Host 提供的 iframe/WebView 中，不依赖用户安装 Edge、Chrome 或其他浏览器。仓库的 runtime UI 自动化此前把系统 Edge headless 写死为测试工具；1.1.54 将其改成可选 browser-render smoke probe，并允许通过 `DEVSPACE_TEST_BROWSER` 使用任意兼容本地浏览器。没有可用 headless browser 或浏览器 CLI 异常时，测试使用确定性的 UI source contracts 验证 compact runtime log、折叠 operation timeline、文件记录与敏感参数 redaction，不能因为开发机某个浏览器安装异常阻断整个 release pipeline。

## 回归状态

在 packed core 重新安装到 `app/node_modules` 后，`test-continuation-guard.mjs` 与 `test-continuation-architecture.mjs` 均通过；完整 `scripts/test-source.ps1 -SkipInstall` 也以 exit code 0 结束，progress log 的最后结果为 `PASS ALL source and Portable regression tests`。其中此前偶发的 updater recovery、update launch ACK 与 core-memory-bounds 均在完整顺序中通过，Remote Workspace、Linux Agent、SSH rescue、插件、Computer Use 和 production dependency audit 也保持绿色。

Protocol 继续保持 **1.5**。1.1.54 在真实 ChatGPT/Host 上完成单卡、sender takeover、长请求不误续、静默恢复、manual takeover 与最终 milestone completion 验收前不发布。
