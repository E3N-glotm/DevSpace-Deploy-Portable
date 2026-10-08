# Recovery: old Portable installation stranded between bootstrap and Electron

## Symptoms

- The `DevSpace-Portable.exe` launcher reports that Electron UI/runtime is missing.
- `Update.exe` reports `Portable could not be stopped safely before the update` and
  `Unable to enumerate Portable-owned processes: Get-CimInstance ...`.

These are distinct conditions which can occur in the same legacy migration.
Some legacy `file-delta-v1` bridges contain only the target launcher, version
manifest, manager/updater and `setup/legacy-upgrade-bootstrap.json`, **not**
the large Electron payload. Full same-version repair is required to finish.
The standalone `DevSpacePortable-Windows-x64-1.1.63.zip` DOES contain the
Electron executable, `ui-next/electron/main.cjs` and `ui-next/dist/index.html`.

## Read-only diagnosis

In the installed Portable directory, verify whether these paths exist:

1. `setup/legacy-upgrade-bootstrap.json` (partial bridge marker)
2. `ui-next/runtime/electron.exe`
3. `ui-next/electron/main.cjs`
4. `ui-next/dist/index.html`

PowerShell process-enumeration checks (read only):

```powershell
Get-CimInstance Win32_Process | Select-Object -First 1 ProcessId,Name
Get-WmiObject Win32_Process | Select-Object -First 1 ProcessId,Name
Get-Service winmgmt
```

If both process enumeration methods fail, Portable must **not** assume there
are no running processes: stop/update remains blocked for safety. Record the
full error and Windows version for diagnosis. Do not disable process ownership
checks or kill arbitrary `node.exe`, `powershell.exe` or `electron.exe` PIDs.

## Existing affected installation

The failed Apply shown in the report aborted before moving program files. An
**earlier** bridge may already have replaced the old launcher, however.

1. Close the Portable UI/updater and stop only the services and scheduled tasks
   belonging to this exact installation. If this cannot be established safely,
   reboot and address process-enumeration failures before replacing files.
2. Back up the entire installation, especially `data/`, `logs/`, `reports/`
   (these include private settings and credentials; do not upload them publicly).
3. Download the **complete**, verified `1.1.63` ZIP from the project's
   official GitHub Release. Do not use the small `DevSpacePortable-Update-...`
   bridge ZIP as a replacement for a complete installation.
4. With the service stopped, preserve the previous installation as a backup,
   extract the whole `DevSpacePortable/` directory into the original install
   path, and restore only `data/`, `logs/`, `reports/`. Avoid creating an extra
   nested `DevSpacePortable/DevSpacePortable/` directory.
5. Confirm all three Electron paths above are present; then start the new UI,
   reconcile its own scheduled tasks, and verify MCP/tunnel health. Retain the
   previous directory backup until services and user data are confirmed.

## Unreleased source mitigation

- The Next launcher now checks the bridge marker **before** checking the
  Electron runtime and attempts same-version full repair automatically.
- The manager first tries `Get-CimInstance`, then compatible `Get-WmiObject`
  enumeration. Both use the same strict path/creation-identity checks; if both
  fail the updater still aborts **before** program-file modification.
- New regression coverage verifies a real marker-only Windows launcher fixture
  without Electron, while mocking only the stage/launch network actions.

The same-version **legacy bridge and full release assets** can now distribute
the fixed launcher and manager to users beginning a fresh upgrade. This does **not** automatically fix
machines which applied the previous shallow bridge and are already stranded:
those users may still need the full ZIP recovery steps above.

Bridge-only repairs can be reproduced from the *previous published bridges*,
not from a potentially different local same-named full ZIP:

```powershell
python setup/rebuild-published-legacy-bridges.py --original-dir release-assets/bridge-repair-original --output-dir release-assets/bridge-repair-1.1.63 --launcher DevSpace-Portable.exe --manager setup/portable-manager.cjs
python setup/test-published-legacy-bridge-repair.py --original-dir release-assets/bridge-repair-original --repaired-dir release-assets/bridge-repair-1.1.63
```

The bridge-only rebuilding command remains useful when the full ZIP should be
preserved. For the corrective complete re-publication, the official workflow
rebuilds the full ZIP, blockmap, five bridges and release manifests together.
