# 正式版发行流程

GitHub Release 是 Windows 完整包和在线更新附件的发布入口。正式版的 Git 标签、版本清单、发布说明和附件应对应同一版本。

## 准备版本

1. 在最新 `main` 的发布工作区构建。保留本机运行目录和用户数据。
2. 同步 Portable、桌面和 MCP 界面的版本标识。正式版 `VERSION-MANIFEST.json` 使用 `X.Y.Z` 显示版本，移除 `development` 字段。
3. 更新 `CHANGELOG.md`，并为新版本添加 `docs/releases/HOTFIX-X.Y.Z.md`。
4. 从上一个正式版恢复发行运行时，准备 Electron 运行时并构建界面。固定版本和准备步骤见 [.github/workflows/release.yml](../.github/workflows/release.yml)。

在发布工作区执行构建和检查。将示例版本替换为本次版本。

```powershell
$Version = '1.1.68'
npm run core:pack
npm ci --prefix app
node setup/harden-nested-dependencies.mjs
npm ci --prefix ui-next
npm run build --prefix ui-next
python setup/finalize-release.py $Version --hotfix "docs/releases/HOTFIX-$Version.md"
npm run source:verify
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-source.ps1 -SkipInstall -SkipAudit
npm audit --omit=dev --prefix app
python setup/build-release.py
```

打包预检会检查核心 TGZ、锁文件、已安装核心及源码行尾。按顺序运行 `core:pack` 和 `npm ci --prefix app`，使测试与最终包使用同一份核心代码。正式包包含发行自带的 `codex-runtime-bridge` 插件，并保留用户配置与运行数据和程序文件之间的边界。

## 自动发布与附件

提交正式版源码后创建并推送注解标签。仓库变量 `DEVSPACE_RELEASE_APPROVED` 为 `true` 时，推送 `vX.Y.Z` 标签会触发 GitHub Actions 的 Release 构建。工作流从低于目标版本的最近稳定版恢复运行时，然后执行测试、生产依赖审计、打包和上传。

当前正式版应包含以下附件。文件名示例使用 1.1.68。

| 附件 | 用途 |
| --- | --- |
| `DevSpacePortable-Windows-x64-1.1.68.zip` | 全新安装或完整包恢复 |
| `DevSpacePortable-Windows-x64-1.1.68.blockmap` | 复用本机文件块并通过 HTTP Range 下载差异 |
| `DevSpacePortable-Update-<起始版本>-to-1.1.68.zip` | 兼容指定旧版本的升级桥 |
| `update-manifest.json` | 更新器读取的版本、附件和 SHA-256 信息 |
| `SHA256SUMS-release.txt` | 完整 ZIP、blockmap 和升级包的校验清单 |

GitHub 的 **Source code** 归档用于查看源码。发行完成后，核对 Release 的正式状态、Latest 指向和各附件的上传状态、大小与 SHA-256。Git 标签和工作流状态用于追踪构建，不替代附件验证。

## 手动发布

GitHub 托管运行器无法完成桌面交互测试时，可在可用 Windows 桌面上对相同标签提交完成全量源码和 Portable 回归、生产依赖审计及打包，再使用仓库的手动发布路径。保留工作流故障和本地验收记录。

1. 用 `setup/build-release.py` 生成完整 ZIP 和升级桥。
2. 用 `setup/create-blockmap.py` 以该 ZIP 生成同版本 `.blockmap`。
3. 用 `setup/create-update-manifest.py` 指定 ZIP、blockmap、当前升级桥和工作流适用的上一版更新清单，生成本次的两份清单。
4. 校验 ZIP 的 CRC、包内版本、blockmap 头，以及所有附件的大小和 SHA-256。先上传到对应标签的 GitHub Release 草稿，再核对实际上传结果并公开。也可参阅 [GitHub CLI 发布脚本](../scripts/publish-github-release.ps1)。
5. 只有在有意重新制作同版本发行包并完成兼容性复验时，才替换已有同名附件。

生产运行时来源、凭据及打包边界见 [安全政策](../SECURITY.md)。公开分发第三方运行时前核对 [第三方许可](../THIRD-PARTY-NOTICES.md)。

## 版本兼容

- 1.1.59 为开发系列，1.1.60 已撤回。稳定升级桥从 **1.1.61** 开始，受支持的旧版本由 [升级策略配置](../setup/legacy-release-policy.json) 定义。
- 当前原地升级的校验范围从 1.1.36 起，具体纳入的历史版本见升级策略。1.1.61 之后的正式版沿用历史更新清单，并按策略发布 1.1.61 以及 1.1.36–1.1.39 到目标版本的直接升级桥。旧更新器先安装兼容桥，必要时再由新更新器完成同版本的完整包修复。
- 1.1.40–1.1.42 的迁移包和 1.1.33 救援包属于历史兼容安排。当前发布附件以对应 Release 的更新清单为准。
- 用户持久数据与程序文件分别处理。完整包包含固定的内置插件种子，在线升级保留已有用户配置和运行数据。

需要补齐两个已发布版本之间的差异更新时，可使用 [Backfill Incremental Update 工作流](../.github/workflows/backfill-incremental.yml)。该流程以既有正式 ZIP 生成补充附件。
