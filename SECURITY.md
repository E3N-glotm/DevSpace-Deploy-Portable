# 安全策略

## 支持范围

安全修复优先覆盖最新稳定版和正在开发的下一版本。历史版本只在问题能够安全回移且不会破坏协议或数据兼容性时处理。

## 私下报告漏洞

不要在公开 Issue 中披露可利用细节、Owner Password、Tunnel Token、OAuth Token、私钥、`devspace.sqlite` 或完整日志。请优先通过 GitHub Security Advisory 的私密报告入口联系仓库维护者；该入口不可用时，再通过仓库所有者的私有联系方式报告。

报告应包含：

- 受影响版本与模块；
- 最小复现步骤；
- 实际影响和所需权限；
- 是否涉及远程利用、凭据泄露、持久化、Computer Use 或更新链；
- 已验证的缓解措施；
- 不含真实凭据和个人数据的测试材料。

## 核心边界

- 本地 MCP 默认绑定 `127.0.0.1`。公网接入使用用户配置的 HTTPS 隧道和 OAuth。
- Windows 计划任务以部署所用账户运行，受该账户的系统权限约束。
- 「文件访问」限制 DevSpace 内置文件工具的路径解析。「操作权限」单独控制 Shell、网络、凭据和桌面操作。任意 Shell 和外部程序由操作系统执行，目录过滤无法约束其全部行为。
- MCP 委派继承 DevSpace 全局授权，单次任务可收窄权限。限制只读任务时，需要同时关闭 Shell、文件编辑、Computer Use、记忆写入、插件修改。Linux 工作区还受远程 Agent 的目录及系统权限约束。
- Computer Use 需要本机授权、可用的交互桌面和有效 UI 租约。工具返回中断时，应先核对桌面真实状态再继续。
- 会话审阅使用有界日志。回退覆盖取决于 Git 跟踪、结构化工具记录及操作类型。
- 更新器依据官方 GitHub Release 元数据验证文件大小和 SHA-256。blockmap 路径还校验索引头、下载块及重建后的文件。

## 绝不进入 Git 或 Release 源码的内容

- `data/config/auth.json`；
- `data/config/ngrok.yml`；
- `data/config/cloudflare.token`；
- `data/state/devspace.sqlite`；
- OAuth 访问令牌、刷新令牌、SSH 私钥和 API Key；
- `logs/`、`reports/`、Computer Use 临时请求和已部署目录的完整副本。

提交前运行：

```powershell
npm run source:verify
```

## 发行要求

- 固定第三方运行时版本、来源和 SHA-256；
- 对最终 ZIP 做 CRC、文件清单和关键哈希验证；
- 从空目录解压并重新运行核心回归；
- Release 附带 ZIP 级 SHA-256 与更新清单；
- 在改为公开仓库或公开 Release 前，处理 ngrok Agent 的再分发许可问题。

