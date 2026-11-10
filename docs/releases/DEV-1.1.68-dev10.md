# DevSpace Portable 1.1.68 dev10 — H200 SSH 错误分类与 Agent 回连预检

## 故障实测（2026-11-10）

- 生产控制端已安装 1.1.68 dev9，Agent LAN 网关同时监听 192.168.219.14:7677 和 192.168.221.238:7677，本机 TCP 连接正常。
- H200 SSH 配置为 100.200.199.25:32891，用户 ht_qh_1。DevSpace 自带 SSH 登录测试成功，已信任的主机指纹与当前服务器匹配。
- 远程 Linux 的主目录 /home/ht_qh_1 可写，而通用模板路径 /home/ubuntu/workspace 不存在。
- H200 经已认证 SSH 的只读检查：反向连接 Windows 两个网卡的 7677 均失败。H200 到 Windows 私网 IP 的路由指向 169.254.1.1；H200 直接访问当前公网 MCP 地址亦失败。
- 因此，重要阻断是跨网络 Agent 反向连接不可达，另有潜在的错误安装目录；不是 SSH 密码错误或 Windows 双网卡监听失效。

## 软件修复

1. 新增脱敏 SSH 错误分类 INSTALL_ROOT_INVALID、INSTALL_FAILED、SSH_KEY_INVALID，补充远程 Linux 无法连接 Agent 服务入口的中文错误匹配为 CONTROLLER_UNREACHABLE。
2. Electron 为各类别显示明确操作建议，继续隐藏原始 SSH stderr、凭据与远端不可信文本。
3. 新增 LAN Agent 在分配 enrollment token、执行安装或停止既有进程前，必须经 SSH 从远端验证控制端 WebSocket 101 回连。不通则安全失败；已有 Agent 的身份和回滚保护保持不变。
4. 定点测试覆盖错误归类与回连预检失败时不创建 enrollment、不停止 Agent、不执行安装程序。

## 部署与限制

- 当前未修改 D 盘正式服务、Windows 网络路由或防火墙，未执行 H200 Agent 安装和 SSH 反向转发，不会停止 GPU/Qwen 训练。
- 改进诊断不能代替实际网络连通性：H200 需要另行授权配置持久的 SSH 反向隧道，或采用经过验证的双向可达 Agent 服务地址。
- 当前所有改动只在 E 盘原有 DevSpaceDeploy 源码中。发布后从 dev9 升级需受控重启本地服务才能生效。
