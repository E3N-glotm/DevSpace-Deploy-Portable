# Application update design and 1.1.16 implementation

## Goal

Version 1.1.16 keeps the public GitHub Releases update flow introduced in
1.1.15 and adds file-level incremental packages with automatic full-package
fallback while preserving configuration, OAuth state, plugins, sessions, and
rollback safety.

The first implementation uses a detached updater, a staging directory and a
same-volume backup around a controlled restart. It never replaces files while
the native UI is still running.

## Implemented in 1.1.16: incremental first, full fallback

1. Each Release still contains the complete `DevSpacePortable-Windows-x64-<version>.zip`.
2. The release workflow additionally compares the new full ZIP with the latest
   stable full ZIP and generates
   `DevSpacePortable-Update-<from>-to-<to>.zip`.
3. The incremental package uses `file-delta-v1`: only changed/new files are
   included, while deleted paths are listed explicitly in `delta-manifest.json`.
4. `update-manifest.json` schema 2 advertises both the complete asset and one or
   more `incrementalAssets` keyed by exact `fromVersion`.
5. The updater first selects a delta whose `fromVersion` exactly equals the
   installed version. Before staging it verifies asset size/SHA-256, archive
   paths, every changed target file, and the installed SHA-256 of every file
   the delta will replace or delete.
6. Missing delta assets, malformed packages, SHA-256 mismatches, unsafe paths,
   or local drift in a touched base file automatically switch the same update
   attempt to the complete ZIP.
7. Incremental apply backs up and replaces only touched paths; complete apply
   retains the 1.1.15 top-level payload replacement behavior. Both modes share
   the same rollback, service restart, and persistent-data exclusions.
8. Users several versions behind can update without a chain of intermediate
   deltas: if no exact delta exists, the updater downloads the current full ZIP.
9. The updater shipped in 1.1.15 predates schema-2 `incrementalAssets`, so an
   already-installed 1.1.15 client still performs one complete-package update
   to 1.1.16. Incremental-first selection becomes effective for subsequent
   releases once the installed updater is 1.1.16 or newer.

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

