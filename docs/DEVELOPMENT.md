# Development guide

## Source checkout versus runnable distribution

The Git repository is intentionally smaller than the Portable ZIP:

- Git stores the Portable code, the maintained DevSpace package fork, tests,
  manifests, and build scripts;
- GitHub Releases store complete Windows runtime bundles;
- user configuration and state remain local and are never source artifacts.

After a clean clone, `runtime/`, `app/node_modules/`, generated `.tgz` files,
native executables, and ZIP files are absent.

## Bootstrap

```powershell
PowerShell -NoProfile -ExecutionPolicy Bypass -File scripts/bootstrap-dev.ps1
```

The script resolves either bundled or system Node, verifies its supported
major version, packs `vendor/waishnav-devspace`, runs `npm ci --prefix app`,
applies dependency hardening, and compiles the native UI when Visual Studio
Build Tools are present.

To build a complete Release, restore the pinned runtime from a previous
Release first:

```powershell
PowerShell -NoProfile -ExecutionPolicy Bypass -File scripts/hydrate-runtime-from-release.ps1 -Version 1.1.19
```

## Core development loop

1. Edit `vendor/waishnav-devspace` and/or Portable integration code under
   `setup/`, `scripts/`, and `app/`.
2. Run `npm run core:pack`.
3. Run `npm ci --prefix app` to refresh the installed test runtime.
4. Run `npm test`.
5. Run the application from a non-production checkout and verify that no
   scheduled task or tunnel points at the production directory.

## Native UI

The native control center source is:

```text
setup/native/DevSpacePortableApp.cs
```

Compile it with:

```powershell
node setup/build-native-ui.cjs
```

The compiler discovery uses Visual Studio `vswhere.exe` and .NET Framework 4.8
reference assemblies. The generated root `DevSpace-Portable.exe` is ignored by
Git and belongs in Release artifacts only.

## Runtime state safety

Never use development scripts against a deployed directory containing real
OAuth state unless the task explicitly requires it. Use an isolated temporary
configuration via:

```text
DEVSPACE_PORTABLE_CONFIG_DIR
DEVSPACE_PORTABLE_STATE_DIR
DEVSPACE_PORTABLE_RUN_DIR
```

Automated tests already create temporary directories and must leave them
clean after completion.

