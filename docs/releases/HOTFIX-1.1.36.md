# DevSpace Portable 1.1.36

## Scope

1.1.36 hardens the online updater after a 1.1.33 installation could reach the full-package path, finish downloading/verifying the Release ZIP, and still fail during Apply. The release also publishes two dedicated recovery assets for installed 1.1.33 copies: an official file-delta package and a direct-extract rescue overlay. Portable Protocol remains 1.5 and the top-level MCP tool schema is unchanged.

## What was actually failing

The full Release archive itself is not the failing transaction boundary. A local isolated reproduction using the real 1.1.33 and 1.1.34 full ZIPs completed the complete top-level program-file replacement and produced the expected 1.1.34 `VERSION-MANIFEST.json` when no configured service recovery was requested.

The dangerous behavior was around that file transaction:

1. the old Apply path called `portable-manager stop` with ignore-failure semantics, so a stop failure could be hidden and Apply could continue into directories still owned by a Portable process;
2. after target files had been moved into place and the target manifest had been validated, `install-tasks` plus `start` still lived inside the same rollback transaction;
3. therefore a temporary Task Scheduler, local-service, tunnel, proxy, VPN, DNS, or other network-recovery failure could roll an otherwise valid new program version back;
4. if the machine also had locked files or a partial stop, that unnecessary rollback had a much weaker chance of restoring every moved path cleanly.

This is why a user could observe a full ZIP finishing download and verification yet still see “installation failed”: download success did not mean the updater had crossed the actual commit boundary.

## Pre-Apply stop is now a hard gate

1.1.36 does not touch program files unless the old Portable runtime has stopped successfully.

The updater now retries the normal Portable stop up to three times. If it still fails, Apply exits before creating the program backup transaction or moving a target program path. The error explicitly states that no program files were changed.

This is intentionally different from the old ignore-failure behavior. A failure to stop is recoverable; a partially moved application tree is not.

## Program commit is independent from service recovery

After target files have been moved into place, 1.1.36 validates the installed `VERSION-MANIFEST.json`. Once the manifest reports the requested target version, the program-file transaction is committed.

Task and service recovery then runs as a separate recovery phase:

- `install-tasks` is attempted;
- local MCP/tunnel startup is attempted according to the saved task state;
- failures are recorded as `servicesRecovered=false` plus `serviceRecoveryError`;
- the newly installed program files remain installed;
- the control center is still launched when possible so the user can inspect/retry recovery.

Network availability is therefore no longer allowed to decide whether a valid program-file upgrade should be undone.

## Apply-level full fallback

The existing incremental-first strategy already fell back to a full package when incremental **download, validation, extraction, or base preflight** failed. It did not cover an incremental package that staged successfully but failed later during Apply.

The new Update.exe closes that gap. If an incremental Apply fails and the backend explicitly records that the previous version was fully rolled back, the temporary out-of-tree update controller performs one forced full-package Stage and one final full Apply. It will not continue when rollback is incomplete, and it will not loop indefinitely.

## 1.1.33 recovery assets

The v1.1.36 Release contains:

- `DevSpacePortable-Windows-x64-1.1.36.zip` — normal complete Portable Release;
- `DevSpacePortable-Update-1.1.35-to-1.1.36.zip` — normal previous-stable delta;
- `DevSpacePortable-Update-1.1.33-to-1.1.36.zip` — dedicated 1.1.33 delta so an installed 1.1.33 copy does not have to fetch the 500+ MiB full package merely because intermediate Releases were skipped;
- `DevSpacePortable-Rescue-1.1.33-to-1.1.36.zip` — direct-overlay rescue package that bypasses the old Update.exe transaction entirely.

The rescue package is designed for manual recovery: close/stop the old Portable, extract the ZIP directly into the existing DevSpacePortable root, and choose to replace all same-name files. Its ZIP paths are already relative to the installation root; there is no additional `DevSpacePortable/` wrapper directory.

The rescue builder excludes `data`, `logs`, and `reports`, so Owner Password, OAuth clients/tokens, user configuration, plugin runtime state, SQLite state, and logs are not replaced. To keep “extract and overwrite” semantically safe, the builder refuses to create the rescue package if the target Release requires deleting any non-persistent file that existed in 1.1.33.

## Release pipeline changes

The Release workflow now downloads the published 1.1.33 full ZIP as a second base in addition to the latest stable base. It builds both deltas, builds the 1.1.33 rescue overlay, includes both delta entries plus rescue metadata in `update-manifest.json`, includes all assets in `SHA256SUMS-release.txt`, and uploads all of them to the same GitHub Release.

Local builds keep the generated complete ZIP, incremental ZIPs, and rescue ZIP directly in the repository root. For the maintained checkout this is:

```text
E:\program\Python\DevSpaceDeploy
```

## Regression coverage

1.1.36 adds or extends regression coverage for:

- pre-Apply stop failure aborting before program files are touched;
- missing tasks being installed before service startup;
- post-update service startup failure leaving validated target program files installed rather than rolling them back;
- true program-file transaction failure still restoring the previous files and recovering the previous tasks/services;
- concise backend error propagation without exposing `FullyQualifiedErrorId` as the user-facing cause;
- forced full-package Stage support after a safely rolled-back incremental Apply failure;
- direct rescue overlay paths with no nested Portable root;
- exclusion of `data`, `logs`, and `reports` from the rescue package;
- mandatory updater/version files being present in the rescue overlay;
- rescue generation failing closed when the target requires deleting an old file.

## Compatibility

- Portable version: 1.1.36;
- DevSpace server capability version: 1.1.36;
- Portable Protocol: 1.5;
- top-level MCP tool schema: unchanged;
- OAuth reset: not required;
- ChatGPT tool rescan: not required.
