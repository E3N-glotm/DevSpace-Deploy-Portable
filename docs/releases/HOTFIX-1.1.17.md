# DevSpace Portable 1.1.17

1.1.17 修复完整发行包缺少显式 `plugins/installed/codex-runtime-bridge` 目录的问题。Portable Protocol 保持 1.5，MCP 顶层工具 Schema 不变。

## Release 内直接包含 Codex Runtime Bridge

- 完整 ZIP 现在固定包含：
  - `DevSpacePortable/plugins/installed/codex-runtime-bridge/<版本>/manifest.json`
  - `DevSpacePortable/plugins/installed/codex-runtime-bridge/<版本>/runtime.mjs`
  - `DevSpacePortable/plugins/installed/codex-runtime-bridge/<版本>/keep-awake.ps1`
  - `DevSpacePortable/plugins/installed/codex-runtime-bridge/<版本>/skills/codex-runtime-bridge/SKILL.md`
- 维护源仍只有 `setup/bundled-plugins/` 一份；`setup/build-release.py` 在构建时自动生成 `plugins/installed/` 发布镜像，避免两套源码发生漂移。
- 构建器在生成 SHA256SUMS 和 ZIP 之前强制检查 `plugins/installed/codex-runtime-bridge/<版本>/manifest.json` 是否进入 release file set，缺失则直接终止发布。

## 插件持久化边界

- `plugins/installed/` 是 Release 自带的 bundled seed tree，保证解压后、不启动程序也能直接看到内置 Codex Runtime Bridge。
- 用户实际安装、启用、升级后的插件仍位于 `data/plugins/installed/`；该目录属于持久化 `data/`，在线更新不会覆盖。
- Portable manager 在完整 Release 中优先使用 `plugins/installed/` 作为 seed source；源码开发环境没有该镜像时继续回退到 `setup/bundled-plugins/`。

## 验证

- 新增 `setup/test-release-plugin-layout.py`，验证发布镜像、版本目录及四个关键文件均存在，并被 release scanner 收录。
- `setup/build-release.py` 自身增加 release-time invariant，防止后续版本再次生成不含 Codex Runtime Bridge 的 ZIP。
