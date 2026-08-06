# DevSpace Deploy Portable

面向 Windows x64 的 DevSpace 便携部署、原生控制中心、Computer Use、插件管理、会话审阅与显式 Memories 集成项目。

当前稳定版本：**1.1.14**  
Portable Protocol：**1.5**  
上游核心：[`Waishnav/devspace`](https://github.com/Waishnav/devspace) `1.0.5`

> 本仓库只维护源码、构建脚本、测试、文档和体积可控的 Portable 核心分支。Node、Git、cloudflared、ngrok、完整 `node_modules`、运行状态与发行 ZIP 不进入 Git 历史；完整 Windows 便携包发布在 GitHub Releases。

## 下载

- 稳定版 ZIP：在本仓库的 **Releases** 页面下载 `DevSpacePortable-Windows-x64-<版本>.zip`。
- 每个 Release 同时提供 `update-manifest.json` 与 `SHA256SUMS-release.txt`，用于更新检查和完整性校验。
- 不要下载 GitHub 自动生成的 Source code ZIP 作为可运行程序；该压缩包只包含源码。

## 1.1.14 主要变化

- 原生 UI 执行操作时不再禁用或漂白整个主窗体，只有触发按钮显示“执行中…”；
- “会话与回退”改为会话列表与独立详情子页面，支持逐文件彩色差异；
- 新增显式 Memories 独立页面，可查看、搜索、新建、编辑和删除记录；
- Computer Use 保留会话级金色控制边框、批量动作及默认无截图低延迟路径；
- 会话审阅使用有界 `sparse-journal-v4`，避免大型工作区产生几十或上百 GB 的审阅副本。

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
$env:GH_TOKEN = "具有本私有仓库读取权限的 GitHub Token"
PowerShell -NoProfile -ExecutionPolicy Bypass -File scripts/hydrate-runtime-from-release.ps1 -Version 1.1.14
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

首次建立 1.1.14 基线 Release，或需要从维护机手工重新上传附件时，可运行：

```powershell
PowerShell -NoProfile -ExecutionPolicy Bypass -File scripts/publish-github-release.ps1 -Version 1.1.14
```

## 自动更新规划

1.1.15 起计划加入应用内更新检查与独立更新器。更新采用“下载到新版本目录、校验、切换指针、健康检查、失败回滚”，而不是覆盖正在运行的 EXE。设计见 [docs/UPDATE-DESIGN.md](docs/UPDATE-DESIGN.md)。

## 安全与隐私

以下内容绝不能提交或上传为 Release 源文件：

- `data/config/auth.json`、`ngrok.yml`、`cloudflare.token`；
- `data/state/devspace.sqlite` 及 OAuth Token；
- `logs/`、`reports/`、Computer Use 临时请求；
- 已部署目录的完整副本。

提交前运行 `npm run source:verify`。安全边界和漏洞报告方式见 [SECURITY.md](SECURITY.md)。

## 许可证与第三方组件

本仓库原创 Portable 集成代码采用 MIT License。DevSpace 上游代码保留其 MIT License；Node.js、Git for Windows、cloudflared、npm 依赖等保留各自许可证。

**ngrok Agent 为专有软件。** 当前私有 Release 可以作为内部协作基线，但在把仓库和 Release 改为公开之前，应移除随包 `ngrok.exe`，改为用户首次启用时从官方来源下载并校验，或取得明确的再分发授权。详情见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

## 参与维护

请通过分支和 Pull Request 提交修改，不要直接向 `main` 强推。开发、测试、版本号、更新日志和 Release 规则见 [CONTRIBUTING.md](CONTRIBUTING.md)。

