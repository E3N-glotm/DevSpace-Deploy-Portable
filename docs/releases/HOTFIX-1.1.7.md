# DevSpace Portable 1.1.7

## 目标

本版补齐四组本地运行能力，同时保持用户数据与现有 Portable 部署可迁移：

1. UI 底部版本与协议显示；
2. 受本地 UI 租约保护的 Windows Computer Use；
3. 用户可见、可删除、可禁用的显式 Memories；
4. 确定性 Hooks，以及 Codex 风格的 UI 会话总修改统计与确认式回退。

## Computer Use

- 默认关闭；
- 需要 `computerUse` 功能开关；
- 需要 `full-access`，或自定义权限中的 `allowComputerUse`；
- 需要本地 HTA 每 1.5 秒维持一次 UI 心跳；
- 租约约 20 秒过期，关闭 UI 后立即撤销；
- MCP 服务只写入带租约的短期 Broker 请求；真正的截图、鼠标和键盘动作由桌面中打开的 HTA 心跳进程执行；
- 请求与响应位于 `data/run/computer-use`，完成、失败或超时后清理；
- 截图使用随包编译的 Windows x64 DXGI 1.2 Desktop Duplication Helper，通过 D3D11 读取帧并由 WIC 编码 PNG；
- 目标机不需要安装编译器、Python、.NET SDK 或额外 Visual C++ 运行库；Helper 使用静态 CRT；
- 锁屏、UAC 安全桌面和非交互 Window Station 失败关闭；
- 键盘只接受固定按键白名单，文本输入和审计只保存长度，不把文本正文写入事件日志。

## UI 心跳控制台闪烁修复

- 根因是 HTA 每 1.5 秒通过 `WScript.Shell.Exec` 启动一次 Node 管理进程；`Exec` 不支持隐藏窗口参数；
- 改为 `WScript.Shell.Run(command, 0, true)`，窗口样式固定为隐藏并同步等待；
- 请求、响应和错误通过系统临时目录中的短期 UTF-16 文件传递；
- 管理器支持 `--input-file`、`--output-file`、`--error-file` 和 `--file-encoding`；
- 调用完成后 HTA 删除三类临时文件；自动测试确认源码不再包含 `shell.Exec`。

## Memories

- `memory_list`、`memory_upsert`、`memory_delete`；
- `global` 或 `workspace` 作用域；
- 保存在 `devspace.sqlite` 的 `devspace_memories` 表；
- 打开/恢复工作区时返回相关显式记忆摘要；
- 默认拒绝疑似密码、Bearer Token、API Key、Private Key 和 Client Secret；
- 不自动读取或保存聊天、命令输出、浏览历史、文件内容或凭据。

## Hooks

- `hook_list`、`hook_upsert`、`hook_delete`、`hook_run`；
- 支持 `workspace_open`、命令前后、修改前后、审阅前后和回退前后；
- 配置只接受 `executable + argv`；
- 依赖任意命令权限；
- 可选择 `blocking`，阻止失败阶段继续执行；
- 命令、输出和错误统一脱敏并写入结构化事件审计。

## UI 会话审阅和回退

- HTA 打开时创建短期 UI 租约；
- 每个已打开工作区按当前租约建立独立基线；
- `show_changes` 保留“自上次展示以来”的增量，并附加“UI 打开以来”的总量；
- `session_changes` 可单独查询会话总量；
- Workspace App 显示文件数、增删行数、逐文件统计、限制说明和精确确认令牌；
- `session_rollback` 必须提交 `ROLLBACK <checkpointId>`；
- Git 回退恢复工作树且保留暂存区；
- 非 Git 回退使用结构化工具写前快照；
- 非 Git 会话执行 Shell/Hook 后默认阻止完整回退，只有显式 `forcePartial=true` 才恢复已知路径并保留风险标记。

## 验证

- Node ESM 导入与语法检查；
- Git 和非 Git 会话统计/回退自动测试；
- Git 暂存区保留测试；
- Memories 凭据检测；
- Hooks argv 执行与审计；
- UI 租约生效/过期；
- Computer Use Broker 请求、响应与清理；
- Explorer Shell 启动的真实 HTA 会话连续 5 次成功捕获 1920×1080 PNG，均无 stderr；
- `setup/test-portable-ui-heartbeat.mjs` 验证隐藏窗口样式和文件 RPC；
- `setup/test-computer-use-live.mjs` 验证 DXGI Helper、PNG 签名、分辨率和连续截图；
- Workspace App 资源和版本显示检查；
- 生产依赖审计、文件清单和发行 ZIP 哈希检查。

## 升级注意

只覆盖程序文件并保留整个 `data` 目录。不要删除：

- `data/config/auth.json`；
- `data/config/deployment.json`；
- `data/state/devspace.sqlite`；
- `data/plugins`；
- ngrok/Cloudflare Token。

本版新增固定顶层工具。旧 ChatGPT App 需要重新读取一次工具定义；本地功能开关之后不会继续改变这些 Schema。
