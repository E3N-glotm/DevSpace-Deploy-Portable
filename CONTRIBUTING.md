# 参与维护

从最新 `main` 开始，一个 Pull Request 聚焦一个主题。说明改动目的、验证方法和已知限制。合并前由维护者审查并通过所需 CI。涉及部署、更新器、凭据、Computer Use 或回退时，说明故障表现与恢复步骤。

## 在哪里修改

- MCP 核心、Agent 与工具源码在 `vendor/waishnav-devspace/`。
- Windows 控制中心在 `ui-next/`，启动器和更新器在 `setup/`。
- 用户上手说明从 [README](README.md) 进入，安装和操作见 [使用指南](README-PORTABLE.md)。

修改核心后，用 `npm run core:pack` 生成本地 TGZ，再用 `npm ci --prefix app` 更新测试依赖。构建和测试细节见 [开发指南](docs/DEVELOPMENT.md)。

## 提交检查

- 保持 Windows 路径对空格和非 ASCII 用户名的兼容性。
- 按 `.gitattributes` 保持行尾格式。Markdown、JavaScript、TypeScript、Python 和 Shell 使用 LF，C#、CMD、PowerShell 使用 CRLF。
- 提交源码与必要的锁文件、文档和测试。生成的运行时、安装包、用户数据、日志和凭据保留在本地。
- 新增第三方运行时或依赖时，标明版本、来源、完整性信息和许可。
- 根据改动运行相应测试，并执行 `npm run source:verify`。发行变更还应验证最终附件与升级路径。

正式版本标识、升级兼容和附件发布见 [发行流程](docs/RELEASING.md)。安全问题请按 [安全政策](SECURITY.md) 私下报告。
