# DevSpace Mobile 1.1.43 Android Standalone MCP

DevSpace Mobile 是与 Windows Portable **相互独立**的 Android 产品线。APK 自己就是 MCP/OAuth 控制平面，直接在手机本机调用 Root 文件系统、Root shell、截图、输入、应用管理和长进程能力；它不是 Desktop DevSpace 的 Remote Agent，也不需要 Windows DevSpace 在线。

## 架构

```text
ChatGPT / MCP Client
        |
        | HTTPS + OAuth
        v
https://<新的 Android 独立域名>/mcp
        |
        | ngrok Agent 或 Cloudflare Named Tunnel（二选一）
        v
Android phone 127.0.0.1:7676
        |
        +-- Standalone MCP / OAuth server in APK
        +-- RootShell (user-approved su -c)
        +-- RootFs / structured file tools
        +-- AndroidControl (screen / input / app)
        +-- ProcessRegistry
```

桌面版域名、桌面 OAuth SQLite、Remote Agent enrollment、`agentSecret` 和 `/agent/v1/connect` 均不参与这条链路。Android 有自己的域名、Owner Password、OAuth client_id、Tunnel 凭据和 Root 权限策略。

## Root 模型

APK **不会利用漏洞给未 Root 的手机提权**。设备必须已经由 Magisk、KernelSU、APatch 或兼容的 `su` 管理器提供 Root。用户在 Root 管理器中明确授权 DevSpace Mobile 后，应用才会执行 `su -c`。

当前 Root 后端包括：

- `screencap` 截图，默认低延迟 JPEG；
- `input` tap / swipe / text / key / back / home，最多 50 步批处理；
- `pm` / `am` 应用 list / info / start / stop / clear / install / uninstall；
- Root 文件读取、目录枚举、写入、编辑、删除、重命名、mkdir、grep、glob；
- Full Root Access 下的任意 Root shell；
- 可轮询的非 PTY Root 长进程。

## MCP / OAuth

APK 只监听：

```text
http://127.0.0.1:7676/mcp
```

不会在 Wi-Fi/蜂窝网卡上直接开放 `0.0.0.0:7676`。公网访问必须从手机主动建立 Tunnel。

HTTP/OAuth 入口：

```text
/.well-known/oauth-protected-resource/mcp
/.well-known/oauth-authorization-server
/register
/authorize
/token
/mcp
/health
```

授权实现包含：

- OAuth public client 默认 `token_endpoint_auth_method=none`，并保留 `client_secret_post` 兼容；
- PKCE S256；
- RFC 8707 `resource` 绑定到当前 `https://<android-domain>/mcp`；
- RFC 9207 `iss` authorization response；
- 1 小时 access token；
- 30 天、一次使用后轮换的 refresh token；
- OAuth client / refresh-token hash state / Owner Password / HMAC signing key 均由 Android Keystore AES-GCM 加密保存。

MCP 同时支持：

- `2026-07-28`：`server/discover`、无会话 per-request `_meta`、标准 HTTP headers、`resultType`、cache hints 和 serverInfo `_meta`；
- `2025-11-25` / `2025-06-18` / `2025-03-26`：无服务端 session 的兼容 `initialize -> tools/list -> tools/call` 路径。

## 工具面

Android 专用：

```text
android_device_status
android_snapshot
android_action
android_app
android_shell
```

Workspace / 文件 / 搜索：

```text
open_workspace
stat
read
ls
write
edit
remove
rename
mkdir
grep
glob
exec_command
```

进程：

```text
process_start
write_stdin
process_list
process_attach
process_kill
```

`android_shell`、`exec_command` 和 Root 长进程要求 **Full Root Access**。Scoped 模式仍可截图、输入和管理应用，并允许结构化文件读取；写入只能落到 UI 中配置的 writable roots，同时执行 lexical + canonical realpath 检查阻止 symlink 逃逸。

## 内置 ngrok Agent SDK

上一版把官方 **Linux** ARM64 ngrok CLI 直接塞进 APK。ngrok 官方支持平台列表没有 Android，实际 Root Android 上会出现 runtime/连接失败。因此当前版已经取消 Linux CLI，改为把官方开源 Go Agent SDK `golang.ngrok.com/ngrok/v2 v2.1.4` 直接编译成 `GOOS=android / GOARCH=arm64` 的 Android-native forwarding runtime。ngrok 官方也明确建议：当 Agent executable 不能运行在目标平台时使用 Agent SDK。

手机不需要另外安装 Termux 或 ngrok。免费 ngrok 账户可使用 development domain，例如：

```text
https://xxxx.ngrok-free.app
```

把这个地址直接填到 **Public Base URL**，不要带 `/mcp`。Authtoken 使用 Android Keystore 加密保存。启动时 APK 只执行自己的 Android-native bridge，Authtoken 通过 **stdin JSON** 传给 SDK runtime，不出现在 argv、环境变量或 shell command 中。

如果不想手工创建 Authtoken，可以在新 WebView 控制台中粘贴一次 **ngrok API Key**，点击“生成独立 Authtoken”。APK 会调用 ngrok 官方 `POST /credentials` API，生成一条独立 tunnel credential，并立即把只返回一次的 token 加密存进 Android Keystore。若 Public Base URL 已填写，生成的 credential 还会添加 `bind:<domain>` ACL。API Key 本身同样由 Android Keystore 保存。

还可以点击“读取我的 ngrok 域名”，APK 使用官方 `GET /reserved_domains` API 获取账户域名列表，并直接回填 Public Base URL。第一个 API Key 仍必须由用户在 ngrok Dashboard 创建；它属于账户认证凭据，离线 APK 无法凭空生成一个有效的 ngrok 账户凭据。

当前内置 runtime：

```text
ngrok Agent SDK: 2.1.4
runtime: devspace-ngrok-sdk-2.1.4
target: GOOS=android / GOARCH=arm64 / CGO_ENABLED=0
embedded binary SHA-256: 6e7495dbf4f2031bd6d36f5935bf9a97aefa15d6b1c48805b0064b46a0d787bd
license: MIT
```

ngrok 官方当前 Free Plan 包含 1 个自动分配的 development domain、最多 3 个在线 endpoint，并允许 development domain 持续在线；自定义 ngrok 品牌域名或自有域名取决于付费计划。对 MCP/API 请求，免费层的浏览器 interstitial 不影响程序化 API 调用。

### ngrok SDK 许可

当前 APK 不再重新分发专有 Linux Agent CLI。`ngrok-go v2.1.4` 是 MIT License，APK 内附 `assets/ngrok-go-LICENSE.txt` 与 `assets/ngrok-NOTICE.txt`。ngrok 云服务本身仍按用户自己的 ngrok 账户与服务条款使用。

## Android WebView 控制台

原先 Activity 使用原生 `ScrollView + EditText`，状态每秒刷新会触发 Android 的焦点/布局滚动修正，在部分 ROM 上表现为“向下滑后自动回弹”。当前 UI 已改成**本地离线 WebView Dashboard**：HTML/CSS/JS 全部封装在 APK assets 中，不加载远程页面，不使用 Electron。Android 本身不支持 Electron 桌面运行时；WebView 能获得接近 Electron 的界面能力，同时不额外打包一整套 Chromium/Node。

新界面增加并真正接入后端的开关包括：Full Root Access、屏幕/输入控制、应用管理、结构化文件写入、开机自启、WakeLock、Tunnel 自动重连、Tunnel 详细日志、ngrok、Cloudflare。页面状态轮询只更新状态 DOM，不会重写正在编辑的输入框，因此不会再因为刷新把滚动位置顶回去。

## 内置 Cloudflare Tunnel（可选）

Android 必须使用一个**独立于 Windows Desktop 的新域名/hostname**，Public Base URL 示例：

```text
https://phone.example.com
```

不要带 `/mcp`。

APK 内置 Termux 针对 Android/Bionic 构建的 `cloudflared 2026.8.2`，当前正式内置 ABI 为 `arm64-v8a`。运行时：

1. 用户在自己的 Cloudflare 账户中创建一个 remotely-managed Named Tunnel；
2. 给该 Tunnel 添加新的 Android 专用 Public Hostname；
3. Service URL 指向 `http://127.0.0.1:7676`；
4. 将该 Tunnel 的 **Tunnel Token** 粘贴到 APK；
5. 打开“启动 MCP 时同时启动 Cloudflare Tunnel”。

Tunnel Token 使用 Android Keystore 加密保存。启动时它通过 stdin 写入 `/data/local/tmp/devspace-mobile/tunnel.token`，权限为 `0600`；`cloudflared` 使用 `--token-file`，因此 Token 不出现在进程命令行。APK 会先校验 assets 中的固定 SHA-256，每次启动 Tunnel 时再用已校验副本原子覆盖 Root 运行文件并执行 `--version` 自检。传输协议使用 Cloudflare `auto` 策略，优先 QUIC，在 UDP 不可用时自动回退 HTTP/2；服务停止后 token file 与 pid file 会被删除。

ngrok 和 Cloudflare Tunnel 是**二选一**的公网入口，UI 会在启用一个时自动关闭另一个，服务端也会再次校验，避免同一个 MCP/OAuth 实例同时暴露到两个不同的 Public Base URL。

内置 runtime 固定信息：

```text
cloudflared version: 2026.8.2
Termux package: cloudflared_2026.8.2_aarch64.deb
Termux .deb SHA-256: 7ecda51a05326f34a832be6e763eb7c6f71edf4ad49f096b291fa6f8ec5a5377
embedded ELF SHA-256: adcbc5cb319af844a4ce932f4ed656ee8656b1c478faf5001aff4b6166a950ef
license: Apache-2.0
```

## 首次配置

1. 安装 APK，打开应用；
2. 填入新的 Android Public Base URL；
3. 设置独立 Owner Password；
4. 选择 Scoped 或 Full Root Access；
5. 点击“请求 / 检测 Root”，在 Magisk/KernelSU/APatch 中授权；
6. 公网方式二选一：
   - ngrok：可直接粘贴 Authtoken；也可以粘贴 API Key 后点“生成独立 Authtoken”，并用“读取我的 ngrok 域名”回填域名；
   - Cloudflare：粘贴 Tunnel Token，启用 Cloudflare Tunnel；
7. 保存并启动 Standalone MCP Server；
8. 确认状态为 MCP/Tunnel 已启动；
9. 在 ChatGPT 中用 `https://<android-domain>/mcp` 创建新的 OAuth MCP 连接；
10. 浏览器进入手机提供的授权页时输入 Android 版 Owner Password。

## 构建与回归

要求：JDK 17、Android SDK Platform 36、Build Tools 36.0.0。工程固定 Android Gradle Plugin 8.10.1、Gradle Wrapper 8.11.1。

```bat
python tools\vendor-cloudflared.py
python tools\build-ngrok-android.py
gradlew.bat --no-daemon clean assembleDebug lintDebug
node ..\..\setup\test-android-standalone-contract.mjs
```

APK：

```text
app\build\outputs\apk\debug\app-debug.apk
```

`vendor-cloudflared.py` 固定验证 Termux `.deb` 的 SHA-256，并只把 cloudflared ELF 抽取到 APK assets；本地下载的 `.deb` 被 `.gitignore` 排除。

`build-ngrok-android.py` 从固定的 Go module lock (`go.mod` + `go.sum`) 构建 Android-native ngrok SDK bridge；输出位于 `assets/ngrok-android-arm64`。构建使用 `GOOS=android`、`GOARCH=arm64`、`CGO_ENABLED=0`，APK contract test 再验证固定 SHA-256，避免构建时静默替换 runtime。

## 当前边界

- 内置 ngrok/cloudflared runtime 当前只正式支持 `arm64-v8a`；其他 ABI 会明确拒绝启动 Tunnel，而不会静默执行错误二进制。
- PTY、file watch、Git worktree、Desktop plugin manager、review/rollback、Subagents 尚未移植；这些不是 Android standalone 启动与手机 Root 控制的依赖。
- Debug APK 可直接做设备联调；正式长期发布还需要用户自己的持久 Android signing keystore，不能把发布私钥写进 Git。
- ngrok 路径不要求另购域名，但仍需要一个合法 ngrok 账户凭据。APK 可以用用户提供的 API Key 自动创建 Authtoken，不能离线伪造 ngrok 账户 Token；Cloudflare Named Tunnel Token 同理属于 Cloudflare 账户侧凭据。
