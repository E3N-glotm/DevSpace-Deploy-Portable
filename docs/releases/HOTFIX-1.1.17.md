# DevSpace Portable 1.1.17

1.1.17 修复完整发行包中 `codex-runtime-bridge` 的预置路径：插件必须位于 PluginManager 实际使用的 `data/plugins/installed/codex-runtime-bridge`，而不是 Portable 根目录下的 `plugins/installed`。Portable Protocol 保持 1.5，MCP 顶层工具 Schema 不变。

## Release 内直接包含 Codex Runtime Bridge

- 完整 ZIP 现在固定包含：
  - `DevSpacePortable/data/plugins/installed/codex-runtime-bridge/<版本>/manifest.json`
  - `DevSpacePortable/data/plugins/installed/codex-runtime-bridge/<版本>/runtime.mjs`
  - `DevSpacePortable/data/plugins/installed/codex-runtime-bridge/<版本>/keep-awake.ps1`
  - `DevSpacePortable/data/plugins/installed/codex-runtime-bridge/<版本>/skills/codex-runtime-bridge/SKILL.md`
- 维护源仍只有 `setup/bundled-plugins/` 一份；`setup/build-release.py` 在构建时自动生成 `plugins/installed/` 发布镜像，避免两套源码发生漂移。
- 构建器通过虚拟归档映射把 `setup/bundled-plugins` 中的受控插件文件写入 `data/plugins/installed/...`，不会读取或复制维护机本地 `data/` 中的 OAuth、SQLite、配置和其他运行状态；如果 `data/plugins/installed/codex-runtime-bridge/<版本>/manifest.json` 不能进入 ZIP，则直接终止发布。
- 完整 ZIP 明确禁止生成错误的 `DevSpacePortable/plugins/installed/...` 根目录镜像。

## 插件持久化边界

- `plugins/installed/` 是 Release 自带的 bundled seed tree，保证解压后、不启动程序也能直接看到内置 Codex Runtime Bridge。
- 用户实际安装、启用、升级后的插件仍位于 `data/plugins/installed/`；该目录属于持久化 `data/`，在线更新不会覆盖。
- Portable manager 在完整 Release 中优先使用 `plugins/installed/` 作为 seed source；源码开发环境没有该镜像时继续回退到 `setup/bundled-plugins/`。

## GitHub 在线更新网络兼容性

- 修复 Windows PowerShell 5.1 经过本地 HTTP/HTTPS 代理访问 GitHub 时可能出现“基础连接已经关闭: 发送时发生错误”的问题。
- updater 进程显式允许 TLS 1.2，并关闭旧式 `Expect100Continue`；不会修改系统全局网络配置。
- Release API 与 `update-manifest.json` 请求先走 PowerShell，失败时以 0.5 s / 1 s 退避最多尝试 3 次，再自动切换到 `curl.exe`。
- 增量 ZIP 与完整 ZIP 下载使用相同的有界重试和 curl fallback；如果两条网络路径都失败才向 UI 返回错误。
- 原有 size、SHA-256、增量基础文件 hash 和路径安全校验保持不变，网络 fallback 不降低更新完整性检查。

## 验证

- 新增 `setup/test-release-plugin-layout.py`，验证发布镜像、版本目录及四个关键文件均存在，并被 release scanner 收录。
- `setup/build-release.py` 自身增加 release-time invariant，防止后续版本再次生成不含 Codex Runtime Bridge 的 ZIP。
- `setup/test-online-updater-contract.mjs` 同时验证 TLS 1.2、有界 retry、GitHub JSON/download wrapper 与 curl fallback 合约。
