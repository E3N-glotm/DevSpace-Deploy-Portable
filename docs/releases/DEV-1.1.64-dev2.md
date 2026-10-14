# DevSpace Portable 1.1.64 dev2

## Main fix — intermittent Linux Remote Agent offline

- Diagnosed on server `5090-55301`: the host and Python process were still running, but the controller recorded an actual WebSocket disconnect. The older Linux Agent repeatedly logged `Unexpected WebSocket payload during handshake`; `5090-55201` remained connected during the investigation.
- Fixed the Linux Agent WebSocket HTTP 101 handshake parser to preserve bytes arriving **after** the HTTP header terminator in the same TCP/TLS read. Such bytes belong to the first WebSocket frame and are valid. Previously they were rejected, potentially trapping reconnect attempts behind Cloudflare or another reverse proxy.
- Added bounded TLS/HTTP handshake and idle read timeouts, so a silently blackholed socket eventually reconnects instead of waiting indefinitely. Invalid `Sec-WebSocket-Accept` values are still rejected.
- Bumped embedded Linux Agent from **1.1.46 to 1.1.47** on both controller and Agent to enable the normal version-difference update path for connected Agents.
- Added a loopback integration regression for ordinary, coalesced and split HTTP 101 / WebSocket responses plus invalid handshake acceptance; existing Linux Agent and SSH recovery contracts remain covered.
- Deployment compatibility: Linux Agent 1.1.47 now rejects equal/older or malformed self-update versions before fetching code. This prevents the still-running 1.1.63 control plane (bundled Agent 1.1.46) from silently downgrading a deliberately upgraded 1.1.47 server Agent. Identity-verified, SSH-based in-place upgrade performs a remote self-test, takes a binary backup, restarts only the matching state, validates configuration SHA-256 and rolls back on failure.

## Includes all dev1 changes

- When automatic continuation is disabled, the server rejects stale `continuation_anchor` calls without creating cards or returning card-render metadata.
- Electron Computer Use restores the gold click-through, screenshot-excluded desktop border and broker-scoped activity signaling with automatic lease retry. Computer Use remains independent of the auto-continuation switch and does not override ChatGPT Host turn limits.

## Deployment caveats

- The dev2 package is an **independent development ZIP**. This source/package preparation does not modify the running `D:\DevSpacePortable` installation or a production Linux Agent.
- An Agent that is **currently offline** cannot receive an update through its offline WebSocket. Apply the fixed `1.1.47` Agent to that specific server using a verified SSH maintenance path, or recover connectivity first, then inspect its heartbeats. Preserve configuration and Agent identity.
- The separate `HTTP 403` observed from a diagnostic OAuth metadata request was not conclusively attributed to the Agent defect; check the access-control/proxy path again after a real upgrade.
