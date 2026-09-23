# DevSpace Portable 1.1.62 dev3 — Next Desktop UI (preview)

This build is a side-by-side desktop UI preview, NOT a replacement for
DevSpace-Portable.exe. New launcher: DevSpace-Portable-Next.exe.
Both frontends use the same existing Portable manager, MCP, tunnel, OAuth,
SQLite, agents and update service. The E-drive source checkout is the only
development worktree; no C-drive worktree is created. D-live must not be
overwritten merely to evaluate a new desktop renderer.

## Implemented

- Electron 38 + React 19 + TypeScript/Vite + Fluent UI 2 shell and a persistent
  Electron Main process. Status is pushed from filesystem change notices and
  one lightweight local HTTP probe every 20 seconds. No short-interval
  manager/Node spawning for dashboard polling. Mutations still call the
  existing reviewed manager action on demand, serialized in Main.
- Strict contextIsolation, sandbox, no nodeIntegration, no popup/navigation,
  restrictive file CSP, narrow explicit typed preload IPC and whitelist for
  advanced manager operations. No generic terminal/FS IPC is exported.
- First-use wizard: connection mode, conditional domain/token fields, folder
  picker, workspace/full-access/custom permission presets and guarded
  confirmation/deploy progress. Local-only setup now uses a valid loopback
  OAuth origin; it needs neither public domain nor tunnel token, and only the
  local MCP service is started.
- Previously saved secrets appear as configured and masked rather than empty.
  The renderer does not receive saved secrets or generated Owner Password.
  Existing secret and MCP URL copying is handled by Electron Main with the
  native clipboard. Normal saves omit unchanged secrets, so placeholders
  never overwrite valid credentials.
- Home, workspace, agents, plugins, tasks/sessions, diagnosis and settings
  have distinct navigation. Missing advanced editor flows (Agent pairing,
  plugin install, complex task actions, OAuth editor, update application and
  interactive Computer Use broker) explicitly open the legacy control center,
  rather than silently deleting or forking those capabilities.

## Limitations and release gate

- This is NOT yet 100% standalone feature parity with WinForms, and the
  old UI remains the authoritative path for advanced operations. Do not
  uninstall the old UI or automatically replace the user's desktop shortcut.
- The old manager's write actions still launch a short-lived Node process
  when the user actually saves or deploys. Only the fast recurring status
  loop was eliminated. Memory/CPU may rise due to Chromium: measure both
  old and new UI before claiming lower idle CPU or fan noise.
- The Next UI refuses to replace a scheduled DevSpace service owned by a
  different Portable installation (such as an E-drive preview while D-live
  is running). Saving an E-drive preview only changes its isolated E-drive
  configuration, and the UI never claims that D-live is its own healthy
  local service merely because port 7676 answers.
- Saved-but-unapplied settings are recorded separately from in-memory form
  state; the main action stays Apply and restart until the service reports
  healthy after deployment. This is not a replacement for backend delivery
  or automatic-continuation end-to-end acceptance.
- Electron's bundled Windows runtime is distributed with this development
  package and must be verified with its official SHA-256 before packaging.
  Rendering and the first-run UI should be smoke-tested with the actual
  Electron executable; no verified public deployment or upgrade migration
  is implied by a local smoke test.
- New local-only configuration is regression-tested in an isolated E-drive
  config directory; a separate isolated loopback instance verifies real
  OAuth metadata and an unauthenticated MCP denial. The real Electron
  bootstrap and its sandboxed renderer were smoke-tested from E-drive.
  Optional remote/Computer Use workflows require separate live acceptance before
  promoting the new UI as the default executable.
