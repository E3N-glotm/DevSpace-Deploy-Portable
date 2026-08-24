# DevSpace Portable 1.1.43

1.1.43 fixes Remote Workspace handling for non-Git directories and separates Linux Agent installation state from Remote filesystem permissions. Portable Protocol remains 1.5.

## Remote Git metadata

The Linux Agent previously returned JSON `null` for Git metadata commands that had no value. The MCP `open_workspace` output schema intentionally models `sha`, `branch` and `originUrl` as optional strings, so a non-Git directory could be opened internally but the final structured result failed validation.

1.1.43 omits unavailable Git fields instead. Normal Git repositories still report their metadata; non-Git directories, repositories without an origin and other partial-Git states remain valid Remote Workspaces.

## Linux Agent access model

Remote Agent enrollment now stores three independent concepts:

- `installRoot`: one writable directory used to hold the single Agent installation/state for that host enrollment.
- `writableRoots`: directories DevSpace may modify in scoped mode.
- `accessMode`: `scoped` or `full-access`.

Multiple writable roots do not install multiple Agents. The Agent state directory is created beneath `installRoot/.devspace-agent/` and remains independent of the number of writable roots.

### Scoped mode

Scoped mode is the default. A Remote Workspace may be opened anywhere the Linux Agent service user can read. This permits read-only datasets and other readable paths to be inspected without adding those paths to the writable-root list.

Structured file mutations must resolve inside a configured writable root. Shell and persistent process children are additionally restricted with Linux Landlock so a command cannot bypass the writable-root policy by writing an absolute path outside the workspace/writable roots. If Landlock is unavailable, scoped Shell execution fails closed rather than silently becoming unrestricted.

The Landlock rules permit `WRITE_FILE` to `/dev/null` as a compatibility exception because ordinary Linux commands commonly redirect diagnostic output there. This is a non-persistent character device; `/tmp` and other real directories remain outside the writable set unless the user explicitly selects them as writable roots.

For systemd installs, the service keeps the host filesystem read-only through systemd sandboxing and grants writes only to Agent state and the selected writable roots. Reads still follow the service user's normal Linux permissions.

### Full Access mode

Full Access removes DevSpace's additional writable-root restriction. `installRoot` remains only the Agent installation/state location; Remote file operations and commands then follow the Linux/SSH user's actual filesystem permissions. The systemd service does not apply the scoped read-only filesystem sandbox in this mode.

## Compatibility

- Existing `allowedRoots` configurations are treated as scoped `writableRoots` during migration.
- Existing Agent records default to scoped access; their first legacy root remains the installation-root fallback until repaired/re-enrolled with an explicit install root.
- `--allowed-root` remains accepted by the Linux installer/Agent as a compatibility alias for `--writable-root`.
- Offline SSH install, background SSH recovery, systemd recovery and Agent self-update continue to use one Agent identity.

## Validation

Release validation covers Linux Agent Python syntax, installer Bash syntax, enrollment database migration, dedicated install-root state isolation, scoped/full-access enrollment generation, Remote Workspace backend behavior, SSH rescue compatibility and native Windows UI compilation.
