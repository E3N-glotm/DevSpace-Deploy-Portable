# DevSpace Portable 1.1.42

1.1.42 is the Remote Workspace Agent recovery/install stability release. Portable Protocol remains 1.5. The release keeps direct incremental compatibility for installed 1.1.32-1.1.39 clients while adding the normal 1.1.41 -> 1.1.42 edge for graph-capable updaters.

## Same-version UI / SSH hotfix

- Fix the embedded **Remote server** page on non-maximized windows. Scrolling is now owned by a dedicated outer viewport with a full-height content surface, so reaching the bottom of the scrollbar also exposes the final status/help rows instead of leaving text hidden behind the main-window footer.
- Fix false SSH-recovery failures for healthy Agents. The native UI reads Agent state through a short-lived administrative process, which cannot observe the running DevSpace server's in-memory WebSocket set; a healthy, freshly heartbeating Agent is therefore reported to that UI as `online-recent`. 1.1.42 now treats both `online` and fresh `online-recent` as a recovered heartbeat in this administrative channel, while `offline` and `revoked` still fail closed.
- Clicking **One-click recover / install Agent** for an already healthy selected Agent now exits without needlessly restarting or repairing it.
- The Release workflow now selects the newest stable Release strictly below the target version as its canonical delta/runtime base. This makes an intentional same-version 1.1.42 repack continue to use v1.1.41 as the base instead of accidentally selecting the already-published v1.1.42 Release itself.

## Remote Agent SSH recovery

- The SSH rescue path no longer treats “the process started” as success. If the selected Agent still does not restore heartbeat, DevSpace creates a repair enrollment bound to the same Agent ID, rotates the stale Agent credential, repairs the configured control-plane endpoint, and restarts the Agent in place.
- Repair enrollment preserves the existing control-plane Agent identity. It does not create a duplicate tile just because the old credential or endpoint stopped working.
- SSH recovery emits and consumes the actual remote Agent state directory. Repair therefore updates the selected instance instead of guessing a path.
- New or unsaved SSH profiles default to automatic recovery. Existing profiles keep the user's previously saved AutoRecover value. Background rescue remains rate-limited per Agent.

## Offline SSH installation

- One-click SSH installation no longer requires `curl`, `sha256sum`, or outbound Internet access on the Linux host. Windows reads the bundled `install.sh` and `devspace-agent.py`, validates their SHA-256 locally, transfers them through the already-established SSH stdin stream, and asks the remote Python 3 runtime to materialize the temporary files.
- The Linux installer also accepts `--agent-file`, so the transferred Agent can be installed without downloading it from the public DevSpace URL. The normal public/manual installer can still download the Agent through Python `urllib` when no local file is supplied.
- The remote host requirements for the one-click path are reduced to SSH, Bash, Python 3, and write/execute permission on the selected allowedRoot. Manual public download remains the final fallback.

## User-level state directory and shared-server isolation

- Default non-system installation is explicitly anchored under the first selected allowedRoot rather than `/var/lib/devspace-agent`.
- Each enrollment receives an independent instance directory:

  `<first-allowedRoot>/.devspace-agent/<instance-key>/`

  A new enrollment uses a token-derived key; repair uses the selected Agent identity and, when an existing installation is found, repairs that exact on-disk state directory.
- This prevents two DevSpace users sharing the same Linux account/server and the same allowedRoot from overwriting each other's `config.json`, `agent.pid`, `agent.log`, or Agent binary.
- Recovery scans the new per-instance directories by the selected Agent ID and continues to recognize historical `~/.local/state/devspace-agent` and `/var/lib/devspace-agent` layouts.
- `--state-dir` is accepted only when it is an absolute path inside one of the selected allowedRoots. A user-mode install fails clearly if that state directory is not writable; it does not silently escalate with sudo.
- Generated manual install commands use ordinary `bash`, never `sudo bash`, and include the isolated `--state-dir`. System-level systemd installation remains available only when the user explicitly runs the installer as root/sudo.

## Native UI navigation

- “远程服务器” is now a first-class left navigation page between “配置与权限” and “插件管理”. The old subordinate button inside Configuration is removed.
- The existing Agent tiles, SSH endpoint/password fields, allowedRoots, enrollment controls, diagnostics, and fallback command remain on the same functional surface, now embedded directly in the main control center.
- Automatic SSH rescue is enabled by default for newly configured Agent profiles.

## Release compatibility

- The v1.1.42 Release publishes exact `1.1.32 -> 1.1.42` through `1.1.39 -> 1.1.42` migration deltas so old updaters remain incremental-first.
- It also publishes `1.1.41 -> 1.1.42`, carries forward the historical incremental graph, and retains the 1.1.33 Rescue overlay.
- Migration ZIPs are GitHub Release assets only and are not committed to the repository.
