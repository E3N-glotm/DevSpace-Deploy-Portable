# Changelog

本文件提供版本索引；每个版本的完整设计、修复、测试和兼容性说明位于 [`docs/releases/`](docs/releases/)。

## 1.1.20

- 修复打开原生 UI 时可能依据陈旧 Computer Use Broker PID 误终止第三方进程的问题；
- Broker 停止前必须验证当前 PID 的可执行文件确为当前 Portable 的 `node.exe`、命令行包含当前 `computer-use-broker.cjs`，且 leaseId 与状态文件一致；身份不匹配时仅清理陈旧状态，绝不 `taskkill`；
- 新增启动期陈旧 PID 回归，使用外部 `PING.EXE` 模拟 EasyConnect/v2rayN 等无关进程并验证 `ui-open`/`ui-close` 不会结束它；
- 实机只读网络检查未发现 MCP/ngrok、sing-box 与 Sangfor 的监听端口重叠；本版不修改 EasyConnect、v2rayN、系统代理、WinHTTP 或路由；
- 继承 1.1.19 的更新下载、非递归停止、shutdown 与完整/增量更新安全机制，Protocol 保持 1.5。

[完整更新说明](docs/releases/HOTFIX-1.1.20.md)

## 1.1.19

- GitHub updater 改为 curl-first、有界代理失败切换、`--noproxy '*'` 直连 fallback、断点续传与低速超时检测；
- 原生 UI 增加更新下载百分比、字节数、实时速度、ETA、校验/解压阶段和当前网络路径显示，不再长时间只显示“执行中”；
- 更新器不启动、停止或修改 EasyConnect、v2rayN、WinINET/WinHTTP 系统代理；网络 fallback 仅作用于当前 GitHub 请求；
- 修复停止逻辑递归 `taskkill /T` 可能误杀第三方子进程的问题，改为仅按当前 Portable 根目录直接归属识别 PID，并逐个终止；
- “停止全部并退出”会保持任务禁用；卸载计划任务后执行第二次严格 PID 清理并 fail-closed，保证 UI/manager 退出后不应残留 Portable 后台进程锁定目录；
- 保持 `file-delta-v1` 增量优先、完整 ZIP 自动兜底、事务回滚和 Protocol 1.5。

[完整更新说明](docs/releases/HOTFIX-1.1.19.md)

## 1.1.18

- 显式 Memories 页面默认只展示所选工作区的 workspace Memory 与所有 global Memory，避免把其他项目的工作区记忆混在当前视图中；
- 新增“查看工作区”选择器与“显示其他工作区”开关，其他工作区 Memory 只有用户主动开启后才显示；
- Memory 列表增加“当前工作区 / 全局 / 其他工作区”范围标识与工作区列，并按范围和更新时间排序；
- 右侧新增只读“完整内容预览”，选择 Memory 后可直接查看标题、作用域、工作区、标签、更新时间和完整正文；
- 沿用 1.1.16+ 的增量优先、完整 ZIP 兜底更新机制；从 1.1.17 升级 1.1.18 时可使用精确版本增量包，Portable Protocol 保持 1.5。

[完整更新说明](docs/releases/HOTFIX-1.1.18.md)

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

