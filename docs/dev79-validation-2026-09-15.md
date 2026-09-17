# dev79 缓存 sender 兼容修复与验收

## 已核实的 dev78 实机证据

E 盘源码目录：`E:\program\Python\DevSpaceDeploy`；D-live：`D:\DevSpacePortable`。

- 原会话 turn lease：`turn_f567e6a3-66b1-441a-8862-dc5566ab804c`。
- 2026-09-15 15:49:14.960 UTC，event sequence 459519：`continuation-host-timeout-inferred`，watchedProcessCount=2，elapsedTurnMs=1587264。
- 15:49:14.963 UTC，sequence 459520：synthetic generation 7 进入 READY。
- `dev78-cutoff-observer` 于 15:49:15.763 UTC exit 0，结束原因 `inferred-timeout-ready`；记录位于 `reports/dev78-cutoff-observer.jsonl`。
- `dev78-live-resident-acceptance` 于 16:22:00.967 UTC exit 0；181 次采样中 MCP 均存活。这只证明后台监控进程运行，不能证明模型持续工作。
- READY 后缓存 sender 继续报告 `sender-protocol-epoch-mismatch`：observed=12、expected=13、asset revision=`c71b36ee04631e0a`；未完成真实发送/ACK。

## 修改依据与边界

dev78 部署前备份的 coordinator 与 dev78 canonical 对比，唯一行为相关差异为 epoch 常量 12→13。双方使用相同的 sender wire、发送前 authorize-delivery 和 generation CAS；cutoff 推断与撤销属于服务端 RuntimeState。dev79 保留 current epoch13，在两处 App bridge 的共用兼容集合中明确接受epoch12，并按已有路径归一化到13。资产revision保留原值用于来源诊断。没有放宽 card、boot、turn、generation、manual takeover 或未知协议版本的校验。

旧 wire 回归使用不满足schema的 asset revision 字符串，不能据此证明版本门禁。现已改用合法16位revision，逐一验证两个App入口拒绝epoch11及未来epoch，并将完整发送/ACK及权限链路运行在缓存epoch12上；timeout、manual takeover和各类发送回执同时覆盖epoch12/13。

## 验证状态

- `setup/test-continuation-wire-contract.mjs`：exit 0，ACK_BYTES=7185；epoch12/13兼容、epoch11/未来版本拒绝、归一化lease、人工接管、发送授权及synthetic工作门槛均通过。
- 完整源码回归：exit 0，308542 ms，2026-09-15 17:18:38.518 UTC结束。日志 `reports/dev79-source-regression.log`、`reports/dev79-test-progress.log`，最终退出结果 `reports/dev79-source-regression-result.json`。guard、architecture、wire、supervisor、ATCC、resident、milestone及Portable UI回归均通过。
- 源码与D-live版本：1.1.59 dev79；manifest共208项均匹配，源码与部署共211项比对0差异；部署实际替换12个文件。
- 部署备份：`E:\program\Python\DevSpaceDeploy\workspace-archives\dev79-predeploy-2026-09-15T17-20-19-433Z`，包含12个旧文件和SQLite在线备份。
- 独立restart-local控制器于17:21:47.428 UTC完成，明确记录 `publicTunnelTouched=false`；新MCP PID=19572，doctor=6/6，UI启动PID=30252。
- 真实端到端与连续长时模型工作：未通过验收，`liveHostAcceptance=false`。历史时长推断不是Host提供的显式timeout事件，READY不能代替发送/模型ACK/持续工具工作的证据。

当前Work窗口被DevSpace识别为新的conversation scope，因此使用本窗口的Task Contract记录本轮工作；原会话observer和事件日志保持原样，不将本轮人工操作算入原无人干预验收。

## 新发现的独立实机阻塞

原会话在dev79部署前已于17:00:55 UTC出现新的epoch13 sender，并于17:01:25.864 UTC记录sequence459952 `continuation-generation-delivery-authorized`。generation7从READY进入DELIVERING，但截至17:24:07.749 UTC，`delivered_at`和`turn_acked_at`仍为空。因此epoch兼容修复不能被解释为已经解决授权之后的回执丢失。

dev79重启后截至上述快照，全服务ACTIVE sender数为0；原会话卡片g9保持VERIFIED但sender为NEED_REBIND，没有新的heartbeat。本Work窗口卡片g2于17:02:25.958 UTC申请挂载，到快照时仍为REQUESTED，mount_verified_at为空。没有伪造App mount、Host timeout、发送回执或synthetic ACK，也没有通过重复发卡制造另一张卡。

现有证据不能区分Host消息调用未完成、iframe冻结/销毁、回执返回丢失等原因。DELIVERING可能已发生不可逆发送，不能仅凭45秒租约到期重新发送，否则可能重复消息或打断迟到模型。下一步所需证据是原sender恢复后的真实Host调用结果、delivery receipt以及同一generation的模型ACK；当前没有存活sender可用于取得这些证据。本轮将实际Host验收记为外部阻塞，未标记最终成功。原始只读快照：`reports/dev79-live-host-snapshot.json`。
