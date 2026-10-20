# DevSpace Portable 1.1.65 — Stable

This release promotes the 1.1.65 dev1 updater experience to stable and updates
the public project documentation and control-center screenshot.

## Desktop update experience

- The Electron control center presents three clear steps: check available
  versions, download and verify, then confirm installation. It keeps the
  operator-focused view readable without raw JSON, checksums or internal paths.
- Download/staging progress is read from the existing updater task rather than
  starting duplicate downloads. The display distinguishes network bytes from
  blockmap chunks reused locally, and shows progress, speed, elapsed time and
  ETA when provided by the updater.
- Verification, extraction, download fallback and errors have distinct status
  messages; a completed download is not misreported as completed installation.
- The progress bridge exposes only an allowlisted subset of current-operation
  state to the renderer. Stale snapshots must not override a newer task, and
  raw transport addresses, paths or diagnostics stay outside the UI payload.
- Installation remains a user-confirmed, disruptive operation. The prepared
  payload is handed to the standalone visible updater, which continues progress
  and rollback reporting after the main Electron control center closes.

## Documentation and version identity

- Reworked README for first-time users with a concise setup flow, HTTPS/OAuth
  guidance, remote Linux Agent modes, updates, common failures and safeguards.
- Replaced the public control-center illustration with `docs/assets/superface.png`.
  Archived the former long README so historical operational notes remain
  accessible without being presented as the current user interface.
- Normalized display strings, lockfile, launcher, manager and manifest to
  `1.1.65` without the previous `dev1` label. Portable Protocol remains 1.6.
- Updated pinned/transitive dependencies for published MCP SDK, Hono,
  proxy-addr, brace-expansion and fast-uri advisories. The release workflow
  must pass its production dependency audit instead of bypassing it.

## Deployment and security

- Does not intentionally replace an already-running Windows installation;
  installation or updating is a separate operator action.
- Portable updates must preserve existing configuration, OAuth/SQLite data,
  plugin state, remote Agent identities and user logs.
- Remote Agent LAN connections should only be used on trusted private networks;
  do not expose the LAN Agent gateway publicly. MCP service should remain on
  loopback and be accessed remotely through an HTTPS tunnel with OAuth.

The release is complete only after the Windows GitHub Actions workflow passes
and the full portable ZIP, update manifest, SHA-256 list and update artifacts
appear on the public GitHub Release page.
