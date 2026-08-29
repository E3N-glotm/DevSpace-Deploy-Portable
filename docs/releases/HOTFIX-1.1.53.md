# DevSpace Portable 1.1.53

1.1.53 收口的是 1.1.50～1.1.52 仍然存在的一条底层 UI 状态机缺口：服务端曾经把 `continuation_anchor` 的“结果已经发给 Host”近似成“Workspace App iframe 已经真实挂载”。在 ChatGPT 对 MCP App iframe 延迟创建、懒加载或丢弃 UI 结果的情况下，SQLite 会留下 `anchor_mount_requested_at`，但 `anchor_mount_verified_at` 与 coordinator 仍为空。旧逻辑看到 requested 时间后便永久停止再次挂载，于是同一 conversation 后续 DevSpace 工具可以继续运行，却始终没有用户可见的里程碑卡。

## 新的 requested / verified 边界

1.1.53 明确区分三个阶段：

1. **requested**：服务端已经签发当前 generation 的 mount token，并把 UI-bearing result 交给 Host；这只是 provisional 状态。
2. **mounted / verified**：Workspace App iframe 已启动，并携带当前 token 与 coordinator identity 回调服务端；只有此时才写入 `anchor_mount_verified_at`。
3. **superseded**：如果未验证的旧 generation 已经失效，后来才被 Host 懒加载出来，iframe 会先读取 authoritative task generation，确认自己过期后立即停用，不再发送 heartbeat、mount ACK 或自动续轮消息。

因此，“调用过一次 `continuation_anchor`”与“用户实际看到且正在工作的卡片”不再混为同一状态。

## Ghost-anchor 恢复

未验证的 requested anchor 不会无限阻塞 conversation。1.1.53 为其增加 `anchor_mount_generation` 与 `anchor_mount_host_turn_hash`：

- 首次签发从 generation 1 开始；
- 同一个 Host assistant turn 内重复检查不会旋转 generation，也不会制造第二张可见卡；
- 如果新的 Host turn 到来而旧 generation 仍没有 ACK，服务端会把它判定为 ghost issuance，旋转 token/generation，并允许重新挂载；
- Host 没有提供可用 turn hint 时，使用与已确认 Host turn limit 对齐的有界 provisional timeout，默认 30 分钟、限制在 10～45 分钟范围内，避免永久锁死；
- 一旦任意 generation 成功 verified，该 conversation 的 anchor 恢复条件永久关闭，后续普通工具调用不会生成新卡。

Host turn hint 仅以 SHA-256 截断后的不透明指纹落库，原始请求 header 不记录、不输出。

## Pre-workspace 单卡契约

conversation Task Contract 可能在第一个 workspace 打开之前就自动创建。旧 1.1.52 的服务端引导要求“先调用 `continuation_anchor`，暂时省略 workspaceId”，但发布出去的 MCP schema 却仍将 `workspaceId` 声明为必填，形成无法执行的 precondition。

1.1.53 将 `continuation_anchor.workspaceId` 改为可选。这样首次 conversation 可以先真实挂载唯一一张 Task Contract 卡，随后 `open_workspace` 只把该 task 绑定到当前执行 workspace；切换 workspace 也继续复用同一个 conversation task/card，而不是为每个目录建立 shadow task。

## 数据迁移与兼容性

SQLite migration 28 只为 `continuation_tasks` 增加：

- `anchor_mount_generation integer not null default 0`
- `anchor_mount_host_turn_hash text`

既有 `anchor_mount_verified_at` 保持原样。因此已经真实 ACK 的 1.1.52 卡片升级后继续被视为已验证，不会因为服务重启或 migration 自动重挂；只有 requested-but-unverified 的历史 ghost task 才进入新的恢复判定。

Protocol 仍为 **1.5**，Remote Agent wire protocol、OAuth、权限模型、插件数据与用户 `data/` 均不需要重建。

## 回归覆盖

`setup/test-continuation-guard.mjs` 新增/扩展覆盖：首次 generation、同 turn provisional 去重、跨 Host turn ghost recovery、旧 token 拒绝、旧 iframe supersede、verified 永久抑制、conversation 单 task/单卡、substantive tool gate、pre-workspace anchor schema，以及原有 synthetic continuation / manual takeover / completion-driven 恢复协议。

## 发行包状态隔离

1.1.53 的最终 archive 自审额外发现：源码 checkout 中保留的 live rollback 快照目录可能包含 `auth.json` 与 `devspace.sqlite`。这些文件用于本机恢复，但不属于程序源码，也绝不能进入公开 Portable ZIP。构建器因此增加两层长期防线：

- 顶层 `workspace-archives` 与既有 `release-output`、`data`、`logs` 等运行目录一样，从 release walk 中整体排除；
- `release_files()` 生成清单后、checksum/ZIP 之前再执行内容无关的路径安全校验，任何名为 `auth.json` 或后缀为 `.sqlite` / `.sqlite3` 的文件都会直接中止构建，而不是依赖某个特定备份目录名称。

校验只检查相对路径和文件名，不读取认证文件或数据库内容。`setup/test-release-plugin-layout.py` 同时覆盖备份目录排除以及两个 fail-closed 样例，防止今后的构建规则回退。
