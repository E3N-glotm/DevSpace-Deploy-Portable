# DevSpace Portable 1.1.12

1.1.12 聚焦 Computer Use 的可见性和交互延迟，Portable Protocol 保持 1.5。

## 受控状态金色边框

- Computer Use 请求执行期间，在每个显示器边缘显示 7 px 金色边框。
- Overlay 始终置顶、点击穿透、不抢焦点、不出现在任务栏。
- 请求完成后保留 3 秒再自动隐藏。
- 使用 `WDA_EXCLUDEFROMCAPTURE` 尽量避免边框进入 Computer Use 截图。

## 低延迟输入

- 鼠标、滚轮、白名单按键和 Unicode 文本改为 WinForms UI 进程内直接调用 `SendInput`。
- 仅在系统不支持相关入口时回退到原生 Helper 进程。
- UI 请求轮询从 40 ms 降到 15 ms，MCP 响应轮询从 25 ms 降到 10 ms。
- 返回 `queueWaitMs`、`inputElapsedMs`、`captureElapsedMs` 和 `totalElapsedMs`，便于定位真实瓶颈。

## 批量动作

- `computer_action` 新增 `steps`，一次可提交 1–50 个动作。
- 序列只在末尾截图一次，显著减少模型工具往返。
- 单序列累计显式延时上限 30 秒，文本总量上限 80,000 字符。
- 请求超时根据显式延时动态计算，最长 60 秒。

## 实机基准

- 20 个连续 `move` 动作 + 1 次 2560×1440 截图：138 ms。
- 输入执行：2 ms。
- 截图：94 ms。
- 队列等待：9 ms。
- 金色指示窗在执行期间可见，结束 3 秒后消失。

## 升级提示

`computer_action` 顶层输入 Schema 新增 `steps`。升级后需要刷新或重新创建一次 ChatGPT App 工具定义。
