# Application update design and 1.1.15 implementation

## Goal

Version 1.1.15 provides a user-visible “检查更新” function backed by public
GitHub Releases while preserving configuration, OAuth state, plugins,
sessions, and rollback safety.

The first implementation uses a detached updater, a staging directory and a
same-volume backup around a controlled restart. It never replaces files while
the native UI is still running.

## Implemented in 1.1.15

1. Query the public repository's latest stable Release without requiring a
   GitHub token.
2. Download `update-manifest.json` and the versioned Windows ZIP.
3. Verify Release/tag consistency, archive name, expected size and SHA-256.
4. Reject archive entries outside the `DevSpacePortable/` root or containing
   traversal components.
5. Extract to `.update-staging/<version>-<id>` and start a detached updater.
6. Stop the current Portable services while excluding the detached controller.
7. Back up the current application payload, replace it, verify the embedded
   version, restart services and reopen the UI.
8. Preserve `data/`, `logs/` and `reports/`; restore the previous application
   payload automatically if any apply or restart step fails.
9. Refuse application-level overwrite when the current directory contains
   `.git`, so source checkouts continue to use normal Git workflows.

## Future target layout

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

## Future version-directory protocol

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

