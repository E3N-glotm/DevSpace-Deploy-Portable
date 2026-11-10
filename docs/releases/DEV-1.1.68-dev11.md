# DevSpace Portable 1.1.68 dev11 — SSH 反向隧道连接模式

## 界面

新增第三种 Agent 连接方式 **SSH 反向隧道**，和已有“公网连接”“局域网直连”并列。界面标签严格使用“SSH 反向隧道”，不附加 H200 等设备名称。提供独立的“检测并推荐连接方式”按钮。

## 核心设计

- Windows 控制端复用原有 DPAPI 加密 SSH 凭据及已信任的 SSH 主机密钥，使用受管 SSH -N -T -R 会话，在 Linux 远端的 127.0.0.1 绑定独立的非特权端口，把流量转发到 Windows 已启用的 Agent-only 网关；保留 Agent Token 认证。
- 新增 ssh-reverse Agent 连接模式，URL 只允许 HTTP 127.0.0.1:端口，安装器及 Linux Agent 认识该模式。不会通过该端口开放 MCP 或 OAuth API。
- 自动选择一个未被占用的远端回环端口，SSH 强制 ExitOnForwardFailure 和活跃性 keepalive；在使用之前，远端通过 SSH 检测 WebSocket 握手 HTTP 101 和实际 Linux 监听端口仅限回环。
- 独立的 Portable-owned supervisor 持续监视 SSH 子进程，异常中断时进行有限退避重连；运行状态文件不包含凭据。MCP 启动时恢复已启用的配置，完整停止 Portable 时停止其 own supervisor；单独重启本地 MCP 不会擅自杀掉其他服务器训练。
- 连接切换使用原有的 Agent 身份确认、配置备份、心跳验收与失败回滚。公网/局域网现有服务器保持原状。

## 测试范围与限制

- 新增 E 盘隔离测试，覆盖严格回环 URL、SSH 转发参数、持久配置、自动重试、停止行为与现有 Agent 协议。
- 是否允许 SSH 远程 TCP 转发取决于目标 sshd 配置；SSH 可登录不代表 SSH -R 一定可用。不允许转发或远端端口异常占用时，应明确报错且不创建半完成 Agent。
- 修改仅在 E 盘现有 DevSpaceDeploy 源码；未覆盖 D 盘当前安装，不对 H200、5090 网络、训练及其他项目进行破坏性操作。
