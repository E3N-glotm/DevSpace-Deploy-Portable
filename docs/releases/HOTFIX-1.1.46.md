# DevSpace Portable 1.1.46

## Refresh / tool-registration hotfix

The first 1.1.46 package registered `continuation_task` with `registerAppTool()` without the required `_meta` descriptor. With `@modelcontextprotocol/ext-apps 1.7.5`, that can fail while constructing the MCP tool graph because the helper reads `config._meta.ui`, which explains the observed ChatGPT Refresh failure even while the HTTP/OAuth service remains reachable.

The refreshed 1.1.46 package keeps the Continuation Task Controller and all Remote Agent GPU/Landlock fixes, but registers `continuation_task` with the same headless descriptor path as the existing shell tools via `toolWidgetDescriptorMeta(config, "shell")`. A regression assertion now requires that descriptor, and packaged-server smoke coverage verifies authenticated `initialize` + `tools/list`, including a non-empty `continuation_task._meta` and the normal `open_workspace` tool.

The durable task state machine/process monitoring portion is verified in 1.1.46. Automatic ChatGPT follow-up remains a best-effort host-side MCP App behavior in this release; the long-duration live test did not produce an automatic follow-up, so that UI lifecycle path is being hardened separately rather than being treated as a release-completion guarantee.

## Continuation Guard / Task Controller

1.1.46 增加一个独立于单个 ChatGPT assistant turn 生命周期的持久任务控制器。任务状态保存在 DevSpace SQLite，而不是只依赖聊天上下文，因此续轮后可以继续复用原有 workspace、processHandle、里程碑和验证证据。

核心状态包括 `RUNNING`、`WAITING_EXTERNAL`、`FAILED_RETRYABLE`、`SUCCEEDED`、`FAILED_TERMINAL`、`CANCELLED_BY_USER`、`ABORTED_NO_PROGRESS` 和 `BUDGET_EXHAUSTED`。`complete` 只有在 required milestones 全部满足并提交非空 evidence 后才会被接受。

隐藏的 MCP App continuation guard 跟随 workspace/runtime/edit 类工具实例化。它利用 Apps SDK Host 的正式 `ui/message` 能力发起新的 user follow-up；若宿主没有该 capability，则只尝试 `window.openai.sendFollowUpMessage` compatibility fallback。没有 DOM selector、输入框填充或模拟点击路径。

Guard 优先响应 `ui/notifications/tool-cancelled(reason≈timeout)`；同时以 24m30s arm + 25m45s bounded watchdog 兜底。发送前必须在 SQLite 里原子 `claim-continuation`，因此多个 iframe、timeout 事件和 watchdog 同时触发也只能成功认领一次。

循环治理默认包含：continuation 次数预算、wall-clock deadline、连续 no-progress 限制、相同 failure fingerprint 限制、60 秒续轮 cooldown、120 秒 stale-pending 恢复、WAITING_EXTERNAL 抑制和用户取消终止。用户要求“直到完成”时可以由模型显式提高 continuation budget，但 no-progress/same-failure 保护仍保留，避免无限重复同一个错误策略。

## Remote Agent GPU / Linux runtime compatibility

在 55301 的真实 scoped Remote Agent 环境中复现到：Agent 的 system metadata 能看到两张 RTX 5090，但 Agent 执行 `nvidia-smi` 返回 `Failed to initialize NVML: Unknown Error`；同一容器内 `/dev/nvidia4`、`/dev/nvidia5`、`/dev/nvidiactl` 等节点存在，驱动与 userspace 版本也一致。

进一步直接 `O_RDWR` 打开设备得到 `EACCES`，`cuInit(0)` 返回 304、`nvmlInit_v2()` 返回 999；同时 `/tmp`、`/var/tmp`、`/dev/shm`、`/dev/tty`、`/dev/ptmx` 也被 scoped 子进程拒绝。根因不是 GPU/容器失效，而是 1.1.43 的 Landlock write confinement 只给 writableRoots 和 `/dev/null` 放行。Linux Landlock 的 `WRITE_FILE` 同样约束 character device 的 `O_RDWR`，于是把 NVML/CUDA 正常设备访问误当成持久文件写入。

1.1.46 保留 writableRoots 的持久写边界，同时增加两类严格 runtime exception：

- 非持久 scratch：`/tmp`、`/var/tmp`、`/dev/shm`、`/dev/mqueue`、`XDG_RUNTIME_DIR` 或 `/run/user/<uid>`；
- 已存在且经 `stat.S_ISCHR` 验证的 runtime/accelerator character devices：常用 null/zero/random/TTY/PTMX、NVIDIA control/UVM/GPU nodes、DRM render/card、AMD KFD，以及 InfiniBand uverbs/rdma_cm/umad/issm。
- 动态 PTY slave：对 `/dev/pts` 目录只授予 `WRITE_FILE`，不授予创建/删除节点权限；这样 ptmx 打开后新出现的 `/dev/pts/<n>` 可以被当前 Linux 用户正常打开，恢复 `tty=true`、screen/tmux 和交互式 shell。

设备例外只授予 Landlock `WRITE_FILE`；runtime scratch 也显式移除 `MAKE_CHAR`/`MAKE_BLOCK`。因此不会因为兼容修复而允许创建设备节点、开放 block devices 或任意 `/dev` 目录写入；真实可访问性仍受 Linux DAC、容器 device cgroup 和驱动权限约束。这样 scoped Agent 的 GPU/PyTorch/NCCL 行为与同一 Linux 用户通过 SSH 执行时保持一致，同时项目持久数据仍不能越过 writableRoots。

控制端 `DEVSPACE_LINUX_AGENT_VERSION` 同步提升到 `1.1.46`。已登记且声明 `autoUpdate` 的旧 Agent 在重新连接 1.1.46 控制端时会由 Remote Agent manager 调用现有 `agent.selfUpdate`，校验 SHA-256 后原位替换 Agent 脚本并通过 Agent 自身的 `execv` 重载。因此这次 Landlock 修复不要求重新注册 Agent，也不会从旧受限子进程继承旧 Landlock 规则。

## Regression coverage

- Continuation SQLite migration/state machine、conversation scope 隔离、milestone/evidence completion gate、waiting-external gate、no-progress governor、原子 dedupe、cooldown 和 continuation budget 都有自动回归测试。
- Guard contract 明确检查 `ui/message`、`sendFollowUpMessage` fallback、timeout/watchdog、claim/release，且禁止 ChatGPT DOM 自动化路径。
- Linux Agent contract 检查 runtime scratch、动态 `/dev/pts` PTY、NVIDIA/DRM/KFD/RDMA character-device allowlist、`stat.S_ISCHR` 限制、控制端 1.1.46 auto-update 目标版本，并显式禁止 sd/nvme block-device exception。
