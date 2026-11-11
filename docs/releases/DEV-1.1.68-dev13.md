# DevSpace Portable 1.1.68 dev13 — DeepSeek 工具调用和安全凭据桥接

## 用户可见的两层故障

- 当前 DeepSeek 官方 Chat Completions API 模型标识为 `deepseek-flash`。DeepSeek 的思考模式默认开启，但思考模式不允许 `tool_choice: "required"`；旧版“测试 Function Calling”直接发送该参数且未关闭思考，因此 API 返回 HTTP 400。连接测试与模型发现未必同时失败。
- DevSpace MCP Worker 与 Electron 桌面是两个进程。旧 Worker 运行时检测到云模型的 `encryptedKey` 后直接拒绝调用并返回 `MODEL_API_KEY_NEEDS_SECURE_NATIVE_VAULT_BRIDGE`。该错误是独立于测试 HTTP 400 的功能阻断，不是用户未勾选“允许调用”。

## 修复

- DeepSeek Function Calling 探测请求使用明确的非思考模式，再强制调用仅用于检测的无副作用 `devspace_probe_echo`。旧 Ollama、自定义 OpenAI 兼容端点的请求行为不变。
- DeepSeek Worker 执行使用非思考模式与 `tool_choice: "auto"`，保留现有的 `read_file`、`grep_files`、`list_directory` 和经授权的 `edit_file` 工具协议；避免思考模式下多轮工具调用的 `reasoning_content` 回传不兼容。
- Electron 在保存云模型 API Key 时，除原有 Electron `safeStorage` 密文外，额外使用 **Windows 当前用户 DPAPI** 生成供独立 Node MCP Worker 使用的密文。DPAPI 保护的密文仍保存在本机现有配置中；凭据经 stdin 传入 Powershell DPAPI 保护／解密流程，不出现于命令行参数、环境变量、UI 或 MCP 列表中。
- Electron 初始化时迁移以前只保存 `encryptedKey` 的模型配置，不要求用户重复输入 API Key；迁移失败时不会写入明文，Worker 会保持明确的安全拒绝。
- MCP Worker 每次请求按已保存的模型 ID、策略修订号与启用状态验证本地密文，用 Windows DPAPI 解密并仅在向该模型 HTTPS API 发起请求时放入 Authorization Header。模型列表及委派结果始终不返回任何密文字段或明文密钥。
- 新增模型默认 ID 从已不再推荐的 `deepseek-chat` 调整为官方 `deepseek-flash`。已有用户模型 ID 不自动更改。

## 验收与边界

- 模型提供商与 Worker 运行时测试覆盖加密凭据隔离、旧配置迁移、工具请求格式、实际结构化工具调用及无密钥信息泄漏；Windows DPAPI 当前用户加密／解密往返验证通过。
- 该版本源码在 `E:\program\Python\DevSpaceDeploy` 现有目录修改；不主动覆盖 `D:\DevSpacePortable` 正式安装，不改变当前 Agent、训练任务、远端路由、模型 API Key 明文或 Windows 系统代理设置。
- 离线模拟测试不能代替部署后的真实 DeepSeek API 工具调用验收；完成生产升级、Electron 安全密钥迁移及 MCP 重启后才能验证完整线上闭环。
