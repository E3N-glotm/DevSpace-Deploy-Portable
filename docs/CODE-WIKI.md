# DevSpace Deploy Portable — Code Wiki

> 面向源码维护者的结构化代码文档。涵盖项目整体架构、主要模块职责、关键类与函数说明、依赖关系、运行方式与安全边界。
>
> 当前稳定版本：**1.1.14** · Portable Protocol：**1.5** · 上游核心：[`Waishnav/devspace`](https://github.com/Waishnav/devspace) `1.0.5`
>
> 本文档基于仓库源码自动梳理生成，描述的是源码视图（不含 `runtime/`、`app/node_modules/` 等发行期产物）。

---

## 1. 项目概览

### 1.1 项目定位

DevSpace Deploy Portable 是面向 **Windows x64** 的便携式部署项目，把上游 [`@waishnav/devspace`](https://github.com/Waishnav/devspace) MCP 服务器封装成一个可解压即用的本地控制中心，目标用户场景是把 ChatGPT / Claude 等 MCP 客户端安全地接入本机真实编码工作区。

它在上游 DevSpace 之上扩展了：

- **便携运行时**：自带 Node、Git for Windows、cloudflared、ngrok（约 579 MiB），不依赖系统全局安装；
- **原生 WinForms 控制中心**：单 `DevSpace-Portable.exe`，集成部署、隧道、权限、插件、会话审阅、Memory 与 Computer Use 管理；
- **Computer Use Broker**：基于文件队列的本地桌面控制（WGC/DXGI/GDI 截图 + 原生 `SendInput`）；
- **插件管理**：本地安装/启停/版本切换 + 16 个固定槽位 + 热调度（`plugin_query` / `plugin_action`）；
- **会话审阅与回退**：有界稀疏日志（`sparse-journal-v4`）+ 受跟踪路径回退；
- **显式 Memories**：全局/工作区 SQLite 记录，凭据检测；
- **生命周期 Hooks**：固定 `executable + argv`，覆盖工作区、命令、修改、审阅、回退事件；
- **隧道管理**：ngrok 固定域名 / Cloudflare named tunnel，含固定 SHA-256 校验与缺失自动恢复。

### 1.2 仓库布局

```text
DevSpace-Deploy-Portable/
├── app/                       # Portable Node 应用入口 + 插件调度器
│   ├── DevSpace-Plugin.cmd    #   旧会话插件调度 CLI 入口
│   ├── plugin-admin.mjs       #   插件管理（安装/启停/槽位）入口
│   ├── plugin-dispatcher.mjs  #   插件工具执行 CLI
│   ├── package.json           #   运行时依赖锁（@waishnav/devspace file: 引用）
│   └── package-lock.json      #   锁文件（含 integrity）
├── vendor/waishnav-devspace/  # 受控的 DevSpace 1.0.5 Portable 核心包源
│   ├── dist/                  #   发布的 ESM 包（server.js 等）
│   ├── skills/                #   内置 Skill
│   ├── README.md / UPSTREAM.md / LICENSE
│   └── package.json
├── setup/                     # 原生 UI、Computer Use、隧道、构建、测试脚本
│   ├── native/                #   C# / C++ 原生源
│   ├── bundled-plugins/       #   内置插件（codex-runtime-bridge）
│   ├── plugin-example/        #   插件示例
│   ├── portable-manager.cjs   #   ★ Portable 总编排器
│   ├── computer-use-broker.cjs#   Computer Use 常驻 broker
│   ├── tunnel-launcher.cjs    #   隧道进程启动器
│   ├── logged-launcher.cjs    #   通用日志记录启动器
│   ├── ngrok-launcher.cjs     #   ngrok 启动器
│   ├── Portable-Setup.hta     #   旧 HTA 安装器（保留兼容）
│   ├── build-release.py       #   Release ZIP 打包
│   ├── finalize-release.py    #   发行前元数据校验
│   ├── create-update-manifest.py
│   ├── build-native-ui.cjs    #   编译 DevSpace-Portable.exe
│   ├── harden-nested-dependencies.mjs
│   └── test-*.mjs             #   回归测试套件
├── scripts/                   # 开发引导、核心打包、运行时恢复、源码校验
│   ├── bootstrap-dev.ps1      #   开发环境一键引导
│   ├── pack-devspace-core.mjs #   vendor -> packages/*.tgz
│   ├── verify-source-tree.mjs #   源码边界与敏感文件检查
│   ├── hydrate-runtime-from-release.ps1  # 从 Release 恢复 runtime/
│   ├── publish-github-release.ps1
│   ├── prepare-ci-runtime.ps1
│   ├── start-devspace.{cmd,sh}#   MCP 服务启动
│   ├── start-tunnel.{cmd,sh}  #   隧道启动
│   ├── start-ngrok.{cmd,sh}
│   ├── hidden-launch.vbs      #   隐藏控制台窗口启动器（被计划任务调用）
│   └── test-source.ps1        #   回归测试编排
├── docs/                      # 文档
│   ├── releases/HOTFIX-*.md   #   每个版本的完整 HOTFIX 说明
│   ├── acceptance/            #   历史验收记录
│   ├── DEVELOPMENT.md         #   开发指南
│   ├── RELEASING.md           #   发行流程
│   ├── UPDATE-DESIGN.md       #   1.1.15+ 应用内更新设计
│   └── CODEX-GAP-1.1.6.md
├── .github/workflows/         # CI（ci.yml）与发行（release.yml）
├── CHANGELOG.md
├── README.md / README-PORTABLE.md
├── VERSION-MANIFEST.json      # 版本、运行时、能力、SHA-256 清单
├── package.json               # 顶层工具脚本（core:pack / source:verify / bootstrap / test / release:manifest）
├── LICENSE / NOTICE / THIRD-PARTY-NOTICES.md / SECURITY.md
├── CONTRIBUTING.md / CODE_OF_CONDUCT.md / MIGRATION-CHECKLIST.md
└── BUILD-ACCEPTANCE.md
```

> **不进 Git** 的目录：`runtime/`（Node/Git/ngrok/cloudflared）、`app/node_modules/`、`packages/*.tgz`、`data/`（用户配置与状态）、`logs/`、`reports/`、`DevSpace-Portable.exe`、`SHA256SUMS.txt`、Release ZIP。`scripts/verify-source-tree.mjs` 强制这条边界。

### 1.3 版本与协议

- Portable 版本：`1.1.14`（`setup/portable-manager.cjs` 中 `PORTABLE_VERSION`）
- 服务端版本：`1.1.14`（`vendor/waishnav-devspace/dist/capabilities.js` 中 `DEVSPACE_SERVER_VERSION`）
- 协议版本：`1.5`（`DEVSPACE_PROTOCOL_VERSION`）
- 上游包：`@waishnav/devspace@1.0.5`，固定 commit `dca3b6a345a9285e63446d72376afdafe8c72af4`

`VERSION-MANIFEST.json` 是发行物的唯一权威清单，包含：固定运行时版本、SHA-256 校验、能力里程碑（`capabilityMilestones`，从 1.0.7 到 1.1.14）、关键文件哈希与策略（`policy`）。

---

## 2. 整体架构

### 2.1 分层视图

```text
┌──────────────────────────────────────────────────────────────────────┐
│  MCP 客户端（ChatGPT / Claude / 其他）                                │
│     ↕ HTTPS  https://<public-origin>/mcp                             │
└──────────────────────────────────────────────────────────────────────┘
                                ▲
                                │ 公网隧道
┌───────────────────────────────┴─────────────────────────────────────┐
│  隧道层  ngrok.exe / cloudflared.exe  （runtime/ 内，固定 SHA-256）   │
│     ↕ 127.0.0.1:7676                                                  │
└───────────────────────────────┬─────────────────────────────────────┘
                                ▲
                                │ 本地 HTTP / OAuth Bearer
┌───────────────────────────────┴─────────────────────────────────────┐
│  DevSpace MCP 服务器（vendor/waishnav-devspace/dist/server.js）       │
│   ├ Express + StreamableHTTP transport                                │
│   ├ OAuth 单用户授权（SingleUserOAuthProvider + SQLite）              │
│   ├ 工具注册：open/read/write/edit/grep/glob/ls/bash/apply_patch...   │
│   ├ 进程会话、文件监听、权限规则、审阅检查点、Memory、Hook             │
│   ├ Computer Use 工具（feature-tools.js）                             │
│   └ 插件调度（plugin-tools.js：plugin_query/plugin_action + 16 槽位） │
└───────────────────────────────┬─────────────────────────────────────┘
                                ▲
                                │ 文件队列 RPC（data/run/computer-use/）
┌───────────────────────────────┴─────────────────────────────────────┐
│  Computer Use Broker（setup/computer-use-broker.cjs，detached）       │
│   ├ 40ms 轮询 requests/，写入 responses/                              │
│   ├ computer-use-input.exe  → SendInput 鼠标/键盘/文本                │
│   └ computer-use-capture.exe → WGC > DXGI > GDI 截图                  │
└──────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│  原生控制中心（setup/native/DevSpacePortableApp.cs → DevSpace-Portable.exe）│
│   ├ 配置 / 隧道 / 计划任务管理（通过 setup/portable-manager.cjs）      │
│   ├ UI Lease 心跳（90s TTL，驱动 Computer Use 启停）                  │
│   ├ 插件管理 / 会话审阅 / Memory 管理 / Computer Use 队列 worker      │
│   └ 调度：schtasks /Run（DevSpace Portable MCP Server + Tunnel）     │
└───────────────────────────────┬─────────────────────────────────────┘
                                ▲
                                │ spawn + JSON stdin/stdout
┌───────────────────────────────┴─────────────────────────────────────┐
│  Portable Manager（setup/portable-manager.cjs，由 runtime/node 运行） │
│   ├ configure / install-tasks / start / stop / restart / status      │
│   ├ ui-open / ui-heartbeat / ui-close / ui-status（UI 租约）          │
│   ├ plugin-* / review-* / memory-* （转发到 dist 子模块）             │
│   ├ Computer Use broker 生命周期                                       │
│   └ 严格停止：Portable 拥有的进程树 + 0 残留 PID 校验                  │
└──────────────────────────────────────────────────────────────────────┘
```

### 2.2 关键数据流

**部署配置流**：原生 UI 表单 → `portable-manager.cjs configure` → 写 `data/config/config.json` + `auth.json` + `ngrok.yml`/`cloudflare.token` + `deployment.json`，并对所有敏感文件 `icacls` 限制 ACL（仅当前用户 + SYSTEM + Administrators）→ `install-tasks` 创建两个 LogonTrigger 计划任务（MCP + Tunnel，`LeastPrivilege` + `InteractiveToken`）。

**MCP 调用流**：客户端 → 公网隧道 → `127.0.0.1:7676/mcp` → Express Bearer 中间件 → `StreamableHTTPServerTransport` → `McpServer` 工具调度 → `WorkspaceRegistry.openWorkspace` → 后续工具在 workspaceId 上下文中执行 → 工具结果经 `redaction.js` 脱敏后返回。

**Computer Use 流**：MCP 工具 `computer_snapshot` / `computer_action`（`feature-tools.js`）→ `computer-use.js invokeComputerUse` 写入 `data/run/computer-use/requests/<uuid>.json` → broker（`computer-use-broker.cjs`）40ms 轮询 → 调 `computer-use-input.exe` / `computer-use-capture.exe` → 写 `responses/<uuid>.json` + `responses/<uuid>.png` → MCP 端 10ms 轮询读取并返回（带 12-60s 动态超时）。

**插件调用流**：MCP `plugin_query`/`plugin_action`（`plugin-tools.js`）→ `PluginManager.resolveTool` → 模板渲染 `${pluginDir}` `${workspaceRoot}` → `executePluginTool` spawn `argv` → 结构化 JSON 返回。旧会话通过 `app/DevSpace-Plugin.cmd` → `plugin-dispatcher.mjs` 走相同路径。

### 2.3 关键设计原则

1. **源码/运行时分离**：Git 只保存源码与构建脚本；约 579 MiB 的 `runtime/` 从 Release 恢复（`hydrate-runtime-from-release.ps1`）。`verify-source-tree.mjs` 强制此边界。
2. **固定可复现**：所有外部二进制（Node、Git、cloudflared）有固定 SHA-256；`app/package-lock.json` 用 `file:../packages/waishnav-devspace-1.0.5.tgz` + `integrity` 锁定核心包；`harden-nested-dependencies.mjs` 加固嵌套依赖（`brace-expansion`/`protobufjs`/`hono`/`undici`）。
3. **fail-closed 安全**：默认权限档为 `workspace`；`full-access` 仅获得当前 Windows 用户权限，**不绕过 UAC/ACL/杀毒/凭据提供者**；Computer Use 同时要求功能开关 + 权限档 + 有效 UI 租约。
4. **本地优先**：所有敏感状态（`auth.json`、`ngrok.yml`、`cloudflare.token`、`devspace.sqlite`、OAuth token）保存在本地 `data/`，绝不进入 Git 或 Release 源文件。
5. **零残留停止**：`stopServices` 用 PowerShell 枚举 Portable 拥有的进程树（基于 ROOT 路径前缀匹配 + 父子传播），`taskkill /T /F`，并校验端口监听器为空。
6. **热插拔插件**：`plugin_query`/`plugin_action` 是固定顶层 MCP 工具；插件安装/启停/升级/槽位重绑不改变 MCP Schema，无需刷新 ChatGPT 工具定义。
7. **有界审阅**：`review-checkpoints.js` 用 `sparse-journal-v4`（32 MiB/session、512 MiB/total 硬上限）替代全目录 shadow Git，避免大型工作区磁盘膨胀。

---

## 3. 主要模块职责

### 3.1 `app/` — Portable Node 应用入口

| 文件 | 职责 |
|------|------|
| [DevSpace-Plugin.cmd](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/app/DevSpace-Plugin.cmd) | 旧会话/CLI 入口；用 `runtime/node/node.exe` 调用 `plugin-dispatcher.mjs` |
| [plugin-dispatcher.mjs](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/app/plugin-dispatcher.mjs) | 插件工具执行 CLI：`list` / `refresh` / `query`（只读）/ `action`（修改）。强制 `--workspace`，校验 `readOnly` 与 command 一致性 |
| [plugin-admin.mjs](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/app/plugin-admin.mjs) | 插件管理 JSON-over-stdin CLI：`list`/`refresh`/`install`/`enable`/`disable`/`uninstall`/`bind-slot`/`unbind-slot`。状态目录由 `DEVSPACE_PORTABLE_STATE_DIR` 覆盖 |
| `package.json` | 锁定运行时依赖：`@waishnav/devspace`（file 引用）+ `brace-expansion`/`protobufjs`/`undici` 安全加固 |

### 3.2 `setup/` — 部署、原生 UI、Computer Use、构建

#### 核心编排

| 文件 | 职责 |
|------|------|
| [portable-manager.cjs](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/setup/portable-manager.cjs) | **★ 总编排器（~2100 行）**。命令式 CLI，覆盖：配置、计划任务、服务启停、UI 租约、Computer Use broker、插件/审阅/Memory 转发、进程树停止、SHA-256 校验、诊断。被 `DevSpace-Portable.cmd` 和原生 UI 共同调用 |
| [computer-use-broker.cjs](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/setup/computer-use-broker.cjs) | Computer Use 常驻 detached broker；40ms 轮询 `requests/`，调用 `manager.processComputerUseRequests` 执行截图/输入，写 `responses/`；UI 租约失效即退出 |
| [tunnel-launcher.cjs](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/setup/tunnel-launcher.cjs) | 隧道进程启动器；**白名单**只允许 `runtime/ngrok/ngrok.exe` 或 `runtime/cloudflared/cloudflared.exe`；记录 PID 到 `TUNNEL_PID_FILE` |
| [logged-launcher.cjs](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/setup/logged-launcher.cjs) | 通用启动器，把子进程 stdout/stderr 追加到指定日志文件，转发信号 |
| [ngrok-launcher.cjs](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/setup/ngrok-launcher.cjs) | ngrok 专用启动器（封装 `tunnel-launcher.cjs`） |

#### 原生 UI

| 文件 | 职责 |
|------|------|
| [native/DevSpacePortableApp.cs](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/setup/native/DevSpacePortableApp.cs) | **单文件 WinForms 应用**（C# / .NET Framework 4.8）。包含 `UiPalette` 配色、`NativeWindowEffects`（DWM 圆角/暗色背景/已存在窗口激活）、`ModernButton`/`ModernNavButton` 等自绘控件、配置表单、插件管理、会话审阅子页面、Memory 管理页面、Computer Use 队列 worker |
| [native/computer-use-capture.cpp](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/setup/native/computer-use-capture.cpp) | 桌面截图 helper（C++/WinRT + D3D11 + WIC）。后端顺序：WGC → DXGI Desktop Duplication → GDI/DIB。静态链接，目标机无需 VC++ 运行库 |
| [native/computer-use-input.cpp](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/setup/native/computer-use-input.cpp) | 输入 helper（`SendInput` 鼠标/滚轮/白名单按键/Unicode 文本） |
| [build-native-ui.cjs](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/setup/build-native-ui.cjs) | 用 `vswhere.exe` 发现 VS Build Tools + .NET Framework 4.8 引用程序集，编译生成根目录 `DevSpace-Portable.exe` |
| [build-native-ui.cmd](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/setup/build-native-ui.cmd) / [build-computer-use-helper.cmd](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/setup/build-computer-use-helper.cmd) | 编译入口 |
| `Portable-Setup.hta` / `legacy/Portable-Setup-1.1.8.hta` | 旧 HTA 安装器（1.1.9 起被原生 WinForms 替代，保留兼容） |

#### 构建与发行

| 文件 | 职责 |
|------|------|
| [build-release.py](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/setup/build-release.py) | 打包 Release ZIP；遍历 ROOT 排除 `data/`/`logs/`/`reports/`/`vendor/`/`.git`/`.github` 等，生成 `SHA256SUMS.txt` |
| [finalize-release.py](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/setup/finalize-release.py) | 发行前元数据校验（版本号、HOTFIX 文档、manifest 一致性） |
| [create-update-manifest.py](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/setup/create-update-manifest.py) | 生成 `release-assets/update-manifest.json`（供 1.1.15+ 应用内更新） |
| [harden-nested-dependencies.mjs](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/setup/harden-nested-dependencies.mjs) | 重写 `app/node_modules` 内嵌套依赖版本，强制与 `app/package.json` 的 `overrides` 一致 |
| [pid-preload.cjs](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/setup/pid-preload.cjs) | 进程 PID 预加载（用于子进程归属识别） |
| [permission-rules.example.json](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/setup/permission-rules.example.json) | 权限规则示例：`allow`/`deny`/`audit` 三态决策 + `executable` / `commandPattern` 匹配 |

#### 内置插件

| 路径 | 职责 |
|------|------|
| [bundled-plugins/codex-runtime-bridge/1.1.1/](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/setup/bundled-plugins/codex-runtime-bridge/1.1.1) | Codex 兼容桥；`enabledByDefault: true`，提供 `inventory`/`shell_snapshot`/`checkpoint_list`/`checkpoint_create`/`checkpoint_restore`/`keep_awake_*` 工具；声明本地 Codex Skills 根；`keep-awake.ps1` 持有系统唤醒请求 |
| [plugin-example/](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/setup/plugin-example) | 插件 manifest 示例（`devspace-example`，echo 工具） |

#### 测试

`setup/test-*.mjs`（共 14 个）：覆盖 Computer Use broker、Computer Use 批量/实机、原生 UI 心跳与工作流、原生 UI 弹性、插件管理器、运行时卡片、运行时日志 UI、会话能力、严格停止、Codex Runtime Bridge。由 `scripts/test-source.ps1` 编排。

### 3.3 `vendor/waishnav-devspace/` — 受控 DevSpace 核心

上游 `@waishnav/devspace@1.0.5` 的 Portable 维护副本。`UPSTREAM.md` 说明：此目录是 Portable 项目的权威可审查源；修改后跑 `npm run core:pack` 重新打包到 `packages/`，再 `npm ci --prefix app` 安装。**不要直接编辑 `app/node_modules`**。

`dist/` 是 ESM 包，主要模块：

#### 入口与配置

| 文件 | 职责 |
|------|------|
| [dist/server.js](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/vendor/waishnav-devspace/dist/server.js) | **★ MCP 服务器核心**。创建 Express + `StreamableHTTPServerTransport` + `McpServer`；注册 OAuth 路由（`mcpAuthRouter` + `requireBearerAuth`）；注册所有工具（open/read/write/edit/grep/glob/ls/bash/apply_patch/show_changes/capabilities/doctor/session_*/process_*/memory_*/computer_*/plugin_*）；注入 `serverInstructions`（按权限档/工具模式/特性生成不同提示） |
| [dist/cli.js](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/vendor/waishnav-devspace/dist/cli.js) | `devspace` CLI：`serve` / `init` / `doctor` / `config` / `agents` / `help` / `version`。`init` 用 `@clack/prompts` 交互式收集 allowedRoots/port/publicBaseUrl，生成 `~/.devspace/{config.json,auth.json}` |
| [dist/config.js](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/vendor/waishnav-devspace/dist/config.js) | `loadConfig()`：合并 `~/.devspace/config.json` 与环境变量（`DEVSPACE_*`）；解析 allowedRoots、allowedHosts、port、permissionProfile、toolMode、features、OAuth TTL 等 |
| [dist/capabilities.js](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/vendor/waishnav-devspace/dist/capabilities.js) | `DEVSPACE_PROTOCOL_VERSION`/`DEVSPACE_SERVER_VERSION` 常量；`FEATURE_CATALOG`（60+ 能力条目，含 maturity + since）；`buildCapabilities(config, pluginManager)` 生成 `capabilities` 工具返回值 |

#### 工作区与文件工具

| 文件 | 职责 |
|------|------|
| [dist/workspaces.js](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/vendor/waishnav-devspace/dist/workspaces.js) | `WorkspaceRegistry`：`openWorkspace`（checkout / worktree 模式）、`getWorkspace`（含会话恢复）、加载 `AGENTS.md`/`CLAUDE.md` 上下文与 Skills |
| [dist/workspace-store.js](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/vendor/waishnav-devspace/dist/workspace-store.js) | `createWorkspaceStore`：SQLite 工作区会话持久化 |
| [dist/pi-tools.js](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/vendor/waishnav-devspace/dist/pi-tools.js) | 文件工具实现，封装 `@earendil-works/pi-coding-agent` 的 read/write/edit/grep/glob/ls/bash 工具；路径解析按 `allowExternalPaths` 决定是否允许工作区外 |
| [dist/apply-patch.js](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/vendor/waishnav-devspace/dist/apply-patch.js) | 多文件 `apply_patch` 解析与应用 |
| [dist/artifact-tools.js](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/vendor/waishnav-devspace/dist/artifact-tools.js) | `download_artifact` 工具（ChatGPT native file → 本地文件） |
| [dist/incoming-artifacts.js](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/vendor/waishnav-devspace/dist/incoming-artifacts.js) | OpenAI incoming artifact 适配器 |
| [dist/skills.js](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/vendor/waishnav-devspace/dist/skills.js) | Skill 路径解析与加载；`loadWorkspaceSkills`、`formatPathForPrompt`、`markSkillActivated` |
| [dist/roots.js](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/vendor/waishnav-devspace/dist/roots.js) | `assertAllowedPath` / `expandHomePath` / `isPathInsideRoot` / `resolveAllowedPath` — 路径边界校验 |
| [dist/git.js](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/vendor/waishnav-devspace/dist/git.js) / [dist/git-worktrees.js](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/vendor/waishnav-devspace/dist/git-worktrees.js) | Git 操作封装与受管 worktree 创建 |

#### 进程与命令

| 文件 | 职责 |
|------|------|
| [dist/process-sessions.js](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/vendor/waishnav-devspace/dist/process-sessions.js) | `ProcessSessionManager`：bash/exec/write_stdin/poll/kill；持久 `processHandle`；环境变量注入（`DEVSPACE_WORKSPACE_ID` 等）；Windows PTY（node-pty/ConPTY） |
| [dist/process-platform.js](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/vendor/waishnav-devspace/dist/process-platform.js) | `resolveShellCommand` / `terminateProcessTree` 跨平台封装 |
| [dist/process-registry.js](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/vendor/waishnav-devspace/dist/process-registry.js) | `ProcessRegistryStore` + `processExists`：SQLite 进程注册表，PID 级重启识别 |
| [dist/doctor.js](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/vendor/waishnav-devspace/dist/doctor.js) | 结构化 `doctor` 诊断：Node/Git/Bash/PATH/数据库/隧道等检查项 + 修复建议 |

#### 权限、审计、监听

| 文件 | 职责 |
|------|------|
| [dist/permission-rules.js](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/vendor/waishnav-devspace/dist/permission-rules.js) | `PermissionRuleEngine`：读取 `config/permission-rules.json`；`evaluate(input)` 按 `executable` + `commandPattern` 匹配，返回 `allow`/`deny`/`audit` |
| [dist/redaction.js](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/vendor/waishnav-devspace/dist/redaction.js) | `redactText`/`redactValue`/`redactedJson`：递归脱敏 Bearer token、`password=`、`--token` 等 |
| [dist/runtime-state.js](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/vendor/waishnav-devspace/dist/runtime-state.js) | `StructuredRuntimeState`：SQLite `event_journal` 事件追加 + 序列游标轮询；权限规则、文件监听、进程注册表共用 |
| [dist/file-watch.js](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/vendor/waishnav-devspace/dist/file-watch.js) | `FileWatchManager`：递归 `fs.watch` + 事件入 journal |
| [dist/logger.js](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/vendor/waishnav-devspace/dist/logger.js) | `logEvent`、`requestIp`、`commandPreview`、`sessionIdPrefix` |
| [dist/mcp-sessions.js](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/vendor/waishnav-devspace/dist/mcp-sessions.js) | `McpSessionRegistry`：MCP 会话注册 + 24h 空闲清理（防止 abandoned session 累积） |
| [dist/server-shutdown.js](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/vendor/waishnav-devspace/dist/server-shutdown.js) | `shutdownHttpServer`：优雅关闭 HTTP server + transport |

#### OAuth

| 文件 | 职责 |
|------|------|
| [dist/oauth-provider.js](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/vendor/waishnav-devspace/dist/oauth-provider.js) | `SingleUserOAuthProvider`：单用户 OAuth 流（owner password 审批页 + 授权码 + access/refresh token，timingSafeEqual 比较） |
| [dist/oauth-store.js](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/vendor/waishnav-devspace/dist/oauth-store.js) | `SqliteOAuthStore` / `SqliteOAuthClientsStore`：OAuth 客户端与 token 持久化 |

#### Memory / Hook / 审阅

| 文件 | 职责 |
|------|------|
| [dist/memory-store.js](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/vendor/waishnav-devspace/dist/memory-store.js) | `MemoryStore`：`devspace_memories` 表（global/workspace 双 scope）；`list`/`upsert`/`delete`；疑似凭据检测（`SECRET_PATTERN`） |
| [dist/hook-manager.js](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/vendor/waishnav-devspace/dist/hook-manager.js) | `HookManager`：9 个事件（`workspace_open`/`before_command`/`after_command`/`before_mutation`/`after_mutation`/`before_review`/`after_review`/`before_rollback`/`after_rollback`）；固定 `executable + argv` + 模板渲染 |
| [dist/review-checkpoints.js](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/vendor/waishnav-devspace/dist/review-checkpoints.js) | `createReviewCheckpointManager`：`sparse-journal-v4`（每会话 32 MiB / 总 512 MiB 硬上限）；`beforeMutation` 捕获受跟踪路径预图像；`rollback` 受跟踪路径恢复 + pre-rollback safety snapshot；自动清理 legacy v3 |
| [dist/ui-session.js](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/vendor/waishnav-devspace/dist/ui-session.js) | `UiSessionLease`：读取 `data/run/ui-session.json`，校验 leaseId + 过期时间 + 心跳，`requireActive(capability)` 用于 Computer Use 等门禁 |

#### 插件系统

| 文件 | 职责 |
|------|------|
| [dist/plugin-manager.js](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/vendor/waishnav-devspace/dist/plugin-manager.js) | `PluginManager`：manifest 校验（id/version/maturity/tools argv-or-command/skillRoots/dependencies）；安全安装（目录/manifest/ZIP，拒绝路径穿越/符号链接/目录联接）；版本缓存；启停；16 槽位绑定（版本 + 内容哈希固定）；`evaluateDependencies` 检查 platforms/executables/files |
| [dist/plugin-tools.js](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/vendor/waishnav-devspace/dist/plugin-tools.js) | MCP 工具注册：`plugin_query`/`plugin_action` 热调度 + `plugin_list`/`plugin_install`/`plugin_enable`/... + 16 个 `plugin_slot_01..16` + `synchronizePluginSkillRoots` + 模板参数渲染（`${pluginDir}`/`${workspaceRoot}`/`${message}` 等） |
| [dist/schema-bundle.js](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/vendor/waishnav-devspace/dist/schema-bundle.js) | `generateSchemaBundle`/`writeSchemaBundle`：生成 plugin manifest JSON Schema bundle |

#### Computer Use

| 文件 | 职责 |
|------|------|
| [dist/computer-use.js](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/vendor/waishnav-devspace/dist/computer-use.js) | `invokeComputerUse`：写入 `requests/<uuid>.json`，10ms 轮询 `responses/<uuid>.json`，12-60s 动态超时；`captureDesktop` / `performComputerAction`；返回 metadata + image + 脱敏 stderr |
| [dist/feature-tools.js](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/vendor/waishnav-devspace/dist/feature-tools.js) | `registerFeatureTools`：注册 `memory_list`/`memory_upsert`/`memory_delete`/`computer_snapshot`/`computer_action`；`computerUseGuard` 三重门禁（feature + permission + uiLease）；`validateComputerAction` 校验 steps（1-50 步、总延迟 ≤30s、总文本 ≤80k 字符） |
| `dist/helpers/computer-use-capture.exe` / `computer-use-input.exe` / `computer-use.ps1` | 原生 helper（由 `setup/native/*.cpp` 编译）+ PowerShell 旧环境回退 |

#### Local Agent 集成

| 文件 | 职责 |
|------|------|
| `dist/local-agent-adapters.js` | `runLocalAgentProvider`：本地 agent provider 适配（Codex / Claude / Opencode / Pi） |
| `dist/local-agent-runtime.js` / `local-agent-store.js` / `local-agent-profiles.js` / `local-agent-targets.js` / `local-agent-availability.js` / `local-agent-path.js` | 本地 agent 运行时、会话存储、配置 profile、目标解析、可用性检测、路径隔离 |

#### 数据库

| 文件 | 职责 |
|------|------|
| [dist/db/client.js](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/vendor/waishnav-devspace/dist/db/client.js) | `openDatabase(stateDir)`：better-sqlite3 连接 + 迁移 |
| [dist/db/schema.js](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/vendor/waishnav-devspace/dist/db/schema.js) | Drizzle ORM schema：`workspace_sessions` / `loaded_agent_files` / `oauth_clients` / `oauth_access_tokens` / `oauth_refresh_tokens` / `local_agent_sessions` / `event_journal` / `process_registry` / `devspace_memories` 等 |
| [dist/db/migrations.js](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/vendor/waishnav-devspace/dist/db/migrations.js) | SQLite 迁移脚本 |

### 3.4 `scripts/` — 开发引导与构建

| 文件 | 职责 |
|------|------|
| [bootstrap-dev.ps1](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/scripts/bootstrap-dev.ps1) | 一键引导：选 bundled/系统 Node → 校验版本 → `pack-devspace-core.mjs` → `npm ci --prefix app` → `harden-nested-dependencies.mjs` → `verify-source-tree.mjs` → 条件编译原生 UI |
| [pack-devspace-core.mjs](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/scripts/pack-devspace-core.mjs) | `npm pack` vendor 目录到 `packages/waishnav-devspace-<ver>.tgz`，计算 sha256/sha512 integrity，回写到 `app/package-lock.json` |
| [verify-source-tree.mjs](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/scripts/verify-source-tree.mjs) | 源码边界检查：必需文件存在 + 禁止追踪 `runtime/`/`app/node_modules/`/`data/`/`logs/`/`packages/*.tgz`/`*.exe`/`*.zip`/`auth.json`/`ngrok.yml`/`cloudflare.token`/`devspace.sqlite` + 单文件 ≤95 MiB + `VERSION-MANIFEST.json` 合法 |
| [hydrate-runtime-from-release.ps1](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/scripts/hydrate-runtime-from-release.ps1) | 从 GitHub Release ZIP 提取 `runtime/`（不复制用户配置/OAuth/日志/data） |
| [publish-github-release.ps1](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/scripts/publish-github-release.ps1) | GitHub CLI 包装；读 `GH_TOKEN`/`GITHUB_TOKEN`/Git 凭据存储，不打印凭据；`-BypassProxy` 选项 |
| [prepare-ci-runtime.ps1](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/scripts/prepare-ci-runtime.ps1) | CI 运行时准备 |
| [test-source.ps1](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/scripts/test-source.ps1) | 回归测试编排（调用 `setup/test-*.mjs`） |
| [start-devspace.cmd](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/scripts/start-devspace.cmd) / [.sh](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/scripts/start-devspace.sh) | 启动 DevSpace MCP 服务（Git Bash → node dist/cli.js serve） |
| [start-tunnel.cmd](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/scripts/start-tunnel.cmd) / [.sh](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/scripts/start-tunnel.sh) | 启动隧道（ngrok / cloudflared） |
| [start-ngrok.cmd](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/scripts/start-ngrok.cmd) / [.sh](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/scripts/start-ngrok.sh) | ngrok 专用启动 |
| [hidden-launch.vbs](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/scripts/hidden-launch.vbs) | `WScript.Shell.Run(..., 0, True)` 隐藏控制台窗口启动（被计划任务调用，避免 1.5s 闪现） |

### 3.5 `docs/` — 文档

| 文件 | 职责 |
|------|------|
| [DEVELOPMENT.md](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/docs/DEVELOPMENT.md) | 开发指南：源码 vs 发行、Bootstrap、核心开发循环、原生 UI 编译、运行时状态安全 |
| [RELEASING.md](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/docs/RELEASING.md) | 发行流程：版本准备 → finalize-release.py → test → build-release.py → create-update-manifest.py → 打 tag → CI 上传；首次 bootstrap Release；公开化前门槛 |
| [UPDATE-DESIGN.md](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/docs/UPDATE-DESIGN.md) | 1.1.15+ 应用内更新设计：`versions/<ver>/` 目录 + `current.json` 指针 + Ed25519 签名 + 健康检查 + 失败回滚 |
| [CODEX-GAP-1.1.6.md](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/docs/CODEX-GAP-1.1.6.md) | Codex 集成差距分析 |
| `releases/HOTFIX-<ver>.md` | 每个版本的完整 HOTFIX 说明（1.0.1 ~ 1.1.14） |
| `acceptance/RELEASE-ACCEPTANCE-*.md` | 历史验收记录 |

### 3.6 `.github/` — CI/CD

| 文件 | 职责 |
|------|------|
| [workflows/ci.yml](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/.github/workflows/ci.yml) | Windows runner CI：prepare-ci-runtime → source:verify → core:pack → npm ci → harden-nested-deps → test-source.ps1 → `npm audit --omit=dev` |
| `workflows/release.yml` | 打 `v<ver>` tag 触发：从上一稳定 Release 恢复 runtime → 重新安装依赖 → 测试 → 构建 ZIP → 生成 update-manifest → 上传 Release |
| `ISSUE_TEMPLATE/` / `pull_request_template.md` / `CODEOWNERS` / `dependabot.yml` | 协作模板与依赖更新 |

---

## 4. 关键类与函数说明

### 4.1 `setup/portable-manager.cjs`（总编排器）

CommonJS 模块，导出 `{ COMPUTER_USE_BROKER_FILE, UI_LEASE_FILE, processComputerUseRequests, readJson, uiLeaseStatus, writeJson }` 供 broker 复用。

**关键常量**：
- `PORTABLE_VERSION = "1.1.14"`、`UI_LEASE_TTL_MS = 90_000`
- `TASK_MCP = "DevSpace Portable MCP Server"`、`TASK_TUNNEL = "DevSpace Portable Tunnel"`
- 路径：`data/config/`（config.json/auth.json/ngrok.yml/cloudflare.token/deployment.json）、`data/state/`（devspace.sqlite）、`data/run/`（pid/lease/computer-use）

**关键函数**：

| 函数 | 作用 |
|------|------|
| `main()` | 命令分发：`configure` / `set-computer-use` / `show-config` / `ui-open`/`ui-heartbeat`/`ui-close`/`ui-status` / `list-drives` / `install-tasks` / `start`/`stop`/`restart`/`enable`/`disable`/`uninstall-tasks` / `status` / `test` / `diagnose` / `verify-files` / `install-cloudflared` / `plugin-*` / `review-*` / `memory-*` / `log-paths` / `portable-processes` / `get` |
| `configure(input)` | 写 config.json/auth.json/ngrok.yml/cloudflare.token/deployment.json；备份旧文件；`icacls` 限制 ACL；seed 内置插件；cloudflared 缺失自动下载 + SHA-256 校验 |
| `normalizePermissionSettings(value, fallback)` | 三档：`workspace`（默认全 false 除 network/interactive/persistent）/ `full-access`（全 true）/ `custom`（按位） |
| `normalizeFeatureSettings(value, fallback)` | `computerUse` / `memories` / `hooks` / `uiSessionReview` |
| `installTasks()` | 生成计划任务 XML（LogonTrigger + LeastPrivilege + InteractiveToken + wscript hidden-launch.vbs），`schtasks /create`；先 `stopServices({leaveDisabled:true})` |
| `startServices()` | 校验配置 → 检查已健康 → `stopServices` → `startLocalService(port)`（最多 3 次 45s 重试，探活 OAuth metadata）→ `startPublicTunnel(provider, publicBaseUrl, port)` |
| `stopServices(options)` | 禁用 + 结束计划任务 → 停 Computer Use broker → 取消待处理请求 → 停隧道/MCP recorded PID → `stopPortableOwnedProcesses`（PowerShell 枚举 ROOT 拥有的进程树）→ `cleanupRunState` → 校验 0 残留 + 端口无监听 |
| `stopPortableOwnedProcesses(excludePids)` | 用 `Get-CimInstance Win32_Process` 枚举所有进程，按 `ExecutablePath`/`CommandLine` 是否以 ROOT 开头判定归属，传播父子关系，`taskkill /T /F`，20s 超时 |
| `openUiLease()` / `heartbeatUiLease(input)` / `closeUiLease(input)` / `uiLeaseStatus()` | UI 租约 90s TTL 管理；open 时若 Computer Use 启用则 `ensureComputerUseBroker` |
| `ensureComputerUseBroker(lease)` | 优先用原生 UI 内嵌 worker（`nativeQueueWorker` + UI PID 存活）；否则 `startComputerUseBroker(lease)` detached spawn `computer-use-broker.cjs` |
| `processComputerUseRequests(lease)` | 取最多 4 个 `requests/*.json`，重命名为 `.working-<pid>`，校验 leaseId，调 `runComputerInput`（input.exe 优先，PowerShell 回退）+ 可选 `captureComputerScreen`，写 `responses/<uuid>.json` + `.png` |
| `seedBundledPlugins()` | 把 `setup/bundled-plugins/<id>/<ver>/` 原子复制到 `data/plugins/installed/<id>/<ver>/`（已存在则保留） |
| `restrictAcl(target)` | `icacls /inheritance:r /grant:r *<userSID>:(OI)(CI)(F) *S-1-5-18:... *S-1-5-32-544:...` |
| `verifyFiles()` | 读 `SHA256SUMS.txt`，16 并发 worker 校验，路径越界即失败 |
| `runPluginAdmin(command, payload)` / `runReviewAdmin(action, payload)` / `runMemoryAdmin(action, payload)` | 通过 `runtime/node` spawn 子进程或动态 `import()` dist 模块执行，隔离状态目录 |

### 4.2 `app/plugin-dispatcher.mjs`（插件工具执行 CLI）

ESM 入口，从 `./node_modules/@waishnav/devspace/dist/*.js` 直接 import。

- `main(argv)`：解析 `list`/`refresh`/`query`/`action`；`query` 强制 `tool.readOnly === true`，`action` 拒绝只读工具
- 校验 `--workspace` 必填；`--yield-ms` 0-30000 整数；`--parameters-json` 必须是单个 JSON 对象
- `executePluginTool(tool, { workspaceId, parameters, processHandle, yieldTimeMs, auditToolName: "plugin_cli_<command>" }, { workspaces, processSessions, permissionRules, runtimeState })`

### 4.3 `app/plugin-admin.mjs`（插件管理 CLI）

- JSON-over-stdin，命令：`list`/`refresh`/`install`/`enable`/`disable`/`uninstall`/`bind-slot`/`unbind-slot`
- 状态目录：`DEVSPACE_PORTABLE_STATE_DIR` 或 `<root>/data/state`
- 输出统一含 `plugins` + `slots` + `reconnectRequired: false`（热插拔，无需刷新 ChatGPT 工具定义）

### 4.4 `setup/native/DevSpacePortableApp.cs`（原生 WinForms UI）

单文件 C# 应用，namespace `DevSpacePortable.NativeUI`。

- `UiPalette`：固定调色板（背景 `#F6F8FC`、主色 `#495BF6`、Computer Use 金色 `#E2B73F` 等）
- `NativeWindowEffects`：P/Invoke `DwmSetWindowAttribute`（圆角 attribute 33、暗色背景 attribute 38）、`EnumWindows` 激活已存在窗口
- `DrawingUtil.Rounded`：圆角 `GraphicsPath`
- `ModernButton` / `ModernNavButton`：自绘按钮，`Busy` 状态显示"执行中…"（1.1.14 改为仅触发按钮 busy，不禁用整窗）
- 主窗体：配置表单（隧道/工具模式/权限/根目录/Owner Password）+ 选项卡导航（部署/插件/会话/Memory/日志）
- Computer Use 队列 worker：原生 UI 内嵌轮询 `requests/`（`nativeQueueWorker` 标志），免启动 detached broker

### 4.5 `vendor/waishnav-devspace/dist/server.js`（MCP 服务器）

- `createServer(config)`：返回 `{ app, close, localAgentProviders }`
- 注册工具：
  - 工作区：`open_workspace` / `close_workspace` / `session_list` / `session_resume` / `session_archive`
  - 文件：`read` / `write` / `edit` / `grep` / `glob` / `ls` / `bash` / `apply_patch` / `show_changes`
  - 进程：`exec_command` / `write_stdin` / `process_list` / `process_attach` / `process_kill` / `poll_process`
  - 文件监听：`watch_start` / `watch_stop` / `events_poll`
  - 诊断：`capabilities` / `doctor` / `doctor_history`
  - 权限：`permission_rules_list` / `permission_rules_set`
  - Memory / Hook / 审阅：由 `feature-tools.js` 注册
  - Computer Use：`computer_snapshot` / `computer_action`
  - 插件：由 `plugin-tools.js` 注册（`plugin_query`/`plugin_action`/`plugin_list`/.../`plugin_slot_01..16`）
  - 工件：`download_artifact`（`artifact-tools.js`）
- `toolWidgetDescriptorMeta(config, kind)`：附加 `ui.resourceUri` + `openai/toolInvocation/invoking`/`invoked` 状态元数据
- `serverInstructions(config)`：按 `toolMode`（`full`/`codex`/`minimal`）+ `permissionProfile` + `features` 生成不同 LLM 指令

### 4.6 `vendor/waishnav-devspace/dist/plugin-manager.js`（插件管理器）

- `PluginManager` 类：构造 `(config, runtimeState)`，加载 `data/plugins/installed/<id>/<ver>/manifest.json`
- `parseManifest(path)` / `validateManifest`：id 正则 `^[a-z0-9][a-z0-9._-]{0,63}$`、tool name `^[a-zA-Z][a-zA-Z0-9_-]{0,63}$`、maturity ∈ {stable,experimental,deprecated}、tool 必须有 `argv` 或 `command` 之一
- `installFromPath(sourcePath, { replace })`：支持目录/manifest.json/ZIP；拒绝路径穿越、符号链接、目录联接；上限 20000 文件 / 1 GiB
- `setEnabled(pluginId, enabled, version)` / `uninstall(pluginId, version)`
- `bindSlot(slot, pluginId, toolName)` / `unbindSlot(slot)`：16 槽位，绑定到固定 plugin version + manifest 内容哈希；插件变更后 fail-closed
- `evaluateDependencies(pluginVersion)`：检查 platforms / executables / optionalExecutables / environment / files
- `enabledSkillRoots()`：返回已启用插件的 skillRoots（含环境变量展开 `%USERPROFILE%`/`${VAR}`/`~`）

### 4.7 `vendor/waishnav-devspace/dist/computer-use.js` + `feature-tools.js`

- `invokeComputerUse(payload, { leaseId })`：
  1. 校验 `process.platform === "win32"` + `leaseId`
  2. 生成 `requestId`，写 `requests/<uuid>.json.tmp-<pid>` → rename（原子）
  3. 轮询 `responses/<uuid>.json`（10ms 间隔，12-60s 动态超时 = `BASE 12s + sum(delayMs) ≤ 60s`）
  4. 失败抛脱敏错误；成功返回 `{ metadata, image, stderr }`
  5. finally 清理 request/response/image
- `captureDesktop(options)` / `performComputerAction(input, options)`
- `feature-tools.js registerFeatureTools(server, services)`：注册 `memory_list`/`memory_upsert`/`memory_delete`/`computer_snapshot`/`computer_action`
- `computerUseGuard(config, uiLease)`：三重门禁（feature + permission + uiLease.requireActive）
- `validateComputerAction(input)`：steps 1-50、总延迟 ≤30s、总文本 ≤80k 字符；pointActions 需整数 x/y；scroll 需整数 delta；keypress 需非空 keys 数组；type_text 需 text

### 4.8 `vendor/waishnav-devspace/dist/review-checkpoints.js`（有界稀疏审阅）

- `createReviewCheckpointManager(options)`：`FORMAT_VERSION = 4`、`SESSION_DIRECTORY = "review-sessions-v4"`
- 硬上限：`MAX_TRACKED_FILES = 2048`、`MAX_FILE_BYTES = 4 MiB`、`MAX_SESSION_STORED_BYTES = 32 MiB`、`MAX_TOTAL_STATE_BYTES = 512 MiB`、`MAX_SESSION_DIRECTORIES = 30`、`MAX_SAFETY_SNAPSHOTS = 5`
- `beforeMutation({ workspaceId, root, paths, kind })`：捕获受跟踪路径预图像（gzip 压缩 + 去重）；`kind: "shell"` 时标记 `shellMutationObserved`，回退仅覆盖结构化工具已知路径
- `rollback`：受跟踪路径恢复 + 自动 pre-rollback safety snapshot + 确认 token
- `scheduleLegacyCleanup`：异步清理 `review-sessions-v3` / `review-repositories-v3`

### 4.9 `vendor/waishnav-devspace/dist/permission-rules.js`

- `PermissionRuleEngine`：读取 `config/permission-rules.json`（默认 `defaultDecision: "allow"`）
- `evaluate(input)`：按 `executable`（basename 小写）+ `commandPattern`（正则 i）匹配，返回 `{ decision, matchedRule }`
- 三态：`allow` / `deny` / `audit`（audit 记录但不阻断）

### 4.10 `setup/computer-use-broker.cjs`

detached 进程，`require("./portable-manager.cjs")` 复用 `processComputerUseRequests` / `readJson` / `writeJson`。

- 接收 `leaseId`（argv[2] 或 `DEVSPACE_COMPUTER_USE_LEASE_ID`）
- `updateState(extra, force)`：节流写 `broker.json`（1s 一次，除非 force）
- 主循环：读 `ui-session.json` 校验 leaseId + 未过期 → `processComputerUseRequests(lease)` → 有处理则 1ms 再轮询，否则 40ms
- lease 失效即退出，finally 清理 `broker.json`（仅当 pid + leaseId 匹配）

### 4.11 `scripts/pack-devspace-core.mjs`

- 校验 `vendor/waishnav-devspace/dist/server.js` 存在
- 清理 `packages/waishnav-devspace-*.tgz`
- 调 `npm pack`（优先 bundled npm-cli.js，回退系统 npm.cmd）
- 计算 sha256 / sha512-base64 integrity
- 回写到 `app/package-lock.json` 的 `packages["node_modules/@waishnav/devspace"]` 与根 dependencies

### 4.12 `scripts/verify-source-tree.mjs`

- `required` 列表：README/CHANGELOG/LICENSE/VERSION-MANIFEST.json/vendor package.json/server.js/DevSpacePortableApp.cs/pack-devspace-core.mjs
- `forbiddenTrackedPatterns`：`runtime/` / `app/node_modules/` / `data/` / `logs/` / `reports/` / `packages/*.tgz` / `release-assets/!(README.md)` / `*.zip` / `SHA256SUMS.txt` / `DevSpace-Portable.exe` / `<uuid>_DevSpace-Portable.exe`
- 单文件 ≤95 MiB
- 敏感文件检测：`auth.json` / `ngrok.yml` / `cloudflare.token` / `devspace.sqlite`
- `VERSION-MANIFEST.json` 的 `release` 必须以 `DevSpacePortable-Windows-x64-` 开头

---

## 5. 依赖关系

### 5.1 上游依赖

| 依赖 | 版本 | 用途 |
|------|------|------|
| [`@waishnav/devspace`](https://github.com/Waishnav/devspace) | 1.0.5（commit `dca3b6a`） | MCP 服务器核心，受控 fork 在 `vendor/waishnav-devspace/` |

### 5.2 运行时依赖（`vendor/waishnav-devspace/package.json`）

| 依赖 | 用途 |
|------|------|
| `@modelcontextprotocol/sdk` | MCP 服务器 SDK（`McpServer` / `StreamableHTTPServerTransport` / OAuth middleware） |
| `@modelcontextprotocol/ext-apps` | `registerAppTool` / `registerAppResource`（ChatGPT Apps 兼容） |
| `@agentclientProtocol/sdk` | Agent Client Protocol |
| `@anthropic-ai/claude-agent-sdk` | Claude agent 集成 |
| `@openai/codex-sdk` | Codex agent 集成 |
| `@opencode-ai/sdk` | Opencode agent 集成 |
| `@earendil-works/pi-coding-agent` | 文件工具（read/write/edit/grep/glob/ls/bash）+ Skill 加载 + shell config |
| `@pierre/diffs` | 差异展示 |
| `@clack/prompts` | CLI 交互式提示（`devspace init`） |
| `better-sqlite3` | SQLite（可选 `node-pty` for PTY） |
| `drizzle-orm` | SQLite schema 定义 |
| `express` | HTTP 服务器 |
| `react` / `react-dom` / `lucide` | Workspace App UI（`dist/ui/`） |
| `zod` | 输入/输出 schema 校验 |
| `semver` / `yaml` / `diff` | 版本比较 / YAML 解析 / 文本差异 |

**安全 overrides**（`app/package.json` + `vendor/package.json`）：
- `brace-expansion@5.0.9`（CVE 修复）
- `protobufjs@7.6.5`
- `hono@4.13.0`
- `undici@8.10.0`

### 5.3 工具链依赖

| 工具 | 版本（VERSION-MANIFEST） | 用途 |
|------|------|------|
| Node.js | 24.18.1（runtime，源码要求 `>=22.19 <27`） | 运行 MCP 服务器 + 所有 .mjs/.cjs 脚本 |
| Git for Windows | 2.51.2 | Bash + git + curl（备用下载） |
| cloudflared | 2026.7.3 | Cloudflare named tunnel（固定 SHA-256，缺失自动下载） |
| ngrok | 3.39.10 | ngrok 固定域名隧道（**专有软件**，公开化前需替换） |
| Python | 3.11+ | 发行脚本（build-release.py / finalize-release.py / create-update-manifest.py） |
| GitHub CLI | 最新 | 发布 Release（`publish-github-release.ps1`） |
| VS Build Tools + .NET Framework 4.8 | — | 编译 `DevSpace-Portable.exe` + native helpers |

### 5.4 模块间依赖（关键路径）

```text
DevSpace-Portable.cmd
  └─> setup/portable-manager.cjs   （runtime/node 执行）
        ├─> app/plugin-admin.mjs    （plugin-* 命令）
        ├─> vendor/dist/review-checkpoints.js  （review-* 命令，动态 import）
        ├─> vendor/dist/db/client.js + memory-store.js  （memory-* 命令）
        ├─> setup/computer-use-broker.cjs  （detached spawn，Computer Use 启用时）
        │     └─> vendor/dist/helpers/computer-use-{input,capture}.exe
        ├─> scripts/start-devspace.cmd  （计划任务调用，启动 MCP）
        │     └─> vendor/dist/cli.js serve → dist/server.js
        └─> scripts/start-tunnel.cmd  （计划任务调用）
              └─> setup/tunnel-launcher.cjs → runtime/{ngrok,cloudflared}/*.exe

DevSpace-Portable.exe  （原生 UI，C#）
  └─> setup/portable-manager.cjs  （通过 spawn + JSON stdin/stdout）
        └─> （同上）

ChatGPT/Claude  （MCP 客户端）
  └─> https://<public>/mcp → ngrok/cloudflared → 127.0.0.1:7676
        └─> vendor/dist/server.js → 各工具 → 工作区文件 / 进程 / 插件 / Computer Use broker
```

### 5.5 内部模块依赖（vendor dist 内部）

```text
server.js
  ├─ config.js (loadConfig)
  ├─ capabilities.js (DEVSPACE_PROTOCOL_VERSION, buildCapabilities)
  ├─ workspaces.js (WorkspaceRegistry) ─> workspace-store.js ─> db/client.js
  ├─ pi-tools.js ─> roots.js ─> skills.js ─> @earendil-works/pi-coding-agent
  ├─ apply-patch.js
  ├─ artifact-tools.js + incoming-artifacts.js
  ├─ process-sessions.js ─> process-platform.js ─> process-registry.js ─> db/client.js
  ├─ file-watch.js ─> runtime-state.js ─> db/client.js + redaction.js
  ├─ permission-rules.js ─> redaction.js
  ├─ plugin-manager.js ─> db/client.js + redaction.js + semver
  ├─ plugin-tools.js ─> plugin-manager.js + schema-bundle.js + capabilities.js
  ├─ feature-tools.js ─> computer-use.js + memory-store.js + hook-manager.js + review-checkpoints.js + ui-session.js
  ├─ oauth-provider.js ─> oauth-store.js ─> db/client.js
  ├─ doctor.js ─> db/client.js
  ├─ mcp-sessions.js + server-shutdown.js
  └─ logger.js + redaction.js
```

---

## 6. 项目运行方式

### 6.1 环境要求

- **OS**：Windows 10/11 x64
- **Node.js**：`>=22.19 <27`（runtime 自带 24.18.1）
- **Python**：3.11+（仅发行时）
- **Git**（仅发行时需要 GitHub CLI）
- **VS Build Tools + .NET Framework 4.8 引用程序集**（仅编译原生 UI 时）

### 6.2 用户首次部署（Release ZIP）

1. 从 GitHub Releases 下载 `DevSpacePortable-Windows-x64-1.1.14.zip`，解压到任意目录。
2. 双击 `DevSpace-Portable.cmd`（无参数）→ 启动 `DevSpace-Portable.exe`（原生 UI）。
3. 在 UI 中选择：
   - 隧道：`ngrok 固定域名` 或 `Cloudflare Tunnel + 自定义域名`
   - 工具模式：`full`（默认）/ `codex`（实验性，多文件 apply_patch + 持久命令会话）/ `minimal`（精简）
   - 权限档：`workspace`（默认）/ `full-access`（当前 Windows 用户全权限）/ `custom`
   - 公网根地址、Token、允许目录、Owner Password（≥16 字符，缺失自动生成）
4. 点"保存并自动部署"→ `portable-manager.cjs configure` + `install-tasks` + `start`。
5. UI 显示状态健康后，把 `https://<public-origin>/mcp` 填入 ChatGPT 自定义 App/connector。
6. ChatGPT 首次连接时打开 Owner password 审批页，输入 `auth.json` 中的 `ownerToken`。

**Cloudflare 模式额外要求**：先在 Cloudflare 控制台创建 remotely-managed named tunnel，自定义域名 Published application 的 Service URL 指向 `http://127.0.0.1:7676`。`cloudflared` 缺失时保存配置会自动下载并 SHA-256 校验。

### 6.3 开发流程

```powershell
# 首次克隆后
PowerShell -NoProfile -ExecutionPolicy Bypass -File scripts/bootstrap-dev.ps1

# 核心开发循环
# 1. 修改 vendor/waishnav-devspace/ 或 setup/scripts/app/
npm run core:pack                       # 重新打包核心
npm ci --prefix app                     # 刷新 app/node_modules
npm test                                # = scripts/test-source.ps1

# 隔离测试（避免污染生产 data/）
$env:DEVSPACE_PORTABLE_CONFIG_DIR = "<temp>"
$env:DEVSPACE_PORTABLE_STATE_DIR = "<temp>"
$env:DEVSPACE_PORTABLE_RUN_DIR = "<temp>"
```

**Bootstrap 顺序**：`pack-devspace-core.mjs` → `npm ci --prefix app` → `harden-nested-dependencies.mjs` → `verify-source-tree.mjs` → 条件 `build-native-ui.cjs`。

### 6.4 从 Release 恢复运行时（构建完整 ZIP）

```powershell
$env:GH_TOKEN = "<具私有仓库读取权限的 GitHub Token>"
PowerShell -NoProfile -ExecutionPolicy Bypass -File scripts/hydrate-runtime-from-release.ps1 -Version 1.1.14
```

只从 Release ZIP 提取 `runtime/`，不复制用户配置/OAuth/日志/`data/`。

### 6.5 测试

```powershell
npm run source:verify                   # 源码边界检查
npm run core:pack                       # 打包核心
PowerShell -NoProfile -ExecutionPolicy Bypass -File scripts/test-source.ps1
```

`setup/test-*.mjs` 14 个测试覆盖：Computer Use broker/批量/实机、原生 UI 心跳/工作流/弹性、插件管理器、运行时卡片、运行时日志 UI、会话能力、严格停止、Codex Runtime Bridge。

CI（`.github/workflows/ci.yml`）在 `windows-2025` runner 执行：`prepare-ci-runtime` → `source:verify` → `core:pack` → `npm ci --prefix app` → `harden-nested-dependencies` → `test-source.ps1 -SkipInstall -SkipAudit` → `npm audit --omit=dev`。

### 6.6 发行

```powershell
# 1. 更新代码与测试
# 2. 添加 docs/releases/HOTFIX-<version>.md
# 3. 更新 CHANGELOG.md / README / UI / server / portable-manager / test strings / VERSION-MANIFEST.json
npm run core:pack
python setup/finalize-release.py <version> --hotfix docs/releases/HOTFIX-<version>.md
PowerShell -NoProfile -ExecutionPolicy Bypass -File scripts/test-source.ps1
python setup/build-release.py
python setup/create-update-manifest.py --repository E3N-glotm/DevSpace-Deploy-Portable

# 4. 提交 + 打 annotated tag
git tag -a v<version> -m "DevSpace Portable <version>"
git push origin main --follow-tags
```

`release.yml` workflow 自动：从上一稳定 Release 恢复 runtime → 重新安装依赖 → 测试 → 构建 ZIP → 生成 update-manifest → 上传 `DevSpacePortable-Windows-x64-<version>.zip` + `update-manifest.json` + `SHA256SUMS-release.txt`。

**首次 bootstrap Release**：手动上传已验证的 1.1.14 ZIP（`scripts/publish-github-release.ps1 -Version 1.1.14 -BypassProxy`），后续版本以 1.1.14 为 runtime 源。

### 6.7 命令清单（`DevSpace-Portable.cmd <command>` 或 `portable-manager.cjs <command>`）

```
configure                       set-computer-use             show-config
ui-open  ui-heartbeat  ui-close  ui-status
list-drives
install-tasks  uninstall-tasks
start  stop  restart  enable  disable
status  test  diagnose  verify-files  install-cloudflared
plugin-list  plugin-refresh  seed-bundled-plugins
plugin-install  plugin-enable  plugin-disable  plugin-uninstall
plugin-slot-bind  plugin-slot-unbind
review-list  review-details  review-update  review-rollback  review-restore-safety
memory-list  memory-upsert  memory-delete
log-paths  portable-processes  get
```

---

## 7. 数据与配置

### 7.1 运行时目录布局（解压后）

```text
DevSpacePortable/
├── DevSpace-Portable.cmd         # 用户入口（无参 → 启动 EXE；有参 → portable-manager.cjs）
├── DevSpace-Portable.exe         # 原生 WinForms UI（发行期生成，不进 Git）
├── app/
│   ├── DevSpace-Plugin.cmd       # 旧会话插件 CLI
│   ├── plugin-admin.mjs
│   ├── plugin-dispatcher.mjs
│   ├── package.json / package-lock.json
│   └── node_modules/             # 不进 Git（含 @waishnav/devspace + helpers）
├── setup/                        # 部署脚本、原生源、broker、bundled plugins
├── vendor/waishnav-devspace/     # 受控核心源
├── scripts/                      # 启动/引导/校验脚本
├── runtime/                      # 不进 Git（~579 MiB）
│   ├── node/node.exe
│   ├── git/bin/bash.exe + cmd/git.exe + mingw64/bin/curl.exe
│   ├── ngrok/ngrok.exe
│   └── cloudflared/cloudflared.exe
├── data/                         # 不进 Git（用户配置与状态）
│   ├── config/
│   │   ├── config.json           # host/port/allowedRoots/publicBaseUrl/permissions/features
│   │   ├── auth.json             # { ownerToken }  （ACL 限制）
│   │   ├── ngrok.yml             # version 3 + agent.authtoken (+ proxy_url/connect_cas)
│   │   ├── cloudflare.token      # 单行 token（ACL 限制）
│   │   ├── deployment.json       # formatVersion 5 + tunnelProvider/toolMode/permissions/features/providerUrls/taskNames
│   │   ├── permission-rules.json # 可选 allow/deny/audit 规则
│   │   └── backup/<timestamp>/   # 配置变更前备份
│   ├── state/
│   │   └── devspace.sqlite       # 工作区会话/进程注册表/event_journal/OAuth/Memory/审阅索引
│   ├── run/
│   │   ├── devspace.pid          # MCP 服务 PID
│   │   ├── tunnel.pid / ngrok.pid
│   │   ├── ui-session.json       # UI 租约（90s TTL）
│   │   └── computer-use/
│   │       ├── broker.json       # broker 状态
│   │       ├── requests/<uuid>.json
│   │       └── responses/<uuid>.json + <uuid>.png
│   └── plugins/installed/<id>/<ver>/   # 已安装插件
├── logs/                         # devspace.log / ngrok.log / cloudflared.log
├── reports/                      # latest-http-test.txt / portable-*-task.xml
├── packages/                     # 不进 Git（waishnav-devspace-1.0.5.tgz）
├── release-assets/               # update-manifest.json / SHA256SUMS-release.txt
└── SHA256SUMS.txt                # 不进 Git（发行期生成）
```

### 7.2 关键配置文件

**`data/config/config.json`**：
```json
{
  "host": "127.0.0.1",
  "port": 7676,
  "allowedRoots": ["C:\\Users\\me\\projects"],
  "publicBaseUrl": "https://example.ngrok-free.app",
  "stateDir": "<ROOT>/data/state",
  "subagents": false,
  "permissions": { "profile": "workspace", "allowExternalPaths": false, ... },
  "features": { "computerUse": false, "memories": true, "hooks": true, "uiSessionReview": true }
}
```

**`data/config/deployment.json`**（formatVersion 5）：扩展运行时配置，含 `tunnelProvider` / `toolMode` / `providerUrls`（双隧道保留）/ `taskNames` / `permissionMode`（selected-roots / all-drive-roots）/ `cloudflaredVersion` / `configuredAt`。

**`data/config/permission-rules.json`**（可选，示例见 `setup/permission-rules.example.json`）：
```json
{
  "version": 1,
  "defaultDecision": "allow",
  "rules": [
    { "id": "audit-ssh", "executable": "ssh.exe", "decision": "audit" },
    { "id": "deny-format-drive", "executable": "format.exe", "decision": "deny" },
    { "id": "audit-reg-delete", "executable": "reg.exe", "commandPattern": "\\bdelete\\b", "decision": "audit" }
  ]
}
```

### 7.3 权限模型

| 档位 | externalPaths | arbitraryCommands | shellMutation | networkAccess | credentialAccess | computerUse | interactiveProc | persistentProc |
|------|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `workspace`（默认） | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | ✓ | ✓ |
| `full-access` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `custom` | 用户选择 | 用户选择 | 用户选择 | 用户选择 | 用户选择 | 用户选择 | 用户选择 | 用户选择 |

**边界声明**：`full-access` 仅获得**当前 Windows 用户**已有的权限，**不**绕过 UAC、ACL、杀毒软件、凭据提供者或远端服务器权限。计划任务 `RunLevel: LeastPrivilege`、`LogonType: InteractiveToken`。

### 7.4 工具模式

| 模式 | 工具集 | 备注 |
|------|--------|------|
| `full`（默认） | open/read/write/edit/grep/glob/ls/bash/apply_patch/show_changes + 全部能力 | 兼容性最好 |
| `codex`（实验性） | 多文件 apply_patch + 持久命令会话（exec_command/write_stdin/poll_process）+ show_changes | Codex 风格运行时卡片 |
| `minimal` | 精简工具集（grep/glob/ls 禁用，改用 bash + 命令行工具） | — |

切换模式会重启 DevSpace 并要求 ChatGPT 网页端刷新工具定义（仅当顶层 Schema 变化时）。

---

## 8. 安全边界

### 8.1 绝不提交/上传的内容

- `data/config/auth.json`、`ngrok.yml`、`cloudflare.token`
- `data/state/devspace.sqlite` 及 OAuth Token
- `logs/`、`reports/`、Computer Use 临时请求
- 已部署目录的完整副本

提交前必须 `npm run source:verify`。

### 8.2 ACL 限制

`portable-manager.cjs restrictAcl(target)` 对所有敏感文件/目录执行 `icacls /inheritance:r /grant:r *<userSID>:(OI)(CI)(F) *S-1-5-18:(OI)(CI)(F) *S-1-5-32-544:(OI)(CI)(F)`，仅当前用户 + SYSTEM + Administrators 完全控制。

### 8.3 Computer Use 三重门禁

1. `features.computerUse === true`（功能开关）
2. `permissions.allowComputerUse === true`（权限档，需 `full-access` 或 `custom` 启用）
3. `UiSessionLease.requireActive("Computer Use")`（UI 租约有效，90s 心跳）

任一不满足即拒绝。UI 关闭或心跳超时 → 自动取消待处理请求 + 停 broker。

### 8.4 隧道启动器白名单

`tunnel-launcher.cjs` 硬编码只允许 `runtime/ngrok/ngrok.exe` 或 `runtime/cloudflared/cloudflared.exe`，拒绝任何其他可执行文件。

### 8.5 计划任务归属校验

`taskOwnedByRoot(task)` 检查计划任务 XML 的 action 是否属于当前 ROOT 路径，防止跨安装控制（`scheduledTaskRootOwnershipCheck` 能力）。

### 8.6 cloudflared 固定 SHA-256

`ensureCloudflaredRuntime()`：已存在则校验 SHA-256；缺失则从 GitHub 下载（fetch 失败回退 bundled curl）→ SHA-256 校验 → 版本检查 → 原子写入。

### 8.7 公开化前门槛（`docs/RELEASING.md`）

1. 移除公开 ZIP 中的 `runtime/ngrok/ngrok.exe` 或取得再分发授权；
2. 改为首次启用时从官方来源下载 + SHA-256 校验；
3. 审查第三方声明与 SBOM；
4. 确认无历史 commit/Release 含凭据或本地运行时状态。

### 8.8 1.1.15+ 更新安全（`docs/UPDATE-DESIGN.md`）

- HTTPS 不是信任边界；updater 必须用内嵌公钥验证 Ed25519 签名；
- 签名密钥不存仓库或通用自托管 runner；
- 降级需显式确认（除非自动失败回滚）；
- 拒绝路径穿越 + 不跟随归档链接；
- Schema 变化时明确提示用户刷新 ChatGPT 工具定义。

---

## 9. 附录

### 9.1 关键常量速查

| 常量 | 值 | 出处 |
|------|----|----|
| `PORTABLE_VERSION` | `1.1.14` | `setup/portable-manager.cjs` |
| `DEVSPACE_SERVER_VERSION` | `1.1.14` | `vendor/.../capabilities.js` |
| `DEVSPACE_PROTOCOL_VERSION` | `1.5` | `vendor/.../capabilities.js` |
| `UI_LEASE_TTL_MS` | 90000 | `setup/portable-manager.cjs` |
| `LOCAL_SERVICE_START_TIMEOUT_MS` | 45000 | `setup/portable-manager.cjs` |
| `TUNNEL_START_TIMEOUT_MS` | 45000 | `setup/portable-manager.cjs` |
| `SERVICE_START_ATTEMPTS` | 3 | `setup/portable-manager.cjs` |
| `PORTABLE_STOP_TIMEOUT_MS` | 20000 | `setup/portable-manager.cjs` |
| Computer Use broker poll | 40ms 请求 / 10ms 响应 | `setup/computer-use-broker.cjs` / `vendor/.../computer-use.js` |
| Computer Use 超时 | 12s 基础 / 60s 硬上限 | `vendor/.../computer-use.js` |
| `RESERVED_PLUGIN_SLOT_COUNT` | 16 | `vendor/.../plugin-manager.js` |
| 审阅硬上限 | 32 MiB/session · 512 MiB/total · 2048 文件 · 4 MiB/文件 | `vendor/.../review-checkpoints.js` |
| 默认端口 | 7676 | `VERSION-MANIFEST.json policy.defaultPort` |
| 默认 bind host | 127.0.0.1 | `policy.defaultBindHost` |
| Computer Use 指示色 | `#E2B73F`（7px，空闲 3s 隐藏 / 会话级 90s） | `VERSION-MANIFEST.json` |

### 9.2 环境变量速查

| 变量 | 作用 |
|------|------|
| `DEVSPACE_PORTABLE_ROOT` | Portable 根目录（broker / computer-use.js 用） |
| `DEVSPACE_PORTABLE_CONFIG_DIR` | 覆盖默认 `data/config/`（测试隔离） |
| `DEVSPACE_PORTABLE_STATE_DIR` | 覆盖默认 `data/state/`（测试隔离） |
| `DEVSPACE_PORTABLE_RUN_DIR` | 覆盖默认 `data/run/`（测试隔离） |
| `DEVSPACE_NATIVE_UI_PID` | 原生 UI 进程 PID（UI 租约归属识别） |
| `DEVSPACE_NATIVE_UI_QUEUE_WORKER` | `1` 表示原生 UI 内嵌 Computer Use worker |
| `DEVSPACE_COMPUTER_USE_LEASE_ID` | broker 持有的租约 ID |
| `DEVSPACE_STOP_EXCLUDE_PID` | `stopPortableOwnedProcesses` 排除的 PID 列表 |
| `DEVSPACE_HOST_PATH` | 子进程 PATH 隔离（Codex host PATH isolation） |
| `DEVSPACE_OAUTH_OWNER_TOKEN` | 非交互式启动时提供 owner token |
| `DEVSPACE_ALLOWED_ROOTS` | 非交互式启动时提供允许根 |
| `DEVSPACE_ALLOWED_HOSTS` | Host 头白名单（`*` 关闭） |
| `DEVSPACE_PERMISSION_PROFILE` | 权限档覆盖 |
| `DEVSPACE_DYNAMIC_PLUGIN_ALIASES` | `0` 关闭动态插件别名（默认关闭） |
| `DEVSPACE_PERMISSION_RULES_FILE` | 自定义权限规则文件路径 |
| `DEVSPACE_UI_LEASE_FILE` | 自定义 UI 租约文件路径 |
| `GH_TOKEN` / `GITHUB_TOKEN` | GitHub CLI 凭据 |

### 9.3 能力里程碑（节选）

完整列表见 `VERSION-MANIFEST.json capabilityMilestones`。

| 版本 | 关键能力 |
|------|---------|
| 1.0.7 | 结构化 doctor、稳定 processHandle、process_list/attach/kill、SQLite 进程注册表 |
| 1.0.8 | 持久工作区会话、MCP 重连进程重附着、服务重启 PID 识别 |
| 1.0.9 | 文件监听、有序事件 journal + 序列游标、脱敏 SQLite 审计、allow/deny/audit 规则 |
| 1.1.0 | 本地插件 manifest、SQLite 版本缓存、动态 MCP 工具注册、Schema bundle 生成 |
| 1.1.1 | `plugin_query`/`plugin_action` 热调度、`DevSpace-Plugin.cmd` 旧会话 CLI |
| 1.1.2 | Codex 风格运行时卡片、apply_patch 预览与逐文件差异、MCP image result blocks |
| 1.1.3 | 本地插件管理 UI、安全目录/manifest/ZIP 安装、16 固定槽位 + 版本哈希绑定 |
| 1.1.4 | Workspace App 折叠运行时日志、no-store UI assets（无需刷新工具定义） |
| 1.1.5 | `show_changes` 作为唯一 render 工具、ChatGPT invoking/invoked 状态元数据 |
| 1.1.6 | 插件依赖契约、codex-runtime-bridge、shell 环境快照、隐藏 Git 检查点、keep-awake |
| 1.1.7 | UI 租约门禁 Computer Use、DXGI 截图、显式 Memories、生命周期 Hooks、Git 工作树回退 |
| 1.1.8 | 常驻 Computer Use broker（40ms/25ms 轮询）、WGC 主截图后端、原生 SendInput helper |
| 1.1.9 | 单原生 WinForms 控制中心、严格 Portable 进程树停止、pre-rollback safety snapshots |
| 1.1.10 | 现代 WinForms 视觉清理、独立 Computer Use 开关、共享日志读取 |
| 1.1.11 | `sparse-journal-v4` 有界审阅、legacy v3 GC、幂等计划任务、原生 UI Computer Use worker |
| 1.1.12 | 多显示器金色指示器、`WDA_EXCLUDEFROMCAPTURE`、进程内 SendInput、批量动作（50 步） |
| 1.1.13 | 指示器会话级 90s 保持、`computer_action` 默认不返回截图 |
| 1.1.14 | 原生 UI 非阻塞动作状态、会话审阅列表+详情子页面、显式 Memory 管理页面 |

### 9.4 参考文档

- [README.md](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/README.md) — 项目总览与下载
- [README-PORTABLE.md](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/README-PORTABLE.md) — 便携版特性历史
- [docs/DEVELOPMENT.md](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/docs/DEVELOPMENT.md) — 开发指南
- [docs/RELEASING.md](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/docs/RELEASING.md) — 发行流程
- [docs/UPDATE-DESIGN.md](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/docs/UPDATE-DESIGN.md) — 1.1.15+ 应用内更新设计
- [CHANGELOG.md](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/CHANGELOG.md) — 版本索引
- [VERSION-MANIFEST.json](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/VERSION-MANIFEST.json) — 版本/运行时/能力/SHA-256 清单
- [SECURITY.md](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/SECURITY.md) — 安全边界与漏洞报告
- [THIRD-PARTY-NOTICES.md](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/THIRD-PARTY-NOTICES.md) — 第三方组件许可
- [CONTRIBUTING.md](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/CONTRIBUTING.md) — 参与维护规则
- [vendor/waishnav-devspace/UPSTREAM.md](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/vendor/waishnav-devspace/UPSTREAM.md) — 上游来源与 fork 维护说明
- [vendor/waishnav-devspace/README.md](file:///i:/devspaceGPT/DevSpace-Deploy-Portable/vendor/waishnav-devspace/README.md) — 上游 DevSpace 说明
