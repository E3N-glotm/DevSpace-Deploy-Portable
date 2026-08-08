# DevSpace Portable 1.1.20

1.1.20 修复一个与“打开 DevSpace 控制中心后 EasyConnect / v2rayN 异常退出”高度吻合的启动期进程身份问题。这个问题与 1.1.19 已经修复的 stop/shutdown 递归进程树误杀不同：即使用户没有点击停止，只是启动原生 UI，也可能触发旧 Computer Use Broker 状态清理。

## 根因

原生 UI 显示后会调用 `ui-open` 获取桌面租约。`openUiLease()` 在发现旧租约或切换到原生 Computer Use 队列时，会调用 `stopComputerUseBroker()` 清理旧 Broker。

旧实现只做两件事：

1. 从 `data/run/computer-use/broker.json` 读取 PID；
2. 如果这个数字 PID 当前存在，就直接 `taskkill /PID <pid> /F`。

Windows 会复用已经退出进程的 PID。因此，如果旧 broker 异常退出后状态文件没有及时清理，而该 PID 后来恰好被 EasyConnect、v2rayN、sing-box 或其他程序使用，那么下一次**仅仅打开 DevSpace UI**就可能把那个无关程序终止。

这解释了为什么问题可能表现为“打开软件就闪退”，而不是只有点击“停止并禁用”时才出现。

## 修复

1. `stopComputerUseBroker()` 不再相信单独的数字 PID。
2. 允许终止前必须重新枚举当前 Windows 进程并同时满足：
   - PID 与 broker 状态记录一致；
   - `ExecutablePath` 精确等于当前 Portable 根目录的 bundled `runtime/node/node.exe`；
   - `CommandLine` 明确包含当前根目录 `setup/computer-use-broker.cjs`；
   - 若状态中有 leaseId，当前命令行还必须包含同一个 leaseId。
3. 任一身份条件无法确认时，DevSpace 只删除陈旧 `broker.json`，返回 `pid-identity-mismatch`，不会向该 PID 发送终止命令。
4. 真正的 Computer Use Broker 仍可正常关闭；shutdown 的直接 Portable-owned 进程清理仍作为最终兜底。

## 实机网络排查

在修复前对当前部署做了只读检查，观察到以下程序可同时运行：

```text
DevSpace MCP      127.0.0.1:7676
ngrok             127.0.0.1:4040
v2rayN/sing-box   0.0.0.0:10809, 127.0.0.1:10815
Sangfor service   127.0.0.1:10000
```

WinINET 系统代理仍由 v2rayN 指向 `127.0.0.1:10809`，WinHTTP 为 direct。DevSpace 的 `start-tunnel.sh` 对 tunnel 子进程清除继承的 `HTTP_PROXY/HTTPS_PROXY/ALL_PROXY`，并没有修改 Windows 全局代理。现有证据没有显示这些监听端口存在直接冲突，因此本版不去改 EasyConnect/v2rayN 网络设置，而是修复已经确认存在的启动期错误进程终止路径。

## 回归测试

新增 `setup/test-ui-open-process-safety.mjs`：

1. 启动一个真实的系统 `PING.EXE` 外部进程；
2. 人为把它的 PID 写进陈旧 Computer Use Broker 状态；
3. 创建旧 UI lease；
4. 执行新的 `ui-open`；
5. 验证陈旧 broker 状态被删除，但外部 `PING.EXE` 仍存活；
6. 再执行 `ui-close`，外部进程仍必须存活。

该测试直接覆盖“打开 DevSpace 不得因为陈旧 PID 误杀第三方程序”的失效模式。

## 兼容性

- 1.1.19 → 1.1.20 继续使用精确 `file-delta-v1` 增量优先、完整 ZIP 自动兜底；
- 不改变 `data/`、`logs/`、`reports/` 持久化规则；
- Portable Protocol 仍为 `1.5`；
- MCP 顶层工具 Schema 不变；
- 不需要重新 OAuth 或重新 Scan Tools。
