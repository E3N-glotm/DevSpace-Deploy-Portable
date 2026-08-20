# DevSpace Portable 1.1.42

1.1.42 is the Remote Workspace Agent recovery/install stability and blockmap differential-update release. Portable Protocol remains 1.5. This same-version repack refreshes the direct incremental matrix for 1.1.32, 1.1.33, 1.1.34 and 1.1.36-1.1.41 while adding the `block-pack-v2` path for new 1.1.42 installations. A 1.1.35 direct edge is intentionally not published.

## Same-version UI / SSH hotfix

- Fix the embedded **Remote server** page on non-maximized windows. Scrolling is now owned by a dedicated outer viewport with a full-height content surface, so reaching the bottom of the scrollbar also exposes the final status/help rows instead of leaving text hidden behind the main-window footer.
- Fix false SSH-recovery failures for healthy Agents. The native UI reads Agent state through a short-lived administrative process, which cannot observe the running DevSpace server's in-memory WebSocket set; a healthy, freshly heartbeating Agent is therefore reported to that UI as `online-recent`. 1.1.42 now treats both `online` and fresh `online-recent` as a recovered heartbeat in this administrative channel, while `offline` and `revoked` still fail closed.
- Clicking **One-click recover / install Agent** for an already healthy selected Agent now exits without needlessly restarting or repairing it.
- The Release workflow now selects the newest stable Release strictly below the target version as its canonical delta/runtime base. This makes an intentional same-version 1.1.42 repack continue to use v1.1.41 as the base instead of accidentally selecting the already-published v1.1.42 Release itself.

## Block-pack v2 differential updater

- The Release keeps the normal `DevSpacePortable-Windows-x64-1.1.42.zip` as the final compatibility fallback and also publishes `DevSpacePortable-Windows-x64-1.1.42.blockmap`.
- The blockmap is a content-addressed pack over the target tree, not a hash list over compressed ZIP bytes. Files are divided into 1 MiB logical chunks; unique chunks are stored once and independently `zlib` compressed, or stored raw when compression would be larger.
- Its authenticated header records every target file SHA-256, ordered chunk hashes, and every unique chunk's physical Range offset and encoded size. `update-manifest.json` pins both the asset digest and compressed-header digest before payload ranges are trusted.
- The client reuses a local chunk only when its size and SHA-256 match, downloads only missing chunks with HTTP Range, verifies every decoded chunk, reconstructs the full target in staging, and verifies each completed target file before entering the existing transactional Apply/Rollback path.
- `data`, `logs`, and `reports` remain persistent roots. The only blockmap exception is the fixed Release-owned `data/plugins/installed/codex-runtime-bridge/` seed prefix required by `SHA256SUMS.txt`; all other durable user state remains excluded, and Apply continues to preserve the live `data` tree before the manager performs its existing non-destructive bundled-plugin seed.

## Parallel Range source selection

- Configured GitHub mirrors, explicit/environment/Windows proxy paths, and the official Release URL are probed in parallel with bounded 128 KiB requests.
- A source is eligible only when it returns HTTP 206 with the exact byte count. Eligible paths are ranked by measured elapsed time, throughput, and TTFB; missing-chunk groups fail over through that verified ranking.
- Blockmap failure falls back first to the compatible `file-delta-v1` path and then to the full Release ZIP. Existing full-download proxy/direct/TUN transports, resume, SHA-256 checks, backup, rollback, task repair, and service recovery remain unchanged.

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

- The repacked v1.1.42 Release publishes exact deltas from 1.1.32, 1.1.33, 1.1.34 and 1.1.36 through 1.1.41. The `1.1.35 -> 1.1.42` asset is intentionally omitted; 1.1.32 is retained to avoid regressing an existing compatibility promise.
- It carries forward the historical incremental graph and retains the 1.1.33 Rescue overlay.
- An already-installed earlier 1.1.42 build compares equal by semantic version and therefore cannot discover this same-version repack through its old updater. Such an installation must receive the repack through a controlled local/manual apply. Future Releases keep a direct `1.1.42 -> current` bootstrap so those older 1.1.42 updaters can enter the blockmap-capable runtime when a higher version is eventually published.
- Migration ZIPs are GitHub Release assets only and are not committed to the repository.

## Blockmap regression coverage

The regression suite exercises real HTTP 206 serving, local unchanged-block reuse, missing-block download and target reconstruction, final file SHA-256 equality, wrong-header rejection, HTTP 200/no-Range rejection, Windows temporary-file cleanup, and the Release matrix contract. The preferred order is authenticated blockmap reconstruction, compatible legacy delta, then complete ZIP.
