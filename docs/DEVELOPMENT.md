# 开发指南

仓库保存可审阅源码、依赖锁文件和构建脚本。GitHub Release 提供完整 Windows 运行包。开发时使用独立的配置、状态和运行目录。

## 环境准备

使用 Windows x64、Git、Node.js `>=22.19 <27` 和 Python 3.11+。构建 Windows 启动器及桌面原生组件时，安装 Visual Studio Build Tools 和相应 Windows SDK。发布环境的固定版本见 [Release 工作流](../.github/workflows/release.yml)。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/bootstrap-dev.ps1
npm ci --prefix ui-next
if (-not (Test-Path ui-next/runtime/electron.exe)) {
    Copy-Item ui-next/node_modules/electron/dist -Destination ui-next/runtime -Recurse
}
npm run build --prefix ui-next
```

构建完整 Portable 包时，从上一正式版恢复打包所需的运行时。例如，构建 1.1.69 时以 1.1.68 为基础。已存在运行时需要替换时，在隔离目录内显式使用 `-Force`。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/hydrate-runtime-from-release.ps1 -Version 1.1.68
```

## 源码位置

| 目录 | 内容 |
| --- | --- |
| `ui-next/src/` | Electron 控制中心的 React 界面 |
| `ui-next/electron/` | Electron 主进程、预加载桥接及本机管理接口 |
| `vendor/waishnav-devspace/` | DevSpace MCP、Agent Runtime、权限与工具实现 |
| `setup/` | Windows 启动器、更新器、Portable 管理器、构建和测试 |
| `scripts/` | 环境初始化、核心打包、源码检查及发行辅助脚本 |

默认桌面入口使用 Electron 控制中心，Windows 启动器由 `node setup/build-native-ui.cjs` 构建。历史 WinForms 源码在 `setup/native/DevSpacePortableApp.cs`。

## 模型委派与全局调度

`agent_task_start` 和 `model_delegate_task` 都创建可持久化的 Agent 任务，在工作台显示。兼容参数 `useSpecifiedModel=true` 不再创建不可见的 `mworker_` 任务；新调用返回 `agent_` ID，同时保留旧客户端使用的 `taskId`、`answer`、用量和工具证据字段。当前进程中已存在的旧 `mworker_` 仍可查询或取消。

对于 MCP 委派，全局“单模型”或“分组”优先于调用方的 `modelId`、`groupId`、`routeMode` 和兼容模型提示；全局“自动”仍允许任务选择模型。通过本机工作台手动选择的单次任务设置仍有效。调度在创建任务时确定，更改全局设置不会自动重启或改组正在执行的任务。

回归测试位于 `vendor/waishnav-devspace/test/agent-runtime.test.mjs` 和 `setup/test-model-workflow-wire.mjs`，后者通过隔离的假模型端点检查真实 OAuth、MCP 与工作台 HTTP 链路，不调用生产模型或修改生产状态。

## 修改和验证

修改核心源码后，先重新打包，再重装 `app` 依赖。测试通常从已安装的 `app/node_modules` 加载核心，确保它来自这次的源码。

```powershell
npm run source:verify
npm run core:pack
npm ci --prefix app
node setup/harden-nested-dependencies.mjs
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-source.ps1 -SkipInstall
```

在独立开发目录中运行桌面和 MCP 服务。可用 `DEVSPACE_PORTABLE_CONFIG_DIR`、`DEVSPACE_PORTABLE_STATE_DIR`、`DEVSPACE_PORTABLE_RUN_DIR` 区分配置、状态和运行文件。修改发布逻辑时，另行验证打包产物及升级路径。

[参与维护](../CONTRIBUTING.md) · [发行流程](RELEASING.md)
