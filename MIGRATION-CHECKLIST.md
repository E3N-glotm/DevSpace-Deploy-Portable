# 迁移检查清单

## 旧电脑

- [ ] 在图形菜单中停止 DevSpace 和当前公网隧道；
- [ ] 卸载 `DevSpace Portable MCP Server` 和 `DevSpace Portable Tunnel`；
- [ ] 从 1.0.3 升级时，同时确认旧任务 `DevSpace Portable ngrok Tunnel` 已删除；
- [ ] 确认原固定公网域名不再由旧电脑上的隧道副本占用；
- [ ] 决定使用原始无凭据 ZIP，还是迁移包含 `data` 的既有身份；
- [ ] 如果迁移既有身份，使用加密介质并完整复制文件夹，不要只复制 `auth.json`。

## 新电脑

- [ ] Windows 为 x64，当前账户为普通交互用户；
- [ ] 文件夹已解压到长期不移动的位置；
- [ ] 允许目录真实存在，盘符和路径已按新电脑调整；
- [ ] ngrok 模式：固定域名属于准备使用的账户，Authtoken 可用；或
- [ ] Cloudflare 模式：named tunnel、Published application、自定义域名和 Tunnel Token 已准备；
- [ ] Cloudflare Published application 的 Service URL 指向实际的 `http://127.0.0.1:端口`；
- [ ] 双击 `DevSpace-Portable.cmd` 并完成“保存并自动部署”；
- [ ] Owner Password 已存入密码管理器；
- [ ] 本地状态为 200 / 200 / 401；
- [ ] 公网状态为 200 / 200 / 401；
- [ ] 任务以当前用户、`InteractiveToken`、`LeastPrivilege` 运行；
- [ ] 在 ChatGPT 网页手工创建或重新连接 `https://固定域名/mcp`。

## 迁移旧 OAuth 身份时额外确认

- [ ] `data\config\auth.json` 存在且没有被重置；
- [ ] `data\state\devspace.sqlite` 存在；
- [ ] 新电脑配置后 SQLite 仍被保留；
- [ ] ChatGPT 不出现 `invalid_client`；
- [ ] 旧电脑不再同时运行相同域名的公网隧道。
