# DevSpace Portable 1.1.65 dev1 — update experience

## Usable progress and nontechnical messaging

- The Next control center shows a three-step update flow, with plain-language
  version checking and a compact comparison of the installed and newest
  releases. JSON, file paths and checksums are not displayed by default.
- The download/staging phase now polls the existing updater's progress file
  without spawning duplicate downloads: visible phase, progress bar, transfer
  bytes, transfer speed, ETA and elapsed time. Verification and extraction are
  identified separately from a completed download.
- Reused blockmap chunks are not described as network bytes. Automatic
  fallback, local verification and error states are translated into ordinary
  status messages rather than raw PowerShell exceptions.
- The progress bridge only reads the current installation's fixed updater
  state paths and forwards a small allowlisted set of fields. Raw progress
  text, transport addresses, local paths and updater diagnostics never reach
  the renderer. Old/stale snapshots do not overwrite a new operation.
- Installation confirms interruption risk, then hands an already staged
  package to the existing visible standalone Update.exe controller. This
  reuses the verified staging folder instead of downloading again. The
  standalone controller retains its real-time application/rollback progress
  after the main Electron window exits and reopens it after installation.
- A recent installation result can be shown when the control center is
  reopened, distinguishing successful program replacement from unfinished
  service recovery.

## Development-only status

This build is 1.1.65 dev1, not a repacked 1.1.64 stable release. It does not
modify active installations, update task registration or user data in-place.
Production service replacement should be scheduled and confirmed separately.
