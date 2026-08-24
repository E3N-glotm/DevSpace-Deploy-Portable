# DevSpace Portable 1.1.44

## 修复目标

1.1.42 起 updater 后端已经支持 `block-pack-v2` 差分更新，并会优先返回 `preferredMode=blockmap`。但 1.1.42/1.1.43 的原生 `Update.exe` 只把 `incremental` 与 `incremental-chain` 识别为增量方式，导致 Blockmap 在界面上被错误归入“完整包”。同时，本地 SHA-256 扫描阶段复用了统一的字节进度字段，用户容易把本地扫描量误认为网络下载量。

1.1.44 不改变 blockmap 下载、校验、重组、事务 Apply/Rollback 或 fallback 协议，只修复 updater 的显示和进度语义。

## 主要修复

- `preferredMode=blockmap` 在检查更新页显示为 **Blockmap 差分增量更新**。
- 检查页不再显示完整 ZIP 大小作为 Blockmap 的“预计下载量”；改为说明先扫描并复用本地已有块、仅联网下载缺失块，同时保留 blockmap 索引大小与完整包 fallback 大小供用户判断。
- `updateMode=blockmap` 在暂存完成和最终安装结果中保持同一名称，不再被默认分支显示为“完整包更新”。
- `phase=analyzing + transport=local-sha256` 显示为 **正在分析本地可复用块**，详情明确标注 **不计入网络下载**。
- `phase=probing` 显示为 **正在选择 Blockmap Range 下载源**。
- Range 下载阶段显示为 **正在下载缺失文件块**；`reusedBytes/targetBytes` 可用时同步显示本地已复用体积。
- `phase=reconstructing` 显示为 **正在本地重组并校验目标文件**。

## 兼容性

- Portable Protocol：1.5，未变化。
- Linux Remote Agent：本版本无 Agent 协议或权限模型变化，不要求为 UI 修复单独升级 Agent。
- 更新优先级仍为：Blockmap differential → 传统 `file-delta-v1` 兼容路径 → 完整 ZIP fallback。
- 继续保留单条 `1.1.42 → 1.1.44` 传统 bootstrap delta，同时为 1.1.44 发布 blockmap 资产；1.1.42 及之后的 blockmap-capable 客户端按实际缺失块更新，不再为每个历史版本维护新的直达 delta。

## 验证要求

- 原生 Update.exe 编译与 `--self-test` 通过。
- standalone updater contract 必须验证 Blockmap 模式名称、本地扫描“不计入网络下载”、缺失块 Range 下载与本地重组状态文案。
- 完整 source/Portable regression suite 通过。
- GitHub Release 必须包含完整 ZIP、1.1.44 blockmap、`1.1.42 -> 1.1.44` bootstrap delta、`update-manifest.json` 与 `SHA256SUMS-release.txt`。
