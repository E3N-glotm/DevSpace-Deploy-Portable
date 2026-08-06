# Application update design for 1.1.15+

## Goal

Provide a user-visible “检查更新” function backed by GitHub Releases while
preserving configuration, OAuth state, plugins, sessions, and rollback safety.

The feature is an application update with a controlled restart, not in-place
replacement of files held open by the running process.

## Target layout

```text
DevSpacePortable/
├─ DevSpace-Launcher.exe
├─ DevSpace-Updater.exe
├─ current.json
├─ versions/
│  ├─ 1.1.14/
│  └─ 1.1.15/
├─ data/
├─ logs/
└─ update-cache/
```

`data/` and `logs/` remain outside versioned application directories. The
launcher reads `current.json` and starts the selected version.

## Update protocol

1. Read the latest stable GitHub Release and `update-manifest.json`.
2. Compare semantic versions and updater compatibility.
3. Download the ZIP to `update-cache/`.
4. Verify expected size, SHA-256, and a detached Ed25519 signature.
5. Extract to `versions/<version>.tmp` and verify the internal manifest.
6. Back up `data/state/devspace.sqlite` and configuration metadata.
7. Stop only processes owned by the current Portable installation.
8. Atomically rename the new directory and switch `current.json`.
9. Start the new version and run local listener, OAuth metadata, MCP, tunnel,
   plugin, and database-migration health checks.
10. If health checks fail, switch `current.json` back and restore the database
    backup.

## Security requirements

- HTTPS alone is not the trust boundary; the updater must verify a signature
  with an embedded public key.
- Release signing keys must not be stored in the repository or on a general
  self-hosted runner.
- Downgrades require explicit confirmation unless performed by automatic
  failure rollback.
- Update code must reject paths escaping the staging directory and must not
  follow archive links.
- A Release that changes the MCP top-level schema must clearly tell the user
  that the ChatGPT App definition needs refreshing.

## Channels

The manifest should support `stable`, `beta`, and `nightly`, with `stable` as
the default. Automatic installation should initially remain opt-in; background
checks may notify without silently replacing the active version.

