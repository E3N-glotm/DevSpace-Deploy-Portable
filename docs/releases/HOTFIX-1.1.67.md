# DevSpace Portable 1.1.67 — Stable Release

Official stable promotion of the 1.1.67 development series, including the
SSH credential and Agent recovery improvements from dev1 and the Windows
branding corrections from dev2.

## SSH password rotation and Remote Agents

- When existing SSH credentials change, verify the new credentials and
  automatically recover an **offline** Agent without silently allocating a
  different identity. An online Agent is not restarted merely to update SSH
  credentials.
- If an SSH host key changes, show its SHA-256 fingerprints and require
  explicit user approval after independent verification. Maintain a
  Portable-local SSH trust file instead of modifying the user's original
  known_hosts; require the key to match a fresh scan at approval time.
- Report a bounded, secret-free category for SSH login, network, host-key
  and recovery errors.
- An Agent whose identity has been **revoked** is not silently reactivated.
  The UI offers a separately confirmed new enrollment, with a new Agent ID,
  leaving the revoked identity unchanged.

## Windows application identity

- Replace generic taskbar and tray icons with a dedicated indigo DevSpace
  icon, a high-contrast white D glyph and cyan accent.
- Embed branded ICO resources into the native Windows launchers and updater.
- Use the matching icon for the Electron BrowserWindow taskbar and system
  tray. Multiple native icon resolutions (16–256 px) support Windows DPI
  scaling.
- Keep a deterministic icon source generator and ship its prebuilt ICO/PNG
  resources. No Pillow installation is required on end-user systems.

## Upgrade policy

- Preserve installed configuration, user data, Agent identities, secrets,
  and log history through the normal Portable update path.
- The released ZIP and update metadata are built in the GitHub Actions
  stable workflow, subject to the existing source, runtime, production
  dependency audit, updater and packaging checks.
