# DevSpace Portable 1.1.55 Hotfix

## 目标

1.1.55 专门收敛 1.1.54 在真实 ChatGPT Host 中仍未完全解决的 continuation P0：Task Contract 和里程碑仍然明确要求继续，但最初的 Workspace App iframe 已被 Host 虚拟化或销毁时，服务端只能等待保守 quiet backstop，最终还可能因为没有 sender transport 而无法调用 `app.sendMessage()`。

本版本不再把“旧 anchor iframe 是否还活着”当作 completion-driven 自动恢复的必要条件，同时必须保留 1.1.54 已证明有效的长请求误触发保护。

## 关键修复

### 1. Server-owned two-stage stall recovery

- 每次真实模型 DevSpace 活动继续刷新短 activity lease。
- lease 过期后，服务端 supervisor 自己把任务推进到 `SUSPECTED_STALL`，不需要任何旧 iframe heartbeat。
- suspicion 持续至少 20 秒，期间没有新的 model request in-flight、没有新的 substantive model activity、没有 durable process guard 时，才允许进入 `CONTINUATION_ARMED` 并产生一个 READY generation。
- 任何新的真实模型活动都会重新租约并把 stall 状态恢复到 ACTIVE。
- 原有 120 秒 quiet recovery 只保留给缺失/无效 turn lease 的历史兼容行，不再是正常 1.1.55 completion-driven 路径的唯一恢复机制。

设计目标不是依赖某个 ChatGPT 固定时限，而是把“模型还在做真实工作”和“这一轮已经停止但里程碑未完成”拆成显式状态。默认正常恢复窗口约为 35 秒 activity lease + 20 秒 confirmation。

### 2. Durable process activity guard

MCP handler 返回并不等于实际工作已经结束。`exec_command` 返回一个仍在运行的 persistent processHandle 后，如果模型暂时没有继续 poll，不能在 55 秒后错误启动 synthetic continuation。

1.1.55 因此把 running process handle 持久登记到当前 completion-driven Task：

- `exec_command` / `write_stdin` / `process_attach` / `process_kill` 的结果会更新 guard；
- resident server timer 使用 `process.list` / 本地 persistent process registry 检查 liveness；
- guard 存在时 completion-driven stall recovery 必须 fail closed；
- 进程退出或被 kill 后自动清理 handle，再重新给正常 activity lease；
- 后台巡检禁止使用 `process.attach`，避免移动输出游标或消费 stdout。

这和 resident mode 的 process-completion wake 是两套语义：completion-driven guard 只负责证明“真实工作仍在进行”，不会自行把普通任务改成 resident monitor。

### 3. Keep the single milestone Card alive when Host supports PiP

MCP Apps 的 `app.sendMessage()` 必须从仍存活的 App iframe 发起；纯 MCP server 没有标准 API 可以绕过 Host 直接注入一条 ChatGPT user message。因此如果 Host 销毁全部 App iframe，server 即使生成 READY 也无法独立完成最后一跳。

1.1.55 不使用零高度/隐藏第二卡片规避这个 Host 约束，而是：

- 仍然坚持一个真实 ChatGPT conversation 只有一张 conversation milestone Card；
- 只有 verified anchor Card、completion-driven RUNNING、里程碑未完成，并且 Host 明确声明支持 `pip` display mode 时，才请求 PiP；
- relay / show_changes 等后续 UI surface 不请求 PiP，不会成为第二张 milestone Card；
- Host 不支持、拒绝或异常时自动保持 inline；
- task terminal 后不再维持 persistent display mode。

PiP 用于提高唯一 sender surface 的 Host 生命周期稳定性，不改变 Card/Workset/Generation 身份模型，也不伪装 Host 能力。

## 需要通过的验收

发布前至少必须满足：

1. conversation 只有一张可见 milestone Card，且同一时刻最多一个 active Workset；
2. 长时间 model request in-flight 不产生 synthetic continuation；
3. running persistent process 在模型暂时不 poll 时不产生 synthetic continuation；
4. assistant turn 真正停止、里程碑未完成且无真实工作 in-flight 时，在正常 activity lease + confirmation 后产生且只产生一个 READY generation；
5. 有可用 sender iframe 时只发送一次 `app.sendMessage()`；
6. synthetic status-only 不算推进实际工作；
7. 用户人工输入可以原子 supersede pending synthetic generation；
8. milestone/workset 完成后 Card 不再显示 RUNNING；
9. 新任务复用同一 conversation Card，创建下一顺序 Workset，不创建第二卡；
10. Host 不支持 PiP 时 continuation FSM 本身仍可正常工作，不允许把 PiP 当成强依赖。

Protocol 继续为 1.5。
