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

- DevSpace 本地服务只绑定 `127.0.0.1`，公网入口由用户选择的 HTTPS 隧道提供；
- 正式计划任务以当前 Windows 用户运行，不以管理员或 SYSTEM 身份运行；
- `full-access` 是明确的高风险授权，不是沙箱，不能绕过 Windows ACL、UAC、杀毒软件、凭据提供程序或远端服务器权限；
- 默认 `workspace` 档位限制 DevSpace 文件和工作目录解析范围；
- Computer Use 需要本地交互桌面、有效 UI 租约和显式权限，锁屏、UAC 安全桌面或租约失效时失败关闭；
- 会话审阅使用有界稀疏日志，任意 Shell 修改只保证已声明或已跟踪路径的回退覆盖；
- 自动更新必须验证 SHA-256 和独立数字签名，不能仅信任下载 URL。

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

