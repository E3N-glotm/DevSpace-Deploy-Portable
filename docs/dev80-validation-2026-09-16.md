# dev80 发送生命周期竞态与实机验收记录

源码仅在 E:\program\Python\DevSpaceDeploy 迭代；D-live为 D:\DevSpacePortable。

## 本轮实机证据

2026-09-16 01:26 UTC，本Work会话卡片g3完成真实挂载，sender epoch13、asset revision 5321ddad0c0293e7、ACTIVE；全服务ACTIVE sender数为2。上轮sender全不可用的状态已经变化。

原验收会话generation7仍为DELIVERING，claimed_at=2026-09-15T17:01:22.559Z、updated_at=17:01:25.863Z，delivered_at/turn_acked_at为空。原卡g9为NEED_REBIND。原task的last_send_attempt_at仍是09:26:00.088Z，证明本次授权后没有记录发送结果，不能解释为已发送或已拒绝；没有重发、修改或人工ACK原generation。

## 已复现与修复

1. coordinator等待authorize-delivery期间dispose，返回accepted后仍发送Host消息；新增动态回归在修改前exit1，修改后guard exit0。已在强制入口及每次实际Host调用前检查disposed/superseded/connected，未增加发送前网络往返。
2. 已ACK且发生实质操作的generation收到迟到rejected，旧runtime将WORK_REQUIRED改为NO_WORK。以原generation token重现，修改前exit1；测试包含完整task/generation行前后比较。修复为已delivery/ACK/关闭状态不可由迟到传输回执回退，负面回执只可关闭CLAIMED/DELIVERING，原task ownership失效的回执被拒绝。

新增测试首次因从ACK响应读取已隐藏token而失败，该失败不构成运行时证据；改为从隔离fixture的generation账本获取原token后，才复现上述WORK_REQUIRED到NO_WORK状态回退。

## 未完成

修改后的clean安装、resident回归、完整源码回归、哈希校验、D-live部署与真实持续工作验收尚待完成。liveHostAcceptance=false。旧g7无回执的原因仍未证实，不将隔离竞态修复声称为历史事故根因。

## 01:40 UTC 验证进展

clean npm ci与better-sqlite3 rebuild exit0；后续最后一次core变更重新pack并逐文件刷新了400个包内文件，canonical/installed的runtime-state、server、coordinator完全一致。原生SQLite内存库查询通过。

guard exit0；resident 18 fixtures exit0，包括五类迟到回执与人工接管后的不回退断言；实际MCP wire exit0、ACK_BYTES=7185，epoch12/13以及两个App入口均通过迟到回执验证。首轮wire发现多余返回字段不符合严格schema，已删除该新增字段，未改变sender协议schema。人工接管后的旧回执仍返回拒绝。

已启动完整scripts/test-source.ps1 -SkipInstall，进程handle为dev80-source-regression，日志reports/dev80-source-regression.log与reports/dev80-test-progress.log，退出记录reports/dev80-source-regression-result.json；此时未取得完整测试最终结果，D-live尚未更新。
