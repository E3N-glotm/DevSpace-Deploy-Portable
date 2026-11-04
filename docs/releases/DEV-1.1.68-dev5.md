# DevSpace Portable 1.1.68 dev5 — 异步强制 Worker 与工作区单写入者保护

dev4 的强制模型工作流要求 Worker 完成且读取最终结果后，才放行普通工作区工具，导致 GPT 无法在 Worker 推理期间继续独立读文件、检查源码和规划。dev5 将强制语义改为**必须显式提交委派任务**，而非**必须同步等待委派完成**。

## 调度行为

- 强制模式启用时，受控工作区仍需先执行 `model_worker_list` 与 `model_delegate_task`。委派成功返回任务 ID 后，GPT 可以立即使用 `read`、`read_attachment`、`show_changes`、日志与其他已分类的只读观察工具。
- 只读 Worker 运行时，GPT 可以继续独立工作，也可使用命令和代码编辑工具；只读 Worker 不会修改文件。若 Worker 失败，GPT 可在明确记录失败原因后自行接管。
- 允许写入的 Worker 运行时，GPT 可以继续规划和检查，但不能同时执行同工作区的潜在写操作（包括 `apply_patch`、`exec_command`）。Worker 结束后还需读取 `model_task_result`，才能解除该工作区的写入门禁。
- MCP Host 已进入写入工具调用时，Worker 不能启动该工作区的写任务。工作区写入租约覆盖受控 MCP 调用期间，并在调用结束或出错时释放。
- 同一服务进程内的多 MCP 会话共享 Worker 写入状态，避免其他会话绕过单写入者检查。即使关闭强制模型工作流，运行中的写入 Worker 也不会允许另一个 DevSpace Host 调用并发改写该工作区。
- Worker 的状态、调用次数、Token 用量仍通过 `model_task_status` 查询；GPT 负责最后独立验收，不将 Worker 自报成功视为测试通过。

## 安全与限制

- 写入互斥粒度为工作区，而不是文件：宁可短时间阻塞无关文件写入，也不允许一个未知 Shell 命令与 Worker 同时修改项目。
- 工作区租约覆盖 MCP 工具请求生命周期，不会追踪所有外部程序以及已经脱离 MCP 请求的后台进程。因此不能对 DevSpace 之外的编辑器、用户操作或持久后台写任务宣称全局原子互斥。
- 当前内置 Worker 依旧仅限本地工作区，不能将远程 Linux 工作区视为已完成委派。
- 门禁只能约束经过 DevSpace 的 MCP 工具，不能强制 ChatGPT 对不使用工具的普通回答调用 Worker。
- 服务重启后运行中 Worker 不会自动恢复；强制门禁的会话授权及写入占用状态也属于当前进程。
- 没有改变 OAuth、Owner Token、模型密钥、生产模型路由、正式安装目录或自动续轮的触发策略。

## 测试

- 门禁单元测试：异步提交、跨作用域隔离、TTL、模型禁用、读并行、写阻断、租约生命周期。
- Worker 运行时测试：调用统计、真实读写回调、跨路径拒绝、HTTP 错误、同工作区单写入者及 Host/Worker 排他。
- 使用隔离本地模拟模型与 OAuth/MCP HTTP 完整请求测试：委派后立即读、写入 Worker 期间允许读但拒绝执行命令、读取终态前拒绝写、读取最终结果后放行。
- 完整源码回归执行 `scripts/test-source.ps1 -SkipInstall -SkipAudit -SkipNativeBuild`，退出码为 0；生产依赖审计及完整发行包构建须独立验收。

此版本只在 E 盘源码和开发版 ZIP 中归档，不代表 D 盘 Portable 已升级。
