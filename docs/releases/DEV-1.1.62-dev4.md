# DevSpace Portable 1.1.62 dev4 — Electron desktop replacement

## Scope

Only the original E-drive source checkout is edited. dev4 replaces the shipped
WinForms control center with the Electron/React desktop UI. Both standard
DevSpace launcher executable names start the same new Electron app, not two
different control centers. Historical WinForms source remains in Git for
older-version tests and is excluded from the dev4 release ZIP. MCP, OAuth,
continuation state, plugin store, Remote Agent runtime, updater and persistent
data directory retain the existing backend contracts.

## Reintroduced desktop capabilities

- Eleven direct pages: Home, workspaces, Remote Agents, plugins/tools,
  continuation tasks, session review and rollback, memories, OAuth clients,
  service/Computer Use management, diagnostics/updates, settings.
- Allow-listed Electron IPC invokes existing manager APIs; no general renderer
  Node/shell/credentials API and no button opens the former WinForms window.
  Important destructive actions require explicit confirmation.
- Remote Agent enrollment, revoke/delete, SSH profile editing, SSH test,
  installation and recovery are integrated into the new UI. Existing SSH
  profiles keep the historical PascalCase storage shape and current-user DPAPI
  entropy. Existing Agent updates verify exact Agent ID/state before stopping
  the old process; refuse updates if that state cannot be attributed.
- Settings preserve configured tokens when ordinary fields change. Save and
  Apply states survive UI restart. Existing Computer Use fallback broker and
  lease semantics remain in use without launching WinForms.
- Secondary text, selected rows and buttons have explicit contrasting colors,
  and keyboard focus is visible in the light-theme design.

## Acceptance and release limits

- Require full source regression, Electron IPC/security tests, actual Electron
  navigation of 11 pages, local-only OAuth/MCP tests, SSH DPAPI compatibility
  and isolated mock Agent-upgrade tests.
- Mock SSH tests verify Bash syntax and process targeting, not actual Linux
  production deployments. Remote live Agent behavior and Computer Use
  end-to-end remain separate preproduction gates.
- D-live remains dev2 until a safe maintenance window and verified recovery
  plan. Building dev4 must not start or replace D-live scheduled tasks.
- No claim is made that Chromium uses less CPU/RAM than historical WinForms,
  nor that Electron alone changes MCP model-turn delivery latency.
- The previous conversation's real ATCC handoff reached READY, CLAIMED, and
  authorize-delivery, but never recorded a Host delivery receipt or resumed
  model ACK. Dev4 removes an avoidable async preflight between the final
  authorize-delivery CAS and first irreversible Host message call, retaining
  authoritative ownership checks before any retry/fallback. Isolation tests
  pass; this is not proof that ChatGPT will accept background App messages
  in every UI lifecycle. No ambiguous DELIVERING generation is auto-retried.
