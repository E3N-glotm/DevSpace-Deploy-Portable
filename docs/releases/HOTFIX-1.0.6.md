# DevSpace Portable 1.0.6

本版本在 1.0.5 基础上增加用户可控的主机访问权限，并修复 Windows 交互进程支持。

## 权限档位

- `workspace`：保持工作区路径边界和保守命令说明；
- `full-access`：当前 Windows 用户可访问的路径和可执行的命令均可由 MCP 调用，包括
  SSH/SCP/SFTP、网络访问、Windows 凭据接口、Shell 文件修改、安装器、交互式及持续进程；
- `custom`：逐项控制外部路径、任意命令、Shell 修改、网络/SSH、凭据接口、PTY 和持续会话。

完整访问不会授予管理员、SYSTEM 或绕过 UAC/ACL。OAuth Owner Password 仍是必需的。

## Windows PTY 修复

旧版在 Windows 上即使 `exec_command(tty=true)` 也会退化为普通管道，导致 SSH 密码提示、
交互式 CLI 和需要控制台的命令容易中断。1.0.6 使用包内 `node-pty`/ConPTY 启动真实终端，
并继续通过 `write_stdin` 输入、轮询和调整终端尺寸。

## 配置与兼容性

- 权限配置写入 `config.json` 和 `deployment.json`，重启后生效；
- 旧 1.0.5 配置没有权限字段时自动回退到 `workspace`；
- 工具模式 `minimal/full/codex` 与权限档位相互独立；
- 更换权限档位不会删除 Owner Password、隧道 Token 或 OAuth SQLite 状态。
