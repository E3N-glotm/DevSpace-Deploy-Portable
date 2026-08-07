# Changelog

本文件提供版本索引；每个版本的完整设计、修复、测试和兼容性说明位于 [`docs/releases/`](docs/releases/)。

## 1.1.17

- 完整 Portable ZIP 直接预置 `data/plugins/installed/codex-runtime-bridge/<版本>/`，与 PluginManager 实际安装路径一致，并移除错误的根目录 `plugins/installed/...` 布局；
- 发布构建自动把 `setup/bundled-plugins/` 镜像到 `plugins/installed/`，并在打包前校验 Codex Runtime Bridge 的 manifest、runtime 和 Skill；
- 正式部署优先从 Release 内 `plugins/installed/` 向持久化的 `data/plugins/installed/` 做非破坏性 seed，用户插件状态仍由 `data/` 持久化；
- GitHub updater 增加 TLS 1.2、最多 3 次有界重试和 `curl.exe` fallback，覆盖 Release metadata、manifest、增量包及完整包下载；
- Portable 与服务端版本统一为 1.1.17，Protocol 保持 1.5。

[完整更新说明](docs/releases/HOTFIX-1.1.17.md)

## 1.1.16

- GitHub 在线更新升级为文件级增量优先、完整 ZIP 自动兜底；
- 增量包包含变更文件、删除清单、基础 SHA-256 与目标 SHA-256，基础文件发生本地漂移时自动回退完整包；
- 修复会话详情选择文件后仍渲染整轮 patch 的 bug，兼容 `jsdiff createTwoFilesPatch` 的分隔格式；
- 差异视图增加旧/新双行号 gutter，并切换到 Segoe UI Variable / Cascadia Code 现代字体体系；
- Portable 与服务端版本统一为 1.1.16，Protocol 保持 1.5。

[完整更新说明](docs/releases/HOTFIX-1.1.16.md)

## 1.1.15

- 新增公开 GitHub Release 在线检查、下载、校验、受控重启和失败回滚；
- 会话历史按名称分组，分组及组内轮次均按最近更新时间倒序；
- 文件差异改为现代深色逐文件视图，未选择文件时不再展示整轮 patch；
- 关闭窗口可选择最小化到系统托盘或仅退出控制中心，并可记住选择；
- Portable 与服务端版本统一为 1.1.15，Protocol 保持 1.5。

[完整更新说明](docs/releases/HOTFIX-1.1.15.md)

## 1.1.14

- 修复原生 UI 操作期间整个内容区域变白；
- 会话审阅改为列表与详情子页面；
- 新增显式 Memories 管理页面；
- Portable 与服务端版本统一为 1.1.14，Protocol 保持 1.5。

[完整更新说明](docs/releases/HOTFIX-1.1.14.md)

## 1.1.13

- Computer Use 金色边框改为会话级保持；
- `computer_action` 默认不返回截图，观察帧改为显式请求。

[完整更新说明](docs/releases/HOTFIX-1.1.13.md)

## 1.1.12

- 增加多显示器金色控制边框；
- 增加批量动作和进程内 `SendInput`；
- 收紧 Computer Use 队列与响应轮询。

[完整更新说明](docs/releases/HOTFIX-1.1.12.md)

## 1.1.11

- 使用有界稀疏审阅日志替代全目录 shadow Git；
- 修复大型目录审阅导致的 P0 磁盘膨胀；
- 加固服务启停、计划任务和 Codex Runtime Bridge Doctor。

[完整更新说明](docs/releases/HOTFIX-1.1.11.md)

## 更早版本

从 1.0.1 到 1.1.10 的完整记录均保存在 [`docs/releases/`](docs/releases/)。

