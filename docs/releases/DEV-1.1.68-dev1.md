# DevSpace Portable 1.1.68 dev1 — 原生模型提供商

本开发版在 DevSpace 桌面本体左侧导航新增“模型提供商”，不再使用独立的
`custom-model-worker` 插件。删除的是 E 盘源码中未纳入 Git 的两个原型
版本目录（0.1.0、0.1.1），没有触碰 D 盘正式安装或用户插件数据。

## 已实现

- DeepSeek 官方、通用 OpenAI 兼容 API、Ollama、本地 vLLM / llama.cpp
  四类接入方式，以及 Worker/Reviewer/Planner 职责设置。
- 多配置的创建、读取、编辑、删除。支持 Chat Completions 和 Responses API，
  手动模型 ID 与保存后自动发现服务端模型列表。尚不知道模型 ID 时允许先保存
  服务地址，读取模型列表后再选择目标模型。
- API Key 通过 Electron safeStorage 在 Windows 下调用系统加密能力后存储。
  磁盘只有密文，页面只返回是否已配置；留空保留、显式删除，不会回显密钥。
  系统加密不可用时拒绝保存任何新明文密钥。
- 真实网络连通测试以及基于无副作用探测函数的 Function Calling 检测；
  仅 HTTP 200 或文字响应不会被认定为工具调用成功。请求失败时隐藏
  远端正文与网络内部堆栈，限制超时、响应大小以及 URL 重定向。
- 用户配置上下文窗口、最大输出 Token、每任务 USD 预算和输入/输出
  每百万 Token 单价；提供由实际 token usage 计算费用的纯预算守卫。
- 云端密钥强制 HTTPS；非认证本地模型允许本机或私有 IP HTTP；
  带密钥的远端地址不允许明文 HTTP，URL 拒绝嵌入凭据、查询字符串。
- 使用 Electron 网络栈适配 Windows 系统代理/PAC；HTTP 跳转被拒绝，
  响应流设定 512 KiB 硬上限，测试不会执行远端工具调用的任何内容。
- 更新间接生产依赖的安全修复：glob 14.0.3、minimatch 11.0.4、
  @hono/node-server 2.1.6，并重新执行生产 npm audit。

## 明确边界

- 这个版本交付的是**本体模型管理与能力探测**，不是自动编码 Agent
  的全部运行时。模型配置中的任务费用上限已经保存并有预算守卫，
  但在独立任务执行器接入前尚不能保证云端供应商不会额外计费，
  不能把估算费用理解成平台账单硬限制。
- 不自动安装 Ollama、vLLM、llama.cpp 或模型权重，也不因保存配置而
  让远程 Linux Agent 接受额外工具权限。
- 与 ChatGPT 和原 DevSpace MCP 的现有入口共存；不更改已有权限边界，
  也不创建 C 盘工作树或更换 E 盘源码目录。
