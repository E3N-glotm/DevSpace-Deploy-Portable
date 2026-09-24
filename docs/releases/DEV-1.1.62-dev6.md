# DevSpace Portable 1.1.62 dev6 — Electron close-to-tray and Settings updates

Source iteration stays strictly in the E-drive original source directory.
The separately installed D-drive Portable remains dev2 during development
and packaging. No C-drive checkout or worktree is used.

## Closing the control center

- Clicking the Electron window X now opens an in-app decision dialog:
  Minimize to system tray, Exit control center, or Cancel. The dialog
  explains that neither close choice stops the MCP server or public tunnel.
- Choosing tray keeps the Electron main process, local UI and Computer Use
  lease running. Clicking/double-clicking the Windows tray icon restores
  the control center. Its context menu offers Open, Ask next time and Exit.
- Exiting closes only the control center and releases the exact UI lease via
  the existing ui-close handler. It does not call stop-local, stop-tunnel,
  uninstall-tasks or disable.
- The optional Remember my choice uses the same
  data/config/ui-preferences.json closeChoice values
  (minimize-tray / exit-ui) as the former WinForms interface. The
  preferences helper preserves unrelated keys. A remembered choice can be
  reset from Settings, or from the tray menu while minimized. Cancel never
  overwrites an existing preference.
- Electron main owns the Tray and preference file; the sandboxed renderer
  only has narrow close-choice IPC. No legacy WinForms UI is invoked.

## Updates are in Settings

The complete Check updates / Download and verify / Install verified update
panel is located at the bottom of Settings. Diagnostics retains logs,
service/network status and proxy repair only. Installation still requires
explicit confirmation and a maintenance window, as it interrupts MCP tasks.

## Acceptance and boundaries

- Node close-preference and IPC security tests, TypeScript/Vite build,
  actual Electron Windows close/cancel/remember/tray test using an isolated
  E-drive preference, and actual 11-page Electron navigation proving the
  update panel is in Settings rather than Diagnostics.
- Existing source and Portable regression suite, ZIP CRC and key-file hash
  verification must pass before distribution.
- dev6 does not change the ChatGPT Host interrupted-response recovery
  limitation described in dev5. A tray-resident UI does not itself provide
  a verified assistant-turn-final event.
- Installing dev6 over D-live is a separate upgrade requiring explicit
  update/backup/active-session acceptance.
