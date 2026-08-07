# DevSpace Portable

## 1.1.0 运行时能力

- 持久 `processHandle`、进程列表、重连接入和 PID 级重启识别；
- 工作区 session 列表、恢复、归档和 Git 元数据；
- `doctor`、诊断历史和自动修复建议；
- 文件 Watch、事件 sequence 游标和脱敏 SQLite 审计；
- `allow`、`deny`、`audit` 权限规则；
- 本地插件 manifest、版本缓存、启停、动态工具和插件 Skill 根；
- 协议/功能成熟度查询与 JSON Schema bundle 生成。

插件安装位置为 `data/plugins/installed/<id>/<version>`。启停或切换版本后，新建 MCP 会话刷新工具定义。

完整中文部署、迁移、权限、故障排查和卸载说明请阅读同目录的 `README.md`。

首次使用：解压整个文件夹后双击 `DevSpace-Portable.cmd`，选择 `ngrok 固定域名` 或
`Cloudflare Tunnel + 自定义域名`，选择 `full`、`codex` 或 `minimal` 工具模式，并选择
`workspace`、`full-access` 或 `custom` 主机访问权限，填写对应的固定公网根地址、Token、
允许目录和可选 Owner Password，然后点击“保存并自动部署”。

Cloudflare 模式要求先在 Cloudflare 控制台创建 remotely-managed named tunnel，并为
自定义域名配置 Published application，Service URL 指向 `http://127.0.0.1:7676`。
1.0.6 包内已包含固定版本的 `cloudflared`；若运行时文件缺失，保存 Cloudflare 配置时会自动恢复下载并校验。

`full` 是兼容性最好的默认模式；`codex` 使用多文件 `apply_patch` 和持久命令会话；
`minimal` 只保留精简工具集。切换模式会重启 DevSpace，并要求 ChatGPT 网页端刷新工具定义。

需要通过 MCP 执行 SSH、交互式密码提示、Windows Credential Manager、Shell 文件修改或任意
本地命令时，选择 `full-access`。该模式只获得当前 Windows 用户已有的权限，不会绕过 UAC、
ACL、杀毒软件或远端服务器权限。
