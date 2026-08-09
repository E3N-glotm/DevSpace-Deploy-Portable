# DevSpace Portable 1.1.21

1.1.21 修复一个与 1.1.20 的 PID 安全问题不同的网络共存问题：当 DevSpace 公网 tunnel 持续运行时，EasyConnect/Sangfor VPN 可能在登录后收到被动注销，v2rayN 等本地代理也可能无法正常维持。关闭 DevSpace 服务后网络软件恢复正常，说明需要隔离的是 tunnel 的出站生命周期，而不是继续扩大进程终止保护。

## 实机证据

在不停止、不修改当前正式部署的前提下，只读检查得到：

- DevSpace MCP、本地 ngrok Agent、Sangfor 本地服务和 v2rayN 本地监听之间没有直接 TCP 端口重叠；
- Sangfor 客户端能够先成功登录并分配虚拟 IP，随后 NetworkMonitor 观察到网络变化；
- 约十秒后服务端返回被动注销信息，客户端进入 `STATUS_ASK_FOR_LOGOUT`，UI 显示“VPN 已注销/会话已过期”；
- ngrok 同期也发生控制会话被本机网络软件中断并自动重连；
- 旧的 `start-tunnel.sh` 会在启动 ngrok 前无条件清除 `HTTP_PROXY / HTTPS_PROXY / ALL_PROXY`，因此即使 v2rayN 已提供本地系统代理，DevSpace tunnel 仍倾向独立直连公网。

这组时间线说明需要把 tunnel 与 VPN/代理的网络切换显式协调，而不是把问题继续解释为进程 PID 误杀。

## 新的 VPN/代理兼容模式

默认启用 `tunnelNetworkCompatibility`：

1. tunnel 由一个轻量 supervisor 管理；MCP 本地服务仍独立运行；
2. 检测到 EasyConnect/Sangfor 客户端存在、但 Sangfor VNIC 尚未连通时，ngrok 暂停启动；
3. VPN VNIC 进入已连接状态后等待短暂稳定期，再启动公网 tunnel；
4. 如果当前 Windows 已启用并且本地端口确实在监听的 HTTP/SOCKS 代理，则 tunnel 跟随该代理出站；
5. 代理/VPN 状态变化时只停止和重建当前 Portable 自己的 tunnel 子进程，不停止 MCP，不触碰第三方程序；
6. 用户显式填写 `ngrok 出站代理` 时，该配置优先；如果显式代理不可用，tunnel 会暂停而不是悄悄改成直连；
7. 用户可以关闭兼容模式，恢复固定的手工 tunnel 网络行为。

## 明确不会做的事情

兼容模式不会：

- 修改 Windows WinINET `ProxyEnable/ProxyServer`；
- 修改 WinHTTP proxy；
- 添加、删除或重排系统路由；
- 启用/禁用 Sangfor、Wintun、sing-box 等网卡；
- 启动、停止、重启 EasyConnect、ECAgent、v2rayN、sing-box；
- 递归结束任何第三方进程树。

## 可观测性

状态/诊断输出新增：

```text
Network compatibility
Network mode
VPN state
Network reason
Proxy source
Tunnel supervisor PID
```

当 EasyConnect 正在登录时，可能看到 `Network mode: paused` 与 `VPN state: negotiating`；这是主动让出网络切换窗口，不代表 MCP 本地服务崩溃。

## 回归测试

新增 `setup/test-tunnel-network-coexistence.mjs`，覆盖：

- 健康本地系统代理自动选择；
- Sangfor VPN 协商期暂停；
- VPN 稳定后恢复；
- 兼容模式测试前后 WinINET 代理注册表文本完全一致。

原有的 UI stale PID、Computer Use Broker、严格停止、在线更新和完整回归继续执行。

## 兼容性

- 1.1.20 → 1.1.21 继续使用精确 `file-delta-v1` 增量优先、完整 ZIP 自动兜底；
- `data/`、`logs/`、`reports/` 继续作为持久化目录；
- Portable Protocol 仍为 `1.5`；
- MCP 顶层工具 Schema 不变；
- 不要求重新 OAuth 或重新 Scan Tools。
