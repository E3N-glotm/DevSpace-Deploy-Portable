# 1.0.1 跨机器热修复

此版本修复：

- 中文 Windows 中 `schtasks` 输出被错误当作 UTF-8 导致的“锟斤拷”乱码；
- 公网失败只显示 `actual=0`、无法判断 DNS/Token/域名/代理问题；
- 状态页把同一机器上其他 DevSpace/ngrok 实例误认为 Portable 实例；
- 自动部署在 ngrok 尚未真正发布固定域名时过早返回成功；
- 缺少 ngrok 出站代理和企业 CA 设置。

## 已部署 1.0.0 的电脑

1. 在旧菜单中点击“停止服务”；
2. 把 `DevSpacePortable-Hotfix-1.0.1.zip` 解压到便携文件夹的上级目录，确认覆盖同名文件；
3. 重新打开 `DevSpace-Portable.cmd`；
4. 点击“保存并自动部署”；
5. 若仍失败，点击“诊断公网隧道”，错误原因会直接显示，Token 自动脱敏。

热修复包不包含 `data`、`logs`，不会覆盖 Owner Password、ngrok Token 或 OAuth SQLite。

如果本地三个端点是 200/200/401，而公网三个端点是 `actual=0`，则 DevSpace 本身正常，
故障在 ngrok。优先确认域名和 Authtoken 属于同一个 ngrok 账户。若网络必须通过本机
代理访问外网，在菜单填写例如 `http://127.0.0.1:7890`。
