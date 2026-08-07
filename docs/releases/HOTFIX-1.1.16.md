# DevSpace Portable 1.1.16

1.1.16 将 GitHub 在线更新从“每次下载完整 Portable ZIP”升级为“增量优先、完整包自动兜底”，同时修复 1.1.15 会话详情中逐文件差异仍可能显示整轮 patch 的问题，并统一原生控制中心的现代字体体系。Portable Protocol 保持 1.5，MCP 顶层工具 Schema 不变。

## 增量优先、完整包兜底

- Release 继续发布 `DevSpacePortable-Windows-x64-1.1.16.zip` 作为完整安装与最终兜底包。
- 构建流程同时比较上一稳定 Release 与 1.1.16 完整包，生成 `DevSpacePortable-Update-1.1.15-to-1.1.16.zip` 文件级增量包。
- 增量格式为 `file-delta-v1`：ZIP 只保存新增或发生变化的文件；删除项写入 `delta-manifest.json`，不需要重复携带未变化的 Node、Git、runtime 或 npm 文件。
- `update-manifest.json` 升级到 schema 2，保留完整 `asset`，并增加按 `fromVersion` 精确匹配的 `incrementalAssets`。
- 更新器只有在已安装版本与增量包 `fromVersion` 完全一致时才尝试增量；跨多个版本、找不到增量时直接使用完整 ZIP，不要求逐版升级。
- **已安装的 1.1.15 更新器本身尚不认识 `incrementalAssets`，所以普通用户从 1.1.15 升到 1.1.16 时仍会完整下载一次 1.1.16 ZIP。** 1.1.16 安装完成以后，后续版本才正式进入“增量优先、完整包兜底”的选择流程；本次仍发布 1.1.15→1.1.16 delta，用于验证新协议、镜像场景和新更新器回归。
- 增量下载后校验 Release 资产大小、SHA-256、压缩路径、delta manifest、所有目标文件 SHA-256，并在真正关闭 UI 前校验将被替换或删除的本地基础文件 SHA-256。
- 增量包缺失、损坏、格式不合法、路径不安全、目标文件校验失败或本地基础文件发生漂移时，同一次更新流程自动切换到完整 ZIP。
- 增量安装只备份、替换和删除明确列出的路径；完整包安装继续采用顶层应用 payload 替换。两种模式都保留 `data/`、`logs/`、`reports/`，并共享同盘备份与失败回滚。

## 修复逐文件差异串页

- 1.1.15 的提取器优先查找 `diff --git`，但当前 `sparse-journal-v4` 使用 `diff` 包的 `createTwoFilesPatch`，实际输出以 `===================================================================`、`--- a/<path>`、`+++ b/<path>` 分隔，不包含 `diff --git`。
- 因此旧逻辑在找到 `+++ b/<path>` 后会把 block 起点错误回退到整个 patch 的第 0 字符，造成截图所示“标题已经切换到 README/YAML，但下面仍显示 DEVELOPMENT_STATUS 及其他文件”的问题。
- 1.1.16 直接识别 `createTwoFilesPatch` 的真实分隔格式，以连续 `--- a/path` / `+++ b/path` 精确定位文件，并在下一个分隔线或 `diff --git` block 前截断。
- 二进制、大文件和 unsupported path 使用独立路径标记匹配；无法可靠找到当前文件时返回空状态，绝不回退展示整轮 patch。
- 新增真实原生 EXE 回归：构造三个连续 jsdiff 文件块，分别选择中间文件并验证输出不包含前后文件内容。

## 差异视图与字体

- 深色 diff 视图从“patch 内部顺序号”改为接近 PyCharm/Codex 的旧行号 + 新行号双 gutter；新增、删除、上下文和 hunk 会分别推进正确的行号计数。
- 代码和差异区域优先使用 `Cascadia Code`，回退到 `Cascadia Mono` / `Consolas`。
- 原生 UI 正文、按钮、导航、表格、提示和对话框优先使用 `Segoe UI Variable Text`，大标题使用 `Segoe UI Variable Display`；未安装时自动回退到 Windows 系统字体，不随程序分发字体文件。
- 保留原有浅色控制中心与深色 diff 的视觉层级，不改变现有 Computer Use、Memories、插件与部署布局。

## 发布与测试

- Release workflow 会保留上一稳定版完整 ZIP 作为 delta 构建基线，构建 1.1.16 完整 ZIP 后自动生成增量 ZIP，并将两者连同 `update-manifest.json`、`SHA256SUMS-release.txt` 一起发布。
- 新增 `setup/test-incremental-update.py`：使用微型 1.1.15/1.1.16 ZIP 验证 changed-only、delete manifest、persistent root 排除和 base SHA-256。
- 新增 `setup/test-selected-file-diff.mjs`：执行原生 `DevSpace-Portable.exe --diff-extract-test`，验证 jsdiff 分隔符、单文件隔离、双行号 gutter 和字体配置。
- 继续执行原生 UI、Memory CRUD、稀疏会话、插件、Computer Use、在线更新安全边界和生产依赖审计回归。
