# DevSpace Portable 1.1.19

1.1.19 处理两个 P0/P1 级运行问题：在线更新长时间无反馈，以及停止流程可能递归影响第三方网络软件并留下不完整的退出状态。Portable Protocol 仍为 **1.5**，没有新增或修改 MCP 顶层工具 Schema。

## 1. GitHub 在线更新不再长时间无反馈

1.1.18 的下载链路仍以 Windows PowerShell 网络栈为首选，并允许多轮较长超时；代理端口存在但不可用、企业 VPN 改写链路或 Schannel 连接不稳定时，UI 只能等待 `update-stage` 整体返回，因此容易表现为“执行中很久、没有速度、最后才报错”。

1.1.19 改为：

- bundled Git 自带 `curl.exe` 为 GitHub metadata、manifest 和 ZIP 的首选传输；
- 首先尊重当前进程继承的代理/网络环境；连接失败后，只对当前 GitHub 请求使用 `--noproxy '*'` 直连；
- metadata 使用短连接超时和有界 fallback，仅保留一次短时 PowerShell 兼容路径；
- ZIP 下载使用 `--continue-at -` 支持 partial file 断点续传；
- `--speed-limit` / `--speed-time` 检测长时间无有效吞吐，避免连接存在但下载实际停滞；
- 代理路径失败后优先使用同一个 partial file 直连续传；CDN 不接受 Range 时才删除 partial file 做一次干净直连重试；
- 文件大小、SHA-256、archive traversal、delta base hash、事务回滚等既有安全校验全部保留。

更新器持续原子写入：

```text
data/state/update-progress.json
```

其中记录 phase、已下载字节、总字节、百分比、实时速度、ETA 和 transport。原生 UI 每 500 ms 读取一次，因此用户能看到下载、校验、解压、fallback 和应用阶段，而不是只看到一个长期“执行中”。

## 2. 与 EasyConnect / v2rayN 等网络软件隔离

1.1.18 的严格停止逻辑存在一个危险边界：只要一个进程被判断为 Portable-owned，其所有后代都会递归加入 owned 集合，并使用 `taskkill /T /F` 结束整个进程树。DevSpace 又允许用户通过 MCP 启动任意程序，因此一个由 DevSpace 发起、随后独立运行的 EasyConnect、v2rayN 或其他程序可能仍处于 MCP 进程树下，从而在 Portable stop/restart/update 时被误杀。

1.1.19 改为 **直接归属**：

- 只有进程自己的 `ExecutablePath` 位于当前 Portable 根目录，或自己的 `CommandLine` 明确引用当前 Portable 根目录时，才算 Portable-owned；
- 不再因为“父进程属于 DevSpace”就自动把所有后代算成 Portable-owned；
- 普通 Portable 停止路径不再使用 `taskkill /T`，而是把直接 owned PID 按内部层级从叶到根逐个结束；
- Computer Use Broker、记录的 MCP PID、ngrok/cloudflared PID 也使用直接 PID 终止；
- updater 不启动、停止、重启或修改 EasyConnect、v2rayN、WinINET/WinHTTP 系统代理。

自动回归会让一个 Portable-owned Node 子进程启动系统 `PING.EXE` 外部后代，然后执行 stop；验收条件是 owned Node 必须退出，而外部后代必须继续存活。这样直接覆盖了本次误杀的根因。

## 3. “停止全部并退出 / 卸载计划任务”必须真正结束 Portable 后台

“停止全部并退出”新增独立 `shutdown` 语义：

- 停止 MCP、隧道、Computer Use Broker、hidden launcher 和其他当前根目录自有 PID；
- 现有 Portable 计划任务保持 disabled，不再在 stop 完成后恢复到之前的 enabled 状态；
- 即使计划任务已经先被卸载，`shutdown` 仍可继续完成 PID 清理。

`uninstall-tasks` 也加强为：删除任务后等待一个短周期，再执行第二次 direct-owned PID 清理与检查；如果仍存在 Portable-owned 进程就直接报错，而不是错误返回“卸载完成”。正常情况下，UI 和当前 manager 进程退出后，安装目录不应再被 DevSpace 后台进程锁定，可以直接删除。

## 4. 更新兼容性

- 1.1.18 → 1.1.19 继续优先使用精确 `file-delta-v1` 增量包；
- 增量预检失败自动切换完整 ZIP；
- `data/`、`logs/`、`reports/` 继续作为持久目录保留；
- Protocol 仍为 `1.5`；
- 不要求重新创建 ChatGPT App 或重新 Scan Tools。

## 5. 发布验收重点

发布前必须至少通过：

1. Windows PowerShell 5.1 对 `portable-updater.ps1` 的语法解析；
2. dead-proxy 故障注入下 GitHub metadata 能在有界时间内自动切换 direct curl；
3. updater contract、增量更新和完整 ZIP fallback 回归；
4. strict stop 的“自有进程退出、外部后代保留”测试；
5. 原生 UI 编译与实时 update progress UI contract；
6. 完整源码/Portable 回归与 `npm audit --omit=dev`；
7. 构建全过程不得停止、重启或覆盖其他 Portable 根目录中正在运行的服务。
