# DevSpace Portable 1.1.9

## 重做背景

此前构建的 1.1.9 存在会话回退异常、Computer Use 无法正常使用、日志等 UI 按钮失效、停止后残留进程、界面有时无法完整加载，以及浏览器 Control Center 与 1.1.8 HTA 两套界面割裂等问题。该故障包保留为 `DevSpacePortable-Windows-x64-1.1.9-broken.zip`，不得用于部署。

本次没有在故障版上继续叠补丁，而是先从 `DevSpacePortable-Windows-x64-1.1.8.zip` 全量恢复源码树，并依据 1.1.8 的 `SHA256SUMS.txt` 验证 47,343 个文件全部匹配、缺失和哈希不一致均为 0，然后以该已验收基线重新实现 1.1.9。

## 单一原生控制中心

- 新增 Windows x64 WinForms `DevSpace-Portable.exe`；
- 根目录 `DevSpace-Portable.cmd` 只启动该 EXE；
- 不打开 Edge，不提供浏览器管理页，不依赖本地 HTTP UI；
- 旧 1.1.8 HTA 源码归档到 `setup\legacy`，兼容路径只转到原生 EXE；
- 一个窗口内提供“状态与部署”“配置与权限”“插件管理”“会话与回退”“日志与诊断”五个页面；
- 合并 1.1.8 的隧道、权限、部署、插件、日志、诊断和计划任务操作，结构自检共识别 35 个按钮。
- 所有异步管理操作在禁用重复点击前先显示“正在执行，请稍候”，长时间文件校验或诊断不会再表现为无反馈按钮。

## 完整会话回退

- 会话基线持久化，不依赖 UI、HTA 租约或 MCP 连接生命周期；
- Git 和非 Git 工作区统一使用项目目录外的 shadow Git 对象库保存完整工作树；
- 能识别和恢复修改、新建、删除、被 `.gitignore` 忽略的文件、文本和二进制文件；
- Shell、Hook 和任意工具造成的变化不再使非 Git 回退直接失效；
- Git 项目的实际 HEAD、分支和 index 不被修改；
- 每次回退前自动创建安全快照，原生界面可恢复回退前状态。

独立回归同时覆盖非 Git 与 Git 项目。Git 测试中回退前后实际 index tree 哈希一致，忽略文件和二进制文件均被正确恢复或移除。

## 严格停止与安装隔离

- 停止动作核验计划任务 XML 中的实际程序路径，只操作属于当前 Portable 根目录的任务；
- 按可执行路径、命令行和父子进程树枚举当前 Portable 的后台进程；
- 结束 MCP、隧道、Broker、GUI 及其子进程后再次检查，存在残留即返回失败；
- `停止全部并退出` 成功后不弹出阻塞消息框，GUI 立即退出；
- E 盘测试版执行停止时不会结束或禁用 D 盘正式部署。
- 文件完整性校验由 47,000 余文件的逐文件流式串行哈希改为最多 16 路有限并发；不超过 8 MiB 的小文件直接异步读取，仅大文件保留流式哈希。47,351 文件的回归由约 267 秒降到约 9.4 秒，同时仍正确报告预期的单文件哈希不一致，并保留路径越界、缺失和读取异常检查。

最终联合验收中，原生 GUI 和 Computer Use Broker 被关闭后，E 盘 Portable 根目录下可执行进程数为 0；D 盘 1.1.8 MCP 仍正常响应。

## Computer Use

- 原生程序打开、续租并关闭常驻 Broker；
- Broker 冷启动等待窗口由 3 秒提高到 10 秒，避免整套回归或杀毒扫描负载下偶发返回 `starting`；
- 保留 WGC 主路径、DXGI/GDI 降级和原生 `SendInput` Helper；
- 最终 2560×1440 实机连续 5/5 截图成功，WGC 无降级，平均端到端约 306 ms；
- 原生输入 `broker_probe` 成功；非法 `F25` 在发送输入前返回 `Unsupported key`；
- UI 关闭、租约变化或超时后 Broker 继续失败关闭。

## 回归与兼容性

- 会话能力、原生 UI、Computer Use Broker、插件管理、运行卡片、运行日志、Codex Runtime Bridge 和严格停止测试全部通过；
- 原生 C# 使用确定性编译，连续两次构建的 EXE SHA-256 完全一致；`--self-test` 与 `--structure-test` 均为无窗口自检，其他未知 `--` 选项失败关闭，不会误打开 GUI；
- `portable-manager.cjs`、ESM 模块和原生 EXE 构建通过；
- 不新增、删除或修改顶层 MCP 工具 Schema；
- Portable Protocol 保持 1.5；
- 从 1.1.8 升级时保留整个 `data` 目录即可延续配置、OAuth 状态和插件，不需要重新创建 ChatGPT App。
