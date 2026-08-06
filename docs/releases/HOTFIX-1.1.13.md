# DevSpace Portable 1.1.13

1.1.13 继续优化 Computer Use 的可见性与往返延迟，Portable Protocol 保持 1.5。

## 会话级金色边框

- 金色边框从“请求完成后 3 秒隐藏”改为“最后一次 Computer Use 活动后 90 秒隐藏”。
- 关闭 Computer Use、关闭原生 UI 或租约失效时立即隐藏。
- 本机用户可以把边框理解为当前桌面仍处于可被控制会话继续操作的状态。

## 动作默认不回传截图

- `computer_action` 默认只执行动作并返回结构化耗时，不再附带全屏 PNG。
- 需要观察时调用 `computer_snapshot`，或显式设置 `screenshotAfter: true`。
- 批量 `steps` 同样默认不截图，适合连续点击、键入和快捷键序列。

## 与 Codex 的差异结论

本机 Codex 0.146.0 的 Windows 包是大型原生二进制，Computer Use 逻辑不以 JS 源码暴露；二进制中可见 screenshot、capture、SendInput、desktop/screen 等原生路径。它快的核心原因不是模型少思考，而是动作与观察在同一本地宿主循环中执行，避免每步都通过 MCP 把全屏截图作为工具结果传回 ChatGPT。DevSpace 1.1.13 因此采用“动作默认无截图 + 显式观察 + 批量步骤”的策略压缩往返。

## 实机基准

- 单个 `move`、不截图：28 ms。
- 输入执行：3 ms。
- 队列等待：6 ms。
- 返回图片：0 字节。
- 黄框在动作完成 6 秒后仍保持显示。
