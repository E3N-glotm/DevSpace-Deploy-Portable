# DevSpace Portable dev90 validation — 2026-09-17

## Trigger

dev89 was deployed and passed its full regression, manifest, doctor and idle-wakeup acceptance. During the live Computer Use kill-switch review, one remaining race was identified in the Native UI execution boundary: `_computerUseRuntimeEnabled` is refreshed by `ui-runtime-poll` every 15 seconds while visible (30 seconds in tray). A request that had already passed the server guard immediately before the owner disabled Computer Use could arrive at the Native request directory after disable but before the next runtime poll.

## dev90 change

- Keep the Computer Use request-directory `FileSystemWatcher` alive while Computer Use is disabled. It is event driven and does not reintroduce the old 15 ms poll.
- Disabled mode still never executes input. The watcher only drains a late request so it can be rejected immediately instead of surviving in the queue until a later re-enable.
- Before Native input or capture, read `data/run/ui-session.json` directly and require all of:
  - exact current `leaseId`;
  - `computerUseEnabled === true`;
  - a parseable, unexpired `expiresAt`.
- The in-memory `_computerUseRuntimeEnabled` value remains useful for UI presentation and ordinary scheduling, but it is no longer the authority for Native queue execution.
- No continuation runtime-state, coordinator, sender, ACK, Host-cutoff or milestone-card authorization logic is modified by dev90.

## Focused evidence

- Native UI rebuild: exit 0.
- `setup/test-portable-ui-heartbeat.mjs`: exit 0 with the live-lease gate contract.
- Computer Use + Native UI + continuation focused suite: exit 0, including continuation guard, architecture, wire, ATCC and resident recovery.

## Final acceptance

- Source identity finalized as `1.1.59 dev90`; source-tree verification passed with 665 files and 0 EOL mismatches.
- Final package SHA-256: `ffd2f781bb1c616dc2038d7475e24325b74addbaff6b321b49f6ed2d1fd20536`.
- Full source regression: exit 0, wall time 975139 ms.
- Rollback snapshot: `E:\program\Python\DevSpaceDeploy\workspace-archives\dev90-predeploy-2026-09-17T08-58-17-469Z`.
- Rollback SQLite online backup: 258060288 bytes, SHA-256 `4fb8f6dd6e8e5434ad749dab7d5a56524aa9f4e8fffbdf644d45803b49547a15`.
- D-live upgraded from dev89 to dev90 with 8-file incremental deployment; post-deploy manifest check passed 208/208 with no missing or mismatched file.
- Post-deploy doctor: 6/6 OK. Local serve PID became 5228; Cloudflare remained the existing PID 16996 and was not restarted.
- Live Native UI self-test: `passed=true`, splitter passed, 10 tabs and 74 buttons; restarted UI PID 21164.
- 10-second idle child-process sample: exactly one short-lived `portable-manager.cjs` child, the consolidated `ui-runtime-poll`. The older independent `ui-heartbeat`, `dashboard-status` and `continuation-list` periodic children did not reappear.
- Live Computer Use kill-switch test started from `computerUseEnabled=true`, disabled it without MCP restart, verified the persisted UI lease immediately became false, then inserted a harmless late `broker_probe`. The Native watcher consumed the request and returned `success=false` with `Computer Use is disabled in the local DevSpace Portable UI.`; the request did not remain queued. The owner's original enabled state was restored afterwards.
- Post-deploy continuation wire contract: exit 0, `ACK_BYTES=7405`; epoch compatibility, strict schema, anchor/status/bind/heartbeat, READY/claim/authorize/receipt/ACK/completion, manual fencing and synthetic work-floor contracts all passed.

dev90 therefore preserves the dev89 low-wakeup architecture, closes the remaining late-request Computer Use race, and leaves automatic-continuation authorization semantics unchanged.
