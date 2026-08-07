# DevSpace Deploy Portable

面向 Windows x64 的 DevSpace 便携部署、原生控制中心、Computer Use、插件管理、会话审阅与显式 Memories 集成项目。

当前稳定版本：**1.1.16**
Portable Protocol：**1.5**  
上游核心：[`Waishnav/devspace`](https://github.com/Waishnav/devspace) `1.0.5`

> 本仓库只维护源码、构建脚本、测试、文档和体积可控的 Portable 核心分支。Node、Git、cloudflared、ngrok、完整 `node_modules`、运行状态与发行 ZIP 不进入 Git 历史；完整 Windows 便携包发布在 GitHub Releases。

## 下载

- 稳定版 ZIP：在本仓库的 **Releases** 页面下载 `DevSpacePortable-Windows-x64-<版本>.zip`。
- 每个 Release 同时提供 `update-manifest.json` 与 `SHA256SUMS-release.txt`，用于更新检查和完整性校验。
- 不要下载 GitHub 自动生成的 Source code ZIP 作为可运行程序；该压缩包只包含源码。

## 1.1.16 主要变化

- GitHub 在线更新改为“**增量优先、完整包兜底**”：与当前版本精确匹配时优先下载文件级增量包，增量缺失、损坏、基础文件漂移或校验失败时自动回退到完整 Portable ZIP；
- Release 同时发布完整 ZIP 和 `DevSpacePortable-Update-<旧版>-to-<新版>.zip`，增量包只携带变更文件与删除清单，并对基础文件和目标文件执行 SHA-256 校验；
- 修复会话详情中选择不同文件后仍显示整轮所有文件 patch 的问题；现在按 `jsdiff` 实际分隔格式精确提取当前文件，不再发生跨文件差异泄漏；
- 差异视图增加旧/新双行号 gutter，整体字体改为 Segoe UI Variable + Cascadia Code，并保留 Windows 字体回退；
- `data/`、`logs/`、`reports/`、OAuth 状态、插件、Memories 和会话审阅数据仍不会被在线更新覆盖。

> 兼容说明：已经安装的 1.1.15 更新器只认识完整 `asset`，因此 **1.1.15 → 1.1.16 对现有用户仍会下载一次完整 ZIP**。升级到 1.1.16 后，后续 1.1.17+ 才会由新更新器优先选择精确匹配的增量包；发布 1.1.15→1.1.16 delta 主要用于协议验收、镜像维护和新更新器回归。

完整历史见 [CHANGELOG.md](CHANGELOG.md) 和 [`docs/releases/`](docs/releases/)。

## 仓库结构

```text
app/                       Portable Node 应用入口、锁文件和插件调度器
vendor/waishnav-devspace/  受控的 DevSpace 1.0.5 Portable 核心包
setup/                     原生 WinForms、部署、隧道、测试和发行脚本
scripts/                   开发引导、核心打包、运行时恢复和仓库检查
docs/releases/             每个版本的完整 HOTFIX 更新说明
docs/acceptance/            历史验收记录
.github/workflows/         CI 与标签发行流程
```

`app/node_modules` 不是源码，不提交。当前 Portable 核心的可维护副本位于 `vendor/waishnav-devspace`；构建前由脚本将其打包为 `packages/waishnav-devspace-1.0.5.tgz`，再按 `app/package-lock.json` 安装。

## 开发环境

需要：

- Windows 10/11 x64；
- Node.js `>=22.19 <27`；
- Python 3.11+；
- Git；
- 维护 Release 时需要 GitHub CLI，可通过 `winget install --id GitHub.cli --exact --scope user` 安装；
- 构建原生 UI 时需要 Visual Studio Build Tools 和 .NET Framework 4.8 引用程序集。

首次克隆后执行：

```powershell
PowerShell -NoProfile -ExecutionPolicy Bypass -File scripts/bootstrap-dev.ps1
```

该脚本会：

1. 将 `vendor/waishnav-devspace` 打包到被 Git 忽略的 `packages/`；
2. 依据锁文件安装 `app/node_modules`；
3. 执行依赖加固与源码树检查；
4. 在本机具备 Build Tools 时编译 `DevSpace-Portable.exe`。

完整说明见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。

## 从 Release 恢复便携运行时

源码仓库不保存约 579 MiB 的 `runtime/`。需要构建完整 Portable ZIP 时，可从已有 Release 恢复固定运行时：

```powershell
PowerShell -NoProfile -ExecutionPolicy Bypass -File scripts/hydrate-runtime-from-release.ps1 -Version 1.1.16
```

脚本只从 Release ZIP 提取 `runtime/`，不会复制其中的用户配置、OAuth 数据、日志或 `data/`。

## 测试

```powershell
npm run source:verify
npm run core:pack
PowerShell -NoProfile -ExecutionPolicy Bypass -File scripts/test-source.ps1
```

CI 在 Windows runner 上执行源码边界检查、核心包打包、锁文件安装、原生 UI 编译、会话/Memory/插件回归和生产依赖审计。

## 发布

版本说明放在：

```text
docs/releases/HOTFIX-<版本>.md
```

创建并推送 `v<版本>` 标签后，Release workflow 会从上一稳定 Release 恢复运行时，重新安装依赖、执行测试、构建 ZIP、生成更新清单，并上传到 GitHub Release。详细流程见 [docs/RELEASING.md](docs/RELEASING.md)。

需要从维护机手工创建或覆盖 Release 附件时，可运行：

```powershell
PowerShell -NoProfile -ExecutionPolicy Bypass -File scripts/publish-github-release.ps1 -Version 1.1.16 -BypassProxy
```

## 在线更新

正式 Release 解压目录可在原生 UI 的“状态与部署”页面点击“检查更新”。从 1.1.16 开始，程序先寻找 `fromVersion` 与当前安装版本完全一致的 `file-delta-v1` 增量包；增量包会先验证下载大小、SHA-256、压缩路径、变更文件目标哈希以及当前基础文件哈希。只要增量路径不适用或任一预检失败，就自动改用完整 Portable ZIP。安装阶段继续使用同盘备份和事务回滚，`data/`、`logs/`、`reports/` 始终保留。

源码检出目录包含 `.git` 时，应用级在线更新会拒绝覆盖，请继续使用 Git 分支和 Pull Request 更新源码。当前更新器实现与后续签名、版本目录方案见 [docs/UPDATE-DESIGN.md](docs/UPDATE-DESIGN.md)。

## 安全与隐私

以下内容绝不能提交或上传为 Release 源文件：

- `data/config/auth.json`、`ngrok.yml`、`cloudflare.token`；
- `data/state/devspace.sqlite` 及 OAuth Token；
- `logs/`、`reports/`、Computer Use 临时请求；
- 已部署目录的完整副本。

提交前运行 `npm run source:verify`。安全边界和漏洞报告方式见 [SECURITY.md](SECURITY.md)。

## 许可证与第三方组件

本仓库原创 Portable 集成代码采用 MIT License。DevSpace 上游代码保留其 MIT License；Node.js、Git for Windows、cloudflared、npm 依赖等保留各自许可证。

**ngrok Agent 为专有软件。** 当前公开 Release 仍包含固定版本的内部便携运行时；继续公开分发前应确认具体再分发方式符合 ngrok 当前条款，或改为用户首次启用时从官方来源下载并校验。详情见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

## 参与维护

请通过分支和 Pull Request 提交修改，不要直接向 `main` 强推。开发、测试、版本号、更新日志和 Release 规则见 [CONTRIBUTING.md](CONTRIBUTING.md)。

