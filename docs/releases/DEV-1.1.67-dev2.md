# DevSpace Portable 1.1.67 dev2

Development preview built on dev1, with a consistent Windows icon identity.

## Windows taskbar and tray appearance

- Replace the default generic executable icon with a distinctive DevSpace
  indigo rounded-square mark, high-contrast white “D” and a cyan accent.
- Embed the brand icon into the native Windows launcher executables at compile
  time. This avoids Windows Explorer selecting the generic C# program icon
  when the launcher is pinned to the taskbar.
- Specify the same brand icon for the Electron BrowserWindow taskbar button.
- Use the packaged multi-resolution ICO asset directly for the system tray;
  do not derive a low-resolution bitmap from the launcher file icon.
- Include 16, 20, 24, 32, 40, 48, 64, 128 and 256 pixel ICO frames for a
  range of Windows DPI scales, plus a 256px transparent PNG fallback.
- Keep one deterministic source generator
  (`setup/generate-brand-icon.py`) and checked-in binary assets. No Pillow
  dependency is required by production users or the release workflow.

## Scope and compatibility

- Keeps the existing minimize/restore/close policy, tray menu, UI leases,
  background MCP service and public tunnel behavior unchanged.
- Preserves dev1 SSH/Remote Agent work.
- Local development ZIP only; do not overwrite the currently running D-drive
  Portable installation or publish a stable release from this preview.
