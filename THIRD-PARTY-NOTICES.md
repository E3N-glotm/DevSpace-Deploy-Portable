# 第三方组件说明

本项目的 Portable 集成代码采用 MIT License。下列第三方组件保留各自许可证、版权和使用条款。

## DevSpace

- 项目：`Waishnav/devspace`
- 固定版本：`@waishnav/devspace@1.0.5`
- 固定提交：`dca3b6a345a9285e63446d72376afdafe8c72af4`
- 许可证：MIT
- 受控 Portable 分支：`vendor/waishnav-devspace`

上游许可证保存在 `vendor/waishnav-devspace/LICENSE`。Portable 修改不改变上游版权归属。

## Node.js

- 固定版本：24.18.1 Windows x64
- 许可证及随附第三方通知位于发行包 `runtime/node/`。

## Git for Windows

- 固定版本：2.51.2.windows.1
- 发行包内许可证位于 `runtime/git/`；其中各组件可能使用不同的兼容开源许可证。

## cloudflared

- 固定版本：2026.7.3 Windows amd64
- 许可证：Apache License 2.0
- 固定下载 URL 与 SHA-256 记录在 `VERSION-MANIFEST.json`。

## ngrok Agent

- 当前内部基线版本：3.39.10 Windows amd64
- 性质：专有软件，受 ngrok 当前服务条款约束，不属于本仓库 MIT License 的授权范围。

当前私有 Release 可用于已授权协作者的内部开发与迁移基线。**在仓库或二进制 Release 改为公开之前，不应继续公开随包分发 `ngrok.exe`，除非已经确认该具体分发方式符合当前条款或取得单独许可。** 公开版本应优先改为用户首次启用 ngrok 时从官方来源下载，并校验版本与 SHA-256。

## npm 依赖

`app/package-lock.json` 固定生产依赖图。每个依赖的许可证由对应包提供；发行包保留安装后的包元数据与许可证。发布前运行：

```powershell
npm audit --omit=dev --prefix app
```

新增或升级依赖时，维护者必须检查许可证兼容性、固定锁文件并更新供应链记录。

