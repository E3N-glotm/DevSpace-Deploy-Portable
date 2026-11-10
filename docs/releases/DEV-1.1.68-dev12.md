# DevSpace Portable 1.1.68 dev12 — 修复 SSH 反向隧道默认启动失败

## 生产故障

- 2026-11-10 14:24，本机正式 dev11 为 H200 启动 SSH 反向隧道时出现 SSH_REVERSE_FORWARD_UNAVAILABLE。
- Windows 双网卡 192.168.219.14、192.168.221.238 的 TCP/7677 正常监听。H200 反向隧道配置远端端口为 19389，监督进程尝试 2 次后停止；当前配置为 disabled。
- 使用 D 盘正式 SSH 管理代码、现有 SSH 凭据和同一端口 19389 执行临时 ssh -R，WebSocket 101 和远端 loopback-only 验证均成功，测试结束后立即关闭临时隧道。
- 根因在 setup/ssh-reverse-tunnel.cjs：supervise 的 launch 默认参数闭包引用了函数体内声明的 spec，JavaScript 参数默认表达式有独立作用域，因而真正的启动调用抛出 ReferenceError: spec is not defined。此前测试注入了 launch 函数而绕过该错误。

## 修复与测试

- 将默认 SSH launcher 定义移入 spec 初始化之后，保持原有 SSH -R、DPAPI 凭据、known_hosts、Agent Token 与 WebSocket 验证机制不变。
- 新增覆盖真实默认启动代码路径的回归：不传自定义 launch，而只注入受控 SSH 工厂，验证实际 spec 传参、状态更新和安全停止。
- 在 supervise 的 finally 中移除 SIGTERM/SIGINT 监听，防止测试中重复创建监听器。
- 独立验证 H200 ssh -R 可行不等于已将 Agent 安装到生产服务器。D 盘已运行 dev11，代码修复只在 E 盘原有源码中完成，正式升级必须由用户授权。
