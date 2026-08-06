# DevSpace Portable 1.1.3

## 本地插件管理 UI

- Portable 控制界面新增插件管理栏，可从目录、`manifest.json` 或 ZIP 安装插件；
- 支持查看插件版本、成熟度、工具数量和启用状态；
- 支持选择版本启用、禁用、卸载单个版本或卸载全部版本；
- UI、`portable-manager.cjs`、`plugin-admin.mjs` 和 MCP 运行时统一使用同一个 `PluginManager` 与 SQLite 状态；
- 插件状态变更立即被 `plugin_query`、`plugin_action` 和预留槽位读取，不要求重启 DevSpace。

## 安装和卸载安全

- ZIP 在解压前检查绝对路径、盘符路径和 `..` 路径穿越；
- 解压后拒绝符号链接、目录联接、非普通文件、超过 20,000 个文件或超过 1 GiB 的包；
- 插件包必须在三层目录内且只包含一个有效 `manifest.json`；
- 安装在隔离 staging 目录完成校验，再使用同卷重命名原子发布；
- 默认拒绝覆盖相同 ID/版本，只有本地 UI 明确勾选后才允许替换；
- 安装过程不执行 `postinstall`、安装脚本或插件工具。

## 16 个固定网页预留接口

- 固定暴露 `plugin_slot_01` 至 `plugin_slot_16`；
- 槽位只能在本机 Portable UI 绑定，远程 MCP 客户端不能选择或修改绑定；
- 槽位输入不包含 `pluginId`、`toolName`、`cmd`、`argv` 或 `env`；
- 绑定固定插件版本、manifest 内容 SHA-256 和工具名；
- 插件被禁用、升级、修改或卸载后，槽位立即 fail closed，必须在本地 UI 重新绑定；
- 最终命令仍经过参数模板限制、工作区解析和 permission rules。

## 固定工具集合

- Portable 启动默认设置 `DEVSPACE_DYNAMIC_PLUGIN_ALIASES=0`，不再为每个插件生成变化的顶层别名；
- 普通插件统一使用固定 `plugin_query` / `plugin_action`；
- 只有确实不适合统一调度器的插件才占用一个预留槽位；
- 从 1.1.2 升级到 1.1.3 后需要让 ChatGPT 一次性读取新增的 16 个固定槽位，之后安装、升级、启停、卸载和重新绑定插件均不再改变网页 MCP Schema。

## 依赖安全覆盖

- 将 Hono 固定为 `4.13.0`，修复低于 `4.12.34` 的 CORS ReDoS 公告；
- 将 `pi-coding-agent` shrinkwrap 中锁死的 Undici 从 `8.5.0` 升级到 `8.10.0`；
- `setup/harden-nested-dependencies.mjs` 校验嵌套 package、shrinkwrap、实际安装目录和根 lockfile 四者一致，避免后续安装恢复已知漏洞版本。

