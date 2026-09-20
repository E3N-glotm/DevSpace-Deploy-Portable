# DevSpace Portable 1.1.61

`1.1.61` is the first stable release after the internal `1.1.59 dev*` series. No `v1.1.59` or `v1.1.60` stable Release was published; the previous public stable release is `v1.1.58`.

## Changes

- Continuation Task Contract, synthetic delivery/ACK ledger, process-watch recovery, manual-user priority, and per-manual-turn milestone card handling incorporate the dev106 source series. Automatic continuation may be turned off in the native control center beside Computer Use without disabling ordinary MCP operations or milestone cards.
- The Continuation Tasks page shows an editable Host cutoff *estimate* in minutes with a separate lock. An unlocked value is updated when new matching Host observations arrive; a locked user value is retained. The native editor row now sizes to its controls, wraps at narrow widths and no longer clips the save button or creates an inner scrollbar.
- Existing native UI, Computer Use, tunnel, OAuth, permissions, Remote Agent and process ownership hardening are included; live configuration and working data remain separate from the program payload.

## Updating from older versions

**This is the first stable updater bootstrap.** Since `v1.1.60` was never published, older clients must not be routed through a nonexistent `v1.1.60` edge. Release `v1.1.61` includes direct, small `file-delta-v1` bootstrap packages from every supported historical auto-update source: `1.1.36`, `1.1.37`, `1.1.38`, `1.1.39`, `1.1.40`, `1.1.41`, `1.1.42`, `1.1.43`, `1.1.44`, `1.1.45`, `1.1.46`, `1.1.47`, `1.1.48`, `1.1.49`, `1.1.51`, `1.1.52`, `1.1.54`, `1.1.56`, `1.1.57`, `1.1.58`. Versions not released between these numbers are not invented.

The first small delta updates only the control center, updater, manager, version manifest and a repair marker. The new control center then requests a **same-version full repair** using the verified full ZIP; the old updater does not have to extract the full modern `node_modules` tree. If the selected incremental path fails, the hardened updater must safely roll back before attempting its bounded full-package fallback. Stopping owned services and draining their PIDs is a hard precondition for replacing binaries, and failure before commit must preserve the old installation. Never terminate an unrelated VPN/proxy or third-party process.

The release provides a SHA-256-verified complete Windows ZIP, a blockmap and update manifest. Data under `data/config`, OAuth/Owner credentials, plugins, SQLite task/lease history, logs, reports, configured workspaces and Cloudflare/ngrok identity are **not** part of program-file replacement. Do not uninstall, clean `data`, or overwrite an existing installation with a bare ZIP without first retaining its data and a rollback copy.

**Pre-1.1.36:** Versions `1.1.14`–`1.1.35` precede the verified transactional one-click updater floor. They are not advertised as universally automatic upgrades. In particular, `1.1.33` had a documented full-package Apply failure. Use a backed-up migration with the version-specific rescue/recovery procedure rather than repeatedly retrying the broken old updater. Keep `data` intact; a version-specific rescue overlay is not interchangeable with an ordinary delta for a different baseline.

## Known limitation: extended Host reasoning

The displayed Host cutoff estimate and its lock **do not change** ChatGPT's actual reasoning limit or the continuation sender's authorization threshold. Historical cutoff inference can still mistake an extended, purely reasoning Host turn with no DevSpace tool activity for a timeout near the old learned window (~25–26 minutes), and a synthetic message may then be attempted. This issue was explicitly deferred to a future version; this release does **not** claim authoritative Host timeout detection or guaranteed noninterruption of arbitrarily long reasoning. Disable automatic continuation in the control center when preserving an extended manual reasoning turn has priority over unattended recovery.

## Acceptance boundary

The supported historical upgrade matrix, strict-stop/rollback and same-version full-repair checks must pass on Windows, followed by GitHub Release CI and downloaded-asset digest verification before publication is reported as successful. The published ZIP and incremental update assets must come from one canonical source revision and be byte-verified by `SHA256SUMS-release.txt` and `update-manifest.json`; a dev106 archive merely renamed `1.1.61` is not a valid release.
