# Changelog

本文件提供版本索引；每个版本的完整设计、修复、测试和兼容性说明位于 [`docs/releases/`](docs/releases/)。

## 1.1.29

- 本地 MCP 与公网 tunnel 拆成真正独立的生命周期：保存/部署默认只安装并启动 `127.0.0.1` MCP，公网 tunnel 任务默认保持禁用，只有用户明确点击“启动公网隧道”才启用；本地启动不再要求 ngrok/cloudflared runtime 或 tunnel Token；更新/任务修复会保留已有 tunnel 的 enabled/disabled 状态，不会把用户关闭的 tunnel 自动重新打开。
- 首页自动刷新彻底取消主动公网回打，只做本地回环、任务、PID 和 tunnel agent 的被动检查；公网 OAuth/HTTP 验证仅在用户进入“详细信息”并明确执行验证/诊断时发起，避免企业 VPN 会话中每 3 秒产生额外公网连接。
- tunnel supervisor 不再因为第三方网卡、地址或路由拓扑变化主动停止/重连 ngrok/cloudflared；这些变化仅只读记录。只有 DevSpace 自己的显式代理配置变化、显式本地代理失效或 tunnel 子进程真实退出时才管理自己的子进程。
- tunnel 子进程继续清空继承的 `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` 等环境变量；只有用户显式配置的 DevSpace tunnel 代理才会注入，因此 v2ray/Clash/sing-box 的系统代理开关不会自动成为 DevSpace tunnel 的依赖。
- 新增只读 Windows 系统代理诊断，可识别“ProxyEnable 仍开启但 `127.0.0.1` 代理端口无人监听”的失效代理状态；只有用户明确点击修复时才关闭该系统代理，并保存可恢复备份。正常启动、状态刷新、tunnel 运行均不写系统代理、DNS、路由、网卡或第三方进程。
- 新增网络隔离契约回归，覆盖本地/tunnel 分离、默认 tunnel opt-in、首页零主动公网探测、拓扑变化不重启 tunnel、环境代理隔离和厂商无关性；Portable Protocol 仍为 1.5。

[完整更新说明](docs/releases/HOTFIX-1.1.29.md)

## 1.1.28

- 修复首页探测器用同步公网 curl 阻塞 Node 事件循环，导致健康本地 MCP 偶发显示 `0/0` 并标红的问题；回环探测改为独立直连，公网探测异步并发；
- 本地状态刷新缩短为 3 秒；成功公网验证缓存 15 秒，失败结果仅缓存 2 秒；部署操作和详细信息刷新完成后主动同步主页，监听存在但一次传输检查未完成时进入复核态而不是立即报错；
- 厂商无关地观察所有已连接 IPv4 网卡、地址和活动路由；任一拓扑变化会立即静默 DevSpace 自有公网 tunnel 与公网探测，本地 MCP 不停止，完整拓扑连续稳定 15 秒后才恢复；
- 不再自动把 WinINET/环境本地代理注入 ngrok；只有用户显式 `proxy_url` 才使用代理，否则遵循 Windows 系统选路，避免依赖部分 ngrok 账号不支持的代理功能；
- 公网诊断严格跟随 tunnel 已选出口，不跨显式代理/系统路由回退；新增慢代理、静默窗口、分流路由与 BOM 配置回归，策略保持厂商无关、只读网络观察和第三方零修改；Portable Protocol 仍为 1.5。
- Release 构建排除 1.1.27 曾误打包的源码本地测试输出 `true`；增量更新按基线哈希移除正式副本中的该构建杂质。

[完整更新说明](docs/releases/HOTFIX-1.1.28.md)

## 1.1.27

- 修复独立更新器在 Portable 计划任务缺失、被外部清理或定义过期时，文件替换完成却因直接执行 `start` 而安装失败的问题；
- 更新事务在目标文件校验后统一执行“重建任务 → 启动服务”，回滚路径也会在恢复旧文件后重建旧版本任务并恢复服务；
- 回滚结果持久记录文件恢复、服务恢复、回滚错误和保留备份位置，不再无条件宣称回滚成功；控制中心自动启动失败不再撤销已经成功的程序更新；
- PowerShell 后端输出结构化失败结果，并为旧版 `Update.exe` 保留包含真实原因的最后一行；新版更新窗口优先读取结构化错误和 `update-progress.json`，不再显示无意义的 `FullyQualifiedErrorId`；
- 新增隔离的真实 Apply 回归，覆盖缺任务自动修复、强制启动失败、旧文件恢复、任务重建、旧服务恢复和错误透传；Portable Protocol 仍为 1.5，顶层 MCP Schema 不变。

[完整更新说明](docs/releases/HOTFIX-1.1.27.md)

## 1.1.26

- 移除 1.1.25 按 EasyConnect/Sangfor 会话持续暂停公网 tunnel 的过度隔离策略；MCP 公网隧道不再绑定任何具体 VPN/TUN 厂商、进程或网卡名称；
- 新增只读的 Windows 活动默认路径指纹与稳定性防抖；路径稳定变化后只重连 supervisor 持有的 tunnel child，短暂路由抖动不打断现有隧道；
- 多条默认路由改为信息状态，公网探测保持启用；本地正常而公网不可达时明确提示 VPN、TUN、防火墙或企业策略限制及独立代理/中继选项；
- 公网初始就绪超时时保留本地 MCP 与 tunnel supervisor 自动恢复，不再停止整套服务；显式 ngrok 代理优先级、环境代理隔离和第三方状态零修改边界保持不变；
- Portable Protocol 仍为 1.5，顶层 MCP Schema 不变。

[完整更新说明](docs/releases/HOTFIX-1.1.26.md)

## 1.1.25

- EasyConnect/Sangfor 会话存在期间持续隔离 DevSpace 自有公网 tunnel，本地 MCP 保持运行；不再依赖固定时长的登录稳定等待；
- 首页把预期的 VPN 隔离显示为警告而不是故障，并加入连续失败复核，修复日志正确但首页偶发保持红色的问题；
- 只读检测 EasyConnect 与第三方 TUN 默认路由竞争，不修改第三方进程、配置、系统代理、注册表、网卡或路由；
- 删除首页“最近操作”，文件差异和 Memories 完整内容改为可缩放、可最大化的独立窗口，文件差异窗口保留回退与恢复；日志页加入可拖动分隔条；
- Portable Protocol 仍为 1.5，顶层 MCP Schema 不变。

[完整更新说明](docs/releases/HOTFIX-1.1.25.md)

## 1.1.24

- 新增独立 `Update.exe`，主控制中心“检查更新”只负责启动更新程序，不再在主 UI 进程中执行 Check/Stage/Apply；
- `Update.exe` 独立显示 GitHub 检查、实际更新方式、实时下载百分比/速度/网络路径，并允许直接双击运行；
- Apply 前将更新器自身复制到系统临时目录，由临时控制器验证并关闭 DevSpace 主 UI 后执行事务替换；正常更新链不再依赖 Task Scheduler；
- `file-delta-v1` changed file 改为完整目标文件替换语义：changed file 的 base hash 漂移只记录诊断，不再触发完整包兜底；目标 SHA-256、ZIP SHA-256、持久化目录隔离和删除文件 base hash 校验仍严格执行；
- 保留旧 updater/manager 更新命令用于从旧版本升级和故障兼容；Portable Protocol 仍为 1.5。

[完整更新说明](docs/releases/HOTFIX-1.1.24.md)

## 1.1.23

- “会话与回退”同名会话分组默认折叠，分组标题以 `▶/▼` 显示状态并支持单击展开/折叠；搜索命中时临时展开匹配分组；
- 新增“全部折叠 / 全部展开”，大量历史轮次不再一次性占满会话列表；分组标题不会被误当作具体会话打开；
- 首次生成 Owner Password 的窗口明确展示 `auth.json` 完整路径，并分别提供“复制 Owner Password”和“复制 auth.json 路径”按钮；
- 保持 1.1.22 非侵入式网络策略，不把 EasyConnect/Sangfor 或 v2rayN 生命周期纳入 DevSpace 管理；
- Portable Protocol 仍为 1.5，不修改顶层 MCP Schema。

[完整更新说明](docs/releases/HOTFIX-1.1.23.md)

## 1.1.22

- tunnel supervisor 改为非侵入式网络策略：不再扫描 EasyConnect/Sangfor 进程与 VPN 网卡，不再因为第三方 VPN 状态变化周期性停止/恢复 ngrok；
- ngrok tunnel 默认隔离环境中的 WinINET/`HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`，因此先打开 v2rayN 系统代理不会强制 ngrok 使用该代理；透明 TUN 仍可自然接管 direct socket。GitHub 更新与公网健康检查独立使用健康代理候选并跳过未监听的 `127.0.0.1` 代理；
- GitHub updater 统一使用健康代理候选 + direct/TUN 路径，避免无效本地代理导致 Check/Stage 长时间失败；
- `file-delta-v1` 继续严格保护普通程序文件与删除文件，同时允许少量 Release 构建生成物在本地构建与 GitHub Actions canonical 构建之间存在合法 base hash 差异，避免无意义的 500+ MB 完整包回退；
- Apply 启动改为一次性用户级 Task Scheduler 控制器并增加启动 ACK；UI 只有确认独立更新器已经运行后才关闭，启动失败时保留 UI 并显示诊断信息；
- 首页改为 7 秒自动刷新活动指示器，总状态、MCP、tunnel、HTTP/OAuth、核心文件、网络策略与 Computer Use 不再依赖手动刷新；
- 新增“详细信息”对话框，保留完整状态、HTTP 验证、隧道诊断、文件验证、DevSpace/tunnel/update 日志及任务计划程序入口；
- Portable Protocol 仍为 1.5，不修改顶层 MCP Schema。

[完整更新说明](docs/releases/HOTFIX-1.1.22.md)

## 1.1.21

- 修复 DevSpace 公网 tunnel 与 EasyConnect/Sangfor、v2rayN 等本机网络软件共存时可能造成 VPN 会话失效或代理不可用的问题；
- 新增 tunnel 网络监督器：Sangfor VPN 正在协商时暂停 ngrok，虚拟网卡稳定后再恢复，避免在 VPN 登录和路由切换窗口维持竞争性的公网长连接；
- 自动检测已启用且可用的本地 WinINET HTTP/SOCKS 代理，并让 DevSpace tunnel 跟随该代理出站；网络路径变化时只重建 DevSpace 自己的 tunnel 子进程；
- 默认启用“VPN/代理兼容模式（推荐）”，但不修改 WinINET/WinHTTP、路由表、网卡或 EasyConnect/v2rayN 自身配置和进程；
- 状态输出增加 tunnel 网络模式、VPN 状态、代理来源和 supervisor PID；新增网络共存回归并验证 WinINET 注册表前后完全不变；
- 保持 `file-delta-v1` 增量优先、完整 ZIP 自动兜底、Protocol 1.5 与现有 OAuth/MCP Schema。

[完整更新说明](docs/releases/HOTFIX-1.1.21.md)

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
