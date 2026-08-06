## 变更内容

说明本 PR 修改了什么，以及为什么需要修改。

## 影响范围

- [ ] 原生 UI
- [ ] DevSpace Portable 核心
- [ ] Computer Use
- [ ] OAuth / 权限 / 凭据
- [ ] 会话审阅与回退
- [ ] 插件
- [ ] 隧道或计划任务
- [ ] 构建、Release 或更新器
- [ ] 仅文档

## 验证

列出实际运行的命令与结果，不要只写“测试通过”。

```text
npm run source:verify
npm run core:pack
npm test
```

## 安全与回滚

说明是否涉及用户数据、Token、OAuth、进程停止、计划任务、自动更新、数据库迁移或不可逆操作；若涉及，说明失败后的回滚路径。

## Release 要求

- [ ] 已更新 `docs/releases/HOTFIX-<版本>.md`（需要发版时）
- [ ] 已更新 `CHANGELOG.md` 与版本号（需要发版时）
- [ ] 未提交 `runtime/`、`node_modules/`、ZIP、日志、`data/` 或凭据

