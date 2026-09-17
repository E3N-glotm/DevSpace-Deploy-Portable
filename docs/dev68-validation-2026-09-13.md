# DevSpace Portable dev68 自动续轮触发层修复记录

## 现场结论

2026-09-13 的真实长轮次测试使用 `timeout-recovery`，同一 Task Contract 持续运行到 ChatGPT Host 的硬截断窗口。截断前没有提前续轮；截断后也没有 READY、sender claim 或 synthetic ACK。

事件与 Task Contract 证据显示，故障发生在 sender 之前：

- 当前 ChatGPT Workspace App surface 暴露的 Host lifecycle method 只有 `ui/notifications/host-context-changed`、`ui/notifications/tool-input`、`ui/notifications/tool-result`；
- 实际硬截断后没有 `host-signal(timeout)` 或 `host-signal(teardown)`；
- `hostTimeoutSamples`、`continuationCount`、`deliveryGeneration` 在截断前均保持 0；
- 已存在两个独立且高度一致的真实硬截断观测：`1552000 ms` 与 `1555000 ms`；
- dev67 的 server 已实现 `learnedHostCutoffFallback()`，但 `inferLearnedHostCutoffTimeout()` 把触发模式硬编码为 `completion-driven`，因此 `timeout-recovery` 无法使用该兜底。

这形成一个确定性的死区：Host 不发显式 timeout，而 `timeout-recovery` 又被 server 的 learned-cutoff fallback 排除，因此没有任何合法路径可以把当前 turn 从 `GENERATING` 变为 `TIMED_OUT`，下游 READY/sender/ACK 根本不会启动。

## dev68 修改

`inferLearnedHostCutoffTimeout()` 的 learned-cutoff authority 现在同时适用于 `completion-driven` 与 `timeout-recovery`。下游原本已经支持 `timeout-recovery + TIMED_OUT + exact turn lease + CONTINUATION_ARMED` 进入 READY，因此不需要改变 sender、generation CAS 或 ACK 协议。

安全条件没有放宽为普通静默计时。推断仍必须同时满足：

1. Task 为 `RUNNING`，当前 assistant turn 为 `GENERATING`，且存在 exact current turn lease；
2. 至少两个**不同**的 cutoff 样本；
3. 样本 spread 不超过 median 的 5%；
4. 到达 `median + max(2% median, 2×spread)` 的自适应安全余量；
5. 当前 conversation 没有 in-flight model request；
6. 没有 resident process watch；
7. host cutoff regime epoch 与 task 保持一致。

一旦当前真实 turn 在 learned deadline 之后仍产生 substantive DevSpace 操作，现有 `touchContinuationModelActivity()` 会立即清空旧 cutoff 样本并推进 `cutoffEpoch`，因此不会用旧的 25 分钟 Host regime 抢占变长后的正常模型轮次。

## 针对性回归

新增 server/runtime 回归覆盖：

- `timeout-recovery` 只有一个旧 cutoff 样本，即使超过该值仍 fail closed，不生成 READY；
- `timeout-recovery` 有两个紧密聚类的独立 cutoff 样本，超过 adaptive deadline 后必须写入 `TIMED_OUT`、绑定 exact turn lease、记录 `learned-host-cutoff-watchdog`，并创建 synthetic `READY` generation；
- 必须产生 `continuation-host-timeout-inferred` 事件作为可审计证据。

下一轮 live 验收仍必须真实跑过 Host 硬截断，要求完整出现：

`GENERATING → learned cutoff inferred → TIMED_OUT → READY → sender claim → Host ui/message accepted → synthetic status ACK → ≥4 次 synthetic substantive work`。

在完整 live 链路出现前，不把自动续轮最终状态宣告为 PASS。
