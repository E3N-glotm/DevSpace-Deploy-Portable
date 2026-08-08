# DevSpace Portable 1.1.18

1.1.18 收紧显式 Memories 的原生 UI 可见范围，并增加完整内容查看能力。该版本不改变 Memory 数据库结构、不迁移或删除已有 Memory，也不改变 MCP 顶层工具 Schema。Portable Protocol 保持 1.5。

## 显式 Memories 默认范围修复

1.1.17 的 MCP `open_workspace` 本身已经只向模型返回“当前工作区 Memory + global Memory”，但原生 UI 的 Memory 列表会读取数据库中最多 200 条记录并全部显示，因此其他项目的 workspace Memory 也可能出现在当前页面，容易被误认为已经注入当前项目。

1.1.18 的 UI 改为：

- 增加“查看工作区”选择器，来源为当前配置中的 `allowedRoots`；
- 默认只显示所选工作区的 workspace Memory 与所有 global Memory；
- 其他工作区的 Memory 默认隐藏；
- 只有显式开启“显示其他工作区”后才展示其他项目记录；
- 列表增加“范围”和“工作区”信息，并按“当前工作区 → 全局 → 其他工作区”、各组更新时间倒序排列；
- 当前工作区和全局记录使用不同的视觉层级，减少作用域误判。

该修改只影响原生管理 UI 的可见性，不改变模型端既有的作用域过滤规则。

## 完整 Memory 内容预览

选择一条 Memory 后，右侧新增只读“完整内容预览”，展示：

- 标题；
- 作用域；
- workspace Memory 的绑定工作区，或 global Memory 的“所有工作区”；
- 标签；
- 最后更新时间；
- 完整正文。

原来的编辑器仍保留，可继续修改标题、标签、正文、作用域和工作区；预览区域本身不可编辑，避免仅查看时误改内容。

## 数据与升级兼容性

- `data/state/devspace.sqlite` 中的 `devspace_memories` 表结构不变；
- 已有 global/workspace Memory 不会被自动迁移、删除或改作用域；
- 关闭 Memories 功能仍只会停止模型读取，不会删除数据库记录；
- 从 1.1.17 升级时继续使用 1.1.16 引入的 `file-delta-v1`：优先选择精确 `1.1.17 -> 1.1.18` 增量包，增量缺失、基础文件漂移、大小/SHA-256/路径/目标哈希预检失败时自动回退完整 ZIP；
- `data/`、`logs/`、`reports/` 继续由更新器保留；
- Portable Protocol 仍为 1.5，MCP 顶层工具 Schema 未发生变化，因此不需要因为本版本重新创建 ChatGPT App。

## 验收要求

- 原生 UI 可编译；
- 默认 Memory 列表只包含当前工作区和 global 记录；
- 其他工作区记录只有打开“显示其他工作区”后才可见；
- 选择 Memory 后能查看完整正文和元数据；
- Memory CRUD 与敏感内容保护规则保持有效；
- 1.1.17 -> 1.1.18 增量包可以生成，并与完整 ZIP 共同发布；
- 构建与测试不得启动、停止、重启或覆盖机器上其他 Portable 根目录中的既有 DevSpace 服务。
