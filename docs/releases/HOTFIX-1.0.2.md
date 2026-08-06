# 1.0.2 auth.json 路径显示优化

本增量版本基于 1.0.1，解决部署后不方便定位 `auth.json` 的问题。

以下位置现在都会显示 `auth.json` 的实际绝对路径：

- 保存配置完成提示；
- 自动部署完成提示；
- 重新打开中文 HTA 图形菜单时的当前配置信息；
- “查看状态”输出；
- `show-config` 的 `authFile` 字段。

程序只显示路径，不会读取或打印 Owner Password。覆盖热修复包不包含 `data`、`logs` 或
`reports`，不会替换已有身份、OAuth 数据库或运行日志。
