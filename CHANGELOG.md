# Changelog

本文件提供版本索引；每个版本的完整设计、修复、测试和兼容性说明位于 [`docs/releases/`](docs/releases/)。

## 1.1.42

- 同版本热修复：修正“远程服务器”一级页面在非全屏窗口中滚动到底仍有底部文字被主窗口 footer 遮住的问题；改为外层滚动 viewport + 完整固定高度内容面板，滚动范围与真实内容高度一致。
- 同版本热修复：修正 Remote Agent 一键恢复对 `online-recent` 的误判。原生 UI 通过短生命周期管理进程读取 Agent 状态，无法持有运行中 DevSpace 的 WebSocket connection set，因此健康 Agent 会在该管理通道显示为 `online-recent`；现在 `online` / `online-recent` 均作为 heartbeat 已恢复，`offline` / `revoked` 仍按失败处理。已在线 Agent 点击“一键恢复 / 安装”时直接返回，不再无意义 repair。
- 将 Remote Agent SSH 救援升级为“进程拉起 + heartbeat 验证 + 原 Agent repair enrollment”。已有 Agent 启动后仍不回 heartbeat 时，自动刷新同一 Agent ID 的 endpoint/Secret 并原位修复，不再只弹出“SSH 操作完成但 heartbeat 未恢复”。
- 一键 SSH 安装改为 Windows 端直接传输随包 `install.sh` 与 `devspace-agent.py`，Linux 端仅需 SSH、Bash、Python 3 和 allowedRoot 写权限；不再要求远端存在 `curl`、`sha256sum` 或具备公网下载能力。
- 默认用户级状态目录改为 `<第一条 allowedRoot>/.devspace-agent/<独立实例>/`。实例目录由 enrollment 唯一标识生成，多用户共享同一服务器、同一 Linux 用户和同一 allowedRoot 时不会覆盖彼此的 `config.json`、PID、日志或 Agent 文件；repair 会按 Agent ID 找到原实例目录。
- 手动安装命令默认使用普通用户 `bash`，不包含 `sudo bash`，并显式传入受 allowedRoot 约束的 `--state-dir`；旧 `~/.local/state/devspace-agent` 与 `/var/lib/devspace-agent` 仍保留救援兼容。
- “远程服务器”从“配置与权限”的子入口提升为左侧一级页面，位于“配置与权限”和“插件管理”之间；新 SSH profile 默认启用自动救援。
- v1.1.42 继续为 1.1.32～1.1.39 发布各自直达最新版的精确增量，同时发布 `1.1.41 -> 1.1.42` 邻接增量、carry-forward 历史图和 1.1.33 Rescue，迁移 ZIP 仍只存在于 GitHub Release。

[完整更新说明](docs/releases/HOTFIX-1.1.42.md)

## 1.1.41

- 修复 Remote Agent SSH 救援脚本的 Windows CRLF → Linux Bash 传输问题。所有送入 `ssh ... bash -s` 的脚本现在在发送前统一规范化为 POSIX LF，避免 `set -eu\r`、`do\r` 被 Bash 当成非法参数/语法。
- 增加原生 self-test 和 SSH rescue contract 的 CRLF 回归；DPAPI AskPass、已有 Agent 优先恢复、systemd/nohup 以及手动安装 fallback 行为不变。
- 将 1.1.41 作为稳定兼容 Release：继续发布 `1.1.32`～`1.1.39` 各自直达 1.1.41 的精确增量，同时发布 `1.1.40 -> 1.1.41` 邻接增量、carry-forward 历史增量图，并保留 1.1.33 Rescue fallback。

[完整更新说明](docs/releases/HOTFIX-1.1.41.md)

## 1.1.40

- 将 1.1.40 定义为更新协议迁移点：Release workflow 一次性生成 `1.1.32`～`1.1.39` 各自直达 1.1.40 的八个精确增量包，并继续为 1.1.33 提供 direct-overlay Rescue；迁移 ZIP 只发布到 GitHub Release，不进入 Git 历史。
- 1.1.40+ 更新器新增历史稳定 Release 增量图和最小下载量路径规划。后续每个版本只需保留“上一版 → 当前版”差分，跳版用户由客户端拼成 `incremental-chain`；所有步骤先下载/校验，再一次停服、一次事务应用，任何中间步骤失败都会回滚到原始安装版本并保留完整 ZIP fallback。
- 最新版 `update-manifest.json` 会继续携带已验证的历史增量图；跳版更新优先使用这个小清单规划路径，清单不可用时才枚举历史 Release，避免常规升级依赖大量 GitHub API 查询。
- Remote Workspace Agent 页面新增 SSH 主机/IP、端口、用户名、密码、测试连接和“一键恢复 / 安装 Agent”。已有 Agent 优先按原 identity 恢复；确认未安装才创建短期 enrollment。systemd、普通用户 `nohup` 和原手动安装命令继续保留。
- SSH 密码使用 Windows DPAPI CurrentUser 加密保存，并只通过子进程环境 + `DevSpace-SshAskPass.exe` 交给 OpenSSH；不会写进 SSH 参数、远程命令或 DevSpace 日志。主控制中心支持用户明确启用的后台 SSH 恢复，并对单 Agent 做两分钟限频。
- 新增 `read_attachment` 原生 MCP 多模态工具；PNG/JPEG/WebP/GIF 返回 `image`，PDF/SVG 返回嵌入式 `resource`。普通 `read` 对这些文件也自动走同一路径，避免为读取图片/PDF调用本地 Codex Runtime、OCR、`pdftotext` 或子模型。
- 修复原生控制中心圆角输入框只有上半部可点击的问题：公共 `FieldHost` 与 `RemoteInputHost` 现在对整个可见输入区域做 hit forwarding，并将单行编辑控件垂直居中；Remote Agent 两处说明文字也改为不裁切的自适应/滚动布局。
- 新增真实两段增量事务回归、SSH 救援安全契约、1.1.40 Release 迁移契约和原生图片/PDF内容块测试。Portable Protocol 仍为 `1.5`，顶层 MCP Schema 因 `read_attachment` 新增而变化。

[完整更新说明](docs/releases/HOTFIX-1.1.40.md)

## 1.1.39

- 新增 Remote Workspace Backend：Windows 继续作为唯一 MCP/OAuth Control Plane，Ubuntu/Linux 通过轻量出站 Agent 登记后可使用 `devspace://<agent-id-or-name>/absolute/linux/path` 直接打开；文件、搜索、patch、命令、PTY、持续进程、file watch、review/rollback 等继续复用现有 workspaceId。
- 修复首版 1.1.39 在公网 enrollment ACK 丢失/瞬时断线时会出现“Windows 已创建 Agent、Linux 尚未拿到 Agent Secret、一次性 Token 又已永久失效”的半注册状态。Enrollment 现在采用两阶段确认：首次使用后保留 2 分钟恢复窗口，同一 Token 重试会复用 Agent ID、轮换为新的 Agent Secret；Linux 原子写入凭据后显式确认，控制端随即销毁 enrollment。Agent 默认自动尝试 3 次，并输出 WebSocket close code/reason。
- Linux installer 在重新登记前会暂停已有 `devspace-agent.service`，避免旧守护进程与新 enrollment 竞争连接；登记失败时会尝试恢复原服务。Agent/installer 仍保持 SHA-256 链式校验、普通用户运行与 systemd sandbox 边界。
- 修复容器/非 systemd Ubuntu 的安装失败：仅当 PID 1 确实是 systemd 时才创建并启用 systemd unit；否则自动以普通 Linux 用户通过 `nohup` 后台模式启动 Agent，并保存 PID/日志。该模式可跨 SSH 退出保持运行，不再因 `systemctl` 无法连接 bus 而把已成功的 enrollment 判为失败。
- 修复生成的一次性安装命令末尾直接执行 `exit $rc` 会主动关闭用户当前 SSH shell 的问题；安装过程现在运行在子 shell 中，仍保留正确退出码，但不会关闭交互式 SSH 会话。
- 第三次 1.1.39 原位修订将 Linux Agent 默认安装模式改为**无 sudo 用户级安装**：生成的一键命令不再包含 `sudo`，普通账号可直接安装到 `~/.local/state/devspace-agent`；若之前 1.1.39 已把 `/var/lib/devspace-agent` 交给当前用户，则自动复用该可写目录原位升级，避免重复 Agent。只有管理员显式用 sudo/root 执行 installer 时才走系统级 systemd 路径。
- 重做 **AI / MCP OAuth 客户端** 窗口：彻底移除该页易受 DPI/Dock 瞬时尺寸影响的 SplitContainer，改用与主页一致的 SurfacePanel / FieldHost / ModernButton 视觉体系，并把“新建手动客户端”与“当前选中客户端凭据”拆成独立区域，避免把 ChatGPT DCR Client ID 误当成 Gemini 手动 Client ID。
- Remote Linux Agent 管理窗口第三次收口：不再使用生硬 DataGridView/标准方框。Agent 改成与主页状态卡一致的圆角动态磁贴，支持 hover、选中、状态点和自适应双列/单列；输入框改为实心背景的独立圆角输入宿主，焦点时使用主页蓝色描边。按钮行改为固定 44px 真实高度并取消窄行裁切，同时仍保持单层自绘，避免早期多层透明 SurfacePanel 的 resize 残影。
- 1.1.39 Release 资产按同一版本号重新构建并原位替换；Portable Protocol 仍为 `1.5`，原 1.1.39 已新增的顶层 MCP Schema 不再发生第二次变化。

[完整更新说明](docs/releases/HOTFIX-1.1.39.md)

## 1.1.38

- 将维护版 `@waishnav/devspace` 上游兼容基线从 1.0.5 选择性同步到 1.0.7；不直接覆盖 Portable fork，保留现有 sparse review、OAuth、full-access 权限、插件、Memories、Computer Use、会话管理、更新器和原生 UI 扩展。
- 移植上游 1.0.6 的 ChatGPT conversation-aware checkout reuse：宿主提供 `_meta["openai/session"]` 时，同一 conversation + 同一 checkout 项目复用同一个 workspaceId；首次 open 返回完整 bootstrap，重复 open 只返回简化续用信息。
- 新增 SQLite `workspace_conversation_bindings` migration，使 conversation → workspace 绑定跨 MCP 重连和 DevSpace 重启保持；绑定指向归档 session、丢失目录或失效 root 时自动清理并重建。
- 同一 conversation/target 的并发重复 open 共享一个 pending operation，避免竞态创建多个 workspace；worktree 模式仍保持每次请求创建新的隔离 worktree。
- 新创建 workspaceId 改为 `ws_` + 10 位随机十六进制；已有长 UUID workspaceId 不迁移、不失效，仍由持久 session store 恢复。
- unknown workspaceId 错误改为明确要求重新打开目标项目/worktree并继续使用新 ID；上游 review-checkpoint 文件没有整包覆盖，本项目现有 sparse-journal-v4 的历史冻结、空间上限、rollback/snapshot 语义继续作为权威实现。
- 新增 conversation metadata、同会话复用、并发合并、重启恢复、stale/archived binding 恢复、compact ID 与 unknown-ID 指引回归；Portable Protocol 仍为 `1.5`，顶层 MCP tool schema 不变。

[完整更新说明](docs/releases/HOTFIX-1.1.38.md)

## 1.1.37

- 修复原生控制中心 `AI / MCP OAuth 客户端` 页面首次打开时的 WinForms `SplitContainer` 约束异常：不再在容器真实尺寸稳定前写死 `SplitterDistance` 与 Panel MinSize。
- 新增共享 `SafeSplitLayout`，按实时 `ClientSize`、`SplitterWidth` 和目标比例动态 clamp；临时尺寸不足时安全放宽 Panel MinSize，尺寸恢复后再恢复设计约束。
- OAuth 客户端窗口启用 DPI autoscaling；原生 UI 自检覆盖 120–1800 px 的瞬时宽度，以及横向分栏 90–980 px 的瞬时高度。
- 插件、Memories、日志分栏同步采用安全布局路径，防止同类异常扩散到其它页面。
- Portable Protocol 仍为 `1.5`，顶层 MCP tool schema 不变。

[完整更新说明](docs/releases/HOTFIX-1.1.37.md)

## 1.1.36

- 修复 1.1.33 起暴露出的完整包 Apply 事务边界问题：更新前 `portable-manager stop` 不再以 ignore-failure 方式执行；旧 Portable 未能完全停止时直接中止，任何程序文件都不移动，避免带锁目录进入半更新状态后再依赖脆弱回滚。
- 将“程序文件提交”与“任务/服务/公网 tunnel 恢复”拆成两个阶段。目标程序文件替换完成并通过 `VERSION-MANIFEST.json` 校验后即提交新版本；后续 `install-tasks/start` 失败只返回 `servicesRecovered=false` 与错误详情，不再把已经正确安装的新版本回滚。
- 新版 Update.exe 增加 Apply 级 full fallback：增量 Apply 失败且后端明确记录 `rolledBack=true` 时，强制 Stage 一次完整包并再 Apply 一次；不在回滚不完整时继续，不无限循环。
- Release pipeline 除常规“上一稳定版 → 1.1.36”增量包外，固定生成 `DevSpacePortable-Update-1.1.33-to-1.1.36.zip`，让 1.1.33 用户优先下载小型增量资产而不是 500+ MiB 完整包。
- 新增 `DevSpacePortable-Rescue-1.1.33-to-1.1.36.zip` direct-overlay-v1 救援包：关闭旧 Portable 后可直接解压到安装目录并覆盖；`data`、`logs`、`reports` 永不进入该包。构建器如果发现目标版本需要删除 1.1.33 中的旧文件会拒绝生成，避免“只覆盖不删除”留下不兼容残留。
- 本地 Release 构建继续将完整包、增量包和救援包保存在源码根目录 `E:\program\Python\DevSpaceDeploy`；Portable Protocol 仍为 `1.5`，顶层 MCP tool schema 不变。

[完整更新说明](docs/releases/HOTFIX-1.1.36.md)

## 1.1.35

- OAuth Dynamic Client Registration 不再把远程回调域名写死为 `chatgpt.com`：标准 HTTPS 回调、localhost/loopback HTTP(S) 和符合反向域名格式的 native private URI scheme 均可注册，因此 Gemini、Claude、Cursor、IDE 和未来其它标准 MCP 客户端不再需要 DevSpace 维护厂商白名单。
- Owner Password 授权页新增明确的 Redirect URI 展示；即使开放厂商无关 DCR，用户仍能在授权前核对授权码将返回到哪里，服务端继续要求授权请求与已注册 redirect 精确匹配。
- 原生“配置与权限”新增 **AI / MCP OAuth 客户端** 管理入口，为不支持 DCR 或要求显式 Client ID/Client Secret 的客户端提供本地预注册：支持创建、列表、复制 ID、一次性 Secret、轮换 Secret、删除并撤销 Token。已有 Secret 不通过列表接口回显。
- 远程明文 HTTP redirect 继续拒绝；Secret 轮换与客户端删除都会撤销该客户端已有 Access/Refresh Token。Portable Protocol 仍为 `1.5`，顶层 MCP tool schema 不变。

[完整更新说明](docs/releases/HOTFIX-1.1.35.md)

## 1.1.34

- 彻底修复“会话与回退”旧记录随未来文件状态变化重新变成 `0` 的语义问题：成功的结构化文件修改结束后立即冻结本轮历史 summary/files/diff；后续会话即使继续修改同一文件或把它改回 baseline，旧会话仍显示自己当时真实发生的修改。
- 纯只读 workspace 打开、SSH/GPU 监控与 shell-only 轮次不再创建持久 review 目录；原生 UI 默认隐藏空会话，并新增“显示空会话”诊断开关。升级后会自动清理 1.1.33 及更早版本留下的可丢弃空记录。
- 保留 512 MiB 全局回退状态硬上限，但达到存储压力时不再优先删除整轮历史：先释放旧会话的 rollback object/safety snapshot，保留轻量历史 summary/files/diff；被释放快照的会话仍可审阅，但明确标记为不可回退，从而同时控制空间并长期保留历史记录。
- 更新下载改为“官方元数据 + 镜像优先传输”：版本、大小和 SHA-256 只信任官方 GitHub；ZIP 默认优先 `ghproxy.net`，失败后快速切回官方 Release URL。系统代理开启时优先使用系统代理，没有可用代理时自动使用 direct/TUN；镜像只负责传输，最终仍以官方 SHA-256 验证。
- 已在线实测 `1.1.32 -> 1.1.33` 的 5.8 MiB 增量包经 `ghproxy.net + Windows system proxy` 下载并通过官方 SHA-256；同时用不可达镜像验证了两次有界失败后自动回落官方源。
- DevSpace server capability version 更新为 `1.1.34`，Portable Protocol 仍为 `1.5`，顶层 MCP tool schema 不变。

[完整更新说明](docs/releases/HOTFIX-1.1.34.md)

## 1.1.33

- 修复“会话与回退”中旧修改记录偶发变成 `0` 或直接消失的问题。根因是 `review-sessions-v4` 把所有会话统一限制为 30 个，而 VGSP/LC-PiSA-SR 等高频只读监控会话同样占用这个数量配额，最终会把更旧但真正保存了 tracked baseline/rollback 数据的会话目录删除。1.1.33 改为只对无 tracked baseline、无 safety snapshot、无 shell mutation、无实际修改且未置顶的空会话执行 30 轮数量淘汰；真实修改会话不再因为后续空会话数量增长而被删除，512 MiB 全局 review-state 上限仍然作为硬存储边界。
- 插件管理新增“导出当前选中插件包”。导出的是所选插件**所选版本**的完整可安装 ZIP，而不是单独的 `manifest.json`；导出过程使用临时文件、ZIP 内容校验和 SHA-256，导出的包已加入“卸载后重新安装”往返回归测试。
- 将 `codex-runtime-bridge` 固化为所有正式 ZIP 的强制内置插件：完整 Portable ZIP 构建会校验其 manifest/runtime/keep-awake/Skill 文件，缺失即失败；增量更新 ZIP 即使插件相对基线未变化，也会携带 `setup/bundled-plugins/codex-runtime-bridge/` seed payload。
- DevSpace server capability version 更新为 `1.1.33`，Portable Protocol 仍为 `1.5`，顶层 MCP tool schema 不变，因此本次升级不要求重新 OAuth 或重新 Scan Tools。

[完整更新说明](docs/releases/HOTFIX-1.1.33.md)

## 1.1.32

- 修复 1.1.31 “检查更新”按钮启动 `Update.exe` 后立即以 CLR 未处理异常退出的问题。Windows `.NET Runtime 1026` 证实旧主 UI 将带尾部反斜杠的 Portable 根目录手工拼成 `--root "D:\\DevSpacePortable\\"`，Windows 命令行解析会吞掉闭合引号，最终让 `ResolveRoot()` 收到损坏参数并在 `Path.GetFullPath()` 抛 `System.ArgumentException`。1.1.32 主 UI 不再向同目录 Update.exe 传冗余 `--root/--current`，只传必要的 `parent-ui` PID；更新器内部其余子进程参数统一使用完整 Windows quoting 规则，并增加顶层异常提示，避免再次以 CLR 崩溃码静默退出。
- 将原生 Windows Logo 统一为当前控制中心使用的蓝紫底白色 `D`：主窗口、独立 Update、文件差异、完整内容、详细诊断、关闭选择、首次部署等标题栏以及系统托盘全部复用同一个品牌绘制实现，不再显示 .NET/默认应用图标。
- 新增 updater/brand regression：验证主 UI 启动更新器时不再传易损 root/current 参数、Windows 参数 quoting 对尾部反斜杠安全、两个原生程序都能创建品牌 Icon。

[完整更新说明](docs/releases/HOTFIX-1.1.32.md)

## 1.1.31

- 修复原生 UI“检查更新”点击后更新窗口可能没有被用户看到的问题：启动后等待并验证可见窗口；已有同一 Portable 的 Update.exe 时直接恢复并前置现有窗口；启动失败/立即退出/超时均在主 UI 明确报错，不再静默。
- 重做更新网络容错：检查更新优先使用与系统代理无关的 direct/TUN 传输，动态读取 Windows/环境代理作为 fallback；支持 HTTP/SOCKS、PAC/WinINET 路径与代理端口变化；网络路径切换时刷新候选重试。GitHub Release API 提供 asset SHA-256 时直接使用，不再强制额外下载 update-manifest.json 才能完成版本检查。
- 公网隧道“按需关闭”从绿色 ready 改为独立的琥珀色 `idle` 状态；这是正常用户选择，不计入整体 warning/error。
- 修复 `statusText()` 缺少 `internetProxy` 局部变量导致“刷新概览”和“保存并部署”出现 `ReferenceError: internetProxy is not defined` 的回归。
- 修复长期运行时 DevSpace Node 堆持续增长最终导致上游 502 的结构性风险：MCP transport/server 会话、workspace/review 热缓存、活动进程、文件 watcher 与待交换 OAuth code 全部增加明确上限/空闲回收；持续进程输出缓冲去除高分配 `Array.from()` 路径并减小 retention；大型数据目录的嵌套指令发现增加时间、条目、目录和深度预算。没有通过提高 V8 heap 上限掩盖问题。

[完整更新说明](docs/releases/HOTFIX-1.1.31.md)

## 1.1.30

- 修复首页 `dashboard-status` 的 ngrok Agent 发现逻辑会无条件扫描 `127.0.0.1:4040-4049` 的 P0 兼容性问题。实机复验确认企业 VPN 的本地服务也可能监听这些端口，周期性 `/api/tunnels` 请求会干扰其会话并导致服务端注销。
- ngrok Agent 状态检测改为严格所有权链：只接受当前 Portable 自带的 `runtime/ngrok/ngrok.exe`，并要求 PID 记录或当前 Portable 的 ngrok 配置路径能够证明进程归属；随后只枚举这些已验证 PID 自己的 TCP LISTEN 端口，再对这些端口查询 `/api/tunnels`。
- 彻底移除“猜测 localhost 端口”的发现方式。任何不属于 DevSpace 的本地服务，无论占用 4040、4041、4042 或其他端口，首页、启动检查与 tunnel 健康判断都不会主动访问它。
- 新增网络隔离回归契约，明确禁止 `4040-4049` 扫描，并要求 ngrok Agent 探测必须同时满足可执行文件路径、Portable 配置归属和监听 PID 所有权过滤；Portable Protocol 仍为 1.5，顶层 MCP Schema 不变。

[完整更新说明](docs/releases/HOTFIX-1.1.30.md)

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
