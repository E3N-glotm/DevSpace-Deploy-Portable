# DevSpace Portable 1.1.59 dev75 验证记录

## 范围与实现

源码只在 E:\program\Python\DevSpaceDeploy 迭代。dev75 包含 migration 35、自动记录最近实质操作的有界 resume capsule、synthetic-execution-v3 ACK，以及发送前最终 model context 注入；ACK 不重复携带两份 capsule。

提前交接窗口由历史 cutoff、离散度及真实 READY→ACK 延迟计算。模型在工具边界签署后，READY/CLAIMED 只预留发送资源；真正发送仍须通过精确 turn lease、完成宽限期、无在途模型请求和当前任务可运行状态检查。timeout-recovery 与旧 schema checkpoint 兼容签署同样保留 prehandoff 标记。

显式用户接管使用 completionDisposition=await-user（旧 schema: checkpoint note=atcc-await-user），保留未完成里程碑并禁止自动发送；iframe reconnect 不得恢复，后续人工 status takeover 可以继续原计划或切换新计划。

## 本轮发现并修复

- 人工 takeover 曾只重置轮次却保留 WAITING_EXTERNAL，已在明确 await-user 来源下恢复 RUNNING 并清除等待原因。
- 旧 schema 提前交接曾写入普通 completion note，造成 timeout-recovery 接受签署后无法推进；已统一为 learned-host-cutoff-prehandoff。
- wire 测试曾将 READY→claim 视为立即发送许可；已增加完成宽限期内拒绝与到期后允许的实际 MCP schema 验证。

## 验证状态

最终七项回归均已 exit 0：guard、wire、ATCC、architecture、blockmap update、release migration、runtime cards；独立 source-tree 验证也 exit 0。wire ACK_BYTES=7185，上限仍为 8000。ATCC 覆盖两种模式及专用动作/旧 schema 两种签署入口的 READY→claim→authorize 完整链路，并覆盖人工更换计划及仅发送继续的恢复。

最终七项回归输出已保存到 reports/dev75/final-regressions.json（complete=true），单项日志位于同目录。dev75 原生程序与核心包已构建；20 个文件增量部署到 D-live 后，MCP PID 从 34968 变为 37992，doctor 6/6 正常，208 个 manifest 文件哈希一致，migration 35 已生效。隧道 PID 21968 与 supervisor PID 40908 未变，原生 UI 已启动为 PID 43444。新运行时已真实记录 resumeContext。

备份位于 workspace-archives/dev75-predeploy-2026-09-15T02-45-45-516Z，含替换前文件及一致性 SQLite backup，OAuth/Token 配置未修改。部署明细见 reports/dev75/deploy-copy.json。

当前任务 task_b2009381-6b2c-4686-8de9-2680dd48e43e 的卡片 generation 2 仍为 REQUESTED，sender 为 NEED_REBIND；未伪造挂载/ACK，也没有重复发卡。真实 automatic v3 ACK、续轮及时性与持续实质工作仍待验收，整体不能认定 PASS，未发布 GitHub Release。

## 验收边界

不能读取 Host 内部最终 prompt，capsule 提高 DevSpace 能保证的恢复信息量，但不证明 Host 获得了完整 transcript。历史 cutoff 推断不等于 verified Host timeout，也不能证明静默模型已停止；实际误触发、READY→ACK 时延及 ACK 后连续实质工作仍须分别观察。后台进程运行时长不计为模型工作时长。
