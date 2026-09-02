# DevSpace Portable 1.1.59 Hotfix

## 目标

1.1.59 当前 hotfix 同时收口 Remote Workspace / Linux Agent 配置更新链路，以及 ChatGPT Host 自动续轮 / 里程碑卡片状态机中的确定性竞态。

第一，原生控制中心的按钮虽然叫“**一键恢复 / 更新 Agent**”，但 existing-agent 分支实际上以已登记的 `_selectedAgent` 配置为优先来源；只要 Agent heartbeat 正常就直接返回，离线时也先按旧 `installRoot / writableRoots / accessMode` 重启。结果是用户在界面里修改 Writable Roots、切换 Full Access 或更改 Agent install root 后，按钮并不会把这些新值写回同一个 Agent。

第二，Full Access 本来不应该依赖任何 Writable Root，但 SSH enrollment 的旧 fallback 在 roots 为空时仍把 install root 硬编码为 `/home/ubuntu/workspace`。如果服务器没有该目录，即使 Full Access 已启用，安装链路仍会因为这个无关路径不存在而失败。

第三，自动续轮此前把“模型一段时间没有 DevSpace 活动”与“Host 已经结束当前 assistant turn”混在一起，短 owner lease、普通静默和 `app.sendMessage` 回调不确定状态都有机会被错误解释成可重发条件。这既可能制造重复续轮，也可能在真实 send 已经发生但 ACK 丢失时重复发送。

第四，server resident sweep 可以在 Workspace App sender 已经绑定之后才创建新的 `READY` generation；旧 coordinator 只在 bind/onConnected 当下消费 READY，导致这种“后出现 READY”可以长期无人 claim。真实现场曾出现 READY 约 18 分钟，直到用户手动发送消息才被 supersede。

第五，真实 Host 已观察到第一条 synthetic `ui/message` 被模型误判为“只是系统续接说明”，首个 resumed turn 只复述恢复信息、不做实质工具操作，直到第二次续轮才开始工作。synthetic visible/hidden contract 现已明确首轮就是本轮实际用户角色工作请求，并要求 status/discovery 后在同一 turn 继续实质 DevSpace 操作。

第六，真实 ChatGPT 网页在普通 assistant turn 正常结束后可能继续保留里程碑 iframe 和 heartbeat，并不会可靠触发 `onTeardown()`。如果状态机只接受 timeout / teardown / 已确认 Host cutoff，那么 25 秒 Turn Lease 过期后会永久停在 `SUSPECTED_STALL`。1.1.59 因此增加一个与工具契约一致的、严格受控的 **under-one-minute server-quiet backstop**：先等待 25 秒进入疑似静默，再额外确认 30 秒无模型 DevSpace 请求、无 durable process 后才允许生成下一代；heartbeat 本身仍不构成授权。

## 关键修复

### 1. 手动“恢复 / 更新”真正变成配置更新

- 用户主动点击按钮时，控制中心从**当前编辑器**读取服务器显示名、Agent install root、Writable Roots 与 Full Access 开关，不再让已登记的旧值覆盖 UI 草稿。
- Existing Agent 使用原 `agentId` 创建 repair enrollment，并通过现有 SSH 本地安装链重新写入同一个 Agent 的 endpoint、凭据、访问模式与 roots。
- Full Access 会明确把 `writableRoots` 置为空数组；Scoped 则使用当前多行编辑器里的 roots。
- 更新完成后重新等待同一个 `agentId` heartbeat 并刷新列表，从而避免“看起来保存了、实际仍是旧配置”。

### 2. 后台自动恢复与人工更新分离

- `silent` 自动 SSH 救援继续使用最后一次已持久化的 Agent 配置，并保持 restart-first；它不会因为用户恰好打开界面、但尚未主动提交某个草稿值而擅自修改服务器权限。
- 非 `silent` 的显式按钮路径才执行 repair enrollment 和配置更新。
- 因此“自动救活旧配置”和“用户确认应用新配置”不再共用一个模糊分支。

### 3. Full Access 不再依赖 `/home/ubuntu/workspace`

- SSH 端先验证当前 install root 是否为存在且 `r/w/x` 的绝对目录。
- Full Access 下，如果该路径不存在、不可写或用户没有提供有效路径，则自动使用 `${XDG_STATE_HOME:-$HOME/.local/state}`，必要时创建该目录，并再次验证权限。
- Enrollment 不再存在 `roots 为空 -> /home/ubuntu/workspace` 的硬编码 fallback。
- Scoped 模式保持严格：指定 install root 不存在或不可写时直接失败，而不是静默把受限 Agent 安装到范围之外。

### 4. install root 变化时安全迁移运行实例

- 更新前会用旧的已登记 install root / roots 以及标准 state 目录候选定位现存 Agent state，并在可用时核对 `config.json` 里的 `agentId`。
- 如果新 install root 不再包含旧 state，先读取旧 PID，并且只有 `/proc/<pid>/cmdline` 同时匹配旧 state 下的 `devspace-agent.py` 与 `config.json` 时才终止该进程。
- 随后在新位置安装并启动 repair enrollment，避免同一 Agent 的旧进程继续用旧权限策略在线。

### 5. 自动续轮状态机 fail-closed

- 普通静默、Turn Lease 到期的第一阶段只允许进入 `SUSPECTED_STALL`，不会在 25 秒阈值处直接生成新的 Host turn。
- 明确 Host timeout / teardown 证据，以及用户已确认的真实 Host cutoff + grace + model quiet，继续作为更强的恢复证据。
- 对真实网页“assistant 已结束但 iframe 继续存活”的情况，增加约 **55 秒总静默窗口**的 bounded server-quiet backstop：25 秒进入 `SUSPECTED_STALL` 后，再稳定 30 秒；期间只要存在模型侧 DevSpace 请求或 durable process handle 就保持 fail-closed。该后备只解决 Host 不提供 turn-end 信号的问题，不把 iframe heartbeat 当成 turn-end。
- `CLAIMED` 是发送前状态，可以在 claim lease 到期后安全回收；`DELIVERING` 是结果不确定区，timer 永远不能据此重发。
- `app.sendMessage` 返回 `unknown` 时保留原 generation 的 `DELIVERING`，不转换成 READY；只有明确 `failed/rejected` 才允许下一次 generation。
- synthetic work owner 的 45 秒短 lease 只用于检测 stale ownership，不能凭自身到期制造第二个 ChatGPT turn；后续 synthetic→synthetic 同样必须有 Host/cutoff 证据，或满足同一约 55 秒 no-inflight server-quiet backstop。

### 6. READY-after-bind 不再饿死

- `continuation_task status` 已能暴露当前 durable `readyGeneration`，coordinator supervisor 现在会在常规权威状态刷新时消费它。
- 因此 READY 无论是在 sender bind 前还是 bind 后由 resident sweep 生成，都会进入同一个原子 `claim -> authorize-delivery -> app.sendMessage -> delivery-result` 路径。
- 多个可用 Workspace App relay 即使同时看到 READY，也依靠 server CAS 只有一个 sender 能 claim，避免重复消息。

### 7. 第一次 synthetic turn 必须直接干活

- Host-visible continuation 文本明确声明：这是**当前 assistant turn 的实际用户角色工作请求**，不是仅供参考的系统恢复说明。
- 恢复后的第一步仍要求 `continuation_task status`；如果 DevSpace_MCP schema 未预加载，先通过 connector/tool discovery 加载。
- status/discovery 只属于 control plane。只要仍有 runnable milestone，同一 synthetic turn 必须继续至少一次实质 DevSpace 工具工作，不能只复述提示、只报状态、回复“继续处理中”，也不能等第二次续轮才开始执行。

### 8. Apply 前残留进程检查保持安全但不再超时

- Portable-root executable preflight 仍然 fail-closed：检测到无关的运行中可执行文件时，在任何 program-file move 前拒绝 Apply。
- 首次使用全量进程扫描定位残留；等待退出期间只复核已经证明属于 Portable root 的 PID，避免在高进程数机器上每 250 ms 对所有进程重复读取 `MainModule.FileName`。
- 已知残留清空后必须再次执行全量扫描才能进入事务，因此性能优化不降低“开始移动文件前无 Portable-root 残留”的安全不变量。

### 9. 同一真实 assistant turn 不再被 weak quiet-backstop 抢占

- 真实网页 Host 可能在模型长推理、上下文压缩或等待外部工具返回期间保持当前 assistant turn 存活，但这一段时间未必持续产生 DevSpace 调用；旧 bounded quiet-backstop 因而仍存在把“同一轮仍在工作”误判成“上一轮已经结束”的窗口。
- 模型发起新的 DevSpace 请求时，server 现在先登记 model-originated request in-flight，再执行 continuation ownership authorization，关闭“授权检查通过后、in-flight 尚未可见前”被 supervisor 抢占的竞态。
- 如果当前 manual turn 的真实模型活动遇到仅由 `server-quiet-backstop-no-inflight-model-request` 产生、尚未进入真实发送的 weak READY generation，runtime 会撤销该 weak READY 并继续当前 turn，而不是强迫模型进入 synthetic/manual takeover 竞争。
- 已经 claim、已经进入 `DELIVERING` 或拥有更强 Host/cutoff 证据的 generation 不会被该规则撤销；因此修复只消除 weak false-positive，不削弱 durable delivery 的去重语义。
- 同一手动用户消息的异常恢复继续复用当前 visible card generation；weak quiet recovery 不得自行旋转新卡。

### 10. canonical-repair SQLite 快照改为有界 retention

- `devspace-before-canonical-repair-<timestamp>.sqlite` 维护快照现在通过独立的纯文件系统 retention 模块管理，并在 state DB 打开路径中自动收敛历史遗留文件。
- 只匹配严格 canonical-repair 文件名，不触碰主 `devspace.sqlite`、WAL/SHM 或其他 SQLite 文件。
- 默认保留最近 **3** 份，同时施加 **512 MiB** 总体积上限；清理失败 fail-open，不允许因历史维护文件权限异常阻塞 DevSpace 服务启动。
- D live 已从 39 份、约 3.16 GB 历史快照收敛到 3 份、约 256 MB；清理前后 `PRAGMA quick_check` 均为 `ok`，主库大小未改变。

### 11. process registry 终态历史改为有界 compaction

- persistent process registry 不再无限累积 `exited/lost` 等终态行。
- `running`、`detached-running`、`stopping` 等活动/过渡状态明确永不进入历史 DELETE 条件。
- 终态历史默认保留最近 **5000** 条，并额外淘汰超过 **30 天**的旧记录，在保留诊断窗口的同时阻止长期无界膨胀。
- D live 已从 26,798 行压缩到 5,003 行，删除 21,796 条终态历史；活动记录全部保留，主库 `quick_check` 仍为 `ok`。

### 12. milestone 全部完成后原子封口 Task Contract

- completion-driven Task Contract 不再允许出现 `remainingMilestones=[] / taskIncomplete=false` 但 task state 仍长期停在 `RUNNING` 的僵尸终态。
- checkpoint 只有在 required milestones 非空且全部完成、存在 durable evidence、当前不处于 owner lock、canonical visible card 已完成验证等终态安全条件同时成立时，才原子进入 `SUCCEEDED`。
- 原子封口后同时执行 terminal continuation cleanup，清除 synthetic delivery owner/token 等残余控制面状态；因此 late duplicate delivery 会被更强的 `task-terminal-no-work` 门直接拒绝。
- 没有 evidence、卡片仍待 ACK、仍有 owner lock 或 milestone 未完成时，checkpoint 保持旧的 fail-closed RUNNING 行为，不会通过“自动成功”绕过原有门禁。

## 回归覆盖

1. `test-remote-agent-ssh-rescue.mjs` 断言显式更新读取 `_fullAccess.Checked` 与 `_roots.Lines`，Full Access 时 roots 归零，并且 existing Agent 仍传入原 `agentId` repair enrollment。
2. 同一测试锁定 Full Access 的 `${XDG_STATE_HOME:-$HOME/.local/state}` fallback，并明确禁止恢复旧的 `/home/ubuntu/workspace` 硬编码表达式。
3. 同一测试锁定 install root 改变时旧 state 的安全停止逻辑，同时确认后台 `silent` recovery 仍读取 persisted Agent 配置。
4. `test-native-ui-resilience.mjs`、`test-linux-agent-contract.mjs`、`test-remote-workspace-backend.mjs` 与 `verify-source-tree.mjs` 继续作为 UI 生命周期、Linux Agent 权限契约、后端 repair enrollment 和版本身份门禁。
5. `test-continuation-guard.mjs` 新增 READY-after-bind 模拟：初次 sender bind 没有 READY，后续 supervisor status 才出现 READY，必须在下一次 refresh 原子 claim 且只发送一次；同时锁定首条 visible synthetic message 的“actual user-role work request / 首轮必须实质工作”语义。
6. `test-continuation-architecture.mjs` 继续覆盖 generation ownership、manual takeover、card/workset singleton、confirmed-cutoff 恢复，并新增 server-quiet backstop 动态验证：真实模型 DevSpace 请求仍在 flight 时即使静默窗口成熟也不得续轮；请求释放后只生成一个 READY generation。
7. `test-updater-apply-recovery.mjs` 覆盖无关 Portable-root executable 在文件事务前阻断更新，并要求 stderr/stdout 保留具体 PID/文件路径和 `No program files were changed` 诊断。
8. `test-continuation-guard.mjs` 额外锁定 synthetic owner lease 不能单独重发、`DELIVERING/unknown` 仍不可 timer retry，以及 synthetic 正常结束时只能通过 Host/cutoff 或 bounded no-inflight quiet gate 进入下一轮。
9. `test-continuation-architecture.mjs` / `test-continuation-guard.mjs` 同时锁定 same-turn weak READY 撤销、model request in-flight 登记顺序以及“弱静默恢复不能旋转当前手动卡片”的不变量。
10. canonical-repair retention 专项回归锁定严格文件名匹配、最近 3 份 / 512 MiB 双上限，并验证主库、WAL/SHM 与非目标 SQLite 文件不会被删除。
11. `test-process-registry-retention.mjs` 验证活动/过渡状态永不清理，终态历史受到 5000 条 + 30 天双重约束。
12. `test-continuation-guard.mjs` 新增 checkpoint 终态卫生覆盖：具备 durable evidence 且最后 milestone 完成时必须原子 `SUCCEEDED` 并清除 synthetic ownership；缺失 evidence 时必须继续 RUNNING。
13. 正式发行仍要求 D 盘 live 同步、真实 ChatGPT Host E2E，以及真实 Remote Agent 的 Scoped / Full Access 更新验收。

Protocol 继续为 1.5。
