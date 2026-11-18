# DevSpace Portable 使用指南

适用于当前 Windows x64 正式版的 Electron 控制中心。功能概览与文档入口见 [项目首页](README.md)。

## 安装和首次部署

1. 在 [最新正式版](https://github.com/E3N-glotm/DevSpace-Deploy-Portable/releases/latest) 下载完整 `DevSpacePortable-Windows-x64-<版本>.zip`，解压到固定目录，运行 `DevSpace-Portable.exe`。
2. 在部署向导选择本地或公网连接方式。只在 Windows 本机使用时选择本地模式。
3. 在「文件访问」选择指定目录或当前 Windows 用户可访问的所有目录。然后在「操作权限」单独设置命令、网络、凭据、桌面等能力。
4. 保存并部署。控制中心显示本地服务状态，公网模式还会显示隧道状态，后续可在「服务与桌面控制」启停。

文件范围约束 DevSpace 内置文件工具。任意 Shell、外部程序和桌面控制按当前 Windows 用户权限运行，需要结合「操作权限」单独授权。

## 连接本机和 ChatGPT

| 方式 | 配置 |
| --- | --- |
| 本机 | 适合支持本地 MCP 端点的客户端和诊断。默认地址为 `http://127.0.0.1:7676/mcp` |
| ngrok | 填写 Authtoken 和分配给该账户的 HTTPS 域名 |
| Cloudflare Tunnel | 填写命名隧道 Token，在 Cloudflare 将公网主机名指向 `http://127.0.0.1:7676` |

控制中心的公网 HTTPS 根地址填写 `https://你的域名`。在 MCP 客户端使用 `https://你的域名/mcp`。隧道 Token 用于启动隧道，Owner Password 用于 DevSpace 的 OAuth 授权页。通过公网 HTTPS 隧道接入时，本机的 MCP 端口继续使用回环地址。

从 ChatGPT 网页端连接时，在账户或工作区可用的自定义 MCP 入口添加端点并完成授权。升级后若工具列表没有更新，在客户端刷新或重新扫描工具。[OpenAI 连接文档](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt)

## 连接远程 Linux Agent

在「远程服务器」填写连接信息、安装目录和允许访问的 Linux 目录。安装目录与工作目录可以分别设置。根据远程机器可以到达的地址选择公网、受信任的局域网直连或 SSH 反向隧道。SSH 模式需要远端允许相应的端口转发。局域网直连用于受信任的网络。

Agent 上线后，从 MCP 客户端打开 `devspace://<Agent 名称或 ID>/absolute/linux/path`。Linux 访问范围由 Agent 授权目录、真实路径检查和运行账户权限决定。连接中断时，可在现有服务器条目中检查心跳、核对 SSH 凭据，并尝试恢复现有 Agent。

## 委派和桌面操作

在「模型提供商」添加模型后，通过「Agent 工作台」发起任务，或者由 ChatGPT 经 DevSpace MCP 委派。工作台可查看输出、工具步骤和结果。权限继承、模型组、暂停和恢复见 [Agent 工作台指南](docs/AGENT-WORKBENCH.md)。

使用 Computer Use 时，在 Windows 交互桌面打开控制中心并授权。遇到坐标或画面变化时先获取新截图再操作。界面报告输入结果不确定时，先核对实际桌面状态。插件、会话审阅和显式 Memories 可从各自的控制中心页面管理。

## 更新与迁移

在「设置 → 更新」点击「检查更新」，下载并校验后确认安装。更新器使用正式 Release 的数据，支持复用已有文件块并下载差异，必要时走完整包。独立更新窗口显示安装和恢复结果。安装会短时中断 DevSpace 服务，开始前保存当前工作与进程状态。

应用升级保留现有配置和运行数据，包括 `data/`、已登记的 Agent、OAuth 和已安装插件。遇到更新异常，在独立窗口记录失败阶段并查看日志。迁移旧版本前先备份整个旧目录，所支持的旧版本和升级桥见 [发行兼容说明](docs/RELEASING.md#版本兼容)。

| 现象 | 检查顺序 |
| --- | --- |
| 外部客户端连不上 | 先检查本地服务，再检查隧道、域名和客户端 OAuth |
| 未授权访问 `/mcp` 返回 401 | 到客户端完成 OAuth，核对配置使用的端点和授权状态 |
| Agent 工作台无法新建任务 | 从运行 MCP 服务的那份 Portable 打开控制中心，再检查服务状态 |
| Linux Agent 离线 | 核对连接模式、地址、Agent 心跳及 SSH 登录状态 |
| 下载或安装失败 | 在更新窗口区分下载、校验、暂存和替换阶段，保留对应的错误信息 |

旧版界面与历史功能记录见 [历史 README](docs/README-legacy-archive.md)。源码构建和测试见 [开发指南](docs/DEVELOPMENT.md)。
