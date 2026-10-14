# DevSpace Portable 1.1.64 dev1

## Remote Linux Agent intermittent offline diagnosis (55301)

- A real 55301 incident was verified via the Windows DevSpace event database
  and identity-fenced read-only SSH diagnostics. The Linux server was alive,
  and Agent 1.1.46 remained running while logging repeated
  `Unexpected WebSocket payload during handshake` failures after the server
  had marked the WebSocket disconnected.
- The Linux Agent had incorrectly assumed that the HTTP 101 response and the
  first WebSocket frame could never share one TCP/TLS read. This is not a valid
  framing assumption, especially with tunnels or TLS proxies.
- WebSocketClient now retains bytes received after the HTTP header delimiter
  and consumes them before reading more socket data. TLS/HTTP handshake waits
  are bounded to 15 seconds and idle reads to 75 seconds to permit reconnect
  after blackholed connections. Invalid Sec-WebSocket-Accept responses remain
  rejected. Agent version rises from 1.1.46 to 1.1.47 so a future release can
  advertise a genuine Agent self-update.
- `setup/test-agent-websocket-coalesced.py` uses a loopback WebSocket peer to
  reproduce coalesced, split and normal 101+frame delivery, plus an invalid
  challenge response. The real Linux Agent contract and SSH rescue regressions
  also pass.
- Live D-drive Portable and the Linux server were **not** modified. An Agent
  already offline cannot self-update before it can reconnect; apply the fixed
  Agent in a separately authorized maintenance window. Remote OAuth probing
  also returned HTTP 403 during the incident, which remains a separate route
  or access-control diagnostic and must not be silently assumed fixed.

## Auto-continuation OFF must never create a new anchor

- Previously, a cached ChatGPT client could call `continuation_anchor`
  directly with automatic continuation disabled. The runtime rejected anchor
  preparation, but the server still returned App render metadata, allowing a
  visible empty or stale milestone-card shell to appear.
- The server now rejects UI-bearing anchor calls **before** creating or
  refining a task and returns no card-rendering metadata when disabled.
- Regular manual DevSpace actions and their task contracts remain available.
- Old milestone cards already present in the conversation transcript are
  controlled by ChatGPT's conversation UI; Portable cannot delete them.

## Computer Use visual parity with the former native UI

- The legacy WinForms window drew a gold `#E2B73F`, seven-pixel border around
  every display while the authorized Computer Use worker was active. The Next
  Electron UI preserved the lease and file-queue broker but omitted that
  visual component.
- Restored a click-through, always-on-top, screenshot-excluded Electron border
  on every connected monitor, driven exclusively by lease-matching Computer
  Use activity from the persistent broker. Idle, denied, expired or disabled
  sessions display no border, and overlays close with the UI process.
- The existing 65-second active and 90-second completion visibility windows
  are preserved. UI minimized to the system tray retains the local broker and
  may still indicate actual authorized desktop activity.

## Tool mode and continuation semantics

- `codex` remains the default tool mode; it is not a switch that disables
  independently permissioned Computer Use functionality.
- Turning off automatic continuation prevents synthetic ChatGPT work rounds.
  It does not interrupt an already-running manual assistant turn or cancel a
  long-running desktop action. The app cannot guarantee unlimited reasoning
  time or force ChatGPT Host to continue after its own turn budget.

## Verification

- UI tests cover the gold indicator's lease fencing, multi-display geometry,
  screenshot exclusion and expiry behavior.
- MCP wire contract covers disabling automatic continuation while an old
  anchor tool is still advertised, verifying no new card metadata is returned.
- The native backend Computer Use broker/disable regression checks that a
  valid activity request emits a bounded indicator pulse.
