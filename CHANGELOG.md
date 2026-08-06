# Changelog

本文件提供版本索引；每个版本的完整设计、修复、测试和兼容性说明位于 [`docs/releases/`](docs/releases/)。

## 1.1.14

- 修复原生 UI 操作期间整个内容区域变白；
- 会话审阅改为列表与详情子页面；
- 新增显式 Memories 管理页面；
- Portable 与服务端版本统一为 1.1.14，Protocol 保持 1.5。

[完整更新说明](docs/releases/HOTFIX-1.1.14.md)

## 1.1.13

- Computer Use 金色边框改为会话级保持；
- `computer_action` 默认不返回截图，观察帧改为显式请求。

[完整更新说明](docs/releases/HOTFIX-1.1.13.md)

## 1.1.12

- 增加多显示器金色控制边框；
- 增加批量动作和进程内 `SendInput`；
- 收紧 Computer Use 队列与响应轮询。

[完整更新说明](docs/releases/HOTFIX-1.1.12.md)

## 1.1.11

- 使用有界稀疏审阅日志替代全目录 shadow Git；
- 修复大型目录审阅导致的 P0 磁盘膨胀；
- 加固服务启停、计划任务和 Codex Runtime Bridge Doctor。

[完整更新说明](docs/releases/HOTFIX-1.1.11.md)

## 更早版本

从 1.0.1 到 1.1.10 的完整记录均保存在 [`docs/releases/`](docs/releases/)。

