# DevSpace Portable 1.1.68 dev8 — 长任务 MCP 轮询与 Worker 授权续期

## 现场取证（2026-11-05）

- 09:20–09:40（北京时间），本地 Open WebUI 的 29 个 POST /mcp 请求均返回 HTTP 200；Windows MCP 日志中同期多个 write_stdin 调用正常 success=true，不少等待约 30 秒后成功返回。不能仅凭模型输出“抖动”断言 DevSpace 本地服务中断。
- 公网隧道日志中存在 Cloudflare stream canceled by remote with error code 0 和 DNS timeout。远端主动取消流不必然代表 origin 请求失败，也不能把这类错误直接归因于 Linux 训练进程。
- 同期还出现 MODEL_WORKFLOW_DELEGATION_EXPIRED。dev7 的强制 Worker 授权是固定起始时间的 5 分钟 TTL，完成委派后持续调用工具也不会延长授权，可能让长任务中途被拒绝。

## 修复

- **活动授权滑动续期**：同一 MCP 对话作用域与工作区里，每次成功获准的工具调用会刷新空闲授权 TTL（默认 5 分钟）。拒绝的请求无法续期；空闲超时、模型禁用／修订变更、策略修改仍立即使旧授权失效。保留绝对授权上限 24 小时，避免无限期持有旧授权。
- **长 Worker 生命周期**：保留运行中的 Worker、结果审查及单写入者约束；清理旧任务元数据时不再把正常长任务仅因创建超过 5 分钟而当成过期。
- **工具使用说明**：明确 write_stdin 返回 running=true 且无新增输出属于成功轮询；监控 55801 的 watcher/feed 时应直接读取持久化快照，或使用 process_attach 加 yieldTimeMs=0 获取即时状态，避免用反复 sleep 200/300/900 占用 MCP 请求。
- **保持兼容**：不改变 OAuth、Linux Agent 协议、进程输入输出语义、训练调度器、GPU 任务、云隧道进程，也不放宽强制 Worker 的跨会话权限。

## 验证范围与限制

- 门禁单元测试新增活动续期、拒绝请求无法续期、24 小时绝对期限的场景；保留跨 transport 同会话恢复与不同会话隔离。
- 对 Cloudflare 流取消只能从日志确认出现，无法凭此保证改善所有网络错误；本版本主要减少工具误用及授权误过期。
- 发行 ZIP 与实际部署分离；不覆盖当前 D 盘 DevSpace，不在 55801 重启、停用或修改训练队列。
