# DevSpace Portable 1.1.45

1.1.45 聚焦 Blockmap 差分更新在真实 Windows 网络环境中的稳定性和速度。1.1.44 已能正确显示 Blockmap 更新，但一次 1.1.42 → 1.1.44 的真实升级暴露出：128 KiB 的短 Range probe 会把吞吐很低的 GitHub 官方直连误判为健康线路，随后 4.72 MiB header 在固定 45 秒超时内无法收完，最终触发 file-delta fallback；同时同一安装目录曾出现两个 Stage 重叠运行。

## Range 路由

- 路由优先级固定为 **镜像站 → Windows/显式代理 → 官方直连**。
- 镜像站使用直接 Range 请求并并行测速；只要该优先级存在健康候选，就不会提前进入代理或官方直连。
- 镜像不可用时，使用 PowerShell 已检测并验证的 Windows 系统代理或显式代理访问官方 GitHub Release。
- 最后才尝试官方直连/TUN，避免低吞吐直连抢占更快的镜像或本地代理。
- 每一级内部按照 1 MiB probe 的实测吞吐、总耗时和 TTFB 排序。

## 更可信的探测与 Range 下载

- probe 大小从 128 KiB 增加到 **1 MiB**，与 blockmap 默认内容块大小一致。
- probe 最大时间为 12 秒，可过滤“很小请求能完成、持续吞吐却不足”的线路。
- 正式 Range 的超时根据 probe 吞吐动态计算，范围限制在 30～180 秒，不再所有请求固定 45 秒。
- 真实 Range 请求在当前 tier 全部失败时先重新测速一次；仍失败则自动进入下一优先级并继续当前 Range，不立即放弃整个 Blockmap staging。

## Header 与缺失块分段

- Blockmap compressed header 按 **1 MiB** 分段下载，每段独立验证 HTTP 206 和长度，全部拼接后仍执行原有 header SHA-256 与 zlib/JSON 校验。
- 缺失块连续 Range 的最大合并长度从 16 MiB 收紧到 **4 MiB**。这会略微增加 Range 请求数量，但显著减少慢速或抖动链路失败时需要重新传输的数据量。
- Chunk SHA-256、重组文件 SHA-256、目标 VERSION-MANIFEST 版本验证均保持不变。

## 可诊断性与并发保护

- Blockmap helper 直接向 `logs/update.log` 写入每个 1 MiB probe 的 PASS/FAIL、source、是否代理、耗时和速度，以及最终选中的 tier 和后续 failover。
- `portable-updater.ps1 Stage` 使用按 Portable 根目录派生的 Windows named Mutex。同一安装目录同时启动第二个 Stage 会立即拒绝，不再出现两个 helper 同时进行 SHA-256 扫描、Range 下载和 staging 写入。
- Mutex 为进程所有；异常退出由 Windows 以 abandoned mutex 语义回收，下一次 Stage 可以安全接管，不依赖容易遗留的 lock 文件。

## 兼容性

- 更新策略仍为 `blockmap-first-full-fallback`，Blockmap 不可用时继续使用既有 file-delta/full fallback。
- 1.1.45 仍发布 `1.1.42 -> 1.1.45` legacy bootstrap delta，供早期 1.1.42 updater 兼容升级。
- Portable Protocol 保持 1.5；本版没有修改 Linux Remote Agent 协议或权限模型，因此不要求为 updater 修复升级 Remote Agent。
