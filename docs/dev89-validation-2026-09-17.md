# DevSpace Portable dev89 validation — 2026-09-17

## Trigger

Another owner observed that opening DevSpace Portable made a high-end Ryzen desktop audibly ramp its fans despite low average CPU/GPU utilization. A 10-second live sample on dev88 captured five short-lived `node.exe portable-manager.cjs ...` children from the Native UI (`dashboard-status` twice, `continuation-list` twice and `ui-heartbeat` once). Source inspection also found a 15 ms Native Computer Use queue timer.

Separately, disabling Computer Use in the Portable UI was not a complete live kill-switch. The MCP server kept a startup-time feature/permission config snapshot, while the Native UI queue worker authenticated only the active lease id and did not re-check the Computer Use toggle before local input execution.

## dev89 change

- Replace the 1.5 s heartbeat + 3 s dashboard + 5 s continuation-list Native UI timers with one `ui-runtime-poll` call. Visible UI uses a 15 s baseline; tray mode uses 30 s. Dashboard data is included only while the dashboard page is visible and continuation-list data only while the continuation page is visible. Page navigation triggers a prompt refresh without restoring high-frequency idle polling.
- Replace the Native UI 15 ms Computer Use directory poll with `FileSystemWatcher` events. Keep a 15/30 s combined-poll drain only as a missed-event safety net.
- Reduce the non-Native compatibility Computer Use broker idle poll from 40 ms to 500 ms.
- Persist `computerUseEnabled` in the active UI lease. Disabling Computer Use updates that lease immediately, cancels pending requests and stops the broker.
- Make the server-side Computer Use guard consult the live lease rather than the MCP server's startup config snapshot, so both disable and re-enable are effective without restarting MCP.
- Add Native UI gates before queue claim, each sequence step, direct input and screenshot capture so stale or racing requests cannot continue after the toggle is disabled.

## Continuation isolation

The automatic continuation supervisor, `runtime-state.js`, sender/claim/delivery/ACK path, Host-cutoff recovery logic and continuation coordinator scheduling are intentionally unchanged by dev89. Only the Portable owner's status/list presentation polling is reduced. Focused continuation guard, architecture, wire, ATCC and resident recovery tests remain mandatory before deployment.

## Validation plan

1. Computer Use broker/lease disable contract, Native UI self-test, dashboard/UI workflow/resilience and session capability tests.
2. Continuation guard, architecture, wire, ATCC and resident recovery regression.
3. Full source regression and source-tree/manifest verification.
4. Rollback-safe incremental D-live deployment.
5. Live post-deploy measurement of short-lived `portable-manager.cjs` child creation and D-live Computer Use disable contract.

