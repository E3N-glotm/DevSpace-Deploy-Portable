# 参与维护

## 分支与 Pull Request

1. 从最新 `main` 创建功能分支，建议命名为 `feature/...`、`fix/...` 或 `release/...`；
2. 一个 PR 只处理一个明确主题；
3. 不得提交 `runtime/`、`app/node_modules/`、`data/`、日志、ZIP、Token 或 OAuth 数据库；
4. 至少通过一名维护者审查和全部必需 CI 后再合并；
5. 对部署、更新器、凭据、Computer Use、回退逻辑的修改应在 PR 中明确列出失败模式和回滚方式。

## 修改 Portable 核心

不要直接修改 `app/node_modules/@waishnav/devspace`。受控代码位于：

```text
vendor/waishnav-devspace/
```

修改后运行：

```powershell
npm run core:pack
```

该命令会生成被 Git 忽略的 `packages/waishnav-devspace-1.0.5.tgz`。随后运行 `scripts/bootstrap-dev.ps1` 或 `npm ci --prefix app` 安装到本地运行目录。

## 版本变更

每个版本必须同步修改：

- `VERSION-MANIFEST.json`；
- `setup/portable-manager.cjs` 的 Portable 版本；
- `app/node_modules` 对应核心源码中的服务端版本（通过 `vendor/` 修改）；
- 原生 UI 页脚版本；
- `docs/releases/HOTFIX-<版本>.md`；
- `CHANGELOG.md` 与 README 当前版本；
- 相关测试输出中的版本文本。

使用 `python setup/finalize-release.py <版本> --hotfix docs/releases/HOTFIX-<版本>.md` 更新包完整性与关键文件哈希。

## 提交前检查

```powershell
npm run source:verify
npm run core:pack
PowerShell -NoProfile -ExecutionPolicy Bypass -File scripts/test-source.ps1
```

修改发行逻辑时，还应从空目录解压最终 ZIP 并重新运行核心回归。

## 编码与兼容性

- JavaScript/TypeScript/Python/Shell/Markdown 使用 LF；
- WinForms C#、CMD、PowerShell 使用 CRLF；
- Windows 路径处理必须支持非 ASCII 用户名和带空格目录；
- 不得通过字符串黑名单声称实现 Windows 沙箱；
- 新增运行时或依赖必须固定版本、下载来源和 SHA-256，并补充第三方许可。

