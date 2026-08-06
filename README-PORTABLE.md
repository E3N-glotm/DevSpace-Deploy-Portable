# DevSpace Portable

## 1.1.8 常驻 Computer Use Broker 与 WGC

- Portable UI 和 Workspace App 底部显示 `DevSpace Portable 1.1.8 · Protocol 1.5`；
- HTA 打开时在当前登录用户的 Session/Window Station 中启动隐藏常驻 Broker，关闭 UI 或租约过期时自动退出；
- Broker 每 40 ms 检查动作，MCP 客户端每 25 ms读取结果，不再由 1.5 秒心跳串行处理截图；
- 截图后端顺序为 Windows Graphics Capture（WGC）→ DXGI Desktop Duplication → GDI/DIB；
- 鼠标、滚轮、白名单按键和 Unicode 文本由静态编译的 Windows x64 `SendInput` Helper 执行，PowerShell 只保留为旧环境兼容回退；
- WGC Helper 使用 Windows SDK C++/WinRT、D3D11 和 WIC，目标机无需 Python、.NET SDK、Visual Studio 或额外 VC++ 运行库；
- 真实 Session 1 测试连续 5/5 返回 1920×1080 PNG；保存的完整截图内容正确，平均端到端约 312 ms；
- 顶层 `computer_snapshot` / `computer_action` Schema 保持不变，协议仍为 1.5，从 1.1.7 升级无需重新刷新网页 MCP 工具定义。

## 1.1.7 Computer Use、Memories、Hooks 与 UI 会话回退

- Portable UI 和 Workspace App 底部显示 `DevSpace Portable 1.1.7 · Protocol 1.5`；
- Computer Use 使用本地 UI 心跳 Broker，默认关闭，并同时要求功能开关、权限档位和有效 UI 租约；
- HTA 必须由已登录且未锁定的 Windows 桌面打开，关闭 UI 或约 20 秒心跳超时后自动撤销截图、鼠标、键盘和回退能力；
- 桌面截图使用包内 Windows x64 DXGI Desktop Duplication Helper；连续 5 次实机 PNG 捕获作为发行验收；
- UI 心跳使用隐藏的 `Shell.Run(..., 0, true)` 和短期文件 RPC，修复每 1.5 秒闪现控制台窗口的问题；
- Memories 为显式全局/工作区 SQLite 记录，不自动采集命令输出、浏览历史或聊天，并默认拒绝疑似凭据；
- Hooks 使用固定 `executable + argv`，覆盖工作区、命令、修改、审阅和回退事件，并保留脱敏审计；
- `show_changes` 和 `session_changes` 显示本地 UI 打开以来的总修改文件、增删行和逐文件统计；
- Git 工作区支持保留暂存区的工作树回退；非 Git 工作区只安全恢复结构化工具已知路径，执行 Shell/Hook 后拒绝声称完整回退；
- 1.1.7 新增固定顶层工具，从旧版升级时需要让 ChatGPT App 重新读取一次工具定义；以后本地开关不改变 Schema。

## 1.1.3 插件管理 UI 与固定预留槽位

- Portable UI 可安装、启用、禁用和卸载插件，并管理版本；
- 安装支持目录、`manifest.json` 和 ZIP，拒绝路径穿越、符号链接、目录联接和不安全包结构；
- 固定暴露 `plugin_slot_01` 至 `plugin_slot_16`，供极少数无法通过统一调度器表达的插件使用；
- 槽位只能由本机 UI 绑定，并固定插件版本、内容哈希和工具名；插件变化后自动拒绝执行；
- Portable 默认关闭会变化的 `plugin_<id>_<tool>` 顶层别名，普通插件统一通过 `plugin_query` / `plugin_action` 热插拔；
- UI 管理、固定调度器和预留槽位共享 SQLite 状态，变更立即生效，无需重启服务。

1.1.3 新增了 16 个固定顶层槽位，因此从 1.1.2 或更早版本升级后需要让 ChatGPT 一次性重新读取工具定义。完成这次升级后，后续插件安装、升级、启停、卸载和槽位重绑均不会继续改变网页 MCP Schema。

## 1.1.2 Codex 风格运行时卡片

- 在命令开始时显示实际 `cmd`/`argv`、工作目录和运行状态；
- 完成后显示退出码、PID、稳定进程句柄、耗时、权限规则与终端输出；
- `apply_patch` 显示待应用 patch，并在完成后显示逐文件差异；
- `show_changes` 自动预览本轮新增或修改的小型图片，并列出 PDF、HTML、Markdown、CSV、JSON 等产物；
- `show_changes` 同时汇总本轮命令与文件操作时间线，为旧 App 提供无需刷新核心描述符的最终操作回顾；
- 命令、环境变量与卡片元数据统一脱敏；
- 不新增顶层 MCP 工具，插件仍通过固定热调度入口运行。

1.1.2 修改了核心工具的 UI 描述符。首次从旧版升级后，ChatGPT 需要重新读取一次 DevSpace 核心工具定义；以后新增、升级、启停普通插件仍不需要刷新 App。

## 1.1.1 运行时能力

- 持久 `processHandle`、进程列表、重连接入和 PID 级重启识别；
- 工作区 session 列表、恢复、归档和 Git 元数据；
- `doctor`、诊断历史和自动修复建议；
- 文件 Watch、事件 sequence 游标和脱敏 SQLite 审计；
- `allow`、`deny`、`audit` 权限规则；
- 本地插件 manifest、版本缓存、启停、动态工具和插件 Skill 根；
- 协议/功能成熟度查询与 JSON Schema bundle 生成。
- 固定 `plugin_query` / `plugin_action` 热插拔调度器；
- 旧会话可通过 `app\DevSpace-Plugin.cmd` 使用当前插件，无需刷新 ChatGPT App。

插件安装位置为 `data/plugins/installed/<id>/<version>`。启停、刷新或切换版本后，固定调度器立即使用新状态；仅在需要新增独立的 `plugin_<id>_<tool>` 顶层别名时才需要刷新 ChatGPT 工具定义。

完整中文部署、迁移、权限、故障排查和卸载说明请阅读同目录的 `README.md`。

首次使用：解压整个文件夹后双击 `DevSpace-Portable.cmd`，选择 `ngrok 固定域名` 或
`Cloudflare Tunnel + 自定义域名`，选择 `full`、`codex` 或 `minimal` 工具模式，并选择
`workspace`、`full-access` 或 `custom` 主机访问权限，填写对应的固定公网根地址、Token、
允许目录和可选 Owner Password，然后点击“保存并自动部署”。

Cloudflare 模式要求先在 Cloudflare 控制台创建 remotely-managed named tunnel，并为
自定义域名配置 Published application，Service URL 指向 `http://127.0.0.1:7676`。
1.0.6 包内已包含固定版本的 `cloudflared`；若运行时文件缺失，保存 Cloudflare 配置时会自动恢复下载并校验。

`full` 是兼容性最好的默认模式；`codex` 使用多文件 `apply_patch` 和持久命令会话；
`minimal` 只保留精简工具集。切换模式会重启 DevSpace，并要求 ChatGPT 网页端刷新工具定义。

需要通过 MCP 执行 SSH、交互式密码提示、Windows Credential Manager、Shell 文件修改或任意
本地命令时，选择 `full-access`。该模式只获得当前 Windows 用户已有的权限，不会绕过 UAC、
ACL、杀毒软件或远端服务器权限。
