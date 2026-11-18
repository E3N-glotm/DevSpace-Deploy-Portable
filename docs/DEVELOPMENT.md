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

构建完整 Portable 包时，从上一正式版恢复打包所需的运行时。例如，构建 1.1.68 时以 1.1.67 为基础。已存在运行时需要替换时，在隔离目录内显式使用 `-Force`。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/hydrate-runtime-from-release.ps1 -Version 1.1.67
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
