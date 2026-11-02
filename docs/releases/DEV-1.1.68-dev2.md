# DevSpace Portable 1.1.68 dev2 — 原生模型 Worker MCP 委派

本开发版修复 1.1.68 dev1 的实际问题：模型提供商配置仅供桌面 UI
使用，ChatGPT 无法通过 MCP 调用已绑定 Worker。dev2 将模型委派接口
直接注册到 DevSpace MCP 本体，不使用插件，不依赖 Codex 或 OpenCode。

## 新增 MCP 入口

- model_worker_list：枚举本机已保存 Worker，不返回 API Key。
- model_delegate_task：指定已打开的 workspaceId、模型配置 ID、任务、
  最大步骤数和超时，异步交由模型执行。默认只读；只有显式
  allowWrites=true 才允许限定工作区内的精确文本编辑。
- model_task_status：查询步骤、工具次数、Token 和估算费用。
- model_task_result：获取答复、失败原因和工具操作证据；ChatGPT 需要
  独立检查真实 Git 差异与测试结果，不应直接相信 Worker 的结论。
- model_task_cancel：取消任务并中断等待中的模型请求。

## 安全和实现边界

- 在当前已打开的本地工作区内使用 DevSpace 变更前后审核机制，
  遵守单一写入者；拒绝目录穿越、绝对路径、敏感目录和链接越界。
- Worker 仅开放 read_file、list_directory、grep_files 和经过授权的
  edit_file。没有任意 shell、任意网络请求、管理员权限、Git 推送、
  文件删除或远程服务器写入权限。
- 每任务最多 20 轮推理、24 次工具调用、3600 秒；预算使用用户配置的
  Token 单价估算，不等于云端供应商的账单硬上限。
- 任务状态由 MCP 服务端进程保管，跨对话可通过 taskId 查询；服务重启
  会终止进程内任务，尚不支持重启后的自动恢复。
- dev2 的原生运行时先支持没有 API Key 的 Chat Completions 模型，
  例如本地 Ollama Qwen。云端通过 Electron safeStorage 加密保存的
  Key 不会被 MCP 子进程越权解密，使用时会明确返回
  MODEL_API_KEY_NEEDS_SECURE_NATIVE_VAULT_BRIDGE；云端安全密钥桥接
  尚需后续开发。
- 不会自动把每次普通 @DevSpace MCP 调用改走模型。ChatGPT 必须主动
  调用 model_delegate_task；MCP 客户端重连或刷新工具列表才能发现。

## 回归要求

- 使用模拟 Chat Completions API 验证多轮工具调用、受控文件读取和编辑、
  修改前后审核、越界拒绝、Token 统计和 HTTP 错误；不得访问真实密钥。
- 升级不能覆盖已有的模型配置、OAuth、远程 Agent 身份或用户文件。
