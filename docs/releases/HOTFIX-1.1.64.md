# DevSpace Portable 1.1.64 — Stable

This release promotes the 1.1.64 development line to stable and fixes public
MCP health detection on Windows machines using system proxies.

## Public connectivity status

- Fixed repeated amber "公网状态暂无法核验" on Windows systems with an enabled
  system HTTP proxy, including local proxies such as 127.0.0.1:10809. The
  previous health monitor used Node's global fetch, which did not follow the
  Windows/Chromium proxy resolver. Actual MCP connections could remain healthy
  while both health checks timed out.
- Public verification now uses Electron's Chromium network stack (net.fetch)
  and its active system/PAC proxy configuration, without reconfiguring
  Cloudflare, editing system proxy settings, or exposing credentials.
- Preserve the explicit 200 OAuth protected-resource metadata + 401
  unauthenticated MCP verification contract, five-second polling while Home
  is visible, recent-success retention, and conservative handling of genuine
  timeout/transport uncertainty. Cloudflare DNS errors or client stream
  cancellations alone do not prove that MCP is offline.
- The production smoke test on a Windows host using PROXY 127.0.0.1:10809
  returned HTTP 200/401 in 2.0 seconds using Electron. The old Node-native
  eight-second health probe repeatedly timed out on the same machine while
  active remote MCP sessions were present.

## Remote Linux servers and Agents

- Included LAN-only Agent WebSocket entry point, per-server LAN/internet
  connection switch, and one-step SSH enrollment with name, permissions,
  installation directory, host, SSH port, username and password/private key.
- Included identity-fenced SSH recovery with a fresh connection plus heartbeat
  requirement. An unreachable target is rejected before stopping the existing
  Agent; network switches roll back on failures.
- Verified against real SSH ports 55201 and 55301: both LAN and internet
  endpoints accepted WebSocket handshakes; both switch directions and both
  SSH recovery operations produced fresh heartbeats and usable remote RPC.
  Both Agents ran version 1.1.48 at the end of acceptance testing.

## Other features

- Retains the improvements from the dev1/dev2/dev4 line, including Computer
  Use indicator fixes, Linux Agent WebSocket frame handling, automatic
  continuation remaining opt-in, and simplified native React/Electron UI.
- Full source, incremental-updater, service ownership, key-file integrity,
  and UI regression checks are required before publication.

## Security / deployment notes

- LAN Agent traffic uses HTTP/WS without TLS and must remain limited
  to trusted, isolated private networks. Do not expose the Agent port publicly.
- The Windows MCP listener stays bound to localhost. The standalone LAN
  gateway exposes only Agent WebSocket and installer assets, not MCP/OAuth.
- Updating the Portable installation must preserve operator data/config,
  Agent/SSH profiles, persistent state and running training jobs.
