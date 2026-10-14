# DevSpace Portable 1.1.64 dev4

## 每台 Remote Agent 可选公网或局域网连接

- Windows 主机可明确开启独立的 Agent-only LAN 网关，默认关闭；
  默认端口 7677，绑定 0.0.0.0 或指定本机内网 IPv4。保存后需重启本地 MCP。
- 网关仅提供 Agent WebSocket 及两个 Agent 安装资源，
  不向局域网开放 MCP、OAuth 和其他管理接口。
- 每个服务器在创建时选择公网 HTTPS 或内网 HTTP 地址；已有 Agent 在
  SSH 配置齐备时可修改、测试新入口并定向重连，失败时回滚旧配置。
- 无论是复制安装命令还是“通过 SSH 安装 Agent”，都会按当前服务器的
  公网/局域网选择生成并传递对应 URL，避免 SSH 安装时意外退回公网默认地址。
- LAN 入口使用 Windows 内网 IP，Linux 服务器无需能够访问公网；
  须确认服务器可访问 Windows 的对应端口，并由用户按网络要求开放防火墙。
- 内网 HTTP/WS 为明文，Agent 认证凭据随 WS 握手后的 hello 发送；
  只能在明确可信的隔离网络使用，推荐绑定指定私有 IP，并限制防火墙来源。
  不应在公网上开放此端口；公网模式继续使用 HTTPS/WSS。
- Internet 和 LAN 的连接地址独立记录，互不强制转换或影响其他 Agent。
- 当前 LAN 模式采用 **未加密的 HTTP/WebSocket** 和 Agent 身份凭据；
  仅在受信任的内网或隔离 VPN 中启用，不建议映射到公网。建议只绑定
  Windows 实际用于 Agent 访问的网卡并通过防火墙限制来源服务器地址。
- 由于公网 URL 与局域网网关监听端口不同，必须先保存 LAN 网关设置，
  再通过“服务与桌面控制”重启本地 MCP，使新监听器生效。

## SSH 一键恢复离线 Agent

- 修复旧版遇到 Agent 进程仍在运行、但 WebSocket 已断开时，
  被误判为 already-running 恢复成功的问题。
- SSH 在重启前从远程 Linux 对实际 Agent WebSocket 入口发起升级握手。
  不可达则报告原因且不停止进程；可达时仅停止并重启身份与配置路径
  完全匹配的 Agent，等待本次操作之后的新连接、新心跳，并连续两次
  确认健康后才报告成功。管理 CLI 独立读取 SQLite，健康 Agent 可能呈现
  `online-recent`；不能仅依赖该状态或单次最近心跳判定恢复成功。
- 自动恢复复用该保护，不会重启其他 Python/Agent 或服务器训练任务。
- 新连接入口不通时会明确报错，**不停止**原 Agent。此时应先修正
  网络入口或切换 LAN 再恢复；反复重启无法修复不通的网络。
- 新旧 SSH 凭据键兼容：使用原本按名称保存的 DPAPI 凭据，
  不会为了改成 Agent ID 意外创建缺少密码的新配置。

## Linux Agent 1.1.48

- 在 1.1.47 的 HTTP 101/首帧合并修复、静默连接超时与禁止降级基础上，
  增加连接方式配置和局域网自更新的正确下载来源。
- Agent 在 hello 中提供当前 connectionMode 元数据，方便控制中心显示。

## 保留的 dev1–dev2 修复

- 自动续轮关闭后不再创建新的可渲染锚点；
  Computer Use 恢复有效租约内的金色透明边框。
- 本版本仅在 E 盘原源码迭代构建，不修改 D 盘 live 或生产服务器的 Agent 配置。
