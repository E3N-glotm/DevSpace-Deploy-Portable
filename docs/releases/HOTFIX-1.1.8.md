# DevSpace Portable 1.1.8

## 修复目标

1.1.7 的 Computer Use 已具备权限、UI 租约和动作审计，但仍有两个结构性问题：

1. UI 心跳每 1.5 秒才处理一次请求，交互延迟明显；
2. 每次截图重新创建 DXGI Desktop Duplication，会在部分 Windows 11 显卡/会话状态下返回 `0x8000FFFF`，导致截图和动作后反馈全部失败。

## 运行时修正

- HTA 打开时启动隐藏常驻 `computer-use-broker.cjs`；
- Broker 继承当前用户的 Session、`WinSta0` 和 `Default` Desktop；
- Broker 以 40 ms 周期处理请求，UI 心跳只续租和确保 Broker 存活；
- MCP Computer Use 客户端的响应轮询由 100 ms 缩短为 25 ms；
- 鼠标、滚轮、白名单按键和 Unicode 文本改由静态编译的 Windows x64 `SendInput` Helper 执行，不再为每个动作启动 PowerShell；
- UI 关闭、租约变化或约 20 秒心跳超时后，Broker 自动退出并取消待处理动作；
- Broker 异常退出时，下一个 HTA 心跳自动拉起新进程。

## 截图后端

截图 Helper 改为自动多后端：

1. Windows Graphics Capture（WGC，主路径）；
2. DXGI 1.2 Desktop Duplication；
3. Pillow `ImageGrab.grabscreen_win32` 等价的 GDI/DIB 路径。

WGC 使用 Windows SDK C++/WinRT、D3D11 和 WIC，编译为静态 CRT Windows x64 EXE。Helper 返回实际 `backend`、分辨率、显示器数量及降级诊断。

## 实测

- Session 0 中直接启动的截图进程只能得到黑屏或失败，证明桌面捕获必须由用户 Session 1 的 UI 宿主启动；
- Explorer/HTA Session 1 常驻 Broker 连续 5/5 次返回 1920×1080 PNG；
- 保存的实际 PNG 包含完整桌面与 Portable UI，不是空白或全黑帧；
- 最终 Session 1 连续 5 次 `computer_snapshot` 平均端到端约 312 ms；
- Broker 协议、租约关闭、异常重启、无副作用 probe、Memories、Hooks、会话回退、插件和运行时卡片回归均必须通过。

## 兼容性

- 不新增、删除或修改顶层 MCP 工具 Schema；
- Portable Protocol 保持 1.5；
- 从 1.1.7 升级后只需替换程序文件并保留整个 `data`，无需再次刷新 ChatGPT App；
- Computer Use 仍默认关闭，并继续要求权限档位和本地 UI 有效租约。
