# 构建验收记录

日期：2026-08-05（Asia/Shanghai）

## 已通过

- 本地运行时为 Node 24.18.1、Git for Windows 2.51.2、Bash 5.2.37、ngrok 3.39.10；
- DevSpace 1.0.5 CLI 入口为 `dist/cli.js`；正式启动不调用全局 `devspace.cmd`；
- 已安装编译产物同时包含 OAuth 工具 `securitySchemes` 修复和单跳
  `app.set("trust proxy", 1)` 修复；
- `better-sqlite3` 在 Node ABI 137 上打开内存数据库并执行 `select 1`；
- `node-pty` 可加载并提供 `spawn`；
- `npm audit --omit=dev` 为 0 个已知漏洞；实际依赖树使用
  `brace-expansion` 5.0.9、`protobufjs` 7.6.5；
- 中文 HTA 为 UTF-8，纯 ASCII CMD/VBS 后端通过语法检查；
- 配置首次保存与再次保存通过，留空时保留已有 Owner Password 和 ngrok Token；
- 凭据 ACL 只授予当前用户、SYSTEM 和本机管理员完全控制；
- 隔离端口 17676 就绪后连续 85 秒、18 次采样：PID 2000 不变，HTTP 始终
  200 / 200 / 401；
- 用户级任务 XML 使用 UTF-16LE BOM，可由中文 Windows `schtasks` 创建；任务为
  `InteractiveToken`、`LeastPrivilege`、`IgnoreNew`、失败 1 分钟重试 3 次、无运行时限；
- 计划任务启动实测 PID 18056，HTTP 200 / 200 / 401；修复 PID 管理后再次实测 PID
  18056/10072 对应的启动与停止均释放端口并删除 PID 文件；
- 完整 OAuth 冒烟测试通过：动态客户端注册、Owner Password 授权、PKCE Token 交换、
  access/refresh token 签发、MCP 初始化、9 个工具列表、`open_workspace` 和 `bash pwd`；
- 包含完整上游生产依赖和 Windows x64 Agent 可执行文件；正式配置仍关闭 Subagents；
- 验收结束后 Portable 任务数为 0、17676 监听数为 0，发行目录中的 `data`、`logs`、
  `reports` 均没有运行数据。

## 说明

- doctor 在普通 PowerShell 环境中不会自动发现便携 Bash，因为上游 doctor 只检查标准
  Program Files 路径；正式任务明确从内置 Git Bash 启动，并且真实 MCP `bash` 工具调用
  已通过，因此不影响运行。
- 域名和 ngrok Authtoken 是目标电脑/账户相关输入，干净发行包不进行真实公网测试。
  图形菜单部署时会对目标域名执行完整六端点验证。
- ChatGPT 网页连接器必须由用户在网页中手工创建，这是设计中的唯一人工应用步骤。

## 1.0.1 跨机器修复回归

- 不再把本地化 `schtasks /fo LIST /v` 原文输出到 HTA，中文 Windows 状态页无“锟斤拷”；
- 状态页只认受限 PID 文件，并区分本便携实例与机器上其他 7676/4040 服务；
- ngrok Agent API 自动扫描 4040-4049，并核对实际 `public_url`；
- HTTP 失败输出 DNS/TCP/TLS 的具体错误，不再只显示不明原因的 `actual=0`；
- 故意使用假 Token/假域名演练时，成功识别 `ENOTFOUND` 和 `ERR_NGROK_105`，日志中的
  Authtoken 被替换为 `[REDACTED]`；
- 可选 ngrok `proxy_url` 与 `connect_cas: host` 通过 v3 `ngrok config check`；
- ngrok 未成功发布固定域名时，“自动部署”会失败并显示原因，不再误报部署完成。
- 对用户报告故障域名的独立公网探测为三项 HTTP 404，响应头均为
  `Ngrok-Error-Code: ERR_NGROK_3200`，确认根因是 Endpoint 离线而非 DevSpace OAuth。

## 1.0.2 auth.json 路径可发现性

- 配置保存结果包含 `authFile` 绝对路径；
- 自动部署完成提示显示 `auth.json` 绝对路径；
- 重新打开配置界面及命令行“查看状态”均持续显示该路径；
- 只输出路径，不读取或输出 Owner Password 内容。

## 1.0.3 多语言 Windows ACL 修复

- 当前用户 ACL 授权从本地化的 `DOMAIN\\username` 改为稳定的 Windows SID；
- `icacls`、`whoami` 和任务计划错误使用当前控制台代码页解码，避免中文错误信息乱码；
- 任务 XML Principal 继续使用 SID，Author 从 Unicode 环境变量获取，不依赖 `whoami` 文本编码；
- 启动前显式检查两个计划任务是否存在，缺失时提示先保存配置并安装任务，不再返回含混的
  `schtasks /run`“找不到指定的文件”。

## 1.0.4 Cloudflare Tunnel 与域名切换

- 配置模型新增 `tunnelProvider=ngrok|cloudflare`，切换时保留两套凭据、Owner Password 和
  OAuth SQLite 状态；
- 计划任务统一为 `DevSpace Portable Tunnel`，升级时会停止并删除旧 ngrok 专用任务；
- Cloudflare 模式使用 remotely-managed named tunnel Token，并通过受限 Token 文件传递，
  Token 不进入 `cloudflared.exe` 命令行；
- 官方 `cloudflared-windows-amd64.exe` 2026.7.3 已实际下载，SHA-256 实测为
  `8635da433b6df8194746e88ed9d2589566c20e38bfc2a80e431a348b7c765841`，与发行页一致；
- Node 内置 `fetch` 在当前网络失败时，下载器会回退到内置 Git for Windows 的 `curl.exe`；
- `cloudflared tunnel run --help` 已确认支持 `--token-file`、`--no-autoupdate`、`--metrics`
  和 `--loglevel`；使用无效测试 Token 启动时进入 Token 校验而非参数解析错误；
- `portable-manager.cjs`、`tunnel-launcher.cjs`、HTA JavaScript、两个 Bash 启动脚本均通过
  语法检查；ngrok 隔离配置写入回归通过；
- 真实 Cloudflare 公网 200/200/401 验证需要用户自己的域名、Tunnel Token 和 Published
  application，因此本次未伪造账号数据进行端到端连接。

## 1.0.5 工具模式切换

- 图形界面可选择 `minimal`、`full` 和 `codex`，选择持久化到 `deployment.json`；
- 旧部署没有 `toolMode` 时回退到 `full`；非法模式被配置器拒绝；
- `codex` 模式使用 `apply_patch`、`exec_command` 和 `write_stdin`，启动日志显示实际模式；
- 三种模式的隔离配置测试、HTA/Node/Bash 语法检查和发行包逐项 SHA-256 校验通过。

## 1.0.6 用户可控主机权限与 Windows PTY

## 1.0.7 稳定进程与结构化诊断

- `doctor` 返回稳定检查 ID、分类、状态、摘要、详细字段和修复建议。
- `exec_command` 同时支持旧 `cmd` 与新 `argv`，两者必须二选一。
- `env` 支持覆盖环境变量，值为 `null` 时移除继承变量。
- 显式 `processHandle` 能通过 `process_list` 查询，并在 MCP 重连后通过 `process_attach` 接回。
- `process_kill` 只能操作所属工作区的进程句柄。
- `process_registry` 写入现有 `devspace.sqlite`，不创建新的凭据文件。
- 启动日志必须包含 Portable 根目录和实际 Node/Git/SSH 来源。
- 本版不新增输出字节上限或专用截断字段。

## 1.0.8 工作区会话与重启恢复

- `session_list` 必须分别返回 active 和 history。
- `session_archive` 不得删除项目目录、Git worktree 或工作区文件。
- `session_resume` 必须复用原会话 ID并重新加载项目上下文。
- 工作区记录必须包含可获得的 Git HEAD、分支、origin 和根目录。
- MCP 传输重连不得清除进程管理器中的稳定句柄。
- 服务重启后必须核查数据库中的活动 PID，并区分 `detached-running` 与 `lost`。
- 重启后只恢复 PID 级控制，不得虚构已经丢失的 PTY/stdin/stdout 可重新连接。

## 1.0.9 事件、Watch、审计与规则

- 事件必须使用 SQLite 自增 sequence，客户端以 `afterSequence` 增量读取。
- 文件 Watch 必须支持稳定 `watchId`、启动、轮询、停止和列表。
- 权限规则必须支持 `allow`、`deny`、`audit`；`audit` 不得中断命令。
- `permission_rules_test` 不得实际执行命令。
- 工具调用、事件和诊断落盘前必须执行递归脱敏。
- `doctor` 每次运行必须写入诊断历史，并生成非 OK 检查的修复建议。
- Watch 和权限事件必须可通过 `event_poll` 按游标读取。
- 不得新增输出字节上限或专用截断标志功能。

## 1.1.0 插件、Skill 与 Schema

- 插件必须按 `<id>/<version>/manifest.json` 目录结构扫描。
- manifest ID 和版本必须与目录名称一致，并保存 SHA-256 版本缓存。
- 插件启用状态和选中版本必须持久化到 SQLite。
- 动态工具名称必须稳定，并以 `plugin_` 为前缀。
- 插件工具必须继续经过权限规则、工作区检查、进程注册表和日志脱敏。
- 禁用或切换版本后，旧会话中的旧工具不得继续执行。
- 启用插件的 Skill 根必须加入新打开或恢复工作区的 Skill 搜索路径。
- `capabilities` 必须返回协议版本、服务版本、功能成熟度和插件状态。
- `schema_generate` 必须生成可解析的 JSON Schema bundle。
- 独立动态工具别名变更后必须明确提示 `dynamicToolRefreshRequired=true`。
- 不得新增输出字节上限或专用截断标志功能。

## 1.1.1 插件热插拔

- `plugin_query` 和 `plugin_action` 必须是永久稳定的顶层工具名与输入 Schema。
- `plugin_query` 只能执行 manifest 中 `readOnly=true` 的工具；`plugin_action` 必须拒绝只读工具。
- 两个调度器必须在每次调用时解析当前启用插件和当前选中版本，不得缓存插件命令定义。
- `plugin_refresh`、`plugin_enable` 和 `plugin_disable` 对稳定调度器必须立即生效，并返回 `reconnectRequired=false`。
- `plugin_list` 必须返回 `dispatchTools`，包含内部 toolName、标题、描述、只读属性和成熟度。
- 旧会话必须能通过已有 `exec_command` 调用 `app\DevSpace-Plugin.cmd query|action`，不得要求删除或重装 ChatGPT App。
- CLI 不得接受调用方指定的可执行文件、SSH 主机、密码、远端命令或 manifest command。
- MCP 与 CLI 调度器都必须继续经过工作区、权限规则、进程注册表、审计和脱敏层。
- 现有 `plugin_<id>_<tool>` 动态顶层工具必须保留兼容，但不得再作为自动化的必需依赖。

- 图形界面新增 `workspace`、`full-access`、`custom` 三种权限档位，配置同时持久化到
  `config.json` 和 `deployment.json`；旧配置缺少权限字段时回退到 `workspace`；
- `full-access` 允许打开当前 Windows 用户可访问但不在 `allowedRoots` 内的路径；实测
  `workspace` 拒绝 `C:\Windows`，`full-access` 成功打开同一路径；
- `full-access` 的 MCP 服务器指令及命令工具描述明确授权任意本地命令、SSH/SCP/SFTP、
  网络访问、凭据接口、Shell 文件修改、安装器、交互式和持续进程，同时明确不提升为
  管理员或 SYSTEM；
- `custom` 可逐项设置外部路径、任意命令、Shell 修改、网络/SSH、凭据接口、PTY 和持续
  会话。外部路径、PTY 和持续会话由服务端直接执行限制；
- Windows 上 `exec_command(tty=true)` 不再退化为普通管道，已使用包内 `node-pty`/ConPTY
  实际启动终端并获得 `DEVSPACE_PTY_OK` 输出和退出码 0；
- 临时配置回归确认 `configure`、`show-config` 和 `get accessProfile` 对 `full-access` 返回
  一致结果，所有预期能力为 true；
- 重新打包的 `waishnav-devspace-1.0.5.tgz` 已解包核对，包含权限解析、Windows PTY、完整
  访问服务器指令和外部工作区实现；`npm audit` 为 0 个已知漏洞；
- 构建器新增 `.hotupdate-stage-*` 排除规则，并清理了残留的 1.0.5 临时阶段目录，防止旧版
  发行树被递归嵌入新 ZIP。

## 1.0.5 工具模式 UI

- 图形界面新增 `minimal`、`full`、`codex` 三种合法工具模式，默认保持 `full`；
- 模式写入 `deployment.json`，旧版配置缺少该字段时自动回退到 `full`；
- 启动脚本动态读取持久化模式，并对未知值再次回退到 `full`；
- “保存并自动部署”会保存后重启服务，确保工具集合立即重新注册；
- `portable-manager.cjs`、HTA JavaScript 和 Bash 启动脚本均通过语法检查；
- 使用隔离临时配置依次验证 `minimal`、`full`、`codex` 均可保存和读取，非法 `turbo`
  值会被明确拒绝；
- 切换模式不改变 `DEVSPACE_SUBAGENTS=0`，也不会调用本机 Codex Agent；ChatGPT 网页端
  仍需刷新工具定义，没有刷新入口时重新创建插件连接。

## 1.1.3 插件 UI 与预留槽位验收

- `setup/test-plugin-manager.mjs` 验证目录安装、启停、卸载和 Portable 统一管理接口；
- 固定注册 16 个 `plugin_slot_XX`，输入 Schema 不包含 `pluginId`、`toolName`、`cmd`、`argv` 或 `env`；
- 槽位固定插件版本和 manifest SHA-256，内容变化后在启动进程前拒绝执行；
- ZIP 安装已验证，恶意 `../` 路径条目在解压前被拒绝且未写出 staging 目录；
- HTA JavaScript 通过语法检查，42 个 `getElementById` 引用全部存在；
- Portable 统一接口已验证安装、启用、绑定第 16 槽、读取、解绑和卸载；
- `createServer()` 在协议 1.4 / 服务 1.1.3 下正常创建和关闭，返回 16 个槽位且动态别名默认关闭。
- Hono 固定为 `4.13.0`；嵌套 Undici 固定为 `8.10.0`，并由 `harden-nested-dependencies.mjs` 同步根 lockfile。

## 1.1.2 Codex 风格运行时与产物预览

- Codex 模式且 `widgets=changes` 时，`exec_command`、`write_stdin`、`process_attach`、`apply_patch` 必须挂载固定 Workspace App；
- 卡片必须在 tool-input 阶段显示正在运行的命令或待应用 patch，而不是只能等待 tool-result；
- 命令完成后必须显示工作目录、PID、稳定进程句柄、退出状态、耗时、权限规则和输出；
- `cmd`、`argv`、环境覆盖和卡片元数据必须在进入结构化结果前脱敏；
- `write_stdin` 不得在卡片中返回实际输入字符，只允许返回字符数、轮询/写入类型和终端尺寸；
- `show_changes` 和 `apply_patch` 必须识别受支持的产物扩展名，并只读取工作区内仍存在的文件；
- 内嵌图片最多 4 张、单张最多 2 MiB、总计最多 6 MiB；超过限制时只返回产物路径、类型和大小；
- Raster 图片必须能作为标准 MCP image content block 返回；SVG 只能在受限卡片中以 data URL 预览；
- PDF 和 HTML 不得在卡片中执行，只返回文件元数据；
- 前端消息流测试必须覆盖 tool-input → running card → tool-result → completed card；
- 浏览器测试必须验证命令 Token 脱敏、图片画廊和非图片产物列表；
- `show_changes` 必须携带自工作区打开或上次 review 以来的命令/修改操作时间线，作为旧核心工具快照的兼容降级；
- 1.1.2 不得破坏 1.1.1 的固定插件热调度入口。

## 1.1.7 Computer Use、Memories、Hooks 与 UI 会话回退

- `capabilities.js` 返回 Portable `1.1.7`、协议 `1.5`，Portable HTA 和 Workspace App 底部均显示同一版本；
- Computer Use 默认关闭，并同时要求功能开关、`allowComputerUse` 权限和有效 UI 租约；
- UI 租约每 1.5 秒刷新，约 20 秒过期；关闭 HTA 后租约文件删除，待处理 Computer Use 请求被取消；
- Computer Use Broker 请求绑定随机请求 ID 与当前租约 ID，完成、失败或超时后清理请求、响应和 PNG；
- 截图主路径改为包内 Windows x64 DXGI 1.2 Desktop Duplication Helper：D3D11 读取桌面帧，WIC 编码 PNG，静态 CRT，不依赖目标机编译环境；
- 通过 Explorer Shell 启动真实 HTA 后，`setup/test-computer-use-live.mjs 5` 连续 5/5 次捕获 1920×1080 PNG，单次约 290 KiB，均无 stderr；Helper 大小 296,448 字节，SHA-256 为 `ba8715c09c8c0eb911e37087b25fb38da1364b5d5b0aa6b85de110bcc68d162f`；
- PowerShell Helper 在执行真实动作前调用 `OpenInputDesktop`，锁屏、UAC 安全桌面或非交互 Window Station 失败关闭；
- `setup/test-computer-use-broker.mjs` 使用不暴露为 MCP 动作的内部 `broker_probe` 验证租约、请求认领、响应和清理链路；
- 周期性黑框根因定位为 HTA 的 `WScript.Shell.Exec` 心跳；已改为 `Shell.Run(command, 0, true)` 隐藏同步执行和短期 UTF-16 文件 RPC；
- `setup/test-portable-ui-heartbeat.mjs` 验证源码不存在 `shell.Exec`、窗口样式为 0、文件 RPC 不向继承 stdout/stderr 输出；
- Memories 的 SQLite 建表、全局/工作区作用域、标签去重、更新、删除和摘要注入通过；疑似 API Key/Token 默认被拒绝；
- Hooks 的 `executable + argv` 保存、显式运行、blocking 语义与脱敏事件审计通过；不接受动态 Shell 字符串；
- 非 Git 工作区结构化修改统计与回退通过：原文件恢复，新文件删除；
- 非 Git 工作区执行任意 Shell/Hook 后，完整回退默认被阻止并返回明确限制；
- Git 工作区能够统计命令和工具造成的全部工作树变化；回退恢复 UI 打开时的工作树，并保留原暂存区；
- `show_changes` 保留增量差异，同时附加 UI 会话总修改文件数、增删行、逐文件统计、限制和精确确认令牌；
- Workspace App 回退按钮需要浏览器二次确认，并通过 `tools/call` 提交精确 `ROLLBACK <checkpointId>`；
- `server.js`、新增模块、HTA JavaScript、PowerShell Helper 和 Portable 管理器均通过语法检查与真实 ESM 导入；
- `setup/test-session-capabilities.mjs`、`setup/test-computer-use-broker.mjs`、`setup/test-computer-use-live.mjs`、`setup/test-portable-ui-heartbeat.mjs`、`setup/test-runtime-cards.mjs`、运行时日志 UI、插件管理和 Codex Runtime Bridge 回归均通过；
- 本地核心 TGZ 包含新增模块、Helper 与 CSS；生产 `npm audit --omit=dev` 为 0 个已知漏洞；
- 测试 HTA、UI 租约、Computer Use 临时目录和 Python 缓存在构建前均已清理；未修改或重启 `D:\DevSpacePortable`。

## 1.1.8 常驻 Computer Use Broker 与 WGC

- `capabilities.js` 返回 Portable `1.1.8`、协议 `1.5`，并声明 `computer-use-persistent-broker`、`computer-use-wgc-capture` 和 `computer-use-low-latency-loop`；
- 顶层 MCP 工具 Schema 与 1.1.7 完全一致，升级无需重新刷新网页 App；
- `portable-manager.cjs` 作为模块加载时不得执行 CLI，HTA `ui-open` 启动隐藏常驻 Broker，`ui-heartbeat` 只续租并在 Broker 退出时重启；
- Broker 轮询间隔为 40 ms，Computer Use 客户端响应轮询为 25 ms；UI 关闭、租约变化或超时后 Broker 必须退出；
- `computer-use-input.exe` 使用原生 `SendInput` 执行移动、点击、双击、右键、滚轮、白名单按键和 Unicode 文本；常规动作不得依赖 PowerShell 冷启动；
- 截图后端顺序固定为 WGC → DXGI → GDI/DIB，并在返回元数据中声明实际 `backend` 和降级错误；
- WGC 使用 Windows SDK 10.0.26100 C++/WinRT、D3D11 和 WIC，Helper 编译为 `/MT` Windows x64 PE；
- Session 0 直接截图失败或黑屏不得被误判为成功；截图必须由 Session 1 中打开的 HTA/Broker执行；
- 真实 Session 1 `setup/test-computer-use-live.mjs 5` 连续 5/5 返回有效 1920×1080 PNG；保存的实际截图必须包含完整桌面内容；
- 单次 Session 1 Broker 截图端到端目标低于 500 ms；最终连续 5 次实测平均约 312 ms；
- `setup/test-computer-use-broker.mjs`、`setup/test-computer-use-live.mjs`、C++ Helper 编译、核心回归、生产依赖审计和最终 ZIP 全量 SHA-256 校验必须通过；
- 构建和测试只修改 `E:\program\Python\DevSpaceDeploy`，不得覆盖或重启用户当前 `D:\DevSpacePortable` 部署。

## 1.1.9 原生统一控制中心、完整回退与零残留停止

- 故障版 1.1.9 已保留为 `DevSpacePortable-Windows-x64-1.1.9-broken.zip`，不得部署；源码树先从 1.1.8 ZIP 全量恢复，依据 1.1.8 `SHA256SUMS.txt` 校验 47,343 个文件，缺失与哈希不一致均为 0；
- `DevSpace-Portable.exe` 为 Windows x64 WinForms 单一图形入口，`DevSpace-Portable.cmd` 和兼容 HTA 路径均只启动该 EXE；真实进程检查只有 `DevSpace-Portable.exe` 主窗口和 Broker，不存在 Edge App 或旧 HTA 窗口；
- 原生 UI 结构自检包含“状态与部署”“配置与权限”“插件管理”“会话与回退”“日志与诊断”5 个页面、35 个按钮，并覆盖 1.1.8 旧 UI 的工作目录选择、启停、禁用、恢复、任务卸载、插件、日志和诊断动作；
- `ExecuteBusyAsync` 在禁用窗口和显示等待光标前写入“正在执行，请稍候”，长操作期间提供明确可见反馈并阻止重复提交；
- 原生 C# 以 `/deterministic+` 构建，连续两次编译产物均为 102,400 字节且 SHA-256 同为 `585f5ad4295a6f4d5642db075aad0200c54809f808362b764881a4ab298ea6f3`；`--structure-test` 与 `--self-test` 均无窗口退出，未知 `--` 参数不再误启动 GUI；
- `review-checkpoints.js` 使用工作区外 shadow Git 对象库保存完整快照；非 Git 回归覆盖文本修改、二进制删除、新建文本和新建二进制，回退与安全快照恢复均通过；
- Git 回归覆盖工作树修改、已有 staged 文件、被 `.gitignore` 忽略的文件和二进制文件；回退前后实际 index tree 哈希完全一致；
- 回退前自动生成安全快照，`review-restore-safety` 能恢复回退前完整状态；会话列表、详情、重命名、置顶、隐藏、归档、回退和安全恢复均通过 Portable Manager 稳定接口提供；
- 计划任务操作在执行前核对任务 XML 的 action 是否属于当前 Portable 根目录，E 盘测试版不得操作 D 盘正式任务；
- 严格停止测试成功结束一个父启动器已退出的孤立 Portable Node 进程，并返回 `No background Portable PID remains`；
- `verify-files` 使用最多 16 个异步 worker；47,340 个不超过 8 MiB 的文件直接异步读取，11 个大文件流式哈希。47,351 文件回归从约 267 秒降到约 9.4 秒，并正确检测到人为制造的单个 `portable-manager.cjs` 哈希不一致；失败项排序后统一返回，不降低路径逃逸、缺失文件、读取异常和哈希不一致的失败关闭语义；
- 原生 GUI 与 Broker 联合停止后，独立 CIM 检查确认 E 盘 Portable 根目录下可执行进程数为 0，D 盘 1.1.8 MCP 仍在线；
- 最终原生窗口下 WGC 连续 5/5 捕获 2560×1440 PNG，平均约 306 ms且无降级；原生输入 probe 成功，非法 `F25` 在发送前被拒绝；
- Broker 启动等待窗口提高到 10 秒，并连续 5 次独立 `ui-open`、probe、heartbeat、status、`ui-close` 回归通过；测试断言失败时也会执行租约与 Broker 清理；
- `test-session-capabilities.mjs`、`test-portable-ui-heartbeat.mjs`、`test-computer-use-broker.mjs`、`test-plugin-manager.mjs`、`test-runtime-cards.mjs`、`test-runtime-log-ui.mjs`、`test-codex-runtime-bridge.mjs` 和 `test-strict-stop.mjs` 全部通过；
- 1.1.9 不改变顶层 MCP 工具 Schema，协议保持 1.5；构建和测试未覆盖、重启或迁移当前 `D:\DevSpacePortable` 正式部署。

## 1.1.10 原生 UI 与 Computer Use 热修复

- 自绘圆角按钮、开关、分组框和玻璃面板在绘制前解析首个不透明父背景并清空画布，真实 Windows 桌面逐页检查未再出现黑色角块或黑边；
- 配置页两个表单组使用自动首选高度和页面级纵向滚动，顶部字段、全部权限/功能开关、Owner Password 与底部四个操作按钮均可到达；
- 插件页上下分区重新分配高度，槽位表可显示多行；会话页保留搜索、详情和差异三块布局，并为未选择文件时提供明确提示；日志页两块长文本区域完整显示；
- 顶栏 Computer Use 开关使用独立 `set-computer-use` 命令，不再被公网域名、Tunnel Token 或工作目录等完整部署校验阻断；实机关闭后旧 Broker PID 与状态文件消失，重新开启后新 Broker 为 `running` 且租约匹配；
- UI 心跳删除租约后自动恢复、Computer Use 关闭时 Broker 不启动、日志被追加句柄持有时仍可读取、第二实例不替换首实例租约，四项自动回归全部通过；
- 首次本地服务启动等待为 120 秒，UI 租约有效期为 90 秒；服务日志通过共享追加启动器写入，原生页面以 `FileShare.ReadWrite | FileShare.Delete` 读取；
- WGC 与 DXGI BGRA 帧在 PNG 编码前执行可见像素检查；全透明或近空帧会触发后端降级或明确失败，不会作为有效 Computer Use 截图返回；
- 最终截图 Helper 大小为 361,984 字节，SHA-256 为 `66a3eaf5104c0c4f8919f13a9172a46de0552d759e31e075645abbe1b23b0af6`；Explorer Shell 用户桌面连续 5/5 次捕获 3840×2160 PNG，平均约 395 ms；
- 运行卡片、日志 UI、插件管理、Codex Runtime Bridge、会话能力、Computer Use Broker、原生 UI、严格停止和四项韧性回归全部通过；
- 1.1.10 不改变顶层 MCP 工具 Schema，Portable Protocol 保持 1.5；全部修改、构建和实机检查限定在 `E:\program\Python\DevSpaceDeploy`，未修改或停止 `D:\DevSpacePortable` 正式部署。

## 1.1.12 Computer Use 指示器与批量低延迟控制

- Computer Use 活跃期间，每个显示器创建一个 7 px 金色、TopMost、无焦点、点击穿透的 WinForms Overlay；实机窗口枚举确认控制期间指示窗存在，完成 3 秒后自动消失；
- Overlay 调用 `WDA_EXCLUDEFROMCAPTURE`，避免安全提示干扰模型截图；不支持该 API 时仍保持点击穿透和不抢焦点；
- 鼠标、滚轮、白名单按键和 Unicode 文本由原生 UI 进程内直接调用 `SendInput`，仅在入口缺失时回退独立 Helper；
- `computer_action.steps` 支持一次提交 1–50 个动作，只返回一个最终截图；累计显式延时上限 30 秒，文本总量上限 80,000 字符；
- UI 请求轮询从 40 ms 降到 15 ms，MCP 响应轮询从 25 ms 降到 10 ms；固定 18 秒超时改为按显式延时动态计算，最大 60 秒；
- 实机 20 个连续 `move` 加一次 2560×1440 截图总耗时 138 ms：输入 2 ms、截图 94 ms、队列等待 9 ms；
- 隔离批量协议回归耗时 37 ms；Broker、稀疏会话、原生 UI 韧性、UI 结构、Runtime Cards、插件管理和严格停止测试全部通过；
- `computer_action` 顶层输入 Schema 新增 `steps`，Portable Protocol 仍为 1.5，但升级后需要刷新一次 ChatGPT App 工具定义。

## 1.1.13 Computer Use 会话级指示器与默认无截图动作

- 检查本机 `@openai/codex@0.146.0` Windows 包：核心逻辑位于原生 `codex.exe`，二进制包含 screenshot、capture、desktop、screen、SendInput 等路径；可读结构显示其并非 JS 工具逐步回传全屏截图；
- 金色边框从请求完成后 3 秒隐藏改为最后一次 Computer Use 活动后 90 秒隐藏；关闭 Computer Use、关闭 UI 或租约失效时立即隐藏；
- 实机单个 `move` 默认不截图，总耗时 28 ms，输入 3 ms，队列等待 6 ms，返回图片 0 字节；
- 实机窗口枚举确认单个无截图动作完成 6 秒后，`DevSpace Computer Use Indicator` 顶层窗口仍存在；
- `computer_action` 和批量 `steps` 默认不返回截图；需要观察时显式调用 `computer_snapshot` 或设置 `screenshotAfter: true`；
- 兼容隐藏 Broker 仅作为回退路径保留，解压副本首次 probe 阈值放宽为 2.5 秒；低延迟标准以原生 UI 进程内 SendInput 路径为准；
- 批量协议、Broker、稀疏会话和原生 UI 自检均通过。

## 1.1.14 原生 UI 非阻塞操作、会话子页面与 Memories 管理

- 定位到整框变白根因是 `ExecuteBusyAsync` 和初始化阶段对整个 `MainForm` 设置 `Enabled=false`；新实现不再禁用主窗体，只有触发操作的按钮显示“执行中…”，并阻止同一按钮被重复提交；
- “会话与回退”由同屏拥挤的左右分栏改为隐藏 TabControl 驱动的列表页与详情页；双击会话或点击“查看本轮修改”进入详情，返回按钮恢复列表；
- 会话详情显示根目录、`sparse-journal-v4`、文件与增删统计、完整回退状态；文件选择会提取对应 patch，新增、删除、区块和文件头采用独立文字颜色；
- 左侧导航新增“显式 Memories”页面，使用正式 `devspace.sqlite` 和既有 `MemoryStore` 完成查看、搜索、新建、编辑、保存和确认删除；
- 工作区 Memory 只能选择当前配置中的精确 `allowedRoots`，全局 Memory 不绑定项目；凭据检测仍强制开启，UI 不提供绕过开关；
- `setup/test-portable-ui-workflows.mjs` 对非整窗禁用、会话子页面以及真实 SQLite Memory CRUD 进行隔离回归，结果为 `nonWhiteningBusyState=true`、`sessionSubpage=true`、`memoryCrud=true`；
- 原生 WinForms 编译通过，Portable 与服务端版本统一为 1.1.14，协议仍为 1.5，未新增或修改 MCP 顶层工具 Schema；
- 所有源码修改和测试均在 `E:\program\Python\DevSpaceDeploy` 完成，未覆盖或停止 `D:\DevSpacePortable` 正式部署。

## 1.1.15 GitHub 在线更新、会话分组、现代逐文件差异与托盘关闭行为

- 原生“状态与部署”新增公开 GitHub Release 更新入口；`update-check` 无 Token 读取最新稳定 Release，`update-stage` 下载并核对字节数、SHA-256、仓库、标签、文件名和压缩包路径安全；
- 独立 `portable-updater.ps1` 在 UI 退出后运行，停止当前 Portable 服务、建立同盘备份、替换应用文件并重新启动；`data`、`logs`、`reports` 不参与替换，失败会恢复旧应用文件并重新启动旧版本；
- 源码目录包含 `.git` 时更新器拒绝覆盖，避免在线更新破坏 Git 分支或未提交修改；
- 会话历史按规范化会话名分组，分组按最新修改时间倒序，组内轮次同样按更新时间倒序；分组标题不可直接执行回退、归档或重命名；
- 差异区域改为 `ModernDiffViewer`，使用深色编辑器背景、行号栏、文件标题、hunk/新增/删除/文件头分色；未选择文件时只显示空状态，提取失败也不会退回展示整轮 patch；
- 点击右上角关闭按钮会显示最小化到系统托盘、仅退出控制中心和取消；最小化保留 UI 租约和后台服务，退出只关闭 UI；选择可写入隔离的 `ui-preferences.json`，并可从托盘菜单或“重置关闭选择”恢复为每次询问；
- 修复 Windows 文本编码探测没有超时的问题，并把核心 TGZ 改为 Python 生成的确定性归档，避免本机 npm CLI 异常阻塞发行流程；
- 原生 WinForms 编译通过，公开 Release 检查实测成功；源码边界、Runtime Cards、现代日志、UI 工作流、更新器安全契约、原生 UI 韧性、稀疏会话、插件、Computer Use 批量和 Broker 回归全部通过；
- Portable 与服务端版本统一为 1.1.15，Protocol 保持 1.5，未新增或修改 MCP 顶层工具 Schema。

## 1.1.16 增量更新、严格逐文件差异与现代字体

- 在线更新策略改为 `file-delta-v1` 增量优先，并保留完整 Portable ZIP 自动兜底；增量包按精确 `fromVersion` 选择，校验下载大小、SHA-256、压缩路径、目标文件和被触及基础文件哈希。
- Release 构建从上一稳定完整 ZIP 生成 changed/new 文件与 deleted path manifest；`data`、`logs`、`reports` 不进入增量修改集合。
- 修复 `createTwoFilesPatch` 不包含 `diff --git` 导致的跨文件 patch 泄漏；当前选择只允许渲染匹配的 `--- a/path` / `+++ b/path` block。
- 差异视图增加旧/新双行号 gutter，代码字体使用 Cascadia Code；原生 UI 使用 Segoe UI Variable 系列并具备系统字体回退。
- 新增增量构建器与原生单文件差异回归；Portable Protocol 仍为 1.5，MCP 顶层工具 Schema 不变。
