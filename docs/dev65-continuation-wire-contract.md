# DevSpace Portable dev65 自动续轮协议修复记录

日期：2026-09-12。源码目录：`E:\program\Python\DevSpaceDeploy`；基线提交：`3159d6d`。本次未创建其他工作树。

## 已证实的问题

1. **续轮控制工具的输出 schema 不完整。** 真实 MCP SDK Client 在接收 `continuation_sender` 绑定回复时因未声明字段抛出 `-32602`，而服务端 sender 租约已经写为 `ACTIVE`。因此数据库显示绑定成功，不能证明客户端拿到了可用回复。旧 same-source anchor bridge 的状态回复还缺少 `syntheticOwnerActive`、`syntheticTokenPending` 等字段；授权、交付回执也有额外字段。
2. **普通工作工具也存在同类协议缺陷。** 加入真实 ACK 后的 `open_workspace` 调用，复现了 `devspacePreFinalBarrier` 未声明导致的 `-32602`。通用包装器会附加 task/taskContract/barrier，但注册输出 schema 时没有同步声明，可能使已经成功的工作操作被客户端视为失败。
3. **明确超时信号后的调度仍使用旧租约期限。** task 进入 `TIMED_OUT` 后没有立即更新 workset 的到期时间，独立测试第一次 sweep 无法产生 READY；修复后已验证无需等待旧活动租约到期。

此前关于 iframe URI、跨工具路由或客户端天然不支持的部分解释仅是假设，不能继续当作根因。本轮 live g3 已真实挂载并注册 sender，常规日志未出现 RPC 名称也不能证明 App 调用未发生。

## 修改

- task、anchor、sender 三个续轮控制入口使用同一份完整输出字段定义，继续拒绝未声明的顶层字段。
- 通用 App 工具包装器在注册阶段声明自身附加的任务与结束前状态字段；不改工具输入、权限检查和执行逻辑。
- 已验证的 timeout/匹配 completion intent 的 teardown 立即更新 workset 调度期限；普通 teardown、请求静默和租约过期仍不能冒充结束信号。
- 增加 `setup/test-continuation-wire-contract.mjs` 并接入源码测试流程。测试使用独立临时目录、数据库、OAuth 身份和随机监听端口；不写 live 任务或认证数据。
- 协议测试先确认安装副本与 canonical 源码一致，避免测试到旧 server/runtime/coordinator。

## 验证证据

2026-09-12 09:15 UTC，以下四项在最终行为代码上顺序运行并全部 exit 0：

- `setup/test-continuation-wire-contract.mjs`：真实 HTTP MCP + SDK 输出校验；覆盖主入口和旧桥接、绑定/心跳/READY/claim/authorize/receipt/ACK；ACK 后实际打开 workspace、读文件、执行 Node 命令、apply_patch 再读取结果；验证人工接管拒绝旧授权和旧回执、重复领取禁止重发、发送失败/拒绝、fallback 回执、精确租约超时和 synthetic 实质工作门槛。
- `setup/test-continuation-guard.mjs`。
- `setup/test-continuation-architecture.mjs`。
- `setup/test-assistant-turn-completion-contract.mjs`。

测试中的 Host 交付回执和 ACK 是独立场景模拟，不是用户 ChatGPT 会话真实自动启动的证明。

## 部署与最终验收

09:20 UTC 已完成 D-live 增量部署与重启：`1.1.59 dev65`，MCP PID `34792`，native UI PID `34044`；Cloudflare PID `19576` 未变化。桌面 EXE 首次替换遇到 EBUSY，旧 UI 退出后重试成功，已确认运行副本与新构建一致。未重建完整 ZIP，旧同名 ZIP 不代表 dev65。

本轮 taskId 为 `task_7ccc76ca-476d-4ed8-9eb2-3a599d0e77c9`，卡片 generation 为 3；重启后沿用原卡，sender 已绑定新 server boot 并保持 ACTIVE，09:20:14 UTC 有真实心跳。源码及部署回退文件位于 `workspace-archives/dev65-live-2026-09-12T09-17-36-390Z`。

真实 Host 最终验收仍待本轮结束后的 sender claim、Host 交付、自动模型首轮 status ACK 及后续实质工作。达到四个操作只是防空转下限，不是提前结束任务的理由。真实闭环完成前不发布 release，不声称自动续轮已经完全正常。

