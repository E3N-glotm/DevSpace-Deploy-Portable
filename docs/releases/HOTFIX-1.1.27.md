# DevSpace Portable 1.1.27

## Scope

1.1.27 repairs the standalone update transaction when Portable scheduled
tasks are missing, externally cleaned, or stale at the point where newly
installed services must start. It also preserves the original backend failure
instead of reducing it to PowerShell metadata. Portable Protocol remains 1.5
and the top-level MCP schema is unchanged.

## Confirmed failure chain

The affected installation recorded the following original Apply failure in
`data/state/update-progress.json`:

```text
Portable scheduled tasks are not installed: DevSpace Portable MCP Server,
DevSpace Portable Tunnel.
```

Both task definitions were created several minutes after the failed Apply,
confirming that they were unavailable during the transaction. The previous
implementation stopped owned processes, replaced and verified program files,
and then called `manager start` directly. It never reconciled Task Scheduler
state between replacement and restart.

The visible dialog hid this evidence because the old native updater selected
the final PowerShell error-stream line, which was normally
`FullyQualifiedErrorId` rather than the exception message.

## Transaction repair

For a configured installation, Apply now uses this order:

1. stop Portable-owned processes;
2. transactionally replace full-package or incremental target files;
3. verify the target files and target version manifest;
4. recreate the two Portable task definitions with the target manager;
5. start the local MCP service and selected public tunnel;
6. persist the successful result and reopen the control center.

Task definitions are reproducible deployment state. Configuration, OAuth
state, SQLite data, plugins, logs, reports, and session history remain outside
the program replacement transaction.

## Rollback repair

If target task installation or service startup fails, the updater now:

1. stops the partially updated runtime;
2. removes newly applied paths and restores every recorded old path;
3. uses the restored manager to recreate the previous task definitions;
4. restarts the previous services;
5. records file rollback, service recovery, rollback errors, UI restart state,
   and the retained backup path in `data/state/update-result.json`.

The updater no longer unconditionally reports `rolledBack: true`. An
incomplete recovery retains the backup and exposes each recovery error. A
failure to reopen the control-center process after a successful program and
service update is reported as `uiStartError` but does not undo the installed
version.

## Error preservation

The PowerShell backend emits a compact JSON failure object and an explicit
final stderr line containing the original exception. Existing 1.1.24–1.1.26
`Update.exe` controllers therefore receive the real reason while upgrading to
1.1.27.

The 1.1.27 controller additionally prefers, in order:

1. the structured backend error;
2. the current `update-progress.json` error or rollback message;
3. a filtered PowerShell error line that excludes stack-location,
   `CategoryInfo`, and `FullyQualifiedErrorId` metadata.

Full exceptions remain in the update window log and `logs/update.log` for
diagnostics.

## Validation

An isolated Apply regression uses a real Windows PowerShell backend and a
minimal Portable fixture:

- no scheduled-task marker exists before Apply;
- `start` fails unless `install-tasks` ran first;
- the successful path proves missing tasks are rebuilt before target startup;
- a forced first target-start failure proves old files are restored;
- the rollback path proves old tasks are rebuilt before old services restart;
- the final stderr line contains the original failure and not only
  `FullyQualifiedErrorId`.

Source verification, native `Update.exe` compilation/self-test, incremental
package tests, full Portable regressions, release construction, and update
manifest validation are also required before publication.

## Compatibility

- The full package supports recovery from 1.1.25 and earlier installations;
  1.1.26 uses the matching incremental package when available.
- Existing configuration, OAuth state, task ownership paths, plugins,
  sessions, logs, and reports remain preserved.
- No OAuth reset or ChatGPT tool rescan is required.
